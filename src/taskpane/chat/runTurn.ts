import { Attachment } from "../../shared/attachment";
import { CommittedFile, clampFiles, fileCharBudget } from "../../shared/fileSource";
import { NewMessage, StoredMessage } from "../../shared/history";
import {
  stableSystemPrompt,
  systemMessageWithFiles,
  turnAttachmentNotes,
  userMessageForHistory,
  userMessageWithAttachment,
} from "../../shared/prompts";
import { joinArgosScopes } from "../../shared/argos";
import { Usage } from "../../shared/stripThinking";
import {
  THINKING_BRIDGE,
  THINKING_BUDGET_UNSET_NOTICE,
  runawayThinkingChars,
} from "../../shared/thinking";
import {
  UNLIMITED_TOOL_ROUNDS,
  buildTools,
  isToolsUnsupportedError,
  toolRoundLimitNotice,
} from "../../shared/tools";
import { logInfo } from "../../sidecar/logger";
import { ChatMessage } from "../../sidecar/types";
import { ChatBody, chatStream } from "../api";
import { Settings } from "../settings";
import { documentHasVisibleText, isWordHost } from "../word";
import {
  ABORTED_TOOL_RESULT,
  fitContext,
  indexedReadCharLimit,
  requestTokens,
  toChatMessages,
} from "./context";
import { beginToolTurn, executeToolCall } from "./execute";
import { knownThinkingBudget, readThinkingBudget } from "./thinkingBudget";

/* global AbortSignal */

export type RunTurnOptions = {
  settings: Settings;
  instruction: string;
  /** Read from the document just before the turn; never replayed from history. */
  attachment: Attachment;
  /**
   * Every file this conversation carries, whether it was picked this turn or an
   * earlier one. The caller has already merged the two; this does not care
   * which is which.
   */
  files?: CommittedFile[];
  /** Earlier turns of this conversation, oldest first. */
  history: StoredMessage[];
  signal: AbortSignal;
  /** Called as each message appears so the UI and the database stay in step. */
  onMessage: (message: NewMessage) => Promise<void> | void;
  /** Live tokens for the assistant reply currently being generated. */
  onDelta?: (snapshot: { content: string; reasoningContent: string }) => void;
  /** Folder prefixes for Argos; empty means the whole index. */
  argosPathPrefixes?: string[];
};

export type TurnResult = {
  usage: Usage | null;
  /** Estimate for what the next request would cost, used by the context bar. */
  nextRequestTokens: number;
};

type Streamed = Awaited<ReturnType<typeof chatStream>>;

function withFinishReason(done: Streamed): Streamed {
  return done.usage ? { ...done, usage: { ...done.usage, finishReason: done.finishReason } } : done;
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) {
    return true;
  }
  return error instanceof Error && error.name === "AbortError";
}

function silentEndNotice(finishReason: string): string {
  return `モデルが本文も操作も返さずに終わりました（終了理由: ${finishReason || "不明"}）。もう一度送るか、指示を分けてください。`;
}

function attachmentShowsBody(attachment: Attachment): boolean | null {
  if (attachment.scope === "document") {
    if (attachment.document.trim() || attachment.truncated) {
      return true;
    }
    return false;
  }
  return null;
}

