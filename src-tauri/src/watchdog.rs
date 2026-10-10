//! 跨平台看门狗（supervisor）。
//!
//! 应用自身以 `--ccsm-supervise <parent_pid>` 方式再拉起一个同二进制进程；该进程
//! 只做一件事：盯着主进程。主进程异常退出（运行标记仍指向它、但进程已经不在了）时，
//! 它把安装态可执行文件重新拉起，等到本地代理端口重新可用后自行退出。
//!
//! 为什么不是进程内线程：线程会随主进程一起消失，无法实现“进程死了再拉起来”。
//! 为什么不用 PowerShell/计划任务/systemd/launchd：那是各平台各写一套的运维方案，
//! 不随软件分发，也无法做成产品开关。这里用同一份 Rust 代码覆盖 Windows/macOS/Linux。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 守护进程的启动标记；主程序带这个参数运行时进入守护模式，不创建窗口。
pub const SUPERVISE_FLAG: &str = "--ccsm-supervise";
pub const SUPERVISE_CONFIG_FLAG: &str = "--ccsm-supervise-config";
pub const SUPERVISE_PORT_FLAG: &str = "--ccsm-supervise-port";
pub const SUPERVISE_SETTINGS_FLAG: &str = "--ccsm-supervise-settings";
pub const DEV_SUPERVISOR_ENV: &str = "CC_SWITCH_DEV_SUPERVISOR";

const POLL_INTERVAL: Duration = Duration::from_secs(5);
const READY_TIMEOUT: Duration = Duration::from_secs(90);
const READY_POLL: Duration = Duration::from_millis(500);
const RESTART_WINDOW_SECS: u64 = 30 * 60;
const MAX_RESTARTS_PER_WINDOW: usize = 5;
const RUN_MARKER_FILE: &str = "app-run-marker.json";
const WATCHDOG_LOG_FILE: &str = "watchdog.jsonl";
const WATCHDOG_STATE_FILE: &str = "watchdog-state.json";

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
    std::env::var(DEV_SUPERVISOR_ENV)
        .ok()
        .is_some_and(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true"))
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
    let directory = log_dir(config_dir);
    if std::fs::create_dir_all(&directory).is_err() {
        return;
    }
    let record = serde_json::json!({
        "timestamp": chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "level": level,
        "event": event,
        "detail": detail,
    });
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join(WATCHDOG_LOG_FILE))
    {
        let _ = writeln!(file, "{record}");
    }
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

fn read_recent_restarts(config_dir: &Path) -> Vec<u64> {
    let path = log_dir(config_dir).join(WATCHDOG_STATE_FILE);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|value| {
            value
                .get("restarts")
                .and_then(serde_json::Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .filter_map(serde_json::Value::as_u64)
                        .collect::<Vec<u64>>()
                })
        })
        .unwrap_or_default()
}

fn write_recent_restarts(config_dir: &Path, restarts: &[u64]) {
    let directory = log_dir(config_dir);
    if std::fs::create_dir_all(&directory).is_err() {
        return;
    }
    let payload = serde_json::json!({ "restarts": restarts });
    let _ = std::fs::write(
        directory.join(WATCHDOG_STATE_FILE),
        serde_json::to_vec_pretty(&payload).unwrap_or_default(),
    );
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

fn supervisor_identity_from_event(
    config_dir: &Path,
    parent_pid: u32,
) -> Option<crate::process_identity::ProcessIdentity> {
    let record = recent_events(config_dir, 64).into_iter().find(|record| {
        if record.event != "supervisor-spawned" {
            return false;
        }
        record
            .detail
            .get("parentPid")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            == Some(parent_pid)
    })?;
    let detail = record.detail;
    let supervisor_pid = detail
        .get("supervisorPid")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())?;
    let observed = crate::process_identity::process_identity(supervisor_pid)?;
    if !crate::process_identity::executable_matches_current(&observed.executable_path) {
        return None;
    }
    if let Some(started_at_ticks) = detail
        .get("startedAtTicks")
        .and_then(serde_json::Value::as_u64)
    {
        if started_at_ticks != observed.started_at_ticks {
            return None;
        }
    }
    Some(observed)
}

