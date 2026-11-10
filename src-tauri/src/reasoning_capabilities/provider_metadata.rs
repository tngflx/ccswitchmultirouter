//! Provider 只读元数据发现适配器（首版：OpenRouter、vLLM）。
//!
//! 原则：
//! - 只读元数据，禁止通过 low/high/none 真实推理请求主动试错；
//! - 只提取 allowlist 字段，不保存或展示原始服务器路径、凭据和其他敏感配置；
//! - `NotAdvertised`/`Unavailable`/`Invalid` 均不能自动生成 `confirmed_unsupported`。

use crate::provider::Provider;
use crate::proxy::providers::codex_reasoning::{
    CapabilityConfidence, CodexModelReasoningCapability, CodexModelReasoningUpstream,
    ReasoningControlKind, ReasoningSupportStatus,
};
use crate::reasoning_capabilities::{
    reasoning_evidence_scope_for_settings, reasoning_provider_key,
    reasoning_wire_model_for_settings, DiscoveryOutcome, ProviderCapabilitySnapshot,
    ReasoningCapabilitySnapshot,
};
use reqwest::StatusCode;
use serde_json::Value;
use std::time::Duration;

/// 发现请求超时（与 model_fetch 保持一致）。
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(15);

/// 按平台标识（name / base_url）判定 provider 平台。
///
/// 仅以平台标识判定，绝不掺入 model 名——model 名属于模型厂商，会把托管
/// 平台误判成模型官方接口。
pub fn detect_platform(provider: &Provider) -> Option<&'static str> {
    detect_platform_from_settings_parts(
        &provider.settings_config,
        Some(&provider.name),
        Some(&provider.id),
    )
}

/// Detect a known provider platform from the transient settings shape used by
/// unsaved provider forms and catalog projections.
///
/// The persisted `Provider` record keeps the display name outside
/// `settings_config`, while a draft resolver only receives the settings object.
/// Keep this helper aligned with [`detect_platform`] so both paths select the
/// same capability-library entries.
pub fn detect_platform_from_settings(settings: &Value) -> Option<&'static str> {
    detect_platform_from_settings_parts(settings, None, None)
}

fn detect_platform_from_settings_parts(
    settings: &Value,
    provider_name: Option<&str>,
    provider_id: Option<&str>,
) -> Option<&'static str> {
    // Only the active TOML table belongs to the current transport. Inactive
    // tables must never lend their platform identity to the selected gateway.
    let config = settings
        .get("config")
        .and_then(Value::as_str)
        .and_then(|config| toml::from_str::<toml::Value>(config).ok());
    let selected_provider = config.as_ref().and_then(|config| {
        let selected = config.get("model_provider")?.as_str()?.trim();
        let provider = config.get("model_providers")?.get(selected)?;
        Some((selected, provider))
    });
    // Share the exact runtime-compatible root/selected endpoint precedence
    // with discovery and evidence scopes rather than duplicating a reader.
    let base_url = base_url_from_settings(settings);

    // The actual known transport owns platform identity for every supported
    // provider, not just gateways. URL paths, queries, and credentials are data
    // and must never let stale labels choose a different capability contract.
    if let Some(platform) = base_url.as_deref().and_then(detect_platform_from_url) {
        return Some(platform);
    }

    if let Some((selected, provider)) = selected_provider {
        let config_name = ["name", "providerName", "provider_name"]
            .into_iter()
            .find_map(|key| {
                provider
                    .get(key)
                    .and_then(toml::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            })
            .unwrap_or("");
        // Presets often omit a redundant name; the selected table key is
        // still active provider identity, ahead of stale fallback labels.
        if let Some(platform) = detect_platform_from_label(&format!("{selected} {config_name}")) {
            return Some(platform);
        }
    }

    let (name, id) = provider_identity_from_settings_parts(settings, provider_name, provider_id);
    detect_platform_from_label(&format!("{name} {id}"))
}

/// Original provider label and ID for platform-aware compatibility fallbacks.
/// Routed providers keep synthetic request identities, so consumers must not
/// infer a transport contract from their wrapper display names or route IDs.
pub fn provider_platform_identity(provider: &Provider) -> (&str, &str) {
    provider_identity_from_settings_parts(
        &provider.settings_config,
        Some(&provider.name),
        Some(&provider.id),
    )
}

fn provider_identity_from_settings_parts<'a>(
    settings: &'a Value,
    provider_name: Option<&'a str>,
    provider_id: Option<&'a str>,
) -> (&'a str, &'a str) {
    // Marker presence, even with an empty or malformed value, means wrapper
    // labels are not provider identity. Do not accidentally restore them.
    let has_target_identity = settings.get("codexResolvedTargetProviderId").is_some()
        || settings.get("codexResolvedTargetProviderName").is_some();
    if has_target_identity {
        (
            settings_string(settings, &["codexResolvedTargetProviderName"]).unwrap_or(""),
            settings_string(settings, &["codexResolvedTargetProviderId"]).unwrap_or(""),
        )
    } else {
        (
            settings_string(settings, &["providerName", "provider_name", "name"])
                .or(provider_name)
                .unwrap_or(""),
            provider_id.unwrap_or_default(),
        )
    }
}

fn settings_string<'a>(settings: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| {
        settings
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    })
}

fn settings_base_url(settings: &Value) -> Option<&str> {
    settings_string(settings, &["base_url", "baseURL", "baseUrl"])
}

fn detect_platform_from_label(identity: &str) -> Option<&'static str> {
    let identity = identity.to_ascii_lowercase();
    if identity.contains("openrouter") {
        Some("openrouter")
    } else if identity.contains("sublyx") {
        // Explicit provider labels support custom gateway domains. Model names
        // and arbitrary URL text never enter this fallback identity.
        Some("sublyx")
    } else if identity.contains("vllm") {
        Some("vllm")
    } else {
        // Official model vendors remain host-only: a generic gateway called
        // DeepSeek/Zhipu/DashScope must not inherit an official wire contract.
        None
    }
}

fn detect_platform_from_url(base_url: &str) -> Option<&'static str> {
    let url = reqwest::Url::parse(base_url).ok()?;
    if !matches!(url.scheme(), "https" | "http") {
        return None;
    }
    let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    if host == "openrouter.ai" || (!host.starts_with('.') && host.ends_with(".openrouter.ai")) {
        return Some("openrouter");
    }
    if host == "sublyx.org" || (!host.starts_with('.') && host.ends_with(".sublyx.org")) {
        return Some("sublyx");
    }
    match host.as_str() {
        "api.deepseek.com" => Some("deepseek"),
        "api.z.ai" | "open.bigmodel.cn" => Some("zhipu"),
        "dashscope.aliyuncs.com" | "dashscope-intl.aliyuncs.com" => Some("dashscope"),
        host if !host.starts_with('.') && host.ends_with(".maas.aliyuncs.com") => Some("dashscope"),
        _ => {
            // vLLM is self-hosted rather than tied to an official API domain.
            // Honor explicit deployment host labels such as vllm.local and
            // vllm-roglinux, not arbitrary substring matches like notvllm.
            let label = host.split('.').next().unwrap_or_default();
            (label == "vllm"
                || label
                    .strip_prefix("vllm-")
                    .is_some_and(|suffix| !suffix.is_empty()))
            .then_some("vllm")
        }
    }
}

/// 统一发现入口：按平台选择适配器。未知平台返回 `Unavailable`。
pub async fn discover_provider_capability(provider: &Provider, model: &str) -> DiscoveryOutcome {
    match detect_platform(provider) {
        Some("openrouter") => discover_openrouter(provider, model).await,
        Some("vllm") => discover_vllm(provider, model).await,
        _ => DiscoveryOutcome::Unavailable,
    }
}

fn provider_key(provider: &Provider) -> String {
    reasoning_provider_key(provider).to_string()
}

fn discovery_snapshot(
    provider: &Provider,
    model: &str,
    source: &str,
    reasoning: Option<ReasoningCapabilitySnapshot>,
) -> Option<ProviderCapabilitySnapshot> {
    Some(ProviderCapabilitySnapshot {
        provider_key: provider_key(provider),
        model: reasoning_wire_model_for_settings(&provider.settings_config, model)?,
        fetched_at: now_millis(),
        source: source.to_string(),
        evidence_scope: Some(reasoning_evidence_scope_for_settings(
            &provider.settings_config,
            model,
        )?),
        reasoning,
    })
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn base_url(provider: &Provider) -> Option<String> {
    base_url_from_settings(&provider.settings_config)
}

/// Effective transport shared by platform detection, discovery and evidence.
/// Mirrors `extract_codex_base_url`: built-in OpenAI override, active table,
/// then historical root TOML. JSON draft overrides retain first precedence;
/// empty/malformed aliases never shadow another usable transport declaration.
pub(crate) fn base_url_from_settings(settings: &Value) -> Option<String> {
    if let Some(explicit) = settings_base_url(settings) {
        return Some(explicit.to_string());
    }
    let config = settings.get("config")?.as_str()?;
    let config = toml::from_str::<toml::Value>(config).ok()?;
    let active = toml_string(&config, &["model_provider"]);
    if active.is_none_or(|provider| provider == "openai") {
        if let Some(base_url) = toml_string(&config, &["openai_base_url"]) {
            return Some(base_url.to_string());
        }
    }
    let aliases = &["base_url", "baseURL", "baseUrl"];
    let selected = active
        .and_then(|provider| config.get("model_providers")?.get(provider))
        .and_then(|provider| toml_string(provider, aliases));
    selected
        .or_else(|| toml_string(&config, aliases))
        .map(ToString::to_string)
}

fn toml_string<'a>(value: &'a toml::Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(toml::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    })
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(DISCOVERY_TIMEOUT)
        .build()
        .map_err(|error| format!("cannot build discovery client: {error}"))
}

/// A reqwest error may embed credential-bearing URLs or provider response
/// context. Log only a closed classification, never its Display/Debug output.
fn discovery_error_class(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_builder() {
        "request-builder"
    } else if error.is_redirect() {
        "redirect"
    } else if error.is_decode() {
        "decode"
    } else if error.is_body() {
        "body"
    } else if error.is_request() {
        "request"
    } else {
        "transport"
    }
}

