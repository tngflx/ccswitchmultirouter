//! Native-only owner console adapter. Neither CDP transports nor renderer view
//! references are serialized. Every mutation requires both canonical native
//! reservation authorization and the caller's current authenticated session.

use super::{
    candidate_debug_ports, cdp_websocket_endpoint, codex_cdp_http_client,
    codex_renderer_runtime_fingerprint, target_matches_codex_desktop, CdpTarget,
    CDP_CONNECT_TIMEOUT, DEFAULT_CODEX_DEBUG_PORT, MODEL_PICKER_PATCH_KEY,
};
use crate::process_identity::ProcessIdentity;
use crate::proxy::codex_turn_recovery::{
    self as recovery, OwnerContinuationEpoch, OwnerContinuationOperation, OwnerContinuationOutcome,
    OwnerContinuationReceipt, OwnerContinuationReservation,
};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
#[cfg(test)]
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::tungstenite::{protocol::WebSocketConfig, Message};

const OWNER_VIEW_LIFETIME: Duration = Duration::from_secs(30);
const OWNER_CDP_TIMEOUT: Duration = Duration::from_secs(8);
const OWNER_JOB_WAIT: Duration = Duration::from_secs(12);
const OWNER_MAX_CDP_BYTES: usize = 262_144;
const OWNER_MAX_TARGET_BYTES: usize = 131_072;
const OWNER_MAX_CONFIG_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexOwnerRemoteError {
    Unauthorized,
    InvalidSelection,
    UnsupportedPlatform,
    Unavailable,
    AmbiguousTarget,
    StaleView,
    ContentUnavailable,
    OperationUnavailable,
}
impl CodexOwnerRemoteError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::Unauthorized => "owner_unauthorized",
            Self::InvalidSelection => "invalid_thread",
            Self::UnsupportedPlatform => "owner_platform_unavailable",
            Self::Unavailable => "codex_unavailable",
            Self::AmbiguousTarget => "codex_target_ambiguous",
            Self::StaleView => "view_stale",
            Self::ContentUnavailable => "content_unavailable",
            Self::OperationUnavailable => "operation_unavailable",
        }
    }
}
impl std::fmt::Display for CodexOwnerRemoteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}
impl std::error::Error for CodexOwnerRemoteError {}

#[derive(Clone, PartialEq, Eq)]
struct OwnerConfigIdentity {
    application_root: PathBuf,
    settings_root: PathBuf,
    config_path: PathBuf,
    content_hash: [u8; 32],
    provider_scope: String,
}
#[derive(Clone)]
struct OwnerTargetProof {
    port: u16,
    endpoint: IpAddr,
    target: CdpTarget,
    processes: Vec<ProcessIdentity>,
    config: OwnerConfigIdentity,
    database: Arc<crate::database::Database>,
}
#[derive(Clone)]
struct OwnerViewBinding {
    epoch: OwnerContinuationEpoch,
    target: OwnerTargetProof,
    reference: String,
    runtime_generation: u64,
    base_turn_id: String,
    model: String,
    // Additional native binding, never sent to the browser.
    model_provider: String,
    captured_at: Instant,
}
/// Only content() is suitable for the website. This type deliberately has no
/// Serialize/Deserialize or Debug implementation: it contains local authority.
#[derive(Clone)]
pub(crate) struct CodexOwnerRemoteView {
    content: Value,
    thread_id: String,
    binding: Option<OwnerViewBinding>,
}
impl CodexOwnerRemoteView {
    pub(crate) fn content(&self) -> &Value {
        &self.content
    }
    pub(crate) fn thread_id(&self) -> &str {
        &self.thread_id
    }
    pub(crate) fn remaining_lifetime(&self) -> Duration {
        self.binding.as_ref().map_or(Duration::ZERO, |binding| {
            OWNER_VIEW_LIFETIME.saturating_sub(binding.captured_at.elapsed())
        })
    }
    pub(crate) fn can_continue(&self) -> bool {
        self.binding
            .as_ref()
            .is_some_and(|binding| binding.captured_at.elapsed() < OWNER_VIEW_LIFETIME)
    }
}
fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && !value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
}
fn valid_model(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && !value.eq_ignore_ascii_case("unknown")
        && !value.chars().any(char::is_control)
}
fn valid_operation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
}
fn capture_owner_config_identity(
    db: &crate::database::Database,
) -> Result<OwnerConfigIdentity, CodexOwnerRemoteError> {
    let application_root = crate::config::get_app_config_dir()
        .canonicalize()
        .map_err(|_| CodexOwnerRemoteError::Unavailable)?;
    let settings_path =
        crate::settings::AppSettings::settings_path().ok_or(CodexOwnerRemoteError::Unavailable)?;
    let settings_root = settings_path
        .parent()
        .ok_or(CodexOwnerRemoteError::Unavailable)?
        .canonicalize()
        .map_err(|_| CodexOwnerRemoteError::Unavailable)?;
    let path = crate::codex_config::get_codex_config_path();
    let config_path = path
        .canonicalize()
        .map_err(|_| CodexOwnerRemoteError::Unavailable)?;
    let metadata =
        std::fs::metadata(&config_path).map_err(|_| CodexOwnerRemoteError::Unavailable)?;
    if !metadata.is_file() || metadata.len() > OWNER_MAX_CONFIG_BYTES {
        return Err(CodexOwnerRemoteError::Unavailable);
    }
    let text = crate::codex_config::read_existing_codex_config_text()
        .map_err(|_| CodexOwnerRemoteError::Unavailable)?;
    if text.len() as u64 > OWNER_MAX_CONFIG_BYTES
        || toml::from_str::<toml::Table>(&text).is_err()
        || crate::codex_config::get_codex_config_path()
            .canonicalize()
            .ok()
            .as_ref()
            != Some(&config_path)
    {
        return Err(CodexOwnerRemoteError::Unavailable);
    }
    Ok(OwnerConfigIdentity {
        application_root,
        settings_root,
        config_path,
        content_hash: Sha256::digest(text.as_bytes()).into(),
        provider_scope: crate::codex_multirouter::owner_scope_fingerprint(db)
            .map_err(|_| CodexOwnerRemoteError::Unavailable)?,
    })
}
#[cfg(any(target_os = "windows", test))]
fn owner_listener_pids_from_rows(
    rows: &[crate::process_identity::TcpPortRow],
    endpoint: IpAddr,
) -> Option<Vec<u32>> {
    if !endpoint.is_loopback() {
        return None;
    }
    let mut pids = BTreeSet::new();
    for row in rows {
        let listener = row.local_address.parse::<SocketAddr>().ok()?;
        if !super::cdp_listener_address_covers_endpoint(listener.ip(), endpoint) {
            continue;
        }
        if row.state == "UNKNOWN" {
            return None;
        }
        if row.state == "LISTEN" {
            if row.pid == 0 {
                return None;
            }
            pids.insert(row.pid);
        }
    }
    (!pids.is_empty()).then(|| pids.into_iter().collect())
}
#[cfg(any(target_os = "windows", test))]
fn owner_identities_match(left: &[ProcessIdentity], right: &[ProcessIdentity]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .all(|(left, right)| left.matches(right))
}
#[cfg(any(target_os = "windows", test))]
fn owner_shell_identities_are_verified(
    identities: &[ProcessIdentity],
    processes: &[crate::commands::CodexAppServerProcessDiagnostics],
) -> bool {
    !identities.is_empty()
        && identities.iter().all(|identity| {
            identity.pid != 0
                && identity.started_at_ticks != 0
                && processes.iter().any(|process| {
                    process.pid == identity.pid
                        && !process.is_app_server
                        && process.executable_path.as_deref().is_some_and(|path| {
                            let candidate = ProcessIdentity {
                                pid: identity.pid,
                                executable_path: path.to_owned(),
                                started_at_ticks: identity.started_at_ticks,
                            };
                            identity.matches(&candidate)
                        })
                })
        })
}
#[cfg(target_os = "windows")]
fn capture_owner_listener_identity_sync(
    port: u16,
    endpoint: IpAddr,
) -> Option<Vec<ProcessIdentity>> {
    let pids =
        owner_listener_pids_from_rows(&crate::process_identity::tcp_port_rows(port), endpoint)?;
    let before = pids
        .iter()
        .map(|pid| crate::process_identity::process_identity(*pid))
        .collect::<Option<Vec<_>>>()?;
    let (processes, error) = crate::commands::query_codex_processes();
    if error.is_some() || !owner_shell_identities_are_verified(&before, &processes) {
        return None;
    }
    let after_pids =
        owner_listener_pids_from_rows(&crate::process_identity::tcp_port_rows(port), endpoint)?;
    if pids != after_pids {
        return None;
    }
    let after = pids
        .iter()
        .map(|pid| crate::process_identity::process_identity(*pid))
        .collect::<Option<Vec<_>>>()?;
    owner_identities_match(&before, &after).then_some(after)
}
#[cfg(not(target_os = "windows"))]
fn capture_owner_listener_identity_sync(
    _port: u16,
    _endpoint: IpAddr,
) -> Option<Vec<ProcessIdentity>> {
    // A boolean process probe cannot pin PID reuse/start identity here.
    None
}
async fn capture_owner_listener_identity(
    port: u16,
    endpoint: IpAddr,
) -> Option<Vec<ProcessIdentity>> {
    super::run_codex_native_query(move || capture_owner_listener_identity_sync(port, endpoint))
        .await
        .flatten()
}

async fn read_owner_targets_at_endpoint(
    port: u16,
    endpoint: IpAddr,
) -> Result<Vec<CdpTarget>, CodexOwnerRemoteError> {
    if !endpoint.is_loopback() {
        return Err(CodexOwnerRemoteError::Unavailable);
    }
    let client = codex_cdp_http_client().map_err(|_| CodexOwnerRemoteError::Unavailable)?;
    let response = client
        .get(format!("http://{}/json", SocketAddr::new(endpoint, port)))
        .send()
        .await
        .map_err(|_| CodexOwnerRemoteError::Unavailable)?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|size| size > OWNER_MAX_TARGET_BYTES as u64)
    {
        return Err(CodexOwnerRemoteError::Unavailable);
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| CodexOwnerRemoteError::Unavailable)?;
        if bytes.len().saturating_add(chunk.len()) > OWNER_MAX_TARGET_BYTES {
            return Err(CodexOwnerRemoteError::Unavailable);
        }
        bytes.extend_from_slice(&chunk);
    }
    let mut targets: Vec<CdpTarget> =
        serde_json::from_slice(&bytes).map_err(|_| CodexOwnerRemoteError::Unavailable)?;
    if targets.len() > 64 {
        return Err(CodexOwnerRemoteError::Unavailable);
    }
    for target in &mut targets {
        target.source_endpoint = Some(endpoint);
    }
    Ok(targets
        .into_iter()
        .filter(|target| {
            target.target_type == "page"
                && valid_identifier(&target.id)
                && target_matches_codex_desktop(target, true)
                && target
                    .web_socket_debugger_url
                    .as_deref()
                    .and_then(|url| cdp_websocket_endpoint(url, port))
                    == Some(endpoint)
        })
        .collect())
}
fn owner_targets_are_same_instance(left: &OwnerTargetProof, right: &OwnerTargetProof) -> bool {
    left.port == right.port
        && left.target.id == right.target.id
        && left.target.target_type == right.target.target_type
        && left.target.url == right.target.url
        && left.config == right.config
        && left.processes.len() == right.processes.len()
        && left
            .processes
            .iter()
            .zip(&right.processes)
            .all(|(left, right)| left.matches(right))
        && left
            .target
            .web_socket_debugger_url
            .as_deref()
            .and_then(|value| url::Url::parse(value).ok())
            .zip(
                right
                    .target
                    .web_socket_debugger_url
                    .as_deref()
                    .and_then(|value| url::Url::parse(value).ok()),
            )
            .is_some_and(|(left, right)| left.path() == right.path())
}

