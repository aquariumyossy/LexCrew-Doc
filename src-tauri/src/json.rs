use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::OnceLock;

pub fn strip_thinking(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }

    static THINK: OnceLock<Regex> = OnceLock::new();
    static THINKING: OnceLock<Regex> = OnceLock::new();
    static THINK_OPEN: OnceLock<Regex> = OnceLock::new();
    static THINKING_OPEN: OnceLock<Regex> = OnceLock::new();

    let think = THINK.get_or_init(|| Regex::new(r"(?is)<think\b[^>]*>.*?</think>").expect("think"));
    let thinking = THINKING
        .get_or_init(|| Regex::new(r"(?is)<thinking\b[^>]*>.*?</thinking>").expect("thinking"));
    let think_open =
        THINK_OPEN.get_or_init(|| Regex::new(r"(?is)<think\b[^>]*>.*$").expect("think open"));
    let thinking_open = THINKING_OPEN
        .get_or_init(|| Regex::new(r"(?is)<thinking\b[^>]*>.*$").expect("thinking open"));

    let mut out = think.replace_all(text, "").into_owned();
    out = thinking.replace_all(&out, "").into_owned();
    out = think_open.replace_all(&out, "").into_owned();
    out = thinking_open.replace_all(&out, "").into_owned();
    out.trim().to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub reasoning_tokens: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    pub content: String,
    pub reasoning_content: String,
    pub tool_calls: Vec<Value>,
    pub finish_reason: String,
    pub usage: Option<Usage>,
}

fn text_at(value: Option<&Value>) -> String {
    value
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

fn count_at(value: Option<&Value>) -> u64 {
    value.and_then(|v| v.as_u64()).unwrap_or(0)
}

/// Keep only tool calls that name a function. Missing ids get a positional one
/// so the matching `role: "tool"` reply can still be paired up.
///
/// Twin of `normalizeToolCalls` in `src/shared/tools.ts`.
pub fn normalize_tool_calls(value: Option<&Value>) -> Vec<Value> {
    let Some(items) = value.and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let name = text_at(item.get("function").and_then(|f| f.get("name")));
            if name.trim().is_empty() {
                return None;
            }
            let arguments = text_at(item.get("function").and_then(|f| f.get("arguments")));
            let id = text_at(item.get("id"));
            let id = if id.trim().is_empty() {
                format!("call_{index}")
            } else {
                id
            };
            Some(json!({
                "id": id,
                "type": "function",
                "function": { "name": name, "arguments": arguments }
            }))
        })
        .collect()
}

fn parse_usage(payload: &Value) -> Option<Usage> {
    let usage = payload.get("usage")?;
    if !usage.is_object() {
        return None;
    }
    let details = usage.get("completion_tokens_details");
    Some(Usage {
        prompt_tokens: count_at(usage.get("prompt_tokens")),
        completion_tokens: count_at(usage.get("completion_tokens")),
        total_tokens: count_at(usage.get("total_tokens")),
        reasoning_tokens: count_at(details.and_then(|d| d.get("reasoning_tokens"))),
    })
}

/// Twin of `parseCompletion` in `src/shared/stripThinking.ts`.
pub fn parse_completion(payload: &Value) -> Completion {
    let choice = payload.get("choices").and_then(|c| c.get(0));
    let message = choice.and_then(|c| c.get("message"));

    let raw_content = match message {
        Some(message) => text_at(message.get("content")),
        None => text_at(choice.and_then(|c| c.get("text"))),
    };
    let reasoning = {
        let primary = text_at(message.and_then(|m| m.get("reasoning_content")));
        if primary.is_empty() {
            text_at(message.and_then(|m| m.get("reasoning")))
        } else {
            primary
        }
    };

    Completion {
        content: strip_thinking(&raw_content),
        reasoning_content: reasoning,
        tool_calls: normalize_tool_calls(message.and_then(|m| m.get("tool_calls"))),
        finish_reason: text_at(choice.and_then(|c| c.get("finish_reason"))),
        usage: parse_usage(payload),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strip_thinking_drops_blocks() {
        assert_eq!(strip_thinking("<think>内部</think>\n本文です"), "本文です");
        assert_eq!(strip_thinking("<think>途中\n最終"), "");
    }

    #[test]
    fn parse_completion_keeps_reasoning_separate() {
        let payload = json!({
            "choices": [{
                "finish_reason": "stop",
                "message": {
                    "content": "<think>隠す</think>本文",
                    "reasoning_content": "まだ考え中"
                }
            }],
            "usage": {
                "prompt_tokens": 120,
                "completion_tokens": 40,
                "total_tokens": 160,
                "completion_tokens_details": { "reasoning_tokens": 25 }
            }
        });
        let completion = parse_completion(&payload);
        assert_eq!(completion.content, "本文");
        assert_eq!(completion.reasoning_content, "まだ考え中");
        assert_eq!(completion.finish_reason, "stop");
        assert_eq!(
            completion.usage,
            Some(Usage {
                prompt_tokens: 120,
                completion_tokens: 40,
                total_tokens: 160,
                reasoning_tokens: 25,
            })
        );
    }

    #[test]
    fn parse_completion_reads_tool_calls_and_fills_missing_ids() {
        let payload = json!({
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "content": "",
                    "tool_calls": [
                        { "function": { "name": "search", "arguments": "{\"q\":\"民法\"}" } },
                        { "id": "c2", "function": { "name": "" } }
                    ]
                }
            }]
        });
        let completion = parse_completion(&payload);
        assert_eq!(completion.finish_reason, "tool_calls");
        assert_eq!(completion.tool_calls.len(), 1);
        assert_eq!(completion.tool_calls[0]["id"], "call_0");
        assert_eq!(completion.tool_calls[0]["function"]["name"], "search");
        assert_eq!(completion.usage, None);
    }
}
