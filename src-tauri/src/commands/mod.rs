#![allow(non_snake_case)]

mod auth;
mod balance;
mod codex_oauth;
mod codex_plugin;
mod coding_plan;
mod config;
mod copilot;
mod deeplink;
mod env;
mod failover;
mod global_proxy;
mod hermes;
mod import_export;
mod mcp;
mod misc;
mod model_fetch;
mod omo;
mod openclaw;
mod orchestration;
mod owner_remote;
mod plugin;
mod preset_registry;
mod profile;
mod prompt;
mod protocol_compatibility;
mod provider;
mod proxy;
mod recovery;
mod session_manager;
mod settings;
pub mod skill;
mod stream_check;
mod subscription;
mod sync_support;
mod te_provider;
mod xai_oauth;

mod lightweight;
mod s3_sync;
mod usage;
mod watchdog;
mod webdav_sync;
mod workspace;

pub use auth::*;
pub use balance::*;
pub use codex_oauth::*;
pub use codex_plugin::*;
pub use coding_plan::*;
pub use config::*;
pub use copilot::*;
pub use deeplink::*;
pub use env::*;
pub use failover::*;
pub use global_proxy::*;
pub use hermes::*;
pub use import_export::*;
pub use mcp::*;
pub use misc::*;
pub use model_fetch::*;
pub use omo::*;
pub use openclaw::*;
pub use orchestration::*;
pub use owner_remote::*;
pub use plugin::*;
pub use preset_registry::*;
pub use profile::*;
pub use prompt::*;
pub use protocol_compatibility::*;
pub use provider::*;
pub use proxy::*;
pub use recovery::*;
pub use session_manager::*;
pub use settings::*;
pub use skill::*;
pub use stream_check::*;
pub use subscription::*;
pub use te_provider::*;
pub use xai_oauth::*;

pub use lightweight::*;
pub use s3_sync::*;
pub use usage::*;
pub use watchdog::*;
pub use webdav_sync::*;
pub use workspace::*;

pub use crate::codex_config_consistency::{
    inspect_codex_config_consistency, resolve_codex_config_consistency,
};

/// Keep blocking command work (SQLite, filesystem, and native queries) off both
/// the window thread and the async executor. Reuse the one managed app state.
pub(crate) async fn run_app_state_blocking<T>(
    app: &tauri::AppHandle,
    work: impl FnOnce(&crate::store::AppState) -> Result<T, String> + Send + 'static,
) -> Result<T, String>
where
    T: Send + 'static,
{
    use tauri::Manager;

    let app = app.clone();
    run_command_blocking(move || {
        let state = app
            .try_state::<crate::store::AppState>()
            .ok_or_else(|| "Application state is not initialized".to_string())?;
        work(state.inner())
    })
    .await
}

/// Run synchronous work against a shared state clone on a blocking worker.
/// The clone retains the process-wide Arc-backed caches and coordination locks.
pub(crate) async fn run_state_blocking<T>(
    state: &crate::store::AppState,
    work: impl FnOnce(&crate::store::AppState) -> Result<T, String> + Send + 'static,
) -> Result<T, String>
where
    T: Send + 'static,
{
    let state = state.clone();
    run_command_blocking(move || work(&state)).await
}

pub(crate) async fn run_command_blocking<T>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("Background command failed: {error}"))?
}

#[cfg(test)]
mod blocking_command_tests {
    use super::run_command_blocking;
    use std::time::Duration;

    #[tokio::test]
    async fn blocking_command_runs_on_a_worker_and_preserves_errors() {
        let caller = std::thread::current().id();
        let worker = run_command_blocking(|| Ok(std::thread::current().id()))
            .await
            .unwrap();
        assert_ne!(caller, worker);

        let result = run_command_blocking(|| Err::<(), _>("inspection failed".to_string())).await;
        assert_eq!(result, Err("inspection failed".to_string()));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn blocking_command_keeps_the_async_executor_schedulable() {
        let command = run_command_blocking(|| {
            std::thread::sleep(Duration::from_millis(100));
            Ok::<_, String>(())
        });
        tokio::pin!(command);

        let result = tokio::time::timeout(Duration::from_millis(20), &mut command).await;
        assert!(
            result.is_err(),
            "blocking command completed on the async executor"
        );

        command.await.unwrap();
    }
}
