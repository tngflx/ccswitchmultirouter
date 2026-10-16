use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

use crate::app_config::AppType;
use crate::error::AppError;
use crate::services::preset_registry::PresetRegistrySettings;
use crate::services::skill::{SkillStorageLocation, SyncMethod};

/// 自定义端点配置（历史兼容，实际存储在 provider.meta.custom_endpoints）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomEndpoint {
    pub url: String,
    pub added_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used: Option<i64>,
}

fn default_true() -> bool {
    true
}

fn default_stream_retry_max_attempts() -> u32 {
    3
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StreamRetryMode {
    Off,
    Safe,
    Aggressive,
}

fn default_stream_retry_mode() -> StreamRetryMode {
    StreamRetryMode::Safe
}

fn default_large_request_threshold_bytes() -> u32 {
    384 * 1024
}

fn default_max_codex_input_tokens() -> u32 {
    200_000
}

fn default_request_health_review_timeout_seconds() -> u32 {
    60
}

fn default_request_health_notification_snooze_hours() -> u32 {
    4
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RequestOptimizationMode {
    Off,
    Diagnose,
    #[default]
    Safe,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RequestHealthReviewMode {
    Off,
    #[default]
    FirstLargeRequest,
    SustainedGrowth,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RequestHealthConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub optimization_mode: RequestOptimizationMode,
    #[serde(default = "default_large_request_threshold_bytes")]
    pub large_request_threshold_bytes: u32,
    #[serde(default = "default_max_codex_input_tokens")]
    pub max_codex_input_tokens: u32,
    #[serde(default = "default_request_health_review_timeout_seconds")]
    pub review_timeout_seconds: u32,
    #[serde(default)]
    pub review_mode: RequestHealthReviewMode,
    #[serde(default = "default_true", alias = "compactAndRestartEnabled")]
    pub summarize_and_restart_enabled: bool,
    #[serde(default = "default_true")]
    pub windows_notifications_enabled: bool,
    #[serde(default = "default_request_health_notification_snooze_hours")]
    pub windows_notification_snooze_hours: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub windows_notifications_snoozed_until_ms: Option<i64>,
}

impl Default for RequestHealthConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            optimization_mode: RequestOptimizationMode::Safe,
            large_request_threshold_bytes: default_large_request_threshold_bytes(),
            max_codex_input_tokens: default_max_codex_input_tokens(),
            review_timeout_seconds: default_request_health_review_timeout_seconds(),
            review_mode: RequestHealthReviewMode::FirstLargeRequest,
            summarize_and_restart_enabled: true,
            windows_notifications_enabled: true,
            windows_notification_snooze_hours: default_request_health_notification_snooze_hours(),
            windows_notifications_snoozed_until_ms: None,
        }
    }
}

/// 主页面显示的应用配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibleApps {
    #[serde(default = "default_true")]
    pub claude: bool,
    #[serde(
        rename = "claude-desktop",
        alias = "claudeDesktop",
        alias = "claude_desktop",
        default = "default_true"
    )]
    pub claude_desktop: bool,
    #[serde(default = "default_true")]
    pub codex: bool,
    #[serde(default = "default_true")]
    pub gemini: bool,
    #[serde(default = "default_true")]
    pub grokbuild: bool,
    #[serde(default = "default_true")]
    pub opencode: bool,
    #[serde(default = "default_true")]
    pub openclaw: bool,
    #[serde(default)]
    pub hermes: bool,
    #[serde(default = "default_true")]
    pub pi: bool,
}

impl Default for VisibleApps {
    fn default() -> Self {
        Self {
            claude: true,
            claude_desktop: true,
            codex: true,
            gemini: true,
            grokbuild: true,
            opencode: true,
            openclaw: true,
            hermes: false, // 默认不显示，需用户手动启用
            pi: true,
        }
    }
}

impl VisibleApps {
    /// Check if the specified app is visible
    pub fn is_visible(&self, app: &AppType) -> bool {
        match app {
            AppType::Claude => self.claude,
            AppType::ClaudeDesktop => self.claude_desktop,
            AppType::Codex => self.codex,
            AppType::Gemini => self.gemini,
            AppType::GrokBuild => self.grokbuild,
            AppType::OpenCode => self.opencode,
            AppType::OpenClaw => self.openclaw,
            AppType::Hermes => self.hermes,
            AppType::Pi => self.pi,
        }
    }
}

/// WebDAV 同步状态（持久化同步进度信息）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebDavSyncStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_remote_etag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_local_manifest_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_remote_manifest_hash: Option<String>,
}

fn default_remote_root() -> String {
    "cc-switch-sync".to_string()
}
fn default_profile() -> String {
    "default".to_string()
}

/// WebDAV 同步设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavSyncSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub auto_sync: bool,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default = "default_remote_root")]
    pub remote_root: String,
    #[serde(default = "default_profile")]
    pub profile: String,
    #[serde(default = "default_true")]
    pub include_keys_on_upload: bool,
    #[serde(default)]
    pub status: WebDavSyncStatus,
}

impl Default for WebDavSyncSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            auto_sync: false,
            base_url: String::new(),
            username: String::new(),
            password: String::new(),
            remote_root: default_remote_root(),
            profile: default_profile(),
            include_keys_on_upload: true,
            status: WebDavSyncStatus::default(),
        }
    }
}

impl WebDavSyncSettings {
    pub fn validate(&self) -> Result<(), crate::error::AppError> {
        if self.base_url.trim().is_empty() {
            return Err(crate::error::AppError::localized(
                "webdav.base_url.required",
                "WebDAV 地址不能为空",
                "WebDAV URL is required.",
            ));
        }
        if self.username.trim().is_empty() {
            return Err(crate::error::AppError::localized(
                "webdav.username.required",
                "WebDAV 用户名不能为空",
                "WebDAV username is required.",
            ));
        }
        Ok(())
    }

    pub fn normalize(&mut self) {
        self.base_url = self.base_url.trim().to_string();
        self.username = self.username.trim().to_string();
        self.remote_root = self.remote_root.trim().to_string();
        self.profile = self.profile.trim().to_string();
        if self.remote_root.is_empty() {
            self.remote_root = default_remote_root();
        }
        if self.profile.is_empty() {
            self.profile = default_profile();
        }
    }

    /// Returns true if all credential fields are blank (no config to persist).
    fn is_empty(&self) -> bool {
        self.base_url.is_empty() && self.username.is_empty() && self.password.is_empty()
    }
}

/// S3 同步设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3SyncSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub auto_sync: bool,
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub bucket: String,
    #[serde(default)]
    pub access_key_id: String,
    #[serde(default)]
    pub secret_access_key: String,
    #[serde(default)]
    pub endpoint: String,
    #[serde(default = "default_remote_root")]
    pub remote_root: String,
    #[serde(default = "default_profile")]
    pub profile: String,
    #[serde(default = "default_true")]
    pub include_keys_on_upload: bool,
    #[serde(default)]
    pub status: WebDavSyncStatus,
}

impl Default for S3SyncSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            auto_sync: false,
            region: String::new(),
            bucket: String::new(),
            access_key_id: String::new(),
            secret_access_key: String::new(),
            endpoint: String::new(),
            remote_root: default_remote_root(),
            profile: default_profile(),
            include_keys_on_upload: true,
            status: WebDavSyncStatus::default(),
        }
    }
}

impl S3SyncSettings {
    pub fn validate(&self) -> Result<(), crate::error::AppError> {
        if self.bucket.trim().is_empty() {
            return Err(crate::error::AppError::localized(
                "s3.bucket.required",
                "S3 存储桶不能为空",
                "S3 bucket is required.",
            ));
        }
        if self.region.trim().is_empty() {
            return Err(crate::error::AppError::localized(
                "s3.region.required",
                "S3 区域不能为空",
                "S3 region is required.",
            ));
        }
        if self.access_key_id.trim().is_empty() {
            return Err(crate::error::AppError::localized(
                "s3.access_key_id.required",
                "S3 Access Key ID 不能为空",
                "S3 Access Key ID is required.",
            ));
        }
        if self.secret_access_key.trim().is_empty() {
            return Err(crate::error::AppError::localized(
                "s3.secret_access_key.required",
                "S3 Secret Access Key 不能为空",
                "S3 Secret Access Key is required.",
            ));
        }
        Ok(())
    }

    pub fn normalize(&mut self) {
        self.region = self.region.trim().to_string();
        self.bucket = self.bucket.trim().to_string();
        self.access_key_id = self.access_key_id.trim().to_string();
        self.endpoint = self.endpoint.trim().to_string();
        self.remote_root = self.remote_root.trim().to_string();
        self.profile = self.profile.trim().to_string();
        if self.remote_root.is_empty() {
            self.remote_root = default_remote_root();
        }
        if self.profile.is_empty() {
            self.profile = default_profile();
        }
    }

    /// Returns true if all credential fields are blank (no config to persist).
    fn is_empty(&self) -> bool {
        self.bucket.is_empty()
            && self.region.is_empty()
            && self.access_key_id.is_empty()
            && self.secret_access_key.is_empty()
    }
}

