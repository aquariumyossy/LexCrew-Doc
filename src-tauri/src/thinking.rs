use serde_json::{json, Value};

pub const DEFAULT_THINKING_BUDGET: u32 = 2_048;
pub const MIN_THINKING_BUDGET: u32 = 64;

pub fn normalize_budget(budget: u32) -> u32 {
    if budget == 0 {
        DEFAULT_THINKING_BUDGET
    } else {
        budget.max(MIN_THINKING_BUDGET)
    }
}

/// MTPLX keeps thinking on by default and honours `reasoning_effort` plus Qwen's
/// `chat_template_kwargs`. Long deliberation is bounded by the budget, not by
/// turning thinking off: with reasoning disabled, Qwen 3.8 has been seen to emit
/// stray tool calls and cut the turn short.
///
/// Twin of `thinkingFields` in `src/shared/thinking.ts`.
pub fn thinking_fields(level: &str, budget: u32) -> Value {
    if level.trim() == "off" {
        return json!({ "chat_template_kwargs": { "enable_thinking": false } });
    }
    let n = normalize_budget(budget);
    let effort = match level.trim() {
        "low" => "low",
        "high" => "xhigh",
        _ => "medium",
    };
    json!({
        "reasoning_effort": effort,
        "thinking_budget": n,
        "chat_template_kwargs": { "enable_thinking": true, "thinking_budget": n }
    })
}

pub fn with_thinking(body: &Value, level: &str, budget: u32) -> Value {
    let mut out = body.clone();
    let fields = thinking_fields(level, budget);
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
    fn medium_sends_effort_and_budget() {
        let fields = thinking_fields("medium", 2048);
        assert_eq!(fields["reasoning_effort"], "medium");
        assert_eq!(fields["thinking_budget"], 2048);
        assert_eq!(fields["chat_template_kwargs"]["enable_thinking"], true);
        assert_eq!(fields["chat_template_kwargs"]["thinking_budget"], 2048);
    }

    #[test]
    fn high_maps_to_xhigh() {
        assert_eq!(thinking_fields("high", 4096)["reasoning_effort"], "xhigh");
    }

    #[test]
    fn off_disables_thinking_only_when_chosen() {
        let fields = thinking_fields("off", 2048);
        assert_eq!(fields["chat_template_kwargs"]["enable_thinking"], false);
        assert!(fields.get("reasoning_effort").is_none());
    }

    #[test]
    fn budget_falls_back_and_has_a_floor() {
        assert_eq!(
            thinking_fields("low", 0)["thinking_budget"],
            DEFAULT_THINKING_BUDGET
        );
        assert_eq!(
            thinking_fields("low", 8)["thinking_budget"],
            MIN_THINKING_BUDGET
        );
    }

    #[test]
    fn with_thinking_keeps_the_base_payload() {
        let base = json!({ "model": "m", "messages": [] });
        let merged = with_thinking(&base, "medium", 2048);
        assert_eq!(merged["model"], "m");
        assert_eq!(merged["reasoning_effort"], "medium");
    }
}
