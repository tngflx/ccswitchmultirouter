//! Codex 第三方模型推理能力：统一来源链（P1）。
//!
//! 单一 resolver 入口 [`resolve_codex_model_capability`]——所有消费者（catalog 投影、
//! 请求转换、Sub-Agent policy、GUI/CLI inspect）必须经由该入口，不得再按模型名
//! 重新猜测档位。任何一层重新按模型名猜测档位都视为实现失败。
//!
//! 来源优先级（高 → 低）：
//! 1. 用户模型级声明（`modelCatalog.models[].reasoning`）——始终最高优先级；
//! 2. 动态检测候选快照（TTL、只读元数据、禁止主动推理试探）；
//! 3. CCSM 维护的版本化能力库（随应用打包的独立 JSON 资源）；
//! 4. 内置清单（deepseek-v4 / k3）；
//! 5. Codex 官方模型缓存（仅未知平台生效；OpenRouter/vLLM 等聚合平台不套用）；
//! 6. Unknown（fail-closed）。
//!
//! 核心原则：缺失证据不是不存在的证据。`NotAdvertised`/`Unavailable`/`Invalid`
//! 以及库/内置未命中，都只能得到 `unknown`，绝不自动生成 `confirmed_unsupported`。

pub mod catalog;
pub mod provider_metadata;

use crate::codex_multirouter::catalog::{
    lookup_catalog_model, lookup_provider_catalog_model, CatalogModelIndex, CatalogModelLookup,
};
use crate::provider::Provider;
pub use crate::proxy::providers::codex_reasoning::ReasoningEvidenceScope;
use crate::proxy::providers::codex_reasoning::{
    builtin_reasoning_capability_for_model, capability_fingerprint,
    normalize_sublyx_reasoning_capability_for_model, official_reasoning_capability_for_model,
    reasoning_capability_from_model_entry, reasoning_capability_from_provider_model_entry,
    sublyx_reasoning_capability_for_model, CapabilityConfidence, CodexModelReasoningCapability,
    CodexModelReasoningUpstream, ReasoningControlKind, ReasoningSupportStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 能力来源（用于指纹溯源与 UI 展示）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilitySource {
    /// 用户模型级显式声明（含 `user_confirmed_detection` 采用后的覆盖）。
    UserConfig,
    /// Reasoning declared in Codex's inline provider model definition.
    ProviderConfig,
    /// 动态只读检测（TTL 候选快照）。
    Detection,
    /// CCSM 维护的版本化能力库。
    Library,
    /// 内置清单。
    Builtin,
    /// Codex 官方模型缓存（仅未知平台生效；OpenRouter/vLLM 等聚合平台不套用）。
    Official,
    /// Validated provider-wide capability, only after model and wire evidence miss.
    #[serde(rename = "provider")]
    ProviderFallback,
    /// 无来源命中，fail-closed unknown。
    Unknown,
}

impl CapabilitySource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UserConfig => "user_config",
            Self::ProviderConfig => "provider_config",
            Self::Detection => "detection",
            Self::Library => "library",
            Self::Builtin => "builtin",
            Self::Official => "official",
            Self::ProviderFallback => "provider",
            Self::Unknown => "unknown",
        }
    }
}

/// 通用 Provider 能力快照（可扩展：reasoning / 工具调用 / 结构化输出 / 模态 /
/// 上下文 / 端点协议）。首版只填充 reasoning 子对象，避免以后为其他能力
/// 重新发明探测框架。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilitySnapshot {
    pub provider_key: String,
    pub model: String,
    /// Unix 毫秒时间戳。
    pub fetched_at: i64,
    /// 来源标识：`openrouter_api` / `vllm_server` / ...
    pub source: String,
    /// Binding to the current API transport and canonical wire identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_scope: Option<ReasoningEvidenceScope>,
    pub reasoning: Option<ReasoningCapabilitySnapshot>,
}

/// 快照的 reasoning 子对象（仅 allowlist 字段，不含任何敏感信息）。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningCapabilitySnapshot {
    /// 平台声明的可选 effort（含 `none` 表示支持显式关闭）。
    pub supported_efforts: Vec<String>,
    pub default_effort: Option<String>,
    /// 推理强制开启（不可关闭）。
    pub mandatory: bool,
    /// 服务端默认是否开启推理。
    pub default_enabled: Option<bool>,
    /// 支持 token budget 控制（无分档时的替代控制形态）。
    pub supports_max_tokens: bool,
    /// 上游 wire 形态（平台相关）：`object`（reasoning.effort）/ `string`
    /// （reasoning_effort）/ `boolean`（enable_thinking）等。
    pub upstream_format: Option<String>,
    /// 上游参数名。
    pub upstream_parameter: Option<String>,
    /// Explicit support status from canonical provider metadata. Omitted by
    /// legacy snapshots, whose positive capability objects imply support.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support_status: Option<ReasoningSupportStatus>,
    /// Validated provider control shape. Optional for legacy snapshots; when
    /// present it must be preserved instead of being inferred from efforts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control_kind: Option<ReasoningControlKind>,
    /// Provider-native disable contract, independent from `mandatory`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disable_allowed: Option<bool>,
    /// Validated provider-native effort mapping. Synthetic Codex Ultra is
    /// deliberately not part of this map.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort_map: Option<HashMap<String, String>>,
    /// Product-level Ultra projection with its explicit native target, kept
    /// separate from provider-native efforts and the provider effort map.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_ultra_orchestration:
        Option<crate::proxy::providers::codex_reasoning::CodexUltraOrchestrationCapability>,
    /// reasoning 内容回传字段形态。
    pub output_format: Option<String>,
}

/// 适配器结果。`NotAdvertised`/`Unavailable`/`Invalid` 均不能自动生成
/// `confirmed_unsupported`——缺失证据不是不存在的证据。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
#[expect(
    clippy::large_enum_variant,
    reason = "discovery returns one owned capability snapshot and the outcome remains short-lived"
)]
pub enum DiscoveryOutcome {
    Found(ProviderCapabilitySnapshot),
    /// 端点可达，但模型/字段未声明。
    NotAdvertised,
    /// 端点不可达 / 404 / 鉴权失败。
    Unavailable,
    /// 响应无法解析 / 结构非法。
    Invalid,
}

/// Resolver 输出：能力 + 来源 + 指纹。
#[derive(Clone, Debug)]
pub struct ResolvedModelCapability {
    pub capability: Option<CodexModelReasoningCapability>,
    pub source: CapabilitySource,
    pub fingerprint: String,
}

/// 动态检测候选快照的 TTL。
pub const DETECTION_TTL: Duration = Duration::from_secs(60 * 60);

/// 内存 TTL 候选快照缓存（per provider+model）。
#[derive(Default)]
pub struct DetectionCache {
    entries: HashMap<String, (ProviderCapabilitySnapshot, Instant)>,
    revision: u64,
    next_expiration: Option<Instant>,
}

impl DetectionCache {
    fn key(provider_key: &str, model: &str) -> String {
        format!("{provider_key}\u{1f}{}", model.trim().to_ascii_lowercase())
    }

    /// 读取未过期的候选快照；过期或不存在返回 None。
    pub fn get(&self, provider_key: &str, model: &str) -> Option<&ProviderCapabilitySnapshot> {
        self.entries
            .get(&Self::key(provider_key, model))
            .filter(|(_, inserted_at)| inserted_at.elapsed() < DETECTION_TTL)
            .map(|(snapshot, _)| snapshot)
    }

    pub fn insert(&mut self, snapshot: ProviderCapabilitySnapshot) {
        self.insert_at(snapshot, Instant::now());
    }

    fn insert_at(&mut self, snapshot: ProviderCapabilitySnapshot, now: Instant) {
        self.prune_expired_at(now);
        self.entries.insert(
            Self::key(&snapshot.provider_key, &snapshot.model),
            (snapshot, now),
        );
        let expiration = now + DETECTION_TTL;
        self.next_expiration = Some(
            self.next_expiration
                .map_or(expiration, |old| old.min(expiration)),
        );
        self.revision = self.revision.wrapping_add(1);
    }

    pub fn prune_expired(&mut self) {
        self.prune_expired_at(Instant::now());
    }

    fn prune_expired_at(&mut self, now: Instant) {
        if self
            .next_expiration
            .is_none_or(|expiration| now < expiration)
        {
            return;
        }
        let previous = self.entries.len();
        self.entries.retain(|_, (_, inserted_at)| {
            now.saturating_duration_since(*inserted_at) < DETECTION_TTL
        });
        self.next_expiration = self
            .entries
            .values()
            .map(|(_, inserted_at)| *inserted_at + DETECTION_TTL)
            .min();
        if self.entries.len() != previous {
            self.revision = self.revision.wrapping_add(1);
        }
    }
}

/// 全局检测缓存（请求路径与检测触发方共享）。
static DETECTION_CACHE: OnceLock<Mutex<DetectionCache>> = OnceLock::new();

pub fn detection_cache() -> &'static Mutex<DetectionCache> {
    DETECTION_CACHE.get_or_init(|| Mutex::new(DetectionCache::default()))
}

pub(crate) fn detection_revision() -> Option<u64> {
    let mut cache = detection_cache().lock().ok()?;
    cache.prune_expired();
    Some(cache.revision)
}

/// 读取当前 provider+model 的 TTL 候选快照（无或过期返回 None）。
fn current_detection(provider_key: &str, model: &str) -> Option<ProviderCapabilitySnapshot> {
    let cache = detection_cache().lock().expect("detection cache poisoned");
    cache.get(provider_key, model).cloned()
}

/// Build non-secret provenance from the same conservative API URL normalizer
/// used by protocol declarations. Credential-bearing/option URLs are rejected;
/// neither their text nor their hashes enter saved evidence or diagnostics.
pub(crate) fn reasoning_evidence_scope(
    base_url: &str,
    wire_model: &str,
) -> Option<ReasoningEvidenceScope> {
    let base_url =
        crate::codex_multirouter::protocol_capability::normalize_protocol_capability_base_url(
            base_url,
        )?;
    let model = wire_model.trim().to_ascii_lowercase();
    if model.is_empty() {
        return None;
    }
    Some(ReasoningEvidenceScope {
        transport_fingerprint: hex::encode(Sha256::digest(base_url.as_bytes())),
        model,
    })
}

pub(crate) fn reasoning_wire_model_for_provider(
    provider: &Provider,
    model: &str,
) -> Option<String> {
    reasoning_wire_model_for_catalog(ModelCatalog::for_provider(provider), model)
}

#[derive(Clone, Copy)]
struct ModelCatalog<'a> {
    settings: &'a Value,
    index: Option<&'a CatalogModelIndex<'a>>,
    provider: Option<&'a Provider>,
}

impl<'a> ModelCatalog<'a> {
    fn new(settings: &'a Value) -> Self {
        Self {
            settings,
            index: None,
            provider: None,
        }
    }

    fn for_provider(provider: &'a Provider) -> Self {
        Self {
            settings: &provider.settings_config,
            index: None,
            provider: Some(provider),
        }
    }

    fn lookup(self, model: &str) -> CatalogModelLookup<'a> {
        self.provider.map_or_else(
            || {
                self.index.map_or_else(
                    || lookup_catalog_model(self.settings, model),
                    |index| index.lookup(model),
                )
            },
            |provider| lookup_provider_catalog_model(provider, model),
        )
    }
}

fn reasoning_wire_model_for_catalog(catalog: ModelCatalog<'_>, model: &str) -> Option<String> {
    let wire_model = match catalog.lookup(model) {
        CatalogModelLookup::Ambiguous => return None,
        CatalogModelLookup::Found(entry) => {
            if entry.get("enabled").and_then(Value::as_bool) == Some(false) {
                return None;
            }
            ["upstreamModel", "upstream_model", "model", "id", "slug"]
                .iter()
                .filter_map(|key| entry.get(*key).and_then(Value::as_str))
                .map(str::trim)
                .find(|value| !value.is_empty())
                .unwrap_or(model)
        }
        CatalogModelLookup::Missing => model,
    };
    let wire_model = wire_model.trim();
    (!wire_model.is_empty()).then(|| wire_model.to_string())
}

pub(crate) fn reasoning_evidence_scope_for_settings(
    settings: &Value,
    model: &str,
) -> Option<ReasoningEvidenceScope> {
    reasoning_evidence_scope_for_catalog(ModelCatalog::new(settings), model)
}

pub(crate) fn reasoning_evidence_scope_for_provider(
    provider: &Provider,
    model: &str,
) -> Option<ReasoningEvidenceScope> {
    reasoning_evidence_scope_for_catalog(ModelCatalog::for_provider(provider), model)
}

fn reasoning_evidence_scope_for_catalog(
    catalog: ModelCatalog<'_>,
    model: &str,
) -> Option<ReasoningEvidenceScope> {
    let base_url = provider_metadata::base_url_from_settings(catalog.settings)?;
    let wire_model = reasoning_wire_model_for_catalog(catalog, model)?;
    reasoning_evidence_scope(&base_url, &wire_model)
}

fn evidence_scope_matches(
    catalog: ModelCatalog<'_>,
    model: &str,
    scope: Option<&ReasoningEvidenceScope>,
) -> bool {
    scope.is_some_and(|scope| {
        reasoning_evidence_scope_for_catalog(catalog, model).as_ref() == Some(scope)
    })
}

fn snapshot_matches_context(
    catalog: ModelCatalog<'_>,
    platform: Option<&str>,
    model: &str,
    snapshot: &ProviderCapabilitySnapshot,
) -> bool {
    if !evidence_scope_matches(catalog, model, snapshot.evidence_scope.as_ref()) {
        return false;
    }
    if !snapshot.evidence_scope.as_ref().is_some_and(|scope| {
        scope.model.eq_ignore_ascii_case(snapshot.model.trim())
            || reasoning_wire_model_for_catalog(catalog, &snapshot.model)
                .is_some_and(|wire| scope.model.eq_ignore_ascii_case(wire.trim()))
    }) {
        return false;
    }
    let source_platform = match snapshot.source.as_str() {
        "openrouter_api" => Some("openrouter"),
        "vllm_server" => Some("vllm"),
        _ => None,
    };
    !matches!((platform, source_platform), (Some(actual), Some(source)) if actual != source)
}

/// Read only a snapshot bound to this endpoint and its current wire identity.
/// Old unscoped cache entries are intentionally not adopted after upgrading.
pub(crate) fn current_detection_for_settings(
    settings: &Value,
    provider_key: &str,
    model: &str,
) -> Option<ProviderCapabilitySnapshot> {
    current_detection_for_catalog(ModelCatalog::new(settings), provider_key, model)
}

fn current_detection_for_catalog(
    catalog: ModelCatalog<'_>,
    provider_key: &str,
    model: &str,
) -> Option<ProviderCapabilitySnapshot> {
    let wire_model = reasoning_wire_model_for_catalog(catalog, model)?;
    let validate_snapshot = |snapshot: &ProviderCapabilitySnapshot| {
        let platform = provider_metadata::detect_platform_from_settings(catalog.settings);
        snapshot_matches_context(catalog, platform, model, snapshot)
    };
    current_detection(provider_key, model)
        .filter(validate_snapshot)
        .or_else(|| {
            (!model.trim().eq_ignore_ascii_case(&wire_model))
                .then(|| current_detection(provider_key, &wire_model))
                .flatten()
                .filter(validate_snapshot)
        })
}

