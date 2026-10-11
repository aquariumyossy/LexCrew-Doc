use serde_json::{json, Value};

/// MTPLX picks the thinking strength and caps it with its own budget, so only
/// Qwen's on/off switch is sent.
///
/// Twin of `thinkingFields` in `src/shared/thinking.ts`.
pub fn thinking_fields(enabled: bool) -> Value {
    json!({ "chat_template_kwargs": { "enable_thinking": enabled } })
}

/// MTPLX guards only requests that carry tools with thinking on, so an empty
/// guard on such a request means no budget is set; on any other it says nothing.
fn budget_of_record(record: &Value) -> Option<Option<u64>> {
    let guard = &record["thinking_guard"];
    if guard["enabled"] == true {
        if let Some(budget) = guard["budget_tokens"].as_u64().filter(|n| *n > 0) {
            return Some(Some(budget));
        }
    }
    let tools = record["request_tool_count"].as_u64().unwrap_or(0);
    (record["request_enable_thinking"] == true && tools > 0).then_some(None)
}

/// The budget MTPLX applied, read from its `GET /metrics` records:
/// `Some(Some(tokens))`, `Some(None)` when none is set, `None` when the
/// records do not say. Without a request id the newest record that says
/// anything decides.
///
/// Twin of `budgetFromMetrics` in `src/shared/thinking.ts`.
pub fn budget_from_metrics(metrics: &Value, request_id: Option<&str>) -> Option<Option<u64>> {
    metrics["recent"]
        .as_array()?
        .iter()
        .rev()
        .filter(|record| record.is_object())
        .filter(|record| request_id.is_none_or(|id| record["request_id"] == id))
        .find_map(budget_of_record)
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
        assert_eq!(
            fields,
            json!({ "chat_template_kwargs": { "enable_thinking": true } })
        );
    }

    #[test]
    fn off_disables_thinking() {
        let fields = thinking_fields(false);
        assert_eq!(
            fields,
            json!({ "chat_template_kwargs": { "enable_thinking": false } })
        );
    }

    fn guarded(id: &str, budget: u64) -> Value {
        json!({
            "request_id": id,
            "request_tool_count": 3,
            "request_enable_thinking": true,
            "thinking_guard": { "enabled": true, "budget_tokens": budget }
        })
    }

    fn unguarded(id: &str) -> Value {
        json!({
            "request_id": id,
            "request_tool_count": 3,
            "request_enable_thinking": true,
            "thinking_guard": {}
        })
    }

    #[test]
    fn budget_comes_off_the_record_of_the_request() {
        let metrics = json!({ "recent": [guarded("a", 2048), guarded("b", 4096)] });
        assert_eq!(budget_from_metrics(&metrics, Some("a")), Some(Some(2048)));
        let unset = json!({ "recent": [unguarded("a")] });
        assert_eq!(budget_from_metrics(&unset, Some("a")), Some(None));
        assert_eq!(budget_from_metrics(&metrics, Some("z")), None);
    }

    #[test]
    fn budget_is_unknown_when_the_guard_never_covered_the_request() {
        let plain = json!({ "recent": [{
            "request_id": "a",
            "request_tool_count": 0,
            "request_enable_thinking": true,
            "thinking_guard": {}
        }] });
        assert_eq!(budget_from_metrics(&plain, Some("a")), None);
        assert_eq!(budget_from_metrics(&json!("not metrics"), Some("a")), None);
    }

    #[test]
    fn budget_without_a_request_takes_the_newest_covered_one() {
        let plain = json!({ "request_id": "c", "request_tool_count": 0, "thinking_guard": {} });
        let unset = json!({ "recent": [guarded("a", 2048), unguarded("b"), plain.clone()] });
        assert_eq!(budget_from_metrics(&unset, None), Some(None));
        let set = json!({ "recent": [unguarded("a"), guarded("b", 2048), plain] });
        assert_eq!(budget_from_metrics(&set, None), Some(Some(2048)));
    }

    #[test]
    fn with_thinking_keeps_the_base_payload() {
        let base = json!({ "model": "m", "messages": [] });
        let merged = with_thinking(&base, true);
        assert_eq!(merged["model"], "m");
        assert_eq!(merged["chat_template_kwargs"]["enable_thinking"], true);
    }
}
