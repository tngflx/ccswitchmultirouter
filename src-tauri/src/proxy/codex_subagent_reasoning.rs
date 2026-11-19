//! Sub-Agent-only reasoning overrides at the request boundary.
//!
//! A role file is a default, not an enforcement boundary: native built-in roles
//! and explicit spawn arguments can choose another effort. Only Codex's explicit
//! child-request metadata authorizes this override; prompts/model names do not.

use super::codex_reasoning_controls::CodexReasoningProjection;
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
        CodexReasoningProjection::capture(&controls).apply(body);
        return true;
    }
    let Some(object) = body.as_object() else {
        return false;
    };
    if object
        .get("reasoning")
        .is_some_and(|value| !value.is_null() && !value.is_object())
    {
        // Preserve malformed input for ordinary validation; an override is not
        // permission to reinterpret an unrecognized request structure.
        return false;
    }
    let mut logical = serde_json::json!({"reasoning": {"effort": effort.as_str()}});
    if object.contains_key("reasoning_effort") {
        logical["reasoning_effort"] = Value::String(effort.as_str().to_string());
    }
    // This active policy replaces prior reasoning intent, not just one alias.
    // A stale enabled=false must not contradict the chosen logical High when
    // the common ingress validator subsequently prepares the provider body.
    CodexReasoningProjection::capture(&logical).apply(body);
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
    fn subagent_reasoning_effort_prepares_sublyx_native_max_for_marked_children() {
        let base_url = "https://api.sublyx.org/v1";
        let wire_model = "gpt-6.2-sol";
        let evidence_scope =
            crate::reasoning_capabilities::reasoning_evidence_scope(base_url, wire_model)
                .expect("Sublyx Responses evidence scope");
        let provider = Provider::with_id(
            "sublyx-router-route".into(),
            "Sublyx relay".into(),
            json!({
                "base_url": base_url,
                "codexResolvedRouteId": "sublyx-route",
                "codexResolvedTargetProviderId": "sublyx-test-target",
                "codexResolvedCanonicalModel": "gpt-6.2-sol-sublyx",
                "codexResolvedUpstreamModelOverride": wire_model,
                "modelCatalog": {"models": [{
                    "model": "gpt-6.2-sol-sublyx",
                    "upstreamModel": wire_model,
                    "codexUltra": {"enabled": true, "providerEffort": "xhigh"},
                    "reasoning": {
                        "schemaVersion": 2,
                        "supportStatus": "confirmed_supported",
                        "controlKind": "graded",
                        "supportedEfforts": ["low", "medium", "high", "xhigh", "max"],
                        "defaultEffort": "medium",
                        "disableAllowed": false,
                        "source": "sublyx",
                        "confidence": "maintained",
                        "evidenceScope": evidence_scope,
                        "upstream": {
                            "format": "reasoning_object",
                            "parameter": "reasoning.effort",
                            "effortMap": {"low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh", "max": "max"}
                        },
                        "codexUltraOrchestration": {"enabled": true, "providerEffort": "xhigh"}
                    }
                }]}
            }),
            None,
        );

        for (policy, incoming) in [
            ("max", "low"),
            ("max", "medium"),
            ("max", "xhigh"),
            ("ultra", "low"),
            ("ultra", "medium"),
            ("ultra", "xhigh"),
            ("max", "ultra"),
        ] {
            for child in [false, true] {
                let headers = if child {
                    child_headers()
                } else {
                    HeaderMap::new()
                };
                let mut body = request();
                body["model"] = json!("router-generated-public-alias");
                body["reasoning"]["effort"] = json!(incoming);
                assert_eq!(
                    apply_subagent_reasoning_effort(
                        &settings(policy),
                        &provider,
                        &headers,
                        &mut body,
                        "/v1/responses",
                    ),
                    child,
                    "{policy}/{incoming}/child={child}"
                );
                crate::proxy::providers::prepare_codex_native_responses_model(&provider, &mut body)
                    .expect("prepare Sublyx Responses request");
                let wire_effort = if child || incoming == "ultra" {
                    "max"
                } else {
                    incoming
                };
                assert_eq!(body["model"], wire_model);
                assert_eq!(
                    body["reasoning"]["effort"], wire_effort,
                    "{policy}/{incoming}/child={child}"
                );
                assert_eq!(body["reasoning"]["summary"], "auto");
                assert!(body.get("reasoning_effort").is_none());
            }
        }
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
    fn subagent_reasoning_effort_responses_replaces_stale_boolean_controls_before_validation() {
        let mut body = json!({
            "model": "test-graded-model", "input": "bounded test", "reasoning_effort": "max",
            "reasoning": {"enabled": false, "effort": "max", "summary": "auto"},
            "thinking": {"type": "disabled"}, "enable_thinking": false, "reasoning_split": false,
            "chat_template_kwargs": {"enable_thinking": false, "keep": "ancillary"},
            "output_config": {"effort": "low", "keep": "ancillary"}
        });
        assert!(apply_subagent_reasoning_effort(
            &settings("high"),
            &provider(),
            &child_headers(),
            &mut body,
            "/v1/responses"
        ));
        assert_eq!(body["reasoning"]["effort"], "high");
        assert_eq!(body["reasoning_effort"], "high");
        assert_eq!(body["reasoning"]["summary"], "auto");
        assert!(body["reasoning"].get("enabled").is_none());
        for field in ["thinking", "enable_thinking", "reasoning_split"] {
            assert!(body.get(field).is_none());
        }
        assert!(body["chat_template_kwargs"]
            .get("enable_thinking")
            .is_none());
        assert!(body["output_config"].get("effort").is_none());
        assert_eq!(body["chat_template_kwargs"]["keep"], "ancillary");
        assert_eq!(body["output_config"]["keep"], "ancillary");
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
        let projection = CodexReasoningProjection::capture(&original);
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
        let projection = CodexReasoningProjection::capture(&budget);
        projection.verify(&budget).unwrap();
        let mut reduced = budget;
        reduced["max_tokens"] = json!(2048);
        assert!(projection.verify(&reduced).is_err());
    }
}
