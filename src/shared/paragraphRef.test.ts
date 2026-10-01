import { describe, expect, it } from "vitest";
import { formatParagraphRef, isParagraphRef, parseParagraphRef } from "./paragraphRef";

describe("paragraphRef", () => {
  it("formats and parses paragraph references", () => {
    expect(formatParagraphRef(12)).toBe("[段落 12]");
    expect(parseParagraphRef("[段落 12]")).toBe(12);
    expect(isParagraphRef("[段落 12]")).toBe(true);
    expect(isParagraphRef("第12条")).toBe(false);
  });
});
