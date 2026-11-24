use serde::de::{self, IgnoredAny, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use std::{collections::HashMap, fmt, hash::Hash, marker::PhantomData};

const OWNER_REMOTE_HTTPS_PORT: u16 = 443;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ServeRoute {
    Missing,
    Matching,
    Conflict,
    FunnelEnabled,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "PascalCase")]
struct ServeConfig {
    #[serde(rename = "TCP", deserialize_with = "unique_map")]
    tcp: HashMap<u16, TcpHandler>,
    #[serde(deserialize_with = "unique_map")]
    web: HashMap<String, WebServer>,
    #[serde(deserialize_with = "unique_map")]
    allow_funnel: HashMap<String, bool>,
    #[serde(deserialize_with = "unique_map")]
    foreground: HashMap<String, ServeConfig>,
    // VIP services have their own routing table and do not own the node origin.
    #[serde(rename = "Services")]
    _services: HashMap<String, IgnoredAny>,
    #[serde(flatten)]
    unknown: HashMap<String, IgnoredAny>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "PascalCase")]
struct TcpHandler {
    #[serde(rename = "HTTPS")]
    https: bool,
    #[serde(rename = "HTTP")]
    http: bool,
    #[serde(rename = "TCPForward")]
    tcp_forward: String,
    #[serde(rename = "TerminateTLS")]
    terminate_tls: String,
    proxy_protocol: u8,
    #[serde(flatten)]
    unknown: HashMap<String, IgnoredAny>,
}

impl TcpHandler {
    fn is_https(&self) -> bool {
        self.https
            && !self.http
            && self.tcp_forward.is_empty()
            && self.terminate_tls.is_empty()
            && self.proxy_protocol == 0
            && self.unknown.is_empty()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct WebServer {
    #[serde(deserialize_with = "unique_map")]
    handlers: HashMap<String, HttpHandler>,
    #[serde(flatten)]
    unknown: HashMap<String, IgnoredAny>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "PascalCase")]
struct HttpHandler {
    proxy: String,
    path: String,
    text: String,
    redirect: String,
    #[serde(rename = "AcceptAppCaps")]
    _accept_app_caps: Vec<String>,
    #[serde(flatten)]
    unknown: HashMap<String, IgnoredAny>,
}

impl HttpHandler {
    fn proxies_to(&self, target: &str) -> bool {
        (self.proxy == target || self.proxy.strip_suffix('/') == Some(target))
            && self.path.is_empty()
            && self.text.is_empty()
            && self.redirect.is_empty()
            && self.unknown.is_empty()
    }
}

// A duplicate route or Funnel entry must not hide an earlier value.
fn unique_map<'de, D, K, V>(deserializer: D) -> Result<HashMap<K, V>, D::Error>
where
    D: Deserializer<'de>,
    K: Deserialize<'de> + Eq + Hash,
    V: Deserialize<'de>,
{
    struct UniqueMap<K, V>(PhantomData<(K, V)>);

    impl<'de, K, V> Visitor<'de> for UniqueMap<K, V>
    where
        K: Deserialize<'de> + Eq + Hash,
        V: Deserialize<'de>,
    {
        type Value = HashMap<K, V>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a map with unique keys")
        }

        fn visit_map<M: MapAccess<'de>>(self, mut entries: M) -> Result<Self::Value, M::Error> {
            let mut map = HashMap::new();
            while let Some((key, value)) = entries.next_entry()? {
                if map.insert(key, value).is_some() {
                    return Err(de::Error::custom("duplicate Serve status key"));
                }
            }
            Ok(map)
        }
    }

    deserializer.deserialize_map(UniqueMap(PhantomData))
}

