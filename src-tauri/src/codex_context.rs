//! Official context limits belong to the selected provider and authentication
//! source. Effective defaults never become a second persisted catalog.

use crate::{error::AppError, provider::Provider};
use serde_json::Value;

const OFFICIAL_CONTEXT_DEFAULTS: &str =
    include_str!("../../src/config/codexOfficialContextDefaults.json");
const PROVIDER_CONTEXT_FIELDS: &[&str] = &[
    "contextWindow",
    "context_window",
    "modelContextWindow",
    "model_context_window",
];
const MODEL_CONTEXT_FIELDS: &[&str] = &["contextWindow", "context_window"];

pub(crate) fn explicit_context_window(entry: &Value, fields: &[&str]) -> Option<u64> {
    crate::services::model_fetch::explicit_positive_model_limit(entry.as_object()?, fields)
}

fn context_window(entry: &Value) -> Option<u64> {
    explicit_context_window(entry, MODEL_CONTEXT_FIELDS)
}

fn checked_context_window(entry: &Value, fields: &[&str]) -> Result<Option<u64>, AppError> {
    let mut selected = None;
    for field in fields {
        if entry.get(*field).is_none_or(Value::is_null) {
            continue;
        }
        let limit = explicit_context_window(entry, &[*field]).ok_or_else(|| {
            AppError::InvalidInput(format!(
                "Official context field '{field}' must be a positive integer"
            ))
        })?;
        if selected.is_none() {
            selected = Some(limit);
        }
    }
    Ok(selected)
}

