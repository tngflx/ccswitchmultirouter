use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fmt,
    str::FromStr,
};

/// `ultra` 是 Codex 产品层的编排开关，绝不能由 Provider capability 持久化为
/// 原生 effort，也不能作为持久化映射的输入/输出。
const VALID_PROVIDER_EFFORTS: &[&str] =
    &["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/// Codex resolver 的内部词表。只有 resolver 在已验证 max 路径上才能生成 Ultra。
const VALID_CODEX_EFFORTS: &[&str] = &[
    "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
];

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CodexReasoningEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    #[serde(rename = "xhigh")]
    XHigh,
    Max,
    Ultra,
}

impl CodexReasoningEffort {
    const ORDERED: [Self; 8] = [
        Self::None,
        Self::Minimal,
        Self::Low,
        Self::Medium,
        Self::High,
        Self::XHigh,
        Self::Max,
        Self::Ultra,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::XHigh => "xhigh",
            Self::Max => "max",
            Self::Ultra => "ultra",
        }
    }
}

impl fmt::Display for CodexReasoningEffort {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for CodexReasoningEffort {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ORDERED
            .into_iter()
            .find(|candidate| candidate.as_str() == value)
            .ok_or_else(|| format!("unknown reasoning effort: {value}"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningSupportKind {
    EffortLevels,
    BooleanOnly,
    Unsupported,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningConfidence {
    Confirmed,
    Declared,
    Unverified,
}

/// 三态支持状态（模型推理能力 schema v2）。
///
/// 只有明确否定证据才能写 `confirmed_unsupported`；字段缺失、探测失败或
/// 不在维护库中都只能得到 `unknown`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningSupportStatus {
    ConfirmedSupported,
    ConfirmedUnsupported,
    Unknown,
}

/// 控制形态（模型推理能力 schema v2）。
///
/// 与支持状态相互独立，不能互相推导：能产生 reasoning、能开关 reasoning、
/// 能分档控制 reasoning 是三个独立能力。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningControlKind {
    /// 无控制：模型产生 reasoning，但上游未声明开关或档位。
    None,
    /// 仅布尔开关。
    Boolean,
    /// 分档 effort。
    Graded,
    /// token budget 或其他非 effort 控制。
    Budget,
    /// 控制形态未知。
    Unknown,
}

/// 能力声明的证据等级（模型推理能力 schema v2）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CapabilityConfidence {
    Authoritative,
    Verified,
    Maintained,
    Inferred,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedSubagentReasoningCapability {
    pub support_kind: ReasoningSupportKind,
    pub source: Option<String>,
    pub confidence: ReasoningConfidence,
    pub codex_selectable_efforts: Vec<CodexReasoningEffort>,
    pub provider_accepted_efforts: Vec<CodexReasoningEffort>,
    pub provider_default_effort: Option<CodexReasoningEffort>,
    pub disable_allowed: bool,
    pub effort_map: BTreeMap<CodexReasoningEffort, CodexReasoningEffort>,
    /// 仅在 Codex V2 中有编排语义；Provider 请求仍使用 max。
    #[serde(default, skip_serializing_if = "is_false")]
    pub codex_ultra_orchestration_enabled: bool,
    /// 来源能力的稳定指纹；无来源（unknown 兜底）时为空串。
    ///
    /// P2 起 catalog / 请求转换 / Sub-Agent 各层投影必须携带同一指纹，
    /// 任何一层重新按模型名猜测档位都视为实现失败。
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelReasoningUpstream {
    pub format: String,
    pub parameter: String,
    #[serde(default)]
    pub effort_map: HashMap<String, String>,
}

/// Codex 产品层的 Ultra 编排能力。
///
/// Ultra 不会作为字符串传给第三方 Provider：Codex 在出站 Responses 请求前
/// 将它固定降为 `max`，同时（仅 V2）启用主动 Sub-Agent 委派。因此它与
/// Provider 原生 reasoning effort 必须分开持久化。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUltraOrchestrationCapability {
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelReasoningCapability {
    /// 能力 schema 版本。缺失表示 legacy v1；新写入固定为 2。
    ///
    /// 注意：这是模型推理能力 schema 的版本，与 Codex Sub-Agent V1/V2 无关，
    /// 代码、错误码与 UI 文案中禁止混用简称。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<u32>,
    /// 三态支持状态（schema v2）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support_status: Option<ReasoningSupportStatus>,
    /// 控制形态（schema v2）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control_kind: Option<ReasoningControlKind>,
    /// Legacy 字段：仅用于读取旧数据；新写入不得包含。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supported: Option<bool>,
    #[serde(default)]
    pub supported_efforts: Vec<String>,
    pub default_effort: Option<String>,
    pub disable_allowed: bool,
    pub upstream: CodexModelReasoningUpstream,
    pub output_format: Option<String>,
    pub source: Option<String>,
    /// 证据等级（schema v2）。易变元数据，不进入能力指纹。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<CapabilityConfidence>,
    /// 检测时间（schema v2）。易变元数据，不进入能力指纹。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<String>,
    /// Provider 身份（schema v2）。易变元数据，不进入能力指纹。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_key: Option<String>,
    /// 模型 revision（schema v2）。易变元数据，不进入能力指纹。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_revision: Option<String>,
    /// 可选的 Codex V2 Ultra 编排开关；不改变 Provider 原生能力声明。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_ultra_orchestration: Option<CodexUltraOrchestrationCapability>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningCapabilityRepairOutcome {
    pub repaired_models: Vec<String>,
    pub warnings: Vec<String>,
}

impl CodexModelReasoningCapability {
    /// 兼容读取旧能力声明：历史 schema 允许省略同名映射。
    ///
    /// 仅在读取/解析消费者入口调用；新写入仍必须直接通过 `validate()`，
    /// 从而维持“read old, write complete”的持久化契约。
    pub fn complete_identity_effort_map_for_read(mut self) -> Self {
        if let Some(format) = normalize_upstream_format(&self.upstream.format) {
            self.upstream.format = format;
        }
        if let Some(parameter) =
            normalize_upstream_parameter(&self.upstream.parameter, &self.upstream.format)
        {
            self.upstream.parameter = parameter;
        }
        if self.effective_support_status() == ReasoningSupportStatus::ConfirmedSupported
            && self.effective_control_kind() == ReasoningControlKind::Graded
            && !matches!(self.upstream.format.as_str(), "none" | "boolean")
        {
            for effort in &self.supported_efforts {
                if effort != "none" {
                    self.upstream
                        .effort_map
                        .entry(effort.clone())
                        .or_insert_with(|| effort.clone());
                }
            }
        }
        self
    }

    /// 生效三态状态：`supportStatus` 优先；legacy `supported` 仅用于读旧数据。
    pub fn effective_support_status(&self) -> ReasoningSupportStatus {
        if let Some(status) = self.support_status {
            return status;
        }
        match self.supported {
            Some(true) => ReasoningSupportStatus::ConfirmedSupported,
            Some(false) => ReasoningSupportStatus::ConfirmedUnsupported,
            None => ReasoningSupportStatus::Unknown,
        }
    }

    /// 生效控制形态：`controlKind` 优先；legacy 数据从声明字段推导。
    pub fn effective_control_kind(&self) -> ReasoningControlKind {
        if let Some(kind) = self.control_kind {
            return kind;
        }
        if !self.supported_efforts.is_empty() {
            return ReasoningControlKind::Graded;
        }
        match self.upstream.format.as_str() {
            "boolean" => ReasoningControlKind::Boolean,
            "none" => ReasoningControlKind::None,
            _ => ReasoningControlKind::Unknown,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        validate_upstream_wire_contract(&self.upstream.format, &self.upstream.parameter)?;
        if let (Some(status), Some(legacy)) = (self.support_status, self.supported) {
            let legacy_status = if legacy {
                ReasoningSupportStatus::ConfirmedSupported
            } else {
                ReasoningSupportStatus::ConfirmedUnsupported
            };
            if status != legacy_status {
                return Err("supportStatus contradicts legacy supported field".to_string());
            }
        }
        if self
            .supported_efforts
            .iter()
            .any(|effort| !VALID_PROVIDER_EFFORTS.contains(&effort.as_str()))
        {
            return Err("supportedEfforts contains an unknown or Codex-only effort".to_string());
        }
        if let Some(default_effort) = self.default_effort.as_deref() {
            if !self
                .supported_efforts
                .iter()
                .any(|item| item == default_effort)
            {
                return Err("defaultEffort must be present in supportedEfforts".to_string());
            }
        }
        if !self.disable_allowed && self.supported_efforts.iter().any(|effort| effort == "none") {
            return Err("none requires disableAllowed=true".to_string());
        }
        match self.effective_control_kind() {
            ReasoningControlKind::Graded if self.supported_efforts.is_empty() => {
                return Err("controlKind graded requires nonempty supportedEfforts".to_string());
            }
            ReasoningControlKind::Boolean | ReasoningControlKind::None
                if !self.supported_efforts.is_empty() =>
            {
                return Err("controlKind boolean/none cannot advertise efforts".to_string());
            }
            _ => {}
        }
        if self.effective_support_status() == ReasoningSupportStatus::ConfirmedUnsupported {
            if !self.supported_efforts.is_empty() {
                return Err("unsupported capability cannot advertise efforts".to_string());
            }
            if self.disable_allowed {
                return Err("unsupported capability cannot allow disabling".to_string());
            }
        }
        if self.upstream.effort_map.iter().any(|(source, target)| {
            !VALID_PROVIDER_EFFORTS.contains(&source.as_str())
                || !VALID_PROVIDER_EFFORTS.contains(&target.as_str())
        }) {
            return Err("effortMap contains an unknown or Codex-only effort".to_string());
        }
        if self.upstream.effort_map.values().any(|target| {
            !self
                .supported_efforts
                .iter()
                .any(|supported| supported == target)
        }) {
            return Err("effortMap target must be present in supportedEfforts".to_string());
        }
        if self
            .codex_ultra_orchestration
            .as_ref()
            .is_some_and(|ultra| ultra.enabled)
        {
            let max_target = self.upstream.effort_map.get("max").map(String::as_str);
            let has_usable_max_path = max_target
                .is_some_and(|target| self.supported_efforts.iter().any(|effort| effort == target));
            if !has_usable_max_path {
                return Err(
                    "Codex Ultra orchestration requires a valid max-to-Provider effortMap path"
                        .to_string(),
                );
            }
        }
        if self.effective_support_status() == ReasoningSupportStatus::ConfirmedSupported
            && self.effective_control_kind() == ReasoningControlKind::Graded
            && !matches!(self.upstream.format.as_str(), "none" | "boolean")
        {
            let missing = self
                .supported_efforts
                .iter()
                .filter(|effort| effort.as_str() != "none")
                .filter(|effort| !self.upstream.effort_map.contains_key(effort.as_str()))
                .cloned()
                .collect::<Vec<_>>();
            if !missing.is_empty() {
                return Err(format!(
                    "effortMap is missing Provider effort(s): {}",
                    missing.join(", ")
                ));
            }
        }
        Ok(())
    }
}

pub fn validate_upstream_wire_contract(format: &str, parameter: &str) -> Result<(), String> {
    let normalized_format = normalize_upstream_format(format)
        .ok_or_else(|| "upstream format is not supported".to_string())?;
    let normalized_parameter = normalize_upstream_parameter(parameter, &normalized_format)
        .ok_or_else(|| "upstream parameter is not supported".to_string())?;
    if format.trim() != normalized_format {
        return Err("upstream format is not supported".to_string());
    }
    if parameter.trim() != normalized_parameter {
        return Err("upstream parameter is not supported".to_string());
    }
    Ok(())
}

fn normalize_upstream_format(value: &str) -> Option<String> {
    let format = value.trim().to_ascii_lowercase();
    matches!(
        format.as_str(),
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
    .then_some(format)
}

fn normalize_upstream_parameter(value: &str, format: &str) -> Option<String> {
    let parameter = value.trim().to_ascii_lowercase();
    if parameter.is_empty() && format == "none" {
        return Some(parameter);
    }
    matches!(
        parameter.as_str(),
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
    .then_some(parameter)
}

/// 稳定能力指纹：只覆盖影响运行的规范化字段。
///
/// 不包含 `fetchedAt`、`source`、`confidence`、`schemaVersion` 等易变元数据；
/// legacy 与 v2 声明只要运行语义相同就产生相同指纹。`supportedEfforts` 按
/// 规范化顺序去重，`effortMap` 按键排序，保证与字段书写顺序无关。
pub fn capability_fingerprint(capability: &CodexModelReasoningCapability) -> String {
    let mut efforts: Vec<&str> = capability
        .supported_efforts
        .iter()
        .map(String::as_str)
        .collect();
    efforts.sort_unstable();
    efforts.dedup();
    let effort_map: BTreeMap<&str, &str> = capability
        .upstream
        .effort_map
        .iter()
        .map(|(source, target)| (source.as_str(), target.as_str()))
        .collect();
    let mut canonical = serde_json::json!({
        "supportStatus": capability.effective_support_status(),
        "controlKind": capability.effective_control_kind(),
        "supportedEfforts": efforts,
        "defaultEffort": capability.default_effort,
        "disableAllowed": capability.disable_allowed,
        "upstream": {
            "format": capability.upstream.format,
            "parameter": capability.upstream.parameter,
            "effortMap": effort_map,
        },
        "outputFormat": capability.output_format,
    });
    // 缺省 Ultra 配置与旧 schema 的运行语义相同，必须保持既有指纹，避免
    // 仅升级 CCSM 就触发无意义的 catalog / role 重写。
    if let Some(ultra) = &capability.codex_ultra_orchestration {
        canonical["codexUltraOrchestration"] =
            serde_json::to_value(ultra).expect("Ultra orchestration capability must serialize");
    }
    let digest = Sha256::digest(canonical.to_string().as_bytes());
    hex::encode(digest)
}

/// Repair persisted reasoning metadata that older CCSwitchMulti versions allowed to drift.
///
/// Exact DeepSeek V4 model IDs use the maintained built-in declaration. Unknown models keep
/// their own declared levels and merely choose the first valid level when their default is
/// invalid; they never inherit GPT or DeepSeek capabilities.
///
/// This helper is intentionally limited to the explicit force-repair workflow. The ordinary
/// catalogue normalizer may have already made a formerly invalid built-in declaration parse as
/// valid (for example, by selecting the first supported effort), so force repair needs a way to
/// restore the maintained declaration without changing normal persistence semantics.
pub fn restore_maintained_reasoning_capabilities(
    settings: &mut Value,
) -> ReasoningCapabilityRepairOutcome {
    let mut outcome = ReasoningCapabilityRepairOutcome::default();
    let Some(models) = settings
        .get_mut("modelCatalog")
        .and_then(|catalog| catalog.get_mut("models"))
        .and_then(Value::as_array_mut)
    else {
        return outcome;
    };

    for entry in models {
        let model = ["model", "id", "slug", "upstreamModel", "upstream_model"]
            .into_iter()
            .find_map(|field| entry.get(field).and_then(Value::as_str))
            .unwrap_or("")
            .trim()
            .to_string();
        let is_builtin = entry
            .get("reasoning")
            .and_then(Value::as_object)
            .and_then(|reasoning| reasoning.get("source"))
            .and_then(Value::as_str)
            .is_some_and(|source| source == "builtin");
        let Some(builtin) = builtin_reasoning_capability_for_model(&model) else {
            continue;
        };
        if !is_builtin {
            continue;
        }
        let builtin_value = serde_json::to_value(builtin)
            .expect("built-in reasoning capability must be serializable");
        if entry.get("reasoning") == Some(&builtin_value) {
            continue;
        }
        entry["reasoning"] = builtin_value;
        outcome.repaired_models.push(model.clone());
        outcome.warnings.push(format!(
            "Restored maintained reasoning capability for {model} during force repair"
        ));
    }

    outcome
}

pub fn repair_invalid_reasoning_capabilities(
    settings: &mut Value,
) -> ReasoningCapabilityRepairOutcome {
    let mut outcome = ReasoningCapabilityRepairOutcome::default();
    let Some(models) = settings
        .get_mut("modelCatalog")
        .and_then(|catalog| catalog.get_mut("models"))
        .and_then(Value::as_array_mut)
    else {
        return outcome;
    };

    for entry in models {
        let model = ["model", "id", "slug", "upstreamModel", "upstream_model"]
            .into_iter()
            .find_map(|field| entry.get(field).and_then(Value::as_str))
            .unwrap_or("")
            .trim()
            .to_string();
        let Some(reasoning) = entry.get("reasoning") else {
            continue;
        };
        let parsed = serde_json::from_value::<CodexModelReasoningCapability>(reasoning.clone());
        if parsed.as_ref().is_ok_and(|value| value.validate().is_ok()) {
            continue;
        }

        if let Some(builtin) = builtin_reasoning_capability_for_model(&model) {
            entry["reasoning"] = serde_json::to_value(builtin)
                .expect("built-in reasoning capability must be serializable");
            outcome.repaired_models.push(model.clone());
            outcome.warnings.push(format!(
                "Restored maintained reasoning capability for {model}"
            ));
            continue;
        }

        let Some(object) = entry.get_mut("reasoning").and_then(Value::as_object_mut) else {
            continue;
        };
        let supported = object
            .get("supportedEfforts")
            .and_then(Value::as_array)
            .map(|values| {
                let mut seen = HashSet::new();
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|effort| VALID_PROVIDER_EFFORTS.contains(effort))
                    .filter(|effort| seen.insert((*effort).to_string()))
                    .map(|effort| Value::String(effort.to_string()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let supported_names = supported
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<HashSet<_>>();
        object.insert("supportedEfforts".to_string(), Value::Array(supported));

        let default_is_valid = object
            .get("defaultEffort")
            .and_then(Value::as_str)
            .is_some_and(|effort| supported_names.contains(effort));
        if !default_is_valid {
            if let Some(first) = supported_names
                .iter()
                .min_by_key(|effort| {
                    VALID_PROVIDER_EFFORTS
                        .iter()
                        .position(|candidate| candidate == &effort.as_str())
                        .unwrap_or(usize::MAX)
                })
                .cloned()
            {
                object.insert("defaultEffort".to_string(), Value::String(first));
            } else {
                object.remove("defaultEffort");
            }
        }
        if let Some(effort_map) = object
            .get_mut("upstream")
            .and_then(Value::as_object_mut)
            .and_then(|upstream| upstream.get_mut("effortMap"))
            .and_then(Value::as_object_mut)
        {
            effort_map.retain(|source, target| {
                VALID_PROVIDER_EFFORTS.contains(&source.as_str())
                    && target
                        .as_str()
                        .is_some_and(|target| supported_names.contains(target))
            });
        }
        outcome.repaired_models.push(model.clone());
        outcome.warnings.push(format!(
            "Repaired invalid reasoning metadata for {model} using only its declared efforts"
        ));
    }

    outcome
}

pub fn resolve_subagent_reasoning_capability(
    capability: Option<&CodexModelReasoningCapability>,
) -> ResolvedSubagentReasoningCapability {
    let normalized = capability
        .cloned()
        .map(CodexModelReasoningCapability::complete_identity_effort_map_for_read);
    let Some(capability) = normalized.as_ref().filter(|value| value.validate().is_ok()) else {
        return ResolvedSubagentReasoningCapability {
            support_kind: ReasoningSupportKind::Unknown,
            source: None,
            confidence: ReasoningConfidence::Unverified,
            codex_selectable_efforts: Vec::new(),
            provider_accepted_efforts: Vec::new(),
            provider_default_effort: None,
            disable_allowed: false,
            effort_map: BTreeMap::new(),
            codex_ultra_orchestration_enabled: false,
            fingerprint: String::new(),
        };
    };

    let provider_accepted_efforts = CodexReasoningEffort::ORDERED
        .into_iter()
        .filter(|effort| {
            capability
                .supported_efforts
                .iter()
                .any(|value| value == effort.as_str())
        })
        .collect::<Vec<_>>();
    let provider_effort_set = provider_accepted_efforts
        .iter()
        .copied()
        .collect::<HashSet<_>>();
    let mut effort_map = provider_accepted_efforts
        .iter()
        .copied()
        .map(|effort| (effort, effort))
        .collect::<BTreeMap<_, _>>();
    for (source, target) in &capability.upstream.effort_map {
        let Ok(source) = source.parse::<CodexReasoningEffort>() else {
            continue;
        };
        let Ok(target) = target.parse::<CodexReasoningEffort>() else {
            continue;
        };
        if provider_effort_set.contains(&target) {
            effort_map.insert(source, target);
        }
    }

    let selectable_set = provider_effort_set.iter().copied().collect::<HashSet<_>>();
    let codex_selectable_efforts: Vec<_> = CodexReasoningEffort::ORDERED
        .into_iter()
        // P2：none 先按 disable capability 处理，不作为普通正向 effort 暴露给
        // Codex 选择（UI/spawn_agent 的可选档位不含 none；关闭走 disable 路径）。
        .filter(|effort| *effort != CodexReasoningEffort::None)
        .filter(|effort| selectable_set.contains(effort))
        .collect();
    let mut codex_selectable_efforts = codex_selectable_efforts;
    if capability
        .codex_ultra_orchestration
        .as_ref()
        .is_some_and(|ultra| ultra.enabled)
    {
        // Codex emits `max` at the Provider boundary for internal Ultra. Keep
        // the mapping explicit in the resolved contract so UI, catalog and
        // generated roles can explain the same behavior without claiming the
        // Provider accepts a literal `ultra` effort.
        if let Some(max_target) = effort_map.get(&CodexReasoningEffort::Max).copied() {
            effort_map.insert(CodexReasoningEffort::Ultra, max_target);
            codex_selectable_efforts.push(CodexReasoningEffort::Ultra);
        }
    }
    // 映射补全：Codex 档位阶梯上 Provider 不原生接受、声明映射也未覆盖的档位，
    // 一律钳到最近的受支持档位（等距时取更高档），使解析后的契约对 Codex 端
    // 可能发送的每个档位都有明确目标。否则旧会话/主模型发来如 `high`（典型：
    // gpt-5.6-sol 路由到仅支持 low/medium/xhigh 的 Qwen Provider）时，转换层
    // 宽映射兜底查不到映射、allowed 校验也拒绝，fail-closed 422 打断整个会话。
    // fail-closed 仅保留给 Codex 阶梯之外的未知档位值。
    for effort in CodexReasoningEffort::ORDERED.iter().copied() {
        if matches!(effort, CodexReasoningEffort::None) {
            continue;
        }
        if effort_map.contains_key(&effort) {
            continue;
        }
        if let Some(target) = nearest_supported_effort(effort, &provider_effort_set) {
            effort_map.insert(effort, target);
        }
    }
    let support_kind = match capability.effective_support_status() {
        ReasoningSupportStatus::ConfirmedUnsupported => ReasoningSupportKind::Unsupported,
        ReasoningSupportStatus::Unknown => ReasoningSupportKind::Unknown,
        ReasoningSupportStatus::ConfirmedSupported => {
            if !provider_accepted_efforts.is_empty() {
                ReasoningSupportKind::EffortLevels
            } else if capability.upstream.format == "boolean" {
                ReasoningSupportKind::BooleanOnly
            } else {
                // 支持已确认但未声明控制形态：按控制未知处理，不暴露任何档位，
                // 也不继承 GPT 通用档位。
                ReasoningSupportKind::Unknown
            }
        }
    };
    let confidence = match capability.source.as_deref() {
        Some("builtin") => ReasoningConfidence::Confirmed,
        Some("user") => ReasoningConfidence::Declared,
        _ => ReasoningConfidence::Unverified,
    };

    ResolvedSubagentReasoningCapability {
        support_kind,
        source: capability.source.clone(),
        confidence,
        codex_selectable_efforts,
        provider_accepted_efforts,
        provider_default_effort: capability
            .default_effort
            .as_deref()
            .and_then(|value| value.parse().ok()),
        disable_allowed: capability.disable_allowed,
        effort_map,
        codex_ultra_orchestration_enabled: capability
            .codex_ultra_orchestration
            .as_ref()
            .is_some_and(|ultra| ultra.enabled),
        fingerprint: capability_fingerprint(capability),
    }
}

/// 为 Provider 不原生接受的 Codex 档位找最近的受支持档位。
///
/// 等距时取更高档（与 openrouter `max→xhigh`、deepseek 全档钳高等既有一致：
/// 不无必要地把用户意图往下降），保证解析结果确定且可解释。
fn nearest_supported_effort(
    effort: CodexReasoningEffort,
    supported: &HashSet<CodexReasoningEffort>,
) -> Option<CodexReasoningEffort> {
    let rank = |candidate: CodexReasoningEffort| {
        CodexReasoningEffort::ORDERED
            .iter()
            .position(|item| *item == candidate)
    };
    let target_rank = rank(effort)?;
    let mut best: Option<(usize, bool, CodexReasoningEffort)> = None;
    for candidate in supported {
        let candidate_rank = rank(*candidate)?;
        let (distance, at_or_above) = if candidate_rank >= target_rank {
            (candidate_rank - target_rank, true)
        } else {
            (target_rank - candidate_rank, false)
        };
        let better = match best {
            None => true,
            Some((best_distance, best_above, _)) => {
                distance < best_distance
                    || (distance == best_distance && at_or_above && !best_above)
            }
        };
        if better {
            best = Some((distance, at_or_above, *candidate));
        }
    }
    best.map(|(_, _, candidate)| candidate)
}

/// Return CCSwitchMulti's maintained capability for exact, stable model IDs.
///
/// This is a migration fallback for Provider/model-catalog rows saved before reasoning metadata
/// became part of the persisted schema. Explicit row metadata remains authoritative. Keep this
/// list narrow: unknown third-party models must not inherit GPT effort levels.
pub fn builtin_reasoning_capability_for_model(
    model: &str,
) -> Option<CodexModelReasoningCapability> {
    let normalized = model.trim().to_ascii_lowercase();
    // 官方维护清单：DeepSeek V4 与 Kimi K3 均支持 reasoning_effort: low/high/max（默认 high）。
    // 保持精确匹配，未知第三方模型不得继承 GPT 通用档位。
    if !matches!(
        normalized.as_str(),
        "deepseek-v4-flash" | "deepseek-v4-pro" | "deepseek-v4-flash-vision-exp" | "k3" | "k3-256k"
    ) {
        return None;
    }
    // DeepSeek Responses 返回 reasoning_content 字段；Kimi 响应字段未确认，
    // 不声明 output_format（代理层按默认行为处理，避免错误字段破坏转换）。
    let output_format = if normalized.starts_with("deepseek") {
        Some("reasoning_content".into())
    } else {
        None
    };
    Some(CodexModelReasoningCapability {
        schema_version: Some(2),
        support_status: Some(ReasoningSupportStatus::ConfirmedSupported),
        control_kind: Some(ReasoningControlKind::Graded),
        supported: None,
        supported_efforts: vec!["low".into(), "high".into(), "max".into()],
        default_effort: Some("high".into()),
        disable_allowed: true,
        upstream: CodexModelReasoningUpstream {
            format: "string".into(),
            parameter: "reasoning_effort".into(),
            effort_map: [
                ("low".into(), "low".into()),
                ("medium".into(), "high".into()),
                ("high".into(), "high".into()),
                ("xhigh".into(), "high".into()),
                ("max".into(), "max".into()),
            ]
            .into_iter()
            .collect(),
        },
        output_format,
        source: Some("builtin".into()),
        confidence: Some(CapabilityConfidence::Maintained),
        fetched_at: None,
        provider_key: None,
        model_revision: None,
        codex_ultra_orchestration: None,
    })
}

pub fn reasoning_capability_from_model_entry(
    model_entry: &Value,
) -> Option<CodexModelReasoningCapability> {
    let value = model_entry.get("reasoning")?;
    if value.is_null() {
        // reasoning: null 与缺失等价，均视为"未声明"
        return None;
    }
    let model = model_entry
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("?");
    let mut capability: CodexModelReasoningCapability = match serde_json::from_value::<
        CodexModelReasoningCapability,
    >(value.clone())
    {
        Ok(capability) => capability,
        Err(error) => {
            // A number of older provider catalogs use the compact
            // `supportedEfforts`/`defaultEffort` form without the full
            // schema-v2 `upstream` object. Preserve that valid declaration
            // through the same validation path, but never reinterpret an
            // object that already contains canonical fields.
            if let Some(capability) = lightweight_reasoning_capability(value) {
                capability
            } else {
                // 声明存在但无法解析：打日志暴露问题，避免用户手动声明
                // 被静默当作"未声明"而清空（v27/v28 回归）。
                log::warn!(
                        "Codex reasoning declaration for model {model} is not parseable and will be ignored: {error}"
                    );
                return None;
            }
        }
    };
    // Normalize provider/catalog input at the parser boundary. Validation
    // remains strict so manually constructed capabilities cannot carry a
    // mixed-case value into runtime exact comparisons.
    let format = normalize_upstream_format(&capability.upstream.format)?;
    let parameter = normalize_upstream_parameter(&capability.upstream.parameter, &format)?;
    capability.upstream.format = format;
    capability.upstream.parameter = parameter;
    let capability = capability.complete_identity_effort_map_for_read();
    if let Err(error) = capability.validate() {
        log::warn!(
            "Codex reasoning declaration for model {model} is invalid and will be ignored: {error}"
        );
        return None;
    }
    Some(capability)
}

/// Parse the compact catalog shape used by older provider/model entries.
///
/// This is intentionally narrower than the canonical schema: if any
/// schema-v2 marker is present, callers must provide the complete object and
/// malformed declarations remain invalid instead of falling through here.
fn lightweight_reasoning_capability(value: &Value) -> Option<CodexModelReasoningCapability> {
    let object = value.as_object()?;
    let canonical_markers = [
        "schemaVersion",
        "schema_version",
        "supportStatus",
        "support_status",
        "controlKind",
        "control_kind",
        "supported",
        "disableAllowed",
        "disable_allowed",
        "upstream",
        "source",
        "confidence",
    ];
    if canonical_markers
        .iter()
        .any(|field| object.contains_key(*field))
    {
        return None;
    }
    let compact_fields = [
        "supportedEfforts",
        "supported_efforts",
        "defaultEffort",
        "default_effort",
        "reasoningFormat",
        "reasoning_format",
        "upstreamFormat",
        "upstream_format",
        "reasoningParameter",
        "reasoning_parameter",
        "upstreamParameter",
        "upstream_parameter",
        "outputFormat",
        "output_format",
    ];
    if object
        .keys()
        .any(|field| !compact_fields.contains(&field.as_str()))
    {
        return None;
    }

    let parse_levels = |value: &Value| -> Option<Vec<String>> {
        let values = value.as_array()?;
        let mut efforts = Vec::with_capacity(values.len());
        for value in values {
            let effort = value.as_str()?.trim().to_ascii_lowercase();
            if effort.is_empty() || !VALID_PROVIDER_EFFORTS.contains(&effort.as_str()) {
                return None;
            }
            if !efforts.contains(&effort) {
                efforts.push(effort);
            }
        }
        Some(efforts)
    };
    let levels = match (
        object.get("supportedEfforts"),
        object.get("supported_efforts"),
    ) {
        (Some(camel), Some(snake)) => {
            let camel = parse_levels(camel)?;
            let snake = parse_levels(snake)?;
            let mut left = camel.clone();
            let mut right = snake;
            left.sort();
            right.sort();
            (left == right).then_some(camel)?
        }
        (Some(value), None) | (None, Some(value)) => parse_levels(value)?,
        (None, None) => return None,
    };
    let supported_efforts = levels;
    let default_effort = match (object.get("defaultEffort"), object.get("default_effort")) {
        (Some(camel), Some(snake)) => {
            let camel = camel.as_str()?.trim().to_ascii_lowercase();
            let snake = snake.as_str()?.trim().to_ascii_lowercase();
            if camel.is_empty() || camel != snake {
                return None;
            }
            Some(camel)
        }
        (Some(value), None) | (None, Some(value)) => {
            let effort = value.as_str()?.trim().to_ascii_lowercase();
            if effort.is_empty() {
                return None;
            }
            Some(effort)
        }
        (None, None) => None,
    };
    if let Some(default_effort) = default_effort.as_deref() {
        if !supported_efforts
            .iter()
            .any(|effort| effort == default_effort)
        {
            return None;
        }
    }

    let format = object
        .get("reasoningFormat")
        .or_else(|| object.get("reasoning_format"))
        .or_else(|| object.get("upstreamFormat"))
        .or_else(|| object.get("upstream_format"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|format| !format.is_empty())
        .unwrap_or("string");
    let format = normalize_upstream_format(format)?;
    let parameter = object
        .get("reasoningParameter")
        .or_else(|| object.get("reasoning_parameter"))
        .or_else(|| object.get("upstreamParameter"))
        .or_else(|| object.get("upstream_parameter"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|parameter| !parameter.is_empty())
        .unwrap_or("reasoning_effort");
    let parameter = normalize_upstream_parameter(parameter, &format)?;
    let output_format = object
        .get("outputFormat")
        .or_else(|| object.get("output_format"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|format| !format.is_empty())
        .map(ToString::to_string);
    if output_format.as_deref().is_some_and(|format| {
        !matches!(
            format,
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
    }) {
        return None;
    }
    let capability = CodexModelReasoningCapability {
        schema_version: Some(2),
        support_status: Some(ReasoningSupportStatus::ConfirmedSupported),
        control_kind: Some(if supported_efforts.is_empty() {
            ReasoningControlKind::None
        } else {
            ReasoningControlKind::Graded
        }),
        supported: None,
        supported_efforts: supported_efforts.clone(),
        default_effort,
        disable_allowed: supported_efforts.iter().any(|effort| effort == "none"),
        upstream: CodexModelReasoningUpstream {
            format,
            parameter,
            effort_map: supported_efforts
                .iter()
                .filter(|effort| effort.as_str() != "none")
                .map(|effort| (effort.clone(), effort.clone()))
                .collect(),
        },
        output_format,
        source: None,
        confidence: None,
        fetched_at: None,
        provider_key: None,
        model_revision: None,
        codex_ultra_orchestration: None,
    };
    capability.validate().ok().map(|_| capability)
}

/// Parse a reasoning declaration embedded in a Codex provider's inline
/// `model_providers.*.models[]` entry.
///
/// Codex stores these entries in TOML rather than CCSM's model catalog schema,
/// so accept both the native `reasoning` object and the lightweight
/// `supported_reasoning_levels`/`default_reasoning_level` form used by routed
/// model definitions. The returned capability is normalized to the same
/// validated shape consumed by the shared resolver.
pub fn reasoning_capability_from_provider_model_entry(
    model_entry: &Value,
) -> Option<CodexModelReasoningCapability> {
    if let Some(reasoning) = model_entry.get("reasoning") {
        if !reasoning.is_null() {
            let mut capability = reasoning_capability_from_model_entry(model_entry)?;
            capability.source = Some("provider_config".to_string());
            capability.confidence = Some(CapabilityConfidence::Authoritative);
            return capability.validate().ok().map(|_| capability);
        }
    }
    if let Some(mut capability) = reasoning_capability_from_model_entry(model_entry) {
        capability.source = Some("provider_config".to_string());
        capability.confidence = Some(CapabilityConfidence::Authoritative);
        return capability.validate().ok().map(|_| capability);
    }

    let supported_efforts = strict_official_levels(model_entry)?;
    let default_effort = strict_official_default(model_entry)?
        .and_then(|effort| supported_efforts.contains(&effort).then_some(effort));
    let format = model_entry
        .get("reasoning_format")
        .or_else(|| model_entry.get("reasoningFormat"))
        .and_then(Value::as_str)
        .unwrap_or("string")
        .to_string();
    let parameter = model_entry
        .get("reasoning_parameter")
        .or_else(|| model_entry.get("reasoningParameter"))
        .and_then(Value::as_str)
        .map(|value| {
            normalize_upstream_parameter(value, "string")
                .unwrap_or_else(|| value.trim().to_ascii_lowercase())
        })
        .unwrap_or_else(|| "reasoning_effort".to_string());
    let format =
        normalize_upstream_format(&format).unwrap_or_else(|| format.trim().to_ascii_lowercase());
    let capability = CodexModelReasoningCapability {
        schema_version: Some(2),
        support_status: Some(ReasoningSupportStatus::ConfirmedSupported),
        control_kind: Some(ReasoningControlKind::Graded),
        supported: None,
        supported_efforts: supported_efforts.clone(),
        default_effort,
        disable_allowed: supported_efforts.iter().any(|effort| effort == "none"),
        upstream: CodexModelReasoningUpstream {
            format,
            parameter,
            effort_map: supported_efforts
                .iter()
                .map(|effort| (effort.clone(), effort.clone()))
                .collect(),
        },
        output_format: model_entry
            .get("reasoning_output_format")
            .or_else(|| model_entry.get("reasoningOutputFormat"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        source: Some("provider_config".to_string()),
        confidence: Some(CapabilityConfidence::Authoritative),
        fetched_at: None,
        provider_key: None,
        model_revision: None,
        codex_ultra_orchestration: None,
    };
    capability.validate().ok().map(|_| capability)
}

pub fn resolve_reasoning_capability_from_settings(
    settings: &Value,
    model: &str,
) -> Option<CodexModelReasoningCapability> {
    let crate::codex_multirouter::catalog::CatalogModelLookup::Found(entry) =
        crate::codex_multirouter::catalog::lookup_catalog_model(settings, model)
    else {
        return None;
    };
    if entry.get("enabled").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    reasoning_capability_from_model_entry(entry)
}

fn official_model_identity_values(entry: &Value) -> Vec<&str> {
    let mut values = Vec::new();
    for field in ["slug", "id", "canonicalSlug", "canonical_slug", "name"] {
        if let Some(value) = entry.get(field).and_then(Value::as_str) {
            values.push(value);
        }
    }
    for field in ["aliases", "alias"] {
        match entry.get(field) {
            Some(Value::Array(values_array)) => {
                values.extend(values_array.iter().filter_map(Value::as_str));
            }
            Some(Value::Object(values_object)) => {
                values.extend(values_object.keys().map(String::as_str));
                values.extend(values_object.values().filter_map(Value::as_str));
            }
            _ => {}
        }
    }
    values
}

fn strict_reasoning_levels(value: &Value) -> Option<Vec<String>> {
    let values = value.as_array()?;
    let mut levels = Vec::with_capacity(values.len());
    for value in values {
        let effort = if let Some(value) = value.as_str() {
            value.trim().to_ascii_lowercase()
        } else {
            let object = value.as_object()?;
            let mut declared = Vec::new();
            for field in ["effort", "reasoning_effort", "reasoningEffort"] {
                if let Some(value) = object.get(field) {
                    declared.push(value.as_str()?.trim().to_ascii_lowercase());
                }
            }
            if declared.is_empty()
                || declared.iter().any(|value| value.is_empty())
                || declared.windows(2).any(|values| values[0] != values[1])
            {
                return None;
            }
            declared.remove(0)
        };
        if effort.is_empty() {
            return None;
        }
        if !VALID_CODEX_EFFORTS.contains(&effort.as_str()) {
            return None;
        }
        levels.push(effort);
    }
    (!levels.is_empty()).then_some(levels)
}

fn strict_official_levels(entry: &Value) -> Option<Vec<String>> {
    let snake = entry.get("supported_reasoning_levels");
    let camel = entry
        .get("supportedReasoningLevels")
        .or_else(|| entry.get("supported_reasoning_efforts"))
        .or_else(|| entry.get("supportedReasoningEfforts"));
    let snake = match snake {
        Some(value) => Some(strict_reasoning_levels(value)?),
        None => None,
    };
    let camel = match camel {
        Some(value) => Some(strict_reasoning_levels(value)?),
        None => None,
    };
    match (snake, camel) {
        (Some(left), Some(right)) if left != right => None,
        (Some(levels), _) | (_, Some(levels)) => Some(levels),
        (None, None) => None,
    }
}

fn strict_official_default(entry: &Value) -> Option<Option<String>> {
    let fields = [
        "default_reasoning_level",
        "default_reasoning_effort",
        "defaultReasoningLevel",
        "defaultReasoningEffort",
    ];
    let mut found = None;
    for field in fields {
        let Some(value) = entry.get(field) else {
            continue;
        };
        let value = value.as_str()?.trim().to_ascii_lowercase();
        if value.is_empty() || !VALID_CODEX_EFFORTS.contains(&value.as_str()) {
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
    Some(found)
}

/// 从 Codex 官方模型缓存为指定 slug 构造 reasoning capability（P2：official 来源）。
///
/// 官方缓存字段是 snake_case，`supported_reasoning_levels` 可能是字符串数组
/// （["low","medium",...]）或对象数组（[{"effort":"low","description":...},...]）：
/// CCSM 写入的 cache 为字符串数组，官方 backup 为对象数组，两种都兼容。
/// 官方 GPT 模型走 OpenAI 顶层 `reasoning_effort` 字段，effort_map 用 identity。
/// 任何校验失败都返回 None（保守降级为 Unknown，不产生虚假档位）。
///
/// 该来源只适用于未知平台（platform=None，含 OpenAI 直连与 catalog 投影）；
/// OpenRouter/vLLM 等已知聚合平台有自己的推理接口，不得套用官方 OpenAI 形态。
pub fn official_reasoning_capability_for_model(
    model: &str,
    official_models: &[Value],
) -> Option<CodexModelReasoningCapability> {
    let entry = official_models.iter().find(|entry| {
        official_model_identity_values(entry)
            .into_iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(model))
    })?;
    let mut levels = strict_official_levels(entry)?;
    // 官方目录里的 ultra 同样是 Codex 产品层的编排语义：请求边界仍会变成
    // max。因此将其从 Provider 原生档位剥离，避免下游把 ultra 透传给 API。
    let codex_ultra_enabled = levels.iter().any(|level| level == "ultra");
    levels.retain(|level| level != "ultra");
    let default_effort = strict_official_default(entry)?.and_then(|default_effort| {
        if default_effort == "ultra" {
            Some("max".to_string())
        } else {
            levels.contains(&default_effort).then_some(default_effort)
        }
    });
    let mut effort_map = levels
        .iter()
        .map(|level| (level.clone(), level.clone()))
        .collect::<HashMap<_, _>>();
    if !levels.iter().any(|level| level == "none") {
        if let Some(lowest_effort) = VALID_PROVIDER_EFFORTS
            .iter()
            .find(|candidate| levels.iter().any(|level| level == **candidate))
            .map(|effort| (*effort).to_string())
        {
            effort_map.insert("none".to_string(), lowest_effort.clone());
            effort_map.insert("minimal".to_string(), lowest_effort);
        }
    }
    let capability = CodexModelReasoningCapability {
        schema_version: Some(2),
        support_status: Some(ReasoningSupportStatus::ConfirmedSupported),
        control_kind: Some(ReasoningControlKind::Graded),
        supported: None,
        supported_efforts: levels.clone(),
        default_effort,
        disable_allowed: false,
        upstream: CodexModelReasoningUpstream {
            format: "string".to_string(),
            parameter: "reasoning_effort".to_string(),
            effort_map,
        },
        output_format: None,
        source: Some("official".to_string()),
        confidence: Some(CapabilityConfidence::Authoritative),
        fetched_at: None,
        provider_key: None,
        model_revision: None,
        codex_ultra_orchestration: codex_ultra_enabled
            .then_some(CodexUltraOrchestrationCapability { enabled: true }),
    };
    capability.validate().ok()?;
    Some(capability)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn efforts(values: &[&str]) -> Vec<CodexReasoningEffort> {
        values
            .iter()
            .map(|value| value.parse().expect("valid reasoning effort fixture"))
            .collect()
    }

    #[test]
    fn repair_legacy_deepseek_reasoning_restores_builtin_capability() {
        let mut settings = json!({
            "modelCatalog": {"models": [{
                "model": "deepseek-v4-flash",
                "reasoning": {
                    "supported": true,
                    "supportedEfforts": ["low", "high", "max"],
                    "defaultEffort": "medium",
                    "disableAllowed": true,
                    "upstream": {"format": "string", "parameter": "reasoning_effort"},
                    "source": "builtin"
                }
            }]}
        });

        let outcome = repair_invalid_reasoning_capabilities(&mut settings);
        let repaired = &settings["modelCatalog"]["models"][0]["reasoning"];
        assert_eq!(repaired["supportedEfforts"], json!(["low", "high", "max"]));
        assert_eq!(repaired["defaultEffort"], json!("high"));
        assert!(outcome
            .repaired_models
            .contains(&"deepseek-v4-flash".to_string()));
        assert!(!outcome.warnings.is_empty());
    }

    #[test]
    fn force_repair_restores_builtin_after_catalog_normalization() {
        let mut settings = json!({
            "modelCatalog": {"models": [{
                "model": "deepseek-v4-flash",
                "reasoning": {
                    "schemaVersion": 2,
                    "supportStatus": "confirmed_supported",
                    "controlKind": "graded",
                    "supportedEfforts": ["low", "high", "max"],
                    "defaultEffort": "low",
                    "disableAllowed": true,
                    "upstream": {
                        "format": "string",
                        "parameter": "reasoning_effort",
                        "effortMap": {
                            "low": "low",
                            "high": "high",
                            "max": "max"
                        }
                    },
                    "source": "builtin"
                }
            }]}
        });

        let outcome = restore_maintained_reasoning_capabilities(&mut settings);
        assert_eq!(
            settings["modelCatalog"]["models"][0]["reasoning"]["defaultEffort"],
            json!("high")
        );
        assert_eq!(outcome.repaired_models, vec!["deepseek-v4-flash"]);
    }

    #[test]
    fn repair_unknown_reasoning_uses_only_declared_supported_efforts() {
        let mut settings = json!({
            "modelCatalog": {"models": [{
                "model": "private-model",
                "reasoning": {
                    "supported": true,
                    "supportedEfforts": ["low", "ultra"],
                    "defaultEffort": "high",
                    "disableAllowed": false,
                    "upstream": {"format": "string", "parameter": "reasoning_effort"},
                    "source": "user"
                }
            }]}
        });

        let outcome = repair_invalid_reasoning_capabilities(&mut settings);
        let repaired = &settings["modelCatalog"]["models"][0]["reasoning"];
        assert_eq!(repaired["supportedEfforts"], json!(["low"]));
        assert_eq!(repaired["defaultEffort"], json!("low"));
        assert_eq!(repaired["source"], json!("user"));
        assert!(outcome
            .repaired_models
            .contains(&"private-model".to_string()));
    }

    fn deepseek_capability() -> CodexModelReasoningCapability {
        serde_json::from_value(json!({
            "supported": true,
            "supportedEfforts": ["low", "high", "max"],
            "defaultEffort": "high",
            "disableAllowed": true,
            "upstream": {
                "format": "string",
                "parameter": "reasoning_effort",
                "effortMap": {
                    "low": "low",
                    "medium": "high",
                    "high": "high",
                    "xhigh": "high",
                    "max": "max"
                }
            },
            "source": "builtin"
        }))
        .expect("DeepSeek fixture")
    }

    #[test]
    fn deepseek_resolution_separates_provider_and_codex_efforts() {
        let resolved = resolve_subagent_reasoning_capability(Some(&deepseek_capability()));
        assert_eq!(
            resolved.provider_accepted_efforts,
            efforts(&["low", "high", "max"])
        );
        assert_eq!(
            resolved.codex_selectable_efforts,
            efforts(&["low", "high", "max"])
        );
        assert_eq!(
            resolved.effort_map.get(&CodexReasoningEffort::Medium),
            Some(&CodexReasoningEffort::High)
        );
        assert!(!resolved
            .codex_selectable_efforts
            .contains(&CodexReasoningEffort::Ultra));
    }

    #[test]
    fn codex_ultra_orchestration_adds_ultra_without_claiming_provider_support() {
        let mut capability = deepseek_capability();
        let mut value = serde_json::to_value(&capability).expect("serialize fixture");
        value["codexUltraOrchestration"] = json!({ "enabled": true });
        capability = serde_json::from_value(value).expect("parse ultra-enabled fixture");

        let resolved = resolve_subagent_reasoning_capability(Some(&capability));

        assert_eq!(
            resolved.provider_accepted_efforts,
            efforts(&["low", "high", "max"]),
            "Ultra is a Codex orchestration mode, not a Provider-native effort"
        );
        assert!(resolved
            .codex_selectable_efforts
            .contains(&CodexReasoningEffort::Ultra));
        assert_eq!(
            resolved.effort_map.get(&CodexReasoningEffort::Ultra),
            Some(&CodexReasoningEffort::Max),
            "Ultra must reach a third-party Provider through the verified max path"
        );
    }

    #[test]
    fn resolution_clamps_codex_efforts_the_provider_cannot_accept() {
        // 回归锁定：Qwen 形态 Provider（low/medium/xhigh + Ultra 编排→xhigh）必须对
        // Codex 端可发送但不被原生接受的档位（high、minimal）给出明确目标，
        // 转换层宽映射兜底据此钳制，不再 fail-closed 422。
        let capability: CodexModelReasoningCapability = serde_json::from_value(json!({
            "schemaVersion": 2,
            "supportStatus": "confirmed_supported",
            "controlKind": "graded",
            "supportedEfforts": ["low", "medium", "xhigh"],
            "defaultEffort": "medium",
            "disableAllowed": true,
            "upstream": {
                "format": "string",
                "parameter": "reasoning_effort",
                "effortMap": {
                    "low": "low",
                    "medium": "medium",
                    "xhigh": "xhigh",
                    "max": "xhigh"
                }
            },
            "codexUltraOrchestration": {"enabled": true},
            "source": "user"
        }))
        .expect("Qwen-style fixture");

        let resolved = resolve_subagent_reasoning_capability(Some(&capability));
        assert_eq!(
            resolved.codex_selectable_efforts,
            efforts(&["low", "medium", "xhigh", "ultra"]),
            "selectable stays provider-native + Ultra; clamped levels are not advertised"
        );
        assert_eq!(
            resolved.effort_map.get(&CodexReasoningEffort::High),
            Some(&CodexReasoningEffort::XHigh),
            "high must clamp to the nearer supported level above medium"
        );
        assert_eq!(
            resolved.effort_map.get(&CodexReasoningEffort::Minimal),
            Some(&CodexReasoningEffort::Low),
            "minimal must clamp down to low"
        );
        assert_eq!(
            resolved.effort_map.get(&CodexReasoningEffort::Ultra),
            Some(&CodexReasoningEffort::XHigh),
            "Ultra orchestration target stays authoritative"
        );
        assert_eq!(
            resolved.effort_map.get(&CodexReasoningEffort::Low),
            Some(&CodexReasoningEffort::Low),
            "native identity mappings are untouched"
        );
    }

    #[test]
    fn codex_ultra_orchestration_requires_a_usable_max_path() {
        let mut capability = deepseek_capability();
        capability.supported_efforts = vec!["low".to_string(), "high".to_string()];
        capability.default_effort = Some("high".to_string());
        capability.upstream.effort_map.remove("max");
        let mut value = serde_json::to_value(&capability).expect("serialize fixture");
        value["codexUltraOrchestration"] = json!({ "enabled": true });
        let capability: CodexModelReasoningCapability =
            serde_json::from_value(value).expect("parse ultra-enabled fixture");

        assert!(
            capability.validate().is_err(),
            "enabling Codex Ultra without a Provider max path must be rejected before save"
        );
    }

    #[test]
    fn rejects_ultra_as_a_provider_native_effort_or_persisted_mapping() {
        let mut capability = deepseek_capability();
        capability.supported_efforts.push("ultra".to_string());
        assert!(
            capability.validate().is_err(),
            "Ultra must be represented only by codexUltraOrchestration"
        );

        let mut capability = deepseek_capability();
        capability
            .upstream
            .effort_map
            .insert("ultra".to_string(), "max".to_string());
        assert!(
            capability.validate().is_err(),
            "persisted Provider mappings must not accept Codex-only Ultra"
        );
    }

    #[test]
    fn official_ultra_default_is_normalized_to_max_before_provider_validation() {
        let official_models = vec![json!({
            "slug": "gpt-5.6-sol",
            "supported_reasoning_levels": ["low", "high", "max", "ultra"],
            "default_reasoning_level": "ultra"
        })];

        let capability = official_reasoning_capability_for_model("gpt-5.6-sol", &official_models)
            .expect("official Ultra model capability");
        assert_eq!(capability.supported_efforts, vec!["low", "high", "max"]);
        assert_eq!(capability.default_effort.as_deref(), Some("max"));
        assert_eq!(
            capability.codex_ultra_orchestration,
            Some(CodexUltraOrchestrationCapability { enabled: true })
        );
        assert!(capability.validate().is_ok());
    }

    #[test]
    fn official_model_maps_legacy_disabled_efforts_to_lowest_supported_level() {
        let official_models = vec![json!({
            "slug": "gpt-6-astra",
            "supported_reasoning_levels": ["max", "xhigh", "high", "medium", "low"],
            "default_reasoning_level": "low"
        })];

        let capability = official_reasoning_capability_for_model("gpt-6-astra", &official_models)
            .expect("official Astra capability");
        assert_eq!(
            capability
                .upstream
                .effort_map
                .get("none")
                .map(String::as_str),
            Some("low")
        );
        assert_eq!(
            capability
                .upstream
                .effort_map
                .get("minimal")
                .map(String::as_str),
            Some("low")
        );
    }

    #[test]
    fn unknown_capability_does_not_advertise_candidate_efforts() {
        let resolved = resolve_subagent_reasoning_capability(None);
        assert_eq!(resolved.support_kind, ReasoningSupportKind::Unknown);
        assert_eq!(resolved.confidence, ReasoningConfidence::Unverified);
        assert!(resolved.codex_selectable_efforts.is_empty());
        assert!(resolved.provider_accepted_efforts.is_empty());
    }

    #[test]
    fn rejects_mapping_to_effort_the_provider_does_not_accept() {
        let mut capability = deepseek_capability();
        capability
            .upstream
            .effort_map
            .insert("medium".to_string(), "medium".to_string());
        assert_eq!(
            capability.validate(),
            Err("effortMap target must be present in supportedEfforts".to_string())
        );
    }

    #[test]
    fn rejects_unknown_upstream_wire_contract_values() {
        let mut capability = deepseek_capability();
        capability.upstream.format = "server-command".to_string();
        assert_eq!(
            capability.validate(),
            Err("upstream format is not supported".to_string())
        );
        let mut capability = deepseek_capability();
        capability.upstream.parameter = "api_key".to_string();
        assert_eq!(
            capability.validate(),
            Err("upstream parameter is not supported".to_string())
        );
    }

    #[test]
    fn rejects_noncanonical_upstream_wire_case_before_runtime_comparison() {
        let mut capability = deepseek_capability();
        capability.upstream.format = "STRING".to_string();
        assert_eq!(
            capability.validate(),
            Err("upstream format is not supported".to_string())
        );

        let mut capability = deepseek_capability();
        capability.upstream.parameter = "REASONING_EFFORT".to_string();
        assert_eq!(
            capability.validate(),
            Err("upstream parameter is not supported".to_string())
        );
    }

    #[test]
    fn read_normalization_canonicalizes_legacy_wire_case_before_resolution() {
        let mut capability = deepseek_capability();
        capability.upstream.format = "STRING".to_string();
        capability.upstream.parameter = "REASONING_EFFORT".to_string();
        let capability = capability.complete_identity_effort_map_for_read();
        assert_eq!(capability.upstream.format, "string");
        assert_eq!(capability.upstream.parameter, "reasoning_effort");
        assert!(capability.validate().is_ok());
    }

    #[test]
    fn parser_normalizes_mixed_case_upstream_wire_metadata() {
        let canonical_entry = json!({
            "model": "canonical-mixed-case-model",
            "reasoning": {
                "schemaVersion": 2,
                "supportStatus": "confirmed_supported",
                "controlKind": "graded",
                "supportedEfforts": ["low", "high"],
                "defaultEffort": "high",
                "disableAllowed": false,
                "upstream": {
                    "format": "STRING",
                    "parameter": "REASONING_EFFORT",
                    "effortMap": {"low": "low", "high": "high"}
                }
            }
        });
        let capability = reasoning_capability_from_model_entry(&canonical_entry)
            .expect("mixed-case canonical declaration should normalize");
        assert_eq!(capability.upstream.format, "string");
        assert_eq!(capability.upstream.parameter, "reasoning_effort");
        assert!(capability.validate().is_ok());

        let entry = json!({
            "model": "mixed-case-model",
            "reasoning": {
                "supportedEfforts": ["low", "high"],
                "defaultEffort": "high",
                "reasoningFormat": "STRING",
                "reasoningParameter": "REASONING_EFFORT"
            }
        });
        let capability = reasoning_capability_from_model_entry(&entry)
            .expect("mixed-case compact declaration should normalize");
        assert_eq!(capability.upstream.format, "string");
        assert_eq!(capability.upstream.parameter, "reasoning_effort");
        assert!(capability.validate().is_ok());

        let provider_entry = json!({
            "id": "provider-model",
            "supported_reasoning_levels": ["low", "high"],
            "reasoning_format": "STRING",
            "reasoning_parameter": "REASONING_EFFORT"
        });
        let capability = reasoning_capability_from_provider_model_entry(&provider_entry)
            .expect("mixed-case provider declaration should normalize");
        assert_eq!(capability.upstream.format, "string");
        assert_eq!(capability.upstream.parameter, "reasoning_effort");
        assert!(capability.validate().is_ok());
    }

    #[test]
    fn rejects_incomplete_graded_effort_mapping() {
        let mut capability = deepseek_capability();
        capability.upstream.effort_map.remove("low");
        capability.upstream.effort_map.remove("high");
        capability.upstream.effort_map.remove("max");
        assert_eq!(
            capability.validate(),
            Err("effortMap is missing Provider effort(s): low, high, max".to_string())
        );
    }

    #[test]
    fn boolean_control_does_not_require_effort_mapping() {
        let capability: CodexModelReasoningCapability = serde_json::from_value(json!({
            "schemaVersion": 2,
            "supportStatus": "confirmed_supported",
            "controlKind": "boolean",
            "supportedEfforts": [],
            "disableAllowed": true,
            "upstream": {"format": "boolean", "parameter": "enable_thinking"}
        }))
        .expect("boolean capability");
        assert!(capability.validate().is_ok());
    }

    #[test]
    fn resolves_visible_or_upstream_model_from_same_catalog_row() {
        let settings = json!({"modelCatalog":{"models":[{
            "model":"visible-glm", "upstreamModel":"glm-5.2",
            "reasoning":{"supported":true,"supportedEfforts":["high","max"],
                "defaultEffort":"max","disableAllowed":false,
                "upstream":{"format":"string","parameter":"reasoning_effort"}}
        }]}});
        assert_eq!(
            resolve_reasoning_capability_from_settings(&settings, "visible-glm")
                .and_then(|capability| capability.default_effort),
            Some("max".to_string())
        );
        assert!(resolve_reasoning_capability_from_settings(&settings, "glm-5.2").is_some());
    }

    #[test]
    fn catalog_reasoning_selects_exact_row_before_exclusion_or_parsing() {
        let sibling = json!({
            "model": "sibling", "upstreamModel": "exact",
            "reasoning": {
                "supported": true, "supportedEfforts": ["low", "high"],
                "defaultEffort": "high", "disableAllowed": false,
                "upstream": {"format": "string", "parameter": "reasoning_effort"}
            }
        });
        for exact in [
            json!({"model": "exact", "enabled": false, "reasoning": sibling["reasoning"]}),
            json!({"model": "exact"}),
            json!({"model": "exact", "reasoning": {"supportedEfforts": ["invalid"]}}),
        ] {
            for rows in [
                vec![sibling.clone(), exact.clone()],
                vec![exact.clone(), sibling.clone()],
            ] {
                let settings = json!({"modelCatalog": {"models": rows}});
                assert!(resolve_reasoning_capability_from_settings(&settings, "exact").is_none());
            }
        }
    }

    #[test]
    fn catalog_reasoning_rejects_ambiguous_upstream_and_alias_matches() {
        for identity in [
            json!({"upstreamModel": "shared"}),
            json!({"aliases": ["shared"]}),
            json!({"alias": {"shared": "wire"}}),
        ] {
            let mut first = identity.clone();
            first["model"] = json!("first");
            first["reasoning"] = json!({
                "supported": true, "supportedEfforts": ["high", "max"],
                "defaultEffort": "max", "disableAllowed": false,
                "upstream": {"format": "string", "parameter": "reasoning_effort"}
            });
            let mut second = identity;
            second["model"] = json!("second");
            for rows in [
                vec![first.clone(), second.clone()],
                vec![second.clone(), first.clone()],
            ] {
                let settings = json!({"modelCatalog": {"models": rows}});
                assert!(resolve_reasoning_capability_from_settings(&settings, "shared").is_none());
            }
        }
    }

    #[test]
    fn catalog_reasoning_uses_legacy_only_when_canonical_is_unusable() {
        let entry = json!({
            "model": "catalog-model",
            "reasoning": {
                "supported": true, "supportedEfforts": ["low", "max"],
                "defaultEffort": "max", "disableAllowed": false,
                "upstream": {"format": "string", "parameter": "reasoning_effort"}
            }
        });
        let mut settings = json!({"model_catalog": {"models": [entry]}});
        assert!(resolve_reasoning_capability_from_settings(&settings, "catalog-model").is_some());
        settings["modelCatalog"] = json!({"models": []});
        assert!(resolve_reasoning_capability_from_settings(&settings, "catalog-model").is_none());
        settings["modelCatalog"] = json!({"models": null});
        assert!(resolve_reasoning_capability_from_settings(&settings, "catalog-model").is_some());
    }

    #[test]
    fn catalog_reasoning_does_not_resolve_excluded_rows_or_their_aliases() {
        let settings = json!({"modelCatalog": {"models": [{
            "model": "excluded-model", "upstreamModel": "upstream-model",
            "aliases": ["alias-model"], "enabled": false,
            "reasoning": {
                "supported": true, "supportedEfforts": ["low", "max"],
                "defaultEffort": "max", "disableAllowed": false,
                "upstream": {"format": "string", "parameter": "reasoning_effort"}
            }
        }]}});
        for model in ["excluded-model", "upstream-model", "alias-model"] {
            assert!(
                resolve_reasoning_capability_from_settings(&settings, model).is_none(),
                "{model} must not resolve from an excluded catalog row"
            );
        }
    }

    #[test]
    fn catalog_reasoning_resolves_canonical_identity_and_declared_aliases() {
        for aliases in [
            json!(["alias-model"]),
            json!({"alias-model": "public-model"}),
        ] {
            let settings = json!({"modelCatalog": {"models": [{
                "model": "public-model", "canonicalSlug": "canonical-model",
                "aliases": aliases,
                "reasoning": {
                    "supported": true, "supportedEfforts": ["low", "max"],
                    "defaultEffort": "max", "disableAllowed": false,
                    "upstream": {"format": "string", "parameter": "reasoning_effort"}
                }
            }]}});
            for model in ["public-model", "canonical-model", "alias-model"] {
                assert!(
                    resolve_reasoning_capability_from_settings(&settings, model).is_some(),
                    "{model} must resolve from the same canonical row"
                );
            }
        }
    }

    #[test]
    fn provider_model_reasoning_accepts_camel_case_levels_and_default() {
        let entry = json!({
            "id": "provider-model",
            "supportedReasoningLevels": [
                {"reasoningEffort": "low"}, {"effort": "high"}, "max"
            ],
            "defaultReasoningLevel": "max"
        });
        let capability = reasoning_capability_from_provider_model_entry(&entry)
            .expect("camel-case provider reasoning");
        assert_eq!(capability.supported_efforts, vec!["low", "high", "max"]);
        assert_eq!(capability.default_effort.as_deref(), Some("max"));
    }

    #[test]
    fn catalog_reasoning_accepts_compact_supported_efforts_declaration() {
        let settings = json!({"modelCatalog":{"models":[{
            "model": "compact-model",
            "reasoning": {
                "supportedEfforts": ["low", "high"],
                "defaultEffort": "low"
            }
        }]}});
        let capability = resolve_reasoning_capability_from_settings(&settings, "compact-model")
            .expect("compact catalog declaration");
        assert_eq!(capability.supported_efforts, vec!["low", "high"]);
        assert_eq!(capability.default_effort.as_deref(), Some("low"));
        assert_eq!(capability.upstream.format, "string");
        assert_eq!(capability.upstream.parameter, "reasoning_effort");
    }

    #[test]
    fn compact_empty_efforts_remain_authoritative_without_library_fallback() {
        let settings = json!({"modelCatalog":{"models":[{
            "model": "compact-no-levels",
            "reasoning": {"supportedEfforts": []}
        }]}});
        let capability = resolve_reasoning_capability_from_settings(&settings, "compact-no-levels")
            .expect("explicit empty compact declaration");
        assert!(capability.supported_efforts.is_empty());
        assert_eq!(
            capability.effective_control_kind(),
            ReasoningControlKind::None
        );
    }

    #[test]
    fn compact_reasoning_does_not_rescue_malformed_canonical_declaration() {
        let settings = json!({"modelCatalog":{"models":[{
            "model": "broken-model",
            "reasoning": {
                "supportStatus": "confirmed_supported",
                "supportedEfforts": ["low"],
                "defaultEffort": "high"
            }
        }]}});
        assert!(
            resolve_reasoning_capability_from_settings(&settings, "broken-model").is_none(),
            "canonical markers must stay fail-closed when the full declaration is invalid"
        );
    }

    #[test]
    fn provider_model_reasoning_rejects_partial_or_conflicting_effort_metadata() {
        for levels in [
            json!(["low", 7, "max"]),
            json!(["low", "", "max"]),
            json!(["low", {"description": "missing effort"}, "max"]),
            json!([{"effort": "low", "reasoningEffort": "max"}]),
        ] {
            let entry = json!({"supported_reasoning_levels": levels});
            assert!(
                reasoning_capability_from_provider_model_entry(&entry).is_none(),
                "malformed entries must reject the whole declared effort list"
            );
        }
        let conflict = json!({
            "supported_reasoning_levels": ["low"],
            "supportedReasoningLevels": ["max"]
        });
        assert!(reasoning_capability_from_provider_model_entry(&conflict).is_none());
        let conflict = json!({
            "supported_reasoning_levels": ["low", "max"],
            "default_reasoning_level": "low",
            "defaultReasoningLevel": "max"
        });
        assert!(reasoning_capability_from_provider_model_entry(&conflict).is_none());
        let malformed_default = json!({
            "supported_reasoning_levels": ["low", "max"],
            "default_reasoning_level": 7
        });
        assert!(reasoning_capability_from_provider_model_entry(&malformed_default).is_none());
    }

    #[test]
    fn provider_model_reasoning_does_not_hide_invalid_canonical_declaration() {
        let entry = json!({
            "reasoning": {
                "supported": true, "supportedEfforts": ["low"],
                "defaultEffort": "max", "disableAllowed": false,
                "upstream": {"format": "string", "parameter": "reasoning_effort"}
            },
            "supported_reasoning_levels": ["low", "max"]
        });
        assert!(reasoning_capability_from_provider_model_entry(&entry).is_none());
    }

    #[test]
    fn official_reasoning_accepts_model_id_aliases_and_camel_case_levels() {
        let official = vec![json!({
            "id": "official-model", "canonicalSlug": "official-canonical",
            "aliases": ["official-alias"],
            "supportedReasoningLevels": ["low", {"reasoningEffort": "max"}, "ultra"],
            "defaultReasoningLevel": "ultra"
        })];
        for model in ["official-model", "official-canonical", "official-alias"] {
            let capability = official_reasoning_capability_for_model(model, &official)
                .expect("all declared identities resolve");
            assert_eq!(capability.supported_efforts, vec!["low", "max"]);
            assert_eq!(capability.default_effort.as_deref(), Some("max"));
            assert!(capability
                .codex_ultra_orchestration
                .is_some_and(|ultra| ultra.enabled));
            assert!(!capability.upstream.effort_map.contains_key("ultra"));
        }
    }

    #[test]
    fn official_reasoning_rejects_partial_or_conflicting_effort_metadata() {
        for levels in [
            json!(["low", 7, "max"]),
            json!(["low", "unknown-effort", "max"]),
            json!(["low", "", "max"]),
            json!([{"effort": "low", "reasoningEffort": "max"}]),
        ] {
            let official = vec![json!({
                "slug": "official-model", "supported_reasoning_levels": levels
            })];
            assert!(official_reasoning_capability_for_model("official-model", &official).is_none());
        }
        let official = vec![json!({
            "slug": "official-model", "supported_reasoning_levels": ["low"],
            "supportedReasoningLevels": ["max"]
        })];
        assert!(official_reasoning_capability_for_model("official-model", &official).is_none());
    }

    #[test]
    fn rejects_invalid_default_instead_of_guessing() {
        let settings = json!({"modelCatalog":{"models":[{
            "model":"broken",
            "reasoning":{"supported":true,"supportedEfforts":["low"],
                "defaultEffort":"high","disableAllowed":false,
                "upstream":{"format":"string","parameter":"reasoning_effort"}}
        }]}});
        assert!(resolve_reasoning_capability_from_settings(&settings, "broken").is_none());
    }

    #[test]
    fn restores_only_exact_builtin_deepseek_v4_capabilities() {
        let flash = builtin_reasoning_capability_for_model("deepseek-v4-flash")
            .expect("known Flash capability");
        let pro = builtin_reasoning_capability_for_model("DEEPSEEK-V4-PRO")
            .expect("known Pro capability");
        let vision = builtin_reasoning_capability_for_model("deepseek-v4-flash-vision-exp")
            .expect("known Flash Vision capability");
        assert_eq!(flash.supported_efforts, vec!["low", "high", "max"]);
        assert_eq!(pro.default_effort.as_deref(), Some("high"));
        assert_eq!(vision.default_effort.as_deref(), Some("high"));
        assert!(builtin_reasoning_capability_for_model("deepseek-v4-flash-preview").is_none());
        assert!(builtin_reasoning_capability_for_model("vendor/deepseek-v4-pro").is_none());
    }

    #[test]
    fn restores_exact_kimi_k3_capabilities() {
        for model in ["k3", "K3-256K", "k3-256k"] {
            let capability = builtin_reasoning_capability_for_model(model)
                .unwrap_or_else(|| panic!("{model} must resolve a Kimi capability"));
            assert_eq!(capability.supported_efforts, vec!["low", "high", "max"]);
            assert_eq!(capability.default_effort.as_deref(), Some("high"));
            // Kimi 响应字段未确认，output_format 保持 None
            assert_eq!(capability.output_format, None);
            assert_eq!(capability.source.as_deref(), Some("builtin"));
        }
        assert!(builtin_reasoning_capability_for_model("k3-ultra").is_none());
        assert!(builtin_reasoning_capability_for_model("vendor/k3").is_none());
    }

    // ===== P0 契约：三态 schema v2 与能力指纹 =====

    #[test]
    fn new_schema_unknown_parses_and_resolves_unknown() {
        // 字段缺失/未声明 = unknown，绝不继承 GPT 档位，也不得被当作解析失败丢弃。
        let capability: CodexModelReasoningCapability = serde_json::from_value(json!({
            "schemaVersion": 2,
            "supportStatus": "unknown",
            "controlKind": "unknown",
            "supportedEfforts": [],
            "disableAllowed": false,
            "upstream": {"format": "none", "parameter": "none"},
            "source": "provider"
        }))
        .expect("schema v2 unknown capability must parse");
        assert_eq!(
            capability.effective_support_status(),
            ReasoningSupportStatus::Unknown
        );
        assert_eq!(
            capability.effective_control_kind(),
            ReasoningControlKind::Unknown
        );
        assert!(capability.validate().is_ok());

        let resolved = resolve_subagent_reasoning_capability(Some(&capability));
        assert_eq!(resolved.support_kind, ReasoningSupportKind::Unknown);
        assert!(resolved.codex_selectable_efforts.is_empty());
        assert!(resolved.provider_accepted_efforts.is_empty());
        assert!(resolved.provider_default_effort.is_none());
        assert!(!resolved.disable_allowed);
        // resolved 结果必须携带来源能力的稳定指纹。
        assert_eq!(resolved.fingerprint, capability_fingerprint(&capability));
        assert!(!resolved.fingerprint.is_empty());
    }

    #[test]
    fn new_schema_confirmed_unsupported_rejects_efforts_and_disable() {
        let with_efforts: CodexModelReasoningCapability = serde_json::from_value(json!({
            "schemaVersion": 2,
            "supportStatus": "confirmed_unsupported",
            "supportedEfforts": ["low"],
            "disableAllowed": false,
            "upstream": {"format": "none", "parameter": "none"}
        }))
        .expect("parse");
        assert_eq!(
            with_efforts.validate(),
            Err("unsupported capability cannot advertise efforts".to_string())
        );

        let with_disable: CodexModelReasoningCapability = serde_json::from_value(json!({
            "schemaVersion": 2,
            "supportStatus": "confirmed_unsupported",
            "supportedEfforts": [],
            "disableAllowed": true,
            "upstream": {"format": "none", "parameter": "none"}
        }))
        .expect("parse");
        assert_eq!(
            with_disable.validate(),
            Err("unsupported capability cannot allow disabling".to_string())
        );

        // 无效声明不得被信任为 confirmed_unsupported（fail-closed 回退 unknown）；
        // 有效的 confirmed_unsupported 才解析为 Unsupported。
        let invalid_resolved = resolve_subagent_reasoning_capability(Some(&with_disable));
        assert_eq!(invalid_resolved.support_kind, ReasoningSupportKind::Unknown);

        let valid_unsupported: CodexModelReasoningCapability = serde_json::from_value(json!({
            "schemaVersion": 2,
            "supportStatus": "confirmed_unsupported",
            "supportedEfforts": [],
            "disableAllowed": false,
            "upstream": {"format": "none", "parameter": "none"}
        }))
        .expect("parse");
        let resolved = resolve_subagent_reasoning_capability(Some(&valid_unsupported));
        assert_eq!(resolved.support_kind, ReasoningSupportKind::Unsupported);
        assert!(resolved.codex_selectable_efforts.is_empty());
    }

    #[test]
    fn explicit_empty_efforts_are_not_filled_by_template() {
        // 明确的 supportedEfforts=[] 是“无分档”声明：任何投影都不得回退到通用档位。
        let capability: CodexModelReasoningCapability = serde_json::from_value(json!({
            "schemaVersion": 2,
            "supportStatus": "confirmed_supported",
            "controlKind": "boolean",
            "supportedEfforts": [],
            "disableAllowed": true,
            "upstream": {"format": "boolean", "parameter": "enable_thinking"},
            "outputFormat": "reasoning_content",
            "source": "user"
        }))
        .expect("schema v2 boolean capability must parse");
        assert!(capability.validate().is_ok());

        let resolved = resolve_subagent_reasoning_capability(Some(&capability));
        assert_eq!(resolved.support_kind, ReasoningSupportKind::BooleanOnly);
        assert!(resolved.codex_selectable_efforts.is_empty());
        assert!(resolved.provider_accepted_efforts.is_empty());
        assert!(resolved.provider_default_effort.is_none());
        assert!(resolved.disable_allowed);
    }

    #[test]
    fn legacy_supported_bool_still_parses_and_derives_status() {
        let legacy_true: CodexModelReasoningCapability = serde_json::from_value(json!({
            "supported": true,
            "supportedEfforts": ["low", "high"],
            "defaultEffort": "high",
            "disableAllowed": false,
            "upstream": {"format": "string", "parameter": "reasoning_effort"}
        }))
        .expect("legacy capability must parse");
        assert_eq!(
            legacy_true.effective_support_status(),
            ReasoningSupportStatus::ConfirmedSupported
        );
        assert_eq!(
            legacy_true.effective_control_kind(),
            ReasoningControlKind::Graded
        );

        let legacy_false: CodexModelReasoningCapability = serde_json::from_value(json!({
            "supported": false,
            "supportedEfforts": [],
            "disableAllowed": false,
            "upstream": {"format": "none", "parameter": "none"}
        }))
        .expect("legacy capability must parse");
        assert_eq!(
            legacy_false.effective_support_status(),
            ReasoningSupportStatus::ConfirmedUnsupported
        );
        assert_eq!(
            legacy_false.effective_control_kind(),
            ReasoningControlKind::None
        );
    }

    #[test]
    fn support_status_contradicting_legacy_supported_is_rejected() {
        let capability: CodexModelReasoningCapability = serde_json::from_value(json!({
            "schemaVersion": 2,
            "supportStatus": "confirmed_supported",
            "supported": false,
            "supportedEfforts": ["low"],
            "disableAllowed": false,
            "upstream": {"format": "string", "parameter": "reasoning_effort"}
        }))
        .expect("parse");
        assert_eq!(
            capability.validate(),
            Err("supportStatus contradicts legacy supported field".to_string())
        );
    }

    #[test]
    fn fingerprint_is_stable_across_volatile_metadata() {
        let base: CodexModelReasoningCapability = serde_json::from_value(json!({
            "schemaVersion": 2,
            "supportStatus": "confirmed_supported",
            "controlKind": "graded",
            "supportedEfforts": ["low", "high", "max"],
            "defaultEffort": "high",
            "disableAllowed": true,
            "upstream": {
                "format": "string",
                "parameter": "reasoning_effort",
                "effortMap": {"medium": "high", "low": "low"}
            },
            "outputFormat": "reasoning_content",
            "source": "builtin",
            "confidence": "maintained",
            "fetchedAt": "2026-08-17T00:00:00Z",
            "providerKey": "deepseek",
            "modelRevision": "v4"
        }))
        .expect("parse");
        let mut volatile = base.clone();
        volatile.fetched_at = Some("2031-01-01T00:00:00Z".into());
        volatile.source = Some("user".into());
        volatile.confidence = Some(CapabilityConfidence::Inferred);
        volatile.provider_key = Some("other".into());
        volatile.model_revision = Some("v9".into());
        volatile.schema_version = None;
        // legacy 形态但运行语义相同：指纹必须一致。
        let mut legacy = base.clone();
        legacy.schema_version = None;
        legacy.support_status = None;
        legacy.control_kind = None;
        legacy.supported = Some(true);
        assert_eq!(
            capability_fingerprint(&base),
            capability_fingerprint(&volatile)
        );
        assert_eq!(
            capability_fingerprint(&base),
            capability_fingerprint(&legacy)
        );
    }

    #[test]
    fn fingerprint_changes_with_execution_fields() {
        let base: CodexModelReasoningCapability = serde_json::from_value(json!({
            "schemaVersion": 2,
            "supportStatus": "confirmed_supported",
            "controlKind": "graded",
            "supportedEfforts": ["low", "high", "max"],
            "defaultEffort": "high",
            "disableAllowed": true,
            "upstream": {"format": "string", "parameter": "reasoning_effort"}
        }))
        .expect("parse");
        let base_fingerprint = capability_fingerprint(&base);

        let mut different_default = base.clone();
        different_default.default_effort = Some("max".into());
        assert_ne!(base_fingerprint, capability_fingerprint(&different_default));

        let mut different_disable = base.clone();
        different_disable.disable_allowed = false;
        assert_ne!(base_fingerprint, capability_fingerprint(&different_disable));

        // 档位顺序不同但集合相同：指纹不变。
        let mut reordered = base.clone();
        reordered.supported_efforts = vec!["max".into(), "low".into(), "high".into()];
        assert_eq!(base_fingerprint, capability_fingerprint(&reordered));

        let mut different_parameter = base.clone();
        different_parameter.upstream.parameter = "thinking".into();
        assert_ne!(
            base_fingerprint,
            capability_fingerprint(&different_parameter)
        );
    }

    #[test]
    fn none_is_disable_not_positive_effort() {
        // P2：none 先按 disable capability 处理，不能作为普通正向 effort 映射。
        // provider_accepted_efforts 含 none（关闭契约），codex_selectable_efforts 不含
        // none（UI/spawn_agent 可选档位不含 none），effort_map 把 none 映射到 none。
        let capability: CodexModelReasoningCapability = serde_json::from_value(json!({
            "schemaVersion": 2,
            "supportStatus": "confirmed_supported",
            "controlKind": "graded",
            "supportedEfforts": ["none", "low", "high", "max"],
            "defaultEffort": "high",
            "disableAllowed": true,
            "upstream": {"format": "string", "parameter": "reasoning_effort"}
        }))
        .expect("parse");
        let resolved = resolve_subagent_reasoning_capability(Some(&capability));
        // provider_accepted_efforts 含 none（关闭契约需要）。
        assert!(resolved
            .provider_accepted_efforts
            .contains(&CodexReasoningEffort::None));
        // codex_selectable_efforts 不含 none（none 是关闭，不是可选正向档位）。
        assert!(!resolved
            .codex_selectable_efforts
            .contains(&CodexReasoningEffort::None));
        assert_eq!(
            resolved.codex_selectable_efforts,
            vec![
                CodexReasoningEffort::Low,
                CodexReasoningEffort::High,
                CodexReasoningEffort::Max
            ]
        );
        // effort_map 把 none 映射到 none（identity，即关闭）。
        assert_eq!(
            resolved.effort_map.get(&CodexReasoningEffort::None),
            Some(&CodexReasoningEffort::None)
        );
        // disable_allowed 为 true（能力声明显式携带关闭契约）。
        assert!(resolved.disable_allowed);
    }
}
