//! Desktop Ultra recovery and Sub-Agent reasoning overrides at the request boundary.
//!
//! A role file is a default, not an enforcement boundary: native built-in roles
//! and explicit spawn arguments can choose another effort. Only Codex's explicit
//! child-request metadata authorizes this override; prompts/model names do not.

use super::codex_reasoning_controls::CodexReasoningProjection;
use super::providers::codex_reasoning::{
    CodexReasoningEffort, ReasoningSupportKind, ResolvedSubagentReasoningCapability,
};
use crate::codex_multirouter::catalog::{lookup_catalog_model, CatalogModelLookup};
use crate::provider::Provider;
use crate::reasoning_capabilities::CapabilitySource;
use axum::http::HeaderMap;
use serde_json::Value;
use std::borrow::Cow;

/// Codex HTTP uses compatibility headers. WebSocket response.create includes
/// the same turn metadata and its identity fields in client_metadata.
struct TurnMetadata<'a> {
    headers: &'a HeaderMap,
    header_turn: Option<Value>,
    client_metadata: Option<&'a Value>,
    client_turn: Option<Cow<'a, Value>>,
}

impl<'a> TurnMetadata<'a> {
    fn read(headers: &'a HeaderMap, body: &'a Value) -> Option<Self> {
        const TURN_METADATA_HEADER: &str = "x-codex-turn-metadata";
        let header_turn = header_text(headers, TURN_METADATA_HEADER)
            .ok()?
            .map(parse_turn_metadata)
            .transpose()
            .ok()?;
        let client_metadata = body.get("client_metadata");
        if client_metadata.is_some_and(|value| !value.is_object()) {
            return None;
        }
        let client_turn = match client_metadata.and_then(|value| value.get(TURN_METADATA_HEADER)) {
            Some(Value::String(raw)) => Some(Cow::Owned(parse_turn_metadata(raw).ok()?)),
            Some(value @ Value::Object(_)) => Some(Cow::Borrowed(value)),
            None => None,
            _ => return None,
        };
        let metadata = Self {
            headers,
            header_turn,
            client_metadata,
            client_turn,
        };
        match metadata.identifier("request_kind", None) {
            Ok(None | Some("turn")) => Some(metadata),
            _ => None,
        }
    }

    fn identifier(&self, key: &str, header_key: Option<&str>) -> Result<Option<&str>, ()> {
        let mut resolved = match header_key {
            Some(key) => header_text(self.headers, key)?,
            None => None,
        };
        for candidate in [
            self.header_turn.as_ref().and_then(|value| value.get(key)),
            self.client_turn.as_ref().and_then(|value| value.get(key)),
            self.client_metadata.and_then(|value| value.get(key)),
        ]
        .into_iter()
        .flatten()
        {
            let candidate = candidate.as_str().ok_or(())?;
            if resolved.is_some_and(|resolved| resolved != candidate) {
                return Err(());
            }
            resolved = Some(candidate);
        }
        if resolved.is_some_and(|id| {
            id.is_empty()
                || id.len() > 128
                || !id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
        }) {
            return Err(());
        }
        Ok(resolved)
    }
}

fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Result<Option<&'a str>, ()> {
    let all = headers.get_all(name);
    let mut values = all.iter();
    let value = values
        .next()
        .map(|value| value.to_str().map_err(|_| ()))
        .transpose()?;
    if values.next().is_some() {
        return Err(());
    }
    Ok(value)
}

fn parse_turn_metadata(raw: &str) -> Result<Value, ()> {
    if raw.len() > 8096 {
        return Err(());
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| ())?;
    value.is_object().then_some(value).ok_or(())
}

pub(super) fn is_generation_endpoint(endpoint: &str) -> bool {
    let path = endpoint.split('?').next().unwrap_or(endpoint);
    matches!(
        path,
        "/responses" | "/v1/responses" | "/chat/completions" | "/v1/chat/completions"
    )
}

