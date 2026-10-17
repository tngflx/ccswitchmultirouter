use serde_json::Value;
use url::Url;

use super::catalog::catalog_models;
use crate::{
    protocol_compatibility::TransportKind,
    provider::Provider,
    proxy::providers::{CodexAdapter, ProviderAdapter},
};

/// Provider declarations identify API scope, never credentials or URL options.
pub(crate) fn normalize_protocol_capability_base_url(base_url: &str) -> Option<String> {
    let base_url = base_url.trim();
    if base_url.chars().any(char::is_whitespace)
        || base_url.contains(['?', '#'])
        || base_url
            .split_once("://")
            .is_some_and(|(_, authority)| authority.split('/').next().unwrap_or("").contains('@'))
    {
        return None;
    }
    let url = Url::parse(base_url).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    Some(url.as_str().trim_end_matches('/').to_string())
}

pub(crate) fn provider_api_declared_transport(
    provider: &Provider,
    public_model: &str,
) -> Option<TransportKind> {
    match provider_api_transport_declaration_for_model(provider, public_model) {
        ProviderApiTransportDeclaration::Supported(transport) => Some(transport),
        ProviderApiTransportDeclaration::Unsupported
        | ProviderApiTransportDeclaration::Unavailable => None,
    }
}

pub(crate) fn provider_api_transport_declaration_for_model(
    provider: &Provider,
    public_model: &str,
) -> ProviderApiTransportDeclaration {
    let Some(models) = catalog_models(&provider.settings_config) else {
        return ProviderApiTransportDeclaration::Unavailable;
    };
    let Some(model) = models
        .iter()
        .find(|model| model_identity(model) == Some(public_model.trim()))
    else {
        return ProviderApiTransportDeclaration::Unavailable;
    };
    provider_api_transport_declaration(provider, model)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProviderApiTransportDeclaration {
    /// The provider API declared a usable transport for this model.
    Supported(TransportKind),
    /// The provider API declaration is structurally valid, but explicitly
    /// denies a capability required by the automatic Codex route.
    Unsupported,
    /// No usable declaration was found (missing, stale, malformed, or
    /// unbound metadata). These models remain eligible for deep probing.
    Unavailable,
}

pub(crate) fn provider_api_transport_declaration(
    provider: &Provider,
    model: &Value,
) -> ProviderApiTransportDeclaration {
    if model.get("enabled").and_then(Value::as_bool) == Some(false) {
        return ProviderApiTransportDeclaration::Unavailable;
    }
    let Some(public_model) = model_identity(model) else {
        return ProviderApiTransportDeclaration::Unavailable;
    };
    let upstream_model = ["upstreamModel", "upstream_model"]
        .into_iter()
        .find_map(|field| {
            model
                .get(field)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or(public_model);
    let Some(declaration) = model.get("protocolCapability").and_then(Value::as_object) else {
        return ProviderApiTransportDeclaration::Unavailable;
    };
    if declaration.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || declaration.get("source").and_then(Value::as_str) != Some("provider_api")
        || declaration
            .get("upstreamModel")
            .and_then(Value::as_str)
            .map(str::trim)
            != Some(upstream_model)
    {
        return ProviderApiTransportDeclaration::Unavailable;
    }

    let declared_base = declaration
        .get("baseUrl")
        .and_then(Value::as_str)
        .and_then(normalize_protocol_capability_base_url);
    let current_base_url = match CodexAdapter::new().extract_base_url(provider) {
        Ok(value) => value,
        Err(_) => return ProviderApiTransportDeclaration::Unavailable,
    };
    let current_base = normalize_protocol_capability_base_url(&current_base_url);
    if declared_base.is_none() || current_base.is_none() || declared_base != current_base {
        return ProviderApiTransportDeclaration::Unavailable;
    }

    let Some(endpoints) = declaration
        .get("supportedEndpoints")
        .and_then(Value::as_array)
    else {
        return ProviderApiTransportDeclaration::Unavailable;
    };
    let mut responses = false;
    let mut chat = false;
    for endpoint in endpoints {
        match endpoint.as_str() {
            Some("openai_responses") => responses = true,
            Some("openai_chat") => chat = true,
            _ => return ProviderApiTransportDeclaration::Unavailable,
        }
    }
    let transport = if provider.meta.as_ref().and_then(|meta| meta.is_full_url) == Some(true) {
        let Ok(full_url) = Url::parse(&current_base_url) else {
            return ProviderApiTransportDeclaration::Unavailable;
        };
        let path = full_url.path().trim_end_matches('/');
        let transport = if path.ends_with("/chat/completions") {
            TransportKind::OpenAiChat
        } else if path.ends_with("/responses") {
            TransportKind::OpenAiResponses
        } else {
            let Some(transport) = configured_transport(provider) else {
                return ProviderApiTransportDeclaration::Unavailable;
            };
            transport
        };
        match transport {
            TransportKind::OpenAiChat if chat => transport,
            TransportKind::OpenAiResponses if responses => transport,
            _ => return ProviderApiTransportDeclaration::Unavailable,
        }
    } else {
        match (configured_transport(provider), responses, chat) {
            (Some(TransportKind::OpenAiChat), _, true) => TransportKind::OpenAiChat,
            (_, true, _) => TransportKind::OpenAiResponses,
            (_, false, true) => TransportKind::OpenAiChat,
            _ => return ProviderApiTransportDeclaration::Unavailable,
        }
    };

    let mut explicitly_unsupported = false;
    for field in [
        "supportsTools",
        "supportsStreaming",
        "supportsToolContinuation",
    ] {
        let Some(value) = declaration.get(field) else {
            continue;
        };
        let Some(value) = value.as_bool() else {
            return ProviderApiTransportDeclaration::Unavailable;
        };
        explicitly_unsupported |= !value;
    }
    if explicitly_unsupported {
        ProviderApiTransportDeclaration::Unsupported
    } else {
        ProviderApiTransportDeclaration::Supported(transport)
    }
}

fn model_identity(model: &Value) -> Option<&str> {
    ["model", "id", "slug"].into_iter().find_map(|field| {
        model
            .get(field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    })
}

pub(crate) fn configured_transport(provider: &Provider) -> Option<TransportKind> {
    for format in [
        provider
            .meta
            .as_ref()
            .and_then(|meta| meta.api_format.as_deref()),
        provider
            .settings_config
            .get("apiFormat")
            .and_then(Value::as_str),
        provider
            .settings_config
            .get("api_format")
            .and_then(Value::as_str),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(transport) = parse_transport(format) {
            return Some(transport);
        }
    }
    let config = provider.settings_config.get("config")?.as_str()?;
    let config = toml::from_str::<toml::Value>(config).ok()?;
    let selected = config.get("model_provider").and_then(toml::Value::as_str);
    let format = selected
        .and_then(|selected| config.get("model_providers")?.get(selected))
        .and_then(|provider| provider.get("wire_api"))
        .or_else(|| config.get("wire_api"))
        .and_then(toml::Value::as_str)?;
    parse_transport(format)
}

fn parse_transport(format: &str) -> Option<TransportKind> {
    match format.trim().to_ascii_lowercase().as_str() {
        "chat"
        | "chat_completions"
        | "chat-completions"
        | "openai_chat"
        | "openai-chat"
        | "openai_chat_completions" => Some(TransportKind::OpenAiChat),
        "responses" | "openai_responses" | "openai-responses" => {
            Some(TransportKind::OpenAiResponses)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ProviderMeta;
    use serde_json::json;

    fn api_provider() -> Provider {
        let mut provider = Provider::with_id(
            "api-source".to_string(),
            "API source".to_string(),
            json!({
                "base_url": "https://provider.example/v1",
                "auth": {"OPENAI_API_KEY": "redacted-test-key"},
                "config": "model = \"visible-model\"\nmodel_provider = \"api\"\n[model_providers.api]\nbase_url = \"https://provider.example/v1\"\nwire_api = \"responses\"\n",
                "modelCatalog": {"models": [{
                    "model": "visible-model",
                    "upstreamModel": "vendor/upstream-model",
                    "protocolCapability": {
                        "schemaVersion": 1,
                        "source": "provider_api",
                        "baseUrl": "https://provider.example/v1/",
                        "upstreamModel": "vendor/upstream-model",
                        "supportedEndpoints": ["openai_chat", "openai_responses"],
                        "supportsTools": true
                    }
                }]}
            }),
            None,
        );
        provider.meta = Some(ProviderMeta {
            api_format: Some("openai_responses".to_string()),
            ..ProviderMeta::default()
        });
        provider
    }

    #[test]
    fn normalization_accepts_only_unambiguous_credential_free_api_scope() {
        assert_eq!(
            normalize_protocol_capability_base_url("HTTPS://Provider.Example:443/v1/"),
            Some("https://provider.example/v1".to_string())
        );
        for url in [
            "https://user:REDACTED@provider.example/v1",
            "https://provider.example/v1?api_key=REDACTED",
            "https://provider.example/v1#REDACTED",
            "https://provider.example/v1?",
            "https://provider.example/v1#",
            "https://@provider.example/v1",
            "https://provider.example/v1/\tpath",
            "relative/v1",
            "file:///private/config",
        ] {
            assert!(normalize_protocol_capability_base_url(url).is_none());
        }
    }

    #[test]
    fn declarations_follow_configured_supported_transport_and_exact_model_binding() {
        let mut provider = api_provider();
        assert_eq!(
            provider_api_declared_transport(&provider, "visible-model"),
            Some(TransportKind::OpenAiResponses)
        );
        provider.meta.as_mut().unwrap().api_format = Some("openai_chat".to_string());
        assert_eq!(
            provider_api_declared_transport(&provider, "visible-model"),
            Some(TransportKind::OpenAiChat)
        );
        provider.settings_config["modelCatalog"]["models"][0]["protocolCapability"]
            ["supportedEndpoints"] = json!(["openai_responses"]);
        assert_eq!(
            provider_api_declared_transport(&provider, "visible-model"),
            Some(TransportKind::OpenAiResponses)
        );
        provider.settings_config["modelCatalog"]["models"][0]["upstreamModel"] =
            json!("vendor/other-model");
        assert_eq!(
            provider_api_declared_transport(&provider, "visible-model"),
            None
        );
    }

    #[test]
    fn missing_malformed_or_negative_capabilities_do_not_certify_protocols() {
        for (field, value) in [
            ("schemaVersion", json!(2)),
            ("source", json!("builtin")),
            ("baseUrl", json!("https://other.example/v1")),
            ("upstreamModel", json!("vendor/UPSTREAM-model")),
            ("supportedEndpoints", json!([])),
            ("supportedEndpoints", json!(["unknown_protocol"])),
            ("supportedEndpoints", json!(["openai_chat", null])),
            ("supportsTools", json!(false)),
            ("supportsStreaming", json!(false)),
            ("supportsToolContinuation", json!(false)),
            ("supportsTools", json!("true")),
            ("supportsStreaming", json!(null)),
        ] {
            let mut provider = api_provider();
            provider.settings_config["modelCatalog"]["models"][0]["protocolCapability"][field] =
                value;
            assert!(
                provider_api_declared_transport(&provider, "visible-model").is_none(),
                "{field}"
            );
        }
        let mut provider = api_provider();
        provider.settings_config["modelCatalog"]["models"][0]["enabled"] = json!(false);
        assert!(provider_api_declared_transport(&provider, "visible-model").is_none());
    }

    #[test]
    fn explicit_negative_capabilities_are_known_unsupported_not_unresolved() {
        for field in [
            "supportsTools",
            "supportsStreaming",
            "supportsToolContinuation",
        ] {
            let mut provider = api_provider();
            provider.settings_config["modelCatalog"]["models"][0]["protocolCapability"][field] =
                json!(false);
            assert_eq!(
                provider_api_transport_declaration_for_model(&provider, "visible-model"),
                ProviderApiTransportDeclaration::Unsupported,
                "{field}"
            );
            assert!(
                provider_api_declared_transport(&provider, "visible-model").is_none(),
                "negative capability must not produce an executable transport"
            );
        }

        let mut malformed = api_provider();
        malformed.settings_config["modelCatalog"]["models"][0]["protocolCapability"]
            ["supportsTools"] = json!("false");
        assert_eq!(
            provider_api_transport_declaration_for_model(&malformed, "visible-model"),
            ProviderApiTransportDeclaration::Unavailable
        );
    }

    #[test]
    fn canonical_empty_catalog_and_current_url_options_reject_old_metadata() {
        let mut provider = api_provider();
        provider.settings_config["model_catalog"] =
            provider.settings_config["modelCatalog"].clone();
        provider.settings_config["modelCatalog"] = json!({"models": []});
        assert!(provider_api_declared_transport(&provider, "visible-model").is_none());

        for url in [
            "https://provider.example/v1?api-version=2026-01-01",
            "https://REDACTED@provider.example/v1",
            "https://provider.example/v1#fragment",
        ] {
            let mut provider = api_provider();
            provider.settings_config["base_url"] = json!(url);
            provider.settings_config["config"] = json!(format!(
                "model = \"visible-model\"\nmodel_provider = \"api\"\n[model_providers.api]\nbase_url = {url:?}\nwire_api = \"responses\"\n"
            ));
            assert!(provider_api_declared_transport(&provider, "visible-model").is_none());
        }
    }

    #[test]
    fn full_url_declarations_never_switch_to_an_incompatible_physical_endpoint() {
        let mut provider = api_provider();
        provider.meta.as_mut().unwrap().is_full_url = Some(true);
        provider.settings_config["base_url"] = json!("https://provider.example/v1/responses");
        provider.settings_config["modelCatalog"]["models"][0]["protocolCapability"]["baseUrl"] =
            json!("https://provider.example/v1/responses");
        provider.settings_config["modelCatalog"]["models"][0]["protocolCapability"]
            ["supportedEndpoints"] = json!(["openai_chat"]);
        assert_eq!(
            provider_api_declared_transport(&provider, "visible-model"),
            None
        );
        provider.settings_config["modelCatalog"]["models"][0]["protocolCapability"]
            ["supportedEndpoints"] = json!(["openai_chat", "openai_responses"]);
        provider.meta.as_mut().unwrap().api_format = Some("openai_chat".to_string());
        assert_eq!(
            provider_api_declared_transport(&provider, "visible-model"),
            Some(TransportKind::OpenAiResponses)
        );
    }

    #[test]
    fn unknown_full_url_requires_an_explicit_supported_transport() {
        let mut provider = api_provider();
        provider.meta.as_mut().unwrap().is_full_url = Some(true);
        provider.meta.as_mut().unwrap().api_format = None;
        provider.settings_config["base_url"] = json!("https://provider.example/invoke");
        provider.settings_config["config"] = json!("model = \"visible-model\"\n");
        provider.settings_config["modelCatalog"]["models"][0]["protocolCapability"]["baseUrl"] =
            json!("https://provider.example/invoke");
        assert_eq!(
            provider_api_declared_transport(&provider, "visible-model"),
            None
        );
        provider.meta.as_mut().unwrap().api_format = Some("openai_chat".to_string());
        assert_eq!(
            provider_api_declared_transport(&provider, "visible-model"),
            Some(TransportKind::OpenAiChat)
        );
    }

    #[test]
    fn protocol_declarations_do_not_certify_or_require_authentication() {
        let mut provider = api_provider();
        provider.settings_config["auth"] = json!({});
        assert_eq!(
            provider_api_declared_transport(&provider, "visible-model"),
            Some(TransportKind::OpenAiResponses)
        );
    }
}
