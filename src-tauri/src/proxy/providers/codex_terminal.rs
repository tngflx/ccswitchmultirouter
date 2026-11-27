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

impl TerminalErrorCategory {
    fn matches(&self, summary: &[String], details: &[String]) -> bool {
        contains_marker(summary, &self.markers)
            || contains_marker(
                details,
                self.serialized_markers.as_deref().unwrap_or(&self.markers),
            )
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TemporaryUsageLimitPolicy {
    category_code: String,
    usage_markers: Vec<String>,
    retry_message_paths: Vec<String>,
    retry_markers: Vec<String>,
    retry_denial_markers: Vec<String>,
    hard_limit_markers: Vec<String>,
    period_limit_markers: PeriodLimitMarkers,
    period_limit_blocking_markers: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PeriodLimitMarkers {
    daily: Vec<String>,
    weekly: Vec<String>,
    monthly: Vec<String>,
}

impl PeriodLimitMarkers {
    fn periods(&self) -> [(&'static str, &[String]); 3] {
        [
            ("Daily", self.daily.as_slice()),
            ("Weekly", self.weekly.as_slice()),
            ("Monthly", self.monthly.as_slice()),
        ]
    }

    fn classify(&self, summary: &[String]) -> Option<&'static str> {
        self.periods()
            .into_iter()
            .find_map(|(period, markers)| contains_marker(summary, markers).then_some(period))
    }

    fn classify_notice(&self, statement: &str) -> Option<&'static str> {
        let limit = ["reached", "exceeded", "exhausted"]
            .into_iter()
            .find_map(|ending| statement.strip_suffix(ending))?;
        if !limit.ends_with("limit") {
            return None;
        }
        self.periods().into_iter().find_map(|(period, markers)| {
            markers
                .iter()
                .any(|marker| marker == statement || marker == limit)
                .then_some(period)
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NonRetryablePolicy {
    category_code: String,
    retryable_paths: Vec<String>,
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
    temporary_usage_limit: TemporaryUsageLimitPolicy,
    non_retryable: NonRetryablePolicy,
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

    fn summary(&self, payload: &Value) -> Vec<String> {
        self.summary_paths
            .iter()
            .filter_map(|pointer| payload.pointer(pointer))
            .filter_map(Value::as_str)
            .map(|value| self.normalize(value))
            .collect()
    }

    fn details(&self, payload: &Value) -> Vec<String> {
        self.serialized_paths
            .iter()
            .filter_map(|pointer| payload.pointer(pointer))
            .map(|value| self.normalize(&value.to_string()))
            .collect()
    }
}

fn contains_marker(values: &[String], markers: &[String]) -> bool {
    values
        .iter()
        .any(|value| markers.iter().any(|marker| value.contains(marker)))
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
            !policy.categories.is_empty()
                && !policy.cancelled_code.is_empty()
                && !policy.non_retryable.category_code.is_empty()
                && !policy.non_retryable.retryable_paths.is_empty(),
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
        assert!(
            policy
                .categories
                .iter()
                .any(|category| category.code == policy.temporary_usage_limit.category_code)
                && !policy.temporary_usage_limit.retry_message_paths.is_empty(),
            "temporary usage-limit policy must preserve a permanent category"
        );
        let normalize_markers = |markers: &mut Vec<String>| {
            assert!(
                !markers.is_empty(),
                "temporary usage-limit markers are required"
            );
            for marker in markers {
                *marker = marker
                    .chars()
                    .filter(|ch| !policy.ignored_separators.contains(ch))
                    .map(|ch| ch.to_ascii_lowercase())
                    .collect();
                assert!(
                    !marker.is_empty(),
                    "temporary usage-limit markers must not be empty"
                );
            }
        };
        normalize_markers(&mut policy.temporary_usage_limit.usage_markers);
        normalize_markers(&mut policy.temporary_usage_limit.retry_markers);
        normalize_markers(&mut policy.temporary_usage_limit.retry_denial_markers);
        normalize_markers(&mut policy.temporary_usage_limit.hard_limit_markers);
        let period_markers = &mut policy.temporary_usage_limit.period_limit_markers;
        normalize_markers(&mut period_markers.daily);
        normalize_markers(&mut period_markers.weekly);
        normalize_markers(&mut period_markers.monthly);
        normalize_markers(&mut policy.temporary_usage_limit.period_limit_blocking_markers);
        policy
    })
}

/// Keep the provider's explicit retry decision while normalizing protocol
/// errors. Only canonical error fields participate; arbitrary request/debug
/// metadata and non-boolean flags do not become provider retry instructions.
/// A denial in any known envelope wins over a positive flag in another.
pub(crate) fn explicit_retry_decision(payload: &Value) -> Option<bool> {
    explicit_retry_decision_from_policy(terminal_error_policy(), payload)
}

fn explicit_retry_decision_from_policy(
    policy: &TerminalErrorPolicy,
    payload: &Value,
) -> Option<bool> {
    let mut decision = None;
    for flag in policy
        .non_retryable
        .retryable_paths
        .iter()
        .filter_map(|pointer| payload.pointer(pointer))
        .filter_map(Value::as_bool)
    {
        if !flag {
            return Some(false);
        }
        decision = Some(true);
    }
    let text_denies_retry = policy
        .summary_paths
        .iter()
        .filter_map(|pointer| payload.pointer(pointer))
        .filter_map(Value::as_str)
        .map(|value| policy.normalize(value))
        .any(|value| {
            policy
                .temporary_usage_limit
                .retry_denial_markers
                .iter()
                .any(|marker| value.contains(marker))
        });
    if text_denies_retry {
        Some(false)
    } else {
        decision
    }
}

fn explicit_retry_denial_matches(policy: &TerminalErrorPolicy, payload: &Value) -> bool {
    explicit_retry_decision_from_policy(policy, payload) == Some(false)
}

fn temporary_usage_limit_matches(policy: &TerminalErrorPolicy, payload: &Value) -> bool {
    if explicit_retry_denial_matches(policy, payload) {
        return false;
    }
    let rule = &policy.temporary_usage_limit;
    let summary = policy.summary(payload);
    let serialized = policy.details(payload);
    // Explicit refusal always wins over a positive substring such as `retry`
    // or `reset`, including a denial in a structured code or nested detail.
    if summary.iter().chain(serialized.iter()).any(|value| {
        rule.retry_denial_markers
            .iter()
            .any(|marker| value.contains(marker))
    }) {
        return false;
    }
    let has_usage_limit = summary.iter().any(|value| {
        rule.usage_markers
            .iter()
            .any(|marker| value.contains(marker))
    });
    let has_retry_window = rule
        .retry_message_paths
        .iter()
        .filter_map(|pointer| payload.pointer(pointer))
        .filter_map(Value::as_str)
        .map(|value| policy.normalize(value))
        .any(|value| {
            rule.retry_markers
                .iter()
                .any(|marker| value.contains(marker))
        });
    let has_hard_limit = summary.iter().chain(serialized.iter()).any(|value| {
        rule.hard_limit_markers
            .iter()
            .any(|marker| value.contains(marker))
    });
    has_usage_limit && has_retry_window && !has_hard_limit
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
    let summary = policy.summary(payload);
    // Preserve the renderer's conservative guards for nested error details and
    // keys. JSON punctuation keeps separate fields from forming new markers.
    let serialized = policy.details(payload);
    let temporary_usage_limit = temporary_usage_limit_matches(policy, payload);
    let category = policy.categories.iter().find_map(|category| {
        // Skip only the ambiguous usage category. Continue checking every
        // other permanent guard so mixed auth/permission/cancellation errors
        // cannot become replayable through a retry message.
        if temporary_usage_limit && category.code == policy.temporary_usage_limit.category_code {
            return None;
        }
        category
            .matches(&summary, &serialized)
            .then_some(category.code.as_str())
    });
    // Preserve the established auth/quota/cancellation reason priority while
    // still stopping unrecognized server errors that explicitly forbid retry.
    category.or_else(|| {
        explicit_retry_denial_matches(policy, payload)
            .then_some(policy.non_retryable.category_code.as_str())
    })
}

/// The canonical narrow exception is shared by safe capacity replay and
/// Desktop continuation. Other permanent categories always keep precedence.
pub(crate) fn is_retryable_usage_limit_payload(payload: &Value) -> bool {
    temporary_usage_limit_matches(terminal_error_policy(), payload)
        && terminal_error_code("response.failed", payload).is_none()
}

/// A hard daily/weekly/monthly usage limit cannot be replayed automatically,
/// but it still identifies a failed Desktop turn that the user may continue
/// after switching providers or waiting for the quota reset. Keep this
/// predicate alongside the terminal policy so the manual continuation path
/// uses the same marker vocabulary and precedence as retry classification.
pub(crate) fn deferred_usage_limit_period(
    event_name: &str,
    payload: &Value,
) -> Option<&'static str> {
    let policy = terminal_error_policy();
    if policy
        .cancelled_events
        .iter()
        .any(|event| event == event_name)
    {
        return None;
    }
    deferred_usage_limit_period_for_payload(policy, payload)
        .or_else(|| deferred_usage_limit_period_in_output(policy, event_name, payload))
}

/// A provider may return its exact usage-limit code without a reset hint.
/// This is enough for manual recovery when the request already has an exact
/// Desktop binding. Keep the automatic retry policy separate.
pub(crate) fn is_deferred_usage_limit(event_name: &str, payload: &Value) -> bool {
    if deferred_usage_limit_period(event_name, payload).is_some() {
        return true;
    }
    let typed_error = ["/response/error", "/error", ""]
        .into_iter()
        .filter_map(|path| payload.pointer(path))
        .any(|error| match (error.get("code"), error.get("type")) {
            (Some(code), Some(kind)) => is_usage_limit_code(code) && is_usage_limit_code(kind),
            (Some(field), None) | (None, Some(field)) => is_usage_limit_code(field),
            (None, None) => false,
        });
    let exact_usage_limit_code = ["/response/error", "/error", ""]
        .into_iter()
        .filter_map(|path| payload.pointer(path))
        .any(|error| {
            ["code", "type"]
                .into_iter()
                .filter_map(|field| error.get(field))
                .any(is_exact_usage_limit_code)
        });
    if !typed_error && !exact_usage_limit_code {
        return false;
    }
    let policy = terminal_error_policy();
    let rule = &policy.temporary_usage_limit;
    let terminal_code = terminal_error_code(event_name, payload);
    let safe_typed_code = terminal_code == Some(rule.category_code.as_str());
    let safe_exact_code = exact_usage_limit_code
        && terminal_code.is_none_or(|code| code == rule.category_code.as_str());
    (safe_typed_code || safe_exact_code)
        && !explicit_retry_denial_matches(policy, payload)
        && [policy.summary(payload), policy.details(payload)]
            .iter()
            .all(|values| {
                !contains_marker(values, &rule.hard_limit_markers)
                    && !contains_marker(values, &rule.retry_denial_markers)
                    && !contains_marker(values, &rule.period_limit_blocking_markers)
                    && !policy.categories.iter().any(|category| {
                        category.code != rule.category_code && category.matches(values, values)
                    })
            })
}

fn is_usage_limit_code(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some("usage_limit_reached" | "USAGE_LIMIT_EXCEEDED")
    )
}

fn is_exact_usage_limit_code(value: &Value) -> bool {
    value.as_str() == Some("USAGE_LIMIT_EXCEEDED")
}

fn deferred_usage_limit_period_in_output(
    policy: &TerminalErrorPolicy,
    event_name: &str,
    payload: &Value,
) -> Option<&'static str> {
    let status = payload.pointer("/response/status").and_then(Value::as_str);
    if !matches!(
        (event_name, status),
        ("response.completed", Some("completed")) | ("response.failed", Some("failed") | None)
    ) {
        return None;
    }
    // Some gateways place the quota notice in a single final assistant
    // message. A structured error takes precedence, even if its code is new.
    let [message] = payload.pointer("/response/output")?.as_array()?.as_slice() else {
        return None;
    };
    if message.get("type").and_then(Value::as_str) != Some("message")
        || message
            .get("role")
            .is_some_and(|role| role.as_str() != Some("assistant"))
    {
        return None;
    }
    let [part] = message.get("content")?.as_array()?.as_slice() else {
        return None;
    };
    let text = match part.get("type").and_then(Value::as_str)? {
        "output_text" => part.get("text"),
        "refusal" => part.get("refusal"),
        _ => None,
    }?
    .as_str()?;
    // The supported notices fit in two short clauses. Skip long replies
    // without scanning or normalizing them as error text.
    if text.len() > 256 {
        return None;
    }
    let text = text.trim();
    let (statement, suffix) = text.split_once(['.', ';']).unwrap_or((text, ""));
    let period = policy
        .temporary_usage_limit
        .period_limit_markers
        .classify_notice(&policy.normalize(statement))?;
    let suffix = suffix.trim().trim_end_matches('.');
    let is_notice = ["", "Please try again later", "Please retry later"]
        .iter()
        .any(|notice| suffix.eq_ignore_ascii_case(notice))
        || suffix.eq_ignore_ascii_case(&format!(
            "The upstream provider's {period} Codex allowance is exhausted"
        ));
    (is_notice
        && ![
            "/response/error",
            "/response/incomplete_details",
            "/error",
            "/code",
            "/message",
        ]
        .iter()
        .filter_map(|pointer| payload.pointer(pointer))
        .any(|field| !field.is_null())
        && !explicit_retry_denial_matches(policy, payload))
    .then_some(period)
}

fn deferred_usage_limit_period_for_payload(
    policy: &TerminalErrorPolicy,
    payload: &Value,
) -> Option<&'static str> {
    let rule = &policy.temporary_usage_limit;
    let summary = policy.summary(payload);
    let period = rule.period_limit_markers.classify(&summary)?;
    if contains_marker(&summary, &rule.period_limit_blocking_markers)
        || explicit_retry_denial_matches(policy, payload)
    {
        return None;
    }
    let details = policy.details(payload);
    (!contains_marker(&details, &rule.period_limit_blocking_markers)
        && !contains_marker(&details, &rule.retry_denial_markers)
        && !policy.categories.iter().any(|category| {
            category.code != rule.category_code && category.matches(&summary, &details)
        }))
    .then_some(period)
}

