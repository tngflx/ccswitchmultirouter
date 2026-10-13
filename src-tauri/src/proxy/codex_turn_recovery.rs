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
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::providers::codex_terminal::{
    classify_native_responses_terminal, NativeResponsesEvidence, NativeResponsesTerminalDisposition,
};
use super::sse::{append_utf8_safe, strip_sse_field, take_sse_block};

const RECOVERY_STATE_TTL: Duration = Duration::from_secs(15 * 60);
const DESKTOP_READY_TIMEOUT: Duration = Duration::from_secs(60);
const DESKTOP_READY_DELAY: Duration = Duration::from_millis(500);
const RECOVERY_FILE: &str = "codex-turn-recovery.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct TurnRecoveryContext {
    pub(crate) session_id: String,
    pub(crate) desktop_thread_id: String,
    pub(crate) recovery_id: String,
    pub(crate) observed_at_ms: i64,
    pub(crate) model: String,
    pub(crate) desktop_model: String,
    pub(crate) provider_id: String,
    pub(crate) durable_provider_id: String,
    pub(crate) provider_fingerprint: String,
    pub(crate) desktop_eligible: bool,
    pub(crate) max_recoveries: u32,
}

#[derive(Debug)]
struct RecoveryState {
    submitted: u32,
    in_flight: bool,
    updated_at: Instant,
    tracked: Option<TurnRecoveryContext>,
    active: bool,
}

impl Default for RecoveryState {
    fn default() -> Self {
        Self {
            submitted: 0,
            in_flight: false,
            updated_at: Instant::now(),
            tracked: None,
            active: false,
        }
    }
}

static RECOVERY_STATES: OnceLock<Mutex<HashMap<String, RecoveryState>>> = OnceLock::new();

fn recovery_states() -> &'static Mutex<HashMap<String, RecoveryState>> {
    RECOVERY_STATES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn reserve_recovery(context: &TurnRecoveryContext) -> Option<u32> {
    if !context.desktop_eligible
        || context.max_recoveries == 0
        || context.desktop_thread_id.is_empty()
    {
        return None;
    }

    let now = Instant::now();
    let mut states = recovery_states().lock().ok()?;
    states.retain(|_, state| now.duration_since(state.updated_at) <= RECOVERY_STATE_TTL);
    let state = states.entry(context.desktop_thread_id.clone()).or_default();
    if state.tracked.as_ref().is_some_and(|tracked| {
        tracked.recovery_id != context.recovery_id
            && (state.active || tracked.observed_at_ms >= context.observed_at_ms)
    }) {
        return None;
    }
    if state.in_flight || state.submitted >= context.max_recoveries {
        return None;
    }
    state.in_flight = true;
    state.tracked = Some(context.clone());
    state.active = false;
    state.updated_at = now;
    let attempt = state.submitted.saturating_add(1);
    persist_states(&states);
    Some(attempt)
}

#[cfg(test)]
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
    if submitted && !state.active {
        state.tracked = None;
    }
    let submitted = state.submitted;
    persist_states(&states);
    submitted
}

pub(crate) fn mark_turn_completed(session_id: &str) {
    if let Ok(mut states) = recovery_states().lock() {
        states.remove(session_id);
        persist_states(&states);
    }
}

pub(crate) fn mark_observed_turn_completed(context: &TurnRecoveryContext) {
    if let Ok(mut states) = recovery_states().lock() {
        let owned = states.get(&context.desktop_thread_id).is_some_and(|state| {
            state
                .tracked
                .as_ref()
                .is_some_and(|tracked| tracked.recovery_id == context.recovery_id)
        });
        if owned {
            states.remove(&context.desktop_thread_id);
            persist_states(&states);
        }
    }
}

fn mark_observed_tool_step_completed(context: &TurnRecoveryContext) {
    if let Ok(mut states) = recovery_states().lock() {
        if let Some(state) = states.get_mut(&context.desktop_thread_id) {
            if state
                .tracked
                .as_ref()
                .is_some_and(|tracked| tracked.recovery_id == context.recovery_id)
            {
                // A successful tool step hands control back to the Desktop's
                // tool loop. Its next request is still the same user turn.
                // Keep crash evidence across the gap between delivering a
                // completed tool item and the next tool-result request. A
                // final assistant response or explicit cancellation clears it.
                state.active = false;
                state.in_flight = false;
                state.updated_at = Instant::now();
                persist_states(&states);
            }
        }
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
            persist_states(&states);
        }
    } else {
        mark_turn_completed(session_id);
    }
}

