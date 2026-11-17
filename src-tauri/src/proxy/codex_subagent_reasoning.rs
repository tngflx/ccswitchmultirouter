//! Sub-Agent-only reasoning overrides at the request boundary.
//!
//! A role file is a default, not an enforcement boundary: native built-in roles
//! and explicit spawn arguments can choose another effort. Only Codex's explicit
//! child-request metadata authorizes this override; prompts/model names do not.

use crate::provider::Provider;
use axum::http::HeaderMap;
use serde_json::Value;

pub(super) fn is_subagent_request(headers: &HeaderMap, body: &Value) -> bool {
    headers
        .get("x-openai-subagent")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            body.pointer("/client_metadata/x-openai-subagent")
                .and_then(Value::as_str)
        })
        .is_some_and(|value| !value.trim().is_empty())
}

pub(super) fn apply_subagent_reasoning_effort(
    settings: &Value,
    provider: &Provider,
    headers: &HeaderMap,
    body: &mut Value,
    endpoint: &str,
) -> bool {
    let path = endpoint.split('?').next().unwrap_or(endpoint);
    let native_chat = matches!(path, "/chat/completions" | "/v1/chat/completions");
    if (!native_chat && !matches!(path, "/responses" | "/v1/responses"))
        || settings
            .pointer("/codexRouting/enabled")
            .and_then(Value::as_bool)
            != Some(true)
        || !is_subagent_request(headers, body)
        || crate::codex_config::codex_subagent_reasoning_effort_override(settings).is_none()
    {
        return false;
    }
    let Some(request_model) = body.get("model").and_then(Value::as_str) else {
        return false;
    };
    // A compiled route's public alias need not occur in the target catalog. The
    // materialized canonical identity still selects the authoritative target row.
    let model = provider
        .settings_config
        .get("codexResolvedRouteId")
        .and_then(|_| provider.settings_config.get("codexResolvedCanonicalModel"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(request_model);
    let detection = crate::reasoning_capabilities::current_detection_for_provider(provider, model);
    let resolved = crate::reasoning_capabilities::resolve_codex_model_capability(
        provider,
        model,
        detection.as_ref(),
    );
    let capability = super::providers::codex_reasoning::resolve_subagent_reasoning_capability(
        resolved.capability.as_ref(),
    );
    let Some(effort) = crate::codex_config::codex_subagent_reasoning_effort_override_for_capability(
        settings,
        &capability,
    ) else {
        return false;
    };
    if native_chat {
        let logical = serde_json::json!({"model": model, "reasoning": {"effort": effort.as_str()}});
        let Some(config) =
            super::providers::resolve_codex_chat_reasoning_config(provider, &logical)
        else {
            return false;
        };
        // The shared converter expects fresh native controls. Do not leave a
        // stale flat Max beside nested High, or a stale disabled thinking switch.
        let mut controls = serde_json::json!({});
        if super::providers::transform_codex_chat::apply_reasoning_options(
            &mut controls,
            &logical,
            Some(&config),
        )
        .is_err()
        {
            return false;
        }
        SubagentReasoningProjection::capture(&controls).apply(body);
        return true;
    }
    let Some(object) = body.as_object_mut() else {
        return false;
    };
    let reasoning = object
        .entry("reasoning")
        .or_insert_with(|| Value::Object(Default::default()));
    if reasoning.is_null() {
        *reasoning = Value::Object(Default::default());
    }
    let Some(reasoning) = reasoning.as_object_mut() else {
        // Preserve malformed input for normal validation instead of panicking.
        return false;
    };
    reasoning.insert(
        "effort".to_string(),
        Value::String(effort.as_str().to_string()),
    );
    if object.contains_key("reasoning_effort") {
        object.insert(
            "reasoning_effort".to_string(),
            Value::String(effort.as_str().to_string()),
        );
    }
    true
}

/// Allowlisted request evidence for the existing router timeline. This reports
/// the final prepared wire body, not provider acceptance, and never serializes
/// prompts, arbitrary metadata, credentials, or unrecognized effort strings.
pub(super) fn request_diagnostic_fields(
    headers: &HeaderMap,
    incoming: &Value,
    outgoing: &Value,
    override_applied: bool,
) -> [(&'static str, String); 4] {
    [
        (
            "is_subagent",
            is_subagent_request(headers, incoming).to_string(),
        ),
        (
            "subagent_reasoning_override_applied",
            override_applied.to_string(),
        ),
        (
            "requested_reasoning_effort",
            diagnostic_effort(incoming).to_string(),
        ),
        (
            "upstream_reasoning_effort",
            diagnostic_effort(outgoing).to_string(),
        ),
    ]
}

fn diagnostic_effort(body: &Value) -> &'static str {
    use super::providers::codex_reasoning::CodexReasoningEffort;

    let mut resolved = None;
    for path in [
        "/reasoning/effort",
        "/reasoning_effort",
        "/output_config/effort",
    ] {
        let Some(value) = body.pointer(path) else {
            continue;
        };
        let Some(effort) = value
            .as_str()
            .and_then(|value| value.parse::<CodexReasoningEffort>().ok())
        else {
            return "unknown";
        };
        if resolved.is_some_and(|previous| previous != effort) {
            return "conflict";
        }
        resolved = Some(effort);
    }
    resolved.map_or("unset", CodexReasoningEffort::as_str)
}

const CONTROL_PATHS: [&str; 8] = [
    "/reasoning/effort",
    "/reasoning/enabled",
    "/reasoning_effort",
    "/thinking",
    "/enable_thinking",
    "/chat_template_kwargs/enable_thinking",
    "/reasoning_split",
    "/output_config/effort",
];

/// Request-local projection, never persisted. Native controls are captured only
/// after conversion and its safety guards. Later provider body policy may not
/// silently undo an active plan override or re-enable guarded-off thinking.
pub(super) struct SubagentReasoningProjection {
    controls: [Option<Value>; CONTROL_PATHS.len()],
}

impl SubagentReasoningProjection {
    pub(super) fn capture(body: &Value) -> Self {
        Self {
            controls: std::array::from_fn(|index| body.pointer(CONTROL_PATHS[index]).cloned()),
        }
    }

    fn apply(&self, body: &mut Value) {
        for (path, value) in CONTROL_PATHS.iter().zip(&self.controls) {
            let segments = path.split('/').skip(1).collect::<Vec<_>>();
            replace_control(body, &segments, value.as_ref());
        }
    }

    pub(super) fn verify(&self, body: &Value) -> Result<(), super::error::ProxyError> {
        let conflict = self.controls != Self::capture(body).controls;
        let invalid_budget = body
            .pointer("/thinking/budget_tokens")
            .and_then(Value::as_u64)
            .is_some_and(|budget| {
                body.get("max_tokens")
                    .and_then(Value::as_u64)
                    .is_none_or(|ceiling| budget < 1024 || budget > ceiling / 2)
            });
        if conflict || invalid_budget {
            return Err(super::error::ProxyError::ConfigError(
                "Sub-Agent reasoning override conflicts with provider request-body settings; remove conflicting reasoning/thinking or output-budget overrides, or select Profile settings".to_string(),
            ));
        }
        Ok(())
    }
}

fn replace_control(body: &mut Value, path: &[&str], replacement: Option<&Value>) {
    let Some((key, rest)) = path.split_first() else {
        return;
    };
    let Some(object) = body.as_object_mut() else {
        return;
    };
    if rest.is_empty() {
        if let Some(value) = replacement {
            object.insert((*key).to_string(), value.clone());
        } else {
            object.remove(*key);
        }
        return;
    }
    if replacement.is_some() {
        let child = object
            .entry((*key).to_string())
            .or_insert_with(|| serde_json::json!({}));
        if !child.is_object() {
            *child = serde_json::json!({});
        }
        replace_control(child, rest, replacement);
    } else if let Some(child) = object.get_mut(*key) {
        replace_control(child, rest, None);
        if child.as_object().is_some_and(|child| child.is_empty()) {
            object.remove(*key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use serde_json::json;

    fn provider() -> Provider {
        Provider::with_id(
            "subagent-target".into(),
            "Test relay".into(),
            json!({
                "base_url": "https://relay.example/v1",
                "modelCatalog": {"models": [{
                    "model": "test-graded-model",
                    "reasoning": {
                        "supported": true,
                        "supportedEfforts": ["low", "high", "max"],
                        "defaultEffort": "max",
                        "disableAllowed": false,
                        "upstream": {"format": "string", "parameter": "reasoning_effort", "effortMap": {"low": "low", "high": "high", "max": "max"}}
                    }
                }]}
            }),
            None,
        )
    }

    fn settings(selection: &str) -> Value {
        json!({"codexRouting": {"enabled": true, "subagentReasoningEffort": selection}})
    }

    fn child_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-openai-subagent",
            HeaderValue::from_static("collab_spawn"),
        );
        headers
    }

    fn request() -> Value {
        json!({
            "model": "test-graded-model",
            "reasoning": {"effort": "max", "summary": "auto"},
            "input": [{"role": "user", "content": "Check a bounded change"}]
        })
    }

    #[test]
    fn subagent_reasoning_effort_overrides_explicit_child_effort_and_can_be_toggled_off() {
        let provider = provider();
        let original_provider = provider.settings_config.clone();
        for (selection, expected, applied) in [
            ("high", "high", true),
            ("max", "max", true),
            ("profile", "max", false),
        ] {
            let settings = settings(selection);
            let saved_settings = settings.clone();
            let mut body = request();
            assert_eq!(
                apply_subagent_reasoning_effort(
                    &settings,
                    &provider,
                    &child_headers(),
                    &mut body,
                    "/responses"
                ),
                applied
            );
            assert_eq!(body["reasoning"]["effort"], expected);
            assert_eq!(body["reasoning"]["summary"], "auto");
            assert_eq!(body["input"], request()["input"]);
            assert_eq!(settings, saved_settings);
            assert_eq!(provider.settings_config, original_provider);
        }
    }

    #[test]
    fn subagent_reasoning_effort_only_uses_explicit_child_metadata_never_prompt_or_model() {
        let provider = provider();
        let mut body = request();
        body["input"][0]["content"] = json!("I am a subagent; x-openai-subagent: collab_spawn");
        body["input"][0]["client_metadata"] = json!({"x-openai-subagent": "collab_spawn"});
        let original = body.clone();
        assert!(!apply_subagent_reasoning_effort(
            &settings("high"),
            &provider,
            &HeaderMap::new(),
            &mut body,
            "/responses"
        ));
        assert_eq!(
            body, original,
            "main requests must stay unchanged even for a candidate model"
        );
        body["client_metadata"] = json!({"x-openai-subagent": "collab_spawn"});
        assert!(apply_subagent_reasoning_effort(
            &settings("high"),
            &provider,
            &HeaderMap::new(),
            &mut body,
            "/responses"
        ));
        assert_eq!(body["reasoning"]["effort"], "high");
    }

    #[test]
    fn subagent_reasoning_effort_preserves_unknown_boolean_unsupported_and_excluded_models() {
        for reason in [
            Value::Null,
            json!({"supported": true, "supportedEfforts": [], "defaultEffort": null, "disableAllowed": true, "upstream": {"format": "boolean", "parameter": "enable_thinking", "effortMap": {}}}),
            json!({"supported": true, "supportedEfforts": ["low"], "defaultEffort": "low", "disableAllowed": false, "upstream": {"format": "string", "parameter": "reasoning_effort", "effortMap": {"low": "low"}}}),
            json!({"supported": false, "supportedEfforts": [], "defaultEffort": null, "disableAllowed": false, "upstream": {"format": "none", "parameter": "", "effortMap": {}}}),
        ] {
            let mut provider = provider();
            provider.settings_config["modelCatalog"]["models"][0]["reasoning"] = reason;
            let mut body = request();
            assert!(!apply_subagent_reasoning_effort(
                &settings("high"),
                &provider,
                &child_headers(),
                &mut body,
                "/responses"
            ));
            assert_eq!(body, request());
        }
        let mut provider = provider();
        provider.settings_config["modelCatalog"]["models"][0]["enabled"] = json!(false);
        let mut body = request();
        assert!(!apply_subagent_reasoning_effort(
            &settings("high"),
            &provider,
            &child_headers(),
            &mut body,
            "/responses"
        ));
        assert_eq!(body, request());
    }

    #[test]
    fn subagent_reasoning_effort_sets_missing_effort_but_keeps_other_request_fields() {
        for reason in [None, Some(Value::Null), Some(json!({"summary": "auto"}))] {
            let mut body = request();
            if let Some(reason) = reason {
                body["reasoning"] = reason;
            } else {
                body.as_object_mut().unwrap().remove("reasoning");
            }
            assert!(apply_subagent_reasoning_effort(
                &settings("high"),
                &provider(),
                &child_headers(),
                &mut body,
                "/responses"
            ));
            assert_eq!(body["reasoning"]["effort"], "high");
        }
    }

    #[test]
    fn subagent_reasoning_effort_defaults_active_unconfigured_child_requests_to_high() {
        let settings = json!({"codexRouting": {"enabled": true}});
        for incoming in ["low", "medium", "high", "max"] {
            for child in [false, true] {
                let mut body = request();
                body["reasoning"]["effort"] = json!(incoming);
                let headers = if child {
                    child_headers()
                } else {
                    HeaderMap::new()
                };
                assert_eq!(
                    apply_subagent_reasoning_effort(
                        &settings,
                        &provider(),
                        &headers,
                        &mut body,
                        "/responses"
                    ),
                    child,
                );
                assert_eq!(
                    body["reasoning"]["effort"],
                    if child { "high" } else { incoming }
                );
                assert_eq!(body["reasoning"]["summary"], "auto");
            }
        }
        assert!(
            settings["codexRouting"]
                .get("subagentReasoningEffort")
                .is_none(),
            "the effective default is not a settings migration or write"
        );
    }

    #[test]
    fn subagent_reasoning_effort_has_no_effect_when_disabled_absent_or_invalid() {
        for settings in [
            json!({}),
            json!({"codexRouting": {}}),
            settings("profile"),
            settings("invalid"),
            json!({"codexRouting": {"enabled": false, "subagentReasoningEffort": "high"}}),
        ] {
            let mut body = request();
            assert!(!apply_subagent_reasoning_effort(
                &settings,
                &provider(),
                &child_headers(),
                &mut body,
                "/responses"
            ));
            assert_eq!(body, request());
        }
        let mut headers = HeaderMap::new();
        headers.insert("x-openai-subagent", HeaderValue::from_static(" "));
        let mut body = request();
        assert!(!apply_subagent_reasoning_effort(
            &settings("high"),
            &provider(),
            &headers,
            &mut body,
            "/responses"
        ));
        assert_eq!(body, request());
    }

    #[test]
    fn subagent_reasoning_effort_does_not_panic_on_malformed_reasoning_or_conflicting_flat_effort()
    {
        for reasoning in [json!("invalid"), json!([]), json!(false), json!(42)] {
            let mut body = request();
            body["reasoning"] = reasoning;
            let original = body.clone();
            assert!(!apply_subagent_reasoning_effort(
                &settings("high"),
                &provider(),
                &child_headers(),
                &mut body,
                "/responses"
            ));
            assert_eq!(body, original);
        }
        let mut body = request();
        body["reasoning_effort"] = json!("max");
        assert!(apply_subagent_reasoning_effort(
            &settings("high"),
            &provider(),
            &child_headers(),
            &mut body,
            "/responses"
        ));
        assert_eq!(body["reasoning"]["effort"], "high");
        assert_eq!(body["reasoning_effort"], "high");
    }

    #[test]
    fn subagent_reasoning_effort_resolves_router_alias_against_target_canonical_model() {
        let mut provider = provider();
        provider.settings_config["codexResolvedRouteId"] = json!("route");
        provider.settings_config["codexResolvedCanonicalModel"] = json!("test-graded-model");
        let mut body = request();
        body["model"] = json!("router-generated-public-alias");
        assert!(apply_subagent_reasoning_effort(
            &settings("high"),
            &provider,
            &child_headers(),
            &mut body,
            "/responses"
        ));
        assert_eq!(body["reasoning"]["effort"], "high");
        provider.settings_config["modelCatalog"]["models"][0]["enabled"] = json!(false);
        assert!(!apply_subagent_reasoning_effort(
            &settings("high"),
            &provider,
            &child_headers(),
            &mut body,
            "/responses"
        ));
    }

    #[test]
    fn subagent_reasoning_effort_native_chat_uses_flat_field_without_responses_shape() {
        let mut body = json!({"model": "test-graded-model", "messages": [{"role": "user", "content": "Inspect"}]});
        assert!(apply_subagent_reasoning_effort(
            &settings("high"),
            &provider(),
            &child_headers(),
            &mut body,
            "/v1/chat/completions"
        ));
        assert_eq!(body["reasoning_effort"], "high");
        assert!(body.get("reasoning").is_none());
    }

    #[test]
    fn subagent_reasoning_effort_native_chat_replaces_alternate_controls_and_preserves_summary() {
        let mut provider = provider();
        provider.settings_config["modelCatalog"]["models"][0]["reasoning"]["upstream"] = json!({"format": "object", "parameter": "reasoning.effort", "effortMap": {"low": "low", "high": "high", "max": "max"}});
        let mut body = json!({"model": "test-graded-model", "messages": [], "reasoning_effort": "max", "thinking": {"type": "disabled"}, "reasoning": {"enabled": false, "effort": "max", "summary": "auto"}});
        assert!(apply_subagent_reasoning_effort(
            &settings("high"),
            &provider,
            &child_headers(),
            &mut body,
            "/v1/chat/completions"
        ));
        assert_eq!(body["reasoning"]["effort"], "high");
        assert_eq!(body["reasoning"]["summary"], "auto");
        assert!(body.get("reasoning_effort").is_none());
        assert!(body.get("thinking").is_none());
        assert!(body["reasoning"].get("enabled").is_none());
    }

    #[test]
    fn subagent_reasoning_effort_leaves_nongeneration_endpoints_unchanged() {
        for endpoint in [
            "/alpha/search",
            "/responses/compact",
            "/v1/responses/compact",
            "/v1/images/generations",
        ] {
            let mut body = request();
            assert!(!apply_subagent_reasoning_effort(
                &settings("high"),
                &provider(),
                &child_headers(),
                &mut body,
                endpoint
            ));
            assert_eq!(body, request());
        }
    }

    #[test]
    fn subagent_reasoning_diagnostics_identify_children_and_allowlist_final_wire_effort() {
        let incoming = request();
        for outgoing in [
            json!({"reasoning": {"effort": "high"}}),
            json!({"reasoning_effort": "high"}),
            json!({"output_config": {"effort": "high"}}),
        ] {
            let fields = request_diagnostic_fields(&child_headers(), &incoming, &outgoing, true);
            assert_eq!(
                fields,
                [
                    ("is_subagent", "true".to_string()),
                    ("subagent_reasoning_override_applied", "true".to_string()),
                    ("requested_reasoning_effort", "max".to_string()),
                    ("upstream_reasoning_effort", "high".to_string()),
                ]
            );
        }
        let main = request_diagnostic_fields(&HeaderMap::new(), &incoming, &incoming, false);
        assert_eq!(main[0].1, "false");
        assert_eq!(main[1].1, "false");
        assert_eq!(main[2].1, "max");
        assert_eq!(main[3].1, "max");
        let metadata = json!({"client_metadata": {"x-openai-subagent": "collab_spawn"}});
        assert_eq!(
            request_diagnostic_fields(&HeaderMap::new(), &metadata, &json!({}), false)[0].1,
            "true"
        );
        assert_eq!(
            diagnostic_effort(
                &json!({"reasoning": {"effort": "high"}, "reasoning_effort": "high"})
            ),
            "high"
        );
        assert_eq!(
            diagnostic_effort(&json!({"reasoning": {"effort": "high"}, "reasoning_effort": "max"})),
            "conflict"
        );
        assert_eq!(
            diagnostic_effort(&json!({"thinking": {"type": "enabled", "budget_tokens": 16384}})),
            "unset"
        );
    }

    #[test]
    fn subagent_reasoning_diagnostics_never_copy_unrecognized_values_or_request_content() {
        for value in [
            json!("SENSITIVE_SENTINEL"),
            json!({"raw": "SENSITIVE_SENTINEL"}),
            json!(null),
        ] {
            let body = json!({"reasoning_effort": value, "input": "SENSITIVE_SENTINEL", "api_key": "SENSITIVE_SENTINEL"});
            let fields = request_diagnostic_fields(&child_headers(), &body, &body, false);
            assert_eq!(fields[2].1, "unknown");
            assert_eq!(fields[3].1, "unknown");
            assert!(!format!("{fields:?}").contains("SENSITIVE_SENTINEL"));
        }
    }

    #[test]
    fn subagent_reasoning_effort_final_policy_rejects_conflicts_without_exposing_values() {
        let original = json!({"reasoning": {"effort": "high"}, "model": "test-graded-model"});
        let projection = SubagentReasoningProjection::capture(&original);
        let mut compatible = original.clone();
        compatible["reasoning"]["summary"] = json!("auto");
        compatible["temperature"] = json!(0.1);
        projection.verify(&compatible).unwrap();
        for conflicting in [
            json!({"reasoning": {"effort": "max"}}),
            json!({"reasoning": {"effort": "high"}, "thinking": {"type": "disabled"}}),
            json!({"reasoning": {"effort": "high"}, "reasoning_effort": "max"}),
        ] {
            let error = projection.verify(&conflicting).unwrap_err().to_string();
            assert!(error.contains("Profile settings"));
            assert!(!error.contains("test-graded-model"));
        }
        let budget =
            json!({"thinking": {"type": "enabled", "budget_tokens": 4096}, "max_tokens": 16384});
        let projection = SubagentReasoningProjection::capture(&budget);
        projection.verify(&budget).unwrap();
        let mut reduced = budget;
        reduced["max_tokens"] = json!(2048);
        assert!(projection.verify(&reduced).is_err());
    }
}
