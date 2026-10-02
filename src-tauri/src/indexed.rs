use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::Mutex;

const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_PDF_BYTES: u64 = 20 * 1024 * 1024;

static ALLOWED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn lock() -> std::sync::MutexGuard<'static, Option<HashSet<String>>> {
    ALLOWED.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Remember paths this process returned from an index search.
pub fn note_hits<I, S>(paths: I)
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut guard = lock();
    let set = guard.get_or_insert_with(HashSet::new);
    for path in paths {
        let trimmed = path.as_ref().trim();
        if !trimmed.is_empty() {
            set.insert(trimmed.to_string());
        }
    }
}

pub fn allowed(path: &str) -> bool {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return false;
    }
    lock().as_ref().is_some_and(|set| set.contains(trimmed))
}

#[cfg(test)]
pub fn clear() {
    lock().take();
}

fn extension(name: &str) -> &str {
    match name.rsplit_once('.') {
        Some((_, ext)) if !ext.is_empty() && !name.ends_with('.') => ext,
        _ => "",
    }
}

fn reject_reason(name: &str, size: u64) -> Option<String> {
    let ext = extension(name).to_ascii_lowercase();
    let image = matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "jpe" | "gif" | "webp");
    let known = matches!(
        ext.as_str(),
        "pdf" | "docx" | "xlsx" | "txt" | "md" | "markdown" | "json" | "html" | "htm"
    ) || image;
    if !known {
        let message = match ext.as_str() {
            "doc" => "古い .doc は読めません。.docx で保存し直してください。",
            "xls" => "古い .xls は読めません。.xlsx で保存し直してください。",
            "jtd" => "一太郎の .jtd は読めません。PDF か .docx にしてください。",
            "pptx" | "ppt" => "PowerPoint は読めません。PDF にしてください。",
            _ => "この形式は読めません。PDF・Word・Excel・テキスト・画像のいずれかにしてください。",
        };
        return Some(message.to_string());
    }
    if size == 0 {
        return Some("中身が空です。".to_string());
    }
    let limit = if image { MAX_IMAGE_BYTES } else { MAX_PDF_BYTES };
    if size > limit {
        let mib = limit / (1024 * 1024);
        return Some(format!("{mib}MB を超えるので読めません。"));
    }
    None
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut index = 0;
    while index + 3 <= bytes.len() {
        let chunk = ((bytes[index] as u32) << 16)
            | ((bytes[index + 1] as u32) << 8)
            | (bytes[index + 2] as u32);
        out.push(TABLE[((chunk >> 18) & 63) as usize] as char);
        out.push(TABLE[((chunk >> 12) & 63) as usize] as char);
        out.push(TABLE[((chunk >> 6) & 63) as usize] as char);
        out.push(TABLE[(chunk & 63) as usize] as char);
        index += 3;
    }
    let rest = bytes.len() - index;
    if rest == 1 {
        let chunk = (bytes[index] as u32) << 16;
        out.push(TABLE[((chunk >> 18) & 63) as usize] as char);
        out.push(TABLE[((chunk >> 12) & 63) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rest == 2 {
        let chunk = ((bytes[index] as u32) << 16) | ((bytes[index + 1] as u32) << 8);
        out.push(TABLE[((chunk >> 18) & 63) as usize] as char);
        out.push(TABLE[((chunk >> 12) & 63) as usize] as char);
        out.push(TABLE[((chunk >> 6) & 63) as usize] as char);
        out.push('=');
    }
    out
}

pub enum ReadError {
    Forbidden,
    BadRequest(String),
    NotFound,
    Failed,
}

/// Bytes of a path this process has already returned from search.
pub fn read_file(path: &str) -> Result<(String, String), ReadError> {
    let file_path = path.trim();
    if !allowed(file_path) {
        return Err(ReadError::Forbidden);
    }
    let meta = match fs::metadata(file_path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(ReadError::NotFound),
        Err(_) => return Err(ReadError::Failed),
    };
    let name = Path::new(file_path)
        .file_name()
        .and_then(|part| part.to_str())
        .unwrap_or("")
        .to_string();
    if let Some(reason) = reject_reason(&name, meta.len()) {
        return Err(ReadError::BadRequest(reason));
    }
    if !meta.is_file() {
        return Err(ReadError::BadRequest(
            "この形式は読めません。PDF・Word・Excel・テキスト・画像のいずれかにしてください。".into(),
        ));
    }
    match fs::read(file_path) {
        Ok(bytes) => Ok((name, encode_base64(&bytes))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(ReadError::NotFound),
        Err(_) => Err(ReadError::Failed),
    }
}
