//! Document citation check: law, article, 項, 号, and a 「」 quote.
//!
//! The button path is deterministic. It never calls an LLM. Online calls, when
//! enabled, go through `resolve_without_refresh` and send only a law id and an
//! article number.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use crate::statute::cite::{ArticleMiss, ToolArticle};
use crate::statute::egov::{EgovFailure, EgovSource};
use crate::statute::legal_ref::{is_numeral_char, parse_legal_numeral};
use crate::statute::lookup::{resolve_without_refresh, ArticleQuery};
use crate::statute::store::{LawRef, StatuteDb};
use crate::statute::xmlparse::article_spans;

pub const SOURCE_LABEL: &str = "e-Gov法令検索";
pub const OFFLINE_NOTE: &str = "改正確認できず（オフライン）";

const DENY_LAW_NAME: &[&str] = &[
    "方法", "手法", "療法", "用法", "違法", "適法", "合法", "魔法", "司法", "立法", "憲法改正",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckHit {
    pub citation: String,
    pub status: String,
    pub label: String,
    pub reason: String,
    pub diff: String,
    pub article_text: String,
    pub as_of: String,
    pub source: String,
    pub offline_note: String,
    pub anchor: String,
    pub occurrence: usize,
}

struct Raw {
    start: usize,
    law: Option<LawRef>,
    unresolved: String,
    bare_douhou: bool,
    historical: bool,
    key: String,
    display: String,
    paragraph: Option<u32>,
    item: Option<u32>,
    item_branch: Vec<u32>,
    clause_unread: bool,
    quote: Option<String>,
    quote_unread: bool,
    inside_quote: bool,
    suppl: bool,
    schedule: bool,
    anchor: String,
    citation: String,
}

const MAX_ONLINE: usize = 50;
const MAX_PROBES: usize = 50;
const ONLINE_GAP_MS: u64 = 350;

pub fn check_text(
    db: &StatuteDb,
    client: &dyn EgovSource,
    text: &str,
    today: &str,
    online: bool,
) -> Vec<CheckHit> {
    check_text_opts(
        db,
        client,
        text,
        today,
        online,
        MAX_ONLINE,
        ONLINE_GAP_MS,
        MAX_PROBES,
    )
}

thread_local! {
    static CHECK_CANCEL: std::cell::RefCell<Option<std::sync::Arc<AtomicBool>>> =
        std::cell::RefCell::new(None);
}

fn cancel_requested() -> bool {
    CHECK_CANCEL.with(|slot| {
        slot.borrow()
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Relaxed))
    })
}

/// The button handler sets this for the duration of one check. The blocking
/// loop stops calling e-Gov once the HTTP request is dropped.
pub fn set_check_cancel(flag: Option<std::sync::Arc<AtomicBool>>) {
    CHECK_CANCEL.with(|slot| *slot.borrow_mut() = flag);
}

pub fn check_text_opts(
    db: &StatuteDb,
    client: &dyn EgovSource,
    text: &str,
    today: &str,
    online: bool,
    max_online: usize,
    delay_ms: u64,
    probe_cap: usize,
) -> Vec<CheckHit> {
    let raws = scan(db, text);
    if raws.is_empty() {
        return Vec::new();
    }
    let guarded = LocalNames { inner: client };
    if online {
        let _ = crate::statute::lookup::warm_updates(db, &guarded, today);
    }
    let budget = OnlineBudget {
        max: max_online,
        delay_ms,
        used: std::cell::Cell::new(0usize),
    };
    let probes = OnlineBudget {
        max: probe_cap,
        delay_ms,
        used: std::cell::Cell::new(0usize),
    };
    let mut out = Vec::new();
    for raw in raws {
        let occurrence = literal_occurrence(text, &raw.anchor, raw.start);
        out.push(judge(
            db, &guarded, raw, today, online, &budget, &probes, occurrence,
        ));
    }
    out
}

struct OnlineBudget {
    max: usize,
    delay_ms: u64,
    used: std::cell::Cell<usize>,
}

impl OnlineBudget {
    fn allow(&self) -> bool {
        let used = self.used.get();
        if used >= self.max {
            return false;
        }
        if used > 0 && self.delay_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(self.delay_ms));
        }
        self.used.set(used + 1);
        true
    }
}

/// Law-name catalog requests are answered locally. Only a law id and an
/// article number are allowed to leave the machine.
struct LocalNames<'a> {
    inner: &'a dyn EgovSource,
}

impl EgovSource for LocalNames<'_> {
    fn fetch(&self, url: &str) -> Result<String, EgovFailure> {
        if url.contains("/lawlists/") {
            return Ok("<DataRoot></DataRoot>".into());
        }
        self.inner.fetch(url)
    }
}

fn literal_occurrence(text: &str, anchor: &str, start_char: usize) -> usize {
    if anchor.is_empty() || start_char == 0 {
        return 0;
    }
    let mut bytes = 0usize;
    for (seen, ch) in text.chars().enumerate() {
        if seen >= start_char {
            break;
        }
        bytes += ch.len_utf8();
    }
    text[..bytes.min(text.len())].matches(anchor).count()
}

fn judge(
    db: &StatuteDb,
    client: &dyn EgovSource,
    raw: Raw,
    today: &str,
    online: bool,
    budget: &OnlineBudget,
    probes: &OnlineBudget,
    occurrence: usize,
) -> CheckHit {
    let mut hit = CheckHit {
        citation: raw.citation.clone(),
        status: "review".into(),
        label: "要確認".into(),
        reason: String::new(),
        diff: String::new(),
        article_text: String::new(),
        as_of: String::new(),
        source: SOURCE_LABEL.into(),
        offline_note: String::new(),
        anchor: raw.anchor,
        occurrence,
    };
    if raw.bare_douhou {
        hit.reason = "同法の指す法令が分かりません。".into();
        return hit;
    }
    if raw.historical {
        hit.reason = "現行の条文だけを照合します。".into();
        return hit;
    }
    if raw.clause_unread {
        hit.reason = "項または号を読めませんでした。".into();
        return hit;
    }
    if raw.schedule {
        hit.reason = "別表は照合しません。".into();
        return hit;
    }
    if raw.suppl {
        hit.reason = "附則は照合しません。".into();
        return hit;
    }
    if raw.unresolved.is_empty() && raw.law.is_none() {
        hit.reason = "法令名を特定できませんでした。".into();
        return hit;
    }
    let Some(law) = raw.law.clone() else {
        hit.reason = format!("法令名を特定できませんでした（{}）。", raw.unresolved);
        return hit;
    };
    let local = db.lookup_article(&law.law_id, &raw.key).ok().flatten();
    if local.as_ref().is_some_and(|row| is_deleted_body(&row.body)) && !online {
        hit.reason = "削除された条です".into();
        return hit;
    }
    if local.is_none() && !online {
        // A missing row in the seed is not proof the article does not exist.
        hit.reason = "未取得（オフライン）".into();
        return hit;
    }
    let fetched = if online {
        if cancel_requested() {
            hit.reason = "照合を中止しました。".into();
            return hit;
        }
        let guarded = LocalNames { inner: client };
        let ask = || {
            resolve_without_refresh(
                db,
                &guarded,
                &[ArticleQuery {
                    law: law.name.clone(),
                    article: raw.display.clone(),
                }],
                today,
            )
            .into_iter()
            .next()
        };
        if let Some(row) = local.clone() {
            let action = crate::statute::lookup::revision_for(db, &law, &row, today, false);
            let probing = matches!(
                action,
                crate::statute::refresh::RevisionAction::ProbeArticle
                    | crate::statute::refresh::RevisionAction::ReloadLaw { .. }
            );
            let cooled = db.probe_failure_is_fresh(&law.law_id, &raw.key);
            if probing && (cooled || !probes.allow()) {
                Some(cached_article(&law, &row, &raw.display, true))
            } else {
                let got = ask();
                if probing && got.as_ref().is_some_and(|item| probe_burst(&item.note)) {
                    let _ = db.note_probe_failure(&law.law_id, &raw.key);
                    Some(cached_article(&law, &row, &raw.display, true))
                } else {
                    got
                }
            }
        } else {
            if !budget.allow() {
                hit.reason = "件数が多いため未確認".into();
                return hit;
            }
            ask()
        }
    } else if let Some(row) = local.clone() {
        Some(ToolArticle {
            names: vec![law.name.clone()],
            article_num: row.num,
            heading: row.heading,
            body: row.body,
            as_of: row.as_of,
            verified: true,
            offline: true,
            note: String::new(),
            law_query: law.name.clone(),
            article_query: raw.display.clone(),
            miss: None,
        })
    } else {
        None
    };
    let Some(article) = fetched else {
        hit.reason = "条文を確認できませんでした。".into();
        return hit;
    };
    if !article.verified {
        match article.miss {
            Some(ArticleMiss::Deleted) => {
                hit.reason = "削除された条です".into();
                return hit;
            }
            Some(ArticleMiss::NotFound) if law.source == "bundle" => {
                return number_miss(hit, "その条はありません。");
            }
            _ => {
                hit.reason = one_line(if article.note.is_empty() {
                    "条文を確認できませんでした。"
                } else {
                    article.note.as_str()
                });
                return hit;
            }
        }
    }
    if is_deleted_body(&article.body) {
        hit.reason = "削除された条です".into();
        return hit;
    }
    let offline = article.offline || !online;
    if offline {
        hit.offline_note = OFFLINE_NOTE.into();
    }
    hit.as_of = article.as_of.clone();
    hit.article_text = if article.heading.is_empty() {
        article.body.clone()
    } else {
        format!("（{}）\n{}", article.heading, article.body)
    };
    let confirmed = article.verified
        && !article.offline
        && db
            .lookup_article(&law.law_id, &raw.key)
            .ok()
            .flatten()
            .is_some_and(|row| row.probed_on == today);
    let target = match clause_text(&article.body, raw.paragraph, raw.item, &raw.item_branch) {
        Ok(text) => text,
        Err(miss) => {
            let what = match &miss {
                ClauseMiss::Paragraph(n) => format!("第{n}項"),
                ClauseMiss::Item(n) => format!("第{n}号"),
                ClauseMiss::Branch(item, branches) => {
                    let tail = branches
                        .iter()
                        .map(|n| n.to_string())
                        .collect::<Vec<_>>()
                        .join("の");
                    format!("第{item}号の{tail}")
                }
            };
            if !confirmed {
                hit.reason = format!("保存済みの本文に{what}がありません（未確認）");
                return hit;
            }
            return number_miss(hit, &format!("{what}はありません。"));
        }
    };
    if is_deleted_text(&target) {
        hit.reason = "削除された項または号です".into();
        hit.offline_note.clear();
        return hit;
    }
    if raw.inside_quote {
        hit.reason = "前の引用の途中にあります。".into();
        return hit;
    }
    if raw.quote_unread {
        hit.reason = "近くの引用を照合できませんでした。".into();
        return hit;
    }
    if let Some(quote) = raw.quote.as_deref() {
        if normalize_compare(quote).is_empty() {
            hit.reason = "引用が空です。".into();
            return hit;
        }
        if let Some(diff) = quote_diff(quote, &target) {
            hit.reason = "引用と条文が違います。".into();
            hit.diff = diff;
            return hit;
        }
    }
    hit.status = "match".into();
    hit.label = "一致".into();
    hit
}