fn recovery_is_active(context: &TurnRecoveryContext) -> bool {
    recovery_states()
        .lock()
        .ok()
        .and_then(|states| {
            states.get(&context.desktop_thread_id).map(|state| {
                state.in_flight
                    && state
                        .tracked
                        .as_ref()
                        .is_some_and(|tracked| tracked.recovery_id == context.recovery_id)
            })
        })
        .unwrap_or(false)
}

fn finish_reserved_recovery(context: &TurnRecoveryContext, submitted: bool) -> u32 {
    let Ok(mut states) = recovery_states().lock() else {
        return 0;
    };
    let Some(state) = states.get_mut(&context.desktop_thread_id) else {
        return 0;
    };
    if !state.in_flight
        || !state
            .tracked
            .as_ref()
            .is_some_and(|tracked| tracked.recovery_id == context.recovery_id)
    {
        return state.submitted;
    }
    if submitted {
        state.submitted = state.submitted.saturating_add(1);
    }
    state.in_flight = false;
    state.updated_at = Instant::now();
    if submitted && !state.active {
        state.tracked = None;
    }
    let submitted = state.submitted;
    persist_states(&states);
    submitted
}

#[cfg(test)]
pub(crate) fn recovery_reserved_for_test(thread_id: &str) -> bool {
    recovery_states()
        .lock()
        .ok()
        .and_then(|states| states.get(thread_id).map(|state| state.in_flight))
        .unwrap_or(false)
}

/// Drop removes a cancelled request from the crash ledger. A killed process
/// cannot run Drop, so only genuinely interrupted active requests survive.
pub(crate) struct TrackedTurn {
    context: TurnRecoveryContext,
    armed: bool,
    heartbeat: Option<tokio::task::JoinHandle<()>>,
}

impl TrackedTurn {
    pub(crate) fn hand_off_to_stream(mut self) {
        self.armed = false;
    }
}

impl Drop for TrackedTurn {
    fn drop(&mut self) {
        if let Some(heartbeat) = self.heartbeat.take() {
            heartbeat.abort();
        }
        if !self.armed {
            return;
        }
        if let Ok(mut states) = recovery_states().lock() {
            let owned_active = states
                .get(&self.context.desktop_thread_id)
                .is_some_and(|state| {
                    state.active
                        && state
                            .tracked
                            .as_ref()
                            .is_some_and(|tracked| tracked.recovery_id == self.context.recovery_id)
                });
            if owned_active {
                states.remove(&self.context.desktop_thread_id);
                persist_states(&states);
            }
        }
    }
}

