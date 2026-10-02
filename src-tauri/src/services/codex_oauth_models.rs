//! Codex OAuth model list service.
//!
//! ChatGPT Codex exposes models through `chatgpt.com/backend-api/codex/models`,
//! which is not an OpenAI-compatible `/v1/models` endpoint.

use crate::proxy::providers::{CODEX_OAUTH_CLIENT_VERSION, CODEX_OAUTH_ORIGINATOR};
use crate::services::model_fetch::FetchedModel;
use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::Value;
use std::error::Error;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

const CODEX_OAUTH_MODELS_URL: &str = "https://chatgpt.com/backend-api/codex/models";
const CODEX_PUBLIC_MODELS_URL: &str =
    "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";
const CODEX_OAUTH_FETCH_TIMEOUT_SECS: u64 = 15;
const CODEX_PUBLIC_MODELS_FETCH_TIMEOUT_SECS: u64 = 10;
const CODEX_PUBLIC_MODELS_MAX_BYTES: u64 = 8 * 1024 * 1024;
const CODEX_PUBLIC_MODELS_FAILURE_COOLDOWN_SECS: u64 = 60;
const ERROR_BODY_MAX_CHARS: usize = 512;

static CODEX_PUBLIC_CATALOG_REFRESH_GATE: Lazy<Mutex<CatalogRefreshGate>> =
    Lazy::new(|| Mutex::new(CatalogRefreshGate::default()));
static CODEX_PUBLIC_CATALOG_REFRESH_COMPLETED: Lazy<
    tokio::sync::broadcast::Sender<CatalogRefreshCompletion>,
> =
    Lazy::new(|| {
        let (sender, _receiver) = tokio::sync::broadcast::channel(16);
        sender
    });
static CODEX_PUBLIC_CATALOG_APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> =
    std::sync::OnceLock::new();

pub(crate) fn register_public_catalog_app_handle(app_handle: tauri::AppHandle) {
    let _ = CODEX_PUBLIC_CATALOG_APP_HANDLE.set(app_handle);
}

fn reproject_after_automatic_catalog_change() {
    let Some(app_handle) = CODEX_PUBLIC_CATALOG_APP_HANDLE.get() else {
        return;
    };
    let app_handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let Some(state) = app_handle.try_state::<crate::store::AppState>() else {
            return;
        };
        match state
            .proxy_service
            .reproject_official_codex_catalog_if_owned()
            .await
        {
            Ok(crate::services::proxy::OfficialCodexCatalogProjectionOutcome::Applied) => {
                log::info!("automatically reprojected changed Codex official catalog")
            }
            Ok(crate::services::proxy::OfficialCodexCatalogProjectionOutcome::Skipped(reason)) => {
                log::debug!("skipped automatic Codex catalog reprojection: {reason}")
            }
            Err(error) => {
                log::warn!("automatic Codex catalog reprojection failed: {error}")
            }
        }
    });
}

#[derive(Default)]
struct CatalogRefreshGate {
    in_flight: bool,
    next_attempt_id: u64,
    in_flight_attempt_id: Option<u64>,
    retry_after: Option<Instant>,
}

impl CatalogRefreshGate {
    fn try_start(&mut self, now: Instant) -> Option<u64> {
        if self.in_flight
            || self
                .retry_after
                .is_some_and(|retry_after| now < retry_after)
        {
            return None;
        }
        self.in_flight = true;
        self.next_attempt_id = self.next_attempt_id.wrapping_add(1);
        let attempt_id = self.next_attempt_id;
        self.in_flight_attempt_id = Some(attempt_id);
        Some(attempt_id)
    }

    fn try_start_forced(&mut self, _now: Instant) -> Option<u64> {
        if self.in_flight {
            return None;
        }
        self.in_flight = true;
        self.next_attempt_id = self.next_attempt_id.wrapping_add(1);
        let attempt_id = self.next_attempt_id;
        self.in_flight_attempt_id = Some(attempt_id);
        Some(attempt_id)
    }

    fn in_flight_attempt_id(&self) -> Option<u64> {
        self.in_flight_attempt_id
    }

