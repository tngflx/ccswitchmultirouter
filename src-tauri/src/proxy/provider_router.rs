//! 供应商路由器模块
//!
//! 负责选择和管理代理目标供应商，实现智能故障转移

use crate::app_config::AppType;
use crate::database::Database;
use crate::error::AppError;
use crate::provider::Provider;
use crate::proxy::circuit_breaker::{AllowResult, CircuitBreaker, CircuitBreakerConfig};
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{OwnedSemaphorePermit, RwLock, Semaphore};
use tokio::time::timeout;

use super::codex_traffic_policy::resolve_codex_traffic_policy;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodexAdmissionQueueTimeout {
    pub provider_id: String,
    pub max_in_flight: usize,
    pub waited_ms: u64,
}

/// 供应商路由器
pub struct ProviderRouter {
    /// 数据库连接
    db: Arc<Database>,
    /// 熔断器管理器 - key 格式: "app_type:provider_id"
    circuit_breakers: Arc<RwLock<HashMap<String, Arc<CircuitBreaker>>>>,
    /// Codex MultiRouter route admission gates. These are shared by every request
    /// forwarder and the permit is retained for the complete response stream.
    codex_route_admission: Arc<RwLock<HashMap<String, Arc<Semaphore>>>>,
}

impl ProviderRouter {
    /// 创建新的供应商路由器
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            db,
            circuit_breakers: Arc::new(RwLock::new(HashMap::new())),
            codex_route_admission: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Acquire the provider's shared Codex admission slot when its resolved traffic
    /// policy enables local limiting. The owned permit is retained by the caller for
    /// the complete buffered response or SSE stream, not just response headers.
    pub async fn acquire_codex_route_admission(
        &self,
        provider: &Provider,
        app_type: &str,
    ) -> Result<Option<OwnedSemaphorePermit>, CodexAdmissionQueueTimeout> {
        if app_type != "codex" {
            return Ok(None);
        }

        let policy = resolve_codex_traffic_policy(provider);
        if !policy.admission_enabled {
            return Ok(None);
        }
        let max_in_flight = policy.max_in_flight;
        // Include the limit in the key so a saved policy change takes effect for new
        // requests without mutating a live Tokio semaphore. Routes sharing an endpoint
        // and effective limit intentionally share one process-local admission budget.
        let admission_target = policy.admission_key;
        let key = format!("{app_type}:{admission_target}:limit={max_in_flight}");
        // Keep the read guard in its own scope. An `if let` directly over
        // `read().await` can retain the temporary guard into the `else` branch,
        // then deadlock while that branch waits for the write lock.
        let existing = {
            let gates = self.codex_route_admission.read().await;
            gates.get(&key).cloned()
        };
        let semaphore = if let Some(existing) = existing {
            existing
        } else {
            let mut gates = self.codex_route_admission.write().await;
            gates
                .entry(key.clone())
                .or_insert_with(|| Arc::new(Semaphore::new(max_in_flight)))
                .clone()
        };

        match semaphore.clone().try_acquire_owned() {
            Ok(permit) => Ok(Some(permit)),
            Err(tokio::sync::TryAcquireError::NoPermits) => {
                let max_queue_wait = policy.max_queue_wait;
                let wait_started = Instant::now();
                log::warn!(
                    "[{app_type}] Codex provider {} reached its configured {max_in_flight} in-flight requests; queueing locally for at most {} ms (admission_target={admission_target})",
                    provider.id,
                    max_queue_wait.as_millis()
                );
                super::codex_router_log::append_event(
                    "admission_queue_wait",
                    &[
                        ("provider", provider.id.clone()),
                        ("admission_target", admission_target.clone()),
                        ("max_in_flight", max_in_flight.to_string()),
                        ("max_queue_wait_ms", max_queue_wait.as_millis().to_string()),
                    ],
                );
                match timeout(max_queue_wait, semaphore.acquire_owned()).await {
                    Ok(Ok(permit)) => {
                        let waited_ms =
                            wait_started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
                        super::codex_router_log::append_event(
                            "admission_queue_acquired",
                            &[
                                ("provider", provider.id.clone()),
                                ("admission_target", admission_target),
                                ("max_in_flight", max_in_flight.to_string()),
                                ("waited_ms", waited_ms.to_string()),
                            ],
                        );
                        Ok(Some(permit))
                    }
                    Ok(Err(_)) | Err(_) => {
                        let waited_ms =
                            wait_started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
                        super::codex_router_log::append_event(
                            "admission_queue_timeout",
                            &[
                                ("provider", provider.id.clone()),
                                ("admission_target", admission_target),
                                ("max_in_flight", max_in_flight.to_string()),
                                ("waited_ms", waited_ms.to_string()),
                            ],
                        );
                        Err(CodexAdmissionQueueTimeout {
                            provider_id: provider.id.clone(),
                            max_in_flight,
                            waited_ms,
                        })
                    }
                }
            }
            Err(tokio::sync::TryAcquireError::Closed) => {
                super::codex_router_log::append_event(
                    "admission_queue_closed",
                    &[
                        ("provider", provider.id.clone()),
                        ("admission_target", admission_target),
                        ("max_in_flight", max_in_flight.to_string()),
                    ],
                );
                Err(CodexAdmissionQueueTimeout {
                    provider_id: provider.id.clone(),
                    max_in_flight,
                    waited_ms: 0,
                })
            }
        }
    }

