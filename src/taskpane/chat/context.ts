import { CHARS_PER_TOKEN, MAX_FILE_CHARS, TOOL_RESULT_BUDGET_RATIO } from "../../shared/constants";
import { StoredMessage } from "../../shared/history";
import { stripAttachment } from "../../shared/prompts";
import { isDocumentSnapshotTool, STALE_DOCUMENT_READ } from "../../shared/tools";
import { logInfo } from "../../sidecar/logger";
import { ChatMessage } from "../../sidecar/types";

/** Tool result written when a turn is cancelled before the call runs. Replay uses the same text to close an orphan already stored. */
export const ABORTED_TOOL_RESULT = "中止しました";

/** Rough count used for the header readout and for trimming. */
export function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / CHARS_PER_TOKEN);
}

export function messageTokens(message: ChatMessage): number {
  let total = estimateTokens(message.content || "");
  for (const call of message.tool_calls || []) {
    total += estimateTokens(call.function.name) + estimateTokens(call.function.arguments);
  }
  // Role and delimiters cost a few tokens per message.
  return total + 4;
}

export function messagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + messageTokens(message), 0);
}

/**
 * The tool schema rides in the request beside the messages. The meter and
 * `fitContext` both count it; leaving it out under-reads the window by the
 * whole schema (about ten thousand tokens for this tool set).
 */
export function toolSchemaTokens(tools: readonly unknown[] | null | undefined): number {
  if (!tools?.length) {
    return 0;
  }
  return estimateTokens(JSON.stringify(tools));
}

/** Messages plus the tool schema the server also bills. */
export function requestTokens(messages: ChatMessage[], tools?: readonly unknown[] | null): number {
  return messagesTokens(messages) + toolSchemaTokens(tools);
}

/**
 * Past turns are replayed without their reasoning channel to save context.
 * Within a single turn the loop keeps it, which is what Qwen expects.
 *
 * Attachments are dropped too. The current one is read from the document each
 * turn, so an old copy would only describe a document that has since changed —
 * and would crowd out the room the new one needs.
 *
 * A document snapshot is replaced here, on replay, with one constant string.
 * The turn that produced the read still sends the full text: that copy lives
 * in the in-memory messages and is not loaded back from history. Every later
 * turn substitutes the same constant, so the replayed prefix does not change
 * from one of those turns to the next. The single divergence is the boundary
 * out of the producing turn (full text there, the stub afterwards). Saving the
 * stub instead of the read would not close that gap, because the model still
 * has to see the snapshot before the turn ends.
 */
/**
 * Name of the call this tool message answers. The server often omits ids, and
 * the client then reuses `call_${index}` every round, so a map of the whole
 * conversation would attach a later call's name to an earlier result. Only the
 * assistant message immediately before this run of tool messages counts, and
 * the nth result with an id answers the nth call with that id.
 */
export function toolNameForResult(stored: StoredMessage[], index: number): string {
  let cursor = index;
  while (cursor > 0 && stored[cursor].role === "tool") {
    cursor -= 1;
  }
  const assistant = stored[cursor];
  if (cursor === index || assistant?.role !== "assistant") {
    return "";
  }
  const id = stored[index].toolCallId;
  let seen = 0;
  for (let at = cursor + 1; at <= index; at += 1) {
    if (stored[at].role === "tool" && stored[at].toolCallId === id) {
      seen += 1;
    }
  }
  let match = 0;
  for (const call of assistant.toolCalls) {
    if (call.id !== id) {
      continue;
    }
    match += 1;
    if (match === seen) {
      return call.function.name;
    }
  }
  return "";
}

export function toChatMessages(stored: StoredMessage[]): ChatMessage[] {
  const chat = stored.map((message, index) => {
    let content = message.role === "user" ? stripAttachment(message.content) : message.content;
    if (message.role === "tool" && isDocumentSnapshotTool(toolNameForResult(stored, index))) {
      content = STALE_DOCUMENT_READ;
    }
    const mapped: ChatMessage = { role: message.role, content };
    if (message.toolCalls.length) {
      mapped.tool_calls = message.toolCalls;
    }
    if (message.toolCallId) {
      mapped.tool_call_id = message.toolCallId;
    }
    return mapped;
  });
  return repairMissingToolResults(chat);
}

/**
 * A cancelled turn can leave an assistant `tool_calls` with no tool result,
 * and the server rejects that on the next request. `call_${index}` is reused
 * whenever the server omits ids, so a call is answered only by a tool message
 * with that id in the contiguous run immediately after that assistant message.
 * A tool message with no matching call in that run is dropped. A complete
 * transcript is left as it was stored.
 */