/// 本机自动迁移状态。
///
/// 这里记录的是本机启动时执行过的一次性迁移；标记不随数据库同步。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalMigrations {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_third_party_history_provider_bucket_v1:
        Option<CodexThirdPartyHistoryProviderBucketMigration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_openai_history_provider_bucket_v2:
        Option<CodexThirdPartyHistoryProviderBucketMigration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_provider_template_v1: Option<CodexProviderTemplateMigration>,
    /// 统一会话开关的官方历史迁移标记。开关关闭时会被清除，
    /// 这样重新开启能把"关闭期间"落入 openai 桶的官方会话补迁进来。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_official_history_unify_v1: Option<CodexOfficialHistoryUnifyMigration>,
}

/// 多设备额度协作的本机策略与网关约束缓存。
///
/// 该结构保留在每台设备自己的 settings 文件中；远端只交换脱敏聚合报告，
/// 不会同步登录凭据、提示词、原始会话或本机目录。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaCollaborationSettings {
    #[serde(default = "default_quota_collaboration_device_id")]
    pub device_id: String,
    #[serde(default)]
    pub device_name: String,
    #[serde(default = "default_quota_collaboration_mode")]
    pub mode: String,
    #[serde(default = "default_quota_collaboration_threshold")]
    pub enforce_remaining_percent: f64,
    #[serde(default)]
    pub latest_window_utilization: std::collections::BTreeMap<String, f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_window_captured_at: Option<i64>,
}

fn default_quota_collaboration_device_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn default_quota_collaboration_mode() -> String {
    "observe".to_string()
}

fn default_quota_collaboration_threshold() -> f64 {
    20.0
}

impl Default for QuotaCollaborationSettings {
    fn default() -> Self {
        Self {
            device_id: default_quota_collaboration_device_id(),
            device_name: String::new(),
            mode: default_quota_collaboration_mode(),
            enforce_remaining_percent: default_quota_collaboration_threshold(),
            latest_window_utilization: std::collections::BTreeMap::new(),
            latest_window_captured_at: None,
        }
    }
}

impl QuotaCollaborationSettings {
    /// 规范化手工编辑或旧版本遗留的字段，避免异常设置阻断网关。
    fn normalize(&mut self) {
        self.device_id = self.device_id.trim().to_string();
        if self.device_id.is_empty() {
            self.device_id = default_quota_collaboration_device_id();
        }
        self.device_name = self.device_name.trim().to_string();
        if self.mode != "enforce" {
            self.mode = default_quota_collaboration_mode();
        }
        self.enforce_remaining_percent = self.enforce_remaining_percent.clamp(1.0, 90.0);
        self.latest_window_utilization
            .retain(|_, value| value.is_finite() && (0.0..=100.0).contains(value));
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexThirdPartyHistoryProviderBucketMigration {
    pub completed_at: String,
    pub target_provider_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_provider_ids: Vec<String>,
    #[serde(default)]
    pub migrated_jsonl_files: usize,
    #[serde(default)]
    pub migrated_state_rows: usize,
    #[serde(default)]
    pub scanned_history_files: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProviderTemplateMigration {
    pub completed_at: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub migrated_provider_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexOfficialHistoryUnifyMigration {
    pub completed_at: String,
    pub target_provider_id: String,
    #[serde(default)]
    pub migrated_jsonl_files: usize,
    #[serde(default)]
    pub migrated_state_rows: usize,
    /// 迁移时的规范化 Codex 目录。标记只对同一目录生效：
    /// 切换 codex_config_dir 后旧标记不会挡住新目录的迁移。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_config_dir: Option<String>,
}

/// 应用设置结构
///
/// 存储设备级别设置，保存在本地 `~/.cc-switch/settings.json`，不随数据库同步。
/// 这确保了云同步场景下多设备可以独立运作。
#[derive(Debug, Clone, Copy, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexEgressTimezoneMode {
    #[default]
    Off,
    Auto,
    Manual,
}

/// Codex Desktop 进程级出口时区设置。
///
/// 仅在 CCSwitchMulti 启动 Codex 时通过子进程 `TZ` 环境变量生效，不会修改
/// Windows 系统时区。`auto` 使用后台监测到的最新 IANA 时区；监测失败不会
/// 阻塞 Codex 请求或启动。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexEgressTimezoneSettings {
    #[serde(default)]
    pub mode: CodexEgressTimezoneMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manual_timezone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detected_timezone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detected_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detected_egress_ip: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detected_country_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detected_region: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detected_city: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detected_colo: Option<String>,
    #[serde(default = "default_codex_egress_monitor_interval_minutes")]
    pub monitor_interval_minutes: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_probe_trigger: Option<String>,
    /// 最近一次由 CCSM 启动 Codex 时实际注入的进程时区。该字段由后端维护，
    /// 用于区分“已经探测到新出口”与“运行中的 Codex 已经应用新时区”。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_applied_timezone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_applied_at: Option<i64>,
}

fn default_codex_egress_monitor_interval_minutes() -> u32 {
    15
}

impl Default for CodexEgressTimezoneSettings {
    fn default() -> Self {
        Self {
            mode: CodexEgressTimezoneMode::Off,
            manual_timezone: None,
            detected_timezone: None,
            detected_at: None,
            detected_egress_ip: None,
            detected_country_code: None,
            detected_region: None,
            detected_city: None,
            detected_colo: None,
            monitor_interval_minutes: default_codex_egress_monitor_interval_minutes(),
            last_probe_trigger: None,
            last_applied_timezone: None,
            last_applied_at: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    // ===== 设备级 UI 设置 =====
    #[serde(default = "default_show_in_tray")]
    pub show_in_tray: bool,
    #[serde(default = "default_minimize_to_tray_on_close")]
    pub minimize_to_tray_on_close: bool,
    #[serde(default)]
    pub use_app_window_controls: bool,
    /// 是否启用 Claude 插件联动
    #[serde(default)]
    pub enable_claude_plugin_integration: bool,
    /// 是否跳过 Claude Code 初次安装确认
    #[serde(default)]
    pub skip_claude_onboarding: bool,
    /// 是否开机自启
    #[serde(default)]
    pub launch_on_startup: bool,
    /// 是否在 CCSwitchMulti 启动后启动 Codex Desktop。
    ///
    /// 这是独立于系统开机自启的显式选择：仅开启 `launch_on_startup`
    /// 绝不会拉起 Codex Desktop。
    #[serde(default)]
    pub launch_codex_desktop_with_ccswitch: bool,
    /// Device-local, opt-in updates of installed CLIs at application startup.
    #[serde(default)]
    pub tool_auto_update: HashMap<String, bool>,
    /// Preserve the preference written by the original Codex-only feature.
    #[serde(default)]
    pub auto_update_codex_cli: bool,
    /// Optional, process-local timezone injection for Codex Desktop.
    #[serde(default)]
    pub codex_egress_timezone: CodexEgressTimezoneSettings,
    /// 是否启用内置看门狗（supervisor）：同一二进制以守护模式盯住主进程，
    /// 主进程异常退出后自动拉起。跨平台，不需要计划任务或脚本。
    #[serde(default = "default_watchdog_enabled")]
    pub watchdog_enabled: bool,
    /// 静默启动（程序启动时不显示主窗口，仅托盘运行）
    #[serde(default)]
    pub silent_startup: bool,
    /// 是否在主页面启用本地代理功能（默认关闭）
    #[serde(default)]
    pub enable_local_proxy: bool,
    /// User has confirmed the local proxy first-run notice
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_confirmed: Option<bool>,
    /// User has confirmed the usage query first-run notice
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_confirmed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_dashboard_refresh_interval_ms: Option<u32>,
    /// Whether to show the failover toggle independently on the main page
    #[serde(default)]
    pub enable_failover_toggle: bool,
    /// Legacy compatibility switch. New UI writes `stream_retry_mode`; false maps to Off.
    #[serde(default = "default_true")]
    pub enable_stream_retry: bool,
    /// Proxy stream recovery policy: off, safe, or aggressive.
    #[serde(default = "default_stream_retry_mode")]
    pub stream_retry_mode: StreamRetryMode,
    /// Maximum aggressive recovery attempts after the original request (1..=3).
    #[serde(default = "default_stream_retry_max_attempts")]
    pub stream_retry_max_attempts: u32,
    /// Provider-neutral request size diagnostics and conservative JSON cleanup.
    #[serde(default)]
    pub request_health: RequestHealthConfig,
    /// Whether to show the project profile switcher on the main page header
    #[serde(default = "default_show_profile_switcher")]
    pub show_profile_switcher: bool,
    /// Keep Codex ChatGPT login material in auth.json when switching to third-party providers.
    /// Opt-in: defaults to false so third-party switches cleanly overwrite auth.json.
    #[serde(default)]
    pub preserve_codex_official_auth_on_switch: bool,
    /// Run official Codex providers under the shared "custom" model_provider id
    /// so official sessions share one resume-history bucket with third-party
    /// providers. Opt-in: defaults to false.
    #[serde(default)]
    pub unify_codex_session_history: bool,
    /// User opted in (via the enable dialog checkbox) to migrate existing
    /// official sessions ("openai" bucket) into the shared bucket. Persisted so
    /// a failed migration retries at startup; cleared when the toggle turns off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unify_codex_migrate_existing: Option<bool>,
    /// User has confirmed the failover toggle first-run notice
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failover_confirmed: Option<bool>,
    /// User has confirmed the first-run welcome notice
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_run_notice_confirmed: Option<bool>,
    /// User has confirmed the common config first-run notice
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub common_config_confirmed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,

    // ===== 主页面显示的应用 =====
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_apps: Option<VisibleApps>,

    // ===== 设备级目录覆盖 =====
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_config_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_config_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gemini_config_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grok_config_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opencode_config_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openclaw_config_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hermes_config_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pi_config_dir: Option<String>,

    // ===== 当前供应商 ID（设备级）=====
    /// 当前 Claude 供应商 ID（本地存储，优先于数据库 is_current）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_provider_claude: Option<String>,
    /// 当前 Claude Desktop 供应商 ID（本地存储，优先于数据库 is_current）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_provider_claude_desktop: Option<String>,
    /// 当前 Codex 供应商 ID（本地存储，优先于数据库 is_current）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_provider_codex: Option<String>,
    /// 当前 Gemini 供应商 ID（本地存储，优先于数据库 is_current）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_provider_gemini: Option<String>,
    /// 当前 Grok Build 供应商 ID（本地存储，优先于数据库 is_current）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_provider_grokbuild: Option<String>,
    /// 当前 OpenCode 供应商 ID（本地存储，对 OpenCode 可能无意义，但保持结构一致）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_provider_opencode: Option<String>,
    /// 当前 OpenClaw 供应商 ID（本地存储，对 OpenClaw 可能无意义，但保持结构一致）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_provider_openclaw: Option<String>,
    /// 当前 Hermes 供应商 ID（本地存储，保持结构一致）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_provider_hermes: Option<String>,

    // ===== Skill 同步设置 =====
    /// Skill 同步方式：auto（默认，优先 symlink）、symlink、copy
    #[serde(default)]
    pub skill_sync_method: SyncMethod,
    /// Skill 存储位置：cc_switch（默认）或 unified（~/.agents/skills/）
    #[serde(default)]
    pub skill_storage_location: SkillStorageLocation,

    // ===== WebDAV 同步设置 =====
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webdav_sync: Option<WebDavSyncSettings>,

    // ===== 预设注册表设置（设备级，不跨设备同步）=====
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_registry: Option<PresetRegistrySettings>,

    // ===== S3 同步设置 =====
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub s3_sync: Option<S3SyncSettings>,

    // ===== WebDAV 备份设置（旧版，保留向后兼容）=====
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webdav_backup: Option<serde_json::Value>,

    // ===== 备份策略设置 =====
    /// Auto-backup interval in hours (default 24, 0 = disabled)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_interval_hours: Option<u32>,
    /// Maximum number of backup files to retain (default 10)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_retain_count: Option<u32>,

    // ===== 终端设置 =====
    /// 首选终端应用（可选，默认使用系统默认终端）
    /// - macOS: "terminal" | "iterm2" | "warp" | "alacritty" | "kitty" | "ghostty" | "otty" | "wezterm" | "kaku"
    /// - Windows: "cmd" | "powershell" | "wt" (Windows Terminal)
    /// - Linux: "gnome-terminal" | "konsole" | "xfce4-terminal" | "alacritty" | "kitty" | "ghostty"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_terminal: Option<String>,

    /// 多设备额度协作配置与最近一次同步的官方窗口快照。
    #[serde(default)]
    pub quota_collaboration: QuotaCollaborationSettings,

    /// Device-local environment variables managed through each CLI's native
    /// configuration surface. Disabled by default and never synced to the
    /// provider database.
    #[serde(default)]
    pub env_injection: crate::env_injection::EnvInjectionSettings,

    // ===== 本机自动迁移状态 =====
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_migrations: Option<LocalMigrations>,
}

fn default_watchdog_enabled() -> bool {
    true
}

fn default_show_in_tray() -> bool {
    true
}

fn default_minimize_to_tray_on_close() -> bool {
    true
}

fn default_show_profile_switcher() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            show_in_tray: true,
            minimize_to_tray_on_close: true,
            use_app_window_controls: false,
            enable_claude_plugin_integration: false,
            skip_claude_onboarding: false,
            launch_on_startup: false,
            watchdog_enabled: default_watchdog_enabled(),
            launch_codex_desktop_with_ccswitch: false,
            tool_auto_update: HashMap::new(),
            auto_update_codex_cli: false,
            codex_egress_timezone: CodexEgressTimezoneSettings::default(),
            silent_startup: false,
            enable_local_proxy: false,
            proxy_confirmed: None,
            usage_confirmed: None,
            usage_dashboard_refresh_interval_ms: None,
            enable_failover_toggle: false,
            enable_stream_retry: true,
            stream_retry_mode: StreamRetryMode::Safe,
            stream_retry_max_attempts: default_stream_retry_max_attempts(),
            request_health: RequestHealthConfig::default(),
            show_profile_switcher: true,
            preserve_codex_official_auth_on_switch: false,
            unify_codex_session_history: false,
            unify_codex_migrate_existing: None,
            failover_confirmed: None,
            first_run_notice_confirmed: None,
            common_config_confirmed: None,
            language: None,
            visible_apps: None,
            claude_config_dir: None,
            codex_config_dir: None,
            gemini_config_dir: None,
            grok_config_dir: None,
            opencode_config_dir: None,
            openclaw_config_dir: None,
            hermes_config_dir: None,
            pi_config_dir: None,
            current_provider_claude: None,
            current_provider_claude_desktop: None,
            current_provider_codex: None,
            current_provider_gemini: None,
            current_provider_grokbuild: None,
            current_provider_opencode: None,
            current_provider_openclaw: None,
            current_provider_hermes: None,
            skill_sync_method: SyncMethod::default(),
            skill_storage_location: SkillStorageLocation::default(),
            webdav_sync: None,
            preset_registry: None,
            s3_sync: None,
            webdav_backup: None,
            backup_interval_hours: None,
            backup_retain_count: None,
            preferred_terminal: None,
            quota_collaboration: QuotaCollaborationSettings::default(),
            env_injection: crate::env_injection::EnvInjectionSettings::default(),
            local_migrations: None,
        }
    }
}

impl AppSettings {
    pub fn tool_auto_update_enabled(&self, tool: &str) -> bool {
        self.tool_auto_update
            .get(tool)
            .copied()
            .unwrap_or(tool == "codex" && self.auto_update_codex_cli)
    }

