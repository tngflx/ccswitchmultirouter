//! Opt-in owner-only console, never an inference/CDP/Tauri gateway.
pub(crate) mod auth;

use crate::codex_desktop::owner_remote::{
    list_codex_owner_remote_conversations, read_codex_owner_remote_view,
    submit_codex_owner_continuation, CodexOwnerRemoteView,
};
use crate::database::Database;
use crate::proxy::codex_turn_recovery::{
    read_owner_continuation_receipt, OwnerContinuationReceipt,
};
pub use auth::OwnerInvite;
use auth::{
    AuthError, OwnerManagementAction, OwnerPrincipal, OwnerRemoteAuth, OwnerSessionIssued,
    CLEAR_OWNER_COOKIE,
};
use axum::{
    extract::{
        rejection::{JsonRejection, PathRejection, QueryRejection},
        DefaultBodyLimit, Path as AxumPath, Query, State,
    },
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fmt,
    io::Read,
    net::{Ipv4Addr, SocketAddrV4},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::{
    sync::{oneshot, Mutex as AsyncMutex, Semaphore},
    task::JoinHandle,
};

const CONTROL_PORT: u16 = 15723;
pub(crate) const CONTROL_ADDRESS: &str = "127.0.0.1:15723";
const CONFIG_FILE: &str = "control.json";
const AUTH_FILE: &str = "owner-remote-auth.sqlite";
const CONFIG_VERSION: u8 = 1;
const REQUEST_BODY_LIMIT: usize = 64 * 1024;
const RESPONSE_BODY_LIMIT: usize = 512 * 1024;
const REQUEST_BODY_TIMEOUT: Duration = Duration::from_secs(10);
const VIEW_LIMIT: usize = 32;
const VIEW_TTL: Duration = Duration::from_secs(30);
const RATE_WINDOW: Duration = Duration::from_secs(60);

/// Local-only; never put owner trust in the exported/synced main DB.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalRemoteConfig {
    version: u8,
    enabled: bool,
    https_origin: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerRemoteStatus {
    pub enabled: bool,
    pub running: bool,
    pub https_origin: Option<String>,
    pub loopback_address: &'static str,
    pub host_id: Option<String>,
    pub error: Option<&'static str>,
}

#[derive(Clone, Copy)]
pub(crate) enum OwnerRemoteServiceError {
    Configuration,
    Storage,
    ListenerUnavailable,
    NotRunning,
    Authentication,
}
impl OwnerRemoteServiceError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::Configuration => "owner_remote_configuration_unavailable",
            Self::Storage => "owner_remote_storage_unavailable",
            Self::ListenerUnavailable => "owner_remote_listener_unavailable",
            Self::NotRunning => "owner_remote_not_running",
            Self::Authentication => "owner_remote_authentication_unavailable",
        }
    }
}
impl fmt::Display for OwnerRemoteServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl fmt::Debug for OwnerRemoteServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}
impl std::error::Error for OwnerRemoteServiceError {}

struct RunningServer {
    auth: Arc<OwnerRemoteAuth>,
    active: Arc<AtomicBool>,
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}
struct ServiceInner {
    local_dir: PathBuf,
    db: Arc<Database>,
    server: AsyncMutex<Option<RunningServer>>,
    shutdown_requested: Arc<AtomicBool>,
}

