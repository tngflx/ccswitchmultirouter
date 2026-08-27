//! Session-scoped Codex Desktop turn recovery.
//!
//! This is deliberately separate from proxy stream reconnection. The proxy may
//! replay a request only before semantic output. Aggressive recovery instead
//! asks Codex Desktop to start a new turn containing the literal `continue`.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures::{Stream, StreamExt};
use serde_json::Value;

use super::providers::codex_terminal::{
    classify_native_responses_terminal, NativeResponsesEvidence, NativeResponsesTerminalDisposition,
};
use super::sse::{append_utf8_safe, strip_sse_field, take_sse_block};

const RECOVERY_STATE_TTL: Duration = Duration::from_secs(15 * 60);
const DESKTOP_READY_RETRIES: u32 = 20;
const DESKTOP_READY_DELAY: Duration = Duration::from_millis(500);

#[derive(Clone, Debug)]
pub(crate) struct TurnRecoveryContext {
    pub(crate) session_id: String,
    pub(crate) model: String,
    pub(crate) provider_id: String,
    pub(crate) desktop_eligible: bool,
    pub(crate) max_recoveries: u32,
}

#[derive(Debug)]
struct RecoveryState {
    submitted: u32,
    in_flight: bool,
    updated_at: Instant,
}

impl Default for RecoveryState {
    fn default() -> Self {
        Self {
            submitted: 0,
            in_flight: false,
            updated_at: Instant::now(),
        }
    }
}

static RECOVERY_STATES: OnceLock<Mutex<HashMap<String, RecoveryState>>> = OnceLock::new();

fn recovery_states() -> &'static Mutex<HashMap<String, RecoveryState>> {
    RECOVERY_STATES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn reserve_recovery(context: &TurnRecoveryContext) -> Option<u32> {
    if !context.desktop_eligible || context.max_recoveries == 0 {
        return None;
    }

    let now = Instant::now();
    let mut states = recovery_states().lock().ok()?;
    states.retain(|_, state| now.duration_since(state.updated_at) <= RECOVERY_STATE_TTL);
    let state = states.entry(context.session_id.clone()).or_default();
    if state.in_flight || state.submitted >= context.max_recoveries {
        return None;
    }
    state.in_flight = true;
    state.updated_at = now;
    Some(state.submitted.saturating_add(1))
}

fn finish_recovery(session_id: &str, submitted: bool) -> u32 {
    let Ok(mut states) = recovery_states().lock() else {
        return 0;
    };
    let Some(state) = states.get_mut(session_id) else {
        return 0;
    };
    if submitted && state.in_flight {
        state.submitted = state.submitted.saturating_add(1);
    }
    state.in_flight = false;
    state.updated_at = Instant::now();
    state.submitted
}

pub(crate) fn mark_turn_completed(session_id: &str) {
    if let Ok(mut states) = recovery_states().lock() {
        states.remove(session_id);
    }
}

/// Reset stale recovery state when the user starts a genuinely new turn. The
/// exact continuation that this module submits keeps the existing budget.
pub(crate) fn begin_turn(session_id: &str, is_continuation: bool) {
    if is_continuation {
        if let Ok(mut states) = recovery_states().lock() {
            if let Some(state) = states.get_mut(session_id) {
                if state.in_flight {
                    state.submitted = state.submitted.saturating_add(1);
                    state.in_flight = false;
                }
                state.updated_at = Instant::now();
            }
        }
    } else {
        mark_turn_completed(session_id);
    }
}

fn recovery_is_active(session_id: &str) -> bool {
    recovery_states()
        .lock()
        .ok()
        .and_then(|states| states.get(session_id).map(|state| state.in_flight))
        .unwrap_or(false)
}

pub(crate) fn schedule_turn_recovery(context: TurnRecoveryContext, reason: &'static str) {
    let Some(next_attempt) = reserve_recovery(&context) else {
        if context.desktop_eligible && context.max_recoveries > 0 {
            log_recovery_event(&context, "not_scheduled", reason, None);
        }
        return;
    };

    log_recovery_event(&context, "scheduled", reason, Some(next_attempt));
    tokio::spawn(async move {
        let mut last_message = String::from("Codex Desktop did not become ready");
        for _ in 0..DESKTOP_READY_RETRIES {
            if !recovery_is_active(&context.session_id) {
                return;
            }
            match crate::codex_desktop::submit_codex_continuation().await {
                Ok(result) if result.submitted => {
                    let submitted = finish_recovery(&context.session_id, true);
                    log_recovery_event(&context, "submitted", reason, Some(submitted));
                    log::warn!(
                        "[Codex/Recovery] submitted continue for session {} ({submitted}/{})",
                        context.session_id,
                        context.max_recoveries
                    );
                    return;
                }
                Ok(result) => last_message = result.message,
                Err(error) => last_message = error,
            }
            tokio::time::sleep(DESKTOP_READY_DELAY).await;
        }

        finish_recovery(&context.session_id, false);
        log_recovery_event(&context, "submit_failed", reason, Some(next_attempt));
        log::error!(
            "[Codex/Recovery] failed to submit continue for session {}: {}",
            context.session_id,
            last_message
        );
    });
}

