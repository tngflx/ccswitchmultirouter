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
pub async fn get_codex_usage_limit_resume_count(
    state: tauri::State<'_, crate::AppState>,
) -> Result<UsageLimitResumeCount, String> {
    // The ribbon is also the observer's first consumer after a clean start.
    // Retain the observer before reading its projection so a fresh runtime does
    // not report an unverified zero until another lifecycle path happens to
    // start the guardian.
    state.proxy_service.retain_codex_recovery_observer().await;
    super::run_command_blocking(codex_turn_recovery::codex_usage_limit_resume_count).await
}

#[tauri::command]
pub async fn resume_codex_usage_limited_turns(
) -> Result<codex_turn_recovery::UsageLimitResumeReport, String> {
    codex_turn_recovery::resume_usage_limited_turns().await
}

#[cfg(test)]
mod read_dispatch_tests {
    use super::{get_pending_recovery_outcomes, UsageLimitResumeCount};
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
    fn usage_limit_resume_count_command_retains_observer_before_projection_read() {
        let source = include_str!("recovery.rs");
        let retain = source
            .find("state.proxy_service.retain_codex_recovery_observer().await;")
            .expect("count command retains the observer");
        let read = source
            .find(
                "super::run_command_blocking(codex_turn_recovery::codex_usage_limit_resume_count)",
            )
            .expect("count command reads the projection");
        assert!(
            retain < read,
            "the observer must be retained before the count projection is read"
        );
        let _ = std::marker::PhantomData::<UsageLimitResumeCount>;
    }
}
