//! Provider 只读元数据发现适配器（首版：OpenRouter、vLLM）。
//!
//! 原则：
//! - 只读元数据，禁止通过 low/high/none 真实推理请求主动试错；
//! - 只提取 allowlist 字段，不保存或展示原始服务器路径、凭据和其他敏感配置；
//! - `NotAdvertised`/`Unavailable`/`Invalid` 均不能自动生成 `confirmed_unsupported`。

use crate::app_config::AppType;
use crate::provider::Provider;
use crate::proxy::providers::codex_reasoning::{
    reasoning_capability_from_openrouter_model_entry,
    reasoning_capability_from_provider_model_entry, CodexModelReasoningCapability,
};
use crate::reasoning_capabilities::{
    DiscoveryOutcome, ProviderCapabilitySnapshot, ReasoningCapabilitySnapshot,
};
use reqwest::StatusCode;
use serde_json::Value;
use std::time::Duration;

/// 发现请求超时（与 model_fetch 保持一致）。
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(15);

/// 错误响应体截断长度：避免把几十 KB 的 HTML 404 页整页保留到日志。
const ERROR_BODY_MAX_CHARS: usize = 512;

/// 按平台标识（name / base_url）判定 provider 平台。
///
/// 仅以平台标识判定，绝不掺入 model 名——model 名属于模型厂商，会把托管
/// 平台误判成模型官方接口。
pub fn detect_platform(provider: &Provider) -> Option<&'static str> {
    let base_url = base_url(provider).unwrap_or_default();
    detect_platform_from_name_and_base_url(Some(&provider.name), Some(&base_url))
}

/// Classify a provider from its own label and endpoint only.
///
/// This helper is intentionally independent of model IDs. A gateway may expose
/// `gpt-*` names while accepting a different reasoning schema, so model names
/// are never evidence for the official OpenAI contract.
pub fn detect_platform_from_name_and_base_url(
    name: Option<&str>,
    base_url: Option<&str>,
) -> Option<&'static str> {
    let platform = format!(
        "{} {}",
        name.unwrap_or_default(),
        base_url.unwrap_or_default()
    )
    .to_ascii_lowercase();
    if platform.contains("openrouter") || base_url.is_some_and(is_openrouter_endpoint) {
        Some("openrouter")
    } else if platform.contains("vllm") {
        Some("vllm")
    } else if is_official_openai_endpoint(base_url.unwrap_or_default()) {
        Some("openai")
    } else {
        None
    }
}

/// Exact OpenRouter endpoint classification shared by discovery and catalog
/// fetch. A look-alike hostname must never receive OpenRouter's native
/// `reasoning: { effort }` contract.
pub fn is_openrouter_endpoint(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    host.eq_ignore_ascii_case("openrouter.ai") && {
        let path = parsed.path().trim_end_matches('/');
        path.is_empty()
            || path.eq_ignore_ascii_case("/api")
            || path.eq_ignore_ascii_case("/api/v1")
            || path.eq_ignore_ascii_case("/api/v1/models")
    }
}

/// 统一发现入口：按平台选择适配器。未知平台仍尝试其认证 `/models`
/// 端点；没有凭据或没有声明时保持 `Unavailable`/`NotAdvertised`，绝不猜测。
pub async fn discover_provider_capability(provider: &Provider, model: &str) -> DiscoveryOutcome {
    match detect_platform(provider) {
        Some("openrouter") => discover_openrouter(provider, model).await,
        Some("vllm") => discover_vllm(provider, model).await,
        _ => discover_generic(provider, model).await,
    }
}