/// OpenRouter 适配器：`GET {base}/api/v1/models`（公共端点，无需鉴权）。
///
/// 提取目标模型的 `reasoning` 对象（allowlist 字段）：
/// `supported_efforts` / `default_effort` / `mandatory` / `default_enabled` /
/// `supports_max_tokens`。
pub async fn discover_openrouter(provider: &Provider, model: &str) -> DiscoveryOutcome {
    let Some(wire_model) = reasoning_wire_model_for_settings(&provider.settings_config, model)
    else {
        return DiscoveryOutcome::NotAdvertised;
    };
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
            log::debug!(
                "openrouter discovery unreachable: {}",
                discovery_error_class(&error)
            );
            return DiscoveryOutcome::Unavailable;
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        // Response bodies can echo tokens or arbitrary provider diagnostics.
        // The HTTP status is sufficient here; never retain the body or URL.
        log::debug!("openrouter discovery failed: HTTP {status}");
        return DiscoveryOutcome::Unavailable;
    }

    let Ok(payload) = response.json::<Value>().await else {
        return DiscoveryOutcome::Invalid;
    };
    let Some(models) = payload.get("data").and_then(Value::as_array) else {
        return DiscoveryOutcome::Invalid;
    };

    let normalized = wire_model.to_ascii_lowercase();
    let entry = models.iter().find(|candidate| {
        ["id", "canonical_slug", "slug"]
            .into_iter()
            .filter_map(|field| candidate.get(field).and_then(Value::as_str))
            .any(|value| value.trim().eq_ignore_ascii_case(&normalized))
    });

    let Some(entry) = entry else {
        // 端点可达但模型未列出：NotAdvertised（不是 Unavailable）。
        return DiscoveryOutcome::NotAdvertised;
    };

    let Some(reasoning) = openrouter_reasoning_snapshot(entry) else {
        return DiscoveryOutcome::NotAdvertised;
    };

    discovery_snapshot(provider, model, "openrouter_api", Some(reasoning))
        .map(DiscoveryOutcome::Found)
        .unwrap_or(DiscoveryOutcome::Invalid)
}

/// Both discovery paths use the same normalization before building a snapshot.
fn openrouter_reasoning_snapshot(entry: &Value) -> Option<ReasoningCapabilitySnapshot> {
    let capability = provider_reasoning_capability_from_model_entry(entry, true)?;
    if capability.effective_support_status() != ReasoningSupportStatus::ConfirmedSupported {
        return None;
    }
    let object = entry.as_object()?;
    let mut scopes = metadata_scopes(object);
    if let Some(reasoning) = object.get("reasoning").and_then(Value::as_object) {
        scopes.insert(0, reasoning);
    }
    Some(ReasoningCapabilitySnapshot {
        supported_efforts: capability.supported_efforts,
        default_effort: capability.default_effort,
        mandatory: !capability.disable_allowed,
        default_enabled: lookup_bool(&scopes, &["default_enabled", "defaultEnabled"]).ok()?,
        supports_max_tokens: lookup_bool(&scopes, &["supports_max_tokens", "supportsMaxTokens"])
            .ok()?
            .unwrap_or(false),
        upstream_format: Some(capability.upstream.format),
        upstream_parameter: Some(capability.upstream.parameter),
        output_format: capability.output_format,
    })
}

/// Convert a raw OpenRouter `/models` entry into the same validated capability
/// schema used by the resolver and Codex catalog projection.
///
/// The caller must have established the OpenRouter API scope. A generic
/// provider's null effort declaration must never inherit gateway semantics.
pub fn openrouter_reasoning_capability_from_model_entry(
    entry: &Value,
) -> Option<CodexModelReasoningCapability> {
    provider_reasoning_capability_from_model_entry(entry, true)
}

pub fn provider_reasoning_capability_from_model_entry(
    entry: &Value,
    openrouter_contract: bool,
) -> Option<CodexModelReasoningCapability> {
    let object = entry.as_object()?;
    let mut scopes = metadata_scopes(object);
    let declared_supported = match lookup_bool(
        &scopes,
        &[
            "supportsReasoning",
            "supports_reasoning",
            "reasoningSupported",
            "reasoning_supported",
            "supportsThinking",
            "supports_thinking",
        ],
    ) {
        Ok(value) => value,
        Err(()) => return None,
    };
    let declared_reasoning_values = scopes
        .iter()
        .filter_map(|scope| scope.get("reasoning"))
        .collect::<Vec<_>>();
    if declared_reasoning_values
        .windows(2)
        .any(|values| values[0] != values[1])
    {
        return None;
    }

    // A present canonical declaration is authoritative for this response. Do
    // not reinterpret a malformed canonical object as a weaker lightweight
    // declaration: that would make a bad upstream row look supported.
    let mut reasoning_boolean = None;
    if let Some(reasoning) = first_declared_value(&scopes, &["reasoning"]) {
        if reasoning.is_null() {
            return None;
        }
        if reasoning.is_object() {
            if declared_supported == Some(false) {
                return None;
            }
            if looks_like_canonical_reasoning(reasoning) {
                return parse_canonical_provider_reasoning(reasoning);
            }
            // A lightweight reasoning object can be completed by sibling
            // declarations at the model-entry level (default, mandatory,
            // wire format and effort list). Add it as a scope and resolve
            // the complete declaration below.
            if let Some(reasoning_object) = reasoning.as_object() {
                scopes.insert(0, reasoning_object);
            }
        } else if reasoning.is_boolean() {
            reasoning_boolean = Some(reasoning.as_bool()?);
        } else {
            return None;
        }
    }

    if declared_supported.is_some()
        && reasoning_boolean.is_some()
        && declared_supported != reasoning_boolean
    {
        return None;
    }

    let supported_efforts = match collect_effort_declaration(&scopes) {
        Ok(value) => value,
        Err(()) => return None,
    };
    let supported_parameters = match collect_string_array_declaration(
        &scopes,
        &["supported_parameters", "supportedParameters"],
    ) {
        Ok(value) => value.unwrap_or_default(),
        Err(()) => return None,
    };
    let mandatory = match lookup_bool(&scopes, &["mandatory", "reasoningMandatory"]) {
        Ok(value) => value,
        Err(()) => return None,
    };
    let has_explicit_controls = supported_efforts.is_some()
        || !supported_parameters.is_empty()
        || has_declared_key(
            &scopes,
            &[
                "supports_max_tokens",
                "supportsMaxTokens",
                "disable_allowed",
                "disableAllowed",
                "default_enabled",
                "defaultEnabled",
                "mandatory",
                "reasoningMandatory",
            ],
        )
        || lookup_effort_string(
            &scopes,
            &[
                "default_effort",
                "defaultEffort",
                "default_level",
                "defaultLevel",
                "default_reasoning_level",
                "defaultReasoningLevel",
                "default_reasoning_effort",
                "defaultReasoningEffort",
            ],
        )
        .is_none()
        || lookup_wire_string(
            &scopes,
            &[
                "reasoning_format",
                "reasoningFormat",
                "upstream_format",
                "upstreamFormat",
                "reasoning_parameter",
                "reasoningParameter",
                "upstream_parameter",
                "upstreamParameter",
            ],
        )
        .is_none();

    // Explicit negative evidence conflicts with any positive control
    // declaration. A positive boolean can be completed by those controls.
    if declared_supported == Some(false) || reasoning_boolean == Some(false) {
        if has_explicit_controls {
            return None;
        }
        return build_boolean_or_unknown_capability(false, mandatory);
    }
    if (declared_supported == Some(true) || reasoning_boolean == Some(true))
        && !has_explicit_controls
    {
        return build_boolean_or_unknown_capability(true, mandatory);
    }

    if supported_efforts.is_none() {
        if openrouter_contract
            && supported_parameters
                .iter()
                .any(|parameter| matches!(parameter.as_str(), "reasoning" | "reasoning_effort"))
        {
            let efforts = if has_null_effort_declaration(&scopes) {
                let mut efforts = ["max", "xhigh", "high", "medium", "low", "minimal"]
                    .into_iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>();
                if mandatory != Some(true) {
                    efforts.push("none".to_string());
                }
                efforts
            } else {
                Vec::new()
            };
            return build_reasoning_capability(
                efforts,
                &scopes,
                true,
                Some("reasoning_object".to_string()),
                Some("reasoning.effort".to_string()),
            );
        }
        return if declared_supported == Some(true) || reasoning_boolean == Some(true) {
            build_boolean_or_unknown_capability(true, mandatory)
        } else {
            None
        };
    }

    let efforts = supported_efforts.expect("checked above");
    let format = lookup_wire_string(
        &scopes,
        &[
            "reasoning_format",
            "reasoningFormat",
            "upstream_format",
            "upstreamFormat",
        ],
    )?;
    let parameter = lookup_wire_string(
        &scopes,
        &[
            "reasoning_parameter",
            "reasoningParameter",
            "upstream_parameter",
            "upstreamParameter",
        ],
    )?;
    let format = format.or_else(|| {
        if openrouter_contract {
            Some("reasoning_object".to_string())
        } else {
            Some("string".to_string())
        }
    });
    let parameter = parameter.or_else(|| {
        if format.as_deref() == Some("reasoning_object") {
            Some("reasoning.effort".to_string())
        } else {
            Some("reasoning_effort".to_string())
        }
    });
    build_reasoning_capability(efforts, &scopes, openrouter_contract, format, parameter)
}

fn metadata_scopes(
    object: &serde_json::Map<String, Value>,
) -> Vec<&serde_json::Map<String, Value>> {
    const MAX_METADATA_SCOPE_DEPTH: u8 = 8;
    let envelope_keys = [
        "metadata",
        "effort",
        "capability",
        "capabilities",
        "protocolCapability",
        "protocol_capability",
        "limit",
        "limits",
    ];
    let mut scopes = vec![object];
    let mut pending = vec![(object, 0u8)];
    while let Some((scope, depth)) = pending.pop() {
        if depth >= MAX_METADATA_SCOPE_DEPTH {
            continue;
        }
        for key in envelope_keys {
            if let Some(nested) = scope.get(key).and_then(Value::as_object) {
                scopes.push(nested);
                pending.push((nested, depth + 1));
            }
        }
    }
    scopes
}

fn first_declared_value<'a>(
    scopes: &[&'a serde_json::Map<String, Value>],
    keys: &[&str],
) -> Option<&'a Value> {
    scopes.iter().find_map(|scope| {
        keys.iter()
            .find_map(|key| scope.get(*key))
            .filter(|value| !value.is_null())
    })
}

