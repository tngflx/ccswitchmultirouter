//! Session-scoped Codex Desktop turn recovery.
//!
//! This is deliberately separate from proxy stream reconnection. The proxy may
//! replay a request only before semantic output. Aggressive recovery instead
//! asks Codex Desktop to start a new turn containing the literal `continue`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::providers::codex_terminal::{
    classify_native_responses_terminal, terminal_error_code, terminal_error_code_from_body,
    NativeResponsesEvidence, NativeResponsesTerminalDisposition,
};
use super::sse::{append_utf8_safe, strip_sse_field, take_sse_block};

const RECOVERY_STATE_TTL: Duration = Duration::from_secs(15 * 60);
const DESKTOP_READY_TIMEOUT: Duration = Duration::from_secs(60);
const DESKTOP_READY_DELAY: Duration = Duration::from_millis(500);
#[cfg(not(test))]
const RECOVERY_FILE: &str = "codex-turn-recovery.json";
const RECOVERY_LEDGER_VERSION: u32 = 2;
const MAX_OWNER_OPERATIONS_PER_THREAD: usize = 256;
const MAX_IDLE_OWNER_EPOCHS: usize = 128;
const IDLE_OWNER_EPOCH_TTL: Duration = Duration::from_secs(60);
const MAX_RECOVERY_LEDGER_BYTES: usize = 16 * 1024 * 1024;

/// Intent is recorded by the native transaction, never inferred from a proxy
/// prompt/header. Literal `continue` can only retain a restrictive old budget.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ContinuationIntent {
    AutoRecovery,
    OwnerContinue,
}

/// An opaque, process-local observation of the canonical per-thread action
/// epoch. It is not serializable and is not remote authorization.
#[derive(Clone, Debug)]
pub(crate) struct OwnerContinuationEpoch {
    thread_id: String,
    process_epoch: String,
    action_epoch: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OwnerContinuationStatus {
    Reserved,
    Committing,
    Submitted,
    Uncertain,
    Refused,
}

#[derive(Clone, Debug)]
pub(crate) struct OwnerContinuationOperation {
    epoch: OwnerContinuationEpoch,
    operation_id: String,
    base_turn_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnerContinuationReceipt {
    pub(crate) operation_id: String,
    pub(crate) status: OwnerContinuationStatus,
    pub(crate) submitted: bool,
    pub(crate) mutation_attempted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) acknowledged_turn_id: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) enum OwnerContinuationReservation {
    Reserved(OwnerContinuationOperation),
    AttachOnly(OwnerContinuationReceipt),
}

#[derive(Clone, Debug)]
pub(crate) enum OwnerContinuationOutcome {
    Submitted {
        turn_id: String,
    },
    Uncertain,
    /// Only a positive renderer no-mutation result can select Refused.
    Refused,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OwnerContinuationError {
    InvalidBinding,
    StaleEpoch,
    Busy,
    OperationConflict,
    JournalFull,
    StorageUnavailable,
}

impl std::fmt::Display for OwnerContinuationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidBinding => "Owner continuation binding is invalid",
            Self::StaleEpoch => "Owner continuation view is stale",
            Self::Busy => "The Codex thread is not available for owner continuation",
            Self::OperationConflict => "Owner operation id belongs to another view",
            Self::JournalFull => "Owner continuation journal requires reconciliation",
            Self::StorageUnavailable => "Owner continuation evidence storage is unavailable",
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContinuationTransaction {
    intent: ContinuationIntent,
    operation_id: String,
    action_epoch: String,
    base_turn_id: String,
    status: OwnerContinuationStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    accepted_turn_id: Option<String>,
    #[serde(default)]
    budget_reconciled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    superseded_auto_recovery_id: Option<String>,
}

impl ContinuationTransaction {
    fn receipt(&self) -> OwnerContinuationReceipt {
        OwnerContinuationReceipt {
            operation_id: self.operation_id.clone(),
            status: self.status,
            submitted: self.status == OwnerContinuationStatus::Submitted,
            acknowledged_turn_id: (self.status == OwnerContinuationStatus::Submitted)
                .then(|| self.accepted_turn_id.clone())
                .flatten(),
            mutation_attempted: matches!(
                self.status,
                OwnerContinuationStatus::Committing
                    | OwnerContinuationStatus::Submitted
                    | OwnerContinuationStatus::Uncertain
            ),
        }
    }