pub(crate) fn current_detection_for_provider(
    provider: &Provider,
    model: &str,
) -> Option<ProviderCapabilitySnapshot> {
    current_detection_for_catalog(
        ModelCatalog::for_provider(provider),
        reasoning_provider_key(provider),
        model,
    )
}

fn capability_matches_context(
    catalog: ModelCatalog<'_>,
    platform: Option<&str>,
    model: &str,
    capability: &CodexModelReasoningCapability,
) -> bool {
    if is_explicit_reasoning_declaration(capability) {
        return true;
    }
    if !evidence_scope_matches(catalog, model, capability.evidence_scope.as_ref()) {
        return false;
    }
    let source_platform = match capability.source.as_deref() {
        Some("openrouter_api") => Some("openrouter"),
        Some("vllm_server") => Some("vllm"),
        Some("sublyx") => Some("sublyx"),
        _ => None,
    };
    !matches!((platform, source_platform), (Some(actual), Some(source)) if actual != source)
}

fn is_explicit_reasoning_declaration(capability: &CodexModelReasoningCapability) -> bool {
    matches!(
        capability.source.as_deref(),
        None | Some("user" | "user_confirmed_detection")
    )
}

/// Use the target provider identity for routed capability evidence. Route IDs
/// and labels are presentation identities; they must not select another
/// provider's detection-cache namespace.
pub(crate) fn reasoning_provider_key(provider: &Provider) -> &str {
    provider
        .settings_config
        .get("codexResolvedTargetProviderId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or(&provider.id)
}

/// Tauri 资源目录（由 setup hook 初始化；测试/开发可缺省）。
static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn init_resource_dir(dir: PathBuf) {
    let _ = RESOURCE_DIR.set(dir);
}

pub fn resource_dir() -> Option<PathBuf> {
    RESOURCE_DIR.get().cloned()
}

/// 单一 resolver 入口（请求路径用；同步、无网络）。
///
/// `detection` 为当前 TTL 候选快照（可为 None）；用户配置始终最高优先级。
/// 能力库读取自全局懒加载缓存，official 来源读取 Codex 官方模型缓存。
pub fn resolve_codex_model_capability(
    provider: &Provider,
    model: &str,
    detection: Option<&ProviderCapabilitySnapshot>,
) -> ResolvedModelCapability {
    let platform = provider_metadata::detect_platform(provider);
    let official_models = platform
        .is_none()
        .then(crate::codex_config::codex_official_models_snapshot)
        .flatten();
    resolve_codex_model_capability_for_provider(
        provider,
        platform,
        Some(reasoning_provider_key(provider)),
        model,
        catalog::global_library().as_deref(),
        official_models.as_deref().unwrap_or_default(),
        |candidate| {
            if candidate.eq_ignore_ascii_case(model) {
                detection
                    .filter(|snapshot| snapshot.provider_key == reasoning_provider_key(provider))
                    .cloned()
            } else {
                current_detection_for_provider(provider, candidate)
            }
        },
    )
}

/// Resolve legacy model-list source objects through the same canonical pipeline.
///
/// This is a read-only compatibility adapter, not another persisted catalog:
/// a valid current catalog (including an empty one) always wins. Only an absent
/// or malformed catalog permits the legacy source to form an ephemeral row.
pub(crate) fn resolve_codex_model_capability_for_model_source(
    provider: &Provider,
    model: &str,
    source: &Value,
) -> ResolvedModelCapability {
    let adapted_provider =
        if crate::codex_multirouter::catalog::read_provider_catalog(provider).is_none() {
            let mut adapted = provider.clone();
            let mut row = source.as_object().cloned().unwrap_or_default();
            row.insert("model".to_string(), Value::String(model.to_string()));
            adapted.settings_config["modelCatalog"] = serde_json::json!({
                "models": [Value::Object(row)]
            });
            if let Some(settings) = adapted.settings_config.as_object_mut() {
                settings.remove("model_catalog");
            }
            Some(adapted)
        } else {
            None
        };
    let provider = adapted_provider.as_ref().unwrap_or(provider);
    let detection = current_detection_for_provider(provider, model);
    resolve_codex_model_capability(provider, model, detection.as_ref())
}

/// 测试用 resolver 入口（可注入能力库；不加载 official 缓存，保持确定性）。
///
/// 来源优先级（高 → 低）：用户配置 > 检测候选 > 能力库 > 内置 > official（仅未知平台）> unknown。
pub fn resolve_codex_model_capability_with_library(
    provider: &Provider,
    model: &str,
    detection: Option<&ProviderCapabilitySnapshot>,
    library: Option<&catalog::CapabilityLibrary>,
) -> ResolvedModelCapability {
    let platform = provider_metadata::detect_platform(provider);
    resolve_codex_model_capability_for_provider(
        provider,
        platform,
        Some(reasoning_provider_key(provider)),
        model,
        library,
        &[],
        |candidate| {
            if candidate.eq_ignore_ascii_case(model) {
                detection
                    .filter(|snapshot| snapshot.provider_key == reasoning_provider_key(provider))
                    .cloned()
            } else {
                None
            }
        },
    )
}

/// Resolve a catalog model without promoting provider defaults above model evidence.
///
/// Every consumer follows the same chain: the canonical model's complete core
/// evidence, then its declared wire model's complete core evidence, then a
/// validated provider-wide capability. The detector is injected so static
/// projections can deliberately remain independent of the TTL cache.
/// Legacy provider transport settings are not model capabilities and remain
/// the responsibility of their existing transport adapters.
pub(crate) fn resolve_codex_model_capability_for_settings(
    settings: &Value,
    platform: Option<&str>,
    provider_key: Option<&str>,
    model: &str,
    library: Option<&catalog::CapabilityLibrary>,
    official_models: &[Value],
    detection_for_model: impl Fn(&str) -> Option<ProviderCapabilitySnapshot>,
) -> ResolvedModelCapability {
    resolve_codex_model_capability_for_catalog(
        ModelCatalog::new(settings),
        platform,
        provider_key,
        model,
        library,
        official_models,
        detection_for_model,
    )
}

fn resolve_codex_model_capability_for_provider(
    provider: &Provider,
    platform: Option<&str>,
    provider_key: Option<&str>,
    model: &str,
    library: Option<&catalog::CapabilityLibrary>,
    official_models: &[Value],
    detection_for_model: impl Fn(&str) -> Option<ProviderCapabilitySnapshot>,
) -> ResolvedModelCapability {
    resolve_codex_model_capability_for_catalog(
        ModelCatalog::for_provider(provider),
        platform,
        provider_key,
        model,
        library,
        official_models,
        detection_for_model,
    )
}

pub(crate) fn resolve_codex_model_capability_for_indexed_provider(
    provider: &Provider,
    index: &CatalogModelIndex<'_>,
    platform: Option<&str>,
    model: &str,
    library: Option<&catalog::CapabilityLibrary>,
    official_models: &[Value],
) -> ResolvedModelCapability {
    let catalog = ModelCatalog {
        settings: &provider.settings_config,
        index: Some(index),
        provider: None,
    };
    let provider_key = reasoning_provider_key(provider);
    resolve_codex_model_capability_for_catalog(
        catalog,
        platform,
        Some(provider_key),
        model,
        library,
        official_models,
        |model| current_detection_for_catalog(catalog, provider_key, model),
    )
}

fn resolve_codex_model_capability_for_catalog(
    catalog: ModelCatalog<'_>,
    platform: Option<&str>,
    provider_key: Option<&str>,
    model: &str,
    library: Option<&catalog::CapabilityLibrary>,
    official_models: &[Value],
    detection_for_model: impl Fn(&str) -> Option<ProviderCapabilitySnapshot>,
) -> ResolvedModelCapability {
    let lookup = catalog.lookup(model);
    if matches!(lookup, CatalogModelLookup::Ambiguous)
        || matches!(lookup, CatalogModelLookup::Found(entry)
            if entry.get("enabled").and_then(Value::as_bool) == Some(false))
    {
        // Excluded or ambiguous identities must not be revived by a provider
        // fallback or by a recognized upstream name.
        return ResolvedModelCapability {
            capability: None,
            source: CapabilitySource::Unknown,
            fingerprint: String::new(),
        };
    }
    let row = match lookup {
        CatalogModelLookup::Found(entry) => Some(entry),
        _ => None,
    };
    let canonical_model = row
        .and_then(|entry| {
            ["model", "id", "slug"]
                .iter()
                .find_map(|key| entry.get(*key))
        })
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .unwrap_or(model);
    let upstream_model = row
        .and_then(|entry| {
            ["upstreamModel", "upstream_model"]
                .iter()
                .find_map(|key| entry.get(*key))
        })
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .unwrap_or(canonical_model);
    let normalize_selected_capability = |capability| {
        let mut capability =
            normalize_provider_reasoning_capability(platform, upstream_model, capability);
        // The shared selection boundary has already checked this automatic
        // declaration's current transport/model scope. Attach missing display
        // provenance here, not in one compiler projection, so source, routed
        // requests and picker publication all receive the same capability.
        // A settings-only caller cannot invent an actual provider identity.
        if capability.source.as_deref() == Some("detection") && capability.provider_key.is_none() {
            capability.provider_key = provider_key
                .map(str::trim)
                .filter(|key| !key.is_empty())
                .map(str::to_string);
        }
        capability
    };
    // A non-wire alias names this canonical row too. Preserve a snapshot
    // explicitly supplied for that alias before consulting the canonical key;
    // a wire snapshot must remain on the later upstream-evidence step.
    let canonical_detection_model = if !model.eq_ignore_ascii_case(canonical_model)
        && !model.eq_ignore_ascii_case(upstream_model)
    {
        model
    } else {
        canonical_model
    };
    let detection = detection_for_model(canonical_detection_model).or_else(|| {
        (!canonical_detection_model.eq_ignore_ascii_case(canonical_model))
            .then(|| detection_for_model(canonical_model))
            .flatten()
    });
    let mut resolved = resolve_codex_model_capability_core_for_catalog(
        catalog,
        platform,
        canonical_model,
        detection.as_ref(),
        library,
        official_models,
    );
    if resolved.capability.is_none() && !canonical_model.eq_ignore_ascii_case(upstream_model) {
        let detection = detection_for_model(upstream_model);
        resolved = resolve_codex_model_capability_core_for_catalog(
            catalog,
            platform,
            upstream_model,
            detection.as_ref(),
            library,
            official_models,
        );
    }
    if let Some(capability) = resolved.capability.take() {
        // The public row owns product-level settings even when its
        // reasoning evidence came from the wire identity.
        return resolved_with_catalog_ultra_setting(
            catalog,
            canonical_model,
            resolved.source,
            normalize_selected_capability(capability),
        );
    }
    let provider_reasoning = ["reasoning", "codexChatReasoning", "codex_chat_reasoning"]
        .iter()
        .find_map(|key| catalog.settings.get(*key))
        .and_then(|reasoning| {
            reasoning_capability_from_model_entry(&serde_json::json!({
                "reasoning": reasoning,
            }))
        })
        .filter(|capability| {
            capability_matches_context(catalog, platform, canonical_model, capability)
        });
    provider_reasoning.map_or(resolved, |capability| {
        resolved_with_catalog_ultra_setting(
            catalog,
            canonical_model,
            CapabilitySource::ProviderFallback,
            normalize_selected_capability(capability),
        )
    })
}

fn normalize_provider_reasoning_capability(
    platform: Option<&str>,
    wire_model: &str,
    capability: CodexModelReasoningCapability,
) -> CodexModelReasoningCapability {
    if platform == Some("sublyx") {
        normalize_sublyx_reasoning_capability_for_model(wire_model, capability)
    } else {
        capability
    }
}

/// Apply the model's product-level Ultra setting after the capability source
/// has been resolved. This deliberately does not change the source or
/// Provider-native capability declaration.
fn apply_catalog_ultra_setting(
    catalog: ModelCatalog<'_>,
    model: &str,
    capability: CodexModelReasoningCapability,
) -> CodexModelReasoningCapability {
    let CatalogModelLookup::Found(entry) = catalog.lookup(model) else {
        return capability;
    };
    let setting = entry.get("codexUltra").and_then(Value::as_object);
    let Some(setting) = setting else {
        return capability;
    };

    let enabled = setting
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !enabled {
        let mut capability = capability;
        capability.codex_ultra_orchestration = None;
        return capability;
    }
    let Some(provider_effort) = setting
        .get("providerEffort")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        log::warn!("Codex Ultra for model {model} is enabled without providerEffort");
        return capability;
    };
    // Migrate legacy maintained targets while retaining explicit choices.
    let explicit_capability_declaration = capability
        .source
        .as_deref()
        .is_some_and(|source| matches!(source, "user" | "user_confirmed_detection"))
        || (capability.source.as_deref() == Some("provider_config")
            && capability.confidence == Some(CapabilityConfidence::Authoritative));
    if provider_effort == "xhigh"
        && setting.get("providerEffortSource").and_then(Value::as_str) != Some("user")
        && !explicit_capability_declaration
        && capability
            .codex_ultra_orchestration
            .as_ref()
            .is_some_and(|ultra| ultra.enabled && ultra.provider_effort.as_deref() == Some("max"))
    {
        return capability;
    }
    if !capability
        .supported_efforts
        .iter()
        .any(|effort| effort == provider_effort)
    {
        log::warn!(
            "Codex Ultra for model {model} selects unsupported provider effort {provider_effort}"
        );
        return capability;
    }

    let original = capability.clone();
    let mut capability = capability;
    // Ultra's product-level target is independent of the native effort map.
    // Never rewrite a real provider `max` mapping to change synthetic Ultra;
    // legacy effortMap.max remains a read-only fallback for old declarations.
    capability.codex_ultra_orchestration = Some(
        crate::proxy::providers::codex_reasoning::CodexUltraOrchestrationCapability {
            enabled: true,
            provider_effort: Some(provider_effort.to_string()),
        },
    );
    capability
        .validate()
        .map(|_| capability)
        .unwrap_or_else(|error| {
            log::warn!("Codex Ultra for model {model} is invalid: {error}");
            original
        })
}

fn resolved_with_catalog_ultra_setting(
    catalog: ModelCatalog<'_>,
    model: &str,
    source: CapabilitySource,
    capability: CodexModelReasoningCapability,
) -> ResolvedModelCapability {
    let mut capability = apply_catalog_ultra_setting(catalog, model, capability);
    if !is_explicit_reasoning_declaration(&capability) {
        capability.evidence_scope = reasoning_evidence_scope_for_catalog(catalog, model);
    }
    ResolvedModelCapability {
        fingerprint: capability_fingerprint(&capability),
        capability: Some(capability),
        source,
    }
}

/// The desktop cache is shared with generated third-party picker catalogs.
/// A matching slug alone therefore cannot prove an OpenAI wire contract for
/// arbitrary relay models. Keep the historical OpenAI-family fallback, while
/// accepting future official names only behind an exact, safe native endpoint.
fn official_cache_fallback_matches_context(settings: &Value, wire_model: &str) -> bool {
    let model = wire_model.trim().to_ascii_lowercase();
    let model = model.strip_prefix("openai/").unwrap_or(&model);
    let openai_family = model.starts_with("gpt-")
        || model.starts_with("chatgpt-")
        || model.starts_with("codex-")
        || model.strip_prefix('o').is_some_and(|suffix| {
            let digits = suffix.bytes().take_while(u8::is_ascii_digit).count();
            digits > 0
                && suffix[digits..]
                    .chars()
                    .next()
                    .is_none_or(|boundary| matches!(boundary, '-' | '.'))
        });
    if openai_family {
        return true;
    }
    let Some(base_url) = provider_metadata::base_url_from_settings(settings)
        .and_then(|base_url| {
            crate::codex_multirouter::protocol_capability::normalize_protocol_capability_base_url(
                &base_url,
            )
        })
        .and_then(|base_url| url::Url::parse(&base_url).ok())
    else {
        return false;
    };
    if base_url.scheme() != "https" || base_url.port().is_some() {
        return false;
    }
    match base_url.host_str() {
        Some("api.openai.com") => true,
        Some("chatgpt.com" | "chat.openai.com") => {
            let path = base_url.path().trim_end_matches('/');
            path == "/backend-api/codex" || path.starts_with("/backend-api/codex/")
        }
        _ => false,
    }
}