    fn set_tool_auto_update(&mut self, tool: &str, enabled: bool) {
        self.tool_auto_update.insert(tool.to_string(), enabled);
        if tool == "codex" {
            self.auto_update_codex_cli = enabled;
        }
    }

    /// Effective policy after accounting for settings written by pre-tier versions.
    pub fn stream_retry_mode_effective(&self) -> StreamRetryMode {
        if !self.enable_stream_retry && self.stream_retry_mode == StreamRetryMode::Safe {
            StreamRetryMode::Off
        } else {
            self.stream_retry_mode
        }
    }

    /// Transparent proxy reconnect budget. This is deliberately separate from the
    /// logical continuation budget: both Safe and Aggressive keep the normal
    /// pre-semantic reconnect protection.
    pub fn stream_retry_budget(&self, safe_budget: u32) -> u32 {
        match self.stream_retry_mode_effective() {
            StreamRetryMode::Off => 0,
            StreamRetryMode::Safe | StreamRetryMode::Aggressive => safe_budget,
        }
    }

    /// Number of post-semantic logical turn recoveries. Only Aggressive may type
    /// and submit a continuation through Codex Desktop.
    pub fn stream_recovery_budget(&self) -> u32 {
        match self.stream_retry_mode_effective() {
            StreamRetryMode::Aggressive => self.stream_retry_max_attempts.clamp(1, 3),
            StreamRetryMode::Off | StreamRetryMode::Safe => 0,
        }
    }

    pub(crate) fn settings_path() -> Option<PathBuf> {
        // Device-local settings live outside the synced SQLite database.
        Some(
            crate::config::get_home_dir()
                .join(".cc-switch")
                .join("settings.json"),
        )
    }

    fn normalize_paths(&mut self) {
        self.claude_config_dir = self
            .claude_config_dir
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        self.codex_config_dir = self
            .codex_config_dir
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        self.gemini_config_dir = self
            .gemini_config_dir
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        self.grok_config_dir = self
            .grok_config_dir
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        self.opencode_config_dir = self
            .opencode_config_dir
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        self.openclaw_config_dir = self
            .openclaw_config_dir
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        self.hermes_config_dir = self
            .hermes_config_dir
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        self.pi_config_dir = self
            .pi_config_dir
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        self.language = self
            .language
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| matches!(*s, "en" | "zh" | "zh-TW" | "ja"))
            .map(|s| s.to_string());

        if let Some(sync) = &mut self.webdav_sync {
            sync.normalize();
            if sync.is_empty() {
                self.webdav_sync = None;
            }
        }

