use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const STALE_TEMP: Duration = Duration::from_secs(60);
const UNREADABLE: &str = "connection.json を読めません";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Connection {
    pub llm_base_url: String,
    pub llm_api_key: String,
    pub searxng_url: String,
}

impl Connection {
    pub fn is_empty(&self) -> bool {
        self.llm_base_url.is_empty() && self.llm_api_key.is_empty() && self.searxng_url.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionFile {
    Ready(Connection),
    Absent,
    Broken,
}

pub fn connection_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("LexCrew")
        .join("connection.json")
}

pub fn read_connection(file: &Path, log: &mut dyn FnMut(&str)) -> ConnectionFile {
    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return ConnectionFile::Absent,
        Err(_) => {
            log(UNREADABLE);
            return ConnectionFile::Broken;
        }
    };
    parse_connection_text(&text, log)
}

pub fn parse_connection_text(text: &str, log: &mut dyn FnMut(&str)) -> ConnectionFile {
    let source = text.strip_prefix('\u{feff}').unwrap_or(text);
    let parsed: Value = match serde_json::from_str(source) {
        Ok(value) => value,
        Err(_) => {
            log(UNREADABLE);
            return ConnectionFile::Broken;
        }
    };
    let Some(object) = parsed.as_object() else {
        log(UNREADABLE);
        return ConnectionFile::Broken;
    };
    ConnectionFile::Ready(Connection {
        llm_base_url: string_field(object.get("llmBaseUrl")),
        llm_api_key: string_field(object.get("llmApiKey")),
        searxng_url: string_field(object.get("searxngUrl")),
    })
}

pub fn resolve_connection(file: &ConnectionFile, body: &Connection) -> Connection {
    match file {
        ConnectionFile::Ready(connection) => connection.clone(),
        ConnectionFile::Absent | ConnectionFile::Broken => body.clone(),
    }
}

pub fn connection_from_value(value: &Value) -> Connection {
    let object = value.as_object();
    Connection {
        llm_base_url: string_field(object.and_then(|map| map.get("llmBaseUrl"))),
        llm_api_key: string_field(object.and_then(|map| map.get("llmApiKey"))),
        searxng_url: string_field(object.and_then(|map| map.get("searxngUrl"))),
    }
}

/// Startup must not replace a file LexCrew Mail already published.
pub fn adopt_connection(file: &Path, incoming: &Connection, log: &mut dyn FnMut(&str)) -> Result<ConnectionFile, String> {
    let current = read_connection(file, log);
    if !matches!(current, ConnectionFile::Absent) || incoming.is_empty() {
        return Ok(current);
    }
    publish_new(file, incoming)?;
    Ok(read_connection(file, log))
}

pub fn save_connection(file: &Path, incoming: &Connection) -> Result<(), String> {
    if incoming.is_empty() && matches!(read_connection(file, &mut |_| {}), ConnectionFile::Absent) {
        return Ok(());
    }
    let dir = file.parent().ok_or_else(|| "接続ファイルを保存できません。".to_string())?;
    fs::create_dir_all(dir).map_err(|_| "接続ファイルを保存できません。".to_string())?;
    sweep_connection_temps(dir, SystemTime::now());
    let tmp = temp_path(dir);
    let publish = (|| {
        write_complete(&tmp, incoming)?;
        replace_file(&tmp, file)
    })();
    let _ = fs::remove_file(&tmp);
    publish
}

pub fn sweep_connection_temps(dir: &Path, now: SystemTime) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with("connection.json.") || !name.ends_with(".tmp") {
            continue;
        }
        let modified = match entry.metadata().and_then(|meta| meta.modified()) {
            Ok(modified) => modified,
            Err(_) => continue,
        };
        if now.duration_since(modified).unwrap_or_default() < STALE_TEMP {
            continue;
        }
        let _ = fs::remove_file(entry.path());
    }
}

pub fn connection_payload(file: &ConnectionFile) -> Value {
    match file {
        ConnectionFile::Ready(connection) => json!({
            "kind": "ready",
            "llmBaseUrl": connection.llm_base_url,
            "llmApiKey": connection.llm_api_key,
            "searxngUrl": connection.searxng_url,
        }),
        ConnectionFile::Absent => json!({ "kind": "absent" }),
        ConnectionFile::Broken => json!({ "kind": "broken" }),
    }
}

