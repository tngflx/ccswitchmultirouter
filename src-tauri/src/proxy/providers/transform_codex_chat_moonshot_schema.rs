//! JSON-Schema compatibility rewrite for Moonshot/Kimi Chat upstreams.

use serde_json::{Map, Value};
use url::Url;

const HOST_SUFFIXES: &[&str] = &["moonshot.cn", "moonshot.ai", "kimi.com"];
const MAP_KEYS: &[&str] = &[
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
    "dependencies",
];
const ARRAY_KEYS: &[&str] = &["allOf", "anyOf", "oneOf", "prefixItems"];
const SINGLE_KEYS: &[&str] = &[
    "items",
    "additionalItems",
    "unevaluatedItems",
    "contains",
    "additionalProperties",
    "unevaluatedProperties",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
    "contentSchema",
];

pub fn upstream_requires_ref_sibling_all_of(base_url: &str) -> bool {
    let Ok(url) = Url::parse(base_url.trim()) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    HOST_SUFFIXES.iter().any(|suffix| {
        host == *suffix
            || host
                .strip_suffix(suffix)
                .is_some_and(|prefix| prefix.ends_with('.'))
    })
}

pub fn wrap_ref_siblings_in_chat_tools(body: &mut Value) -> usize {
    let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) else {
        return 0;
    };
    tools
        .iter_mut()
        .filter_map(|tool| {
            tool.get_mut("function")
                .and_then(|function| function.get_mut("parameters"))
        })
        .map(wrap_ref_siblings)
        .filter(|count| *count > 0)
        .count()
}

pub fn wrap_ref_siblings(schema: &mut Value) -> usize {
    let Value::Object(map) = schema else { return 0 };
    let mut changed = 0;
    if map.len() > 1 && map.get("$ref").is_some_and(Value::is_string) {
        let reference = map.remove("$ref").expect("checked above");
        let branch = Value::Object(Map::from_iter([("$ref".to_string(), reference)]));
        match map.get_mut("allOf") {
            Some(Value::Array(branches)) => branches.push(branch),
            _ => {
                map.insert("allOf".to_string(), Value::Array(vec![branch]));
            }
        }
        changed += 1;
    }
    for (key, child) in map.iter_mut() {
        if MAP_KEYS.contains(&key.as_str()) {
            if let Value::Object(entries) = child {
                changed += entries.values_mut().map(wrap_ref_siblings).sum::<usize>();
            }
        } else if ARRAY_KEYS.contains(&key.as_str()) {
            if let Value::Array(entries) = child {
                changed += entries.iter_mut().map(wrap_ref_siblings).sum::<usize>();
            }
        } else if SINGLE_KEYS.contains(&key.as_str()) {
            match child {
                Value::Array(entries) => {
                    changed += entries.iter_mut().map(wrap_ref_siblings).sum::<usize>()
                }
                other => changed += wrap_ref_siblings(other),
            }
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matches_dns_boundaries() {
        assert!(upstream_requires_ref_sibling_all_of(
            "https://api.moonshot.cn/v1"
        ));
        assert!(upstream_requires_ref_sibling_all_of(
            "https://api.kimi.com/coding/v1"
        ));
        assert!(!upstream_requires_ref_sibling_all_of(
            "https://api.kimi.com.evil.test/v1"
        ));
        assert!(!upstream_requires_ref_sibling_all_of(
            "https://notmoonshot.cn/v1"
        ));
    }

    #[test]
    fn rewrites_nested_refs_idempotently() {
        let mut schema = json!({
            "type": "object",
            "properties": {"prompt": {"$ref": "#/$defs/P", "description": "prompt"}},
            "$defs": {"P": {"$ref": "#/$defs/S", "type": "string"}, "S": {"type": "string"}}
        });
        assert_eq!(wrap_ref_siblings(&mut schema), 2);
        assert_eq!(wrap_ref_siblings(&mut schema), 0);
        assert_eq!(
            schema["properties"]["prompt"]["allOf"][0]["$ref"],
            "#/$defs/P"
        );
        assert_eq!(schema["$defs"]["P"]["allOf"][0]["$ref"], "#/$defs/S");
    }

    #[test]
    fn rewrites_function_parameters_only() {
        let mut body = json!({
            "tools": [
                {"type": "function", "function": {"parameters": {"$ref": "#/$defs/A", "type": "object"}}},
                {"type": "web_search"}
            ]
        });
        assert_eq!(wrap_ref_siblings_in_chat_tools(&mut body), 1);
        assert!(body["tools"][0]["function"]["parameters"]["allOf"].is_array());
        assert_eq!(body["tools"][1], json!({"type": "web_search"}));
    }
}