fn lookup_bool(
    scopes: &[&serde_json::Map<String, Value>],
    keys: &[&str],
) -> Result<Option<bool>, ()> {
    let mut found = None;
    for scope in scopes {
        for key in keys {
            let Some(value) = scope.get(*key) else {
                continue;
            };
            let Some(value) = value.as_bool() else {
                return Err(());
            };
            if found.is_some_and(|previous| previous != value) {
                return Err(());
            }
            found = Some(value);
        }
    }
    Ok(found)
}

fn collect_string_array_declaration(
    scopes: &[&serde_json::Map<String, Value>],
    keys: &[&str],
) -> Result<Option<Vec<String>>, ()> {
    let mut found: Option<Vec<String>> = None;
    for scope in scopes {
        for key in keys {
            let Some(value) = scope.get(*key) else {
                continue;
            };
            if value.is_null() {
                continue;
            }
            let Some(items) = value.as_array() else {
                return Err(());
            };
            let mut normalized = Vec::with_capacity(items.len());
            for item in items {
                let Some(item) = item.as_str().map(str::trim).filter(|item| !item.is_empty())
                else {
                    return Err(());
                };
                normalized.push(item.to_ascii_lowercase());
            }
            normalized.dedup();
            if found.as_ref().is_some_and(|previous| {
                let mut previous = previous.clone();
                previous.sort();
                previous.dedup();
                let mut current = normalized.clone();
                current.sort();
                current.dedup();
                previous != current
            }) {
                return Err(());
            }
            found = Some(normalized);
        }
    }
    Ok(found)
}

fn collect_effort_declaration(
    scopes: &[&serde_json::Map<String, Value>],
) -> Result<Option<Vec<String>>, ()> {
    let keys = [
        "supported_efforts",
        "supportedEfforts",
        "supported_levels",
        "supportedLevels",
        "efforts",
        "supported_reasoning_levels",
        "supportedReasoningLevels",
        "supported_reasoning_efforts",
        "supportedReasoningEfforts",
    ];
    let mut found = None;
    for scope in scopes {
        for key in keys {
            let Some(value) = scope.get(key) else {
                continue;
            };
            if value.is_null() {
                continue;
            }
            let Some(items) = value.as_array() else {
                return Err(());
            };
            let mut normalized = Vec::with_capacity(items.len());
            for item in items {
                let value = if let Some(value) = item.as_str() {
                    let value = value.trim();
                    if value.is_empty() {
                        return Err(());
                    }
                    value.to_ascii_lowercase()
                } else {
                    let object = item.as_object().ok_or(())?;
                    let mut declared = None;
                    for field in ["effort", "reasoning_effort", "reasoningEffort"] {
                        let Some(value) = object.get(field) else {
                            continue;
                        };
                        let value = value.as_str().ok_or(())?.trim();
                        if value.is_empty() {
                            return Err(());
                        }
                        let value = value.to_ascii_lowercase();
                        if declared.as_ref().is_some_and(|previous| previous != &value) {
                            return Err(());
                        }
                        declared = Some(value);
                    }
                    declared.ok_or(())?
                };
                normalized.push(value);
            }
            if found.as_ref().is_some_and(|previous: &Vec<String>| {
                let mut previous = previous.clone();
                previous.sort();
                previous.dedup();
                let mut current = normalized.clone();
                current.sort();
                current.dedup();
                previous != current
            }) {
                return Err(());
            }
            normalized.dedup();
            found = Some(normalized);
        }
    }
    Ok(found)
}

fn has_null_effort_declaration(scopes: &[&serde_json::Map<String, Value>]) -> bool {
    [
        "supported_efforts",
        "supportedEfforts",
        "supported_levels",
        "supportedLevels",
        "efforts",
        "supported_reasoning_levels",
        "supportedReasoningLevels",
        "supported_reasoning_efforts",
        "supportedReasoningEfforts",
    ]
    .iter()
    .any(|key| {
        scopes
            .iter()
            .any(|scope| scope.get(*key).is_some_and(Value::is_null))
    })
}

fn has_declared_key(scopes: &[&serde_json::Map<String, Value>], keys: &[&str]) -> bool {
    scopes
        .iter()
        .any(|scope| keys.iter().any(|key| scope.contains_key(*key)))
}

fn lookup_wire_string(
    scopes: &[&serde_json::Map<String, Value>],
    keys: &[&str],
) -> Option<Option<String>> {
    let mut found = None;
    for scope in scopes {
        for key in keys {
            let Some(value) = scope.get(*key) else {
                continue;
            };
            let value = value.as_str()?.trim().to_ascii_lowercase();
            if value.is_empty() || !valid_wire_value(key, &value) {
                return None;
            }
            if found
                .as_ref()
                .is_some_and(|previous: &String| previous != &value)
            {
                return None;
            }
            found = Some(value);
        }
    }
    Some(found)
}

fn lookup_effort_string(
    scopes: &[&serde_json::Map<String, Value>],
    keys: &[&str],
) -> Option<Option<String>> {
    let mut found = None;
    for scope in scopes {
        for key in keys {
            let Some(value) = scope.get(*key) else {
                continue;
            };
            let value = value.as_str()?.trim().to_ascii_lowercase();
            if value.is_empty()
                || !matches!(
                    value.as_str(),
                    "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
                )
            {
                return None;
            }
            if found
                .as_ref()
                .is_some_and(|previous: &String| previous != &value)
            {
                return None;
            }
            found = Some(value);
        }
    }
    Some(found)
}

fn valid_wire_value(key: &str, value: &str) -> bool {
    if key.to_ascii_lowercase().contains("format") {
        matches!(
            value,
            "auto"
                | "text"
                | "summary"
                | "object"
                | "reasoning_object"
                | "string"
                | "boolean"
                | "none"
                | "budget"
        )
    } else {
        matches!(
            value,
            "reasoning"
                | "reasoning.effort"
                | "reasoning_effort"
                | "enable_thinking"
                | "thinking"
                | "thinking_budget"
                | "max_tokens"
                | "reasoning.max_tokens"
                | "none"
        )
    }
}

fn parse_canonical_provider_reasoning(value: &Value) -> Option<CodexModelReasoningCapability> {
    let wrapper = serde_json::json!({ "reasoning": value });
    let capability =
        crate::proxy::providers::codex_reasoning::reasoning_capability_from_model_entry(&wrapper)?;
    let mut capability = capability.complete_identity_effort_map_for_read();
    capability.source = Some("detection".to_string());
    capability.confidence = Some(CapabilityConfidence::Verified);
    capability.fetched_at = None;
    capability.provider_key = None;
    capability.model_revision = None;
    capability.codex_ultra_orchestration = None;
    capability.validate().ok()?;
    Some(capability)
}

fn looks_like_canonical_reasoning(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    [
        "schemaVersion",
        "schema_version",
        "supportStatus",
        "support_status",
        "controlKind",
        "control_kind",
        "disableAllowed",
        "disable_allowed",
        "upstream",
    ]
    .iter()
    .any(|key| object.contains_key(*key))
}

fn build_boolean_or_unknown_capability(
    supported: bool,
    mandatory: Option<bool>,
) -> Option<CodexModelReasoningCapability> {
    let capability = if supported {
        CodexModelReasoningCapability {
            schema_version: Some(2),
            support_status: Some(ReasoningSupportStatus::ConfirmedSupported),
            control_kind: Some(ReasoningControlKind::None),
            supported: None,
            supported_efforts: Vec::new(),
            default_effort: None,
            disable_allowed: false,
            upstream: CodexModelReasoningUpstream {
                format: "none".to_string(),
                parameter: "reasoning".to_string(),
                effort_map: Default::default(),
            },
            output_format: None,
            source: Some("detection".to_string()),
            confidence: Some(CapabilityConfidence::Verified),
            fetched_at: None,
            provider_key: None,
            model_revision: None,
            evidence_scope: None,
            codex_ultra_orchestration: None,
        }
    } else {
        CodexModelReasoningCapability {
            schema_version: Some(2),
            support_status: Some(ReasoningSupportStatus::ConfirmedUnsupported),
            control_kind: Some(ReasoningControlKind::None),
            supported: None,
            supported_efforts: Vec::new(),
            default_effort: None,
            disable_allowed: false,
            upstream: CodexModelReasoningUpstream {
                format: "none".to_string(),
                parameter: "reasoning".to_string(),
                effort_map: Default::default(),
            },
            output_format: None,
            source: Some("detection".to_string()),
            confidence: Some(CapabilityConfidence::Authoritative),
            fetched_at: None,
            provider_key: None,
            model_revision: None,
            evidence_scope: None,
            codex_ultra_orchestration: None,
        }
    };
    if mandatory == Some(true) && supported {
        return None;
    }
    capability.validate().ok().map(|_| capability)
}

