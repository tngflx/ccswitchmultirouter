use std::collections::HashMap;
use tauri::AppHandle;

use crate::openclaw_config;

// ============================================================================
// OpenClaw Provider Commands (migrated from provider.rs)
// ============================================================================

/// Import providers from OpenClaw live config to database.
///
/// OpenClaw uses additive mode — users may already have providers
/// configured in openclaw.json.
#[tauri::command]
pub async fn import_openclaw_providers_from_live(app: AppHandle) -> Result<usize, String> {
    super::run_app_state_blocking(&app, |state| {
        crate::services::provider::import_openclaw_providers_from_live(state)
            .map_err(|e| e.to_string())
    })
    .await
}

/// Get provider IDs in the OpenClaw live config.
#[tauri::command]
pub async fn get_openclaw_live_provider_ids() -> Result<Vec<String>, String> {
    super::run_command_blocking(|| {
        openclaw_config::get_providers()
            .map(|providers| providers.keys().cloned().collect())
            .map_err(|e| e.to_string())
    })
    .await
}

/// Get a single OpenClaw provider fragment from live config.
#[tauri::command]
pub async fn get_openclaw_live_provider(
    #[allow(non_snake_case)] providerId: String,
) -> Result<Option<serde_json::Value>, String> {
    super::run_command_blocking(move || {
        openclaw_config::get_provider(&providerId).map_err(|e| e.to_string())
    })
    .await
}

/// Scan openclaw.json for known configuration hazards.
#[tauri::command]
pub async fn scan_openclaw_config_health(
) -> Result<Vec<openclaw_config::OpenClawHealthWarning>, String> {
    super::run_command_blocking(|| {
        openclaw_config::scan_openclaw_config_health().map_err(|e| e.to_string())
    })
    .await
}

// ============================================================================
// Agents Configuration Commands
// ============================================================================

/// Get OpenClaw default model config (agents.defaults.model)
#[tauri::command]
pub async fn get_openclaw_default_model(
) -> Result<Option<openclaw_config::OpenClawDefaultModel>, String> {
    super::run_command_blocking(|| openclaw_config::get_default_model().map_err(|e| e.to_string()))
        .await
}

#[cfg(test)]
mod read_dispatch_tests {
    use super::{
        get_openclaw_agents_defaults, get_openclaw_default_model, get_openclaw_env,
        get_openclaw_live_provider, get_openclaw_live_provider_ids, get_openclaw_model_catalog,
        get_openclaw_tools, import_openclaw_providers_from_live, scan_openclaw_config_health,
        set_openclaw_agents_defaults, set_openclaw_default_model, set_openclaw_env,
        set_openclaw_model_catalog, set_openclaw_tools,
    };
    use std::future::Future;
    use tauri::AppHandle;

    fn assert_async_command<T, F>(_: impl FnOnce() -> F)
    where
        F: Future<Output = Result<T, String>> + Send,
    {
    }

    fn assert_async_command_with_arg<A, T, F>(_: impl FnOnce(A) -> F)
    where
        F: Future<Output = Result<T, String>> + Send,
    {
    }

    fn assert_async_app_command<T, F>(_: impl FnOnce(AppHandle) -> F)
    where
        F: Future<Output = Result<T, String>> + Send,
    {
    }

    #[test]
    fn provider_page_reads_use_async_dispatch() {
        assert_async_command(get_openclaw_live_provider_ids);
        assert_async_command(get_openclaw_default_model);
        assert_async_command_with_arg(get_openclaw_live_provider);
        assert_async_command(scan_openclaw_config_health);
        assert_async_command(get_openclaw_model_catalog);
        assert_async_command(get_openclaw_agents_defaults);
        assert_async_command(get_openclaw_env);
        assert_async_command(get_openclaw_tools);
        assert_async_app_command(import_openclaw_providers_from_live);
    }

