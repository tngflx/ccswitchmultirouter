//! Session-scoped Codex Desktop turn recovery.
//!
//! This is deliberately separate from proxy stream reconnection. The proxy may
//! replay a request only before semantic output. Aggressive recovery instead
//! asks Codex Desktop to start a new turn containing the literal `continue`.

use std::collections::HashMap;
use std::ops::{Deref, DerefMut};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::database::{Database, ProviderRevision};

use super::providers::codex_terminal::{
    classify_native_responses_terminal, deferred_usage_limit_period, is_deferred_usage_limit,
    is_retryable_usage_limit_payload, terminal_error_code, terminal_error_code_from_body,
    terminal_error_payload, NativeResponsesEvidence, NativeResponsesTerminalDisposition,
};
use super::sse::strip_sse_field;

const RECOVERY_STATE_TTL: Duration = Duration::from_secs(15 * 60);
// Keep the crash snapshot inside the restore TTL for long-running work. All
// active turns share this checkpoint and durable transitions reset the clock.
const RECOVERY_CHECKPOINT_INTERVAL: Duration = Duration::from_secs(10 * 60);
// Permit a short gap between native snapshots without presenting an old
// confirmation indefinitely if the renderer stops answering.
const NATIVE_USAGE_LIMIT_CONFIRMATION_TTL: Duration = Duration::from_secs(30);
const DESKTOP_READY_TIMEOUT: Duration = Duration::from_secs(60);
const DESKTOP_READY_DELAY: Duration = Duration::from_millis(500);
#[cfg(not(test))]
const RECOVERY_FILE: &str = "codex-turn-recovery.json";
const RECOVERY_LEDGER_VERSION: u32 = 2;
const MAX_OWNER_OPERATIONS_PER_THREAD: usize = 256;
const MAX_IDLE_OWNER_EPOCHS: usize = 128;
const IDLE_OWNER_EPOCH_TTL: Duration = Duration::from_secs(60);
const MAX_RECOVERY_LEDGER_BYTES: usize = 16 * 1024 * 1024;
const MAX_RECOVERY_SSE_FRAME_BYTES: usize = 1024 * 1024;

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

    fn blocks_new_continuation(
        &self,
        action_epoch: &str,
        usage_limit: Option<&UsageLimitCandidate>,
    ) -> bool {
        if self.status == OwnerContinuationStatus::Committing {
            return true;
        }
        if usage_limit.is_some_and(|candidate| candidate.turn.turn_id == self.base_turn_id) {
            return self.status != OwnerContinuationStatus::Refused;
        }
        // Native turns can advance without a proxy request changing the epoch.
        // Preserve previous mutation receipts and any current reservation.
        self.blocks_same_epoch(action_epoch)
            && (self.status == OwnerContinuationStatus::Reserved
                || usage_limit.is_none_or(|candidate| {
                    candidate
                        .native_evidence
                        .confirmed_at_ms(Instant::now())
                        .is_none()
                }))
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

pub(crate) fn valid_continuation_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct TurnRecoveryContext {
    pub(crate) session_id: String,
    pub(crate) desktop_thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) desktop_turn_id: Option<String>,
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

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObservedUsageLimitTurn {
    thread_id: String,
    turn_id: String,
    model: Option<String>,
    observed_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProxyUsageLimitTurn {
    pub(crate) thread_id: String,
    pub(crate) turn_id: String,
    pub(crate) observed_at_ms: i64,
}

impl ProxyUsageLimitTurn {
    pub(crate) fn is_valid(&self) -> bool {
        valid_continuation_identifier(&self.thread_id)
            && valid_continuation_identifier(&self.turn_id)
            && self.observed_at_ms > 0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativeUsageLimitEvidence {
    Absent,
    Confirmed {
        observed_at_ms: i64,
        confirmed_at: Instant,
    },
    Conflicting,
    Displaced,
}

impl NativeUsageLimitEvidence {
    fn confirmed_at_ms(self, now: Instant) -> Option<i64> {
        match self {
            Self::Confirmed {
                observed_at_ms,
                confirmed_at,
            } if now.saturating_duration_since(confirmed_at)
                <= NATIVE_USAGE_LIMIT_CONFIRMATION_TTL =>
            {
                Some(observed_at_ms)
            }
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct UsageLimitCandidate {
    turn: ObservedUsageLimitTurn,
    proxy_observed_at: Option<Instant>,
    native_evidence: NativeUsageLimitEvidence,
}

impl UsageLimitCandidate {
    fn from_active_proxy_turn(
        state: &RecoveryState,
        context: &TurnRecoveryContext,
        now: Instant,
    ) -> Option<Self> {
        if !context.desktop_eligible
            || state.phase != RecoveryPhase::ActiveRequest
            || state.tracked_epoch.as_deref() != Some(state.action_epoch.as_str())
            || state.tracked.as_ref().is_none_or(|tracked| {
                tracked.recovery_id != context.recovery_id
                    || tracked.desktop_turn_id != context.desktop_turn_id
            })
        {
            return None;
        }
        let turn = ObservedUsageLimitTurn {
            thread_id: context.desktop_thread_id.clone(),
            turn_id: context.desktop_turn_id.clone()?,
            model: Some(context.desktop_model.clone()),
            observed_at_ms: context.observed_at_ms,
        };
        turn.is_valid().then_some(Self {
            turn,
            proxy_observed_at: Some(now),
            native_evidence: NativeUsageLimitEvidence::Absent,
        })
    }

    fn has_current_proxy_observation(&self, now: Instant) -> bool {
        self.proxy_observed_at
            .is_some_and(|observed| now.saturating_duration_since(observed) <= RECOVERY_STATE_TTL)
    }

    fn has_current_observation(&self, now: Instant) -> bool {
        self.native_evidence.confirmed_at_ms(now).is_some()
            || self.has_current_proxy_observation(now)
    }

    fn has_current_evidence(&self, now: Instant) -> bool {
        !matches!(
            self.native_evidence,
            NativeUsageLimitEvidence::Conflicting | NativeUsageLimitEvidence::Displaced
        ) && self.has_current_observation(now)
    }

    fn continuation_observation(&self) -> (i64, bool) {
        let native_observed_at_ms = self.native_evidence.confirmed_at_ms(Instant::now());
        (
            native_observed_at_ms.unwrap_or(self.turn.observed_at_ms),
            native_observed_at_ms.is_some(),
        )
    }

    fn operation_id(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut digest = Sha256::new();
        digest.update(self.turn.thread_id.as_bytes());
        digest.update([0]);
        digest.update(self.turn.turn_id.as_bytes());
        format!("usage-limit-{}", hex::encode(digest.finalize()))
    }
}

fn usage_limit_candidate_is_current(
    state: &RecoveryState,
    candidate: &UsageLimitCandidate,
) -> bool {
    let now = Instant::now();
    state.usage_limit.as_ref().is_some_and(|current| {
        current.turn == candidate.turn
            && current.proxy_observed_at == candidate.proxy_observed_at
            && candidate
                .native_evidence
                .confirmed_at_ms(now)
                .is_none_or(|expected| {
                    current.native_evidence.confirmed_at_ms(now) == Some(expected)
                })
            && current.has_current_evidence(now)
    })
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
    // Eligibility is live evidence from this CC Switch process. Only
    // continuation transaction receipts are restored across a restart.
    usage_limit: Option<UsageLimitCandidate>,
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
            usage_limit: None,
            continuations: HashMap::new(),
        }
    }
}

#[derive(Default)]
struct RecoveryStates {
    threads: HashMap<String, RecoveryState>,
    native_usage_limit_scan: Option<NativeUsageLimitScanReceipt>,
    last_logged_usage_limit_count: Option<(usize, &'static str)>,
    last_persisted_at: Option<Instant>,
}

struct NativeUsageLimitScanReceipt {
    verified_at: Instant,
    verified_at_ms: i64,
    complete: bool,
}

impl Deref for RecoveryStates {
    type Target = HashMap<String, RecoveryState>;

    fn deref(&self) -> &Self::Target {
        &self.threads
    }
}

impl DerefMut for RecoveryStates {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.threads
    }
}

static RECOVERY_STATES: OnceLock<Mutex<RecoveryStates>> = OnceLock::new();
#[cfg(test)]
thread_local! {
    static RECOVERY_PERSIST_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn recovery_states() -> &'static Mutex<RecoveryStates> {
    RECOVERY_STATES.get_or_init(|| Mutex::new(RecoveryStates::default()))
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
    state.usage_limit = None;
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
            && state.usage_limit.is_none()
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
    reserve_continuation(epoch, base_turn_id, operation_id, None)
}

fn reserve_continuation(
    epoch: &OwnerContinuationEpoch,
    base_turn_id: &str,
    operation_id: &str,
    usage_limit: Option<&UsageLimitCandidate>,
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
    if usage_limit.is_some_and(|candidate| !usage_limit_candidate_is_current(state, candidate)) {
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
    ) || state
        .continuations
        .values()
        .any(|operation| operation.blocks_new_continuation(&state.action_epoch, usage_limit))
    {
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
    if !persist_states(&mut states) {
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
    persist: impl FnOnce(&mut RecoveryStates) -> bool,
) -> bool {
    authorize_continuation_commit(operation, None, persist)
}

fn authorize_continuation_commit(
    operation: &OwnerContinuationOperation,
    usage_limit: Option<&UsageLimitCandidate>,
    persist: impl FnOnce(&mut RecoveryStates) -> bool,
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
        || usage_limit.is_some_and(|candidate| !usage_limit_candidate_is_current(state, candidate))
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
    persist(&mut states)
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
    if !persist_states(&mut states) && receipt.mutation_attempted {
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
    persist_states(&mut states)
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
            || state
                .usage_limit
                .as_ref()
                .is_some_and(|candidate| candidate.has_current_observation(now))
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
    persist_states(&mut states).then_some(attempt)
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
        persist_states(&mut states);
    }
}

pub(crate) fn mark_observed_turn_completed(context: &TurnRecoveryContext) {
    finish_observed_turn(context, false);
}

pub(super) fn finish_observed_turn(context: &TurnRecoveryContext, deferred_usage_limit: bool) {
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
            let candidate = if deferred_usage_limit {
                UsageLimitCandidate::from_active_proxy_turn(state, context, Instant::now())
            } else {
                None
            };
            if let Some(candidate) = candidate {
                state.usage_limit = Some(candidate);
            } else if state.usage_limit.as_ref().is_some_and(|candidate| {
                context.desktop_turn_id.as_deref() == Some(candidate.turn.turn_id.as_str())
            }) {
                state.usage_limit = None;
            }
            reset_automatic_state(state, true);
            if state.continuations.is_empty() && state.usage_limit.is_none() {
                states.remove(&context.desktop_thread_id);
            }
            persist_states(&mut states);
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
                persist_states(&mut states);
            }
        }
    }
}

fn retire_uninspectable_stream(context: &TurnRecoveryContext) {
    let Ok(mut states) = recovery_states().lock() else {
        return;
    };
    let Some(state) = states.get_mut(&context.desktop_thread_id) else {
        return;
    };
    if state.phase != RecoveryPhase::ActiveRequest
        || state.tracked_epoch.as_deref() != Some(state.action_epoch.as_str())
        || state
            .tracked
            .as_ref()
            .is_none_or(|tracked| tracked.recovery_id != context.recovery_id)
    {
        return;
    }
    // An unreadable event might contain a success or a permanent failure. Do
    // not leave crash-recovery evidence, but do not refund earlier attempts.
    if state.submitted > 0 {
        make_automatic_budget_dormant(state);
    } else {
        reset_automatic_state(state, false);
        if state.continuations.is_empty() {
            states.remove(&context.desktop_thread_id);
        }
    }
    persist_states(&mut states);
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
        persist_states(&mut states);
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
    persist: impl FnOnce(&mut RecoveryStates) -> bool,
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
    persist(&mut states)
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
        persist_states(&mut states);
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
    if committed_submission {
        state.usage_limit = None;
    }
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
    persist_states(&mut states);
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
        if state.continuations.is_empty() && state.usage_limit.is_none() {
            states.remove(&context.desktop_thread_id);
        }
    }
    persist_states(&mut states);
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
                persist_states(&mut states);
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
                persist_states(&mut states);
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
                    if !refresh_recovery_lease(
                        &mut states,
                        &heartbeat_context,
                        RecoveryPhase::ActiveRequest,
                        Instant::now(),
                    ) {
                        return;
                    }
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
            if entry.transaction.status == OwnerContinuationStatus::Reserved {
                // A reservation has no mutation evidence. It belongs to the
                // previous process epoch and must not block a fresh native
                // observation of the same deterministic thread/turn operation.
                continue;
            }
            let state = states.entry(entry.thread_id.clone()).or_default();
            let mut transaction = entry.transaction.clone();
            transaction.status = match transaction.status {
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
                    phase: if state.phase == RecoveryPhase::Idle && state.usage_limit.is_some() {
                        RecoveryPhase::AwaitingContinuation
                    } else {
                        state.phase
                    },
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

fn persist_states(states: &mut RecoveryStates) -> bool {
    persist_states_at(states, Instant::now())
}

fn persist_states_at(states: &mut RecoveryStates, now: Instant) -> bool {
    if !RECOVERY_STORAGE_HEALTHY.load(Ordering::SeqCst) {
        return false;
    }
    #[cfg(test)]
    RECOVERY_PERSIST_CALLS.with(|calls| calls.set(calls.get().saturating_add(1)));
    #[cfg(not(test))]
    if persist_states_to_path(states, &recovery_path()).is_err() {
        RECOVERY_STORAGE_HEALTHY.store(false, Ordering::SeqCst);
        log::warn!(
            "[Codex/Recovery] failed to persist continuation evidence; mutation is disabled"
        );
        return false;
    }
    states.last_persisted_at = Some(now);
    true
}

fn refresh_recovery_lease(
    states: &mut RecoveryStates,
    context: &TurnRecoveryContext,
    phase: RecoveryPhase,
    now: Instant,
) -> bool {
    if !RECOVERY_STORAGE_HEALTHY.load(Ordering::SeqCst) {
        return false;
    }
    let Some(state) = states.get_mut(&context.desktop_thread_id) else {
        return false;
    };
    if state.phase != phase
        || state
            .tracked
            .as_ref()
            .is_none_or(|tracked| tracked.recovery_id != context.recovery_id)
    {
        return false;
    }
    state.updated_at = now;
    // Callers hold the recovery lock, so simultaneous heartbeats share the
    // snapshot and its timestamp with both automatic and owner transitions.
    if states.last_persisted_at.is_none_or(|previous| {
        now.saturating_duration_since(previous) >= RECOVERY_CHECKPOINT_INTERVAL
    }) {
        return persist_states_at(states, now);
    }
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
        persist_states(&mut states);
    }
}

fn ledger_is_current(ledger: &RecoveryLedger, config_scope: &str, now: i64) -> bool {
    ledger.config_scope == config_scope
        && ledger.saved_at <= now
        && now.saturating_sub(ledger.saved_at) <= RECOVERY_STATE_TTL.as_secs() as i64
}

fn should_skip_reserved_only_turn(
    turn: &PersistedTurn,
    continuations: &[PersistedContinuation],
) -> bool {
    if turn.submitted != 0
        || turn.phase != RecoveryPhase::AwaitingContinuation
        || turn.commit_charged
    {
        return false;
    }
    let Some(desktop_turn_id) = turn.context.desktop_turn_id.as_deref() else {
        return false;
    };
    let same_thread = continuations
        .iter()
        .filter(|entry| entry.thread_id == turn.context.desktop_thread_id);
    let mut found_owner_evidence = false;
    for entry in same_thread {
        if entry.transaction.status != OwnerContinuationStatus::Reserved {
            return false;
        }
        if entry.transaction.base_turn_id == desktop_turn_id {
            found_owner_evidence = true;
        }
    }
    found_owner_evidence
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
    let continuations = &ledger.continuations;
    for turn in ledger.turns {
        if should_skip_reserved_only_turn(&turn, continuations) {
            // A previous process may have checkpointed an unsubmitted
            // usage-limit turn alongside an owner reservation. The
            // reservation has no mutation evidence and was discarded during
            // import, so restoring this turn would veto a fresh native
            // observation of the same thread and turn.
            continue;
        }
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
    #[cfg(test)]
    PROVIDER_FINGERPRINT_CALLS.with(|calls| calls.set(calls.get() + 1));
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

#[cfg(test)]
thread_local! {
    static PROVIDER_FINGERPRINT_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static RECOVERY_PROVIDER_ROW_LOOKUPS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(not(test))]
static RECOVERY_DATABASE: OnceLock<Weak<Database>> = OnceLock::new();

#[cfg(not(test))]
pub(crate) fn register_database(db: &Arc<Database>) {
    let _ = RECOVERY_DATABASE.set(Arc::downgrade(db));
}

// One binding per reservation, shared between the scheduler and authorization.
struct RecoveryProviderBinding {
    db: Weak<Database>,
    cached_match: Mutex<Option<(ProviderRevision, bool)>>,
}

impl RecoveryProviderBinding {
    fn new(db: Weak<Database>) -> Self {
        Self {
            db,
            cached_match: Mutex::new(None),
        }
    }

    fn is_current(
        &self,
        context: &TurnRecoveryContext,
        next_attempt: u32,
        current_budget: Option<u32>,
    ) -> bool {
        current_budget.is_some_and(|budget| {
            recovery_policy_allows_attempt(context, next_attempt, budget)
                && self.provider_matches(context) == Some(true)
        })
    }

    fn provider_matches(&self, context: &TurnRecoveryContext) -> Option<bool> {
        let db = self.db.upgrade()?;
        let mut cached = self.cached_match.lock().ok()?;
        let revision = db.provider_revision().ok()?;
        if let Some((_, matches)) = cached.filter(|(previous, _)| *previous == revision) {
            return Some(matches);
        }

        #[cfg(test)]
        RECOVERY_PROVIDER_ROW_LOOKUPS.with(|calls| calls.set(calls.get() + 1));
        let matches = db
            .get_provider_by_id(&context.durable_provider_id, "codex")
            .ok()?
            .is_some_and(|provider| durable_provider_matches(context, &provider));
        // SQLite may have changed between the revision sample and row read.
        if db.provider_revision().ok()? != revision {
            return None;
        }
        *cached = Some((revision, matches));
        Some(matches)
    }
}

#[cfg(not(test))]
fn recovery_binding_is_current(
    binding: &RecoveryProviderBinding,
    context: &TurnRecoveryContext,
    next_attempt: u32,
) -> bool {
    binding.is_current(
        context,
        next_attempt,
        crate::settings::codex_recovery_budget_for_provider(&context.durable_provider_id),
    )
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

pub(crate) fn handle_recovery_forward_error(
    context: TurnRecoveryContext,
    error: &super::error::ProxyError,
    reason: &'static str,
) {
    if forward_error_is_recoverable(error) {
        if matches!(
            error,
            super::error::ProxyError::UpstreamError { body: Some(body), .. }
                if super::providers::streaming_retry::is_retryable_usage_limit_body(body)
        ) {
            record_proxy_usage_limit(&context);
        }
        schedule_turn_recovery(context, reason);
    } else {
        let manual_usage_limit = matches!(
            error,
            super::error::ProxyError::UpstreamError { status, body: Some(body) }
                if {
                    let payload = terminal_error_payload(body);
                    is_deferred_usage_limit("error", &payload)
                        || (*status == 403 && is_retryable_usage_limit_payload(&payload))
                }
        );
        finish_observed_turn(&context, manual_usage_limit);
    }
}

/// Observe an authoritative upstream usage limit before an adapter can strip
/// its evidence. A handled response must bypass the final response observer
/// for the same request so it cannot reopen or clear the completed turn.
pub(crate) fn observe_recovery_forward_response(
    context: &TurnRecoveryContext,
    status: http::StatusCode,
    body: &[u8],
) -> bool {
    if !matches!(
        status,
        http::StatusCode::FORBIDDEN | http::StatusCode::TOO_MANY_REQUESTS
    ) {
        return false;
    }
    let body = String::from_utf8_lossy(body);
    let payload = terminal_error_payload(&body);
    if is_deferred_usage_limit("error", &payload) {
        finish_observed_turn(context, true);
    } else if is_retryable_usage_limit_payload(&payload) {
        if status == http::StatusCode::TOO_MANY_REQUESTS {
            record_proxy_usage_limit(context);
            schedule_turn_recovery(context.clone(), "upstream_usage_limit_response");
        } else {
            finish_observed_turn(context, true);
        }
    } else {
        return false;
    }
    true
}

fn record_proxy_usage_limit(context: &TurnRecoveryContext) {
    let Ok(mut states) = recovery_states().lock() else {
        return;
    };
    let Some(state) = states.get_mut(&context.desktop_thread_id) else {
        return;
    };
    let now = Instant::now();
    let Some(candidate) = UsageLimitCandidate::from_active_proxy_turn(state, context, now) else {
        return;
    };
    // The running request reached a terminal failure. Its Drop must retain
    // the click candidate independently of the automatic retry budget.
    state.phase = RecoveryPhase::Idle;
    state.usage_limit = Some(candidate);
    state.updated_at = now;
    persist_states(&mut states);
}

impl ObservedUsageLimitTurn {
    pub(crate) fn is_valid(&self) -> bool {
        valid_continuation_identifier(&self.thread_id)
            && valid_continuation_identifier(&self.turn_id)
            && self.model.as_deref().is_none_or(|model| {
                valid_continuation_identifier(model) && !model.eq_ignore_ascii_case("unknown")
            })
            && self.observed_at_ms > 0
    }
}

pub(crate) fn proxy_usage_limit_turns() -> Vec<ProxyUsageLimitTurn> {
    ensure_owner_ledger_loaded();
    recovery_states()
        .lock()
        .map(|states| states.proxy_usage_limit_turns())
        .unwrap_or_default()
}

pub(crate) fn replace_native_usage_limit_candidates(
    snapshot: Option<crate::codex_desktop::NativeUsageLimitSnapshot>,
) {
    ensure_owner_ledger_loaded();
    let Ok(mut states) = recovery_states().lock() else {
        return;
    };
    states.apply_native_usage_limit_snapshot(snapshot);
}

pub(crate) fn clear_native_usage_limit_candidates() {
    ensure_owner_ledger_loaded();
    let Ok(mut states) = recovery_states().lock() else {
        return;
    };
    states.clear_native_usage_limit_snapshot();
}

impl RecoveryStates {
    fn proxy_usage_limit_turns(&self) -> Vec<ProxyUsageLimitTurn> {
        let now = Instant::now();
        self.threads
            .values()
            .filter_map(|state| state.usage_limit.as_ref())
            .filter(|candidate| candidate.has_current_proxy_observation(now))
            .map(|candidate| ProxyUsageLimitTurn {
                thread_id: candidate.turn.thread_id.clone(),
                turn_id: candidate.turn.turn_id.clone(),
                observed_at_ms: candidate.turn.observed_at_ms,
            })
            .collect()
    }

    #[cfg(test)]
    fn replace_native_usage_limit_snapshot(
        &mut self,
        turns: Vec<ObservedUsageLimitTurn>,
        conflicting_thread_ids: Vec<String>,
        complete: bool,
    ) {
        self.apply_native_usage_limit_snapshot(Some(
            crate::codex_desktop::NativeUsageLimitSnapshot {
                candidates: turns,
                conflicting_thread_ids,
                complete,
                ..Default::default()
            },
        ));
    }

    fn apply_native_usage_limit_snapshot(
        &mut self,
        snapshot: Option<crate::codex_desktop::NativeUsageLimitSnapshot>,
    ) {
        let scan_was_verified = snapshot.is_some();
        let snapshot = snapshot.unwrap_or_default();
        merge_native_usage_limit_candidates(
            &mut self.threads,
            snapshot.candidates,
            snapshot.conflicting_thread_ids,
            snapshot.stale_proxy_turns,
            snapshot.complete,
        );
        self.native_usage_limit_scan = scan_was_verified.then(|| NativeUsageLimitScanReceipt {
            verified_at: Instant::now(),
            verified_at_ms: chrono::Utc::now().timestamp_millis(),
            complete: snapshot.complete,
        });
    }

    fn clear_native_usage_limit_snapshot(&mut self) {
        merge_native_usage_limit_candidates(
            &mut self.threads,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            true,
        );
        self.native_usage_limit_scan = None;
    }

    fn usage_limit_resume_count(&self) -> UsageLimitResumeCount {
        let scan = self
            .native_usage_limit_scan
            .as_ref()
            .filter(|scan| scan.verified_at.elapsed() <= NATIVE_USAGE_LIMIT_CONFIRMATION_TTL);
        UsageLimitResumeCount {
            count: self
                .threads
                .values()
                .filter_map(eligible_usage_limit_candidate)
                .count(),
            complete: scan.is_some_and(|scan| scan.complete),
            scan_verified_at_ms: scan.map(|scan| scan.verified_at_ms),
        }
    }
}

fn merge_native_usage_limit_candidates(
    states: &mut HashMap<String, RecoveryState>,
    turns: Vec<ObservedUsageLimitTurn>,
    conflicting_thread_ids: Vec<String>,
    stale_proxy_turns: Vec<ProxyUsageLimitTurn>,
    complete: bool,
) {
    let mut observed: HashMap<String, Option<ObservedUsageLimitTurn>> = HashMap::new();
    for turn in turns.into_iter().filter(ObservedUsageLimitTurn::is_valid) {
        observed
            .entry(turn.thread_id.clone())
            .and_modify(|previous| {
                // Renderer windows can overlap. Conflicting turn/model
                // bindings cannot pick an arbitrary winner for this thread.
                match previous {
                    Some(old) if old.turn_id == turn.turn_id => match (&old.model, &turn.model) {
                        (None, Some(_)) => *old = turn.clone(),
                        (Some(_), None) => {}
                        (left, right) if left == right => {
                            old.observed_at_ms = old.observed_at_ms.min(turn.observed_at_ms);
                        }
                        _ => *previous = None,
                    },
                    _ => *previous = None,
                }
            })
            .or_insert(Some(turn));
    }
    for thread_id in conflicting_thread_ids {
        // A reported conflict takes precedence over a positive observation
        // from another renderer during the same scan.
        observed.insert(thread_id, None);
    }
    let now = Instant::now();
    for stale in stale_proxy_turns {
        let Some(candidate) = states
            .get_mut(&stale.thread_id)
            .and_then(|state| state.usage_limit.as_mut())
            .filter(|candidate| {
                candidate.has_current_proxy_observation(now)
                    && candidate.turn.turn_id == stale.turn_id
                    && candidate.turn.observed_at_ms == stale.observed_at_ms
            })
        else {
            continue;
        };
        candidate.native_evidence = NativeUsageLimitEvidence::Displaced;
    }
    // A renderer can report the terminal usage-limit failure after CC Switch
    // has been restarted. The restored ledger may still describe the exact
    // request as active, which would otherwise block the native observation
    // forever. Reconcile only an exact, current tracked turn. A mismatched
    // turn, model, or action epoch must remain blocked by the normal guards.
    for turn in observed.values().filter_map(Option::as_ref) {
        if let Some(state) = states.get_mut(&turn.thread_id) {
            if native_terminal_turn_matches_active_state(state, turn) {
                reset_automatic_state(state, false);
            }
        }
    }
    let reconcile_candidate =
        |state: &mut RecoveryState, observation: Option<&Option<ObservedUsageLimitTurn>>| {
            let Some(candidate) = state.usage_limit.as_mut() else {
                return true;
            };
            let observed_turn = observation.and_then(Option::as_ref);
            if candidate.native_evidence == NativeUsageLimitEvidence::Displaced
                && !observed_turn.is_some_and(|turn| {
                    turn.turn_id != candidate.turn.turn_id
                        && turn.observed_at_ms > candidate.turn.observed_at_ms
                })
                && (observed_turn.is_some() || candidate.has_current_proxy_observation(now))
            {
                // A renderer still reporting the displaced turn cannot make it
                // eligible again. A proven newer failed turn can replace it.
                return true;
            }
            candidate.native_evidence = match observation {
                Some(Some(turn))
                    if turn.turn_id == candidate.turn.turn_id
                        && (turn.model == candidate.turn.model
                            || (turn.model.is_none() && candidate.proxy_observed_at.is_some())) =>
                {
                    NativeUsageLimitEvidence::Confirmed {
                        observed_at_ms: turn.observed_at_ms,
                        confirmed_at: now,
                    }
                }
                Some(native)
                    if candidate.proxy_observed_at.is_some()
                        && native
                            .as_ref()
                            .is_none_or(|turn| turn.turn_id == candidate.turn.turn_id) =>
                {
                    // Keep the proxy's binding while the renderer disagrees, so a
                    // later poll cannot reinsert the conflicting turn as native only.
                    NativeUsageLimitEvidence::Conflicting
                }
                _ if candidate.native_evidence == NativeUsageLimitEvidence::Conflicting
                    && !observation.and_then(Option::as_ref).is_some_and(|turn| {
                        turn.observed_at_ms > candidate.turn.observed_at_ms
                    }) =>
                {
                    // Missing evidence cannot restore a vetoed proxy failure.
                    // Keep the veto until a positive binding or proxy expiry.
                    NativeUsageLimitEvidence::Conflicting
                }
                _ => NativeUsageLimitEvidence::Absent,
            };
            if candidate.has_current_observation(now) {
                return true;
            }
            state.usage_limit = None;
            state.phase != RecoveryPhase::Idle
                || state.tracked.is_some()
                || !state.continuations.is_empty()
        };
    if complete {
        states.retain(|thread_id, state| reconcile_candidate(state, observed.get(thread_id)));
    } else {
        // Only an observed thread has enough evidence to change its binding
        // when the renderer could not enumerate every thread.
        for (thread_id, observation) in &observed {
            if states
                .get_mut(thread_id)
                .is_some_and(|state| !reconcile_candidate(state, Some(observation)))
            {
                states.remove(thread_id);
            }
        }
    }
    for (thread_id, turn) in observed
        .into_iter()
        .filter_map(|(id, turn)| Some((id, turn?)))
    {
        let state = states.entry(thread_id).or_default();
        if state.usage_limit.as_ref().is_some_and(|candidate| {
            candidate.native_evidence != NativeUsageLimitEvidence::Absent
                || candidate.turn.observed_at_ms >= turn.observed_at_ms
        }) || matches!(
            state.phase,
            RecoveryPhase::ActiveRequest | RecoveryPhase::ToolStepComplete
        ) || state.tracked.as_ref().is_some_and(|tracked| {
            tracked.observed_at_ms > turn.observed_at_ms
                || (state.phase == RecoveryPhase::AwaitingContinuation
                    && tracked.desktop_turn_id.as_deref() == Some(turn.turn_id.as_str()))
        }) {
            continue;
        }
        state.usage_limit = Some(UsageLimitCandidate {
            native_evidence: NativeUsageLimitEvidence::Confirmed {
                observed_at_ms: turn.observed_at_ms,
                confirmed_at: now,
            },
            turn,
            proxy_observed_at: None,
        });
    }
}

fn native_terminal_turn_matches_active_state(
    state: &RecoveryState,
    turn: &ObservedUsageLimitTurn,
) -> bool {
    if !matches!(
        state.phase,
        RecoveryPhase::ActiveRequest | RecoveryPhase::ToolStepComplete
    ) || state.tracked_epoch.as_deref() != Some(state.action_epoch.as_str())
    {
        return false;
    }
    let Some(tracked) = state.tracked.as_ref() else {
        return false;
    };
    tracked.desktop_thread_id == turn.thread_id
        && tracked.desktop_turn_id.as_deref() == Some(turn.turn_id.as_str())
        && turn
            .model
            .as_ref()
            .is_none_or(|model| model == &tracked.desktop_model)
}

fn eligible_usage_limit_candidate(state: &RecoveryState) -> Option<&UsageLimitCandidate> {
    let candidate = state.usage_limit.as_ref()?;
    if !candidate.has_current_evidence(Instant::now())
        || matches!(
            state.phase,
            RecoveryPhase::ActiveRequest
                | RecoveryPhase::ToolStepComplete
                | RecoveryPhase::CommittingRecovery
        )
        || state.continuations.len() >= MAX_OWNER_OPERATIONS_PER_THREAD
        || state.continuations.contains_key(&candidate.operation_id())
        || state.continuations.values().any(|operation| {
            operation.blocks_new_continuation(&state.action_epoch, Some(candidate))
        })
    {
        return None;
    }
    Some(candidate)
}

fn usage_limit_resume_states() -> Result<MutexGuard<'static, RecoveryStates>, String> {
    ensure_owner_ledger_loaded();
    if !RECOVERY_STORAGE_HEALTHY.load(Ordering::SeqCst) {
        return Err("Codex continuation evidence storage is unavailable".into());
    }
    recovery_states()
        .lock()
        .map_err(|_| "Codex continuation evidence storage is unavailable".into())
}

fn usage_limit_resume_snapshot(
) -> Result<Vec<(OwnerContinuationEpoch, UsageLimitCandidate)>, String> {
    Ok(usage_limit_resume_states()?
        .iter()
        .filter_map(|(thread_id, state)| {
            let candidate = eligible_usage_limit_candidate(state)?;
            Some((
                OwnerContinuationEpoch {
                    thread_id: thread_id.clone(),
                    process_epoch: native_continuation_process_epoch().to_owned(),
                    action_epoch: state.action_epoch.clone(),
                },
                candidate.clone(),
            ))
        })
        .collect())
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct UsageLimitResumeCount {
    count: usize,
    complete: bool,
    #[serde(rename = "scanVerifiedAtMs", skip_serializing_if = "Option::is_none")]
    scan_verified_at_ms: Option<i64>,
}

pub(crate) fn codex_usage_limit_resume_count() -> Result<UsageLimitResumeCount, String> {
    let (count, scan, changed) = {
        let mut states = usage_limit_resume_states()?;
        let count = states.usage_limit_resume_count();
        let scan = if count.complete {
            "complete"
        } else if count.scan_verified_at_ms.is_some() {
            "partial"
        } else {
            "unverified"
        };
        // Report the same projection that the ribbon reads. New timestamps
        // from unchanged polling results don't create additional log entries.
        let current = (count.count, scan);
        let changed = states.last_logged_usage_limit_count.replace(current) != Some(current);
        (count, scan, changed)
    };
    if changed {
        log::info!(
            "[Codex/Recovery] session count eligible={} scan={scan}",
            count.count
        );
    }
    Ok(count)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UsageLimitResumeOutcome {
    Submitted,
    Deferred,
    DesktopUnavailable(&'static str),
    Skipped,
    Uncertain,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimitResumeReport {
    submitted: usize,
    deferred: usize,
    desktop_unavailable: usize,
    skipped: usize,
    uncertain: usize,
}

impl UsageLimitResumeReport {
    fn record(&mut self, outcome: UsageLimitResumeOutcome) {
        match outcome {
            UsageLimitResumeOutcome::Submitted => self.submitted += 1,
            UsageLimitResumeOutcome::Deferred => self.deferred += 1,
            UsageLimitResumeOutcome::DesktopUnavailable(blocker) => {
                self.deferred += 1;
                self.desktop_unavailable += 1;
                log::warn!("[Codex/Recovery] usage-limit submission deferred: {blocker}");
            }
            UsageLimitResumeOutcome::Skipped => self.skipped += 1,
            UsageLimitResumeOutcome::Uncertain => self.uncertain += 1,
        }
    }
}

pub(crate) async fn resume_usage_limited_turns() -> Result<UsageLimitResumeReport, String> {
    static BATCH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _batch = BATCH
        .try_lock()
        .map_err(|_| "CC Switch is already sending continue to usage-limited Codex sessions")?;
    let candidates = usage_limit_resume_snapshot()?;
    let mut outcomes = futures::stream::iter(candidates)
        .map(|(epoch, candidate)| resume_usage_limited_turn(epoch, candidate))
        .buffer_unordered(4);
    let mut report = UsageLimitResumeReport::default();
    while let Some(outcome) = outcomes.next().await {
        report.record(outcome);
    }
    Ok(report)
}

async fn await_desktop_continuation<F: std::future::Future>(
    submit: F,
    preparation_deadline: tokio::time::Instant,
    commit_started: impl FnOnce() -> bool,
) -> Option<F::Output> {
    tokio::pin!(submit);
    tokio::select! {
        biased;
        _ = tokio::time::sleep_until(preparation_deadline) => {}
        result = &mut submit => return Some(result),
    }
    // Once authorized, only the already-polled submission can finish. Its
    // renderer has its own acknowledgement deadline.
    if commit_started() {
        tokio::time::timeout(crate::codex_desktop::CODEX_CONTINUATION_ACK_TIMEOUT, submit)
            .await
            .ok()
    } else {
        None
    }
}

async fn resume_usage_limited_turn(
    epoch: OwnerContinuationEpoch,
    candidate: UsageLimitCandidate,
) -> UsageLimitResumeOutcome {
    let turn = &candidate.turn;
    let operation = match reserve_continuation(
        &epoch,
        &turn.turn_id,
        &candidate.operation_id(),
        Some(&candidate),
    ) {
        Ok(OwnerContinuationReservation::Reserved(operation)) => operation,
        Err(OwnerContinuationError::Busy) => return UsageLimitResumeOutcome::Deferred,
        _ => return UsageLimitResumeOutcome::Skipped,
    };
    let renderer_operation_id = uuid::Uuid::new_v4().to_string();
    let (observed_at_ms, require_native_observation) = candidate.continuation_observation();
    let commit_started = AtomicBool::new(false);
    let result = await_desktop_continuation(
        crate::codex_desktop::submit_codex_usage_limit_continuation(
            &turn.thread_id,
            &renderer_operation_id,
            turn.model.as_deref(),
            observed_at_ms,
            &turn.turn_id,
            require_native_observation,
            |final_commit| {
                if !final_commit {
                    return owner_continuation_is_reserved(&operation);
                }
                let authorized =
                    authorize_continuation_commit(&operation, Some(&candidate), persist_states);
                if authorized {
                    commit_started.store(true, Ordering::Relaxed);
                }
                authorized
            },
        ),
        tokio::time::Instant::now() + DESKTOP_READY_TIMEOUT,
        || commit_started.load(Ordering::Relaxed),
    )
    .await;
    finish_usage_limit_resume(&operation, &candidate, result)
}

fn finish_usage_limit_resume(
    operation: &OwnerContinuationOperation,
    candidate: &UsageLimitCandidate,
    result: Option<Result<crate::codex_desktop::CodexContinuationResult, String>>,
) -> UsageLimitResumeOutcome {
    let blocker = match result.as_ref() {
        Some(Ok(result)) if !result.submitted => Some(desktop_readiness_blocker(&result.message)),
        Some(Err(error)) => Some(desktop_readiness_blocker(error)),
        _ => None,
    };
    let desktop_unavailable = blocker.filter(|blocker| {
        matches!(
            *blocker,
            "compatibility_runtime_unavailable"
                | "desktop_request_client_unavailable"
                | "desktop_command_timeout"
                | "desktop_connection_unavailable"
                | "desktop_target_unavailable"
        )
    });
    let (outcome, deferred) = match result {
        Some(Ok(result)) if result.submitted => (
            result
                .turn_id
                .map_or(OwnerContinuationOutcome::Uncertain, |turn_id| {
                    OwnerContinuationOutcome::Submitted { turn_id }
                }),
            false,
        ),
        Some(Ok(result)) if result.mutation_attempted => {
            (OwnerContinuationOutcome::Uncertain, false)
        }
        Some(Ok(result)) => (
            OwnerContinuationOutcome::Refused,
            result.usage_limit_deferred || desktop_unavailable.is_some(),
        ),
        // The journal distinguishes read-only preparation from an authorized
        // send when the transport stops yielding a result.
        Some(Err(_)) | None => (OwnerContinuationOutcome::Uncertain, true),
    };
    let receipt = finish_owner_continuation(operation, outcome);
    match receipt.status {
        OwnerContinuationStatus::Submitted => UsageLimitResumeOutcome::Submitted,
        OwnerContinuationStatus::Committing | OwnerContinuationStatus::Uncertain => {
            if let Some(blocker) = blocker {
                log::warn!("[Codex/Recovery] usage-limit submission unconfirmed: {blocker}");
            }
            UsageLimitResumeOutcome::Uncertain
        }
        OwnerContinuationStatus::Refused => {
            let Ok(mut states) = recovery_states().lock() else {
                return UsageLimitResumeOutcome::Skipped;
            };
            let Some(state) = states.get_mut(&operation.epoch.thread_id) else {
                return UsageLimitResumeOutcome::Skipped;
            };
            let current = state.action_epoch == operation.epoch.action_epoch
                && usage_limit_candidate_is_current(state, candidate);
            if deferred {
                if owner_operation_matches(state, operation)
                    && state.continuations[&operation.operation_id].status
                        == OwnerContinuationStatus::Refused
                {
                    state.continuations.remove(&operation.operation_id);
                    persist_states(&mut states);
                }
                return match (current, desktop_unavailable) {
                    (true, Some(blocker)) => UsageLimitResumeOutcome::DesktopUnavailable(blocker),
                    (true, None) => UsageLimitResumeOutcome::Deferred,
                    (false, _) => UsageLimitResumeOutcome::Skipped,
                };
            }
            if current {
                state.usage_limit = None;
            }
            UsageLimitResumeOutcome::Skipped
        }
        OwnerContinuationStatus::Reserved => UsageLimitResumeOutcome::Uncertain,
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
    {
        let binding = Arc::new(RecoveryProviderBinding::new(
            RECOVERY_DATABASE.get().cloned().unwrap_or_default(),
        ));
        let submit_binding = Arc::clone(&binding);
        tokio::spawn(run_turn_recovery(
            context,
            reason,
            next_attempt,
            move |context, next_attempt| {
                let submit_binding = Arc::clone(&submit_binding);
                async move {
                    let authorization_context = context.clone();
                    crate::codex_desktop::submit_codex_continuation(
                        &context.desktop_thread_id,
                        &format!("{}:{next_attempt}", context.recovery_id),
                        &context.desktop_model,
                        context.observed_at_ms,
                        move |final_commit| {
                            recovery_is_active(&authorization_context)
                                && recovery_binding_is_current(
                                    &submit_binding,
                                    &authorization_context,
                                    next_attempt,
                                )
                                && (!final_commit
                                    || authorize_reserved_recovery(&authorization_context))
                        },
                    )
                    .await
                }
            },
            move |context, next_attempt| {
                recovery_binding_is_current(&binding, context, next_attempt)
            },
        ));
    }
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
        let lease_current = recovery_states().lock().is_ok_and(|mut states| {
            refresh_recovery_lease(
                &mut states,
                context,
                RecoveryPhase::ReservedRecovery,
                Instant::now(),
            )
        });
        if !lease_current {
            cancel_reserved_recovery(context);
            let reason = if RECOVERY_STORAGE_HEALTHY.load(Ordering::SeqCst) {
                "turn_activity_changed"
            } else {
                "recovery_storage_unavailable"
            };
            log_recovery_event(context, "cancelled", reason, Some(next_attempt));
            return false;
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
        let result =
            await_desktop_continuation(submit(context.clone(), next_attempt), deadline, || {
                recovery_commit_started(&context)
            })
            .await;
        match result {
            None => {
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
            Some(result) => match result {
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

#[derive(Default)]
struct RecoverySseInspection {
    frame: Vec<u8>,
    evidence: NativeResponsesEvidence,
}

impl RecoverySseInspection {
    fn inspect_chunk(&mut self, chunk: &[u8]) -> Result<Option<RecoveryDecision>, ()> {
        // Inspect raw bytes up to one complete SSE frame at a time. This keeps
        // UTF-8 and LF/CRLF delimiters intact across transport chunk boundaries
        // without copying an arbitrarily large chunk into the frame buffer.
        for line in chunk.split_inclusive(|byte| *byte == b'\n') {
            if line.len() > MAX_RECOVERY_SSE_FRAME_BYTES.saturating_sub(self.frame.len()) {
                return Err(());
            }
            self.frame.extend_from_slice(line);
            let delimiter = if self.frame.ends_with(b"\r\n\r\n") {
                4
            } else if self.frame.ends_with(b"\n\n") {
                2
            } else {
                continue;
            };
            let parsed = parse_event(&String::from_utf8_lossy(
                &self.frame[..self.frame.len() - delimiter],
            ));
            self.frame.clear();
            let Some((event_name, payload)) = parsed else {
                continue;
            };
            self.evidence.observe_event(&event_name, &payload);
            if let Some(disposition) =
                classify_native_responses_terminal(&event_name, &payload, self.evidence)
            {
                return Ok(Some(recovery_decision(
                    disposition,
                    &event_name,
                    &payload,
                    self.evidence,
                )));
            }
        }
        Ok(None)
    }
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
        let mut inspection = Some(RecoverySseInspection::default());

        while let Some(item) = stream.next().await {
            if let Some(observer) = inspection.as_mut() {
                match &item {
                    Ok(chunk) => match observer.inspect_chunk(chunk) {
                        Ok(Some(decision)) => {
                            apply_recovery_decision(&context, decision);
                            inspection = None;
                        }
                        Ok(None) => {}
                        Err(()) => {
                            retire_uninspectable_stream(&context);
                            log_recovery_event(&context, "not_scheduled", "sse_frame_too_large", None);
                            inspection = None;
                        }
                    },
                    Err(_) if stream_interruption_is_recoverable(observer.evidence) => {
                        schedule_turn_recovery(context.clone(), "downstream_stream_error");
                        inspection = None;
                    }
                    Err(_) => {}
                }
            }
            yield item;
        }

        if inspection.is_some_and(|observer| stream_interruption_is_recoverable(observer.evidence)) {
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
        RecoveryDecision::UsageLimit(reason) => {
            record_proxy_usage_limit(context);
            schedule_turn_recovery(context.clone(), reason);
        }
        RecoveryDecision::DeferredUsageLimit => finish_observed_turn(context, true),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecoveryDecision {
    Complete,
    ToolStepComplete,
    Recover(&'static str),
    UsageLimit(&'static str),
    DeferredUsageLimit,
    Ignore,
}

fn recovery_decision(
    disposition: NativeResponsesTerminalDisposition,
    event_name: &str,
    payload: &Value,
    evidence: NativeResponsesEvidence,
) -> RecoveryDecision {
    let deferred = if matches!(disposition, NativeResponsesTerminalDisposition::Completed) {
        deferred_usage_limit_period(event_name, payload).is_some()
    } else {
        is_deferred_usage_limit(event_name, payload)
    };
    if deferred {
        return RecoveryDecision::DeferredUsageLimit;
    }

    let reason = match disposition {
        NativeResponsesTerminalDisposition::Completed if evidence.valid_tool_calls > 0 => {
            return RecoveryDecision::ToolStepComplete;
        }
        NativeResponsesTerminalDisposition::Completed => return RecoveryDecision::Complete,
        NativeResponsesTerminalDisposition::Incomplete => "response_incomplete",
        NativeResponsesTerminalDisposition::Failed => "response_failed",
        NativeResponsesTerminalDisposition::ProtocolError { .. } => "protocol_error",
    };
    if !terminal_is_recoverable(event_name, payload) {
        RecoveryDecision::Ignore
    } else if is_retryable_usage_limit_payload(payload) {
        RecoveryDecision::UsageLimit(reason)
    } else {
        RecoveryDecision::Recover(reason)
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
    let event_name = event_name
        .or_else(|| {
            payload
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .or_else(|| {
            // Responses-to-Chat adapters expose a failed Responses event as a
            // plain Chat error envelope. Preserve the terminal boundary for the
            // recovery observer without changing the client-facing payload.
            payload
                .get("error")
                .filter(|error| error.is_object())
                .map(|_| "response.failed".to_string())
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
            desktop_turn_id: None,
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

    fn exact_usage_limit_context(session_id: &str, budget: u32) -> TurnRecoveryContext {
        let mut turn = context(session_id, budget);
        turn.desktop_turn_id = Some(format!("{session_id}-turn"));
        turn
    }

    fn temporary_usage_limit_error() -> Value {
        serde_json::json!({
            "type": "usage_limit_reached",
            "message": "You've hit your usage limit. Try again later."
        })
    }

    #[tokio::test]
    async fn bulk_resume_snapshot_selects_exact_temporary_failures_from_http_and_sse() {
        use super::super::error::ProxyError;

        let http = exact_usage_limit_context("bulk-resume-http", 0);
        let sse = exact_usage_limit_context("bulk-resume-sse", 0);
        let pending = exact_usage_limit_context("bulk-resume-pending", 0);
        let cancelled = exact_usage_limit_context("bulk-resume-cancelled", 0);
        let hard_limit = exact_usage_limit_context("bulk-resume-quota", 0);
        let no_turn_id = context("bulk-resume-no-exact-turn", 0);
        let mut external = exact_usage_limit_context("bulk-resume-external", 0);
        external.desktop_eligible = false;
        let temporary = ProxyError::UpstreamError {
            status: 429,
            body: Some(serde_json::json!({"error": temporary_usage_limit_error()}).to_string()),
        };
        for turn in [&http, &no_turn_id, &external] {
            let tracking = track_turn(turn);
            handle_recovery_forward_error(turn.clone(), &temporary, "upstream_request_failed");
            drop(tracking);
        }

        let frame = serde_json::json!({
            "type": "response.failed",
            "response": {"status": "failed", "error": temporary_usage_limit_error()}
        });
        let terminal = Bytes::from(format!("event: response.failed\ndata: {frame}\n\n"));
        let events = futures::stream::iter([Ok::<_, std::io::Error>(terminal.clone())]);
        let output = observe_responses_turn_stream(events, sse.clone())
            .collect::<Vec<_>>()
            .await;
        assert_eq!(output[0].as_ref().unwrap(), &terminal);

        let pending_tracking = track_turn(&pending);
        let cancelled_tracking = track_turn(&cancelled);
        drop(cancelled_tracking);
        handle_recovery_forward_error(cancelled.clone(), &temporary, "late_error");
        let quota_tracking = track_turn(&hard_limit);
        handle_recovery_forward_error(
            hard_limit.clone(),
            &ProxyError::UpstreamError {
                status: 429,
                body: Some(
                    serde_json::json!({"error": {"type": "insufficient_quota", "message": "Quota exhausted"}})
                        .to_string(),
                ),
            },
            "upstream_request_failed",
        );
        drop(quota_tracking);

        let candidates = usage_limit_resume_snapshot().unwrap();
        for turn in [&http, &sse] {
            let candidate = &candidates
                .iter()
                .find(|(epoch, _)| epoch.thread_id == turn.desktop_thread_id)
                .unwrap()
                .1;
            assert_eq!(Some(&candidate.turn.turn_id), turn.desktop_turn_id.as_ref());
        }
        for turn in [&pending, &cancelled, &hard_limit, &no_turn_id, &external] {
            assert!(candidates
                .iter()
                .all(|(epoch, _)| epoch.thread_id != turn.desktop_thread_id));
        }
        drop(pending_tracking);
        for turn in [&http, &sse] {
            mark_turn_completed(&turn.desktop_thread_id);
        }
    }

    #[test]
    fn terminal_usage_limit_response_records_exact_active_proxy_turn() {
        let context = exact_usage_limit_context("response-boundary", 1);
        let tracking = track_turn(&context);
        assert!(observe_recovery_forward_response(
            &context,
            http::StatusCode::TOO_MANY_REQUESTS,
            br#"{"error":{"code":"usage_limit_reached","message":"Daily usage limit exceeded."}}"#,
        ));
        let candidate = proxy_usage_limit_turns()
            .into_iter()
            .find(|candidate| candidate.thread_id == context.desktop_thread_id);
        assert_eq!(
            candidate.map(|candidate| candidate.turn_id),
            context.desktop_turn_id
        );
        drop(tracking);
        mark_turn_completed(&context.desktop_thread_id);
    }

    #[test]
    fn terminal_usage_limit_response_ignores_generic_rate_limit_body() {
        let context = exact_usage_limit_context("response-boundary-generic", 1);
        let tracking = track_turn(&context);
        assert!(!observe_recovery_forward_response(
            &context,
            http::StatusCode::TOO_MANY_REQUESTS,
            br#"{"error":{"code":"rate_limit_exceeded","message":"Try again later."}}"#,
        ));
        assert!(!proxy_usage_limit_turns()
            .into_iter()
            .any(|candidate| candidate.thread_id == context.desktop_thread_id));
        drop(tracking);
        mark_turn_completed(&context.desktop_thread_id);
    }

    #[test]
    fn usage_limit_candidate_preserves_the_existing_automatic_budget_and_fences_old_clicks() {
        let context = exact_usage_limit_context("bulk-resume-aggressive", 1);
        let tracking = track_turn(&context);
        apply_recovery_decision(&context, RecoveryDecision::UsageLimit("response_failed"));
        drop(tracking);
        assert!(recovery_is_active(&context));
        let (epoch, candidate) = usage_limit_resume_snapshot()
            .unwrap()
            .into_iter()
            .find(|(epoch, _)| epoch.thread_id == context.desktop_thread_id)
            .unwrap();
        let OwnerContinuationReservation::Reserved(operation) = reserve_continuation(
            &epoch,
            &candidate.turn.turn_id,
            &candidate.operation_id(),
            Some(&candidate),
        )
        .unwrap() else {
            panic!("the explicit click should reserve the exact turn");
        };
        assert!(!recovery_is_active(&context));
        begin_turn(&context.desktop_thread_id, false);
        assert!(!authorize_continuation_commit(
            &operation,
            Some(&candidate),
            persist_states,
        ));
        assert_eq!(
            finish_usage_limit_resume(&operation, &candidate, None),
            UsageLimitResumeOutcome::Skipped,
        );
        cleanup_owner_test(&epoch);
    }

    #[test]
    fn bulk_resume_can_retry_after_native_confirmation_temporarily_conflicts() {
        let context = exact_usage_limit_context("bulk-resume-confirmation-conflict", 0);
        let tracking = track_turn(&context);
        record_proxy_usage_limit(&context);
        drop(tracking);
        let (epoch, candidate) = usage_limit_resume_snapshot()
            .unwrap()
            .into_iter()
            .find(|(epoch, _)| epoch.thread_id == context.desktop_thread_id)
            .unwrap();
        let OwnerContinuationReservation::Reserved(operation) = reserve_continuation(
            &epoch,
            &candidate.turn.turn_id,
            &candidate.operation_id(),
            Some(&candidate),
        )
        .unwrap() else {
            panic!("the first click should reserve");
        };
        recovery_states()
            .lock()
            .unwrap()
            .replace_native_usage_limit_snapshot(Vec::new(), vec![epoch.thread_id.clone()], false);
        assert!(!authorize_continuation_commit(
            &operation,
            Some(&candidate),
            persist_states,
        ));
        assert_eq!(
            finish_usage_limit_resume(
                &operation,
                &candidate,
                Some(Ok(crate::codex_desktop::CodexContinuationResult {
                    submitted: false,
                    mutation_attempted: false,
                    usage_limit_deferred: true,
                    turn_id: None,
                    debug_port: None,
                    target_id: None,
                    message: String::new(),
                })),
            ),
            UsageLimitResumeOutcome::Skipped,
        );
        recovery_states()
            .lock()
            .unwrap()
            .replace_native_usage_limit_snapshot(vec![candidate.turn.clone()], Vec::new(), false);
        let (_, confirmed) = usage_limit_resume_snapshot()
            .unwrap()
            .into_iter()
            .find(|(observed, _)| observed.thread_id == epoch.thread_id)
            .expect("fresh confirmation should make the turn eligible again");
        assert!(matches!(
            reserve_continuation(
                &epoch,
                &confirmed.turn.turn_id,
                &confirmed.operation_id(),
                Some(&confirmed),
            ),
            Ok(OwnerContinuationReservation::Reserved(_))
        ));
        cleanup_owner_test(&epoch);
    }

    #[test]
    fn bulk_resume_retries_preparation_after_timeout_and_fences_a_possible_send() {
        let context = exact_usage_limit_context("bulk-resume-timeout", 0);
        let tracking = track_turn(&context);
        record_proxy_usage_limit(&context);
        drop(tracking);
        let (epoch, candidate) = usage_limit_resume_snapshot()
            .unwrap()
            .into_iter()
            .find(|(epoch, _)| epoch.thread_id == context.desktop_thread_id)
            .unwrap();
        let reserve = || {
            reserve_continuation(
                &epoch,
                &candidate.turn.turn_id,
                &candidate.operation_id(),
                Some(&candidate),
            )
            .unwrap()
        };
        let OwnerContinuationReservation::Reserved(operation) = reserve() else {
            panic!("the first click should reserve");
        };
        assert!(matches!(
            reserve(),
            OwnerContinuationReservation::AttachOnly(_)
        ));
        assert_eq!(
            finish_usage_limit_resume(&operation, &candidate, None),
            UsageLimitResumeOutcome::Deferred,
        );
        let OwnerContinuationReservation::Reserved(retry) = reserve() else {
            panic!("an uncommitted timeout should leave the turn available");
        };
        assert!(authorize_continuation_commit(
            &retry,
            Some(&candidate),
            persist_states
        ));
        assert_eq!(
            finish_usage_limit_resume(&retry, &candidate, None),
            UsageLimitResumeOutcome::Uncertain,
        );
        let OwnerContinuationReservation::AttachOnly(receipt) = reserve() else {
            panic!("an unconfirmed send must retain its receipt");
        };
        assert_eq!(receipt.status, OwnerContinuationStatus::Uncertain);
        assert!(usage_limit_resume_snapshot()
            .unwrap()
            .iter()
            .all(|(observed, _)| observed.thread_id != epoch.thread_id));
        cleanup_owner_test(&epoch);
    }

    #[test]
    fn bulk_resume_reports_an_unavailable_desktop_only_before_a_possible_send() {
        let context = exact_usage_limit_context("bulk-resume-desktop-unavailable", 0);
        let tracking = track_turn(&context);
        record_proxy_usage_limit(&context);
        drop(tracking);
        let (epoch, candidate) = usage_limit_resume_snapshot()
            .unwrap()
            .into_iter()
            .find(|(epoch, _)| epoch.thread_id == context.desktop_thread_id)
            .unwrap();
        let reserve = || {
            reserve_continuation(
                &epoch,
                &candidate.turn.turn_id,
                &candidate.operation_id(),
                Some(&candidate),
            )
            .unwrap()
        };
        let unavailable = || Some(Err("port 9229: failed to list CDP targets: REDACTED".into()));
        let OwnerContinuationReservation::Reserved(operation) = reserve() else {
            panic!("the first click should reserve");
        };
        let deferred = finish_usage_limit_resume(&operation, &candidate, unavailable());
        assert_eq!(
            deferred,
            UsageLimitResumeOutcome::DesktopUnavailable("desktop_target_unavailable"),
        );

        let OwnerContinuationReservation::Reserved(retry) = reserve() else {
            panic!("a connection error before authorization should allow retry");
        };
        assert!(authorize_continuation_commit(
            &retry,
            Some(&candidate),
            persist_states,
        ));
        let uncertain = finish_usage_limit_resume(&retry, &candidate, unavailable());
        assert_eq!(uncertain, UsageLimitResumeOutcome::Uncertain);
        assert!(matches!(
            reserve(),
            OwnerContinuationReservation::AttachOnly(receipt)
                if receipt.status == OwnerContinuationStatus::Uncertain
        ));

        let mut report = UsageLimitResumeReport::default();
        report.record(deferred);
        report.record(uncertain);
        assert_eq!(
            serde_json::to_value(report).unwrap(),
            serde_json::json!({
                "submitted": 0,
                "deferred": 1,
                "desktopUnavailable": 1,
                "skipped": 0,
                "uncertain": 1,
            }),
        );
        cleanup_owner_test(&epoch);
    }

    #[test]
    fn native_snapshots_merge_matching_turns_and_require_current_evidence() {
        let turn = ObservedUsageLimitTurn {
            thread_id: "bulk-resume-overlapping-views".into(),
            turn_id: "matching-turn".into(),
            model: Some("gpt-test".into()),
            observed_at_ms: 100,
        };
        let mut duplicate = turn.clone();
        duplicate.observed_at_ms += 1;
        let mut states = HashMap::new();
        merge_native_usage_limit_candidates(
            &mut states,
            vec![duplicate, turn.clone()],
            Vec::new(),
            Vec::new(),
            true,
        );
        let state = &states[&turn.thread_id];
        assert_eq!(eligible_usage_limit_candidate(state).unwrap().turn, turn);

        let mut conflict = turn.clone();
        conflict.turn_id = "conflicting-turn".into();
        merge_native_usage_limit_candidates(
            &mut states,
            vec![turn.clone(), conflict],
            Vec::new(),
            Vec::new(),
            true,
        );
        assert!(!states.contains_key(&turn.thread_id));

        let proxy = UsageLimitCandidate {
            turn: turn.clone(),
            proxy_observed_at: Some(Instant::now() - RECOVERY_STATE_TTL - Duration::from_secs(1)),
            native_evidence: NativeUsageLimitEvidence::Absent,
        };
        let mut state = RecoveryState {
            usage_limit: Some(proxy),
            ..Default::default()
        };
        assert!(eligible_usage_limit_candidate(&state).is_none());
        state.updated_at = Instant::now();
        states.insert(turn.thread_id.clone(), state);
        merge_native_usage_limit_candidates(
            &mut states,
            vec![turn.clone()],
            Vec::new(),
            Vec::new(),
            true,
        );
        assert!(eligible_usage_limit_candidate(&states[&turn.thread_id]).is_some());
        merge_native_usage_limit_candidates(&mut states, Vec::new(), Vec::new(), Vec::new(), true);
        assert!(!states.contains_key(&turn.thread_id));
    }

    #[test]
    fn exact_native_terminal_turn_reconciles_a_restored_active_request() {
        let mut tracked = exact_usage_limit_context("native-restored-active", 3);
        tracked.desktop_turn_id = Some("native-restored-active-turn".into());
        let action_epoch = "current-action-epoch".to_string();
        let mut states = HashMap::from([(
            tracked.desktop_thread_id.clone(),
            RecoveryState {
                submitted: 2,
                phase: RecoveryPhase::ActiveRequest,
                tracked: Some(tracked.clone()),
                tracked_epoch: Some(action_epoch.clone()),
                action_epoch,
                ..RecoveryState::default()
            },
        )]);

        merge_native_usage_limit_candidates(
            &mut states,
            vec![ObservedUsageLimitTurn {
                thread_id: tracked.desktop_thread_id.clone(),
                turn_id: tracked.desktop_turn_id.clone().unwrap(),
                model: Some(tracked.desktop_model.clone()),
                observed_at_ms: tracked.observed_at_ms + 1,
            }],
            Vec::new(),
            Vec::new(),
            true,
        );

        let state = &states[&tracked.desktop_thread_id];
        assert_eq!(state.phase, RecoveryPhase::Idle);
        assert_eq!(state.submitted, 2);
        assert!(state.tracked.is_none());
        assert!(eligible_usage_limit_candidate(state).is_some());
    }

    #[test]
    fn mismatched_native_terminal_turn_does_not_clear_active_request() {
        let mut tracked = exact_usage_limit_context("native-mismatched-active", 3);
        tracked.desktop_turn_id = Some("tracked-turn".into());
        let action_epoch = "current-action-epoch".to_string();
        let mut states = HashMap::from([(
            tracked.desktop_thread_id.clone(),
            RecoveryState {
                phase: RecoveryPhase::ActiveRequest,
                tracked: Some(tracked.clone()),
                tracked_epoch: Some(action_epoch.clone()),
                action_epoch,
                ..RecoveryState::default()
            },
        )]);

        merge_native_usage_limit_candidates(
            &mut states,
            vec![ObservedUsageLimitTurn {
                thread_id: tracked.desktop_thread_id.clone(),
                turn_id: "different-turn".into(),
                model: Some(tracked.desktop_model.clone()),
                observed_at_ms: tracked.observed_at_ms + 1,
            }],
            Vec::new(),
            Vec::new(),
            true,
        );

        let state = &states[&tracked.desktop_thread_id];
        assert_eq!(state.phase, RecoveryPhase::ActiveRequest);
        assert!(state.usage_limit.is_none());
        assert!(eligible_usage_limit_candidate(state).is_none());
    }

    #[test]
    fn incomplete_native_snapshot_replaces_a_superseded_turn() {
        let turn = ObservedUsageLimitTurn {
            thread_id: "native-superseded-thread".into(),
            turn_id: "first-turn".into(),
            model: Some("gpt-test".into()),
            observed_at_ms: 100,
        };
        let newer = ObservedUsageLimitTurn {
            turn_id: "newer-turn".into(),
            observed_at_ms: 200,
            ..turn.clone()
        };
        let mut states = RecoveryStates::default();
        states.replace_native_usage_limit_snapshot(vec![turn.clone()], Vec::new(), true);
        let previous = eligible_usage_limit_candidate(&states[&turn.thread_id])
            .unwrap()
            .clone();

        states.replace_native_usage_limit_snapshot(vec![newer.clone()], Vec::new(), false);

        let count = states.usage_limit_resume_count();
        assert_eq!(count.count, 1);
        assert!(!count.complete);
        assert!(count.scan_verified_at_ms.is_some());
        let state = &states[&turn.thread_id];
        assert_eq!(eligible_usage_limit_candidate(state).unwrap().turn, newer);
        assert!(!usage_limit_candidate_is_current(state, &previous));
    }

    #[test]
    fn incomplete_native_snapshot_blocks_conflicting_observed_bindings() {
        let native = ObservedUsageLimitTurn {
            thread_id: "native-ambiguous-thread".into(),
            turn_id: "native-turn".into(),
            model: Some("gpt-test".into()),
            observed_at_ms: 100,
        };
        let proxy = ObservedUsageLimitTurn {
            thread_id: "proxy-conflicting-thread".into(),
            ..native.clone()
        };
        let native_conflict = ObservedUsageLimitTurn {
            turn_id: "different-turn".into(),
            ..native.clone()
        };
        let proxy_conflict = ObservedUsageLimitTurn {
            model: Some("different-model".into()),
            ..proxy.clone()
        };
        let mut states = RecoveryStates::default();
        states.replace_native_usage_limit_snapshot(vec![native.clone()], Vec::new(), true);
        states
            .entry(proxy.thread_id.clone())
            .or_default()
            .usage_limit = Some(UsageLimitCandidate {
            turn: proxy.clone(),
            proxy_observed_at: Some(Instant::now()),
            native_evidence: NativeUsageLimitEvidence::Absent,
        });

        states.replace_native_usage_limit_snapshot(
            vec![native.clone(), native_conflict, proxy_conflict],
            Vec::new(),
            false,
        );

        assert_eq!(
            states.usage_limit_resume_count(),
            UsageLimitResumeCount::default()
        );
        assert!(!states.contains_key(&native.thread_id));
        let proxy_candidate = states[&proxy.thread_id].usage_limit.as_ref().unwrap();
        assert_eq!(proxy_candidate.turn, proxy);
        assert_eq!(
            proxy_candidate.native_evidence,
            NativeUsageLimitEvidence::Conflicting
        );
    }

    #[test]
    fn incomplete_native_snapshot_applies_explicit_conflicts_to_reported_threads() {
        let native = ObservedUsageLimitTurn {
            thread_id: "native-explicit-conflict".into(),
            turn_id: "failed-turn".into(),
            model: Some("gpt-test".into()),
            observed_at_ms: 100,
        };
        let proxy = ObservedUsageLimitTurn {
            thread_id: "proxy-explicit-conflict".into(),
            ..native.clone()
        };
        let unrelated = ObservedUsageLimitTurn {
            thread_id: "native-unrelated-thread".into(),
            ..native.clone()
        };
        let mut states = RecoveryStates::default();
        states.replace_native_usage_limit_snapshot(
            vec![native.clone(), unrelated.clone()],
            Vec::new(),
            true,
        );
        let proxy_candidate = UsageLimitCandidate {
            turn: proxy.clone(),
            proxy_observed_at: Some(Instant::now()),
            native_evidence: NativeUsageLimitEvidence::Absent,
        };
        states
            .entry(proxy.thread_id.clone())
            .or_default()
            .usage_limit = Some(proxy_candidate.clone());
        assert_eq!(states.usage_limit_resume_count().count, 3);

        states.replace_native_usage_limit_snapshot(
            vec![native.clone()],
            vec![native.thread_id.clone(), proxy.thread_id.clone()],
            false,
        );

        let count = states.usage_limit_resume_count();
        assert_eq!(count.count, 1);
        assert!(!count.complete);
        assert!(count.scan_verified_at_ms.is_some());
        assert!(!states.contains_key(&native.thread_id));
        let proxy_state = &states[&proxy.thread_id];
        assert!(!usage_limit_candidate_is_current(
            proxy_state,
            &proxy_candidate
        ));
        let blocked_proxy = proxy_state.usage_limit.as_ref().unwrap();
        assert_eq!(blocked_proxy.turn, proxy);
        assert_eq!(
            blocked_proxy.proxy_observed_at,
            proxy_candidate.proxy_observed_at
        );
        assert_eq!(
            blocked_proxy.native_evidence,
            NativeUsageLimitEvidence::Conflicting
        );
        assert!(eligible_usage_limit_candidate(&states[&unrelated.thread_id]).is_some());
    }

    #[test]
    fn native_usage_limit_snapshots_accept_null_models_and_preserve_known_bindings() {
        let native: ObservedUsageLimitTurn = serde_json::from_value(serde_json::json!({
            "threadId": "native-null-model-thread",
            "turnId": "native-null-model-turn",
            "model": null,
            "observedAtMs": 100
        }))
        .unwrap();
        let known = ObservedUsageLimitTurn {
            model: Some("gpt-test".into()),
            observed_at_ms: 200,
            ..native.clone()
        };
        let mut states = RecoveryStates::default();
        let thread_id = native.thread_id.clone();
        states.replace_native_usage_limit_snapshot(
            vec![native.clone(), native.clone()],
            Vec::new(),
            true,
        );
        assert_eq!(states.usage_limit_resume_count().count, 1);
        assert_eq!(
            eligible_usage_limit_candidate(&states[&thread_id])
                .unwrap()
                .turn,
            native
        );

        for turns in [
            vec![native.clone(), known.clone()],
            vec![known.clone(), native.clone()],
        ] {
            states.replace_native_usage_limit_snapshot(turns, Vec::new(), true);
            assert_eq!(states.usage_limit_resume_count().count, 1);
            assert_eq!(
                eligible_usage_limit_candidate(&states[&thread_id])
                    .unwrap()
                    .turn,
                known
            );
            states.replace_native_usage_limit_snapshot(vec![native.clone()], Vec::new(), true);
            assert_eq!(
                eligible_usage_limit_candidate(&states[&thread_id])
                    .unwrap()
                    .turn,
                native
            );
        }

        let conflict = ObservedUsageLimitTurn {
            model: Some("other-model".into()),
            ..known.clone()
        };
        states.replace_native_usage_limit_snapshot(
            vec![known.clone(), native.clone(), conflict, native.clone()],
            Vec::new(),
            true,
        );
        assert_eq!(states.usage_limit_resume_count().count, 0);

        // The proxy binding keeps its model even when only the native source
        // can still confirm the failed turn.
        let state = states.entry(thread_id.clone()).or_default();
        state.usage_limit = Some(UsageLimitCandidate {
            turn: known.clone(),
            proxy_observed_at: Some(Instant::now() - RECOVERY_STATE_TTL - Duration::from_secs(1)),
            native_evidence: NativeUsageLimitEvidence::Absent,
        });
        states.replace_native_usage_limit_snapshot(vec![native.clone()], Vec::new(), true);
        assert_eq!(states.usage_limit_resume_count().count, 1);
        let candidate = eligible_usage_limit_candidate(&states[&thread_id]).unwrap();
        assert_eq!(candidate.turn, known);
        assert!(candidate.proxy_observed_at.is_some());
        assert_eq!(
            candidate.continuation_observation(),
            (native.observed_at_ms, true)
        );
        let pending = candidate.clone();

        let reobserved = ObservedUsageLimitTurn {
            observed_at_ms: native.observed_at_ms + 1,
            ..native
        };
        states.replace_native_usage_limit_snapshot(vec![reobserved.clone()], Vec::new(), true);
        let state = &states[&thread_id];
        let candidate = eligible_usage_limit_candidate(state).unwrap();
        assert_eq!(
            candidate.continuation_observation(),
            (reobserved.observed_at_ms, true)
        );
        assert!(!usage_limit_candidate_is_current(state, &pending));
    }

    #[test]
    fn conflicting_native_models_block_proxy_resume_until_bindings_agree() {
        let turn = ObservedUsageLimitTurn {
            thread_id: "proxy-native-conflict".into(),
            turn_id: "same-turn".into(),
            model: Some("proxy-model".into()),
            observed_at_ms: 100,
        };
        let conflicting = ObservedUsageLimitTurn {
            model: Some("other-model".into()),
            observed_at_ms: 200,
            ..turn.clone()
        };
        let mut states = RecoveryStates::default();
        let proxy = UsageLimitCandidate {
            turn: turn.clone(),
            proxy_observed_at: Some(Instant::now()),
            native_evidence: NativeUsageLimitEvidence::Absent,
        };
        states
            .entry(turn.thread_id.clone())
            .or_default()
            .usage_limit = Some(proxy.clone());
        assert_eq!(states.usage_limit_resume_count().count, 1);
        assert_eq!(
            proxy.continuation_observation(),
            (turn.observed_at_ms, false)
        );

        // A separate window may agree while another reports a conflicting
        // model. Neither a conflicting row nor conflicting windows can resume.
        for rows in [
            vec![conflicting.clone()],
            vec![turn.clone(), conflicting.clone()],
            vec![conflicting],
        ] {
            states.replace_native_usage_limit_snapshot(rows, Vec::new(), true);
            assert_eq!(states.usage_limit_resume_count().count, 0);
            assert!(!usage_limit_candidate_is_current(
                &states[&turn.thread_id],
                &proxy
            ));
        }

        states.replace_native_usage_limit_snapshot(vec![turn.clone()], Vec::new(), true);
        let candidate = eligible_usage_limit_candidate(&states[&turn.thread_id]).unwrap();
        assert_eq!(candidate.turn, turn);
        assert_eq!(
            candidate.continuation_observation(),
            (turn.observed_at_ms, true)
        );
    }

    #[test]
    fn usage_limit_count_preserves_completeness_when_candidates_change() {
        let mut states = RecoveryStates::default();
        assert_eq!(
            states.usage_limit_resume_count(),
            UsageLimitResumeCount::default()
        );
        states.replace_native_usage_limit_snapshot(Vec::new(), Vec::new(), true);
        let count = states.usage_limit_resume_count();
        assert_eq!(count.count, 0);
        assert!(count.complete);

        let turn = ObservedUsageLimitTurn {
            thread_id: "native-count-thread".into(),
            turn_id: "native-count-turn".into(),
            model: Some("gpt-test".into()),
            observed_at_ms: 100,
        };
        states.replace_native_usage_limit_snapshot(
            vec![turn.clone(), turn.clone()],
            Vec::new(),
            true,
        );
        let count = states.usage_limit_resume_count();
        assert_eq!(count.count, 1);
        assert!(count.complete);

        let thread_id = turn.thread_id.clone();
        let confirmed_observation = eligible_usage_limit_candidate(&states[&thread_id])
            .unwrap()
            .continuation_observation();
        states.replace_native_usage_limit_snapshot(vec![turn.clone()], Vec::new(), false);
        let count = states.usage_limit_resume_count();
        assert_eq!(count.count, 1);
        assert!(!count.complete);
        assert!(count.scan_verified_at_ms.is_some());
        assert_eq!(
            eligible_usage_limit_candidate(&states[&thread_id])
                .unwrap()
                .continuation_observation(),
            confirmed_observation
        );

        states.replace_native_usage_limit_snapshot(Vec::new(), Vec::new(), false);
        let count = states.usage_limit_resume_count();
        assert_eq!(count.count, 1);
        assert!(!count.complete);
        assert!(count.scan_verified_at_ms.is_some());
        assert!(states.threads.contains_key(&thread_id));
        assert_eq!(
            eligible_usage_limit_candidate(&states[&thread_id])
                .unwrap()
                .continuation_observation(),
            confirmed_observation
        );

        // A new action invalidates the last confirmed candidate between scans.
        states.replace_native_usage_limit_snapshot(vec![turn], Vec::new(), false);
        advance_action_epoch(states.get_mut(&thread_id).unwrap());
        let count = states.usage_limit_resume_count();
        assert_eq!(count.count, 0);
        assert!(!count.complete);
        assert!(count.scan_verified_at_ms.is_some());

        states.replace_native_usage_limit_snapshot(Vec::new(), Vec::new(), true);
        let count = states.usage_limit_resume_count();
        assert_eq!(count.count, 0);
        assert!(count.complete);
    }

    #[test]
    fn usage_limit_count_identifies_current_verified_scans_even_when_partial() {
        let mut states = RecoveryStates::default();
        let before_publish_ms = chrono::Utc::now().timestamp_millis();
        for complete in [true, false] {
            states.replace_native_usage_limit_snapshot(Vec::new(), Vec::new(), complete);
            let count = states.usage_limit_resume_count();
            let verified_at_ms = count.scan_verified_at_ms.unwrap();
            assert!(verified_at_ms >= before_publish_ms);
            assert_eq!(
                serde_json::to_value(count).unwrap(),
                serde_json::json!({"count": 0, "complete": complete, "scanVerifiedAtMs": verified_at_ms})
            );

            states.native_usage_limit_scan.as_mut().unwrap().verified_at =
                Instant::now() - NATIVE_USAGE_LIMIT_CONFIRMATION_TTL - Duration::from_secs(1);
            assert_eq!(
                states.usage_limit_resume_count(),
                UsageLimitResumeCount::default()
            );
        }

        states.replace_native_usage_limit_snapshot(Vec::new(), Vec::new(), true);
        states.apply_native_usage_limit_snapshot(None);
        assert_eq!(
            serde_json::to_value(states.usage_limit_resume_count()).unwrap(),
            serde_json::json!({"count": 0, "complete": false})
        );
    }

    #[test]
    fn usage_limit_count_keeps_eligible_proxy_evidence_when_native_observation_is_unavailable() {
        let turn = ObservedUsageLimitTurn {
            thread_id: "proxy-count-thread".into(),
            turn_id: "proxy-count-turn".into(),
            model: Some("gpt-test".into()),
            observed_at_ms: 200,
        };
        let mut states = RecoveryStates::default();
        let state = states.entry(turn.thread_id.clone()).or_default();
        state.usage_limit = Some(UsageLimitCandidate {
            turn: turn.clone(),
            proxy_observed_at: Some(Instant::now()),
            native_evidence: NativeUsageLimitEvidence::Absent,
        });
        assert_eq!(
            states.usage_limit_resume_count(),
            UsageLimitResumeCount {
                count: 1,
                ..Default::default()
            }
        );

        states.replace_native_usage_limit_snapshot(vec![turn.clone()], Vec::new(), true);
        let count = states.usage_limit_resume_count();
        assert_eq!(count.count, 1);
        assert!(count.complete);

        states.apply_native_usage_limit_snapshot(None);
        assert_eq!(
            states.usage_limit_resume_count(),
            UsageLimitResumeCount {
                count: 1,
                ..Default::default()
            }
        );

        let state = states.get_mut(&turn.thread_id).unwrap();
        state.usage_limit.as_mut().unwrap().native_evidence = NativeUsageLimitEvidence::Confirmed {
            observed_at_ms: turn.observed_at_ms,
            confirmed_at: Instant::now()
                - NATIVE_USAGE_LIMIT_CONFIRMATION_TTL
                - Duration::from_secs(1),
        };
        let candidate = eligible_usage_limit_candidate(state).unwrap();
        assert_eq!(
            candidate.continuation_observation(),
            (turn.observed_at_ms, false)
        );

        advance_action_epoch(states.get_mut(&turn.thread_id).unwrap());
        assert_eq!(
            states.usage_limit_resume_count(),
            UsageLimitResumeCount::default()
        );
    }

    #[test]
    fn usage_limit_count_does_not_revive_vetoed_proxy_turn_on_quiet_scans() {
        let turn = ObservedUsageLimitTurn {
            thread_id: "vetoed-proxy-thread".into(),
            turn_id: "failed-proxy-turn".into(),
            model: Some("gpt-test".into()),
            observed_at_ms: 200,
        };
        let mut states = RecoveryStates::default();
        let candidate = UsageLimitCandidate {
            turn: turn.clone(),
            proxy_observed_at: Some(Instant::now()),
            native_evidence: NativeUsageLimitEvidence::Absent,
        };
        states
            .entry(turn.thread_id.clone())
            .or_default()
            .usage_limit = Some(candidate.clone());
        states.replace_native_usage_limit_snapshot(vec![turn.clone()], Vec::new(), true);
        assert_eq!(states.usage_limit_resume_count().count, 1);

        states.replace_native_usage_limit_snapshot(Vec::new(), vec![turn.thread_id.clone()], false);
        assert_eq!(states.usage_limit_resume_count().count, 0);

        states.replace_native_usage_limit_snapshot(Vec::new(), Vec::new(), true);
        assert_eq!(states.usage_limit_resume_count().count, 0);
        assert!(!usage_limit_candidate_is_current(
            &states[&turn.thread_id],
            &candidate
        ));

        states.clear_native_usage_limit_snapshot();
        assert_eq!(
            states.usage_limit_resume_count(),
            UsageLimitResumeCount::default()
        );

        states.replace_native_usage_limit_snapshot(vec![turn.clone()], Vec::new(), true);
        assert_eq!(states.usage_limit_resume_count().count, 1);
        assert!(usage_limit_candidate_is_current(
            &states[&turn.thread_id],
            &candidate
        ));
    }

    #[test]
    fn usage_limit_count_vetoes_only_the_exact_proxy_observation() {
        let turn = ObservedUsageLimitTurn {
            thread_id: "proxy-observation-thread".into(),
            turn_id: "proxy-observation-turn".into(),
            model: None,
            observed_at_ms: 200,
        };
        let mut states = RecoveryStates::default();
        let proxy = UsageLimitCandidate {
            turn: turn.clone(),
            proxy_observed_at: Some(Instant::now()),
            native_evidence: NativeUsageLimitEvidence::Absent,
        };
        states
            .entry(turn.thread_id.clone())
            .or_default()
            .usage_limit = Some(proxy.clone());
        let mut unrelated = proxy.clone();
        unrelated.turn.thread_id = "unrelated-proxy-thread".into();
        let unrelated_state = states.entry(unrelated.turn.thread_id.clone()).or_default();
        unrelated_state.usage_limit = Some(unrelated);
        let mut watched = states.proxy_usage_limit_turns();
        watched.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
        assert_eq!(watched.len(), 2);
        let observed = watched.remove(0);
        assert_eq!(observed.thread_id, turn.thread_id);

        for stale in [
            ProxyUsageLimitTurn {
                turn_id: "older-turn".into(),
                ..observed.clone()
            },
            ProxyUsageLimitTurn {
                observed_at_ms: 100,
                ..observed.clone()
            },
        ] {
            states.apply_native_usage_limit_snapshot(Some(
                crate::codex_desktop::NativeUsageLimitSnapshot {
                    stale_proxy_turns: vec![stale],
                    ..Default::default()
                },
            ));
            assert_eq!(states.usage_limit_resume_count().count, 2);
        }

        states.apply_native_usage_limit_snapshot(Some(
            crate::codex_desktop::NativeUsageLimitSnapshot {
                candidates: vec![turn.clone()],
                stale_proxy_turns: vec![observed],
                complete: true,
                ..Default::default()
            },
        ));
        assert_eq!(states.usage_limit_resume_count().count, 1);
        assert!(!usage_limit_candidate_is_current(
            &states[&turn.thread_id],
            &proxy
        ));

        states.replace_native_usage_limit_snapshot(Vec::new(), Vec::new(), true);
        assert_eq!(states.usage_limit_resume_count().count, 1);
        for complete in [false, true] {
            // The window that disproved this failure can disappear while an
            // older renderer continues to report it.
            states.replace_native_usage_limit_snapshot(vec![turn.clone()], Vec::new(), complete);
            assert_eq!(states.usage_limit_resume_count().count, 1);
            assert!(!usage_limit_candidate_is_current(
                &states[&turn.thread_id],
                &proxy
            ));
        }
        let replacement = ObservedUsageLimitTurn {
            turn_id: "replacement-failed-turn".into(),
            observed_at_ms: 300,
            ..turn
        };
        states.replace_native_usage_limit_snapshot(vec![replacement.clone()], Vec::new(), true);
        assert_eq!(states.usage_limit_resume_count().count, 2);
        assert_eq!(
            eligible_usage_limit_candidate(&states[&replacement.thread_id])
                .unwrap()
                .turn,
            replacement
        );
    }

    #[test]
    fn stale_native_confirmations_do_not_keep_the_count_actionable() {
        let turn = ObservedUsageLimitTurn {
            thread_id: "native-stale-thread".into(),
            turn_id: "native-stale-turn".into(),
            model: None,
            observed_at_ms: 300,
        };
        let mut states = RecoveryStates::default();
        states.replace_native_usage_limit_snapshot(vec![turn.clone()], Vec::new(), true);

        let stale_at =
            Instant::now() - NATIVE_USAGE_LIMIT_CONFIRMATION_TTL - Duration::from_secs(1);
        states.native_usage_limit_scan.as_mut().unwrap().verified_at = stale_at;
        let candidate = states
            .get_mut(&turn.thread_id)
            .unwrap()
            .usage_limit
            .as_mut()
            .unwrap();
        candidate.native_evidence = NativeUsageLimitEvidence::Confirmed {
            observed_at_ms: turn.observed_at_ms,
            confirmed_at: stale_at,
        };
        let previous_confirmation = candidate.clone();

        assert_eq!(
            states.usage_limit_resume_count(),
            UsageLimitResumeCount::default()
        );
        assert!(!usage_limit_candidate_is_current(
            &states[&turn.thread_id],
            &previous_confirmation
        ));

        states.replace_native_usage_limit_snapshot(Vec::new(), Vec::new(), false);
        let count = states.usage_limit_resume_count();
        assert_eq!(count.count, 0);
        assert!(!count.complete);
        assert!(count.scan_verified_at_ms.is_some());

        states.replace_native_usage_limit_snapshot(vec![turn.clone()], Vec::new(), false);
        let count = states.usage_limit_resume_count();
        assert_eq!(count.count, 1);
        assert!(!count.complete);
        assert!(count.scan_verified_at_ms.is_some());
        assert!(usage_limit_candidate_is_current(
            &states[&turn.thread_id],
            &previous_confirmation
        ));
    }

    #[test]
    fn clearing_native_usage_limit_snapshot_removes_native_only_rows() {
        let turn = ObservedUsageLimitTurn {
            thread_id: "native-clear-thread".into(),
            turn_id: "native-clear-turn".into(),
            model: Some("gpt-test".into()),
            observed_at_ms: 300,
        };
        let mut states = RecoveryStates::default();
        states.replace_native_usage_limit_snapshot(vec![turn], Vec::new(), true);
        let count = states.usage_limit_resume_count();
        assert_eq!(count.count, 1);
        assert!(count.complete);

        states.clear_native_usage_limit_snapshot();
        assert_eq!(
            states.usage_limit_resume_count(),
            UsageLimitResumeCount::default()
        );
        assert!(states.threads.is_empty());
    }

    #[test]
    fn distinct_native_failure_can_resume_in_the_same_proxy_epoch() {
        for outcome in [
            OwnerContinuationOutcome::Submitted {
                turn_id: "next-turn".into(),
            },
            OwnerContinuationOutcome::Uncertain,
        ] {
            let (epoch, prior) = owner_test_operation("repeat-native-usage-limit");
            let candidate = UsageLimitCandidate {
                turn: ObservedUsageLimitTurn {
                    thread_id: epoch.thread_id.clone(),
                    turn_id: "next-turn".into(),
                    model: Some("gpt-test".into()),
                    observed_at_ms: 100,
                },
                proxy_observed_at: None,
                native_evidence: NativeUsageLimitEvidence::Confirmed {
                    observed_at_ms: 100,
                    confirmed_at: Instant::now(),
                },
            };
            let set_candidate = |candidate: &UsageLimitCandidate| {
                recovery_states()
                    .lock()
                    .unwrap()
                    .get_mut(&epoch.thread_id)
                    .unwrap()
                    .usage_limit = Some(candidate.clone());
            };
            let is_eligible = || {
                eligible_usage_limit_candidate(&recovery_states().lock().unwrap()[&epoch.thread_id])
                    .is_some()
            };
            set_candidate(&candidate);
            assert!(
                !is_eligible(),
                "an in-flight reservation blocks another send"
            );
            assert!(authorize_owner_continuation_commit(&prior));
            assert!(!is_eligible(), "an in-flight commit blocks another send");
            let prior_receipt = finish_owner_continuation(&prior, outcome);

            let mut same_turn = candidate.clone();
            same_turn.turn.turn_id = "base-turn".into();
            set_candidate(&same_turn);
            assert!(
                !is_eligible(),
                "the original failed turn cannot be replayed"
            );
            let OwnerContinuationReservation::AttachOnly(receipt) = reserve_continuation(
                &epoch,
                &same_turn.turn.turn_id,
                &same_turn.operation_id(),
                Some(&same_turn),
            )
            .unwrap() else {
                panic!("the original failed turn must keep its receipt");
            };
            assert_eq!(receipt.operation_id, prior_receipt.operation_id);

            set_candidate(&candidate);
            assert!(is_eligible(), "a different observed failed turn can resume");
            assert!(matches!(
                reserve_continuation(
                    &epoch,
                    &candidate.turn.turn_id,
                    &candidate.operation_id(),
                    Some(&candidate),
                ),
                Ok(OwnerContinuationReservation::Reserved(_))
            ));
            cleanup_owner_test(&epoch);
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
    fn owner_reserved_startup_is_discarded_and_committing_startup_is_uncertain_never_replayed() {
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
            if commit {
                let restored = &states[&epoch.thread_id];
                assert_eq!(restored.phase, RecoveryPhase::Idle);
                assert_eq!(
                    restored.continuations[&operation.operation_id].status,
                    OwnerContinuationStatus::Uncertain
                );
                assert!(restored.tracked.is_none());
            } else {
                assert!(!states.contains_key(&epoch.thread_id));
            }
            drop(states);
            cleanup_owner_test(&epoch);
        }
    }

    #[test]
    fn imported_reserved_owner_operation_allows_fresh_native_observation() {
        let context = exact_usage_limit_context("restart-reserved-native", 0);
        let epoch = capture_owner_continuation_epoch(&context.desktop_thread_id).unwrap();
        let turn = ObservedUsageLimitTurn {
            thread_id: context.desktop_thread_id.clone(),
            turn_id: context.desktop_turn_id.clone().unwrap(),
            model: Some(context.desktop_model.clone()),
            observed_at_ms: context.observed_at_ms,
        };
        let candidate = UsageLimitCandidate {
            turn: turn.clone(),
            proxy_observed_at: None,
            native_evidence: NativeUsageLimitEvidence::Confirmed {
                observed_at_ms: turn.observed_at_ms,
                confirmed_at: Instant::now(),
            },
        };
        let operation_id = candidate.operation_id();
        let reservation =
            reserve_continuation(&epoch, &candidate.turn.turn_id, &operation_id, None).unwrap();
        assert!(matches!(
            reservation,
            OwnerContinuationReservation::Reserved(_)
        ));

        let state = recovery_states()
            .lock()
            .unwrap()
            .remove(&epoch.thread_id)
            .unwrap();
        let ledger = ledger_from_states(&HashMap::from([(epoch.thread_id.clone(), state)]));
        import_owner_continuations(&ledger);
        assert!(!recovery_states()
            .lock()
            .unwrap()
            .contains_key(&epoch.thread_id));

        let mut states = recovery_states().lock().unwrap();
        states.replace_native_usage_limit_snapshot(vec![turn], Vec::new(), true);
        drop(states);
        let (fresh_epoch, fresh_candidate) = usage_limit_resume_snapshot()
            .unwrap()
            .into_iter()
            .find(|(_, candidate)| candidate.turn.thread_id == context.desktop_thread_id)
            .expect("fresh native observation should remain eligible after restart");
        assert_eq!(fresh_candidate.operation_id(), operation_id);
        assert!(matches!(
            reserve_continuation(
                &fresh_epoch,
                &fresh_candidate.turn.turn_id,
                &fresh_candidate.operation_id(),
                Some(&fresh_candidate),
            ),
            Ok(OwnerContinuationReservation::Reserved(_))
        ));
        cleanup_owner_test(&epoch);
    }

    #[test]
    #[serial_test::serial]
    fn restore_skips_unsubmitted_reserved_only_turn_for_fresh_native_observation() {
        let _home = crate::config::TestHomeGuard::new();
        let database = crate::database::Database::memory().unwrap();
        let provider = crate::provider::Provider::with_id(
            "restore-reserved-only-provider".into(),
            "test".into(),
            serde_json::json!({"baseUrl":"https://example.test"}),
            None,
        );
        database.save_provider("codex", &provider).unwrap();

        let mut context = exact_usage_limit_context(
            &format!("restore-reserved-only-{}", uuid::Uuid::new_v4()),
            0,
        );
        context.durable_provider_id = provider.id.clone();
        context.provider_fingerprint = provider_fingerprint(&provider);
        let tracking = track_turn(&context);
        record_proxy_usage_limit(&context);
        drop(tracking);
        let epoch = capture_owner_continuation_epoch(&context.desktop_thread_id).unwrap();
        let (_, candidate) = usage_limit_resume_snapshot()
            .unwrap()
            .into_iter()
            .find(|(_, candidate)| candidate.turn.thread_id == context.desktop_thread_id)
            .expect("the proxy failure should create a usage-limit candidate");
        let operation_id = candidate.operation_id();
        let OwnerContinuationReservation::Reserved(operation) = reserve_continuation(
            &epoch,
            &candidate.turn.turn_id,
            &operation_id,
            Some(&candidate),
        )
        .unwrap() else {
            panic!("the owner operation must begin as a reservation");
        };
        let state = recovery_states()
            .lock()
            .unwrap()
            .remove(&context.desktop_thread_id)
            .unwrap();
        let ledger =
            ledger_from_states(&HashMap::from([(context.desktop_thread_id.clone(), state)]));
        assert_eq!(ledger.turns.len(), 1);
        assert_eq!(ledger.turns[0].submitted, 0);
        assert_eq!(ledger.turns[0].phase, RecoveryPhase::AwaitingContinuation);
        assert!(should_skip_reserved_only_turn(
            ledger.turns.last().unwrap(),
            &ledger.continuations,
        ));
        let submitted_turn = PersistedTurn {
            context: context.clone(),
            submitted: 1,
            phase: RecoveryPhase::AwaitingContinuation,
            commit_charged: false,
        };
        assert!(!should_skip_reserved_only_turn(
            &submitted_turn,
            &ledger.continuations,
        ));
        let mut newer_turn = submitted_turn;
        newer_turn.submitted = 0;
        newer_turn.context.desktop_turn_id = Some("newer-turn-after-reservation".into());
        assert!(!should_skip_reserved_only_turn(
            &newer_turn,
            &ledger.continuations,
        ));
        import_owner_continuations(&ledger);
        restore_ledger(Some(ledger), 0, &database);

        let turn = ObservedUsageLimitTurn {
            thread_id: context.desktop_thread_id.clone(),
            turn_id: context.desktop_turn_id.clone().unwrap(),
            model: Some(context.desktop_model.clone()),
            observed_at_ms: context.observed_at_ms,
        };
        recovery_states()
            .lock()
            .unwrap()
            .replace_native_usage_limit_snapshot(vec![turn], Vec::new(), true);
        let (_, candidate) = usage_limit_resume_snapshot()
            .unwrap()
            .into_iter()
            .find(|(_, candidate)| candidate.turn.thread_id == context.desktop_thread_id)
            .expect("fresh native observation should remain eligible after restore");
        assert_eq!(candidate.operation_id(), operation_id);
        drop(operation);
        cleanup_owner_test(&epoch);
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
                    usage_limit_deferred: false,
                    turn_id: None,
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
    #[serial_test::serial]
    async fn third_backoff_heartbeats_the_canonical_lease_before_unrelated_pruning() {
        let mut pending = context("third-backoff-lease", 3);
        for attempt in 1..=2 {
            assert_eq!(reserve_recovery(&pending), Some(attempt));
            assert!(authorize_reserved_recovery(&pending));
            assert_eq!(finish_reserved_recovery(&pending, true), attempt);
            observe_next_continuation(&mut pending).hand_off_to_stream();
        }
        assert_eq!(reserve_recovery(&pending), Some(3));
        RECOVERY_PERSIST_CALLS.with(|calls| calls.set(0));
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
        assert_eq!(
            RECOVERY_PERSIST_CALLS.with(std::cell::Cell::get),
            0,
            "lease heartbeats must not persist the complete recovery ledger"
        );
        let unrelated = context("third-backoff-unrelated-reservation", 1);
        assert_eq!(reserve_recovery(&unrelated), Some(1));
        assert!(recovery_is_active(&pending));
        drop(wait);
        mark_turn_completed(&pending.desktop_thread_id);
        mark_turn_completed(&unrelated.desktop_thread_id);
    }

    #[test]
    fn long_recovery_leases_share_durable_checkpoints_inside_the_startup_ttl() {
        let started = Instant::now();
        let pending = context("checkpoint-reserved", 3);
        let streaming = context("checkpoint-streaming", 3);
        let mut states = RecoveryStates::default();
        for (context, phase) in [
            (&pending, RecoveryPhase::ReservedRecovery),
            (&streaming, RecoveryPhase::ActiveRequest),
        ] {
            states.insert(
                context.desktop_thread_id.clone(),
                RecoveryState {
                    tracked: Some(context.clone()),
                    phase,
                    updated_at: started,
                    ..RecoveryState::default()
                },
            );
        }

        RECOVERY_PERSIST_CALLS.with(|calls| calls.set(0));
        assert!(persist_states_at(&mut states, started));
        for second in (5..=continuation_backoff(3).as_secs()).step_by(5) {
            let now = started + Duration::from_secs(second);
            assert!(refresh_recovery_lease(
                &mut states,
                &pending,
                RecoveryPhase::ReservedRecovery,
                now,
            ));
            if second % 30 == 0 {
                assert!(refresh_recovery_lease(
                    &mut states,
                    &streaming,
                    RecoveryPhase::ActiveRequest,
                    now,
                ));
            }
            assert!(now.duration_since(states.last_persisted_at.unwrap()) < RECOVERY_STATE_TTL);
        }
        assert_eq!(RECOVERY_PERSIST_CALLS.with(std::cell::Cell::get), 3);
        assert_eq!(
            states.last_persisted_at,
            Some(started + continuation_backoff(3))
        );
        assert_eq!(ledger_from_states(&states).turns.len(), 2);
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
    fn transformed_chat_error_envelope_retains_response_failed_boundary() {
        let parsed = parse_event(
            "data: {\"error\":{\"message\":\"response failed as text\",\"type\":\"upstream_error\"}}",
        )
        .expect("transformed Chat error envelope should parse");

        assert_eq!(parsed.0, "response.failed");
        assert_eq!(parsed.1["error"]["message"], "response failed as text");
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
    async fn hanging_desktop_submission_has_a_bounded_acknowledgement_and_consumes_attempt() {
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
            continuation_backoff(1)
                + DESKTOP_READY_TIMEOUT
                + crate::codex_desktop::CODEX_CONTINUATION_ACK_TIMEOUT
        );
        assert!(!recovery_is_active(&context));
        assert_eq!(reserve_recovery(&context), None);
        mark_turn_completed(&context.desktop_thread_id);
    }

    #[tokio::test(start_paused = true)]
    async fn late_desktop_commit_keeps_its_acknowledgement_window() {
        let commit_started = AtomicBool::new(false);
        let readiness_deadline = tokio::time::Instant::now() + DESKTOP_READY_TIMEOUT;
        let result = await_desktop_continuation(
            async {
                tokio::time::sleep_until(readiness_deadline - Duration::from_secs(1)).await;
                commit_started.store(true, Ordering::Relaxed);
                tokio::time::sleep(Duration::from_secs(2)).await;
                "new-turn-id"
            },
            readiness_deadline,
            || commit_started.load(Ordering::Relaxed),
        )
        .await;
        assert_eq!(result, Some("new-turn-id"));
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
                    usage_limit_deferred: false,
                    turn_id: None,
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
                            usage_limit_deferred: false,
                            turn_id: None,
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
                    usage_limit_deferred: false,
                    turn_id: None,
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
                    usage_limit_deferred: false,
                    turn_id: None,
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
                    usage_limit_deferred: false,
                    turn_id: None,
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
                        usage_limit_deferred: false,
                        turn_id: None,
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
    fn recovery_polling_reuses_provider_digest_until_sqlite_revision_changes() {
        for model_count in [1, 4096] {
            let db = Arc::new(Database::memory().unwrap());
            let models = (0..model_count)
                .map(|index| serde_json::json!({"model": format!("model-{index}")}))
                .collect::<Vec<_>>();
            let provider = crate::provider::Provider::with_id(
                "recovery-provider".to_string(),
                "Recovery provider".to_string(),
                serde_json::json!({"modelCatalog": {"models": models}}),
                None,
            );
            db.save_provider("codex", &provider).unwrap();
            let provider = db
                .get_provider_by_id(&provider.id, "codex")
                .unwrap()
                .unwrap();
            let mut context = context("recovery-polling-revision", 3);
            context.durable_provider_id = provider.id.clone();
            context.provider_fingerprint = provider_fingerprint(&provider);
            PROVIDER_FINGERPRINT_CALLS.with(|calls| calls.set(0));
            RECOVERY_PROVIDER_ROW_LOOKUPS.with(|calls| calls.set(0));
            let binding = Arc::new(RecoveryProviderBinding::new(Arc::downgrade(&db)));
            let submit_binding = Arc::clone(&binding);

            for _ in 0..=240 {
                assert!(binding.is_current(&context, 3, Some(3)));
            }
            assert!(submit_binding.is_current(&context, 3, Some(3)));
            assert!(!binding.is_current(&context, 3, Some(2)));
            assert!(!binding.is_current(&context, 3, None));
            db.set_setting("test-recovery-unrelated", "changed")
                .unwrap();
            assert!(binding.is_current(&context, 3, Some(3)));
            assert_eq!(RECOVERY_PROVIDER_ROW_LOOKUPS.with(|calls| calls.get()), 1);
            assert_eq!(PROVIDER_FINGERPRINT_CALLS.with(|calls| calls.get()), 1);

            let mut edited = provider.clone();
            edited.settings_config["modelCatalog"]["models"][0]["model"] =
                serde_json::json!("replacement-model");
            db.save_provider("codex", &edited).unwrap();
            assert!(!submit_binding.is_current(&context, 3, Some(3)));
            assert_eq!(PROVIDER_FINGERPRINT_CALLS.with(|calls| calls.get()), 2);

            db.save_provider("codex", &provider).unwrap();
            assert!(binding.is_current(&context, 3, Some(3)));
            assert_eq!(PROVIDER_FINGERPRINT_CALLS.with(|calls| calls.get()), 3);
            db.delete_provider("codex", &provider.id).unwrap();
            assert!(!submit_binding.is_current(&context, 3, Some(3)));
            assert_eq!(RECOVERY_PROVIDER_ROW_LOOKUPS.with(|calls| calls.get()), 4);
            assert_eq!(PROVIDER_FINGERPRINT_CALLS.with(|calls| calls.get()), 3);
        }
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
    async fn oversized_sse_event_passes_through_but_cannot_authorize_recovery() {
        let mut context = context("recovery-oversized-sse", 2);
        assert_eq!(reserve_recovery(&context), Some(1));
        assert!(authorize_recovery_commit_for_test(&context));
        begin_turn(&context.desktop_thread_id, true);
        context.observed_at_ms += 1;
        context.recovery_id.push_str("-continued");

        // The frame remains unterminated. Its uninspected tail could have
        // carried a permanent terminal error; EOF must not queue continue.
        let frames = [
            Bytes::from_static(b"event: response.failed\ndata: {\"padding\":\""),
            Bytes::from(vec![b'x'; MAX_RECOVERY_SSE_FRAME_BYTES / 2]),
            Bytes::from(vec![b'x'; MAX_RECOVERY_SSE_FRAME_BYTES / 2]),
        ];
        let output = observe_responses_turn_stream(
            futures::stream::iter(frames.clone().map(Ok)),
            context.clone(),
        )
        .collect::<Vec<_>>()
        .await;

        assert_eq!(
            output.into_iter().collect::<Result<Vec<_>, _>>().unwrap(),
            frames
        );
        let states = recovery_states().lock().unwrap();
        let state = states.get(&context.desktop_thread_id).unwrap();
        assert_eq!(state.phase, RecoveryPhase::AwaitingContinuation);
        assert_eq!(state.submitted, 1);
        drop(states);
        mark_turn_completed(&context.desktop_thread_id);
    }

    #[tokio::test]
    async fn sse_inspection_budget_is_per_frame_and_supports_split_crlf() {
        let context = context("recovery-bounded-sse-frames", 3);
        let prefix = Bytes::from(": heartbeat\n\n".repeat(MAX_RECOVERY_SSE_FRAME_BYTES / 10));
        assert!(prefix.len() > MAX_RECOVERY_SSE_FRAME_BYTES);
        let frames = [
            prefix,
            Bytes::from_static(b"event: response.failed\r\n"),
            Bytes::from_static(b"data: {\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"overloaded_error\"}}}\r\n\r"),
            Bytes::from_static(b"\n"),
        ];
        let output = observe_responses_turn_stream(
            futures::stream::iter(frames.clone().map(Ok)),
            context.clone(),
        )
        .collect::<Vec<_>>()
        .await;
        assert_eq!(
            output.into_iter().collect::<Result<Vec<_>, _>>().unwrap(),
            frames
        );
        assert!(recovery_reserved_for_test(&context.desktop_thread_id));
        mark_turn_completed(&context.desktop_thread_id);
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

    #[tokio::test]
    async fn terminal_period_usage_limits_are_deferred_for_manual_continuation() {
        use super::super::error::ProxyError;

        let raw_http = exact_usage_limit_context("deferred-raw-daily-limit", 3);
        let normalized_http = exact_usage_limit_context("deferred-normalized-daily-limit", 3);
        let sse = exact_usage_limit_context("deferred-weekly-limit-sse", 3);
        let json = exact_usage_limit_context("deferred-monthly-limit-json", 3);
        let daily = serde_json::json!({
            "type": "usage_limit_reached",
            "code": "usage_limit_reached",
            "message": "Daily usage limit exceeded. The upstream provider's daily Codex allowance is exhausted.",
            "param": null,
            "upstream_reason": "DAILY_LIMIT_EXCEEDED"
        });
        for (context, status, body) in [
            (&raw_http, 403, "daily usage limit exceeded".to_owned()),
            (
                &normalized_http,
                429,
                serde_json::json!({"error": daily}).to_string(),
            ),
        ] {
            let error = ProxyError::UpstreamError {
                status,
                body: Some(body),
            };
            assert!(!forward_error_is_recoverable(&error));
            let tracking = track_turn(context);
            handle_recovery_forward_error(context.clone(), &error, "upstream_request_failed");
            drop(tracking);
        }

        let weekly = serde_json::json!({
            "type": "response.failed",
            "response": {"status": "failed", "error": {"code": "WEEKLY_LIMIT_EXCEEDED"}}
        });
        let frame = Bytes::from(format!("event: response.failed\ndata: {weekly}\n\n"));
        let stream = futures::stream::iter([Ok::<_, std::io::Error>(frame.clone())]);
        let output = observe_responses_turn_stream(stream, sse.clone())
            .collect::<Vec<_>>()
            .await;
        assert_eq!(output[0].as_ref().unwrap(), &frame);

        let tracking = track_turn(&json);
        observe_responses_turn_json(
            &serde_json::json!({
                "status": "failed",
                "error": {"message": "Monthly usage limit reached."}
            }),
            &json,
        );
        drop(tracking);

        let candidates = usage_limit_resume_snapshot().unwrap();
        for context in [&raw_http, &normalized_http, &sse, &json] {
            let candidate = candidates
                .iter()
                .find(|(epoch, _)| epoch.thread_id == context.desktop_thread_id)
                .map(|(_, candidate)| candidate)
                .unwrap_or_else(|| panic!("missing candidate for {}", context.desktop_thread_id));
            assert_eq!(
                Some(&candidate.turn.turn_id),
                context.desktop_turn_id.as_ref()
            );
            assert!(!recovery_reserved_for_test(&context.desktop_thread_id));
            mark_turn_completed(&context.desktop_thread_id);
        }
    }

    #[tokio::test]
    async fn chat_error_envelope_preserves_hard_usage_limit_for_manual_continuation() {
        let context = exact_usage_limit_context("deferred-chat-error-envelope", 3);
        let upstream = futures::stream::iter([Ok::<_, std::io::Error>(Bytes::from_static(
            b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"USAGE_LIMIT_EXCEEDED\",\"type\":\"upstream_error\",\"message\":\"Daily usage limit exceeded. The upstream provider's daily Codex allowance is exhausted.\"}}}\n\n",
        ))]);
        let converted =
            super::super::providers::openai_compat::create_chat_sse_stream_from_codex_responses(
                upstream,
                "gpt-test".to_string(),
            );

        let output = observe_responses_turn_stream(converted, context.clone())
            .collect::<Vec<_>>()
            .await;
        assert!(
            String::from_utf8_lossy(output[0].as_ref().unwrap()).contains("USAGE_LIMIT_EXCEEDED")
        );
        assert_eq!(
            output[1].as_ref().unwrap(),
            &Bytes::from_static(b"data: [DONE]\n\n")
        );

        let candidates = usage_limit_resume_snapshot().unwrap();
        let candidate = candidates
            .iter()
            .find(|(epoch, _)| epoch.thread_id == context.desktop_thread_id)
            .map(|(_, candidate)| candidate)
            .expect("chat error envelope should create a usage-limit candidate");
        assert_eq!(
            candidate.turn.turn_id,
            context.desktop_turn_id.clone().unwrap()
        );
        assert!(!recovery_reserved_for_test(&context.desktop_thread_id));
        mark_turn_completed(&context.desktop_thread_id);
    }

    #[test]
    fn deferred_period_limits_require_the_current_exact_desktop_request() {
        use super::super::error::ProxyError;

        let unbound = context("deferred-unbound-limit", 3);
        let mut external = exact_usage_limit_context("deferred-external-limit", 3);
        external.desktop_eligible = false;
        let cancelled = exact_usage_limit_context("deferred-cancelled-request", 3);
        let superseded = exact_usage_limit_context("deferred-superseded-request", 3);
        let mut latest = superseded.clone();
        latest.desktop_turn_id = Some("newer-turn".into());
        latest.recovery_id = "newer-recovery".into();
        latest.observed_at_ms += 1;

        let error = ProxyError::UpstreamError {
            status: 403,
            body: Some("Daily usage limit exceeded.".into()),
        };
        let unbound_tracking = track_turn(&unbound);
        drop(track_turn(&cancelled));
        let superseded_tracking = track_turn(&superseded);
        let latest_tracking = track_turn(&latest);
        for context in [&unbound, &external, &cancelled, &superseded] {
            handle_recovery_forward_error(context.clone(), &error, "upstream_request_failed");
            assert!(usage_limit_resume_snapshot()
                .unwrap()
                .iter()
                .all(|(epoch, _)| epoch.thread_id != context.desktop_thread_id));
        }
        {
            let states = recovery_states().lock().unwrap();
            let current = states.get(&latest.desktop_thread_id).unwrap();
            assert_eq!(current.phase, RecoveryPhase::ActiveRequest);
            assert_eq!(
                current
                    .tracked
                    .as_ref()
                    .map(|tracked| tracked.recovery_id.as_str()),
                Some(latest.recovery_id.as_str())
            );
        }
        drop((unbound_tracking, superseded_tracking, latest_tracking));
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
            RecoveryDecision::UsageLimit("response_failed")
        );
        assert!(forward_error_is_recoverable(&ProxyError::UpstreamError {
            status: 429,
            body: Some(serde_json::json!({"error": error}).to_string()),
        }));

        for (message, expected) in [
            (
                "Daily usage limit reached. Please try again later.",
                RecoveryDecision::DeferredUsageLimit,
            ),
            (
                "Weekly usage limit reached. Please retry later.",
                RecoveryDecision::DeferredUsageLimit,
            ),
            (
                "Monthly usage limit reached. Wait for the reset.",
                RecoveryDecision::DeferredUsageLimit,
            ),
            (
                "Usage limit reached; quota exhausted. Retry later.",
                RecoveryDecision::Ignore,
            ),
            (
                "Daily usage limit reached; billing payment required. Retry later.",
                RecoveryDecision::Ignore,
            ),
            (
                "Daily usage limit reached; insufficient credit balance. Retry later.",
                RecoveryDecision::Ignore,
            ),
            (
                "Daily usage limit reached. Permission denied; retry later.",
                RecoveryDecision::Ignore,
            ),
            (
                "Daily usage limit reached. Token expired; retry later.",
                RecoveryDecision::Ignore,
            ),
            (
                "Daily usage limit reached. User cancelled the turn; retry later.",
                RecoveryDecision::Ignore,
            ),
            (
                "Daily usage limit reached. Do not retry.",
                RecoveryDecision::Ignore,
            ),
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
                expected,
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

    #[test]
    fn output_embedded_period_limits_defer_completed_and_failed_turns() {
        let completed = serde_json::json!({
            "response": {
                "status": "completed",
                "output": [{
                    "type": "message",
                    "content": [{
                        "type": "output_text",
                        "text": "Daily usage limit reached. Please try again later."
                    }]
                }]
            }
        });
        assert_eq!(
            recovery_decision(
                NativeResponsesTerminalDisposition::Completed,
                "response.completed",
                &completed,
                NativeResponsesEvidence::default(),
            ),
            RecoveryDecision::DeferredUsageLimit
        );

        let failed = serde_json::json!({
            "response": {
                "status": "failed",
                "output": [{
                    "type": "message",
                    "content": [{
                        "type": "output_text",
                        "text": "Weekly usage limit reached. Please try again later."
                    }]
                }]
            }
        });
        assert_eq!(
            recovery_decision(
                NativeResponsesTerminalDisposition::Failed,
                "response.failed",
                &failed,
                NativeResponsesEvidence::default(),
            ),
            RecoveryDecision::DeferredUsageLimit
        );
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
