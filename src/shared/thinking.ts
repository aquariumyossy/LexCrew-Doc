import { DEFAULT_THINKING_BUDGET, DEFAULT_THINKING_LEVEL, MIN_THINKING_BUDGET } from "./constants";

export type ThinkingLevel = "low" | "medium" | "high" | "off";

/** Use the chat's thinking level. The default, so formatting does not get quieter on its own. */
export type FormatThinkingLevel = ThinkingLevel | "same";

export const THINKING_LEVELS: ThinkingLevel[] = ["low", "medium", "high", "off"];

export const FORMAT_THINKING_LEVELS: FormatThinkingLevel[] = ["same", ...THINKING_LEVELS];

export const FORMAT_THINKING_LABELS: Record<FormatThinkingLevel, string> = {
  same: "同じ",
  low: "低",
  medium: "中",
  high: "高",
  off: "オフ",
};

export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  low: "低",
  medium: "中",
  high: "高",
  off: "オフ",
};

export type ChatTemplateKwargs = {
  enable_thinking: boolean;
};

export type ThinkingFields = {
  reasoning_effort?: "low" | "medium" | "xhigh";
  chat_template_kwargs?: ChatTemplateKwargs;
};

export function normalizeThinkingLevel(value: unknown): ThinkingLevel {
  return THINKING_LEVELS.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : DEFAULT_THINKING_LEVEL;
}

/** Unknown values stay on "same" so an old settings file does not change thinking. */
export function normalizeFormatThinkingLevel(value: unknown): FormatThinkingLevel {
  if (value === "same" || value === undefined || value === null || value === "") {
    return "same";
  }
  return THINKING_LEVELS.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : "same";
}

export function resolveFormatThinking(
  formatLevel: FormatThinkingLevel,
  thinkingLevel: ThinkingLevel
): ThinkingLevel {
  return formatLevel === "same" ? thinkingLevel : formatLevel;
}

/**
 * A coarse hint that this instruction is about appearance rather than drafting.
 * Used only when the user has set a separate thinking level for formatting.
 */
const FORMAT_INSTRUCTION =
  /書式|フォント|字体|太字|斜体|下線|インデント|字下げ|ぶら下げ|行間|行送り|段落前|段落後|両端揃え|中央揃え|文字色|蛍光ペン|アウトライン|見出しレベル|文字の大きさ|文字サイズ/;

export function looksLikeFormatInstruction(instruction: string): boolean {
  return FORMAT_INSTRUCTION.test(instruction || "");
}

/** The level a call is sent again at after its thinking ran past the budget. */
export type ThinkingRetryLevel = "low" | "off";

export const THINKING_RETRY_LEVELS: ThinkingRetryLevel[] = ["low", "off"];

export const DEFAULT_THINKING_RETRY_LEVEL: ThinkingRetryLevel = "low";

export function normalizeThinkingRetryLevel(value: unknown): ThinkingRetryLevel {
  return THINKING_RETRY_LEVELS.includes(value as ThinkingRetryLevel)
    ? (value as ThinkingRetryLevel)
    : DEFAULT_THINKING_RETRY_LEVEL;
}

const THINKING_RANK: Record<ThinkingLevel, number> = { off: 0, low: 1, medium: 2, high: 3 };

/** Where a cut call goes next: the retry level when it is lower, else no thinking. */
export function thinkingAfterCut(cut: ThinkingLevel, retry: ThinkingRetryLevel): ThinkingLevel {
  return THINKING_RANK[retry] < THINKING_RANK[cut] ? retry : "off";
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
 * `chat_template_kwargs.enable_thinking`. It does not read a token budget, so
 * none is sent; the pane cuts a call short when its thinking runs too long.
 */
export function thinkingFields(level: ThinkingLevel): ThinkingFields {
  if (level === "off") {
    return { chat_template_kwargs: { enable_thinking: false } };
  }
  const effort = level === "high" ? "xhigh" : level;
  return {
    reasoning_effort: effort,
    chat_template_kwargs: { enable_thinking: true },
  };
}