fn cached_article(
    law: &LawRef,
    row: &crate::statute::store::ArticleRow,
    article_query: &str,
    offline: bool,
) -> ToolArticle {
    ToolArticle {
        names: vec![law.name.clone()],
        article_num: row.num.clone(),
        heading: row.heading.clone(),
        body: row.body.clone(),
        as_of: row.as_of.clone(),
        verified: true,
        offline,
        note: String::new(),
        law_query: law.name.clone(),
        article_query: article_query.to_string(),
        miss: None,
    }
}

fn probe_burst(note: &str) -> bool {
    note.contains("HTTP 429") || note.contains("HTTP 500")
}

fn number_miss(mut hit: CheckHit, reason: &str) -> CheckHit {
    hit.status = "number".into();
    hit.label = "番号違い".into();
    hit.reason = reason.into();
    hit.offline_note.clear();
    hit
}

fn one_line(text: &str) -> String {
    text.lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or(text)
        .trim()
        .to_string()
}

#[derive(Clone)]
enum Current {
    Law(LawRef),
    Historical(String),
}

fn scan(db: &StatuteDb, text: &str) -> Vec<Raw> {
    let chars: Vec<char> = text.chars().collect();
    let spans = article_spans(text);
    let mut current: Option<Current> = None;
    let mut prev_end = 0usize;
    let mut raws = Vec::new();
    for (index, span) in spans.iter().enumerate() {
        let next = spans.get(index + 1).map(|s| s.start).unwrap_or(chars.len());
        let from = prev_end.min(span.start);
        let between: String = chars[from..span.start].iter().collect();
        if let Some(mention) = db.rightmost_law(&between).ok().flatten() {
            current = Some(Current::Law(mention));
        } else if let Some(name) = historical_mention(&between) {
            current = Some(Current::Historical(name));
        }
        let window = law_window(&chars, span.start, prev_end);
        let enumerated = window.is_none() && enumeration_gap(&between);
        let dou = window.as_ref().is_some_and(|w| w.text == "同法");
        if let Some(window) = window.as_ref() {
            if window.text != "同法" && denied(&window.text) {
                current = None;
                continue;
            }
        }
        let (law, unresolved, bare_douhou, historical) = if dou {
            match current.clone() {
                Some(Current::Law(law)) => (Some(law), String::new(), false, false),
                Some(Current::Historical(name)) => (None, name, false, true),
                None => (None, String::new(), true, false),
            }
        } else if enumerated {
            match current.clone() {
                Some(Current::Law(law)) => (Some(law), String::new(), false, false),
                Some(Current::Historical(name)) => (None, name, false, true),
                None => {
                    continue;
                }
            }
        } else if window.is_none() {
            // A bare 第N条 that is not part of this citation does not move the
            // quote or the enumeration anchor. Those stay on the last row.
            continue;
        } else if let Some(window) = window.as_ref() {
            if is_historical_name(&window.text) {
                current = Some(Current::Historical(window.text.clone()));
                (None, window.text.clone(), false, true)
            } else {
                match db.match_law_in_text(&window.text) {
                    Ok(Some(law)) => {
                        current = Some(Current::Law(law.clone()));
                        (Some(law), String::new(), false, false)
                    }
                    _ if looks_like_law(&window.text) => {
                        current = None;
                        (None, window.text.clone(), false, false)
                    }
                    _ => {
                        continue;
                    }
                }
            }
        } else {
            current = None;
            continue;
        };
        let clause = read_clause(&chars, span.end, next);
        let mut anchor_start = window.as_ref().map(|w| w.start).unwrap_or(span.start);
        let anchor_end = clause.end.max(span.end).min(chars.len());
        anchor_start = anchor_start.min(anchor_end);
        let mut anchor: String = chars[anchor_start..anchor_end].iter().collect();
        if anchor.chars().count() > 80 {
            let tail = clause_label(clause.paragraph, clause.item, &clause.item_branch);
            anchor = format!("{}{}", span.display, tail);
        }
        let quote = quote_after(&chars, clause.end, next).or_else(|| {
            if closes_paren(&chars, clause.end, next) {
                quote_before(&chars, anchor_start, prev_end)
            } else {
                None
            }
        });
        let quote_unread = quote.is_none() && quote_nearby(&chars, clause.end, next);
        let inside_quote = !raws.is_empty() && quote_still_open(&chars, prev_end, span.start);
        let citation = if dou || window.is_none() {
            if let Some(law) = law.as_ref() {
                format!(
                    "{}{}{}",
                    law.name,
                    span.display,
                    clause_label(clause.paragraph, clause.item, &clause.item_branch)
                )
            } else if historical {
                format!(
                    "{}{}{}",
                    unresolved,
                    span.display,
                    clause_label(clause.paragraph, clause.item, &clause.item_branch)
                )
            } else {
                anchor.clone()
            }
        } else {
            anchor.clone()
        };
        raws.push(Raw {
            start: anchor_start,
            law,
            unresolved,
            bare_douhou,
            historical,
            key: span.key.clone(),
            display: span.display.clone(),
            paragraph: clause.paragraph,
            item: clause.item,
            item_branch: clause.item_branch,
            clause_unread: clause.unread,
            quote,
            quote_unread,
            inside_quote,
            suppl: span.suppl,
            schedule: false,
            anchor,
            citation,
        });
        prev_end = clause.end.max(span.end);
    }
    for (start, end) in schedule_spans(&chars) {
        if raws.iter().any(|raw| start < raw.start + raw.anchor.chars().count() && end > raw.start)
        {
            continue;
        }
        let window = law_window(&chars, start, 0);
        let law = window
            .as_ref()
            .and_then(|w| db.match_law_in_text(&w.text).ok().flatten());
        let anchor_start = window.as_ref().map(|w| w.start).unwrap_or(start);
        let anchor: String = chars[anchor_start..end].iter().collect();
        raws.push(Raw {
            start: anchor_start,
            law,
            unresolved: String::new(),
            bare_douhou: false,
            historical: false,
            key: String::new(),
            display: anchor.clone(),
            paragraph: None,
            item: None,
            item_branch: Vec::new(),
            clause_unread: false,
            quote: None,
            quote_unread: false,
            inside_quote: false,
            suppl: false,
            schedule: true,
            anchor: anchor.clone(),
            citation: anchor,
        });
    }
    raws.sort_by_key(|raw| raw.start);
    raws
}

fn clause_label(paragraph: Option<u32>, item: Option<u32>, branches: &[u32]) -> String {
    let mut out = String::new();
    if let Some(n) = paragraph {
        out.push_str(&format!("第{n}項"));
    }
    if let Some(n) = item {
        out.push_str(&format!("第{n}号"));
    }
    for n in branches {
        out.push_str(&format!("の{n}"));
    }
    out
}

fn is_deleted_body(body: &str) -> bool {
    let text = body.trim();
    text == "削除" || text == "（削除）"
}

fn looks_like_law(text: &str) -> bool {
    text.ends_with('法')
        || text.ends_with('令')
        || text.ends_with("規則")
        || text.ends_with("憲法")
        || text.ends_with("条例")
}

fn is_historical_name(text: &str) -> bool {
    text.starts_with('旧') || text.contains("改正前")
}

fn historical_mention(text: &str) -> Option<String> {
    for token in text.split(|c: char| c.is_whitespace() || matches!(c, '。' | '、' | '，' | '「' | '」' | '（' | '）')) {
        if is_historical_name(token) && looks_like_law(token) {
            return Some(token.to_string());
        }
    }
    None
}

