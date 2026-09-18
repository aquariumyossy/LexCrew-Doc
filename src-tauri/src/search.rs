use crate::log;
use reqwest::StatusCode;
use serde::Serialize;
use serde_json::Value;
use url::Url;

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub content: String,
}

#[derive(Debug)]
pub struct SearchError {
    pub message: String,
    pub cancelled: bool,
}

impl SearchError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            cancelled: false,
        }
    }
}

impl std::fmt::Display for SearchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SearchError {}

fn normalize_base(base_url: &str) -> Result<String, SearchError> {
    let trimmed = base_url.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        return Err(SearchError::new("SearXNG の URL を入力してください。"));
    }
    let parsed = Url::parse(&trimmed)
        .map_err(|_| SearchError::new("SearXNG の URL が不正です。例: http://127.0.0.1:8080"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(SearchError::new(
            "SearXNG の URL は http または https にしてください。",
        ));
    }
    let root = if trimmed.len() >= 7 && trimmed.to_ascii_lowercase().ends_with("/search") {
        trimmed[..trimmed.len() - 7].to_string()
    } else {
        trimmed
    };
    Ok(root)
}

fn search_url(base_url: &str, query: &str) -> Result<String, SearchError> {
    let root = normalize_base(base_url)?;
    let mut url = Url::parse(&format!("{root}/search"))
        .map_err(|_| SearchError::new("SearXNG の URL が不正です。例: http://127.0.0.1:8080"))?;
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("format", "json")
        .append_pair("language", "ja");
    Ok(url.to_string())
}

pub async fn search(query: &str, base_url: &str) -> Result<Vec<SearchHit>, SearchError> {
    let q = query.trim();
    if q.is_empty() {
        return Err(SearchError::new("検索語を入力してください。"));
    }
    let url = search_url(base_url, q)?;
    log::info_status("searxng search", "start");

    let res = reqwest::Client::new()
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| {
            log::error_name("searxng search failed", "error");
            let _ = error;
            SearchError::new(
                "SearXNG に接続できませんでした。URL と、Word PC からそのホストへ届くか（ファイアウォール）を確認してください。",
            )
        })?;

    log::info_status("searxng search", res.status().as_u16());
    if res.status() == StatusCode::FORBIDDEN {
        return Err(SearchError::new(
            "SearXNG が JSON 形式を拒否しました（403）。settings.yml の search.formats に json を追加してインスタンスを再起動してください。",
        ));
    }
    if !res.status().is_success() {
        return Err(SearchError::new(format!(
            "SearXNG が {} を返しました。",
            res.status().as_u16()
        )));
    }

    let payload = res.json::<Value>().await.unwrap_or(Value::Null);
    let results = payload
        .get("results")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(results
        .into_iter()
        .filter(|row| {
            row.get("title")
                .and_then(|t| t.as_str())
                .filter(|s| !s.is_empty())
                .is_some()
                || row
                    .get("url")
                    .and_then(|t| t.as_str())
                    .filter(|s| !s.is_empty())
                    .is_some()
        })
        .map(|row| SearchHit {
            title: row
                .get("title")
                .and_then(|t| t.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("(無題)")
                .to_string(),
            url: row
                .get("url")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string(),
            content: row
                .get("content")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string(),
        })
        .collect())
}

pub async fn check_searxng(base_url: &str) -> (bool, Option<String>) {
    if base_url.trim().is_empty() {
        return (false, Some("SearXNG の URL が空です。".into()));
    }
    match search("ping", base_url).await {
        Ok(_) => (true, None),
        Err(error) => (false, Some(error.message)),
    }
}
