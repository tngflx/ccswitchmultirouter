//! 供应商连通性检查命令
//!
//! 注意：本检查只探测 base_url 是否可达，不发真实大模型请求，也不触碰故障转移
//! 熔断器（熔断器由真实转发流量驱动）。详见 `services::stream_check`。

use crate::app_config::AppType;
use crate::commands::copilot::CopilotAuthState;
use crate::error::AppError;
use crate::services::stream_check::{
    HealthStatus, StreamCheckConfig, StreamCheckResult, StreamCheckService,
};
use std::collections::HashSet;
use tauri::{AppHandle, State};

/// 连通性检查（单个供应商）
#[tauri::command]
pub async fn stream_check_provider(
    app: AppHandle,
    copilot_state: State<'_, CopilotAuthState>,
    app_type: AppType,
    provider_id: String,
) -> Result<StreamCheckResult, AppError> {
    let provider_id_for_load = provider_id.clone();
    let app_type_for_load = app_type.clone();
    let (config, provider) = crate::commands::run_app_state_blocking(&app, move |state| {
        let config = state.db.get_stream_check_config().map_err(|e| e.to_string())?;
        let providers = state
            .db
            .get_all_providers(app_type_for_load.as_str())
            .map_err(|e| e.to_string())?;
        let provider = providers
            .get(&provider_id_for_load)
            .cloned()
            .ok_or_else(|| format!("供应商 {provider_id_for_load} 不存在"))?;
        Ok((config, provider))
    })
    .await
    .map_err(AppError::Message)?;

    // Copilot 端点是动态的（随 OAuth token 解析），需预先取出 host 再探测；
    // 其余供应商传 None，由服务层从 settings_config 提取 base_url。无需鉴权。
    let base_url_override = resolve_copilot_base_url_override(&provider, &copilot_state).await?;
    let result =
        StreamCheckService::check_with_retry(&app_type, &provider, &config, base_url_override)
            .await?;

    // 记录日志
    let app_type_for_log = app_type.as_str().to_string();
    let provider_name = provider.name.clone();
    let result_for_log = result.clone();
    let _ = crate::commands::run_app_state_blocking(&app, move |state| {
        state
            .db
            .save_stream_check_log(
                &provider_id,
                &provider_name,
                &app_type_for_log,
                &result_for_log,
            )
            .map_err(|e| e.to_string())
    })
    .await;

    Ok(result)
}

/// 批量连通性检查
#[tauri::command]
pub async fn stream_check_all_providers(
    app: AppHandle,
    copilot_state: State<'_, CopilotAuthState>,
    app_type: AppType,
    proxy_targets_only: bool,
) -> Result<Vec<(String, StreamCheckResult)>, AppError> {
    let app_type_for_load = app_type.clone();
    let (config, providers) = crate::commands::run_app_state_blocking(&app, move |state| {
        let config = state.db.get_stream_check_config().map_err(|e| e.to_string())?;
        let providers = state
            .db
            .get_all_providers(app_type_for_load.as_str())
            .map_err(|e| e.to_string())?;
        let allowed_ids: Option<HashSet<String>> = if proxy_targets_only {
            let mut ids = HashSet::new();
            if let Ok(Some(current_id)) = state.db.get_current_provider(app_type_for_load.as_str())
            {
                ids.insert(current_id);
            }
            if let Ok(queue) = state.db.get_failover_queue(app_type_for_load.as_str()) {
                for item in queue {
                    ids.insert(item.provider_id);
                }
            }
            Some(ids)
        } else {
            None
        };

        let providers = providers
            .into_iter()
            .filter(|(id, provider)| {
                provider.category.as_deref() != Some("official")
                    && allowed_ids
                        .as_ref()
                        .is_none_or(|allowed| allowed.contains(id))
            })
            .collect::<Vec<_>>();
        Ok((config, providers))
    })
    .await
    .map_err(AppError::Message)?;

    let mut results = Vec::new();
    for (id, provider) in providers {
        let base_url_override =
            resolve_copilot_base_url_override(&provider, &copilot_state).await?;
        let result =
            StreamCheckService::check_with_retry(&app_type, &provider, &config, base_url_override)
                .await
                .unwrap_or_else(|e| StreamCheckResult {
                    status: HealthStatus::Failed,
                    success: false,
                    message: e.to_string(),
                    response_time_ms: None,
                    http_status: None,
                    model_used: String::new(),
                    tested_at: chrono::Utc::now().timestamp(),
                    retry_count: 0,
                    error_category: None,
                });

        let app_type_for_log = app_type.as_str().to_string();
        let provider_name = provider.name.clone();
        let result_for_log = result.clone();
        let id_for_log = id.clone();
        let _ = crate::commands::run_app_state_blocking(&app, move |state| {
            state
                .db
                .save_stream_check_log(
                    &id_for_log,
                    &provider_name,
                    &app_type_for_log,
                    &result_for_log,
                )
                .map_err(|e| e.to_string())
        })
        .await;

        results.push((id, result));
    }

    Ok(results)
}

