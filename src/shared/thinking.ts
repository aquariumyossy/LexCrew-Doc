export type ThinkingFields = {
  chat_template_kwargs: { enable_thinking: boolean };
};

/**
 * MTPLX picks the thinking strength and caps it with its own budget, so only
 * Qwen's on/off switch is sent.
 */
export function thinkingFields(enabled: boolean): ThinkingFields {
  return { chat_template_kwargs: { enable_thinking: enabled } };
}

/** The budget assumed when MTPLX shows none: what its "auto" mode gives medium. */
export const FALLBACK_THINKING_BUDGET = 3_072;

/** Observed thinking ran up to 5 characters a token; 8 keeps a capped call clear of the cut. */
const RUNAWAY_CHARS_PER_TOKEN = 8;

export function runawayThinkingChars(budget: number | null): number {
  return (budget ?? FALLBACK_THINKING_BUDGET) * RUNAWAY_CHARS_PER_TOKEN;
}
