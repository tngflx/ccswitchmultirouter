//! 跨平台看门狗（supervisor）。
//!
//! 应用自身以 `--ccsm-supervise <parent_pid>` 方式再拉起一个同二进制进程；该进程
//! 只做一件事：盯着主进程。主进程异常退出（运行标记仍指向它、但进程已经不在了）时，
//! 它把安装态可执行文件重新拉起，等到本地代理端口重新可用后自行退出。
//!
//! 为什么不是进程内线程：线程会随主进程一起消失，无法实现“进程死了再拉起来”。
//! 为什么不用 PowerShell/计划任务/systemd/launchd：那是各平台各写一套的运维方案，
//! 不随软件分发，也无法做成产品开关。这里用同一份 Rust 代码覆盖 Windows/macOS/Linux。

mod diagnostic_journal;

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// 守护进程的启动标记；主程序带这个参数运行时进入守护模式，不创建窗口。
pub const SUPERVISE_FLAG: &str = "--ccsm-supervise";
pub const SUPERVISE_CONFIG_FLAG: &str = "--ccsm-supervise-config";
pub const SUPERVISE_PORT_FLAG: &str = "--ccsm-supervise-port";
pub const SUPERVISE_SETTINGS_FLAG: &str = "--ccsm-supervise-settings";
pub const DEV_SUPERVISOR_ENV: &str = "CC_SWITCH_DEV_SUPERVISOR";

const POLL_INTERVAL: Duration = Duration::from_secs(5);
const READY_TIMEOUT: Duration = Duration::from_secs(90);
const READY_POLL: Duration = Duration::from_millis(500);
const FAILED_RESTART_CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);
const FAILED_RESTART_CLEANUP_POLL: Duration = Duration::from_millis(50);
const RESTART_WINDOW_SECS: u64 = 30 * 60;
const MAX_RESTARTS_PER_WINDOW: usize = 5;
const RUN_MARKER_FILE: &str = "app-run-marker.json";
const WATCHDOG_LOG_FILE: &str = "watchdog.jsonl";
const WATCHDOG_STATE_FILE: &str = "watchdog-state.json";
static SUPERVISOR_SPAWN_LOCK: std::sync::Mutex<Option<SupervisorChildReceipt>> =
    std::sync::Mutex::new(None);

struct SupervisorChildReceipt {
    config_dir: PathBuf,
    parent_pid: u32,
    child: std::process::Child,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WatchedParentState {
    Running,
    Exited,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SupervisorPollAction {
    Observe,
    Recover,
    Stop,
}

fn supervisor_poll_action(
    enabled: Option<bool>,
    parent: WatchedParentState,
) -> SupervisorPollAction {
    match enabled {
        Some(false) if parent == WatchedParentState::Exited => SupervisorPollAction::Stop,
        Some(true) if parent == WatchedParentState::Exited => SupervisorPollAction::Recover,
        None if parent == WatchedParentState::Exited => SupervisorPollAction::Stop,
        _ => SupervisorPollAction::Observe,
    }
}

fn classify_watched_parent_state(
    expected: &crate::process_identity::ProcessIdentity,
    identity: Result<
        crate::process_identity::ProcessIdentity,
        crate::process_identity::ProcessIdentityError,
    >,
    liveness: Result<bool, crate::process_identity::ProcessIdentityError>,
) -> WatchedParentState {
    match liveness {
        Ok(false) => WatchedParentState::Exited,
        Ok(true) => match identity {
            Ok(observed) if expected.matches(&observed) => WatchedParentState::Running,
            Ok(_) => WatchedParentState::Exited,
            Err(_) => WatchedParentState::Unknown,
        },
        Err(_) => WatchedParentState::Unknown,
    }
}

fn supervisor_identity_from_receipt(
    receipt: Option<&mut SupervisorChildReceipt>,
    config_dir: &Path,
    parent_pid: u32,
) -> Option<crate::process_identity::ProcessIdentity> {
    let receipt = receipt?;
    if receipt.config_dir != config_dir || receipt.parent_pid != parent_pid {
        return None;
    }
    match receipt.child.try_wait() {
        Ok(None) => crate::process_identity::process_identity_result(receipt.child.id())
            .ok()
            .filter(|identity| {
                crate::process_identity::executable_matches_current(&identity.executable_path)
            }),
        // Neither a failed wait nor diagnostic history can authorize another
        // child. The retained Child remains the canonical current-app receipt.
        Ok(Some(_)) | Err(_) => None,
    }
}

trait FailedReplacementChild {
    fn try_reap(&mut self) -> io::Result<bool>;
    fn terminate(&mut self) -> io::Result<()>;
}

impl FailedReplacementChild for std::process::Child {
    fn try_reap(&mut self) -> io::Result<bool> {
        self.try_wait().map(|status| status.is_some())
    }

    fn terminate(&mut self) -> io::Result<()> {
        self.kill()
    }
}

fn terminate_and_reap_child(
    child: &mut impl FailedReplacementChild,
    timeout: Duration,
) -> io::Result<()> {
    if child.try_reap()? {
        return Ok(());
    }
    if let Err(error) = child.terminate() {
        // A concurrent exit is harmless, but a failed kill is not a reason to wait indefinitely.
        return if matches!(child.try_reap(), Ok(true)) {
            Ok(())
        } else {
            Err(error)
        };
    }

    let started = Instant::now();
    while !child.try_reap()? {
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "replacement process did not exit after termination",
            ));
        }
        std::thread::sleep(remaining.min(FAILED_RESTART_CLEANUP_POLL));
    }
    Ok(())
}