/// Constructor has no I/O. Desktop setup restores only explicit persisted opt-in.
#[derive(Clone)]
pub(crate) struct OwnerRemoteService {
    inner: Arc<ServiceInner>,
}
impl OwnerRemoteService {
    pub(crate) fn new(local_dir: PathBuf, db: Arc<Database>) -> Self {
        Self {
            inner: Arc::new(ServiceInner {
                local_dir,
                db,
                server: AsyncMutex::new(None),
                shutdown_requested: Arc::new(AtomicBool::new(false)),
            }),
        }
    }
    pub(crate) async fn restore(&self) -> Result<(), OwnerRemoteServiceError> {
        let mut server = self.inner.server.lock().await;
        if let Some(config) = read_local_config(&self.inner.local_dir)? {
            if config.enabled {
                self.start_locked(&mut server, &config.https_origin).await?;
            }
        }
        Ok(())
    }
    pub(crate) async fn start(
        &self,
        https_origin: &str,
    ) -> Result<OwnerRemoteStatus, OwnerRemoteServiceError> {
        let mut server = self.inner.server.lock().await;
        self.start_locked(&mut server, https_origin).await
    }
    async fn start_locked(
        &self,
        server: &mut Option<RunningServer>,
        https_origin: &str,
    ) -> Result<OwnerRemoteStatus, OwnerRemoteServiceError> {
        self.start_locked_on_port(server, https_origin, CONTROL_PORT)
            .await
    }
    // Public startup always uses the fixed loopback control port. The private
    // port parameter lets isolated tests exercise bind failure and retry without
    // competing with a running desktop installation.
    async fn start_locked_on_port(
        &self,
        server: &mut Option<RunningServer>,
        https_origin: &str,
        control_port: u16,
    ) -> Result<OwnerRemoteStatus, OwnerRemoteServiceError> {
        if self.inner.shutdown_requested.load(Ordering::SeqCst) {
            return Err(OwnerRemoteServiceError::NotRunning);
        }
        if let Some(running) = server.as_ref() {
            if running.active.load(Ordering::SeqCst)
                && !running.task.is_finished()
                && running.auth.origin() == https_origin
            {
                return Ok(running_status(running));
            }
            if running.auth.origin() != https_origin {
                return Err(OwnerRemoteServiceError::Configuration);
            }
            shutdown_running(server.take()).await;
        }
        std::fs::create_dir_all(&self.inner.local_dir)
            .map_err(|_| OwnerRemoteServiceError::Storage)?;
        let auth = Arc::new(
            OwnerRemoteAuth::open(&self.inner.local_dir.join(AUTH_FILE), https_origin)
                .map_err(|_| OwnerRemoteServiceError::Authentication)?,
        );
        let listener =
            tokio::net::TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, control_port))
                .await
                .map_err(|_| OwnerRemoteServiceError::ListenerUnavailable)?;
        if self.inner.shutdown_requested.load(Ordering::SeqCst) {
            return Err(OwnerRemoteServiceError::NotRunning);
        }
        // Publishing the listener requires durable opt-in. No firewall changes.
        write_local_config(
            &self.inner.local_dir,
            &LocalRemoteConfig {
                version: CONFIG_VERSION,
                enabled: true,
                https_origin: auth.origin().to_string(),
            },
        )?;
        let active = Arc::new(AtomicBool::new(true));
        let router = remote_router(RouterState::new(
            auth.clone(),
            active.clone(),
            self.inner.shutdown_requested.clone(),
            self.inner.db.clone(),
        ));
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let task_active = active.clone();
        let task = tokio::spawn(async move {
            let _result = axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
            // Reflected network/auth/CDP errors must not reach logs.
            task_active.store(false, Ordering::SeqCst);
        });
        let running = RunningServer {
            auth,
            active,
            shutdown: Some(shutdown_tx),
            task,
        };
        let status = running_status(&running);
        *server = Some(running);
        Ok(status)
    }
    pub(crate) async fn stop(&self) -> Result<OwnerRemoteStatus, OwnerRemoteServiceError> {
        let mut server = self.inner.server.lock().await;
        if let Some(running) = server.as_ref() {
            running.active.store(false, Ordering::SeqCst);
        }
        let existing = read_local_config(&self.inner.local_dir);
        let origin = server
            .as_ref()
            .map(|s| s.auth.origin().to_string())
            .or_else(|| {
                existing
                    .as_ref()
                    .ok()
                    .and_then(|v| v.as_ref())
                    .map(|v| v.https_origin.clone())
            });
        let persisted = match origin {
            Some(https_origin) => write_local_config(
                &self.inner.local_dir,
                &LocalRemoteConfig {
                    version: CONFIG_VERSION,
                    enabled: false,
                    https_origin,
                },
            ),
            None if matches!(existing, Ok(None)) => Ok(()),
            None => Err(OwnerRemoteServiceError::Configuration),
        };
        // Even failed persistence closes this runtime; report failure honestly.
        shutdown_running(server.take()).await;
        persisted?;
        Ok(self.status_without_lock())
    }
    /// Exit preserves opt-in/enrollment and never clears native mutation evidence.
    pub(crate) async fn shutdown(&self) {
        self.inner.shutdown_requested.store(true, Ordering::SeqCst);
        let mut server = self.inner.server.lock().await;
        shutdown_running(server.take()).await;
    }
    pub(crate) async fn status(&self) -> OwnerRemoteStatus {
        let server = self.inner.server.lock().await;
        server
            .as_ref()
            .map(running_status)
            .unwrap_or_else(|| self.status_without_lock())
    }
    fn status_without_lock(&self) -> OwnerRemoteStatus {
        let config = read_local_config(&self.inner.local_dir);
        let known = config.as_ref().ok().and_then(|v| v.as_ref());
        // Auth trust can be durably pinned before listener/config publication
        // succeeds. Observe that existing pin without invoking enrolling open().
        let (pinned_origin, auth_error) =
            match OwnerRemoteAuth::read_pinned_origin(&self.inner.local_dir.join(AUTH_FILE)) {
                Ok(origin) => (origin, None),
                Err(_) => (None, Some(OwnerRemoteServiceError::Authentication)),
            };
        let error = config.as_ref().err().copied().or(auth_error).or_else(|| {
            match (known, pinned_origin.as_deref()) {
                (Some(config), Some(origin)) if config.https_origin != origin => {
                    Some(OwnerRemoteServiceError::Configuration)
                }
                _ => None,
            }
        });
        OwnerRemoteStatus {
            enabled: known.is_some_and(|v| v.enabled),
            running: false,
            https_origin: pinned_origin.or_else(|| known.map(|v| v.https_origin.clone())),
            loopback_address: CONTROL_ADDRESS,
            host_id: None,
            error: error.map(OwnerRemoteServiceError::code),
        }
    }
    pub(crate) async fn create_local_invite(&self) -> Result<OwnerInvite, OwnerRemoteServiceError> {
        let server = self.inner.server.lock().await;
        let running = server
            .as_ref()
            .filter(|s| s.active.load(Ordering::SeqCst) && !s.task.is_finished())
            .ok_or(OwnerRemoteServiceError::NotRunning)?;
        running
            .auth
            .create_local_invite()
            .map_err(|_| OwnerRemoteServiceError::Authentication)
    }
}
fn running_status(running: &RunningServer) -> OwnerRemoteStatus {
    let running_now = running.active.load(Ordering::SeqCst) && !running.task.is_finished();
    OwnerRemoteStatus {
        enabled: true,
        running: running_now,
        https_origin: Some(running.auth.origin().to_string()),
        loopback_address: CONTROL_ADDRESS,
        host_id: Some(running.auth.host_id().to_string()),
        error: (!running_now).then_some("owner_remote_listener_unavailable"),
    }
}
async fn shutdown_running(running: Option<RunningServer>) {
    let Some(mut running) = running else {
        return;
    };
    running.active.store(false, Ordering::SeqCst);
    if let Some(shutdown) = running.shutdown.take() {
        let _ = shutdown.send(());
    }
    if tokio::time::timeout(Duration::from_secs(3), &mut running.task)
        .await
        .is_err()
    {
        running.task.abort();
        let _ = running.task.await;
    }
}
fn read_local_config(
    local_dir: &Path,
) -> Result<Option<LocalRemoteConfig>, OwnerRemoteServiceError> {
    let file = match std::fs::File::open(local_dir.join(CONFIG_FILE)) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(OwnerRemoteServiceError::Storage),
    };
    let mut encoded = Vec::with_capacity(4097);
    file.take(4097)
        .read_to_end(&mut encoded)
        .map_err(|_| OwnerRemoteServiceError::Storage)?;
    if encoded.len() > 4096 {
        return Err(OwnerRemoteServiceError::Configuration);
    }
    let config: LocalRemoteConfig =
        serde_json::from_slice(&encoded).map_err(|_| OwnerRemoteServiceError::Configuration)?;
    if config.version != CONFIG_VERSION || config.https_origin.is_empty() {
        return Err(OwnerRemoteServiceError::Configuration);
    }
    Ok(Some(config))
}
fn write_local_config(
    local_dir: &Path,
    config: &LocalRemoteConfig,
) -> Result<(), OwnerRemoteServiceError> {
    std::fs::create_dir_all(local_dir).map_err(|_| OwnerRemoteServiceError::Storage)?;
    let encoded =
        serde_json::to_string(config).map_err(|_| OwnerRemoteServiceError::Configuration)?;
    crate::config::atomic_write_private(&local_dir.join(CONFIG_FILE), encoded.as_bytes())
        .map_err(|_| OwnerRemoteServiceError::Storage)
}