        if let Some(registry) = &mut self.preset_registry {
            registry.normalize();
            if registry.is_empty() {
                self.preset_registry = None;
            }
        }

        if let Some(s3) = &mut self.s3_sync {
            s3.normalize();
            if s3.is_empty() {
                self.s3_sync = None;
            }
        }
        self.quota_collaboration.normalize();
    }

    fn load_from_file() -> Self {
        let Some(path) = Self::settings_path() else {
            return Self::default();
        };
        Self::load_from_path(&path)
    }

    fn load_from_path(path: &Path) -> Self {
        if let Ok(content) = fs::read_to_string(path) {
            match serde_json::from_str::<AppSettings>(&content) {
                Ok(mut settings) => {
                    settings.normalize_paths();
                    settings
                }
                Err(err) => {
                    log::warn!(
                        "解析设置文件失败，将使用默认设置。路径: {}, 错误: {}",
                        path.display(),
                        err
                    );
                    Self::default()
                }
            }
        } else {
            Self::default()
        }
    }
}

fn save_settings_file(settings: &AppSettings) -> Result<(), AppError> {
    let Some(path) = AppSettings::settings_path() else {
        return Err(AppError::Config("无法获取用户主目录".to_string()));
    };
    save_settings_file_to_path(settings, &path)
}

fn save_settings_file_to_path(settings: &AppSettings, path: &Path) -> Result<(), AppError> {
    let mut normalized = settings.clone();
    normalized.normalize_paths();
    let json = serde_json::to_string_pretty(&normalized)
        .map_err(|e| AppError::JsonSerialize { source: e })?;
    crate::config::atomic_write_private(path, json.as_bytes())
}

static SETTINGS_STORE: OnceLock<RwLock<AppSettings>> = OnceLock::new();

fn settings_store() -> &'static RwLock<AppSettings> {
    SETTINGS_STORE.get_or_init(|| RwLock::new(AppSettings::load_from_file()))
}

fn resolve_override_path(raw: &str) -> PathBuf {
    if raw == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    } else if let Some(stripped) = raw.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(stripped);
        }
    } else if let Some(stripped) = raw.strip_prefix("~\\") {
        if let Some(home) = dirs::home_dir() {
            return home.join(stripped);
        }
    }

    PathBuf::from(raw)
}

pub fn get_settings() -> AppSettings {
    settings_store()
        .read()
        .unwrap_or_else(|e| {
            log::warn!("设置锁已毒化，使用恢复值: {e}");
            e.into_inner()
        })
        .clone()
}

pub fn get_settings_for_frontend() -> AppSettings {
    let mut settings = get_settings();
    redact_frontend_secrets(&mut settings);
    settings
}

/// Return device-local preset registry settings without exposing credentials to
/// renderer code. The backend-only getter remains available to request
/// execution paths that need the WebDAV password.
pub fn get_preset_registry_settings_for_frontend() -> Option<PresetRegistrySettings> {
    let mut settings = get_preset_registry_settings();
    if let Some(registry) = &mut settings {
        redact_preset_registry_passwords(registry);
    }
    settings
}

fn redact_preset_registry_passwords(registry: &mut PresetRegistrySettings) {
    for source in &mut registry.sources {
        source.password.clear();
    }
}

fn preserve_preset_registry_passwords(
    incoming: &mut Option<PresetRegistrySettings>,
    existing: Option<&PresetRegistrySettings>,
) {
    let (Some(incoming), Some(existing)) = (incoming, existing) else {
        return;
    };
    for source in &mut incoming.sources {
        if source.password.is_empty() {
            if let Some(previous) = existing
                .sources
                .iter()
                .find(|candidate| candidate.id == source.id)
            {
                source.password = previous.password.clone();
            }
        }
    }
}

fn redact_frontend_secrets(settings: &mut AppSettings) {
    if let Some(sync) = &mut settings.webdav_sync {
        sync.password.clear();
    }
    if let Some(s3) = &mut settings.s3_sync {
        s3.secret_access_key.clear();
    }
    if let Some(registry) = &mut settings.preset_registry {
        redact_preset_registry_passwords(registry);
    }
    settings.webdav_backup = None;
}

pub fn update_settings(mut new_settings: AppSettings) -> Result<(), AppError> {
    new_settings.normalize_paths();
    new_settings.env_injection.validate()?;
    crate::codex_egress_timezone::validate_timezone_settings(&new_settings.codex_egress_timezone)
        .map_err(AppError::InvalidInput)?;
    let request_health_windows_notifications_active =
        request_health_windows_notifications_active(&new_settings.request_health);
    let mut guard = settings_store().write().unwrap_or_else(|e| {
        log::warn!("设置锁已毒化，使用恢复值: {e}");
        e.into_inner()
    });
    // 文件与内存必须在同一写锁临界区更新。出口监测会在后台原子修改设置；
    // 若先写文件再取锁，前端保存与探测写回交错时会造成磁盘和内存分别保留
    // 两个不同版本，并在下一次启动时丢失其中一方的结果。
    save_settings_file(&new_settings)?;
    *guard = new_settings;
    drop(guard);
    if !request_health_windows_notifications_active {
        crate::proxy::request_health::cancel_pending_reviews();
        crate::codex_desktop::clear_codex_request_health_warnings();
    }
    Ok(())
}

pub(crate) fn preserve_dedicated_settings(incoming: &mut AppSettings, existing: &AppSettings) {
    incoming.tool_auto_update = existing.tool_auto_update.clone();
    incoming.auto_update_codex_cli = existing.auto_update_codex_cli;
    incoming.request_health = existing.request_health.clone();
    incoming.current_provider_claude = existing.current_provider_claude.clone();
    incoming.current_provider_claude_desktop = existing.current_provider_claude_desktop.clone();
    incoming.current_provider_codex = existing.current_provider_codex.clone();
    incoming.current_provider_gemini = existing.current_provider_gemini.clone();
    incoming.current_provider_grokbuild = existing.current_provider_grokbuild.clone();
    incoming.current_provider_opencode = existing.current_provider_opencode.clone();
    incoming.current_provider_openclaw = existing.current_provider_openclaw.clone();
    incoming.current_provider_hermes = existing.current_provider_hermes.clone();
    incoming.local_migrations = existing.local_migrations.clone();
    // Quota window evidence is backend-owned and updated independently of the
    // settings form. Policy changes use `patch_settings`, so preserve the
    // complete canonical cache during stale full saves.
    incoming.quota_collaboration = existing.quota_collaboration.clone();
    // Cloud-sync settings and status are owned by their dedicated commands;
    // frontend full settings payloads intentionally omit these fields.
    incoming.webdav_sync = existing.webdav_sync.clone();
    incoming.s3_sync = existing.s3_sync.clone();
    // Preset registry sources and accepted-version metadata are likewise
    // maintained by dedicated registry commands, not the general form.
    incoming.preset_registry = existing.preset_registry.clone();

    // Probe and launch evidence can change after the initial form merge.
    if incoming.codex_egress_timezone.mode == CodexEgressTimezoneMode::Auto
        && existing.codex_egress_timezone.mode == CodexEgressTimezoneMode::Auto
        && existing.codex_egress_timezone.detected_at > incoming.codex_egress_timezone.detected_at
    {
        incoming.codex_egress_timezone.detected_timezone =
            existing.codex_egress_timezone.detected_timezone.clone();
        incoming.codex_egress_timezone.detected_at = existing.codex_egress_timezone.detected_at;
        incoming.codex_egress_timezone.detected_egress_ip =
            existing.codex_egress_timezone.detected_egress_ip.clone();
        incoming.codex_egress_timezone.detected_country_code =
            existing.codex_egress_timezone.detected_country_code.clone();
        incoming.codex_egress_timezone.detected_region =
            existing.codex_egress_timezone.detected_region.clone();
        incoming.codex_egress_timezone.detected_city =
            existing.codex_egress_timezone.detected_city.clone();
        incoming.codex_egress_timezone.detected_colo =
            existing.codex_egress_timezone.detected_colo.clone();
        incoming.codex_egress_timezone.last_probe_trigger =
            existing.codex_egress_timezone.last_probe_trigger.clone();
    }
    incoming.codex_egress_timezone.last_applied_timezone =
        existing.codex_egress_timezone.last_applied_timezone.clone();
    incoming.codex_egress_timezone.last_applied_at = existing.codex_egress_timezone.last_applied_at;
}

pub fn update_settings_preserving_dedicated_settings(
    mut new_settings: AppSettings,
) -> Result<(), AppError> {
    new_settings.env_injection.validate()?;
    crate::codex_egress_timezone::validate_timezone_settings(&new_settings.codex_egress_timezone)
        .map_err(AppError::InvalidInput)?;
    mutate_settings(|existing| {
        // Dedicated setters and full saves must share the same current state,
        // including updates made after the settings page loaded.
        preserve_dedicated_settings(&mut new_settings, existing);
        *existing = new_settings;
    })
}