/// Apply the same terminal policy to structured provider errors and plaintext
/// gateway responses. HTTP 429/5xx must not turn a quota or authentication
/// rejection into a transient failure merely because its body is not JSON.
pub(crate) fn terminal_error_code_from_body(body: &str) -> Option<&'static str> {
    terminal_error_code("response.failed", &terminal_error_payload(body))
}

pub(crate) fn terminal_error_payload(body: &str) -> Value {
    serde_json::from_str(body).unwrap_or_else(|_| Value::String(body.to_owned()))
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
    fn embedded_period_limit_requires_a_standalone_quota_notice() {
        let completed = |content| {
            json!({"response": {
                "status": "completed",
                "output": [{"type": "message", "role": "assistant", "content": content}]
            }})
        };
        for (text, expected) in [
            (
                "Daily usage limit reached. Please try again later.",
                Some("Daily"),
            ),
            (
                "Daily usage limit exceeded. The upstream provider's daily Codex allowance is exhausted.",
                Some("Daily"),
            ),
            ("Weekly limit exceeded.", Some("Weekly")),
            ("Monthly usage limit reached; please retry later", Some("Monthly")),
            ("The code emits 'Daily usage limit reached.'", None),
            ("\"Daily usage limit reached.\"", None),
            ("Daily usage limit reached. I updated the error message.", None),
            ("Daily usage limit reached is the text of the banner.", None),
            ("Daily usage limit reached? Here's what you can do.", None),
            ("Daily usage limit was never reached.", None),
        ] {
            let response = completed(json!([{"type": "output_text", "text": text}]));
            assert_eq!(
                deferred_usage_limit_period("response.completed", &response),
                expected,
                "{text}"
            );
        }

        let response = completed(json!([
            {"type": "output_text", "text": "Daily usage limit reached."},
            {"type": "output_text", "text": "I updated the banner."}
        ]));
        assert_eq!(
            deferred_usage_limit_period("response.completed", &response),
            None
        );

        let response = completed(json!([{
            "type": "output_text",
            "text": format!("{}Daily usage limit reached.", " ".repeat(256))
        }]));
        assert_eq!(
            deferred_usage_limit_period("response.completed", &response),
            None
        );
    }

    #[test]
    fn embedded_period_limit_yields_to_authoritative_terminal_errors() {
        let failed = json!({"response": {
            "status": "failed",
            "error": null,
            "output": [{
                "type": "message",
                "content": [{"type": "refusal", "refusal": "Monthly usage limit exceeded."}]
            }]
        }});
        assert_eq!(
            deferred_usage_limit_period("response.failed", &failed),
            Some("Monthly")
        );

        for error in [
            json!({"code": "invalid_api_key"}),
            json!({"code": "upstream_validation_failed"}),
            json!({"message": "Daily usage limit reached", "retryable": false}),
        ] {
            let mut response = failed.clone();
            response["response"]["error"] = error;
            assert_eq!(
                deferred_usage_limit_period("response.failed", &response),
                None
            );
        }

        let mut response = failed.clone();
        response["retryable"] = json!(false);
        assert_eq!(
            deferred_usage_limit_period("response.failed", &response),
            None
        );
        assert_eq!(
            deferred_usage_limit_period("response.cancelled", &failed),
            None
        );
    }

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
    fn temporary_usage_limits_never_override_explicit_retry_denial() {
        for message in [
            "Usage limit reached. Do not retry this request.",
            "Usage limit reached. Don't retry this request.",
            "Usage limit reached. Don’t retry this request.",
            "Usage limit reached. This request is not retryable.",
            "Usage limit reached. This is a non-retryable error.",
            "Usage limit reached. You cannot retry this request.",
            "Usage limit reached. Cannot retry until the next reset.",
            "Usage limit reached. You can't retry this request.",
            "Usage limit reached. Never retry this request.",
            "Usage limit reached. You must not retry; wait for support.",
        ] {
            let payload = json!({"error": {"type": "usage_limit_reached", "message": message}});
            assert!(!is_retryable_usage_limit_payload(&payload), "{message}");
            assert_eq!(
                terminal_error_code("response.failed", &payload),
                Some("insufficient_quota"),
                "{message}"
            );
            assert_eq!(
                terminal_error_code_from_body(message),
                Some("insufficient_quota"),
                "{message}"
            );
        }
        let payload = json!({"error": {
            "type": "usage_limit_reached",
            "code": "not_retryable",
            "message": "Usage limit reached. Please retry later."
        }});
        assert!(!is_retryable_usage_limit_payload(&payload));
        assert_eq!(
            terminal_error_code("response.failed", &payload),
            Some("insufficient_quota")
        );
    }

    #[test]
    fn exact_uppercase_usage_limit_code_allows_manual_continuation_without_reset_text() {
        let payload = json!({
            "error": {
                "code": "USAGE_LIMIT_EXCEEDED",
                "type": "upstream_error"
            }
        });
        assert!(is_deferred_usage_limit("response.failed", &payload));

        for payload in [
            json!({
                "error": {
                    "code": "USAGE_LIMIT_EXCEEDED",
                    "message": "Permission denied by the provider"
                }
            }),
            json!({
                "error": {
                    "code": "USAGE_LIMIT_EXCEEDED",
                    "retryable": false
                }
            }),
            json!({
                "error": {
                    "code": "USAGE_LIMIT_EXCEEDED",
                    "message": "Quota exhausted"
                }
            }),
        ] {
            assert!(
                !is_deferred_usage_limit("response.failed", &payload),
                "{payload}"
            );
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
    fn explicit_retry_decision_preserves_only_canonical_boolean_or_denial_signals() {
        for (payload, expected) in [
            (json!({"error": {"code": "server_error"}}), None),
            (json!({"retryable": "false"}), None),
            (json!({"error": {"retryable": "true"}}), None),
            (json!({"retryable": 0}), None),
            (
                json!({"request": {"retryable": false, "message": "Do not retry"}}),
                None,
            ),
            (
                json!({"error": {"metadata": {"retryable": false, "message": "Do not retry"}}}),
                None,
            ),
            (json!({"retryable": true}), Some(true)),
            (json!({"error": {"retryable": true}}), Some(true)),
            (
                json!({"response": {"error": {"retryable": true}}}),
                Some(true),
            ),
            (json!({"retryable": false}), Some(false)),
            (json!({"error": {"retryable": false}}), Some(false)),
            (
                json!({"response": {"error": {"retryable": false}}}),
                Some(false),
            ),
            (
                json!({"retryable": false, "error": {"retryable": true}}),
                Some(false),
            ),
            (
                json!({"retryable": true, "error": {"retryable": false}}),
                Some(false),
            ),
            (
                json!({"retryable": true, "error": {"retryable": true}, "response": {"error": {"retryable": false}}}),
                Some(false),
            ),
            (
                json!({"retryable": true, "error": {"retryable": false}, "response": {"error": {"retryable": true}}}),
                Some(false),
            ),
            (json!({"error": {"code": "not_retryable"}}), Some(false)),
            (
                json!({"error": {"retryable": true, "message": "Do not retry this request"}}),
                Some(false),
            ),
            (
                json!({"error": {"retryable": true}, "response": {"error": {"message": "Do not retry this request"}}}),
                Some(false),
            ),
        ] {
            assert_eq!(explicit_retry_decision(&payload), expected, "{payload}");
        }
    }

    #[test]
    fn explicit_retry_denials_apply_only_at_known_error_boundaries() {
        for payload in [
            json!({"retryable": false, "code": "server_error"}),
            json!({"error": {"retryable": false, "code": "server_error"}}),
            json!({"response": {"error": {"retryable": false, "code": "server_error"}}}),
            json!({"retryable": true, "error": {"retryable": false, "code": "server_error"}}),
            json!({"retryable": false, "error": {"retryable": true, "code": "server_error"}}),
            json!({"error": "Service temporarily overloaded. Do not retry this request."}),
            json!("Service temporarily overloaded. Do not retry this request."),
        ] {
            assert_eq!(
                terminal_error_code("response.failed", &payload),
                Some("non_retryable_error"),
                "{payload}"
            );
            assert_eq!(
                terminal_error_code_from_body(&payload.to_string()),
                Some("non_retryable_error"),
                "{payload}"
            );
        }
        assert_eq!(
            terminal_error_code_from_body(
                "Service temporarily overloaded. Do not retry this request."
            ),
            Some("non_retryable_error")
        );
        for payload in [
            json!({"error": {"retryable": true, "code": "server_error"}}),
            json!({"error": {"retryable": "false", "code": "server_error"}}),
            json!({"error": {"code": "server_error", "metadata": {"request": {"retryable": false, "prompt": "Do not retry this request"}}}}),
            json!({"error": {"code": "server_error"}, "request": {"retryable": false, "message": "Do not retry this request"}}),
        ] {
            assert_eq!(
                terminal_error_code("response.failed", &payload),
                None,
                "{payload}"
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