/// 获取连通性检查配置
#[tauri::command]
pub async fn get_stream_check_config(app: AppHandle) -> Result<StreamCheckConfig, AppError> {
    crate::commands::run_app_state_blocking(&app, |state| {
        state.db.get_stream_check_config().map_err(|e| e.to_string())
    })
    .await
    .map_err(AppError::Message)
}

/// 保存连通性检查配置
#[tauri::command]
pub async fn save_stream_check_config(
    app: AppHandle,
    config: StreamCheckConfig,
) -> Result<(), AppError> {
    crate::commands::run_app_state_blocking(&app, move |state| {
        state
            .db
            .save_stream_check_config(&config)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(AppError::Message)
}

/// Copilot 供应商的 base_url 需要从 OAuth 管理器动态解析（按账号或默认端点）。
/// `is_full_url` 的供应商已是完整地址，无需解析。
async fn resolve_copilot_base_url_override(
    provider: &crate::provider::Provider,
    copilot_state: &State<'_, CopilotAuthState>,
) -> Result<Option<String>, AppError> {
    let is_copilot = is_copilot_provider(provider);
    let is_full_url = provider
        .meta
        .as_ref()
        .and_then(|meta| meta.is_full_url)
        .unwrap_or(false);

    if !is_copilot || is_full_url {
        return Ok(None);
    }

    let auth_manager = copilot_state.0.read().await;
    let account_id = provider
        .meta
        .as_ref()
        .and_then(|meta| meta.managed_account_id_for("github_copilot"));

    let endpoint = match account_id.as_deref() {
        Some(id) => auth_manager.get_api_endpoint(id).await,
        None => auth_manager.get_default_api_endpoint().await,
    };

    Ok(Some(endpoint))
}

fn is_copilot_provider(provider: &crate::provider::Provider) -> bool {
    provider
        .meta
        .as_ref()
        .and_then(|meta| meta.provider_type.as_deref())
        == Some("github_copilot")
        || provider
            .settings_config
            .pointer("/env/ANTHROPIC_BASE_URL")
            .and_then(|value| value.as_str())
            .map(|url| url.contains("githubcopilot.com"))
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::is_copilot_provider;
    use crate::provider::{Provider, ProviderMeta};
    use serde_json::json;

    #[test]
    fn copilot_provider_detection_accepts_provider_type_or_base_url() {
        let typed_provider = Provider {
            id: "p1".to_string(),
            name: "typed".to_string(),
            settings_config: json!({}),
            website_url: None,
            category: None,
            created_at: None,
            sort_index: None,
            notes: None,
            meta: Some(ProviderMeta {
                provider_type: Some("github_copilot".to_string()),
                ..Default::default()
            }),
            icon: None,
            icon_color: None,
            in_failover_queue: false,
        };
        assert!(is_copilot_provider(&typed_provider));

        let url_provider = Provider {
            id: "p2".to_string(),
            name: "url".to_string(),
            settings_config: json!({
                "env": {
                    "ANTHROPIC_BASE_URL": "https://api.githubcopilot.com"
                }
            }),
            website_url: None,
            category: None,
            created_at: None,
            sort_index: None,
            notes: None,
            meta: None,
            icon: None,
            icon_color: None,
            in_failover_queue: false,
        };
        assert!(is_copilot_provider(&url_provider));
    }

    #[test]
    fn copilot_full_url_metadata_is_available_for_override_guard() {
        let provider = Provider {
            id: "p3".to_string(),
            name: "relay".to_string(),
            settings_config: json!({}),
            website_url: None,
            category: None,
            created_at: None,
            sort_index: None,
            notes: None,
            meta: Some(ProviderMeta {
                provider_type: Some("github_copilot".to_string()),
                is_full_url: Some(true),
                ..Default::default()
            }),
            icon: None,
            icon_color: None,
            in_failover_queue: false,
        };

        assert!(is_copilot_provider(&provider));
        assert_eq!(
            provider.meta.as_ref().and_then(|meta| meta.is_full_url),
            Some(true)
        );
    }
}
