import { describe, expect, it } from "vitest";
import { indexedPathAllowed, rememberIndexedPath, sliceIndexedText } from "./indexedRead";

describe("indexed path allow list", () => {
  it("accepts a path a search returned and refuses a made-up one", () => {
    const allowed = new Set<string>();
    rememberIndexedPath(allowed, "C:\\案件\\委託基本契約書.docx");
    expect(indexedPathAllowed("C:\\案件\\委託基本契約書.docx", allowed)).toBe(true);
    expect(indexedPathAllowed("C:\\案件\\別の契約.docx", allowed)).toBe(false);
    expect(indexedPathAllowed("C:\\案件\\..\\秘密.docx", allowed)).toBe(false);
  });

  it("ignores a blank path", () => {
    const allowed = new Set<string>();
    rememberIndexedPath(allowed, "  ");
    expect(allowed.size).toBe(0);
  });
});

describe("sliceIndexedText", () => {
  it("returns the next slice inside the limit and the offset to continue from", () => {
    const text = "あ".repeat(80);
    const first = sliceIndexedText(text, 0, 40);
    expect(first.length).toBeLessThanOrEqual(40);
    expect(first).toContain("offset を");
    const offset = Number(first.match(/offset を (\d+)/)?.[1]);
    expect(offset).toBeGreaterThan(0);
    const rest = sliceIndexedText(text, offset, 40);
    expect(rest.length).toBeLessThanOrEqual(40);
    expect(rest.startsWith("あ")).toBe(true);
    expect(sliceIndexedText(text, text.length, 40)).toBe("この offset より先はありません。");
  });
});
