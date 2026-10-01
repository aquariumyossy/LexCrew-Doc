import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_OCR_PAGE_CHARS, OCR_PROMPT, isLoopbackUrl, visionUnsupportedMessage } from "./ocr";

/** The Rust sidecar cannot import this module, so the prompt is copied there. */
function rustOcrPrompt(): string {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src/ocr.rs"),
    "utf8"
  );
  const start = source.indexOf("pub const OCR_PROMPT");
  const body = source.slice(start, source.indexOf(");", start));
  return [...body.matchAll(/"((?:\\.|[^"\\])*)"/g)]
    .map((match) => match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"'))
    .join("");
}

describe("OCR_PROMPT", () => {
  it("asks for the text as written, not for a summary", () => {
    expect(OCR_PROMPT).toContain("そのまま書き出して");
    expect(OCR_PROMPT).toContain("要約");
    // A blank page must come back blank, or an apology becomes the body.
    expect(OCR_PROMPT).toContain("空で返して");
  });

  it("writes chart edges under 〔図〕 and does not invent kinship", () => {
    expect(OCR_PROMPT).toContain("〔図〕");
    expect(OCR_PROMPT).toContain("山田太郎 → 山田花子");
    expect(OCR_PROMPT).toContain("山田太郎 ┄ 山田花子");
    expect(OCR_PROMPT).toContain("端点は箱の文字を短くせず");
    expect(OCR_PROMPT).toContain("親子、婚姻、養子とは書きません");
    expect(OCR_PROMPT).toContain("タブ区切り");
    expect(OCR_PROMPT).toContain("表は図にしません");
    expect(OCR_PROMPT).toContain("図が無いページでは「〔図〕」を書きません");
  });

  it("matches the Rust copy the sidecar sends", () => {
    expect(rustOcrPrompt()).toBe(OCR_PROMPT);
  });
});

describe("visionUnsupportedMessage", () => {
  it("names the setting to change when the model cannot see", () => {
    for (const detail of [
      "this model does not support image input",
      "Vision is not enabled for this deployment",
      "invalid request: content must be a string",
    ]) {
      expect(visionUnsupportedMessage(detail)).toContain("画像に対応したモデル");
    }
  });

  it("leaves an unrelated failure to be reported as it came", () => {
    expect(visionUnsupportedMessage("context length exceeded")).toBeNull();
    expect(visionUnsupportedMessage("")).toBeNull();
  });
});

describe("isLoopbackUrl", () => {
  it("knows the pictures are staying on this machine", () => {
    for (const url of [
      "http://127.0.0.1:8080/v1",
      "https://localhost:28765",
      "http://[::1]:1234/v1",
      "127.0.0.1:8080",
      "http://user:pass@127.0.0.1/v1",
    ]) {
      expect(isLoopbackUrl(url)).toBe(true);
    }
  });

  it("treats anything else, including an empty setting, as elsewhere", () => {
    for (const url of ["https://api.example.com/v1", "http://192.168.1.20:8080", "", "   "]) {
      expect(isLoopbackUrl(url)).toBe(false);
    }
  });
});

describe("MAX_OCR_PAGE_CHARS", () => {
  it("leaves room well past a dense page", () => {
    expect(MAX_OCR_PAGE_CHARS).toBeGreaterThan(10_000);
  });
});