fn build_reasoning_capability(
    mut efforts: Vec<String>,
    scopes: &[&serde_json::Map<String, Value>],
    openrouter_contract: bool,
    format: Option<String>,
    parameter: Option<String>,
) -> Option<CodexModelReasoningCapability> {
    efforts.dedup();
    let codex_ultra_enabled = efforts.iter().any(|effort| effort == "ultra");
    if codex_ultra_enabled && !efforts.iter().any(|effort| effort == "max") {
        return None;
    }
    efforts.retain(|effort| effort != "ultra");
    let mandatory = lookup_bool(scopes, &["mandatory", "reasoningMandatory"])
        .ok()?
        .unwrap_or(false);
    let default_effort = lookup_effort_string(
        scopes,
        &[
            "default_effort",
            "defaultEffort",
            "default_level",
            "defaultLevel",
            "default_reasoning_level",
            "defaultReasoningLevel",
            "default_reasoning_effort",
            "defaultReasoningEffort",
        ],
    )?;
    if mandatory && default_effort.as_deref() == Some("none") {
        return None;
    }
    let default_effort = match default_effort
        .map(|effort| {
            if effort == "ultra" {
                "max".to_string()
            } else {
                effort
            }
        })
        // OpenRouter's `default_effort: "none"` means reasoning is
        // disabled by default; it is not a Codex selector declaration.
        .filter(|effort| effort != "none" || !openrouter_contract)
    {
        Some(value) if efforts.contains(&value) => Some(value),
        Some(_) => return None,
        None => None,
    };
    let supports_max_tokens = lookup_bool(scopes, &["supports_max_tokens", "supportsMaxTokens"])
        .ok()?
        .unwrap_or(false);
    let default_enabled = lookup_bool(scopes, &["default_enabled", "defaultEnabled"]).ok()?;
    if mandatory
        && (efforts.iter().any(|effort| effort == "none") || default_enabled == Some(false))
    {
        return None;
    }
    let disable_allowed = lookup_bool(scopes, &["disable_allowed", "disableAllowed"])
        .ok()?
        .unwrap_or(!mandatory || efforts.iter().any(|effort| effort == "none"));
    if mandatory && disable_allowed {
        return None;
    }
    let format = format.unwrap_or_else(|| {
        if openrouter_contract {
            "reasoning_object".to_string()
        } else {
            "string".to_string()
        }
    });
    let parameter = parameter.unwrap_or_else(|| {
        if format == "reasoning_object" || format == "object" {
            "reasoning.effort".to_string()
        } else {
            "reasoning_effort".to_string()
        }
    });
    let mut effort_map = efforts
        .iter()
        .filter(|effort| effort.as_str() != "none")
        .map(|effort| (effort.clone(), effort.clone()))
        .collect::<std::collections::HashMap<_, _>>();
    let control_kind = if !efforts
        .iter()
        .filter(|effort| effort.as_str() != "none")
        .collect::<Vec<_>>()
        .is_empty()
    {
        ReasoningControlKind::Graded
    } else if supports_max_tokens {
        ReasoningControlKind::Budget
    } else {
        ReasoningControlKind::None
    };
    if efforts.iter().any(|effort| effort == "none") {
        effort_map.remove("none");
    }
    let capability = CodexModelReasoningCapability {
        schema_version: Some(2),
        support_status: Some(ReasoningSupportStatus::ConfirmedSupported),
        control_kind: Some(control_kind),
        supported: None,
        supported_efforts: efforts,
        default_effort,
        disable_allowed,
        upstream: CodexModelReasoningUpstream {
            format: if format == "object" {
                "reasoning_object".to_string()
            } else {
                format
            },
            parameter,
            effort_map,
        },
        output_format: lookup_wire_string(scopes, &["output_format", "outputFormat"])?,
        source: Some("detection".to_string()),
        confidence: Some(CapabilityConfidence::Verified),
        fetched_at: None,
        provider_key: None,
        model_revision: None,
        evidence_scope: None,
        codex_ultra_orchestration: codex_ultra_enabled.then_some(
            crate::proxy::providers::codex_reasoning::CodexUltraOrchestrationCapability {
                enabled: true,
                provider_effort: None,
            },
        ),
    };
    capability.validate().ok().map(|_| capability)
}

