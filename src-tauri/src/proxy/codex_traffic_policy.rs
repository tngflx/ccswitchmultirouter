//! Runtime resolution for provider-specific Codex admission and rejection retry policy.
//!
//! Unknown providers get conservative protocol-safe behavior only: bounded HTTP 429
//! retry remains available, but local admission limiting and provider-specific HTTP 503
//! replay are disabled until configured. OpenCode Zen has a maintained recommendation
//! based on live load tests; persisted provider metadata can override every value.

use crate::provider::{CodexRejectionRetryMode, Provider};
use std::time::Duration;

pub(crate) const MIN_MAX_IN_FLIGHT: usize = 1;
pub(crate) const MAX_MAX_IN_FLIGHT: usize = 64;
pub(crate) const MIN_QUEUE_WAIT_MS: u64 = 100;
pub(crate) const MAX_QUEUE_WAIT_MS: u64 = 300_000;
pub(crate) const DEFAULT_QUEUE_WAIT_MS: u64 = 30_000;
pub(crate) const MAX_RETRIES: usize = 5;
pub(crate) const MIN_RETRY_DELAY_MS: u64 = 100;
pub(crate) const MAX_RETRY_DELAY_MS: u64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CodexTrafficPolicySource {
    SafeDefault,
    MaintainedRecommendation,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedCodexTrafficPolicy {
    pub source: CodexTrafficPolicySource,
    pub admission_enabled: bool,
    pub max_in_flight: usize,
    pub max_queue_wait: Duration,
    pub rate_limit_max_retries: usize,
    pub rejection_retry_mode: CodexRejectionRetryMode,
    pub rejection_max_retries: usize,
    pub rejection_initial_delay: Duration,
    pub rejection_max_delay: Duration,
    pub admission_key: String,
}

impl ResolvedCodexTrafficPolicy {
    pub(crate) fn rejection_backoff(&self, retry_count: usize) -> Duration {
        let multiplier = 1u32 << retry_count.min(5);
        self.rejection_initial_delay
            .saturating_mul(multiplier)
            .min(self.rejection_max_delay)
    }
}

pub(crate) fn codex_provider_base_url(provider: &Provider) -> Option<String> {
    provider
        .settings_config
        .get("config")
        .and_then(|value| value.as_str())
        .and_then(crate::codex_config::extract_codex_base_url)
        .or_else(|| {
            provider
                .settings_config
                .get("base_url")
                .or_else(|| provider.settings_config.get("baseUrl"))
                .or_else(|| provider.settings_config.get("baseURL"))
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned)
        })
        .map(|value| value.trim().trim_end_matches('/').to_ascii_lowercase())
        .filter(|value| !value.is_empty())
}