pub(super) fn classify_serve(
    output: &str,
    host: &str,
    target: &str,
) -> Result<ServeRoute, serde_json::Error> {
    let Some(config) = serde_json::from_str::<Option<ServeConfig>>(output)? else {
        return Ok(ServeRoute::Missing);
    };
    let host_port = format!("{host}:{OWNER_REMOTE_HTTPS_PORT}");

    if std::iter::once(&config)
        .chain(config.foreground.values())
        .any(|layer| layer.allow_funnel.get(&host_port) == Some(&true))
    {
        return Ok(ServeRoute::FunnelEnabled);
    }

    // A foreground listener may own this port or replace the entire Web table
    // entry for this host. A persistent setup must leave that session alone.
    if !config.unknown.is_empty()
        || config.foreground.values().any(|layer| {
            !layer.unknown.is_empty()
                || !layer.foreground.is_empty()
                || layer.tcp.contains_key(&OWNER_REMOTE_HTTPS_PORT)
                || layer.web.contains_key(&host_port)
        })
    {
        return Ok(ServeRoute::Conflict);
    }

    let https = config.tcp.get(&OWNER_REMOTE_HTTPS_PORT);
    if https.is_some_and(|handler| !handler.is_https()) {
        return Ok(ServeRoute::Conflict);
    }
    let Some(web) = config.web.get(&host_port) else {
        return Ok(ServeRoute::Missing);
    };
    if https.is_none()
        || !web.unknown.is_empty()
        || web.handlers.keys().any(|path| {
            // Serve's trailing-slash fallback tries "//" before "/".
            path == "//"
                || path == "/remote"
                || path.starts_with("/remote/")
                || !path.starts_with('/')
        })
    {
        return Ok(ServeRoute::Conflict);
    }

    Ok(match web.handlers.get("/") {
        Some(root) if root.proxies_to(target) => ServeRoute::Matching,
        Some(_) => ServeRoute::Conflict,
        None => ServeRoute::Missing,
    })
}

#[cfg(test)]
mod tests {
    use super::{classify_serve, ServeRoute};
    use serde_json::{json, Value};

    const HOST: &str = "workstation.example.ts.net";
    const ENDPOINT: &str = "workstation.example.ts.net:443";
    const TARGET: &str = "http://127.0.0.1:15723";

    fn classify(config: Value) -> ServeRoute {
        classify_serve(&config.to_string(), HOST, TARGET).unwrap()
    }

    fn https_route(mount: &str, handler: Value) -> Value {
        json!({"TCP": {"443": {"HTTPS": true}}, "Web": {ENDPOINT: {"Handlers": {mount: handler}}}})
    }

    #[test]
    fn classifies_nil_and_empty_serve_status_as_unconfigured() {
        assert_eq!(classify(Value::Null), ServeRoute::Missing);
        assert_eq!(classify(json!({})), ServeRoute::Missing);
    }

    #[test]
    fn matches_the_exact_loopback_root_proxy_with_optional_slash() {
        for target in [TARGET.to_owned(), format!("{TARGET}/")] {
            let mut config = https_route("/", json!({"Proxy": target}));
            config["Web"][ENDPOINT]["Handlers"]["/remote-status"] = json!({"Text": "separate"});
            assert_eq!(classify(config), ServeRoute::Matching);
        }
    }

    #[test]
    fn preserves_unrelated_ports_hosts_mounts_and_vip_services() {
        let mut config = https_route("/dashboard", json!({"Text": "separate"}));
        config["TCP"]["8443"] = json!({"TCPForward": "127.0.0.1:3000"});
        config["AllowFunnel"]["workstation.example.ts.net:8443"] = json!(true);
        config["Web"]["other.example.ts.net:443"] = json!({"Handlers": {"/": {"Text": "other"}}});
        config["Foreground"]["separate-session"] = json!({"TCP": {"7777": {"HTTP": true}}});
        config["Services"]["svc:separate"] = json!({"TCP": {"443": {"HTTP": true}}});
        assert_eq!(classify(config), ServeRoute::Missing);
    }

    #[test]
    fn refuses_an_existing_root_with_a_different_target_or_handler() {
        for root in [
            json!({"Proxy": "http://127.0.0.1:15722"}),
            json!({"Proxy": "http://127.0.0.1:15723/remote/"}),
            json!({"Proxy": "https://127.0.0.1:15723"}),
            json!({"Text": "separate"}),
            json!({"Path": "/var/www"}),
            json!({"Redirect": "https://example.test"}),
            json!({"Proxy": TARGET, "Text": "separate"}),
            json!({"Proxy": TARGET, "FutureHandler": true}),
        ] {
            assert_eq!(classify(https_route("/", root)), ServeRoute::Conflict);
        }
    }

