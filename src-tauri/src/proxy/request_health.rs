//! Provider-neutral request diagnostics and conservative transport optimization.
//!
//! This module deliberately operates on the final JSON body immediately before
//! serialization. It never stores prompt text, tool arguments, or tool output.
//! Diagnostics contain only byte counts, item kinds, structural findings, and
//! redacted routing identifiers.

use crate::settings::{RequestHealthConfig, RequestHealthReviewMode, RequestOptimizationMode};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::oneshot;

const MAX_DIAGNOSTICS: usize = 100;
const MAX_APPROVED_PAYLOADS: usize = 100;
const LARGE_ITEM_BYTES: usize = 64 * 1024;
const ESTIMATED_BYTES_PER_TOKEN: usize = 4;
#[cfg(target_os = "windows")]
const MIN_REVIEW_TIMEOUT_SECONDS: u64 = 15;
#[cfg(target_os = "windows")]
const MAX_REVIEW_TIMEOUT_SECONDS: u64 = 300;

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_input_tokens: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fresh_input_tokens: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_hit_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anomaly: Option<RequestHealthFinding>,
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
static SESSION_REVIEW_RISKS: OnceLock<Mutex<HashMap<String, RequestHealthFinding>>> =
    OnceLock::new();
static PENDING_REVIEWS: OnceLock<Mutex<HashMap<String, PendingReview>>> = OnceLock::new();
static APPROVED_PAYLOADS: OnceLock<Mutex<VecDeque<ApprovedPayload>>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReviewDecision {
    ContinueOnce,
    Block,
    CompactAndRestart,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PreflightReviewOutcome {
    NotRequired,
    ContinueOnce,
    CompactAndRestart,
}

struct PendingReview {
    trace_id: String,
    session_id: String,
    body_hash: String,
    dispatch_hash: String,
    sender: oneshot::Sender<ReviewDecision>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ApprovedPayload {
    trace_id: String,
    session_id: String,
    body_hash: String,
    dispatch_hash: String,
}

struct PendingReviewGuard {
    token: String,
    body_hash: String,
}

impl Drop for PendingReviewGuard {
    fn drop(&mut self) {
        let _ = resolve_pending_review(&self.token, &self.body_hash, ReviewDecision::Block);
    }
}

fn diagnostics_store() -> &'static Mutex<VecDeque<RequestHealthDiagnostic>> {
    DIAGNOSTICS.get_or_init(|| Mutex::new(VecDeque::with_capacity(MAX_DIAGNOSTICS)))
}

fn session_review_risks() -> &'static Mutex<HashMap<String, RequestHealthFinding>> {
    SESSION_REVIEW_RISKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pending_reviews() -> &'static Mutex<HashMap<String, PendingReview>> {
    PENDING_REVIEWS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn approved_payloads() -> &'static Mutex<VecDeque<ApprovedPayload>> {
    APPROVED_PAYLOADS.get_or_init(|| Mutex::new(VecDeque::with_capacity(MAX_APPROVED_PAYLOADS)))
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
    // Keep this module diagnostic-only. A byte heuristic is not a tokenizer:
    // JSON syntax, tool schemas, and provider-specific transformations make
    // `bytes / 4` unsuitable for rejecting a live Codex turn.
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
        actual_input_tokens: None,
        cached_input_tokens: None,
        fresh_input_tokens: None,
        cache_hit_ratio: None,
        anomaly: None,
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
    refresh_session_review_risk(&mut store, context.session_id);
    Some(diagnostic)
}

/// Attach authoritative upstream usage to the matching finalized request. A
/// sustained anomaly arms a review for the next request; it never tries to
/// recall or block the request whose response supplied this usage.
pub(crate) fn record_usage(
    trace_id: &str,
    input_tokens: u32,
    cache_read_tokens: u32,
) -> Option<RequestHealthFinding> {
    if trace_id.is_empty() || input_tokens == 0 {
        return None;
    }

    let mut store = diagnostics_store()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let target_index = store
        .iter()
        .rposition(|diagnostic| diagnostic.trace_id.as_deref() == Some(trace_id))?;

    {
        let diagnostic = &mut store[target_index];
        let input_tokens = input_tokens as usize;
        let cached_input_tokens = (cache_read_tokens as usize).min(input_tokens);
        diagnostic.actual_input_tokens = Some(input_tokens);
        diagnostic.cached_input_tokens = Some(cached_input_tokens);
        diagnostic.fresh_input_tokens = Some(input_tokens.saturating_sub(cached_input_tokens));
        diagnostic.cache_hit_ratio = Some(cached_input_tokens as f64 / input_tokens as f64);
    }

    let target = &store[target_index];
    if target.app_type != "codex" || target.compaction_request || !target.session_client_provided {
        return None;
    }
    let target_session_id = target.session_id.clone();
    if !target.threshold_exceeded {
        drop(store);
        session_review_risks()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&target_session_id);
        return None;
    }
    refresh_session_review_risk(&mut store, &target_session_id);
    let finding = session_review_risks()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&target_session_id)
        .cloned();
    drop(store);

    finding
}

