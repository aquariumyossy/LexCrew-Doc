import { CHARS_PER_TOKEN, TOOL_RESULT_BUDGET_RATIO } from "../../shared/constants";
import { StoredMessage } from "../../shared/history";
import { stripAttachment } from "../../shared/prompts";
import { ChatMessage } from "../../sidecar/types";

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
 * Past turns are replayed without their reasoning channel to save context.
 * Within a single turn the loop keeps it, which is what Qwen expects.
 *
 * Attachments are dropped too. The current one is read from the document each
 * turn, so an old copy would only describe a document that has since changed —
 * and would crowd out the room the new one needs.
 */
export function toChatMessages(stored: StoredMessage[]): ChatMessage[] {
  return stored.map((message) => {
    const content = message.role === "user" ? stripAttachment(message.content) : message.content;
    const chat: ChatMessage = { role: message.role, content };
    if (message.toolCalls.length) {
      chat.tool_calls = message.toolCalls;
    }
    if (message.toolCallId) {
      chat.tool_call_id = message.toolCallId;
    }
    return chat;
  });
}

function truncate(text: string, maxTokens: number): string {
  const maxChars = Math.max(0, maxTokens * CHARS_PER_TOKEN);
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n…（長いので省略しました）`;
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
  for (const index of toolIndexes) {
    if (used <= budget) {
      break;
    }
    const before = messageTokens(out[index]);
    // Keep the newest results intact by shrinking the oldest to a stub.
    const shrunk: ChatMessage = { ...out[index], content: truncate(out[index].content || "", 40) };
    out[index] = shrunk;
    used -= before - messageTokens(shrunk);
  }
  return out;
}

/**
 * Drop whole exchanges from the front until the request fits. An assistant turn
 * with tool calls leaves with its tool replies: the server rejects an orphan of
 * either half.
 */
export function dropOldest(messages: ChatMessage[], limit: number): ChatMessage[] {
  const pinnedFront = messages[0]?.role === "system" ? 1 : 0;
  const out = [...messages];

  while (messagesTokens(out) > limit && out.length > pinnedFront + 1) {
    const dropped = out.splice(pinnedFront, 1)[0];
    if (dropped.tool_calls?.length) {
      while (out[pinnedFront]?.role === "tool") {
        out.splice(pinnedFront, 1);
      }
    }
  }
  return out;
}

export function fitContext(messages: ChatMessage[], limit: number): ChatMessage[] {
  return dropOldest(capToolResults(messages, limit), limit);
}