    #[test]
    fn refuses_mounts_that_could_intercept_remote_console_requests() {
        for path in [
            "//",
            "/remote",
            "/remote/",
            "/remote/console.js",
            "/remote/api/v1",
        ] {
            let mut config = https_route("/", json!({"Proxy": TARGET}));
            config["Web"][ENDPOINT]["Handlers"][path] = json!({"Text": "separate"});
            assert_eq!(classify(config), ServeRoute::Conflict);
            assert_eq!(
                classify(https_route(path, json!({"Text": "separate"}))),
                ServeRoute::Conflict,
            );
        }
    }

    #[test]
    fn refuses_an_incompatible_listener_on_443() {
        for listener in [
            json!({"HTTP": true}),
            json!({"TCPForward": "127.0.0.1:3000"}),
            json!({"HTTPS": true, "TCPForward": "127.0.0.1:3000"}),
            json!({"HTTPS": true, "HTTP": true}),
            json!({"HTTPS": true, "FutureProtocol": true}),
            json!({}),
        ] {
            assert_eq!(
                classify(json!({"TCP": {"443": listener}})),
                ServeRoute::Conflict
            );
        }
        let mut config = https_route("/", json!({"Proxy": TARGET}));
        config.as_object_mut().unwrap().remove("TCP");
        assert_eq!(classify(config), ServeRoute::Conflict);
    }

    #[test]
    fn refuses_foreground_ownership_even_for_a_matching_route() {
        let config = https_route("/", json!({"Proxy": TARGET}));
        assert_eq!(
            classify(json!({"Foreground": {"session": config}})),
            ServeRoute::Conflict,
        );
        let mut config = https_route("/", json!({"Proxy": TARGET}));
        config["Foreground"]["session"]["Web"][ENDPOINT] =
            json!({"Handlers": {"/unrelated": {"Text": "separate"}}});
        assert_eq!(classify(config), ServeRoute::Conflict);
        assert_eq!(
            classify(json!({"Foreground": {"session": {"TCP": {"443": {"HTTPS": true}}}}})),
            ServeRoute::Conflict,
        );
    }

    #[test]
    fn detects_funnel_on_the_affected_host_and_port_in_either_layer() {
        assert_eq!(
            classify(json!({"AllowFunnel": {ENDPOINT: true}})),
            ServeRoute::FunnelEnabled
        );
        let mut config = https_route("/", json!({"Proxy": TARGET}));
        config["AllowFunnel"][ENDPOINT] = json!(false);
        assert_eq!(classify(config.clone()), ServeRoute::Matching);
        config["Foreground"]["session"]["AllowFunnel"][ENDPOINT] = json!(true);
        assert_eq!(classify(config), ServeRoute::FunnelEnabled);
    }

    #[test]
    fn refuses_unknown_layers_and_rejects_malformed_or_duplicate_status() {
        assert_eq!(classify(json!({"FutureConfig": {}})), ServeRoute::Conflict);
        assert_eq!(
            classify(json!({"Foreground": {"session": {"Foreground": {"nested": {}}}}})),
            ServeRoute::Conflict,
        );
        for invalid in [
            "",
            "[]",
            r#"{"TCP":{"443":{"HTTPS":"true"}}}"#,
            r#"{"TCP":{"443":{"HTTPS":true},"443":{"HTTP":true}}}"#,
            r#"{"AllowFunnel":{"workstation.example.ts.net:443":true,"workstation.example.ts.net:443":false}}"#,
            r#"{"Web":{"workstation.example.ts.net:443":{"Handlers":null}}}"#,
        ] {
            assert!(classify_serve(invalid, HOST, TARGET).is_err(), "{invalid}");
        }
    }
}
