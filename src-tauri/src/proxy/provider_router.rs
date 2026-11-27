//! 供应商路由器模块
//!
//! 负责选择和管理代理目标供应商，实现智能故障转移

use crate::app_config::AppType;
use crate::codex_multirouter::catalog::share_provider_catalog;
use crate::codex_multirouter::compile_inputs::{routing_inputs_revision, RoutingInputsRevision};
use crate::codex_multirouter::compiler::{
    compile_v2, enabled_provider_v2_plan, CodexRoutingCompileError,
};
use crate::database::{Database, ProviderRevision};
use crate::error::AppError;
use crate::provider::Provider;
use crate::proxy::circuit_breaker::{AllowResult, CircuitBreaker, CircuitBreakerConfig};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::str::FromStr;
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::sync::{OwnedSemaphorePermit, RwLock, Semaphore};
use tokio::time::timeout;

use super::codex_traffic_policy::resolve_codex_traffic_policy;
use super::error::ProxyError;
use super::providers::{CodexV2RouteIndex, ResolvedCodexRoute};

const MAX_CACHED_CODEX_ROUTERS: usize = 4;

pub(super) struct CodexV2RoutePlan {
    pub(super) index: CodexV2RouteIndex,
    providers: HashMap<String, Provider>,
}

impl CodexV2RoutePlan {
    pub(super) fn resolve(
        &self,
        router: &Provider,
        body: &Value,
        explicit_route_id: Option<&str>,
    ) -> Result<Option<ResolvedCodexRoute>, ProxyError> {
        self.index
            .resolve(router, body, &self.providers, explicit_route_id)
            .map_err(codex_v2_compile_error)
    }
}

struct CachedCodexV2Routes {
    provider_id: String,
    routing: Value,
    sqlite: ProviderRevision,
    inputs: RoutingInputsRevision,
    compiled: Result<Arc<CodexV2RoutePlan>, CodexRoutingCompileError>,
}

fn codex_v2_compile_error(error: CodexRoutingCompileError) -> ProxyError {
    ProxyError::ConfigError(format!(
        "Codex MultiRouter v2 编译失败 [{}]: {}",
        error.code, error.message
    ))
}

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
    /// Shared Codex admission gates. Permits are retained by the forwarder for the
    /// complete response lifetime, including streamed bodies.
    codex_route_admission: Arc<RwLock<HashMap<String, Arc<Semaphore>>>>,
    codex_v2_routes: Mutex<VecDeque<CachedCodexV2Routes>>,
    codex_v2_compile: Mutex<()>,
    #[cfg(test)]
    codex_v2_compile_count: AtomicUsize,
}

