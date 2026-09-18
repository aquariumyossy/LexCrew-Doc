use crate::log;
use reqwest::StatusCode;
use serde::Serialize;
use serde_json::Value;
use url::Url;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgosScopeRow {
    pub path: String,
    pub label: String,
    pub is_root: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ArgosScopes {
    pub recent: Vec<ArgosScopeRow>,
    pub scopes: Vec<ArgosScopeRow>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ArgosHit {
    pub title: String,
    pub url: String,
    pub content: String,
}

#[derive(Debug)]
pub struct ArgosError {
    pub message: String,
    pub hint: Option<String>,
    pub cancelled: bool,
}

impl ArgosError {
    fn new(message: impl Into<String>, hint: Option<String>) -> Self {
        Self {
            message: message.into(),
            hint,
            cancelled: false,
        }
    }
}

const HINT: &str =
    "Argos をこの PC で起動しているか、待受が http://127.0.0.1:17890 かを確認してください。";

fn normalize_base(base_url: &str) -> Result<String, ArgosError> {
    let trimmed = if base_url.trim().is_empty() {
        "http://127.0.0.1:17890".to_string()
    } else {
        base_url.trim().trim_end_matches('/').to_string()
    };
    let mut parsed = Url::parse(&trimmed).map_err(|_| {
        ArgosError::new(
            "Argos の URL が不正です。",
            Some("例: http://127.0.0.1:17890（localhost ではなく 127.0.0.1）".into()),
        )
    })?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(ArgosError::new(
            "Argos の URL は http または https にしてください。",
            None,
        ));
    }
    if parsed.host_str() == Some("localhost") {
        let _ = parsed.set_host(Some("127.0.0.1"));
    }
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

async fn send(
    base_url: &str,
    api_key: &str,
    path: &str,
    method: reqwest::Method,
    json_body: Option<Value>,
) -> Result<reqwest::Response, ArgosError> {
    let root = normalize_base(base_url)?;
    let url = format!("{root}{path}");
    let mut req = client()
        .request(method, &url)
        .header("Accept", "application/json");
    let key = api_key.trim();
    if !key.is_empty() {
        req = req.header("Authorization", format!("Bearer {key}"));
    }
    if let Some(body) = json_body {
        req = req.header("Content-Type", "application/json").json(&body);
    }
    req.send().await.map_err(|error| {
        log::error_name("argos failed", "error");
        let _ = error;
        ArgosError::new("Argos に接続できませんでした。", Some(HINT.into()))
    })
}

async fn read_error(res: reqwest::Response) -> String {
    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
        if let Some(error) = parsed.get("error").and_then(|v| v.as_str()) {
            return error.to_string();
        }
    }
    if status == 401 {
        return "Argos が認証を要求しました。LAN 経由なら設定の API キーを入れてください。同一 PC なら 127.0.0.1 を使います。".into();
    }
    if text.trim().is_empty() {
        format!("Argos が {status} を返しました。")
    } else {
        text.chars().take(180).collect()
    }
}

fn map_scope(row: &Value) -> Option<ArgosScopeRow> {
    let path = row
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if path.is_empty() {
        return None;
    }
    Some(ArgosScopeRow {
        path,
        label: row
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        is_root: row.get("isRoot").and_then(|v| v.as_bool()).unwrap_or(false),
    })
}

pub async fn check_argos(base_url: &str, api_key: &str) -> (bool, Option<String>) {
    match send(base_url, api_key, "/health", reqwest::Method::GET, None).await {
        Ok(res) if res.status().is_success() => match res.json::<Value>().await {
            Ok(payload)
                if payload.get("ok").and_then(|v| v.as_bool()) == Some(true)
                    && payload.get("name").and_then(|v| v.as_str()) == Some("argos") =>
            {
                (true, None)
            }
            _ => (false, Some("Argos の応答が想定と違います。".into())),
        },
        Ok(res) => (false, Some(read_error(res).await)),
        Err(error) => (false, Some(error.message)),
    }
}

pub async fn list_scopes(
    base_url: &str,
    api_key: &str,
    query: &str,
) -> Result<ArgosScopes, ArgosError> {
    log::info_status("argos scopes", "start");
    let path = if query.trim().is_empty() {
        "/scopes".to_string()
    } else {
        let encoded: String =
            url::form_urlencoded::byte_serialize(query.trim().as_bytes()).collect();
        format!("/scopes?query={encoded}")
    };
    let res = send(base_url, api_key, &path, reqwest::Method::GET, None).await?;
    log::info_status("argos scopes", res.status().as_u16());
    if !res.status().is_success() {
        return Err(ArgosError::new(read_error(res).await, Some(HINT.into())));
    }
    let payload = res.json::<Value>().await.unwrap_or(Value::Null);
    Ok(ArgosScopes {
        recent: payload
            .get("recent")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
            .filter_map(map_scope)
            .collect(),
        scopes: payload
            .get("scopes")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
            .filter_map(map_scope)
            .collect(),
    })
}

pub async fn search(
    base_url: &str,
    api_key: &str,
    query: &str,
    path_prefixes: &[String],
) -> Result<Vec<ArgosHit>, ArgosError> {
    let q = query.trim();
    if q.is_empty() {
        return Err(ArgosError::new("検索語を入力してください。", None));
    }
    log::info_status("argos search", "start");
    let prefixes: Vec<String> = path_prefixes
        .iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    let res = send(
        base_url,
        api_key,
        "/search",
        reqwest::Method::POST,
        Some(serde_json::json!({
            "query": q,
            "limit": 8,
            "pathPrefixes": prefixes,
        })),
    )
    .await?;
    log::info_status("argos search", res.status().as_u16());
    if res.status() == StatusCode::UNAUTHORIZED {
        return Err(ArgosError::new(read_error(res).await, Some(HINT.into())));
    }
    if !res.status().is_success() {
        return Err(ArgosError::new(read_error(res).await, Some(HINT.into())));
    }
    let payload = res.json::<Value>().await.unwrap_or(Value::Null);
    let hits = payload
        .get("hits")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(hits
        .into_iter()
        .filter(|row| {
            row.get("title")
                .and_then(|t| t.as_str())
                .filter(|s| !s.is_empty())
                .is_some()
                || row
                    .get("path")
                    .and_then(|t| t.as_str())
                    .filter(|s| !s.is_empty())
                    .is_some()
        })
        .map(|row| ArgosHit {
            title: row
                .get("title")
                .and_then(|t| t.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("(無題)")
                .to_string(),
            url: row
                .get("path")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string(),
            content: row
                .get("snippet")
                .and_then(|t| t.as_str())
                .filter(|s| !s.is_empty())
                .or_else(|| row.get("previewText").and_then(|t| t.as_str()))
                .unwrap_or("")
                .to_string(),
        })
        .collect())
}
