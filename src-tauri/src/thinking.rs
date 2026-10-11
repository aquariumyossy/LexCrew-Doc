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
    fn on_leaves_the_strength_to_mtplx() {
        let fields = thinking_fields(true);
        assert_eq!(fields, json!({ "chat_template_kwargs": { "enable_thinking": true } }));
    }

    #[test]
    fn off_disables_thinking() {
        let fields = thinking_fields(false);
        assert_eq!(fields, json!({ "chat_template_kwargs": { "enable_thinking": false } }));
    }

    #[test]
    fn with_thinking_keeps_the_base_payload() {
        let base = json!({ "model": "m", "messages": [] });
        let merged = with_thinking(&base, true);
        assert_eq!(merged["model"], "m");
        assert_eq!(merged["chat_template_kwargs"]["enable_thinking"], true);
    }
}
