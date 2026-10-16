//! Internal catalogue normalization. Native provider/Codex descriptor adapters stay at the edges.
use serde_json::Value;
use std::sync::OnceLock;

fn contract() -> &'static Value {
    static CONTRACT: OnceLock<Value> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../src/config/codexCatalogContract.json"
        ))
        .expect("embedded catalogue alias contract is valid JSON")
    })
}

fn normalize_aliases(value: &mut Value, section: &str) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    let Some(fields) = contract()[section].as_object() else {
        return;
    };
    for (canonical, aliases) in fields {
        let aliases = aliases.as_array().expect("alias list");
        let selected = std::iter::once(canonical.as_str())
            .chain(aliases.iter().filter_map(Value::as_str))
            .find_map(|key| {
                object
                    .get(key)
                    .filter(|value| {
                        !value.is_null()
                            && !value.as_str().is_some_and(|text| text.trim().is_empty())
                    })
                    .cloned()
            });
        if let Some(selected) = selected {
            object.insert(canonical.clone(), selected);
        }
        for alias in aliases.iter().filter_map(Value::as_str) {
            object.remove(alias);
        }
    }
}

pub(crate) fn normalize_reasoning(value: &mut Value) {
    normalize_reasoning_declaration(value, true);
}

fn normalize_reasoning_declaration(value: &mut Value, repair_default: bool) {
    normalize_aliases(value, "reasoning");
    let Some(object) = value.as_object_mut() else {
        return;
    };
    let Some(upstream) = object.get_mut("upstream") else {
        return;
    };
    normalize_aliases(upstream, "upstream");
    let Some(upstream) = upstream.as_object_mut() else {
        return;
    };
    if upstream.get("format").and_then(Value::as_str) == Some("object") {
        upstream.insert("format".into(), Value::from("reasoning_object"));
    }
    let format = upstream
        .get("format")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let status = match object.get("supported").and_then(Value::as_bool) {
        Some(true) => "confirmed_supported",
        Some(false) => "confirmed_unsupported",
        None => "unknown",
    };
    if object.get("supportStatus").is_none_or(Value::is_null) {
        object.insert("supportStatus".into(), Value::from(status));
    }
    object.remove("supported");
    let efforts = object
        .get("supportedEfforts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let kind = if !efforts.is_empty() {
        "graded"
    } else {
        match format.as_str() {
            "boolean" => "boolean",
            "none" => "none",
            _ => "unknown",
        }
    };
    if object.get("controlKind").is_none_or(Value::is_null) {
        object.insert("controlKind".into(), Value::from(kind));
    }
    object.insert("schemaVersion".into(), Value::from(2));
    if object.get("disableAllowed").is_none_or(Value::is_null) {
        object.insert("disableAllowed".into(), Value::Bool(false));
    }
    if repair_default
        && object
            .get("defaultEffort")
            .is_some_and(|value| value.is_string() && !efforts.contains(value))
    {
        if let Some(first) = efforts.first() {
            object.insert("defaultEffort".into(), first.clone());
        } else {
            object.remove("defaultEffort");
        }
    }
    if object.get("supportStatus").and_then(Value::as_str) == Some("confirmed_supported")
        && object.get("controlKind").and_then(Value::as_str) == Some("graded")
        && !matches!(format.as_str(), "none" | "boolean")
    {
        let upstream = object
            .get_mut("upstream")
            .and_then(Value::as_object_mut)
            .expect("checked upstream");
        let map = upstream
            .entry("effortMap")
            .or_insert_with(|| serde_json::json!({}));
        if !map.is_object() {
            *map = serde_json::json!({});
        }
        let map = map.as_object_mut().expect("effort map object");
        for effort in efforts
            .iter()
            .filter_map(Value::as_str)
            .filter(|effort| *effort != "none")
        {
            if map.get(effort).is_none_or(Value::is_null) {
                map.insert(effort.into(), Value::from(effort));
            }
        }
    }
}

pub(crate) fn normalize_model(model: &mut Value) {
    normalize_aliases(model, "model");
    normalize_capability_fields(model);
}

