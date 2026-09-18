use crate::constants::MAX_ATTACHED_FILES;
use crate::json::{normalize_tool_calls, Usage};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

pub const UNTITLED_CONVERSATION: &str = "新しい会話";
const TITLE_CHARS: usize = 40;

/// Versioned so later phases (attachments) can add tables without rewriting an
/// existing database. Twin of `MIGRATIONS` in `src/sidecar/history.ts`.
const MIGRATIONS: &[&str] = &[
    r#"
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  document_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  reasoning_content TEXT NOT NULL DEFAULT '',
  tool_calls_json TEXT NOT NULL DEFAULT '',
  tool_call_id TEXT NOT NULL DEFAULT '',
  usage_json TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX messages_by_conversation ON messages(conversation_id, id);
CREATE INDEX conversations_by_document ON conversations(document_key, updated_at DESC);
"#,
    r#"ALTER TABLE conversations ADD COLUMN argos_path_prefix TEXT NOT NULL DEFAULT '';"#,
    r#"ALTER TABLE conversations ADD COLUMN document_path TEXT NOT NULL DEFAULT '';"#,
    // Attached files are read once and kept here, not copied into every message.
    r#"ALTER TABLE conversations ADD COLUMN file_sources TEXT NOT NULL DEFAULT '';"#,
];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub document_key: String,
    pub document_path: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: i64,
    #[serde(rename = "argosPathPrefix")]
    pub argos_path_prefix: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub id: i64,
    pub role: String,
    pub content: String,
    pub reasoning_content: String,
    pub tool_calls: Vec<Value>,
    pub tool_call_id: String,
    pub usage: Option<Usage>,
    pub created_at: String,
}

/// The files ride on the detail rather than the summary: the summary columns
/// also serve the history dialog, which lists every conversation.
#[derive(Debug, Clone, Serialize)]
pub struct ConversationDetail {
    pub conversation: ConversationSummary,
    pub messages: Vec<StoredMessage>,
    pub files: Vec<Value>,
}

#[derive(Debug, Default, Deserialize)]
pub struct NewMessage {
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(default, rename = "reasoningContent")]
    pub reasoning_content: String,
    #[serde(default, rename = "toolCalls")]
    pub tool_calls: Vec<Value>,
    #[serde(default, rename = "toolCallId")]
    pub tool_call_id: String,
    #[serde(default)]
    pub usage: Option<Value>,
}

pub fn history_file_path() -> Option<PathBuf> {
    dirs::data_dir().map(|dir| dir.join("GURI").join("history.db"))
}

fn now_stamp() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| String::new())
}

fn new_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let millis = OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    let seq = COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("c_{millis:x}_{seq:x}")
}

/// System prompts are rebuilt on every turn, so only these roles are stored.
fn normalize_role(role: &str) -> &'static str {
    match role {
        "assistant" => "assistant",
        "tool" => "tool",
        _ => "user",
    }
}

pub fn conversation_title(text: &str) -> String {
    let Some(line) = text.lines().find(|line| !line.trim().is_empty()) else {
        return UNTITLED_CONVERSATION.to_string();
    };
    let trimmed = line.trim();
    if trimmed.chars().count() > TITLE_CHARS {
        let short: String = trimmed.chars().take(TITLE_CHARS).collect();
        format!("{short}…")
    } else {
        trimmed.to_string()
    }
}

pub fn migrate(db: &Connection) -> rusqlite::Result<()> {
    db.pragma_update(None, "journal_mode", "WAL")?;
    db.pragma_update(None, "foreign_keys", "ON")?;
    let current: i64 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    for (index, migration) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        db.execute_batch(migration)?;
        db.pragma_update(None, "user_version", (index + 1) as i64)?;
    }
    Ok(())
}

pub fn open(path: Option<&PathBuf>) -> rusqlite::Result<Connection> {
    let db = match path {
        Some(path) => {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            Connection::open(path)?
        }
        None => Connection::open_in_memory()?,
    };
    migrate(&db)?;
    Ok(db)
}

