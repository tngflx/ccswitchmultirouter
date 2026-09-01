//! Provider-neutral request diagnostics and conservative transport optimization.
//!
//! This module deliberately operates on the final JSON body immediately before
//! serialization. It never stores prompt text, tool arguments, or tool output.
//! Diagnostics contain only byte counts, item kinds, structural findings, and
//! redacted routing identifiers.

use crate::settings::{RequestHealthConfig, RequestOptimizationMode};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};

const MAX_DIAGNOSTICS: usize = 100;
const LARGE_ITEM_BYTES: usize = 64 * 1024;
const ESTIMATED_BYTES_PER_TOKEN: usize = 4;

#[derive(Debug, Clone)]
pub(crate) struct RequestHealthContext<'a> {
    pub trace_id: Option<&'a str>,
    pub session_id: &'a str,
    pub app_type: &'a str,
    pub provider_id: &'a str,
    pub provider_name: &'a str,
    pub model: &'a str,
    pub endpoint: &'a str,
    pub client_request_bytes: usize,
    pub compaction_request: bool,
    pub session_client_provided: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RequestHealthBreakdown {
    pub category: String,
    pub item_count: usize,
    pub bytes: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RequestHealthFinding {
    pub code: String,
    pub severity: String,
    pub count: usize,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestHealthDiagnostic {
    pub generated_at: String,
    pub trace_id: Option<String>,
    pub session_id: String,
    pub app_type: String,
    pub provider_id: String,
    pub provider_name: String,
    pub model: String,
    pub endpoint: String,
    pub client_request_bytes: usize,
    pub original_bytes: usize,
    pub optimized_bytes: usize,
    pub bytes_removed: usize,
    pub threshold_bytes: usize,
    pub threshold_exceeded: bool,
    pub estimated_input_tokens: usize,
    pub max_input_tokens: usize,
    pub token_limit_exceeded: bool,
    pub blocked: bool,
    pub item_count: usize,
    pub largest_item_bytes: usize,
    pub largest_item_category: Option<String>,
    pub optimization_mode: RequestOptimizationMode,
    pub optimization_applied: bool,
    pub compaction_request: bool,
    pub compaction_recommended: bool,
    pub session_client_provided: bool,
    pub findings: Vec<RequestHealthFinding>,
    pub breakdown: Vec<RequestHealthBreakdown>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestHealthSnapshot {
    pub config: RequestHealthConfig,
    pub diagnostics: Vec<RequestHealthDiagnostic>,
}

#[derive(Default)]
struct Analysis {
    item_count: usize,
    largest_item_bytes: usize,
    largest_item_category: Option<String>,
    breakdown: HashMap<String, (usize, usize)>,
    calls: HashSet<String>,
    duplicate_calls: usize,
    outputs: Vec<String>,
}

static DIAGNOSTICS: OnceLock<Mutex<VecDeque<RequestHealthDiagnostic>>> = OnceLock::new();

fn diagnostics_store() -> &'static Mutex<VecDeque<RequestHealthDiagnostic>> {
    DIAGNOSTICS.get_or_init(|| Mutex::new(VecDeque::with_capacity(MAX_DIAGNOSTICS)))
}

pub fn snapshot(config: RequestHealthConfig) -> RequestHealthSnapshot {
    let diagnostics = diagnostics_store()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .rev()
        .cloned()
        .collect();
    RequestHealthSnapshot {
        config,
        diagnostics,
    }
}

pub(crate) fn inspect_and_optimize(
    body: &mut Value,
    config: &RequestHealthConfig,
    context: RequestHealthContext<'_>,
) -> Option<RequestHealthDiagnostic> {
    if !config.enabled {
        return None;
    }

    let original_bytes = serialized_len(body);
    let mut analysis = Analysis::default();
    analyze_conversation_items(body, &mut analysis);

    let optimization_applied = config.optimization_mode == RequestOptimizationMode::Safe;
    if optimization_applied {
        remove_safe_transport_metadata(body);
    }
    let optimized_bytes = serialized_len(body);
    let threshold_bytes = config.large_request_threshold_bytes.max(64 * 1024) as usize;
    let threshold_exceeded = optimized_bytes >= threshold_bytes;
    let estimated_input_tokens = optimized_bytes.div_ceil(ESTIMATED_BYTES_PER_TOKEN);
    let max_input_tokens = config.max_codex_input_tokens.max(1) as usize;
    let token_limit_exceeded = estimated_input_tokens > max_input_tokens;
    // Request Health is diagnostic-only. Rejecting a normal turn here can
    // prevent Codex from reaching its own visible compaction boundary.
    let blocked = false;

    let mut findings = Vec::new();
    let orphaned_outputs = analysis
        .outputs
        .iter()
        .filter(|call_id| !analysis.calls.contains(*call_id))
        .count();
    if orphaned_outputs > 0 {
        findings.push(RequestHealthFinding {
            code: "orphaned_tool_output".to_string(),
            severity: "error".to_string(),
            count: orphaned_outputs,
            detail: format!(
                "{orphaned_outputs} tool output item(s) reference a call_id that is absent from the replayed request history"
            ),
        });
    }
    if analysis.duplicate_calls > 0 {
        findings.push(RequestHealthFinding {
            code: "duplicate_tool_call_id".to_string(),
            severity: "warning".to_string(),
            count: analysis.duplicate_calls,
            detail: format!(
                "{} duplicate tool call identifier(s) were found",
                analysis.duplicate_calls
            ),
        });
    }
    if analysis.largest_item_bytes >= LARGE_ITEM_BYTES {
        findings.push(RequestHealthFinding {
            code: "large_history_item".to_string(),
            severity: "warning".to_string(),
            count: 1,
            detail: format!(
                "The largest replayed item is {} bytes ({})",
                analysis.largest_item_bytes,
                analysis
                    .largest_item_category
                    .as_deref()
                    .unwrap_or("unknown")
            ),
        });
    }
    if threshold_exceeded {
        findings.push(RequestHealthFinding {
            code: "large_request".to_string(),
            severity: "warning".to_string(),
            count: 1,
            detail: format!(
                "The final request body is {optimized_bytes} bytes, above the configured {threshold_bytes}-byte threshold"
            ),
        });
    }
    if token_limit_exceeded {
        findings.push(RequestHealthFinding {
            code: "codex_input_token_limit".to_string(),
            severity: "error".to_string(),
            count: 1,
            detail: format!(
                "The request is estimated at {estimated_input_tokens} input tokens, above the configured {max_input_tokens}-token ceiling"
            ),
        });
    }

    let mut breakdown = analysis
        .breakdown
        .into_iter()
        .map(|(category, (item_count, bytes))| RequestHealthBreakdown {
            category,
            item_count,
            bytes,
        })
        .collect::<Vec<_>>();
    breakdown.sort_by(|left, right| {
        right
            .bytes
            .cmp(&left.bytes)
            .then_with(|| left.category.cmp(&right.category))
    });

    let diagnostic = RequestHealthDiagnostic {
        generated_at: chrono::Utc::now().to_rfc3339(),
        trace_id: context.trace_id.map(ToString::to_string),
        session_id: context.session_id.to_string(),
        app_type: context.app_type.to_string(),
        provider_id: context.provider_id.to_string(),
        provider_name: context.provider_name.to_string(),
        model: context.model.to_string(),
        endpoint: context.endpoint.to_string(),
        client_request_bytes: context.client_request_bytes,
        original_bytes,
        optimized_bytes,
        bytes_removed: original_bytes.saturating_sub(optimized_bytes),
        threshold_bytes,
        threshold_exceeded,
        estimated_input_tokens,
        max_input_tokens,
        token_limit_exceeded,
        blocked,
        item_count: analysis.item_count,
        largest_item_bytes: analysis.largest_item_bytes,
        largest_item_category: analysis.largest_item_category,
        optimization_mode: config.optimization_mode,
        optimization_applied,
        compaction_request: context.compaction_request,
        compaction_recommended: token_limit_exceeded
            && !context.compaction_request
            && context.app_type == "codex"
            && context.session_client_provided,
        session_client_provided: context.session_client_provided,
        findings,
        breakdown,
    };

    let mut store = diagnostics_store()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if store.len() == MAX_DIAGNOSTICS {
        store.pop_front();
    }
    store.push_back(diagnostic.clone());
    Some(diagnostic)
}

fn serialized_len(value: &Value) -> usize {
    serde_json::to_vec(value).map_or(0, |bytes| bytes.len())
}

fn analyze_conversation_items(body: &Value, analysis: &mut Analysis) {
    let Some(object) = body.as_object() else {
        return;
    };
    let items = ["input", "messages", "contents"]
        .into_iter()
        .find_map(|key| object.get(key).and_then(Value::as_array));
    let Some(items) = items else {
        return;
    };

    for item in items {
        let bytes = serialized_len(item);
        let category = item_category(item);
        analysis.item_count += 1;
        let entry = analysis.breakdown.entry(category.clone()).or_default();
        entry.0 += 1;
        entry.1 += bytes;
        if bytes > analysis.largest_item_bytes {
            analysis.largest_item_bytes = bytes;
            analysis.largest_item_category = Some(category);
        }

        let Some(object) = item.as_object() else {
            continue;
        };
        let item_type = object.get("type").and_then(Value::as_str).unwrap_or("");
        if is_call_type(item_type) {
            if let Some(call_id) = structural_id(object) {
                if !analysis.calls.insert(call_id.to_string()) {
                    analysis.duplicate_calls += 1;
                }
            }
        } else if is_output_type(item_type) {
            if let Some(call_id) = structural_id(object) {
                analysis.outputs.push(call_id.to_string());
            }
        }
    }
}

fn item_category(item: &Value) -> String {
    let Some(object) = item.as_object() else {
        return "scalar".to_string();
    };
    if let Some(item_type) = object.get("type").and_then(Value::as_str) {
        if !item_type.is_empty() {
            return item_type.to_string();
        }
    }
    object
        .get("role")
        .and_then(Value::as_str)
        .map(|role| format!("message:{role}"))
        .unwrap_or_else(|| "object".to_string())
}

fn structural_id(object: &Map<String, Value>) -> Option<&str> {
    object
        .get("call_id")
        .or_else(|| object.get("tool_call_id"))
        .or_else(|| object.get("id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn is_call_type(item_type: &str) -> bool {
    matches!(
        item_type,
        "function_call"
            | "custom_tool_call"
            | "mcp_tool_call"
            | "tool_search_call"
            | "local_shell_call"
            | "computer_call"
    )
}

fn is_output_type(item_type: &str) -> bool {
    matches!(
        item_type,
        "function_call_output"
            | "custom_tool_call_output"
            | "mcp_tool_call_output"
            | "tool_search_output"
            | "computer_call_output"
    )
}

fn remove_safe_transport_metadata(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.remove("internal_chat_message_metadata_passthrough");
            for child in object.values_mut() {
                remove_safe_transport_metadata(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                remove_safe_transport_metadata(item);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn context() -> RequestHealthContext<'static> {
        RequestHealthContext {
            trace_id: Some("trace-1"),
            session_id: "session-1",
            app_type: "codex",
            provider_id: "provider-1",
            provider_name: "Provider One",
            model: "model-1",
            endpoint: "/responses",
            client_request_bytes: 0,
            compaction_request: false,
            session_client_provided: true,
        }
    }

    #[test]
    fn reports_orphaned_tool_outputs_without_storing_content() {
        let mut body = json!({
            "input": [{
                "type": "function_call_output",
                "call_id": "missing-call",
                "output": "secret tool output"
            }]
        });
        let diagnostic =
            inspect_and_optimize(&mut body, &RequestHealthConfig::default(), context())
                .expect("diagnostic");

        assert!(diagnostic
            .findings
            .iter()
            .any(|finding| finding.code == "orphaned_tool_output"));
        let serialized = serde_json::to_string(&diagnostic).expect("serialize diagnostic");
        assert!(!serialized.contains("secret tool output"));
    }

    #[test]
    fn safe_mode_removes_only_known_transport_metadata() {
        let mut body = json!({
            "input": [{
                "type": "message",
                "role": "user",
                "content": "keep",
                "internal_chat_message_metadata_passthrough": {"secret": true}
            }]
        });
        let diagnostic =
            inspect_and_optimize(&mut body, &RequestHealthConfig::default(), context())
                .expect("diagnostic");

        assert_eq!(body["input"][0]["content"], "keep");
        assert!(body["input"][0]
            .get("internal_chat_message_metadata_passthrough")
            .is_none());
        assert!(diagnostic.bytes_removed > 0);
    }

    #[test]
    fn diagnose_mode_does_not_mutate_request() {
        let mut body = json!({
            "input": [{
                "type": "message",
                "internal_chat_message_metadata_passthrough": {"value": 1}
            }]
        });
        let original = body.clone();
        let config = RequestHealthConfig {
            optimization_mode: RequestOptimizationMode::Diagnose,
            ..RequestHealthConfig::default()
        };

        inspect_and_optimize(&mut body, &config, context()).expect("diagnostic");
        assert_eq!(body, original);
    }

    #[test]
    fn oversized_turns_are_diagnostic_only_and_never_blocked() {
        let config = RequestHealthConfig::default();
        let mut oversized_context = context();
        oversized_context.session_id = "session-oversized-diagnostic-only";
        oversized_context.trace_id = Some("trace-oversized-first");
        let mut body = json!({
            "input": [{"type": "message", "content": "x".repeat(1_200_000)}]
        });
        let first = inspect_and_optimize(&mut body, &config, oversized_context.clone())
            .expect("diagnostic");
        assert!(first.token_limit_exceeded);
        assert!(!first.blocked);
        assert!(first.compaction_recommended);

        oversized_context.trace_id = Some("trace-oversized-second");
        let second = inspect_and_optimize(&mut body, &config, oversized_context.clone())
            .expect("diagnostic");
        assert!(second.token_limit_exceeded);
        assert!(!second.blocked);

        let mut smaller = json!({
            "input": [{"type": "message", "content": "x".repeat(80_000)}]
        });
        oversized_context.trace_id = Some("trace-oversized-reduced");
        let reduced = inspect_and_optimize(&mut smaller, &config, oversized_context.clone())
            .expect("diagnostic");
        assert!(!reduced.token_limit_exceeded);
        assert!(!reduced.compaction_recommended);
        assert!(!reduced.blocked);

        let mut compaction_context = oversized_context;
        compaction_context.trace_id = Some("trace-compaction");
        compaction_context.compaction_request = true;
        let compaction = inspect_and_optimize(&mut body, &config, compaction_context)
            .expect("compaction diagnostic");
        assert!(compaction.token_limit_exceeded);
        assert!(!compaction.compaction_recommended);
        assert!(!compaction.blocked);
    }

    #[test]
    fn recommends_native_compaction_only_for_real_codex_thread_ids() {
        let mut body = json!({"input": [{"type": "message", "content": "x".repeat(1_200_000)}]});
        let mut missing_thread = context();
        missing_thread.session_client_provided = false;
        let without_thread =
            inspect_and_optimize(&mut body, &RequestHealthConfig::default(), missing_thread)
                .expect("diagnostic");
        assert!(!without_thread.compaction_recommended);

        let mut non_codex = context();
        non_codex.app_type = "claude";
        let for_other_app =
            inspect_and_optimize(&mut body, &RequestHealthConfig::default(), non_codex)
                .expect("diagnostic");
        assert!(!for_other_app.compaction_recommended);
    }
}
