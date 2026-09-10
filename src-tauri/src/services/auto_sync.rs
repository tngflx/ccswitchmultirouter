use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{channel, Sender};

use super::sync_protocol::should_trigger_auto_sync_for_table;
use crate::{database::Database, error::AppError};

pub(crate) const MAX_AUTO_SYNC_WAIT_MS: u64 = 10_000;

pub(crate) struct AutoSyncState {
    tx: OnceLock<Sender<String>>,
    suppress_depth: AtomicUsize,
}

pub(crate) struct SuppressionGuard(&'static AutoSyncState);

impl Drop for SuppressionGuard {
    fn drop(&mut self) {
        self.0.suppress_depth.fetch_sub(1, Ordering::SeqCst);
    }
}

impl AutoSyncState {
    pub const fn new() -> Self {
        Self {
            tx: OnceLock::new(),
            suppress_depth: AtomicUsize::new(0),
        }
    }

    pub fn suppress(&'static self) -> SuppressionGuard {
        self.suppress_depth.fetch_add(1, Ordering::SeqCst);
        SuppressionGuard(self)
    }

    pub fn is_suppressed(&self) -> bool {
        self.suppress_depth.load(Ordering::SeqCst) > 0
    }

    pub fn notify(&self, table: &str) {
        if self.is_suppressed() || !should_trigger_auto_sync_for_table(table) {
            return;
        }
        if let Some(tx) = self.tx.get() {
            let _ = enqueue_change_signal(tx, table);
        }
    }

    pub fn start<F, Fut>(
        &'static self,
        db: Arc<Database>,
        app: tauri::AppHandle,
        label: &'static str,
        upload: F,
    ) where
        F: Fn(Arc<Database>, tauri::AppHandle) -> Fut + Send + 'static,
        Fut: Future<Output = Result<(), AppError>> + Send,
    {
        // One pending dirty signal is sufficient while an upload is running.
        let (tx, mut rx) = channel::<String>(1);
        if self.tx.set(tx).is_err() {
            return;
        }
        tauri::async_runtime::spawn(async move {
            while let Some(first_table) = rx.recv().await {
                let started_at = Instant::now();
                let mut merged_count = 1usize;
                while let Some(wait_for) = auto_sync_wait_duration(started_at, Instant::now()) {
                    match tokio::time::timeout(wait_for, rx.recv()).await {
                        Ok(Some(_)) => merged_count += 1,
                        Ok(None) => return,
                        Err(_) => break,
                    }
                }
                log::debug!("[{label}][AutoSync] Triggered by table={first_table}, merged_changes={merged_count}");
                if let Err(err) = upload(db.clone(), app.clone()).await {
                    log::warn!("[{label}][AutoSync] Upload failed: {err}");
                }
            }
        });
    }
}

pub(crate) fn enqueue_change_signal(tx: &Sender<String>, table: &str) -> bool {
    tx.try_send(table.to_string()).is_ok()
}

pub(crate) fn auto_sync_wait_duration(started_at: Instant, now: Instant) -> Option<Duration> {
    let remaining = Duration::from_millis(MAX_AUTO_SYNC_WAIT_MS)
        .checked_sub(now.saturating_duration_since(started_at))?;
    if remaining.is_zero() {
        return None;
    }
    Some(Duration::from_millis(1000).min(remaining))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_suppression_is_scoped_to_each_transport() {
        static FIRST: AutoSyncState = AutoSyncState::new();
        static SECOND: AutoSyncState = AutoSyncState::new();
        let outer = FIRST.suppress();
        let inner = FIRST.suppress();
        assert!(FIRST.is_suppressed());
        assert!(!SECOND.is_suppressed());
        drop(inner);
        assert!(FIRST.is_suppressed());
        drop(outer);
        assert!(!FIRST.is_suppressed());
    }

    #[test]
    fn debounce_respects_remaining_deadline() {
        let start = Instant::now();
        assert_eq!(
            auto_sync_wait_duration(start, start),
            Some(Duration::from_millis(1000))
        );
        assert_eq!(
            auto_sync_wait_duration(start, start + Duration::from_millis(9500)),
            Some(Duration::from_millis(500))
        );
        assert_eq!(
            auto_sync_wait_duration(start, start + Duration::from_millis(10000)),
            None
        );
    }
}