static DB: OnceLock<Mutex<Connection>> = OnceLock::new();

fn connection() -> Option<&'static Mutex<Connection>> {
    if DB.get().is_none() {
        let db = open(history_file_path().as_ref()).ok()?;
        let _ = DB.set(Mutex::new(db));
    }
    DB.get()
}

pub fn with_db<T>(action: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> rusqlite::Result<T> {
    let Some(lock) = connection() else {
        return Err(rusqlite::Error::InvalidPath(PathBuf::from("history.db")));
    };
    let db = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    action(&db)
}

const SUMMARY_COLUMNS: &str = "c.id, c.title, c.document_key, c.document_path, c.created_at, \
    c.updated_at, c.argos_path_prefix, \
    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id)";

fn read_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConversationSummary> {
    Ok(ConversationSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        document_key: row.get(2)?,
        document_path: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        argos_path_prefix: row.get(6)?,
        message_count: row.get(7)?,
    })
}

fn read_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredMessage> {
    let tool_calls_json: String = row.get(4)?;
    let usage_json: String = row.get(6)?;
    let parsed_calls = serde_json::from_str::<Value>(&tool_calls_json).unwrap_or(Value::Null);
    Ok(StoredMessage {
        id: row.get(0)?,
        role: row.get(1)?,
        content: row.get(2)?,
        reasoning_content: row.get(3)?,
        tool_calls: normalize_tool_calls(Some(&parsed_calls)),
        tool_call_id: row.get(5)?,
        usage: serde_json::from_str::<Usage>(&usage_json).ok(),
        created_at: row.get(7)?,
    })
}

pub fn list_conversations(
    db: &Connection,
    document_key: Option<&str>,
) -> rusqlite::Result<Vec<ConversationSummary>> {
    let rows = match document_key {
        Some(key) if !key.is_empty() => {
            let sql = format!(
                "SELECT {SUMMARY_COLUMNS} FROM conversations c WHERE c.document_key = ?1 ORDER BY c.updated_at DESC"
            );
            let mut stmt = db.prepare(&sql)?;
            let rows = stmt.query_map(params![key], |row| read_summary(row))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        }
        _ => {
            let sql =
                format!("SELECT {SUMMARY_COLUMNS} FROM conversations c ORDER BY c.updated_at DESC");
            let mut stmt = db.prepare(&sql)?;
            let rows = stmt.query_map([], |row| read_summary(row))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        }
    };
    Ok(rows)
}

fn find_conversation(db: &Connection, id: &str) -> rusqlite::Result<Option<ConversationSummary>> {
    let sql = format!("SELECT {SUMMARY_COLUMNS} FROM conversations c WHERE c.id = ?1");
    db.query_row(&sql, params![id], |row| read_summary(row))
        .optional()
}

pub fn get_conversation(db: &Connection, id: &str) -> rusqlite::Result<Option<ConversationDetail>> {
    let Some(conversation) = find_conversation(db, id)? else {
        return Ok(None);
    };
    let mut stmt = db.prepare(
        "SELECT id, role, content, reasoning_content, tool_calls_json, tool_call_id, usage_json, created_at
         FROM messages WHERE conversation_id = ?1 ORDER BY id",
    )?;
    let messages = stmt
        .query_map(params![id], |row| read_message(row))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(ConversationDetail {
        conversation,
        messages,
        files: read_files(db, id)?,
    }))
}

/// Kept out of `SUMMARY_COLUMNS` on purpose: that list also serves the history
/// dialog, which would then carry every conversation's file text.
fn read_files(db: &Connection, id: &str) -> rusqlite::Result<Vec<Value>> {
    let raw: Option<String> = db
        .query_row(
            "SELECT file_sources FROM conversations WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(keep_files(
        &serde_json::from_str::<Value>(raw.unwrap_or_default().as_str()).unwrap_or(Value::Null),
    ))
}

