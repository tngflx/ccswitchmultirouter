//! Internal catalogue normalization. Native provider/Codex descriptor adapters stay at the edges.
use crate::provider::Provider;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};

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
    models_in_catalog(read_catalog(settings)?)
}

fn models_in_catalog(catalog: &Value) -> Option<&[Value]> {
    catalog.get("models")?.as_array().map(Vec::as_slice)
}

fn shared_provider_catalog(provider: &Provider) -> Option<&SharedCodexCatalog> {
    provider.meta.as_ref()?.runtime_codex_catalog.as_deref()
}

pub(crate) fn read_provider_catalog(provider: &Provider) -> Option<&Value> {
    shared_provider_catalog(provider)
        .map(|catalog| &catalog.value)
        .or_else(|| read_catalog(&provider.settings_config))
}

pub(crate) fn provider_catalog_models(provider: &Provider) -> Option<&[Value]> {
    models_in_catalog(read_provider_catalog(provider)?)
}

/// Resolve whether a provider's catalog should be projected into Codex live
/// settings. Runtime route providers keep the catalog in the materialized
/// shared snapshot, so the legacy metadata fallback must consult the same
/// provider-aware reader after the settings field has been moved out.
pub(crate) fn provider_catalog_projection_enabled(provider: &Provider) -> bool {
    let Some(meta) = provider.meta.as_ref() else {
        return read_provider_catalog(provider).is_some();
    };
    if meta.codex_model_catalog_projection_enabled(&provider.settings_config) {
        return true;
    }
    meta.codex_local_model_mapping.is_none() && read_provider_catalog(provider).is_some()
}

pub(crate) fn lookup_provider_catalog_model<'a>(
    provider: &'a Provider,
    model: &str,
) -> CatalogModelLookup<'a> {
    if let Some(catalog) = shared_provider_catalog(provider) {
        catalog.index.lookup(catalog.models(), model)
    } else {
        lookup_catalog_model(&provider.settings_config, model)
    }
}

/// The canonical inventory captured by a compiled route snapshot.
#[derive(Debug)]
pub struct SharedCodexCatalog {
    value: Value,
    index: Arc<CatalogIdentityIndex>,
}

impl SharedCodexCatalog {
    fn models(&self) -> &[Value] {
        models_in_catalog(&self.value).unwrap_or_default()
    }
}

