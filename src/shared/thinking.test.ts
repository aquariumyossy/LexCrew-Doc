import { describe, expect, it } from "vitest";
import { DEFAULT_THINKING_BUDGET, MIN_THINKING_BUDGET } from "./constants";
import { normalizeThinkingLevel, thinkingFields } from "./thinking";

describe("thinkingFields", () => {
  it("sends medium effort with a budget by default", () => {
    expect(thinkingFields("medium", 2048)).toEqual({
      reasoning_effort: "medium",
      thinking_budget: 2048,
      chat_template_kwargs: { enable_thinking: true, thinking_budget: 2048 },
    });
  });

  it("maps the high level to xhigh", () => {
    expect(thinkingFields("high", 4096).reasoning_effort).toBe("xhigh");
  });

  it("disables thinking only when the user picks off", () => {
    expect(thinkingFields("off", 2048)).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it("falls back to the default budget and enforces a floor", () => {
    expect(thinkingFields("low", 0).thinking_budget).toBe(DEFAULT_THINKING_BUDGET);
    expect(thinkingFields("low", 8).thinking_budget).toBe(MIN_THINKING_BUDGET);
  });
});

describe("normalizeThinkingLevel", () => {
  it("falls back to medium for unknown values", () => {
    expect(normalizeThinkingLevel("xhigh")).toBe("medium");
    expect(normalizeThinkingLevel(undefined)).toBe("medium");
    expect(normalizeThinkingLevel("off")).toBe("off");
  });
});