fn refresh_session_review_risk(
    diagnostics: &mut VecDeque<RequestHealthDiagnostic>,
    session_id: &str,
) {
    let recent = diagnostics
        .iter()
        .rev()
        .filter(|candidate| {
            candidate.session_id == session_id
                && candidate.app_type == "codex"
                && candidate.session_client_provided
                && !candidate.compaction_request
                && candidate.threshold_exceeded
        })
        .take(3)
        .collect::<Vec<_>>();
    let finding = sustained_growth_finding(&recent);
    if let Some(current) = diagnostics
        .iter_mut()
        .rfind(|candidate| candidate.session_id == session_id)
    {
        current.anomaly = finding.clone();
    }

    let mut risks = session_review_risks()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(finding) = finding {
        risks.insert(session_id.to_string(), finding);
    } else {
        risks.remove(session_id);
    }
}

fn sustained_growth_finding(recent: &[&RequestHealthDiagnostic]) -> Option<RequestHealthFinding> {
    let [newest, middle, oldest] = recent else {
        return None;
    };

    let fresh_values = [
        oldest.fresh_input_tokens,
        middle.fresh_input_tokens,
        newest.fresh_input_tokens,
    ];
    let cache_stalled = recent
        .iter()
        .all(|candidate| candidate.cache_hit_ratio.unwrap_or_default() < 0.10);
    if let [Some(oldest), Some(middle), Some(newest)] = fresh_values {
        let fresh_input_growing = middle >= oldest.saturating_add(oldest / 20)
            && newest >= middle.saturating_add(middle / 20);
        if cache_stalled && fresh_input_growing {
            return Some(RequestHealthFinding {
                code: "sustained_uncached_input_growth".to_string(),
                severity: "warning".to_string(),
                count: 3,
                detail: format!(
                    "Three large Codex turns increased fresh input from {oldest} to {newest} tokens while cache hits stayed below 10%"
                ),
            });
        }
    }

    let oldest_bytes = oldest.optimized_bytes;
    let middle_bytes = middle.optimized_bytes;
    let newest_bytes = newest.optimized_bytes;
    let body_growing = middle_bytes >= oldest_bytes.saturating_add(oldest_bytes / 20)
        && newest_bytes >= middle_bytes.saturating_add(middle_bytes / 20);
    body_growing.then(|| RequestHealthFinding {
        code: "sustained_request_growth".to_string(),
        severity: "warning".to_string(),
        count: 3,
        detail: format!(
            "Three large finalized Codex request bodies increased from {oldest_bytes} to {newest_bytes} bytes before upstream dispatch"
        ),
    })
}

