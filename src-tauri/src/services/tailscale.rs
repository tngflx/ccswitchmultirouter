mod serve;

use crate::services::owner_remote::{OwnerRemoteStatus, CONTROL_ADDRESS};
use reqwest::{Response, Url};
use serde::{Deserialize, Serialize};
use serve::{classify_serve, ServeRoute};
use std::{
    env,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

const CLI_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CLI_OUTPUT: usize = 1024 * 1024;
const OWNER_REMOTE_PAGE: &str = include_str!("../resources/owner_remote/index.html");

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TailscaleState {
    Missing,
    NeedsLogin,
    NeedsApproval,
    ServeMissing,
    TargetMismatch,
    OriginMismatch,
    Ready,
    Reachable,
    Unreachable,
    Error,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleStatus {
    pub state: TailscaleState,
    pub reachable: bool,
    pub version: Option<String>,
    pub backend_state: Option<String>,
    pub serve_target: Option<String>,
    pub origin: Option<String>,
    pub error: Option<&'static str>,
}

impl TailscaleStatus {
    pub(crate) fn new(state: TailscaleState) -> Self {
        Self {
            state,
            reachable: state == TailscaleState::Reachable,
            version: None,
            backend_state: None,
            serve_target: None,
            origin: None,
            error: None,
        }
    }

    pub(crate) fn fail(mut self, code: &'static str) -> Self {
        self.error = Some(code);
        self
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct NodeStatus {
    backend_state: String,
    version: Option<String>,
    #[serde(rename = "AuthURL", default)]
    auth_url: String,
    #[serde(rename = "Self")]
    local_node: Option<LocalNode>,
    #[serde(rename = "TailscaleIPs", default)]
    ips: Option<Vec<std::net::IpAddr>>,
}

#[derive(Deserialize)]
struct LocalNode {
    #[serde(rename = "DNSName")]
    dns_name: Option<String>,
}

impl NodeStatus {
    pub(crate) fn connected(&self) -> bool {
        self.backend_state == "Running" && self.ips.as_ref().is_some_and(|ips| !ips.is_empty())
    }

    pub(crate) fn needs_connection(&self) -> bool {
        matches!(
            self.backend_state.as_str(),
            "NeedsLogin" | "Stopped" | "NoState" | "Starting"
        )
    }

    pub(crate) fn needs_approval(&self) -> bool {
        self.backend_state == "NeedsMachineAuth"
    }

    fn origin(&self) -> Option<Url> {
        let name = self.local_node.as_ref()?.dns_name.as_deref()?;
        let name = name.trim_end_matches('.').to_ascii_lowercase();
        if !name.ends_with(".ts.net") {
            return None;
        }
        let url = Url::parse(&format!("https://{name}")).ok()?;
        (url.host_str() == Some(name.as_str())).then_some(url)
    }

    pub(crate) fn status(&self) -> TailscaleStatus {
        let state = if self.connected() {
            TailscaleState::Ready
        } else if self.needs_approval() {
            TailscaleState::NeedsApproval
        } else if self.needs_connection() {
            TailscaleState::NeedsLogin
        } else {
            TailscaleState::Error
        };
        TailscaleStatus {
            version: self.version.clone(),
            backend_state: Some(self.backend_state.clone()),
            error: (state == TailscaleState::Error).then_some("tailscale_command_failed"),
            ..TailscaleStatus::new(state)
        }
    }
}

#[derive(Clone)]
pub(crate) struct TailscaleClient {
    executable: PathBuf,
}

impl TailscaleClient {
    pub(crate) fn discover() -> Option<Self> {
        #[cfg(windows)]
        let standard = ["ProgramW6432", "ProgramFiles"]
            .into_iter()
            .filter_map(env::var_os)
            .map(|dir| PathBuf::from(dir).join("Tailscale/tailscale.exe"))
            .find(|path| path.is_file());
        #[cfg(not(windows))]
        let standard = [
            "/usr/bin/tailscale",
            "/usr/local/bin/tailscale",
            "/opt/homebrew/bin/tailscale",
        ]
        .into_iter()
        .map(PathBuf::from)
        .find(|path| path.is_file());
        let executable = standard.or_else(|| {
            find_in_path(if cfg!(windows) {
                "tailscale.exe"
            } else {
                "tailscale"
            })
        })?;
        Some(Self { executable })
    }

    pub(crate) fn install() -> Result<Self, &'static str> {
        #[cfg(windows)]
        {
            let winget = env::var_os("LOCALAPPDATA")
                .map(|dir| PathBuf::from(dir).join("Microsoft/WindowsApps/winget.exe"))
                .filter(|path| path.is_file())
                .or_else(|| find_in_path("winget.exe"))
                .ok_or("tailscale_winget_unavailable")?;
            let args = [
                "install",
                "--id",
                "Tailscale.Tailscale",
                "--exact",
                "--source",
                "winget",
                "--silent",
                "--disable-interactivity",
                "--accept-source-agreements",
                "--accept-package-agreements",
            ];
            run(&winget, &args, Duration::from_secs(300))
                .map_err(|_| "tailscale_install_failed")?;
            Self::discover().ok_or("tailscale_install_failed")
        }
        #[cfg(not(windows))]
        Err("tailscale_install_unsupported")
    }

    pub(crate) fn node_status(&self) -> Result<NodeStatus, &'static str> {
        let output = run(
            &self.executable,
            &["status", "--json", "--peers=false"],
            CLI_TIMEOUT,
        )?;
        // Some backend states still include valid status JSON on nonzero exit.
        serde_json::from_str(&output.stdout).map_err(|_| "tailscale_command_failed")
    }

    pub(crate) fn begin_login(&self) -> Result<(NodeStatus, Option<Url>), &'static str> {
        let output = run(
            &self.executable,
            &["up", "--json", "--timeout=7s"],
            CLI_TIMEOUT,
        )
        .map_err(|_| "tailscale_login_failed")?;
        let node = self.node_status()?;
        let url = if node.connected() || node.needs_approval() {
            None
        } else {
            let url =
                tailscale_browser_url(&node.auth_url).or_else(|| login_url_from_up(&output.stdout));
            if url.is_none() && !output.success {
                return Err("tailscale_login_failed");
            }
            url
        };
        Ok((node, url))
    }

    pub(crate) fn inspect(&self, owner: &OwnerRemoteStatus) -> TailscaleStatus {
        match self.node_status() {
            Ok(node) => self.inspect_node(&node, owner),
            Err(code) => TailscaleStatus::new(TailscaleState::Error).fail(code),
        }
    }

    pub(crate) fn inspect_node(
        &self,
        node: &NodeStatus,
        owner: &OwnerRemoteStatus,
    ) -> TailscaleStatus {
        let status = node.status();
        if !node.connected() {
            return status;
        }
        let Some(origin) = node.origin() else {
            return TailscaleStatus {
                state: TailscaleState::Error,
                ..status
            }
            .fail("tailscale_command_failed");
        };
        let origin = origin.origin().ascii_serialization();
        let status = TailscaleStatus {
            origin: Some(origin.clone()),
            ..status
        };
        if owner
            .https_origin
            .as_deref()
            .is_some_and(|pinned| pinned != origin)
        {
            return TailscaleStatus {
                state: TailscaleState::OriginMismatch,
                ..status
            };
        }
        let Ok(output) = run(
            &self.executable,
            &["serve", "status", "--json"],
            CLI_TIMEOUT,
        ) else {
            return TailscaleStatus {
                state: TailscaleState::Error,
                ..status
            }
            .fail("tailscale_serve_failed");
        };
        let host = origin.trim_start_matches("https://");
        let target = owner_remote_target();
        match classify_serve(&output.stdout, host, &target) {
            Ok(ServeRoute::Matching) if output.success => TailscaleStatus {
                serve_target: Some(target),
                ..status
            },
            Ok(ServeRoute::Missing) if output.success => TailscaleStatus {
                state: TailscaleState::ServeMissing,
                ..status
            },
            Ok(ServeRoute::Conflict) if output.success => TailscaleStatus {
                state: TailscaleState::TargetMismatch,
                ..status
            }
            .fail("tailscale_serve_conflict"),
            Ok(ServeRoute::FunnelEnabled) if output.success => TailscaleStatus {
                state: TailscaleState::TargetMismatch,
                ..status
            }
            .fail("tailscale_funnel_enabled"),
            _ => TailscaleStatus {
                state: TailscaleState::Error,
                ..status
            }
            .fail("tailscale_serve_failed"),
        }
    }

    pub(crate) fn configure_serve(
        &self,
        owner: &OwnerRemoteStatus,
        open_consent: impl FnOnce(Url) -> Result<(), &'static str> + Send + 'static,
    ) -> TailscaleStatus {
        let status = self.inspect(owner);
        if status.state != TailscaleState::ServeMissing || !owner.running {
            return status;
        }
        let target = owner_remote_target();
        let args = ["serve", "--bg", "--https=443", "--yes", &target];
        // Serve can print a browser consent URL and wait for HTTPS enablement with --yes.
        let _ = run_observing_stdout(
            &self.executable,
            &args,
            Duration::from_secs(180),
            serve_consent_on_stdout(open_consent),
        );
        let status = self.inspect(owner);
        if status.state == TailscaleState::ServeMissing {
            return status.fail("tailscale_serve_failed");
        }
        status
    }
}

fn owner_remote_target() -> String {
    format!("http://{CONTROL_ADDRESS}")
}

fn find_in_path(binary: &str) -> Option<PathBuf> {
    env::split_paths(&env::var_os("PATH")?)
        .filter(|path| path.is_absolute())
        .map(|dir| dir.join(binary))
        .find(|path| path.is_file())
}

fn tailscale_browser_url(value: &str) -> Option<Url> {
    let url = Url::parse(value).ok()?;
    (url.scheme() == "https"
        && url.host_str() == Some("login.tailscale.com")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() != "/")
        .then_some(url)
}

fn login_url_from_up(output: &str) -> Option<Url> {
    #[derive(Deserialize)]
    struct UpEvent {
        #[serde(rename = "AuthURL", default)]
        auth_url: String,
    }
    serde_json::Deserializer::from_str(output)
        .into_iter::<UpEvent>()
        .map_while(Result::ok)
        .find_map(|event| tailscale_browser_url(&event.auth_url))
}

fn serve_consent_on_stdout(
    open: impl FnOnce(Url) -> Result<(), &'static str>,
) -> impl FnMut(&str) -> Result<(), &'static str> {
    let mut open = Some(open);
    move |line| {
        if let Some(url) = tailscale_browser_url(line.trim()) {
            if let Some(open) = open.take() {
                open(url)?;
            }
        }
        Ok(())
    }
}