    #[test]
    fn setters_use_async_dispatch() {
        assert_async_command_with_arg(set_openclaw_default_model);
        assert_async_command_with_arg(set_openclaw_model_catalog);
        assert_async_command_with_arg(set_openclaw_agents_defaults);
        assert_async_command_with_arg(set_openclaw_env);
        assert_async_command_with_arg(set_openclaw_tools);
    }
}

/// Set OpenClaw default model config (agents.defaults.model)
#[tauri::command]
pub async fn set_openclaw_default_model(
    model: openclaw_config::OpenClawDefaultModel,
) -> Result<openclaw_config::OpenClawWriteOutcome, String> {
    super::run_command_blocking(move || {
        openclaw_config::set_default_model(&model).map_err(|e| e.to_string())
    })
    .await
}

/// Get OpenClaw model catalog/allowlist (agents.defaults.models)
#[tauri::command]
pub async fn get_openclaw_model_catalog(
) -> Result<Option<HashMap<String, openclaw_config::OpenClawModelCatalogEntry>>, String> {
    super::run_command_blocking(|| openclaw_config::get_model_catalog().map_err(|e| e.to_string()))
        .await
}

/// Set OpenClaw model catalog/allowlist (agents.defaults.models)
#[tauri::command]
pub async fn set_openclaw_model_catalog(
    catalog: HashMap<String, openclaw_config::OpenClawModelCatalogEntry>,
) -> Result<openclaw_config::OpenClawWriteOutcome, String> {
    super::run_command_blocking(move || {
        openclaw_config::set_model_catalog(&catalog).map_err(|e| e.to_string())
    })
    .await
}

/// Get full agents.defaults config (all fields)
#[tauri::command]
pub async fn get_openclaw_agents_defaults(
) -> Result<Option<openclaw_config::OpenClawAgentsDefaults>, String> {
    super::run_command_blocking(|| {
        openclaw_config::get_agents_defaults().map_err(|e| e.to_string())
    })
    .await
}

/// Set full agents.defaults config (all fields)
#[tauri::command]
pub async fn set_openclaw_agents_defaults(
    defaults: openclaw_config::OpenClawAgentsDefaults,
) -> Result<openclaw_config::OpenClawWriteOutcome, String> {
    super::run_command_blocking(move || {
        openclaw_config::set_agents_defaults(&defaults).map_err(|e| e.to_string())
    })
    .await
}

// ============================================================================
// Env Configuration Commands
// ============================================================================

/// Get OpenClaw env config (env section of openclaw.json)
#[tauri::command]
pub async fn get_openclaw_env() -> Result<openclaw_config::OpenClawEnvConfig, String> {
    super::run_command_blocking(|| openclaw_config::get_env_config().map_err(|e| e.to_string()))
        .await
}

/// Set OpenClaw env config (env section of openclaw.json)
#[tauri::command]
pub async fn set_openclaw_env(
    env: openclaw_config::OpenClawEnvConfig,
) -> Result<openclaw_config::OpenClawWriteOutcome, String> {
    super::run_command_blocking(move || {
        openclaw_config::set_env_config(&env).map_err(|e| e.to_string())
    })
    .await
}

// ============================================================================
// Tools Configuration Commands
// ============================================================================

/// Get OpenClaw tools config (tools section of openclaw.json)
#[tauri::command]
pub async fn get_openclaw_tools() -> Result<openclaw_config::OpenClawToolsConfig, String> {
    super::run_command_blocking(|| openclaw_config::get_tools_config().map_err(|e| e.to_string()))
        .await
}

/// Set OpenClaw tools config (tools section of openclaw.json)
#[tauri::command]
pub async fn set_openclaw_tools(
    tools: openclaw_config::OpenClawToolsConfig,
) -> Result<openclaw_config::OpenClawWriteOutcome, String> {
    super::run_command_blocking(move || {
        openclaw_config::set_tools_config(&tools).map_err(|e| e.to_string())
    })
    .await
}