/// A stored row is outside input: a file with no id or name would reach the
/// prompt as a half-shaped object, so it is dropped here.
fn keep_files(value: &Value) -> Vec<Value> {
    let Some(rows) = value.as_array() else {
        return Vec::new();
    };
    rows.iter()
        .filter(|row| {
            let named = |key: &str| {
                row.get(key)
                    .and_then(Value::as_str)
                    .is_some_and(|text| !text.is_empty())
            };
            row.is_object() && named("id") && named("name")
        })
        .take(MAX_ATTACHED_FILES)
        .cloned()
        .collect()
}

/// The whole set, every time: adding what a turn attached and dropping what the
/// user took away are the same call, so a retry lands on the same state.
pub fn set_files(
    db: &Connection,
    id: &str,
    files: &[Value],
) -> rusqlite::Result<Option<Vec<Value>>> {
    if find_conversation(db, id)?.is_none() {
        return Ok(None);
    }
    let kept = keep_files(&Value::Array(files.to_vec()));
    let stored = if kept.is_empty() {
        String::new()
    } else {
        serde_json::to_string(&kept).unwrap_or_default()
    };
    db.execute(
        "UPDATE conversations SET file_sources = ?1, updated_at = ?2 WHERE id = ?3",
        params![stored, now_stamp(), id],
    )?;
    read_files(db, id).map(Some)
}

pub fn create_conversation(
    db: &Connection,
    document_key: &str,
    title: &str,
    document_path: &str,
) -> rusqlite::Result<ConversationSummary> {
    let id = new_id();
    let now = now_stamp();
    let title = if title.trim().is_empty() {
        UNTITLED_CONVERSATION
    } else {
        title.trim()
    };
    db.execute(
        "INSERT INTO conversations (id, title, document_key, document_path, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, title, document_key, document_path, now, now],
    )?;
    Ok(find_conversation(db, &id)?.expect("just inserted"))
}

pub fn append_message(
    db: &Connection,
    conversation_id: &str,
    message: &NewMessage,
) -> rusqlite::Result<Option<StoredMessage>> {
    let Some(existing) = find_conversation(db, conversation_id)? else {
        return Ok(None);
    };
    let now = now_stamp();
    let role = normalize_role(&message.role);
    let tool_calls_json = if message.tool_calls.is_empty() {
        String::new()
    } else {
        serde_json::to_string(&message.tool_calls).unwrap_or_default()
    };
    let usage_json = match &message.usage {
        Some(usage) => serde_json::to_string(usage).unwrap_or_default(),
        None => String::new(),
    };

    db.execute(
        "INSERT INTO messages
           (conversation_id, role, content, reasoning_content, tool_calls_json, tool_call_id, usage_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            conversation_id,
            role,
            message.content,
            message.reasoning_content,
            tool_calls_json,
            message.tool_call_id,
            usage_json,
            now
        ],
    )?;
    let inserted = db.last_insert_rowid();

    let title = if existing.title == UNTITLED_CONVERSATION
        && role == "user"
        && !message.content.trim().is_empty()
    {
        conversation_title(&message.content)
    } else {
        existing.title
    };
    db.execute(
        "UPDATE conversations SET updated_at = ?1, title = ?2 WHERE id = ?3",
        params![now, title, conversation_id],
    )?;

    let stored = db.query_row(
        "SELECT id, role, content, reasoning_content, tool_calls_json, tool_call_id, usage_json, created_at
         FROM messages WHERE id = ?1",
        params![inserted],
        |row| read_message(row),
    )?;
    Ok(Some(stored))
}

pub fn delete_conversation(db: &Connection, id: &str) -> rusqlite::Result<bool> {
    let changed = db.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
    Ok(changed > 0)
}