/// Resolver 核心（settings-based、纯函数、无网络、无全局状态）。
///
/// 所有消费者（catalog 投影、请求转换、Sub-Agent policy、GUI/CLI inspect）
/// 必须经由该核心，保证同一模型四层 fingerprint 一致。任何一层绕过该核心
/// 重新按模型名猜测档位都视为实现失败。
///
/// 来源优先级（高 → 低）：
/// 1. 用户模型级声明（始终最高优先级）；
/// 2. 动态检测候选快照（TTL、只读元数据）；
/// 3. CCSM 维护的版本化能力库；
/// 4. 内置清单（deepseek-v4 / k3）；
/// 5. Codex 官方模型缓存（仅 `platform=None` 即未知平台生效；OpenRouter/vLLM
///    等已知聚合平台有自己的推理接口，不得套用官方 OpenAI 形态）；
/// 6. Unknown（fail-closed）。
pub fn resolve_codex_model_capability_core(
    settings: &Value,
    platform: Option<&str>,
    model: &str,
    detection: Option<&ProviderCapabilitySnapshot>,
    library: Option<&catalog::CapabilityLibrary>,
    official_models: &[Value],
) -> ResolvedModelCapability {
    resolve_codex_model_capability_core_for_catalog(
        ModelCatalog::new(settings),
        platform,
        model,
        detection,
        library,
        official_models,
    )
}

fn resolve_codex_model_capability_core_for_catalog(
    catalog: ModelCatalog<'_>,
    platform: Option<&str>,
    model: &str,
    detection: Option<&ProviderCapabilitySnapshot>,
    library: Option<&catalog::CapabilityLibrary>,
    official_models: &[Value],
) -> ResolvedModelCapability {
    let settings = catalog.settings;
    // Catalog row selection precedes exclusion or capability parsing, so an
    // exact public model is never replaced by a sibling's upstream alias.
    // An excluded or ambiguous identity cannot be revived by lower sources.
    let catalog_model = catalog.lookup(model);
    if matches!(catalog_model, CatalogModelLookup::Ambiguous)
        || matches!(
            catalog_model,
            CatalogModelLookup::Found(entry)
                if entry.get("enabled").and_then(Value::as_bool) == Some(false)
        )
    {
        return ResolvedModelCapability {
            capability: None,
            source: CapabilitySource::Unknown,
            fingerprint: String::new(),
        };
    }

    // A display/public name is not a provider contract. Normalize against
    // the selected row's current wire identity, not a renamed GPT-looking
    // public alias, while keeping the same row authoritative for exclusion
    // and product-level settings.
    let wire_model = match catalog_model {
        CatalogModelLookup::Found(entry) => ["upstreamModel", "upstream_model"]
            .iter()
            .find_map(|key| entry.get(*key))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|wire| !wire.is_empty())
            .or_else(|| {
                ["model", "id", "slug"]
                    .iter()
                    .find_map(|key| entry.get(*key))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|canonical| !canonical.is_empty())
            })
            .unwrap_or(model),
        _ => model,
    };
    let normalize_platform_capability =
        |capability| normalize_provider_reasoning_capability(platform, wire_model, capability);

    // 1. 用户模型级声明（始终最高优先级）
    let declared = match catalog_model {
        CatalogModelLookup::Found(entry) => reasoning_capability_from_model_entry(entry),
        _ => None,
    };
    if let Some(capability) = declared
        .filter(|capability| capability_matches_context(catalog, platform, model, capability))
    {
        return resolved_with_catalog_ultra_setting(
            catalog,
            model,
            CapabilitySource::UserConfig,
            normalize_platform_capability(capability),
        );
    }

    // 2. A declaration parsed from the currently selected TOML provider is
    // explicit current configuration, not a previously persisted automatic
    // projection. Only this parsing branch is trusted without a saved scope;
    // catalog/provider-wide source=provider_config still requires provenance.
    if let Some(capability) = resolve_reasoning_capability_from_provider_config(settings, model) {
        return resolved_with_catalog_ultra_setting(
            catalog,
            model,
            CapabilitySource::ProviderConfig,
            normalize_platform_capability(capability),
        );
    }

    // 3. 动态检测候选（只读元数据，TTL）
    if let Some(snapshot) =
        detection.filter(|snapshot| snapshot_matches_context(catalog, platform, model, snapshot))
    {
        if let Some(capability) = snapshot_to_capability(snapshot) {
            return resolved_with_catalog_ultra_setting(
                catalog,
                model,
                CapabilitySource::Detection,
                normalize_platform_capability(capability),
            );
        }
    }

    // 4. CCSM 维护的版本化能力库
    if let Some(library) = library {
        if let Some(capability) = catalog::lookup_library_capability(library, platform, model) {
            return resolved_with_catalog_ultra_setting(
                catalog,
                model,
                CapabilitySource::Library,
                normalize_platform_capability(capability),
            );
        }
    }

    // 5. 内置清单
    // Builtins use a vendor-native string contract. They are safe only
    // for an unknown provider or the exact official DeepSeek platform; a
    // known aggregator may expose the same model through a different wire
    // shape, so applying this fallback there would silently mis-encode the
    // request instead of failing closed.
    if platform.is_none()
        || (platform == Some("deepseek")
            && wire_model
                .trim()
                .to_ascii_lowercase()
                .starts_with("deepseek-"))
    {
        if let Some(capability) = builtin_reasoning_capability_for_model(wire_model) {
            return resolved_with_catalog_ultra_setting(
                catalog,
                model,
                CapabilitySource::Builtin,
                normalize_platform_capability(capability),
            );
        }
    }

    // 6. The shared desktop cache may contain generated third-party rows.
    // Unknown relay models cannot inherit OpenAI controls from a matching slug;
    // require an OpenAI-family identity or trusted native endpoint provenance.
    if platform.is_none() && official_cache_fallback_matches_context(settings, wire_model) {
        if let Some(capability) =
            official_reasoning_capability_for_model(wire_model, official_models)
        {
            return resolved_with_catalog_ultra_setting(
                catalog,
                model,
                CapabilitySource::Official,
                normalize_platform_capability(capability),
            );
        }
    }

    // 7. Sublyx GPT fallback.  This is deliberately gated by the detected
    // provider platform; a model suffix such as `-sublyx` on OpenRouter (or
    // any other aggregator) must not inherit the Sublyx wire contract.
    if platform == Some("sublyx") {
        if let Some(capability) = sublyx_reasoning_capability_for_model(wire_model) {
            return resolved_with_catalog_ultra_setting(
                catalog,
                model,
                CapabilitySource::ProviderFallback,
                normalize_platform_capability(capability),
            );
        }
    }

    // 8. Unknown（fail-closed）
    ResolvedModelCapability {
        capability: None,
        source: CapabilitySource::Unknown,
        fingerprint: String::new(),
    }
}

fn resolve_reasoning_capability_from_provider_config(
    settings: &Value,
    model: &str,
) -> Option<CodexModelReasoningCapability> {
    let config_text = settings.get("config").and_then(Value::as_str)?;
    let config = toml::from_str::<toml::Value>(config_text).ok()?;
    let active_provider = config
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|provider| !provider.is_empty());
    let providers = config.get("model_providers")?.as_table()?;
    // Inline metadata is authoritative only for the explicitly selected
    // provider. A sole table is not an active-provider declaration: drafts
    // and stale configs can retain an unselected table, so guessing here
    // reintroduces capabilities that Codex will not actually use.
    let provider_id = active_provider?;
    let provider = providers.get(provider_id)?;
    let models = provider.get("models").and_then(toml::Value::as_array)?;
    for model_entry in models {
        let Ok(model_json) = serde_json::to_value(model_entry) else {
            continue;
        };
        let matches_model = ["model", "id", "slug", "upstreamModel", "upstream_model"]
            .into_iter()
            .filter_map(|field| model_json.get(field).and_then(Value::as_str))
            .any(|candidate| candidate.trim().eq_ignore_ascii_case(model.trim()));
        if !matches_model {
            continue;
        }
        if let Some(capability) = reasoning_capability_from_provider_model_entry(&model_json) {
            return Some(capability);
        }
    }
    None
}

