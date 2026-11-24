use crate::proxy::codex_turn_recovery::{self, UsageLimitResumeCount};
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

#[tauri::command]
pub async fn get_codex_usage_limit_resume_count() -> Result<UsageLimitResumeCount, String> {
    super::run_command_blocking(codex_turn_recovery::codex_usage_limit_resume_count).await
}

#[tauri::command]
pub async fn resume_codex_usage_limited_turns(
) -> Result<codex_turn_recovery::UsageLimitResumeReport, String> {
    codex_turn_recovery::resume_usage_limited_turns().await
}

#[cfg(test)]
mod read_dispatch_tests {
    use super::{
        get_codex_usage_limit_resume_count, get_pending_recovery_outcomes, UsageLimitResumeCount,
    };
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

    #[test]
    fn usage_limit_resume_count_reports_count_and_completeness() {
        assert_async_command::<UsageLimitResumeCount, _>(get_codex_usage_limit_resume_count);
    }
}