/// Desktop records the selected Ultra tier before serializing it as xhigh.
/// Only the local record for this exact turn and model can distinguish those
/// two selections. Keep the original body available for request diagnostics.
pub(super) async fn restore_desktop_ultra_effort(
    provider: &Provider,
    headers: &HeaderMap,
    incoming: &Value,
    mapped: &mut Value,
    endpoint: &str,
) -> Option<CodexReasoningEffort> {
    let (thread, turn, model) = desktop_ultra_candidate(provider, headers, incoming, endpoint)?;
    let effort = tokio::task::spawn_blocking(move || {
        crate::codex_state_db::codex_turn_reasoning_effort(&thread, &turn, &model)
    })
    .await
    .ok()
    .flatten();
    apply_recorded_ultra_effort(mapped, effort)
}

fn desktop_ultra_candidate(
    provider: &Provider,
    headers: &HeaderMap,
    incoming: &Value,
    endpoint: &str,
) -> Option<(String, String, String)> {
    let path = endpoint.split('?').next().unwrap_or(endpoint);
    if !matches!(path, "/responses" | "/v1/responses")
        || !super::handlers::is_verified_codex_desktop_request(headers)
        || is_subagent_request(headers, incoming)
        || diagnostic_effort(incoming) != "xhigh"
    {
        return None;
    }
    let metadata = TurnMetadata::read(headers, incoming)?;
    let thread = metadata.identifier("thread_id", Some("thread-id")).ok()??;
    let turn = metadata.identifier("turn_id", None).ok()??;
    if uuid::Uuid::parse_str(thread).is_err() || uuid::Uuid::parse_str(turn).is_err() {
        return None;
    }
    let model = incoming.get("model")?.as_str()?;
    let normalized =
        super::providers::transform_codex_chat::normalized_codex_reasoning_request(incoming)
            .ok()?;
    if normalized.pointer("/reasoning/effort")?.as_str()? != "xhigh" {
        return None;
    }
    let capability_model = canonical_route_model(provider).unwrap_or(model);
    let (capability, source) = resolved_reasoning_capability(provider, capability_model);
    let ultra = CodexReasoningEffort::Ultra;
    // An unlisted model can pick up a provider-wide fallback with identical
    // wire values for Ultra and XHigh. That fallback needs no rollout lookup.
    if source == CapabilitySource::ProviderFallback
        && capability.effort_map.get(&ultra)
            == capability.effort_map.get(&CodexReasoningEffort::XHigh)
        && matches!(
            lookup_catalog_model(&provider.settings_config, capability_model),
            CatalogModelLookup::Missing
        )
    {
        return None;
    }
    // The effort map also contains nearest-tier fallbacks for unconfigured inputs.
    (capability.support_kind == ReasoningSupportKind::EffortLevels
        && capability.codex_selectable_efforts.contains(&ultra))
    .then(|| (thread.to_owned(), turn.to_owned(), model.to_owned()))
}

fn apply_recorded_ultra_effort(
    mapped: &mut Value,
    effort: Option<CodexReasoningEffort>,
) -> Option<CodexReasoningEffort> {
    let effort = effort.filter(|effort| *effort == CodexReasoningEffort::Ultra)?;
    for path in ["/reasoning/effort", "/reasoning_effort"] {
        if let Some(value) = mapped.pointer_mut(path) {
            *value = Value::String(effort.as_str().to_string());
        }
    }
    Some(effort)
}

fn resolved_reasoning_capability(
    provider: &Provider,
    model: &str,
) -> (ResolvedSubagentReasoningCapability, CapabilitySource) {
    let detection = crate::reasoning_capabilities::current_detection_for_provider(provider, model);
    let resolved = crate::reasoning_capabilities::resolve_codex_model_capability(
        provider,
        model,
        detection.as_ref(),
    );
    (
        super::providers::codex_reasoning::resolve_subagent_reasoning_capability(
            resolved.capability.as_ref(),
        ),
        resolved.source,
    )
}