export async function runTurn(options: RunTurnOptions): Promise<TurnResult> {
  const { settings, signal } = options;
  const limit = settings.contextLimit;
  const hasSelection = Boolean(options.attachment.focus.trim());
  // Numbers are only addresses if the model was handed them with the body.
  const numbered = Boolean(options.attachment.document.trim());
  const shown = attachmentShowsBody(options.attachment);
  const hasBody = shown !== null ? shown : isWordHost() ? await documentHasVisibleText() : false;
  const promptBase = {
    fontName: settings.fontName,
    bodyPt: settings.bodyPt,
    titlePt: settings.titlePt,
    lineSpacingChars: settings.lineSpacingChars,
    search: Boolean(settings.searxngUrl.trim()),
    argos: Boolean(settings.argosBaseUrl.trim()),
    argosPathPrefix: joinArgosScopes(options.argosPathPrefixes || []),
  };
  /*
   * The file budget does not yield to the document. Files are clamped from
   * the stable prompt only. The document and the instruction change every
   * turn; folding them into the budget would resize the file text and
   * invalidate the prefix cache from the system message on.
   */
  const stable = stableSystemPrompt({
    ...promptBase,
    files: Boolean(options.files?.length),
  });
  const files = clampFiles(options.files || [], fileCharBudget(limit, stable.length));
  const notes = turnAttachmentNotes({
    ...promptBase,
    hasBody,
    selection: hasSelection,
    numbered,
    markup: options.attachment.markup,
    reviewedBody:
      Boolean(options.attachment.document.trim()) || options.attachment.scope !== "none",
    reviewedFallback: options.attachment.reviewedFallback === true,
    inlineMarkup: options.attachment.inlineMarkup === true,
    listMarks: Boolean(options.attachment.listMarks),
    shapes: Boolean(
      options.attachment.shapes &&
      (options.attachment.shapes.text ||
        options.attachment.shapes.error ||
        options.attachment.shapes.truncated)
    ),
    shapeNumbers: (options.attachment.shapes?.count ?? 0) > 0,
  });
  const system: ChatMessage = {
    role: "system",
    content: systemMessageWithFiles(stable, files),
  };

  const messages: ChatMessage[] = [
    system,
    ...toChatMessages(options.history),
    {
      role: "user",
      content: userMessageWithAttachment(options.instruction, options.attachment, notes),
    },
  ];
  await options.onMessage({
    role: "user",
    content: userMessageForHistory(options.instruction, options.attachment, files),
  });

  // An insert hands out numbers for its new paragraphs, so from that round on
  // the tools take a paragraph number even when the attachment had none.
  let numbersHandedOut = false;
  const offeredTools = () =>
    buildTools({
      search: Boolean(settings.searxngUrl.trim()),
      argos: Boolean(settings.argosBaseUrl.trim()),
      selection: hasSelection,
      numbered,
      insertedNumbers: numbersHandedOut,
      shapes: (options.attachment.shapes?.count ?? 0) > 0,
    });
  let tools = offeredTools();
  let toolsSupported = true;
  let lastUsage: Usage | null = null;
  const started = Date.now();
  const meter = {
    toolRounds: 0,
    llmCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  beginToolTurn();

  const noteUsage = (usage: Usage | null) => {
    if (!usage) {
      return;
    }
    meter.promptTokens += usage.promptTokens || 0;
    meter.completionTokens += usage.completionTokens || 0;
    meter.totalTokens += usage.totalTokens || 0;
  };

  const userMessagesText = [
    ...options.history
      .filter((message) => message.role === "user")
      .map((message) => message.content),
    options.instruction,
  ].join("\n");

  let round = 0;
  const finish = (usage: Usage | null): TurnResult => {
    meter.toolRounds = round;
    logInfo("turn", {
      toolRounds: meter.toolRounds,
      llmCalls: meter.llmCalls,
      promptTokens: meter.promptTokens,
      completionTokens: meter.completionTokens,
      totalTokens: meter.totalTokens,
      elapsedMs: Date.now() - started,
    });
    const nextTools = offeredTools();
    return {
      usage,
      nextRequestTokens: requestTokens(fitContext(messages, limit, nextTools), nextTools),
    };
  };

  const toldNoBudget = options.history.some(
    (message) => message.content === THINKING_BUDGET_UNSET_NOTICE
  );
  const end = async (usage: Usage | null): Promise<TurnResult> => {
    if (knownThinkingBudget() === null && !toldNoBudget) {
      await options.onMessage({ role: "assistant", content: THINKING_BUDGET_UNSET_NOTICE });
      messages.push({ role: "assistant", content: THINKING_BUDGET_UNSET_NOTICE });
    }
    return finish(usage);
  };

  let budgetRead = false;
  const readBudgetOnce = async (body: ChatBody, done: Streamed): Promise<void> => {
    if (budgetRead || !body.tools?.length || !done.requestId) {
      return;
    }
    budgetRead = true;
    await readThinkingBudget(settings, done.requestId);
  };

  /** MTPLX closes thinking at its budget; this only stops a call that budget did not hold. */
  const stream = async (body: ChatBody, resent = false): Promise<Streamed> => {
    const capChars = runawayThinkingChars(knownThinkingBudget() ?? null);
    const cut = new AbortController();
    const forward = () => cut.abort(signal.reason);
    signal.addEventListener("abort", forward, { once: true });
    let thought = 0;
    let bridgeLeaked = false;
    const onDelta = (snapshot: { content: string; reasoningContent: string }) => {
      thought = snapshot.reasoningContent.length;
      if (cut.signal.aborted) {
        return;
      }
      bridgeLeaked = snapshot.content.includes(THINKING_BRIDGE);
      if (bridgeLeaked || thought > capChars) {
        cut.abort();
        return;
      }
      options.onDelta?.(snapshot);
    };
    try {
      return withFinishReason(await chatStream(body, { signal: cut.signal, onDelta }));
    } catch (error) {
      if (signal.aborted || !cut.signal.aborted) {
        throw error;
      }
      if (!bridgeLeaked) {
        logInfo("thinking runaway", { reasoningChars: thought, capChars });
        throw new Error(
          `思考が ${thought} 字に達しても答えが出ないため止めました。` +
            "MTPLX に思考の上限が設定されているか確かめ、指示を分けて送り直してください。"
        );
      }
      logInfo("thinking bridge leaked", { reasoningChars: thought, resent });
      if (resent) {
        throw new Error(
          "MTPLX が思考を閉じられず、同じ文を繰り返したため止めました。" +
            "もう一度送ってください。続くときは MTPLX を再起動してください。"
        );
      }
      meter.llmCalls += 1;
      options.onDelta?.({ content: "", reasoningContent: "" });
      return stream(body, true);
    } finally {
      signal.removeEventListener("abort", forward);
    }
  };

  const send = async (withTools: boolean) => {
    meter.llmCalls += 1;
    const activeTools = withTools && toolsSupported ? tools : undefined;
    const body: ChatBody = {
      llmBaseUrl: settings.llmBaseUrl,
      llmApiKey: settings.llmApiKey,
      model: settings.llmModel,
      messages: fitContext(messages, limit, activeTools),
      tools: activeTools,
      timeoutMs: settings.timeoutMs,
    };
    options.onDelta?.({ content: "", reasoningContent: "" });
    try {
      const done = await stream(body);
      await readBudgetOnce(body, done);
      return done;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!withTools || !toolsSupported || !isToolsUnsupportedError(message)) {
        throw error;
      }
      toolsSupported = false;
      meter.llmCalls += 1;
      return stream({ ...body, tools: undefined, messages: fitContext(messages, limit) });
    }
  };

  const emitAssistant = async (completion: Awaited<ReturnType<typeof send>>): Promise<void> => {
    lastUsage = completion.usage;
    noteUsage(completion.usage);
    await options.onMessage({
      role: "assistant",
      content: completion.content,
      reasoningContent: completion.reasoningContent,
      toolCalls: completion.toolCalls,
      usage: completion.usage,
    });
    messages.push({
      role: "assistant",
      content: completion.content,
      // Kept inside the turn: Qwen expects its own reasoning back with the tool replies.
      reasoning_content: completion.reasoningContent || undefined,
      tool_calls: completion.toolCalls.length ? completion.toolCalls : undefined,
    });
  };

  const maxRounds = settings.maxToolRounds;
  while (true) {
    if (maxRounds !== UNLIMITED_TOOL_ROUNDS && round >= maxRounds) {
      const notice = toolRoundLimitNotice(maxRounds);
      await options.onMessage({ role: "assistant", content: notice });
      messages.push({ role: "assistant", content: notice });
      return end(lastUsage);
    }

    const completion = await send(true);
    await emitAssistant(completion);

    if (!completion.toolCalls.length) {
      if (!completion.content.trim()) {
        const notice = silentEndNotice(completion.finishReason);
        await options.onMessage({ role: "assistant", content: notice });
        messages.push({ role: "assistant", content: notice });
      }
      return end(lastUsage);
    }

    // Ids are `call_${index}` when the server omits them, so they repeat across
    // rounds. Only results written for this round count as answering this round.
    const answeredThisRound = new Set<string>();
    try {
      for (const call of completion.toolCalls) {
        signal.throwIfAborted();
        const toolContents = messages
          .filter((message) => message.role === "tool")
          .map((message) => message.content || "");
        const outcome = await executeToolCall(call, settings, signal, {
          argosPathPrefixes: options.argosPathPrefixes,
          indexedReadChars: indexedReadCharLimit(limit, toolContents),
          hasBody,
          userMessagesText,
        });
        await options.onMessage({ role: "tool", content: outcome.content, toolCallId: call.id });
        messages.push({ role: "tool", content: outcome.content, tool_call_id: call.id });
        answeredThisRound.add(call.id);
        if (outcome.numbered && !numbersHandedOut) {
          numbersHandedOut = true;
          tools = offeredTools();
        }
        signal.throwIfAborted();
      }
    } catch (error) {
      if (!isAbortError(error, signal)) {
        throw error;
      }
      // The assistant turn is already stored with tool_calls. Close every call
      // that did not finish, or the next request is rejected.
      for (const call of completion.toolCalls) {
        if (answeredThisRound.has(call.id)) {
          continue;
        }
        await options.onMessage({
          role: "tool",
          content: ABORTED_TOOL_RESULT,
          toolCallId: call.id,
        });
        messages.push({
          role: "tool",
          content: ABORTED_TOOL_RESULT,
          tool_call_id: call.id,
        });
        answeredThisRound.add(call.id);
      }
      throw error;
    }
    round += 1;
  }
}
