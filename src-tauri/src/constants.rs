pub const HOST: &str = "127.0.0.1";
pub const PORT: u16 = 28765;
pub const DEFAULT_MODEL: &str = "qwen3.8-flash-next";
pub const DEFAULT_TIMEOUT_MS: u64 = 600_000;
pub const JSON_BODY_LIMIT: usize = 2 * 1024 * 1024;
/// Page images arrive base64 encoded, which grows them by 4/3, so the OCR route
/// needs more room than the 8MB image cap. Twin of `OCR_BODY_LIMIT_BYTES`.
pub const OCR_BODY_LIMIT: usize = 12 * 1024 * 1024;
/// Pending and committed files together. Twin of `MAX_ATTACHED_FILES`.
pub const MAX_ATTACHED_FILES: usize = 10;
pub const ADDIN_ID: &str = "61e1060d-9903-425b-b6e8-8349101653ea";
