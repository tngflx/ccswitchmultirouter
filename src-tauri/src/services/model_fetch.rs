//! 模型列表获取服务
//!
//! 通过 OpenAI 兼容的 GET /v1/models 端点获取供应商可用模型列表。
//! 主要面向第三方聚合站（硅基流动、OpenRouter 等），以及把 Anthropic
//! 协议挂在兼容子路径上的官方供应商（DeepSeek、Kimi、智谱 GLM 等）。

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, USER_AGENT};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Duration;

use crate::codex_multirouter::protocol_capability::normalize_protocol_capability_base_url;

/// 获取到的模型信息
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedModel {
    pub id: String,
    pub owned_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aliases: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_parallel_tool_calls: Option<bool>,
    pub context_window: Option<u64>,
    pub input_modalities: Option<Vec<String>>,
    pub supports_image: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_capability: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_free: Option<bool>,
}

/// 模型列表获取服务的统一入参。
///
/// 通用 OpenAI-compatible `/models` 字段和火山 Plan 管控面字段放在同一个请求对象里，
/// 让服务入口保持稳定；新增 provider 专用取模逻辑时优先扩展子结构而不是继续增加函数参数。
#[derive(Debug, Clone)]
pub struct FetchModelsRequest<'a> {
    pub base_url: &'a str,
    pub api_key: &'a str,
    pub is_full_url: bool,
    pub models_url_override: Option<&'a str>,
    pub user_agent: Option<HeaderValue>,
    pub api_format: Option<&'a str>,
    pub request_headers: Option<&'a BTreeMap<String, String>>,
    pub volcengine: VolcengineModelListRequest<'a>,
}

/// 火山 Agent/Coding Plan 模型枚举的管控面参数。
///
/// 这些字段不是推理 API 的 bearer key，而是火山 OpenAPI AK/SK；没有 action 时
/// 主流程仍回到普通 OpenAI-compatible `/models` 候选逻辑。
#[derive(Debug, Clone, Copy, Default)]
pub struct VolcengineModelListRequest<'a> {
    pub action: Option<&'a str>,
    pub access_key_id: Option<&'a str>,
    pub secret_access_key: Option<&'a str>,
}

/// OpenAI 兼容的 /v1/models 响应格式
#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Option<Vec<ModelEntry>>,
    /// Opper's public catalog uses `models` instead of OpenAI's `data` array.
    #[serde(default)]
    models: Option<serde_json::Value>,
    #[serde(default)]
    msg: Option<String>,
    #[serde(default)]
    error: Option<ModelFetchError>,
    #[serde(default)]
    success: Option<bool>,
    #[serde(default, alias = "hasMore")]
    has_more: Option<bool>,
    #[serde(default, alias = "nextCursor")]
    next_cursor: Option<String>,
    #[serde(default)]
    total: Option<serde_json::Value>,
    #[serde(default)]
    pagination: Option<serde_json::Value>,
    #[serde(default)]
    links: Option<serde_json::Value>,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct ModelFetchError {
    #[serde(default)]
    message: Option<String>,
}

impl ModelsResponse {
    fn error_message(&self) -> Option<&str> {
        self.msg
            .as_deref()
            .map(str::trim)
            .filter(|message| !message.is_empty())
            .or_else(|| {
                self.error
                    .as_ref()
                    .and_then(|error| error.message.as_deref())
                    .map(str::trim)
                    .filter(|message| !message.is_empty())
            })
    }

    fn explicit_failure(&self) -> bool {
        self.success == Some(false)
            || self.error.is_some()
            || self.extra.get("ok").and_then(serde_json::Value::as_bool) == Some(false)
    }

    fn incomplete_inventory(&self, returned: usize) -> bool {
        if self.has_more == Some(true)
            || self
                .next_cursor
                .as_deref()
                .is_some_and(|cursor| !cursor.trim().is_empty())
        {
            return true;
        }

        let (extra_incomplete, extra_total) = pagination_object_signals(&self.extra);
        let mut pagination_total = self
            .total
            .as_ref()
            .and_then(parse_nonnegative_u64)
            .into_iter()
            .chain(extra_total)
            .max();
        let mut pagination_incomplete = extra_incomplete;
        for value in [&self.pagination, &self.links].into_iter().flatten() {
            let (incomplete, total) = pagination_signals(value);
            pagination_incomplete |= incomplete;
            pagination_total = pagination_total.into_iter().chain(total).max();
        }
        pagination_incomplete || pagination_total.is_some_and(|total| total > returned as u64)
    }
}

#[derive(Debug)]
struct ModelEntry {
    id: String,
    owned_by: Option<String>,
    extra: serde_json::Map<String, serde_json::Value>,
}

impl<'de> Deserialize<'de> for ModelEntry {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let object = serde_json::Map::<String, serde_json::Value>::deserialize(deserializer)?;
        // The authoritative OpenAI-compatible `data` inventory needs a
        // requestable identifier. A display-only `name` is valid for rich
        // descriptors, but must not turn a corrupt data row into a route.
        let id = ["id", "slug", "model"]
            .iter()
            .filter_map(|key| object.get(*key))
            .find_map(|value| {
                value
                    .as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            })
            .ok_or_else(|| serde::de::Error::custom("missing model identifier"))?;
        let owned_by = ["owned_by", "ownedBy"]
            .iter()
            .filter_map(|key| object.get(*key))
            .find_map(|value| value.as_str().map(str::to_string));
        Ok(Self {
            id,
            owned_by,
            extra: object,
        })
    }
}

/// Normalized view of Opper's public `/v3/models` catalog entries.
///
/// The endpoint is not OpenAI-shaped: it returns `models`, keeps the public
/// model identity in `id`, and nests the upstream owner under `provider.slug`.
/// Keep the full entry in `extra` so pricing and capability metadata remain
/// available to the common classifier.
#[derive(Debug, Deserialize)]
struct OpperModelEntry {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    #[serde(alias = "modelId")]
    model_id: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    #[serde(alias = "ownedBy")]
    owned_by: Option<String>,
    #[serde(default)]
    provider: Option<serde_json::Value>,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

impl OpperModelEntry {
    fn into_model_entry(self) -> Option<ModelEntry> {
        let mut extra = self.extra;
        for (key, value) in [
            ("id", self.id.as_ref()),
            ("model_id", self.model_id.as_ref()),
            ("model", self.model.as_ref()),
        ] {
            if let Some(value) = value {
                extra.insert(key.to_string(), serde_json::json!(value));
            }
        }
        let id = self
            .id
            .or(self.model_id)
            .or(self.model)
            .or_else(|| {
                ["slug", "canonical_slug", "canonicalSlug"]
                    .iter()
                    .find_map(|key| {
                        extra
                            .get(*key)
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string)
                    })
            })
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())?;
        let owned_by = self.owned_by.or_else(|| {
            self.provider
                .as_ref()
                .and_then(serde_json::Value::as_object)
                .and_then(|provider| {
                    provider
                        .get("slug")
                        .or_else(|| provider.get("id"))
                        .and_then(serde_json::Value::as_str)
                })
                .map(str::to_string)
        });
        Some(ModelEntry {
            id,
            owned_by,
            extra,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PriceSign {
    Zero,
    Positive,
    Negative,
    Invalid,
}

#[derive(Debug, Default)]
struct PricingEvidence {
    prompt: Option<PriceSign>,
    completion: Option<PriceSign>,
    has_charge_fields: bool,
    has_positive: bool,
    has_invalid: bool,
    has_negative: bool,
}

const NESTED_CACHE_PRICE_KEYS: &[&str] = &["read", "write"];

/// Pricing fields that represent a billable request, token, modality, or cache
/// charge. `discount` and other descriptive metadata are deliberately omitted.
const PRICING_CHARGE_KEYS: &[&str] = &[
    "prompt",
    "completion",
    "input",
    "output",
    "request",
    "image",
    "image_generation",
    "web_search",
    "search",
    "internal_reasoning",
    "reasoning",
    "input_cache_read",
    "input_cache_write",
    "output_cache_read",
    "output_cache_write",
    "cache_read",
    "cache_write",
    "input_audio",
    "output_audio",
    "audio_output",
    "image_output",
    "image_token",
    "input_audio_cache",
    "input_cache_write_1h",
    "audio",
    "video",
    "embedding",
    "embeddings",
    "tool_call",
    "tool_calls",
];

const FETCH_TIMEOUT_SECS: u64 = 15;
const MAX_REQUEST_HEADERS: usize = 64;
const MAX_HEADER_NAME_BYTES: usize = 256;
const MAX_HEADER_VALUE_BYTES: usize = 16 * 1024;

/// 智谱官方模型概览 markdown。
///
/// 智谱 `/models` 只返回账号可用模型 id，不返回上下文窗口；官方 Mintlify 文档提供
/// `.md` 形态，更适合程序解析。只在智谱域名且 `/models` 缺上下文字段时作为补充来源。
const ZHIPU_MODEL_OVERVIEW_MD_URL: &str =
    "https://docs.bigmodel.cn/cn/guide/start/model-overview.md";

/// models.dev 公共模型目录。
///
/// 原版只把它用于定价导入，但该 API 也包含 `limit.context`。这里作为通用兜底：
/// 仅当 provider 的 `api` 前缀能匹配当前成功的 `/models` endpoint 时才使用。
const MODELS_DEV_API_URL: &str = "https://models.dev/api.json";

/// 404/405 响应体截断长度：避免把几十 KB HTML 404 页整页保留到错误串里。
const ERROR_BODY_MAX_CHARS: usize = 512;

/// 已知的「Anthropic 协议兼容子路径」后缀；按长度降序，最长前缀优先匹配。
/// baseURL 命中这些后缀时，候选列表会追加「剥离后缀再拼 /v1/models / /models」的版本。
const KNOWN_COMPAT_SUFFIXES: &[&str] = &[
    "/api/claudecode",
    "/api/anthropic",
    "/apps/anthropic",
    "/api/coding",
    "/api/v1",
    "/claudecode",
    "/anthropic",
    "/step_plan",
    "/coding",
    "/claude",
];

const VOLCENGINE_AGENT_PLAN_MODEL_LIST_ACTION: &str = "ListArkAgentPlanModel";
const VOLCENGINE_CODING_PLAN_MODEL_LIST_ACTION: &str = "ListArkCodingPlanModel";

/// 归一化前端传入的火山模型列表 Action，只允许官方已确认的 Plan 模型枚举接口。
fn normalize_volcengine_model_list_action(
    action: Option<&str>,
) -> Result<Option<&'static str>, String> {
    let Some(action) = action.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    match action {
        VOLCENGINE_AGENT_PLAN_MODEL_LIST_ACTION => {
            Ok(Some(VOLCENGINE_AGENT_PLAN_MODEL_LIST_ACTION))
        }
        VOLCENGINE_CODING_PLAN_MODEL_LIST_ACTION => {
            Ok(Some(VOLCENGINE_CODING_PLAN_MODEL_LIST_ACTION))
        }
        other => Err(format!("Unsupported Volcengine model list action: {other}")),
    }
}

/// 通过火山方舟管控面 OpenAPI 获取 Agent/Coding Plan 支持的模型列表。
///
/// 这里不使用数据面推理 API Key，也不猜 `/models`；火山官方模型枚举走
/// `open.volcengineapi.com` + AK/SK 签名，base_url 只用于提取 Region。
async fn fetch_volcengine_plan_models(
    base_url: &str,
    action: &str,
    access_key_id: Option<&str>,
    secret_access_key: Option<&str>,
) -> Result<Vec<FetchedModel>, String> {
    let access_key_id = access_key_id.unwrap_or("").trim();
    let secret_access_key = secret_access_key.unwrap_or("").trim();
    if base_url.trim().is_empty() {
        return Err("Base URL is required to derive Volcengine region".to_string());
    }
    if access_key_id.is_empty() || secret_access_key.is_empty() {
        return Err(
            "Volcengine AgentPlan model list requires AccessKey ID and SecretAccessKey".to_string(),
        );
    }

    let region = crate::services::coding_plan::volcengine_region(base_url);
    match crate::services::coding_plan::volcengine_openapi_call(
        &region,
        access_key_id,
        secret_access_key,
        action,
    )
    .await
    {
        crate::services::coding_plan::VolcCall::Body(body) => {
            let models = parse_volcengine_plan_models(&body);
            if models.is_empty() {
                Err(format!("{action} returned no models"))
            } else {
                Ok(models)
            }
        }
        crate::services::coding_plan::VolcCall::Auth(detail) => Err(detail),
        crate::services::coding_plan::VolcCall::Soft(detail)
        | crate::services::coding_plan::VolcCall::Transient(detail) => Err(detail),
    }
}

/// 获取供应商的可用模型列表
///
/// 使用 OpenAI 兼容的 GET /v1/models 端点，按候选列表顺序尝试。
pub async fn fetch_models(options: FetchModelsRequest<'_>) -> Result<Vec<FetchedModel>, String> {
    if let Some(action) = normalize_volcengine_model_list_action(options.volcengine.action)? {
        return fetch_volcengine_plan_models(
            options.base_url,
            action,
            options.volcengine.access_key_id,
            options.volcengine.secret_access_key,
        )
        .await;
    }

    let candidates = build_models_url_candidates(
        options.base_url,
        options.is_full_url,
        options.models_url_override,
    )?;
    let client = crate::proxy::http_client::get();
    let mut last_err: Option<String> = None;
    let headers = build_model_fetch_headers(
        options.api_key,
        options.api_format,
        options.user_agent.as_ref(),
        options.request_headers,
    )?;
    let mut log_secrets = vec![options.api_key.to_string()];
    if let Some(request_headers) = options.request_headers {
        log_secrets.extend(request_headers.values().cloned());
    }

    for url in &candidates {
        log::debug!(
            "[ModelFetch] Trying endpoint: {}",
            crate::url_for_log_with_secrets(url, &log_secrets)
        );
        let request_builder = client
            .get(url)
            .headers(headers.clone())
            .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS));
        let response = match request_builder.send().await {
            Ok(r) => r,
            Err(e) => {
                return Err(format!("Request failed: {e}"));
            }
        };

        let status = response.status();

        if status.is_success() {
            let resolved_models_url = response.url().clone();
            let body = response.text().await.unwrap_or_default();
            let mut models = parse_provider_models_response(
                &body,
                &log_secrets,
                options.base_url,
                resolved_models_url.as_str(),
            )?;

            enrich_missing_context_windows(&client, url, &mut models).await;
            models.sort_by(|a, b| a.id.cmp(&b.id));
            return Ok(models);
        }

        if status == StatusCode::NOT_FOUND || status == StatusCode::METHOD_NOT_ALLOWED {
            let body = redact_model_fetch_error_body(
                response.text().await.unwrap_or_default(),
                &log_secrets,
            );
            last_err = Some(format!("HTTP {status}: {body}"));
            continue;
        }

        let body =
            redact_model_fetch_error_body(response.text().await.unwrap_or_default(), &log_secrets);
        return Err(format!("HTTP {status}: {body}"));
    }

    Err(format!(
        "All candidates failed: {}",
        last_err.unwrap_or_else(|| "no candidates".to_string())
    ))
}

#[cfg(test)]
fn parse_models_response(
    body: &str,
    known_secrets: &[String],
) -> Result<Vec<FetchedModel>, String> {
    parse_provider_models_response(body, known_secrets, "", "")
}

fn parse_provider_models_response(
    body: &str,
    known_secrets: &[String],
    base_url: &str,
    models_url: &str,
) -> Result<Vec<FetchedModel>, String> {
    let response: ModelsResponse = serde_json::from_str(body).map_err(|error| {
        let detail = format!("Failed to parse response: {error}");
        crate::redact_known_secrets(&detail, known_secrets)
    })?;
    if response.explicit_failure() {
        let detail = response
            .error_message()
            .map(|message| crate::redact_known_secrets(message, known_secrets))
            .unwrap_or_else(|| "provider reported model-list failure".to_string());
        return Err(format!("Model fetch failed: {detail}"));
    }
    let error_detail = response
        .error_message()
        .map(|message| crate::redact_known_secrets(message, known_secrets))
        .unwrap_or_else(|| redact_model_fetch_error_body(body.to_string(), known_secrets));
    let inventory_size = response
        .data
        .as_ref()
        .map(Vec::len)
        .or_else(|| response.models.as_ref().map(rich_model_count))
        .unwrap_or_default();
    if response.incomplete_inventory(inventory_size) {
        return Err(
            "Model fetch response is incomplete; pagination must be resolved first".to_string(),
        );
    }
    let data = response.data;
    let rich_models = response.models;
    let native_google_models = is_native_google_models_discovery(base_url, models_url);
    let entries = match (data, rich_models) {
        (Some(mut data), Some(rich)) => {
            let rich = normalize_rich_model_entries(rich, native_google_models)?;
            validate_rich_model_entries(&rich)?;
            if data.is_empty() && !rich.is_empty() {
                return Err(
                    "Model fetch response contained contradictory data and models inventories"
                        .to_string(),
                );
            }
            enrich_data_model_entries(&mut data, &rich)?;
            data
        }
        (Some(data), None) => data,
        (None, Some(rich)) => {
            let rich = normalize_rich_model_entries(rich, native_google_models)?;
            validate_rich_model_entries(&rich)?;
            rich
        }
        (None, None) => return Err(format!("Model fetch failed: {error_detail}")),
    };
    validate_model_entries(&entries)?;

    Ok(entries
        .into_iter()
        .map(|entry| {
            let is_free = classify_model_free_status(&entry.id, &entry.extra);
            let protocol_capability =
                extract_protocol_capability(&entry.id, &entry.extra, base_url, models_url);
            let identity = extract_model_identity_fields(&entry.extra);
            let supports_parallel_tool_calls =
                identity.supports_parallel_tool_calls.or_else(|| {
                    is_openrouter_models_discovery(base_url, models_url)
                        .then(|| extract_openrouter_parallel_tool_calls(&entry.extra))
                        .flatten()
                });
            FetchedModel {
                context_window: extract_context_window(&entry.extra),
                id: entry.id,
                input_modalities: extract_input_modalities(&entry.extra),
                owned_by: entry.owned_by,
                supports_image: extract_supports_image(&entry.extra),
                display_name: identity.display_name,
                canonical_slug: identity.canonical_slug,
                slug: identity.slug,
                name: identity.name,
                aliases: identity.aliases,
                upstream_model: None,
                supports_parallel_tool_calls,
                reasoning: crate::reasoning_capabilities::provider_metadata::
                    provider_reasoning_capability_from_model_entry(
                        &serde_json::Value::Object(entry.extra.clone()),
                        is_openrouter_models_discovery(base_url, models_url),
                    )
                    .and_then(|capability| serde_json::to_value(capability).ok()),
                protocol_capability,
                is_free,
            }
        })
        .collect())
}

fn normalize_rich_model_entries(
    value: serde_json::Value,
    native_google_models: bool,
) -> Result<Vec<ModelEntry>, String> {
    let entries = match value {
        serde_json::Value::Array(entries) => entries
            .into_iter()
            .map(|entry| (None, entry))
            .collect::<Vec<_>>(),
        serde_json::Value::Object(entries) => entries
            .into_iter()
            .map(|(key, entry)| (Some(key), entry))
            .collect::<Vec<_>>(),
        _ => {
            return Err("Model fetch response contained an invalid models envelope".to_string());
        }
    };
    let mut normalized = Vec::with_capacity(entries.len());
    for (fallback_id, value) in entries {
        let mut entry: OpperModelEntry = serde_json::from_value(value).map_err(|_| {
            "Model fetch response contained an invalid model descriptor".to_string()
        })?;
        if entry.id.is_none()
            && entry.model_id.is_none()
            && entry.model.is_none()
            && entry
                .extra
                .get("slug")
                .and_then(serde_json::Value::as_str)
                .is_none()
            && !["canonical_slug", "canonicalSlug"].iter().any(|key| {
                entry
                    .extra
                    .get(*key)
                    .and_then(serde_json::Value::as_str)
                    .is_some()
            })
        {
            entry.id = if native_google_models {
                entry
                    .extra
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .filter(|name| {
                        name.strip_prefix("models/").is_some_and(|model| {
                            !model.is_empty()
                                && model != "."
                                && model != ".."
                                && model.bytes().all(|character| {
                                    character.is_ascii_alphanumeric()
                                        || matches!(character, b'-' | b'_' | b'.')
                                })
                        })
                    })
                    .map(str::to_string)
                    .or(fallback_id)
            } else {
                fallback_id
            };
        }
        let Some(entry) = entry.into_model_entry() else {
            return Err("Model fetch response contained a model without an identifier".to_string());
        };
        normalized.push(entry);
    }
    Ok(normalized)
}

fn rich_model_count(value: &serde_json::Value) -> usize {
    match value {
        serde_json::Value::Array(values) => values.len(),
        serde_json::Value::Object(values) => values.len(),
        _ => 0,
    }
}

fn validate_rich_model_entries(entries: &[ModelEntry]) -> Result<(), String> {
    for (index, entry) in entries.iter().enumerate() {
        let identities = model_entry_identity_values(entry);
        for other in entries.iter().skip(index + 1) {
            if model_entry_identity_values(other)
                .iter()
                .any(|identity| identities.iter().any(|candidate| identity == candidate))
            {
                return Err(
                    "Model fetch response contained ambiguous model descriptors".to_string()
                );
            }
        }
    }
    Ok(())
}