fn canonical_route_model(provider: &Provider) -> Option<&str> {
    // The public alias may be absent from the target catalog. A compiled
    // route carries the target's canonical model separately.
    provider
        .settings_config
        .get("codexResolvedRouteId")
        .and_then(|_| provider.settings_config.get("codexResolvedCanonicalModel"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

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
) -> Option<CodexReasoningEffort> {
    let path = endpoint.split('?').next().unwrap_or(endpoint);
    let native_chat = matches!(path, "/chat/completions" | "/v1/chat/completions");
    if !is_generation_endpoint(endpoint)
        || settings
            .pointer("/codexRouting/enabled")
            .and_then(Value::as_bool)
            != Some(true)
        || !is_subagent_request(headers, body)
    {
        return None;
    }
    let request_model = body.get("model").and_then(Value::as_str)?;
    let model = canonical_route_model(provider).unwrap_or(request_model);
    let (capability, _) = resolved_reasoning_capability(provider, model);
    let effort = crate::codex_config::codex_subagent_reasoning_effort_override_for_capability(
        settings,
        &capability,
    )?;
    if native_chat {
        let logical = serde_json::json!({"model": model, "reasoning": {"effort": effort.as_str()}});
        let config = super::providers::resolve_codex_chat_reasoning_config(provider, &logical)?;
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
            return None;
        }
        CodexReasoningProjection::capture(&controls).apply(body);
        return Some(effort);
    }
    let object = body.as_object()?;
    if object
        .get("reasoning")
        .is_some_and(|value| !value.is_null() && !value.is_object())
    {
        // Preserve malformed input for ordinary validation; an override is not
        // permission to reinterpret an unrecognized request structure.
        return None;
    }
    let mut logical = serde_json::json!({"reasoning": {"effort": effort.as_str()}});
    if object.contains_key("reasoning_effort") {
        logical["reasoning_effort"] = Value::String(effort.as_str().to_string());
    }
    // This active policy replaces prior reasoning intent, not just one alias.
    // A stale enabled=false must not contradict the chosen logical effort when
    // the common ingress validator subsequently prepares the provider body.
    CodexReasoningProjection::capture(&logical).apply(body);
    Some(effort)
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

    fn desktop_parent_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("originator", HeaderValue::from_static("Codex Desktop"));
        headers.insert(
            "x-codex-turn-metadata",
            HeaderValue::from_static(
                r#"{"installation_id":"local-install","thread_id":"019c0000-0000-7000-8000-000000000001","turn_id":"019c0000-0000-7000-8000-000000000002","request_kind":"turn"}"#,
            ),
        );
        headers
    }

    #[test]
    fn desktop_ultra_transport_fallback_restores_max_only_for_the_recorded_turn() {
        let provider = Provider::with_id(
            "sublyx".into(),
            "Sublyx".into(),
            json!({"base_url": "https://api.sublyx.org/v1"}),
            None,
        );
        let mut headers = desktop_parent_headers();
        let incoming = json!({
            "model": "gpt-6.2-sol",
            "reasoning": {"effort": "xhigh", "summary": "auto"},
            "reasoning_effort": "xhigh",
        });
        let candidate = desktop_ultra_candidate(&provider, &headers, &incoming, "/v1/responses");
        assert_eq!(
            candidate,
            Some((
                "019c0000-0000-7000-8000-000000000001".into(),
                "019c0000-0000-7000-8000-000000000002".into(),
                "gpt-6.2-sol".into(),
            ))
        );
        for (recorded, expected) in [
            (None, "xhigh"),
            (Some(CodexReasoningEffort::XHigh), "xhigh"),
            (Some(CodexReasoningEffort::Ultra), "max"),
        ] {
            let mut prepared = incoming.clone();
            apply_recorded_ultra_effort(&mut prepared, recorded);
            super::super::providers::prepare_codex_native_responses_model(&provider, &mut prepared)
                .expect("prepare Sublyx Responses payload");
            assert_eq!(prepared["reasoning"]["effort"], expected);
            assert_eq!(prepared["reasoning"]["summary"], "auto");
            assert!(prepared.get("reasoning_effort").is_none());
        }
        let mut unrelated = incoming.clone();
        unrelated["model"] = json!("gpt-unknown");
        assert!(
            desktop_ultra_candidate(&provider, &headers, &unrelated, "/v1/responses").is_none()
        );
        let mut conflicting = incoming.clone();
        conflicting["reasoning_effort"] = json!("high");
        assert!(
            desktop_ultra_candidate(&provider, &headers, &conflicting, "/v1/responses").is_none()
        );
        assert!(
            desktop_ultra_candidate(&provider, &headers, &incoming, "/v1/responses/compact")
                .is_none()
        );
        headers.remove("originator");
        assert!(desktop_ultra_candidate(&provider, &headers, &incoming, "/v1/responses").is_none());
    }

    #[test]
    fn desktop_ultra_route_alias_uses_canonical_capability_and_keeps_exact_lookup_model() {
        let mut provider = Provider::with_id(
            "router::route::sublyx".into(),
            "Sublyx route".into(),
            json!({
                "base_url": "https://api.sublyx.org/v1",
                "codexResolvedRouteId": "sublyx",
                "codexResolvedCanonicalModel": "gpt-6.2-sol",
                "codexResolvedUpstreamModelOverride": "gpt-6.2-sol",
                "modelCatalog": {"models": [{"model": "gpt-6.2-sol"}]}
            }),
            None,
        );
        let request = json!({
            "model": "my-preferred-route",
            "reasoning": {"effort": "xhigh"}
        });

        for native_target in ["max", "xhigh"] {
            if native_target == "xhigh" {
                provider.settings_config["modelCatalog"]["models"][0]["codexUltra"] = json!({
                    "enabled": true,
                    "providerEffort": "xhigh",
                    "providerEffortSource": "user"
                });
            }
            let (_, _, lookup_model) = desktop_ultra_candidate(
                &provider,
                &desktop_parent_headers(),
                &request,
                "/responses",
            )
            .expect("compiled canonical model supports the configured Ultra target");
            assert_eq!(lookup_model, "my-preferred-route");

            let mut prepared = request.clone();
            apply_recorded_ultra_effort(&mut prepared, Some(CodexReasoningEffort::Ultra));
            super::super::providers::prepare_codex_native_responses_model(&provider, &mut prepared)
                .expect("prepare routed Sublyx Responses payload");
            assert_eq!(prepared["reasoning"]["effort"], native_target);
        }
    }

    #[test]
    fn desktop_ultra_recovery_uses_the_configured_native_target_on_other_providers() {
        let mut provider = Provider::with_id(
            "relay".into(),
            "Custom relay".into(),
            json!({
                "base_url": "https://relay.example/v1",
                "modelCatalog": {"models": [{
                    "model": "relay-test-model",
                    "reasoning": {
                        "schemaVersion": 2,
                        "source": "user",
                        "supportStatus": "confirmed_supported",
                        "controlKind": "graded",
                        "supportedEfforts": ["medium", "high", "xhigh", "max"],
                        "defaultEffort": "medium",
                        "disableAllowed": false,
                        "upstream": {
                            "format": "reasoning_object",
                            "parameter": "reasoning.effort",
                            "effortMap": {
                                "medium": "medium", "high": "high", "xhigh": "medium", "max": "max"
                            }
                        }
                    }
                }]}
            }),
            None,
        );
        let headers = desktop_parent_headers();
        let incoming = json!({"model": "relay-test-model", "reasoning": {"effort": "xhigh"}});
        let candidate = |provider: &Provider| {
            desktop_ultra_candidate(provider, &headers, &incoming, "/responses")
        };
        assert!(candidate(&provider).is_none());

        for native_target in ["xhigh", "high", "max"] {
            provider.settings_config["modelCatalog"]["models"][0]["codexUltra"] = json!({
                "enabled": true,
                "providerEffort": native_target,
                "providerEffortSource": "user"
            });
            assert!(candidate(&provider).is_some());

            for (recorded, expected) in [
                (Some(CodexReasoningEffort::XHigh), "medium"),
                (Some(CodexReasoningEffort::Ultra), native_target),
            ] {
                let mut prepared = incoming.clone();
                apply_recorded_ultra_effort(&mut prepared, recorded);
                crate::proxy::providers::prepare_codex_native_responses_model(
                    &provider,
                    &mut prepared,
                )
                .expect("prepare Responses request for the declared provider");
                assert_eq!(prepared["reasoning"]["effort"], expected);
            }
        }

        provider.settings_config["modelCatalog"]["models"][0]["codexUltra"]["enabled"] =
            json!(false);
        assert!(candidate(&provider).is_none());
    }

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

    fn apply_subagent_reasoning_effort(
        settings: &Value,
        provider: &Provider,
        headers: &HeaderMap,
        body: &mut Value,
        endpoint: &str,
    ) -> bool {
        super::apply_subagent_reasoning_effort(settings, provider, headers, body, endpoint)
            .is_some()
    }

    #[test]
    fn desktop_ultra_candidate_accepts_consistent_http_and_websocket_turn_metadata() {
        let provider = Provider::with_id(
            "sublyx".into(),
            "Sublyx".into(),
            json!({"base_url": "https://api.sublyx.org/v1"}),
            None,
        );
        let thread = "019c0000-0000-7000-8000-000000000001";
        let turn = "019c0000-0000-7000-8000-000000000002";
        let mut body = json!({
            "model": "gpt-6.2-sol",
            "reasoning": {"effort": "xhigh"},
            "client_metadata": {
                "thread_id": thread,
                "x-codex-turn-metadata": {"thread_id": thread, "turn_id": turn, "request_kind": "turn"}
            }
        });
        let mut headers = desktop_parent_headers();
        let candidate = |headers: &HeaderMap, body: &Value| {
            desktop_ultra_candidate(&provider, headers, body, "/responses")
        };
        let expected = Some((thread.to_owned(), turn.to_owned(), "gpt-6.2-sol".to_owned()));
        assert_eq!(candidate(&headers, &body), expected);

        headers.remove("x-codex-turn-metadata");
        assert_eq!(candidate(&headers, &body), expected);
        body["client_metadata"]["x-codex-turn-metadata"] =
            json!(body["client_metadata"]["x-codex-turn-metadata"].to_string());
        assert_eq!(candidate(&headers, &body), expected);

        headers.insert("thread-id", HeaderValue::from_static(turn));
        assert!(candidate(&headers, &body).is_none());
        headers.remove("thread-id");
        body["client_metadata"]["x-openai-subagent"] = json!("collab_spawn");
        assert!(candidate(&headers, &body).is_none());

        body["client_metadata"]
            .as_object_mut()
            .unwrap()
            .remove("x-openai-subagent");
        body["client_metadata"]["x-codex-turn-metadata"] = json!("malformed");
        assert!(candidate(&headers, &body).is_none());
        body["client_metadata"]["x-codex-turn-metadata"] =
            json!({"thread_id": thread, "turn_id": turn, "request_kind": "compaction"});
        assert!(candidate(&headers, &body).is_none());
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
    fn subagent_reasoning_effort_prepares_saved_effort_for_marked_sublyx_children() {
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

        for (policy, expected) in [
            (json!({"codexRouting": {"enabled": true}}), Some("high")),
            (settings("high"), Some("high")),
            (settings("xhigh"), Some("xhigh")),
            (settings("profile"), None),
        ] {
            let mut body = request();
            body["model"] = json!("router-generated-public-alias");
            body["reasoning"]["effort"] = json!("low");
            let effort = super::apply_subagent_reasoning_effort(
                &policy,
                &provider,
                &child_headers(),
                &mut body,
                "/v1/responses",
            );
            assert_eq!(effort.map(CodexReasoningEffort::as_str), expected);
            crate::proxy::providers::prepare_codex_native_responses_model(&provider, &mut body)
                .expect("prepare Sublyx Responses request");
            assert_eq!(body["reasoning"]["effort"], expected.unwrap_or("low"));
        }

        let mut body = request();
        assert_eq!(
            super::apply_subagent_reasoning_effort(
                &settings("high"),
                &self::provider(),
                &child_headers(),
                &mut body,
                "/v1/responses",
            ),
            Some(CodexReasoningEffort::High),
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
