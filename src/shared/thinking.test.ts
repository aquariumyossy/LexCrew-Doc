import { describe, expect, it } from "vitest";
import { budgetFromMetrics, runawayThinkingChars, thinkingFields } from "./thinking";

const toolCall = { request_tool_count: 3, request_enable_thinking: true };
const guarded = (id: string, budget: number) => ({
  ...toolCall,
  request_id: id,
  thinking_guard: { enabled: true, budget_tokens: budget, think_tokens: 900, engaged: null },
});
const unguarded = (id: string) => ({ ...toolCall, request_id: id, thinking_guard: {} });

describe("budgetFromMetrics", () => {
  it("reads the budget off the record of the request", () => {
    const metrics = { latest: guarded("b", 4096), recent: [guarded("a", 2048), guarded("b", 4096)] };
    expect(budgetFromMetrics(metrics, "a")).toBe(2048);
  });

  it("says no budget is set when a tool call with thinking went unguarded", () => {
    expect(budgetFromMetrics({ recent: [unguarded("a")] }, "a")).toBeNull();
  });

  it("does not know when the record is missing or the guard never covered it", () => {
    expect(budgetFromMetrics({ recent: [guarded("a", 2048)] }, "z")).toBeUndefined();
    const plain = { request_id: "a", request_tool_count: 0, request_enable_thinking: true, thinking_guard: {} };
    expect(budgetFromMetrics({ recent: [plain] }, "a")).toBeUndefined();
    expect(budgetFromMetrics("not metrics", "a")).toBeUndefined();
  });

  it("takes the newest covered request when none is named", () => {
    const plain = { request_id: "c", request_tool_count: 0, thinking_guard: {} };
    expect(budgetFromMetrics({ recent: [guarded("a", 2048), unguarded("b"), plain] })).toBeNull();
    expect(budgetFromMetrics({ recent: [unguarded("a"), guarded("b", 2048), plain] })).toBe(2048);
    expect(budgetFromMetrics({ recent: [] })).toBeUndefined();
  });
});

describe("thinkingFields", () => {
  it("turns thinking on and leaves its strength to MTPLX", () => {
    expect(thinkingFields(true)).toEqual({ chat_template_kwargs: { enable_thinking: true } });
  });

  it("turns thinking off for calls that do not reason", () => {
    expect(thinkingFields(false)).toEqual({ chat_template_kwargs: { enable_thinking: false } });
  });
});

describe("runawayThinkingChars", () => {
  it("leaves room above the MTPLX budget for its densest observed thinking", () => {
    expect(runawayThinkingChars(2048)).toBe(16_384);
  });

  it("falls back to 3072 tokens when MTPLX shows no budget", () => {
    expect(runawayThinkingChars(null)).toBe(24_576);
  });
});