    /// Exposes the shared read-only database for request-local compatibility
    /// profile resolution. Callers must not mutate provider routing through it.
    pub(crate) fn database(&self) -> &Database {
        self.db.as_ref()
    }

    pub(crate) fn database_arc(&self) -> Arc<Database> {
        self.db.clone()
    }

    /// 按应用和 ID 读取真实 provider 配置。
    ///
    /// Codex 多模型 route 可以引用一个已存在的 Codex provider；forwarder 需要在
    /// request-local route 命中后读取该 provider，让 base_url、认证和转换策略跟随
    /// 这个真实供应商配置，而不是复制一份 route 内联配置。
    pub fn get_provider_by_id(
        &self,
        provider_id: &str,
        app_type: &str,
    ) -> Result<Option<Provider>, AppError> {
        self.db.get_provider_by_id(provider_id, app_type)
    }

    /// 选择可用的供应商（支持故障转移）
    ///
    /// 返回按优先级排序的可用供应商列表：
    /// - 故障转移关闭时：仅返回当前供应商
    /// - 故障转移开启时：仅使用故障转移队列，按队列顺序依次尝试（P1 → P2 → ...）
    pub async fn select_providers(&self, app_type: &str) -> Result<Vec<Provider>, AppError> {
        let mut result = Vec::new();
        let mut total_providers = 0usize;
        let mut circuit_open_count = 0usize;

        // 检查该应用的自动故障转移开关是否开启（从 proxy_config 表读取）
        let auto_failover_enabled = match self.db.get_proxy_config_for_app(app_type).await {
            Ok(config) => config.auto_failover_enabled,
            Err(e) => {
                log::error!("[{app_type}] 读取 proxy_config 失败: {e}，默认禁用故障转移");
                false
            }
        };

        if auto_failover_enabled {
            // 故障转移开启：仅按队列顺序依次尝试（P1 → P2 → ...）
            let all_providers = self.db.get_all_providers(app_type)?;

            // 使用 DAO 返回的排序结果，确保和前端展示一致
            let ordered_ids: Vec<String> = self
                .db
                .get_failover_queue(app_type)?
                .into_iter()
                .map(|item| item.provider_id)
                .collect();

            total_providers = ordered_ids.len();

            for provider_id in ordered_ids {
                let Some(provider) = all_providers.get(&provider_id).cloned() else {
                    continue;
                };

                let circuit_key = format!("{app_type}:{}", provider.id);
                let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;

                if breaker.is_available().await {
                    result.push(provider);
                } else {
                    circuit_open_count += 1;
                }
            }
        } else {
            // 故障转移关闭：仅使用当前供应商，跳过熔断器检查
            let current_id = AppType::from_str(app_type)
                .ok()
                .and_then(|app_enum| {
                    crate::settings::get_effective_current_provider(&self.db, &app_enum)
                        .ok()
                        .flatten()
                })
                .or_else(|| self.db.get_current_provider(app_type).ok().flatten());

            if let Some(current_id) = current_id {
                if let Some(current) = self.db.get_provider_by_id(&current_id, app_type)? {
                    total_providers = 1;
                    result.push(current);
                }
            }
        }

        if result.is_empty() {
            if total_providers > 0 && circuit_open_count == total_providers {
                log::warn!("[{app_type}] [FO-004] 所有供应商均已熔断");
                return Err(AppError::AllProvidersCircuitOpen);
            } else {
                log::warn!("[{app_type}] [FO-005] 未配置供应商");
                return Err(AppError::NoProvidersConfigured);
            }
        }

        Ok(result)
    }