struct Window {
    start: usize,
    text: String,
}

fn law_window(chars: &[char], cite_start: usize, floor: usize) -> Option<Window> {
    let floor = floor.min(cite_start);
    let mut end = cite_start;
    while end > floor && is_hspace(chars[end - 1]) {
        end -= 1;
    }
    if end > floor && is_hard_boundary(chars[end - 1]) {
        return None;
    }
    end = peel_glue(chars, end, floor)?;
    if let Some(cut) = strip_connector(chars, end) {
        if cut < end && cut >= floor {
            return None;
        }
    }
    let mut start = end;
    while start > floor && is_law_char(chars[start - 1]) && !is_hard_boundary(chars[start - 1]) {
        start -= 1;
    }
    if start >= end {
        return None;
    }
    let mut full: String = chars[start..end].iter().collect();
    if let Some(skip) = leading_connector_len(&full) {
        start += skip;
        if start >= end {
            return None;
        }
        full = chars[start..end].iter().collect();
    }
    let peeled = crate::statute::store::law_name_after_particle(&full);
    let shift = full.chars().count() - peeled.chars().count();
    start += shift;
    let text = peeled.to_string();
    if text.ends_with('条') || text.ends_with('項') || text.ends_with('号') {
        return None;
    }
    if text.chars().count() < 2 || is_connector(&text) {
        None
    } else {
        Some(Window { start, text })
    }
}

fn strip_connector(chars: &[char], end: usize) -> Option<usize> {
    let from = end.saturating_sub(8);
    let tail: String = chars[from..end].iter().collect();
    for conn in [
        "若しくは",
        "ならびに",
        "並びに",
        "あるいは",
        "および",
        "又は",
        "または",
        "及び",
        "、",
        "，",
        "・",
        "と",
        "か",
    ] {
        if tail.ends_with(conn) {
            return Some(end - conn.chars().count());
        }
    }
    None
}

fn is_law_char(c: char) -> bool {
    matches!(
        c,
        '\u{4E00}'..='\u{9FFF}'
            | '\u{3400}'..='\u{4DBF}'
            | '\u{3040}'..='\u{309F}'
            | '\u{30A0}'..='\u{30FF}'
            | '々'
            | '、'
            | '，'
    )
}

fn denied(window: &str) -> bool {
    let name = window
        .strip_prefix("改正")
        .or_else(|| window.strip_prefix("現行"))
        .unwrap_or(window);
    DENY_LAW_NAME.iter().any(|deny| name == *deny || window == *deny)
}

fn is_hard_boundary(c: char) -> bool {
    matches!(c, '。' | '！' | '？' | '!' | '?' | '\n' | '\r')
}

fn is_hspace(c: char) -> bool {
    matches!(c, ' ' | '\u{3000}' | '\t')
}

fn enumeration_gap(between: &str) -> bool {
    let chars: Vec<char> = between.chars().collect();
    if gap_crosses_sentence(&chars) {
        return false;
    }
    let text = gap_core(&chars);
    matches!(
        text.as_str(),
        "及び" | "および" | "並びに" | "ならびに" | "又は" | "または" | "若しくは" | "、" | "，" | "・"
    )
}

/// 。！？ and line breaks end a lookback, except inside a parenthetical.
fn gap_crosses_sentence(chars: &[char]) -> bool {
    let mut depth = 0i32;
    let mut quote = false;
    for &c in chars {
        if c == '「' {
            quote = true;
            continue;
        }
        if c == '」' {
            quote = false;
            continue;
        }
        if quote {
            continue;
        }
        if c == '（' || c == '(' {
            depth += 1;
            continue;
        }
        if (c == '）' || c == ')') && depth > 0 {
            depth -= 1;
            continue;
        }
        if depth == 0 && is_hard_boundary(c) {
            return true;
        }
    }
    false
}

fn gap_core(chars: &[char]) -> String {
    let mut text = String::new();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '「' {
            let mut j = i + 1;
            while j < chars.len() && chars[j] != '」' {
                j += 1;
            }
            if j >= chars.len() {
                text.extend(chars[i..].iter());
                break;
            }
            i = j + 1;
            continue;
        }
        if chars[i] == '（' || chars[i] == '(' {
            if let Some(close) = matching_close(chars, i, chars.len()) {
                let inner: String = chars[i + 1..close].iter().collect();
                if is_list_marker(&inner) || is_circled_run(&inner) {
                    text.push(chars[i]);
                    text.push_str(&inner);
                    text.push(chars[close]);
                }
                i = close + 1;
                continue;
            }
            text.push(chars[i]);
            i += 1;
            continue;
        }
        if is_circled(chars[i]) {
            text.push(chars[i]);
            i += 1;
            continue;
        }
        if !chars[i].is_whitespace() {
            text.push(chars[i]);
        }
        i += 1;
    }
    text
}

