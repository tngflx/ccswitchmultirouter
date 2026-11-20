//! 看门狗 / 端口自检命令
//!
//! 只读：把守护进程状态、最近自动拉起记录和当前端口占用诊断暴露给设置页面板，
//! 让用户不用翻日志就能判断“现在到底有没有守护、端口是谁占的”。

use crate::store::AppState;
use crate::watchdog::WatchdogEventRecord;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchdogStatus {
    /// 设置里是否启用内置看门狗。
    pub enabled: bool,
    /// Saved switch value, independent of an explicit development override.
    pub configured_enabled: bool,
    /// Only present for a pnpm-dev session with an explicit environment override.
    pub enabled_override: Option<bool>,
    /// 当前恢复责任方：Rust supervisor 或 pnpm dev 的开发包装器。
    pub supervisor_mode: String,
    /// 当前应用主进程 PID。
    pub app_pid: u32,
    /// 当前应用对应的守护进程 PID（来自守护日志）。
    pub supervisor_pid: Option<u32>,
    /// 该守护进程当前是否仍在运行。
    pub supervisor_alive: bool,
    /// 守护进程可执行文件路径（校验用）。
    pub supervisor_path: Option<String>,
    /// 重启窗口内已发生的自动拉起次数。
    pub restarts_in_window: usize,
    /// 代理监听端口。
    pub port: u16,
    /// 端口当前监听者 PID。
    pub listener_pid: Option<u32>,
    /// 端口当前监听者可执行文件路径。
    pub listener_path: Option<String>,
    /// 监听者是否就是本安装态程序（即端口就绪且归属正确）。
    pub port_ready: bool,
    /// 端口占用诊断文本（无异常时是简短说明）。
    pub port_diagnosis: String,
    /// 最近若干条守护事件（新到旧）。
    pub recent_events: Vec<WatchdogEventRecord>,
}

fn listener_belongs_to_app(
    listener: Option<&crate::process_identity::ProcessIdentity>,
    app_identity: Option<&crate::process_identity::ProcessIdentity>,
) -> bool {
    listener
        .zip(app_identity)
        .is_some_and(|(listener, app)| app.matches(listener))
}

#[tauri::command]
pub async fn get_watchdog_status(
    state: tauri::State<'_, AppState>,
) -> Result<WatchdogStatus, String> {
    let db = state.db.clone();
    super::run_command_blocking(move || {
        let config_dir = crate::config::get_app_config_dir();
        let supervisor_mode = if crate::watchdog::dev_supervisor_owned() {
            "pnpm-dev"
        } else {
            "rust"
        };
        let port = tauri::async_runtime::block_on(db.get_proxy_config())
            .map(|config| config.listen_port)
            .unwrap_or(0);
        let app_pid = std::process::id();
        let persisted_enabled = crate::settings::get_settings().watchdog_enabled;
        let dev_status = (supervisor_mode == "pnpm-dev").then(|| {
            crate::watchdog::dev_watchdog_status(
                &crate::watchdog::dev_session_status_dir(),
                persisted_enabled,
            )
        });
        let supervisor_identity = dev_status.as_ref().map_or_else(
            || crate::watchdog::live_supervisor_identity(&config_dir, app_pid),
            |status| status.supervisor_identity.clone(),
        );
        let verified_supervisor_pid = supervisor_identity.as_ref().map(|identity| identity.pid);
        let verified_supervisor_path = supervisor_identity
            .as_ref()
            .map(|identity| identity.executable_path.clone());
        let listener_pid = if port > 0 {
            crate::process_identity::tcp_listener_owner_pid(port)
        } else {
            None
        };
        let listener_identity = listener_pid.and_then(crate::process_identity::process_identity);
        let app_identity = crate::process_identity::current_process_identity();
        let port_ready = listener_belongs_to_app(listener_identity.as_ref(), app_identity.as_ref());

        Ok(WatchdogStatus {
            enabled: dev_status
                .as_ref()
                .map_or(persisted_enabled, |status| status.enabled),
            configured_enabled: persisted_enabled,
            enabled_override: dev_status
                .as_ref()
                .and_then(|status| status.enabled_override),
            supervisor_mode: supervisor_mode.to_string(),
            app_pid,
            supervisor_pid: verified_supervisor_pid,
            supervisor_alive: supervisor_identity.is_some(),
            supervisor_path: verified_supervisor_path,
            restarts_in_window: dev_status.as_ref().map_or_else(
                || crate::watchdog::recent_restart_count(&config_dir),
                |status| status.restarts_in_window,
            ),
            port,
            listener_pid,
            listener_path: listener_identity.map(|identity| identity.executable_path),
            port_ready,
            port_diagnosis: if port > 0 {
                crate::process_identity::describe_port_blockers(port)
            } else {
                String::new()
            },
            // A dev session must not display an unrelated release supervisor ledger.
            recent_events: if dev_status.is_some() {
                Vec::new()
            } else {
                crate::watchdog::recent_events(&config_dir, 8)
            },
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::super::run_command_blocking;
    use super::listener_belongs_to_app;
    use std::time::Duration;

    #[test]
    fn recovery_status_requires_exact_app_listener_identity() {
        let app = crate::process_identity::current_process_identity().expect("fixture identity");
        let mut other = app.clone();
        other.pid = app.pid.checked_add(1).expect("fixture pid");
        assert!(
            !listener_belongs_to_app(Some(&other), Some(&app)),
            "another instance of the same binary is not this app's listener"
        );
        other = app.clone();
        other.started_at_ticks += 1;
        assert!(
            !listener_belongs_to_app(Some(&other), Some(&app)),
            "PID reuse must not claim readiness"
        );
        assert!(
            !listener_belongs_to_app(Some(&app), None),
            "unknown app identity cannot prove port ownership"
        );
        assert!(!listener_belongs_to_app(None, Some(&app)));
        assert!(listener_belongs_to_app(Some(&app), Some(&app)));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn watchdog_blocking_dispatch_keeps_executor_schedulable() {
        let command = run_command_blocking(|| {
            std::thread::sleep(Duration::from_millis(50));
            Ok::<_, String>(())
        });
        tokio::pin!(command);

        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut command)
                .await
                .is_err()
        );
        command.await.unwrap();
    }
}
