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
  UNLIMITED_TOOL_ROUNDS,
  buildTools,
  isToolsUnsupportedError,
  toolRoundLimitNotice,
} from "../../shared/tools";
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
    });
  let tools = toolsFor();
  let toolsSupported = true;
  let lastUsage: Usage | null = null;
  beginToolTurn();

  const send = async (withTools: boolean) => {
    const body = {
      llmBaseUrl: settings.llmBaseUrl,
      llmApiKey: settings.llmApiKey,
      model: settings.llmModel,
      messages: fitContext(messages, limit),
      tools: withTools && toolsSupported ? tools : undefined,
      thinkingLevel: settings.thinkingLevel,
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
      return chatStream({ ...body, tools: undefined }, { signal, onDelta: options.onDelta });
    }
  };

  const emitAssistant = async (completion: Awaited<ReturnType<typeof send>>): Promise<void> => {
    lastUsage = completion.usage;
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
  let round = 0;
  while (true) {
    if (maxRounds !== UNLIMITED_TOOL_ROUNDS && round >= maxRounds) {
      const notice = toolRoundLimitNotice(maxRounds);
      await options.onMessage({ role: "assistant", content: notice });
      messages.push({ role: "assistant", content: notice });
      return { usage: lastUsage, nextRequestTokens: messagesTokens(fitContext(messages, limit)) };
    }

    const completion = await send(true);
    await emitAssistant(completion);

    if (!completion.toolCalls.length) {
      return { usage: lastUsage, nextRequestTokens: messagesTokens(fitContext(messages, limit)) };
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
    }
    round += 1;
  }
}
