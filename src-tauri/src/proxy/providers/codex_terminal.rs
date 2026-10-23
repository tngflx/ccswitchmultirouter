//! Shared terminal semantics for Codex protocol adapters.
//!
//! Transport closure is deliberately excluded from these decisions. Callers
//! must provide the upstream protocol's explicit terminal signal together
//! with the structured output they successfully decoded.

use serde::Deserialize;
use serde_json::Value;
use std::sync::OnceLock;

// Embedded into the renderer by codex_desktop.rs as well. Marker vocabulary,
// extraction paths, separators, and category precedence have one source.
pub(crate) const TERMINAL_ERROR_POLICY_JSON: &str = include_str!("terminal_error_policy.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminalErrorCategory {
    code: String,
    markers: Vec<String>,
    serialized_markers: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminalErrorPolicy {
    schema_version: u8,
    ignored_separators: Vec<char>,
    summary_paths: Vec<String>,
    serialized_paths: Vec<String>,
    cancelled_events: Vec<String>,
    cancelled_code: String,
    categories: Vec<TerminalErrorCategory>,
}

impl TerminalErrorPolicy {
    fn normalize(&self, value: &str) -> String {
        value
            .chars()
            .filter(|ch| !self.ignored_separators.contains(ch))
            .map(|ch| ch.to_ascii_lowercase())
            .collect()
    }
}

fn terminal_error_policy() -> &'static TerminalErrorPolicy {
    static POLICY: OnceLock<TerminalErrorPolicy> = OnceLock::new();
    POLICY.get_or_init(|| {
        let mut policy: TerminalErrorPolicy = serde_json::from_str(TERMINAL_ERROR_POLICY_JSON)
            .expect("embedded terminal-error policy must be valid");
        assert_eq!(
            policy.schema_version, 1,
            "unsupported terminal-error policy"
        );
        assert!(
            !policy.categories.is_empty() && !policy.cancelled_code.is_empty(),
            "terminal-error policy must preserve permanent guards"
        );
        let mut categories = std::mem::take(&mut policy.categories);
        for category in &mut categories {
            assert!(
                !category.code.is_empty() && !category.markers.is_empty(),
                "terminal-error categories must contain a code and markers"
            );
            let markers: Vec<_> = category
                .markers
                .iter()
                .map(|marker| policy.normalize(marker))
                .collect();
            let serialized_markers = category.serialized_markers.as_ref().map(|markers| {
                markers
                    .iter()
                    .map(|marker| policy.normalize(marker))
                    .collect::<Vec<_>>()
            });
            assert!(
                markers.iter().all(|marker| !marker.is_empty())
                    && serialized_markers
                        .as_ref()
                        .is_none_or(|markers| !markers.is_empty()
                            && markers.iter().all(|marker| !marker.is_empty())),
                "terminal-error markers must not normalize to an empty string"
            );
            category.markers = markers;
            category.serialized_markers = serialized_markers;
        }
        policy.categories = categories;
        policy
    })
}

/// Map a decoded terminal payload to one stable category shared by reconnect
/// and Desktop continuation boundaries. The callers can still choose their
/// protocol-specific wire message while this function owns marker precedence.
pub(crate) fn terminal_error_code(event_name: &str, payload: &Value) -> Option<&'static str> {
    let policy = terminal_error_policy();
    if policy
        .cancelled_events
        .iter()
        .any(|event| event == event_name)
    {
        return Some(&policy.cancelled_code);
    }
    // Keep fields separate: joining an unrelated code and message must not
    // manufacture a permanent marker across their boundary.
    let summary: Vec<_> = policy
        .summary_paths
        .iter()
        .filter_map(|pointer| payload.pointer(pointer))
        .filter_map(Value::as_str)
        .map(|value| policy.normalize(value))
        .collect();
    // Preserve the renderer's conservative guards for nested error details and
    // keys. JSON punctuation keeps separate fields from forming new markers.
    let serialized: Vec<_> = policy
        .serialized_paths
        .iter()
        .filter_map(|pointer| payload.pointer(pointer))
        .map(|value| policy.normalize(&value.to_string()))
        .collect();
    policy.categories.iter().find_map(|category| {
        let serialized_markers = category
            .serialized_markers
            .as_ref()
            .unwrap_or(&category.markers);
        (summary
            .iter()
            .any(|value| category.markers.iter().any(|marker| value.contains(marker)))
            || serialized.iter().any(|value| {
                serialized_markers
                    .iter()
                    .any(|marker| value.contains(marker))
            }))
        .then_some(category.code.as_str())
    })
}

