//! 错误类型到 HTTP 状态码的映射
//!
//! 将 ProxyError 映射到合适的 HTTP 状态码，用于日志记录和手动构建错误响应

use super::ProxyError;

const OPENCODE_ZEN_FREE_TIER_GUIDANCE: &str = concat!(
    "OpenCode Zen rejected this free-tier model because Zen free models are restricted ",
    "to the official OpenCode client. Changing User-Agent or session headers cannot ",
    "grant access. Use a paid Zen model through https://opencode.ai/zen/v1 with a Zen ",
    "API key, or run this free model in the official OpenCode client."
);

/// Return actionable guidance for upstream errors whose raw text otherwise
/// encourages users to keep retrying an unsupported client configuration.
pub fn actionable_upstream_error_message(status: u16, body: Option<&str>) -> Option<String> {
    if status != 403 {
        return None;
    }

    let normalized = body?.to_ascii_lowercase();
    let is_zen_free_tier_rejection = normalized.contains("opencode")
        && normalized.contains("free tier")
        && normalized.contains("only be used")
        && (normalized.contains("within opencode") || normalized.contains("in opencode"));

    is_zen_free_tier_rejection.then(|| OPENCODE_ZEN_FREE_TIER_GUIDANCE.to_string())
}

/// 将 ProxyError 映射到 HTTP 状态码
///
/// 映射规则：
/// - 上游错误：直接使用上游返回的状态码
/// - 超时：504 Gateway Timeout
/// - 连接失败：502 Bad Gateway
/// - 无可用 Provider：503 Service Unavailable
/// - 重试耗尽：503 Service Unavailable
/// - 认证错误：401 Unauthorized
/// - 配置/请求错误：400 Bad Request
/// - 转换错误：422 Unprocessable Entity
/// - 其他错误：500 Internal Server Error
pub fn map_proxy_error_to_status(error: &ProxyError) -> u16 {
    match error {
        // 服务状态错误：与 IntoResponse 保持一致
        ProxyError::AlreadyRunning => 409,
        ProxyError::NotRunning => 503,

        // 上游错误：使用实际状态码
        ProxyError::UpstreamError { status, .. } => *status,

        // 超时错误：504 Gateway Timeout
        ProxyError::Timeout(_) | ProxyError::StreamIdleTimeout(_) => 504,

        // 请求可能已到达上游但结果未知：不是限流，也不能诱导客户端自动重放。
        ProxyError::ResponsePending(_) => 424,

        // 转发失败/连接失败：502 Bad Gateway
        ProxyError::ForwardFailed(_) => 502,

        // 无可用 Provider：503 Service Unavailable
        ProxyError::NoAvailableProvider => 503,

        // 所有供应商已熔断：503 Service Unavailable
        ProxyError::AllProvidersCircuitOpen => 503,

        // Codex admission queue saturation: the request was not dispatched.
        ProxyError::AdmissionQueueTimeout { .. } => 429,

        // 未配置供应商：503 Service Unavailable
        ProxyError::NoProvidersConfigured => 503,

        // 重试耗尽：503 Service Unavailable
        ProxyError::MaxRetriesExceeded => 503,

        // Provider 不健康：503 Service Unavailable
        ProxyError::ProviderUnhealthy(_) => 503,

        // 配置错误/无效请求：400 Bad Request
        ProxyError::ConfigError(_) | ProxyError::InvalidRequest(_) => 400,

        // 认证错误：401 Unauthorized
        ProxyError::AuthError(_) => 401,

        // 数据库错误：500 Internal Server Error
        ProxyError::DatabaseError(_) => 500,

        // 转换错误：422 Unprocessable Entity
        ProxyError::TransformError(_) => 422,

        // 其他未知错误：500 Internal Server Error
        _ => 500,
    }
}

