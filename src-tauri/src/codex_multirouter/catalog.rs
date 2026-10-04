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

pub(crate) fn normalize_settings(settings: &mut Value) {
    normalize_aliases(settings, "settings");
    normalize_capability_fields(settings);
    let Some(catalog) = settings.get_mut("modelCatalog") else {
        return;
    };
    normalize_aliases(catalog, "catalog");
    if let Some(models) = catalog.get_mut("models").and_then(Value::as_array_mut) {
        for model in models {
            normalize_model(model);
        }
    }
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