struct CommandOutput {
    success: bool,
    stdout: String,
}

fn run(executable: &Path, args: &[&str], timeout: Duration) -> Result<CommandOutput, &'static str> {
    run_observing_stdout(executable, args, timeout, |_| Ok(()))
}

fn run_observing_stdout(
    executable: &Path,
    args: &[&str],
    timeout: Duration,
    on_line: impl FnMut(&str) -> Result<(), &'static str> + Send + 'static,
) -> Result<CommandOutput, &'static str> {
    let failed = "tailscale_command_failed";
    let mut command = Command::new(executable);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| failed)?;
    let stdout = child.stdout.take().expect("stdout is piped");
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(read_command_stdout(stdout, on_line));
    });

    let deadline = Instant::now() + timeout;
    let outcome = (|| {
        let mut stdout = None;
        loop {
            if stdout.is_none() {
                if let Ok(read) = rx.try_recv() {
                    stdout = Some(read?);
                }
            }
            if let Some(exit) = child.try_wait().map_err(|_| failed)? {
                let stdout = match stdout {
                    Some(stdout) => stdout,
                    None => rx
                        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                        .map_err(|_| failed)??,
                };
                return Ok(CommandOutput {
                    success: exit.success(),
                    stdout,
                });
            }
            if Instant::now() >= deadline {
                return Err(failed);
            }
            thread::sleep(Duration::from_millis(40));
        }
    })();
    if outcome.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    outcome
}

