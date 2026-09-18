import { describe, expect, it } from "vitest";
import { MAX_OCR_PAGE_CHARS, OCR_PROMPT, isLoopbackUrl, visionUnsupportedMessage } from "./ocr";

describe("OCR_PROMPT", () => {
  it("asks for the text as written, not for a summary", () => {
    expect(OCR_PROMPT).toContain("そのまま書き出して");
    expect(OCR_PROMPT).toContain("要約");
    // A blank page must come back blank, or an apology becomes the body.
    expect(OCR_PROMPT).toContain("空で返して");
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
