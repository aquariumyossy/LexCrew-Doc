//! Document citation check: law, article, 項, 号, and a 「」 quote.
//!
//! The button path is deterministic. It never calls an LLM. Online calls, when
//! enabled, go through `resolve_without_refresh` and send only a law id and an
//! article number.

use serde::Serialize;

use crate::statute::cite::ToolArticle;
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
    item_branch: Option<u32>,
    clause_unread: bool,
    quote: Option<String>,
    quote_unread: bool,
    suppl: bool,
    schedule: bool,
    anchor: String,
    citation: String,
}

const MAX_ONLINE: usize = 50;
const ONLINE_GAP_MS: u64 = 350;

pub fn check_text(
    db: &StatuteDb,
    client: &dyn EgovSource,
    text: &str,
    today: &str,
    online: bool,
) -> Vec<CheckHit> {
    check_text_opts(db, client, text, today, online, MAX_ONLINE, ONLINE_GAP_MS)
}

pub fn check_text_opts(
    db: &StatuteDb,
    client: &dyn EgovSource,
    text: &str,
    today: &str,
    online: bool,
    max_online: usize,
    delay_ms: u64,
) -> Vec<CheckHit> {
    let raws = scan(db, text);
    if raws.is_empty() {
        return Vec::new();
    }
    let budget = OnlineBudget {
        max: max_online,
        delay_ms,
        used: std::cell::Cell::new(0usize),
    };
    let guarded = LocalNames { inner: client };
    let mut out = Vec::new();
    for raw in raws {
        let occurrence = literal_occurrence(text, &raw.anchor, raw.start);
        out.push(judge(db, &guarded, raw, today, online, &budget, occurrence));
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
    if anchor.is_empty() {
        return 0;
    }
    let chars: Vec<char> = text.chars().collect();
    let needle: Vec<char> = anchor.chars().collect();
    if needle.is_empty() {
        return 0;
    }
    let mut count = 0usize;
    let mut i = 0usize;
    let limit = start_char.min(chars.len());
    while i + needle.len() <= limit {
        if chars[i..i + needle.len()] == needle[..] {
            count += 1;
            i += needle.len();
        } else {
            i += 1;
        }
    }
    count
}

fn judge(
    db: &StatuteDb,
    client: &dyn EgovSource,
    raw: Raw,
    today: &str,
    online: bool,
    budget: &OnlineBudget,
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
    if local.as_ref().is_some_and(|row| is_deleted_body(&row.body)) {
        hit.reason = "削除された条です".into();
        return hit;
    }
    if local.is_none() && law.source == "bundle" {
        return number_miss(hit, "その条はありません。");
    }
    if local.is_none() && !online {
        hit.reason = "未取得（オフライン）".into();
        return hit;
    }
    let fetched = if online {
        if !budget.allow() {
            hit.reason = "件数が多いため未確認".into();
            return hit;
        }
        let guarded = LocalNames { inner: client };
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
    } else {
        local.map(|row| ToolArticle {
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
        })
    };
    let Some(article) = fetched else {
        hit.reason = "条文を確認できませんでした。".into();
        return hit;
    };
    if !article.verified {
        if article.note.contains("削除された条") {
            hit.reason = "削除された条です".into();
            return hit;
        }
        if law.source == "bundle"
            && (article.note.contains("ありません") || article.note.contains("見つかりません"))
        {
            return number_miss(hit, "その条はありません。");
        }
        hit.reason = one_line(if article.note.is_empty() {
            "条文を確認できませんでした。"
        } else if article.note.contains("見つかりません") {
            "e-Govで条が見つかりませんでした"
        } else {
            article.note.as_str()
        });
        return hit;
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
    let target = match clause_text(&article.body, raw.paragraph, raw.item, raw.item_branch) {
        Ok(text) => text,
        Err(ClauseMiss::Paragraph(n)) => {
            return number_miss(hit, &format!("第{n}項はありません。"));
        }
        Err(ClauseMiss::Item(n)) => {
            return number_miss(hit, &format!("第{n}号はありません。"));
        }
        Err(ClauseMiss::Branch(item, branch)) => {
            return number_miss(hit, &format!("第{item}号の{branch}はありません。"));
        }
    };
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
        let window = law_window(&chars, span.start);
        let inherit = current.is_some() && (window.is_none() || connector_gap(&between));
        let dou = window.as_ref().is_some_and(|w| w.text == "同法");
        if let Some(window) = window.as_ref() {
            if window.text != "同法" && denied(&window.text) {
                current = None;
                prev_end = span.end;
                continue;
            }
        }
        let (law, unresolved, bare_douhou, historical) = if dou || (window.is_none() && inherit) {
            match current.clone() {
                Some(Current::Law(law)) => (Some(law), String::new(), false, false),
                Some(Current::Historical(name)) => (None, name, false, true),
                None if dou => (None, String::new(), true, false),
                None => (None, String::new(), false, false),
            }
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
                        prev_end = span.end;
                        continue;
                    }
                }
            }
        } else {
            current = None;
            prev_end = span.end;
            continue;
        };
        let clause = read_clause(&chars, span.end);
        let anchor_start = window.as_ref().map(|w| w.start).unwrap_or(span.start);
        let anchor_end = clause.end.max(span.end).min(chars.len());
        let mut anchor: String = chars[anchor_start..anchor_end].iter().collect();
        if anchor.chars().count() > 80 {
            let tail = clause_label(clause.paragraph, clause.item, clause.item_branch);
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
        let citation = if dou || window.is_none() {
            if let Some(law) = law.as_ref() {
                format!(
                    "{}{}{}",
                    law.name,
                    span.display,
                    clause_label(clause.paragraph, clause.item, clause.item_branch)
                )
            } else if historical {
                format!(
                    "{}{}{}",
                    unresolved,
                    span.display,
                    clause_label(clause.paragraph, clause.item, clause.item_branch)
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
        let window = law_window(&chars, start);
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
            item_branch: None,
            clause_unread: false,
            quote: None,
            quote_unread: false,
            suppl: false,
            schedule: true,
            anchor: anchor.clone(),
            citation: anchor,
        });
    }
    raws.sort_by_key(|raw| raw.start);
    raws
}

