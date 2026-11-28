use futures::future::join_all;
use serde::Serialize;
use std::collections::HashSet;
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{watch, Mutex};

use crate::codex_desktop::{
    candidate_debug_ports, collect_native_usage_limit_candidates, deactivate_codex_model_picker,
    detect_running_codex_main_process_for_guardian, discover_codex_page_targets_for_guardian,
    inspect_codex_renderer_compatibility, load_cc_switch_model_catalog_projection_outcome,
    try_inject_on_candidate_ports, CdpTarget, CodexModelCatalogLoadOutcome,
    CodexModelCatalogProjection, CodexModelPickerDiagnosticsCounts, CodexModelPickerReadiness,
    CodexRendererCompatibilityObservation, NativeUsageLimitSnapshot, DEFAULT_CODEX_DEBUG_PORT,
};
use crate::proxy::codex_turn_recovery::{
    clear_native_usage_limit_candidates, proxy_usage_limit_turns,
    replace_native_usage_limit_candidates,
};

const GUARDIAN_CHECK_INTERVAL: Duration = Duration::from_secs(3);
const GUARDIAN_IDLE_MAX_INTERVAL: Duration = Duration::from_secs(12);
// Native usage-limit scans enumerate every loaded thread. Keep renderer and
// picker verification at the normal cadence, but bound this heavier observer
// to one scan per three guardian cycles unless its source set changes.
const NATIVE_USAGE_SCAN_INTERVAL: Duration = Duration::from_secs(9);
// A refresh may queue behind a running cycle before probing the renderer.
const NATIVE_USAGE_REFRESH_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, PartialEq, Eq)]
enum GuardianCycleState {
    DesktopMissing,
    VerifiedRendererUnavailable,
    WatchingRenderer,
}

#[derive(Default)]
struct GuardianCadence {
    previous: Option<(GuardianCycleState, Duration)>,
}

impl GuardianCadence {
    fn after_cycle(&mut self, state: GuardianCycleState) -> Duration {
        // Keep live renderer verification at full cadence. Only consecutive
        // equivalent idle checks back off the native process/listener probes.
        let delay = match self.previous {
            Some((previous, delay))
                if state != GuardianCycleState::WatchingRenderer && state == previous =>
            {
                (delay * 2).min(GUARDIAN_IDLE_MAX_INTERVAL)
            }
            _ => GUARDIAN_CHECK_INTERVAL,
        };
        self.previous = Some((state, delay));
        delay
    }
}

/// 守护上报给前端的即时状态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexGuardianStatus {
    pub active: bool,
    pub codex_running: bool,
    pub cdp_available: bool,
    pub injected_target_count: usize,
    pub injected: bool,
    pub picker_ready_target_count: usize,
    pub picker_status: CodexModelPickerReadiness,
    pub picker_diagnostics: Option<CodexModelPickerDiagnosticsCounts>,
    pub picker_verification_issues: Vec<String>,
    pub last_event: String,
    pub message: String,
}

/// 守护内部持有的可变更状态。
struct GuardianInner {
    injected_target_ids: Vec<String>,
    injected_catalog_fingerprint: Option<String>,
    inject_generation: u64,
    last_picker_readiness_signature: Option<String>,
    native_usage_scan: NativeUsageScanCadence,
}

#[derive(Default)]
struct NativeUsageScanCadence {
    next_due_at: Option<Instant>,
    source_signature: Vec<String>,
    expedited_incomplete: bool,
    source_set_shrank: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum NativeUsageScan {
    Skip,
    Scan,
    Clear,
    Incomplete,
}

impl NativeUsageScanCadence {
    fn next_scan(
        &mut self,
        sources: &[&str],
        source_enumeration_complete: bool,
        force: bool,
        now: Instant,
    ) -> NativeUsageScan {
        if sources.is_empty() {
            if !source_enumeration_complete {
                return if force {
                    NativeUsageScan::Incomplete
                } else {
                    NativeUsageScan::Skip
                };
            }
            if self.source_signature.is_empty() && !force {
                return NativeUsageScan::Skip;
            }
            // Losing every verified destination invalidates its native proof.
            // A failed read from a still verified destination remains partial.
            self.reset();
            return NativeUsageScan::Clear;
        }
        if force {
            self.next_due_at = None;
        }
        if self.should_scan(sources, now) {
            NativeUsageScan::Scan
        } else {
            NativeUsageScan::Skip
        }
    }

    fn should_scan(&mut self, sources: &[&str], now: Instant) -> bool {
        let mut signature = sources
            .iter()
            .map(|source| (*source).to_string())
            .collect::<Vec<_>>();
        signature.sort_unstable();
        self.source_set_shrank = !self.source_signature.is_empty()
            && self
                .source_signature
                .iter()
                .any(|source| signature.binary_search(source).is_err());
        let source_changed = self.source_signature != signature;
        let due = self
            .next_due_at
            .is_none_or(|next_due_at| now >= next_due_at);
        if source_changed || due {
            if source_changed {
                self.expedited_incomplete = false;
            }
            self.source_signature = signature;
            self.next_due_at = Some(now + NATIVE_USAGE_SCAN_INTERVAL);
            true
        } else {
            false
        }
    }

    fn reset(&mut self) {
        *self = Self::default();
    }

    fn expedite(&mut self) {
        self.next_due_at = None;
        self.expedited_incomplete = false;
    }