/// Return the currently live supervisor only when its PID still refers to the
/// same executable identity recorded at spawn time.
pub(crate) fn live_supervisor_identity(
    config_dir: &Path,
    parent_pid: u32,
) -> Option<crate::process_identity::ProcessIdentity> {
    supervisor_identity_from_event(config_dir, parent_pid)
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
        log::debug!("开发会话由 pnpm dev supervisor 接管，跳过 Rust supervisor");
        return;
    }
    let settings = crate::settings::get_settings();
    if !settings.watchdog_enabled {
        log::debug!("内置看门狗已关闭，跳过 supervisor 启动");
        return;
    }
    let parent_pid = std::process::id();
    if let Some(identity) = live_supervisor_identity(config_dir, parent_pid) {
        log::debug!(
            "内置看门狗已在运行: supervisorPid={} parentPid={parent_pid}",
            identity.pid
        );
        return;
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
            let started_at_ticks = crate::process_identity::process_identity(child.id())
                .map(|identity| identity.started_at_ticks);
            append_event(
                config_dir,
                "info",
                "supervisor-spawned",
                serde_json::json!({
                    "supervisorPid": child.id(),
                    "parentPid": parent_pid,
                    "port": port,
                    "executable": executable.to_string_lossy(),
                    "startedAtTicks": started_at_ticks,
                }),
            );
            log::info!(
                "已启动内置看门狗: supervisorPid={} parentPid={parent_pid} port={port}",
                child.id()
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

/// Backwards-compatible startup entry point for callers outside the settings
/// command. New callers should use `ensure_supervisor`.
pub fn spawn_supervisor(config_dir: &Path, port: u16) {
    ensure_supervisor(config_dir, port);
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
    loop {
        match read_watchdog_enabled(settings_path) {
            Ok(true) => {
                setting_read_error_logged = false;
            }
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
                if !setting_read_error_logged {
                    setting_read_error_logged = true;
                    append_event(
                        &config_dir,
                        "warning",
                        "supervisor-settings-unreadable",
                        serde_json::json!({ "parentPid": args.parent_pid, "error": error }),
                    );
                }
            }
        }
        let current = crate::process_identity::process_identity(args.parent_pid);
        let still_running = current
            .as_ref()
            .is_some_and(|current| expected.matches(current));
        if still_running {
            let port_ready = args.port == 0
                || crate::process_identity::tcp_listener_owner_pid(args.port).is_some();
            if !port_ready {
                if !unhealthy_logged {
                    unhealthy_logged = true;
                    append_event(
                        &config_dir,
                        "warning",
                        "supervisor-parent-unhealthy",
                        serde_json::json!({ "parentPid": args.parent_pid, "port": args.port }),
                    );
                }
            } else {
                unhealthy_logged = false;
            }
            std::thread::sleep(POLL_INTERVAL);
            continue;
        }
        break;
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
    match classify_parent_outcome_with_identity(marker.as_deref(), args.parent_pid, Some(&expected))
    {
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

    let mut restarts = read_recent_restarts(&config_dir);
    let now = now_secs();
    if !restart_budget_allows(now, &restarts) {
        append_event(
            &config_dir,
            "error",
            "supervisor-restart-limited",
            serde_json::json!({ "parentPid": args.parent_pid, "windowSecs": RESTART_WINDOW_SECS }),
        );
        std::process::exit(0);
    }
    restarts.push(now);
    write_recent_restarts(&config_dir, &restarts);

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
    let spawned = command.spawn();
    let Ok(child) = spawned else {
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

    let deadline = SystemTime::now() + READY_TIMEOUT;
    while SystemTime::now() < deadline {
        if args.port == 0 || crate::process_identity::tcp_listener_owner_pid(args.port).is_some() {
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
    append_event(
        &config_dir,
        "error",
        "supervisor-restart-not-ready",
        serde_json::json!({ "newPid": child.id(), "port": args.port }),
    );
    std::process::exit(0);
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
    let path = log_dir(config_dir).join(WATCHDOG_LOG_FILE);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let mut records = Vec::new();
    for line in text.lines().rev() {
        if records.len() >= limit {
            break;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
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