fn model_id(entry: &Value) -> Option<&str> {
    ["model", "id", "slug"].iter().find_map(|field| {
        entry
            .get(*field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
    })
}

fn upstream_id(entry: &Value) -> Option<&str> {
    ["upstreamModel", "upstream_model"]
        .iter()
        .find_map(|field| {
            entry
                .get(*field)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
        })
}

/// This registry contains verified native defaults only. Published API specs
/// are display references and must not authorize ChatGPT account enlargement.
pub(crate) fn official_default_context_window(model: &str) -> Option<u64> {
    let defaults: Value = serde_json::from_str(OFFICIAL_CONTEXT_DEFAULTS).ok()?;
    defaults
        .get("models")?
        .as_array()?
        .iter()
        .find(|entry| model_id(entry).is_some_and(|id| id.eq_ignore_ascii_case(model.trim())))
        .and_then(context_window)
}

pub(crate) fn official_account_id(provider: &Provider) -> Option<String> {
    official_account_id_with_default(provider, || {
        let manager = crate::proxy::providers::codex_oauth_auth::CodexOAuthManager::new(
            crate::config::get_app_config_dir(),
        );
        crate::services::provider::block_on_tauri_runtime(manager.default_account_id())
    })
}

fn official_account_id_with_default(
    provider: &Provider,
    default_account: impl FnOnce() -> Option<String>,
) -> Option<String> {
    // Use the same canonical official materialization and managed binding
    // reader as forwarding. Ordinary OAuth providers already own authBinding;
    // canonical Official materializes its selector into that same contract.
    let effective = crate::proxy::providers::materialize_codex_official_auth(provider, None);
    if !effective.is_codex_oauth() {
        return None;
    }
    match effective
        .meta
        .as_ref()
        .and_then(|meta| meta.managed_account_id_for("codex_oauth"))
    {
        Some(id) => (!id.trim().is_empty()).then_some(id),
        None => default_account(),
    }
}

pub(crate) fn official_auth_binding_matches(left: &Provider, right: &Provider) -> bool {
    let left_auth = left
        .meta
        .as_ref()
        .and_then(|meta| meta.codex_official_auth.as_ref());
    let right_auth = right
        .meta
        .as_ref()
        .and_then(|meta| meta.codex_official_auth.as_ref());
    if left_auth != right_auth {
        return false;
    }
    let left = crate::proxy::providers::materialize_codex_official_auth(left, None);
    let right = crate::proxy::providers::materialize_codex_official_auth(right, None);
    if left.is_codex_oauth() != right.is_codex_oauth() {
        return false;
    }
    let pool_enabled = |provider: &Provider| {
        provider
            .settings_config
            .get(crate::proxy::providers::CODEX_ACCOUNT_POOL_ENABLED)
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    if pool_enabled(&left) != pool_enabled(&right)
        || crate::proxy::providers::provider_uses_native_codex_auth(&left)
            != crate::proxy::providers::provider_uses_native_codex_auth(&right)
    {
        return false;
    }
    let binding_identity = |provider: &Provider| {
        provider
            .meta
            .as_ref()
            .and_then(|meta| meta.auth_binding.as_ref())
            .map(|binding| {
                (
                    binding.source.clone(),
                    binding.auth_provider.clone(),
                    binding.account_id.clone(),
                )
            })
    };
    if binding_identity(&left) != binding_identity(&right) {
        return false;
    }
    if left.is_codex_oauth() {
        // An implicit default has no persisted historical account binding.
        // Require current discovery rather than grandfathering it after the
        // manager's default account may have changed outside this provider.
        return left
            .meta
            .as_ref()
            .and_then(|meta| meta.managed_account_id_for("codex_oauth"))
            .is_some_and(|id| !id.trim().is_empty());
    }
    true
}

/// Constructed only from backend discovery. A public directory can provide a
/// conservative native default; only authenticated selected-account metadata
/// can provide an enlargement ceiling.
#[derive(Debug, Clone)]
pub(crate) struct TrustedOfficialModel {
    id: String,
    default: Option<u64>,
    account_maximum: Option<u64>,
    source: &'static str,
}

pub(crate) fn trusted_official_models(provider: &Provider) -> Vec<TrustedOfficialModel> {
    if !crate::codex_config::codex_provider_record_is_official(provider) {
        return Vec::new();
    }
    let mut models = official_account_id(provider)
        .map(|account_id| {
            crate::services::codex_oauth_models::authenticated_model_limits(&account_id)
                .into_iter()
                .map(|model| TrustedOfficialModel {
                    id: model.id,
                    default: model.context_window,
                    account_maximum: model.max_context_window,
                    source: "account_directory",
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    models.extend(
        crate::codex_config::codex_official_models_cache()
            .unwrap_or_default()
            .iter()
            .filter_map(|entry| {
                Some(TrustedOfficialModel {
                    id: model_id(entry)?.to_string(),
                    default: context_window(entry),
                    account_maximum: None,
                    source: "official_directory",
                })
            }),
    );
    models
}

fn trusted_model<'a>(
    models: &'a [TrustedOfficialModel],
    model: &str,
) -> Option<&'a TrustedOfficialModel> {
    models
        .iter()
        .find(|entry| entry.id.eq_ignore_ascii_case(model.trim()))
}

fn resolved_from_models(
    model: &str,
    row_max: Option<u64>,
    models: &[TrustedOfficialModel],
) -> Option<(u64, &'static str)> {
    let trusted = trusted_model(models, model);
    let (default, source) = trusted
        .and_then(|entry| entry.default.map(|value| (value, entry.source)))
        .or_else(|| {
            official_default_context_window(model).map(|value| (value, "official_default"))
        })?;
    let maximum = trusted
        .and_then(|entry| entry.account_maximum)
        .into_iter()
        .chain(row_max)
        .min();
    Some((
        maximum.map_or(default, |maximum| default.min(maximum)),
        source,
    ))
}

pub(crate) fn resolved_official_context_window(
    provider: &Provider,
    model: &str,
    row_max: Option<u64>,
) -> Option<(u64, &'static str)> {
    if !crate::codex_config::codex_provider_record_is_official(provider) {
        return None;
    }
    resolved_from_models(model, row_max, &trusted_official_models(provider))
}

pub(crate) fn apply_official_context_defaults(provider: &Provider, settings: &mut Value) {
    if !crate::codex_config::codex_provider_record_is_official(provider)
        || explicit_context_window(settings, PROVIDER_CONTEXT_FIELDS).is_some()
    {
        return;
    }
    let models = trusted_official_models(provider);
    let Some(object) = settings.as_object_mut() else {
        return;
    };
    let Some(catalog) = crate::codex_multirouter::catalog::read_catalog_mut(object) else {
        return;
    };
    let Some(rows) = catalog.get_mut("models").and_then(Value::as_array_mut) else {
        return;
    };
    for entry in rows {
        if entry.get("enabled").and_then(Value::as_bool) == Some(false)
            || context_window(entry).is_some()
        {
            continue;
        }
        let Some(model) = upstream_id(entry).or_else(|| model_id(entry)) else {
            continue;
        };
        let maximum = explicit_context_window(entry, &["maxContextWindow", "max_context_window"]);
        let Some((window, _)) = resolved_from_models(model, maximum, &models) else {
            continue;
        };
        if let Some(object) = entry.as_object_mut() {
            object.insert("contextWindow".into(), window.into());
        }
    }
}

pub(crate) fn validate_official_context_changes(
    provider: &Provider,
    previous: Option<&Provider>,
    models: &[TrustedOfficialModel],
) -> Result<(), AppError> {
    if !crate::codex_config::codex_provider_record_is_official(provider) {
        return Ok(());
    }
    let provider_window =
        checked_context_window(&provider.settings_config, PROVIDER_CONTEXT_FIELDS)?;
    for entry in crate::codex_multirouter::catalog::catalog_models(&provider.settings_config)
        .unwrap_or_default()
    {
        let row_window = checked_context_window(entry, MODEL_CONTEXT_FIELDS)?;
        // An invalid editable maximum must not silently disappear and become
        // an unrestricted context declaration through another alias.
        checked_context_window(entry, &["maxContextWindow", "max_context_window"])?;
        let Some(window) = row_window.or(provider_window) else {
            continue;
        };
        let Some(model) = model_id(entry) else {
            continue;
        };
        let upstream = upstream_id(entry).unwrap_or(model);
        let unchanged = previous.is_some_and(|previous| {
            crate::codex_config::codex_provider_record_is_official(previous)
                && official_auth_binding_matches(provider, previous)
                && crate::codex_multirouter::catalog::catalog_models(&previous.settings_config)
                    .is_some_and(|models| {
                        models.iter().any(|prior| {
                            model_id(prior) == Some(model)
                                && upstream_id(prior).unwrap_or(model) == upstream
                                && (entry.get("enabled").and_then(Value::as_bool) == Some(false)
                                    || prior.get("enabled").and_then(Value::as_bool) != Some(false))
                                && context_window(prior).or_else(|| {
                                    explicit_context_window(
                                        &previous.settings_config,
                                        PROVIDER_CONTEXT_FIELDS,
                                    )
                                }) == Some(window)
                        })
                    })
        });
        if unchanged {
            continue;
        }
        let trusted = trusted_model(models, upstream);
        // Persisted row maximum is a conservative clamp for derived defaults.
        // Explicit edits use fresh selected-account authorization; stale row
        // metadata cannot raise or lower that authenticated capability.
        let maximum = trusted.and_then(|entry| entry.account_maximum);
        let default = trusted
            .and_then(|entry| entry.default)
            .or_else(|| official_default_context_window(upstream));
        let ceiling = maximum.or(default);
        if ceiling.is_none_or(|limit| window > limit) || (window >= 1_000_000 && maximum.is_none())
        {
            return Err(AppError::InvalidInput(format!(
                "Official model '{model}' context {window} exceeds trusted metadata (maximum: {}, default: {}). Discover models for the selected authentication source before changing this context window.",
                maximum.map(|value| value.to_string()).unwrap_or_else(|| "unknown".into()),
                default.map(|value| value.to_string()).unwrap_or_else(|| "unknown".into()),
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn official(rows: Value) -> Provider {
        let mut provider = Provider::with_id(
            crate::database::CODEX_OFFICIAL_PROVIDER_ID.into(),
            "Official".into(),
            json!({"modelCatalog":{"models":rows}}),
            None,
        );
        provider.category = Some("official".into());
        provider
    }
    fn managed(rows: Value, account_id: &str) -> Provider {
        let mut provider = official(rows);
        provider.meta = Some(crate::provider::ProviderMeta {
            codex_official_auth: Some(crate::provider::CodexOfficialAuthConfig {
                mode: crate::provider::CodexOfficialAuthMode::ManagedOauth,
                account_id: Some(account_id.into()),
            }),
            ..Default::default()
        });
        provider
    }
    fn ordinary_oauth(rows: Value, account_id: Option<&str>) -> Provider {
        let mut provider = Provider::with_id(
            "managed-custom".into(),
            "Managed".into(),
            json!({"modelCatalog":{"models":rows}}),
            None,
        );
        provider.category = Some("custom".into());
        provider.meta = Some(crate::provider::ProviderMeta {
            provider_type: Some("codex_oauth".into()),
            auth_binding: Some(crate::provider::AuthBinding {
                source: crate::provider::AuthBindingSource::ManagedAccount,
                auth_provider: Some("codex_oauth".into()),
                account_id: account_id.map(str::to_string),
            }),
            ..Default::default()
        });
        provider
    }
    fn metadata(default: Option<u64>, account_maximum: Option<u64>) -> Vec<TrustedOfficialModel> {
        vec![TrustedOfficialModel {
            id: "wire".into(),
            default,
            account_maximum,
            source: "account_directory",
        }]
    }

    #[test]
    fn official_context_validation_uses_account_max_not_editable_or_public_maxima() {
        let provider = managed(
            json!([{"model":"alias", "upstreamModel":"wire", "contextWindow":1000000, "maxContextWindow":2000000}]),
            "account-a",
        );
        assert!(validate_official_context_changes(&provider, None, &[]).is_err());
        assert!(validate_official_context_changes(
            &provider,
            None,
            &metadata(Some(272000), Some(872000))
        )
        .is_err());
        assert!(validate_official_context_changes(
            &provider,
            None,
            &metadata(Some(272000), Some(1000000))
        )
        .is_ok());
        let public = vec![TrustedOfficialModel {
            id: "wire".into(),
            default: Some(272000),
            account_maximum: None,
            source: "official_directory",
        }];
        assert!(validate_official_context_changes(&provider, None, &public).is_err());
        let mut explicit = provider.clone();
        explicit.settings_config["modelCatalog"]["models"][0]["maxContextWindow"] = json!(128000);
        explicit.settings_config["modelCatalog"]["models"][0]["contextWindow"] = json!(200000);
        assert!(validate_official_context_changes(&explicit, None, &metadata(Some(272000), Some(1000000))).is_ok(), "fresh account maximum governs explicit edits; stale row maximum only clamps derived defaults");
    }

    #[test]
    fn official_context_ordinary_oauth_uses_managed_binding_and_rechecks_account_changes() {
        let suffix = uuid::Uuid::new_v4();
        let model = format!("ordinary-context-{suffix}");
        let account_a = format!("ordinary-a-{suffix}");
        let account_b = format!("ordinary-b-{suffix}");
        let models = [crate::services::model_fetch::FetchedModel {
            id: model.clone(),
            context_window: Some(272000),
            max_context_window: Some(1000000),
            ..Default::default()
        }];
        crate::services::codex_oauth_models::record_authenticated_model_limits(&account_a, &models);
        crate::services::codex_oauth_models::record_authenticated_model_limits(
            &account_b,
            &[crate::services::model_fetch::FetchedModel {
                id: model.clone(),
                context_window: Some(272000),
                ..Default::default()
            }],
        );
        let previous = ordinary_oauth(
            json!([{"model":model, "contextWindow":1000000}]),
            Some(&account_a),
        );
        assert_eq!(
            official_account_id_with_default(&previous, || panic!(
                "explicit binding must not follow default"
            )),
            Some(account_a.clone())
        );
        assert!(validate_official_context_changes(
            &previous,
            None,
            &trusted_official_models(&previous)
        )
        .is_ok());
        let mut switched = previous.clone();
        switched
            .meta
            .as_mut()
            .unwrap()
            .auth_binding
            .as_mut()
            .unwrap()
            .account_id = Some(account_b.clone());
        assert_eq!(
            official_account_id_with_default(&switched, || None),
            Some(account_b.clone())
        );
        assert!(!official_auth_binding_matches(&switched, &previous));
        assert!(validate_official_context_changes(
            &switched,
            Some(&previous),
            &trusted_official_models(&switched)
        )
        .is_err());
        crate::services::codex_oauth_models::record_authenticated_model_limits(&account_b, &models);
        assert!(
            validate_official_context_changes(
                &switched,
                Some(&previous),
                &trusted_official_models(&switched)
            )
            .is_ok(),
            "new selected-account discovery can authorize the unchanged context"
        );
        let mut implicit = previous.clone();
        implicit
            .meta
            .as_mut()
            .unwrap()
            .auth_binding
            .as_mut()
            .unwrap()
            .account_id = None;
        assert_eq!(official_account_id_with_default(&implicit, || None), None);
        assert_eq!(
            official_account_id_with_default(&implicit, || Some(account_b.clone())),
            Some(account_b.clone())
        );
        assert!(!official_auth_binding_matches(&implicit, &previous));
        assert!(
            !official_auth_binding_matches(&implicit, &implicit),
            "implicit defaults have no historical persisted account identity"
        );
        let mut source_changed = previous.clone();
        source_changed
            .meta
            .as_mut()
            .unwrap()
            .auth_binding
            .as_mut()
            .unwrap()
            .source = crate::provider::AuthBindingSource::ProviderConfig;
        assert_eq!(
            official_account_id_with_default(&source_changed, || None),
            None
        );
        assert_eq!(
            official_account_id_with_default(&source_changed, || Some(account_b.clone())),
            Some(account_b.clone())
        );
        assert!(!official_auth_binding_matches(&source_changed, &previous));
        let mut auth_provider_changed = previous.clone();
        auth_provider_changed
            .meta
            .as_mut()
            .unwrap()
            .auth_binding
            .as_mut()
            .unwrap()
            .auth_provider = Some("xai_oauth".into());
        assert_eq!(
            official_account_id_with_default(&auth_provider_changed, || None),
            None
        );
        assert!(!official_auth_binding_matches(
            &auth_provider_changed,
            &previous
        ));
        let mut type_changed = previous.clone();
        type_changed.meta.as_mut().unwrap().provider_type = None;
        assert_eq!(
            official_account_id_with_default(&type_changed, || panic!(
                "non-OAuth never reads a managed default"
            )),
            None
        );
        assert!(!official_auth_binding_matches(&type_changed, &previous));
    }

    #[test]
    fn official_context_auth_resolution_mirrors_canonical_and_ordinary_precedence() {
        let mut ordinary = ordinary_oauth(json!([]), Some("ordinary-account"));
        ordinary.meta.as_mut().unwrap().codex_official_auth =
            Some(crate::provider::CodexOfficialAuthConfig {
                mode: crate::provider::CodexOfficialAuthMode::ManagedOauth,
                account_id: Some("ignored-special-selector".into()),
            });
        assert_eq!(
            official_account_id_with_default(&ordinary, || None),
            Some("ordinary-account".into())
        );
        for mode in [
            crate::provider::CodexOfficialAuthMode::DesktopCurrentLogin,
            crate::provider::CodexOfficialAuthMode::AccountPool,
        ] {
            let mut canonical = managed(json!([]), "unused");
            canonical
                .meta
                .as_mut()
                .unwrap()
                .codex_official_auth
                .as_mut()
                .unwrap()
                .mode = mode;
            canonical.meta.as_mut().unwrap().provider_type = Some("codex_oauth".into());
            canonical.meta.as_mut().unwrap().auth_binding =
                ordinary.meta.as_ref().unwrap().auth_binding.clone();
            assert_eq!(
                official_account_id_with_default(&canonical, || panic!(
                    "native/pool cannot inherit managed discovery"
                )),
                None
            );
        }
    }

    #[test]
    fn official_context_discovery_authority_is_bound_to_selected_account_and_mode() {
        let suffix = uuid::Uuid::new_v4();
        let model = format!("account-bound-{suffix}");
        let account_a = format!("context-a-{suffix}");
        let account_b = format!("context-b-{suffix}");
        crate::services::codex_oauth_models::record_authenticated_model_limits(
            &account_a,
            &[crate::services::model_fetch::FetchedModel {
                id: model.clone(),
                context_window: Some(272000),
                max_context_window: Some(1000000),
                ..Default::default()
            }],
        );
        crate::services::codex_oauth_models::record_authenticated_model_limits(
            &account_b,
            &[crate::services::model_fetch::FetchedModel {
                id: model.clone(),
                context_window: Some(272000),
                ..Default::default()
            }],
        );
        let provider = managed(
            json!([{"model":model, "contextWindow":1000000}]),
            &account_a,
        );
        assert!(validate_official_context_changes(
            &provider,
            None,
            &trusted_official_models(&provider)
        )
        .is_ok());
        let mut switched = provider.clone();
        switched
            .meta
            .as_mut()
            .unwrap()
            .codex_official_auth
            .as_mut()
            .unwrap()
            .account_id = Some(account_b);
        assert!(validate_official_context_changes(
            &switched,
            Some(&provider),
            &trusted_official_models(&switched)
        )
        .is_err());
        switched
            .meta
            .as_mut()
            .unwrap()
            .codex_official_auth
            .as_mut()
            .unwrap()
            .mode = crate::provider::CodexOfficialAuthMode::DesktopCurrentLogin;
        assert!(validate_official_context_changes(
            &switched,
            Some(&provider),
            &trusted_official_models(&switched)
        )
        .is_err());
        switched
            .meta
            .as_mut()
            .unwrap()
            .codex_official_auth
            .as_mut()
            .unwrap()
            .mode = crate::provider::CodexOfficialAuthMode::AccountPool;
        assert!(validate_official_context_changes(
            &switched,
            Some(&provider),
            &trusted_official_models(&switched)
        )
        .is_err());
    }

    #[test]
    fn official_context_unknown_max_caps_edits_at_known_default_and_unknown_fails_closed() {
        let mut provider = official(json!([{"model":"wire", "contextWindow":500000}]));
        assert!(
            validate_official_context_changes(&provider, None, &metadata(Some(272000), None))
                .is_err()
        );
        provider.settings_config["modelCatalog"]["models"][0]["contextWindow"] = json!(272000);
        assert!(
            validate_official_context_changes(&provider, None, &metadata(Some(272000), None))
                .is_ok()
        );
        assert!(validate_official_context_changes(&provider, None, &[]).is_err());
    }

    #[test]
    fn official_context_provider_fallbacks_cannot_bypass_limits_and_empty_catalog_stays_empty() {
        for field in PROVIDER_CONTEXT_FIELDS {
            let mut provider = managed(
                json!([{"model":"alias", "upstreamModel":"wire"}]),
                "account-a",
            );
            provider.settings_config[*field] = json!("1000000");
            assert!(
                validate_official_context_changes(&provider, None, &metadata(Some(272000), None))
                    .is_err(),
                "{field}"
            );
            assert!(
                validate_official_context_changes(
                    &provider,
                    None,
                    &metadata(Some(272000), Some(1000000))
                )
                .is_ok(),
                "{field}"
            );
            assert!(
                validate_official_context_changes(&provider, Some(&provider), &[]).is_ok(),
                "unchanged legacy {field}"
            );
            provider.settings_config["modelCatalog"]["models"] = json!([]);
            provider.settings_config["model_catalog"] =
                json!({"models":[{"model":"stale", "contextWindow":2000000}]});
            assert!(
                validate_official_context_changes(&provider, None, &[]).is_ok(),
                "empty canonical has no effective model {field}"
            );
        }
    }

    #[test]
    fn official_context_rejects_malformed_explicit_values_in_rows_and_provider_fallbacks() {
        for invalid in [
            json!(0),
            json!(-1),
            json!(1.5),
            json!("8000 tokens"),
            json!(""),
            json!({"value":1000000}),
            json!(true),
        ] {
            for field in PROVIDER_CONTEXT_FIELDS {
                let mut provider = official(json!([{"model":"wire"}]));
                provider.settings_config[*field] = invalid.clone();
                assert!(
                    validate_official_context_changes(
                        &provider,
                        None,
                        &metadata(Some(272000), Some(1000000))
                    )
                    .is_err(),
                    "{field}={invalid}"
                );
            }
            for field in [
                "contextWindow",
                "context_window",
                "maxContextWindow",
                "max_context_window",
            ] {
                let mut provider = official(json!([{"model":"wire", "contextWindow":272000}]));
                provider.settings_config["modelCatalog"]["models"][0][field] = invalid.clone();
                assert!(
                    validate_official_context_changes(
                        &provider,
                        None,
                        &metadata(Some(272000), Some(1000000))
                    )
                    .is_err(),
                    "{field}={invalid}"
                );
            }
        }
    }

    #[test]
    fn official_context_legacy_exemption_requires_previous_official_identity_and_inclusion() {
        let previous = Provider::with_id(
            "custom".into(),
            "Custom".into(),
            json!({"modelCatalog":{"models":[{"model":"wire", "contextWindow":1000000}]}}),
            None,
        );
        let mut official = previous.clone();
        official.category = Some("official".into());
        assert!(validate_official_context_changes(&official, Some(&previous), &[]).is_err());
        let mut excluded = official.clone();
        excluded.settings_config["modelCatalog"]["models"][0]["enabled"] = json!(false);
        assert!(validate_official_context_changes(&excluded, Some(&excluded), &[]).is_ok());
        assert!(validate_official_context_changes(&official, Some(&excluded), &[]).is_err());
    }

    #[test]
    fn official_context_legacy_unchanged_survives_but_auth_and_upstream_changes_recheck() {
        let previous = managed(
            json!([{"model":"alias", "upstreamModel":"wire", "contextWindow":"1000000"}]),
            "account-a",
        );
        assert!(validate_official_context_changes(&previous, Some(&previous), &[]).is_ok());
        let mut switched = previous.clone();
        switched
            .meta
            .as_mut()
            .unwrap()
            .codex_official_auth
            .as_mut()
            .unwrap()
            .account_id = Some("account-b".into());
        assert!(validate_official_context_changes(&switched, Some(&previous), &[]).is_err());
        let mut renamed = previous.clone();
        renamed.settings_config["modelCatalog"]["models"][0]["upstreamModel"] = json!("other");
        assert!(validate_official_context_changes(
            &renamed,
            Some(&previous),
            &metadata(Some(272000), Some(1000000))
        )
        .is_err());
    }

    #[test]
    fn official_context_empty_canonical_masks_legacy_and_third_party_is_unchanged() {
        let mut provider = official(json!([]));
        provider.settings_config["model_catalog"] =
            json!({"models":[{"model":"wire", "contextWindow":2000000}]});
        assert!(validate_official_context_changes(&provider, None, &[]).is_ok());
        let mut effective = provider.settings_config.clone();
        apply_official_context_defaults(&provider, &mut effective);
        assert!(
            crate::codex_multirouter::catalog::catalog_models(&effective)
                .unwrap()
                .is_empty()
        );
        let third_party = Provider::with_id(
            "third-party".into(),
            "Third Party".into(),
            json!({"modelCatalog":{"models":[{"model":"wire", "contextWindow":2000000}]}}),
            None,
        );
        assert!(validate_official_context_changes(&third_party, None, &[]).is_ok());
    }

    #[test]
    fn official_context_defaults_affect_only_effective_clones_and_preserve_overrides() {
        let account = format!("context-clone-{}", uuid::Uuid::new_v4());
        crate::services::codex_oauth_models::record_authenticated_model_limits(
            &account,
            &[crate::services::model_fetch::FetchedModel {
                id: "wire".into(),
                context_window: Some(600000),
                max_context_window: Some(450000),
                ..Default::default()
            }],
        );
        let provider = managed(
            json!([
                {"model":"alias", "upstreamModel":"wire"},
                {"model":"explicit", "upstreamModel":"wire", "contextWindow":"128000"},
                {"model":"excluded", "upstreamModel":"wire", "enabled":false}
            ]),
            &account,
        );
        let before = provider.settings_config.clone();
        let mut effective = before.clone();
        apply_official_context_defaults(&provider, &mut effective);
        assert_eq!(
            effective["modelCatalog"]["models"][0]["contextWindow"],
            450000
        );
        assert_eq!(
            effective["modelCatalog"]["models"][1]["contextWindow"],
            "128000"
        );
        assert!(effective["modelCatalog"]["models"][2]
            .get("contextWindow")
            .is_none());
        assert_eq!(provider.settings_config, before);
        effective["contextWindow"] = json!("64000");
        effective["modelCatalog"]["models"][0]
            .as_object_mut()
            .unwrap()
            .remove("contextWindow");
        apply_official_context_defaults(&provider, &mut effective);
        assert!(effective["modelCatalog"]["models"][0]
            .get("contextWindow")
            .is_none());
    }

    #[test]
    fn official_context_fresh_account_missing_max_masks_other_sources_and_row_max_only_caps() {
        let provider = official(json!([{"model":"wire", "contextWindow":1000000}]));
        let mut models = metadata(Some(272000), None);
        models.extend(metadata(Some(400000), Some(2000000)));
        assert!(validate_official_context_changes(&provider, None, &models).is_err());
        assert_eq!(
            resolved_from_models("wire", Some(2000000), &models),
            Some((272000, "account_directory"))
        );
        assert_eq!(
            resolved_from_models("wire", Some(128000), &models),
            Some((128000, "account_directory"))
        );
        assert_eq!(
            resolved_from_models("wire", Some(2000000), &metadata(None, Some(2000000))),
            None
        );
    }
}
