import { describe, expect, it } from "vitest";
import { runawayThinkingChars, thinkingFields } from "./thinking";

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