/// 归一化 OpenRouter models 端点：base 已含 `/api/v1` 时直接拼 `/models`。
fn openrouter_models_url(base: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    if trimmed.to_ascii_lowercase().ends_with("/api/v1") {
        format!("{trimmed}/models")
    } else if trimmed.to_ascii_lowercase().ends_with("/api") {
        format!("{trimmed}/v1/models")
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
    let Some(wire_model) = reasoning_wire_model_for_settings(&provider.settings_config, model)
    else {
        return DiscoveryOutcome::NotAdvertised;
    };
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
            log::debug!(
                "vllm /version unreachable: {}",
                discovery_error_class(&error)
            );
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
                            .is_some_and(|id| id.trim().eq_ignore_ascii_case(&wire_model))
                    })
                })
            })
            .unwrap_or(false),
        Ok(response) => {
            log::debug!("vllm /v1/models failed: {}", response.status());
            return DiscoveryOutcome::Unavailable;
        }
        Err(error) => {
            log::debug!(
                "vllm /v1/models unreachable: {}",
                discovery_error_class(&error)
            );
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

    // vLLM 不声明逐模型 effort：reasoning 保持 None，resolver 落到能力库。
    discovery_snapshot(provider, model, "vllm_server", None)
        .map(DiscoveryOutcome::Found)
        .unwrap_or(DiscoveryOutcome::Invalid)
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

    #[test]
    fn detect_platform_openrouter_by_name_or_url() {
        assert_eq!(
            detect_platform(&provider("OpenRouter", "https://api.deepseek.com")),
            Some("deepseek")
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
        assert_eq!(
            detect_platform(&provider("Sublyx", "https://gateway.example/v1")),
            Some("sublyx")
        );
    }

    #[test]
    fn detect_platform_from_settings_matches_persisted_provider_detection() {
        assert_eq!(
            detect_platform_from_settings(&json!({
                "providerName": "OpenRouter",
                "base_url": "https://openrouter.ai/api/v1"
            })),
            Some("openrouter")
        );
        assert_eq!(
            detect_platform_from_settings(&json!({
                "base_url": "http://vllm.local:8000/v1"
            })),
            Some("vllm")
        );
        assert_eq!(
            detect_platform_from_settings(&json!({
                "base_url": "https://example.test/v1"
            })),
            None
        );
        assert_eq!(
            detect_platform_from_settings(&json!({
                "config": r#"
                    model_provider = "custom"
                    [model_providers.custom]
                    name = "openrouter"
                    base_url = "https://openrouter.ai/api/v1"
                "#
            })),
            Some("openrouter")
        );
        assert_eq!(
            detect_platform(&provider(
                "Saved custom provider",
                "https://gateway.example/v1"
            )),
            None
        );
        let persisted = Provider {
            settings_config: json!({
                "config": r#"
                    model_provider = "custom"
                    [model_providers.custom]
                    name = "openrouter"
                    base_url = "https://openrouter.ai/api/v1"
                "#
            }),
            ..provider("Saved custom provider", "https://gateway.example/v1")
        };
        assert_eq!(detect_platform(&persisted), Some("openrouter"));
    }

    #[test]
    fn active_gateway_transport_overrides_stale_provider_labels() {
        for (active, stale, base_url) in [
            ("openrouter", "Sublyx", "https://openrouter.ai/api/v1"),
            ("sublyx", "OpenRouter", "https://api.sublyx.org/v1"),
        ] {
            let mut saved = provider(stale, "");
            saved.id = format!("{stale}-saved-id");
            saved.settings_config = json!({
                "providerName": stale,
                "config": format!(
                    "model_provider = \"{active}\"\n[model_providers.{active}]\nbase_url = \"{base_url}\"\n"
                ),
            });
            assert_eq!(detect_platform(&saved), Some(active));
            assert_eq!(
                detect_platform_from_settings(&saved.settings_config),
                Some(active)
            );

            // The top-level URL is the actual request destination when both
            // forms exist, not the stale selected TOML gateway declaration.
            saved.settings_config["base_url"] = json!("  ");
            saved.settings_config["baseURL"] = json!(base_url);
            assert_eq!(super::base_url(&saved).as_deref(), Some(base_url));
            saved.settings_config["config"] = json!(format!(
                "model_provider = \"{stale}\"\n[model_providers.{stale}]\nbase_url = \"https://{stale}.example/v1\"\n"
            ));
            assert_eq!(detect_platform(&saved), Some(active));
            assert_eq!(
                detect_platform_from_settings(&saved.settings_config),
                Some(active)
            );
        }
    }

    #[test]
    fn active_toml_gateway_key_overrides_stale_provider_labels() {
        for (active, stale) in [("openrouter", "Sublyx"), ("sublyx", "OpenRouter")] {
            let mut saved = provider(stale, "");
            saved.settings_config = json!({
                "providerName": stale,
                "config": format!(
                    "model_provider = \"{active}\"\n[model_providers.{active}]\nbase_url = \"https://gateway.example/v1\"\n"
                ),
            });
            assert_eq!(detect_platform(&saved), Some(active));
            assert_eq!(
                detect_platform_from_settings(&saved.settings_config),
                Some(active)
            );
        }
    }

    #[test]
    fn projected_target_identity_overrides_synthetic_router_labels() {
        for (active, wrapper) in [
            ("openrouter", "Sublyx router"),
            ("sublyx", "OpenRouter router"),
        ] {
            let mut routed = provider(wrapper, "https://gateway.example/v1");
            routed.id = format!("{wrapper}-synthetic-id");
            routed.settings_config["codexResolvedTargetProviderId"] =
                json!(format!("{active}-target"));
            routed.settings_config["codexResolvedTargetProviderName"] = json!(active);
            assert_eq!(detect_platform(&routed), Some(active));
            assert_eq!(
                detect_platform_from_settings(&routed.settings_config),
                Some(active)
            );
        }

        let mut unknown_target = provider("OpenRouter wrapper", "https://gateway.example/v1");
        unknown_target.settings_config["codexResolvedTargetProviderId"] = json!("custom-target");
        assert_eq!(detect_platform(&unknown_target), None);
    }

    #[test]
    fn known_transport_hosts_override_every_stale_gateway_identity() {
        for (platform, endpoint) in [
            ("openrouter", "https://openrouter.ai/api/v1"),
            ("openrouter", "https://api.openrouter.ai/v1"),
            ("openrouter", "https://OPENROUTER.AI.:443/api/v1"),
            ("sublyx", "https://api.sublyx.org/v1"),
            ("sublyx", "https://sublyx.org/v1"),
            ("sublyx", "https://region.api.sublyx.org/v1"),
            ("vllm", "http://vllm.local:8000/v1"),
            ("vllm", "http://vllm-roglinux:8000/v1"),
            ("deepseek", "https://api.deepseek.com/v1"),
            ("zhipu", "https://api.z.ai/api/paas/v4"),
            ("zhipu", "https://open.bigmodel.cn/api/paas/v4"),
            (
                "dashscope",
                "https://dashscope.aliyuncs.com/compatible-mode/v1",
            ),
            (
                "dashscope",
                "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
            ),
            ("dashscope", "https://example.maas.aliyuncs.com/v1"),
        ] {
            for stale in ["openrouter", "sublyx", "vllm"] {
                let mut saved = provider(stale, endpoint);
                saved.id = format!("{stale}-stale-id");
                saved.settings_config["providerName"] = json!(stale);
                saved.settings_config["codexResolvedTargetProviderId"] =
                    json!(format!("{stale}-stale-target"));
                saved.settings_config["codexResolvedTargetProviderName"] = json!(stale);
                // The actual top-level transport wins even a selected table
                // which still points at a different known gateway endpoint.
                saved.settings_config["config"] = json!(format!(
                    "model_provider = \"{stale}\"\n[model_providers.{stale}]\nbase_url = \"https://openrouter.ai/api/v1\"\n"
                ));
                assert_eq!(
                    detect_platform(&saved),
                    Some(platform),
                    "{platform} transport vs {stale} stale identity"
                );
                assert_eq!(
                    detect_platform_from_settings(&saved.settings_config),
                    Some(platform),
                    "{platform} draft vs {stale} stale identity"
                );

                // Without a top-level override, the selected table's URL is
                // authoritative even when its key and name are stale.
                saved
                    .settings_config
                    .as_object_mut()
                    .unwrap()
                    .remove("base_url");
                saved.settings_config["config"] = json!(format!(
                    "model_provider = \"{stale}\"\n[model_providers.{stale}]\nname = \"{stale}\"\nbase_url = \"{endpoint}\"\n"
                ));
                assert_eq!(
                    detect_platform(&saved),
                    Some(platform),
                    "{platform} selected transport vs {stale} stale identity"
                );
                assert_eq!(
                    detect_platform_from_settings(&saved.settings_config),
                    Some(platform)
                );
            }

            // A path/query containing another platform is data, not identity.
            let endpoint = format!("{endpoint}/openrouter/sublyx/vllm?provider=openrouter");
            assert_eq!(
                detect_platform(&provider("Gateway", &endpoint)),
                Some(platform)
            );
        }
    }

    #[test]
    fn platform_transport_detection_rejects_url_substring_spoofing() {
        for endpoint in [
            "https://openrouter.ai.example/v1",
            "https://notopenrouter.ai/v1",
            "https://.openrouter.ai/v1",
            "https://gateway.example/openrouter",
            "https://gateway.example/v1?provider=openrouter",
            "https://openrouter.ai@gateway.example/v1",
            "https://sublyx.org.example/v1",
            "https://notsublyx.org/v1",
            "https://.sublyx.org/v1",
            "https://api.sublyx.com/v1",
            "https://gateway.example/sublyx",
            "https://gateway.example/v1?provider=sublyx",
            "https://sublyx.org@gateway.example/v1",
            "https://vllmish.example/v1",
            "https://notvllm.example/v1",
            "https://vllm-.example/v1",
            "https://gateway.example/vllm",
            "https://gateway.example/v1?provider=vllm",
            "https://api.deepseek.com.example/v1",
            "https://api.z.ai.example/v1",
            "https://open.bigmodel.cn.example/v1",
            "https://dashscope.aliyuncs.com.example/v1",
            "https://example.maas.aliyuncs.com.evil/v1",
            "https://maas.aliyuncs.com/v1",
            "https://.maas.aliyuncs.com/v1",
            "ftp://openrouter.ai/v1",
            "ftp://api.sublyx.org/v1",
            "ftp://vllm.local/v1",
            "ftp://api.deepseek.com/v1",
            "ftp://api.z.ai/v1",
            "file://dashscope.aliyuncs.com/v1",
        ] {
            let saved = provider("Gateway", endpoint);
            assert_eq!(detect_platform(&saved), None, "{endpoint}");
            assert_eq!(
                detect_platform_from_settings(&saved.settings_config),
                None,
                "{endpoint}"
            );
        }
    }

    #[test]
    fn custom_transport_preserves_only_explicit_supported_label_fallbacks() {
        for (name, expected) in [
            ("OpenRouter custom", Some("openrouter")),
            ("Sublyx custom", Some("sublyx")),
            ("vLLM custom", Some("vllm")),
            ("DeepSeek custom", None),
            ("Zhipu custom", None),
            ("DashScope custom", None),
        ] {
            let mut saved = provider(name, "https://gateway.example/v1");
            saved.settings_config["providerName"] = json!(name);
            assert_eq!(detect_platform(&saved), expected, "{name}");
            assert_eq!(
                detect_platform_from_settings(&saved.settings_config),
                expected,
                "{name}"
            );
        }
        let mut unknown = provider("Gateway", "https://gateway.example/v1");
        unknown.settings_config["model"] = json!("openrouter/sublyx-vllm-deepseek-zhipu-dashscope");
        assert_eq!(
            detect_platform(&unknown),
            None,
            "model names never identify transport"
        );
    }

    #[test]
    fn provider_platform_identity_uses_target_markers_and_first_nonblank_labels() {
        let mut saved = provider("Display-only wrapper", "https://gateway.example/v1");
        saved.settings_config["providerName"] = json!("  ");
        saved.settings_config["provider_name"] = json!(" Sublyx custom ");
        assert_eq!(provider_platform_identity(&saved).0, "Sublyx custom");
        assert_eq!(detect_platform(&saved), Some("sublyx"));

        saved.settings_config["codexResolvedTargetProviderName"] = json!("OpenRouter target");
        saved.settings_config["codexResolvedTargetProviderId"] = json!("original-target-id");
        assert_eq!(
            provider_platform_identity(&saved),
            ("OpenRouter target", "original-target-id")
        );
        assert_eq!(detect_platform(&saved), Some("openrouter"));

        for marker in [json!(null), json!(""), json!("  ")] {
            saved.settings_config["codexResolvedTargetProviderName"] = marker.clone();
            saved.settings_config["codexResolvedTargetProviderId"] = marker;
            assert_eq!(provider_platform_identity(&saved), ("", ""));
            assert_eq!(detect_platform(&saved), None);
        }
        // The original name/key remains a supported explicit fallback for
        // historical or custom domains, but never hostname-only evidence.
        let mut custom = provider("Sublyx custom", "https://api.sublyx.com/v1");
        assert_eq!(detect_platform(&custom), Some("sublyx"));
        custom.settings_config = json!({"config": r#"
            model_provider = "custom"
            [model_providers.custom]
            name = "  "
            providerName = "Sublyx custom"
            base_url = "https://gateway.example/v1"
        "#});
        assert_eq!(detect_platform(&custom), Some("sublyx"));
        assert_eq!(
            detect_platform_from_settings(&custom.settings_config),
            Some("sublyx")
        );
    }

    #[test]
    fn upstream_metadata_active_toml_provider_owns_platform() {
        for selection in [
            "model_provider = \"active\"\n",
            "model_provider = \"missing\"\n",
            "",
        ] {
            let config = format!("{selection}[model_providers.active]\nbase_url = \"https://gateway.example/v1\"\n[model_providers.inactive]\nbase_url = \"https://api.deepseek.com/v1\"\n");
            let mut draft = provider("Gateway", "");
            draft.settings_config = json!({"config": config});
            assert_eq!(
                detect_platform(&draft),
                None,
                "inactive provider metadata is never active vendor identity"
            );
            assert_eq!(detect_platform_from_settings(&draft.settings_config), None);
        }
    }

    #[test]
    fn upstream_metadata_matches_exact_zhipu_and_dashscope_hosts() {
        for (name, base_url, expected) in [
            ("Z.AI", "https://api.z.ai/api/paas/v4", Some("zhipu")),
            (
                "BigModel",
                "https://open.bigmodel.cn/api/paas/v4",
                Some("zhipu"),
            ),
            (
                "DashScope",
                "https://dashscope.aliyuncs.com/compatible-mode/v1",
                Some("dashscope"),
            ),
            (
                "DashScope Intl",
                "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
                Some("dashscope"),
            ),
            (
                "DashScope MaaS",
                "https://model-123.maas.aliyuncs.com/v1",
                Some("dashscope"),
            ),
            ("Lookalike", "https://api.z.ai.example/v1", None),
            ("Gateway", "https://dashscope.aliyuncs.com.example/v1", None),
        ] {
            assert_eq!(
                detect_platform(&provider(name, base_url)),
                expected,
                "unexpected platform for {base_url}"
            );
        }
    }
    #[test]
    fn upstream_metadata_deepseek_platform_requires_exact_official_host() {
        assert_eq!(
            detect_platform(&provider(
                "DeepSeek Official",
                "https://api.deepseek.com/v1"
            )),
            Some("deepseek")
        );
        assert_eq!(
            detect_platform(&provider("DeepSeek Gateway", "https://gateway.example/v1")),
            None
        );
        assert_eq!(
            detect_platform(&provider("Gateway", "https://api.deepseek.com.example/v1")),
            None
        );
        let toml_provider = provider("Official", "");
        let mut toml_provider = toml_provider;
        toml_provider.settings_config = serde_json::json!({"config": "model_provider = \"deepseek\"\n[model_providers.deepseek]\nbase_url = \"https://api.deepseek.com/v1\"\n"});
        assert_eq!(detect_platform(&toml_provider), Some("deepseek"));
    }

    #[test]
    fn discovery_error_diagnostics_exclude_credential_urls_and_provider_context() {
        let unsafe_url =
            "https://redacted-user:redacted-secret@example.invalid:invalid/v1?api_key=redacted-key";
        let error = reqwest::Client::new()
            .get(unsafe_url)
            .build()
            .expect_err("invalid port produces a request-builder failure");
        let diagnostics = format!(
            "openrouter discovery unreachable: {}",
            discovery_error_class(&error)
        );
        assert_eq!(
            diagnostics,
            "openrouter discovery unreachable: request-builder"
        );
        for sensitive in [
            unsafe_url,
            "https://",
            "redacted-user",
            "redacted-secret",
            "example.invalid",
            "api_key",
            "redacted-key",
        ] {
            assert!(!diagnostics.contains(sensitive));
        }
    }

    #[test]
    fn discovery_snapshot_uses_original_target_wire_model_and_current_transport_scope() {
        let mut routed = provider("OpenRouter wrapper", "https://openrouter.ai/api/v1");
        routed.id = "router::route::synthetic".to_string();
        routed.settings_config["codexResolvedTargetProviderId"] = json!("actual-target");
        routed.settings_config["codexResolvedTargetProviderName"] = json!("Actual gateway");
        routed.settings_config["modelCatalog"] = json!({"models": [{
            "model": "public-model",
            "aliases": ["picker-alias"],
            "upstreamModel": "Provider/Native-Model",
        }]});
        let snapshot = discovery_snapshot(&routed, "picker-alias", "openrouter_api", None)
            .expect("routable alias has a scoped snapshot");
        assert_eq!(snapshot.provider_key, "actual-target");
        assert_eq!(snapshot.model, "Provider/Native-Model");
        assert_eq!(
            snapshot.evidence_scope,
            reasoning_evidence_scope_for_settings(&routed.settings_config, "public-model")
        );
        let encoded = serde_json::to_string(&snapshot.evidence_scope).unwrap();
        assert!(
            !encoded.contains("https://"),
            "scope never persists a raw endpoint"
        );
        assert!(
            !encoded.contains("openrouter.ai"),
            "scope fingerprints its transport"
        );

        routed.settings_config["base_url"] = json!("https://api.deepseek.com/v1");
        let switched = discovery_snapshot(&routed, "picker-alias", "provider_api", None).unwrap();
        assert_eq!(switched.provider_key, snapshot.provider_key);
        assert_eq!(switched.model, snapshot.model);
        assert_ne!(
            switched.evidence_scope, snapshot.evidence_scope,
            "changing transport invalidates prior evidence even with the same target and model"
        );

        routed.settings_config["modelCatalog"]["models"][0]["enabled"] = json!(false);
        assert!(discovery_snapshot(&routed, "picker-alias", "provider_api", None).is_none());
        routed.settings_config["modelCatalog"]["models"] = json!([
            {"model": "first", "aliases": ["ambiguous"], "upstreamModel": "one"},
            {"model": "second", "aliases": ["ambiguous"], "upstreamModel": "two"},
        ]);
        assert!(discovery_snapshot(&routed, "ambiguous", "provider_api", None).is_none());
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
        assert_eq!(
            openrouter_models_url("https://openrouter.ai/api"),
            "https://openrouter.ai/api/v1/models"
        );
    }

    #[test]
    fn root_codex_toml_transport_keeps_runtime_platform_and_evidence_scope_in_parity() {
        for (config, expected) in [
            (
                r#"model = "wire-model"
base_url = "https://api.sublyx.org/v1"
wire_api = "responses""#,
                "https://api.sublyx.org/v1",
            ),
            (
                r#"model_provider = "missing"
base_url = "https://api.sublyx.org/v1"
[model_providers.inactive]
base_url = "https://openrouter.ai/api/v1""#,
                "https://api.sublyx.org/v1",
            ),
            (
                r#"openai_base_url = "https://api.sublyx.org/v1"
base_url = "https://api.deepseek.com/v1""#,
                "https://api.sublyx.org/v1",
            ),
            (
                r#"model_provider = "openai"
openai_base_url = "https://api.sublyx.org/v1"
base_url = "https://api.deepseek.com/v1"
[model_providers.openai]
base_url = "https://openrouter.ai/api/v1""#,
                "https://api.sublyx.org/v1",
            ),
            (
                r#"model_provider = "custom"
openai_base_url = "https://openrouter.ai/api/v1"
base_url = "https://api.deepseek.com/v1"
[model_providers.custom]
base_url = "https://api.sublyx.org/v1""#,
                "https://api.sublyx.org/v1",
            ),
        ] {
            let mut saved = provider("OpenRouter stale label", "");
            saved.settings_config = json!({"config": config});
            assert_eq!(
                crate::codex_config::extract_codex_base_url(config).as_deref(),
                Some(expected),
                "fixture describes the canonical runtime's transport"
            );
            assert_eq!(
                base_url_from_settings(&saved.settings_config).as_deref(),
                Some(expected)
            );
            assert_eq!(detect_platform(&saved), Some("sublyx"));
            assert_eq!(
                detect_platform_from_settings(&saved.settings_config),
                Some("sublyx")
            );
            assert_eq!(
                reasoning_evidence_scope_for_settings(&saved.settings_config, "wire-model"),
                crate::reasoning_capabilities::reasoning_evidence_scope(expected, "wire-model"),
                "root TOML must not discard valid persisted/API evidence"
            );
        }
    }

    #[test]
    fn codex_toml_transport_uses_first_nonblank_alias_and_root_fallback() {
        for config in [
            r#"base_url = 42
baseURL = " "
baseUrl = "https://api.sublyx.org/v1""#,
            r#"model_provider = "openai"
openai_base_url = " "
base_url = "https://api.sublyx.org/v1""#,
            r#"model_provider = "custom"
base_url = "https://api.sublyx.org/v1"
[model_providers.custom]
base_url = false
baseURL = " ""#,
            r#"model_provider = "custom"
base_url = "https://api.deepseek.com/v1"
[model_providers.custom]
base_url = false
baseURL = " "
baseUrl = "https://api.sublyx.org/v1""#,
        ] {
            let settings = json!({"config": config});
            assert_eq!(
                base_url_from_settings(&settings).as_deref(),
                Some("https://api.sublyx.org/v1")
            );
            assert_eq!(detect_platform_from_settings(&settings), Some("sublyx"));
            assert!(reasoning_evidence_scope_for_settings(&settings, "wire-model").is_some());
        }
    }

    #[test]
    fn discovery_reads_only_the_selected_codex_toml_provider_base() {
        let mut provider = provider("Saved OpenRouter", "");
        provider.settings_config = json!({
            "config": r#"
                model_provider = "selected"
                [model_providers.unselected]
                base_url = "https://unselected.test/v1"
                [model_providers.selected]
                base_url = "https://openrouter.ai/api/v1"
            "#
        });
        assert_eq!(
            base_url(&provider).as_deref(),
            Some("https://openrouter.ai/api/v1")
        );
        provider.settings_config["baseUrl"] = json!("https://explicit.test/v1");
        assert_eq!(
            base_url(&provider).as_deref(),
            Some("https://explicit.test/v1")
        );
        provider.settings_config = json!({
            "config": r#"
                model_provider = "missing"
                [model_providers.unselected]
                base_url = "https://unselected.test/v1"
            "#
        });
        assert!(base_url(&provider).is_none());
    }

    #[test]
    fn openrouter_catalog_and_detection_paths_share_the_same_capability_fingerprint() {
        use crate::proxy::providers::codex_reasoning::capability_fingerprint;
        use crate::reasoning_capabilities::snapshot_to_capability;

        for entry in [
            json!({
                "id": "provider/native-max",
                "supported_parameters": ["reasoning", "reasoning_effort"],
                "reasoning": {
                    "supported_efforts": ["max", "xhigh", "high", "medium", "low"],
                    "default_effort": "high",
                    "mandatory": true,
                },
            }),
            json!({
                "id": "provider/explicit-output-format",
                "supported_parameters": ["reasoning"],
                "reasoning": {
                    "supported_efforts": ["high", "low"],
                    "default_effort": "low",
                    "output_format": "auto",
                    "mandatory": false,
                },
            }),
            json!({
                "id": "provider/budget-only",
                "supported_parameters": ["reasoning"],
                "reasoning": {
                    "supports_max_tokens": true,
                    "mandatory": false,
                    "default_enabled": true,
                },
            }),
        ] {
            let direct = openrouter_reasoning_capability_from_model_entry(&entry)
                .expect("direct catalog capability");
            let snapshot = ProviderCapabilitySnapshot {
                provider_key: "openrouter-test".to_string(),
                model: entry["id"].as_str().unwrap().to_string(),
                fetched_at: 1,
                source: "openrouter_api".to_string(),
                evidence_scope: None,
                reasoning: Some(openrouter_reasoning_snapshot(&entry).expect("reasoning snapshot")),
            };
            let detected = snapshot_to_capability(&snapshot).expect("detected capability");
            assert_eq!(direct.output_format, detected.output_format, "{entry}");
            assert_eq!(
                capability_fingerprint(&direct),
                capability_fingerprint(&detected),
                "{entry}"
            );
        }
    }

    #[test]
    fn openrouter_reasoning_metadata_omitted_efforts_do_not_invent_a_selector() {
        let snapshot = openrouter_reasoning_snapshot(&json!({
            "reasoning": {"mandatory": false},
            "supported_parameters": ["reasoning", "include_reasoning"]
        }))
        .expect("reasoning metadata");
        assert!(snapshot.supported_efforts.is_empty());
        assert_eq!(snapshot.default_effort, None);
        assert_eq!(
            snapshot.upstream_format.as_deref(),
            Some("reasoning_object")
        );
        assert_eq!(
            snapshot.upstream_parameter.as_deref(),
            Some("reasoning.effort")
        );
    }

    #[test]
    fn openrouter_reasoning_metadata_uses_native_object_with_effort_alias() {
        let snapshot = openrouter_reasoning_snapshot(&json!({
            "reasoning": {
                "supported_efforts": ["xhigh", "high"],
                "default_effort": "high",
                "mandatory": true,
            },
            "supported_parameters": [
                "reasoning",
                "reasoning_effort",
                "include_reasoning"
            ]
        }))
        .expect("reasoning metadata");
        assert_eq!(
            snapshot.supported_efforts,
            vec!["xhigh".to_string(), "high".to_string()]
        );
        assert_eq!(snapshot.default_effort.as_deref(), Some("high"));
        assert!(snapshot.mandatory);
        assert_eq!(
            snapshot.upstream_format.as_deref(),
            Some("reasoning_object")
        );
        assert_eq!(
            snapshot.upstream_parameter.as_deref(),
            Some("reasoning.effort")
        );
    }

    #[test]
    fn openrouter_reasoning_metadata_rejects_malformed_efforts_and_wire_aliases() {
        for entry in [
            json!({
                "reasoning": {"supported_efforts": ["high", 7]},
                "supported_parameters": ["reasoning"]
            }),
            json!({
                "reasoning": {"supported_efforts": [7]},
                "supported_parameters": ["reasoning"]
            }),
            json!({
                "reasoning": {
                    "supported_efforts": ["high"],
                    "supportedEfforts": ["max"]
                },
                "supported_parameters": ["reasoning"]
            }),
            json!({
                "reasoning": {
                    "supported_efforts": ["high"],
                    "upstream_format": "server-command"
                },
                "supported_parameters": ["reasoning"]
            }),
            json!({
                "reasoning": {
                    "supported_efforts": ["high"],
                    "upstream_parameter": "api_key"
                },
                "supported_parameters": ["reasoning"]
            }),
        ] {
            assert!(openrouter_reasoning_snapshot(&entry).is_none(), "{entry}");
        }
    }

    #[test]
    fn openrouter_reasoning_capability_is_valid_for_mimo_without_advertised_levels() {
        let capability = openrouter_reasoning_capability_from_model_entry(&json!({
            "id": "xiaomi/mimo-v2.6-pro",
            "supported_parameters": ["reasoning", "include_reasoning"],
            "reasoning": {"mandatory": false}
        }))
        .expect("Mimo reasoning capability");
        assert!(capability.supported_efforts.is_empty());
        assert_eq!(
            capability.effective_control_kind(),
            ReasoningControlKind::None
        );
        assert_eq!(capability.upstream.format, "reasoning_object");
        assert_eq!(capability.upstream.parameter, "reasoning.effort");
        assert!(capability.disable_allowed);
    }

    #[test]
    fn openrouter_reasoning_capability_keeps_deepseek_wire_schema() {
        let capability = openrouter_reasoning_capability_from_model_entry(&json!({
            "id": "deepseek/deepseek-v4-flash",
            "supported_parameters": [
                "reasoning",
                "reasoning_effort",
                "include_reasoning"
            ],
            "reasoning": {
                "mandatory": false,
                "supported_efforts": ["xhigh", "high"],
                "default_effort": "high"
            }
        }))
        .expect("DeepSeek reasoning capability");
        assert_eq!(capability.supported_efforts, ["xhigh", "high"]);
        assert_eq!(capability.upstream.format, "reasoning_object");
        assert_eq!(capability.upstream.parameter, "reasoning.effort");
        assert_eq!(capability.default_effort.as_deref(), Some("high"));
    }

    #[test]
    fn openrouter_reasoning_capability_accepts_parameter_only_metadata() {
        let capability = openrouter_reasoning_capability_from_model_entry(&json!({
            "id": "provider/model",
            "supported_parameters": ["reasoning", "include_reasoning"]
        }))
        .expect("parameter-only OpenRouter reasoning capability");
        assert!(capability.supported_efforts.is_empty());
        assert_eq!(
            capability.effective_control_kind(),
            ReasoningControlKind::None
        );
        assert_eq!(capability.upstream.format, "reasoning_object");
        assert_eq!(capability.upstream.parameter, "reasoning.effort");
    }

    #[test]
    fn provider_reasoning_metadata_keeps_explicit_levels_and_wire_contract() {
        let capability = provider_reasoning_capability_from_model_entry(
            &json!({
                "id": "gateway-model",
                "metadata": {
                    "reasoning": {
                        "supported_efforts": ["low", "high", "max"],
                        "default_effort": "max",
                        "mandatory": true,
                        "upstream_format": "string",
                        "upstream_parameter": "reasoning_effort"
                    }
                }
            }),
            false,
        )
        .expect("explicit provider reasoning contract");
        assert_eq!(capability.supported_efforts, ["low", "high", "max"]);
        assert_eq!(capability.default_effort.as_deref(), Some("max"));
        assert!(!capability.disable_allowed);
        assert_eq!(capability.upstream.format, "string");
        assert_eq!(capability.upstream.parameter, "reasoning_effort");
        assert_ne!(capability.source.as_deref(), Some("user"));
        capability.validate().expect("valid canonical capability");
    }

    #[test]
    fn provider_reasoning_metadata_reads_allowlisted_limit_envelopes() {
        let capability = provider_reasoning_capability_from_model_entry(
            &json!({
                "id": "gateway-model",
                "limits": {
                    "metadata": {
                        "capabilities": {
                            "reasoning": {
                                "supported_efforts": ["low", "high", "max"],
                                "default_effort": "high",
                                "upstream_format": "string",
                                "upstream_parameter": "reasoning_effort"
                            }
                        }
                    }
                }
            }),
            false,
        )
        .expect("reasoning declaration nested under limits");

        assert_eq!(capability.supported_efforts, ["low", "high", "max"]);
        assert_eq!(capability.default_effort.as_deref(), Some("high"));
        assert_eq!(capability.upstream.format, "string");
        assert_eq!(capability.upstream.parameter, "reasoning_effort");
    }

    #[test]
    fn provider_reasoning_metadata_reads_protocol_capability_envelopes() {
        let capability = provider_reasoning_capability_from_model_entry(
            &json!({
                "id": "gateway-model",
                "protocolCapability": {
                    "reasoning": {
                        "supportedEfforts": ["low", "high", "max"],
                        "defaultEffort": "high",
                        "upstreamFormat": "string",
                        "upstreamParameter": "reasoning_effort"
                    }
                }
            }),
            false,
        )
        .expect("reasoning declaration nested under protocol capability");

        assert_eq!(capability.supported_efforts, ["low", "high", "max"]);
        assert_eq!(capability.default_effort.as_deref(), Some("high"));
        assert_eq!(capability.upstream.format, "string");
        assert_eq!(capability.upstream.parameter, "reasoning_effort");
    }

    #[test]
    fn provider_reasoning_metadata_normalizes_ultra_only_with_a_max_path() {
        let capability = provider_reasoning_capability_from_model_entry(
            &json!({
                "id": "gateway-model",
                "reasoning": {
                    "supported_efforts": ["low", "max", "ultra"],
                    "default_effort": "ultra",
                    "upstream_format": "string",
                    "upstream_parameter": "reasoning_effort"
                }
            }),
            false,
        )
        .expect("a provider declaration with max can expose Codex Ultra");

        assert_eq!(capability.supported_efforts, ["low", "max"]);
        assert_eq!(capability.default_effort.as_deref(), Some("max"));
        assert!(capability
            .codex_ultra_orchestration
            .as_ref()
            .is_some_and(|ultra| ultra.enabled));
        assert!(!capability.upstream.effort_map.contains_key("ultra"));
        capability
            .validate()
            .expect("normalized capability is valid");

        assert!(
            provider_reasoning_capability_from_model_entry(
                &json!({
                    "id": "gateway-model",
                    "reasoning": {"supported_efforts": ["low", "ultra"]}
                }),
                false,
            )
            .is_none(),
            "Ultra without a valid max path must remain fail-closed"
        );
    }

    #[test]
    fn provider_reasoning_metadata_keeps_canonical_mapping_without_promoting_remote_instructions() {
        let capability = provider_reasoning_capability_from_model_entry(
            &json!({
                "id": "gateway-model",
                "reasoning": {
                    "schemaVersion": 2,
                    "supportStatus": "confirmed_supported",
                    "controlKind": "graded",
                    "supportedEfforts": ["high", "xhigh"],
                    "defaultEffort": "high",
                    "disableAllowed": false,
                    "upstream": {
                        "format": "reasoning_object",
                        "parameter": "reasoning.effort",
                        "effortMap": {"high": "high", "xhigh": "xhigh", "max": "xhigh"}
                    },
                    "source": "user",
                    "providerKey": "[REDACTED]",
                    "codexUltraOrchestration": {"enabled": true},
                    "baseInstructions": "remote instructions"
                }
            }),
            false,
        )
        .expect("canonical provider reasoning declaration");
        assert_eq!(capability.supported_efforts, ["high", "xhigh"]);
        assert_eq!(
            capability
                .upstream
                .effort_map
                .get("max")
                .map(String::as_str),
            Some("xhigh")
        );
        assert_ne!(capability.source.as_deref(), Some("user"));
        assert!(capability.codex_ultra_orchestration.is_none());
        assert!(capability.provider_key.is_none());
        let serialized =
            serde_json::to_string(&capability).expect("serialize canonical capability");
        assert!(!serialized.contains("[REDACTED]"));
        assert!(!serialized.contains("remote instructions"));
    }

    #[test]
    fn provider_reasoning_metadata_distinguishes_absent_positive_and_explicit_false() {
        use crate::proxy::providers::codex_reasoning::{
            ReasoningControlKind, ReasoningSupportStatus,
        };
        for entry in [
            json!({"id": "model", "reasoning": false}),
            json!({"id": "model", "supportsReasoning": false}),
            json!({"id": "model", "capabilities": {"reasoning": false}}),
        ] {
            let capability = provider_reasoning_capability_from_model_entry(&entry, false)
                .expect("explicit unsupported declaration");
            assert_eq!(
                capability.effective_support_status(),
                ReasoningSupportStatus::ConfirmedUnsupported
            );
            assert_eq!(
                capability.effective_control_kind(),
                ReasoningControlKind::None
            );
            assert!(capability.supported_efforts.is_empty());
        }
        let positive = provider_reasoning_capability_from_model_entry(
            &json!({"id": "model", "capabilities": {"reasoning": true}}),
            false,
        )
        .expect("positive reasoning evidence");
        assert_eq!(
            positive.effective_support_status(),
            ReasoningSupportStatus::ConfirmedSupported
        );
        assert_eq!(
            positive.effective_control_kind(),
            ReasoningControlKind::None
        );
        assert!(positive.supported_efforts.is_empty());
        for entry in [
            json!({"id": "model"}),
            json!({"id": "model", "reasoning": null}),
            json!({"id": "model", "reasoning": {}}),
            json!({"id": "model", "supported_parameters": ["reasoning"]}),
        ] {
            assert!(
                provider_reasoning_capability_from_model_entry(&entry, false).is_none(),
                "{entry}"
            );
        }
    }

    #[test]
    fn provider_reasoning_metadata_does_not_invent_openrouter_efforts_for_generic_providers() {
        let entry =
            json!({"id": "model", "supported_parameters": ["reasoning", "include_reasoning"]});
        assert!(provider_reasoning_capability_from_model_entry(&entry, false).is_none());
        let openrouter = provider_reasoning_capability_from_model_entry(&entry, true)
            .expect("verified OpenRouter reasoning support without effort selection");
        assert!(openrouter.supported_efforts.is_empty());
        assert_eq!(
            openrouter.effective_control_kind(),
            ReasoningControlKind::None
        );
    }

    #[test]
    fn provider_reasoning_positive_flags_compose_with_explicit_sibling_controls() {
        for support in [
            json!({"supportsReasoning": true}),
            json!({"reasoning": true}),
            json!({"capabilities": {"supports_thinking": true, "reasoning": true}}),
        ] {
            let mut entry = support;
            entry["supported_reasoning_efforts"] = json!(["low", "high", "max"]);
            entry["default_reasoning_effort"] = json!("max");
            entry["reasoning_format"] = json!("string");
            entry["reasoning_parameter"] = json!("reasoning_effort");
            entry["mandatory"] = json!(true);
            let capability = provider_reasoning_capability_from_model_entry(&entry, false)
                .expect("positive flags must not erase explicit controls");
            assert_eq!(capability.supported_efforts, ["low", "high", "max"]);
            assert_eq!(capability.default_effort.as_deref(), Some("max"));
            assert_eq!(
                capability.effective_control_kind(),
                ReasoningControlKind::Graded
            );
            assert!(!capability.disable_allowed);
            assert_eq!(capability.upstream.format, "string");
            assert_eq!(capability.upstream.parameter, "reasoning_effort");
        }
    }

    #[test]
    fn provider_reasoning_objects_compose_with_sibling_defaults_and_wire_metadata() {
        let capability = provider_reasoning_capability_from_model_entry(
            &json!({
                "reasoning": {"supported_efforts": ["low", "high", "max"]},
                "defaultReasoningEffort": "max",
                "upstream_format": "string",
                "upstream_parameter": "reasoning_effort",
                "mandatory": true
            }),
            false,
        )
        .expect("consistent siblings complete a lightweight reasoning object");
        assert_eq!(capability.default_effort.as_deref(), Some("max"));
        assert_eq!(capability.upstream.format, "string");
        assert_eq!(capability.upstream.parameter, "reasoning_effort");
        assert!(!capability.disable_allowed);
    }

    #[test]
    fn provider_reasoning_rejects_cross_shape_boolean_and_control_conflicts() {
        for entry in [
            json!({"reasoning": true, "supportsReasoning": false}),
            json!({"reasoning": false, "supportsReasoning": true}),
            json!({"reasoning": false, "supportedEfforts": ["high"]}),
            json!({"supportsReasoning": false, "supports_max_tokens": true}),
            json!({"reasoning": true, "supportedEfforts": ["high", 7]}),
            json!({"reasoning": {"supportedEfforts": ["high"]}, "supportedEfforts": ["max"]}),
            json!({"reasoning": {"supportedEfforts": ["high"], "mandatory": true}, "mandatory": false}),
            json!({"reasoning": {"supportedEfforts": ["high"], "defaultEffort": "high"}, "defaultEffort": "max"}),
            json!({"reasoning": {"supportedEfforts": ["high"], "upstream_format": "string"}, "upstreamFormat": "reasoning_object"}),
        ] {
            for openrouter in [false, true] {
                assert!(
                    provider_reasoning_capability_from_model_entry(&entry, openrouter).is_none(),
                    "contradictory or invalid declaration must fail atomically: {entry}"
                );
            }
        }
    }

    #[test]
    fn provider_reasoning_malformed_canonical_does_not_reopen_lightweight_fallback() {
        for canonical in [
            json!({"schemaVersion": 2, "supportedEfforts": ["high"]}),
            json!({
                "schemaVersion": 2,
                "supportStatus": "confirmed_supported",
                "controlKind": "graded",
                "supportedEfforts": ["high"],
                "defaultEffort": "max",
                "disableAllowed": false,
                "upstream": {"format": "string", "parameter": "reasoning_effort"}
            }),
        ] {
            let entry = json!({
                "reasoning": canonical,
                "supportsReasoning": true,
                "supportedEfforts": ["low", "high", "max"],
                "supported_parameters": ["reasoning"]
            });
            for openrouter in [false, true] {
                assert!(
                    provider_reasoning_capability_from_model_entry(&entry, openrouter).is_none(),
                    "{entry}"
                );
            }
        }
    }

    #[test]
    fn openrouter_null_efforts_expand_the_gateway_vocabulary_without_ultra() {
        for mandatory in [false, true] {
            let entry = json!({
                "id": "provider/model",
                "supported_parameters": ["reasoning"],
                "reasoning": {
                    "supported_efforts": null,
                    "default_effort": "max",
                    "mandatory": mandatory
                }
            });
            let expected = if mandatory {
                vec!["max", "xhigh", "high", "medium", "low", "minimal"]
            } else {
                vec!["max", "xhigh", "high", "medium", "low", "minimal", "none"]
            };
            let generic = provider_reasoning_capability_from_model_entry(&entry, true)
                .expect("null is an unbounded OpenRouter gateway effort allowlist");
            let dedicated = openrouter_reasoning_capability_from_model_entry(&entry)
                .expect("dedicated discovery uses the same normalization");
            let snapshot = openrouter_reasoning_snapshot(&entry).expect("snapshot");
            assert_eq!(generic.supported_efforts, expected);
            assert_eq!(dedicated.supported_efforts, expected);
            assert_eq!(snapshot.supported_efforts, expected);
            assert_eq!(generic.default_effort.as_deref(), Some("max"));
            assert_eq!(generic.disable_allowed, !mandatory);
            assert!(generic.codex_ultra_orchestration.is_none());
            assert!(provider_reasoning_capability_from_model_entry(&entry, false).is_none());
        }
    }

    #[test]
    fn openrouter_explicit_effort_allowlists_remain_exact_across_entry_points() {
        for efforts in [json!(["max", "high"]), json!([])] {
            let entry = json!({
                "id": "provider/model",
                "supported_parameters": ["reasoning"],
                "reasoning": {"supported_efforts": efforts, "mandatory": false}
            });
            let generic = provider_reasoning_capability_from_model_entry(&entry, true)
                .expect("valid explicit OpenRouter allowlist");
            let dedicated = openrouter_reasoning_capability_from_model_entry(&entry)
                .expect("dedicated OpenRouter capability");
            assert_eq!(
                serde_json::to_value(&generic.supported_efforts).unwrap(),
                efforts
            );
            assert_eq!(generic.supported_efforts, dedicated.supported_efforts);
        }
    }

    #[test]
    fn openrouter_omitted_efforts_preserve_budget_only_reasoning_without_graded_defaults() {
        let entry = json!({
            "id": "anthropic/model",
            "supported_parameters": ["reasoning"],
            "reasoning": {
                "mandatory": false,
                "supports_max_tokens": true,
                "default_enabled": true
            }
        });
        for capability in [
            provider_reasoning_capability_from_model_entry(&entry, true),
            openrouter_reasoning_capability_from_model_entry(&entry),
        ] {
            let capability = capability.expect("budget-only support");
            assert_eq!(
                capability.effective_control_kind(),
                ReasoningControlKind::Budget
            );
            assert!(capability.supported_efforts.is_empty());
            assert!(capability.default_effort.is_none());
            assert!(capability.disable_allowed);
        }
        let snapshot = openrouter_reasoning_snapshot(&entry).expect("budget snapshot");
        assert!(snapshot.supports_max_tokens);
        assert_eq!(snapshot.default_enabled, Some(true));
    }

    #[test]
    fn openrouter_default_off_is_not_an_automatic_disable_effort() {
        for efforts in [None, Some(json!(["high", "low"])), Some(Value::Null)] {
            let mut entry = json!({
                "id": "provider/model",
                "supported_parameters": ["reasoning"],
                "reasoning": {
                    "mandatory": false,
                    "default_effort": "none",
                    "default_enabled": false
                }
            });
            if let Some(efforts) = efforts {
                entry["reasoning"]["supported_efforts"] = efforts;
            }
            let capability = provider_reasoning_capability_from_model_entry(&entry, true)
                .expect("off-by-default does not invalidate advertised reasoning support");
            assert!(capability.default_effort.is_none());
            assert_eq!(
                openrouter_reasoning_snapshot(&entry)
                    .unwrap()
                    .default_enabled,
                Some(false)
            );
        }
    }

    #[test]
    fn reaudit_generic_provider_preserves_an_explicit_none_selector_default() {
        let entry = json!({
            "reasoning": {
                "supported_efforts": ["none", "high"],
                "default_effort": "none",
                "mandatory": false
            }
        });
        let capability = provider_reasoning_capability_from_model_entry(&entry, false)
            .expect("valid provider-native disable effort");
        assert_eq!(capability.default_effort.as_deref(), Some("none"));
        assert_eq!(capability.supported_efforts, ["none", "high"]);
        assert!(capability.disable_allowed);

        let openrouter = provider_reasoning_capability_from_model_entry(&entry, true)
            .expect("OpenRouter off-by-default declaration");
        assert!(openrouter.default_effort.is_none());
    }

    #[test]
    fn provider_reasoning_mandatory_rejects_disable_and_off_defaults() {
        for reasoning in [
            json!({"supported_efforts": ["none", "high"], "mandatory": true}),
            json!({"supported_efforts": ["high"], "mandatory": true, "disable_allowed": true}),
            json!({"supported_efforts": ["high"], "mandatory": true, "default_enabled": false}),
            json!({"supported_efforts": ["high"], "mandatory": true, "default_effort": "none"}),
        ] {
            let entry = json!({"id": "model", "reasoning": reasoning, "supported_parameters": ["reasoning"]});
            for openrouter in [false, true] {
                assert!(
                    provider_reasoning_capability_from_model_entry(&entry, openrouter).is_none(),
                    "{entry}"
                );
            }
            assert!(openrouter_reasoning_capability_from_model_entry(&entry).is_none());
        }
    }

    #[test]
    fn provider_reasoning_metadata_rejects_invalid_or_conflicting_declarations_atomically() {
        for entry in [
            json!({"reasoning": {"supported_efforts": ["high", 7]}}),
            json!({"reasoning": {"supported_efforts": ["high", "unsupported-level"]}}),
            json!({"reasoning": {"supported_efforts": ["high"], "supportedEfforts": ["max"]}}),
            json!({"reasoning": {"supported_efforts": ["high"], "default_effort": "max"}}),
            json!({"reasoning": {"supported_efforts": ["high"], "mandatory": "true"}}),
            json!({"reasoning": {"supported_efforts": ["high"], "upstream_format": "server-command"}}),
            json!({"reasoning": {"supported_efforts": ["high"], "upstream_parameter": "api_key"}}),
            json!({"reasoning": {"supported_efforts": ["high"], "mandatory": true, "disableAllowed": true}}),
            json!({"supportsReasoning": false, "reasoning": {"supported_efforts": ["high"]}}),
            json!({"reasoning": {"supported_efforts": ["high"]}, "metadata": {"reasoning": {"supported_efforts": ["max"]}}}),
            json!({"reasoning": {"supported_efforts": [{"effort": "low", "reasoningEffort": "max"}]}}),
            json!({"reasoning": {"supported_efforts": ["ultra"]}}),
            // Native wire "ultra" is not the product's synthetic orchestration
            // selector. Unknown provider mappings must stay absent evidence,
            // never fabricate max or a confirmed-unsupported declaration.
            json!({"reasoning": {"supported_efforts": ["low", "medium", "high", "xhigh", "ultra"]}}),
            json!({"reasoning": "yes"}),
        ] {
            assert!(
                provider_reasoning_capability_from_model_entry(&entry, false).is_none(),
                "{entry}"
            );
            assert!(
                provider_reasoning_capability_from_model_entry(&entry, true).is_none(),
                "{entry}"
            );
        }
    }
}