/// 将 ProxyError 转换为用户友好的错误消息
pub fn get_error_message(error: &ProxyError) -> String {
    match error {
        ProxyError::UpstreamError { status, body } => {
            if let Some(message) = actionable_upstream_error_message(*status, body.as_deref()) {
                return message;
            }
            if let Some(body) = body
                .as_deref()
                .map(str::trim)
                .filter(|body| !body.is_empty())
            {
                format!("上游错误 ({status}): {body}")
            } else {
                format!("上游错误 ({status})")
            }
        }
        ProxyError::Timeout(msg) => format!("请求超时: {msg}"),
        ProxyError::ResponsePending(msg) => format!("上游请求可能仍在处理中: {msg}"),
        ProxyError::ForwardFailed(msg) => format!("转发失败: {msg}"),
        // 这条消息是用户唯一能看到的“为什么这次请求根本没发出去”。旧的
        // “无可用 Provider”既像配置错误又没有任何可操作信息：候选为空可能是
        // 账号池全部不可用，也可能是全部候选被熔断器拒绝。
        ProxyError::NoAvailableProvider => {
            "无可用 Provider（没有可尝试的上游候选：账号池全部不可用或全部被熔断拒绝）".to_string()
        }
        ProxyError::AllProvidersCircuitOpen => "所有供应商已熔断，无可用渠道".to_string(),
        ProxyError::NoProvidersConfigured => "未配置供应商".to_string(),
        ProxyError::MaxRetriesExceeded => "所有 Provider 都失败，重试耗尽".to_string(),
        ProxyError::ProviderUnhealthy(msg) => format!("Provider 不健康: {msg}"),
        ProxyError::DatabaseError(msg) => format!("数据库错误: {msg}"),
        ProxyError::TransformError(msg) => format!("请求/响应转换错误: {msg}"),
        _ => error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_map_upstream_error() {
        let error = ProxyError::UpstreamError {
            status: 401,
            body: Some("Unauthorized".to_string()),
        };
        assert_eq!(map_proxy_error_to_status(&error), 401);
    }

    #[test]
    fn test_map_timeout_error() {
        let error = ProxyError::Timeout("Request timeout".to_string());
        assert_eq!(map_proxy_error_to_status(&error), 504);
    }

    #[test]
    fn test_map_response_pending_error() {
        let error = ProxyError::ResponsePending("model is still reasoning".to_string());
        assert_eq!(map_proxy_error_to_status(&error), 424);
        assert_eq!(error.retry_after_secs(), None);
    }

    #[test]
    fn test_map_connection_error() {
        let error = ProxyError::ForwardFailed("Connection refused".to_string());
        assert_eq!(map_proxy_error_to_status(&error), 502);
    }

    #[test]
    fn test_map_no_provider_error() {
        let error = ProxyError::NoAvailableProvider;
        assert_eq!(map_proxy_error_to_status(&error), 503);
    }

    #[test]
    fn admission_timeout_is_retryable_client_saturation() {
        let error = ProxyError::AdmissionQueueTimeout {
            provider_id: "zen".to_string(),
            max_in_flight: 4,
            waited_ms: 30_000,
        };
        assert_eq!(map_proxy_error_to_status(&error), 429);
        assert_eq!(error.retry_after_secs(), Some(1));
    }

    #[test]
    fn test_map_status_matches_proxy_error_response_semantics() {
        assert_eq!(
            map_proxy_error_to_status(&ProxyError::AuthError("bad token".to_string())),
            401
        );
        assert_eq!(
            map_proxy_error_to_status(&ProxyError::ConfigError("bad config".to_string())),
            400
        );
        assert_eq!(
            map_proxy_error_to_status(&ProxyError::InvalidRequest("bad request".to_string())),
            400
        );
        assert_eq!(
            map_proxy_error_to_status(&ProxyError::TransformError("bad transform".to_string())),
            422
        );
        assert_eq!(
            map_proxy_error_to_status(&ProxyError::StreamIdleTimeout(30)),
            504
        );
    }

    #[test]
    fn test_get_error_message() {
        let error = ProxyError::UpstreamError {
            status: 500,
            body: Some("Internal Server Error".to_string()),
        };
        let msg = get_error_message(&error);
        assert!(msg.contains("上游错误"));
        assert!(msg.contains("500"));
        assert!(msg.contains("Internal Server Error"));
    }

    #[test]
    fn empty_upstream_error_body_does_not_render_a_dangling_cause_separator() {
        for body in [Some(String::new()), Some("   ".to_string()), None] {
            assert_eq!(
                get_error_message(&ProxyError::UpstreamError { status: 502, body }),
                "上游错误 (502)"
            );
        }
    }

    #[test]
    fn opencode_zen_free_tier_rejection_has_actionable_guidance() {
        let body = r#"{"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode"}"#;
        let error = ProxyError::UpstreamError {
            status: 403,
            body: Some(body.to_string()),
        };

        let message = get_error_message(&error);
        assert!(message.contains("official OpenCode client"));
        assert!(message.contains("Changing User-Agent or session headers cannot grant access"));
        assert!(message.contains("https://opencode.ai/zen/v1"));
        assert!(!message.contains("FreeTierError"));
    }

    #[test]
    fn similar_non_403_error_keeps_the_upstream_body() {
        let body = "OpenCode's free tier can only be used from within OpenCode";
        let message = get_error_message(&ProxyError::UpstreamError {
            status: 429,
            body: Some(body.to_string()),
        });

        assert!(message.contains("上游错误 (429)"));
        assert!(message.contains(body));
    }
}