    fn finish_scan(&mut self, complete: bool) {
        if complete {
            self.expedited_incomplete = false;
        } else if !self.expedited_incomplete {
            self.expedited_incomplete = true;
            self.next_due_at = None;
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PickerManagement {
    Observe,
    Manage,
    ReleaseRestoredPicker,
}

/// 守护的外部句柄；丢弃后守护自动停止。
pub(crate) struct GuardianHandle {
    shutdown_tx: watch::Sender<bool>,
    picker_management: watch::Sender<PickerManagement>,
    native_usage_refresh: watch::Sender<Option<NativeUsageRefresh>>,
    pub(crate) status: Arc<Mutex<CodexGuardianStatus>>,
}

type NativeUsageRefreshResult = Result<(), NativeUsageRefreshError>;
type NativeUsageRefresh = watch::Sender<Option<NativeUsageRefreshResult>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NativeUsageRefreshError {
    ScanTimedOut,
    ObserverStopped,
    ObserverUnavailable,
    DesktopNotRunning,
    DesktopNotLinked,
}

fn take_native_usage_refresh(
    pending: &watch::Sender<Option<NativeUsageRefresh>>,
) -> Option<NativeUsageRefresh> {
    let mut refresh = None;
    pending.send_if_modified(|state| {
        refresh = state.take();
        refresh.is_some()
    });
    refresh
}

async fn wait_for_native_usage_refresh(
    mut refresh: watch::Receiver<Option<NativeUsageRefreshResult>>,
    mut shutdown: watch::Receiver<bool>,
) -> NativeUsageRefreshResult {
    if *shutdown.borrow() {
        return Err(NativeUsageRefreshError::ObserverStopped);
    }
    let completion = async {
        let result = refresh
            .wait_for(Option::is_some)
            .await
            .map_err(|_| NativeUsageRefreshError::ObserverStopped)?;
        (*result).expect("refresh completed")
    };
    tokio::select! {
        biased;
        _ = shutdown.changed() => Err(NativeUsageRefreshError::ObserverStopped),
        result = tokio::time::timeout(NATIVE_USAGE_REFRESH_TIMEOUT, completion) => {
            result.map_err(|_| NativeUsageRefreshError::ScanTimedOut)?
        }
    }
}

/// 启动 Codex 桌面模型菜单生命周期守护。
///
/// 守护不会静默终止正在工作的 Codex。
/// 在检测到新 renderer target、目录变化或 renderer 重载时幂等重新注入；
/// 若 CDP 不可用则记录原因并等待。
pub(crate) fn start_codex_guardian(manage_model_picker: bool) -> GuardianHandle {
    let (handle, shutdown_rx) = GuardianHandle::new(manage_model_picker);
    let native_usage_refresh = handle.native_usage_refresh.clone();
    let inner = Arc::new(Mutex::new(GuardianInner {
        injected_target_ids: Vec::new(),
        injected_catalog_fingerprint: None,
        inject_generation: 0,
        last_picker_readiness_signature: None,
        native_usage_scan: NativeUsageScanCadence::default(),
    }));

    let status = handle.status.clone();
    let management = handle.picker_management.clone();
    tauri::async_runtime::spawn(async move {
        guardian_loop(status, inner, shutdown_rx, management, native_usage_refresh).await;
    });

    handle
}

impl GuardianHandle {
    fn new(manage_model_picker: bool) -> (Self, watch::Receiver<bool>) {
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let status = Arc::new(Mutex::new(CodexGuardianStatus {
            active: true,
            codex_running: false,
            cdp_available: false,
            injected_target_count: 0,
            injected: false,
            picker_ready_target_count: 0,
            picker_status: CodexModelPickerReadiness::Unverified,
            picker_diagnostics: None,
            picker_verification_issues: Vec::new(),
            last_event: "守护已启动".into(),
            message: "守护已启动，等待 Codex Desktop...".into(),
        }));
        (
            Self {
                shutdown_tx,
                picker_management: watch::Sender::new(if manage_model_picker {
                    PickerManagement::Manage
                } else {
                    PickerManagement::Observe
                }),
                native_usage_refresh: watch::Sender::new(None),
                status,
            },
            shutdown_rx,
        )
    }

    #[cfg(test)]
    pub(crate) fn for_test(manage_model_picker: bool) -> Self {
        Self::new(manage_model_picker).0
    }

    #[cfg(test)]
    pub(crate) fn manages_model_picker(&self) -> bool {
        *self.picker_management.borrow() == PickerManagement::Manage
    }

    pub(crate) fn set_model_picker_management(&self, enabled: bool) {
        self.picker_management.send_modify(|mode| {
            if enabled {
                *mode = PickerManagement::Manage;
            } else if *mode == PickerManagement::Manage {
                *mode = PickerManagement::ReleaseRestoredPicker;
            }
        });
    }

    pub(crate) fn request_native_usage_scan(
        &self,
    ) -> impl Future<Output = Result<(), NativeUsageRefreshError>> + Send + 'static {
        let mut receiver = None;
        self.native_usage_refresh.send_if_modified(|pending| {
            let is_new = pending.is_none();
            let refresh = pending.get_or_insert_with(|| watch::Sender::new(None));
            receiver = Some(refresh.subscribe());
            is_new
        });
        wait_for_native_usage_refresh(
            receiver.expect("refresh subscribed"),
            self.shutdown_tx.subscribe(),
        )
    }

    pub(crate) fn stop(self) {
        let _ = self.shutdown_tx.send(true);
        clear_native_usage_limit_candidates();
    }
}

async fn guardian_loop(
    status: Arc<Mutex<CodexGuardianStatus>>,
    inner: Arc<Mutex<GuardianInner>>,
    mut shutdown: watch::Receiver<bool>,
    picker_management: watch::Sender<PickerManagement>,
    native_usage_refresh: watch::Sender<Option<NativeUsageRefresh>>,
) {
    let mut cadence = GuardianCadence::default();
    let mut refresh_requests = native_usage_refresh.subscribe();
    while !*shutdown.borrow() {
        let delay = cadence.after_cycle(
            run_guardian_cycle(
                &status,
                &inner,
                &shutdown,
                &picker_management,
                &native_usage_refresh,
            )
            .await,
        );

        tokio::select! {
            _ = tokio::time::sleep(delay) => {},
            _ = refresh_requests.wait_for(Option::is_some) => {},
            _ = shutdown.changed() => break,
        }
    }

    let mut s = status.lock().await;
    s.active = false;
    s.picker_ready_target_count = 0;
    s.picker_status = CodexModelPickerReadiness::Unverified;
    s.picker_diagnostics = None;
    s.picker_verification_issues.clear();
    s.last_event = "守护已停止".into();
    s.message = "守护已停止".into();
}

struct GuardianTargetDestinations<'a> {
    picker: Vec<(String, String)>,
    native_usage: Vec<&'a str>,
    native_usage_enumeration_complete: bool,
}

fn collect_guardian_target_destinations(
    verified_pages: &[CdpTarget],
) -> GuardianTargetDestinations<'_> {
    let mut picker = Vec::new();
    let mut native_usage = Vec::new();
    let mut native_usage_enumeration_complete = true;
    let mut seen_picker_ids = HashSet::new();
    let mut seen_websocket_urls = HashSet::new();
    for page in verified_pages {
        let Some(websocket_url) = page.web_socket_debugger_url.as_deref() else {
            native_usage_enumeration_complete = false;
            continue;
        };
        if seen_picker_ids.insert(page.id.as_str()) {
            picker.push((page.id.clone(), websocket_url.to_string()));
        }
        // Different verified listeners can report the same target ID. Observe
        // each distinct WebSocket destination once, even across debug ports.
        if seen_websocket_urls.insert(websocket_url) {
            native_usage.push(websocket_url);
        }
    }
    GuardianTargetDestinations {
        picker,
        native_usage,
        native_usage_enumeration_complete,
    }
}

fn publish_native_usage_limit_candidates(
    shutdown: &watch::Receiver<bool>,
    scan: Result<NativeUsageLimitSnapshot, NativeUsageRefreshError>,
    refresh: Option<&NativeUsageRefresh>,
) {
    // Serialize publication and acknowledgement with shutdown. A stopped
    // observer cannot replace the cleared snapshot or acknowledge a refresh.
    let stopped = shutdown.borrow();
    if !*stopped {
        let result = match scan {
            Ok(snapshot) => {
                replace_native_usage_limit_candidates(Some(snapshot));
                Ok(())
            }
            Err(
                error @ (NativeUsageRefreshError::DesktopNotRunning
                | NativeUsageRefreshError::DesktopNotLinked),
            ) => {
                clear_native_usage_limit_candidates();
                Err(error)
            }
            Err(error) => {
                replace_native_usage_limit_candidates(None);
                Err(error)
            }
        };
        if let Some(refresh) = refresh {
            refresh.send_replace(Some(result));
        }
    }
}

async fn scan_native_usage_limit_sources(
    inner: &Arc<Mutex<GuardianInner>>,
    shutdown: &watch::Receiver<bool>,
    sources: &[&str],
    source_enumeration_complete: bool,
    force: bool,
    refresh: Option<&NativeUsageRefresh>,
) {
    let scan = {
        let mut guard = inner.lock().await;
        guard.native_usage_scan.next_scan(
            sources,
            source_enumeration_complete,
            force || refresh.is_some(),
            Instant::now(),
        )
    };
    let result = match scan {
        NativeUsageScan::Skip => return,
        NativeUsageScan::Clear => Err(NativeUsageRefreshError::DesktopNotLinked),
        NativeUsageScan::Incomplete => Err(NativeUsageRefreshError::ObserverUnavailable),
        NativeUsageScan::Scan => {
            let proxy_turns_json = serde_json::to_string(&proxy_usage_limit_turns()).expect(
                "serializing proxy usage limit turn identifiers and timestamps cannot fail",
            );
            let authorize = |_| !*shutdown.borrow();
            let snapshots = join_all(sources.iter().copied().map(|source| {
                collect_native_usage_limit_candidates(source, &proxy_turns_json, &authorize)
            }))
            .await;
            let mut guard = inner.lock().await;
            let combined = combine_native_usage_limit_snapshots(
                snapshots,
                source_enumeration_complete,
                !guard.native_usage_scan.source_set_shrank,
            );
            // An incomplete bridge install gets one expedited retry. Consecutive
            // partial scans return to the normal cadence.
            guard
                .native_usage_scan
                .finish_scan(combined.as_ref().is_some_and(|snapshot| snapshot.complete));
            combined.ok_or(NativeUsageRefreshError::ObserverUnavailable)
        }
    };
    publish_native_usage_limit_candidates(shutdown, result, refresh);
}

fn combine_native_usage_limit_snapshots(
    snapshots: Vec<Option<NativeUsageLimitSnapshot>>,
    source_enumeration_complete: bool,
    source_set_complete: bool,
) -> Option<NativeUsageLimitSnapshot> {
    let all_sources_responded = snapshots.iter().all(Option::is_some);
    let mut snapshots = snapshots.into_iter().flatten();
    let mut combined = snapshots.next()?;
    combined.complete &=
        all_sources_responded && source_enumeration_complete && source_set_complete;
    for snapshot in snapshots {
        combined.complete &= snapshot.complete;
        combined.candidates.extend(snapshot.candidates);
        combined
            .conflicting_thread_ids
            .extend(snapshot.conflicting_thread_ids);
        combined
            .stale_proxy_turns
            .extend(snapshot.stale_proxy_turns);
    }
    Some(combined)
}

fn finish_restored_picker_release(picker_management: &watch::Sender<PickerManagement>) {
    picker_management.send_modify(|mode| {
        if *mode == PickerManagement::ReleaseRestoredPicker {
            *mode = PickerManagement::Observe;
        }
    });
}

async fn run_guardian_cycle(
    status: &Arc<Mutex<CodexGuardianStatus>>,
    inner: &Arc<Mutex<GuardianInner>>,
    shutdown: &watch::Receiver<bool>,
    picker_management: &watch::Sender<PickerManagement>,
    native_usage_refresh: &watch::Sender<Option<NativeUsageRefresh>>,
) -> GuardianCycleState {
    // A request can only be fulfilled by discovery that starts after the click.
    // Callers queued before discovery share that scan's own completion channel.
    let refresh = take_native_usage_refresh(native_usage_refresh);
    let refresh = refresh.as_ref();

    // 1. 检查 Codex 主进程是否在运行。
    let running = detect_running_codex_main_process_for_guardian().await;
    if !matches!(running, Ok(Some(_))) {
        let confirmed_missing = matches!(running, Ok(None));
        if confirmed_missing {
            publish_native_usage_limit_candidates(
                shutdown,
                Err(NativeUsageRefreshError::DesktopNotRunning),
                refresh,
            );
        } else {
            scan_native_usage_limit_sources(inner, shutdown, &[], false, false, refresh).await;
        }
        let mut s = status.lock().await;
        if confirmed_missing {
            s.codex_running = false;
        }
        s.cdp_available = false;
        s.injected = false;
        s.injected_target_count = 0;
        s.picker_ready_target_count = 0;
        s.picker_status = CodexModelPickerReadiness::Unverified;
        s.picker_diagnostics = None;
        s.picker_verification_issues.clear();
        if !confirmed_missing {
            s.last_event = "Codex 运行状态未核验".into();
            s.message = "无法核验 Codex Desktop 进程，等待下次检查...".into();
            return GuardianCycleState::VerifiedRendererUnavailable;
        }
        s.last_event = "Codex 未运行".into();
        s.message = "Codex Desktop 未运行，等待用户启动...".into();
        // 进程消失时清理已知 target，下次启动不会跳过新 target。
        let mut guard = inner.lock().await;
        guard.injected_target_ids.clear();
        guard.injected_catalog_fingerprint = None;
        guard.last_picker_readiness_signature = None;
        guard.native_usage_scan.reset();
        return GuardianCycleState::DesktopMissing;
    }

    // 2. 保留 websocket 地址，以便同一 target 重载后核验 renderer 状态。
    let ports = candidate_debug_ports(DEFAULT_CODEX_DEBUG_PORT);
    let discovery = discover_codex_page_targets_for_guardian(&ports).await;
    let mut verified_pages = Vec::new();
    let mut target_ports = Vec::new();
    for (port, pages) in discovery.pages_by_port {
        target_ports.push(port);
        verified_pages.extend(pages);
    }
    let cdp_available = !target_ports.is_empty();

    // The continuation runtime also serves native providers. Its candidates
    // are independent of the model picker catalog's availability or ownership.
    // This observer enumerates every loaded thread, so it has its own bounded
    // cadence; renderer/picker checks below still run on every guardian cycle.
    let destinations = collect_guardian_target_destinations(&verified_pages);
    let native_usage_enumeration_complete =
        discovery.complete && destinations.native_usage_enumeration_complete;
    let GuardianTargetDestinations {
        picker: current_targets,
        native_usage: native_usage_sources,
        ..
    } = destinations;
    scan_native_usage_limit_sources(
        inner,
        shutdown,
        &native_usage_sources,
        native_usage_enumeration_complete,
        false,
        refresh,
    )
    .await;

    if !cdp_available {
        let mut s = status.lock().await;
        s.codex_running = true;
        s.cdp_available = false;
        s.injected = false;
        s.injected_target_count = 0;
        s.picker_ready_target_count = 0;
        s.picker_status = CodexModelPickerReadiness::Unverified;
        s.picker_diagnostics = None;
        s.picker_verification_issues.clear();
        if discovery.complete {
            s.last_event = "Codex 运行中但无 CDP".into();
            s.message = "Codex Desktop 正在运行但未开放 CDP 调试端口；CCSM 不会静默终止 Codex，请退出后从 CCSM 启动或等待下次 CCSM 启动 Codex 时自动注入。".into();
        } else {
            s.last_event = "Codex CDP 状态未核验".into();
            s.message = "无法核验 Codex Desktop 调试端口，等待下次检查...".into();
        }
        let mut guard = inner.lock().await;
        guard.injected_target_ids.clear();
        guard.injected_catalog_fingerprint = None;
        guard.last_picker_readiness_signature = None;
        return GuardianCycleState::VerifiedRendererUnavailable;
    }

    // A retained observer reconciles the restored picker configuration before
    // ending picker management after takeover.
    let management = *picker_management.borrow();
    let catalog = match (management != PickerManagement::Observe)
        .then(load_cc_switch_model_catalog_projection_outcome)
    {
        Some(Ok(CodexModelCatalogLoadOutcome::Managed(catalog))) => Some(catalog),
        Some(Ok(CodexModelCatalogLoadOutcome::Unmanaged { model_provider })) => {
            if *picker_management.borrow() != PickerManagement::Observe && !*shutdown.borrow() {
                let released = release_unmanaged_picker(
                    &current_targets,
                    model_provider.as_deref(),
                    status,
                    inner,
                )
                .await;
                if released && management == PickerManagement::ReleaseRestoredPicker {
                    finish_restored_picker_release(picker_management);
                }
            }
            return GuardianCycleState::WatchingRenderer;
        }
        Some(Err(error)) => {
            let mut s = status.lock().await;
            if report_catalog_load_failure(&mut s, &error.to_string()) {
                log::warn!("Codex 守护: 模型目录加载失败: {error}");
            }
            return GuardianCycleState::WatchingRenderer;
        }
        None => None,
    };
    let Some(catalog) = catalog else {
        let mut guard = inner.lock().await;
        guard.injected_target_ids.clear();
        guard.injected_catalog_fingerprint = None;
        guard.last_picker_readiness_signature = None;
        drop(guard);
        let mut s = status.lock().await;
        s.codex_running = true;
        s.cdp_available = true;
        s.injected = false;
        s.injected_target_count = 0;
        s.picker_ready_target_count = 0;
        s.picker_status = CodexModelPickerReadiness::NotRequired;
        s.picker_diagnostics = None;
        s.picker_verification_issues.clear();
        s.last_event = "已核验 Codex 恢复观察目标".into();
        s.message = "正在观察 Codex Desktop 中断的会话。".into();
        return GuardianCycleState::WatchingRenderer;
    };
    // 3. 同时比较 target 和目录。renderer 补丁持有模型目录状态，因此 Provider
    // 目录变化时，即使 target ID 不变也必须重新注入。
    let catalog_fingerprint = catalog.fingerprint();
    let mut guard = inner.lock().await;
    guard.injected_target_ids.retain(|id| {
        current_targets
            .iter()
            .any(|(current_id, _)| current_id == id)
    });
    let new_ids: Vec<String> = current_targets
        .iter()
        .filter(|(id, _)| !guard.injected_target_ids.contains(id))
        .map(|(id, _)| id.clone())
        .collect();
    let injected_catalog_fingerprint = guard.injected_catalog_fingerprint.clone();
    let catalog_changed =
        injected_catalog_fingerprint.as_deref() != Some(catalog_fingerprint.as_str());
    drop(guard);

    // New-document CDP scripts belong to the installing connection. Its socket
    // is short-lived, so an unchanged target ID cannot prove a reloaded page is
    // still patched. Check every current renderer before reporting it healthy.
    let observations = if new_ids.is_empty() && !catalog_changed {
        current_renderer_targets(&current_targets, &catalog).await
    } else {
        RendererTargetsObservation::default()
    };
    let renderers_current = observations.installed_target_ids.len() == current_targets.len();

    if !guardian_should_inject(
        &new_ids,
        injected_catalog_fingerprint.as_deref(),
        &catalog_fingerprint,
        renderers_current,
    ) {
        let mut guard = inner.lock().await;
        guard.injected_target_ids = observations.installed_target_ids.clone();
        record_picker_readiness_transition(&mut guard, &observations);
        drop(guard);
        let s = &mut *status.lock().await;
        s.codex_running = true;
        s.cdp_available = true;
        apply_renderer_observation(s, &observations);
        s.last_event = "CDP renderer 安装状态与模型选择器就绪状态已核验".into();
        s.message = renderer_observation_message(&observations);
        if management == PickerManagement::ReleaseRestoredPicker {
            finish_restored_picker_release(picker_management);
        }
        return GuardianCycleState::WatchingRenderer;
    }

    // 4. 有新 target、目录变化或 renderer 状态丢失时尝试注入。
    // The renderer can reload without changing its target ID or websocket URL.
    // Expedite the heavier observer after reinjection so the fresh compatibility
    // layer is sampled immediately instead of waiting for the normal 9-second
    // native scan interval.
    {
        let mut guard = inner.lock().await;
        guard.native_usage_scan.expedite();
    }
    let gen = {
        let mut guard = inner.lock().await;
        guard.inject_generation += 1;
        guard.inject_generation
    };

    {
        let mut s = status.lock().await;
        s.codex_running = true;
        s.cdp_available = true;
        apply_renderer_observation(&mut s, &observations);
        s.last_event = if catalog_changed {
            format!("检测到模型目录变化，发起注入 (gen {gen})")
        } else if new_ids.is_empty() {
            format!("检测到 renderer 兼容层失效，发起注入 (gen {gen})")
        } else {
            format!("检测到新 CDP target，发起注入 (gen {gen})")
        };
        s.message = if catalog_changed {
            "Provider 模型目录已更新，正在刷新现有 Codex Desktop renderer...".into()
        } else if new_ids.is_empty() {
            "Codex Desktop renderer 已重载或状态无法核验，正在恢复模型菜单兼容层...".into()
        } else {
            format!(
                "检测到 {} 个新 CDP renderer target，正在注入...",
                new_ids.len()
            )
        };
    }

    let mut injection = None;
    for port in target_ports {
        if *picker_management.borrow() != management || *shutdown.borrow() {
            return GuardianCycleState::WatchingRenderer;
        }
        if let Some(result) = try_inject_on_candidate_ports(&catalog, &[port]).await {
            if result.injected || injection.is_none() {
                injection = Some(result);
            }
        }
    }
    let observations = current_renderer_targets(&current_targets, &catalog).await;
    let injected_target_count = observations.installed_target_ids.len();
    {
        let mut guard = inner.lock().await;
        // A successful port-level attempt does not prove every discovered
        // target was injected. Unconfirmed targets must be retried next cycle.
        guard.injected_target_ids = observations.installed_target_ids.clone();
        guard.injected_catalog_fingerprint =
            (injected_target_count > 0).then_some(catalog_fingerprint);
        record_picker_readiness_transition(&mut guard, &observations);
    }
    {
        let mut s = status.lock().await;
        s.codex_running = true;
        s.cdp_available = true;
        apply_renderer_observation(&mut s, &observations);
    }
    let injection_succeeded = injection.as_ref().is_some_and(|result| result.injected);
    match injection {
        Some(result) if result.injected => {
            let mut s = status.lock().await;
            if injected_target_count == current_targets.len() {
                s.last_event = format!("兼容层安装已核验 (gen {gen})");
                s.message = renderer_observation_message(&observations);
            } else {
                s.last_event = format!("注入核验未完成 (gen {gen})");
                s.message = format!(
                    "已核验 {}/{} 个 renderer target；未核验的 target 将在下次守护检查时重试。",
                    injected_target_count,
                    current_targets.len()
                );
            }
            log::info!(
                "Codex 守护: 模型菜单已注入 target={:?}, models={}",
                result.target_id,
                result.model_count
            );
        }
        Some(result) => {
            let mut s = status.lock().await;
            s.codex_running = true;
            s.cdp_available = true;
            s.last_event = format!("注入未完成 (gen {gen})");
            s.message = format!("模型菜单注入尝试未完成: {}", result.message);
            log::warn!("Codex 守护: 注入未完成: {}", result.message);
        }
        None => {
            let mut s = status.lock().await;
            s.codex_running = true;
            s.cdp_available = true;
            s.last_event = format!("注入失败 (gen {gen})");
            s.message = "模型菜单注入失败：未找到可注入的 CDP target。".into();
            log::warn!("Codex 守护: 注入失败，未找到可注入的 target");
        }
    }
    if injection_succeeded && injected_target_count > 0 {
        // This rescan reuses the earlier inventory. A newer manual request
        // must wait for fresh source discovery.
        scan_native_usage_limit_sources(
            inner,
            shutdown,
            &native_usage_sources,
            native_usage_enumeration_complete,
            true,
            None,
        )
        .await;
    }
    GuardianCycleState::WatchingRenderer
}

/// Update the live failure status every time, but log only a new failure.
fn report_catalog_load_failure(status: &mut CodexGuardianStatus, error: &str) -> bool {
    const EVENT: &str = "模型目录加载失败";
    let message = format!("无法加载 CCSM 模型目录: {error}");
    let changed = status.last_event != EVENT || status.message != message;
    status.codex_running = true;
    status.cdp_available = true;
    status.picker_ready_target_count = 0;
    status.picker_status = CodexModelPickerReadiness::Unverified;
    status.picker_diagnostics = None;
    status.picker_verification_issues.clear();
    status.last_event = EVENT.into();
    status.message = message;
    changed
}

async fn release_unmanaged_picker(
    targets: &[(String, String)],
    model_provider: Option<&str>,
    status: &Arc<Mutex<CodexGuardianStatus>>,
    inner: &Arc<Mutex<GuardianInner>>,
) -> bool {
    let mut failed = 0;
    for (_, websocket_url) in targets {
        match deactivate_codex_model_picker(websocket_url, model_provider).await {
            Ok(true) => {}
            Ok(false) => failed += 1,
            Err(error) => {
                failed += 1;
                log::warn!("Codex guardian could not release managed model picker: {error}");
            }
        }
    }
    {
        let mut guard = inner.lock().await;
        guard.injected_target_ids.clear();
        guard.injected_catalog_fingerprint = None;
        guard.last_picker_readiness_signature = None;
    }
    let mut s = status.lock().await;
    s.codex_running = true;
    s.cdp_available = true;
    s.injected = false;
    s.injected_target_count = 0;
    s.picker_ready_target_count = 0;
    s.picker_diagnostics = None;
    s.picker_verification_issues.clear();
    s.picker_status = if failed == 0 {
        CodexModelPickerReadiness::NotRequired
    } else {
        CodexModelPickerReadiness::Unverified
    };
    if failed == 0 {
        s.last_event = "已退出模型菜单托管".into();
        s.message = "当前 Codex 配置不由 CCSM 托管，已释放模型菜单兼容层。".into();
    } else {
        s.last_event = "模型菜单托管释放未完成".into();
        s.message = format!(
            "当前 Codex 配置不由 CCSM 托管；{failed} 个 renderer 的模型菜单兼容层尚未释放，将在下次检查时重试。"
        );
    }
    failed == 0
}

/// Readiness is a projection of this cycle's live diagnostics, not another
/// persisted flag or a reason to reinstall an otherwise current runtime.
struct RendererTargetsObservation {
    installed_target_ids: Vec<String>,
    picker_ready_target_count: usize,
    picker_status: CodexModelPickerReadiness,
    picker_diagnostics: Option<CodexModelPickerDiagnosticsCounts>,
    picker_verification_issues: Vec<String>,
}

impl Default for RendererTargetsObservation {
    fn default() -> Self {
        Self {
            installed_target_ids: Vec::new(),
            picker_ready_target_count: 0,
            picker_status: CodexModelPickerReadiness::Unverified,
            picker_diagnostics: None,
            picker_verification_issues: Vec::new(),
        }
    }
}

const PICKER_VERIFICATION_ISSUE_ORDER: [&str; 12] = [
    "runtime_not_current",
    "catalog_unavailable",
    "diagnostics_unavailable",
    "observer_not_found",
    "observer_pending",
    "observer_error",
    "observer_unsupported",
    "observer_unreadable",
    "native_visibility_unverified",
    "boolean_control_unverified",
    "effort_mismatch",
    "flag_mismatch",
];

fn push_picker_verification_issue(issues: &mut Vec<String>, issue: &str) {
    if PICKER_VERIFICATION_ISSUE_ORDER.contains(&issue) && !issues.iter().any(|item| item == issue)
    {
        issues.push(issue.to_string());
    }
}

fn add_picker_diagnostics(
    total: &mut CodexModelPickerDiagnosticsCounts,
    value: &CodexModelPickerDiagnosticsCounts,
) {
    total.picker_observer_count = total
        .picker_observer_count
        .saturating_add(value.picker_observer_count);
    total.success_observer_count = total
        .success_observer_count
        .saturating_add(value.success_observer_count);
    total.error_observer_count = total
        .error_observer_count
        .saturating_add(value.error_observer_count);
    total.pending_observer_count = total
        .pending_observer_count
        .saturating_add(value.pending_observer_count);
    total.unsupported_observer_count = total
        .unsupported_observer_count
        .saturating_add(value.unsupported_observer_count);
    total.unreadable_observer_count = total
        .unreadable_observer_count
        .saturating_add(value.unreadable_observer_count);
    total.native_visibility_unverified_observer_count = total
        .native_visibility_unverified_observer_count
        .saturating_add(value.native_visibility_unverified_observer_count);
    total.boolean_control_unverified_model_count = total
        .boolean_control_unverified_model_count
        .saturating_add(value.boolean_control_unverified_model_count);
    total.boolean_control_ready_model_count = total
        .boolean_control_ready_model_count
        .saturating_add(value.boolean_control_ready_model_count);
    total.boolean_control_not_observed_model_count = total
        .boolean_control_not_observed_model_count
        .saturating_add(value.boolean_control_not_observed_model_count);
    total.effort_mismatch_count = total
        .effort_mismatch_count
        .saturating_add(value.effort_mismatch_count);
    total.flag_mismatch_count = total
        .flag_mismatch_count
        .saturating_add(value.flag_mismatch_count);
    total.missing_max_model_count = total
        .missing_max_model_count
        .saturating_add(value.missing_max_model_count);
    total.missing_ultra_model_count = total
        .missing_ultra_model_count
        .saturating_add(value.missing_ultra_model_count);
    total.selected_max_model_count = total
        .selected_max_model_count
        .saturating_add(value.selected_max_model_count);
    total.selected_ultra_model_count = total
        .selected_ultra_model_count
        .saturating_add(value.selected_ultra_model_count);
}

fn summarize_renderer_observations(
    observations: Vec<(String, CodexRendererCompatibilityObservation)>,
) -> RendererTargetsObservation {
    let mut summary = RendererTargetsObservation::default();
    let mut statuses = Vec::new();
    let mut aggregate_diagnostics = CodexModelPickerDiagnosticsCounts::default();
    let mut has_diagnostics = false;
    let mut verified_empty_targets = 0;
    for (id, observation) in observations {
        if observation.current {
            summary.installed_target_ids.push(id);
        } else {
            push_picker_verification_issue(
                &mut summary.picker_verification_issues,
                "runtime_not_current",
            );
        }
        let mut target_issues = Vec::new();
        for issue in &observation.picker_verification_issues {
            push_picker_verification_issue(&mut target_issues, issue);
        }
        if observation.current
            && observation.picker_diagnostics.is_none()
            && observation.picker_status != CodexModelPickerReadiness::NotRequired
            && !target_issues
                .iter()
                .any(|issue| issue == "catalog_unavailable")
        {
            push_picker_verification_issue(&mut target_issues, "diagnostics_unavailable");
        }
        if let Some(diagnostics) = observation
            .picker_diagnostics
            .as_ref()
            .filter(|_| observation.current)
        {
            has_diagnostics = true;
            add_picker_diagnostics(&mut aggregate_diagnostics, diagnostics);
            if diagnostics.picker_observer_count == 0
                && observation.picker_status != CodexModelPickerReadiness::NotRequired
            {
                push_picker_verification_issue(&mut target_issues, "observer_not_found");
            }
            for (count, issue) in [
                (diagnostics.pending_observer_count, "observer_pending"),
                (diagnostics.error_observer_count, "observer_error"),
                (
                    diagnostics.unsupported_observer_count,
                    "observer_unsupported",
                ),
                (diagnostics.unreadable_observer_count, "observer_unreadable"),
                (
                    diagnostics.native_visibility_unverified_observer_count,
                    "native_visibility_unverified",
                ),
                (
                    diagnostics.boolean_control_unverified_model_count,
                    "boolean_control_unverified",
                ),
                (diagnostics.effort_mismatch_count, "effort_mismatch"),
                (diagnostics.flag_mismatch_count, "flag_mismatch"),
            ] {
                if count > 0 {
                    push_picker_verification_issue(&mut target_issues, issue);
                }
            }
        }
        for issue in &target_issues {
            push_picker_verification_issue(&mut summary.picker_verification_issues, issue);
        }
        let picker_status = if !observation.current
            || (!target_issues.is_empty()
                && observation.picker_status == CodexModelPickerReadiness::Ready)
        {
            CodexModelPickerReadiness::Unverified
        } else {
            // Query-cache observer proof certifies only the model picker.
            // It neither requires nor grants request-client authorization.
            observation.picker_status
        };
        if picker_status == CodexModelPickerReadiness::Ready {
            summary.picker_ready_target_count += 1;
        }
        // The probe checks the same managed catalog on every target and only
        // emits NotRequired for an available catalog with no model names.
        if picker_status == CodexModelPickerReadiness::NotRequired
            && target_issues.is_empty()
            && observation
                .picker_diagnostics
                .as_ref()
                .is_some_and(|diagnostics| {
                    *diagnostics == CodexModelPickerDiagnosticsCounts::default()
                })
        {
            verified_empty_targets += 1;
        }
        statuses.push(picker_status);
    }
    if has_diagnostics {
        summary.picker_diagnostics = Some(aggregate_diagnostics);
    }
    summary.picker_verification_issues.sort_by_key(|issue| {
        PICKER_VERIFICATION_ISSUE_ORDER
            .iter()
            .position(|item| *item == issue)
            .unwrap_or(usize::MAX)
    });
    if !statuses.is_empty() {
        summary.picker_status = [
            CodexModelPickerReadiness::Error,
            CodexModelPickerReadiness::Mismatch,
            CodexModelPickerReadiness::Unverified,
            CodexModelPickerReadiness::Pending,
        ]
        .into_iter()
        .find(|status| statuses.contains(status))
        .unwrap_or_else(|| {
            if statuses
                .iter()
                .all(|status| *status == CodexModelPickerReadiness::Ready)
            {
                CodexModelPickerReadiness::Ready
            } else if statuses
                .iter()
                .all(|status| *status == CodexModelPickerReadiness::NotRequired)
                || summary.picker_ready_target_count + verified_empty_targets == statuses.len()
            {
                CodexModelPickerReadiness::NotRequired
            } else {
                // Mixed applicability is not proof that every picker is ready.
                CodexModelPickerReadiness::Unverified
            }
        });
    }
    summary
}

fn picker_readiness_signature(observations: &RendererTargetsObservation) -> String {
    format!(
        "{:?}|{:?}|{:?}",
        observations.picker_status,
        observations.picker_verification_issues,
        observations.picker_diagnostics
    )
}

fn record_picker_readiness_transition(
    inner: &mut GuardianInner,
    observations: &RendererTargetsObservation,
) -> bool {
    let signature = picker_readiness_signature(observations);
    if inner.last_picker_readiness_signature.as_deref() == Some(signature.as_str()) {
        return false;
    }
    // Counts and allowlisted issues only: no model names, URLs or provider data.
    log::info!(
        "Codex guardian picker readiness changed: status={:?}, issues={:?}, counts={:?}",
        observations.picker_status,
        observations.picker_verification_issues,
        observations.picker_diagnostics
    );
    inner.last_picker_readiness_signature = Some(signature);
    true
}

async fn current_renderer_targets(
    targets: &[(String, String)],
    catalog: &CodexModelCatalogProjection,
) -> RendererTargetsObservation {
    let mut observations = Vec::new();
    for (id, websocket_url) in targets {
        let observation = match inspect_codex_renderer_compatibility(websocket_url, catalog).await {
            Ok(observation) => observation,
            Err(error) => {
                log::debug!("Codex guardian renderer verification failed: {error}");
                CodexRendererCompatibilityObservation::default()
            }
        };
        observations.push((id.clone(), observation));
    }
    summarize_renderer_observations(observations)
}

fn apply_renderer_observation(
    status: &mut CodexGuardianStatus,
    observations: &RendererTargetsObservation,
) {
    status.injected_target_count = observations.installed_target_ids.len();
    status.injected = status.injected_target_count > 0;
    status.picker_ready_target_count = observations.picker_ready_target_count;
    status.picker_status = observations.picker_status;
    status.picker_diagnostics = observations.picker_diagnostics.clone();
    status.picker_verification_issues = observations.picker_verification_issues.clone();
}

fn renderer_observation_message(observations: &RendererTargetsObservation) -> String {
    if observations.installed_target_ids.is_empty() {
        return "CDP 可用但兼容层安装状态尚未核验（可能 target 启动中）".into();
    }
    format!(
        "已安装 {} 个 renderer target 的兼容层；模型选择器已核验就绪 {} 个，状态 {:?}。安装状态不代表模型选择器已就绪；守护将继续检查，不会因查询未就绪而重新注入。",
        observations.installed_target_ids.len(),
        observations.picker_ready_target_count,
        observations.picker_status,
    )
}

fn guardian_should_inject(
    new_target_ids: &[String],
    injected_catalog_fingerprint: Option<&str>,
    current_catalog_fingerprint: &str,
    renderers_current: bool,
) -> bool {
    !new_target_ids.is_empty()
        || injected_catalog_fingerprint != Some(current_catalog_fingerprint)
        || !renderers_current
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::{SinkExt, StreamExt};
    use serde_json::json;
    use tokio::net::TcpListener;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    use crate::proxy::codex_turn_recovery::ObservedUsageLimitTurn;

    #[test]
    fn native_usage_sources_keep_shared_target_ids_and_dedupe_websocket_aliases() {
        let first = "ws://127.0.0.1:9229/devtools/page/1";
        let second = "ws://127.0.0.1:9229/devtools/page/2";
        let third = "ws://127.0.0.1:9230/devtools/page/1";
        let page = |id: &str, websocket_url: &str| CdpTarget {
            id: id.to_string(),
            target_type: "page".to_string(),
            title: "Codex".to_string(),
            url: "app://-/index.html".to_string(),
            web_socket_debugger_url: Some(websocket_url.to_string()),
            source_endpoint: Some(std::net::Ipv4Addr::LOCALHOST.into()),
        };
        let verified_pages = [
            page("shared-id", first),
            page("first-alias", first),
            page("second-page", second),
            page("shared-id", third),
            page("shared-id", third),
        ];

        let destinations = collect_guardian_target_destinations(&verified_pages);
        assert_eq!(destinations.native_usage, [first, second, third]);
        assert!(destinations.native_usage_enumeration_complete);
        assert_eq!(
            destinations.picker,
            [
                ("shared-id".to_string(), first.to_string()),
                ("first-alias".to_string(), first.to_string()),
                ("second-page".to_string(), second.to_string()),
            ],
        );
    }

    #[test]
    fn native_usage_source_without_a_websocket_is_partial() {
        let verified_pages = [CdpTarget {
            id: "missing-websocket".into(),
            target_type: "page".into(),
            title: "Codex".into(),
            url: "app://-/index.html".into(),
            web_socket_debugger_url: None,
            source_endpoint: Some(std::net::Ipv4Addr::LOCALHOST.into()),
        }];

        let destinations = collect_guardian_target_destinations(&verified_pages);
        assert!(destinations.native_usage.is_empty());
        assert!(!destinations.native_usage_enumeration_complete);
    }

    #[test]
    fn native_usage_scan_cadence_skips_unchanged_sources_until_due() {
        let start = Instant::now();
        let mut cadence = NativeUsageScanCadence::default();
        let sources = ["ws://127.0.0.1:9229/devtools/page/1"];

        assert!(cadence.should_scan(&sources, start));
        assert!(!cadence.should_scan(
            &sources,
            start + NATIVE_USAGE_SCAN_INTERVAL - Duration::from_millis(1),
        ));
        assert!(cadence.should_scan(&sources, start + NATIVE_USAGE_SCAN_INTERVAL));
        // A renderer installation resets the cadence so the first current
        // runtime is sampled in the same guardian cycle.
        cadence.reset();
        assert!(cadence.should_scan(&sources, start + Duration::from_secs(1)));
        assert!(!cadence.should_scan(&sources, start + Duration::from_secs(2)));

        let changed = ["ws://127.0.0.1:9229/devtools/page/2"];
        assert!(cadence.should_scan(&changed, start + Duration::from_secs(10)));
        assert!(!cadence.should_scan(
            &changed,
            start + Duration::from_secs(10) + Duration::from_secs(1),
        ));

        assert!(cadence.should_scan(&[], start + Duration::from_secs(11)));
        assert!(!cadence.should_scan(&[], start + Duration::from_secs(12)));
        cadence.reset();
        assert!(cadence.should_scan(&[], start + Duration::from_secs(13)));
    }

    #[test]
    fn usage_limit_scan_clears_once_when_the_last_verified_source_disappears() {
        let now = Instant::now();
        let sources = ["ws://127.0.0.1:9229/devtools/page/1"];
        let mut cadence = NativeUsageScanCadence::default();
        assert_eq!(
            cadence.next_scan(&sources, true, false, now),
            NativeUsageScan::Scan
        );
        cadence.finish_scan(false);
        cadence.expedite();
        assert_eq!(
            cadence.next_scan(&[], true, false, now),
            NativeUsageScan::Clear
        );
        assert_eq!(
            cadence.next_scan(&[], true, false, now),
            NativeUsageScan::Skip
        );
        assert_eq!(
            cadence.next_scan(&sources, true, false, now),
            NativeUsageScan::Scan
        );
    }

    #[test]
    fn incomplete_empty_native_inventory_preserves_the_previous_scan_state() {
        let now = Instant::now();
        let sources = ["ws://127.0.0.1:9229/devtools/page/1"];
        let mut cadence = NativeUsageScanCadence::default();

        assert_eq!(
            cadence.next_scan(&sources, true, false, now),
            NativeUsageScan::Scan
        );
        cadence.finish_scan(true);

        assert_eq!(
            cadence.next_scan(&[], false, false, now + Duration::from_secs(1)),
            NativeUsageScan::Skip
        );
        assert_eq!(cadence.source_signature, vec![sources[0].to_string()]);

        assert_eq!(
            cadence.next_scan(&[], true, false, now + Duration::from_secs(1)),
            NativeUsageScan::Clear
        );
        assert!(cadence.source_signature.is_empty());
    }

    #[test]
    fn forced_native_usage_scan_resolves_empty_inventory() {
        let now = Instant::now();
        let mut cadence = NativeUsageScanCadence::default();
        assert_eq!(
            cadence.next_scan(&[], true, true, now),
            NativeUsageScan::Clear
        );

        let sources = ["ws://127.0.0.1:9229/devtools/page/1"];
        assert_eq!(
            cadence.next_scan(&sources, true, false, now),
            NativeUsageScan::Scan
        );
        cadence.finish_scan(true);

        assert_eq!(
            cadence.next_scan(&[], false, true, now + Duration::from_secs(1)),
            NativeUsageScan::Incomplete,
        );
        assert_eq!(cadence.source_signature, vec![sources[0].to_string()]);
        assert_eq!(
            cadence.next_scan(&sources, true, false, now + Duration::from_secs(2)),
            NativeUsageScan::Skip,
        );
    }

    #[test]
    fn forced_native_usage_scan_bypasses_cadence_for_one_scan() {
        let now = Instant::now();
        let sources = ["ws://127.0.0.1:9229/devtools/page/1"];
        let mut cadence = NativeUsageScanCadence::default();
        assert_eq!(
            cadence.next_scan(&sources, true, false, now),
            NativeUsageScan::Scan
        );
        cadence.finish_scan(false);
        assert_eq!(
            cadence.next_scan(&sources, true, false, now),
            NativeUsageScan::Scan
        );
        cadence.finish_scan(false);

        let before_due = now + GUARDIAN_CHECK_INTERVAL;
        assert_eq!(
            cadence.next_scan(&sources, true, false, before_due),
            NativeUsageScan::Skip
        );
        assert_eq!(
            cadence.next_scan(&sources, true, true, before_due),
            NativeUsageScan::Scan
        );
        cadence.finish_scan(false);
        assert_eq!(
            cadence.next_scan(&sources, true, false, before_due),
            NativeUsageScan::Skip
        );
    }

    #[test]
    fn native_usage_source_set_shrink_marks_the_next_snapshot_partial() {
        let start = Instant::now();
        let first = "ws://127.0.0.1:9229/devtools/page/1";
        let second = "ws://127.0.0.1:9229/devtools/page/2";
        let mut cadence = NativeUsageScanCadence::default();

        assert_eq!(
            cadence.next_scan(&[first, second], true, false, start),
            NativeUsageScan::Scan
        );
        cadence.finish_scan(true);

        assert_eq!(
            cadence.next_scan(&[first], true, false, start + Duration::from_secs(1),),
            NativeUsageScan::Scan
        );
        assert!(cadence.source_set_shrank);
    }

    #[test]
    fn incomplete_native_source_inventory_keeps_candidates_in_a_partial_snapshot() {
        let candidate: ObservedUsageLimitTurn = serde_json::from_value(json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "model": "gpt-test",
            "observedAtMs": 1,
        }))
        .expect("valid observed usage-limit turn fixture");
        let combined = combine_native_usage_limit_snapshots(
            vec![Some(NativeUsageLimitSnapshot {
                candidates: vec![candidate.clone()],
                complete: true,
                ..Default::default()
            })],
            false,
            true,
        )
        .unwrap();