fn enrich_data_model_entries(data: &mut [ModelEntry], rich: &[ModelEntry]) -> Result<(), String> {
    let mut descriptor_matches = Vec::with_capacity(data.len());
    let mut used_descriptors = HashSet::new();
    for entry in data.iter() {
        let data_id = normalize_model_identity(&entry.id);
        let exact = rich
            .iter()
            .position(|candidate| normalize_model_identity(&candidate.id) == data_id);
        let descriptor_index = if exact.is_some() {
            exact
        } else {
            let identities = model_entry_identity_values(entry);
            let mut candidates = rich.iter().enumerate().filter_map(|(index, candidate)| {
                model_entry_identity_values(candidate)
                    .iter()
                    .any(|identity| identities.contains(identity))
                    .then_some(index)
            });
            let candidate = candidates.next();
            if candidates.next().is_some() {
                return Err(
                    "Model fetch response contained ambiguous model descriptors".to_string()
                );
            }
            candidate
        };
        if let Some(index) = descriptor_index {
            if !used_descriptors.insert(index) {
                return Err(
                    "Model fetch response contained ambiguous model descriptors".to_string()
                );
            }
        }
        descriptor_matches.push(descriptor_index);
    }
    for (entry, descriptor_index) in data.iter_mut().zip(descriptor_matches) {
        let Some(descriptor) = descriptor_index.map(|index| &rich[index]) else {
            continue;
        };
        let mut owned_fields = HashSet::new();
        collect_declared_model_metadata_fields(&entry.extra, &mut owned_fields);
        merge_missing_model_metadata(&mut entry.extra, &descriptor.extra, &owned_fields);
        if entry.owned_by.is_none() {
            entry.owned_by = descriptor.owned_by.clone();
        }
    }
    Ok(())
}

fn model_metadata_field(key: &str) -> Option<&'static str> {
    match key {
        "context" | "context_window" | "context_length" | "contextLength" | "ContextWindow"
        | "ContextLength" | "max_context_window" | "max_context_length" | "contextWindow"
        | "maxContextWindow" | "maxContextLength" | "max_model_len" | "maxModelLen"
        | "max_input_tokens" | "maxInputTokens" | "max_prompt_tokens" | "maxPromptTokens"
        | "input_token_limit" | "inputTokenLimit" => Some("context"),
        "input_modalities"
        | "inputModalities"
        | "modalities"
        | "input"
        | "inputs"
        | "supports_image"
        | "supportsImage"
        | "vision"
        | "supports_vision"
        | "supportsVision"
        | "supports_image_detail_original"
        | "supportsImageDetailOriginal" => Some("input"),
        "supports_parallel_tool_calls" | "supportsParallelToolCalls" => Some("parallel"),
        "display_name" | "displayName" => Some("display"),
        "canonical_slug" | "canonicalSlug" => Some("canonical"),
        "slug" => Some("slug"),
        "name" => Some("name"),
        "aliases" | "alias" | "model_aliases" | "modelAliases" => Some("aliases"),
        "is_free" | "isFree" | "pricing" | "cost" => Some("pricing"),
        "reasoning"
        | "supportsReasoning"
        | "supports_reasoning"
        | "reasoningSupported"
        | "reasoning_supported"
        | "supportsThinking"
        | "supports_thinking"
        | "supported_efforts"
        | "supportedEfforts"
        | "efforts"
        | "supported_reasoning_levels"
        | "supportedReasoningLevels"
        | "supported_reasoning_efforts"
        | "supportedReasoningEfforts"
        | "default_effort"
        | "defaultEffort"
        | "default_reasoning_level"
        | "default_reasoning_effort"
        | "defaultReasoningLevel"
        | "defaultReasoningEffort"
        | "reasoning_format"
        | "reasoningFormat"
        | "upstream_format"
        | "upstreamFormat"
        | "reasoning_parameter"
        | "reasoningParameter"
        | "upstream_parameter"
        | "upstreamParameter"
        | "mandatory"
        | "reasoningMandatory"
        | "default_enabled"
        | "defaultEnabled"
        | "supports_max_tokens"
        | "supportsMaxTokens" => Some("reasoning"),
        "supported_endpoints" | "supportedEndpoints" | "endpoints" => Some("endpoints"),
        "supportsTools"
        | "supports_tools"
        | "tools"
        | "tool_calling"
        | "toolCalling"
        | "supports_function_calling"
        | "supportsFunctionCalling"
        | "function_calling"
        | "functionCalling" => Some("tools"),
        "supportsStreaming" | "supports_streaming" | "supportsStream" | "supports_stream"
        | "streaming" | "stream" => Some("streaming"),
        "supportsToolContinuation"
        | "supports_tool_continuation"
        | "toolContinuation"
        | "tool_continuation" => Some("continuation"),
        "supported_parameters" | "supportedParameters" => Some("parameters"),
        _ => None,
    }
}

fn collect_declared_model_metadata_fields(
    object: &serde_json::Map<String, serde_json::Value>,
    fields: &mut HashSet<&'static str>,
) {
    for (key, value) in object {
        if value.is_null() {
            continue;
        }
        if let Some(field) = model_metadata_field(key) {
            fields.insert(field);
            if field == "parameters"
                && value.as_array().is_some_and(|parameters| {
                    parameters.iter().any(|parameter| {
                        parameter
                            .as_str()
                            .is_some_and(|parameter| parameter.eq_ignore_ascii_case("tools"))
                    })
                })
            {
                fields.insert("tools");
            }
        } else if [
            "architecture",
            "metadata",
            "capability",
            "capabilities",
            "protocolCapability",
            "protocol_capability",
            "limit",
            "limits",
        ]
        .contains(&key.as_str())
        {
            if let Some(nested) = value.as_object() {
                collect_declared_model_metadata_fields(nested, fields);
            }
        }
    }
}

fn merge_missing_model_metadata(
    target: &mut serde_json::Map<String, serde_json::Value>,
    descriptor: &serde_json::Map<String, serde_json::Value>,
    declared: &HashSet<&'static str>,
) {
    for (key, value) in descriptor {
        if let Some(field) = model_metadata_field(key) {
            if declared.contains(field) || (field == "parameters" && declared.contains("tools")) {
                continue;
            }
        } else if [
            "architecture",
            "metadata",
            "capability",
            "capabilities",
            "protocolCapability",
            "protocol_capability",
            "limit",
            "limits",
        ]
        .contains(&key.as_str())
        {
            if let Some(nested) = value.as_object() {
                let entry = target
                    .entry(key.clone())
                    .or_insert_with(|| serde_json::json!({}));
                if let Some(object) = entry.as_object_mut() {
                    merge_missing_model_metadata(object, nested, declared);
                }
                continue;
            }
        }
        if target.get(key).is_none_or(serde_json::Value::is_null) {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn model_entry_identity_values(entry: &ModelEntry) -> Vec<String> {
    let mut values = Vec::new();
    push_model_identity(&mut values, &entry.id);
    let mut scopes = Vec::new();
    collect_model_metadata_scopes(&entry.extra, &mut scopes, 0);
    for object in std::iter::once(&entry.extra).chain(scopes) {
        for key in [
            "model",
            "model_id",
            "modelId",
            "canonical_slug",
            "canonicalSlug",
            "slug",
            "name",
        ] {
            if let Some(value) = object.get(key).and_then(serde_json::Value::as_str) {
                push_model_identity(&mut values, value);
            }
        }
        for key in ["aliases", "alias", "model_aliases", "modelAliases"] {
            if let Some(value) = object.get(key) {
                push_alias_identities(&mut values, value);
            }
        }
    }
    values
}

fn normalize_model_identity(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn push_model_identity(values: &mut Vec<String>, value: &str) {
    let normalized = normalize_model_identity(value);
    if !normalized.is_empty() && !values.iter().any(|item| item == &normalized) {
        values.push(normalized);
    }
}

fn push_alias_identities(values: &mut Vec<String>, value: &serde_json::Value) {
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                if let Some(alias) = item.as_str() {
                    push_model_identity(values, alias);
                }
            }
        }
        serde_json::Value::Object(items) => {
            for (alias, target) in items {
                push_model_identity(values, alias);
                if let Some(target) = target.as_str() {
                    push_model_identity(values, target);
                }
            }
        }
        _ => {}
    }
}

fn validate_model_entries(entries: &[ModelEntry]) -> Result<(), String> {
    let mut seen_ids = HashSet::new();
    for entry in entries {
        let id = normalize_model_identity(&entry.id);
        if id.is_empty() {
            return Err("Model fetch response contained a model without an identifier".to_string());
        }
        if !seen_ids.insert(id) {
            return Err("Model fetch response contained duplicate model identifiers".to_string());
        }
    }
    Ok(())
}

fn parse_nonnegative_u64(value: &serde_json::Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str()?.trim().parse::<u64>().ok())
}

fn pagination_signals(value: &serde_json::Value) -> (bool, Option<u64>) {
    let Some(object) = value.as_object() else {
        return (false, None);
    };
    pagination_object_signals(object)
}

fn pagination_object_signals(
    object: &serde_json::Map<String, serde_json::Value>,
) -> (bool, Option<u64>) {
    let has_more = ["has_more", "hasMore", "more"]
        .iter()
        .filter_map(|key| object.get(*key))
        .any(|value| value.as_bool() == Some(true));
    let next = [
        "next_cursor",
        "nextCursor",
        "next_page_token",
        "nextPageToken",
    ]
    .iter()
    .filter_map(|key| object.get(*key))
    .any(|value| value.as_str().is_some_and(|value| !value.trim().is_empty()));
    let total = ["total", "total_count", "totalCount"]
        .iter()
        .find_map(|key| object.get(*key).and_then(parse_nonnegative_u64));
    let page = ["page", "current_page", "currentPage"]
        .iter()
        .find_map(|key| object.get(*key).and_then(parse_nonnegative_u64));
    let page_count = ["total_pages", "totalPages", "page_count", "pageCount"]
        .iter()
        .find_map(|key| object.get(*key).and_then(parse_nonnegative_u64));
    let page_incomplete = page
        .zip(page_count)
        .is_some_and(|(page, total_pages)| total_pages > page && total_pages > 0);
    let nested = ["pagination", "meta", "links"]
        .iter()
        .filter_map(|key| object.get(*key))
        .map(pagination_signals)
        .fold(
            (false, None),
            |(left_incomplete, left_total), (right_incomplete, right_total)| {
                (
                    left_incomplete || right_incomplete,
                    left_total.or(right_total),
                )
            },
        );
    (
        has_more
            || next
            || page_incomplete
            || nested.0
            || object.get("next").is_some_and(|value| {
                !value.is_null() && (!value.as_str().is_some_and(|value| value.trim().is_empty()))
            }),
        total.or(nested.1),
    )
}

#[derive(Debug, Default)]
pub(crate) struct ModelIdentityFields {
    pub display_name: Option<String>,
    pub canonical_slug: Option<String>,
    pub slug: Option<String>,
    pub name: Option<String>,
    pub aliases: Option<serde_json::Value>,
    pub supports_parallel_tool_calls: Option<bool>,
}

/// Extract only stable model identity fields advertised by a provider catalog.
///
/// Arbitrary model-entry properties are intentionally not forwarded to the
/// renderer. `metadata` is accepted as a fallback envelope because several
/// OpenAI-compatible providers nest these same fields there.
pub(crate) fn extract_model_identity_fields(
    object: &serde_json::Map<String, serde_json::Value>,
) -> ModelIdentityFields {
    let mut nested_scopes = Vec::new();
    collect_model_metadata_scopes(object, &mut nested_scopes, 0);
    let get_string = |keys: &[&str]| {
        keys.iter()
            .flat_map(|key| metadata_values_for_key(object, &nested_scopes, key))
            .find_map(|value| {
                value
                    .as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            })
    };
    let aliases = ["aliases", "alias", "model_aliases", "modelAliases"]
        .iter()
        .flat_map(|key| metadata_values_for_key(object, &nested_scopes, key))
        .find_map(sanitize_model_aliases);

    ModelIdentityFields {
        display_name: get_string(&["display_name", "displayName"]),
        canonical_slug: get_string(&["canonical_slug", "canonicalSlug"]),
        slug: get_string(&["slug"]),
        name: get_string(&["name"]),
        aliases,
        supports_parallel_tool_calls: ["supportsParallelToolCalls", "supports_parallel_tool_calls"]
            .iter()
            .flat_map(|key| metadata_values_for_key(object, &nested_scopes, key))
            .find_map(serde_json::Value::as_bool),
    }
}

fn metadata_values_for_key<'a>(
    object: &'a serde_json::Map<String, serde_json::Value>,
    nested_scopes: &[&'a serde_json::Map<String, serde_json::Value>],
    key: &str,
) -> Vec<&'a serde_json::Value> {
    object
        .get(key)
        .into_iter()
        .chain(nested_scopes.iter().filter_map(|scope| scope.get(key)))
        .collect()
}

fn collect_model_metadata_scopes<'a>(
    object: &'a serde_json::Map<String, serde_json::Value>,
    scopes: &mut Vec<&'a serde_json::Map<String, serde_json::Value>>,
    depth: u8,
) {
    if depth >= 8 {
        return;
    }
    for key in [
        "metadata",
        "capability",
        "capabilities",
        "protocolCapability",
        "protocol_capability",
        "limit",
        "limits",
    ] {
        let Some(nested) = object.get(key).and_then(serde_json::Value::as_object) else {
            continue;
        };
        scopes.push(nested);
        collect_model_metadata_scopes(nested, scopes, depth + 1);
    }
}

fn sanitize_model_aliases(value: &serde_json::Value) -> Option<serde_json::Value> {
    match value {
        serde_json::Value::Array(values) => {
            let mut aliases = Vec::new();
            for alias in values {
                let Some(alias) = alias.as_str().map(str::trim).filter(|v| !v.is_empty()) else {
                    continue;
                };
                if !aliases.iter().any(|existing| existing == alias) {
                    aliases.push(alias.to_string());
                }
            }
            (!aliases.is_empty()).then_some(serde_json::json!(aliases))
        }
        serde_json::Value::Object(values) => {
            let mut aliases = BTreeMap::new();
            for (alias, target) in values {
                let alias = alias.trim();
                let Some(target) = target.as_str().map(str::trim).filter(|v| !v.is_empty()) else {
                    continue;
                };
                if !alias.is_empty() {
                    aliases.insert(alias.to_string(), target.to_string());
                }
            }
            (!aliases.is_empty()).then_some(serde_json::json!(aliases))
        }
        _ => None,
    }
}

#[derive(Default)]
struct ProviderProtocolMetadata {
    endpoints: Option<Vec<&'static str>>,
    supports_tools: Option<bool>,
    supports_streaming: Option<bool>,
    supports_tool_continuation: Option<bool>,
    parameters_support_tools: Option<bool>,
    invalid: bool,
}

/// Provider declarations identify usable transports, not a completed runtime
/// probe. Binding them locally prevents upstream metadata from changing scope.
fn extract_protocol_capability(
    model_id: &str,
    metadata: &serde_json::Map<String, serde_json::Value>,
    base_url: &str,
    models_url: &str,
) -> Option<serde_json::Value> {
    let base_url = normalize_protocol_capability_base_url(base_url)?;
    if !model_discovery_has_same_origin(&base_url, models_url) {
        return None;
    }
    let upstream_model = model_id.trim();
    if upstream_model.is_empty() {
        return None;
    }

    let mut evidence = ProviderProtocolMetadata::default();
    collect_protocol_metadata(metadata, &mut evidence, 0);
    if evidence.parameters_support_tools == Some(true) {
        evidence.invalid |= !merge_protocol_declaration(&mut evidence.supports_tools, true);
    }
    if evidence.invalid {
        return None;
    }

    let endpoints = match evidence.endpoints {
        Some(endpoints) => endpoints,
        None if evidence.supports_tools == Some(true)
            && is_openrouter_models_discovery(&base_url, models_url) =>
        {
            vec!["openai_chat"]
        }
        None => return None,
    };
    if endpoints.is_empty() {
        return None;
    }

    let mut capability = serde_json::json!({
        "schemaVersion": 1,
        "source": "provider_api",
        "baseUrl": base_url,
        "upstreamModel": upstream_model,
        "supportedEndpoints": endpoints,
    });
    for (key, value) in [
        ("supportsTools", evidence.supports_tools),
        ("supportsStreaming", evidence.supports_streaming),
        (
            "supportsToolContinuation",
            evidence.supports_tool_continuation,
        ),
    ] {
        if let Some(value) = value {
            capability[key] = serde_json::json!(value);
        }
    }
    Some(capability)
}

fn collect_protocol_metadata(
    metadata: &serde_json::Map<String, serde_json::Value>,
    evidence: &mut ProviderProtocolMetadata,
    depth: u8,
) {
    if depth > 8 {
        evidence.invalid = true;
        return;
    }
    for value in ["supported_endpoints", "supportedEndpoints", "endpoints"]
        .iter()
        .filter_map(|key| metadata.get(*key))
    {
        match parse_protocol_endpoints(value) {
            Some(endpoints) => {
                evidence.invalid |= !merge_protocol_declaration(&mut evidence.endpoints, endpoints);
            }
            None => evidence.invalid = true,
        }
    }
    evidence.invalid |= !collect_protocol_flag(
        metadata,
        &[
            "supportsTools",
            "supports_tools",
            "tools",
            "tool_calling",
            "toolCalling",
            "supports_function_calling",
            "supportsFunctionCalling",
            "function_calling",
            "functionCalling",
        ],
        &mut evidence.supports_tools,
    );
    evidence.invalid |= !collect_protocol_flag(
        metadata,
        &[
            "supportsStreaming",
            "supports_streaming",
            "supportsStream",
            "supports_stream",
            "streaming",
            "stream",
        ],
        &mut evidence.supports_streaming,
    );
    evidence.invalid |= !collect_protocol_flag(
        metadata,
        &[
            "supportsToolContinuation",
            "supports_tool_continuation",
            "toolContinuation",
            "tool_continuation",
        ],
        &mut evidence.supports_tool_continuation,
    );
    for value in ["supported_parameters", "supportedParameters"]
        .iter()
        .filter_map(|key| metadata.get(*key))
    {
        let Some(parameters) = value.as_array().and_then(|parameters| {
            parameters
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                })
                .collect::<Option<Vec<_>>>()
        }) else {
            evidence.invalid = true;
            continue;
        };
        let supports_tools = parameters
            .iter()
            .any(|parameter| parameter.eq_ignore_ascii_case("tools"));
        evidence.invalid |=
            !merge_protocol_declaration(&mut evidence.parameters_support_tools, supports_tools);
    }
    for nested in [
        "capability",
        "capabilities",
        "metadata",
        "protocolCapability",
        "protocol_capability",
        "limit",
        "limits",
    ]
    .iter()
    .filter_map(|key| metadata.get(*key).and_then(serde_json::Value::as_object))
    {
        collect_protocol_metadata(nested, evidence, depth + 1);
    }
}

fn collect_protocol_flag(
    metadata: &serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
    declared: &mut Option<bool>,
) -> bool {
    let mut valid = true;
    for value in keys.iter().filter_map(|key| metadata.get(*key)) {
        valid &= value
            .as_bool()
            .is_some_and(|value| merge_protocol_declaration(declared, value));
    }
    valid
}

fn merge_protocol_declaration<T: PartialEq>(declared: &mut Option<T>, value: T) -> bool {
    match declared {
        Some(previous) => *previous == value,
        None => {
            *declared = Some(value);
            true
        }
    }
}

fn parse_protocol_endpoints(value: &serde_json::Value) -> Option<Vec<&'static str>> {
    let mut endpoints = Vec::new();
    for value in value.as_array()? {
        let name = value.as_str()?.trim();
        if name.is_empty() {
            return None;
        }
        let endpoint = match name.to_ascii_lowercase().as_str() {
            "openai_responses" | "openai-responses" | "responses" | "/responses"
            | "v1/responses" | "/v1/responses" => Some("openai_responses"),
            "openai_chat"
            | "openai-chat"
            | "chat"
            | "chat_completions"
            | "chat-completions"
            | "chat.completions"
            | "chat/completions"
            | "/chat/completions"
            | "v1/chat/completions"
            | "/v1/chat/completions" => Some("openai_chat"),
            _ => None,
        };
        if let Some(endpoint) = endpoint {
            endpoints.push(endpoint);
        }
    }
    endpoints.sort_unstable();
    endpoints.dedup();
    Some(endpoints)
}

fn model_discovery_has_same_origin(base_url: &str, models_url: &str) -> bool {
    let (Ok(base), Ok(models)) = (
        reqwest::Url::parse(base_url),
        reqwest::Url::parse(models_url.trim()),
    ) else {
        return false;
    };
    models.username().is_empty()
        && models.password().is_none()
        && models.fragment().is_none()
        && base.origin() == models.origin()
}

