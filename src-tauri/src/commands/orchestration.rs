use crate::orchestration::{Run, Settings};
use crate::store::AppState;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestrationSaveResult {
    settings: Settings,
    codex_projection: Option<crate::codex_multirouter::projection::CodexRoutingProjectionStatus>,
    publication_error: Option<String>,
}

#[tauri::command]
pub fn get_orchestration_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    state
        .db
        .get_orchestration_settings()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_orchestration_settings(
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<OrchestrationSaveResult, String> {
    settings
        .validate_providers(&state.db)
        .map_err(|error| error.to_string())?;
    state
        .db
        .save_orchestration_settings(&settings)
        .map_err(|error| error.to_string())?;
    let publication =
        crate::codex_multirouter::projection::inspect_active_codex_multirouter_projection(
            &state.db,
        )
        .and_then(|status| {
            status
                .map(|status| {
                    crate::codex_multirouter::projection::ensure_codex_multirouter_projection(
                        &state.db,
                        &status.router_provider_id,
                        true,
                    )
                })
                .transpose()
        });
    Ok(save_result(settings, publication))
}

fn save_result(
    settings: Settings,
    publication: Result<
        Option<crate::codex_multirouter::projection::CodexRoutingProjectionStatus>,
        crate::error::AppError,
    >,
) -> OrchestrationSaveResult {
    match publication {
        Ok(codex_projection) => OrchestrationSaveResult {
            settings,
            codex_projection,
            publication_error: None,
        },
        // Projection errors can contain upstream configuration. Only return a safe diagnostic.
        Err(_) => OrchestrationSaveResult {
            settings,
            codex_projection: None,
            publication_error: Some("projection_publish_failed".into()),
        },
    }
}

#[tauri::command]
pub fn list_orchestration_runs(state: State<'_, AppState>) -> Result<Vec<Run>, String> {
    state
        .db
        .list_orchestration_runs()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn cancel_orchestration_run(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<bool, String> {
    if run_id.trim().is_empty() {
        return Err("run_id is required".into());
    }
    let Some(mut run) = state
        .db
        .get_orchestration_run(&run_id)
        .map_err(|error| error.to_string())?
    else {
        return Ok(false);
    };
    if run.finished_at.is_some() || run.status != "running" {
        return Ok(false);
    }
    let requested = crate::proxy::orchestration_runtime::request_cancel(&run_id);
    if requested {
        run.status = "cancellation_requested".to_string();
        state
            .db
            .save_orchestration_run(&run)
            .map_err(|error| error.to_string())?;
    }
    Ok(requested)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publication_failure_preserves_saved_settings_and_redacts_details() {
        let result = save_result(
            crate::orchestration::fixture(),
            Err(crate::error::AppError::Message(
                "sensitive diagnostic".into(),
            )),
        );
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["settings"]["profiles"][0]["id"], "test");
        assert_eq!(value["publicationError"], "projection_publish_failed");
        assert!(!value.to_string().contains("sensitive diagnostic"));
        assert!(result.codex_projection.is_none());
    }
}
