//! Opt-in routing policy. Models are provider-scoped; no credentials live here.

use crate::app_config::AppType;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub const PROFILE_PREFIX: &str = "ccsm-orch/";
pub const ROLE_PREFIX: &str = "ccsm-role/";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModelApp {
    Claude,
    Codex,
}

impl ModelApp {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    pub fn app_type(self) -> AppType {
        match self {
            Self::Claude => AppType::Claude,
            Self::Codex => AppType::Codex,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelRef {
    pub app_type: ModelApp,
    pub provider_id: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Budget {
    pub max_rounds: u32,
    pub max_worker_calls: u32,
    pub max_parallel_workers: u32,
    pub timeout_seconds: u64,
    pub max_output_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub display_name: String,
    pub enabled: bool,
    pub scope: String,
    pub orchestrator: ModelRef,
    pub worker: ModelRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verifier: Option<ModelRef>,
    pub budget: Budget,
    pub approval_policy: String,
    pub failure_fallback: String,
    #[serde(default)]
    pub worker_guidance: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picker_model: Option<String>,
}

impl Profile {
    pub fn picker_model(&self) -> String {
        format!("{PROFILE_PREFIX}{}", self.id)
    }

    pub fn supports(&self, app: &str) -> bool {
        self.scope == "all" || self.scope == app
    }

    pub fn roles(&self) -> Vec<(&'static str, &ModelRef)> {
        let mut roles = vec![
            ("orchestrator", &self.orchestrator),
            ("worker", &self.worker),
        ];
        if let Some(verifier) = &self.verifier {
            roles.push(("verifier", verifier));
        }
        roles
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_profile_id: Option<String>,
    pub profiles: Vec<Profile>,
    #[serde(default)]
    pub default_mode_by_app: HashMap<String, String>,
}

#[derive(Debug, Clone)]
pub enum Route {
    Profile(Profile),
    Role(Profile, ModelRef),
}

impl Route {
    pub fn profile(&self) -> &Profile {
        match self {
            Self::Profile(profile) | Self::Role(profile, _) => profile,
        }
    }
}

impl Settings {
    pub fn validate_providers(
        &self,
        db: &crate::database::Database,
    ) -> Result<(), crate::error::AppError> {
        if !self.enabled {
            return Ok(());
        }
        for profile in self.profiles.iter().filter(|profile| profile.enabled) {
            for (_, role) in profile.roles() {
                let provider = db
                    .get_provider_by_id(&role.provider_id, role.app_type.as_str())?
                    .ok_or_else(|| {
                        crate::error::AppError::InvalidInput(
                            "Orchestration provider is unavailable".into(),
                        )
                    })?;
                validate_role_provider(role, &provider)
                    .map_err(crate::error::AppError::InvalidInput)?;
            }
        }
        Ok(())
    }

    pub fn routable_settings(
        &self,
        db: &crate::database::Database,
    ) -> Result<Self, crate::error::AppError> {
        let mut result = self.clone();
        let mut profiles = Vec::new();
        for profile in &self.profiles {
            let mut available = true;
            for (_, role) in profile.roles() {
                let provider = db.get_provider_by_id(&role.provider_id, role.app_type.as_str())?;
                available &= provider
                    .as_ref()
                    .is_some_and(|provider| validate_role_provider(role, provider).is_ok());
            }
            if available {
                profiles.push(profile.clone());
            }
        }
        result.profiles = profiles;
        Ok(result)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.profiles.len() > 50 {
            return Err("At most 50 orchestration profiles are allowed".into());
        }
        let mut ids = HashSet::new();
        for p in &self.profiles {
            if p.id.is_empty()
                || p.id.len() > 64
                || !p
                    .id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
                || !ids.insert(&p.id)
            {
                return Err("Profile IDs must be unique ASCII names (1-64 characters)".into());
            }
            if p.display_name.trim().is_empty() || p.display_name.len() > 160 {
                return Err("A profile name is required (at most 160 bytes)".into());
            }
            if !matches!(p.scope.as_str(), "claude" | "codex" | "all")
                || p.approval_policy != "client"
                || !matches!(p.failure_fallback.as_str(), "direct" | "fail_closed")
            {
                return Err("Invalid scope, client approval policy, or fallback".into());
            }
            let b = &p.budget;
            if !(1..=8).contains(&b.max_rounds)
                || !(1..=8).contains(&b.max_worker_calls)
                || b.max_parallel_workers != 1
                || !(10..=1800).contains(&b.timeout_seconds)
                || !(256..=32768).contains(&b.max_output_tokens)
                || b.budget_usd.is_some()
            {
                return Err("Invalid limits: 1-8 rounds/calls, one worker, 10-1800 seconds, 256-32768 output tokens. Monetary budgets are not supported.".into());
            }
            if p.worker_guidance.len() > 8000 {
                return Err("Worker guidance exceeds 8000 bytes".into());
            }
            if p.picker_model
                .as_ref()
                .is_some_and(|m| m != &p.picker_model())
            {
                return Err("Picker model must match the profile ID".into());
            }
            for (_, model) in p.roles() {
                if model.provider_id.trim().is_empty()
                    || model.provider_id.len() > 256
                    || model.model.trim().is_empty()
                    || model.model.len() > 256
                    || model.model.starts_with("ccsm-")
                    || model.model.chars().any(char::is_control)
                {
                    return Err("Each role needs a provider and a non-recursive model ID".into());
                }
            }
        }
        for (app, mode) in &self.default_mode_by_app {
            if !matches!(app.as_str(), "claude" | "codex")
                || !matches!(mode.as_str(), "direct" | "orchestrated")
            {
                return Err("Invalid default routing mode".into());
            }
            if mode == "orchestrated"
                && !self.profiles.iter().any(|p| {
                    Some(&p.id) == self.active_profile_id.as_ref() && p.enabled && p.supports(app)
                })
            {
                return Err(format!(
                    "Default {app} orchestration needs an enabled active profile"
                ));
            }
        }
        if self
            .active_profile_id
            .as_ref()
            .is_some_and(|id| !ids.contains(id))
        {
            return Err("Active profile does not exist".into());
        }
        Ok(())
    }

    pub fn resolve(&self, app: &str, model: &str) -> Result<Option<Route>, String> {
        let explicit = model.starts_with(PROFILE_PREFIX) || model.starts_with(ROLE_PREFIX);
        if !self.enabled {
            return if explicit {
                Err("Orchestration is disabled".into())
            } else {
                Ok(None)
            };
        }
        if let Some(id) = model.strip_prefix(PROFILE_PREFIX) {
            let p = self.enabled_profile(app, id)?;
            return Ok(Some(Route::Profile(p.clone())));
        }
        if let Some(role) = model.strip_prefix(ROLE_PREFIX) {
            let (id, role) = role.split_once('/').ok_or("Invalid role model")?;
            let p = self.enabled_profile(app, id)?;
            let model = p
                .roles()
                .into_iter()
                .find(|(name, _)| *name == role)
                .map(|(_, model)| model.clone())
                .ok_or("Unknown profile role")?;
            return Ok(Some(Route::Role(p.clone(), model)));
        }
        if self.default_mode_by_app.get(app).map(String::as_str) == Some("orchestrated") {
            let id = self
                .active_profile_id
                .as_deref()
                .ok_or("No active profile")?;
            return Ok(Some(Route::Profile(self.enabled_profile(app, id)?.clone())));
        }
        Ok(None)
    }

    fn enabled_profile(&self, app: &str, id: &str) -> Result<&Profile, String> {
        self.profiles
            .iter()
            .find(|p| p.id == id && p.enabled && p.supports(app))
            .ok_or_else(|| "Profile is missing, disabled, or outside this client scope".into())
    }

    /// Add routable aliases, never credentials or policy, to an inventory snapshot.
    pub fn project_catalog(&self, catalog: &mut Value) {
        let Some(models) = catalog.get_mut("models").and_then(Value::as_array_mut) else {
            return;
        };
        models.retain(|m| {
            let id = m
                .get("model")
                .or_else(|| m.get("slug"))
                .and_then(Value::as_str)
                .unwrap_or("");
            !id.starts_with(PROFILE_PREFIX) && !id.starts_with(ROLE_PREFIX)
        });
        if !self.enabled {
            return;
        }
        for p in self
            .profiles
            .iter()
            .filter(|p| p.enabled && p.supports("codex"))
        {
            models.push(picker_entry(
                &p.picker_model(),
                &p.display_name,
                "profile",
                &p.id,
            ));
            for (role, model) in p.roles() {
                if model.app_type != ModelApp::Codex {
                    continue;
                }
                models.push(picker_entry(
                    &format!("{ROLE_PREFIX}{}/{role}", p.id),
                    &format!("{}: {} ({})", p.display_name, role, model.model),
                    role,
                    &p.id,
                ));
            }
        }
    }

    pub fn project_settings(&self, settings: &mut Value) {
        if !settings.get("modelCatalog").is_some_and(Value::is_object) {
            settings["modelCatalog"] = json!({"models": []});
        }
        if !settings["modelCatalog"]
            .get("models")
            .is_some_and(Value::is_array)
        {
            settings["modelCatalog"]["models"] = json!([]);
        }
        self.project_catalog(&mut settings["modelCatalog"]);
    }
}

pub(crate) fn validate_role_provider(
    role: &ModelRef,
    provider: &crate::provider::Provider,
) -> Result<(), String> {
    let settings = &provider.settings_config;
    if settings.get("codexRouting").is_some()
        || settings.get("codexProtocolSet").is_some()
        || role.model.starts_with("ccsm-")
    {
        return Err(
            "Orchestration roles must use a direct provider and a non-recursive model".into(),
        );
    }
    if let Some(models) = crate::codex_multirouter::catalog::catalog_models(settings) {
        let included = models.iter().any(|entry| {
            let model = entry.as_str().or_else(|| {
                ["model", "slug", "id", "name"]
                    .iter()
                    .find_map(|key| entry.get(key).and_then(Value::as_str))
            });
            model == Some(role.model.as_str())
                && entry.get("enabled").and_then(Value::as_bool) != Some(false)
        });
        if !included {
            return Err(
                "Orchestration model is unavailable or excluded from its provider catalog".into(),
            );
        }
    }
    Ok(())
}

fn picker_entry(model: &str, name: &str, role: &str, id: &str) -> Value {
    json!({
        "model": model, "slug": model, "displayName": name, "display_name": name,
        "enabled": true, "includeInPicker": true, "visibility": "list",
        "role": role, "orchestrationProfileId": id,
        "contextWindow": 128000, "maxOutputTokens": 8192,
        "supportsReasoning": false, "supportsParallelToolCalls": false
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub stage: String,
    pub at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub profile_id: String,
    pub app_type: String,
    pub session_id: String,
    pub status: String,
    pub started_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
    pub events: Vec<Event>,
}

#[cfg(test)]
pub fn fixture() -> Settings {
    serde_json::from_value(json!({
        "enabled": true, "activeProfileId": "test", "profiles": [{
            "id": "test", "displayName": "Planner + Worker", "enabled": true, "scope": "all",
            "orchestrator": {"appType": "claude", "providerId": "same", "model": "planner"},
            "worker": {"appType": "codex", "providerId": "same", "model": "worker"},
            "budget": {"maxRounds": 2, "maxWorkerCalls": 2, "maxParallelWorkers": 1,
                "timeoutSeconds": 60, "maxOutputTokens": 4096},
            "approvalPolicy": "client", "failureFallback": "fail_closed"
        }]
    }))
    .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opt_in_and_role_routes_do_not_recurse() {
        let mut s = fixture();
        s.validate().unwrap();
        assert!(s.resolve("codex", "ordinary-model").unwrap().is_none());
        assert!(matches!(
            s.resolve("codex", "ccsm-orch/test").unwrap(),
            Some(Route::Profile(_))
        ));
        assert!(matches!(
            s.resolve("codex", "ccsm-role/test/worker").unwrap(),
            Some(Route::Role(_, _))
        ));
        assert!(s.resolve("codex", "ccsm-role/test/missing").is_err());
        s.enabled = false;
        assert!(s.resolve("codex", "ccsm-orch/test").is_err());
        assert!(s.resolve("codex", "ordinary-model").unwrap().is_none());
    }
    #[test]
    fn unsupported_limits_and_wrong_scope_fail_closed() {
        let mut s = fixture();
        s.profiles[0].budget.budget_usd = Some(1.0);
        assert!(s.validate().is_err());
        s.profiles[0].budget.budget_usd = None;
        s.profiles[0].scope = "claude".into();
        assert!(s.resolve("codex", "ccsm-orch/test").is_err());
        s.default_mode_by_app
            .insert("codex".into(), "orchestrated".into());
        assert!(s.validate().is_err());
    }
    #[test]
    fn picker_projection_is_idempotent_and_preserves_direct_models() {
        let mut s = fixture();
        let mut c = json!({"models": [{"model": "ordinary-model"}]});
        s.project_catalog(&mut c);
        s.project_catalog(&mut c);
        assert_eq!(c["models"].as_array().unwrap().len(), 3);
        s.enabled = false;
        s.project_catalog(&mut c);
        assert_eq!(c["models"], json!([{"model": "ordinary-model"}]));
    }

    #[test]
    fn role_validation_respects_empty_and_excluded_canonical_catalogs() {
        let role = fixture().profiles[0].worker.clone();
        for catalog in [
            json!({"models": []}),
            json!({"models": [{"model": "worker", "enabled": false}]}),
        ] {
            let provider = crate::provider::Provider::with_id(
                "same".into(),
                "Worker".into(),
                json!({"modelCatalog": catalog, "model_catalog": {"models": [{"model": "worker"}]}}),
                None,
            );
            assert!(validate_role_provider(&role, &provider).is_err());
        }
        let provider = crate::provider::Provider::with_id(
            "same".into(),
            "Worker".into(),
            json!({"modelCatalog": {"models": [{"model": "worker"}]}}),
            None,
        );
        assert!(validate_role_provider(&role, &provider).is_ok());
    }

    #[test]
    fn unavailable_roles_are_hidden_without_deleting_persisted_profiles() {
        let db = crate::database::Database::memory().unwrap();
        let settings = fixture();
        db.save_orchestration_settings(&settings).unwrap();
        assert!(settings.validate_providers(&db).is_err());
        assert!(settings.routable_settings(&db).unwrap().profiles.is_empty());
        assert_eq!(db.get_orchestration_settings().unwrap().profiles.len(), 1);
    }
}
