use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::{Child, Output};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use std::time::Instant;

use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

#[path = "codex_windows_launch.rs"]
mod windows_launch;

pub(crate) const DEFAULT_CODEX_DEBUG_PORT: u16 = 9229;
pub(crate) const CDP_HTTP_TIMEOUT: Duration = Duration::from_secs(2);
const CDP_CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
const CDP_COMMAND_TIMEOUT: Duration = Duration::from_secs(4);
const MODEL_PICKER_PATCH_KEY: &str = "__ccSwitchCodexAppCompatibilityV9";
const REMEMBERED_CODEX_DESKTOP_EXECUTABLE_FILENAME: &str = "codex-desktop-executable.json";
pub(crate) const MANUAL_SUMMARY_REQUEST_MARKER: &str =
    "[CCSwitch internal request: manual-summary-v1]";
pub(crate) const MANUAL_SUMMARY_REQUEST_INSTRUCTION: &str =
    "This is a manual coding-agent summary, not context compaction.";
static CODEX_REQUEST_HEALTH_WARNINGS: OnceLock<Mutex<HashMap<String, CodexRequestHealthWarning>>> =
    OnceLock::new();
static CODEX_REQUEST_HEALTH_WARNING_SYNC: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
static CODEX_REQUEST_HEALTH_WARNINGS_SUPPRESSED: AtomicBool = AtomicBool::new(false);
static CODEX_RENDERER_RUNTIME_FINGERPRINT: OnceLock<String> = OnceLock::new();
#[cfg(any(target_os = "macos", test))]
const CODEX_DESKTOP_BUNDLE_IDENTIFIER: &str = "com.openai.codex";

fn codex_renderer_runtime_fingerprint() -> &'static str {
    CODEX_RENDERER_RUNTIME_FINGERPRINT
        .get_or_init(|| {
            let mut hasher = Sha256::new();
            hasher.update(b"ccswitch-codex-renderer-runtime-fingerprint-v2\0");
            hasher.update(codex_renderer_runtime_template_for_fingerprint().as_bytes());
            let digest = hasher.finalize();
            let encoded = digest
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            format!("sha256-{encoded}")
        })
        .as_str()
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexRequestHealthWarning {
    pub token: String,
    pub title: String,
    pub detail: String,
    pub instruction: String,
    pub expires_at_ms: u64,
}

fn codex_request_health_warnings() -> &'static Mutex<HashMap<String, CodexRequestHealthWarning>> {
    CODEX_REQUEST_HEALTH_WARNINGS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn codex_request_health_warning_sync_lock() -> &'static tokio::sync::Mutex<()> {
    CODEX_REQUEST_HEALTH_WARNING_SYNC.get_or_init(|| tokio::sync::Mutex::new(()))
}

pub(crate) fn show_codex_request_health_warning(warning: CodexRequestHealthWarning) {
    let settings = crate::settings::get_settings();
    if !crate::settings::request_health_windows_notifications_active(&settings.request_health) {
        clear_codex_request_health_warnings();
        return;
    }
    CODEX_REQUEST_HEALTH_WARNINGS_SUPPRESSED.store(false, Ordering::Release);
    codex_request_health_warnings()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(warning.token.clone(), warning);
    spawn_codex_request_health_warning_sync();
}

pub(crate) fn clear_codex_request_health_warnings() {
    CODEX_REQUEST_HEALTH_WARNINGS_SUPPRESSED.store(true, Ordering::Release);
    codex_request_health_warnings()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
    spawn_codex_request_health_warning_sync();
}

pub(crate) fn hide_codex_request_health_warning(token: &str) {
    if codex_request_health_warnings()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(token)
        .is_some()
    {
        spawn_codex_request_health_warning_sync();
    }
}

fn spawn_codex_request_health_warning_sync() {
    schedule_codex_request_health_warning_sync(|| {
        tauri::async_runtime::spawn(async {
            if let Err(error) = sync_codex_request_health_warnings().await {
                log::debug!("[RequestHealth] Codex advisory warning was not injected: {error}");
            }
        });
    });
}

fn schedule_codex_request_health_warning_sync(spawn_sync: impl FnOnce()) {
    if crate::config::automatic_codex_desktop_effects_allowed() {
        spawn_sync();
    }
}

async fn sync_codex_request_health_warnings() -> Result<usize, String> {
    let _sync_guard = codex_request_health_warning_sync_lock().lock().await;
    let settings = crate::settings::get_settings();
    let suppressed = CODEX_REQUEST_HEALTH_WARNINGS_SUPPRESSED.load(Ordering::Acquire)
        || !crate::settings::request_health_windows_notifications_active(&settings.request_health);
    let mut warnings = codex_request_health_warnings()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .values()
        .cloned()
        .collect::<Vec<_>>();
    if suppressed {
        warnings.clear();
    }
    warnings.sort_by(|left, right| left.token.cmp(&right.token));
    let warnings_json = serde_json::to_string(&warnings)
        .map_err(|error| format!("Failed to serialize Codex Request Health warnings: {error}"))?;
    let script = format!(
        r#"(() => {{
          const state = window[{patch_key:?}];
          if (!state || typeof state.syncRequestHealthWarnings !== "function") return false;
          state.syncRequestHealthWarnings({warnings_json}, {suppressed});
          return true;
        }})()"#,
        patch_key = MODEL_PICKER_PATCH_KEY,
    );
    let mut updated_targets = 0usize;
    for port in candidate_debug_ports(DEFAULT_CODEX_DEBUG_PORT) {
        let targets = match list_cdp_targets(port).await {
            Ok(targets) => targets,
            Err(_) => continue,
        };
        let targets = match pick_codex_page_targets(&targets, port) {
            Ok(targets) => targets,
            Err(_) => continue,
        };
        for target in targets {
            let Some(websocket_url) = target.web_socket_debugger_url.as_deref() else {
                continue;
            };
            let evaluation = evaluate_cdp_expression(websocket_url, &script).await?;
            if evaluation
                .pointer("/result/result/value")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                updated_targets += 1;
            }
        }
    }
    Ok(updated_targets)
}
/// Codex App 历史目录与模型兼容层安装命令的执行结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelPickerUnlockResult {
    pub attempted_ports: Vec<u16>,
    pub debug_port: Option<u16>,
    pub target_id: Option<String>,
    pub target_title: Option<String>,
    pub target_url: Option<String>,
    pub model_count: usize,
    pub model_names: Vec<String>,
    pub injected: bool,
    pub launched: bool,
    pub codex_executable: Option<String>,
    pub history_sync_requested: bool,
    pub history_catalog_complete: Option<bool>,
    pub history_catalog_count: Option<usize>,
    pub all_provider_history_patched: bool,
    pub history_refresh_requested: bool,
    pub message: String,
}

/// renderer 脚本返回的新版历史目录同步证据。
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct CodexAppCompatibilityEvidence {
    model_count: usize,
    catalog_diagnostics: Option<CodexModelCatalogDiagnostics>,
    picker_diagnostics: Option<CodexModelPickerDiagnostics>,
    reasoning_query_cache_count: Option<usize>,
    catalog_payload_preserved: bool,
    app_server_patch_installed: bool,
    history_sync_requested: bool,
    history_catalog_complete: Option<bool>,
    history_catalog_count: Option<usize>,
    all_provider_history_patched: bool,
    history_refresh_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexModelCatalogDiagnostics {
    reasoning_model_count: usize,
    max_effort_model_count: usize,
    ultra_effort_model_count: usize,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
enum CodexModelPickerReadiness {
    Ready,
    #[default]
    Pending,
    Error,
    Mismatch,
    Unverified,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub(crate) struct CodexModelPickerDiagnostics {
    status: CodexModelPickerReadiness,
    picker_observer_count: usize,
    success_observer_count: usize,
    error_observer_count: usize,
    pending_observer_count: usize,
    unsupported_observer_count: usize,
    unreadable_observer_count: usize,
    effort_mismatch_count: usize,
    flag_mismatch_count: usize,
    missing_max_model_count: usize,
    missing_ultra_model_count: usize,
    selected_max_model_count: usize,
    selected_ultra_model_count: usize,
}

/// 注入脚本需要的模型目录投影，避免把整个 catalog 私有字段泄漏到 renderer。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexModelCatalogProjection {
    default_model: Option<String>,
    model_provider: Option<String>,
    catalog_available: bool,
    model_names: Vec<String>,
    models: Vec<Value>,
}

pub(crate) enum CodexModelCatalogLoadOutcome {
    Managed(CodexModelCatalogProjection),
    Unmanaged { model_provider: Option<String> },
}

impl CodexModelCatalogProjection {
    /// 构造不含路由模型的兼容投影，使历史目录修复不依赖 CCSM 模型目录是否已生成。
    pub(crate) fn empty() -> Self {
        Self {
            default_model: None,
            model_provider: None,
            catalog_available: false,
            model_names: Vec::new(),
            models: Vec::new(),
        }
    }

    /// 返回本次 renderer 注入实际使用的目录指纹。
    pub(crate) fn fingerprint(&self) -> String {
        let payload = serde_json::to_vec(self).unwrap_or_default();
        hex::encode(Sha256::digest(payload))
    }
}

/// Chrome DevTools Protocol `/json` 返回的页面 target 摘要。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub(crate) struct CdpTarget {
    pub(crate) id: String,
    #[serde(rename = "type")]
    pub(crate) target_type: String,
    #[serde(default)]
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) url: String,
    #[serde(default, rename = "webSocketDebuggerUrl")]
    pub(crate) web_socket_debugger_url: Option<String>,
}

// A failed managed snapshot must leave the renderer untouched. Only a proven
// unmanaged config may install an empty payload to release picker ownership.
fn resolve_codex_model_picker_catalog(
    outcome: Result<CodexModelCatalogLoadOutcome, String>,
) -> Result<(CodexModelCatalogProjection, bool), String> {
    Ok(match outcome? {
        CodexModelCatalogLoadOutcome::Managed(catalog) => (catalog, false),
        CodexModelCatalogLoadOutcome::Unmanaged { model_provider } => {
            let mut projection = CodexModelCatalogProjection::empty();
            projection.model_provider = model_provider;
            (projection, true)
        }
    })
}

/// 尝试为当前或新启动的 Codex App 安装 renderer 兼容层。
///
/// 副作用：
/// - 若发现已开放 CDP 的 Codex renderer，会触发新版历史目录同步并修复模型菜单；
/// - 若未发现 CDP 且 Codex 未运行，会以 remote debugging 参数启动 Codex。
pub async fn unlock_codex_model_picker() -> Result<CodexModelPickerUnlockResult, String> {
    let (catalog, catalog_released) =
        resolve_codex_model_picker_catalog(load_cc_switch_model_catalog_projection_outcome())?;
    let attempted_ports = candidate_debug_ports(DEFAULT_CODEX_DEBUG_PORT);

    if let Some(result) =
        try_inject_on_candidate_ports_with_state(&catalog, &attempted_ports, catalog_released).await
    {
        return Ok(result);
    }

    // A renderer target can be reachable over CDP while the compatibility
    // script is still converging (or while one of its optional discovery
    // hooks is unavailable). Distinguish that state from a plain Codex launch
    // with no CDP port so the UI does not tell the user to restart a healthy,
    // injectable process.
    let renderer_port = first_codex_renderer_debug_port(&attempted_ports).await;
    let running_main = detect_running_codex_main_process();
    if let Some(running_main) = running_main {
        let remembered = remember_codex_desktop_executable(&running_main).ok();
        return Ok(CodexModelPickerUnlockResult {
            attempted_ports,
            debug_port: renderer_port,
            target_id: None,
            target_title: None,
            target_url: None,
            model_count: catalog.model_names.len(),
            model_names: catalog.model_names,
            injected: false,
            launched: false,
            codex_executable: Some(
                remembered
                    .as_ref()
                    .unwrap_or(&running_main)
                    .display()
                    .to_string(),
            ),
            history_sync_requested: false,
            history_catalog_complete: None,
            history_catalog_count: None,
            all_provider_history_patched: false,
            history_refresh_requested: false,
            message: codex_renderer_injection_failure_message(renderer_port.is_some()).to_string(),
        });
    }

    let executable =
        resolve_codex_executable().ok_or_else(codex_desktop_executable_not_found_message)?;
    launch_codex_with_debug_port(&executable, DEFAULT_CODEX_DEBUG_PORT)?;

    let mut last_result = None;
    for _ in 0..30 {
        if let Some(result) = try_inject_on_candidate_ports_with_state(
            &catalog,
            &[DEFAULT_CODEX_DEBUG_PORT],
            catalog_released,
        )
        .await
        {
            return Ok(CodexModelPickerUnlockResult {
                launched: true,
                codex_executable: Some(executable.display().to_string()),
                ..result
            });
        }
        last_result = Some(CodexModelPickerUnlockResult {
            attempted_ports: vec![DEFAULT_CODEX_DEBUG_PORT],
            debug_port: Some(DEFAULT_CODEX_DEBUG_PORT),
            target_id: None,
            target_title: None,
            target_url: None,
            model_count: catalog.model_names.len(),
            model_names: catalog.model_names.clone(),
            injected: false,
            launched: true,
            codex_executable: Some(executable.display().to_string()),
            history_sync_requested: false,
            history_catalog_complete: None,
            history_catalog_count: None,
            all_provider_history_patched: false,
            history_refresh_requested: false,
            message: "Codex was launched with remote debugging; waiting for the renderer target."
                .to_string(),
        });
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    Ok(last_result.unwrap_or(CodexModelPickerUnlockResult {
        attempted_ports: vec![DEFAULT_CODEX_DEBUG_PORT],
        debug_port: Some(DEFAULT_CODEX_DEBUG_PORT),
        target_id: None,
        target_title: None,
        target_url: None,
        model_count: catalog.model_names.len(),
        model_names: catalog.model_names,
        injected: false,
        launched: true,
        codex_executable: Some(executable.display().to_string()),
        history_sync_requested: false,
        history_catalog_complete: None,
        history_catalog_count: None,
        all_provider_history_patched: false,
        history_refresh_requested: false,
        message: "Codex was launched, but no injectable renderer target appeared before timeout."
            .to_string(),
    }))
}

async fn first_codex_renderer_debug_port(ports: &[u16]) -> Option<u16> {
    for port in ports {
        let Ok(targets) = list_cdp_targets(*port).await else {
            continue;
        };
        if pick_codex_page_targets(&targets, *port).is_ok() {
            return Some(*port);
        }
    }
    None
}

fn codex_renderer_injection_failure_message(cdp_target_seen: bool) -> &'static str {
    if cdp_target_seen {
        "Codex renderer target detected on a CDP port, but the compatibility layer did not finish installing. Retry the renderer compatibility check before restarting Codex."
    } else {
        "Codex App is already running without an injectable CDP port. Fully quit Codex, then launch it from CCSwitchMulti so the history catalog and model compatibility layer can be installed."
    }
}

/// 在用户显式开启的“随 CCSwitchMulti 启动 Codex Desktop”设置下启动 Codex。
///
/// 这个入口不属于系统自启注册流程；调用方必须先读取独立设置。已有 Codex
/// 主进程时保持幂等，不重复拉起或干扰现有会话。
pub(crate) fn launch_codex_desktop_with_ccswitch(enabled: bool) -> Result<bool, String> {
    let codex_running = is_codex_desktop_running();
    if !should_launch_codex_desktop_with_ccswitch(enabled, codex_running) {
        return Ok(false);
    }

    let executable =
        resolve_codex_executable().ok_or_else(codex_desktop_executable_not_found_message)?;
    launch_codex_with_debug_port(&executable, DEFAULT_CODEX_DEBUG_PORT)?;
    Ok(true)
}

pub(crate) fn is_codex_desktop_running() -> bool {
    detect_running_codex_main_process().is_some()
}

fn should_launch_codex_desktop_with_ccswitch(enabled: bool, codex_running: bool) -> bool {
    enabled && !codex_running
}

/// 返回当前平台的 Desktop 可执行文件发现失败说明，避免 Windows-only 文案误导 macOS/Linux 用户。
fn codex_desktop_executable_not_found_message() -> String {
    let platform_sources = if cfg!(target_os = "windows") {
        "running Desktop process, remembered Desktop path, MSIX/Appx package metadata and manifest, App Paths registry entries, PATH commands, and common local install folders"
    } else if cfg!(target_os = "macos") {
        "running Desktop process, remembered Desktop path, /Applications, ~/Applications, and Spotlight-discovered com.openai.codex bundles (Codex.app or ChatGPT.app)"
    } else if cfg!(target_os = "linux") {
        "running Desktop process, remembered Desktop path, PATH entries for Codex/Codex.AppImage, .desktop entries with absolute Exec paths, and common AppImage or /opt install folders"
    } else {
        "running Desktop process, remembered Desktop path, and platform-specific install folders"
    };
    format!(
        "Codex Desktop executable was not found. CCSwitchMulti checked {platform_sources}. Install or start the Codex Desktop app once. The Desktop menu unlock flow will not launch CLI/app-server codex as an Electron shell; Codex CLI/app-server is still supported through live config.toml, model_catalog_json, the local /v1/models endpoint, and MultiRouter request routing."
    )
}

/// 从 cc-switch 生成的 catalog 中读取模型名和 renderer 需要的最小描述。
fn parse_codex_live_config_snapshot(text: &str) -> Result<toml::Value, String> {
    text.parse::<toml::Value>()
        .map_err(|_| "The active Codex config is malformed".to_string())
}

fn codex_catalog_path_from_live_snapshot(
    config: &toml::Value,
    config_text: &str,
    config_dir: &Path,
) -> Result<Option<PathBuf>, String> {
    let Some(pointer) = config.get("model_catalog_json") else {
        return Ok(None);
    };
    let pointer = pointer
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "The active Codex catalog pointer is malformed".to_string())?;
    let resolved = crate::codex_config::resolve_cc_switch_catalog_path(config_text, config_dir);
    if resolved.is_none()
        && Path::new(pointer)
            .file_name()
            .and_then(|name| name.to_str())
            == Some(crate::codex_config::CC_SWITCH_CODEX_MODEL_CATALOG_FILENAME)
    {
        return Err("The active CCSwitchMulti catalog pointer is invalid".to_string());
    }
    Ok(resolved)
}

pub(crate) fn load_cc_switch_model_catalog_projection_outcome(
) -> Result<CodexModelCatalogLoadOutcome, String> {
    let config_text =
        crate::codex_config::read_existing_codex_config_text().map_err(|e| e.to_string())?;
    let config = parse_codex_live_config_snapshot(&config_text)?;
    let config_dir = crate::codex_config::get_codex_config_dir();
    let default_model = config
        .get("model")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let model_provider = config
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| Some("openai".to_string()));
    let catalog_path = codex_catalog_path_from_live_snapshot(&config, &config_text, &config_dir)?;
    let Some(catalog_path) = catalog_path else {
        if crate::codex_config::read_existing_codex_config_text().map_err(|e| e.to_string())?
            != config_text
        {
            return Err("The active Codex config changed while reading its catalog".to_string());
        }
        return Ok(CodexModelCatalogLoadOutcome::Unmanaged { model_provider });
    };
    let catalog = crate::config::read_json_file::<Value>(&catalog_path).ok();
    let cache_path = config_dir.join("models_cache.json");
    let cache = crate::config::read_json_file::<Value>(&cache_path).ok();
    let inline_catalog = read_active_codex_provider_inline_model_catalog(&config);
    // A provider switch must not bind files read from one config revision to
    // the provider from another revision. Keep the last renderer payload until
    // the writer has finished publishing a consistent snapshot.
    if crate::codex_config::read_existing_codex_config_text().map_err(|e| e.to_string())?
        != config_text
    {
        return Err("The active Codex config changed while reading its catalog".to_string());
    }
    select_cc_switch_model_catalog_projection(
        catalog.as_ref(),
        cache.as_ref(),
        inline_catalog.as_ref(),
        default_model,
        model_provider,
    )
    .map(CodexModelCatalogLoadOutcome::Managed)
    .ok_or_else(|| {
        format!(
            "No routed models were found in {}, the CCSwitchMulti models cache, or the active provider inline catalog",
            catalog_path.display()
        )
    })
}

fn select_cc_switch_model_catalog_projection(
    catalog: Option<&Value>,
    cache: Option<&Value>,
    inline_catalog: Option<&Value>,
    default_model: Option<String>,
    model_provider: Option<String>,
) -> Option<CodexModelCatalogProjection> {
    // The canonical modelCatalog is authoritative even when it is empty. Do
    // not reinterpret a top-level array as the canonical schema: accepting it
    // here can turn a malformed/legacy value into an empty managed catalog.
    if let Some(catalog) = catalog
        .filter(|catalog| catalog_matches_model_provider(catalog, model_provider.as_deref(), true))
    {
        if let Some(projection) = codex_model_catalog_projection_from_value_with_shape(
            catalog,
            default_model.clone(),
            model_provider.clone(),
            false,
        ) {
            return Some(projection);
        }
    }

    // Fallback sources are best-effort snapshots. An empty fallback must not
    // prevent a later source (notably the active provider's inline catalog)
    // from supplying usable models. If every fallback is empty, report a load
    // failure and retain the existing renderer state until a usable snapshot
    // is published. Only a canonical empty catalog can clear the picker.
    let mut fallback_candidates = Vec::new();
    if let Some(cache) = cache {
        if cache.get("etag").and_then(Value::as_str) == Some("cc-switch-model-catalog")
            && catalog_matches_model_provider(cache, model_provider.as_deref(), false)
        {
            fallback_candidates.push(cache);
        }
    }
    if let Some(inline_catalog) = inline_catalog {
        fallback_candidates.push(inline_catalog);
    }
    for candidate in &fallback_candidates {
        let Some(projection) = codex_model_catalog_projection_from_value_with_shape(
            candidate,
            default_model.clone(),
            model_provider.clone(),
            true,
        ) else {
            continue;
        };
        if !projection.model_names.is_empty() {
            return Some(projection);
        }
    }
    None
}

fn catalog_matches_model_provider(
    catalog: &Value,
    model_provider: Option<&str>,
    allow_legacy_unbound: bool,
) -> bool {
    let Some(model_provider) = model_provider.filter(|provider| !provider.is_empty()) else {
        return false;
    };
    match catalog.get("ccSwitchModelProvider") {
        Some(provider) => provider.as_str().map(str::trim) == Some(model_provider),
        None => allow_legacy_unbound,
    }
}

/// 从单个目录值构造 renderer 投影。
///
/// `models: []` 是一个结构上完整且权威的目录，不能继续回退到陈旧缓存；
/// 只有缺少数组或形状损坏的值才返回 `None`，让调用方尝试下一个来源。
#[cfg(test)]
fn codex_model_catalog_projection_from_value(
    catalog: &Value,
    default_model: Option<String>,
    model_provider: Option<String>,
) -> Option<CodexModelCatalogProjection> {
    codex_model_catalog_projection_from_value_with_shape(
        catalog,
        default_model,
        model_provider,
        false,
    )
}

fn codex_model_catalog_projection_from_value_with_shape(
    catalog: &Value,
    default_model: Option<String>,
    model_provider: Option<String>,
    allow_top_level_array: bool,
) -> Option<CodexModelCatalogProjection> {
    let has_structural_models_array = catalog.get("models").is_some_and(Value::is_array)
        || (allow_top_level_array && catalog.is_array());
    if !has_structural_models_array {
        return None;
    }
    let (model_names, models) = codex_model_entries_from_catalog_value(catalog);
    Some(CodexModelCatalogProjection {
        default_model: default_model.or_else(|| model_names.first().cloned()),
        model_provider,
        catalog_available: true,
        model_names,
        models,
    })
}

/// Select the payload to expose to the renderer across repeated compatibility
/// injections. A transiently unavailable source may reuse the last complete
/// catalog for the same provider, but it must never cross a provider boundary.
fn catalog_payload_selection_core_script() -> &'static str {
    include_str!("resources/codex_desktop/catalog_payload_selection.js")
}

fn app_server_model_list_scope_core_script() -> &'static str {
    include_str!("resources/codex_desktop/app_server_model_list_scope.js")
}

/// 从当前活动 provider 的 TOML 内联 `models` 读取最后一道模型菜单回退。
///
/// 生成 live config 时，CCSM 会把同一份路由目录同时投射到 JSON catalog、models cache
/// 和活动 provider 内联数组。任一 JSON 文件短暂不可读时，内联数组仍能避免整次 Desktop
/// 会话安装空白名单；这里仅读取活动 provider，不能把未启用 provider 的模型重新注入。
fn read_active_codex_provider_inline_model_catalog(parsed: &toml::Value) -> Option<Value> {
    let provider_id = parsed.get("model_provider").and_then(toml::Value::as_str)?;
    let models = parsed
        .get("model_providers")
        .and_then(|providers| providers.get(provider_id))
        .and_then(|provider| provider.get("models"))
        .and_then(toml::Value::as_array)?
        .clone();
    serde_json::to_value(models)
        .ok()
        .map(|models| json!({ "models": models }))
}

/// 提取 catalog 内所有 Codex Desktop 可识别的模型条目。
fn codex_model_entries_from_catalog_value(catalog: &Value) -> (Vec<String>, Vec<Value>) {
    let Some(entries) = catalog
        .get("models")
        .and_then(Value::as_array)
        .or_else(|| catalog.as_array())
    else {
        return (Vec::new(), Vec::new());
    };

    let mut seen = BTreeSet::new();
    let mut names = Vec::new();
    let mut projected = Vec::new();

    for entry in entries {
        if entry.get("enabled").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let Some(model_name) = codex_model_name(entry) else {
            continue;
        };
        if !seen.insert(model_name.clone()) {
            continue;
        }
        names.push(model_name.clone());
        projected.push(project_codex_model_descriptor(entry, &model_name));
    }

    (names, projected)
}

/// 从单个 catalog 条目中提取稳定模型名，兼容官方/旧版字段别名。
fn codex_model_name(entry: &Value) -> Option<String> {
    ["model", "slug", "id", "name"].into_iter().find_map(|key| {
        entry
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    })
}

/// 将 catalog 条目补齐成 renderer 可直接消费的模型描述。
fn project_codex_model_descriptor(entry: &Value, model_name: &str) -> Value {
    let mut object = entry.as_object().cloned().unwrap_or_default();
    for key in ["model", "slug", "id", "name"] {
        object.insert(key.to_string(), Value::String(model_name.to_string()));
    }
    if !object.contains_key("displayName") {
        let display = object
            .get("display_name")
            .and_then(Value::as_str)
            .unwrap_or(model_name);
        object.insert(
            "displayName".to_string(),
            Value::String(display.to_string()),
        );
    }
    if !object.contains_key("display_name") {
        let display = object
            .get("displayName")
            .and_then(Value::as_str)
            .unwrap_or(model_name);
        object.insert(
            "display_name".to_string(),
            Value::String(display.to_string()),
        );
    }
    object.insert("hidden".to_string(), Value::Bool(false));
    Value::Object(object)
}

/// 在候选 CDP 端口中寻找 Codex renderer 并安装模型白名单补丁。
pub(crate) async fn try_inject_on_candidate_ports(
    catalog: &CodexModelCatalogProjection,
    ports: &[u16],
) -> Option<CodexModelPickerUnlockResult> {
    try_inject_on_candidate_ports_with_state(catalog, ports, false).await
}

async fn try_inject_on_candidate_ports_with_state(
    catalog: &CodexModelCatalogProjection,
    ports: &[u16],
    catalog_released: bool,
) -> Option<CodexModelPickerUnlockResult> {
    let launch_timezone =
        crate::codex_egress_timezone::resolve_launch_timezone(&crate::settings::get_settings());
    for port in ports {
        let targets = match list_cdp_targets(*port).await {
            Ok(targets) => targets,
            Err(_) => continue,
        };
        let targets = match pick_codex_page_targets(&targets, *port) {
            Ok(targets) => targets,
            Err(_) => continue,
        };
        let script = build_model_picker_unlock_script_with_state(catalog, catalog_released);
        let mut injected_target = None;
        let mut compatibility_evidence = CodexAppCompatibilityEvidence::default();
        for target in targets {
            let Some(websocket_url) = target.web_socket_debugger_url.as_deref() else {
                continue;
            };
            if let Ok(evidence) =
                install_script(websocket_url, &script, launch_timezone.as_deref()).await
            {
                if evidence.model_count != catalog.model_names.len() {
                    continue;
                }
                compatibility_evidence = evidence;
                injected_target.get_or_insert(target);
            }
        }
        let Some(target) = injected_target else {
            continue;
        };
        let diagnostics = compatibility_evidence.catalog_diagnostics.as_ref();
        log::info!(
            "Codex picker catalog payload installed: models={}, reasoning_models={:?}, max_models={:?}, ultra_models={:?}, reasoning_query_caches={:?}, app_server_ready={}, picker_diagnostics={:?}, preserved_previous_payload={}, catalog_fingerprint={}, runtime_fingerprint={}",
            catalog.model_names.len(),
            diagnostics.map(|value| value.reasoning_model_count),
            diagnostics.map(|value| value.max_effort_model_count),
            diagnostics.map(|value| value.ultra_effort_model_count),
            compatibility_evidence.reasoning_query_cache_count,
            compatibility_evidence.app_server_patch_installed,
            compatibility_evidence.picker_diagnostics,
            compatibility_evidence.catalog_payload_preserved,
            catalog.fingerprint(),
            codex_renderer_runtime_fingerprint(),
        );
        return Some(CodexModelPickerUnlockResult {
            attempted_ports: ports.to_vec(),
            debug_port: Some(*port),
            target_id: Some(target.id),
            target_title: Some(target.title),
            target_url: Some(target.url),
            model_count: catalog.model_names.len(),
            model_names: catalog.model_names.clone(),
            injected: true,
            launched: false,
            codex_executable: detect_running_codex_main_process()
                .map(|path| path.display().to_string()),
            history_sync_requested: compatibility_evidence.history_sync_requested,
            history_catalog_complete: compatibility_evidence.history_catalog_complete,
            history_catalog_count: compatibility_evidence.history_catalog_count,
            all_provider_history_patched: compatibility_evidence.all_provider_history_patched,
            history_refresh_requested: compatibility_evidence.history_refresh_requested,
            message: if !catalog.catalog_available {
                "Codex App compatibility layer was injected, but no usable CCSwitch catalog was available; existing native model data was left untouched until the catalog can be loaded.".to_string()
            } else if !compatibility_evidence.app_server_patch_installed
                && !catalog.model_names.is_empty()
            {
                "Codex App compatibility layer ran, but no local app-server request client was discovered; the renderer may require a fresh Codex reload before model visibility updates.".to_string()
            } else if compatibility_evidence.all_provider_history_patched {
                "Codex App compatibility layer was injected; all-provider history queries were restored and the native history catalog was refreshed without rewriting history data.".to_string()
            } else if compatibility_evidence.history_sync_requested {
                "Codex App compatibility layer was injected; the native history catalog sync was requested and model visibility was refreshed.".to_string()
            } else {
                "Codex App compatibility layer was injected, but the all-provider history query patch was not installed in this renderer; model visibility was refreshed without rewriting history metadata.".to_string()
            },
        });
    }
    None
}

/// 生成去重后的 CDP 端口探测列表。
pub(crate) fn candidate_debug_ports(preferred: u16) -> Vec<u16> {
    let mut ports = vec![preferred, DEFAULT_CODEX_DEBUG_PORT, 9222, 9223, 9230, 9231];
    ports.sort_unstable();
    ports.dedup();
    ports
}

/// 查询 CDP 页面 target。
pub(crate) async fn list_cdp_targets(debug_port: u16) -> Result<Vec<CdpTarget>, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(CDP_HTTP_TIMEOUT)
        .build()
        .map_err(|error| format!("failed to build CDP client: {error}"))?;
    let urls = [
        format!("http://127.0.0.1:{debug_port}/json"),
        format!("http://[::1]:{debug_port}/json"),
    ];
    let mut errors = Vec::new();
    for url in urls {
        match client.get(&url).send().await {
            Ok(response) => match response.error_for_status() {
                Ok(response) => match response.json::<Vec<CdpTarget>>().await {
                    Ok(targets) => return Ok(targets),
                    Err(error) => errors.push(format!("{url}: invalid target JSON: {error}")),
                },
                Err(error) => errors.push(format!("{url}: {error}")),
            },
            Err(error) => errors.push(format!("{url}: {error}")),
        }
    }
    Err(errors.join("; "))
}

/// 选择最可能属于 Codex Desktop 的 renderer 页面。
///
/// CDP ports can belong to another application, including the default port.
/// Wait for a positive Codex marker before injecting into any renderer.
pub(crate) fn pick_codex_page_targets(
    targets: &[CdpTarget],
    debug_port: u16,
) -> Result<Vec<CdpTarget>, String> {
    let needs_listener_identity = targets.iter().any(|target| {
        target.target_type == "page"
            && target
                .web_socket_debugger_url
                .as_deref()
                .is_some_and(|url| !url.is_empty())
            && !target_matches_codex_desktop(target, false)
            && target_matches_codex_desktop(target, true)
    });
    let verified_listener =
        needs_listener_identity && codex_debug_port_has_verified_desktop_listener(debug_port);
    pick_codex_page_targets_with_listener_identity(targets, verified_listener)
}

fn pick_codex_page_targets_with_listener_identity(
    targets: &[CdpTarget],
    verified_listener: bool,
) -> Result<Vec<CdpTarget>, String> {
    let pages = targets.iter().filter(|target| {
        target.target_type == "page"
            && target
                .web_socket_debugger_url
                .as_deref()
                .is_some_and(|url| !url.is_empty())
    });
    let mut codex_pages = Vec::new();
    for target in pages {
        if target_matches_codex_desktop(target, verified_listener) {
            codex_pages.push(target.clone());
        }
    }
    if !codex_pages.is_empty() {
        return Ok(codex_pages);
    }
    Err("No Codex Desktop page target was found on CDP port".to_string())
}

/// 判断 CDP target 是否明确指向 Codex Desktop，兼容当前 packaged shell URL。
fn target_matches_codex_desktop(target: &CdpTarget, verified_listener: bool) -> bool {
    let Ok(url) = url::Url::parse(&target.url) else {
        return false;
    };
    if !matches!(url.scheme(), "app" | "file") {
        return false;
    }
    // The current packaged Desktop shell serves its renderer from the
    // scheme-relative `app://-/index.html` URL. Its document title is the
    // active task title, so it does not contain a stable "Codex" marker.
    let haystack = format!("{} {}", target.title, target.url).to_ascii_lowercase();
    haystack.contains("codex")
        || (verified_listener
            && url.scheme() == "app"
            && url.host_str() == Some("-")
            && matches!(url.path(), "/" | "/index.html"))
}

fn parse_cdp_listener_process_ids(output: &str) -> Vec<u32> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            line.strip_prefix('p').unwrap_or(line).parse::<u32>().ok()
        })
        .filter(|pid| *pid != 0)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

#[cfg(any(target_os = "windows", test))]
fn cdp_listener_belongs_to_verified_codex_shell(
    listener_pids: &[u32],
    processes: &[crate::commands::CodexAppServerProcessDiagnostics],
) -> bool {
    !listener_pids.is_empty()
        && listener_pids.iter().all(|pid| {
            processes
                .iter()
                .any(|process| !process.is_app_server && process.pid == *pid)
        })
}

