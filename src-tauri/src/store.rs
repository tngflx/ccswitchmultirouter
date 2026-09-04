use crate::database::Database;
use crate::services::{ProxyService, UsageCache};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Notify;

/// 全局应用状态
#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Database>,
    pub proxy_service: ProxyService,
    pub usage_cache: Arc<UsageCache>,
    protocol_probes_in_flight: Arc<Mutex<HashSet<String>>>,
    protocol_probe_released: Arc<Notify>,
}

pub struct ProtocolProbeLease {
    key: String,
    in_flight: Arc<Mutex<HashSet<String>>>,
    released: Arc<Notify>,
}

impl Drop for ProtocolProbeLease {
    fn drop(&mut self) {
        if let Ok(mut in_flight) = self.in_flight.lock() {
            in_flight.remove(&self.key);
        }
        self.released.notify_waiters();
    }
}

impl AppState {
    /// 创建新的应用状态
    pub fn new(db: Arc<Database>) -> Self {
        let proxy_service = ProxyService::new(db.clone());

        Self {
            db,
            proxy_service,
            usage_cache: Arc::new(UsageCache::new()),
            protocol_probes_in_flight: Arc::new(Mutex::new(HashSet::new())),
            protocol_probe_released: Arc::new(Notify::new()),
        }
    }

    pub fn try_acquire_protocol_probe(&self, key: &str) -> Result<ProtocolProbeLease, String> {
        let mut in_flight = self
            .protocol_probes_in_flight
            .lock()
            .map_err(|_| "protocol probe lease state is unavailable".to_string())?;
        if !in_flight.insert(key.to_string()) {
            return Err("probe_in_progress".to_string());
        }
        Ok(ProtocolProbeLease {
            key: key.to_string(),
            in_flight: self.protocol_probes_in_flight.clone(),
            released: self.protocol_probe_released.clone(),
        })
    }

    /// Wait for a conflicting physical probe to finish while leaving unrelated
    /// targets free to run. The direct try-lock API keeps its rejection semantics.
    pub async fn acquire_protocol_probe(&self, key: &str) -> Result<ProtocolProbeLease, String> {
        tokio::time::timeout(Duration::from_secs(180), async {
            loop {
                let released = self.protocol_probe_released.notified();
                match self.try_acquire_protocol_probe(key) {
                    Ok(lease) => return Ok(lease),
                    Err(error) if error == "probe_in_progress" => released.await,
                    Err(error) => return Err(error),
                }
            }
        })
        .await
        .map_err(|_| "protocol probe queue timed out".to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_protocol_probe_target_has_one_in_flight_lease() {
        let state = AppState::new(Arc::new(Database::memory().expect("memory database")));

        let first = state
            .try_acquire_protocol_probe("target-a")
            .expect("first lease");
        assert!(state.try_acquire_protocol_probe("target-a").is_err());
        assert!(state.try_acquire_protocol_probe("target-b").is_ok());
        drop(first);
        assert!(state.try_acquire_protocol_probe("target-a").is_ok());
    }

    #[tokio::test]
    async fn queued_probe_waits_for_same_target_but_not_unrelated_targets() {
        let state = AppState::new(Arc::new(Database::memory().unwrap()));
        let first = state.try_acquire_protocol_probe("shared").unwrap();
        let mut waiter = Box::pin(state.acquire_protocol_probe("shared"));
        assert!(futures::poll!(&mut waiter).is_pending());
        let unrelated = state.acquire_protocol_probe("other").await.unwrap();
        drop(unrelated);
        drop(first);
        let lease = tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .unwrap()
            .unwrap();
        drop(lease);
        assert!(state.try_acquire_protocol_probe("shared").is_ok());
    }

    #[tokio::test]
    async fn cancelled_probe_waiter_does_not_leak_a_lease() {
        let state = AppState::new(Arc::new(Database::memory().unwrap()));
        let first = state.try_acquire_protocol_probe("shared").unwrap();
        let mut waiter = Box::pin(state.acquire_protocol_probe("shared"));
        assert!(futures::poll!(&mut waiter).is_pending());
        drop(waiter);
        drop(first);
        assert!(state.try_acquire_protocol_probe("shared").is_ok());
    }
}