fn publish_new(file: &Path, incoming: &Connection) -> Result<(), String> {
    let dir = file.parent().ok_or_else(|| "接続ファイルを作成できません。".to_string())?;
    fs::create_dir_all(dir).map_err(|_| "接続ファイルを作成できません。".to_string())?;
    sweep_connection_temps(dir, SystemTime::now());
    let tmp = temp_path(dir);
    let publish = (|| {
        write_complete(&tmp, incoming)?;
        match fs::hard_link(&tmp, file) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(_) => Err("接続ファイルを作成できません。".to_string()),
        }
    })();
    let _ = fs::remove_file(&tmp);
    publish
}

fn write_complete(tmp: &Path, incoming: &Connection) -> Result<(), String> {
    let mut handle = File::create(tmp).map_err(|_| "接続ファイルを保存できません。".to_string())?;
    handle
        .write_all(&encode(incoming))
        .map_err(|_| "接続ファイルを保存できません。".to_string())?;
    handle
        .sync_all()
        .map_err(|_| "接続ファイルを保存できません。".to_string())?;
    Ok(())
}

fn encode(incoming: &Connection) -> Vec<u8> {
    format!(
        "{{\n  \"llmBaseUrl\": {},\n  \"llmApiKey\": {},\n  \"searxngUrl\": {}\n}}\n",
        serde_json::to_string(&incoming.llm_base_url).unwrap_or_else(|_| "\"\"".into()),
        serde_json::to_string(&incoming.llm_api_key).unwrap_or_else(|_| "\"\"".into()),
        serde_json::to_string(&incoming.searxng_url).unwrap_or_else(|_| "\"\"".into()),
    )
    .into_bytes()
}

fn temp_path(dir: &Path) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    dir.join(format!(
        "connection.json.{}.{nanos:x}{n:x}.tmp",
        std::process::id()
    ))
}

fn string_field(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        _ => String::new(),
    }
}

fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        replace_file_windows(from, to)
    }
    #[cfg(not(windows))]
    {
        fs::rename(from, to).map_err(|_| "接続ファイルを保存できません。".to_string())
    }
}