fn acquire_supervisor_parent_lock(
    config_dir: &Path,
    expected: &crate::process_identity::ProcessIdentity,
) -> std::io::Result<Option<std::fs::File>> {
    let directory = log_dir(config_dir);
    std::fs::create_dir_all(&directory)?;
    use sha2::{Digest, Sha256};
    let identity = serde_json::to_vec(expected).map_err(std::io::Error::other)?;
    let executable = hex::encode(Sha256::digest(identity));
    let path = directory.join(format!(
        "watchdog-parent-{}-{}-{executable}.lock",
        expected.pid, expected.started_at_ticks
    ));
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(error)) => Err(error),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuperviseArgs {
    pub parent_pid: u32,
    pub config_dir: Option<String>,
    pub settings_path: Option<String>,
    pub port: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParentOutcome {
    /// 主进程仍在运行。
    StillRunning,
    /// 主进程异常消失（运行标记仍指向它），应当重启。
    Crashed,
    /// 主进程正常退出（运行标记已被应用自己删除或不属于它），不应打扰。
    CleanExit,
}

/// Whether the running development wrapper, rather than this binary, owns
/// recovery for the Tauri child.
pub fn dev_supervisor_owned() -> bool {
    // The Node supervisor is a development-only lifecycle owner. Release
    // builds must always use the installed app's Rust supervisor, even if a
    // stale development environment variable is inherited by the process.
    #[cfg(not(debug_assertions))]
    {
        return false;
    }

    #[cfg(debug_assertions)]
    std::env::var(DEV_SUPERVISOR_ENV)
        .ok()
        .is_some_and(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true"))
}

pub(crate) fn dev_retry_packet(
    event: &str,
    session_id: &str,
    provider_id: &str,
    attempt: u32,
    reason_class: Option<&str>,
) -> Option<serde_json::Value> {
    let scheduled_transport_retry = event == "retry_scheduled"
        && matches!(
            reason_class,
            Some(
                "stream_interrupted"
                    | "premature_eof"
                    | "transport_error"
                    | "reconnect_transport_failure"
                    | "reconnect_http_failure"
            )
        );
    if !matches!(
        event,
        "reconnect_failed" | "stream_finished" | "stream_cancelled"
    ) && !scheduled_transport_retry
    {
        return None;
    }
    use sha2::{Digest, Sha256};
    let key = hex::encode(Sha256::digest(
        serde_json::to_vec(&(session_id, provider_id)).ok()?,
    ));
    Some(serde_json::json!({ "event": event, "key": &key[..16], "attempt": attempt }))
}

fn write_dev_packet(packet: &serde_json::Value) {
    let _ = writeln!(std::io::stdout().lock(), "[ccsm-dev-watchdog] {packet}");
}

/// Notify the parent-owned dev watchdog without exporting request data or IDs.
pub(crate) fn report_dev_retry_activity(
    event: &str,
    session_id: &str,
    provider_id: &str,
    attempt: u32,
    reason_class: Option<&str>,
) {
    if !dev_supervisor_owned() {
        return;
    }
    if let Some(packet) = dev_retry_packet(event, session_id, provider_id, attempt, reason_class) {
        write_dev_packet(&packet);
    }
}

fn report_dev_identity(config_dir: &Path) {
    let Some(identity) = crate::process_identity::current_process_identity() else {
        return;
    };
    write_dev_packet(&serde_json::json!({
        "event": "ready",
        "pid": identity.pid,
        "executablePath": identity.executable_path,
        "processStartedAtTicks": identity.started_at_ticks,
        "markerPath": log_dir(config_dir).join(RUN_MARKER_FILE),
    }));
}

/// 解析守护模式参数；不是守护模式时返回 None。
pub fn parse_supervise_args(args: &[String]) -> Option<SuperviseArgs> {
    let position = args.iter().position(|arg| arg == SUPERVISE_FLAG)?;
    let parent_pid = args
        .get(position + 1)
        .and_then(|value| value.parse::<u32>().ok())?;
    let config_dir = flag_value(args, SUPERVISE_CONFIG_FLAG);
    let settings_path = flag_value(args, SUPERVISE_SETTINGS_FLAG);
    let port = flag_value(args, SUPERVISE_PORT_FLAG)
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0);
    Some(SuperviseArgs {
        parent_pid,
        config_dir,
        settings_path,
        port,
    })
}

fn flag_value(args: &[String], flag: &str) -> Option<String> {
    let position = args.iter().position(|arg| arg == flag)?;
    args.get(position + 1).cloned()
}

/// 依据运行标记判断主进程是崩溃还是正常退出。
///
/// 应用只在**正常退出**时删除 `logs/app-run-marker.json`；标记仍在且 pid 等于主进程 pid
/// 并且该进程已经不存在 ⇒ 崩溃。标记缺失、pid 不匹配或内容不可解析时一律按正常退出处理
/// （宁可少重启，也不制造崩溃循环）。
pub fn classify_parent_outcome(marker_json: Option<&str>, parent_pid: u32) -> ParentOutcome {
    classify_parent_outcome_with_identity(marker_json, parent_pid, None)
}

/// Classify the parent while optionally binding the marker to the exact process
/// instance observed when the supervisor started. PID values can be reused after
/// a process exits, so a matching PID alone is not sufficient for recovery.
fn classify_parent_outcome_with_identity(
    marker_json: Option<&str>,
    parent_pid: u32,
    expected_identity: Option<&crate::process_identity::ProcessIdentity>,
) -> ParentOutcome {
    let Some(marker_json) = marker_json else {
        return ParentOutcome::CleanExit;
    };
    let Ok(marker) = serde_json::from_str::<serde_json::Value>(marker_json) else {
        return ParentOutcome::CleanExit;
    };
    let marker_pid = marker
        .get("pid")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| u32::try_from(value).ok());
    if marker_pid != Some(parent_pid) {
        return ParentOutcome::CleanExit;
    }

    if let Some(expected_identity) = expected_identity {
        let marker_executable = marker
            .get("executablePath")
            .or_else(|| marker.get("executable_path"))
            .and_then(serde_json::Value::as_str);
        let marker_started_at = marker
            .get("processStartedAtTicks")
            .or_else(|| marker.get("process_started_at_ticks"))
            .and_then(serde_json::Value::as_u64);

        match (marker_executable, marker_started_at) {
            (Some(executable_path), Some(started_at_ticks)) => {
                let marker_identity = crate::process_identity::ProcessIdentity {
                    pid: parent_pid,
                    executable_path: executable_path.to_string(),
                    started_at_ticks,
                };
                if !expected_identity.matches(&marker_identity) {
                    return ParentOutcome::CleanExit;
                }
            }
            // Older markers only recorded the PID. Keep those markers
            // recoverable, but reject partially written identity metadata.
            (None, None) => {}
            _ => return ParentOutcome::CleanExit,
        }
    }

    ParentOutcome::Crashed
}

fn classify_parent_recovery_outcome(
    config_dir: &Path,
    marker_json: Option<&str>,
    parent_pid: u32,
    expected_identity: Option<&crate::process_identity::ProcessIdentity>,
) -> ParentOutcome {
    let outcome = classify_parent_outcome_with_identity(marker_json, parent_pid, expected_identity);
    if outcome == ParentOutcome::Crashed
        && marker_json
            .zip(expected_identity)
            .is_some_and(|(marker, expected)| {
                crate::app_exit_monitor::watchdog_exit_classification(config_dir, marker, expected)
                    .is_some_and(|classification| !classification.allows_crash_recovery())
            })
    {
        ParentOutcome::CleanExit
    } else {
        outcome
    }
}

/// 重启频率预算：默认 30 分钟内最多 5 次。
pub fn restart_budget_allows(now_secs: u64, recent_secs: &[u64]) -> bool {
    let window_start = now_secs.saturating_sub(RESTART_WINDOW_SECS);
    let recent = recent_secs
        .iter()
        .filter(|value| **value >= window_start)
        .count();
    recent < MAX_RESTARTS_PER_WINDOW
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

fn log_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("logs")
}

fn append_event(config_dir: &Path, level: &str, event: &str, detail: serde_json::Value) {
    let record = serde_json::json!({
        "timestamp": chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "level": level,
        "event": event,
        "detail": detail,
    });
    let path = log_dir(config_dir).join(WATCHDOG_LOG_FILE);
    let _ = diagnostic_journal::append(&path, &record);
}

fn read_run_marker(config_dir: &Path) -> Option<String> {
    std::fs::read_to_string(log_dir(config_dir).join(RUN_MARKER_FILE)).ok()
}

fn process_identity_from_marker(
    marker_json: Option<&str>,
    parent_pid: u32,
) -> Option<crate::process_identity::ProcessIdentity> {
    let marker = serde_json::from_str::<serde_json::Value>(marker_json?).ok()?;
    let marker_pid = marker
        .get("pid")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())?;
    if marker_pid != parent_pid {
        return None;
    }
    let executable_path = marker
        .get("executablePath")
        .or_else(|| marker.get("executable_path"))
        .and_then(serde_json::Value::as_str)?;
    let started_at_ticks = marker
        .get("processStartedAtTicks")
        .or_else(|| marker.get("process_started_at_ticks"))
        .and_then(serde_json::Value::as_u64)?;
    if !crate::process_identity::executable_matches_current(executable_path) {
        return None;
    }
    Some(crate::process_identity::ProcessIdentity {
        pid: parent_pid,
        executable_path: executable_path.to_string(),
        started_at_ticks,
    })
}

/// Diagnostic projection only; a status-read failure is not launch authority.
fn read_recent_restarts(config_dir: &Path) -> Vec<u64> {
    read_restart_budget_state(config_dir).unwrap_or_default()
}

fn read_restart_budget_state(config_dir: &Path) -> Result<Vec<u64>, String> {
    let path = log_dir(config_dir).join(WATCHDOG_STATE_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("读取看门狗重启预算失败: {error}")),
    };
    #[derive(serde::Deserialize)]
    struct RestartBudgetState {
        restarts: Vec<u64>,
    }
    serde_json::from_str::<RestartBudgetState>(&text)
        .map(|state| state.restarts)
        .map_err(|_| "看门狗重启预算格式无效；已拒绝重置历史".to_string())
}

fn write_restart_budget_state(config_dir: &Path, restarts: &[u64]) -> Result<(), String> {
    let payload = serde_json::to_vec_pretty(&serde_json::json!({ "restarts": restarts }))
        .map_err(|_| "无法序列化看门狗重启预算".to_string())?;
    crate::config::atomic_write_private(&log_dir(config_dir).join(WATCHDOG_STATE_FILE), &payload)
        .map_err(|error| format!("持久化看门狗重启预算失败: {error}"))
}

fn authorize_restart_attempt(config_dir: &Path, now: u64) -> Result<bool, String> {
    let mut restarts = read_restart_budget_state(config_dir)?;
    if !restart_budget_allows(now, &restarts) {
        return Ok(false);
    }
    restarts.retain(|time| *time >= now.saturating_sub(RESTART_WINDOW_SECS));
    restarts.push(now);
    write_restart_budget_state(config_dir, &restarts)?;
    Ok(true)
}

/// 主进程可执行文件路径（守护用的就是同一个二进制）。
pub fn current_executable() -> Option<PathBuf> {
    std::env::current_exe().ok()
}

/// Read the persisted watchdog setting without using the supervisor process's
/// cached settings store. The settings writer uses camelCase JSON, but accepting
/// the legacy snake_case spelling keeps older files safe to interpret.
fn read_watchdog_enabled(settings_path: Option<&Path>) -> Result<bool, String> {
    let Some(settings_path) = settings_path else {
        return Ok(true);
    };
    let content = match std::fs::read_to_string(settings_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(format!("读取看门狗设置失败: {error}")),
    };
    let value = serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|error| format!("解析看门狗设置失败: {error}"))?;
    value
        .get("watchdogEnabled")
        .or_else(|| value.get("watchdog_enabled"))
        .and_then(serde_json::Value::as_bool)
        .map(Ok)
        .unwrap_or(Ok(true))
}