fn read_command_stdout(
    stdout: impl Read,
    mut on_line: impl FnMut(&str) -> Result<(), &'static str>,
) -> Result<String, &'static str> {
    let failed = "tailscale_command_failed";
    let mut reader = BufReader::new(stdout.take(MAX_CLI_OUTPUT as u64 + 1));
    let mut bytes = Vec::new();
    loop {
        let start = bytes.len();
        if reader.read_until(b'\n', &mut bytes).map_err(|_| failed)? == 0 {
            return Ok(String::from_utf8_lossy(&bytes).into_owned());
        }
        if bytes.len() > MAX_CLI_OUTPUT {
            return Err(failed);
        }
        if let Ok(line) = std::str::from_utf8(&bytes[start..]) {
            on_line(line)?;
        }
    }
}

pub(crate) async fn verify(
    mut status: TailscaleStatus,
    owner: &OwnerRemoteStatus,
    attempts: usize,
) -> TailscaleStatus {
    if status.state != TailscaleState::Ready || !owner.running {
        return status;
    }
    let Some(origin) = status
        .origin
        .as_deref()
        .filter(|origin| Some(*origin) == owner.https_origin.as_deref())
    else {
        status.state = TailscaleState::OriginMismatch;
        return status;
    };
    for attempt in 0..attempts {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        if probe(origin).await {
            status.state = TailscaleState::Reachable;
            status.reachable = true;
            return status;
        }
    }
    status.state = TailscaleState::Unreachable;
    status.fail("tailscale_probe_failed")
}

async fn probe(origin: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(6))
        .build()
    else {
        return false;
    };
    match client.get(format!("{origin}/remote/")).send().await {
        Ok(response) => owner_remote_response(response).await,
        Err(_) => false,
    }
}

