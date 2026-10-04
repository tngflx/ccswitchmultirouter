use std::sync::Arc;

use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::error::AppError;
use crate::services::s3_sync;
use crate::services::sync_protocol::should_trigger_auto_sync_for_table;
use crate::settings::{self, S3SyncSettings};

use crate::services::auto_sync::{AutoSyncState, SuppressionGuard};

static AUTO_SYNC: AutoSyncState = AutoSyncState::new();

pub(crate) struct AutoSyncSuppressionGuard {
    _guard: SuppressionGuard,
}

impl AutoSyncSuppressionGuard {
    pub fn new() -> Self {
        Self {
            _guard: AUTO_SYNC.suppress(),
        }
    }
}

#[cfg(test)]
fn is_auto_sync_suppressed() -> bool {
    AUTO_SYNC.is_suppressed()
}

#[allow(dead_code)]
pub fn should_trigger_for_table(table: &str) -> bool {
    should_trigger_auto_sync_for_table(table)
}

fn should_run_auto_sync(settings: Option<&S3SyncSettings>) -> bool {
    let Some(sync) = settings else {
        return false;
    };
    sync.enabled && sync.auto_sync
}

fn persist_auto_sync_error(settings: &mut S3SyncSettings, error: &AppError) {
    settings.status.last_error = Some(error.to_string());
    settings.status.last_error_source = Some("auto".to_string());
    let _ = settings::update_s3_sync_status(settings.status.clone());
}

fn emit_auto_sync_status_updated(app: &AppHandle, status: &str, error: Option<&str>) {
    let payload = match error {
        Some(message) => json!({
            "source": "auto",
            "status": status,
            "error": message,
        }),
        None => json!({
            "source": "auto",
            "status": status,
        }),
    };

    if let Err(err) = app.emit("s3-sync-status-updated", payload) {
        log::debug!("[S3] failed to emit sync status update event: {err}");
    }
}

async fn run_auto_sync_upload(
    db: &crate::database::Database,
    app: &AppHandle,
) -> Result<(), AppError> {
    let mut settings = settings::get_s3_sync_settings();
    if !should_run_auto_sync(settings.as_ref()) {
        return Ok(());
    }

    let mut sync_settings = match settings.take() {
        Some(value) => value,
        None => return Ok(()),
    };

    let result = s3_sync::run_with_sync_lock(s3_sync::upload(db, &mut sync_settings)).await;
    match result {
        Ok(_) => {
            emit_auto_sync_status_updated(app, "success", None);
            Ok(())
        }
        Err(err) => {
            persist_auto_sync_error(&mut sync_settings, &err);
            emit_auto_sync_status_updated(app, "error", Some(&err.to_string()));
            Err(err)
        }
    }
}

pub fn notify_db_changed(table: &str) {
    AUTO_SYNC.notify(table);
}

pub fn start_worker(db: Arc<crate::database::Database>, app: tauri::AppHandle) {
    AUTO_SYNC.start(db, app, "S3", |db, app| async move {
        run_auto_sync_upload(&db, &app).await
    });
}

#[cfg(test)]
mod tests {
    use super::{
        is_auto_sync_suppressed, should_run_auto_sync, should_trigger_for_table,
        AutoSyncSuppressionGuard,
    };
    use crate::settings::S3SyncSettings;

    #[test]
    fn should_trigger_sync_for_config_tables_only() {
        assert!(should_trigger_for_table("providers"));
        assert!(should_trigger_for_table("settings"));
        assert!(!should_trigger_for_table("proxy_request_logs"));
        assert!(!should_trigger_for_table("provider_health"));
    }

    #[test]
    fn suppression_guard_enables_and_restores_state() {
        assert!(!is_auto_sync_suppressed());
        {
            let _guard = AutoSyncSuppressionGuard::new();
            assert!(is_auto_sync_suppressed());
        }
        assert!(!is_auto_sync_suppressed());
    }

    #[test]
    fn should_run_auto_sync_requires_enabled_and_auto_sync_flag() {
        assert!(!should_run_auto_sync(None));

        let disabled = S3SyncSettings {
            enabled: false,
            auto_sync: true,
            ..S3SyncSettings::default()
        };
        assert!(!should_run_auto_sync(Some(&disabled)));

        let auto_sync_off = S3SyncSettings {
            enabled: true,
            auto_sync: false,
            ..S3SyncSettings::default()
        };
        assert!(!should_run_auto_sync(Some(&auto_sync_off)));

        let enabled = S3SyncSettings {
            enabled: true,
            auto_sync: true,
            ..S3SyncSettings::default()
        };
        assert!(should_run_auto_sync(Some(&enabled)));
    }

    #[test]
    fn service_layer_does_not_depend_on_commands_layer() {
        let source = include_str!("s3_auto_sync.rs");
        let needle = ["crate", "commands", ""].join("::");
        assert!(
            !source.contains(&needle),
            "services layer should not depend on commands layer"
        );
    }
}
