import { MAX_ATTACHED_FILES, MAX_IMAGE_BYTES, MAX_PDF_BYTES } from "./constants";

/**
 * How a file is read. The registry keeps the decision in one place: an
 * extension that is not here is refused at the door rather than accepted and
 * then shown as a failed badge.
 */
export type FileKind = "docx" | "sheet" | "pdf" | "text" | "html" | "image";

/**
 * A refusal with wording meant for the person who attached the file. Anything
 * else that escapes a reader is a bug or a browser limit, and has to be shown
 * with its own detail: a library's `TypeError` dressed up as "this is not
 * UTF-8" sends the user to re-save a file that was never the problem.
 */
export class FileReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileReadError";
  }
}

const KINDS: Record<string, FileKind> = {
  pdf: "pdf",
  docx: "docx",
  xlsx: "sheet",
  txt: "text",
  md: "text",
  markdown: "text",
  json: "text",
  html: "html",
  htm: "html",
  png: "image",
  jpg: "image",
  jpeg: "image",
  jpe: "image",
  gif: "image",
  webp: "image",
};

/**
 * Argos also reads these, but the task pane has no Rust extractor to fall back
 * on, so they are refused instead of accepted and failed.
 */
const KNOWN_UNSUPPORTED: Record<string, string> = {
  doc: "古い .doc は読めません。.docx で保存し直してください。",
  xls: "古い .xls は読めません。.xlsx で保存し直してください。",
  jtd: "一太郎の .jtd は読めません。PDF か .docx にしてください。",
  pptx: "PowerPoint は読めません。PDF にしてください。",
  ppt: "PowerPoint は読めません。PDF にしてください。",
};

export function fileExtension(name: string): string {
  const dot = (name || "").lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function fileKind(name: string): FileKind | null {
  return KINDS[fileExtension(name)] || null;
}

/** For the `accept` attribute of the hidden file input. */
export const ACCEPTED_EXTENSIONS = Object.keys(KINDS).map((ext) => `.${ext}`);

export function maxBytes(kind: FileKind): number {
  return kind === "image" ? MAX_IMAGE_BYTES : MAX_PDF_BYTES;
}

function mib(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

/**
 * Why this file cannot be attached, or an empty string when it can. Checked
 * before any bytes are read so a 200MB file never reaches memory.
 */
export function rejectReason(file: { name: string; size: number }): string {
  const kind = fileKind(file.name);
  if (!kind) {
    const known = KNOWN_UNSUPPORTED[fileExtension(file.name)];
    if (known) {
      return known;
    }
    return "この形式は読めません。PDF・Word・Excel・テキスト・画像のいずれかにしてください。";
  }
  if (file.size <= 0) {
    return "中身が空です。";
  }
  const limit = maxBytes(kind);
  if (file.size > limit) {
    return `${mib(limit)} を超えるので読めません。`;
  }
  return "";
}

/** Pending and committed files share the limit: both ride along on every turn. */
export function tooManyFiles(attached: number, adding: number): boolean {
  return attached + adding > MAX_ATTACHED_FILES;
}