#[cfg(target_os = "windows")]
fn codex_debug_port_has_verified_desktop_listener(debug_port: u16) -> bool {
    use std::os::windows::process::CommandExt;
    let script = format!(
        "Get-NetTCPConnection -State Listen -LocalPort {debug_port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"
    );
    let Ok(output) = crate::powershell::command()
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(0x08000000)
        .output()
    else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let listener_pids = parse_cdp_listener_process_ids(&String::from_utf8_lossy(&output.stdout));
    if listener_pids.is_empty() {
        return false;
    }
    let (processes, error) = crate::commands::query_codex_processes();
    error.is_none() && cdp_listener_belongs_to_verified_codex_shell(&listener_pids, &processes)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn codex_debug_port_has_verified_desktop_listener(debug_port: u16) -> bool {
    let Some(output) = command_stdout_trimmed(Command::new("lsof").args([
        "-nP",
        "-a",
        &format!("-iTCP:{debug_port}"),
        "-sTCP:LISTEN",
        "-Fp",
    ])) else {
        return false;
    };
    let listener_pids = parse_cdp_listener_process_ids(&output);
    !listener_pids.is_empty()
        && listener_pids.into_iter().all(|pid| {
            let Some(args) = command_stdout_trimmed(Command::new("ps").args([
                "-p",
                &pid.to_string(),
                "-o",
                "args=",
            ])) else {
                return false;
            };
            if args.split_whitespace().any(|arg| {
                let arg = arg.trim_matches('"');
                arg == "--type" || arg.starts_with("--type=")
            }) {
                return false;
            }
            #[cfg(target_os = "linux")]
            let executable = std::fs::read_link(format!("/proc/{pid}/exe")).ok();
            #[cfg(target_os = "macos")]
            let executable = command_stdout_trimmed(Command::new("ps").args([
                "-p",
                &pid.to_string(),
                "-o",
                "comm=",
            ]))
            .map(PathBuf::from);
            executable.is_some_and(|path| canonical_codex_desktop_executable_path(&path).is_ok())
        })
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn codex_debug_port_has_verified_desktop_listener(_debug_port: u16) -> bool {
    false
}

/// Patch the current document through CDP. New-document registrations are
/// session-scoped and disappear when this connection closes; the guardian
/// verifies the renderer marker and reapplies after navigation instead.
pub(crate) async fn install_script(
    websocket_url: &str,
    script: &str,
    timezone: Option<&str>,
) -> Result<CodexAppCompatibilityEvidence, String> {
    let (socket, _) = tokio::time::timeout(CDP_CONNECT_TIMEOUT, connect_async(websocket_url))
        .await
        .map_err(|_| "timed out connecting CDP websocket".to_string())?
        .map_err(|error| format!("failed to connect CDP websocket: {error}"))?;
    let mut session = CdpSession::new(socket);
    session.send_command(1, "Runtime.enable", json!({})).await?;
    if let Some(timezone) = timezone {
        // `TZ` is inherited by a directly launched Desktop/app-server process,
        // while Chromium has its own ICU timezone controller. Apply the same
        // user-selected IANA identifier to the renderer through the documented
        // CDP command as well. This remains best-effort so the experimental
        // override can never block the model/history compatibility layer.
        if let Err(error) = session
            .send_command(
                2,
                "Emulation.setTimezoneOverride",
                codex_timezone_override_parameters(timezone),
            )
            .await
        {
            log::warn!("Codex renderer timezone override was not applied: {error}");
        }
    }
    let evaluation = session
        .send_command(
            3,
            "Runtime.evaluate",
            json!({
                "expression": script,
                "awaitPromise": true,
                "returnByValue": true,
                "allowUnsafeEvalBlockedByCSP": true
            }),
        )
        .await?;
    codex_app_compatibility_evidence_from_evaluation(&evaluation)
}

fn codex_renderer_compatibility_probe_script(catalog: &CodexModelCatalogProjection) -> String {
    let payload = serde_json::to_string(catalog).unwrap_or_else(|_| "{}".to_string());
    let runtime_fingerprint = codex_renderer_runtime_fingerprint();
    let catalog_payload_selection_core = catalog_payload_selection_core_script();
    format!(
        r#"(() => {{
          const state = window[{MODEL_PICKER_PATCH_KEY:?}];
          if (!state || state.rendererRuntimeFingerprint !== {runtime_fingerprint:?}
              || !state.interval || !state.messagePatchInstalled) return false;
          {catalog_payload_selection_core}
          const expected = selectCatalogPayload(state.payload, {payload});
          return JSON.stringify(state.payload) === JSON.stringify(expected);
        }})()"#
    )
}

pub(crate) async fn codex_renderer_compatibility_is_current(
    websocket_url: &str,
    catalog: &CodexModelCatalogProjection,
) -> Result<bool, String> {
    let evaluation = evaluate_cdp_expression(
        websocket_url,
        &codex_renderer_compatibility_probe_script(catalog),
    )
    .await?;
    if evaluation.pointer("/result/exceptionDetails").is_some() {
        return Ok(false);
    }
    Ok(evaluation
        .pointer("/result/result/value")
        .and_then(Value::as_bool)
        .unwrap_or(false))
}

fn codex_model_picker_release_script(model_provider: Option<&str>) -> String {
    let provider = serde_json::to_string(&model_provider).unwrap_or_else(|_| "null".to_string());
    let release_core = include_str!("resources/codex_desktop/model_picker_release.js");
    format!(
        r#"(() => {{
      const state = window[{MODEL_PICKER_PATCH_KEY:?}];
      if (!state) return true;
      {release_core}
      return releaseCodexModelPicker({provider});
    }})()"#
    )
}

pub(crate) async fn deactivate_codex_model_picker(
    websocket_url: &str,
    model_provider: Option<&str>,
) -> Result<bool, String> {
    let evaluation = evaluate_cdp_expression(
        websocket_url,
        &codex_model_picker_release_script(model_provider),
    )
    .await?;
    Ok(evaluation
        .pointer("/result/result/value")
        .and_then(Value::as_bool)
        .unwrap_or(false))
}

fn codex_timezone_override_parameters(timezone: &str) -> Value {
    json!({ "timezoneId": timezone })
}

/// 从 CDP `Runtime.evaluate` 结果中提取原生历史同步状态，并把脚本异常转为明确错误。
fn codex_app_compatibility_evidence_from_evaluation(
    evaluation: &Value,
) -> Result<CodexAppCompatibilityEvidence, String> {
    if let Some(exception) = evaluation
        .get("result")
        .and_then(|result| result.get("exceptionDetails"))
    {
        return Err(format!(
            "Codex App compatibility script failed: {exception}"
        ));
    }
    let value = evaluation
        .pointer("/result/result/value")
        .ok_or_else(|| "Codex App compatibility script returned no value".to_string())?;
    if value.get("status").and_then(Value::as_str) != Some("ok") {
        return Err("Codex App compatibility script returned no success status".to_string());
    }
    if value.get("patchKey").and_then(Value::as_str) != Some(MODEL_PICKER_PATCH_KEY) {
        return Err("Codex App compatibility script returned an unexpected patch key".to_string());
    }
    let history_sync = value.get("historySync").unwrap_or(&Value::Null);
    let history_query_patch = value.get("historyQueryPatch").unwrap_or(&Value::Null);
    let history_hydration_failed = history_query_patch
        .pointer("/lineageHydration/failed")
        .and_then(Value::as_array)
        .is_some_and(|failures| !failures.is_empty());
    Ok(CodexAppCompatibilityEvidence {
        model_count: value
            .get("modelCount")
            .and_then(Value::as_u64)
            .and_then(|count| usize::try_from(count).ok())
            .unwrap_or(0),
        catalog_diagnostics: value
            .get("catalogDiagnostics")
            .cloned()
            .and_then(|diagnostics| serde_json::from_value(diagnostics).ok()),
        picker_diagnostics: value
            .get("pickerDiagnostics")
            .cloned()
            .and_then(|diagnostics| serde_json::from_value(diagnostics).ok()),
        reasoning_query_cache_count: value
            .get("reasoningQueryCacheCount")
            .and_then(Value::as_u64)
            .and_then(|count| usize::try_from(count).ok()),
        catalog_payload_preserved: value
            .get("catalogPayloadPreserved")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        app_server_patch_installed: value
            .get("appServerPatchInstalled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        history_sync_requested: history_sync
            .get("requested")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        history_catalog_complete: history_sync.get("complete").and_then(Value::as_bool),
        history_catalog_count: history_sync
            .get("afterCount")
            .and_then(Value::as_u64)
            .and_then(|count| usize::try_from(count).ok()),
        all_provider_history_patched: history_query_patch
            .get("patched")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        history_refresh_requested: history_query_patch
            .get("refreshRequested")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            && !history_hydration_failed,
    })
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexRuntimeTimezone {
    pub(crate) timezone: String,
    pub(crate) utc_offset: String,
}

fn codex_runtime_timezone_from_evaluation(
    evaluation: &Value,
) -> Result<CodexRuntimeTimezone, String> {
    if let Some(exception) = evaluation
        .get("result")
        .and_then(|result| result.get("exceptionDetails"))
    {
        return Err(format!(
            "Codex runtime timezone inspection failed: {exception}"
        ));
    }
    let value = evaluation
        .pointer("/result/result/value")
        .ok_or_else(|| "Codex runtime timezone inspection returned no value".to_string())?;
    let timezone = value
        .get("timezone")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|timezone| !timezone.is_empty())
        .ok_or_else(|| "Codex renderer did not report an IANA timezone".to_string())?;
    let minutes = value
        .get("utcOffsetMinutes")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Codex renderer did not report a UTC offset".to_string())?;
    let sign = if minutes < 0 { '-' } else { '+' };
    let absolute = minutes.unsigned_abs();
    Ok(CodexRuntimeTimezone {
        timezone: timezone.to_string(),
        utc_offset: format!("{sign}{:02}:{:02}", absolute / 60, absolute % 60),
    })
}

async fn evaluate_cdp_expression(websocket_url: &str, expression: &str) -> Result<Value, String> {
    evaluate_cdp_expression_if_authorized(websocket_url, expression, &|_| true)
        .await?
        .ok_or_else(|| "CDP expression authorization was revoked".to_string())
}

async fn evaluate_cdp_expression_if_authorized(
    websocket_url: &str,
    expression: &str,
    authorize: &(impl Fn(bool) -> bool + Sync),
) -> Result<Option<Value>, String> {
    if !authorize(false) {
        return Ok(None);
    }
    let (socket, _) = tokio::time::timeout(CDP_CONNECT_TIMEOUT, connect_async(websocket_url))
        .await
        .map_err(|_| "timed out connecting CDP websocket".to_string())?
        .map_err(|error| format!("failed to connect CDP websocket: {error}"))?;
    let mut session = CdpSession::new(socket);
    session.send_command(1, "Runtime.enable", json!({})).await?;
    // Connection/Runtime.enable can wait while the user disables recovery or
    // changes providers. Recheck canonical authorization immediately before
    // sending the renderer expression that commits a prepared continuation.
    // Only this final check transitions the backend reservation to committing;
    // connection preflight must not consume a continuation attempt.
    if !authorize(true) {
        return Ok(None);
    }
    session
        .send_command(
            2,
            "Runtime.evaluate",
            json!({
                "expression": expression,
                "returnByValue": true,
                "allowUnsafeEvalBlockedByCSP": true
            }),
        )
        .await
        .map(Some)
}

/// Read the timezone from a currently running Codex renderer. This verifies the
/// child-process `TZ` result instead of inferring it from Windows settings.
pub(crate) async fn inspect_codex_runtime_timezone() -> Result<CodexRuntimeTimezone, String> {
    let ports = candidate_debug_ports(DEFAULT_CODEX_DEBUG_PORT);
    let expression = r#"(() => ({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      utcOffsetMinutes: -new Date().getTimezoneOffset()
    }))()"#;
    let mut errors = Vec::new();
    for port in ports {
        let targets = match list_cdp_targets(port).await {
            Ok(targets) => targets,
            Err(error) => {
                errors.push(format!("port {port}: {error}"));
                continue;
            }
        };
        let targets = match pick_codex_page_targets(&targets, port) {
            Ok(targets) => targets,
            Err(error) => {
                errors.push(format!("port {port}: {error}"));
                continue;
            }
        };
        for target in targets {
            let Some(websocket_url) = target.web_socket_debugger_url.as_deref() else {
                continue;
            };
            match evaluate_cdp_expression(websocket_url, expression).await {
                Ok(evaluation) => return codex_runtime_timezone_from_evaluation(&evaluation),
                Err(error) => errors.push(format!("port {port}: {error}")),
            }
        }
    }
    if detect_running_codex_main_process().is_some() {
        Err("Codex is running without an injectable CDP port; fully quit it and relaunch it from CCSwitchMulti before verifying the runtime timezone".to_string())
    } else if errors.is_empty() {
        Err("Codex Desktop is not running".to_string())
    } else {
        Err("Codex Desktop is not running on a CCSwitchMulti-managed debug port".to_string())
    }
}

/// 轻量 CDP websocket 会话，只处理 request/response。
struct CdpSession<S> {
    socket: S,
    responses: HashMap<u64, Value>,
}

impl<S> CdpSession<S>
where
    S: SinkExt<Message>
        + StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + Unpin,
    <S as futures::Sink<Message>>::Error: std::fmt::Display,
{
    fn new(socket: S) -> Self {
        Self {
            socket,
            responses: HashMap::new(),
        }
    }

    /// 发送 CDP 命令并等待对应 id 的响应。
    async fn send_command(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        self.socket
            .send(Message::Text(
                json!({ "id": id, "method": method, "params": params })
                    .to_string()
                    .into(),
            ))
            .await
            .map_err(|error| format!("failed to send CDP command {method}: {error}"))?;
        tokio::time::timeout(CDP_COMMAND_TIMEOUT, self.wait_for_id(id, method))
            .await
            .map_err(|_| format!("timed out waiting for CDP command {method}"))?
    }

    /// 跳过无关 CDP 事件，直到拿到当前命令响应。
    async fn wait_for_id(&mut self, id: u64, method: &str) -> Result<Value, String> {
        loop {
            if let Some(response) = self.responses.remove(&id) {
                return cdp_command_result(response, method);
            }
            let Some(message) = self.socket.next().await else {
                return Err(format!("CDP websocket closed before {method} response"));
            };
            let message =
                message.map_err(|error| format!("failed to read CDP message: {error}"))?;
            let Message::Text(text) = message else {
                continue;
            };
            let value: Value = serde_json::from_str(&text)
                .map_err(|error| format!("failed to parse CDP message: {error}"))?;
            if let Some(response_id) = value.get("id").and_then(Value::as_u64) {
                if response_id == id {
                    return cdp_command_result(value, method);
                }
                self.responses.insert(response_id, value);
            }
        }
    }
}

/// 将 CDP error 响应转成普通错误。
fn cdp_command_result(response: Value, method: &str) -> Result<Value, String> {
    if let Some(error) = response.get("error") {
        Err(format!("CDP command {method} failed: {error}"))
    } else {
        Ok(response)
    }
}

/// 模型目录 patch 的可执行 JavaScript 核心。
///
/// 这段逻辑会同时嵌入 Codex renderer，并由 QuickJS 回归直接执行。任何字段写入都必须
/// 先通过明确的模型门特征；不能把 React Fiber、Intl context 或普通 API 对象当成模型
/// 容器遍历和改写。
fn model_picker_patch_core_script() -> &'static str {
    include_str!("resources/codex_desktop/model_picker_core.js")
}

/// The V5 renderer patch accidentally added model-whitelist fields to every
/// Statsig dynamic config instead of only the model catalog config. When those
/// fields reached Guardian V2, the bundled app-server rejected the request as
/// an invalid `FeatureToml` even though the on-disk `config.toml` was valid.
/// Keep the repair and exact-error fallback independent from model/history code
/// so the compatibility boundary can be executed directly in QuickJS tests.
fn guardian_v2_compatibility_patch_core_script() -> &'static str {
    include_str!("resources/codex_desktop/guardian_v2_compatibility.js")
}

/// App-server 请求兼容核心，同时嵌入 renderer 并由 QuickJS 行为测试直接执行。
///
/// `thread/list` 继续显式查询所有 Provider；`thread/resume` 则以当前 live Provider
/// 覆盖历史线程保存的旧入口标签，使跨 Provider 历史在冷恢复后重新经过 CCSM Router。
fn app_server_request_normalization_core_script() -> &'static str {
    include_str!("resources/codex_desktop/app_server_request_normalization.js")
}

/// Codex Desktop refreshes thread metadata independently from the loaded transcript. After
/// `thread/revert`, the stable thread ID remains unchanged while `thread.path` moves to a new
/// rollout. An already loaded conversation can therefore retain the old rollout path and turns.
/// Rehydrate only idle conversations whose cached path is demonstrably stale; active turns are
/// deferred so the compatibility layer never interrupts live work.
fn history_lineage_hydration_core_script() -> &'static str {
    include_str!("resources/codex_desktop/history_lineage_hydration.js")
}

/// Locate real request clients from legacy signals or the current app-shared
/// scoped registry. Declared descriptors exclude RPC proxies, and retained app
/// scopes let each heartbeat observe a replaced client without scanning React.
fn app_server_module_client_discovery_core_script() -> &'static str {
    include_str!("resources/codex_desktop/client_discovery.js")
}

fn request_health_warning_core_script(suppressed: bool) -> String {
    let suppressed = if suppressed { "true" } else { "false" };
    include_str!("resources/codex_desktop/request_health_warning.js")
        .replace("__CCSWITCH_REQUEST_HEALTH_SUPPRESSED__", suppressed)
}

pub(crate) fn manual_summary_request_prompt() -> String {
    [
        MANUAL_SUMMARY_REQUEST_MARKER,
        MANUAL_SUMMARY_REQUEST_INSTRUCTION,
        "Create a faithful handoff summary of this coding session for a fresh session.",
        "Do not call tools, inspect files, change files, or continue implementation; summarize only the conversation already present.",
        "Return plain text with these headings on separate lines: Goal; Decisions and rationale; Changed files or areas; Current state; Failures and unresolved issues; Tests and verification; Not tested; Exact next action.",
        "Never claim a test ran unless the conversation records its result, and preserve recorded failures and user constraints.",
    ]
    .join(" ")
}

///
/// The fresh refork discovers app-server clients from the same patched client
/// registry used by routing compatibility. This core only owns the handoff
/// workflow and never touches rollout files or the proxy request history.
fn summary_handoff_core_script() -> String {
    let prompt = serde_json::to_string(&manual_summary_request_prompt())
        .expect("serialize manual summary request prompt");
    include_str!("resources/codex_desktop/summary_handoff.js")
        .replace("__CCSWITCH_MANUAL_SUMMARY_PROMPT__", &prompt)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexSummarizeRestartResult {
    pub new_thread_id: String,
    pub handoff_turn_id: String,
    pub debug_port: u16,
    pub target_id: String,
}

/// Coordinate the renderer-owned summary and fresh-root handoff without
/// duplicating app-server or rollout persistence logic in Rust.
pub(crate) async fn summarize_and_restart_codex_session(
    thread_id: &str,
) -> Result<CodexSummarizeRestartResult, String> {
    if thread_id.trim().is_empty() {
        return Err("A Codex thread id is required".to_string());
    }
    let thread_id_json =
        serde_json::to_string(thread_id).map_err(|error| format!("Invalid thread id: {error}"))?;
    let start_script = format!(
        r#"(() => {{
          const state = window[{patch_key:?}];
          if (!state || typeof state.startSummarizeSession !== 'function') return {{started:false, reason:'Codex compatibility layer is not ready'}};
          try {{ return state.startSummarizeSession({thread_id_json}); }} catch (error) {{ return {{started:false, reason:String(error?.message || error)}}; }}
        }})()"#,
        patch_key = MODEL_PICKER_PATCH_KEY,
    );
    let mut diagnostics = Vec::new();
    for port in candidate_debug_ports(DEFAULT_CODEX_DEBUG_PORT) {
        let targets = match list_cdp_targets(port).await {
            Ok(targets) => targets,
            Err(error) => {
                diagnostics.push(format!("port {port}: {error}"));
                continue;
            }
        };
        let targets = match pick_codex_page_targets(&targets, port) {
            Ok(targets) => targets,
            Err(error) => {
                diagnostics.push(format!("port {port}: {error}"));
                continue;
            }
        };
        for target in targets {
            let Some(websocket_url) = target.web_socket_debugger_url.as_deref() else {
                continue;
            };
            let started = match evaluate_cdp_expression(websocket_url, &start_script).await {
                Ok(value) => value
                    .pointer("/result/result/value")
                    .cloned()
                    .unwrap_or(Value::Null),
                Err(error) => {
                    diagnostics.push(format!("target {}: {error}", target.id));
                    continue;
                }
            };
            let job_id = started
                .get("jobId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if !started
                .get("started")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || job_id.is_empty()
            {
                diagnostics.push(format!(
                    "target {}: {}",
                    target.id,
                    started
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("Codex Desktop did not start manual summarization")
                ));
                continue;
            }
            let job_id_json = serde_json::to_string(&job_id)
                .map_err(|error| format!("Invalid summary job id: {error}"))?;
            let poll_script = format!(
                r#"(() => {{
                  const state = window[{patch_key:?}];
                  return state && typeof state.readSummarizeJob === 'function' ? state.readSummarizeJob({job_id_json}) : null;
                }})()"#,
                patch_key = MODEL_PICKER_PATCH_KEY,
            );
            let deadline = tokio::time::Instant::now() + Duration::from_secs(130);
            let summary = loop {
                if tokio::time::Instant::now() >= deadline {
                    return Err(format!(
                        "target {}: timed out waiting for Codex summary",
                        target.id
                    ));
                }
                tokio::time::sleep(Duration::from_millis(750)).await;
                let value = evaluate_cdp_expression(websocket_url, &poll_script).await?;
                let value = value
                    .pointer("/result/result/value")
                    .cloned()
                    .unwrap_or(Value::Null);
                match value.get("status").and_then(Value::as_str) {
                    Some("completed") => {
                        break value
                            .get("summary")
                            .and_then(Value::as_str)
                            .filter(|s| !s.trim().is_empty())
                            .unwrap_or_default()
                            .to_string();
                    }
                    Some("failed") => {
                        return Err(value
                            .get("reason")
                            .and_then(Value::as_str)
                            .unwrap_or("Codex Desktop summary failed")
                            .to_string())
                    }
                    _ => {}
                }
            };
            if summary.is_empty() {
                return Err(format!(
                    "target {}: summary completed without text",
                    target.id
                ));
            }
            let summary_json = serde_json::to_string(&summary)
                .map_err(|error| format!("Invalid handoff summary: {error}"))?;
            let fresh_script = format!(
                r#"(() => {{
                  const state = window[{patch_key:?}];
                  if (!state || typeof state.startFreshSessionFromSummary !== 'function') return {{started:false, reason:'Fresh-session bridge is not ready'}};
                  try {{ return state.startFreshSessionFromSummary({thread_id_json}, {summary_json}); }} catch (error) {{ return {{started:false, reason:String(error?.message || error)}}; }}
                }})()"#,
                patch_key = MODEL_PICKER_PATCH_KEY,
            );
            let fresh = evaluate_cdp_expression(websocket_url, &fresh_script).await?;
            let fresh = fresh
                .pointer("/result/result/value")
                .cloned()
                .unwrap_or(Value::Null);
            let fresh_job_id = fresh
                .get("jobId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !fresh
                .get("started")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || fresh_job_id.is_empty()
            {
                return Err(fresh
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex did not start the fresh-session handoff")
                    .to_string());
            }
            let fresh_job_json = serde_json::to_string(fresh_job_id)
                .map_err(|error| format!("Invalid fresh-session job id: {error}"))?;
            let fresh_poll_script = format!(
                r#"(() => {{
                  const state = window[{patch_key:?}];
                  return state && typeof state.readFreshSessionJob === 'function' ? state.readFreshSessionJob({fresh_job_json}) : null;
                }})()"#,
                patch_key = MODEL_PICKER_PATCH_KEY,
            );
            let deadline = tokio::time::Instant::now() + Duration::from_secs(130);
            loop {
                if tokio::time::Instant::now() >= deadline {
                    return Err(format!(
                        "target {}: timed out waiting for fresh-session handoff",
                        target.id
                    ));
                }
                tokio::time::sleep(Duration::from_millis(750)).await;
                let value = evaluate_cdp_expression(websocket_url, &fresh_poll_script).await?;
                let value = value
                    .pointer("/result/result/value")
                    .cloned()
                    .unwrap_or(Value::Null);
                match value.get("status").and_then(Value::as_str) {
                    Some("completed") => {
                        let new_thread_id = value
                            .get("newThreadId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let handoff_turn_id = value
                            .get("turnId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        if new_thread_id.is_empty() || handoff_turn_id.is_empty() {
                            return Err(
                                "Fresh-session handoff completed without thread and turn ids"
                                    .to_string(),
                            );
                        }
                        return Ok(CodexSummarizeRestartResult {
                            new_thread_id,
                            handoff_turn_id,
                            debug_port: port,
                            target_id: target.id,
                        });
                    }
                    Some("failed") => {
                        return Err(value
                            .get("reason")
                            .and_then(Value::as_str)
                            .unwrap_or("Fresh-session handoff failed")
                            .to_string())
                    }
                    _ => {}
                }
            }
        }
    }
    Err(if diagnostics.is_empty() {
        "No Codex Desktop CDP target was found".to_string()
    } else {
        diagnostics.join("; ")
    })
}

#[derive(Debug, Clone)]
pub(crate) struct CodexContinuationResult {
    pub submitted: bool,
    pub mutation_attempted: bool,
    pub debug_port: Option<u16>,
    pub target_id: Option<String>,
    pub message: String,
}

fn codex_continuation_core_script() -> &'static str {
    static SCRIPT: OnceLock<String> = OnceLock::new();
    SCRIPT
        .get_or_init(|| {
            include_str!("resources/codex_desktop/continuation.js").replace(
                "__CCSWITCH_TERMINAL_ERROR_POLICY__",
                crate::proxy::providers::codex_terminal::TERMINAL_ERROR_POLICY_JSON,
            )
        })
        .as_str()
}

fn codex_continuation_bridge_script(method: &str, arguments: &str) -> String {
    let runtime_fingerprint = codex_renderer_runtime_fingerprint();
    format!(
        r#"(() => {{
          const state = window[{patch_key:?}];
          const operation = state && Object.getOwnPropertyDescriptor(state, {method:?})?.value;
          if (!state || state.rendererRuntimeFingerprint !== {runtime_fingerprint:?} || typeof operation !== 'function')
            return {{started:false, status:'unavailable', reason:'Codex compatibility layer is not ready'}};
          return operation.call(state, {arguments});
        }})()"#,
        patch_key = MODEL_PICKER_PATCH_KEY,
    )
}

/// Submit a literal `continue` to the exact failed Codex thread through the
/// renderer-owned app-server client. Recovery never changes a visible draft or
/// uses the currently selected model/provider. A renderer job and a persisted
/// failed-turn marker prevent retries after an ambiguous mutation response.
pub(crate) async fn submit_codex_continuation(
    thread_id: &str,
    recovery_id: &str,
    expected_model: &str,
    observed_at_ms: i64,
    authorize: impl Fn(bool) -> bool + Send + Sync,
) -> Result<CodexContinuationResult, String> {
    if thread_id.trim().is_empty() || recovery_id.trim().is_empty() {
        return Err("An exact Codex thread and recovery id are required".to_string());
    }
    if observed_at_ms <= 0 {
        return Err("The interrupted turn observation time is required".to_string());
    }
    let thread_id_json =
        serde_json::to_string(thread_id.trim()).map_err(|error| error.to_string())?;
    let recovery_id_json =
        serde_json::to_string(recovery_id.trim()).map_err(|error| error.to_string())?;
    let expected_model_json =
        serde_json::to_string(expected_model.trim()).map_err(|error| error.to_string())?;
    let start_script = codex_continuation_bridge_script(
        "startCodexContinuation",
        &format!("{thread_id_json}, {recovery_id_json}, {expected_model_json}, {observed_at_ms}"),
    );
    let mut diagnostics = Vec::new();
    for port in candidate_debug_ports(DEFAULT_CODEX_DEBUG_PORT) {
        let targets = match list_cdp_targets(port).await {
            Ok(value) => value,
            Err(error) => {
                diagnostics.push(format!("port {port}: failed to list CDP targets: {error}"));
                continue;
            }
        };
        let targets = match pick_codex_page_targets(&targets, port) {
            Ok(value) => value,
            Err(error) => {
                diagnostics.push(format!("port {port}: {error}"));
                continue;
            }
        };
        if let Some(result) = submit_codex_continuation_to_targets(
            targets,
            port,
            &start_script,
            &recovery_id_json,
            &authorize,
            &mut diagnostics,
        )
        .await?
        {
            return Ok(result);
        }
    }
    Err(if diagnostics.is_empty() {
        "No Codex Desktop CDP target was found".to_string()
    } else {
        diagnostics.join("; ")
    })
}

async fn abandon_codex_continuation_preparation(
    target: &CdpTarget,
    port: u16,
    cancel_script: &str,
    diagnostic: String,
    diagnostics: &mut Vec<String>,
) -> Option<CodexContinuationResult> {
    diagnostics.push(diagnostic);
    let websocket_url = target.web_socket_debugger_url.as_deref()?;
    // Preparation never sends turn/start. Retire its exact job if reachable,
    // but do not let an unreachable target consume the next target's budget.
    let evaluation = tokio::time::timeout(
        Duration::from_secs(1),
        evaluate_cdp_expression(websocket_url, cancel_script),
    )
    .await
    .ok()?
    .ok()?;
    let value = evaluation.pointer("/result/result/value")?;
    if value.get("cancelled").and_then(Value::as_bool) == Some(false)
        || value.get("mutationAttempted").and_then(Value::as_bool) == Some(true)
        || value.get("submitted").and_then(Value::as_bool) == Some(true)
    {
        return Some(CodexContinuationResult {
            submitted: value.get("submitted").and_then(Value::as_bool) == Some(true),
            mutation_attempted: true,
            debug_port: Some(port),
            target_id: Some(target.id.clone()),
            message: "A continuation was already attempted; its result is uncertain".to_string(),
        });
    }
    None
}

async fn submit_codex_continuation_to_targets(
    targets: Vec<CdpTarget>,
    port: u16,
    start_script: &str,
    recovery_id_json: &str,
    authorize: &(impl Fn(bool) -> bool + Sync),
    diagnostics: &mut Vec<String>,
) -> Result<Option<CodexContinuationResult>, String> {
    let poll_script =
        codex_continuation_bridge_script("readCodexContinuationJob", recovery_id_json);
    let commit_script =
        codex_continuation_bridge_script("commitCodexContinuation", recovery_id_json);
    let cancel_script =
        codex_continuation_bridge_script("cancelCodexContinuation", recovery_id_json);
    'targets: for target in targets {
        let Some(websocket_url) = target.web_socket_debugger_url.as_deref() else {
            continue;
        };
        let diagnostic = 'preparation: {
            // Only these read-only operations can abandon this renderer.
            let evaluation = match evaluate_cdp_expression(websocket_url, start_script).await {
                Ok(value) => value,
                Err(error) => break 'preparation format!("target {}: {error}", target.id),
            };
            if let Some(exception) = evaluation.pointer("/result/exceptionDetails") {
                break 'preparation format!(
                    "target {}: CDP evaluation failed: {exception}",
                    target.id
                );
            }
            let started = evaluation
                .pointer("/result/result/value")
                .cloned()
                .unwrap_or(Value::Null);
            if started.get("started").and_then(Value::as_bool) != Some(true) {
                // The guarded start did not invoke preparation.
                diagnostics.push(format!(
                    "target {}: {}",
                    target.id,
                    started
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("Continuation was not started")
                ));
                continue 'targets;
            }
            let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
            let mut commit_requested = false;
            loop {
                let evaluation = match evaluate_cdp_expression(websocket_url, &poll_script).await {
                    Ok(value) => value,
                    Err(error) => {
                        let diagnostic = format!("target {}: {error}", target.id);
                        if commit_requested {
                            return Err(diagnostic);
                        }
                        break 'preparation diagnostic;
                    }
                };
                if let Some(exception) = evaluation.pointer("/result/exceptionDetails") {
                    let diagnostic =
                        format!("target {}: CDP evaluation failed: {exception}", target.id);
                    if commit_requested {
                        return Err(diagnostic);
                    }
                    break 'preparation diagnostic;
                }
                let value = evaluation
                    .pointer("/result/result/value")
                    .cloned()
                    .unwrap_or(Value::Null);
                let status = value.get("status").and_then(Value::as_str);
                let submitted = value.get("submitted").and_then(Value::as_bool) == Some(true);
                let attempted =
                    value.get("mutationAttempted").and_then(Value::as_bool) == Some(true);
                // start can reattach to a previous job. Its mutation evidence
                // takes precedence over this invocation's local commit flag.
                if submitted
                    || (!commit_requested && (attempted || status == Some("submitting")))
                    || (status == Some("completed") && attempted)
                {
                    return Ok(Some(CodexContinuationResult {
                        submitted,
                        mutation_attempted: true,
                        debug_port: Some(port),
                        target_id: Some(target.id),
                        message: value
                            .get("reason")
                            .and_then(Value::as_str)
                            .unwrap_or(
                                "A continuation was already attempted; its result is uncertain",
                            )
                            .to_string(),
                    }));
                }
                match status {
                    Some("completed") => {
                        if commit_requested
                            && (value.get("submitted").and_then(Value::as_bool) != Some(false)
                                || value.get("mutationAttempted").and_then(Value::as_bool)
                                    != Some(false))
                        {
                            return Err(format!("target {}: CDP continuation commit failed: completion acknowledgement is incomplete; result is uncertain", target.id));
                        }
                        let reason = value
                            .get("reason")
                            .and_then(Value::as_str)
                            .unwrap_or("Codex did not confirm the targeted continuation");
                        if !commit_requested
                            && value.get("submitted").and_then(Value::as_bool) == Some(false)
                            && value.get("mutationAttempted").and_then(Value::as_bool)
                                == Some(false)
                            && reason.starts_with("Codex Desktop request client was not found")
                        {
                            break 'preparation format!("target {}: {reason}", target.id);
                        }
                        // Semantic stops are authoritative, including user
                        // actions, terminal errors and changed thread bindings.
                        return Ok(Some(CodexContinuationResult {
                            submitted: false,
                            mutation_attempted: false,
                            debug_port: Some(port),
                            target_id: Some(target.id),
                            message: reason.to_string(),
                        }));
                    }
                    Some("prepared") if !commit_requested => {
                        // Set before either authorization or dispatch: losing
                        // any later response must preserve mutation uncertainty.
                        commit_requested = true;
                        let committed = evaluate_cdp_expression_if_authorized(
                            websocket_url,
                            &commit_script,
                            authorize,
                        )
                        .await?;
                        let Some(committed) = committed else {
                            if let Some(result) = abandon_codex_continuation_preparation(
                                &target,
                                port,
                                &cancel_script,
                                format!(
                                    "target {}: Continuation authorization was revoked",
                                    target.id
                                ),
                                diagnostics,
                            )
                            .await
                            {
                                return Ok(Some(result));
                            }
                            return Ok(Some(CodexContinuationResult {
                                submitted: false,
                                mutation_attempted: false,
                                debug_port: Some(port),
                                target_id: Some(target.id),
                                message: "Continuation authorization was revoked".to_string(),
                            }));
                        };
                        if let Some(exception) = committed.pointer("/result/exceptionDetails") {
                            return Err(format!(
                                "target {}: CDP continuation commit failed: {exception}",
                                target.id
                            ));
                        }
                        let started = committed
                            .pointer("/result/result/value/started")
                            .and_then(Value::as_bool);
                        if started.is_none() {
                            return Err(format!("target {}: CDP continuation commit failed: acknowledgement is incomplete; result is uncertain", target.id));
                        }
                        if started == Some(false) {
                            return Ok(Some(CodexContinuationResult {
                                submitted: false,
                                mutation_attempted: false,
                                debug_port: Some(port),
                                target_id: Some(target.id),
                                message: committed
                                    .pointer("/result/result/value/reason")
                                    .and_then(Value::as_str)
                                    .unwrap_or("Codex continuation commit was not started")
                                    .to_string(),
                            }));
                        }
                    }
                    Some("pending") | Some("submitting") if commit_requested => {}
                    Some("pending") => {}
                    Some("unavailable") if commit_requested => {
                        return Err(format!("target {}: Codex compatibility runtime was replaced after continuation commit; result is uncertain", target.id));
                    }
                    _ => {
                        let diagnostic = format!("target {}: Codex compatibility layer is not ready: continuation preparation job was not found", target.id);
                        if commit_requested {
                            return Err(diagnostic);
                        }
                        break 'preparation diagnostic;
                    }
                }
                if tokio::time::Instant::now() >= deadline {
                    let diagnostic = format!("target {}: continuation is still pending; no second submission was attempted", target.id);
                    if commit_requested {
                        return Err(diagnostic);
                    }
                    break 'preparation diagnostic;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        };
        if let Some(result) = abandon_codex_continuation_preparation(
            &target,
            port,
            &cancel_script,
            diagnostic,
            diagnostics,
        )
        .await
        {
            return Ok(Some(result));
        }
    }
    Ok(None)
}

/// 构造 renderer 注入脚本：触发新版本地历史目录同步，并修复模型白名单和缓存。
#[cfg(test)]
fn build_model_picker_unlock_script(catalog: &CodexModelCatalogProjection) -> String {
    build_model_picker_unlock_script_with_state(catalog, false)
}