fn settings_path() -> Option<PathBuf> {
    crate::settings::AppSettings::settings_path()
}

fn watched_parent_state(expected: &crate::process_identity::ProcessIdentity) -> WatchedParentState {
    let liveness = crate::process_identity::process_liveness_result(expected.pid);
    let identity = if matches!(liveness, Ok(true)) {
        crate::process_identity::process_identity_result(expected.pid)
    } else {
        Err(crate::process_identity::ProcessIdentityError::NotFound)
    };
    classify_watched_parent_state(expected, identity, liveness)
}

fn listener_is_ready(
    port: u16,
    expected: Option<&crate::process_identity::ProcessIdentity>,
) -> bool {
    if port == 0 {
        return true;
    }
    let Some(expected) = expected else {
        return false;
    };
    if crate::process_identity::tcp_listener_owner_pid(port) != Some(expected.pid) {
        return false;
    }
    crate::process_identity::process_identity(expected.pid)
        .is_some_and(|observed| expected.matches(&observed))
}

/// Project the current app's retained native child receipt for the status UI.
/// Diagnostic event history is never lifecycle authority.
pub(crate) fn live_supervisor_identity(
    config_dir: &Path,
    parent_pid: u32,
) -> Option<crate::process_identity::ProcessIdentity> {
    let mut receipt = supervisor_spawn_guard();
    supervisor_identity_from_receipt(receipt.as_mut(), config_dir, parent_pid)
}

fn supervisor_spawn_guard() -> std::sync::MutexGuard<'static, Option<SupervisorChildReceipt>> {
    SUPERVISOR_SPAWN_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Idempotently ensure one supervisor exists for the current app process.
pub fn ensure_supervisor(config_dir: &Path, port: u16) {
    if crate::lightweight::is_lightweight_mode() {
        return;
    }
    // `pnpm dev` has its own parent-level recovery loop. Running both
    // supervisors would let the Rust child and the Node wrapper relaunch the
    // same Tauri app concurrently after one crash.
    if dev_supervisor_owned() {
        report_dev_identity(config_dir);
        log::debug!("开发会话由 pnpm dev supervisor 接管，跳过 Rust supervisor");
        return;
    }
    let settings = crate::settings::get_settings();
    if !settings.watchdog_enabled {
        log::debug!("内置看门狗已关闭，跳过 supervisor 启动");
        return;
    }
    // Startup and save_settings may race. Serialize check, spawn and receipt.
    let mut receipt = supervisor_spawn_guard();
    let parent_pid = std::process::id();
    if let Some(tracked) = receipt.as_mut() {
        match tracked.child.try_wait() {
            Ok(None) => {
                log::debug!(
                    "内置看门狗已在运行: supervisorPid={} parentPid={parent_pid}",
                    tracked.child.id()
                );
                return;
            }
            Err(error) => {
                log::warn!("无法确认已保留的看门狗是否退出，跳过重复启动: {error}");
                return;
            }
            Ok(Some(_)) => {
                *receipt = None;
            }
        }
    }
    let Some(executable) = current_executable() else {
        log::warn!("无法解析当前可执行文件路径，跳过 supervisor 启动");
        return;
    };
    let mut command = std::process::Command::new(&executable);
    command
        .arg(SUPERVISE_FLAG)
        .arg(parent_pid.to_string())
        .arg(SUPERVISE_CONFIG_FLAG)
        .arg(config_dir)
        .arg(SUPERVISE_SETTINGS_FLAG)
        .arg(settings_path().unwrap_or_else(|| config_dir.join("settings.json")))
        .arg(SUPERVISE_PORT_FLAG)
        .arg(port.to_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    match command.spawn() {
        Ok(child) => {
            let child_pid = child.id();
            // Retain the native child before optional diagnostics. A failed log
            // write or truncated history must never create a second owner.
            *receipt = Some(SupervisorChildReceipt {
                config_dir: config_dir.to_path_buf(),
                parent_pid,
                child,
            });
            let started_at_ticks = crate::process_identity::process_identity(child_pid)
                .map(|identity| identity.started_at_ticks);
            append_event(
                config_dir,
                "info",
                "supervisor-spawned",
                serde_json::json!({
                    "supervisorPid": child_pid,
                    "parentPid": parent_pid,
                    "port": port,
                    "executable": executable.to_string_lossy(),
                    "startedAtTicks": started_at_ticks,
                }),
            );
            log::info!(
                "已启动内置看门狗: supervisorPid={} parentPid={parent_pid} port={port}",
                child_pid
            );
        }
        Err(error) => {
            log::warn!("启动内置看门狗失败: {error}");
            append_event(
                config_dir,
                "error",
                "supervisor-spawn-failed",
                serde_json::json!({ "error": error.to_string() }),
            );
        }
    }
}

/// 守护进程入口：盯住主进程，必要时把它拉起来，然后退出。
pub fn run_supervisor(args: SuperviseArgs) -> ! {
    let config_dir = args
        .config_dir
        .clone()
        .map(PathBuf::from)
        .unwrap_or_else(crate::config::get_app_config_dir);
    let settings_path = args.settings_path.map(PathBuf::from).or_else(settings_path);
    let settings_path = settings_path.as_deref();
    append_event(
        &config_dir,
        "info",
        "supervisor-started",
        serde_json::json!({
            "parentPid": args.parent_pid,
            "port": args.port,
            "settingsPath": settings_path.map(|path| path.to_string_lossy().to_string()),
        }),
    );

    let initial_marker = read_run_marker(&config_dir);
    let Some(expected) = crate::process_identity::process_identity(args.parent_pid)
        .or_else(|| process_identity_from_marker(initial_marker.as_deref(), args.parent_pid))
    else {
        append_event(
            &config_dir,
            "error",
            "supervisor-watch-skipped",
            serde_json::json!({
                "parentPid": args.parent_pid,
                "reason": "parent process identity could not be verified at supervisor startup",
            }),
        );
        std::process::exit(0);
    };
    // The lock file's existence is not ownership. Keep the native lock handle
    // for this exact parent generation through accounting, restart and readiness.
    // A restarted app gets a different key and can arm its own supervisor.
    let _parent_lock = match acquire_supervisor_parent_lock(&config_dir, &expected) {
        Ok(Some(lock)) => lock,
        Ok(None) => {
            append_event(
                &config_dir,
                "info",
                "supervisor-duplicate-skipped",
                serde_json::json!({ "parentPid": args.parent_pid }),
            );
            std::process::exit(0);
        }
        Err(error) => {
            append_event(
                &config_dir,
                "error",
                "supervisor-lock-unavailable",
                serde_json::json!({ "parentPid": args.parent_pid, "error": error.to_string() }),
            );
            std::process::exit(0);
        }
    };
    append_event(
        &config_dir,
        "info",
        "supervisor-watching",
        serde_json::json!({
            "parentPid": expected.pid,
            "startedAtTicks": expected.started_at_ticks,
            "executable": expected.executable_path,
        }),
    );

    let mut unhealthy_logged = false;
    let mut setting_read_error_logged = false;
    let mut parent_unverified_logged = false;
    'watch_parent: loop {
        loop {
            let enabled = match read_watchdog_enabled(settings_path) {
                Ok(enabled) => {
                    setting_read_error_logged = false;
                    Some(enabled)
                }
                Err(error) => {
                    if !setting_read_error_logged {
                        setting_read_error_logged = true;
                        append_event(
                            &config_dir,
                            "warning",
                            "supervisor-settings-unreadable",
                            serde_json::json!({ "parentPid": args.parent_pid, "error": error }),
                        );
                    }
                    None
                }
            };
            let parent = watched_parent_state(&expected);
            match supervisor_poll_action(enabled, parent) {
                SupervisorPollAction::Recover => break,
                SupervisorPollAction::Stop => {
                    append_event(
                        &config_dir,
                        "info",
                        "supervisor-recovery-disabled",
                        serde_json::json!({ "parentPid": args.parent_pid }),
                    );
                    std::process::exit(0);
                }
                SupervisorPollAction::Observe => {}
            }
            match parent {
                WatchedParentState::Running => {
                    parent_unverified_logged = false;
                    if enabled == Some(true) {
                        let port_ready = listener_is_ready(args.port, Some(&expected));
                        if !port_ready && !unhealthy_logged {
                            unhealthy_logged = true;
                            append_event(
                                &config_dir,
                                "warning",
                                "supervisor-parent-unhealthy",
                                serde_json::json!({ "parentPid": args.parent_pid, "port": args.port }),
                            );
                        } else if port_ready {
                            unhealthy_logged = false;
                        }
                    } else {
                        unhealthy_logged = false;
                    }
                }
                WatchedParentState::Unknown => {
                    if !parent_unverified_logged {
                        parent_unverified_logged = true;
                        append_event(
                            &config_dir,
                            "warning",
                            "supervisor-parent-unverified",
                            serde_json::json!({ "parentPid": args.parent_pid }),
                        );
                    }
                }
                // Observe never returns for a confirmed exited parent.
                WatchedParentState::Exited => unreachable!(),
            }
            // A disabled supervisor stays passive while its exact parent is
            // alive. Rapid false->true saves reuse one owner instead of racing
            // against an already queued disabled-process exit.
            std::thread::sleep(POLL_INTERVAL);
        }

        match read_watchdog_enabled(settings_path) {
            Ok(true) => {}
            Ok(false) => {
                append_event(
                    &config_dir,
                    "info",
                    "supervisor-disabled",
                    serde_json::json!({ "parentPid": args.parent_pid }),
                );
                std::process::exit(0);
            }
            Err(error) => {
                append_event(
                    &config_dir,
                    "error",
                    "supervisor-restart-skipped",
                    serde_json::json!({
                        "parentPid": args.parent_pid,
                        "error": error,
                        "reason": "watchdog setting could not be verified",
                    }),
                );
                std::process::exit(0);
            }
        }

        // Read the marker after the parent has stopped. A clean exit removes it;
        // retaining the startup snapshot here would turn an intentional quit into
        // a false crash and relaunch.
        let marker = read_run_marker(&config_dir);
        match classify_parent_recovery_outcome(
            &config_dir,
            marker.as_deref(),
            args.parent_pid,
            Some(&expected),
        ) {
            ParentOutcome::StillRunning => std::process::exit(0),
            ParentOutcome::CleanExit => {
                append_event(
                    &config_dir,
                    "info",
                    "supervisor-clean-exit",
                    serde_json::json!({ "parentPid": args.parent_pid }),
                );
                std::process::exit(0);
            }
            ParentOutcome::Crashed => {}
        }

        let Some(executable) = current_executable() else {
            append_event(
                &config_dir,
                "error",
                "supervisor-restart-failed",
                serde_json::json!({ "error": "current executable unavailable" }),
            );
            std::process::exit(0);
        };
        let mut command = std::process::Command::new(&executable);
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        // Repeat the native absence check at the accounting/launch boundary. A
        // failed identity or liveness probe must not spend the budget or relaunch.
        if watched_parent_state(&expected) != WatchedParentState::Exited {
            std::thread::sleep(POLL_INTERVAL);
            continue 'watch_parent;
        }
        match authorize_restart_attempt(&config_dir, now_secs()) {
            Ok(true) => {}
            Ok(false) => {
                append_event(
                    &config_dir,
                    "error",
                    "supervisor-restart-limited",
                    serde_json::json!({ "parentPid": args.parent_pid, "windowSecs": RESTART_WINDOW_SECS }),
                );
                std::process::exit(0);
            }
            Err(error) => {
                append_event(
                    &config_dir,
                    "error",
                    "supervisor-restart-skipped",
                    serde_json::json!({ "parentPid": args.parent_pid, "reason": "restart budget could not be committed", "error": error }),
                );
                std::process::exit(0);
            }
        }
        let spawned = command.spawn();
        let Ok(mut child) = spawned else {
            let error = spawned
                .err()
                .map(|value| value.to_string())
                .unwrap_or_default();
            append_event(
                &config_dir,
                "error",
                "supervisor-restart-failed",
                serde_json::json!({ "error": error }),
            );
            std::process::exit(0);
        };
        append_event(
            &config_dir,
            "warning",
            "supervisor-restarted",
            serde_json::json!({
                "parentPid": args.parent_pid,
                "newPid": child.id(),
                "port": args.port,
                "executable": executable.to_string_lossy(),
            }),
        );

        let restarted_identity =
            crate::process_identity::process_identity(child.id()).filter(|identity| {
                crate::process_identity::executable_matches_current(&identity.executable_path)
            });
        let deadline = SystemTime::now() + READY_TIMEOUT;
        while SystemTime::now() < deadline {
            if !matches!(child.try_wait(), Ok(None)) {
                break;
            }
            if listener_is_ready(args.port, restarted_identity.as_ref()) {
                append_event(
                    &config_dir,
                    "info",
                    "supervisor-restart-ready",
                    serde_json::json!({ "newPid": child.id(), "port": args.port }),
                );
                std::process::exit(0);
            }
            std::thread::sleep(READY_POLL);
        }
        let child_pid = child.id();
        append_event(
            &config_dir,
            "error",
            "supervisor-restart-not-ready",
            serde_json::json!({ "newPid": child_pid, "port": args.port }),
        );
        if let Err(error) = terminate_and_reap_child(&mut child, FAILED_RESTART_CLEANUP_TIMEOUT) {
            append_event(
                &config_dir,
                "error",
                "supervisor-restart-child-cleanup-failed",
                serde_json::json!({ "newPid": child_pid, "error": error.to_string() }),
            );
        }
        std::process::exit(0);
    }
}