    fn finish(&mut self, now: Instant, succeeded: bool) {
        self.in_flight = false;
        self.in_flight_attempt_id = None;
        self.retry_after = (!succeeded)
            .then_some(now + Duration::from_secs(CODEX_PUBLIC_MODELS_FAILURE_COOLDOWN_SECS));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CatalogRefreshCompletion {
    attempt_id: u64,
    succeeded: bool,
}

struct CatalogRefreshPermit {
    finished: bool,
    attempt_id: u64,
}

impl CatalogRefreshPermit {
    fn try_acquire() -> Option<Self> {
        let mut gate = CODEX_PUBLIC_CATALOG_REFRESH_GATE.lock().ok()?;
        gate.try_start(Instant::now()).map(|attempt_id| Self {
            finished: false,
            attempt_id,
        })
    }

    fn finish(mut self, succeeded: bool) {
        if let Ok(mut gate) = CODEX_PUBLIC_CATALOG_REFRESH_GATE.lock() {
            gate.finish(Instant::now(), succeeded);
        }
        self.finished = true;
        let _ = CODEX_PUBLIC_CATALOG_REFRESH_COMPLETED.send(CatalogRefreshCompletion {
            attempt_id: self.attempt_id,
            succeeded,
        });
    }
}

impl Drop for CatalogRefreshPermit {
    fn drop(&mut self) {
        if !self.finished {
            // Cancellation or unwinding between acquisition and completion
            // must never leave refreshes permanently disabled. Treat it as a
            // failed attempt so the normal short cooldown still applies.
            if let Ok(mut gate) = CODEX_PUBLIC_CATALOG_REFRESH_GATE.lock() {
                gate.finish(Instant::now(), false);
            }
            let _ = CODEX_PUBLIC_CATALOG_REFRESH_COMPLETED.send(CatalogRefreshCompletion {
                attempt_id: self.attempt_id,
                succeeded: false,
            });
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialCatalogRefreshResult {
    pub source: String,
    pub fetched_at: Option<String>,
    pub model_count: usize,
    pub used_stale_cache: bool,
    #[serde(skip_serializing)]
    pub refreshed: bool,
    pub refresh_error: Option<String>,
}

/// 使用 ChatGPT OAuth access token 在线读取官方 Codex 模型列表。
///
/// 这里的失败分两层：HTTP 状态码失败说明请求已经到达 ChatGPT 后端；`send`
/// 失败则是 DNS、TLS、代理、超时或本机网络层问题，调用方可以再尝试本地缓存兜底。
pub async fn fetch_models_with_token(
    token: &str,
    account_id: &str,
) -> Result<Vec<FetchedModel>, String> {
    let client = crate::proxy::http_client::get();
    let response = build_models_request(&client, token, account_id)
        .send()
        .await
        .map_err(format_codex_oauth_request_error)?;

    let status = response.status();
    if !status.is_success() {
        let body = truncate_body(response.text().await.unwrap_or_default());
        return Err(format!("HTTP {status}: {body}"));
    }

    let value: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    Ok(parse_models(value))
}

fn build_models_request(
    client: &reqwest::Client,
    token: &str,
    account_id: &str,
) -> reqwest::RequestBuilder {
    client
        .get(CODEX_OAUTH_MODELS_URL)
        .query(&[("client_version", CODEX_OAUTH_CLIENT_VERSION)])
        .header("Authorization", format!("Bearer {token}"))
        .header("originator", CODEX_OAUTH_ORIGINATOR)
        .header("version", CODEX_OAUTH_CLIENT_VERSION)
        .header("chatgpt-account-id", account_id)
        .timeout(Duration::from_secs(CODEX_OAUTH_FETCH_TIMEOUT_SECS))
}

/// 格式化 OAuth 模型列表请求的网络层错误。
///
/// `reqwest::Error` 的默认文本经常只显示 `error sending request for url`，
/// 不足以区分超时、连接、TLS 或代理问题。这里展开错误链和 CCSM 全局代理状态，
/// 但不包含任何 token、账号明文或请求头。
fn format_codex_oauth_request_error(error: reqwest::Error) -> String {
    let mut hints = Vec::new();
    if error.is_timeout() {
        hints.push("timeout");
    }
    if error.is_connect() {
        hints.push("connect");
    }
    if error.is_builder() {
        hints.push("request_builder");
    }
    if error.is_decode() {
        hints.push("decode");
    }

    let proxy_hint = crate::proxy::http_client::get_current_proxy_url()
        .map(|_| "CCSwitchMulti 全局代理已配置".to_string())
        .unwrap_or_else(|| {
            "CCSwitchMulti 全局代理未配置；Windows/浏览器系统代理不一定会被后端 reqwest 使用"
                .to_string()
        });

    let mut source_parts = Vec::new();
    let mut source = error.source();
    while let Some(current) = source {
        source_parts.push(current.to_string());
        if source_parts.len() >= 4 {
            break;
        }
        source = current.source();
    }

    let kind = if hints.is_empty() {
        "unknown".to_string()
    } else {
        hints.join(",")
    };
    let source_chain = if source_parts.is_empty() {
        "无底层错误链".to_string()
    } else {
        source_parts.join(" -> ")
    };

    format!("Request failed: {error}; kind={kind}; {proxy_hint}; source={source_chain}")
}

/// 无需 OAuth 的官方目录入口：按 TTL 刷新公共快照，失败时继续使用可信旧快照。
pub async fn fetch_official_fallback_models() -> Result<Vec<FetchedModel>, String> {
    if let Err(error) = refresh_public_official_catalog_if_needed().await {
        log::warn!(
            "failed to refresh OpenAI public Codex model catalog; using stale cache: {error}"
        );
    }
    // The public fallback must consume the same authority chain used by
    // catalog projection and reasoning resolution. Reading only the raw
    // Codex cache files here would bypass the packaged/public snapshot after
    // a successful refresh and could reintroduce CCSM-owned third-party rows.
    Ok(parse_official_model_values(
        &crate::codex_config::codex_official_models_cache().unwrap_or_default(),
    ))
}

/// 刷新独立的 OpenAI/Codex 公共目录快照；成功才原子替换缓存，失败保留旧快照。
pub async fn refresh_public_official_catalog_if_needed() -> Result<bool, String> {
    if !crate::codex_config::codex_public_official_models_cache_needs_refresh() {
        return Ok(false);
    }
    let Some(permit) = CatalogRefreshPermit::try_acquire() else {
        return Ok(false);
    };
    let result = if !crate::codex_config::codex_public_official_models_cache_needs_refresh() {
        Ok(false)
    } else {
        match fetch_public_official_catalog_from_url(CODEX_PUBLIC_MODELS_URL).await {
            Ok(models) => crate::codex_config::store_codex_public_official_models_cache(&models)
                .map_err(|error| {
                    format!("Failed to cache OpenAI public Codex model catalog: {error}")
                }),
            Err(error) => Err(error),
        }
    };
    permit.finish(result.is_ok());
    if result.as_ref().is_ok_and(|changed| *changed) {
        reproject_after_automatic_catalog_change();
    }
    result
}

/// Explicitly refresh the public OpenAI/Codex catalog. Unlike the automatic
/// path this ignores both the six-hour TTL and the short failure cooldown. A
/// concurrent explicit caller waits for the in-flight request; if it failed,
/// it owns a new forced attempt instead of presenting stale data as fresh.
pub async fn refresh_public_official_catalog_force() -> OfficialCatalogRefreshResult {
    loop {
        // Subscribe before reading the gate. A broadcast receiver retains the
        // exact completion outcome for this waiter, so a failed forced refresh
        // cannot be mistaken for a still-fresh older snapshot.
        let mut completed = CODEX_PUBLIC_CATALOG_REFRESH_COMPLETED.subscribe();
        let (permit, in_flight_attempt_id) = {
            let mut gate = match CODEX_PUBLIC_CATALOG_REFRESH_GATE.lock() {
                Ok(gate) => gate,
                Err(poisoned) => poisoned.into_inner(),
            };
            match gate.try_start_forced(Instant::now()) {
                Some(attempt_id) => (
                    Some(CatalogRefreshPermit {
                        finished: false,
                        attempt_id,
                    }),
                    None,
                ),
                None => (None, gate.in_flight_attempt_id()),
            }
        };

        let Some(permit) = permit else {
            let Some(in_flight_attempt_id) = in_flight_attempt_id else {
                // The gate can only reject a forced attempt while another
                // attempt is in flight. Recheck rather than reporting a
                // fabricated completion if that invariant is ever violated.
                continue;
            };
            loop {
                match completed.recv().await {
                    Ok(completion) if completion.attempt_id == in_flight_attempt_id => {
                        if completion.succeeded {
                            return public_catalog_snapshot_result(
                                "openai_codex_models_json",
                                false,
                                true,
                                None,
                            );
                        }
                        // A failed attempt must be retried explicitly even
                        // when the retained snapshot is still within its
                        // automatic TTL.
                        break;
                    }
                    Ok(_) => {
                        // Automatic or unrelated forced completions do not
                        // belong to this waiter.
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_))
                    | Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        // Reacquire the gate and either retry or wait on the
                        // current attempt. The static sender normally cannot
                        // close, but retrying remains safer than fabricating
                        // success.
                        break;
                    }
                }
            }
            continue;
        };

        let result: Result<OfficialCatalogRefreshResult, String> =
            match fetch_public_official_catalog_from_url(CODEX_PUBLIC_MODELS_URL).await {
                Ok(models) => crate::codex_config::store_codex_public_official_models_cache(&models)
                    .map(|_| {
                        public_catalog_snapshot_result(
                            "openai_codex_models_json",
                            false,
                            true,
                            None,
                        )
                    })
                    .map_err(|error| {
                        format!("Failed to cache OpenAI public Codex model catalog: {error}")
                    }),
                Err(error) => Err(error),
            };
        permit.finish(result.is_ok());

        return match result {
            Ok(outcome) => outcome,
            Err(error) => public_catalog_snapshot_result(
                "stale_cache",
                true,
                false,
                Some(sanitize_public_catalog_error(&error)),
            ),
        };
    }
}

fn public_catalog_snapshot_result(
    source: &str,
    used_stale_cache: bool,
    refreshed: bool,
    refresh_error: Option<String>,
) -> OfficialCatalogRefreshResult {
    public_catalog_result_from_snapshot(
        crate::codex_config::codex_public_official_models_cache_snapshot(),
        source,
        used_stale_cache,
        refreshed,
        refresh_error,
    )
}

fn public_catalog_result_from_snapshot(
    snapshot: Option<(Option<String>, usize)>,
    source: &str,
    used_stale_cache: bool,
    refreshed: bool,
    refresh_error: Option<String>,
) -> OfficialCatalogRefreshResult {
    let has_snapshot = snapshot.is_some();
    let (fetched_at, model_count) = snapshot.unwrap_or((None, 0));
    OfficialCatalogRefreshResult {
        source: if has_snapshot || refreshed {
            source.to_string()
        } else {
            "unavailable".to_string()
        },
        fetched_at,
        model_count,
        used_stale_cache: used_stale_cache && has_snapshot,
        refreshed,
        refresh_error,
    }
}

fn sanitize_public_catalog_error(error: &str) -> String {
    // Do not expose transport diagnostics or response bodies at IPC. Either
    // could acquire sensitive details if a proxy or HTTP implementation changes.
    log::warn!("forced public Codex catalog refresh failed: {error}");
    "Unable to refresh the official model catalog; the trusted cached snapshot was retained"
        .to_string()
}

pub(crate) fn public_catalog_models_changed(previous: &[Value], next: &[Value]) -> bool {
    let mut previous = previous.to_vec();
    let mut next = next.to_vec();
    let sort_key = |model: &Value| {
        let id = ["slug", "model", "id"]
            .iter()
            .find_map(|field| model.get(*field).and_then(Value::as_str))
            .unwrap_or_default()
            .to_ascii_lowercase();
        (id, model.to_string())
    };
    previous.sort_by_key(&sort_key);
    next.sort_by_key(&sort_key);
    previous != next
}

async fn fetch_public_official_catalog_from_url(url: &str) -> Result<Vec<Value>, String> {
    let response = crate::proxy::http_client::get()
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(
            reqwest::header::USER_AGENT,
            concat!("CCSwitchMulti/", env!("CARGO_PKG_VERSION")),
        )
        .timeout(Duration::from_secs(CODEX_PUBLIC_MODELS_FETCH_TIMEOUT_SECS))
        .send()
        .await
        .map_err(format_codex_oauth_request_error)?;

    let status = response.status();
    if !status.is_success() {
        let body = truncate_body(response.text().await.unwrap_or_default());
        return Err(format!("HTTP {status}: {body}"));
    }
    if response
        .content_length()
        .is_some_and(|length| length > CODEX_PUBLIC_MODELS_MAX_BYTES)
    {
        return Err("OpenAI public Codex model catalog exceeds 8 MiB".to_string());
    }

    let body = response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read public model catalog: {error}"))?;
    if body.len() as u64 > CODEX_PUBLIC_MODELS_MAX_BYTES {
        return Err("OpenAI public Codex model catalog exceeds 8 MiB".to_string());
    }
    let value: Value = serde_json::from_slice(&body)
        .map_err(|error| format!("Failed to parse public model catalog: {error}"))?;
    let models = value
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| "OpenAI public Codex model catalog has no models array".to_string())?;
    let sanitized = models
        .iter()
        .filter_map(sanitize_public_official_model)
        .collect::<Vec<_>>();
    if parse_cached_models(serde_json::json!({ "models": sanitized })).is_empty() {
        return Err("OpenAI public Codex model catalog has no usable models".to_string());
    }
    Ok(sanitized)
}

/// Public catalog entries may contain instruction-bearing fields intended for
/// Codex's own runtime. They are not needed for the model picker and must not
/// be copied into a CCSM-generated catalog.
pub(crate) fn sanitize_public_official_model(model: &Value) -> Option<Value> {
    let mut model = model.as_object()?.clone();
    for field in [
        "model_messages",
        "modelMessages",
        "base_instructions",
        "baseInstructions",
        "instructions",
        "instructions_template",
        "instructionsTemplate",
    ] {
        model.remove(field);
    }
    Some(Value::Object(model))
}

/// 从 Codex 缓存结构里解析官方模型，并剔除 MultiRouter 合并进去的第三方模型。
fn parse_cached_models(value: Value) -> Vec<FetchedModel> {
    parse_models(value)
        .into_iter()
        .filter(|model| is_likely_codex_oauth_model_id(&model.id))
        .collect()
}

fn parse_official_model_values(models: &[Value]) -> Vec<FetchedModel> {
    parse_cached_models(serde_json::json!({ "models": models }))
}

/// 判断缓存条目是否像官方 Codex/ChatGPT 模型。
///
/// 该函数只用于离线 fallback，宁可漏掉不认识的新第三方条目，也不能把 Qwen、
/// DeepSeek 等用户自定义模型灌进 official route。在线接口成功时不走这层过滤。
fn is_likely_codex_oauth_model_id(model_id: &str) -> bool {
    let id = model_id.trim().to_ascii_lowercase();
    if id.starts_with("gpt-") || id.starts_with("codex-") || id.starts_with("chatgpt-") {
        return true;
    }
    ["o1", "o3", "o4", "o5"].iter().any(|prefix| {
        id == *prefix
            || id
                .strip_prefix(prefix)
                .is_some_and(|suffix| suffix.starts_with('-'))
    })
}

/// 解析 ChatGPT Codex 模型列表响应，兼容数组、`data`、`items` 和 map 形态。
fn parse_models(value: Value) -> Vec<FetchedModel> {
    let entries = value
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| value.get("models").and_then(Value::as_array))
        .or_else(|| value.get("items").and_then(Value::as_array))
        .or_else(|| value.as_array());

    let mut models = Vec::new();

    if let Some(entries) = entries {
        for entry in entries {
            push_model_entry(&mut models, entry, None);
        }
    }

    if let Some(model_map) = value.get("models").and_then(Value::as_object) {
        for (key, entry) in model_map {
            push_model_entry(&mut models, entry, Some(key));
        }
    }

    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    models
}

/// 将单个响应条目追加到模型列表。
///
/// 条目可能只是字符串模型名，也可能是包含 `slug/id/model/name` 的对象；
/// `fallback_id` 仅用于 map 形态，避免对象里没有显式 id 时丢失 key。
fn push_model_entry(models: &mut Vec<FetchedModel>, entry: &Value, fallback_id: Option<&str>) {
    if let Some(id) = entry.as_str().map(str::trim).filter(|id| !id.is_empty()) {
        models.push(FetchedModel {
            context_window: None,
            canonical_slug: None,
            slug: None,
            name: None,
            aliases: Vec::new(),
            id: id.to_string(),
            input_modalities: None,
            owned_by: Some("Codex".to_string()),
            supports_image: None,
            reasoning: None,
        });
        return;
    }

    let Some(obj) = entry.as_object() else {
        if let Some(id) = fallback_id.map(str::trim).filter(|id| !id.is_empty()) {
            models.push(FetchedModel {
                context_window: None,
                canonical_slug: None,
                slug: None,
                name: None,
                aliases: Vec::new(),
                id: id.to_string(),
                input_modalities: None,
                owned_by: Some("Codex".to_string()),
                supports_image: None,
                reasoning: None,
            });
        }
        return;
    };

    if model_entry_is_explicitly_unavailable(obj) {
        return;
    }

    let Some(id) = string_field(obj, &["slug", "id", "model", "name"]).or_else(|| {
        fallback_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
    }) else {
        return;
    };
    let owned_by = string_field(
        obj,
        &[
            "owned_by", "ownedBy", "provider", "vendor", "category", "owner",
        ],
    )
    .or_else(|| Some("Codex".to_string()));

    let context_window = extract_context_window(obj);
    let input_modalities = extract_input_modalities(obj);
    let supports_image = extract_supports_image(obj, input_modalities.as_deref());
    let reasoning =
        crate::proxy::providers::codex_reasoning::official_reasoning_capability_for_model(
            &id,
            std::slice::from_ref(entry),
        )
        .and_then(|capability| serde_json::to_value(capability).ok());

    models.push(FetchedModel {
        context_window,
        canonical_slug: string_field(obj, &["canonical_slug", "canonicalSlug"]),
        slug: string_field(obj, &["slug"]),
        name: string_field(obj, &["name"]),
        aliases: aliases_field(obj),
        id,
        input_modalities,
        owned_by,
        supports_image,
        reasoning,
    });
}

/// 判断官方 Codex 模型条目是否显式标为不可调用。
///
/// ChatGPT 后端有时会返回“存在但当前账号/API 不可用”的模型元数据；这类模型
/// 不能写进 MultiRouter catalog，否则 Codex 选择器会展示它，但 `/responses`
/// 随后返回 `Model not found`。缺少可用性字段时保守保留，只过滤明确否定值。
fn model_entry_is_explicitly_unavailable(obj: &serde_json::Map<String, Value>) -> bool {
    let false_flags = [
        "supported_in_api",
        "supportedInApi",
        "available",
        "is_available",
        "isAvailable",
        "enabled",
    ];
    if false_flags
        .iter()
        .any(|key| obj.get(*key).and_then(Value::as_bool) == Some(false))
    {
        return true;
    }

    if obj.get("disabled").and_then(Value::as_bool) == Some(true) {
        return true;
    }

    let hidden_visibility = string_field(obj, &["visibility", "status", "availability"])
        .map(|value| value.to_ascii_lowercase())
        .is_some_and(|value| {
            matches!(
                value.as_str(),
                "hide" | "hidden" | "disabled" | "unavailable" | "unsupported" | "denied"
            )
        });
    hidden_visibility
}

fn string_field(obj: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| obj.get(*key))
        .filter_map(Value::as_str)
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(str::to_string)
}

