import { ToolCall, normalizeToolCalls } from "./tools";

/**
 * Drop leftover <think> blocks. Servers that return a separate reasoning
 * channel never need this; it is a guard for the ones that inline it.
 */
export function stripThinking(text: string): string {
  if (!text) {
    return "";
  }

  let out = text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "");
  out = out.replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, "");
  out = out.replace(/<think\b[^>]*>[\s\S]*$/gi, "");
  out = out.replace(/<thinking\b[^>]*>[\s\S]*$/gi, "");

  return out.trim();
}

export type Usage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
};

export type Completion = {
  content: string;
  reasoningContent: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: Usage | null;
};

function readString(row: Record<string, unknown> | undefined, key: string): string {
  const value = row?.[key];
  return typeof value === "string" ? value : "";
}

function readNumber(row: Record<string, unknown> | undefined, key: string): number {
  const value = row?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  return input as Record<string, unknown>;
}

function parseUsage(input: unknown): Usage | null {
  const row = asRecord(input);
  if (!row) {
    return null;
  }
  const details = asRecord(row.completion_tokens_details);
  return {
    promptTokens: readNumber(row, "prompt_tokens"),
    completionTokens: readNumber(row, "completion_tokens"),
    totalTokens: readNumber(row, "total_tokens"),
    reasoningTokens: readNumber(details, "reasoning_tokens"),
  };
}

export function parseCompletion(payload: unknown): Completion {
  const root = asRecord(payload);
  const choices = root?.choices;
  const choice = asRecord(Array.isArray(choices) ? choices[0] : undefined);
  const message = asRecord(choice?.message);

  const rawContent = message ? readString(message, "content") : readString(choice, "text");
  const reasoning = readString(message, "reasoning_content") || readString(message, "reasoning");

  return {
    content: stripThinking(rawContent),
    reasoningContent: reasoning,
    toolCalls: normalizeToolCalls(message?.tool_calls),
    finishReason: readString(choice, "finish_reason"),
    usage: parseUsage(root?.usage),
  };
}