/// Assemble the exact renderer program that is injected through CDP.
///
/// The same assembly path is used for the runtime fingerprint and for the
/// live payload. Keeping these paths together means slot wiring and fragment
/// ordering changes invalidate the installed renderer automatically; they do
/// not require another hand-maintained scheduler number.
fn assemble_codex_renderer_runtime_script(
    catalog_payload: &str,
    catalog_released: bool,
    request_health_warning_suppressed: bool,
    runtime_fingerprint: &str,
) -> String {
    let catalog_payload_selection_core = catalog_payload_selection_core_script();
    let app_server_model_list_scope_core = app_server_model_list_scope_core_script();
    let model_patch_core = model_picker_patch_core_script();
    let query_cache_lifecycle_core =
        include_str!("resources/codex_desktop/model_picker_cache_lifecycle.js");
    let model_picker_release_core = include_str!("resources/codex_desktop/model_picker_release.js");
    let model_picker_diagnostics_core =
        include_str!("resources/codex_desktop/model_picker_diagnostics.js");
    let guardian_v2_patch_core = guardian_v2_compatibility_patch_core_script();
    let request_normalization_core = app_server_request_normalization_core_script();
    let history_lineage_hydration_core = history_lineage_hydration_core_script();
    let module_client_discovery_core = app_server_module_client_discovery_core_script();
    let request_health_warning_core =
        request_health_warning_core_script(request_health_warning_suppressed);
    let summary_handoff_core = summary_handoff_core_script();
    let codex_continuation_core = codex_continuation_core_script();

    // Resolve executable fragments before inserting opaque provider metadata.
    include_str!("resources/codex_desktop/renderer_runtime.js")
        .replace(
            "/*__CCSWITCH_CATALOG_PAYLOAD_SELECTION_CORE__*/",
            catalog_payload_selection_core,
        )
        .replace(
            "/*__CCSWITCH_MODEL_PICKER_RELEASE_CORE__*/",
            model_picker_release_core,
        )
        .replace(
            "/*__CCSWITCH_QUERY_CACHE_LIFECYCLE_CORE__*/",
            query_cache_lifecycle_core,
        )
        .replace("/*__CCSWITCH_MODEL_PATCH_CORE__*/", model_patch_core)
        .replace(
            "/*__CCSWITCH_GUARDIAN_V2_PATCH_CORE__*/",
            guardian_v2_patch_core,
        )
        .replace(
            "/*__CCSWITCH_REQUEST_NORMALIZATION_CORE__*/",
            request_normalization_core,
        )
        .replace(
            "/*__CCSWITCH_HISTORY_LINEAGE_HYDRATION_CORE__*/",
            history_lineage_hydration_core,
        )
        .replace(
            "/*__CCSWITCH_MODULE_CLIENT_DISCOVERY_CORE__*/",
            module_client_discovery_core,
        )
        .replace(
            "/*__CCSWITCH_MODEL_PICKER_DIAGNOSTICS_CORE__*/",
            model_picker_diagnostics_core,
        )
        .replace(
            "/*__CCSWITCH_REQUEST_HEALTH_WARNING_CORE__*/",
            &request_health_warning_core,
        )
        .replace(
            "/*__CCSWITCH_SUMMARY_HANDOFF_CORE__*/",
            &summary_handoff_core,
        )
        .replace(
            "/*__CCSWITCH_CODEX_CONTINUATION_CORE__*/",
            codex_continuation_core,
        )
        .replace(
            "/*__CCSWITCH_APP_SERVER_MODEL_LIST_SCOPE_CORE__*/",
            app_server_model_list_scope_core,
        )
        .replace(
            "__CCSWITCH_CATALOG_RELEASED__",
            if catalog_released { "true" } else { "false" },
        )
        .replace(
            "__CCSWITCH_PATCH_KEY__",
            &serde_json::to_string(MODEL_PICKER_PATCH_KEY).expect("serialize renderer patch key"),
        )
        .replace(
            "__CCSWITCH_RENDERER_RUNTIME_FINGERPRINT__",
            &serde_json::to_string(runtime_fingerprint)
                .expect("serialize renderer runtime fingerprint"),
        )
        .replace("__CCSWITCH_CATALOG_PAYLOAD__", catalog_payload)
}

fn codex_renderer_runtime_template_for_fingerprint() -> String {
    // Keep a valid, deterministic payload in the template so the fingerprint
    // covers the final assembled program without including the live catalog.
    assemble_codex_renderer_runtime_script(
        r#"{"__ccswitch_catalog_slot__":true}"#,
        false,
        false,
        "__ccswitch_runtime_fingerprint_slot__",
    )
}

fn build_model_picker_unlock_script_with_state(
    catalog: &CodexModelCatalogProjection,
    catalog_released: bool,
) -> String {
    let payload = serde_json::to_string(catalog).unwrap_or_else(|_| "{}".to_string());
    let runtime_fingerprint = codex_renderer_runtime_fingerprint();
    let settings = crate::settings::get_settings();
    let request_health_warning_suppressed = CODEX_REQUEST_HEALTH_WARNINGS_SUPPRESSED
        .load(Ordering::Acquire)
        || !crate::settings::request_health_windows_notifications_active(&settings.request_health);
    assemble_codex_renderer_runtime_script(
        &payload,
        catalog_released,
        request_health_warning_suppressed,
        runtime_fingerprint,
    )
}

/// 启动 Codex Desktop，并传入 remote debugging 参数。
pub(crate) fn launch_codex_with_debug_port(
    executable: &Path,
    debug_port: u16,
) -> Result<(), String> {
    if let Some(running) = detect_running_codex_main_process() {
        return Err(format!(
            "Codex Desktop is already running at {}. Fully quit Codex, then launch it from CCSwitchMulti so the model picker patch can be installed.",
            running.display()
        ));
    }
    let launch_timezone =
        crate::codex_egress_timezone::resolve_launch_timezone(&crate::settings::get_settings());
    #[cfg(target_os = "macos")]
    {
        if launch_timezone.is_none() {
            if let Some(bundle) = macos_codex_bundle_for_executable(executable) {
                let mut command = Command::new("open");
                command.arg(bundle).arg("--args");
                append_codex_debug_args(&mut command, debug_port);
                return command
                    .spawn()
                    .map(|_| {
                        crate::codex_egress_timezone::mark_codex_timezone_applied();
                    })
                    .map_err(|error| {
                        format!("failed to launch {}: {error}", executable.display())
                    });
            }
        } else {
            log::warn!(
                "Codex egress timezone injection is not supported through macOS LaunchServices; launching the bundle executable directly"
            );
        }
    }
    let mut command = Command::new(executable);
    append_codex_debug_args(&mut command, debug_port);
    apply_codex_launch_timezone(&mut command, launch_timezone.as_deref());
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        if let Some(aumid) = windows_launch::resolve_app_id(executable)? {
            return windows_launch::activate(&aumid, Some(debug_port));
        }
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .spawn()
        .map(|_| {
            crate::codex_egress_timezone::mark_codex_timezone_applied();
        })
        .map_err(|error| format!("failed to launch {}: {error}", executable.display()))
}

fn apply_codex_launch_timezone(command: &mut Command, timezone: Option<&str>) {
    if let Some(timezone) = timezone {
        command.env("TZ", timezone);
    }
}

/// 为 Desktop 启动命令追加 Chromium remote-debugging 参数。
fn append_codex_debug_args(command: &mut Command, debug_port: u16) {
    command
        .arg(format!("--remote-debugging-port={debug_port}"))
        .arg(format!(
            "--remote-allow-origins=http://127.0.0.1:{debug_port}"
        ));
}

/// Windows 下查找 Codex App 主进程的脚本。
///
/// 新版 MSIX 将统一应用壳改名为 `ChatGPT.exe`，但只允许来自 `OpenAI.Codex`
/// 包目录的同名进程，避免误把独立 ChatGPT 应用接入 Codex 的 CDP 修复链路。
#[cfg(target_os = "windows")]
const DETECT_CODEX_MAIN_PROCESS_SCRIPT: &str = r#"
Get-CimInstance Win32_Process -Filter "Name = 'Codex.exe' OR Name = 'ChatGPT.exe'" |
  Where-Object {
    if (-not $_.ExecutablePath -or $_.CommandLine -match ' --type=') { return $false }
    $leaf = Split-Path -Leaf $_.ExecutablePath
    $legacyCodex = $leaf -ceq 'Codex.exe'
    $unifiedCodex = $leaf -ceq 'ChatGPT.exe' -and $_.ExecutablePath -match '\\WindowsApps\\OpenAI\.Codex(?:\.Preview)?_'
    return $legacyCodex -or $unifiedCodex
  } |
  Select-Object -First 1 -ExpandProperty ExecutablePath
"#;

/// 查找 Codex Desktop 主进程路径；已运行但未开放 CDP 时不能原地注入。
pub(crate) fn detect_running_codex_main_process() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let script = DETECT_CODEX_MAIN_PROCESS_SCRIPT;
        let output = crate::powershell::command()
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(PathBuf::from(text))
        }
    }

    #[cfg(target_os = "macos")]
    {
        detect_running_macos_codex_main_process()
    }

    #[cfg(target_os = "linux")]
    {
        detect_running_linux_codex_main_process()
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

/// List only verified Codex Desktop shells. CLI/app-server processes are
/// intentionally excluded because they can share the `Codex.exe` name.
#[cfg(target_os = "windows")]
pub(crate) fn list_running_codex_desktop_process_ids() -> Result<Vec<u32>, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let script = r#"
Get-CimInstance Win32_Process -Filter "Name = 'Codex.exe' OR Name = 'ChatGPT.exe'" |
  Where-Object {
    if (-not $_.ExecutablePath -or $_.CommandLine -match ' --type=') { return $false }
    $leaf = Split-Path -Leaf $_.ExecutablePath
    $legacyCodex = $leaf -ceq 'Codex.exe'
    $unifiedCodex = $leaf -ceq 'ChatGPT.exe' -and $_.ExecutablePath -match '\\WindowsApps\\OpenAI\.Codex(?:\.Preview)?_'
    return $legacyCodex -or $unifiedCodex
  } |
  Select-Object -ExpandProperty ProcessId
"#;
    let output = crate::powershell::command()
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("failed to inspect Codex Desktop processes: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn list_running_codex_desktop_process_ids() -> Result<Vec<u32>, String> {
    Ok(Vec::new())
}

/// Stop only the verified Desktop shells captured immediately before the
/// switch. The wait prevents a new shell from racing the old WebView2 exit.
#[cfg(target_os = "windows")]
pub(crate) fn terminate_running_codex_desktop_processes(
    expected_ids: &[u32],
) -> Result<u32, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let running = list_running_codex_desktop_process_ids()?;
    let verified = expected_ids
        .iter()
        .copied()
        .filter(|pid| running.contains(pid))
        .collect::<Vec<_>>();
    for pid in &verified {
        let output = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|error| format!("failed to stop Codex Desktop PID {pid}: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "failed to stop Codex Desktop PID {pid}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let remaining = list_running_codex_desktop_process_ids()?;
        if remaining.is_empty() {
            return Ok(verified.len() as u32);
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "Codex Desktop processes did not exit after taskkill: {remaining:?}"
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn terminate_running_codex_desktop_processes(
    _expected_ids: &[u32],
) -> Result<u32, String> {
    Ok(0)
}

/// Capture the executable before stopping it, since process discovery is no
/// longer available after termination.
pub(crate) fn stop_running_codex_desktop_for_managed_lifecycle() -> Result<u32, String> {
    if let Some(executable) = detect_running_codex_main_process() {
        remember_codex_desktop_executable(&executable)?;
    }
    let process_ids = list_running_codex_desktop_process_ids()?;
    terminate_running_codex_desktop_processes(&process_ids)
}

/// Relaunch the plain Desktop shell after takeover has been disabled.
pub(crate) fn relaunch_codex_desktop_after_takeover() -> Result<(), String> {
    let executable = resolve_codex_executable()
        .ok_or_else(|| "Codex Desktop executable was not found".to_string())?;
    if detect_running_codex_main_process().is_some() {
        return Err(
            "Codex Desktop started again before its routing transition completed".to_string(),
        );
    }
    let timezone =
        crate::codex_egress_timezone::resolve_launch_timezone(&crate::settings::get_settings());
    let mut command = Command::new(&executable);
    apply_codex_launch_timezone(&mut command, timezone.as_deref());
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        if let Some(aumid) = windows_launch::resolve_app_id(&executable)? {
            return windows_launch::activate(&aumid, None);
        }
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .spawn()
        .map(|_| {
            crate::codex_egress_timezone::mark_codex_timezone_applied();
        })
        .map_err(|error| format!("failed to relaunch {}: {error}", executable.display()))
}

#[cfg(target_os = "windows")]
pub(crate) fn resolve_windows_codex_aumid() -> Result<Option<String>, String> {
    let Some(executable) = resolve_codex_executable() else {
        return Ok(None);
    };
    windows_launch::resolve_app_id(&executable)
}

#[cfg(target_os = "windows")]
pub(crate) fn launch_windows_codex_aumid(aumid: &str, debug_port: u16) -> Result<(), String> {
    windows_launch::activate(aumid, Some(debug_port))
}

/// 按常见安装位置寻找 Codex Desktop 可执行文件。
pub(crate) fn resolve_codex_executable() -> Option<PathBuf> {
    detect_running_codex_main_process()
        .filter(|path| path.exists())
        .and_then(|path| remember_codex_desktop_executable(&path).ok().or(Some(path)))
        .or_else(read_remembered_codex_desktop_executable)
        .or_else(find_platform_codex_executable)
}

/// 按当前操作系统查找 Codex Desktop 主程序，避免把 CLI 路径混进 Desktop/CDP 解锁链路。
fn find_platform_codex_executable() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        find_latest_windows_codex_executable()
    }

    #[cfg(target_os = "macos")]
    {
        find_macos_codex_executable()
    }

    #[cfg(target_os = "linux")]
    {
        find_linux_codex_executable()
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

/// 存储最近确认过的 Codex App shell 路径，支持 Desktop 不在常见安装目录的场景。
fn remembered_codex_desktop_executable_path() -> PathBuf {
    crate::config::get_app_config_dir().join(REMEMBERED_CODEX_DESKTOP_EXECUTABLE_FILENAME)
}

/// 判断路径文件名是否是当前平台的 Desktop shell，而不是小写 CLI/app-server。
#[cfg(target_os = "windows")]
fn is_codex_desktop_executable_name(name: &str) -> bool {
    name == "Codex.exe" || name == "ChatGPT.exe"
}

/// Windows 下进一步约束统一 `ChatGPT.exe` 必须来自 `OpenAI.Codex` MSIX 包目录。
///
/// 旧版 `Codex.exe` 仍兼容独立安装目录；新版壳使用了通用文件名，若不校验祖先目录，
/// 会把用户安装的独立 ChatGPT 应用错误地当成 Codex App。
#[cfg(target_os = "windows")]
fn is_codex_desktop_executable_path(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if !is_codex_desktop_executable_name(name) {
        return false;
    }
    if name == "Codex.exe" {
        return true;
    }
    path.ancestors().any(|ancestor| {
        ancestor
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name.starts_with("OpenAI.Codex_") || name.starts_with("OpenAI.Codex.Preview_")
            })
    })
}

/// macOS 统一壳可能叫 Codex 或 ChatGPT；必须回到 bundle 元数据校验身份与实际主程序。
#[cfg(target_os = "macos")]
fn is_codex_desktop_executable_path(path: &Path) -> bool {
    macos_codex_bundle_for_executable(path).is_some()
}

/// Linux 等平台沿用文件名级别的 Desktop shell 校验。
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn is_codex_desktop_executable_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(is_codex_desktop_executable_name)
}

/// 判断路径文件名是否是当前平台的 Desktop shell，而不是小写 CLI/app-server。
#[cfg(target_os = "linux")]
fn is_codex_desktop_executable_name(name: &str) -> bool {
    name == "Codex" || (name.starts_with("Codex") && name.ends_with(".AppImage"))
}

/// 判断路径文件名是否是当前平台的 Desktop shell，而不是小写 CLI/app-server。
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn is_codex_desktop_executable_name(_name: &str) -> bool {
    false
}

/// 校验 Desktop 主程序路径，避免把小写 CLI/app-server `codex` 当成 Electron shell。
///
/// 这不是禁用 CLI 支持；CLI/app-server 修复走 `config.toml`、`model_catalog_json`
/// 和 `/v1/models`，而不是 Desktop renderer 的 CDP 注入入口。
fn canonical_codex_desktop_executable_path(path: &Path) -> Result<PathBuf, String> {
    if !path.exists() {
        return Err(format!(
            "Codex Desktop executable does not exist: {}",
            path.display()
        ));
    }
    if !is_codex_desktop_executable_path(path) {
        return Err(format!(
            "Detected file is not Codex Desktop's platform shell executable: {}",
            path.display()
        ));
    }
    path.canonicalize().map_err(|error| {
        format!(
            "Failed to resolve Codex Desktop executable {}: {error}",
            path.display()
        )
    })
}

/// 读取上次从运行中 Desktop 捕获到的已校验主程序路径。
fn read_remembered_codex_desktop_executable() -> Option<PathBuf> {
    read_remembered_codex_desktop_executable_from(&remembered_codex_desktop_executable_path())
}

/// 从指定状态文件读取记住的 Desktop 主程序路径，便于测试隔离。
fn read_remembered_codex_desktop_executable_from(state_path: &Path) -> Option<PathBuf> {
    let value = crate::config::read_json_file::<Value>(state_path).ok()?;
    let executable = value
        .get("codex_executable")
        .or_else(|| value.get("codexExecutable"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)?;
    canonical_codex_desktop_executable_path(&executable).ok()
}

/// 记住已运行的 Desktop shell 路径；失败只影响下一次自动启动，不影响本次诊断返回。
fn remember_codex_desktop_executable(path: &Path) -> Result<PathBuf, String> {
    let executable = canonical_codex_desktop_executable_path(path)?;
    remember_codex_desktop_executable_at(&remembered_codex_desktop_executable_path(), &executable)
}

/// 将已校验的 Desktop 主程序路径写入指定状态文件，便于测试隔离。
fn remember_codex_desktop_executable_at(
    state_path: &Path,
    executable: &Path,
) -> Result<PathBuf, String> {
    let executable = canonical_codex_desktop_executable_path(executable)?;
    crate::config::write_json_file(
        state_path,
        &json!({
            "codex_executable": executable.display().to_string(),
        }),
    )
    .map_err(|error| {
        format!(
            "Failed to remember Codex Desktop executable at {}: {error}",
            state_path.display()
        )
    })?;
    Ok(executable)
}

/// macOS 上通过稳定 bundle identifier 找到运行中的 Codex/ChatGPT 统一壳。
#[cfg(target_os = "macos")]
fn detect_running_macos_codex_main_process() -> Option<PathBuf> {
    let script = format!(
        r#"
tell application "System Events"
  set matches to application processes whose bundle identifier is "{}"
  if (count of matches) is 0 then return ""
  try
    return POSIX path of (application file of item 1 of matches)
  end try
end tell
"#,
        CODEX_DESKTOP_BUNDLE_IDENTIFIER
    );
    if let Some(bundle) = command_stdout_trimmed(Command::new("osascript").arg("-e").arg(script))
        .filter(|path| !path.is_empty())
    {
        if let Some(executable) = macos_codex_bundle_executable(Path::new(&bundle)) {
            if let Ok(executable) = canonical_codex_desktop_executable_path(&executable) {
                return Some(executable);
            }
        }
    }

    let mut saw_codex_process = false;
    for process_name in ["Codex", "ChatGPT"] {
        for pid in command_stdout_lines(Command::new("pgrep").args(["-x", process_name])) {
            saw_codex_process = true;
            let path = command_stdout_trimmed(Command::new("ps").args(["-p", &pid, "-o", "comm="]));
            let Some(path) = path.filter(|path| !path.is_empty()) else {
                continue;
            };
            if let Ok(executable) = canonical_codex_desktop_executable_path(Path::new(&path)) {
                return Some(executable);
            }
        }
    }
    if saw_codex_process {
        return find_macos_codex_executable();
    }
    None
}

/// Linux 上通过 `/proc/<pid>/exe` 找到运行中的大写 Desktop/AppImage 主进程。
#[cfg(target_os = "linux")]
fn detect_running_linux_codex_main_process() -> Option<PathBuf> {
    let entries = std::fs::read_dir("/proc").ok()?;
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(pid) = file_name
            .to_str()
            .filter(|pid| pid.as_bytes().iter().all(|byte| byte.is_ascii_digit()))
        else {
            continue;
        };
        let Ok(executable) = std::fs::read_link(Path::new("/proc").join(pid).join("exe")) else {
            continue;
        };
        if let Ok(executable) = canonical_codex_desktop_executable_path(&executable) {
            return Some(executable);
        }
    }
    None
}

/// 查找 macOS 常见 Codex.app 安装位置和 Spotlight 索引结果。
#[cfg(target_os = "macos")]
fn find_macos_codex_executable() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for bundle in macos_codex_common_bundle_candidates() {
        if let Some(executable) = macos_codex_bundle_executable(&bundle) {
            push_codex_desktop_executable_candidate(&mut candidates, Vec::new(), executable);
        }
    }
    for bundle in command_stdout_lines(Command::new("mdfind").arg(format!(
        "kMDItemCFBundleIdentifier == '{}' || kMDItemFSName == 'Codex.app'",
        CODEX_DESKTOP_BUNDLE_IDENTIFIER
    ))) {
        if let Some(executable) = macos_codex_bundle_executable(Path::new(&bundle)) {
            push_codex_desktop_executable_candidate(&mut candidates, Vec::new(), executable);
        }
    }

    candidates.pop().map(|(_, executable)| executable)
}

/// macOS 常见应用目录候选，覆盖系统级和用户级安装。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn macos_codex_common_bundle_candidates() -> Vec<PathBuf> {
    let mut bundles = vec![
        PathBuf::from("/Applications/Codex.app"),
        PathBuf::from("/Applications/ChatGPT.app"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let applications = PathBuf::from(home).join("Applications");
        bundles.push(applications.join("Codex.app"));
        bundles.push(applications.join("ChatGPT.app"));
    }
    bundles
}

/// 以 bundle 的稳定身份和声明的主程序名构造候选，拒绝路径穿越与独立 ChatGPT。
#[cfg(any(target_os = "macos", test))]
fn macos_codex_bundle_executable_from_metadata(
    bundle: &Path,
    bundle_identifier: &str,
    executable_name: &str,
) -> Option<PathBuf> {
    if bundle_identifier.trim() != CODEX_DESKTOP_BUNDLE_IDENTIFIER {
        return None;
    }
    let executable_name = executable_name.trim();
    let executable_path = Path::new(executable_name);
    if executable_name.is_empty()
        || executable_path.file_name().and_then(|name| name.to_str()) != Some(executable_name)
        || executable_path.components().count() != 1
    {
        return None;
    }
    Some(bundle.join("Contents").join("MacOS").join(executable_name))
}

/// 读取 macOS bundle 的 Info.plist 字段；使用系统绝对路径，避免 GUI PATH 差异。
#[cfg(target_os = "macos")]
fn macos_bundle_info_value(bundle: &Path, key: &str) -> Option<String> {
    let info_plist = bundle.join("Contents").join("Info.plist");
    command_stdout_trimmed(
        Command::new("/usr/bin/plutil")
            .arg("-extract")
            .arg(key)
            .arg("raw")
            .arg("-o")
            .arg("-")
            .arg(info_plist),
    )
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
}

/// 从 macOS `.app` 的真实元数据解析 Desktop 主二进制路径。
#[cfg(target_os = "macos")]
fn macos_codex_bundle_executable(bundle: &Path) -> Option<PathBuf> {
    let bundle_identifier = macos_bundle_info_value(bundle, "CFBundleIdentifier")?;
    let executable_name = macos_bundle_info_value(bundle, "CFBundleExecutable")?;
    macos_codex_bundle_executable_from_metadata(bundle, &bundle_identifier, &executable_name)
}

/// 找到受支持的顶层包装；Framework 内部 Service.app 不会提前截断搜索。
#[cfg(any(target_os = "macos", test))]
fn macos_codex_bundle_ancestor(executable: &Path) -> Option<PathBuf> {
    executable.ancestors().find_map(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .filter(|name| *name == "Codex.app" || *name == "ChatGPT.app")
            .map(|_| path.to_path_buf())
    })
}

/// 如果路径属于 bundle 元数据声明的主程序，返回对应 bundle，便于使用 `open` 启动。
#[cfg(target_os = "macos")]
fn macos_codex_bundle_for_executable(executable: &Path) -> Option<PathBuf> {
    let bundle = macos_codex_bundle_ancestor(executable)?;
    let declared_executable = macos_codex_bundle_executable(&bundle)?;
    (declared_executable == executable).then_some(bundle)
}

/// 查找 Linux 常见 Desktop/AppImage 安装位置，避免把小写 CLI `codex` 当成 Desktop。
#[cfg(target_os = "linux")]
fn find_linux_codex_executable() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for binary in ["Codex", "Codex.AppImage"] {
        for path in command_stdout_lines(Command::new("which").args(["-a", binary])) {
            push_codex_desktop_executable_candidate(
                &mut candidates,
                Vec::new(),
                PathBuf::from(path),
            );
        }
    }
    for path in linux_codex_common_executable_candidates() {
        push_codex_desktop_executable_candidate(&mut candidates, Vec::new(), path);
    }
    for path in linux_desktop_entry_executable_candidates() {
        push_codex_desktop_executable_candidate(&mut candidates, Vec::new(), path);
    }

    candidates.pop().map(|(_, executable)| executable)
}

/// Linux 常见安装目录候选，覆盖 PATH 之外的 AppImage 和 `/opt` 安装。
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn linux_codex_common_executable_candidates() -> Vec<PathBuf> {
    let mut paths = vec![
        PathBuf::from("/usr/local/bin/Codex"),
        PathBuf::from("/usr/bin/Codex"),
        PathBuf::from("/opt/Codex/Codex"),
        PathBuf::from("/opt/OpenAI/Codex/Codex"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        paths.extend([
            home.join(".local").join("bin").join("Codex"),
            home.join(".local").join("bin").join("Codex.AppImage"),
            home.join("Applications").join("Codex"),
            home.join("Applications").join("Codex.AppImage"),
        ]);
    }
    paths
}

/// 从 Linux `.desktop` 文件中提取绝对路径 Exec 候选。
#[cfg(target_os = "linux")]
fn linux_desktop_entry_executable_candidates() -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from("/usr/share/applications")];
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(
            PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("applications"),
        );
    }

    let mut candidates = Vec::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.to_ascii_lowercase().contains("codex"))
            {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(path) else {
                continue;
            };
            candidates.extend(
                linux_desktop_entry_exec_values(&text)
                    .into_iter()
                    .map(PathBuf::from),
            );
        }
    }
    candidates
}

/// 解析 `.desktop` 文件中的绝对路径 Exec 值，忽略 flatpak/snap 包装命令。
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn linux_desktop_entry_exec_values(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| line.strip_prefix("Exec="))
        .filter_map(|exec| exec.split_whitespace().next())
        .filter(|path| path.starts_with('/'))
        .map(ToOwned::to_owned)
        .collect()
}

/// 运行命令并返回非空输出行，供平台探测脚本复用。
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn command_stdout_lines(command: &mut Command) -> Vec<String> {
    command_stdout_trimmed(command)
        .map(|text| {
            text.lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// 运行命令并返回去空白后的标准输出，命令失败时按无结果处理。
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn command_stdout_trimmed(command: &mut Command) -> Option<String> {
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// 在 WindowsApps 中选择版本最新的 Codex Desktop。
#[cfg(target_os = "windows")]
fn find_latest_windows_codex_executable() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    collect_registry_codex_executable_candidates(&mut candidates);
    collect_path_codex_executable_candidates(&mut candidates);
    collect_windowsapps_codex_executable_candidates(&mut candidates);
    collect_appx_codex_executable_candidates(&mut candidates);
    collect_local_windows_codex_executable_candidates(&mut candidates);

    candidates.sort_by(|left, right| left.0.cmp(&right.0));
    candidates.pop().map(|(_, executable)| executable)
}

/// 从 Windows App Paths 注册表读取显式应用路径，覆盖独立安装器注册的 Desktop。
#[cfg(target_os = "windows")]
fn collect_registry_codex_executable_candidates(candidates: &mut Vec<(Vec<u32>, PathBuf)>) {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let root = RegKey::predef(hive);
        for subkey in [
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Codex.exe",
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\Codex.exe",
        ] {
            let Ok(key) = root.open_subkey(subkey) else {
                continue;
            };
            let Ok(path) = key.get_value::<String, _>("") else {
                continue;
            };
            push_codex_desktop_executable_candidate(candidates, Vec::new(), PathBuf::from(path));
        }
    }
}

/// 从 PATH 中查找大写 Desktop `Codex.exe`，兼容用户手动加入 PATH 的独立安装。
#[cfg(target_os = "windows")]
fn collect_path_codex_executable_candidates(candidates: &mut Vec<(Vec<u32>, PathBuf)>) {
    let script = r#"
Get-Command Codex.exe -All -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -ceq 'Codex.exe' -and $_.Source } |
  Select-Object -ExpandProperty Source |
  ConvertTo-Json -Compress
"#;
    for path in powershell_json_string_list(script) {
        push_codex_desktop_executable_candidate(candidates, Vec::new(), PathBuf::from(path));
    }
}

/// 扫描 WindowsApps 包目录，收集可启动 Codex App renderer 的 shell 候选。
#[cfg(target_os = "windows")]
fn collect_windowsapps_codex_executable_candidates(candidates: &mut Vec<(Vec<u32>, PathBuf)>) {
    let mut roots = Vec::new();
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        roots.push(PathBuf::from(program_files).join("WindowsApps"));
    }
    if let Some(program_files) = std::env::var_os("ProgramW6432") {
        roots.push(PathBuf::from(program_files).join("WindowsApps"));
    }
    roots.push(PathBuf::from(r"C:\Program Files\WindowsApps"));
    roots.sort();
    roots.dedup();

    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !name.contains("Codex") {
                continue;
            }
            for executable in windows_codex_package_executable_candidates(&path) {
                if push_codex_desktop_executable_candidate(
                    candidates,
                    version_tuple_from_package_name(name),
                    executable,
                ) {
                    break;
                }
            }
        }
    }
}

/// `Get-AppxPackage` 返回的 Codex Windows App 安装摘要。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct WindowsCodexAppxPackage {
    package_full_name: Option<String>,
    version: Option<String>,
    install_location: Option<String>,
}

/// 通过 MSIX 安装元数据寻找 Codex Desktop，覆盖 WindowsApps 目录不可枚举的场景。
#[cfg(target_os = "windows")]
fn collect_appx_codex_executable_candidates(candidates: &mut Vec<(Vec<u32>, PathBuf)>) {
    let script = r#"
$packages = @()
$packages += Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue
$packages += Get-AppxPackage -Name *Codex* -ErrorAction SilentlyContinue
try { $packages += Get-AppxPackage -AllUsers -Name *Codex* -ErrorAction SilentlyContinue } catch {}
$packages |
  Where-Object { $_.InstallLocation -and ($_.Name -like '*Codex*' -or $_.PackageFullName -like '*Codex*' -or $_.PackageFamilyName -like '*Codex*') } |
  Sort-Object PackageFullName -Unique |
  Select-Object Name,PackageFullName,PackageFamilyName,Version,InstallLocation |
  ConvertTo-Json -Compress
"#;
    let Some(value) = powershell_json_value(script) else {
        return;
    };
    let packages = if value.is_array() {
        serde_json::from_value::<Vec<WindowsCodexAppxPackage>>(value)
    } else {
        serde_json::from_value::<WindowsCodexAppxPackage>(value).map(|package| vec![package])
    };
    let Ok(packages) = packages else {
        return;
    };
    for package in packages {
        let Some(root) = package
            .install_location
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
        else {
            continue;
        };
        let sort_key = package
            .version
            .as_deref()
            .map(version_tuple_from_text)
            .or_else(|| {
                package
                    .package_full_name
                    .as_deref()
                    .map(version_tuple_from_package_name)
                    .filter(|version| !version.is_empty())
            })
            .unwrap_or_default();
        for executable in windows_codex_package_executable_candidates(&root) {
            if push_codex_desktop_executable_candidate(candidates, sort_key.clone(), executable) {
                break;
            }
        }
    }
}

/// WindowsApps 包内的 Codex Desktop 可执行文件候选路径。
///
/// MSIX 包布局随版本变化过：新版统一应用壳是 `app/ChatGPT.exe`，旧版则可能在
/// `app/Codex.exe` 或 `app/resources/Codex.exe`。小写 `codex.exe` 仍是 CLI/app-server，
/// 不参与 renderer/CDP 修复链路。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_codex_package_executable_candidates(package_root: &Path) -> Vec<PathBuf> {
    let mut candidates = appx_manifest_codex_executable_candidates(package_root);
    candidates.extend([
        package_root.join("app").join("ChatGPT.exe"),
        package_root.join("app").join("Codex.exe"),
        package_root.join("app").join("resources").join("Codex.exe"),
        package_root.join("ChatGPT.exe"),
        package_root.join("Codex.exe"),
    ]);
    dedupe_paths(candidates)
}

#[cfg(target_os = "windows")]
fn collect_local_windows_codex_executable_candidates(candidates: &mut Vec<(Vec<u32>, PathBuf)>) {
    let mut roots = Vec::new();
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let local_app_data = PathBuf::from(local_app_data);
        let root = local_app_data.join("OpenAI").join("Codex");
        roots.push(root.clone());
        roots.push(root.join("app"));
        roots.push(local_app_data.join("Programs").join("OpenAI").join("Codex"));
        roots.push(local_app_data.join("Programs").join("Codex"));
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        let program_files = PathBuf::from(program_files);
        roots.push(program_files.join("OpenAI").join("Codex"));
        roots.push(program_files.join("Codex"));
    }
    if let Some(program_w6432) = std::env::var_os("ProgramW6432") {
        roots.push(PathBuf::from(program_w6432).join("OpenAI").join("Codex"));
    }
    if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
        roots.push(
            PathBuf::from(program_files_x86)
                .join("OpenAI")
                .join("Codex"),
        );
    }
    if let Some(user_profile) = std::env::var_os("USERPROFILE") {
        roots.push(
            PathBuf::from(user_profile)
                .join("scoop")
                .join("apps")
                .join("codex")
                .join("current"),
        );
    }

    for root in roots {
        push_codex_desktop_executable_candidate(candidates, Vec::new(), root.join("Codex.exe"));
    }
}

/// 从 AppxManifest.xml 读取 Desktop 应用声明的 Executable，减少对包内部目录结构的猜测。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn appx_manifest_codex_executable_candidates(package_root: &Path) -> Vec<PathBuf> {
    let manifest_path = package_root.join("AppxManifest.xml");
    let Ok(text) = std::fs::read_to_string(manifest_path) else {
        return Vec::new();
    };
    appx_manifest_codex_executable_values(&text)
        .into_iter()
        .map(|relative| package_root.join(relative.replace('/', "\\")))
        .collect()
}

/// 提取 manifest 中 Codex App shell 的相对路径；小写 CLI/app-server `codex.exe` 不参与。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn appx_manifest_codex_executable_values(text: &str) -> Vec<String> {
    let Ok(regex) = regex::Regex::new(r#"Executable\s*=\s*"([^"]+)""#) else {
        return Vec::new();
    };
    regex
        .captures_iter(text)
        .filter_map(|captures| captures.get(1).map(|value| value.as_str().trim()))
        .filter(|value| {
            Path::new(value)
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == "Codex.exe" || name == "ChatGPT.exe")
        })
        .map(ToOwned::to_owned)
        .collect()
}

/// 校验并加入候选，统一过滤小写 CLI/app-server 路径和不存在的路径。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn push_codex_desktop_executable_candidate(
    candidates: &mut Vec<(Vec<u32>, PathBuf)>,
    version: Vec<u32>,
    path: PathBuf,
) -> bool {
    let Ok(path) = canonical_codex_desktop_executable_path(&path) else {
        return false;
    };
    if !candidates
        .iter()
        .any(|(_, existing)| paths_equal_ignore_ascii_case(existing, &path))
    {
        candidates.push((version, path));
    }
    true
}

/// 去重候选路径，保留原始优先级顺序。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut deduped = Vec::new();
    for path in paths {
        if !deduped
            .iter()
            .any(|existing: &PathBuf| paths_equal_ignore_ascii_case(existing, &path))
        {
            deduped.push(path);
        }
    }
    deduped
}

/// 执行 PowerShell 并解析 JSON 输出，统一处理空输出和脚本失败。
#[cfg(target_os = "windows")]
fn powershell_json_value(script: &str) -> Option<Value> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const POWERSHELL_COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
    let mut command = crate::powershell::command();
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW);
    let output = command_output_with_timeout(&mut command, POWERSHELL_COMMAND_TIMEOUT)?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return None;
    }
    serde_json::from_str::<Value>(&stdout).ok()
}

/// Wait for a command without leaving a timed-out child behind.
///
/// Output pipes are drained concurrently so a verbose command cannot block on a
/// full pipe while this thread polls its process state.
pub(crate) fn command_output_with_timeout(
    command: &mut Command,
    timeout: Duration,
) -> Option<Output> {
    use std::io::Read;
    use std::sync::mpsc;
    use std::thread;

    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take().expect("stdout was configured as piped");
    let mut stderr = child.stderr.take().expect("stderr was configured as piped");
    let Some(deadline) = Instant::now().checked_add(timeout) else {
        terminate_and_reap_child(&mut child);
        return None;
    };
    let (sender, receiver) = mpsc::channel();
    let stdout_sender = sender.clone();
    thread::spawn(move || {
        let mut output = Vec::new();
        let _ = stdout_sender.send((true, stdout.read_to_end(&mut output).map(|_| output)));
    });
    thread::spawn(move || {
        let mut output = Vec::new();
        let _ = sender.send((false, stderr.read_to_end(&mut output).map(|_| output)));
    });

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // `try_wait` already observed termination. `wait` is retained
                // here to make the reap guarantee explicit for every exit path.
                let _ = child.wait();
                break status;
            }
            Ok(None) => {
                let now = Instant::now();
                if now >= deadline {
                    terminate_and_reap_child(&mut child);
                    return None;
                }
                thread::sleep(Duration::from_millis(20).min(deadline - now));
            }
            Err(_) => {
                terminate_and_reap_child(&mut child);
                return None;
            }
        }
    };

    // A descendant may inherit a pipe even after PowerShell exits. Bound the
    // output drain by the same deadline instead of joining a stuck reader.
    let mut stdout = None;
    let mut stderr = None;
    for _ in 0..2 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let (is_stdout, result) = receiver.recv_timeout(remaining).ok()?;
        if is_stdout {
            stdout = Some(result.ok()?);
        } else {
            stderr = Some(result.ok()?);
        }
    }
    Some(Output {
        status,
        stdout: stdout?,
        stderr: stderr?,
    })
}

fn terminate_and_reap_child(child: &mut Child) {
    // If the process exited between `try_wait` and `kill`, `wait` still reaps it.
    let _ = child.kill();
    let _ = child.wait();
}