pub(crate) fn track_turn(context: &TurnRecoveryContext) -> TrackedTurn {
    let armed = context.desktop_eligible
        && context.max_recoveries > 0
        && !context.desktop_thread_id.is_empty();
    let mut owns_state = false;
    if armed {
        if let Ok(mut states) = recovery_states().lock() {
            let state = states.entry(context.desktop_thread_id.clone()).or_default();
            let can_claim = state.tracked.as_ref().is_none_or(|tracked| {
                tracked.recovery_id == context.recovery_id
                    || context.observed_at_ms > tracked.observed_at_ms
            });
            if can_claim {
                state.tracked = Some(context.clone());
                state.active = true;
                state.updated_at = Instant::now();
                persist_states(&states);
                owns_state = true;
            }
        }
    }
    let heartbeat_context = context.clone();
    let heartbeat = owns_state
        .then(|| tokio::runtime::Handle::try_current().ok())
        .flatten()
        .map(|runtime| {
            runtime.spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    let Ok(mut states) = recovery_states().lock() else {
                        return;
                    };
                    let Some(state) = states.get_mut(&heartbeat_context.desktop_thread_id) else {
                        return;
                    };
                    if !state.active
                        || !state.tracked.as_ref().is_some_and(|tracked| {
                            tracked.recovery_id == heartbeat_context.recovery_id
                        })
                    {
                        return;
                    }
                    state.updated_at = Instant::now();
                    persist_states(&states);
                }
            })
        });
    TrackedTurn {
        context: context.clone(),
        armed: owns_state,
        heartbeat,
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryLedger {
    config_scope: String,
    saved_at: i64,
    turns: Vec<PersistedTurn>,
}

static STARTUP_LEDGER: OnceLock<Mutex<Option<RecoveryLedger>>> = OnceLock::new();

/// Capture before listener startup so a new request cannot overwrite evidence
/// left by the previous process while startup reconciliation is still running.
pub(crate) fn capture_startup_recovery(
    classification: crate::app_exit_monitor::PreviousRunClassification,
) {
    if !classification.allows_proxy_startup() {
        return;
    }
    let ledger = classification
        .allows_crash_recovery()
        .then(|| {
            std::fs::read(recovery_path())
                .ok()
                .and_then(|bytes| serde_json::from_slice::<RecoveryLedger>(&bytes).ok())
        })
        .flatten();
    let _ = STARTUP_LEDGER.set(Mutex::new(ledger));
    if !classification.allows_crash_recovery() {
        clear_persisted_recovery();
    }
}

#[derive(Serialize, Deserialize)]
struct PersistedTurn {
    context: TurnRecoveryContext,
    submitted: u32,
}

fn ledger_from_states(states: &HashMap<String, RecoveryState>) -> RecoveryLedger {
    RecoveryLedger {
        config_scope: crate::process_identity::config_scope_fingerprint(),
        saved_at: chrono::Utc::now().timestamp(),
        turns: states
            .values()
            .filter_map(|state| {
                let context = state.tracked.as_ref()?;
                (state.updated_at.elapsed() <= RECOVERY_STATE_TTL).then(|| PersistedTurn {
                    context: context.clone(),
                    submitted: state.submitted,
                })
            })
            .collect(),
    }
}

fn recovery_path() -> std::path::PathBuf {
    crate::config::get_app_config_dir()
        .join("logs")
        .join(RECOVERY_FILE)
}

fn persist_states(states: &HashMap<String, RecoveryState>) {
    // Unit tests must never mutate a running user's recovery ledger.
    #[cfg(not(test))]
    {
        let result = serde_json::to_vec(&ledger_from_states(states))
            .map_err(|error| error.to_string())
            .and_then(|bytes| {
                crate::config::atomic_write(&recovery_path(), &bytes)
                    .map_err(|error| error.to_string())
            });
        if let Err(error) = result {
            log::warn!("[Codex/Recovery] failed to persist recovery ledger: {error}");
        }
    }
    #[cfg(test)]
    let _ = states;
}

/// An explicit app exit must not look like an interrupted coding turn later.
pub(crate) fn clear_persisted_recovery() {
    if let Ok(mut states) = recovery_states().lock() {
        states.clear();
    }
    #[cfg(not(test))]
    if let Err(error) = std::fs::remove_file(recovery_path()) {
        if error.kind() != std::io::ErrorKind::NotFound {
            log::warn!("[Codex/Recovery] failed to clear recovery ledger: {error}");
        }
    }
}

fn ledger_is_current(ledger: &RecoveryLedger, config_scope: &str, now: i64) -> bool {
    ledger.config_scope == config_scope
        && ledger.saved_at <= now
        && now.saturating_sub(ledger.saved_at) <= RECOVERY_STATE_TTL.as_secs() as i64
}

/// Called only after proxy takeover restoration. Recovery is production-safe:
/// it reconnects an exact Desktop thread, never starts development commands.
pub(crate) fn restore_after_startup(
    classification: crate::app_exit_monitor::PreviousRunClassification,
    db: &crate::database::Database,
) {
    let budget = crate::settings::get_settings().stream_recovery_budget();
    if !classification.allows_crash_recovery() || budget == 0 {
        return;
    }
    let ledger = STARTUP_LEDGER
        .get()
        .and_then(|captured| captured.lock().ok().and_then(|mut ledger| ledger.take()));
    restore_ledger(ledger, budget, db);
}

fn restore_ledger(ledger: Option<RecoveryLedger>, budget: u32, db: &crate::database::Database) {
    let Some(ledger) = ledger.filter(|ledger| {
        ledger_is_current(
            ledger,
            &crate::process_identity::config_scope_fingerprint(),
            chrono::Utc::now().timestamp(),
        )
    }) else {
        return;
    };
    for turn in ledger.turns {
        let mut context = turn.context;
        context.max_recoveries = context.max_recoveries.min(budget);
        let provider_matches = db
            .get_provider_by_id(&context.durable_provider_id, "codex")
            .ok()
            .flatten()
            .is_some_and(|provider| durable_provider_matches(&context, &provider));
        if context.desktop_thread_id.is_empty()
            || turn.submitted >= context.max_recoveries
            || !provider_matches
        {
            continue;
        }
        if let Ok(mut states) = recovery_states().lock() {
            // A newly observed request supersedes the old process's evidence.
            if states.contains_key(&context.desktop_thread_id) {
                continue;
            }
            states.insert(
                context.desktop_thread_id.clone(),
                RecoveryState {
                    submitted: turn.submitted,
                    ..RecoveryState::default()
                },
            );
        }
        schedule_turn_recovery(context, "app_crash_interrupted_turn");
    }
}

pub(crate) fn provider_fingerprint(provider: &crate::provider::Provider) -> String {
    use sha2::{Digest, Sha256};
    let serialized = serde_json::to_vec(&provider.settings_config).unwrap_or_default();
    hex::encode(Sha256::digest(serialized))
}

fn durable_provider_matches(
    context: &TurnRecoveryContext,
    provider: &crate::provider::Provider,
) -> bool {
    provider.id == context.durable_provider_id
        && provider_fingerprint(provider) == context.provider_fingerprint
}

#[cfg(not(test))]
fn recovery_binding_is_current(context: &TurnRecoveryContext) -> bool {
    crate::settings::get_settings().stream_recovery_budget() > 0
        && crate::settings::get_current_provider(&crate::app_config::AppType::Codex).as_deref()
            == Some(context.durable_provider_id.as_str())
        && crate::database::Database::init_readonly()
            .ok()
            .and_then(|db| {
                db.get_provider_by_id(&context.durable_provider_id, "codex")
                    .ok()
                    .flatten()
            })
            .is_some_and(|provider| durable_provider_matches(context, &provider))
}

pub(crate) fn forward_error_is_recoverable(error: &super::error::ProxyError) -> bool {
    use super::error::ProxyError;
    match error {
        ProxyError::ForwardFailed(_)
        | ProxyError::Timeout(_)
        | ProxyError::StreamIdleTimeout(_)
        | ProxyError::AllProvidersCircuitOpen
        | ProxyError::NoAvailableProvider
        | ProxyError::AdmissionQueueTimeout { .. }
        | ProxyError::MaxRetriesExceeded
        | ProxyError::ProviderUnhealthy(_) => true,
        ProxyError::UpstreamError { status, body } => {
            let permanent = body
                .as_deref()
                .map(|body| {
                    serde_json::from_str::<Value>(body)
                        .unwrap_or_else(|_| serde_json::json!({"error":{"message":body}}))
                })
                .is_some_and(|payload| !terminal_is_recoverable("response.failed", &payload));
            !permanent && (*status == 429 || (500..=599).contains(status))
        }
        // ResponsePending is an unknown still-running upstream operation;
        // neither a replay nor a new turn may duplicate it.
        _ => false,
    }
}

pub(crate) fn schedule_turn_recovery(context: TurnRecoveryContext, reason: &'static str) {
    let Some(next_attempt) = reserve_recovery(&context) else {
        if context.desktop_eligible && context.max_recoveries > 0 {
            log_recovery_event(&context, "not_scheduled", reason, None);
        }
        return;
    };

    log_recovery_event(&context, "scheduled", reason, Some(next_attempt));
    #[cfg(not(test))]
    tokio::spawn(run_turn_recovery(
        context,
        reason,
        next_attempt,
        |context, next_attempt| async move {
            crate::codex_desktop::submit_codex_continuation(
                &context.desktop_thread_id,
                &format!("{}:{next_attempt}", context.recovery_id),
                &context.desktop_model,
                context.observed_at_ms,
            )
            .await
        },
        recovery_binding_is_current,
    ));
}

async fn run_turn_recovery<Submit, SubmitFuture, Binding>(
    context: TurnRecoveryContext,
    reason: &'static str,
    next_attempt: u32,
    mut submit: Submit,
    binding_is_current: Binding,
) where
    Submit: FnMut(TurnRecoveryContext, u32) -> SubmitFuture,
    SubmitFuture:
        std::future::Future<Output = Result<crate::codex_desktop::CodexContinuationResult, String>>,
    Binding: Fn(&TurnRecoveryContext) -> bool,
{
    let mut last_message = String::from("Codex Desktop did not become ready");
    let deadline = tokio::time::Instant::now() + DESKTOP_READY_TIMEOUT;
    while tokio::time::Instant::now() < deadline {
        if !recovery_is_active(&context) {
            return;
        }
        if !binding_is_current(&context) {
            finish_reserved_recovery(&context, false);
            mark_observed_turn_completed(&context);
            log_recovery_event(
                &context,
                "cancelled",
                "recovery_settings_or_provider_changed",
                Some(next_attempt),
            );
            return;
        }
        // The renderer bridge checks the exact thread's terminal state;
        // it never types into whichever composer happens to be visible.
        let result = tokio::time::timeout_at(deadline, submit(context.clone(), next_attempt)).await;
        match result {
            Err(_) => {
                // CDP can lose the acknowledgement after the renderer has
                // started its job. Conservatively consume this attempt;
                // the renderer's per-turn marker prevents duplicate sends.
                finish_reserved_recovery(&context, true);
                log_recovery_event(
                    &context,
                    "outcome_unknown",
                    "desktop_ready_deadline",
                    Some(next_attempt),
                );
                return;
            }
            Ok(result) => match result {
                Ok(result) if result.submitted => {
                    let submitted = finish_reserved_recovery(&context, true);
                    log_recovery_event(&context, "submitted", reason, Some(submitted));
                    log::warn!(
                        "[Codex/Recovery] submitted continue for session {} ({submitted}/{}) through CDP port {:?}, target {:?}",
                        context.session_id,
                        context.max_recoveries,
                        result.debug_port,
                        result.target_id,
                    );
                    return;
                }
                Ok(result) if result.mutation_attempted => {
                    // The app-server may have accepted the turn while its
                    // acknowledgement was lost. Consume the reservation and
                    // let its persisted renderer marker prevent duplicates.
                    finish_reserved_recovery(&context, true);
                    log_recovery_event(&context, "outcome_unknown", reason, Some(next_attempt));
                    log::warn!(
                        "[Codex/Recovery] continuation outcome unknown for session {}: {}",
                        context.session_id,
                        result.message
                    );
                    return;
                }
                Ok(result) => last_message = result.message,
                Err(error) => last_message = error,
            },
        }
        tokio::time::sleep_until(std::cmp::min(
            deadline,
            tokio::time::Instant::now() + DESKTOP_READY_DELAY,
        ))
        .await;
    }

    finish_reserved_recovery(&context, false);
    log_recovery_event(&context, "submit_failed", reason, Some(next_attempt));
    log::error!(
        "[Codex/Recovery] failed to submit continue for session {}: {}",
        context.session_id,
        last_message
    );
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
    let tracked = track_turn(&context);
    async_stream::stream! {
        let _tracked = tracked;
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
                        if terminal_seen { continue; }
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
                                mark_observed_turn_completed(&context);
                            }
                            RecoveryDecision::ToolStepComplete => {
                                mark_observed_tool_step_completed(&context);
                            }
                            RecoveryDecision::Recover(reason) => {
                                schedule_turn_recovery(context.clone(), reason);
                            }
                            RecoveryDecision::Ignore => {
                                mark_observed_turn_completed(&context);
                            }
                        }
                    }
                }
                Err(_) if !terminal_seen && stream_interruption_is_recoverable(evidence) => {
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
    ToolStepComplete,
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
        NativeResponsesTerminalDisposition::Completed if evidence.valid_tool_calls > 0 => {
            RecoveryDecision::ToolStepComplete
        }
        NativeResponsesTerminalDisposition::Completed => RecoveryDecision::Complete,
        NativeResponsesTerminalDisposition::Incomplete
            if terminal_is_recoverable(event_name, payload) =>
        {
            RecoveryDecision::Recover("response_incomplete")
        }
        NativeResponsesTerminalDisposition::Failed
            if terminal_is_recoverable(event_name, payload) =>
        {
            RecoveryDecision::Recover("response_failed")
        }
        NativeResponsesTerminalDisposition::ProtocolError { .. }
            if terminal_is_recoverable(event_name, payload) =>
        {
            RecoveryDecision::Recover("protocol_error")
        }
        _ => RecoveryDecision::Ignore,
    }
}