    fn blocks_same_epoch(&self, action_epoch: &str) -> bool {
        self.action_epoch == action_epoch
            && matches!(
                self.status,
                OwnerContinuationStatus::Reserved
                    | OwnerContinuationStatus::Committing
                    | OwnerContinuationStatus::Submitted
                    | OwnerContinuationStatus::Uncertain
            )
    }
}

static NATIVE_CONTINUATION_PROCESS_EPOCH: OnceLock<String> = OnceLock::new();
// A malformed/unreadable ledger or a failed write must not be overwritten by
// automatic bookkeeping and must never authorize a mutation.
static RECOVERY_STORAGE_HEALTHY: AtomicBool = AtomicBool::new(true);
static OWNER_LEDGER_LOADED: OnceLock<()> = OnceLock::new();

fn native_continuation_process_epoch() -> &'static str {
    NATIVE_CONTINUATION_PROCESS_EPOCH.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

fn valid_continuation_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

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
    phase: RecoveryPhase,
    updated_at: Instant,
    tracked: Option<TurnRecoveryContext>,
    action_epoch: String,
    tracked_epoch: Option<String>,
    reservation_epoch: Option<String>,
    reservation_intent: Option<ContinuationIntent>,
    commit_charged: bool,
    // Retained native mutation evidence lives in this same canonical ledger;
    // it has no independent sender, retry loop, or timeout retirement.
    continuations: HashMap<String, ContinuationTransaction>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum RecoveryPhase {
    #[default]
    Idle,
    ActiveRequest,
    ToolStepComplete,
    ReservedRecovery,
    CommittingRecovery,
    // Acknowledged or ambiguous submission, or cancelled queued recovery with
    // an already-spent budget. Keep the budget for the next continuation, but
    // never replay this old failed turn after a process restart.
    AwaitingContinuation,
}

impl Default for RecoveryState {
    fn default() -> Self {
        Self {
            submitted: 0,
            phase: RecoveryPhase::Idle,
            updated_at: Instant::now(),
            tracked: None,
            action_epoch: uuid::Uuid::new_v4().to_string(),
            tracked_epoch: None,
            reservation_epoch: None,
            reservation_intent: None,
            commit_charged: false,
            continuations: HashMap::new(),
        }
    }
}

static RECOVERY_STATES: OnceLock<Mutex<HashMap<String, RecoveryState>>> = OnceLock::new();

fn recovery_states() -> &'static Mutex<HashMap<String, RecoveryState>> {
    RECOVERY_STATES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn reset_automatic_state(state: &mut RecoveryState, reset_budget: bool) {
    if reset_budget {
        state.submitted = 0;
    }
    state.phase = RecoveryPhase::Idle;
    state.tracked = None;
    state.tracked_epoch = None;
    state.reservation_epoch = None;
    state.reservation_intent = None;
    state.commit_charged = false;
    state.updated_at = Instant::now();
}

fn make_automatic_budget_dormant(state: &mut RecoveryState) {
    state.phase = RecoveryPhase::AwaitingContinuation;
    state.reservation_epoch = None;
    state.reservation_intent = None;
    state.commit_charged = false;
    state.updated_at = Instant::now();
}

fn has_owner_transaction_for_current_epoch(state: &RecoveryState) -> bool {
    state
        .continuations
        .values()
        .any(|operation| operation.blocks_same_epoch(&state.action_epoch))
}

fn advance_action_epoch(state: &mut RecoveryState) {
    state.action_epoch = uuid::Uuid::new_v4().to_string();
    // A later user action invalidates uncommitted owner preparation. A commit
    // intent/outcome is retained; observing input does not establish provenance.
    for operation in state.continuations.values_mut() {
        if operation.status == OwnerContinuationStatus::Reserved {
            operation.status = OwnerContinuationStatus::Refused;
        }
    }
}

fn owner_epoch_capacity_allows(
    states: &mut HashMap<String, RecoveryState>,
    thread_id: &str,
    now: Instant,
) -> bool {
    let is_empty = |state: &RecoveryState| {
        state.phase == RecoveryPhase::Idle
            && state.tracked.is_none()
            && state.continuations.is_empty()
    };
    // Failed arbitrary thread reads must not accumulate epoch-only entries.
    // Never prune a transaction, active request, or unresolved mutation receipt.
    states.retain(|_, state| {
        !is_empty(state) || now.saturating_duration_since(state.updated_at) <= IDLE_OWNER_EPOCH_TTL
    });
    states.contains_key(thread_id)
        || states.values().filter(|state| is_empty(state)).count() < MAX_IDLE_OWNER_EPOCHS
}

pub(crate) fn owner_continuation_mutation_storage_available() -> bool {
    ensure_owner_ledger_loaded();
    RECOVERY_STORAGE_HEALTHY.load(Ordering::SeqCst)
}

pub(crate) fn capture_owner_continuation_epoch(
    thread_id: &str,
) -> Result<OwnerContinuationEpoch, OwnerContinuationError> {
    ensure_owner_ledger_loaded();
    if !valid_continuation_identifier(thread_id) {
        return Err(OwnerContinuationError::InvalidBinding);
    }
    let mut states = recovery_states()
        .lock()
        .map_err(|_| OwnerContinuationError::StorageUnavailable)?;
    let now = Instant::now();
    if !owner_epoch_capacity_allows(&mut states, thread_id, now) {
        return Err(OwnerContinuationError::Busy);
    }
    let state = states.entry(thread_id.to_owned()).or_default();
    if state.tracked.is_none() && state.continuations.is_empty() {
        state.updated_at = now;
    }
    Ok(OwnerContinuationEpoch {
        thread_id: thread_id.to_owned(),
        process_epoch: native_continuation_process_epoch().to_owned(),
        action_epoch: state.action_epoch.clone(),
    })
}

pub(crate) fn owner_continuation_epoch_is_current(epoch: &OwnerContinuationEpoch) -> bool {
    epoch.process_epoch == native_continuation_process_epoch()
        && recovery_states().lock().ok().is_some_and(|states| {
            states
                .get(&epoch.thread_id)
                .is_some_and(|state| state.action_epoch == epoch.action_epoch)
        })
}

pub(crate) fn reserve_owner_continuation(
    epoch: &OwnerContinuationEpoch,
    base_turn_id: &str,
    operation_id: &str,
) -> Result<OwnerContinuationReservation, OwnerContinuationError> {
    ensure_owner_ledger_loaded();
    if !RECOVERY_STORAGE_HEALTHY.load(Ordering::SeqCst) {
        return Err(OwnerContinuationError::StorageUnavailable);
    }
    if epoch.process_epoch != native_continuation_process_epoch()
        || !valid_continuation_identifier(base_turn_id)
        || !valid_continuation_identifier(operation_id)
    {
        return Err(OwnerContinuationError::InvalidBinding);
    }
    let mut states = recovery_states()
        .lock()
        .map_err(|_| OwnerContinuationError::StorageUnavailable)?;
    if states.iter().any(|(thread_id, state)| {
        thread_id != &epoch.thread_id && state.continuations.contains_key(operation_id)
    }) {
        return Err(OwnerContinuationError::OperationConflict);
    }
    let Some(state) = states.get_mut(&epoch.thread_id) else {
        return Err(OwnerContinuationError::StaleEpoch);
    };
    if let Some(existing) = state.continuations.get(operation_id) {
        if existing.action_epoch != epoch.action_epoch || existing.base_turn_id != base_turn_id {
            return Err(OwnerContinuationError::OperationConflict);
        }
        return Ok(OwnerContinuationReservation::AttachOnly(existing.receipt()));
    }
    if state.action_epoch != epoch.action_epoch {
        return Err(OwnerContinuationError::StaleEpoch);
    }
    // Old-base mutation evidence is not erased by a new action, TTL, or policy
    // change. Repeated clicks for the same exact base attach rather than send.
    if let Some(existing) = state.continuations.values().find(|operation| {
        operation.base_turn_id == base_turn_id
            && matches!(
                operation.status,
                OwnerContinuationStatus::Reserved
                    | OwnerContinuationStatus::Committing
                    | OwnerContinuationStatus::Submitted
                    | OwnerContinuationStatus::Uncertain
            )
    }) {
        return Ok(OwnerContinuationReservation::AttachOnly(existing.receipt()));
    }
    if matches!(
        state.phase,
        RecoveryPhase::ActiveRequest
            | RecoveryPhase::ToolStepComplete
            | RecoveryPhase::CommittingRecovery
    ) || state.continuations.values().any(|operation| {
        operation.status == OwnerContinuationStatus::Committing
            || operation.blocks_same_epoch(&state.action_epoch)
    }) {
        return Err(OwnerContinuationError::Busy);
    }
    if state.continuations.len() >= MAX_OWNER_OPERATIONS_PER_THREAD {
        return Err(OwnerContinuationError::JournalFull);
    }
    // The owner may replace only a queued, uncommitted automatic reservation.
    // Its old task fails the epoch/CAS checks at every later await/authorize.
    let superseded_auto_recovery_id = (state.phase == RecoveryPhase::ReservedRecovery)
        .then(|| {
            state
                .tracked
                .as_ref()
                .map(|context| context.recovery_id.clone())
        })
        .flatten();
    if state.phase == RecoveryPhase::ReservedRecovery {
        if state.submitted > 0 && state.tracked.is_some() {
            // Superseding a queued attempt is not an accepted new user turn.
            // Keep the old chain's spent cap durable until positive acceptance
            // or another real user turn; only its retry eligibility is retired.
            make_automatic_budget_dormant(state);
        } else {
            reset_automatic_state(state, false);
        }
    }
    let transaction = ContinuationTransaction {
        intent: ContinuationIntent::OwnerContinue,
        operation_id: operation_id.to_owned(),
        action_epoch: epoch.action_epoch.clone(),
        base_turn_id: base_turn_id.to_owned(),
        status: OwnerContinuationStatus::Reserved,
        accepted_turn_id: None,
        budget_reconciled: false,
        superseded_auto_recovery_id,
    };
    state
        .continuations
        .insert(operation_id.to_owned(), transaction);
    state.updated_at = Instant::now();
    if !persist_states(&states) {
        return Err(OwnerContinuationError::StorageUnavailable);
    }
    Ok(OwnerContinuationReservation::Reserved(
        OwnerContinuationOperation {
            epoch: epoch.clone(),
            operation_id: operation_id.to_owned(),
            base_turn_id: base_turn_id.to_owned(),
        },
    ))
}

fn owner_operation_matches(state: &RecoveryState, operation: &OwnerContinuationOperation) -> bool {
    operation.epoch.process_epoch == native_continuation_process_epoch()
        && state
            .continuations
            .get(&operation.operation_id)
            .is_some_and(|record| {
                record.intent == ContinuationIntent::OwnerContinue
                    && record.action_epoch == operation.epoch.action_epoch
                    && record.base_turn_id == operation.base_turn_id
            })
}

pub(crate) fn read_owner_continuation_receipt(
    operation_id: &str,
) -> Option<OwnerContinuationReceipt> {
    ensure_owner_ledger_loaded();
    if !valid_continuation_identifier(operation_id) {
        return None;
    }
    recovery_states().lock().ok()?.values().find_map(|state| {
        state
            .continuations
            .get(operation_id)
            .map(ContinuationTransaction::receipt)
    })
}

pub(crate) fn owner_continuation_is_reserved(operation: &OwnerContinuationOperation) -> bool {
    RECOVERY_STORAGE_HEALTHY.load(Ordering::SeqCst)
        && recovery_states().lock().ok().is_some_and(|states| {
            states.get(&operation.epoch.thread_id).is_some_and(|state| {
                owner_operation_matches(state, operation)
                    && state.action_epoch == operation.epoch.action_epoch
                    && state.continuations[&operation.operation_id].status
                        == OwnerContinuationStatus::Reserved
            })
        })
}

pub(crate) fn authorize_owner_continuation_commit(operation: &OwnerContinuationOperation) -> bool {
    authorize_owner_continuation_commit_with(operation, persist_states)
}

fn authorize_owner_continuation_commit_with(
    operation: &OwnerContinuationOperation,
    persist: impl FnOnce(&HashMap<String, RecoveryState>) -> bool,
) -> bool {
    if !RECOVERY_STORAGE_HEALTHY.load(Ordering::SeqCst) {
        return false;
    }
    let Ok(mut states) = recovery_states().lock() else {
        return false;
    };
    let Some(state) = states.get_mut(&operation.epoch.thread_id) else {
        return false;
    };
    if !owner_operation_matches(state, operation)
        || state.action_epoch != operation.epoch.action_epoch
        || state.continuations[&operation.operation_id].status != OwnerContinuationStatus::Reserved
        || matches!(
            state.phase,
            RecoveryPhase::ActiveRequest | RecoveryPhase::CommittingRecovery
        )
    {
        return false;
    }
    state
        .continuations
        .get_mut(&operation.operation_id)
        .unwrap()
        .status = OwnerContinuationStatus::Committing;
    state.updated_at = Instant::now();
    // Do not roll back an uncertain durable-write failure to a replayable
    // reservation. A failed write positively prevents this caller from sending.
    persist(&states)
}

pub(crate) fn finish_owner_continuation(
    operation: &OwnerContinuationOperation,
    outcome: OwnerContinuationOutcome,
) -> OwnerContinuationReceipt {
    let fallback = OwnerContinuationReceipt {
        operation_id: operation.operation_id.clone(),
        status: OwnerContinuationStatus::Uncertain,
        submitted: false,
        mutation_attempted: true,
        acknowledged_turn_id: None,
    };
    let Ok(mut states) = recovery_states().lock() else {
        return fallback;
    };
    let Some(state) = states.get_mut(&operation.epoch.thread_id) else {
        return fallback;
    };
    if !owner_operation_matches(state, operation) {
        return fallback;
    }
    let record = state
        .continuations
        .get_mut(&operation.operation_id)
        .unwrap();
    if !matches!(
        record.status,
        OwnerContinuationStatus::Reserved | OwnerContinuationStatus::Committing
    ) {
        return record.receipt();
    }
    match outcome {
        OwnerContinuationOutcome::Submitted { turn_id }
            if record.status == OwnerContinuationStatus::Committing
                && valid_continuation_identifier(&turn_id)
                && turn_id != record.base_turn_id =>
        {
            record.status = OwnerContinuationStatus::Submitted;
            record.accepted_turn_id = Some(turn_id);
            // If input arrived during commit, no proxy body can prove whose
            // input it was. A later exact acknowledged-turn read reconciles it.
            if state.action_epoch == operation.epoch.action_epoch {
                state.submitted = 0;
                record.budget_reconciled = true;
            }
        }
        OwnerContinuationOutcome::Refused => record.status = OwnerContinuationStatus::Refused,
        _ if record.status == OwnerContinuationStatus::Committing => {
            record.status = OwnerContinuationStatus::Uncertain;
        }
        _ => record.status = OwnerContinuationStatus::Refused,
    }
    state.updated_at = Instant::now();
    let receipt = record.receipt();
    if !persist_states(&states) && receipt.mutation_attempted {
        return fallback;
    }
    receipt
}

/// Only the exact owned native view adapter may supply this post-read proof.
/// It must capture/recheck epoch around a read proving the current turn equals
/// the validated acknowledgement, not infer it from a proxy `continue` body.
pub(crate) fn reconcile_owner_accepted_turn(
    epoch: &OwnerContinuationEpoch,
    current_turn_id: &str,
) -> bool {
    if epoch.process_epoch != native_continuation_process_epoch()
        || !valid_continuation_identifier(current_turn_id)
        || !RECOVERY_STORAGE_HEALTHY.load(Ordering::SeqCst)
    {
        return false;
    }
    let Ok(mut states) = recovery_states().lock() else {
        return false;
    };
    let Some(state) = states.get_mut(&epoch.thread_id) else {
        return false;
    };
    if state.action_epoch != epoch.action_epoch
        || state.commit_charged
        || matches!(
            state.phase,
            RecoveryPhase::ReservedRecovery | RecoveryPhase::CommittingRecovery
        )
    {
        return false;
    }
    let Some(record) = state.continuations.values_mut().find(|record| {
        record.status == OwnerContinuationStatus::Submitted
            && !record.budget_reconciled
            && record.accepted_turn_id.as_deref() == Some(current_turn_id)
    }) else {
        return false;
    };
    record.budget_reconciled = true;
    state.submitted = 0;
    state.updated_at = Instant::now();
    persist_states(&states)
}

fn reserve_recovery(context: &TurnRecoveryContext) -> Option<u32> {
    ensure_owner_ledger_loaded();
    if !context.desktop_eligible
        || context.max_recoveries == 0
        || context.desktop_thread_id.is_empty()
    {
        return None;
    }

    let now = Instant::now();
    let mut states = recovery_states().lock().ok()?;
    states.retain(|_, state| {
        !state.continuations.is_empty()
            || now.duration_since(state.updated_at) <= RECOVERY_STATE_TTL
    });
    let state = states.entry(context.desktop_thread_id.clone()).or_default();
    if has_owner_transaction_for_current_epoch(state)
        || state.continuations.values().any(|operation| {
            operation.status == OwnerContinuationStatus::Committing
                || operation.superseded_auto_recovery_id.as_deref()
                    == Some(context.recovery_id.as_str())
        })
        || (state
            .tracked
            .as_ref()
            .is_some_and(|tracked| tracked.recovery_id == context.recovery_id)
            && state.tracked_epoch.as_deref() != Some(state.action_epoch.as_str()))
    {
        return None;
    }
    if state.phase == RecoveryPhase::AwaitingContinuation
        && state
            .tracked
            .as_ref()
            .is_some_and(|tracked| tracked.recovery_id == context.recovery_id)
    {
        return None;
    }
    if state.tracked.as_ref().is_some_and(|tracked| {
        tracked.recovery_id != context.recovery_id
            && (state.phase == RecoveryPhase::ActiveRequest
                || tracked.observed_at_ms >= context.observed_at_ms)
    }) {
        return None;
    }
    if matches!(
        state.phase,
        RecoveryPhase::ReservedRecovery | RecoveryPhase::CommittingRecovery
    ) || state.submitted >= context.max_recoveries
    {
        return None;
    }
    // Once a later automatic chain reserves, a delayed owner-acceptance read
    // must never refund that chain's reserved/precharged/uncertain attempts.
    // Settle the old owner budget conservatively without granting a reset.
    for operation in state.continuations.values_mut() {
        if operation.status == OwnerContinuationStatus::Submitted {
            operation.budget_reconciled = true;
        }
    }
    state.phase = RecoveryPhase::ReservedRecovery;
    state.tracked = Some(context.clone());
    state.tracked_epoch = Some(state.action_epoch.clone());
    state.reservation_epoch = Some(state.action_epoch.clone());
    state.reservation_intent = Some(ContinuationIntent::AutoRecovery);
    state.commit_charged = false;
    state.updated_at = now;
    let attempt = state.submitted.saturating_add(1);
    persist_states(&states).then_some(attempt)
}

// Test-only simulation/cleanup. Runtime completions must carry their observed context.
#[cfg(test)]
pub(crate) fn mark_turn_completed(session_id: &str) {
    ensure_owner_ledger_loaded();
    if let Ok(mut states) = recovery_states().lock() {
        if let Some(state) = states.get_mut(session_id) {
            advance_action_epoch(state);
            reset_automatic_state(state, true);
            if state.continuations.is_empty() {
                states.remove(session_id);
            }
        }
        persist_states(&states);
    }
}

pub(crate) fn mark_observed_turn_completed(context: &TurnRecoveryContext) {
    if let Ok(mut states) = recovery_states().lock() {
        let owned = states.get(&context.desktop_thread_id).is_some_and(|state| {
            state.phase != RecoveryPhase::AwaitingContinuation
                && state.tracked_epoch.as_deref() == Some(state.action_epoch.as_str())
                && state
                    .tracked
                    .as_ref()
                    .is_some_and(|tracked| tracked.recovery_id == context.recovery_id)
        });
        if owned {
            let state = states.get_mut(&context.desktop_thread_id).unwrap();
            reset_automatic_state(state, true);
            if state.continuations.is_empty() {
                states.remove(&context.desktop_thread_id);
            }
            persist_states(&states);
        }
    }
}

fn mark_observed_tool_step_completed(context: &TurnRecoveryContext) {
    if let Ok(mut states) = recovery_states().lock() {
        if let Some(state) = states.get_mut(&context.desktop_thread_id) {
            if state.phase != RecoveryPhase::AwaitingContinuation
                && state.tracked_epoch.as_deref() == Some(state.action_epoch.as_str())
                && state
                    .tracked
                    .as_ref()
                    .is_some_and(|tracked| tracked.recovery_id == context.recovery_id)
            {
                state.phase = RecoveryPhase::ToolStepComplete;
                state.updated_at = Instant::now();
                persist_states(&states);
            }
        }
    }
}

/// Every unproven user input is a new native action epoch. A literal continue
/// only retains a conservative already-spent automatic cap; it does not prove
/// that this module (or the owner) submitted that input and never charges it.
/// Tool-only/unknown requests do not call this function and retain their chain.
pub(crate) fn begin_turn(session_id: &str, preserve_spent_budget: bool) {
    ensure_owner_ledger_loaded();
    if let Ok(mut states) = recovery_states().lock() {
        let state = states.entry(session_id.to_owned()).or_default();
        advance_action_epoch(state);
        if preserve_spent_budget && state.submitted > 0 && state.tracked.is_some() {
            // Retain spent-cap crash evidence across the gap before this new
            // request is tracked. This is not proof that its input came from
            // our sender; the old epoch can never authorize another mutation.
            state.phase = RecoveryPhase::AwaitingContinuation;
            state.reservation_epoch = None;
            state.reservation_intent = None;
            state.updated_at = Instant::now();
        } else {
            reset_automatic_state(state, !preserve_spent_budget);
        }
        persist_states(&states);
    }
}

fn recovery_is_active(context: &TurnRecoveryContext) -> bool {
    recovery_states()
        .lock()
        .ok()
        .and_then(|states| {
            states.get(&context.desktop_thread_id).map(|state| {
                matches!(
                    state.phase,
                    RecoveryPhase::ReservedRecovery | RecoveryPhase::CommittingRecovery
                ) && state.reservation_epoch.as_deref() == Some(state.action_epoch.as_str())
                    && state.reservation_intent == Some(ContinuationIntent::AutoRecovery)
                    && !has_owner_transaction_for_current_epoch(state)
                    && state
                        .tracked
                        .as_ref()
                        .is_some_and(|tracked| tracked.recovery_id == context.recovery_id)
            })
        })
        .unwrap_or(false)
}

fn authorize_reserved_recovery(context: &TurnRecoveryContext) -> bool {
    authorize_reserved_recovery_with(context, persist_states)
}

fn authorize_reserved_recovery_with(
    context: &TurnRecoveryContext,
    persist: impl FnOnce(&HashMap<String, RecoveryState>) -> bool,
) -> bool {
    if !RECOVERY_STORAGE_HEALTHY.load(Ordering::SeqCst) {
        return false;
    }
    let Ok(mut states) = recovery_states().lock() else {
        return false;
    };
    let Some(state) = states.get_mut(&context.desktop_thread_id) else {
        return false;
    };
    if state.phase != RecoveryPhase::ReservedRecovery
        || state.reservation_epoch.as_deref() != Some(state.action_epoch.as_str())
        || state.reservation_intent != Some(ContinuationIntent::AutoRecovery)
        || has_owner_transaction_for_current_epoch(state)
        || state
            .tracked
            .as_ref()
            .is_none_or(|tracked| tracked.recovery_id != context.recovery_id)
    {
        return false;
    }
    state.phase = RecoveryPhase::CommittingRecovery;
    // Charge the exact native transaction at durable precommit. An arriving
    // proxy body is never treated as proof of origin/acceptance.
    state.submitted = state.submitted.saturating_add(1);
    state.commit_charged = true;
    state.updated_at = Instant::now();
    persist(&states)
}

#[cfg(test)]
pub(crate) fn authorize_recovery_commit_for_test(context: &TurnRecoveryContext) -> bool {
    authorize_reserved_recovery(context)
}

fn recovery_commit_started(context: &TurnRecoveryContext) -> bool {
    recovery_states().lock().ok().is_some_and(|states| {
        states.get(&context.desktop_thread_id).is_some_and(|state| {
            state.phase == RecoveryPhase::CommittingRecovery
                && state.reservation_epoch.as_deref() == Some(state.action_epoch.as_str())
                && state.reservation_intent == Some(ContinuationIntent::AutoRecovery)
                && state
                    .tracked
                    .as_ref()
                    .is_some_and(|tracked| tracked.recovery_id == context.recovery_id)
        })
    })
}

fn release_refused_recovery_commit(context: &TurnRecoveryContext) {
    if !RECOVERY_STORAGE_HEALTHY.load(Ordering::SeqCst) {
        return;
    }
    let Ok(mut states) = recovery_states().lock() else {
        return;
    };
    let Some(state) = states.get_mut(&context.desktop_thread_id) else {
        return;
    };
    if state.phase == RecoveryPhase::CommittingRecovery
        && state.reservation_epoch.as_deref() == Some(state.action_epoch.as_str())
        && state.reservation_intent == Some(ContinuationIntent::AutoRecovery)
        && state
            .tracked
            .as_ref()
            .is_some_and(|tracked| tracked.recovery_id == context.recovery_id)
    {
        state.phase = RecoveryPhase::ReservedRecovery;
        if state.commit_charged {
            state.submitted = state.submitted.saturating_sub(1);
            state.commit_charged = false;
        }
        state.updated_at = Instant::now();
        persist_states(&states);
    }
}

fn finish_reserved_recovery(context: &TurnRecoveryContext, submitted: bool) -> u32 {
    let Ok(mut states) = recovery_states().lock() else {
        return 0;
    };
    let Some(state) = states.get_mut(&context.desktop_thread_id) else {
        return 0;
    };
    if !matches!(
        state.phase,
        RecoveryPhase::ReservedRecovery | RecoveryPhase::CommittingRecovery
    ) || state.reservation_epoch.as_deref() != Some(state.action_epoch.as_str())
        || state.reservation_intent != Some(ContinuationIntent::AutoRecovery)
        || state
            .tracked
            .as_ref()
            .is_none_or(|tracked| tracked.recovery_id != context.recovery_id)
    {
        return state.submitted;
    }
    let committed_submission = submitted && state.phase == RecoveryPhase::CommittingRecovery;
    // A positive no-mutation finish can retire its precommit charge. Ambiguous
    // results use submitted=true and must retain it.
    if !submitted && state.commit_charged {
        state.submitted = state.submitted.saturating_sub(1);
    }
    state.phase = if committed_submission {
        RecoveryPhase::AwaitingContinuation
    } else {
        RecoveryPhase::Idle
    };
    state.commit_charged = false;
    state.reservation_epoch = None;
    state.reservation_intent = None;
    state.updated_at = Instant::now();
    let submitted = state.submitted;
    persist_states(&states);
    submitted
}

fn cancel_reserved_recovery(context: &TurnRecoveryContext) {
    let Ok(mut states) = recovery_states().lock() else {
        return;
    };
    let Some(state) = states.get_mut(&context.desktop_thread_id) else {
        return;
    };
    if !matches!(
        state.phase,
        RecoveryPhase::ReservedRecovery | RecoveryPhase::CommittingRecovery
    ) || state.reservation_epoch.as_deref() != Some(state.action_epoch.as_str())
        || state.reservation_intent != Some(ContinuationIntent::AutoRecovery)
        || state
            .tracked
            .as_ref()
            .is_none_or(|tracked| tracked.recovery_id != context.recovery_id)
    {
        return;
    }
    if state.submitted > 0 {
        state.phase = RecoveryPhase::AwaitingContinuation;
        state.reservation_epoch = None;
        state.reservation_intent = None;
        state.commit_charged = false;
        state.updated_at = Instant::now();
    } else {
        reset_automatic_state(state, false);
        if state.continuations.is_empty() {
            states.remove(&context.desktop_thread_id);
        }
    }
    persist_states(&states);
}

#[cfg(test)]
pub(crate) fn recovery_reserved_for_test(thread_id: &str) -> bool {
    recovery_states()
        .lock()
        .ok()
        .and_then(|states| {
            states.get(thread_id).map(|state| {
                matches!(
                    state.phase,
                    RecoveryPhase::ReservedRecovery | RecoveryPhase::CommittingRecovery
                )
            })
        })
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
                    state.phase == RecoveryPhase::ActiveRequest
                        && state
                            .tracked
                            .as_ref()
                            .is_some_and(|tracked| tracked.recovery_id == self.context.recovery_id)
                });
            if owned_active {
                let state = states.get_mut(&self.context.desktop_thread_id).unwrap();
                reset_automatic_state(state, true);
                if state.continuations.is_empty() {
                    states.remove(&self.context.desktop_thread_id);
                }
                persist_states(&states);
            }
        }
    }
}

