// Included only from owner_remote::tests. No production bootstrap or auth bypass.
// Explicit live audit: same monitor owns the disposable thread and commit handoff.
use futures::StreamExt as _;
use std::io::Write as _;
use webauthn_authenticator_rs::{softpasskey::SoftPasskey, WebauthnAuthenticator};

type LiveAuditResult<T> = Result<T, &'static str>;
const LIVE_AUDIT_LIMIT: u64 = 16 * 1024;
const LIVE_AUDIT_ENV: &str = "CC_SWITCH_OWNER_REMOTE_LIVE_HANDOFF";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LiveAuditRequest {
    schema_version: u8,
    audit_nonce: String,
    thread_id: String,
    initial_turn_id: String,
    model: String,
    provider_id: String,
    fixture_base_url: String,
    expected_renderer_fingerprint: String,
}
impl LiveAuditRequest {
    fn validate(&self) -> LiveAuditResult<()> {
        let hex = |s: &str, n| {
            s.len() == n
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        let url =
            url::Url::parse(&self.fixture_base_url).map_err(|_| "audit_invalid_fixture_url")?;
        if self.schema_version != 1
            || !hex(&self.audit_nonce, 64)
            || !safe_identifier(&self.thread_id, 1, 256)
            || !safe_identifier(&self.initial_turn_id, 1, 256)
            || !safe_identifier(&self.provider_id, 1, 256)
            || self.model != "fixture-model"
            || !self
                .expected_renderer_fingerprint
                .strip_prefix("sha256-")
                .is_some_and(|s| hex(s, 64))
            || url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.port().is_none_or(|p| p == 0)
            || url.path() != "/v1"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("audit_invalid_request");
        }
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LiveAuditCommit {
    schema_version: u8,
    audit_nonce: String,
    commit: bool,
}
// The browser fixture is opt-in and carries no cookie, assertion, transcript or
// mutation authority over IPC. Actual enrollment and Continue run in the UI.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LiveBrowserConfig {
    schema_version: u8,
    audit_nonce: String,
    https_origin: String,
}
impl LiveBrowserConfig {
    fn validate(&self, expected_nonce: &str) -> LiveAuditResult<()> {
        let origin =
            url::Url::parse(&self.https_origin).map_err(|_| "audit_browser_origin_invalid")?;
        if self.schema_version != 1
            || self.audit_nonce != expected_nonce
            || expected_nonce.len() != 64
            || !expected_nonce
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || origin.scheme() != "https"
            || origin.host_str() != Some("owner.example.test")
            || origin.port().is_none_or(|port| port == 0)
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
            || origin.origin().ascii_serialization() != self.https_origin
        {
            return Err("audit_browser_origin_invalid");
        }
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LiveBrowserDone {
    schema_version: u8,
    audit_nonce: String,
    done: bool,
}
impl LiveBrowserDone {
    fn validate(&self, expected_nonce: &str) -> LiveAuditResult<()> {
        if self.schema_version != 1 || self.audit_nonce != expected_nonce || !self.done {
            return Err("audit_browser_done_invalid");
        }
        Ok(())
    }
}
#[cfg(windows)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveBrowserReady<'a> {
    schema_version: u8,
    audit_nonce: &'a str,
    invitation_secret: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveBrowserResult<'a> {
    schema_version: u8,
    audit_nonce: &'a str,
    stopped: bool,
    error: Option<&'static str>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct LiveAuditEvidence {
    schema_version: u8,
    audit_nonce: String,
    stage: &'static str,
    passed: bool,
    error: Option<&'static str>,
    socket_verified: bool,
    webauthn_verified: bool,
    login_verified: bool,
    csrf_verified: bool,
    origin_verified: bool,
    logout_verified: bool,
    snapshot_verified: bool,
    // Fixed diagnostic codes only; never reflect native content or identifiers.
    view_status: Option<&'static str>,
    latest_turn_status: Option<&'static str>,
    thread_matches: bool,
    continue_blocker: Option<&'static str>,
    latest_turn_matches: bool,
    model_matches: bool,
    turn_count: usize,
    item_count: usize,
    truncated: bool,
    ready: bool,
    continue_request_sent: bool,
    post_status: Option<&'static str>,
    post_submitted: Option<bool>,
    post_mutation_attempted: Option<bool>,
    operation_matches: bool,
    post_elapsed_ms: Option<u32>,
    canonical_receipt_matches: bool,
    canonical_refusal_verified: bool,
    acknowledgement_verified: bool,
    // Private monitor handoff only: never project this identifier publicly.
    #[serde(skip_serializing_if = "Option::is_none")]
    acknowledged_turn_id: Option<String>,
    receipt_verified: bool,
    duplicate_refused: bool,
    durable_ledger_verified: bool,
    native_error: Option<&'static str>,
    native_trace: Option<crate::codex_desktop::owner_remote::OwnerNativeTraceEvidence>,
}
fn live_audit_regular(path: &Path) -> LiveAuditResult<std::fs::Metadata> {
    let m = std::fs::symlink_metadata(path).map_err(|_| "audit_file_unavailable")?;
    if m.file_type().is_symlink() {
        return Err("audit_link_refused");
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if m.file_attributes() & 0x400 != 0 {
            return Err("audit_link_refused");
        }
    }
    Ok(m)
}
fn live_audit_read<T: serde::de::DeserializeOwned>(path: &Path) -> LiveAuditResult<T> {
    let m = live_audit_regular(path)?;
    if !m.is_file() || m.len() == 0 || m.len() > LIVE_AUDIT_LIMIT {
        return Err("audit_file_size");
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // Open reparse point itself, never follow it.
    }
    let file = options.open(path).map_err(|_| "audit_file_unavailable")?;
    let mut bytes = Vec::new();
    std::io::Read::take(file, LIVE_AUDIT_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "audit_file_unavailable")?;
    if bytes.len() as u64 > LIVE_AUDIT_LIMIT {
        return Err("audit_file_size");
    }
    serde_json::from_slice(&bytes).map_err(|_| "audit_file_invalid")
}
fn live_audit_write(path: &Path, value: &impl Serialize) -> LiveAuditResult<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| "audit_evidence_invalid")?;
    if bytes.len() as u64 > LIVE_AUDIT_LIMIT {
        return Err("audit_file_size");
    }
    let parent = path.parent().ok_or("audit_invalid_handoff_path")?;
    if !live_audit_regular(parent)?.is_dir() {
        return Err("audit_invalid_handoff_path");
    }
    let temporary = parent.join(format!(
        ".owner-live-evidence-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "audit_evidence_unavailable")?;
    let outcome = (|| {
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| "audit_evidence_unavailable")?;
        // Hard-link publication is atomic AND refuses an existing target on all
        // supported filesystems. A rename may overwrite on Windows/Unix.
        std::fs::hard_link(&temporary, path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "audit_evidence_exists"
            } else {
                "audit_evidence_unavailable"
            }
        })
    })();
    drop(file);
    // Only this create_new-owned temporary file is removed; no recursive IO.
    let cleanup = std::fs::remove_file(&temporary).map_err(|_| "audit_evidence_cleanup_failed");
    outcome.and(cleanup)
}
fn live_audit_handoff(path: &Path) -> LiveAuditResult<(PathBuf, LiveAuditRequest)> {
    if !path.is_absolute()
        || path.file_name().is_none_or(|v| v != "request.json")
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("audit_invalid_handoff_path");
    }
    let parent = path.parent().ok_or("audit_invalid_handoff_path")?;
    let temp = std::env::temp_dir()
        .canonicalize()
        .map_err(|_| "audit_temp_unavailable")?;
    let canonical = parent
        .canonicalize()
        .map_err(|_| "audit_temp_unavailable")?;
    if !canonical.starts_with(&temp)
        || canonical == temp
        || !canonical
            .file_name()
            .and_then(|v| v.to_str())
            .is_some_and(|v| v.starts_with("ccswitch-desktop-continuation-"))
    {
        return Err("audit_invalid_handoff_path");
    }
    let mut cursor = parent;
    loop {
        if !live_audit_regular(cursor)?.is_dir() {
            return Err("audit_invalid_handoff_path");
        }
        if cursor
            .canonicalize()
            .map_err(|_| "audit_temp_unavailable")?
            == temp
        {
            break;
        }
        cursor = cursor.parent().ok_or("audit_invalid_handoff_path")?;
    }
    for name in ["ready.json", "commit.json", "result.json"] {
        if canonical
            .join(name)
            .try_exists()
            .map_err(|_| "audit_file_unavailable")?
        {
            return Err("audit_handoff_not_fresh");
        }
    }
    let request: LiveAuditRequest = live_audit_read(path)?;
    request.validate()?;
    Ok((canonical, request))
}
struct LiveAuditSession {
    cookie: String,
    csrf: String,
}
struct LiveAuditHttp {
    client: reqwest::Client,
    address: std::net::SocketAddr,
}
struct LiveAuditResponse {
    status: u16,
    cookie: Option<String>,
    body: Value,
}
impl LiveAuditHttp {
    fn new(address: std::net::SocketAddr) -> LiveAuditResult<Self> {
        if !address.ip().is_loopback() {
            return Err("audit_non_loopback_refused");
        }
        Ok(Self {
            address,
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(45))
                .build()
                .map_err(|_| "audit_client_unavailable")?,
        })
    }
    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        session: Option<&LiveAuditSession>,
        csrf: bool,
        origin: &'static str,
    ) -> LiveAuditResult<LiveAuditResponse> {
        let mut request = self
            .client
            .request(method, format!("http://{}{}", self.address, path))
            .header("host", "owner.example.test")
            .header("origin", origin)
            .header("sec-fetch-site", "same-origin");
        if let Some(session) = session {
            request = request.header("cookie", &session.cookie);
            if csrf {
                request = request.header("x-ccsm-csrf", &session.csrf);
            }
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|_| "audit_http_unavailable")?;
        let status = response.status().as_u16();
        if response
            .content_length()
            .is_some_and(|n| n > RESPONSE_BODY_LIMIT as u64)
        {
            return Err("audit_response_size");
        }
        let cookie = response
            .headers()
            .get("set-cookie")
            .map(|v| {
                v.to_str()
                    .map(str::to_owned)
                    .map_err(|_| "audit_cookie_invalid")
            })
            .transpose()?;
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "audit_http_unavailable")?;
            if bytes.len().saturating_add(chunk.len()) > RESPONSE_BODY_LIMIT {
                return Err("audit_response_size");
            }
            bytes.extend_from_slice(&chunk);
        }
        let body = serde_json::from_slice(&bytes).map_err(|_| "audit_response_invalid")?;
        Ok(LiveAuditResponse {
            status,
            cookie,
            body,
        })
    }
    async fn get(
        &self,
        path: &str,
        session: Option<&LiveAuditSession>,
    ) -> LiveAuditResult<LiveAuditResponse> {
        self.request(reqwest::Method::GET, path, None, session, false, ORIGIN)
            .await
    }
    async fn post(
        &self,
        path: &str,
        body: Value,
        session: Option<&LiveAuditSession>,
    ) -> LiveAuditResult<LiveAuditResponse> {
        self.request(
            reqwest::Method::POST,
            path,
            Some(body),
            session,
            true,
            ORIGIN,
        )
        .await
    }
}
fn live_audit_session(response: LiveAuditResponse) -> LiveAuditResult<LiveAuditSession> {
    if response.status != 200 || response.body["authenticated"] != true {
        return Err("audit_authentication_failed");
    }
    let cookie = response.cookie.ok_or("audit_cookie_missing")?;
    if !cookie.starts_with("__Host-ccsm-owner=")
        || !["Secure", "HttpOnly", "SameSite=Strict", "Path=/"]
            .iter()
            .all(|v| cookie.contains(v))
        || cookie.contains("Domain=")
    {
        return Err("audit_cookie_invalid");
    }
    let csrf = response.body["csrfToken"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 256)
        .ok_or("audit_csrf_missing")?
        .to_owned();
    Ok(LiveAuditSession {
        cookie: cookie
            .split(';')
            .next()
            .ok_or("audit_cookie_invalid")?
            .to_owned(),
        csrf,
    })
}
async fn live_audit_enroll_login(
    http: &LiveAuditHttp,
    invitation: &str,
    evidence: &mut LiveAuditEvidence,
) -> LiveAuditResult<LiveAuditSession> {
    evidence.stage = "socket_authentication";
    if http.get("/remote/api/v1/session", None).await?.status != 401 {
        return Err("audit_unauthenticated_not_refused");
    }
    evidence.socket_verified = true;
    let options = http
        .post(
            "/remote/api/v1/session/enroll/options",
            json!({"invitationSecret":invitation,"label":"Isolated live audit"}),
            None,
        )
        .await?;
    if options.status != 200 {
        return Err("audit_enrollment_options_failed");
    }
    let ceremony = options.body["ceremonyId"]
        .as_str()
        .ok_or("audit_ceremony_missing")?
        .to_owned();
    let options = serde_json::from_value(json!({"publicKey":options.body["publicKey"]}))
        .map_err(|_| "audit_ceremony_invalid")?;
    let mut key = SoftPasskey::new(true);
    let registration = key
        .do_registration(
            url::Url::parse(ORIGIN).map_err(|_| "audit_origin_invalid")?,
            options,
        )
        .map_err(|_| "audit_registration_failed")?;
    let session = live_audit_session(http.post("/remote/api/v1/session/enroll/finish", json!({"ceremonyId":ceremony,"credential":serde_json::to_value(registration).map_err(|_| "audit_credential_invalid")?}), None).await?)?;
    evidence.webauthn_verified = true;
    let rejected = http
        .request(
            reqwest::Method::POST,
            "/remote/api/v1/session/logout",
            Some(json!({})),
            Some(&session),
            false,
            ORIGIN,
        )
        .await?;
    if rejected.status != 403 {
        return Err("audit_csrf_not_refused");
    }
    evidence.csrf_verified = true;
    let rejected = http
        .request(
            reqwest::Method::GET,
            "/remote/api/v1/session",
            None,
            Some(&session),
            false,
            "https://wrong.example.test",
        )
        .await?;
    if rejected.status != 403 {
        return Err("audit_origin_not_refused");
    }
    evidence.origin_verified = true;
    if http
        .post("/remote/api/v1/session/logout", json!({}), Some(&session))
        .await?
        .status
        != 200
        || http
            .get("/remote/api/v1/session", Some(&session))
            .await?
            .status
            != 401
    {
        return Err("audit_logout_not_refused");
    }
    evidence.logout_verified = true;
    let options = http
        .post("/remote/api/v1/session/auth/options", json!({}), None)
        .await?;
    if options.status != 200 {
        return Err("audit_login_options_failed");
    }
    let ceremony = options.body["ceremonyId"]
        .as_str()
        .ok_or("audit_ceremony_missing")?
        .to_owned();
    let options = serde_json::from_value(json!({"publicKey":options.body["publicKey"]}))
        .map_err(|_| "audit_ceremony_invalid")?;
    let assertion = key
        .do_authentication(
            url::Url::parse(ORIGIN).map_err(|_| "audit_origin_invalid")?,
            options,
        )
        .map_err(|_| "audit_assertion_failed")?;
    let session = live_audit_session(http.post("/remote/api/v1/session/auth/finish", json!({"ceremonyId":ceremony,"credential":serde_json::to_value(assertion).map_err(|_| "audit_credential_invalid")?}), None).await?)?;
    if http
        .get("/remote/api/v1/session", Some(&session))
        .await?
        .status
        != 200
    {
        return Err("audit_session_unavailable");
    }
    evidence.login_verified = true;
    Ok(session)
}
fn live_audit_fixture_database(request: &LiveAuditRequest) -> LiveAuditResult<Arc<Database>> {
    let root = crate::config::get_app_config_dir();
    std::fs::create_dir_all(&root).map_err(|_| "audit_home_unavailable")?;
    let config_path = crate::codex_config::get_codex_config_path();
    std::fs::create_dir_all(config_path.parent().ok_or("audit_home_unavailable")?)
        .map_err(|_| "audit_home_unavailable")?;
    let mut providers = toml::Table::new();
    providers.insert(request.provider_id.clone(), toml::Value::try_from(json!({"name":"Isolated live audit","base_url":request.fixture_base_url,"wire_api":"responses","requires_openai_auth":false})).map_err(|_| "audit_provider_invalid")?);
    let mut config = toml::Table::new();
    config.insert(
        "model".to_string(),
        toml::Value::String(request.model.clone()),
    );
    config.insert(
        "model_provider".to_string(),
        toml::Value::String(request.provider_id.clone()),
    );
    config.insert("model_providers".to_string(), toml::Value::Table(providers));
    let encoded = toml::to_string(&config).map_err(|_| "audit_provider_invalid")?;
    std::fs::write(config_path, encoded).map_err(|_| "audit_home_unavailable")?;
    let db = Arc::new(Database::memory().map_err(|_| "audit_database_unavailable")?);
    let provider = crate::provider::Provider::with_id(
        request.provider_id.clone(),
        "Isolated live audit".to_string(),
        json!({"modelCatalog":{"models":[{"id":request.model,"enabled":true}]}}),
        None,
    );
    db.save_provider("codex", &provider)
        .map_err(|_| "audit_database_unavailable")?;
    db.set_current_provider("codex", &request.provider_id)
        .map_err(|_| "audit_database_unavailable")?;
    Ok(db)
}
fn live_audit_native_error(body: &Value) -> Option<&'static str> {
    match body["error"].as_str() {
        Some("codex_unavailable") => Some("codex_unavailable"),
        Some("codex_target_ambiguous") => Some("codex_target_ambiguous"),
        Some("view_stale") => Some("view_stale"),
        Some("content_unavailable") => Some("content_unavailable"),
        Some("operation_unavailable") => Some("operation_unavailable"),
        _ => None,
    }
}
fn live_audit_view_diagnostics(
    content: &Value,
    expected_thread_id: &str,
    evidence: &mut LiveAuditEvidence,
) {
    evidence.view_status = Some(match content["status"].as_str() {
        Some("idle") => "idle",
        Some("active") => "active",
        Some("waiting") => "waiting",
        Some("error") => "error",
        _ => "unknown",
    });
    evidence.latest_turn_status = content["turns"]
        .as_array()
        .and_then(|turns| turns.last())
        .map(|turn| match turn["status"].as_str() {
            Some("completed") => "completed",
            Some("failed") => "failed",
            Some("interrupted") => "interrupted",
            Some("inProgress") => "inProgress",
            _ => "unknown",
        });
    evidence.thread_matches = content["threadId"] == expected_thread_id;
    evidence.continue_blocker = match content.get("continueBlocker") {
        Some(Value::Null) => None,
        Some(Value::String(code)) => Some(match code.as_str() {
            "thread_not_idle" => "thread_not_idle",
            "latest_turn_unavailable" => "latest_turn_unavailable",
            "model_unavailable" => "model_unavailable",
            "provider_unavailable" => "provider_unavailable",
            "thread_binding_unavailable" => "thread_binding_unavailable",
            "user_action_unavailable" => "user_action_unavailable",
            "user_action_changed" => "user_action_changed",
            "reference_unavailable" => "reference_unavailable",
            "mutation_evidence_unavailable" => "mutation_evidence_unavailable",
            _ => "unknown",
        }),
        _ => Some("unknown"),
    };
}
fn live_audit_snapshot_status_allows_continue(content: &Value) -> bool {
    content["status"] == "idle"
        || (content["status"] == "error"
            && content["turns"]
                .as_array()
                .and_then(|turns| turns.last())
                .and_then(|turn| turn["status"].as_str())
                .is_some_and(|status| matches!(status, "failed" | "interrupted")))
}
fn live_audit_bounded_elapsed_ms(elapsed: Duration) -> u32 {
    elapsed.as_millis().min(120_000) as u32
}
fn live_audit_receipt_schema_is_valid(body: &Value) -> bool {
    let Some(object) = body.as_object() else {
        return false;
    };
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "operationId" | "status" | "submitted" | "mutationAttempted" | "acknowledgedTurnId"
        )
    }) || body["operationId"]
        .as_str()
        .is_none_or(|operation| !safe_operation_id(operation))
    {
        return false;
    }
    let Some(submitted) = body["submitted"].as_bool() else {
        return false;
    };
    let Some(mutation_attempted) = body["mutationAttempted"].as_bool() else {
        return false;
    };
    let ack = body.get("acknowledgedTurnId");
    match body["status"].as_str() {
        Some("pending") => !submitted && ack.is_none(),
        Some("submitted") => {
            submitted
                && mutation_attempted
                && ack
                    .and_then(Value::as_str)
                    .is_some_and(|id| safe_identifier(id, 1, 256))
        }
        Some("uncertain") => !submitted && mutation_attempted && ack.is_none(),
        Some("refused") => !submitted && !mutation_attempted && ack.is_none(),
        _ => false,
    }
}
fn live_audit_post_receipt_diagnostics(
    body: &Value,
    operation: &str,
    initial_turn: &str,
    evidence: &mut LiveAuditEvidence,
) {
    evidence.post_status = Some(match body["status"].as_str() {
        Some("pending") => "pending",
        Some("submitted") => "submitted",
        Some("uncertain") => "uncertain",
        Some("refused") => "refused",
        _ => "unknown",
    });
    evidence.post_submitted = body["submitted"].as_bool();
    evidence.post_mutation_attempted = body["mutationAttempted"].as_bool();
    evidence.operation_matches = body["operationId"] == operation;
    evidence.acknowledgement_verified = false;
    evidence.acknowledged_turn_id = None;
    if evidence.operation_matches
        && live_audit_receipt_schema_is_valid(body)
        && body["status"] == "submitted"
        && body["acknowledgedTurnId"] != initial_turn
    {
        evidence.acknowledgement_verified = true;
        evidence.acknowledged_turn_id = body["acknowledgedTurnId"].as_str().map(str::to_owned);
    }
}
fn live_audit_reconcile_receipts(
    post: &Value,
    canonical_status: u16,
    canonical: &Value,
    operation: &str,
    evidence: &mut LiveAuditEvidence,
) -> LiveAuditResult<()> {
    evidence.canonical_receipt_matches = canonical_status == 200
        && post == canonical
        && post["operationId"] == operation
        && live_audit_receipt_schema_is_valid(post);
    evidence.canonical_refusal_verified = evidence.canonical_receipt_matches
        && post["status"] == "refused"
        && post["submitted"] == false
        && post["mutationAttempted"] == false
        && post.get("acknowledgedTurnId").is_none();
    if !evidence.acknowledgement_verified {
        return Err("audit_acknowledgement_unproven");
    }
    if !evidence.canonical_receipt_matches {
        return Err("audit_receipt_unproven");
    }
    evidence.receipt_verified = true;
    Ok(())
}
async fn live_audit_native_round_trip(
    directory: &Path,
    request: &LiveAuditRequest,
    service: &OwnerRemoteService,
    evidence: &mut LiveAuditEvidence,
) -> LiveAuditResult<()> {
    let invitation = service
        .create_local_invite()
        .await
        .map_err(|_| "audit_invitation_unavailable")?;
    let http = LiveAuditHttp::new(
        CONTROL_ADDRESS
            .parse()
            .map_err(|_| "audit_address_invalid")?,
    )?;
    let session = live_audit_enroll_login(&http, &invitation.invitation_secret, evidence).await?;
    evidence.stage = "native_owner_view";
    let response = http
        .get(
            &format!("/remote/api/v1/view?threadId={}", request.thread_id),
            Some(&session),
        )
        .await?;
    if response.status != 200 {
        evidence.native_error = live_audit_native_error(&response.body);
        return Err("audit_native_view_failed");
    }
    let content = &response.body["content"];
    live_audit_view_diagnostics(content, &request.thread_id, evidence);
    evidence.latest_turn_matches = content["latestTurnId"] == request.initial_turn_id;
    evidence.model_matches = content["model"] == request.model;
    let turns = content["turns"]
        .as_array()
        .ok_or("audit_snapshot_invalid")?;
    evidence.turn_count = turns.len();
    evidence.item_count = turns
        .iter()
        .map(|turn| {
            turn["items"]
                .as_array()
                .map(Vec::len)
                .ok_or("audit_snapshot_invalid")
        })
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .sum();
    evidence.truncated = content["truncated"]
        .as_bool()
        .ok_or("audit_snapshot_invalid")?;
    if content["threadId"] != request.thread_id
        || !live_audit_snapshot_status_allows_continue(content)
        || !evidence.latest_turn_matches
        || !evidence.model_matches
        || evidence.turn_count == 0
        || evidence.turn_count > 20
        || evidence.item_count > 120
    {
        return Err("audit_snapshot_binding_failed");
    }
    evidence.snapshot_verified = true;
    let view_id = response.body["viewId"]
        .as_str()
        .filter(|v| safe_identifier(v, 32, 128))
        .ok_or("audit_view_capability_unavailable")?
        .to_owned();
    if response.body["canContinue"] != true
        || response.body["expiresInSeconds"]
            .as_u64()
            .is_none_or(|v| v == 0 || v > 30)
    {
        return Err("audit_view_capability_unavailable");
    }
    evidence.stage = "owner_view_ready";
    evidence.ready = true;
    live_audit_write(&directory.join("ready.json"), evidence)?;
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        let path = directory.join("commit.json");
        if path.try_exists().map_err(|_| "audit_file_unavailable")? {
            let commit: LiveAuditCommit = live_audit_read(&path)?;
            if commit.schema_version != 1
                || commit.audit_nonce != request.audit_nonce
                || !commit.commit
            {
                return Err("audit_commit_invalid");
            }
            break;
        }
        if Instant::now() >= deadline {
            return Err("audit_commit_deadline");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let operation = format!("owner-{}", uuid::Uuid::new_v4().simple());
    evidence.stage = "native_owner_continue";
    evidence.continue_request_sent = true;
    let payload = json!({"viewId":view_id,"operationId":operation});
    let trace =
        crate::codex_desktop::owner_remote::OwnerNativeTraceRegistration::register(&operation)
            .ok_or("audit_native_trace_unavailable")?;
    let post_started = Instant::now();
    let response = http
        .post("/remote/api/v1/continue", payload.clone(), Some(&session))
        .await;
    evidence.post_elapsed_ms = Some(live_audit_bounded_elapsed_ms(post_started.elapsed()));
    evidence.native_trace = trace.snapshot();
    let response = response?;
    if response.status != 200 {
        evidence.native_error = live_audit_native_error(&response.body);
        return Err("audit_native_continue_failed");
    }
    live_audit_post_receipt_diagnostics(
        &response.body,
        &operation,
        &request.initial_turn_id,
        evidence,
    );
    // Every HTTP 200 gets one READ-ONLY canonical receipt lookup for the exact
    // generated operation, even for pending/refused/uncertain/malformed POSTs.
    // This is never a retry sender and never adopts a reflected operation ID.
    let receipt = http
        .get(
            &format!("/remote/api/v1/operations/{operation}"),
            Some(&session),
        )
        .await?;
    live_audit_reconcile_receipts(
        &response.body,
        receipt.status,
        &receipt.body,
        &operation,
        evidence,
    )?;
    // Deliberate duplicate rejection test only AFTER an affirmative ACK and GET.
    // Never retry after transport loss, timeout, unknown state or absent ACK.
    let duplicate = http
        .post("/remote/api/v1/continue", payload, Some(&session))
        .await?;
    if duplicate.status != 409 || duplicate.body["error"] != "view_unavailable" {
        return Err("audit_duplicate_not_refused");
    }
    evidence.duplicate_refused = true;
    if http
        .post("/remote/api/v1/session/logout", json!({}), Some(&session))
        .await?
        .status
        != 200
        || http
            .get("/remote/api/v1/session", Some(&session))
            .await?
            .status
            != 401
    {
        return Err("audit_final_logout_failed");
    }
    evidence.stage = "completed";
    evidence.passed = true;
    Ok(())
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[serial_test::serial]
#[ignore = "Requires the configured monitor's fresh disposable-thread handoff; never runs routinely"]
async fn live_owner_remote_socket_native_round_trip() {
    let path = std::env::var_os(LIVE_AUDIT_ENV)
        .map(PathBuf::from)
        .expect("explicit_live_owner_handoff_required");
    let (directory, request) = live_audit_handoff(&path).expect("invalid_live_owner_handoff");
    let mut evidence = LiveAuditEvidence {
        schema_version: 1,
        audit_nonce: request.audit_nonce.clone(),
        stage: "isolated_setup",
        ..Default::default()
    };
    let _home = crate::config::TestHomeGuard::new();
    let setup = live_audit_fixture_database(&request);
    let mut service = None;
    let outcome = match setup {
        Ok(db) => {
            let active = OwnerRemoteService::new(
                crate::config::get_app_config_dir().join("owner-remote"),
                db,
            );
            let started = active
                .start(ORIGIN)
                .await
                .map_err(|_| "audit_listener_unavailable");
            service = Some(active.clone());
            match started {
                Ok(status) if status.running && status.loopback_address == CONTROL_ADDRESS => {
                    live_audit_native_round_trip(&directory, &request, &active, &mut evidence).await
                }
                Ok(_) => Err("audit_listener_unavailable"),
                Err(error) => Err(error),
            }
        }
        Err(error) => Err(error),
    };
    if let Some(service) = service {
        service.shutdown().await;
    }
    if let Err(error) = outcome {
        evidence.error = Some(error);
    }
    // cfg(test) deliberately does not write the real recovery ledger. This audit
    // certifies canonical in-memory CAS/status + sender, NOT durable ledger IO.
    evidence.durable_ledger_verified = false;
    live_audit_write(&directory.join("result.json"), &evidence)
        .expect("live_owner_evidence_write_failed");
    assert!(outcome.is_ok(), "live_owner_remote_audit_failed");
}

#[cfg(windows)]
async fn live_browser_fixture_hold(
    directory: &Path,
    request: &LiveAuditRequest,
    service: &OwnerRemoteService,
) -> LiveAuditResult<()> {
    let invitation = service
        .create_local_invite()
        .await
        .map_err(|_| "audit_browser_invitation_unavailable")?;
    if !safe_identifier(&invitation.invitation_secret, 22, 256) {
        return Err("audit_browser_invitation_invalid");
    }
    live_audit_write(
        &directory.join("browser-ready.json"),
        &LiveBrowserReady {
            schema_version: 1,
            audit_nonce: &request.audit_nonce,
            invitation_secret: &invitation.invitation_secret,
        },
    )?;
    // This process owns no sender. It only keeps the isolated service alive for
    // the monitor's fresh browser and waits for an exclusive private stop file.
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let path = directory.join("browser-done.json");
        if path.try_exists().map_err(|_| "audit_file_unavailable")? {
            let done: LiveBrowserDone = live_audit_read(&path)?;
            done.validate(&request.audit_nonce)?;
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("audit_browser_deadline");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[serial_test::serial]
#[ignore = "Requires the configured monitor's explicit fresh browser fixture; never runs routinely"]
async fn live_owner_remote_browser_fixture() {
    let path = std::env::var_os(LIVE_AUDIT_ENV)
        .map(PathBuf::from)
        .expect("explicit_live_browser_handoff_required");
    let (directory, request) = live_audit_handoff(&path).expect("invalid_live_browser_handoff");
    let browser: LiveBrowserConfig = live_audit_read(&directory.join("browser-config.json"))
        .expect("invalid_live_browser_configuration");
    browser
        .validate(&request.audit_nonce)
        .expect("invalid_live_browser_configuration");
    for name in [
        "browser-ready.json",
        "browser-done.json",
        "browser-result.json",
    ] {
        assert!(
            !directory.join(name).try_exists().unwrap_or(true),
            "live_browser_handoff_not_fresh"
        );
    }
    let _home = crate::config::TestHomeGuard::new();
    let mut service = None;
    let outcome = match live_audit_fixture_database(&request) {
        Ok(db) => {
            let active = OwnerRemoteService::new(
                crate::config::get_app_config_dir().join("owner-remote"),
                db,
            );
            let started = active
                .start(&browser.https_origin)
                .await
                .map_err(|_| "audit_browser_listener_unavailable");
            service = Some(active.clone());
            match started {
                Ok(status) if status.running && status.loopback_address == CONTROL_ADDRESS => {
                    live_browser_fixture_hold(&directory, &request, &active).await
                }
                Ok(_) => Err("audit_browser_listener_unavailable"),
                Err(error) => Err(error),
            }
        }
        Err(error) => Err(error),
    };
    if let Some(service) = service {
        service.shutdown().await;
    }
    live_audit_write(
        &directory.join("browser-result.json"),
        &LiveBrowserResult {
            schema_version: 1,
            audit_nonce: &request.audit_nonce,
            stopped: true,
            error: outcome.err(),
        },
    )
    .expect("live_browser_evidence_write_failed");
    assert!(outcome.is_ok(), "live_owner_remote_browser_fixture_failed");
}

#[tokio::test]
async fn socket_passkey_round_trip_uses_actual_http_and_real_verifier() {
    let (_dir, state) = test_state();
    let invitation = state
        .auth
        .create_local_invite()
        .expect("isolated_invitation");
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("isolated_listener");
    let address = listener.local_addr().expect("isolated_address");
    let (stop, stopped) = oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        axum::serve(listener, remote_router(state))
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
    });
    let mut evidence = LiveAuditEvidence::default();
    let result = match LiveAuditHttp::new(address) {
        Ok(http) => live_audit_enroll_login(&http, &invitation.invitation_secret, &mut evidence)
            .await
            .map(|_| ()),
        Err(error) => Err(error),
    };
    let _ = stop.send(());
    let joined = task.await;
    assert!(result.is_ok(), "socket_passkey_round_trip_failed");
    assert!(
        joined.is_ok_and(|result| result.is_ok()),
        "socket_listener_cleanup_failed"
    );
    assert!(
        evidence.socket_verified
            && evidence.webauthn_verified
            && evidence.login_verified
            && evidence.csrf_verified
            && evidence.origin_verified
            && evidence.logout_verified
    );
}
#[test]
fn live_owner_handoff_schema_refuses_unowned_model_remote_url_and_extra_fields() {
    let base = json!({"schemaVersion":1,"auditNonce":"0".repeat(64),"threadId":"thread-fixture","initialTurnId":"turn-fixture","model":"fixture-model","providerId":"provider-fixture","fixtureBaseUrl":"http://127.0.0.1:12345/v1","expectedRendererFingerprint":format!("sha256-{}", "a".repeat(64))});
    let valid: LiveAuditRequest = serde_json::from_value(base.clone()).expect("valid_fixture");
    assert!(valid.validate().is_ok());
    for (key, value) in [
        ("model", json!("real-model")),
        ("fixtureBaseUrl", json!("https://example.test/v1")),
        (
            "fixtureBaseUrl",
            json!("http://127.0.0.1:12345/v1?secret=redacted"),
        ),
        ("auditNonce", json!("short")),
        ("threadId", json!("../other-thread")),
    ] {
        let mut changed = base.clone();
        changed[key] = value;
        let invalid: LiveAuditRequest = serde_json::from_value(changed).expect("fixture_shape");
        assert!(invalid.validate().is_err());
    }
    let mut extra = base;
    extra["prompt"] = json!("redacted");
    assert!(serde_json::from_value::<LiveAuditRequest>(extra).is_err());
}
#[test]
fn live_owner_commit_schema_is_exact_and_evidence_never_replays_over_existing_file() {
    assert!(serde_json::from_value::<LiveAuditCommit>(
        json!({"schemaVersion":1,"auditNonce":"0".repeat(64),"commit":true,"threadId":"untrusted"})
    )
    .is_err());
    let dir = tempfile::tempdir().expect("isolated_fixture");
    let path = dir.path().join("result.json");
    assert!(live_audit_write(&path, &json!({"fixed":true})).is_ok());
    assert_eq!(
        live_audit_write(&path, &json!({"fixed":false})),
        Err("audit_evidence_exists")
    );
    assert_eq!(
        live_audit_read::<Value>(&path).expect("read_fixture"),
        json!({"fixed":true})
    );
}

#[test]
fn live_owner_view_diagnostics_project_fixed_codes_and_never_reflect_content() {
    let mut evidence = LiveAuditEvidence::default();
    let defaults = serde_json::to_value(&evidence).expect("diagnostic_defaults");
    assert!(defaults["viewStatus"].is_null());
    assert!(defaults["latestTurnStatus"].is_null());
    assert_eq!(defaults["threadMatches"], false);
    assert!(defaults["continueBlocker"].is_null());
    assert!(defaults["postStatus"].is_null());
    assert!(defaults["postSubmitted"].is_null());
    assert!(defaults["postMutationAttempted"].is_null());
    assert_eq!(defaults["operationMatches"], false);
    assert!(defaults["postElapsedMs"].is_null());
    assert_eq!(defaults["canonicalReceiptMatches"], false);
    assert_eq!(defaults["canonicalRefusalVerified"], false);
    assert!(defaults["nativeTrace"].is_null());
    for status in ["idle", "active", "waiting", "error", "unknown"] {
        live_audit_view_diagnostics(
            &json!({"threadId":"fixture-thread","status":status,"continueBlocker":null}),
            "fixture-thread",
            &mut evidence,
        );
        assert_eq!(evidence.view_status, Some(status));
        assert!(evidence.thread_matches);
        assert!(evidence.continue_blocker.is_none());
    }
    for blocker in [
        "thread_not_idle",
        "latest_turn_unavailable",
        "model_unavailable",
        "provider_unavailable",
        "thread_binding_unavailable",
        "user_action_unavailable",
        "user_action_changed",
        "reference_unavailable",
        "mutation_evidence_unavailable",
    ] {
        live_audit_view_diagnostics(
            &json!({"threadId":"other-fixture","status":"unknown","continueBlocker":blocker}),
            "fixture-thread",
            &mut evidence,
        );
        assert_eq!(evidence.continue_blocker, Some(blocker));
        assert!(!evidence.thread_matches);
    }
    for native in [
        json!({"threadId":"private-fixture-marker","status":"reflected-fixture-marker","continueBlocker":"reflected-fixture-marker"}),
        json!({"threadId":"private-fixture-marker","status":{"secret":"reflected-fixture-marker"},"continueBlocker":{"secret":"reflected-fixture-marker"}}),
        json!({}),
    ] {
        live_audit_view_diagnostics(&native, "fixture-thread", &mut evidence);
        assert_eq!(evidence.view_status, Some("unknown"));
        assert_eq!(evidence.continue_blocker, Some("unknown"));
        assert!(!evidence.thread_matches);
        let encoded = serde_json::to_string(&evidence).expect("diagnostic_evidence");
        assert!(!encoded.contains("private-fixture-marker"));
        assert!(!encoded.contains("reflected-fixture-marker"));
    }
}

#[test]
fn live_owner_snapshot_requires_idle_or_error_with_latest_failure() {
    assert!(live_audit_snapshot_status_allows_continue(
        &json!({"status":"idle","turns":[{"status":"completed"}]})
    ));
    for status in ["failed", "interrupted"] {
        assert!(live_audit_snapshot_status_allows_continue(
            &json!({"status":"error","turns":[{"status":status}]})
        ));
    }
    for view_status in ["active", "waiting", "unknown", "notLoaded", "systemError"] {
        assert!(!live_audit_snapshot_status_allows_continue(
            &json!({"status":view_status,"turns":[{"status":"failed"}]})
        ));
    }
    for content in [
        json!({"status":"error","turns":[{"status":"completed"}]}),
        json!({"status":"error","turns":[{"status":"inProgress"}]}),
        json!({"status":"error","turns":[{"status":"unknown"}]}),
        json!({"status":"error","turns":[{"status":"failed"},{"status":"completed"}]}),
        json!({"status":"error","turns":[{}]}),
        json!({"status":"error","turns":[]}),
        json!({"status":"error"}),
    ] {
        assert!(!live_audit_snapshot_status_allows_continue(&content));
    }
}
#[test]
fn live_owner_latest_turn_diagnostic_never_reflects_native_status() {
    let mut evidence = LiveAuditEvidence::default();
    for status in [
        "completed",
        "failed",
        "interrupted",
        "inProgress",
        "unknown",
    ] {
        live_audit_view_diagnostics(
            &json!({"status":"error","turns":[{"status":status}]}),
            "fixture-thread",
            &mut evidence,
        );
        assert_eq!(evidence.latest_turn_status, Some(status));
    }
    for status in [
        json!("private-status-marker"),
        json!({"private":"private-status-marker"}),
        Value::Null,
    ] {
        live_audit_view_diagnostics(
            &json!({"status":"error","turns":[{"status":status}]}),
            "fixture-thread",
            &mut evidence,
        );
        assert_eq!(evidence.latest_turn_status, Some("unknown"));
        assert!(!serde_json::to_string(&evidence)
            .expect("diagnostic_evidence")
            .contains("private-status-marker"));
    }
    live_audit_view_diagnostics(
        &json!({"status":"error","turns":[]}),
        "fixture-thread",
        &mut evidence,
    );
    assert!(evidence.latest_turn_status.is_none());
}

#[tokio::test]
async fn live_owner_receipt_reconciliation_uses_actual_canonical_http_schema() {
    use crate::proxy::codex_turn_recovery::OwnerContinuationStatus;
    let operation = format!("owner-{}", "a".repeat(32));
    for (status, expected_status, submitted, mutation_attempted) in [
        (OwnerContinuationStatus::Reserved, "pending", false, false),
        (OwnerContinuationStatus::Committing, "pending", false, true),
        (OwnerContinuationStatus::Submitted, "submitted", true, true),
        (OwnerContinuationStatus::Uncertain, "uncertain", false, true),
        (OwnerContinuationStatus::Refused, "refused", false, false),
    ] {
        let response = operation_response(OwnerContinuationReceipt {
            operation_id: operation.clone(),
            status,
            submitted,
            mutation_attempted,
            acknowledged_turn_id: submitted.then(|| "acknowledged-fixture-turn".to_owned()),
        })
        .expect("canonical_http_receipt");
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("bounded_fixture_body")
            .to_bytes();
        let body: Value = serde_json::from_slice(&bytes).expect("canonical_fixture_json");
        let mut evidence = LiveAuditEvidence::default();
        live_audit_post_receipt_diagnostics(
            &body,
            &operation,
            "initial-fixture-turn",
            &mut evidence,
        );
        let result = live_audit_reconcile_receipts(&body, 200, &body, &operation, &mut evidence);
        assert_eq!(evidence.post_status, Some(expected_status));
        assert_eq!(evidence.post_submitted, Some(submitted));
        assert_eq!(evidence.post_mutation_attempted, Some(mutation_attempted));
        assert!(evidence.operation_matches);
        assert!(evidence.canonical_receipt_matches);
        assert_eq!(
            evidence.canonical_refusal_verified,
            expected_status == "refused"
        );
        assert_eq!(evidence.acknowledgement_verified, submitted);
        assert_eq!(evidence.receipt_verified, submitted);
        assert_eq!(result.is_ok(), submitted);
        assert!(!evidence.duplicate_refused);
        assert!(!evidence.passed);
    }
}
#[test]
fn live_owner_receipt_reconciliation_never_infers_refusal_from_unknown_or_mismatch() {
    let operation = format!("owner-{}", "a".repeat(32));
    let refusal = json!({"operationId":operation,"status":"refused","submitted":false,"mutationAttempted":false});
    let mut invalid_bodies = Vec::new();
    for (key, value) in [
        ("operationId", json!(format!("owner-{}", "b".repeat(32)))),
        ("status", json!("private-reflected-status")),
        ("status", json!("uncertain")),
        ("submitted", Value::Null),
        ("submitted", json!(true)),
        ("mutationAttempted", Value::Null),
        ("mutationAttempted", json!(true)),
        ("acknowledgedTurnId", json!("private-ack-marker")),
        ("acknowledgedTurnId", Value::Null),
        ("extraSecret", json!("private-reflected-status")),
    ] {
        let mut body = refusal.clone();
        body[key] = value;
        invalid_bodies.push(body);
    }
    let mut missing = refusal.clone();
    missing
        .as_object_mut()
        .expect("fixture_object")
        .remove("mutationAttempted");
    invalid_bodies.extend([missing, Value::Null, json!({})]);
    for body in invalid_bodies {
        let mut evidence = LiveAuditEvidence::default();
        live_audit_post_receipt_diagnostics(
            &body,
            &operation,
            "initial-fixture-turn",
            &mut evidence,
        );
        assert!(
            live_audit_reconcile_receipts(&body, 200, &body, &operation, &mut evidence).is_err()
        );
        assert!(!evidence.canonical_refusal_verified);
        assert!(!evidence.canonical_receipt_matches);
        assert!(!evidence.acknowledgement_verified);
        assert!(!evidence.receipt_verified);
        assert!(!evidence.duplicate_refused);
        let encoded = serde_json::to_string(&evidence).expect("finite_receipt_evidence");
        assert!(!encoded.contains("private-reflected-status"));
        assert!(!encoded.contains("private-ack-marker"));
    }
    for (http_status, canonical) in [
        (404, refusal.clone()),
        (
            200,
            json!({"operationId":operation,"status":"pending","submitted":false,"mutationAttempted":false}),
        ),
        (
            200,
            json!({"operationId":format!("owner-{}", "b".repeat(32)),"status":"refused","submitted":false,"mutationAttempted":false}),
        ),
    ] {
        let mut evidence = LiveAuditEvidence::default();
        live_audit_post_receipt_diagnostics(
            &refusal,
            &operation,
            "initial-fixture-turn",
            &mut evidence,
        );
        assert!(live_audit_reconcile_receipts(
            &refusal,
            http_status,
            &canonical,
            &operation,
            &mut evidence
        )
        .is_err());
        assert!(!evidence.canonical_refusal_verified);
        assert!(!evidence.canonical_receipt_matches);
        assert!(!evidence.receipt_verified);
    }
    assert_eq!(live_audit_bounded_elapsed_ms(Duration::from_millis(42)), 42);
    assert_eq!(
        live_audit_bounded_elapsed_ms(Duration::from_secs(121)),
        120_000
    );
}
#[test]
fn live_owner_submitted_receipt_requires_new_safe_acknowledgement_and_exact_get() {
    let operation = format!("owner-{}", "a".repeat(32));
    for ack in ["initial-fixture-turn", "../unsafe", ""] {
        let body = json!({"operationId":operation,"status":"submitted","submitted":true,"mutationAttempted":true,"acknowledgedTurnId":ack});
        let mut evidence = LiveAuditEvidence::default();
        live_audit_post_receipt_diagnostics(
            &body,
            &operation,
            "initial-fixture-turn",
            &mut evidence,
        );
        assert!(
            live_audit_reconcile_receipts(&body, 200, &body, &operation, &mut evidence).is_err()
        );
        assert!(!evidence.acknowledgement_verified);
        assert!(evidence.acknowledged_turn_id.is_none());
        assert!(!evidence.receipt_verified);
        assert!(!evidence.canonical_refusal_verified);
    }
}

#[test]
fn live_owner_browser_fixture_config_accepts_only_private_fixed_https_origin() {
    let nonce = "a".repeat(64);
    let valid = json!({"schemaVersion":1,"auditNonce":nonce,"httpsOrigin":"https://owner.example.test:49152"});
    let config: LiveBrowserConfig = serde_json::from_value(valid.clone()).expect("browser_config");
    assert!(config.validate(&nonce).is_ok());
    for origin in [
        "http://owner.example.test:49152",
        "https://owner.example.test",
        "https://owner.example.test:0",
        "https://owner.example.test:443",
        "https://owner.example.test:49152/",
        "https://another.example.test:49152",
        "https://owner.example.test.evil:49152",
        "https://127.0.0.1:49152",
        "https://secret@owner.example.test:49152",
        "https://owner.example.test:49152/remote/",
        "https://owner.example.test:49152?private=redacted",
        "https://owner.example.test:49152#private-redacted",
    ] {
        let value = json!({"schemaVersion":1,"auditNonce":nonce,"httpsOrigin":origin});
        let config: LiveBrowserConfig = serde_json::from_value(value).expect("browser_config");
        assert_eq!(config.validate(&nonce), Err("audit_browser_origin_invalid"));
    }
    for extra in ["cookie", "invitationSecret", "operationId", "credential"] {
        let mut value = valid.clone();
        value[extra] = json!("redacted-private");
        assert!(serde_json::from_value::<LiveBrowserConfig>(value).is_err());
    }
    let mut wrong_nonce: LiveBrowserConfig = serde_json::from_value(valid).expect("browser_config");
    wrong_nonce.audit_nonce = "b".repeat(64);
    assert_eq!(
        wrong_nonce.validate(&nonce),
        Err("audit_browser_origin_invalid")
    );
}

#[test]
fn live_owner_browser_fixture_stop_schema_has_no_mutation_authority() {
    let nonce = "a".repeat(64);
    let valid = json!({"schemaVersion":1,"auditNonce":nonce,"done":true});
    let done: LiveBrowserDone = serde_json::from_value(valid.clone()).expect("browser_done");
    assert!(done.validate(&nonce).is_ok());
    for value in [
        json!({"schemaVersion":2,"auditNonce":nonce,"done":true}),
        json!({"schemaVersion":1,"auditNonce":"b".repeat(64),"done":true}),
        json!({"schemaVersion":1,"auditNonce":nonce,"done":false}),
    ] {
        let done: LiveBrowserDone = serde_json::from_value(value).expect("browser_done");
        assert_eq!(done.validate(&nonce), Err("audit_browser_done_invalid"));
    }
    for extra in [
        "cookie",
        "threadId",
        "operationId",
        "acknowledgedTurnId",
        "commit",
    ] {
        let mut value = valid.clone();
        value[extra] = json!("redacted-private");
        assert!(serde_json::from_value::<LiveBrowserDone>(value).is_err());
    }
    let result = serde_json::to_value(LiveBrowserResult {
        schema_version: 1,
        audit_nonce: &nonce,
        stopped: true,
        error: Some("audit_browser_deadline"),
    })
    .expect("browser_result");
    assert_eq!(result.as_object().map(|object| object.len()), Some(4));
    assert_eq!(result["error"], "audit_browser_deadline");
    assert!(!result.to_string().contains("redacted-private"));
}
