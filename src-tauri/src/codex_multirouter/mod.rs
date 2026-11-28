pub(crate) mod catalog;
pub(crate) mod compile_inputs;
pub mod compiler;
pub mod migration;
pub mod mutation;
mod owner_scope;
pub(crate) use owner_scope::owner_scope_fingerprint;
pub mod projection;
pub(crate) mod protocol_capability;
pub mod provider_set;
pub mod schema;

use crate::app_config::AppType;
use crate::database::Database;
use crate::error::AppError;

/// Resolve the Router that owns the single shared Codex live projection.
/// An active workspace wins, followed by the device-local selection and the DB fallback.
pub(crate) fn active_codex_router_id(db: &Database) -> Result<Option<String>, AppError> {
    let local = crate::settings::get_current_provider(&AppType::Codex);
    active_codex_router_id_with_local(db, local.as_deref())
}

pub(crate) fn active_codex_router_id_with_local(
    db: &Database,
    local_provider_id: Option<&str>,
) -> Result<Option<String>, AppError> {
    if let Some(profile_id) = db.get_current_profile_id("codex")? {
        let profiles = db.get_all_profiles()?;
        if let Some(profile) = profiles
            .into_iter()
            .find(|profile| profile.id == profile_id)
        {
            let payload: serde_json::Value =
                serde_json::from_str(&profile.payload).map_err(|error| {
                    AppError::Database(format!("Failed to parse profile payload: {error}"))
                })?;
            if let Some(id) = payload
                .get("providers")
                .and_then(|providers| providers.get("codex"))
                .and_then(serde_json::Value::as_str)
                .filter(|id| !id.is_empty())
            {
                if let Some(id) = canonical_codex_router_id(db, id)? {
                    return Ok(Some(id));
                }
            }
        }
    }
    if let Some(id) = local_provider_id.filter(|id| !id.is_empty()) {
        if let Some(id) = canonical_codex_router_id(db, id)? {
            return Ok(Some(id));
        }
    }
    let current = db.get_current_provider("codex")?;
    current
        .as_deref()
        .map(|id| canonical_codex_router_id(db, id))
        .transpose()
        .map(|id| id.flatten())
}

/// Provider Set leaves are persistence/runtime implementation details. Resolve
/// them back to their user-facing facade before projection ownership checks.
fn canonical_codex_router_id(db: &Database, provider_id: &str) -> Result<Option<String>, AppError> {
    let Some(provider) = db.get_provider_by_id(provider_id, "codex")? else {
        return Ok(None);
    };
    let Some(parent_id) = provider_set::codex_provider_set_leaf_parent_id(&provider) else {
        return Ok(Some(provider_id.to_string()));
    };
    let parent = db.get_provider_by_id(parent_id, "codex")?;
    if parent
        .as_ref()
        .is_some_and(provider_set::is_codex_provider_set_facade)
    {
        return Ok(Some(parent_id.to_string()));
    }
    log::warn!(
        "Codex current Provider points to an orphaned internal Provider Set leaf: {provider_id}"
    );
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Profile;
    use crate::provider::Provider;

    #[test]
    fn stale_profile_provider_falls_back_to_device_local_provider() {
        let db = Database::memory().expect("memory db");
        db.save_provider(
            "codex",
            &Provider::with_id(
                "router-local".to_string(),
                "Local Router".to_string(),
                serde_json::json!({}),
                None,
            ),
        )
        .expect("save local router");
        db.save_profile(&Profile {
            id: "workspace".to_string(),
            name: "Workspace".to_string(),
            payload: r#"{"providers":{"codex":"deleted-router"}}"#.to_string(),
            sort_order: None,
            created_at: Some(1),
            updated_at: Some(1),
        })
        .expect("save profile");
        db.set_current_profile_id("codex", Some("workspace"))
            .expect("activate profile");

        assert_eq!(
            active_codex_router_id_with_local(&db, Some("router-local"))
                .expect("resolve active router"),
            Some("router-local".to_string())
        );
    }

    #[test]
    fn generated_leaf_current_provider_resolves_to_its_facade() {
        let db = Database::memory().expect("memory db");
        let facade = Provider::with_id(
            "router-facade".to_string(),
            "Router facade".to_string(),
            serde_json::json!({
                "codexProtocolSet": {
                    "version": 1,
                    "role": "facade",
                    "responsesProviderId": "router-facade::responses",
                    "chatProviderId": "router-facade::chat"
                }
            }),
            None,
        );
        let leaf = Provider::with_id(
            "router-facade::chat".to_string(),
            "Router facade (Chat)".to_string(),
            serde_json::json!({
                "codexProtocolSet": {
                    "version": 1,
                    "role": "leaf",
                    "transport": "open_ai_chat",
                    "parentProviderId": "router-facade"
                }
            }),
            None,
        );
        db.save_provider("codex", &facade).expect("save facade");
        db.save_provider("codex", &leaf).expect("save leaf");
        db.set_current_provider("codex", &leaf.id)
            .expect("set leaf current");

        assert_eq!(
            active_codex_router_id_with_local(&db, None).expect("resolve active router"),
            Some(facade.id)
        );
    }
}