fn aliases_field(obj: &serde_json::Map<String, Value>) -> Vec<String> {
    let mut aliases = Vec::new();
    for key in ["aliases", "alias", "model_aliases", "modelAliases"] {
        match obj.get(key) {
            Some(Value::Array(values)) => aliases.extend(values.iter().filter_map(|value| {
                value
                    .as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
            })),
            Some(Value::String(value)) if !value.trim().is_empty() => {
                aliases.push(value.trim().to_string())
            }
            _ => {}
        }
    }
    aliases.sort_unstable();
    aliases.dedup();
    aliases
}

/// 从 Codex OAuth 模型条目中提取上下文窗口。
///
/// 官方接口字段可能随客户端版本变化，只有明确的正整数才会被接受。
fn extract_context_window(obj: &serde_json::Map<String, Value>) -> Option<u64> {
    const KEYS: &[&str] = &[
        "context_window",
        "max_context_window",
        "contextWindow",
        "maxContextWindow",
    ];

    KEYS.iter()
        .filter_map(|key| obj.get(*key))
        .find_map(parse_positive_u64)
}

/// 从官方 Codex 模型条目读取输入模态。
///
/// 这是 Codex Desktop 判断图片入口的关键能力字段；不能在 OAuth 动态目录同步时丢掉。
fn extract_input_modalities(obj: &serde_json::Map<String, Value>) -> Option<Vec<String>> {
    ["input_modalities", "inputModalities", "modalities"]
        .iter()
        .filter_map(|key| obj.get(*key))
        .find_map(parse_input_modalities)
}

