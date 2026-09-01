//! Best-effort Codex app-server coordination for persisted thread deletion.
//!
//! Request Health deliberately does not compact, fork, or start Codex turns.
//! A separately launched app-server cannot authoritatively observe the active
//! turn owned by Codex Desktop, so request forwarding remains diagnostic-only.

use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Permanently delete persisted Codex threads through an app-server. Every
/// thread is attempted even when an earlier deletion fails, so callers can
/// apply a local-file fallback without losing coverage.
pub(crate) fn delete_threads_blocking(thread_ids: &[String]) -> Vec<Result<(), String>> {
    if thread_ids.is_empty() {
        return Vec::new();
    }

    let mut client = match AppServerClient::start().and_then(|mut client| {
        client.initialize()?;
        Ok(client)
    }) {
        Ok(client) => client,
        Err(error) => {
            return thread_ids
                .iter()
                .map(|_| Err(error.clone()))
                .collect::<Vec<_>>();
        }
    };

    delete_threads_with_client(&mut client, thread_ids)
}

fn delete_threads_with_client(
    client: &mut impl CodexAppServer,
    thread_ids: &[String],
) -> Vec<Result<(), String>> {
    thread_ids
        .iter()
        .enumerate()
        .map(|(index, thread_id)| {
            client
                .request(
                    2 + index as u64,
                    "thread/delete",
                    json!({"threadId": thread_id}),
                )
                .map(|_| ())
        })
        .collect()
}

trait CodexAppServer {
    fn request(&mut self, id: u64, method: &str, params: Value) -> Result<Value, String>;
}

struct AppServerClient {
    child: Child,
    stdin: ChildStdin,
    messages: Receiver<Result<Value, String>>,
}

impl AppServerClient {
    fn start() -> Result<Self, String> {
        let mut errors = Vec::new();
        for executable in codex_executable_candidates() {
            match Self::start_with_executable(&executable) {
                Ok(client) => return Ok(client),
                Err(error) => errors.push(error),
            }
        }
        Err(format!(
            "Codex CLI executable could not be started. Checked configured, PATH, npm, Codex Desktop, and common version-manager locations. {}",
            errors.join(" | ")
        ))
    }

    fn start_with_executable(executable: &PathBuf) -> Result<Self, String> {
        let mut command = Command::new(executable);
        command
            .args(["app-server", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let mut child = command.spawn().map_err(|error| {
            format!(
                "Failed to start `{} app-server --stdio`: {error}",
                executable.display()
            )
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "app-server stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "app-server stdout unavailable".to_string())?;
        let (sender, messages) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let result = line
                    .map_err(|error| format!("Failed reading app-server output: {error}"))
                    .and_then(|line| {
                        serde_json::from_str::<Value>(&line)
                            .map_err(|error| format!("Invalid app-server JSON: {error}"))
                    });
                if sender.send(result).is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            stdin,
            messages,
        })
    }

    fn initialize(&mut self) -> Result<(), String> {
        self.send(json!({"id": 1, "method": "initialize", "params": {
            "clientInfo": {"name": "ccswitch-session-manager", "title": "CCSwitchMulti Session Manager", "version": env!("CARGO_PKG_VERSION")},
            "capabilities": {"experimentalApi": true}
        }}))?;
        self.wait_for_id(1)?;
        self.send(json!({"method": "initialized", "params": {}}))
    }

    fn send(&mut self, message: Value) -> Result<(), String> {
        serde_json::to_writer(&mut self.stdin, &message)
            .map_err(|error| format!("Failed encoding app-server request: {error}"))?;
        self.stdin
            .write_all(b"\n")
            .and_then(|_| self.stdin.flush())
            .map_err(|error| format!("Failed sending app-server request: {error}"))
    }

    fn wait_for_id(&self, id: u64) -> Result<Value, String> {
        loop {
            match self.messages.recv_timeout(Duration::from_secs(30)) {
                Ok(Ok(message)) if message.get("id").and_then(Value::as_u64) == Some(id) => {
                    if let Some(error) = message.get("error") {
                        return Err(format!("Codex app-server RPC failed: {error}"));
                    }
                    return Ok(message);
                }
                Ok(Ok(_)) => {}
                Ok(Err(error)) => return Err(error),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    return Err("Timed out waiting for Codex app-server".to_string());
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("Codex app-server closed its output".to_string());
                }
            }
        }
    }
}

fn codex_executable_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    for env_key in ["CCSWITCH_CODEX_EXECUTABLE", "CODEX_EXECUTABLE"] {
        if let Some(path) = std::env::var_os(env_key).filter(|value| !value.is_empty()) {
            push_candidate(&mut candidates, &mut seen, PathBuf::from(path));
        }
    }
    for candidate in crate::codex_config::codex_cli_candidates() {
        push_candidate(&mut candidates, &mut seen, candidate);
    }
    candidates
}

fn push_candidate(candidates: &mut Vec<PathBuf>, seen: &mut HashSet<String>, candidate: PathBuf) {
    let key = candidate.to_string_lossy().to_ascii_lowercase();
    if seen.insert(key) {
        candidates.push(candidate);
    }
}

impl CodexAppServer for AppServerClient {
    fn request(&mut self, id: u64, method: &str, params: Value) -> Result<Value, String> {
        self.send(json!({"id": id, "method": method, "params": params}))?;
        self.wait_for_id(id)
    }
}

impl Drop for AppServerClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct MockAppServer {
        delete_errors: HashMap<String, String>,
        requests: Vec<(String, Value)>,
    }

    impl CodexAppServer for MockAppServer {
        fn request(&mut self, _id: u64, method: &str, params: Value) -> Result<Value, String> {
            self.requests.push((method.to_string(), params));
            let thread_id = self
                .requests
                .last()
                .and_then(|(_, params)| params.get("threadId"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if let Some(error) = self.delete_errors.get(thread_id) {
                return Err(error.clone());
            }
            Ok(json!({"result": {}}))
        }
    }

    #[test]
    fn delete_threads_continues_after_individual_rpc_failure() {
        let mut client = MockAppServer {
            delete_errors: HashMap::from([(
                "thread-2".to_string(),
                "thread is still active".to_string(),
            )]),
            requests: Vec::new(),
        };

        let results = delete_threads_with_client(
            &mut client,
            &[
                "thread-1".to_string(),
                "thread-2".to_string(),
                "thread-3".to_string(),
            ],
        );

        assert!(results[0].is_ok());
        assert_eq!(
            results[1].as_ref().err().map(String::as_str),
            Some("thread is still active")
        );
        assert!(results[2].is_ok());
        assert_eq!(client.requests.len(), 3);
    }
}