fn normalize_capability_fields(model: &mut Value) {
    if let Some(context) = model.get("contextWindow").and_then(parse_context_window) {
        model["contextWindow"] = Value::from(context);
    }
    if let Some(reasoning) = model.get_mut("reasoning") {
        normalize_reasoning(reasoning);
    }
    if let Some(cache) = model.get_mut("codexCache") {
        normalize_aliases(cache, "cache");
    }
}

fn is_catalog_container(value: &Value) -> bool {
    value
        .as_object()
        .and_then(|object| object.get("models"))
        .is_some_and(Value::is_array)
}

/// Read the one authoritative Codex catalog representation.
///
/// `modelCatalog` wins when it is structurally valid, including an explicit
/// empty `models` array. The legacy key is only a recovery path for absent or
/// malformed canonical data.
pub(crate) fn read_catalog(settings: &Value) -> Option<&Value> {
    settings
        .get("modelCatalog")
        .filter(|catalog| is_catalog_container(catalog))
        .or_else(|| {
            settings
                .get("model_catalog")
                .filter(|catalog| is_catalog_container(catalog))
        })
}

pub(crate) fn read_catalog_mut(
    settings: &mut serde_json::Map<String, Value>,
) -> Option<&mut Value> {
    let key = if settings
        .get("modelCatalog")
        .is_some_and(is_catalog_container)
    {
        "modelCatalog"
    } else if settings
        .get("model_catalog")
        .is_some_and(is_catalog_container)
    {
        "model_catalog"
    } else {
        return None;
    };
    settings.get_mut(key)
}

pub(crate) fn catalog_models(settings: &Value) -> Option<&[Value]> {
    read_catalog(settings)?
        .get("models")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum CatalogModelLookup<'a> {
    Missing,
    Found(&'a Value),
    Ambiguous,
}

/// Select the same catalog row for exclusion, capability, and product settings.
/// Public model/id matches outrank aliases; either tier must identify one row.
pub(crate) fn lookup_catalog_model<'a>(
    settings: &'a Value,
    model: &str,
) -> CatalogModelLookup<'a> {
    let model = model.trim();
    if model.is_empty() {
        return CatalogModelLookup::Missing;
    }
    let Some(models) = catalog_models(settings) else {
        return CatalogModelLookup::Missing;
    };
    let exact = unique_model_match(models.iter().filter(|entry| {
        model_identity_matches(entry, model, &["model", "id"])
    }));
    if !matches!(exact, CatalogModelLookup::Missing) {
        return exact;
    }
    unique_model_match(
        models
            .iter()
            .filter(|entry| fallback_model_identity_matches(entry, model)),
    )
}

fn unique_model_match<'a>(
    mut entries: impl Iterator<Item = &'a Value>,
) -> CatalogModelLookup<'a> {
    let Some(entry) = entries.next() else {
        return CatalogModelLookup::Missing;
    };
    if entries.next().is_some() {
        CatalogModelLookup::Ambiguous
    } else {
        CatalogModelLookup::Found(entry)
    }
}

fn model_identity_matches(entry: &Value, model: &str, fields: &[&str]) -> bool {
    fields
        .iter()
        .filter_map(|field| entry.get(*field).and_then(Value::as_str))
        .any(|candidate| candidate.trim().eq_ignore_ascii_case(model))
}

fn fallback_model_identity_matches(entry: &Value, model: &str) -> bool {
    model_identity_matches(
        entry,
        model,
        &[
            "slug",
            "canonicalSlug",
            "canonical_slug",
            "upstreamModel",
            "upstream_model",
            "name",
        ],
    ) || ["aliases", "alias"]
        .iter()
        .any(|field| match entry.get(*field) {
            Some(Value::Array(values)) => values
                .iter()
                .filter_map(Value::as_str)
                .any(|candidate| candidate.trim().eq_ignore_ascii_case(model)),
            Some(Value::Object(values)) => values
                .keys()
                .map(String::as_str)
                .chain(values.values().filter_map(Value::as_str))
                .any(|candidate| candidate.trim().eq_ignore_ascii_case(model)),
            _ => false,
        })
}