    /// 请求执行前获取熔断器“放行许可”
    ///
    /// - Closed：直接放行
    /// - Open：超时到达后切到 HalfOpen 并放行一次探测
    /// - HalfOpen：按限流规则放行探测
    ///
    /// 注意：调用方必须在请求结束后通过 `record_result()` 释放 HalfOpen 名额，
    /// 否则会导致该 Provider 长时间无法进入探测状态。
    pub async fn allow_provider_request(&self, provider_id: &str, app_type: &str) -> AllowResult {
        let circuit_key = format!("{app_type}:{provider_id}");
        let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;
        breaker.allow_request().await
    }

    /// 记录供应商请求结果
    #[allow(dead_code)]
    pub async fn record_result(
        &self,
        provider_id: &str,
        app_type: &str,
        used_half_open_permit: bool,
        success: bool,
        error_msg: Option<String>,
    ) -> Result<(), AppError> {
        self.record_result_with_health_provider(
            provider_id,
            provider_id,
            app_type,
            used_half_open_permit,
            success,
            error_msg,
        )
        .await
    }

    /// 记录一次请求结果，并允许熔断 key 与数据库健康 provider 分离。
    ///
    /// Codex router 的 route 是 request-local attempt target，不是数据库 provider。
    /// 因此熔断器可以按 route id 细分，但 provider_health 必须写入真实父 provider。
    pub async fn record_result_with_health_provider(
        &self,
        circuit_provider_id: &str,
        health_provider_id: &str,
        app_type: &str,
        used_half_open_permit: bool,
        success: bool,
        error_msg: Option<String>,
    ) -> Result<(), AppError> {
        // 1. 按应用独立获取熔断器配置
        let failure_threshold = match self.db.get_proxy_config_for_app(app_type).await {
            Ok(app_config) => app_config.circuit_failure_threshold,
            Err(_) => 5, // 默认值
        };

        // 2. 更新熔断器状态
        let circuit_key = format!("{app_type}:{circuit_provider_id}");
        let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;

        if success {
            breaker.record_success(used_half_open_permit).await;
        } else {
            breaker.record_failure(used_half_open_permit).await;
        }

        // 3. 更新数据库健康状态（使用配置的阈值）
        self.db
            .update_provider_health_with_threshold(
                health_provider_id,
                app_type,
                success,
                error_msg.clone(),
                failure_threshold,
            )
            .await?;

        Ok(())
    }

    /// 重置熔断器（手动恢复）
    pub async fn reset_circuit_breaker(&self, circuit_key: &str) {
        let breakers = self.circuit_breakers.read().await;
        if let Some(breaker) = breakers.get(circuit_key) {
            breaker.reset().await;
        }
    }

