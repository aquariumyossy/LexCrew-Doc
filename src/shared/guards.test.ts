import { describe, expect, it } from "vitest";
import { assertChatInput } from "./guards";

describe("assertChatInput", () => {
  it("refuses an empty instruction", () => {
    expect(() => assertChatInput("  \n")).toThrow(/指示/);
  });

  it("accepts an instruction with nothing attached", () => {
    expect(() => assertChatInput("契約の骨子を作って")).not.toThrow();
  });

  it("no longer refuses long input: the attachment is trimmed to the budget instead", () => {
    expect(() => assertChatInput("あ".repeat(100_000))).not.toThrow();
  });
});