/// Move the canonical catalog out of a target loaded for the runtime plan.
/// Called only after compilation has consumed the original provider settings.
pub(crate) fn share_provider_catalog(provider: &mut Provider) {
    let Some(settings) = provider.settings_config.as_object_mut() else {
        return;
    };
    let catalog = read_catalog_mut(settings).map(std::mem::take);
    settings.remove("modelCatalog");
    settings.remove("model_catalog");
    if let Some(value) = catalog {
        let index = Arc::new(CatalogIdentityIndex::new(
            models_in_catalog(&value).unwrap_or_default(),
        ));
        provider
            .meta
            .get_or_insert_with(Default::default)
            .runtime_codex_catalog = Some(Arc::new(SharedCodexCatalog { value, index }));
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum CatalogModelLookup<'a> {
    Missing,
    Found(&'a Value),
    Ambiguous,
}

/// Borrow the canonical inventory for consumers doing multiple lookups.
/// The exact and fallback tiers have the same ownership rules as a scan.
#[derive(Default)]
pub(crate) struct CatalogModelIndex<'a> {
    rows: &'a [Value],
    index: Arc<CatalogIdentityIndex>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CatalogRowOwner {
    Unique(usize),
    Ambiguous,
}

#[derive(Clone, Debug, Default)]
struct CatalogIdentityIndex {
    exact: HashMap<String, CatalogRowOwner>,
    fallback: HashMap<String, CatalogRowOwner>,
    public_models: HashSet<String>,
}

impl<'a> CatalogModelIndex<'a> {
    pub(crate) fn new(settings: &'a Value) -> Self {
        let rows = catalog_models(settings).unwrap_or_default();
        Self {
            rows,
            index: Arc::new(CatalogIdentityIndex::new(rows)),
        }
    }

    pub(crate) fn for_provider(provider: &'a Provider) -> Self {
        if let Some(catalog) = shared_provider_catalog(provider) {
            return Self {
                rows: catalog.models(),
                index: Arc::clone(&catalog.index),
            };
        }
        let rows = provider_catalog_models(provider).unwrap_or_default();
        Self {
            rows,
            index: Arc::new(CatalogIdentityIndex::new(rows)),
        }
    }

    pub(crate) fn lookup(&self, model: &str) -> CatalogModelLookup<'a> {
        self.index.lookup(self.rows, model)
    }

    pub(crate) fn has_public_model(&self, model: &str) -> bool {
        !model.trim().is_empty()
            && self
                .index
                .public_models
                .contains(&model.trim().to_ascii_lowercase())
    }
}

impl CatalogIdentityIndex {
    fn new(rows: &[Value]) -> Self {
        let mut index = Self::default();
        for (position, row) in rows.iter().enumerate() {
            #[cfg(test)]
            track_catalog_row_visit();
            for identity in model_identities(row, &["model", "id"]) {
                Self::insert(&mut index.exact, identity, position);
            }
            if let Some(model) = row.get("model").and_then(Value::as_str) {
                index
                    .public_models
                    .insert(model.trim().to_ascii_lowercase());
            }
            if !is_generated_api_key_group_model(row) {
                for identity in fallback_model_identities(row) {
                    Self::insert(&mut index.fallback, identity, position);
                }
            }
        }
        index
    }

    fn insert(index: &mut HashMap<String, CatalogRowOwner>, identity: &str, position: usize) {
        let identity = identity.trim();
        if identity.is_empty() {
            return;
        }
        let owner = index
            .entry(identity.to_ascii_lowercase())
            .or_insert(CatalogRowOwner::Unique(position));
        if *owner != CatalogRowOwner::Unique(position) {
            *owner = CatalogRowOwner::Ambiguous;
        }
    }

    fn lookup<'a>(&self, rows: &'a [Value], model: &str) -> CatalogModelLookup<'a> {
        let key = model.trim().to_ascii_lowercase();
        match self.exact.get(&key).or_else(|| self.fallback.get(&key)) {
            Some(CatalogRowOwner::Unique(position)) => CatalogModelLookup::Found(&rows[*position]),
            Some(CatalogRowOwner::Ambiguous) => CatalogModelLookup::Ambiguous,
            None => CatalogModelLookup::Missing,
        }
    }
}

#[cfg(test)]
thread_local! {
    static CATALOG_ROW_VISITS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn track_catalog_row_visit() {
    CATALOG_ROW_VISITS.with(|visits| visits.set(visits.get() + 1));
}

#[cfg(test)]
pub(crate) fn take_catalog_row_visits() -> usize {
    CATALOG_ROW_VISITS.with(|visits| visits.replace(0))
}

/// Select the same catalog row for exclusion, capability, and product settings.
/// Public model/id matches outrank aliases; either tier must identify one row.
/// Generated key-group rows own only their public identities, not inherited base aliases.
pub(crate) fn lookup_catalog_model<'a>(settings: &'a Value, model: &str) -> CatalogModelLookup<'a> {
    let model = model.trim();
    if model.is_empty() {
        return CatalogModelLookup::Missing;
    }
    let Some(models) = catalog_models(settings) else {
        return CatalogModelLookup::Missing;
    };
    let exact = unique_model_match(models.iter().filter(|entry| {
        #[cfg(test)]
        track_catalog_row_visit();
        model_identities(entry, &["model", "id"])
            .any(|identity| identity.trim().eq_ignore_ascii_case(model))
    }));
    if !matches!(exact, CatalogModelLookup::Missing) {
        return exact;
    }
    unique_model_match(models.iter().filter(|entry| {
        #[cfg(test)]
        track_catalog_row_visit();
        !is_generated_api_key_group_model(entry)
            && fallback_model_identities(entry)
                .any(|identity| identity.trim().eq_ignore_ascii_case(model))
    }))
}

fn unique_model_match<'a>(mut entries: impl Iterator<Item = &'a Value>) -> CatalogModelLookup<'a> {
    let Some(entry) = entries.next() else {
        return CatalogModelLookup::Missing;
    };
    if entries.next().is_some() {
        CatalogModelLookup::Ambiguous
    } else {
        CatalogModelLookup::Found(entry)
    }
}

