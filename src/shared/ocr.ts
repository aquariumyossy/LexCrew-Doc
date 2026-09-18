/**
 * Reading a page image. The prompt and the failure wording are kept here so the
 * Node and Rust proxies say the same thing; `src-tauri/src/ocr.rs` is the twin.
 * The notice below is the task pane's alone: the sidecar does not warn anyone.
 */

/** One page at a time, so a long scan does not depend on one huge reply. */
export const OCR_PROMPT = [
  "この画像は日本の法律文書を紙で読み取ったものです。書かれている文字をそのまま書き出してください。",
  "要約・翻訳・言い換えをしません。読めない文字は「□」にします。",
  "段落と改行は元の見た目に合わせます。表は行ごとにタブ区切りで書きます。",
  "文字が何も無ければ、何も書かずに空で返してください。感想や説明は書きません。",
].join("\n");

/** A page of dense text is around 2,000 characters; this is room to spare. */
export const MAX_OCR_PAGE_CHARS = 40_000;

/**
 * Said once per scan. A page of a contract is the client's, and the user has to
 * know it is leaving the machine before it goes.
 */
export const REMOTE_OCR_NOTICE = "画像は設定中の LLM サーバへ送られます。";

const LOOPBACK_HOSTS = new Set(["localhost", "::1", "0:0:0:0:0:0:0:1"]);

/**
 * Host of a base URL that may have no scheme, credentials, a port, or a
 * bracketed v6 address. `new URL` refuses the schemeless form the setting
 * allows, so the parts are taken apart by hand, as the Argos twin does.
 */
export function isLoopbackUrl(raw: string): boolean {
  const text = (raw || "").trim();
  if (!text) {
    return false;
  }
  const afterScheme = text.includes("://") ? text.slice(text.indexOf("://") + 3) : text;
  const hostPort = (afterScheme.split("/")[0] || "").split("@").pop() || "";
  const host = hostPort.startsWith("[") ? hostPort.slice(1).split("]")[0] : hostPort.split(":")[0];
  const lowered = host.toLowerCase();
  return LOOPBACK_HOSTS.has(lowered) || /^127\.\d+\.\d+\.\d+$/.test(lowered);
}

/** Kept as plain words, not a pattern, so the Rust twin can say the same. */
const VISION_HINTS = ["image", "vision", "multimodal", "image_url", "content must be a string"];

/**
 * A text-only model refuses the request rather than answering badly, and the
 * refusal is worth translating: the user has to pick another model, and the
 * upstream wording does not say so. Every failure on this route is about an
 * image, so matching the bare word "image" costs nothing.
 */
export function visionUnsupportedMessage(detail: string): string | null {
  const lowered = (detail || "").toLowerCase();
  return VISION_HINTS.some((hint) => lowered.includes(hint))
    ? "このモデルは画像を読めません。設定で画像に対応したモデルを選んでください。"
    : null;
}