/// Apply the same terminal policy to structured provider errors and plaintext
/// gateway responses. HTTP 429/5xx must not turn a quota or authentication
/// rejection into a transient failure merely because its body is not JSON.
pub(crate) fn terminal_error_code_from_body(body: &str) -> Option<&'static str> {
    let payload =
        serde_json::from_str::<Value>(body).unwrap_or_else(|_| Value::String(body.to_string()));
    terminal_error_code("response.failed", &payload)
}

/// Shared transient HTTP statuses for stream reconnection and a new Desktop
/// continuation. A permanent error body always takes precedence at callers.
pub(crate) fn http_error_status_is_retryable(status: u16) -> bool {
    matches!(status, 408 | 425 | 429 | 500..=599)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ChatTerminalEvidence {
    pub(crate) has_final_message: bool,
    pub(crate) valid_tool_calls: usize,
    pub(crate) dropped_tool_calls: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TerminalDisposition {
    Completed,
    Incomplete { reason: &'static str },
    Failed { code: &'static str, message: String },
}

impl TerminalDisposition {
    pub(crate) fn status(&self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Incomplete { .. } => "incomplete",
            Self::Failed { .. } => "failed",
        }
    }
}

pub(crate) fn classify_chat_terminal(
    finish_reason: Option<&str>,
    evidence: ChatTerminalEvidence,
) -> TerminalDisposition {
    match finish_reason {
        Some("length") => TerminalDisposition::Incomplete {
            reason: "max_output_tokens",
        },
        Some("content_filter") => TerminalDisposition::Incomplete {
            reason: "content_filter",
        },
        Some(reason @ ("tool_calls" | "function_call")) => {
            if evidence.dropped_tool_calls > 0 {
                TerminalDisposition::Failed {
                    code: "upstream_tool_call_dropped",
                    message: format!(
                        "Upstream returned {} structurally incomplete tool call(s); the turn cannot complete after dropping requested actions",
                        evidence.dropped_tool_calls
                    ),
                }
            } else if evidence.valid_tool_calls > 0 {
                TerminalDisposition::Completed
            } else {
                TerminalDisposition::Failed {
                    code: "upstream_tool_call_missing",
                    message: format!(
                        "Upstream finish_reason={reason} did not include a complete tool call"
                    ),
                }
            }
        }
        Some("stop") => {
            if evidence.dropped_tool_calls > 0 {
                TerminalDisposition::Failed {
                    code: "upstream_tool_call_dropped",
                    message: format!(
                        "Upstream returned {} structurally incomplete tool call(s); the turn cannot complete after dropping requested actions",
                        evidence.dropped_tool_calls
                    ),
                }
            } else if evidence.has_final_message || evidence.valid_tool_calls > 0 {
                TerminalDisposition::Completed
            } else {
                TerminalDisposition::Failed {
                    code: "upstream_final_output_missing",
                    message: "Upstream finish_reason=stop did not include a final output message or complete tool call"
                        .to_string(),
                }
            }
        }
        None => TerminalDisposition::Failed {
            code: "upstream_finish_reason_missing",
            message: "Upstream Chat Completions response ended without finish_reason".to_string(),
        },
        Some(reason) => TerminalDisposition::Failed {
            code: "upstream_finish_reason_unknown",
            message: format!("Upstream returned unknown finish_reason={reason}"),
        },
    }
}

pub(crate) fn chat_tool_arguments_are_complete(arguments: Option<&Value>) -> bool {
    match arguments {
        None => true,
        Some(Value::String(arguments)) => streamed_tool_arguments_are_complete(arguments),
        Some(Value::Null) => false,
        Some(_) => true,
    }
}

pub(crate) fn streamed_tool_arguments_are_complete(arguments: &str) -> bool {
    let arguments = arguments.trim();
    arguments.is_empty() || serde_json::from_str::<Value>(arguments).is_ok()
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct NativeResponsesEvidence {
    pub(crate) has_final_message: bool,
    pub(crate) has_compaction_output: bool,
    pub(crate) valid_tool_calls: usize,
    pub(crate) dropped_tool_calls: usize,
}

impl NativeResponsesEvidence {
    pub(crate) fn observe_event(&mut self, event_name: &str, payload: &Value) {
        match event_name {
            "response.output_text.delta" | "response.output_text.done" => {
                self.has_final_message |= payload
                    .get(if event_name.ends_with(".delta") {
                        "delta"
                    } else {
                        "text"
                    })
                    .and_then(Value::as_str)
                    .is_some_and(|text| !text.trim().is_empty());
            }
            "response.refusal.delta" | "response.refusal.done" => {
                self.has_final_message |= payload
                    .get(if event_name.ends_with(".delta") {
                        "delta"
                    } else {
                        "refusal"
                    })
                    .and_then(Value::as_str)
                    .is_some_and(|text| !text.trim().is_empty());
            }
            "response.output_item.done" => {
                if let Some(item) = payload.get("item") {
                    self.observe_output_item(item);
                }
            }
            "response.completed" => {
                if let Some(output) = payload
                    .pointer("/response/output")
                    .and_then(Value::as_array)
                {
                    for item in output {
                        self.observe_output_item(item);
                    }
                }
            }
            _ => {}
        }
    }

    fn observe_output_item(&mut self, item: &Value) {
        match item.get("type").and_then(Value::as_str) {
            Some("message") => {
                self.has_final_message |= item
                    .get("content")
                    .and_then(Value::as_array)
                    .is_some_and(|content| content.iter().any(is_nonempty_final_content));
            }
            Some("compaction") => {
                self.has_compaction_output |= is_nonempty_string(item.get("encrypted_content"));
            }
            Some(item_type) if is_client_tool_call_type(item_type) => {
                if is_complete_client_tool_call(item_type, item) {
                    self.valid_tool_calls += 1;
                } else {
                    self.dropped_tool_calls += 1;
                }
            }
            _ => {}
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NativeResponsesTerminalDisposition {
    Completed,
    Incomplete,
    Failed,
    ProtocolError { code: &'static str, message: String },
}

pub(crate) fn classify_native_responses_terminal(
    event_name: &str,
    payload: &Value,
    evidence: NativeResponsesEvidence,
) -> Option<NativeResponsesTerminalDisposition> {
    let response_status = payload.pointer("/response/status").and_then(Value::as_str);

    match event_name {
        "response.completed" => {
            if response_status != Some("completed") {
                return Some(NativeResponsesTerminalDisposition::ProtocolError {
                    code: "upstream_terminal_status_mismatch",
                    message: format!(
                        "Upstream response.completed carried status={}",
                        response_status.unwrap_or("missing")
                    ),
                });
            }
            if evidence.dropped_tool_calls > 0 {
                return Some(NativeResponsesTerminalDisposition::ProtocolError {
                    code: "upstream_tool_call_dropped",
                    message: format!(
                        "Upstream response.completed included {} structurally incomplete client tool call(s); the turn cannot complete after dropping requested actions",
                        evidence.dropped_tool_calls
                    ),
                });
            }
            if evidence.has_final_message
                || evidence.has_compaction_output
                || evidence.valid_tool_calls > 0
            {
                Some(NativeResponsesTerminalDisposition::Completed)
            } else {
                Some(NativeResponsesTerminalDisposition::ProtocolError {
                    code: "upstream_final_output_missing",
                    message: "Upstream response.completed did not include final output text, refusal, compaction output, or a complete client tool call".to_string(),
                })
            }
        }
        "response.incomplete" => {
            if response_status.is_some_and(|status| status != "incomplete") {
                Some(NativeResponsesTerminalDisposition::ProtocolError {
                    code: "upstream_terminal_status_mismatch",
                    message: format!(
                        "Upstream response.incomplete carried status={}",
                        response_status.unwrap_or("missing")
                    ),
                })
            } else {
                Some(NativeResponsesTerminalDisposition::Incomplete)
            }
        }
        "response.failed" => {
            if response_status.is_some_and(|status| status != "failed") {
                Some(NativeResponsesTerminalDisposition::ProtocolError {
                    code: "upstream_terminal_status_mismatch",
                    message: format!(
                        "Upstream response.failed carried status={}",
                        response_status.unwrap_or("missing")
                    ),
                })
            } else {
                Some(NativeResponsesTerminalDisposition::Failed)
            }
        }
        "error" | "response.error" | "response.cancelled" | "response.canceled"
        | "response.aborted" => Some(NativeResponsesTerminalDisposition::Failed),
        _ => None,
    }
}

fn is_nonempty_string(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
}

fn is_nonempty_final_content(content: &Value) -> bool {
    match content.get("type").and_then(Value::as_str) {
        Some("output_text") => is_nonempty_string(content.get("text")),
        Some("refusal") => is_nonempty_string(content.get("refusal")),
        _ => false,
    }
}

fn is_client_tool_call_type(item_type: &str) -> bool {
    matches!(
        item_type,
        "function_call"
            | "custom_tool_call"
            | "tool_search_call"
            | "local_shell_call"
            | "shell_call"
    )
}

fn is_complete_client_tool_call(item_type: &str, item: &Value) -> bool {
    let status_is_usable = item
        .get("status")
        .and_then(Value::as_str)
        .is_none_or(|status| status == "completed");
    if !status_is_usable || !is_nonempty_string(item.get("call_id")) {
        return false;
    }

    match item_type {
        "function_call" => {
            is_nonempty_string(item.get("name"))
                && item
                    .get("arguments")
                    .and_then(Value::as_str)
                    .is_some_and(|arguments| {
                        !arguments.trim().is_empty()
                            && streamed_tool_arguments_are_complete(arguments)
                    })
        }
        "custom_tool_call" => {
            is_nonempty_string(item.get("name")) && is_nonempty_string(item.get("input"))
        }
        "tool_search_call" => {
            item.get("execution").and_then(Value::as_str) == Some("client")
                && item
                    .get("arguments")
                    .is_some_and(|arguments| !arguments.is_null())
        }
        "local_shell_call" | "shell_call" => {
            item.get("action").is_some_and(|action| action.is_object())
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn retryable_http_statuses_are_shared_by_reconnect_and_continuation() {
        for status in [408, 425, 429, 500, 502, 503, 504, 599] {
            assert!(http_error_status_is_retryable(status), "HTTP {status}");
        }
        for status in [200, 400, 401, 402, 403, 404, 409, 422, 499, 600] {
            assert!(!http_error_status_is_retryable(status), "HTTP {status}");
        }
    }

    #[test]
    fn terminal_error_body_uses_shared_policy_for_json_and_plaintext() {
        for (body, expected) in [
            ("Daily quota exhausted", Some("insufficient_quota")),
            ("Daily usage limit reached", Some("insufficient_quota")),
            ("Billing payment required", Some("insufficient_quota")),
            ("Token expired", Some("authentication_error")),
            ("Permission denied", Some("permission_denied")),
            ("Context length exceeded", Some("context_length_exceeded")),
            (
                r#"{"error":{"code":"daily_limit","message":"redacted rejection"}}"#,
                Some("insufficient_quota"),
            ),
            (
                r#"{"response":{"error":{"code":"token_expired"}}}"#,
                Some("authentication_error"),
            ),
            (r#""Daily quota exhausted""#, Some("insufficient_quota")),
            ("Our servers are currently overloaded", None),
            ("Connection reset before completion", None),
            ("HTTP 429, retry later", None),
            (
                r#"{"error":{"type":"server_error","message":"Service temporarily overloaded","metadata":{"quota_remaining":42}}}"#,
                None,
            ),
        ] {
            assert_eq!(terminal_error_code_from_body(body), expected);
        }
    }

    #[test]
    fn terminal_error_policy_shared_contract() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/terminalErrorPolicy.json"
        ))
        .expect("parse shared terminal-error fixtures");
        for case in cases {
            assert_eq!(
                terminal_error_code(
                    case["event"].as_str().unwrap(),
                    &json!({ "error": case["error"] }),
                ),
                case["expectedCode"].as_str(),
                "{}",
                case["name"],
            );
        }
    }

    #[test]
    fn chat_terminal_never_completes_after_dropping_any_tool_call() {
        for (finish_reason, evidence) in [
            (
                "tool_calls",
                ChatTerminalEvidence {
                    has_final_message: false,
                    valid_tool_calls: 1,
                    dropped_tool_calls: 1,
                },
            ),
            (
                "stop",
                ChatTerminalEvidence {
                    has_final_message: true,
                    valid_tool_calls: 0,
                    dropped_tool_calls: 1,
                },
            ),
        ] {
            assert!(matches!(
                classify_chat_terminal(Some(finish_reason), evidence),
                TerminalDisposition::Failed {
                    code: "upstream_tool_call_dropped",
                    ..
                }
            ));
        }
    }

    #[test]
    fn responses_terminal_never_completes_after_dropping_any_tool_call() {
        let terminal = json!({
            "response": {
                "status": "completed"
            }
        });
        let disposition = classify_native_responses_terminal(
            "response.completed",
            &terminal,
            NativeResponsesEvidence {
                has_final_message: true,
                has_compaction_output: false,
                valid_tool_calls: 1,
                dropped_tool_calls: 1,
            },
        );

        assert!(matches!(
            disposition,
            Some(NativeResponsesTerminalDisposition::ProtocolError {
                code: "upstream_tool_call_dropped",
                ..
            })
        ));
    }
}
