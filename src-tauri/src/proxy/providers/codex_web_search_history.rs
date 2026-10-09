//! Keep replayed hosted-search history consistent with its tool declarations.
//!
//! Codex compaction can replay `web_search_call` with no tools. ChatGPT's Codex
//! backend rejects that shape with `response protection is unavailable`.
//! Callers must gate this repair to native GPT/Codex Responses, never Chat,
//! Anthropic, unrelated native vendors, or the standalone `/responses/compact`.

use serde_json::{json, Value};

/// Run at the final native Responses send boundary, after model mapping and
/// provider overrides. Other transports and standalone compact stay untouched.
pub(crate) fn repair_codex_web_search_history(
    app_type: &crate::app_config::AppType,
    endpoint: &str,
    body: &mut Value,
    use_responses_lite: bool,
    native_responses: bool,
    official_codex: bool,
) -> bool {
    let path = endpoint.split_once('?').map_or(endpoint, |(path, _)| path);
    let model = body.get("model").and_then(Value::as_str).unwrap_or("");
    if !matches!(app_type, crate::app_config::AppType::Codex)
        || !native_responses
        || !matches!(path, "/responses" | "/v1/responses")
        || !(official_codex || model.starts_with("gpt-") || model.starts_with("codex-"))
    {
        return false;
    }
    ensure_web_search_declared_for_history(body, use_responses_lite)
}

/// Declare hosted search for replay without deleting history or enabling new
/// tool calls in an originally tool-free request. Existing search declarations
/// (including their live-search settings) and caller tool choices are preserved.
pub(crate) fn ensure_web_search_declared_for_history(
    body: &mut Value,
    use_responses_lite: bool,
) -> bool {
    if undeclared_web_search_history_count(body) == 0 {
        return false;
    }
    let items = body.get("input").and_then(Value::as_array).unwrap();
    let top_level_tools = body.get("tools").and_then(Value::as_array);
    let additional_tools = items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("additional_tools"))
        .filter_map(|item| item.get("tools").and_then(Value::as_array));
    let caller_has_tools = top_level_tools.is_some_and(|tools| !tools.is_empty())
        || additional_tools.into_iter().any(|tools| !tools.is_empty());
    let keep_tool_free = !caller_has_tools
        && match body.get("tool_choice") {
            None | Some(Value::Null) => true,
            Some(Value::String(choice)) => matches!(choice.as_str(), "auto" | "none"),
            _ => false,
        };

    // This declaration is for interpreting existing search history, not for
    // changing the user's live-search preference or fetching new pages.
    let tool = json!({"type": "web_search", "external_web_access": false});
    if use_responses_lite {
        let items = body.get_mut("input").and_then(Value::as_array_mut).unwrap();
        if let Some(item) = items
            .iter_mut()
            .find(|item| item.get("type").and_then(Value::as_str) == Some("additional_tools"))
        {
            let Some(item) = item.as_object_mut() else {
                return false;
            };
            let tools = item.entry("tools").or_insert_with(|| json!([]));
            if tools.is_null() {
                *tools = json!([]);
            }
            let Some(tools) = tools.as_array_mut() else {
                return false;
            };
            tools.push(tool);
        } else {
            let position = if items.last().is_some_and(|item| {
                item.get("type").and_then(Value::as_str) == Some("compaction_trigger")
            }) {
                items.len() - 1
            } else {
                items.len()
            };
            items.insert(
                position,
                json!({"type": "additional_tools", "role": "developer", "tools": [tool]}),
            );
        }
    } else {
        let Some(object) = body.as_object_mut() else {
            return false;
        };
        let tools = object.entry("tools").or_insert_with(|| json!([]));
        if tools.is_null() {
            *tools = json!([]);
        }
        let Some(tools) = tools.as_array_mut() else {
            return false;
        };
        tools.push(tool);
    }
    if keep_tool_free {
        body["tool_choice"] = json!("none");
    }
    true
}