        assert!(!combined.complete);
        assert_eq!(combined.candidates, vec![candidate]);
    }

    #[test]
    fn native_usage_scan_missing_renderer_results_cannot_verify_a_zero_count() {
        assert_eq!(
            combine_native_usage_limit_snapshots(vec![None, None], true, true),
            None
        );
        assert_eq!(
            combine_native_usage_limit_snapshots(
                vec![
                    None,
                    Some(NativeUsageLimitSnapshot {
                        complete: true,
                        ..Default::default()
                    }),
                ],
                true,
                true,
            ),
            Some(NativeUsageLimitSnapshot::default())
        );
    }

    #[test]
    fn incomplete_native_usage_scan_is_due_again_immediately() {
        let start = Instant::now();
        let mut cadence = NativeUsageScanCadence::default();
        let sources = ["ws://127.0.0.1:9229/devtools/page/1"];

        assert!(cadence.should_scan(&sources, start));
        assert!(!cadence.should_scan(&sources, start + Duration::from_secs(1)));

        cadence.finish_scan(false);

        assert!(cadence.should_scan(&sources, start + Duration::from_secs(1)));
    }

    #[test]
    fn repeated_incomplete_usage_scans_keep_the_normal_work_bound() {
        let mut cadence = NativeUsageScanCadence::default();
        let sources = ["ws://127.0.0.1:9229/devtools/page/1"];
        let start = Instant::now();
        let mut scans = 0;
        for cycle in 0..=12 {
            let now = start + GUARDIAN_CHECK_INTERVAL * cycle;
            if cadence.should_scan(&sources, now) {
                scans += 1;
                cadence.finish_scan(false);
            }
        }
        assert_eq!(scans, 5);

        let changed = ["ws://127.0.0.1:9229/devtools/page/2"];
        let now = start + GUARDIAN_CHECK_INTERVAL * 13;
        assert!(cadence.should_scan(&changed, now));
        cadence.finish_scan(false);
        assert!(cadence.should_scan(&changed, now + GUARDIAN_CHECK_INTERVAL));
    }

    #[test]
    fn guardian_backs_off_repeated_idle_native_probes_and_recovers_full_cadence() {
        use GuardianCycleState::*;

        let mut cadence = GuardianCadence::default();
        let seconds = [
            DesktopMissing,
            DesktopMissing,
            DesktopMissing,
            DesktopMissing,
            VerifiedRendererUnavailable,
            VerifiedRendererUnavailable,
            VerifiedRendererUnavailable,
            VerifiedRendererUnavailable,
            WatchingRenderer,
            WatchingRenderer,
            WatchingRenderer,
            VerifiedRendererUnavailable,
            DesktopMissing,
        ]
        .map(|state| cadence.after_cycle(state).as_secs());

        // No unbounded idle wait or inherited delay after a state transition.
        assert_eq!(seconds, [3, 6, 12, 12, 3, 6, 12, 12, 3, 3, 3, 3, 3]);
    }

    #[test]
    fn guardian_reports_new_catalog_failures_without_repeating_a_steady_warning() {
        let mut status = CodexGuardianStatus {
            active: true,
            codex_running: true,
            cdp_available: true,
            injected_target_count: 1,
            injected: true,
            picker_ready_target_count: 1,
            picker_status: CodexModelPickerReadiness::Ready,
            picker_diagnostics: Some(CodexModelPickerDiagnosticsCounts::default()),
            picker_verification_issues: vec!["stale".into()],
            last_event: "Verified".into(),
            message: "Picker is ready".into(),
        };

        assert!(report_catalog_load_failure(&mut status, "invalid JSON"));
        assert!(!report_catalog_load_failure(&mut status, "invalid JSON"));
        assert_eq!(status.picker_ready_target_count, 0);
        assert_eq!(status.picker_status, CodexModelPickerReadiness::Unverified);
        assert!(status.picker_diagnostics.is_none());
        assert!(status.picker_verification_issues.is_empty());
        assert!(status.message.contains("invalid JSON"));
        assert!(report_catalog_load_failure(&mut status, "catalog missing"));
        assert!(!report_catalog_load_failure(&mut status, "catalog missing"));

        status.last_event = "Verified".into();
        assert!(report_catalog_load_failure(&mut status, "catalog missing"));
    }

    #[tokio::test]
    async fn unmanaged_catalog_release_clears_previous_guardian_ownership() {
        let inner = Arc::new(Mutex::new(GuardianInner {
            injected_target_ids: vec!["previous-renderer".to_string()],
            injected_catalog_fingerprint: Some("previous-catalog".to_string()),
            inject_generation: 7,
            last_picker_readiness_signature: Some("previous-readiness".to_string()),
            native_usage_scan: NativeUsageScanCadence::default(),
        }));
        let status = Arc::new(Mutex::new(CodexGuardianStatus {
            active: true,
            codex_running: true,
            cdp_available: true,
            injected_target_count: 1,
            injected: true,
            picker_ready_target_count: 1,
            picker_status: CodexModelPickerReadiness::Ready,
            picker_diagnostics: Some(CodexModelPickerDiagnosticsCounts::default()),
            picker_verification_issues: vec!["native_visibility_unverified".to_string()],
            last_event: "previous injection".to_string(),
            message: "previous managed catalog".to_string(),
        }));

        release_unmanaged_picker(&[], Some("openai"), &status, &inner).await;

        let guard = inner.lock().await;
        assert!(guard.injected_target_ids.is_empty());
        assert!(guard.injected_catalog_fingerprint.is_none());
        assert_eq!(guard.inject_generation, 7);
        let current = status.lock().await;
        assert!(!current.injected);
        assert_eq!(current.injected_target_count, 0);
        assert_eq!(current.picker_ready_target_count, 0);
        assert_eq!(
            current.picker_status,
            CodexModelPickerReadiness::NotRequired
        );
        let serialized = serde_json::to_value(&*current).expect("serialize guardian status");
        assert_eq!(serialized["pickerReadyTargetCount"], 0);
        assert_eq!(serialized["pickerStatus"], "not_required");
        assert_eq!(serialized["pickerDiagnostics"], serde_json::Value::Null);
        assert_eq!(serialized["pickerVerificationIssues"], json!([]));
        assert!(guard.last_picker_readiness_signature.is_none());
        assert!(current.active);
        assert!(current.codex_running);
        assert!(current.cdp_available);
    }

    #[tokio::test]
    async fn native_usage_refresh_batches_requests_before_discovery() {
        let (handle, _shutdown) = GuardianHandle::new(false);
        let pending = &handle.native_usage_refresh;
        let first = handle.request_native_usage_scan();
        let second = handle.request_native_usage_scan();
        let scanning = take_native_usage_refresh(pending).unwrap();
        assert!(pending.borrow().is_none());

        let later = handle.request_native_usage_scan();
        tokio::pin!(later);
        scanning.send_replace(Some(Ok(())));
        assert_eq!(first.await, Ok(()));
        assert_eq!(second.await, Ok(()));
        assert!(futures::poll!(later.as_mut()).is_pending());

        let next = take_native_usage_refresh(pending).unwrap();
        next.send_replace(Some(Ok(())));
        assert_eq!(later.await, Ok(()));
        assert!(pending.borrow().is_none());
    }

    #[tokio::test]
    async fn native_usage_refresh_preserves_the_result_of_each_scan_for_delayed_waiters() {
        let (handle, _shutdown) = GuardianHandle::new(false);
        let pending = &handle.native_usage_refresh;
        let first = handle.request_native_usage_scan();
        let scanning = take_native_usage_refresh(pending).unwrap();
        let later = handle.request_native_usage_scan();
        scanning.send_replace(Some(Err(NativeUsageRefreshError::DesktopNotLinked)));
        drop(scanning);
        let next = take_native_usage_refresh(pending).unwrap();
        next.send_replace(Some(Ok(())));
        drop(next);

        assert_eq!(first.await, Err(NativeUsageRefreshError::DesktopNotLinked));
        assert_eq!(later.await, Ok(()));
    }

    #[tokio::test]
    async fn native_usage_refresh_reports_unavailable_when_no_renderer_was_verified() {
        let (handle, _shutdown) = GuardianHandle::new(false);
        let request = handle.request_native_usage_scan();
        let pending = &handle.native_usage_refresh;
        let failed = take_native_usage_refresh(pending).unwrap();
        failed.send_replace(Some(Err(NativeUsageRefreshError::ObserverUnavailable)));
        assert_eq!(
            request.await,
            Err(NativeUsageRefreshError::ObserverUnavailable)
        );

        let retry = handle.request_native_usage_scan();
        let next = take_native_usage_refresh(pending).unwrap();
        next.send_replace(Some(Ok(())));
        assert_eq!(retry.await, Ok(()));
    }

    #[tokio::test(start_paused = true)]
    async fn native_usage_refresh_reports_a_distinct_timeout() {
        let (handle, _shutdown) = GuardianHandle::new(false);

        assert_eq!(
            handle.request_native_usage_scan().await,
            Err(NativeUsageRefreshError::ScanTimedOut)
        );
        assert!(handle.native_usage_refresh.borrow().is_some());
    }

    #[test]
    fn native_usage_refresh_errors_use_stable_ipc_codes() {
        for (error, code) in [
            (NativeUsageRefreshError::ScanTimedOut, "scanTimedOut"),
            (NativeUsageRefreshError::ObserverStopped, "observerStopped"),
            (
                NativeUsageRefreshError::ObserverUnavailable,
                "observerUnavailable",
            ),
            (
                NativeUsageRefreshError::DesktopNotRunning,
                "desktopNotRunning",
            ),
            (
                NativeUsageRefreshError::DesktopNotLinked,
                "desktopNotLinked",
            ),
        ] {
            assert_eq!(serde_json::to_value(error).unwrap(), json!(code));
        }
    }

    #[tokio::test]
    async fn native_usage_refresh_stops_waiting_on_guardian_shutdown() {
        let (handle, shutdown) = GuardianHandle::new(false);
        let waiter = handle.request_native_usage_scan();
        tokio::pin!(waiter);
        assert!(futures::poll!(waiter.as_mut()).is_pending());
        let refresh = take_native_usage_refresh(&handle.native_usage_refresh).unwrap();

        handle.shutdown_tx.send(true).expect("signal shutdown");
        publish_native_usage_limit_candidates(
            &shutdown,
            Ok(NativeUsageLimitSnapshot::default()),
            Some(&refresh),
        );

        assert_eq!(waiter.await, Err(NativeUsageRefreshError::ObserverStopped));
        assert!(refresh.borrow().is_none());
    }

    fn observed_target(
        id: &str,
        current: bool,
        picker_status: CodexModelPickerReadiness,
        app_server_ready: bool,
    ) -> (String, CodexRendererCompatibilityObservation) {
        (
            id.to_string(),
            CodexRendererCompatibilityObservation {
                current,
                picker_status,
                app_server_ready,
                picker_diagnostics: Some(CodexModelPickerDiagnosticsCounts {
                    picker_observer_count: 1,
                    success_observer_count: 1,
                    ..Default::default()
                }),
                picker_verification_issues: Vec::new(),
            },
        )
    }

    #[test]
    fn guardian_does_not_reinject_current_runtime_while_picker_discovery_is_pending() {
        let observations = summarize_renderer_observations(vec![
            observed_target("pending", true, CodexModelPickerReadiness::Pending, false),
            observed_target("ready", true, CodexModelPickerReadiness::Ready, true),
        ]);
        assert_eq!(observations.installed_target_ids, vec!["pending", "ready"]);
        assert_eq!(observations.picker_ready_target_count, 1);
        assert_eq!(
            observations.picker_status,
            CodexModelPickerReadiness::Pending
        );
        assert!(!guardian_should_inject(
            &[],
            Some("current-catalog"),
            "current-catalog",
            observations.installed_target_ids.len() == 2,
        ));
    }

    #[test]
    fn guardian_aggregate_never_hides_failed_or_stale_targets_behind_a_ready_target() {
        for (current, picker_status, expected) in [
            (
                true,
                CodexModelPickerReadiness::Error,
                CodexModelPickerReadiness::Error,
            ),
            (
                true,
                CodexModelPickerReadiness::Mismatch,
                CodexModelPickerReadiness::Mismatch,
            ),
            (
                false,
                CodexModelPickerReadiness::Ready,
                CodexModelPickerReadiness::Unverified,
            ),
        ] {
            let observations = summarize_renderer_observations(vec![
                observed_target("ready", true, CodexModelPickerReadiness::Ready, true),
                observed_target("other", current, picker_status, true),
            ]);
            assert_eq!(observations.picker_ready_target_count, 1);
            assert_eq!(observations.picker_status, expected);
        }
    }

    #[test]
    fn guardian_accepts_current_cache_only_picker_proof() {
        let observations = summarize_renderer_observations(vec![observed_target(
            "cache-only",
            true,
            CodexModelPickerReadiness::Ready,
            false,
        )]);
        assert_eq!(observations.installed_target_ids, vec!["cache-only"]);
        assert_eq!(observations.picker_status, CodexModelPickerReadiness::Ready);
        assert_eq!(observations.picker_ready_target_count, 1);
    }

    #[test]
    fn guardian_never_invents_ready_from_pending_or_zero_targets() {
        let observations = summarize_renderer_observations(vec![observed_target(
            "pending-cache-discovery",
            true,
            CodexModelPickerReadiness::Pending,
            false,
        )]);
        assert_eq!(
            observations.picker_status,
            CodexModelPickerReadiness::Pending
        );
        assert_eq!(observations.picker_ready_target_count, 0);
        let no_targets = summarize_renderer_observations(Vec::new());
        assert_eq!(
            no_targets.picker_status,
            CodexModelPickerReadiness::Unverified
        );
        assert_eq!(no_targets.picker_ready_target_count, 0);
        let mixed = summarize_renderer_observations(vec![
            observed_target("ready", true, CodexModelPickerReadiness::Ready, true),
            observed_target("empty", true, CodexModelPickerReadiness::NotRequired, false),
        ]);
        assert_eq!(mixed.picker_status, CodexModelPickerReadiness::Unverified);
        assert_eq!(mixed.picker_ready_target_count, 1);
        let empty = summarize_renderer_observations(vec![observed_target(
            "empty",
            true,
            CodexModelPickerReadiness::NotRequired,
            false,
        )]);
        assert_eq!(empty.picker_status, CodexModelPickerReadiness::NotRequired);
        assert_eq!(empty.picker_ready_target_count, 0);
    }

    #[test]
    fn guardian_aggregate_accepts_authoritative_empty_catalog() {
        let mut without_observer =
            observed_target("empty", true, CodexModelPickerReadiness::NotRequired, false);
        without_observer.1.picker_diagnostics = Some(CodexModelPickerDiagnosticsCounts::default());
        let ready = observed_target("ready", true, CodexModelPickerReadiness::Ready, true);
        let summarize = |other| summarize_renderer_observations(vec![ready.clone(), other]);
        let summary = summarize(without_observer.clone());

        assert_eq!(
            summary.picker_status,
            CodexModelPickerReadiness::NotRequired
        );
        assert_eq!(summary.installed_target_ids, ["ready", "empty"]);
        assert_eq!(summary.picker_ready_target_count, 1);
        assert!(summary.picker_verification_issues.is_empty());
        assert_eq!(
            summary.picker_diagnostics.unwrap().success_observer_count,
            1
        );

        let mut pending_observer = without_observer.clone();
        pending_observer.1.picker_diagnostics = Some(CodexModelPickerDiagnosticsCounts {
            picker_observer_count: 1,
            pending_observer_count: 1,
            ..Default::default()
        });
        let pending = summarize(pending_observer);
        assert_eq!(pending.picker_status, CodexModelPickerReadiness::Unverified);
        assert_eq!(pending.picker_verification_issues, ["observer_pending"]);

        let mut unavailable = without_observer.clone();
        unavailable.1.picker_diagnostics = None;
        assert_eq!(
            summarize(unavailable).picker_status,
            CodexModelPickerReadiness::Unverified
        );

        let mismatched = summarize_renderer_observations(vec![
            ready,
            without_observer,
            observed_target("mismatch", true, CodexModelPickerReadiness::Mismatch, true),
        ]);
        assert_eq!(
            mismatched.picker_status,
            CodexModelPickerReadiness::Mismatch
        );
    }

    #[test]
    fn guardian_exposes_native_visibility_uncertainty_without_reinstalling() {
        let (id, mut observation) =
            observed_target("current", true, CodexModelPickerReadiness::Unverified, true);
        observation.picker_diagnostics = Some(CodexModelPickerDiagnosticsCounts {
            picker_observer_count: 3,
            success_observer_count: 3,
            native_visibility_unverified_observer_count: 3,
            selected_max_model_count: 13,
            selected_ultra_model_count: 13,
            ..Default::default()
        });
        observation.picker_verification_issues = vec!["native_visibility_unverified".to_string()];
        let summary = summarize_renderer_observations(vec![(id, observation)]);
        assert_eq!(summary.installed_target_ids.len(), 1);
        assert_eq!(summary.picker_ready_target_count, 0);
        assert_eq!(summary.picker_status, CodexModelPickerReadiness::Unverified);
        assert_eq!(
            summary.picker_verification_issues,
            vec!["native_visibility_unverified"]
        );
        let counts = summary.picker_diagnostics.as_ref().expect("fresh counts");
        assert_eq!(counts.picker_observer_count, 3);
        assert_eq!(counts.success_observer_count, 3);
        assert_eq!(counts.native_visibility_unverified_observer_count, 3);
        assert_eq!(counts.selected_max_model_count, 13);
        assert!(!guardian_should_inject(
            &[],
            Some("catalog"),
            "catalog",
            true
        ));
    }

    #[test]
    fn guardian_preserves_boolean_control_evidence_from_only_current_targets() {
        let (first_id, mut first) =
            observed_target("first", true, CodexModelPickerReadiness::Unverified, true);
        first.picker_diagnostics = Some(CodexModelPickerDiagnosticsCounts {
            picker_observer_count: 3,
            success_observer_count: 3,
            boolean_control_unverified_model_count: 2,
            boolean_control_ready_model_count: 1,
            ..Default::default()
        });
        let (second_id, mut second) =
            observed_target("second", true, CodexModelPickerReadiness::Ready, false);
        second.picker_diagnostics = Some(CodexModelPickerDiagnosticsCounts {
            picker_observer_count: 1,
            success_observer_count: 1,
            boolean_control_ready_model_count: 4,
            ..Default::default()
        });
        let (stale_id, mut stale) =
            observed_target("stale", false, CodexModelPickerReadiness::Ready, true);
        stale.picker_diagnostics = Some(CodexModelPickerDiagnosticsCounts {
            boolean_control_unverified_model_count: 100,
            boolean_control_ready_model_count: 100,
            ..Default::default()
        });
        let summary = summarize_renderer_observations(vec![
            (first_id, first),
            (second_id, second),
            (stale_id, stale),
        ]);
        let counts = summary.picker_diagnostics.as_ref().expect("current counts");
        assert_eq!(counts.picker_observer_count, 4);
        assert_eq!(counts.boolean_control_unverified_model_count, 2);
        assert_eq!(counts.boolean_control_ready_model_count, 5);
        assert_eq!(summary.picker_status, CodexModelPickerReadiness::Unverified);
        assert_eq!(summary.picker_ready_target_count, 1);
        assert_eq!(
            summary.picker_verification_issues,
            vec!["runtime_not_current", "boolean_control_unverified"]
        );
        assert!(!guardian_should_inject(
            &[],
            Some("catalog"),
            "catalog",
            true
        ));

        let (id, mut inconsistent_ready) =
            observed_target("inconsistent", true, CodexModelPickerReadiness::Ready, true);
        inconsistent_ready
            .picker_diagnostics
            .as_mut()
            .unwrap()
            .boolean_control_unverified_model_count = 1;
        let summary = summarize_renderer_observations(vec![(id, inconsistent_ready)]);
        assert_eq!(summary.picker_status, CodexModelPickerReadiness::Unverified);
        assert_eq!(summary.picker_ready_target_count, 0);
        assert_eq!(
            summary.picker_verification_issues,
            vec!["boolean_control_unverified"]
        );
    }

    #[test]
    fn guardian_old_native_without_diagnostics_cannot_claim_ready() {
        let (id, mut observation) =
            observed_target("legacy", true, CodexModelPickerReadiness::Ready, true);
        observation.picker_diagnostics = None;
        let summary = summarize_renderer_observations(vec![(id, observation)]);
        assert_eq!(summary.picker_status, CodexModelPickerReadiness::Unverified);
        assert_eq!(summary.picker_ready_target_count, 0);
        assert!(summary.picker_diagnostics.is_none());
        assert_eq!(
            summary.picker_verification_issues,
            vec!["diagnostics_unavailable"]
        );
    }

    #[test]
    fn guardian_issues_are_allowlisted_deduplicated_and_order_independent() {
        let (id_a, mut a) = observed_target("a", true, CodexModelPickerReadiness::Unverified, true);
        a.picker_verification_issues = vec![
            "native_visibility_unverified".to_string(),
            "observer_pending".to_string(),
            "unrecognized_detail".to_string(),
        ];
        let (id_b, mut b) = observed_target("b", true, CodexModelPickerReadiness::Mismatch, false);
        b.picker_verification_issues = vec![
            "effort_mismatch".to_string(),
            "observer_pending".to_string(),
        ];
        let first = summarize_renderer_observations(vec![
            (id_a.clone(), a.clone()),
            (id_b.clone(), b.clone()),
        ]);
        let reversed = summarize_renderer_observations(vec![(id_b, b), (id_a, a)]);
        assert_eq!(
            first.picker_verification_issues,
            vec![
                "observer_pending",
                "native_visibility_unverified",
                "effort_mismatch"
            ]
        );
        assert_eq!(
            first.picker_verification_issues,
            reversed.picker_verification_issues
        );
        assert_eq!(
            first
                .picker_diagnostics
                .as_ref()
                .expect("counts")
                .picker_observer_count,
            2
        );
        assert_eq!(first.picker_ready_target_count, 0);
        assert_eq!(first.picker_status, CodexModelPickerReadiness::Mismatch);
        assert_eq!(
            picker_readiness_signature(&first),
            picker_readiness_signature(&reversed)
        );
    }

    #[test]
    fn guardian_readiness_logging_is_transition_only_and_ignores_target_identity() {
        let mut inner = GuardianInner {
            injected_target_ids: Vec::new(),
            injected_catalog_fingerprint: None,
            inject_generation: 0,
            last_picker_readiness_signature: None,
            native_usage_scan: NativeUsageScanCadence::default(),
        };
        let mut observation = summarize_renderer_observations(vec![observed_target(
            "a",
            true,
            CodexModelPickerReadiness::Ready,
            false,
        )]);
        assert!(record_picker_readiness_transition(&mut inner, &observation));
        assert!(!record_picker_readiness_transition(
            &mut inner,
            &observation
        ));
        observation.installed_target_ids = vec!["different-target".to_string()];
        assert!(!record_picker_readiness_transition(
            &mut inner,
            &observation
        ));
        observation.picker_status = CodexModelPickerReadiness::Pending;
        assert!(record_picker_readiness_transition(&mut inner, &observation));
        observation.picker_verification_issues = vec!["observer_pending".to_string()];
        assert!(record_picker_readiness_transition(&mut inner, &observation));
        observation
            .picker_diagnostics
            .as_mut()
            .expect("counts")
            .pending_observer_count = 1;
        assert!(record_picker_readiness_transition(&mut inner, &observation));
        assert!(!record_picker_readiness_transition(
            &mut inner,
            &observation
        ));
    }

    #[test]
    fn guardian_reinjects_existing_targets_when_catalog_changes() {
        let no_new_targets = Vec::<String>::new();

        assert!(guardian_should_inject(
            &no_new_targets,
            Some("catalog-v1"),
            "catalog-v2",
            true,
        ));
    }

    #[test]
    fn guardian_keeps_unchanged_catalog_injection_idempotent() {
        let no_new_targets = Vec::<String>::new();

        assert!(!guardian_should_inject(
            &no_new_targets,
            Some("catalog-v2"),
            "catalog-v2",
            true,
        ));
    }

    #[test]
    fn guardian_injects_new_targets_even_when_catalog_is_unchanged() {
        let new_targets = vec!["renderer-2".to_string()];

        assert!(guardian_should_inject(
            &new_targets,
            Some("catalog-v2"),
            "catalog-v2",
            true,
        ));
    }

    #[test]
    fn guardian_reinjects_unchanged_targets_after_renderer_reload() {
        assert!(guardian_should_inject(
            &[],
            Some("catalog-v2"),
            "catalog-v2",
            false,
        ));
    }

    #[test]
    fn guardian_does_not_treat_prior_injection_as_current_renderer_evidence() {
        for fingerprint in [None, Some("catalog-v2")] {
            assert!(guardian_should_inject(
                &[],
                fingerprint,
                "catalog-v2",
                false,
            ));
        }
    }

    #[tokio::test]
    async fn guardian_tracks_only_renderers_with_successful_current_payload_probes() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake CDP listener");
        let address = listener.local_addr().expect("fake CDP address");
        let server = tokio::spawn(async move {
            for current in [Some(true), Some(false), None] {
                let (stream, _) = listener.accept().await.expect("accept CDP connection");
                let mut socket = accept_async(stream).await.expect("accept CDP websocket");
                while let Some(message) = socket.next().await {
                    let message = message.expect("read CDP request");
                    let Message::Text(text) = message else {
                        continue;
                    };
                    let request: serde_json::Value =
                        serde_json::from_str(text.as_str()).expect("parse CDP request");
                    let evaluating = request["method"] == "Runtime.evaluate";
                    let response = if evaluating {
                        match current {
                            Some(current) => json!({
                                "id": request["id"],
                                "result": {"result": {"type": "object", "value": {
                                    "current": current,
                                    "pickerStatus": "pending",
                                    "appServerReady": false
                                }}}
                            }),
                            None => json!({
                                "id": request["id"],
                                "error": {"code": -32000, "message": "renderer unavailable"}
                            }),
                        }
                    } else {
                        json!({"id": request["id"], "result": {}})
                    };
                    socket
                        .send(Message::Text(response.to_string().into()))
                        .await
                        .expect("send CDP response");
                    if evaluating {
                        break;
                    }
                }
            }
        });
        let targets = ["current", "reloaded", "unreachable"]
            .into_iter()
            .map(|id| (id.to_string(), format!("ws://{address}/devtools/page/{id}")))
            .collect::<Vec<_>>();
        let catalog = CodexModelCatalogProjection::empty();

        let observations = current_renderer_targets(&targets, &catalog).await;
        tokio::time::timeout(Duration::from_secs(10), server)
            .await
            .expect("all renderer probes must finish")
            .expect("complete fake CDP server");

        assert_eq!(observations.installed_target_ids, vec!["current"]);
        assert_eq!(observations.picker_ready_target_count, 0);
        assert_eq!(
            observations.picker_status,
            CodexModelPickerReadiness::Unverified
        );
        assert!(guardian_should_inject(
            &[],
            Some("catalog-v2"),
            "catalog-v2",
            observations.installed_target_ids.len() == targets.len(),
        ));
    }
}
