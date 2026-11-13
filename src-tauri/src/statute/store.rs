//! Statute SQLite in the app data directory. Not a user-facing folder.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};

use crate::statute::refresh::parse_ymd;
use crate::statute::xmlparse::{article_spans, ListedUpdate, ParsedArticle};

/// Packed on 2026-11-11. Rebuild with `python3 scripts/fetch_statutes.py`.
/// A missing article is 要確認 while offline, even for a bundled law.
pub const BUNDLE_VERSION: &str = "2026-11-11b";
const BUNDLE_VERSION_KEY: &str = "bundle_version";

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS law (
  law_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  law_num TEXT NOT NULL DEFAULT '',
  as_of TEXT NOT NULL DEFAULT '',
  checked_on TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'bundle'
);
CREATE TABLE IF NOT EXISTS law_alias (
  alias TEXT PRIMARY KEY,
  law_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS law_name (
  law_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  law_num TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS article (
  law_id TEXT NOT NULL,
  article_key TEXT NOT NULL,
  article_num TEXT NOT NULL,
  heading TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  as_of TEXT NOT NULL DEFAULT '',
  probed_on TEXT NOT NULL DEFAULT '',
  suppl INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (law_id, article_key)
);
CREATE TABLE IF NOT EXISTS law_update (
  law_id TEXT PRIMARY KEY,
  as_of TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS update_day (
  day TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS pending_revision (
  law_id TEXT PRIMARY KEY,
  enforce_on TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_law_alias_id ON law_alias(law_id);
CREATE INDEX IF NOT EXISTS idx_law_name_name ON law_name(name);
";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArticleRow {
    pub law_id: String,
    pub key: String,
    pub num: String,
    pub heading: String,
    pub body: String,
    pub as_of: String,
    pub probed_on: String,
    pub suppl: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LawRef {
    pub law_id: String,
    pub name: String,
    pub law_num: String,
    pub as_of: String,
    pub checked_on: String,
    pub article_count: usize,
    /// `bundle` means the seed shipped the whole law. A missing row is still
    /// 要確認 until e-Gov is asked, because the seed can be older than the statute.
    pub source: String,
}

struct AliasHit {
    alias: String,
    law_id: String,
    name: String,
}

#[derive(Default)]
pub struct IndexDirty {
    pub laws: Vec<String>,
    pub removed: Vec<(String, String)>,
}

pub struct StatuteDb {
    conn: Mutex<Connection>,
    aliases: Mutex<Option<Vec<AliasHit>>>,
    law_cache: Mutex<HashMap<String, LawRef>>,
    dirty: Mutex<IndexDirty>,
}

#[allow(dead_code)]
impl StatuteDb {
    pub fn open(path: &Path) -> Result<Self, String> {
        let db = Self::open_empty(path)?;
        db.import_seed()?;
        Ok(db)
    }

    pub fn open_empty(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
            aliases: Mutex::new(None),
            law_cache: Mutex::new(HashMap::new()),
            dirty: Mutex::new(IndexDirty::default()),
        })
    }

    pub fn open_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
            aliases: Mutex::new(None),
            law_cache: Mutex::new(HashMap::new()),
            dirty: Mutex::new(IndexDirty::default()),
        })
    }

    pub fn import_seed(&self) -> Result<(), String> {
        let conn = self.conn.lock();
        let current = meta_locked(&conn, BUNDLE_VERSION_KEY)?.unwrap_or_default();
        if current == BUNDLE_VERSION {
            return Ok(());
        }
        let temp = seed_temp_path();
        let decoded = (|| -> Result<(), String> {
            let mut file = File::create(&temp).map_err(|e| e.to_string())?;
            let mut decoder = flate2::read::GzDecoder::new(SEED);
            std::io::copy(&mut decoder, &mut file).map_err(|e| e.to_string())?;
            file.flush().map_err(|e| e.to_string())?;
            Ok(())
        })();
        if let Err(err) = decoded {
            let _ = std::fs::remove_file(&temp);
            return Err(err);
        }
        let import = import_attached(&conn, &temp);
        let _ = std::fs::remove_file(&temp);
        import?;
        set_meta_locked(&conn, BUNDLE_VERSION_KEY, BUNDLE_VERSION)?;
        drop(conn);
        self.invalidate_aliases();
        Ok(())
    }

    /// Attach `path` and copy seed tables. Rolls the transaction back and detaches on failure.
    pub fn import_attached_db(&self, path: &Path) -> Result<(), String> {
        let conn = self.conn.lock();
        import_attached(&conn, path)
    }

    pub fn meta(&self, key: &str) -> Result<String, String> {
        let conn = self.conn.lock();
        Ok(meta_locked(&conn, key)?.unwrap_or_default())
    }

    pub fn note_probe_failure(&self, law_id: &str, key: &str, note: &str) -> Result<(), String> {
        self.set_meta(
            &format!("probe_fail:{law_id}:{key}"),
            &format!("{}\n{note}", chrono::Utc::now().timestamp()),
        )
    }

    /// A failed currency probe. The next check inside an hour reuses the saved text.
    pub fn probe_failure_is_fresh(&self, law_id: &str, key: &str) -> bool {
        let raw = self
            .meta(&format!("probe_fail:{law_id}:{key}"))
            .unwrap_or_default();
        let Some(checked) = raw.lines().next() else {
            return false;
        };
        let Ok(checked) = checked.parse::<i64>() else {
            return false;
        };
        chrono::Utc::now().timestamp().saturating_sub(checked) < 60 * 60
    }

    pub fn probe_failure_note(&self, law_id: &str, key: &str) -> Option<String> {
        if !self.probe_failure_is_fresh(law_id, key) {
            return None;
        }
        let raw = self
            .meta(&format!("probe_fail:{law_id}:{key}"))
            .unwrap_or_default();
        let note = raw.split_once('\n').map(|(_, note)| note.to_string())?;
        if note.is_empty() { None } else { Some(note) }
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        set_meta_locked(&conn, key, value)
    }

    pub fn article_count(&self) -> Result<usize, String> {
        let conn = self.conn.lock();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM article", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        Ok(n.max(0) as usize)
    }

    pub fn bundled_law_count(&self) -> Result<usize, String> {
        let conn = self.conn.lock();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM law WHERE source = 'bundle'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(n.max(0) as usize)
    }

    pub fn index_token(&self) -> Result<String, String> {
        let version = self.meta(BUNDLE_VERSION_KEY)?;
        let count = self.article_count()?;
        let rev = self.meta("content_rev")?;
        Ok(format!("{version}:{count}:{rev}"))
    }

    pub fn take_index_dirty(&self) -> IndexDirty {
        std::mem::take(&mut *self.dirty.lock())
    }

    fn note_dirty(&self, law_id: &str, removed: Vec<(String, String)>) {
        let mut dirty = self.dirty.lock();
        if !dirty.laws.iter().any(|id| id == law_id) {
            dirty.laws.push(law_id.to_string());
        }
        dirty.removed.extend(removed);
    }

    pub fn upsert_names(&self, names: &[(String, String, String)]) -> Result<(), String> {
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO law_name (law_id, name, law_num) VALUES (?1, ?2, ?3)
                     ON CONFLICT(law_id) DO UPDATE SET name = excluded.name, law_num = excluded.law_num",
                )
                .map_err(|e| e.to_string())?;
            for (id, name, num) in names {
                if id.is_empty() || name.is_empty() {
                    continue;
                }
                stmt.execute(params![id, name, num])
                    .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        drop(conn);
        self.invalidate_aliases();
        Ok(())
    }

    pub fn replace_law(
        &self,
        law_id: &str,
        name: &str,
        law_num: &str,
        as_of: &str,
        checked_on: &str,
        source: &str,
        aliases: &[String],
        articles: &[ParsedArticle],
    ) -> Result<(), String> {
        if articles.is_empty() {
            return Err("空の法令で既存の条文を置き換えません".into());
        }
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let old_keys = {
            let mut stmt = tx
                .prepare("SELECT article_key FROM article WHERE law_id = ?1")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([law_id], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            let mut keys = Vec::new();
            for row in rows {
                keys.push(row.map_err(|e| e.to_string())?);
            }
            keys
        };
        tx.execute("DELETE FROM article WHERE law_id = ?1", [law_id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM law_alias WHERE law_id = ?1", [law_id])
            .map_err(|e| e.to_string())?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO article (
                        law_id, article_key, article_num, heading, body, as_of, probed_on, suppl
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7)",
                )
                .map_err(|e| e.to_string())?;
            for article in articles {
                stmt.execute(params![
                    law_id,
                    article.key,
                    article.num,
                    article.heading,
                    article.body,
                    as_of,
                    article.suppl as i64
                ])
                .map_err(|e| e.to_string())?;
            }
        }
        tx.execute(
            "INSERT INTO law (law_id, name, law_num, as_of, checked_on, source)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(law_id) DO UPDATE SET
               name = excluded.name,
               law_num = excluded.law_num,
               as_of = excluded.as_of,
               checked_on = excluded.checked_on,
               source = excluded.source",
            params![law_id, name, law_num, as_of, checked_on, source],
        )
        .map_err(|e| e.to_string())?;
        insert_aliases(&tx, law_id, name, aliases)?;
        bump_rev_locked(&tx)?;
        tx.commit().map_err(|e| e.to_string())?;
        drop(conn);
        let new_keys: std::collections::HashSet<&str> =
            articles.iter().map(|article| article.key.as_str()).collect();
        let removed = old_keys
            .into_iter()
            .filter(|key| !new_keys.contains(key.as_str()))
            .map(|key| (law_id.to_string(), key))
            .collect();
        self.note_dirty(law_id, removed);
        self.invalidate_aliases();
        Ok(())
    }

    pub fn ensure_law(
        &self,
        law_id: &str,
        name: &str,
        law_num: &str,
        source: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO law (law_id, name, law_num, as_of, checked_on, source)
             VALUES (?1, ?2, ?3, '', '', ?4)
             ON CONFLICT(law_id) DO UPDATE SET
               name = CASE WHEN law.name = '' THEN excluded.name ELSE law.name END,
               law_num = CASE WHEN law.law_num = '' THEN excluded.law_num ELSE law.law_num END",
            params![law_id, name, law_num, source],
        )
        .map_err(|e| e.to_string())?;
        if !name.is_empty() {
            conn.execute(
                "INSERT INTO law_alias (alias, law_id) VALUES (?1, ?2)
                 ON CONFLICT(alias) DO NOTHING",
                params![normalize_alias(name), law_id],
            )
            .map_err(|e| e.to_string())?;
        }
        drop(conn);
        self.invalidate_aliases();
        Ok(())
    }

    pub fn upsert_article(
        &self,
        law_id: &str,
        article: &ParsedArticle,
        as_of: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO article (
                law_id, article_key, article_num, heading, body, as_of, probed_on, suppl
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)
             ON CONFLICT(law_id, article_key) DO UPDATE SET
               article_num = excluded.article_num,
               heading = excluded.heading,
               body = excluded.body,
               as_of = excluded.as_of,
               probed_on = excluded.probed_on,
               suppl = excluded.suppl",
            params![
                law_id,
                article.key,
                article.num,
                article.heading,
                article.body,
                as_of,
                article.suppl as i64
            ],
        )
        .map_err(|e| e.to_string())?;
        bump_rev_locked(&conn)?;
        drop(conn);
        self.law_cache.lock().remove(law_id);
        self.note_dirty(law_id, Vec::new());
        Ok(())
    }

    pub fn mark_probed(&self, law_id: &str, key: &str, today: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE article SET probed_on = ?3 WHERE law_id = ?1 AND article_key = ?2",
            params![law_id, key, today],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_law_revision(
        &self,
        law_id: &str,
        as_of: &str,
        checked_on: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE law SET as_of = ?2, checked_on = ?3 WHERE law_id = ?1",
            params![law_id, as_of, checked_on],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn lookup_article(&self, law_id: &str, key: &str) -> Result<Option<ArticleRow>, String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT law_id, article_key, article_num, heading, body, as_of, probed_on, suppl
             FROM article WHERE law_id = ?1 AND article_key = ?2",
            params![law_id, key],
            read_article,
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn articles_for(&self, law_id: &str) -> Result<Vec<ArticleRow>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT law_id, article_key, article_num, heading, body, as_of, probed_on, suppl
                 FROM article WHERE law_id = ?1 ORDER BY article_key",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([law_id], read_article)
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    pub fn article_count_for(&self, law_id: &str) -> Result<usize, String> {
        let conn = self.conn.lock();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM article WHERE law_id = ?1",
                [law_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(n.max(0) as usize)
    }

    pub fn law_ref(&self, law_id: &str) -> Result<Option<LawRef>, String> {
        if let Some(hit) = self.law_cache.lock().get(law_id) {
            return Ok(Some(hit.clone()));
        }
        let found = self.law_ref_db(law_id)?;
        if let Some(law) = &found {
            self.law_cache.lock().insert(law.law_id.clone(), law.clone());
        }
        Ok(found)
    }

    fn law_ref_db(&self, law_id: &str) -> Result<Option<LawRef>, String> {
        let conn = self.conn.lock();
        let row = conn
            .query_row(
                "SELECT l.law_id, l.name, l.law_num, l.as_of, l.checked_on,
                        (SELECT COUNT(*) FROM article a WHERE a.law_id = l.law_id),
                        l.source
                 FROM law l WHERE l.law_id = ?1",
                [law_id],
                |row| {
                    Ok(LawRef {
                        law_id: row.get(0)?,
                        name: row.get(1)?,
                        law_num: row.get(2)?,
                        as_of: row.get(3)?,
                        checked_on: row.get(4)?,
                        article_count: row.get::<_, i64>(5)? as usize,
                        source: row.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if row.is_some() {
            return Ok(row);
        }
        conn.query_row(
            "SELECT law_id, name, law_num FROM law_name WHERE law_id = ?1",
            [law_id],
            |row| {
                Ok(LawRef {
                    law_id: row.get(0)?,
                    name: row.get(1)?,
                    law_num: row.get(2)?,
                    as_of: String::new(),
                    checked_on: String::new(),
                    article_count: 0,
                    source: String::new(),
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn aliases_of(&self, law_id: &str) -> Result<Vec<String>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT alias FROM law_alias WHERE law_id = ?1 ORDER BY length(alias) DESC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([law_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    /// Rightmost current-law name in `text`. Historical prefixes are ignored.
    pub fn rightmost_law(&self, text: &str) -> Result<Option<LawRef>, String> {
        #[cfg(test)]
        crate::statute::check::RIGHTMOST_CALLS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.ensure_alias_cache()?;
        let cache = self.aliases.lock();
        let Some(entries) = cache.as_ref() else {
            return Ok(None);
        };
        let mut best: Option<(usize, usize, String, String)> = None;
        for hit in entries {
            let mut from = 0usize;
            while let Some(pos) = text[from..].find(&hit.alias) {
                let abs = from + pos;
                if !text.is_char_boundary(abs) {
                    from = abs + 1;
                    continue;
                }
                let before = &text[..abs];
                if alias_prefix_ok(before) {
                    let end = abs + hit.alias.len();
                    let replace = match &best {
                        None => true,
                        Some((at, alen, _, _)) => end > *at || (end == *at && hit.alias.len() > *alen),
                    };
                    if replace {
                        best = Some((end, hit.alias.len(), hit.law_id.clone(), hit.name.clone()));
                    }
                }
                from = abs + hit.alias.len().max(1);
            }
        }
        let Some((_, _, law_id, name)) = best else {
            return Ok(None);
        };
        drop(cache);
        self.law_with_fallback(&law_id, &name)
    }

    pub fn match_law_in_text(&self, text: &str) -> Result<Option<LawRef>, String> {
        if let Some(span) = article_spans(text).into_iter().next() {
            let chars: Vec<char> = text.chars().collect();
            let mut end = span.start;
            while end > 0 && chars[end - 1].is_whitespace() {
                end -= 1;
            }
            let before: String = chars[..end].iter().collect();
            return self.alias_ending(&before);
        }
        self.alias_contained(text)
    }

    fn alias_ending(&self, text: &str) -> Result<Option<LawRef>, String> {
        let norm = normalize_alias(text);
        if norm.chars().count() < 2 {
            return Ok(None);
        }
        self.ensure_alias_cache()?;
        let cache = self.aliases.lock();
        let Some(entries) = cache.as_ref() else {
            return Ok(None);
        };
        let found = longest_bounded_suffix(entries, &norm);
        let Some(found) = found else {
            return Ok(None);
        };
        let law_id = found.law_id.clone();
        let fallback_name = found.name.clone();
        drop(cache);
        self.law_with_fallback(&law_id, &fallback_name)
    }

    fn alias_contained(&self, text: &str) -> Result<Option<LawRef>, String> {
        let norm = normalize_alias(text);
        if norm.chars().count() < 2 {
            return Ok(None);
        }
        self.ensure_alias_cache()?;
        let cache = self.aliases.lock();
        let Some(entries) = cache.as_ref() else {
            return Ok(None);
        };
        let found = longest_bounded_suffix(entries, &norm);
        let Some(found) = found else {
            return Ok(None);
        };
        let law_id = found.law_id.clone();
        let fallback_name = found.name.clone();
        drop(cache);
        self.law_with_fallback(&law_id, &fallback_name)
    }

    fn law_with_fallback(&self, law_id: &str, fallback_name: &str) -> Result<Option<LawRef>, String> {
        let mut law = self.law_ref(law_id)?;
        if let Some(law) = law.as_mut() {
            if law.name.is_empty() {
                law.name = fallback_name.to_string();
            }
        }
        Ok(law)
    }

    pub fn resolve_name(&self, name: &str) -> Result<Option<LawRef>, String> {
        let norm = normalize_alias(name);
        if norm.is_empty() {
            return Ok(None);
        }
        let conn = self.conn.lock();
        let id: Option<String> = conn
            .query_row(
                "SELECT law_id FROM law_alias WHERE alias = ?1",
                [&norm],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let id = if let Some(id) = id {
            id
        } else {
            let found: Option<String> = conn
                .query_row(
                    "SELECT law_id FROM law_name WHERE name = ?1",
                    [&norm],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let Some(found) = found else {
                drop(conn);
                return self.law_from_split_alias(&norm);
            };
            found
        };
        drop(conn);
        self.law_ref(&id)
    }

    fn law_from_split_alias(&self, name: &str) -> Result<Option<LawRef>, String> {
        self.ensure_alias_cache()?;
        let cache = self.aliases.lock();
        let Some(hit) = cache.as_ref().and_then(|entries| entries.iter().find(|hit| hit.alias == name)) else {
            return Ok(None);
        };
        let law_id = hit.law_id.clone();
        let fallback = hit.name.clone();
        drop(cache);
        self.law_with_fallback(&law_id, &fallback)
    }

    pub fn list_articles(&self) -> Result<Vec<(String, ArticleRow)>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT a.law_id, a.article_key, a.article_num, a.heading, a.body, a.as_of,
                        a.probed_on, a.suppl, COALESCE(l.name, n.name, a.law_id)
                 FROM article a
                 LEFT JOIN law l ON l.law_id = a.law_id
                 LEFT JOIN law_name n ON n.law_id = a.law_id
                 ORDER BY a.law_id, a.article_key",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let name: String = row.get(8)?;
                Ok((
                    name,
                    ArticleRow {
                        law_id: row.get(0)?,
                        key: row.get(1)?,
                        num: row.get(2)?,
                        heading: row.get(3)?,
                        body: row.get(4)?,
                        as_of: row.get(5)?,
                        probed_on: row.get(6)?,
                        suppl: row.get::<_, i64>(7)? != 0,
                    },
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    pub fn store_updates(&self, day: &str, today: &str, rows: &[ListedUpdate]) -> Result<(), String> {
        let today_d = parse_ymd(today);
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute("INSERT OR IGNORE INTO update_day (day) VALUES (?1)", [day])
            .map_err(|e| e.to_string())?;
        for row in rows {
            if row.law_id.is_empty() {
                continue;
            }
            let enforce = parse_ymd(&row.enforce_on);
            let as_of_date = parse_ymd(&row.as_of);
            // Today still counts as outstanding: refetch on the following day.
            let outstanding = row.pending
                || enforce
                    .zip(today_d)
                    .is_some_and(|(date, today)| date >= today)
                || as_of_date
                    .zip(today_d)
                    .is_some_and(|(date, today)| date >= today);
            if outstanding {
                let when = if !row.enforce_on.is_empty() {
                    row.enforce_on.as_str()
                } else {
                    row.as_of.as_str()
                };
                if !when.is_empty() {
                    remember_pending(&tx, &row.law_id, when)?;
                }
                continue;
            }
            if row.as_of.is_empty() {
                continue;
            }
            tx.execute(
                "INSERT INTO law_update (law_id, as_of) VALUES (?1, ?2)
                 ON CONFLICT(law_id) DO UPDATE SET
                   as_of = CASE WHEN excluded.as_of > law_update.as_of THEN excluded.as_of ELSE law_update.as_of END",
                params![row.law_id, row.as_of],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn pending_due(&self, law_id: &str, today: &str) -> Result<bool, String> {
        let conn = self.conn.lock();
        let when: Option<String> = conn
            .query_row(
                "SELECT enforce_on FROM pending_revision WHERE law_id = ?1",
                [law_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(when) = when else {
            return Ok(false);
        };
        // The enforcement day itself is too early: the published text can still
        // be the pre-amendment one. Recheck from the next day.
        Ok(parse_ymd(&when)
            .zip(parse_ymd(today))
            .is_some_and(|(due, today)| due < today))
    }

    pub fn clear_pending(&self, law_id: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM pending_revision WHERE law_id = ?1", [law_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn remote_as_of(&self, law_id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT as_of FROM law_update WHERE law_id = ?1",
            [law_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn update_span(&self) -> Result<(Option<String>, Option<String>, i64), String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT MIN(day), MAX(day), COUNT(*) FROM update_day",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|e| e.to_string())
    }

    fn ensure_alias_cache(&self) -> Result<(), String> {
        if self.aliases.lock().is_some() {
            return Ok(());
        }
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT alias, law_id FROM law_alias
                 UNION
                 SELECT name, law_id FROM law WHERE name <> ''
                 UNION
                 SELECT name, law_id FROM law_name WHERE name <> ''",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        let mut map: HashMap<String, String> = HashMap::new();
        for row in rows {
            let (alias, law_id) = row.map_err(|e| e.to_string())?;
            for alias in split_alias_list(&alias) {
                map.entry(alias).or_insert_with(|| law_id.clone());
            }
        }
        let mut entries: Vec<AliasHit> = map
            .into_iter()
            .map(|(alias, law_id)| AliasHit {
                alias,
                law_id,
                name: String::new(),
            })
            .collect();
        entries.sort_by_key(|hit| std::cmp::Reverse(hit.alias.chars().count()));
        drop(stmt);
        drop(conn);
        for hit in &mut entries {
            if let Some(law) = self.law_ref(&hit.law_id)? {
                hit.name = law.name;
            }
        }
        *self.aliases.lock() = Some(entries);
        Ok(())
    }

    fn invalidate_aliases(&self) {
        *self.aliases.lock() = None;
        self.law_cache.lock().clear();
    }
}

fn insert_aliases(
    tx: &Connection,
    law_id: &str,
    name: &str,
    aliases: &[String],
) -> Result<(), String> {
    let mut stmt = tx
        .prepare(
            "INSERT INTO law_alias (alias, law_id) VALUES (?1, ?2)
             ON CONFLICT(alias) DO UPDATE SET law_id = excluded.law_id",
        )
        .map_err(|e| e.to_string())?;
    let mut seen = Vec::new();
    if !name.is_empty() {
        seen.push(normalize_alias(name));
    }
    for alias in aliases {
        seen.extend(split_alias_list(alias));
    }
    seen.retain(|alias| alias.chars().count() >= 2);
    seen.sort();
    seen.dedup();
    for alias in seen {
        stmt.execute(params![alias, law_id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn read_article(row: &rusqlite::Row<'_>) -> rusqlite::Result<ArticleRow> {
    Ok(ArticleRow {
        law_id: row.get(0)?,
        key: row.get(1)?,
        num: row.get(2)?,
        heading: row.get(3)?,
        body: row.get(4)?,
        as_of: row.get(5)?,
        probed_on: row.get(6)?,
        suppl: row.get::<_, i64>(7)? != 0,
    })
}

fn meta_locked(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .optional()
    .map_err(|e| e.to_string())
}

fn set_meta_locked(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn normalize_alias(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_whitespace() && *c != '　')
        .collect()
}

/// e-Gov sometimes stores several abbreviations in one cell (`労災法,労災保険法`).
pub fn split_alias_list(alias: &str) -> Vec<String> {
    alias
        .split([',', '、', '，'])
        .map(normalize_alias)
        .filter(|alias| alias.chars().count() >= 2)
        .collect()
}

/// The alias is a suffix, and the character before it is a real boundary
/// (start, punctuation, a particle) or a known prefix such as 改正.
/// `旧` and `改正前` are not boundaries: those names are not the current act.
pub fn alias_suffix_bounded(text: &str, alias: &str) -> bool {
    if alias.chars().count() < 2 || !text.ends_with(alias) {
        return false;
    }
    let before = &text[..text.len() - alias.len()];
    alias_prefix_ok(before)
}

/// Hiragana that can sit immediately before a law name (`について民法`).
/// Longest first so `によれば` is not cut down to `より`.
const NAME_PARTICLES: &[&str] = &[
    "によれば",
    "について",
    "ならびに",
    "による",
    "により",
    "として",
    "同じく",
    "では",
    "には",
    "とは",
    "前記",
    "上記",
    "から",
    "まで",
    "なお",
    "より",
];

fn longest_bounded_suffix<'a>(entries: &'a [AliasHit], norm: &str) -> Option<&'a AliasHit> {
    entries
        .iter()
        .filter(|hit| alias_suffix_bounded(norm, &hit.alias))
        .max_by_key(|hit| hit.alias.chars().count())
}

fn alias_prefix_ok(before: &str) -> bool {
    if before.is_empty() {
        return true;
    }
    if before.ends_with('旧') || before.ends_with("改正前") {
        return false;
    }
    for prefix in ["改正", "現行", "新"] {
        if let Some(rest) = before.strip_suffix(prefix) {
            return rest.is_empty() || rest.chars().last().is_some_and(is_name_boundary);
        }
    }
    if NAME_PARTICLES.iter().any(|particle| before.ends_with(particle)) {
        return true;
    }
    // 及び / 又は / 並びに may separate a law name (`本件及び民法`).
    // A longer catalog name that contains the joiner still wins, because the
    // caller keeps the longest bounded suffix.
    if joiner_boundary(before) {
        return true;
    }
    before.chars().last().is_some_and(is_name_boundary)
}

fn joiner_boundary(before: &str) -> bool {
    ["並びに", "ならびに", "および", "または", "及び", "又は"]
        .iter()
        .any(|conn| before.ends_with(conn))
}

/// Drops a particle glued to the front of a law name (`契約による民法` → `民法`).
/// A remainder that still contains hiragana is left alone so official titles
/// such as `個人情報の保護に関する法律` stay intact.
pub(crate) fn law_name_after_particle(text: &str) -> &str {
    let mut best = 0usize;
    for particle in NAME_PARTICLES {
        let Some(idx) = text.rfind(particle) else {
            continue;
        };
        let after = idx + particle.len();
        if !text.is_char_boundary(after) {
            continue;
        }
        let rest = &text[after..];
        if rest.chars().count() < 2 {
            continue;
        }
        if rest.chars().any(|c| ('\u{3040}'..='\u{309F}').contains(&c)) {
            continue;
        }
        if after > best && after < text.len() {
            best = after;
        }
    }
    if best == 0 {
        text
    } else {
        &text[best..]
    }
}

fn is_name_boundary(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            '。' | '、'
                | '，'
                | '．'
                | '.'
                | '・'
                | '（'
                | '）'
                | '('
                | ')'
                | '「'
                | '」'
                | '『'
                | '』'
                | '：'
                | ':'
                | '；'
                | ';'
                | 'は'
                | 'を'
                | 'に'
                | 'が'
                | 'と'
                | 'の'
                | 'や'
                | 'も'
                | 'へ'
                | 'で'
                | 'か'
        )
}


const SEED_IMPORT_SQL: &str = "
BEGIN;
INSERT INTO law_name (law_id, name, law_num)
SELECT law_id, name, law_num FROM seed.law_name
WHERE 1
ON CONFLICT(law_id) DO UPDATE SET
  name = excluded.name,
  law_num = excluded.law_num;
INSERT INTO law_alias (alias, law_id)
SELECT alias, law_id FROM seed.law_alias
WHERE 1
ON CONFLICT(alias) DO UPDATE SET law_id = excluded.law_id;
DELETE FROM article WHERE law_id IN (
  SELECT s.law_id FROM seed.law s
  LEFT JOIN law l ON l.law_id = s.law_id
  WHERE l.law_id IS NULL OR s.as_of >= COALESCE(l.as_of, '')
);
INSERT INTO article (
  law_id, article_key, article_num, heading, body, as_of, probed_on, suppl
)
SELECT law_id, article_key, article_num, heading, body, as_of, probed_on, suppl
FROM seed.article
WHERE law_id IN (
  SELECT s.law_id FROM seed.law s
  LEFT JOIN law l ON l.law_id = s.law_id
  WHERE l.law_id IS NULL OR s.as_of >= COALESCE(l.as_of, '')
);
INSERT INTO law (law_id, name, law_num, as_of, checked_on, source)
SELECT law_id, name, law_num, as_of, checked_on, source FROM seed.law
WHERE 1
ON CONFLICT(law_id) DO UPDATE SET
  name = excluded.name,
  law_num = excluded.law_num,
  as_of = CASE WHEN excluded.as_of >= law.as_of THEN excluded.as_of ELSE law.as_of END,
  checked_on = CASE WHEN excluded.as_of >= law.as_of THEN excluded.checked_on ELSE law.checked_on END,
  source = CASE
    WHEN law.source = 'egov' AND excluded.as_of < law.as_of THEN law.source
    ELSE excluded.source
  END;
COMMIT;
";

fn import_attached(conn: &Connection, path: &Path) -> Result<(), String> {
    let attached = path.to_string_lossy().to_string();
    let mut did_attach = false;
    let import = (|| -> Result<(), String> {
        conn.execute("ATTACH DATABASE ?1 AS seed", [&attached])
            .map_err(|e| e.to_string())?;
        did_attach = true;
        conn.execute_batch(SEED_IMPORT_SQL)
            .map_err(|e| e.to_string())?;
        Ok(())
    })();
    if import.is_err() {
        let _ = conn.execute_batch("ROLLBACK;");
    }
    if did_attach {
        let _ = conn.execute("DETACH DATABASE seed", []);
    }
    import
}

fn remember_pending(conn: &Connection, law_id: &str, enforce_on: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO pending_revision (law_id, enforce_on) VALUES (?1, ?2)
         ON CONFLICT(law_id) DO UPDATE SET
           enforce_on = CASE
             WHEN excluded.enforce_on < pending_revision.enforce_on THEN excluded.enforce_on
             ELSE pending_revision.enforce_on
           END",
        params![law_id, enforce_on],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn bump_rev_locked(conn: &Connection) -> Result<(), String> {
    let current = meta_locked(conn, "content_rev")?.unwrap_or_default();
    let next = current.parse::<u64>().unwrap_or(0).saturating_add(1);
    set_meta_locked(conn, "content_rev", &next.to_string())
}

fn seed_temp_path() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "argos-statute-seed-{}-{nanos}.db",
        std::process::id()
    ))
}

const SEED: &[u8] = include_bytes!("../../resources/statutes.db.gz");

#[allow(dead_code)]
pub fn gzip_file(src: &Path, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut input = File::open(src).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    input.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let file = File::create(dest).map_err(|e| e.to_string())?;
    let mut encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    encoder.write_all(&raw).map_err(|e| e.to_string())?;
    encoder.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::statute::xmlparse::ParsedArticle;

    struct TempDir {
        path: std::path::PathBuf,
    }

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "argos-statute-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn path(&self) -> &std::path::Path {
            &self.path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn temp_db() -> (TempDir, StatuteDb) {
        let dir = TempDir::new();
        let db = StatuteDb::open_empty(&dir.path().join("statutes.db")).unwrap();
        (dir, db)
    }

    #[test]
    fn schema_lookup_alias_and_newer_bundle_does_not_clobber_a_fresher_row() {
        let (_dir, db) = temp_db();
        let article = ParsedArticle {
            key: "555".into(),
            num: "第555条".into(),
            heading: "売買".into(),
            body: "古い本文".into(),
            suppl: false,
        };
        db.replace_law(
            "129AC0000000089",
            "民法",
            "明治二十九年法律第八十九号",
            "2020-04-01",
            "2020-04-01",
            "bundle",
            &["民法".into()],
            &[article.clone()],
        )
        .unwrap();
        let found = db.resolve_name("民法").unwrap().unwrap();
        assert_eq!(found.law_id, "129AC0000000089");
        assert_eq!(found.article_count, 1);
        let row = db.lookup_article(&found.law_id, "555").unwrap().unwrap();
        assert_eq!(row.heading, "売買");
        assert_eq!(row.body, "古い本文");
        assert_eq!(row.as_of, "2020-04-01");
        assert!(db.match_law_in_text("民法第555条の効果").unwrap().is_some());

        let newer = ParsedArticle {
            body: "新しい本文".into(),
            ..article
        };
        db.replace_law(
            "129AC0000000089",
            "民法",
            "明治二十九年法律第八十九号",
            "2026-04-01",
            "2026-04-01",
            "egov",
            &["民法".into()],
            &[newer],
        )
        .unwrap();
        let row = db
            .lookup_article("129AC0000000089", "555")
            .unwrap()
            .unwrap();
        assert_eq!(row.body, "新しい本文");
        assert_eq!(row.as_of, "2026-04-01");
        assert_eq!(db.article_count().unwrap(), 1);
    }

    #[test]
    fn bundled_seed_opens_and_contains_core_statutes() {
        let dir = TempDir::new();
        let db = StatuteDb::open(&dir.path().join("statutes.db")).unwrap();
        assert!(db.bundled_law_count().unwrap() >= 30, "bundled laws");
        let row = db
            .lookup_article("129AC0000000089", "555")
            .unwrap()
            .expect("民法第555条");
        assert_eq!(row.heading, "売買");
        assert!(row.body.contains("財産権を相手方に移転"), "{}", row.body);
        assert!(row.as_of.len() >= 10);
        let constitution = db.resolve_name("憲法").unwrap().expect("憲法");
        assert_eq!(constitution.law_id, "321CONSTITUTION");
        assert!(constitution.article_count > 10);
    }

    #[test]
    fn update_list_keeps_the_newest_revision_date() {
        let (_dir, db) = temp_db();
        let row = |as_of: &str| ListedUpdate {
            law_id: "129AC0000000089".into(),
            as_of: as_of.into(),
            enforce_on: as_of.into(),
            pending: false,
        };
        db.store_updates("2026-11-10", "2026-11-11", &[row("2024-04-01")])
            .unwrap();
        db.store_updates("2026-11-11", "2026-11-11", &[row("2026-04-01")])
            .unwrap();
        db.store_updates("2026-11-09", "2026-11-11", &[row("2020-01-01")])
            .unwrap();
        assert_eq!(
            db.remote_as_of("129AC0000000089").unwrap().as_deref(),
            Some("2026-04-01")
        );
        let (from, through, count) = db.update_span().unwrap();
        assert_eq!(from.as_deref(), Some("2026-11-09"));
        assert_eq!(through.as_deref(), Some("2026-11-11"));
        assert_eq!(count, 3);
    }

    #[test]
    fn article_number_binds_to_the_law_name_before_it() {
        let (_dir, db) = temp_db();
        let article = ParsedArticle {
            key: "555".into(),
            num: "第555条".into(),
            heading: "売買".into(),
            body: "本文".into(),
            suppl: false,
        };
        db.replace_law(
            "129AC0000000089",
            "民法",
            "",
            "2026-04-01",
            "2026-04-01",
            "bundle",
            &["民法".into()],
            &[article.clone()],
        )
        .unwrap();
        db.replace_law(
            "417AC0000000086",
            "会社法",
            "",
            "2026-04-01",
            "2026-04-01",
            "bundle",
            &["会社法".into()],
            &[article],
        )
        .unwrap();
        let law = db
            .match_law_in_text("民法第555条と会社法")
            .unwrap()
            .unwrap();
        assert_eq!(law.law_id, "129AC0000000089");
        assert!(db.match_law_in_text("第555条と会社法").unwrap().is_none());
    }

    #[test]
    fn a_comma_separated_alias_resolves_each_name() {
        let (_dir, db) = temp_db();
        let article = ParsedArticle {
            key: "1".into(),
            num: "第1条".into(),
            heading: String::new(),
            body: "本文".into(),
            suppl: false,
        };
        db.replace_law(
            "322AC0000000050",
            "労働者災害補償保険法",
            "",
            "2026-11-11",
            "2026-11-11",
            "bundle",
            &["労災法,労災保険法".into()],
            &[article],
        )
        .unwrap();
        let law = db.resolve_name("労災法").unwrap().expect("労災法");
        assert_eq!(law.law_id, "322AC0000000050");
        assert!(db.resolve_name("労災保険法").unwrap().is_some());
    }

    #[test]
    fn empty_replacement_does_not_delete_articles() {
        let (_dir, db) = temp_db();
        db.replace_law(
            "129AC0000000089",
            "民法",
            "",
            "2026-04-01",
            "2026-04-01",
            "bundle",
            &["民法".into()],
            &[ParsedArticle {
                key: "1".into(),
                num: "第1条".into(),
                heading: String::new(),
                body: "本文".into(),
                suppl: false,
            }],
        )
        .unwrap();
        let err = db
            .replace_law(
                "129AC0000000089",
                "民法",
                "",
                "2026-11-11",
                "2026-11-11",
                "egov",
                &["民法".into()],
                &[],
            )
            .unwrap_err();
        assert!(err.contains("置き換えません"), "{err}");
        assert!(db
            .lookup_article("129AC0000000089", "1")
            .unwrap()
            .is_some());
    }

    #[test]
    fn failed_attach_rolls_back_and_detaches() {
        let (dir, db) = temp_db();
        let bad = dir.path().join("bad.db");
        let raw = Connection::open(&bad).unwrap();
        raw.execute_batch("CREATE TABLE dummy (id INTEGER);")
            .unwrap();
        drop(raw);
        let err = db.import_attached_db(&bad).unwrap_err();
        assert!(!err.is_empty());
        assert_eq!(db.article_count().unwrap(), 0);
        let again = db.import_attached_db(&bad).unwrap_err();
        assert!(
            !again.contains("already in use"),
            "seed stayed attached: {again}"
        );
        assert!(bad.exists(), "the caller's file is not the temp seed");
    }

    #[test]
    fn a_future_update_is_pending_until_it_is_in_force() {
        let (_dir, db) = temp_db();
        db.store_updates(
            "2026-11-11",
            "2026-11-11",
            &[ListedUpdate {
                law_id: "129AC0000000089".into(),
                as_of: String::new(),
                enforce_on: "2027-04-01".into(),
                pending: true,
            }],
        )
        .unwrap();
        assert!(db.remote_as_of("129AC0000000089").unwrap().is_none());
        assert!(!db.pending_due("129AC0000000089", "2026-11-11").unwrap());
        assert!(!db.pending_due("129AC0000000089", "2027-04-01").unwrap());
        assert!(db.pending_due("129AC0000000089", "2027-04-02").unwrap());
    }

    #[test]
    fn pending_dates_keep_the_earliest_and_a_today_row_is_not_dropped() {
        let (_dir, db) = temp_db();
        let row = |enforce: &str, pending: bool| ListedUpdate {
            law_id: "129AC0000000089".into(),
            as_of: if pending {
                String::new()
            } else {
                enforce.into()
            },
            enforce_on: enforce.into(),
            pending,
        };
        db.store_updates("2026-11-01", "2026-11-11", &[row("2027-06-01", true)])
            .unwrap();
        db.store_updates("2026-11-02", "2026-11-11", &[row("2027-04-01", true)])
            .unwrap();
        assert!(!db.pending_due("129AC0000000089", "2027-04-01").unwrap());
        assert!(
            db.pending_due("129AC0000000089", "2027-04-02").unwrap(),
            "a later pending date must not replace the earlier one"
        );
        db.store_updates(
            "2026-11-11",
            "2026-11-11",
            &[ListedUpdate {
                law_id: "129AC0000000089".into(),
                as_of: "2024-04-01".into(),
                enforce_on: "2024-04-01".into(),
                pending: false,
            }],
        )
        .unwrap();
        assert_eq!(
            db.remote_as_of("129AC0000000089").unwrap().as_deref(),
            Some("2024-04-01")
        );
        assert!(db.pending_due("129AC0000000089", "2027-04-02").unwrap());
        db.store_updates("2026-11-11", "2026-11-11", &[row("2026-11-11", false)])
            .unwrap();
        assert!(!db.pending_due("129AC0000000089", "2026-11-11").unwrap());
        assert!(db.pending_due("129AC0000000089", "2026-11-12").unwrap());
    }
}