/// 解析 PowerShell 输出的字符串或字符串数组 JSON。
#[cfg(target_os = "windows")]
fn powershell_json_string_list(script: &str) -> Vec<String> {
    match powershell_json_value(script) {
        Some(Value::String(value)) => vec![value],
        Some(Value::Array(values)) => values
            .into_iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

/// Windows 路径比较需要忽略大小写；非 Windows 测试也复用该规则验证候选去重。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn paths_equal_ignore_ascii_case(left: &Path, right: &Path) -> bool {
    left.as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
}

/// 从版本号文本解析排序 key，兼容 MSIX 包名和 `Get-AppxPackage Version` 字段。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn version_tuple_from_text(version: &str) -> Vec<u32> {
    version
        .split('.')
        .filter_map(|part| part.parse::<u32>().ok())
        .collect::<Vec<_>>()
}

/// 从 WindowsApps 包目录名解析版本号，供排序使用。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn version_tuple_from_package_name(name: &str) -> Vec<u32> {
    name.split('_')
        .nth(1)
        .map(version_tuple_from_text)
        .unwrap_or_default()
}

/// 探测已安装 Codex Desktop 的版本（MSIX 包版本，如 26.915.4065.0）。
///
/// 先扫 WindowsApps 包目录（纯 fs，快）；目录扫描拿不到版本时才回退
/// `Get-AppxPackage`。探测不到版本时返回 `None`；调用方必须按"版本未知"
/// 回落旧行为，不得当作旧版本处理。
#[cfg(target_os = "windows")]
#[cfg_attr(test, allow(dead_code))]
pub(crate) fn installed_codex_desktop_version() -> Option<Vec<u32>> {
    let mut candidates = Vec::new();
    collect_windowsapps_codex_executable_candidates(&mut candidates);
    if let Some(version) = candidates
        .iter()
        .filter(|(version, _)| !version.is_empty())
        .map(|(version, _)| version.clone())
        .max()
    {
        return Some(version);
    }
    let mut appx_candidates = Vec::new();
    collect_appx_codex_executable_candidates(&mut appx_candidates);
    appx_candidates
        .iter()
        .filter(|(version, _)| !version.is_empty())
        .map(|(version, _)| version.clone())
        .max()
}

/// 探测已安装 Codex Desktop 的版本（Info.plist `CFBundleShortVersionString`）。
#[cfg(target_os = "macos")]
#[cfg_attr(test, allow(dead_code))]
pub(crate) fn installed_codex_desktop_version() -> Option<Vec<u32>> {
    macos_codex_common_bundle_candidates()
        .iter()
        .find_map(|bundle| {
            macos_bundle_info_value(bundle, "CFBundleShortVersionString").and_then(|version| {
                let version = version_tuple_from_text(&version);
                (!version.is_empty()).then_some(version)
            })
        })
}