/// 守护日志里的一条事件（供设置页的“看门狗 / 端口自检”面板展示）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchdogEventRecord {
    pub timestamp: String,
    pub level: String,
    pub event: String,
    pub detail: serde_json::Value,
}

/// 读取最近 limit 条守护事件（新到旧）。
pub fn recent_events(config_dir: &Path, limit: usize) -> Vec<WatchdogEventRecord> {
    const MAX_RECORDS: usize = 64;
    let path = log_dir(config_dir).join(WATCHDOG_LOG_FILE);
    let Ok(bytes) = diagnostic_journal::tail(&path) else {
        return Vec::new();
    };
    let mut records = Vec::new();
    for line in bytes.rsplit(|byte| *byte == b'\n') {
        if records.len() >= limit.min(MAX_RECORDS) {
            break;
        }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) else {
            continue;
        };
        records.push(WatchdogEventRecord {
            timestamp: value
                .get("timestamp")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
            level: value
                .get("level")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("info")
                .to_string(),
            event: value
                .get("event")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
            detail: value
                .get("detail")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        });
    }
    records
}

/// 最近一次为 parent_pid 拉起的守护进程 PID（来自守护日志的 supervisor-spawned 事件）。
pub fn last_supervisor_pid(config_dir: &Path, parent_pid: u32) -> Option<u32> {
    recent_events(config_dir, 64)
        .into_iter()
        .filter(|record| record.event == "supervisor-spawned")
        .find_map(|record| {
            let detail = record.detail;
            let detail_parent = detail
                .get("parentPid")
                .and_then(serde_json::Value::as_u64)
                .and_then(|value| u32::try_from(value).ok());
            if detail_parent != Some(parent_pid) {
                return None;
            }
            detail
                .get("supervisorPid")
                .and_then(serde_json::Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
        })
}

/// 当前重启窗口内已经发生的自动拉起次数。
pub fn recent_restart_count(config_dir: &Path) -> usize {
    let now = now_secs();
    let window_start = now.saturating_sub(RESTART_WINDOW_SECS);
    read_recent_restarts(config_dir)
        .into_iter()
        .filter(|value| *value >= window_start)
        .count()
}

/// Status projects the authoritative Node dev ledger, never Rust's ledger.
pub(crate) struct DevWatchdogStatus {
    pub enabled: bool,
    pub enabled_override: Option<bool>,
    pub supervisor_identity: Option<crate::process_identity::ProcessIdentity>,
    pub restarts_in_window: usize,
}

pub(crate) fn parse_dev_watchdog_override(value: Option<&str>) -> Option<bool> {
    value.map(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn dev_restart_count(session: &serde_json::Value, now_ms: u64) -> usize {
    session
        .get("restartTimesMs")
        .filter(|value| value.is_array())
        .or_else(|| session.get("supervisorRestartTimesMs"))
        .and_then(serde_json::Value::as_array)
        .map_or(0, |history| {
            let start = now_ms.saturating_sub(RESTART_WINDOW_SECS * 1000);
            history
                .iter()
                .filter(|value| value.as_u64().is_some_and(|value| value >= start))
                .count()
        })
}

/// Device-local dev markers follow settings.json, not the optionally moved
/// application database/config directory. This mirrors Node resolveDevSettingsPath.
pub(crate) fn dev_session_status_dir() -> PathBuf {
    dev_session_status_dir_from_settings(settings_path().as_deref())
        .unwrap_or_else(|| crate::config::get_home_dir().join(".cc-switch"))
}

fn dev_session_status_dir_from_settings(settings: Option<&Path>) -> Option<PathBuf> {
    settings.and_then(Path::parent).map(Path::to_path_buf)
}

#[cfg(any(target_os = "windows", test))]
fn dev_supervisor_start_matches(recorded: &str, observed_filetime_ticks: u64) -> bool {
    let Ok(started) = chrono::DateTime::parse_from_rfc3339(recorded) else {
        return false;
    };
    // Node's windowsProcessStartedAtUtc uses Date/toISOString and intentionally
    // publishes milliseconds, not native 100ns FILETIME precision. Keep the
    // start-time check at that documented precision as Node's owner check does.
    // PID and executable identity are separately required by the caller.
    let recorded_filetime_ms = i128::from(started.timestamp_millis()) + 11_644_473_600_000;
    recorded_filetime_ms == i128::from(observed_filetime_ticks / 10_000)
}

pub(crate) fn dev_watchdog_status(config_dir: &Path, persisted: bool) -> DevWatchdogStatus {
    let session = std::fs::read(config_dir.join("logs").join("dev-session.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .filter(|session| {
            session
                .get("schemaVersion")
                .and_then(serde_json::Value::as_u64)
                == Some(1)
        });
    let environment_override = std::env::var("CC_SWITCH_DEV_WATCHDOG_ENABLED").ok();
    let enabled_override = parse_dev_watchdog_override(environment_override.as_deref());
    let enabled = enabled_override.unwrap_or(persisted);
    let supervisor_identity = session.as_ref().and_then(|session| {
        if session.get("state").and_then(serde_json::Value::as_str) != Some("running") {
            return None;
        }
        let pid = u32::try_from(session.get("supervisorPid")?.as_u64()?).ok()?;
        let observed = crate::process_identity::process_identity(pid)?;
        let expected_path = session.get("supervisorExecutablePath")?.as_str()?;
        if !observed.executable_path.eq_ignore_ascii_case(expected_path) {
            return None;
        }
        // PID/path alone cannot verify the recorded supervisor's live identity.
        #[cfg(target_os = "windows")]
        {
            if !dev_supervisor_start_matches(
                session.get("supervisorStartedAtUtc")?.as_str()?,
                observed.started_at_ticks,
            ) {
                return None;
            }
        }
        Some(observed)
    });
    let restarts_in_window = session.as_ref().map_or(0, |session| {
        dev_restart_count(session, now_secs().saturating_mul(1000))
    });
    DevWatchdogStatus {
        enabled,
        enabled_override,
        supervisor_identity,
        restarts_in_window,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supervisor_spawn_guard_serializes_check_then_spawn() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let already_spawned = AtomicBool::new(false);
        let spawns = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..16 {
                scope.spawn(|| {
                    let _guard = supervisor_spawn_guard();
                    if !already_spawned.load(Ordering::SeqCst) {
                        std::thread::yield_now();
                        spawns.fetch_add(1, Ordering::SeqCst);
                        already_spawned.store(true, Ordering::SeqCst);
                    }
                });
            }
        });
        assert_eq!(spawns.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn watchdog_fixture_waits_for_owned_input() {
        if std::env::var_os("CCSM_WATCHDOG_DISPOSABLE_FIXTURE").as_deref()
            != Some(std::ffi::OsStr::new("1"))
        {
            return;
        }
        let mut input = String::new();
        let _ = std::io::stdin().read_line(&mut input);
    }

    fn disposable_watchdog_fixture() -> std::process::Child {
        let mut command =
            std::process::Command::new(std::env::current_exe().expect("test executable"));
        command
            .args([
                "--exact",
                "watchdog::tests::watchdog_fixture_waits_for_owned_input",
                "--nocapture",
            ])
            .env("CCSM_WATCHDOG_DISPOSABLE_FIXTURE", "1")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        command.spawn().expect("disposable watchdog fixture")
    }

    #[test]
    fn native_supervisor_receipt_survives_missing_and_flooded_event_logs() {
        let dir = tempfile::tempdir().expect("tempdir");
        let child = disposable_watchdog_fixture();
        let child_pid = child.id();
        let parent_pid = std::process::id();
        let mut receipt = SupervisorChildReceipt {
            config_dir: dir.path().to_path_buf(),
            parent_pid,
            child,
        };
        let without_logs =
            supervisor_identity_from_receipt(Some(&mut receipt), dir.path(), parent_pid)
                .is_some_and(|identity| identity.pid == child_pid);
        for _ in 0..80 {
            append_event(
                dir.path(),
                "warning",
                "supervisor-parent-unhealthy",
                serde_json::json!({ "parentPid": parent_pid }),
            );
        }
        let flooded = supervisor_identity_from_receipt(Some(&mut receipt), dir.path(), parent_pid)
            .is_some_and(|identity| identity.pid == child_pid);
        receipt.child.stdin.take();
        assert!(receipt.child.wait().expect("fixture exit").success());
        assert!(
            without_logs,
            "native child receipt must not depend on a successful diagnostic write"
        );
        assert!(
            flooded,
            "bounded diagnostic history must not erase live ownership"
        );
    }

    #[test]
    fn failed_restart_child_is_killed_and_reaped() {
        let mut child = disposable_watchdog_fixture();
        let child_pid = child.id();

        terminate_and_reap_child(&mut child, FAILED_RESTART_CLEANUP_TIMEOUT)
            .expect("failed restart child cleanup");

        assert!(
            child.try_wait().expect("reaped child status").is_some(),
            "failed restart child must not remain running after supervisor cleanup"
        );
        assert_eq!(
            child.id(),
            child_pid,
            "cleanup must target the spawned child"
        );
    }

    #[derive(Default)]
    struct FailedReplacementFixture {
        terminate_error: Option<io::ErrorKind>,
        exits_after_terminate: bool,
        terminated: bool,
        reap_attempts: usize,
    }

    impl FailedReplacementChild for FailedReplacementFixture {
        fn try_reap(&mut self) -> io::Result<bool> {
            self.reap_attempts += 1;
            Ok(self.terminated && self.exits_after_terminate)
        }

        fn terminate(&mut self) -> io::Result<()> {
            self.terminated = true;
            self.terminate_error.map_or(Ok(()), |kind| Err(kind.into()))
        }
    }

    #[test]
    fn failed_restart_cleanup_reports_kill_error_without_waiting() {
        let mut child = FailedReplacementFixture {
            terminate_error: Some(io::ErrorKind::PermissionDenied),
            ..Default::default()
        };

        let error = terminate_and_reap_child(&mut child, FAILED_RESTART_CLEANUP_TIMEOUT)
            .expect_err("kill error while replacement is still running");

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(child.terminated);
        assert_eq!(child.reap_attempts, 2);
    }

    #[test]
    fn failed_restart_cleanup_accepts_exit_racing_kill_error() {
        let mut child = FailedReplacementFixture {
            terminate_error: Some(io::ErrorKind::PermissionDenied),
            exits_after_terminate: true,
            ..Default::default()
        };

        terminate_and_reap_child(&mut child, Duration::ZERO).expect("confirmed exit wins the race");
        assert_eq!(child.reap_attempts, 2);
    }

    #[test]
    fn failed_restart_cleanup_reports_timeout_after_successful_kill() {
        let mut child = FailedReplacementFixture::default();

        let error = terminate_and_reap_child(&mut child, Duration::ZERO)
            .expect_err("replacement is still running after the cleanup deadline");

        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(child.terminated);
        assert_eq!(child.reap_attempts, 2);
    }

    #[test]
    fn watchdog_fixture_holds_native_parent_lock() {
        let Some(config) = std::env::var_os("CCSM_WATCHDOG_NATIVE_LOCK_FIXTURE") else {
            return;
        };
        let expected: crate::process_identity::ProcessIdentity = serde_json::from_str(
            &std::env::var("CCSM_WATCHDOG_NATIVE_LOCK_IDENTITY").expect("fixture identity"),
        )
        .expect("valid fixture identity");
        let _lock = acquire_supervisor_parent_lock(Path::new(&config), &expected)
            .expect("child native lock")
            .expect("child owns lock");
        std::fs::write(Path::new(&config).join("lock-ready"), b"ready").expect("fixture ready");
        let mut input = String::new();
        let _ = std::io::stdin().read_line(&mut input);
    }

    #[test]
    fn native_parent_lock_excludes_an_independent_process_until_owner_exit() {
        let dir = tempfile::tempdir().expect("tempdir");
        let expected =
            crate::process_identity::current_process_identity().expect("current identity");
        let mut command =
            std::process::Command::new(std::env::current_exe().expect("test executable"));
        command
            .args([
                "--exact",
                "watchdog::tests::watchdog_fixture_holds_native_parent_lock",
                "--nocapture",
            ])
            .env("CCSM_WATCHDOG_NATIVE_LOCK_FIXTURE", dir.path())
            .env(
                "CCSM_WATCHDOG_NATIVE_LOCK_IDENTITY",
                serde_json::to_string(&expected).unwrap(),
            )
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command.spawn().expect("disposable lock fixture");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !dir.path().join("lock-ready").is_file() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let ready = dir.path().join("lock-ready").is_file();
        let other_claim =
            acquire_supervisor_parent_lock(dir.path(), &expected).expect("parent lock attempt");
        let excluded = other_claim.is_none();
        drop(other_claim);
        let next = crate::process_identity::ProcessIdentity {
            started_at_ticks: expected.started_at_ticks + 1,
            ..expected.clone()
        };
        let next_claim =
            acquire_supervisor_parent_lock(dir.path(), &next).expect("next generation attempt");
        let next_allowed = next_claim.is_some();
        drop(next_claim);
        child.stdin.take();
        let exited = child.wait().expect("fixture exit").success();
        assert!(
            ready && exited,
            "native lock fixture must become ready and exit cleanly"
        );
        assert!(
            excluded,
            "an independent native process must exclude the same exact parent claim"
        );
        assert!(
            next_allowed,
            "new app generation may arm while old owner waits"
        );
        assert!(acquire_supervisor_parent_lock(dir.path(), &expected)
            .expect("released native lock")
            .is_some());
    }

    #[test]
    fn duplicate_supervisors_cannot_hold_the_same_exact_parent_lock() {
        let dir = tempfile::tempdir().expect("tempdir");
        let expected =
            crate::process_identity::current_process_identity().expect("current identity");
        let first = acquire_supervisor_parent_lock(dir.path(), &expected)
            .expect("first lock")
            .expect("owned first lock");
        let second =
            acquire_supervisor_parent_lock(dir.path(), &expected).expect("second lock attempt");
        let duplicate_rejected = second.is_none();
        drop(second);
        drop(first);
        assert!(
            duplicate_rejected,
            "two native supervisors must not charge or restart the same parent"
        );
    }

    #[test]
    fn supervisor_parent_lock_does_not_block_the_restarted_app_generation() {
        let dir = tempfile::tempdir().expect("tempdir");
        let expected =
            crate::process_identity::current_process_identity().expect("current identity");
        let first = acquire_supervisor_parent_lock(dir.path(), &expected)
            .expect("first lock")
            .expect("owned first lock");
        let next = crate::process_identity::ProcessIdentity {
            started_at_ticks: expected.started_at_ticks + 1,
            ..expected.clone()
        };
        let next_lock =
            acquire_supervisor_parent_lock(dir.path(), &next).expect("next generation lock");
        assert!(
            next_lock.is_some(),
            "a restarted app must arm while the old supervisor waits for readiness"
        );
        drop(next_lock);
        drop(first);
        assert!(acquire_supervisor_parent_lock(dir.path(), &expected)
            .expect("released lock")
            .is_some());
    }

    #[test]
    fn exact_clean_exit_event_overrides_a_leftover_owned_marker() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(log_dir(dir.path())).expect("logs");
        let expected = crate::process_identity::current_process_identity().expect("identity");
        let marker = serde_json::json!({
            "startedAt": "2026-11-17 10:00:00.000", "pid": expected.pid,
            "version": "test", "os": "test", "arch": "test", "cwd": "redacted",
            "executablePath": expected.executable_path, "processStartedAtTicks": expected.started_at_ticks,
            "configScope": crate::process_identity::config_scope_fingerprint_for(dir.path()),
        });
        let event = serde_json::json!({
            "timestamp": "2026-11-17 10:01:00.000", "kind": "clean_exit", "reason": "user_requested_exit", "exitCode": 0,
            "version": "test", "os": "test", "arch": "test", "pid": expected.pid,
            "details": { "startedAt": "2026-11-17 10:00:00.000", "executablePath": expected.executable_path, "processStartedAtTicks": expected.started_at_ticks.to_string(), "configScope": crate::process_identity::config_scope_fingerprint_for(dir.path()) },
        });
        std::fs::write(
            log_dir(dir.path()).join("app-exit-events.jsonl"),
            format!("{event}\n"),
        )
        .expect("event fixture");
        assert_eq!(
            classify_parent_recovery_outcome(
                dir.path(),
                Some(&marker.to_string()),
                expected.pid,
                Some(&expected)
            ),
            ParentOutcome::CleanExit
        );
    }

    #[test]
    fn disabled_live_observer_can_reenable_without_replacing_its_owner() {
        assert_eq!(
            supervisor_poll_action(Some(false), WatchedParentState::Running),
            SupervisorPollAction::Observe
        );
        assert_eq!(
            supervisor_poll_action(Some(false), WatchedParentState::Unknown),
            SupervisorPollAction::Observe
        );
        assert_eq!(
            supervisor_poll_action(Some(true), WatchedParentState::Running),
            SupervisorPollAction::Observe
        );
        assert_eq!(
            supervisor_poll_action(Some(false), WatchedParentState::Exited),
            SupervisorPollAction::Stop
        );
        assert_eq!(
            supervisor_poll_action(Some(true), WatchedParentState::Exited),
            SupervisorPollAction::Recover
        );
        assert_eq!(
            supervisor_poll_action(None, WatchedParentState::Exited),
            SupervisorPollAction::Stop
        );
    }

    #[test]
    fn malformed_restart_ledger_cannot_authorize_or_erase_history() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(log_dir(dir.path())).expect("logs");
        let file = log_dir(dir.path()).join(WATCHDOG_STATE_FILE);
        for invalid in ["{", "{}", r#"{"restarts":[1,"invalid"]}"#] {
            std::fs::write(&file, invalid).expect("malformed fixture");
            let authorized = authorize_restart_attempt(dir.path(), 2_000_000);
            assert!(
                authorized.is_err(),
                "malformed canonical history must not reset the budget"
            );
            assert_eq!(std::fs::read_to_string(&file).unwrap(), invalid);
        }
    }

    #[test]
    fn unreadable_restart_ledger_cannot_authorize_launch() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(log_dir(dir.path()).join(WATCHDOG_STATE_FILE))
            .expect("unreadable ledger fixture");
        assert!(authorize_restart_attempt(dir.path(), 2_000_000).is_err());
    }

    #[test]
    fn failed_restart_ledger_commit_cannot_authorize_launch() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(log_dir(dir.path()).join(WATCHDOG_STATE_FILE))
            .expect("blocked commit fixture");
        assert!(write_restart_budget_state(dir.path(), &[2_000_000]).is_err());
    }

    #[test]
    fn missing_first_run_ledger_initializes_and_charges_once() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            read_restart_budget_state(dir.path()).unwrap(),
            Vec::<u64>::new()
        );
        assert_eq!(authorize_restart_attempt(dir.path(), 2_000_000), Ok(true));
        assert_eq!(
            read_restart_budget_state(dir.path()).unwrap(),
            vec![2_000_000]
        );
    }

    #[test]
    fn unknown_parent_identity_or_liveness_cannot_authorize_recovery() {
        use crate::process_identity::ProcessIdentityError;
        let expected =
            crate::process_identity::current_process_identity().expect("current identity");
        for error in [
            ProcessIdentityError::AccessDenied,
            ProcessIdentityError::Unavailable(31),
        ] {
            assert_eq!(
                classify_watched_parent_state(&expected, Err(error), Err(error)),
                WatchedParentState::Unknown
            );
            assert_eq!(
                classify_watched_parent_state(&expected, Ok(expected.clone()), Err(error)),
                WatchedParentState::Unknown
            );
        }
        assert_eq!(
            classify_watched_parent_state(
                &expected,
                Err(ProcessIdentityError::NotFound),
                Ok(false)
            ),
            WatchedParentState::Exited
        );
        assert_eq!(
            classify_watched_parent_state(&expected, Err(ProcessIdentityError::NotFound), Ok(true)),
            WatchedParentState::Unknown
        );
        assert_eq!(
            classify_watched_parent_state(&expected, Ok(expected.clone()), Ok(false)),
            WatchedParentState::Exited
        );
        assert_eq!(
            classify_watched_parent_state(&expected, Ok(expected.clone()), Ok(true)),
            WatchedParentState::Running
        );
    }

    #[test]
    fn dev_supervisor_identity_matches_node_millisecond_start_precision() {
        let recorded = "2026-11-16T03:04:05.123Z";
        let millis = chrono::DateTime::parse_from_rfc3339(recorded)
            .unwrap()
            .timestamp_millis();
        let ticks = u64::try_from(i128::from(millis) + 11_644_473_600_000).unwrap() * 10_000;
        assert!(dev_supervisor_start_matches(recorded, ticks));
        // An ordinary native start carries sub-ms ticks lost by Node Date.
        assert!(dev_supervisor_start_matches(recorded, ticks + 7_891));
        assert!(!dev_supervisor_start_matches(recorded, ticks + 10_000));
        assert!(!dev_supervisor_start_matches(recorded, ticks - 1));
        assert!(!dev_supervisor_start_matches("malformed", ticks));
    }

    #[test]
    fn dev_session_ledger_follows_device_settings_not_custom_database_dir() {
        let root = tempfile::tempdir().unwrap();
        let device = root.path().join("home").join(".cc-switch");
        let custom_database_dir = root.path().join("synced-database");
        let settings = device.join("settings.json");
        let dev_dir = dev_session_status_dir_from_settings(Some(&settings)).unwrap();
        assert_eq!(dev_dir, device);
        assert_ne!(dev_dir, custom_database_dir);
        assert_eq!(dev_session_status_dir_from_settings(None), None);
    }

    #[test]
    fn dev_status_uses_dev_override_and_canonical_restart_ledger() {
        for value in ["true", "1", "yes", "on", " ON "] {
            assert_eq!(parse_dev_watchdog_override(Some(value)), Some(true));
        }
        for value in ["false", "0", "off", "invalid", ""] {
            assert_eq!(parse_dev_watchdog_override(Some(value)), Some(false));
        }
        assert_eq!(parse_dev_watchdog_override(None), None);
        let now = 2_000_000;
        let session = serde_json::json!({
            "restartTimesMs": [200_001, 1_999_999],
            "supervisorRestartTimesMs": [1_999_998, 1_999_999, 2_000_000]
        });
        assert_eq!(dev_restart_count(&session, now), 2);
        assert_eq!(
            dev_restart_count(
                &serde_json::json!({"restartTimesMs": [] , "supervisorRestartTimesMs": [now]}),
                now
            ),
            0
        );
        assert_eq!(
            dev_restart_count(&serde_json::json!({"supervisorRestartTimesMs": [now]}), now),
            1
        );
    }

    #[test]
    fn release_and_dev_watchdog_share_restart_budget_contract() {
        let policy: serde_json::Value =
            serde_json::from_str(include_str!("../../scripts/dev-recovery-policy.json"))
                .expect("canonical dev policy");
        assert_eq!(
            policy["maxRestarts"].as_u64(),
            Some(MAX_RESTARTS_PER_WINDOW as u64)
        );
        assert_eq!(
            policy["restartWindowMs"].as_u64(),
            Some(RESTART_WINDOW_SECS * 1000)
        );
    }

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn watched_parent_liveness_requires_the_exact_process_identity() {
        let current =
            crate::process_identity::current_process_identity().expect("current process identity");
        assert_eq!(watched_parent_state(&current), WatchedParentState::Running);
        let reused = crate::process_identity::ProcessIdentity {
            started_at_ticks: current.started_at_ticks + 1,
            ..current
        };
        assert_eq!(watched_parent_state(&reused), WatchedParentState::Exited);
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn watched_parent_liveness_rejects_exited_process_with_retained_child_handle() {
        use std::os::windows::process::CommandExt;

        let mut child = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "set /p ccsm_watchdog_test_exit= & exit /b 0"])
            .creation_flags(0x0800_0000)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("owned test child");
        let expected = crate::process_identity::process_identity(child.id())
            .expect("owned child process identity");
        assert_eq!(watched_parent_state(&expected), WatchedParentState::Running);
        child
            .stdin
            .take()
            .expect("owned child input")
            .write_all(b"\r\n")
            .expect("release owned child");
        assert!(child.wait().expect("owned child exit").success());
        assert!(!crate::process_identity::process_exists(child.id()));
        assert_eq!(watched_parent_state(&expected), WatchedParentState::Exited);
    }

    #[cfg(target_os = "windows")]
    fn test_listener() -> (
        std::net::TcpListener,
        u16,
        crate::process_identity::ProcessIdentity,
    ) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("test listener");
        let port = listener.local_addr().expect("listener address").port();
        let current =
            crate::process_identity::current_process_identity().expect("current process identity");
        assert_eq!(
            crate::process_identity::tcp_listener_owner_pid(port),
            Some(current.pid)
        );
        (listener, port, current)
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn listener_readiness_rejects_foreign_process() {
        let (_listener, port, current) = test_listener();
        let expected = crate::process_identity::ProcessIdentity {
            pid: current.pid + 1,
            ..current
        };
        assert!(!listener_is_ready(port, Some(&expected)));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn listener_readiness_rejects_reused_pid() {
        let (_listener, port, current) = test_listener();
        let expected = crate::process_identity::ProcessIdentity {
            started_at_ticks: current.started_at_ticks + 1,
            ..current
        };
        assert!(!listener_is_ready(port, Some(&expected)));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn listener_readiness_rejects_different_executable() {
        let (_listener, port, current) = test_listener();
        let expected = crate::process_identity::ProcessIdentity {
            executable_path: "C:/not-ccswitch.exe".to_string(),
            ..current
        };
        assert!(!listener_is_ready(port, Some(&expected)));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn listener_readiness_rejects_unverified_process() {
        let (_listener, port, _current) = test_listener();
        assert!(!listener_is_ready(port, None));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn listener_readiness_accepts_exact_process() {
        let (_listener, port, current) = test_listener();
        assert!(listener_is_ready(port, Some(&current)));
    }

    #[test]
    fn listener_readiness_without_port_does_not_require_identity() {
        assert!(listener_is_ready(0, None));
    }

    #[test]
    fn dev_retry_packets_include_chat_transport_failures_only() {
        for reason_class in ["premature_eof", "transport_error"] {
            assert!(
                dev_retry_packet(
                    "retry_scheduled",
                    "session-redacted",
                    "provider-redacted",
                    1,
                    Some(reason_class),
                )
                .is_some(),
                "missing Chat transport retry: {reason_class}"
            );
        }
        for reason_class in [
            "capacity_pressure",
            "capacity_error",
            "capacity_error_long_wait",
            "upstream_error",
            "upstream_http_error",
            "terminal_error",
            "transport_error_after_semantic_output",
        ] {
            assert!(
                dev_retry_packet(
                    "retry_scheduled",
                    "session-redacted",
                    "provider-redacted",
                    1,
                    Some(reason_class),
                )
                .is_none(),
                "non-transport retry reported: {reason_class}"
            );
        }
    }

    #[test]
    fn dev_terminal_packets_use_the_same_private_request_key_as_retry_packets() {
        let retry = dev_retry_packet(
            "retry_scheduled",
            "request-redacted",
            "provider-redacted",
            1,
            Some("transport_error"),
        )
        .expect("retry packet");
        for event in ["stream_finished", "stream_cancelled"] {
            let terminal =
                dev_retry_packet(event, "request-redacted", "provider-redacted", 0, None)
                    .expect("terminal packet");
            assert_eq!(terminal["event"], event);
            assert_eq!(terminal["key"], retry["key"]);
            let serialized = terminal.to_string();
            assert!(!serialized.contains("request-redacted"));
            assert!(!serialized.contains("provider-redacted"));
        }
        let other_request = dev_retry_packet(
            "stream_finished",
            "other-request-redacted",
            "provider-redacted",
            0,
            None,
        )
        .expect("other request terminal packet");
        assert_ne!(other_request["key"], retry["key"]);
    }

    #[test]
    fn dev_retry_packets_only_report_failures_and_hash_stream_identifiers() {
        assert!(dev_retry_packet(
            "reconnected",
            "session-redacted",
            "provider-redacted",
            1,
            None
        )
        .is_none());
        assert!(dev_retry_packet(
            "retry_scheduled",
            "session-redacted",
            "provider-redacted",
            1,
            Some("capacity_pressure")
        )
        .is_none());
        assert!(dev_retry_packet(
            "retry_scheduled",
            "session-redacted",
            "provider-redacted",
            1,
            Some("stream_interrupted")
        )
        .is_some());
        let packet = dev_retry_packet(
            "reconnect_failed",
            "session-redacted",
            "provider-redacted",
            1,
            None,
        )
        .expect("retry packet");
        assert_eq!(packet["event"], "reconnect_failed");
        assert_eq!(packet["key"].as_str().expect("hash").len(), 16);
        let serialized = packet.to_string();
        assert!(!serialized.contains("session-redacted"));
        assert!(!serialized.contains("provider-redacted"));
        assert_ne!(
            packet,
            dev_retry_packet(
                "reconnect_failed",
                "other-session",
                "provider-redacted",
                1,
                None
            )
            .expect("other retry packet")
        );
    }

    #[test]
    fn supervise_args_require_the_flag_and_a_pid() {
        assert!(parse_supervise_args(&args(&["cc-switch.exe"])).is_none());
        assert!(parse_supervise_args(&args(&[SUPERVISE_FLAG])).is_none());
        assert!(parse_supervise_args(&args(&[SUPERVISE_FLAG, "abc"])).is_none());
        let parsed = parse_supervise_args(&args(&[
            "cc-switch.exe",
            SUPERVISE_FLAG,
            "4242",
            SUPERVISE_CONFIG_FLAG,
            "C:/cfg",
            SUPERVISE_SETTINGS_FLAG,
            "C:/cfg/settings.json",
            SUPERVISE_PORT_FLAG,
            "15721",
        ]))
        .expect("parsed");
        assert_eq!(parsed.parent_pid, 4242);
        assert_eq!(parsed.config_dir.as_deref(), Some("C:/cfg"));
        assert_eq!(
            parsed.settings_path.as_deref(),
            Some("C:/cfg/settings.json")
        );
        assert_eq!(parsed.port, 15721);
    }

    #[test]
    fn crash_is_detected_only_from_our_own_remaining_marker() {
        assert_eq!(classify_parent_outcome(None, 42), ParentOutcome::CleanExit);
        assert_eq!(
            classify_parent_outcome(Some("{ not json"), 42),
            ParentOutcome::CleanExit
        );
        assert_eq!(
            classify_parent_outcome(Some(r#"{"pid": 7}"#), 42),
            ParentOutcome::CleanExit
        );
        assert_eq!(
            classify_parent_outcome(Some(r#"{"pid": 42, "version": "1.0"}"#), 42),
            ParentOutcome::Crashed
        );
    }

    #[test]
    fn crash_marker_is_bound_to_the_observed_process_identity_when_available() {
        let expected =
            crate::process_identity::current_process_identity().expect("current process identity");
        let matching = serde_json::json!({
            "pid": expected.pid,
            "executablePath": expected.executable_path,
            "processStartedAtTicks": expected.started_at_ticks,
        });
        assert_eq!(
            classify_parent_outcome_with_identity(
                Some(&matching.to_string()),
                expected.pid,
                Some(&expected),
            ),
            ParentOutcome::Crashed
        );

        let reused_pid = serde_json::json!({
            "pid": expected.pid,
            "executablePath": expected.executable_path,
            "processStartedAtTicks": expected.started_at_ticks.saturating_add(1),
        });
        assert_eq!(
            classify_parent_outcome_with_identity(
                Some(&reused_pid.to_string()),
                expected.pid,
                Some(&expected),
            ),
            ParentOutcome::CleanExit
        );
    }

    #[test]
    fn legacy_pid_only_marker_remains_eligible_for_recovery() {
        let expected =
            crate::process_identity::current_process_identity().expect("current process identity");
        let marker = serde_json::json!({ "pid": expected.pid });
        assert_eq!(
            classify_parent_outcome_with_identity(
                Some(&marker.to_string()),
                expected.pid,
                Some(&expected),
            ),
            ParentOutcome::Crashed
        );
    }

    #[test]
    fn missing_marker_after_parent_exit_is_a_clean_exit_even_with_identity_binding() {
        let expected =
            crate::process_identity::current_process_identity().expect("current process identity");
        assert_eq!(
            classify_parent_outcome_with_identity(None, expected.pid, Some(&expected)),
            ParentOutcome::CleanExit
        );
    }

    #[test]
    fn marker_identity_can_bootstrap_a_supervisor_after_parent_exit() {
        let expected =
            crate::process_identity::current_process_identity().expect("current process identity");
        let marker = serde_json::json!({
            "pid": expected.pid,
            "executablePath": expected.executable_path,
            "processStartedAtTicks": expected.started_at_ticks,
        });

        let recovered = process_identity_from_marker(Some(&marker.to_string()), expected.pid)
            .expect("identity");
        assert!(expected.matches(&recovered));
    }

    #[test]
    fn marker_identity_cannot_bootstrap_from_another_executable() {
        let expected =
            crate::process_identity::current_process_identity().expect("current process identity");
        let marker = serde_json::json!({
            "pid": expected.pid,
            "executablePath": "C:/not-ccswitch.exe",
            "processStartedAtTicks": expected.started_at_ticks,
        });

        assert!(process_identity_from_marker(Some(&marker.to_string()), expected.pid).is_none());
    }

    #[test]
    fn watchdog_setting_is_read_from_persisted_json_each_time() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.json");

        assert!(read_watchdog_enabled(Some(&path)).expect("missing settings"));

        std::fs::write(&path, r#"{"watchdogEnabled":false}"#).expect("write camel case");
        assert!(!read_watchdog_enabled(Some(&path)).expect("camel case settings"));

        std::fs::write(&path, r#"{"watchdog_enabled":false}"#).expect("write snake case");
        assert!(!read_watchdog_enabled(Some(&path)).expect("snake case settings"));

        std::fs::write(&path, r#"{"watchdogEnabled":true}"#).expect("write enabled");
        assert!(read_watchdog_enabled(Some(&path)).expect("enabled settings"));
    }

    #[test]
    fn unreadable_watchdog_setting_fails_closed_before_recovery() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{").expect("write malformed settings");

        let error = read_watchdog_enabled(Some(&path)).expect_err("malformed settings");
        assert!(error.contains("解析看门狗设置失败"));
    }

    #[test]
    fn stale_or_reused_supervisor_pid_is_not_reported_as_live() {
        let dir = tempfile::tempdir().expect("tempdir");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).expect("logs dir");
        let current =
            crate::process_identity::current_process_identity().expect("current process identity");
        let line = serde_json::json!({
            "timestamp": "t1",
            "level": "info",
            "event": "supervisor-spawned",
            "detail": {
                "supervisorPid": current.pid,
                "parentPid": 4242,
                "startedAtTicks": current.started_at_ticks.saturating_add(1),
            }
        });
        std::fs::write(
            logs.join(WATCHDOG_LOG_FILE),
            serde_json::to_string(&line).expect("serialize event"),
        )
        .expect("write log");

        assert!(live_supervisor_identity(dir.path(), 4242).is_none());
    }

    #[test]
    fn supervisor_log_round_trip_finds_events_and_last_pid() {
        let dir = tempfile::tempdir().expect("tempdir");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).expect("logs dir");
        let log = logs.join(WATCHDOG_LOG_FILE);
        let lines = [
            r#"{"timestamp":"t1","level":"info","event":"supervisor-spawned","detail":{"supervisorPid":11,"parentPid":100}}"#,
            r#"{"timestamp":"t2","level":"info","event":"supervisor-watching","detail":{"parentPid":100}}"#,
            r#"{"timestamp":"t3","level":"warning","event":"supervisor-restarted","detail":{"parentPid":100,"newPid":101}}"#,
            r#"{"timestamp":"t4","level":"info","event":"supervisor-spawned","detail":{"supervisorPid":22,"parentPid":999}}"#,
        ]
        .join("\n");
        std::fs::write(&log, lines).expect("write log");

        let events = recent_events(dir.path(), 10);
        assert_eq!(events.len(), 4);
        assert_eq!(events[0].event, "supervisor-spawned");
        assert_eq!(last_supervisor_pid(dir.path(), 100), Some(11));
        assert_eq!(last_supervisor_pid(dir.path(), 999), Some(22));
        assert_eq!(last_supervisor_pid(dir.path(), 1234), None);
    }

    #[test]
    fn watchdog_status_reads_bounded_recent_records_from_legacy_journal() {
        let dir = tempfile::tempdir().expect("tempdir");
        let logs = log_dir(dir.path());
        std::fs::create_dir_all(&logs).expect("logs dir");
        let mut bytes = vec![0xff; 2 * diagnostic_journal::MAX_BYTES];
        bytes.push(b'\n');
        for index in 0..80 {
            writeln!(bytes, r#"{{"event":"event-{index}"}}"#).unwrap();
        }
        std::fs::write(logs.join(WATCHDOG_LOG_FILE), bytes).expect("legacy log");

        let events = recent_events(dir.path(), usize::MAX);

        assert_eq!(events.len(), 64);
        assert_eq!(events.first().unwrap().event, "event-79");
        assert_eq!(events.last().unwrap().event, "event-16");
    }

    #[test]
    fn restart_budget_limits_crash_loops() {
        let now = 1_000_000u64;
        assert!(restart_budget_allows(now, &[]));
        assert!(restart_budget_allows(now, &[now - 10, now - 20]));
        let exhausted = vec![now - 1, now - 2, now - 3, now - 4, now - 5];
        assert!(!restart_budget_allows(now, &exhausted));
        let stale = vec![now - RESTART_WINDOW_SECS - 1; 5];
        assert!(restart_budget_allows(now, &stale));
    }
}