    /// 重置指定供应商的熔断器
    pub async fn reset_provider_breaker(&self, provider_id: &str, app_type: &str) {
        let circuit_key = format!("{app_type}:{provider_id}");
        self.reset_circuit_breaker(&circuit_key).await;
    }

    /// 仅释放 HalfOpen permit，不影响健康统计（neutral 接口）
    ///
    /// 用于整流器等场景：请求结果不应计入 Provider 健康度，
    /// 但仍需释放占用的探测名额，避免 HalfOpen 状态卡死
    pub async fn release_permit_neutral(
        &self,
        provider_id: &str,
        app_type: &str,
        used_half_open_permit: bool,
    ) {
        if !used_half_open_permit {
            return;
        }
        let circuit_key = format!("{app_type}:{provider_id}");
        let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;
        breaker.release_half_open_permit();
    }

    /// 更新所有熔断器的配置（热更新）
    pub async fn update_all_configs(&self, config: CircuitBreakerConfig) {
        let breakers = self.circuit_breakers.read().await;
        for breaker in breakers.values() {
            breaker.update_config(config.clone()).await;
        }
    }

    /// 更新指定应用已创建熔断器的配置（热更新）
    pub async fn update_app_configs(&self, app_type: &str, config: CircuitBreakerConfig) {
        let prefix = format!("{app_type}:");
        let breakers = self.circuit_breakers.read().await;
        for (key, breaker) in breakers.iter() {
            if key.starts_with(&prefix) {
                breaker.update_config(config.clone()).await;
            }
        }
    }

    /// 获取熔断器状态
    #[allow(dead_code)]
    pub async fn get_circuit_breaker_stats(
        &self,
        provider_id: &str,
        app_type: &str,
    ) -> Option<crate::proxy::circuit_breaker::CircuitBreakerStats> {
        let circuit_key = format!("{app_type}:{provider_id}");
        let breakers = self.circuit_breakers.read().await;

        if let Some(breaker) = breakers.get(&circuit_key) {
            Some(breaker.get_stats().await)
        } else {
            None
        }
    }

    /// 获取或创建熔断器
    async fn get_or_create_circuit_breaker(&self, key: &str) -> Arc<CircuitBreaker> {
        // 先尝试读锁获取
        {
            let breakers = self.circuit_breakers.read().await;
            if let Some(breaker) = breakers.get(key) {
                return breaker.clone();
            }
        }

        // 如果不存在，获取写锁创建
        let mut breakers = self.circuit_breakers.write().await;

        // 双重检查，防止竞争条件
        if let Some(breaker) = breakers.get(key) {
            return breaker.clone();
        }

        // 从 key 中提取 app_type (格式: "app_type:provider_id")
        let app_type = key.split(':').next().unwrap_or("claude");

        // 按应用独立读取熔断器配置
        let config = match self.db.get_proxy_config_for_app(app_type).await {
            Ok(app_config) => crate::proxy::circuit_breaker::CircuitBreakerConfig {
                failure_threshold: app_config.circuit_failure_threshold,
                success_threshold: app_config.circuit_success_threshold,
                timeout_seconds: app_config.circuit_timeout_seconds as u64,
                error_rate_threshold: app_config.circuit_error_rate_threshold,
                min_requests: app_config.circuit_min_requests,
            },
            Err(_) => crate::proxy::circuit_breaker::CircuitBreakerConfig::default(),
        };

        let breaker = Arc::new(CircuitBreaker::new(config));
        breakers.insert(key.to_string(), breaker.clone());

        breaker
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;
    use serde_json::json;
    use serial_test::serial;
    use std::env;
    use tempfile::TempDir;

    struct TempHome {
        #[allow(dead_code)]
        dir: TempDir,
        original_home: Option<String>,
        original_userprofile: Option<String>,
        original_test_home: Option<String>,
    }

    impl TempHome {
        fn new() -> Self {
            let dir = TempDir::new().expect("failed to create temp home");
            let original_home = env::var("HOME").ok();
            let original_userprofile = env::var("USERPROFILE").ok();
            let original_test_home = env::var("CC_SWITCH_TEST_HOME").ok();

            env::set_var("HOME", dir.path());
            env::set_var("USERPROFILE", dir.path());
            env::set_var("CC_SWITCH_TEST_HOME", dir.path());
            crate::settings::reload_settings().expect("reload settings");

            Self {
                dir,
                original_home,
                original_userprofile,
                original_test_home,
            }
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            match &self.original_home {
                Some(value) => env::set_var("HOME", value),
                None => env::remove_var("HOME"),
            }

            match &self.original_userprofile {
                Some(value) => env::set_var("USERPROFILE", value),
                None => env::remove_var("USERPROFILE"),
            }

            match &self.original_test_home {
                Some(value) => env::set_var("CC_SWITCH_TEST_HOME", value),
                None => env::remove_var("CC_SWITCH_TEST_HOME"),
            }
        }
    }

    #[tokio::test]
    #[serial]
    async fn test_provider_router_creation() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());
        let router = ProviderRouter::new(db);