/// Persist only the Request Health configuration without replaying a stale
/// full settings snapshot from the renderer.
fn replace_request_health_config(
    settings: &mut AppSettings,
    mut request_health: RequestHealthConfig,
) {
    request_health.windows_notifications_snoozed_until_ms = settings
        .request_health
        .windows_notifications_snoozed_until_ms;
    settings.request_health = request_health;
}

pub fn update_request_health_config(
    request_health: RequestHealthConfig,
) -> Result<RequestHealthConfig, AppError> {
    mutate_settings(|settings| {
        replace_request_health_config(settings, request_health);
        settings.request_health.clone()
    })
}

pub fn set_tool_auto_update(tool: &str, enabled: bool) -> Result<(), AppError> {
    mutate_settings(|settings| settings.set_tool_auto_update(tool, enabled))
}

pub fn snooze_request_health_windows_notifications() -> Result<(), AppError> {
    mutate_settings(|settings| {
        let hours = settings
            .request_health
            .windows_notification_snooze_hours
            .clamp(1, 24);
        settings
            .request_health
            .windows_notifications_snoozed_until_ms = Some(
            chrono::Utc::now()
                .timestamp_millis()
                .saturating_add(i64::from(hours).saturating_mul(60 * 60 * 1000)),
        );
    })
}

pub fn request_health_windows_notifications_active(config: &RequestHealthConfig) -> bool {
    request_health_diagnostics_active(config)
        && config.review_mode != RequestHealthReviewMode::Off
        && config.windows_notifications_enabled
        && config
            .windows_notifications_snoozed_until_ms
            .is_none_or(|until| chrono::Utc::now().timestamp_millis() >= until)
}

pub fn request_health_diagnostics_active(config: &RequestHealthConfig) -> bool {
    config.enabled
}

pub(crate) fn mutate_settings<F, R>(mutator: F) -> Result<R, AppError>
where
    F: FnOnce(&mut AppSettings) -> R,
{
    let mut guard = settings_store().write().unwrap_or_else(|e| {
        log::warn!("设置锁已毒化，使用恢复值: {e}");
        e.into_inner()
    });
    let mut next = guard.clone();
    let result = mutator(&mut next);
    next.normalize_paths();
    let request_health_windows_notifications_active =
        request_health_windows_notifications_active(&next.request_health);
    save_settings_file(&next)?;
    *guard = next;
    drop(guard);
    if !request_health_windows_notifications_active {
        crate::proxy::request_health::cancel_pending_reviews();
        crate::codex_desktop::clear_codex_request_health_warnings();
    }
    Ok(result)
}

pub fn mutate_codex_egress_timezone<F, R>(mutator: F) -> Result<R, AppError>
where
    F: FnOnce(&mut CodexEgressTimezoneSettings) -> R,
{
    mutate_settings(|settings| mutator(&mut settings.codex_egress_timezone))
}

pub fn is_codex_third_party_history_provider_bucket_migrated() -> bool {
    get_settings()
        .local_migrations
        .as_ref()
        .and_then(|migrations| {
            migrations
                .codex_third_party_history_provider_bucket_v1
                .as_ref()
        })
        .is_some_and(|m| m.scanned_history_files)
}

pub fn mark_codex_third_party_history_provider_bucket_migrated(
    migration: CodexThirdPartyHistoryProviderBucketMigration,
) -> Result<(), AppError> {
    mutate_settings(|settings| {
        let migrations = settings
            .local_migrations
            .get_or_insert_with(Default::default);
        migrations.codex_third_party_history_provider_bucket_v1 = Some(migration);
    })
}

pub fn is_codex_openai_history_provider_bucket_migrated() -> bool {
    get_settings()
        .local_migrations
        .as_ref()
        .and_then(|migrations| migrations.codex_openai_history_provider_bucket_v2.as_ref())
        .is_some_and(|m| m.scanned_history_files)
}

pub fn mark_codex_openai_history_provider_bucket_migrated(
    migration: CodexThirdPartyHistoryProviderBucketMigration,
) -> Result<(), AppError> {
    mutate_settings(|settings| {
        let migrations = settings
            .local_migrations
            .get_or_insert_with(Default::default);
        migrations.codex_openai_history_provider_bucket_v2 = Some(migration);
    })
}

pub fn is_codex_provider_template_migrated() -> bool {
    get_settings()
        .local_migrations
        .as_ref()
        .and_then(|migrations| migrations.codex_provider_template_v1.as_ref())
        .is_some()
}

pub fn mark_codex_provider_template_migrated(
    migration: CodexProviderTemplateMigration,
) -> Result<(), AppError> {
    mutate_settings(|settings| {
        let migrations = settings
            .local_migrations
            .get_or_insert_with(Default::default);
        migrations.codex_provider_template_v1 = Some(migration);
    })
}

/// 统一会话迁移标记是否覆盖指定目录。标记里没记目录（不应出现的旧格式）
/// 视为不匹配——重跑迁移是幂等的，宁可重迁也不漏迁。
pub fn is_codex_official_history_unify_migrated_for_dir(codex_dir: &str) -> bool {
    get_settings()
        .local_migrations
        .as_ref()
        .and_then(|migrations| migrations.codex_official_history_unify_v1.as_ref())
        .is_some_and(|migration| migration.codex_config_dir.as_deref() == Some(codex_dir))
}

/// 条件写入迁移完成标记：仅当此刻开关仍开启且迁移意愿仍在时才写。
/// 检查与写入在 settings 写锁内原子完成，与关闭开关路径
/// （`update_settings` / 清标记）串行，消除"迁移线程复查开关后、写标记前
/// 用户恰好关闭开关"的竞态窗口。返回是否实际写入。
pub fn mark_codex_official_history_unify_migrated_if_enabled(
    migration: CodexOfficialHistoryUnifyMigration,
) -> Result<bool, AppError> {
    let mut written = false;
    mutate_settings(|settings| {
        if settings.unify_codex_session_history
            && settings.unify_codex_migrate_existing.unwrap_or(false)
        {
            settings
                .local_migrations
                .get_or_insert_with(Default::default)
                .codex_official_history_unify_v1 = Some(migration);
            written = true;
        }
    })?;
    Ok(written)
}

pub fn clear_codex_official_history_unify_migration() -> Result<(), AppError> {
    mutate_settings(|settings| {
        if let Some(migrations) = settings.local_migrations.as_mut() {
            migrations.codex_official_history_unify_v1 = None;
        }
    })
}

pub fn unify_codex_migrate_existing_requested() -> bool {
    get_settings().unify_codex_migrate_existing.unwrap_or(false)
}

pub fn clear_codex_unify_migrate_existing() -> Result<(), AppError> {
    mutate_settings(|settings| {
        settings.unify_codex_migrate_existing = None;
    })
}

/// 从文件重新加载设置到内存缓存
/// 用于导入配置等场景，确保内存缓存与文件同步
pub fn reload_settings() -> Result<(), AppError> {
    let fresh_settings = AppSettings::load_from_file();
    let mut guard = settings_store().write().unwrap_or_else(|e| {
        log::warn!("设置锁已毒化，使用恢复值: {e}");
        e.into_inner()
    });
    *guard = fresh_settings;
    Ok(())
}

pub fn get_claude_override_dir() -> Option<PathBuf> {
    let settings = settings_store().read().ok()?;
    settings
        .claude_config_dir
        .as_ref()
        .map(|p| resolve_override_path(p))
}

pub fn get_codex_override_dir() -> Option<PathBuf> {
    let settings = settings_store().read().ok()?;
    settings
        .codex_config_dir
        .as_ref()
        .map(|p| resolve_override_path(p))
}

pub fn get_gemini_override_dir() -> Option<PathBuf> {
    let settings = settings_store().read().ok()?;
    settings
        .gemini_config_dir
        .as_ref()
        .map(|p| resolve_override_path(p))
}

pub fn get_grok_override_dir() -> Option<PathBuf> {
    let settings = settings_store().read().ok()?;
    settings
        .grok_config_dir
        .as_ref()
        .map(|p| resolve_override_path(p))
}

pub fn get_opencode_override_dir() -> Option<PathBuf> {
    let settings = settings_store().read().ok()?;
    settings
        .opencode_config_dir
        .as_ref()
        .map(|p| resolve_override_path(p))
}

pub fn get_openclaw_override_dir() -> Option<PathBuf> {
    let settings = settings_store().read().ok()?;
    settings
        .openclaw_config_dir
        .as_ref()
        .map(|p| resolve_override_path(p))
}

pub fn get_hermes_override_dir() -> Option<PathBuf> {
    let settings = settings_store().read().ok()?;
    settings
        .hermes_config_dir
        .as_ref()
        .map(|p| resolve_override_path(p))
}

pub fn get_pi_override_dir() -> Option<PathBuf> {
    let settings = settings_store().read().ok()?;
    settings
        .pi_config_dir
        .as_ref()
        .map(|path| resolve_override_path(path))
}

pub fn preserve_codex_official_auth_on_switch() -> bool {
    settings_store()
        .read()
        .unwrap_or_else(|e| {
            log::warn!("设置锁已毒化，使用恢复值: {e}");
            e.into_inner()
        })
        .preserve_codex_official_auth_on_switch
}