pub(crate) fn wire_body_hash(body: &[u8]) -> String {
    let digest = Sha256::digest(body);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn mark_blocked(trace_id: &str) {
    let mut store = diagnostics_store()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(diagnostic) = store
        .iter_mut()
        .rfind(|diagnostic| diagnostic.trace_id.as_deref() == Some(trace_id))
    {
        diagnostic.blocked = true;
    }
}

fn payload_was_approved(
    trace_id: &str,
    session_id: &str,
    body_hash: &str,
    dispatch_hash: &str,
) -> bool {
    approved_payloads()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .any(|approved| {
            approved.trace_id == trace_id
                && approved.session_id == session_id
                && approved.body_hash == body_hash
                && approved.dispatch_hash == dispatch_hash
        })
}

fn remember_approved_payload(
    trace_id: &str,
    session_id: &str,
    body_hash: &str,
    dispatch_hash: &str,
) {
    let mut approved = approved_payloads()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if approved.len() == MAX_APPROVED_PAYLOADS {
        approved.pop_front();
    }
    approved.push_back(ApprovedPayload {
        trace_id: trace_id.to_string(),
        session_id: session_id.to_string(),
        body_hash: body_hash.to_string(),
        dispatch_hash: dispatch_hash.to_string(),
    });
}

fn resolve_pending_review(token: &str, body_hash: &str, decision: ReviewDecision) -> bool {
    let pending = {
        let mut reviews = pending_reviews()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let matches = reviews
            .get(token)
            .is_some_and(|review| review.body_hash == body_hash);
        matches.then(|| reviews.remove(token)).flatten()
    };
    let Some(pending) = pending else {
        return false;
    };
    if decision == ReviewDecision::ContinueOnce {
        remember_approved_payload(
            &pending.trace_id,
            &pending.session_id,
            &pending.body_hash,
            &pending.dispatch_hash,
        );
    }
    pending.sender.send(decision).is_ok()
}

fn review_finding(
    config: &RequestHealthConfig,
    trace_id: &str,
    session_id: &str,
) -> Option<RequestHealthFinding> {
    let sustained_risk = session_review_risks()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(session_id)
        .cloned();
    let immediate_risk = || {
        diagnostics_store()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .rev()
            .find(|diagnostic| {
                diagnostic.trace_id.as_deref() == Some(trace_id)
                    && diagnostic.session_id == session_id
                    && diagnostic.app_type == "codex"
                    && diagnostic.session_client_provided
                    && !diagnostic.compaction_request
                    && (diagnostic.threshold_exceeded || diagnostic.token_limit_exceeded)
            })
            .filter(|diagnostic| diagnostic.threshold_exceeded)
            .map(|diagnostic| RequestHealthFinding {
                code: "oversized_request_preflight".to_string(),
                severity: "error".to_string(),
                count: 1,
                detail: format!(
                    "This request is {:.1} KB, above the configured {:.1} KB threshold",
                    diagnostic.optimized_bytes as f64 / 1024.0,
                    diagnostic.threshold_bytes as f64 / 1024.0
                ),
            })
    };
    match config.review_mode {
        RequestHealthReviewMode::Off => None,
        RequestHealthReviewMode::FirstLargeRequest => immediate_risk().or(sustained_risk),
        RequestHealthReviewMode::SustainedGrowth => sustained_risk,
    }
}

pub(crate) async fn review_before_upstream(
    config: &RequestHealthConfig,
    trace_id: &str,
    session_id: &str,
    session_client_provided: bool,
    model: &str,
    body: &[u8],
    dispatch_scope: &str,
    compaction_request: bool,
) -> Result<PreflightReviewOutcome, String> {
    if !config.enabled
        || config.review_mode == RequestHealthReviewMode::Off
        || trace_id.is_empty()
        || session_id.is_empty()
        || !session_client_provided
        || compaction_request
        || body.is_empty()
    {
        return Ok(PreflightReviewOutcome::NotRequired);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (model, body, dispatch_scope);
        return Ok(PreflightReviewOutcome::NotRequired);
    }

    #[cfg(target_os = "windows")]
    {
        let risk = review_finding(config, trace_id, session_id);
        let Some(risk) = risk else {
            return Ok(PreflightReviewOutcome::NotRequired);
        };

        let body_hash = wire_body_hash(body);
        let dispatch_hash = wire_body_hash(dispatch_scope.as_bytes());
        if payload_was_approved(trace_id, session_id, &body_hash, &dispatch_hash) {
            return Ok(PreflightReviewOutcome::ContinueOnce);
        }

        let token = uuid::Uuid::new_v4().simple().to_string();
        let (sender, receiver) = oneshot::channel();
        pending_reviews()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                token.clone(),
                PendingReview {
                    trace_id: trace_id.to_string(),
                    session_id: session_id.to_string(),
                    body_hash: body_hash.clone(),
                    dispatch_hash,
                    sender,
                },
            );
        let _guard = PendingReviewGuard {
            token: token.clone(),
            body_hash: body_hash.clone(),
        };

        show_windows_review_notification(
            &token,
            &body_hash,
            model,
            body.len(),
            &risk,
            config.review_timeout_seconds,
            config.compact_and_restart_enabled,
        )
        .map_err(|error| format!("Windows Request Health notification failed: {error}"))?;

        let timeout_seconds = u64::from(config.review_timeout_seconds)
            .clamp(MIN_REVIEW_TIMEOUT_SECONDS, MAX_REVIEW_TIMEOUT_SECONDS);
        match tokio::time::timeout(Duration::from_secs(timeout_seconds), receiver).await {
            Ok(Ok(ReviewDecision::ContinueOnce)) => Ok(PreflightReviewOutcome::ContinueOnce),
            Ok(Ok(ReviewDecision::CompactAndRestart)) => {
                Ok(PreflightReviewOutcome::CompactAndRestart)
            }
            Ok(Ok(ReviewDecision::Block)) => {
                Err("Request blocked from the Windows Request Health notification".to_string())
            }
            Ok(Err(_)) => Err("Request Health review channel closed before approval".to_string()),
            Err(_) => Err(format!(
                "Request Health review timed out after {timeout_seconds} seconds"
            )),
        }
    }
}