trait BoundOwnerView {
    fn thread_id(&self) -> &str;
    fn remaining_lifetime(&self) -> Duration {
        VIEW_TTL
    }
}
impl BoundOwnerView for CodexOwnerRemoteView {
    fn thread_id(&self) -> &str {
        CodexOwnerRemoteView::thread_id(self)
    }
    fn remaining_lifetime(&self) -> Duration {
        CodexOwnerRemoteView::remaining_lifetime(self)
    }
}
struct CapturedView<T> {
    session_id: String,
    snapshot: T,
    expires_at: Instant,
}
struct ViewCapabilities<T = CodexOwnerRemoteView> {
    views: HashMap<String, CapturedView<T>>,
}
impl<T> Default for ViewCapabilities<T> {
    fn default() -> Self {
        Self {
            views: HashMap::new(),
        }
    }
}
impl<T: BoundOwnerView> ViewCapabilities<T> {
    fn insert(&mut self, session_id: &str, snapshot: T) -> Result<String, HttpError> {
        let now = Instant::now();
        let lifetime = VIEW_TTL.min(snapshot.remaining_lifetime());
        self.views.retain(|_, view| {
            view.expires_at > now
                && !(view.session_id == session_id
                    && view.snapshot.thread_id() == snapshot.thread_id())
        });
        if self.views.len() >= VIEW_LIMIT {
            return Err(HttpError::limited());
        }
        let id = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        self.views.insert(
            id.clone(),
            CapturedView {
                session_id: session_id.to_string(),
                snapshot,
                expires_at: now + lifetime,
            },
        );
        Ok(id)
    }
    fn take(&mut self, session_id: &str, id: &str) -> Result<T, HttpError> {
        let now = Instant::now();
        self.views.retain(|_, view| view.expires_at > now);
        if self
            .views
            .get(id)
            .is_none_or(|view| view.session_id != session_id)
        {
            return Err(HttpError::conflict("view_unavailable"));
        }
        self.views
            .remove(id)
            .map(|view| view.snapshot)
            .ok_or_else(|| HttpError::conflict("view_unavailable"))
    }
    fn revoke_thread(&mut self, session_id: &str, thread_id: &str) {
        self.views.retain(|_, view| {
            !(view.session_id == session_id && view.snapshot.thread_id() == thread_id)
        });
    }
    fn revoke_session(&mut self, session_id: &str) {
        self.views.retain(|_, view| view.session_id != session_id);
    }
}
struct Window {
    started_at: Instant,
    count: u32,
}
#[derive(Default)]
struct RateLimits {
    windows: HashMap<String, Window>,
}
impl RateLimits {
    fn check(&mut self, key: String, limit: u32, now: Instant) -> bool {
        self.windows
            .retain(|_, v| now.saturating_duration_since(v.started_at) < RATE_WINDOW);
        if self.windows.len() >= 256 && !self.windows.contains_key(&key) {
            return false;
        }
        let window = self.windows.entry(key).or_insert(Window {
            started_at: now,
            count: 0,
        });
        if window.count >= limit {
            return false;
        }
        window.count = window.count.saturating_add(1);
        true
    }
}
#[derive(Clone)]
struct RouterState {
    db: Arc<Database>,
    auth: Arc<OwnerRemoteAuth>,
    active: Arc<AtomicBool>,
    shutdown_requested: Arc<AtomicBool>,
    views: Arc<Mutex<ViewCapabilities>>,
    limits: Arc<Mutex<RateLimits>>,
    read_permits: Arc<Semaphore>,
    mutation_permits: Arc<Semaphore>,
    body_permits: Arc<Semaphore>,
}
impl RouterState {
    fn new(
        auth: Arc<OwnerRemoteAuth>,
        active: Arc<AtomicBool>,
        shutdown_requested: Arc<AtomicBool>,
        db: Arc<Database>,
    ) -> Self {
        Self {
            db,
            auth,
            active,
            shutdown_requested,
            views: Arc::new(Mutex::new(ViewCapabilities::default())),
            limits: Arc::new(Mutex::new(RateLimits::default())),
            read_permits: Arc::new(Semaphore::new(4)),
            mutation_permits: Arc::new(Semaphore::new(2)),
            body_permits: Arc::new(Semaphore::new(8)),
        }
    }
    fn authorize(&self, headers: &HeaderMap, mutation: bool) -> Result<OwnerPrincipal, HttpError> {
        if !self.is_active() {
            return Err(HttpError::unavailable());
        }
        let principal = self.auth.authorize(headers, mutation)?;
        let (category, limit) = if mutation {
            ("command", 12)
        } else {
            ("read", 120)
        };
        if !self.rate(format!("{category}:{}", principal.session_id()), limit)? {
            return Err(HttpError::limited());
        }
        Ok(principal)
    }
    fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst) && !self.shutdown_requested.load(Ordering::SeqCst)
    }
    fn recheck(&self, principal: &OwnerPrincipal) -> bool {
        self.is_active() && self.auth.recheck(principal).is_ok()
    }
    fn rate(&self, key: String, limit: u32) -> Result<bool, HttpError> {
        self.limits
            .lock()
            .map(|mut v| v.check(key, limit, Instant::now()))
            .map_err(|_| HttpError::unavailable())
    }
}
#[derive(Debug)]
struct HttpError {
    status: StatusCode,
    code: &'static str,
}
impl HttpError {
    fn bad_request() -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_request",
        }
    }
    fn conflict(code: &'static str) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code,
        }
    }
    fn unavailable() -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "owner_remote_unavailable",
        }
    }
    fn unauthorized() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "authentication_required",
        }
    }
    fn limited() -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            code: "rate_limited",
        }
    }
}
impl From<AuthError> for HttpError {
    fn from(error: AuthError) -> Self {
        Self {
            status: error.status_code(),
            code: error.code(),
        }
    }
}
impl IntoResponse for HttpError {
    fn into_response(self) -> Response {
        let mut response = (self.status, Json(json!({"error":self.code}))).into_response();
        if self.status == StatusCode::TOO_MANY_REQUESTS {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("60"));
        }
        response
    }
}
fn remote_router(state: RouterState) -> Router {
    Router::new()
        .route("/", get(console_redirect))
        .route("/remote", get(console_redirect))
        .route("/remote/", get(console_index))
        .route("/remote/console.js", get(console_script))
        .route("/remote/console.css", get(console_style))
        .route("/remote/i18next.js", get(console_i18next))
        .route("/remote/locales", get(console_locales))
        .route("/remote/api/v1/session", get(session))
        .route("/remote/api/v1/session/logout", post(logout))
        .route(
            "/remote/api/v1/session/enroll/options",
            post(enroll_options),
        )
        .route("/remote/api/v1/session/enroll/finish", post(enroll_finish))
        .route("/remote/api/v1/session/auth/options", post(auth_options))
        .route("/remote/api/v1/session/auth/finish", post(auth_finish))
        .route("/remote/api/v1/devices", get(devices))
        .route("/remote/api/v1/conversations", get(conversations))
        .route("/remote/api/v1/view", get(view))
        .route("/remote/api/v1/continue", post(continue_thread))
        .route(
            "/remote/api/v1/operations/{operation_id}",
            get(operation_status),
        )
        .fallback(not_found)
        .layer(DefaultBodyLimit::max(REQUEST_BODY_LIMIT))
        .layer(middleware::from_fn_with_state(state.clone(), guard_request))
        .with_state(state)
}
async fn guard_request(
    State(state): State<RouterState>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let outcome = if !state.is_active() {
        Err(HttpError::unavailable())
    } else {
        let mutation = request.method() != Method::GET;
        state
            .auth
            .validate_request(request.headers(), mutation)
            .map_err(HttpError::from)
            .and_then(|()| {
                let path = request.uri().path();
                let (key, limit) =
                    if path.contains("/session/enroll/") || path.contains("/session/auth/") {
                        ("public_auth", 24)
                    } else {
                        ("all_requests", 480)
                    };
                if !state.rate(key.to_string(), limit)? {
                    return Err(HttpError::limited());
                }
                if mutation
                    && request
                        .headers()
                        .get(header::CONTENT_TYPE)
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.split(';').next())
                        != Some("application/json")
                {
                    return Err(HttpError::bad_request());
                }
                Ok(())
            })
    };
    let mut response = match outcome {
        Ok(()) => match bounded_request_body(&state, request).await {
            Ok(request) => next.run(request).await,
            Err(error) => error.into_response(),
        },
        Err(error) => error.into_response(),
    };
    add_security_headers(response.headers_mut());
    response
}
// This deadline ends before the handler/native reservation begins. Never put a
// timeout around an authorized Continue future: that could hide a real mutation.
async fn bounded_request_body(
    state: &RouterState,
    request: axum::extract::Request,
) -> Result<axum::extract::Request, HttpError> {
    if request.method() != Method::POST {
        return Ok(request);
    }
    let _permit = state
        .body_permits
        .clone()
        .try_acquire_owned()
        .map_err(|_| HttpError::limited())?;
    let (parts, body) = request.into_parts();
    let encoded = tokio::time::timeout(
        REQUEST_BODY_TIMEOUT,
        axum::body::to_bytes(body, REQUEST_BODY_LIMIT),
    )
    .await
    .map_err(|_| HttpError {
        status: StatusCode::REQUEST_TIMEOUT,
        code: "request_body_timeout",
    })?
    .map_err(|_| HttpError::bad_request())?;
    Ok(axum::extract::Request::from_parts(
        parts,
        axum::body::Body::from(encoded),
    ))
}