fn parse_input_modalities(value: &Value) -> Option<Vec<String>> {
    let values = match value {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.as_str())
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        Value::Object(obj) => obj
            .get("input")
            .or_else(|| obj.get("inputs"))
            .and_then(parse_input_modalities)?,
        _ => return None,
    };

    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

fn extract_supports_image(
    obj: &serde_json::Map<String, Value>,
    input_modalities: Option<&[String]>,
) -> Option<bool> {
    if let Some(value) = [
        "supports_image",
        "supportsImage",
        "vision",
        "supports_image_detail_original",
        "supportsImageDetailOriginal",
    ]
    .iter()
    .filter_map(|key| obj.get(*key))
    .find_map(Value::as_bool)
    {
        return Some(value);
    }

    input_modalities.map(|modalities| {
        modalities
            .iter()
            .any(|modality| modality.eq_ignore_ascii_case("image"))
    })
}

/// 将 JSON 数字或纯数字字符串转换为正整数。
///
/// 带单位的文本会保留为未知值，让前端继续使用用户填写或默认兜底。
fn parse_positive_u64(value: &Value) -> Option<u64> {
    match value {
        Value::Number(number) => number.as_u64().filter(|v| *v > 0),
        Value::String(text) => text.trim().parse::<u64>().ok().filter(|value| *value > 0),
        _ => None,
    }
}