fn matching_close(chars: &[char], open_at: usize, limit: usize) -> Option<usize> {
    let open = chars.get(open_at).copied()?;
    let close = match open {
        '（' => '）',
        '(' => ')',
        _ => return None,
    };
    let mut depth = 0i32;
    for i in open_at..limit.min(chars.len()) {
        if chars[i] == open {
            depth += 1;
        } else if chars[i] == close {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
    }
    None
}

fn is_list_marker(inner: &str) -> bool {
    let text = inner.trim();
    if text.is_empty() || text.chars().count() > 3 {
        return false;
    }
    if text.chars().all(|c| c.is_ascii_digit() || ('０'..='９').contains(&c)) {
        return true;
    }
    if text.chars().count() == 1 {
        let c = text.chars().next().unwrap();
        if ('ア'..='ン').contains(&c) || is_circled(c) {
            return true;
        }
    }
    parse_legal_numeral(text).is_some()
}

fn is_circled(c: char) -> bool {
    ('①'..='⑳').contains(&c) || ('❶'..='❿').contains(&c) || ('㉑'..='㉟').contains(&c)
}

fn is_circled_run(text: &str) -> bool {
    text.chars().all(is_circled) && !text.is_empty()
}

/// Only an enactment parenthesis may sit between a law name and 第.
/// A heading such as （目的） blocks the name. Matching is nested and stops at a line break.
fn peel_glue(chars: &[char], mut end: usize, floor: usize) -> Option<usize> {
    loop {
        while end > floor && is_hspace(chars[end - 1]) {
            end -= 1;
        }
        if end == floor || is_hard_boundary(chars[end - 1]) {
            break;
        }
        if chars[end - 1] == 'の' {
            end -= 1;
            continue;
        }
        if matches!(chars[end - 1], '）' | ')') {
            let open_at = matching_open_same_line(chars, end - 1, floor)?;
            let inner: String = chars[open_at + 1..end - 1].iter().collect();
            if !is_promulgation(&inner) {
                return None;
            }
            end = open_at;
            continue;
        }
        break;
    }
    Some(end)
}

fn matching_open_same_line(chars: &[char], close_at: usize, floor: usize) -> Option<usize> {
    let close = chars.get(close_at).copied()?;
    let open = match close {
        '）' => '（',
        ')' => '(',
        _ => return None,
    };
    let mut depth = 0i32;
    let mut i = close_at;
    loop {
        let c = chars[i];
        if c == '\n' || c == '\r' {
            return None;
        }
        if c == close {
            depth += 1;
        } else if c == open {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
        if i == floor {
            return None;
        }
        i -= 1;
    }
}

fn is_promulgation(inner: &str) -> bool {
    let kind = ["法律", "政令", "勅令", "府令", "省令", "規則", "条例"]
        .iter()
        .any(|kind| inner.contains(kind));
    inner.contains('年') && kind && inner.contains('第') && inner.contains('号')
}

fn leading_connector_len(text: &str) -> Option<usize> {
    for conn in [
        "若しくは",
        "ならびに",
        "並びに",
        "あるいは",
        "および",
        "又は",
        "または",
        "及び",
        "、",
        "，",
        "・",
    ] {
        if text.starts_with(conn) {
            return Some(conn.chars().count());
        }
    }
    None
}

fn quote_still_open(chars: &[char], from: usize, until: usize) -> bool {
    let mut open = false;
    let until = until.min(chars.len());
    let mut i = from.min(until);
    while i < until {
        if chars[i] == '「' {
            open = true;
        } else if chars[i] == '」' {
            open = false;
        }
        i += 1;
    }
    open
}

fn is_connector(text: &str) -> bool {
    enumeration_gap(text)
}

struct ClauseRead {
    paragraph: Option<u32>,
    item: Option<u32>,
    item_branch: Vec<u32>,
    end: usize,
    unread: bool,
}

fn read_clause(chars: &[char], start: usize, limit: usize) -> ClauseRead {
    let limit = limit.min(chars.len());
    if start >= limit {
        return ClauseRead {
            paragraph: None,
            item: None,
            item_branch: Vec::new(),
            end: limit,
            unread: false,
        };
    }
    let chars = &chars[..limit];
    let mut unread = false;
    let (paragraph, after_p) = match read_unit(chars, start, '項') {
        Some((n, end)) => (n, end),
        None if unit_fragment(chars, start, '項') => {
            unread = true;
            (None, swallow_unit(chars, start, '項'))
        }
        None => (None, start),
    };
    let (item, after_i) = match read_unit(chars, after_p, '号') {
        Some((n, end)) => (n, end),
        None if unit_fragment(chars, after_p, '号') => {
            unread = true;
            (None, swallow_unit(chars, after_p, '号'))
        }
        None => (None, after_p),
    };
    let mut item_branch = Vec::new();
    let mut end = after_i.min(chars.len());
    if item.is_some() {
        while chars.get(end) == Some(&'の') {
            match take_numeral(chars, end + 1) {
                Some((n, next)) => {
                    item_branch.push(n);
                    end = next.min(chars.len());
                }
                None => {
                    unread = true;
                    break;
                }
            }
        }
    }
    ClauseRead {
        paragraph,
        item,
        item_branch,
        end: end.min(chars.len()),
        unread,
    }
}

fn unit_fragment(chars: &[char], start: usize, unit: char) -> bool {
    let mut i = start;
    while i < chars.len() && matches!(chars[i], ' ' | '\u{3000}' | '\t') {
        i += 1;
    }
    if chars.get(i) != Some(&'第') {
        return false;
    }
    chars[i..].iter().take(12).any(|c| *c == unit)
}

fn swallow_unit(chars: &[char], start: usize, unit: char) -> usize {
    let mut i = start;
    while i < chars.len() && matches!(chars[i], ' ' | '\u{3000}' | '\t') {
        i += 1;
    }
    let mut end = i;
    while end < chars.len() && end < i + 16 && chars[end] != unit {
        end += 1;
    }
    if end < chars.len() && chars[end] == unit {
        end + 1
    } else {
        start
    }
}

fn read_unit(chars: &[char], start: usize, unit: char) -> Option<(Option<u32>, usize)> {
    let mut i = start;
    while i < chars.len() && matches!(chars[i], ' ' | '\u{3000}' | '\t') {
        i += 1;
    }
    let mut j = i;
    if chars.get(j) == Some(&'第') {
        j += 1;
    }
    let (n, after) = take_numeral(chars, j)?;
    if chars.get(after) != Some(&unit) {
        return None;
    }
    if n == 0 || n > 999_999 {
        return None;
    }
    Some((Some(n), after + 1))
}

fn take_numeral(chars: &[char], start: usize) -> Option<(u32, usize)> {
    let mut end = start;
    while end < chars.len() && is_numeral_char(chars[end]) {
        end += 1;
    }
    while end > start {
        let token: String = chars[start..end].iter().collect();
        if let Some(n) = parse_legal_numeral(&token) {
            if n > 0 && n <= 999_999 {
                return Some((n, end));
            }
        }
        end -= 1;
    }
    None
}

fn quote_after(chars: &[char], start: usize, limit: usize) -> Option<String> {
    if start >= chars.len() {
        return None;
    }
    let mut i = start.min(chars.len());
    let limit = limit.min(chars.len());
    if i >= limit {
        return None;
    }
    while i < limit && chars[i].is_whitespace() {
        i += 1;
    }
    const LEADS: &[&str] = &[
        "に規定する",
        "と規定する",
        "が定める",
        "と定める",
        "によると",
        "によれば",
        "について",
        "により",
        "では",
        "には",
        "とは",
        "は",
        "の",
        "に",
        "を",
        "が",
        "と",
        "も",
    ];
    if i >= chars.len() {
        return None;
    }
    let hi = limit.min(i.saturating_add(12)).max(i).min(chars.len());
    let rest: String = chars[i..hi].iter().collect();
    for lead in LEADS {
        if rest.starts_with(lead) {
            i += lead.chars().count();
            break;
        }
    }
    while i < limit && (chars[i].is_whitespace() || matches!(chars[i], '、' | '，' | ',' | '。')) {
        i += 1;
    }
    if chars.get(i) != Some(&'「') {
        return None;
    }
    let mut k = i + 1;
    while k < limit && chars[k] != '」' {
        k += 1;
    }
    if k >= limit || chars.get(k) != Some(&'」') {
        return None;
    }
    Some(chars[i + 1..k].iter().collect())
}

fn quote_nearby(chars: &[char], start: usize, limit: usize) -> bool {
    if start >= chars.len() {
        return false;
    }
    let end = limit.min(start.saturating_add(48)).min(chars.len());
    if start >= end {
        return false;
    }
    let mut depth = 0i32;
    for &c in &chars[start..end] {
        if c == '（' || c == '(' {
            depth += 1;
        } else if (c == '）' || c == ')') && depth > 0 {
            depth -= 1;
        } else if c == '「' && depth == 0 {
            return true;
        }
    }
    false
}

fn closes_paren(chars: &[char], end: usize, limit: usize) -> bool {
    let mut i = end;
    let limit = limit.min(chars.len());
    while i < limit && chars[i].is_whitespace() {
        i += 1;
    }
    matches!(chars.get(i), Some('）' | ')'))
}

fn quote_before(chars: &[char], law_start: usize, prev_end: usize) -> Option<String> {
    let mut i = skip_ws_back(chars, law_start);
    if i == 0 || !matches!(chars[i - 1], '（' | '(') {
        return None;
    }
    i = skip_ws_back(chars, i - 1);
    if i == 0 || chars[i - 1] != '」' {
        return None;
    }
    let quote_end = i - 1;
    let mut j = quote_end;
    while j > prev_end && chars[j - 1] != '「' {
        j -= 1;
    }
    if j == 0 || chars.get(j - 1) != Some(&'「') {
        return None;
    }
    Some(chars[j..quote_end].iter().collect())
}

fn skip_ws_back(chars: &[char], mut i: usize) -> usize {
    while i > 0 && chars[i - 1].is_whitespace() {
        i -= 1;
    }
    i
}

fn schedule_spans(chars: &[char]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 1 < chars.len() {
        if chars[i] == '別' && chars[i + 1] == '表' {
            let mut end = i + 2;
            if chars.get(end) == Some(&'第') {
                end += 1;
            }
            if let Some((_, next)) = take_numeral(chars, end) {
                if next > end && (next - end) <= 4 {
                    end = next;
                }
            }
            out.push((i, end));
            i = end;
            continue;
        }
        i += 1;
    }
    out
}

enum ClauseMiss {
    Paragraph(u32),
    Item(u32),
    Branch(u32, Vec<u32>),
}

struct Block {
    paragraph: u32,
    text: String,
    items: Vec<(u32, Vec<u32>, String)>,
}

fn clause_text(
    body: &str,
    paragraph: Option<u32>,
    item: Option<u32>,
    branches: &[u32],
) -> Result<String, ClauseMiss> {
    if paragraph.is_none() && item.is_none() {
        return Ok(body.to_string());
    }
    let blocks = split_blocks(body);
    let p = paragraph.unwrap_or(1);
    let Some(block) = blocks.iter().find(|block| block.paragraph == p) else {
        return Err(ClauseMiss::Paragraph(p));
    };
    if let Some(n) = item {
        let Some((_, _, text)) = block
            .items
            .iter()
            .find(|it| it.0 == n && it.1 == branches)
        else {
            if !branches.is_empty() {
                return Err(ClauseMiss::Branch(n, branches.to_vec()));
            }
            return Err(ClauseMiss::Item(n));
        };
        return Ok(text.clone());
    }
    Ok(block.text.clone())
}

fn split_blocks(body: &str) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut current: Option<Block> = None;
    for line in body.lines() {
        if let Some((num, rest)) = paragraph_marker(line) {
            if let Some(block) = current.take() {
                if !block.text.trim().is_empty() || !block.items.is_empty() {
                    blocks.push(block);
                }
            }
            current = Some(Block {
                paragraph: num,
                text: rest,
                items: Vec::new(),
            });
            continue;
        }
        if let Some((num, branch, rest)) = item_marker(line) {
            let block = current.get_or_insert_with(|| Block {
                paragraph: 1,
                text: String::new(),
                items: Vec::new(),
            });
            if !block.text.is_empty() && !block.text.ends_with('\n') {
                block.text.push('\n');
            }
            block.text.push_str(&rest);
            block.items.push((num, branch, rest));
            continue;
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let block = current.get_or_insert_with(|| Block {
            paragraph: 1,
            text: String::new(),
            items: Vec::new(),
        });
        if !block.text.is_empty() && !block.text.ends_with('\n') {
            block.text.push('\n');
        }
        block.text.push_str(line);
        if let Some(last) = block.items.last_mut() {
            last.2.push('\n');
            last.2.push_str(line);
        }
    }
    if let Some(block) = current {
        if !block.text.trim().is_empty() || !block.items.is_empty() {
            blocks.push(block);
        }
    }
    blocks
}

fn paragraph_marker(line: &str) -> Option<(u32, String)> {
    let trimmed = line.trim_start();
    let chars: Vec<char> = trimmed.chars().collect();
    let mut i = 0usize;
    while i < chars.len() && is_fw_digit(chars[i]) {
        i += 1;
    }
    if i == 0 || i > 3 {
        return None;
    }
    let token: String = chars[..i].iter().collect();
    let n = parse_legal_numeral(&token)?;
    if n == 0 || n > 999 {
        return None;
    }
    let rest: String = chars[i..].iter().collect();
    let rest = rest.trim_start_matches([' ', '\u{3000}']).to_string();
    if rest.starts_with(['年', '月', '日']) {
        return None;
    }
    Some((n, rest))
}

fn is_fw_digit(c: char) -> bool {
    c.is_ascii_digit() || ('０'..='９').contains(&c)
}

fn item_marker(line: &str) -> Option<(u32, Vec<u32>, String)> {
    let trimmed = line.trim_start();
    let chars: Vec<char> = trimmed.chars().collect();
    let mut i = 0usize;
    while i < chars.len() && is_numeral_char(chars[i]) {
        i += 1;
    }
    if i == 0 {
        return None;
    }
    let token: String = chars[..i].iter().collect();
    if token.chars().all(is_fw_digit) {
        return None;
    }
    let n = parse_legal_numeral(&token)?;
    if n == 0 || n > 999 {
        return None;
    }
    let mut branch = Vec::new();
    let mut k = i;
    while chars.get(k) == Some(&'の') {
        let mut b = k + 1;
        let bstart = b;
        while b < chars.len() && is_numeral_char(chars[b]) {
            b += 1;
        }
        if b == bstart {
            break;
        }
        let btok: String = chars[bstart..b].iter().collect();
        let Some(value) = parse_legal_numeral(&btok) else {
            break;
        };
        branch.push(value);
        k = b;
    }
    if chars.get(k).is_none_or(|c| !c.is_whitespace()) {
        return None;
    }
    let rest: String = chars[k + 1..].iter().collect();
    Some((n, branch, rest.trim().to_string()))
}

fn is_deleted_text(text: &str) -> bool {
    let flat: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    flat == "削除" || flat == "（削除）"
}

pub fn quote_diff(quote: &str, article: &str) -> Option<String> {
    let q = normalize_compare(quote);
    let a = normalize_compare(article);
    if q.is_empty() {
        return None;
    }
    if a.contains(&q) {
        return None;
    }
    let qb: Vec<char> = q.chars().collect();
    let ab: Vec<char> = a.chars().collect();
    let mut prefix = 0usize;
    while prefix < qb.len() && prefix < ab.len() && qb[prefix] == ab[prefix] {
        prefix += 1;
    }
    let mut suffix = 0usize;
    while suffix < qb.len() - prefix
        && suffix < ab.len() - prefix
        && qb[qb.len() - 1 - suffix] == ab[ab.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let qdiff: String = qb[prefix..qb.len() - suffix].iter().collect();
    let adiff: String = ab[prefix..ab.len() - suffix].iter().collect();
    Some(format!(
        "引用「{}」／条文「{}」",
        clip(&qdiff, 40),
        clip(&adiff, 40)
    ))
}

fn clip(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        return text.to_string();
    }
    let mut out: String = chars[..max].iter().collect();
    out.push('…');
    out
}

fn normalize_compare(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| match c {
            '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
            _ => c,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::statute::catalog;
    use crate::statute::egov::OfflineEgov;
    use crate::statute::xmlparse::ParsedArticle;

    fn db() -> StatuteDb {
        StatuteDb::open_memory().unwrap()
    }

    fn article(key: &str, num: &str, body: &str) -> ParsedArticle {
        ParsedArticle {
            key: key.into(),
            num: num.into(),
            heading: String::new(),
            body: body.into(),
            suppl: false,
        }
    }

    const BODY_415: &str = "\
債務者がその債務の本旨に従った履行をしないとき又は債務の履行が不能であるときは、債権者は、これによって生じた損害の賠償を請求することができる。
２前項の規定により損害賠償の請求をすることができる場合において、債権者は、次に掲げるときは、債務の履行に代わる損害賠償の請求をすることができる。
一　債務の履行が不能であるとき。
二　債務者がその債務の履行を拒絶する意思を明確に表示したとき。";

    fn seed(db: &StatuteDb) {
        db.replace_law(
            "129AC0000000089",
            "民法",
            "明治二十九年法律第八十九号",
            "2026-11-11",
            "2026-11-11",
            "bundle",
            &["民法".into()],
            &[
                article("415", "第415条", BODY_415),
                article("3_2", "第3条の2", "法律行為の当事者が意思表示をした時に意思能力を有しなかったときは、その法律行為は、無効とする。"),
            ],
        )
        .unwrap();
        db.replace_law(
            "408AC0000000109",
            "民事訴訟法",
            "",
            "2026-11-11",
            "2026-11-11",
            "bundle",
            &["民事訴訟法".into(), "民訴法".into()],
            &[article("1", "第1条", "民事訴訟については、他の法令に定めるもののほか、この法律の定めるところによる。")],
        )
        .unwrap();
    }

    fn statuses(text: &str) -> Vec<CheckHit> {
        let db = db();
        seed(&db);
        check_text(&db, &OfflineEgov, text, "2026-11-13", false)
    }

    #[test]
    fn catalog_lists_the_short_names() {
        assert!(catalog::aliases_for("408AC0000000109").contains(&"民訴法"));
        assert!(catalog::aliases_for("322AC0000000049").contains(&"労基法"));
        assert!(catalog::aliases_for("322AC0000000054").contains(&"独禁法"));
    }

    #[test]
    fn abbreviations_douhou_branch_kanji_and_fullwidth_numbers() {
        let hits = statuses("民訴法第1条により訴える。同法第2条は別である。民法第3条の2。");
        assert_eq!(hits.len(), 3, "{hits:?}");
        assert_eq!(hits[0].label, "一致");
        assert!(hits[0].citation.contains("民訴法"));
        assert_eq!(hits[1].label, "要確認", "{hits:?}");
        assert!(hits[1].citation.starts_with("民事訴訟法"), "{hits:?}");
        assert_eq!(hits[1].reason, "未取得（オフライン）");
        assert_eq!(hits[2].label, "一致", "{hits:?}");
        assert!(hits[2].offline_note.contains("オフライン"), "{hits:?}");

        let kanji = statuses("民法第四百十五条第一項");
        assert_eq!(kanji.len(), 1, "{kanji:?}");
        assert_eq!(kanji[0].label, "一致", "{kanji:?}");

        let wide = statuses("民法第４１５条第２項第１号");
        assert_eq!(wide.len(), 1, "{wide:?}");
        assert_eq!(wide[0].label, "一致", "{wide:?}");
        assert!(wide[0].citation.contains("第２項") || wide[0].citation.contains("第2項"), "{wide:?}");
    }

    #[test]
    fn quoted_text_ignores_width_and_shows_only_the_difference() {
        let same = statuses(
            "民法第415条第1項は「債務者がその債務の本旨に従った履行をしないとき又は債務の履行が不能であるときは、債権者は、これによって生じた損害の賠償を請求することができる。」と定める。",
        );
        assert_eq!(same[0].label, "一致", "{same:?}");
        assert!(same[0].diff.is_empty(), "{same:?}");

        let wide = statuses("民法第415条第1項「債権者は、これによって生じた損害の賠償を請求することができる。」");
        assert_eq!(wide[0].label, "一致", "{wide:?}");

        let spaced = statuses(
            "民法第415条第1項「債権者は、 これによって生じた損害の賠償を請求することができる。」",
        );
        assert_eq!(spaced[0].label, "一致", "{spaced:?}");

        let wrong = statuses(
            "民法第415条第1項「債務者がその債務の本旨に従った履行をしないとき又は債務の履行が不能であるときは、債務者は、これによって生じた損害の賠償を請求することができる。」",
        );
        assert_eq!(wrong[0].label, "要確認", "{wrong:?}");
        assert_eq!(wrong[0].reason, "引用と条文が違います。");
        assert!(
            wrong[0].diff.contains("務") && wrong[0].diff.contains("権"),
            "{wrong:?}"
        );
        assert!(
            !wrong[0].diff.contains("本旨"),
            "the shared wording stays out of the diff: {}",
            wrong[0].diff
        );

        let missing_item = statuses("民法第415条第2項第9号");
        assert_eq!(missing_item[0].label, "要確認", "{missing_item:?}");
        assert!(missing_item[0].reason.contains("第9号"), "{missing_item:?}");
        assert!(missing_item[0].reason.contains("未確認"), "{missing_item:?}");
    }

    #[test]
    fn supplements_and_schedules_are_never_a_match() {
        let hits = statuses("民法附則第1条を適用する。民法別表第一のとおり。");
        assert!(hits.len() >= 2, "{hits:?}");
        assert!(
            hits.iter().all(|hit| hit.label == "要確認"),
            "{hits:?}"
        );
        assert!(hits.iter().any(|hit| hit.reason.contains("附則")), "{hits:?}");
        assert!(hits.iter().any(|hit| hit.reason.contains("別表")), "{hits:?}");
        assert!(hits.iter().all(|hit| hit.label != "一致"));
    }

    #[test]
    fn offline_uses_the_saved_text_and_says_so() {
        let hits = statuses("民法第415条");
        assert_eq!(hits[0].label, "一致");
        assert_eq!(hits[0].offline_note, OFFLINE_NOTE);
        assert_eq!(hits[0].source, SOURCE_LABEL);
        assert_eq!(hits[0].as_of, "2026-11-11");
        assert!(hits[0].article_text.contains("債権者"));
    }

    #[test]
    fn a_paren_quote_before_the_citation_is_compared() {
        let hits = statuses(
            "「債務の履行が不能であるとき」（民法第415条第2項第1号）とある。",
        );
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert_eq!(hits[0].label, "一致", "{hits:?}");
    }

    #[test]
    fn deleted_articles_are_not_a_match() {
        let db = db();
        db.replace_law(
            "129AC0000000089",
            "民法",
            "",
            "2026-11-11",
            "2026-11-11",
            "bundle",
            &["民法".into()],
            &[article("208", "第208条", "削除"), article("1", "第1条", "私権は、公共の福祉に適合しなければならない。")],
        )
        .unwrap();
        let hits = check_text(&db, &OfflineEgov, "民法第208条。民法第1条。", "2026-11-13", false);
        assert_eq!(hits[0].label, "要確認", "{hits:?}");
        assert_eq!(hits[0].reason, "削除された条です");
        assert_eq!(hits[1].label, "一致", "{hits:?}");
    }

    #[test]
    fn suffixes_and_historical_names_are_not_the_current_act() {
        let hits = statuses("旧民法第1条。改正前民法第1条。損害保険法第1条。");
        assert!(hits.len() >= 3, "{hits:?}");
        assert!(hits.iter().all(|hit| hit.label == "要確認"), "{hits:?}");
        assert!(hits.iter().all(|hit| hit.label != "一致"));
        assert!(hits[0].reason.contains("現行"), "{hits:?}");
    }

    #[test]
    fn unknown_law_names_are_rows_and_real_laws_are_not_denied() {
        let unknown = statuses("労働安全衛生規則第1条。");
        assert_eq!(unknown.len(), 1, "{unknown:?}");
        assert_eq!(unknown[0].label, "要確認");
        assert!(unknown[0].reason.contains("特定できません"), "{unknown:?}");
        for name in ["労働組合法", "小切手法", "行手法", "取適法", "医療法"] {
            let hits = statuses(&format!("{name}第1条"));
            assert_eq!(hits.len(), 1, "{name} {hits:?}");
            assert_ne!(hits[0].label, "一致");
            assert!(hits[0].citation.contains(name), "{name} {hits:?}");
        }
    }

    #[test]
    fn douhou_follows_the_latest_mentioned_law() {
        let db = db();
        seed(&db);
        db.replace_law(
            "417AC0000000086",
            "会社法",
            "",
            "2026-11-11",
            "2026-11-11",
            "bundle",
            &["会社法".into()],
            &[article("2", "第2条", "会社は、法人とする。")],
        )
        .unwrap();
        let hits = check_text(
            &db,
            &OfflineEgov,
            "民法第1条。会社法は重要である。同法第2条",
            "2026-11-13",
            false,
        );
        assert_eq!(hits.len(), 2, "{hits:?}");
        assert!(hits[1].citation.starts_with("会社法"), "{hits:?}");
        assert_eq!(hits[1].label, "一致", "{hits:?}");
    }

    #[test]
    fn enumerations_keep_every_article() {
        let db = db();
        seed(&db);
        db.replace_law(
            "129AC0000000089",
            "民法",
            "",
            "2026-11-11",
            "2026-11-11",
            "bundle",
            &["民法".into()],
            &[
                article("709", "第709条", "故意又は過失によって他人の権利又は法律上保護される利益を侵害した者は、これによって生じた損害を賠償する責任を負う。"),
                article("710", "第710条", "他人の身体、自由若しくは名誉を侵害した場合又は他人の財産権を侵害した場合のいずれであるかを問わず、財産以外の損害に対しても、その賠償をしなければならない。"),
            ],
        )
        .unwrap();
        for sample in ["民法第709条又は第9999条", "民法第709条、第710条", "民法第709条及び第710条"] {
            let hits = check_text(&db, &OfflineEgov, sample, "2026-11-13", false);
            assert_eq!(hits.len(), 2, "{sample} {hits:?}");
            assert!(hits.iter().all(|hit| hit.citation.contains("民法") || hit.citation.contains('第')), "{sample} {hits:?}");
        }
        let or = check_text(&db, &OfflineEgov, "民法第709条又は第9999条", "2026-11-13", false);
        assert_eq!(or[0].label, "一致", "{or:?}");
        assert_eq!(or[1].label, "要確認", "{or:?}");
        assert_eq!(or[1].reason, "未取得（オフライン）");
    }

    #[test]
    fn large_paragraphs_and_item_branches_are_not_dropped() {
        let hits = statuses("民法第415条第100項。民法第415条第2項第1号の2。");
        assert_eq!(hits.len(), 2, "{hits:?}");
        assert!(hits[0].citation.contains("100") || hits[0].citation.contains("第100項"), "{hits:?}");
        assert_eq!(hits[0].label, "要確認", "{hits:?}");
        assert!(hits[0].reason.contains("未確認"), "{hits:?}");
        assert!(hits[1].citation.contains("号の2") || hits[1].citation.contains("の2"), "{hits:?}");
        assert_ne!(hits[1].label, "一致", "{hits:?}");
    }

    #[test]
    fn a_nearby_quote_that_is_not_tied_to_the_citation_is_not_a_match() {
        let loose = statuses("民法第415条第1項によると「債権者は、これによって生じた損害の賠償を請求することができる。」");
        assert_eq!(loose[0].label, "一致", "{loose:?}");
        let missed = statuses("民法第415条第1項。別の文「これは条文ではない。」");
        assert_eq!(missed[0].label, "要確認", "{missed:?}");
        assert!(missed[0].reason.contains("引用"), "{missed:?}");
    }

    #[test]
    fn offline_partial_cache_is_not_a_wrong_number() {
        let db = db();
        db.replace_law(
            "999AC0000000001",
            "架空法",
            "",
            "2026-11-11",
            "2026-11-11",
            "egov",
            &["架空法".into()],
            &[article("1", "第1条", "本文がある。")],
        )
        .unwrap();
        let hits = check_text(&db, &OfflineEgov, "架空法第9条", "2026-11-13", false);
        assert_eq!(hits[0].label, "要確認", "{hits:?}");
        assert_eq!(hits[0].reason, "未取得（オフライン）");
    }

    #[test]
    fn online_fetches_stop_after_the_cap() {
        let db = db();
        db.replace_law(
            "999AC0000000001",
            "架空法",
            "",
            "",
            "",
            "egov",
            &["架空法".into()],
            &[article("1", "第1条", "ある。")],
        )
        .unwrap();
        let hits = check_text_opts(
            &db,
            &OfflineEgov,
            "架空法第2条。架空法第3条。",
            "2026-11-13",
            true,
            0,
            0,
            MAX_PROBES,
        );
        assert!(hits.iter().all(|hit| hit.reason.contains("件数が多い")), "{hits:?}");
    }

    #[test]
    fn odd_citations_do_not_panic() {
        for sample in [
            "民法第709条第710条第1項",
            "第1条",
            "民法第415条第1項第2号の3の4の5",
            "「」民法第",
            "第条",
            "民法第0条",
            "同法第",
            "民法第709条「",
            "）民法第415条（",
            "",
            "第1条第2条第3条第4項第5号の2の99",
            "民法第709条。さらに第9999条",
        ] {
            let hits = statuses(sample);
            assert!(hits.len() < 20, "{sample} {hits:?}");
        }
    }

    #[test]
    fn bare_articles_inherit_only_inside_an_enumeration() {
        let db = db();
        seed(&db);
        db.replace_law(
            "129AC0000000089",
            "民法",
            "",
            "2026-11-11",
            "2026-11-11",
            "bundle",
            &["民法".into()],
            &[
                article("415", "第415条", BODY_415),
                article("1", "第1条", "私権は、公共の福祉に適合しなければならない。"),
                article("709", "第709条", "不法行為の本文。"),
                article("710", "第710条", "財産以外の損害。"),
            ],
        )
        .unwrap();
        let sentence = check_text(
            &db,
            &OfflineEgov,
            "民法第415条に基づき請求する。第1条の目的は契約の目的である。",
            "2026-11-13",
            false,
        );
        assert_eq!(sentence.len(), 1, "{sentence:?}");
        assert!(sentence[0].citation.contains("415"), "{sentence:?}");

        let both = check_text(&db, &OfflineEgov, "民法第709条及び第710条", "2026-11-13", false);
        assert_eq!(both.len(), 2, "{both:?}");
        assert!(both.iter().all(|hit| hit.citation.contains("民法")), "{both:?}");
        assert!(both.iter().all(|hit| hit.label == "一致"), "{both:?}");

        let further = check_text(
            &db,
            &OfflineEgov,
            "民法第709条。さらに第9999条",
            "2026-11-13",
            false,
        );
        assert_eq!(further.len(), 1, "{further:?}");
        assert!(further[0].citation.contains("709"), "{further:?}");

        let dou = check_text(&db, &OfflineEgov, "民法第709条を適用する。同法第1条。", "2026-11-13", false);
        assert_eq!(dou.len(), 2, "{dou:?}");
        assert!(dou[1].citation.starts_with("民法"), "{dou:?}");
        assert!(dou[1].citation.contains("第1条"), "{dou:?}");
        assert_eq!(dou[1].label, "一致", "{dou:?}");

        let kept = check_text(
            &db,
            &OfflineEgov,
            "民法第709条。さらに第1条。同法第710条。",
            "2026-11-13",
            false,
        );
        assert_eq!(kept.len(), 2, "{kept:?}");
        assert!(kept[1].citation.contains("710"), "{kept:?}");
        assert!(kept.iter().all(|hit| !hit.citation.contains("第1条") || hit.citation.contains("710")), "{kept:?}");
    }

    #[test]
    fn deleted_items_and_paragraphs_are_not_a_match() {
        let parsed = crate::statute::xmlparse::parse_law_xml(include_str!(
            "fixtures/deleted_clause.xml"
        ))
        .unwrap();
        let body_331 = parsed
            .articles
            .iter()
            .find(|article| article.key == "331")
            .unwrap();
        let body_2 = parsed.articles.iter().find(|article| article.key == "2").unwrap();
        let body_9 = parsed.articles.iter().find(|article| article.key == "9").unwrap();
        assert!(body_331.body.contains("二\u{3000}削除"), "{}", body_331.body);
        assert!(body_2.body.contains("一\u{3000}削除"), "{}", body_2.body);
        assert!(body_9.body.contains("削除"), "{}", body_9.body);
        let db = db();
        let company = [body_331.clone(), body_9.clone()];
        db.replace_law(
            "417AC0000000086",
            "会社法",
            "",
            "2026-11-11",
            "2026-11-11",
            "bundle",
            &["会社法".into()],
            &company,
        )
        .unwrap();
        let criminal = [body_2.clone()];
        db.replace_law(
            "140AC0000000045",
            "刑法",
            "",
            "2026-11-11",
            "2026-11-11",
            "bundle",
            &["刑法".into()],
            &criminal,
        )
        .unwrap();
        let hits = check_text(
            &db,
            &OfflineEgov,
            "会社法第331条第1項第1号。会社法第331条第1項第2号。会社法第9条第2項。刑法第2条第1号。",
            "2026-11-13",
            false,
        );
        assert_eq!(hits.len(), 4, "{hits:?}");
        assert_eq!(hits[0].label, "一致", "{hits:?}");
        assert!(hits[1..].iter().all(|hit| hit.label == "要確認"), "{hits:?}");
        assert!(
            hits[1..].iter().all(|hit| hit.reason.contains("削除")),
            "{hits:?}"
        );
        assert!(hits[1..].iter().all(|hit| hit.label != "一致"));
    }

    #[test]
    fn every_no_branch_is_its_own_number() {
        let db = db();
        db.replace_law(
            "129AC0000000089",
            "民法",
            "",
            "2026-11-11",
            "2026-11-11",
            "bundle",
            &["民法".into()],
            &[
                article("3_2", "第3条の2", "親の本文。"),
                article("3_2_3", "第3条の2の3", "二重枝番の本文。"),
                article(
                    "10",
                    "第10条",
                    "三　親\n三の二　途中\n三の二の九十九　末尾の本文。",
                ),
            ],
        )
        .unwrap();
        let hits = check_text(
            &db,
            &OfflineEgov,
            "民法第3条の2の3。民法第10条第3号の2の99。民法第10条第3号の2の100。",
            "2026-11-13",
            false,
        );
        assert_eq!(hits.len(), 3, "{hits:?}");
        assert_eq!(hits[0].label, "一致", "{hits:?}");
        assert!(hits[0].article_text.contains("二重枝番"), "{hits:?}");
        assert!(!hits[0].article_text.contains("親の本文"), "{hits:?}");
        assert_eq!(hits[1].label, "一致", "{hits:?}");
        assert!(hits[1].article_text.contains("末尾"), "{hits:?}");
        assert_eq!(hits[2].label, "要確認", "{hits:?}");
        assert!(hits[2].reason.contains("未確認"), "{hits:?}");
        assert!(!hits[2].reason.contains("親"), "{hits:?}");
    }

    #[test]
    fn a_particle_before_the_law_name_still_resolves() {
        let hits = statuses("について民法第415条。契約による民法第3条の2。");
        assert_eq!(hits.len(), 2, "{hits:?}");
        assert!(hits.iter().all(|hit| hit.label == "一致"), "{hits:?}");
        assert!(hits.iter().all(|hit| hit.citation.contains("民法")), "{hits:?}");
    }

    #[test]
    fn cached_hits_do_not_spend_the_online_budget() {
        let db = db();
        seed(&db);
        let started = std::time::Instant::now();
        let hits = check_text_opts(
            &db,
            &OfflineEgov,
            "民法第415条。民法第3条の2。民訴法第1条。",
            "2026-11-13",
            true,
            0,
            0,
            MAX_PROBES,
        );
        assert!(started.elapsed().as_millis() < 1000, "cached check slept");
        assert_eq!(hits.len(), 3, "{hits:?}");
        assert!(hits.iter().all(|hit| hit.label == "一致"), "{hits:?}");
    }

    struct CancelReset;
    impl Drop for CancelReset {
        fn drop(&mut self) {
            set_check_cancel(None);
        }
    }

    #[test]
    fn abort_stops_before_the_next_fetch() {
        let db = db();
        seed(&db);
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        set_check_cancel(Some(flag));
        let _reset = CancelReset;
        let hits = check_text(&db, &OfflineEgov, "民法第9999条", "2026-11-13", true);
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert_eq!(hits[0].label, "要確認", "{hits:?}");
        assert_eq!(hits[0].reason, "照合を中止しました。");
    }

    #[test]
    fn an_online_miss_for_a_bundled_law_is_a_wrong_number() {
        let db = db();
        seed(&db);
        let client = crate::statute::egov::MapEgov::new(vec![(
            String::new(),
            Err(crate::statute::egov::EgovFailure::NotFound),
        )]);
        let hits = check_text(&db, &client, "民法第9999条", "2026-11-13", true);
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert_eq!(hits[0].label, "番号違い", "{hits:?}");
        assert_eq!(hits[0].reason, "その条はありません。");
    }

    fn minpo(db: &StatuteDb, articles: &[crate::statute::xmlparse::ParsedArticle]) {
        db.replace_law(
            "129AC0000000089",
            "民法",
            "明治二十九年法律第八十九号",
            "2020-01-01",
            "2020-01-01",
            "bundle",
            &["民法".into()],
            articles,
        )
        .unwrap();
    }

    fn article_xml(num: &str, body: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<DataRoot><Result><Code>0</Code></Result><ApplData>
<LawFullText><Law><LawBody><MainProvision>
<Article Num="{num}"><ArticleTitle>第{num}条</ArticleTitle>
<Paragraph><ParagraphSentence><Sentence>{body}</Sentence></ParagraphSentence></Paragraph>
</Article>
</MainProvision></LawBody></Law></LawFullText></ApplData></DataRoot>"#
        )
    }

    #[test]
    fn a_cached_row_is_checked_against_the_current_text() {
        let db = db();
        minpo(&db, &[article("555", "第555条", "古い本文")]);
        let client = crate::statute::egov::MapEgov::new(vec![(
            "articles;".into(),
            Ok(article_xml("555", "新しい本文")),
        )]);
        let started = std::time::Instant::now();
        let hits = check_text_opts(
            &db,
            &client,
            "民法第555条「古い本文」",
            "2026-11-13",
            true,
            0,
            0,
            MAX_PROBES,
        );
        assert!(started.elapsed().as_millis() < 1000, "a cached probe slept on the budget");
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert!(hits[0].article_text.contains("新しい本文"), "{hits:?}");
        assert!(
            hits[0].label != "一致" || !hits[0].offline_note.is_empty(),
            "stale text must not be a silent match: {hits:?}"
        );
        assert_ne!(hits[0].label, "一致", "{hits:?}");

        let chat_db = StatuteDb::open_memory().unwrap();
        minpo(&chat_db, &[article("555", "第555条", "古い本文")]);
        let chat = crate::statute::resolve_without_refresh(
            &chat_db,
            &client,
            &[crate::statute::ArticleQuery {
                law: "民法".into(),
                article: "第555条".into(),
            }],
            "2026-11-13",
        );
        assert!(chat[0].verified, "{:?}", chat[0].note);
        assert!(chat[0].body.contains("新しい本文"), "{:?}", chat[0].body);
        assert_eq!(
            hits[0].article_text.contains("新しい本文"),
            chat[0].body.contains("新しい本文")
        );

        let capped_db = StatuteDb::open_memory().unwrap();
        minpo(&capped_db, &[article("555", "第555条", "古い本文")]);
        let capped = check_text_opts(
            &capped_db,
            &client,
            "民法第555条「古い本文」",
            "2026-11-13",
            true,
            0,
            0,
            0,
        );
        assert!(capped[0].article_text.contains("古い本文"), "{capped:?}");
        assert!(capped[0].offline_note.contains("改正確認"), "{capped:?}");
        assert!(
            !(capped[0].label == "一致" && capped[0].offline_note.is_empty()),
            "{capped:?}"
        );

        let burst_db = StatuteDb::open_memory().unwrap();
        minpo(&burst_db, &[article("555", "第555条", "古い本文")]);
        let fail = crate::statute::egov::MapEgov::new(vec![(
            "articles;".into(),
            Err(crate::statute::egov::EgovFailure::Bad(
                "法令APIが応答しませんでした（HTTP 500）".into(),
            )),
        )]);
        let first = check_text(&burst_db, &fail, "民法第555条", "2026-11-13", true);
        assert!(first[0].article_text.contains("古い本文"), "{first:?}");
        assert!(first[0].offline_note.contains("改正確認"), "{first:?}");
        let second = check_text(&burst_db, &client, "民法第555条", "2026-11-13", true);
        assert!(second[0].article_text.contains("古い本文"), "{second:?}");
        assert!(second[0].offline_note.contains("改正確認"), "{second:?}");
    }

    #[test]
    fn a_parenthesised_heading_does_not_break_an_enumeration() {
        let db = db();
        minpo(
            &db,
            &[
                article("709", "第709条", "不法行為の本文。"),
                article("710", "第710条", "財産以外の損害。"),
            ],
        );
        let hits = check_text(
            &db,
            &OfflineEgov,
            "民法第709条（不法行為）及び第710条（財産以外の損害）",
            "2026-11-13",
            false,
        );
        assert_eq!(hits.len(), 2, "{hits:?}");
        assert!(hits.iter().all(|hit| hit.label == "一致"), "{hits:?}");
        let though = check_text(
            &db,
            &OfflineEgov,
            "民法第709条、ただし第710条",
            "2026-11-13",
            false,
        );
        assert_eq!(though.len(), 1, "{though:?}");
        assert!(though[0].citation.contains("709"), "{though:?}");
    }

    #[test]
    fn a_law_name_need_not_sit_flush_against_the_article() {
        let db = db();
        minpo(
            &db,
            &[
                article("709", "第709条", "不法行為の本文。"),
                article("90", "第90条", "公序良俗の本文。"),
            ],
        );
        let only = check_text(&db, &OfflineEgov, "民法の第709条", "2026-11-13", false);
        assert_eq!(only.len(), 1, "{only:?}");
        assert_eq!(only[0].label, "一致", "{only:?}");
        assert!(only[0].citation.contains("民法"), "{only:?}");
        let dou = check_text(
            &db,
            &OfflineEgov,
            "民法第709条を準用する。同法の第90条。",
            "2026-11-13",
            false,
        );
        assert_eq!(dou.len(), 2, "{dou:?}");
        assert!(dou[1].citation.starts_with("民法"), "{dou:?}");
        assert!(dou[1].citation.contains("90"), "{dou:?}");
        let promulgated = check_text(
            &db,
            &OfflineEgov,
            "民法（明治二十九年法律第八十九号）第709条",
            "2026-11-13",
            false,
        );
        assert_eq!(promulgated.len(), 1, "{promulgated:?}");
        assert_eq!(promulgated[0].label, "一致", "{promulgated:?}");
        assert!(promulgated[0].citation.contains("民法"), "{promulgated:?}");
    }

    #[test]
    fn an_http_error_is_not_a_wrong_number() {
        let db = db();
        minpo(&db, &[article("1", "第1条", "前文です。")]);
        let refused = crate::statute::egov::MapEgov::new(vec![(
            String::new(),
            Err(crate::statute::egov::EgovFailure::Bad(
                "法令APIが応答しませんでした（HTTP 500）".into(),
            )),
        )]);
        let http = check_text(&db, &refused, "民法第9999条", "2026-11-13", true);
        assert_eq!(http.len(), 1, "{http:?}");
        assert_eq!(http[0].label, "要確認", "{http:?}");
        assert_ne!(http[0].label, "番号違い");
        assert!(http[0].reason.contains("HTTP 500"), "{http:?}");

        let garbled = crate::statute::egov::MapEgov::new(vec![(
            String::new(),
            Ok("<html>not law xml</html>".into()),
        )]);
        let bad_xml = check_text(&db, &garbled, "民法第9999条", "2026-11-13", true);
        assert_eq!(bad_xml[0].label, "要確認", "{bad_xml:?}");
        assert_ne!(bad_xml[0].label, "番号違い");
        assert!(bad_xml[0].reason.contains("取得できません"), "{bad_xml:?}");

        let timeout = check_text(&db, &OfflineEgov, "民法第9999条", "2026-11-13", true);
        assert_eq!(timeout[0].label, "要確認", "{timeout:?}");
        assert_ne!(timeout[0].label, "番号違い");
        assert!(
            timeout[0].reason.contains("取得できません") || timeout[0].reason.contains("オフライン"),
            "{timeout:?}"
        );
    }

    #[test]
    fn a_joiner_between_two_named_citations_keeps_each_law() {
        let db = db();
        minpo(
            &db,
            &[
                article("1", "第1条", "前文です。"),
                article("2", "第2条", "第二条です。"),
                article("709", "第709条", "不法行為の本文。"),
                article("710", "第710条", "財産以外の損害。"),
            ],
        );
        db.replace_law(
            "417AC0000000086",
            "会社法",
            "",
            "2020-01-01",
            "2020-01-01",
            "bundle",
            &["会社法".into()],
            &[article("2", "第2条", "会社の第二条。")],
        )
        .unwrap();
        let same = check_text(&db, &OfflineEgov, "民法第1条及び民法第2条", "2026-11-13", false);
        assert_eq!(same.len(), 2, "{same:?}");
        assert!(same.iter().all(|hit| hit.label == "一致"), "{same:?}");
        assert!(same.iter().all(|hit| hit.citation.contains("民法")), "{same:?}");
        let other = check_text(
            &db,
            &OfflineEgov,
            "民法第709条及び会社法第2条",
            "2026-11-13",
            false,
        );
        assert_eq!(other.len(), 2, "{other:?}");
        assert!(other[0].citation.contains("民法"), "{other:?}");
        assert!(other[1].citation.contains("会社法"), "{other:?}");
        assert_eq!(other[1].label, "一致", "{other:?}");
        let dou = check_text(
            &db,
            &OfflineEgov,
            "民法第709条、同法第710条",
            "2026-11-13",
            false,
        );
        assert_eq!(dou.len(), 2, "{dou:?}");
        assert!(dou[1].citation.starts_with("民法"), "{dou:?}");
        assert_eq!(dou[1].label, "一致", "{dou:?}");
        let anchor = check_text(
            &db,
            &OfflineEgov,
            "民法第709条並びに会社法第2条",
            "2026-11-13",
            false,
        );
        assert_eq!(anchor.len(), 2, "{anchor:?}");
        assert!(!anchor[1].anchor.contains("並びに"), "{anchor:?}");
        assert!(!anchor[1].anchor.contains("条並"), "{anchor:?}");
    }

    #[test]
    fn a_lead_in_before_the_law_name_is_not_part_of_the_name() {
        let hits = statuses("として民法第415条。なお民法第3条の2。前記民法第415条。上記民法第415条。同じく民法第415条。及び民法第415条。");
        assert!(hits.len() >= 6, "{hits:?}");
        assert!(hits.iter().all(|hit| hit.label == "一致"), "{hits:?}");
        assert!(hits.iter().all(|hit| hit.citation.contains("民法")), "{hits:?}");
        let longer = statuses("特別法第1条。施行法第1条。整備法第1条。損害保険法第1条。");
        assert!(longer.len() >= 4, "{longer:?}");
        assert!(longer.iter().all(|hit| hit.label != "一致"), "{longer:?}");
        assert!(longer.iter().all(|hit| !hit.citation.starts_with("民法")), "{longer:?}");
    }

    #[test]
    fn a_quote_that_contains_another_citation_does_not_verify_the_inner_one() {
        let db = db();
        minpo(
            &db,
            &[
                article("1", "第1条", "前文です。"),
                article("90", "第90条", "後文です。"),
            ],
        );
        let hits = check_text(
            &db,
            &OfflineEgov,
            "民法第1条「前文です。民法第90条後文です。」",
            "2026-11-13",
            false,
        );
        assert_eq!(hits.len(), 2, "{hits:?}");
        assert_ne!(hits[1].label, "一致", "{hits:?}");
        assert_eq!(hits[1].label, "要確認", "{hits:?}");
        assert!(hits[1].reason.contains("引用"), "{hits:?}");
    }

    #[test]
    fn glue_cases_match_the_shared_table() {
        #[derive(serde::Deserialize)]
        struct GlueCase {
            id: String,
            text: String,
            rows: Vec<GlueRow>,
        }
        #[derive(serde::Deserialize)]
        struct GlueRow {
            law: String,
            key: String,
            label: Option<String>,
            #[serde(rename = "reasonHas")]
            reason_has: Option<String>,
        }
        let cases: Vec<GlueCase> =
            serde_json::from_str(include_str!("../../../src/shared/statuteGlueCases.json")).unwrap();
        let db = db();
        minpo(
            &db,
            &[
                article("1", "第1条", "第一条の本文。"),
                article("2", "第2条", "第二条の本文。"),
                article("5", "第5条", "第五条の本文。"),
                article("8", "第8条", "第八条の本文。"),
                article("20", "第20条", "第二十条の本文。"),
                article("90", "第90条", "第九十条の本文。"),
                article("709", "第709条", "不法行為の本文。"),
                article("710", "第710条", "財産以外の損害。"),
            ],
        );
        db.replace_law(
            "417AC0000000086",
            "会社法",
            "平成十七年法律第八十六号",
            "2020-01-01",
            "2020-01-01",
            "bundle",
            &["会社法".into()],
            &[article("2", "第2条", "会社の第二条。")],
        )
        .unwrap();
        for case in cases {
            let hits = check_text(&db, &OfflineEgov, &case.text, "2026-11-13", false);
            assert_eq!(hits.len(), case.rows.len(), "{} {hits:?}", case.id);
            for (hit, row) in hits.iter().zip(case.rows.iter()) {
                assert!(
                    hit.citation.contains(&row.law),
                    "{} {:?} {hit:?}",
                    case.id,
                    row.law
                );
                assert!(
                    hit.citation.contains(&format!("第{}条", row.key))
                        || hit.citation.contains(&row.key),
                    "{} key {} {hit:?}",
                    case.id,
                    row.key
                );
                if let Some(label) = &row.label {
                    assert_eq!(&hit.label, label, "{} {hit:?}", case.id);
                }
                if let Some(reason) = &row.reason_has {
                    assert!(hit.reason.contains(reason), "{} {hit:?}", case.id);
                }
            }
        }
    }
}
