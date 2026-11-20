use tauri::State;

use crate::services::omo::{OmoLocalFileData, SLIM, STANDARD};
use crate::services::OmoService;
use crate::store::AppState;

#[tauri::command]
pub async fn read_omo_local_file() -> Result<OmoLocalFileData, String> {
    super::run_command_blocking(|| {
        OmoService::read_local_file(&STANDARD).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn get_current_omo_provider_id(state: State<'_, AppState>) -> Result<String, String> {
    let db = state.db.clone();
    super::run_command_blocking(move || {
        let provider = db
            .get_current_omo_provider("opencode", "omo")
            .map_err(|e| e.to_string())?;
        Ok(provider.map(|p| p.id).unwrap_or_default())
    })
    .await
}

#[tauri::command]
pub async fn disable_current_omo(state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.clone();
    super::run_command_blocking(move || {
        let providers = db
            .get_all_providers("opencode")
            .map_err(|e| e.to_string())?;
        for (id, p) in &providers {
            if p.category.as_deref() == Some("omo") {
                db.clear_omo_provider_current("opencode", id, "omo")
                    .map_err(|e| e.to_string())?;
            }
        }
        OmoService::delete_config_file(&STANDARD).map_err(|e| e.to_string())
    })
    .await
}

// ── OMO Slim commands ───────────────────────────────────────

#[tauri::command]
pub async fn read_omo_slim_local_file() -> Result<OmoLocalFileData, String> {
    super::run_command_blocking(|| OmoService::read_local_file(&SLIM).map_err(|e| e.to_string()))
        .await
}

#[tauri::command]
pub async fn get_current_omo_slim_provider_id(
    state: State<'_, AppState>,
) -> Result<String, String> {
    let db = state.db.clone();
    super::run_command_blocking(move || {
        let provider = db
            .get_current_omo_provider("opencode", "omo-slim")
            .map_err(|e| e.to_string())?;
        Ok(provider.map(|p| p.id).unwrap_or_default())
    })
    .await
}

#[tauri::command]
pub async fn disable_current_omo_slim(state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.clone();
    super::run_command_blocking(move || {
        let providers = db
            .get_all_providers("opencode")
            .map_err(|e| e.to_string())?;
        for (id, p) in &providers {
            if p.category.as_deref() == Some("omo-slim") {
                db.clear_omo_provider_current("opencode", id, "omo-slim")
                    .map_err(|e| e.to_string())?;
            }
        }
        OmoService::delete_config_file(&SLIM).map_err(|e| e.to_string())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::super::run_command_blocking;
    use std::time::Duration;

    #[tokio::test(flavor = "current_thread")]
    async fn omo_blocking_dispatch_keeps_executor_schedulable() {
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
