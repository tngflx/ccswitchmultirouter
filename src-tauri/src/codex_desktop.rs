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
#[cfg(any(target_os = "macos", test))]
const CODEX_DESKTOP_BUNDLE_IDENTIFIER: &str = "com.openai.codex";

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
    tauri::async_runtime::spawn(async {
        if let Err(error) = sync_codex_request_health_warnings().await {
            log::debug!("[RequestHealth] Codex advisory warning was not injected: {error}");
        }
    });
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
    history_sync_requested: bool,
    history_catalog_complete: Option<bool>,
    history_catalog_count: Option<usize>,
    all_provider_history_patched: bool,
    history_refresh_requested: bool,
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

impl CodexModelCatalogProjection {
    /// 构造不含路由模型的兼容投影，使历史目录修复不依赖 CCSM 模型目录是否已生成。
    fn empty() -> Self {
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

/// 尝试为当前或新启动的 Codex App 安装 renderer 兼容层。
/// Summary/restart handoff core for oversized Codex sessions.
///
/// 副作用：
/// - 若发现已开放 CDP 的 Codex renderer，会触发新版历史目录同步并修复模型菜单；
/// - 若未发现 CDP 且 Codex 未运行，会以 remote debugging 参数启动 Codex。
pub async fn unlock_codex_model_picker() -> Result<CodexModelPickerUnlockResult, String> {
    let catalog = load_cc_switch_model_catalog_projection().unwrap_or_else(|_| {
        let mut projection = CodexModelCatalogProjection::empty();
        projection.model_provider = read_current_codex_model_provider();
        projection
    });
    let attempted_ports = candidate_debug_ports(DEFAULT_CODEX_DEBUG_PORT);

    if let Some(result) = try_inject_on_candidate_ports(&catalog, &attempted_ports).await {
        return Ok(result);
    }

    let running_main = detect_running_codex_main_process();
    if let Some(running_main) = running_main {
        let remembered = remember_codex_desktop_executable(&running_main).ok();
        return Ok(CodexModelPickerUnlockResult {
            attempted_ports,
            debug_port: None,
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
            message: "Codex App is already running without an injectable CDP port. Fully quit Codex, then launch it from CCSwitchMulti so the history catalog and model compatibility layer can be installed.".to_string(),
        });
    }

    let executable =
        resolve_codex_executable().ok_or_else(codex_desktop_executable_not_found_message)?;
    launch_codex_with_debug_port(&executable, DEFAULT_CODEX_DEBUG_PORT)?;

    let mut last_result = None;
    for _ in 0..30 {
        if let Some(result) =
            try_inject_on_candidate_ports(&catalog, &[DEFAULT_CODEX_DEBUG_PORT]).await
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
pub(crate) fn load_cc_switch_model_catalog_projection(
) -> Result<CodexModelCatalogProjection, String> {
    let catalog_path = crate::codex_config::get_codex_model_catalog_path();
    let default_model = read_current_codex_default_model();
    let model_provider = read_current_codex_model_provider();
    let mut candidates = Vec::new();

    if let Ok(catalog) = crate::config::read_json_file::<Value>(&catalog_path) {
        candidates.push(catalog);
    }

    let cache_path = crate::codex_config::get_codex_config_dir().join("models_cache.json");
    if let Ok(cache) = crate::config::read_json_file::<Value>(&cache_path) {
        if cache.get("etag").and_then(Value::as_str) == Some("cc-switch-model-catalog") {
            candidates.push(cache);
        }
    }

    if let Some(inline_catalog) = read_active_codex_provider_inline_model_catalog() {
        candidates.push(inline_catalog);
    }

    for candidate in &candidates {
        if let Some(projection) = codex_model_catalog_projection_from_value(
            candidate,
            default_model.clone(),
            model_provider.clone(),
        ) {
            return Ok(projection);
        }
    }

    Err(format!(
        "No routed models were found in {}, the CCSwitchMulti models cache, or the active provider inline catalog",
        catalog_path.display()
    ))
}

/// 从单个目录值构造 renderer 投影。
///
/// `models: []` 是一个结构上完整且权威的目录，不能继续回退到陈旧缓存；
/// 只有缺少数组或形状损坏的值才返回 `None`，让调用方尝试下一个来源。
fn codex_model_catalog_projection_from_value(
    catalog: &Value,
    default_model: Option<String>,
    model_provider: Option<String>,
) -> Option<CodexModelCatalogProjection> {
    let has_structural_models_array =
        catalog.get("models").is_some_and(Value::is_array) || catalog.is_array();
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
    r#"
  const normalizedCatalogProvider = (value) =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  const selectCatalogPayload = (previousPayload, incomingPayload) => {
    const incomingProvider = normalizedCatalogProvider(incomingPayload?.modelProvider);
    const previousProvider = normalizedCatalogProvider(previousPayload?.modelProvider);
    const preservePreviousCatalog =
      incomingPayload?.catalogAvailable !== true &&
      previousPayload?.catalogAvailable === true &&
      incomingProvider !== null &&
      incomingProvider === previousProvider;
    if (!preservePreviousCatalog) return incomingPayload;
    return {
      ...incomingPayload,
      defaultModel: previousPayload.defaultModel,
      modelNames: Array.isArray(previousPayload.modelNames)
        ? [...previousPayload.modelNames]
        : [],
      models: Array.isArray(previousPayload.models)
        ? [...previousPayload.models]
        : [],
      catalogAvailable: true,
    };
  };
"#
}

fn app_server_model_list_scope_core_script() -> &'static str {
    r#"
  const normalizedHostId = (value) =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  const requestHostIds = (client, params) => [
    client?.hostId,
    client?.host_id,
    params?.hostId,
    params?.host_id,
    params?.host?.hostId,
    params?.host?.host_id,
    params?.params?.hostId,
    params?.params?.host_id,
    params?.params?.host?.hostId,
    params?.params?.host?.host_id,
  ].map(normalizedHostId).filter(Boolean);
  const isLocalAppServerTarget = (client, params, sourceIsLocalView = false) => {
    const hosts = requestHostIds(client, params);
    return hosts.length > 0
      ? hosts.every((hostId) => hostId === "local")
      : sourceIsLocalView;
  };
  const currentManagedCatalogProvider = () => {
    const provider = currentModelProvider();
    return provider && provider !== "openai" && state.payload?.catalogAvailable === true
      ? provider
      : null;
  };
  const isModelListMethod = (method) =>
    method === "list-models-for-host" || method === "model/list";
  const captureModelListScope = (method, params, client, sourceIsLocalView = false) => {
    if (!isModelListMethod(method) ||
        !isLocalAppServerTarget(client, params, sourceIsLocalView)) return null;
    const provider = currentManagedCatalogProvider();
    const providers = [
      params?.modelProvider, params?.model_provider,
      params?.params?.modelProvider, params?.params?.model_provider,
    ].map(normalizedCatalogProvider).filter(Boolean);
    // Current Codex Desktop sends `model/list` without a provider field. The
    // local app-server client and active catalog already establish the scope;
    // rejecting this request leaves the picker with an unpatched response.
    return provider && (!providers.length || providers.every((value) => value === provider))
      ? { provider, hostId: "local", providerEpoch: state.catalogProviderEpoch || 0 }
      : null;
  };
  const isCurrentModelListScope = (scope, client, params) =>
    Boolean(scope) &&
    scope.provider === currentManagedCatalogProvider() &&
    scope.providerEpoch === (state.catalogProviderEpoch || 0) &&
    isLocalAppServerTarget(client || scope, params);
"#
}

/// 从当前活动 provider 的 TOML 内联 `models` 读取最后一道模型菜单回退。
///
/// 生成 live config 时，CCSM 会把同一份路由目录同时投射到 JSON catalog、models cache
/// 和活动 provider 内联数组。任一 JSON 文件短暂不可读时，内联数组仍能避免整次 Desktop
/// 会话安装空白名单；这里仅读取活动 provider，不能把未启用 provider 的模型重新注入。
fn read_active_codex_provider_inline_model_catalog() -> Option<Value> {
    let text = crate::codex_config::read_codex_config_text().ok()?;
    let parsed = text.parse::<toml::Value>().ok()?;
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

/// 读取当前 Codex 默认模型，用于 renderer 动态配置的 default_model。
fn read_current_codex_default_model() -> Option<String> {
    let text = crate::codex_config::read_codex_config_text().ok()?;
    let parsed = text.parse::<toml::Value>().ok()?;
    parsed
        .get("model")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

/// 读取当前 live Codex Provider，供 renderer 在冷恢复旧任务时覆盖历史 Provider 标签。
fn read_current_codex_model_provider() -> Option<String> {
    let text = crate::codex_config::read_codex_config_text().ok()?;
    let parsed = text.parse::<toml::Value>().ok()?;
    parsed
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

/// 在候选 CDP 端口中寻找 Codex renderer 并安装模型白名单补丁。
pub(crate) async fn try_inject_on_candidate_ports(
    catalog: &CodexModelCatalogProjection,
    ports: &[u16],
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
        let script = build_model_picker_unlock_script(catalog);
        let mut injected_target = None;
        let mut compatibility_evidence = CodexAppCompatibilityEvidence::default();
        for target in targets {
            let Some(websocket_url) = target.web_socket_debugger_url.as_deref() else {
                continue;
            };
            if let Ok(evidence) =
                install_script(websocket_url, &script, launch_timezone.as_deref()).await
            {
                if evidence.history_sync_requested
                    || evidence.history_catalog_complete.is_some()
                    || evidence.all_provider_history_patched
                {
                    compatibility_evidence = evidence;
                }
                injected_target.get_or_insert(target);
            }
        }
        let Some(target) = injected_target else {
            continue;
        };
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
            message: if compatibility_evidence.all_provider_history_patched {
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
/// 共享调试端口如 9222 可能属于 Chrome 或其它 Electron 应用，必须看到 Codex
/// 标识才注入；CCSwitchMulti 自己启动的默认 9229 允许在标题还没初始化时退回
/// 到第一个 page target。
pub(crate) fn pick_codex_page_targets(
    targets: &[CdpTarget],
    debug_port: u16,
) -> Result<Vec<CdpTarget>, String> {
    let pages = targets.iter().filter(|target| {
        target.target_type == "page"
            && target
                .web_socket_debugger_url
                .as_deref()
                .is_some_and(|url| !url.is_empty())
    });
    let mut all_pages = Vec::new();
    let mut codex_pages = Vec::new();
    for target in pages {
        all_pages.push(target.clone());
        if target_matches_codex_desktop(target) {
            codex_pages.push(target.clone());
        }
    }
    if !codex_pages.is_empty() {
        return Ok(codex_pages);
    }
    if debug_port == DEFAULT_CODEX_DEBUG_PORT && !all_pages.is_empty() {
        return Ok(all_pages);
    }
    Err("No Codex Desktop page target was found on shared CDP port".to_string())
}

/// 判断 CDP target 的标题或 URL 是否明确指向 Codex Desktop。
fn target_matches_codex_desktop(target: &CdpTarget) -> bool {
    let haystack = format!("{} {}", target.title, target.url).to_ascii_lowercase();
    haystack.contains("codex") || haystack.contains("app://")
}

/// 使用 CDP 同时安装新文档脚本并立即 patch 当前页面。
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
    session.send_command(3, "Page.enable", json!({})).await?;
    session
        .send_command(
            4,
            "Page.addScriptToEvaluateOnNewDocument",
            json!({ "source": script }),
        )
        .await?;
    // 只有 Runtime.evaluate 会返回当前 renderer 的执行结果；新文档脚本注册命令只返回
    // identifier，不能用来判断 localThreadCatalog 是否真正触发。
    let evaluation = session
        .send_command(
            5,
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
    let history_sync = value.get("historySync").unwrap_or(&Value::Null);
    let history_query_patch = value.get("historyQueryPatch").unwrap_or(&Value::Null);
    let history_hydration_failed = history_query_patch
        .pointer("/lineageHydration/failed")
        .and_then(Value::as_array)
        .is_some_and(|failures| !failures.is_empty());
    Ok(CodexAppCompatibilityEvidence {
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
    let (socket, _) = tokio::time::timeout(CDP_CONNECT_TIMEOUT, connect_async(websocket_url))
        .await
        .map_err(|_| "timed out connecting CDP websocket".to_string())?
        .map_err(|error| format!("failed to connect CDP websocket: {error}"))?;
    let mut session = CdpSession::new(socket);
    session.send_command(1, "Runtime.enable", json!({})).await?;
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
    include_str!("resources/codex_model_picker_core.js")
}

/// The V5 renderer patch accidentally added model-whitelist fields to every
/// Statsig dynamic config instead of only the model catalog config. When those
/// fields reached Guardian V2, the bundled app-server rejected the request as
/// an invalid `FeatureToml` even though the on-disk `config.toml` was valid.
/// Keep the repair and exact-error fallback independent from model/history code
/// so the compatibility boundary can be executed directly in QuickJS tests.
fn guardian_v2_compatibility_patch_core_script() -> &'static str {
    r#"
  const guardianV2DynamicConfigName = "2553103476";
  const guardianV2FlatFeatureKey = "features.guardianv2";
  const statsigModelWhitelistConfigName = "107580212";
  const legacyModelWhitelistFields = ["available_models", "use_hidden_models", "default_model"];
  const guardianV2Enabled = (value) => value?.enabled === true;
  const isGuardianV2StructuredValue = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const stripLegacyModelWhitelistPollution = (config) => {
    const value = config?.value;
    if (!isGuardianV2StructuredValue(value) || !legacyModelWhitelistFields.some((key) => Object.prototype.hasOwnProperty.call(value, key))) return config;
    const nextValue = { ...value };
    for (const key of legacyModelWhitelistFields) delete nextValue[key];
    return { ...config, value: nextValue };
  };
  const patchGuardianV2DynamicConfig = (name, config) => {
    if (String(name || "") !== guardianV2DynamicConfigName) return config;
    return stripLegacyModelWhitelistPollution(config);
  };
  const prepareStatsigDynamicConfig = (name, config, repairLegacyPollution = false) => {
    const normalizedName = String(name || "");
    config = patchGuardianV2DynamicConfig(normalizedName, config);
    if (normalizedName === statsigModelWhitelistConfigName) {
      return { config, patchModelWhitelist: true };
    }
    return {
      config: repairLegacyPollution ? stripLegacyModelWhitelistPollution(config) : config,
      patchModelWhitelist: false,
    };
  };
  const isGuardianV2FeatureTomlError = (error) => {
    const message = String(error?.message || error || "");
    return message.includes("FeatureToml") && message.includes("features.guardianv2");
  };
  const downgradeGuardianV2Config = (config) => {
    if (!config || typeof config !== "object" || Array.isArray(config)) return config;
    let next = config;
    let changed = false;
    const flat = config[guardianV2FlatFeatureKey];
    if (isGuardianV2StructuredValue(flat)) {
      next = { ...next, [guardianV2FlatFeatureKey]: guardianV2Enabled(flat) };
      changed = true;
    }
    const features = config.features;
    if (isGuardianV2StructuredValue(features) && isGuardianV2StructuredValue(features.guardianv2)) {
      if (!changed) next = { ...next };
      next.features = { ...features, guardianv2: guardianV2Enabled(features.guardianv2) };
      changed = true;
    }
    return changed ? next : config;
  };
  const guardianV2FallbackRequestParams = (method, params) => {
    const wrapped = method === "send-cli-request-for-host" && params?.params && typeof params.params === "object";
    const requestParams = wrapped ? params.params : params;
    if (!requestParams || typeof requestParams !== "object" || Array.isArray(requestParams)) return params;
    const nextConfig = downgradeGuardianV2Config(requestParams.config);
    if (nextConfig === requestParams.config) return params;
    const nextRequestParams = { ...requestParams, config: nextConfig };
    return wrapped ? { ...params, params: nextRequestParams } : nextRequestParams;
  };
"#
}

/// App-server 请求兼容核心，同时嵌入 renderer 并由 QuickJS 行为测试直接执行。
///
/// `thread/list` 继续显式查询所有 Provider；`thread/resume` 则以当前 live Provider
/// 覆盖历史线程保存的旧入口标签，使跨 Provider 历史在冷恢复后重新经过 CCSM Router。
fn app_server_request_normalization_core_script() -> &'static str {
    r#"
  const appServerRequestPatchVersion = "11";
  const appServerRequestClientNeedsPatch = (client) => client?.__ccSwitchModelRequestPatch !== appServerRequestPatchVersion;
  const appServerMethod = (method, params) => method === "send-cli-request-for-host" && params?.method ? String(params.method) : String(method || "");
  const currentModelProvider = () => {
    const value = state.payload?.modelProvider;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const normalizeAppServerRequestParams = (method, params) => {
    const actualMethod = appServerMethod(method, params);
    if (actualMethod === "thread/list") {
      if (method === "send-cli-request-for-host" && params?.params?.modelProviders == null) {
        return { ...params, params: { ...(params?.params || {}), modelProviders: [] } };
      }
      if (params == null) return { modelProviders: [] };
      return params?.modelProviders == null ? { ...params, modelProviders: [] } : params;
    }
    if (actualMethod !== "thread/resume") return params;
    const modelProvider = currentModelProvider();
    if (!modelProvider) return params;
    if (method === "send-cli-request-for-host") {
      const requestParams = params?.params;
      if (!requestParams || typeof requestParams !== "object" || Array.isArray(requestParams) || requestParams.modelProvider === modelProvider) return params;
      return { ...params, params: { ...requestParams, modelProvider } };
    }
    if (!params || typeof params !== "object" || Array.isArray(params) || params.modelProvider === modelProvider) return params;
    return { ...params, modelProvider };
  };
"#
}

/// Codex Desktop refreshes thread metadata independently from the loaded transcript. After
/// `thread/revert`, the stable thread ID remains unchanged while `thread.path` moves to a new
/// rollout. An already loaded conversation can therefore retain the old rollout path and turns.
/// Rehydrate only idle conversations whose cached path is demonstrably stale; active turns are
/// deferred so the compatibility layer never interrupts live work.
fn history_lineage_hydration_core_script() -> &'static str {
    r#"
  const normalizedRolloutPath = (value) => typeof value === "string"
    ? value.replaceAll("\\", "/").replace(/^\/\/?\?\//, "").toLowerCase()
    : "";
  const conversationHasActiveTurn = (conversation) => {
    if (Array.isArray(conversation?.turns)
        && conversation.turns.some((turn) => turn?.status === "inProgress")) return true;
    const history = conversation?.turnHistory?.kind === "canonical"
      ? conversation.turnHistory.history
      : null;
    const entities = history?.entitiesByKey;
    return entities && typeof entities === "object"
      ? Object.values(entities).some((turn) => turn?.status === "inProgress")
      : false;
  };
  const canonicalHistoryIsFragmented = (conversation) => {
    const history = conversation?.turnHistory?.kind === "canonical"
      ? conversation.turnHistory.history
      : null;
    return history?.isComplete !== true
      && Array.isArray(history?.islands)
      && history.islands.length > 1;
  };
  const planHistoryLineageRehydration = (manager) => {
    const repair = [];
    const deferred = [];
    const conversations = typeof manager?.getCachedConversations === "function"
      ? manager.getCachedConversations()
      : [];
    const metadata = manager?.threadStore?.threadsById;
    for (const conversation of Array.isArray(conversations) ? conversations : []) {
      const id = typeof conversation?.id === "string" ? conversation.id : "";
      if (!id || !metadata || typeof metadata.get !== "function") continue;
      const currentPath = normalizedRolloutPath(conversation.rolloutPath);
      const activePath = normalizedRolloutPath(metadata.get(id)?.path);
      if (!activePath) continue;
      const pathChanged = currentPath !== activePath;
      if (!pathChanged && !canonicalHistoryIsFragmented(conversation)) continue;
      const streaming = typeof manager?.isConversationStreaming === "function"
        && manager.isConversationStreaming(id);
      if (streaming || conversationHasActiveTurn(conversation)) deferred.push(id);
      else repair.push(id);
    }
    return { repair, deferred };
  };
  const rehydrateStaleHistoryLineages = async (manager) => {
    const plan = planHistoryLineageRehydration(manager);
    const repaired = [];
    const failed = [];
    for (const id of plan.repair) {
      const previous = manager.getConversation(id);
      const activePath = manager.threadStore.threadsById.get(id)?.path;
      try {
        manager.updateConversationState(id, (conversation) => {
          conversation.rolloutPath = activePath;
          conversation.turns = [];
          // Codex 26.901 renders canonical turnHistory when present. Clearing only the
          // legacy turns overlay leaves the stale islands visible and causes resume to
          // merge the new tail into the broken cache instead of replacing it.
          delete conversation.turnHistory;
          conversation.turnsPagination = {
            olderCursor: null,
            oldestLoadedTurnId: null,
            isLoadingOlder: false,
            hasLoadedOldest: false,
          };
          conversation.resumeState = "needs_resume";
        });
        const resume = await manager.resumeConversationForUnavailableOwner({
          conversationId: id,
          model: null,
          serviceTier: null,
          reasoningEffort: null,
          workspaceRoots: previous?.cwd ? [previous.cwd] : ["/"],
          collaborationMode: previous?.latestCollaborationMode || null,
        });
        if (resume?.status === "not-ready") {
          throw new Error(`Codex App could not resume history: ${String(resume.reason || "not-ready")}`);
        }
        // Resume intentionally hydrates only the newest page for paginated histories.
        // Ask Codex's own pagination layer to close every remaining boundary so a
        // fragmented middle cannot remain hidden behind a stale virtual-list island.
        if (typeof manager.getCompleteConversationTurns === "function") {
          await manager.getCompleteConversationTurns(id);
        }
        repaired.push(id);
      } catch (error) {
        if (previous) manager.setConversation(previous);
        failed.push({ id, error: String(error?.message || error) });
      }
    }
    return { repaired, deferred: plan.deferred, failed };
  };
"#
}

/// Locate real request clients from legacy signals or the current app-shared
/// scoped registry. Declared descriptors exclude RPC proxies, and retained app
/// scopes let each heartbeat observe a replaced client without scanning React.
fn app_server_module_client_discovery_core_script() -> &'static str {
    include_str!("resources/codex_client_discovery_core.js")
}

fn request_health_warning_core_script(suppressed: bool) -> String {
    let suppressed = if suppressed { "true" } else { "false" };
    (r###"
  state.requestHealthWarningsSuppressed = {suppressed};
  const requestHealthWarningStorageKey = "ccswitch-request-health-warnings-v1";
  const requestHealthWarningContainerId = "ccswitch-request-health-warning-container";
  const readStoredRequestHealthWarnings = () => {
    try {
      const stored = JSON.parse(localStorage.getItem(requestHealthWarningStorageKey) || "[]");
      return Array.isArray(stored) ? stored : [];
    } catch { return []; }
  };
  const renderRequestHealthWarnings = (warnings) => {
    if (state.requestHealthWarningsSuppressed) {
      try { localStorage.removeItem(requestHealthWarningStorageKey); } catch {}
      document.getElementById(requestHealthWarningContainerId)?.remove();
      if (state.requestHealthWarningExpiryTimer) clearTimeout(state.requestHealthWarningExpiryTimer);
      state.requestHealthWarningExpiryTimer = null;
      return { active: 0 };
    }
    const now = Date.now();
    const active = (Array.isArray(warnings) ? warnings : [])
      .filter((warning) => warning && String(warning.token || "").trim() && Number(warning.expiresAtMs) > now)
      .sort((left, right) => Number(left.expiresAtMs) - Number(right.expiresAtMs));
    try {
      if (active.length) localStorage.setItem(requestHealthWarningStorageKey, JSON.stringify(active));
      else localStorage.removeItem(requestHealthWarningStorageKey);
    } catch {}
    let container = document.getElementById(requestHealthWarningContainerId);
    if (!active.length) {
      container?.remove();
      if (state.requestHealthWarningExpiryTimer) clearTimeout(state.requestHealthWarningExpiryTimer);
      state.requestHealthWarningExpiryTimer = null;
      return { active: 0 };
    }
    if (!container) {
      container = document.createElement("section");
      container.id = requestHealthWarningContainerId;
      container.setAttribute("role", "status");
      container.setAttribute("aria-live", "assertive");
      Object.assign(container.style, { position: "fixed", top: "16px", right: "16px", zIndex: "2147483647", display: "grid", gap: "8px", width: "min(420px, calc(100vw - 32px))", maxHeight: "calc(100vh - 32px)", overflowY: "auto", pointerEvents: "none", fontFamily: "system-ui, sans-serif" });
      (document.body || document.documentElement).appendChild(container);
    }
    const activeTokens = new Set(active.map((warning) => String(warning.token)));
    for (const existing of container.querySelectorAll("[data-ccswitch-request-health-token]")) {
      if (!activeTokens.has(String(existing.getAttribute("data-ccswitch-request-health-token")))) existing.remove();
    }
    for (const warning of active) {
      const token = String(warning.token);
      let card = Array.from(container.querySelectorAll("[data-ccswitch-request-health-token]")).find((candidate) => candidate.getAttribute("data-ccswitch-request-health-token") === token);
      if (!card) {
        card = document.createElement("article");
        card.setAttribute("data-ccswitch-request-health-token", token);
        Object.assign(card.style, { border: "1px solid rgba(245, 158, 11, .65)", borderRadius: "10px", background: "rgba(24, 24, 27, .96)", color: "#fafafa", boxShadow: "0 18px 48px rgba(0,0,0,.38)", padding: "12px 14px", lineHeight: "1.4", pointerEvents: "none" });
        container.appendChild(card);
      }
      card.replaceChildren();
      const title = document.createElement("strong");
      title.textContent = String(warning.title || "Request paused for approval");
      const detail = document.createElement("div");
      detail.textContent = String(warning.detail || "");
      const instruction = document.createElement("div");
      instruction.textContent = String(warning.instruction || "");
      Object.assign(instruction.style, { marginTop: "7px", fontSize: "12px", fontWeight: "600", color: "#fbbf24" });
      card.append(title, detail, instruction);
    }
    if (state.requestHealthWarningExpiryTimer) clearTimeout(state.requestHealthWarningExpiryTimer);
    const nextExpiry = Math.min(...active.map((warning) => Number(warning.expiresAtMs)));
    state.requestHealthWarningExpiryTimer = setTimeout(() => {
      if (!state.requestHealthWarningsSuppressed) {
        renderRequestHealthWarnings(readStoredRequestHealthWarnings());
      }
    }, Math.max(50, nextExpiry - now + 25));
    return { active: active.length };
  };
  state.syncRequestHealthWarnings = (warnings, suppressed = state.requestHealthWarningsSuppressed) => {
    state.requestHealthWarningsSuppressed = Boolean(suppressed);
    return renderRequestHealthWarnings(warnings);
  };
  if (state.requestHealthWarningsSuppressed) {
    try { localStorage.removeItem(requestHealthWarningStorageKey); } catch {}
    renderRequestHealthWarnings([]);
  } else {
    renderRequestHealthWarnings(readStoredRequestHealthWarnings());
  }
"###)
        .replace("{suppressed}", suppressed)
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
    (r#"
  const rememberHandoffClient = (client) => {
    if (!client || typeof client.sendRequest !== "function") return;
    state.appServerClients = Array.isArray(state.appServerClients) ? state.appServerClients : [];
    if (!state.appServerClients.includes(client)) state.appServerClients.push(client);
  };
  const readExactHandoffThread = async (client, threadId, includeTurns) => {
    const response = await client.sendRequest("thread/read", { threadId, includeTurns });
    const thread = response?.thread || response;
    const returnedThreadId = String(thread?.id || "").trim();
    if (returnedThreadId !== threadId) {
      throw new Error(returnedThreadId
        ? `Codex returned the wrong task ${returnedThreadId} instead of ${threadId}`
        : `Codex did not return task ${threadId}`);
    }
    return thread;
  };
  const discoverHandoffClients = async () => {
    try { await installAppServerPatch(); } catch (error) { recordFailure(error); }
    const clients = (Array.isArray(state.appServerClients) ? state.appServerClients : [])
      .filter((client, index, array) => client && typeof client.sendRequest === "function" && array.indexOf(client) === index);
    if (!clients.length) throw new Error("Codex Desktop request client was not found");
    return clients;
  };
  const extractAssistantText = (value, seen = new WeakSet()) => {
    if (!value || typeof value !== "object") return [];
    if (seen.has(value)) return [];
    seen.add(value);
    if (Array.isArray(value)) return value.flatMap((item) => extractAssistantText(item, seen));
    const type = String(value.type || "").toLowerCase();
    const role = String(value.role || "").toLowerCase();
    const own = (role === "assistant" || type === "agentmessage" || type === "assistant_message")
      ? [value.text, value.content].flatMap((item) => typeof item === "string" ? [item] : extractAssistantText(item, seen)).filter(Boolean)
      : [];
    return [...own, ...Object.values(value).flatMap((item) => extractAssistantText(item, seen))];
  };
  const runSummarizeSession = async (threadId) => {
    const normalizedThreadId = String(threadId || "").trim();
    if (!normalizedThreadId) throw new Error("A Codex thread id is required");
    const clients = await discoverHandoffClients();
    let lastError = null;
    for (const client of clients) {
      let mutationAttempted = false;
      try {
        const idleDeadline = Date.now() + 30000;
        let before = null;
        const interrupted = new Set();
        while (Date.now() < idleDeadline) {
          before = await readExactHandoffThread(client, normalizedThreadId, true);
          if (String(before?.status?.type || "") !== "active") break;
          const active = [...(before?.turns || [])].reverse().find((turn) => String(turn?.status || "") === "inProgress");
          const activeTurnId = String(active?.id || "").trim();
          if (activeTurnId && !interrupted.has(activeTurnId)) {
            interrupted.add(activeTurnId);
            mutationAttempted = true;
            await client.sendRequest("turn/interrupt", { threadId: normalizedThreadId, turnId: activeTurnId });
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (String(before?.status?.type || "") === "active") throw new Error("Timed out interrupting the source turn");
        mutationAttempted = true;
        const started = await client.sendRequest("turn/start", {
          threadId: normalizedThreadId,
          input: [{ type: "text", text: __CCSWITCH_MANUAL_SUMMARY_PROMPT__ }],
        });
        const summaryTurnId = String(started?.turn?.id || started?.turnId || started?.turn_id || "").trim();
        if (!summaryTurnId) throw new Error("Codex did not return the manual summary turn id");
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 750));
          const current = await readExactHandoffThread(client, normalizedThreadId, true);
          const turn = (current?.turns || []).find((candidate) => candidate?.id === summaryTurnId);
          const status = String(turn?.status || "").toLowerCase();
          if (status === "completed") {
            const summary = [...new Set(extractAssistantText(turn))].map((value) => String(value).trim()).filter(Boolean).join("\n").trim();
            if (!summary) throw new Error("Codex completed without a manual handoff summary");
            return { summary };
          }
          if (status === "failed" || status === "interrupted") throw new Error(`Manual summary turn ${status}`);
        }
        throw new Error("Timed out waiting for the manual handoff summary");
      } catch (error) {
        if (mutationAttempted) throw error;
        lastError = error;
      }
    }
    throw lastError || new Error("Codex Desktop could not summarize the session");
  };
  const verifyFreshHandoff = (thread, source, newThreadId, phase) => {
    if (String(thread?.id || "").trim() !== newThreadId) throw new Error(`Codex returned the wrong fresh task during ${phase}`);
    if (String(thread?.projectId || "").trim() !== String(source.projectId || "").trim()) throw new Error(`Fresh session ${phase} changed project ownership`);
    if (source.cwd && String(thread?.cwd || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase() !== String(source.cwd).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()) throw new Error(`Fresh session ${phase} changed workspace`);
    for (const field of ["model", "modelProvider", "reasoningEffort"]) {
      if (source[field] != null && JSON.stringify(thread?.[field]) !== JSON.stringify(source[field])) throw new Error(`Fresh session ${phase} changed ${field}`);
    }
    return String(thread?.name || "").trim();
  };
  const runFreshSessionFromSummary = async (sourceThreadId, summary) => {
    const sourceId = String(sourceThreadId || "").trim();
    const handoffSummary = String(summary || "").trim();
    if (!sourceId) throw new Error("A Codex source thread id is required");
    if (!handoffSummary) throw new Error("The manual handoff summary is empty");
    const clients = await discoverHandoffClients();
    let lastError = null;
    for (const client of clients) {
      let mutationAttempted = false;
      try {
        const source = await readExactHandoffThread(client, sourceId, false);
        const startParams = { config: { model_reasoning_effort: String(source?.reasoningEffort || "medium") } };
        for (const key of ["cwd", "model", "modelProvider"]) if (source?.[key]) startParams[key] = source[key];
        mutationAttempted = true;
        const started = await client.sendRequest("thread/start", startParams);
        let fresh = started?.thread || started;
        const newThreadId = String(fresh?.id || started?.threadId || started?.thread_id || "").trim();
        if (!newThreadId || newThreadId === sourceId) throw new Error("Codex did not create a fresh root session");
        if (fresh?.forkedFromId || fresh?.forked_from_id) throw new Error("Codex created a fork instead of a fresh root session");
        fresh = await readExactHandoffThread(client, newThreadId, false);
        let freshName = verifyFreshHandoff(fresh, source, newThreadId, "before acknowledgement");
        if (!freshName) {
          await client.sendRequest("thread/name/set", { threadId: newThreadId, name: `Handoff - ${String(source?.name || "continued task").trim()}`.slice(0, 120) });
          fresh = await readExactHandoffThread(client, newThreadId, false);
          freshName = verifyFreshHandoff(fresh, source, newThreadId, "after naming");
        }
        const acknowledged = await client.sendRequest("turn/start", {
          threadId: newThreadId,
          input: [{ type: "text", text: [
            "Fresh-session handoff from an oversized prior task.",
            "Use the summary below as reference context only. Do not execute its action items or call tools in this acknowledgement turn; wait for the user's next instruction.",
            handoffSummary,
          ].join("\n") }],
        });
        const turnId = String(acknowledged?.turn?.id || acknowledged?.turnId || acknowledged?.turn_id || "").trim();
        if (!turnId) throw new Error("Codex did not return the fresh-session handoff turn id");
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 750));
          const current = await readExactHandoffThread(client, newThreadId, true);
          const turn = (current?.turns || []).find((candidate) => candidate?.id === turnId);
          const status = String(turn?.status || "").toLowerCase();
          if (status === "completed") {
            freshName = verifyFreshHandoff(current, source, newThreadId, "after acknowledgement") || freshName;
            try { await triggerLocalThreadCatalogSync(); } catch (error) { recordFailure(error); }
            return { newThreadId, turnId, name: freshName };
          }
          if (status === "failed" || status === "interrupted") throw new Error(`Fresh-session handoff turn ${status}`);
        }
        throw new Error("Timed out waiting for the fresh-session handoff");
      } catch (error) {
        if (mutationAttempted) throw error;
        lastError = error;
      }
    }
    throw lastError || new Error("Codex Desktop could not create the fresh handoff session");
  };
  state.summarizeJobs = state.summarizeJobs || {};
  state.startSummarizeSession = (threadId) => {
    const id = String(threadId || "").trim();
    if (!id) throw new Error("A Codex thread id is required");
    const existing = Object.entries(state.summarizeJobs).find(([, job]) => job?.threadId === id && job?.status === "pending");
    if (existing) return { started: true, jobId: existing[0] };
    const jobId = `${id}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    state.summarizeJobs[jobId] = { status: "pending", threadId: id };
    void runSummarizeSession(id).then((result) => { state.summarizeJobs[jobId] = { ...state.summarizeJobs[jobId], ...result, status: "completed" }; }, (error) => { state.summarizeJobs[jobId] = { ...state.summarizeJobs[jobId], status: "failed", reason: String(error?.message || error) }; });
    return { started: true, jobId };
  };
  state.readSummarizeJob = (jobId) => state.summarizeJobs[String(jobId || "")] || null;
  state.freshSessionJobs = state.freshSessionJobs || {};
  state.startFreshSessionFromSummary = (sourceThreadId, summary) => {
    const sourceId = String(sourceThreadId || "").trim();
    const handoffSummary = String(summary || "").trim();
    if (!sourceId) throw new Error("A Codex source thread id is required");
    if (!handoffSummary) throw new Error("The manual handoff summary is empty");
    const existing = Object.entries(state.freshSessionJobs).find(([, job]) => job?.sourceThreadId === sourceId && job?.status === "pending");
    if (existing) return { started: true, jobId: existing[0] };
    const jobId = `${sourceId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    state.freshSessionJobs[jobId] = { status: "pending", sourceThreadId: sourceId };
    void runFreshSessionFromSummary(sourceId, handoffSummary).then((result) => { state.freshSessionJobs[jobId] = { ...state.freshSessionJobs[jobId], ...result, status: "completed" }; }, (error) => { state.freshSessionJobs[jobId] = { ...state.freshSessionJobs[jobId], status: "failed", reason: String(error?.message || error) }; });
    return { started: true, jobId };
  };
  state.readFreshSessionJob = (jobId) => state.freshSessionJobs[String(jobId || "")] || null;
"#)
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
                            .to_string()
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
    include_str!("resources/codex_continuation_core.js")
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
    let start_script = format!(
        r#"(() => {{
          const state = window[{patch_key:?}];
          if (!state || typeof state.startCodexContinuation !== 'function') return {{started:false, reason:'Codex compatibility layer is not ready'}};
          return state.startCodexContinuation({thread_id_json}, {recovery_id_json}, {expected_model_json}, {observed_at_ms});
        }})()"#,
        patch_key = MODEL_PICKER_PATCH_KEY,
    );
    let mut diagnostics = Vec::new();
    for port in candidate_debug_ports(DEFAULT_CODEX_DEBUG_PORT) {
        let targets = match list_cdp_targets(port).await {
            Ok(value) => value,
            Err(error) => {
                diagnostics.push(format!("port {port}: {error}"));
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
        for target in targets {
            let Some(websocket_url) = target.web_socket_debugger_url.as_deref() else {
                continue;
            };
            // This synchronous expression only registers a job. If its reply
            // is lost, do not try another renderer: the job may be submitting.
            let evaluation = match evaluate_cdp_expression(websocket_url, &start_script).await {
                Ok(value) => value,
                Err(error) => return Err(format!("target {}: {error}", target.id)),
            };
            if let Some(exception) = evaluation.pointer("/result/exceptionDetails") {
                return Err(format!(
                    "target {}: CDP evaluation failed: {exception}",
                    target.id
                ));
            }
            let started = evaluation
                .pointer("/result/result/value")
                .cloned()
                .unwrap_or(Value::Null);
            if !started
                .get("started")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                diagnostics.push(format!(
                    "target {}: {}",
                    target.id,
                    started
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("Continuation was not started")
                ));
                continue;
            }
            let poll_script = format!(
                r#"(() => {{
                  const state = window[{patch_key:?}];
                  return state && typeof state.readCodexContinuationJob === 'function' ? state.readCodexContinuationJob({recovery_id_json}) : null;
                }})()"#,
                patch_key = MODEL_PICKER_PATCH_KEY,
            );
            let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
            loop {
                let evaluation = evaluate_cdp_expression(websocket_url, &poll_script).await?;
                let value = evaluation
                    .pointer("/result/result/value")
                    .cloned()
                    .unwrap_or(Value::Null);
                if value.get("status").and_then(Value::as_str) == Some("completed") {
                    return Ok(CodexContinuationResult {
                        submitted: value
                            .get("submitted")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        mutation_attempted: value
                            .get("mutationAttempted")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        debug_port: Some(port),
                        target_id: Some(target.id),
                        message: value
                            .get("reason")
                            .and_then(Value::as_str)
                            .unwrap_or("Codex did not confirm the targeted continuation")
                            .to_string(),
                    });
                }
                if tokio::time::Instant::now() >= deadline {
                    return Err(format!("target {}: continuation is still pending; no second submission was attempted", target.id));
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
    }
    Err(if diagnostics.is_empty() {
        "No Codex Desktop CDP target was found".to_string()
    } else {
        diagnostics.join("; ")
    })
}

/// 构造 renderer 注入脚本：触发新版本地历史目录同步，并修复模型白名单和缓存。
fn build_model_picker_unlock_script(catalog: &CodexModelCatalogProjection) -> String {
    let payload = serde_json::to_string(catalog).unwrap_or_else(|_| "{}".to_string());
    let catalog_payload_selection_core = catalog_payload_selection_core_script();
    let app_server_model_list_scope_core = app_server_model_list_scope_core_script();
    let model_patch_core = model_picker_patch_core_script();
    let guardian_v2_patch_core = guardian_v2_compatibility_patch_core_script();
    let request_normalization_core = app_server_request_normalization_core_script();
    let history_lineage_hydration_core = history_lineage_hydration_core_script();
    let module_client_discovery_core = app_server_module_client_discovery_core_script();
    let settings = crate::settings::get_settings();
    let request_health_warning_suppressed = CODEX_REQUEST_HEALTH_WARNINGS_SUPPRESSED
        .load(Ordering::Acquire)
        || !crate::settings::request_health_windows_notifications_active(&settings.request_health);
    let request_health_warning_core =
        request_health_warning_core_script(request_health_warning_suppressed);
    let summary_handoff_core = summary_handoff_core_script();
    let codex_continuation_core = codex_continuation_core_script();
    format!(
        r#"
(async () => {{
  const incomingPayload = {payload};
  const patchKey = "{MODEL_PICKER_PATCH_KEY}";
  const state = window[patchKey] || {{}};
{catalog_payload_selection_core}
  const previousPayload = state.payload;
  const payload = selectCatalogPayload(previousPayload, incomingPayload);
  const preservePreviousCatalog =
    payload !== incomingPayload && payload?.catalogAvailable === true;
  // Bump this whenever the injected app-server/request patch changes. The
  // scheduler closure captures those functions; leaving an older interval
  // alive would reapply stale recovery hooks over the new patch.
  const rendererSchedulerVersion = "7";
  if (state.rendererSchedulerVersion !== rendererSchedulerVersion) {{
    if (state.interval) clearInterval(state.interval);
    try {{ state.reactRootObserver?.disconnect(); }} catch {{}}
    state.interval = null;
    state.runPromise = null;
    state.reactRootObserver = null;
    state.reactDiscoveryPromise = null;
    // Older discovery admitted dynamic RPC stubs before patching failed. Drop
    // that registry so continuation can use only declared request clients.
    state.appServerClients = [];
    state.requestIds = new Map();
    state.modelListRequestScopes = new Map();
    state.messagePatchInstalled = false;
    state.appServerModuleRetryAt = 0;
    state.scopedAppServerScopes = new Set();
    state.pendingReactNodes = new Set();
    state.lastReactFullScanAt = 0;
    state.lastReactIncrementalScanAt = 0;
    state.rendererSchedulerVersion = rendererSchedulerVersion;
  }}
  if (normalizedCatalogProvider(previousPayload?.modelProvider) !==
      normalizedCatalogProvider(payload?.modelProvider)) {{
    state.catalogProviderEpoch = (state.catalogProviderEpoch || 0) + 1;
  }}
  state.payload = payload;
  state.catalogPayloadPreserved = preservePreviousCatalog;
  state.requestIds = state.requestIds instanceof Map ? state.requestIds : new Map();
  state.modelListRequestScopes = state.modelListRequestScopes || new Map();
  state.modulePromises = state.modulePromises || new Map();
  state.failures = state.failures || [];
  state.pendingReactNodes = state.pendingReactNodes || new Set();
  state.historyManagerCandidates = state.historyManagerCandidates || new Set();
  const recordFailure = (error) => {{
    const message = String(error?.message || error);
    if (state.failures.at(-1) !== message) state.failures.push(message);
    state.failures = state.failures.slice(-20);
  }};
  window[patchKey] = state;
{model_patch_core}
{guardian_v2_patch_core}
{request_normalization_core}
{history_lineage_hydration_core}
{module_client_discovery_core}
{request_health_warning_core}
{summary_handoff_core}
{codex_continuation_core}
  const patchStatsigConfig = (name, config, repairLegacyPollution = false) => {{
    const prepared = prepareStatsigDynamicConfig(name, config, repairLegacyPollution);
    config = prepared.config;
    if (!prepared.patchModelWhitelist) return config;
    const value = config?.value;
    if (!value || typeof value !== "object") return config;
    const available = Array.isArray(value.available_models) ? [...value.available_models] : [];
    let changed = false;
    for (const name of modelNames()) {{
      if (!available.includes(name)) {{
        available.push(name);
        changed = true;
      }}
    }}
    const nextValue = {{ ...value, available_models: available, use_hidden_models: false, default_model: modelNames()[0] || value.default_model }};
    if (changed || nextValue.default_model !== value.default_model || value.use_hidden_models !== false) {{
      try {{
        config.value = nextValue;
      }} catch {{
        return {{ ...config, value: nextValue }};
      }}
    }}
    return config;
  }};
  const statsigClients = () => {{
    const root = window.__STATSIG__ || globalThis.__STATSIG__;
    if (!root || typeof root !== "object") return [];
    const clients = [root.firstInstance, typeof root.instance === "function" ? root.instance() : null];
    if (root.instances && typeof root.instances === "object") clients.push(...Object.values(root.instances));
    return clients.filter((client, index, array) => client && typeof client === "object" && array.indexOf(client) === index);
  }};
  const patchStatsig = () => {{
    for (const client of statsigClients()) {{
      if (typeof client.getDynamicConfig !== "function") continue;
      if (client.__ccSwitchStatsigPatchVersion !== "2") {{
        const repairingLegacyPatch = client.__ccSwitchModelWhitelistPatched === true;
        const original = client.__ccSwitchOriginalGetDynamicConfig || client.getDynamicConfig.bind(client);
        client.__ccSwitchOriginalGetDynamicConfig = original;
        client.getDynamicConfig = (name, options) => patchStatsigConfig(name, original(name, options), repairingLegacyPatch);
        client.__ccSwitchStatsigPatchVersion = "2";
      }}
      try {{ patchStatsigConfig("107580212", client.getDynamicConfig("107580212", {{ disableExposureLog: true }})); }} catch {{}}
      try {{ patchStatsigConfig(guardianV2DynamicConfigName, client.getDynamicConfig(guardianV2DynamicConfigName, {{ disableExposureLog: true }})); }} catch {{}}
    }}
  }};
  const visibleAssetUrls = () => [
      ...Array.from(document.scripts || []).map((script) => script.src),
      ...Array.from(document.querySelectorAll("link[href]") || []).map((link) => link.href),
      ...performance.getEntriesByType("resource").map((entry) => entry.name),
    ].filter((url, index, urls) => Boolean(url) && urls.indexOf(url) === index);
  const assetUrl = async (namePart) => {{
    const urls = visibleAssetUrls();
    const direct = urls.find((url) => url.includes("/assets/") && url.includes(namePart) && url.split("?")[0].endsWith(".js"));
    if (direct) return direct;

    // Newer Codex builds keep only index-*.js visible and reference rpc/app chunks
    // from the Vite dependency table. Follow those same-origin module references
    // instead of depending on one hashed filename or Performance API behavior.
    const inspected = new Set();
    for (let index = 0; index < urls.length && index < 32; index += 1) {{
      const url = urls[index];
      if (!url || inspected.has(url) || !url.split("?")[0].endsWith(".js")) continue;
      inspected.add(url);
      let source = "";
      try {{
        source = await fetch(url).then((response) => response.ok ? response.text() : "");
      }} catch {{}}
      for (const match of source.matchAll(/["'](\.\/[^"']+\.js)["']/g)) {{
        const candidate = new URL(match[1], url).href;
        if (candidate.includes(namePart)) return candidate;
        if (!urls.includes(candidate)) urls.push(candidate);
      }}
    }}
    return "";
  }};
  const loadAppModule = async (namePart) => {{
    if (!state.modulePromises.has(namePart)) {{
      state.modulePromises.set(namePart, Promise.resolve().then(async () => {{
        const url = await assetUrl(namePart);
        if (!url) throw new Error(`Codex App asset not found: ${{namePart}}`);
        return await import(url);
      }}).catch((error) => {{
        state.modulePromises.delete(namePart);
        throw error;
      }}));
    }}
    return await state.modulePromises.get(namePart);
  }};
  const localCatalogFromModule = (module) => {{
    // 26.825+ exports both an unresolved RpcPromise (`appHost`) and the
    // initialized RpcStub (`appServices`). Prefer the initialized service;
    // otherwise the first shallow export looks valid but fails inside
    // readStatus/readSnapshot.
    const initialized = module?.appServices?.localThreadCatalog;
    if (initialized && typeof initialized.requestStartupSync === "function") return initialized;
    const roots = Object.values(module).filter((item) => item && (typeof item === "object" || typeof item === "function"));
    for (const root of roots) {{
      const catalog = root.localThreadCatalog;
      if (catalog && typeof catalog.requestStartupSync === "function") return catalog;
    }}
    return null;
  }};
  const summarizeCatalogStatus = (status, requested) => {{
    const local = Array.isArray(status?.hosts) ? status.hosts.find((host) => host?.hostId === "local") : null;
    return {{
      requested,
      complete: local?.isComplete ?? null,
      revision: local?.revision ?? status?.revision ?? null,
      source: "status",
    }};
  }};
  // 新版 Codex/ChatGPT App 用 localThreadCatalog 保存统一侧边栏目录。这里只调用
  // App 自己的 RPC 同步服务，不直接改 codex-dev.db 或历史 provider 元数据。
  const triggerLocalThreadCatalogSync = async () => {{
    if (state.historySyncPromise) return await state.historySyncPromise;
    state.historySyncPromise = Promise.resolve().then(async () => {{
      const module = await loadAppModule("rpc-");
      const catalog = localCatalogFromModule(module);
      if (!catalog || typeof catalog.requestStartupSync !== "function") throw new Error("Codex App localThreadCatalog RPC service was not found");

      // 26.825+ exposes readStatus and can report a complete local catalog before
      // requestStartupSync. Do not wait on a redundant startup sync RPC forever.
      try {{
        const status = await catalog.readStatus();
        const summary = summarizeCatalogStatus(status, false);
        if (summary.complete === true) {{
          state.historySync = summary;
          return summary;
        }}
        state.historySync = summarizeCatalogStatus(status, true);
        Promise.resolve(catalog.requestStartupSync()).then(async () => {{
          try {{
            state.historySync = summarizeCatalogStatus(await catalog.readStatus(), true);
          }} catch (error) {{
            recordFailure(error);
          }}
        }}).catch(recordFailure);
        return state.historySync;
      }} catch (error) {{
        recordFailure(error);
      }}

      // Older builds expose readSnapshot instead of readStatus. Preserve that
      // official cold-sweep path as a capability fallback.
      try {{
          const before = typeof catalog.readSnapshot === "function" ? await catalog.readSnapshot() : null;
          await catalog.requestStartupSync();
          const after = typeof catalog.readSnapshot === "function" ? await catalog.readSnapshot() : null;
          state.historySync = {{
            requested: true,
            beforeCount: Array.isArray(before?.entries) ? before.entries.length : null,
            afterCount: Array.isArray(after?.entries) ? after.entries.length : null,
            complete: after?.isComplete ?? null,
            source: "snapshot",
          }};
          if (after?.isComplete !== true) {{
            setTimeout(() => {{ state.historySyncPromise = null; }}, 10000);
          }}
          return state.historySync;
      }} catch (error) {{
        recordFailure(error);
      }}
      throw new Error("Codex App localThreadCatalog RPC service was not found");
    }}).catch((error) => {{
      state.historySync = {{ requested: false, error: String(error?.message || error) }};
      recordFailure(error);
      state.historySyncPromise = null;
      return state.historySync;
    }});
    return await state.historySyncPromise;
  }};
{app_server_model_list_scope_core}
  const patchModelListResult = (result) => {{
    if (result == null) return false;
    let changed = false;
     if (Array.isArray(result) && patchModelArray(result, true, true)) changed = true;
     if (Array.isArray(result?.data) && patchModelArray(result.data, true, true)) changed = true;
     if (Array.isArray(result?.models) && patchModelArray(result.models, true, true)) changed = true;
     if (Array.isArray(result?.result) && patchModelArray(result.result, true, true)) changed = true;
     if (Array.isArray(result?.result?.data) && patchModelArray(result.result.data, true, true)) changed = true;
     if (Array.isArray(result?.result?.models) && patchModelArray(result.result.models, true, true)) changed = true;
     if (Array.isArray(result?.pages?.[0]?.data) && patchModelArray(result.pages[0].data, true, true)) changed = true;
     if (Array.isArray(result?.message?.result?.data) && patchModelArray(result.message.result.data, true, true)) changed = true;
     if (Array.isArray(result?.message?.result?.models) && patchModelArray(result.message.result.models, true, true)) changed = true;
     if (patchModelContainer(result, true)) changed = true;
    return changed;
  }};
  const patchAppServerResult = (method, result, scope, client, params) => {{
    if (!isModelListMethod(method) || !isCurrentModelListScope(scope, client, params)) return result;
    patchModelListResult(result);
    return result;
  }};
  const patchRequestClient = (client) => {{
    if (!client || typeof client.sendRequest !== "function") return false;
    if (!isLocalAppServerTarget(client, null)) return false;
    state.appServerClients = Array.isArray(state.appServerClients) ? state.appServerClients : [];
    if (!state.appServerClients.includes(client)) state.appServerClients.push(client);
    if (!appServerRequestClientNeedsPatch(client)) return true;
    try {{
      const original = client.__ccSwitchOriginalSendRequest || client.sendRequest.bind(client);
      client.__ccSwitchOriginalSendRequest = original;
      client.sendRequest = async function ccSwitchPatchedSendRequest(method, params, options) {{
        rememberCodexUserTurnAction(method, params);
        const normalizedParams = normalizeAppServerRequestParams(method, params);
        const actualMethod = appServerMethod(method, params);
        const modelListScope = captureModelListScope(actualMethod, normalizedParams, client);
        try {{
          const result = await original(method, normalizedParams, options);
          return patchAppServerResult(actualMethod, result, modelListScope, client, normalizedParams);
        }} catch (error) {{
          if (!isGuardianV2FeatureTomlError(error)) throw error;
          const fallbackParams = guardianV2FallbackRequestParams(method, normalizedParams);
          if (fallbackParams === normalizedParams) throw error;
          state.guardianV2FallbackCount = (state.guardianV2FallbackCount || 0) + 1;
          const result = await original(method, fallbackParams, options);
          return patchAppServerResult(actualMethod, result, modelListScope, client, fallbackParams);
        }}
      }};
      client.__ccSwitchModelRequestPatch = appServerRequestPatchVersion;
      return true;
    }} catch (error) {{
      // rpc-BaVz... also exposes immutable RpcStub objects whose method shape
      // resembles AppServerRequestClient. Skip them and keep scanning React.
      recordFailure(error);
      return false;
    }}
  }};
  const reactRootValue = (value) => {{
    let current = value;
    let hops = 0;
    try {{
      while (current?.return && hops < 2048) {{
        current = current.return;
        hops += 1;
      }}
    }} catch {{}}
    return current || value;
  }};
  const appendReactRootsFromNode = (node, values, seen) => {{
    for (const key of Object.keys(node || {{}})) {{
      if (!key.startsWith("__reactContainer") && !key.startsWith("__reactFiber") && !key.startsWith("__reactInternalInstance")) continue;
      const value = reactRootValue(node[key]);
      if (value && !seen.has(value)) {{
        seen.add(value);
        values.push(value);
      }}
    }}
  }};
  const initialReactNodes = () => [
    document.getElementById("root") || document.body,
    document.documentElement,
  ].filter(Boolean);
  const drainPendingReactNodes = () => {{
    const pending = Array.from(state.pendingReactNodes || []);
    state.pendingReactNodes.clear();
    return pending;
  }};
  const scheduleHistoryLineageHydration = (manager) => {{
    if (!state.historyQueryRefreshCompleted
        || state.historyLineageHydrationPromise
        || state.historyLineageHydrationCompleted
        || typeof manager?.getCachedConversations !== "function"
        || typeof manager?.getConversation !== "function"
        || typeof manager?.updateConversationState !== "function"
        || typeof manager?.setConversation !== "function"
        || typeof manager?.resumeConversationForUnavailableOwner !== "function") return;
    const wallNow = Date.now();
    if (wallNow < (state.historyLineageHydrationRetryAt || 0)) return;
    state.historyLineageHydrationRetryAt = wallNow + 30000;
    state.historyLineageHydrationPromise = Promise.resolve()
      .then(() => rehydrateStaleHistoryLineages(manager))
      .then((result) => {{
        state.historyLineageHydration = result;
        for (const failure of result.failed || []) recordFailure(failure.error);
        state.historyLineageHydrationCompleted = (result.deferred || []).length === 0 && (result.failed || []).length === 0;
        if (state.historyLineageHydrationCompleted) state.historyManagerCandidates.clear();
        return result;
      }})
      .catch((error) => {{
        state.historyLineageHydration = {{ repaired: [], deferred: [], failed: [{{ error: String(error?.message || error) }}] }};
        recordFailure(error);
      }})
      .finally(() => {{ state.historyLineageHydrationPromise = null; }});
  }};
  const yieldReactDiscovery = () => new Promise((resolve) => {{
    if (typeof globalThis.requestIdleCallback === "function") {{
      globalThis.requestIdleCallback(() => resolve(), {{ timeout: 50 }});
    }} else {{
      setTimeout(resolve, 0);
    }}
  }});
  const monotonicNow = () => typeof performance?.now === "function" ? performance.now() : Date.now();
  const patchReactAppServerClients = async (startingNodes) => {{
    if (state.reactDiscoveryPromise) return await state.reactDiscoveryPromise;
    state.reactDiscoveryPromise = (async () => {{
      const roots = [];
      const rootSeen = new Set();
      const nodeQueue = startingNodes.filter(Boolean);
      let nodeCursor = 0;
      while (nodeCursor < nodeQueue.length) {{
        const sliceDeadline = monotonicNow() + 4;
        let sliceCount = 0;
        while (nodeCursor < nodeQueue.length && sliceCount < 800 && monotonicNow() < sliceDeadline) {{
          sliceCount += 1;
          const node = nodeQueue[nodeCursor++];
          appendReactRootsFromNode(node, roots, rootSeen);
          try {{
            for (const child of Array.from(node?.childNodes || [])) nodeQueue.push(child);
          }} catch {{}}
        }}
        if (nodeCursor < nodeQueue.length) await yieldReactDiscovery();
      }}

      const queue = roots.map((value) => ({{ value, depth: 0 }}));
      const seen = new Set();
      let cursor = 0;
      let patched = 0;
      while (cursor < queue.length && seen.size < 140000) {{
        const sliceDeadline = monotonicNow() + 4;
        let sliceCount = 0;
        while (cursor < queue.length && seen.size < 140000 && sliceCount < 800 && monotonicNow() < sliceDeadline) {{
          sliceCount += 1;
          const {{ value, depth }} = queue[cursor++];
          if (!value || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) continue;
          seen.add(value);

          if (looksLikeAppServerRequestClient(value) && patchRequestClient(value)) patched += 1;
          const nestedClient = value?.requestClient;
          if (looksLikeAppServerRequestClient(nestedClient) && patchRequestClient(nestedClient)) {{
            patched += 1;
            if (state.historyManagerCandidates.size >= 8 && !state.historyManagerCandidates.has(value)) state.historyManagerCandidates.clear();
            state.historyManagerCandidates.add(value);
            if (!state.historyQueryRefreshPromise && !state.historyQueryRefreshCompleted && typeof value?.threadStore?.refreshRecentConversations === "function") {{
              state.historyQueryRefreshPromise = Promise.resolve().then(() =>
                value.threadStore.refreshRecentConversations({{ mode: "expanded" }})
              ).then(() => {{
                state.historyQueryRefreshCompleted = true;
              }}).catch((error) => {{
                state.historyQueryRefreshPromise = null;
                state.historyQueryRefreshCompleted = false;
                recordFailure(error);
                throw error;
              }});
            }}
            scheduleHistoryLineageHydration(value);
          }}

          if (depth >= 14) continue;
          let descriptors = {{}};
          try {{ descriptors = Object.getOwnPropertyDescriptors(value); }} catch {{}}
          for (const [key, descriptor] of Object.entries(descriptors)) {{
            if (!["window", "ownerDocument", "parentNode", "parentElement", "nextSibling", "previousSibling"].includes(key) && "value" in descriptor) {{
              const child = descriptor.value;
              if (child && ((typeof child === "object" && !(typeof Node !== "undefined" && child instanceof Node)) || typeof child === "function")) {{
                queue.push({{ value: child, depth: depth + 1 }});
              }}
            }}
          }}
        }}
        if (cursor < queue.length && seen.size < 140000) await yieldReactDiscovery();
      }}
      state.reactRequestClientPatched = state.reactRequestClientPatched || patched > 0;
      state.historyQueryPatch = {{
        patched: Boolean(state.reactRequestClientPatched),
        clientCount: patched,
        refreshRequested: Boolean(state.historyQueryRefreshCompleted),
        lineageHydration: state.historyLineageHydration || null,
      }};
      return patched;
    }})().finally(() => {{ state.reactDiscoveryPromise = null; }});
    return await state.reactDiscoveryPromise;
  }};
  const installReactRootObserver = () => {{
    if (state.reactRootObserver || typeof MutationObserver !== "function") return;
    const target = document.documentElement || document.body;
    if (!target) return;
    state.reactRootObserver = new MutationObserver((records) => {{
      for (const record of records) {{
        for (const node of record.addedNodes || []) {{
          if (!node || (typeof node !== "object" && typeof node !== "function")) continue;
          state.pendingReactNodes.add(node);
          if (state.pendingReactNodes.size > 128) {{
            state.pendingReactNodes.clear();
            state.pendingReactNodes.add(document.getElementById("root") || document.body);
          }}
        }}
      }}
    }});
    state.reactRootObserver.observe(target, {{ childList: true, subtree: true }});
  }};
  const installAppServerPatch = async () => {{
    let patched = 0;
    let modulePatched = 0;
    const wallNow = Date.now();
    if (!state.appServerModuleRetryAt || wallNow >= state.appServerModuleRetryAt) {{
      try {{
        // 26.1007+ merges the signal module into app-shared. Discover the
        // initialized local manager from its declared registry and app scope.
        try {{
          const shared = await loadAppModule("app-shared-");
          modulePatched = await patchCodexScopedAppServerClients(shared);
        }} catch {{}}
        if (modulePatched === 0) {{
          const module = await loadAppModule("app-server-manager-signals-");
          modulePatched = patchAppServerModuleClients(module);
        }}
        patched += modulePatched;
        state.appServerModuleRetryAt = modulePatched > 0 ? 0 : wallNow + 30000;
      }} catch (error) {{
        recordFailure(error);
        state.appServerModuleRetryAt = wallNow + 30000;
      }}
    }}
    installReactRootObserver();
    const fullScanDue = !state.reactInitialDiscoveryCompleted
      || (modulePatched === 0 && wallNow - (state.lastReactFullScanAt || 0) >= 30000);
    const incrementalScanDue = modulePatched === 0
      && state.pendingReactNodes.size > 0
      && wallNow - (state.lastReactIncrementalScanAt || 0) >= 5000;
    if (fullScanDue) {{
      state.pendingReactNodes.clear();
      state.lastReactFullScanAt = wallNow;
      patched += await patchReactAppServerClients(initialReactNodes());
      state.reactInitialDiscoveryCompleted = true;
    }} else if (incrementalScanDue) {{
      state.lastReactIncrementalScanAt = wallNow;
      patched += await patchReactAppServerClients(drainPendingReactNodes());
    }} else if (modulePatched > 0) {{
      state.pendingReactNodes.clear();
    }}
    if (state.historyQueryRefreshPromise) {{
      try {{
        await state.historyQueryRefreshPromise;
      }} catch {{}}
    }}
    for (const manager of state.historyManagerCandidates) scheduleHistoryLineageHydration(manager);
    if (state.historyLineageHydrationPromise) {{
      try {{
        await state.historyLineageHydrationPromise;
      }} catch {{}}
    }}
    state.historyQueryPatch = {{
      ...(state.historyQueryPatch || {{}}),
      refreshRequested: Boolean(state.historyQueryRefreshCompleted),
      lineageHydration: state.historyLineageHydration || null,
    }};
    for (const scope of state.scopedAppServerScopes || []) {{
      try {{ patchCodexModelReasoningQueryCache(scope.queryClient?.getQueryCache()); }}
      catch (error) {{ recordFailure(error); }}
    }}
    state.appServerPatchInstalled = patched > 0;
    if (patched > 0 && state.historyQueryRefreshCompleted) {{
      state.reactRequestClientPatchVersion = appServerRequestPatchVersion;
      state.appServerPatchVersion = appServerRequestPatchVersion;
    }}
  }};
  const patchMcpModelResponseData = (data) => {{
    if (data?.type !== "mcp-response") return false;
    const message = data.message || data.response;
    const requestId = message?.id != null ? String(message.id) : "";
    if (!requestId || !(state.requestIds instanceof Map)) return false;
    const scope = state.requestIds.get(requestId);
    if (!scope) return false;
    state.requestIds.delete(requestId);
    if (!isCurrentModelListScope(scope, null, message?.params || data?.params)) return false;
    return patchModelListResult(message?.result) || patchModelListResult(message?.result?.data);
  }};
  const installMessagePatch = () => {{
    if (state.messagePatchInstalled) return;
    state.messagePatchInstalled = true;
    const originalDispatchEvent = window.dispatchEvent;
    window.dispatchEvent = function ccSwitchPatchedDispatchEvent(event) {{
      try {{
        const detail = event?.detail;
        const request = detail?.request;
        if (event?.type === "codex-message-from-view" && detail?.type === "mcp-request" && request?.method === "model/list") {{
          const viewRequest = {{
            ...request,
            hostId: detail?.hostId ?? detail?.host_id ?? request?.hostId ?? request?.host_id,
          }};
          const scope = captureModelListScope("model/list", viewRequest, null, true);
          if (scope) {{
            request.params = {{ ...(request.params || {{}}), includeHidden: true }};
            if (request.id != null) state.requestIds.set(String(request.id), scope);
          }}
        }}
        if (event?.type === "message") patchMcpModelResponseData(event.data);
      }} catch (error) {{
        recordFailure(error);
      }}
      return originalDispatchEvent.call(this, event);
    }};
    window.addEventListener("message", (event) => {{
      try {{ patchMcpModelResponseData(event?.data); }} catch (error) {{ recordFailure(error); }}
    }}, true);
  }};
  const reactFiberKeys = (element) => Object.keys(element || {{}}).filter((key) => key.startsWith("__reactFiber") || key.startsWith("__reactInternalInstance") || key.startsWith("__reactProps"));
  // Codex app-server 会根据 requires_openai_auth 暴露 OAuth 状态；旧配置或缓存状态
  // 可能把 renderer 留在非 chatgpt 模式，这里只修复前端 context，不改请求路由。
  const authContextValueFrom = (element) => {{
    for (const key of reactFiberKeys(element)) {{
      for (let fiber = element?.[key]; fiber; fiber = fiber.return) {{
        for (const value of [fiber.memoizedProps?.value, fiber.pendingProps?.value]) {{
          if (value && typeof value === "object" && typeof value.setAuthMethod === "function" && "authMethod" in value) return value;
        }}
      }}
    }}
    return null;
  }};
  const spoofChatGPTAuthMethod = (element) => {{
    const auth = authContextValueFrom(element);
    if (!auth || auth.authMethod === "chatgpt") return false;
    try {{
      auth.setAuthMethod("chatgpt");
      return true;
    }} catch (error) {{
      recordFailure(error);
      return false;
    }}
  }};
  const patchReactState = () => {{
    const nodes = [document.body, ...document.querySelectorAll("button, [role='menu'], [role='dialog'], [data-radix-popper-content-wrapper]")].filter(Boolean);
    for (const node of nodes.slice(0, 220)) {{
      spoofChatGPTAuthMethod(node);
    }}
  }};
  const run = async () => {{
    if (state.runPromise) return await state.runPromise;
    state.runPromise = (async () => {{
      installMessagePatch();
      await installAppServerPatch();
      void triggerLocalThreadCatalogSync();
      patchStatsig();
      patchReactState();
    }})().finally(() => {{ state.runPromise = null; }});
    return await state.runPromise;
  }};
  await run();
  if (!state.interval) state.interval = setInterval(() => {{ void run(); }}, 1500);
  const historySync = await triggerLocalThreadCatalogSync();
  return {{ status: "ok", modelCount: modelNames().length, available_models: modelNames(), historySync, historyQueryPatch: state.historyQueryPatch || null, patchKey }};
}})()
"#
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
        let output = Command::new("powershell")
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
    let output = Command::new("powershell")
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
    let mut command = Command::new("powershell");
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
        let script = format!(
            r#"
const state = {{}};
Object.defineProperty(state, "appServerClients", {{
  set(clients) {{ this.clients = clients.map((client) => ({{ hostId: "local", getCompatibleThreadSortKey() {{}}, supportsPaginatedThreadHistory() {{}}, ...client }})); }},
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

    #[test]
    fn codex_continuation_ignores_retained_rpc_stubs_before_the_real_client() {
        let result = run_codex_continuation_probe(
            r#"
let proxyPropertyReads = 0;
let starts = 0;
const proxy = new Proxy({}, { get() { proxyPropertyReads += 1; return () => { throw new Error("stale RPC stub must not be called"); }; } });
state.clients = [proxy, {
  hostId: "local",
  getCompatibleThreadSortKey() {},
  supportsPaginatedThreadHistory() {},
  sendRequest: async (method) => {
    if (method === "turn/start") { starts += 1; return { turn: { id: "continue-turn" } }; }
    return { thread: { id: "exact-thread", turns: [{ id: "failed-turn", status: "failed" }] } };
  },
}];
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
  currentNeedsPatch: appServerRequestClientNeedsPatch({ __ccSwitchModelRequestPatch: "11" }),
  missingNeedsPatch: appServerRequestClientNeedsPatch({}),
  patchVersion: appServerRequestPatchVersion,
});
"#,
        );

        assert_eq!(result["v5NeedsPatch"], true);
        assert_eq!(result["v6NeedsPatch"], true);
        assert_eq!(result["v7NeedsPatch"], true);
        assert_eq!(result["v8NeedsPatch"], true);
        assert_eq!(result["currentNeedsPatch"], false);
        assert_eq!(result["missingNeedsPatch"], true);
        assert_eq!(result["patchVersion"], "11");
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
        assert!(script.contains("client.__ccSwitchStatsigPatchVersion !== \"2\""));
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
});
"#,
        );

        assert_eq!(result["hasDefault"], false);
        assert_eq!(result["hasEfforts"], false);
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
})));
"#,
        );

        assert_eq!(
            result,
            json!([
                {
                    "model": "xiaomi/mimo-v2.6-flash",
                    "hasDefault": false,
                    "hasEfforts": false
                },
                {
                    "model": "xiaomi/mimo-v2.6-pro",
                    "hasDefault": false,
                    "hasEfforts": false
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
  officialUnchanged: restored.models[3] === official,
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
                [],
                ["high"]
            ])
        );
        assert_eq!(result["officialUnchanged"], true);
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
        assert!(script.contains("appServerRequestPatchVersion = \"11\""));
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
        assert!(script.contains("const historySync = await triggerLocalThreadCatalogSync()"));
        assert!(script.contains("params?.modelProviders == null"));
        assert!(script.contains("if (params == null) return { modelProviders: [] }"));
        assert!(script.contains("modelProviders: []"));
        assert!(script.contains("getCompatibleThreadSortKey"));
        assert!(script.contains("document.getElementById(\"root\")"));
        assert!(!script.contains("document.querySelectorAll(\"*\")"));
        assert!(script.contains("module?.appServices?.localThreadCatalog"));
        assert!(script.contains("fetch(url)"));
        assert!(script.contains("await state.historyQueryRefreshPromise"));
        assert!(script.contains("state.historyQueryRefreshCompleted = true"));
    }

    /// The renderer heartbeat must not synchronously walk every DOM node and the
    /// complete React object graph. New app-server clients are discovered from
    /// the cached module on every heartbeat; React traversal is an incremental,
    /// idle-time fallback with one in-flight job and an observer-backed dirty set.
    #[test]
    fn codex_app_compatibility_heartbeat_does_not_repeat_full_react_scan() {
        let script = build_model_picker_unlock_script(&CodexModelCatalogProjection::empty());

        assert!(script.contains("const rendererSchedulerVersion = \"7\""));
        assert!(script
            .contains("patchCodexModelReasoningQueryCache(scope.queryClient?.getQueryCache())"));
        assert!(script.contains("clearInterval(state.interval)"));
        assert!(script.contains("const patchAppServerModuleClients"));
        assert!(script.contains("state.reactDiscoveryPromise"));
        assert!(script.contains("requestIdleCallback"));
        assert!(script.contains("const sliceDeadline = monotonicNow() + 4"));
        assert!(script.contains("sliceCount < 800"));
        assert!(script.contains("state.lastReactFullScanAt || 0) >= 30000"));
        assert!(script.contains("state.lastReactIncrementalScanAt || 0) >= 5000"));
        assert!(script.contains("new MutationObserver"));
        assert!(script.contains("modulePatched = patchAppServerModuleClients(module)"));
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
            assert_eq!(result, json!({ "firstCount": 1, "secondCount": 1, "remoteCount": 0, "patched": ["first", "second"], "registryMutations": 0, "scopeScans": 1, "queryClientReads": 0 }));
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

    /// 验证 CDP 返回值能准确区分“脚本已安装”和“原生历史同步已请求”。
    #[test]
    fn compatibility_evidence_reads_native_history_sync_result() {
        let evaluation = json!({
            "result": {
                "result": {
                    "value": {
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
    fn compatibility_evidence_does_not_report_history_ready_after_hydration_failure() {
        let evaluation = json!({
            "result": {
                "result": {
                    "value": {
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
        let mut command = Command::new("powershell");
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
    fn default_cdp_port_allows_initializing_codex_page() {
        let targets = vec![CdpTarget {
            id: "codex-page".to_string(),
            target_type: "page".to_string(),
            title: String::new(),
            url: String::new(),
            web_socket_debugger_url: Some("ws://127.0.0.1:9229/devtools/page/1".to_string()),
        }];

        let targets = pick_codex_page_targets(&targets, DEFAULT_CODEX_DEBUG_PORT)
            .expect("default Codex CDP port should allow early blank targets");
        assert_eq!(targets[0].id, "codex-page");
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
