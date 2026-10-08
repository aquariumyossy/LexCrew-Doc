import { Attachment } from "../../shared/attachment";
import { CommittedFile, clampFiles, fileCharBudget } from "../../shared/fileSource";
import { NewMessage, StoredMessage } from "../../shared/history";
import {
  systemPrompt,
  userMessageForHistory,
  userMessageWithAttachment,
} from "../../shared/prompts";
import { joinArgosScopes } from "../../shared/argos";
import { Usage } from "../../shared/stripThinking";
import {
  looksLikeFormatInstruction,
  resolveFormatThinking,
} from "../../shared/thinking";
import {
  UNLIMITED_TOOL_ROUNDS,
  buildTools,
  isFormattingTool,
  isToolsUnsupportedError,
  toolRoundLimitNotice,
} from "../../shared/tools";
import { logInfo } from "../../sidecar/logger";
import { ChatMessage } from "../../sidecar/types";
import { chatStream } from "../api";
import { Settings } from "../settings";
import { documentHasVisibleText, isWordHost } from "../word";
import { fitContext, indexedReadCharLimit, messagesTokens, toChatMessages } from "./context";
import { beginToolTurn, executeToolCall } from "./execute";

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
  const hasBody =
    shown !== null ? shown : isWordHost() ? await documentHasVisibleText() : false;
  const system: ChatMessage = {
    role: "system",
    content: systemPrompt({
      fontName: settings.fontName,
      bodyPt: settings.bodyPt,
      titlePt: settings.titlePt,
      lineSpacingChars: settings.lineSpacingChars,
      hasBody,
      search: Boolean(settings.searxngUrl.trim()),
      argos: Boolean(settings.argosBaseUrl.trim()),
      argosPathPrefix: joinArgosScopes(options.argosPathPrefixes || []),
      selection: hasSelection,
      numbered,
      markup: options.attachment.markup,
      reviewedBody: Boolean(options.attachment.document.trim()) || options.attachment.scope !== "none",
      reviewedFallback: options.attachment.reviewedFallback === true,
      inlineMarkup: options.attachment.inlineMarkup === true,
      files: Boolean(options.files?.length),
      listMarks: Boolean(options.attachment.listMarks),
      shapes: Boolean(
        options.attachment.shapes &&
          (options.attachment.shapes.text ||
            options.attachment.shapes.error ||
            options.attachment.shapes.truncated)
      ),
      shapeNumbers: (options.attachment.shapes?.count ?? 0) > 0,
    }),
  };

  /*
   * The files share what the rest of this request does not already take. They
   * sit in the current message, which `dropOldest` never drops, so anything
   * over the window has to be cut here rather than trimmed later.
   */
  const reserved =
    system.content.length +
    userMessageWithAttachment(options.instruction, options.attachment).length;
  const files = clampFiles(options.files || [], fileCharBudget(limit, reserved));

  const messages: ChatMessage[] = [
    system,
    ...toChatMessages(options.history),
    {
      role: "user",
      content: userMessageWithAttachment(options.instruction, options.attachment, files),
    },
  ];
  await options.onMessage({
    role: "user",
    content: userMessageForHistory(options.instruction, options.attachment, files),
  });

  // An insert hands out numbers for its new paragraphs, so from that round on
  // the tools take a paragraph number even when the attachment had none.
  let numbersHandedOut = false;
  const toolsFor = () =>
    buildTools({
      search: Boolean(settings.searxngUrl.trim()),
      argos: Boolean(settings.argosBaseUrl.trim()),
      selection: hasSelection,
      numbered,
      insertedNumbers: numbersHandedOut,
      shapes: (options.attachment.shapes?.count ?? 0) > 0,
    });
  let tools = toolsFor();
  let toolsSupported = true;
  let lastUsage: Usage | null = null;
  // Lower thinking only after the user opts in. The first call uses the hint;
  // later calls follow it once a formatting tool has actually run.
  let formatWork = looksLikeFormatInstruction(options.instruction);
  const started = Date.now();
  const meter = {
    toolRounds: 0,
    llmCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  beginToolTurn();

  const thinkingFor = () =>
    formatWork
      ? resolveFormatThinking(settings.formatThinkingLevel, settings.thinkingLevel)
      : settings.thinkingLevel;

  const noteUsage = (usage: Usage | null) => {
    if (!usage) {
      return;
    }
    meter.promptTokens += usage.promptTokens || 0;
    meter.completionTokens += usage.completionTokens || 0;
    meter.totalTokens += usage.totalTokens || 0;
  };

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
    return { usage, nextRequestTokens: messagesTokens(fitContext(messages, limit)) };
  };

  const send = async (withTools: boolean) => {
    meter.llmCalls += 1;
    const body = {
      llmBaseUrl: settings.llmBaseUrl,
      llmApiKey: settings.llmApiKey,
      model: settings.llmModel,
      messages: fitContext(messages, limit),
      tools: withTools && toolsSupported ? tools : undefined,
      thinkingLevel: thinkingFor(),
      thinkingBudget: settings.thinkingBudget,
      timeoutMs: settings.timeoutMs,
    };
    options.onDelta?.({ content: "", reasoningContent: "" });
    try {
      return await chatStream(body, { signal, onDelta: options.onDelta });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!withTools || !toolsSupported || !isToolsUnsupportedError(message)) {
        throw error;
      }
      toolsSupported = false;
      meter.llmCalls += 1;
      return chatStream({ ...body, tools: undefined }, { signal, onDelta: options.onDelta });
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
      return finish(lastUsage);
    }

    const completion = await send(true);
    await emitAssistant(completion);

    if (!completion.toolCalls.length) {
      return finish(lastUsage);
    }

    for (const call of completion.toolCalls) {
      signal.throwIfAborted();
      const toolContents = messages
        .filter((message) => message.role === "tool")
        .map((message) => message.content || "");
      const outcome = await executeToolCall(call, settings, signal, {
        argosPathPrefixes: options.argosPathPrefixes,
        indexedReadChars: indexedReadCharLimit(limit, toolContents),
        hasBody,
      });
      await options.onMessage({ role: "tool", content: outcome.content, toolCallId: call.id });
      messages.push({ role: "tool", content: outcome.content, tool_call_id: call.id });
      if (outcome.numbered && !numbersHandedOut) {
        numbersHandedOut = true;
        tools = toolsFor();
      }
      if (isFormattingTool(call.function.name)) {
        formatWork = true;
      }
    }
    round += 1;
  }
}
