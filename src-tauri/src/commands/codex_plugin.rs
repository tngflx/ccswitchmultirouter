use crate::services::codex_plugin_registry::RepairableCodexPlugin;

use crate::services::codex_plugin_health::CodexPluginHealthReport;

/// Run read-only Codex plugin and browser integration diagnostics.
#[tauri::command]
pub async fn inspect_codex_plugin_health() -> Result<CodexPluginHealthReport, String> {
    tauri::async_runtime::spawn_blocking(
        crate::services::codex_plugin_health::inspect_codex_plugin_health,
    )
    .await
    .map_err(|error| format!("Codex plugin diagnostics task failed: {error}"))
}

/// Detect enabled Codex plugins whose cached manifest is not registered in the
/// personal marketplace. Detection is read-only and never enables a plugin.
#[tauri::command]
pub async fn detect_codex_plugin_registration() -> Result<Vec<RepairableCodexPlugin>, String> {
    tauri::async_runtime::spawn_blocking(
        crate::services::codex_plugin_registry::detect_codex_plugin_registration,
    )
    .await
    .map_err(|error| format!("Codex plugin registration scan failed: {error}"))?
}

/// Repair one user-confirmed Codex plugin marketplace entry.
#[tauri::command]
pub fn repair_codex_plugin_registration(
    plugin_id: String,
) -> Result<RepairableCodexPlugin, String> {
    crate::services::codex_plugin_registry::repair_codex_plugin_registration(&plugin_id)
}

#[cfg(test)]
mod tests {
    #[test]
    fn registration_scan_uses_async_dispatch() {
        fn assert_async<F>(_: impl FnOnce() -> F)
        where
            F: std::future::Future<Output = Result<Vec<super::RepairableCodexPlugin>, String>>
                + Send,
        {
        }

        assert_async(super::detect_codex_plugin_registration);
    }
}
