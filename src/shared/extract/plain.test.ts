import { describe, expect, it } from "vitest";
import { FileReadError } from "../fileExtract";
import { decodeUtf8, htmlToText, pdfNeedsOcr, pdfPagesToText } from "./plain";

describe("decodeUtf8", () => {
  it("drops a byte order mark", () => {
    const bytes = new TextEncoder().encode("\ufeff契約書");
    expect(decodeUtf8(bytes)).toBe("契約書");
  });

  it("refuses bytes that are not UTF-8 rather than guessing", () => {
    // Shift-JIS for 日本. Decoding it as UTF-8 would produce plausible nonsense.
    const shiftJis = new Uint8Array([0x93, 0xfa, 0x96, 0x7b]);
    // The wording reaches a badge, and only a real encoding failure may say it:
    // a `TypeError` from anywhere else used to be reported as this.
    expect(() => decodeUtf8(shiftJis)).toThrow(FileReadError);
    expect(() => decodeUtf8(shiftJis)).toThrow(/UTF-8 で保存し直して/);
  });
});

describe("htmlToText", () => {
  it("keeps the text and throws away scripts and styles", () => {
    const html = `<html><head><title>題</title><style>p{color:red}</style></head>
      <body><h1>第1条</h1><p>本文です。</p><script>alert(1)</script>
      <table><tr><td>甲</td><td>乙</td></tr></table></body></html>`;
    expect(htmlToText(html)).toBe("第1条\n本文です。\n甲\t乙");
  });

  it("decodes entities in the text", () => {
    expect(htmlToText("<p>甲 &amp; 乙</p>")).toBe("甲 & 乙");
  });
});

describe("pdf pages", () => {
  it("sends a short caption to OCR, and ignores spaces and line breaks", () => {
    expect(pdfNeedsOcr(["", "  ", "1"])).toBe(true);
    expect(pdfNeedsOcr(["", "  \n "])).toBe(true);
    expect(pdfNeedsOcr([])).toBe(true);
    expect(pdfNeedsOcr(["あ".repeat(200)])).toBe(true);
    expect(pdfNeedsOcr(["あ".repeat(50) + " \n\t　" + "い".repeat(150)])).toBe(true);
  });

  it("keeps the text layer when any page is longer than the caption", () => {
    expect(pdfNeedsOcr(["あ".repeat(201)])).toBe(false);
    expect(pdfNeedsOcr(["あ".repeat(200), "い".repeat(201)])).toBe(false);
  });

  it("joins pages and records where the text came from", () => {
    const read = pdfPagesToText(["第1条", "", "第2条"], "ocr");
    expect(read.body).toBe("第1条\n\n第2条");
    expect(read.origin).toBe("ocr");
    expect(read.comments.items).toEqual([]);
  });
});