function repairMissingToolResults(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "tool") {
      continue;
    }
    out.push(message);
    if (message.role !== "assistant" || !message.tool_calls?.length) {
      continue;
    }
    const waiting = new Map<string, number>();
    for (const call of message.tool_calls) {
      waiting.set(call.id, (waiting.get(call.id) || 0) + 1);
    }
    let follow = index + 1;
    while (follow < messages.length && messages[follow].role === "tool") {
      const tool = messages[follow];
      const id = tool.tool_call_id || "";
      const left = waiting.get(id) || 0;
      if (left > 0) {
        out.push(tool);
        waiting.set(id, left - 1);
      }
      follow += 1;
    }
    for (const call of message.tool_calls) {
      const left = waiting.get(call.id) || 0;
      if (left > 0) {
        out.push({ role: "tool", content: ABORTED_TOOL_RESULT, tool_call_id: call.id });
        waiting.set(call.id, left - 1);
      }
    }
    index = follow - 1;
  }
  return out;
}

function truncate(text: string, maxTokens: number): string {
  const maxChars = Math.max(0, maxTokens * CHARS_PER_TOKEN);
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n…（長いので省略しました）`;
}

/**
 * How much of an indexed file the next tool result can carry.
 * `capToolResults` shrinks a result, newest included, once the tool share is over.
 */
export function indexedReadCharLimit(contextLimit: number, toolContents: string[]): number {
  const budget = Math.floor(contextLimit * TOOL_RESULT_BUDGET_RATIO);
  const used = toolContents.reduce(
    (total, content) => total + messageTokens({ role: "tool", content }),
    0
  );
  const room = budget - used - 4;
  if (room <= 0) {
    return 0;
  }
  return Math.min(MAX_FILE_CHARS, Math.floor(room * CHARS_PER_TOKEN));
}

/**
 * Search hits and other tool output must not crowd out the conversation, so
 * they get their own share of the window; the oldest ones shrink first.
 */
export function capToolResults(messages: ChatMessage[], limit: number): ChatMessage[] {
  const budget = Math.floor(limit * TOOL_RESULT_BUDGET_RATIO);
  const toolIndexes = messages
    .map((m, index) => (m.role === "tool" ? index : -1))
    .filter((i) => i >= 0);
  let used = toolIndexes.reduce((total, index) => total + messageTokens(messages[index]), 0);
  if (used <= budget) {
    return messages;
  }

  const out = [...messages];
  let shrunk = 0;
  for (const index of toolIndexes) {
    if (used <= budget) {
      break;
    }
    const before = messageTokens(out[index]);
    // Keep the newest results intact by shrinking the oldest to a stub.
    const shrunkMessage: ChatMessage = {
      ...out[index],
      content: truncate(out[index].content || "", 40),
    };
    if (shrunkMessage.content === out[index].content) {
      continue;
    }
    out[index] = shrunkMessage;
    used -= before - messageTokens(shrunkMessage);
    shrunk += 1;
  }
  if (shrunk > 0) {
    logInfo("context trim", { shrunkToolResults: shrunk, tokens: messagesTokens(out), limit });
  }
  return out;
}

/**
 * Index of the latest user message. That message is the current instruction
 * (with this turn's document behind it). Everything after it is this turn's
 * tool round. Older exchanges, between the system prompt and that message,
 * are what may be dropped.
 */
function currentTurnStart(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      return index;
    }
  }
  return Math.max(0, messages.length - 1);
}

/**
 * Drop whole exchanges from the front until the request fits. An assistant turn
 * with tool calls leaves with its tool replies: the server rejects an orphan of
 * either half.
 *
 * The system prompt (and the committed files inside it) stays. So does the
 * latest user message and everything after it: after a tool round the current
 * instruction is no longer the last message, and dropping it would send the
 * next call with no instruction.
 */
export function dropOldest(messages: ChatMessage[], limit: number): ChatMessage[] {
  const pinnedFront = messages[0]?.role === "system" ? 1 : 0;
  const out = [...messages];
  let dropped = 0;

  while (messagesTokens(out) > limit && currentTurnStart(out) > pinnedFront) {
    const removed = out.splice(pinnedFront, 1)[0];
    dropped += 1;
    if (removed.tool_calls?.length) {
      while (out[pinnedFront]?.role === "tool" && pinnedFront < currentTurnStart(out)) {
        out.splice(pinnedFront, 1);
        dropped += 1;
      }
    }
  }
  if (dropped > 0) {
    logInfo("context trim", { dropped, tokens: messagesTokens(out), limit });
  }
  return out;
}

export function fitContext(
  messages: ChatMessage[],
  limit: number,
  tools?: readonly unknown[] | null
): ChatMessage[] {
  const room = Math.max(0, limit - toolSchemaTokens(tools));
  return dropOldest(capToolResults(messages, room), room);
}