/// Shared invariant for replay repair and diagnostic-only request inspection.
pub(crate) fn undeclared_web_search_history_count(body: &Value) -> usize {
    let Some(items) = body.get("input").and_then(Value::as_array) else {
        return 0;
    };
    let count = items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("web_search_call"))
        .count();
    let additional_tools = items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("additional_tools"))
        .filter_map(|item| item.get("tools").and_then(Value::as_array));
    let declared = body
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .chain(additional_tools)
        .flatten()
        .any(|tool| {
            tool.get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind == "web_search" || kind.starts_with("web_search_"))
        });
    if declared {
        0
    } else {
        count
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn history() -> Value {
        json!([
            {"type": "message", "role": "user", "content": "Continue the task."},
            {"type": "web_search_call", "id": "ws_history", "status": "completed",
             "action": {"type": "search", "query": "reference", "sources": [{"url": "https://example.org"}]}},
            {"type": "compaction_trigger"}
        ])
    }

    #[test]
    fn search_history_tool_free_standard_replay_preserves_history_and_is_idempotent() {
        for tools in [None, Some(Value::Null), Some(json!([]))] {
            for choice in [
                None,
                Some(Value::Null),
                Some(json!("auto")),
                Some(json!("none")),
            ] {
                let mut body = json!({"model": "gpt-6.1-sol", "input": history()});
                if let Some(tools) = tools.clone() {
                    body["tools"] = tools;
                }
                if let Some(choice) = choice {
                    body["tool_choice"] = choice;
                }
                assert!(ensure_web_search_declared_for_history(&mut body, false));
                assert_eq!(body["input"], history());
                assert_eq!(body["tool_choice"], "none");
                assert_eq!(
                    body["tools"],
                    json!([{"type": "web_search", "external_web_access": false}])
                );
                let repaired = body.clone();
                assert!(!ensure_web_search_declared_for_history(&mut body, false));
                assert_eq!(body, repaired);
            }
        }
    }

    #[test]
    fn search_history_preserves_live_search_and_preview_declarations_on_both_transports() {
        for kind in [
            "web_search",
            "web_search_preview",
            "web_search_preview_2025_03_11",
        ] {
            for lite in [false, true] {
                for in_input in [false, true] {
                    let mut body = json!({"input": history(), "tool_choice": "auto"});
                    let tools = json!([{"type": kind, "external_web_access": true, "search_context_size": "high"}]);
                    if in_input {
                        body["input"]
                            .as_array_mut()
                            .unwrap()
                            .insert(0, json!({"type": "additional_tools", "tools": tools}));
                    } else {
                        body["tools"] = tools;
                    }
                    let original = body.clone();
                    assert!(!ensure_web_search_declared_for_history(&mut body, lite));
                    assert_eq!(body, original);
                }
            }
        }
    }

    #[test]
    fn search_history_keeps_existing_function_tools_and_explicit_choices() {
        for choice in [
            json!("auto"),
            json!("required"),
            json!("none"),
            json!({"type": "function", "name": "shell"}),
        ] {
            let function =
                json!({"type": "function", "name": "shell", "parameters": {"type": "object"}});
            let mut body = json!({"input": history(), "tools": [function.clone()], "tool_choice": choice.clone()});
            assert!(ensure_web_search_declared_for_history(&mut body, false));
            assert_eq!(body["tools"][0], function);
            assert_eq!(body["tools"].as_array().unwrap().len(), 2);
            assert_eq!(body["tool_choice"], choice);
            assert_eq!(body["input"], history());
        }
    }

    #[test]
    fn search_history_lite_inserts_before_trigger_without_top_level_hosted_tools() {
        let mut body = json!({"input": history(), "tool_choice": "auto"});
        assert!(ensure_web_search_declared_for_history(&mut body, true));
        assert!(body.get("tools").is_none());
        assert_eq!(body["input"][1], history()[1]);
        assert_eq!(body["input"][2]["type"], "additional_tools");
        assert_eq!(body["input"][2]["role"], "developer");
        assert_eq!(body["input"][2]["tools"][0]["type"], "web_search");
        assert_eq!(body["input"][3], history()[2]);
        assert_eq!(body["tool_choice"], "none");
        let repaired = body.clone();
        assert!(!ensure_web_search_declared_for_history(&mut body, true));
        assert_eq!(body, repaired);
    }

    #[test]
    fn search_history_lite_extends_additional_tools_without_changing_caller_choice() {
        let mut body = json!({"input": history(), "tool_choice": "auto"});
        let function = json!({"type": "function", "name": "shell"});
        body["input"].as_array_mut().unwrap().insert(
            0,
            json!({"type": "additional_tools", "role": "developer", "tools": [function.clone()]}),
        );
        assert!(ensure_web_search_declared_for_history(&mut body, true));
        assert_eq!(body["input"][0]["tools"][0], function);
        assert_eq!(body["input"][0]["tools"][1]["type"], "web_search");
        assert_eq!(body["input"][3]["type"], "compaction_trigger");
        assert_eq!(body["tool_choice"], "auto");
        assert!(body.get("tools").is_none());
    }

    #[test]
    fn search_history_lite_fills_empty_additional_tools_and_handles_no_trigger() {
        for tools in [None, Some(Value::Null), Some(json!([]))] {
            let mut item = json!({"type": "additional_tools", "role": "developer"});
            if let Some(tools) = tools {
                item["tools"] = tools;
            }
            let mut body = json!({"input": [item, history()[1].clone()]});
            assert!(ensure_web_search_declared_for_history(&mut body, true));
            assert_eq!(body["input"].as_array().unwrap().len(), 2);
            assert_eq!(body["input"][0]["tools"][0]["type"], "web_search");
            assert_eq!(body["tool_choice"], "none");
        }
        let mut body = json!({"input": [history()[1].clone()]});
        assert!(ensure_web_search_declared_for_history(&mut body, true));
        assert_eq!(body["input"][1]["type"], "additional_tools");
    }

    #[test]
    fn search_history_lite_fallback_restores_injected_declaration_to_standard_tools() {
        let mut body = json!({"input": history()});
        assert!(ensure_web_search_declared_for_history(&mut body, true));
        let mut fallback =
            super::super::openai_compat::normalize_codex_responses_lite_fallback_request(body);
        assert_eq!(fallback["input"], history());
        assert_eq!(fallback["tools"][0]["type"], "web_search");
        assert_eq!(fallback["tool_choice"], "none");
        assert!(!ensure_web_search_declared_for_history(
            &mut fallback,
            false
        ));
    }

    #[test]
    fn search_history_does_not_rewrite_unrelated_or_malformed_requests() {
        for mut body in [
            Value::Null,
            json!({"input": "web_search_call"}),
            json!({"input": [{"type": "message", "content": "web_search_call"}]}),
            json!({"input": history(), "tools": "invalid"}),
        ] {
            let original = body.clone();
            assert!(!ensure_web_search_declared_for_history(&mut body, false));
            assert_eq!(body, original);
        }
        let mut body = json!({"input": [{"type": "additional_tools", "tools": "invalid"}, history()[1].clone()]});
        let original = body.clone();
        assert!(!ensure_web_search_declared_for_history(&mut body, true));
        assert_eq!(body, original);
    }

    #[test]
    fn search_history_scope_excludes_other_apps_transports_models_and_standalone_compact() {
        use crate::app_config::AppType;
        for (app, endpoint, model, native, official, expected) in [
            (
                AppType::Codex,
                "/v1/responses",
                "gpt-6.1-sol",
                true,
                false,
                true,
            ),
            (
                AppType::Codex,
                "/responses?x=1",
                "codex-latest",
                true,
                false,
                true,
            ),
            (
                AppType::Codex,
                "/v1/responses",
                "official-alias",
                true,
                true,
                true,
            ),
            (
                AppType::Claude,
                "/v1/responses",
                "gpt-6.1-sol",
                true,
                false,
                false,
            ),
            (
                AppType::GrokBuild,
                "/v1/responses",
                "gpt-6.1-sol",
                true,
                false,
                false,
            ),
            (
                AppType::Codex,
                "/v1/responses",
                "gpt-6.1-sol",
                false,
                false,
                false,
            ),
            (
                AppType::Codex,
                "/v1/chat/completions",
                "gpt-6.1-sol",
                true,
                false,
                false,
            ),
            (
                AppType::Codex,
                "/v1/responses/compact?x=1",
                "gpt-6.1-sol",
                true,
                true,
                false,
            ),
            (
                AppType::Codex,
                "/responses/compact",
                "gpt-6.1-sol",
                true,
                true,
                false,
            ),
            (
                AppType::Codex,
                "/v1/responses",
                "deepseek-v4",
                true,
                false,
                false,
            ),
            (
                AppType::Codex,
                "/v1/responses",
                "grok-4",
                true,
                false,
                false,
            ),
            (
                AppType::Codex,
                "/v1/responses",
                "qwen3.8",
                true,
                false,
                false,
            ),
        ] {
            let mut body = json!({"model": model, "input": history()});
            let original = body.clone();
            assert_eq!(
                repair_codex_web_search_history(&app, endpoint, &mut body, false, native, official),
                expected
            );
            if !expected {
                assert_eq!(body, original);
            }
        }
    }
}