pub fn set_argos_path_prefix(
    db: &Connection,
    id: &str,
    prefixes: &[String],
) -> rusqlite::Result<Option<ConversationSummary>> {
    let Some(_) = find_conversation(db, id)? else {
        return Ok(None);
    };
    let joined = join_argos_scopes(prefixes);
    let now = now_stamp();
    db.execute(
        "UPDATE conversations SET argos_path_prefix = ?1, updated_at = ?2 WHERE id = ?3",
        params![joined, now, id],
    )?;
    find_conversation(db, id)
}

pub fn set_document_path(
    db: &Connection,
    document_key: &str,
    document_path: &str,
) -> rusqlite::Result<usize> {
    if document_key.is_empty() {
        return Ok(0);
    }
    let changed = db.execute(
        "UPDATE conversations SET document_path = ?1 WHERE document_key = ?2",
        params![document_path, document_key],
    )?;
    Ok(changed)
}

fn normalize_argos_path(path: &str) -> String {
    path.replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

fn argos_path_starts_with(path: &str, prefix: &str) -> bool {
    let a = normalize_argos_path(path);
    let b = normalize_argos_path(prefix);
    if b.is_empty() {
        return true;
    }
    a == b || a.starts_with(&format!("{b}\\"))
}

fn join_argos_scopes(prefixes: &[String]) -> String {
    let mut out: Vec<String> = Vec::new();
    for raw in prefixes {
        let p = raw.trim();
        if p.is_empty() {
            continue;
        }
        if out.iter().any(|kept| argos_path_starts_with(p, kept)) {
            continue;
        }
        out.retain(|kept| !argos_path_starts_with(kept, p));
        out.push(p.to_string());
        if out.len() >= 8 {
            break;
        }
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn memory() -> Connection {
        open(None).expect("open in-memory history")
    }

    #[test]
    fn stores_a_turn_and_names_the_conversation() {
        let db = memory();
        let created = create_conversation(&db, "docA", "", "").expect("create");
        assert_eq!(created.title, UNTITLED_CONVERSATION);

        append_message(
            &db,
            &created.id,
            &NewMessage {
                role: "user".into(),
                content: "この条項を点検して".into(),
                ..Default::default()
            },
        )
        .expect("user message");

        append_message(
            &db,
            &created.id,
            &NewMessage {
                role: "assistant".into(),
                content: "コメントを 2 件付けました。".into(),
                reasoning_content: "内部の検討".into(),
                tool_calls: vec![json!({
                    "id": "c1",
                    "type": "function",
                    "function": { "name": "insert_comment", "arguments": "{}" }
                })],
                usage: Some(json!({
                    "promptTokens": 10,
                    "completionTokens": 4,
                    "totalTokens": 14,
                    "reasoningTokens": 2
                })),
                ..Default::default()
            },
        )
        .expect("assistant message");

        let detail = get_conversation(&db, &created.id)
            .expect("read")
            .expect("exists");
        assert_eq!(detail.conversation.title, "この条項を点検して");
        assert_eq!(detail.conversation.message_count, 2);
        assert_eq!(detail.messages.len(), 2);
        assert_eq!(detail.messages[1].tool_calls.len(), 1);
        assert_eq!(detail.messages[1].reasoning_content, "内部の検討");
        assert_eq!(detail.messages[1].usage.as_ref().unwrap().total_tokens, 14);
    }

    #[test]
    fn lists_by_document_and_deletes_with_messages() {
        let db = memory();
        let a = create_conversation(&db, "docA", "", "").expect("a");
        create_conversation(&db, "docB", "", "").expect("b");

        assert_eq!(list_conversations(&db, Some("docA")).unwrap().len(), 1);
        assert_eq!(list_conversations(&db, None).unwrap().len(), 2);

        append_message(
            &db,
            &a.id,
            &NewMessage {
                role: "user".into(),
                content: "本文".into(),
                ..Default::default()
            },
        )
        .expect("message");

        assert!(delete_conversation(&db, &a.id).unwrap());
        assert!(get_conversation(&db, &a.id).unwrap().is_none());
        let left: i64 = db
            .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn appending_to_a_missing_conversation_returns_none() {
        let db = memory();
        let stored = append_message(
            &db,
            "nope",
            &NewMessage {
                role: "user".into(),
                content: "x".into(),
                ..Default::default()
            },
        )
        .expect("query");
        assert!(stored.is_none());
    }

    #[test]
    fn migrating_twice_is_a_no_op() {
        let db = memory();
        migrate(&db).expect("second migrate");
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
    }

    #[test]
    fn stores_argos_path_prefix_on_the_conversation() {
        let db = memory();
        let created = create_conversation(&db, "docA", "", "").expect("create");
        assert_eq!(created.argos_path_prefix, "");
        let updated =
            set_argos_path_prefix(&db, &created.id, &["C:\\案件A".into(), "C:\\案件B".into()])
                .expect("set")
                .expect("exists");
        assert_eq!(updated.argos_path_prefix, "C:\\案件A\nC:\\案件B");
        let collapsed = set_argos_path_prefix(
            &db,
            &created.id,
            &["C:\\案件A".into(), "C:\\案件A\\子".into()],
        )
        .expect("set")
        .expect("exists");
        assert_eq!(collapsed.argos_path_prefix, "C:\\案件A");
    }

    #[test]
    fn keeps_attached_files_on_the_conversation() {
        let db = memory();
        let created = create_conversation(&db, "docA", "", "").expect("create");
        let detail = get_conversation(&db, &created.id)
            .expect("read")
            .expect("exists");
        assert!(detail.files.is_empty());

        let file = json!({
            "id": "f1",
            "name": "契約.docx",
            "origin": "text",
            "body": "第1条（目的）",
            "size": 1024,
            "mtime": 1_700_000_000_000i64
        });
        let stored = set_files(&db, &created.id, &[file.clone()])
            .expect("set")
            .expect("exists");
        assert_eq!(stored, vec![file.clone()]);

        // A second turn re-sends the same set, which must not double the text.
        let again = set_files(&db, &created.id, &[file.clone()])
            .expect("set")
            .expect("exists");
        assert_eq!(again.len(), 1);
        assert_eq!(
            get_conversation(&db, &created.id)
                .expect("read")
                .expect("exists")
                .files,
            vec![file]
        );
    }

    #[test]
    fn drops_a_stored_file_without_a_name_and_clears_the_set() {
        let db = memory();
        let created = create_conversation(&db, "docA", "", "").expect("create");
        let kept = set_files(
            &db,
            &created.id,
            &[
                json!({ "id": "f1", "body": "あ" }),
                json!({ "id": "f2", "name": "良.txt", "body": "い" }),
            ],
        )
        .expect("set")
        .expect("exists");
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0]["name"], json!("良.txt"));

        let cleared = set_files(&db, &created.id, &[]).expect("set").expect("exists");
        assert!(cleared.is_empty());
    }

    #[test]
    fn setting_files_on_a_missing_conversation_returns_none() {
        let db = memory();
        assert!(set_files(&db, "nope", &[]).expect("query").is_none());
    }

    #[test]
    fn stores_and_backfills_document_path() {
        let db = memory();
        let created =
            create_conversation(&db, "docA", "", "file:///C:/案件/契約.docx").expect("create");
        assert_eq!(created.document_path, "file:///C:/案件/契約.docx");
        create_conversation(&db, "docA", "", "").expect("second");
        let updated = set_document_path(&db, "docA", "C:\\案件\\契約_改.docx").expect("backfill");
        assert_eq!(updated, 2);
        let listed = list_conversations(&db, Some("docA")).unwrap();
        assert!(listed
            .iter()
            .all(|row| row.document_path == "C:\\案件\\契約_改.docx"));
    }
}