async fn owner_remote_response(mut response: Response) -> bool {
    if response.status() != reqwest::StatusCode::OK {
        return false;
    }
    let mut expected = OWNER_REMOTE_PAGE.as_bytes();
    while let Ok(Some(chunk)) = response.chunk().await {
        let Some(rest) = expected.strip_prefix(chunk.as_ref()) else {
            return false;
        };
        expected = rest;
        if expected.is_empty() {
            return matches!(response.chunk().await, Ok(None));
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(json: &str) -> NodeStatus {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn classifies_login_and_approval_without_a_tailnet_ip() {
        let login = node(r#"{"BackendState":"NeedsLogin","TailscaleIPs":null,"Self":null}"#);
        assert_eq!(login.status().state, TailscaleState::NeedsLogin);
        let approval = node(r#"{"BackendState":"NeedsMachineAuth","TailscaleIPs":null}"#);
        assert_eq!(approval.status().state, TailscaleState::NeedsApproval);
        let offline = node(r#"{"BackendState":"Running","TailscaleIPs":[]}"#);
        assert_eq!(offline.status().state, TailscaleState::Error);
    }

    #[test]
    fn canonicalizes_the_tailnet_dns_name_and_rejects_non_tailnet_origins() {
        let running = node(
            r#"{"BackendState":"Running","TailscaleIPs":["100.64.0.1"],"Self":{"DNSName":"Host.Example.ts.net."}}"#,
        );
        assert!(running.connected());
        assert_eq!(
            running.origin().unwrap().origin().ascii_serialization(),
            "https://host.example.ts.net"
        );
        let custom = node(
            r#"{"BackendState":"Running","TailscaleIPs":["100.64.0.1"],"Self":{"DNSName":"host.example.test."}}"#,
        );
        assert!(custom.origin().is_none());
    }

    #[test]
    fn finds_the_login_url_without_accepting_other_origins() {
        let fixture = r#"{"AuthURL":"https://example.test/a/first"} {"AuthURL":"https://login.tailscale.com/a/fixture"} {"BackendState":"Running"}"#;
        assert_eq!(
            login_url_from_up(fixture).unwrap().as_str(),
            "https://login.tailscale.com/a/fixture"
        );
        assert!(tailscale_browser_url("http://login.tailscale.com/a/fixture").is_none());
        assert!(
            tailscale_browser_url("https://login.tailscale.com.example.test/a/fixture").is_none()
        );
        assert!(tailscale_browser_url("https://user@login.tailscale.com/a/fixture").is_none());
    }

    #[test]
    fn opens_only_the_first_official_serve_consent_url_before_stdout_closes() {
        use std::cell::Cell;
        use std::io::{self, Cursor};

        struct WaitForConsent<'a>(&'a Cell<bool>);

        impl Read for WaitForConsent<'_> {
            fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
                assert!(
                    self.0.get(),
                    "open consent before waiting for the CLI to exit"
                );
                Ok(0)
            }
        }

        let opened = Cell::new(false);
        let stdout = "To enable HTTPS, visit:\n\
            https://login.tailscale.com.example.test/fixture\n\
            https://login.tailscale.com/f/serve-fixture\n\
            https://login.tailscale.com/f/second-fixture\n";
        let input = Cursor::new(stdout).chain(WaitForConsent(&opened));
        let output = read_command_stdout(
            input,
            serve_consent_on_stdout(|url| {
                assert_eq!(url.path(), "/f/serve-fixture");
                opened.set(true);
                Ok(())
            }),
        )
        .unwrap();
        assert_eq!(output, stdout);
    }

    #[tokio::test]
    async fn verifies_the_complete_owner_remote_page() {
        use axum::{http::StatusCode, routing::get, Router};

        let app = Router::new()
            .route("/owner", get(|| async { OWNER_REMOTE_PAGE }))
            .route("/different", get(|| async { "Another application" }))
            .route("/truncated", get(|| async { &OWNER_REMOTE_PAGE[..20] }))
            .route(
                "/extra",
                get(|| async { format!("{OWNER_REMOTE_PAGE}extra") }),
            )
            .route(
                "/denied",
                get(|| async { (StatusCode::FORBIDDEN, OWNER_REMOTE_PAGE) }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();

        for (path, expected) in [
            ("/owner", true),
            ("/different", false),
            ("/truncated", false),
            ("/extra", false),
            ("/denied", false),
        ] {
            let response = client
                .get(format!("http://{address}{path}"))
                .send()
                .await
                .unwrap();
            assert_eq!(owner_remote_response(response).await, expected, "{path}");
        }
        server.abort();
    }
}