fn add_security_headers(headers: &mut HeaderMap) {
    for (name,value) in [
        ("cache-control","no-store, max-age=0"),("pragma","no-cache"),("x-content-type-options","nosniff"),("referrer-policy","no-referrer"),("x-frame-options","DENY"),("cross-origin-resource-policy","same-origin"),("cross-origin-opener-policy","same-origin"),("permissions-policy","camera=(), microphone=(), geolocation=()"),
        ("content-security-policy","default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"),
    ] {headers.insert(header::HeaderName::from_static(name),HeaderValue::from_static(value));}
}
async fn console_redirect() -> Redirect {
    Redirect::temporary("/remote/")
}
async fn console_index() -> Response {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        include_str!("../../resources/owner_remote/index.html"),
    )
        .into_response()
}
async fn console_script() -> Response {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        include_str!("../../resources/owner_remote/console.js"),
    )
        .into_response()
}
async fn console_style() -> Response {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        include_str!("../../resources/owner_remote/console.css"),
    )
        .into_response()
}
async fn console_i18next() -> Response {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        include_str!("../../resources/owner_remote/i18next.js"),
    )
        .into_response()
}
async fn console_locales() -> Result<Response, HttpError> {
    let mut resources = serde_json::Map::new();
    for (language, encoded) in [
        ("en", include_str!("../../../../src/i18n/locales/en.json")),
        ("zh", include_str!("../../../../src/i18n/locales/zh.json")),
        (
            "zh-TW",
            include_str!("../../../../src/i18n/locales/zh-TW.json"),
        ),
        ("ja", include_str!("../../../../src/i18n/locales/ja.json")),
    ] {
        let source: Value = serde_json::from_str(encoded).map_err(|_| HttpError::unavailable())?;
        let namespace = source
            .get("ownerRemoteConsole")
            .filter(|value| value.is_object())
            .ok_or_else(HttpError::unavailable)?;
        resources.insert(
            language.to_string(),
            json!({"translation": {"ownerRemoteConsole": namespace}}),
        );
    }
    safe_json(resources)
}
async fn not_found() -> HttpError {
    HttpError {
        status: StatusCode::NOT_FOUND,
        code: "not_found",
    }
}
fn json_payload<T>(payload: Result<Json<T>, JsonRejection>) -> Result<T, HttpError> {
    payload
        .map(|Json(v)| v)
        .map_err(|_| HttpError::bad_request())
}
fn safe_json(value: impl Serialize) -> Result<Response, HttpError> {
    let encoded = serde_json::to_vec(&value).map_err(|_| HttpError::unavailable())?;
    if encoded.len() > RESPONSE_BODY_LIMIT {
        return Err(HttpError::unavailable());
    }
    Ok(([(header::CONTENT_TYPE, "application/json")], encoded).into_response())
}
fn session_response(issued: OwnerSessionIssued) -> Result<Response, HttpError> {
    let mut value =
        serde_json::to_value(&issued.principal).map_err(|_| HttpError::unavailable())?;
    value["authenticated"] = json!(true);
    value["csrfToken"] = json!(issued.csrf_token);
    value["capabilities"] = json!({"view":true,"continue":true});
    let mut response = safe_json(value)?;
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&issued.cookie_header).map_err(|_| HttpError::unavailable())?,
    );
    Ok(response)
}

