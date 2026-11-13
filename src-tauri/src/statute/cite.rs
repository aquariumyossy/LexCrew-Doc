//! Mark statute citations the chat did not verify.

use crate::statute::xmlparse::{article_spans, parse_article_query};

const TOOL_RESULT_OMITTED: &str = "（文脈の上限に達したため、この結果は省略しました）";
const TOOL_RESULT_TRUNCATION_NOTE: &str = "…（長いので省略しました）";

#[allow(dead_code)]
pub const LLM_STATUTE_HINT: &str = "\
条文を回答に書く前に law_article で、その条の本文を取得してください。1回に10条まで、1つの回答で10回までです。この回数はウェブ検索や他のツール往復には数えません。返ってきた見出しと本文だけを根拠にし、本文にない効果は書かないでください。取得できなかった条番号には「要確認」と付けてください。";
#[allow(dead_code)]
pub const LLM_STATUTE_SENTINEL: &str = "law_article で、その条の本文を取得";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedCite {
    pub names: Vec<String>,
    pub key: String,
}

/// Why a lookup did not return current text. Only `NotFound` may become 番号違い.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArticleMiss {
    NotFound,
    Deleted,
    Failed,
}

#[derive(Debug, Clone)]
pub struct ToolArticle {
    pub names: Vec<String>,
    pub article_num: String,
    pub heading: String,
    pub body: String,
    pub as_of: String,
    pub verified: bool,
    pub offline: bool,
    pub note: String,
    pub law_query: String,
    pub article_query: String,
    /// Set when `verified` is false. HTTP errors and bad XML stay `Failed`.
    pub miss: Option<ArticleMiss>,
}

/// Keep one `law_article` reply from crowding out the rest of the tool budget.
pub fn cap_statute_tool_text(text: &str, max_chars: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max_chars {
        return text.to_string();
    }
    let mut out: String = chars.into_iter().take(max_chars).collect();
    out.push_str("\n…（長いので省略しました）");
    out
}

pub fn format_tool_result(articles: &[ToolArticle], omitted: usize) -> String {
    let mut out = String::new();
    for article in articles {
        if article.verified {
            out.push_str("確認済み: ");
            out.push_str(&article.names.join("|"));
            out.push(' ');
            out.push_str(&article.article_num);
            out.push('\n');
        } else {
            out.push_str("未確認: ");
            out.push_str(&article.law_query);
            out.push(' ');
            out.push_str(&article.article_query);
            out.push('\n');
        }
    }
    if omitted > 0 {
        out.push_str(&format!(
            "未確認: （{omitted}件は1回の上限10条を超えたため取得していません）\n"
        ));
    }
    out.push('\n');
    for article in articles {
        if article.verified {
            out.push_str(&format!(
                "【{} {}】\n",
                article.names.first().map(|s| s.as_str()).unwrap_or("法令"),
                article.article_num
            ));
            if !article.heading.is_empty() {
                out.push_str(&format!("見出し: {}\n", article.heading));
            }
            if !article.as_of.is_empty() {
                out.push_str(&format!("時点: {}\n", article.as_of));
            }
            if article.offline {
                out.push_str("改正確認できず（オフライン）。保存済みの本文を返しました。\n");
            }
            out.push_str(&article.body);
            out.push_str("\n\n");
        } else {
            out.push_str(&format!(
                "【{} {}】要確認\n{}\n\n",
                article.law_query, article.article_query, article.note
            ));
        }
    }
    out
}

pub fn verified_from_tool_output(content: &str) -> Vec<VerifiedCite> {
    let mut out = Vec::new();
    for line in content.lines() {
        let Some(rest) = line.strip_prefix("確認済み: ") else {
            continue;
        };
        let Some((names, article)) = rest.rsplit_once(' ') else {
            continue;
        };
        let Some((key, _)) = parse_article_query(article) else {
            continue;
        };
        let names = names
            .split('|')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(|name| name.to_string())
            .collect::<Vec<_>>();
        if names.is_empty() {
            continue;
        }
        out.push(VerifiedCite { names, key });
    }
    out
}

/// Verified cites from the tool text the model actually received.
/// A result replaced by the context-limit stub, or an article whose body was
/// cut, does not count. The law name and the article number both have to match
/// a section that arrived whole.
pub fn verified_from_delivered(content: &str) -> Vec<VerifiedCite> {
    if content.contains(TOOL_RESULT_OMITTED) {
        return Vec::new();
    }
    let header = verified_from_tool_output(content);
    let Some(cut) = content.find(TOOL_RESULT_TRUNCATION_NOTE) else {
        return header;
    };
    let complete = complete_sections(content, cut);
    header
        .into_iter()
        .filter(|cite| {
            complete.iter().any(|section| {
                section.key == cite.key && cite.names.iter().any(|name| name == &section.name)
            })
        })
        .collect()
}

