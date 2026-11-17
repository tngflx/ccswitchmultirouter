//! Local-only owner authentication: not the synced app database. Ceremony state
//! stays in memory; stored passkeys are public, invitations/sessions hash-only.
//! Maintained webauthn-rs 0.6.2 deliberately raises MSRV to 1.89; the former
//! 1.85-compatible releases are affected by GHSA-22w3-693w-x895. No relaxed
//! subdomains/ports or dangerous ceremony-state serialization is enabled.
use hmac::{Hmac, KeyInit, Mac};
use http::{header, HeaderMap, StatusCode};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use url::Url;
use uuid::Uuid;
use webauthn_rs::prelude::{
    Passkey, PasskeyAuthentication, PasskeyRegistration, PublicKeyCredential,
    RegisterPublicKeyCredential, Webauthn, WebauthnBuilder,
};
const CEREMONY_TTL_MS: i64 = 60_000;
const SESSION_IDLE_MS: i64 = 12 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const MAX_CEREMONIES: usize = 32;
const MAX_INVITATIONS: usize = 4;
const MAX_CREDENTIALS: i64 = 32;
const MAX_SESSIONS: i64 = 128;
pub(crate) const OWNER_COOKIE_NAME: &str = "__Host-ccsm-owner";
pub(crate) const CLEAR_OWNER_COOKIE: &str =
    "__Host-ccsm-owner=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0";
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub(crate) enum AuthError {
    #[error("owner_auth_invalid_configuration")]
    InvalidConfiguration,
    #[error("owner_auth_invalid_request")]
    InvalidRequest,
    #[error("owner_auth_forbidden_origin")]
    ForbiddenOrigin,
    #[error("owner_auth_forbidden_csrf")]
    ForbiddenCsrf,
    #[error("owner_auth_unauthorized")]
    Unauthorized,
    #[error("owner_auth_expired_ceremony")]
    ExpiredCeremony,
    #[error("owner_auth_invalid_ceremony")]
    InvalidCeremony,
    #[error("owner_auth_verification_failed")]
    VerificationFailed,
    #[error("owner_auth_conflict")]
    Conflict,
    #[error("owner_auth_limit_reached")]
    LimitReached,
    #[error("owner_auth_persistence_failed")]
    Persistence,
}
impl AuthError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::InvalidConfiguration => "owner_auth_invalid_configuration",
            Self::InvalidRequest => "owner_auth_invalid_request",
            Self::ForbiddenOrigin => "owner_auth_forbidden_origin",
            Self::ForbiddenCsrf => "owner_auth_forbidden_csrf",
            Self::Unauthorized => "owner_auth_unauthorized",
            Self::ExpiredCeremony => "owner_auth_expired_ceremony",
            Self::InvalidCeremony => "owner_auth_invalid_ceremony",
            Self::VerificationFailed => "owner_auth_verification_failed",
            Self::Conflict => "owner_auth_conflict",
            Self::LimitReached => "owner_auth_limit_reached",
            Self::Persistence => "owner_auth_persistence_failed",
        }
    }
    pub(crate) fn status_code(self) -> StatusCode {
        match self {
            Self::InvalidConfiguration | Self::InvalidRequest | Self::InvalidCeremony => {
                StatusCode::BAD_REQUEST
            }
            Self::ForbiddenOrigin | Self::ForbiddenCsrf => StatusCode::FORBIDDEN,
            Self::Unauthorized | Self::VerificationFailed => StatusCode::UNAUTHORIZED,
            Self::ExpiredCeremony => StatusCode::GONE,
            Self::Conflict => StatusCode::CONFLICT,
            Self::LimitReached => StatusCode::TOO_MANY_REQUESTS,
            Self::Persistence => StatusCode::SERVICE_UNAVAILABLE,
        }
    }
}
type AuthResult<T> = Result<T, AuthError>;
/// Opaque authorization evidence, not caller-deserializable/constructible.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnerPrincipal {
    host_id: String,
    device_id: String,
    session_id: String,
    #[serde(skip)]
    token_hash: String,
}
impl OwnerPrincipal {
    pub(crate) fn session_id(&self) -> &str {
        &self.session_id
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnerSessionInfo {
    #[serde(flatten)]
    pub principal: OwnerPrincipal,
    pub csrf_token: String,
}
/// Cookie is secret: deliberately not Serialize/Debug; Set-Cookie only.
pub(crate) struct OwnerSessionIssued {
    pub cookie_header: String,
    pub csrf_token: String,
    pub principal: OwnerPrincipal,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerInvite {
    pub invitation_secret: String,
    pub expires_in_seconds: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnerChallenge {
    pub ceremony_id: String,
    pub public_key: Value,
    pub expires_in_seconds: u64,
}
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum OwnerManagementAction {
    Invite,
    RevokeCredential {
        #[serde(rename = "deviceId")]
        device_id: String,
    },
    RevokeSession {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnerManagementOutcome {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invitation: Option<OwnerInvite>,
    pub revoked: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnerDeviceView {
    pub device_id: String,
    pub label: String,
    pub created_at_ms: i64,
    pub revoked: bool,
    pub active_sessions: u32,
}
#[derive(Clone, Copy)]
struct AuthTime {
    wall_ms: i64,
    steady_ms: u64,
}
trait AuthClock: Send + Sync {
    fn now(&self) -> AuthTime;
}
struct SystemClock {
    started: Instant,
}
impl AuthClock for SystemClock {
    fn now(&self) -> AuthTime {
        AuthTime {
            wall_ms: chrono::Utc::now().timestamp_millis(),
            steady_ms: self
                .started
                .elapsed()
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX),
        }
    }
}
#[derive(Clone, Copy)]
struct Deadline {
    created_wall_ms: i64,
    expires_wall_ms: i64,
    expires_steady_ms: u64,
}
impl Deadline {
    fn new(now: AuthTime, ttl: i64) -> Self {
        Self {
            created_wall_ms: now.wall_ms,
            expires_wall_ms: now.wall_ms.saturating_add(ttl),
            expires_steady_ms: now.steady_ms.saturating_add(ttl as u64),
        }
    }
    fn current(self, now: AuthTime) -> bool {
        now.wall_ms >= self.created_wall_ms
            && now.wall_ms < self.expires_wall_ms
            && now.steady_ms < self.expires_steady_ms
    }
}
struct PendingCeremony {
    deadline: Deadline,
    kind: CeremonyKind,
}
enum CeremonyKind {
    Registration {
        invitation_hash: String,
        label: String,
        state: PasskeyRegistration,
    },
    Login {
        state: PasskeyAuthentication,
    },
    Management {
        principal: OwnerPrincipal,
        action: OwnerManagementAction,
        state: PasskeyAuthentication,
    },
}
struct SessionDeadline {
    absolute_steady_ms: u64,
    idle_steady_ms: u64,
}
struct AuthState {
    db: Connection,
    ceremonies: HashMap<String, PendingCeremony>,
    invitations: HashMap<String, Deadline>,
    session_deadlines: HashMap<String, SessionDeadline>,
}
pub(crate) struct OwnerRemoteAuth {
    origin: String,
    authority: String,
    host_id: String,
    owner_user_id: Uuid,
    verifier: Webauthn,
    clock: Arc<dyn AuthClock>,
    state: Mutex<AuthState>,
}
impl OwnerRemoteAuth {
    /// Inspect existing local trust without enrolling a host, repairing a store,
    /// clearing invitations, or opening the synced application database.
    pub(crate) fn read_pinned_origin(path: &Path) -> AuthResult<Option<String>> {
        if path.file_name().and_then(|v| v.to_str()) != Some("owner-remote-auth.sqlite")
            || !path.is_absolute()
        {
            return Err(AuthError::InvalidConfiguration);
        }
        match std::fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(AuthError::Persistence),
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err(AuthError::InvalidConfiguration);
            }
            Ok(_) => {}
        }
        let db = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| AuthError::Persistence)?;
        db.busy_timeout(Duration::from_secs(2))
            .map_err(|_| AuthError::Persistence)?;
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|_| AuthError::Persistence)?;
        if version != 1 {
            return Err(AuthError::InvalidConfiguration);
        }
        let origin: String = db
            .query_row("SELECT origin FROM owner_auth_meta WHERE id=1", [], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|_| AuthError::Persistence)?
            .ok_or(AuthError::InvalidConfiguration)?;
        let parsed = parse_origin(&origin)?;
        if parsed.origin().ascii_serialization() != origin {
            return Err(AuthError::InvalidConfiguration);
        }
        Ok(Some(origin))
    }
    /// Dedicated host-local store, never main synced DB. Origin changes require explicit re-enrollment.
    pub(crate) fn open(path: &Path, origin: &str) -> AuthResult<Self> {
        Self::open_with_clock(
            path,
            origin,
            Arc::new(SystemClock {
                started: Instant::now(),
            }),
        )
    }
    fn open_with_clock(path: &Path, origin: &str, clock: Arc<dyn AuthClock>) -> AuthResult<Self> {
        let url = parse_origin(origin)?;
        let origin = url.origin().ascii_serialization();
        let authority = url[url::Position::BeforeHost..url::Position::AfterPort].to_string();
        let verifier =
            WebauthnBuilder::new(url.domain().ok_or(AuthError::InvalidConfiguration)?, &url)
                .map_err(|_| AuthError::InvalidConfiguration)?
                .rp_name("CCSwitchMulti Owner")
                .timeout(Duration::from_millis(CEREMONY_TTL_MS as u64))
                .build()
                .map_err(|_| AuthError::InvalidConfiguration)?;
        if path.file_name().and_then(|v| v.to_str()) != Some("owner-remote-auth.sqlite")
            || !path.is_absolute()
        {
            return Err(AuthError::InvalidConfiguration);
        }
        if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(AuthError::InvalidConfiguration);
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| AuthError::Persistence)?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(path).map_err(|_| AuthError::Persistence)?;
        let mut db = Connection::open(path).map_err(|_| AuthError::Persistence)?;
        db.busy_timeout(Duration::from_secs(2))
            .map_err(|_| AuthError::Persistence)?;
        db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")
            .map_err(|_| AuthError::Persistence)?;
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|_| AuthError::Persistence)?;
        if version != 0 && version != 1 {
            return Err(AuthError::InvalidConfiguration);
        }
        let tx = db.transaction().map_err(|_| AuthError::Persistence)?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS owner_auth_meta (id INTEGER PRIMARY KEY CHECK(id=1),host_id TEXT NOT NULL,owner_user_id TEXT NOT NULL,origin TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS owner_credentials (id TEXT PRIMARY KEY,credential_key TEXT UNIQUE NOT NULL,passkey_json TEXT NOT NULL,label TEXT NOT NULL,created_at_ms INTEGER NOT NULL,revoked_at_ms INTEGER);
   CREATE TABLE IF NOT EXISTS owner_sessions (id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,credential_id TEXT NOT NULL REFERENCES owner_credentials(id),created_at_ms INTEGER NOT NULL,last_seen_ms INTEGER NOT NULL,absolute_expires_ms INTEGER NOT NULL,revoked_at_ms INTEGER);
   CREATE TABLE IF NOT EXISTS owner_invites (token_hash TEXT PRIMARY KEY,created_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,issuer_credential_id TEXT REFERENCES owner_credentials(id));PRAGMA user_version=1;").map_err(|_|AuthError::Persistence)?;
        let existing: Option<(String, String, String)> = tx
            .query_row(
                "SELECT host_id,owner_user_id,origin FROM owner_auth_meta WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|_| AuthError::Persistence)?;
        let (host_id, owner_user_id) = if let Some((id, user, saved)) = existing {
            if saved != origin {
                return Err(AuthError::InvalidConfiguration);
            }
            (
                id,
                Uuid::parse_str(&user).map_err(|_| AuthError::InvalidConfiguration)?,
            )
        } else {
            let id = Uuid::new_v4().to_string();
            let user = Uuid::new_v4();
            tx.execute(
                "INSERT INTO owner_auth_meta (id,host_id,owner_user_id,origin) VALUES (1,?1,?2,?3)",
                params![id, user.to_string(), origin],
            )
            .map_err(|_| AuthError::Persistence)?;
            (id, user)
        };
        // Restart invalidates all unfinished invitations and ceremonies, never replays them.
        tx.execute("DELETE FROM owner_invites", [])
            .map_err(|_| AuthError::Persistence)?;
        tx.commit().map_err(|_| AuthError::Persistence)?;
        Ok(Self {
            origin,
            authority,
            host_id,
            owner_user_id,
            verifier,
            clock,
            state: Mutex::new(AuthState {
                db,
                ceremonies: HashMap::new(),
                invitations: HashMap::new(),
                session_deadlines: HashMap::new(),
            }),
        })
    }
    pub(crate) fn origin(&self) -> &str {
        &self.origin
    }
    pub(crate) fn host_id(&self) -> &str {
        &self.host_id
    }
    fn lock(&self) -> AuthResult<MutexGuard<'_, AuthState>> {
        self.state.lock().map_err(|_| AuthError::Persistence)
    }
    pub(crate) fn validate_request(&self, headers: &HeaderMap, mutation: bool) -> AuthResult<()> {
        let host =
            single_header(headers, header::HOST.as_str())?.ok_or(AuthError::ForbiddenOrigin)?;
        if host != self.authority {
            return Err(AuthError::ForbiddenOrigin);
        }
        let origin = single_header(headers, header::ORIGIN.as_str())?;
        if origin.is_some_and(|v| v != self.origin) || (mutation && origin.is_none()) {
            return Err(AuthError::ForbiddenOrigin);
        }
        if single_header(headers, "sec-fetch-site")?
            .is_some_and(|v| v != "same-origin" && v != "none")
        {
            return Err(AuthError::ForbiddenOrigin);
        }
        Ok(())
    }
    pub(crate) fn authorize(
        &self,
        headers: &HeaderMap,
        mutation: bool,
    ) -> AuthResult<OwnerPrincipal> {
        self.validate_request(headers, mutation)?;
        let token = cookie_token(headers)?;
        let mut state = self.lock()?;
        let principal = self.authorize_token_locked(&mut state, &token, false)?;
        if mutation {
            verify_csrf(
                &token,
                &self.origin,
                principal.session_id(),
                single_header(headers, "x-ccsm-csrf")?.ok_or(AuthError::ForbiddenCsrf)?,
            )?;
        }
        read_active_session(&mut state, &principal.token_hash, self.clock.now(), true)?;
        Ok(principal)
    }
    pub(crate) fn session_info(&self, headers: &HeaderMap) -> AuthResult<OwnerSessionInfo> {
        self.validate_request(headers, false)?;
        let token = cookie_token(headers)?;
        let mut state = self.lock()?;
        let principal = self.authorize_token_locked(&mut state, &token, true)?;
        let csrf_token = csrf_token(&token, &self.origin, principal.session_id())?;
        Ok(OwnerSessionInfo {
            principal,
            csrf_token,
        })
    }
    pub(crate) fn recheck(&self, principal: &OwnerPrincipal) -> AuthResult<()> {
        let mut state = self.lock()?;
        self.recheck_locked(&mut state, principal)
    }
    fn recheck_locked(&self, state: &mut AuthState, principal: &OwnerPrincipal) -> AuthResult<()> {
        if principal.host_id != self.host_id {
            return Err(AuthError::Unauthorized);
        }
        let active = read_active_session(state, &principal.token_hash, self.clock.now(), false)?;
        if active.0 != principal.session_id || active.1 != principal.device_id {
            return Err(AuthError::Unauthorized);
        }
        Ok(())
    }
    fn authorize_token_locked(
        &self,
        state: &mut AuthState,
        token: &str,
        touch: bool,
    ) -> AuthResult<OwnerPrincipal> {
        if !valid_token(token) {
            return Err(AuthError::Unauthorized);
        }
        let hash = hash_token(token);
        let (session_id, device_id) = read_active_session(state, &hash, self.clock.now(), touch)?;
        Ok(OwnerPrincipal {
            host_id: self.host_id.clone(),
            device_id,
            session_id,
            token_hash: hash,
        })
    }
    /// Host-only setup. Never expose as an HTTP handler.
    pub(crate) fn create_local_invite(&self) -> AuthResult<OwnerInvite> {
        let mut state = self.lock()?;
        self.create_invite_locked(&mut state, None)
    }
    fn create_invite_locked(
        &self,
        state: &mut AuthState,
        issuer: Option<&str>,
    ) -> AuthResult<OwnerInvite> {
        let now = self.clock.now();
        cleanup_ephemeral(state, now)?;
        if state.invitations.len() >= MAX_INVITATIONS {
            return Err(AuthError::LimitReached);
        }
        let secret = new_secret();
        let hash = hash_token(&secret);
        let deadline = Deadline::new(now, CEREMONY_TTL_MS);
        state.db.execute("INSERT INTO owner_invites (token_hash,created_at_ms,expires_at_ms,issuer_credential_id) VALUES (?1,?2,?3,?4)",params![hash,now.wall_ms,deadline.expires_wall_ms,issuer]).map_err(|_|AuthError::Persistence)?;
        state.invitations.insert(hash, deadline);
        Ok(OwnerInvite {
            invitation_secret: secret,
            expires_in_seconds: 60,
        })
    }
    pub(crate) fn begin_registration(
        &self,
        invitation_secret: &str,
        label: &str,
    ) -> AuthResult<OwnerChallenge> {
        if !valid_token(invitation_secret) {
            return Err(AuthError::Unauthorized);
        }
        let label = validate_label(label)?;
        let mut state = self.lock()?;
        let now = self.clock.now();
        cleanup_ephemeral(&mut state, now)?;
        if state.ceremonies.len() >= MAX_CEREMONIES {
            return Err(AuthError::LimitReached);
        }
        let invitation_hash = hash_token(invitation_secret);
        validate_invitation(&state, &invitation_hash, now)?;
        if state.ceremonies.values().any(|p|matches!(&p.kind,CeremonyKind::Registration {invitation_hash:hash,..} if hash==&invitation_hash)) {return Err(AuthError::Conflict);}
        if count_active_credentials(&state.db)? >= MAX_CREDENTIALS {
            return Err(AuthError::LimitReached);
        }
        let existing = load_passkeys(&state.db, None)?;
        let exclude = existing
            .iter()
            .map(|(_, key)| key.cred_id().clone())
            .collect();
        let (challenge, registration) = self
            .verifier
            .start_passkey_registration(
                self.owner_user_id,
                "owner",
                "CCSwitchMulti Owner",
                Some(exclude),
            )
            .map_err(|_| AuthError::VerificationFailed)?;
        let public_key = public_options(challenge)?;
        let ceremony_id = Uuid::new_v4().to_string();
        state.ceremonies.insert(
            ceremony_id.clone(),
            PendingCeremony {
                deadline: Deadline::new(now, CEREMONY_TTL_MS),
                kind: CeremonyKind::Registration {
                    invitation_hash,
                    label,
                    state: registration,
                },
            },
        );
        Ok(OwnerChallenge {
            ceremony_id,
            public_key,
            expires_in_seconds: 60,
        })
    }
    pub(crate) fn finish_registration(
        &self,
        ceremony_id: &str,
        response: Value,
    ) -> AuthResult<OwnerSessionIssued> {
        let mut state = self.lock()?;
        let pending = take_ceremony(&mut state, ceremony_id, self.clock.now())?;
        let CeremonyKind::Registration {
            invitation_hash,
            label,
            state: registration,
        } = pending.kind
        else {
            return Err(AuthError::InvalidCeremony);
        };
        validate_invitation(&state, &invitation_hash, self.clock.now())?;
        let credential: RegisterPublicKeyCredential =
            serde_json::from_value(response).map_err(|_| AuthError::InvalidRequest)?;
        let passkey = self
            .verifier
            .finish_passkey_registration(&credential, &registration)
            .map_err(|_| AuthError::VerificationFailed)?;
        let now = self.clock.now();
        if !pending.deadline.current(now) {
            return Err(AuthError::ExpiredCeremony);
        }
        validate_invitation(&state, &invitation_hash, now)?;
        let public_json = serde_json::to_string(&passkey).map_err(|_| AuthError::Persistence)?;
        let device_id = Uuid::new_v4().to_string();
        let issued = prepare_session(&self.host_id, &self.origin, &device_id)?;
        let tx = state.db.transaction().map_err(|_| AuthError::Persistence)?;
        if count_active_credentials(&tx)? >= MAX_CREDENTIALS {
            return Err(AuthError::LimitReached);
        }
        tx.execute("INSERT INTO owner_credentials (id,credential_key,passkey_json,label,created_at_ms) VALUES (?1,?2,?3,?4,?5)",params![device_id,hex::encode(passkey.cred_id().as_slice()),public_json,label,now.wall_ms]).map_err(|_|AuthError::Persistence)?;
        if tx
            .execute(
                "DELETE FROM owner_invites WHERE token_hash=?1",
                [&invitation_hash],
            )
            .map_err(|_| AuthError::Persistence)?
            != 1
        {
            return Err(AuthError::Unauthorized);
        }
        persist_session(&tx, &issued, now)?;
        tx.commit().map_err(|_| AuthError::Persistence)?;
        state.invitations.remove(&invitation_hash);
        remember_session_deadline(&mut state, &issued.principal.token_hash, now);
        Ok(issued)
    }
    pub(crate) fn begin_login(&self) -> AuthResult<OwnerChallenge> {
        let mut state = self.lock()?;
        let now = self.clock.now();
        cleanup_ephemeral(&mut state, now)?;
        if state.ceremonies.len() >= MAX_CEREMONIES {
            return Err(AuthError::LimitReached);
        }
        let keys = load_passkeys(&state.db, None)?;
        if keys.is_empty() {
            return Err(AuthError::Unauthorized);
        }
        let passkeys: Vec<Passkey> = keys.into_iter().map(|(_, key)| key).collect();
        let (challenge, authentication) = self
            .verifier
            .start_passkey_authentication(&passkeys)
            .map_err(|_| AuthError::VerificationFailed)?;
        let public_key = public_options(challenge)?;
        let ceremony_id = Uuid::new_v4().to_string();
        state.ceremonies.insert(
            ceremony_id.clone(),
            PendingCeremony {
                deadline: Deadline::new(now, CEREMONY_TTL_MS),
                kind: CeremonyKind::Login {
                    state: authentication,
                },
            },
        );
        Ok(OwnerChallenge {
            ceremony_id,
            public_key,
            expires_in_seconds: 60,
        })
    }
    pub(crate) fn finish_login(
        &self,
        ceremony_id: &str,
        response: Value,
    ) -> AuthResult<OwnerSessionIssued> {
        let mut state = self.lock()?;
        let pending = take_ceremony(&mut state, ceremony_id, self.clock.now())?;
        let CeremonyKind::Login {
            state: authentication,
        } = pending.kind
        else {
            return Err(AuthError::InvalidCeremony);
        };
        let credential: PublicKeyCredential =
            serde_json::from_value(response).map_err(|_| AuthError::InvalidRequest)?;
        let result = self
            .verifier
            .finish_passkey_authentication(&credential, &authentication)
            .map_err(|_| AuthError::VerificationFailed)?;
        let now = self.clock.now();
        if !pending.deadline.current(now) {
            return Err(AuthError::ExpiredCeremony);
        }
        let (device_id, mut key) =
            load_passkey_by_key(&state.db, &hex::encode(result.cred_id().as_slice()))?;
        if key.update_credential(&result).is_none() {
            return Err(AuthError::VerificationFailed);
        }
        let public_json = serde_json::to_string(&key).map_err(|_| AuthError::Persistence)?;
        let issued = prepare_session(&self.host_id, &self.origin, &device_id)?;
        let tx = state.db.transaction().map_err(|_| AuthError::Persistence)?;
        tx.execute(
            "UPDATE owner_credentials SET passkey_json=?1 WHERE id=?2 AND revoked_at_ms IS NULL",
            params![public_json, device_id],
        )
        .map_err(|_| AuthError::Persistence)?;
        persist_session(&tx, &issued, now)?;
        tx.commit().map_err(|_| AuthError::Persistence)?;
        remember_session_deadline(&mut state, &issued.principal.token_hash, now);
        Ok(issued)
    }
    pub(crate) fn begin_management(
        &self,
        principal: &OwnerPrincipal,
        action: OwnerManagementAction,
    ) -> AuthResult<OwnerChallenge> {
        let mut state = self.lock()?;
        self.recheck_locked(&mut state, principal)?;
        validate_management_action(&state.db, &action)?;
        let now = self.clock.now();
        cleanup_ephemeral(&mut state, now)?;
        if state.ceremonies.len() >= MAX_CEREMONIES {
            return Err(AuthError::LimitReached);
        }
        let passkeys: Vec<Passkey> = load_passkeys(&state.db, Some(&principal.device_id))?
            .into_iter()
            .map(|(_, key)| key)
            .collect();
        let (challenge, authentication) = self
            .verifier
            .start_passkey_authentication(&passkeys)
            .map_err(|_| AuthError::VerificationFailed)?;
        let public_key = public_options(challenge)?;
        let ceremony_id = Uuid::new_v4().to_string();
        state.ceremonies.insert(
            ceremony_id.clone(),
            PendingCeremony {
                deadline: Deadline::new(now, CEREMONY_TTL_MS),
                kind: CeremonyKind::Management {
                    principal: principal.clone(),
                    action,
                    state: authentication,
                },
            },
        );
        Ok(OwnerChallenge {
            ceremony_id,
            public_key,
            expires_in_seconds: 60,
        })
    }
    pub(crate) fn finish_management(
        &self,
        principal: &OwnerPrincipal,
        ceremony_id: &str,
        response: Value,
    ) -> AuthResult<OwnerManagementOutcome> {
        let mut state = self.lock()?;
        self.recheck_locked(&mut state, principal)?;
        let pending = take_ceremony(&mut state, ceremony_id, self.clock.now())?;
        let CeremonyKind::Management {
            principal: captured,
            action,
            state: authentication,
        } = pending.kind
        else {
            return Err(AuthError::InvalidCeremony);
        };
        if captured.token_hash != principal.token_hash
            || captured.session_id != principal.session_id
            || captured.device_id != principal.device_id
        {
            return Err(AuthError::Unauthorized);
        }
        let credential: PublicKeyCredential =
            serde_json::from_value(response).map_err(|_| AuthError::InvalidRequest)?;
        let result = self
            .verifier
            .finish_passkey_authentication(&credential, &authentication)
            .map_err(|_| AuthError::VerificationFailed)?;
        let now = self.clock.now();
        if !pending.deadline.current(now) {
            return Err(AuthError::ExpiredCeremony);
        }
        self.recheck_locked(&mut state, principal)?;
        let (verified_device, mut key) =
            load_passkey_by_key(&state.db, &hex::encode(result.cred_id().as_slice()))?;
        if verified_device != principal.device_id || key.update_credential(&result).is_none() {
            return Err(AuthError::VerificationFailed);
        }
        validate_management_action(&state.db, &action)?;
        let public_json = serde_json::to_string(&key).map_err(|_| AuthError::Persistence)?;
        cleanup_ephemeral(&mut state, now)?;
        if matches!(action, OwnerManagementAction::Invite)
            && state.invitations.len() >= MAX_INVITATIONS
        {
            return Err(AuthError::LimitReached);
        }
        let invitation = matches!(action, OwnerManagementAction::Invite).then(|| OwnerInvite {
            invitation_secret: new_secret(),
            expires_in_seconds: 60,
        });
        let tx = state.db.transaction().map_err(|_| AuthError::Persistence)?;
        tx.execute(
            "UPDATE owner_credentials SET passkey_json=?1 WHERE id=?2 AND revoked_at_ms IS NULL",
            params![public_json, principal.device_id],
        )
        .map_err(|_| AuthError::Persistence)?;
        match &action {
            OwnerManagementAction::Invite => {
                let invite = invitation.as_ref().ok_or(AuthError::Persistence)?;
                tx.execute("INSERT INTO owner_invites (token_hash,created_at_ms,expires_at_ms,issuer_credential_id) VALUES (?1,?2,?3,?4)",params![hash_token(&invite.invitation_secret),now.wall_ms,now.wall_ms.saturating_add(CEREMONY_TTL_MS),principal.device_id]).map_err(|_|AuthError::Persistence)?;
            }
            OwnerManagementAction::RevokeCredential { device_id } => {
                tx.execute(
                    "UPDATE owner_credentials SET revoked_at_ms=?1 WHERE id=?2",
                    params![now.wall_ms, device_id],
                )
                .map_err(|_| AuthError::Persistence)?;
                tx.execute(
                    "UPDATE owner_sessions SET revoked_at_ms=?1 WHERE credential_id=?2",
                    params![now.wall_ms, device_id],
                )
                .map_err(|_| AuthError::Persistence)?;
                tx.execute(
                    "DELETE FROM owner_invites WHERE issuer_credential_id=?1",
                    [device_id],
                )
                .map_err(|_| AuthError::Persistence)?;
            }
            OwnerManagementAction::RevokeSession { session_id } => {
                tx.execute(
                    "UPDATE owner_sessions SET revoked_at_ms=?1 WHERE id=?2",
                    params![now.wall_ms, session_id],
                )
                .map_err(|_| AuthError::Persistence)?;
            }
        }
        tx.commit().map_err(|_| AuthError::Persistence)?;
        if let Some(invite) = &invitation {
            state.invitations.insert(
                hash_token(&invite.invitation_secret),
                Deadline::new(now, CEREMONY_TTL_MS),
            );
        }
        Ok(OwnerManagementOutcome {
            invitation,
            revoked: !matches!(action, OwnerManagementAction::Invite),
        })
    }
    pub(crate) fn logout(&self, principal: &OwnerPrincipal) -> AuthResult<()> {
        let mut state = self.lock()?;
        self.recheck_locked(&mut state, principal)?;
        state
            .db
            .execute(
                "UPDATE owner_sessions SET revoked_at_ms=?1 WHERE id=?2 AND token_hash=?3",
                params![
                    self.clock.now().wall_ms,
                    principal.session_id,
                    principal.token_hash
                ],
            )
            .map_err(|_| AuthError::Persistence)?;
        state.session_deadlines.remove(&principal.token_hash);
        Ok(())
    }
    pub(crate) fn list_devices(
        &self,
        principal: &OwnerPrincipal,
    ) -> AuthResult<Vec<OwnerDeviceView>> {
        let mut state = self.lock()?;
        self.recheck_locked(&mut state, principal)?;
        let now = self.clock.now().wall_ms;
        let mut query=state.db.prepare("SELECT c.id,c.label,c.created_at_ms,c.revoked_at_ms IS NOT NULL,(SELECT COUNT(*) FROM owner_sessions s WHERE s.credential_id=c.id AND s.revoked_at_ms IS NULL AND s.absolute_expires_ms>?1 AND s.last_seen_ms>?2) FROM owner_credentials c ORDER BY c.created_at_ms,c.id").map_err(|_|AuthError::Persistence)?;
        let rows = query
            .query_map(params![now, now.saturating_sub(SESSION_IDLE_MS)], |r| {
                Ok(OwnerDeviceView {
                    device_id: r.get(0)?,
                    label: r.get(1)?,
                    created_at_ms: r.get(2)?,
                    revoked: r.get(3)?,
                    active_sessions: r.get(4)?,
                })
            })
            .map_err(|_| AuthError::Persistence)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| AuthError::Persistence)
    }
}
fn parse_origin(origin: &str) -> AuthResult<Url> {
    let url = Url::parse(origin).map_err(|_| AuthError::InvalidConfiguration)?;
    if url.scheme() != "https"
        || url.domain().is_none()
        || url.domain().is_some_and(|d| d.ends_with('.'))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AuthError::InvalidConfiguration);
    }
    Ok(url)
}
fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> AuthResult<Option<&'a str>> {
    let mut values = headers.get_all(name).iter();
    let first = values
        .next()
        .map(|v| v.to_str().map_err(|_| AuthError::InvalidRequest))
        .transpose()?;
    if values.next().is_some() {
        return Err(AuthError::InvalidRequest);
    }
    Ok(first)
}
fn cookie_token(headers: &HeaderMap) -> AuthResult<String> {
    let mut selected = None;
    for header in headers.get_all(header::COOKIE) {
        let text = header.to_str().map_err(|_| AuthError::Unauthorized)?;
        for pair in text.split(';') {
            if let Some((name, value)) = pair.trim().split_once('=') {
                if name == OWNER_COOKIE_NAME {
                    if selected.is_some() || !valid_token(value) {
                        return Err(AuthError::Unauthorized);
                    }
                    selected = Some(value.to_string());
                }
            }
        }
    }
    selected.ok_or(AuthError::Unauthorized)
}
fn new_secret() -> String {
    // Two independent OS-random UUIDv4 values provide 244 random bits. One UUID
    // alone has 122, below the invitation's >=128-bit requirement.
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
fn valid_token(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}
fn csrf_mac(token: &str, origin: &str, session_id: &str) -> AuthResult<Hmac<Sha256>> {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(token.as_bytes()).map_err(|_| AuthError::Persistence)?;
    mac.update(b"ccsm-owner-csrf-v1\0");
    mac.update(origin.as_bytes());
    mac.update(b"\0");
    mac.update(session_id.as_bytes());
    Ok(mac)
}
fn csrf_token(token: &str, origin: &str, session_id: &str) -> AuthResult<String> {
    Ok(hex::encode(
        csrf_mac(token, origin, session_id)?.finalize().into_bytes(),
    ))
}
fn verify_csrf(token: &str, origin: &str, session_id: &str, supplied: &str) -> AuthResult<()> {
    if supplied.len() != 64 {
        return Err(AuthError::ForbiddenCsrf);
    }
    let bytes = hex::decode(supplied).map_err(|_| AuthError::ForbiddenCsrf)?;
    csrf_mac(token, origin, session_id)?
        .verify_slice(&bytes)
        .map_err(|_| AuthError::ForbiddenCsrf)
}
fn public_options(challenge: impl Serialize) -> AuthResult<Value> {
    serde_json::to_value(challenge)
        .map_err(|_| AuthError::Persistence)?
        .get("publicKey")
        .cloned()
        .ok_or(AuthError::Persistence)
}
fn validate_label(label: &str) -> AuthResult<String> {
    let label = label.trim();
    if label.is_empty() || label.chars().count() > 64 || label.chars().any(char::is_control) {
        return Err(AuthError::InvalidRequest);
    }
    Ok(label.to_string())
}
fn cleanup_ephemeral(state: &mut AuthState, now: AuthTime) -> AuthResult<()> {
    let expired_invites: Vec<String> = state
        .invitations
        .iter()
        .filter(|(_, d)| !d.current(now))
        .map(|(hash, _)| hash.clone())
        .collect();
    let expired_sessions: Vec<String> = state
        .session_deadlines
        .iter()
        .filter(|(_, d)| now.steady_ms >= d.absolute_steady_ms || now.steady_ms >= d.idle_steady_ms)
        .map(|(hash, _)| hash.clone())
        .collect();
    if !expired_invites.is_empty() || !expired_sessions.is_empty() {
        let tx = state.db.transaction().map_err(|_| AuthError::Persistence)?;
        for hash in &expired_invites {
            tx.execute("DELETE FROM owner_invites WHERE token_hash=?1", [hash])
                .map_err(|_| AuthError::Persistence)?;
        }
        // Never evict the only monotonic-expiry evidence before durable revocation:
        // a clock rollback must not let a later lookup reconstruct a fresh deadline.
        for hash in &expired_sessions {
            tx.execute("UPDATE owner_sessions SET revoked_at_ms=?1 WHERE token_hash=?2 AND revoked_at_ms IS NULL", params![now.wall_ms, hash]).map_err(|_| AuthError::Persistence)?;
        }
        tx.commit().map_err(|_| AuthError::Persistence)?;
    }
    state.ceremonies.retain(|_, p| p.deadline.current(now));
    state.invitations.retain(|_, d| d.current(now));
    for hash in expired_sessions {
        state.session_deadlines.remove(&hash);
    }
    Ok(())
}
fn take_ceremony(state: &mut AuthState, id: &str, now: AuthTime) -> AuthResult<PendingCeremony> {
    if Uuid::parse_str(id).is_err() {
        return Err(AuthError::InvalidCeremony);
    }
    let pending = state
        .ceremonies
        .remove(id)
        .ok_or(AuthError::InvalidCeremony)?;
    if !pending.deadline.current(now) {
        return Err(AuthError::ExpiredCeremony);
    }
    Ok(pending)
}
fn validate_invitation(state: &AuthState, hash: &str, now: AuthTime) -> AuthResult<()> {
    if !state.invitations.get(hash).is_some_and(|d| d.current(now)) {
        return Err(AuthError::ExpiredCeremony);
    }
    let issuer:Option<Option<String>>=state.db.query_row("SELECT issuer_credential_id FROM owner_invites WHERE token_hash=?1 AND created_at_ms<=?2 AND expires_at_ms>?2",params![hash,now.wall_ms],|r|r.get(0)).optional().map_err(|_|AuthError::Persistence)?;
    match issuer {
        None => Err(AuthError::Unauthorized),
        Some(None) => Ok(()),
        Some(Some(issuer)) => {
            let valid:bool=state.db.query_row("SELECT EXISTS(SELECT 1 FROM owner_credentials WHERE id=?1 AND revoked_at_ms IS NULL)",[issuer],|r|r.get(0)).map_err(|_|AuthError::Persistence)?;
            if valid {
                Ok(())
            } else {
                Err(AuthError::Unauthorized)
            }
        }
    }
}
fn count_active_credentials(db: &Connection) -> AuthResult<i64> {
    db.query_row(
        "SELECT COUNT(*) FROM owner_credentials WHERE revoked_at_ms IS NULL",
        [],
        |r| r.get(0),
    )
    .map_err(|_| AuthError::Persistence)
}
fn load_passkeys(db: &Connection, device_id: Option<&str>) -> AuthResult<Vec<(String, Passkey)>> {
    let mut query=db.prepare("SELECT id,passkey_json FROM owner_credentials WHERE revoked_at_ms IS NULL AND (?1 IS NULL OR id=?1) ORDER BY id").map_err(|_|AuthError::Persistence)?;
    let rows = query
        .query_map([device_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|_| AuthError::Persistence)?;
    let mut keys = Vec::new();
    for row in rows {
        let (id, json) = row.map_err(|_| AuthError::Persistence)?;
        keys.push((
            id,
            serde_json::from_str(&json).map_err(|_| AuthError::Persistence)?,
        ));
    }
    Ok(keys)
}
fn load_passkey_by_key(db: &Connection, key: &str) -> AuthResult<(String, Passkey)> {
    let row:Option<(String,String)>=db.query_row("SELECT id,passkey_json FROM owner_credentials WHERE credential_key=?1 AND revoked_at_ms IS NULL",[key],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_|AuthError::Persistence)?;
    let (id, json) = row.ok_or(AuthError::Unauthorized)?;
    Ok((
        id,
        serde_json::from_str(&json).map_err(|_| AuthError::Persistence)?,
    ))
}
fn validate_management_action(db: &Connection, action: &OwnerManagementAction) -> AuthResult<()> {
    let exists=match action {OwnerManagementAction::Invite=>true,OwnerManagementAction::RevokeCredential {device_id}=>db.query_row("SELECT EXISTS(SELECT 1 FROM owner_credentials WHERE id=?1 AND revoked_at_ms IS NULL)",[device_id],|r|r.get(0)).map_err(|_|AuthError::Persistence)?,OwnerManagementAction::RevokeSession {session_id}=>db.query_row("SELECT EXISTS(SELECT 1 FROM owner_sessions WHERE id=?1 AND revoked_at_ms IS NULL)",[session_id],|r|r.get(0)).map_err(|_|AuthError::Persistence)?};
    if exists {
        Ok(())
    } else {
        Err(AuthError::InvalidRequest)
    }
}
fn prepare_session(host_id: &str, origin: &str, device_id: &str) -> AuthResult<OwnerSessionIssued> {
    let secret = new_secret();
    let session_id = Uuid::new_v4().to_string();
    let csrf_token = csrf_token(&secret, origin, &session_id)?;
    let principal = OwnerPrincipal {
        host_id: host_id.to_string(),
        device_id: device_id.to_string(),
        session_id,
        token_hash: hash_token(&secret),
    };
    Ok(OwnerSessionIssued {
        cookie_header: format!(
            "{OWNER_COOKIE_NAME}={secret}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age={}",
            SESSION_ABSOLUTE_MS / 1000
        ),
        csrf_token,
        principal,
    })
}
fn persist_session(
    tx: &Transaction<'_>,
    issued: &OwnerSessionIssued,
    now: AuthTime,
) -> AuthResult<()> {
    tx.execute("DELETE FROM owner_sessions WHERE revoked_at_ms IS NOT NULL OR absolute_expires_ms<=?1 OR last_seen_ms<=?2",params![now.wall_ms,now.wall_ms.saturating_sub(SESSION_IDLE_MS)]).map_err(|_|AuthError::Persistence)?;
    let count: i64 = tx
        .query_row("SELECT COUNT(*) FROM owner_sessions", [], |r| r.get(0))
        .map_err(|_| AuthError::Persistence)?;
    if count >= MAX_SESSIONS {
        return Err(AuthError::LimitReached);
    }
    tx.execute("INSERT INTO owner_sessions (id,token_hash,credential_id,created_at_ms,last_seen_ms,absolute_expires_ms) VALUES (?1,?2,?3,?4,?4,?5)",params![issued.principal.session_id,issued.principal.token_hash,issued.principal.device_id,now.wall_ms,now.wall_ms.saturating_add(SESSION_ABSOLUTE_MS)]).map_err(|_|AuthError::Persistence)?;
    Ok(())
}
fn remember_session_deadline(state: &mut AuthState, hash: &str, now: AuthTime) {
    state.session_deadlines.insert(
        hash.to_string(),
        SessionDeadline {
            absolute_steady_ms: now.steady_ms.saturating_add(SESSION_ABSOLUTE_MS as u64),
            idle_steady_ms: now.steady_ms.saturating_add(SESSION_IDLE_MS as u64),
        },
    );
}
fn read_active_session(
    state: &mut AuthState,
    hash: &str,
    now: AuthTime,
    touch: bool,
) -> AuthResult<(String, String)> {
    let record:Option<(String,String,i64,i64,i64)>=state.db.query_row("SELECT s.id,s.credential_id,s.created_at_ms,s.last_seen_ms,s.absolute_expires_ms FROM owner_sessions s JOIN owner_credentials c ON c.id=s.credential_id WHERE s.token_hash=?1 AND s.revoked_at_ms IS NULL AND c.revoked_at_ms IS NULL",[hash],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(|_|AuthError::Persistence)?;
    let (session_id, device_id, created, last_seen, absolute) =
        record.ok_or(AuthError::Unauthorized)?;
    if created > now.wall_ms
        || last_seen > now.wall_ms
        || absolute <= now.wall_ms
        || now.wall_ms.saturating_sub(last_seen) >= SESSION_IDLE_MS
    {
        state
            .db
            .execute(
                "UPDATE owner_sessions SET revoked_at_ms=?1 WHERE token_hash=?2",
                params![now.wall_ms, hash],
            )
            .map_err(|_| AuthError::Persistence)?;
        state.session_deadlines.remove(hash);
        return Err(AuthError::Unauthorized);
    }
    let deadlines = state
        .session_deadlines
        .entry(hash.to_string())
        .or_insert_with(|| SessionDeadline {
            absolute_steady_ms: now
                .steady_ms
                .saturating_add(absolute.saturating_sub(now.wall_ms) as u64),
            idle_steady_ms: now
                .steady_ms
                .saturating_add((SESSION_IDLE_MS - now.wall_ms.saturating_sub(last_seen)) as u64),
        });
    if now.steady_ms >= deadlines.absolute_steady_ms || now.steady_ms >= deadlines.idle_steady_ms {
        state
            .db
            .execute(
                "UPDATE owner_sessions SET revoked_at_ms=?1 WHERE token_hash=?2",
                params![now.wall_ms, hash],
            )
            .map_err(|_| AuthError::Persistence)?;
        state.session_deadlines.remove(hash);
        return Err(AuthError::Unauthorized);
    }
    if touch {
        state.db.execute("UPDATE owner_sessions SET last_seen_ms=?1 WHERE token_hash=?2 AND revoked_at_ms IS NULL",params![now.wall_ms,hash]).map_err(|_|AuthError::Persistence)?;
        deadlines.idle_steady_ms = now.steady_ms.saturating_add(SESSION_IDLE_MS as u64);
    }
    Ok((session_id, device_id))
}

#[cfg(test)]
impl OwnerRemoteAuth {
    /// Exercises the real verifier and canonical store; never an authorization bypass.
    pub(super) fn test_session(&self) -> OwnerSessionIssued {
        use webauthn_authenticator_rs::{softpasskey::SoftPasskey, WebauthnAuthenticator};
        let invitation = self.create_local_invite().unwrap();
        let challenge = self
            .begin_registration(&invitation.invitation_secret, "Test browser")
            .unwrap();
        let options =
            serde_json::from_value(serde_json::json!({"publicKey":challenge.public_key})).unwrap();
        let mut passkey = SoftPasskey::new(true);
        let response = passkey
            .do_registration(Url::parse(self.origin()).unwrap(), options)
            .unwrap();
        self.finish_registration(
            &challenge.ceremony_id,
            serde_json::to_value(response).unwrap(),
        )
        .unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use webauthn_authenticator_rs::{softpasskey::SoftPasskey, WebauthnAuthenticator};

    struct TestClock(Mutex<AuthTime>);
    impl TestClock {
        fn new() -> Self {
            Self(Mutex::new(AuthTime {
                wall_ms: 1_800_000_000_000,
                steady_ms: 0,
            }))
        }
        fn advance(&self, millis: i64) {
            let mut now = self.0.lock().unwrap();
            now.wall_ms += millis;
            now.steady_ms += millis as u64;
        }
        fn wall_rollback(&self, millis: i64) {
            self.0.lock().unwrap().wall_ms -= millis;
        }
        fn steady_advance(&self, millis: u64) {
            self.0.lock().unwrap().steady_ms += millis;
        }
    }
    impl AuthClock for TestClock {
        fn now(&self) -> AuthTime {
            *self.0.lock().unwrap()
        }
    }
    fn setup() -> (TempDir, OwnerRemoteAuth, Arc<TestClock>) {
        let dir = TempDir::new().unwrap();
        let clock = Arc::new(TestClock::new());
        let auth = OwnerRemoteAuth::open_with_clock(
            &dir.path().join("owner-remote-auth.sqlite"),
            "https://host.example",
            clock.clone(),
        )
        .unwrap();
        (dir, auth, clock)
    }
    fn origin() -> Url {
        Url::parse("https://host.example").unwrap()
    }
    fn register_response(key: &mut SoftPasskey, challenge: &OwnerChallenge) -> Value {
        let options =
            serde_json::from_value(serde_json::json!({"publicKey":challenge.public_key})).unwrap();
        serde_json::to_value(key.do_registration(origin(), options).unwrap()).unwrap()
    }
    fn assertion(key: &mut SoftPasskey, challenge: &OwnerChallenge) -> Value {
        let options =
            serde_json::from_value(serde_json::json!({"publicKey":challenge.public_key})).unwrap();
        serde_json::to_value(key.do_authentication(origin(), options).unwrap()).unwrap()
    }
    fn enroll(auth: &OwnerRemoteAuth, key: &mut SoftPasskey) -> OwnerSessionIssued {
        let invite = auth.create_local_invite().unwrap();
        let challenge = auth
            .begin_registration(&invite.invitation_secret, "Tablet")
            .unwrap();
        let response = register_response(key, &challenge);
        auth.finish_registration(&challenge.ceremony_id, response)
            .unwrap()
    }
    fn login(auth: &OwnerRemoteAuth, key: &mut SoftPasskey) -> OwnerSessionIssued {
        let challenge = auth.begin_login().unwrap();
        let response = assertion(key, &challenge);
        auth.finish_login(&challenge.ceremony_id, response).unwrap()
    }
    fn headers(session: &OwnerSessionIssued, mutation: bool) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "host.example".parse().unwrap());
        headers.insert(
            header::COOKIE,
            session
                .cookie_header
                .split(';')
                .next()
                .unwrap()
                .parse()
                .unwrap(),
        );
        headers.insert("sec-fetch-site", "same-origin".parse().unwrap());
        if mutation {
            headers.insert(header::ORIGIN, "https://host.example".parse().unwrap());
            headers.insert("x-ccsm-csrf", session.csrf_token.parse().unwrap());
        }
        headers
    }
    fn count(auth: &OwnerRemoteAuth, table: &str) -> i64 {
        auth.lock()
            .unwrap()
            .db
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn pinned_origin_lookup_never_creates_an_unenrolled_store() {
        let dir = TempDir::new().unwrap();
        let local = dir.path().join("not-created");
        let path = local.join("owner-remote-auth.sqlite");
        assert_eq!(OwnerRemoteAuth::read_pinned_origin(&path).unwrap(), None);
        assert!(!local.exists());
        assert!(matches!(
            OwnerRemoteAuth::read_pinned_origin(&dir.path().join("cc-switch.db")),
            Err(AuthError::InvalidConfiguration)
        ));
        assert!(!dir.path().join("cc-switch.db").exists());
    }

    #[test]
    fn pinned_origin_lookup_is_read_only_and_preserves_unfinished_enrollment() {
        let (dir, auth, _) = setup();
        let invitation = auth.create_local_invite().unwrap();
        let path = dir.path().join("owner-remote-auth.sqlite");
        let before = std::fs::read(&path).unwrap();
        assert_eq!(count(&auth, "owner_invites"), 1);
        assert_eq!(
            OwnerRemoteAuth::read_pinned_origin(&path)
                .unwrap()
                .as_deref(),
            Some("https://host.example")
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(count(&auth, "owner_invites"), 1);
        assert!(auth
            .begin_registration(&invitation.invitation_secret, "Tablet")
            .is_ok());
    }

    #[test]
    fn pinned_origin_lookup_rejects_unknown_or_corrupt_trust_without_repair() {
        let (dir, auth, _) = setup();
        let path = dir.path().join("owner-remote-auth.sqlite");
        auth.lock()
            .unwrap()
            .db
            .execute_batch("PRAGMA user_version=2")
            .unwrap();
        assert!(matches!(
            OwnerRemoteAuth::read_pinned_origin(&path),
            Err(AuthError::InvalidConfiguration)
        ));
        auth.lock()
            .unwrap()
            .db
            .execute_batch("PRAGMA user_version=1")
            .unwrap();
        auth.lock()
            .unwrap()
            .db
            .execute(
                "UPDATE owner_auth_meta SET origin=?1 WHERE id=1",
                ["http://invalid.example"],
            )
            .unwrap();
        assert!(matches!(
            OwnerRemoteAuth::read_pinned_origin(&path),
            Err(AuthError::InvalidConfiguration)
        ));
        drop(auth);
        let corrupt = b"not-a-sqlite-owner-store";
        std::fs::write(&path, corrupt).unwrap();
        assert!(matches!(
            OwnerRemoteAuth::read_pinned_origin(&path),
            Err(AuthError::Persistence)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), corrupt);
    }
    #[test]
    fn rejects_non_https_ip_and_non_origin_configurations() {
        for input in [
            "http://host.example",
            "https://127.0.0.1",
            "https://user@host.example",
            "https://host.example/path",
            "https://host.example/?q=1",
            "https://host.example/#secret",
            "https://host.example.",
        ] {
            assert!(parse_origin(input).is_err());
        }
        assert_eq!(
            parse_origin("https://host.example")
                .unwrap()
                .origin()
                .ascii_serialization(),
            "https://host.example"
        );
    }
    #[test]
    fn refuses_main_synced_database_and_origin_rebinding() {
        let (dir, auth, _) = setup();
        let host_id = auth.host_id().to_string();
        drop(auth);
        assert!(matches!(
            OwnerRemoteAuth::open(&dir.path().join("cc-switch.db"), "https://host.example"),
            Err(AuthError::InvalidConfiguration)
        ));
        assert!(matches!(
            OwnerRemoteAuth::open(
                &dir.path().join("owner-remote-auth.sqlite"),
                "https://other.example"
            ),
            Err(AuthError::InvalidConfiguration)
        ));
        assert_eq!(
            OwnerRemoteAuth::open(
                &dir.path().join("owner-remote-auth.sqlite"),
                "https://host.example"
            )
            .unwrap()
            .host_id(),
            host_id
        );
    }
    #[test]
    fn real_passkey_registration_login_and_cookie_session_work() {
        let (_dir, auth, _) = setup();
        let mut key = SoftPasskey::new(true);
        let session = enroll(&auth, &mut key);
        for flag in [
            "Path=/",
            "Secure",
            "HttpOnly",
            "SameSite=Strict",
            "Max-Age=604800",
        ] {
            assert!(session.cookie_header.contains(flag));
        }
        assert!(!session.cookie_header.contains("Domain="));
        assert!(auth.authorize(&headers(&session, true), true).is_ok());
        let info = auth.session_info(&headers(&session, false)).unwrap();
        assert_eq!(info.csrf_token, session.csrf_token);
        assert_eq!(info.principal.device_id, session.principal.device_id);
        let second = login(&auth, &mut key);
        assert_ne!(second.cookie_header, session.cookie_header);
        assert_ne!(second.csrf_token, session.csrf_token);
        assert_eq!(second.principal.device_id, session.principal.device_id);
        let json = serde_json::to_value(info).unwrap();
        assert!(json.get("tokenHash").is_none());
        assert!(json.get("csrfToken").is_some());
    }
    #[test]
    fn no_plaintext_invitation_or_session_is_persisted() {
        let (_dir, auth, _) = setup();
        let invite = auth.create_local_invite().unwrap();
        let secret = invite.invitation_secret.clone();
        let challenge = auth.begin_registration(&secret, "Laptop").unwrap();
        let mut key = SoftPasskey::new(true);
        let response = register_response(&mut key, &challenge);
        let session = auth
            .finish_registration(&challenge.ceremony_id, response)
            .unwrap();
        let cookie = session
            .cookie_header
            .split(';')
            .next()
            .unwrap()
            .split_once('=')
            .unwrap()
            .1;
        let state = auth.lock().unwrap();
        let hash: String = state
            .db
            .query_row("SELECT token_hash FROM owner_sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(hash, hash_token(cookie));
        assert_ne!(hash, cookie);
        assert_eq!(count_active_credentials(&state.db).unwrap(), 1);
        drop(state);
        let bytes = std::fs::read(_dir.path().join("owner-remote-auth.sqlite")).unwrap();
        assert!(!bytes.windows(secret.len()).any(|v| v == secret.as_bytes()));
        assert!(!bytes.windows(cookie.len()).any(|v| v == cookie.as_bytes()));
    }
    #[test]
    fn invalid_registration_cannot_create_session_or_replay_ceremony() {
        let (_dir, auth, _) = setup();
        let invite = auth.create_local_invite().unwrap();
        let challenge = auth
            .begin_registration(&invite.invitation_secret, "Tablet")
            .unwrap();
        assert_eq!(
            auth.finish_registration(&challenge.ceremony_id, serde_json::json!({}))
                .err(),
            Some(AuthError::InvalidRequest)
        );
        assert_eq!(
            auth.finish_registration(&challenge.ceremony_id, serde_json::json!({}))
                .err(),
            Some(AuthError::InvalidCeremony)
        );
        assert_eq!(count(&auth, "owner_sessions"), 0);
        assert_eq!(count(&auth, "owner_credentials"), 0);
    }
    #[test]
    fn invitation_and_ceremony_expire_at_sixty_seconds() {
        let (_dir, auth, clock) = setup();
        let invite = auth.create_local_invite().unwrap();
        let challenge = auth
            .begin_registration(&invite.invitation_secret, "Tablet")
            .unwrap();
        let mut key = SoftPasskey::new(true);
        let response = register_response(&mut key, &challenge);
        clock.advance(CEREMONY_TTL_MS);
        assert_eq!(
            auth.finish_registration(&challenge.ceremony_id, response)
                .err(),
            Some(AuthError::ExpiredCeremony)
        );
        assert!(auth
            .begin_registration(&invite.invitation_secret, "Tablet")
            .is_err());
        assert_eq!(count(&auth, "owner_sessions"), 0);
    }
    #[test]
    fn monotonic_deadline_prevents_clock_rollback_catchup_revival() {
        let (_dir, auth, clock) = setup();
        let invite = auth.create_local_invite().unwrap();
        clock.steady_advance(CEREMONY_TTL_MS as u64);
        assert!(auth
            .begin_registration(&invite.invitation_secret, "Tablet")
            .is_err());
        let session = auth.test_session();
        clock.steady_advance(SESSION_IDLE_MS as u64);
        assert!(auth.authorize(&headers(&session, false), false).is_err());
    }
    #[test]
    fn unfinished_invites_and_challenges_do_not_survive_restart() {
        let (dir, auth, _) = setup();
        let invite = auth.create_local_invite().unwrap();
        let challenge = auth
            .begin_registration(&invite.invitation_secret, "Tablet")
            .unwrap();
        drop(auth);
        let restarted = OwnerRemoteAuth::open(
            &dir.path().join("owner-remote-auth.sqlite"),
            "https://host.example",
        )
        .unwrap();
        assert!(restarted
            .begin_registration(&invite.invitation_secret, "Tablet")
            .is_err());
        assert_eq!(
            restarted
                .finish_registration(&challenge.ceremony_id, serde_json::json!({}))
                .err(),
            Some(AuthError::InvalidCeremony)
        );
    }
    #[test]
    fn invitation_success_is_one_use_and_registration_is_not_parallel() {
        let (_dir, auth, _) = setup();
        let invite = auth.create_local_invite().unwrap();
        let challenge = auth
            .begin_registration(&invite.invitation_secret, "Tablet")
            .unwrap();
        assert_eq!(
            auth.begin_registration(&invite.invitation_secret, "Tablet")
                .err(),
            Some(AuthError::Conflict)
        );
        let mut key = SoftPasskey::new(true);
        let response = register_response(&mut key, &challenge);
        auth.finish_registration(&challenge.ceremony_id, response.clone())
            .unwrap();
        assert!(auth
            .begin_registration(&invite.invitation_secret, "Tablet")
            .is_err());
        assert_eq!(
            auth.finish_registration(&challenge.ceremony_id, response)
                .err(),
            Some(AuthError::InvalidCeremony)
        );
    }
    #[test]
    fn failed_persistence_never_authorizes_or_returns_cookie() {
        let (_dir, auth, _) = setup();
        let invite = auth.create_local_invite().unwrap();
        let challenge = auth
            .begin_registration(&invite.invitation_secret, "Tablet")
            .unwrap();
        let mut key = SoftPasskey::new(true);
        let response = register_response(&mut key, &challenge);
        auth.lock()
            .unwrap()
            .db
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        assert_eq!(
            auth.finish_registration(&challenge.ceremony_id, response)
                .err(),
            Some(AuthError::Persistence)
        );
        assert_eq!(count(&auth, "owner_credentials"), 0);
        assert_eq!(count(&auth, "owner_sessions"), 0);
    }
    #[test]
    fn request_policy_rejects_cross_site_null_foreign_host_and_duplicate_cookies() {
        let (_dir, auth, _) = setup();
        let session = auth.test_session();
        let valid = headers(&session, true);
        assert!(auth.authorize(&valid, true).is_ok());
        for (name, value) in [
            ("host", "attacker.example"),
            ("origin", "null"),
            ("origin", "https://evil.host.example"),
            ("sec-fetch-site", "cross-site"),
            ("sec-fetch-site", "same-site"),
            ("x-ccsm-csrf", "invalid"),
        ] {
            let mut altered = valid.clone();
            altered.insert(
                http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                value.parse().unwrap(),
            );
            assert!(auth.authorize(&altered, true).is_err());
        }
        let mut missing = valid.clone();
        missing.remove(header::ORIGIN);
        assert!(auth.authorize(&missing, true).is_err());
        let mut duplicate = valid.clone();
        duplicate.append(header::COOKIE, valid[header::COOKIE].clone());
        assert!(auth.authorize(&duplicate, false).is_err());
        let mut duplicate = valid.clone();
        duplicate.append(header::HOST, valid[header::HOST].clone());
        assert!(auth.authorize(&duplicate, false).is_err());
    }
    #[test]
    fn csrf_token_is_bound_to_exact_session() {
        let (_dir, auth, _) = setup();
        let mut key = SoftPasskey::new(true);
        let first = enroll(&auth, &mut key);
        let second = login(&auth, &mut key);
        let mut request = headers(&second, true);
        request.insert("x-ccsm-csrf", first.csrf_token.parse().unwrap());
        assert_eq!(
            auth.authorize(&request, true).err(),
            Some(AuthError::ForbiddenCsrf)
        );
    }
    #[test]
    fn idle_expiry_and_clock_rollback_revoke_instead_of_revive() {
        let (_dir, auth, clock) = setup();
        let session = auth.test_session();
        clock.advance(SESSION_IDLE_MS);
        assert!(auth.recheck(&session.principal).is_err());
        clock.wall_rollback(SESSION_IDLE_MS);
        assert!(auth.recheck(&session.principal).is_err());
        let session = auth.test_session();
        clock.wall_rollback(1);
        assert!(auth.recheck(&session.principal).is_err());
        clock.advance(1);
        assert!(auth.recheck(&session.principal).is_err());
    }
    #[test]
    fn activity_never_extends_seven_day_absolute_expiry() {
        let (_dir, auth, clock) = setup();
        let session = auth.test_session();
        for _ in 0..14 {
            clock.advance(SESSION_IDLE_MS - 1);
            auth.authorize(&headers(&session, false), false).unwrap();
        }
        clock.advance(14);
        assert!(auth.recheck(&session.principal).is_err());
    }
    #[test]
    fn login_and_management_ceremonies_cannot_be_substituted_or_replayed() {
        let (_dir, auth, _) = setup();
        let mut key = SoftPasskey::new(true);
        let session = enroll(&auth, &mut key);
        let management = auth
            .begin_management(&session.principal, OwnerManagementAction::Invite)
            .unwrap();
        let response = assertion(&mut key, &management);
        assert_eq!(
            auth.finish_login(&management.ceremony_id, response.clone())
                .err(),
            Some(AuthError::InvalidCeremony)
        );
        assert_eq!(
            auth.finish_management(&session.principal, &management.ceremony_id, response)
                .err(),
            Some(AuthError::InvalidCeremony)
        );
        let challenge = auth.begin_login().unwrap();
        let response = assertion(&mut key, &challenge);
        auth.finish_login(&challenge.ceremony_id, response.clone())
            .unwrap();
        assert_eq!(
            auth.finish_login(&challenge.ceremony_id, response).err(),
            Some(AuthError::InvalidCeremony)
        );
    }
    #[test]
    fn management_challenge_is_bound_to_exact_authenticated_session() {
        let (_dir, auth, _) = setup();
        let mut key = SoftPasskey::new(true);
        let first = enroll(&auth, &mut key);
        let second = login(&auth, &mut key);
        let challenge = auth
            .begin_management(&first.principal, OwnerManagementAction::Invite)
            .unwrap();
        let response = assertion(&mut key, &challenge);
        assert_eq!(
            auth.finish_management(&second.principal, &challenge.ceremony_id, response)
                .err(),
            Some(AuthError::Unauthorized)
        );
    }
    #[test]
    fn remote_owner_can_invite_and_revoke_without_host_approval() {
        let (_dir, auth, _) = setup();
        let mut key = SoftPasskey::new(true);
        let first = enroll(&auth, &mut key);
        let challenge = auth
            .begin_management(&first.principal, OwnerManagementAction::Invite)
            .unwrap();
        let response = assertion(&mut key, &challenge);
        let invite = auth
            .finish_management(&first.principal, &challenge.ceremony_id, response)
            .unwrap()
            .invitation
            .unwrap();
        let challenge = auth
            .begin_registration(&invite.invitation_secret, "Laptop")
            .unwrap();
        let mut laptop = SoftPasskey::new(true);
        let response = register_response(&mut laptop, &challenge);
        let second = auth
            .finish_registration(&challenge.ceremony_id, response)
            .unwrap();
        assert!(auth.recheck(&second.principal).is_ok());
        let other_laptop_session = login(&auth, &mut laptop);
        let challenge = auth
            .begin_management(
                &first.principal,
                OwnerManagementAction::RevokeCredential {
                    device_id: second.principal.device_id.to_string(),
                },
            )
            .unwrap();
        let response = assertion(&mut key, &challenge);
        let result = auth
            .finish_management(&first.principal, &challenge.ceremony_id, response)
            .unwrap();
        assert!(result.revoked);
        assert!(auth.recheck(&second.principal).is_err());
        assert!(auth.recheck(&other_laptop_session.principal).is_err());
        assert!(auth.recheck(&first.principal).is_ok());
        assert_eq!(auth.list_devices(&first.principal).unwrap().len(), 2);
    }
    #[test]
    fn revoked_session_cannot_finish_previously_opened_stepup() {
        let (_dir, auth, _) = setup();
        let mut key = SoftPasskey::new(true);
        let session = enroll(&auth, &mut key);
        let challenge = auth
            .begin_management(&session.principal, OwnerManagementAction::Invite)
            .unwrap();
        let response = assertion(&mut key, &challenge);
        auth.logout(&session.principal).unwrap();
        assert!(auth.recheck(&session.principal).is_err());
        assert_eq!(
            auth.finish_management(&session.principal, &challenge.ceremony_id, response)
                .err(),
            Some(AuthError::Unauthorized)
        );
    }
    #[test]
    fn ephemeral_cleanup_bounds_rows_without_reviving_monotonic_expiry() {
        let (_dir, auth, clock) = setup();
        for _ in 0..12 {
            auth.create_local_invite().unwrap();
            clock.advance(CEREMONY_TTL_MS);
        }
        auth.create_local_invite().unwrap();
        assert_eq!(count(&auth, "owner_invites"), 1);
        let session = auth.test_session();
        clock.steady_advance(SESSION_IDLE_MS as u64);
        auth.create_local_invite().unwrap();
        assert!(auth.recheck(&session.principal).is_err());
        assert!(auth.lock().unwrap().session_deadlines.is_empty());
    }
    #[test]
    fn cleanup_durably_revokes_absolute_expiry_before_evicting_cache() {
        let (_dir, auth, clock) = setup();
        let session = auth.test_session();
        // Exercise the absolute branch independently of the idle branch.
        {
            let mut state = auth.lock().unwrap();
            state
                .session_deadlines
                .get_mut(&session.principal.token_hash)
                .unwrap()
                .idle_steady_ms = u64::MAX;
        }
        clock.steady_advance(SESSION_ABSOLUTE_MS as u64);
        auth.create_local_invite().unwrap();
        assert!(auth.recheck(&session.principal).is_err());
    }
    #[test]
    fn failed_csrf_does_not_extend_idle_session_lifetime() {
        let (_dir, auth, clock) = setup();
        let session = auth.test_session();
        clock.advance(60 * 60 * 1000);
        let mut bad = headers(&session, true);
        bad.remove("x-ccsm-csrf");
        assert_eq!(
            auth.authorize(&bad, true).err(),
            Some(AuthError::ForbiddenCsrf)
        );
        clock.advance(11 * 60 * 60 * 1000);
        assert!(auth.recheck(&session.principal).is_err());
    }
    #[test]
    fn verifier_ceremonies_require_user_verification() {
        let (_dir, auth, _) = setup();
        let invite = auth.create_local_invite().unwrap();
        let challenge = auth
            .begin_registration(&invite.invitation_secret, "Tablet")
            .unwrap();
        assert_eq!(
            challenge.public_key["authenticatorSelection"]["userVerification"],
            "required"
        );
        let mut key = SoftPasskey::new(true);
        let response = register_response(&mut key, &challenge);
        auth.finish_registration(&challenge.ceremony_id, response)
            .unwrap();
        let login = auth.begin_login().unwrap();
        assert_eq!(login.public_key["userVerification"], "required");
    }
    #[test]
    fn verifier_rejects_signed_credential_for_different_origin() {
        let (_dir, auth, _) = setup();
        let mut key = SoftPasskey::new(true);
        let _session = enroll(&auth, &mut key);
        let challenge = auth.begin_login().unwrap();
        let options =
            serde_json::from_value(serde_json::json!({"publicKey":challenge.public_key})).unwrap();
        let response = key
            .do_authentication(Url::parse("https://other.host.example").unwrap(), options)
            .unwrap();
        assert_eq!(
            auth.finish_login(
                &challenge.ceremony_id,
                serde_json::to_value(response).unwrap()
            )
            .err(),
            Some(AuthError::VerificationFailed)
        );
    }
}

#[cfg(test)]
mod verifier_failure_tests {
    use super::*;
    use tempfile::TempDir;
    use webauthn_authenticator_rs::{softpasskey::SoftPasskey, WebauthnAuthenticator};
    #[test]
    fn altered_signature_cannot_mint_another_session() {
        let dir = TempDir::new().unwrap();
        let auth = OwnerRemoteAuth::open(
            &dir.path().join("owner-remote-auth.sqlite"),
            "https://host.example",
        )
        .unwrap();
        let invitation = auth.create_local_invite().unwrap();
        let registration = auth
            .begin_registration(&invitation.invitation_secret, "Tablet")
            .unwrap();
        let options =
            serde_json::from_value(serde_json::json!({"publicKey":registration.public_key}))
                .unwrap();
        let mut key = SoftPasskey::new(true);
        let response = key
            .do_registration(Url::parse(auth.origin()).unwrap(), options)
            .unwrap();
        auth.finish_registration(
            &registration.ceremony_id,
            serde_json::to_value(response).unwrap(),
        )
        .unwrap();
        let login = auth.begin_login().unwrap();
        let options =
            serde_json::from_value(serde_json::json!({"publicKey":login.public_key})).unwrap();
        let response = key
            .do_authentication(Url::parse(auth.origin()).unwrap(), options)
            .unwrap();
        let mut encoded = serde_json::to_value(response).unwrap();
        encoded["response"]["signature"] = serde_json::json!("AA");
        assert_eq!(
            auth.finish_login(&login.ceremony_id, encoded).err(),
            Some(AuthError::VerificationFailed)
        );
        let count: i64 = auth
            .lock()
            .unwrap()
            .db
            .query_row("SELECT COUNT(*) FROM owner_sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
    #[test]
    fn passkeys_and_sessions_persist_but_nonce_ceremonies_do_not() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("owner-remote-auth.sqlite");
        let auth = OwnerRemoteAuth::open(&path, "https://host.example").unwrap();
        let session = auth.test_session();
        let id = auth.host_id().to_string();
        drop(auth);
        let restarted = OwnerRemoteAuth::open(&path, "https://host.example").unwrap();
        assert_eq!(restarted.host_id(), id);
        assert!(restarted.recheck(&session.principal).is_ok());
        assert!(restarted.begin_login().is_ok());
    }
}