fn stream_interruption_is_recoverable(_evidence: NativeResponsesEvidence) -> bool {
    // This is a new Desktop turn with retained history, never an upstream
    // request replay. The bridge waits for terminal failure before continuing,
    // including interruptions after a tool item was delivered.
    true
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
        "/response/status",
        "/error/code",
        "/error/type",
        "/error/message",
        "/code",
        "/type",
        "/message",
        "/status",
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
        "insufficient_quota",
        "insufficient quota",
        "quota_exceeded",
        "quota exceeded",
        "exceeded your current quota",
        "billing",
        "credit balance",
        "usage limit",
        "usage_limit",
        "cancelled",
        "canceled",
        "aborted",
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
            desktop_thread_id: session_id.to_string(),
            recovery_id: format!("recovery-{session_id}"),
            observed_at_ms: chrono::Utc::now().timestamp_millis(),
            model: "gpt-test".to_string(),
            desktop_model: "gpt-test".to_string(),
            provider_id: "provider-test".to_string(),
            durable_provider_id: "provider-test".to_string(),
            provider_fingerprint: "fingerprint-test".to_string(),
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
    fn cancelled_request_drop_clears_crash_evidence() {
        let context = context("recovery-cancel-drop", 3);
        mark_turn_completed(&context.desktop_thread_id);
        let tracked = track_turn(&context);
        assert!(
            recovery_states()
                .lock()
                .unwrap()
                .get(&context.desktop_thread_id)
                .unwrap()
                .active
        );
        drop(tracked);
        assert!(!recovery_states()
            .lock()
            .unwrap()
            .contains_key(&context.desktop_thread_id));
    }

    #[test]
    fn scheduled_recovery_survives_stream_drop_and_new_user_turn_supersedes_it() {
        let context = context("recovery-scheduled-drop", 3);
        let tracked = track_turn(&context);
        assert_eq!(reserve_recovery(&context), Some(1));
        drop(tracked);
        assert!(recovery_is_active(&context));
        begin_turn(&context.desktop_thread_id, false);
        assert!(!recovery_is_active(&context));

        let mut newer = context.clone();
        newer.recovery_id = "newer-observed-request".to_string();
        assert_eq!(reserve_recovery(&newer), Some(1));
        assert!(!recovery_is_active(&context));
        assert!(recovery_is_active(&newer));
        assert_eq!(finish_reserved_recovery(&context, true), 0);
        assert!(recovery_is_active(&newer));
        mark_turn_completed(&context.desktop_thread_id);
    }

    #[test]
    fn equal_timestamp_different_generation_cannot_reclaim_tracked_request() {
        let older = context("recovery-equal-observation", 3);
        let mut newer = older.clone();
        newer.recovery_id = "already-tracked-newer".to_string();
        let newer_guard = track_turn(&newer);
        let older_guard = track_turn(&older);
        assert!(!older_guard.armed);
        assert_eq!(
            recovery_states()
                .lock()
                .unwrap()
                .get(&newer.desktop_thread_id)
                .unwrap()
                .tracked
                .as_ref()
                .unwrap()
                .recovery_id,
            newer.recovery_id
        );
        drop(older_guard);
        drop(newer_guard);
    }

    #[tokio::test(start_paused = true)]
    async fn hanging_desktop_submission_has_one_total_deadline_and_consumes_ambiguous_attempt() {
        let context = context("recovery-total-ready-deadline", 1);
        assert_eq!(reserve_recovery(&context), Some(1));
        let started = tokio::time::Instant::now();
        run_turn_recovery(
            context.clone(),
            "test_hanging_desktop",
            1,
            |_, _| {
                futures::future::pending::<
                    Result<crate::codex_desktop::CodexContinuationResult, String>,
                >()
            },
            |_| true,
        )
        .await;
        assert_eq!(started.elapsed(), DESKTOP_READY_TIMEOUT);
        assert!(!recovery_is_active(&context));
        assert_eq!(reserve_recovery(&context), None);
        mark_turn_completed(&context.desktop_thread_id);
    }

    #[test]
    fn crash_ledger_is_scoped_recent_and_preserves_budget_without_request_body() {
        let context = context("recovery-ledger", 2);
        let mut states = HashMap::new();
        states.insert(
            context.desktop_thread_id.clone(),
            RecoveryState {
                submitted: 1,
                active: true,
                tracked: Some(context),
                ..RecoveryState::default()
            },
        );
        let mut ledger = ledger_from_states(&states);
        ledger.config_scope = "scope-a".to_string();
        ledger.saved_at = 1_000;
        let encoded = serde_json::to_string(&ledger).unwrap();
        let decoded: RecoveryLedger = serde_json::from_str(&encoded).unwrap();
        assert!(ledger_is_current(&decoded, "scope-a", 1_100));
        assert!(!ledger_is_current(&decoded, "scope-b", 1_100));
        assert!(!ledger_is_current(&decoded, "scope-a", 999));
        assert!(!ledger_is_current(&decoded, "scope-a", 1_901));
        assert_eq!(decoded.turns[0].submitted, 1);
        assert_eq!(
            decoded.turns[0].context.desktop_thread_id,
            "recovery-ledger"
        );
        assert!(!encoded.contains("input"));
        assert!(!encoded.contains("headers"));
    }

    #[test]
    fn routed_provider_diagnostics_do_not_replace_durable_configuration_binding() {
        let root = crate::provider::Provider::with_id(
            "router-root".to_string(),
            "router".to_string(),
            serde_json::json!({"routes":[{"id":"route-a","url":"https://example.test"}]}),
            None,
        );
        let mut context = context("recovery-router-binding", 3);
        context.durable_provider_id = root.id.clone();
        context.provider_id = "router-root::route::route-a".to_string();
        context.provider_fingerprint = provider_fingerprint(&root);
        assert!(durable_provider_matches(&context, &root));
        let mut changed = root.clone();
        changed.settings_config["routes"][0]["url"] = serde_json::json!("https://changed.test");
        assert!(!durable_provider_matches(&context, &changed));
        changed.id = "another-root".to_string();
        assert!(!durable_provider_matches(&context, &changed));
    }

    #[test]
    fn startup_restores_valid_router_budget_and_preserves_new_live_requests() {
        let db = crate::database::Database::memory().unwrap();
        let root = crate::provider::Provider::with_id(
            "restore-router-root".into(),
            "router".into(),
            serde_json::json!({"routes":[{"id":"route-a"}]}),
            None,
        );
        db.save_provider("codex", &root).unwrap();
        let mut valid = context("restore-router-valid", 3);
        valid.provider_id = "restore-router-root::route::route-a".into();
        valid.durable_provider_id = root.id.clone();
        valid.provider_fingerprint = provider_fingerprint(&root);
        let mut changed = valid.clone();
        changed.desktop_thread_id = "restore-router-changed".into();
        changed.provider_fingerprint = "old-configuration".into();
        let mut newer = valid.clone();
        newer.desktop_thread_id = "restore-router-new-live".into();
        newer.recovery_id = "new-live-generation".into();
        let tracked = track_turn(&newer);
        let mut old = newer.clone();
        old.recovery_id = "previous-process-generation".into();
        let ledger = RecoveryLedger {
            config_scope: crate::process_identity::config_scope_fingerprint(),
            saved_at: chrono::Utc::now().timestamp(),
            turns: vec![
                PersistedTurn {
                    context: valid.clone(),
                    submitted: 1,
                },
                PersistedTurn {
                    context: changed.clone(),
                    submitted: 0,
                },
                PersistedTurn {
                    context: old,
                    submitted: 0,
                },
            ],
        };
        restore_ledger(Some(ledger), 2, &db);
        assert!(recovery_reserved_for_test(&valid.desktop_thread_id));
        assert!(!recovery_reserved_for_test(&changed.desktop_thread_id));
        let states = recovery_states().lock().unwrap();
        let restored = states.get(&valid.desktop_thread_id).unwrap();
        assert_eq!(restored.submitted, 1);
        assert_eq!(restored.tracked.as_ref().unwrap().max_recoveries, 2);
        assert_eq!(
            states
                .get(&newer.desktop_thread_id)
                .unwrap()
                .tracked
                .as_ref()
                .unwrap()
                .recovery_id,
            newer.recovery_id
        );
        drop(states);
        finish_reserved_recovery(&valid, true);
        assert_eq!(
            reserve_recovery(&TurnRecoveryContext {
                max_recoveries: 2,
                ..valid.clone()
            }),
            None
        );
        mark_turn_completed(&valid.desktop_thread_id);
        drop(tracked);
    }

    #[tokio::test]
    async fn late_old_stream_terminal_cannot_clear_or_reserve_newer_request() {
        for terminal in [
            "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"old done\"}]}]}}\n\n",
            "event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"server_error\"}}}\n\n",
        ] {
            let mut old = context("recovery-old-late-terminal", 3);
            old.observed_at_ms = 100;
            let old_stream = observe_responses_turn_stream(futures::stream::iter(vec![Ok::<_, std::io::Error>(Bytes::from(terminal))]), old.clone());
            let mut newer = old.clone();
            newer.recovery_id = "new-request-generation".to_string();
            newer.observed_at_ms = 200;
            let tracked = track_turn(&newer);
            old_stream.collect::<Vec<_>>().await;
            let states = recovery_states().lock().unwrap();
            let state = states.get(&newer.desktop_thread_id).unwrap();
            assert_eq!(state.tracked.as_ref().unwrap().recovery_id, newer.recovery_id);
            assert!(state.active);
            assert!(!state.in_flight);
            drop(states);
            drop(tracked);
        }
    }

    #[tokio::test]
    async fn completed_terminal_followed_by_transport_teardown_does_not_resume() {
        let context = context("recovery-completed-teardown", 3);
        let completed = "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}]}}\n\n";
        let stream = futures::stream::iter(vec![
            Ok(Bytes::from(completed)),
            Err(std::io::Error::other("connection teardown")),
        ]);
        let output = observe_responses_turn_stream(stream, context.clone())
            .collect::<Vec<_>>()
            .await;
        assert_eq!(output.len(), 2);
        assert!(!recovery_reserved_for_test(&context.desktop_thread_id));
        assert!(!recovery_states()
            .lock()
            .unwrap()
            .contains_key(&context.desktop_thread_id));
    }

    #[tokio::test]
    async fn overload_after_tool_output_and_eof_after_text_reserve_continuations() {
        let tool_overload = concat!(
            "event: response.output_item.done\n",
            "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",\"id\":\"item-1\",\"call_id\":\"call-1\",\"name\":\"shell\",\"arguments\":\"{}\"}}\n\n",
            "event: response.failed\n",
            "data: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"type\":\"overloaded_error\"}}}\n\n",
        );
        let text_eof = "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial result\"}\n\n";
        for (session, bytes) in [
            ("recovery-tool-overload", tool_overload),
            ("recovery-text-eof", text_eof),
        ] {
            let context = context(session, 3);
            let stream = futures::stream::iter(vec![Ok::<_, std::io::Error>(Bytes::from(bytes))]);
            let output = observe_responses_turn_stream(stream, context.clone())
                .collect::<Vec<_>>()
                .await;
            assert_eq!(output.len(), 1);
            assert!(recovery_reserved_for_test(&context.desktop_thread_id));
            mark_turn_completed(&context.desktop_thread_id);
        }
    }

    #[test]
    fn successful_tool_step_preserves_budget_and_crash_evidence_for_the_tool_loop() {
        let context = context("recovery-tool-budget", 2);
        assert_eq!(reserve_recovery(&context), Some(1));
        finish_recovery(&context.desktop_thread_id, true);
        let tracked = track_turn(&context);
        mark_observed_tool_step_completed(&context);
        drop(tracked);
        let states = recovery_states().lock().unwrap();
        let state = states.get(&context.desktop_thread_id).unwrap();
        assert_eq!(state.submitted, 1);
        assert!(state.tracked.is_some());
        assert!(!state.active);
        drop(states);
        begin_turn(&context.desktop_thread_id, true);
        assert_eq!(reserve_recovery(&context), Some(2));
        finish_recovery(&context.desktop_thread_id, true);
        begin_turn(&context.desktop_thread_id, true);
        assert_eq!(reserve_recovery(&context), None);
        mark_turn_completed(&context.desktop_thread_id);
    }

    #[test]
    fn late_old_failure_cannot_replace_newer_inactive_tool_step_evidence() {
        let mut old = context("recovery-inactive-newer-tool-step", 3);
        old.observed_at_ms = 100;
        let mut newer = old.clone();
        newer.recovery_id = "newer-tool-step".into();
        newer.observed_at_ms = 200;
        let tracked = track_turn(&newer);
        mark_observed_tool_step_completed(&newer);
        assert_eq!(reserve_recovery(&old), None);
        let states = recovery_states().lock().unwrap();
        let state = states.get(&newer.desktop_thread_id).unwrap();
        assert_eq!(
            state.tracked.as_ref().unwrap().recovery_id,
            newer.recovery_id
        );
        assert!(!state.active);
        assert!(!state.in_flight);
        drop(states);
        drop(tracked);
        mark_turn_completed(&newer.desktop_thread_id);
    }

    #[test]
    fn request_failure_recovery_accepts_transport_capacity_and_server_errors_only() {
        use super::super::error::ProxyError;
        for error in [
            ProxyError::ForwardFailed("reset".into()),
            ProxyError::Timeout("first byte".into()),
            ProxyError::UpstreamError {
                status: 429,
                body: Some(r#"{"error":{"type":"rate_limit_exceeded"}}"#.into()),
            },
            ProxyError::UpstreamError {
                status: 503,
                body: Some(r#"{"error":{"type":"overloaded_error"}}"#.into()),
            },
            ProxyError::UpstreamError {
                status: 502,
                body: None,
            },
        ] {
            assert!(forward_error_is_recoverable(&error));
        }
        for error in [
            ProxyError::ResponsePending("unknown running result".into()),
            ProxyError::RequestHealthBlocked("review".into()),
            ProxyError::AuthError("expired".into()),
            ProxyError::UpstreamError {
                status: 429,
                body: Some(r#"{"error":{"type":"insufficient_quota"}}"#.into()),
            },
            ProxyError::UpstreamError {
                status: 500,
                body: Some(r#"{"error":{"code":"invalid_api_key"}}"#.into()),
            },
            ProxyError::UpstreamError {
                status: 400,
                body: None,
            },
        ] {
            assert!(!forward_error_is_recoverable(&error));
        }
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
            serde_json::json!({"response":{"error":{"code":"insufficient_quota"}}}),
            serde_json::json!({"response":{"error":{"code":"turn_cancelled"}}}),
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
            RecoveryDecision::Recover("response_failed")
        );
        assert!(stream_interruption_is_recoverable(tool_call));
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
