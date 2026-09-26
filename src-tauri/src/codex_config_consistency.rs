use crate::app_config::AppType;
use crate::codex_config;
use crate::error::AppError;
use crate::services::provider::build_codex_live_config_for_provider;
use crate::store::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use tauri::State;

const LAST_ACTION_KEY: &str = "codex_config_consistency:last_action";
const LAST_ACTUAL_FINGERPRINT_KEY: &str = "codex_config_consistency:last_actual_fingerprint";
const LAST_PROVIDER_ID_KEY: &str = "codex_config_consistency:last_provider_id";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexConfigConsistencyState {
    Consistent,
    ExternalDrift,
    NotApplicable,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexConfigConsistencyReport {
    pub state: CodexConfigConsistencyState,
    pub provider_id: Option<String>,
    pub expected_fingerprint: Option<String>,
    pub actual_fingerprint: Option<String>,
    pub changed_keys: Vec<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexConfigConsistencyAction {
    ApplyCcsm,
    KeepCodex,
    Later,
}

fn canonicalize_toml_value(value: &toml::Value) -> JsonValue {
    match value {
        toml::Value::String(value) => JsonValue::String(value.clone()),
        toml::Value::Integer(value) => JsonValue::Number((*value).into()),
        toml::Value::Float(value) => serde_json::Number::from_f64(*value)
            .map(JsonValue::Number)
            .unwrap_or_else(|| JsonValue::String(value.to_string())),
        toml::Value::Boolean(value) => JsonValue::Bool(*value),
        toml::Value::Datetime(value) => JsonValue::String(value.to_string()),
        toml::Value::Array(values) => {
            JsonValue::Array(values.iter().map(canonicalize_toml_value).collect())
        }
        toml::Value::Table(values) => {
            let mut object = JsonMap::new();
            for (name, value) in values {
                object.insert(name.clone(), canonicalize_toml_value(value));
            }
            JsonValue::Object(object)
        }
    }
}

#[cfg(test)]
fn canonicalize_toml(text: &str) -> Result<JsonValue, AppError> {
    let value = text.parse::<toml::Value>().map_err(|error| {
        AppError::Config(format!("Codex config.toml semantic parse failed: {error}"))
    })?;
    Ok(canonicalize_toml_value(&value))
}

#[cfg(test)]
pub(crate) fn fingerprint_toml(text: &str) -> Result<String, AppError> {
    let canonical = canonicalize_toml(text)?;
    let bytes = serde_json::to_vec(&canonical)
        .map_err(|error| AppError::JsonSerialize { source: error })?;
    let digest = Sha256::digest(bytes);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Top-level `config.toml` keys CCSwitchMulti owns and may rewrite.
///
/// This is the ownership boundary that keeps Codex-owned runtime state out of
/// the drift fingerprint. Codex CLI and Codex Desktop legitimately own
/// `approval_policy`, `notify`, `[agents]`, `[desktop]`, `[features.*]`,
/// `[marketplaces]`, `[mcp_servers]`, `[plugins]`, `[projects]` and `[windows]`,
/// and rewrite them on every launch and update. Fingerprinting the whole
/// document made each of those look like external Provider drift.
const CCSM_MANAGED_TOP_LEVEL_KEYS: &[&str] = &[
    "model",
    "model_provider",
    // Fork-owned: per-provider reasoning effort is part of the Provider's
    // Codex config, so a hand edit that disagrees with the Provider form is
    // real routing drift worth reporting.
    "model_reasoning_effort",
    "model_catalog_json",
    "openai_base_url",
    "experimental_bearer_token",
];

/// `developer_instructions` is shared: CCSwitchMulti owns only the Sub-Agent V2
/// policy block. The rest of the string is the user's own text.
const NO_MANAGED_SUBAGENT_POLICY: &str = "<ccsm-no-managed-subagent-policy>";

fn active_model_provider_id(value: &toml::Value) -> Option<String> {
    value
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn managed_subagent_policy(root: &toml::map::Map<String, toml::Value>) -> Option<String> {
    let instructions = root.get("developer_instructions")?.as_str()?;
    Some(
        codex_config::codex_subagent_v2_policy_block(instructions)
            .unwrap_or_else(|| NO_MANAGED_SUBAGENT_POLICY.to_string()),
    )
}

fn ccsm_owned_projection(
    text: &str,
    provider_id_hint: Option<&str>,
) -> Result<JsonValue, AppError> {
    let value = text.parse::<toml::Value>().map_err(|error| {
        AppError::Config(format!("Codex config.toml semantic parse failed: {error}"))
    })?;
    let root = value
        .as_table()
        .ok_or_else(|| AppError::Config("Codex config.toml root must be a table".to_string()))?;
    let mut managed = toml::map::Map::new();

    for key in CCSM_MANAGED_TOP_LEVEL_KEYS {
        if let Some(value) = root.get(*key) {
            managed.insert((*key).to_string(), value.clone());
        }
    }

    if let Some(policy) = managed_subagent_policy(root) {
        managed.insert(
            "developer_instructions".to_string(),
            toml::Value::String(policy),
        );
    }

    if root
        .get(crate::codex_config::CODEX_WEB_SEARCH_FIELD)
        .and_then(toml::Value::as_str)
        == Some(crate::codex_config::CODEX_WEB_SEARCH_DISABLED)
    {
        managed.insert(
            crate::codex_config::CODEX_WEB_SEARCH_FIELD.to_string(),
            root[crate::codex_config::CODEX_WEB_SEARCH_FIELD].clone(),
        );
    }

    let provider_id = provider_id_hint
        .map(str::to_string)
        .or_else(|| active_model_provider_id(&value));
    if provider_id.as_deref() == Some(crate::codex_config::CC_SWITCH_CODEX_ROUTER_MODEL_PROVIDER_ID)
    {
        for key in ["model_context_window", "model_auto_compact_token_limit"] {
            if let Some(value) = root.get(key) {
                managed.insert(key.to_string(), value.clone());
            }
        }
    }

    if let Some(provider_id) = provider_id {
        if let Some(provider) = root
            .get("model_providers")
            .and_then(toml::Value::as_table)
            .and_then(|providers| providers.get(&provider_id))
        {
            let mut providers = toml::map::Map::new();
            providers.insert(provider_id, provider.clone());
            managed.insert("model_providers".to_string(), toml::Value::Table(providers));
        }
    }

    Ok(canonicalize_toml_value(&toml::Value::Table(managed)))
}

fn fingerprint_json(value: &JsonValue) -> Result<String, AppError> {
    let bytes =
        serde_json::to_vec(value).map_err(|error| AppError::JsonSerialize { source: error })?;
    let digest = Sha256::digest(bytes);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn managed_fingerprint(text: &str, provider_id_hint: Option<&str>) -> Result<String, AppError> {
    fingerprint_json(&ccsm_owned_projection(text, provider_id_hint)?)
}

fn active_model_provider_id_from_text(text: &str) -> Result<Option<String>, AppError> {
    let value = text.parse::<toml::Value>().map_err(|error| {
        AppError::Config(format!("Codex config.toml semantic parse failed: {error}"))
    })?;
    Ok(active_model_provider_id(&value))
}

fn flatten_json(value: &JsonValue, prefix: &str, output: &mut BTreeMap<String, String>) {
    match value {
        JsonValue::Object(object) if object.is_empty() && !prefix.is_empty() => {
            output.insert(prefix.to_string(), "{}".to_string());
        }
        JsonValue::Object(object) => {
            for (key, child) in object {
                let child_prefix = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                flatten_json(child, &child_prefix, output);
            }
        }
        JsonValue::Array(array) if array.is_empty() => {
            output.insert(prefix.to_string(), "[]".to_string());
        }
        JsonValue::Array(array) => {
            for (index, child) in array.iter().enumerate() {
                flatten_json(child, &format!("{prefix}[{index}]"), output);
            }
        }
        other => {
            output.insert(prefix.to_string(), other.to_string());
        }
    }
}

#[cfg(test)]
pub(crate) fn changed_key_paths(before: &str, after: &str) -> Result<Vec<String>, AppError> {
    let before = canonicalize_toml(before)?;
    let after = canonicalize_toml(after)?;
    let mut before_paths = BTreeMap::new();
    let mut after_paths = BTreeMap::new();
    flatten_json(&before, "", &mut before_paths);
    flatten_json(&after, "", &mut after_paths);
    Ok(before_paths
        .keys()
        .chain(after_paths.keys())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter(|key| before_paths.get(*key) != after_paths.get(*key))
        .take(64)
        .cloned()
        .collect())
}

fn changed_managed_key_paths(
    expected: &str,
    actual: &str,
    provider_id_hint: Option<&str>,
) -> Result<Vec<String>, AppError> {
    let expected = ccsm_owned_projection(expected, provider_id_hint)?;
    let actual = ccsm_owned_projection(actual, provider_id_hint)?;
    let mut expected_paths = BTreeMap::new();
    let mut actual_paths = BTreeMap::new();
    flatten_json(&expected, "", &mut expected_paths);
    flatten_json(&actual, "", &mut actual_paths);
    Ok(expected_paths
        .keys()
        .chain(actual_paths.keys())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter(|key| expected_paths.get(*key) != actual_paths.get(*key))
        .take(64)
        .cloned()
        .collect())
}

fn copy_or_remove_top_level_item(
    target: &mut toml_edit::DocumentMut,
    expected: &toml_edit::DocumentMut,
    key: &str,
) {
    match expected.get(key).cloned() {
        Some(item) => {
            target.as_table_mut().insert(key, item);
        }
        None => {
            target.as_table_mut().remove(key);
        }
    }
}

/// Rewrite only the Sub-Agent V2 policy block inside `developer_instructions`.
///
/// This mirrors the ownership rule enforced by
/// `codex_config::project_codex_subagent_v2_parent_instructions`: user text
/// outside the markers is preserved verbatim, and the block is re-encoded as a
/// basic string so Codex Desktop's notify updater cannot mistake a line inside
/// the instructions for the root `notify` setting.
fn merge_managed_subagent_policy(
    target: &mut toml_edit::DocumentMut,
    expected: &toml_edit::DocumentMut,
) -> Result<(), AppError> {
    let expected_policy = expected
        .get("developer_instructions")
        .and_then(toml_edit::Item::as_str)
        .and_then(codex_config::codex_subagent_v2_policy_block);
    let live_value = target
        .get("developer_instructions")
        .and_then(toml_edit::Item::as_str)
        .unwrap_or("");
    let user_instructions = codex_config::strip_codex_subagent_v2_policy_block(live_value);
    let projected = match expected_policy {
        Some(policy) if user_instructions.is_empty() => policy,
        Some(policy) => format!("{user_instructions}\n\n{policy}"),
        None => user_instructions,
    };
    if projected.is_empty() {
        target.as_table_mut().remove("developer_instructions");
        return Ok(());
    }
    let basic_repr = serde_json::to_string(&projected)
        .map_err(|error| AppError::JsonSerialize { source: error })?;
    let projected_value = basic_repr.parse::<toml_edit::Value>().map_err(|error| {
        AppError::Config(format!(
            "Failed to encode Codex developer instructions: {error}"
        ))
    })?;
    target.as_table_mut().remove("developer_instructions");
    target["developer_instructions"] = toml_edit::Item::Value(projected_value);
    Ok(())
}

/// Merge the CCSwitchMulti-owned projection into the latest live document.
///
/// Replacing the whole file (the previous behaviour) deleted Codex-owned
/// `desktop`, `projects`, `plugins`, `mcp_servers` and runtime sections, which
/// Codex immediately rewrote — re-arming the same drift on the next poll.
fn merge_ccsm_owned_projection(current: &str, expected: &str) -> Result<String, AppError> {
    let mut target = current
        .parse::<toml_edit::DocumentMut>()
        .map_err(|error| AppError::Config(format!("Invalid live Codex config.toml: {error}")))?;
    let expected = expected
        .parse::<toml_edit::DocumentMut>()
        .map_err(|error| {
            AppError::Config(format!("Invalid expected Codex config.toml: {error}"))
        })?;

    for key in CCSM_MANAGED_TOP_LEVEL_KEYS {
        copy_or_remove_top_level_item(&mut target, &expected, key);
    }

    merge_managed_subagent_policy(&mut target, &expected)?;

    match expected
        .get(crate::codex_config::CODEX_WEB_SEARCH_FIELD)
        .and_then(toml_edit::Item::as_str)
    {
        Some(crate::codex_config::CODEX_WEB_SEARCH_DISABLED) => copy_or_remove_top_level_item(
            &mut target,
            &expected,
            crate::codex_config::CODEX_WEB_SEARCH_FIELD,
        ),
        _ => {
            if target
                .get(crate::codex_config::CODEX_WEB_SEARCH_FIELD)
                .and_then(toml_edit::Item::as_str)
                == Some(crate::codex_config::CODEX_WEB_SEARCH_DISABLED)
            {
                target
                    .as_table_mut()
                    .remove(crate::codex_config::CODEX_WEB_SEARCH_FIELD);
            }
        }
    }

    let expected_provider_id = expected
        .get("model_provider")
        .and_then(toml_edit::Item::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    if expected_provider_id.as_deref()
        == Some(crate::codex_config::CC_SWITCH_CODEX_ROUTER_MODEL_PROVIDER_ID)
    {
        for key in ["model_context_window", "model_auto_compact_token_limit"] {
            copy_or_remove_top_level_item(&mut target, &expected, key);
        }
    }

    if let Some(provider_id) = expected_provider_id {
        let expected_provider = expected
            .get("model_providers")
            .and_then(toml_edit::Item::as_table_like)
            .and_then(|providers| providers.get(&provider_id))
            .cloned();

        if target.get("model_providers").is_none() {
            target["model_providers"] = toml_edit::table();
        }
        let providers = target
            .get_mut("model_providers")
            .and_then(toml_edit::Item::as_table_like_mut)
            .ok_or_else(|| AppError::Config("Codex model_providers must be a table".to_string()))?;
        match expected_provider {
            Some(provider) => {
                providers.insert(&provider_id, provider);
            }
            None => {
                providers.remove(&provider_id);
            }
        }
        if providers.is_empty() {
            target.as_table_mut().remove("model_providers");
        }
    }

    Ok(target.to_string())
}

fn report(
    state: CodexConfigConsistencyState,
    provider_id: Option<String>,
    expected_fingerprint: Option<String>,
    actual_fingerprint: Option<String>,
    changed_keys: Vec<String>,
    reason: Option<&str>,
) -> CodexConfigConsistencyReport {
    CodexConfigConsistencyReport {
        state,
        provider_id,
        expected_fingerprint,
        actual_fingerprint,
        changed_keys,
        reason: reason.map(str::to_string),
    }
}

pub fn inspect(state: &AppState) -> Result<CodexConfigConsistencyReport, AppError> {
    let provider_id = crate::settings::get_effective_current_provider(&state.db, &AppType::Codex)?;
    let Some(provider_id) = provider_id else {
        return Ok(report(
            CodexConfigConsistencyState::NotApplicable,
            None,
            None,
            None,
            Vec::new(),
            Some("no_current_provider"),
        ));
    };

    if state
        .proxy_service
        .detect_takeover_in_live_config_for_app(&AppType::Codex)
    {
        return Ok(report(
            CodexConfigConsistencyState::NotApplicable,
            Some(provider_id),
            None,
            None,
            Vec::new(),
            Some("proxy_takeover_active"),
        ));
    }

    let provider = state
        .db
        .get_provider_by_id(&provider_id, AppType::Codex.as_str())?
        .ok_or_else(|| AppError::Config("Codex current provider is missing".to_string()))?;
    let expected_text = match build_codex_live_config_for_provider(&state.db, &provider) {
        Ok(text) => text,
        Err(error) => {
            log::warn!("Codex config consistency expected config build failed: {error}");
            return Ok(report(
                CodexConfigConsistencyState::Unavailable,
                Some(provider_id),
                None,
                None,
                Vec::new(),
                Some("expected_config_unavailable"),
            ));
        }
    };

    let expected_provider_id = active_model_provider_id_from_text(&expected_text)?;
    let expected_fingerprint =
        managed_fingerprint(&expected_text, expected_provider_id.as_deref())?;

    let live_path = codex_config::get_codex_config_path();
    let actual_text = match fs::read_to_string(&live_path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(report(
                CodexConfigConsistencyState::Unavailable,
                Some(provider_id),
                Some(expected_fingerprint),
                None,
                Vec::new(),
                Some("live_config_missing"),
            ));
        }
        Err(error) => return Err(AppError::io(&live_path, error)),
    };

    let actual_fingerprint =
        match managed_fingerprint(&actual_text, expected_provider_id.as_deref()) {
            Ok(fingerprint) => fingerprint,
            Err(error) => {
                log::warn!("Codex config consistency live TOML parse failed: {error}");
                return Ok(report(
                    CodexConfigConsistencyState::Unavailable,
                    Some(provider_id),
                    Some(expected_fingerprint),
                    None,
                    Vec::new(),
                    Some("invalid_toml"),
                ));
            }
        };

    if expected_fingerprint == actual_fingerprint {
        return Ok(report(
            CodexConfigConsistencyState::Consistent,
            Some(provider_id),
            Some(expected_fingerprint),
            Some(actual_fingerprint),
            Vec::new(),
            None,
        ));
    }

    Ok(report(
        CodexConfigConsistencyState::ExternalDrift,
        Some(provider_id),
        Some(expected_fingerprint),
        Some(actual_fingerprint),
        changed_managed_key_paths(
            &expected_text,
            &actual_text,
            expected_provider_id.as_deref(),
        )?,
        Some("live_config_changed"),
    ))
}

pub fn resolve(
    state: &AppState,
    expected_fingerprint: String,
    action: CodexConfigConsistencyAction,
) -> Result<CodexConfigConsistencyReport, AppError> {
    let current = inspect(state)?;
    if action == CodexConfigConsistencyAction::Later {
        return Ok(current);
    }

    let Some(actual_fingerprint) = current.actual_fingerprint.clone() else {
        return Ok(current);
    };

    match action {
        CodexConfigConsistencyAction::KeepCodex => {
            state.db.set_setting(LAST_ACTION_KEY, "keep_codex")?;
            state
                .db
                .set_setting(LAST_ACTUAL_FINGERPRINT_KEY, &actual_fingerprint)?;
            state.db.set_setting(
                LAST_PROVIDER_ID_KEY,
                current.provider_id.as_deref().unwrap_or_default(),
            )?;
            Ok(current)
        }
        CodexConfigConsistencyAction::ApplyCcsm => {
            if expected_fingerprint != actual_fingerprint {
                return Err(AppError::InvalidInput(
                    "codex_config_consistency_stale_fingerprint".to_string(),
                ));
            }
            let provider_id = current
                .provider_id
                .clone()
                .ok_or_else(|| AppError::Config("Codex current provider is missing".to_string()))?;
            let provider = state
                .db
                .get_provider_by_id(&provider_id, AppType::Codex.as_str())?
                .ok_or_else(|| AppError::Config("Codex current provider is missing".to_string()))?;
            let live_path = codex_config::get_codex_config_path();
            let backup_path = live_path.with_file_name(format!(
                "config.toml.ccsm-drift-{}.bak",
                chrono::Utc::now().format("%Y%m%dT%H%M%S%.fZ")
            ));
            let mut backup_created = false;
            codex_config::reconcile_codex_live_config_atomic(|before| {
                let candidate = build_codex_live_config_for_provider(&state.db, &provider)?;
                let provider_id_hint = active_model_provider_id_from_text(&candidate)?;
                let observed = managed_fingerprint(before, provider_id_hint.as_deref())?;
                if observed != expected_fingerprint {
                    return Err(AppError::InvalidInput(
                        "codex_config_consistency_stale_fingerprint".to_string(),
                    ));
                }
                if !backup_created {
                    fs::write(&backup_path, before.as_bytes())
                        .map_err(|error| AppError::io(&backup_path, error))?;
                    backup_created = true;
                }
                merge_ccsm_owned_projection(before, &candidate)
            })?;
            inspect(state)
        }
        CodexConfigConsistencyAction::Later => Ok(current),
    }
}

#[tauri::command]
pub fn inspect_codex_config_consistency(
    state: State<'_, AppState>,
) -> Result<CodexConfigConsistencyReport, String> {
    inspect(&state).map_err(String::from)
}

#[tauri::command]
pub fn resolve_codex_config_consistency(
    state: State<'_, AppState>,
    expected_fingerprint: String,
    action: CodexConfigConsistencyAction,
) -> Result<CodexConfigConsistencyReport, String> {
    resolve(&state, expected_fingerprint, action).map_err(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;
    use crate::provider::Provider;
    use serde_json::json;
    use serial_test::serial;

    struct TestHomeGuard {
        _dir: tempfile::TempDir,
        original: Option<String>,
    }

    impl TestHomeGuard {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("create temp home");
            let original = std::env::var("CC_SWITCH_TEST_HOME").ok();
            std::env::set_var("CC_SWITCH_TEST_HOME", dir.path());
            Self {
                _dir: dir,
                original,
            }
        }
    }

    impl Drop for TestHomeGuard {
        fn drop(&mut self) {
            match &self.original {
                Some(value) => std::env::set_var("CC_SWITCH_TEST_HOME", value),
                None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
            }
        }
    }

    fn seed_provider() -> (crate::store::AppState, String) {
        let db = std::sync::Arc::new(Database::memory().expect("memory db"));
        let provider = Provider::with_id(
            "consistency-provider".to_string(),
            "Consistency Provider".to_string(),
            json!({
                "auth": {},
                "config": "model = \"gpt-5.5\"\nmodel_reasoning_effort = \"medium\"\n",
                "modelCatalog": {"models": [{"model": "gpt-5.5"}]}
            }),
            None,
        );
        db.save_provider(AppType::Codex.as_str(), &provider)
            .expect("save provider");
        db.set_current_provider(AppType::Codex.as_str(), &provider.id)
            .expect("set current provider");
        crate::settings::set_current_provider(&AppType::Codex, Some(&provider.id))
            .expect("set local current provider");
        (crate::store::AppState::new(db), provider.id)
    }

    #[test]
    fn semantic_fingerprint_ignores_comments_whitespace_and_key_order() {
        let first = "# user note\nmodel = \"gpt-5.5\"\nmodel_reasoning_effort = \"medium\"\n";
        let second = "model_reasoning_effort = \"medium\"\nmodel = \"gpt-5.5\" # inline note\n";

        assert_eq!(
            fingerprint_toml(first).expect("first fingerprint"),
            fingerprint_toml(second).expect("second fingerprint")
        );
        assert!(changed_key_paths(first, second)
            .expect("semantic diff")
            .is_empty());
    }

    #[test]
    fn semantic_diff_reports_changed_paths_without_values() {
        let before = "model = \"gpt-5.5\"\n[features]\nweb_search = true\n";
        let after = "model = \"gpt-5.5\"\n[features]\nweb_search = false\n";

        let changed = changed_key_paths(before, after).expect("semantic diff");

        assert_eq!(changed, vec!["features.web_search"]);
        let serialized = serde_json::to_string(&changed).expect("serialize paths");
        assert!(!serialized.contains("true"));
        assert!(!serialized.contains("false"));
    }

    #[test]
    #[serial]
    fn inspect_reports_external_drift_with_changed_paths_only() {
        let _home = TestHomeGuard::new();
        crate::settings::reload_settings().expect("reload settings");
        let (state, _) = seed_provider();
        let provider = state
            .db
            .get_provider_by_id("consistency-provider", AppType::Codex.as_str())
            .expect("read provider")
            .expect("provider exists");
        let expected = build_codex_live_config_for_provider(&state.db, &provider)
            .expect("build expected live config");
        let mut live = expected
            .parse::<toml_edit::DocumentMut>()
            .expect("parse expected config");
        live["model_reasoning_effort"] = toml_edit::value("high");
        codex_config::write_codex_live_config_atomic(Some(&live.to_string()))
            .expect("write drifted live config");

        let result = inspect(&state).expect("inspect config consistency");

        assert_eq!(result.state, CodexConfigConsistencyState::ExternalDrift);
        assert_eq!(result.provider_id.as_deref(), Some("consistency-provider"));
        assert!(result
            .changed_keys
            .contains(&"model_reasoning_effort".to_string()));
        assert!(result.changed_keys.iter().all(|key| !key.contains("high")));
    }

    /// Regression for the reported Codex 0.157 upgrade regression: every key
    /// Codex CLI / Codex Desktop writes on its own launch used to be reported
    /// as "Codex configuration differs from CCSM", and the 30s poll re-armed
    /// the dialog after every Apply.
    #[test]
    #[serial]
    fn inspect_ignores_codex_owned_runtime_and_user_changes() {
        let _home = TestHomeGuard::new();
        crate::settings::reload_settings().expect("reload settings");
        let (state, _) = seed_provider();
        let provider = state
            .db
            .get_provider_by_id("consistency-provider", AppType::Codex.as_str())
            .expect("read provider")
            .expect("provider exists");
        let expected = build_codex_live_config_for_provider(&state.db, &provider)
            .expect("build expected live config");
        let mut live = expected
            .parse::<toml_edit::DocumentMut>()
            .expect("parse expected config");
        live["approval_policy"] = toml_edit::value("on-request");
        live["notify"] = toml_edit::value(
            r"C:\Users\felix\AppData\Local\OpenAI\Codex\runtimes\cua_node\bin\codex-computer-use.exe",
        );
        live["agents"]["max_concurrent_threads_per_session"] = toml_edit::value(10);
        live["agents"]["max_depth"] = toml_edit::value(1);
        live["desktop"]["ambient-suggestions-enabled"] = toml_edit::value(true);
        live["desktop"]["conversationDetailMode"] = toml_edit::value("expanded");
        live["desktop"]["followUpQueueMode"] = toml_edit::value("queue");
        live["desktop"]["integratedTerminalShell"] = toml_edit::value(false);
        live["desktop"]["runCodexInWindowsSubsystemForLinux"] = toml_edit::value(false);
        live["features"]["guardianv2"] = toml_edit::value(false);
        live["features"]["multi_agent_v2"]["enabled"] = toml_edit::value(true);
        live["marketplaces"]["openai-bundled"]["source_type"] = toml_edit::value("local");
        live["mcp_servers"]["node_repl"]["command"] = toml_edit::value(
            r"C:\Users\felix\AppData\Local\OpenAI\Codex\runtimes\cua_node\bin\node_repl.exe",
        );
        live["mcp_servers"]["node_repl"]["env"]["BROWSER_USE_CODEX_APP_VERSION"] =
            toml_edit::value("26.924.20706");
        live["plugins"]["browser@openai-bundled"]["enabled"] = toml_edit::value(true);
        live["projects"][r"h:\repos\ccswitchmulti-fork"]["trust_level"] =
            toml_edit::value("trusted");
        live["windows"]["sandbox"] = toml_edit::value("elevated");
        codex_config::write_codex_live_config_atomic(Some(&live.to_string()))
            .expect("write Codex-owned changes");

        let result = inspect(&state).expect("inspect config consistency");

        assert_eq!(
            result.state,
            CodexConfigConsistencyState::Consistent,
            "Codex-owned keys leaked into drift: {:?}",
            result.changed_keys
        );
        assert!(result.changed_keys.is_empty());
    }

    /// Real routing drift must still be reported, and the reported key list
    /// must not be padded with Codex-owned noise.
    #[test]
    #[serial]
    fn inspect_reports_only_ccsm_owned_route_drift() {
        let _home = TestHomeGuard::new();
        crate::settings::reload_settings().expect("reload settings");
        let (state, _) = seed_provider();
        let provider = state
            .db
            .get_provider_by_id("consistency-provider", AppType::Codex.as_str())
            .expect("read provider")
            .expect("provider exists");
        let expected = build_codex_live_config_for_provider(&state.db, &provider)
            .expect("build expected live config");
        let mut live = expected
            .parse::<toml_edit::DocumentMut>()
            .expect("parse expected config");
        live["model"] = toml_edit::value("gpt-5.6-sol");
        live["approval_policy"] = toml_edit::value("never");
        live["desktop"]["integratedTerminalShell"] = toml_edit::value(false);
        codex_config::write_codex_live_config_atomic(Some(&live.to_string()))
            .expect("write drifted live config");

        let result = inspect(&state).expect("inspect config consistency");

        assert_eq!(result.state, CodexConfigConsistencyState::ExternalDrift);
        assert_eq!(result.changed_keys, vec!["model".to_string()]);
    }

    /// `developer_instructions` is shared: the user's own text is not
    /// CCSwitchMulti drift, but damage to the managed Sub-Agent V2 policy
    /// block is.
    #[test]
    fn subagent_policy_ownership_ignores_user_text_and_tracks_the_managed_block() {
        let expected = concat!(
            "developer_instructions = \"[CCSWITCHMULTI_SUBAGENT_V2_POLICY_BEGIN]\\n",
            "policy v2\\n",
            "[CCSWITCHMULTI_SUBAGENT_V2_POLICY_END]\"\n",
        );
        let with_user_text = concat!(
            "developer_instructions = \"Keep my own house rule.\\n\\n",
            "[CCSWITCHMULTI_SUBAGENT_V2_POLICY_BEGIN]\\n",
            "policy v2\\n",
            "[CCSWITCHMULTI_SUBAGENT_V2_POLICY_END]\"\n",
        );
        let damaged = concat!(
            "developer_instructions = \"[CCSWITCHMULTI_SUBAGENT_V2_POLICY_BEGIN]\\n",
            "policy v1\\n",
            "[CCSWITCHMULTI_SUBAGENT_V2_POLICY_END]\"\n",
        );

        assert!(changed_managed_key_paths(expected, with_user_text, None)
            .expect("user text diff")
            .is_empty());
        assert_eq!(
            changed_managed_key_paths(expected, damaged, None).expect("policy diff"),
            vec!["developer_instructions".to_string()]
        );
    }

    #[test]
    fn apply_merge_replaces_the_policy_block_and_preserves_user_instructions() {
        let live = concat!(
            "developer_instructions = \"Keep my own house rule.\\n\\n",
            "[CCSWITCHMULTI_SUBAGENT_V2_POLICY_BEGIN]\\n",
            "stale policy\\n",
            "[CCSWITCHMULTI_SUBAGENT_V2_POLICY_END]\"\n",
        );
        let expected = concat!(
            "developer_instructions = \"[CCSWITCHMULTI_SUBAGENT_V2_POLICY_BEGIN]\\n",
            "fresh policy\\n",
            "[CCSWITCHMULTI_SUBAGENT_V2_POLICY_END]\"\n",
        );

        let merged = merge_ccsm_owned_projection(live, expected).expect("merge owned projection");
        let parsed: toml::Value = toml::from_str(&merged).expect("parse merged config");
        let instructions = parsed
            .get("developer_instructions")
            .and_then(toml::Value::as_str)
            .expect("merged developer_instructions");

        assert!(instructions.contains("Keep my own house rule."));
        assert!(instructions.contains("fresh policy"));
        assert!(!instructions.contains("stale policy"));
    }

    /// Apply must repair owned drift without deleting the Codex-owned state
    /// that the previous whole-file replacement used to wipe.
    #[test]
    #[serial]
    fn apply_ccsm_preserves_codex_owned_sections() {
        let (_home, state, _) = seed_drifted_state();
        let live_path = codex_config::get_codex_config_path();
        let mut live = fs::read_to_string(&live_path)
            .expect("read drifted live config")
            .parse::<toml_edit::DocumentMut>()
            .expect("parse drifted live config");
        live["approval_policy"] = toml_edit::value("on-request");
        live["desktop"]["integratedTerminalShell"] = toml_edit::value(false);
        live["mcp_servers"]["node_repl"]["env"]["BROWSER_USE_CODEX_APP_VERSION"] =
            toml_edit::value("26.924.20706");
        live["plugins"]["browser@openai-bundled"]["enabled"] = toml_edit::value(true);
        live["projects"][r"h:\repos\ccswitchmulti-fork"]["trust_level"] =
            toml_edit::value("trusted");
        live["windows"]["sandbox"] = toml_edit::value("elevated");
        codex_config::write_codex_live_config_atomic(Some(&live.to_string()))
            .expect("write unmanaged live fields");
        let before = inspect(&state).expect("inspect drift");
        let actual = before
            .actual_fingerprint
            .clone()
            .expect("actual fingerprint");

        let after = resolve(&state, actual, CodexConfigConsistencyAction::ApplyCcsm)
            .expect("apply CCSM config");

        assert_eq!(after.state, CodexConfigConsistencyState::Consistent);
        let applied = fs::read_to_string(&live_path)
            .expect("read applied live config")
            .parse::<toml::Value>()
            .expect("parse applied live config");
        assert_eq!(
            applied.get("approval_policy").and_then(toml::Value::as_str),
            Some("on-request")
        );
        assert_eq!(
            applied
                .get("desktop")
                .and_then(|desktop| desktop.get("integratedTerminalShell"))
                .and_then(toml::Value::as_bool),
            Some(false)
        );
        assert_eq!(
            applied
                .get("mcp_servers")
                .and_then(|servers| servers.get("node_repl"))
                .and_then(|server| server.get("env"))
                .and_then(|env| env.get("BROWSER_USE_CODEX_APP_VERSION"))
                .and_then(toml::Value::as_str),
            Some("26.924.20706")
        );
        assert_eq!(
            applied
                .get("plugins")
                .and_then(|plugins| plugins.get("browser@openai-bundled"))
                .and_then(|plugin| plugin.get("enabled"))
                .and_then(toml::Value::as_bool),
            Some(true)
        );
        assert_eq!(
            applied
                .get("projects")
                .and_then(|projects| projects.get(r"h:\repos\ccswitchmulti-fork"))
                .and_then(|project| project.get("trust_level"))
                .and_then(toml::Value::as_str),
            Some("trusted")
        );
        assert_eq!(
            applied
                .get("windows")
                .and_then(|windows| windows.get("sandbox"))
                .and_then(toml::Value::as_str),
            Some("elevated")
        );
        assert_eq!(
            applied
                .get("model_reasoning_effort")
                .and_then(toml::Value::as_str),
            Some("medium"),
            "owned drift must still be repaired"
        );
    }

    #[test]
    #[serial]
    fn inspect_marks_invalid_live_toml_unavailable() {
        let _home = TestHomeGuard::new();
        crate::settings::reload_settings().expect("reload settings");
        let (state, _) = seed_provider();
        codex_config::write_codex_live_config_atomic(Some("model = [\n"))
            .expect_err("invalid TOML must not be written by the atomic writer");
        let path = codex_config::get_codex_config_path();
        std::fs::create_dir_all(path.parent().expect("config parent")).expect("create parent");
        std::fs::write(&path, "model = [\n").expect("seed invalid external TOML");

        let result = inspect(&state).expect("inspect invalid config");

        assert_eq!(result.state, CodexConfigConsistencyState::Unavailable);
        assert_eq!(result.reason.as_deref(), Some("invalid_toml"));
        assert!(result.actual_fingerprint.is_none());
    }

    fn seed_drifted_state() -> (TestHomeGuard, crate::store::AppState, String) {
        let home = TestHomeGuard::new();
        crate::settings::reload_settings().expect("reload settings");
        let (state, provider_id) = seed_provider();
        let provider = state
            .db
            .get_provider_by_id(&provider_id, AppType::Codex.as_str())
            .expect("read provider")
            .expect("provider exists");
        let expected = build_codex_live_config_for_provider(&state.db, &provider)
            .expect("build expected live config");
        let mut live = expected
            .parse::<toml_edit::DocumentMut>()
            .expect("parse expected config");
        live["model_reasoning_effort"] = toml_edit::value("high");
        codex_config::write_codex_live_config_atomic(Some(&live.to_string()))
            .expect("write drifted live config");
        (home, state, provider_id)
    }

    #[test]
    #[serial]
    fn keep_codex_records_only_fingerprint_acknowledgement() {
        let (_home, state, provider_id) = seed_drifted_state();
        let before = inspect(&state).expect("inspect drift");
        let actual = before
            .actual_fingerprint
            .clone()
            .expect("actual fingerprint");

        let after = resolve(
            &state,
            actual.clone(),
            CodexConfigConsistencyAction::KeepCodex,
        )
        .expect("keep Codex changes");

        assert_eq!(after.state, CodexConfigConsistencyState::ExternalDrift);
        assert_eq!(
            state.db.get_setting(LAST_ACTION_KEY).unwrap().as_deref(),
            Some("keep_codex")
        );
        assert_eq!(
            state
                .db
                .get_setting(LAST_ACTUAL_FINGERPRINT_KEY)
                .unwrap()
                .as_deref(),
            Some(actual.as_str())
        );
        assert_eq!(
            state
                .db
                .get_setting(LAST_PROVIDER_ID_KEY)
                .unwrap()
                .as_deref(),
            Some(provider_id.as_str())
        );
    }

    #[test]
    #[serial]
    fn later_does_not_persist_an_acknowledgement() {
        let (_home, state, _) = seed_drifted_state();
        let before = inspect(&state).expect("inspect drift");
        let actual = before
            .actual_fingerprint
            .clone()
            .expect("actual fingerprint");

        resolve(&state, actual, CodexConfigConsistencyAction::Later).expect("defer Codex changes");

        assert!(state.db.get_setting(LAST_ACTION_KEY).unwrap().is_none());
        assert!(state
            .db
            .get_setting(LAST_ACTUAL_FINGERPRINT_KEY)
            .unwrap()
            .is_none());
        assert!(state
            .db
            .get_setting(LAST_PROVIDER_ID_KEY)
            .unwrap()
            .is_none());
    }

    #[test]
    #[serial]
    fn apply_ccsm_uses_compare_and_swap_and_creates_a_drift_backup() {
        let (_home, state, _) = seed_drifted_state();
        let before = inspect(&state).expect("inspect drift");
        let actual = before
            .actual_fingerprint
            .clone()
            .expect("actual fingerprint");

        let after = resolve(&state, actual, CodexConfigConsistencyAction::ApplyCcsm)
            .expect("apply CCSM config");

        assert_eq!(after.state, CodexConfigConsistencyState::Consistent);
        let backups = std::fs::read_dir(codex_config::get_codex_config_dir())
            .expect("read Codex config directory")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("config.toml.ccsm-drift-")
            })
            .count();
        assert_eq!(backups, 1, "apply must create one recoverable drift backup");
    }

    #[test]
    #[serial]
    fn apply_ccsm_rejects_a_stale_live_fingerprint_before_writing() {
        let (_home, state, _) = seed_drifted_state();
        let error = resolve(
            &state,
            "stale-fingerprint".to_string(),
            CodexConfigConsistencyAction::ApplyCcsm,
        )
        .expect_err("stale fingerprint must not overwrite Codex changes");

        assert!(error
            .to_string()
            .contains("codex_config_consistency_stale_fingerprint"));
    }
}