pub fn unify_codex_session_history() -> bool {
    settings_store()
        .read()
        .unwrap_or_else(|e| {
            log::warn!("设置锁已毒化，使用恢复值: {e}");
            e.into_inner()
        })
        .unify_codex_session_history
}

/// 关闭 Codex 统一历史模式，并清除尚未执行的迁移意愿与完成标记。
///
/// 一键切回官方时必须一次性更新这三个字段；否则后续写官方配置时仍可能把
/// `model_provider` 重新注入为 `custom`，让刚归并到 `openai` 的历史再次不可见。
pub fn disable_codex_session_history_unify() -> Result<(), AppError> {
    mutate_settings(|settings| {
        settings.unify_codex_session_history = false;
        settings.unify_codex_migrate_existing = None;
        if let Some(migrations) = settings.local_migrations.as_mut() {
            migrations.codex_official_history_unify_v1 = None;
        }
    })
}

// ===== 当前供应商管理函数 =====

/// 获取指定应用类型的当前供应商 ID（从本地 settings 读取）
///
/// 这是设备级别的设置，不随数据库同步。
/// 如果本地没有设置，调用者应该 fallback 到数据库的 `is_current` 字段。
pub fn get_current_provider(app_type: &AppType) -> Option<String> {
    let settings = settings_store().read().ok()?;
    match app_type {
        AppType::Claude => settings.current_provider_claude.clone(),
        AppType::ClaudeDesktop => settings.current_provider_claude_desktop.clone(),
        AppType::Codex => settings.current_provider_codex.clone(),
        AppType::Gemini => settings.current_provider_gemini.clone(),
        AppType::GrokBuild => settings.current_provider_grokbuild.clone(),
        AppType::OpenCode => settings.current_provider_opencode.clone(),
        AppType::OpenClaw => settings.current_provider_openclaw.clone(),
        AppType::Hermes => settings.current_provider_hermes.clone(),
        AppType::Pi => None,
    }
}

/// 设置指定应用类型的当前供应商 ID（保存到本地 settings）
///
/// 这是设备级别的设置，不随数据库同步。
/// 传入 `None` 会清除当前供应商设置。
pub fn set_current_provider(app_type: &AppType, id: Option<&str>) -> Result<(), AppError> {
    let id_owned = id.map(|s| s.to_string());
    mutate_settings(|settings| match app_type {
        AppType::Claude => settings.current_provider_claude = id_owned.clone(),
        AppType::ClaudeDesktop => settings.current_provider_claude_desktop = id_owned.clone(),
        AppType::Codex => settings.current_provider_codex = id_owned.clone(),
        AppType::Gemini => settings.current_provider_gemini = id_owned.clone(),
        AppType::GrokBuild => settings.current_provider_grokbuild = id_owned.clone(),
        AppType::OpenCode => settings.current_provider_opencode = id_owned.clone(),
        AppType::OpenClaw => settings.current_provider_openclaw = id_owned.clone(),
        AppType::Hermes => settings.current_provider_hermes = id_owned.clone(),
        AppType::Pi => {}
    })
}

/// 获取有效的当前供应商 ID（验证存在性）
///
/// 逻辑：
/// 1. 从本地 settings 读取当前供应商 ID
/// 2. 验证该 ID 在数据库中存在
/// 3. 如果不存在则清理本地 settings，fallback 到数据库的 is_current
///
/// 这确保了返回的 ID 一定是有效的（在数据库中存在）。
/// 多设备云同步场景下，配置导入后本地 ID 可能失效，此函数会自动修复。
pub fn get_effective_current_provider(
    db: &crate::database::Database,
    app_type: &AppType,
) -> Result<Option<String>, AppError> {
    // 1. 从本地 settings 读取
    if let Some(local_id) = get_current_provider(app_type) {
        // 2. 验证该 ID 在数据库中存在
        let providers = db.get_all_providers(app_type.as_str())?;
        if providers.contains_key(&local_id) {
            // 存在，直接返回
            return Ok(Some(local_id));
        }

        // 3. 不存在，清理本地 settings
        log::warn!(
            "本地 settings 中的供应商 {} ({}) 在数据库中不存在，将清理并 fallback 到数据库",
            local_id,
            app_type.as_str()
        );
        let _ = set_current_provider(app_type, None);
    }

    // Fallback 到数据库的 is_current
    db.get_current_provider(app_type.as_str())
}

// ===== Skill 同步方式管理函数 =====

/// 获取 Skill 同步方式配置
pub fn get_skill_sync_method() -> SyncMethod {
    settings_store()
        .read()
        .unwrap_or_else(|e| {
            log::warn!("设置锁已毒化，使用恢复值: {e}");
            e.into_inner()
        })
        .skill_sync_method
}

// ===== Skill 存储位置管理函数 =====

/// 获取 Skill 存储位置配置
pub fn get_skill_storage_location() -> SkillStorageLocation {
    settings_store()
        .read()
        .unwrap_or_else(|e| {
            log::warn!("设置锁已毒化，使用恢复值: {e}");
            e.into_inner()
        })
        .skill_storage_location
}

/// 设置 Skill 存储位置
pub fn set_skill_storage_location(location: SkillStorageLocation) -> Result<(), AppError> {
    mutate_settings(|s| {
        s.skill_storage_location = location;
    })
}

// ===== 备份策略管理函数 =====

/// Get the effective auto-backup interval in hours (default 24)
pub fn effective_backup_interval_hours() -> u32 {
    settings_store()
        .read()
        .unwrap_or_else(|e| {
            log::warn!("设置锁已毒化，使用恢复值: {e}");
            e.into_inner()
        })
        .backup_interval_hours
        .unwrap_or(24)
}

/// Get the effective backup retain count (default 10, minimum 1)
pub fn effective_backup_retain_count() -> usize {
    settings_store()
        .read()
        .unwrap_or_else(|e| {
            log::warn!("设置锁已毒化，使用恢复值: {e}");
            e.into_inner()
        })
        .backup_retain_count
        .map(|n| (n as usize).max(1))
        .unwrap_or(10)
}

// ===== 终端设置管理函数 =====

/// 获取首选终端应用
pub fn get_preferred_terminal() -> Option<String> {
    settings_store()
        .read()
        .unwrap_or_else(|e| {
            log::warn!("设置锁已毒化，使用恢复值: {e}");
            e.into_inner()
        })
        .preferred_terminal
        .clone()
}

// ===== WebDAV 同步设置管理函数 =====

/// 获取 WebDAV 同步设置
pub fn get_webdav_sync_settings() -> Option<WebDavSyncSettings> {
    settings_store().read().ok()?.webdav_sync.clone()
}

/// 保存 WebDAV 同步设置
pub fn set_webdav_sync_settings(settings: Option<WebDavSyncSettings>) -> Result<(), AppError> {
    mutate_settings(|current| {
        current.webdav_sync = settings;
    })
}

/// 读取预设注册表设置（设备级，不跨设备同步）。
pub fn get_preset_registry_settings() -> Option<PresetRegistrySettings> {
    settings_store().read().ok()?.preset_registry.clone()
}

/// 保存预设注册表设置。
pub fn set_preset_registry_settings(
    mut settings: Option<PresetRegistrySettings>,
) -> Result<(), AppError> {
    mutate_settings(|current| {
        // Renderer payloads intentionally omit credentials. Preserve the
        // existing password for matching sources instead of erasing it when
        // the registry form is saved after a read.
        preserve_preset_registry_passwords(&mut settings, current.preset_registry.as_ref());
        current.preset_registry = settings;
    })
}

/// Mark one device-local registry source as having accepted a signed bundle.
/// Registry credentials remain in settings and are deliberately not WebDAV
/// profile data; only the shared compiled bundle is synchronized.
pub fn mark_preset_registry_source_accepted(
    source_id: &str,
    version: &str,
    checked_at: i64,
) -> Result<(), AppError> {
    let source_id = source_id.trim().to_string();
    let version = version.trim().to_string();
    mutate_settings(|current| {
        if let Some(registry) = current.preset_registry.as_mut() {
            if let Some(source) = registry
                .sources
                .iter_mut()
                .find(|source| source.id == source_id)
            {
                source.last_accepted_version = version;
                source.last_checked_at = checked_at;
            }
        }
    })
}

/// 仅更新 WebDAV 同步状态，避免覆写 credentials/root/profile 等字段
pub fn update_webdav_sync_status(status: WebDavSyncStatus) -> Result<(), AppError> {
    mutate_settings(|current| {
        if let Some(sync) = current.webdav_sync.as_mut() {
            sync.status = status;
        }
    })
}

// ===== S3 同步设置管理函数 =====

pub fn get_s3_sync_settings() -> Option<S3SyncSettings> {
    settings_store().read().ok()?.s3_sync.clone()
}

pub fn set_s3_sync_settings(settings: Option<S3SyncSettings>) -> Result<(), AppError> {
    mutate_settings(|current| {
        current.s3_sync = settings;
    })
}

pub fn update_s3_sync_status(status: WebDavSyncStatus) -> Result<(), AppError> {
    mutate_settings(|current| {
        if let Some(s3) = current.s3_sync.as_mut() {
            s3.status = status;
        }
    })
}