/// 其他平台没有可靠的 Desktop 版本探测通道，返回 `None`（按版本未知处理）。
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
#[cfg_attr(test, allow(dead_code))]
pub(crate) fn installed_codex_desktop_version() -> Option<Vec<u32>> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_tests_do_not_schedule_live_request_health_warning_sync() {
        let scheduled = std::cell::Cell::new(false);
        schedule_codex_request_health_warning_sync(|| scheduled.set(true));
        assert!(
            !scheduled.get(),
            "unit tests must not inject warnings into the running Codex app"
        );
    }

    /// 返回当前测试平台的 Desktop 主程序文件名。
    fn desktop_test_executable_name() -> &'static str {
        if cfg!(target_os = "windows") {
            "Codex.exe"
        } else {
            "Codex"
        }
    }

    /// 返回当前测试平台应被拒绝的小写 CLI/app-server 文件名。
    fn cli_test_executable_name() -> &'static str {
        if cfg!(target_os = "windows") {
            "codex.exe"
        } else {
            "codex"
        }
    }

    #[test]
    fn codex_startup_toggle_is_explicit_and_idempotent() {
        assert!(!should_launch_codex_desktop_with_ccswitch(false, false));
        assert!(!should_launch_codex_desktop_with_ccswitch(false, true));
        assert!(should_launch_codex_desktop_with_ccswitch(true, false));
        assert!(!should_launch_codex_desktop_with_ccswitch(true, true));
    }

    #[test]
    fn codex_launch_timezone_is_scoped_to_the_child_command() {
        let mut command = Command::new("codex-desktop-placeholder");
        apply_codex_launch_timezone(&mut command, Some("Asia/Taipei"));

        let timezone = command
            .get_envs()
            .find_map(|(key, value)| {
                (key == "TZ").then(|| value.map(|value| value.to_string_lossy().to_string()))
            })
            .flatten();
        assert_eq!(timezone.as_deref(), Some("Asia/Taipei"));

        let mut disabled = Command::new("codex-desktop-placeholder");
        apply_codex_launch_timezone(&mut disabled, None);
        assert!(!disabled.get_envs().any(|(key, _)| key == "TZ"));
    }

    #[test]
    fn codex_runtime_timezone_is_read_from_the_renderer_value() {
        let evaluation = json!({
            "result": {
                "result": {
                    "value": {
                        "timezone": "Asia/Taipei",
                        "utcOffsetMinutes": 480
                    }
                }
            }
        });

        let timezone =
            codex_runtime_timezone_from_evaluation(&evaluation).expect("valid runtime timezone");
        assert_eq!(timezone.timezone, "Asia/Taipei");
        assert_eq!(timezone.utc_offset, "+08:00");
    }

    #[test]
    fn codex_renderer_timezone_override_uses_the_configured_iana_identifier() {
        assert_eq!(
            codex_timezone_override_parameters("America/Los_Angeles"),
            json!({ "timezoneId": "America/Los_Angeles" })
        );
    }

    /// 按当前平台构造一个能通过 Desktop 主程序校验的测试文件。
    ///
    /// Windows/Linux 是文件名级校验，直接写文件即可；macOS 要求 bundle 元数据
    /// （CFBundleIdentifier=com.openai.codex + CFBundleExecutable），构造最小
    /// Codex.app 结构（44b9de42 起 macOS 校验以 bundle 身份为准）。
    fn write_desktop_test_executable(dir: &Path) -> PathBuf {
        let name = desktop_test_executable_name();
        if cfg!(target_os = "macos") {
            let bundle = dir.join("Codex.app");
            let contents = bundle.join("Contents");
            let macos_dir = contents.join("MacOS");
            std::fs::create_dir_all(&macos_dir).expect("create fake bundle MacOS dir");
            std::fs::write(
                contents.join("Info.plist"),
                format!(
                    r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>{name}</string>
    <key>CFBundleIdentifier</key>
    <string>{CODEX_DESKTOP_BUNDLE_IDENTIFIER}</string>
</dict>
</plist>
"#
                ),
            )
            .expect("write fake bundle Info.plist");
            let executable = macos_dir.join(name);
            std::fs::write(&executable, "").expect("write fake bundle executable");
            executable
        } else {
            let executable = dir.join(name);
            std::fs::write(&executable, "").expect("write desktop exe");
            executable
        }
    }

    #[test]
    fn catalog_projection_accepts_model_and_slug_fields() {
        let value = json!({
            "models": [
                { "model": "qwen3.6", "display_name": "Qwen 3.6" },
                { "slug": "deepseek-v4-flash", "displayName": "DeepSeek V4 Flash" },
                { "id": "gpt-5.4-mini" }
            ]
        });
        let (names, models) = codex_model_entries_from_catalog_value(&value);
        assert_eq!(names, vec!["qwen3.6", "deepseek-v4-flash", "gpt-5.4-mini"]);
        assert!(models.iter().all(|model| model["hidden"] == false));
        assert_eq!(models[0]["displayName"], "Qwen 3.6");
    }

    #[test]
    fn catalog_projection_excludes_disabled_models() {
        let value = json!({
            "models": [
                { "model": "included-model", "enabled": true },
                { "model": "excluded-model", "enabled": false },
                { "model": "legacy-model" }
            ]
        });

        let (names, models) = codex_model_entries_from_catalog_value(&value);

        assert_eq!(names, vec!["included-model", "legacy-model"]);
        assert_eq!(
            models
                .iter()
                .filter_map(|model| model.get("model").and_then(Value::as_str))
                .collect::<Vec<_>>(),
            vec!["included-model", "legacy-model"]
        );
        let projection = codex_model_catalog_projection_from_value(
            &json!({
                "models": [{ "model": "excluded-model", "enabled": false }]
            }),
            None,
            None,
        )
        .expect("structurally valid catalog remains authoritative after exclusions");
        assert!(projection.catalog_available);
        assert!(projection.model_names.is_empty());
    }

    #[test]
    fn catalog_projection_does_not_invent_unknown_reasoning_defaults() {
        let value = json!({
            "models": [{ "model": "unknown-third-party", "display_name": "Unknown" }]
        });
        let (_, models) = codex_model_entries_from_catalog_value(&value);

        assert!(models[0].get("defaultReasoningEffort").is_none());
        assert!(models[0].get("supportedReasoningEfforts").is_none());
    }

    #[test]
    fn canonical_projection_rejects_top_level_arrays_but_inline_fallback_accepts_them() {
        let legacy_array = json!([{"model": "legacy-model"}]);
        assert!(codex_model_catalog_projection_from_value(&legacy_array, None, None).is_none());

        let fallback = codex_model_catalog_projection_from_value_with_shape(
            &legacy_array,
            None,
            Some("codex_model_router_v2".to_string()),
            true,
        )
        .expect("inline fallback may use the native array shape");
        assert_eq!(fallback.model_names, vec!["legacy-model"]);
        assert!(!fallback.model_names.is_empty());
    }

    #[test]
    /// 结构上完整的空目录必须阻止陈旧 cache 或内联目录回退。
    fn catalog_projection_preserves_authoritative_empty_and_accepts_malformed_fallback_source() {
        let empty = json!({ "models": [] });
        let empty_projection = codex_model_catalog_projection_from_value(&empty, None, None)
            .expect("empty catalog is an authoritative projection");
        assert!(empty_projection.catalog_available);
        assert!(empty_projection.model_names.is_empty());

        let fallback = json!({
            "models": [
                { "model": "gpt-5.6-sol", "display_name": "GPT-5.6-Sol" },
                { "model": "qwen3.6", "display_name": "Qwen3.6 Local" }
            ]
        });
        let projection = codex_model_catalog_projection_from_value(
            &fallback,
            Some("qwen3.6".to_string()),
            Some("codex_model_router_v2".to_string()),
        )
        .expect("fallback catalog projection");

        assert_eq!(
            projection.model_names,
            vec!["gpt-5.6-sol".to_string(), "qwen3.6".to_string()]
        );
        assert_eq!(projection.default_model.as_deref(), Some("qwen3.6"));
        assert!(projection.catalog_available);
        assert!(
            codex_model_catalog_projection_from_value(&json!({ "unexpected": true }), None, None)
                .is_none(),
            "malformed catalog values remain unavailable and may use a fallback source"
        );
    }

    #[test]
    fn catalog_source_selection_rejects_cross_provider_catalogs_and_caches() {
        let stale_catalog = json!({
            "ccSwitchModelProvider": "old-provider",
            "models": [{"model": "old-model"}]
        });
        let stale_cache = json!({
            "etag": "cc-switch-model-catalog",
            "ccSwitchModelProvider": "old-provider",
            "models": [{"model": "old-cache-model"}]
        });
        let inline = json!({"models": [{"model": "current-model"}]});
        let projection = select_cc_switch_model_catalog_projection(
            Some(&stale_catalog),
            Some(&stale_cache),
            Some(&inline),
            Some("current-model".into()),
            Some("current-provider".into()),
        )
        .expect("current provider inline fallback");
        assert_eq!(projection.model_names, vec!["current-model"]);
        assert!(select_cc_switch_model_catalog_projection(
            Some(&stale_catalog),
            Some(&stale_cache),
            None,
            None,
            Some("current-provider".into()),
        )
        .is_none());
    }

    #[test]
    fn catalog_source_selection_requires_provider_binding_for_fallback_cache() {
        let cache = json!({
            "etag": "cc-switch-model-catalog",
            "models": [{"model": "unknown-owner-model"}]
        });
        assert!(select_cc_switch_model_catalog_projection(
            None,
            Some(&cache),
            None,
            None,
            Some("current-provider".into()),
        )
        .is_none());

        let current_cache = json!({
            "etag": "cc-switch-model-catalog",
            "ccSwitchModelProvider": "current-provider",
            "models": [{"model": "current-model"}]
        });
        let projection = select_cc_switch_model_catalog_projection(
            None,
            Some(&current_cache),
            None,
            None,
            Some("current-provider".into()),
        )
        .expect("same-provider fallback cache");
        assert_eq!(projection.model_names, vec!["current-model"]);
    }

    #[test]
    fn catalog_source_selection_retains_bound_and_legacy_authoritative_empty_catalogs() {
        let cache = json!({
            "etag": "cc-switch-model-catalog",
            "ccSwitchModelProvider": "current-provider",
            "models": [{"model": "stale-model"}]
        });
        for catalog in [
            json!({"models": []}),
            json!({"ccSwitchModelProvider": "current-provider", "models": []}),
        ] {
            let projection = select_cc_switch_model_catalog_projection(
                Some(&catalog),
                Some(&cache),
                None,
                None,
                Some("current-provider".into()),
            )
            .expect("current authoritative empty catalog");
            assert!(projection.catalog_available);
            assert!(projection.model_names.is_empty());
        }
    }

    #[test]
    fn picker_catalog_load_failure_does_not_become_an_empty_installation() {
        let error = "The active Codex config changed while reading its catalog".to_string();
        let result = resolve_codex_model_picker_catalog(Err(error.clone()));

        assert_eq!(result.unwrap_err(), error);
    }

    #[test]
    fn picker_catalog_resolution_distinguishes_empty_authority_from_unmanaged_release() {
        let empty = codex_model_catalog_projection_from_value(
            &json!({"models": []}),
            None,
            Some("managed-provider".to_string()),
        )
        .expect("authoritative empty catalog");
        let (managed, released) =
            resolve_codex_model_picker_catalog(Ok(CodexModelCatalogLoadOutcome::Managed(empty)))
                .expect("managed empty catalog is usable");
        assert!(managed.catalog_available);
        assert!(managed.model_names.is_empty());
        assert!(!released);

        let (unmanaged, released) =
            resolve_codex_model_picker_catalog(Ok(CodexModelCatalogLoadOutcome::Unmanaged {
                model_provider: Some("openai".to_string()),
            }))
            .expect("unmanaged config releases picker ownership");
        assert_eq!(unmanaged.model_provider.as_deref(), Some("openai"));
        assert!(!unmanaged.catalog_available);
        assert!(released);
    }

    #[test]
    fn catalog_source_selection_does_not_treat_empty_fallbacks_as_usable() {
        let cache = json!({
            "etag": "cc-switch-model-catalog",
            "ccSwitchModelProvider": "current-provider",
            "models": []
        });
        let inline = json!({"models": []});
        assert!(select_cc_switch_model_catalog_projection(
            None,
            Some(&cache),
            Some(&inline),
            None,
            Some("current-provider".into()),
        )
        .is_none());

        let inline = json!({"models": [{"model": "current-model"}]});
        let projection = select_cc_switch_model_catalog_projection(
            None,
            Some(&cache),
            Some(&inline),
            None,
            Some("current-provider".into()),
        )
        .expect("empty cache must not shadow usable inline models");
        assert!(projection.catalog_available);
        assert_eq!(projection.model_names, vec!["current-model"]);
    }

    #[test]
    fn catalog_payload_selection_preserves_only_same_provider_usable_catalogs() {
        let previous = json!({
            "modelProvider": "codex_model_router_v2",
            "catalogAvailable": true,
            "defaultModel": "sol-relay",
            "modelNames": ["sol-relay"],
            "models": [{"model": "sol-relay"}]
        });
        let unavailable_same_provider = run_catalog_payload_selection_probe(
            previous.clone(),
            json!({
                "modelProvider": "codex_model_router_v2",
                "catalogAvailable": false,
                "defaultModel": null,
                "modelNames": [],
                "models": []
            }),
        );
        assert_eq!(
            unavailable_same_provider["modelNames"],
            json!(["sol-relay"])
        );
        assert_eq!(unavailable_same_provider["catalogAvailable"], true);
        let released_same_provider = run_catalog_payload_selection_probe(
            previous.clone(),
            json!({"modelProvider": "codex_model_router_v2", "catalogAvailable": false,
                "catalogReleased": true, "modelNames": [], "models": []}),
        );
        assert_eq!(released_same_provider["catalogAvailable"], false);
        assert_eq!(released_same_provider["modelNames"], json!([]));

        let unavailable_other_provider = run_catalog_payload_selection_probe(
            previous.clone(),
            json!({
                "modelProvider": "openrouter",
                "catalogAvailable": false,
                "modelNames": [],
                "models": []
            }),
        );
        assert_eq!(unavailable_other_provider["modelNames"], json!([]));
        assert_eq!(unavailable_other_provider["catalogAvailable"], false);

        let authoritative_empty = run_catalog_payload_selection_probe(
            previous,
            json!({
                "modelProvider": "codex_model_router_v2",
                "catalogAvailable": true,
                "defaultModel": null,
                "modelNames": [],
                "models": []
            }),
        );
        assert_eq!(authoritative_empty["modelNames"], json!([]));
        assert_eq!(authoritative_empty["models"], json!([]));
        assert_eq!(authoritative_empty["catalogAvailable"], true);
    }

    #[test]
    fn live_catalog_ownership_requires_valid_pointer_and_preserves_managed_snapshot() {
        let error = parse_codex_live_config_snapshot(
            "experimental_bearer_token = \"redacted-secret-marker\" trailing-invalid",
        )
        .unwrap_err();
        assert!(!error.contains("redacted-secret-marker"));
        assert!(!error.contains("experimental_bearer_token"));
        let directory = tempfile::tempdir().expect("snapshot directory");
        for text in ["", "model_provider = \"custom\""] {
            let config = text.parse::<toml::Value>().unwrap();
            assert!(
                codex_catalog_path_from_live_snapshot(&config, text, directory.path())
                    .unwrap()
                    .is_none()
            );
        }
        let text = "model_catalog_json = 123";
        assert!(codex_catalog_path_from_live_snapshot(
            &text.parse().unwrap(),
            text,
            directory.path()
        )
        .is_err());
        let text =
            "model_provider = \"custom\"\nmodel_catalog_json = \"cc-switch-model-catalog.json\"";
        assert!(codex_catalog_path_from_live_snapshot(
            &text.parse().unwrap(),
            text,
            directory.path()
        )
        .unwrap()
        .is_some());
    }

    #[test]
    fn released_model_picker_preserves_history_normalization_and_rejects_old_model_scopes() {
        let release_core = include_str!("resources/codex_desktop/model_picker_release.js");
        let scope_core = app_server_model_list_scope_core_script();
        let probe = format!(
            r#"
const normalizedCatalogProvider = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
{scope_core}
{release_core}
const client = {{hostId: "local"}};
const before = captureModelListScope("model/list", {{}}, client);
releaseCodexModelPicker("codex_model_router_v2");
releaseCodexModelPicker("unmanaged-next-provider");
JSON.stringify({{
  before: Boolean(before), after: Boolean(captureModelListScope("model/list", {{}}, client)),
  priorResponseAccepted: isCurrentModelListScope(before, client, {{}}),
  history: normalizeAppServerRequestParams("thread/list", {{limit: 20}}),
  resume: normalizeAppServerRequestParams("thread/resume", {{threadId: "thread-1"}}),
  released: state.catalogReleased,
}});
"#
        );
        let result = run_app_server_request_normalization_probe_with_payload(
            json!({"modelProvider": "codex_model_router_v2", "catalogAvailable": true}),
            &probe,
        );
        assert_eq!(
            result,
            json!({"before": true, "after": false, "priorResponseAccepted": false,
            "history": {"limit": 20, "modelProviders": []}, "resume": {"threadId": "thread-1", "modelProvider": "unmanaged-next-provider"}, "released": true})
        );
    }

    #[test]
    fn unmanaged_manual_compatibility_still_runs_history_sync_and_installs_request_patch() {
        let script = build_model_picker_unlock_script_with_state(
            &CodexModelCatalogProjection::empty(),
            true,
        );
        assert!(script.contains("if (true) incomingPayload.catalogReleased = true"));
        assert!(script.contains("await installAppServerPatch()"));
        assert!(script.contains("void triggerLocalThreadCatalogSync()"));
        assert!(!script.contains("const historySync = await triggerLocalThreadCatalogSync()"));
        assert!(!script.contains("await catalog.requestStartupSync()"));
        assert!(script.contains("if (!state.catalogReleased) patchStatsig()"));
    }

    #[test]
    fn model_list_patch_scope_requires_local_host_current_provider_and_epoch() {
        let result = run_model_list_scope_probe(
            json!({
                "modelProvider": "codex_model_router_v2",
                "catalogAvailable": true
            }),
            r#"
const local = {hostId: "local"};
const remote = {hostId: "remote"};
const localParams = {modelProvider: "codex_model_router_v2"};
const localParamsWithoutProvider = {};
const scope = captureModelListScope("model/list", localParams, local);
const scopeWithoutProvider = captureModelListScope("model/list", localParamsWithoutProvider, local);
const remoteScope = captureModelListScope("model/list", localParams, remote);
const missingHostScope = captureModelListScope("model/list", localParams, {});
const localViewScope = captureModelListScope("model/list", localParams, null, true);
const remoteViewScope = captureModelListScope(
  "model/list", {...localParams, hostId: "remote"}, null, true
);
const wrongProviderScope = captureModelListScope(
  "model/list", {modelProvider: "openai"}, local
);
const current = isCurrentModelListScope(scope, local, localParams);
state.catalogProviderEpoch = 1;
const stale = isCurrentModelListScope(scope, local, localParams);
state.payload = {...state.payload, modelProvider: "openrouter"};
const switched = isCurrentModelListScope(scope, local, localParams);
JSON.stringify({
  local: Boolean(scope),
  localWithoutProvider: Boolean(scopeWithoutProvider),
  remote: remoteScope,
  missingHost: missingHostScope,
  localView: Boolean(localViewScope),
  remoteView: remoteViewScope,
  wrongProvider: wrongProviderScope,
  current,
  stale,
  switched,
});
"#,
        );
        assert_eq!(
            result,
            json!({
                "local": true,
                "localWithoutProvider": true,
                "remote": null,
                "missingHost": null,
                "localView": true,
                "remoteView": null,
                "wrongProvider": null,
                "current": true,
                "stale": false,
                "switched": false
            })
        );
    }

    fn run_model_picker_patch_core_probe(probe: &str) -> serde_json::Value {
        run_model_picker_patch_core_probe_with_payload(
            json!({
                "defaultModel": "qwen3.6",
                "catalogAvailable": true,
                "modelNames": ["qwen3.6", "deepseek-v4-flash"],
                "models": [
                    {"model": "qwen3.6", "displayName": "Qwen 3.6", "hidden": false},
                    {"model": "deepseek-v4-flash", "displayName": "DeepSeek V4 Flash", "hidden": false}
                ]
            }),
            probe,
        )
    }

    fn run_catalog_payload_selection_probe(previous: Value, incoming: Value) -> Value {
        let runtime = rquickjs::Runtime::new().expect("create JavaScript runtime");
        let context = rquickjs::Context::full(&runtime).expect("create JavaScript context");
        let script = format!(
            "const previousPayload = {};\nconst incomingPayload = {};\n{}\nJSON.stringify(selectCatalogPayload(previousPayload, incomingPayload));",
            previous,
            incoming,
            catalog_payload_selection_core_script(),
        );
        context.with(|ctx| {
            let json_text: String = ctx
                .eval(script)
                .expect("execute catalog payload selection core");
            serde_json::from_str(&json_text).expect("parse catalog payload selection result")
        })
    }

    fn run_model_list_scope_probe(payload: Value, probe: &str) -> Value {
        let runtime = rquickjs::Runtime::new().expect("create JavaScript runtime");
        let context = rquickjs::Context::full(&runtime).expect("create JavaScript context");
        let script = format!(
            r#"
const state = {{ payload: {}, catalogProviderEpoch: 0 }};
const currentModelProvider = () => state.payload?.modelProvider || null;
const normalizedCatalogProvider = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
{}
{}
"#,
            payload,
            app_server_model_list_scope_core_script(),
            probe,
        );
        context.with(|ctx| {
            let json_text: String = ctx.eval(script).expect("execute model list scope core");
            serde_json::from_str(&json_text).expect("parse model list scope result")
        })
    }

    fn run_model_picker_patch_core_probe_with_payload(
        payload: Value,
        probe: &str,
    ) -> serde_json::Value {
        let runtime = rquickjs::Runtime::new().expect("create JavaScript runtime");
        let context = rquickjs::Context::full(&runtime).expect("create JavaScript context");
        let script = format!(
            "const payload = {{ catalogAvailable: true, ...{} }};\nconst state = {{ payload }};\n{}\n{}",
            payload,
            model_picker_patch_core_script(),
            probe
        );

        context.with(|ctx| {
            let json_text: String = ctx.eval(script).expect("execute model picker patch core");
            serde_json::from_str(&json_text).expect("parse model picker patch probe result")
        })
    }

    fn run_guardian_v2_compatibility_probe(probe: &str) -> serde_json::Value {
        let runtime = rquickjs::Runtime::new().expect("create JavaScript runtime");
        let context = rquickjs::Context::full(&runtime).expect("create JavaScript context");
        let script = format!(
            "{}\n{}",
            guardian_v2_compatibility_patch_core_script(),
            probe
        );

        context.with(|ctx| {
            let json_text: String = ctx
                .eval(script)
                .expect("execute Guardian V2 compatibility core");
            serde_json::from_str(&json_text).expect("parse Guardian V2 compatibility result")
        })
    }

    fn run_app_server_request_normalization_probe_with_payload(
        payload: Value,
        probe: &str,
    ) -> serde_json::Value {
        let runtime = rquickjs::Runtime::new().expect("create JavaScript runtime");
        let context = rquickjs::Context::full(&runtime).expect("create JavaScript context");
        let script = format!(
            "const payload = {};\nconst state = {{ payload }};\n{}\n{}",
            payload,
            app_server_request_normalization_core_script(),
            probe
        );

        context.with(|ctx| {
            let json_text: String = ctx
                .eval(script)
                .expect("execute app-server request normalization core");
            serde_json::from_str(&json_text).expect("parse app-server request normalization result")
        })
    }

    fn run_history_lineage_hydration_probe(probe: &str) -> serde_json::Value {
        let runtime = rquickjs::Runtime::new().expect("create JavaScript runtime");
        let context = rquickjs::Context::full(&runtime).expect("create JavaScript context");
        let script = format!("{}\n{}", history_lineage_hydration_core_script(), probe);

        context.with(|ctx| {
            let json_text: String = ctx
                .eval(script)
                .expect("execute history lineage hydration core");
            serde_json::from_str(&json_text).expect("parse history lineage hydration result")
        })
    }

    fn run_async_history_lineage_hydration_probe(probe: &str) -> serde_json::Value {
        let runtime = rquickjs::Runtime::new().expect("create JavaScript runtime");
        let context = rquickjs::Context::full(&runtime).expect("create JavaScript context");
        let script = format!("{}\n{}", history_lineage_hydration_core_script(), probe);
        context.with(|ctx| {
            ctx.eval::<(), _>(script)
                .expect("start async history lineage hydration probe");
        });
        while runtime
            .execute_pending_job()
            .expect("execute history lineage hydration job")
        {}
        context.with(|ctx| {
            let json_text: String = ctx
                .eval("globalThis.__historyLineageResult")
                .expect("read async history lineage hydration result");
            serde_json::from_str(&json_text).expect("parse async history lineage hydration result")
        })
    }

    fn run_codex_continuation_probe(probe: &str) -> serde_json::Value {
        let runtime = rquickjs::Runtime::new().expect("create JavaScript runtime");
        let context = rquickjs::Context::full(&runtime).expect("create JavaScript context");
        let probe = format!(
            r#"
// Simulate the backend's authorized prepare/commit handshake for existing
// client-binding probes; the runtime itself never auto-commits a prepared job.
const runCodexContinuation = async (threadId, recoveryId, model, observedAtMs) => {{
  const started = state.startCodexContinuation(threadId, recoveryId, model, observedAtMs);
  if (!started.started) return {{ submitted: false, reason: started.reason }};
  for (let pending = 0; pending < 256; pending += 1) {{
    const job = state.readCodexContinuationJob(recoveryId);
    if (job?.status === "prepared") state.commitCodexContinuation(recoveryId);
    if (job?.status === "completed") return job;
    await Promise.resolve();
  }}
  throw new Error("The simulated authorized continuation did not finish");
}};
{probe}
"#
        );
        let script = format!(
            r#"
const state = {{}};
const verifiedProbeClient = (value) => {{
  const client = {{ hostId: "local", getCompatibleThreadSortKey() {{}}, supportsPaginatedThreadHistory() {{}}, ...value }};
  const original = client.__ccSwitchOriginalSendRequest || client.sendRequest?.bind(client);
  if (typeof original !== "function") return client;
  const wrapper = async (method, params, options) => {{
    rememberCodexUserTurnAction(method, params);
    return original(method, params, options);
  }};
  Object.defineProperty(wrapper, "__ccSwitchRequestHook", {{value: Object.freeze({{client, original, version: "standalone"}})}});
  client.__ccSwitchOriginalSendRequest = original;
  client.sendRequest = wrapper;
  client.__ccSwitchModelRequestPatch = "standalone";
  return client;
}};
Object.defineProperty(state, "appServerClients", {{
  set(clients) {{ this.clients = clients.map(verifiedProbeClient); }},
  get() {{ return this.clients; }},
}});
state.appServerClients = [];
const storage = {{}};
const localStorage = {{
  getItem: (key) => storage[key] || null,
  setItem: (key, value) => {{ storage[key] = value; }},
}};
const installAppServerPatch = async () => {{}};
const recordFailure = () => {{}};
const setTimeout = (callback) => globalThis.__continuationTimer ? globalThis.__continuationTimer(callback) : 1;
const clearTimeout = () => {{}};
{}
{}
{}
"#,
            app_server_module_client_discovery_core_script(),
            codex_continuation_core_script(),
            probe,
        );
        context.with(|ctx| {
            ctx.eval::<(), _>(script)
                .expect("start Codex continuation probe");
        });
        while runtime
            .execute_pending_job()
            .expect("execute Codex continuation job")
        {}
        context.with(|ctx| {
            let json_text: String = ctx
                .eval("globalThis.__codexContinuationResult")
                .expect("read Codex continuation probe result");
            serde_json::from_str(&json_text).expect("parse Codex continuation probe result")
        })
    }

    fn run_summary_handoff_probe(probe: &str) -> Value {
        let runtime = rquickjs::Runtime::new().expect("create JavaScript runtime");
        let context = rquickjs::Context::full(&runtime).expect("create JavaScript context");
        let script = format!(
            r#"
const state = {{}};
const installAppServerPatch = async () => {{}};
const recordFailure = () => {{}};
const setTimeout = (callback) => {{ callback(); return 1; }};
{}
{}
"#,
            summary_handoff_core_script(),
            probe
        );
        context.with(|ctx| {
            ctx.eval::<(), _>(script)
                .expect("start manual summary handoff probe");
        });
        while runtime
            .execute_pending_job()
            .expect("execute manual summary handoff job")
        {}
        context.with(|ctx| {
            let json_text: String = ctx
                .eval("globalThis.__summaryHandoffResult")
                .expect("read manual summary handoff result");
            serde_json::from_str(&json_text).expect("parse manual summary handoff result")
        })
    }

    fn run_request_health_warning_probe(suppressed: bool, setup: &str, probe: &str) -> Value {
        let runtime = rquickjs::Runtime::new().expect("create JavaScript runtime");
        let context = rquickjs::Context::full(&runtime).expect("create JavaScript context");
        let script = format!(
            r#"
const state = {{}};
const storage = new Map();
const localStorage = {{
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
}};
const timers = new Map();
let nextTimer = 1;
const setTimeout = (callback) => {{ const id = nextTimer++; timers.set(id, callback); return id; }};
const clearTimeout = (id) => timers.delete(id);
class Element {{
  constructor(tag) {{ this.tag = tag; this.children = []; this.style = {{}}; this.attributes = {{}}; }}
  appendChild(child) {{ child.parent = this; this.children.push(child); return child; }}
  append(...children) {{ children.forEach((child) => this.appendChild(child)); }}
  replaceChildren(...children) {{ this.children = []; this.append(...children); }}
  setAttribute(name, value) {{ this.attributes[name] = String(value); }}
  getAttribute(name) {{ return this.attributes[name] ?? null; }}
  remove() {{
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }}
  querySelectorAll(selector) {{
    const attribute = selector.slice(1, -1);
    return this.children.flatMap((child) => [
      ...(Object.hasOwn(child.attributes, attribute) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }}
}}
const root = new Element("body");
const document = {{
  body: root,
  documentElement: root,
  createElement: (tag) => new Element(tag),
  getElementById: (id) => {{
    const find = (element) => element.id === id ? element : element.children.map(find).find(Boolean);
    return find(root) || null;
  }},
}};
const warning = {{ token: "pending-review", expiresAtMs: Date.now() + 60000, title: "Request paused" }};
const storageKey = "ccswitch-request-health-warnings-v1";
const containerId = "ccswitch-request-health-warning-container";
{}
{}
{}
"#,
            setup,
            request_health_warning_core_script(suppressed),
            probe
        );
        context.with(|ctx| {
            let json_text: String = ctx
                .eval(script)
                .expect("execute Request Health warning overlay");
            serde_json::from_str(&json_text).expect("parse Request Health warning overlay result")
        })
    }

    #[test]
    fn manual_summary_uses_the_runtime_bypass_discriminator() {
        let result = run_summary_handoff_probe(
            r#"
let summaryPrompt = null;
state.appServerClients = [{ sendRequest: async (method, params) => {
  if (method === "turn/start") {
    summaryPrompt = params.input[0].text;
    return { turn: { id: "summary-turn" } };
  }
  return { thread: { id: "source-thread", status: { type: "idle" }, turns: [
    { id: "summary-turn", status: "completed", items: [{ role: "assistant", text: "Handoff summary" }] },
  ] } };
} }];
void runSummarizeSession("source-thread").then((result) => {
  globalThis.__summaryHandoffResult = JSON.stringify({ result, summaryPrompt });
});
"#,
        );
        let prompt = result["summaryPrompt"]
            .as_str()
            .expect("summary turn prompt");
        assert_eq!(prompt, manual_summary_request_prompt());
        assert!(prompt.contains(MANUAL_SUMMARY_REQUEST_MARKER));
        assert!(
            prompt.contains(MANUAL_SUMMARY_REQUEST_INSTRUCTION),
            "the production summary prompt must match the Request Health bypass guard"
        );
        assert_eq!(result["result"]["summary"], "Handoff summary");
    }

    #[test]
    fn request_health_warning_overlay_can_enable_after_suppressed_injection() {
        let result = run_request_health_warning_probe(
            true,
            "",
            r#"
state.syncRequestHealthWarnings([warning], false);
JSON.stringify({
  cards: document.getElementById(containerId)?.children.length || 0,
  stored: JSON.parse(localStorage.getItem(storageKey) || "[]").map((item) => item.token),
});
"#,
        );
        assert_eq!(result["cards"], 1);
        assert_eq!(result["stored"], json!(["pending-review"]));
    }

    #[test]
    fn request_health_warning_overlay_disable_clears_and_rejects_stale_updates() {
        let result = run_request_health_warning_probe(
            false,
            "",
            r#"
state.syncRequestHealthWarnings([warning], false);
const staleExpiryCallbacks = [...timers.values()];
state.syncRequestHealthWarnings([], true);
state.syncRequestHealthWarnings([warning]);
for (const callback of staleExpiryCallbacks) callback();
JSON.stringify({
  containerPresent: Boolean(document.getElementById(containerId)),
  stored: localStorage.getItem(storageKey),
  timer: state.requestHealthWarningExpiryTimer,
  scheduledTimers: timers.size,
});
"#,
        );
        assert_eq!(result["containerPresent"], false);
        assert_eq!(result["stored"], Value::Null);
        assert_eq!(result["timer"], Value::Null);
        assert_eq!(result["scheduledTimers"], 0);
    }

    #[test]
    fn request_health_warning_overlay_does_not_restore_storage_after_reenable() {
        let result = run_request_health_warning_probe(
            true,
            "localStorage.setItem(storageKey, JSON.stringify([warning]));",
            r#"
state.syncRequestHealthWarnings([], false);
JSON.stringify({
  containerPresent: Boolean(document.getElementById(containerId)),
  stored: localStorage.getItem(storageKey),
});
"#,
        );
        assert_eq!(result["containerPresent"], false);
        assert_eq!(result["stored"], Value::Null);
    }

    #[test]
    fn terminal_error_policy_renderer_and_rust_share_contract() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../tests/fixtures/terminalErrorPolicy.json"
        ))
        .expect("parse shared terminal-error fixtures");
        let cases_json = serde_json::to_string(&cases).expect("encode terminal-error fixtures");
        let result = run_codex_continuation_probe(&format!(
            r#"
const cases = {cases_json};
globalThis.__codexContinuationResult = JSON.stringify(cases.map((testCase) => {{
  const disposition = classifyCodexContinuationThread({{
    id: "exact-thread", model: "request-model",
    turns: [{{ id: "failed-turn", status: "failed", error: testCase.error }}],
  }}, "exact-thread", "request-model");
  return {{
    ready: disposition.ready,
    code: codexContinuationTerminalErrorCode(testCase.event, {{ error: testCase.error }}),
  }};
}}));
"#,
        ));
        for (case, renderer) in cases.iter().zip(result.as_array().unwrap()) {
            let backend = crate::proxy::providers::codex_terminal::terminal_error_code(
                case["event"].as_str().unwrap(),
                &json!({ "error": case["error"] }),
            );
            assert_eq!(backend, case["expectedCode"].as_str(), "{}", case["name"]);
            assert_eq!(
                renderer["code"].as_str(),
                backend,
                "renderer and backend categories disagree: {}",
                case["name"],
            );
            assert_eq!(
                renderer["ready"],
                backend.is_none(),
                "renderer and backend disagree: {}",
                case["name"],
            );
        }
    }

    #[test]
    fn codex_continuation_targets_only_the_exact_failed_thread_without_picker_overrides() {
        let result = run_codex_continuation_probe(
            r#"
const calls = [];
const failed = { id: "exact-thread", model: "request-model", turns: [{ id: "failed-turn", status: "failed", error: { message: "server overloaded" } }] };
state.appServerClients = [
  { sendRequest: async () => ({ thread: { ...failed, id: "wrong-thread" } }) },
  {
    sendRequest: async () => { throw new Error("the picker wrapper must not be called"); },
    __ccSwitchOriginalSendRequest: async (method, params) => {
      calls.push({ method, params });
      return method === "thread/read" ? { thread: failed } : { turn: { id: "continue-turn" } };
    },
  },
];
void runCodexContinuation("exact-thread", "recovery-1", "request-model", Date.now()).then((result) => {
  globalThis.__codexContinuationResult = JSON.stringify({ result, calls });
});
"#,
        );
        assert_eq!(result["result"]["submitted"], true);
        assert_eq!(
            result["calls"],
            json!([
                { "method": "thread/read", "params": { "threadId": "exact-thread", "includeTurns": true } },
                { "method": "thread/read", "params": { "threadId": "exact-thread", "includeTurns": true } },
                { "method": "turn/start", "params": { "threadId": "exact-thread", "input": [{ "type": "text", "text": "continue" }] } },
            ])
        );
    }

    #[tokio::test]
    async fn codex_continuation_rechecks_authorization_after_cdp_connection() {
        use std::sync::Arc;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind simulated CDP server");
        let address = listener.local_addr().unwrap();
        let authorized = Arc::new(AtomicBool::new(true));
        let authorization_stages = Arc::new(Mutex::new(Vec::new()));
        let checked_stages = authorization_stages.clone();
        let server_authorized = authorized.clone();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
            let enabled = socket.next().await.unwrap().unwrap();
            let enabled: Value = serde_json::from_str(enabled.to_text().unwrap()).unwrap();
            assert_eq!(enabled["method"], "Runtime.enable");
            server_authorized.store(false, Ordering::Release);
            socket
                .send(Message::Text(
                    json!({"id": enabled["id"], "result": {}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            match tokio::time::timeout(Duration::from_millis(250), socket.next()).await {
                Ok(Some(Ok(Message::Text(message)))) => {
                    let message: Value = serde_json::from_str(&message).unwrap();
                    message["method"].as_str().map(str::to_string)
                }
                _ => None,
            }
        });
        let result = evaluate_cdp_expression_if_authorized(
            &format!("ws://{address}"),
            "state.commitCodexContinuation('simulated-recovery')",
            &move |final_commit| {
                checked_stages.lock().unwrap().push(final_commit);
                authorized.load(Ordering::Acquire)
            },
        )
        .await
        .expect("inspect simulated authorization boundary");
        assert!(result.is_none());
        assert_eq!(server.await.unwrap(), None);
        assert_eq!(*authorization_stages.lock().unwrap(), vec![false, true]);
    }

    #[test]
    fn codex_continuation_bridge_checks_runtime_identity_before_every_operation() {
        let start = codex_continuation_bridge_script(
            "startCodexContinuation",
            "'exact-thread', 'isolated-recovery', 'request-model', 1000",
        );
        let poll =
            codex_continuation_bridge_script("readCodexContinuationJob", "'isolated-recovery'");
        let commit =
            codex_continuation_bridge_script("commitCodexContinuation", "'isolated-recovery'");
        let cancel =
            codex_continuation_bridge_script("cancelCodexContinuation", "'isolated-recovery'");
        let runtime_fingerprint = codex_renderer_runtime_fingerprint();
        let script = format!(
            r#"
const window = {{}};
const calls = [];
const operations = [() => {start}, () => {poll}, () => {commit}, () => {cancel}];
const missing = operations.map((operation) => operation());
const state = {{rendererRuntimeFingerprint: 'stale-runtime'}};
for (const method of ['startCodexContinuation', 'readCodexContinuationJob', 'commitCodexContinuation', 'cancelCodexContinuation']) {{
  state[method] = function(...args) {{ calls.push({{method, args, bound: this === state}}); return {{accepted: true}}; }};
}}
window[{MODEL_PICKER_PATCH_KEY:?}] = state;
const stale = operations.map((operation) => operation());
const staleCalls = calls.length;
state.rendererRuntimeFingerprint = {runtime_fingerprint:?};
const current = operations.map((operation) => operation());
state.rendererRuntimeFingerprint = 'replaced-after-preparation';
const replaced = [operations[1](), operations[2]()];
const replacedCalls = calls.length;
state.rendererRuntimeFingerprint = {runtime_fingerprint:?};
const inheritedState = Object.create(state);
inheritedState.rendererRuntimeFingerprint = {runtime_fingerprint:?};
window[{MODEL_PICKER_PATCH_KEY:?}] = inheritedState;
const inherited = operations.map((operation) => operation());
JSON.stringify({{missing, stale, staleCalls, current, replaced, replacedCalls, inherited, calls}});
"#
        );
        let runtime = rquickjs::Runtime::new().expect("create bridge JavaScript runtime");
        let context = rquickjs::Context::full(&runtime).expect("create bridge JavaScript context");
        context.with(|ctx| {
            let encoded: String = ctx.eval(script).expect("execute generated continuation bridges");
            let result: Value = serde_json::from_str(&encoded).unwrap();
            for category in ["missing", "stale", "replaced", "inherited"] {
                for unavailable in result[category].as_array().unwrap() {
                    assert_eq!(
                        unavailable,
                        &json!({
                            "started": false, "status": "unavailable",
                            "reason": "Codex compatibility layer is not ready"
                        }),
                        "{category} runtime must not invoke a continuation method"
                    );
                }
            }
            assert_eq!(result["staleCalls"], 0);
            assert_eq!(result["replacedCalls"], 4);
            assert_eq!(
                result["current"],
                json!([
                    {"accepted": true}, {"accepted": true},
                    {"accepted": true}, {"accepted": true}
                ])
            );
            assert_eq!(
                result["calls"],
                json!([
                    {"method": "startCodexContinuation", "args": ["exact-thread", "isolated-recovery", "request-model", 1000], "bound": true},
                    {"method": "readCodexContinuationJob", "args": ["isolated-recovery"], "bound": true},
                    {"method": "commitCodexContinuation", "args": ["isolated-recovery"], "bound": true},
                    {"method": "cancelCodexContinuation", "args": ["isolated-recovery"], "bound": true}
                ])
            );
        });
    }

    async fn codex_continuation_test_targets(
        responses: Vec<Value>,
    ) -> (
        Vec<CdpTarget>,
        u16,
        std::sync::Arc<Mutex<Vec<String>>>,
        tokio::task::JoinHandle<()>,
    ) {
        codex_continuation_test_targets_with_evaluations(
            responses
                .into_iter()
                .map(|value| Some(json!({"result": {"value": value}})))
                .collect(),
        )
        .await
    }

    async fn codex_continuation_test_targets_with_evaluations(
        responses: Vec<Option<Value>>,
    ) -> (
        Vec<CdpTarget>,
        u16,
        std::sync::Arc<Mutex<Vec<String>>>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind isolated continuation CDP server");
        let address = listener.local_addr().unwrap();
        let expressions = std::sync::Arc::new(Mutex::new(Vec::new()));
        let recorded = expressions.clone();
        let server = tokio::spawn(async move {
            let mut responses = std::collections::VecDeque::from(responses);
            while let Some(response) = responses.front().cloned() {
                let mut consume_response = true;
                let (socket, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
                for method in ["Runtime.enable", "Runtime.evaluate"] {
                    let command = socket.next().await.unwrap().unwrap();
                    let command: Value = serde_json::from_str(command.to_text().unwrap()).unwrap();
                    assert_eq!(command["method"], method);
                    let result = if method == "Runtime.evaluate" {
                        recorded.lock().unwrap().push(
                            command["params"]["expression"]
                                .as_str()
                                .unwrap()
                                .to_string(),
                        );
                        let Some(response) = response.as_ref() else {
                            socket
                                .close(None)
                                .await
                                .expect("close simulated CDP websocket");
                            let peer_close =
                                tokio::time::timeout(Duration::from_secs(1), socket.next())
                                    .await
                                    .expect("peer must acknowledge the simulated close");
                            assert!(
                                matches!(peer_close, Some(Ok(Message::Close(_))) | None),
                                "unexpected simulated close acknowledgement: {peer_close:?}"
                            );
                            break;
                        };
                        if response.get("repeatPending").and_then(Value::as_bool) == Some(true) {
                            if command["params"]["expression"]
                                .as_str()
                                .unwrap()
                                .contains("readCodexContinuationJob")
                            {
                                consume_response = false;
                                json!({"result": {"value": {"status": "pending"}}})
                            } else {
                                assert!(command["params"]["expression"]
                                    .as_str()
                                    .unwrap()
                                    .contains("cancelCodexContinuation"));
                                json!({"result": {"value": {"cancelled": true, "mutationAttempted": false}}})
                            }
                        } else {
                            response.clone()
                        }
                    } else {
                        json!({})
                    };
                    socket
                        .send(Message::Text(
                            json!({"id": command["id"], "result": result})
                                .to_string()
                                .into(),
                        ))
                        .await
                        .unwrap();
                }
                if consume_response {
                    responses.pop_front();
                }
            }
        });
        let targets = ["unready-renderer", "ready-renderer"]
            .into_iter()
            .map(|id| CdpTarget {
                id: id.to_string(),
                target_type: "page".to_string(),
                title: "Codex".to_string(),
                url: "codex://desktop".to_string(),
                web_socket_debugger_url: Some(format!("ws://{address}")),
            })
            .collect();
        (targets, address.port(), expressions, server)
    }

    #[tokio::test]
    async fn codex_continuation_tries_ready_renderer_after_client_discovery_failure() {
        let (targets, port, expressions, server) = codex_continuation_test_targets(vec![
            json!({"started": true}),
            json!({
                "status": "completed", "submitted": false, "mutationAttempted": false,
                "reason": "Codex Desktop request client was not found"
            }),
            json!({"cancelled": true, "mutationAttempted": false}),
            json!({"started": true}),
            json!({"status": "prepared"}),
            json!({"started": true}),
            json!({
                "status": "completed", "submitted": true, "mutationAttempted": true,
                "reason": "Continuation submitted to the interrupted Codex thread"
            }),
        ])
        .await;
        let authorization_stages = Mutex::new(Vec::new());
        let mut diagnostics = Vec::new();
        let result = submit_codex_continuation_to_targets(
            targets,
            port,
            "start-exact-continuation",
            "\"isolated-recovery\"",
            &|final_commit| {
                authorization_stages.lock().unwrap().push(final_commit);
                true
            },
            &mut diagnostics,
        )
        .await;
        server.abort();
        let result = result.unwrap().expect("a ready renderer must submit");
        assert!(
            result.submitted,
            "unready renderer must not starve a ready one"
        );
        assert!(result.mutation_attempted);
        assert_eq!(result.target_id.as_deref(), Some("ready-renderer"));
        assert_eq!(*authorization_stages.lock().unwrap(), vec![false, true]);
        assert_eq!(
            diagnostics,
            vec!["target unready-renderer: Codex Desktop request client was not found"]
        );
        let expressions = expressions.lock().unwrap();
        assert_eq!(expressions.len(), 7);
        assert_eq!(
            expressions
                .iter()
                .filter(|expression| expression.contains("commitCodexContinuation"))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn codex_continuation_never_falls_through_a_stop_or_uncertain_mutation() {
        for completed in [
            json!({
                "status": "completed", "submitted": false, "mutationAttempted": true,
                "reason": "Codex Desktop request client was not found"
            }),
            json!({
                "status": "completed", "submitted": false,
                "reason": "Codex Desktop request client was not found"
            }),
            json!({
                "status": "completed", "submitted": false, "mutationAttempted": false,
                "reason": "The user changed or stopped the Codex thread before continuation"
            }),
            json!({
                "status": "completed", "submitted": false, "mutationAttempted": false,
                "reason": "The interrupted Codex thread is still active"
            }),
            json!({
                "status": "completed", "submitted": false, "mutationAttempted": false,
                "reason": "The latest Codex turn needs a user action"
            }),
        ] {
            let expected_mutation = completed["mutationAttempted"].as_bool().unwrap_or(false);
            let (targets, port, expressions, server) =
                codex_continuation_test_targets(vec![json!({"started": true}), completed]).await;
            let result = submit_codex_continuation_to_targets(
                targets,
                port,
                "start-exact-continuation",
                "\"isolated-recovery\"",
                &|_| panic!("a stopped preparation must not authorize a mutation"),
                &mut Vec::new(),
            )
            .await;
            server.abort();
            let result = result.unwrap().expect("preserve the first stop decision");
            assert!(!result.submitted);
            assert_eq!(result.mutation_attempted, expected_mutation);
            assert_eq!(result.target_id.as_deref(), Some("unready-renderer"));
            assert_eq!(expressions.lock().unwrap().len(), 2);
        }
    }

    #[tokio::test]
    async fn codex_continuation_preserves_uncertainty_when_runtime_is_lost_after_commit() {
        let (targets, port, expressions, server) = codex_continuation_test_targets(vec![
            json!({"started": true}),
            json!({"status": "prepared"}),
            json!({"started": true}),
            json!({
                "started": false, "status": "unavailable",
                "reason": "Codex compatibility layer is not ready"
            }),
        ])
        .await;
        let result = submit_codex_continuation_to_targets(
            targets,
            port,
            "start-exact-continuation",
            "\"isolated-recovery\"",
            &|_| true,
            &mut Vec::new(),
        )
        .await;
        server.abort();
        assert!(result.unwrap_err().contains("result is uncertain"));
        let expressions = expressions.lock().unwrap();
        assert_eq!(expressions.len(), 4);
        assert_eq!(
            expressions
                .iter()
                .filter(|expression| expression.contains("commitCodexContinuation"))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn codex_continuation_advances_after_precommit_transport_or_evaluation_failure() {
        for (phase, failure) in [
            ("start", None),
            (
                "start",
                Some(json!({"exceptionDetails": {"text": "isolated exception"}})),
            ),
            ("poll", None),
            (
                "poll",
                Some(json!({"exceptionDetails": {"text": "isolated exception"}})),
            ),
        ] {
            let mut evaluations = Vec::new();
            if phase == "poll" {
                evaluations.push(Some(json!({"result": {"value": {"started": true}}})));
            }
            evaluations.push(failure);
            evaluations.push(Some(
                json!({"result": {"value": {"cancelled": true, "mutationAttempted": false}}}),
            ));
            evaluations.extend([
                Some(json!({"result": {"value": {"started": true}}})),
                Some(json!({"result": {"value": {"status": "prepared"}}})),
                Some(json!({"result": {"value": {"started": true}}})),
                Some(json!({"result": {"value": {
                    "status": "completed", "submitted": true, "mutationAttempted": true,
                    "reason": "Continuation submitted to the interrupted Codex thread"
                }}})),
            ]);
            let (targets, port, expressions, server) =
                codex_continuation_test_targets_with_evaluations(evaluations).await;
            let authorization_stages = Mutex::new(Vec::new());
            let mut diagnostics = Vec::new();
            let result = tokio::time::timeout(
                Duration::from_secs(3),
                submit_codex_continuation_to_targets(
                    targets,
                    port,
                    "start-exact-continuation",
                    "\"isolated-recovery\"",
                    &|final_commit| {
                        authorization_stages.lock().unwrap().push(final_commit);
                        true
                    },
                    &mut diagnostics,
                ),
            )
            .await;
            server.abort();
            let result = result
                .expect("a failed read-only renderer must not consume the readiness deadline")
                .expect("read-only CDP failures must advance to another renderer")
                .expect("the second renderer must be ready");
            assert!(
                result.submitted,
                "{phase} failure must not starve a ready renderer"
            );
            assert_eq!(result.target_id.as_deref(), Some("ready-renderer"));
            assert_eq!(*authorization_stages.lock().unwrap(), vec![false, true]);
            assert_eq!(diagnostics.len(), 1);
            assert!(diagnostics[0].starts_with("target unready-renderer:"));
            let expressions = expressions.lock().unwrap();
            assert_eq!(expressions.len(), if phase == "poll" { 7 } else { 6 });
            assert_eq!(
                expressions
                    .iter()
                    .filter(|expression| expression.contains("commitCodexContinuation"))
                    .count(),
                1
            );
        }
    }

    #[tokio::test]
    async fn codex_continuation_never_advances_after_postcommit_transport_or_evaluation_failure() {
        for failure in [
            None,
            Some(json!({"exceptionDetails": {"text": "isolated exception"}})),
        ] {
            let exception = failure.is_some();
            let (targets, port, expressions, server) =
                codex_continuation_test_targets_with_evaluations(vec![
                    Some(json!({"result": {"value": {"started": true}}})),
                    Some(json!({"result": {"value": {"status": "prepared"}}})),
                    Some(json!({"result": {"value": {"started": true}}})),
                    failure,
                ])
                .await;
            let authorization_stages = Mutex::new(Vec::new());
            let mut diagnostics = Vec::new();
            let result = submit_codex_continuation_to_targets(
                targets,
                port,
                "start-exact-continuation",
                "\"isolated-recovery\"",
                &|final_commit| {
                    authorization_stages.lock().unwrap().push(final_commit);
                    true
                },
                &mut diagnostics,
            )
            .await;
            server.abort();
            let error = result.expect_err("a lost commit acknowledgement must stay uncertain");
            assert!(error.starts_with("target unready-renderer:"), "{error}");
            assert!(
                error.contains(if exception {
                    "CDP evaluation failed"
                } else {
                    "CDP websocket closed before Runtime.evaluate response"
                }),
                "{error}"
            );
            assert!(diagnostics.is_empty());
            assert_eq!(*authorization_stages.lock().unwrap(), vec![false, true]);
            assert_eq!(expressions.lock().unwrap().len(), 4);
        }
    }

    #[tokio::test]
    async fn codex_continuation_reconciles_abandoned_jobs_with_cancellation_evidence() {
        for job in [
            Value::Null,
            json!({"status": "unexpected"}),
            json!({"status": "unavailable"}),
        ] {
            for cancellation in [
                None,
                Some(json!({"cancelled": true, "mutationAttempted": false})),
                Some(json!({"cancelled": true, "notFound": true, "mutationAttempted": false})),
                Some(json!({"cancelled": false, "mutationAttempted": true, "submitted": false})),
                Some(json!({"cancelled": false, "mutationAttempted": true, "submitted": true})),
            ] {
                let attempted = cancellation
                    .as_ref()
                    .and_then(|value| value["mutationAttempted"].as_bool())
                    == Some(true);
                let already_submitted = cancellation
                    .as_ref()
                    .and_then(|value| value["submitted"].as_bool())
                    == Some(true);
                let mut evaluations = vec![
                    Some(json!({"result": {"value": {"started": true}}})),
                    Some(json!({"result": {"value": job}})),
                    cancellation.map(|value| json!({"result": {"value": value}})),
                ];
                if !attempted {
                    evaluations.extend([
                        Some(json!({"result": {"value": {"started": true}}})),
                        Some(json!({"result": {"value": {"status": "prepared"}}})),
                        Some(json!({"result": {"value": {"started": true}}})),
                        Some(json!({"result": {"value": {"status": "completed", "submitted": true, "mutationAttempted": true}}})),
                    ]);
                }
                let (targets, port, expressions, server) =
                    codex_continuation_test_targets_with_evaluations(evaluations).await;
                let authorizations = Mutex::new(Vec::new());
                let mut diagnostics = Vec::new();
                let result = submit_codex_continuation_to_targets(
                    targets,
                    port,
                    "start-exact-continuation",
                    "\"isolated-recovery\"",
                    &|final_commit| {
                        authorizations.lock().unwrap().push(final_commit);
                        true
                    },
                    &mut diagnostics,
                )
                .await;
                server.abort();
                let result = result.unwrap().unwrap();
                assert!(result.mutation_attempted);
                assert_eq!(result.submitted, !attempted || already_submitted);
                assert_eq!(
                    result.target_id.as_deref(),
                    Some(if attempted {
                        "unready-renderer"
                    } else {
                        "ready-renderer"
                    })
                );
                assert_eq!(diagnostics.len(), 1);
                assert_eq!(
                    *authorizations.lock().unwrap(),
                    if attempted { vec![] } else { vec![false, true] }
                );
                assert_eq!(
                    expressions
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|script| script.contains("cancelCodexContinuation"))
                        .count(),
                    1
                );
            }
        }
    }

    #[tokio::test]
    async fn codex_continuation_reused_submitting_job_stops_but_own_commit_waits_for_confirmation()
    {
        for inherited in [
            json!({"status": "submitting"}),
            json!({"status": "pending", "mutationAttempted": true}),
        ] {
            let (targets, port, expressions, server) =
                codex_continuation_test_targets(vec![json!({"started": true}), inherited]).await;
            let result = submit_codex_continuation_to_targets(
                targets,
                port,
                "start-exact-continuation",
                "\"isolated-recovery\"",
                &|_| panic!("an inherited submission must not be authorized again"),
                &mut Vec::new(),
            )
            .await;
            server.abort();
            let result = result.unwrap().unwrap();
            assert!(result.mutation_attempted);
            assert!(!result.submitted);
            assert_eq!(result.target_id.as_deref(), Some("unready-renderer"));
            assert_eq!(expressions.lock().unwrap().len(), 2);
        }
        let (targets, port, expressions, server) = codex_continuation_test_targets(vec![
            json!({"started": true}),
            json!({"status": "prepared"}),
            json!({"started": true}),
            json!({"status": "submitting", "mutationAttempted": true}),
            json!({"status": "completed", "submitted": true, "mutationAttempted": true}),
        ])
        .await;
        let authorizations = Mutex::new(Vec::new());
        let result = submit_codex_continuation_to_targets(
            targets,
            port,
            "start-exact-continuation",
            "\"isolated-recovery\"",
            &|final_commit| {
                authorizations.lock().unwrap().push(final_commit);
                true
            },
            &mut Vec::new(),
        )
        .await;
        server.abort();
        let result = result.unwrap().unwrap();
        assert!(result.submitted);
        assert!(result.mutation_attempted);
        assert_eq!(*authorizations.lock().unwrap(), vec![false, true]);
        assert_eq!(expressions.lock().unwrap().len(), 5);
    }

    async fn codex_continuation_test_pending_deadline(after_commit: bool) {
        let mut evaluations = vec![Some(json!({"result": {"value": {"started": true}}}))];
        if after_commit {
            evaluations.extend([
                Some(json!({"result": {"value": {"status": "prepared"}}})),
                Some(json!({"result": {"value": {"started": true}}})),
            ]);
        }
        evaluations.push(Some(json!({"repeatPending": true})));
        if !after_commit {
            evaluations.extend([
                Some(json!({"result": {"value": {"started": true}}})),
                Some(json!({"result": {"value": {"status": "prepared"}}})),
                Some(json!({"result": {"value": {"started": true}}})),
                Some(json!({"result": {"value": {"status": "completed", "submitted": true, "mutationAttempted": true}}})),
            ]);
        }
        let (targets, port, expressions, server) =
            codex_continuation_test_targets_with_evaluations(evaluations).await;
        let authorizations = Mutex::new(Vec::new());
        let mut diagnostics = Vec::new();
        let result = tokio::time::timeout(
            Duration::from_secs(30),
            submit_codex_continuation_to_targets(
                targets,
                port,
                "start-exact-continuation",
                "\"isolated-recovery\"",
                &|final_commit| {
                    authorizations.lock().unwrap().push(final_commit);
                    true
                },
                &mut diagnostics,
            ),
        )
        .await;
        server.abort();
        let result = result.expect("preparation deadline must remain bounded");
        if after_commit {
            assert!(result
                .unwrap_err()
                .contains("no second submission was attempted"));
            assert!(diagnostics.is_empty());
        } else {
            let result = result
                .unwrap()
                .expect("next renderer must be tried after timeout");
            assert!(result.submitted);
            assert_eq!(result.target_id.as_deref(), Some("ready-renderer"));
            assert_eq!(diagnostics.len(), 1);
        }
        assert_eq!(*authorizations.lock().unwrap(), vec![false, true]);
        let expressions = expressions.lock().unwrap();
        assert_eq!(
            expressions
                .iter()
                .filter(|script| script.contains("cancelCodexContinuation"))
                .count(),
            usize::from(!after_commit)
        );
        assert_eq!(
            expressions
                .iter()
                .filter(|script| script.contains("commitCodexContinuation"))
                .count(),
            1
        );
        assert_eq!(
            expressions
                .iter()
                .filter(|script| *script == "start-exact-continuation")
                .count(),
            if after_commit { 1 } else { 2 }
        );
    }

    #[tokio::test]
    async fn codex_continuation_pending_preparation_is_cancelled_before_next_renderer() {
        codex_continuation_test_pending_deadline(false).await;
    }

    #[tokio::test]
    async fn codex_continuation_pending_commit_never_advances_after_deadline() {
        codex_continuation_test_pending_deadline(true).await;
    }

    #[tokio::test]
    async fn codex_continuation_requires_positive_refusal_or_complete_commit_acknowledgement() {
        for (acknowledgement, completion) in [
            (Value::Null, false),
            (json!({}), false),
            (json!({"started": "true"}), false),
            (json!({"status": "completed"}), true),
            (json!({"status": "completed", "submitted": false}), true),
        ] {
            let mut responses = vec![json!({"started": true}), json!({"status": "prepared"})];
            if completion {
                responses.push(json!({"started": true}));
            }
            responses.push(acknowledgement);
            let (targets, port, expressions, server) =
                codex_continuation_test_targets(responses).await;
            let authorizations = Mutex::new(Vec::new());
            let result = submit_codex_continuation_to_targets(
                targets,
                port,
                "start-exact-continuation",
                "\"isolated-recovery\"",
                &|final_commit| {
                    authorizations.lock().unwrap().push(final_commit);
                    true
                },
                &mut Vec::new(),
            )
            .await;
            server.abort();
            let error =
                result.expect_err("an incomplete acknowledgement cannot prove non-mutation");
            assert!(error.contains("result is uncertain"), "{error}");
            assert_eq!(*authorizations.lock().unwrap(), vec![false, true]);
            assert_eq!(
                expressions.lock().unwrap().len(),
                if completion { 4 } else { 3 }
            );
        }
        let (targets, port, expressions, server) = codex_continuation_test_targets(vec![
            json!({"started": true}),
            json!({"status": "prepared"}),
            json!({"started": false, "reason": "Continuation is not prepared"}),
        ])
        .await;
        let result = submit_codex_continuation_to_targets(
            targets,
            port,
            "start-exact-continuation",
            "\"isolated-recovery\"",
            &|_| true,
            &mut Vec::new(),
        )
        .await;
        server.abort();
        let refused = result.unwrap().unwrap();
        assert!(!refused.submitted);
        assert!(!refused.mutation_attempted);
        assert_eq!(refused.target_id.as_deref(), Some("unready-renderer"));
        assert_eq!(expressions.lock().unwrap().len(), 3);
    }

    #[test]
    fn codex_continuation_ignores_retained_rpc_stubs_before_the_real_client() {
        let result = run_codex_continuation_probe(
            r#"
let proxyPropertyReads = 0;
let starts = 0;
const proxy = new Proxy({}, { get() { proxyPropertyReads += 1; return () => { throw new Error("stale RPC stub must not be called"); }; } });
state.clients = [proxy, verifiedProbeClient({
  hostId: "local",
  getCompatibleThreadSortKey() {},
  supportsPaginatedThreadHistory() {},
  sendRequest: async (method) => {
    if (method === "turn/start") { starts += 1; return { turn: { id: "continue-turn" } }; }
    return { thread: { id: "exact-thread", turns: [{ id: "failed-turn", status: "failed" }] } };
  },
})];
void runCodexContinuation("exact-thread", "recovery-1", "request-model", Date.now()).then((result) => {
  globalThis.__codexContinuationResult = JSON.stringify({ result, starts, proxyPropertyReads });
});
"#,
        );
        assert_eq!(result["result"]["submitted"], true);
        assert_eq!(result["starts"], 1);
        assert_eq!(result["proxyPropertyReads"], 0);
    }

    #[test]
    fn codex_continuation_skips_remote_clients_and_times_out_stale_local_reads() {
        let result = run_codex_continuation_probe(
            r#"
let remoteCalls = 0;
let starts = 0;
let firstTimer = null;
globalThis.__continuationTimer = (callback) => { if (!firstTimer) firstTimer = callback; return 1; };
state.appServerClients = [
  { hostId: "remote", sendRequest: async () => { remoteCalls += 1; throw new Error("remote thread must not be used"); } },
  { sendRequest: () => new Promise(() => {}) },
  { sendRequest: async (method) => {
    if (method === "turn/start") { starts += 1; return { turn: { id: "continue-turn" } }; }
    return { thread: { id: "exact-thread", turns: [{ id: "failed-turn", status: "failed" }] } };
  } },
];
void runCodexContinuation("exact-thread", "recovery-1", "request-model", Date.now()).then((result) => {
  globalThis.__codexContinuationResult = JSON.stringify({ result, starts, remoteCalls });
});
void Promise.resolve().then(() => Promise.resolve()).then(() => { firstTimer(); });
"#,
        );
        assert_eq!(result["result"]["submitted"], true);
        assert_eq!(result["starts"], 1);
        assert_eq!(result["remoteCalls"], 0);
    }

    #[test]
    fn codex_continuation_refuses_unverified_original_marker_and_replaced_hook() {
        for replacement_after_preparation in [false, true] {
            let result = run_codex_continuation_probe(&format!(
                r#"
const replacementAfterPreparation = {replacement_after_preparation};
let starts = 0;
let reads = 0;
const request = async (method) => {{
  if (method === "turn/start") {{ starts += 1; return {{turn: {{id: "continued"}}}}; }}
  reads += 1;
  return {{thread: {{id: "exact-thread", model: "request-model", turns: [{{id: "failed-turn", status: "failed"}}]}}}};
}};
state.appServerClients = [{{sendRequest: request}}];
const client = state.appServerClients[0];
if (!replacementAfterPreparation) client.sendRequest = client.__ccSwitchOriginalSendRequest;
void (async () => {{
  state.startCodexContinuation("exact-thread", "recovery-1", "request-model", Date.now() - 1000);
  for (let n = 0; n < 256; n += 1) {{
    const job = state.readCodexContinuationJob("recovery-1");
    if (job?.status === "prepared") {{
      client.sendRequest = client.__ccSwitchOriginalSendRequest;
      state.commitCodexContinuation("recovery-1");
    }}
    if (job?.status === "completed") {{
      globalThis.__codexContinuationResult = JSON.stringify({{job, starts, reads, hookVerified: state.isCodexContinuationRequestClient(client), markers: readCodexContinuationMarkers()}});
      return;
    }}
    await Promise.resolve();
  }}
  throw new Error("The replaced-hook continuation did not finish");
}})();
"#
            ));
            assert_eq!(result["job"]["submitted"], false);
            assert_eq!(result["job"]["mutationAttempted"], false);
            assert_eq!(result["starts"], 0);
            assert_eq!(
                result["reads"],
                if replacement_after_preparation { 2 } else { 0 }
            );
            assert_eq!(result["hookVerified"], false);
            assert_eq!(result["markers"], json!({}));
        }
    }

    #[test]
    fn codex_continuation_refuses_user_cancellation_completed_turns_and_changed_models() {
        let result = run_codex_continuation_probe(
            r#"
const thread = (turn, extra = {}) => ({ id: "exact-thread", turns: [{ id: "older-failure", status: "failed" }, { id: "latest-turn", ...turn }], ...extra });
const cases = [
  thread({ status: "completed" }),
  thread({ status: "inProgress" }),
  thread({ status: "interrupted" }),
  thread({ status: "failed", error: { codexErrorInfo: "turnAborted" } }),
  thread({ status: "failed", error: { message: "User cancelled the turn" } }),
  thread({ status: "failed" }, { model: "new-user-model" }),
  thread({ status: "failed", error: { message: "Authentication failed" } }),
  thread({ status: "failed", error: { message: "server overloaded" } }),
  thread({ status: "interrupted", error: { message: "unexpected transport EOF" } }),
];
globalThis.__codexContinuationResult = JSON.stringify(cases.map((value) => classifyCodexContinuationThread(value, "exact-thread", "request-model").ready));
"#,
        );
        assert_eq!(
            result,
            json!([false, false, false, false, false, false, false, true, true])
        );
    }

    #[test]
    fn codex_continuation_rechecks_for_a_newer_turn_before_submitting() {
        let result = run_codex_continuation_probe(
            r#"
let reads = 0;
let starts = 0;
state.appServerClients = [{ sendRequest: async (method) => {
  if (method === "turn/start") { starts += 1; return { turn: { id: "continued" } }; }
  reads += 1;
  return { thread: { id: "exact-thread", turns: [{ id: reads === 1 ? "failed-turn" : "new-user-turn", status: reads === 1 ? "failed" : "inProgress" }] } };
} }];
void runCodexContinuation("exact-thread", "recovery-1", "request-model", Date.now()).then((result) => {
  globalThis.__codexContinuationResult = JSON.stringify({ result, reads, starts });
});
"#,
        );
        assert_eq!(result["result"]["submitted"], false);
        assert_eq!(result["reads"], 2);
        assert_eq!(result["starts"], 0);
    }

    #[test]
    fn codex_continuation_does_not_replay_an_ambiguous_submission_on_another_client_or_retry() {
        let result = run_codex_continuation_probe(
            r#"
let starts = 0;
let secondClientCalls = 0;
const failed = { id: "exact-thread", turns: [{ id: "failed-turn", status: "failed" }] };
state.appServerClients = [
  { sendRequest: async (method) => {
    if (method === "thread/read") return { thread: failed };
    starts += 1;
    throw new Error("connection closed after request was sent");
  } },
  { sendRequest: async () => { secondClientCalls += 1; return { thread: failed }; } },
];
void (async () => {
  const first = await runCodexContinuation("exact-thread", "recovery-1", "request-model", Date.now());
  const retry = await runCodexContinuation("exact-thread", "recovery-2", "request-model", Date.now());
  globalThis.__codexContinuationResult = JSON.stringify({ first, retry, starts, secondClientCalls, markers: readCodexContinuationMarkers() });
})();
"#,
        );
        assert_eq!(result["first"]["submitted"], false);
        assert_eq!(result["first"]["mutationAttempted"], true);
        assert_eq!(result["retry"]["submitted"], false);
        assert_eq!(result["retry"]["mutationAttempted"], true);
        assert_eq!(result["starts"], 1);
        assert_eq!(result["secondClientCalls"], 0);
        assert_eq!(
            result["markers"]["exact-thread:failed-turn"]["status"],
            "attempted"
        );
    }

    #[test]
    fn codex_continuation_recovery_id_cannot_be_rebound_to_another_thread() {
        let result = run_codex_continuation_probe(
            r#"
state.codexContinuationJobs["recovery-1"] = { status: "pending", threadId: "exact-thread" };
globalThis.__codexContinuationResult = JSON.stringify(state.startCodexContinuation("other-thread", "recovery-1", "request-model", Date.now()));
"#,
        );
        assert_eq!(result["started"], false);
        assert_eq!(
            result["reason"],
            "The recovery id belongs to a different Codex thread"
        );
    }

    #[test]
    fn codex_continuation_recovery_id_cannot_be_rebound_to_another_request() {
        let result = run_codex_continuation_probe(
            r#"
state.codexContinuationJobs["recovery-1"] = { status: "pending", threadId: "exact-thread", expectedModel: "old-model", observedAtMs: 1000 };
globalThis.__codexContinuationResult = JSON.stringify(state.startCodexContinuation("exact-thread", "recovery-1", "new-model", 2000));
"#,
        );
        assert_eq!(result["started"], false);
        assert_eq!(
            result["reason"],
            "The recovery id belongs to a different interrupted request"
        );
    }

    #[test]
    fn codex_continuation_refuses_a_newer_user_turn_even_when_it_has_already_failed() {
        let result = run_codex_continuation_probe(
            r#"
const observedAtMs = Date.now() - 1000;
let calls = 0;
state.appServerClients = [{ sendRequest: async () => {
  calls += 1;
  return { thread: { id: "exact-thread", turns: [{ id: "newer-failed-turn", status: "failed" }] } };
} }];
rememberCodexUserTurnAction("send-cli-request-for-host", { method: "turn/start", params: { threadId: "exact-thread" } });
// The persisted action still protects recovery after compatibility reinjection.
state.codexUserTurnActions = {};
void runCodexContinuation("exact-thread", "recovery-1", "request-model", observedAtMs).then((result) => {
  globalThis.__codexContinuationResult = JSON.stringify({ result, calls });
});
"#,
        );
        assert_eq!(result["result"]["submitted"], false);
        assert_eq!(result["calls"], 0);
    }

    #[test]
    fn codex_continuation_refuses_a_user_stop_while_its_thread_read_is_pending() {
        let result = run_codex_continuation_probe(
            r#"
const observedAtMs = Date.now() - 1000;
let reads = 0;
let starts = 0;
state.appServerClients = [{ sendRequest: async (method) => {
  if (method === "turn/start") { starts += 1; return { turn: { id: "continued" } }; }
  reads += 1;
  if (reads === 2) rememberCodexUserTurnAction("turn/interrupt", { threadId: "exact-thread", turnId: "failed-turn" });
  return { thread: { id: "exact-thread", turns: [{ id: "failed-turn", status: "failed" }] } };
} }];
void runCodexContinuation("exact-thread", "recovery-1", "request-model", observedAtMs).then((result) => {
  globalThis.__codexContinuationResult = JSON.stringify({ result, reads, starts });
});
"#,
        );
        assert_eq!(result["result"]["submitted"], false);
        assert_eq!(result["reads"], 2);
        assert_eq!(result["starts"], 0);
    }

    #[test]
    fn history_lineage_hydration_repairs_only_idle_conversations_with_a_changed_rollout_path() {
        let result = run_history_lineage_hydration_probe(
            r#"
const conversations = [
  {id: "idle-stale", rolloutPath: "root.jsonl", turns: []},
  {id: "running-stale", rolloutPath: "root.jsonl", turns: [{status: "inProgress"}]},
  {id: "current", rolloutPath: "active.jsonl", turns: []},
];
const manager = {
  getCachedConversations: () => conversations,
  isConversationStreaming: (id) => id === "running-stale",
  threadStore: {threadsById: new Map([
    ["idle-stale", {path: "branch.jsonl"}],
    ["running-stale", {path: "branch.jsonl"}],
    ["current", {path: "active.jsonl"}],
  ])},
};
JSON.stringify(planHistoryLineageRehydration(manager));
"#,
        );

        assert_eq!(result["repair"], json!(["idle-stale"]));
        assert_eq!(result["deferred"], json!(["running-stale"]));
    }

    #[test]
    fn history_lineage_hydration_repairs_fragmented_canonical_history_without_path_drift() {
        let result = run_history_lineage_hydration_probe(
            r#"
const fragmentedHistory = {
  kind: "canonical",
  history: {
    isComplete: false,
    islands: [
      {id: "old", entries: []},
      {id: "tail", entries: []},
    ],
    entitiesByKey: {},
  },
};
const normalTail = {
  kind: "canonical",
  history: {
    isComplete: false,
    islands: [{id: "tail", entries: []}],
    entitiesByKey: {},
  },
};
const activeFragmentedHistory = {
  kind: "canonical",
  history: {
    isComplete: false,
    islands: [{id: "old", entries: []}, {id: "tail", entries: []}],
    entitiesByKey: {running: {status: "inProgress"}},
  },
};
const conversations = [
  {id: "fragmented", rolloutPath: "active.jsonl", turns: [], turnHistory: fragmentedHistory},
  {id: "normal-tail", rolloutPath: "active.jsonl", turns: [], turnHistory: normalTail},
  {id: "active-fragmented", rolloutPath: "active.jsonl", turns: [], turnHistory: activeFragmentedHistory},
];
const manager = {
  getCachedConversations: () => conversations,
  isConversationStreaming: () => false,
  threadStore: {threadsById: new Map([
    ["fragmented", {path: "active.jsonl"}],
    ["normal-tail", {path: "active.jsonl"}],
    ["active-fragmented", {path: "active.jsonl"}],
  ])},
};
JSON.stringify(planHistoryLineageRehydration(manager));
"#,
        );

        assert_eq!(result["repair"], json!(["fragmented"]));
        assert_eq!(result["deferred"], json!(["active-fragmented"]));
    }

    #[test]
    fn history_lineage_hydration_discards_canonical_cache_and_loads_complete_history() {
        let result = run_async_history_lineage_hydration_probe(
            r#"
let conversation = {
  id: "fragmented",
  cwd: "C:/workspace",
  rolloutPath: "active.jsonl",
  turns: [{status: "completed", id: "legacy-overlay"}],
  turnHistory: {
    kind: "canonical",
    history: {
      isComplete: false,
      islands: [{id: "old", entries: []}, {id: "tail", entries: []}],
      entitiesByKey: {},
    },
  },
  resumeState: "resumed",
};
let turnHistoryPresentDuringResume = null;
let completeHistoryLoads = 0;
const manager = {
  getCachedConversations: () => [conversation],
  getConversation: () => conversation,
  isConversationStreaming: () => false,
  updateConversationState: (_id, update) => {
    const next = JSON.parse(JSON.stringify(conversation));
    update(next);
    conversation = next;
  },
  setConversation: (value) => { conversation = value; },
  resumeConversationForUnavailableOwner: async () => {
    turnHistoryPresentDuringResume = conversation.turnHistory != null;
    conversation.resumeState = "resumed";
    return {status: "ready"};
  },
  getCompleteConversationTurns: async () => { completeHistoryLoads += 1; return []; },
  threadStore: {threadsById: new Map([["fragmented", {path: "active.jsonl"}]])},
};
rehydrateStaleHistoryLineages(manager).then((outcome) => {
  globalThis.__historyLineageResult = JSON.stringify({
    outcome,
    turnHistoryPresentDuringResume,
    completeHistoryLoads,
  });
});
"#,
        );

        assert_eq!(result["outcome"]["repaired"], json!(["fragmented"]));
        assert_eq!(result["turnHistoryPresentDuringResume"], false);
        assert_eq!(result["completeHistoryLoads"], 1);
    }

    #[test]
    fn history_lineage_hydration_uses_codex_resume_without_evicting_the_conversation() {
        let result = run_async_history_lineage_hydration_probe(
            r#"
let conversation = {
  id: "idle-stale",
  cwd: "C:/workspace",
  rolloutPath: "root.jsonl",
  turns: [{status: "completed"}],
  latestCollaborationMode: {mode: "default"},
  resumeState: "resumed",
};
let resumeParams = null;
let evictionCalled = false;
const manager = {
  getCachedConversations: () => [conversation],
  getConversation: () => conversation,
  isConversationStreaming: () => false,
  updateConversationState: (_id, update) => {
    const next = JSON.parse(JSON.stringify(conversation));
    update(next);
    conversation = next;
  },
  setConversation: (value) => { conversation = value; },
  resumeConversationForUnavailableOwner: async (params) => { resumeParams = params; },
  threadStore: {
    threadsById: new Map([["idle-stale", {path: "branch.jsonl"}]]),
    removeConversationFromCache: () => { evictionCalled = true; },
  },
};
rehydrateStaleHistoryLineages(manager).then((outcome) => {
  globalThis.__historyLineageResult = JSON.stringify({
    outcome,
    conversation,
    resumeParams,
    evictionCalled,
  });
});
"#,
        );

        assert_eq!(result["outcome"]["repaired"], json!(["idle-stale"]));
        assert_eq!(result["conversation"]["rolloutPath"], "branch.jsonl");
        assert_eq!(result["conversation"]["turns"], json!([]));
        assert_eq!(result["conversation"]["resumeState"], "needs_resume");
        assert_eq!(
            result["resumeParams"]["workspaceRoots"],
            json!(["C:/workspace"])
        );
        assert_eq!(result["evictionCalled"], false);
    }

    #[test]
    fn history_lineage_hydration_restores_the_cached_transcript_when_resume_fails() {
        let result = run_async_history_lineage_hydration_probe(
            r#"
let conversation = {
  id: "idle-stale",
  cwd: "C:/workspace",
  rolloutPath: "root.jsonl",
  turns: [{status: "completed", id: "old-turn"}],
  latestCollaborationMode: {mode: "default"},
  resumeState: "resumed",
};
const manager = {
  getCachedConversations: () => [conversation],
  getConversation: () => conversation,
  isConversationStreaming: () => false,
  updateConversationState: (_id, update) => {
    const next = JSON.parse(JSON.stringify(conversation));
    update(next);
    conversation = next;
  },
  setConversation: (value) => { conversation = value; },
  resumeConversationForUnavailableOwner: async () => { throw new Error("resume failed"); },
  threadStore: {threadsById: new Map([["idle-stale", {path: "branch.jsonl"}]])},
};
rehydrateStaleHistoryLineages(manager).then((outcome) => {
  globalThis.__historyLineageResult = JSON.stringify({outcome, conversation});
});
"#,
        );

        assert_eq!(result["outcome"]["repaired"], json!([]));
        assert_eq!(result["outcome"]["failed"][0]["id"], "idle-stale");
        assert_eq!(result["conversation"]["rolloutPath"], "root.jsonl");
        assert_eq!(
            result["conversation"]["turns"],
            json!([{ "status": "completed", "id": "old-turn" }])
        );
        assert_eq!(result["conversation"]["resumeState"], "resumed");
    }

    #[test]
    fn codex_app_request_normalization_routes_resumed_threads_through_active_provider() {
        let result = run_app_server_request_normalization_probe_with_payload(
            json!({ "modelProvider": "codex_model_router_v2" }),
            r#"
const directOriginal = { threadId: "thread-1", model: "gpt-5.6-sol", modelProvider: "openai" };
const wrappedOriginal = {
  method: "thread/resume",
  params: { threadId: "thread-2", model: "qwen3.8", modelProvider: "openai" },
  hostId: "local",
};
const unrelatedOriginal = { threadId: "thread-3", modelProvider: "openai" };
const direct = normalizeAppServerRequestParams("thread/resume", directOriginal);
const wrapped = normalizeAppServerRequestParams("send-cli-request-for-host", wrappedOriginal);
const unrelated = normalizeAppServerRequestParams("thread/read", unrelatedOriginal);
JSON.stringify({
  direct,
  wrapped,
  unrelated,
  directOriginal,
  wrappedOriginal,
  unrelatedIdentityPreserved: unrelated === unrelatedOriginal,
});
"#,
        );

        assert_eq!(
            result["direct"],
            json!({
                "threadId": "thread-1",
                "model": "gpt-5.6-sol",
                "modelProvider": "codex_model_router_v2"
            })
        );
        assert_eq!(
            result["wrapped"],
            json!({
                "method": "thread/resume",
                "params": {
                    "threadId": "thread-2",
                    "model": "qwen3.8",
                    "modelProvider": "codex_model_router_v2"
                },
                "hostId": "local"
            })
        );
        assert_eq!(
            result["unrelated"],
            json!({
                "threadId": "thread-3",
                "modelProvider": "openai"
            })
        );
        assert_eq!(result["directOriginal"]["modelProvider"], "openai");
        assert_eq!(
            result["wrappedOriginal"]["params"]["modelProvider"],
            "openai"
        );
        assert_eq!(result["unrelatedIdentityPreserved"], true);
    }

    #[test]
    fn codex_app_request_normalization_does_not_invent_a_resume_provider() {
        let result = run_app_server_request_normalization_probe_with_payload(
            json!({ "modelProvider": null }),
            r#"
const directOriginal = { threadId: "thread-1", modelProvider: "openai" };
const direct = normalizeAppServerRequestParams("thread/resume", directOriginal);
const list = normalizeAppServerRequestParams("thread/list", { modelProviders: null, limit: 20 });
const wrappedList = normalizeAppServerRequestParams("send-cli-request-for-host", {
  method: "thread/list",
  params: { modelProviders: null, limit: 50 },
});
JSON.stringify({
  direct,
  directIdentityPreserved: direct === directOriginal,
  list,
  wrappedList,
});
"#,
        );

        assert_eq!(
            result["direct"],
            json!({
                "threadId": "thread-1",
                "modelProvider": "openai"
            })
        );
        assert_eq!(result["directIdentityPreserved"], true);
        assert_eq!(result["list"], json!({ "modelProviders": [], "limit": 20 }));
        assert_eq!(
            result["wrappedList"],
            json!({
                "method": "thread/list",
                "params": { "modelProviders": [], "limit": 50 }
            })
        );
    }

    #[test]
    fn codex_app_request_normalization_replaces_the_previous_request_wrapper() {
        let result = run_app_server_request_normalization_probe_with_payload(
            json!({ "modelProvider": "codex_model_router_v2" }),
            r#"
JSON.stringify({
  v5NeedsPatch: appServerRequestClientNeedsPatch({ __ccSwitchModelRequestPatch: "5" }),
  v6NeedsPatch: appServerRequestClientNeedsPatch({ __ccSwitchModelRequestPatch: "6" }),
  v7NeedsPatch: appServerRequestClientNeedsPatch({ __ccSwitchModelRequestPatch: "7" }),
  v8NeedsPatch: appServerRequestClientNeedsPatch({ __ccSwitchModelRequestPatch: "8" }),
  v12NeedsPatch: appServerRequestClientNeedsPatch({ __ccSwitchModelRequestPatch: "12" }),
  currentNeedsPatch: appServerRequestClientNeedsPatch({ __ccSwitchModelRequestPatch: "13" }),
  standaloneNeedsPatch: appServerRequestClientNeedsPatch({ __ccSwitchModelRequestPatch: "standalone" }),
  missingNeedsPatch: appServerRequestClientNeedsPatch({}),
  patchVersion: appServerRequestPatchVersion,
});
"#,
        );

        assert_eq!(result["v5NeedsPatch"], true);
        assert_eq!(result["v6NeedsPatch"], true);
        assert_eq!(result["v7NeedsPatch"], true);
        assert_eq!(result["v8NeedsPatch"], true);
        assert_eq!(result["v12NeedsPatch"], true);
        assert_eq!(result["currentNeedsPatch"], true);
        assert_eq!(result["standaloneNeedsPatch"], false);
        assert_eq!(result["missingNeedsPatch"], true);
        assert_eq!(result["patchVersion"], "standalone");
    }

    #[test]
    fn guardian_v2_compatibility_downgrades_only_the_rejected_request_override() {
        let result = run_guardian_v2_compatibility_probe(
            r#"
const direct = {
  threadId: "thread-1",
  config: {
    "features.guardianv2": { enabled: true, future_field: "unsupported" },
    "features.memories": true,
  },
};
const wrapped = {
  method: "thread/resume",
  params: {
    threadId: "thread-2",
    config: { features: { guardianv2: { enabled: false, future_field: 1 }, goals: true } },
  },
};
const directFallback = guardianV2FallbackRequestParams("thread/resume", direct);
const wrappedFallback = guardianV2FallbackRequestParams("send-cli-request-for-host", wrapped);
JSON.stringify({
  directValue: directFallback.config["features.guardianv2"],
  directMemories: directFallback.config["features.memories"],
  directOriginalStillObject: typeof direct.config["features.guardianv2"] === "object",
  wrappedValue: wrappedFallback.params.config.features.guardianv2,
  wrappedGoals: wrappedFallback.params.config.features.goals,
  wrappedOriginalStillObject: typeof wrapped.params.config.features.guardianv2 === "object",
  unrelatedIdentityPreserved: guardianV2FallbackRequestParams("thread/resume", {config: {"features.memories": true}}).config["features.memories"],
});
"#,
        );

        assert_eq!(result["directValue"], true);
        assert_eq!(result["directMemories"], true);
        assert_eq!(result["directOriginalStillObject"], true);
        assert_eq!(result["wrappedValue"], false);
        assert_eq!(result["wrappedGoals"], true);
        assert_eq!(result["wrappedOriginalStillObject"], true);
        assert_eq!(result["unrelatedIdentityPreserved"], true);
    }

    #[test]
    fn guardian_v2_compatibility_retries_only_the_exact_feature_schema_failure() {
        let result = run_guardian_v2_compatibility_probe(
            r#"
JSON.stringify({
  exact: isGuardianV2FeatureTomlError({message: "failed to load configuration: data did not match any variant of untagged enum FeatureToml\nin `features.guardianv2`"}),
  otherFeature: isGuardianV2FeatureTomlError({message: "FeatureToml in `features.memories`"}),
  network: isGuardianV2FeatureTomlError({message: "connection reset"}),
});
"#,
        );

        assert_eq!(result["exact"], true);
        assert_eq!(result["otherFeature"], false);
        assert_eq!(result["network"], false);
    }

    #[test]
    fn guardian_v2_statsig_config_removes_only_the_legacy_model_whitelist_pollution() {
        let result = run_guardian_v2_compatibility_probe(
            r#"
const source = {value: {
  enabled: true,
  mode: "future",
  nested: {unknown: true},
  available_models: ["qwen3.8"],
  use_hidden_models: false,
  default_model: "qwen3.8",
}};
const patched = patchGuardianV2DynamicConfig("2553103476", source);
const unrelated = {value: {enabled: true, mode: "keep"}};
JSON.stringify({
  patchedValue: patched.value,
  sourceValue: source.value,
  unrelatedIdentity: patchGuardianV2DynamicConfig("other", unrelated) === unrelated,
});
"#,
        );

        assert_eq!(
            result["patchedValue"],
            json!({ "enabled": true, "mode": "future", "nested": { "unknown": true } })
        );
        assert_eq!(
            result["sourceValue"],
            json!({
                "enabled": true,
                "mode": "future",
                "nested": { "unknown": true },
                "available_models": ["qwen3.8"],
                "use_hidden_models": false,
                "default_model": "qwen3.8"
            })
        );
        assert_eq!(result["unrelatedIdentity"], true);
    }

    #[test]
    fn statsig_model_whitelist_fields_are_scoped_to_their_own_dynamic_config() {
        let result = run_guardian_v2_compatibility_probe(
            r#"
const model = {value: {available_models: []}};
const unrelated = {value: {enabled: true}};
const legacy = {value: {enabled: true, available_models: ["qwen3.8"], default_model: "qwen3.8", use_hidden_models: false}};
const modelPrepared = prepareStatsigDynamicConfig("107580212", model, false);
const unrelatedPrepared = prepareStatsigDynamicConfig("unrelated", unrelated, false);
const repairedPrepared = prepareStatsigDynamicConfig("unrelated", legacy, true);
JSON.stringify({
  modelPatch: modelPrepared.patchModelWhitelist,
  unrelatedPatch: unrelatedPrepared.patchModelWhitelist,
  unrelatedIdentity: unrelatedPrepared.config === unrelated,
  repairedPatch: repairedPrepared.patchModelWhitelist,
  repairedValue: repairedPrepared.config.value,
  legacyOriginalKeys: Object.keys(legacy.value).sort(),
});
"#,
        );
        assert_eq!(result["modelPatch"], true);
        assert_eq!(result["unrelatedPatch"], false);
        assert_eq!(result["unrelatedIdentity"], true);
        assert_eq!(result["repairedPatch"], false);
        assert_eq!(result["repairedValue"], json!({ "enabled": true }));
        assert_eq!(
            result["legacyOriginalKeys"],
            json!([
                "available_models",
                "default_model",
                "enabled",
                "use_hidden_models"
            ])
        );

        let script = build_model_picker_unlock_script(&CodexModelCatalogProjection::empty());

        assert!(script.contains("const prepared = prepareStatsigDynamicConfig"));
        assert!(
            script.contains("client.__ccSwitchStatsigPatchVersion !== rendererRuntimeFingerprint")
        );
        assert!(script.contains("client.__ccSwitchModelWhitelistPatched === true"));
    }

    #[test]
    fn model_picker_fallback_descriptor_does_not_invent_reasoning_capability() {
        let result = run_model_picker_patch_core_probe_with_payload(
            json!({
                "defaultModel": "unknown-third-party",
                "modelNames": ["unknown-third-party"],
                "models": []
            }),
            r#"
const descriptor = descriptorFor("unknown-third-party");
JSON.stringify({
  hasDefault: Object.prototype.hasOwnProperty.call(descriptor, "defaultReasoningEffort"),
  hasEfforts: Object.prototype.hasOwnProperty.call(descriptor, "supportedReasoningEfforts"),
  efforts: descriptor.supportedReasoningEfforts,
});
"#,
        );

        assert_eq!(result["hasDefault"], false);
        // Codex's native model select reads supportedReasoningEfforts unguarded,
        // so managed rows must expose the canonical empty array. No effort level
        // is invented: the descriptor still advertises no reasoning capability.
        assert_eq!(result["hasEfforts"], true);
        assert_eq!(result["efforts"], json!([]));
    }

    #[test]
    fn model_picker_clears_stale_effort_defaults_when_provider_advertises_no_levels() {
        let result = run_model_picker_patch_core_probe_with_payload(
            json!({
                "defaultModel": "xiaomi/mimo-v2.6-flash",
                "modelNames": [
                    "xiaomi/mimo-v2.6-flash",
                    "xiaomi/mimo-v2.6-pro"
                ],
                "models": [
                    {
                        "model": "xiaomi/mimo-v2.6-flash",
                        "defaultReasoningEffort": "medium"
                    },
                    {"model": "xiaomi/mimo-v2.6-pro"}
                ]
            }),
            r#"
const models = [];
patchModelArray(models, true);
JSON.stringify(models.map((model) => ({
  model: model.model,
  hasDefault: Object.prototype.hasOwnProperty.call(model, "defaultReasoningEffort"),
  hasEfforts: Object.prototype.hasOwnProperty.call(model, "supportedReasoningEfforts"),
  efforts: model.supportedReasoningEfforts,
})));
"#,
        );

        assert_eq!(
            result,
            json!([
                {
                    "model": "xiaomi/mimo-v2.6-flash",
                    "hasDefault": false,
                    "hasEfforts": true,
                    "efforts": []
                },
                {
                    "model": "xiaomi/mimo-v2.6-pro",
                    "hasDefault": false,
                    "hasEfforts": true,
                    "efforts": []
                }
            ])
        );
    }

    #[test]
    fn model_picker_matches_renderer_rows_by_canonical_slug_and_alias() {
        let result = run_model_picker_patch_core_probe_with_payload(
            json!({
                "defaultModel": "gpt-6.1-sol-relay",
                "modelNames": ["gpt-6.1-sol-relay"],
                "models": [{
                    "model": "gpt-6.1-sol-relay",
                    "id": "openai/gpt-6.1-sol",
                    "canonicalSlug": "openai/gpt-6.1-sol-20260929",
                    "aliases": ["gpt-6.1-sol-openrouter"],
                    "supportedReasoningEfforts": [{"reasoningEffort": "high"}],
                    "defaultReasoningEffort": "high"
                }]
            }),
            r#"
const models = [{id: "openai/gpt-6.1-sol-20260929", displayName: "GPT 6.1 Sol"}];
patchModelArray(models);
JSON.stringify({
  model: models[0].model,
  id: models[0].id,
  canonicalSlug: models[0].canonicalSlug,
  aliases: models[0].aliases,
  efforts: models[0].supportedReasoningEfforts.map((item) => item.reasoningEffort),
});
"#,
        );

        assert_eq!(result["model"], "gpt-6.1-sol-relay");
        assert_eq!(result["id"], "openai/gpt-6.1-sol");
        assert_eq!(result["canonicalSlug"], "openai/gpt-6.1-sol-20260929");
        assert_eq!(result["aliases"], json!(["gpt-6.1-sol-openrouter"]));
        assert_eq!(result["efforts"], json!(["high"]));
    }

    #[test]
    fn model_picker_normalizes_reasoning_aliases_and_deduplicates_levels() {
        let result = run_model_picker_patch_core_probe_with_payload(
            json!({
                "defaultModel": "mixed-reasoning-aliases",
                "modelNames": ["mixed-reasoning-aliases"],
                "models": [{
                    "model": "mixed-reasoning-aliases",
                    "default_reasoning_level": "unsupported",
                    "supportedReasoningLevels": [
                        {"effort": "low"},
                        {"effort": "low", "description": "duplicate"},
                        {"reasoning_effort": "high"}
                    ]
                }]
            }),
            r#"
const models = [];
patchModelArray(models, true);
JSON.stringify({
  defaultEffort: models[0].defaultReasoningEffort,
  efforts: models[0].supportedReasoningEfforts,
  levels: models[0].supportedReasoningLevels,
});
"#,
        );

        assert_eq!(result["defaultEffort"], "low");
        assert_eq!(
            result["efforts"],
            json!([
                {"reasoningEffort": "low", "description": "low"},
                {"reasoningEffort": "high", "description": "high"}
            ])
        );
        assert_eq!(
            result["levels"],
            json!([
                {"effort": "low", "description": "low"},
                {"effort": "high", "description": "high"}
            ])
        );
    }

    #[test]
    fn model_picker_restores_catalog_efforts_after_renderer_preference_filters() {
        let result = run_model_picker_patch_core_probe_with_payload(
            json!({
                "modelProvider": "codex_model_router_v2",
                "modelNames": ["sol-relay", "luna-relay", "plain-relay"],
                "models": [
                    {
                        "model": "sol-relay",
                        "defaultReasoningEffort": "high",
                        "supported_reasoning_levels": ["low", "medium", "high", "xhigh", "max", "ultra"]
                    },
                    {
                        "model": "luna-relay",
                        "supportedReasoningEfforts": [
                            {"reasoningEffort": "low"}, {"reasoningEffort": "medium"},
                            {"reasoningEffort": "high"}, {"reasoningEffort": "xhigh"},
                            {"reasoningEffort": "max"}
                        ]
                    },
                    {"model": "plain-relay"}
                ]
            }),
            r#"
const key = ["models", "list", "local", "chatgpt", 100, "codex_model_router_v2", "catalog.json"];
const levels = ["low", "medium", "high", "xhigh"];
const official = {model: "official", supportedReasoningEfforts: [{reasoningEffort: "high"}]};
const filtered = {
  models: [
    {model: "sol-relay", defaultReasoningEffort: "high", supportedReasoningEfforts: levels.map(reasoningEffort => ({reasoningEffort}))},
    {model: "luna-relay", supportedReasoningEfforts: levels.map(reasoningEffort => ({reasoningEffort}))},
    {model: "plain-relay", defaultReasoningEffort: "high", supportedReasoningEfforts: [{reasoningEffort: "high"}]},
    official,
  ],
  hasModelSupportingMaxReasoningEffort: false,
  hasModelSupportingUltraReasoningEffort: false,
};
filtered.defaultModel = filtered.models[0];
const before = JSON.stringify(filtered);
const restored = restoreCodexCatalogReasoningSelection(key, filtered);
JSON.stringify({
  efforts: restored.models.map(model => model.supportedReasoningEfforts.map(level => level.reasoningEffort)),
  officialUnchanged: restored.models.includes(official),
  sourceUnchanged: JSON.stringify(filtered) === before,
  defaultIdentity: restored.defaultModel === restored.models[0],
  unknownHasDefault: "defaultReasoningEffort" in restored.models[2],
  max: restored.hasModelSupportingMaxReasoningEffort,
  ultra: restored.hasModelSupportingUltraReasoningEffort,
});
"#,
        );
        assert_eq!(
            result["efforts"],
            json!([
                ["low", "medium", "high", "xhigh", "max", "ultra"],
                ["low", "medium", "high", "xhigh", "max"],
                []
            ])
        );
        assert_eq!(result["officialUnchanged"], false);
        assert_eq!(result["sourceUnchanged"], true);
        assert_eq!(result["defaultIdentity"], true);
        assert_eq!(result["unknownHasDefault"], false);
        assert_eq!(result["max"], true);
        assert_eq!(result["ultra"], true);
    }

    #[test]
    fn model_picker_post_filter_projection_is_scoped_and_never_adds_models() {
        let result = run_model_picker_patch_core_probe_with_payload(
            json!({
                "modelProvider": "codex_model_router_v2",
                "modelNames": ["relay", "excluded"],
                "models": [
                    {"model": "relay", "supported_reasoning_levels": ["high", "max", "ultra"]},
                    {"model": "excluded", "enabled": false, "supported_reasoning_levels": ["ultra"]}
                ]
            }),
            r#"
const key = ["models", "list", "local", "chatgpt", 100, "codex_model_router_v2"];
const excluded = {model: "excluded", supportedReasoningEfforts: []};
const filtered = {models: [{model: "relay", supportedReasoningEfforts: []}, excluded]};
const remote = key.map((value) => value === "local" ? "remote" : value);
const otherProvider = key.map((value) => value === "codex_model_router_v2" ? "openai" : value);
const copilot = key.map((value) => value === "chatgpt" ? "copilot" : value);
const result = restoreCodexCatalogReasoningSelection(key, filtered);
JSON.stringify({
  remoteUnchanged: restoreCodexCatalogReasoningSelection(remote, filtered) === filtered,
  providerUnchanged: restoreCodexCatalogReasoningSelection(otherProvider, filtered) === filtered,
  authUnchanged: restoreCodexCatalogReasoningSelection(copilot, filtered) === filtered,
  otherQueryUnchanged: restoreCodexCatalogReasoningSelection(["threads", "list", ...key], filtered) === filtered,
  rawUnchanged: restoreCodexCatalogReasoningSelection(key, {data: filtered.models}).data === filtered.models,
  excludedAbsent: !result.models.includes(excluded),
  absentNotAdded: restoreCodexCatalogReasoningSelection(key, {models: []}).models.length,
  nullUnchanged: restoreCodexCatalogReasoningSelection(key, null) === null,
});
"#,
        );
        assert_eq!(
            result,
            json!({
                "remoteUnchanged": true, "providerUnchanged": true, "authUnchanged": true,
                "otherQueryUnchanged": true,
                "rawUnchanged": true, "excludedAbsent": true, "absentNotAdded": 0,
                "nullUnchanged": true
            })
        );
    }

    #[test]
    fn model_list_projection_replaces_native_rows_with_enabled_catalog_models() {
        let result = run_model_picker_patch_core_probe_with_payload(
            json!({
                "modelProvider": "codex_model_router_v2",
                "modelNames": ["included"],
                "models": [{"model": "included", "enabled": true}]
            }),
            r#"
const models = [
  {model: "provider-fetched-but-not-included"},
  {model: "included"},
];
patchModelArray(models, true, true);
JSON.stringify(models.map((model) => model.model));
"#,
        );
        assert_eq!(result, json!(["included"]));
    }

    #[test]
    fn model_picker_query_observers_reproject_cached_and_future_filtered_results() {
        let result = run_model_picker_patch_core_probe_with_payload(
            json!({
                "modelProvider": "codex_model_router_v2",
                "modelNames": ["relay"],
                "models": [{"model": "relay", "supported_reasoning_levels": ["high", "max", "ultra"]}]
            }),
            r#"
const key = ["models", "list", "local", "chatgpt", 100, "codex_model_router_v2"];
const data = {data: [{model: "relay", supportedReasoningEfforts: ["high", "max", "ultra"].map(reasoningEffort => ({reasoningEffort}))}]};
const filter = (raw) => ({models: raw.data.map(model => ({
  ...model, supportedReasoningEfforts: model.supportedReasoningEfforts.filter(level => level.reasoningEffort === "high"),
}))});
let notify = () => {};
let subscriptions = 0;
let optionUpdates = 0;
const observer = {
  options: {queryKey: key, select: filter},
  setOptions(options) {
    optionUpdates += 1;
    this.options = options;
    this.result = options.select(data);
    notify({type: "observerOptionsUpdated", query, observer: this});
  },
};
const query = {queryKey: key, observers: [observer]};
const cache = {getAll: () => [query], subscribe(callback) {subscriptions += 1; notify = callback; return () => {};}};
const efforts = () => observer.result.models[0].supportedReasoningEfforts.map(level => level.reasoningEffort);
patchCodexModelReasoningQueryCache(cache);
const cached = efforts();
const firstUpdates = optionUpdates;
patchCodexModelReasoningQueryCache(cache);
const idempotent = optionUpdates === firstUpdates;
observer.setOptions({queryKey: key, select: raw => filter(raw)});
const replacedSelector = efforts();
state.payload = {...state.payload, models: [{model: "relay", supported_reasoning_levels: ["high", "max"]}]};
patchCodexModelReasoningQueryCache(cache);
const changedCatalog = efforts();
const later = {...observer, options: {queryKey: key, select: filter}};
query.observers.push(later);
notify({type: "observerAdded", query, observer: later});
const addedObserver = later.result.models[0].supportedReasoningEfforts.map(level => level.reasoningEffort);
observer.setOptions({queryKey: ["models", "list", "remote", "chatgpt", 100, "codex_model_router_v2"], select: filter});
const movedRemote = efforts();
state.payload = {...state.payload, modelNames: [], models: []};
patchCodexModelReasoningQueryCache(cache);
JSON.stringify({cached, idempotent, subscriptions, replacedSelector, changedCatalog, addedObserver, movedRemote});
"#,
        );
        assert_eq!(result["cached"], json!(["high", "max", "ultra"]));
        assert_eq!(result["idempotent"], true);
        assert_eq!(result["subscriptions"], 1);
        assert_eq!(result["replacedSelector"], json!(["high", "max", "ultra"]));
        assert_eq!(result["changedCatalog"], json!(["high", "max"]));
        assert_eq!(result["addedObserver"], json!(["high", "max"]));
        assert_eq!(result["movedRemote"], json!(["high"]));
    }

    #[test]
    fn model_picker_prototype_projects_first_unsubscribed_snapshots_only_for_registered_queries() {
        let result = run_model_picker_patch_core_probe_with_payload(
            json!({
                "modelProvider": "codex_model_router_v2",
                "modelNames": ["relay"],
                "models": [{
                    "model": "relay",
                    "supported_reasoning_levels": ["low", "medium", "high", "xhigh", "max", "ultra"]
                }]
            }),
            r#"
const key = ["models", "list", "local", "apikey", 100, "redacted-session-id", "codex_model_router_v2", "catalog.json"];
const allEfforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
const data = {data: [{
  model: "relay",
  supportedReasoningEfforts: allEfforts.map(reasoningEffort => ({reasoningEffort})),
}]};
const before = JSON.stringify(data);
const select = (raw) => ({models: raw.data.map(model => ({
  ...model,
  supportedReasoningEfforts: model.supportedReasoningEfforts.filter(level =>
    ["low", "medium", "high", "xhigh"].includes(level.reasoningEffort)),
}))});
const query = {queryKey: key, queryHash: "same-query-hash", state: {data}};
const foreignQuery = {queryKey: [...key], queryHash: query.queryHash, state: {data}};
let cacheSubscriptions = 0;
let observerSubscriptions = 0;
const cache = {
  getAll: () => [query],
  get: hash => hash === query.queryHash ? query : undefined,
  subscribe() { cacheSubscriptions += 1; return () => {}; },
};
class Observer {
  constructor(query, options) {
    this.query = query;
    this.setOptions(options);
  }
  createResult(query, options) {
    return {data: options.select(query.state.data)};
  }
  getCurrentResult() { return this.result; }
  getCurrentQuery() { return this.query; }
  getOptimisticResult(options) {
    this.result = this.createResult(this.query, options);
    return this.result;
  }
  setOptions(options) {
    this.options = options;
    this.result = this.createResult(this.query, options);
  }
  subscribe() { observerSubscriptions += 1; return () => {}; }
}
const patched = patchCodexModelReasoningQueryObserverPrototype(Observer.prototype);
const cacheRegistered = patchCodexModelReasoningQueryCache(cache);
const options = {queryKey: key, select};
const observer = new Observer(query, options);
const current = observer.getCurrentResult();
const optimistic = observer.getOptimisticResult(options);
const foreign = new Observer(foreignQuery, options);
const foreignCurrent = foreign.getCurrentResult();
const foreignOptimistic = foreign.getOptimisticResult(options);
const efforts = result => result.data.models[0].supportedReasoningEfforts.map(level => level.reasoningEffort);
JSON.stringify({
  patched,
  cacheRegistered,
  current: efforts(current),
  optimistic: efforts(optimistic),
  foreignCurrent: efforts(foreignCurrent),
  foreignOptimistic: efforts(foreignOptimistic),
  max: current.data.hasModelSupportingMaxReasoningEffort,
  ultra: current.data.hasModelSupportingUltraReasoningEffort,
  cacheSubscriptions,
  observerSubscriptions,
  noObserverArrays: !("observers" in query) && !("observers" in foreignQuery),
  rawUnchanged: JSON.stringify(data) === before,
  sameKeyAndHash: JSON.stringify(query.queryKey) === JSON.stringify(foreignQuery.queryKey) && query.queryHash === foreignQuery.queryHash,
});
"#,
        );
        assert_eq!(
            result,
            json!({
                "patched": true,
                "cacheRegistered": true,
                "current": ["low", "medium", "high", "xhigh", "max", "ultra"],
                "optimistic": ["low", "medium", "high", "xhigh", "max", "ultra"],
                "foreignCurrent": ["low", "medium", "high", "xhigh"],
                "foreignOptimistic": ["low", "medium", "high", "xhigh"],
                "max": true,
                "ultra": true,
                "cacheSubscriptions": 1,
                "observerSubscriptions": 0,
                "noObserverArrays": true,
                "rawUnchanged": true,
                "sameKeyAndHash": true
            })
        );
    }

    #[test]
    fn model_picker_query_cache_cleanup_restores_owned_observers_before_reinjection() {
        let result = run_model_picker_patch_core_probe_with_payload(
            json!({
                "modelProvider": "codex_model_router_v2",
                "modelNames": ["relay"],
                "models": [{"model": "relay", "supported_reasoning_levels": ["high", "max"]}]
            }),
            r#"
const key = ["models", "list", "local", "chatgpt", 100, "codex_model_router_v2"];
const select = () => ({models: [{model: "relay", supportedReasoningEfforts: []}]});
const setOptions = function(options) {this.options = options; this.result = options.select();};
const getOptimisticResult = function() {};
const fetchOptimistic = function() {};
const observer = {options: {queryKey: key, select}, setOptions, getOptimisticResult, fetchOptimistic};
const query = {queryKey: key, observers: [observer]};
let unsubscribeCount = 0;
let notify = () => {};
const cache = {getAll: () => [query], subscribe(callback) {notify = callback; return () => {unsubscribeCount += 1;};}};
patchCodexModelReasoningQueryCache(cache);
const firstWrapper = observer.setOptions;
const externalOptimisticResult = function() {};
observer.getOptimisticResult = externalOptimisticResult;
state.reasoningQueryCaches.get(cache).dispose();
const restored = observer.setOptions === setOptions && observer.fetchOptimistic === fetchOptimistic && observer.options.select === select;
const externalPreserved = observer.getOptimisticResult === externalOptimisticResult;
state.reasoningQueryCaches.clear();
patchCodexModelReasoningQueryCache(cache);
const reinjected = observer.setOptions !== setOptions && observer.setOptions !== firstWrapper;
query.observers = [];
notify({type: "observerRemoved", query, observer});
const removedRestored = observer.setOptions === setOptions && observer.options.select === select;
JSON.stringify({restored, externalPreserved, reinjected, removedRestored, unsubscribeCount});
"#,
        );
        assert_eq!(
            result,
            json!({
                "restored": true, "externalPreserved": true, "reinjected": true,
                "removedRestored": true, "unsubscribeCount": 1
            })
        );
    }

    #[test]
    fn model_picker_preserves_grouped_key_display_and_provider_labels() {
        let result = run_model_picker_patch_core_probe_with_payload(
            json!({
                "defaultModel": "gpt-6-sol--ccg-7f3d2b1a",
                "modelNames": ["gpt-6-sol--ccg-7f3d2b1a"],
                "models": [{
                    "model": "gpt-6-sol--ccg-7f3d2b1a",
                    "upstreamModel": "gpt-6-sol",
                    "apiKeyGroupId": "7f3d2b1a",
                    "displayName": "GPT 6 Sol [Sublyx key]",
                    "providerName": "Sublyx"
                }]
            }),
            r#"
const models = [{model: "gpt-6-sol--ccg-7f3d2b1a", displayName: "gpt-6-sol--ccg-7f3d2b1a"}];
patchModelArray(models);
JSON.stringify({
  model: models[0].model,
  displayName: models[0].displayName,
  providerName: models[0].providerName,
});
"#,
        );

        assert_eq!(result["model"], "gpt-6-sol--ccg-7f3d2b1a");
        assert_eq!(result["displayName"], "GPT 6 Sol [Sublyx key]");
        assert_eq!(result["providerName"], "Sublyx");
    }

    /// 回归：模型解锁器不能再给 React Intl 的 formats/defaultFormats/formatters
    /// 写入 defaultModel/useHiddenModels，否则 MessageFormat 缓存会因循环引用失败并回退
    /// 为未插值的 ICU source。
    #[test]
    fn model_picker_patch_core_does_not_pollute_react_intl_objects() {
        let result = run_model_picker_patch_core_probe(
            r#"
const intl = {
  formats: {number: {compact: {notation: "compact"}}},
  defaultFormats: {date: {short: {year: "numeric"}}},
  formatters: {cache: {message: {}}},
};
const before = JSON.stringify(intl);
const changed = [intl, intl.formats, intl.defaultFormats, intl.formatters]
  .map((value) => patchModelContainer(value));
JSON.stringify({before, after: JSON.stringify(intl), changed});
"#,
        );

        assert_eq!(result["before"], result["after"]);
        assert_eq!(result["changed"], json!([false, false, false, false]));
    }

    /// 已验证的模型门仍应补齐目录、解除隐藏并设置已有的默认模型字段；同时不能
    /// 凭空向 camelCase 容器追加 snake_case 控制字段。
    #[test]
    fn model_picker_patch_core_still_unlocks_explicit_model_gate() {
        let result = run_model_picker_patch_core_probe(
            r#"
const gate = {availableModels: ["gpt-5.6-sol"], useHiddenModels: true, defaultModel: null};
const changed = patchModelContainer(gate);
JSON.stringify({
  changed,
  availableModels: gate.availableModels,
  useHiddenModels: gate.useHiddenModels,
  defaultModel: gate.defaultModel?.model,
  hasSnakeCaseFlag: Object.prototype.hasOwnProperty.call(gate, "use_hidden_models"),
});
"#,
        );

        assert_eq!(result["changed"], true);
        assert_eq!(
            result["availableModels"],
            json!(["gpt-5.6-sol", "qwen3.6", "deepseek-v4-flash"])
        );
        assert_eq!(result["useHiddenModels"], false);
        assert_eq!(result["defaultModel"], "qwen3.6");
        assert_eq!(result["hasSnakeCaseFlag"], false);
    }

    #[test]
    fn model_picker_patch_core_uses_latest_shared_catalog_payload() {
        let result = run_model_picker_patch_core_probe_with_payload(
            json!({
                "defaultModel": "qwen3.8",
                "modelNames": ["qwen3.8"],
                "models": [{ "model": "qwen3.8", "hidden": false }]
            }),
            r#"
const first = [];
patchModelArray(first, true);
state.payload = {
  defaultModel: "deepseek-v4-flash",
  modelNames: ["deepseek-v4-flash", "deepseek-v4-vision"],
  models: [
    {model: "deepseek-v4-flash", hidden: false},
    {model: "deepseek-v4-vision", inputModalities: ["text", "image"], hidden: false},
  ],
};
const second = [];
patchModelArray(second, true);
JSON.stringify({
  first: first.map((model) => model.model),
  second: second.map((model) => model.model),
  modalities: second.find((model) => model.model === "deepseek-v4-vision")?.inputModalities,
});
"#,
        );

        assert_eq!(result["first"], json!(["qwen3.8"]));
        assert_eq!(
            result["second"],
            json!(["deepseek-v4-flash", "deepseek-v4-vision"])
        );
        assert_eq!(result["modalities"], json!(["text", "image"]));
    }

    #[test]
    fn model_picker_unlock_script_patches_renderer_whitelists() {
        let catalog = CodexModelCatalogProjection {
            default_model: Some("qwen3.6".to_string()),
            model_provider: Some("codex_model_router_v2".to_string()),
            catalog_available: true,
            model_names: vec!["qwen3.6".to_string(), "deepseek-v4-flash".to_string()],
            models: vec![json!({ "model": "qwen3.6", "hidden": false })],
        };
        let script = build_model_picker_unlock_script(&catalog);
        assert!(script.contains("qwen3.6"));
        assert!(script.contains("deepseek-v4-flash"));
        assert!(script.contains("\"catalogAvailable\":true"));
        assert!(script.contains("available_models"));
        assert!(script.contains("use_hidden_models: false"));
        assert!(script.contains("107580212"));
        assert!(script.contains("list-models-for-host"));
        assert!(script.contains("model/list"));
        assert!(script.contains("patchModelArray(result.data, true, true)"));
        assert!(script.contains("isModelListMethod(method)"));
        assert!(script.contains("await installAppServerPatch()"));
        assert!(script.contains("state.requestIds.get(requestId)"));
        assert!(script.contains("__ccSwitchCodexAppCompatibilityV9"));
        assert!(script.contains(&format!(
            "const rendererRuntimeFingerprint = {:?}",
            codex_renderer_runtime_fingerprint()
        )));
        assert!(script.contains("typeof rendererRuntimeFingerprint === \"string\""));
        assert!(script.contains("rehydrateStaleHistoryLineages(manager)"));
        assert!(
            script.contains("state.reactRequestClientPatchVersion = appServerRequestPatchVersion")
        );
        assert!(
            !script.contains("if (state.appServerPatchVersion !== appServerRequestPatchVersion)")
        );
        assert!(!script.contains(
            "if (state.reactRequestClientPatchVersion === appServerRequestPatchVersion) return"
        ));
        assert!(!script
            .contains("if (state.appServerPatchVersion === appServerRequestPatchVersion) return"));
        assert!(script.contains("2553103476"));
        assert!(script.contains("isGuardianV2FeatureTomlError(error)"));
        assert!(script.contains("guardianV2FallbackRequestParams"));
        assert!(script.contains("auth.setAuthMethod(\"chatgpt\")"));
        assert!(script.contains("state.requestHealthWarningsSuppressed"));
        assert!(script.contains("state.requestHealthWarningsSuppressed = Boolean(suppressed)"));
        assert!(script.contains("if (!state.requestHealthWarningsSuppressed) {"));
    }

    /// 验证新版历史兼容层同时恢复官方目录同步，并把 Desktop 的全量历史查询
    /// 明确投影为 `modelProviders: []`，不再受活动 Provider 桶影响。
    #[test]
    fn codex_app_compatibility_script_repairs_native_history_catalog() {
        let script = build_model_picker_unlock_script(&CodexModelCatalogProjection::empty());

        assert!(script.contains("localThreadCatalog"));
        assert!(script.contains("requestStartupSync"));
        assert!(script.contains("readStatus"));
        assert!(script.contains("void triggerLocalThreadCatalogSync()"));
        assert!(!script.contains("const historySync = await triggerLocalThreadCatalogSync()"));
        assert!(!script.contains("await catalog.requestStartupSync()"));
        assert!(script.contains("params?.modelProviders == null"));
        assert!(script.contains("if (params == null) return { modelProviders: [] }"));
        assert!(script.contains("modelProviders: []"));
        assert!(script.contains("getCompatibleThreadSortKey"));
        assert!(script.contains("document.getElementById(\"root\")"));
        assert!(!script.contains("document.querySelectorAll(\"*\")"));
        assert!(script.contains("module?.appServices?.localThreadCatalog"));
        assert!(script.contains("fetch(url)"));
        assert!(!script.contains("await state.historyQueryRefreshPromise"));
        assert!(!script.contains("await state.historyLineageHydrationPromise"));
        assert!(!script.contains("await state.historySyncPromise"));
        assert!(!script.contains("await catalog.requestStartupSync()"));
        assert!(script.contains("state.historyQueryRefreshCompleted = true"));
    }

    #[test]
    fn codex_app_compatibility_does_not_block_model_picker_on_history_refresh() {
        let script = build_model_picker_unlock_script(&CodexModelCatalogProjection::empty());

        assert!(script.contains("state.historyQueryRefreshPromise = Promise.resolve()"));
        assert!(script.contains("state.historyQueryRefreshCompleted = true"));
        assert!(!script.contains("await state.historyQueryRefreshPromise"));
        assert!(!script.contains("await state.historyLineageHydrationPromise"));
        assert!(!script.contains("await state.historySyncPromise"));
        assert!(!script.contains("const historySync = await triggerLocalThreadCatalogSync()"));
        assert!(script.contains("void triggerLocalThreadCatalogSync()"));
        assert!(script.contains(
            "if (state.runtimeGeneration === installationGeneration && !state.interval)"
        ));
    }

    fn renderer_lifecycle_test_setup() -> &'static str {
        r#"
globalThis.__historyAttempts = 0;
globalThis.__delayedDiscovery = [];
const client = {
  hostId: "local",
  sendRequest: async () => ({data: []}),
  getCompatibleThreadSortKey() {},
  supportsPaginatedThreadHistory() {},
};
const manager = {
  requestClient: client,
  threadStore: {
    refreshRecentConversations: async () => {
      if (++globalThis.__historyAttempts === 1) throw new Error("temporary history failure");
    },
  },
};
const root = {
  childNodes: [],
  __reactContainerTest: {memoizedProps: {manager}},
};
const document = {
  scripts: [],
  body: root,
  documentElement: root,
  getElementById: id => id === "root" ? root : null,
  querySelectorAll: () => [],
};
const window = {
  dispatchEvent() {},
  addEventListener() {},
  removeEventListener() {},
};
const localStorage = {getItem: () => null, setItem() {}, removeItem() {}};
const performance = {now: () => 0, getEntriesByType: () => []};
const setInterval = callback => { globalThis.__heartbeat = callback; return 1; };
const clearInterval = () => {};
const setTimeout = callback => {
  if (globalThis.__deferDiscovery) __delayedDiscovery.push(callback);
  else callback();
  return 1;
};
const clearTimeout = () => {};
"#
    }

    #[test]
    fn reaudit_renderer_continuation_requires_verified_request_hook() {
        for mode in ["frozen", "nonwritable", "mutable_inherited", "legacy_hook"] {
            let runtime = rquickjs::Runtime::new().expect("create JavaScript runtime");
            let context = rquickjs::Context::full(&runtime).expect("create JavaScript context");
            let payload = r#"{"modelProvider":"codex_model_router_v2","catalogAvailable":true,"modelNames":["worker"],"models":[{"model":"worker"}]}"#;
            let script = assemble_codex_renderer_runtime_script(
                payload,
                false,
                true,
                "verified-request-hook-test",
            );
            let setup = renderer_lifecycle_test_setup();
            context.with(|ctx| {
                ctx.eval::<(), _>(format!(
                    r#"
{setup}
const mode = {mode:?};
let reads = 0;
let starts = 0;
let legacyCalls = 0;
const request = async (method, params) => {{
  if (method === "turn/start") {{
    starts += 1;
    return {{ turn: {{ id: "continued-turn" }} }};
  }}
  if (method === "thread/read") {{
    reads += 1;
    return {{ thread: {{ id: "exact-thread", model: "worker", turns: [{{id: "newer-failed-turn", status: "failed", error: {{message: "Our servers are currently overloaded"}}}}] }} }};
  }}
  return {{data: []}};
}};
if (mode === "mutable_inherited") {{
  delete client.sendRequest;
  delete client.getCompatibleThreadSortKey;
  delete client.supportsPaginatedThreadHistory;
  Object.setPrototypeOf(client, {{sendRequest: request, getCompatibleThreadSortKey() {{}}, supportsPaginatedThreadHistory() {{}}}});
}} else if (mode === "legacy_hook") {{
  client.__ccSwitchOriginalSendRequest = request;
  client.__ccSwitchModelRequestPatch = "verified-request-hook-test";
  client.sendRequest = async () => {{legacyCalls += 1; throw new Error("An unverified legacy wrapper must not be stacked");}};
}} else {{
  client.sendRequest = request;
  if (mode === "frozen") Object.freeze(client);
  else Object.defineProperty(client, "sendRequest", {{value: request, writable: false, configurable: false}});
}}
const installation = {script};
void installation.then(async () => {{
  const state = window[{MODEL_PICKER_PATCH_KEY:?}];
  const retainedBeforeProbe = state.appServerClients.includes(client);
  // A retained legacy/unpatchable client must be rejected at the mutation
  // boundary too, not only omitted by a successful discovery pass.
  if (mode === "frozen" || mode === "nonwritable") {{
    state.appServerClients.push(client);
    await client.sendRequest("turn/start", {{threadId: "exact-thread", input: [{{type:"text", text:"a newer user question"}}]}});
  }}
  globalThis.__deferDiscovery = true;
  state.startCodexContinuation("exact-thread", "old-request-recovery", "worker", Date.now() - 1000);
  for (let n = 0; n < 256; n += 1) {{
    const job = state.readCodexContinuationJob("old-request-recovery");
    if (job?.status === "prepared") state.commitCodexContinuation("old-request-recovery");
    if (job?.status === "completed") {{
      globalThis.__verifiedHookProbe = JSON.stringify({{retainedBeforeProbe, reads, starts, legacyCalls, submitted: job.submitted, mutationAttempted: job.mutationAttempted}});
      return;
    }}
    await Promise.resolve();
  }}
  throw new Error("The hook-ownership probe did not finish");
}}, error => {{globalThis.__verifiedHookProbeError = String(error);}});
"#
                ))
                .expect("start real renderer hook-ownership probe");
            });
            while runtime
                .execute_pending_job()
                .expect("run hook-ownership jobs")
            {}
            context.with(|ctx| {
                let result: Value = serde_json::from_str(
                    &ctx.eval::<String, _>("globalThis.__verifiedHookProbe || globalThis.__verifiedHookProbeError")
                        .expect("read hook-ownership probe"),
                )
                .expect("parse hook-ownership probe");
                assert_eq!(
                    result,
                    if mode == "mutable_inherited" || mode == "legacy_hook" {
                        json!({"retainedBeforeProbe": true, "reads": 2, "starts": 1, "legacyCalls": 0, "submitted": true, "mutationAttempted": true})
                    } else {
                        json!({"retainedBeforeProbe": false, "reads": 0, "starts": 1, "legacyCalls": 0, "submitted": false, "mutationAttempted": false})
                    },
                    "request-hook ownership must be authoritative for {mode} clients"
                );
            });
        }
    }

    #[test]
    fn reaudit_background_history_failure_is_handled_and_retried_without_stopping_picker() {
        let runtime = rquickjs::Runtime::new().expect("create JavaScript runtime");
        let unhandled = std::sync::Arc::new(std::sync::atomic::AtomicIsize::new(0));
        let rejection_count = unhandled.clone();
        runtime.set_host_promise_rejection_tracker(Some(Box::new(move |_, _, _, handled| {
            rejection_count.fetch_add(if handled { -1 } else { 1 }, Ordering::SeqCst);
        })));
        let context = rquickjs::Context::full(&runtime).expect("create JavaScript context");
        let script = assemble_codex_renderer_runtime_script(
            r#"{"modelProvider":"codex_model_router_v2","catalogAvailable":true,"modelNames":["worker"],"models":[{"model":"worker"}]}"#,
            false,
            true,
            "reaudit-runtime",
        );
        let setup = renderer_lifecycle_test_setup();
        context.with(|ctx| {
            ctx.eval::<(), _>(format!(
                "{setup}\nconst installation = {script}\ninstallation.then(value => {{globalThis.__installation = value;}}, error => {{globalThis.__installationError = String(error);}});"
            ))
            .expect("start actual renderer runtime");
        });
        while runtime.execute_pending_job().expect("run renderer jobs") {}
        context.with(|ctx| {
            let status: String = ctx.eval("globalThis.__installation?.status || globalThis.__installationError").unwrap();
            assert_eq!(status, "ok");
            let first: Value = serde_json::from_str(
                &ctx.eval::<String, _>(format!(
                    "JSON.stringify({{attempts: __historyAttempts, running: Boolean(window[{MODEL_PICKER_PATCH_KEY:?}].interval), failures: window[{MODEL_PICKER_PATCH_KEY:?}].failures}})"
                )).unwrap()
            ).unwrap();
            assert_eq!(first["attempts"], 1);
            assert_eq!(first["running"], true);
            assert!(first["failures"].as_array().unwrap().contains(&json!("temporary history failure")));
        });
        assert_eq!(
            unhandled.load(Ordering::SeqCst),
            0,
            "optional history work must not leave an unhandled rejection"
        );
        context.with(|ctx| {
            ctx.eval::<(), _>(format!(
                "window[{MODEL_PICKER_PATCH_KEY:?}].lastReactFullScanAt = 0; __heartbeat();"
            ))
            .unwrap();
        });
        while runtime.execute_pending_job().expect("run retry jobs") {}
        context.with(|ctx| {
            let retried: bool = ctx.eval(format!(
                "__historyAttempts === 2 && window[{MODEL_PICKER_PATCH_KEY:?}].historyQueryRefreshCompleted === true && Boolean(window[{MODEL_PICKER_PATCH_KEY:?}].interval)"
            )).unwrap();
            assert!(retried, "the next discovery pass must retry failed optional history work");
        });
        assert_eq!(unhandled.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn picker_scope_discovery_does_not_block_installation_or_heartbeat() {
        let runtime = rquickjs::Runtime::new().expect("create JavaScript runtime");
        let context = rquickjs::Context::full(&runtime).expect("create JavaScript context");
        let payload = r#"{"modelProvider":"codex_model_router_v2","catalogAvailable":true,"modelNames":["worker"],"models":[{"model":"worker","supported_reasoning_levels":["high","max","ultra"]}]}"#;
        let script =
            assemble_codex_renderer_runtime_script(payload, false, true, "scoped-discovery-test");
        let setup = renderer_lifecycle_test_setup();
        context.with(|ctx| {
            ctx.eval::<(), _>(format!(
                r#"{setup}
let fiber = root.__reactContainerTest;
for (let depth = 0; depth < 150; depth += 1) {{
  fiber.child = {{}};
  fiber = fiber.child;
}}
globalThis.__deferDiscovery = true;
window[{MODEL_PICKER_PATCH_KEY:?}] = {{
  modulePromises: new Map([["app-shared-", Promise.resolve({{}})]]),
}};
const installation = {script}
installation.then(() => {{ globalThis.__installationCompleted = true; }});
"#
            ))
            .expect("start renderer with paused scope discovery");
        });
        while runtime.execute_pending_job().expect("run renderer jobs") {}
        context.with(|ctx| {
            assert!(ctx.eval::<bool, _>("__delayedDiscovery.length > 0").unwrap());
            assert!(ctx.eval::<bool, _>(format!(
                "globalThis.__installationCompleted === true && Boolean(window[{MODEL_PICKER_PATCH_KEY:?}].interval)"
            )).unwrap(), "scope discovery must not hold installation or its heartbeat open");
            ctx.eval::<(), _>(
                "globalThis.__deferDiscovery = false; for (const resume of __delayedDiscovery.splice(0)) resume();"
            ).unwrap();
        });
        while runtime
            .execute_pending_job()
            .expect("finish scope discovery")
        {}
        context.with(|ctx| {
            assert!(ctx.eval::<bool, _>(format!(
                "window[{MODEL_PICKER_PATCH_KEY:?}].scopedAppServerDiscoveryPromise === null && Boolean(window[{MODEL_PICKER_PATCH_KEY:?}].interval)"
            )).unwrap());
        });
    }

    #[test]
    fn reaudit_superseded_renderer_discovery_cannot_replace_newer_request_hooks() {
        let runtime = rquickjs::Runtime::new().expect("create JavaScript runtime");
        let context = rquickjs::Context::full(&runtime).expect("create JavaScript context");
        let payload = r#"{"modelProvider":"codex_model_router_v2","catalogAvailable":true,"modelNames":["worker"],"models":[{"model":"worker"}]}"#;
        let old = assemble_codex_renderer_runtime_script(payload, false, true, "old-runtime");
        let new = assemble_codex_renderer_runtime_script(payload, false, true, "new-runtime");
        let setup = renderer_lifecycle_test_setup();
        context.with(|ctx| {
            ctx.eval::<(), _>(format!(
                r#"{setup}
root.__reactContainerTest.memoizedProps = {{
  entries: [...Array.from({{length: 1200}}, () => ({{}})), manager],
}};
globalThis.__deferDiscovery = true;
const oldInstallation = {old}
oldInstallation.then(() => {{ globalThis.__oldCompleted = true; }});
"#
            ))
            .expect("start old runtime with paused discovery");
        });
        while runtime.execute_pending_job().expect("run old runtime jobs") {}
        context.with(|ctx| {
            assert!(ctx
                .eval::<bool, _>("__delayedDiscovery.length > 0 && !globalThis.__oldCompleted")
                .unwrap());
            ctx.eval::<(), _>(format!(
                "globalThis.__deferDiscovery = false;\nconst newInstallation = {new}\nnewInstallation.then(() => {{ globalThis.__newCompleted = true; }});"
            ))
            .expect("install replacement runtime");
        });
        while runtime.execute_pending_job().expect("run new runtime jobs") {}
        context.with(|ctx| {
            assert!(ctx
                .eval::<bool, _>(
                    "globalThis.__newCompleted === true && client.__ccSwitchModelRequestPatch === 'new-runtime'"
                )
                .unwrap());
            ctx.eval::<(), _>("for (const resume of __delayedDiscovery.splice(0)) resume();")
                .unwrap();
        });
        while runtime
            .execute_pending_job()
            .expect("resume old runtime jobs")
        {}
        context.with(|ctx| {
            assert!(ctx.eval::<bool, _>("globalThis.__oldCompleted === true").unwrap());
            let fingerprint: String = ctx.eval("client.__ccSwitchModelRequestPatch").unwrap();
            assert_eq!(
                fingerprint, "new-runtime",
                "a superseded async discovery must not reinstall its captured request hooks"
            );
            let running: bool = ctx.eval(format!(
                "window[{MODEL_PICKER_PATCH_KEY:?}].rendererRuntimeFingerprint === 'new-runtime' && Boolean(window[{MODEL_PICKER_PATCH_KEY:?}].interval)"
            )).unwrap();
            assert!(running);
            ctx.eval::<(), _>(format!(
                "const duplicateInstallation = {new}\nduplicateInstallation.then(() => client.sendRequest('model/list', {{}})).then(result => {{ globalThis.__duplicateModels = result.data.map(model => model.model); }});"
            )).expect("repeat the current runtime installation");
        });
        while runtime
            .execute_pending_job()
            .expect("run duplicate runtime jobs")
        {}
        context.with(|ctx| {
            let models: String = ctx
                .eval("JSON.stringify(globalThis.__duplicateModels)")
                .unwrap();
            assert_eq!(
                models, r#"["worker"]"#,
                "same-fingerprint reinjection must retain working request hooks"
            );
        });
    }

    /// The renderer heartbeat must not synchronously walk every DOM node and the
    /// complete React object graph. New app-server clients are discovered from
    /// the cached module on every heartbeat; React traversal is an incremental,
    /// idle-time fallback with one in-flight job and an observer-backed dirty set.
    #[test]
    fn codex_app_compatibility_heartbeat_does_not_repeat_full_react_scan() {
        let script = build_model_picker_unlock_script(&CodexModelCatalogProjection::empty());

        assert!(script.contains(&format!(
            "const rendererRuntimeFingerprint = {:?}",
            codex_renderer_runtime_fingerprint()
        )));
        assert!(script.contains("refreshCodexScopedAppServerClients("));
        assert!(script.contains("const patchedCaches = new Set()"));
        assert!(script.contains("patchCodexModelReasoningQueryCacheOnce(cache, patchedCaches)"));
        assert!(script.contains("clearInterval(state.interval)"));
        assert!(script.contains("const patchAppServerModuleClients"));
        assert!(script.contains("state.reactDiscoveryPromise"));
        assert!(script.contains("requestIdleCallback"));
        assert!(script.contains("const sliceDeadline = monotonicNow() + 4"));
        assert!(script.contains("sliceCount < 800"));
        assert!(script.contains("state.lastReactFullScanAt || 0) >= 30000"));
        assert!(script.contains("state.lastReactIncrementalScanAt || 0) >= 5000"));
        assert!(script.contains("new MutationObserver"));
        assert!(
            script.contains("modulePatched = patchAppServerModuleClients(module, patchedCaches)")
        );
        assert!(script.contains("patchCodexModelReasoningQueryClient(value, patchedCaches)"));
        assert!(script.contains("state.scopedAppServerScopeCandidates = new Set()"));
        assert!(script.contains("state.scopedAppServerRegistryClasses = []"));
        assert!(script.contains("state.scopedAppServerRegistryInstances = new Set()"));
        assert!(script.contains("for (const cache of state.reasoningQueryCaches?.keys() || [])"));
        assert!(script.contains("state.reactInitialDiscoveryCompleted = false"));
        assert!(script.contains("for (const cache of reasoningQueryCachesToRebind)"));
        assert!(script.contains("if (typeof entry?.dispose !== \"function\") continue"));
        assert!(!script.contains("document.querySelectorAll(\"*\")"));
        assert!(
            !script.contains("if (state.appServerPatchVersion !== appServerRequestPatchVersion)")
        );
        assert!(!script.contains("patched += patchReactAppServerClients();"));
        assert!(!script.contains(
            "if (state.historyQueryRefreshCompleted) patched += patchReactAppServerClients()"
        ));
    }

    #[test]
    fn fallback_query_client_discovery_reprojects_retained_caches_without_rpc_getters() {
        let discovery_core = app_server_module_client_discovery_core_script();
        let result = run_model_picker_patch_core_probe_with_payload(
            json!({
                "modelProvider": "codex_model_router_v2",
                "modelNames": ["relay"],
                "models": [{"model": "relay", "supported_reasoning_levels": ["high", "max", "ultra"]}]
            }),
            &format!(
                r#"
const patchRequestClient = () => false;
const recordFailure = (error) => {{ throw error; }};
{discovery_core}
const key = ["models", "list", "local", "chatgpt", 100, "codex_model_router_v2"];
const observer = {{
  options: {{queryKey: key, select: () => ({{models: [{{model: "relay", supportedReasoningEfforts: []}}]}})}},
  setOptions(options) {{ this.options = options; this.result = options.select(); }},
}};
const cache = {{getAll: () => [{{queryKey: key, observers: [observer]}}], subscribe: () => () => {{}}}};
class QueryClient {{ getQueryCache() {{ return cache; }} getQueryData() {{}} setQueryData() {{}} }}
let propertyReads = 0;
const rpc = new Proxy({{}}, {{get() {{ propertyReads += 1; return () => {{}}; }}}});
const getter = {{get getQueryCache() {{ propertyReads += 1; throw new Error("must not read getter"); }}}};
patchAppServerModuleClients({{queryClient: new QueryClient(), rpc, getter}});
const efforts = () => observer.result.models[0].supportedReasoningEfforts.map(level => level.reasoningEffort);
const first = efforts();
state.payload = {{...state.payload, models: [{{model: "relay", supported_reasoning_levels: ["high", "max"]}}]}};
for (const retained of state.reasoningQueryCaches.keys()) patchCodexModelReasoningQueryCache(retained);
JSON.stringify({{first, refreshed: efforts(), caches: state.reasoningQueryCaches.size, propertyReads}});
"#
            ),
        );
        assert_eq!(
            result,
            json!({
                "first": ["high", "max", "ultra"],
                "refreshed": ["high", "max"],
                "caches": 1,
                "propertyReads": 0
            })
        );
    }

    #[test]
    fn app_server_module_discovery_patches_a_replaced_signal_client() {
        let runtime = rquickjs::Runtime::new().expect("create JavaScript runtime");
        let context = rquickjs::Context::full(&runtime).expect("create JavaScript context");
        let script = format!(
            r#"
const patched = [];
const patchRequestClient = (client) => {{
  if (!client || typeof client.sendRequest !== "function") return false;
  patched.push(client.id);
  return true;
}};
{}
let current = {{ id: "first", sendRequest() {{}}, getCompatibleThreadSortKey() {{}}, supportsPaginatedThreadHistory() {{}} }};
const module = {{ signal: {{ get: () => current }} }};
const firstCount = patchAppServerModuleClients(module);
current = {{ id: "second", sendRequest() {{}}, getCompatibleThreadSortKey() {{}}, supportsPaginatedThreadHistory() {{}} }};
const secondCount = patchAppServerModuleClients(module);
JSON.stringify({{ firstCount, secondCount, patched }});
"#,
            app_server_module_client_discovery_core_script()
        );

        context.with(|ctx| {
            let json_text: String = ctx.eval(script).expect("execute module discovery core");
            let result: Value =
                serde_json::from_str(&json_text).expect("parse module discovery result");
            assert_eq!(result["firstCount"], 1);
            assert_eq!(result["secondCount"], 1);
            assert_eq!(result["patched"], json!(["first", "second"]));
        });
    }

    #[test]
    fn app_server_module_discovery_does_not_invoke_rpc_proxy_properties() {
        let runtime = rquickjs::Runtime::new().expect("create JavaScript runtime");
        let context = rquickjs::Context::full(&runtime).expect("create JavaScript context");
        let script = format!(
            r#"
let propertyReads = 0;
let patched = 0;
const patchRequestClient = () => {{ patched += 1; return true; }};
{}
const rpc = new Proxy({{}}, {{ get() {{ propertyReads += 1; return () => {{ throw new Error("an arbitrary RPC must not be called"); }}; }} }});
const count = patchAppServerModuleClients({{ rpc, map: new Map() }});
JSON.stringify({{ count, patched, propertyReads, client: looksLikeAppServerRequestClient(rpc) }});
"#,
            app_server_module_client_discovery_core_script()
        );
        context.with(|ctx| {
            let result: String = ctx.eval(script).expect("execute RPC exclusion probe");
            let result: Value = serde_json::from_str(&result).expect("parse RPC exclusion result");
            assert_eq!(
                result,
                json!({ "count": 0, "patched": 0, "propertyReads": 0, "client": false })
            );
        });
    }

    #[test]
    fn app_server_module_discovery_finds_deep_scoped_local_clients_and_observes_replacement() {
        let runtime = rquickjs::Runtime::new().expect("create JavaScript runtime");
        let context = rquickjs::Context::full(&runtime).expect("create JavaScript context");
        let script = format!(
            r#"
const state = {{}};
const patched = [];
let registryMutations = 0;
let queryClientReads = 0;
let scopeScans = 0;
const patchRequestClient = (client) => {{ patched.push(client.id); return true; }};
const monotonicNow = () => 1;
const yieldReactDiscovery = async () => {{}};
const recordFailure = (error) => {{ throw error; }};
const document = {{ getElementById() {{ scopeScans += 1; return null; }} }};
class Client {{
  constructor(id) {{ this.id = id; this.hostId = "local"; }}
  sendRequest() {{}}
  getCompatibleThreadSortKey() {{}}
  supportsPaginatedThreadHistory() {{}}
}}
let manager = {{ requestClient: new Client("first") }};
const scope = {{ chain: {{}}, node: {{}}, get queryClient() {{ queryClientReads += 1; return {{}}; }}, get: () => manager, set() {{}}, watch() {{}} }};
const current = {{}};
let leaf = current;
for (let index = 0; index < 40; index += 1) {{ leaf.child = {{}}; leaf = leaf.child; }}
leaf.memoizedState = {{ memoizedState: {{ current: scope }} }};
const window = {{ __codexRoot: {{ _internalRoot: {{ current }} }} }};
class Registry {{
  constructor(scope) {{ this.scope = scope; }}
  getForHostId(host) {{ return this.scope.get(host); }}
  getAll() {{}}
  getDefault() {{}}
  getImplForHostId() {{}}
}}
class UntrustedRegistry {{
  constructor(scope) {{ registryMutations += 1; this.scope = scope; }}
  getForHostId(host) {{ return this.scope.get(host); }}
  getAll() {{}}
  getDefault() {{}}
  getImplForHostId() {{}}
}}
{}
void (async () => {{
  const module = {{ minifiedExport: Registry, unrelatedFactory: UntrustedRegistry }};
  const firstCount = await patchCodexScopedAppServerClients(module);
  manager = {{ requestClient: new Client("second") }};
  const secondCount = await patchCodexScopedAppServerClients(module);
  manager = {{ requestClient: {{ ...new Client("remote"), hostId: "remote" }} }};
  const remoteCount = await patchCodexScopedAppServerClients(module);
  globalThis.__scopedClientDiscoveryResult = JSON.stringify({{ firstCount, secondCount, remoteCount, patched, registryMutations, scopeScans, queryClientReads }});
}})();
"#,
            app_server_module_client_discovery_core_script()
        );
        context.with(|ctx| {
            ctx.eval::<(), _>(script)
                .expect("start scoped discovery probe")
        });
        while runtime
            .execute_pending_job()
            .expect("execute scoped discovery job")
        {}
        context.with(|ctx| {
            let result: String = ctx.eval("globalThis.__scopedClientDiscoveryResult").expect("read scoped discovery result");
            let result: Value = serde_json::from_str(&result).expect("parse scoped discovery result");
            assert_eq!(result, json!({ "firstCount": 1, "secondCount": 1, "remoteCount": 0, "patched": ["first", "second"], "registryMutations": 0, "scopeScans": 1, "queryClientReads": 3 }));
        });
    }

    #[test]
    fn app_server_scoped_discovery_uses_runtime_registry_instances_without_optional_methods() {
        let runtime = rquickjs::Runtime::new().expect("create JavaScript runtime");
        let context = rquickjs::Context::full(&runtime).expect("create JavaScript context");
        let script = format!(
            r#"
const state = {{}};
const patched = [];
let queryClientReads = 0;
const patchRequestClient = (client) => {{ patched.push(client.id); return true; }};
const monotonicNow = () => 1;
const yieldReactDiscovery = async () => {{}};
const recordFailure = (error) => {{ throw error; }};
const document = {{ getElementById() {{ return null; }} }};
class Client {{
  constructor(id) {{ this.id = id; this.hostId = "local"; }}
  sendRequest() {{}}
  getCompatibleThreadSortKey() {{}}
  supportsPaginatedThreadHistory() {{}}
}}
const manager = {{ requestClient: new Client("runtime-instance") }};
const scope = {{ chain: {{}}, node: {{}}, get queryClient() {{ queryClientReads += 1; return {{}}; }}, get: () => manager, set() {{}}, watch() {{}} }};
class RuntimeRegistry {{
  constructor(scope) {{ this.scope = scope; }}
  getForHostId(host) {{ return this.scope.get(host); }}
  getAll() {{}}
  getImplForHostId(host) {{ return this.scope.get(host); }}
}}
const current = {{ memoizedProps: {{ appServerRegistry: new RuntimeRegistry(scope) }} }};
const window = {{ __codexRoot: {{ _internalRoot: {{ current }} }} }};
const module = {{}};
{}
void (async () => {{
  const count = await patchCodexScopedAppServerClients(module);
  globalThis.__runtimeRegistryResult = JSON.stringify({{ count, patched, queryClientReads }});
}})();
"#,
            app_server_module_client_discovery_core_script()
        );
        context
            .with(|ctx| ctx.eval::<(), _>(script))
            .expect("start runtime registry discovery probe");
        while runtime
            .execute_pending_job()
            .expect("execute runtime registry discovery job")
        {}
        context.with(|ctx| {
            let result: String = ctx
                .eval("globalThis.__runtimeRegistryResult")
                .expect("read runtime registry discovery result");
            let result: Value =
                serde_json::from_str(&result).expect("parse runtime registry result");
            assert_eq!(
                result,
                json!({ "count": 1, "patched": ["runtime-instance"], "queryClientReads": 1 })
            );
        });
    }

    #[test]
    fn renderer_discovery_uses_app_server_manager_hooks_chunk() {
        let runtime = rquickjs::Runtime::new().expect("create JavaScript runtime");
        let context = rquickjs::Context::full(&runtime).expect("create JavaScript context");
        let payload = r#"{"modelProvider":"codex_model_router_v2","catalogAvailable":true,"modelNames":["worker"],"models":[{"model":"worker"}]}"#;
        let script = assemble_codex_renderer_runtime_script(
            payload,
            false,
            true,
            "app-initial-fallback-test",
        );
        let setup = renderer_lifecycle_test_setup();
        context.with(|ctx| {
            ctx.eval::<(), _>(format!(
                r#"
{setup}
const scope = {{
  chain: {{}}, node: {{}}, queryClient: {{
    getQueryCache() {{ return {{ getAll: () => [] }}; }},
    getQueryData() {{}}, setQueryData() {{}},
  }},
  get(key) {{ return key === "local" ? manager : []; }},
  set() {{}}, watch() {{}},
}};
root.__reactContainerTest.memoizedProps.scope = scope;
class AppServerRegistry {{
  scope;
  constructor(scope) {{ this.scope = scope; }}
  getForHostId(host) {{ return this.scope.get(host); }}
  getImplForHostId(host) {{ return this.scope.get(host); }}
  getAll() {{ return []; }}
}}
window[{MODEL_PICKER_PATCH_KEY:?}] = {{
  modulePromises: new Map([
    ["app-shared-", Promise.resolve({{}})],
    ["app-server-manager-hooks-", Promise.resolve({{AppServerRegistry}})],
  ]),
}};
const installation = {script};
installation.then(value => {{ globalThis.__fallbackInstallation = value; }}, error => {{ globalThis.__fallbackInstallationError = String(error); }});
"#
            ))
            .expect("start app-server-manager-hooks probe");
        });
        while runtime
            .execute_pending_job()
            .expect("run app-server-manager-hooks jobs")
        {}
        context.with(|ctx| {
            let result: Value = serde_json::from_str(
                &ctx
                    .eval::<String, _>(format!(
                        r#"JSON.stringify({{
                          status: globalThis.__fallbackInstallation?.status || null,
                          error: globalThis.__fallbackInstallationError || null,
                          appServerPatchInstalled: window[{MODEL_PICKER_PATCH_KEY:?}]?.appServerPatchInstalled || false,
                          clientCount: window[{MODEL_PICKER_PATCH_KEY:?}]?.scopedAppServerDiscovery?.clientCount || 0,
                        }})"#
                    ))
                    .expect("read app-server-manager-hooks result"),
            )
            .expect("parse app-initial fallback result");
            assert_eq!(result["status"], "ok");
            assert_eq!(result["error"], Value::Null);
            assert_eq!(result["appServerPatchInstalled"], true);
            assert_eq!(result["clientCount"], 1);
        });
    }

    #[test]
    fn renderer_discovery_falls_back_to_app_initial_registry_chunk() {
        let runtime = rquickjs::Runtime::new().expect("create JavaScript runtime");
        let context = rquickjs::Context::full(&runtime).expect("create JavaScript context");
        let payload = r#"{"modelProvider":"codex_model_router_v2","catalogAvailable":true,"modelNames":["worker"],"models":[{"model":"worker"}]}"#;
        let script = assemble_codex_renderer_runtime_script(
            payload,
            false,
            true,
            "app-initial-fallback-test",
        );
        let setup = renderer_lifecycle_test_setup();
        context.with(|ctx| {
            ctx.eval::<(), _>(format!(
                r#"
{setup}
const scope = {{
  chain: {{}}, node: {{}}, queryClient: {{
    getQueryCache() {{ return {{ getAll: () => [] }}; }},
    getQueryData() {{}}, setQueryData() {{}},
  }},
  get(key) {{ return key === "local" ? manager : []; }},
  set() {{}}, watch() {{}},
}};
root.__reactContainerTest.memoizedProps.scope = scope;
class AppServerRegistry {{
  scope;
  constructor(scope) {{ this.scope = scope; }}
  getForHostId(host) {{ return this.scope.get(host); }}
  getImplForHostId(host) {{ return this.scope.get(host); }}
  getAll() {{ return []; }}
}}
window[{MODEL_PICKER_PATCH_KEY:?}] = {{
  modulePromises: new Map([
    ["app-shared-", Promise.resolve({{}})],
    ["app-initial-", Promise.resolve({{AppServerRegistry}})],
  ]),
}};
const installation = {script};
installation.then(value => {{ globalThis.__fallbackInstallation = value; }}, error => {{ globalThis.__fallbackInstallationError = String(error); }});
"#
            ))
            .expect("start app-initial fallback probe");
        });
        while runtime
            .execute_pending_job()
            .expect("run app-initial fallback jobs")
        {}
        context.with(|ctx| {
            let result: Value = serde_json::from_str(
                &ctx
                    .eval::<String, _>(format!(
                        r#"JSON.stringify({{
                          status: globalThis.__fallbackInstallation?.status || null,
                          error: globalThis.__fallbackInstallationError || null,
                          appServerPatchInstalled: window[{MODEL_PICKER_PATCH_KEY:?}]?.appServerPatchInstalled || false,
                          clientCount: window[{MODEL_PICKER_PATCH_KEY:?}]?.scopedAppServerDiscovery?.clientCount || 0,
                        }})"#
                    ))
                    .expect("read app-initial fallback result"),
            )
            .expect("parse app-initial fallback result");
            assert_eq!(result["status"], "ok");
            assert_eq!(result["error"], Value::Null);
            assert_eq!(result["appServerPatchInstalled"], true);
            assert_eq!(result["clientCount"], 1);
        });
    }

    #[test]
    fn codex_app_renderer_resources_are_valid_javascript_fragments() {
        let runtime = rquickjs::Runtime::new().expect("create JavaScript runtime");
        let context = rquickjs::Context::full(&runtime).expect("create JavaScript context");
        let fragments = [
            catalog_payload_selection_core_script(),
            app_server_model_list_scope_core_script(),
            model_picker_patch_core_script(),
            include_str!("resources/codex_desktop/model_picker_cache_lifecycle.js"),
            include_str!("resources/codex_desktop/model_picker_release.js"),
            guardian_v2_compatibility_patch_core_script(),
            app_server_request_normalization_core_script(),
            history_lineage_hydration_core_script(),
            app_server_module_client_discovery_core_script(),
            include_str!("resources/codex_desktop/request_health_warning.js"),
            include_str!("resources/codex_desktop/summary_handoff.js"),
            codex_continuation_core_script(),
            include_str!("resources/codex_desktop/renderer_runtime.js"),
        ];

        context.with(|ctx| {
            for (index, fragment) in fragments.iter().enumerate() {
                let encoded = serde_json::to_string(fragment).expect("encode renderer fragment");
                let parsed: bool = ctx
                    .eval(format!("new Function({encoded}); true"))
                    .unwrap_or_else(|error| panic!("parse renderer fragment {index}: {error}"));
                assert!(parsed);
            }
        });
    }

    #[test]
    fn codex_app_runtime_template_resolves_every_slot() {
        let script = build_model_picker_unlock_script(&CodexModelCatalogProjection::empty());

        assert!(!script.contains("__CCSWITCH_"));
        assert!(script.contains("const incomingPayload = {"));
        assert!(script.contains("else cancelCodexModelPickerReleaseRefresh();"));
        assert!(script.contains("pickerDiagnostics: codexModelPickerDiagnostics()"));
        assert!(script.contains("state.requestHealthWarningsSuppressed = "));
        assert!(script.contains(&format!(
            "const rendererRuntimeFingerprint = {:?}",
            codex_renderer_runtime_fingerprint()
        )));
    }

    #[test]
    fn codex_renderer_identity_is_a_content_fingerprint_of_the_assembled_runtime() {
        let fingerprint = codex_renderer_runtime_fingerprint();
        assert!(fingerprint.starts_with("sha256-"));
        assert_eq!(fingerprint.len(), "sha256-".len() + 64);

        let template = codex_renderer_runtime_template_for_fingerprint();
        assert!(!template.contains("__CCSWITCH_"));
        assert!(template.contains("const rendererRuntimeFingerprint ="));
        assert!(template.contains("__ccswitch_runtime_fingerprint_slot__"));

        let script = build_model_picker_unlock_script(&CodexModelCatalogProjection::empty());
        assert!(!script.contains("rendererSchedulerVersion"));
        assert!(script.contains(&format!(
            "const rendererRuntimeFingerprint = {:?}",
            fingerprint
        )));
    }

    #[test]
    fn codex_app_runtime_template_preserves_literal_provider_metadata() {
        let literal_metadata = [
            "{{braces}} ${template} \"quotes\" \\backslash",
            "__CCSWITCH_CATALOG_PAYLOAD__",
            "__CCSWITCH_CATALOG_RELEASED__",
            "__CCSWITCH_PATCH_KEY__",
            "__CCSWITCH_RENDERER_RUNTIME_FINGERPRINT__",
            "/*__CCSWITCH_CATALOG_PAYLOAD_SELECTION_CORE__*/",
            "/*__CCSWITCH_MODEL_PICKER_RELEASE_CORE__*/",
            "/*__CCSWITCH_QUERY_CACHE_LIFECYCLE_CORE__*/",
            "/*__CCSWITCH_MODEL_PATCH_CORE__*/",
            "/*__CCSWITCH_GUARDIAN_V2_PATCH_CORE__*/",
            "/*__CCSWITCH_REQUEST_NORMALIZATION_CORE__*/",
            "/*__CCSWITCH_HISTORY_LINEAGE_HYDRATION_CORE__*/",
            "/*__CCSWITCH_MODULE_CLIENT_DISCOVERY_CORE__*/",
            "/*__CCSWITCH_MODEL_PICKER_DIAGNOSTICS_CORE__*/",
            "/*__CCSWITCH_REQUEST_HEALTH_WARNING_CORE__*/",
            "/*__CCSWITCH_SUMMARY_HANDOFF_CORE__*/",
            "/*__CCSWITCH_CODEX_CONTINUATION_CORE__*/",
            "/*__CCSWITCH_APP_SERVER_MODEL_LIST_SCOPE_CORE__*/",
            "__CCSWITCH_REQUEST_HEALTH_SUPPRESSED__",
            "__CCSWITCH_MANUAL_SUMMARY_PROMPT__",
        ]
        .join("\n");
        let catalog = CodexModelCatalogProjection {
            default_model: Some("literal-model".to_string()),
            model_provider: Some("codex_model_router_v2".to_string()),
            catalog_available: true,
            model_names: vec!["literal-model".to_string()],
            models: vec![json!({"model": "literal-model", "description": literal_metadata})],
        };
        let script = build_model_picker_unlock_script(&catalog);
        let payload_literal = script
            .lines()
            .find_map(|line| line.trim().strip_prefix("const incomingPayload = "))
            .and_then(|line| line.strip_suffix(';'))
            .expect("find serialized renderer payload");
        let actual: Value = serde_json::from_str(payload_literal).expect("parse literal payload");
        assert_eq!(
            actual,
            serde_json::to_value(&catalog).expect("encode catalog")
        );

        let runtime = rquickjs::Runtime::new().expect("create JavaScript runtime");
        let context = rquickjs::Context::full(&runtime).expect("create JavaScript context");
        let encoded = serde_json::to_string(&script).expect("encode renderer script");
        context.with(|ctx| {
            let parsed: bool = ctx
                .eval(format!("new Function({encoded}); true"))
                .expect("parse renderer script containing literal metadata");
            assert!(parsed);
        });
    }

    #[test]
    fn codex_app_compatibility_script_is_valid_javascript() {
        let runtime = rquickjs::Runtime::new().expect("create JavaScript runtime");
        let context = rquickjs::Context::full(&runtime).expect("create JavaScript context");
        let script = build_model_picker_unlock_script(&CodexModelCatalogProjection::empty());
        let encoded = serde_json::to_string(&script).expect("encode renderer script");

        context.with(|ctx| {
            let parsed: bool = ctx
                .eval(format!("new Function({encoded}); true"))
                .expect("parse renderer compatibility script");
            assert!(parsed);
        });
    }

    #[test]
    fn renderer_compatibility_probe_rejects_reloads_stale_versions_and_changed_metadata() {
        let catalog = CodexModelCatalogProjection {
            default_model: Some("relay".to_string()),
            model_provider: Some("codex_model_router_v2".to_string()),
            catalog_available: true,
            model_names: vec!["relay".to_string()],
            models: vec![json!({"model": "relay", "inputModalities": ["text", "image"]})],
        };
        let runtime = rquickjs::Runtime::new().expect("create JavaScript runtime");
        let context = rquickjs::Context::full(&runtime).expect("create JavaScript context");
        let payload = serde_json::to_string(&catalog).expect("serialize catalog");
        let runtime_fingerprint = codex_renderer_runtime_fingerprint();
        let probe = codex_renderer_compatibility_probe_script(&catalog);
        let script = format!(
            r#"
const window = {{}};
const probe = () => {probe};
const reloaded = probe();
const state = {{payload: {payload}, rendererRuntimeFingerprint: {runtime_fingerprint:?}, interval: 1, messagePatchInstalled: true}};
window[{MODEL_PICKER_PATCH_KEY:?}] = state;
const current = probe();
state.payload.models[0].inputModalities = ["text"];
const changedMetadata = probe();
state.payload = {payload};
state.rendererRuntimeFingerprint = "old";
const staleVersion = probe();
state.rendererRuntimeFingerprint = {runtime_fingerprint:?};
state.interval = null;
const stopped = probe();
JSON.stringify({{reloaded, current, changedMetadata, staleVersion, stopped}});
"#
        );
        context.with(|ctx| {
            let result: String = ctx.eval(script).expect("execute renderer probe");
            assert_eq!(
                serde_json::from_str::<Value>(&result).unwrap(),
                json!({
                    "reloaded": false, "current": true, "changedMetadata": false,
                    "staleVersion": false, "stopped": false
                })
            );
        });
    }

    #[tokio::test]
    async fn compatibility_install_evaluates_each_document_without_session_scoped_registration() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind CDP test listener");
        let address = listener.local_addr().expect("read CDP test address");
        let server = tokio::spawn(async move {
            let mut methods = Vec::new();
            for _ in 0..2 {
                let (socket, _) = listener.accept().await.expect("accept CDP connection");
                let mut socket = tokio_tungstenite::accept_async(socket)
                    .await
                    .expect("accept CDP websocket");
                for _ in 0..2 {
                    let message = socket
                        .next()
                        .await
                        .expect("read command")
                        .expect("valid command");
                    let command: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
                    let method = command["method"].as_str().unwrap();
                    methods.push(method.to_string());
                    let result = if method == "Runtime.evaluate" {
                        json!({"result": {"value": {
                            "status": "ok", "patchKey": MODEL_PICKER_PATCH_KEY,
                            "modelCount": 0, "appServerPatchInstalled": true
                        }}})
                    } else {
                        json!({})
                    };
                    socket
                        .send(Message::Text(
                            json!({"id": command["id"], "result": result})
                                .to_string()
                                .into(),
                        ))
                        .await
                        .expect("reply to command");
                }
            }
            methods
        });
        for _ in 0..2 {
            let evidence = install_script(&format!("ws://{address}"), "true", None)
                .await
                .expect("install current document script");
            assert!(evidence.app_server_patch_installed);
        }
        assert_eq!(
            server.await.unwrap(),
            vec![
                "Runtime.enable",
                "Runtime.evaluate",
                "Runtime.enable",
                "Runtime.evaluate"
            ]
        );
    }

    /// 验证 CDP 返回值能准确区分“脚本已安装”和“原生历史同步已请求”。
    #[test]
    fn compatibility_evidence_reads_native_history_sync_result() {
        let evaluation = json!({
            "result": {
                "result": {
                    "value": {
                        "status": "ok",
                        "patchKey": MODEL_PICKER_PATCH_KEY,
                        "historySync": {
                            "requested": true,
                            "complete": false,
                            "afterCount": 17
                        },
                        "historyQueryPatch": {
                            "patched": true,
                            "refreshRequested": true
                        }
                    }
                }
            }
        });

        let evidence = codex_app_compatibility_evidence_from_evaluation(&evaluation)
            .expect("compatibility evidence");
        assert!(evidence.history_sync_requested);
        assert_eq!(evidence.history_catalog_complete, Some(false));
        assert_eq!(evidence.history_catalog_count, Some(17));
        assert!(evidence.all_provider_history_patched);
        assert!(evidence.history_refresh_requested);
    }

    #[test]
    fn compatibility_evidence_distinguishes_catalog_delivery_from_hook_readiness() {
        let evaluation = json!({
            "result": {
                "result": {
                    "value": {
                        "status": "ok",
                        "patchKey": MODEL_PICKER_PATCH_KEY,
                        "modelCount": 36,
                        "catalogDiagnostics": {
                            "reasoningModelCount": 25,
                            "maxEffortModelCount": 16,
                            "ultraEffortModelCount": 9
                        },
                        "reasoningQueryCacheCount": 0,
                        "catalogPayloadPreserved": true,
                        "appServerPatchInstalled": false,
                        "pickerDiagnostics": {
                            "status": "mismatch",
                            "pickerObserverCount": 1,
                            "effortMismatchCount": 1,
                            "missingMaxModelCount": 1
                        }
                    }
                }
            }
        });

        let evidence = codex_app_compatibility_evidence_from_evaluation(&evaluation)
            .expect("catalog delivery evidence");
        assert_eq!(evidence.model_count, 36);
        assert_eq!(
            evidence.catalog_diagnostics,
            Some(CodexModelCatalogDiagnostics {
                reasoning_model_count: 25,
                max_effort_model_count: 16,
                ultra_effort_model_count: 9,
            })
        );
        assert_eq!(evidence.reasoning_query_cache_count, Some(0));
        assert!(evidence.catalog_payload_preserved);
        assert!(!evidence.app_server_patch_installed);
        assert_eq!(
            evidence.picker_diagnostics,
            Some(CodexModelPickerDiagnostics {
                status: CodexModelPickerReadiness::Mismatch,
                picker_observer_count: 1,
                effort_mismatch_count: 1,
                missing_max_model_count: 1,
                ..Default::default()
            })
        );
    }

    #[test]
    fn compatibility_evidence_does_not_invent_missing_or_invalid_catalog_diagnostics() {
        for diagnostics in [
            None,
            Some(Value::Null),
            Some(json!({"reasoningModelCount": 1})),
            Some(json!({
                "reasoningModelCount": -1,
                "maxEffortModelCount": 0,
                "ultraEffortModelCount": 0
            })),
        ] {
            let mut value = json!({
                "status": "ok",
                "patchKey": MODEL_PICKER_PATCH_KEY,
                "historySync": {"requested": true}
            });
            if let Some(diagnostics) = diagnostics {
                value["catalogDiagnostics"] = diagnostics;
            }
            let evaluation = json!({"result": {"result": {"value": value}}});

            let evidence = codex_app_compatibility_evidence_from_evaluation(&evaluation)
                .expect("history compatibility remains usable without catalog diagnostics");
            assert_eq!(evidence.catalog_diagnostics, None);
            assert_eq!(evidence.reasoning_query_cache_count, None);
            assert!(!evidence.catalog_payload_preserved);
            assert!(!evidence.app_server_patch_installed);
            assert!(evidence.history_sync_requested);
        }
    }

    #[test]
    fn compatibility_evidence_does_not_report_history_ready_after_hydration_failure() {
        let evaluation = json!({
            "result": {
                "result": {
                    "value": {
                        "status": "ok",
                        "patchKey": MODEL_PICKER_PATCH_KEY,
                        "historySync": {"requested": true, "complete": true},
                        "historyQueryPatch": {
                            "patched": true,
                            "refreshRequested": true,
                            "lineageHydration": {
                                "repaired": [],
                                "deferred": [],
                                "failed": [{"id": "thread-1", "error": "resume failed"}]
                            }
                        }
                    }
                }
            }
        });

        let evidence = codex_app_compatibility_evidence_from_evaluation(&evaluation)
            .expect("compatibility evidence");
        assert!(evidence.all_provider_history_patched);
        assert!(!evidence.history_refresh_requested);
    }

    /// 验证 Desktop 可执行文件缺失时，错误信息不会被误读成不支持 CLI/app-server。
    #[test]
    fn desktop_executable_missing_message_preserves_cli_support_boundary() {
        let message = codex_desktop_executable_not_found_message();
        assert!(message.contains("Desktop menu unlock flow"));
        assert!(message.contains("will not launch CLI/app-server codex as an Electron shell"));
        assert!(message.contains("Codex CLI/app-server is still supported"));
        assert!(message.contains("model_catalog_json"));
        assert!(message.contains("/v1/models"));
    }

    #[test]
    fn shared_cdp_port_requires_explicit_codex_target() {
        let targets = vec![CdpTarget {
            id: "chrome-page".to_string(),
            target_type: "page".to_string(),
            title: "Chrome".to_string(),
            url: "https://example.com".to_string(),
            web_socket_debugger_url: Some("ws://127.0.0.1:9222/devtools/page/1".to_string()),
        }];

        assert!(pick_codex_page_targets(&targets, 9222).is_err());
    }

    #[test]
    fn renderer_failure_message_distinguishes_detected_cdp_target_from_missing_port() {
        let reachable = codex_renderer_injection_failure_message(true);
        assert!(reachable.contains("renderer target detected on a CDP port"));
        assert!(!reachable.contains("reachable over CDP"));
        assert!(reachable.contains("before restarting Codex"));

        let missing = codex_renderer_injection_failure_message(false);
        assert!(missing.contains("without an injectable CDP port"));
        assert!(missing.contains("Fully quit Codex"));
    }

    #[test]
    fn windows_codex_package_candidates_cover_known_desktop_layouts() {
        let root = PathBuf::from(r"C:\Program Files\WindowsApps\OpenAI.Codex_26.608.1.0_x64__id");
        let candidates = windows_codex_package_executable_candidates(&root);

        assert!(candidates.contains(&root.join("app").join("ChatGPT.exe")));
        assert!(candidates.contains(&root.join("app").join("Codex.exe")));
        assert!(candidates.contains(&root.join("app").join("resources").join("Codex.exe")));
        assert!(!candidates.iter().any(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == "codex.exe")
        }));
    }

    /// 验证 Appx manifest 里的新版 `ChatGPT.exe` 与旧版 `Codex.exe` 都会进入候选。
    #[test]
    fn appx_manifest_candidates_use_declared_desktop_executable() {
        let package_dir = tempfile::tempdir().expect("create appx package temp dir");
        std::fs::write(
            package_dir.path().join("AppxManifest.xml"),
            r#"
<Package>
  <Applications>
    <Application Id="UnifiedApp" Executable="app/ChatGPT.exe" EntryPoint="Windows.FullTrustApplication" />
    <Application Id="App" Executable="app/bin/Codex.exe" EntryPoint="Windows.FullTrustApplication" />
    <Application Id="Cli" Executable="app/resources/codex.exe" EntryPoint="Windows.FullTrustApplication" />
  </Applications>
</Package>
"#,
        )
        .expect("write appx manifest");

        let candidates = windows_codex_package_executable_candidates(package_dir.path());

        assert_eq!(candidates[0], package_dir.path().join(r"app\ChatGPT.exe"));
        assert!(candidates.contains(&package_dir.path().join(r"app\bin\Codex.exe")));
        assert!(!candidates.iter().any(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == "codex.exe")
        }));
    }

    /// 验证 MSIX/Appx 包名版本解析兼容稳定版和预览版包名。
    #[test]
    fn codex_desktop_version_sort_keys_parse_package_and_appx_versions() {
        assert_eq!(
            version_tuple_from_package_name("OpenAI.Codex_26.623.141536.0_x64__2p2nqsd0c76g0"),
            vec![26, 623, 141536, 0]
        );
        assert_eq!(
            version_tuple_from_package_name("OpenAI.Codex.Preview_27.1.2.3_x64__2p2nqsd0c76g0"),
            vec![27, 1, 2, 3]
        );
        assert_eq!(
            version_tuple_from_text("26.623.141536.0"),
            vec![26, 623, 141536, 0]
        );
        assert!(version_tuple_from_package_name("Other.Package.Without.Version").is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn powershell_timeout_terminates_and_reaps_stalled_child() {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut command = crate::powershell::command();
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ])
            .creation_flags(CREATE_NO_WINDOW);

        let started = Instant::now();
        let output = command_output_with_timeout(&mut command, Duration::from_secs(1));

        assert!(output.is_none(), "stalled PowerShell should time out");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "timed-out PowerShell child must be terminated and reaped promptly"
        );
    }

    /// 验证只接受平台 Desktop shell，避免把 CLI/app-server `codex` 用于 renderer 解锁。
    #[test]
    fn codex_desktop_executable_validation_rejects_cli_launcher() {
        let desktop_dir = tempfile::tempdir().expect("create desktop temp dir");
        let desktop = write_desktop_test_executable(desktop_dir.path());
        let resolved = canonical_codex_desktop_executable_path(&desktop)
            .expect("platform Desktop executable should be accepted");
        assert!(resolved.ends_with(desktop_test_executable_name()));

        let cli_dir = tempfile::tempdir().expect("create cli temp dir");
        let cli = cli_dir.path().join(cli_test_executable_name());
        std::fs::write(&cli, "").expect("write cli exe");
        let error = canonical_codex_desktop_executable_path(&cli)
            .expect_err("lowercase CLI codex should be rejected");
        assert!(error.contains("not Codex Desktop"));
    }

    /// 验证新版通用壳只有位于 OpenAI.Codex 包目录时才会被接入 Codex 修复链路。
    #[cfg(target_os = "windows")]
    #[test]
    fn unified_chatgpt_shell_requires_codex_msix_ancestor() {
        let package_dir = tempfile::tempdir().expect("create windows apps temp dir");
        let package_root = package_dir
            .path()
            .join("OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0");
        let shell = package_root.join("app").join("ChatGPT.exe");
        std::fs::create_dir_all(shell.parent().expect("unified shell parent"))
            .expect("create unified shell parent");
        std::fs::write(&shell, "").expect("write unified shell");

        let resolved = canonical_codex_desktop_executable_path(&shell)
            .expect("OpenAI.Codex unified shell should be accepted");
        assert!(resolved.ends_with(Path::new("app").join("ChatGPT.exe")));

        let unrelated = package_dir.path().join("ChatGPT.exe");
        std::fs::write(&unrelated, "").expect("write unrelated ChatGPT shell");
        assert!(canonical_codex_desktop_executable_path(&unrelated).is_err());
    }

    /// 验证运行中进程探测也按可执行文件名精确区分 Desktop 和小写 app-server。
    #[cfg(target_os = "windows")]
    #[test]
    fn codex_main_process_probe_filters_cli_launcher_name_case() {
        assert!(DETECT_CODEX_MAIN_PROCESS_SCRIPT.contains("$legacyCodex = $leaf -ceq 'Codex.exe'"));
        assert!(DETECT_CODEX_MAIN_PROCESS_SCRIPT.contains("Name = 'ChatGPT.exe'"));
        assert!(DETECT_CODEX_MAIN_PROCESS_SCRIPT.contains("OpenAI\\.Codex"));
        assert!(!DETECT_CODEX_MAIN_PROCESS_SCRIPT.contains(" -ieq 'Codex.exe'"));
    }

    /// 验证已确认的 Desktop 路径能写入状态文件并再次读回。
    #[test]
    fn remembered_codex_desktop_executable_round_trips_confirmed_path() {
        let desktop_dir = tempfile::tempdir().expect("create confirmed desktop temp dir");
        let desktop = write_desktop_test_executable(desktop_dir.path());
        let state_dir = tempfile::tempdir().expect("create state temp dir");
        let state_path = state_dir
            .path()
            .join(REMEMBERED_CODEX_DESKTOP_EXECUTABLE_FILENAME);

        let remembered = remember_codex_desktop_executable_at(&state_path, &desktop)
            .expect("remember confirmed desktop path");
        let loaded = read_remembered_codex_desktop_executable_from(&state_path)
            .expect("read remembered desktop path");

        assert_eq!(loaded, remembered);
        assert!(loaded.ends_with(desktop_test_executable_name()));
    }

    /// 旧 Codex.app 和统一 ChatGPT.app 都必须按 bundle 元数据解析主程序，不能硬编码壳名称。
    #[test]
    fn macos_codex_bundle_metadata_accepts_legacy_and_unified_shells() {
        assert_eq!(
            macos_codex_bundle_executable_from_metadata(
                Path::new("/Applications/Codex.app"),
                "com.openai.codex",
                "Codex",
            ),
            Some(PathBuf::from(
                "/Applications/Codex.app/Contents/MacOS/Codex"
            ))
        );
        assert_eq!(
            macos_codex_bundle_executable_from_metadata(
                Path::new("/Applications/ChatGPT.app"),
                "com.openai.codex",
                "ChatGPT",
            ),
            Some(PathBuf::from(
                "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"
            ))
        );
    }

    /// 独立 ChatGPT 即使目录和主程序同名，也不能进入 Codex Desktop/CDP 链路。
    #[test]
    fn macos_chatgpt_bundle_rejects_non_codex_identity_and_unsafe_executable_names() {
        assert_eq!(
            macos_codex_bundle_executable_from_metadata(
                Path::new("/Applications/ChatGPT.app"),
                "com.openai.chat",
                "ChatGPT",
            ),
            None
        );
        assert_eq!(
            macos_codex_bundle_executable_from_metadata(
                Path::new("/Applications/ChatGPT.app"),
                "com.openai.codex",
                "../Codex",
            ),
            None
        );
    }

    /// 反查 bundle 时兼容两代包装，但拒绝 Framework 内部 Service.app 和无关应用。
    #[test]
    fn macos_codex_bundle_ancestor_accepts_only_supported_top_level_shells() {
        assert_eq!(
            macos_codex_bundle_ancestor(Path::new("/Applications/Codex.app/Contents/MacOS/Codex")),
            Some(PathBuf::from("/Applications/Codex.app"))
        );
        assert_eq!(
            macos_codex_bundle_ancestor(Path::new(
                "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"
            )),
            Some(PathBuf::from("/Applications/ChatGPT.app"))
        );
        assert_eq!(
            macos_codex_bundle_ancestor(Path::new("/Applications/Other.app/Contents/MacOS/Other")),
            None
        );
    }

    /// Spotlight 不可用时也必须从系统和用户 Applications 目录发现统一壳。
    #[test]
    fn macos_common_candidates_include_legacy_and_unified_bundles() {
        let candidates = macos_codex_common_bundle_candidates();
        assert!(candidates.contains(&PathBuf::from("/Applications/Codex.app")));
        assert!(candidates.contains(&PathBuf::from("/Applications/ChatGPT.app")));
        if let Some(home) = std::env::var_os("HOME") {
            let applications = PathBuf::from(home).join("Applications");
            assert!(candidates.contains(&applications.join("Codex.app")));
            assert!(candidates.contains(&applications.join("ChatGPT.app")));
        }
    }

    /// 验证 Linux desktop entry 只提取绝对路径 Exec，忽略包装命令。
    #[test]
    fn linux_desktop_entry_exec_parser_keeps_absolute_exec_paths() {
        let values = linux_desktop_entry_exec_values(
            "Name=Codex\nExec=/opt/Codex/Codex --no-sandbox %U\nExec=flatpak run com.openai.Codex\n",
        );
        assert_eq!(values, vec!["/opt/Codex/Codex"]);
    }

    #[test]
    fn default_cdp_port_waits_for_positive_codex_page_identity() {
        let targets = vec![CdpTarget {
            id: "codex-page".to_string(),
            target_type: "page".to_string(),
            title: String::new(),
            url: String::new(),
            web_socket_debugger_url: Some("ws://127.0.0.1:9229/devtools/page/1".to_string()),
        }];

        assert!(pick_codex_page_targets(&targets, DEFAULT_CODEX_DEBUG_PORT).is_err());
    }

    #[test]
    fn default_cdp_port_rejects_non_codex_electron_pages() {
        let targets = vec![CdpTarget {
            id: "other-app".to_string(),
            target_type: "page".to_string(),
            title: "Other Electron App".to_string(),
            url: "app://other/index.html".to_string(),
            web_socket_debugger_url: Some("ws://127.0.0.1:9229/devtools/page/1".to_string()),
        }];
        assert!(pick_codex_page_targets(&targets, DEFAULT_CODEX_DEBUG_PORT).is_err());
        assert!(pick_codex_page_targets(&targets, 9222).is_err());
    }

    #[test]
    fn packaged_codex_shell_url_is_accepted_even_when_task_title_has_no_codex_marker() {
        let targets = vec![CdpTarget {
            id: "codex-task".to_string(),
            target_type: "page".to_string(),
            title: "Fix production payment blockers".to_string(),
            url: "app://-/index.html".to_string(),
            web_socket_debugger_url: Some("ws://127.0.0.1:9229/devtools/page/1".to_string()),
        }];

        assert!(pick_codex_page_targets_with_listener_identity(&targets, false).is_err());
        let picked = pick_codex_page_targets_with_listener_identity(&targets, true)
            .expect("the packaged Codex renderer target should be recognized");
        assert_eq!(picked[0].id, "codex-task");
    }

    #[test]
    fn packaged_shell_url_needs_verified_listener_on_shared_cdp_ports() {
        for url in ["app://-/index.html", "app://-/"] {
            let target = CdpTarget {
                id: "generic-shell".to_string(),
                target_type: "page".to_string(),
                title: "Other Electron App".to_string(),
                url: url.to_string(),
                web_socket_debugger_url: Some("ws://127.0.0.1:9222/devtools/page/1".to_string()),
            };
            assert!(!target_matches_codex_desktop(&target, false));
            assert!(target_matches_codex_desktop(&target, true));
        }
    }

    #[test]
    fn cdp_listener_identity_requires_matching_verified_shell_pid() {
        let shell = crate::commands::CodexAppServerProcessDiagnostics {
            pid: 41,
            name: Some("ChatGPT.exe".to_string()),
            executable_path: None,
            command_line: None,
            started_at: None,
            is_app_server: false,
        };
        let app_server = crate::commands::CodexAppServerProcessDiagnostics {
            pid: 42,
            is_app_server: true,
            ..shell.clone()
        };
        let processes = [shell, app_server];
        assert!(cdp_listener_belongs_to_verified_codex_shell(
            &[41],
            &processes
        ));
        assert!(!cdp_listener_belongs_to_verified_codex_shell(
            &[42],
            &processes
        ));
        assert!(!cdp_listener_belongs_to_verified_codex_shell(
            &[99],
            &processes
        ));
        assert!(!cdp_listener_belongs_to_verified_codex_shell(
            &[41, 99],
            &processes
        ));
        assert!(!cdp_listener_belongs_to_verified_codex_shell(
            &[],
            &processes
        ));
        assert!(!cdp_listener_belongs_to_verified_codex_shell(&[41], &[]));
    }

    #[test]
    fn cdp_listener_pid_parser_rejects_invalid_and_zero_process_ids() {
        assert_eq!(
            parse_cdp_listener_process_ids("41\np42\np42\np0\n-7\nnot-a-pid\n"),
            vec![41, 42]
        );
    }

    #[test]
    fn cdp_ports_never_treat_codex_web_pages_as_desktop_renderers() {
        for url in [
            "https://example.org/codex",
            "http://localhost:3000/codex",
            "chrome://newtab/",
        ] {
            let targets = vec![CdpTarget {
                id: "browser-page".to_string(),
                target_type: "page".to_string(),
                title: "Codex".to_string(),
                url: url.to_string(),
                web_socket_debugger_url: Some("ws://127.0.0.1:9229/devtools/page/1".to_string()),
            }];
            assert!(pick_codex_page_targets(&targets, DEFAULT_CODEX_DEBUG_PORT).is_err());
            assert!(pick_codex_page_targets(&targets, 9222).is_err());
        }
    }

    #[test]
    fn codex_cdp_port_injects_all_matching_pages() {
        let targets = vec![
            CdpTarget {
                id: "codex-main".to_string(),
                target_type: "page".to_string(),
                title: "Codex".to_string(),
                url: "app://codex/index.html".to_string(),
                web_socket_debugger_url: Some("ws://127.0.0.1:9229/devtools/page/1".to_string()),
            },
            CdpTarget {
                id: "codex-dialog".to_string(),
                target_type: "page".to_string(),
                title: "Codex".to_string(),
                url: "app://codex/dialog.html".to_string(),
                web_socket_debugger_url: Some("ws://127.0.0.1:9229/devtools/page/2".to_string()),
            },
        ];

        let picked = pick_codex_page_targets(&targets, DEFAULT_CODEX_DEBUG_PORT)
            .expect("all Codex targets should be injectable");
        assert_eq!(
            picked
                .iter()
                .map(|target| target.id.as_str())
                .collect::<Vec<_>>(),
            vec!["codex-main", "codex-dialog"]
        );
    }
}