async fn session(
    State(state): State<RouterState>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    state.authorize(&headers, false)?;
    let mut value = serde_json::to_value(state.auth.session_info(&headers)?)
        .map_err(|_| HttpError::unavailable())?;
    value["authenticated"] = json!(true);
    value["capabilities"] = json!({"view":true,"continue":true});
    safe_json(value)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EnrollOptions {
    invitation_secret: String,
    label: String,
}
async fn enroll_options(
    State(state): State<RouterState>,
    payload: Result<Json<EnrollOptions>, JsonRejection>,
) -> Result<Response, HttpError> {
    let payload = json_payload(payload)?;
    safe_json(
        state
            .auth
            .begin_registration(&payload.invitation_secret, &payload.label)?,
    )
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialFinish {
    ceremony_id: String,
    credential: Value,
}
async fn enroll_finish(
    State(state): State<RouterState>,
    payload: Result<Json<CredentialFinish>, JsonRejection>,
) -> Result<Response, HttpError> {
    let payload = json_payload(payload)?;
    session_response(
        state
            .auth
            .finish_registration(&payload.ceremony_id, payload.credential)?,
    )
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthOptions {
    management_action: Option<OwnerManagementAction>,
}
async fn auth_options(
    State(state): State<RouterState>,
    headers: HeaderMap,
    payload: Result<Json<AuthOptions>, JsonRejection>,
) -> Result<Response, HttpError> {
    let payload = json_payload(payload)?;
    let challenge = match payload.management_action {
        Some(action) => {
            let principal = state.authorize(&headers, true)?;
            state.auth.begin_management(&principal, action)?
        }
        None => state.auth.begin_login()?,
    };
    safe_json(challenge)
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum AuthPurpose {
    #[default]
    Login,
    Management,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthFinish {
    ceremony_id: String,
    credential: Value,
    #[serde(default)]
    purpose: AuthPurpose,
}
async fn auth_finish(
    State(state): State<RouterState>,
    headers: HeaderMap,
    payload: Result<Json<AuthFinish>, JsonRejection>,
) -> Result<Response, HttpError> {
    let payload = json_payload(payload)?;
    match payload.purpose {
        AuthPurpose::Login => session_response(
            state
                .auth
                .finish_login(&payload.ceremony_id, payload.credential)?,
        ),
        AuthPurpose::Management => {
            let principal = state.authorize(&headers, true)?;
            let outcome = state.auth.finish_management(
                &principal,
                &payload.ceremony_id,
                payload.credential,
            )?;
            safe_json(json!({"management":outcome}))
        }
    }
}
async fn logout(
    State(state): State<RouterState>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let principal = state.authorize(&headers, true)?;
    state.auth.logout(&principal)?;
    state
        .views
        .lock()
        .map_err(|_| HttpError::unavailable())?
        .revoke_session(principal.session_id());
    let mut response = safe_json(json!({"authenticated":false}))?;
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static(CLEAR_OWNER_COOKIE),
    );
    Ok(response)
}
async fn devices(
    State(state): State<RouterState>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let principal = state.authorize(&headers, false)?;
    safe_json(json!({"devices":state.auth.list_devices(&principal)?}))
}
async fn conversations(
    State(state): State<RouterState>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let principal = state.authorize(&headers, false)?;
    let _permit = state
        .read_permits
        .clone()
        .try_acquire_owned()
        .map_err(|_| HttpError::limited())?;
    let response = list_codex_owner_remote_conversations(&state.db, || state.recheck(&principal))
        .await
        .map_err(|e| HttpError::conflict(e.code()))?;
    if !state.recheck(&principal) {
        return Err(HttpError::unauthorized());
    }
    safe_json(response)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ViewQuery {
    thread_id: String,
}
async fn view(
    State(state): State<RouterState>,
    headers: HeaderMap,
    query: Result<Query<ViewQuery>, QueryRejection>,
) -> Result<Response, HttpError> {
    let principal = state.authorize(&headers, false)?;
    let Query(query) = query.map_err(|_| HttpError::bad_request())?;
    if !safe_identifier(&query.thread_id, 1, 256) {
        return Err(HttpError::bad_request());
    }
    let _permit = state
        .read_permits
        .clone()
        .try_acquire_owned()
        .map_err(|_| HttpError::limited())?;
    let snapshot =
        read_codex_owner_remote_view(&state.db, &query.thread_id, || state.recheck(&principal))
            .await
            .map_err(|e| HttpError::conflict(e.code()))?;
    if !state.recheck(&principal) {
        return Err(HttpError::unauthorized());
    }
    let content = snapshot.content().clone();
    let remaining = VIEW_TTL.min(snapshot.remaining_lifetime());
    let can_continue = snapshot.can_continue() && remaining.as_secs() > 0;
    state
        .views
        .lock()
        .map_err(|_| HttpError::unavailable())?
        .revoke_thread(principal.session_id(), snapshot.thread_id());
    let view_id = if can_continue {
        Some(
            state
                .views
                .lock()
                .map_err(|_| HttpError::unavailable())?
                .insert(principal.session_id(), snapshot)?,
        )
    } else {
        None
    };
    safe_json(
        json!({"viewId":view_id,"expiresInSeconds":if can_continue { remaining.as_secs() } else { 0 },"canContinue":can_continue,"content":content}),
    )
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContinueRequest {
    view_id: String,
    operation_id: String,
}
async fn continue_thread(
    State(state): State<RouterState>,
    headers: HeaderMap,
    payload: Result<Json<ContinueRequest>, JsonRejection>,
) -> Result<Response, HttpError> {
    let principal = state.authorize(&headers, true)?;
    let payload = json_payload(payload)?;
    if !safe_identifier(&payload.view_id, 32, 128) || !safe_operation_id(&payload.operation_id) {
        return Err(HttpError::bad_request());
    }
    let _permit = state
        .mutation_permits
        .clone()
        .try_acquire_owned()
        .map_err(|_| HttpError::limited())?;
    // Consume the session-bound view before any awaited work. No retry sender,
    // native status cache, or second continuation ledger exists in this service.
    let snapshot = state
        .views
        .lock()
        .map_err(|_| HttpError::unavailable())?
        .take(principal.session_id(), &payload.view_id)?;
    let receipt =
        submit_codex_owner_continuation(&state.db, &snapshot, &payload.operation_id, || {
            state.recheck(&principal)
        })
        .await
        .map_err(|e| HttpError::conflict(e.code()))?;
    if !state.recheck(&principal) {
        return Err(HttpError::unauthorized());
    }
    operation_response(receipt)
}
async fn operation_status(
    State(state): State<RouterState>,
    headers: HeaderMap,
    operation_id: Result<AxumPath<String>, PathRejection>,
) -> Result<Response, HttpError> {
    let principal = state.authorize(&headers, false)?;
    let AxumPath(operation_id) = operation_id.map_err(|_| HttpError::bad_request())?;
    if !safe_operation_id(&operation_id) {
        return Err(HttpError::bad_request());
    }
    let receipt = read_owner_continuation_receipt(&operation_id).ok_or(HttpError {
        status: StatusCode::NOT_FOUND,
        code: "operation_unavailable",
    })?;
    if !state.recheck(&principal) {
        return Err(HttpError::unauthorized());
    }
    operation_response(receipt)
}
fn operation_response(receipt: OwnerContinuationReceipt) -> Result<Response, HttpError> {
    let mut response = serde_json::to_value(receipt).map_err(|_| HttpError::unavailable())?;
    // Public pending is a projection, not another mutation state or ledger.
    if response
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|value| matches!(value, "reserved" | "committing"))
    {
        response["status"] = json!("pending");
    }
    safe_json(response)
}
fn safe_operation_id(value: &str) -> bool {
    value.strip_prefix("owner-").is_some_and(|suffix| {
        suffix.len() == 32
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}
fn safe_identifier(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    const ORIGIN: &str = "https://owner.example.test";
    fn test_state() -> (tempfile::TempDir, RouterState) {
        let dir = tempfile::tempdir().unwrap();
        let auth = Arc::new(OwnerRemoteAuth::open(&dir.path().join(AUTH_FILE), ORIGIN).unwrap());
        (
            dir,
            RouterState::new(
                auth,
                Arc::new(AtomicBool::new(true)),
                Arc::new(AtomicBool::new(false)),
                Arc::new(Database::memory().unwrap()),
            ),
        )
    }
    fn request(method: Method, path: &str, body: &str) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(path)
            .header(header::HOST, "owner.example.test")
            .header(header::ORIGIN, ORIGIN)
            .header(header::CONTENT_TYPE, "application/json")
            .header("sec-fetch-site", "same-origin")
            .body(Body::from(body.to_string()))
            .unwrap()
    }
    fn authenticated_request(
        method: Method,
        path: &str,
        body: &str,
        session: &OwnerSessionIssued,
    ) -> Request<Body> {
        let mut req = request(method, path, body);
        let cookie = session.cookie_header.split(';').next().unwrap();
        req.headers_mut()
            .insert(header::COOKIE, HeaderValue::from_str(cookie).unwrap());
        req.headers_mut().insert(
            "x-ccsm-csrf",
            HeaderValue::from_str(&session.csrf_token).unwrap(),
        );
        req
    }
    #[test]
    fn constructor_has_no_side_effect_and_malformed_config_never_opts_in() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("not-created");
        let service = OwnerRemoteService::new(path.clone(), Arc::new(Database::memory().unwrap()));
        assert!(!path.exists());
        assert!(!service.status_without_lock().enabled);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join(CONFIG_FILE), b"{broken").unwrap();
        let status = service.status_without_lock();
        assert!(!status.enabled);
        assert!(!status.running);
        assert_eq!(status.error, Some("owner_remote_configuration_unavailable"));
    }
    #[tokio::test]
    async fn failed_first_bind_exposes_the_persisted_auth_pin_and_allows_same_origin_retry() {
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("owner-remote");
        let db = Arc::new(Database::memory().unwrap());
        let service = OwnerRemoteService::new(local.clone(), db.clone());
        let untouched = service.status().await;
        assert!(!untouched.enabled);
        assert!(!untouched.running);
        assert!(untouched.https_origin.is_none());
        assert!(!local.exists());

        let occupied = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = occupied.local_addr().unwrap().port();
        let failed = {
            let mut server = service.inner.server.lock().await;
            service
                .start_locked_on_port(&mut server, ORIGIN, port)
                .await
        };
        assert!(matches!(
            failed,
            Err(OwnerRemoteServiceError::ListenerUnavailable)
        ));
        assert!(local.join(AUTH_FILE).is_file());
        assert!(!local.join(CONFIG_FILE).exists());
        let auth_before_status = std::fs::read(local.join(AUTH_FILE)).unwrap();

        // The origin is durable auth trust, not an in-memory service projection.
        let reloaded = OwnerRemoteService::new(local.clone(), db);
        let status = reloaded.status().await;
        assert!(!status.enabled);
        assert!(!status.running);
        assert_eq!(status.https_origin.as_deref(), Some(ORIGIN));
        assert!(status.error.is_none());
        assert!(!local.join(CONFIG_FILE).exists());
        assert_eq!(
            std::fs::read(local.join(AUTH_FILE)).unwrap(),
            auth_before_status
        );

        drop(occupied);
        let rejected_rebind = {
            let mut server = reloaded.inner.server.lock().await;
            reloaded
                .start_locked_on_port(&mut server, "https://other.example.test", port)
                .await
        };
        assert!(matches!(
            rejected_rebind,
            Err(OwnerRemoteServiceError::Authentication)
        ));
        assert_eq!(
            reloaded.status().await.https_origin.as_deref(),
            Some(ORIGIN)
        );
        let retry = {
            let mut server = reloaded.inner.server.lock().await;
            reloaded
                .start_locked_on_port(&mut server, ORIGIN, port)
                .await
        }
        .unwrap();
        assert!(retry.enabled);
        assert!(retry.running);
        assert_eq!(retry.https_origin.as_deref(), Some(ORIGIN));
        reloaded.shutdown().await;
    }

    #[test]
    fn auth_pin_does_not_repair_or_opt_in_a_corrupt_local_config() {
        let dir = tempfile::tempdir().unwrap();
        let auth_path = dir.path().join(AUTH_FILE);
        drop(OwnerRemoteAuth::open(&auth_path, ORIGIN).unwrap());
        std::fs::write(dir.path().join(CONFIG_FILE), b"{broken").unwrap();
        let service = OwnerRemoteService::new(
            dir.path().to_path_buf(),
            Arc::new(Database::memory().unwrap()),
        );
        let status = service.status_without_lock();
        assert!(!status.enabled);
        assert!(!status.running);
        assert_eq!(status.https_origin.as_deref(), Some(ORIGIN));
        assert_eq!(status.error, Some("owner_remote_configuration_unavailable"));
        assert_eq!(
            std::fs::read(dir.path().join(CONFIG_FILE)).unwrap(),
            b"{broken"
        );
    }

    #[test]
    fn status_exposes_auth_pin_and_rejects_conflicting_config_origin() {
        let dir = tempfile::tempdir().unwrap();
        drop(OwnerRemoteAuth::open(&dir.path().join(AUTH_FILE), ORIGIN).unwrap());
        write_local_config(
            dir.path(),
            &LocalRemoteConfig {
                version: 1,
                enabled: true,
                https_origin: "https://other.example.test".to_string(),
            },
        )
        .unwrap();
        let service = OwnerRemoteService::new(
            dir.path().to_path_buf(),
            Arc::new(Database::memory().unwrap()),
        );
        let status = service.status_without_lock();
        assert!(status.enabled);
        assert!(!status.running);
        assert_eq!(status.https_origin.as_deref(), Some(ORIGIN));
        assert_eq!(status.error, Some("owner_remote_configuration_unavailable"));
    }
    #[test]
    fn corrupt_auth_store_is_reported_without_creation_or_repair() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(AUTH_FILE);
        let service = OwnerRemoteService::new(
            dir.path().to_path_buf(),
            Arc::new(Database::memory().unwrap()),
        );
        assert!(service.status_without_lock().https_origin.is_none());
        assert!(!path.exists());
        let corrupt = b"not-a-sqlite-owner-store";
        std::fs::write(&path, corrupt).unwrap();
        let status = service.status_without_lock();
        assert!(!status.enabled);
        assert!(!status.running);
        assert!(status.https_origin.is_none());
        assert_eq!(
            status.error,
            Some("owner_remote_authentication_unavailable")
        );
        assert_eq!(std::fs::read(&path).unwrap(), corrupt);
        assert!(!dir.path().join(CONFIG_FILE).exists());
    }
    #[test]
    fn unknown_or_future_config_is_not_silently_migrated() {
        let dir = tempfile::tempdir().unwrap();
        for encoded in [
            r#"{"version":2,"enabled":true,"httpsOrigin":"https://owner.example.test"}"#,
            r#"{"version":1,"enabled":true,"httpsOrigin":"https://owner.example.test","listener":"0.0.0.0"}"#,
            r#"{"version":1,"enabled":true,"httpsOrigin":""}"#,
        ] {
            std::fs::write(dir.path().join(CONFIG_FILE), encoded).unwrap();
            assert!(read_local_config(dir.path()).is_err());
        }
        write_local_config(
            dir.path(),
            &LocalRemoteConfig {
                version: 1,
                enabled: false,
                https_origin: ORIGIN.to_string(),
            },
        )
        .unwrap();
        assert!(!read_local_config(dir.path()).unwrap().unwrap().enabled);
    }
    #[test]
    fn rate_limits_use_monotonic_windows_and_bound_unknown_keys() {
        let mut limits = RateLimits::default();
        let now = Instant::now();
        assert!(limits.check("auth".to_string(), 2, now));
        assert!(limits.check("auth".to_string(), 2, now));
        assert!(!limits.check("auth".to_string(), 2, now));
        assert!(limits.check("auth".to_string(), 2, now + RATE_WINDOW));
        for n in 0..255 {
            assert!(limits.check(format!("key-{n}"), 1, now + RATE_WINDOW));
        }
        assert!(!limits.check("one-too-many".to_string(), 1, now + RATE_WINDOW));
    }
    #[test]
    fn identifiers_cannot_smuggle_method_payloads_or_urls() {
        assert!(safe_identifier("operation-1234_abcd", 16, 128));
        for invalid in [
            "",
            "../thread",
            "x?secret=redacted",
            "{\"rpc\":1}",
            "a b",
            "é",
        ] {
            assert!(!safe_identifier(invalid, 1, 256));
        }
    }
    #[tokio::test]
    async fn untrusted_requests_cannot_read_or_mutate_native_content() {
        let (_dir, state) = test_state();
        let router = remote_router(state);
        for (method, path, body) in [
            (Method::GET, "/remote/api/v1/session", ""),
            (Method::GET, "/remote/api/v1/conversations", ""),
            (Method::GET, "/remote/api/v1/view?threadId=untrusted", ""),
            (
                Method::POST,
                "/remote/api/v1/continue",
                r#"{"viewId":"redacted","operationId":"redacted"}"#,
            ),
            (Method::GET, "/remote/api/v1/devices", ""),
        ] {
            let response = router
                .clone()
                .oneshot(request(method, path, body))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "no-store, max-age=0"
            );
            assert_eq!(
                response.headers()[header::X_CONTENT_TYPE_OPTIONS],
                "nosniff"
            );
            assert!(!response
                .headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            assert!(body.get("error").and_then(Value::as_str).is_some());
            assert!(body.get("content").is_none());
        }
    }
    #[tokio::test]
    async fn exact_origin_host_and_json_content_type_precede_auth_ceremonies() {
        let (_dir, state) = test_state();
        let router = remote_router(state);
        for (name, bad) in [
            (header::HOST, "127.0.0.1:15723"),
            (header::HOST, "attacker.example.test"),
            (header::ORIGIN, "null"),
            (header::ORIGIN, "https://attacker.example.test"),
            (
                header::HeaderName::from_static("sec-fetch-site"),
                "cross-site",
            ),
        ] {
            let mut req = request(Method::POST, "/remote/api/v1/session/auth/options", "{}");
            req.headers_mut()
                .insert(name, HeaderValue::from_static(bad));
            assert_eq!(
                router.clone().oneshot(req).await.unwrap().status(),
                StatusCode::FORBIDDEN
            );
        }
        let mut req = request(Method::POST, "/remote/api/v1/session/auth/options", "{}");
        req.headers_mut().remove(header::ORIGIN);
        assert_eq!(
            router.clone().oneshot(req).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
        let mut req = request(Method::POST, "/remote/api/v1/session/auth/options", "{}");
        req.headers_mut()
            .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
        assert_eq!(
            router.oneshot(req).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );
    }
    #[tokio::test]
    async fn malformed_oversized_and_extra_payload_fields_do_not_reflect_secrets() {
        let (_dir, state) = test_state();
        let router = remote_router(state);
        for body in [
            "{\"invitationSecret\":\"redacted-fixture\",broken".to_string(),
            format!(
                "{{\"invitationSecret\":\"{}\",\"label\":\"test\"}}",
                "x".repeat(REQUEST_BODY_LIMIT + 1)
            ),
            r#"{"invitationSecret":"redacted-fixture","label":"test","rpc":"turn/start"}"#
                .to_string(),
        ] {
            let response = router
                .clone()
                .oneshot(request(
                    Method::POST,
                    "/remote/api/v1/session/enroll/options",
                    &body,
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            let encoded = response.into_body().collect().await.unwrap().to_bytes();
            assert_eq!(
                std::str::from_utf8(&encoded).unwrap(),
                r#"{"error":"invalid_request"}"#
            );
        }
    }
    #[tokio::test]
    async fn no_generic_admin_cdp_inference_or_duplicate_management_routes() {
        let (_dir, state) = test_state();
        let router = remote_router(state);
        for path in [
            "/remote/api/v1/rpc",
            "/remote/api/v1/settings",
            "/remote/api/v1/providers",
            "/json/list",
            "/v1/responses",
            "/remote/api/v1/devices/invite",
        ] {
            assert_eq!(
                router
                    .clone()
                    .oneshot(request(Method::GET, path, ""))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::NOT_FOUND
            );
        }
    }
    #[tokio::test]
    async fn disabled_runtime_blocks_assets_login_and_precommit_recheck() {
        let (_dir, state) = test_state();
        let issued = state.auth.test_session();
        assert!(state.recheck(&issued.principal));
        state.active.store(false, Ordering::SeqCst);
        assert!(!state.recheck(&issued.principal));
        let router = remote_router(state);
        for path in ["/remote/", "/remote/console.js", "/remote/api/v1/session"] {
            assert_eq!(
                router
                    .clone()
                    .oneshot(request(Method::GET, path, ""))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::SERVICE_UNAVAILABLE
            );
        }
    }
    #[tokio::test]
    async fn public_document_is_no_store_and_cannot_be_framed_or_run_inline_scripts() {
        let (_dir, state) = test_state();
        let response = remote_router(state)
            .oneshot(request(Method::GET, "/remote/", ""))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let policy = response.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap();
        assert!(policy.contains("frame-ancestors 'none'"));
        assert!(policy.contains("default-src 'none'"));
        assert!(!policy.contains("'unsafe-inline'"));
        assert_eq!(response.headers()[header::REFERRER_POLICY], "no-referrer");
        assert_eq!(
            response.headers()["cross-origin-resource-policy"],
            "same-origin"
        );
    }
    #[tokio::test]
    async fn public_auth_rate_limit_bounds_challenge_work() {
        let (_dir, state) = test_state();
        for _ in 0..24 {
            assert!(state.rate("public_auth".to_string(), 24).unwrap());
        }
        let response = remote_router(state)
            .oneshot(request(
                Method::POST,
                "/remote/api/v1/session/auth/options",
                "{}",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()[header::RETRY_AFTER], "60");
    }
    #[test]
    fn bounded_json_never_releases_oversize_native_result() {
        assert!(safe_json(json!({"text":"x".repeat(RESPONSE_BODY_LIMIT)})).is_err());
    }
    #[tokio::test]
    async fn authenticated_session_recovers_csrf_without_plaintext_session_persistence() {
        let (_dir, state) = test_state();
        let issued = state.auth.test_session();
        let response = remote_router(state)
            .oneshot(authenticated_request(
                Method::GET,
                "/remote/api/v1/session",
                "",
                &issued,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["authenticated"], true);
        assert_eq!(body["csrfToken"], issued.csrf_token);
        assert_eq!(body["capabilities"]["continue"], true);
        assert!(body.get("tokenHash").is_none());
    }
    #[tokio::test]
    async fn csrf_logout_and_revocation_are_rechecked_before_native_dispatch() {
        let (_dir, state) = test_state();
        let issued = state.auth.test_session();
        let router = remote_router(state.clone());
        let mut req = authenticated_request(
            Method::POST,
            "/remote/api/v1/continue",
            r#"{"viewId":"00000000000000000000000000000000","operationId":"owner-00000000000000000000000000000000"}"#,
            &issued,
        );
        req.headers_mut().remove("x-ccsm-csrf");
        assert_eq!(
            router.clone().oneshot(req).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
        let response = router
            .clone()
            .oneshot(authenticated_request(
                Method::POST,
                "/remote/api/v1/session/logout",
                "{}",
                &issued,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .contains("Max-Age=0"));
        assert!(!state.recheck(&issued.principal));
        assert_eq!(
            router
                .oneshot(authenticated_request(
                    Method::GET,
                    "/remote/api/v1/conversations",
                    "",
                    &issued
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    #[tokio::test]
    async fn caller_cannot_forge_a_view_or_add_arbitrary_prompt_to_continue() {
        let (_dir, state) = test_state();
        let issued = state.auth.test_session();
        let router = remote_router(state);
        for (body, status) in [
            (
                r#"{"viewId":"00000000000000000000000000000000","operationId":"owner-00000000000000000000000000000000"}"#,
                StatusCode::CONFLICT,
            ),
            (
                r#"{"viewId":"00000000000000000000000000000000","operationId":"owner-00000000000000000000000000000000","prompt":"shell command"}"#,
                StatusCode::BAD_REQUEST,
            ),
        ] {
            assert_eq!(
                router
                    .clone()
                    .oneshot(authenticated_request(
                        Method::POST,
                        "/remote/api/v1/continue",
                        body,
                        &issued
                    ))
                    .await
                    .unwrap()
                    .status(),
                status
            );
        }
    }

    // This fake only exercises the private HTTP capability container. It cannot
    // become a production native snapshot or bypass any CDP/native validation.
    struct TestBoundView(&'static str);
    impl BoundOwnerView for TestBoundView {
        fn thread_id(&self) -> &str {
            self.0
        }
    }
    #[test]
    fn view_capabilities_are_session_owned_and_consumed_once() {
        let mut views = ViewCapabilities::default();
        let id = views.insert("owner-a", TestBoundView("thread-a")).unwrap();
        assert!(views.take("owner-b", &id).is_err());
        assert_eq!(views.take("owner-a", &id).unwrap().thread_id(), "thread-a");
        assert!(views.take("owner-a", &id).is_err());
    }
    #[test]
    fn newer_view_replaces_only_same_session_and_thread() {
        let mut views = ViewCapabilities::default();
        let old = views.insert("owner-a", TestBoundView("thread-a")).unwrap();
        let other_session = views.insert("owner-b", TestBoundView("thread-a")).unwrap();
        let other_thread = views.insert("owner-a", TestBoundView("thread-b")).unwrap();
        let fresh = views.insert("owner-a", TestBoundView("thread-a")).unwrap();
        assert!(views.take("owner-a", &old).is_err());
        assert!(views.take("owner-a", &fresh).is_ok());
        assert!(views.take("owner-b", &other_session).is_ok());
        assert!(views.take("owner-a", &other_thread).is_ok());
    }
    #[test]
    fn view_capacity_and_expiry_use_monotonic_time_not_wall_clock() {
        let mut views = ViewCapabilities::default();
        for index in 0..VIEW_LIMIT {
            views
                .insert(&format!("owner-{index}"), TestBoundView("thread-a"))
                .unwrap();
        }
        assert!(views
            .insert("one-too-many", TestBoundView("thread-a"))
            .is_err());
        for view in views.views.values_mut() {
            view.expires_at = Instant::now() - Duration::from_secs(1);
        }
        let id = views
            .insert("new-owner", TestBoundView("thread-a"))
            .unwrap();
        assert_eq!(views.views.len(), 1);
        views.views.get_mut(&id).unwrap().expires_at = Instant::now() - Duration::from_secs(1);
        assert!(views.take("new-owner", &id).is_err());
        assert!(views.views.is_empty());
    }
    #[test]
    fn simultaneous_view_consumers_get_only_one_capability() {
        let mut views = ViewCapabilities::default();
        let id = views.insert("owner-a", TestBoundView("thread-a")).unwrap();
        let views = Arc::new(Mutex::new(views));
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let successes = std::thread::scope(|scope| {
            let handles = (0..2)
                .map(|_| {
                    let views = views.clone();
                    let barrier = barrier.clone();
                    let id = id.clone();
                    scope.spawn(move || {
                        barrier.wait();
                        views.lock().unwrap().take("owner-a", &id).is_ok()
                    })
                })
                .collect::<Vec<_>>();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .filter(|success| *success)
                .count()
        });
        assert_eq!(successes, 1);
    }
    #[tokio::test]
    async fn shutdown_refuses_later_start_or_queued_restore_before_file_or_socket_io() {
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("not-created");
        let service = OwnerRemoteService::new(local.clone(), Arc::new(Database::memory().unwrap()));
        service.shutdown().await;
        assert!(matches!(
            service.start(ORIGIN).await,
            Err(OwnerRemoteServiceError::NotRunning)
        ));
        assert!(!local.exists());
        write_local_config(
            &local,
            &LocalRemoteConfig {
                version: 1,
                enabled: true,
                https_origin: ORIGIN.to_string(),
            },
        )
        .unwrap();
        assert!(matches!(
            service.restore().await,
            Err(OwnerRemoteServiceError::NotRunning)
        ));
        assert!(!local.join(AUTH_FILE).exists());
    }
    #[tokio::test]
    async fn locale_endpoint_only_returns_canonical_console_namespace_without_auth() {
        let (_dir, state) = test_state();
        let response = remote_router(state)
            .oneshot(request(Method::GET, "/remote/locales", ""))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let resources: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(resources.as_object().unwrap().len(), 4);
        for language in ["en", "zh", "zh-TW", "ja"] {
            let translation = resources[language]["translation"].as_object().unwrap();
            assert_eq!(translation.len(), 1);
            assert!(translation["ownerRemoteConsole"].is_object());
            assert!(translation.get("settings").is_none());
            assert!(translation.get("providers").is_none());
        }
    }
    #[test]
    fn oversized_local_config_cannot_enable_listener() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(CONFIG_FILE), vec![b' '; 8192]).unwrap();
        assert!(read_local_config(dir.path()).is_err());
    }

    #[test]
    fn read_only_refresh_retires_prior_mutation_capability_for_same_session_thread() {
        let mut views = ViewCapabilities::default();
        let id = views.insert("owner-a", TestBoundView("thread-a")).unwrap();
        let other = views.insert("owner-b", TestBoundView("thread-a")).unwrap();
        views.revoke_thread("owner-a", "thread-a");
        assert!(views.take("owner-a", &id).is_err());
        assert!(views.take("owner-b", &other).is_ok());
    }
    #[tokio::test]
    async fn root_urls_redirect_only_to_same_origin_console() {
        let (_dir, state) = test_state();
        let router = remote_router(state);
        for path in ["/", "/remote"] {
            let response = router
                .clone()
                .oneshot(request(Method::GET, path, ""))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
            assert_eq!(response.headers()[header::LOCATION], "/remote/");
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "no-store, max-age=0"
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn slow_public_auth_body_has_finite_deadline_before_handler_or_mutation() {
        let (_dir, state) = test_state();
        let mut req = request(Method::POST, "/remote/api/v1/session/auth/options", "");
        *req.body_mut() = Body::from_stream(futures::stream::pending::<
            Result<bytes::Bytes, std::io::Error>,
        >());
        let response = remote_router(state).oneshot(req).await.unwrap();
        assert_eq!(response.status(), StatusCode::REQUEST_TIMEOUT);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            std::str::from_utf8(&bytes).unwrap(),
            r#"{"error":"request_body_timeout"}"#
        );
    }
    #[tokio::test]
    async fn full_body_read_concurrency_refuses_new_body_without_entering_auth_handler() {
        let (_dir, state) = test_state();
        let _permits = state
            .body_permits
            .clone()
            .try_acquire_many_owned(8)
            .unwrap();
        let response = remote_router(state)
            .oneshot(request(
                Method::POST,
                "/remote/api/v1/session/auth/options",
                "{}",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn operation_lookup_requires_auth_and_unknown_is_not_no_mutation_proof() {
        let (_dir, state) = test_state();
        let issued = state.auth.test_session();
        let router = remote_router(state);
        let operation_path = "/remote/api/v1/operations/owner-fffffffffffffffffffffffffffffffe";
        assert_eq!(
            router
                .clone()
                .oneshot(request(Method::GET, operation_path, ""))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let response = router
            .clone()
            .oneshot(authenticated_request(
                Method::GET,
                operation_path,
                "",
                &issued,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            std::str::from_utf8(&bytes).unwrap(),
            r#"{"error":"operation_unavailable"}"#
        );
        assert_eq!(
            router
                .oneshot(authenticated_request(
                    Method::GET,
                    "/remote/api/v1/operations/reflected-redacted-fixture",
                    "",
                    &issued
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    #[test]
    fn public_operation_ids_match_browser_128_bit_format_only() {
        assert!(safe_operation_id("owner-0123456789abcdef0123456789abcdef"));
        for invalid in [
            "owner-0123",
            "owner-0123456789ABCDEF0123456789ABCDEF",
            "0123456789abcdef0123456789abcdef",
            "owner-0123456789abcdef0123456789abcdef-extra",
            "owner-../redacted",
        ] {
            assert!(!safe_operation_id(invalid));
        }
    }
    #[tokio::test]
    async fn operation_receipt_projects_canonical_reservation_as_pending_without_new_state() {
        use crate::proxy::codex_turn_recovery::OwnerContinuationStatus;
        for status in [
            OwnerContinuationStatus::Reserved,
            OwnerContinuationStatus::Committing,
        ] {
            let response = operation_response(OwnerContinuationReceipt {
                operation_id: "owner-0123456789abcdef0123456789abcdef".to_string(),
                status,
                submitted: false,
                mutation_attempted: status == OwnerContinuationStatus::Committing,
                acknowledged_turn_id: None,
            })
            .unwrap();
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            let value: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(value["status"], "pending");
            assert!(value.get("acknowledgedTurnId").is_none());
            assert!(value.get("baseTurnId").is_none());
        }
    }
    include!("live_audit_tests.rs");
}