#[cfg(target_os = "windows")]
fn show_windows_review_notification(
    token: &str,
    body_hash: &str,
    model: &str,
    body_bytes: usize,
    risk: &RequestHealthFinding,
    timeout_seconds: u32,
    compact_and_restart_enabled: bool,
) -> Result<(), String> {
    use tauri_winrt_notification::{Scenario, Toast};
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    const APP_ID: &str = "com.ccswitchmulti.desktop";
    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let (identity, _) = current_user
        .create_subkey(format!(r"Software\Classes\AppUserModelId\{APP_ID}"))
        .map_err(|error| error.to_string())?;
    identity
        .set_value("DisplayName", &"CCSwitchMulti")
        .map_err(|error| error.to_string())?;
    if let Ok(executable) = std::env::current_exe() {
        let icon_uri = executable.to_string_lossy().to_string();
        let _ = identity.set_value("IconUri", &icon_uri);
    }

    let language = crate::settings::get_settings()
        .language
        .unwrap_or_else(|| "en".to_string());
    let strings = NativeReviewStrings::for_language(&language);
    let continue_action = format!("continue|{token}|{body_hash}");
    let block_action = format!("block|{token}|{body_hash}");
    let compact_action = format!("compact|{token}|{body_hash}");
    let activated_token = token.to_string();
    let activated_hash = body_hash.to_string();
    let expected_continue = continue_action.clone();
    let expected_block = block_action.clone();
    let expected_compact = compact_action.clone();
    let dismissed_token = token.to_string();
    let dismissed_hash = body_hash.to_string();
    let model = truncate_for_notification(model, 80);
    let detail = format!(
        "{} ({:.1} KB, {}s)",
        truncate_for_notification(&risk.detail, 150),
        body_bytes as f64 / 1024.0,
        u64::from(timeout_seconds).clamp(MIN_REVIEW_TIMEOUT_SECONDS, MAX_REVIEW_TIMEOUT_SECONDS)
    );

    let toast = Toast::new(APP_ID)
        .title(strings.title)
        .text1(&format!("{}: {model}", strings.model))
        .text2(&detail)
        .scenario(Scenario::Reminder)
        .on_activated(move |action| {
            let decision = match action.as_deref() {
                Some(value) if value == expected_continue => ReviewDecision::ContinueOnce,
                Some(value) if value == expected_block => ReviewDecision::Block,
                Some(value) if value == expected_compact => ReviewDecision::CompactAndRestart,
                _ => ReviewDecision::Block,
            };
            let _ = resolve_pending_review(&activated_token, &activated_hash, decision);
            Ok(())
        })
        .add_button(strings.continue_once, &continue_action)
        .add_button(strings.block, &block_action);
    let toast = if compact_and_restart_enabled {
        toast.add_button(strings.compact_and_restart, &compact_action)
    } else {
        toast
    };
    toast
        .on_dismissed(move |_| {
            let _ =
                resolve_pending_review(&dismissed_token, &dismissed_hash, ReviewDecision::Block);
            Ok(())
        })
        .show()
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
pub(crate) fn show_compact_restart_result_notification(
    session_id: &str,
    new_session_id: Option<&str>,
    error: Option<&str>,
) {
    use tauri_winrt_notification::{Scenario, Toast};

    const APP_ID: &str = "com.ccswitchmulti.desktop";
    let (title, detail) = match (new_session_id, error) {
        (Some(new_session), _) => (
            "Compaction complete",
            format!(
                "Codex compacted the source session and forked a new session: {}",
                truncate_for_notification(new_session, 80)
            ),
        ),
        (_, Some(reason)) => (
            "Compaction + new session failed",
            format!(
                "The source session was not forked. {}",
                truncate_for_notification(reason, 180)
            ),
        ),
        _ => (
            "Compaction + new session finished",
            "Codex did not return a new session id.".to_string(),
        ),
    };
    let source = format!("Source session: {}", truncate_for_notification(session_id, 80));
    let _ = Toast::new(APP_ID)
        .title(title)
        .text1(&detail)
        .text2(&source)
        .scenario(Scenario::Reminder)
        .show();
}

#[cfg(target_os = "windows")]
struct NativeReviewStrings {
    title: &'static str,
    model: &'static str,
    continue_once: &'static str,
    block: &'static str,
    compact_and_restart: &'static str,
}

#[cfg(target_os = "windows")]
impl NativeReviewStrings {
    fn for_language(language: &str) -> Self {
        match language {
            "zh" | "zh-CN" => Self {
                title: "请求已暂停，等待确认",
                model: "模型",
                continue_once: "仅继续这一次",
                block: "阻止",
                compact_and_restart: "压缩并开始新会话",
            },
            "zh-TW" => Self {
                title: "請求已暫停，等待確認",
                model: "模型",
                continue_once: "僅繼續這一次",
                block: "封鎖",
                compact_and_restart: "壓縮並開始新工作階段",
            },
            "ja" => Self {
                title: "リクエストを一時停止しました",
                model: "モデル",
                continue_once: "今回のみ続行",
                block: "ブロック",
                compact_and_restart: "圧縮して新しいセッション",
            },
            _ => Self {
                title: "Request paused for approval",
                model: "Model",
                continue_once: "Continue once",
                block: "Block",
                compact_and_restart: "Compact + new session",
            },
        }
    }
}

#[cfg(target_os = "windows")]
fn truncate_for_notification(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
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
    fn first_oversized_codex_turn_arms_pre_dispatch_review() {
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
        let finding = review_finding(
            &config,
            "trace-oversized-first",
            "session-oversized-diagnostic-only",
        )
        .expect("first oversized request should require review");
        assert_eq!(finding.code, "oversized_request_preflight");

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
        assert!(
            review_finding(&config, "trace-compaction", compaction.session_id.as_str()).is_none()
        );
    }

    #[test]
    fn review_mode_can_delay_or_disable_first_request_prompt() {
        let session_id = "review-mode-session";
        let trace_id = "review-mode-trace";
        let mut body = json!({
            "input": [{"type": "message", "content": "x".repeat(1_200_000)}]
        });
        let mut request_context = context();
        request_context.session_id = session_id;
        request_context.trace_id = Some(trace_id);
        inspect_and_optimize(&mut body, &RequestHealthConfig::default(), request_context)
            .expect("diagnostic");

        let delayed = RequestHealthConfig {
            review_mode: RequestHealthReviewMode::SustainedGrowth,
            ..RequestHealthConfig::default()
        };
        assert!(review_finding(&delayed, trace_id, session_id).is_none());

        let disabled = RequestHealthConfig {
            review_mode: RequestHealthReviewMode::Off,
            ..RequestHealthConfig::default()
        };
        assert!(review_finding(&disabled, trace_id, session_id).is_none());
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

    #[test]
    fn flags_sustained_uncached_growth_only_after_warmup() {
        let config = RequestHealthConfig {
            large_request_threshold_bytes: 64 * 1024,
            ..RequestHealthConfig::default()
        };
        for (trace, input_tokens, expected_alert) in [
            ("health-growth-1", 100_000, false),
            ("health-growth-2", 106_000, false),
            ("health-growth-3", 113_000, true),
        ] {
            let mut body = json!({
                "input": [{"type": "message", "content": "x".repeat(70_000)}]
            });
            let context = RequestHealthContext {
                trace_id: Some(trace),
                session_id: "health-growth-session",
                app_type: "codex",
                provider_id: "provider-1",
                provider_name: "Provider One",
                model: "model-1",
                endpoint: "/responses",
                client_request_bytes: 70_000,
                compaction_request: false,
                session_client_provided: true,
            };
            inspect_and_optimize(&mut body, &config, context).expect("diagnostic");
            let alert = record_usage(trace, input_tokens, 0);
            assert_eq!(alert.is_some(), expected_alert);
        }
    }

    #[test]
    fn arms_preflight_from_sustained_finalized_body_growth_without_usage() {
        let config = RequestHealthConfig {
            large_request_threshold_bytes: 64 * 1024,
            ..RequestHealthConfig::default()
        };
        let session_id = "body-growth-session";
        for (trace, payload_bytes) in [
            ("body-growth-1", 70_000),
            ("body-growth-2", 75_000),
            ("body-growth-3", 80_000),
        ] {
            let mut body = json!({
                "input": [{"type": "message", "content": "x".repeat(payload_bytes)}]
            });
            let mut request_context = context();
            request_context.trace_id = Some(trace);
            request_context.session_id = session_id;
            inspect_and_optimize(&mut body, &config, request_context).expect("diagnostic");
        }

        let finding = session_review_risks()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(session_id)
            .cloned()
            .expect("preflight risk");
        assert_eq!(finding.code, "sustained_request_growth");
    }

    #[test]
    fn native_review_resolution_is_single_use_and_body_hash_bound() {
        let token = "single-use-review-token";
        let trace_id = "single-use-review-trace";
        let session_id = "single-use-review-session";
        let body_hash = wire_body_hash(br#"{"input":"frozen"}"#);
        let dispatch_hash = wire_body_hash(b"provider-1|POST|https://example.test/responses");
        let (sender, receiver) = oneshot::channel();
        pending_reviews()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                token.to_string(),
                PendingReview {
                    trace_id: trace_id.to_string(),
                    session_id: session_id.to_string(),
                    body_hash: body_hash.clone(),
                    dispatch_hash: dispatch_hash.clone(),
                    sender,
                },
            );

        assert!(!resolve_pending_review(
            token,
            &wire_body_hash(br#"{"input":"different"}"#),
            ReviewDecision::ContinueOnce,
        ));
        assert!(resolve_pending_review(
            token,
            &body_hash,
            ReviewDecision::ContinueOnce,
        ));
        assert_eq!(
            receiver.blocking_recv().expect("review decision"),
            ReviewDecision::ContinueOnce
        );
        assert!(payload_was_approved(
            trace_id,
            session_id,
            &body_hash,
            &dispatch_hash
        ));
        assert!(!payload_was_approved(
            trace_id,
            "another-session",
            &body_hash,
            &dispatch_hash
        ));
        assert!(!payload_was_approved(
            trace_id,
            session_id,
            &body_hash,
            &wire_body_hash(b"provider-2|POST|https://example.test/responses")
        ));
        assert!(!resolve_pending_review(
            token,
            &body_hash,
            ReviewDecision::ContinueOnce,
        ));
    }

    #[test]
    fn compact_restart_decision_does_not_approve_the_blocked_payload() {
        let token = "compact-restart-review-token";
        let trace_id = "compact-restart-review-trace";
        let session_id = "compact-restart-review-session";
        let body_hash = wire_body_hash(br#"{"input":"oversized"}"#);
        let dispatch_hash = wire_body_hash(b"provider-1|POST|https://example.test/responses");
        let (sender, receiver) = oneshot::channel();
        pending_reviews()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                token.to_string(),
                PendingReview {
                    trace_id: trace_id.to_string(),
                    session_id: session_id.to_string(),
                    body_hash: body_hash.clone(),
                    dispatch_hash: dispatch_hash.clone(),
                    sender,
                },
            );

        assert!(resolve_pending_review(
            token,
            &body_hash,
            ReviewDecision::CompactAndRestart,
        ));
        assert_eq!(
            receiver.blocking_recv().expect("review decision"),
            ReviewDecision::CompactAndRestart
        );
        assert!(!payload_was_approved(
            trace_id,
            session_id,
            &body_hash,
            &dispatch_hash
        ));
    }

    #[test]
    fn healthy_usage_clears_an_armed_session_review() {
        let config = RequestHealthConfig {
            large_request_threshold_bytes: 64 * 1024,
            ..RequestHealthConfig::default()
        };
        let session_id = "health-recovery-session";
        for (trace, input_tokens) in [
            ("health-recovery-1", 100_000),
            ("health-recovery-2", 106_000),
            ("health-recovery-3", 113_000),
        ] {
            let mut body = json!({
                "input": [{"type": "message", "content": "x".repeat(70_000)}]
            });
            let mut request_context = context();
            request_context.trace_id = Some(trace);
            request_context.session_id = session_id;
            inspect_and_optimize(&mut body, &config, request_context).expect("diagnostic");
            let _ = record_usage(trace, input_tokens, 0);
        }
        assert!(session_review_risks()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(session_id));

        let mut body = json!({
            "input": [{"type": "message", "content": "x".repeat(70_000)}]
        });
        let mut request_context = context();
        request_context.trace_id = Some("health-recovery-4");
        request_context.session_id = session_id;
        inspect_and_optimize(&mut body, &config, request_context).expect("diagnostic");
        assert!(record_usage("health-recovery-4", 120_000, 110_000).is_none());
        assert!(!session_review_risks()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(session_id));
    }
}