fn provider_key(provider: &Provider) -> String {
    provider.id.clone()
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn base_url(provider: &Provider) -> Option<String> {
    // Codex providers persist the effective endpoint inside the TOML config
    // (`model_providers.<id>.base_url`). Prefer that value over generic
    // top-level fields so discovery reaches the same upstream that Codex uses.
    if let Some(config_text) = provider
        .settings_config
        .get("config")
        .and_then(Value::as_str)
    {
        if let Some(base_url) = crate::codex_config::extract_codex_base_url(config_text) {
            let base_url = base_url.trim();
            if !base_url.is_empty() {
                return Some(base_url.to_string());
            }
        }
    }

    provider
        .settings_config
        .get("base_url")
        .or_else(|| provider.settings_config.get("baseURL"))
        .or_else(|| provider.settings_config.get("baseUrl"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(ToString::to_string)
}

fn is_official_openai_endpoint(base: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(base) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    host.eq_ignore_ascii_case("api.openai.com")
        || (host.eq_ignore_ascii_case("chatgpt.com") && url.path().contains("/backend-api/codex"))
        || (host.eq_ignore_ascii_case("chat.openai.com")
            && url.path().contains("/backend-api/codex"))
}

fn provider_api_key(provider: &Provider) -> Option<String> {
    fn first_string(value: Option<&Value>, keys: &[&str]) -> Option<String> {
        keys.iter().find_map(|key| {
            value
                .and_then(|object| object.get(*key))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
    }

    let settings = &provider.settings_config;
    // Pair a Codex TOML endpoint with the credential stored for that same
    // source before consulting generic/stale provider fields.
    if let Some(config) = settings.get("config").and_then(Value::as_str) {
        if let Some(api_key) =
            crate::codex_config::extract_codex_api_key(settings.get("auth"), Some(config))
        {
            if !api_key.trim().is_empty() {
                return Some(api_key);
            }
        }
    }
    first_string(
        Some(settings),
        &["api_key", "apiKey", "token", "access_token", "accessToken"],
    )
    .or_else(|| {
        first_string(
            settings.get("options"),
            &["api_key", "apiKey", "token", "access_token", "accessToken"],
        )
    })
    .or_else(|| {
        first_string(
            settings.get("env"),
            &[
                "OPENAI_API_KEY",
                "API_KEY",
                "OPENROUTER_API_KEY",
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
            ],
        )
    })
    .or_else(|| {
        // Keep the discovery path aligned with the app-wide credential
        // resolver. This covers Codex's `auth.OPENAI_API_KEY` shape even when
        // the provider has no generic top-level key fields.
        let (_, api_key) = provider.resolve_usage_credentials(&AppType::Codex);
        (!api_key.is_empty()).then_some(api_key)
    })
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(DISCOVERY_TIMEOUT)
        .build()
        .map_err(|error| format!("cannot build discovery client: {error}"))
}

fn truncate_body(body: &str) -> String {
    body.chars().take(ERROR_BODY_MAX_CHARS).collect()
}

/// OpenRouter 适配器：`GET {base}/api/v1/models`（公共端点，无需鉴权）。
///
/// 提取目标模型的 `reasoning` 对象（allowlist 字段）：
/// `supported_efforts` / `default_effort` / `mandatory` / `default_enabled` /
/// `supports_max_tokens`。
pub async fn discover_openrouter(provider: &Provider, model: &str) -> DiscoveryOutcome {
    let Some(base) = base_url(provider) else {
        return DiscoveryOutcome::Unavailable;
    };
    let models_url = openrouter_models_url(&base);
    let Ok(http) = client() else {
        return DiscoveryOutcome::Unavailable;
    };

    let response = match http.get(&models_url).send().await {
        Ok(response) => response,
        Err(error) => {
            log::debug!("openrouter discovery unreachable at {models_url}: {error}");
            return DiscoveryOutcome::Unavailable;
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        log::debug!(
            "openrouter discovery failed at {models_url}: {status} {}",
            truncate_body(&body)
        );
        return DiscoveryOutcome::Unavailable;
    }

    let Ok(payload) = response.json::<Value>().await else {
        return DiscoveryOutcome::Invalid;
    };
    let Some(models) = payload.get("data").and_then(Value::as_array) else {
        return DiscoveryOutcome::Invalid;
    };

    let Some(entry) = models
        .iter()
        .find(|entry| model_entry_matches(entry, model))
    else {
        // 端点可达但模型未列出：NotAdvertised（不是 Unavailable）。
        return DiscoveryOutcome::NotAdvertised;
    };

    let Some(reasoning) = entry.get("reasoning") else {
        return DiscoveryOutcome::NotAdvertised;
    };
    if reasoning.is_null() {
        return DiscoveryOutcome::NotAdvertised;
    }

    let Some(capability) = reasoning_capability_from_openrouter_model_entry(entry) else {
        return DiscoveryOutcome::NotAdvertised;
    };
    DiscoveryOutcome::Found(snapshot_from_capability(
        provider,
        model,
        "openrouter_api",
        entry,
        &capability,
    ))
}

fn add_model_identity(values: &mut Vec<String>, value: String) {
    if !value.is_empty() && !values.contains(&value) {
        values.push(value);
    }
}

fn push_model_identity(values: &mut Vec<String>, raw: &str) {
    let normalized = raw.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return;
    }

    add_model_identity(values, normalized.clone());
    let suffix = normalized
        .rsplit_once('/')
        .map(|(_, suffix)| suffix.to_string());
    if let Some(suffix) = suffix {
        add_model_identity(values, suffix);
    }

    // OpenRouter uses dated canonical slugs such as
    // `openai/gpt-6.1-sol-20260929`, while routed Codex models commonly use
    // the stable `gpt-6.1-sol` alias. Treat the date suffix as a canonical
    // alias, but keep the full slug too.
    let current = values.clone();
    for value in current {
        let Some((base, version)) = value.rsplit_once('-') else {
            continue;
        };
        if version.len() == 8 && version.bytes().all(|byte| byte.is_ascii_digit()) {
            add_model_identity(values, base.to_string());
        }
    }
}

fn collect_model_identity_values(value: &Value, values: &mut Vec<String>) {
    match value {
        Value::String(raw) => push_model_identity(values, raw),
        Value::Array(items) => {
            for item in items {
                collect_model_identity_values(item, values);
            }
        }
        Value::Object(object) => {
            for (key, value) in object {
                push_model_identity(values, key);
                collect_model_identity_values(value, values);
            }
        }
        _ => {}
    }
}

fn model_entry_identity_values(entry: &Value) -> Vec<String> {
    let Some(object) = entry.as_object() else {
        return Vec::new();
    };
    let mut values = Vec::new();
    for key in [
        "model",
        "id",
        "upstreamModel",
        "upstream_model",
        "canonical_slug",
        "canonicalSlug",
        "slug",
        "name",
        "display_name",
        "displayName",
        "aliases",
    ] {
        if let Some(value) = object.get(key) {
            collect_model_identity_values(value, &mut values);
        }
    }
    values
}

fn model_entry_matches(entry: &Value, model: &str) -> bool {
    let mut wanted = Vec::new();
    push_model_identity(&mut wanted, model);
    let advertised = model_entry_identity_values(entry);
    wanted
        .iter()
        .any(|candidate| advertised.iter().any(|value| value == candidate))
}

fn snapshot_from_capability(
    provider: &Provider,
    model: &str,
    source: &str,
    entry: &Value,
    capability: &CodexModelReasoningCapability,
) -> ProviderCapabilitySnapshot {
    let reasoning = entry.get("reasoning").and_then(Value::as_object);
    let bool_field = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| entry.get(*key).and_then(Value::as_bool))
            .or_else(|| {
                reasoning.and_then(|object| {
                    keys.iter()
                        .find_map(|key| object.get(*key).and_then(Value::as_bool))
                })
            })
    };
    ProviderCapabilitySnapshot {
        provider_key: provider_key(provider),
        model: model.to_string(),
        fetched_at: now_millis(),
        source: source.to_string(),
        reasoning: Some(ReasoningCapabilitySnapshot {
            supported_efforts: capability.supported_efforts.clone(),
            default_effort: capability.default_effort.clone(),
            mandatory: bool_field(&["mandatory"]).unwrap_or(false),
            default_enabled: bool_field(&["default_enabled", "defaultEnabled"]),
            supports_max_tokens: bool_field(&["supports_max_tokens", "supportsMaxTokens"])
                .unwrap_or(false),
            upstream_format: Some(capability.upstream.format.clone()),
            upstream_parameter: Some(capability.upstream.parameter.clone()),
            upstream_effort_map: (!capability.upstream.effort_map.is_empty())
                .then(|| capability.upstream.effort_map.clone()),
            output_format: capability.output_format.clone(),
        }),
    }
}

/// Generic authenticated `/models` discovery used by Sublyx/Zmhub and other
/// OpenAI-compatible gateways. A 401/403 or missing reasoning declaration is
/// intentionally non-authoritative.
pub async fn discover_generic(provider: &Provider, model: &str) -> DiscoveryOutcome {
    let Some(base) = base_url(provider) else {
        return DiscoveryOutcome::Unavailable;
    };
    let Some(api_key) = provider_api_key(provider) else {
        return DiscoveryOutcome::Unavailable;
    };
    let Ok(http) = client() else {
        return DiscoveryOutcome::Unavailable;
    };
    let trimmed = base.trim_end_matches('/');
    let mut urls = vec![if trimmed.ends_with("/models") {
        trimmed.to_string()
    } else if trimmed
        .rsplit('/')
        .next()
        .is_some_and(|segment| segment.starts_with('v') && segment[1..].parse::<u32>().is_ok())
    {
        format!("{trimmed}/models")
    } else {
        format!("{trimmed}/v1/models")
    }];
    let fallback = format!("{trimmed}/models");
    if urls[0] != fallback {
        urls.push(fallback);
    }

    for url in urls {
        let response = match http.get(&url).bearer_auth(&api_key).send().await {
            Ok(response) => response,
            Err(_) => continue,
        };
        if response.status() == StatusCode::UNAUTHORIZED
            || response.status() == StatusCode::FORBIDDEN
        {
            return DiscoveryOutcome::Unavailable;
        }
        if !response.status().is_success() {
            continue;
        }
        let Ok(payload) = response.json::<Value>().await else {
            return DiscoveryOutcome::Invalid;
        };
        let entries = payload
            .get("data")
            .or_else(|| payload.get("models"))
            .and_then(Value::as_array);
        let Some(entries) = entries else {
            return DiscoveryOutcome::Invalid;
        };
        let Some(entry) = entries
            .iter()
            .find(|entry| model_entry_matches(entry, model))
        else {
            return DiscoveryOutcome::NotAdvertised;
        };
        let Some(capability) = reasoning_capability_from_provider_model_entry(entry) else {
            return DiscoveryOutcome::NotAdvertised;
        };
        return DiscoveryOutcome::Found(snapshot_from_capability(
            provider,
            model,
            "models_api",
            entry,
            &capability,
        ));
    }
    DiscoveryOutcome::Unavailable
}

/// 归一化 OpenRouter models 端点：base 已含 `/api/v1` 时直接拼 `/models`。
fn openrouter_models_url(base: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    if trimmed.to_ascii_lowercase().ends_with("/api/v1") {
        format!("{trimmed}/models")
    } else if trimmed.to_ascii_lowercase().ends_with("/models") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/api/v1/models")
    }
}

/// vLLM 适配器：组合 `/version`、`/v1/models`、`/server_info?config_format=json`。
///
/// vLLM 不在服务端声明逐模型 effort 档位（那是模型属性，不是服务属性），
/// 因此本适配器只产出服务级快照（版本 + 模型存在性 + 推理解析器配置），
/// `reasoning` 子对象保持 None——逐模型能力由版本化能力库提供。
///
/// `/server_info` 是开发端点（`VLLM_SERVER_DEV_MODE` 开启才暴露），生产部署
/// 通常 404——按 `Unavailable` 降级，不是错误。
pub async fn discover_vllm(provider: &Provider, model: &str) -> DiscoveryOutcome {
    let Some(base) = base_url(provider) else {
        return DiscoveryOutcome::Unavailable;
    };
    let Ok(http) = client() else {
        return DiscoveryOutcome::Unavailable;
    };

    // 1. /version：服务版本（revision 匹配用）。
    let version_url = format!("{}/version", base.trim_end_matches('/'));
    // 首版仅用于确认服务可达 + 为后续 revision 匹配预留；vLLM 库条目（P6）
    // 引入后用于 `revision_range` 校验。
    let _version = match http.get(&version_url).send().await {
        Ok(response) if response.status().is_success() => {
            response.json::<Value>().await.ok().and_then(|payload| {
                payload
                    .get("version")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
        }
        Ok(response) => {
            log::debug!("vllm /version failed: {}", response.status());
            None
        }
        Err(error) => {
            log::debug!("vllm /version unreachable at {version_url}: {error}");
            return DiscoveryOutcome::Unavailable;
        }
    };

    // 2. /v1/models：确认目标模型存在于服务实例。
    let models_url = format!("{}/v1/models", base.trim_end_matches('/'));
    let model_listed = match http.get(&models_url).send().await {
        Ok(response) if response.status().is_success() => response
            .json::<Value>()
            .await
            .ok()
            .and_then(|payload| {
                payload.get("data").and_then(Value::as_array).map(|items| {
                    items.iter().any(|item| {
                        item.get("id")
                            .and_then(Value::as_str)
                            .is_some_and(|id| id.trim().eq_ignore_ascii_case(model.trim()))
                    })
                })
            })
            .unwrap_or(false),
        Ok(response) => {
            log::debug!("vllm /v1/models failed: {}", response.status());
            return DiscoveryOutcome::Unavailable;
        }
        Err(error) => {
            log::debug!("vllm /v1/models unreachable at {models_url}: {error}");
            return DiscoveryOutcome::Unavailable;
        }
    };
    if !model_listed {
        return DiscoveryOutcome::NotAdvertised;
    }

    // 3. /server_info?config_format=json：开发端点，只提取 allowlist 字段。
    //    404/403 是常态（生产部署未开 VLLM_SERVER_DEV_MODE），按 Unavailable 降级。
    let info_url = format!(
        "{}/server_info?config_format=json",
        base.trim_end_matches('/')
    );
    let server_info = match http.get(&info_url).send().await {
        Ok(response) if response.status().is_success() => response.json::<Value>().await.ok(),
        Ok(response) if response.status() == StatusCode::NOT_FOUND => {
            log::debug!("vllm /server_info not exposed (dev mode off); degrading");
            None
        }
        Ok(response) => {
            log::debug!("vllm /server_info failed: {}", response.status());
            None
        }
        Err(_) => None,
    };

    // allowlist 提取：只保留推理解析器相关字段，绝不落盘/展示完整 VllmConfig。
    let reasoning_parser = server_info
        .as_ref()
        .and_then(|payload| payload.get("vllm_config"))
        .and_then(|config| config.get("reasoning_config"))
        .and_then(|reasoning| reasoning.get("reasoning_parser"))
        .and_then(Value::as_str)
        .map(ToString::to_string);

    let _ = reasoning_parser; // 首版仅记录到日志，不进入快照（无消费方）。

    DiscoveryOutcome::Found(ProviderCapabilitySnapshot {
        provider_key: provider_key(provider),
        model: model.to_string(),
        fetched_at: now_millis(),
        source: "vllm_server".to_string(),
        // vLLM 不声明逐模型 effort：reasoning 保持 None，resolver 落到能力库。
        reasoning: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn provider(name: &str, base_url: &str) -> Provider {
        Provider {
            id: "test-provider".into(),
            name: name.into(),
            settings_config: json!({ "base_url": base_url }),
            website_url: None,
            category: None,
            created_at: None,
            sort_index: None,
            notes: None,
            meta: None,
            icon: None,
            icon_color: None,
            in_failover_queue: false,
        }
    }

    fn codex_provider(name: &str, base_url: &str, api_key: &str) -> Provider {
        Provider {
            id: "codex-shaped-provider".into(),
            name: name.into(),
            settings_config: json!({
                "config": format!(
                    "model_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"{base_url}\"\n"
                ),
                "auth": { "OPENAI_API_KEY": api_key }
            }),
            website_url: None,
            category: None,
            created_at: None,
            sort_index: None,
            notes: None,
            meta: None,
            icon: None,
            icon_color: None,
            in_failover_queue: false,
        }
    }

    #[test]
    fn detect_platform_openrouter_by_name_or_url() {
        assert_eq!(
            detect_platform(&provider("OpenRouter", "https://api.deepseek.com")),
            Some("openrouter")
        );
        assert_eq!(
            detect_platform(&provider("My Gateway", "https://openrouter.ai/api/v1")),
            Some("openrouter")
        );
        // 名称与 URL 均不含平台标识 → 未知平台。
        assert_eq!(
            detect_platform(&provider("Local Server", "http://127.0.0.1:8000")),
            None
        );
        assert_eq!(
            detect_platform(&provider("Qwen vLLM", "http://vllm-roglinux:8000")),
            Some("vllm")
        );
    }

    #[test]
    fn detect_platform_requires_endpoint_or_provider_identity_not_model_name() {
        assert_eq!(
            detect_platform(&provider("OpenAI", "https://api.openai.com/v1")),
            Some("openai")
        );
        assert_eq!(
            detect_platform(&provider("Sublyx", "https://api.sublyx.org/v1")),
            None
        );
        assert_eq!(
            detect_platform_from_name_and_base_url(
                Some("gpt-6.1-sol"),
                Some("https://api.sublyx.org/v1")
            ),
            None
        );
        assert_eq!(
            detect_platform_from_name_and_base_url(
                Some("Custom OpenAI-compatible gateway"),
                Some("https://api.openai.com.evil.example/v1")
            ),
            None
        );
    }

    #[test]
    fn codex_shaped_settings_resolve_endpoint_and_key_for_discovery() {
        let provider = codex_provider("Sublyx", "https://api.sublyx.org/v1", "sk-sublyx");

        assert_eq!(
            base_url(&provider).as_deref(),
            Some("https://api.sublyx.org/v1")
        );
        assert_eq!(provider_api_key(&provider).as_deref(), Some("sk-sublyx"));
        assert_eq!(detect_platform(&provider), None);
    }

    #[test]
    fn codex_shaped_openrouter_settings_classify_from_toml_endpoint() {
        let provider = codex_provider(
            "Custom gateway",
            "https://openrouter.ai/api/v1",
            "sk-openrouter",
        );

        assert_eq!(detect_platform(&provider), Some("openrouter"));
        assert_eq!(
            base_url(&provider).as_deref(),
            Some("https://openrouter.ai/api/v1")
        );
        assert_eq!(
            provider_api_key(&provider).as_deref(),
            Some("sk-openrouter")
        );
    }

    #[test]
    fn openrouter_models_url_normalization() {
        assert_eq!(
            openrouter_models_url("https://openrouter.ai/api/v1"),
            "https://openrouter.ai/api/v1/models"
        );
        assert_eq!(
            openrouter_models_url("https://openrouter.ai"),
            "https://openrouter.ai/api/v1/models"
        );
        assert_eq!(
            openrouter_models_url("https://openrouter.ai/api/v1/"),
            "https://openrouter.ai/api/v1/models"
        );
    }

    #[test]
    fn model_matching_accepts_openrouter_prefixed_and_dated_canonical_ids() {
        let entry = json!({
            "id": "openai/gpt-6.1-sol",
            "canonical_slug": "openai/gpt-6.1-sol-20260929",
            "name": "OpenAI: GPT-6.1 Sol",
            "aliases": ["gpt-6.1-sol-stable"]
        });

        assert!(model_entry_matches(&entry, "gpt-6.1-sol"));
        assert!(model_entry_matches(&entry, "openai/gpt-6.1-sol-20260929"));
        assert!(model_entry_matches(&entry, "gpt-6.1-sol-stable"));
        assert!(!model_entry_matches(&entry, "gpt-6.1-sol-pro"));
    }

    #[test]
    fn openrouter_shape_preserves_all_advertised_efforts() {
        let entry = json!({
            "id": "openai/gpt-6.1-sol",
            "canonical_slug": "openai/gpt-6.1-sol-20260929",
            "supported_parameters": [
                "include_reasoning",
                "reasoning",
                "reasoning_effort"
            ],
            "reasoning": {
                "mandatory": true,
                "default_enabled": true,
                "supported_efforts": ["max", "xhigh", "high", "medium", "low"],
                "default_effort": "medium"
            }
        });

        let capability = reasoning_capability_from_openrouter_model_entry(&entry)
            .expect("OpenRouter's declared reasoning contract must parse");
        assert_eq!(
            capability.supported_efforts,
            vec!["max", "xhigh", "high", "medium", "low"]
        );
        assert_eq!(capability.default_effort.as_deref(), Some("medium"));
        assert_eq!(capability.upstream.format, "object");
        assert_eq!(capability.upstream.parameter, "reasoning.effort");
    }
}
