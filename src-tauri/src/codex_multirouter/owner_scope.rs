//! Ephemeral owner-view invalidation, not a provider/catalog representation.
//!
//! Local live config may still point to the same router while its canonical
//! providers, included models, key groups or active profile change. Hash the
//! shared DAO projections plus current local settings; never route from, persist,
//! log or return this material to a browser. Unrelated usage rows are excluded.

use crate::{database::Database, error::AppError};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub(crate) fn owner_scope_fingerprint(db: &Database) -> Result<String, AppError> {
    let read = || {
        let settings = crate::settings::get_settings();
        scope_fingerprint_with_settings(db, &settings)
    };
    // No database/settings lock may cross a network await. Reject a changing
    // read rather than certify a torn projection; callers recheck at every
    // awaited boundary and again immediately before committing.
    let before = read()?;
    if before != read()? {
        return Err(AppError::Config("owner_remote_scope_changed".to_string()));
    }
    Ok(before)
}

fn scope_fingerprint_with_settings(
    db: &Database,
    local_settings: &impl Serialize,
) -> Result<String, AppError> {
    // This is deliberately not a new catalog reader. The existing provider DAO
    // owns normalization, including canonical empty catalogs and metadata.
    let providers = db
        .get_all_providers("codex")?
        .into_iter()
        .collect::<BTreeMap<_, _>>();
    let scope = (
        providers,
        db.get_current_provider("codex")?,
        super::active_codex_router_id(db)?,
        db.get_config_snippet("codex")?,
        db.get_global_proxy_url()?,
        db.try_get_proxy_flags_sync("codex")?,
        local_settings,
    );
    let bytes = serde_json::to_vec(&scope)
        .map_err(|_| AppError::Config("owner_remote_scope_unavailable".to_string()))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::Provider;
    use serde_json::{json, Value};

    fn provider(id: &str, settings: Value) -> Provider {
        Provider::with_id(id.to_string(), id.to_string(), settings, None)
    }

    fn fingerprint(db: &Database) -> String {
        scope_fingerprint_with_settings(db, &json!({"currentProviderCodex": "source"}))
            .expect("scope fingerprint")
    }

    #[test]
    fn canonical_provider_configuration_change_invalidates_stable_live_router() {
        let db = Database::memory().expect("memory db");
        let mut source = provider("source", json!({"modelCatalog":{"models":[]}}));
        db.save_provider("codex", &source).expect("save provider");
        let before = fingerprint(&db);
        source.settings_config =
            json!({"modelCatalog":{"models":[{"id":"model-one","enabled":true}]}});
        db.save_provider("codex", &source).expect("change catalog");
        assert_ne!(before, fingerprint(&db));
    }

    #[test]
    fn metadata_key_group_and_provider_selection_change_invalidate_scope() {
        let db = Database::memory().expect("memory db");
        let source = provider("source", json!({"modelCatalog":{"models":[]}}));
        db.save_provider("codex", &source).expect("save provider");
        let before = fingerprint(&db);
        let mut source = source;
        source.meta = Some(crate::provider::ProviderMeta {
            codex_fast_mode: Some(true),
            ..Default::default()
        });
        db.save_provider("codex", &source).expect("save metadata");
        let after_metadata = fingerprint(&db);
        assert_ne!(before, after_metadata);
        source.settings_config["codexApiKeyGroups"] = json!([
            {"id":"group-one","name":"one","apiKey":"redacted-fixture"}
        ]);
        db.save_provider("codex", &source).expect("save key group");
        let after_key_group = fingerprint(&db);
        assert_ne!(after_metadata, after_key_group);
        db.set_current_provider("codex", "source")
            .expect("select provider");
        assert_ne!(after_key_group, fingerprint(&db));
    }

    #[test]
    fn local_settings_and_common_snippet_are_invalidation_inputs() {
        let db = Database::memory().expect("memory db");
        let before = fingerprint(&db);
        db.set_setting("common_config_codex", "fixture_setting = true")
            .expect("change common snippet");
        let after = fingerprint(&db);
        assert_ne!(before, after);
        assert_ne!(
            after,
            scope_fingerprint_with_settings(&db, &json!({"currentProviderCodex":"other"}))
                .expect("new local scope")
        );
    }

    #[test]
    fn broken_proxy_policy_cannot_certify_an_owner_scope() {
        let db = Database::memory().expect("memory db");
        db.conn
            .lock()
            .expect("isolated test db")
            .execute("DROP TABLE proxy_config", [])
            .expect("simulate unavailable canonical policy");
        assert!(scope_fingerprint_with_settings(&db, &json!({})).is_err());
    }

    #[test]
    fn unrelated_usage_or_other_app_updates_do_not_revoke_views() {
        let db = Database::memory().expect("memory db");
        let before = fingerprint(&db);
        db.set_setting("unrelated_usage_counter", "10")
            .expect("usage");
        db.save_provider("claude", &provider("other", json!({"fixture":true})))
            .expect("other app provider");
        assert_eq!(before, fingerprint(&db));
        assert_eq!(before.len(), 64);
        assert!(!before.contains("source"));
    }
}
