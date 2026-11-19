use crate::services::env_checker::{check_env_conflicts as check_conflicts, EnvConflict};
use crate::services::env_manager::{
    delete_env_vars as delete_vars, restore_from_backup, BackupInfo,
};

/// Check environment variable conflicts for a specific app
#[tauri::command]
pub async fn check_env_conflicts(app: String) -> Result<Vec<EnvConflict>, String> {
    super::run_command_blocking(move || check_conflicts(&app)).await
}

/// Delete environment variables with backup
#[tauri::command]
pub fn delete_env_vars(conflicts: Vec<EnvConflict>) -> Result<BackupInfo, String> {
    delete_vars(conflicts)
}

/// Restore environment variables from backup file
#[tauri::command]
pub fn restore_env_backup(backup_path: String) -> Result<(), String> {
    restore_from_backup(backup_path)
}

#[cfg(test)]
mod tests {
    #[test]
    fn environment_conflict_check_uses_async_dispatch() {
        fn assert_async<F>(_: impl FnOnce(String) -> F)
        where
            F: std::future::Future<Output = Result<Vec<super::EnvConflict>, String>> + Send,
        {
        }

        assert_async(super::check_env_conflicts);
    }
}
