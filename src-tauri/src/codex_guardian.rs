use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{watch, Mutex};

use crate::codex_desktop::{
    candidate_debug_ports, deactivate_codex_model_picker, detect_running_codex_main_process_async,
    inspect_codex_renderer_compatibility, list_cdp_targets,
    load_cc_switch_model_catalog_projection_outcome, pick_codex_page_targets_async,
    try_inject_on_candidate_ports, CodexModelCatalogLoadOutcome, CodexModelCatalogProjection,
    CodexModelPickerDiagnosticsCounts, CodexModelPickerReadiness,
    CodexRendererCompatibilityObservation, DEFAULT_CODEX_DEBUG_PORT,
};

const GUARDIAN_CHECK_INTERVAL: Duration = Duration::from_secs(3);

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
}

/// 守护的外部句柄；丢弃后守护自动停止。
pub(crate) struct GuardianHandle {
    shutdown_tx: watch::Sender<bool>,
    pub(crate) status: Arc<Mutex<CodexGuardianStatus>>,
}

/// 启动 Codex 桌面模型菜单生命周期守护。
///
/// 守护不会静默终止正在工作的 Codex。
/// 在检测到新 renderer target、目录变化或 renderer 重载时幂等重新注入；
/// 若 CDP 不可用则记录原因并等待。
pub(crate) fn start_codex_guardian() -> GuardianHandle {
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

    let inner = Arc::new(Mutex::new(GuardianInner {
        injected_target_ids: Vec::new(),
        injected_catalog_fingerprint: None,
        inject_generation: 0,
        last_picker_readiness_signature: None,
    }));

    let s = status.clone();
    let i = inner.clone();
    tokio::spawn(async move {
        guardian_loop(s, i, shutdown_rx).await;
    });

    GuardianHandle {
        shutdown_tx,
        status,
    }
}

impl GuardianHandle {
    pub(crate) fn stop(self) {
        let _ = self.shutdown_tx.send(true);
    }
}

async fn guardian_loop(
    status: Arc<Mutex<CodexGuardianStatus>>,
    inner: Arc<Mutex<GuardianInner>>,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        if *shutdown.borrow() {
            let mut s = status.lock().await;
            s.active = false;
            s.picker_ready_target_count = 0;
            s.picker_status = CodexModelPickerReadiness::Unverified;
            s.picker_diagnostics = None;
            s.picker_verification_issues.clear();
            s.last_event = "守护已停止".into();
            s.message = "守护已停止".into();
            return;
        }

        run_guardian_cycle(&status, &inner).await;

        tokio::select! {
            _ = tokio::time::sleep(GUARDIAN_CHECK_INTERVAL) => {},
            _ = shutdown.changed() => {
                let mut s = status.lock().await;
                s.active = false;
                s.picker_ready_target_count = 0;
                s.picker_status = CodexModelPickerReadiness::Unverified;
                s.picker_diagnostics = None;
                s.picker_verification_issues.clear();
                s.last_event = "守护已停止".into();
                s.message = "守护已停止".into();
                return;
            }
        }
    }
}

async fn run_guardian_cycle(
    status: &Arc<Mutex<CodexGuardianStatus>>,
    inner: &Arc<Mutex<GuardianInner>>,
) {
    // 1. 检查 Codex 主进程是否在运行。
    let running = detect_running_codex_main_process_async().await;
    if running.is_none() {
        let mut s = status.lock().await;
        s.codex_running = false;
        s.cdp_available = false;
        s.injected = false;
        s.injected_target_count = 0;
        s.picker_ready_target_count = 0;
        s.picker_status = CodexModelPickerReadiness::Unverified;
        s.picker_diagnostics = None;
        s.picker_verification_issues.clear();
        s.last_event = "Codex 未运行".into();
        s.message = "Codex Desktop 未运行，等待用户启动...".into();
        // 进程消失时清理已知 target，下次启动不会跳过新 target。
        let mut guard = inner.lock().await;
        guard.injected_target_ids.clear();
        guard.injected_catalog_fingerprint = None;
        guard.last_picker_readiness_signature = None;
        return;
    }

    // 2. 保留 websocket 地址，以便同一 target 重载后核验 renderer 状态。
    let ports = candidate_debug_ports(DEFAULT_CODEX_DEBUG_PORT);
    let mut current_targets: Vec<(String, String)> = Vec::new();
    let mut target_ports = Vec::new();
    let mut cdp_available = false;

    for port in &ports {
        match list_cdp_targets(*port).await {
            Ok(targets) => match pick_codex_page_targets_async(&targets, *port).await {
                Ok(pages) => {
                    cdp_available = true;
                    target_ports.push(*port);
                    for t in &pages {
                        if let Some(websocket_url) = t.web_socket_debugger_url.as_deref() {
                            if !current_targets.iter().any(|(id, _)| id == &t.id) {
                                current_targets.push((t.id.clone(), websocket_url.to_string()));
                            }
                        }
                    }
                }
                Err(_) => continue,
            },
            Err(_) => continue,
        }
    }

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
        s.last_event = "Codex 运行中但无 CDP".into();
        s.message = "Codex Desktop 正在运行但未开放 CDP 调试端口；CCSM 不会静默终止 Codex，请退出后从 CCSM 启动或等待下次 CCSM 启动 Codex 时自动注入。".into();
        let mut guard = inner.lock().await;
        guard.injected_target_ids.clear();
        guard.injected_catalog_fingerprint = None;
        guard.last_picker_readiness_signature = None;
        return;
    }

    // 3. 同时比较 target 和目录。renderer 补丁持有模型目录状态，因此 Provider
    // 目录变化时，即使 target ID 不变也必须重新注入。
    let catalog = match load_cc_switch_model_catalog_projection_outcome() {
        Ok(CodexModelCatalogLoadOutcome::Managed(catalog)) => catalog,
        Ok(CodexModelCatalogLoadOutcome::Unmanaged { model_provider }) => {
            release_unmanaged_picker(&current_targets, model_provider.as_deref(), status, inner)
                .await;
            return;
        }
        Err(error) => {
            let mut s = status.lock().await;
            s.codex_running = true;
            s.cdp_available = true;
            s.picker_ready_target_count = 0;
            s.picker_status = CodexModelPickerReadiness::Unverified;
            s.picker_diagnostics = None;
            s.picker_verification_issues.clear();
            s.last_event = "模型目录加载失败".into();
            s.message = format!("无法加载 CCSM 模型目录: {error}");
            log::warn!("Codex 守护: 模型目录加载失败: {error}");
            return;
        }
    };
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
        return;
    }

    // 4. 有新 target、目录变化或 renderer 状态丢失时尝试注入。
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
}

async fn release_unmanaged_picker(
    targets: &[(String, String)],
    model_provider: Option<&str>,
    status: &Arc<Mutex<CodexGuardianStatus>>,
    inner: &Arc<Mutex<GuardianInner>>,
) {
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

    #[tokio::test]
    async fn unmanaged_catalog_release_clears_previous_guardian_ownership() {
        let inner = Arc::new(Mutex::new(GuardianInner {
            injected_target_ids: vec!["previous-renderer".to_string()],
            injected_catalog_fingerprint: Some("previous-catalog".to_string()),
            inject_generation: 7,
            last_picker_readiness_signature: Some("previous-readiness".to_string()),
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
