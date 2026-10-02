use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

const FORBIDDEN: &[&str] = &[
    "body",
    "prompt",
    "content",
    "reasoning_content",
    "reasoningContent",
    "messages",
    "text",
    "q",
    "query",
    "replacement",
    "selection",
    "instruction",
    "apiKey",
    "llmApiKey",
    "argosApiKey",
    "authorization",
    "snippet",
    "previewText",
    "pathPrefixes",
    "path_prefix",
    "path_prefixes",
];

static LOG_FILE: OnceLock<PathBuf> = OnceLock::new();
static CAPTURE_ON: AtomicBool = AtomicBool::new(false);
static CAPTURE: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn forbidden() -> HashSet<&'static str> {
    FORBIDDEN.iter().copied().collect()
}

fn scrub(extra: &serde_json::Value) -> serde_json::Value {
    let Some(obj) = extra.as_object() else {
        return extra.clone();
    };
    let banned = forbidden();
    let mut out = serde_json::Map::new();
    for (key, value) in obj {
        if banned.contains(key.as_str()) {
            continue;
        }
        if let Some(text) = value.as_str() {
            if text.len() > 180 {
                let sliced: String = text.chars().take(80).collect();
                out.insert(key.clone(), serde_json::Value::String(format!("{sliced}…")));
                continue;
            }
        }
        out.insert(key.clone(), value.clone());
    }
    serde_json::Value::Object(out)
}

pub fn set_log_file(path: PathBuf) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = LOG_FILE.set(path);
}

pub fn init_default_log_file() {
    if let Some(dir) = dirs::data_dir() {
        set_log_file(dir.join("GURI").join("guri.log"));
    }
}

fn write_line(level: &str, message: &str, extra: Option<&serde_json::Value>) {
    let extra = extra.map(scrub);
    let line = match &extra {
        Some(extra) => format!("{} [GURI] {level} {message} {}\n", now_stamp(), extra),
        None => format!("{} [GURI] {level} {message}\n", now_stamp()),
    };

    if CAPTURE_ON.load(Ordering::SeqCst) {
        if let Ok(mut logs) = CAPTURE.lock() {
            logs.push(line.clone());
        }
    }

    match extra {
        Some(extra) => {
            if level == "error" {
                eprintln!("[GURI] {message} {extra}");
            } else {
                println!("[GURI] {message} {extra}");
            }
        }
        None => {
            if level == "error" {
                eprintln!("[GURI] {message}");
            } else {
                println!("[GURI] {message}");
            }
        }
    }

    if let Some(path) = LOG_FILE.get() {
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = file.write_all(line.as_bytes());
        }
    }
}

fn now_stamp() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "unknown-time".into())
}

pub fn info(message: &str, extra: Option<serde_json::Value>) {
    write_line("info", message, extra.as_ref());
}

pub fn error(message: &str, extra: Option<serde_json::Value>) {
    write_line("error", message, extra.as_ref());
}

pub fn info_status(message: &str, status: impl serde::Serialize) {
    info(message, Some(serde_json::json!({ "status": status })));
}

pub fn error_name(message: &str, name: &str) {
    error(message, Some(serde_json::json!({ "name": name })));
}

#[cfg(test)]
pub fn capture_start() {
    if let Ok(mut logs) = CAPTURE.lock() {
        logs.clear();
    }
    CAPTURE_ON.store(true, Ordering::SeqCst);
}

#[cfg(test)]
pub fn capture_stop() -> Vec<String> {
    CAPTURE_ON.store(false, Ordering::SeqCst);
    CAPTURE
        .lock()
        .map(|mut logs| logs.drain(..).collect())
        .unwrap_or_default()
}