fn extract_openrouter_parallel_tool_calls(
    metadata: &serde_json::Map<String, serde_json::Value>,
) -> Option<bool> {
    let mut declaration: Option<Vec<String>> = None;
    for value in ["supported_parameters", "supportedParameters"]
        .iter()
        .filter_map(|key| metadata.get(*key))
    {
        let mut parameters = value
            .as_array()?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::trim)
                    .filter(|parameter| !parameter.is_empty())
                    .map(str::to_ascii_lowercase)
            })
            .collect::<Option<Vec<_>>>()?;
        parameters.sort();
        parameters.dedup();
        if declaration
            .as_ref()
            .is_some_and(|previous| previous != &parameters)
        {
            return None;
        }
        declaration = Some(parameters);
    }
    declaration?
        .iter()
        .any(|parameter| parameter == "parallel_tool_calls")
        .then_some(true)
}

fn is_openrouter_api_url(value: &str, expected_path: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value.trim()) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some("openrouter.ai")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path().trim_end_matches('/') == expected_path
}

/// Recognize an actual OpenRouter model-list response even when the user
/// entered the common `https://openrouter.ai/api` base instead of the
/// normalized `/api/v1` API scope.
///
/// Both the configured API scope and the successful model-list endpoint must
/// identify OpenRouter before applying its provider-specific defaults.
fn is_openrouter_models_discovery(base_url: &str, models_url: &str) -> bool {
    (is_openrouter_api_url(base_url, "/api/v1") || is_openrouter_api_url(base_url, "/api"))
        && is_openrouter_api_url(models_url, "/api/v1/models")
        && model_discovery_has_same_origin(base_url, models_url)
}

fn is_native_google_models_discovery(base_url: &str, models_url: &str) -> bool {
    let (Ok(base), Ok(models)) = (
        reqwest::Url::parse(base_url.trim()),
        reqwest::Url::parse(models_url.trim()),
    ) else {
        return false;
    };
    if base.host_str() != Some("generativelanguage.googleapis.com")
        || !is_safe_known_gateway_url(&base)
        || !is_safe_known_gateway_url(&models)
        || base.origin() != models.origin()
    {
        return false;
    }
    let expected_path = match base.path().trim_end_matches('/') {
        "" | "/v1beta" => "/v1beta/models",
        "/v1" => "/v1/models",
        _ => return false,
    };
    models.path().trim_end_matches('/') == expected_path
}

/// Derive a conservative free/paid signal from provider model metadata.
///
/// This is intentionally tri-state: `None` means the provider did not give us
/// enough trustworthy billing metadata. A terminal `:free` suffix is accepted
/// only when no conflicting pricing metadata is present; model names and
/// unrelated fields such as `access: "open"` never prove free access.
fn classify_model_free_status(
    model_id: &str,
    metadata: &serde_json::Map<String, serde_json::Value>,
) -> Option<bool> {
    let explicit = match metadata.get("isFree").or_else(|| metadata.get("is_free")) {
        None => None,
        Some(serde_json::Value::Bool(value)) => Some(*value),
        Some(_) => return None,
    };
    let has_free_suffix = model_id.trim().to_ascii_lowercase().ends_with(":free");
    let aggregate_cost = metadata
        .get("cost")
        .map(classify_price_value)
        .filter(|sign| *sign != PriceSign::Invalid);

    if explicit == Some(false) {
        return Some(false);
    }

    let Some(pricing) = metadata.get("pricing") else {
        return match aggregate_cost {
            Some(PriceSign::Positive) => Some(false),
            Some(PriceSign::Zero) => Some(true),
            Some(PriceSign::Negative) => None,
            Some(PriceSign::Invalid) | None => explicit.or_else(|| has_free_suffix.then_some(true)),
        };
    };

    let Some(pricing_object) = pricing.as_object() else {
        return match explicit {
            Some(false) => Some(false),
            _ => None,
        };
    };

    let evidence = pricing_evidence(pricing_object);
    if explicit == Some(false) || evidence.has_positive {
        return Some(false);
    }
    if evidence.has_invalid || evidence.has_negative {
        return None;
    }
    if evidence.has_charge_fields {
        return match (evidence.prompt, evidence.completion, aggregate_cost) {
            (Some(PriceSign::Zero), Some(PriceSign::Zero), _) => Some(true),
            (None, None, Some(PriceSign::Zero)) => Some(true),
            _ => None,
        };
    }

    match aggregate_cost {
        Some(PriceSign::Positive) => Some(false),
        Some(PriceSign::Zero) => Some(true),
        Some(PriceSign::Negative) => None,
        Some(PriceSign::Invalid) | None => explicit.or_else(|| has_free_suffix.then_some(true)),
    }
}

fn pricing_evidence(pricing: &serde_json::Map<String, serde_json::Value>) -> PricingEvidence {
    let mut evidence = PricingEvidence::default();
    collect_pricing_evidence(pricing, None, &mut evidence);
    evidence
}

fn collect_pricing_evidence(
    object: &serde_json::Map<String, serde_json::Value>,
    parent_key: Option<&str>,
    evidence: &mut PricingEvidence,
) {
    for (key, value) in object {
        let normalized_key = normalize_pricing_key(key);
        let is_charge = PRICING_CHARGE_KEYS.contains(&normalized_key.as_str())
            || (parent_key == Some("cache")
                && NESTED_CACHE_PRICE_KEYS.contains(&normalized_key.as_str()));
        if is_charge {
            evidence.has_charge_fields = true;
            let sign = classify_price_value(value);
            match (parent_key, normalized_key.as_str()) {
                (None, "prompt") => evidence.prompt = Some(sign),
                (None, "completion") => evidence.completion = Some(sign),
                _ => {}
            }
            match sign {
                PriceSign::Positive => evidence.has_positive = true,
                PriceSign::Negative => evidence.has_negative = true,
                PriceSign::Invalid => evidence.has_invalid = true,
                PriceSign::Zero => {}
            }
        }
        if normalized_key == "overrides" {
            let Some(overrides) = value.as_array() else {
                evidence.has_invalid = true;
                continue;
            };
            for override_value in overrides {
                let Some(override_object) = override_value.as_object() else {
                    evidence.has_invalid = true;
                    continue;
                };
                collect_pricing_evidence(override_object, Some("overrides"), evidence);
            }
            continue;
        }
        if let Some(child) = value.as_object() {
            collect_pricing_evidence(child, Some(normalized_key.as_str()), evidence);
        }
    }
}

fn normalize_pricing_key(value: &str) -> String {
    value
        .trim()
        .chars()
        .map(|character| match character {
            '-' | ' ' => '_',
            character => character.to_ascii_lowercase(),
        })
        .collect()
}

/// Classify a JSON number/string without floating-point underflow.
fn classify_price_value(value: &serde_json::Value) -> PriceSign {
    let text = match value {
        serde_json::Value::Number(number) => number.to_string(),
        serde_json::Value::String(text) => text.trim().to_string(),
        _ => return PriceSign::Invalid,
    };
    classify_decimal_text(&text)
}

fn classify_decimal_text(value: &str) -> PriceSign {
    let value = value.trim();
    if value.is_empty() {
        return PriceSign::Invalid;
    }

    let (negative, unsigned) = match value.as_bytes()[0] {
        b'+' => (false, &value[1..]),
        b'-' => (true, &value[1..]),
        _ => (false, value),
    };
    if unsigned.is_empty() {
        return PriceSign::Invalid;
    }

    let (mantissa, exponent) = match unsigned.split_once(['e', 'E']) {
        Some((mantissa, exponent)) => (mantissa, Some(exponent)),
        None => (unsigned, None),
    };
    if let Some(exponent) = exponent {
        let exponent = exponent
            .strip_prefix('+')
            .or_else(|| exponent.strip_prefix('-'))
            .unwrap_or(exponent);
        if exponent.is_empty() || !exponent.bytes().all(|byte| byte.is_ascii_digit()) {
            return PriceSign::Invalid;
        }
    }

    let mut digit_count = 0;
    let mut nonzero = false;
    let mut decimal_points = 0;
    for byte in mantissa.bytes() {
        match byte {
            b'0'..=b'9' => {
                digit_count += 1;
                nonzero |= byte != b'0';
            }
            b'.' => {
                decimal_points += 1;
                if decimal_points > 1 {
                    return PriceSign::Invalid;
                }
            }
            _ => return PriceSign::Invalid,
        }
    }
    if digit_count == 0 {
        return PriceSign::Invalid;
    }
    if !nonzero {
        PriceSign::Zero
    } else if negative {
        PriceSign::Negative
    } else {
        PriceSign::Positive
    }
}

fn redact_model_fetch_error_body(body: String, known_secrets: &[String]) -> String {
    truncate_body(crate::redact_known_secrets_strict(&body, known_secrets))
}

fn build_model_fetch_headers(
    api_key: &str,
    api_format: Option<&str>,
    user_agent: Option<&HeaderValue>,
    request_headers: Option<&BTreeMap<String, String>>,
) -> Result<HeaderMap, String> {
    let custom_count = request_headers.map_or(0, BTreeMap::len);
    if api_key.is_empty() && custom_count == 0 {
        return Err("API Key or request headers are required to fetch models".to_string());
    }
    if custom_count > MAX_REQUEST_HEADERS {
        return Err(format!(
            "Too many model-fetch request headers (maximum {MAX_REQUEST_HEADERS})"
        ));
    }

    let mut headers = HeaderMap::new();
    if !api_key.is_empty() {
        let (name, value) = match api_format {
            Some("anthropic-messages") => (
                HeaderName::from_static("x-api-key"),
                HeaderValue::from_str(api_key)
                    .map_err(|error| format!("Invalid API Key header value: {error}"))?,
            ),
            Some("google-generative-ai") => (
                HeaderName::from_static("x-goog-api-key"),
                HeaderValue::from_str(api_key)
                    .map_err(|error| format!("Invalid API Key header value: {error}"))?,
            ),
            _ => (
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {api_key}"))
                    .map_err(|error| format!("Invalid API Key header value: {error}"))?,
            ),
        };
        headers.insert(name, value);
    }
    if let Some(user_agent) = user_agent {
        headers.insert(USER_AGENT, user_agent.clone());
    }
    if let Some(request_headers) = request_headers {
        for (raw_name, raw_value) in request_headers {
            let name = raw_name.trim();
            if name.is_empty() || name.len() > MAX_HEADER_NAME_BYTES {
                return Err(format!("Invalid model-fetch header name: {raw_name}"));
            }
            if raw_value.len() > MAX_HEADER_VALUE_BYTES {
                return Err(format!("Model-fetch header value is too large: {name}"));
            }
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|error| format!("Invalid model-fetch header name {name}: {error}"))?;
            let value = HeaderValue::from_str(raw_value)
                .map_err(|error| format!("Invalid model-fetch header value for {name}: {error}"))?;
            headers.insert(name, value);
        }
    }
    Ok(headers)
}

/// 构造「模型列表端点」的候选 URL 列表
///
/// 候选顺序：
/// 1. `models_url_override` 非空 → 只返回它
/// 2. baseURL 拼 `/v1/models`；若已以版本段 `/v{N}` 结尾（`/v1`、智谱
///    `/api/coding/paas/v4` 等），版本号已在路径里，改拼 `/models`
/// 3. 版本段非 `/v1`（如 `/v4`）时再追加 `/v1/models` 作为兜底次候选
/// 4. 若 baseURL 命中 [`KNOWN_COMPAT_SUFFIXES`]，剥离后缀再拼 `/v1/models`、`/models`
///
/// 从不同供应商的 `/models` 条目中提取上下文窗口。
///
/// OpenAI-compatible 聚合器没有统一字段名，这里只接受明确的正整数，
/// 避免把价格、限流等其它数值误当作 context window。
fn extract_context_window(obj: &serde_json::Map<String, serde_json::Value>) -> Option<u64> {
    const KEYS: &[&str] = &[
        "context",
        "context_window",
        "context_length",
        "contextLength",
        "ContextWindow",
        "ContextLength",
        "max_context_window",
        "max_context_length",
        "contextWindow",
        "maxContextWindow",
        "maxContextLength",
        "max_model_len",
        "maxModelLen",
        "max_input_tokens",
        "maxInputTokens",
        "max_prompt_tokens",
        "maxPromptTokens",
        "input_token_limit",
        "inputTokenLimit",
    ];

    let direct = KEYS
        .iter()
        .filter_map(|key| obj.get(*key))
        .find_map(parse_positive_u64);
    if direct.is_some() {
        return direct;
    }

    [
        "limit",
        "limits",
        "capability",
        "capabilities",
        "protocolCapability",
        "protocol_capability",
        "metadata",
    ]
    .iter()
    .filter_map(|key| obj.get(*key).and_then(|value| value.as_object()))
    .find_map(extract_context_window)
}

/// 从 OpenAI-compatible `/models` 的供应商扩展字段中读取输入模态。
///
/// 只有上游明确声明时才透传，避免把未知能力误推成支持图片。
pub(crate) fn extract_input_modalities(
    obj: &serde_json::Map<String, serde_json::Value>,
) -> Option<Vec<String>> {
    if let Some(modalities) = [
        "input_modalities",
        "inputModalities",
        "modalities",
        "architecture",
        "capabilities",
        "metadata",
    ]
    .iter()
    .filter_map(|key| obj.get(*key))
    .find_map(parse_input_modalities)
    {
        return Some(modalities);
    }

    for key in [
        "metadata",
        "capability",
        "capabilities",
        "protocolCapability",
        "protocol_capability",
        "limit",
        "limits",
    ] {
        if let Some(modalities) = obj
            .get(key)
            .and_then(serde_json::Value::as_object)
            .and_then(extract_input_modalities)
        {
            return Some(modalities);
        }
    }
    None
}

fn parse_input_modalities(value: &serde_json::Value) -> Option<Vec<String>> {
    let values = match value {
        serde_json::Value::Array(items) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::trim)
                    .filter(|item| !item.is_empty())
                    .map(ToString::to_string)
            })
            .collect::<Option<Vec<_>>>()?,
        serde_json::Value::Object(obj) => {
            if let Some(input) = obj
                .get("input")
                .or_else(|| obj.get("inputs"))
                .or_else(|| obj.get("input_modalities"))
                .or_else(|| obj.get("inputModalities"))
                .or_else(|| obj.get("modalities"))
            {
                parse_input_modalities(input)?
            } else {
                return None;
            }
        }
        _ => return None,
    };

    Some(values)
}

pub(crate) fn extract_supports_image(
    obj: &serde_json::Map<String, serde_json::Value>,
) -> Option<bool> {
    let explicit = [
        "supports_image",
        "supportsImage",
        "vision",
        "supports_vision",
        "supportsVision",
        "supports_image_detail_original",
        "supportsImageDetailOriginal",
    ]
    .iter()
    .filter_map(|key| obj.get(*key))
    .find_map(serde_json::Value::as_bool);
    if explicit.is_some() {
        return explicit;
    }

    for key in [
        "metadata",
        "capability",
        "capabilities",
        "protocolCapability",
        "protocol_capability",
        "limit",
        "limits",
    ] {
        if let Some(nested) = obj
            .get(key)
            .and_then(serde_json::Value::as_object)
            .and_then(extract_supports_image)
        {
            return Some(nested);
        }
    }

    extract_input_modalities(obj).map(|modalities| {
        modalities
            .iter()
            .any(|modality| modality.eq_ignore_ascii_case("image"))
    })
}

/// 解析火山 `ListArkAgentPlanModel` / `ListArkCodingPlanModel` 的模型列表。
///
/// 官方文档示例是 `Result.Datas[].ModelID`；这里额外兼容少量常见字段名，
/// 以便 OpenAPI 后续扩展字段时不破坏已有模型列表刷新。
fn parse_volcengine_plan_models(body: &serde_json::Value) -> Vec<FetchedModel> {
    let candidates = [
        body.pointer("/Result/Datas"),
        body.pointer("/Result/Models"),
        body.pointer("/Result/ModelList"),
        body.pointer("/Result/Items"),
        body.get("Result"),
        body.get("Datas"),
        Some(body),
    ];
    let Some(entries) = candidates
        .into_iter()
        .flatten()
        .find_map(|value| value.as_array())
    else {
        return Vec::new();
    };

    let mut models = entries
        .iter()
        .filter_map(parse_volcengine_plan_model_entry)
        .collect::<Vec<_>>();
    models.sort_by(|left, right| left.id.cmp(&right.id));
    models.dedup_by(|left, right| left.id == right.id);
    models
}

/// 解析火山模型列表中的单个模型条目。
fn parse_volcengine_plan_model_entry(entry: &serde_json::Value) -> Option<FetchedModel> {
    if let Some(model_id) = entry
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(FetchedModel {
            id: model_id.to_string(),
            owned_by: Some("volcengine".to_string()),
            context_window: None,
            input_modalities: None,
            supports_image: None,
            reasoning: None,
            protocol_capability: None,
            is_free: None,
            ..Default::default()
        });
    }

    let obj = entry.as_object()?;
    let id = [
        "ModelID",
        "ModelId",
        "modelID",
        "modelId",
        "ModelName",
        "Model",
        "Id",
        "id",
    ]
    .iter()
    .filter_map(|key| obj.get(*key).and_then(|value| value.as_str()))
    .map(str::trim)
    .find(|value| !value.is_empty())?;

    Some(FetchedModel {
        id: id.to_string(),
        owned_by: Some("volcengine".to_string()),
        context_window: extract_context_window(obj),
        input_modalities: extract_input_modalities(obj),
        supports_image: extract_supports_image(obj),
        reasoning: None,
        protocol_capability: None,
        is_free: None,
        ..Default::default()
    })
}

/// 为缺失模型目录事实执行分层补齐。
///
/// 顺序保持保守：`/models` 显式 metadata 已在调用前解析完成；这里仅对仍为空的模型
/// 先查本地预设表（离线可用、WebDAV 同步），再尝试 provider 官方来源，
/// 最后尝试能按 API 前缀匹配的公共目录。
async fn enrich_missing_context_windows(
    client: &reqwest::Client,
    endpoint_url: &str,
    models: &mut [FetchedModel],
) {
    if !models.iter().any(|model| {
        model.context_window.is_none()
            || model.input_modalities.is_none()
            || model.supports_image.is_none()
    }) {
        return;
    }

    enrich_preset_catalog_context_windows(endpoint_url, models);
    enrich_zhipu_context_windows(client, endpoint_url, models).await;
    enrich_models_dev_context_windows(client, endpoint_url, models).await;
}

/// 用本地预设表（`~/.cc-switch/preset-table.json`）补齐安全的模型事实。
///
/// 与远端 models.dev 兜底同一套防误配规则：只有 endpoint 落在 bundle 声明的
/// 官方 API 前缀内才使用；只填充缺失值，不覆盖上游显式 metadata。调用方言、
/// reasoning 参数和 agent 工具语义不在这里猜测，它们必须来自审核后的策略覆盖。
/// 本地文件缺失或损坏时静默跳过，不影响后续远端补齐。
fn enrich_preset_catalog_context_windows(endpoint_url: &str, models: &mut [FetchedModel]) {
    if !models.iter().any(|model| {
        model.context_window.is_none()
            || model.input_modalities.is_none()
            || model.supports_image.is_none()
    }) {
        return;
    }
    let Some(bundle) = crate::services::preset_catalog::load_default_bundle() else {
        return;
    };
    let Some(provider) =
        crate::services::preset_catalog::find_provider_for_endpoint(&bundle, endpoint_url)
    else {
        return;
    };
    apply_missing_catalog_facts(models, |model_id| {
        crate::services::preset_catalog::lookup_baseline(&bundle, provider, model_id)
    });
}

fn entry_context_window(entry: &serde_json::Value) -> Option<u64> {
    entry
        .get("limit")
        .and_then(|value| value.as_object())
        .and_then(|limit| limit.get("context"))
        .and_then(parse_positive_u64)
}

fn entry_input_modalities(entry: &serde_json::Value) -> Option<Vec<String>> {
    entry
        .get("modalities")
        .and_then(|value| value.as_object())
        .and_then(|modalities| modalities.get("input"))
        .and_then(parse_input_modalities)
}

/// Applies only catalog facts whose semantics do not depend on API dialect.
/// A declared `/models` value always has higher precedence than catalog data.
fn apply_missing_catalog_facts<'a, F>(models: &mut [FetchedModel], mut lookup: F)
where
    F: FnMut(&str) -> Option<&'a serde_json::Value>,
{
    for model in models.iter_mut() {
        let Some(entry) = lookup(&model.id) else {
            continue;
        };
        if model.context_window.is_none() {
            model.context_window = entry_context_window(entry);
        }
        if model.input_modalities.is_none() {
            model.input_modalities = entry_input_modalities(entry);
        }
        if model.supports_image.is_none() {
            model.supports_image = entry_input_modalities(entry)
                .map(|modalities| modalities.iter().any(|modality| modality == "image"));
        }
    }
}

