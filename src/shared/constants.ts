export const HOST = "127.0.0.1";
export const PORT = 28765;

export const DEFAULT_MODEL = "qwen3.8-flash-next";
/** Per-request wait for MTPLX. Long contracts need several minutes. */
export const DEFAULT_TIMEOUT_MS = 600_000;
/** Previous default; still stored in some localStorage blobs. */
export const LEGACY_DEFAULT_TIMEOUT_MS = 180_000;
export const MIN_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 1_800_000;
export const MAX_COMMENT_CHARS = 2_000;

export const DEFAULT_FONT_NAME = "游明朝";
export const FALLBACK_FONT_NAME = "ＭＳ 明朝";
export const DEFAULT_BODY_PT = 12;
export const DEFAULT_TITLE_PT = 16;

export const DEFAULT_THINKING_LEVEL = "medium";
export const DEFAULT_THINKING_BUDGET = 2_048;
export const MIN_THINKING_BUDGET = 64;

export const DEFAULT_CONTEXT_LIMIT = 131_072;
/** Previous default; too small to attach a contract, so stored copies are migrated. */
export const LEGACY_DEFAULT_CONTEXT_LIMIT = 32_768;
/** Share of the context limit that tool results may take before older ones are dropped. */
export const TOOL_RESULT_BUDGET_RATIO = 0.25;
/** Share of the context limit the attached document may take. */
export const ATTACHMENT_BUDGET_RATIO = 0.5;
/** Ceiling for one attachment however wide the context window is. */
export const MAX_ATTACHMENT_CHARS = 100_000;
/** Share of the attachment that comments and tracked changes may take. */
export const MARKUP_BUDGET_RATIO = 0.3;
/**
 * Attached files get their own share of the window rather than a slice of the
 * document's: the Word body is read again every turn and would otherwise leave
 * a long scan with nothing.
 */
export const FILE_BUDGET_RATIO = 0.25;
/** Ceiling for all attached files together, however wide the context window is. */
export const MAX_FILE_CHARS = 60_000;
/** Share of the window kept for the conversation itself, whatever is attached. */
export const CONVERSATION_BUDGET_RATIO = 0.2;
/** Pending and committed files together. */
export const MAX_ATTACHED_FILES = 10;
/** Pages of a scanned PDF worth reading. Matches Argos. */
export const MAX_OCR_PAGES = 20;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
/** base64 grows by 4/3, so the OCR route needs more room than the image cap. */
export const OCR_BODY_LIMIT_BYTES = 12 * 1024 * 1024;
/** How many comments and tracked changes are worth asking Word for. */
export const MAX_COMMENTS_READ = 200;
export const MAX_CHANGES_READ = 300;
/**
 * Japanese characters per token, used until the server reports real usage.
 * Fitted against 16 turns of recorded `promptTokens` on contracts and briefs:
 * 0.55 tokens per character, so 2 read about a quarter low and let the meter
 * show four tenths of a window that was already over half full.
 */
export const CHARS_PER_TOKEN = 1.6;

export const SETTINGS_STORAGE_KEY = "guri.settings.v1";
export const DOCUMENT_KEY_SETTING = "guri.documentId";

/** Same-PC Argos loopback. Use 127.0.0.1; localhost may resolve to IPv6 only. */
export const DEFAULT_ARGOS_BASE_URL = "http://127.0.0.1:17890";
export const MAX_ARGOS_SCOPES = 8;

export const DISCLAIMER =
  "出力は下書き・点検用であり、法律意見ではありません。LLM が書いた判例・条文番号は未確認として扱ってください。Word に「出典」として入れるのは SearXNG のヒット（タイトル・URL）と Argos のヒット（タイトル・ファイルパス）だけです。";