impl ProviderRouter {
    /// 创建新的供应商路由器
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            db,
            circuit_breakers: Arc::new(RwLock::new(HashMap::new())),
            codex_route_admission: Arc::new(RwLock::new(HashMap::new())),
            codex_v2_routes: Mutex::new(VecDeque::new()),
            codex_v2_compile: Mutex::new(()),
            #[cfg(test)]
            codex_v2_compile_count: AtomicUsize::new(0),
        }
    }

    #[cfg(test)]
    pub(super) fn codex_v2_compile_count(&self) -> usize {
        self.codex_v2_compile_count.load(Ordering::Relaxed)
    }

    pub(crate) fn resolve_codex_v2_route(
        &self,
        provider: &Provider,
        body: &Value,
        explicit_route_id: Option<&str>,
    ) -> Result<Option<ResolvedCodexRoute>, ProxyError> {
        self.resolve_codex_v2_route_with(provider, body, explicit_route_id, routing_inputs_revision)
    }

    fn resolve_codex_v2_route_with(
        &self,
        provider: &Provider,
        body: &Value,
        explicit_route_id: Option<&str>,
        inputs_revision: impl Fn() -> Option<RoutingInputsRevision>,
    ) -> Result<Option<ResolvedCodexRoute>, ProxyError> {
        let Some(plan) = self.codex_v2_route_plan_with(provider, inputs_revision)? else {
            return Ok(None);
        };
        plan.resolve(provider, body, explicit_route_id)
    }

    pub(super) fn codex_v2_route_plan(
        &self,
        provider: &Provider,
    ) -> Result<Option<Arc<CodexV2RoutePlan>>, ProxyError> {
        self.codex_v2_route_plan_with(provider, routing_inputs_revision)
    }

    fn codex_v2_route_plan_with(
        &self,
        provider: &Provider,
        inputs_revision: impl Fn() -> Option<RoutingInputsRevision>,
    ) -> Result<Option<Arc<CodexV2RoutePlan>>, ProxyError> {
        let Some(routing) = provider.settings_config.get("codexRouting") else {
            return Ok(None);
        };
        if routing.get("schemaVersion").and_then(Value::as_u64) != Some(2) {
            return Ok(None);
        }

        let sqlite_revision = || {
            self.db
                .provider_revision()
                .map_err(|error| ProxyError::DatabaseError(error.to_string()))
        };
        let cached = |sqlite, inputs: Option<&RoutingInputsRevision>| {
            let inputs = inputs?;
            self.codex_v2_routes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .iter()
                .find(|entry| {
                    entry.sqlite == sqlite
                        && &entry.inputs == inputs
                        && entry.provider_id == provider.id
                        && &entry.routing == routing
                })
                .map(|entry| entry.compiled.clone())
        };
        let inputs = inputs_revision();
        if let Some(compiled) = cached(sqlite_revision()?, inputs.as_ref()) {
            return compiled.map(Some).map_err(codex_v2_compile_error);
        }

        // A cold miss may be shared by concurrent requests. Recheck after acquiring
        // the compile lock while allowing hits to keep using the cache directly.
        let _compile = self
            .codex_v2_compile
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for _ in 0..2 {
            let inputs = inputs_revision();
            let sqlite = sqlite_revision()?;
            if let Some(compiled) = cached(sqlite, inputs.as_ref()) {
                return compiled.map(Some).map_err(codex_v2_compile_error);
            }

            let Some(plan) = enabled_provider_v2_plan(provider).map_err(codex_v2_compile_error)?
            else {
                return Ok(None);
            };
            let target_ids = plan
                .routes
                .iter()
                .map(|route| route.target_provider_id.trim())
                .filter(|id| !id.is_empty())
                .collect::<HashSet<_>>();
            let mut providers = self
                .db
                .get_providers_by_id(AppType::Codex.as_str(), target_ids)
                .map_err(|error| ProxyError::DatabaseError(error.to_string()))?;
            #[cfg(test)]
            self.codex_v2_compile_count.fetch_add(1, Ordering::Relaxed);
            let compiled = compile_v2(&plan, &providers);

            // Publish only when the read transaction and the compiler both saw
            // the revision we checked for a hit. A racing change gets a fresh pass.
            if (inputs.is_some() && inputs_revision() != inputs) || sqlite_revision()? != sqlite {
                continue;
            }
            let compiled = compiled.map(|compiled| {
                for provider in providers.values_mut() {
                    share_provider_catalog(provider);
                }
                Arc::new(CodexV2RoutePlan {
                    index: CodexV2RouteIndex::new(compiled, provider, &providers),
                    providers,
                })
            });
            if let Some(inputs) = inputs {
                let mut cache = self
                    .codex_v2_routes
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                cache.retain(|entry| {
                    entry.sqlite == sqlite
                        && entry.inputs == inputs
                        && entry.provider_id != provider.id
                });
                if cache.len() == MAX_CACHED_CODEX_ROUTERS {
                    cache.pop_front();
                }
                cache.push_back(CachedCodexV2Routes {
                    provider_id: provider.id.clone(),
                    routing: routing.clone(),
                    sqlite,
                    inputs,
                    compiled: compiled.clone(),
                });
            }
            return compiled.map(Some).map_err(codex_v2_compile_error);
        }
        Err(ProxyError::ConfigError(
            "Codex MultiRouter settings changed while resolving the request".to_string(),
        ))
    }

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
        let admission_target = policy.admission_key;
        let key = format!("{app_type}:{admission_target}:limit={max_in_flight}");
        let existing = {
            let gates = self.codex_route_admission.read().await;
            gates.get(&key).cloned()
        };
        let semaphore = if let Some(existing) = existing {
            existing
        } else {
            let mut gates = self.codex_route_admission.write().await;
            gates
                .entry(key)
                .or_insert_with(|| Arc::new(Semaphore::new(max_in_flight)))
                .clone()
        };
        match semaphore.clone().try_acquire_owned() {
            Ok(permit) => Ok(Some(permit)),
            Err(tokio::sync::TryAcquireError::NoPermits) => {
                let wait_started = Instant::now();
                match timeout(policy.max_queue_wait, semaphore.acquire_owned()).await {
                    Ok(Ok(permit)) => Ok(Some(permit)),
                    Ok(Err(_)) | Err(_) => Err(CodexAdmissionQueueTimeout {
                        provider_id: provider.id.clone(),
                        max_in_flight,
                        waited_ms: wait_started.elapsed().as_millis().min(u128::from(u64::MAX))
                            as u64,
                    }),
                }
            }
            Err(tokio::sync::TryAcquireError::Closed) => Err(CodexAdmissionQueueTimeout {
                provider_id: provider.id.clone(),
                max_in_flight,
                waited_ms: 0,
            }),
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
            let providers = self.db.get_failover_providers(app_type)?;
            total_providers = providers.len();
            for provider in providers {
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
    use std::cell::Cell;
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

    fn codex_target(id: &str, model_count: usize) -> Provider {
        let models = (0..model_count)
            .map(|index| json!({"model": format!("{id}-model-{index}")}))
            .collect::<Vec<_>>();
        Provider::with_id(
            id.to_string(),
            format!("Target {id}"),
            json!({
                "apiFormat": "openai_responses",
                "apiKey": format!("test-key-{id}"),
                "baseUrl": format!("https://{id}.example.test/v1"),
                "modelCatalog": {"models": models}
            }),
            None,
        )
    }

    fn codex_router(id: &str, target_id: &str, route_label: &str) -> Provider {
        Provider::with_id(
            id.to_string(),
            format!("Router {id}"),
            json!({
                "codexRouting": {
                    "schemaVersion": 2,
                    "enabled": true,
                    "defaultRouteId": "route",
                    "routes": [{
                        "id": "route",
                        "label": route_label,
                        "enabled": true,
                        "targetProviderId": target_id,
                        "modelSelection": {"mode": "all"},
                        "matchPrefixes": [],
                        "aliases": {},
                        "authPolicy": {"source": "provider_config"}
                    }]
                }
            }),
            None,
        )
    }

    fn resolve_cached_route(
        router: &ProviderRouter,
        provider: &Provider,
        body: &Value,
        revision: u64,
    ) -> Result<Option<ResolvedCodexRoute>, ProxyError> {
        router.resolve_codex_v2_route_with(provider, body, None, || {
            Some(RoutingInputsRevision::for_test(revision))
        })
    }

    #[test]
    #[serial]
    fn codex_router_cache_reuses_compiled_plan_for_small_and_large_text_and_raw_requests() {
        let _home = TempHome::new();
        for model_count in [2, 512] {
            let db = Arc::new(Database::memory().unwrap());
            let target = codex_target("target", model_count);
            db.save_provider(AppType::Codex.as_str(), &target).unwrap();
            let router = ProviderRouter::new(db);
            let provider = codex_router("router", "target", "Route");
            let model = format!("target-model-{}", model_count - 1);

            let text = json!({"model": model, "input": "hello"});
            let raw = json!({});
            for _ in 0..8 {
                let resolved = resolve_cached_route(&router, &provider, &text, 1)
                    .unwrap()
                    .expect("text resolves by model name");
                assert_eq!(resolved.matched_by, "exact");
                assert_eq!(resolved.upstream_model, model);

                let resolved = router
                    .resolve_codex_v2_route_with(&provider, &raw, Some(" ROUTE "), || {
                        Some(RoutingInputsRevision::for_test(1))
                    })
                    .unwrap()
                    .expect("model-less raw request resolves by explicit route id");
                assert_eq!(resolved.matched_by, "explicit_route_id");
                assert_eq!(resolved.target_provider_id, "target");
            }
            assert_eq!(router.codex_v2_compile_count(), 1);
        }
    }

    #[test]
    #[serial]
    fn codex_router_cache_compiles_one_plan_for_concurrent_cold_requests() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());
        let target = codex_target("target", 128);
        db.save_provider(AppType::Codex.as_str(), &target).unwrap();
        let router = ProviderRouter::new(db);
        let provider = codex_router("router", "target", "Route");
        let body = json!({"model": "target-model-127"});
        let workers = 8;
        let first_revision = std::sync::Barrier::new(workers);

        std::thread::scope(|scope| {
            for _ in 0..workers {
                let router = &router;
                let provider = &provider;
                let body = &body;
                let first_revision = &first_revision;
                scope.spawn(move || {
                    let first_read = Cell::new(true);
                    let resolved = router
                        .resolve_codex_v2_route_with(provider, body, None, || {
                            if first_read.replace(false) {
                                first_revision.wait();
                            }
                            Some(RoutingInputsRevision::for_test(1))
                        })
                        .unwrap()
                        .expect("concurrent call selects the compiled route");
                    assert_eq!(resolved.upstream_model, "target-model-127");
                });
            }
        });

        assert_eq!(router.codex_v2_compile_count(), 1);
    }

    #[test]
    #[serial]
    fn codex_router_cache_invalidates_after_catalog_edit_and_deletion() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());
        let mut target = codex_target("target", 2);
        db.save_provider(AppType::Codex.as_str(), &target).unwrap();
        let router = ProviderRouter::new(db.clone());
        let provider = codex_router("router", "target", "Route");
        let old_request = json!({"model": "target-model-0"});
        let new_request = json!({"model": "target-model-edited"});

        assert!(resolve_cached_route(&router, &provider, &old_request, 1)
            .unwrap()
            .is_some());
        assert_eq!(router.codex_v2_compile_count(), 1);

        target.settings_config["modelCatalog"]["models"][0]["model"] = json!("target-model-edited");
        db.save_provider(AppType::Codex.as_str(), &target).unwrap();
        assert!(resolve_cached_route(&router, &provider, &old_request, 1)
            .unwrap()
            .is_none());
        assert!(resolve_cached_route(&router, &provider, &new_request, 1)
            .unwrap()
            .is_some());
        assert_eq!(router.codex_v2_compile_count(), 2);

        db.delete_provider(AppType::Codex.as_str(), &target.id)
            .unwrap();
        for _ in 0..4 {
            let error = resolve_cached_route(&router, &provider, &new_request, 1)
                .expect_err("deleted target must invalidate the cached plan");
            assert!(error.to_string().contains("target_provider_missing"));
        }
        assert_eq!(router.codex_v2_compile_count(), 3);

        db.save_provider(AppType::Codex.as_str(), &target).unwrap();
        assert!(resolve_cached_route(&router, &provider, &new_request, 1)
            .unwrap()
            .is_some());
        assert_eq!(router.codex_v2_compile_count(), 4);
    }

    #[test]
    #[serial]
    fn codex_router_cache_invalidates_after_external_catalog_commit() {
        let home = TempHome::new();
        let path = home.dir.path().join("router-cache.sqlite");
        let conn = rusqlite::Connection::open(&path).unwrap();
        let journal_mode: String = conn
            .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
            .unwrap();
        assert_eq!(journal_mode, "wal");
        let db = Arc::new(Database::from_connection(conn));
        db.create_tables().unwrap();
        let mut target = codex_target("target", 12);
        db.save_provider(AppType::Codex.as_str(), &target).unwrap();
        let router = ProviderRouter::new(db);
        let provider = codex_router("router", "target", "Route");
        let request = json!({"model": "target-model-0"});
        assert!(resolve_cached_route(&router, &provider, &request, 1)
            .unwrap()
            .is_some());

        target.settings_config["modelCatalog"]["models"][0]["enabled"] = json!(false);
        let mut external = rusqlite::Connection::open(&path).unwrap();
        let update = external.transaction().unwrap();
        assert_eq!(
            update
                .execute(
                    "UPDATE providers SET settings_config = ?1 WHERE id = ?2 AND app_type = ?3",
                    rusqlite::params![
                        target.settings_config.to_string(),
                        target.id,
                        AppType::Codex.as_str()
                    ],
                )
                .unwrap(),
            1
        );
        assert!(resolve_cached_route(&router, &provider, &request, 1)
            .unwrap()
            .is_some());
        assert_eq!(router.codex_v2_compile_count(), 1);
        update.commit().unwrap();

        for _ in 0..4 {
            assert!(resolve_cached_route(&router, &provider, &request, 1)
                .unwrap()
                .is_none());
        }
        assert_eq!(router.codex_v2_compile_count(), 2);
    }

    #[test]
    #[serial]
    fn codex_router_cache_invalidates_after_router_plan_and_external_input_changes() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());
        let target = codex_target("target", 2);
        db.save_provider(AppType::Codex.as_str(), &target).unwrap();
        let router = ProviderRouter::new(db);
        let mut provider = codex_router("router", "target", "Route");
        let request = json!({"model": "target-model-0"});

        let resolved = resolve_cached_route(&router, &provider, &request, 1)
            .unwrap()
            .unwrap();
        assert_eq!(resolved.effective_provider.name, "Route");
        assert_eq!(router.codex_v2_compile_count(), 1);

        provider.settings_config["codexRouting"]["routes"][0]["label"] = json!("Changed");
        let resolved = resolve_cached_route(&router, &provider, &request, 1)
            .unwrap()
            .unwrap();
        assert_eq!(resolved.effective_provider.name, "Changed");
        assert_eq!(router.codex_v2_compile_count(), 2);

        for _ in 0..4 {
            assert!(resolve_cached_route(&router, &provider, &request, 2)
                .unwrap()
                .is_some());
        }
        assert_eq!(router.codex_v2_compile_count(), 3);
    }

    #[test]
    #[serial]
    fn codex_router_cache_retries_when_sqlite_or_external_revision_changes_during_compile() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());
        let mut target = codex_target("target", 4);
        db.save_provider(AppType::Codex.as_str(), &target).unwrap();
        let provider = codex_router("router", "target", "Route");
        let request = json!({"model": "target-model-0"});

        let router = ProviderRouter::new(db.clone());
        let resolved = router
            .resolve_codex_v2_route_with(&provider, &request, None, || {
                let revision = if router.codex_v2_compile_count() == 0 {
                    1
                } else {
                    2
                };
                Some(RoutingInputsRevision::for_test(revision))
            })
            .unwrap();
        assert!(resolved.is_some());
        assert!(resolve_cached_route(&router, &provider, &request, 2)
            .unwrap()
            .is_some());
        assert_eq!(router.codex_v2_compile_count(), 2);

        let router = ProviderRouter::new(db.clone());
        target.settings_config["modelCatalog"]["models"][0]["enabled"] = json!(false);
        let edited_catalog = Cell::new(false);
        let resolved = router
            .resolve_codex_v2_route_with(&provider, &request, None, || {
                if router.codex_v2_compile_count() == 1 && !edited_catalog.replace(true) {
                    db.save_provider(AppType::Codex.as_str(), &target).unwrap();
                }
                Some(RoutingInputsRevision::for_test(1))
            })
            .unwrap();
        assert!(edited_catalog.get());
        assert!(resolved.is_none());
        assert!(resolve_cached_route(&router, &provider, &request, 1)
            .unwrap()
            .is_none());
        assert_eq!(router.codex_v2_compile_count(), 2);
    }
}