/// 原子更新多设备额度协作状态，供代理热路径读取最近一次同步的官方窗口。
pub fn mutate_quota_collaboration<F>(mutator: F) -> Result<(), AppError>
where
    F: FnOnce(&mut QuotaCollaborationSettings),
{
    mutate_settings(|settings| {
        mutator(&mut settings.quota_collaboration);
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_config::AppType;

    #[test]
    fn tool_auto_update_is_opt_in_and_preserves_legacy_codex_preference() {
        let defaults = AppSettings::default();
        for tool in crate::commands::VALID_TOOLS {
            assert!(!defaults.tool_auto_update_enabled(tool));
        }
        let mut settings: AppSettings = serde_json::from_value(serde_json::json!({
            "autoUpdateCodexCli": true
        }))
        .unwrap();
        assert!(settings.tool_auto_update_enabled("codex"));
        assert!(!settings.tool_auto_update_enabled("claude"));
        settings.set_tool_auto_update("gemini", true);
        assert!(settings.tool_auto_update_enabled("codex"));
        assert!(settings.tool_auto_update_enabled("gemini"));
        settings.set_tool_auto_update("codex", false);
        assert!(!settings.auto_update_codex_cli);
        assert!(!settings.tool_auto_update_enabled("codex"));
        let round_trip: AppSettings =
            serde_json::from_value(serde_json::to_value(settings).unwrap()).unwrap();
        assert!(round_trip.tool_auto_update_enabled("gemini"));
        assert!(!round_trip.tool_auto_update_enabled("codex"));
    }

    #[test]
    fn explicit_codex_policy_overrides_legacy_auto_update() {
        let settings: AppSettings = serde_json::from_value(serde_json::json!({
            "autoUpdateCodexCli": true,
            "toolAutoUpdate": { "codex": false, "pi": true }
        }))
        .unwrap();
        assert!(!settings.tool_auto_update_enabled("codex"));
        assert!(settings.tool_auto_update_enabled("pi"));
    }

    #[test]
    fn request_health_diagnostics_and_notification_controls_are_independent() {
        let defaults = RequestHealthConfig::default();
        assert!(request_health_diagnostics_active(&defaults));
        assert!(request_health_windows_notifications_active(&defaults));

        let mut disabled = defaults.clone();
        disabled.enabled = false;
        assert!(!request_health_diagnostics_active(&disabled));

        let mut review_off = defaults.clone();
        review_off.review_mode = RequestHealthReviewMode::Off;
        assert!(request_health_diagnostics_active(&review_off));
        assert!(!request_health_windows_notifications_active(&review_off));

        let mut notifications_off = defaults;
        assert!(request_health_diagnostics_active(&notifications_off));
        notifications_off.windows_notifications_enabled = false;
        assert!(!request_health_windows_notifications_active(
            &notifications_off
        ));
    }

    #[test]
    fn request_health_update_changes_only_the_canonical_request_health_field() {
        let mut settings = AppSettings {
            language: Some("en".to_string()),
            ..AppSettings::default()
        };
        settings.tool_auto_update.insert("codex".to_string(), true);

        let mut request_health = RequestHealthConfig::default();
        request_health.enabled = false;
        request_health.large_request_threshold_bytes = 512 * 1024;

        replace_request_health_config(&mut settings, request_health.clone());

        assert_eq!(settings.request_health, request_health);
        assert_eq!(settings.language.as_deref(), Some("en"));
        assert_eq!(settings.tool_auto_update.get("codex"), Some(&true));
    }

    #[test]
    fn request_health_save_preserves_backend_owned_snooze() {
        let mut settings = AppSettings::default();
        settings
            .request_health
            .windows_notifications_snoozed_until_ms = Some(9_999_999_999_999);
        let mut stale_form = RequestHealthConfig::default();
        stale_form.large_request_threshold_bytes = 512 * 1024;

        replace_request_health_config(&mut settings, stale_form);

        assert_eq!(
            settings
                .request_health
                .windows_notifications_snoozed_until_ms,
            Some(9_999_999_999_999)
        );
        assert_eq!(
            settings.request_health.large_request_threshold_bytes,
            512 * 1024
        );
    }

    #[test]
    fn full_save_preserves_backend_owned_updates_after_its_initial_snapshot() {
        let mut stale_save = AppSettings::default();
        stale_save.language = Some("ja".to_string());
        let mut current = AppSettings::default();
        current.current_provider_claude = Some("current-claude".to_string());
        current.current_provider_claude_desktop = Some("current-claude-desktop".to_string());
        current.current_provider_codex = Some("current-codex".to_string());
        current.current_provider_gemini = Some("current-gemini".to_string());
        current.current_provider_grokbuild = Some("current-grokbuild".to_string());
        current.current_provider_opencode = Some("current-opencode".to_string());
        current.current_provider_openclaw = Some("current-openclaw".to_string());
        current.current_provider_hermes = Some("current-hermes".to_string());
        current.local_migrations = Some(LocalMigrations {
            codex_provider_template_v1: Some(CodexProviderTemplateMigration {
                completed_at: "2026-10-15T00:00:00Z".to_string(),
                migrated_provider_ids: vec!["current-codex".to_string()],
            }),
            ..LocalMigrations::default()
        });

        preserve_dedicated_settings(&mut stale_save, &current);

        assert_eq!(
            stale_save.current_provider_claude,
            current.current_provider_claude
        );
        assert_eq!(
            stale_save.current_provider_claude_desktop,
            current.current_provider_claude_desktop
        );
        assert_eq!(
            stale_save.current_provider_codex,
            current.current_provider_codex
        );
        assert_eq!(
            stale_save.current_provider_gemini,
            current.current_provider_gemini
        );
        assert_eq!(
            stale_save.current_provider_grokbuild,
            current.current_provider_grokbuild
        );
        assert_eq!(
            stale_save.current_provider_opencode,
            current.current_provider_opencode
        );
        assert_eq!(
            stale_save.current_provider_openclaw,
            current.current_provider_openclaw
        );
        assert_eq!(
            stale_save.current_provider_hermes,
            current.current_provider_hermes
        );
        assert_eq!(
            serde_json::to_value(stale_save.local_migrations).unwrap(),
            serde_json::to_value(current.local_migrations).unwrap()
        );
        assert_eq!(stale_save.language.as_deref(), Some("ja"));
    }

    #[test]
    fn full_save_preserves_timezone_evidence_updated_after_its_initial_snapshot() {
        let mut stale_save = AppSettings::default();
        stale_save.codex_egress_timezone.mode = CodexEgressTimezoneMode::Auto;
        stale_save.codex_egress_timezone.detected_at = Some(100);
        stale_save.codex_egress_timezone.monitor_interval_minutes = 30;
        let mut current = AppSettings::default();
        current.codex_egress_timezone = CodexEgressTimezoneSettings {
            mode: CodexEgressTimezoneMode::Auto,
            detected_timezone: Some("Asia/Singapore".to_string()),
            detected_at: Some(200),
            last_applied_timezone: Some("Asia/Taipei".to_string()),
            last_applied_at: Some(150),
            ..CodexEgressTimezoneSettings::default()
        };

        preserve_dedicated_settings(&mut stale_save, &current);

        assert_eq!(stale_save.codex_egress_timezone.detected_at, Some(200));
        assert_eq!(
            stale_save
                .codex_egress_timezone
                .detected_timezone
                .as_deref(),
            Some("Asia/Singapore")
        );
        assert_eq!(
            stale_save
                .codex_egress_timezone
                .last_applied_timezone
                .as_deref(),
            Some("Asia/Taipei")
        );
        assert_eq!(stale_save.codex_egress_timezone.last_applied_at, Some(150));
        assert_eq!(
            stale_save.codex_egress_timezone.monitor_interval_minutes,
            30
        );
    }

    #[test]
    fn full_save_preserves_backend_owned_quota_window_cache() {
        let mut stale_save = AppSettings::default();
        stale_save.quota_collaboration.latest_window_captured_at = None;
        let mut current = AppSettings::default();
        current.quota_collaboration.latest_window_utilization =
            [("five_hour".to_string(), 82.5)].into_iter().collect();
        current.quota_collaboration.latest_window_captured_at = Some(1_900);

        preserve_dedicated_settings(&mut stale_save, &current);

        assert_eq!(
            stale_save.quota_collaboration.latest_window_utilization,
            current.quota_collaboration.latest_window_utilization
        );
        assert_eq!(
            stale_save.quota_collaboration.latest_window_captured_at,
            Some(1_900)
        );
    }

    #[test]
    fn full_save_preserves_dedicated_cloud_sync_settings() {
        let mut stale_save = AppSettings::default();
        stale_save.webdav_sync = None;
        stale_save.s3_sync = None;
        let mut current = AppSettings::default();
        current.webdav_sync = Some(WebDavSyncSettings {
            enabled: true,
            base_url: "https://dav.example.test/root".to_string(),
            username: "alice".to_string(),
            password: "secret".to_string(),
            ..WebDavSyncSettings::default()
        });
        current.s3_sync = Some(S3SyncSettings {
            enabled: true,
            region: "us-east-1".to_string(),
            bucket: "settings".to_string(),
            access_key_id: "AKIA".to_string(),
            secret_access_key: "secret".to_string(),
            ..S3SyncSettings::default()
        });

        preserve_dedicated_settings(&mut stale_save, &current);

        assert_eq!(
            stale_save
                .webdav_sync
                .as_ref()
                .map(|settings| &settings.base_url),
            current
                .webdav_sync
                .as_ref()
                .map(|settings| &settings.base_url)
        );
        assert_eq!(
            stale_save.s3_sync.as_ref().map(|settings| &settings.bucket),
            current.s3_sync.as_ref().map(|settings| &settings.bucket)
        );
    }

    #[test]
    fn full_save_preserves_dedicated_preset_registry_metadata() {
        let mut stale_save = AppSettings::default();
        stale_save.preset_registry = None;
        let mut current = AppSettings::default();
        current.preset_registry = Some(PresetRegistrySettings {
            schema_version: 1,
            sources: vec![crate::services::preset_registry::PresetSource {
                id: "team".to_string(),
                kind: crate::services::preset_registry::PresetSourceKind::Https,
                trust: crate::services::preset_registry::PresetTrust::Local,
                enabled: true,
                base_url: "https://presets.example.test".to_string(),
                username: String::new(),
                password: String::new(),
                remote_root: String::new(),
                profile: String::new(),
                public_key: String::new(),
                last_checked_at: 1_900,
                last_accepted_version: "2026.10.15".to_string(),
            }],
        });

        preserve_dedicated_settings(&mut stale_save, &current);

        assert_eq!(
            stale_save
                .preset_registry
                .as_ref()
                .and_then(|registry| registry.sources.first())
                .map(|source| source.last_accepted_version.as_str()),
            Some("2026.10.15")
        );
    }

    #[test]
    fn frontend_settings_redact_all_preset_registry_passwords() {
        let mut settings = AppSettings::default();
        settings.preset_registry = Some(PresetRegistrySettings {
            schema_version: 1,
            sources: vec![crate::services::preset_registry::PresetSource {
                id: "team".to_string(),
                kind: crate::services::preset_registry::PresetSourceKind::WebDav,
                trust: crate::services::preset_registry::PresetTrust::Local,
                enabled: true,
                base_url: "https://presets.example.test".to_string(),
                username: "fixture-user".to_string(),
                password: "fixture-password-not-real".to_string(),
                remote_root: "presets".to_string(),
                profile: "default".to_string(),
                public_key: String::new(),
                last_checked_at: 1_900,
                last_accepted_version: "2026.10.15".to_string(),
            }],
        });

        redact_frontend_secrets(&mut settings);

        assert_eq!(
            settings
                .preset_registry
                .as_ref()
                .and_then(|registry| registry.sources.first())
                .map(|source| source.password.as_str()),
            Some("")
        );
    }

    #[test]
    fn frontend_preset_registry_serialization_omits_source_passwords() {
        let mut registry = PresetRegistrySettings {
            schema_version: 1,
            sources: vec![crate::services::preset_registry::PresetSource {
                id: "team".to_string(),
                kind: crate::services::preset_registry::PresetSourceKind::WebDav,
                trust: crate::services::preset_registry::PresetTrust::Local,
                enabled: true,
                base_url: "https://presets.example.test".to_string(),
                username: "fixture-user".to_string(),
                password: "fixture-password-not-real".to_string(),
                remote_root: "presets".to_string(),
                profile: "default".to_string(),
                public_key: String::new(),
                last_checked_at: 1_900,
                last_accepted_version: "2026.10.15".to_string(),
            }],
        };

        redact_preset_registry_passwords(&mut registry);

        let serialized = serde_json::to_value(registry).expect("serialize frontend registry");
        assert!(
            serialized["sources"][0].get("password").is_none(),
            "frontend serialization must not expose a password field"
        );
        assert!(
            !serialized.to_string().contains("fixture-password-not-real"),
            "frontend serialization must not contain the source password"
        );
    }

    #[test]
    fn redacted_preset_registry_save_preserves_existing_password_by_source_id() {
        let existing = PresetRegistrySettings {
            schema_version: 1,
            sources: vec![crate::services::preset_registry::PresetSource {
                id: "team".to_string(),
                kind: crate::services::preset_registry::PresetSourceKind::WebDav,
                trust: crate::services::preset_registry::PresetTrust::Local,
                enabled: true,
                base_url: "https://presets.example.test".to_string(),
                username: "fixture-user".to_string(),
                password: "fixture-password-not-real".to_string(),
                remote_root: "presets".to_string(),
                profile: "default".to_string(),
                public_key: String::new(),
                last_checked_at: 1_900,
                last_accepted_version: "2026.10.15".to_string(),
            }],
        };
        let mut incoming = existing.clone();
        incoming.sources[0].password.clear();

        let mut incoming = Some(incoming);
        preserve_preset_registry_passwords(&mut incoming, Some(&existing));

        assert_eq!(
            incoming
                .as_ref()
                .and_then(|registry| registry.sources.first())
                .map(|source| source.password.as_str()),
            Some("fixture-password-not-real")
        );
    }

    #[test]
    fn settings_save_atomically_replaces_complete_request_health_configuration() {
        use std::io::Read;

        let directory = tempfile::tempdir().expect("temporary settings directory");
        let path = directory.path().join("settings.json");
        let initial = AppSettings::default();
        save_settings_file_to_path(&initial, &path).expect("save initial settings");
        let mut original_file = fs::File::open(&path).expect("open original settings");
        let mut edited = initial.clone();
        edited.request_health.enabled = false;
        edited.request_health.review_mode = RequestHealthReviewMode::Off;
        edited.request_health.large_request_threshold_bytes = 512 * 1024;
        edited.request_health.windows_notifications_snoozed_until_ms = Some(9_999_999_999_999);

        save_settings_file_to_path(&edited, &path).expect("replace settings");

        let reloaded = AppSettings::load_from_path(&path);
        assert_eq!(reloaded.request_health, edited.request_health);
        let mut original_contents = String::new();
        original_file
            .read_to_string(&mut original_contents)
            .expect("read original file handle");
        let original: AppSettings =
            serde_json::from_str(&original_contents).expect("original JSON remains complete");
        assert_eq!(original.request_health, initial.request_health);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn visible_apps_old_settings_default_claude_desktop_visible() {
        let visible: VisibleApps = serde_json::from_value(serde_json::json!({
            "claude": true,
            "codex": true,
            "gemini": true,
            "opencode": true,
            "openclaw": true,
            "hermes": true
        }))
        .expect("visible apps");

        assert!(visible.is_visible(&AppType::ClaudeDesktop));
    }

    #[test]
    fn visible_apps_accepts_claude_desktop_aliases() {
        let visible: VisibleApps = serde_json::from_value(serde_json::json!({
            "claude": true,
            "claudeDesktop": false,
            "codex": true,
            "gemini": true,
            "opencode": true,
            "openclaw": true,
            "hermes": true
        }))
        .expect("visible apps");

        assert!(!visible.is_visible(&AppType::ClaudeDesktop));
    }

    #[test]
    fn codex_desktop_startup_is_opt_in_and_independent_from_auto_launch() {
        let defaults = AppSettings::default();
        assert!(!defaults.launch_on_startup);
        assert!(!defaults.launch_codex_desktop_with_ccswitch);

        let decoded: AppSettings = serde_json::from_value(serde_json::json!({
            "launchOnStartup": true,
        }))
        .expect("legacy settings remain readable");
        assert!(decoded.launch_on_startup);
        assert!(
            !decoded.launch_codex_desktop_with_ccswitch,
            "enabling CCSwitchMulti auto-launch must not implicitly start Codex Desktop"
        );
    }

    #[test]
    fn stream_retry_defaults_enabled_and_accepts_legacy_settings_payloads() {
        let defaults = AppSettings::default();
        assert!(defaults.enable_stream_retry);
        assert_eq!(
            defaults.stream_retry_mode_effective(),
            StreamRetryMode::Safe
        );
        assert_eq!(defaults.stream_retry_budget(5), 5);
        assert_eq!(defaults.stream_recovery_budget(), 0);

        let decoded: AppSettings = serde_json::from_value(serde_json::json!({
            "enableStreamRetry": false,
        }))
        .expect("settings payload");
        assert!(!decoded.enable_stream_retry);
        assert_eq!(decoded.stream_retry_mode_effective(), StreamRetryMode::Off);
        assert_eq!(decoded.stream_retry_budget(5), 0);
    }

    #[test]
    fn aggressive_retry_keeps_safe_reconnects_and_clamps_continuations() {
        for (configured, expected) in [(0, 1), (1, 1), (2, 2), (3, 3), (99, 3)] {
            let settings = AppSettings {
                enable_stream_retry: true,
                stream_retry_mode: StreamRetryMode::Aggressive,
                stream_retry_max_attempts: configured,
                ..AppSettings::default()
            };
            assert_eq!(settings.stream_retry_budget(5), 5);
            assert_eq!(settings.stream_recovery_budget(), expected);
        }
    }
}