async fn discover_owner_target(
    db: &Arc<crate::database::Database>,
    authorize: &(impl Fn() -> bool + Sync),
) -> Result<OwnerTargetProof, CodexOwnerRemoteError> {
    if !authorize() {
        return Err(CodexOwnerRemoteError::Unauthorized);
    }
    if !cfg!(target_os = "windows") {
        return Err(CodexOwnerRemoteError::UnsupportedPlatform);
    }
    let config = capture_owner_config_identity(db)?;
    let mut selected = None;
    for port in candidate_debug_ports(DEFAULT_CODEX_DEBUG_PORT) {
        for endpoint in [
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
        ] {
            if !authorize() {
                return Err(CodexOwnerRemoteError::Unauthorized);
            }
            let Some(processes) = capture_owner_listener_identity(port, endpoint).await else {
                continue;
            };
            if !authorize() {
                return Err(CodexOwnerRemoteError::Unauthorized);
            }
            let targets = read_owner_targets_at_endpoint(port, endpoint).await?;
            if !authorize() {
                return Err(CodexOwnerRemoteError::Unauthorized);
            }
            if capture_owner_listener_identity(port, endpoint)
                .await
                .as_ref()
                != Some(&processes)
                || capture_owner_config_identity(db)? != config
            {
                return Err(CodexOwnerRemoteError::StaleView);
            }
            for target in targets {
                let candidate = OwnerTargetProof {
                    port,
                    endpoint,
                    target,
                    processes: processes.clone(),
                    config: config.clone(),
                    database: db.clone(),
                };
                if let Some(existing) = &selected {
                    // Dual-stack exposure of the very same browser target is
                    // not a second page. Select once here; after the view no
                    // alternate endpoint is ever used, even if it disappears.
                    if owner_targets_are_same_instance(existing, &candidate) {
                        continue;
                    }
                    return Err(CodexOwnerRemoteError::AmbiguousTarget);
                }
                selected = Some(candidate);
            }
        }
    }
    if !authorize() {
        return Err(CodexOwnerRemoteError::Unauthorized);
    }
    selected.ok_or(CodexOwnerRemoteError::Unavailable)
}
async fn owner_target_is_current(proof: &OwnerTargetProof) -> Result<(), CodexOwnerRemoteError> {
    if capture_owner_config_identity(&proof.database)? != proof.config
        || capture_owner_listener_identity(proof.port, proof.endpoint)
            .await
            .as_ref()
            != Some(&proof.processes)
    {
        return Err(CodexOwnerRemoteError::StaleView);
    }
    let targets = read_owner_targets_at_endpoint(proof.port, proof.endpoint).await?;
    let matches = targets
        .iter()
        .filter(|target| {
            target.id == proof.target.id
                && target.url == proof.target.url
                && target.web_socket_debugger_url == proof.target.web_socket_debugger_url
                && target.source_endpoint == Some(proof.endpoint)
        })
        .count();
    if matches != 1
        || capture_owner_listener_identity(proof.port, proof.endpoint)
            .await
            .as_ref()
            != Some(&proof.processes)
        || capture_owner_config_identity(&proof.database)? != proof.config
    {
        return Err(CodexOwnerRemoteError::StaleView);
    }
    Ok(())
}
async fn owner_send_cdp_command<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, CodexOwnerRemoteError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    socket
        .send(Message::Text(
            json!({"id":id,"method":method,"params":params})
                .to_string()
                .into(),
        ))
        .await
        .map_err(|_| CodexOwnerRemoteError::Unavailable)?;
    tokio::time::timeout(OWNER_CDP_TIMEOUT, async {
        for _ in 0..128 {
            let message = socket
                .next()
                .await
                .ok_or(CodexOwnerRemoteError::Unavailable)?
                .map_err(|_| CodexOwnerRemoteError::Unavailable)?;
            let Message::Text(text) = message else {
                continue;
            };
            if text.len() > OWNER_MAX_CDP_BYTES {
                return Err(CodexOwnerRemoteError::ContentUnavailable);
            }
            let value: Value =
                serde_json::from_str(&text).map_err(|_| CodexOwnerRemoteError::Unavailable)?;
            if value.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if value.get("error").is_some() {
                return Err(CodexOwnerRemoteError::Unavailable);
            }
            return Ok(value);
        }
        Err(CodexOwnerRemoteError::Unavailable)
    })
    .await
    .map_err(|_| CodexOwnerRemoteError::Unavailable)?
}
async fn evaluate_owner_script_with_guard<G, F>(
    websocket_url: &str,
    expression: &str,
    await_promise: bool,
    committing: bool,
    authorize: &(dyn Fn(bool) -> bool + Sync),
    guard: G,
) -> Result<Value, CodexOwnerRemoteError>
where
    G: Fn() -> F,
    F: std::future::Future<Output = Result<(), CodexOwnerRemoteError>>,
{
    guard().await?;
    if !authorize(false) {
        return Err(CodexOwnerRemoteError::Unauthorized);
    }
    let config = WebSocketConfig::default()
        .max_message_size(Some(OWNER_MAX_CDP_BYTES))
        .max_frame_size(Some(OWNER_MAX_CDP_BYTES));
    let (mut socket, _) = tokio::time::timeout(
        CDP_CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async_with_config(websocket_url, Some(config), false),
    )
    .await
    .map_err(|_| CodexOwnerRemoteError::Unavailable)?
    .map_err(|_| CodexOwnerRemoteError::Unavailable)?;
    owner_send_cdp_command(&mut socket, 1, "Runtime.enable", json!({})).await?;
    guard().await?;
    // The final native CAS is immediately before the mutation expression.
    if !authorize(committing) {
        return Err(CodexOwnerRemoteError::Unauthorized);
    }
    let evaluation = owner_send_cdp_command(&mut socket, 2, "Runtime.evaluate", json!({
        "expression":expression,"returnByValue":true,"awaitPromise":await_promise,"allowUnsafeEvalBlockedByCSP":true,
    })).await?;
    guard().await?;
    if evaluation.pointer("/result/exceptionDetails").is_some() {
        return Err(CodexOwnerRemoteError::ContentUnavailable);
    }
    evaluation
        .pointer("/result/result/value")
        .cloned()
        .ok_or(CodexOwnerRemoteError::ContentUnavailable)
}
fn owner_bridge_script(
    method: &str,
    arguments: &str,
    runtime_generation: Option<u64>,
    view_envelope: bool,
) -> String {
    let expected_generation =
        runtime_generation.map_or_else(|| "null".to_owned(), |value| value.to_string());
    format!(
        r#"(() => {{
      const own = (object, key) => {{
        if (!object || (typeof object !== 'object' && typeof object !== 'function')) return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
      }};
      const state = window[{patch_key:?}];
      const generation = own(state, 'runtimeGeneration');
      const fingerprint = own(state, 'rendererRuntimeFingerprint');
      const operation = own(state, {method:?});
      const current = () => window[{patch_key:?}] === state && own(state, 'runtimeGeneration') === generation && own(state, 'rendererRuntimeFingerprint') === fingerprint;
      if (fingerprint !== {fingerprint:?} || !Number.isSafeInteger(generation) || generation < 1 || ({expected_generation} !== null && generation !== {expected_generation}) || typeof operation !== 'function') return null;
      const result = operation.call(state, {arguments});
      if (!{view_envelope}) return result;
      return Promise.resolve(result).then(view => {{
        if (!current()) return null;
        const reference = own(view, 'viewReference');
        const inspect = own(state, 'inspectCodexOwnerRemoteViewReference');
        const binding = typeof reference === 'string' && typeof inspect === 'function' ? inspect.call(state, reference) : null;
        if (!current()) return null;
        return {{kind:'owner_native_view',runtimeGeneration:generation,runtimeFingerprint:fingerprint,view,binding}};
      }});
    }})()"#,
        patch_key = MODEL_PICKER_PATCH_KEY,
        fingerprint = codex_renderer_runtime_fingerprint(),
        view_envelope = if view_envelope { "true" } else { "false" }
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerViewEnvelope {
    kind: String,
    runtime_generation: u64,
    runtime_fingerprint: String,
    view: OwnerViewWire,
    binding: Option<OwnerReferenceWire>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerReferenceWire {
    thread_id: String,
    base_turn_id: String,
    expected_model: String,
    expected_model_provider: String,
    runtime_generation: u64,
    observed_at_ms: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerViewWire {
    kind: String,
    thread_id: String,
    observed_at_ms: u64,
    model: Option<String>,
    latest_turn_id: Option<String>,
    status: String,
    current_display: String,
    history_mode: String,
    older_content_available: bool,
    turns: Vec<OwnerTurnWire>,
    truncated: bool,
    #[serde(skip_serializing)]
    view_reference: Option<String>,
    continue_blocker: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum OwnerFailureCategory {
    ServerOverloaded,
    UsageLimit,
    RateLimit,
    InternalServerError,
    AuthenticationError,
    ContextLengthExceeded,
    InvalidRequestError,
    ConnectionError,
    Unknown,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerFailureWire {
    category: OwnerFailureCategory,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerTurnWire {
    id: String,
    status: String,
    items: Vec<OwnerItemWire>,
    truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure: Option<OwnerFailureWire>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerItemWire {
    id: Option<String>,
    #[serde(rename = "type")]
    item_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
}
fn decode_owner_view(
    value: Value,
    thread_id: &str,
) -> Result<OwnerViewEnvelope, CodexOwnerRemoteError> {
    let envelope: OwnerViewEnvelope =
        serde_json::from_value(value).map_err(|_| CodexOwnerRemoteError::ContentUnavailable)?;
    let view = &envelope.view;
    if envelope.kind != "owner_native_view"
        || envelope.runtime_generation == 0
        || envelope.runtime_fingerprint != codex_renderer_runtime_fingerprint()
        || view.kind != "snapshot"
        || view.thread_id != thread_id
        || !valid_identifier(&view.thread_id)
        || view.observed_at_ms == 0
        || view.current_display != "unavailable"
        || view.history_mode != "bounded_recent_snapshot"
        || view.older_content_available
        || !["idle", "active", "waiting", "error", "unknown"].contains(&view.status.as_str())
        || view
            .model
            .as_deref()
            .is_some_and(|model| !valid_model(model))
        || view
            .latest_turn_id
            .as_deref()
            .is_some_and(|id| !valid_identifier(id))
        || view.turns.len() > 20
        || view
            .continue_blocker
            .as_deref()
            .is_some_and(|code| !valid_identifier(code) || code.len() > 80)
    {
        return Err(CodexOwnerRemoteError::ContentUnavailable);
    }
    let mut item_count = 0usize;
    let mut text_count = 0usize;
    let mut ids = BTreeSet::new();
    for turn in &view.turns {
        if !valid_identifier(&turn.id)
            || !ids.insert(&turn.id)
            || turn.items.len() > 40
            || ![
                "completed",
                "failed",
                "interrupted",
                "inProgress",
                "unknown",
            ]
            .contains(&turn.status.as_str())
            || (turn.failure.is_some() && !matches!(turn.status.as_str(), "failed" | "interrupted"))
        {
            return Err(CodexOwnerRemoteError::ContentUnavailable);
        }
        item_count += turn.items.len();
        for item in &turn.items {
            let length = item.text.as_ref().map_or(0, |text| text.chars().count());
            text_count += length;
            if length > 4096
                || item.id.as_deref().is_some_and(|id| !valid_identifier(id))
                || ![
                    "user",
                    "assistant",
                    "plan",
                    "reasoning_summary",
                    "command",
                    "tool",
                    "agent_tool",
                    "file_change",
                    "web_search",
                    "image_generation",
                    "context_compaction",
                    "unsupported",
                ]
                .contains(&item.item_type.as_str())
                || item.status.as_deref().is_some_and(|status| {
                    ![
                        "active",
                        "completed",
                        "failed",
                        "declined",
                        "interrupted",
                        "unknown",
                    ]
                    .contains(&status)
                })
            {
                return Err(CodexOwnerRemoteError::ContentUnavailable);
            }
        }
    }
    if item_count > 120
        || text_count > 32768
        || view.latest_turn_id.as_deref() != view.turns.last().map(|turn| turn.id.as_str())
    {
        return Err(CodexOwnerRemoteError::ContentUnavailable);
    }
    // Preserve the known error display while independently requiring the exact
    // latest turn's terminal failure proof before accepting its private binding.
    let status_allows_binding = view.status == "idle"
        || (view.status == "error"
            && view
                .turns
                .last()
                .is_some_and(|turn| matches!(turn.status.as_str(), "failed" | "interrupted")));
    if let Some(binding) = &envelope.binding {
        if view.continue_blocker.is_some()
            || !status_allows_binding
            || view
                .view_reference
                .as_deref()
                .is_none_or(|value| !valid_identifier(value))
            || binding.thread_id != thread_id
            || Some(binding.base_turn_id.as_str()) != view.latest_turn_id.as_deref()
            || Some(binding.expected_model.as_str()) != view.model.as_deref()
            || !valid_model(&binding.expected_model)
            || !valid_identifier(&binding.expected_model_provider)
            || binding.runtime_generation != envelope.runtime_generation
            || binding.observed_at_ms != view.observed_at_ms
        {
            return Err(CodexOwnerRemoteError::ContentUnavailable);
        }
    } else if view.view_reference.is_some() || view.continue_blocker.is_none() {
        return Err(CodexOwnerRemoteError::ContentUnavailable);
    }
    Ok(envelope)
}
fn restrict_owner_mutation_for_storage(envelope: &mut OwnerViewEnvelope, storage_available: bool) {
    if !storage_available {
        envelope.binding = None;
        envelope.view.view_reference = None;
        envelope.view.continue_blocker = Some("mutation_evidence_unavailable".to_owned());
    }
}

pub(crate) async fn read_codex_owner_remote_view(
    db: &Arc<crate::database::Database>,
    thread_id: &str,
    authorize: impl Fn() -> bool + Send + Sync,
) -> Result<CodexOwnerRemoteView, CodexOwnerRemoteError> {
    if !valid_identifier(thread_id) {
        return Err(CodexOwnerRemoteError::InvalidSelection);
    }
    if !authorize() {
        return Err(CodexOwnerRemoteError::Unauthorized);
    }
    let epoch = recovery::capture_owner_continuation_epoch(thread_id)
        .map_err(|_| CodexOwnerRemoteError::OperationUnavailable)?;
    let target = discover_owner_target(db, &authorize).await?;
    if !authorize() || !recovery::owner_continuation_epoch_is_current(&epoch) {
        return Err(CodexOwnerRemoteError::StaleView);
    }
    let captured_at = Instant::now();
    let expression = owner_bridge_script(
        "readCodexOwnerRemoteView",
        &serde_json::to_string(thread_id).map_err(|_| CodexOwnerRemoteError::InvalidSelection)?,
        None,
        true,
    );
    let value = evaluate_owner_script_with_guard(
        target
            .target
            .web_socket_debugger_url
            .as_deref()
            .ok_or(CodexOwnerRemoteError::Unavailable)?,
        &expression,
        true,
        false,
        &|_| authorize() && recovery::owner_continuation_epoch_is_current(&epoch),
        || owner_target_is_current(&target),
    )
    .await?;
    if !authorize() {
        return Err(CodexOwnerRemoteError::Unauthorized);
    }
    if !recovery::owner_continuation_epoch_is_current(&epoch)
        || captured_at.elapsed() >= OWNER_VIEW_LIFETIME
    {
        return Err(CodexOwnerRemoteError::StaleView);
    }
    let mut envelope = decode_owner_view(value, thread_id)?;
    restrict_owner_mutation_for_storage(
        &mut envelope,
        recovery::owner_continuation_mutation_storage_available(),
    );
    let binding = envelope.binding.map(|metadata| OwnerViewBinding {
        epoch: epoch.clone(),
        target,
        reference: envelope
            .view
            .view_reference
            .clone()
            .expect("validated private reference"),
        runtime_generation: envelope.runtime_generation,
        base_turn_id: metadata.base_turn_id,
        model: metadata.expected_model,
        model_provider: metadata.expected_model_provider,
        captured_at,
    });
    // Retire only a positively acknowledged prior accepted turn, never unknown
    // mutation evidence merely because a wall-clock retention interval passed.
    if let Some(base) = envelope.view.latest_turn_id.as_deref() {
        recovery::reconcile_owner_accepted_turn(&epoch, base);
    }
    let content = serde_json::to_value(envelope.view)
        .map_err(|_| CodexOwnerRemoteError::ContentUnavailable)?;
    Ok(CodexOwnerRemoteView {
        content,
        thread_id: thread_id.to_owned(),
        binding,
    })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerConversationList {
    kind: String,
    current_display: String,
    conversations: Vec<OwnerConversation>,
    truncated: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerConversation {
    thread_id: String,
    title: Option<String>,
}
pub(crate) async fn list_codex_owner_remote_conversations(
    db: &Arc<crate::database::Database>,
    authorize: impl Fn() -> bool + Send + Sync,
) -> Result<Value, CodexOwnerRemoteError> {
    let target = discover_owner_target(db, &authorize).await?;
    let expression = owner_bridge_script("listCodexOwnerRemoteConversations", "", None, false);
    let value = evaluate_owner_script_with_guard(
        target
            .target
            .web_socket_debugger_url
            .as_deref()
            .ok_or(CodexOwnerRemoteError::Unavailable)?,
        &expression,
        true,
        false,
        &|_| authorize(),
        || owner_target_is_current(&target),
    )
    .await?;
    if !authorize() {
        return Err(CodexOwnerRemoteError::Unauthorized);
    }
    let list: OwnerConversationList =
        serde_json::from_value(value).map_err(|_| CodexOwnerRemoteError::ContentUnavailable)?;
    let mut ids = BTreeSet::new();
    if list.kind != "conversations"
        || list.current_display != "unavailable"
        || list.conversations.len() > 20
        || list.conversations.iter().any(|row| {
            !valid_identifier(&row.thread_id)
                || !ids.insert(&row.thread_id)
                || row.title.as_deref().is_some_and(|title| {
                    title.chars().count() > 160 || title.chars().any(char::is_control)
                })
        })
    {
        return Err(CodexOwnerRemoteError::ContentUnavailable);
    }
    Ok(
        json!({"kind":"conversations","currentDisplay":"unavailable","conversations":list.conversations.into_iter().map(|row| json!({"threadId":row.thread_id,"title":row.title})).collect::<Vec<_>>(),"truncated":list.truncated}),
    )
}

fn owner_job_is_bound(job: &Value, binding: &OwnerViewBinding, thread_id: &str) -> bool {
    job.get("intent").and_then(Value::as_str) == Some("OwnerContinue")
        && job.get("threadId").and_then(Value::as_str) == Some(thread_id)
        && job.get("expectedModel").and_then(Value::as_str) == Some(binding.model.as_str())
        && job.get("expectedBaseTurnId").and_then(Value::as_str)
            == Some(binding.base_turn_id.as_str())
        && job.get("baseTurnId").and_then(Value::as_str) == Some(binding.base_turn_id.as_str())
        && job.get("runtimeGeneration").and_then(Value::as_u64) == Some(binding.runtime_generation)
}
fn owner_job_outcome(
    job: &Value,
    binding: &OwnerViewBinding,
    thread_id: &str,
) -> Option<OwnerContinuationOutcome> {
    if !owner_job_is_bound(job, binding, thread_id) {
        return Some(OwnerContinuationOutcome::Uncertain);
    }
    if job.get("status").and_then(Value::as_str) != Some("completed") {
        return None;
    }
    match (
        job.get("submitted").and_then(Value::as_bool),
        job.get("mutationAttempted").and_then(Value::as_bool),
    ) {
        (Some(true), Some(true)) => match job.get("turnId").and_then(Value::as_str) {
            Some(turn_id) if valid_identifier(turn_id) && turn_id != binding.base_turn_id => {
                Some(OwnerContinuationOutcome::Submitted {
                    turn_id: turn_id.to_owned(),
                })
            }
            _ => Some(OwnerContinuationOutcome::Uncertain),
        },
        (Some(false), Some(false)) => Some(OwnerContinuationOutcome::Refused),
        _ => Some(OwnerContinuationOutcome::Uncertain),
    }
}
async fn evaluate_bound_owner_operation(
    binding: &OwnerViewBinding,
    method: &str,
    arguments: &str,
    committing: bool,
    authorize: &(dyn Fn(bool) -> bool + Sync),
) -> Result<Value, CodexOwnerRemoteError> {
    let expression =
        owner_bridge_script(method, arguments, Some(binding.runtime_generation), false);
    evaluate_owner_script_with_guard(
        binding
            .target
            .target
            .web_socket_debugger_url
            .as_deref()
            .ok_or(CodexOwnerRemoteError::StaleView)?,
        &expression,
        false,
        committing,
        authorize,
        || owner_target_is_current(&binding.target),
    )
    .await
}
trait OwnerOperationEvaluator {
    fn scope_is_current(&self) -> bool;
    fn evaluate<'a>(
        &'a self,
        method: &'a str,
        arguments: &'a str,
        committing: bool,
        authorize: &'a (dyn Fn(bool) -> bool + Sync),
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Value, CodexOwnerRemoteError>> + Send + 'a>,
    >;
}
struct NativeOwnerOperationEvaluator<'a> {
    binding: &'a OwnerViewBinding,
}
impl OwnerOperationEvaluator for NativeOwnerOperationEvaluator<'_> {
    fn scope_is_current(&self) -> bool {
        capture_owner_config_identity(&self.binding.target.database)
            .ok()
            .as_ref()
            == Some(&self.binding.target.config)
    }
    fn evaluate<'a>(
        &'a self,
        method: &'a str,
        arguments: &'a str,
        committing: bool,
        authorize: &'a (dyn Fn(bool) -> bool + Sync),
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Value, CodexOwnerRemoteError>> + Send + 'a>,
    > {
        Box::pin(evaluate_bound_owner_operation(
            self.binding,
            method,
            arguments,
            committing,
            authorize,
        ))
    }
}

macro_rules! owner_trace_gate {
    ($trace:ident, $gate:literal, $expression:expr) => {{
        let passed = $expression;
        #[cfg(test)]
        $trace.gate($gate, passed);
        passed
    }};
}
macro_rules! owner_trace_view_lifetime {
    ($trace:ident, $captured_at:expr) => {{
        let age = $captured_at.elapsed();
        #[cfg(test)]
        $trace.view_age(age);
        owner_trace_gate!($trace, "view_lifetime", age < OWNER_VIEW_LIFETIME)
    }};
}

async fn run_owner_submission<E: OwnerOperationEvaluator + Sync>(
    view: &CodexOwnerRemoteView,
    binding: &OwnerViewBinding,
    operation: &OwnerContinuationOperation,
    operation_id: &str,
    authorize: &(impl Fn() -> bool + Sync),
    evaluator: &E,
) -> OwnerContinuationOutcome {
    let operation_json =
        serde_json::to_string(operation_id).expect("serialize validated operation id");
    let reference_json =
        serde_json::to_string(&binding.reference).expect("serialize private view reference");
    #[cfg(test)]
    let trace = OwnerNativeTraceObserver { operation_id };
    let preflight = |_: bool| {
        let scope_current = evaluator.scope_is_current();
        #[cfg(test)]
        trace.preflight();
        owner_trace_gate!(trace, "auth", authorize())
            && owner_trace_gate!(trace, "scope", scope_current)
            && owner_trace_view_lifetime!(trace, binding.captured_at)
            && owner_trace_gate!(
                trace,
                "epoch",
                recovery::owner_continuation_epoch_is_current(&binding.epoch)
            )
            && owner_trace_gate!(
                trace,
                "reservation",
                recovery::owner_continuation_is_reserved(operation)
            )
    };
    #[cfg(test)]
    trace.phase("start");
    let started = evaluator
        .evaluate(
            "startCodexOwnerContinuation",
            &format!("{reference_json}, {operation_json}"),
            false,
            &preflight,
        )
        .await;
    #[cfg(test)]
    trace.evaluator_result(&started);
    let Ok(started) = started else {
        return OwnerContinuationOutcome::Refused;
    };
    if started.get("started").and_then(Value::as_bool) != Some(true) {
        return OwnerContinuationOutcome::Refused;
    }
    let deadline = Instant::now() + OWNER_JOB_WAIT;
    let mut confirmation_started = false;
    loop {
        if !preflight(false) {
            return OwnerContinuationOutcome::Refused;
        }
        #[cfg(test)]
        trace.phase(if confirmation_started {
            "read_confirm"
        } else {
            "read_prepare"
        });
        let job = evaluator
            .evaluate(
                "readCodexContinuationJob",
                &operation_json,
                false,
                &preflight,
            )
            .await;
        #[cfg(test)]
        trace.evaluator_result(&job);
        let job = match job {
            Ok(job) => job,
            Err(_) => return OwnerContinuationOutcome::Refused,
        };
        #[cfg(test)]
        trace.job(&job);
        let status = job.get("status").and_then(Value::as_str);
        if status == Some("pending") || status == Some("confirming") {
            if status == Some("confirming")
                && (!confirmation_started || !owner_job_is_bound(&job, binding, &view.thread_id))
            {
                return OwnerContinuationOutcome::Uncertain;
            }
            if Instant::now() >= deadline {
                return OwnerContinuationOutcome::Refused;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        }
        if let Some(outcome) = owner_job_outcome(&job, binding, &view.thread_id) {
            return outcome;
        }
        if !owner_job_is_bound(&job, binding, &view.thread_id)
            || job.get("submitted").and_then(Value::as_bool) != Some(false)
            || job.get("mutationAttempted").and_then(Value::as_bool) != Some(false)
            || !valid_identifier(&binding.model_provider)
        {
            return OwnerContinuationOutcome::Uncertain;
        }
        if status == Some("prepared") && !confirmation_started {
            #[cfg(test)]
            trace.phase("confirm");
            let result = evaluator
                .evaluate(
                    "confirmCodexOwnerContinuation",
                    &operation_json,
                    false,
                    &preflight,
                )
                .await;
            #[cfg(test)]
            trace.evaluator_result(&result);
            if result
                .as_ref()
                .ok()
                .and_then(|value| value.get("started"))
                .and_then(Value::as_bool)
                != Some(true)
            {
                return OwnerContinuationOutcome::Refused;
            }
            confirmation_started = true;
            continue;
        }
        if status == Some("confirmed") && confirmation_started {
            break;
        }
        return OwnerContinuationOutcome::Uncertain;
    }
    let committing = AtomicBool::new(false);
    let commit_authorization = |at_commit: bool| {
        if !preflight(false) {
            return false;
        }
        if at_commit {
            let accepted = owner_trace_gate!(
                trace,
                "commit_cas",
                recovery::authorize_owner_continuation_commit(operation)
            );
            committing.store(accepted, Ordering::Release);
            accepted
        } else {
            true
        }
    };
    #[cfg(test)]
    trace.phase("commit");
    let result = evaluator
        .evaluate(
            "commitCodexContinuation",
            &operation_json,
            true,
            &commit_authorization,
        )
        .await;
    #[cfg(test)]
    trace.evaluator_result(&result);
    if result.is_err()
        || result
            .as_ref()
            .ok()
            .and_then(|value| value.get("started"))
            .and_then(Value::as_bool)
            != Some(true)
    {
        return if committing.load(Ordering::Acquire) {
            OwnerContinuationOutcome::Uncertain
        } else {
            OwnerContinuationOutcome::Refused
        };
    }
    let deadline = Instant::now() + OWNER_JOB_WAIT;
    loop {
        // The accepted literal Continue can itself advance the proxy epoch.
        // Read-only exact acknowledgement reconciliation is allowed; never
        // reauthorize/recommit or infer mutation provenance from prompt text.
        #[cfg(test)]
        trace.phase("read_ack");
        if !owner_trace_gate!(trace, "auth", authorize()) {
            return OwnerContinuationOutcome::Uncertain;
        }
        let job = evaluator
            .evaluate("readCodexContinuationJob", &operation_json, false, &|_| {
                owner_trace_gate!(trace, "auth", authorize())
            })
            .await;
        #[cfg(test)]
        trace.evaluator_result(&job);
        let job = match job {
            Ok(job) => job,
            Err(_) => return OwnerContinuationOutcome::Uncertain,
        };
        #[cfg(test)]
        trace.job(&job);
        if !owner_trace_gate!(trace, "auth", authorize()) {
            return OwnerContinuationOutcome::Uncertain;
        }
        if let Some(outcome) = owner_job_outcome(&job, binding, &view.thread_id) {
            return outcome;
        }
        if !owner_job_is_bound(&job, binding, &view.thread_id) || Instant::now() >= deadline {
            return OwnerContinuationOutcome::Uncertain;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
struct OwnerSubmissionLease {
    operation: OwnerContinuationOperation,
    completed: bool,
}
impl OwnerSubmissionLease {
    fn finish(&mut self, outcome: OwnerContinuationOutcome) -> OwnerContinuationReceipt {
        let receipt = recovery::finish_owner_continuation(&self.operation, outcome);
        self.completed = true;
        receipt
    }
}
impl Drop for OwnerSubmissionLease {
    fn drop(&mut self) {
        if !self.completed {
            // Dropped HTTP/native futures never replay a mutation. The one
            // canonical ledger retires Reserved and retains Committing as
            // uncertain; this guard owns no second journal or retry policy.
            recovery::finish_owner_continuation(
                &self.operation,
                OwnerContinuationOutcome::Uncertain,
            );
        }
    }
}

// Test-only observers never authorize, reserve, refresh, or retry an operation.
// Only the explicitly registered exact audit operation is observed. Production
// builds contain neither this registry nor the phase/gate observation calls.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnerNativeTraceEvidence {
    phase: &'static str,
    failed_gate: Option<&'static str>,
    evaluator_error: Option<&'static str>,
    view_age_ms: Option<u32>,
    preflight_count: u32,
    last_job_status: Option<&'static str>,
}
#[cfg(test)]
impl Default for OwnerNativeTraceEvidence {
    fn default() -> Self {
        Self {
            phase: "not_started",
            failed_gate: None,
            evaluator_error: None,
            view_age_ms: None,
            preflight_count: 0,
            last_job_status: None,
        }
    }
}
#[cfg(test)]
struct OwnerNativeTraceEntry {
    operation_id: String,
    evidence: OwnerNativeTraceEvidence,
}
#[cfg(test)]
static OWNER_NATIVE_TRACE: Mutex<Option<OwnerNativeTraceEntry>> = Mutex::new(None);

/// The ignored live harness registers one freshly generated private operation.
/// Dropping this lease clears only its own registration, even on early return.
#[cfg(test)]
pub(crate) struct OwnerNativeTraceRegistration {
    operation_id: String,
}
#[cfg(test)]
impl OwnerNativeTraceRegistration {
    pub(crate) fn register(operation_id: &str) -> Option<Self> {
        if !valid_operation_id(operation_id) {
            return None;
        }
        let mut slot = OWNER_NATIVE_TRACE.lock().ok()?;
        if slot.is_some() {
            return None;
        }
        *slot = Some(OwnerNativeTraceEntry {
            operation_id: operation_id.to_owned(),
            evidence: OwnerNativeTraceEvidence::default(),
        });
        Some(Self {
            operation_id: operation_id.to_owned(),
        })
    }
    pub(crate) fn snapshot(&self) -> Option<OwnerNativeTraceEvidence> {
        let slot = OWNER_NATIVE_TRACE.lock().ok()?;
        let entry = slot.as_ref()?;
        (entry.operation_id == self.operation_id).then_some(entry.evidence)
    }
}
#[cfg(test)]
impl Drop for OwnerNativeTraceRegistration {
    fn drop(&mut self) {
        if let Ok(mut slot) = OWNER_NATIVE_TRACE.lock() {
            if slot
                .as_ref()
                .is_some_and(|entry| entry.operation_id == self.operation_id)
            {
                *slot = None;
            }
        }
    }
}
#[cfg(test)]
struct OwnerNativeTraceObserver<'a> {
    operation_id: &'a str,
}
#[cfg(test)]
impl OwnerNativeTraceObserver<'_> {
    fn update(&self, update: impl FnOnce(&mut OwnerNativeTraceEvidence)) {
        if let Ok(mut slot) = OWNER_NATIVE_TRACE.lock() {
            if let Some(entry) = slot
                .as_mut()
                .filter(|entry| entry.operation_id == self.operation_id)
            {
                update(&mut entry.evidence);
            }
        }
    }
    fn phase(&self, phase: &'static str) {
        let phase = match phase {
            "start" => "start",
            "read_prepare" => "read_prepare",
            "confirm" => "confirm",
            "read_confirm" => "read_confirm",
            "commit" => "commit",
            "read_ack" => "read_ack",
            _ => return,
        };
        self.update(|evidence| evidence.phase = phase);
    }
    fn gate(&self, gate: &'static str, passed: bool) {
        if passed {
            return;
        }
        let gate = match gate {
            "auth" => "auth",
            "scope" => "scope",
            "view_lifetime" => "view_lifetime",
            "epoch" => "epoch",
            "reservation" => "reservation",
            "commit_cas" => "commit_cas",
            _ => return,
        };
        self.update(|evidence| {
            evidence.failed_gate.get_or_insert(gate);
        });
    }
    fn preflight(&self) {
        self.update(|evidence| {
            evidence.preflight_count = evidence.preflight_count.saturating_add(1).min(1024);
        });
    }
    fn view_age(&self, age: Duration) {
        self.update(|evidence| evidence.view_age_ms = Some(age.as_millis().min(120_000) as u32));
    }
    fn evaluator_result(&self, result: &Result<Value, CodexOwnerRemoteError>) {
        if let Err(error) = result {
            self.update(|evidence| evidence.evaluator_error = Some(error.code()));
        }
    }
    fn job(&self, value: &Value) {
        let status = match value.get("status").and_then(Value::as_str) {
            None => None,
            Some("pending") => Some("pending"),
            Some("prepared") => Some("prepared"),
            Some("confirming") => Some("confirming"),
            Some("confirmed") => Some("confirmed"),
            Some("submitting") => Some("submitting"),
            Some("completed") => Some("completed"),
            Some(_) => Some("unknown"),
        };
        self.update(|evidence| evidence.last_job_status = status);
    }
}

pub(crate) async fn submit_codex_owner_continuation(
    db: &Arc<crate::database::Database>,
    view: &CodexOwnerRemoteView,
    operation_id: &str,
    authorize: impl Fn() -> bool + Send + Sync,
) -> Result<OwnerContinuationReceipt, CodexOwnerRemoteError> {
    if !valid_operation_id(operation_id) {
        return Err(CodexOwnerRemoteError::OperationUnavailable);
    }
    if !authorize() {
        return Err(CodexOwnerRemoteError::Unauthorized);
    }
    let binding = view
        .binding
        .as_ref()
        .ok_or(CodexOwnerRemoteError::StaleView)?;
    if !Arc::ptr_eq(db, &binding.target.database)
        || binding.captured_at.elapsed() >= OWNER_VIEW_LIFETIME
        || !recovery::owner_continuation_epoch_is_current(&binding.epoch)
    {
        return Err(CodexOwnerRemoteError::StaleView);
    }
    owner_target_is_current(&binding.target).await?;
    if !authorize() {
        return Err(CodexOwnerRemoteError::Unauthorized);
    }
    let reservation =
        recovery::reserve_owner_continuation(&binding.epoch, &binding.base_turn_id, operation_id)
            .map_err(|_| CodexOwnerRemoteError::OperationUnavailable)?;
    let operation = match reservation {
        OwnerContinuationReservation::AttachOnly(receipt) => return Ok(receipt),
        OwnerContinuationReservation::Reserved(operation) => operation,
    };
    let mut lease = OwnerSubmissionLease {
        operation,
        completed: false,
    };
    let outcome = run_owner_submission(
        view,
        binding,
        &lease.operation,
        operation_id,
        &authorize,
        &NativeOwnerOperationEvaluator { binding },
    )
    .await;
    let receipt = lease.finish(outcome);
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::AtomicUsize, Arc};

    fn fixture_envelope() -> Value {
        json!({"kind":"owner_native_view","runtimeGeneration":7,
            "runtimeFingerprint":codex_renderer_runtime_fingerprint(),
            "view":{"kind":"snapshot","threadId":"fixture-thread","observedAtMs":1000,
                "model":"fixture-model","latestTurnId":"base-turn","status":"idle",
                "currentDisplay":"unavailable","historyMode":"bounded_recent_snapshot","olderContentAvailable":false,
                "turns":[{"id":"base-turn","status":"completed","items":[{"id":"item-1","type":"assistant","text":"visible reply"}],"truncated":false}],
                "truncated":false,"viewReference":"view-fixture-not-a-credential","continueBlocker":null},
            "binding":{"threadId":"fixture-thread","baseTurnId":"base-turn","expectedModel":"fixture-model",
                "expectedModelProvider":"fixture-provider","runtimeGeneration":7,"observedAtMs":1000}})
    }
    fn fixture_identity(pid: u32, started_at_ticks: u64) -> ProcessIdentity {
        ProcessIdentity {
            pid,
            started_at_ticks,
            executable_path: "C:/Program Files/Codex/Codex.exe".to_owned(),
        }
    }
    fn fixture_binding() -> OwnerViewBinding {
        let thread_id = format!("owner-native-fixture-{}", uuid::Uuid::new_v4());
        OwnerViewBinding {
            epoch: recovery::capture_owner_continuation_epoch(&thread_id).unwrap(),
            target: OwnerTargetProof {
                port: 9229,
                endpoint: "127.0.0.1".parse().unwrap(),
                target: CdpTarget {
                    id: "fixture-target".to_owned(),
                    target_type: "page".to_owned(),
                    title: "".to_owned(),
                    url: "app://-/index.html".to_owned(),
                    web_socket_debugger_url: Some(
                        "ws://127.0.0.1:9229/devtools/page/fixture-target".to_owned(),
                    ),
                    source_endpoint: Some("127.0.0.1".parse().unwrap()),
                },
                processes: vec![fixture_identity(41, 100)],
                config: OwnerConfigIdentity {
                    application_root: PathBuf::from("fixture-app-root"),
                    settings_root: PathBuf::from("fixture-settings-root"),
                    config_path: PathBuf::from("fixture-config"),
                    content_hash: [1; 32],
                    provider_scope: "fixture-scope".to_owned(),
                },
                database: Arc::new(crate::database::Database::memory().unwrap()),
            },
            reference: "view-fixture-not-a-credential".to_owned(),
            runtime_generation: 7,
            base_turn_id: "base-turn".to_owned(),
            model: "fixture-model".to_owned(),
            model_provider: "fixture-provider".to_owned(),
            captured_at: Instant::now(),
        }
    }
    fn fixture_job() -> Value {
        json!({"intent":"OwnerContinue","threadId":"fixture-thread","expectedModel":"fixture-model",
            "expectedBaseTurnId":"base-turn","baseTurnId":"base-turn","runtimeGeneration":7,
            "status":"completed","submitted":true,"mutationAttempted":true,"turnId":"accepted-turn"})
    }
    #[test]
    fn native_owner_projection_strips_all_private_authority() {
        let decoded = decode_owner_view(fixture_envelope(), "fixture-thread").unwrap();
        let public = serde_json::to_value(decoded.view).unwrap();
        let text = public.to_string();
        assert!(!text.contains("viewReference"));
        assert!(!text.contains("view-fixture-not-a-credential"));
        assert!(!text.contains("fixture-provider"));
        assert!(!text.contains("runtimeFingerprint"));
        assert_eq!(public["turns"][0]["items"][0]["text"], "visible reply");
        assert_eq!(public["currentDisplay"], "unavailable");
    }
    #[test]
    fn native_owner_unavailable_mutation_storage_keeps_reading_without_a_capability() {
        let mut envelope = decode_owner_view(fixture_envelope(), "fixture-thread").unwrap();
        restrict_owner_mutation_for_storage(&mut envelope, false);
        assert!(envelope.binding.is_none());
        assert!(envelope.view.view_reference.is_none());
        let public = serde_json::to_value(envelope.view).unwrap();
        assert_eq!(public["continueBlocker"], "mutation_evidence_unavailable");
        assert_eq!(public["turns"][0]["items"][0]["text"], "visible reply");
    }
    #[test]
    fn native_owner_projection_rejects_stale_or_broadened_contracts() {
        for (pointer, replacement) in [
            ("/runtimeFingerprint", json!("stale-runtime")),
            ("/runtimeGeneration", json!(0)),
            ("/view/threadId", json!("different-thread")),
            ("/view/currentDisplay", json!("current")),
            ("/view/olderContentAvailable", json!(true)),
            ("/view/latestTurnId", json!("different-base")),
            ("/binding/baseTurnId", json!("different-base")),
            ("/binding/runtimeGeneration", json!(8)),
            ("/binding/expectedModel", json!("different-model")),
            ("/binding/expectedModelProvider", json!("")),
            ("/view/status", json!("active")),
            ("/view/turns/0/items/0/type", json!("hidden_reasoning")),
        ] {
            let mut envelope = fixture_envelope();
            *envelope.pointer_mut(pointer).unwrap() = replacement;
            assert_eq!(
                decode_owner_view(envelope, "fixture-thread").err(),
                Some(CodexOwnerRemoteError::ContentUnavailable),
                "{pointer}"
            );
        }
        let mut envelope = fixture_envelope();
        envelope["view"]["providerSettings"] = json!({"redacted":true});
        assert_eq!(
            decode_owner_view(envelope, "fixture-thread").err(),
            Some(CodexOwnerRemoteError::ContentUnavailable)
        );
        assert_eq!(
            decode_owner_view(fixture_envelope(), "different-thread").err(),
            Some(CodexOwnerRemoteError::ContentUnavailable)
        );
    }
    #[test]
    fn native_owner_projection_bounds_turns_items_and_text() {
        for text in ["x".repeat(4097), "界".repeat(4097)] {
            let mut envelope = fixture_envelope();
            envelope["view"]["turns"][0]["items"][0]["text"] = json!(text);
            assert_eq!(
                decode_owner_view(envelope, "fixture-thread").err(),
                Some(CodexOwnerRemoteError::ContentUnavailable)
            );
        }
        let mut envelope = fixture_envelope();
        envelope["view"]["turns"][0]["items"] = json!(vec![
            json!({"id":"fixture-item","type":"assistant","text":"x".repeat(4096)});
            9
        ]);
        assert_eq!(
            decode_owner_view(envelope, "fixture-thread").err(),
            Some(CodexOwnerRemoteError::ContentUnavailable)
        );
        let mut envelope = fixture_envelope();
        envelope["view"]["turns"][0]["items"] = json!(vec![
            json!({"id":"fixture-item","type":"unsupported","status":"unknown"});
            41
        ]);
        assert_eq!(
            decode_owner_view(envelope, "fixture-thread").err(),
            Some(CodexOwnerRemoteError::ContentUnavailable)
        );
    }
    #[test]
    fn native_owner_failure_wire_accepts_fixed_categories_on_failed_turns() {
        for category in [
            "server_overloaded",
            "usage_limit",
            "rate_limit",
            "internal_server_error",
            "authentication_error",
            "context_length_exceeded",
            "invalid_request_error",
            "connection_error",
            "unknown",
        ] {
            for status in ["failed", "interrupted"] {
                let mut envelope = fixture_envelope();
                envelope["view"]["status"] = json!("error");
                envelope["view"]["turns"][0]["status"] = json!(status);
                envelope["view"]["turns"][0]["failure"] = json!({"category": category});
                let decoded = decode_owner_view(envelope, "fixture-thread")
                    .expect("fixed failure category must decode");
                let public = serde_json::to_value(decoded.view).unwrap();
                assert_eq!(public["turns"][0]["failure"], json!({"category": category}));
            }
        }
    }

    #[test]
    fn native_owner_failure_wire_rejects_raw_details_and_nonfailure_turns() {
        for failure in [
            json!({"category":"invented"}),
            json!({"category":"unknown", "message":"secret"}),
            json!({"category":"unknown", "retryable":true}),
            json!({"category":"unknown", "retryAfterSeconds":1}),
            json!({"category":"unknown", "source":{"provider":"secret"}}),
            json!({"category":null}),
            json!({"category":1}),
            json!({}),
            json!([]),
        ] {
            let mut envelope = fixture_envelope();
            envelope["view"]["status"] = json!("error");
            envelope["view"]["turns"][0]["status"] = json!("failed");
            envelope["view"]["turns"][0]["failure"] = failure;
            assert_eq!(
                decode_owner_view(envelope, "fixture-thread").err(),
                Some(CodexOwnerRemoteError::ContentUnavailable)
            );
        }
        for status in ["completed", "inProgress", "unknown"] {
            let mut envelope = fixture_envelope();
            envelope["view"]["turns"][0]["failure"] = json!({"category":"unknown"});
            envelope["view"]["turns"][0]["status"] = json!(status);
            assert_eq!(
                decode_owner_view(envelope, "fixture-thread").err(),
                Some(CodexOwnerRemoteError::ContentUnavailable),
                "failure on {status} must be rejected"
            );
        }
    }

    #[test]
    fn native_owner_error_binding_accepts_only_latest_failed_or_interrupted() {
        for status in ["failed", "interrupted"] {
            let mut envelope = fixture_envelope();
            envelope["view"]["status"] = json!("error");
            envelope["view"]["turns"][0]["status"] = json!(status);
            let decoded = decode_owner_view(envelope, "fixture-thread")
                .expect("terminal_failure_binding_must_be_readable");
            assert_eq!(decoded.view.status, "error");
            assert!(decoded.binding.is_some());
            assert!(decoded.view.continue_blocker.is_none());
        }
    }
    #[test]
    fn native_owner_error_binding_rejects_nonfailure_and_inconsistent_proofs() {
        for status in ["completed", "inProgress", "unknown", "invalid"] {
            let mut envelope = fixture_envelope();
            envelope["view"]["status"] = json!("error");
            envelope["view"]["turns"][0]["status"] = json!(status);
            assert_eq!(
                decode_owner_view(envelope, "fixture-thread").err(),
                Some(CodexOwnerRemoteError::ContentUnavailable),
                "{status}"
            );
        }
        for (pointer, replacement) in [
            ("/view/status", json!("active")),
            ("/view/status", json!("waiting")),
            ("/view/status", json!("unknown")),
            ("/view/status", json!("notLoaded")),
            ("/view/turns", json!([])),
            ("/view/turns/0/status", Value::Null),
            ("/view/continueBlocker", json!("thread_not_idle")),
            ("/view/viewReference", Value::Null),
            ("/view/latestTurnId", json!("other-turn")),
            ("/binding/baseTurnId", json!("other-turn")),
            ("/binding/threadId", json!("other-thread")),
            ("/binding/expectedModel", json!("other-model")),
            ("/binding/expectedModelProvider", json!("")),
            ("/binding/runtimeGeneration", json!(8)),
            ("/binding/observedAtMs", json!(1001)),
            ("/runtimeFingerprint", json!("stale-runtime")),
            ("/binding", Value::Null),
        ] {
            let mut envelope = fixture_envelope();
            envelope["view"]["status"] = json!("error");
            envelope["view"]["turns"][0]["status"] = json!("failed");
            *envelope.pointer_mut(pointer).expect("fixture_pointer") = replacement;
            assert_eq!(
                decode_owner_view(envelope, "fixture-thread").err(),
                Some(CodexOwnerRemoteError::ContentUnavailable),
                "{pointer}"
            );
        }
        // An older failure never authorizes continuation of a later completed turn.
        let mut envelope = fixture_envelope();
        envelope["view"]["status"] = json!("error");
        envelope["view"]["turns"][0]["status"] = json!("failed");
        envelope["view"]["turns"]
            .as_array_mut()
            .expect("fixture_turns")
            .push(json!({"id":"latest-turn","status":"completed","items":[],"truncated":false}));
        envelope["view"]["latestTurnId"] = json!("latest-turn");
        envelope["binding"]["baseTurnId"] = json!("latest-turn");
        assert_eq!(
            decode_owner_view(envelope, "fixture-thread").err(),
            Some(CodexOwnerRemoteError::ContentUnavailable)
        );
    }
    #[test]
    fn native_owner_binding_requires_complete_private_idle_proof() {
        let mut envelope = fixture_envelope();
        envelope["binding"] = Value::Null;
        assert_eq!(
            decode_owner_view(envelope, "fixture-thread").err(),
            Some(CodexOwnerRemoteError::ContentUnavailable)
        );
        let mut envelope = fixture_envelope();
        envelope["binding"] = Value::Null;
        envelope["view"]["viewReference"] = Value::Null;
        envelope["view"]["continueBlocker"] = json!("thread_not_idle");
        envelope["view"]["status"] = json!("active");
        assert!(decode_owner_view(envelope, "fixture-thread").is_ok());
    }
    #[test]
    fn native_owner_identity_rejects_pid_reuse_path_change_and_unreadable_shell() {
        let before = vec![fixture_identity(41, 100)];
        assert!(owner_identities_match(&before, &before));
        assert!(!owner_identities_match(
            &before,
            &[fixture_identity(41, 101)]
        ));
        assert!(!owner_identities_match(
            &before,
            &[fixture_identity(42, 100)]
        ));
        let mut replaced = fixture_identity(41, 100);
        replaced.executable_path = "C:/Other/Program.exe".to_owned();
        assert!(!owner_identities_match(&before, &[replaced]));
        let mut process = crate::commands::CodexAppServerProcessDiagnostics {
            pid: 41,
            name: Some("Codex.exe".to_owned()),
            executable_path: Some(before[0].executable_path.clone()),
            command_line: None,
            started_at: None,
            is_app_server: false,
        };
        assert!(owner_shell_identities_are_verified(
            &before,
            &[process.clone()]
        ));
        process.is_app_server = true;
        assert!(!owner_shell_identities_are_verified(&before, &[process]));
        assert!(!owner_shell_identities_are_verified(&before, &[]));
    }
    #[test]
    fn native_owner_listener_proof_is_endpoint_specific_and_requires_positive_listen() {
        let row = crate::process_identity::TcpPortRow {
            family: "ipv4",
            state: "LISTEN",
            local_address: "127.0.0.1:9229".to_owned(),
            remote_address: "0.0.0.0:0".to_owned(),
            pid: 41,
        };
        assert_eq!(
            owner_listener_pids_from_rows(&[row.clone()], "127.0.0.1".parse().unwrap()),
            Some(vec![41])
        );
        assert_eq!(
            owner_listener_pids_from_rows(&[row.clone()], "::1".parse().unwrap()),
            None
        );
        assert_eq!(
            owner_listener_pids_from_rows(&[row.clone()], "192.0.2.1".parse().unwrap()),
            None
        );
        for state in ["UNKNOWN", "CLOSED", "ESTABLISHED"] {
            let mut changed = row.clone();
            changed.state = state;
            assert_eq!(
                owner_listener_pids_from_rows(&[changed], "127.0.0.1".parse().unwrap()),
                None
            );
        }
        let mut changed = row;
        changed.pid = 0;
        assert_eq!(
            owner_listener_pids_from_rows(&[changed], "127.0.0.1".parse().unwrap()),
            None
        );
    }
    #[test]
    fn native_owner_ack_requires_exact_intent_base_runtime_and_accepted_turn() {
        let binding = fixture_binding();
        assert!(
            matches!(owner_job_outcome(&fixture_job(),&binding,"fixture-thread"),Some(OwnerContinuationOutcome::Submitted{turn_id}) if turn_id=="accepted-turn")
        );
        for (key, value) in [
            ("intent", json!("AutoRecovery")),
            ("threadId", json!("different")),
            ("baseTurnId", json!("different")),
            ("runtimeGeneration", json!(8)),
            ("turnId", json!("base-turn")),
            ("turnId", Value::Null),
            ("mutationAttempted", json!(false)),
        ] {
            let mut job = fixture_job();
            job[key] = value;
            assert!(
                matches!(
                    owner_job_outcome(&job, &binding, "fixture-thread"),
                    Some(OwnerContinuationOutcome::Uncertain)
                ),
                "{key}"
            );
        }
        let mut refused = fixture_job();
        refused["submitted"] = json!(false);
        refused["mutationAttempted"] = json!(false);
        refused.as_object_mut().unwrap().remove("turnId");
        assert!(matches!(
            owner_job_outcome(&refused, &binding, "fixture-thread"),
            Some(OwnerContinuationOutcome::Refused)
        ));
        let mut submitting = fixture_job();
        submitting["status"] = json!("submitting");
        assert!(owner_job_outcome(&submitting, &binding, "fixture-thread").is_none());
    }
    #[test]
    fn native_owner_ttl_uses_monotonic_instant() {
        let mut binding = fixture_binding();
        binding.captured_at = Instant::now() - OWNER_VIEW_LIFETIME;
        let view = CodexOwnerRemoteView {
            content: json!({}),
            thread_id: "fixture-thread".to_owned(),
            binding: Some(binding),
        };
        assert!(!view.can_continue());
        assert_eq!(view.thread_id(), "fixture-thread");
        assert_eq!(view.content(), &json!({}));
    }
    #[test]
    fn native_owner_bridge_is_fixed_method_and_own_data_runtime_guarded() {
        let expression = owner_bridge_script(
            "readCodexOwnerRemoteView",
            r#""fixture-thread""#,
            Some(7),
            true,
        );
        assert!(expression.contains("Object.getOwnPropertyDescriptor"));
        assert!(expression.contains("generation !== 7"));
        assert!(expression.contains("inspectCodexOwnerRemoteViewReference"));
        assert!(expression.contains("runtimeFingerprint"));
        assert!(!expression.contains("fetch("));
        assert!(!expression.contains("turn/start"));
    }

    #[test]
    fn native_owner_initial_discovery_deduplicates_only_identical_dual_stack_target() {
        let left = fixture_binding().target;
        let mut right = left.clone();
        right.endpoint = "::1".parse().unwrap();
        right.target.source_endpoint = Some(right.endpoint);
        right.target.web_socket_debugger_url =
            Some("ws://[::1]:9229/devtools/page/fixture-target".to_owned());
        assert!(owner_targets_are_same_instance(&left, &right));
        let mut different = right.clone();
        different.target.id = "different-target".to_owned();
        assert!(!owner_targets_are_same_instance(&left, &different));
        let mut replaced = right.clone();
        replaced.processes[0].started_at_ticks += 1;
        assert!(!owner_targets_are_same_instance(&left, &replaced));
        let mut other_socket = right;
        other_socket.target.web_socket_debugger_url =
            Some("ws://[::1]:9229/devtools/page/different-target".to_owned());
        assert!(!owner_targets_are_same_instance(&left, &other_socket));
    }
    #[test]
    fn native_owner_dropped_reservation_retires_without_a_sender() {
        let thread_id = format!("owner-native-drop-before-{}", uuid::Uuid::new_v4());
        let operation_id = format!("owner-native-op-{}", uuid::Uuid::new_v4());
        let epoch = recovery::capture_owner_continuation_epoch(&thread_id).unwrap();
        let OwnerContinuationReservation::Reserved(operation) =
            recovery::reserve_owner_continuation(&epoch, "base-turn", &operation_id).unwrap()
        else {
            panic!("expected new reservation")
        };
        drop(OwnerSubmissionLease {
            operation,
            completed: false,
        });
        let receipt = recovery::read_owner_continuation_receipt(&operation_id).unwrap();
        assert_eq!(receipt.status, recovery::OwnerContinuationStatus::Refused);
        assert!(!receipt.mutation_attempted);
    }
    #[test]
    fn native_owner_dropped_commit_retains_uncertainty_without_replay() {
        let thread_id = format!("owner-native-drop-after-{}", uuid::Uuid::new_v4());
        let operation_id = format!("owner-native-op-{}", uuid::Uuid::new_v4());
        let epoch = recovery::capture_owner_continuation_epoch(&thread_id).unwrap();
        let OwnerContinuationReservation::Reserved(operation) =
            recovery::reserve_owner_continuation(&epoch, "base-turn", &operation_id).unwrap()
        else {
            panic!("expected new reservation")
        };
        assert!(recovery::authorize_owner_continuation_commit(&operation));
        drop(OwnerSubmissionLease {
            operation,
            completed: false,
        });
        let receipt = recovery::read_owner_continuation_receipt(&operation_id).unwrap();
        assert_eq!(receipt.status, recovery::OwnerContinuationStatus::Uncertain);
        assert!(receipt.mutation_attempted);
        assert!(!receipt.submitted);
        assert!(matches!(
            recovery::reserve_owner_continuation(&epoch, "base-turn", &operation_id),
            Ok(OwnerContinuationReservation::AttachOnly(_))
        ));
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum FixtureOwnerResult {
        Submitted,
        LostAck,
        RevokePrecommit,
        RevokeDuringConfirmation,
        ScopeChangeDuringConfirmation,
        PausePreparation,
        PauseAfterCommit,
    }
    struct FixtureOwnerEvaluator {
        result: FixtureOwnerResult,
        thread_id: String,
        session: Arc<AtomicBool>,
        committed: AtomicBool,
        confirmed: AtomicBool,
        scope_valid: AtomicBool,
        mutations: Arc<AtomicUsize>,
        paused: Arc<tokio::sync::Notify>,
    }
    impl OwnerOperationEvaluator for FixtureOwnerEvaluator {
        fn scope_is_current(&self) -> bool {
            self.scope_valid.load(Ordering::SeqCst)
        }
        fn evaluate<'a>(
            &'a self,
            method: &'a str,
            _arguments: &'a str,
            committing: bool,
            authorize: &'a (dyn Fn(bool) -> bool + Sync),
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<Value, CodexOwnerRemoteError>> + Send + 'a>,
        > {
            Box::pin(async move {
                if !authorize(false) {
                    return Err(CodexOwnerRemoteError::Unauthorized);
                }
                assert_eq!(committing, method == "commitCodexContinuation");
                match method {
                    "startCodexOwnerContinuation" => Ok(json!({"started":true})),
                    "confirmCodexOwnerContinuation" => {
                        // This fixture await models the real final exact read.
                        // Authorization must be checked again only after it.
                        tokio::task::yield_now().await;
                        if self.result == FixtureOwnerResult::PausePreparation {
                            self.paused.notify_one();
                            std::future::pending::<()>().await;
                        }
                        if self.result == FixtureOwnerResult::RevokeDuringConfirmation {
                            self.session.store(false, Ordering::SeqCst);
                        }
                        if self.result == FixtureOwnerResult::ScopeChangeDuringConfirmation {
                            self.scope_valid.store(false, Ordering::SeqCst);
                        }
                        self.confirmed.store(true, Ordering::SeqCst);
                        Ok(json!({"started":true}))
                    }
                    "commitCodexContinuation" => {
                        if self.result == FixtureOwnerResult::RevokePrecommit {
                            self.session.store(false, Ordering::SeqCst);
                        }
                        if !authorize(true) {
                            return Err(CodexOwnerRemoteError::Unauthorized);
                        }
                        self.mutations.fetch_add(1, Ordering::SeqCst);
                        self.committed.store(true, Ordering::SeqCst);
                        if self.result == FixtureOwnerResult::LostAck {
                            Err(CodexOwnerRemoteError::Unavailable)
                        } else {
                            Ok(json!({"started":true}))
                        }
                    }
                    "readCodexContinuationJob" => {
                        let mut job = fixture_job();
                        job["threadId"] = json!(self.thread_id);
                        if !self.committed.load(Ordering::SeqCst) {
                            job["status"] = json!(if self.confirmed.load(Ordering::SeqCst) {
                                "confirmed"
                            } else {
                                "prepared"
                            });
                            job["submitted"] = json!(false);
                            job["mutationAttempted"] = json!(false);
                            job.as_object_mut().unwrap().remove("turnId");
                        } else if self.result == FixtureOwnerResult::PauseAfterCommit {
                            self.paused.notify_one();
                            std::future::pending::<()>().await;
                        }
                        Ok(job)
                    }
                    _ => panic!("unexpected owner executor operation"),
                }
            })
        }
    }
    fn fixture_owner_executor(
        result: FixtureOwnerResult,
    ) -> (
        CodexOwnerRemoteView,
        OwnerSubmissionLease,
        String,
        FixtureOwnerEvaluator,
    ) {
        let thread_id = format!("owner-executor-fixture-{}", uuid::Uuid::new_v4());
        let operation_id = format!("owner-fixture-op-{}", uuid::Uuid::new_v4());
        let mut binding = fixture_binding();
        binding.epoch = recovery::capture_owner_continuation_epoch(&thread_id).unwrap();
        let OwnerContinuationReservation::Reserved(operation) =
            recovery::reserve_owner_continuation(&binding.epoch, "base-turn", &operation_id)
                .unwrap()
        else {
            panic!("expected new fixture reservation")
        };
        let evaluator = FixtureOwnerEvaluator {
            result,
            thread_id: thread_id.clone(),
            session: Arc::new(AtomicBool::new(true)),
            committed: AtomicBool::new(false),
            confirmed: AtomicBool::new(false),
            scope_valid: AtomicBool::new(true),
            mutations: Arc::new(AtomicUsize::new(0)),
            paused: Arc::new(tokio::sync::Notify::new()),
        };
        let view = CodexOwnerRemoteView {
            content: json!({}),
            thread_id,
            binding: Some(binding),
        };
        (
            view,
            OwnerSubmissionLease {
                operation,
                completed: false,
            },
            operation_id,
            evaluator,
        )
    }
    #[tokio::test]
    async fn native_owner_shared_executor_submits_once_and_second_action_only_attaches() {
        let (view, mut lease, operation_id, evaluator) =
            fixture_owner_executor(FixtureOwnerResult::Submitted);
        let binding = view.binding.as_ref().unwrap();
        let outcome = run_owner_submission(
            &view,
            binding,
            &lease.operation,
            &operation_id,
            &|| evaluator.session.load(Ordering::SeqCst),
            &evaluator,
        )
        .await;
        let receipt = lease.finish(outcome);
        assert_eq!(receipt.status, recovery::OwnerContinuationStatus::Submitted);
        assert_eq!(evaluator.mutations.load(Ordering::SeqCst), 1);
        let another = format!("owner-fixture-op-{}", uuid::Uuid::new_v4());
        assert!(matches!(
            recovery::reserve_owner_continuation(&binding.epoch, "base-turn", &another),
            Ok(OwnerContinuationReservation::AttachOnly(_))
        ));
        assert_eq!(evaluator.mutations.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn native_owner_shared_executor_lost_ack_is_uncertain_and_never_replayed() {
        let (view, mut lease, operation_id, evaluator) =
            fixture_owner_executor(FixtureOwnerResult::LostAck);
        let binding = view.binding.as_ref().unwrap();
        let outcome = run_owner_submission(
            &view,
            binding,
            &lease.operation,
            &operation_id,
            &|| evaluator.session.load(Ordering::SeqCst),
            &evaluator,
        )
        .await;
        let receipt = lease.finish(outcome);
        assert_eq!(receipt.status, recovery::OwnerContinuationStatus::Uncertain);
        assert_eq!(evaluator.mutations.load(Ordering::SeqCst), 1);
        let another = format!("owner-fixture-op-{}", uuid::Uuid::new_v4());
        assert!(matches!(
            recovery::reserve_owner_continuation(&binding.epoch, "base-turn", &another),
            Ok(OwnerContinuationReservation::AttachOnly(_))
        ));
    }
    #[tokio::test]
    async fn native_owner_shared_executor_precommit_revocation_never_mutates() {
        let (view, mut lease, operation_id, evaluator) =
            fixture_owner_executor(FixtureOwnerResult::RevokePrecommit);
        let outcome = run_owner_submission(
            &view,
            view.binding.as_ref().unwrap(),
            &lease.operation,
            &operation_id,
            &|| evaluator.session.load(Ordering::SeqCst),
            &evaluator,
        )
        .await;
        let receipt = lease.finish(outcome);
        assert_eq!(receipt.status, recovery::OwnerContinuationStatus::Refused);
        assert_eq!(evaluator.mutations.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn native_owner_final_read_await_cannot_outlive_session_or_provider_scope_authorization()
    {
        for result in [
            FixtureOwnerResult::RevokeDuringConfirmation,
            FixtureOwnerResult::ScopeChangeDuringConfirmation,
        ] {
            let (view, mut lease, operation_id, evaluator) = fixture_owner_executor(result);
            let outcome = run_owner_submission(
                &view,
                view.binding.as_ref().unwrap(),
                &lease.operation,
                &operation_id,
                &|| evaluator.session.load(Ordering::SeqCst),
                &evaluator,
            )
            .await;
            let receipt = lease.finish(outcome);
            assert_eq!(receipt.status, recovery::OwnerContinuationStatus::Refused);
            assert_eq!(evaluator.mutations.load(Ordering::SeqCst), 0);
            assert!(evaluator.confirmed.load(Ordering::SeqCst));
        }
    }
    #[tokio::test]
    async fn native_owner_shared_executor_cancellation_preserves_exact_mutation_phase() {
        for (result, expected, mutations) in [
            (
                FixtureOwnerResult::PausePreparation,
                recovery::OwnerContinuationStatus::Refused,
                0,
            ),
            (
                FixtureOwnerResult::PauseAfterCommit,
                recovery::OwnerContinuationStatus::Uncertain,
                1,
            ),
        ] {
            let (view, mut lease, operation_id, evaluator) = fixture_owner_executor(result);
            let paused = evaluator.paused.clone();
            let mutation_count = evaluator.mutations.clone();
            let lookup_id = operation_id.clone();
            let task = tokio::spawn(async move {
                let outcome = run_owner_submission(
                    &view,
                    view.binding.as_ref().unwrap(),
                    &lease.operation,
                    &operation_id,
                    &|| evaluator.session.load(Ordering::SeqCst),
                    &evaluator,
                )
                .await;
                let receipt = lease.finish(outcome);
                receipt
            });
            tokio::time::timeout(Duration::from_secs(3), paused.notified())
                .await
                .unwrap();
            task.abort();
            let _ = task.await;
            let receipt = recovery::read_owner_continuation_receipt(&lookup_id).unwrap();
            assert_eq!(receipt.status, expected);
            assert_eq!(mutation_count.load(Ordering::SeqCst), mutations);
        }
    }

    #[test]
    #[serial_test::serial(owner_native_trace)]
    fn native_owner_trace_is_exact_operation_raii_and_bounded_without_private_content() {
        let operation = format!("owner-{}", uuid::Uuid::new_v4().simple());
        let other = format!("owner-{}", uuid::Uuid::new_v4().simple());
        let registration = OwnerNativeTraceRegistration::register(&operation).unwrap();
        assert!(OwnerNativeTraceRegistration::register(&other).is_none());
        let observer = OwnerNativeTraceObserver {
            operation_id: &other,
        };
        observer.phase("commit");
        observer.preflight();
        observer.gate("auth", false);
        assert_eq!(
            registration.snapshot(),
            Some(OwnerNativeTraceEvidence::default())
        );

        let observer = OwnerNativeTraceObserver {
            operation_id: &operation,
        };
        observer.phase("untrusted phase must not be serialized");
        observer.gate("untrusted gate must not be serialized", false);
        observer.job(&json!({"status":"untrusted status must not be serialized"}));
        observer.view_age(Duration::from_secs(999));
        for _ in 0..1100 {
            observer.preflight();
        }
        let evidence = registration.snapshot().unwrap();
        assert_eq!(evidence.phase, "not_started");
        assert_eq!(evidence.failed_gate, None);
        assert_eq!(evidence.last_job_status, Some("unknown"));
        assert_eq!(evidence.view_age_ms, Some(120_000));
        assert_eq!(evidence.preflight_count, 1024);
        let value = serde_json::to_value(evidence).unwrap();
        let keys = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        assert_eq!(
            keys,
            BTreeSet::from([
                "phase",
                "failedGate",
                "evaluatorError",
                "viewAgeMs",
                "preflightCount",
                "lastJobStatus",
            ])
        );
        let encoded = value.to_string();
        for private in [operation.as_str(), other.as_str(), "untrusted"] {
            assert!(!encoded.contains(private));
        }
        drop(registration);
        let next = OwnerNativeTraceRegistration::register(&other).unwrap();
        observer.phase("start");
        assert_eq!(next.snapshot(), Some(OwnerNativeTraceEvidence::default()));
        drop(next);
        assert!(OwnerNativeTraceRegistration::register("").is_none());
    }

    struct SinglePreflightEvaluator {
        scope_valid: bool,
        authorized_evaluations: AtomicUsize,
        observations: Mutex<Vec<&'static str>>,
    }
    impl OwnerOperationEvaluator for SinglePreflightEvaluator {
        fn scope_is_current(&self) -> bool {
            self.observations.lock().unwrap().push("scope");
            self.scope_valid
        }
        fn evaluate<'a>(
            &'a self,
            _method: &'a str,
            _arguments: &'a str,
            _committing: bool,
            authorize: &'a (dyn Fn(bool) -> bool + Sync),
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<Value, CodexOwnerRemoteError>> + Send + 'a>,
        > {
            Box::pin(async move {
                if !authorize(false) {
                    return Err(CodexOwnerRemoteError::Unauthorized);
                }
                self.authorized_evaluations.fetch_add(1, Ordering::SeqCst);
                // The test stops after exactly one preflight; it has no sender.
                Err(CodexOwnerRemoteError::Unavailable)
            })
        }
    }
    #[tokio::test]
    #[serial_test::serial(owner_native_trace)]
    async fn native_owner_trace_preflight_keeps_one_auth_call_scope_guard_and_short_circuit_order()
    {
        for expected_gate in [
            None,
            Some("auth"),
            Some("scope"),
            Some("view_lifetime"),
            Some("epoch"),
            Some("reservation"),
        ] {
            let (mut view, mut lease, operation_id, _) =
                fixture_owner_executor(FixtureOwnerResult::Submitted);
            let binding = view.binding.as_mut().unwrap();
            if matches!(expected_gate, Some("auth" | "scope" | "view_lifetime")) {
                binding.captured_at = Instant::now() - OWNER_VIEW_LIFETIME;
            }
            if matches!(
                expected_gate,
                Some("auth" | "scope" | "view_lifetime" | "epoch")
            ) {
                recovery::begin_turn(&view.thread_id, false);
            }
            if expected_gate == Some("reservation") {
                lease.finish(OwnerContinuationOutcome::Refused);
            }
            let registration = OwnerNativeTraceRegistration::register(&operation_id).unwrap();
            let evaluator = SinglePreflightEvaluator {
                scope_valid: !matches!(expected_gate, Some("auth" | "scope")),
                authorized_evaluations: AtomicUsize::new(0),
                observations: Mutex::new(Vec::new()),
            };
            let auth_calls = AtomicUsize::new(0);
            let authorize = || {
                auth_calls.fetch_add(1, Ordering::SeqCst);
                evaluator.observations.lock().unwrap().push("auth");
                expected_gate != Some("auth")
            };
            let outcome = run_owner_submission(
                &view,
                view.binding.as_ref().unwrap(),
                &lease.operation,
                &operation_id,
                &authorize,
                &evaluator,
            )
            .await;
            assert!(matches!(outcome, OwnerContinuationOutcome::Refused));
            assert_eq!(auth_calls.load(Ordering::SeqCst), 1);
            assert_eq!(*evaluator.observations.lock().unwrap(), ["scope", "auth"]);
            assert_eq!(
                evaluator.authorized_evaluations.load(Ordering::SeqCst),
                usize::from(expected_gate.is_none())
            );
            let trace = registration.snapshot().unwrap();
            assert_eq!(trace.phase, "start");
            assert_eq!(trace.failed_gate, expected_gate);
            assert_eq!(trace.preflight_count, 1);
            assert_eq!(
                trace.evaluator_error,
                Some(if expected_gate.is_some() {
                    "owner_unauthorized"
                } else {
                    "codex_unavailable"
                })
            );
            if matches!(expected_gate, Some("auth" | "scope")) {
                assert_eq!(trace.view_age_ms, None);
            } else if expected_gate == Some("view_lifetime") {
                assert!(trace.view_age_ms.unwrap() >= OWNER_VIEW_LIFETIME.as_millis() as u32);
            } else {
                assert!(trace.view_age_ms.unwrap() < OWNER_VIEW_LIFETIME.as_millis() as u32);
            }
        }
    }
    #[tokio::test]
    #[serial_test::serial(owner_native_trace)]
    async fn native_owner_trace_registered_and_unregistered_executors_keep_identical_auth_counts_and_one_send(
    ) {
        for registered in [false, true] {
            let (view, mut lease, operation_id, evaluator) =
                fixture_owner_executor(FixtureOwnerResult::Submitted);
            let registration_operation = if registered {
                operation_id.clone()
            } else {
                format!("owner-{}", uuid::Uuid::new_v4().simple())
            };
            let registration =
                OwnerNativeTraceRegistration::register(&registration_operation).unwrap();
            let auth_calls = AtomicUsize::new(0);
            let outcome = run_owner_submission(
                &view,
                view.binding.as_ref().unwrap(),
                &lease.operation,
                &operation_id,
                &|| {
                    auth_calls.fetch_add(1, Ordering::SeqCst);
                    evaluator.session.load(Ordering::SeqCst)
                },
                &evaluator,
            )
            .await;
            let receipt = lease.finish(outcome);
            assert_eq!(receipt.status, recovery::OwnerContinuationStatus::Submitted);
            assert_eq!(evaluator.mutations.load(Ordering::SeqCst), 1);
            assert_eq!(auth_calls.load(Ordering::SeqCst), 11);
            let trace = registration.snapshot().unwrap();
            if registered {
                assert_eq!(trace.phase, "read_ack");
                assert_eq!(trace.failed_gate, None);
                assert_eq!(trace.evaluator_error, None);
                assert_eq!(trace.preflight_count, 8);
                assert_eq!(trace.last_job_status, Some("completed"));
            } else {
                assert_eq!(trace, OwnerNativeTraceEvidence::default());
            }
        }
    }
    #[tokio::test]
    #[serial_test::serial(owner_native_trace)]
    async fn native_owner_trace_records_exact_post_await_scope_refusal_without_mutation() {
        let (view, mut lease, operation_id, evaluator) =
            fixture_owner_executor(FixtureOwnerResult::ScopeChangeDuringConfirmation);
        let registration = OwnerNativeTraceRegistration::register(&operation_id).unwrap();
        let outcome = run_owner_submission(
            &view,
            view.binding.as_ref().unwrap(),
            &lease.operation,
            &operation_id,
            &|| evaluator.session.load(Ordering::SeqCst),
            &evaluator,
        )
        .await;
        let receipt = lease.finish(outcome);
        assert_eq!(receipt.status, recovery::OwnerContinuationStatus::Refused);
        assert_eq!(evaluator.mutations.load(Ordering::SeqCst), 0);
        let trace = registration.snapshot().unwrap();
        assert_eq!(trace.phase, "confirm");
        assert_eq!(trace.failed_gate, Some("scope"));
        assert_eq!(trace.preflight_count, 5);
        assert_eq!(trace.last_job_status, Some("prepared"));
    }

    async fn fixture_cdp_server() -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let evaluations = Arc::new(AtomicUsize::new(0));
        let count = evaluations.clone();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            while let Some(Ok(Message::Text(text))) = socket.next().await {
                let command: Value = serde_json::from_str(&text).unwrap();
                let response = if command["method"] == "Runtime.evaluate" {
                    count.fetch_add(1, Ordering::SeqCst);
                    json!({"id":command["id"],"result":{"result":{"value":{"fixture":true}}}})
                } else {
                    json!({"id":command["id"],"result":{}})
                };
                if socket
                    .send(Message::Text(response.to_string().into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        (url, evaluations, server)
    }
    #[tokio::test]
    async fn native_owner_checks_target_after_runtime_enable_before_any_expression() {
        let (url, evaluations, server) = fixture_cdp_server().await;
        let calls = AtomicUsize::new(0);
        let authorized = AtomicUsize::new(0);
        let result = evaluate_owner_script_with_guard(
            &url,
            "fixture-safe-expression",
            false,
            true,
            &|at_commit| {
                if at_commit {
                    authorized.fetch_add(1, Ordering::SeqCst);
                }
                true
            },
            || async {
                if calls.fetch_add(1, Ordering::SeqCst) == 1 {
                    Err(CodexOwnerRemoteError::StaleView)
                } else {
                    Ok(())
                }
            },
        )
        .await;
        assert_eq!(result.err(), Some(CodexOwnerRemoteError::StaleView));
        assert_eq!(evaluations.load(Ordering::SeqCst), 0);
        assert_eq!(authorized.load(Ordering::SeqCst), 0);
        server.await.unwrap();
    }
    #[tokio::test]
    async fn native_owner_session_revocation_at_final_precommit_sends_no_expression() {
        let (url, evaluations, server) = fixture_cdp_server().await;
        let result = evaluate_owner_script_with_guard(
            &url,
            "fixture-safe-expression",
            false,
            true,
            &|at_commit| !at_commit,
            || async { Ok(()) },
        )
        .await;
        assert_eq!(result.err(), Some(CodexOwnerRemoteError::Unauthorized));
        assert_eq!(evaluations.load(Ordering::SeqCst), 0);
        server.await.unwrap();
    }
    #[tokio::test]
    async fn native_owner_rechecks_target_after_awaited_response_without_retry() {
        let (url, evaluations, server) = fixture_cdp_server().await;
        let calls = AtomicUsize::new(0);
        let result = evaluate_owner_script_with_guard(
            &url,
            "fixture-safe-expression",
            true,
            false,
            &|_| true,
            || async {
                if calls.fetch_add(1, Ordering::SeqCst) == 2 {
                    Err(CodexOwnerRemoteError::StaleView)
                } else {
                    Ok(())
                }
            },
        )
        .await;
        assert_eq!(result.err(), Some(CodexOwnerRemoteError::StaleView));
        assert_eq!(evaluations.load(Ordering::SeqCst), 1);
        server.await.unwrap();
    }
}
