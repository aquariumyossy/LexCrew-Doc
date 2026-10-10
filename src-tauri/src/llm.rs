use crate::constants::DEFAULT_MODEL;
use crate::json::{parse_completion, Completion};
use crate::log;
use crate::thinking::with_thinking;
use reqwest::{Client, StatusCode};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;
use url::Url;

#[derive(Debug, Clone, Serialize)]
pub struct HealthResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

#[derive(Debug)]
pub struct ChatError {
    pub message: String,
    pub hint: Option<String>,
    pub cancelled: bool,
}

impl ChatError {
    fn new(message: impl Into<String>, hint: Option<String>) -> Self {
        Self {
            message: message.into(),
            hint,
            cancelled: false,
        }
    }
}

impl std::fmt::Display for ChatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ChatError {}

pub fn split_llm_base(base_url: &str) -> Result<(String, String), String> {
    let trimmed = base_url.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        return Err("MTPLX の Base URL を入力してください。".into());
    }
    let parsed = Url::parse(&trimmed)
        .map_err(|_| "MTPLX の Base URL が不正です。例: http://192.168.1.10:8000/v1".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("MTPLX の Base URL は http または https にしてください。".into());
    }
    let origin = if trimmed.len() >= 3 && trimmed.to_ascii_lowercase().ends_with("/v1") {
        trimmed[..trimmed.len() - 3].to_string()
    } else {
        trimmed
    };
    Ok((origin.clone(), format!("{origin}/v1")))
}

fn hint_for_status(status: Option<u16>, network: bool, timeout: bool) -> String {
    if timeout {
        return format!(
            "タイムアウトしました。モデル起動直後は時間がかかることがあります。設定の待ち時間（既定 {} 秒）を確認してください。",
            crate::constants::DEFAULT_TIMEOUT_MS / 1000
        );
    }
    if network {
        return "Word PC から LLM PC のポートに届いているか（ファイアウォール）、MTPLX が 0.0.0.0 で待っているかを確認してください。"
            .into();
    }
    if matches!(status, Some(401) | Some(403)) {
        return "APIキーが合っているか確認してください。LAN 公開の MTPLX はキー無しを拒否します。"
            .into();
    }
    "MTPLX の URL・モデル名・APIキーを確認してください。".into()
}

fn is_timeout(err: &reqwest::Error) -> bool {
    err.is_timeout() || err.to_string().to_ascii_lowercase().contains("timeout")
}

fn is_canceled(err: &reqwest::Error) -> bool {
    let text = err.to_string().to_ascii_lowercase();
    text.contains("cancel") || text.contains("aborted")
}

fn is_network(err: &reqwest::Error) -> bool {
    if err.is_connect() {
        return true;
    }
    let text = format!("{}{:?}", err, err);
    let re = regex::Regex::new(
        r"(?i)fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|certificate|ECONNRESET",
    )
    .expect("network regex");
    re.is_match(&text)
}

fn excerpt_error(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
        if let Some(error) = parsed.get("error") {
            if let Some(s) = error.as_str() {
                return s.chars().take(300).collect();
            }
            if let Some(s) = error.get("message").and_then(|m| m.as_str()) {
                return s.chars().take(300).collect();
            }
        }
        if let Some(s) = parsed.get("message").and_then(|m| m.as_str()) {
            return s.chars().take(300).collect();
        }
    }
    raw.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(180)
        .collect()
}

fn parse_model_ids(payload: &Value) -> Vec<String> {
    let from_array = |arr: &Vec<Value>| {
        arr.iter()
            .filter_map(|item| {
                if let Some(s) = item.as_str() {
                    Some(s.to_string())
                } else {
                    item.get("id")
                        .and_then(|id| id.as_str())
                        .filter(|id| !id.is_empty())
                        .map(|id| id.to_string())
                }
            })
            .collect::<Vec<_>>()
    };

    if let Some(data) = payload.get("data").and_then(|d| d.as_array()) {
        let ids = from_array(data);
        if !ids.is_empty() || payload.get("data").is_some() {
            return ids;
        }
    }
    if let Some(models) = payload.get("models").and_then(|d| d.as_array()) {
        return from_array(models);
    }
    Vec::new()
}

