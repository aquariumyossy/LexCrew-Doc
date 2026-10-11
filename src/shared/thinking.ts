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

/**
 * MTPLX's default `MTPLX_THINKING_BRIDGE`, written just before it force-closes
 * thinking at the budget. Seen in the answer, it means the close did not land
 * and the guard is re-forcing it in a loop.
 */
export const THINKING_BRIDGE = "I have enough analysis — deciding now and acting.";

export const THINKING_BUDGET_UNSET_NOTICE =
  "MTPLX に思考の上限（--agent-thinking-budget）が設定されていません。" +
  `上限がないと思考が長く続くことがあるため、作業ウィンドウは思考が ${runawayThinkingChars(null).toLocaleString("ja-JP")} 字を超えたところでターンを止めます。` +
  "MTPLX の起動設定で上限を指定してください。";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * MTPLX guards only requests that carry tools with thinking on, so an empty
 * guard on such a request means no budget is set; on any other it says nothing.
 */
function budgetOfRecord(record: Record<string, unknown>): number | null | undefined {
  const guard = asRecord(record.thinking_guard);
  const budget = guard?.budget_tokens;
  if (guard?.enabled === true && typeof budget === "number" && budget > 0) {
    return budget;
  }
  const covered = record.request_enable_thinking === true && Number(record.request_tool_count) > 0;
  return covered ? null : undefined;
}

/**
 * The budget MTPLX applied, read from its `GET /metrics` records: a token
 * count, null when none is set, undefined when the records do not say.
 * Without a request id the newest record that says anything decides.
 * Twin of `budget_from_metrics` in `src-tauri/src/thinking.rs`.
 */
export function budgetFromMetrics(metrics: unknown, requestId?: string): number | null | undefined {
  const recent = asRecord(metrics)?.recent;
  const records = (Array.isArray(recent) ? recent : [])
    .map(asRecord)
    .filter((record): record is Record<string, unknown> => Boolean(record))
    .filter((record) => requestId === undefined || record.request_id === requestId)
    .reverse();
  for (const record of records) {
    const budget = budgetOfRecord(record);
    if (budget !== undefined) {
      return budget;
    }
  }
  return undefined;
}
