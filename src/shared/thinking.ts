import { DEFAULT_THINKING_BUDGET, MIN_THINKING_BUDGET } from "./constants";

export type ThinkingLevel = "low" | "medium" | "high" | "off";

export const THINKING_LEVELS: ThinkingLevel[] = ["low", "medium", "high", "off"];

export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  low: "低",
  medium: "中",
  high: "高",
  off: "オフ",
};

export type ChatTemplateKwargs = {
  enable_thinking: boolean;
  thinking_budget?: number;
};

export type ThinkingFields = {
  reasoning_effort?: "low" | "medium" | "xhigh";
  thinking_budget?: number;
  chat_template_kwargs?: ChatTemplateKwargs;
};

export function normalizeThinkingLevel(value: unknown): ThinkingLevel {
  return THINKING_LEVELS.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : "medium";
}

export function normalizeThinkingBudget(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_THINKING_BUDGET;
  }
  return Math.max(MIN_THINKING_BUDGET, Math.round(n));
}

/**
 * MTPLX keeps thinking on by default and honours `reasoning_effort` plus Qwen's
 * `chat_template_kwargs`. Long deliberation is bounded by the budget, not by
 * turning thinking off: with reasoning disabled, Qwen 3.8 has been seen to emit
 * stray tool calls and cut the turn short.
 */
export function thinkingFields(level: ThinkingLevel, budget: number): ThinkingFields {
  if (level === "off") {
    return { chat_template_kwargs: { enable_thinking: false } };
  }
  const n = normalizeThinkingBudget(budget);
  const effort = level === "high" ? "xhigh" : level;
  return {
    reasoning_effort: effort,
    thinking_budget: n,
    chat_template_kwargs: { enable_thinking: true, thinking_budget: n },
  };
}