struct CompleteSection {
    name: String,
    key: String,
}

fn complete_sections(content: &str, cut: usize) -> Vec<CompleteSection> {
    let chars: Vec<char> = content.chars().collect();
    let mut byte_at = Vec::with_capacity(chars.len() + 1);
    let mut n = 0usize;
    byte_at.push(0);
    for ch in &chars {
        n += ch.len_utf8();
        byte_at.push(n);
    }
    let cut_chars = byte_at
        .iter()
        .position(|b| *b >= cut)
        .unwrap_or(chars.len());
    let mut starts = Vec::new();
    for (i, ch) in chars.iter().copied().enumerate() {
        if ch == '【' {
            starts.push(i);
        }
    }
    let mut sections = Vec::new();
    for (idx, start) in starts.iter().copied().enumerate() {
        let end = starts.get(idx + 1).copied().unwrap_or(chars.len());
        if cut_chars < end {
            continue;
        }
        let heading: String = chars[start..end.min(chars.len())]
            .iter()
            .take_while(|c| **c != '】')
            .collect();
        let Some(span) = article_spans(&heading).into_iter().next() else {
            continue;
        };
        if span.start > heading.chars().count() {
            continue;
        }
        let name: String = heading.chars().take(span.start).collect();
        let name = name.trim_start_matches('【').trim();
        if name.is_empty() {
            continue;
        }
        sections.push(CompleteSection {
            name: name.to_string(),
            key: span.key,
        });
    }
    sections
}

pub fn summary_lines(content: &str) -> Vec<String> {
    content
        .lines()
        .filter(|line| line.starts_with("確認済み: ") || line.starts_with("未確認: "))
        .map(|line| line.to_string())
        .collect()
}


#[cfg_attr(not(test), allow(dead_code))]
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_header_round_trips_and_summary_keeps_only_the_header() {
        let articles = vec![ToolArticle {
            names: vec!["民法".into()],
            article_num: "第555条".into(),
            heading: "売買".into(),
            body: "売買は、当事者の一方がある財産権を相手方に移転することを約する。".into(),
            as_of: "2026-04-01".into(),
            verified: true,
            offline: false,
            note: String::new(),
            law_query: "民法".into(),
            article_query: "555".into(),
            miss: None,
        }];
        let text = format_tool_result(&articles, 0);
        let parsed = verified_from_tool_output(&text);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].key, "555");
        assert_eq!(parsed[0].names, vec!["民法".to_string()]);
        let lines = summary_lines(&text);
        assert_eq!(lines, vec!["確認済み: 民法 第555条".to_string()]);
        assert!(lines.iter().all(|line| !line.contains("財産権")));
        assert!(text.contains("見出し: 売買"));
        assert!(text.contains("時点: 2026-04-01"));
        let huge = "あ".repeat(8_000);
        let capped = cap_statute_tool_text(&huge, 100);
        assert!(capped.chars().count() < 200, "{}", capped.chars().count());
        assert!(capped.contains("…（長いので省略しました）"));
    }


    #[test]
    fn a_truncated_tool_result_does_not_count_as_verified() {
        let full = "確認済み: 民法 第555条\n\n【民法 第555条】\n見出し: 売買\n本文です。\n";
        assert_eq!(verified_from_delivered(full).len(), 1);
        let stub = "（文脈の上限に達したため、この結果は省略しました）";
        assert!(verified_from_delivered(stub).is_empty());
        let cut = "確認済み: 民法 第555条\n確認済み: 民法 第1条\n\n【民法 第555条】\n本文です。\n\n【民法 第1条】\n途中…（長いので省略しました）";
        let kept = verified_from_delivered(cut);
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert_eq!(kept[0].key, "555");
        let same_number = "確認済み: 民法 第1条\n確認済み: 会社法 第1条\n\n【民法 第1条】\n全文です。\n\n【会社法 第1条】\n途中…（長いので省略しました）";
        let kept_law = verified_from_delivered(same_number);
        assert_eq!(kept_law.len(), 1, "{kept_law:?}");
        assert_eq!(kept_law[0].names, vec!["民法".to_string()]);
        assert_eq!(kept_law[0].key, "1");
    }

}