#[cfg(windows)]
fn replace_file_windows(from: &Path, to: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    let from_wide: Vec<u16> = from.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let to_wide: Vec<u16> = to.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let ok = unsafe {
        MoveFileExW(
            from_wide.as_ptr(),
            to_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err("接続ファイルを保存できません。".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "super-secret-key";

    fn root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("guri-conn-{nanos}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn file_in(dir: &Path) -> PathBuf {
        dir.join("connection.json")
    }

    #[test]
    fn connection_path_uses_lexcrew_under_the_data_dir() {
        let path = connection_path();
        assert!(path.ends_with(Path::new("LexCrew").join("connection.json")));
    }

    #[test]
    fn read_fills_a_missing_key_and_ignores_anything_else() {
        let dir = root();
        let file = file_in(&dir);
        fs::write(
            &file,
            serde_json::json!({ "llmBaseUrl": "http://llm", "extra": SECRET, "llmApiKey": 12 }).to_string(),
        )
        .unwrap();
        assert_eq!(
            read_connection(&file, &mut |_| {}),
            ConnectionFile::Ready(Connection {
                llm_base_url: "http://llm".into(),
                llm_api_key: String::new(),
                searxng_url: String::new(),
            })
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn empty_object_is_ready_and_empty() {
        let dir = root();
        let file = file_in(&dir);
        fs::write(&file, "{}").unwrap();
        assert_eq!(
            read_connection(&file, &mut |_| {}),
            ConnectionFile::Ready(Connection {
                llm_base_url: String::new(),
                llm_api_key: String::new(),
                searxng_url: String::new(),
            })
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn leading_bom_still_reads_the_object() {
        let dir = root();
        let file = file_in(&dir);
        fs::write(&file, "\u{feff}{\"searxngUrl\":\"http://searx\"}").unwrap();
        match read_connection(&file, &mut |_| {}) {
            ConnectionFile::Ready(connection) => {
                assert_eq!(connection.llm_base_url, "");
                assert_eq!(connection.searxng_url, "http://searx");
            }
            other => panic!("expected ready, got {other:?}"),
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn broken_file_does_not_log_the_key() {
        let dir = root();
        let file = file_in(&dir);
        fs::write(&file, format!("{{\"llmApiKey\":\"{SECRET}\"")).unwrap();
        let mut lines = Vec::new();
        assert_eq!(
            read_connection(&file, &mut |line| lines.push(line.to_string())),
            ConnectionFile::Broken
        );
        assert!(!lines.join("\n").contains(SECRET));
        assert!(matches!(parse_connection_text("[]", &mut |_| {}), ConnectionFile::Broken));
        assert!(matches!(parse_connection_text("", &mut |_| {}), ConnectionFile::Broken));
        assert!(matches!(parse_connection_text("null", &mut |_| {}), ConnectionFile::Broken));
        assert!(matches!(parse_connection_text("12", &mut |_| {}), ConnectionFile::Broken));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_directory_is_broken_and_does_not_panic() {
        let dir = root();
        let file = file_in(&dir);
        fs::create_dir(&file).unwrap();
        assert_eq!(read_connection(&file, &mut |_| {}), ConnectionFile::Broken);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_file_is_absent() {
        let dir = root();
        assert_eq!(read_connection(&file_in(&dir), &mut |_| {}), ConnectionFile::Absent);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn adopt_does_not_create_when_every_value_is_empty() {
        let dir = root();
        let file = file_in(&dir);
        let empty = Connection {
            llm_base_url: String::new(),
            llm_api_key: String::new(),
            searxng_url: String::new(),
        };
        assert_eq!(adopt_connection(&file, &empty, &mut |_| {}).unwrap(), ConnectionFile::Absent);
        assert!(!file.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn adopt_does_not_replace_an_existing_file() {
        let dir = root();
        let file = file_in(&dir);
        fs::write(
            &file,
            r#"{"llmBaseUrl":"http://doc","llmApiKey":"doc-key","searxngUrl":"http://searx"}"#,
        )
        .unwrap();
        let before = fs::read(&file).unwrap();
        let incoming = Connection {
            llm_base_url: "http://mail".into(),
            llm_api_key: SECRET.into(),
            searxng_url: String::new(),
        };
        let result = adopt_connection(&file, &incoming, &mut |_| {}).unwrap();
        assert_eq!(
            result,
            ConnectionFile::Ready(Connection {
                llm_base_url: "http://doc".into(),
                llm_api_key: "doc-key".into(),
                searxng_url: "http://searx".into(),
            })
        );
        assert_eq!(fs::read(&file).unwrap(), before);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn adopt_does_not_refill_an_empty_object() {
        let dir = root();
        let file = file_in(&dir);
        fs::write(&file, "{}").unwrap();
        let incoming = Connection {
            llm_base_url: "http://mail".into(),
            llm_api_key: SECRET.into(),
            searxng_url: "http://searx".into(),
        };
        let result = adopt_connection(&file, &incoming, &mut |_| {}).unwrap();
        assert_eq!(
            result,
            ConnectionFile::Ready(Connection {
                llm_base_url: String::new(),
                llm_api_key: String::new(),
                searxng_url: String::new(),
            })
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "{}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn adopt_publishes_three_keys_without_a_bom() {
        let dir = root();
        let file = file_in(&dir);
        let incoming = Connection {
            llm_base_url: "http://llm".into(),
            llm_api_key: SECRET.into(),
            searxng_url: "http://searx".into(),
        };
        assert_eq!(
            adopt_connection(&file, &incoming, &mut |_| {}).unwrap(),
            ConnectionFile::Ready(incoming.clone())
        );
        let bytes = fs::read(&file).unwrap();
        assert_ne!(bytes.first().copied(), Some(0xef));
        let text = String::from_utf8(bytes).unwrap();
        assert_ne!(text.chars().next(), Some('\u{feff}'));
        let base = text.find("\"llmBaseUrl\"").unwrap();
        let key = text.find("\"llmApiKey\"").unwrap();
        let searx = text.find("\"searxngUrl\"").unwrap();
        assert!(base < key && key < searx);
        adopt_connection(
            &file,
            &Connection {
                llm_base_url: "http://other".into(),
                llm_api_key: "other".into(),
                searxng_url: String::new(),
            },
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(
            read_connection(&file, &mut |_| {}),
            ConnectionFile::Ready(incoming)
        );
        let leftover = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"));
        assert!(!leftover);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn save_replaces_the_file_without_a_bom() {
        let dir = root();
        let file = file_in(&dir);
        fs::write(&file, format!(r#"{{"llmBaseUrl":"old","extra":"{SECRET}"}}"#)).unwrap();
        save_connection(
            &file,
            &Connection {
                llm_base_url: "http://llm".into(),
                llm_api_key: SECRET.into(),
                searxng_url: String::new(),
            },
        )
        .unwrap();
        let bytes = fs::read(&file).unwrap();
        assert_ne!(bytes.first().copied(), Some(0xef));
        let text = String::from_utf8(bytes.clone()).unwrap();
        let base = text.find("\"llmBaseUrl\"").unwrap();
        let key = text.find("\"llmApiKey\"").unwrap();
        let searx = text.find("\"searxngUrl\"").unwrap();
        assert!(base < key && key < searx);
        let parsed: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["llmApiKey"], SECRET);
        let leftover = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"));
        assert!(!leftover);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn save_does_not_create_when_every_value_is_empty() {
        let dir = root();
        let file = file_in(&dir);
        save_connection(
            &file,
            &Connection {
                llm_base_url: String::new(),
                llm_api_key: String::new(),
                searxng_url: String::new(),
            },
        )
        .unwrap();
        assert!(!file.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn save_replaces_a_broken_file() {
        let dir = root();
        let file = file_in(&dir);
        fs::write(&file, "{").unwrap();
        save_connection(
            &file,
            &Connection {
                llm_base_url: "http://llm".into(),
                llm_api_key: SECRET.into(),
                searxng_url: String::new(),
            },
        )
        .unwrap();
        assert_eq!(
            read_connection(&file, &mut |_| {}),
            ConnectionFile::Ready(Connection {
                llm_base_url: "http://llm".into(),
                llm_api_key: SECRET.into(),
                searxng_url: String::new(),
            })
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn sweep_removes_a_stale_temp_without_logging_it() {
        let dir = root();
        let stale = dir.join("connection.json.old.dead.tmp");
        let fresh = dir.join("connection.json.now.live.tmp");
        fs::write(&stale, SECRET).unwrap();
        fs::write(&fresh, SECRET).unwrap();
        let old = SystemTime::now() - Duration::from_secs(120);
        let file = File::options().write(true).open(&stale).unwrap();
        file.set_modified(old).unwrap();
        sweep_connection_temps(&dir, SystemTime::now());
        assert!(!stale.exists());
        assert!(fresh.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn resolve_prefers_a_ready_file() {
        let file = ConnectionFile::Ready(Connection {
            llm_base_url: "http://file".into(),
            llm_api_key: "file-key".into(),
            searxng_url: "http://file-searx".into(),
        });
        let body = Connection {
            llm_base_url: "http://body".into(),
            llm_api_key: "body-key".into(),
            searxng_url: "http://body-searx".into(),
        };
        assert_eq!(
            resolve_connection(&file, &body),
            Connection {
                llm_base_url: "http://file".into(),
                llm_api_key: "file-key".into(),
                searxng_url: "http://file-searx".into(),
            }
        );
        assert_eq!(
            resolve_connection(&ConnectionFile::Absent, &body).llm_base_url,
            "http://body"
        );
        assert_eq!(
            resolve_connection(&ConnectionFile::Broken, &body).searxng_url,
            "http://body-searx"
        );
    }

    #[test]
    fn whitespace_is_not_empty() {
        assert!(!Connection {
            llm_base_url: " ".into(),
            llm_api_key: String::new(),
            searxng_url: String::new(),
        }
        .is_empty());
    }

}