pub(crate) fn normalize_settings(settings: &mut Value) {
    let selected_catalog = read_catalog(settings).cloned();
    normalize_aliases(settings, "settings");
    normalize_capability_fields(settings);
    let Some(mut catalog) = selected_catalog.or_else(|| settings.get("modelCatalog").cloned())
    else {
        return;
    };
    normalize_aliases(&mut catalog, "catalog");
    if let Some(models) = catalog.get_mut("models").and_then(Value::as_array_mut) {
        for model in models {
            normalize_model(model);
        }
    }
    settings["modelCatalog"] = catalog;
    settings
        .as_object_mut()
        .expect("settings is an object after normalization")
        .remove("model_catalog");
}

pub(crate) fn parse_context_window(value: &Value) -> Option<u64> {
    let result = if let Some(number) = value.as_u64() {
        number
    } else {
        let token = value.as_str()?.trim().to_ascii_lowercase();
        let (digits, multiplier) = if let Some(digits) = token.strip_suffix('k') {
            (digits.trim(), 1000)
        } else if let Some(digits) = token.strip_suffix('m') {
            (digits.trim(), 1_000_000)
        } else {
            (token.strip_suffix("tokens").unwrap_or(&token).trim(), 1)
        };
        if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        digits.parse::<u64>().ok()?.checked_mul(multiplier)?
    };
    (result > 0 && result <= 9_007_199_254_740_991).then_some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{database::Database, provider::Provider};
    use serde_json::json;

    #[test]
    fn canonical_empty_catalog_wins_over_stale_legacy_catalog() {
        let settings = json!({
            "modelCatalog": {"models": []},
            "model_catalog": {"models": [{"model": "removed-model"}]}
        });

        let catalog = read_catalog(&settings).expect("canonical catalog");
        assert_eq!(catalog["models"], json!([]));
        assert!(catalog_models(&settings).expect("models").is_empty());
    }

    #[test]
    fn malformed_canonical_catalog_falls_back_to_legacy_catalog() {
        let settings = json!({
            "modelCatalog": {"models": "invalid"},
            "model_catalog": {"models": [{"model": "legacy-model"}]}
        });

        let models = catalog_models(&settings).expect("legacy models");
        assert_eq!(models[0]["model"], "legacy-model");
    }

    #[test]
    fn mutable_reader_preserves_canonical_authority() {
        for canonical in [
            json!({"models": []}),
            json!({"models": [{"model": "kept"}]}),
        ] {
            let mut settings = json!({
                "modelCatalog": canonical,
                "model_catalog": {"models": [{"model": "removed-model"}]}
            });
            read_catalog_mut(settings.as_object_mut().unwrap()).unwrap()["enabled"] = json!(true);
            assert_eq!(settings["modelCatalog"]["enabled"], json!(true));
            assert!(settings["model_catalog"].get("enabled").is_none());
        }
    }

    #[test]
    fn mutable_reader_uses_only_a_structurally_valid_fallback() {
        let mut settings = json!({
            "modelCatalog": {"models": null},
            "model_catalog": {"models": []}
        });
        read_catalog_mut(settings.as_object_mut().unwrap()).unwrap()["enabled"] = json!(true);
        assert_eq!(settings["model_catalog"]["enabled"], json!(true));
        settings["model_catalog"]["models"] = json!(null);
        assert!(read_catalog_mut(settings.as_object_mut().unwrap()).is_none());
    }

    #[test]
    fn model_lookup_prefers_exact_public_identity_over_broad_siblings() {
        for public_field in ["model", "id"] {
            for fallback in [
                json!({"upstreamModel": "wire"}),
                json!({"canonicalSlug": "wire"}),
                json!({"name": "wire"}),
                json!({"aliases": ["wire"]}),
                json!({"alias": {"wire": "sibling"}}),
            ] {
                let mut sibling = fallback;
                sibling["model"] = json!("sibling");
                let mut exact = json!({"enabled": true});
                exact[public_field] = json!("wire");
                for rows in [
                    vec![sibling.clone(), exact.clone()],
                    vec![exact.clone(), sibling.clone()],
                ] {
                    let settings = json!({"modelCatalog": {"models": rows}});
                    assert_eq!(
                        lookup_catalog_model(&settings, " WIRE "),
                        CatalogModelLookup::Found(&exact)
                    );
                }
            }
        }
    }

    #[test]
    fn model_lookup_requires_unique_identity_in_the_selected_tier() {
        for field in ["model", "id", "upstreamModel", "canonicalSlug", "name"] {
            let mut first = json!({"model": "first"});
            first[field] = json!("shared");
            let mut second = json!({"model": "second", "enabled": false});
            second[field] = json!(" SHARED ");
            let settings = json!({"modelCatalog": {"models": [first, second]}});
            assert_eq!(
                lookup_catalog_model(&settings, "shared"),
                CatalogModelLookup::Ambiguous
            );
        }
        for aliases in [
            json!({"aliases": ["shared"]}),
            json!({"alias": {"shared": "wire"}}),
        ] {
            let mut first = aliases.clone();
            first["model"] = json!("first");
            let mut second = aliases;
            second["model"] = json!("second");
            let settings = json!({"modelCatalog": {"models": [first, second]}});
            assert_eq!(
                lookup_catalog_model(&settings, "shared"),
                CatalogModelLookup::Ambiguous
            );
        }
    }

    #[test]
    fn model_lookup_preserves_catalog_authority_and_rejects_blank_identities() {
        let mut settings = json!({
            "modelCatalog": {"models": []},
            "model_catalog": {"models": [{"model": "legacy"}]}
        });
        assert_eq!(
            lookup_catalog_model(&settings, "legacy"),
            CatalogModelLookup::Missing
        );
        settings["modelCatalog"] = json!({"models": null});
        assert!(matches!(
            lookup_catalog_model(&settings, "legacy"),
            CatalogModelLookup::Found(_)
        ));
        settings["modelCatalog"] = json!({"models": [{"model": " ", "aliases": [""]}]});
        assert_eq!(
            lookup_catalog_model(&settings, " "),
            CatalogModelLookup::Missing
        );
    }

    #[test]
    fn shared_catalogue_contract_is_idempotent_and_round_trips_sqlite() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/codexCatalogNormalization.json"
        ))
        .expect("fixtures");
        let db = Database::memory().expect("database");
        for fixture in fixtures.as_array().expect("fixture array") {
            let mut normalized = fixture["input"].clone();
            normalize_settings(&mut normalized);
            assert_eq!(normalized, fixture["expected"], "{}", fixture["name"]);
            normalize_settings(&mut normalized);
            assert_eq!(
                normalized, fixture["expected"],
                "normalization must be idempotent"
            );
            let provider = Provider::with_id(
                "canonical".into(),
                "Canonical".into(),
                fixture["input"].clone(),
                None,
            );
            db.save_provider("codex", &provider).expect("save");
            {
                let conn = db.conn.lock().expect("connection");
                let raw: String = conn
                    .query_row(
                        "SELECT settings_config FROM providers WHERE id = 'canonical' AND app_type = 'codex'",
                        [],
                        |row| row.get(0),
                    )
                    .expect("stored settings");
                assert_eq!(
                    serde_json::from_str::<Value>(&raw).expect("stored JSON"),
                    fixture["expected"],
                    "canonicalization must happen on write, not just on read"
                );
            }
            let saved = db
                .get_provider_by_id("canonical", "codex")
                .expect("read")
                .expect("provider");
            assert_eq!(saved.settings_config, fixture["expected"]);
            db.update_provider_settings_config("codex", "canonical", &fixture["input"])
                .expect("direct update");
            assert_eq!(
                db.get_all_providers("codex").expect("all")["canonical"].settings_config,
                fixture["expected"]
            );
            db.save_provider("claude", &provider)
                .expect("non-Codex save");
            assert_eq!(
                db.get_provider_by_id("canonical", "claude")
                    .expect("read Claude")
                    .expect("provider")
                    .settings_config,
                fixture["input"],
                "other app schemas must not be rewritten"
            );
        }
    }
}