        let breaker = router.get_or_create_circuit_breaker("claude:test").await;
        assert!(breaker.allow_request().await.allowed);
    }

    #[tokio::test]
    #[serial]
    async fn test_failover_disabled_uses_current_provider() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.set_current_provider("claude", "a").unwrap();
        db.add_to_failover_queue("claude", "b").unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router.select_providers("claude").await.unwrap();

        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "a");
    }

    #[tokio::test]
    #[serial]
    async fn test_failover_enabled_uses_queue_order_ignoring_current() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        // 设置 sort_index 来控制顺序：b=1, a=2
        let mut provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        provider_a.sort_index = Some(2);
        let mut provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        provider_b.sort_index = Some(1);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.set_current_provider("claude", "a").unwrap();

        db.add_to_failover_queue("claude", "b").unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();

        // 启用自动故障转移（使用新的 proxy_config API）
        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router.select_providers("claude").await.unwrap();

        assert_eq!(providers.len(), 2);
        // 故障转移开启时：仅按队列顺序选择（忽略当前供应商）
        assert_eq!(providers[0].id, "b");
        assert_eq!(providers[1].id, "a");
    }

    #[tokio::test]
    #[serial]
    async fn test_failover_enabled_uses_queue_only_even_if_current_not_in_queue() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let mut provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        provider_b.sort_index = Some(1);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.set_current_provider("claude", "a").unwrap();

        // 只把 b 加入故障转移队列（模拟“当前供应商不在队列里”的常见配置）
        db.add_to_failover_queue("claude", "b").unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router.select_providers("claude").await.unwrap();

        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "b");
    }

    #[tokio::test]
    #[serial]
    async fn test_select_providers_does_not_consume_half_open_permit() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        db.update_circuit_breaker_config(&CircuitBreakerConfig {
            failure_threshold: 1,
            timeout_seconds: 0,
            ..Default::default()
        })
        .await
        .unwrap();

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();

        db.add_to_failover_queue("claude", "a").unwrap();
        db.add_to_failover_queue("claude", "b").unwrap();

        // 启用自动故障转移（使用新的 proxy_config API）
        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());

        router
            .record_result("b", "claude", false, false, Some("fail".to_string()))
            .await
            .unwrap();

        let providers = router.select_providers("claude").await.unwrap();
        assert_eq!(providers.len(), 2);

        assert!(router.allow_provider_request("b", "claude").await.allowed);
    }

    #[tokio::test]
    #[serial]
    async fn test_release_permit_neutral_frees_half_open_slot() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        // 配置熔断器：1 次失败即熔断，0 秒超时立即进入 HalfOpen
        db.update_circuit_breaker_config(&CircuitBreakerConfig {
            failure_threshold: 1,
            timeout_seconds: 0,
            ..Default::default()
        })
        .await
        .unwrap();

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        db.save_provider("claude", &provider_a).unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();

        // 启用自动故障转移
        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());

        // 触发熔断：1 次失败
        router
            .record_result("a", "claude", false, false, Some("fail".to_string()))
            .await
            .unwrap();

        // 第一次请求：获取 HalfOpen 探测名额
        let first = router.allow_provider_request("a", "claude").await;
        assert!(first.allowed);
        assert!(first.used_half_open_permit);

        // 第二次请求应被拒绝（名额已被占用）
        let second = router.allow_provider_request("a", "claude").await;
        assert!(!second.allowed);

        // 使用 release_permit_neutral 释放名额（不影响健康统计）
        router
            .release_permit_neutral("a", "claude", first.used_half_open_permit)
            .await;

        // 第三次请求应被允许（名额已释放）
        let third = router.allow_provider_request("a", "claude").await;
        assert!(third.allowed);
        assert!(third.used_half_open_permit);
    }
    fn codex_route_provider(id: &str, base_url: Option<&str>) -> Provider {
        let settings = base_url.map_or_else(
            || json!({}),
            |base_url| {
                json!({
                    "config": format!(
                        "model_provider = \"opencode_go\"\n[model_providers.opencode_go]\nbase_url = \"{base_url}\""
                    )
                })
            },
        );
        Provider::with_id(id.to_string(), id.to_string(), settings, None)
    }

    #[tokio::test]
    async fn codex_route_admission_queues_above_the_per_route_limit() {
        let db = Arc::new(Database::memory().unwrap());
        let router = Arc::new(ProviderRouter::new(db));
        let mut provider = codex_route_provider("codex-multirouter::route::generic", None);
        provider.meta = Some(crate::provider::ProviderMeta {
            codex_traffic_policy: Some(crate::provider::CodexTrafficPolicy {
                admission_enabled: Some(true),
                max_in_flight: Some(2),
                ..Default::default()
            }),
            ..Default::default()
        });

        let mut permits = Vec::with_capacity(2);
        for _ in 0..2 {
            permits.push(
                router
                    .acquire_codex_route_admission(&provider, "codex")
                    .await
                    .expect("admission should not time out")
                    .expect("materialized Codex routes must receive an admission permit"),
            );
        }

        let waiting_router = router.clone();
        let waiting_provider = provider.clone();
        let waiter = tokio::spawn(async move {
            waiting_router
                .acquire_codex_route_admission(&waiting_provider, "codex")
                .await
        });

        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        assert!(
            !waiter.is_finished(),
            "the request above the route limit must queue instead of reaching upstream"
        );

        drop(permits.pop());
        let queued_permit = tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
            .await
            .expect("queued request should wake after a permit is released")
            .expect("admission task should not panic")
            .expect("queued admission should not time out");
        assert!(queued_permit.is_some());
    }

    #[tokio::test]
    async fn opencode_zen_routes_share_the_conservative_admission_limit() {
        let db = Arc::new(Database::memory().unwrap());
        let router = Arc::new(ProviderRouter::new(db));
        let first_route = codex_route_provider(
            "codex-multirouter::route::zen-a",
            Some("https://opencode.ai/zen/go/v1"),
        );
        let mut second_route = codex_route_provider(
            "codex-multirouter::route::zen-b",
            Some("https://opencode.ai/zen/go/v1/"),
        );
        let mut first_route = first_route;
        first_route.settings_config["codexResolvedTargetProviderId"] =
            serde_json::Value::String("zen-provider".to_string());
        second_route.settings_config["codexResolvedTargetProviderId"] =
            serde_json::Value::String("zen-provider".to_string());

        let mut permits = Vec::with_capacity(4);
        for _ in 0..4 {
            permits.push(
                router
                    .acquire_codex_route_admission(&first_route, "codex")
                    .await
                    .expect("admission should not time out")
                    .expect("OpenCode Zen route must receive a permit"),
            );
        }

        let waiting_router = router.clone();
        let waiter = tokio::spawn(async move {
            waiting_router
                .acquire_codex_route_admission(&second_route, "codex")
                .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        assert!(
            !waiter.is_finished(),
            "a second OpenCode Zen route must share the provider-level gate"
        );

        drop(permits.pop());
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
                .await
                .expect("shared OpenCode Zen waiter should wake")
                .expect("admission task should not panic")
                .expect("shared admission should not time out")
                .is_some()
        );
    }

    #[tokio::test]
    async fn providers_with_the_same_endpoint_keep_independent_admission_budgets() {
        let db = Arc::new(Database::memory().unwrap());
        let router = ProviderRouter::new(db);
        let policy = crate::provider::CodexTrafficPolicy {
            admission_enabled: Some(true),
            max_in_flight: Some(1),
            max_queue_wait_ms: Some(100),
            ..Default::default()
        };
        let mut first = codex_route_provider("provider-a", Some("https://same.example/v1"));
        first.meta = Some(crate::provider::ProviderMeta {
            codex_traffic_policy: Some(policy.clone()),
            ..Default::default()
        });
        let mut second = codex_route_provider("provider-b", Some("https://same.example/v1"));
        second.meta = Some(crate::provider::ProviderMeta {
            codex_traffic_policy: Some(policy),
            ..Default::default()
        });

        let _first = router
            .acquire_codex_route_admission(&first, "codex")
            .await
            .expect("first provider admission should not fail")
            .expect("first provider must have a permit");
        let second_permit = tokio::time::timeout(
            std::time::Duration::from_millis(50),
            router.acquire_codex_route_admission(&second, "codex"),
        )
        .await
        .expect("unrelated provider must not wait behind the first")
        .expect("second provider admission should not fail");
        assert!(second_permit.is_some());
    }

    #[tokio::test]
    async fn codex_route_admission_times_out_within_configured_bound() {
        let db = Arc::new(Database::memory().unwrap());
        let router = ProviderRouter::new(db);
        let mut provider = codex_route_provider("bounded-provider", None);
        provider.meta = Some(crate::provider::ProviderMeta {
            codex_traffic_policy: Some(crate::provider::CodexTrafficPolicy {
                admission_enabled: Some(true),
                max_in_flight: Some(1),
                max_queue_wait_ms: Some(100),
                ..Default::default()
            }),
            ..Default::default()
        });

        let _held = router
            .acquire_codex_route_admission(&provider, "codex")
            .await
            .expect("first admission should not fail")
            .expect("first admission must have a permit");
        let started = std::time::Instant::now();
        let error = router
            .acquire_codex_route_admission(&provider, "codex")
            .await
            .expect_err("second admission must time out");

        assert_eq!(error.provider_id, "bounded-provider");
        assert_eq!(error.max_in_flight, 1);
        // Timer wakeups can overshoot the configured wait slightly; assert a sane range.
        assert!(
            error.waited_ms >= 100,
            "reported wait {} ms should be at least the configured bound",
            error.waited_ms
        );
        assert!(
            error.waited_ms < 500,
            "reported wait {} ms should stay close to the configured bound",
            error.waited_ms
        );
        assert!(started.elapsed() >= std::time::Duration::from_millis(90));
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }

    #[tokio::test]
    async fn codex_route_admission_does_not_throttle_other_traffic() {
        let db = Arc::new(Database::memory().unwrap());
        let router = ProviderRouter::new(db);
        let ordinary = codex_route_provider("ordinary-provider", None);
        let codex_route = codex_route_provider("codex-multirouter::route::generic", None);

        assert!(router
            .acquire_codex_route_admission(&ordinary, "codex")
            .await
            .expect("disabled admission must not fail")
            .is_none());
        assert!(router
            .acquire_codex_route_admission(&codex_route, "claude")
            .await
            .expect("disabled admission must not fail")
            .is_none());
    }
}