fn model_identities<'a>(
    entry: &'a Value,
    fields: &'static [&'static str],
) -> impl Iterator<Item = &'a str> {
    fields
        .iter()
        .filter_map(move |field| entry.get(*field).and_then(Value::as_str))
}

/// Generated picker rows inherit their base model's metadata but cannot claim
/// those fallback identities. Keep recognition aligned with the frontend's
/// shared key-group predicate, including marker-only legacy rows.
fn is_generated_api_key_group_model(entry: &Value) -> bool {
    ["apiKeyGroupGenerated", "api_key_group_generated"]
        .iter()
        .any(|field| entry.get(*field).and_then(Value::as_bool) == Some(true))
        || ["apiKeyGroupId", "api_key_group_id"]
            .iter()
            .filter_map(|field| entry.get(*field).and_then(Value::as_str))
            .any(|group_id| !group_id.is_empty())
        || entry
            .get("model")
            .and_then(Value::as_str)
            .is_some_and(|model| model.to_ascii_lowercase().contains("--ccg-"))
}
fn fallback_model_identities(entry: &Value) -> impl Iterator<Item = &str> {
    model_identities(
        entry,
        &[
            "slug",
            "canonicalSlug",
            "canonical_slug",
            "upstreamModel",
            "upstream_model",
            "name",
        ],
    )
    .chain(["aliases", "alias"].into_iter().flat_map(move |field| {
        let value = entry.get(field);
        value
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .chain(
                value
                    .and_then(Value::as_object)
                    .into_iter()
                    .flatten()
                    .flat_map(|(key, value)| std::iter::once(key.as_str()).chain(value.as_str())),
            )
    }))
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
    fn materialized_provider_reuses_shared_catalog_for_projection_and_index() {
        let _ = take_catalog_row_visits();
        let mut provider = Provider::with_id(
            "runtime-provider".into(),
            "Runtime provider".into(),
            json!({
                "modelCatalog": {
                    "models": [{"model": "runtime-model", "upstreamModel": "wire-model"}]
                }
            }),
            None,
        );

        share_provider_catalog(&mut provider);
        assert!(provider.settings_config.get("modelCatalog").is_none());
        assert!(provider_catalog_projection_enabled(&provider));

        let built_rows = take_catalog_row_visits();
        assert_eq!(built_rows, 1);
        let index = CatalogModelIndex::for_provider(&provider);
        let shared_index = &provider
            .meta
            .as_ref()
            .and_then(|meta| meta.runtime_codex_catalog.as_ref())
            .expect("materialized catalog")
            .index;
        assert!(
            Arc::ptr_eq(&index.index, shared_index),
            "runtime provider projections must share the materialized identity index"
        );
        match index.lookup("wire-model") {
            CatalogModelLookup::Found(row) => assert_eq!(row["model"], "runtime-model"),
            other => panic!("unexpected catalog lookup result: {other:?}"),
        }
        assert_eq!(take_catalog_row_visits(), 0);

        provider.meta.as_mut().unwrap().codex_local_model_mapping = Some(false);
        assert!(!provider_catalog_projection_enabled(&provider));
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
    fn indexed_catalog_lookup_uses_the_same_owners_as_a_scan() {
        let settings = serde_json::json!({
            "modelCatalog":{"models":[
                {"model":"Exact", "enabled":false},
                {"model":"mapped", "upstreamModel":"exact", "alias":{"alias-key":"alias-value"}},
                {"model":"repeated", "id":"Repeated", "aliases":["Repeated alias","repeated alias"]},
                {"model":"first", "aliases":["ambiguous"]},
                {"model":"second", "upstreamModel":"Ambiguous"},
                {"model":"base--ccg-key", "upstreamModel":"inherited", "apiKeyGroupGenerated":true}
            ]},
            "model_catalog":{"models":[{"model":"stale"}]}
        });
        let index = CatalogModelIndex::new(&settings);
        for model in [
            " EXACT ",
            "mapped",
            "alias-key",
            "alias-value",
            "repeated",
            "repeated alias",
            "Ambiguous",
            "base--ccg-key",
            "inherited",
            "stale",
            " ",
        ] {
            assert_eq!(index.lookup(model), lookup_catalog_model(&settings, model));
        }
    }

    fn api_key_group_identity_fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../tests/fixtures/codexApiKeyGroupIdentity.json"
        ))
        .expect("shared generated key-group identity fixture")
    }

    #[test]
    fn model_lookup_keeps_base_identities_unique_beside_generated_key_group_rows() {
        let fixture = api_key_group_identity_fixture();
        for enabled in [true, false] {
            let mut base = fixture["baseModel"].clone();
            base["enabled"] = json!(enabled);
            for case in fixture["cases"].as_array().unwrap() {
                if case["generated"] != true {
                    continue;
                }
                let mut grouped = fixture["baseModel"].clone();
                grouped
                    .as_object_mut()
                    .unwrap()
                    .extend(case["row"].as_object().unwrap().clone());
                for rows in [
                    vec![base.clone(), grouped.clone()],
                    vec![grouped.clone(), base.clone()],
                ] {
                    let settings = json!({"modelCatalog": {"models": rows}});
                    for reference in fixture["bareReferences"].as_array().unwrap() {
                        let reference = reference.as_str().unwrap();
                        assert_eq!(
                            lookup_catalog_model(
                                &settings,
                                &format!(" {} ", reference.to_uppercase())
                            ),
                            CatalogModelLookup::Found(&base),
                            "case={} reference={reference} enabled={enabled}",
                            case["name"]
                        );
                    }
                    assert_eq!(
                        lookup_catalog_model(&settings, grouped["model"].as_str().unwrap()),
                        CatalogModelLookup::Found(&grouped),
                        "case={}",
                        case["name"]
                    );
                }
            }
        }
    }
    #[test]
    fn model_lookup_ignores_inherited_identities_on_lone_generated_key_group_rows() {
        let fixture = api_key_group_identity_fixture();
        for case in fixture["cases"].as_array().unwrap() {
            let mut model = fixture["baseModel"].clone();
            model
                .as_object_mut()
                .unwrap()
                .extend(case["row"].as_object().unwrap().clone());
            let settings = json!({"modelCatalog": {"models": [model.clone()]}});
            for reference in fixture["bareReferences"].as_array().unwrap() {
                let reference = reference.as_str().unwrap();
                let expected = if case["generated"] == true {
                    CatalogModelLookup::Missing
                } else {
                    CatalogModelLookup::Found(&model)
                };
                assert_eq!(
                    lookup_catalog_model(&settings, reference),
                    expected,
                    "case={} reference={reference}",
                    case["name"]
                );
            }
            assert_eq!(
                lookup_catalog_model(&settings, model["model"].as_str().unwrap()),
                CatalogModelLookup::Found(&model),
                "case={}",
                case["name"]
            );
        }
    }

    #[test]
    fn model_lookup_keeps_excluded_generated_public_model_and_id_authoritative() {
        let fixture = api_key_group_identity_fixture();
        for case in fixture["cases"].as_array().unwrap() {
            if case["generated"] != true {
                continue;
            }
            let mut excluded = fixture["baseModel"].clone();
            excluded
                .as_object_mut()
                .unwrap()
                .extend(case["row"].as_object().unwrap().clone());
            excluded["id"] = json!("generated-public-id");
            excluded["enabled"] = json!(false);
            let settings = json!({"modelCatalog": {"models": [
                {"model": "sibling", "upstreamModel": excluded["model"],
                 "aliases": ["generated-public-id"]},
                excluded.clone()
            ]}});
            for public in [excluded["model"].as_str().unwrap(), "generated-public-id"] {
                assert_eq!(
                    lookup_catalog_model(&settings, public),
                    CatalogModelLookup::Found(&excluded),
                    "case={} public={public}",
                    case["name"]
                );
            }
        }
    }

    #[test]
    fn model_lookup_keeps_canonical_empty_authority_for_generated_key_group_rows() {
        let fixture = api_key_group_identity_fixture();
        for case in fixture["cases"].as_array().unwrap() {
            if case["generated"] != true {
                continue;
            }
            let settings = json!({
                "modelCatalog": {"models": []},
                "model_catalog": {"models": [case["row"].clone()]}
            });
            assert_eq!(
                lookup_catalog_model(&settings, case["row"]["model"].as_str().unwrap()),
                CatalogModelLookup::Missing,
                "case={}",
                case["name"]
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