#[allow(dead_code)]
fn normalize_model_id(id: &str) -> String {
    id.to_ascii_lowercase().replace(['.', '_'], "-")
}

#[allow(dead_code)]
pub fn pick_default_model(ids: &[String], preferred: &str) -> String {
    if let Some(exact) = ids.iter().find(|id| id.as_str() == preferred) {
        return exact.clone();
    }
    let normalized = normalize_model_id(preferred);
    ids.iter()
        .find(|id| {
            let candidate = normalize_model_id(id);
            candidate.contains(&normalized) || normalized.contains(&candidate)
        })
        .cloned()
        .unwrap_or_else(|| preferred.to_string())
}

fn client() -> Client {
    Client::builder().build().unwrap_or_else(|_| Client::new())
}

pub async fn check_llm_health(base_url: &str, api_key: &str) -> HealthResult {
    if api_key.trim().is_empty() {
        return HealthResult {
            ok: false,
            models: None,
            error: Some("APIキーが空です。".into()),
            hint: Some(
                "APIキーが合っているか確認してください。LAN 公開の MTPLX はキー無しを拒否します。"
                    .into(),
            ),
        };
    }

    let (origin, v1_base) = match split_llm_base(base_url) {
        Ok(v) => v,
        Err(error) => {
            return HealthResult {
                ok: false,
                models: None,
                error: Some(error),
                hint: None,
            };
        }
    };

    let http = client();
    let mut models_auth_failed: Option<HealthResult> = None;

    log::info_status("llm health models", "start");
    match http
        .get(format!("{v1_base}/models"))
        .header("Authorization", format!("Bearer {}", api_key.trim()))
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(res) => {
            let status = res.status();
            log::info_status("llm health models", status.as_u16());
            if status.is_success() {
                let payload = res.json::<Value>().await.unwrap_or(json!({}));
                return HealthResult {
                    ok: true,
                    models: Some(parse_model_ids(&payload)),
                    error: None,
                    hint: None,
                };
            }
            if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
                let raw = res.text().await.unwrap_or_default();
                let detail = excerpt_error(&raw);
                models_auth_failed = Some(HealthResult {
                    ok: false,
                    models: None,
                    error: Some(if detail.is_empty() {
                        format!("モデル一覧が {} でした。", status.as_u16())
                    } else {
                        detail
                    }),
                    hint: Some(hint_for_status(Some(status.as_u16()), false, false)),
                });
            }
        }
        Err(error) => {
            if is_canceled(&error) {
                return HealthResult {
                    ok: false,
                    models: None,
                    error: Some("キャンセルしました。".into()),
                    hint: None,
                };
            }
            log::error_name("llm health models failed", "error");
        }
    }

    log::info_status("llm health fallback", "start");
    match http
        .get(format!("{origin}/health"))
        .header("Authorization", format!("Bearer {}", api_key.trim()))
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(res) => {
            let status = res.status();
            log::info_status("llm health fallback", status.as_u16());
            if status.is_success() {
                return HealthResult {
                    ok: true,
                    models: Some(Vec::new()),
                    error: None,
                    hint: None,
                };
            }
            if let Some(failed) = models_auth_failed {
                return failed;
            }
            let raw = res.text().await.unwrap_or_default();
            let detail = excerpt_error(&raw);
            HealthResult {
                ok: false,
                models: None,
                error: Some(if detail.is_empty() {
                    format!("GET /health が {} でした。", status.as_u16())
                } else {
                    detail
                }),
                hint: Some(hint_for_status(Some(status.as_u16()), false, false)),
            }
        }
        Err(error) => {
            log::error_name("llm health fallback failed", "error");
            if let Some(failed) = models_auth_failed {
                return failed;
            }
            HealthResult {
                ok: false,
                models: None,
                error: Some("GET /v1/models も GET /health も失敗しました。".into()),
                hint: Some(hint_for_status(
                    None,
                    is_network(&error) || true,
                    is_timeout(&error),
                )),
            }
        }
    }
}