fn log_recovery_event(
    context: &TurnRecoveryContext,
    status: &str,
    reason: &str,
    attempt: Option<u32>,
) {
    let mut fields = vec![
        ("session", context.session_id.clone()),
        ("model", context.model.clone()),
        ("provider", context.provider_id.clone()),
        ("status", status.to_string()),
        ("reason", reason.to_string()),
        ("budget", context.max_recoveries.to_string()),
    ];
    if let Some(attempt) = attempt {
        fields.push(("attempt", attempt.to_string()));
    }
    crate::proxy::codex_router_log::append_event("turn_recovery", &fields);
}

/// Observe the final Responses SSE seen by Codex Desktop without altering it.
/// This works for both native Responses providers and Chat-to-Responses routes.
pub(crate) fn observe_responses_turn_stream(
    stream: impl Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static,
    context: TurnRecoveryContext,
) -> impl Stream<Item = Result<Bytes, std::io::Error>> + Send {
    async_stream::stream! {
        let mut stream = Box::pin(stream);
        let mut buffer = String::new();
        let mut utf8_remainder = Vec::new();
        let mut evidence = NativeResponsesEvidence::default();
        let mut terminal_seen = false;

        while let Some(item) = stream.next().await {
            match &item {
                Ok(chunk) => {
                    append_utf8_safe(&mut buffer, &mut utf8_remainder, chunk);
                    while let Some(block) = take_sse_block(&mut buffer) {
                        let Some((event_name, payload)) = parse_event(&block) else {
                            continue;
                        };
                        evidence.observe_event(&event_name, &payload);
                        let Some(disposition) = classify_native_responses_terminal(
                            &event_name,
                            &payload,
                            evidence,
                        ) else {
                            continue;
                        };
                        terminal_seen = true;
                        match recovery_decision(
                            disposition,
                            &event_name,
                            &payload,
                            evidence,
                        ) {
                            RecoveryDecision::Complete => {
                                mark_turn_completed(&context.session_id);
                            }
                            RecoveryDecision::Recover(reason) => {
                                schedule_turn_recovery(context.clone(), reason);
                            }
                            RecoveryDecision::Ignore => {}
                        }
                    }
                }
                Err(_) if stream_interruption_is_recoverable(evidence) => {
                    schedule_turn_recovery(context.clone(), "downstream_stream_error");
                    terminal_seen = true;
                }
                Err(_) => {}
            }
            yield item;
        }

        if !terminal_seen && stream_interruption_is_recoverable(evidence) {
            schedule_turn_recovery(context, "terminal_event_missing");
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecoveryDecision {
    Complete,
    Recover(&'static str),
    Ignore,
}

fn recovery_decision(
    disposition: NativeResponsesTerminalDisposition,
    event_name: &str,
    payload: &Value,
    evidence: NativeResponsesEvidence,
) -> RecoveryDecision {
    match disposition {
        NativeResponsesTerminalDisposition::Completed => RecoveryDecision::Complete,
        NativeResponsesTerminalDisposition::Incomplete
            if evidence.valid_tool_calls == 0 && terminal_is_recoverable(event_name, payload) =>
        {
            RecoveryDecision::Recover("response_incomplete")
        }
        NativeResponsesTerminalDisposition::Failed
            if evidence.valid_tool_calls == 0 && terminal_is_recoverable(event_name, payload) =>
        {
            RecoveryDecision::Recover("response_failed")
        }
        NativeResponsesTerminalDisposition::ProtocolError { .. }
            if evidence.valid_tool_calls == 0 && terminal_is_recoverable(event_name, payload) =>
        {
            RecoveryDecision::Recover("protocol_error")
        }
        _ => RecoveryDecision::Ignore,
    }
}

fn stream_interruption_is_recoverable(evidence: NativeResponsesEvidence) -> bool {
    evidence.valid_tool_calls == 0
}

fn parse_event(block: &str) -> Option<(String, Value)> {
    let mut event_name = None;
    let mut data = Vec::new();
    for line in block.lines() {
        if let Some(value) = strip_sse_field(line, "event") {
            event_name = Some(value.trim().to_string());
        } else if let Some(value) = strip_sse_field(line, "data") {
            data.push(value);
        }
    }
    let payload = serde_json::from_str::<Value>(&data.join("\n")).ok()?;
    let event_name = event_name.or_else(|| {
        payload
            .get("type")
            .and_then(Value::as_str)
            .map(str::to_string)
    })?;
    Some((event_name, payload))
}

fn terminal_is_recoverable(event_name: &str, payload: &Value) -> bool {
    if matches!(
        event_name,
        "response.cancelled" | "response.canceled" | "response.aborted"
    ) {
        return false;
    }
    let summary = [
        "/response/error/code",
        "/response/error/type",
        "/response/error/message",
        "/response/incomplete_details/reason",
        "/error/code",
        "/error/type",
        "/error/message",
        "/code",
        "/type",
        "/message",
    ]
    .iter()
    .filter_map(|pointer| payload.pointer(pointer))
    .filter_map(|value| value.as_str())
    .collect::<Vec<_>>()
    .join(" ")
    .to_ascii_lowercase();
    ![
        "content_filter",
        "content filter",
        "context_length",
        "context window",
        "maximum context",
        "authentication",
        "unauthorized",
        "forbidden",
        "invalid_api_key",
        "invalid api key",
        "permission",
        "unsupported_model",
        "unsupported model",
        "model_not_found",
        "model not found",
        "invalid_request",
        "invalid request",
        "policy_violation",
        "policy violation",
    ]
    .iter()
    .any(|marker| summary.contains(marker))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(session_id: &str, budget: u32) -> TurnRecoveryContext {
        TurnRecoveryContext {
            session_id: session_id.to_string(),
            model: "gpt-test".to_string(),
            provider_id: "provider-test".to_string(),
            desktop_eligible: true,
            max_recoveries: budget,
        }
    }

    #[test]
    fn reserves_exactly_the_configured_number_of_submissions() {
        let context = context("recovery-budget", 3);
        mark_turn_completed(&context.session_id);

        assert_eq!(reserve_recovery(&context), Some(1));
        assert_eq!(reserve_recovery(&context), None);
        assert_eq!(finish_recovery(&context.session_id, true), 1);
        assert_eq!(reserve_recovery(&context), Some(2));
        assert_eq!(finish_recovery(&context.session_id, true), 2);
        assert_eq!(reserve_recovery(&context), Some(3));
        assert_eq!(finish_recovery(&context.session_id, true), 3);
        assert_eq!(reserve_recovery(&context), None);
        mark_turn_completed(&context.session_id);
    }

    #[test]
    fn failed_desktop_submission_does_not_consume_budget() {
        let context = context("recovery-failed-submit", 1);
        mark_turn_completed(&context.session_id);

        assert_eq!(reserve_recovery(&context), Some(1));
        assert_eq!(finish_recovery(&context.session_id, false), 0);
        assert_eq!(reserve_recovery(&context), Some(1));
        finish_recovery(&context.session_id, false);
        mark_turn_completed(&context.session_id);
    }

    #[test]
    fn non_desktop_requests_are_never_reserved() {
        let mut context = context("recovery-cli", 3);
        context.desktop_eligible = false;
        assert_eq!(reserve_recovery(&context), None);
    }

    #[test]
    fn new_user_turn_resets_budget_but_continuation_keeps_it() {
        let context = context("recovery-new-turn", 2);
        mark_turn_completed(&context.session_id);
        assert_eq!(reserve_recovery(&context), Some(1));
        assert_eq!(finish_recovery(&context.session_id, true), 1);

        begin_turn(&context.session_id, true);
        assert_eq!(reserve_recovery(&context), Some(2));
        assert_eq!(finish_recovery(&context.session_id, true), 2);

        begin_turn(&context.session_id, false);
        assert_eq!(reserve_recovery(&context), Some(1));
        finish_recovery(&context.session_id, false);
        mark_turn_completed(&context.session_id);
    }

    #[test]
    fn arriving_continuation_consumes_an_in_flight_reservation_once() {
        let context = context("recovery-arrival-race", 2);
        mark_turn_completed(&context.session_id);
        assert_eq!(reserve_recovery(&context), Some(1));

        begin_turn(&context.session_id, true);
        assert_eq!(finish_recovery(&context.session_id, true), 1);
        assert_eq!(reserve_recovery(&context), Some(2));

        finish_recovery(&context.session_id, false);
        mark_turn_completed(&context.session_id);
    }

    #[test]
    fn permanent_terminal_failures_are_not_recoverable() {
        for payload in [
            serde_json::json!({"response":{"error":{"code":"invalid_api_key"}}}),
            serde_json::json!({"response":{"error":{"type":"authentication_error"}}}),
            serde_json::json!({"response":{"error":{"message":"Permission denied"}}}),
            serde_json::json!({"response":{"error":{"code":"unsupported_model"}}}),
            serde_json::json!({"response":{"error":{"code":"invalid_request_error"}}}),
            serde_json::json!({"response":{"error":{"code":"policy_violation"}}}),
        ] {
            assert!(!terminal_is_recoverable("response.failed", &payload));
        }
        for reason in ["content_filter", "context_length_exceeded"] {
            assert!(!terminal_is_recoverable(
                "response.incomplete",
                &serde_json::json!({"response":{"incomplete_details":{"reason": reason}}}),
            ));
        }
        assert!(!terminal_is_recoverable(
            "response.cancelled",
            &serde_json::json!({"response":{"status":"cancelled"}}),
        ));
        assert!(terminal_is_recoverable(
            "response.failed",
            &serde_json::json!({"response":{"error":{"code":"server_error"}}}),
        ));
        assert!(terminal_is_recoverable(
            "response.failed",
            &serde_json::json!({"response":{"error":{"code":"rate_limit_exceeded"}}}),
        ));
    }

    #[test]
    fn terminal_recovery_decisions_enforce_failure_boundaries() {
        let empty = NativeResponsesEvidence::default();
        assert_eq!(
            recovery_decision(
                NativeResponsesTerminalDisposition::Failed,
                "response.failed",
                &serde_json::json!({"response":{"error":{"code":"server_error"}}}),
                empty,
            ),
            RecoveryDecision::Recover("response_failed")
        );
        assert_eq!(
            recovery_decision(
                NativeResponsesTerminalDisposition::Incomplete,
                "response.incomplete",
                &serde_json::json!({"response":{"incomplete_details":{"reason":"upstream_timeout"}}}),
                empty,
            ),
            RecoveryDecision::Recover("response_incomplete")
        );
        assert_eq!(
            recovery_decision(
                NativeResponsesTerminalDisposition::Failed,
                "response.cancelled",
                &serde_json::json!({"response":{"status":"cancelled"}}),
                empty,
            ),
            RecoveryDecision::Ignore
        );
        assert_eq!(
            recovery_decision(
                NativeResponsesTerminalDisposition::Incomplete,
                "response.incomplete",
                &serde_json::json!({"response":{"incomplete_details":{"reason":"context_length_exceeded"}}}),
                empty,
            ),
            RecoveryDecision::Ignore
        );

        let tool_call = NativeResponsesEvidence {
            valid_tool_calls: 1,
            ..NativeResponsesEvidence::default()
        };
        assert_eq!(
            recovery_decision(
                NativeResponsesTerminalDisposition::Failed,
                "response.failed",
                &serde_json::json!({"response":{"error":{"code":"server_error"}}}),
                tool_call,
            ),
            RecoveryDecision::Ignore
        );
        assert!(!stream_interruption_is_recoverable(tool_call));
        assert!(stream_interruption_is_recoverable(empty));
    }

    #[tokio::test]
    async fn completed_turn_clears_the_existing_recovery_budget() {
        let context = context("recovery-completed", 1);
        mark_turn_completed(&context.session_id);
        assert_eq!(reserve_recovery(&context), Some(1));
        assert_eq!(finish_recovery(&context.session_id, true), 1);

        let sse = concat!(
            "event: response.output_text.done\n",
            "data: {\"type\":\"response.output_text.done\",\"text\":\"done\"}\n\n",
            "event: response.completed\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n"
        );
        let stream = futures::stream::iter(vec![Ok::<_, std::io::Error>(Bytes::from(sse))]);
        let output = observe_responses_turn_stream(stream, context.clone())
            .collect::<Vec<_>>()
            .await;
        assert_eq!(output.len(), 1);
        assert_eq!(reserve_recovery(&context), Some(1));
        finish_recovery(&context.session_id, false);
        mark_turn_completed(&context.session_id);
    }
}