fn clause_label(paragraph: Option<u32>, item: Option<u32>, branch: Option<u32>) -> String {
    let mut out = String::new();
    if let Some(n) = paragraph {
        out.push_str(&format!("第{n}項"));
    }
    if let Some(n) = item {
        out.push_str(&format!("第{n}号"));
    }
    if let Some(n) = branch {
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

fn law_window(chars: &[char], cite_start: usize) -> Option<Window> {
    let mut end = cite_start;
    while end > 0 && chars[end - 1].is_whitespace() {
        end -= 1;
    }
    if let Some(cut) = strip_connector(chars, end) {
        if cut < end {
            return None;
        }
    }
    let mut start = end;
    while start > 0 && is_law_char(chars[start - 1]) {
        start -= 1;
    }
    if start == end {
        return None;
    }
    let text: String = chars[start..end].iter().collect();
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

fn connector_gap(between: &str) -> bool {
    let chars: Vec<char> = between.chars().collect();
    let mut text = String::new();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '「' {
            i += 1;
            while i < chars.len() && chars[i] != '」' {
                i += 1;
            }
            if i < chars.len() {
                i += 1;
            }
            continue;
        }
        if !chars[i].is_whitespace() {
            text.push(chars[i]);
        }
        i += 1;
    }
    is_connector(&text) || text == "同法" || text.ends_with("同法")
}

fn is_connector(text: &str) -> bool {
    matches!(
        text,
        "及び" | "および" | "又は" | "または" | "若しくは" | "並びに" | "と" | "、" | "，" | "・"
    )
}

struct ClauseRead {
    paragraph: Option<u32>,
    item: Option<u32>,
    item_branch: Option<u32>,
    end: usize,
    unread: bool,
}

fn read_clause(chars: &[char], start: usize) -> ClauseRead {
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
    let (item_branch, end) = if item.is_some() && chars.get(after_i) == Some(&'の') {
        match take_numeral(chars, after_i + 1) {
            Some((n, next)) => (Some(n), next),
            None => {
                unread = true;
                (None, after_i)
            }
        }
    } else {
        (None, after_i)
    };
    ClauseRead {
        paragraph,
        item,
        item_branch,
        end,
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
    let mut i = start;
    let limit = limit.min(chars.len());
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
    let rest: String = chars[i..limit.min(i + 12)].iter().collect();
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
    while k < chars.len() && chars[k] != '」' {
        k += 1;
    }
    if k >= chars.len() {
        return None;
    }
    Some(chars[i + 1..k].iter().collect())
}

fn quote_nearby(chars: &[char], start: usize, limit: usize) -> bool {
    let end = limit.min(start.saturating_add(48)).min(chars.len());
    chars[start..end].contains(&'「')
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
    Branch(u32, u32),
}

struct Block {
    paragraph: u32,
    text: String,
    items: Vec<(u32, Option<u32>, String)>,
}

fn clause_text(
    body: &str,
    paragraph: Option<u32>,
    item: Option<u32>,
    branch: Option<u32>,
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
            .find(|it| it.0 == n && it.1 == branch)
        else {
            if branch.is_some() {
                return Err(ClauseMiss::Branch(n, branch.unwrap_or(0)));
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

fn item_marker(line: &str) -> Option<(u32, Option<u32>, String)> {
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
    let mut branch = None;
    let mut k = i;
    if chars.get(k) == Some(&'の') {
        let mut b = k + 1;
        let bstart = b;
        while b < chars.len() && is_numeral_char(chars[b]) {
            b += 1;
        }
        if b > bstart {
            let btok: String = chars[bstart..b].iter().collect();
            if let Some(value) = parse_legal_numeral(&btok) {
                branch = Some(value);
                k = b;
            }
        }
    }
    if chars.get(k).is_none_or(|c| !c.is_whitespace()) {
        return None;
    }
    let rest: String = chars[k + 1..].iter().collect();
    Some((n, branch, rest.trim().to_string()))
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
        assert_eq!(hits[1].label, "番号違い", "{hits:?}");
        assert!(hits[1].citation.starts_with("民事訴訟法"), "{hits:?}");
        assert_eq!(hits[1].reason, "その条はありません。");
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
        assert_eq!(missing_item[0].label, "番号違い", "{missing_item:?}");
        assert_eq!(missing_item[0].reason, "第9号はありません。");
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
        assert_eq!(or[1].label, "番号違い", "{or:?}");
    }

    #[test]
    fn large_paragraphs_and_item_branches_are_not_dropped() {
        let hits = statuses("民法第415条第100項。民法第415条第2項第1号の2。");
        assert_eq!(hits.len(), 2, "{hits:?}");
        assert!(hits[0].citation.contains("100") || hits[0].citation.contains("第100項"), "{hits:?}");
        assert_eq!(hits[0].label, "番号違い", "{hits:?}");
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
        );
        assert!(hits.iter().all(|hit| hit.reason.contains("件数が多い")), "{hits:?}");
    }
}
