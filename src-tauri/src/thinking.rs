use serde_json::{json, Value};

/// MTPLX keeps thinking on by default and honours `reasoning_effort` plus Qwen's
/// `chat_template_kwargs.enable_thinking`. It does not read a token budget, so
/// none is sent; the pane cuts a call short when its thinking runs too long.
///
/// Twin of `thinkingFields` in `src/shared/thinking.ts`.
pub fn thinking_fields(level: &str) -> Value {
    if level.trim() == "off" {
        return json!({ "chat_template_kwargs": { "enable_thinking": false } });
    }
    let effort = match level.trim() {
        "low" => "low",
        "high" => "xhigh",
        _ => "medium",
    };
    json!({
        "reasoning_effort": effort,
        "chat_template_kwargs": { "enable_thinking": true }
    })
}

pub fn with_thinking(body: &Value, level: &str) -> Value {
    let mut out = body.clone();
    let fields = thinking_fields(level);
    if let (Some(target), Some(source)) = (out.as_object_mut(), fields.as_object()) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn medium_sends_effort_without_a_budget() {
        let fields = thinking_fields("medium");
        assert_eq!(fields["reasoning_effort"], "medium");
        assert_eq!(fields["chat_template_kwargs"]["enable_thinking"], true);
        assert!(fields.get("thinking_budget").is_none());
        assert!(fields["chat_template_kwargs"].get("thinking_budget").is_none());
    }

    #[test]
    fn high_maps_to_xhigh() {
        assert_eq!(thinking_fields("high")["reasoning_effort"], "xhigh");
    }

    #[test]
    fn off_disables_thinking_only_when_chosen() {
        let fields = thinking_fields("off");
        assert_eq!(fields["chat_template_kwargs"]["enable_thinking"], false);
        assert!(fields.get("reasoning_effort").is_none());
    }

    #[test]
    fn with_thinking_keeps_the_base_payload() {
        let base = json!({ "model": "m", "messages": [] });
        let merged = with_thinking(&base, "medium");
        assert_eq!(merged["model"], "m");
        assert_eq!(merged["reasoning_effort"], "medium");
    }
}