/// 为智谱模型补齐官方文档里的上下文窗口。
///
/// 智谱 Coding Plan 的 `/models` 响应只证明账号可用模型集合，模型规格需要从官方文档取。
/// 这里只填充缺失值，不覆盖上游未来可能直接返回的真实 metadata。
async fn enrich_zhipu_context_windows(
    client: &reqwest::Client,
    endpoint_url: &str,
    models: &mut [FetchedModel],
) {
    if !is_zhipu_models_endpoint(endpoint_url)
        || !models
            .iter()
            .any(|model| model.context_window.is_none() && is_glm_model_id(&model.id))
    {
        return;
    }

    let mut contexts = fetch_zhipu_model_overview_contexts(client).await;
    enrich_missing_zhipu_detail_contexts(client, models, &mut contexts).await;

    apply_missing_context_windows(models, |model_id| {
        let key = normalize_zhipu_model_id(model_id);
        contexts.get(&key).copied()
    });
}

/// 通过 models.dev 的 `limit.context` 补齐上下文窗口。
///
/// 只在 endpoint 与 provider.api 前缀匹配时使用，避免跨供应商同名模型误配。该来源是
/// 公共目录，因此优先级低于上游 `/models` 显式字段和 provider 官方文档。
async fn enrich_models_dev_context_windows(
    client: &reqwest::Client,
    endpoint_url: &str,
    models: &mut [FetchedModel],
) {
    if !models.iter().any(|model| model.context_window.is_none()) {
        return;
    }

    let Some(catalog) = fetch_models_dev_catalog(client).await else {
        return;
    };
    let Some(provider_models) = find_models_dev_provider_models(&catalog, endpoint_url) else {
        return;
    };

    apply_missing_context_windows(models, |model_id| {
        lookup_models_dev_context(provider_models, model_id)
    });
}

/// 将外部来源查到的上下文窗口应用到模型列表。
///
/// 这是所有补齐来源共享的不变量：只填充 `/models` 未返回上下文的条目，永远不覆盖
/// 上游已经明确给出的真实 metadata。
fn apply_missing_context_windows<F>(models: &mut [FetchedModel], mut lookup: F)
where
    F: FnMut(&str) -> Option<u64>,
{
    for model in models.iter_mut() {
        if model.context_window.is_none() {
            model.context_window = lookup(&model.id);
        }
    }
}

/// 拉取 models.dev 目录；失败时返回 `None`，不影响 `/models` 主流程。
async fn fetch_models_dev_catalog(client: &reqwest::Client) -> Option<serde_json::Value> {
    let response = client
        .get(MODELS_DEV_API_URL)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<serde_json::Value>().await.ok()
}

/// 从 models.dev 目录中找到与当前 endpoint 匹配的 provider models 对象。
fn find_models_dev_provider_models<'a>(
    catalog: &'a serde_json::Value,
    endpoint_url: &str,
) -> Option<&'a serde_json::Map<String, serde_json::Value>> {
    catalog
        .as_object()?
        .values()
        .filter_map(|provider| provider.as_object())
        .find(|provider| {
            provider
                .get("api")
                .and_then(|value| value.as_str())
                .is_some_and(|api| endpoint_matches_provider_api(endpoint_url, api))
        })
        .and_then(|provider| provider.get("models"))
        .and_then(|models| models.as_object())
}

/// 判断 `/models` endpoint 是否属于 models.dev provider.api。
pub(crate) fn endpoint_matches_provider_api(endpoint_url: &str, provider_api: &str) -> bool {
    let Ok(endpoint) = reqwest::Url::parse(endpoint_url.trim()) else {
        return false;
    };
    let Ok(api) = reqwest::Url::parse(provider_api.trim()) else {
        return false;
    };
    if !is_safe_known_gateway_url(&endpoint)
        || !is_safe_known_gateway_url(&api)
        || endpoint.scheme() != api.scheme()
        || !endpoint
            .host_str()
            .zip(api.host_str())
            .is_some_and(|(left, right)| left.eq_ignore_ascii_case(right))
    {
        return false;
    }

    let endpoint_path = endpoint.path().trim_end_matches('/');
    let endpoint_path = endpoint_path
        .strip_suffix("/models")
        .unwrap_or(endpoint_path);
    let api_path = api.path().trim_end_matches('/');
    if endpoint
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("opencode.ai"))
    {
        let api_path = api_path.strip_suffix("/models").unwrap_or(api_path);
        return opencode_models_scope(endpoint_path)
            .zip(opencode_models_scope(api_path))
            .is_some_and(|(endpoint_scope, api_scope)| endpoint_scope == api_scope);
    }

    endpoint_path == api_path
        || endpoint_path
            .strip_prefix(api_path)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn is_safe_known_gateway_url(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

/// 在已匹配 provider 的 models.dev 模型表里查找 context window。
fn lookup_models_dev_context(
    provider_models: &serde_json::Map<String, serde_json::Value>,
    model_id: &str,
) -> Option<u64> {
    let fetched = normalize_models_dev_model_id(model_id);
    let mut suffix_matches = Vec::new();
    let mut exact_identity_without_context = false;

    for (key, value) in provider_models {
        let Some(model_obj) = value.as_object() else {
            continue;
        };
        let catalog_id = model_obj.get("id").and_then(|id| id.as_str());
        if models_dev_model_id_matches_exact(&fetched, key, catalog_id) {
            if let Some(context) = extract_models_dev_entry_context(model_obj) {
                return Some(context);
            }
            exact_identity_without_context = true;
            continue;
        }
        if exact_identity_without_context {
            continue;
        }
        let Some(context) = extract_models_dev_entry_context(model_obj) else {
            continue;
        };
        if models_dev_model_id_matches_suffix(&fetched, key, catalog_id) {
            suffix_matches.push(context);
        }
    }

    if !exact_identity_without_context && suffix_matches.len() == 1 {
        suffix_matches.into_iter().next()
    } else {
        None
    }
}

/// 从 models.dev 单个模型条目中提取正数 `limit.context`。
fn extract_models_dev_entry_context(
    model_obj: &serde_json::Map<String, serde_json::Value>,
) -> Option<u64> {
    model_obj
        .get("limit")
        .and_then(|limit| limit.as_object())
        .and_then(|limit| limit.get("context"))
        .and_then(parse_positive_u64)
        .filter(|context| *context > 0)
}

/// 判断 `/models` 返回的模型 id 是否精确匹配 models.dev 的 key 或 `id` 字段。
fn models_dev_model_id_matches_exact(
    fetched_model_id: &str,
    catalog_key: &str,
    catalog_id: Option<&str>,
) -> bool {
    let key = normalize_models_dev_model_id(catalog_key);
    let id = catalog_id.map(normalize_models_dev_model_id);

    fetched_model_id == key || id.as_deref() == Some(fetched_model_id)
}

/// 判断 `/models` 返回的模型 id 是否唯一后缀匹配 models.dev 的 key 或 `id` 字段。
fn models_dev_model_id_matches_suffix(
    fetched_model_id: &str,
    catalog_key: &str,
    catalog_id: Option<&str>,
) -> bool {
    let key = normalize_models_dev_model_id(catalog_key);
    let id = catalog_id.map(normalize_models_dev_model_id);

    key.rsplit('/').next() == Some(fetched_model_id)
        || id.as_deref().and_then(|value| value.rsplit('/').next()) == Some(fetched_model_id)
}

/// 归一化 models.dev 模型 id，去掉大小写、`:free` 等后缀和 `[1m]` 标记差异。
fn normalize_models_dev_model_id(value: &str) -> String {
    let mut normalized = value.trim().to_ascii_lowercase();
    if let Some(before_colon) = normalized.split(':').next() {
        normalized = before_colon.to_string();
    }
    if normalized.ends_with("[1m]") {
        normalized = normalized[..normalized.len() - "[1m]".len()]
            .trim()
            .to_string();
    }
    normalized
}

/// 判断当前成功的 `/models` endpoint 是否属于智谱/Z.AI。
fn is_zhipu_models_endpoint(endpoint_url: &str) -> bool {
    let lower = endpoint_url.to_ascii_lowercase();
    lower.contains("open.bigmodel.cn") || lower.contains("api.z.ai")
}

/// 判断模型 id 是否是 GLM 文本/视觉模型。
fn is_glm_model_id(model_id: &str) -> bool {
    let normalized = normalize_zhipu_model_id(model_id);
    normalized.starts_with("glm-") || normalized.contains("/glm-")
}

/// 拉取智谱模型概览表，并解析模型上下文列。
///
/// 网络或文档格式异常只会导致补充 metadata 缺失，不阻断 `/models` 本身成功返回。
async fn fetch_zhipu_model_overview_contexts(client: &reqwest::Client) -> HashMap<String, u64> {
    let text = match client
        .get(ZHIPU_MODEL_OVERVIEW_MD_URL)
        .timeout(Duration::from_secs(5))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => response.text().await.ok(),
        _ => None,
    };

    text.as_deref()
        .map(parse_zhipu_model_overview_contexts)
        .unwrap_or_default()
}

/// 对概览表没覆盖的 GLM 模型，按官方单模型 markdown 页面补查上下文。
///
/// 例如 `glm-4.5` 的规格在 `glm-4.5.md` 概览卡片中，而概览表当前只列出
/// `GLM-4.5-Air`；补查可以让真实 `/models` 返回的 `glm-4.5` 也得到 128K。
async fn enrich_missing_zhipu_detail_contexts(
    client: &reqwest::Client,
    models: &[FetchedModel],
    contexts: &mut HashMap<String, u64>,
) {
    for model in models {
        if model.context_window.is_some() {
            continue;
        }
        let key = normalize_zhipu_model_id(&model.id);
        if contexts.contains_key(&key) {
            continue;
        }
        let Some(slug) = zhipu_docs_slug_for_model_id(&model.id) else {
            continue;
        };
        if let Some(context) = fetch_zhipu_detail_context(client, &slug).await {
            contexts.insert(key, context);
        }
    }
}

/// 将 GLM 模型 id 映射到智谱文档 markdown slug。
fn zhipu_docs_slug_for_model_id(model_id: &str) -> Option<String> {
    let normalized = normalize_zhipu_model_id(model_id);
    if !normalized.starts_with("glm-") {
        return None;
    }
    if normalized.starts_with("glm-4.5") {
        return Some("glm-4.5".to_string());
    }
    Some(normalized)
}

/// 拉取单模型 markdown 页面，并解析“上下文窗口”卡片。
async fn fetch_zhipu_detail_context(client: &reqwest::Client, slug: &str) -> Option<u64> {
    let url = format!("https://docs.bigmodel.cn/cn/guide/models/text/{slug}.md");
    let response = client
        .get(url)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let text = response.text().await.ok()?;
    parse_zhipu_detail_context(&text)
}

/// 解析智谱模型概览 markdown 表格中的“模型 / 上下文”列。
fn parse_zhipu_model_overview_contexts(markdown: &str) -> HashMap<String, u64> {
    let mut contexts = HashMap::new();
    let mut pending_row = String::new();

    for line in markdown.lines() {
        let trimmed = line.trim();
        if pending_row.is_empty() {
            if !trimmed.starts_with("| [") {
                continue;
            }
            pending_row.push_str(trimmed);
        } else {
            pending_row.push('\n');
            pending_row.push_str(trimmed);
        }

        if pending_row.matches('|').count() < 5 || !trimmed.ends_with('|') {
            continue;
        }

        if let Some((model, context)) = parse_zhipu_overview_table_row(&pending_row) {
            contexts.insert(model, context);
        }
        pending_row.clear();
    }

    contexts
}

/// 解析单行智谱模型表格。
fn parse_zhipu_overview_table_row(row: &str) -> Option<(String, u64)> {
    let columns = row
        .split('|')
        .map(str::trim)
        .filter(|column| !column.is_empty())
        .collect::<Vec<_>>();
    if columns.len() < 4 {
        return None;
    }

    let model = extract_markdown_link_label(columns[0]).unwrap_or(columns[0]);
    let context = parse_context_tokens(columns[2])?;
    Some((normalize_zhipu_model_id(model), context))
}

/// 从 markdown 链接 `[label](url)` 中取 label；非链接返回 `None`。
fn extract_markdown_link_label(value: &str) -> Option<&str> {
    let start = value.find('[')? + 1;
    let end = value[start..].find(']')? + start;
    Some(&value[start..end])
}

/// 解析单模型页概览卡片中的“上下文窗口”值。
fn parse_zhipu_detail_context(markdown: &str) -> Option<u64> {
    let mut seen_context_card = false;
    let mut waiting_for_value = false;

    for line in markdown.lines() {
        let trimmed = line.trim();
        if trimmed.contains("title=\"上下文窗口\"") {
            seen_context_card = true;
            waiting_for_value = trimmed.contains("}>");
            continue;
        }
        if seen_context_card && trimmed.contains("}>") {
            waiting_for_value = true;
            continue;
        }
        if waiting_for_value
            && !trimmed.is_empty()
            && !trimmed.starts_with('<')
            && !trimmed.starts_with('}')
        {
            return parse_context_tokens(trimmed);
        }
    }

    None
}

/// 统一模型 id：大小写、空格、`ZhipuAI/` 命名空间和 `[1m]` 后缀都不影响匹配。
fn normalize_zhipu_model_id(value: &str) -> String {
    let mut normalized = value.trim().to_ascii_lowercase();
    if let Some(stripped) = normalized.strip_prefix("zhipuai/") {
        normalized = stripped.to_string();
    }
    normalized = normalized.replace(' ', "-");
    normalized = normalized.replace("[1m]", "");
    normalized = normalized.replace("（即将下线）", "");
    normalized.trim().to_string()
}

/// 将智谱文档里的 `1M`、`200K`、纯数字解析为 token 数。
fn parse_context_tokens(value: &str) -> Option<u64> {
    let compact = value
        .trim()
        .trim_matches('`')
        .replace([',', ' '], "")
        .to_ascii_lowercase();
    if compact.is_empty() || compact.contains('：') || compact.contains("≤") {
        return None;
    }
    if let Some(number) = compact.strip_suffix('m') {
        return number.parse::<u64>().ok().map(|value| value * 1_000_000);
    }
    if let Some(number) = compact.strip_suffix('k') {
        return number.parse::<u64>().ok().map(|value| value * 1_000);
    }
    compact.parse::<u64>().ok().filter(|value| *value > 0)
}

/// 将 JSON 数字或纯数字字符串解析为正整数。
///
/// 浮点数、负数、空字符串和带单位的文本都会被忽略，调用方保留原有兜底逻辑。
fn parse_positive_u64(value: &serde_json::Value) -> Option<u64> {
    match value {
        serde_json::Value::Number(number) => number.as_u64().filter(|v| *v > 0),
        serde_json::Value::String(text) => {
            text.trim().parse::<u64>().ok().filter(|value| *value > 0)
        }
        _ => None,
    }
}

/// 构造「模型列表端点」的候选 URL 列表。
///
/// 候选顺序：
/// 1. `models_url_override` 非空 → 只返回它
/// 2. baseURL 拼 `/v1/models`；若已以版本段 `/v{N}` 结尾（`/v1`、智谱
///    `/api/coding/paas/v4` 等），版本号已在路径里，改拼 `/models`
/// 3. 版本段非 `/v1`（如 `/v4`）时再追加 `/v1/models` 作为兜底次候选
/// 4. 若 baseURL 命中 [`KNOWN_COMPAT_SUFFIXES`]，剥离后缀再拼 `/v1/models`、`/models`
///
/// 结果已去重且保持首次出现顺序。
pub fn build_models_url_candidates(
    base_url: &str,
    is_full_url: bool,
    models_url_override: Option<&str>,
) -> Result<Vec<String>, String> {
    if let Some(raw) = models_url_override {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(vec![trimmed.to_string()]);
        }
    }

    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Base URL is empty".to_string());
    }

    let mut candidates: Vec<String> = Vec::new();

    if is_full_url {
        if let Some(idx) = trimmed.find("/v1/") {
            candidates.push(format!("{}/v1/models", &trimmed[..idx]));
        } else if let Some(idx) = trimmed.rfind('/') {
            let root = &trimmed[..idx];
            if root.contains("://") && root.len() > root.find("://").unwrap() + 3 {
                candidates.push(format!("{root}/v1/models"));
            }
        }
        if candidates.is_empty() {
            return Err("Cannot derive models endpoint from full URL".to_string());
        }
        return Ok(candidates);
    }

    // These vendors expose model discovery outside their Anthropic API tree.
    // Resolve saved providers too; an explicit user override above always wins.
    if let Ok(mut url) = reqwest::Url::parse(trimmed) {
        if let Some(models_url) = known_gateway_models_url(&url) {
            return Ok(vec![models_url]);
        }
        if url.scheme() == "https"
            && url
                .host_str()
                .is_some_and(|host| host.eq_ignore_ascii_case("opencode.ai"))
            && url.query().is_none()
            && url.fragment().is_none()
        {
            let path = url.path().trim_end_matches('/');
            let scope = if path == "/zen/go"
                || path.starts_with("/zen/go/")
                || path == "/inference/go"
                || path.starts_with("/inference/go/")
            {
                Some(if path.starts_with("/zen/go") {
                    "/zen/go"
                } else {
                    "/inference/go"
                })
            } else if path == "/zen"
                || path.starts_with("/zen/")
                || path == "/inference"
                || path.starts_with("/inference/")
            {
                Some(if path.starts_with("/zen") {
                    "/zen"
                } else {
                    "/inference"
                })
            } else {
                None
            };
            if let Some(scope) = scope {
                url.set_path(&format!("{scope}/v1/models"));
                return Ok(vec![url.to_string()]);
            }
        }
        if url.scheme() == "https"
            && url
                .host_str()
                .is_some_and(|host| host.eq_ignore_ascii_case("generativelanguage.googleapis.com"))
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
        {
            let path = url.path().trim_end_matches('/');
            let version = match path {
                "" | "/v1beta" => "/v1beta",
                "/v1" => "/v1",
                _ => "",
            };
            if !version.is_empty() {
                url.set_path(&format!("{version}/models"));
                return Ok(vec![url.to_string()]);
            }
        }
        if url.scheme() == "https"
            && matches!(url.host_str(), Some("api.novita.ai" | "api.jiekou.ai"))
            && url.path().trim_end_matches('/') == "/anthropic"
            && url.query().is_none()
        {
            url.set_path("/openai/v1/models");
            url.set_fragment(None);
            return Ok(vec![url.to_string()]);
        }
    }

    // baseURL 已以版本段 /v{N} 结尾时（如 `/v1`、智谱 `/api/coding/paas/v4`），
    // OpenAI 惯例的模型端点是 `{base}/models`，不能再补 `/v1`
    // （否则 .../coding/paas/v4/v1/models → 404）。
    if ends_with_version_segment(trimmed) {
        candidates.push(format!("{trimmed}/models"));
        // 版本段非 /v1 时，保留旧的 /v1/models 作为兜底次候选（正确路径已在前）。
        if !trimmed.ends_with("/v1") {
            candidates.push(format!("{trimmed}/v1/models"));
        }
    } else {
        candidates.push(format!("{trimmed}/v1/models"));
    }

    if let Some(stripped) = strip_compat_suffix(trimmed) {
        let root = stripped.trim_end_matches('/');
        if !root.is_empty() && root.contains("://") {
            candidates.push(format!("{root}/v1/models"));
            candidates.push(format!("{root}/models"));
        }
    }

    // 候选最多 3 条，线性去重即可，不值得上 HashSet。
    let mut unique: Vec<String> = Vec::with_capacity(candidates.len());
    for url in candidates {
        if !unique.iter().any(|u| u == &url) {
            unique.push(url);
        }
    }

    Ok(unique)
}