pub(crate) fn track_turn(context: &TurnRecoveryContext) -> TrackedTurn {
    ensure_owner_ledger_loaded();
    let armed = context.desktop_eligible && !context.desktop_thread_id.is_empty();
    let mut owns_state = false;
    if armed {
        if let Ok(mut states) = recovery_states().lock() {
            let state = states.entry(context.desktop_thread_id.clone()).or_default();
            let can_claim = state.tracked.as_ref().is_none_or(|tracked| {
                (tracked.recovery_id == context.recovery_id
                    && state.phase != RecoveryPhase::AwaitingContinuation
                    && state.tracked_epoch.as_deref() == Some(state.action_epoch.as_str()))
                    || (tracked.recovery_id != context.recovery_id
                        && state.phase == RecoveryPhase::AwaitingContinuation
                        && state.tracked_epoch.as_deref() != Some(state.action_epoch.as_str()))
                    || context.observed_at_ms > tracked.observed_at_ms
            });
            if can_claim {
                // A tool-only followup is not a new user action, but its exact
                // request still invalidates an idle owner view.
                advance_action_epoch(state);
                state.tracked = Some(context.clone());
                state.tracked_epoch = Some(state.action_epoch.clone());
                state.reservation_epoch = None;
                state.reservation_intent = None;
                state.commit_charged = false;
                state.phase = RecoveryPhase::ActiveRequest;
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
                    if state.phase != RecoveryPhase::ActiveRequest
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryLedger {
    #[serde(default = "legacy_recovery_ledger_version")]
    version: u32,
    #[serde(alias = "config_scope")]
    config_scope: String,
    #[serde(alias = "saved_at")]
    saved_at: i64,
    turns: Vec<PersistedTurn>,
    #[serde(default)]
    continuations: Vec<PersistedContinuation>,
}

fn legacy_recovery_ledger_version() -> u32 {
    1
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedContinuation {
    thread_id: String,
    transaction: ContinuationTransaction,
}

static STARTUP_LEDGER: OnceLock<Mutex<Option<RecoveryLedger>>> = OnceLock::new();

fn validate_ledger(ledger: &RecoveryLedger, config_scope: &str) -> bool {
    matches!(ledger.version, 1 | RECOVERY_LEDGER_VERSION)
        && (ledger.version == RECOVERY_LEDGER_VERSION || ledger.continuations.is_empty())
        && ledger.config_scope == config_scope
        && ledger.continuations.iter().all(|entry| {
            valid_continuation_identifier(&entry.thread_id)
                && entry.transaction.intent == ContinuationIntent::OwnerContinue
                && valid_continuation_identifier(&entry.transaction.operation_id)
                && valid_continuation_identifier(&entry.transaction.action_epoch)
                && valid_continuation_identifier(&entry.transaction.base_turn_id)
                && entry
                    .transaction
                    .superseded_auto_recovery_id
                    .as_deref()
                    .is_none_or(valid_continuation_identifier)
                && match entry.transaction.status {
                    OwnerContinuationStatus::Submitted => entry
                        .transaction
                        .accepted_turn_id
                        .as_deref()
                        .is_some_and(|turn_id| {
                            valid_continuation_identifier(turn_id)
                                && turn_id != entry.transaction.base_turn_id
                        }),
                    _ => {
                        entry.transaction.accepted_turn_id.is_none()
                            && !entry.transaction.budget_reconciled
                    }
                }
        })
        && {
            let mut identities = std::collections::HashSet::new();
            ledger
                .continuations
                .iter()
                .all(|entry| identities.insert(&entry.transaction.operation_id))
        }
}

fn import_owner_continuations(ledger: &RecoveryLedger) {
    if let Ok(mut states) = recovery_states().lock() {
        for entry in &ledger.continuations {
            let state = states.entry(entry.thread_id.clone()).or_default();
            let mut transaction = entry.transaction.clone();
            transaction.status = match transaction.status {
                // A reservation from another process is never replayed.
                OwnerContinuationStatus::Reserved => OwnerContinuationStatus::Refused,
                OwnerContinuationStatus::Committing => OwnerContinuationStatus::Uncertain,
                other => other,
            };
            state
                .continuations
                .entry(transaction.operation_id.clone())
                .or_insert(transaction);
        }
        for turn in &ledger.turns {
            if turn.submitted == 0 {
                continue;
            }
            let Some(state) = states.get_mut(&turn.context.desktop_thread_id) else {
                continue;
            };
            if state.continuations.is_empty() || state.tracked.is_some() {
                continue;
            }
            state.submitted = turn.submitted;
            state.tracked = Some(turn.context.clone());
            state.tracked_epoch = Some(state.action_epoch.clone());
            make_automatic_budget_dormant(state);
        }
    } else {
        RECOVERY_STORAGE_HEALTHY.store(false, Ordering::SeqCst);
    }
}

fn ensure_owner_ledger_loaded() {
    OWNER_LEDGER_LOADED.get_or_init(|| {
        // Fixtures must never read or mutate a running user's recovery ledger.
        #[cfg(not(test))]
        {
            let loaded = match std::fs::read(recovery_path()) {
                Ok(bytes) => serde_json::from_slice::<RecoveryLedger>(&bytes)
                    .ok()
                    .filter(|ledger| validate_ledger(ledger, &crate::process_identity::config_scope_fingerprint()))
                    .map(Some)
                    .ok_or(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(_) => Err(()),
            };
            match loaded {
                Ok(ledger) => {
                    if let Some(ledger) = &ledger {
                        import_owner_continuations(ledger);
                    }
                    let _ = STARTUP_LEDGER.set(Mutex::new(ledger));
                }
                Err(()) => {
                    RECOVERY_STORAGE_HEALTHY.store(false, Ordering::SeqCst);
                    log::warn!("[Codex/Recovery] recovery evidence is unreadable; continuation mutation is disabled");
                    let _ = STARTUP_LEDGER.set(Mutex::new(None));
                }
            }
        }
    });
}

/// Load durable transaction tombstones regardless of exit classification/TTL.
/// Only automatic interrupted-request scheduling is limited to crash recovery.
pub(crate) fn capture_startup_recovery(
    classification: crate::app_exit_monitor::PreviousRunClassification,
) {
    ensure_owner_ledger_loaded();
    if !classification.allows_proxy_startup() {
        return;
    }
    if !classification.allows_crash_recovery() {
        if let Some(ledger) = STARTUP_LEDGER.get() {
            if let Ok(mut ledger) = ledger.lock() {
                *ledger = None;
            }
        }
        clear_persisted_recovery();
    }
}

#[derive(Serialize, Deserialize)]
struct PersistedTurn {
    context: TurnRecoveryContext,
    submitted: u32,
    #[serde(default)]
    phase: RecoveryPhase,
    // Version-1 committing records charged on acknowledgement; version 2
    // charges before send so restore must never add the same charge twice.
    #[serde(default)]
    commit_charged: bool,
}

fn ledger_from_states(states: &HashMap<String, RecoveryState>) -> RecoveryLedger {
    RecoveryLedger {
        version: RECOVERY_LEDGER_VERSION,
        config_scope: crate::process_identity::config_scope_fingerprint(),
        saved_at: chrono::Utc::now().timestamp(),
        turns: states
            .values()
            .filter_map(|state| {
                let context = state.tracked.as_ref()?;
                (state.updated_at.elapsed() <= RECOVERY_STATE_TTL
                    || (state.submitted > 0 && !state.continuations.is_empty()))
                .then(|| PersistedTurn {
                    context: context.clone(),
                    submitted: state.submitted,
                    phase: state.phase,
                    commit_charged: state.commit_charged,
                })
            })
            .collect(),
        // No wall-clock TTL retires attempted/uncertain owner evidence.
        continuations: states
            .iter()
            .flat_map(|(thread_id, state)| {
                state
                    .continuations
                    .values()
                    .map(|transaction| PersistedContinuation {
                        thread_id: thread_id.clone(),
                        transaction: transaction.clone(),
                    })
            })
            .collect(),
    }
}

#[cfg(not(test))]
fn recovery_path() -> std::path::PathBuf {
    crate::config::get_app_config_dir()
        .join("logs")
        .join(RECOVERY_FILE)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecoveryPersistenceError {
    TooLarge,
    Serialization,
    AtomicWrite,
    FileSync,
    #[cfg(unix)]
    DirectorySync,
}

fn synchronize_recovery_ledger(path: &std::path::Path) -> Result<(), RecoveryPersistenceError> {
    std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .and_then(|file| file.sync_all())
        .map_err(|_| RecoveryPersistenceError::FileSync)?;
    #[cfg(unix)]
    std::fs::File::open(
        path.parent()
            .ok_or(RecoveryPersistenceError::DirectorySync)?,
    )
    .and_then(|directory| directory.sync_all())
    .map_err(|_| RecoveryPersistenceError::DirectorySync)?;
    Ok(())
}

fn persist_ledger_to_path(
    path: &std::path::Path,
    bytes: &[u8],
) -> Result<(), RecoveryPersistenceError> {
    persist_ledger_to_path_with_sync(path, bytes, synchronize_recovery_ledger)
}

fn persist_ledger_to_path_with_sync(
    path: &std::path::Path,
    bytes: &[u8],
    synchronize: impl FnOnce(&std::path::Path) -> Result<(), RecoveryPersistenceError>,
) -> Result<(), RecoveryPersistenceError> {
    if bytes.len() > MAX_RECOVERY_LEDGER_BYTES {
        return Err(RecoveryPersistenceError::TooLarge);
    }
    crate::config::atomic_write_private(path, bytes)
        .map_err(|_| RecoveryPersistenceError::AtomicWrite)?;
    // atomic_write flushes buffers but does not fsync. Authorize only after
    // the evidence reaches this durable-write boundary. Any error propagates.
    synchronize(path)
}

fn persist_states_to_path(
    states: &HashMap<String, RecoveryState>,
    path: &std::path::Path,
) -> Result<(), RecoveryPersistenceError> {
    let bytes = serde_json::to_vec(&ledger_from_states(states))
        .map_err(|_| RecoveryPersistenceError::Serialization)?;
    persist_ledger_to_path(path, &bytes)
}

fn persist_states(states: &HashMap<String, RecoveryState>) -> bool {
    if !RECOVERY_STORAGE_HEALTHY.load(Ordering::SeqCst) {
        return false;
    }
    #[cfg(not(test))]
    if persist_states_to_path(states, &recovery_path()).is_err() {
        RECOVERY_STORAGE_HEALTHY.store(false, Ordering::SeqCst);
        log::warn!(
            "[Codex/Recovery] failed to persist continuation evidence; mutation is disabled"
        );
        return false;
    }
    // Routine tests still never touch the running user's ledger. Dedicated
    // tests exercise this same IO helper explicitly with an isolated tempfile.
    #[cfg(test)]
    let _ = states;
    true
}

fn retire_automatic_scheduling_for_exit(state: &mut RecoveryState) -> bool {
    if !state.continuations.is_empty() && state.submitted > 0 && state.tracked.is_some() {
        make_automatic_budget_dormant(state);
    } else {
        reset_automatic_state(state, true);
    }
    advance_action_epoch(state);
    !state.continuations.is_empty()
}

/// An explicit exit retires automatic crash scheduling, not durable owner
/// mutation evidence. A malformed document is preserved without overwriting it.
pub(crate) fn clear_persisted_recovery() {
    ensure_owner_ledger_loaded();
    if let Ok(mut states) = recovery_states().lock() {
        states.retain(|_, state| retire_automatic_scheduling_for_exit(state));
        persist_states(&states);
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
    if !classification.allows_crash_recovery() {
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
        let submitted = turn.submitted.saturating_add(u32::from(
            turn.phase == RecoveryPhase::CommittingRecovery && !turn.commit_charged,
        ));
        if budget > 0 {
            context.max_recoveries = context.max_recoveries.min(budget);
        }
        let dormant = matches!(
            turn.phase,
            RecoveryPhase::AwaitingContinuation | RecoveryPhase::CommittingRecovery
        ) || (submitted > 0 && (budget == 0 || submitted >= context.max_recoveries));
        let provider_matches = db
            .get_provider_by_id(&context.durable_provider_id, "codex")
            .ok()
            .flatten()
            .is_some_and(|provider| durable_provider_matches(&context, &provider));
        if context.desktop_thread_id.is_empty()
            || (!dormant && (budget == 0 || submitted >= context.max_recoveries))
            || !provider_matches
        {
            continue;
        }
        if let Ok(mut states) = recovery_states().lock() {
            let state = states.entry(context.desktop_thread_id.clone()).or_default();
            // Strict startup import may already retain a dormant spent cap
            // alongside owner evidence. It is not a newly observed request;
            // only this exact saved generation may resume normal automatic
            // crash policy. A live newer request still wins unconditionally.
            let imported_same_generation_budget = !state.continuations.is_empty()
                && state.phase == RecoveryPhase::AwaitingContinuation
                && state.submitted == submitted
                && state
                    .tracked
                    .as_ref()
                    .is_some_and(|tracked| tracked.recovery_id == context.recovery_id);
            if (state.tracked.is_some() && !imported_same_generation_budget)
                || has_owner_transaction_for_current_epoch(state)
            {
                continue;
            }
            state.submitted = submitted;
            state.phase = if dormant {
                RecoveryPhase::AwaitingContinuation
            } else {
                RecoveryPhase::Idle
            };
            state.tracked = dormant.then(|| context.clone());
            state.tracked_epoch = dormant.then(|| state.action_epoch.clone());
        }
        if dormant {
            continue;
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
fn recovery_binding_is_current(context: &TurnRecoveryContext, next_attempt: u32) -> bool {
    recovery_policy_allows_attempt(
        context,
        next_attempt,
        crate::settings::get_settings().stream_recovery_budget(),
    ) && crate::settings::get_current_provider(&crate::app_config::AppType::Codex).as_deref()
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

fn recovery_policy_allows_attempt(
    context: &TurnRecoveryContext,
    next_attempt: u32,
    current_budget: u32,
) -> bool {
    next_attempt > 0 && next_attempt <= context.max_recoveries && next_attempt <= current_budget
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
                .and_then(terminal_error_code_from_body)
                .is_some();
            !permanent && super::providers::codex_terminal::http_error_status_is_retryable(*status)
        }
        // ResponsePending is an unknown still-running upstream operation;
        // neither a replay nor a new turn may duplicate it.
        _ => false,
    }
}

pub(crate) fn schedule_turn_recovery(context: TurnRecoveryContext, reason: &'static str) {
    let Some(next_attempt) = reserve_recovery(&context) else {
        if context.desktop_eligible {
            log_recovery_event(
                &context,
                if context.max_recoveries == 0 {
                    "disabled"
                } else {
                    "not_scheduled"
                },
                reason,
                None,
            );
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
            let authorization_context = context.clone();
            crate::codex_desktop::submit_codex_continuation(
                &context.desktop_thread_id,
                &format!("{}:{next_attempt}", context.recovery_id),
                &context.desktop_model,
                context.observed_at_ms,
                move |final_commit| {
                    recovery_is_active(&authorization_context)
                        && recovery_binding_is_current(&authorization_context, next_attempt)
                        && (!final_commit || authorize_reserved_recovery(&authorization_context))
                },
            )
            .await
        },
        recovery_binding_is_current,
    ));
}

/// Logical failed-chat continuation has its own backoff. It never replays the
/// completed tool calls/text of the failed request. The attempt budget stays in
/// the existing per-thread ledger, not in a second timer-owned state store.
fn continuation_backoff(attempt: u32) -> Duration {
    Duration::from_secs(300 * (1u64 << attempt.saturating_sub(1).min(2)))
}

async fn wait_for_continuation_backoff(
    context: &TurnRecoveryContext,
    next_attempt: u32,
    binding_is_current: &impl Fn(&TurnRecoveryContext, u32) -> bool,
) -> bool {
    let until = tokio::time::Instant::now() + continuation_backoff(next_attempt);
    loop {
        if !recovery_is_active(context) {
            // A new user turn or another owner may clear the reservation while
            // this task is asleep. Surface that cancellation to the activity
            // feed instead of making the scheduled retry look like it vanished.
            log_recovery_event(
                context,
                "cancelled",
                "turn_activity_changed",
                Some(next_attempt),
            );
            return false;
        }
        if !binding_is_current(context, next_attempt) {
            cancel_reserved_recovery(context);
            log_recovery_event(
                context,
                "cancelled",
                "recovery_settings_or_provider_changed",
                Some(next_attempt),
            );
            return false;
        }
        // Refresh the canonical lease during a long wait. Otherwise unrelated
        // thread activity could prune a third (20-minute) wait at the 15m TTL.
        if let Ok(mut states) = recovery_states().lock() {
            if let Some(state) = states.get_mut(&context.desktop_thread_id) {
                if state
                    .tracked
                    .as_ref()
                    .is_some_and(|tracked| tracked.recovery_id == context.recovery_id)
                {
                    state.updated_at = Instant::now();
                    persist_states(&states);
                }
            }
        }
        if tokio::time::Instant::now() >= until {
            return true;
        }
        tokio::time::sleep_until(until.min(tokio::time::Instant::now() + Duration::from_secs(5)))
            .await;
    }
}

async fn run_turn_recovery<Submit, SubmitFuture, Binding>(
    context: TurnRecoveryContext,
    reason: &'static str,
    next_attempt: u32,
    submit: Submit,
    binding_is_current: Binding,
) where
    Submit: FnMut(TurnRecoveryContext, u32) -> SubmitFuture,
    SubmitFuture:
        std::future::Future<Output = Result<crate::codex_desktop::CodexContinuationResult, String>>,
    Binding: Fn(&TurnRecoveryContext, u32) -> bool,
{
    if !wait_for_continuation_backoff(&context, next_attempt, &binding_is_current).await {
        return;
    }
    run_turn_recovery_with_deadline_reporter(
        context,
        reason,
        next_attempt,
        submit,
        binding_is_current,
        |context, attempt, commit_started, blocker| {
            log_recovery_event_with_blocker(
                context,
                if commit_started {
                    "outcome_unknown"
                } else {
                    "submit_failed"
                },
                "desktop_ready_deadline",
                Some(attempt),
                Some(blocker),
            );
        },
    )
    .await;
}

// Classify only known bridge diagnostics. Arbitrary renderer/transport errors
// may contain request data or credentials and must never enter recovery logs.
fn desktop_readiness_blocker(message: &str) -> &'static str {
    let message = message.to_ascii_lowercase();
    if message.contains("compatibility layer is not ready")
        || message.contains("continuation commit is not ready")
        || message.contains("compatibility runtime was replaced")
    {
        "compatibility_runtime_unavailable"
    } else if message.contains("request client was not found") {
        "desktop_request_client_unavailable"
    } else if message.contains("still active") || message.contains("latest codex turn is") {
        "thread_not_terminal"
    } else if message.contains("interrupted without a recoverable error") {
        "interrupted_error_unrecognized"
    } else if message.contains("needs a user action") {
        "permanent_thread_error"
    } else if message.contains("cancelled") || message.contains("user changed or stopped") {
        "thread_changed_or_cancelled"
    } else if message.contains("different thread")
        || message.contains("different codex thread")
        || message.contains("different interrupted request")
        || message.contains("latest codex turn changed")
        || message.contains("did not identify the interrupted turn")
    {
        "thread_identity_changed"
    } else if message.contains("changed model") {
        "thread_model_changed"
    } else if message.contains("timed out waiting for cdp command") {
        "desktop_command_timeout"
    } else if message.contains("connect cdp websocket")
        || message.contains("connecting cdp websocket")
        || message.contains("thread/read timed out")
        || message.contains("failed to send cdp command")
        || message.contains("cdp websocket closed before")
        || message.contains("failed to read cdp message")
    {
        "desktop_connection_unavailable"
    } else if message.contains("failed to parse cdp message")
        || (message.contains("cdp command ") && message.contains(" failed:"))
    {
        "desktop_protocol_error"
    } else if message.contains("cdp evaluation failed")
        || message.contains("cdp continuation commit failed")
    {
        "desktop_evaluation_failed"
    } else if message.contains("continuation is still pending") {
        "desktop_preparation_unresponsive"
    } else if message.contains("codex desktop page target")
        || message.contains("list cdp targets")
        || message.contains("no codex desktop cdp target")
    {
        "desktop_target_unavailable"
    } else {
        "desktop_readiness_unknown"
    }
}

async fn run_turn_recovery_with_deadline_reporter<Submit, SubmitFuture, Binding, Report>(
    context: TurnRecoveryContext,
    reason: &'static str,
    next_attempt: u32,
    mut submit: Submit,
    binding_is_current: Binding,
    mut report_deadline: Report,
) where
    Submit: FnMut(TurnRecoveryContext, u32) -> SubmitFuture,
    SubmitFuture:
        std::future::Future<Output = Result<crate::codex_desktop::CodexContinuationResult, String>>,
    Binding: Fn(&TurnRecoveryContext, u32) -> bool,
    Report: FnMut(&TurnRecoveryContext, u32, bool, &'static str),
{
    let mut last_blocker = "desktop_preparation_unresponsive";
    let deadline = tokio::time::Instant::now() + DESKTOP_READY_TIMEOUT;
    while tokio::time::Instant::now() < deadline {
        if !recovery_is_active(&context) {
            // Readiness preparation is still read-only. A manual turn that
            // supersedes this reservation must remain untouched, but the
            // previously scheduled activity needs a terminal explanation.
            log_recovery_event(
                &context,
                "cancelled",
                "turn_activity_changed",
                Some(next_attempt),
            );
            return;
        }
        if !binding_is_current(&context, next_attempt) {
            cancel_reserved_recovery(&context);
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
                // started its mutation. Consume only a potentially committed
                // attempt; read-only preparation has not spent the budget.
                let commit_started = recovery_commit_started(&context);
                finish_reserved_recovery(&context, commit_started);
                report_deadline(
                    &context,
                    next_attempt,
                    commit_started,
                    if commit_started {
                        "desktop_commit_acknowledgement_pending"
                    } else {
                        last_blocker
                    },
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
                        desktop_readiness_blocker(&result.message)
                    );
                    return;
                }
                Ok(result) => {
                    // A positive no-mutation result makes another preparation
                    // safe. Do not leave a phantom commit for an arriving
                    // manual continuation to charge against this budget.
                    release_refused_recovery_commit(&context);
                    last_blocker = desktop_readiness_blocker(&result.message);
                }
                Err(_) if recovery_commit_started(&context) => {
                    // A transport or polling error after final authorization
                    // cannot prove that the renderer mutation did not run.
                    finish_reserved_recovery(&context, true);
                    log_recovery_event(
                        &context,
                        "outcome_unknown",
                        "desktop_commit_acknowledgement_disconnected",
                        Some(next_attempt),
                    );
                    return;
                }
                Err(error) => last_blocker = desktop_readiness_blocker(&error),
            },
        }
        tokio::time::sleep_until(std::cmp::min(
            deadline,
            tokio::time::Instant::now() + DESKTOP_READY_DELAY,
        ))
        .await;
    }

    finish_reserved_recovery(&context, false);
    report_deadline(&context, next_attempt, false, last_blocker);
    log::error!(
        "[Codex/Recovery] failed to submit continue for session {}: {}",
        context.session_id,
        last_blocker
    );
}

fn log_recovery_event(
    context: &TurnRecoveryContext,
    status: &str,
    reason: &str,
    attempt: Option<u32>,
) {
    log_recovery_event_with_blocker(context, status, reason, attempt, None);
}

fn log_recovery_event_with_blocker(
    context: &TurnRecoveryContext,
    status: &str,
    reason: &str,
    attempt: Option<u32>,
    readiness_blocker: Option<&'static str>,
) {
    use super::providers::streaming_retry::sanitize_diagnostic_token;
    crate::usage_events::notify_stream_retry_activity(crate::usage_events::StreamRetryActivity {
        timestamp: chrono::Utc::now().to_rfc3339(),
        stage: "desktop_continuation".into(),
        event: format!("continuation_{}", sanitize_diagnostic_token(status)),
        attempt: attempt.unwrap_or(0),
        max_attempts: Some(context.max_recoveries),
        session_id: sanitize_diagnostic_token(&context.session_id),
        model: sanitize_diagnostic_token(&context.model),
        provider_id: sanitize_diagnostic_token(&context.provider_id),
        reason_class: Some(sanitize_diagnostic_token(readiness_blocker.unwrap_or(
            if status == "disabled" {
                "continuation_policy_disabled"
            } else {
                reason
            },
        ))),
        retry_after_seconds: if status == "scheduled" {
            attempt.map(|attempt| continuation_backoff(attempt).as_secs())
        } else {
            None
        },
    });
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
    if let Some(blocker) = readiness_blocker {
        fields.push(("readiness_blocker", blocker.to_string()));
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
                        apply_recovery_decision(&context, recovery_decision(
                            disposition, &event_name, &payload, evidence,
                        ));
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

/// Non-SSE Responses bodies use the same terminal classifier and recovery
/// ownership as streams. Unknown JSON cannot prove an interrupted turn.
pub(crate) fn observe_responses_turn_json(value: &Value, context: &TurnRecoveryContext) {
    let event_type = value.get("type").and_then(Value::as_str);
    let status = value
        .pointer("/response/status")
        .or_else(|| value.get("status"))
        .and_then(Value::as_str);
    let event_name = match event_type {
        Some(
            event @ ("response.completed"
            | "response.failed"
            | "response.incomplete"
            | "response.cancelled"
            | "response.canceled"
            | "response.aborted"
            | "response.error"
            | "error"),
        ) => event,
        _ => match status {
            Some("completed") => "response.completed",
            Some("failed") => "response.failed",
            Some("incomplete") => "response.incomplete",
            Some("cancelled") => "response.cancelled",
            Some("canceled") => "response.canceled",
            Some("aborted") => "response.aborted",
            _ if value.get("error").is_some_and(|error| !error.is_null()) => "error",
            _ => {
                mark_observed_turn_completed(context);
                return;
            }
        },
    };
    let payload =
        if value.get("response").is_some() || matches!(event_name, "error" | "response.error") {
            value.clone()
        } else {
            serde_json::json!({"response": value})
        };
    let mut evidence = NativeResponsesEvidence::default();
    evidence.observe_event(event_name, &payload);
    if let Some(disposition) = classify_native_responses_terminal(event_name, &payload, evidence) {
        apply_recovery_decision(
            context,
            recovery_decision(disposition, event_name, &payload, evidence),
        );
    } else {
        mark_observed_turn_completed(context);
    }
}

fn apply_recovery_decision(context: &TurnRecoveryContext, decision: RecoveryDecision) {
    match decision {
        RecoveryDecision::Complete | RecoveryDecision::Ignore => {
            mark_observed_turn_completed(context)
        }
        RecoveryDecision::ToolStepComplete => mark_observed_tool_step_completed(context),
        RecoveryDecision::Recover(reason) => schedule_turn_recovery(context.clone(), reason),
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
    terminal_error_code(event_name, payload).is_none()
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

    fn owner_test_operation(label: &str) -> (OwnerContinuationEpoch, OwnerContinuationOperation) {
        let thread_id = format!("owner-{label}-{}", uuid::Uuid::new_v4());
        let epoch = capture_owner_continuation_epoch(&thread_id).unwrap();
        let operation_id = format!("owner-operation-{thread_id}");
        let reservation = reserve_owner_continuation(&epoch, "base-turn", &operation_id).unwrap();
        let OwnerContinuationReservation::Reserved(operation) = reservation else {
            panic!("first owner operation must reserve");
        };
        (epoch, operation)
    }

    fn cleanup_owner_test(epoch: &OwnerContinuationEpoch) {
        recovery_states().lock().unwrap().remove(&epoch.thread_id);
    }

    #[test]
    fn invalid_owner_view_epoch_reads_are_bounded_without_retiring_mutation_evidence() {
        let now = Instant::now();
        let mut states = HashMap::new();
        for index in 0..MAX_IDLE_OWNER_EPOCHS {
            states.insert(format!("invalid-thread-{index}"), RecoveryState::default());
        }
        assert!(!owner_epoch_capacity_allows(
            &mut states,
            "one-more-invalid",
            now
        ));
        assert!(owner_epoch_capacity_allows(
            &mut states,
            "invalid-thread-0",
            now
        ));
        states.get_mut("invalid-thread-0").unwrap().updated_at =
            now - IDLE_OWNER_EPOCH_TTL - Duration::from_secs(1);
        assert!(owner_epoch_capacity_allows(
            &mut states,
            "one-more-invalid",
            now
        ));
        let (epoch, operation) = owner_test_operation("bounded-evidence");
        assert!(authorize_owner_continuation_commit(&operation));
        finish_owner_continuation(&operation, OwnerContinuationOutcome::Uncertain);
        let mut retained = recovery_states()
            .lock()
            .unwrap()
            .remove(&epoch.thread_id)
            .unwrap();
        retained.updated_at = now - RECOVERY_STATE_TTL - Duration::from_secs(1);
        states.insert(epoch.thread_id.clone(), retained);
        assert!(owner_epoch_capacity_allows(
            &mut states,
            "one-more-invalid",
            now
        ));
        assert_eq!(
            states[&epoch.thread_id].continuations[&operation.operation_id].status,
            OwnerContinuationStatus::Uncertain
        );
    }

    #[test]
    fn owner_epoch_is_process_local_and_invalidated_by_every_unproven_user_action() {
        let (epoch, operation) = owner_test_operation("epoch");
        assert!(owner_continuation_epoch_is_current(&epoch));
        assert!(owner_continuation_is_reserved(&operation));
        begin_turn(&epoch.thread_id, true);
        assert!(!owner_continuation_epoch_is_current(&epoch));
        assert!(!authorize_owner_continuation_commit(&operation));
        let fresh = capture_owner_continuation_epoch(&epoch.thread_id).unwrap();
        assert!(owner_continuation_epoch_is_current(&fresh));
        let mut other_process = fresh.clone();
        other_process.process_epoch = "another-process".into();
        assert!(!owner_continuation_epoch_is_current(&other_process));
        assert_eq!(
            reserve_owner_continuation(&other_process, "base-turn", "other-operation").unwrap_err(),
            OwnerContinuationError::InvalidBinding
        );
        cleanup_owner_test(&epoch);
    }

    #[test]
    fn owner_supersedes_only_uncommitted_auto_and_old_generation_cannot_reclaim() {
        let thread_id = format!("owner-supersede-{}", uuid::Uuid::new_v4());
        let automatic = context(&thread_id, 2);
        assert_eq!(reserve_recovery(&automatic), Some(1));
        let epoch = capture_owner_continuation_epoch(&thread_id).unwrap();
        let OwnerContinuationReservation::Reserved(owner) = reserve_owner_continuation(
            &epoch,
            "base-turn",
            &format!("owner-operation-{thread_id}"),
        )
        .unwrap() else {
            panic!("owner must replace queued automatic reservation");
        };
        assert!(!recovery_is_active(&automatic));
        assert!(!authorize_reserved_recovery(&automatic));
        assert_eq!(finish_reserved_recovery(&automatic, true), 0);
        assert!(owner_continuation_is_reserved(&owner));
        finish_owner_continuation(&owner, OwnerContinuationOutcome::Refused);
        assert_eq!(
            reserve_recovery(&automatic),
            None,
            "cancelled auto generation cannot reclaim after owner refusal"
        );
        cleanup_owner_test(&epoch);

        let thread_id = format!("owner-no-committing-supersede-{}", uuid::Uuid::new_v4());
        let automatic = context(&thread_id, 2);
        assert_eq!(reserve_recovery(&automatic), Some(1));
        assert!(authorize_reserved_recovery(&automatic));
        let epoch = capture_owner_continuation_epoch(&thread_id).unwrap();
        assert_eq!(
            reserve_owner_continuation(
                &epoch,
                "base-turn",
                &format!("owner-operation-{thread_id}")
            )
            .unwrap_err(),
            OwnerContinuationError::Busy
        );
        assert_eq!(finish_reserved_recovery(&automatic, true), 1);
        cleanup_owner_test(&epoch);
    }

    #[test]
    fn owner_supersession_retains_spent_auto_cap_through_refusal_ttl_exit_and_restore() {
        let mut automatic = context(&format!("owner-spent-cap-{}", uuid::Uuid::new_v4()), 3);
        assert_eq!(reserve_recovery(&automatic), Some(1));
        assert!(authorize_reserved_recovery(&automatic));
        assert_eq!(finish_reserved_recovery(&automatic, true), 1);
        let tracking = observe_next_continuation(&mut automatic);
        assert_eq!(reserve_recovery(&automatic), Some(2));
        let epoch = capture_owner_continuation_epoch(&automatic.desktop_thread_id).unwrap();
        let operation_id = format!("owner-spent-cap-operation-{}", uuid::Uuid::new_v4());
        let OwnerContinuationReservation::Reserved(operation) =
            reserve_owner_continuation(&epoch, "base-turn", &operation_id).unwrap()
        else {
            panic!("owner must supersede only the queued second attempt");
        };
        assert!(!authorize_reserved_recovery(&automatic));
        {
            let states = recovery_states().lock().unwrap();
            let state = &states[&automatic.desktop_thread_id];
            assert_eq!(state.submitted, 1);
            assert_eq!(state.phase, RecoveryPhase::AwaitingContinuation);
            assert_eq!(
                state.tracked.as_ref().unwrap().recovery_id,
                automatic.recovery_id
            );
            let ledger = ledger_from_states(&states);
            let turn = ledger
                .turns
                .iter()
                .find(|turn| turn.context.desktop_thread_id == automatic.desktop_thread_id)
                .unwrap();
            assert_eq!(
                turn.submitted, 1,
                "owner preparation must not erase a spent automatic cap from persistence"
            );
            assert_eq!(turn.phase, RecoveryPhase::AwaitingContinuation);
        }
        let receipt = finish_owner_continuation(&operation, OwnerContinuationOutcome::Refused);
        assert!(!receipt.mutation_attempted);
        let mut state = recovery_states()
            .lock()
            .unwrap()
            .remove(&automatic.desktop_thread_id)
            .unwrap();
        state.updated_at = Instant::now() - RECOVERY_STATE_TTL - Duration::from_secs(1);
        let mut ledger = ledger_from_states(&HashMap::from([(
            automatic.desktop_thread_id.clone(),
            state,
        )]));
        assert_eq!(ledger.turns.len(), 1, "the retained owner evidence must also retain its conservative old-chain cap beyond auto TTL");
        assert_eq!(ledger.turns[0].submitted, 1);
        ledger.saved_at -= RECOVERY_STATE_TTL.as_secs() as i64 + 1;
        import_owner_continuations(&ledger);
        {
            let mut states = recovery_states().lock().unwrap();
            let state = states.get_mut(&automatic.desktop_thread_id).unwrap();
            assert_eq!(state.submitted, 1);
            assert_eq!(state.phase, RecoveryPhase::AwaitingContinuation);
            assert!(retire_automatic_scheduling_for_exit(state));
            assert_eq!(
                state.submitted, 1,
                "graceful exit retires scheduling, not an unaccepted owner reset"
            );
            assert!(state.tracked.is_some());
        }
        assert_eq!(
            reserve_recovery(&automatic),
            None,
            "the superseded old generation remains revoked after restore"
        );
        begin_turn(&automatic.desktop_thread_id, true);
        automatic.recovery_id.push_str("-actual-manual-request");
        automatic.observed_at_ms += 1;
        let newer_tracking = track_turn(&automatic);
        assert_eq!(
            reserve_recovery(&automatic),
            Some(2),
            "an unproven manual continue must not get a third fresh automatic budget"
        );
        drop(newer_tracking);
        drop(tracking);
        cleanup_owner_test(&epoch);
    }

    #[test]
    #[serial_test::serial]
    fn retained_owner_budget_does_not_disable_a_distinct_eligible_auto_crash_recovery() {
        let _home = crate::config::TestHomeGuard::new();
        let database = crate::database::Database::memory().unwrap();
        let provider = crate::provider::Provider::with_id(
            "owner-history-auto-provider".into(),
            "test".into(),
            serde_json::json!({"baseUrl":"https://example.test"}),
            None,
        );
        database.save_provider("codex", &provider).unwrap();
        let (epoch, operation) = owner_test_operation("eligible-auto-restore");
        finish_owner_continuation(&operation, OwnerContinuationOutcome::Refused);
        let mut automatic = context(&epoch.thread_id, 3);
        automatic.durable_provider_id = provider.id.clone();
        automatic.provider_fingerprint = provider_fingerprint(&provider);
        assert_eq!(reserve_recovery(&automatic), Some(1));
        assert!(authorize_reserved_recovery(&automatic));
        assert_eq!(finish_reserved_recovery(&automatic, true), 1);
        let tracking = observe_next_continuation(&mut automatic);
        let state = recovery_states()
            .lock()
            .unwrap()
            .remove(&epoch.thread_id)
            .unwrap();
        let ledger = ledger_from_states(&HashMap::from([(epoch.thread_id.clone(), state)]));
        assert_eq!(ledger.turns[0].phase, RecoveryPhase::ActiveRequest);
        import_owner_continuations(&ledger);
        assert_eq!(
            recovery_states().lock().unwrap()[&epoch.thread_id].phase,
            RecoveryPhase::AwaitingContinuation
        );
        restore_ledger(Some(ledger), 3, &database);
        assert!(recovery_reserved_for_test(&epoch.thread_id), "passive spent-cap import must not disable a different legitimate automatic crash-recovery generation");
        let states = recovery_states().lock().unwrap();
        assert_eq!(states[&epoch.thread_id].submitted, 1);
        assert_eq!(
            states[&epoch.thread_id]
                .tracked
                .as_ref()
                .unwrap()
                .recovery_id,
            automatic.recovery_id
        );
        drop(states);
        drop(tracking);
        cleanup_owner_test(&epoch);
    }

    #[test]
    fn real_ledger_persistence_atomically_replaces_and_synchronizes_isolated_file() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("ledger.json");
        persist_ledger_to_path(&path, b"first-evidence").unwrap();
        persist_ledger_to_path(&path, b"replacement-evidence").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"replacement-evidence");
        let states = HashMap::new();
        persist_states_to_path(&states, &path).unwrap();
        let ledger: RecoveryLedger =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(ledger.version, RECOVERY_LEDGER_VERSION);
        assert!(ledger.turns.is_empty());
        assert!(ledger.continuations.is_empty());
    }

    #[test]
    fn real_ledger_persistence_rejects_size_write_and_rename_failures_without_erasing_target() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("ledger.json");
        std::fs::write(&path, b"existing-evidence").unwrap();
        let too_large = vec![b'x'; MAX_RECOVERY_LEDGER_BYTES + 1];
        assert_eq!(
            persist_ledger_to_path(&path, &too_large),
            Err(RecoveryPersistenceError::TooLarge)
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"existing-evidence");
        let blocked_parent = temporary.path().join("not-a-directory");
        std::fs::write(&blocked_parent, b"untouched-parent").unwrap();
        assert_eq!(
            persist_ledger_to_path(&blocked_parent.join("ledger.json"), b"evidence"),
            Err(RecoveryPersistenceError::AtomicWrite)
        );
        assert_eq!(std::fs::read(&blocked_parent).unwrap(), b"untouched-parent");
        let directory_target = temporary.path().join("existing-directory");
        std::fs::create_dir(&directory_target).unwrap();
        std::fs::write(directory_target.join("sentinel"), b"untouched-directory").unwrap();
        assert_eq!(
            persist_ledger_to_path(&directory_target, b"evidence"),
            Err(RecoveryPersistenceError::AtomicWrite)
        );
        assert_eq!(
            std::fs::read(directory_target.join("sentinel")).unwrap(),
            b"untouched-directory"
        );
    }

    #[test]
    fn real_post_replace_sync_failure_propagates_before_owner_precommit_can_send() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("isolated-ledger.json");
        let (epoch, operation) = owner_test_operation("real-sync-failure");
        let failure = std::cell::Cell::new(None);
        let authorized = authorize_owner_continuation_commit_with(&operation, |states| {
            let bytes = serde_json::to_vec(&ledger_from_states(states)).unwrap();
            let result = persist_ledger_to_path_with_sync(&path, &bytes, |written_path| {
                assert!(
                    written_path.is_file(),
                    "the real atomic replacement already completed"
                );
                // Simulate a filesystem race solely inside this temporary
                // directory, then exercise the real durability-stage IO error.
                // This is not a fake boolean persistence result.
                std::fs::remove_file(written_path).unwrap();
                synchronize_recovery_ledger(written_path)
            });
            failure.set(result.err());
            result.is_ok()
        });
        let mut sends = 0;
        if authorized {
            sends += 1;
        }
        assert_eq!(failure.get(), Some(RecoveryPersistenceError::FileSync));
        assert_eq!(
            sends, 0,
            "a real durable-write boundary failure must withhold mutation authorization"
        );
        assert!(
            !authorize_owner_continuation_commit(&operation),
            "failed intent cannot be authorized again"
        );
        let receipt = read_owner_continuation_receipt(&operation.operation_id).unwrap();
        assert_eq!(receipt.status, OwnerContinuationStatus::Committing);
        assert!(receipt.mutation_attempted);
        cleanup_owner_test(&epoch);
    }

    #[test]
    fn owner_precommit_is_one_use_and_failed_durable_write_cannot_authorize_send() {
        let (epoch, operation) = owner_test_operation("persist-refusal");
        assert!(!authorize_owner_continuation_commit_with(
            &operation,
            |_| false
        ));
        assert!(!owner_continuation_is_reserved(&operation));
        assert!(!authorize_owner_continuation_commit(&operation));
        let OwnerContinuationReservation::AttachOnly(receipt) =
            reserve_owner_continuation(&epoch, "base-turn", "another-click").unwrap()
        else {
            panic!("uncertain durable intent is attach-only");
        };
        assert_eq!(receipt.status, OwnerContinuationStatus::Committing);
        assert!(receipt.mutation_attempted);
        cleanup_owner_test(&epoch);
    }

    #[test]
    fn owner_unknown_outcome_survives_actions_ttl_and_auto_disabled_without_replay() {
        let (epoch, operation) = owner_test_operation("uncertain-retention");
        assert!(authorize_owner_continuation_commit(&operation));
        let receipt = finish_owner_continuation(&operation, OwnerContinuationOutcome::Uncertain);
        assert_eq!(receipt.status, OwnerContinuationStatus::Uncertain);
        assert!(!receipt.submitted);
        assert!(receipt.mutation_attempted);
        begin_turn(&epoch.thread_id, false);
        mark_turn_completed(&epoch.thread_id);
        {
            let mut states = recovery_states().lock().unwrap();
            let state = states.get_mut(&epoch.thread_id).unwrap();
            state.updated_at = Instant::now() - RECOVERY_STATE_TTL - Duration::from_secs(1);
        }
        let unrelated = context(&format!("unrelated-{}", uuid::Uuid::new_v4()), 0);
        assert_eq!(reserve_recovery(&unrelated), None);
        let unrelated_enabled = context(&format!("retention-sweep-{}", uuid::Uuid::new_v4()), 1);
        assert_eq!(reserve_recovery(&unrelated_enabled), Some(1));
        mark_turn_completed(&unrelated_enabled.desktop_thread_id);
        let fresh = capture_owner_continuation_epoch(&epoch.thread_id).unwrap();
        let OwnerContinuationReservation::AttachOnly(receipt) =
            reserve_owner_continuation(&fresh, "base-turn", "new-click").unwrap()
        else {
            panic!("old exact-base uncertainty must not replay");
        };
        assert_eq!(receipt.operation_id, operation.operation_id);
        assert_eq!(receipt.status, OwnerContinuationStatus::Uncertain);
        let encoded =
            serde_json::to_value(ledger_from_states(&recovery_states().lock().unwrap())).unwrap();
        assert!(encoded["continuations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["threadId"] == epoch.thread_id));
        cleanup_owner_test(&epoch);
    }

    #[test]
    fn owner_operation_replay_is_attach_only_and_payload_reuse_conflicts() {
        let (epoch, operation) = owner_test_operation("idempotency");
        assert!(matches!(
            reserve_owner_continuation(&epoch, "base-turn", &operation.operation_id).unwrap(),
            OwnerContinuationReservation::AttachOnly(_)
        ));
        assert_eq!(
            reserve_owner_continuation(&epoch, "different-base", &operation.operation_id)
                .unwrap_err(),
            OwnerContinuationError::OperationConflict
        );
        let other_thread = format!("another-owner-thread-{}", uuid::Uuid::new_v4());
        let other_epoch = capture_owner_continuation_epoch(&other_thread).unwrap();
        assert_eq!(
            reserve_owner_continuation(&other_epoch, "base-turn", &operation.operation_id)
                .unwrap_err(),
            OwnerContinuationError::OperationConflict
        );
        cleanup_owner_test(&other_epoch);
        assert!(authorize_owner_continuation_commit(&operation));
        assert!(!authorize_owner_continuation_commit(&operation));
        let receipt = finish_owner_continuation(
            &operation,
            OwnerContinuationOutcome::Submitted {
                turn_id: "accepted-turn".into(),
            },
        );
        assert!(receipt.submitted);
        assert_eq!(receipt.status, OwnerContinuationStatus::Submitted);
        let serialized = serde_json::to_value(receipt).unwrap();
        assert_eq!(serialized.as_object().unwrap().len(), 5);
        assert_eq!(serialized["acknowledgedTurnId"], "accepted-turn");
        assert!(serialized.get("actionEpoch").is_none());
        assert!(serialized.get("baseTurnId").is_none());
        assert!(serialized.get("provider").is_none());
        cleanup_owner_test(&epoch);
    }

    #[test]
    fn owner_accepted_turn_reconciliation_never_uses_proxy_continue_as_provenance() {
        let (epoch, operation) = owner_test_operation("ack-reconciliation");
        recovery_states()
            .lock()
            .unwrap()
            .get_mut(&epoch.thread_id)
            .unwrap()
            .submitted = 2;
        assert!(authorize_owner_continuation_commit(&operation));
        // Any manual or injected request is unproven at the proxy boundary.
        begin_turn(&epoch.thread_id, true);
        assert_eq!(
            recovery_states().lock().unwrap()[&epoch.thread_id].submitted,
            2
        );
        let receipt = finish_owner_continuation(
            &operation,
            OwnerContinuationOutcome::Submitted {
                turn_id: "accepted-turn".into(),
            },
        );
        assert!(receipt.submitted);
        assert_eq!(
            recovery_states().lock().unwrap()[&epoch.thread_id].submitted,
            2
        );
        assert!(
            !reconcile_owner_accepted_turn(&epoch, "accepted-turn"),
            "stale native epoch cannot reset budget"
        );
        let fresh = capture_owner_continuation_epoch(&epoch.thread_id).unwrap();
        assert!(!reconcile_owner_accepted_turn(&fresh, "another-turn"));
        assert!(reconcile_owner_accepted_turn(&fresh, "accepted-turn"));
        assert_eq!(
            recovery_states().lock().unwrap()[&epoch.thread_id].submitted,
            0
        );
        assert!(
            !reconcile_owner_accepted_turn(&fresh, "accepted-turn"),
            "canonical acceptance reconciles once"
        );
        cleanup_owner_test(&epoch);
    }

    #[test]
    fn delayed_owner_acceptance_reconciliation_never_refunds_a_new_auto_commit() {
        let (epoch, operation) = owner_test_operation("reconcile-auto-race");
        assert!(authorize_owner_continuation_commit(&operation));
        begin_turn(&epoch.thread_id, true);
        finish_owner_continuation(
            &operation,
            OwnerContinuationOutcome::Submitted {
                turn_id: "accepted-owner-turn".into(),
            },
        );
        let automatic = context(&epoch.thread_id, 3);
        let tracking = track_turn(&automatic);
        let read_epoch = capture_owner_continuation_epoch(&epoch.thread_id).unwrap();
        assert_eq!(reserve_recovery(&automatic), Some(1));
        assert!(authorize_reserved_recovery(&automatic));
        assert!(
            owner_continuation_epoch_is_current(&read_epoch),
            "reservation need not fake a user action to guard its charge"
        );
        assert!(!reconcile_owner_accepted_turn(
            &read_epoch,
            "accepted-owner-turn"
        ));
        assert_eq!(
            recovery_states().lock().unwrap()[&epoch.thread_id].submitted,
            1
        );
        assert_eq!(finish_reserved_recovery(&automatic, true), 1);
        assert!(
            !reconcile_owner_accepted_turn(&read_epoch, "accepted-owner-turn"),
            "a late view cannot refund an ambiguous completed auto commit either"
        );
        assert_eq!(
            recovery_states().lock().unwrap()[&epoch.thread_id].submitted,
            1
        );
        drop(tracking);
        cleanup_owner_test(&epoch);
    }

    #[test]
    fn owner_late_finish_cannot_clear_a_newer_active_proxy_request() {
        let (epoch, operation) = owner_test_operation("late-finish");
        assert!(authorize_owner_continuation_commit(&operation));
        begin_turn(&epoch.thread_id, true);
        let newer = context(&epoch.thread_id, 2);
        let tracking = track_turn(&newer);
        finish_owner_continuation(&operation, OwnerContinuationOutcome::Uncertain);
        let states = recovery_states().lock().unwrap();
        let state = &states[&epoch.thread_id];
        assert_eq!(state.phase, RecoveryPhase::ActiveRequest);
        assert_eq!(
            state.tracked.as_ref().unwrap().recovery_id,
            newer.recovery_id
        );
        assert_eq!(
            state.continuations[&operation.operation_id].status,
            OwnerContinuationStatus::Uncertain
        );
        drop(states);
        drop(tracking);
        cleanup_owner_test(&epoch);
    }

    #[test]
    fn owner_reserved_startup_is_refused_and_committing_startup_is_uncertain_never_replayed() {
        for commit in [false, true] {
            let (epoch, operation) = owner_test_operation(if commit {
                "restore-committing"
            } else {
                "restore-reserved"
            });
            if commit {
                assert!(authorize_owner_continuation_commit(&operation));
            }
            let mut states = recovery_states().lock().unwrap();
            let state = states.remove(&epoch.thread_id).unwrap();
            drop(states);
            let ledger = ledger_from_states(&HashMap::from([(epoch.thread_id.clone(), state)]));
            assert!(ledger.turns.is_empty());
            assert_eq!(ledger.continuations.len(), 1);
            import_owner_continuations(&ledger);
            assert!(!owner_continuation_epoch_is_current(&epoch));
            assert!(!authorize_owner_continuation_commit(&operation));
            let states = recovery_states().lock().unwrap();
            let restored = &states[&epoch.thread_id];
            assert_eq!(restored.phase, RecoveryPhase::Idle);
            assert_eq!(
                restored.continuations[&operation.operation_id].status,
                if commit {
                    OwnerContinuationStatus::Uncertain
                } else {
                    OwnerContinuationStatus::Refused
                }
            );
            assert!(restored.tracked.is_none());
            drop(states);
            cleanup_owner_test(&epoch);
        }
    }

    #[test]
    fn literal_legacy_ledger_wire_names_migrate_without_disabling_mutation() {
        // Real older files used snake_case, not a freshly serialized v2 fixture.
        let legacy = br#"{"config_scope":"legacy-scope","saved_at":1,"turns":[]}"#;
        let ledger: RecoveryLedger = serde_json::from_slice(legacy).unwrap();
        assert_eq!(ledger.version, 1);
        assert!(ledger.continuations.is_empty());
        assert!(validate_ledger(&ledger, "legacy-scope"));
        let prior_camel_case = br#"{"configScope":"legacy-scope","savedAt":1,"turns":[]}"#;
        let ledger: RecoveryLedger = serde_json::from_slice(prior_camel_case).unwrap();
        assert!(validate_ledger(&ledger, "legacy-scope"));
        let duplicate_scope = br#"{"configScope":"a","config_scope":"b","savedAt":1,"turns":[]}"#;
        assert!(serde_json::from_slice::<RecoveryLedger>(duplicate_scope).is_err());
    }

    #[test]
    fn owner_ledger_validation_rejects_malformed_unknown_version_or_duplicate_evidence() {
        let (epoch, operation) = owner_test_operation("ledger-validation");
        assert!(authorize_owner_continuation_commit(&operation));
        let mut states = recovery_states().lock().unwrap();
        let state = states.remove(&epoch.thread_id).unwrap();
        drop(states);
        let mut ledger = ledger_from_states(&HashMap::from([(epoch.thread_id.clone(), state)]));
        assert!(validate_ledger(&ledger, &ledger.config_scope));
        assert!(!validate_ledger(&ledger, "another-configuration"));
        ledger.version = RECOVERY_LEDGER_VERSION + 1;
        assert!(!validate_ledger(&ledger, &ledger.config_scope));
        ledger.version = RECOVERY_LEDGER_VERSION;
        let json = serde_json::to_value(&ledger).unwrap();
        let mut malformed = json.clone();
        malformed["continuations"][0]["transaction"]["status"] = serde_json::json!("unknown-state");
        assert!(serde_json::from_value::<RecoveryLedger>(malformed).is_err());
        let mut duplicate = json;
        let entry = duplicate["continuations"][0].clone();
        duplicate["continuations"]
            .as_array_mut()
            .unwrap()
            .push(entry);
        let duplicate: RecoveryLedger = serde_json::from_value(duplicate).unwrap();
        assert!(!validate_ledger(&duplicate, &duplicate.config_scope));
    }

    #[test]
    fn arriving_unproven_continue_preserves_precharged_cap_across_crash_tracking_gap() {
        let automatic = context(&format!("auto-incoming-gap-{}", uuid::Uuid::new_v4()), 2);
        assert_eq!(reserve_recovery(&automatic), Some(1));
        assert!(authorize_reserved_recovery(&automatic));
        begin_turn(&automatic.desktop_thread_id, true);
        assert!(!recovery_is_active(&automatic));
        assert!(!authorize_reserved_recovery(&automatic));
        let mut states = recovery_states().lock().unwrap();
        let state = states.remove(&automatic.desktop_thread_id).unwrap();
        let ledger = ledger_from_states(&HashMap::from([(
            automatic.desktop_thread_id.clone(),
            state,
        )]));
        assert_eq!(ledger.turns.len(), 1);
        assert_eq!(ledger.turns[0].submitted, 1);
        assert_eq!(ledger.turns[0].phase, RecoveryPhase::AwaitingContinuation);
        let restored = RecoveryState {
            submitted: ledger.turns[0].submitted,
            phase: RecoveryPhase::AwaitingContinuation,
            tracked: Some(automatic.clone()),
            tracked_epoch: Some("previous-action-epoch".into()),
            ..RecoveryState::default()
        };
        states.insert(automatic.desktop_thread_id.clone(), restored);
        drop(states);
        let mut newer = automatic.clone();
        newer.recovery_id.push_str("-actual-new-request");
        newer.observed_at_ms -= 1;
        let tracking = track_turn(&newer);
        assert_eq!(
            recovery_states().lock().unwrap()[&newer.desktop_thread_id].phase,
            RecoveryPhase::ActiveRequest
        );
        assert_eq!(
            recovery_states().lock().unwrap()[&newer.desktop_thread_id].submitted,
            1
        );
        assert_eq!(reserve_recovery(&newer), Some(2));
        drop(tracking);
        mark_turn_completed(&newer.desktop_thread_id);
    }

    #[test]
    fn auto_precommit_charges_once_without_incoming_text_and_storage_failure_refuses() {
        let automatic = context(&format!("auto-precommit-{}", uuid::Uuid::new_v4()), 2);
        assert_eq!(reserve_recovery(&automatic), Some(1));
        assert!(authorize_reserved_recovery(&automatic));
        assert_eq!(
            recovery_states().lock().unwrap()[&automatic.desktop_thread_id].submitted,
            1
        );
        assert!(!authorize_reserved_recovery(&automatic));
        release_refused_recovery_commit(&automatic);
        assert_eq!(
            recovery_states().lock().unwrap()[&automatic.desktop_thread_id].submitted,
            0
        );
        assert!(!authorize_reserved_recovery_with(&automatic, |_| false));
        assert!(recovery_commit_started(&automatic), "failed durable intent remains non-replayable rather than granting another authorization");
        mark_turn_completed(&automatic.desktop_thread_id);
    }

    fn observe_next_continuation(context: &mut TurnRecoveryContext) -> TrackedTurn {
        begin_turn(&context.desktop_thread_id, true);
        context.recovery_id.push_str("-next");
        context.observed_at_ms += 1;
        track_turn(context)
    }

    #[test]
    fn disabled_continuation_is_reported_in_the_activity_feed() {
        crate::usage_events::take_test_stream_activities();
        let context = context("policy-disabled-activity", 0);
        schedule_turn_recovery(context, "response_failed");
        let events = crate::usage_events::take_test_stream_activities();
        assert_eq!(
            events.len(),
            1,
            "Safe/Off must explain why no continue was attempted"
        );
        assert_eq!(events[0].stage, "desktop_continuation");
        assert_eq!(events[0].event, "continuation_disabled");
        assert_eq!(
            events[0].reason_class.as_deref(),
            Some("continuation_policy_disabled")
        );
    }

    #[test]
    fn continuation_deadline_blocker_reaches_activity_not_only_a_log() {
        crate::usage_events::take_test_stream_activities();
        let context = context("blocked-activity", 3);
        log_recovery_event_with_blocker(
            &context,
            "submit_failed",
            "desktop_ready_deadline",
            Some(1),
            Some("desktop_cdp_discovery_failed"),
        );
        let events = crate::usage_events::take_test_stream_activities();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event, "continuation_submit_failed");
        assert_eq!(
            events[0].reason_class.as_deref(),
            Some("desktop_cdp_discovery_failed")
        );
    }

    #[tokio::test(start_paused = true)]
    async fn failed_chat_continuation_waits_five_minutes_before_preparing() {
        let context = context("five-minute-continuation", 3);
        assert_eq!(reserve_recovery(&context), Some(1));
        let started = tokio::time::Instant::now();
        run_turn_recovery(
            context.clone(),
            "response_failed",
            1,
            |context, _| {
                assert_eq!(started.elapsed(), Duration::from_secs(300));
                assert!(authorize_reserved_recovery(&context));
                std::future::ready(Ok(crate::codex_desktop::CodexContinuationResult {
                    submitted: true,
                    mutation_attempted: true,
                    debug_port: Some(9229),
                    target_id: None,
                    message: String::new(),
                }))
            },
            |_, _| true,
        )
        .await;
        mark_turn_completed(&context.desktop_thread_id);
    }

    #[test]
    fn logical_continuation_has_an_independent_bounded_exponential_wait() {
        assert_eq!(continuation_backoff(1), Duration::from_secs(300));
        assert_eq!(continuation_backoff(2), Duration::from_secs(600));
        assert_eq!(continuation_backoff(3), Duration::from_secs(1200));
        assert_eq!(continuation_backoff(u32::MAX), Duration::from_secs(1200));
        crate::usage_events::take_test_stream_activities();
        let context = context("scheduled-activity", 3);
        log_recovery_event(&context, "scheduled", "response_failed", Some(2));
        let events = crate::usage_events::take_test_stream_activities();
        assert_eq!(events[0].retry_after_seconds, Some(600));
        assert_eq!(events[0].event, "continuation_scheduled");
    }

    #[tokio::test(start_paused = true)]
    async fn third_backoff_heartbeats_the_canonical_lease_before_unrelated_pruning() {
        let mut pending = context("third-backoff-lease", 3);
        for attempt in 1..=2 {
            assert_eq!(reserve_recovery(&pending), Some(attempt));
            assert!(authorize_reserved_recovery(&pending));
            assert_eq!(finish_reserved_recovery(&pending, true), attempt);
            observe_next_continuation(&mut pending).hand_off_to_stream();
        }
        assert_eq!(reserve_recovery(&pending), Some(3));
        assert!(continuation_backoff(3) > RECOVERY_STATE_TTL);
        {
            let mut states = recovery_states().lock().unwrap();
            // Tokio's paused clock does not advance std::time::Instant. Age
            // only this test's lease, without exposing expired global state
            // that a parallel test's unrelated reservation could prune.
            states
                .get_mut(&pending.desktop_thread_id)
                .unwrap()
                .updated_at = Instant::now() - (RECOVERY_STATE_TTL - Duration::from_secs(60));
        }
        let beat_started = Instant::now();
        let binding_is_current = |_: &TurnRecoveryContext, _: u32| true;
        let mut wait = Box::pin(wait_for_continuation_backoff(
            &pending,
            3,
            &binding_is_current,
        ));
        assert!(futures::poll!(wait.as_mut()).is_pending());
        {
            let states = recovery_states().lock().unwrap();
            let state = states.get(&pending.desktop_thread_id).unwrap();
            assert_eq!(state.phase, RecoveryPhase::ReservedRecovery);
            assert_eq!(state.submitted, 2);
            assert!(state.updated_at >= beat_started);
        }
        let unrelated = context("third-backoff-unrelated-reservation", 1);
        assert_eq!(reserve_recovery(&unrelated), Some(1));
        assert!(recovery_is_active(&pending));
        drop(wait);
        mark_turn_completed(&pending.desktop_thread_id);
        mark_turn_completed(&unrelated.desktop_thread_id);
    }

    #[tokio::test(start_paused = true)]
    async fn policy_change_during_backoff_cancels_without_preparing_a_message() {
        let context = context("backoff-policy-change", 3);
        assert_eq!(reserve_recovery(&context), Some(1));
        let started = tokio::time::Instant::now();
        let calls = std::sync::atomic::AtomicU32::new(0);
        run_turn_recovery(
            context.clone(),
            "response_failed",
            1,
            |_, _| {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                std::future::ready(Err("must not run".into()))
            },
            |_, _| started.elapsed() < Duration::from_secs(10),
        )
        .await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert!(!recovery_is_active(&context));
        assert_eq!(started.elapsed(), Duration::from_secs(10));
        mark_turn_completed(&context.desktop_thread_id);
    }

    #[tokio::test(start_paused = true)]
    async fn manual_turn_during_backoff_cancels_the_old_reservation() {
        crate::usage_events::take_test_stream_activities();
        let context = context("backoff-manual-turn", 3);
        assert_eq!(reserve_recovery(&context), Some(1));
        let calls = std::sync::atomic::AtomicU32::new(0);
        let wait = run_turn_recovery(
            context.clone(),
            "response_failed",
            1,
            |_, _| {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                std::future::ready(Err("must not run".into()))
            },
            |_, _| true,
        );
        let cancel = async {
            tokio::time::sleep(Duration::from_secs(10)).await;
            begin_turn(&context.desktop_thread_id, false);
        };
        tokio::join!(wait, cancel);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert!(!recovery_is_active(&context));
        let events = crate::usage_events::take_test_stream_activities();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event, "continuation_cancelled");
        assert_eq!(
            events[0].reason_class.as_deref(),
            Some("turn_activity_changed")
        );
    }

    #[test]
    fn reserves_exactly_the_configured_number_of_submissions() {
        let mut context = context("recovery-budget", 3);
        mark_turn_completed(&context.session_id);

        assert_eq!(reserve_recovery(&context), Some(1));
        assert_eq!(reserve_recovery(&context), None);
        assert!(authorize_reserved_recovery(&context));
        assert_eq!(finish_reserved_recovery(&context, true), 1);
        observe_next_continuation(&mut context).hand_off_to_stream();
        assert_eq!(reserve_recovery(&context), Some(2));
        assert!(authorize_reserved_recovery(&context));
        assert_eq!(finish_reserved_recovery(&context, true), 2);
        observe_next_continuation(&mut context).hand_off_to_stream();
        assert_eq!(reserve_recovery(&context), Some(3));
        assert!(authorize_reserved_recovery(&context));
        assert_eq!(finish_reserved_recovery(&context, true), 3);
        assert_eq!(reserve_recovery(&context), None);
        mark_turn_completed(&context.session_id);
    }

    #[test]
    fn failed_desktop_submission_does_not_consume_budget() {
        let context = context("recovery-failed-submit", 1);
        mark_turn_completed(&context.session_id);

        assert_eq!(reserve_recovery(&context), Some(1));
        assert_eq!(finish_reserved_recovery(&context, false), 0);
        assert_eq!(reserve_recovery(&context), Some(1));
        finish_reserved_recovery(&context, false);
        mark_turn_completed(&context.session_id);
    }

    #[test]
    #[serial_test::serial]
    fn acknowledged_continuation_budget_survives_crash_before_its_next_proxy_request() {
        // ledger_from_states reads the process configuration scope indirectly.
        // Hold the same home isolation as the explicit startup ledger tests.
        let _home = crate::config::TestHomeGuard::new();
        let db = crate::database::Database::memory().unwrap();
        let provider = crate::provider::Provider::with_id(
            "ack-gap-provider".into(),
            "test".into(),
            serde_json::json!({"baseUrl":"https://example.test"}),
            None,
        );
        db.save_provider("codex", &provider).unwrap();
        for budget in [1, 3] {
            let mut context = context(&format!("recovery-ack-crash-gap-{budget}"), budget);
            context.durable_provider_id = provider.id.clone();
            context.provider_fingerprint = provider_fingerprint(&provider);
            assert_eq!(reserve_recovery(&context), Some(1));
            assert!(authorize_reserved_recovery(&context));
            assert_eq!(finish_reserved_recovery(&context, true), 1);
            let ledger = ledger_from_states(&recovery_states().lock().unwrap());
            assert!(
                ledger.turns.iter().any(|turn| {
                    turn.context.desktop_thread_id == context.desktop_thread_id
                        && turn.submitted == 1
                }),
                "an acknowledged continuation must retain its consumed budget in the crash ledger"
            );
            mark_turn_completed(&context.desktop_thread_id);

            restore_ledger(Some(ledger), budget, &db);
            assert_eq!(
                recovery_states()
                    .lock()
                    .unwrap()
                    .get(&context.desktop_thread_id)
                    .map(|state| state.submitted),
                Some(1),
                "startup must restore the consumed budget before the next proxy request"
            );
            assert!(
                !recovery_reserved_for_test(&context.desktop_thread_id),
                "restoring a budget must not submit another continue to the old failed turn"
            );
            begin_turn(&context.desktop_thread_id, true);
            let mut next = context.clone();
            next.recovery_id = "next-proxy-request".into();
            next.observed_at_ms += 1;
            let tracked = track_turn(&next);
            let next_attempt = reserve_recovery(&next);
            assert_eq!(next_attempt, (budget > 1).then_some(2));
            if next_attempt.is_some() {
                finish_reserved_recovery(&next, false);
            }
            drop(tracked);
            mark_turn_completed(&context.desktop_thread_id);
        }
    }

    #[test]
    fn acknowledged_generation_cannot_reserve_or_reclaim_another_attempt() {
        let mut context = context("recovery-ack-duplicate-generation", 3);
        assert_eq!(reserve_recovery(&context), Some(1));
        assert!(authorize_reserved_recovery(&context));
        assert_eq!(finish_reserved_recovery(&context, true), 1);
        assert_eq!(reserve_recovery(&context), None);
        let stale_tracking = track_turn(&context);
        assert_eq!(reserve_recovery(&context), None);
        mark_observed_turn_completed(&context);
        mark_observed_tool_step_completed(&context);
        assert_eq!(reserve_recovery(&context), None);
        let states = recovery_states().lock().unwrap();
        let state = states.get(&context.desktop_thread_id).unwrap();
        assert_eq!(state.submitted, 1);
        assert_eq!(state.phase, RecoveryPhase::AwaitingContinuation);
        drop(states);
        drop(stale_tracking);

        let next = observe_next_continuation(&mut context);
        assert_eq!(reserve_recovery(&context), Some(2));
        drop(next);
        mark_turn_completed(&context.desktop_thread_id);
    }

    #[test]
    #[serial_test::serial]
    fn committing_continuation_restores_once_without_replaying_an_unknown_outcome() {
        // Ledger capture and restore must observe the same configuration scope.
        // Other serialized tests temporarily change the process-wide home.
        let _home = crate::config::TestHomeGuard::new();
        let db = crate::database::Database::memory().unwrap();
        let provider = crate::provider::Provider::with_id(
            "committing-recovery-provider".into(),
            "test".into(),
            serde_json::json!({"baseUrl":"https://example.test"}),
            None,
        );
        db.save_provider("codex", &provider).unwrap();
        let mut context = context("recovery-committing-crash-gap", 3);
        context.durable_provider_id = provider.id.clone();
        context.provider_fingerprint = provider_fingerprint(&provider);
        assert_eq!(reserve_recovery(&context), Some(1));
        assert!(authorize_reserved_recovery(&context));
        assert!(
            !authorize_reserved_recovery(&context),
            "precommit authorization is a one-use CAS"
        );
        let ledger = ledger_from_states(&recovery_states().lock().unwrap());
        mark_turn_completed(&context.desktop_thread_id);

        restore_ledger(Some(ledger), 3, &db);
        assert!(!recovery_reserved_for_test(&context.desktop_thread_id));
        let restored_ledger = {
            let states = recovery_states().lock().unwrap();
            let state = states.get(&context.desktop_thread_id).unwrap();
            assert_eq!(state.submitted, 1);
            assert_eq!(state.phase, RecoveryPhase::AwaitingContinuation);
            ledger_from_states(&states)
        };
        mark_turn_completed(&context.desktop_thread_id);
        restore_ledger(Some(restored_ledger), 3, &db);
        assert_eq!(
            recovery_states()
                .lock()
                .unwrap()
                .get(&context.desktop_thread_id)
                .unwrap()
                .submitted,
            1,
            "a second restart must not charge the same ambiguous commit twice"
        );
        let next = observe_next_continuation(&mut context);
        assert_eq!(reserve_recovery(&context), Some(2));
        drop(next);
        mark_turn_completed(&context.desktop_thread_id);
    }

    #[test]
    #[serial_test::serial]
    fn startup_with_recovery_disabled_preserves_spent_budget_without_queuing_a_turn() {
        let _home = crate::config::TestHomeGuard::new();
        let db = crate::database::Database::memory().unwrap();
        let provider = crate::provider::Provider::with_id(
            "dormant-budget-provider".into(),
            "test".into(),
            serde_json::json!({"baseUrl":"https://example.test"}),
            None,
        );
        db.save_provider("codex", &provider).unwrap();
        for phase in [
            RecoveryPhase::ActiveRequest,
            RecoveryPhase::AwaitingContinuation,
        ] {
            let mut context = context(&format!("recovery-disabled-startup-{phase:?}"), 3);
            context.durable_provider_id = provider.id.clone();
            context.provider_fingerprint = provider_fingerprint(&provider);
            let ledger = RecoveryLedger {
                version: RECOVERY_LEDGER_VERSION,
                continuations: Vec::new(),
                config_scope: crate::process_identity::config_scope_fingerprint(),
                saved_at: chrono::Utc::now().timestamp(),
                turns: vec![PersistedTurn {
                    commit_charged: false,
                    context: context.clone(),
                    submitted: 1,
                    phase,
                }],
            };
            restore_ledger(Some(ledger), 0, &db);
            assert!(!recovery_reserved_for_test(&context.desktop_thread_id));
            let states = recovery_states().lock().unwrap();
            let state = states.get(&context.desktop_thread_id).unwrap();
            assert_eq!(state.submitted, 1);
            assert_eq!(state.phase, RecoveryPhase::AwaitingContinuation);
            assert_eq!(state.tracked.as_ref().unwrap().max_recoveries, 3);
            drop(states);
            let next = observe_next_continuation(&mut context);
            assert_eq!(reserve_recovery(&context), Some(2));
            drop(next);
            mark_turn_completed(&context.desktop_thread_id);
        }
    }

    #[test]
    fn explicit_json_terminals_use_the_same_recovery_and_cancellation_policy_as_streams() {
        for (id, payload, recoverable) in [
            (
                "json-overload",
                serde_json::json!({"status":"failed","error":{"code":"server_error","message":"Our servers are currently overloaded. Please try again later."}}),
                true,
            ),
            (
                "json-overload-wrapper",
                serde_json::json!({"type":"response.failed","response":{"status":"failed","error":{"code":"server_error"}}}),
                true,
            ),
            (
                "json-incomplete",
                serde_json::json!({"status":"incomplete","incomplete_details":{"reason":"upstream_timeout"}}),
                true,
            ),
            (
                "json-top-error",
                serde_json::json!({"error":{"code":"server_error"}}),
                true,
            ),
            (
                "json-auth",
                serde_json::json!({"error":{"code":"invalid_api_key"}}),
                false,
            ),
            (
                "json-quota",
                serde_json::json!({"status":"failed","error":{"code":"insufficient_quota"}}),
                false,
            ),
            (
                "json-cancelled",
                serde_json::json!({"status":"cancelled"}),
                false,
            ),
            (
                "json-unknown",
                serde_json::json!({"message":"not an explicit Responses terminal"}),
                false,
            ),
        ] {
            let context = context(id, 3);
            let tracked = track_turn(&context);
            observe_responses_turn_json(&payload, &context);
            assert_eq!(
                recovery_reserved_for_test(&context.desktop_thread_id),
                recoverable,
                "{id}"
            );
            drop(tracked);
            mark_turn_completed(&context.desktop_thread_id);
        }
    }

    #[test]
    fn completed_json_tool_step_preserves_the_existing_continuation_budget() {
        let mut context = context("recovery-json-tool-step", 3);
        assert_eq!(reserve_recovery(&context), Some(1));
        assert!(authorize_reserved_recovery(&context));
        assert_eq!(finish_reserved_recovery(&context, true), 1);
        let tracked = observe_next_continuation(&mut context);
        observe_responses_turn_json(
            &serde_json::json!({
                "status":"completed",
                "output":[{"type":"function_call","id":"item-1","call_id":"call-1","name":"shell","arguments":"{}"}]
            }),
            &context,
        );
        let states = recovery_states().lock().unwrap();
        let state = states.get(&context.desktop_thread_id).unwrap();
        assert_eq!(state.submitted, 1);
        assert!(state.tracked.is_some());
        drop(states);
        drop(tracked);
        assert_eq!(reserve_recovery(&context), Some(2));
        mark_turn_completed(&context.desktop_thread_id);
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
        assert_eq!(
            recovery_states()
                .lock()
                .unwrap()
                .get(&context.desktop_thread_id)
                .unwrap()
                .phase,
            RecoveryPhase::ActiveRequest
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
            |context, _| {
                assert!(authorize_reserved_recovery(&context));
                futures::future::pending::<
                    Result<crate::codex_desktop::CodexContinuationResult, String>,
                >()
            },
            |_, _| true,
        )
        .await;
        assert_eq!(
            started.elapsed(),
            continuation_backoff(1) + DESKTOP_READY_TIMEOUT
        );
        assert!(!recovery_is_active(&context));
        assert_eq!(reserve_recovery(&context), None);
        mark_turn_completed(&context.desktop_thread_id);
    }

    #[tokio::test(start_paused = true)]
    async fn manual_turn_during_readiness_reports_cancellation_and_preserves_the_newer_turn() {
        crate::usage_events::take_test_stream_activities();
        let context = context("readiness-manual-turn", 3);
        assert_eq!(reserve_recovery(&context), Some(1));
        let mut newer = context.clone();
        newer.recovery_id = "readiness-newer-user-turn".into();
        newer.observed_at_ms += 1;
        let calls = std::sync::atomic::AtomicU32::new(0);
        let prepare = run_turn_recovery_with_deadline_reporter(
            context.clone(),
            "response_failed",
            1,
            |_, _| {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                std::future::ready(Ok(crate::codex_desktop::CodexContinuationResult {
                    submitted: false,
                    mutation_attempted: false,
                    debug_port: None,
                    target_id: None,
                    message: "Codex Desktop request client was not found".into(),
                }))
            },
            |_, _| true,
            |_, _, _, _| panic!("a newer user turn is a cancellation, not a readiness deadline"),
        );
        let manual_turn = async {
            tokio::time::sleep(Duration::from_millis(200)).await;
            begin_turn(&newer.desktop_thread_id, false);
            track_turn(&newer).hand_off_to_stream();
        };
        tokio::join!(prepare, manual_turn);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(!recovery_is_active(&context));
        {
            let states = recovery_states().lock().unwrap();
            let state = states.get(&newer.desktop_thread_id).unwrap();
            assert_eq!(state.phase, RecoveryPhase::ActiveRequest);
            assert_eq!(state.submitted, 0);
            assert_eq!(
                state.tracked.as_ref().unwrap().recovery_id,
                newer.recovery_id
            );
        }
        let events = crate::usage_events::take_test_stream_activities();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event, "continuation_cancelled");
        assert_eq!(events[0].attempt, 1);
        assert_eq!(
            events[0].reason_class.as_deref(),
            Some("turn_activity_changed")
        );
        mark_turn_completed(&newer.desktop_thread_id);
    }

    #[tokio::test(start_paused = true)]
    async fn readiness_deadline_preserves_last_redacted_blocker_without_spending_attempt() {
        let context = context("recovery-readiness-blocker", 1);
        assert_eq!(reserve_recovery(&context), Some(1));
        let calls = std::sync::atomic::AtomicU32::new(0);
        let mut diagnostics = Vec::new();
        run_turn_recovery_with_deadline_reporter(
            context.clone(),
            "test_readiness_blocker",
            1,
            |_, _| {
                let call = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                async move {
                    if call == 0 {
                        Ok(crate::codex_desktop::CodexContinuationResult {
                            submitted: false,
                            mutation_attempted: false,
                            debug_port: None,
                            target_id: None,
                            message: "Codex Desktop request client was not found".into(),
                        })
                    } else {
                        futures::future::pending().await
                    }
                }
            },
            |_, _| true,
            |_, attempt, commit_started, blocker| {
                diagnostics.push((attempt, commit_started, blocker));
            },
        )
        .await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(
            diagnostics,
            vec![(1, false, "desktop_request_client_unavailable")]
        );
        assert!(!recovery_is_active(&context));
        assert_eq!(reserve_recovery(&context), Some(1));
        mark_turn_completed(&context.desktop_thread_id);
    }

    #[test]
    fn readiness_diagnostics_are_static_and_do_not_serialize_arbitrary_errors() {
        for (message, expected) in [
            (
                "Codex compatibility layer is not ready",
                "compatibility_runtime_unavailable",
            ),
            (
                "The interrupted Codex thread is still active",
                "thread_not_terminal",
            ),
            (
                "The latest Codex turn was interrupted without a recoverable error",
                "interrupted_error_unrecognized",
            ),
            (
                "The latest Codex turn needs a user action",
                "permanent_thread_error",
            ),
            (
                "The user changed or stopped the Codex thread before continuation",
                "thread_changed_or_cancelled",
            ),
            (
                "Codex returned a different thread",
                "thread_identity_changed",
            ),
            (
                "The interrupted Codex thread changed model",
                "thread_model_changed",
            ),
            (
                "failed to connect CDP websocket: REDACTED transport details",
                "desktop_connection_unavailable",
            ),
            (
                "No Codex Desktop page target was found on CDP port REDACTED",
                "desktop_target_unavailable",
            ),
            (
                "REDACTED arbitrary renderer details",
                "desktop_readiness_unknown",
            ),
        ] {
            assert_eq!(desktop_readiness_blocker(message), expected);
            assert!(!desktop_readiness_blocker(message).contains("REDACTED"));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn deadline_reports_real_cdp_command_timeout_without_consuming_attempt() {
        let context = context("recovery-cdp-command-timeout-diagnostic", 1);
        assert_eq!(reserve_recovery(&context), Some(1));
        let mut diagnostics = Vec::new();
        run_turn_recovery_with_deadline_reporter(
            context.clone(),
            "test_cdp_command_timeout_diagnostic",
            1,
            |_, _| {
                std::future::ready(Err(
                    "timed out waiting for CDP command Runtime.enable".into()
                ))
            },
            |_, _| true,
            |_, attempt, commit_started, blocker| {
                diagnostics.push((attempt, commit_started, blocker))
            },
        )
        .await;
        assert_eq!(diagnostics, vec![(1, false, "desktop_command_timeout")]);
        assert_eq!(reserve_recovery(&context), Some(1));
        mark_turn_completed(&context.desktop_thread_id);
    }

    #[test]
    fn readiness_diagnostics_classify_actual_cdp_producer_templates() {
        for (message, expected) in [
            ("port 9229: failed to list CDP targets: REDACTED", "desktop_target_unavailable"),
            ("timed out waiting for CDP command Runtime.enable", "desktop_command_timeout"),
            ("failed to send CDP command Runtime.evaluate: REDACTED", "desktop_connection_unavailable"),
            ("CDP websocket closed before Runtime.evaluate response", "desktop_connection_unavailable"),
            ("failed to read CDP message: REDACTED", "desktop_connection_unavailable"),
            ("failed to parse CDP message: REDACTED", "desktop_protocol_error"),
            ("CDP command Runtime.evaluate failed: REDACTED", "desktop_protocol_error"),
            ("target REDACTED: CDP evaluation failed: REDACTED", "desktop_evaluation_failed"),
            ("target REDACTED: CDP continuation commit failed: REDACTED", "desktop_evaluation_failed"),
            ("target REDACTED: continuation is still pending; no second submission was attempted", "desktop_preparation_unresponsive"),
            ("No Codex Desktop CDP target was found", "desktop_target_unavailable"),
            ("REDACTED arbitrary renderer details", "desktop_readiness_unknown"),
        ] {
            assert_eq!(desktop_readiness_blocker(message), expected, "{message}");
            assert!(!desktop_readiness_blocker(message).contains("REDACTED"));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn read_only_desktop_preparation_timeout_does_not_consume_an_attempt() {
        let context = context("recovery-read-only-deadline", 1);
        assert_eq!(reserve_recovery(&context), Some(1));
        let started = tokio::time::Instant::now();
        run_turn_recovery(
            context.clone(),
            "test_hanging_read_only_preparation",
            1,
            |_, _| {
                futures::future::pending::<
                    Result<crate::codex_desktop::CodexContinuationResult, String>,
                >()
            },
            |_, _| true,
        )
        .await;
        assert_eq!(
            started.elapsed(),
            continuation_backoff(1) + DESKTOP_READY_TIMEOUT
        );
        assert!(!recovery_is_active(&context));
        assert_eq!(reserve_recovery(&context), Some(1));
        mark_turn_completed(&context.desktop_thread_id);
    }

    #[tokio::test(start_paused = true)]
    async fn definite_renderer_refusal_returns_to_preparation_without_spending_budget() {
        let context = context("recovery-definite-renderer-refusal", 1);
        assert_eq!(reserve_recovery(&context), Some(1));
        let calls = std::sync::atomic::AtomicU32::new(0);
        run_turn_recovery(
            context.clone(),
            "test_definite_renderer_refusal",
            1,
            |context, _| {
                let call = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if call == 0 {
                    assert!(authorize_reserved_recovery(&context));
                } else {
                    let phase = recovery_states()
                        .lock()
                        .unwrap()
                        .get(&context.desktop_thread_id)
                        .unwrap()
                        .phase;
                    assert_eq!(
                        phase,
                        RecoveryPhase::ReservedRecovery,
                        "a positive no-mutation result must release the committing phase"
                    );
                    begin_turn(&context.desktop_thread_id, true);
                    assert_eq!(
                        recovery_states()
                            .lock()
                            .unwrap()
                            .get(&context.desktop_thread_id)
                            .unwrap()
                            .submitted,
                        0
                    );
                    cancel_reserved_recovery(&context);
                }
                std::future::ready(Ok(crate::codex_desktop::CodexContinuationResult {
                    submitted: false,
                    mutation_attempted: false,
                    debug_port: None,
                    target_id: None,
                    message: "renderer positively refused before mutation".into(),
                }))
            },
            |_, _| true,
        )
        .await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(reserve_recovery(&context), Some(1));
        mark_turn_completed(&context.desktop_thread_id);
    }

    #[tokio::test(start_paused = true)]
    async fn disconnected_commit_acknowledgement_consumes_once_without_retrying_submission() {
        let context = context("recovery-commit-ack-disconnect", 1);
        assert_eq!(reserve_recovery(&context), Some(1));
        let calls = std::sync::atomic::AtomicU32::new(0);
        run_turn_recovery(
            context.clone(),
            "test_commit_ack_disconnect",
            1,
            |context, _| {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                assert!(authorize_reserved_recovery(&context));
                std::future::ready(Err("simulated commit acknowledgement disconnect".into()))
            },
            |_, _| true,
        )
        .await;
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "a potentially accepted mutation must not be submitted again"
        );
        let states = recovery_states().lock().unwrap();
        let state = states.get(&context.desktop_thread_id).unwrap();
        assert_eq!(state.submitted, 1);
        assert_eq!(state.phase, RecoveryPhase::AwaitingContinuation);
        drop(states);
        assert_eq!(reserve_recovery(&context), None);
        mark_turn_completed(&context.desktop_thread_id);
    }

    #[tokio::test(start_paused = true)]
    async fn precommit_connection_error_retries_preparation_without_spending_an_attempt() {
        let context = context("recovery-precommit-connection-error", 1);
        assert_eq!(reserve_recovery(&context), Some(1));
        let calls = std::sync::atomic::AtomicU32::new(0);
        run_turn_recovery(
            context.clone(),
            "test_precommit_connection_error",
            1,
            |context, _| {
                let call = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if call == 0 {
                    return std::future::ready(Err("simulated precommit connection error".into()));
                }
                assert_eq!(
                    recovery_states()
                        .lock()
                        .unwrap()
                        .get(&context.desktop_thread_id)
                        .unwrap()
                        .submitted,
                    0
                );
                assert!(authorize_reserved_recovery(&context));
                std::future::ready(Ok(crate::codex_desktop::CodexContinuationResult {
                    submitted: true,
                    mutation_attempted: true,
                    debug_port: None,
                    target_id: None,
                    message: "simulated successful continuation".into(),
                }))
            },
            |_, _| true,
        )
        .await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        let states = recovery_states().lock().unwrap();
        let state = states.get(&context.desktop_thread_id).unwrap();
        assert_eq!(state.submitted, 1);
        assert_eq!(state.phase, RecoveryPhase::AwaitingContinuation);
        drop(states);
        assert_eq!(reserve_recovery(&context), None);
        mark_turn_completed(&context.desktop_thread_id);
    }

    #[tokio::test(start_paused = true)]
    async fn reduced_live_budget_cancels_a_reserved_attempt_before_submission() {
        let mut context = context("recovery-live-budget-before-submit", 3);
        assert_eq!(reserve_recovery(&context), Some(1));
        assert!(authorize_reserved_recovery(&context));
        assert_eq!(finish_reserved_recovery(&context, true), 1);
        observe_next_continuation(&mut context).hand_off_to_stream();
        assert_eq!(reserve_recovery(&context), Some(2));
        let calls = std::sync::atomic::AtomicU32::new(0);
        run_turn_recovery(
            context.clone(),
            "test_reduced_live_budget",
            2,
            |_, _| {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                std::future::ready(Ok(crate::codex_desktop::CodexContinuationResult {
                    submitted: true,
                    mutation_attempted: true,
                    debug_port: None,
                    target_id: None,
                    message: "simulated submission".into(),
                }))
            },
            |context, attempt| recovery_policy_allows_attempt(context, attempt, 1),
        )
        .await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        {
            let states = recovery_states().lock().unwrap();
            let retained = states.get(&context.desktop_thread_id).unwrap();
            assert_eq!(retained.submitted, 1);
            assert_eq!(retained.phase, RecoveryPhase::AwaitingContinuation);
        }
        begin_turn(&context.desktop_thread_id, true);
        let mut next = context.clone();
        next.recovery_id = "manual-continue-after-policy-cancellation".into();
        next.observed_at_ms += 1;
        next.max_recoveries = 1;
        let tracked = track_turn(&next);
        assert_eq!(
            reserve_recovery(&next),
            None,
            "cancelling an over-budget queued attempt must not reset the already-spent budget"
        );
        drop(tracked);
        mark_turn_completed(&context.desktop_thread_id);
    }

    #[tokio::test(start_paused = true)]
    async fn pending_recovery_rechecks_reduced_or_disabled_policy_before_another_submission() {
        for next_budget in [1, 0] {
            let mut context = context(&format!("recovery-live-policy-pending-{next_budget}"), 3);
            assert_eq!(reserve_recovery(&context), Some(1));
            assert!(authorize_reserved_recovery(&context));
            assert_eq!(finish_reserved_recovery(&context, true), 1);
            observe_next_continuation(&mut context).hand_off_to_stream();
            assert_eq!(reserve_recovery(&context), Some(2));
            let current_budget = std::sync::atomic::AtomicU32::new(3);
            let calls = std::sync::atomic::AtomicU32::new(0);
            run_turn_recovery(
                context.clone(),
                "test_live_policy_changed_while_pending",
                2,
                |_, _| {
                    calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    current_budget.store(next_budget, std::sync::atomic::Ordering::SeqCst);
                    std::future::ready(Ok(crate::codex_desktop::CodexContinuationResult {
                        submitted: false,
                        mutation_attempted: false,
                        debug_port: None,
                        target_id: None,
                        message: "simulated Desktop readiness wait".into(),
                    }))
                },
                |context, attempt| {
                    recovery_policy_allows_attempt(
                        context,
                        attempt,
                        current_budget.load(std::sync::atomic::Ordering::SeqCst),
                    )
                },
            )
            .await;
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
            let states = recovery_states().lock().unwrap();
            let retained = states.get(&context.desktop_thread_id).unwrap();
            assert_eq!(retained.submitted, 1);
            assert_eq!(retained.phase, RecoveryPhase::AwaitingContinuation);
            drop(states);
            mark_turn_completed(&context.desktop_thread_id);
        }
    }

    #[test]
    fn policy_cancellation_cannot_erase_a_newer_generation() {
        let old = context("recovery-policy-cancel-generation", 3);
        assert_eq!(reserve_recovery(&old), Some(1));
        let mut newer = old.clone();
        newer.recovery_id = "newer-live-generation".into();
        newer.observed_at_ms += 1;
        let tracked = track_turn(&newer);
        cancel_reserved_recovery(&old);
        let states = recovery_states().lock().unwrap();
        let state = states.get(&newer.desktop_thread_id).unwrap();
        assert_eq!(state.phase, RecoveryPhase::ActiveRequest);
        assert_eq!(
            state.tracked.as_ref().unwrap().recovery_id,
            newer.recovery_id
        );
        drop(states);
        drop(tracked);
    }

    #[test]
    fn old_crash_ledgers_without_a_phase_keep_their_interrupted_request_semantics() {
        let context = context("recovery-old-ledger-phase", 3);
        let value = serde_json::json!({
            "configScope":"test-scope", "savedAt":1,
            "turns":[{"context":context,"submitted":1}]
        });
        let ledger: RecoveryLedger = serde_json::from_value(value).unwrap();
        assert_eq!(ledger.turns[0].phase, RecoveryPhase::Idle);
        assert_eq!(ledger.turns[0].submitted, 1);
    }

    #[test]
    fn crash_ledger_is_scoped_recent_and_preserves_budget_without_request_body() {
        let context = context("recovery-ledger", 2);
        let mut states = HashMap::new();
        states.insert(
            context.desktop_thread_id.clone(),
            RecoveryState {
                submitted: 1,
                phase: RecoveryPhase::ActiveRequest,
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
    #[serial_test::serial]
    fn startup_restores_valid_router_budget_and_preserves_new_live_requests() {
        let _home = crate::config::TestHomeGuard::new();
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
            version: RECOVERY_LEDGER_VERSION,
            continuations: Vec::new(),
            config_scope: crate::process_identity::config_scope_fingerprint(),
            saved_at: chrono::Utc::now().timestamp(),
            turns: vec![
                PersistedTurn {
                    commit_charged: false,
                    context: valid.clone(),
                    submitted: 1,
                    phase: RecoveryPhase::Idle,
                },
                PersistedTurn {
                    commit_charged: false,
                    context: changed.clone(),
                    submitted: 0,
                    phase: RecoveryPhase::Idle,
                },
                PersistedTurn {
                    commit_charged: false,
                    context: old,
                    submitted: 0,
                    phase: RecoveryPhase::Idle,
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
        assert!(authorize_reserved_recovery(&valid));
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
            assert_eq!(
                state.tracked.as_ref().unwrap().recovery_id,
                newer.recovery_id
            );
            assert_eq!(state.phase, RecoveryPhase::ActiveRequest);
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
        let mut context = context("recovery-tool-budget", 2);
        assert_eq!(reserve_recovery(&context), Some(1));
        assert!(authorize_reserved_recovery(&context));
        finish_reserved_recovery(&context, true);
        let tracked = observe_next_continuation(&mut context);
        mark_observed_tool_step_completed(&context);
        drop(tracked);
        let states = recovery_states().lock().unwrap();
        let state = states.get(&context.desktop_thread_id).unwrap();
        assert_eq!(state.submitted, 1);
        assert!(state.tracked.is_some());
        assert_eq!(state.phase, RecoveryPhase::ToolStepComplete);
        drop(states);
        observe_next_continuation(&mut context).hand_off_to_stream();
        assert_eq!(reserve_recovery(&context), Some(2));
        assert!(authorize_reserved_recovery(&context));
        finish_reserved_recovery(&context, true);
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
        assert_eq!(state.phase, RecoveryPhase::ToolStepComplete);
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
                status: 503,
                body: Some("Our servers are currently overloaded. Please try again later.".into()),
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
                status: 429,
                body: Some("Daily quota exhausted. Our servers are currently overloaded.".into()),
            },
            ProxyError::UpstreamError {
                status: 503,
                body: Some("Daily usage limit reached.".into()),
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
    fn request_failure_recovery_includes_retryable_http_timeouts_and_early_rejections() {
        use super::super::error::ProxyError;
        for status in [408, 425] {
            for body in [
                None,
                Some("Temporary request timeout; try again later".into()),
            ] {
                assert!(
                    forward_error_is_recoverable(&ProxyError::UpstreamError { status, body }),
                    "HTTP {status} must retain the reconnect layer's transient classification"
                );
            }
            for body in [
                "Daily quota exhausted",
                "The user cancelled the request",
                "Response pending",
            ] {
                assert!(
                    !forward_error_is_recoverable(&ProxyError::UpstreamError {
                        status,
                        body: Some(body.into()),
                    }),
                    "HTTP {status} must not override permanent error precedence"
                );
            }
        }
    }

    #[test]
    fn new_user_turn_resets_budget_but_continuation_keeps_it() {
        let mut context = context("recovery-new-turn", 2);
        mark_turn_completed(&context.session_id);
        assert_eq!(reserve_recovery(&context), Some(1));
        assert!(authorize_reserved_recovery(&context));
        assert_eq!(finish_reserved_recovery(&context, true), 1);

        observe_next_continuation(&mut context).hand_off_to_stream();
        assert_eq!(reserve_recovery(&context), Some(2));
        assert!(authorize_reserved_recovery(&context));
        assert_eq!(finish_reserved_recovery(&context, true), 2);

        begin_turn(&context.session_id, false);
        assert_eq!(reserve_recovery(&context), Some(1));
        finish_reserved_recovery(&context, false);
        mark_turn_completed(&context.session_id);
    }

    #[test]
    fn arriving_continuation_consumes_an_in_flight_reservation_once() {
        let mut context = context("recovery-arrival-race", 2);
        mark_turn_completed(&context.session_id);
        assert_eq!(reserve_recovery(&context), Some(1));

        assert!(authorize_reserved_recovery(&context));
        begin_turn(&context.session_id, true);
        assert_eq!(finish_reserved_recovery(&context, true), 1);
        observe_next_continuation(&mut context).hand_off_to_stream();
        assert_eq!(reserve_recovery(&context), Some(2));

        finish_reserved_recovery(&context, false);
        mark_turn_completed(&context.session_id);
    }

    #[test]
    fn manually_arriving_continuation_during_preparation_does_not_spend_automatic_budget() {
        let mut context = context("recovery-manual-during-preparation", 2);
        assert_eq!(reserve_recovery(&context), Some(1));
        let next = observe_next_continuation(&mut context);
        assert_eq!(
            recovery_states()
                .lock()
                .unwrap()
                .get(&context.desktop_thread_id)
                .unwrap()
                .submitted,
            0
        );
        assert_eq!(reserve_recovery(&context), Some(1));
        drop(next);
        mark_turn_completed(&context.desktop_thread_id);
    }

    #[test]
    fn response_pending_terminal_cannot_start_another_automatic_turn() {
        for payload in [
            serde_json::json!({"response":{"status":"failed","error":{"code":"response_pending","message":"The upstream operation may still be running"}}}),
            serde_json::json!({"error":{"code":"response_pending"}}),
        ] {
            assert_eq!(
                recovery_decision(
                    NativeResponsesTerminalDisposition::Failed,
                    "response.failed",
                    &payload,
                    NativeResponsesEvidence::default(),
                ),
                RecoveryDecision::Ignore,
                "an unknown still-running operation must not produce a second turn"
            );
        }
    }

    #[test]
    fn temporary_usage_limits_remain_recoverable_after_semantic_output() {
        use super::super::error::ProxyError;

        let error = serde_json::json!({
            "type": "usage_limit_reached",
            "message": "You've hit your usage limit. Please try again later."
        });
        let payload = serde_json::json!({"response": {"status": "failed", "error": error}});
        let evidence = NativeResponsesEvidence {
            has_final_message: true,
            valid_tool_calls: 1,
            ..NativeResponsesEvidence::default()
        };
        assert!(terminal_is_recoverable("response.failed", &payload));
        assert_eq!(
            recovery_decision(
                NativeResponsesTerminalDisposition::Failed,
                "response.failed",
                &payload,
                evidence,
            ),
            RecoveryDecision::Recover("response_failed")
        );
        assert!(forward_error_is_recoverable(&ProxyError::UpstreamError {
            status: 429,
            body: Some(serde_json::json!({"error": error}).to_string()),
        }));

        for message in [
            "Daily usage limit reached. Please try again later.",
            "Weekly usage limit reached. Please retry later.",
            "Monthly usage limit reached. Wait for the reset.",
            "Usage limit reached; quota exhausted. Retry later.",
            "Usage limit reached; billing payment required. Retry later.",
            "Usage limit reached; insufficient credit balance. Retry later.",
            "Usage limit reached. Permission denied; retry later.",
            "Usage limit reached. Token expired; retry later.",
            "Usage limit reached. User cancelled the turn; retry later.",
        ] {
            let error = serde_json::json!({"type": "usage_limit_reached", "message": message});
            let payload = serde_json::json!({"response": {"status": "failed", "error": error}});
            assert_eq!(
                recovery_decision(
                    NativeResponsesTerminalDisposition::Failed,
                    "response.failed",
                    &payload,
                    evidence,
                ),
                RecoveryDecision::Ignore,
                "{message}"
            );
            assert!(
                !forward_error_is_recoverable(&ProxyError::UpstreamError {
                    status: 429,
                    body: Some(serde_json::json!({"error": error}).to_string()),
                }),
                "{message}"
            );
        }
    }

    #[tokio::test]
    async fn explicit_retry_denials_never_reserve_a_continuation() {
        use super::super::error::ProxyError;

        for (index, error) in [
            serde_json::json!({"code":"server_error","message":"Temporary overload; retry later.","retryable":false}),
            serde_json::json!({"code":"overloaded_error","message":"The upstream provider is overloaded; automatic capacity retry is disabled.","retryable":false}),
            serde_json::json!({"code":"server_error","message":"Temporary overload. Do not retry this request; retry another request."}),
            serde_json::json!({"code":"not_retryable","message":"Temporary overload"}),
            serde_json::json!({"type":"usage_limit_reached","message":"Usage limit reached. Please retry later.","retryable":false}),
        ].into_iter().enumerate() {
            let context = context(&format!("explicit-no-retry-{index}"), 3);
            let terminal = format!(
                "event: response.failed\ndata: {}\n\n",
                serde_json::json!({"type":"response.failed","response":{"status":"failed","error":error}}),
            );
            let output = observe_responses_turn_stream(
                futures::stream::iter(vec![Ok::<_, std::io::Error>(Bytes::from(terminal.clone()))]),
                context.clone(),
            ).collect::<Vec<_>>().await;
            assert_eq!(output.len(), 1);
            assert_eq!(output[0].as_ref().unwrap(), &Bytes::from(terminal));
            assert!(
                !recovery_states().lock().unwrap().contains_key(&context.desktop_thread_id),
                "an explicit retry denial must clear tracking without queuing a continuation: {error}"
            );
            assert!(!forward_error_is_recoverable(&ProxyError::UpstreamError {
                status: 503,
                body: Some(serde_json::json!({"error":error}).to_string()),
            }));
            mark_turn_completed(&context.desktop_thread_id);
        }
    }

    #[tokio::test]
    async fn replay_disabled_capacity_failure_keeps_independent_continuation_policy() {
        let context = context("capacity-replay-disabled-continuation", 3);
        let terminal = concat!(
            "event: response.failed\n",
            "data: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"overloaded_error\",\"message\":\"The upstream provider is overloaded; automatic capacity retry is disabled.\"}}}\n\n"
        );
        let output = observe_responses_turn_stream(
            futures::stream::iter(vec![Ok::<_, std::io::Error>(Bytes::from(terminal))]),
            context.clone(),
        )
        .collect::<Vec<_>>()
        .await;
        assert_eq!(output.len(), 1);
        assert_eq!(
            recovery_states().lock().unwrap().get(&context.desktop_thread_id).unwrap().phase,
            RecoveryPhase::ReservedRecovery,
            "the provider capacity setting stops same-request replays, not separately enabled Aggressive continuation"
        );
        mark_turn_completed(&context.desktop_thread_id);
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
            serde_json::json!({"response":{"error":{"code":"token_expired"}}}),
            serde_json::json!({"response":{"error":{"code":"insufficient_quota"}}}),
            serde_json::json!({"response":{"error":{"code":"turn_cancelled"}}}),
            serde_json::json!({"response":{"error":{"code":"response_pending","message":"The upstream operation may still be running"}}}),
        ] {
            assert!(!terminal_is_recoverable("response.failed", &payload));
        }
        for reason in [
            "content_filter",
            "policy_violation",
            "context_length_exceeded",
        ] {
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
        let mut context = context("recovery-completed", 1);
        mark_turn_completed(&context.session_id);
        assert_eq!(reserve_recovery(&context), Some(1));
        assert!(authorize_reserved_recovery(&context));
        assert_eq!(finish_reserved_recovery(&context, true), 1);
        observe_next_continuation(&mut context).hand_off_to_stream();

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
        finish_reserved_recovery(&context, false);
        mark_turn_completed(&context.session_id);
    }
}