pub struct ChatOptions<'a> {
    pub base_url: &'a str,
    pub api_key: &'a str,
    pub model: &'a str,
    pub messages: &'a [Value],
    pub tools: &'a [Value],
    pub thinking_level: &'a str,
    pub timeout_ms: u64,
}

fn build_payload(options: &ChatOptions<'_>, include_thinking: bool, stream: bool) -> Value {
    let model = if options.model.trim().is_empty() {
        DEFAULT_MODEL
    } else {
        options.model.trim()
    };
    let mut payload = json!({
        "model": model,
        "messages": options.messages,
    });
    if !options.tools.is_empty() {
        payload["tools"] = json!(options.tools);
        payload["tool_choice"] = json!("auto");
    }
    if stream {
        payload["stream"] = json!(true);
    }
    if include_thinking {
        payload = with_thinking(&payload, options.thinking_level);
    }
    payload
}

pub async fn post_chat(
    options: ChatOptions<'_>,
    stream: bool,
) -> Result<reqwest::Response, ChatError> {
    let api_key = options.api_key.trim();
    if api_key.is_empty() {
        return Err(ChatError::new(
            "APIキーが空です。",
            Some("APIキーが合っているか確認してください。".into()),
        ));
    }
    if options.messages.is_empty() {
        return Err(ChatError::new("messages が空です。", None));
    }

    let (_, v1_base) = split_llm_base(options.base_url).map_err(|e| ChatError::new(e, None))?;
    let timeout_ms = if options.timeout_ms > 0 {
        options.timeout_ms
    } else {
        crate::constants::DEFAULT_TIMEOUT_MS
    };
    let url = format!("{v1_base}/chat/completions");
    let accept = if stream {
        "text/event-stream"
    } else {
        "application/json"
    };

    let http = client();
    let post = |payload: Value| {
        http.post(&url)
            .timeout(Duration::from_millis(timeout_ms))
            .header("Authorization", format!("Bearer {api_key}"))
            .header("Accept", accept)
            .json(&payload)
            .send()
    };
    let connection_error = |error: &reqwest::Error| {
        log::error_name("llm chat failed", "error");
        let timeout = is_timeout(error);
        ChatError::new(
            if timeout {
                "MTPLX が時間内に応答しませんでした。"
            } else {
                "MTPLX に接続できませんでした。"
            },
            Some(hint_for_status(None, !timeout, timeout)),
        )
    };

    log::info_status("llm chat", "start");
    let mut res = post(build_payload(&options, true, stream))
        .await
        .map_err(|error| connection_error(&error))?;

    if res.status() == StatusCode::BAD_REQUEST {
        // Servers without the Qwen thinking controls reject the extra fields.
        log::info_status("llm chat retry without thinking fields", 400);
        res = post(build_payload(&options, false, stream))
            .await
            .map_err(|error| connection_error(&error))?;
    }

    log::info_status("llm chat", res.status().as_u16());
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let raw = res.text().await.unwrap_or_default();
        let detail = excerpt_error(&raw);
        return Err(ChatError::new(
            if detail.is_empty() {
                format!("MTPLX が {status} を返しました。")
            } else {
                detail
            },
            Some(hint_for_status(Some(status), false, false)),
        ));
    }
    Ok(res)
}

pub async fn chat_completions(options: ChatOptions<'_>) -> Result<Completion, ChatError> {
    let payload = post_chat(options, false)
        .await?
        .json::<Value>()
        .await
        .map_err(|_| ChatError::new("MTPLX への問い合わせに失敗しました。", None))?;
    Ok(parse_completion(&payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_default_model_matches_punctuation_drift() {
        let ids = vec!["qwen3_8-flash-next".into(), "other".into()];
        assert_eq!(
            pick_default_model(&ids, DEFAULT_MODEL),
            "qwen3_8-flash-next"
        );
    }
}