/// Resolve exact, documented model-list paths for gateways that do not use the
/// generic `/v1/models` convention. Host and path checks are intentionally
/// strict so a lookalike host cannot redirect discovery to an attacker URL.
fn known_gateway_models_url(url: &reqwest::Url) -> Option<String> {
    if !is_safe_known_gateway_url(url) {
        return None;
    }

    let host = url.host_str()?;
    let path = url.path().trim_end_matches('/');
    let models_path = if host.eq_ignore_ascii_case("api.kilo.ai") && path == "/api/gateway" {
        "/api/gateway/models"
    } else if host.eq_ignore_ascii_case("api.opper.ai") && path == "/v3/compat" {
        "/v3/compat/models"
    } else if host.eq_ignore_ascii_case("opencode.ai") {
        opencode_models_scope(path).map(|scope| return_gateway_models_path(scope, path))?
    } else if host.eq_ignore_ascii_case("generativelanguage.googleapis.com") {
        match path {
            "" | "/v1beta" => "/v1beta/models",
            "/v1" => "/v1/models",
            _ => return None,
        }
    } else {
        return None;
    };

    let mut models_url = url.clone();
    models_url.set_path(models_path);
    Some(models_url.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpenCodeModelScope {
    Zen,
    ZenGo,
}

fn opencode_models_scope(path: &str) -> Option<OpenCodeModelScope> {
    match path {
        "/zen" | "/zen/v1" => Some(OpenCodeModelScope::Zen),
        "/zen/go" | "/zen/go/v1" => Some(OpenCodeModelScope::ZenGo),
        "/inference"
        | "/inference/v1"
        | "/inference/openai/v1"
        | "/inference/anthropic"
        | "/inference/anthropic/v1" => Some(OpenCodeModelScope::Zen),
        "/inference/go"
        | "/inference/go/v1"
        | "/inference/go/openai/v1"
        | "/inference/go/anthropic"
        | "/inference/go/anthropic/v1" => Some(OpenCodeModelScope::ZenGo),
        _ => None,
    }
}

fn return_gateway_models_path(scope: OpenCodeModelScope, input_path: &str) -> &'static str {
    match (scope, input_path) {
        (OpenCodeModelScope::Zen, "/zen" | "/zen/v1") => "/zen/v1/models",
        (OpenCodeModelScope::ZenGo, "/zen/go" | "/zen/go/v1") => "/zen/go/v1/models",
        (OpenCodeModelScope::Zen, _) => "/inference/v1/models",
        (OpenCodeModelScope::ZenGo, _) => "/inference/go/v1/models",
    }
}

/// 截断响应体到 [`ERROR_BODY_MAX_CHARS`] 字符，避免 HTML 404 页占用错误串。
fn truncate_body(body: String) -> String {
    if body.chars().count() <= ERROR_BODY_MAX_CHARS {
        body
    } else {
        let mut s: String = body.chars().take(ERROR_BODY_MAX_CHARS).collect();
        s.push('…');
        s
    }
}

/// 若 baseURL 以任一已知兼容子路径结尾，返回剥离后的剩余部分；否则 `None`。
///
/// 依赖 [`KNOWN_COMPAT_SUFFIXES`] 按长度降序排列，确保最长前缀优先命中
/// （否则 `/anthropic` 会提前匹配掉 `/api/anthropic` 的场景）。
fn strip_compat_suffix(base_url: &str) -> Option<&str> {
    for suffix in KNOWN_COMPAT_SUFFIXES {
        if base_url.ends_with(*suffix) {
            return Some(&base_url[..base_url.len() - suffix.len()]);
        }
    }
    None
}

/// 判断 baseURL 是否以 OpenAI 风格的版本段 `/v{N}` 结尾（`N` 为一个或多个数字），
/// 例如 `/v1`、`.../paas/v4`。这类 URL 版本号已在路径中，模型端点应为
/// `{base}/models`，不能再补 `/v1`（智谱 Coding Plan 即 `.../coding/paas/v4`）。
fn ends_with_version_segment(url: &str) -> bool {
    let last = url.rsplit('/').next().unwrap_or("");
    last.strip_prefix('v')
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_v3202_anthropic_model_directory_uses_vendor_openai_path() {
        for host in ["api.novita.ai", "api.jiekou.ai"] {
            assert_eq!(
                build_models_url_candidates(&format!("https://{host}/anthropic"), false, None)
                    .unwrap()[0],
                format!("https://{host}/openai/v1/models"),
            );
        }
        assert_eq!(
            build_models_url_candidates(
                "https://api.novita.ai/anthropic",
                false,
                Some("https://custom.test/models")
            )
            .unwrap(),
            vec!["https://custom.test/models"],
        );
        assert_eq!(
            build_models_url_candidates("https://api.novita.ai.evil.test/anthropic", false, None)
                .unwrap()[0],
            "https://api.novita.ai.evil.test/anthropic/v1/models",
        );
    }

    #[test]
    fn known_gateway_model_directories_use_exact_official_paths() {
        for (base, endpoint) in [
            (
                "https://api.kilo.ai/api/gateway",
                "https://api.kilo.ai/api/gateway/models",
            ),
            (
                "https://api.opper.ai/v3/compat",
                "https://api.opper.ai/v3/compat/models",
            ),
        ] {
            for base in [base.to_string(), format!("{base}/")] {
                assert_eq!(
                    build_models_url_candidates(&base, false, None).unwrap(),
                    vec![endpoint],
                );
                assert_eq!(
                    build_models_url_candidates(
                        &base,
                        false,
                        Some("https://custom.test/model-directory"),
                    )
                    .unwrap(),
                    vec!["https://custom.test/model-directory"],
                );
            }
        }
    }

    #[test]
    fn known_gateway_model_directory_rules_do_not_match_spoofed_hosts_or_other_paths() {
        for base in [
            "https://api.kilo.ai.evil.test/api/gateway",
            "https://api.kilo.ai@evil.test/api/gateway",
            "https://api.opper.ai.evil.test/v3/compat",
            "https://api.opper.ai@evil.test/v3/compat",
            "https://custom.test/api/gateway",
            "https://api.kilo.ai/other/api/gateway",
            "https://api.opper.ai/other/v3/compat",
            "http://api.kilo.ai/api/gateway",
            "http://api.opper.ai/v3/compat",
        ] {
            assert_eq!(
                build_models_url_candidates(base, false, None).unwrap(),
                vec![format!("{base}/v1/models")],
            );
        }
    }

    #[test]
    fn metadata_audit_opencode_model_discovery_preserves_legacy_and_modern_provider_scopes() {
        for (scope, bases) in [
            ("/zen", vec!["/zen", "/zen/v1"]),
            ("/zen/go", vec!["/zen/go", "/zen/go/v1"]),
            (
                "/inference",
                vec![
                    "/inference",
                    "/inference/v1",
                    "/inference/openai/v1",
                    "/inference/anthropic",
                    "/inference/anthropic/v1",
                ],
            ),
            (
                "/inference/go",
                vec![
                    "/inference/go",
                    "/inference/go/v1",
                    "/inference/go/openai/v1",
                    "/inference/go/anthropic",
                    "/inference/go/anthropic/v1",
                ],
            ),
        ] {
            for path in bases {
                let base = format!("https://opencode.ai{path}");
                assert_eq!(
                    build_models_url_candidates(&base, false, None).unwrap(),
                    vec![format!("https://opencode.ai{scope}/v1/models")],
                    "{base}",
                );
                assert_eq!(
                    build_models_url_candidates(
                        &base,
                        false,
                        Some("https://custom.test/model-directory"),
                    )
                    .unwrap(),
                    vec!["https://custom.test/model-directory"],
                );
            }
        }
    }

    #[test]
    fn metadata_audit_opencode_model_discovery_does_not_rewrite_untrusted_urls() {
        for base in [
            "https://opencode.ai.evil.test/inference/go/openai/v1",
            "https://opencode.ai@evil.test/inference/go/openai/v1",
            "https://user@opencode.ai/inference/go/openai/v1",
            "https://opencode.ai:8443/inference/go/openai/v1",
            "http://opencode.ai/inference/go/openai/v1",
            "https://opencode.ai/inference/go/openai/v1?scope=other",
            "https://opencode.ai/inference/go/openai/v1#other",
            "https://opencode.ai/other/inference/go/openai/v1",
        ] {
            let candidates = build_models_url_candidates(base, false, None).unwrap();
            assert!(
                !candidates
                    .iter()
                    .any(|candidate| candidate == "https://opencode.ai/inference/go/v1/models"),
                "{base}",
            );
        }
    }

    #[test]
    fn metadata_audit_gemini_native_model_discovery_uses_its_api_version() {
        for (base, endpoint) in [
            (
                "https://generativelanguage.googleapis.com",
                "https://generativelanguage.googleapis.com/v1beta/models",
            ),
            (
                "https://generativelanguage.googleapis.com/v1beta",
                "https://generativelanguage.googleapis.com/v1beta/models",
            ),
            (
                "https://generativelanguage.googleapis.com/v1",
                "https://generativelanguage.googleapis.com/v1/models",
            ),
        ] {
            assert_eq!(
                build_models_url_candidates(base, false, None).unwrap(),
                vec![endpoint],
            );
        }
    }

    #[test]
    fn model_fetch_headers_follow_pi_api_format() {
        let anthropic =
            build_model_fetch_headers("anthropic-key", Some("anthropic-messages"), None, None)
                .unwrap();
        assert_eq!(anthropic["x-api-key"], "anthropic-key");
        assert!(!anthropic.contains_key(AUTHORIZATION));

        let google =
            build_model_fetch_headers("google-key", Some("google-generative-ai"), None, None)
                .unwrap();
        assert_eq!(google["x-goog-api-key"], "google-key");
        assert!(!google.contains_key(AUTHORIZATION));

        let openai =
            build_model_fetch_headers("openai-key", Some("openai-responses"), None, None).unwrap();
        assert_eq!(openai[AUTHORIZATION], "Bearer openai-key");
    }

    #[test]
    fn model_fetch_headers_allow_validated_header_only_auth_and_overrides() {
        let custom = BTreeMap::from([
            ("Authorization".to_string(), "Token literal".to_string()),
            ("X-Tenant".to_string(), "tenant-a".to_string()),
        ]);
        let headers =
            build_model_fetch_headers("", Some("openai-completions"), None, Some(&custom)).unwrap();
        assert_eq!(headers[AUTHORIZATION], "Token literal");
        assert_eq!(headers["x-tenant"], "tenant-a");

        let override_default =
            BTreeMap::from([("x-api-key".to_string(), "header-managed-key".to_string())]);
        let headers = build_model_fetch_headers(
            "provider-key",
            Some("anthropic-messages"),
            None,
            Some(&override_default),
        )
        .unwrap();
        assert_eq!(headers["x-api-key"], "header-managed-key");
    }

    #[test]
    fn model_fetch_headers_reject_invalid_or_missing_credentials() {
        assert!(build_model_fetch_headers("", None, None, None).is_err());
        let invalid = BTreeMap::from([("bad header".to_string(), "literal-value".to_string())]);
        assert!(build_model_fetch_headers("", None, None, Some(&invalid)).is_err());
    }

    #[test]
    fn model_fetch_error_body_redacts_known_header_credentials() {
        let secrets = vec![
            "short".to_string(),
            "Bearer literal-header-secret".to_string(),
        ];
        let body = redact_model_fetch_error_body(
            "invalid short / Bearer literal-header-secret".to_string(),
            &secrets,
        );
        assert_eq!(body, "invalid [REDACTED] / [REDACTED]");
    }

    #[test]
    fn test_candidates_plain_root() {
        let c = build_models_url_candidates("https://api.siliconflow.cn", false, None).unwrap();
        assert_eq!(c, vec!["https://api.siliconflow.cn/v1/models"]);
    }

    #[test]
    fn test_candidates_trailing_slash() {
        let c = build_models_url_candidates("https://api.example.com/", false, None).unwrap();
        assert_eq!(c, vec!["https://api.example.com/v1/models"]);
    }

    #[test]
    fn test_candidates_with_v1() {
        let c = build_models_url_candidates("https://api.example.com/v1", false, None).unwrap();
        assert_eq!(c, vec!["https://api.example.com/v1/models"]);
    }

    #[test]
    fn test_candidates_zhipu_coding_paas_v4() {
        // 智谱 Coding Plan 端点以 /v4 版本段结尾：模型端点是 {base}/models，
        // 正确路径必须排在 .../v4/v1/models（404）之前。
        let c =
            build_models_url_candidates("https://open.bigmodel.cn/api/coding/paas/v4", false, None)
                .unwrap();
        assert_eq!(
            c,
            vec![
                "https://open.bigmodel.cn/api/coding/paas/v4/models",
                "https://open.bigmodel.cn/api/coding/paas/v4/v1/models",
            ]
        );
    }

    #[test]
    fn test_candidates_zai_coding_paas_v4() {
        let c = build_models_url_candidates("https://api.z.ai/api/coding/paas/v4", false, None)
            .unwrap();
        assert_eq!(
            c,
            vec![
                "https://api.z.ai/api/coding/paas/v4/models",
                "https://api.z.ai/api/coding/paas/v4/v1/models",
            ]
        );
    }

    #[test]
    fn test_candidates_zhipu_native_responses_strip_api_v1_for_model_discovery() {
        let candidates =
            build_models_url_candidates("https://open.bigmodel.cn/api/v1", false, None).unwrap();
        assert_eq!(
            candidates,
            vec![
                "https://open.bigmodel.cn/api/v1/models",
                "https://open.bigmodel.cn/v1/models",
                "https://open.bigmodel.cn/models",
            ]
        );
    }

    #[test]
    fn test_ends_with_version_segment() {
        assert!(ends_with_version_segment("https://x.com/v1"));
        assert!(ends_with_version_segment(
            "https://open.bigmodel.cn/api/coding/paas/v4"
        ));
        assert!(ends_with_version_segment("https://x.com/v10"));
        assert!(!ends_with_version_segment("https://x.com/api"));
        assert!(!ends_with_version_segment("https://x.com/vX"));
        assert!(!ends_with_version_segment("https://x.com/models"));
        assert!(!ends_with_version_segment("https://api.siliconflow.cn"));
    }

    #[test]
    fn test_candidates_full_url() {
        let c = build_models_url_candidates(
            "https://proxy.example.com/v1/chat/completions",
            true,
            None,
        )
        .unwrap();
        assert_eq!(c, vec!["https://proxy.example.com/v1/models"]);
    }

    #[test]
    fn test_candidates_empty() {
        assert!(build_models_url_candidates("", false, None).is_err());
    }

    #[test]
    fn test_candidates_override_returns_single() {
        let c = build_models_url_candidates(
            "https://api.deepseek.com/anthropic",
            false,
            Some("https://api.deepseek.com/models"),
        )
        .unwrap();
        assert_eq!(c, vec!["https://api.deepseek.com/models"]);
    }

    #[test]
    fn test_candidates_override_empty_falls_through() {
        let c =
            build_models_url_candidates("https://api.siliconflow.cn", false, Some("   ")).unwrap();
        assert_eq!(c, vec!["https://api.siliconflow.cn/v1/models"]);
    }

    #[test]
    fn test_candidates_deepseek_strip_anthropic() {
        let c =
            build_models_url_candidates("https://api.deepseek.com/anthropic", false, None).unwrap();
        assert_eq!(
            c,
            vec![
                "https://api.deepseek.com/anthropic/v1/models",
                "https://api.deepseek.com/v1/models",
                "https://api.deepseek.com/models",
            ]
        );
    }

    #[test]
    fn test_candidates_zhipu_strip_api_anthropic() {
        let c = build_models_url_candidates("https://open.bigmodel.cn/api/anthropic", false, None)
            .unwrap();
        assert_eq!(
            c,
            vec![
                "https://open.bigmodel.cn/api/anthropic/v1/models",
                "https://open.bigmodel.cn/v1/models",
                "https://open.bigmodel.cn/models",
            ]
        );
    }

    #[test]
    fn test_candidates_bailian_strip_apps_anthropic() {
        let c = build_models_url_candidates(
            "https://dashscope.aliyuncs.com/apps/anthropic",
            false,
            None,
        )
        .unwrap();
        assert_eq!(
            c,
            vec![
                "https://dashscope.aliyuncs.com/apps/anthropic/v1/models",
                "https://dashscope.aliyuncs.com/v1/models",
                "https://dashscope.aliyuncs.com/models",
            ]
        );
    }

    #[test]
    fn test_candidates_stepfun_strip_step_plan() {
        let c =
            build_models_url_candidates("https://api.stepfun.com/step_plan", false, None).unwrap();
        assert_eq!(
            c,
            vec![
                "https://api.stepfun.com/step_plan/v1/models",
                "https://api.stepfun.com/v1/models",
                "https://api.stepfun.com/models",
            ]
        );
    }

    #[test]
    fn test_candidates_doubao_strip_api_coding() {
        let c = build_models_url_candidates(
            "https://ark.cn-beijing.volces.com/api/coding",
            false,
            None,
        )
        .unwrap();
        assert_eq!(
            c,
            vec![
                "https://ark.cn-beijing.volces.com/api/coding/v1/models",
                "https://ark.cn-beijing.volces.com/v1/models",
                "https://ark.cn-beijing.volces.com/models",
            ]
        );
    }

    #[test]
    fn test_candidates_rightcode_strip_claude() {
        let c = build_models_url_candidates("https://www.right.codes/claude", false, None).unwrap();
        assert_eq!(
            c,
            vec![
                "https://www.right.codes/claude/v1/models",
                "https://www.right.codes/v1/models",
                "https://www.right.codes/models",
            ]
        );
    }

    #[test]
    fn test_candidates_longer_suffix_wins() {
        // baseURL 以 /api/anthropic 结尾时，应剥离整个 /api/anthropic，
        // 而不是只剥离 /anthropic（那样会得到残缺的 https://.../api 根）。
        let c = build_models_url_candidates("https://api.z.ai/api/anthropic", false, None).unwrap();
        assert_eq!(
            c,
            vec![
                "https://api.z.ai/api/anthropic/v1/models",
                "https://api.z.ai/v1/models",
                "https://api.z.ai/models",
            ]
        );
    }

    #[test]
    fn test_candidates_no_suffix_no_strip() {
        let c = build_models_url_candidates("https://openrouter.ai/api", false, None).unwrap();
        assert_eq!(c, vec!["https://openrouter.ai/api/v1/models"]);
    }

    #[test]
    fn test_candidates_deduplicate() {
        // 虚构 case：baseURL 就是 "scheme://host"，剥不出子路径，应只有一个候选。
        let c = build_models_url_candidates("https://host.example.com", false, None).unwrap();
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn test_parse_response() {
        let json = r#"{"object":"list","data":[{"id":"gpt-4","object":"model","owned_by":"openai"},{"id":"claude-3-sonnet","object":"model","owned_by":"anthropic"}]}"#;
        let resp: ModelsResponse = serde_json::from_str(json).unwrap();
        let data = resp.data.unwrap();
        assert_eq!(data.len(), 2);
        assert_eq!(data[0].id, "gpt-4");
        assert_eq!(data[0].owned_by.as_deref(), Some("openai"));
        assert_eq!(data[1].id, "claude-3-sonnet");
    }

    #[test]
    fn test_parse_response_no_owned_by() {
        let json = r#"{"object":"list","data":[{"id":"my-model","object":"model"}]}"#;
        let resp: ModelsResponse = serde_json::from_str(json).unwrap();
        let data = resp.data.unwrap();
        assert_eq!(data[0].id, "my-model");
        assert!(data[0].owned_by.is_none());
    }

    #[test]
    fn parse_models_response_rejects_and_redacts_http_200_error_envelopes() {
        let secret = "sk-test-secret-1234567890";
        let body =
            format!(r#"{{"code":1001,"msg":"Invalid Authorization: {secret}","success":false}}"#);

        let error = parse_models_response(&body, &[secret.to_string()])
            .expect_err("a 2xx provider error envelope is not an empty model list");

        assert!(error.contains("Invalid Authorization"));
        assert!(!error.contains(secret));
    }

    #[test]
    fn parse_models_response_keeps_model_metadata_on_the_success_path() {
        let models = parse_models_response(
            r#"{"object":"list","data":[{"id":"glm-5.2","owned_by":"zhipu","context_window":200000,"input_modalities":["text"]}]}"#,
            &[],
        )
        .expect("parse a valid OpenAI-compatible model list");

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "glm-5.2");
        assert_eq!(models[0].owned_by.as_deref(), Some("zhipu"));
        assert_eq!(models[0].context_window, Some(200_000));
        assert_eq!(models[0].input_modalities, Some(vec!["text".to_string()]));
    }

    #[test]
    fn metadata_audit_openrouter_architecture_preserves_modalities_and_explicit_empty_inputs() {
        let models = parse_provider_models_response(
            &serde_json::json!({
                "data": [
                    {
                        "id": "provider/vision",
                        "architecture": {
                            "input_modalities": ["text", "image", "audio"],
                            "output_modalities": ["text"]
                        }
                    },
                    {
                        "id": "provider/text",
                        "architecture": {"input_modalities": ["text"]}
                    },
                    {
                        "id": "provider/empty",
                        "input_modalities": [],
                        "architecture": {"input_modalities": ["text", "image"]}
                    },
                    {
                        "id": "provider/explicit-false",
                        "supportsImage": false,
                        "architecture": {"input_modalities": ["text", "image"]}
                    },
                    {
                        "id": "provider/malformed",
                        "architecture": {"input_modalities": ["text", 7]}
                    }
                ]
            })
            .to_string(),
            &[],
            "https://openrouter.ai/api/v1",
            "https://openrouter.ai/api/v1/models",
        )
        .expect("parse actual OpenRouter modality shape");

        assert_eq!(
            models[0].input_modalities,
            Some(vec!["text".into(), "image".into(), "audio".into()])
        );
        assert_eq!(models[0].supports_image, Some(true));
        assert_eq!(models[1].input_modalities, Some(vec!["text".into()]));
        assert_eq!(models[1].supports_image, Some(false));
        assert_eq!(models[2].input_modalities, Some(Vec::new()));
        assert_eq!(models[2].supports_image, Some(false));
        assert_eq!(models[3].supports_image, Some(false));
        assert!(models[4].input_modalities.is_none());
        assert!(models[4].supports_image.is_none());
    }

    #[test]
    fn metadata_audit_data_architecture_blocks_rich_descriptor_input_revival() {
        let models = parse_models_response(
            &serde_json::json!({
                "data": [{
                    "id": "model",
                    "architecture": {"input_modalities": []},
                    "supportsImage": false
                }],
                "models": [{
                    "id": "model",
                    "input_modalities": ["text", "image"],
                    "supportsImage": true
                }]
            })
            .to_string(),
            &[],
        )
        .expect("data remains authoritative across modality envelopes");

        assert_eq!(models[0].input_modalities, Some(Vec::new()));
        assert_eq!(models[0].supports_image, Some(false));
    }

    #[test]
    fn metadata_audit_openrouter_parallel_parameter_is_scoped_and_never_overrides_false() {
        for (base, endpoint, expected) in [
            (
                "https://openrouter.ai/api/v1",
                "https://openrouter.ai/api/v1/models",
                Some(true),
            ),
            (
                "https://openrouter.ai/api",
                "https://openrouter.ai/api/v1/models",
                Some(true),
            ),
            (
                "https://provider.test/v1",
                "https://provider.test/v1/models",
                None,
            ),
            (
                "https://openrouter.ai.evil.test/api/v1",
                "https://openrouter.ai.evil.test/api/v1/models",
                None,
            ),
            (
                "https://openrouter.ai/api/v1",
                "https://external.test/models",
                None,
            ),
        ] {
            let models = parse_provider_models_response(
                &serde_json::json!({
                    "data": [
                        {"id": "declared", "supported_parameters": ["tools", "parallel_tool_calls"]},
                        {"id": "false", "supportsParallelToolCalls": false, "supported_parameters": ["parallel_tool_calls"]},
                        {"id": "absent", "supported_parameters": ["tools"]},
                        {"id": "empty", "supported_parameters": []},
                        {"id": "malformed", "supported_parameters": ["parallel_tool_calls", 7]},
                        {"id": "conflicting", "supported_parameters": ["parallel_tool_calls"], "supportedParameters": []}
                    ]
                })
                .to_string(),
                &[],
                base,
                endpoint,
            )
            .expect("parse scoped parallel tool declaration");

            assert_eq!(models[0].supports_parallel_tool_calls, expected, "{base}");
            assert_eq!(models[1].supports_parallel_tool_calls, Some(false));
            for model in &models[2..] {
                assert!(model.supports_parallel_tool_calls.is_none(), "{}", model.id);
            }
        }
    }

    #[test]
    fn metadata_audit_gemini_native_resource_names_are_allowlisted_and_partial_lists_rejected() {
        let body = serde_json::json!({
            "models": [{
                "name": "models/gemini-2.5-pro",
                "displayName": "Gemini 2.5 Pro",
                "inputTokenLimit": 1_048_576,
                "outputTokenLimit": 65_536,
                "supportedGenerationMethods": ["generateContent", "countTokens"],
                "temperature": 1,
                "internalServerPath": "[REDACTED]",
                "instructions": "untrusted provider instruction"
            }]
        });
        let models = parse_provider_models_response(
            &body.to_string(),
            &[],
            "https://generativelanguage.googleapis.com/v1beta",
            "https://generativelanguage.googleapis.com/v1beta/models",
        )
        .expect("native Gemini uses a resource name as its requestable model identity");
        assert_eq!(models[0].id, "models/gemini-2.5-pro");
        assert_eq!(models[0].display_name.as_deref(), Some("Gemini 2.5 Pro"));
        assert_eq!(models[0].context_window, Some(1_048_576));
        assert!(models[0].reasoning.is_none());
        assert!(models[0].protocol_capability.is_none());
        let serialized = serde_json::to_string(&models[0]).unwrap();
        assert!(!serialized.contains("[REDACTED]"));
        assert!(!serialized.contains("untrusted provider instruction"));

        let mut partial = body.clone();
        partial["nextPageToken"] = serde_json::json!("next-page");
        assert!(parse_provider_models_response(
            &partial.to_string(),
            &[],
            "https://generativelanguage.googleapis.com/v1beta",
            "https://generativelanguage.googleapis.com/v1beta/models",
        )
        .is_err());

        for (base, endpoint) in [
            (
                "https://provider.test/v1",
                "https://provider.test/v1/models",
            ),
            (
                "https://generativelanguage.googleapis.com.evil.test/v1beta",
                "https://generativelanguage.googleapis.com.evil.test/v1beta/models",
            ),
            (
                "https://generativelanguage.googleapis.com/v1beta",
                "https://external.test/models",
            ),
        ] {
            assert!(
                parse_provider_models_response(&body.to_string(), &[], base, endpoint).is_err(),
                "{base} / {endpoint}",
            );
        }
    }

    #[test]
    fn parse_models_response_preserves_safe_identity_metadata_and_explicit_parallel_false() {
        let models = parse_models_response(
            r#"{"data":[
                {
                    "id":"wire-model",
                    "display_name":" Provider Model ",
                    "canonical_slug":" catalog-family ",
                    "slug":" catalog-slug ",
                    "name":" upstream-name ",
                    "aliases":[" old-model ","old-model",null,""],
                    "supports_parallel_tool_calls":false,
                    "upstreamModel":"untrusted-wire-override",
                    "baseInstructions":"[REDACTED]",
                    "apiKey":"[REDACTED]"
                },
                {
                    "id":"nested-model",
                    "metadata":{
                        "displayName":" Nested Model ",
                        "canonicalSlug":" nested-family ",
                        "aliases":{" old-nested ":" nested-model ","invalid":null},
                        "supportsParallelToolCalls":true
                    }
                }
            ]}"#,
            &[],
        )
        .expect("safe identity metadata");
        let first = serde_json::to_value(&models[0]).unwrap();
        assert_eq!(first["id"], "wire-model");
        assert_eq!(first["displayName"], "Provider Model");
        assert_eq!(first["canonicalSlug"], "catalog-family");
        assert_eq!(first["slug"], "catalog-slug");
        assert_eq!(first["name"], "upstream-name");
        assert_eq!(first["aliases"], serde_json::json!(["old-model"]));
        assert_eq!(first["supportsParallelToolCalls"], false);
        assert!(first.get("upstreamModel").is_none());
        assert!(first.get("baseInstructions").is_none());
        assert!(first.get("apiKey").is_none());
        assert!(!first.to_string().contains("[REDACTED]"));

        let second = serde_json::to_value(&models[1]).unwrap();
        assert_eq!(second["displayName"], "Nested Model");
        assert_eq!(second["canonicalSlug"], "nested-family");
        assert_eq!(
            second["aliases"],
            serde_json::json!({"old-nested":"nested-model"})
        );
        assert_eq!(second["supportsParallelToolCalls"], true);
    }

    #[test]
    fn parse_models_response_enriches_data_inventory_from_matching_rich_models() {
        let models = parse_models_response(
            r#"{
                "data":[{"id":"wire-model","owned_by":"provider"},{"id":"other-model"}],
                "models":[
                    {
                        "slug":"wire-model",
                        "display_name":"Provider Model",
                        "canonical_slug":"catalog-family",
                        "aliases":["previous-model"],
                        "context_window":262144,
                        "input_modalities":["text","image"],
                        "supports_parallel_tool_calls":false
                    },
                    {"id":"not-in-data","context_window":1000000}
                ]
            }"#,
            &[],
        )
        .expect("data inventory with matching rich descriptors");

        assert_eq!(models.len(), 2);
        let first = serde_json::to_value(&models[0]).unwrap();
        assert_eq!(first["id"], "wire-model");
        assert_eq!(first["ownedBy"], "provider");
        assert_eq!(first["displayName"], "Provider Model");
        assert_eq!(first["contextWindow"], 262144);
        assert_eq!(
            first["inputModalities"],
            serde_json::json!(["text", "image"])
        );
        assert_eq!(first["supportsImage"], true);
        assert_eq!(first["supportsParallelToolCalls"], false);
        assert!(models.iter().all(|model| model.id != "not-in-data"));
    }

    #[test]
    fn parse_models_response_matches_rich_identity_metadata_case_insensitively() {
        let models = parse_models_response(
            r#"{
                "data":[
                    {"id":"WIRE-MODEL"},
                    {"id":"name-model"},
                    {"id":"alias-model"}
                ],
                "models":[
                    {
                        "id":"descriptor-canonical",
                        "canonicalSlug":"wire-model",
                        "context_window":128000
                    },
                    {
                        "id":"descriptor-name",
                        "name":"Name-Model",
                        "context_window":256000
                    },
                    {
                        "id":"descriptor-alias",
                        "aliases":["Alias-Model"],
                        "context_window":512000
                    }
                ]
            }"#,
            &[],
        )
        .expect("rich identity metadata should bind to data rows");

        assert_eq!(models[0].context_window, Some(128_000));
        assert_eq!(models[1].context_window, Some(256_000));
        assert_eq!(models[2].context_window, Some(512_000));
    }

    #[test]
    fn parse_models_response_matches_nested_identity_aliases() {
        let models = parse_models_response(
            r#"{
                "data":[{"id":"nested-alias"}],
                "models":[{
                    "id":"wire-model",
                    "capabilities":{
                        "aliases":["Nested-Alias"],
                        "limits":{"contextWindow":777000}
                    }
                }]
            }"#,
            &[],
        )
        .expect("nested identity metadata should bind to data rows");

        assert_eq!(models[0].context_window, Some(777_000));
    }

    #[test]
    fn parse_models_response_rejects_empty_or_ambiguous_dual_envelopes() {
        for body in [
            r#"{"data":[],"models":[{"slug":"wire-model"}]}"#,
            r#"{
                "data":[{"id":"wire-model"}],
                "models":[
                    {"id":"descriptor-a","slug":"wire-model","context_window":128000},
                    {"id":"descriptor-b","slug":"wire-model","context_window":256000}
                ]
            }"#,
        ] {
            assert!(
                parse_models_response(body, &[]).is_err(),
                "contradictory descriptor inventories must not replace a usable catalog"
            );
        }
    }

    #[test]
    fn parse_models_response_keeps_explicit_data_fields_when_enriching_rich_models() {
        let models = parse_models_response(
            r#"{
                "data":[{
                    "id":"wire-model",
                    "context_window":64000,
                    "supports_image":false,
                    "supports_parallel_tool_calls":false
                }],
                "models":[{
                    "id":"descriptor-id",
                    "slug":"wire-model",
                    "display_name":"Provider Model",
                    "context_window":128000,
                    "supports_image":true,
                    "supports_parallel_tool_calls":true
                }]
            }"#,
            &[],
        )
        .expect("rich descriptor fills missing data metadata");

        assert_eq!(models[0].id, "wire-model");
        assert_eq!(models[0].context_window, Some(64000));
        assert_eq!(models[0].supports_image, Some(false));
        assert_eq!(models[0].supports_parallel_tool_calls, Some(false));
        assert_eq!(models[0].display_name.as_deref(), Some("Provider Model"));
    }

    #[test]
    fn parse_models_response_keeps_data_authority_across_semantic_aliases() {
        for (data, descriptor) in [
            (
                serde_json::json!({
                    "id": "wire-model",
                    "contextWindow": 64000,
                    "supports_parallel_tool_calls": false,
                    "displayName": "Data Model",
                    "canonicalSlug": "data-family",
                    "aliases": ["data-alias"],
                    "supportsImage": false
                }),
                serde_json::json!({
                    "id": "wire-model",
                    "context_window": 128000,
                    "supportsParallelToolCalls": true,
                    "display_name": "Descriptor Model",
                    "canonical_slug": "descriptor-family",
                    "alias": ["descriptor-alias"],
                    "input_modalities": ["text", "image"]
                }),
            ),
            (
                serde_json::json!({
                    "id": "wire-model",
                    "metadata": {
                        "contextWindow": 64000,
                        "supports_parallel_tool_calls": false,
                        "displayName": "Data Model",
                        "canonicalSlug": "data-family",
                        "aliases": ["data-alias"],
                        "supportsImage": false
                    }
                }),
                serde_json::json!({
                    "id": "wire-model",
                    "context_window": 128000,
                    "supportsParallelToolCalls": true,
                    "display_name": "Descriptor Model",
                    "canonical_slug": "descriptor-family",
                    "alias": ["descriptor-alias"],
                    "input_modalities": ["text", "image"]
                }),
            ),
        ] {
            let body = serde_json::json!({"data": [data], "models": [descriptor]});
            let models = parse_models_response(&body.to_string(), &[])
                .expect("data aliases remain authoritative");
            assert_eq!(models[0].context_window, Some(64000));
            assert_eq!(models[0].supports_parallel_tool_calls, Some(false));
            assert_eq!(models[0].display_name.as_deref(), Some("Data Model"));
            assert_eq!(models[0].canonical_slug.as_deref(), Some("data-family"));
            assert_eq!(models[0].aliases, Some(serde_json::json!(["data-alias"])));
            assert_eq!(models[0].supports_image, Some(false));
            assert!(models[0]
                .input_modalities
                .as_ref()
                .is_none_or(|modalities| !modalities.iter().any(|value| value == "image")));
        }
    }

    #[test]
    fn parse_models_response_keeps_data_reasoning_and_protocol_aliases_authoritative() {
        let body = serde_json::json!({
            "data": [{
                "id": "wire-model",
                "supportedReasoningEfforts": [{"reasoningEffort": "max"}],
                "defaultReasoningEffort": "max",
                "supportedEndpoints": ["responses"],
                "supports_tools": false,
                "supports_streaming": false
            }],
            "models": [{
                "id": "wire-model",
                "supported_reasoning_levels": ["low", "medium", "high", "xhigh"],
                "default_reasoning_level": "high",
                "endpoints": ["chat/completions"],
                "supportsTools": true,
                "supportsStreaming": true
            }]
        });
        let models = parse_provider_models_response(
            &body.to_string(),
            &[],
            "https://provider.test/v1",
            "https://provider.test/v1/models",
        )
        .expect("data reasoning and protocol aliases remain authoritative");

        let reasoning = models[0]
            .reasoning
            .as_ref()
            .expect("data reasoning metadata");
        assert_eq!(reasoning["supportedEfforts"], serde_json::json!(["max"]));
        assert_eq!(reasoning["defaultEffort"], "max");
        let protocol = models[0]
            .protocol_capability
            .as_ref()
            .expect("data protocol metadata");
        assert_eq!(
            protocol["supportedEndpoints"],
            serde_json::json!(["openai_responses"])
        );
        assert_eq!(protocol["supportsTools"], false);
        assert_eq!(protocol["supportsStreaming"], false);
    }

    #[test]
    fn parse_models_response_joins_both_data_and_rich_explicit_identity_metadata() {
        for identity in [
            serde_json::json!({"slug": "descriptor-model"}),
            serde_json::json!({"canonicalSlug": "descriptor-model"}),
            serde_json::json!({"aliases": ["descriptor-model"]}),
        ] {
            let mut data = identity;
            data["id"] = serde_json::json!("wire-model");
            let body = serde_json::json!({
                "data": [data],
                "models": [{
                    "id": "DESCRIPTOR-MODEL",
                    "context_window": 128000
                }]
            });
            let models = parse_models_response(&body.to_string(), &[])
                .expect("explicit data identity binds matching descriptor metadata");
            assert_eq!(models[0].id, "wire-model");
            assert_eq!(models[0].context_window, Some(128000));
        }
    }

    #[test]
    fn parse_models_response_keeps_model_and_model_id_rich_binding_identities() {
        for field in ["model", "model_id", "modelId"] {
            let mut descriptor = serde_json::json!({
                "id": "descriptor-model",
                "context_window": 128000
            });
            descriptor[field] = serde_json::json!("wire-model");
            let body = serde_json::json!({
                "data": [{"id": "wire-model"}],
                "models": [descriptor]
            });
            let models = parse_models_response(&body.to_string(), &[])
                .expect("rich request-model identities remain available for metadata matching");
            assert_eq!(models[0].id, "wire-model");
            assert_eq!(models[0].context_window, Some(128000), "{field}");
        }
    }

    #[test]
    fn parse_models_response_accepts_explicitly_complete_pagination_markers() {
        let models = parse_models_response(
            r#"{
                "data":[{"id":"wire-model"}],
                "has_more":false,
                "next_cursor":null,
                "total":1,
                "pagination":{"page":1,"total_pages":1},
                "links":{"next":null}
            }"#,
            &[],
        )
        .expect("complete model inventory");
        assert_eq!(models.len(), 1);
    }

    #[test]
    fn parse_models_response_accepts_slug_models_and_valid_empty_inventory() {
        let models = parse_models_response(
            r#"{"models":[{"slug":"wire-model","display_name":"Provider Model"}]}"#,
            &[],
        )
        .expect("slug-shaped rich model descriptors");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "wire-model");
        assert_eq!(models[0].display_name.as_deref(), Some("Provider Model"));
        assert!(parse_models_response(r#"{"data":[]}"#, &[])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn parse_models_response_accepts_canonical_slug_only_descriptors() {
        let models = parse_models_response(
            r#"{"models":[{"canonical_slug":"catalog-only","display_name":"Catalog Only"}]}"#,
            &[],
        )
        .expect("canonical slug is a usable rich model identity");

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "catalog-only");
        assert_eq!(models[0].display_name.as_deref(), Some("Catalog Only"));
    }

    #[test]
    fn parse_models_response_rejects_duplicate_data_identifiers() {
        let error =
            parse_models_response(r#"{"data":[{"id":"wire-model"},{"id":"WIRE-MODEL"}]}"#, &[])
                .expect_err("duplicate model identifiers must not create ambiguous routes");

        assert!(error.contains("duplicate model identifiers"));
    }

    #[test]
    fn parse_models_response_handles_models_map_with_key_fallback() {
        let models = parse_models_response(
            r#"{"models":{"wire-model":{"display_name":"Provider Model"}}}"#,
            &[],
        )
        .expect("models map with key fallback");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "wire-model");
        assert_eq!(models[0].display_name.as_deref(), Some("Provider Model"));
    }

    #[test]
    fn parse_models_response_rejects_explicit_failure_even_with_inventory() {
        let secret = "sk-model-list-secret";
        for body in [
            r#"{"success":false,"data":[],"msg":"invalid key sk-model-list-secret"}"#,
            r#"{"error":{"message":"invalid key sk-model-list-secret"},"data":[{"id":"model"}]}"#,
        ] {
            let error = parse_models_response(body, &[secret.to_string()])
                .expect_err("a failure envelope is not authoritative model inventory");
            assert!(!error.contains(secret));
        }
    }

    #[test]
    fn parse_models_response_rejects_explicitly_incomplete_inventory() {
        for marker in [
            serde_json::json!({"has_more": true}),
            serde_json::json!({"hasMore": true}),
            serde_json::json!({"next_cursor": "opaque-cursor"}),
            serde_json::json!({"nextPageToken": "opaque-cursor"}),
            serde_json::json!({"total": 2}),
            serde_json::json!({"pagination": {"total": 2}}),
            serde_json::json!({"pagination": {"page": 1, "total_pages": 2}}),
            serde_json::json!({"links": {"next": "https://provider.test/models?page=2"}}),
        ] {
            let mut body = marker;
            body["data"] = serde_json::json!([{"id": "model"}]);
            let error = parse_models_response(&body.to_string(), &[])
                .expect_err("partial inventory must not disable omitted models");
            assert!(error.contains("incomplete"), "{body}");
            assert!(!error.contains("opaque-cursor"));
        }
    }

    #[test]
    fn parse_models_response_rejects_corrupt_inventory_instead_of_dropping_rows() {
        for body in [
            r#"{"data":[{"id":""}]}"#,
            r#"{"data":[{"id":"  "}]}"#,
            r#"{"models":[{"name":"label-with-no-request-id"}]}"#,
            r#"{"models":[{"id":"kept"},{"display_name":"corrupt"}]}"#,
        ] {
            assert!(
                parse_models_response(body, &[]).is_err(),
                "malformed rows must not be mistaken for complete inventory: {body}"
            );
        }
    }

    #[test]
    fn parse_models_response_accepts_opper_public_catalog_shape() {
        let models = parse_models_response(
            r#"{"models":[
                {
                    "id":"alibaba:global/deepseek-v4-flash-0731",
                    "model_id":"deepseek-v4-flash-0731",
                    "model":"deepseek-v4-flash-0731",
                    "context_window":1048576,
                    "cost":0.42,
                    "provider":{"slug":"alibaba","display_name":"Alibaba"}
                },
                {
                    "id":"vendor/free-model",
                    "cost":0
                }
            ]}"#,
            &[],
        )
        .expect("parse Opper's public model catalog");

        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "alibaba:global/deepseek-v4-flash-0731");
        assert_eq!(models[0].owned_by.as_deref(), Some("alibaba"));
        assert_eq!(models[0].context_window, Some(1_048_576));
        assert_eq!(models[0].is_free, Some(false));
        assert_eq!(models[1].id, "vendor/free-model");
        assert_eq!(models[1].is_free, Some(true));
    }

    #[test]
    fn parse_models_response_classifies_free_models_conservatively() {
        use serde_json::json;

        let cases = [
            (json!({"id": "unknown"}), None),
            (json!({"id": "vendor/model:free"}), Some(true)),
            (
                json!({"id": "vendor/free-model", "name": "Free model"}),
                None,
            ),
            (json!({"id": "vendor/model", "access": "open"}), None),
            (json!({"id": "kilo-auto/free", "isFree": true}), Some(true)),
            (
                json!({"id": "vendor/model:free", "isFree": false}),
                Some(false),
            ),
            (json!({"id": "vendor/model:free", "isFree": null}), None),
            (json!({"id": "vendor/model:free", "isFree": "true"}), None),
            (json!({"id": "model", "cost": 0}), Some(true)),
            (json!({"id": "model", "cost": 0.42}), Some(false)),
            (json!({"id": "vendor/model:free", "pricing": null}), None),
            (json!({"id": "vendor/model:free", "pricing": []}), None),
            (
                json!({"id": "model", "pricing": {"prompt": 0, "completion": 0}}),
                Some(true),
            ),
            (
                json!({"id": "model", "pricing": {"prompt": " 0.000 ", "completion": "0e-30", "discount": 25}}),
                Some(true),
            ),
            (json!({"id": "model", "pricing": {"prompt": 0}}), None),
            (
                json!({"id": "model", "pricing": {"prompt": 0, "completion": null}}),
                None,
            ),
            (
                json!({"id": "vendor/model:free", "pricing": {"prompt": -1, "completion": 0}}),
                None,
            ),
            (
                json!({"id": "model", "pricing": {"prompt": "free", "completion": 0}}),
                None,
            ),
            (
                json!({"id": "model", "pricing": {"prompt": "", "completion": 0}}),
                None,
            ),
            (
                json!({"id": "model", "pricing": {"prompt": false, "completion": 0}}),
                None,
            ),
            (
                json!({"id": "model", "pricing": {"prompt": "NaN", "completion": 0}}),
                None,
            ),
            (
                json!({"id": "model", "pricing": {"prompt": "Infinity", "completion": 0}}),
                None,
            ),
            (
                json!({"id": "vendor/model:free", "pricing": {"prompt": "0.000001", "completion": 0}}),
                Some(false),
            ),
            (
                json!({"id": "model", "pricing": {"prompt": "1e-999", "completion": 0}}),
                Some(false),
            ),
            (
                json!({"id": "model", "isFree": true, "pricing": {"prompt": 0, "completion": 0, "request": "0.01"}}),
                Some(false),
            ),
            (
                json!({"id": "model", "isFree": true, "pricing": {"prompt": 0, "completion": null}}),
                None,
            ),
            (
                json!({"id": "model", "isFree": false, "pricing": null}),
                Some(false),
            ),
            (
                json!({"id": "vendor/model:free", "pricing": {"prompt": 0, "completion": 0, "image": null}}),
                None,
            ),
        ];

        for (entry, expected) in cases {
            let body = json!({"data": [entry.clone()]}).to_string();
            let models = parse_models_response(&body, &[]).expect("parse model pricing metadata");
            let model = serde_json::to_value(&models[0]).expect("serialize fetched model");
            assert_eq!(
                model.get("isFree").and_then(serde_json::Value::as_bool),
                expected,
                "{entry}",
            );
            if expected.is_none() {
                assert!(model.get("isFree").is_none(), "{entry}");
            }
        }
    }

    #[test]
    fn parse_models_response_does_not_call_usage_charges_free() {
        use serde_json::json;

        for field in [
            "prompt",
            "completion",
            "request",
            "image",
            "web_search",
            "internal_reasoning",
            "input_cache_read",
            "input_cache_write",
            "input_audio",
            "output_audio",
        ] {
            let mut pricing = json!({"prompt": 0, "completion": 0});
            pricing[field] = json!("0.000001");
            let body = json!({"data": [{
                "id": "vendor/model:free",
                "isFree": true,
                "pricing": pricing,
            }]})
            .to_string();
            let models = parse_models_response(&body, &[]).expect("parse usage charges");
            let model = serde_json::to_value(&models[0]).expect("serialize fetched model");
            assert_eq!(model["isFree"], json!(false), "{field}");
        }
    }

    #[test]
    fn metadata_audit_openrouter_additional_usage_charges_are_not_free() {
        for field in [
            "audio_output",
            "image_output",
            "image_token",
            "input_audio_cache",
            "input_cache_write_1h",
        ] {
            for (amount, expected) in [
                (serde_json::json!("0.000001"), Some(false)),
                (serde_json::json!("1e-999"), Some(false)),
                (serde_json::json!(-1), None),
                (serde_json::Value::Null, None),
            ] {
                let mut pricing = serde_json::json!({"prompt": "0", "completion": "0"});
                pricing[field] = amount;
                let models = parse_models_response(
                    &serde_json::json!({
                        "data": [{"id": "provider/model:free", "isFree": true, "pricing": pricing}]
                    })
                    .to_string(),
                    &[],
                )
                .expect("pricing uncertainty does not invalidate the model inventory");
                assert_eq!(models[0].is_free, expected, "{field}");
            }
        }
    }

    #[test]
    fn metadata_audit_conditional_pricing_never_proclaims_a_potential_charge_free() {
        for (overrides, expected) in [
            (
                serde_json::json!([{"min_prompt_tokens": 200_000, "prompt": "0.000001"}]),
                Some(false),
            ),
            (
                serde_json::json!([{"utc_start": 0, "utc_end": 400, "image_output": "0.01"}]),
                Some(false),
            ),
            (serde_json::json!([{"prompt": "0"}]), Some(true)),
            (serde_json::json!([]), Some(true)),
            (serde_json::json!([{"prompt": "unknown"}]), None),
            (serde_json::json!([{"prompt": -1}]), None),
            (serde_json::json!(["invalid-override"]), None),
            (serde_json::json!({"prompt": "0.01"}), None),
        ] {
            let models = parse_models_response(
                &serde_json::json!({
                    "data": [{
                        "id": "provider/model:free",
                        "pricing": {"prompt": "0", "completion": "0", "overrides": overrides}
                    }]
                })
                .to_string(),
                &[],
            )
            .expect("parse conditional pricing");
            assert_eq!(models[0].is_free, expected, "{overrides}");
        }
    }

    #[test]
    fn parse_models_response_normalizes_openrouter_reasoning_metadata() {
        let models = parse_provider_models_response(
            r#"{"object":"list","data":[
                {
                    "id":"xiaomi/mimo-v2.6-pro",
                    "supported_parameters":["reasoning","include_reasoning"],
                    "reasoning":{"mandatory":false}
                },
                {
                    "id":"deepseek/deepseek-v4-flash",
                    "supported_parameters":["reasoning","reasoning_effort","include_reasoning"],
                    "reasoning":{
                        "mandatory":false,
                        "supported_efforts":["xhigh","high"],
                        "default_effort":"high"
                    }
                }
            ]}"#,
            &[],
            "https://openrouter.ai/api/v1",
            "https://openrouter.ai/api/v1/models",
        )
        .expect("parse OpenRouter model metadata");

        let mimo = models
            .iter()
            .find(|model| model.id == "xiaomi/mimo-v2.6-pro")
            .and_then(|model| model.reasoning.as_ref())
            .expect("Mimo reasoning");
        assert_eq!(mimo["supportedEfforts"], serde_json::json!([]));
        assert_eq!(mimo["upstream"]["format"], "reasoning_object");
        assert_eq!(mimo["upstream"]["parameter"], "reasoning.effort");

        let deepseek = models
            .iter()
            .find(|model| model.id == "deepseek/deepseek-v4-flash")
            .and_then(|model| model.reasoning.as_ref())
            .expect("DeepSeek reasoning");
        assert_eq!(
            deepseek["supportedEfforts"],
            serde_json::json!(["xhigh", "high"])
        );
        assert_eq!(deepseek["upstream"]["format"], "reasoning_object");
        assert_eq!(deepseek["upstream"]["parameter"], "reasoning.effort");
        assert_eq!(deepseek["defaultEffort"], "high");
    }

    #[test]
    fn parse_models_response_normalizes_openrouter_metadata_when_base_omits_v1() {
        let models = parse_provider_models_response(
            r#"{"object":"list","data":[
                {
                    "id":"openrouter/model",
                    "supported_parameters":["reasoning","include_reasoning","tools"]
                }
            ]}"#,
            &[],
            "https://openrouter.ai/api",
            "https://openrouter.ai/api/v1/models",
        )
        .expect("parse OpenRouter metadata from the resolved endpoint");

        let model = &models[0];
        let reasoning = model.reasoning.as_ref().expect("OpenRouter reasoning");
        assert_eq!(reasoning["supportedEfforts"], serde_json::json!([]));
        assert_eq!(reasoning["upstream"]["format"], "reasoning_object");
        assert_eq!(reasoning["upstream"]["parameter"], "reasoning.effort");
        assert_eq!(
            model
                .protocol_capability
                .as_ref()
                .expect("OpenRouter protocol capability")["supportedEndpoints"],
            serde_json::json!(["openai_chat"])
        );
    }

    #[test]
    fn parse_models_response_does_not_infer_openrouter_metadata_from_unknown_base_scopes() {
        for base_url in [
            "https://openrouter.ai/other/api",
            "https://openrouter.ai/other/api/v1",
            "https://openrouter.ai/api?scope=other",
            "https://openrouter.ai/api/v1#other",
        ] {
            let models = parse_provider_models_response(
                r#"{"data":[{"id":"model","supported_parameters":["reasoning","tools"]}]}"#,
                &[],
                base_url,
                "https://openrouter.ai/api/v1/models",
            )
            .expect("model inventory remains usable without provider inference");
            assert!(
                models[0].reasoning.is_none(),
                "unknown API scope must not invent effort levels: {base_url}"
            );
            assert!(
                models[0].protocol_capability.is_none(),
                "unknown API scope must not certify a protocol: {base_url}"
            );
        }
    }

    fn parse_protocol_metadata(
        base_url: &str,
        models_url: &str,
        entry: serde_json::Value,
    ) -> Option<serde_json::Value> {
        let body = serde_json::json!({ "data": [entry] }).to_string();
        let models = parse_provider_models_response(&body, &[], base_url, models_url)
            .expect("parse provider protocol metadata");
        serde_json::to_value(&models[0])
            .expect("serialize fetched model")
            .get("protocolCapability")
            .cloned()
    }

    #[test]
    fn protocol_metadata_binds_explicit_endpoints_to_original_provider_and_model() {
        let models = parse_provider_models_response(
            r#"{"data":[
                {
                    "id":" model-a ",
                    "supported_endpoints":["/v1/responses","chat/completions"],
                    "supports_tools":true,
                    "supports_streaming":true,
                    "supports_tool_continuation":true,
                    "baseUrl":"https://unrelated.test",
                    "upstreamModel":"wrong-model"
                },
                {
                    "id":"model-b",
                    "metadata":{"capabilities":{"endpoints":["openai_chat"]}}
                }
            ]}"#,
            &[],
            " https://API.PROVIDER.test/v1/// ",
            "https://api.provider.test/model-catalog?scope=account",
        )
        .expect("parse explicit provider protocol declarations");

        assert_eq!(
            models[0].protocol_capability,
            Some(serde_json::json!({
                "schemaVersion": 1,
                "source": "provider_api",
                "baseUrl": "https://api.provider.test/v1",
                "upstreamModel": "model-a",
                "supportedEndpoints": ["openai_chat", "openai_responses"],
                "supportsTools": true,
                "supportsStreaming": true,
                "supportsToolContinuation": true,
            }))
        );
        assert_eq!(
            models[1].protocol_capability,
            Some(serde_json::json!({
                "schemaVersion": 1,
                "source": "provider_api",
                "baseUrl": "https://api.provider.test/v1",
                "upstreamModel": "model-b",
                "supportedEndpoints": ["openai_chat"],
            }))
        );
    }

    #[test]
    fn protocol_metadata_accepts_endpoint_aliases_and_matching_nested_declarations() {
        for entry in [
            serde_json::json!({
                "id": "model",
                "supportedEndpoints": ["responses", "/v1/responses", "openai_responses"],
            }),
            serde_json::json!({
                "id": "model",
                "supported_endpoints": ["/v1/responses", "/v1/embeddings", "anthropic_messages"],
            }),
            serde_json::json!({
                "id": "model",
                "capability": {
                    "endpoints": ["openai_responses"],
                    "supportsTools": true,
                },
                "metadata": {
                    "supported_endpoints": ["responses"],
                    "supported_parameters": ["tools", "tool_choice"],
                },
            }),
        ] {
            let capability = parse_protocol_metadata(
                "https://provider.test/v1",
                "https://provider.test/v1/models",
                entry,
            )
            .expect("explicit Responses capability");
            assert_eq!(
                capability["supportedEndpoints"],
                serde_json::json!(["openai_responses"])
            );
        }
    }

    #[test]
    fn protocol_metadata_preserves_explicit_false_flags_without_certifying_tools() {
        let capability = parse_protocol_metadata(
            "https://provider.test/v1",
            "https://provider.test/v1/models",
            serde_json::json!({
                "id": "model",
                "endpoints": ["chat/completions"],
                "capabilities": {
                    "tools": false,
                    "stream": false,
                    "tool_continuation": false,
                },
            }),
        )
        .expect("explicit protocol metadata");
        assert_eq!(capability["supportsTools"], serde_json::json!(false));
        assert_eq!(capability["supportsStreaming"], serde_json::json!(false));
        assert_eq!(
            capability["supportsToolContinuation"],
            serde_json::json!(false)
        );
    }

    #[test]
    fn protocol_metadata_infers_chat_only_for_actual_openrouter_api_with_tools() {
        for (base_url, models_url) in [
            (
                "https://openrouter.ai/api/v1",
                "https://openrouter.ai/api/v1/models",
            ),
            (
                "https://openrouter.ai/api",
                "https://openrouter.ai/api/v1/models",
            ),
            (
                "https://OPENROUTER.AI:443/api/v1/",
                "https://OPENROUTER.AI:443/api/v1/models/",
            ),
        ] {
            let capability = parse_protocol_metadata(
                base_url,
                models_url,
                serde_json::json!({
                    "id": "unrelated-vendor/opaque-model",
                    "supported_parameters": ["tools"],
                }),
            )
            .expect("OpenRouter advertised tools");
            assert_eq!(
                capability["supportedEndpoints"],
                serde_json::json!(["openai_chat"])
            );
            assert_eq!(capability["supportsTools"], serde_json::json!(true));
            assert!(capability.get("supportsStreaming").is_none());
            assert!(capability.get("supportsToolContinuation").is_none());
        }
        let capability = parse_protocol_metadata(
            "https://openrouter.ai/api/v1",
            "https://openrouter.ai/api/v1/models",
            serde_json::json!({
                "id": "opaque-model",
                "supportsTools": true,
                "supported_parameters": ["tool_choice"],
            }),
        )
        .expect("explicit advertised tool support");
        assert_eq!(
            capability["supportedEndpoints"],
            serde_json::json!(["openai_chat"])
        );
        assert_eq!(capability["supportsTools"], serde_json::json!(true));
    }

    #[test]
    fn protocol_metadata_does_not_infer_protocol_from_model_identity_or_catalog_facts() {
        for entry in [
            serde_json::json!({"id": "openai/gpt-5", "context_window": 128000}),
            serde_json::json!({
                "id": "openrouter/openai/gpt-5",
                "owned_by": "OpenRouter",
                "supported_parameters": ["reasoning", "include_reasoning"],
                "reasoning": {"mandatory": false},
            }),
            serde_json::json!({
                "id": "model",
                "supported_parameters": [],
                "supports_tools": false,
            }),
            serde_json::json!({
                "id": "model",
                "supported_parameters": ["tools_choice"],
            }),
            serde_json::json!({
                "id": "model",
                "supported_parameters": ["tool_choice"],
            }),
        ] {
            assert!(parse_protocol_metadata(
                "https://openrouter.ai/api/v1",
                "https://openrouter.ai/api/v1/models",
                entry,
            )
            .is_none());
        }
    }

    #[test]
    fn protocol_metadata_requires_known_inference_and_final_discovery_url_scopes() {
        let trusted_base = "https://openrouter.ai/api/v1";
        let trusted_models = "https://openrouter.ai/api/v1/models";
        for (base_url, models_url) in [
            ("https://provider.test/v1", trusted_models),
            (trusted_base, "https://catalog-directory.test/models"),
            (
                "https://openrouter.ai.evil.test/api/v1",
                "https://openrouter.ai.evil.test/api/v1/models",
            ),
            (
                "https://openrouter.ai@evil.test/api/v1",
                "https://openrouter.ai@evil.test/api/v1/models",
            ),
            ("http://openrouter.ai/api/v1", trusted_models),
            ("https://openrouter.ai:8443/api/v1", trusted_models),
            ("https://openrouter.ai/other/api/v1", trusted_models),
            (trusted_base, "https://openrouter.ai/other/api/v1/models"),
            (
                "https://openrouter.provider.test/api/v1",
                "https://openrouter.provider.test/api/v1/models",
            ),
            (
                trusted_base,
                "https://openrouter.ai/api/v1/models?scope=other",
            ),
            (trusted_base, "https://openrouter.ai/api/v1/models#other"),
        ] {
            assert!(
                parse_protocol_metadata(
                    base_url,
                    models_url,
                    serde_json::json!({
                        "id": "model",
                        "supported_parameters": ["tools", "tool_choice"],
                    }),
                )
                .is_none(),
                "unexpected inferred protocol for {base_url} / {models_url}",
            );
        }
    }

    #[test]
    fn protocol_metadata_rejects_external_or_unsafe_discovery_with_explicit_endpoints() {
        for models_url in [
            "https://catalog-directory.test/models",
            "https://models.dev/api.json",
            "https://openrouter.ai/api/v1/models",
            "http://provider.test/v1/models",
            "https://provider.test:8443/v1/models",
            "https://[REDACTED]@provider.test/v1/models",
            "https://provider.test/v1/models#[REDACTED]",
            "relative/models",
        ] {
            assert!(
                parse_protocol_metadata(
                    "https://provider.test/v1",
                    models_url,
                    serde_json::json!({
                        "id": "model",
                        "supported_endpoints": ["responses", "chat/completions"],
                        "supported_parameters": ["tools", "tool_choice"],
                    }),
                )
                .is_none(),
                "external or unsafe discovery must not certify the provider",
            );
        }
    }

    #[test]
    fn protocol_metadata_rejects_malformed_empty_or_conflicting_declarations() {
        for entry in [
            serde_json::json!({"id": "model", "endpoints": []}),
            serde_json::json!({"id": "model", "endpoints": ["anthropic_messages"]}),
            serde_json::json!({"id": "model", "endpoints": "responses"}),
            serde_json::json!({"id": "model", "endpoints": ["responses", null]}),
            serde_json::json!({"id": "model", "endpoints": ["responses", " "]}),
            serde_json::json!({"id": "model", "endpoints": ["https://wrong.test/responses"]}),
            serde_json::json!({
                "id": "model",
                "supported_endpoints": ["responses"],
                "supportedEndpoints": ["chat/completions"],
            }),
            serde_json::json!({
                "id": "model",
                "endpoints": ["responses"],
                "supportsTools": true,
                "capabilities": {"supports_tools": false},
            }),
            serde_json::json!({
                "id": "model",
                "endpoints": ["responses"],
                "supportsStreaming": "true",
            }),
            serde_json::json!({
                "id": "model",
                "endpoints": ["responses"],
                "supportsToolContinuation": null,
            }),
            serde_json::json!({
                "id": "model",
                "endpoints": ["responses"],
                "supported_parameters": ["tools"],
                "supportsTools": false,
            }),
            serde_json::json!({
                "id": "model",
                "endpoints": ["responses"],
                "supported_parameters": ["tools", 1],
            }),
        ] {
            let mut entry = entry;
            if entry.get("supported_parameters").is_none() {
                entry["supported_parameters"] = serde_json::json!(["tools"]);
            }
            assert!(
                parse_protocol_metadata(
                    "https://openrouter.ai/api/v1",
                    "https://openrouter.ai/api/v1/models",
                    entry.clone(),
                )
                .is_none(),
                "unexpected protocol capability for {entry}",
            );
        }
    }

    #[test]
    fn protocol_metadata_rejects_unsafe_base_urls_without_serializing_url_data() {
        for base_url in [
            "",
            "not a url",
            "https://[REDACTED]@provider.test/v1",
            "https://user:[REDACTED]@provider.test/v1",
            "https://provider.test/v1?api_key=[REDACTED]",
            "https://provider.test/v1#[REDACTED]",
        ] {
            let body = r#"{"data":[{"id":"model","endpoints":["responses"]}]}"#;
            let models = parse_provider_models_response(
                body,
                &[],
                base_url,
                "https://provider.test/v1/models",
            )
            .expect("unsafe URL must not affect model discovery");
            assert!(models[0].protocol_capability.is_none());
            assert!(
                !serde_json::to_string(&models)
                    .unwrap()
                    .contains("[REDACTED]"),
                "unsafe binding data must not be serialized",
            );
        }
    }

    #[test]
    fn test_parse_response_extracts_context_window() {
        let json = r#"{"object":"list","data":[{"id":"model-a","context_window":262144},{"id":"model-b","maxContextWindow":"1000000"},{"id":"model-c","max_model_len":262144},{"id":"model-d","maxModelLen":"131072"},{"id":"model-e","contextWindow":"128000 tokens"},{"id":"model-f","context_length":200000},{"id":"model-g","max_context_length":"204800"},{"id":"model-h","max_input_tokens":1000000},{"id":"model-i","limit":{"context":262144}},{"id":"model-j","limits":{"context_window":"32768"}},{"id":"model-k","metadata":{"maxContextLength":65536}}]}"#;
        let resp: ModelsResponse = serde_json::from_str(json).unwrap();
        let data = resp
            .data
            .unwrap()
            .into_iter()
            .map(|entry| FetchedModel {
                context_window: extract_context_window(&entry.extra),
                id: entry.id,
                input_modalities: None,
                owned_by: entry.owned_by,
                supports_image: None,
                reasoning: None,
                protocol_capability: None,
                is_free: None,
                ..Default::default()
            })
            .collect::<Vec<_>>();

        assert_eq!(data[0].context_window, Some(262_144));
        assert_eq!(data[1].context_window, Some(1_000_000));
        assert_eq!(data[2].context_window, Some(262_144));
        assert_eq!(data[3].context_window, Some(131_072));
        assert_eq!(data[4].context_window, None);
        assert_eq!(data[5].context_window, Some(200_000));
        assert_eq!(data[6].context_window, Some(204_800));
        assert_eq!(data[7].context_window, Some(1_000_000));
        assert_eq!(data[8].context_window, Some(262_144));
        assert_eq!(data[9].context_window, Some(32_768));
        assert_eq!(data[10].context_window, Some(65_536));
    }

    #[test]
    fn test_parse_response_extracts_declared_image_capabilities() {
        let json = r#"{"object":"list","data":[{"id":"vision-model","input_modalities":["text","image"]},{"id":"metadata-vision","metadata":{"modalities":{"input":["text","image"]}}},{"id":"text-model","supportsImage":false},{"id":"unknown-model"}]}"#;
        let resp: ModelsResponse = serde_json::from_str(json).unwrap();
        let data = resp.data.unwrap();

        assert_eq!(
            extract_input_modalities(&data[0].extra).as_deref(),
            Some(&["text".to_string(), "image".to_string()][..])
        );
        assert_eq!(extract_supports_image(&data[0].extra), Some(true));
        assert_eq!(
            extract_input_modalities(&data[1].extra).as_deref(),
            Some(&["text".to_string(), "image".to_string()][..])
        );
        assert_eq!(extract_supports_image(&data[1].extra), Some(true));
        assert_eq!(extract_supports_image(&data[2].extra), Some(false));
        assert_eq!(extract_supports_image(&data[3].extra), None);
    }

    #[test]
    fn test_extract_supports_image_from_nested_capability_metadata() {
        let json = r#"{"object":"list","data":[{"id":"nested-metadata","metadata":{"capabilities":{"supports_image":false}}},{"id":"nested-limit","limit":{"supportsImage":false}}]}"#;
        let resp: ModelsResponse = serde_json::from_str(json).unwrap();
        let data = resp.data.unwrap();

        assert_eq!(extract_supports_image(&data[0].extra), Some(false));
        assert_eq!(extract_supports_image(&data[1].extra), Some(false));
    }

    #[test]
    fn test_extracts_context_and_image_from_protocol_capability_envelopes() {
        let json = r#"{"object":"list","data":[{"id":"nested-protocol","protocolCapability":{"limits":{"contextWindow":131072},"capabilities":{"supportsImage":false}}},{"id":"nested-protocol-snake","protocol_capability":{"context_window":65536,"supports_image":false}}]}"#;
        let resp: ModelsResponse = serde_json::from_str(json).unwrap();
        let data = resp.data.unwrap();

        assert_eq!(extract_context_window(&data[0].extra), Some(131_072));
        assert_eq!(extract_supports_image(&data[0].extra), Some(false));
        assert_eq!(extract_context_window(&data[1].extra), Some(65_536));
        assert_eq!(extract_supports_image(&data[1].extra), Some(false));
    }

    #[test]
    fn test_extracts_nested_capability_metadata_without_dropping_false_values() {
        let json = r#"{"object":"list","data":[{"id":"nested","supportsParallelToolCalls":"malformed","capability":{"limits":{"contextWindow":"262144"},"modalities":{"input":["text","image"]},"supportsParallelToolCalls":false,"protocolCapability":{"supportedEndpoints":["responses"],"supportsTools":false}}},{"id":"nested-metadata","metadata":{"capabilities":{"modalities":{"input":["text","image"]}}}}]}"#;
        let resp: ModelsResponse = serde_json::from_str(json).unwrap();
        let mut data = resp.data.unwrap();
        let metadata_entry = data.pop().unwrap();
        let entry = data.pop().unwrap();

        assert_eq!(extract_context_window(&entry.extra), Some(262_144));
        assert_eq!(
            extract_input_modalities(&entry.extra),
            Some(vec!["text".to_string(), "image".to_string()])
        );
        assert_eq!(
            extract_model_identity_fields(&entry.extra).supports_parallel_tool_calls,
            Some(false)
        );
        assert_eq!(
            extract_protocol_capability(
                &entry.id,
                &entry.extra,
                "https://provider.test/v1",
                "https://provider.test/v1/models",
            )
            .expect("nested protocol declaration")["supportedEndpoints"],
            serde_json::json!(["openai_responses"])
        );
        assert_eq!(
            extract_protocol_capability(
                &entry.id,
                &entry.extra,
                "https://provider.test/v1",
                "https://provider.test/v1/models",
            )
            .expect("nested protocol declaration")["supportsTools"],
            serde_json::json!(false)
        );
        assert_eq!(
            extract_input_modalities(&metadata_entry.extra),
            Some(vec!["text".to_string(), "image".to_string()])
        );
    }

    #[test]
    fn test_parse_volcengine_plan_models_from_official_agentplan_shape() {
        let body = serde_json::json!({
            "ResponseMetadata": {
                "Action": "ListArkAgentPlanModel",
                "Version": "2024-01-01",
                "Service": "ark",
                "Region": "cn-beijing"
            },
            "Result": {
                "Datas": [
                    { "ModelID": "doubao-seed-1.6" },
                    { "ModelID": "ark-code-latest", "ContextWindow": 262144 }
                ]
            }
        });

        let models = parse_volcengine_plan_models(&body);

        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "ark-code-latest");
        assert_eq!(models[0].owned_by.as_deref(), Some("volcengine"));
        assert_eq!(models[0].context_window, Some(262_144));
        assert_eq!(models[1].id, "doubao-seed-1.6");
    }

    #[test]
    fn test_parse_volcengine_plan_models_accepts_string_entries_and_deduplicates() {
        let body = serde_json::json!({
            "Result": {
                "Datas": [
                    "ark-code-latest",
                    { "ModelId": "ark-code-latest" },
                    { "modelId": "doubao-seed-1.6" }
                ]
            }
        });

        let models = parse_volcengine_plan_models(&body);

        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["ark-code-latest", "doubao-seed-1.6"]
        );
    }

    #[test]
    fn test_normalize_volcengine_model_list_action_accepts_only_plan_actions() {
        assert_eq!(
            normalize_volcengine_model_list_action(Some("ListArkAgentPlanModel")).unwrap(),
            Some("ListArkAgentPlanModel")
        );
        assert_eq!(
            normalize_volcengine_model_list_action(Some("ListArkCodingPlanModel")).unwrap(),
            Some("ListArkCodingPlanModel")
        );
        assert!(normalize_volcengine_model_list_action(Some("GetAFPUsage")).is_err());
        assert_eq!(normalize_volcengine_model_list_action(None).unwrap(), None);
    }

    #[test]
    fn test_parse_zhipu_model_overview_contexts() {
        let markdown = r#"
| 模型 | 特点 | 上下文 | 最大输出 |
| :--- | :--- | :--- | :--- |
| [GLM-5.2](/cn/guide/models/text/glm-5.2) | 1M 上下文，支撑复杂长程任务稳定执行
Coding 能力开源 SOTA，从代码生成走向工程交付 | 1M | 128K |
| [GLM-5.1](/cn/guide/models/text/glm-5.1) | 长程任务显著提升 | 200K | 128K |
| [GLM-OCR](/cn/guide/models/vlm/glm-ocr) | 文档理解 | 输入：单图 ≤ 10 MB | |
"#;
        let contexts = parse_zhipu_model_overview_contexts(markdown);

        assert_eq!(contexts.get("glm-5.2"), Some(&1_000_000));
        assert_eq!(contexts.get("glm-5.1"), Some(&200_000));
        assert!(!contexts.contains_key("glm-ocr"));
    }

    #[test]
    fn test_parse_zhipu_model_overview_contexts_skips_unparseable_rows() {
        let markdown = r#"
| 模型 | 特点 | 上下文 | 最大输出 |
| :--- | :--- | :--- | :--- |
| [GLM-4.6（即将下线）](/cn/guide/models/text/glm-4.6) | 老版本 | 200K | 128K |
| [GLM-OCR](/cn/guide/models/vlm/glm-ocr) | 文档理解 | 输入：单图 ≤ 10 MB | |
| [GLM-Pending](/cn/guide/models/text/glm-pending) | 待发布 | 即将上线 | |
"#;
        let contexts = parse_zhipu_model_overview_contexts(markdown);

        assert_eq!(contexts.get("glm-4.6"), Some(&200_000));
        assert!(!contexts.contains_key("glm-ocr"));
        assert!(!contexts.contains_key("glm-pending"));
        assert!(parse_zhipu_model_overview_contexts("").is_empty());
        assert!(
            parse_zhipu_model_overview_contexts("| 模型 | 特点 | 上下文 | 最大输出 |").is_empty()
        );
    }

    #[test]
    fn test_parse_zhipu_detail_context() {
        let markdown = r#"
<Card title="上下文窗口" icon={<svg />}>
  128K
</Card>
"#;

        assert_eq!(parse_zhipu_detail_context(markdown), Some(128_000));
    }

    #[test]
    fn test_parse_zhipu_detail_context_ignores_other_cards() {
        let markdown = r#"
<Card title="最大输出" icon={<svg />}>
  128K
</Card>
<Card title="上下文窗口" icon={<svg />}>
  1M
</Card>
"#;

        assert_eq!(parse_zhipu_detail_context(markdown), Some(1_000_000));
        assert_eq!(
            parse_zhipu_detail_context("<Card title=\"最大输出\">128K</Card>"),
            None
        );
    }

    #[test]
    fn test_models_dev_endpoint_matches_provider_api() {
        assert!(endpoint_matches_provider_api(
            "https://router.requesty.ai/v1/models",
            "https://router.requesty.ai/v1"
        ));
        assert!(endpoint_matches_provider_api(
            "https://openrouter.ai/api/v1/models",
            "https://openrouter.ai/api/v1/"
        ));
        assert!(!endpoint_matches_provider_api(
            "https://api.other.example/v1/models",
            "https://openrouter.ai/api/v1"
        ));
    }

    #[test]
    fn test_lookup_models_dev_context_matches_exact_and_suffix_ids() {
        let provider_models = serde_json::json!({
            "openai/gpt-5.2-chat": {
                "id": "openai/gpt-5.2-chat",
                "limit": { "context": 128000 }
            },
            "xai/grok-4-fast": {
                "id": "xai/grok-4-fast",
                "limit": { "context": 2000000 }
            },
            "image-model": {
                "id": "image-model",
                "limit": { "context": 0 }
            }
        });
        let models = provider_models.as_object().unwrap();

        assert_eq!(
            lookup_models_dev_context(models, "gpt-5.2-chat"),
            Some(128_000)
        );
        assert_eq!(
            lookup_models_dev_context(models, "xai/grok-4-fast:free"),
            Some(2_000_000)
        );
        assert_eq!(lookup_models_dev_context(models, "image-model"), None);
        assert_eq!(lookup_models_dev_context(models, "missing-model"), None);
    }

    #[test]
    fn test_lookup_models_dev_context_rejects_ambiguous_suffix_ids() {
        let provider_models = serde_json::json!({
            "provider-a/shared-model": {
                "id": "provider-a/shared-model",
                "limit": { "context": 100000 }
            },
            "provider-b/shared-model": {
                "id": "provider-b/shared-model",
                "limit": { "context": 200000 }
            }
        });
        let models = provider_models.as_object().unwrap();

        assert_eq!(lookup_models_dev_context(models, "shared-model"), None);
        assert_eq!(
            lookup_models_dev_context(models, "provider-b/shared-model"),
            Some(200_000)
        );
    }

    #[test]
    fn metadata_audit_models_dev_exact_identity_does_not_inherit_sibling_context() {
        let provider_models = serde_json::json!({
            "shared-model": {"id": "shared-model"},
            "provider/shared-model": {
                "id": "provider/shared-model",
                "limit": {"context": 200_000}
            }
        });
        assert_eq!(
            lookup_models_dev_context(provider_models.as_object().unwrap(), "shared-model"),
            None,
        );
    }

    #[test]
    fn reaudit_exact_model_without_context_blocks_an_earlier_suffix_match() {
        let provider_models = serde_json::json!({
            "provider/shared-model": {
                "id": "provider/shared-model",
                "limit": {"context": 200_000}
            },
            "shared-model": {"id": "shared-model"}
        });
        assert_eq!(
            lookup_models_dev_context(provider_models.as_object().unwrap(), "shared-model"),
            None,
            "exact identity must win independently of inventory order"
        );
    }

    #[test]
    fn reaudit_unknown_opencode_scopes_never_match_each_other() {
        for (endpoint, api) in [
            (
                "https://opencode.ai/unknown/models",
                "https://opencode.ai/other",
            ),
            (
                "https://opencode.ai/unknown/models",
                "https://opencode.ai/unknown",
            ),
            (
                "https://opencode.ai/zen/v10/models",
                "https://opencode.ai/zen/v10",
            ),
        ] {
            assert!(
                !endpoint_matches_provider_api(endpoint, api),
                "unknown scope is not trusted provider evidence: {endpoint} / {api}"
            );
        }
        let catalog = serde_json::json!({
            "unknown": {
                "api": "https://opencode.ai/other",
                "models": {"model": {"limit": {"context": 200_000}}}
            }
        });
        assert!(
            find_models_dev_provider_models(&catalog, "https://opencode.ai/unknown/models")
                .is_none()
        );
    }

    #[test]
    fn test_find_models_dev_provider_models_uses_api_prefix() {
        let catalog = serde_json::json!({
            "requesty": {
                "api": "https://router.requesty.ai/v1",
                "models": {
                    "xai/grok-4-fast": { "limit": { "context": 2000000 } }
                }
            },
            "other": {
                "api": "https://api.other.example/v1",
                "models": {
                    "xai/grok-4-fast": { "limit": { "context": 1 } }
                }
            }
        });

        let models =
            find_models_dev_provider_models(&catalog, "https://router.requesty.ai/v1/models")
                .unwrap();
        assert_eq!(
            lookup_models_dev_context(models, "xai/grok-4-fast"),
            Some(2_000_000)
        );
    }

    #[test]
    fn metadata_audit_models_dev_endpoint_matching_rejects_host_and_path_prefix_spoofs() {
        for endpoint in [
            "https://api.provider.test.evil.test/v1/models",
            "https://api.provider.test@evil.test/v1/models",
            "https://user@api.provider.test/v1/models",
            "https://api.provider.test:8443/v1/models",
            "http://api.provider.test/v1/models",
            "https://api.provider.test/v10/models",
            "https://api.provider.test/v1-else/models",
            "https://api.provider.test/v1/models?scope=other",
            "https://api.provider.test/v1/models#other",
        ] {
            assert!(
                !endpoint_matches_provider_api(endpoint, "https://api.provider.test/v1"),
                "{endpoint}",
            );
        }
        assert!(endpoint_matches_provider_api(
            "https://API.PROVIDER.TEST/v1/models/",
            "https://api.provider.test/v1",
        ));
    }

    #[test]
    fn metadata_audit_models_dev_opencode_aliases_keep_zen_and_go_separate() {
        let zen_api = "https://opencode.ai/inference/openai/v1";
        let go_api = "https://opencode.ai/inference/go/openai/v1";
        let catalog = serde_json::json!({
            "opencode": {
                "api": zen_api,
                "models": {"shared-model": {"limit": {"context": 64_000}}}
            },
            "opencode-go": {
                "api": go_api,
                "models": {"shared-model": {"limit": {"context": 128_000}}}
            }
        });
        for (endpoint, context) in [
            ("https://opencode.ai/zen/v1/models", 64_000),
            ("https://opencode.ai/inference/v1/models", 64_000),
            ("https://opencode.ai/inference/openai/v1/models", 64_000),
            ("https://opencode.ai/inference/anthropic/v1", 64_000),
            ("https://opencode.ai/zen/go/v1/models", 128_000),
            ("https://opencode.ai/inference/go/v1/models", 128_000),
            ("https://opencode.ai/inference/go/openai/v1/models", 128_000),
            ("https://opencode.ai/inference/go/anthropic/v1", 128_000),
        ] {
            let models = find_models_dev_provider_models(&catalog, endpoint)
                .unwrap_or_else(|| panic!("missing same-provider alias: {endpoint}"));
            assert_eq!(
                lookup_models_dev_context(models, "shared-model"),
                Some(context),
                "{endpoint}",
            );
            assert_eq!(
                endpoint_matches_provider_api(endpoint, zen_api),
                context == 64_000,
            );
            assert_eq!(
                endpoint_matches_provider_api(endpoint, go_api),
                context == 128_000,
            );
        }
    }

    #[test]
    fn test_apply_missing_context_windows_preserves_explicit_model_metadata() {
        let mut models = vec![
            FetchedModel {
                id: "glm-5.2".to_string(),
                owned_by: Some("zhipu".to_string()),
                context_window: Some(123_456),
                input_modalities: None,
                supports_image: None,
                reasoning: None,
                protocol_capability: None,
                is_free: None,
                ..Default::default()
            },
            FetchedModel {
                id: "glm-5.1".to_string(),
                owned_by: Some("zhipu".to_string()),
                context_window: None,
                input_modalities: None,
                supports_image: None,
                reasoning: None,
                protocol_capability: None,
                is_free: None,
                ..Default::default()
            },
        ];

        apply_missing_context_windows(&mut models, |model_id| match model_id {
            "glm-5.2" => Some(1_000_000),
            "glm-5.1" => Some(200_000),
            _ => None,
        });

        assert_eq!(models[0].context_window, Some(123_456));
        assert_eq!(models[1].context_window, Some(200_000));
    }

    #[test]
    fn test_apply_missing_catalog_facts_fills_capabilities_without_overwriting_upstream() {
        let mut models = vec![
            FetchedModel {
                id: "gpt-5.5".to_string(),
                owned_by: Some("openai".to_string()),
                context_window: Some(123_456),
                input_modalities: Some(vec!["text".to_string()]),
                supports_image: Some(false),
                reasoning: None,
                protocol_capability: None,
                is_free: None,
                ..Default::default()
            },
            FetchedModel {
                id: "gpt-5.6".to_string(),
                owned_by: Some("openai".to_string()),
                context_window: None,
                input_modalities: None,
                supports_image: None,
                reasoning: None,
                protocol_capability: None,
                is_free: None,
                ..Default::default()
            },
        ];
        let entry = serde_json::json!({
            "limit": { "context": 1_050_000 },
            "modalities": { "input": ["text", "image"], "output": ["text"] }
        });

        apply_missing_catalog_facts(&mut models, |model_id| {
            (model_id == "gpt-5.6").then_some(&entry)
        });

        assert_eq!(models[0].context_window, Some(123_456));
        assert_eq!(
            models[0].input_modalities.as_deref(),
            Some(&["text".to_string()][..])
        );
        assert_eq!(models[0].supports_image, Some(false));
        assert_eq!(models[1].context_window, Some(1_050_000));
        assert_eq!(
            models[1].input_modalities.as_deref(),
            Some(&["text".to_string(), "image".to_string()][..])
        );
        assert_eq!(models[1].supports_image, Some(true));
    }

    #[test]
    fn test_zhipu_endpoint_and_glm_model_detection_boundaries() {
        assert!(is_zhipu_models_endpoint(
            "https://open.bigmodel.cn/api/coding/paas/v4/models"
        ));
        assert!(is_zhipu_models_endpoint(
            "https://OPEN.BIGMODEL.CN/api/coding/paas/v4/models"
        ));
        assert!(is_zhipu_models_endpoint("https://api.z.ai/api/v1/models"));
        assert!(!is_zhipu_models_endpoint(
            "https://api.deepseek.com/v1/models"
        ));
        assert!(!is_zhipu_models_endpoint(""));

        assert!(is_glm_model_id("glm-5.2"));
        assert!(is_glm_model_id("GLM-5.2"));
        assert!(is_glm_model_id("ZhipuAI/glm-5.2[1m]"));
        assert!(!is_glm_model_id("deepseek-chat"));
        assert!(!is_glm_model_id(""));
    }

    #[test]
    fn test_zhipu_model_id_normalization_and_slug() {
        assert_eq!(normalize_zhipu_model_id("ZhipuAI/GLM-5.2[1m]"), "glm-5.2");
        assert_eq!(
            zhipu_docs_slug_for_model_id("glm-4.5-air").as_deref(),
            Some("glm-4.5")
        );
        assert_eq!(
            zhipu_docs_slug_for_model_id("glm-5-turbo").as_deref(),
            Some("glm-5-turbo")
        );
    }

    #[test]
    fn test_parse_response_empty_data() {
        let json = r#"{"object":"list","data":[]}"#;
        let resp: ModelsResponse = serde_json::from_str(json).unwrap();
        assert!(resp.data.unwrap().is_empty());
    }
}
