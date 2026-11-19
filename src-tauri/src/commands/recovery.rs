use crate::services::recovery_outcome::{
    acknowledge_recovery_outcomes as acknowledge, get_pending_recovery_outcomes as get_pending,
    RecoveryOutcome,
};

#[tauri::command]
pub async fn get_pending_recovery_outcomes() -> Result<Vec<RecoveryOutcome>, String> {
    super::run_command_blocking(get_pending).await
}

#[tauri::command]
pub fn acknowledge_recovery_outcomes(generation: u64, ids: Vec<String>) -> Result<usize, String> {
    acknowledge(generation, &ids)
}

#[cfg(test)]
mod read_dispatch_tests {
    use super::get_pending_recovery_outcomes;
    use std::future::Future;

    fn assert_async_command<T, F>(_: impl FnOnce() -> F)
    where
        F: Future<Output = Result<T, String>> + Send,
    {
    }

    #[test]
    fn pending_recovery_read_uses_async_dispatch() {
        assert_async_command(get_pending_recovery_outcomes);
    }
}