pub(crate) fn resolve_codex_traffic_policy(provider: &Provider) -> ResolvedCodexTrafficPolicy {
    let base_url = codex_provider_base_url(provider);
    let is_zen = base_url
        .as_deref()
        .is_some_and(|value| value.contains("opencode.ai/zen/go"));
    let explicit = provider
        .meta
        .as_ref()
        .and_then(|meta| meta.codex_traffic_policy.as_ref());

    let (
        default_admission_enabled,
        default_max_in_flight,
        default_rejection_mode,
        default_rejection_retries,
        default_rejection_initial_ms,
        default_rejection_max_ms,
    ) = if is_zen {
        (
            true,
            4usize,
            CodexRejectionRetryMode::OpencodeEndpointUnavailable,
            2usize,
            750u64,
            5_000u64,
        )
    } else {
        (
            false,
            8usize,
            CodexRejectionRetryMode::Disabled,
            0usize,
            750u64,
            5_000u64,
        )
    };

    let clamp_retries = |value: usize| value.min(MAX_RETRIES);
    let clamp_delay = |value: u64| value.clamp(MIN_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS);
    let rejection_retry_mode = explicit
        .and_then(|policy| policy.rejection_retry_mode)
        .unwrap_or(default_rejection_mode);
    let rejection_max_retries = if rejection_retry_mode == CodexRejectionRetryMode::Disabled {
        0
    } else {
        clamp_retries(
            explicit
                .and_then(|policy| policy.rejection_max_retries)
                .map(usize::from)
                .unwrap_or(default_rejection_retries),
        )
    };

    ResolvedCodexTrafficPolicy {
        source: if explicit.is_some() {
            CodexTrafficPolicySource::Custom
        } else if is_zen {
            CodexTrafficPolicySource::MaintainedRecommendation
        } else {
            CodexTrafficPolicySource::SafeDefault
        },
        admission_enabled: explicit
            .and_then(|policy| policy.admission_enabled)
            .unwrap_or(default_admission_enabled),
        max_in_flight: explicit
            .and_then(|policy| policy.max_in_flight)
            .map(usize::from)
            .unwrap_or(default_max_in_flight)
            .clamp(MIN_MAX_IN_FLIGHT, MAX_MAX_IN_FLIGHT),
        max_queue_wait: Duration::from_millis(
            explicit
                .and_then(|policy| policy.max_queue_wait_ms)
                .unwrap_or(DEFAULT_QUEUE_WAIT_MS)
                .clamp(MIN_QUEUE_WAIT_MS, MAX_QUEUE_WAIT_MS),
        ),
        rate_limit_max_retries: clamp_retries(
            explicit
                .and_then(|policy| policy.rate_limit_max_retries)
                .map(usize::from)
                .unwrap_or(5),
        ),
        rejection_retry_mode,
        rejection_max_retries,
        rejection_initial_delay: Duration::from_millis(clamp_delay(
            explicit
                .and_then(|policy| policy.rejection_initial_delay_ms)
                .unwrap_or(default_rejection_initial_ms),
        )),
        rejection_max_delay: Duration::from_millis(clamp_delay(
            explicit
                .and_then(|policy| policy.rejection_max_delay_ms)
                .unwrap_or(default_rejection_max_ms),
        )),
        admission_key: super::providers::codex_route_target_provider_id(provider)
            .unwrap_or(provider.id.as_str())
            .trim()
            .to_ascii_lowercase(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{CodexTrafficPolicy, ProviderMeta};
    use serde_json::json;

    fn provider(id: &str, base_url: &str, policy: Option<CodexTrafficPolicy>) -> Provider {
        let mut provider = Provider::with_id(
            id.to_string(),
            id.to_string(),
            json!({"base_url": base_url}),
            None,
        );
        provider.meta = policy.map(|policy| ProviderMeta {
            codex_traffic_policy: Some(policy),
            ..ProviderMeta::default()
        });
        provider
    }

    #[test]
    fn unknown_provider_uses_safe_non_503_default() {
        let resolved =
            resolve_codex_traffic_policy(&provider("unknown", "https://example.test/v1", None));
        assert_eq!(resolved.source, CodexTrafficPolicySource::SafeDefault);
        assert!(!resolved.admission_enabled);
        assert_eq!(resolved.rate_limit_max_retries, 5);
        assert_eq!(
            resolved.rejection_retry_mode,
            CodexRejectionRetryMode::Disabled
        );
        assert_eq!(resolved.rejection_max_retries, 0);
    }

    #[test]
    fn zen_gets_visible_maintained_recommendation() {
        let resolved =
            resolve_codex_traffic_policy(&provider("zen", "https://opencode.ai/zen/go/v1/", None));
        assert_eq!(
            resolved.source,
            CodexTrafficPolicySource::MaintainedRecommendation
        );
        assert!(resolved.admission_enabled);
        assert_eq!(resolved.max_in_flight, 4);
        assert_eq!(
            resolved.rejection_retry_mode,
            CodexRejectionRetryMode::OpencodeEndpointUnavailable
        );
        assert_eq!(resolved.rejection_max_retries, 2);
    }

    #[test]
    fn explicit_policy_overrides_and_clamps_all_operational_values() {
        let resolved = resolve_codex_traffic_policy(&provider(
            "custom",
            "https://example.test/v1",
            Some(CodexTrafficPolicy {
                admission_enabled: Some(true),
                max_in_flight: Some(u16::MAX),
                max_queue_wait_ms: Some(u64::MAX),
                rate_limit_max_retries: Some(u8::MAX),
                rejection_retry_mode: Some(CodexRejectionRetryMode::OpencodeEndpointUnavailable),
                rejection_max_retries: Some(u8::MAX),
                rejection_initial_delay_ms: Some(1),
                rejection_max_delay_ms: Some(u64::MAX),
            }),
        ));
        assert_eq!(resolved.source, CodexTrafficPolicySource::Custom);
        assert!(resolved.admission_enabled);
        assert_eq!(resolved.max_in_flight, MAX_MAX_IN_FLIGHT);
        assert_eq!(
            resolved.max_queue_wait,
            Duration::from_millis(MAX_QUEUE_WAIT_MS)
        );
        assert_eq!(resolved.rate_limit_max_retries, MAX_RETRIES);
        assert_eq!(resolved.rejection_max_retries, MAX_RETRIES);
        assert_eq!(resolved.rejection_initial_delay, Duration::from_millis(100));
        assert_eq!(resolved.rejection_max_delay, Duration::from_secs(60));
    }

    #[test]
    fn disabling_rejection_mode_forces_zero_replays() {
        let resolved = resolve_codex_traffic_policy(&provider(
            "zen-custom",
            "https://opencode.ai/zen/go/v1",
            Some(CodexTrafficPolicy {
                rejection_retry_mode: Some(CodexRejectionRetryMode::Disabled),
                rejection_max_retries: Some(5),
                ..CodexTrafficPolicy::default()
            }),
        ));
        assert_eq!(
            resolved.rejection_retry_mode,
            CodexRejectionRetryMode::Disabled
        );
        assert_eq!(resolved.rejection_max_retries, 0);
    }
}