fn truncate_body(body: String) -> String {
    if body.chars().count() <= ERROR_BODY_MAX_CHARS {
        body
    } else {
        let mut s: String = body.chars().take(ERROR_BODY_MAX_CHARS).collect();
        s.push_str("...");
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn model_discovery_advertises_supported_codex_client_cohort() {
        let request = build_models_request(&reqwest::Client::new(), "test-token", "test-account")
            .build()
            .expect("build model discovery request");
        assert_eq!(
            request
                .url()
                .query_pairs()
                .find(|(key, _)| key == "client_version")
                .map(|(_, value)| value.into_owned()),
            Some("0.155.0".to_string())
        );
        assert_eq!(request.headers()["version"], CODEX_OAUTH_CLIENT_VERSION);
        assert_eq!(request.headers()["originator"], CODEX_OAUTH_ORIGINATOR);
    }

    #[test]
    fn parse_codex_oauth_models_preserves_reasoning_capability() {
        let models = parse_models(json!({
            "models": [{
                "slug": "gpt-6-astra",
                "default_reasoning_level": "low",
                "supported_reasoning_levels": ["low", "medium", "high", "xhigh", "max"]
            }]
        }));

        let serialized = serde_json::to_value(&models[0]).expect("serialize fetched model");
        assert_eq!(
            serialized.pointer("/reasoning/supportedEfforts"),
            Some(&json!(["low", "medium", "high", "xhigh", "max"]))
        );
        assert_eq!(
            serialized.pointer("/reasoning/defaultEffort"),
            Some(&json!("low"))
        );
        assert_eq!(
            serialized.pointer("/reasoning/upstream/effortMap/none"),
            Some(&json!("low"))
        );
    }

    #[test]
    fn forced_public_catalog_refresh_bypasses_failure_cooldown() {
        let start = Instant::now();
        let mut gate = CatalogRefreshGate::default();

        assert!(gate.try_start(start).is_some());
        gate.finish(start + Duration::from_secs(1), false);

        assert!(
            gate.try_start_forced(start + Duration::from_secs(2)).is_some(),
            "an explicit user refresh must request upstream even during automatic retry cooldown"
        );
    }

    #[tokio::test]
    async fn enabled_manual_refresh_waiter_observes_failed_completion_and_retries() {
        let (sender, _receiver) = tokio::sync::broadcast::channel(1);
        let mut completed = sender.subscribe();
        let start = Instant::now();
        let mut gate = CatalogRefreshGate::default();

        let attempt_id = gate.try_start(start).expect("start refresh");
        gate.finish(start + Duration::from_secs(1), false);
        sender
            .send(CatalogRefreshCompletion {
                attempt_id,
                succeeded: false,
            })
            .expect("send failed refresh outcome");

        assert_eq!(
            completed.recv().await.expect("receive refresh outcome"),
            CatalogRefreshCompletion {
                attempt_id,
                succeeded: false,
            }
        );
        assert!(
            gate.try_start_forced(start + Duration::from_secs(2)).is_some(),
            "a failed forced refresh must be retried even when the retained snapshot is still fresh"
        );
    }

    #[tokio::test]
    async fn manual_refresh_waiter_ignores_unrelated_completion() {
        let (sender, _receiver) = tokio::sync::broadcast::channel(4);
        let mut completed = sender.subscribe();
        let expected = CatalogRefreshCompletion {
            attempt_id: 2,
            succeeded: true,
        };
        sender
            .send(CatalogRefreshCompletion {
                attempt_id: 1,
                succeeded: true,
            })
            .expect("send unrelated completion");
        sender.send(expected).expect("send owned completion");

        assert_eq!(
            completed
                .recv()
                .await
                .expect("receive unrelated completion")
                .attempt_id,
            1
        );
        assert_eq!(
            completed
                .recv()
                .await
                .expect("receive owned completion"),
            expected
        );
    }

    #[test]
    fn public_catalog_change_detection_ignores_model_order_but_not_metadata() {
        let original = vec![
            json!({"slug": "gpt-6-sol", "supported_reasoning_levels": ["low", "max"]}),
            json!({"slug": "gpt-6-luna", "context_window": 128000}),
        ];
        let reordered = vec![original[1].clone(), original[0].clone()];
        let changed = vec![
            json!({"slug": "gpt-6-sol", "supported_reasoning_levels": ["low", "max", "ultra"]}),
            original[1].clone(),
        ];

        assert!(!public_catalog_models_changed(&original, &reordered));
        assert!(public_catalog_models_changed(&original, &changed));
    }

    #[test]
    fn failed_forced_refresh_reports_only_an_actual_stale_snapshot() {
        let stale = public_catalog_result_from_snapshot(
            Some((Some("2026-09-23T00:00:00Z".to_string()), 3)),
            "stale_cache",
            true,
            false,
            Some("refresh failed".to_string()),
        );
        assert_eq!(stale.source, "stale_cache");
        assert!(stale.used_stale_cache);
        assert_eq!(stale.model_count, 3);
        assert!(!stale.refreshed);

        let unavailable = public_catalog_result_from_snapshot(
            None,
            "stale_cache",
            true,
            false,
            Some("refresh failed".to_string()),
        );
        assert_eq!(unavailable.source, "unavailable");
        assert!(!unavailable.used_stale_cache);
        assert_eq!(unavailable.model_count, 0);
    }

    #[test]
    fn parse_codex_oauth_models_accepts_openai_style_data() {
        let models = parse_models(json!({
            "data": [
                { "id": "gpt-5.4", "owned_by": "openai" },
                { "id": "gpt-5.4-mini", "ownedBy": "openai" }
            ]
        }));

        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "gpt-5.4");
        assert_eq!(models[0].owned_by.as_deref(), Some("openai"));
        assert_eq!(models[1].id, "gpt-5.4-mini");
        assert_eq!(models[1].owned_by.as_deref(), Some("openai"));
    }

    #[test]
    fn parse_codex_oauth_models_accepts_model_list_shape() {
        let models = parse_models(json!({
            "models": [
                { "slug": "gpt-5.3-codex", "display_name": "GPT-5.3 Codex" },
                "gpt-5.5"
            ]
        }));

        assert_eq!(
            models.into_iter().map(|model| model.id).collect::<Vec<_>>(),
            vec!["gpt-5.3-codex".to_string(), "gpt-5.5".to_string()]
        );
    }

    #[test]
    fn parse_codex_oauth_models_deduplicates_ids() {
        let models = parse_models(json!({
            "data": [
                { "id": "gpt-5.4" },
                { "model": "gpt-5.4" }
            ]
        }));

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-5.4");
    }

    #[test]
    fn parse_codex_oauth_models_accepts_model_map_shape() {
        let models = parse_models(json!({
            "models": {
                "gpt-5.4": { "display_name": "GPT-5.4" },
                "gpt-5.5": { "slug": "gpt-5.5" }
            }
        }));

        assert_eq!(
            models.into_iter().map(|model| model.id).collect::<Vec<_>>(),
            vec!["gpt-5.4".to_string(), "gpt-5.5".to_string()]
        );
    }

    #[test]
    fn parse_codex_oauth_models_extracts_context_window() {
        let models = parse_models(json!({
            "models": [
                { "slug": "gpt-5.4", "context_window": 272000 },
                { "slug": "gpt-5.5", "maxContextWindow": "1000000" },
                { "slug": "bad", "contextWindow": "128000 tokens" }
            ]
        }));

        assert_eq!(models[0].context_window, None);
        assert_eq!(models[1].context_window, Some(272_000));
        assert_eq!(models[2].context_window, Some(1_000_000));
    }

    #[test]
    fn parse_codex_oauth_models_preserves_image_modalities() {
        let models = parse_models(json!({
            "models": [
                {
                    "slug": "gpt-5.6-sol",
                    "input_modalities": ["text", "image"],
                    "supports_image_detail_original": true
                },
                {
                    "slug": "gpt-5.3-codex-spark",
                    "input_modalities": ["text"],
                    "supports_image_detail_original": false
                }
            ]
        }));

        let sol = models
            .iter()
            .find(|model| model.id == "gpt-5.6-sol")
            .unwrap();
        assert_eq!(
            sol.input_modalities.as_deref(),
            Some(&["text".to_string(), "image".to_string()][..])
        );
        assert_eq!(sol.supports_image, Some(true));

        let spark = models
            .iter()
            .find(|model| model.id == "gpt-5.3-codex-spark")
            .unwrap();
        assert_eq!(
            spark.input_modalities.as_deref(),
            Some(&["text".to_string()][..])
        );
        assert_eq!(spark.supports_image, Some(false));
    }

    #[test]
    fn parse_codex_oauth_models_filters_explicitly_unavailable_entries() {
        let models = parse_models(json!({
            "models": [
                { "slug": "gpt-5.6-luna", "supported_in_api": false },
                { "slug": "gpt-5.6-hidden", "visibility": "hide" },
                { "slug": "gpt-5.6-disabled", "disabled": true },
                { "slug": "gpt-5.5", "supportedInApi": true },
                { "slug": "gpt-5.4" }
            ]
        }));

        assert_eq!(
            models.into_iter().map(|model| model.id).collect::<Vec<_>>(),
            vec!["gpt-5.4".to_string(), "gpt-5.5".to_string()]
        );
    }

    #[test]
    fn parse_cached_models_keeps_official_codex_models_only() {
        let models = parse_cached_models(json!({
            "models": [
                { "slug": "gpt-5.5", "owned_by": "openai" },
                { "slug": "gpt-5.6-luna", "provider": "Codex" },
                { "slug": "codex-auto-review", "provider": "Codex" },
                { "slug": "o4-mini", "provider": "OpenAI" },
                { "slug": "deepseek-chat", "provider": "deepseek" },
                { "slug": "qwen3-coder", "provider": "qwen" }
            ]
        }));

        assert_eq!(
            models.into_iter().map(|model| model.id).collect::<Vec<_>>(),
            vec![
                "codex-auto-review".to_string(),
                "gpt-5.5".to_string(),
                "gpt-5.6-luna".to_string(),
                "o4-mini".to_string()
            ]
        );
    }
}
