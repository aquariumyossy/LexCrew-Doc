use serde_json::{json, Value};

/// MTPLX picks the thinking strength and caps it with its own budget, so only
/// Qwen's on/off switch is sent.
///
/// Twin of `thinkingFields` in `src/shared/thinking.ts`.
pub fn thinking_fields(enabled: bool) -> Value {
    json!({ "chat_template_kwargs": { "enable_thinking": enabled } })
}

pub fn with_thinking(body: &Value, enabled: bool) -> Value {
    let mut out = body.clone();
    let fields = thinking_fields(enabled);
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
