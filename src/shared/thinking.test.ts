import { describe, expect, it } from "vitest";
import { DEFAULT_THINKING_BUDGET, MIN_THINKING_BUDGET } from "./constants";
import {
  looksLikeFormatInstruction,
  normalizeFormatThinkingLevel,
  normalizeThinkingBudget,
  normalizeThinkingLevel,
  resolveFormatThinking,
  thinkingFields,
} from "./thinking";

describe("thinkingFields", () => {
  it("sends medium effort and no budget, which MTPLX does not read", () => {
    expect(thinkingFields("medium")).toEqual({
      reasoning_effort: "medium",
      chat_template_kwargs: { enable_thinking: true },
    });
  });

  it("maps the high level to xhigh", () => {
    expect(thinkingFields("high").reasoning_effort).toBe("xhigh");
  });

  it("disables thinking only when the user picks off", () => {
    expect(thinkingFields("off")).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    });
  });
});

describe("normalizeThinkingBudget", () => {
  it("falls back to the default budget and enforces a floor", () => {
    expect(normalizeThinkingBudget(0)).toBe(DEFAULT_THINKING_BUDGET);
    expect(normalizeThinkingBudget(8)).toBe(MIN_THINKING_BUDGET);
  });
});

describe("normalizeThinkingLevel", () => {
  it("falls back to medium for unknown values", () => {
    expect(normalizeThinkingLevel("xhigh")).toBe("medium");
    expect(normalizeThinkingLevel(undefined)).toBe("medium");
    expect(normalizeThinkingLevel("off")).toBe("off");
  });
});

describe("format thinking", () => {
  it("stays on the chat level until the user picks another", () => {
    expect(normalizeFormatThinkingLevel(undefined)).toBe("same");
    expect(normalizeFormatThinkingLevel("nope")).toBe("same");
    expect(normalizeFormatThinkingLevel("low")).toBe("low");
    expect(resolveFormatThinking("same", "medium")).toBe("medium");
    expect(resolveFormatThinking("off", "medium")).toBe("off");
  });

  it("notices a formatting instruction and ignores a drafting one", () => {
    expect(looksLikeFormatInstruction("見出しを太字にして行間を詰めて")).toBe(true);
    expect(looksLikeFormatInstruction("第3条を短くして")).toBe(false);
  });
});