/// 把检测快照转换为已校验的能力。
///
/// 非法快照（如 `default_effort` 不在 `supported_efforts` 内）返回 None，
/// 继续落到库/内置——绝不信任畸形检测为 confirmed。
pub fn snapshot_to_capability(
    snapshot: &ProviderCapabilitySnapshot,
) -> Option<CodexModelReasoningCapability> {
    let reasoning = snapshot.reasoning.as_ref()?;
    let efforts: Vec<String> = reasoning
        .supported_efforts
        .iter()
        .map(|effort| effort.trim().to_ascii_lowercase())
        .filter(|effort| !effort.is_empty())
        .collect();
    let codex_ultra_enabled = efforts.iter().any(|effort| effort == "ultra");
    if codex_ultra_enabled
        && (reasoning.codex_ultra_orchestration.is_some()
            || !efforts.iter().any(|effort| effort == "max"))
    {
        // Only legacy snapshots may encode the synthetic selector in the
        // effort list. Explicit canonical metadata keeps it out of native
        // efforts and supplies the provider target in its separate overlay.
        return None;
    }
    let efforts = efforts
        .into_iter()
        .filter(|effort| effort != "ultra")
        .collect::<Vec<_>>();
    let default_effort = reasoning
        .default_effort
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase);
    if reasoning.mandatory
        && (reasoning
            .supported_efforts
            .iter()
            .any(|effort| effort.trim().eq_ignore_ascii_case("none"))
            || default_effort.as_deref() == Some("none")
            || reasoning.default_enabled == Some(false))
    {
        return None;
    }
    let default_effort = default_effort.map(|effort| {
        if effort == "ultra" && reasoning.codex_ultra_orchestration.is_none() {
            "max".to_string()
        } else {
            effort
        }
    });

    let inferred_disable_allowed =
        !reasoning.mandatory || efforts.iter().any(|effort| effort == "none");
    let disable_allowed = reasoning
        .disable_allowed
        .unwrap_or(inferred_disable_allowed);
    if reasoning.mandatory && disable_allowed {
        return None;
    }
    let graded_efforts: Vec<String> = efforts
        .iter()
        .filter(|effort| **effort != "none")
        .cloned()
        .collect();

    let inferred_control_kind = if !graded_efforts.is_empty() {
        ReasoningControlKind::Graded
    } else if reasoning.supports_max_tokens {
        ReasoningControlKind::Budget
    } else {
        // The provider explicitly returned a reasoning capability object, but
        // did not advertise a switch, budget, or effort levels. Preserve that
        // positive evidence as "no provider-side control"; the UI can show
        // reasoning is present while still using the server default.
        ReasoningControlKind::None
    };
    let control_kind = reasoning.control_kind.unwrap_or(inferred_control_kind);

    // `none` is a Codex control sentinel, not an OpenRouter/provider effort.
    // Preserve it only when the provider explicitly advertised it; do not add
    // it merely because reasoning can be disabled, otherwise library and
    // detected capabilities get different fingerprints for the same contract.
    let mut supported_efforts = graded_efforts.clone();
    if efforts.iter().any(|effort| effort == "none") {
        supported_efforts.insert(0, "none".to_string());
    }

    let upstream_format = reasoning
        .upstream_format
        .clone()
        .unwrap_or_else(|| "object".to_string());
    let upstream_format = if upstream_format == "object" {
        "reasoning_object".to_string()
    } else {
        upstream_format
    };

    let capability = CodexModelReasoningCapability {
        schema_version: Some(2),
        support_status: Some(
            reasoning
                .support_status
                .unwrap_or(ReasoningSupportStatus::ConfirmedSupported),
        ),
        control_kind: Some(control_kind),
        supported: None,
        supported_efforts,
        default_effort,
        disable_allowed,
        upstream: CodexModelReasoningUpstream {
            format: upstream_format,
            parameter: reasoning
                .upstream_parameter
                .clone()
                .unwrap_or_else(|| "reasoning.effort".to_string()),
            effort_map: reasoning.effort_map.clone().unwrap_or_else(|| {
                graded_efforts
                    .iter()
                    .map(|effort| (effort.clone(), effort.clone()))
                    .collect()
            }),
        },
        output_format: reasoning.output_format.clone(),
        source: Some("detection".to_string()),
        confidence: Some(CapabilityConfidence::Verified),
        fetched_at: Some(snapshot.fetched_at.to_string()),
        provider_key: Some(snapshot.provider_key.clone()),
        evidence_scope: snapshot.evidence_scope.clone(),
        model_revision: None,
        codex_ultra_orchestration: reasoning.codex_ultra_orchestration.clone().or_else(|| {
            codex_ultra_enabled.then_some(
                crate::proxy::providers::codex_reasoning::CodexUltraOrchestrationCapability {
                    enabled: true,
                    provider_effort: None,
                },
            )
        }),
    };

    capability.validate().ok().map(|_| capability)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::providers::codex_reasoning::ReasoningControlKind;
    use serde_json::json;

    #[test]
    fn detection_revision_changes_on_replacement_and_each_ttl_boundary() {
        let mut cache = DetectionCache::default();
        let start = Instant::now();
        let next = start + Duration::from_secs(10);
        let snapshot = |model: &str| ProviderCapabilitySnapshot {
            provider_key: "provider".into(),
            model: model.into(),
            ..Default::default()
        };

        cache.insert_at(snapshot("first"), start);
        let first_revision = cache.revision;
        cache.insert_at(snapshot("second"), next);
        assert_ne!(cache.revision, first_revision);
        let before_expiry = cache.revision;
        cache.prune_expired_at(start + DETECTION_TTL - Duration::from_millis(1));
        assert_eq!(cache.revision, before_expiry);
        cache.prune_expired_at(start + DETECTION_TTL);
        assert_ne!(cache.revision, before_expiry);
        assert_eq!(cache.entries.len(), 1);

        let after_expiry = cache.revision;
        cache.insert_at(snapshot("second"), start + DETECTION_TTL);
        assert_ne!(cache.revision, after_expiry);
        let replacement_revision = cache.revision;
        cache.prune_expired_at(next + DETECTION_TTL);
        assert_eq!(cache.revision, replacement_revision);
        assert_eq!(cache.entries.len(), 1);
        cache.prune_expired_at(start + DETECTION_TTL * 2);
        assert_ne!(cache.revision, replacement_revision);
        assert!(cache.entries.is_empty());
    }

    fn provider_with_catalog(model: &str, reasoning: Option<serde_json::Value>) -> Provider {
        let mut entry = json!({ "model": model });
        if let Some(reasoning) = reasoning {
            entry["reasoning"] = reasoning;
        }
        Provider {
            id: "test-provider".into(),
            name: "Test Provider".into(),
            settings_config: json!({ "modelCatalog": { "models": [entry] } }),
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
    fn materialized_provider_does_not_reintroduce_ephemeral_source_catalog() {
        let mut provider = provider_with_catalog("canonical-model", None);
        crate::codex_multirouter::catalog::share_provider_catalog(&mut provider);

        let resolved = resolve_codex_model_capability_for_model_source(
            &provider,
            "missing-model",
            &json!({ "reasoning": user_declared_reasoning() }),
        );

        assert_eq!(resolved.source, CapabilitySource::Unknown);
        assert!(resolved.capability.is_none());
    }

    fn plain_provider(name: &str, base_url: &str) -> Provider {
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

    const SCOPED_PROVIDER_ENDPOINTS: [&str; 6] = [
        "https://openrouter.ai/api/v1",
        "https://api.sublyx.org/v1",
        "https://vllm.local/v1",
        "https://api.deepseek.com/v1",
        "https://api.z.ai/api/paas/v4",
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
    ];

    fn automatic_capability(source: &str) -> CodexModelReasoningCapability {
        let mut capability = reasoning_capability_from_model_entry(&json!({
            "reasoning": user_declared_reasoning(),
        }))
        .expect("test capability");
        capability.source = Some(source.into());
        capability
    }

    #[test]
    fn automatic_catalog_evidence_requires_current_scope_but_explicit_declarations_survive() {
        for endpoint in SCOPED_PROVIDER_ENDPOINTS {
            for source in [
                "detection",
                "library",
                "builtin",
                "official",
                "provider",
                "sublyx",
            ] {
                let mut provider = plain_provider("Provider", endpoint);
                let mut capability = automatic_capability(source);
                provider.settings_config["modelCatalog"] = json!({"models": [{
                    "model": "public-model", "upstreamModel": "wire-model", "reasoning": capability,
                }]});
                let unresolved = resolve_codex_model_capability_with_library(
                    &provider,
                    "public-model",
                    None,
                    None,
                );
                assert!(
                    unresolved.capability.is_none(),
                    "{endpoint} inherited unscoped {source}"
                );

                for explicit_source in [None, Some("user"), Some("user_confirmed_detection")] {
                    capability.source = explicit_source.map(str::to_string);
                    provider.settings_config["modelCatalog"]["models"][0]["reasoning"] =
                        serde_json::to_value(&capability).unwrap();
                    let declared = resolve_codex_model_capability_with_library(
                        &provider,
                        "public-model",
                        None,
                        None,
                    );
                    assert_eq!(declared.source, CapabilitySource::UserConfig);
                    assert_eq!(
                        declared.capability.unwrap().supported_efforts,
                        vec!["low", "high"]
                    );
                }
            }
        }
    }

    #[test]
    fn authorized_persisted_detection_gets_one_canonical_provider_identity() {
        let mut provider = plain_provider("Scoped provider", "https://relay.example/v1");
        provider.id = "source-provider".to_string();
        let mut capability = automatic_capability("detection");
        capability.confidence = Some(CapabilityConfidence::Verified);
        capability.evidence_scope =
            reasoning_evidence_scope("https://relay.example/v1", "wire-model");
        provider.settings_config["modelCatalog"] = json!({"models": [{
            "model": "public-model", "upstreamModel": "wire-model", "aliases": ["friendly-model"],
            "reasoning": capability,
        }]});
        let original_settings = provider.settings_config.clone();
        let expected_fingerprint = capability_fingerprint(&capability);
        for requested in ["public-model", "friendly-model", "wire-model"] {
            let resolved =
                resolve_codex_model_capability_with_library(&provider, requested, None, None);
            let source = resolved
                .capability
                .expect("current scoped persisted detection");
            assert_eq!(source.provider_key.as_deref(), Some("source-provider"));
            assert_eq!(source.supported_efforts, capability.supported_efforts);
            assert_eq!(source.evidence_scope, capability.evidence_scope);
            assert_eq!(resolved.fingerprint, expected_fingerprint);
            let mut routed = provider.clone();
            routed.id = "router-visible-provider".to_string();
            routed.settings_config["codexResolvedTargetProviderId"] = json!("source-provider");
            let routed_resolution =
                resolve_codex_model_capability_with_library(&routed, requested, None, None);
            assert_eq!(routed_resolution.capability, Some(source));
            assert_eq!(routed_resolution.fingerprint, expected_fingerprint);
        }
        assert_eq!(
            provider.settings_config, original_settings,
            "derived identity is not persisted by a reader"
        );

        let without_identity = resolve_codex_model_capability_for_settings(
            &provider.settings_config,
            None,
            None,
            "public-model",
            None,
            &[],
            |_| None,
        );
        assert_eq!(
            without_identity.capability.unwrap().provider_key,
            None,
            "settings-only inspection must not invent an identity"
        );
        provider.settings_config["base_url"] = json!("https://other-relay.example/v1");
        let stale =
            resolve_codex_model_capability_with_library(&provider, "public-model", None, None);
        assert!(
            stale.capability.is_none(),
            "missing identity enrichment cannot revive stale transport evidence"
        );
    }

    #[test]
    fn automatic_catalog_scope_isolates_every_known_endpoint_and_wire_model() {
        for endpoint in SCOPED_PROVIDER_ENDPOINTS {
            let mut provider = plain_provider("Provider", endpoint);
            let mut capability = automatic_capability("detection");
            capability.evidence_scope = reasoning_evidence_scope(endpoint, "wire-model");
            provider.settings_config["modelCatalog"] = json!({"models": [{
                "model": "public-model", "upstreamModel": "wire-model", "reasoning": capability,
            }]});
            let valid =
                resolve_codex_model_capability_with_library(&provider, "public-model", None, None);
            assert!(
                valid.capability.is_some(),
                "current evidence rejected for {endpoint}"
            );
            for other_endpoint in SCOPED_PROVIDER_ENDPOINTS {
                if other_endpoint == endpoint {
                    continue;
                }
                provider.settings_config["base_url"] = json!(other_endpoint);
                let changed = resolve_codex_model_capability_with_library(
                    &provider,
                    "public-model",
                    None,
                    None,
                );
                assert!(
                    changed.capability.is_none(),
                    "{endpoint} evidence leaked into {other_endpoint}"
                );
            }
            provider.settings_config["base_url"] = json!(endpoint);
            provider.settings_config["modelCatalog"]["models"][0]["upstreamModel"] =
                json!("new-wire");
            let renamed =
                resolve_codex_model_capability_with_library(&provider, "public-model", None, None);
            assert!(
                renamed.capability.is_none(),
                "old wire evidence survived remapping for {endpoint}"
            );
        }
    }

    #[test]
    fn detection_scope_rejects_cross_platform_and_unrelated_model_snapshots() {
        let mut provider = plain_provider("vLLM", "https://vllm.local/v1");
        let mut snapshot = openrouter_detection_snapshot();
        snapshot.model = "wire-model".into();
        snapshot.evidence_scope =
            reasoning_evidence_scope_for_settings(&provider.settings_config, "wire-model");
        let crossed = resolve_codex_model_capability_with_library(
            &provider,
            "wire-model",
            Some(&snapshot),
            None,
        );
        assert!(
            crossed.capability.is_none(),
            "OpenRouter source cannot become vLLM evidence"
        );

        provider.settings_config["base_url"] = json!("https://openrouter.ai/api/v1");
        snapshot.evidence_scope =
            reasoning_evidence_scope_for_settings(&provider.settings_config, "wire-model");
        snapshot.model = "different-model".into();
        let wrong_model = resolve_codex_model_capability_with_library(
            &provider,
            "wire-model",
            Some(&snapshot),
            None,
        );
        assert!(
            wrong_model.capability.is_none(),
            "an unrelated model snapshot cannot be adopted"
        );
    }

    #[test]
    fn scoped_detection_cache_uses_current_target_wire_and_rejects_endpoint_edits() {
        let mut provider = plain_provider("OpenRouter", "https://openrouter.ai/api/v1");
        provider.id = "scope-test-router".into();
        provider.settings_config["codexResolvedTargetProviderId"] = json!("scope-test-target");
        provider.settings_config["modelCatalog"] = json!({"models": [{
            "model": "public-model", "aliases": ["friendly"], "upstreamModel": "wire-model",
        }]});
        let mut snapshot = openrouter_detection_snapshot();
        snapshot.provider_key = "scope-test-target".into();
        snapshot.model = "wire-model".into();
        snapshot.evidence_scope =
            reasoning_evidence_scope_for_settings(&provider.settings_config, "public-model");
        detection_cache().lock().unwrap().insert(snapshot.clone());
        for model in ["public-model", "friendly", "wire-model"] {
            assert!(
                current_detection_for_provider(&provider, model).is_some(),
                "{model}"
            );
        }
        provider.settings_config["base_url"] = json!("https://another-openrouter.example/api/v1");
        assert!(current_detection_for_provider(&provider, "public-model").is_none());
        provider.settings_config["base_url"] = json!("https://openrouter.ai/api/v1");
        provider.settings_config["modelCatalog"]["models"][0]["enabled"] = json!(false);
        assert!(current_detection_for_provider(&provider, "public-model").is_none());
        provider.settings_config["modelCatalog"]["models"][0]["enabled"] = json!(true);
        snapshot.evidence_scope = None;
        detection_cache().lock().unwrap().insert(snapshot);
        assert!(current_detection_for_provider(&provider, "public-model").is_none());
    }

    #[test]
    fn official_deepseek_does_not_inherit_kimi_builtin_contract() {
        for model in ["k3", "k3-256k"] {
            let resolved = resolve_codex_model_capability_core(
                &json!({}),
                Some("deepseek"),
                model,
                None,
                None,
                &[],
            );
            assert!(
                resolved.capability.is_none(),
                "DeepSeek endpoint inherited Kimi {model}"
            );
            let legacy =
                resolve_codex_model_capability_core(&json!({}), None, model, None, None, &[]);
            assert_eq!(legacy.source, CapabilitySource::Builtin);
        }
        let deepseek = resolve_codex_model_capability_core(
            &json!({}),
            Some("deepseek"),
            "deepseek-v4-pro",
            None,
            None,
            &[],
        );
        assert_eq!(deepseek.source, CapabilitySource::Builtin);
    }

    #[test]
    fn reasoning_evidence_scope_normalizes_api_identity_without_serializing_secrets() {
        let normal =
            reasoning_evidence_scope("https://API.example:443/v1/", " Wire-Model ").unwrap();
        let same = reasoning_evidence_scope("https://api.example/v1", "wire-model").unwrap();
        assert_eq!(normal, same);
        assert_eq!(normal.transport_fingerprint.len(), 64);
        assert_ne!(
            Some(normal.clone()),
            reasoning_evidence_scope("https://api.example/v2", "wire-model")
        );
        for unsafe_url in [
            "https://secret-user:secret-pass@api.example/v1",
            "https://api.example/v1?api_key=secret-token",
            "https://api.example/v1#secret-token",
            "file:///secret-token",
        ] {
            assert!(reasoning_evidence_scope(unsafe_url, "wire-model").is_none());
        }
        let serialized = serde_json::to_string(&normal).unwrap();
        assert!(!serialized.contains("api.example"));
        assert!(!serialized.contains("secret"));
    }

    #[test]
    fn upstream_metadata_official_deepseek_library_respects_provider_and_catalog_authority() {
        let library = catalog::load_library_from_str(include_str!(
            "../../resources/reasoning-capabilities.json"
        ))
        .expect("valid maintained library");
        for model in ["deepseek-flash", "deepseek-v4-pro"] {
            let provider = plain_provider("DeepSeek Official", "https://api.deepseek.com/v1");
            let resolved =
                resolve_codex_model_capability_with_library(&provider, model, None, Some(&library));
            assert_eq!(resolved.source, CapabilitySource::Library);
            let capability = resolved
                .capability
                .expect("official DeepSeek maintained capability");
            assert_eq!(
                capability.supported_efforts,
                vec!["none", "low", "high", "max"]
            );
            assert_eq!(capability.default_effort.as_deref(), Some("high"));
            for (effort, expected) in [("minimal", "low"), ("medium", "high"), ("xhigh", "high")] {
                assert_eq!(
                    capability
                        .upstream
                        .effort_map
                        .get(effort)
                        .map(String::as_str),
                    Some(expected)
                );
            }
            assert!(capability.codex_ultra_orchestration.is_none());
            assert!(!capability.upstream.effort_map.contains_key("ultra"));
            let projected =
                crate::proxy::providers::codex_reasoning::resolve_subagent_reasoning_capability(
                    Some(&capability),
                );
            use crate::proxy::providers::codex_reasoning::CodexReasoningEffort as Effort;
            assert_eq!(projected.provider_default_effort, Some(Effort::High));
            assert_eq!(
                projected.effort_map.get(&Effort::Medium),
                Some(&Effort::High)
            );
            assert!(!projected.codex_selectable_efforts.contains(&Effort::Ultra));

            let gateway = plain_provider("DeepSeek Gateway", "https://gateway.example/v1");
            let resolved =
                resolve_codex_model_capability_with_library(&gateway, model, None, Some(&library));
            assert_ne!(resolved.source, CapabilitySource::Library);
            let mut excluded = provider.clone();
            excluded.settings_config["modelCatalog"] =
                json!({"models": [{"model": model, "enabled": false}]});
            let resolved =
                resolve_codex_model_capability_with_library(&excluded, model, None, Some(&library));
            assert!(
                resolved.capability.is_none(),
                "library never revives an excluded canonical row"
            );
        }
    }

    fn user_declared_reasoning() -> serde_json::Value {
        json!({
            "schemaVersion": 2,
            "supportStatus": "confirmed_supported",
            "controlKind": "graded",
            "supportedEfforts": ["low", "high"],
            "defaultEffort": "high",
            "disableAllowed": false,
            "upstream": {"format": "string", "parameter": "reasoning_effort"},
            "source": "user"
        })
    }

    fn native_max_reasoning(source: &str) -> serde_json::Value {
        let mut reasoning = user_declared_reasoning();
        reasoning["supportedEfforts"] = json!(["low", "high", "max"]);
        reasoning["defaultEffort"] = json!("max");
        reasoning["upstream"] =
            json!({"format": "reasoning_object", "parameter": "reasoning.effort"});
        reasoning["source"] = json!(source);
        reasoning
    }

    #[test]
    fn provider_fallback_accepts_valid_modern_provider_declarations() {
        for field in ["reasoning", "codexChatReasoning", "codex_chat_reasoning"] {
            let mut provider = provider_with_catalog("provider-fallback-custom", None);
            provider.settings_config[field] = user_declared_reasoning();
            let resolved = resolve_codex_model_capability_with_library(
                &provider,
                "provider-fallback-custom",
                None,
                None,
            );
            assert_eq!(resolved.source.as_str(), "provider", "{field}");
            assert_eq!(serde_json::to_value(resolved.source).unwrap(), "provider");
            let capability = resolved.capability.expect("validated provider fallback");
            assert_eq!(capability.supported_efforts, vec!["low", "high"]);
            assert_eq!(resolved.fingerprint, capability_fingerprint(&capability));
        }
    }

    #[test]
    fn provider_fallback_follows_canonical_then_upstream_evidence() {
        let mut provider = provider_with_catalog("provider-fallback-public", None);
        provider.settings_config["modelCatalog"]["models"][0]["upstreamModel"] =
            json!("deepseek-v4-pro");
        provider.settings_config["reasoning"] = user_declared_reasoning();
        provider.settings_config["base_url"] = json!("https://example.com/v1");
        let mut detection = openrouter_detection_snapshot();
        detection.model = "provider-fallback-public".into();
        detection.evidence_scope =
            reasoning_evidence_scope_for_settings(&provider.settings_config, &detection.model);
        detection.reasoning.as_mut().unwrap().supported_efforts = vec!["low".into()];
        detection.reasoning.as_mut().unwrap().default_effort = Some("low".into());

        let canonical = resolve_codex_model_capability_with_library(
            &provider,
            "provider-fallback-public",
            Some(&detection),
            None,
        );
        assert_eq!(canonical.source, CapabilitySource::Detection);
        assert_eq!(canonical.capability.unwrap().supported_efforts, vec!["low"]);

        let upstream = resolve_codex_model_capability_with_library(
            &provider,
            "provider-fallback-public",
            None,
            None,
        );
        assert_eq!(upstream.source, CapabilitySource::Builtin);
        assert_eq!(
            upstream.capability.unwrap().supported_efforts,
            vec!["low", "high", "max"]
        );

        provider.settings_config["modelCatalog"]["models"][0]["reasoning"] =
            user_declared_reasoning();
        let declared = resolve_codex_model_capability_with_library(
            &provider,
            "provider-fallback-public",
            Some(&detection),
            None,
        );
        assert_eq!(declared.source, CapabilitySource::UserConfig);
        assert_eq!(
            declared.capability.unwrap().supported_efforts,
            vec!["low", "high"]
        );
    }

    #[test]
    fn provider_fallback_applies_the_canonical_rows_ultra_setting() {
        let mut provider = provider_with_catalog("provider-fallback-ultra", None);
        provider.settings_config["reasoning"] = user_declared_reasoning();
        provider.settings_config["modelCatalog"]["models"][0]["codexUltra"] =
            json!({"enabled": true, "providerEffort": "high"});
        let resolved = resolve_codex_model_capability_with_library(
            &provider,
            "provider-fallback-ultra",
            None,
            None,
        );
        assert_eq!(resolved.source.as_str(), "provider");
        let capability = resolved
            .capability
            .expect("provider fallback with row Ultra");
        let projected =
            crate::proxy::providers::codex_reasoning::resolve_subagent_reasoning_capability(Some(
                &capability,
            ));
        assert_eq!(capability.supported_efforts, vec!["low", "high"]);
        assert!(projected
            .codex_selectable_efforts
            .contains(&crate::proxy::providers::codex_reasoning::CodexReasoningEffort::Ultra,));
        assert_eq!(resolved.fingerprint, capability_fingerprint(&capability));
    }

    #[test]
    fn provider_fallback_preserves_supplied_alias_detection_without_promoting_wire_detection() {
        let mut provider = provider_with_catalog("provider-fallback-detection-public", None);
        provider.settings_config["modelCatalog"]["models"][0]["aliases"] =
            json!(["provider-fallback-detection-alias"]);
        provider.settings_config["modelCatalog"]["models"][0]["upstreamModel"] =
            json!("provider-fallback-detection-wire");
        provider.settings_config["reasoning"] = user_declared_reasoning();
        provider.settings_config["base_url"] = json!("https://example.com/v1");
        let mut detection = openrouter_detection_snapshot();
        detection.model = "provider-fallback-detection-alias".into();
        detection.evidence_scope =
            reasoning_evidence_scope_for_settings(&provider.settings_config, &detection.model);
        detection.reasoning.as_mut().unwrap().supported_efforts = vec!["low".into()];
        detection.reasoning.as_mut().unwrap().default_effort = Some("low".into());
        let alias = resolve_codex_model_capability_with_library(
            &provider,
            "provider-fallback-detection-alias",
            Some(&detection),
            None,
        );
        assert_eq!(alias.source, CapabilitySource::Detection);
        assert_eq!(alias.capability.unwrap().supported_efforts, vec!["low"]);
        let runtime_alias = resolve_codex_model_capability(
            &provider,
            "provider-fallback-detection-alias",
            Some(&detection),
        );
        assert_eq!(runtime_alias.source, CapabilitySource::Detection);
        assert_eq!(runtime_alias.fingerprint, alias.fingerprint);

        // Resolving a wire identity still checks its public row's stronger
        // canonical evidence before using the wire-only snapshot. The builtin
        // is evidence about the actual wire model, never a public-name guess.
        provider.settings_config["modelCatalog"]["models"][0]["upstreamModel"] =
            json!("deepseek-v4-pro");
        detection.model = "deepseek-v4-pro".into();
        detection.evidence_scope =
            reasoning_evidence_scope_for_settings(&provider.settings_config, &detection.model);
        let wire = resolve_codex_model_capability_with_library(
            &provider,
            "deepseek-v4-pro",
            Some(&detection),
            None,
        );
        assert_eq!(wire.source, CapabilitySource::Builtin);
        assert_eq!(
            wire.capability.unwrap().supported_efforts,
            vec!["low", "high", "max"]
        );
    }

    #[test]
    fn provider_fallback_wire_detection_keeps_the_canonical_rows_ultra_setting() {
        let mut provider = provider_with_catalog("provider-fallback-wire-public", None);
        provider.settings_config["reasoning"] = user_declared_reasoning();
        provider.settings_config["modelCatalog"]["models"][0]["upstreamModel"] =
            json!("provider-fallback-wire");
        provider.settings_config["modelCatalog"]["models"][0]["codexUltra"] =
            json!({"enabled": true, "providerEffort": "max"});
        provider.settings_config["base_url"] = json!("https://example.com/v1");
        let mut detection = openrouter_detection_snapshot();
        detection.model = "provider-fallback-wire".into();
        detection.evidence_scope =
            reasoning_evidence_scope_for_settings(&provider.settings_config, &detection.model);
        let resolved = resolve_codex_model_capability_for_settings(
            &provider.settings_config,
            None,
            Some(reasoning_provider_key(&provider)),
            "provider-fallback-wire-public",
            None,
            &[],
            |model| (model == "provider-fallback-wire").then(|| detection.clone()),
        );
        assert_eq!(resolved.source, CapabilitySource::Detection);
        let capability = resolved.capability.unwrap();
        assert_eq!(capability.supported_efforts, vec!["max", "high", "low"]);
        assert!(capability
            .codex_ultra_orchestration
            .as_ref()
            .is_some_and(|ultra| ultra.enabled));
        assert_eq!(
            capability.upstream.effort_map.get("max"),
            Some(&"max".into())
        );
        assert_eq!(resolved.fingerprint, capability_fingerprint(&capability));
    }

    #[test]
    fn provider_fallback_rejects_malformed_modern_or_legacy_transport_declarations() {
        for reasoning in [
            json!({"supportsThinking": true, "supportsEffort": true}),
            json!({"supportedEfforts": ["ultra"], "defaultEffort": "ultra"}),
            json!({"supportedEfforts": ["low"], "defaultEffort": "high"}),
        ] {
            let mut provider = provider_with_catalog("provider-fallback-invalid", None);
            provider.settings_config["reasoning"] = reasoning;
            let resolved = resolve_codex_model_capability_with_library(
                &provider,
                "provider-fallback-invalid",
                None,
                None,
            );
            assert!(resolved.capability.is_none());
        }
    }

    #[test]
    fn provider_fallback_does_not_revive_excluded_or_ambiguous_catalog_rows() {
        let mut provider = provider_with_catalog("provider-fallback-excluded", None);
        provider.settings_config["reasoning"] = user_declared_reasoning();
        provider.settings_config["modelCatalog"]["models"][0]["enabled"] = json!(false);
        provider.settings_config["modelCatalog"]["models"][0]["upstreamModel"] =
            json!("deepseek-v4-pro");
        for model in ["provider-fallback-excluded", "deepseek-v4-pro"] {
            let resolved =
                resolve_codex_model_capability_with_library(&provider, model, None, None);
            assert!(resolved.capability.is_none(), "{model}");
            assert_eq!(resolved.source, CapabilitySource::Unknown);
        }
        provider.settings_config["modelCatalog"]["models"] = json!([
            {"model": "first", "upstreamModel": "provider-fallback-ambiguous"},
            {"model": "second", "upstreamModel": "provider-fallback-ambiguous"}
        ]);
        let resolved = resolve_codex_model_capability_with_library(
            &provider,
            "provider-fallback-ambiguous",
            None,
            None,
        );
        assert!(resolved.capability.is_none());
    }

    #[test]
    fn provider_fallback_never_replaces_a_valid_empty_model_capability() {
        for status in ["unknown", "confirmed_unsupported"] {
            let mut provider = provider_with_catalog(
                "provider-fallback-empty",
                Some(json!({
                    "schemaVersion": 2,
                    "supportStatus": status,
                    "controlKind": if status == "unknown" {"unknown"} else {"none"},
                    "supportedEfforts": [],
                    "defaultEffort": null,
                    "disableAllowed": false,
                    "upstream": {"format": "none", "parameter": "none", "effortMap": {}},
                    "source": "user"
                })),
            );
            provider.settings_config["reasoning"] = user_declared_reasoning();
            let resolved = resolve_codex_model_capability_with_library(
                &provider,
                "provider-fallback-empty",
                None,
                None,
            );
            assert_eq!(resolved.source, CapabilitySource::UserConfig, "{status}");
            assert!(resolved.capability.unwrap().supported_efforts.is_empty());
        }
    }

    fn openrouter_detection_snapshot() -> ProviderCapabilitySnapshot {
        ProviderCapabilitySnapshot {
            provider_key: "test-provider".into(),
            model: "deepseek/deepseek-v4-pro".into(),
            fetched_at: 1_700_000_000_000,
            source: "openrouter_api".into(),
            evidence_scope: reasoning_evidence_scope(
                "https://openrouter.ai/api/v1",
                "deepseek/deepseek-v4-pro",
            ),
            reasoning: Some(ReasoningCapabilitySnapshot {
                supported_efforts: vec!["max".into(), "high".into(), "low".into()],
                default_effort: Some("high".into()),
                mandatory: false,
                default_enabled: Some(true),
                supports_max_tokens: false,
                upstream_format: Some("object".into()),
                upstream_parameter: Some("reasoning.effort".into()),
                output_format: Some("auto".into()),
                ..Default::default()
            }),
        }
    }

    fn library_with_openrouter_deepseek() -> catalog::CapabilityLibrary {
        catalog::load_library_from_str(
            r#"{
                "libraryVersion": 1,
                "verifiedAt": "2026-08-18",
                "entries": [{
                    "platform": "openrouter",
                    "model": "deepseek/deepseek-v4-pro",
                    "reasoning": {
                        "schemaVersion": 2,
                        "supportStatus": "confirmed_supported",
                        "controlKind": "graded",
                        "supportedEfforts": ["max", "high", "low"],
                        "defaultEffort": "high",
                        "disableAllowed": true,
                        "upstream": {"format": "object", "parameter": "reasoning.effort"},
                        "outputFormat": "auto",
                        "source": "library"
                    },
                    "sourceUrl": "https://openrouter.ai/api/v1/models",
                    "verifiedAt": "2026-08-18",
                    "evidenceLevel": "platform_api"
                }]
            }"#,
        )
        .expect("valid test library")
    }

    #[test]
    fn user_config_beats_detection_and_library() {
        let provider =
            provider_with_catalog("deepseek/deepseek-v4-pro", Some(user_declared_reasoning()));
        let detection = openrouter_detection_snapshot();
        let library = library_with_openrouter_deepseek();
        let resolved = resolve_codex_model_capability_with_library(
            &provider,
            "deepseek/deepseek-v4-pro",
            Some(&detection),
            Some(&library),
        );
        assert_eq!(resolved.source, CapabilitySource::UserConfig);
        assert_eq!(
            resolved.capability.as_ref().unwrap().supported_efforts,
            vec!["low", "high"]
        );
    }

    #[test]
    fn detection_beats_library_when_user_absent() {
        let provider = plain_provider("OpenRouter", "https://openrouter.ai/api/v1");
        let detection = openrouter_detection_snapshot();
        let library = library_with_openrouter_deepseek();
        let resolved = resolve_codex_model_capability_with_library(
            &provider,
            "deepseek/deepseek-v4-pro",
            Some(&detection),
            Some(&library),
        );
        assert_eq!(resolved.source, CapabilitySource::Detection);
        assert_eq!(
            resolved.capability.as_ref().unwrap().supported_efforts,
            vec!["max", "high", "low"]
        );
    }

    #[test]
    fn library_beats_builtin_when_detection_absent() {
        let provider = plain_provider("OpenRouter", "https://openrouter.ai/api/v1");
        let library = library_with_openrouter_deepseek();
        let resolved = resolve_codex_model_capability_with_library(
            &provider,
            "deepseek/deepseek-v4-pro",
            None,
            Some(&library),
        );
        assert_eq!(resolved.source, CapabilitySource::Library);
        // 指纹为 64 位十六进制 sha256（无前缀）。
        assert_eq!(resolved.fingerprint.len(), 64);
        assert!(resolved.fingerprint.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn catalog_ultra_setting_overlays_library_capability_without_changing_its_source() {
        let mut provider = plain_provider("OpenRouter", "https://openrouter.ai/api/v1");
        provider.settings_config = json!({
            "base_url": "https://openrouter.ai/api/v1",
            "modelCatalog": {"models": [{
                "model": "deepseek/deepseek-v4-pro",
                "codexUltra": {"enabled": true, "providerEffort": "high"}
            }]}
        });
        let library = library_with_openrouter_deepseek();

        let resolved = resolve_codex_model_capability_with_library(
            &provider,
            "deepseek/deepseek-v4-pro",
            None,
            Some(&library),
        );
        let capability = resolved.capability.expect("library capability");
        assert_eq!(resolved.source, CapabilitySource::Library);
        assert_eq!(capability.source.as_deref(), Some("library"));
        assert_eq!(
            capability.upstream.effort_map.get("max"),
            Some(&"max".to_string())
        );
        assert!(
            capability.codex_ultra_orchestration.as_ref().is_some_and(
                |ultra| ultra.enabled && ultra.provider_effort.as_deref() == Some("high")
            )
        );
        let projected =
            crate::proxy::providers::codex_reasoning::resolve_subagent_reasoning_capability(Some(
                &capability,
            ));
        use crate::proxy::providers::codex_reasoning::CodexReasoningEffort as Effort;
        assert_eq!(projected.effort_map.get(&Effort::Max), Some(&Effort::Max));
        assert_eq!(
            projected.effort_map.get(&Effort::Ultra),
            Some(&Effort::High)
        );
    }

    #[test]
    fn builtin_beats_unknown_when_library_misses() {
        // deepseek-v4-flash 在内置清单中；库未命中时落到内置。
        let provider = plain_provider("Some Gateway", "https://example.com/v1");
        let resolved =
            resolve_codex_model_capability_with_library(&provider, "deepseek-v4-flash", None, None);
        assert_eq!(resolved.source, CapabilitySource::Builtin);
        assert!(resolved.capability.is_some());
    }

    #[test]
    fn unknown_when_no_source_hits() {
        let provider = plain_provider("Some Gateway", "https://example.com/v1");
        let resolved =
            resolve_codex_model_capability_with_library(&provider, "mystery-model-xyz", None, None);
        assert_eq!(resolved.source, CapabilitySource::Unknown);
        assert!(resolved.capability.is_none());
        assert_eq!(resolved.fingerprint, "");
    }

    #[test]
    fn invalid_detection_snapshot_falls_through_to_library() {
        // ultra 没有可用的 max path → 快照非法 → 落到库。
        let mut detection = openrouter_detection_snapshot();
        detection
            .reasoning
            .as_mut()
            .unwrap()
            .supported_efforts
            .retain(|effort| effort != "max");
        detection.reasoning.as_mut().unwrap().default_effort = Some("ultra".into());
        let provider = plain_provider("OpenRouter", "https://openrouter.ai/api/v1");
        let library = library_with_openrouter_deepseek();
        let resolved = resolve_codex_model_capability_with_library(
            &provider,
            "deepseek/deepseek-v4-pro",
            Some(&detection),
            Some(&library),
        );
        assert_eq!(resolved.source, CapabilitySource::Library);
    }

    #[test]
    fn snapshot_to_capability_preserves_internal_ultra_overlay_without_native_max() {
        let snapshot = ProviderCapabilitySnapshot {
            provider_key: "test-provider".into(),
            model: "gpt-6.1-sol".into(),
            fetched_at: 1,
            source: "test".into(),
            evidence_scope: None,
            reasoning: Some(ReasoningCapabilitySnapshot {
                supported_efforts: vec!["high".into(), "xhigh".into()],
                default_effort: Some("xhigh".into()),
                mandatory: true,
                disable_allowed: Some(false),
                support_status: Some(ReasoningSupportStatus::ConfirmedSupported),
                control_kind: Some(ReasoningControlKind::Graded),
                upstream_format: Some("reasoning_object".into()),
                upstream_parameter: Some("reasoning.effort".into()),
                effort_map: Some(
                    [
                        ("high".into(), "high".into()),
                        ("xhigh".into(), "xhigh".into()),
                    ]
                    .into_iter()
                    .collect(),
                ),
                codex_ultra_orchestration: Some(
                    crate::proxy::providers::codex_reasoning::CodexUltraOrchestrationCapability {
                        enabled: true,
                        provider_effort: Some("xhigh".into()),
                    },
                ),
                ..Default::default()
            }),
        };
        let capability = snapshot_to_capability(&snapshot).expect("valid internal overlay");
        assert_eq!(capability.supported_efforts, ["high", "xhigh"]);
        assert_eq!(
            capability
                .codex_ultra_orchestration
                .as_ref()
                .and_then(|ultra| ultra.provider_effort.as_deref()),
            Some("xhigh")
        );
        assert!(!capability.upstream.effort_map.contains_key("ultra"));
        assert!(!capability.upstream.effort_map.contains_key("max"));
    }

    #[test]
    fn snapshot_to_capability_graded_with_none_is_disable_allowed() {
        let mut snapshot = openrouter_detection_snapshot();
        snapshot.reasoning.as_mut().unwrap().supported_efforts = vec!["high".into(), "none".into()];
        snapshot.reasoning.as_mut().unwrap().default_effort = Some("high".into());
        let capability = snapshot_to_capability(&snapshot).expect("valid snapshot");
        assert!(capability.disable_allowed);
        assert_eq!(capability.supported_efforts, vec!["none", "high"]);
        assert_eq!(capability.control_kind, Some(ReasoningControlKind::Graded));
    }

    #[test]
    fn snapshot_to_capability_rejects_mandatory_disable_declarations() {
        for (efforts, default, enabled) in [
            (vec!["high", "none"], Some("high"), Some(true)),
            (vec!["high"], Some("none"), Some(true)),
            (vec!["high"], Some("high"), Some(false)),
        ] {
            let mut snapshot = openrouter_detection_snapshot();
            let reasoning = snapshot.reasoning.as_mut().unwrap();
            reasoning.mandatory = true;
            reasoning.supported_efforts = efforts.into_iter().map(str::to_string).collect();
            reasoning.default_effort = default.map(str::to_string);
            reasoning.default_enabled = enabled;
            assert!(
                snapshot_to_capability(&snapshot).is_none(),
                "mandatory reasoning must never expose disable or off-by-default behavior"
            );
        }
    }

    #[test]
    fn snapshot_to_capability_normalizes_ultra_only_with_a_max_path() {
        let mut snapshot = openrouter_detection_snapshot();
        snapshot.reasoning.as_mut().unwrap().supported_efforts =
            vec!["low".into(), "max".into(), "ultra".into()];
        snapshot.reasoning.as_mut().unwrap().default_effort = Some("ultra".into());
        let capability = snapshot_to_capability(&snapshot).expect("valid Ultra snapshot");
        assert_eq!(capability.supported_efforts, vec!["low", "max"]);
        assert_eq!(capability.default_effort.as_deref(), Some("max"));
        assert!(capability
            .codex_ultra_orchestration
            .as_ref()
            .is_some_and(|ultra| ultra.enabled));
        assert!(!capability.upstream.effort_map.contains_key("ultra"));

        snapshot.reasoning.as_mut().unwrap().supported_efforts = vec!["ultra".into()];
        assert!(
            snapshot_to_capability(&snapshot).is_none(),
            "Ultra without max must not become a guessed provider capability"
        );
    }

    #[test]
    fn snapshot_to_capability_budget_when_only_max_tokens() {
        let snapshot = ProviderCapabilitySnapshot {
            provider_key: "p".into(),
            model: "m".into(),
            fetched_at: 0,
            source: "openrouter_api".into(),
            evidence_scope: None,
            reasoning: Some(ReasoningCapabilitySnapshot {
                supported_efforts: vec![],
                default_effort: None,
                mandatory: false,
                default_enabled: Some(true),
                supports_max_tokens: true,
                upstream_format: None,
                upstream_parameter: None,
                output_format: None,
                ..Default::default()
            }),
        };
        let capability = snapshot_to_capability(&snapshot).expect("budget snapshot");
        assert_eq!(capability.control_kind, Some(ReasoningControlKind::Budget));
        assert!(capability.supported_efforts.is_empty());
    }

    #[test]
    fn snapshot_to_capability_no_control_when_reasoning_is_advertised_without_levels() {
        // A positive reasoning object with no controls is still confirmed
        // reasoning support; it simply cannot expose an effort selector.
        let snapshot = ProviderCapabilitySnapshot {
            provider_key: "p".into(),
            model: "m".into(),
            fetched_at: 0,
            source: "openrouter_api".into(),
            evidence_scope: None,
            reasoning: Some(ReasoningCapabilitySnapshot::default()),
        };
        let capability = snapshot_to_capability(&snapshot).expect("reasoning capability");
        assert_eq!(capability.control_kind, Some(ReasoningControlKind::None));
        assert_eq!(
            capability.support_status,
            Some(ReasoningSupportStatus::ConfirmedSupported)
        );
        assert!(capability.supported_efforts.is_empty());
    }

    #[test]
    fn detection_cache_ttl_expiry() {
        let mut cache = DetectionCache::default();
        let snapshot = openrouter_detection_snapshot();
        cache.insert(snapshot.clone());
        assert!(cache
            .get("test-provider", "deepseek/deepseek-v4-pro")
            .is_some());
        // 未知 key 不命中。
        assert!(cache.get("other", "deepseek/deepseek-v4-pro").is_none());
        // 空缓存不命中。
        let empty = DetectionCache::default();
        assert!(empty
            .get("test-provider", "deepseek/deepseek-v4-pro")
            .is_none());
    }

    #[test]
    fn fingerprint_stable_across_sources_with_same_semantics() {
        // 同一运行语义（efforts/default/upstream）在不同来源下指纹一致。
        let detection = openrouter_detection_snapshot();
        let library = library_with_openrouter_deepseek();
        let provider = plain_provider("OpenRouter", "https://openrouter.ai/api/v1");
        let from_detection = resolve_codex_model_capability_with_library(
            &provider,
            "deepseek/deepseek-v4-pro",
            Some(&detection),
            None,
        );
        let from_library = resolve_codex_model_capability_with_library(
            &provider,
            "deepseek/deepseek-v4-pro",
            None,
            Some(&library),
        );
        assert_eq!(
            from_detection.fingerprint, from_library.fingerprint,
            "same execution semantics must produce the same fingerprint"
        );
    }

    fn official_models_fixture() -> Vec<serde_json::Value> {
        vec![json!({
            "slug": "gpt-5.4",
            "supported_reasoning_levels": ["low", "medium", "high", "xhigh", "max"],
            "default_reasoning_level": "medium"
        })]
    }

    #[test]
    fn resolver_core_sublyx_fallback_preserves_native_max_and_uses_synthetic_ultra() {
        let settings = json!({});
        let resolved = resolve_codex_model_capability_core(
            &settings,
            Some("sublyx"),
            "gpt-6.1-sol-sublyx",
            None,
            None,
            &[],
        );
        assert_eq!(resolved.source, CapabilitySource::ProviderFallback);
        let capability = resolved.capability.expect("Sublyx GPT fallback capability");
        assert_eq!(
            capability.supported_efforts,
            vec!["low", "medium", "high", "xhigh", "max"]
        );
        assert_eq!(capability.default_effort.as_deref(), Some("medium"));
        assert!(capability
            .supported_efforts
            .iter()
            .any(|effort| effort == "max"));
        assert_eq!(
            capability.upstream.effort_map.get("max"),
            Some(&"max".to_string())
        );
        assert!(!capability.upstream.effort_map.contains_key("ultra"));
        assert!(capability.upstream.effort_map.contains_key("max"));
        assert!(capability
            .codex_ultra_orchestration
            .as_ref()
            .is_some_and(|ultra| ultra.enabled && ultra.provider_effort.as_deref() == Some("max")));

        let projected =
            crate::proxy::providers::codex_reasoning::resolve_subagent_reasoning_capability(Some(
                &capability,
            ));
        use crate::proxy::providers::codex_reasoning::CodexReasoningEffort as Effort;
        assert_eq!(
            projected.provider_accepted_efforts,
            vec![
                Effort::Low,
                Effort::Medium,
                Effort::High,
                Effort::XHigh,
                Effort::Max
            ]
        );
        assert!(projected.codex_selectable_efforts.contains(&Effort::Ultra));
        assert_eq!(projected.effort_map.get(&Effort::Ultra), Some(&Effort::Max));
        assert!(projected.provider_accepted_efforts.contains(&Effort::Max));

        // The same model suffix on an aggregator must remain unknown rather
        // than inheriting the Sublyx Responses contract.
        let openrouter = resolve_codex_model_capability_core(
            &settings,
            Some("openrouter"),
            "gpt-6.1-sol-sublyx",
            None,
            None,
            &[],
        );
        assert_eq!(openrouter.source, CapabilitySource::Unknown);
        assert!(openrouter.capability.is_none());
    }

    #[test]
    fn sublyx_catalog_ultra_overlay_migrates_stale_xhigh_when_native_max_is_available() {
        for (wire_model, enabled, saved_target, effort_source, expected) in [
            ("gpt-6.2-astra", true, "xhigh", None, Some("max")),
            ("gpt-6.2-astra", true, "xhigh", Some("user"), Some("xhigh")),
            ("gpt-6.2-astra", true, "high", None, Some("high")),
            ("gpt-6.2-astra", false, "xhigh", None, None),
            ("gpt-6.2-sol", true, "xhigh", None, Some("max")),
            ("gpt-6.2-sol", true, "xhigh", Some("user"), Some("xhigh")),
            ("gpt-6.2-sol", true, "high", None, Some("high")),
            ("gpt-6.2-sol", false, "xhigh", None, None),
            ("gpt-5.4", true, "xhigh", None, Some("xhigh")),
        ] {
            let mut ultra = json!({"enabled": enabled, "providerEffort": saved_target});
            if let Some(effort_source) = effort_source {
                ultra["providerEffortSource"] = json!(effort_source);
            }
            let settings = json!({
                "baseUrl": "https://api.sublyx.org/v1",
                "modelCatalog": {"models": [{
                    "model": "public-model", "upstreamModel": wire_model,
                    "codexUltra": ultra,
                }]}
            });
            let resolved = resolve_codex_model_capability_core(
                &settings,
                Some("sublyx"),
                "public-model",
                None,
                None,
                &[],
            );
            let capability = resolved.capability.unwrap();
            assert_eq!(
                capability
                    .codex_ultra_orchestration
                    .as_ref()
                    .and_then(|ultra| ultra.provider_effort.as_deref()),
                expected,
                "{wire_model}: {enabled} {saved_target} {effort_source:?}"
            );
            if matches!(wire_model, "gpt-6.2-sol" | "gpt-6.2-astra") {
                assert_eq!(capability.upstream.effort_map["max"], "max");
            }
        }
    }

    #[test]
    fn sublyx_catalog_overlay_repairs_legacy_builtin_reasoning_before_stale_xhigh() {
        let settings = json!({
            "baseUrl": "https://api.sublyx.org/v1",
            "modelCatalog": {"models": [{
                "model": "public-model",
                "upstreamModel": "gpt-6.2-sol",
                "reasoning": {
                    "schemaVersion": 2,
                    "supportStatus": "confirmed_supported",
                    "controlKind": "graded",
                    "supportedEfforts": ["low", "medium", "high", "xhigh"],
                    "defaultEffort": "xhigh",
                    "disableAllowed": false,
                    "upstream": {
                        "format": "reasoning_object",
                        "parameter": "reasoning.effort",
                        "effortMap": {
                            "low": "low",
                            "medium": "medium",
                            "high": "high",
                            "xhigh": "xhigh"
                        }
                    },
                    "source": "builtin",
                    "codexUltraOrchestration": {
                        "enabled": true,
                        "providerEffort": "xhigh"
                    }
                },
                "codexUltra": {"enabled": true, "providerEffort": "xhigh"}
            }]}
        });
        let resolved = resolve_codex_model_capability_core(
            &settings,
            Some("sublyx"),
            "public-model",
            None,
            None,
            &[],
        );
        let capability = resolved
            .capability
            .expect("legacy capability should resolve");
        assert_eq!(
            capability
                .codex_ultra_orchestration
                .as_ref()
                .and_then(|ultra| ultra.provider_effort.as_deref()),
            Some("max")
        );
    }

    #[test]
    fn reasoning_provider_key_preserves_target_identity_without_accepting_blank_overrides() {
        let mut provider = provider_with_catalog("model", None);
        provider.id = "synthetic-route".to_string();
        for override_value in [Value::Null, json!(""), json!("  "), json!(false)] {
            provider.settings_config["codexResolvedTargetProviderId"] = override_value;
            assert_eq!(reasoning_provider_key(&provider), "synthetic-route");
        }
        provider.settings_config["codexResolvedTargetProviderId"] = json!("  original-provider  ");
        assert_eq!(reasoning_provider_key(&provider), "original-provider");
    }

    #[test]
    fn sublyx_normalization_uses_current_wire_identity_for_catalog_names_and_aliases() {
        let stale_reasoning = native_max_reasoning("user");
        for model_reasoning in [Some(stale_reasoning.clone()), None] {
            let mut row = json!({
                "model": "Renamed Friendly Model",
                "upstreamModel": "gpt-6.1-sol",
                "aliases": ["Old Friendly Model"]
            });
            if let Some(reasoning) = model_reasoning.as_ref() {
                row["reasoning"] = reasoning.clone();
            }
            let settings = json!({
                "modelCatalog": {"models": [row]},
                "reasoning": stale_reasoning.clone()
            });
            for requested in [
                "Renamed Friendly Model",
                "Old Friendly Model",
                "gpt-6.1-sol",
            ] {
                let resolved = resolve_codex_model_capability_for_settings(
                    &settings,
                    Some("sublyx"),
                    None,
                    requested,
                    None,
                    &[],
                    |_| None,
                );
                let capability = resolved.capability.expect("Sublyx wire model capability");
                assert_eq!(
                    capability.supported_efforts,
                    if model_reasoning.is_some() {
                        vec!["low", "high", "max"]
                    } else {
                        vec!["low", "medium", "high", "xhigh", "max"]
                    },
                    "{requested}"
                );
                assert_eq!(capability.upstream.parameter, "reasoning.effort");
                assert!(capability.upstream.effort_map.contains_key("max"));
                if model_reasoning.is_some() {
                    assert_eq!(resolved.source, CapabilitySource::UserConfig);
                    assert_eq!(capability.source.as_deref(), Some("user"));
                    assert_eq!(capability.default_effort.as_deref(), Some("max"));
                } else {
                    assert_eq!(resolved.source, CapabilitySource::ProviderFallback);
                }
                assert_eq!(resolved.fingerprint, capability_fingerprint(&capability));
            }
        }
    }

    #[test]
    fn sublyx_core_alias_without_wire_override_uses_the_rows_canonical_model() {
        for reasoning in [Some(native_max_reasoning("user")), None] {
            let mut row = json!({"model": "gpt-6.1-sol", "aliases": ["Friendly Alias"]});
            if let Some(reasoning) = reasoning.as_ref() {
                row["reasoning"] = reasoning.clone();
            }
            let settings = json!({"modelCatalog": {"models": [row]}});
            let resolved = resolve_codex_model_capability_core(
                &settings,
                Some("sublyx"),
                "Friendly Alias",
                None,
                None,
                &[],
            );
            let capability = resolved.capability.expect("canonical GPT wire identity");
            assert_eq!(
                capability.supported_efforts,
                if reasoning.is_some() {
                    vec!["low", "high", "max"]
                } else {
                    vec!["low", "medium", "high", "xhigh", "max"]
                }
            );
            assert_eq!(
                resolved.source,
                if reasoning.is_some() {
                    CapabilitySource::UserConfig
                } else {
                    CapabilitySource::ProviderFallback
                }
            );
            assert_eq!(resolved.fingerprint, capability_fingerprint(&capability));
        }
    }

    #[test]
    fn sublyx_normalization_does_not_treat_a_public_gpt_alias_as_the_wire_model() {
        let settings = json!({"modelCatalog": {"models": [{
            "model": "gpt-friendly-label",
            "upstreamModel": "claude-custom",
            "reasoning": native_max_reasoning("user")
        }]}});
        let resolved = resolve_codex_model_capability_core(
            &settings,
            Some("sublyx"),
            "gpt-friendly-label",
            None,
            None,
            &[],
        );
        let capability = resolved
            .capability
            .expect("unchanged non-GPT wire capability");
        assert_eq!(capability.supported_efforts, vec!["low", "high", "max"]);
        assert_eq!(capability.provider_key, None);
    }

    #[test]
    fn catalog_ultra_target_does_not_overwrite_openrouter_native_max() {
        let mut settings = json!({"base_url":"https://openrouter.ai/api/v1", "modelCatalog": {"models": [{
            "model": "openai/gpt-native-max",
            "reasoning": native_max_reasoning("openrouter_api"),
            "codexUltra": {"enabled": true, "providerEffort": "high"}
        }]}});
        settings["modelCatalog"]["models"][0]["reasoning"]["evidenceScope"] = serde_json::to_value(
            reasoning_evidence_scope_for_settings(&settings, "openai/gpt-native-max").unwrap(),
        )
        .unwrap();
        let resolved = resolve_codex_model_capability_core(
            &settings,
            Some("openrouter"),
            "openai/gpt-native-max",
            None,
            None,
            &[],
        );
        let capability = resolved.capability.expect("native max and synthetic Ultra");
        assert_eq!(capability.supported_efforts, vec!["low", "high", "max"]);
        assert_eq!(
            capability
                .upstream
                .effort_map
                .get("max")
                .map(String::as_str),
            Some("max")
        );
        let projected =
            crate::proxy::providers::codex_reasoning::resolve_subagent_reasoning_capability(Some(
                &capability,
            ));
        use crate::proxy::providers::codex_reasoning::CodexReasoningEffort as Effort;
        assert_eq!(projected.effort_map.get(&Effort::Max), Some(&Effort::Max));
        assert_eq!(
            projected.effort_map.get(&Effort::Ultra),
            Some(&Effort::High)
        );
    }

    #[test]
    fn resolver_core_preserves_sublyx_native_max_without_affecting_openrouter() {
        let settings = json!({
            "modelCatalog": {
                "models": [{
                    "model": "gpt-6.1-sol-sublyx",
                    "reasoning": {
                        "schemaVersion": 2,
                        "supportStatus": "confirmed_supported",
                        "controlKind": "graded",
                        "supportedEfforts": ["low", "medium", "high", "max"],
                        "defaultEffort": "max",
                        "disableAllowed": false,
                        "upstream": {
                            "format": "reasoning_object",
                            "parameter": "reasoning.effort",
                            "effortMap": {
                                "low": "low",
                                "medium": "medium",
                                "high": "high",
                                "max": "max"
                            }
                        },
                        "source": "user"
                    }
                }]
            }
        });
        let resolved = resolve_codex_model_capability_core(
            &settings,
            Some("sublyx"),
            "gpt-6.1-sol-sublyx",
            None,
            None,
            &[],
        );
        assert_eq!(resolved.source, CapabilitySource::UserConfig);
        let capability = resolved.capability.expect("normalized user capability");
        assert_eq!(capability.source.as_deref(), Some("user"));
        assert_eq!(capability.provider_key.as_deref(), None);
        assert_eq!(
            capability.supported_efforts,
            vec!["low", "medium", "high", "max"]
        );
        assert_eq!(capability.default_effort.as_deref(), Some("max"));
        assert_eq!(
            capability.upstream.effort_map.get("max"),
            Some(&"max".to_string())
        );
        assert!(!capability.upstream.effort_map.contains_key("ultra"));
        assert!(capability.codex_ultra_orchestration.is_none());

        let projected =
            crate::proxy::providers::codex_reasoning::resolve_subagent_reasoning_capability(Some(
                &capability,
            ));
        use crate::proxy::providers::codex_reasoning::CodexReasoningEffort as Effort;
        assert!(projected.provider_accepted_efforts.contains(&Effort::Max));
        assert_eq!(projected.effort_map.get(&Effort::Max), Some(&Effort::Max));
        assert!(!projected.codex_ultra_orchestration_enabled);
        assert!(!projected.codex_selectable_efforts.contains(&Effort::Ultra));
        // The resolver retains a nearest-native compatibility map for stale
        // requested tokens, independently of which controls the UI may expose.
        // Such a map must not enable the synthetic Ultra product selector.
        assert_eq!(projected.effort_map.get(&Effort::Ultra), Some(&Effort::Max));

        // Platform identity, not the model suffix, controls normalization.
        let openrouter = resolve_codex_model_capability_core(
            &settings,
            Some("openrouter"),
            "gpt-6.1-sol-sublyx",
            None,
            None,
            &[],
        );
        assert_eq!(openrouter.source, CapabilitySource::UserConfig);
        let openrouter_capability = openrouter.capability.expect("user capability");
        assert!(openrouter_capability
            .supported_efforts
            .iter()
            .any(|effort| effort == "max"));
        assert_eq!(openrouter_capability.provider_key, None);
        assert_eq!(openrouter_capability, capability, "a complete manual declaration is not widened or given a synthetic selector by either provider");
    }

    #[test]
    fn resolver_core_official_source_for_unknown_platform() {
        // platform=None（未知平台，含 OpenAI 直连与 catalog 投影）命中 official 来源。
        let settings = json!({});
        let official = official_models_fixture();
        let resolved =
            resolve_codex_model_capability_core(&settings, None, "gpt-5.4", None, None, &official);
        assert_eq!(resolved.source, CapabilitySource::Official);
        assert!(!resolved.fingerprint.is_empty());
        let capability = resolved.capability.expect("official capability");
        assert_eq!(capability.source.as_deref(), Some("official"));
        assert_eq!(
            capability.supported_efforts,
            vec!["low", "medium", "high", "xhigh", "max"]
        );
        assert_eq!(capability.default_effort.as_deref(), Some("medium"));
        // 官方 GPT 走 OpenAI 顶层 reasoning_effort 字段，effort_map 用 identity。
        assert_eq!(capability.upstream.format, "string");
        assert_eq!(capability.upstream.parameter, "reasoning_effort");
    }

    #[test]
    fn resolver_core_shared_official_cache_cannot_add_controls_to_unknown_relay_models() {
        for model in [
            "claude-fable-5-1",
            "xiaomi/mimo-v2.6-flash",
            "future-relay-model",
        ] {
            let cache = vec![json!({
                "slug": model,
                "supported_reasoning_levels": ["low", "high"],
                "default_reasoning_level": "high"
            })];
            for settings in [
                json!({}),
                json!({"base_url": "https://relay.example/v1", "providerName": "OpenAI Official"}),
                json!({"config": "model_provider = \"official\"\n[model_providers.official]\nname = \"OpenAI Official\"\nbase_url = \"https://relay.example/v1\""}),
            ] {
                let resolved =
                    resolve_codex_model_capability_core(&settings, None, model, None, None, &cache);
                assert_eq!(resolved.source, CapabilitySource::Unknown, "{model}");
                assert!(
                    resolved.capability.is_none(),
                    "relay/cache identity is not native capability evidence: {model}"
                );
            }
        }
    }

    #[test]
    fn resolver_core_official_cache_allows_future_names_only_on_safe_native_transport() {
        let model = "future-official-model";
        let cache = vec![json!({
            "slug": model, "supported_reasoning_levels": ["low", "high"],
            "default_reasoning_level": "high"
        })];
        for base_url in [
            "https://api.openai.com/v1",
            "https://chatgpt.com/backend-api/codex",
            "https://chat.openai.com/backend-api/codex/responses",
        ] {
            let resolved = resolve_codex_model_capability_core(
                &json!({"base_url": base_url}),
                None,
                model,
                None,
                None,
                &cache,
            );
            assert_eq!(resolved.source, CapabilitySource::Official, "{base_url}");
            assert_eq!(
                resolved
                    .capability
                    .expect("native cache evidence")
                    .supported_efforts,
                ["low", "high"]
            );
        }
        let selected_native = json!({"config": "model_provider = \"native\"\n[model_providers.native]\nbase_url = \"https://api.openai.com/v1\"\n[model_providers.relay]\nbase_url = \"https://relay.example/v1\""});
        assert_eq!(
            resolve_codex_model_capability_core(&selected_native, None, model, None, None, &cache)
                .source,
            CapabilitySource::Official,
            "the selected TOML transport owns native provenance"
        );
        let selected_relay = json!({"config": "model_provider = \"relay\"\n[model_providers.native]\nbase_url = \"https://api.openai.com/v1\"\n[model_providers.relay]\nbase_url = \"https://relay.example/v1\""});
        assert_eq!(
            resolve_codex_model_capability_core(&selected_relay, None, model, None, None, &cache)
                .source,
            CapabilitySource::Unknown,
            "an inactive OpenAI table cannot authorize a relay's models"
        );
        for base_url in [
            "http://api.openai.com/v1",
            "https://api.openai.com.evil.example/v1",
            "https://api.openai.com:444/v1",
            "https://user@api.openai.com/v1",
            "https://api.openai.com/v1?scope=other",
            "https://api.openai.com/v1#other",
            "https://chatgpt.com/not-codex",
        ] {
            let resolved = resolve_codex_model_capability_core(
                &json!({"base_url": base_url}),
                None,
                model,
                None,
                None,
                &cache,
            );
            assert_eq!(
                resolved.source,
                CapabilitySource::Unknown,
                "unsafe or foreign transport must not authorize cache evidence"
            );
            assert!(resolved.capability.is_none());
        }
    }

    #[test]
    fn resolver_core_explicit_relay_reasoning_still_overrides_shared_official_cache() {
        let model = "claude-fable-5-1";
        let settings = json!({
            "base_url": "https://relay.example/v1",
            "modelCatalog": {"models": [{"model": model, "reasoning": user_declared_reasoning()}]}
        });
        let cache = vec![json!({"slug": model, "supported_reasoning_levels": ["max"]})];
        let resolved =
            resolve_codex_model_capability_core(&settings, None, model, None, None, &cache);
        assert_eq!(resolved.source, CapabilitySource::UserConfig);
        assert_eq!(
            resolved
                .capability
                .expect("explicit declaration")
                .supported_efforts,
            ["low", "high"]
        );
    }

    #[test]
    fn resolver_official_cache_keeps_openai_families_and_public_alias_wire_bindings() {
        for model in [
            "gpt-future",
            "chatgpt-future",
            "codex-future",
            "o1",
            "o12-future",
        ] {
            let cache = vec![json!({
                "slug": model, "supported_reasoning_levels": ["low", "high"],
                "default_reasoning_level": "high"
            })];
            let settings = json!({
                "base_url": "https://relay.example/v1",
                "modelCatalog": {"models": [{"model": "friendly-label", "upstreamModel": model}]}
            });
            let resolved = resolve_codex_model_capability_for_settings(
                &settings,
                None,
                None,
                "friendly-label",
                None,
                &cache,
                |_| None,
            );
            assert_eq!(resolved.source, CapabilitySource::Official, "{model}");
            assert_eq!(
                resolved
                    .capability
                    .expect("wire-bound cache evidence")
                    .supported_efforts,
                ["low", "high"]
            );
        }
        let cache = vec![json!({"slug": "o1foreign", "supported_reasoning_levels": ["high"]})];
        let resolved =
            resolve_codex_model_capability_core(&json!({}), None, "o1foreign", None, None, &cache);
        assert_eq!(
            resolved.source,
            CapabilitySource::Unknown,
            "OpenAI family prefixes require a token boundary"
        );
    }

    #[test]
    fn resolver_core_official_cache_gate_follows_wire_binding_not_a_public_gpt_alias() {
        let settings = json!({
            "base_url": "https://relay.example/v1",
            "modelCatalog": {"models": [{"model": "gpt-menu-alias", "upstreamModel": "claude-fable-5-1"}]}
        });
        let cache = vec![json!({"slug": "gpt-menu-alias", "supported_reasoning_levels": ["high"]})];
        let resolved = resolve_codex_model_capability_core(
            &settings,
            None,
            "gpt-menu-alias",
            None,
            None,
            &cache,
        );
        assert_eq!(resolved.source, CapabilitySource::Unknown);
        assert!(resolved.capability.is_none());
    }

    #[test]
    fn resolver_core_official_source_skipped_for_known_platform() {
        // platform=openrouter（已知聚合平台）不套用官方 OpenAI 形态，落到 unknown。
        let settings = json!({});
        let official = official_models_fixture();
        let resolved = resolve_codex_model_capability_core(
            &settings,
            Some("openrouter"),
            "gpt-5.4",
            None,
            None,
            &official,
        );
        assert_eq!(resolved.source, CapabilitySource::Unknown);
        assert!(resolved.capability.is_none());
    }

    #[test]
    fn resolver_core_builtin_source_is_skipped_for_known_aggregator_platform() {
        // The maintained builtin uses the official string/reasoning_effort
        // contract. A known aggregator must not inherit it when its packaged
        // platform-specific entry is unavailable; fail closed instead.
        let resolved = resolve_codex_model_capability_core(
            &json!({}),
            Some("openrouter"),
            "deepseek-v4-pro",
            None,
            None,
            &[],
        );
        assert_eq!(resolved.source, CapabilitySource::Unknown);
        assert!(resolved.capability.is_none());
    }

    #[test]
    fn resolver_static_fallbacks_builtin_follows_current_wire_binding_not_public_name() {
        for platform in [None, Some("deepseek")] {
            for public_model in ["deepseek-v4-pro", "gpt-6.1-sol"] {
                let settings = json!({
                    "base_url": "https://relay.example/v1",
                    "modelCatalog": {"models": [{
                        "model": public_model, "upstreamModel": "claude-fable-5-1"
                    }]}
                });
                let resolved = resolve_codex_model_capability_core(
                    &settings,
                    platform,
                    public_model,
                    None,
                    None,
                    &[],
                );
                assert_eq!(resolved.source, CapabilitySource::Unknown, "{public_model}");
                assert!(
                    resolved.capability.is_none(),
                    "a known public alias must not lend its contract to another wire model"
                );
            }
            let settings = json!({
                "base_url": "https://api.deepseek.com/v1",
                "modelCatalog": {"models": [{
                    "model": "friendly-model", "upstreamModel": "deepseek-v4-pro"
                }]}
            });
            let resolved = resolve_codex_model_capability_core(
                &settings,
                platform,
                "friendly-model",
                None,
                None,
                &[],
            );
            assert_eq!(resolved.source, CapabilitySource::Builtin);
            let capability = resolved
                .capability
                .expect("maintained wire-model capability");
            assert_eq!(capability.supported_efforts, ["low", "high", "max"]);
            assert_eq!(capability.upstream.parameter, "reasoning_effort");
        }
        let settings = json!({"modelCatalog": {"models": [{
            "model": "deepseek-v4-pro", "upstreamModel": "k3"
        }]}});
        let resolved = resolve_codex_model_capability_core(
            &settings,
            Some("deepseek"),
            "deepseek-v4-pro",
            None,
            None,
            &[],
        );
        assert_eq!(
            resolved.source,
            CapabilitySource::Unknown,
            "the official DeepSeek scope cannot authorize another vendor's builtin by alias"
        );
    }

    #[test]
    fn resolver_static_fallbacks_official_cache_uses_wire_contract_not_public_gpt_identity() {
        let public_model = "gpt-5.5";
        let wire_model = "gpt-5.6-sol";
        let cache = vec![
            json!({
                "slug": public_model, "supported_reasoning_levels": ["low"],
                "default_reasoning_level": "low"
            }),
            json!({
                "slug": wire_model, "supported_reasoning_levels": ["high", "xhigh"],
                "default_reasoning_level": "xhigh"
            }),
        ];
        for public_alias in [public_model, "friendly-public-label"] {
            let settings = json!({
                "base_url": "https://relay.example/v1",
                "modelCatalog": {"models": [{
                    "model": public_alias, "upstreamModel": wire_model
                }]}
            });
            let resolved = resolve_codex_model_capability_core(
                &settings,
                None,
                public_alias,
                None,
                None,
                &cache,
            );
            assert_eq!(
                resolved.source,
                CapabilitySource::Official,
                "{public_alias}"
            );
            let capability = resolved
                .capability
                .expect("actual wire model cache evidence");
            assert_eq!(
                capability.supported_efforts,
                ["high", "xhigh"],
                "the public name must never select another model's cache contract"
            );
            assert_eq!(capability.default_effort.as_deref(), Some("xhigh"));
        }
    }

    #[test]
    fn resolver_core_user_config_beats_official() {
        // 用户模型级声明始终最高优先级，覆盖 official 来源。
        let settings = json!({
            "modelCatalog": {"models": [{
                "model": "gpt-5.4",
                "reasoning": {
                    "schemaVersion": 2,
                    "supportStatus": "confirmed_supported",
                    "controlKind": "graded",
                    "supportedEfforts": ["low", "high"],
                    "defaultEffort": "high",
                    "disableAllowed": false,
                    "upstream": {"format": "string", "parameter": "reasoning_effort"},
                    "source": "user"
                }
            }]}
        });
        let official = official_models_fixture();
        let resolved =
            resolve_codex_model_capability_core(&settings, None, "gpt-5.4", None, None, &official);
        assert_eq!(resolved.source, CapabilitySource::UserConfig);
        let capability = resolved.capability.expect("user capability");
        assert_eq!(capability.supported_efforts, vec!["low", "high"]);
    }

    #[test]
    fn resolver_core_official_empty_cache_falls_to_unknown() {
        // 官方缓存为空（fresh install）时，GPT 模型落到 unknown（fail-closed）。
        let settings = json!({});
        let resolved =
            resolve_codex_model_capability_core(&settings, None, "gpt-5.4", None, None, &[]);
        assert_eq!(resolved.source, CapabilitySource::Unknown);
        assert!(resolved.capability.is_none());
    }

    #[test]
    fn resolver_reads_only_the_active_inline_provider() {
        let settings = json!({
            "config": r#"
model_provider = "active"
[[model_providers.inactive.models]]
id = "inline-model"
supported_reasoning_levels = ["low"]
[[model_providers.active.models]]
id = "inline-model"
supportedReasoningLevels = ["high", "max"]
defaultReasoningLevel = "max"
"#
        });
        let resolved =
            resolve_codex_model_capability_core(&settings, None, "inline-model", None, None, &[]);
        assert_eq!(resolved.source, CapabilitySource::ProviderConfig);
        assert_eq!(
            resolved
                .capability
                .expect("active capability")
                .supported_efforts,
            vec!["high", "max"]
        );
    }

    #[test]
    fn active_inline_reasoning_is_explicit_but_persisted_provider_config_remains_scoped() {
        let mut settings = json!({
            "base_url": "https://inline-evidence.example/v1",
            "modelCatalog": {"models": [{
                "model": "inline-evidence-model",
                "reasoning": {
                    "schemaVersion": 2,
                    "supportStatus": "confirmed_supported",
                    "controlKind": "graded",
                    "supportedEfforts": ["low"],
                    "defaultEffort": "low",
                    "disableAllowed": false,
                    "upstream": {"format": "string", "parameter": "reasoning_effort"},
                    "source": "provider_config"
                }
            }]},
            "config": r#"
model_provider = "active"
[model_providers.active]
base_url = "https://inline-evidence.example/v1"
[[model_providers.active.models]]
id = "inline-evidence-model"
supported_reasoning_levels = ["high"]
default_reasoning_level = "high"
"#
        });
        let current_inline = resolve_codex_model_capability_core(
            &settings,
            None,
            "inline-evidence-model",
            None,
            None,
            &[],
        );
        assert_eq!(current_inline.source, CapabilitySource::ProviderConfig);
        assert_eq!(
            current_inline.capability.unwrap().supported_efforts,
            vec!["high"]
        );

        // A persisted projection is not an explicit declaration merely because
        // it retained the source label from a formerly active TOML model.
        settings.as_object_mut().unwrap().remove("config");
        let stale_projection = resolve_codex_model_capability_core(
            &settings,
            None,
            "inline-evidence-model",
            None,
            None,
            &[],
        );
        assert_eq!(stale_projection.source, CapabilitySource::Unknown);
        assert!(stale_projection.capability.is_none());
    }

    #[test]
    fn sublyx_active_inline_subset_survives_provider_normalization() {
        let settings = json!({
            "base_url": "https://api.sublyx.org/v1",
            "modelCatalog": {"models": [{"model": "gpt-6.1-sol"}]},
            "config": r#"
model_provider = "active"
[model_providers.active]
base_url = "https://api.sublyx.org/v1"
[[model_providers.active.models]]
id = "gpt-6.1-sol"
supported_reasoning_levels = ["low", "high"]
default_reasoning_level = "high"
"#
        });
        let resolved = resolve_codex_model_capability_core(
            &settings,
            Some("sublyx"),
            "gpt-6.1-sol",
            None,
            None,
            &[],
        );
        assert_eq!(resolved.source, CapabilitySource::ProviderConfig);
        let capability = resolved
            .capability
            .expect("active explicit inline declaration");
        assert_eq!(capability.supported_efforts, ["low", "high"]);
        assert_eq!(capability.default_effort.as_deref(), Some("high"));
        assert_eq!(capability.upstream.format, "string");
        assert_eq!(capability.upstream.parameter, "reasoning_effort");
        assert!(capability.codex_ultra_orchestration.is_none());
    }

    #[test]
    fn resolver_does_not_guess_an_active_inline_provider() {
        for config in [
            r#"
[[model_providers.inactive.models]]
id = "inline-model"
supported_reasoning_levels = ["max"]
"#,
            r#"
model_provider = "missing"
[[model_providers.inactive.models]]
id = "inline-model"
supported_reasoning_levels = ["max"]
"#,
        ] {
            let resolved = resolve_codex_model_capability_core(
                &json!({"config": config}),
                None,
                "inline-model",
                None,
                None,
                &[],
            );
            assert_eq!(resolved.source, CapabilitySource::Unknown);
            assert!(resolved.capability.is_none());
        }
    }

    #[test]
    fn excluded_catalog_rows_cannot_reappear_from_lower_priority_sources() {
        let settings = json!({
            "modelCatalog": {"models": [{
                "model": "public-model", "upstreamModel": "gpt-5.4",
                "canonicalSlug": "canonical-model",
                "aliases": ["alias-model"], "enabled": false,
                "reasoning": user_declared_reasoning(),
                "codexUltra": {"enabled": true, "providerEffort": "high"}
            }]}
        });
        for model in ["public-model", "gpt-5.4", "canonical-model", "alias-model"] {
            let resolved = resolve_codex_model_capability_core(
                &settings,
                None,
                model,
                Some(&openrouter_detection_snapshot()),
                Some(&library_with_openrouter_deepseek()),
                &official_models_fixture(),
            );
            assert_eq!(resolved.source, CapabilitySource::Unknown);
            assert!(resolved.capability.is_none());
        }
    }

    #[test]
    fn ultra_overlay_follows_catalog_authority_and_identity_aliases() {
        let entry = json!({
            "model": "public-model", "upstreamModel": "gpt-5.4", "aliases": ["gpt-5.4"],
            "codexUltra": {"enabled": true, "providerEffort": "high"}
        });
        let mut settings = json!({"model_catalog": {"models": [entry]}});
        let official = official_models_fixture();
        let resolved =
            resolve_codex_model_capability_core(&settings, None, "gpt-5.4", None, None, &official);
        assert!(resolved
            .capability
            .expect("official capability with legacy overlay")
            .codex_ultra_orchestration
            .is_some_and(|ultra| ultra.enabled));
        settings["modelCatalog"] = json!({"models": []});
        let resolved =
            resolve_codex_model_capability_core(&settings, None, "gpt-5.4", None, None, &official);
        assert!(resolved
            .capability
            .expect("official capability without stale legacy overlay")
            .codex_ultra_orchestration
            .is_none());
    }

    #[test]
    fn catalog_identity_exact_enabled_row_beats_disabled_upstream_sibling() {
        for identity_field in ["model", "id"] {
            let disabled = json!({
                "model": "old", "upstreamModel": "wire", "aliases": ["excluded-alias"],
                "enabled": false, "reasoning": user_declared_reasoning()
            });
            let mut exact = json!({
                "enabled": true, "reasoning": user_declared_reasoning()
            });
            exact[identity_field] = json!("wire");
            for rows in [
                vec![disabled.clone(), exact.clone()],
                vec![exact.clone(), disabled.clone()],
            ] {
                let settings = json!({"modelCatalog": {"models": rows}});
                let resolved =
                    resolve_codex_model_capability_core(&settings, None, "wire", None, None, &[]);
                assert_eq!(resolved.source, CapabilitySource::UserConfig);
                assert_eq!(
                    resolved
                        .capability
                        .expect("exact enabled row")
                        .supported_efforts,
                    vec!["low", "high"]
                );
                for excluded in ["old", "excluded-alias"] {
                    let resolved = resolve_codex_model_capability_core(
                        &settings,
                        None,
                        excluded,
                        Some(&openrouter_detection_snapshot()),
                        None,
                        &[],
                    );
                    assert_eq!(resolved.source, CapabilitySource::Unknown);
                    assert!(resolved.capability.is_none());
                }
            }
        }
    }

    #[test]
    fn catalog_identity_exact_row_owns_reasoning_and_ultra() {
        for exact_ultra in [true, false] {
            let sibling = json!({
                "model": "old", "upstreamModel": "wire",
                "reasoning": user_declared_reasoning(),
                "codexUltra": {"enabled": !exact_ultra, "providerEffort": "high"}
            });
            let mut exact_reasoning = user_declared_reasoning();
            exact_reasoning["supportedEfforts"] = json!(["medium", "max"]);
            exact_reasoning["defaultEffort"] = json!("medium");
            let exact = json!({
                "model": "wire", "reasoning": exact_reasoning,
                "codexUltra": {"enabled": exact_ultra, "providerEffort": "max"}
            });
            for rows in [
                vec![sibling.clone(), exact.clone()],
                vec![exact.clone(), sibling.clone()],
            ] {
                let settings = json!({"modelCatalog": {"models": rows}});
                let capability =
                    resolve_codex_model_capability_core(&settings, None, "wire", None, None, &[])
                        .capability
                        .expect("exact row capability");
                assert_eq!(capability.supported_efforts, vec!["medium", "max"]);
                assert_eq!(capability.default_effort.as_deref(), Some("medium"));
                assert_eq!(
                    capability
                        .codex_ultra_orchestration
                        .is_some_and(|ultra| ultra.enabled),
                    exact_ultra
                );
            }
        }
    }

    #[test]
    fn catalog_identity_exact_row_owns_ultra_when_capability_comes_from_official() {
        for exact_ultra in [true, false] {
            let settings = json!({"modelCatalog": {"models": [
                {
                    "model": "old", "upstreamModel": "gpt-5.4",
                    "codexUltra": {"enabled": !exact_ultra, "providerEffort": "high"}
                },
                {
                    "model": "gpt-5.4",
                    "codexUltra": {"enabled": exact_ultra, "providerEffort": "max"}
                }
            ]}});
            let capability = resolve_codex_model_capability_core(
                &settings,
                None,
                "gpt-5.4",
                None,
                None,
                &official_models_fixture(),
            )
            .capability
            .expect("official capability for exact catalog row");
            assert_eq!(
                capability
                    .codex_ultra_orchestration
                    .is_some_and(|ultra| ultra.enabled),
                exact_ultra
            );
        }
    }

    #[test]
    fn catalog_identity_ambiguous_fallback_cannot_choose_a_sibling() {
        for identity in [
            json!({"upstreamModel": "shared"}),
            json!({"aliases": ["shared"]}),
            json!({"alias": {"shared": "wire"}}),
        ] {
            let mut first = json!({
                "model": "first", "reasoning": user_declared_reasoning(),
                "codexUltra": {"enabled": true, "providerEffort": "high"}
            });
            first
                .as_object_mut()
                .expect("first row")
                .extend(identity.as_object().expect("identity").clone());
            let mut second = first.clone();
            second["model"] = json!("second");
            let settings = json!({"modelCatalog": {"models": [first, second]}});
            let resolved = resolve_codex_model_capability_core(
                &settings,
                None,
                "shared",
                Some(&openrouter_detection_snapshot()),
                None,
                &[],
            );
            assert_eq!(resolved.source, CapabilitySource::Unknown);
            assert!(resolved.capability.is_none());
        }
    }
}
