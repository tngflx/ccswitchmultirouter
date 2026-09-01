use crate::services::codex_plugin_registry::{CodexPluginHealthReport, RepairableCodexPlugin};

#[tauri::command]
pub async fn inspect_codex_plugin_health() -> Result<CodexPluginHealthReport, String> {
    tauri::async_runtime::spawn_blocking(
        crate::services::codex_plugin_registry::inspect_codex_plugin_health,
    )
    .await
    .map_err(|error| format!("Codex plugin diagnostics task failed: {error}"))
}

#[tauri::command]
pub async fn repair_codex_plugin_registration(
    plugin_id: String,
) -> Result<RepairableCodexPlugin, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::services::codex_plugin_registry::repair_codex_plugin_registration(&plugin_id)
    })
    .await
    .map_err(|error| format!("Codex plugin repair task failed: {error}"))?
}
