//! Codex 会话日志使用追踪
//!
//! 从 ~/.codex/sessions/ 下的 JSONL 会话文件中提取精确 token 使用数据，
//! 替代原有的 state_5.sqlite 估算方案。
//!
//! ## 数据流
//! ```text
//! ~/.codex/sessions/YYYY/MM/DD/*.jsonl → 增量解析 → delta 计算 → 费用计算 → proxy_request_logs 表
//! ```
//!
//! ## 解析的事件类型
//! - `session_meta` → 提取唯一 thread_id（子代理的 session_id 指向父线程）
//! - `turn_context` → 提取当前 model
//! - `event_msg` (type=token_count) → 提取累计 token 用量，计算 delta

#[path = "session_usage_codex_discovery.rs"]
mod discovery;

#[path = "session_usage_codex_fork.rs"]
mod fork_proof;
use fork_proof::{certify_copied_rollout, CopiedForkProof};

#[cfg(test)]
#[path = "session_usage_codex_fork_tests.rs"]
mod fork_replay_tests;

use crate::codex_config::get_codex_config_dir;
use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::file_revision::{FileIdentity, FileRevision};
use crate::proxy::usage::calculator::{CostCalculator, ModelPricing};
use crate::proxy::usage::parser::TokenUsage;
use crate::services::session_usage::{
    metadata_modified_nanos, update_sync_state, update_sync_state_on_conn, SessionSyncResult,
};
use crate::services::usage_stats::{
    find_model_pricing, has_suspected_codex_session_duplicate, should_skip_session_insert, DedupKey,
};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

const CODEX_THREAD_REQUEST_ID_PREFIX: &str = "codex_session:thread-v1";
const CODEX_FINGERPRINT_BYTES: usize = 4096;

/// 测试用：append 读取字节数按文件路径隔离。
///
/// CI 的 `cargo test` 是并行执行的；进程级单值计数器会被同进程内其它测试的
/// sync_codex_append 读取污染（macOS CI 4245 passed / 2 failed 中
/// "left: 48, right: 0" 即此）。每个测试用自己的 tempdir 路径，按 key 隔离后
/// 并行互不干扰。
#[cfg(test)]
static CODEX_APPEND_BYTES_READ: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, u64>>,
> = std::sync::OnceLock::new();

#[cfg(test)]
fn append_bytes_map() -> &'static std::sync::Mutex<std::collections::HashMap<String, u64>> {
    CODEX_APPEND_BYTES_READ.get_or_init(Default::default)
}

#[cfg(test)]
fn note_codex_append_bytes_read(file: &Path, bytes: u64) {
    if let Ok(mut map) = append_bytes_map().lock() {
        *map.entry(file.to_string_lossy().to_string()).or_insert(0) += bytes;
    }
}

#[cfg(test)]
fn take_codex_append_bytes_read(file: &Path) -> u64 {
    append_bytes_map()
        .lock()
        .map(|mut map| map.remove(&file.to_string_lossy().to_string()).unwrap_or(0))
        .unwrap_or(0)
}

#[cfg(test)]
thread_local! {
    static CODEX_SNAPSHOT_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce(&Path)>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn run_codex_snapshot_test_hook(file_path: &Path) {
    let hook = CODEX_SNAPSHOT_TEST_HOOK.with(|slot| slot.borrow_mut().take());
    if let Some(hook) = hook {
        hook(file_path);
    }
}

#[derive(Debug)]
struct CodexCheckpoint {
    source_path: String,
    last_byte_offset: i64,
    file_size: i64,
    head_window_len: Option<i64>,
    head_fingerprint: Option<i64>,
    tail_fingerprint: Option<i64>,
    state: CodexParserState,
}

/// Physical facts about the rollout file at the moment a byte checkpoint is
/// committed. The in-memory `CodexCheckpoint` only carries what the authority
/// decision reads (size + fingerprints); the persisted row still records mtime
/// for diagnostics.
#[derive(Debug, Clone, Copy)]
struct CodexCheckpointFacts {
    file_size: i64,
    file_modified: i64,
    head_window_len: i64,
    head_fingerprint: i64,
    tail_fingerprint: i64,
}

fn codex_fingerprint(bytes: &[u8]) -> i64 {
    let mut hasher = Sha256::new();
    hasher.update(b"codex-incremental-rollout-v1");
    hasher.update(bytes);
    let digest = hasher.finalize();
    i64::from(u32::from_be_bytes(
        digest[..4].try_into().unwrap_or_default(),
    ))
}

fn read_codex_window(file: &mut fs::File, offset: u64, len: usize) -> Result<Vec<u8>, AppError> {
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| AppError::Config(format!("定位 Codex rollout 指纹失败: {e}")))?;
    let mut bytes = vec![0; len];
    let mut read = 0;
    while read < len {
        let count = file
            .read(&mut bytes[read..])
            .map_err(|e| AppError::Config(format!("读取 Codex rollout 指纹失败: {e}")))?;
        if count == 0 {
            break;
        }
        read += count;
    }
    bytes.truncate(read);
    Ok(bytes)
}

fn codex_head_window_len(size: i64) -> i64 {
    size.clamp(0, CODEX_FINGERPRINT_BYTES as i64)
}

fn codex_head_before(file: &mut fs::File, len: i64) -> Result<i64, AppError> {
    Ok(codex_fingerprint(&read_codex_window(
        file,
        0,
        len.max(0) as usize,
    )?))
}

fn codex_tail_before(file: &mut fs::File, end: i64) -> Result<i64, AppError> {
    let end = end.max(0) as u64;
    let start = end.saturating_sub(CODEX_FINGERPRINT_BYTES as u64);
    // The end is a committed historical boundary. A small rollout can grow
    // after checkpointing; hashing past this boundary would absorb new bytes
    // and falsely turn a normal append into a rewrite.
    Ok(codex_fingerprint(&read_codex_window(
        file,
        start,
        (end - start) as usize,
    )?))
}

/// 累计 token 用量（跟踪 total_token_usage 字段）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct CumulativeTokens {
    input: u64,
    cached_input: u64,
    output: u64,
}

/// 单次 API 调用的 token 增量
#[derive(Debug, Clone)]
struct DeltaTokens {
    input: u32,
    cached_input: u32,
    output: u32,
}

impl DeltaTokens {
    fn is_zero(&self) -> bool {
        self.input == 0 && self.cached_input == 0 && self.output == 0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
struct TokenCountersSignature {
    input: Option<u64>,
    cached_input: Option<u64>,
    output: Option<u64>,
    reasoning_output: Option<u64>,
    total: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
struct TokenUsageSignature {
    total: Option<TokenCountersSignature>,
    last: Option<TokenCountersSignature>,
}

#[derive(Debug)]
struct TimestampedTokenSignature {
    timestamp: DateTime<Utc>,
    signature: TokenUsageSignature,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ParentFileStamp {
    modified_nanos: i64,
    size: u64,
    identity: FileIdentity,
}

impl ParentFileStamp {
    fn from_file(file: &fs::File) -> Option<Self> {
        let metadata = file.metadata().ok()?;
        Some(Self {
            modified_nanos: metadata_modified_nanos(&metadata),
            size: metadata.len(),
            identity: FileIdentity::from_file(file, &metadata)?,
        })
    }

    pub(super) fn same_identity(&self, other: &Self) -> bool {
        self.identity == other.identity
    }

    /// Compare a stamp captured before a bounded read with a later stamp.
    ///
    /// An active rollout is allowed to grow while it is being parsed. A
    /// shrink is always a replacement/truncation, and an equal-size mtime
    /// change indicates an in-place rewrite that must be retried.
    pub(super) fn same_identity_and_not_shrunk(&self, other: &Self) -> bool {
        self.same_identity(other)
            && other.size >= self.size
            && (other.size > self.size || other.modified_nanos == self.modified_nanos)
    }
}

#[derive(Debug)]
struct ParentTokenTimeline {
    events: Vec<TimestampedTokenSignature>,
    max_timestamp: Option<DateTime<Utc>>,
    has_token_without_timestamp: bool,
}

impl ParentTokenTimeline {
    fn signatures_before(
        &self,
        parent_path: &Path,
        cutoff: DateTime<Utc>,
    ) -> Result<Vec<TokenUsageSignature>, String> {
        if self.has_token_without_timestamp {
            return Err(format!(
                "父 rollout {} 的 token_count 缺少有效 timestamp",
                parent_path.display()
            ));
        }
        if self
            .max_timestamp
            .is_none_or(|timestamp| timestamp < cutoff)
        {
            return Err(format!(
                "父 rollout {} 尚未写到 child fork 时刻",
                parent_path.display()
            ));
        }
        Ok(self
            .events
            .iter()
            .filter(|event| event.timestamp <= cutoff)
            .map(|event| event.signature.clone())
            .collect())
    }
}

#[derive(Debug)]
struct CachedParentTimeline {
    stamp: ParentFileStamp,
    revision: Option<FileRevision>,
    content_digest: [u8; 32],
    timeline: Arc<ParentTokenTimeline>,
    retained_order: u64,
    estimated_bytes: usize,
}

// These limits bound only disposable retained derivatives, never the complete
// result returned to accounting. Oversized histories still parse and validate.
const MAX_PARENT_TIMELINES: usize = 256;
const MAX_PARENT_TIMELINE_EVENT_CAPACITY: usize = 4096;
const MAX_PARENT_TOTAL_EVENT_CAPACITY: usize = 32768;
const MAX_PARENT_TIMELINE_BYTES: usize = 1024 * 1024;
const MAX_PARENT_TOTAL_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone)]
struct ParsedTokenEvent {
    line_offset: i64,
    signature: TokenUsageSignature,
    delta: DeltaTokens,
    event_index: Option<u32>,
    model: String,
    timestamp: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
enum ParentResolution {
    None,
    Parent(String),
    Deferred(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ContinuationLink {
    physical_id: String,
    end_ordinal_exclusive: u64,
    end_byte_offset: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ContinuationInfo {
    ancestor_parent_id: Option<String>,
    history_base: Option<ContinuationLink>,
}

/// Durable authority for parent replay; only ordinal- and content-proven forks may
/// append without resolving their parent again. Old checkpoints deserialize to
/// None and are re-certified before their next append.
#[derive(Debug, Clone, Serialize, Deserialize)]
enum CodexReplayVerification {
    Legacy { prefix: usize },
    Copied { first_live_line: i64 },
}

/// Persisted semantic parser state for append-only Codex JSONL files.  This is
/// deliberately a bounded state machine, never an event cache.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CodexParserState {
    version: u8,
    root_thread_id: Option<String>,
    meta_thread_id: Option<String>,
    root_meta_seen: bool,
    root_timestamp: Option<DateTime<Utc>>,
    parent: ParentResolution,
    #[serde(default)]
    continuation: Option<ContinuationInfo>,
    #[serde(default)]
    continuation_accounting_verified: bool,
    is_subagent: bool,
    #[serde(default)]
    replay_verification: Option<CodexReplayVerification>,
    current_model: String,
    total_high_water: Option<CumulativeTokens>,
    #[serde(default)]
    continuation_reset_pending: bool,
    #[serde(skip)]
    saw_total_without_last: bool,
    // JSON object keys cannot be Option<String>; the empty string is the
    // exact on-disk representation of the parser's None rate-limit lane.
    last_signature_by_source: HashMap<String, TokenUsageSignature>,
    previous_token_signature: Option<TokenUsageSignature>,
    event_index: u32,
    has_billable_tokens: bool,
    first_activity_at: Option<i64>,
    last_activity_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    checkpoint_proof: Option<CodexCheckpointProof>,
}

/// The digest covers only complete records through the committed byte cursor.
/// The revision describes the entire file, including any uncommitted tail.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct CodexCheckpointProof {
    revision: Option<i64>,
    prefix_digest: [u8; 32],
}

impl CodexParserState {
    fn initial(root_thread_id: Option<String>) -> Self {
        Self {
            version: 1,
            root_thread_id,
            meta_thread_id: None,
            root_meta_seen: false,
            root_timestamp: None,
            parent: ParentResolution::None,
            continuation: None,
            continuation_accounting_verified: false,
            is_subagent: false,
            replay_verification: None,
            current_model: "unknown".to_string(),
            total_high_water: None,
            continuation_reset_pending: false,
            saw_total_without_last: false,
            last_signature_by_source: HashMap::new(),
            previous_token_signature: None,
            event_index: 0,
            has_billable_tokens: false,
            first_activity_at: None,
            last_activity_at: None,
            checkpoint_proof: None,
        }
    }

    fn valid(&self) -> bool {
        self.version == 1
            && self.last_signature_by_source.len() <= 64
            && !matches!(self.replay_verification, Some(CodexReplayVerification::Copied { first_live_line }) if first_live_line < 2)
    }

    fn replay_contract_current(&self) -> bool {
        self.root_meta_seen
            && match &self.parent {
                ParentResolution::None => {
                    self.continuation.is_none() || self.continuation_accounting_verified
                }
                ParentResolution::Parent(_) => self.replay_verification.is_some(),
                ParentResolution::Deferred(_) => false,
            }
    }

    fn append_authorized(&self) -> bool {
        self.root_meta_seen
            && (matches!(self.parent, ParentResolution::None)
                || (matches!(self.parent, ParentResolution::Parent(_))
                    && matches!(
                        self.replay_verification,
                        Some(CodexReplayVerification::Copied { .. })
                    )))
    }
}

#[derive(Debug)]
struct ParsedCodexFile {
    root_thread_id: Option<String>,
    /// Stable logical thread id from the root `session_meta` record.
    meta_thread_id: Option<String>,
    root_meta_seen: bool,
    root_timestamp: Option<DateTime<Utc>>,
    parent: ParentResolution,
    continuation: Option<ContinuationInfo>,
    token_events: Vec<ParsedTokenEvent>,
    line_offset: i64,
    has_billable_tokens: bool,
}

#[derive(Debug)]
struct CodexParseSnapshot {
    parsed: ParsedCodexFile,
    state: CodexParserState,
    complete_bytes: i64,
    file_size: i64,
    file_modified: i64,
    head_window_len: i64,
    head_fingerprint: i64,
    tail_fingerprint: i64,
    content_digest: [u8; 32],
    complete_digest: [u8; 32],
    missing_continuation_base_prefix: Option<fork_proof::RejectedChildPrefix>,
    continuation_error: Option<PendingReason>,
    file_stamp: Option<ParentFileStamp>,
    verified_revision: Option<FileRevision>,
    // A child-local classification, reusable only after exact byte validation.
    // This is not a parent proof or a cached deferred decision.
    copied_inspection_unavailable: bool,
}

impl CodexParseSnapshot {
    fn verify_reusable_content(&mut self, file_path: &Path) -> Result<(), AppError> {
        let changed =
            || AppError::Config("Codex rollout 在读取 snapshot 期间变化；下轮重试".to_string());
        let open_matching_file = || {
            let file = fs::File::open(file_path)
                .map_err(|e| AppError::Config(format!("打开 Codex snapshot 失败: {e}")))?;
            let metadata = file.metadata().map_err(|e| {
                AppError::Config(format!("读取 Codex snapshot handle 元数据失败: {e}"))
            })?;
            if metadata.len() as i64 != self.file_size
                || metadata_modified_nanos(&metadata) != self.file_modified
                || (self.file_stamp.is_some()
                    && ParentFileStamp::from_file(&file) != self.file_stamp)
            {
                return Err(changed());
            }
            Ok(file)
        };

        let file = open_matching_file()?;
        let revision = FileRevision::from_file(&file);
        if revision.is_some() && revision == self.verified_revision {
            validated_rollout_revision(&file, file_path, revision).map_err(AppError::Config)?;
            return Ok(());
        }

        // Certify the snapshot before retaining a revision. Without matching
        // revision metadata, identity, length and mtime can survive a rewrite.
        let mut file = file.take(self.file_size.max(0) as u64);
        let mut digest = Sha256::new();
        let mut buffer = [0; 8192];
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|e| AppError::Config(format!("读取 Codex snapshot 失败: {e}")))?;
            if read == 0 {
                break;
            }
            digest.update(&buffer[..read]);
            #[cfg(test)]
            CODEX_SNAPSHOT_VERIFY_BYTES_READ.with(|bytes| bytes.set(bytes.get() + read as u64));
        }
        let content_digest: [u8; 32] = digest.finalize().into();
        if file.limit() != 0 || content_digest != self.content_digest {
            return Err(changed());
        }
        let mut fingerprint_file = open_matching_file()?;
        if codex_head_before(&mut fingerprint_file, self.head_window_len)? != self.head_fingerprint
            || codex_tail_before(&mut fingerprint_file, self.complete_bytes)?
                != self.tail_fingerprint
        {
            return Err(changed());
        }
        self.verified_revision = validated_rollout_revision(file.get_ref(), file_path, revision)
            .map_err(AppError::Config)?;
        Ok(())
    }

    /// 提交字节 checkpoint 时应随 snapshot 一并持久化的物理事实。
    fn checkpoint_facts(&self) -> CodexCheckpointFacts {
        CodexCheckpointFacts {
            file_size: self.file_size,
            file_modified: self.file_modified,
            head_window_len: self.head_window_len,
            head_fingerprint: self.head_fingerprint,
            tail_fingerprint: self.tail_fingerprint,
        }
    }
}

/// 只读的、已完成 parent replay 剥离的 rollout token 事件。
///
/// 状态页必须复用此解析器，而不能把 `total_token_usage` 当成可直接相加的请求用量。
///
/// 生产读路径已改为 DB-only（`build_codex_subagent_usage_stats_from_db` 永不重开
/// rollout JSONL）；此结构体属于遗留整文件解析链，仅测试面使用。
#[cfg(test)]
#[derive(Debug, Clone)]
pub(crate) struct VerifiedCodexRolloutUsageEvent {
    pub model: String,
    pub timestamp: DateTime<Utc>,
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
}

/// 解析失败、父 replay 无法验证、或某个可计费用量缺少时间戳时返回 `None`。
/// 这让读侧把它表示成未知，而不是把累计快照猜成真实用量。
///
/// 生产读路径已改为 DB-only；此测试读侧复用生产的完整行 snapshot 与 replay 判定。
#[cfg(test)]
pub(crate) fn read_verified_codex_rollout_usage(
    file_path: &Path,
    rollout_index: &RolloutIndex,
) -> Result<Option<Vec<VerifiedCodexRolloutUsageEvent>>, AppError> {
    let snapshot = parse_codex_snapshot(file_path, None)?;
    let parsed = snapshot.parsed;
    let Ok((replay_prefix, _)) = resolve_codex_replay(
        file_path,
        snapshot.complete_bytes,
        &parsed,
        rollout_index,
        snapshot.file_stamp,
        &mut false,
    ) else {
        return Ok(None);
    };
    let mut events = Vec::new();
    for event in parsed.token_events.iter().skip(replay_prefix) {
        if event.delta.is_zero() {
            continue;
        }
        let Some(timestamp) = event.timestamp.as_deref().and_then(|value| {
            DateTime::parse_from_rfc3339(value)
                .ok()
                .map(|value| value.with_timezone(&Utc))
        }) else {
            return Ok(None);
        };
        events.push(VerifiedCodexRolloutUsageEvent {
            model: event.model.clone(),
            timestamp,
            input_tokens: event.delta.input as u64,
            cached_input_tokens: event.delta.cached_input as u64,
            output_tokens: event.delta.output as u64,
        });
    }
    Ok(Some(events))
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PendingReason {
    MissingParent(String),
    MissingParentPrefix(fork_proof::RejectedChildPrefix),
    MissingContinuationBase(fork_proof::RejectedChildPrefix),
    CheckpointRewrite {
        revision: FileRevision,
        offset: i64,
        expected: [u8; 32],
    },
    Stable(String),
    Retryable(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingEntry {
    modified: i64,
    size: u64,
    reason: PendingReason,
}

// Disposable parser derivatives. Reuse requires a verified file revision or
// exact byte verification. Parent readiness is evaluated separately.
const MAX_RETRYABLE_SNAPSHOTS: usize = 256;
const MAX_RETRYABLE_SNAPSHOT_RECORDS: usize = 512;
const MAX_RETRYABLE_TOTAL_RECORDS: usize = 4096;
const MAX_RETRYABLE_SNAPSHOT_BYTES: usize = 512 * 1024;
const MAX_RETRYABLE_TOTAL_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug)]
struct CachedRetryableSnapshot {
    path: PathBuf,
    snapshot: CodexParseSnapshot,
    records: usize,
    estimated_bytes: usize,
}

impl CodexParseSnapshot {
    fn retryable_retained_allocation_estimate(&self) -> Option<usize> {
        // Do not silently extend this estimator to witnesses, continuations or
        // new authority variants with unaccounted heap allocations.
        if self.parsed.continuation.is_some()
            || self.state.continuation.is_some()
            || self.missing_continuation_base_prefix.is_some()
            || self.state.replay_verification.is_some()
            || !self.state.valid()
            || self.file_stamp.is_none()
            || !matches!(self.parsed.parent, ParentResolution::Parent(_))
            || !matches!(self.state.parent, ParentResolution::Parent(_))
            || self.parsed.token_events.capacity() > MAX_RETRYABLE_SNAPSHOT_RECORDS
        {
            return None;
        }
        let parent_capacity = |parent: &ParentResolution| match parent {
            ParentResolution::Parent(value) => value.capacity(),
            _ => 0,
        };
        let option_capacity = |value: &Option<String>| value.as_ref().map_or(0, String::capacity);
        let mut bytes = std::mem::size_of::<CachedRetryableSnapshot>()
            .saturating_add(
                self.parsed
                    .token_events
                    .capacity()
                    .saturating_mul(std::mem::size_of::<ParsedTokenEvent>()),
            )
            .saturating_add(option_capacity(&self.parsed.root_thread_id))
            .saturating_add(option_capacity(&self.parsed.meta_thread_id))
            .saturating_add(parent_capacity(&self.parsed.parent))
            .saturating_add(option_capacity(&self.state.root_thread_id))
            .saturating_add(option_capacity(&self.state.meta_thread_id))
            .saturating_add(parent_capacity(&self.state.parent))
            .saturating_add(self.state.current_model.capacity())
            // Conservative bucket/control allowance; this is retained Rust
            // allocation accounting, not a measurement of allocator/RSS bytes.
            .saturating_add(
                self.state
                    .last_signature_by_source
                    .capacity()
                    .saturating_mul(
                        2 * (std::mem::size_of::<(String, TokenUsageSignature)>() + 16),
                    ),
            );
        for event in &self.parsed.token_events {
            bytes = bytes
                .saturating_add(event.model.capacity())
                .saturating_add(option_capacity(&event.timestamp));
        }
        for source in self.state.last_signature_by_source.keys() {
            bytes = bytes.saturating_add(source.capacity());
        }
        Some(bytes)
    }
}

impl CodexReplayCaches {
    fn take_retryable_snapshot(&mut self, path: &Path) -> Option<CodexParseSnapshot> {
        let index = self
            .retryable_snapshots
            .iter()
            .position(|entry| entry.path == path)?;
        self.retryable_snapshots
            .remove(index)
            .map(|entry| entry.snapshot)
    }

    fn retain_retryable_snapshot(&mut self, path: &Path, snapshot: CodexParseSnapshot) {
        // Remove stale ownership first, even when this replacement is too big.
        let _ = self.take_retryable_snapshot(path);
        let Some(snapshot_bytes) = snapshot.retryable_retained_allocation_estimate() else {
            return;
        };
        let path = path.to_path_buf();
        let estimated_bytes = snapshot_bytes.saturating_add(path.capacity());
        let records = snapshot.parsed.token_events.len();
        if estimated_bytes > MAX_RETRYABLE_SNAPSHOT_BYTES
            || records > MAX_RETRYABLE_SNAPSHOT_RECORDS
        {
            return;
        }
        // Admission transfers ownership; neither a whole cache nor a snapshot
        // is cloned. FIFO eviction bounds total retained records/allocations.
        while self.retryable_snapshots.len() >= MAX_RETRYABLE_SNAPSHOTS
            || self
                .retryable_snapshots
                .iter()
                .map(|entry| entry.records)
                .sum::<usize>()
                .saturating_add(records)
                > MAX_RETRYABLE_TOTAL_RECORDS
            || self
                .retryable_snapshots
                .iter()
                .map(|entry| entry.estimated_bytes)
                .sum::<usize>()
                .saturating_add(estimated_bytes)
                > MAX_RETRYABLE_TOTAL_BYTES
        {
            let _ = self.retryable_snapshots.pop_front();
        }
        self.retryable_snapshots.push_back(CachedRetryableSnapshot {
            path,
            snapshot,
            records,
            estimated_bytes,
        });
    }

    fn parent_timeline_event_capacity(&self) -> usize {
        self.parent_timelines
            .values()
            .map(|entry| entry.timeline.events.capacity())
            .sum()
    }

    fn parent_timeline_retained_allocation_estimate(&self) -> usize {
        // Account current allocated map capacity even after removals. The
        // multiplier includes conservative bucket/control/slack allowance;
        // this is not allocator/RSS instrumentation.
        let map_bytes = self
            .parent_timelines
            .capacity()
            .saturating_mul(2 * (std::mem::size_of::<(PathBuf, CachedParentTimeline)>() + 16));
        std::mem::size_of::<HashMap<PathBuf, CachedParentTimeline>>()
            .saturating_add(map_bytes)
            .saturating_add(
                self.parent_timelines
                    .values()
                    .map(|entry| entry.estimated_bytes)
                    .sum::<usize>(),
            )
    }

    fn evict_oldest_parent_timeline(&mut self) {
        // FIFO bookkeeping lives only in canonical map values, not a growing
        // secondary queue of duplicate path keys.
        let oldest = self
            .parent_timelines
            .iter()
            .min_by_key(|(_, entry)| entry.retained_order)
            .map(|(path, _)| path.clone());
        if let Some(path) = oldest {
            self.parent_timelines.remove(&path);
        }
    }

    fn retain_parent_timeline(
        &mut self,
        path: &Path,
        stamp: ParentFileStamp,
        revision: Option<FileRevision>,
        content_digest: [u8; 32],
        timeline: &Arc<ParentTokenTimeline>,
    ) {
        self.parent_timelines.remove(path);
        let event_capacity = timeline.events.capacity();
        let base_bytes = std::mem::size_of::<CachedParentTimeline>()
            .saturating_add(std::mem::size_of::<PathBuf>())
            .saturating_add(std::mem::size_of::<ParentTokenTimeline>())
            .saturating_add(2 * std::mem::size_of::<usize>()) // Arc strong/weak counters
            .saturating_add(
                event_capacity.saturating_mul(std::mem::size_of::<TimestampedTokenSignature>()),
            );
        if event_capacity > MAX_PARENT_TIMELINE_EVENT_CAPACITY
            || base_bytes.saturating_add(path.as_os_str().len()) > MAX_PARENT_TIMELINE_BYTES
        {
            return;
        }
        let path = path.to_path_buf();
        let estimated_bytes = base_bytes.saturating_add(path.capacity());
        if estimated_bytes > MAX_PARENT_TIMELINE_BYTES {
            return;
        }
        // Root resets and the unreachable-in-practice sequence wrap release
        // derived storage; sequence state itself is constant-size.
        if self.next_parent_timeline_order == u64::MAX {
            self.parent_timelines = HashMap::new();
            self.next_parent_timeline_order = 0;
        }
        while self.parent_timelines.len() >= MAX_PARENT_TIMELINES
            || self
                .parent_timeline_event_capacity()
                .saturating_add(event_capacity)
                > MAX_PARENT_TOTAL_EVENT_CAPACITY
        {
            self.evict_oldest_parent_timeline();
        }
        self.parent_timelines.reserve(1);
        while self
            .parent_timeline_retained_allocation_estimate()
            .saturating_add(estimated_bytes)
            > MAX_PARENT_TOTAL_BYTES
        {
            if self.parent_timelines.is_empty() {
                // Defensive against a future map/budget contract change: no
                // admission is preferable to an impossible eviction loop.
                self.parent_timelines.shrink_to_fit();
                if self
                    .parent_timeline_retained_allocation_estimate()
                    .saturating_add(estimated_bytes)
                    > MAX_PARENT_TOTAL_BYTES
                {
                    return;
                }
                break;
            }
            self.evict_oldest_parent_timeline();
        }
        let retained_order = self.next_parent_timeline_order;
        self.next_parent_timeline_order += 1;
        self.parent_timelines.insert(
            path,
            CachedParentTimeline {
                stamp,
                revision,
                content_digest,
                timeline: Arc::clone(timeline),
                retained_order,
                estimated_bytes,
            },
        );
    }

    fn retain_discovered_replay_derivatives(&mut self, files: &[PathBuf]) {
        let discovered: HashSet<&Path> = files.iter().map(PathBuf::as_path).collect();
        self.retryable_snapshots
            .retain(|entry| discovered.contains(entry.path.as_path()));
        let previous = self.parent_timelines.len();
        self.parent_timelines
            .retain(|path, _| discovered.contains(path.as_path()));
        if self.parent_timelines.len() != previous {
            if self.parent_timelines.is_empty() {
                self.parent_timelines = HashMap::new();
            } else {
                self.parent_timelines.shrink_to_fit();
            }
        }
    }
}

#[derive(Debug, Default)]
struct CodexReplayCaches {
    parent_timelines: HashMap<PathBuf, CachedParentTimeline>,
    next_parent_timeline_order: u64,
    pending: HashMap<PathBuf, PendingEntry>,
    retryable_snapshots: VecDeque<CachedRetryableSnapshot>,
}

static CODEX_REPLAY_CACHES: OnceLock<Mutex<CodexReplayCaches>> = OnceLock::new();

fn should_warn_for_pending(previous: Option<&PendingEntry>, next: &PendingEntry) -> bool {
    previous.is_none_or(|previous| match (&previous.reason, &next.reason) {
        (PendingReason::MissingParentPrefix(_), PendingReason::MissingParentPrefix(_))
        | (PendingReason::MissingContinuationBase(_), PendingReason::MissingContinuationBase(_))
        | (PendingReason::CheckpointRewrite { .. }, PendingReason::CheckpointRewrite { .. }) => {
            false
        }
        (before, after) => before != after,
    })
}

fn replay_caches() -> &'static Mutex<CodexReplayCaches> {
    CODEX_REPLAY_CACHES.get_or_init(|| Mutex::new(CodexReplayCaches::default()))
}

pub(crate) fn clear_codex_replay_caches() {
    if let Ok(mut caches) = replay_caches().lock() {
        *caches = CodexReplayCaches::default();
    }
}

fn is_rollout_filename(file_name: &str) -> bool {
    if !file_name.starts_with("rollout-") || !file_name.ends_with(".jsonl") {
        return false;
    }
    let stem = file_name.trim_end_matches(".jsonl");
    stem.get(stem.len().saturating_sub(36)..)
        .is_some_and(|candidate| uuid::Uuid::parse_str(candidate).is_ok())
}

fn is_codex_cursor_path(file_path: &str, codex_dir: &Path) -> bool {
    let path = Path::new(file_path);
    let file_name = file_path.rsplit(['/', '\\']).next().unwrap_or_default();
    if !is_rollout_filename(file_name) {
        return false;
    }

    if path.starts_with(codex_dir.join("sessions"))
        || path.starts_with(codex_dir.join("archived_sessions"))
    {
        return true;
    }

    // 兼容用户改过 CODEX_HOME 后遗留、且源文件已不存在的 cursor。只接受
    // 明确目录段 + Codex rollout UUID 文件名，避免宽 codex_dir 误删其他 importer。
    file_path
        .replace('\\', "/")
        .split('/')
        .any(|segment| matches!(segment, "sessions" | "archived_sessions"))
}

fn sqlite_table_exists(conn: &rusqlite::Connection, table: &str) -> Result<bool, AppError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get(0),
    )
    .map_err(|error| AppError::Database(format!("查询表 {table} 失败: {error}")))
}

fn sqlite_column_exists(
    conn: &rusqlite::Connection,
    table: &str,
    column: &str,
) -> Result<bool, AppError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
        rusqlite::params![table, column],
        |row| row.get(0),
    )
    .map_err(|error| AppError::Database(format!("查询列 {table}.{column} 失败: {error}")))
}

pub(crate) fn reset_codex_usage_on_conn(
    conn: &rusqlite::Connection,
    codex_dir: &Path,
) -> Result<(), AppError> {
    if sqlite_table_exists(conn, "proxy_request_logs")?
        && sqlite_column_exists(conn, "proxy_request_logs", "data_source")?
    {
        conn.execute(
            "DELETE FROM proxy_request_logs WHERE data_source = 'codex_session'",
            [],
        )
        .map_err(|error| AppError::Database(format!("清理 Codex 会话明细失败: {error}")))?;
    }
    if sqlite_table_exists(conn, "usage_daily_rollups")?
        && sqlite_column_exists(conn, "usage_daily_rollups", "provider_id")?
    {
        conn.execute(
            "DELETE FROM usage_daily_rollups WHERE provider_id = '_codex_session'",
            [],
        )
        .map_err(|error| AppError::Database(format!("清理 Codex 用量汇总失败: {error}")))?;
    }
    if sqlite_table_exists(conn, "session_log_sync")?
        && sqlite_column_exists(conn, "session_log_sync", "file_path")?
    {
        let paths = {
            let mut statement = conn
                .prepare("SELECT file_path FROM session_log_sync")
                .map_err(|error| {
                    AppError::Database(format!("读取会话同步 cursor 失败: {error}"))
                })?;
            let paths = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| AppError::Database(format!("查询会话同步 cursor 失败: {error}")))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| {
                    AppError::Database(format!("解析会话同步 cursor 失败: {error}"))
                })?;
            paths
        };
        for file_path in paths
            .into_iter()
            .filter(|path| is_codex_cursor_path(path, codex_dir))
        {
            conn.execute(
                "DELETE FROM session_log_sync WHERE file_path = ?1",
                [file_path],
            )
            .map_err(|error| AppError::Database(format!("清理 Codex 同步 cursor 失败: {error}")))?;
        }
    }
    for table in ["codex_usage_file_checkpoints", "codex_usage_sessions"] {
        if sqlite_table_exists(conn, table)? {
            conn.execute(&format!("DELETE FROM {table}"), [])
                .map_err(|error| {
                    AppError::Database(format!("清理 Codex 增量状态表 {table} 失败: {error}"))
                })?;
        }
    }
    Ok(())
}

impl Database {
    pub(crate) fn reset_codex_usage(&self) -> Result<(), AppError> {
        let codex_dir = get_codex_config_dir();
        let conn = lock_conn!(self.conn);
        conn.execute("SAVEPOINT reset_codex_usage", [])
            .map_err(|error| AppError::Database(format!("开启 Codex 重建事务失败: {error}")))?;
        let result = reset_codex_usage_on_conn(&conn, &codex_dir);
        match result {
            Ok(()) => {
                conn.execute("RELEASE reset_codex_usage", [])
                    .map_err(|error| {
                        AppError::Database(format!("提交 Codex 重建事务失败: {error}"))
                    })?;
                drop(conn);
                clear_codex_replay_caches();
                Ok(())
            }
            Err(error) => {
                conn.execute("ROLLBACK TO reset_codex_usage", []).ok();
                conn.execute("RELEASE reset_codex_usage", []).ok();
                Err(error)
            }
        }
    }
}

fn non_empty_string(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn thread_id_from_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let candidate = stem.get(stem.len().checked_sub(36)?..)?;
    uuid::Uuid::parse_str(candidate)
        .ok()
        .map(|value| value.hyphenated().to_string())
}

/// Return the logical thread UUID in a resumed/reverted rollout filename of
/// the form `<thread-id>_<physical-rollout-id>`. Single-UUID names return None.
fn leading_thread_id_from_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let len = stem.len();
    if !stem.get(len.checked_sub(37)?..)?.starts_with('_') {
        return None;
    }
    let candidate = stem.get(len.checked_sub(73)?..len.checked_sub(37)?)?;
    uuid::Uuid::parse_str(candidate)
        .ok()
        .map(|value| value.hyphenated().to_string())
}

fn explicit_parent_from_meta(payload: &serde_json::Value) -> ParentResolution {
    let forked_from = non_empty_string(payload.get("forked_from_id"));
    let spawned_from = payload
        .get("source")
        .and_then(|source| {
            source
                .get("subagent")
                .and_then(|subagent| subagent.get("thread_spawn"))
                .or_else(|| source.get("thread_spawn"))
        })
        .and_then(|spawn| non_empty_string(spawn.get("parent_thread_id")));

    match (forked_from, spawned_from) {
        (None, None) => ParentResolution::None,
        (Some(parent), None) | (None, Some(parent)) => ParentResolution::Parent(parent),
        (Some(forked), Some(spawned)) if forked == spawned => ParentResolution::Parent(forked),
        (Some(forked), Some(spawned)) => ParentResolution::Deferred(format!(
            "forked_from_id ({forked}) 与 thread_spawn.parent_thread_id ({spawned}) 不一致"
        )),
    }
}

fn normalize_thread_id(id: &str) -> Option<String> {
    uuid::Uuid::parse_str(id)
        .ok()
        .map(|value| value.hyphenated().to_string())
}

fn explicit_history_base(payload: &serde_json::Value) -> Result<Option<ContinuationLink>, String> {
    let Some(value) = payload.get("history_base") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let base = value
        .as_object()
        .ok_or_else(|| "history_base must be an object".to_string())?;
    let physical_id = non_empty_string(base.get("thread_id"))
        .and_then(|id| normalize_thread_id(&id))
        .ok_or_else(|| "history_base.thread_id must be a UUID".to_string())?;
    let end_ordinal_exclusive = base
        .get("end_ordinal_exclusive")
        .and_then(serde_json::Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| "history_base.end_ordinal_exclusive must be positive".to_string())?;
    let end_byte_offset = base
        .get("end_byte_offset")
        .and_then(serde_json::Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| "history_base.end_byte_offset must be positive".to_string())?;
    Ok(Some(ContinuationLink {
        physical_id,
        end_ordinal_exclusive,
        end_byte_offset,
    }))
}

fn continuation_from_meta(
    payload: &serde_json::Value,
    file_path: &Path,
    meta_id: Option<&str>,
) -> Result<Option<ContinuationInfo>, String> {
    let Some(logical_id) = meta_id else {
        return Ok(None);
    };
    if leading_thread_id_from_filename(file_path).as_deref() != Some(logical_id) {
        return Ok(None);
    }
    let base = explicit_history_base(payload)?;
    let paginated = payload
        .get("history_mode")
        .and_then(serde_json::Value::as_str)
        == Some("paginated");
    let parent = explicit_parent_from_meta(payload);
    if !paginated && base.is_none() {
        return Ok(None);
    }
    let ancestor_parent_id = match parent {
        ParentResolution::Parent(parent) => Some(
            normalize_thread_id(&parent)
                .ok_or_else(|| "paginated parent_thread_id must be a UUID".to_string())?,
        ),
        ParentResolution::None => None,
        ParentResolution::Deferred(reason) => return Err(reason),
    };
    Ok(Some(ContinuationInfo {
        ancestor_parent_id,
        history_base: base,
    }))
}

fn parse_timestamp(value: Option<&serde_json::Value>) -> Option<DateTime<Utc>> {
    value
        .and_then(serde_json::Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
}

fn parse_signature_counters(value: Option<&serde_json::Value>) -> Option<TokenCountersSignature> {
    let value = value?.as_object()?;
    Some(TokenCountersSignature {
        input: value
            .get("input_tokens")
            .and_then(serde_json::Value::as_u64),
        cached_input: value
            .get("cached_input_tokens")
            .or_else(|| value.get("cache_read_input_tokens"))
            .and_then(serde_json::Value::as_u64),
        output: value
            .get("output_tokens")
            .and_then(serde_json::Value::as_u64),
        reasoning_output: value
            .get("reasoning_output_tokens")
            .and_then(serde_json::Value::as_u64),
        total: value
            .get("total_tokens")
            .and_then(serde_json::Value::as_u64),
    })
}

fn parse_token_signature(info: &serde_json::Value) -> Option<TokenUsageSignature> {
    let total = parse_signature_counters(info.get("total_token_usage"));
    let last = parse_signature_counters(info.get("last_token_usage"));
    (total.is_some() || last.is_some()).then_some(TokenUsageSignature { total, last })
}

fn token_snapshot_source(payload: &serde_json::Value) -> Option<String> {
    payload
        .get("rate_limits")
        .and_then(|rate_limits| rate_limits.get("limit_id"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// A derived lookup snapshot, never a second persisted source of truth. Load
/// database rows once per collection; filename misses must not scan either table.
/// Cursor inheritance retains pass-start visibility. Committed checkpoint writes
/// and migration removals update the checkpoint projection within this pass.
struct CodexSyncPass {
    cursors: HashMap<String, (i64, i64)>,
    cursor_names: HashMap<String, BTreeSet<(i64, i64, String)>>,
    checkpoints: HashMap<String, CodexCheckpointRow>,
    checkpoint_names: HashMap<String, BTreeSet<(i64, std::cmp::Reverse<i64>, String)>>,
    pricing: HashMap<String, Option<ModelPricing>>,
    continuation_sources: ContinuationSources,
}

#[cfg(test)]
thread_local! {
    // Compact checkpoint rows, cursor rows, checkpoint filename candidates,
    // cursor filename candidates, and selected parser payload rows actually read.
    static CODEX_LOOKUP_WORK: std::cell::Cell<[usize; 5]> = const { std::cell::Cell::new([0; 5]) };
}

#[cfg(test)]
fn count_codex_lookup_work(index: usize) {
    CODEX_LOOKUP_WORK.with(|work| {
        let mut counts = work.get();
        counts[index] += 1;
        work.set(counts);
    });
}

// Match the old independent slash/backslash suffix checks. On Unix a
// backslash can be part of the filename, so splitting only at the last of both
// separators loses a valid slash-prefixed filename. At most two keys per row;
// bare filenames still do not match, and equal keys are included only once.
fn stored_codex_filenames(path: &str) -> impl Iterator<Item = &str> {
    let slash = path.rsplit_once('/').map(|(_, name)| name);
    let backslash = path
        .rsplit_once('\\')
        .map(|(_, name)| name)
        .filter(|name| Some(*name) != slash);
    [slash, backslash].into_iter().flatten()
}

struct CodexCheckpointRow {
    path: String,
    updated_at: i64,
    rowid: i64,
}

impl CodexCheckpointRow {
    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        #[cfg(test)]
        count_codex_lookup_work(0);
        Ok(Self {
            path: row.get(0)?,
            updated_at: row.get(1)?,
            rowid: row.get(2)?,
        })
    }

    fn order_key(&self) -> (i64, std::cmp::Reverse<i64>, String) {
        // SQLite's previous timestamp ordering visited the earliest rowid on ties.
        (
            self.updated_at,
            std::cmp::Reverse(self.rowid),
            self.path.clone(),
        )
    }
}

const CODEX_CHECKPOINT_INDEX_COLUMNS: &str =
    "SELECT file_path, updated_at, rowid FROM codex_usage_file_checkpoints";
const CODEX_CHECKPOINT_PAYLOAD_COLUMNS: &str =
    "SELECT file_path, last_byte_offset, file_size, head_window_len,
    head_fingerprint, tail_fingerprint, parser_state FROM codex_usage_file_checkpoints";

fn read_codex_checkpoint_payload(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<Option<CodexCheckpoint>> {
    #[cfg(test)]
    count_codex_lookup_work(4);
    let state_text: String = row.get(6)?;
    let state = serde_json::from_str::<CodexParserState>(&state_text).ok();
    let Some(state) = state.filter(CodexParserState::valid) else {
        return Ok(None);
    };
    Ok(Some(CodexCheckpoint {
        source_path: row.get(0)?,
        last_byte_offset: row.get(1)?,
        file_size: row.get(2)?,
        head_window_len: row.get(3)?,
        head_fingerprint: row.get(4)?,
        tail_fingerprint: row.get(5)?,
        state,
    }))
}

impl CodexSyncPass {
    fn load(db: &Database) -> Result<Self, AppError> {
        let conn = lock_conn!(db.conn);
        let mut pass = Self {
            cursors: HashMap::new(),
            cursor_names: HashMap::new(),
            checkpoints: HashMap::new(),
            checkpoint_names: HashMap::new(),
            pricing: HashMap::new(),
            continuation_sources: ContinuationSources::default(),
        };
        let mut stmt = conn
            .prepare("SELECT file_path, last_modified, last_line_offset FROM session_log_sync")
            .map_err(|e| AppError::Database(format!("预载同步游标失败: {e}")))?;
        let rows = stmt
            .query_map([], |row| {
                #[cfg(test)]
                count_codex_lookup_work(1);
                Ok((
                    row.get::<_, String>(0)?,
                    (row.get::<_, i64>(1)?, row.get::<_, i64>(2)?),
                ))
            })
            .map_err(|e| AppError::Database(format!("预载同步游标失败: {e}")))?;
        for row in rows {
            let (path, (modified, offset)) =
                row.map_err(|e| AppError::Database(format!("预载同步游标失败: {e}")))?;
            for name in stored_codex_filenames(&path) {
                pass.cursor_names
                    .entry(name.to_owned())
                    .or_default()
                    .insert((offset, modified, path.clone()));
            }
            pass.cursors.insert(path, (modified, offset));
        }
        let mut stmt = conn
            .prepare(CODEX_CHECKPOINT_INDEX_COLUMNS)
            .map_err(|e| AppError::Database(format!("预载 Codex checkpoints 失败: {e}")))?;
        let rows = stmt
            .query_map([], CodexCheckpointRow::read)
            .map_err(|e| AppError::Database(format!("预载 Codex checkpoints 失败: {e}")))?;
        for row in rows {
            pass.insert_checkpoint(
                row.map_err(|e| AppError::Database(format!("预载 Codex checkpoints 失败: {e}")))?,
            );
        }
        Ok(pass)
    }

    fn remove_checkpoint(&mut self, path: &str) {
        if let Some(row) = self.checkpoints.remove(path) {
            for name in stored_codex_filenames(path) {
                let name = name.to_ascii_lowercase();
                if let Some(candidates) = self.checkpoint_names.get_mut(&name) {
                    candidates.remove(&row.order_key());
                    if candidates.is_empty() {
                        self.checkpoint_names.remove(&name);
                    }
                }
            }
        }
    }

    fn insert_checkpoint(&mut self, row: CodexCheckpointRow) {
        self.remove_checkpoint(&row.path);
        for name in stored_codex_filenames(&row.path) {
            self.checkpoint_names
                .entry(name.to_ascii_lowercase())
                .or_default()
                .insert(row.order_key());
        }
        self.checkpoints.insert(row.path.clone(), row);
    }

    fn refresh_checkpoint_on_conn(
        &mut self,
        conn: &rusqlite::Connection,
        file: &Path,
    ) -> Result<(), AppError> {
        let path = file.to_string_lossy();
        let row = conn
            .query_row(
                &format!("{CODEX_CHECKPOINT_INDEX_COLUMNS} WHERE file_path = ?1"),
                [path.as_ref()],
                CodexCheckpointRow::read,
            )
            .map_err(|e| AppError::Database(format!("刷新 Codex checkpoint 快照失败: {e}")))?;
        self.insert_checkpoint(row);
        Ok(())
    }

    fn checkpoint_source(&self, file: &Path) -> Option<&str> {
        let path = file.to_string_lossy();
        // An invalid exact row is still authoritative: never inherit an alias.
        if let Some(row) = self.checkpoints.get(path.as_ref()) {
            return Some(&row.path);
        }
        let name = file.file_name()?.to_str()?.to_ascii_lowercase();
        let (_, _, source) = self.checkpoint_names.get(&name)?.last()?;
        #[cfg(test)]
        count_codex_lookup_work(2);
        Some(source)
    }

    fn checkpoint(&self, db: &Database, file: &Path) -> Result<Option<CodexCheckpoint>, AppError> {
        let Some(source) = self.checkpoint_source(file) else {
            return Ok(None);
        };
        // Only this selected payload is read/decoded. The snapshot retains no
        // historical parser state, and every hit uses the primary-key index.
        let conn = lock_conn!(db.conn);
        let result = conn
            .prepare_cached(&format!(
                "{CODEX_CHECKPOINT_PAYLOAD_COLUMNS} WHERE file_path=?1"
            ))
            .and_then(|mut stmt| stmt.query_row([source], read_codex_checkpoint_payload));
        match result {
            Ok(checkpoint) => Ok(checkpoint),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(AppError::Database(format!(
                "读取 Codex checkpoint 失败: {error}"
            ))),
        }
    }

    fn remove_cursor(&mut self, path: &str) {
        if let Some((modified, offset)) = self.cursors.remove(path) {
            for name in stored_codex_filenames(path) {
                if let Some(candidates) = self.cursor_names.get_mut(name) {
                    candidates.remove(&(offset, modified, path.to_owned()));
                    if candidates.is_empty() {
                        self.cursor_names.remove(name);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
fn load_codex_checkpoint(
    db: &Database,
    file_path: &Path,
) -> Result<Option<CodexCheckpoint>, AppError> {
    CodexSyncPass::load(db)?.checkpoint(db, file_path)
}

fn save_codex_checkpoint_on_conn(
    conn: &rusqlite::Connection,
    file_path: &Path,
    state: &CodexParserState,
    byte_offset: i64,
    facts: &CodexCheckpointFacts,
) -> Result<(), AppError> {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    let state_text = serde_json::to_string(state)
        .map_err(|e| AppError::Config(format!("序列化 Codex parser state 失败: {e}")))?;
    conn.execute(
        "INSERT INTO codex_usage_file_checkpoints
         (file_path, session_id, last_byte_offset, last_complete_line_offset, file_size, file_modified,
          head_window_len, head_fingerprint, tail_fingerprint, parser_state, updated_at)
         VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(file_path) DO UPDATE SET session_id=excluded.session_id,
           last_byte_offset=excluded.last_byte_offset, file_size=excluded.file_size,
           file_modified=excluded.file_modified, head_window_len=excluded.head_window_len, head_fingerprint=excluded.head_fingerprint,
           tail_fingerprint=excluded.tail_fingerprint, parser_state=excluded.parser_state,
           updated_at=excluded.updated_at",
        rusqlite::params![
            file_path.to_string_lossy().to_string(),
            state.meta_thread_id.as_ref().or(state.root_thread_id.as_ref()),
            byte_offset,
            facts.file_size,
            facts.file_modified,
            facts.head_window_len,
            facts.head_fingerprint,
            facts.tail_fingerprint,
            state_text,
            now,
        ],
    ).map_err(|e| AppError::Database(format!("保存 Codex checkpoint 失败: {e}")))?;
    Ok(())
}

fn get_codex_sync_state(
    db: &Database,
    file_path: &Path,
    pass: &CodexSyncPass,
) -> Result<(i64, i64), AppError> {
    let file_path_str = file_path.to_string_lossy().to_string();
    let state = pass.cursors.get(&file_path_str).copied().unwrap_or((0, 0));
    if state != (0, 0)
        || file_path
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            != Some("archived_sessions")
    {
        return Ok(state);
    }

    let Some(file_name) = file_path.file_name().and_then(|name| name.to_str()) else {
        return Ok(state);
    };
    // Filename index retains the previous (offset, modified) ordering. At most
    // two candidates are visited: only this exact path can be excluded.
    let inherited = pass.cursor_names.get(file_name).and_then(|candidates| {
        candidates
            .iter()
            .rev()
            .find_map(|(offset, modified, path)| {
                #[cfg(test)]
                count_codex_lookup_work(3);
                (path != &file_path_str).then_some((*offset, *modified))
            })
    });

    match inherited {
        Some((offset, modified)) => {
            update_sync_state(db, &file_path_str, modified, offset)?;
            Ok((modified, offset))
        }
        None => Ok(state),
    }
}

/// 归一化 Codex 模型名
///
/// 处理规则（按顺序）：
/// 1. 转小写：`GLM-4.6` → `glm-4.6`
/// 2. 剥离 provider 前缀：`openai/gpt-5.4` → `gpt-5.4`
/// 3. 剥离 ISO 日期后缀：`gpt-5.4-2026-03-05` → `gpt-5.4`
/// 4. 剥离紧凑日期后缀：`gpt-5.4-20260305` → `gpt-5.4`
fn normalize_codex_model(raw: &str) -> String {
    // Step 1: 小写
    let mut name = raw.to_lowercase();

    // Step 2: 剥离 "provider/" 前缀（如 openai/, azure/）
    if let Some(pos) = name.rfind('/') {
        name = name[pos + 1..].to_string();
    }

    // Step 3: 剥离 ISO 日期后缀 -YYYY-MM-DD（正好 11 字符）
    if name.len() > 11 && name.is_char_boundary(name.len() - 11) {
        let suffix = &name[name.len() - 11..];
        if suffix.is_ascii()
            && suffix.as_bytes()[0] == b'-'
            && suffix[1..5].chars().all(|c| c.is_ascii_digit())
            && suffix.as_bytes()[5] == b'-'
            && suffix[6..8].chars().all(|c| c.is_ascii_digit())
            && suffix.as_bytes()[8] == b'-'
            && suffix[9..11].chars().all(|c| c.is_ascii_digit())
        {
            name.truncate(name.len() - 11);
        }
    }

    // Step 4: 剥离紧凑日期后缀 -YYYYMMDD（正好 9 字符）
    if name.len() > 9 {
        let parts: Vec<&str> = name.rsplitn(2, '-').collect();
        if parts.len() == 2 {
            if let Some(suffix) = parts.first() {
                if suffix.len() == 8 && suffix.chars().all(|c| c.is_ascii_digit()) {
                    name = parts[1].to_string();
                }
            }
        }
    }

    name
}

/// 计算两次累计值之间的 delta
fn compute_delta(prev: &Option<CumulativeTokens>, current: &CumulativeTokens) -> DeltaTokens {
    match prev {
        None => DeltaTokens {
            input: current.input as u32,
            cached_input: current.cached_input as u32,
            output: current.output as u32,
        },
        Some(p) => DeltaTokens {
            input: current.input.saturating_sub(p.input) as u32,
            cached_input: current.cached_input.saturating_sub(p.cached_input) as u32,
            output: current.output.saturating_sub(p.output) as u32,
        },
    }
}

fn update_high_water(high_water: &mut CumulativeTokens, current: &CumulativeTokens) {
    high_water.input = high_water.input.max(current.input);
    high_water.cached_input = high_water.cached_input.max(current.cached_input);
    high_water.output = high_water.output.max(current.output);
}

/// 从 JSON Value 中提取累计 token 用量
fn parse_cumulative_tokens(total_usage: &serde_json::Value) -> Option<CumulativeTokens> {
    let fields = total_usage.as_object()?;
    if ![
        "input_tokens",
        "cached_input_tokens",
        "cache_read_input_tokens",
        "output_tokens",
        "reasoning_output_tokens",
        "total_tokens",
    ]
    .iter()
    .any(|field| fields.contains_key(*field))
    {
        return None;
    }
    Some(CumulativeTokens {
        input: total_usage
            .get("input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        cached_input: total_usage
            .get("cached_input_tokens")
            .or_else(|| total_usage.get("cache_read_input_tokens"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        output: total_usage
            .get("output_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
    })
}

pub(crate) type RolloutIndex = HashMap<String, Vec<PathBuf>>;

#[derive(Debug)]
struct CodexDiscoveryOwner {
    root: PathBuf,
    state: discovery::CodexDiscoveryState,
}

static CODEX_DISCOVERY: OnceLock<Mutex<Option<CodexDiscoveryOwner>>> = OnceLock::new();

fn discover_codex_session_files(codex_dir: &Path) -> Result<Vec<PathBuf>, AppError> {
    let root = if codex_dir.is_dir() {
        fs::canonicalize(codex_dir)
            .map_err(|error| AppError::Config(format!("无法规范化 Codex 配置目录: {error}")))?
    } else {
        codex_dir.to_path_buf()
    };
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    let mut cache = CODEX_DISCOVERY
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|error| AppError::Database(format!("Codex discovery mutex poisoned: {error}")))?;
    if cache.as_ref().is_some_and(|cached| cached.root != root) {
        // A settings change moves discovery ownership, not just its next scan.
        // Keep the normal bounded scan schedule only while the owner is current.
        *cache = None;
        clear_codex_replay_caches();
    }
    let cached = cache.get_or_insert_with(|| CodexDiscoveryOwner {
        root: root.clone(),
        state: discovery::CodexDiscoveryState::new(vec![
            discovery::CodexDiscoveryRoot {
                kind: discovery::CodexDiscoveryRootKind::Sessions,
                path: root.join("sessions"),
            },
            discovery::CodexDiscoveryRoot {
                kind: discovery::CodexDiscoveryRootKind::ArchivedSessions,
                path: root.join("archived_sessions"),
            },
        ]),
    });
    let batch = cached.state.discover_at(now)?;
    if batch.full_scan {
        log::debug!(
            "[CODEX-SYNC] discovery 全量扫描: {} 个候选文件",
            batch.paths.len()
        );
    }
    Ok(batch.paths)
}

#[derive(Debug, Default)]
struct CodexFileSyncResult {
    imported: u32,
    skipped: u32,
    suspected_duplicates: u32,
    deferred: bool,
}

/// 同步 Codex 使用数据（从 JSONL 会话日志）
pub fn sync_codex_usage(db: &Database) -> Result<SessionSyncResult, AppError> {
    let codex_dir = get_codex_config_dir();
    let files = discover_codex_session_files(&codex_dir)?;
    let rollout_index = build_rollout_index(&files);
    if let Ok(mut caches) = replay_caches().lock() {
        caches.retain_discovered_replay_derivatives(&files);
    }
    let mut pass = CodexSyncPass::load(db)?;

    let mut result = SessionSyncResult {
        imported: 0,
        skipped: 0,
        files_scanned: files.len() as u32,
        suspected_duplicates: 0,
        deferred_files: 0,
        errors: vec![],
    };

    for file_path in &files {
        match sync_single_codex_file(db, file_path, &rollout_index, &mut pass) {
            Ok(file_result) => {
                result.imported = result.imported.saturating_add(file_result.imported);
                result.skipped = result.skipped.saturating_add(file_result.skipped);
                result.suspected_duplicates = result
                    .suspected_duplicates
                    .saturating_add(file_result.suspected_duplicates);
                if file_result.deferred {
                    result.deferred_files = result.deferred_files.saturating_add(1);
                }
            }
            Err(e) => {
                let msg = format!("Codex 会话文件解析失败 {}: {e}", file_path.display());
                log::warn!("[CODEX-SYNC] {msg}");
                result.errors.push(msg);
            }
        }
    }

    if result.imported > 0 || result.deferred_files > 0 {
        log::info!(
            "[CODEX-SYNC] 同步完成: 导入 {} 条, 跳过 {} 条, deferred {} 个, 扫描 {} 个文件",
            result.imported,
            result.skipped,
            result.deferred_files,
            result.files_scanned
        );
    }

    Ok(result)
}

/// 收集所有 Codex 会话 JSONL 文件（遗留读路径；生产采集走 `discover_codex_session_files`）
#[cfg(test)]
fn collect_codex_session_files(codex_dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();

    // 1. 扫描 sessions/YYYY/MM/DD/*.jsonl（日期分区目录）
    let sessions_dir = codex_dir.join("sessions");
    if sessions_dir.is_dir() {
        collect_jsonl_recursive(&sessions_dir, &mut files, 0, 3);
    }

    // 2. 扫描 archived_sessions/*.jsonl（扁平归档目录）
    let archived_dir = codex_dir.join("archived_sessions");
    if archived_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&archived_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                    files.push(path);
                }
            }
        }
    }

    files.sort();
    files
}

pub(crate) fn build_rollout_index(files: &[PathBuf]) -> RolloutIndex {
    let mut index = RolloutIndex::new();
    for path in files {
        if let Some(thread_id) = thread_id_from_filename(path) {
            index.entry(thread_id).or_default().push(path.clone());
        }
    }
    for paths in index.values_mut() {
        paths.sort();
    }
    index
}

/// 递归扫描目录下的 .jsonl 文件（限制最大深度）
#[cfg(test)]
fn collect_jsonl_recursive(dir: &Path, files: &mut Vec<PathBuf>, depth: u32, max_depth: u32) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && depth < max_depth {
            collect_jsonl_recursive(&path, files, depth + 1, max_depth);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
}

/// 整文件解析器（含 parent replay 剥离）；生产路径使用增量解析器
/// `parse_codex_snapshot`/`parse_codex_incremental_line`，此函数仅测试面使用。
#[cfg(test)]
fn parse_codex_file(
    file_path: &Path,
    root_thread_id: Option<String>,
) -> Result<ParsedCodexFile, AppError> {
    let file =
        fs::File::open(file_path).map_err(|e| AppError::Config(format!("无法打开文件: {e}")))?;
    let reader = BufReader::new(file);
    let mut root_meta_seen = false;
    let mut root_timestamp = None;
    let mut meta_thread_id = None;
    let mut parent = ParentResolution::None;
    let mut continuation = None;
    let mut current_model = "unknown".to_string();
    // `total_token_usage` is session-cumulative, including across model and
    // rate-limit bucket changes. Divergent snapshots are handled by preferring
    // exact `last_token_usage`, not by splitting the cumulative baseline.
    let mut total_high_water = None;
    // Rate-limit refreshes can re-emit unchanged token info under another
    // `limit_id`. Same-source repeats are identified by that source's latest
    // full snapshot; cross-source repeats must match the immediately preceding
    // token event. Do not compare against other sources' older snapshots:
    // those stale signatures can legitimately recur after a counter reset.
    let mut last_signature_by_source: HashMap<Option<String>, TokenUsageSignature> = HashMap::new();
    let mut previous_token_signature = None;
    let mut event_index = 0u32;
    let mut token_events = Vec::new();
    let mut line_offset = 0i64;
    let mut has_billable_tokens = false;

    for line_result in reader.lines() {
        line_offset += 1;
        let line = match line_result {
            Ok(line) => line,
            Err(_) => continue,
        };
        if line.trim().is_empty() {
            continue;
        }

        let is_event_msg = line.contains("\"event_msg\"");
        let is_turn_context = line.contains("\"turn_context\"");
        let is_session_meta = line.contains("\"session_meta\"");
        if !is_event_msg && !is_turn_context && !is_session_meta {
            continue;
        }
        if is_event_msg
            && !line.contains("\"token_count\"")
            && !line.contains("\"thread_settings_applied\"")
        {
            continue;
        }

        let value: serde_json::Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let Some(event_type) = value.get("type").and_then(serde_json::Value::as_str) else {
            continue;
        };

        match event_type {
            "session_meta" if !root_meta_seen => {
                root_meta_seen = true;
                root_timestamp = parse_timestamp(value.get("timestamp"));
                let payload = value.get("payload").unwrap_or(&serde_json::Value::Null);
                parent = explicit_parent_from_meta(payload);

                meta_thread_id = non_empty_string(
                    payload
                        .get("id")
                        .or_else(|| payload.get("thread_id"))
                        .or_else(|| payload.get("threadId")),
                )
                .map(|id| {
                    uuid::Uuid::parse_str(&id)
                        .map(|value| value.hyphenated().to_string())
                        .unwrap_or(id)
                });
                if let (Some(filename_id), Some(meta_id)) =
                    (&root_thread_id, meta_thread_id.as_ref())
                {
                    let leading_id = leading_thread_id_from_filename(file_path);
                    if filename_id != meta_id && leading_id.as_deref() != Some(meta_id.as_str()) {
                        parent = ParentResolution::Deferred(format!(
                            "文件名线程 ID ({filename_id}) 与 root meta ID ({meta_id}) 不一致"
                        ));
                    }
                }

                if !matches!(parent, ParentResolution::Deferred(_)) {
                    match continuation_from_meta(payload, file_path, meta_thread_id.as_deref()) {
                        Ok(Some(value)) => {
                            parent = ParentResolution::None;
                            continuation = Some(value);
                        }
                        Ok(None) => {}
                        Err(reason) => parent = ParentResolution::Deferred(reason),
                    }
                }
                if let ParentResolution::Parent(parent_id) = &mut parent {
                    match uuid::Uuid::parse_str(parent_id) {
                        Ok(value) => *parent_id = value.hyphenated().to_string(),
                        Err(_) => {
                            parent = ParentResolution::Deferred(format!(
                                "显式 parent_thread_id 不是有效 UUID: {parent_id}"
                            ));
                        }
                    }
                }
                if matches!((&root_thread_id, &parent), (Some(root), ParentResolution::Parent(parent_id)) if root == parent_id)
                {
                    parent = ParentResolution::Deferred(
                        "parent_thread_id 与 root_thread_id 相同".to_string(),
                    );
                }
            }
            "turn_context" => {
                if let Some(payload) = value.get("payload") {
                    if let Some(model) = payload
                        .get("model")
                        .or_else(|| payload.get("info").and_then(|info| info.get("model")))
                        .and_then(serde_json::Value::as_str)
                    {
                        current_model = normalize_codex_model(model);
                    }
                }
            }
            "event_msg"
                if value
                    .pointer("/payload/type")
                    .and_then(serde_json::Value::as_str)
                    == Some("thread_settings_applied") =>
            {
                if let Some(model) = value.get("payload").and_then(|payload| {
                    owned_codex_settings_model(payload, meta_thread_id.as_deref())
                }) {
                    current_model = normalize_codex_model(model);
                }
            }
            "event_msg" => {
                let Some(payload) = value.get("payload") else {
                    continue;
                };
                if payload.get("type").and_then(serde_json::Value::as_str) != Some("token_count") {
                    continue;
                }
                let Some(info) = payload.get("info").filter(|info| !info.is_null()) else {
                    continue;
                };
                let Some(signature) = parse_token_signature(info) else {
                    continue;
                };

                if let Some(model) = info
                    .get("model")
                    .or_else(|| info.get("model_name"))
                    .or_else(|| payload.get("model"))
                    .and_then(serde_json::Value::as_str)
                {
                    current_model = normalize_codex_model(model);
                }

                let snapshot_source = token_snapshot_source(payload);
                let total = info
                    .get("total_token_usage")
                    .and_then(parse_cumulative_tokens);
                let last = info
                    .get("last_token_usage")
                    .and_then(parse_cumulative_tokens);
                if total.is_none() && last.is_none() {
                    continue;
                }
                let has_total_snapshot = total.is_some();
                let duplicate_snapshot = has_total_snapshot
                    && (last_signature_by_source.get(&snapshot_source) == Some(&signature)
                        || previous_token_signature.as_ref() == Some(&signature));
                if has_total_snapshot {
                    last_signature_by_source.insert(snapshot_source, signature.clone());
                }
                previous_token_signature = Some(signature.clone());

                let delta = if duplicate_snapshot {
                    DeltaTokens {
                        input: 0,
                        cached_input: 0,
                        output: 0,
                    }
                } else if let Some(last) = last {
                    // Codex provides the exact per-request usage. Prefer it to
                    // subtracting cumulative snapshots, which may come from
                    // multiple independently advancing rate-limit lanes.
                    DeltaTokens {
                        input: last.input as u32,
                        cached_input: last.cached_input as u32,
                        output: last.output as u32,
                    }
                } else if let Some(total) = total.as_ref() {
                    compute_delta(&total_high_water, total)
                } else {
                    continue;
                };
                if let Some(total) = total {
                    if let Some(high_water) = total_high_water.as_mut() {
                        update_high_water(high_water, &total);
                    } else {
                        total_high_water = Some(total);
                    }
                }
                let delta = DeltaTokens {
                    cached_input: delta.cached_input.min(delta.input),
                    ..delta
                };
                let nonzero_index = if delta.is_zero() {
                    None
                } else {
                    has_billable_tokens = true;
                    event_index = event_index.saturating_add(1);
                    Some(event_index)
                };

                token_events.push(ParsedTokenEvent {
                    line_offset,
                    signature,
                    delta,
                    event_index: nonzero_index,
                    model: current_model.clone(),
                    timestamp: value
                        .get("timestamp")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned),
                });
            }
            _ => {}
        }
    }

    Ok(ParsedCodexFile {
        root_thread_id,
        meta_thread_id,
        root_meta_seen,
        root_timestamp,
        parent,
        continuation,
        token_events,
        line_offset,
        has_billable_tokens,
    })
}

fn owned_codex_settings_model<'a>(
    payload: &'a serde_json::Value,
    thread_id: Option<&str>,
) -> Option<&'a str> {
    if payload.get("type").and_then(serde_json::Value::as_str) != Some("thread_settings_applied") {
        return None;
    }
    let owner = payload
        .get("thread_id")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| uuid::Uuid::parse_str(value).ok())?;
    let expected = uuid::Uuid::parse_str(thread_id?).ok()?;
    (owner == expected).then_some(())?;
    payload
        .get("thread_settings")?
        .get("model")?
        .as_str()
        .filter(|value| !value.trim().is_empty())
}

/// Parse one already-complete JSONL record with the same accounting rules as
/// `parse_codex_file`.  The append reader calls this only after a newline was
/// observed, so an incomplete UTF-8/JSON tail never mutates persisted state.
fn parse_codex_incremental_line(
    file_path: &Path,
    state: &mut CodexParserState,
    line: &str,
    line_offset: i64,
) -> Option<ParsedTokenEvent> {
    if line.trim().is_empty() {
        return None;
    }
    let is_event_msg = line.contains("\"event_msg\"");
    let is_turn_context = line.contains("\"turn_context\"");
    let is_session_meta = line.contains("\"session_meta\"");
    let skips_literal_types = (!is_event_msg && !is_turn_context && !is_session_meta)
        || (is_event_msg
            && !line.contains("\"token_count\"")
            && !line.contains("\"thread_settings_applied\""));
    // JSON may escape letters inside a discriminator. A raw miss cannot
    // exclude those records from continuation accounting.
    if skips_literal_types && !line.contains("\\u") {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let event_type = value.get("type")?.as_str()?;
    match event_type {
        "session_meta" if !state.root_meta_seen => {
            state.root_meta_seen = true;
            state.root_timestamp = parse_timestamp(value.get("timestamp"));
            let payload = value.get("payload").unwrap_or(&serde_json::Value::Null);
            state.parent = explicit_parent_from_meta(payload);
            state.is_subagent = payload
                .get("source")
                .and_then(|source| {
                    source
                        .get("subagent")
                        .and_then(|subagent| subagent.get("thread_spawn"))
                        .or_else(|| source.get("thread_spawn"))
                })
                .and_then(|spawn| spawn.get("parent_thread_id"))
                .and_then(serde_json::Value::as_str)
                .is_some();
            state.meta_thread_id = non_empty_string(
                payload
                    .get("id")
                    .or_else(|| payload.get("thread_id"))
                    .or_else(|| payload.get("threadId")),
            )
            .map(|id| {
                uuid::Uuid::parse_str(&id)
                    .map(|value| value.hyphenated().to_string())
                    .unwrap_or(id)
            });
            if let (Some(filename_id), Some(meta_id)) =
                (&state.root_thread_id, state.meta_thread_id.as_ref())
            {
                let leading_id = leading_thread_id_from_filename(file_path);
                if filename_id != meta_id && leading_id.as_deref() != Some(meta_id.as_str()) {
                    state.parent = ParentResolution::Deferred(format!(
                        "文件名线程 ID ({filename_id}) 与 root meta ID ({meta_id}) 不一致"
                    ));
                }
            }
            if !matches!(state.parent, ParentResolution::Deferred(_)) {
                match continuation_from_meta(payload, file_path, state.meta_thread_id.as_deref()) {
                    Ok(Some(value)) => {
                        state.parent = ParentResolution::None;
                        state.continuation = Some(value);
                        state.continuation_accounting_verified = true;
                    }
                    Ok(None) => {}
                    Err(reason) => state.parent = ParentResolution::Deferred(reason),
                }
            }
            if let ParentResolution::Parent(parent_id) = &mut state.parent {
                match uuid::Uuid::parse_str(parent_id) {
                    Ok(value) => *parent_id = value.hyphenated().to_string(),
                    Err(_) => {
                        state.parent = ParentResolution::Deferred(format!(
                            "显式 parent_thread_id 不是有效 UUID: {parent_id}"
                        ))
                    }
                }
            }
            if matches!((&state.root_thread_id, &state.parent), (Some(root), ParentResolution::Parent(parent_id)) if root == parent_id)
            {
                state.parent = ParentResolution::Deferred(
                    "parent_thread_id 与 root_thread_id 相同".to_string(),
                );
            }
            None
        }
        "turn_context" => {
            if let Some(model) = value
                .get("payload")
                .and_then(|payload| {
                    payload
                        .get("model")
                        .or_else(|| payload.get("info").and_then(|info| info.get("model")))
                })
                .and_then(serde_json::Value::as_str)
            {
                state.current_model = normalize_codex_model(model);
            }
            None
        }
        "event_msg"
            if value
                .pointer("/payload/type")
                .and_then(serde_json::Value::as_str)
                == Some("thread_settings_applied") =>
        {
            if let Some(model) = value.get("payload").and_then(|payload| {
                owned_codex_settings_model(payload, state.meta_thread_id.as_deref())
            }) {
                state.current_model = normalize_codex_model(model);
            }
            None
        }
        "event_msg" => {
            let payload = value.get("payload")?;
            if payload.get("type")?.as_str()? != "token_count" {
                return None;
            }
            let info = payload.get("info").filter(|info| !info.is_null())?;
            let signature = parse_token_signature(info)?;
            if let Some(model) = info
                .get("model")
                .or_else(|| info.get("model_name"))
                .or_else(|| payload.get("model"))
                .and_then(serde_json::Value::as_str)
            {
                state.current_model = normalize_codex_model(model);
            }
            let snapshot_source = token_snapshot_source(payload);
            let lane = snapshot_source.clone().unwrap_or_default();
            let total = info
                .get("total_token_usage")
                .and_then(parse_cumulative_tokens);
            let last = info
                .get("last_token_usage")
                .and_then(parse_cumulative_tokens);
            state.saw_total_without_last |= total.is_some() && last.is_none();
            if total.is_none() && last.is_none() {
                return None;
            }
            if state.continuation.is_some()
                && last.is_none()
                && total.is_some()
                && state.total_high_water.is_none()
            {
                state.parent = ParentResolution::Deferred(
                    "continuation total-only usage has no verified cumulative baseline".to_string(),
                );
                return None;
            }
            let has_total_snapshot = total.is_some();
            let continuation_counter_reset = state.continuation_reset_pending
                && state.continuation.is_some()
                && state.total_high_water.is_some()
                && total.as_ref().is_some_and(|total| {
                    state
                        .total_high_water
                        .as_ref()
                        .is_some_and(|baseline| total.input < baseline.input)
                });
            let duplicate_snapshot = has_total_snapshot
                && !continuation_counter_reset
                && (state.last_signature_by_source.get(&lane) == Some(&signature)
                    || state.previous_token_signature.as_ref() == Some(&signature));
            if has_total_snapshot {
                state
                    .last_signature_by_source
                    .insert(lane, signature.clone());
            }
            state.previous_token_signature = Some(signature.clone());
            let delta = if duplicate_snapshot {
                DeltaTokens {
                    input: 0,
                    cached_input: 0,
                    output: 0,
                }
            } else if let Some(last) = last.as_ref() {
                DeltaTokens {
                    input: last.input as u32,
                    cached_input: last.cached_input as u32,
                    output: last.output as u32,
                }
            } else if let Some(total) = total.as_ref() {
                if continuation_counter_reset {
                    DeltaTokens {
                        input: total.input as u32,
                        cached_input: total.cached_input as u32,
                        output: total.output as u32,
                    }
                } else {
                    compute_delta(&state.total_high_water, total)
                }
            } else {
                return None;
            };
            state.continuation_reset_pending = false;
            if state.continuation.is_some() && total.is_none() && last.is_some() {
                state.total_high_water = None;
            }
            if let Some(total) = total {
                if continuation_counter_reset {
                    state.total_high_water = Some(total);
                } else if let Some(high_water) = state.total_high_water.as_mut() {
                    update_high_water(high_water, &total);
                } else {
                    state.total_high_water = Some(total);
                }
            }
            let delta = DeltaTokens {
                cached_input: delta.cached_input.min(delta.input),
                ..delta
            };
            let event_index = if delta.is_zero() {
                None
            } else {
                state.has_billable_tokens = true;
                state.event_index = state.event_index.saturating_add(1);
                Some(state.event_index)
            };
            let timestamp = value
                .get("timestamp")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            if event_index.is_some() {
                if let Some(activity_at) = timestamp
                    .as_deref()
                    .and_then(|timestamp| DateTime::parse_from_rfc3339(timestamp).ok())
                    .map(|timestamp| timestamp.timestamp())
                {
                    state.first_activity_at = Some(
                        state
                            .first_activity_at
                            .map_or(activity_at, |current| current.min(activity_at)),
                    );
                    state.last_activity_at = Some(
                        state
                            .last_activity_at
                            .map_or(activity_at, |current| current.max(activity_at)),
                    );
                }
            }
            Some(ParsedTokenEvent {
                line_offset,
                signature,
                delta,
                event_index,
                model: state.current_model.clone(),
                timestamp,
            })
        }
        _ => None,
    }
}

#[cfg(test)]
thread_local! {
    static CODEX_SNAPSHOT_PARSE_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static CODEX_COPIED_CHILD_INSPECTION_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static CODEX_PARENT_TIMELINE_PARSES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static CODEX_PARENT_TIMELINE_PARSE_BYTES: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    static CODEX_PARENT_TIMELINE_VERIFY_BYTES: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    static BEFORE_CODEX_PARENT_TIMELINE_VERIFY: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    static BEFORE_CODEX_PARENT_BYTES_VALIDATION_FINISH: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    static CODEX_SNAPSHOT_BYTES_READ: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    static CODEX_SNAPSHOT_VERIFY_BYTES_READ: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    static CODEX_CONTINUATION_SOURCE_BYTES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static CODEX_CONTINUATION_VERIFY_BYTES: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    static CODEX_CHECKPOINT_ROOT_RECORDS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static CODEX_CHECKPOINT_ROOT_BYTES_READ: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    static CODEX_CHECKPOINT_PREFIX_BYTES_READ: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    static BEFORE_CODEX_SNAPSHOT_REUSE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}

/// Read one bounded file snapshot. The opened handle captures the size/mtime
/// boundary and this reader is capped at that size, so a concurrent append is
/// deliberately left for the next pass rather than being accidentally
/// checkpointed.
#[cfg(test)]
fn parse_codex_snapshot(
    file_path: &Path,
    continuation_context: Option<(&RolloutIndex, &mut ContinuationSources)>,
) -> Result<CodexParseSnapshot, AppError> {
    parse_codex_snapshot_with_baseline(file_path, continuation_context, None, None)
}

fn parse_codex_snapshot_with_baseline(
    file_path: &Path,
    mut continuation_context: Option<(&RolloutIndex, &mut ContinuationSources)>,
    baseline: Option<CumulativeTokens>,
    checkpoint_prefix: Option<(i64, [u8; 32])>,
) -> Result<CodexParseSnapshot, AppError> {
    #[cfg(test)]
    CODEX_SNAPSHOT_PARSE_COUNT.with(|count| count.set(count.get() + 1));
    let mut file = fs::File::open(file_path)
        .map_err(|e| AppError::Config(format!("打开 Codex snapshot 失败: {e}")))?;
    let file_stamp = ParentFileStamp::from_file(&file);
    let opened_metadata = file
        .metadata()
        .map_err(|e| AppError::Config(format!("读取 Codex snapshot handle 元数据失败: {e}")))?;
    let file_size = opened_metadata.len() as i64;
    let file_modified = metadata_modified_nanos(&opened_metadata);
    let head_window_len = codex_head_window_len(file_size);
    let head_fingerprint = codex_head_before(&mut file, head_window_len)?;
    let initial_tail_fingerprint = codex_tail_before(&mut file, file_size)?;
    file.seek(SeekFrom::Start(0))
        .map_err(|e| AppError::Config(format!("定位 Codex snapshot 失败: {e}")))?;
    #[cfg(test)]
    run_codex_snapshot_test_hook(file_path);
    let mut reader = BufReader::new(file.take(file_size.max(0) as u64));
    let mut state = CodexParserState::initial(thread_id_from_filename(file_path));
    state.total_high_water = baseline;
    state.continuation_reset_pending = state.total_high_water.is_some();
    let mut events = Vec::new();
    let mut buffer = Vec::new();
    let mut digest = Sha256::new();
    let mut missing_continuation_base_prefix = None;
    let mut continuation_error = None;
    let mut baseline_after_token_events = None;
    let mut complete_bytes = 0i64;
    let mut line_offset = 0i64;
    let complete_digest;
    let mut unmatched_prefix = checkpoint_prefix.filter(|(offset, _)| *offset > 0);
    let changed_prefix =
        || AppError::Config("Codex checkpoint prefix 在重放期间变化；下轮重试".to_string());
    loop {
        buffer.clear();
        let read = reader
            .read_until(b'\n', &mut buffer)
            .map_err(|e| AppError::Config(format!("读取 Codex snapshot 失败: {e}")))?;
        #[cfg(test)]
        CODEX_SNAPSHOT_BYTES_READ.with(|bytes| bytes.set(bytes.get() + read as u64));
        if read == 0 || !buffer.ends_with(b"\n") {
            if unmatched_prefix.is_some() {
                return Err(changed_prefix());
            }
            complete_digest = digest.clone().finalize().into();
            digest.update(&buffer);
            break;
        }
        digest.update(&buffer);
        complete_bytes += read as i64;
        if let Some((offset, expected)) = unmatched_prefix {
            if complete_bytes >= offset {
                if complete_bytes != offset
                    || <[u8; 32]>::from(digest.clone().finalize()) != expected
                {
                    return Err(changed_prefix());
                }
                unmatched_prefix = None;
            }
        }
        line_offset += 1;
        if let Ok(line) = std::str::from_utf8(&buffer) {
            let root_meta_seen = state.root_meta_seen;
            if let Some(event) =
                parse_codex_incremental_line(file_path, &mut state, line, line_offset)
            {
                events.push(event);
            }
            if let (false, true, Some((rollout_index, sources)), Some(link), Some(logical_id)) = (
                root_meta_seen,
                state.root_meta_seen,
                continuation_context.as_mut(),
                state
                    .continuation
                    .as_ref()
                    .and_then(|page| page.history_base.as_ref()),
                state.meta_thread_id.as_deref(),
            ) {
                match resolve_continuation_baseline(
                    file_path,
                    logical_id,
                    link,
                    state.root_timestamp,
                    rollout_index,
                    sources,
                ) {
                    Ok(value) if events.is_empty() => {
                        state.total_high_water = Some(value);
                        state.continuation_reset_pending = true;
                    }
                    // Older histories may have token records ahead of the root
                    // metadata. Preserve their original baseline accounting.
                    Ok(value) => baseline_after_token_events = Some(value),
                    Err(reason) => {
                        continuation_error =
                            Some(if rollout_index.contains_key(&link.physical_id) {
                                PendingReason::Retryable(reason)
                            } else {
                                PendingReason::MissingParent(link.physical_id.clone())
                            });
                    }
                }
            }
        }
        // The first accepted paginated metadata and a billable token record
        // are sufficient to reject a page with no history_base. Certify only
        // that bounded physical prefix, so later output cannot force a replay.
        if missing_continuation_base_prefix.is_none()
            && complete_bytes as u64 <= fork_proof::MAX_REJECTED_PREFIX_BYTES
            && state.has_billable_tokens
            && state
                .continuation
                .as_ref()
                .is_some_and(|page| page.history_base.is_none())
        {
            missing_continuation_base_prefix = file_stamp.and_then(|stamp| {
                fork_proof::RejectedChildPrefix::from_verified_prefix(
                    stamp,
                    complete_bytes as u64,
                    digest.clone().finalize().into(),
                )
            });
        }
    }
    let reader_stamp = ParentFileStamp::from_file(reader.get_ref().get_ref());
    if let (Some(initial), Some(current)) = (file_stamp, reader_stamp) {
        if !initial.same_identity_and_not_shrunk(&current) {
            return Err(AppError::Config(
                "Codex snapshot 在解析期间变化；下轮重试".to_string(),
            ));
        }
    }
    let parsed = ParsedCodexFile {
        root_thread_id: state.root_thread_id.clone(),
        meta_thread_id: state.meta_thread_id.clone(),
        root_meta_seen: state.root_meta_seen,
        root_timestamp: state.root_timestamp,
        parent: state.parent.clone(),
        continuation: state.continuation.clone(),
        token_events: events,
        line_offset,
        has_billable_tokens: state.has_billable_tokens,
    };
    let mut fingerprint_file = fs::File::open(file_path)
        .map_err(|e| AppError::Config(format!("打开 Codex snapshot prefix 指纹失败: {e}")))?;
    let fingerprint_stamp = ParentFileStamp::from_file(&fingerprint_file);
    if let (Some(initial), Some(current)) = (file_stamp, fingerprint_stamp) {
        if !initial.same_identity_and_not_shrunk(&current) {
            return Err(AppError::Config(
                "Codex snapshot 在指纹读取前被替换；下轮重试".to_string(),
            ));
        }
    }
    let current_head_fingerprint = codex_head_before(&mut fingerprint_file, head_window_len)?;
    if current_head_fingerprint != head_fingerprint {
        return Err(AppError::Config(
            "Codex snapshot 在解析期间前缀被替换；下轮重试".to_string(),
        ));
    }
    let current_tail_fingerprint = codex_tail_before(&mut fingerprint_file, file_size)?;
    if current_tail_fingerprint != initial_tail_fingerprint {
        return Err(AppError::Config(
            "Codex snapshot 在解析期间内容被改写；下轮重试".to_string(),
        ));
    }
    let tail_fingerprint = codex_tail_before(&mut fingerprint_file, complete_bytes)?;
    if continuation_error.is_some()
        && !state.saw_total_without_last
        && !incomplete_codex_record_requires_baseline(&buffer)
    {
        continuation_error = None;
    }
    if let Some(baseline) = baseline_after_token_events {
        let reparsed =
            parse_codex_snapshot_with_baseline(file_path, None, Some(baseline), checkpoint_prefix)?;
        if reparsed.content_digest != <[u8; 32]>::from(digest.finalize()) {
            return Err(AppError::Config(
                "Codex rollout 在读取 snapshot 期间变化；下轮重试".to_string(),
            ));
        }
        return Ok(reparsed);
    }
    Ok(CodexParseSnapshot {
        parsed,
        state,
        complete_bytes,
        file_size,
        file_modified,
        head_window_len,
        head_fingerprint,
        tail_fingerprint,
        content_digest: digest.finalize().into(),
        complete_digest,
        missing_continuation_base_prefix,
        continuation_error,
        file_stamp: fingerprint_stamp.or(file_stamp),
        verified_revision: None,
        copied_inspection_unavailable: false,
    })
}

fn incomplete_codex_record_requires_baseline(record: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(record) else {
        return false;
    };
    if value.get("type").and_then(serde_json::Value::as_str) != Some("event_msg")
        || value
            .pointer("/payload/type")
            .and_then(serde_json::Value::as_str)
            != Some("token_count")
    {
        return false;
    }
    value
        .pointer("/payload/info/total_token_usage")
        .and_then(parse_cumulative_tokens)
        .is_some()
        && value
            .pointer("/payload/info/last_token_usage")
            .and_then(parse_cumulative_tokens)
            .is_none()
}

#[derive(Debug, Clone)]
struct ContinuationSource {
    meta_id: String,
    timestamp: Option<DateTime<Utc>>,
    history_base: Option<ContinuationLink>,
    continuation: bool,
    latest_total: Option<CumulativeTokens>,
    has_usage: bool,
}

#[derive(Default)]
struct ContinuationSources {
    entries: HashMap<(PathBuf, u64, u64), CachedContinuationSource>,
}

struct CachedContinuationSource {
    source: ContinuationSource,
    digest: [u8; 32],
    revision: Option<FileRevision>,
}

impl ContinuationSources {
    fn read(
        &mut self,
        path: &Path,
        cutoff: &ContinuationLink,
    ) -> Result<ContinuationSource, String> {
        let key = (
            path.to_path_buf(),
            cutoff.end_byte_offset,
            cutoff.end_ordinal_exclusive,
        );
        let mut file = fs::File::open(path)
            .map_err(|error| format!("cannot open predecessor {}: {error}", path.display()))?;
        let revision = FileRevision::from_file(&file);
        let stamp = ParentFileStamp::from_file(&file);
        if let (Some(cached), Some(stamp)) = (self.entries.get_mut(&key), stamp) {
            if let Some(revision) = revision.filter(|revision| Some(*revision) == cached.revision) {
                validated_rollout_revision(&file, path, Some(revision))?;
                return Ok(cached.source.clone());
            }
            // A changed file can still have the same declared prefix after an
            // append. Reuse the summary only after checking the exact cutoff.
            if stamp.size >= cutoff.end_byte_offset
                && validate_parent_bytes(&mut file, path, stamp, cutoff.end_byte_offset, false)?
                    == cached.digest
            {
                cached.revision = validated_rollout_revision(&file, path, revision)?;
                return Ok(cached.source.clone());
            }
        }
        file.seek(SeekFrom::Start(0))
            .map_err(|error| format!("cannot seek predecessor {}: {error}", path.display()))?;
        let (source, digest) = read_continuation_source(&mut file, path, cutoff, stamp)?;
        let revision = validated_rollout_revision(&file, path, revision)?;
        if stamp.is_some() && (self.entries.len() < 64 || self.entries.contains_key(&key)) {
            self.entries.insert(
                key,
                CachedContinuationSource {
                    source: source.clone(),
                    digest,
                    revision,
                },
            );
        }
        Ok(source)
    }
}

fn read_continuation_source(
    file: &mut fs::File,
    path: &Path,
    cutoff: &ContinuationLink,
    stamp: Option<ParentFileStamp>,
) -> Result<(ContinuationSource, [u8; 32]), String> {
    let file_len = file
        .metadata()
        .map_err(|error| format!("cannot stat predecessor {}: {error}", path.display()))?
        .len();
    if cutoff.end_ordinal_exclusive == 0 || cutoff.end_byte_offset > file_len {
        return Err(format!(
            "invalid history_base cutoff: ordinal={}, offset={}, predecessor length={file_len}",
            cutoff.end_ordinal_exclusive, cutoff.end_byte_offset
        ));
    }
    if !crate::codex_runtime_refresh::paginated_history::history_base_cutoff_is_consistent(
        path,
        cutoff.end_byte_offset,
        cutoff.end_ordinal_exclusive,
    )? {
        return Err(format!(
            "history_base cutoff for {} is not consistent",
            cutoff.physical_id
        ));
    }
    let mut meta_id = None;
    let mut timestamp = None;
    let mut history_base = None;
    let mut continuation = false;
    let mut latest_total = None;
    let mut has_usage = false;
    let mut reader = BufReader::new(file.take(cutoff.end_byte_offset));
    let mut digest = Sha256::new();
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .map_err(|error| format!("cannot read predecessor {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        digest.update(line.as_bytes());
        #[cfg(test)]
        CODEX_CONTINUATION_SOURCE_BYTES.with(|count| count.set(count.get() + read));
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        match value.get("type").and_then(serde_json::Value::as_str) {
            Some("session_meta") if meta_id.is_none() => {
                let payload = value.get("payload").unwrap_or(&serde_json::Value::Null);
                meta_id = non_empty_string(
                    payload
                        .get("id")
                        .or_else(|| payload.get("thread_id"))
                        .or_else(|| payload.get("threadId")),
                )
                .map(|id| normalize_thread_id(&id).unwrap_or(id));
                timestamp = parse_timestamp(value.get("timestamp"));
                history_base = explicit_history_base(payload)?;
                continuation = meta_id
                    .as_deref()
                    .map(|id| continuation_from_meta(payload, path, Some(id)))
                    .transpose()?
                    .flatten()
                    .is_some();
            }
            Some("event_msg")
                if value
                    .get("payload")
                    .and_then(|payload| payload.get("type"))
                    .and_then(serde_json::Value::as_str)
                    == Some("token_count") =>
            {
                let info = value.get("payload").and_then(|payload| payload.get("info"));
                let total = info
                    .and_then(|info| info.get("total_token_usage"))
                    .and_then(parse_cumulative_tokens);
                let last = info
                    .and_then(|info| info.get("last_token_usage"))
                    .and_then(parse_cumulative_tokens);
                if total.is_some() || last.is_some() {
                    has_usage = true;
                }
                if total.is_none() && last.is_some() {
                    latest_total = None;
                }
                if let Some(total) = total {
                    if let Some(high_water) = latest_total.as_mut() {
                        update_high_water(high_water, &total);
                    } else {
                        latest_total = Some(total);
                    }
                }
            }
            _ => {}
        }
    }
    let source = ContinuationSource {
        meta_id: meta_id
            .ok_or_else(|| format!("predecessor {} has no session_meta", path.display()))?,
        timestamp,
        history_base,
        continuation,
        latest_total,
        has_usage,
    };
    if reader.get_ref().limit() != 0 {
        return Err(format!("incomplete predecessor prefix {}", path.display()));
    }
    let digest = digest.finalize().into();
    if let Some(stamp) = stamp {
        let file = reader.into_inner().into_inner();
        if validate_parent_bytes(file, path, stamp, cutoff.end_byte_offset, false)? != digest {
            return Err(format!(
                "predecessor {} changed during parsing",
                path.display()
            ));
        }
    }
    Ok((source, digest))
}

fn validated_rollout_revision(
    file: &fs::File,
    path: &Path,
    revision: Option<FileRevision>,
) -> Result<Option<FileRevision>, String> {
    if revision.is_some_and(|revision| {
        FileRevision::read(path) != Some(revision)
            || FileRevision::from_file(file) != Some(revision)
    }) {
        return Err(format!(
            "rollout {} changed during validation",
            path.display()
        ));
    }
    Ok(revision)
}

fn resolve_continuation_baseline(
    file_path: &Path,
    logical_id: &str,
    initial_link: &ContinuationLink,
    current_timestamp: Option<DateTime<Utc>>,
    rollout_index: &RolloutIndex,
    sources: &mut ContinuationSources,
) -> Result<CumulativeTokens, String> {
    let current_id = thread_id_from_filename(file_path)
        .ok_or_else(|| "continuation filename has no physical UUID".to_string())?;
    let mut visited = HashSet::from([current_id.clone()]);
    let mut next_link = initial_link.clone();
    let mut later_timestamp = Some(
        current_timestamp
            .ok_or_else(|| "continuation session_meta has no valid timestamp".to_string())?,
    );
    let mut direct_baseline = None;
    loop {
        let base_id = normalize_thread_id(&next_link.physical_id)
            .ok_or_else(|| format!("invalid history_base thread_id: {}", next_link.physical_id))?;
        if !visited.insert(base_id.clone()) {
            return Err(format!("history_base chain contains a cycle at {base_id}"));
        }
        let candidates = rollout_index
            .get(&base_id)
            .ok_or_else(|| format!("missing history_base predecessor {base_id}"))?;
        if candidates.len() != 1 {
            return Err(format!(
                "history_base physical UUID {base_id} resolves to {} files",
                candidates.len()
            ));
        }
        let source = sources.read(&candidates[0], &next_link)?;
        if source.meta_id != logical_id {
            return Err(format!(
                "history_base predecessor {base_id} belongs to logical thread {}, expected {logical_id}",
                source.meta_id
            ));
        }
        let predecessor_time = source
            .timestamp
            .ok_or_else(|| format!("predecessor {base_id} has no valid session_meta timestamp"))?;
        if later_timestamp.is_some_and(|later| predecessor_time >= later) {
            return Err(format!(
                "history_base predecessor {base_id} is not earlier than its successor"
            ));
        }
        if direct_baseline.is_none() {
            if source.latest_total.is_none() && source.has_usage {
                return Err(format!(
                    "predecessor {base_id} has usage without a cumulative token baseline"
                ));
            }
            direct_baseline = source.latest_total.clone();
        }
        if !source.continuation {
            return direct_baseline
                .ok_or_else(|| format!("predecessor {base_id} has no cumulative token baseline"));
        }
        later_timestamp = source.timestamp;
        next_link = source
            .history_base
            .as_ref()
            .ok_or_else(|| format!("continuation predecessor {base_id} has no history_base"))?
            .clone();
    }
}

fn validate_parent_timeline_bytes(
    file: &mut fs::File,
    path: &Path,
    expected: ParentFileStamp,
) -> Result<[u8; 32], String> {
    validate_parent_bytes(file, path, expected, expected.size, true)
}

fn validate_parent_bytes(
    file: &mut fs::File,
    path: &Path,
    expected: ParentFileStamp,
    limit: u64,
    _is_parent_timeline: bool,
) -> Result<[u8; 32], String> {
    let changed = || format!("父 rollout {} 在验证期间变化；下轮重试", path.display());
    if ParentFileStamp::from_file(file) != Some(expected) {
        return Err(changed());
    }
    file.seek(SeekFrom::Start(0)).map_err(|_| changed())?;
    let mut bounded = file.take(limit);
    let mut digest = Sha256::new();
    let mut buffer = [0; 8192];
    loop {
        let read = bounded.read(&mut buffer).map_err(|_| changed())?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        #[cfg(test)]
        if _is_parent_timeline {
            CODEX_PARENT_TIMELINE_VERIFY_BYTES.with(|bytes| bytes.set(bytes.get() + read as u64));
        } else {
            CODEX_CONTINUATION_VERIFY_BYTES.with(|bytes| bytes.set(bytes.get() + read as u64));
        }
    }
    #[cfg(test)]
    if _is_parent_timeline {
        if let Some(change) = BEFORE_CODEX_PARENT_BYTES_VALIDATION_FINISH.with(|hook| hook.take()) {
            change();
        }
    }
    if bounded.limit() != 0
        || ParentFileStamp::from_file(bounded.get_ref()) != Some(expected)
        || fs::File::open(path)
            .ok()
            .and_then(|file| ParentFileStamp::from_file(&file))
            != Some(expected)
    {
        return Err(changed());
    }
    Ok(digest.finalize().into())
}

fn parent_signatures_before(
    parent_path: &Path,
    cutoff: DateTime<Utc>,
) -> Result<Vec<TokenUsageSignature>, String> {
    match load_parent_timeline(parent_path) {
        Ok(timeline) => timeline.signatures_before(parent_path, cutoff),
        Err(error) => {
            if let Ok(mut caches) = replay_caches().lock() {
                caches.parent_timelines.remove(parent_path);
            }
            Err(error)
        }
    }
}

fn load_parent_timeline(parent_path: &Path) -> Result<Arc<ParentTokenTimeline>, String> {
    let mut file = fs::File::open(parent_path)
        .map_err(|error| format!("无法打开父 rollout {}: {error}", parent_path.display()))?;
    let revision = FileRevision::from_file(&file);
    let stamp = ParentFileStamp::from_file(&file)
        .ok_or_else(|| format!("无法验证父 rollout {} 的文件身份", parent_path.display()))?;
    let cached_timeline = replay_caches().lock().ok().and_then(|mut caches| {
        if caches
            .parent_timelines
            .get(parent_path)
            .is_some_and(|entry| entry.stamp != stamp)
        {
            caches.parent_timelines.remove(parent_path);
        }
        caches.parent_timelines.get(parent_path).map(|entry| {
            (
                Arc::clone(&entry.timeline),
                entry.content_digest,
                entry.revision,
            )
        })
    });
    if let Some((timeline, content_digest, cached_revision)) = cached_timeline {
        if let Some(revision) = revision.filter(|revision| Some(*revision) == cached_revision) {
            #[cfg(test)]
            if let Some(change) =
                BEFORE_CODEX_PARENT_BYTES_VALIDATION_FINISH.with(|hook| hook.take())
            {
                change();
            }
            validated_rollout_revision(&file, parent_path, Some(revision))?;
            return Ok(timeline);
        }
        if validate_parent_timeline_bytes(&mut file, parent_path, stamp)? == content_digest {
            let verified_revision = validated_rollout_revision(&file, parent_path, revision)?;
            if let Ok(mut caches) = replay_caches().lock() {
                if let Some(entry) = caches.parent_timelines.get_mut(parent_path) {
                    if Arc::ptr_eq(&entry.timeline, &timeline) {
                        entry.revision = verified_revision;
                    }
                }
            }
            return Ok(timeline);
        }
        if let Ok(mut caches) = replay_caches().lock() {
            caches.parent_timelines.remove(parent_path);
        }
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("无法定位父 rollout {}: {error}", parent_path.display()))?;
    #[cfg(test)]
    CODEX_PARENT_TIMELINE_PARSES.with(|count| count.set(count.get() + 1));
    let mut events = Vec::new();
    let mut max_timestamp: Option<DateTime<Utc>> = None;
    let mut has_token_without_timestamp = false;
    let mut digest = Sha256::new();
    let mut reader = BufReader::new((&mut file).take(stamp.size));
    let mut line = Vec::new();
    // Record order is not timestamp order. Hash exact raw bytes while parsing
    // the complete captured boundary, including an unterminated final record.
    loop {
        line.clear();
        let read = reader
            .read_until(b'\n', &mut line)
            .map_err(|error| format!("无法读取父 rollout {}: {error}", parent_path.display()))?;
        if read == 0 {
            break;
        }
        digest.update(&line);
        #[cfg(test)]
        CODEX_PARENT_TIMELINE_PARSE_BYTES.with(|bytes| bytes.set(bytes.get() + read as u64));
        if line.last() == Some(&b'\n') {
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
        }
        let Ok(line) = std::str::from_utf8(&line) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let timestamp = parse_timestamp(value.get("timestamp"));
        if let Some(timestamp) = timestamp {
            max_timestamp = Some(max_timestamp.map_or(timestamp, |current| current.max(timestamp)));
        }
        if value.get("type").and_then(serde_json::Value::as_str) != Some("event_msg")
            || value
                .get("payload")
                .and_then(|payload| payload.get("type"))
                .and_then(serde_json::Value::as_str)
                != Some("token_count")
        {
            continue;
        }
        let Some(info) = value
            .get("payload")
            .and_then(|payload| payload.get("info"))
            .filter(|info| !info.is_null())
        else {
            continue;
        };
        let Some(signature) = parse_token_signature(info) else {
            continue;
        };
        let Some(timestamp) = timestamp else {
            has_token_without_timestamp = true;
            continue;
        };
        events.push(TimestampedTokenSignature {
            timestamp,
            signature,
        });
    }
    let remaining = reader.get_ref().limit();
    drop(reader);
    let content_digest: [u8; 32] = digest.finalize().into();
    // Keep the parsed snapshot and content proof tied even if a middle rewrite
    // preserved all stat fields during parsing. Never publish a mixed timeline.
    #[cfg(test)]
    if let Some(rewrite) = BEFORE_CODEX_PARENT_TIMELINE_VERIFY.with(|hook| hook.take()) {
        rewrite();
    }
    if remaining != 0
        || validate_parent_timeline_bytes(&mut file, parent_path, stamp)? != content_digest
    {
        return Err(format!(
            "父 rollout {} 在解析期间变化；下轮重试",
            parent_path.display()
        ));
    }
    let revision = validated_rollout_revision(&file, parent_path, revision)?;
    let timeline = Arc::new(ParentTokenTimeline {
        events,
        max_timestamp,
        has_token_without_timestamp,
    });
    if let Ok(mut caches) = replay_caches().lock() {
        caches.retain_parent_timeline(parent_path, stamp, revision, content_digest, &timeline);
    }
    Ok(timeline)
}

fn resolve_parent_signatures(
    parent_id: &str,
    cutoff: DateTime<Utc>,
    rollout_index: &RolloutIndex,
) -> Result<Vec<TokenUsageSignature>, String> {
    let Some(candidates) = rollout_index.get(parent_id) else {
        return Err(format!("找不到父 rollout: {parent_id}"));
    };

    let mut snapshots = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        snapshots.push(parent_signatures_before(candidate, cutoff)?);
    }
    let Some(first) = snapshots.first() else {
        return Err(format!("找不到父 rollout: {parent_id}"));
    };
    if snapshots.iter().skip(1).any(|snapshot| snapshot != first) {
        return Err(format!(
            "父 rollout UUID {parent_id} 对应多个内容不一致的文件"
        ));
    }
    Ok(first.clone())
}

fn matching_replay_prefix(child: &[ParsedTokenEvent], parent: &[TokenUsageSignature]) -> usize {
    let mut parent_offset = 0usize;
    let mut matched = 0usize;
    for event in child {
        let Some(relative_match) = parent[parent_offset..]
            .iter()
            .position(|signature| signature == &event.signature)
        else {
            break;
        };
        parent_offset += relative_match + 1;
        matched += 1;
    }
    matched
}

/// Resolve inherited usage from an explicit fork boundary plus exact content.
/// Copied layouts without authoritative ordinals stay deferred, even if a
/// later resume marker and token payloads match. Truly legacy layouts without
/// copied metadata retain timestamp/signature checks, never append authority.
fn resolve_codex_replay(
    file_path: &Path,
    complete_bytes: i64,
    parsed: &ParsedCodexFile,
    rollout_index: &RolloutIndex,
    expected_stamp: Option<ParentFileStamp>,
    copied_inspection_unavailable: &mut bool,
) -> Result<(usize, Option<CodexReplayVerification>), PendingReason> {
    let parent_id = match &parsed.parent {
        ParentResolution::None => return Ok((0, None)),
        ParentResolution::Deferred(reason) => return Err(PendingReason::Stable(reason.clone())),
        ParentResolution::Parent(parent_id) => parent_id,
    };
    let Some(cutoff) = parsed.root_timestamp else {
        return Err(PendingReason::Stable(
            "parented rollout 的 root meta 缺少有效 timestamp".to_string(),
        ));
    };
    let child_id = parsed
        .meta_thread_id
        .as_deref()
        .or(parsed.root_thread_id.as_deref())
        .ok_or_else(|| {
            PendingReason::Stable("parented rollout 缺少有效 child identity".to_string())
        })?;
    let classify_error = |reason: String| {
        if rollout_index.contains_key(parent_id) {
            PendingReason::Retryable(reason)
        } else {
            PendingReason::MissingParent(parent_id.clone())
        }
    };
    let proof = if *copied_inspection_unavailable {
        // The exact-content-validated snapshot already established this
        // child-local fact. Preserve the certifier's later path/identity guard;
        // parent discovery/readiness below is never memoized by this flag.
        let current = fs::File::open(file_path)
            .ok()
            .and_then(|file| ParentFileStamp::from_file(&file));
        if !current
            .zip(expected_stamp)
            .is_some_and(|(current, expected)| expected.same_identity_and_not_shrunk(&current))
        {
            return Err(PendingReason::Retryable(
                "无法验证 copied rollout 的稳定内容边界；下轮重试".to_string(),
            ));
        }
        CopiedForkProof::Unavailable
    } else {
        #[cfg(test)]
        CODEX_COPIED_CHILD_INSPECTION_CALLS.with(|count| count.set(count.get() + 1));
        let proof = certify_copied_rollout(
            file_path,
            complete_bytes,
            child_id,
            parent_id,
            rollout_index,
            expected_stamp,
        )
        .map_err(|_| {
            PendingReason::Retryable("无法验证 copied rollout 的稳定内容边界；下轮重试".to_string())
        })?;
        *copied_inspection_unavailable = matches!(proof, CopiedForkProof::Unavailable);
        proof
    };
    match proof {
        CopiedForkProof::Verified { first_live_line } => {
            let prefix = parsed
                .token_events
                .iter()
                .take_while(|event| event.line_offset < first_live_line)
                .count();
            Ok((
                prefix,
                Some(CodexReplayVerification::Copied { first_live_line }),
            ))
        }
        CopiedForkProof::Deferred(reason) => Err(classify_error(reason)),
        CopiedForkProof::MissingParentPrefix(prefix) => {
            Err(PendingReason::MissingParentPrefix(prefix))
        }
        CopiedForkProof::Unavailable => {
            let signatures = resolve_parent_signatures(parent_id, cutoff, rollout_index)
                .map_err(classify_error)?;
            let prefix = matching_replay_prefix(&parsed.token_events, &signatures);
            Ok((prefix, Some(CodexReplayVerification::Legacy { prefix })))
        }
    }
}

fn reset_codex_live_activity(
    state: &mut CodexParserState,
    events: &[ParsedTokenEvent],
    replay_prefix: usize,
) {
    state.first_activity_at = None;
    state.last_activity_at = None;
    for event in events
        .iter()
        .skip(replay_prefix)
        .filter(|event| event.event_index.is_some())
    {
        if let Some(timestamp) = event
            .timestamp
            .as_deref()
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        {
            let activity = timestamp.timestamp();
            state.first_activity_at = Some(
                state
                    .first_activity_at
                    .map_or(activity, |current| current.min(activity)),
            );
            state.last_activity_at = Some(
                state
                    .last_activity_at
                    .map_or(activity, |current| current.max(activity)),
            );
        }
    }
}

#[cfg(test)]
thread_local! {
    static CODEX_PENDING_WARNING_PATHS: std::cell::RefCell<Vec<PathBuf>> = const { std::cell::RefCell::new(Vec::new()) };
}

const CODEX_CHECKPOINT_REWRITE_REASON: &str =
    "rollout 非追加式重写/截断；保留已验证账本，需受控 Codex 重建";

fn mark_deferred(
    file_path: &Path,
    modified: i64,
    size: u64,
    reason: PendingReason,
) -> CodexFileSyncResult {
    let entry = PendingEntry {
        modified,
        size,
        reason,
    };
    let should_warn = replay_caches()
        .lock()
        .ok()
        .map(|mut caches| {
            let previous = caches
                .pending
                .insert(file_path.to_path_buf(), entry.clone());
            should_warn_for_pending(previous.as_ref(), &entry)
        })
        .unwrap_or(true);
    if should_warn {
        let reason = match &entry.reason {
            PendingReason::MissingParent(parent) => format!("找不到父 rollout {parent}"),
            PendingReason::MissingParentPrefix(_) => fork_proof::MISSING_PARENT_PREFIX.to_string(),
            PendingReason::MissingContinuationBase(_) => {
                "paginated continuation has no explicit history_base".to_string()
            }
            PendingReason::CheckpointRewrite { .. } => CODEX_CHECKPOINT_REWRITE_REASON.to_string(),
            PendingReason::Stable(reason) | PendingReason::Retryable(reason) => reason.clone(),
        };
        #[cfg(test)]
        CODEX_PENDING_WARNING_PATHS.with(|paths| paths.borrow_mut().push(file_path.to_path_buf()));
        log::warn!("[CODEX-SYNC] deferred {}: {reason}", file_path.display());
    }
    CodexFileSyncResult {
        deferred: true,
        ..CodexFileSyncResult::default()
    }
}

/// 单文件批量插入的事务粒度。批内 UI 查询会被连接互斥锁挡住约几毫秒，
/// 批间释放锁让读侧插队——兼顾吞吐（避免逐行 autocommit 的每行 fsync）
/// 与大文件重导期间面板的响应性。
const CODEX_INSERT_BATCH_SIZE: usize = 1000;

fn save_codex_session_metadata_on_conn(
    conn: &rusqlite::Connection,
    file_path: &Path,
    state: &CodexParserState,
) -> Result<(), AppError> {
    let Some(session_id) = state
        .meta_thread_id
        .as_ref()
        .or(state.root_thread_id.as_ref())
    else {
        return Ok(());
    };
    let parent_thread_id = match &state.parent {
        ParentResolution::Parent(parent) => Some(parent.as_str()),
        _ => None,
    };
    // Only the structured thread_spawn path is a subagent. forked_from_id is
    // intentionally not enough; the parser state retains both distinctions.
    let is_subagent = state.is_subagent as i64;
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO codex_usage_sessions (session_id, file_path, is_subagent, parent_thread_id, model, first_activity_at, last_activity_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(session_id) DO UPDATE SET file_path=excluded.file_path,
           is_subagent=excluded.is_subagent, parent_thread_id=excluded.parent_thread_id,
           model=excluded.model, first_activity_at=excluded.first_activity_at,
           last_activity_at=excluded.last_activity_at, last_seen_at=excluded.last_seen_at",
        rusqlite::params![session_id, file_path.to_string_lossy().to_string(), is_subagent, parent_thread_id, state.current_model, state.first_activity_at, state.last_activity_at, now],
    ).map_err(|e| AppError::Database(format!("保存 Codex 会话元数据失败: {e}")))?;
    Ok(())
}

struct CodexCheckpointFile {
    file: fs::File,
    file_modified: i64,
    file_size: i64,
    revision: Option<FileRevision>,
}

impl CodexCheckpointFile {
    fn open(path: &Path) -> Result<Self, AppError> {
        let file = fs::File::open(path)
            .map_err(|e| AppError::Config(format!("无法打开 Codex checkpoint 文件: {e}")))?;
        let metadata = file
            .metadata()
            .map_err(|e| AppError::Config(format!("无法读取 Codex checkpoint 文件元数据: {e}")))?;
        Ok(Self {
            revision: FileRevision::from_file_metadata(&file, &metadata),
            file_modified: metadata_modified_nanos(&metadata),
            file_size: metadata.len() as i64,
            file,
        })
    }

    fn verify_digest(&self, path: &Path, offset: i64, digest: [u8; 32]) -> Result<(), AppError> {
        if let Some(revision) = self.revision {
            validated_rollout_revision(&self.file, path, Some(revision))
                .map_err(AppError::Config)?;
        } else {
            let mut current = Self::open(path)?;
            let current_digest: [u8; 32] = read_codex_checkpoint_prefix(&mut current.file, offset)?
                .finalize()
                .into();
            if current_digest != digest {
                return Err(AppError::Config(
                    "Codex checkpoint 内容在读取期间变化；下轮重试".to_string(),
                ));
            }
        }
        Ok(())
    }
}

fn read_codex_checkpoint_prefix(file: &mut fs::File, offset: i64) -> Result<Sha256, AppError> {
    let error = |e| AppError::Config(format!("读取 Codex checkpoint prefix 失败: {e}"));
    file.seek(SeekFrom::Start(0)).map_err(error)?;
    let mut reader = file.take(offset as u64);
    let mut buffer = [0; 8192];
    let mut digest = Sha256::new();
    loop {
        let read = reader.read(&mut buffer).map_err(error)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        #[cfg(test)]
        CODEX_CHECKPOINT_PREFIX_BYTES_READ.with(|bytes| bytes.set(bytes.get() + read as u64));
    }
    if reader.limit() != 0 {
        return Err(AppError::Config(
            "Codex checkpoint 文件在读取时缩小；下轮重试".to_string(),
        ));
    }
    Ok(digest)
}

fn sync_codex_append(
    db: &Database,
    file_path: &Path,
    checkpoint: CodexCheckpoint,
    mut input: CodexCheckpointFile,
    mut digest: Sha256,
    head_fingerprint: i64,
    pass: &mut CodexSyncPass,
) -> Result<CodexFileSyncResult, AppError> {
    // Prefix verification leaves the handle at the committed cursor.
    let remaining = (input.file_size - checkpoint.last_byte_offset) as u64;
    let mut reader = BufReader::new((&mut input.file).take(remaining));
    if !checkpoint.state.append_authorized() {
        return Err(AppError::Config(
            "Codex append 缺少已验证的 parent replay authority".to_string(),
        ));
    }
    let mut state = checkpoint.state;
    let head_window_len = checkpoint.head_window_len.unwrap_or(0);
    let mut offset = checkpoint.last_byte_offset;
    let mut line_offset = 0i64;
    let mut events = Vec::new();
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        let read = reader
            .read_until(b'\n', &mut buffer)
            .map_err(|e| AppError::Config(format!("读取 Codex append 文件失败: {e}")))?;
        if read == 0 {
            break;
        }
        #[cfg(test)]
        note_codex_append_bytes_read(file_path, read as u64);
        if !buffer.ends_with(b"\n") {
            break;
        }
        digest.update(&buffer);
        offset += read as i64;
        line_offset += 1;
        let Ok(line) = std::str::from_utf8(&buffer) else {
            continue;
        };
        if let Some(event) = parse_codex_incremental_line(file_path, &mut state, line, line_offset)
        {
            events.push(event);
        }
    }
    if reader.get_ref().limit() != 0 {
        return Err(AppError::Config(
            "Codex append 文件在读取时缩小；下轮重试".to_string(),
        ));
    }
    if let ParentResolution::Deferred(reason) = &state.parent {
        return Ok(mark_deferred(
            file_path,
            input.file_modified,
            input.file_size as u64,
            PendingReason::Retryable(reason.clone()),
        ));
    }
    if !state.valid() {
        return Err(AppError::Config(
            "Codex parser state exceeded bounded lane limit; requires full rebuild".to_string(),
        ));
    }
    let committed_tail_fingerprint = codex_tail_before(&mut input.file, offset)?;
    let prefix_digest = digest.finalize().into();
    input.verify_digest(file_path, offset, prefix_digest)?;
    state.checkpoint_proof = Some(CodexCheckpointProof {
        revision: input.revision.map(|revision| revision.fingerprint()),
        prefix_digest,
    });
    let checkpoint_facts = CodexCheckpointFacts {
        file_size: input.file_size,
        file_modified: input.file_modified,
        head_window_len,
        head_fingerprint,
        tail_fingerprint: committed_tail_fingerprint,
    };
    let root_thread_id = state
        .root_thread_id
        .as_deref()
        .ok_or_else(|| AppError::Config("Codex append parser 缺少 root thread id".to_string()))?;
    let session_id = state.meta_thread_id.as_deref().unwrap_or(root_thread_id);
    let mut result = CodexFileSyncResult::default();
    // Commit usage and its prefix proof together. An insert failure must leave
    // the suffix available for retry, including if its bytes change meanwhile.
    let conn = lock_conn!(db.conn);
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AppError::Database(format!("开启 Codex append 事务失败: {e}")))?;
    for event in events {
        let Some(event_index) = event.event_index else {
            continue;
        };
        let request_id = format!("{CODEX_THREAD_REQUEST_ID_PREFIX}:{root_thread_id}:{event_index}");
        if insert_codex_session_entry_on_conn(
            &tx,
            &request_id,
            &event.delta,
            &event.model,
            Some(session_id),
            event.timestamp.as_deref(),
            &mut result.suspected_duplicates,
            &mut pass.pricing,
        )? {
            result.imported = result.imported.saturating_add(1);
        } else {
            result.skipped = result.skipped.saturating_add(1);
        }
    }
    save_codex_session_metadata_on_conn(&tx, file_path, &state)?;
    save_codex_checkpoint_on_conn(&tx, file_path, &state, offset, &checkpoint_facts)?;
    tx.commit()
        .map_err(|e| AppError::Database(format!("提交 Codex append 事务失败: {e}")))?;
    pass.refresh_checkpoint_on_conn(&conn, file_path)?;
    Ok(result)
}

/// Only the first accepted session_meta can classify a rollout as paginated.
/// Inspect that record with the same parser and complete-line boundary as
/// import. A migrated checkpoint can describe an ordinary resumed rollout.
fn checkpoint_root_is_paginated(file_path: &Path) -> Result<bool, AppError> {
    let open = || {
        fs::File::open(file_path)
            .map_err(|e| AppError::Config(format!("打开 Codex root metadata 失败: {e}")))
    };
    let mut file = open()?;
    let stamp = ParentFileStamp::from_file(&file);
    let size = file
        .metadata()
        .map_err(|e| AppError::Config(format!("读取 Codex root metadata 大小失败: {e}")))?
        .len();
    let fingerprints = |file: &mut fs::File| -> Result<_, AppError> {
        Ok((
            codex_head_before(file, codex_head_window_len(size as i64))?,
            codex_tail_before(file, size as i64)?,
        ))
    };
    let before = fingerprints(&mut file)?;
    file.seek(SeekFrom::Start(0))
        .map_err(|e| AppError::Config(format!("定位 Codex root metadata 失败: {e}")))?;
    let mut reader = BufReader::new(file.take(size));
    let mut state = CodexParserState::initial(thread_id_from_filename(file_path));
    let mut record = Vec::new();
    while !state.root_meta_seen {
        record.clear();
        reader
            .read_until(b'\n', &mut record)
            .map_err(|e| AppError::Config(format!("读取 Codex root metadata 失败: {e}")))?;
        if !record.ends_with(b"\n") {
            break;
        }
        #[cfg(test)]
        CODEX_CHECKPOINT_ROOT_RECORDS.with(|count| count.set(count.get() + 1));
        #[cfg(test)]
        CODEX_CHECKPOINT_ROOT_BYTES_READ.with(|bytes| bytes.set(bytes.get() + record.len() as u64));
        if let Ok(line) = std::str::from_utf8(&record) {
            if line.contains("\"session_meta\"") {
                let _ = parse_codex_incremental_line(file_path, &mut state, line, 0);
            }
        }
    }
    let mut reopened = open()?;
    if stamp.is_some_and(|initial| {
        !ParentFileStamp::from_file(&reopened)
            .is_some_and(|current| initial.same_identity_and_not_shrunk(&current))
    }) || fingerprints(&mut reopened)? != before
    {
        return Err(AppError::Config(
            "Codex rollout 在读取 root metadata 期间变化；下轮重试".to_string(),
        ));
    }
    Ok(state.continuation.is_some())
}

/// 同步单个 Codex JSONL 文件。
fn sync_single_codex_file(
    db: &Database,
    file_path: &Path,
    rollout_index: &RolloutIndex,
    pass: &mut CodexSyncPass,
) -> Result<CodexFileSyncResult, AppError> {
    let file_path_str = file_path.to_string_lossy().to_string();

    // 获取文件元数据
    let metadata = fs::metadata(file_path)
        .map_err(|e| AppError::Config(format!("无法读取文件元数据: {e}")))?;
    let mut file_modified = metadata_modified_nanos(&metadata);
    let mut file_size = metadata.len();

    let mut checkpoint = pass.checkpoint(db, file_path)?;
    if checkpoint.is_some() {
        if let Ok(mut caches) = replay_caches().lock() {
            let _ = caches.take_retryable_snapshot(file_path);
        }
    }
    if let Some(value) = checkpoint.as_ref() {
        let continuation_state_incomplete = value.state.continuation.is_some()
            && (!value.state.continuation_accounting_verified
                || (!value.state.has_billable_tokens && value.state.total_high_water.is_none())
                || !matches!(value.state.parent, ParentResolution::None));
        let legacy_page = leading_thread_id_from_filename(file_path)
            .is_some_and(|id| Some(&id) == value.state.meta_thread_id.as_ref())
            && (value.state.continuation.is_none() || continuation_state_incomplete);
        if legacy_page && checkpoint_root_is_paginated(file_path)? {
            let Some(physical_id) = thread_id_from_filename(file_path) else {
                return Ok(mark_deferred(
                    file_path,
                    file_modified,
                    file_size,
                    PendingReason::Stable("continuation filename has no physical UUID".to_string()),
                ));
            };
            let path = file_path.to_string_lossy().to_string();
            let request_prefix = format!("{CODEX_THREAD_REQUEST_ID_PREFIX}:{physical_id}:%");
            let conn = lock_conn!(db.conn);
            let tx = conn.unchecked_transaction().map_err(|error| {
                AppError::Database(format!(
                    "开启 Codex continuation checkpoint 事务失败: {error}"
                ))
            })?;
            let ledger_rows: i64 = tx.query_row("SELECT COUNT(*) FROM proxy_request_logs WHERE data_source='codex_session' AND request_id LIKE ?1", [&request_prefix], |row| row.get(0)).map_err(|error| AppError::Database(format!("检查 Codex continuation 账本失败: {error}")))?;
            if ledger_rows > 0 {
                tx.commit().map_err(|error| {
                    AppError::Database(format!("提交 Codex continuation 账本检查失败: {error}"))
                })?;
                return Ok(mark_deferred(
                    file_path,
                    file_modified,
                    file_size,
                    PendingReason::Stable(
                        "旧版 paginated continuation 已有账本记录；需受控 Codex 重建，禁止自动重放"
                            .to_string(),
                    ),
                ));
            }
            // A certified, empty page cannot acquire a baseline until its
            // predecessor is discovered. Keep its checkpoint while waiting,
            // and still run the unchanged-file fingerprint checks below.
            let waiting_for_baseline = value.state.continuation_accounting_verified
                && matches!(value.state.parent, ParentResolution::None)
                && !value.state.has_billable_tokens
                && value.state.total_high_water.is_none()
                && value.file_size == file_size as i64
                && value.state.continuation.as_ref().is_some_and(|page| {
                    page.history_base
                        .as_ref()
                        .is_none_or(|link| !rollout_index.contains_key(&link.physical_id))
                });
            if !waiting_for_baseline {
                if value.source_path == path {
                    tx.execute(
                        "DELETE FROM codex_usage_file_checkpoints WHERE file_path=?1",
                        [&path],
                    )
                    .map_err(|error| {
                        AppError::Database(format!(
                            "清理空 Codex continuation checkpoint 失败: {error}"
                        ))
                    })?;
                }
                tx.execute("DELETE FROM session_log_sync WHERE file_path=?1", [&path])
                    .map_err(|error| {
                        AppError::Database(format!(
                            "清理空 Codex continuation cursor 失败: {error}"
                        ))
                    })?;
                tx.commit().map_err(|error| {
                    AppError::Database(format!("提交 Codex continuation 游标清理失败: {error}"))
                })?;
                if value.source_path == path {
                    pass.remove_checkpoint(&path);
                }
                pass.remove_cursor(&path);
                checkpoint = None;
            }
        }
    }
    let mut checkpoint_prefix = None;
    if let Some(mut checkpoint) = checkpoint {
        let Some(head_window_len) = checkpoint.head_window_len else {
            return Ok(mark_deferred(
                file_path,
                file_modified,
                file_size,
                PendingReason::Stable(
                    "旧 checkpoint 缺少固定 head window；需受控 Codex 重建".to_string(),
                ),
            ));
        };
        let mut input = CodexCheckpointFile::open(file_path)?;
        let same_size = input.file_size == checkpoint.file_size;
        let current_contract = checkpoint.state.replay_contract_current();
        let proof = checkpoint.state.checkpoint_proof;
        let revision = input.revision.map(|revision| revision.fingerprint());
        if same_size
            && current_contract
            && revision.is_some()
            && proof.is_some_and(|proof| proof.revision == revision)
        {
            return Ok(CodexFileSyncResult::default());
        }
        if let (Some(revision), Some(proof)) = (input.revision, proof) {
            let reason = PendingReason::CheckpointRewrite {
                revision,
                offset: checkpoint.last_byte_offset,
                expected: proof.prefix_digest,
            };
            if replay_caches().lock().ok().is_some_and(|caches| {
                caches
                    .pending
                    .get(file_path)
                    .is_some_and(|entry| entry.reason == reason)
            }) {
                return Ok(CodexFileSyncResult {
                    deferred: true,
                    ..CodexFileSyncResult::default()
                });
            }
        }
        let rewritten = |reason| {
            mark_deferred(
                file_path,
                input.file_modified,
                input.file_size as u64,
                reason,
            )
        };
        if input.file_size < checkpoint.file_size
            || checkpoint.last_byte_offset < 0
            || checkpoint.last_byte_offset > checkpoint.file_size
        {
            return Ok(rewritten(PendingReason::Stable(
                CODEX_CHECKPOINT_REWRITE_REASON.to_string(),
            )));
        }
        // Legacy checkpoints have only these two samples. Apply their existing
        // boundary check before establishing an exact proof for future edits.
        let head_fingerprint = codex_head_before(&mut input.file, head_window_len)?;
        let old_tail = codex_tail_before(&mut input.file, checkpoint.last_byte_offset)?;
        if proof.is_none()
            && (checkpoint.head_fingerprint != Some(head_fingerprint)
                || checkpoint.tail_fingerprint != Some(old_tail))
        {
            return Ok(rewritten(PendingReason::Stable(
                CODEX_CHECKPOINT_REWRITE_REASON.to_string(),
            )));
        }
        let digest = read_codex_checkpoint_prefix(&mut input.file, checkpoint.last_byte_offset)?;
        let prefix_digest: [u8; 32] = digest.clone().finalize().into();
        if let Some(proof) = proof.filter(|proof| proof.prefix_digest != prefix_digest) {
            let reason = if let Some(revision) = input.revision {
                input.verify_digest(file_path, checkpoint.last_byte_offset, prefix_digest)?;
                PendingReason::CheckpointRewrite {
                    revision,
                    offset: checkpoint.last_byte_offset,
                    expected: proof.prefix_digest,
                }
            } else {
                PendingReason::Stable(CODEX_CHECKPOINT_REWRITE_REASON.to_string())
            };
            return Ok(rewritten(reason));
        }
        // A same-size edit can finish a previously incomplete trailing record.
        if input.file_size > checkpoint.last_byte_offset && checkpoint.state.append_authorized() {
            return sync_codex_append(
                db,
                file_path,
                checkpoint,
                input,
                digest,
                head_fingerprint,
                pass,
            );
        }
        input.verify_digest(file_path, checkpoint.last_byte_offset, prefix_digest)?;
        if same_size && current_contract {
            if checkpoint.source_path == file_path_str && (revision.is_some() || proof.is_none()) {
                checkpoint.state.checkpoint_proof = Some(CodexCheckpointProof {
                    revision,
                    prefix_digest,
                });
                let facts = CodexCheckpointFacts {
                    file_size: input.file_size,
                    file_modified: input.file_modified,
                    head_window_len,
                    head_fingerprint,
                    tail_fingerprint: old_tail,
                };
                let conn = lock_conn!(db.conn);
                save_codex_checkpoint_on_conn(
                    &conn,
                    file_path,
                    &checkpoint.state,
                    checkpoint.last_byte_offset,
                    &facts,
                )?;
                pass.refresh_checkpoint_on_conn(&conn, file_path)?;
            }
            return Ok(CodexFileSyncResult::default());
        }
        // Legacy parented checkpoints (including metadata-only v1 states)
        // cannot authorize appends. Reparse the same verified physical prefix
        // and certify it without deleting facts or renumbering event IDs.
        checkpoint_prefix = Some((checkpoint.last_byte_offset, prefix_digest));
    }

    // 检查同步状态
    let (_, last_offset) = get_codex_sync_state(db, file_path, pass)?;

    if let Ok(mut caches) = replay_caches().lock() {
        if let Some(pending) = caches.pending.get(file_path).cloned() {
            if let PendingReason::MissingParentPrefix(prefix)
            | PendingReason::MissingContinuationBase(prefix) = &pending.reason
            {
                drop(caches);
                // Child-local rejection remains decisive across tail appends.
                // The witness checks identity, non-shrinkage and exact bytes.
                if prefix.still_matches(file_path) {
                    return Ok(CodexFileSyncResult {
                        deferred: true,
                        ..CodexFileSyncResult::default()
                    });
                }
            } else if pending.modified == file_modified && pending.size == file_size {
                match &pending.reason {
                    PendingReason::MissingParent(parent) if !rollout_index.contains_key(parent) => {
                        return Ok(CodexFileSyncResult {
                            deferred: true,
                            ..CodexFileSyncResult::default()
                        });
                    }
                    PendingReason::Stable(_) => {
                        return Ok(CodexFileSyncResult {
                            deferred: true,
                            ..CodexFileSyncResult::default()
                        });
                    }
                    PendingReason::Retryable(_) => {
                        // Recheck the parent without erasing the prior reason:
                        // mark_deferred needs it to suppress an unchanged warning.
                        // Successful reconciliation clears the entry below.
                    }
                    _ => {
                        caches.pending.remove(file_path);
                    }
                }
            }
        }
    }

    let cached_snapshot = if checkpoint_prefix.is_none() {
        replay_caches()
            .lock()
            .ok()
            .and_then(|mut caches| caches.take_retryable_snapshot(file_path))
    } else {
        None
    };
    let mut parse_snapshot = || {
        parse_codex_snapshot_with_baseline(
            file_path,
            Some((rollout_index, &mut pass.continuation_sources)),
            None,
            checkpoint_prefix,
        )
    };
    let (preliminary, content_already_verified) = if let Some(mut snapshot) = cached_snapshot {
        #[cfg(test)]
        if let Some(rewrite) = BEFORE_CODEX_SNAPSHOT_REUSE.with(|hook| hook.take()) {
            rewrite();
        }
        if snapshot.verify_reusable_content(file_path).is_ok() {
            (snapshot, true)
        } else {
            // Content, identity or boundary changed. This derivative owns no
            // authority: discard it and recover through the normal parser.
            (parse_snapshot()?, false)
        }
    } else {
        (parse_snapshot()?, false)
    };
    file_modified = preliminary.file_modified;
    file_size = preliminary.file_size.max(0) as u64;
    if let Some(reason) = preliminary.continuation_error {
        return Ok(mark_deferred(file_path, file_modified, file_size, reason));
    }
    if preliminary.parsed.has_billable_tokens
        && preliminary
            .parsed
            .continuation
            .as_ref()
            .is_some_and(|page| page.history_base.is_none())
    {
        return Ok(mark_deferred(
            file_path,
            file_modified,
            file_size,
            preliminary
                .missing_continuation_base_prefix
                .map(PendingReason::MissingContinuationBase)
                .unwrap_or_else(|| {
                    PendingReason::Retryable(
                        "paginated continuation has no explicit history_base".to_string(),
                    )
                }),
        ));
    }
    let mut snapshot = preliminary;
    if !content_already_verified {
        #[cfg(test)]
        if let Some(rewrite) = BEFORE_CODEX_SNAPSHOT_REUSE.with(|hook| hook.take()) {
            rewrite();
        }
        snapshot.verify_reusable_content(file_path)?;
    }
    let checkpoint_facts = snapshot.checkpoint_facts();
    snapshot.state.checkpoint_proof = Some(CodexCheckpointProof {
        revision: snapshot
            .verified_revision
            .map(|revision| revision.fingerprint()),
        prefix_digest: snapshot.complete_digest,
    });
    // Parent ownership must be resolved even for a metadata-only initial
    // snapshot. Otherwise its checkpoint could later bill inherited appends.
    let (replay_prefix, verification) = match resolve_codex_replay(
        file_path,
        snapshot.complete_bytes,
        &snapshot.parsed,
        rollout_index,
        snapshot.file_stamp,
        &mut snapshot.copied_inspection_unavailable,
    ) {
        Ok(resolution) => resolution,
        Err(reason) => {
            let retryable = matches!(reason, PendingReason::Retryable(_));
            let result = mark_deferred(file_path, file_modified, file_size, reason);
            if retryable {
                if let Ok(mut caches) = replay_caches().lock() {
                    caches.retain_retryable_snapshot(file_path, snapshot);
                }
            }
            return Ok(result);
        }
    };
    let parsed = snapshot.parsed;
    snapshot.state.replay_verification = verification;
    reset_codex_live_activity(&mut snapshot.state, &parsed.token_events, replay_prefix);
    if let Ok(mut caches) = replay_caches().lock() {
        caches.pending.remove(file_path);
    }
    if !parsed.has_billable_tokens {
        let conn = lock_conn!(db.conn);
        let tx = conn.unchecked_transaction().map_err(|e| {
            AppError::Database(format!("开启 Codex 空文件 checkpoint 事务失败: {e}"))
        })?;
        update_sync_state_on_conn(&tx, &file_path_str, file_modified, parsed.line_offset)?;
        save_codex_session_metadata_on_conn(&tx, file_path, &snapshot.state)?;
        save_codex_checkpoint_on_conn(
            &tx,
            file_path,
            &snapshot.state,
            snapshot.complete_bytes,
            &checkpoint_facts,
        )?;
        tx.commit().map_err(|e| {
            AppError::Database(format!("提交 Codex 空文件 checkpoint 事务失败: {e}"))
        })?;
        pass.refresh_checkpoint_on_conn(&conn, file_path)?;
        return Ok(CodexFileSyncResult::default());
    }
    let Some(root_thread_id) = parsed.root_thread_id.as_deref() else {
        return Ok(mark_deferred(
            file_path,
            file_modified,
            file_size,
            PendingReason::Stable("文件名缺少有效的尾部 UUID".to_string()),
        ));
    };
    if !parsed.root_meta_seen {
        return Ok(mark_deferred(
            file_path,
            file_modified,
            file_size,
            PendingReason::Stable("含计费 token 但尚无 session_meta".to_string()),
        ));
    }

    let mut result = CodexFileSyncResult::default();
    let mut to_insert: Vec<(&ParsedTokenEvent, u32)> = Vec::new();
    for (token_offset, event) in parsed.token_events.iter().enumerate() {
        let Some(event_index) = event.event_index else {
            continue;
        };
        if token_offset < replay_prefix {
            if event.line_offset > last_offset {
                result.skipped = result.skipped.saturating_add(1);
            }
            continue;
        }
        if event.line_offset <= last_offset {
            continue;
        }
        to_insert.push((event, event_index));
    }

    // 分批事务写库：逐行 autocommit（journal_mode=delete 下每行一整套
    // journal 建立/fsync/删除）是全量重导的最大耗时项。批内单条插入失败
    // 沿用旧行为跳过该条继续；某批 commit 失败则该批整体回滚且游标不推进，
    // 下一 pass 重扫时由 request_id 主键 + 指纹去重兜底，不会双算。
    // The trailing UUID remains the physical-file dedup identity; the root
    // metadata id is the logical conversation identity used by usage views.
    let session_thread_id = parsed.meta_thread_id.as_deref().unwrap_or(root_thread_id);
    let batch_count = to_insert.len().div_ceil(CODEX_INSERT_BATCH_SIZE);
    for (batch_index, batch) in to_insert.chunks(CODEX_INSERT_BATCH_SIZE).enumerate() {
        let is_last_batch = batch_index + 1 == batch_count;
        let conn = lock_conn!(db.conn);
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| AppError::Database(format!("开启 Codex 会话写入事务失败: {e}")))?;

        let mut batch_imported = 0u32;
        let mut batch_skipped = 0u32;
        let mut batch_suspected = 0u32;
        for (event, event_index) in batch {
            let request_id =
                format!("{CODEX_THREAD_REQUEST_ID_PREFIX}:{root_thread_id}:{event_index}");
            match insert_codex_session_entry_on_conn(
                &tx,
                &request_id,
                &event.delta,
                &event.model,
                Some(session_thread_id),
                event.timestamp.as_deref(),
                &mut batch_suspected,
                &mut pass.pricing,
            ) {
                Ok(true) => batch_imported += 1,
                Ok(false) => batch_skipped += 1,
                Err(error) => return Err(error),
            }
        }
        if is_last_batch {
            // 游标推进与最后一批数据同事务提交：中途崩溃时两者一起回滚，
            // 不会出现"游标已推进但数据缺失"的丢数据窗口。
            update_sync_state_on_conn(&tx, &file_path_str, file_modified, parsed.line_offset)?;
            save_codex_session_metadata_on_conn(&tx, file_path, &snapshot.state)?;
            save_codex_checkpoint_on_conn(
                &tx,
                file_path,
                &snapshot.state,
                snapshot.complete_bytes,
                &checkpoint_facts,
            )?;
        }
        tx.commit()
            .map_err(|e| AppError::Database(format!("提交 Codex 会话写入事务失败: {e}")))?;
        if is_last_batch {
            pass.refresh_checkpoint_on_conn(&conn, file_path)?;
        }

        result.imported = result.imported.saturating_add(batch_imported);
        result.skipped = result.skipped.saturating_add(batch_skipped);
        result.suspected_duplicates = result.suspected_duplicates.saturating_add(batch_suspected);
    }

    if to_insert.is_empty() {
        let conn = lock_conn!(db.conn);
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| AppError::Database(format!("开启 Codex 空事件事务失败: {e}")))?;
        update_sync_state_on_conn(&tx, &file_path_str, file_modified, parsed.line_offset)?;
        save_codex_session_metadata_on_conn(&tx, file_path, &snapshot.state)?;
        save_codex_checkpoint_on_conn(
            &tx,
            file_path,
            &snapshot.state,
            snapshot.complete_bytes,
            &checkpoint_facts,
        )?;
        tx.commit()
            .map_err(|e| AppError::Database(format!("提交 Codex 空事件事务失败: {e}")))?;
        pass.refresh_checkpoint_on_conn(&conn, file_path)?;
    }
    Ok(result)
}

/// 插入单条 Codex 会话记录到 proxy_request_logs（自取锁的便捷包装，测试专用；
/// 生产路径走 [`insert_codex_session_entry_on_conn`] 以复用批量事务与定价缓存）
#[cfg(test)]
fn insert_codex_session_entry(
    db: &Database,
    request_id: &str,
    delta: &DeltaTokens,
    model: &str,
    session_id: Option<&str>,
    timestamp: Option<&str>,
    suspected_duplicates: &mut u32,
) -> Result<bool, AppError> {
    let conn = lock_conn!(db.conn);
    insert_codex_session_entry_on_conn(
        &conn,
        request_id,
        delta,
        model,
        session_id,
        timestamp,
        suspected_duplicates,
        &mut HashMap::new(),
    )
}

/// 插入单条 Codex 会话记录到 proxy_request_logs。
///
/// 调用方负责持锁/事务；`pricing_cache` 按原始 model 字符串键控（
/// `find_codex_pricing` 是纯函数式查找，同串必同结果），全量重导时把
/// 每事件一次的定价 SELECT 降为每模型一次。
#[allow(clippy::too_many_arguments)]
fn insert_codex_session_entry_on_conn(
    conn: &rusqlite::Connection,
    request_id: &str,
    delta: &DeltaTokens,
    model: &str,
    session_id: Option<&str>,
    timestamp: Option<&str>,
    suspected_duplicates: &mut u32,
    pricing_cache: &mut HashMap<String, Option<ModelPricing>>,
) -> Result<bool, AppError> {
    let created_at = timestamp
        .and_then(|ts| {
            chrono::DateTime::parse_from_rfc3339(ts)
                .ok()
                .map(|dt| dt.timestamp())
        })
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0)
        });

    let dedup_key = DedupKey {
        app_type: "codex",
        model,
        input_tokens: delta.input,
        output_tokens: delta.output,
        cache_read_tokens: delta.cached_input,
        cache_creation_tokens: 0,
        created_at,
    };
    if should_skip_session_insert(conn, request_id, &dedup_key)? {
        return Ok(false);
    }
    if has_suspected_codex_session_duplicate(conn, request_id, &dedup_key)? {
        *suspected_duplicates = suspected_duplicates.saturating_add(1);
        log::warn!(
            "[CODEX-SYNC] 疑似重复会话用量: request_id={request_id}, model={model}, input={}, output={}, cache_read={}",
            delta.input,
            delta.output,
            delta.cached_input
        );
    }

    // 计算费用
    let usage = TokenUsage {
        input_tokens: delta.input,
        output_tokens: delta.output,
        cache_read_tokens: delta.cached_input,
        cache_creation_tokens: 0,
        model: Some(model.to_string()),
        message_id: None,
    };

    let pricing = pricing_cache
        .entry(model.to_string())
        .or_insert_with(|| find_codex_pricing(conn, model));
    let multiplier = Decimal::from(1);
    let (input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost) = match pricing
    {
        Some(p) => {
            let cost = CostCalculator::calculate_for_app("codex", &usage, p, multiplier);
            (
                cost.input_cost.to_string(),
                cost.output_cost.to_string(),
                cost.cache_read_cost.to_string(),
                cost.cache_creation_cost.to_string(),
                cost.total_cost.to_string(),
            )
        }
        None => (
            "0".to_string(),
            "0".to_string(),
            "0".to_string(),
            "0".to_string(),
            "0".to_string(),
        ),
    };

    let inserted_rows = conn
        .prepare_cached(
            "INSERT OR IGNORE INTO proxy_request_logs (
            request_id, provider_id, app_type, model, request_model,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
            input_cost_usd, output_cost_usd, cache_read_cost_usd, cache_creation_cost_usd, total_cost_usd,
            latency_ms, first_token_ms, status_code, error_message, session_id,
            provider_type, is_streaming, cost_multiplier, created_at, data_source
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)",
        )
        .and_then(|mut stmt| stmt.execute(rusqlite::params![
                request_id,
                "_codex_session",    // provider_id
                "codex",             // app_type
                model,
                model,               // request_model = model
                delta.input,
                delta.output,
                delta.cached_input,
                0i64,                // cache_creation_tokens: Codex 日志无此数据
                input_cost,
                output_cost,
                cache_read_cost,
                cache_creation_cost,
                total_cost,
                0i64,                // latency_ms
                Option::<i64>::None, // first_token_ms
                200i64,              // status_code
                Option::<String>::None, // error_message
                session_id.map(|s| s.to_string()),
                Some("codex_session"), // provider_type
                1i64,                // is_streaming
                "1.0",               // cost_multiplier
                created_at,
                "codex_session",     // data_source
            ]))
        .map_err(|e| AppError::Database(format!("插入 Codex 会话日志失败: {e}")))?;

    Ok(inserted_rows > 0)
}

/// 查找 Codex 模型定价（带归一化）
fn find_codex_pricing(conn: &rusqlite::Connection, model_id: &str) -> Option<ModelPricing> {
    find_model_pricing(conn, &normalize_codex_model(model_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::session_usage::get_sync_state;
    use serde_json::json;
    use std::io::Write;

    #[test]
    fn exact_checkpoint_lookup_does_not_scan_aliases() -> Result<(), AppError> {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let db = Database::memory()?;
        let path = Path::new("current/rollout.jsonl");
        let older_alias = "archived/rollout.jsonl";
        let newer_alias = r"moved\rollout.jsonl";
        let state = serde_json::to_string(&CodexParserState::initial(None)).unwrap();
        let progress = Arc::new(AtomicUsize::new(0));
        {
            let conn = lock_conn!(db.conn);
            let mut insert = conn.prepare(
                "INSERT INTO codex_usage_file_checkpoints (file_path, parser_state, updated_at)
                 VALUES (?1, ?2, ?3)",
            )?;
            for index in 0..256 {
                insert.execute(rusqlite::params![
                    format!("unrelated/{index}.jsonl"),
                    state,
                    0
                ])?;
            }
            for (name, updated_at) in [
                (path.to_str().unwrap(), 1),
                (older_alias, 2),
                (newer_alias, 3),
            ] {
                insert.execute(rusqlite::params![name, state, updated_at])?;
            }
        }
        // Snapshot construction is intentionally one table traversal. Measure
        // the production point lookup separately from that pass-start work.
        let pass = CodexSyncPass::load(&db)?;
        {
            let conn = lock_conn!(db.conn);
            let progress = progress.clone();
            conn.progress_handler(
                10,
                Some(move || {
                    progress.fetch_add(1, Ordering::Relaxed);
                    false
                }),
            );
        }

        let exact = pass.checkpoint(&db, path)?.expect("exact checkpoint");
        let progress_count = progress.load(Ordering::Relaxed);
        assert_eq!(exact.source_path, path.to_str().unwrap());
        assert!(
            progress_count < 10,
            "exact lookup used {progress_count} batches of 10 SQLite VM instructions"
        );

        {
            let conn = lock_conn!(db.conn);
            conn.progress_handler(0, None::<fn() -> bool>);
            conn.execute(
                "UPDATE codex_usage_file_checkpoints SET parser_state = '{}' WHERE file_path = ?1",
                [path.to_str().unwrap()],
            )?;
        }
        assert!(pass.checkpoint(&db, path)?.is_none());

        let moved = pass
            .checkpoint(&db, Path::new("third/rollout.jsonl"))?
            .expect("moved checkpoint");
        assert_eq!(moved.source_path, newer_alias);
        Ok(())
    }

    // Kept in the selected cold/warm performance regression as well as a
    // standalone test, so the performance runner cannot miss lookup work.
    fn assert_codex_lookup_work_is_bounded() -> Result<(), AppError> {
        for (rows, misses) in [(8usize, 16usize), (1024, 128)] {
            let db = Database::memory()?;
            let state = serde_json::to_string(&CodexParserState::initial(None)).unwrap();
            {
                let conn = lock_conn!(db.conn);
                let tx = conn.unchecked_transaction()?;
                for index in 0..rows {
                    // Many aliases for the same filename also must not make a
                    // successful moved/archived lookup traverse all candidates.
                    let path = format!("old/{index}/shared.jsonl");
                    tx.execute(
                        "INSERT INTO codex_usage_file_checkpoints
                        (file_path, parser_state, updated_at) VALUES (?1, ?2, ?3)",
                        rusqlite::params![path, state, index as i64],
                    )?;
                    update_sync_state_on_conn(&tx, &path, index as i64, index as i64 + 1)?;
                }
                tx.commit()?;
            }
            CODEX_LOOKUP_WORK.with(|work| work.set([0; 5]));
            let pass = CodexSyncPass::load(&db)?;
            CODEX_LOOKUP_WORK.with(|work| assert_eq!(work.get(), [rows, rows, 0, 0, 0]));
            for index in 0..misses {
                let path = PathBuf::from(format!("archived_sessions/missing-{index}.jsonl"));
                assert!(pass.checkpoint(&db, &path)?.is_none());
                assert_eq!(get_codex_sync_state(&db, &path, &pass)?, (0, 0));
            }
            // Misses add no row reads and no candidate iteration.
            CODEX_LOOKUP_WORK.with(|work| assert_eq!(work.get(), [rows, rows, 0, 0, 0]));
            for index in 0..misses {
                let moved = PathBuf::from(format!("moved/{index}/shared.jsonl"));
                assert_eq!(
                    pass.checkpoint(&db, &moved)?.unwrap().source_path,
                    format!("old/{}/shared.jsonl", rows - 1)
                );
                assert_eq!(
                    get_codex_sync_state(&db, Path::new("archived_sessions/shared.jsonl"), &pass)?,
                    (rows as i64 - 1, rows as i64)
                );
            }
            CODEX_LOOKUP_WORK
                .with(|work| assert_eq!(work.get(), [rows, rows, misses, misses, misses]));
        }
        Ok(())
    }

    #[test]
    fn checkpoint_and_archived_lookup_snapshot_is_bounded() -> Result<(), AppError> {
        assert_codex_lookup_work_is_bounded()
    }

    #[test]
    fn lookup_snapshot_preserves_exact_moved_and_committed_write_authority() -> Result<(), AppError>
    {
        let db = Database::memory()?;
        let state = serde_json::to_string(&CodexParserState::initial(None)).unwrap();
        let exact = Path::new("current/rollout_page.jsonl");
        {
            let conn = lock_conn!(db.conn);
            for (path, timestamp, text) in [
                (exact.to_str().unwrap(), 1, "{}"),
                ("old/rollout_page.jsonl", 2, state.as_str()),
                (r"moved\rollout_page.jsonl", 3, state.as_str()),
                ("unrelated/rolloutXpage.jsonl", 99, state.as_str()),
            ] {
                conn.execute(
                    "INSERT INTO codex_usage_file_checkpoints
                    (file_path, parser_state, updated_at) VALUES (?1, ?2, ?3)",
                    rusqlite::params![path, text, timestamp],
                )?;
            }
            update_sync_state_on_conn(&conn, "old/rollout_page.jsonl", 5, 10)?;
            update_sync_state_on_conn(&conn, r"moved\rollout_page.jsonl", 7, 10)?;
            update_sync_state_on_conn(&conn, exact.to_str().unwrap(), 99, 2)?;
            update_sync_state_on_conn(&conn, "archived_sessions/rollout_page.jsonl", 0, 0)?;
            update_sync_state_on_conn(&conn, "archived_sessions/zero.jsonl", 0, 0)?;
            update_sync_state_on_conn(&conn, "old/zero.jsonl", -1, 0)?;
        }
        let mut pass = CodexSyncPass::load(&db)?;
        // Invalid exact checkpoints never fall back to a valid moved alias.
        assert!(pass.checkpoint(&db, exact)?.is_none());
        let new_path = Path::new("new/ROLLOUT_page.jsonl");
        assert_eq!(
            pass.checkpoint(&db, new_path)?.unwrap().source_path,
            r"moved\rollout_page.jsonl"
        );
        assert_eq!(
            get_codex_sync_state(&db, Path::new("archived_sessions/zero.jsonl"), &pass)?,
            (-1, 0)
        );
        // Cursor matching is literal/case-sensitive; offset wins before mtime.
        assert_eq!(
            get_codex_sync_state(
                &db,
                Path::new("archived_sessions/rollout_page.jsonl"),
                &pass
            )?,
            (7, 10)
        );
        assert_eq!(get_codex_sync_state(&db, exact, &pass)?, (99, 2));
        let facts = CodexCheckpointFacts {
            file_size: 12,
            file_modified: 13,
            head_window_len: 0,
            head_fingerprint: 0,
            tail_fingerprint: 0,
        };
        // A rolled-back canonical write must not appear in either the current
        // projection or a fresh projection reconstructed from the database.
        {
            let conn = lock_conn!(db.conn);
            let tx = conn.unchecked_transaction()?;
            save_codex_checkpoint_on_conn(
                &tx,
                new_path,
                &CodexParserState::initial(None),
                99,
                &facts,
            )?;
            tx.rollback()?;
        }
        assert_eq!(
            pass.checkpoint_source(new_path),
            Some(r"moved\rollout_page.jsonl")
        );
        assert_eq!(
            CodexSyncPass::load(&db)?.checkpoint_source(new_path),
            Some(r"moved\rollout_page.jsonl")
        );
        {
            let conn = lock_conn!(db.conn);
            let tx = conn.unchecked_transaction()?;
            save_codex_checkpoint_on_conn(
                &tx,
                new_path,
                &CodexParserState::initial(None),
                11,
                &facts,
            )?;
            // An uncommitted write is not published into the derived lookup.
            assert_eq!(
                pass.checkpoint_source(Path::new("later/rollout_page.jsonl"))
                    .unwrap(),
                r"moved\rollout_page.jsonl"
            );
            tx.commit()?;
            pass.refresh_checkpoint_on_conn(&conn, new_path)?;
        }
        let moved = pass
            .checkpoint(&db, Path::new("later/rollout_page.jsonl"))?
            .unwrap();
        assert_eq!(moved.source_path, new_path.to_str().unwrap());
        assert_eq!(moved.last_byte_offset, 11);
        // Updating an existing row must remove its previous ordering key too.
        {
            let conn = lock_conn!(db.conn);
            let tx = conn.unchecked_transaction()?;
            save_codex_checkpoint_on_conn(
                &tx,
                new_path,
                &CodexParserState::initial(None),
                12,
                &facts,
            )?;
            tx.execute("UPDATE codex_usage_file_checkpoints SET updated_at=updated_at+1 WHERE file_path=?1", [new_path.to_str().unwrap()])?;
            tx.commit()?;
            pass.refresh_checkpoint_on_conn(&conn, new_path)?;
        }
        assert_eq!(
            pass.checkpoint(&db, Path::new("later/rollout_page.jsonl"))?
                .unwrap()
                .last_byte_offset,
            12
        );
        // Removing a migrated exact row exposes the next newest same-name row.
        {
            let conn = lock_conn!(db.conn);
            conn.execute(
                "DELETE FROM codex_usage_file_checkpoints WHERE file_path=?1",
                [new_path.to_str().unwrap()],
            )?;
        }
        pass.remove_checkpoint(new_path.to_str().unwrap());
        assert_eq!(
            pass.checkpoint(&db, Path::new("later/rollout_page.jsonl"))?
                .unwrap()
                .source_path,
            r"moved\rollout_page.jsonl"
        );
        pass.remove_cursor(r"moved\rollout_page.jsonl");
        assert_eq!(
            get_codex_sync_state(
                &db,
                Path::new("archived_sessions/rollout_page.jsonl"),
                &pass
            )?,
            (5, 10)
        );
        // A controlled DB rebuild creates a new projection; no prior aliases
        // or cursors may survive into the next collection snapshot.
        {
            let conn = lock_conn!(db.conn);
            conn.execute("DELETE FROM codex_usage_file_checkpoints", [])?;
            conn.execute("DELETE FROM session_log_sync", [])?;
        }
        let rebuilt = CodexSyncPass::load(&db)?;
        assert!(rebuilt.checkpoint(&db, exact)?.is_none());
        assert!(rebuilt.checkpoint(&db, new_path)?.is_none());
        assert_eq!(
            get_codex_sync_state(
                &db,
                Path::new("archived_sessions/rollout_page.jsonl"),
                &rebuilt
            )?,
            (0, 0)
        );
        Ok(())
    }

    #[test]
    fn stored_codex_filename_keys_preserve_both_separator_suffixes() {
        assert_eq!(
            stored_codex_filenames(r"/old/rollout-a\b.jsonl").collect::<Vec<_>>(),
            vec![r"rollout-a\b.jsonl", "b.jsonl"]
        );
        assert_eq!(
            stored_codex_filenames(r"C:\old/rollout.jsonl").collect::<Vec<_>>(),
            vec!["rollout.jsonl", "old/rollout.jsonl"]
        );
        assert_eq!(stored_codex_filenames("bare.jsonl").count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn posix_literal_backslash_filename_preserves_checkpoint_and_archived_fallback(
    ) -> Result<(), AppError> {
        let db = Database::memory()?;
        let source = r"/old/rollout-a\b.jsonl";
        let target = Path::new(r"/new/archived_sessions/rollout-a\b.jsonl");
        {
            let conn = lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO codex_usage_file_checkpoints
                (file_path, parser_state, updated_at) VALUES (?1, ?2, 1)",
                rusqlite::params![
                    source,
                    serde_json::to_string(&CodexParserState::initial(None)).unwrap()
                ],
            )?;
            update_sync_state_on_conn(&conn, source, 7, 11)?;
        }
        let mut pass = CodexSyncPass::load(&db)?;
        assert_eq!(pass.checkpoint(&db, target)?.unwrap().source_path, source);
        assert_eq!(get_codex_sync_state(&db, target, &pass)?, (7, 11));
        {
            let conn = lock_conn!(db.conn);
            conn.execute(
                "DELETE FROM codex_usage_file_checkpoints WHERE file_path=?1",
                [source],
            )?;
            conn.execute("DELETE FROM session_log_sync WHERE file_path=?1", [source])?;
        }
        pass.remove_checkpoint(source);
        pass.remove_cursor(source);
        // Both independent suffix keys must be removed, not just the last one.
        assert!(pass.checkpoint(&db, target)?.is_none());
        assert!(pass.checkpoint(&db, Path::new("/new/b.jsonl"))?.is_none());
        assert_eq!(get_codex_sync_state(&db, target, &pass)?, (0, 0));
        assert_eq!(
            get_codex_sync_state(&db, Path::new("/new/archived_sessions/b.jsonl"), &pass)?,
            (0, 0)
        );
        Ok(())
    }

    #[test]
    fn renamed_rollout_uses_committed_checkpoint_in_the_same_pass() -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let db = Database::memory()?;
        let file = rollout_path(dir.path(), PARENT_ID);
        write_jsonl(
            &file,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                token_count(100, 50, 10),
            ],
        );
        let mut pass = CodexSyncPass::load(&db)?;
        let first = sync_single_codex_file(
            &db,
            &file,
            &build_rollout_index(std::slice::from_ref(&file)),
            &mut pass,
        )?;
        assert_eq!(first.imported, 1);
        let moved_dir = dir.path().join("archived_sessions");
        fs::create_dir(&moved_dir).unwrap();
        let moved = moved_dir.join(file.file_name().unwrap());
        fs::rename(&file, &moved).unwrap();
        let second = sync_single_codex_file(
            &db,
            &moved,
            &build_rollout_index(std::slice::from_ref(&moved)),
            &mut pass,
        )?;
        assert!(!second.deferred);
        assert_eq!(second.imported, 0);
        assert_eq!(
            pass.checkpoint(&db, &moved)?.unwrap().source_path,
            file.to_str().unwrap()
        );
        Ok(())
    }
    use tempfile::tempdir;

    const PARENT_ID: &str = "00000000-0000-4000-8000-000000000001";
    const CHILD_A_ID: &str = "00000000-0000-4000-8000-000000000002";
    const CHILD_B_ID: &str = "00000000-0000-4000-8000-000000000003";

    #[test]
    #[serial_test::serial]
    fn discovery_follows_changed_codex_root_without_process_restart() -> Result<(), AppError> {
        let first = tempdir().unwrap();
        let second = tempdir().unwrap();
        let first_file = first.path().join("sessions/2020/01/01/first.jsonl");
        let second_file = second.path().join("sessions/2020/01/01/second.jsonl");
        let archived_file = second.path().join("archived_sessions/archived.jsonl");
        for file in [&first_file, &second_file, &archived_file] {
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, "{}\n").unwrap();
        }
        let first_file = fs::canonicalize(first_file).unwrap();
        let second_file = fs::canonicalize(second_file).unwrap();
        let archived_file = fs::canonicalize(archived_file).unwrap();

        let first_paths = discover_codex_session_files(first.path())?;
        assert_eq!(first_paths, vec![first_file.clone()]);
        let later_file = first.path().join("sessions/2020/01/01/later.jsonl");
        fs::write(&later_file, "{}\n").unwrap();
        let later_file = fs::canonicalize(later_file).unwrap();
        assert!(
            !discover_codex_session_files(first.path())?.contains(&later_file),
            "the same configured root must retain the bounded repair-scan schedule"
        );
        let second_paths = discover_codex_session_files(second.path())?;
        assert!(
            second_paths.contains(&second_file),
            "changing the configured Codex directory must discover its old sessions immediately"
        );
        assert!(second_paths.contains(&archived_file));
        assert!(
            !second_paths.contains(&first_file),
            "the previous configured directory must not remain the discovery authority"
        );
        let restored_paths = discover_codex_session_files(first.path())?;
        assert_eq!(restored_paths.len(), 2);
        assert!(restored_paths.contains(&first_file));
        assert!(restored_paths.contains(&later_file));
        assert!(
            !restored_paths.contains(&second_file) && !restored_paths.contains(&archived_file),
            "switching back must also discard the other directory's cached inventory"
        );
        Ok(())
    }

    #[test]
    fn repeated_retryable_defer_with_new_file_stamp_does_not_spam_warning() {
        let previous = PendingEntry {
            modified: 1,
            size: 10,
            reason: PendingReason::Retryable("父 rollout 尚未写到 child fork 时刻".to_string()),
        };
        let next = PendingEntry {
            modified: 2,
            size: 20,
            reason: previous.reason.clone(),
        };

        assert!(!should_warn_for_pending(Some(&previous), &next));
        assert!(should_warn_for_pending(
            Some(&previous),
            &PendingEntry {
                modified: 2,
                size: 20,
                reason: PendingReason::Retryable("父 rollout 已更新但仍无法验证".to_string()),
            }
        ));
    }

    fn write_retryable_snapshot_fixture(parent: &Path, child: &Path, padding: usize) {
        write_jsonl(
            parent,
            &[
                session_meta(PARENT_ID),
                token_count_at(100, 50, 10, "2026-07-10T03:00:01Z"),
            ],
        );
        let mut records = vec![
            session_meta_at(CHILD_A_ID, Some(PARENT_ID), None, "2026-07-10T03:00:05Z"),
            token_count_at(100, 50, 10, "2026-07-10T03:00:06Z"),
            token_count_at(150, 70, 20, "2026-07-10T03:00:07Z"),
        ];
        records.extend(std::iter::repeat_n(
            json!({"timestamp":"2026-07-10T03:00:08Z", "type":"response_item", "payload":{"text":"x".repeat(padding)}}),
            8,
        ));
        write_jsonl(child, &records);
    }

    fn finish_retryable_snapshot_parent(parent: &Path) {
        write_jsonl(
            parent,
            &[
                session_meta(PARENT_ID),
                token_count_at(100, 50, 10, "2026-07-10T03:00:01Z"),
                turn_context_at("2026-07-10T03:00:10Z"),
            ],
        );
    }

    fn assert_retryable_snapshot_waits_for_parent(child: &Path) {
        let caches = replay_caches().lock().unwrap();
        assert!(
            matches!(caches.pending.get(child).map(|entry| &entry.reason),
                Some(PendingReason::Retryable(reason)) if reason.contains("尚未写到 child fork 时刻")),
            "the fixture must reach parent readiness, not a malformed copied-child envelope"
        );
        let snapshot = &caches
            .retryable_snapshots
            .iter()
            .find(|entry| entry.path == child)
            .expect("retryable child snapshot retained")
            .snapshot;
        assert!(
            snapshot.copied_inspection_unavailable,
            "only an actual child-local Unavailable proof may avoid reinspection"
        );
    }

    #[test]
    #[serial_test::serial]
    fn retryable_child_snapshot_reuse_bounds_parsing_and_retained_records() -> Result<(), AppError>
    {
        let mut retained_bytes = None;
        for padding in [0, 96 * 1024] {
            clear_codex_replay_caches();
            let db = Database::memory()?;
            let dir = tempdir().unwrap();
            let parent = rollout_path(dir.path(), PARENT_ID);
            let child = rollout_path(dir.path(), CHILD_A_ID);
            write_retryable_snapshot_fixture(&parent, &child, padding);
            assert!(sync_test_file(&db, &child, &[&parent, &child])?.deferred);
            assert_retryable_snapshot_waits_for_parent(&child);
            let size = fs::metadata(&child).unwrap().len();
            let fallback_verify_bytes = if FileRevision::read(&child).is_some() {
                0
            } else {
                size
            };
            {
                let caches = replay_caches().lock().unwrap();
                assert_eq!(caches.retryable_snapshots.len(), 1);
                let entry = &caches.retryable_snapshots[0];
                assert_eq!(entry.records, 2);
                assert!(entry.estimated_bytes < 16 * 1024);
                // Tool-output bytes are not retained in the parser derivative.
                if let Some(previous) = retained_bytes {
                    assert_eq!(entry.estimated_bytes, previous);
                }
                retained_bytes = Some(entry.estimated_bytes);
            }
            CODEX_SNAPSHOT_PARSE_COUNT.with(|count| count.set(0));
            CODEX_SNAPSHOT_BYTES_READ.with(|bytes| bytes.set(0));
            CODEX_SNAPSHOT_VERIFY_BYTES_READ.with(|bytes| bytes.set(0));
            CODEX_COPIED_CHILD_INSPECTION_CALLS.with(|count| count.set(0));
            for _ in 0..3 {
                let repeated = sync_test_file(&db, &child, &[&parent, &child])?;
                assert!(repeated.deferred);
                assert_eq!(repeated.imported, 0);
            }
            CODEX_SNAPSHOT_PARSE_COUNT.with(|count| assert_eq!(count.get(), 0));
            CODEX_SNAPSHOT_BYTES_READ.with(|bytes| assert_eq!(bytes.get(), 0));
            CODEX_SNAPSHOT_VERIFY_BYTES_READ
                .with(|bytes| assert_eq!(bytes.get(), 3 * fallback_verify_bytes));
            CODEX_COPIED_CHILD_INSPECTION_CALLS.with(|count| assert_eq!(count.get(), 0));
            assert_eq!(get_sync_state(&db, &child.to_string_lossy())?, (0, 0));
            finish_retryable_snapshot_parent(&parent);
            let recovered = sync_test_file(&db, &child, &[&parent, &child])?;
            assert_eq!(
                (recovered.imported, recovered.skipped, recovered.deferred),
                (1, 1, false)
            );
            CODEX_SNAPSHOT_PARSE_COUNT.with(|count| assert_eq!(count.get(), 0));
            CODEX_SNAPSHOT_VERIFY_BYTES_READ
                .with(|bytes| assert_eq!(bytes.get(), 4 * fallback_verify_bytes));
            CODEX_COPIED_CHILD_INSPECTION_CALLS.with(|count| assert_eq!(count.get(), 0));
            assert!(replay_caches()
                .lock()
                .unwrap()
                .retryable_snapshots
                .is_empty());
            assert_eq!(sync_test_file(&db, &child, &[&parent, &child])?.imported, 0);
            let conn = lock_conn!(db.conn);
            // Codex input_tokens already includes the cached subset. Keep
            // each ledger column explicit rather than counting cache twice.
            let billed: (i64, i64, i64, i64) = conn.query_row(
                "SELECT COUNT(*), SUM(input_tokens), SUM(cache_read_tokens), SUM(output_tokens) FROM proxy_request_logs WHERE data_source='codex_session'",
                [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(billed, (1, 50, 20, 10));
        }
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn retryable_child_snapshots_reuse_many_files_that_fit_global_budgets() -> Result<(), AppError>
    {
        clear_codex_replay_caches();
        let db = Database::memory()?;
        let dir = tempdir().unwrap();
        let parent = rollout_path(dir.path(), PARENT_ID);
        let mut children = Vec::new();
        for ordinal in 0..33 {
            let child_dir = dir.path().join(format!("child-{ordinal}"));
            fs::create_dir(&child_dir).unwrap();
            let child = rollout_path(&child_dir, CHILD_A_ID);
            write_retryable_snapshot_fixture(&parent, &child, 128);
            children.push(child);
        }
        let mut files = vec![parent.as_path()];
        files.extend(children.iter().map(PathBuf::as_path));
        for child in &children {
            assert!(sync_test_file(&db, child, &files)?.deferred);
            assert_retryable_snapshot_waits_for_parent(child);
        }
        assert_eq!(
            replay_caches().lock().unwrap().retryable_snapshots.len(),
            children.len()
        );
        CODEX_SNAPSHOT_PARSE_COUNT.with(|count| count.set(0));
        CODEX_SNAPSHOT_BYTES_READ.with(|bytes| bytes.set(0));
        CODEX_SNAPSHOT_VERIFY_BYTES_READ.with(|bytes| bytes.set(0));
        CODEX_COPIED_CHILD_INSPECTION_CALLS.with(|count| count.set(0));
        let fallback_verify_bytes: u64 = children
            .iter()
            .filter(|path| FileRevision::read(path).is_none())
            .map(|path| fs::metadata(path).unwrap().len())
            .sum();
        for _ in 0..2 {
            for child in &children {
                assert!(sync_test_file(&db, child, &files)?.deferred);
            }
        }
        CODEX_SNAPSHOT_PARSE_COUNT.with(|count| assert_eq!(count.get(), 0));
        CODEX_SNAPSHOT_BYTES_READ.with(|bytes| assert_eq!(bytes.get(), 0));
        CODEX_SNAPSHOT_VERIFY_BYTES_READ
            .with(|bytes| assert_eq!(bytes.get(), 2 * fallback_verify_bytes));
        CODEX_COPIED_CHILD_INSPECTION_CALLS.with(|count| assert_eq!(count.get(), 0));
        assert_eq!(
            replay_caches().lock().unwrap().retryable_snapshots.len(),
            children.len()
        );
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn retryable_parent_timeline_checks_exact_bytes_without_reparsing_unchanged_history(
    ) -> Result<(), AppError> {
        for padding in [0, 96 * 1024] {
            clear_codex_replay_caches();
            let db = Database::memory()?;
            let dir = tempdir().unwrap();
            let parent = rollout_path(dir.path(), PARENT_ID);
            let child = rollout_path(dir.path(), CHILD_A_ID);
            write_retryable_snapshot_fixture(&parent, &child, 128);
            let mut parent_records = vec![
                session_meta(PARENT_ID),
                token_count_at(100, 50, 10, "2026-07-10T03:00:01Z"),
                turn_context_at("2026-07-10T03:00:04Z"),
            ];
            parent_records.extend(std::iter::repeat_n(
                json!({"timestamp":"2026-07-10T03:00:02Z", "type":"response_item", "payload":{"text":"x".repeat(padding)}}),
                8,
            ));
            write_jsonl(&parent, &parent_records);
            assert!(sync_test_file(&db, &child, &[&parent, &child])?.deferred);
            assert_retryable_snapshot_waits_for_parent(&child);
            let size = fs::metadata(&parent).unwrap().len();
            let modified = fs::metadata(&parent).unwrap().modified().unwrap();
            let stamp = ParentFileStamp::from_file(&fs::File::open(&parent).unwrap());
            let fallback_verify_bytes = if FileRevision::read(&parent).is_some() {
                0
            } else {
                size
            };
            CODEX_PARENT_TIMELINE_PARSES.with(|count| count.set(0));
            CODEX_PARENT_TIMELINE_PARSE_BYTES.with(|bytes| bytes.set(0));
            CODEX_PARENT_TIMELINE_VERIFY_BYTES.with(|bytes| bytes.set(0));
            CODEX_SNAPSHOT_PARSE_COUNT.with(|count| count.set(0));
            for _ in 0..3 {
                assert!(sync_test_file(&db, &child, &[&parent, &child])?.deferred);
            }
            CODEX_PARENT_TIMELINE_PARSES.with(|count| assert_eq!(count.get(), 0));
            CODEX_PARENT_TIMELINE_PARSE_BYTES.with(|bytes| assert_eq!(bytes.get(), 0));
            CODEX_PARENT_TIMELINE_VERIFY_BYTES
                .with(|bytes| assert_eq!(bytes.get(), 3 * fallback_verify_bytes));
            parent_records[2] = turn_context_at("2026-07-10T03:00:09Z");
            write_jsonl(&parent, &parent_records);
            fs::OpenOptions::new()
                .write(true)
                .open(&parent)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(modified))
                .unwrap();
            assert_eq!(fs::metadata(&parent).unwrap().len(), size);
            assert_eq!(
                ParentFileStamp::from_file(&fs::File::open(&parent).unwrap()),
                stamp
            );
            let recovered = sync_test_file(&db, &child, &[&parent, &child])?;
            assert_eq!(
                (recovered.imported, recovered.skipped, recovered.deferred),
                (1, 1, false)
            );
            CODEX_PARENT_TIMELINE_PARSES.with(|count| assert_eq!(count.get(), 1));
            CODEX_PARENT_TIMELINE_PARSE_BYTES.with(|bytes| assert_eq!(bytes.get(), size));
            CODEX_PARENT_TIMELINE_VERIFY_BYTES
                .with(|bytes| assert_eq!(bytes.get(), 3 * fallback_verify_bytes + 2 * size));
            CODEX_SNAPSHOT_PARSE_COUNT.with(|count| assert_eq!(count.get(), 0));
            assert_eq!(sync_test_file(&db, &child, &[&parent, &child])?.imported, 0);
        }
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn parent_timeline_preserves_crlf_invalid_utf8_and_unterminated_record_semantics() {
        clear_codex_replay_caches();
        let dir = tempdir().unwrap();
        let parent = rollout_path(dir.path(), PARENT_ID);
        let mut bytes = format!(
            "{}\r\n{}\r\n",
            session_meta(PARENT_ID),
            token_count_at(100, 50, 10, "2026-07-10T03:00:01Z")
        )
        .into_bytes();
        bytes.extend_from_slice(b"\xff\n");
        bytes.extend_from_slice(
            turn_context_at("2026-07-10T03:00:10Z")
                .to_string()
                .as_bytes(),
        );
        fs::write(&parent, bytes).unwrap();
        let cutoff = "2026-07-10T03:00:05Z".parse::<DateTime<Utc>>().unwrap();
        assert_eq!(parent_signatures_before(&parent, cutoff).unwrap().len(), 1);
        assert_eq!(parent_signatures_before(&parent, cutoff).unwrap().len(), 1);
    }

    #[test]
    #[serial_test::serial]
    fn parent_timeline_rejects_same_stamp_rewrite_during_parse_validation() {
        clear_codex_replay_caches();
        let dir = tempdir().unwrap();
        let parent = rollout_path(dir.path(), PARENT_ID);
        finish_retryable_snapshot_parent(&parent);
        let modified = fs::metadata(&parent).unwrap().modified().unwrap();
        let original_stamp = ParentFileStamp::from_file(&fs::File::open(&parent).unwrap());
        let rewrite = parent.clone();
        BEFORE_CODEX_PARENT_TIMELINE_VERIFY.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                write_jsonl(
                    &rewrite,
                    &[
                        session_meta(PARENT_ID),
                        token_count_at(200, 50, 10, "2026-07-10T03:00:01Z"),
                        turn_context_at("2026-07-10T03:00:10Z"),
                    ],
                );
                fs::OpenOptions::new()
                    .write(true)
                    .open(&rewrite)
                    .unwrap()
                    .set_times(fs::FileTimes::new().set_modified(modified))
                    .unwrap();
                assert_eq!(
                    ParentFileStamp::from_file(&fs::File::open(&rewrite).unwrap()),
                    original_stamp
                );
            }))
        });
        let cutoff = "2026-07-10T03:00:05Z".parse::<DateTime<Utc>>().unwrap();
        assert!(parent_signatures_before(&parent, cutoff).is_err());
        assert!(!replay_caches()
            .lock()
            .unwrap()
            .parent_timelines
            .contains_key(&parent));
        let recovered = parent_signatures_before(&parent, cutoff).unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].total.as_ref().unwrap().input, Some(200));
    }

    #[test]
    #[serial_test::serial]
    fn retryable_child_snapshot_revalidates_middle_rewrite_append_and_replacement(
    ) -> Result<(), AppError> {
        use std::io::Write;
        for change in ["same_stamp_middle", "append", "replacement"] {
            clear_codex_replay_caches();
            let db = Database::memory()?;
            let dir = tempdir().unwrap();
            let parent = rollout_path(dir.path(), PARENT_ID);
            let child = rollout_path(dir.path(), CHILD_A_ID);
            write_retryable_snapshot_fixture(&parent, &child, 16 * 1024);
            // Place the billable token change outside both 4 KiB fingerprints.
            let mut records = vec![
                session_meta_at(CHILD_A_ID, Some(PARENT_ID), None, "2026-07-10T03:00:05Z"),
                json!({"timestamp":"2026-07-10T03:00:08Z", "type":"response_item", "payload":{"text":"x".repeat(16 * 1024)}}),
                token_count_at(100, 50, 10, "2026-07-10T03:00:06Z"),
                token_count_at(150, 70, 20, "2026-07-10T03:00:07Z"),
                json!({"timestamp":"2026-07-10T03:00:08Z", "type":"response_item", "payload":{"text":"x".repeat(16 * 1024)}}),
            ];
            write_jsonl(&child, &records);
            assert!(sync_test_file(&db, &child, &[&parent, &child])?.deferred);
            assert_retryable_snapshot_waits_for_parent(&child);
            let metadata = fs::metadata(&child).unwrap();
            let stamp = ParentFileStamp::from_file(&fs::File::open(&child).unwrap());
            let original = fs::read(&child).unwrap();
            CODEX_SNAPSHOT_PARSE_COUNT.with(|count| count.set(0));
            match change {
                "append" => {
                    fs::OpenOptions::new()
                        .append(true)
                        .open(&child)
                        .unwrap()
                        .write_all(
                            format!("{}\n", token_count_at(160, 70, 20, "2026-07-10T03:00:08Z"))
                                .as_bytes(),
                        )
                        .unwrap();
                }
                "replacement" => {
                    let replacement = dir.path().join("replacement.jsonl");
                    fs::write(&replacement, &original).unwrap();
                    fs::remove_file(&child).unwrap();
                    fs::rename(replacement, &child).unwrap();
                    fs::OpenOptions::new()
                        .write(true)
                        .open(&child)
                        .unwrap()
                        .set_times(fs::FileTimes::new().set_modified(metadata.modified().unwrap()))
                        .unwrap();
                    assert_ne!(
                        ParentFileStamp::from_file(&fs::File::open(&child).unwrap()),
                        stamp
                    );
                }
                _ => {
                    records[3] = token_count_at(180, 70, 20, "2026-07-10T03:00:07Z");
                    write_jsonl(&child, &records);
                    fs::OpenOptions::new()
                        .write(true)
                        .open(&child)
                        .unwrap()
                        .set_times(fs::FileTimes::new().set_modified(metadata.modified().unwrap()))
                        .unwrap();
                    assert_eq!(
                        ParentFileStamp::from_file(&fs::File::open(&child).unwrap()),
                        stamp
                    );
                    let rewritten = fs::read(&child).unwrap();
                    assert_eq!(original.len(), rewritten.len());
                    assert_eq!(
                        original[..CODEX_FINGERPRINT_BYTES],
                        rewritten[..CODEX_FINGERPRINT_BYTES]
                    );
                    assert_eq!(
                        original[original.len() - CODEX_FINGERPRINT_BYTES..],
                        rewritten[rewritten.len() - CODEX_FINGERPRINT_BYTES..]
                    );
                    assert_ne!(original, rewritten);
                }
            }
            finish_retryable_snapshot_parent(&parent);
            let recovered = sync_test_file(&db, &child, &[&parent, &child])?;
            assert!(!recovered.deferred, "{change}");
            CODEX_SNAPSHOT_PARSE_COUNT.with(|count| assert_eq!(count.get(), 1, "{change}"));
            let conn = lock_conn!(db.conn);
            let billed: (i64, i64, i64, i64) = conn.query_row(
                "SELECT COUNT(*), SUM(input_tokens), SUM(cache_read_tokens), SUM(output_tokens) FROM proxy_request_logs WHERE data_source='codex_session'",
                [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(
                billed,
                match change {
                    "same_stamp_middle" => (1, 80, 20, 10),
                    "append" => (2, 60, 20, 10),
                    _ => (1, 50, 20, 10),
                }
            );
            assert!(replay_caches()
                .lock()
                .unwrap()
                .retryable_snapshots
                .is_empty());
        }
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn retryable_child_snapshot_admission_eviction_and_discovery_are_bounded(
    ) -> Result<(), AppError> {
        clear_codex_replay_caches();
        let dir = tempdir().unwrap();
        let parent = rollout_path(dir.path(), PARENT_ID);
        let child = rollout_path(dir.path(), CHILD_A_ID);
        write_retryable_snapshot_fixture(&parent, &child, 0);
        let mut caches = CodexReplayCaches::default();
        let mut snapshot = parse_codex_snapshot(&child, None)?;
        snapshot.state.current_model = "x".repeat(MAX_RETRYABLE_SNAPSHOT_BYTES);
        caches.retain_retryable_snapshot(&child, snapshot);
        assert!(caches.retryable_snapshots.is_empty());
        let mut snapshot = parse_codex_snapshot(&child, None)?;
        snapshot.parsed.token_events =
            vec![snapshot.parsed.token_events[0].clone(); MAX_RETRYABLE_SNAPSHOT_RECORDS + 1];
        caches.retain_retryable_snapshot(&child, snapshot);
        assert!(caches.retryable_snapshots.is_empty());
        for ordinal in 0..MAX_RETRYABLE_SNAPSHOTS + 3 {
            let path = dir.path().join(format!("cache-key-{ordinal}"));
            caches.retain_retryable_snapshot(&path, parse_codex_snapshot(&child, None)?);
            assert!(caches.retryable_snapshots.len() <= MAX_RETRYABLE_SNAPSHOTS);
            assert!(
                caches
                    .retryable_snapshots
                    .iter()
                    .map(|entry| entry.records)
                    .sum::<usize>()
                    <= MAX_RETRYABLE_TOTAL_RECORDS
            );
            assert!(
                caches
                    .retryable_snapshots
                    .iter()
                    .map(|entry| entry.estimated_bytes)
                    .sum::<usize>()
                    <= MAX_RETRYABLE_TOTAL_BYTES
            );
        }
        assert_eq!(caches.retryable_snapshots.len(), MAX_RETRYABLE_SNAPSHOTS);
        assert!(caches
            .retryable_snapshots
            .iter()
            .all(|entry| entry.path != dir.path().join("cache-key-0")));
        let retained = caches.retryable_snapshots.back().unwrap().path.clone();
        caches.retain_discovered_replay_derivatives(std::slice::from_ref(&retained));
        assert_eq!(caches.retryable_snapshots.len(), 1);
        assert!(caches.take_retryable_snapshot(&retained).is_some());
        assert!(caches.retryable_snapshots.is_empty());
        for budget in ["records", "allocations"] {
            caches = CodexReplayCaches::default();
            for ordinal in 0..MAX_RETRYABLE_SNAPSHOTS {
                let mut snapshot = parse_codex_snapshot(&child, None)?;
                if budget == "records" {
                    snapshot.parsed.token_events = vec![
                        snapshot.parsed.token_events[0].clone();
                        MAX_RETRYABLE_SNAPSHOT_RECORDS
                    ];
                } else {
                    snapshot.state.current_model = "x".repeat(400 * 1024);
                }
                caches.retain_retryable_snapshot(
                    &dir.path().join(format!("budget-key-{ordinal}")),
                    snapshot,
                );
                assert!(
                    caches
                        .retryable_snapshots
                        .iter()
                        .map(|entry| entry.records)
                        .sum::<usize>()
                        <= MAX_RETRYABLE_TOTAL_RECORDS
                );
                assert!(
                    caches
                        .retryable_snapshots
                        .iter()
                        .map(|entry| entry.estimated_bytes)
                        .sum::<usize>()
                        <= MAX_RETRYABLE_TOTAL_BYTES
                );
            }
            assert!(
                !caches.retryable_snapshots.is_empty(),
                "{budget} entries must fit individually"
            );
            assert!(
                caches.retryable_snapshots.len() < MAX_RETRYABLE_SNAPSHOTS,
                "{budget} must evict before the entry-count limit"
            );
        }
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn retryable_parent_defer_warns_once_through_real_sync_and_clears_after_recovery(
    ) -> Result<(), AppError> {
        clear_codex_replay_caches();
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let parent = rollout_path(temp.path(), PARENT_ID);
        let child = rollout_path(temp.path(), CHILD_A_ID);
        write_jsonl(
            &parent,
            &[
                session_meta(PARENT_ID),
                token_count_at(100, 50, 10, "2026-07-10T03:00:01Z"),
            ],
        );
        write_jsonl(
            &child,
            &[
                session_meta_at(CHILD_A_ID, Some(PARENT_ID), None, "2026-07-10T03:00:05Z"),
                token_count_at(100, 50, 10, "2026-07-10T03:00:06Z"),
                token_count_at(150, 70, 20, "2026-07-10T03:00:07Z"),
            ],
        );
        let take_warnings = || {
            CODEX_PENDING_WARNING_PATHS.with(|paths| {
                let mut paths = paths.borrow_mut();
                let count = paths.iter().filter(|path| *path == &child).count();
                paths.retain(|path| path != &child);
                count
            })
        };

        let first = sync_test_file(&db, &child, &[&parent, &child])?;
        assert!(first.deferred);
        assert_eq!(take_warnings(), 1, "the first unresolved parent must warn");
        for _ in 0..2 {
            let repeated = sync_test_file(&db, &child, &[&parent, &child])?;
            assert!(repeated.deferred);
            assert_eq!(repeated.imported, 0);
            assert_eq!(get_sync_state(&db, &child.to_string_lossy())?, (0, 0));
            assert_eq!(
                take_warnings(),
                0,
                "an unchanged retryable parent reason must not warn again"
            );
        }

        // A genuinely changed reason still warns; this fix must not mute all
        // deferred cases or stop checking whether the parent becomes usable.
        write_jsonl(
            &parent,
            &[
                session_meta(PARENT_ID),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": {
                        "type": "token_count",
                        "info": { "total_token_usage": { "input_tokens": 100 } }
                    }
                }),
            ],
        );
        let changed = sync_test_file(&db, &child, &[&parent, &child])?;
        assert!(changed.deferred);
        assert_eq!(take_warnings(), 1, "a changed pending reason must warn");

        write_jsonl(
            &parent,
            &[
                session_meta(PARENT_ID),
                token_count_at(100, 50, 10, "2026-07-10T03:00:01Z"),
                turn_context_at("2026-07-10T03:00:10Z"),
            ],
        );
        let recovered = sync_test_file(&db, &child, &[&parent, &child])?;
        assert_eq!(
            (recovered.imported, recovered.skipped, recovered.deferred),
            (1, 1, false)
        );
        assert_eq!(take_warnings(), 0);
        assert!(!replay_caches().lock().unwrap().pending.contains_key(&child));
        assert!(get_sync_state(&db, &child.to_string_lossy())?.1 > 0);
        assert_eq!(sync_test_file(&db, &child, &[&parent, &child])?.imported, 0);
        Ok(())
    }

    fn write_jsonl(path: &Path, values: &[serde_json::Value]) {
        let contents = values
            .iter()
            .map(serde_json::Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        fs::write(path, contents).unwrap();
    }

    const CHILD_A_PAGE_1_ID: &str = "00000000-0000-4000-8000-000000000004";
    const CHILD_A_PAGE_2_ID: &str = "00000000-0000-4000-8000-000000000005";

    fn write_paginated_jsonl(path: &Path, values: &[serde_json::Value]) {
        fs::write(path, paginated_jsonl_contents(values)).unwrap();
    }

    fn paginated_jsonl_contents(values: &[serde_json::Value]) -> String {
        values
            .iter()
            .enumerate()
            .map(|(ordinal, value)| {
                let mut value = value.clone();
                value["ordinal"] = serde_json::json!(ordinal as u64);
                value.to_string()
            })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n"
    }

    fn paginated_session_meta_at(
        thread_id: &str,
        forked_from_id: Option<&str>,
        history_base_thread_id: Option<&str>,
        history_base_cutoff: Option<(u64, u64)>,
        timestamp: &str,
    ) -> serde_json::Value {
        let mut payload = serde_json::json!({
            "id": thread_id,
            "forked_from_id": forked_from_id,
            "source": "cli",
            "history_mode": "paginated",
        });
        if let Some(history_base_thread_id) = history_base_thread_id {
            let (end_ordinal_exclusive, end_byte_offset) =
                history_base_cutoff.expect("history_base cutoff");
            payload["history_base"] = serde_json::json!({
                "thread_id": history_base_thread_id,
                "end_ordinal_exclusive": end_ordinal_exclusive,
                "end_byte_offset": end_byte_offset,
            });
        }
        serde_json::json!({"timestamp": timestamp, "type": "session_meta", "payload": payload})
    }

    fn history_base_cutoff(path: &Path, end_ordinal_exclusive: u64) -> (u64, u64) {
        (end_ordinal_exclusive, fs::metadata(path).unwrap().len())
    }

    fn jsonl_contents(values: &[serde_json::Value]) -> String {
        values
            .iter()
            .enumerate()
            .map(|(ordinal, value)| {
                let mut value = value.clone();
                value["ordinal"] = serde_json::json!(ordinal as u64);
                value.to_string()
            })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n"
    }

    fn rollout_path(dir: &Path, thread_id: &str) -> PathBuf {
        dir.join(format!("rollout-2026-07-10T03-00-00-{thread_id}.jsonl"))
    }

    fn session_meta_at(
        thread_id: &str,
        forked_from_id: Option<&str>,
        spawned_from_id: Option<&str>,
        timestamp: &str,
    ) -> serde_json::Value {
        let source = spawned_from_id.map_or_else(
            || serde_json::Value::String("cli".to_string()),
            |parent| {
                serde_json::json!({
                    "subagent": {
                        "thread_spawn": { "parent_thread_id": parent }
                    }
                })
            },
        );
        serde_json::json!({
            "timestamp": timestamp,
            "type": "session_meta",
            "payload": {
                "id": thread_id,
                "forked_from_id": forked_from_id,
                "source": source
            }
        })
    }

    fn session_meta(thread_id: &str) -> serde_json::Value {
        session_meta_at(thread_id, None, None, "2026-07-10T03:00:00Z")
    }

    fn turn_context_for_model_at(model: &str, timestamp: &str) -> serde_json::Value {
        serde_json::json!({
            "timestamp": timestamp,
            "type": "turn_context",
            "payload": { "model": model }
        })
    }

    fn turn_context_at(timestamp: &str) -> serde_json::Value {
        turn_context_for_model_at("gpt-5.6-sol", timestamp)
    }

    fn turn_context() -> serde_json::Value {
        turn_context_at("2026-07-10T03:00:01Z")
    }

    fn token_count_at(input: u64, cached: u64, output: u64, timestamp: &str) -> serde_json::Value {
        serde_json::json!({
            "timestamp": timestamp,
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": { "total_token_usage": {
                    "input_tokens": input,
                    "cached_input_tokens": cached,
                    "output_tokens": output,
                    "reasoning_output_tokens": 0,
                    "total_tokens": input + output
                }}
            }
        })
    }

    #[test]
    fn codex_incremental_state_matches_full_parser_and_does_not_commit_partial_utf8_tail(
    ) -> Result<(), AppError> {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(format!("rollout-{PARENT_ID}.jsonl"));
        let values = vec![
            session_meta(PARENT_ID),
            serde_json::json!({"type":"turn_context","payload":{"model":"gpt-5.6"}}),
            token_count_at(10, 2, 3, "2026-09-14T00:00:01Z"),
        ];
        write_jsonl(&file, &values);
        let full = parse_codex_file(&file, Some(PARENT_ID.to_string()))?;
        let bytes = fs::read(&file).unwrap();
        let mut state = CodexParserState::initial(Some(PARENT_ID.to_string()));
        let mut offset = 0;
        for line in bytes.split_inclusive(|byte| *byte == b'\n') {
            if !line.ends_with(b"\n") {
                break;
            }
            offset += 1;
            let _ = parse_codex_incremental_line(
                &file,
                &mut state,
                std::str::from_utf8(line).unwrap(),
                offset,
            );
        }
        assert_eq!(
            state.event_index,
            full.token_events
                .iter()
                .filter_map(|event| event.event_index)
                .max()
                .unwrap_or(0)
        );
        assert_eq!(
            state.current_model,
            full.token_events
                .last()
                .map(|event| event.model.clone())
                .unwrap_or_else(|| "unknown".to_string())
        );
        let before = state.event_index;
        let partial = b"{\"type\":\"event_msg\",\"payload\":\"\xF0\x9F";
        assert!(std::str::from_utf8(partial).is_err());
        // The byte reader never calls the state machine for this un-terminated tail.
        assert_eq!(state.event_index, before);
        Ok(())
    }

    #[test]
    fn codex_snapshot_accepts_append_after_bounded_boundary_is_captured() -> Result<(), AppError> {
        use std::io::Write;

        let temp = tempfile::tempdir().unwrap();
        let file = rollout_path(temp.path(), PARENT_ID);
        write_jsonl(
            &file,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                token_count_at(10, 2, 3, "2026-09-14T00:00:01Z"),
            ],
        );
        let initial_size = fs::metadata(&file).unwrap().len();
        let appended = turn_context_at("2026-09-14T00:00:02Z").to_string() + "\n";
        CODEX_SNAPSHOT_TEST_HOOK.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move |path| {
                fs::OpenOptions::new()
                    .append(true)
                    .open(path)
                    .unwrap()
                    .write_all(appended.as_bytes())
                    .unwrap();
            }));
        });

        let snapshot = parse_codex_snapshot(&file, None)?;

        assert_eq!(snapshot.file_size, initial_size as i64);
        assert_eq!(snapshot.complete_bytes, initial_size as i64);
        assert!(snapshot
            .file_stamp
            .is_some_and(|stamp| stamp.size > initial_size));
        assert_eq!(snapshot.parsed.line_offset, 3);
        Ok(())
    }

    #[test]
    fn codex_snapshot_rejects_same_size_rewrite_with_preserved_mtime() -> Result<(), AppError> {
        let temp = tempfile::tempdir().unwrap();
        let file = rollout_path(temp.path(), PARENT_ID);
        write_jsonl(
            &file,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                token_count_at(10, 2, 3, "2026-09-14T00:00:01Z"),
            ],
        );
        let original_metadata = fs::metadata(&file).unwrap();
        let original_mtime = original_metadata.modified().unwrap();
        let original = fs::read_to_string(&file).unwrap();
        let rewritten = original.replace("gpt-5.6-sol", "gpt-5.6-sun");
        assert_eq!(rewritten.len(), original.len());
        let mut rewrite_file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&file)
            .unwrap();
        CODEX_SNAPSHOT_TEST_HOOK.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move |_path| {
                rewrite_file.seek(SeekFrom::Start(0)).unwrap();
                rewrite_file.set_len(0).unwrap();
                rewrite_file.write_all(rewritten.as_bytes()).unwrap();
                rewrite_file.flush().unwrap();
                rewrite_file
                    .set_times(fs::FileTimes::new().set_modified(original_mtime))
                    .unwrap();
            }));
        });

        let error = parse_codex_snapshot(&file, None).unwrap_err();
        let AppError::Config(reason) = error else {
            panic!("expected a configuration error for a rewritten snapshot");
        };
        assert!(
            reason.contains("前缀被替换") || reason.contains("内容被改写"),
            "unexpected rewrite error: {reason}"
        );
        Ok(())
    }

    fn token_count(input: u64, cached: u64, output: u64) -> serde_json::Value {
        token_count_at(input, cached, output, "2026-07-10T03:00:02Z")
    }

    fn token_count_without_timestamp(input: u64, cached: u64, output: u64) -> serde_json::Value {
        let mut value = token_count(input, cached, output);
        value
            .as_object_mut()
            .expect("token_count must be an object")
            .remove("timestamp");
        value
    }

    #[allow(clippy::too_many_arguments)]
    fn token_count_with_last_at(
        total_input: u64,
        total_cached: u64,
        total_output: u64,
        last_input: u64,
        last_cached: u64,
        last_output: u64,
        limit_id: &str,
        timestamp: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "timestamp": timestamp,
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": {
                        "input_tokens": total_input,
                        "cached_input_tokens": total_cached,
                        "output_tokens": total_output,
                        "reasoning_output_tokens": 0,
                        "total_tokens": total_input + total_output
                    },
                    "last_token_usage": {
                        "input_tokens": last_input,
                        "cached_input_tokens": last_cached,
                        "output_tokens": last_output,
                        "reasoning_output_tokens": 0,
                        "total_tokens": last_input + last_output
                    }
                },
                "rate_limits": { "limit_id": limit_id }
            }
        })
    }

    fn sync_test_file(
        db: &Database,
        file: &Path,
        all_files: &[&Path],
    ) -> Result<CodexFileSyncResult, AppError> {
        let files = all_files
            .iter()
            .map(|path| path.to_path_buf())
            .collect::<Vec<_>>();
        let mut pass = CodexSyncPass::load(db)?;
        sync_single_codex_file(db, file, &build_rollout_index(&files), &mut pass)
    }

    #[test]
    #[serial_test::serial]
    fn upstream_4_paginated_fork_pages_use_linked_cumulative_baselines_and_deduplicate(
    ) -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let parent = rollout_path(dir.path(), PARENT_ID);
        let root = rollout_path(dir.path(), CHILD_A_ID);
        let page1 = dir.path().join(format!(
            "rollout-2026-07-10T03-00-00-{CHILD_A_ID}_{CHILD_A_PAGE_1_ID}.jsonl"
        ));
        let page2 = dir.path().join(format!(
            "rollout-2026-07-10T03-00-00-{CHILD_A_ID}_{CHILD_A_PAGE_2_ID}.jsonl"
        ));
        write_paginated_jsonl(
            &parent,
            &[
                session_meta_at(PARENT_ID, None, None, "2026-07-10T03:00:30Z"),
                token_count_at(1000, 100, 100, "2026-07-10T03:00:10Z"),
            ],
        );
        write_paginated_jsonl(
            &root,
            &[
                session_meta_at(CHILD_A_ID, Some(PARENT_ID), None, "2026-07-10T03:00:15Z"),
                token_count_at(1000, 100, 100, "2026-07-10T03:00:15Z"),
                token_count_at(1500, 150, 150, "2026-07-10T03:00:20Z"),
            ],
        );
        write_paginated_jsonl(
            &page1,
            &[
                paginated_session_meta_at(
                    CHILD_A_ID,
                    Some(PARENT_ID),
                    Some(CHILD_A_ID),
                    Some(history_base_cutoff(&root, 3)),
                    "2026-07-10T03:01:00Z",
                ),
                token_count_at(1700, 170, 170, "2026-07-10T03:01:01Z"),
            ],
        );
        write_paginated_jsonl(
            &page2,
            &[
                paginated_session_meta_at(
                    CHILD_A_ID,
                    Some(PARENT_ID),
                    Some(CHILD_A_PAGE_1_ID),
                    Some(history_base_cutoff(&page1, 2)),
                    "2026-07-10T03:02:00Z",
                ),
                token_count_at(2000, 200, 200, "2026-07-10T03:02:01Z"),
            ],
        );
        let files = [
            parent.as_path(),
            root.as_path(),
            page1.as_path(),
            page2.as_path(),
        ];
        let db = Database::memory()?;
        for file in [
            parent.as_path(),
            root.as_path(),
            page1.as_path(),
            page2.as_path(),
        ] {
            CODEX_SNAPSHOT_PARSE_COUNT.with(|count| count.set(0));
            CODEX_SNAPSHOT_BYTES_READ.with(|bytes| bytes.set(0));
            let result = sync_test_file(&db, file, &files)?;
            assert!(!result.deferred, "{} deferred: {result:?}", file.display());
            CODEX_SNAPSHOT_PARSE_COUNT.with(|count| assert_eq!(count.get(), 1));
            CODEX_SNAPSHOT_BYTES_READ.with(|bytes| {
                assert_eq!(bytes.get(), fs::metadata(file).unwrap().len());
            });
        }
        CODEX_SNAPSHOT_PARSE_COUNT.with(|count| count.set(0));
        assert_eq!(sync_test_file(&db, &page1, &files)?.imported, 0);
        assert_eq!(sync_test_file(&db, &page2, &files)?.imported, 0);
        CODEX_SNAPSHOT_PARSE_COUNT.with(|count| assert_eq!(count.get(), 0));
        let conn = lock_conn!(db.conn);
        let (rows, input): (i64, i64) = conn.query_row("SELECT COUNT(*), COALESCE(SUM(input_tokens),0) FROM proxy_request_logs WHERE data_source='codex_session'", [], |row| Ok((row.get(0)?, row.get(1)?)))?;
        assert_eq!(rows, 4);
        assert_eq!(input, 1000 + 500 + 200 + 300);
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn paginated_page_without_history_base_skips_extra_source_scan_on_each_retry(
    ) -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let page = rollout_path(dir.path(), &format!("{CHILD_A_ID}_{CHILD_A_PAGE_1_ID}"));
        write_paginated_jsonl(
            &page,
            &[
                paginated_session_meta_at(CHILD_A_ID, None, None, None, "2026-07-10T03:02:00Z"),
                token_count_with_last_at(
                    100,
                    50,
                    10,
                    100,
                    50,
                    10,
                    "fixture",
                    "2026-07-10T03:02:01Z",
                ),
            ],
        );
        let db = Database::memory()?;
        CODEX_SNAPSHOT_PARSE_COUNT.with(|count| count.set(0));
        for _ in 0..2 {
            let result = sync_test_file(&db, &page, &[&page])?;
            assert!(result.deferred);
            assert_eq!(result.imported, 0);
        }
        CODEX_SNAPSHOT_PARSE_COUNT.with(|count| assert_eq!(count.get(), 1));
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn missing_history_base_page_skips_appended_tail_and_recovers_same_stamp_rewrite(
    ) -> Result<(), AppError> {
        use std::io::Write;

        for padding_bytes in [0, 256 * 1024] {
            let dir = tempdir().unwrap();
            let db = Database::memory()?;
            let page = rollout_path(dir.path(), &format!("{CHILD_A_ID}_{CHILD_A_PAGE_1_ID}"));
            let mut values = vec![
                paginated_session_meta_at(CHILD_A_ID, None, None, None, "2026-07-10T03:02:00Z"),
                token_count_with_last_at(
                    100,
                    50,
                    10,
                    100,
                    50,
                    10,
                    "fixture",
                    "2026-07-10T03:02:01Z",
                ),
                json!({"type":"response_item", "payload":{"text":"x".repeat(padding_bytes)}}),
            ];
            write_paginated_jsonl(&page, &values);
            assert!(sync_test_file(&db, &page, &[&page])?.deferred);
            let initial_reason = replay_caches()
                .lock()
                .unwrap()
                .pending
                .get(&page)
                .map(|entry| entry.reason.clone());
            assert!(
                matches!(
                    initial_reason.as_ref(),
                    Some(PendingReason::MissingContinuationBase(_))
                ),
                "expected missing history-base prefix proof, got {initial_reason:?}"
            );
            CODEX_SNAPSHOT_PARSE_COUNT.with(|count| count.set(0));
            CODEX_SNAPSHOT_BYTES_READ.with(|bytes| bytes.set(0));
            CODEX_SNAPSHOT_VERIFY_BYTES_READ.with(|bytes| bytes.set(0));
            fork_proof::RECHECKED_CHILD_BYTES.with(|bytes| bytes.set(0));
            for ordinal in 3..5 {
                let appended = json!({
                    "ordinal":ordinal, "type":"response_item",
                    "payload":{"text":"tail padding".repeat(2048)}
                });
                fs::OpenOptions::new()
                    .append(true)
                    .open(&page)
                    .unwrap()
                    .write_all(format!("{appended}\n").as_bytes())
                    .unwrap();
                values.push(appended);
                let unchanged = sync_test_file(&db, &page, &[&page])?;
                assert!(unchanged.deferred);
                assert_eq!(unchanged.imported, 0);
            }
            CODEX_SNAPSHOT_PARSE_COUNT.with(|count| assert_eq!(count.get(), 0));
            CODEX_SNAPSHOT_BYTES_READ.with(|bytes| assert_eq!(bytes.get(), 0));
            CODEX_SNAPSHOT_VERIFY_BYTES_READ.with(|bytes| assert_eq!(bytes.get(), 0));
            fork_proof::RECHECKED_CHILD_BYTES
                .with(|bytes| assert!((1..16_384).contains(&bytes.get())));
            assert_eq!(get_sync_state(&db, &page.to_string_lossy())?, (0, 0));

            let metadata = fs::metadata(&page).unwrap();
            values[0]["payload"]["history_mode"] = json!("unpagedxx");
            write_paginated_jsonl(&page, &values);
            assert_eq!(fs::metadata(&page).unwrap().len(), metadata.len());
            fs::OpenOptions::new()
                .write(true)
                .open(&page)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(metadata.modified().unwrap()))
                .unwrap();
            assert_eq!(sync_test_file(&db, &page, &[&page])?.imported, 1);
            CODEX_SNAPSHOT_PARSE_COUNT.with(|count| assert_eq!(count.get(), 1));
            assert!(!replay_caches().lock().unwrap().pending.contains_key(&page));
        }
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn missing_history_base_page_retries_replacement_shrink_and_added_history_link(
    ) -> Result<(), AppError> {
        for correction in ["replacement", "shrink", "history_link"] {
            let dir = tempdir().unwrap();
            let db = Database::memory()?;
            let root = rollout_path(dir.path(), CHILD_A_ID);
            let page = rollout_path(dir.path(), &format!("{CHILD_A_ID}_{CHILD_A_PAGE_1_ID}"));
            write_paginated_jsonl(&root, &[session_meta(CHILD_A_ID), token_count(100, 50, 10)]);
            let mut values = vec![
                paginated_session_meta_at(CHILD_A_ID, None, None, None, "2026-07-10T03:02:00Z"),
                token_count_with_last_at(
                    200,
                    60,
                    20,
                    100,
                    10,
                    10,
                    "fixture",
                    "2026-07-10T03:02:01Z",
                ),
                json!({"type":"response_item", "payload":{"text":"padding".repeat(8192)}}),
            ];
            write_paginated_jsonl(&page, &values);
            assert!(sync_test_file(&db, &page, &[&root, &page])?.deferred);
            let initial_reason = replay_caches()
                .lock()
                .unwrap()
                .pending
                .get(&page)
                .map(|entry| entry.reason.clone());
            assert!(
                matches!(
                    initial_reason.as_ref(),
                    Some(PendingReason::MissingContinuationBase(_))
                ),
                "expected missing history-base prefix proof, got {initial_reason:?}"
            );
            CODEX_SNAPSHOT_PARSE_COUNT.with(|count| count.set(0));
            match correction {
                "replacement" => {
                    let modified = fs::metadata(&page).unwrap().modified().unwrap();
                    let stamp =
                        ParentFileStamp::from_file(&fs::File::open(&page).unwrap()).unwrap();
                    fs::rename(&page, dir.path().join("old-page.jsonl")).unwrap();
                    values[0]["payload"]["history_mode"] = json!("unpagedxx");
                    write_paginated_jsonl(&page, &values);
                    fs::OpenOptions::new()
                        .write(true)
                        .open(&page)
                        .unwrap()
                        .set_times(fs::FileTimes::new().set_modified(modified))
                        .unwrap();
                    assert!(!stamp.same_identity(
                        &ParentFileStamp::from_file(&fs::File::open(&page).unwrap()).unwrap()
                    ));
                }
                "shrink" => {
                    values[0]["payload"]["history_mode"] = json!("unpagedxx");
                    values.pop();
                    write_paginated_jsonl(&page, &values);
                }
                _ => {
                    values[0] = paginated_session_meta_at(
                        CHILD_A_ID,
                        None,
                        Some(CHILD_A_ID),
                        Some(history_base_cutoff(&root, 2)),
                        "2026-07-10T03:02:00Z",
                    );
                    write_paginated_jsonl(&page, &values);
                }
            }
            let recovered = sync_test_file(&db, &page, &[&root, &page])?;
            let recovery_reason = replay_caches()
                .lock()
                .unwrap()
                .pending
                .get(&page)
                .map(|entry| entry.reason.clone());
            assert!(!recovered.deferred, "{correction}: {recovery_reason:?}");
            assert_eq!(recovered.imported, 1);
            CODEX_SNAPSHOT_PARSE_COUNT.with(|count| {
                assert_eq!(
                    count.get(),
                    if correction == "history_link" { 2 } else { 1 }
                );
            });
        }
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn missing_history_base_page_does_not_cache_an_unbounded_prefix() -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let db = Database::memory()?;
        let page = rollout_path(dir.path(), &format!("{CHILD_A_ID}_{CHILD_A_PAGE_1_ID}"));
        write_paginated_jsonl(
            &page,
            &[
                paginated_session_meta_at(CHILD_A_ID, None, None, None, "2026-07-10T03:02:00Z"),
                json!({"type":"response_item", "payload":{"text":"x".repeat(1024 * 1024)}}),
                token_count_with_last_at(
                    100,
                    50,
                    10,
                    100,
                    50,
                    10,
                    "fixture",
                    "2026-07-10T03:02:01Z",
                ),
            ],
        );
        CODEX_SNAPSHOT_PARSE_COUNT.with(|count| count.set(0));
        for _ in 0..2 {
            assert!(sync_test_file(&db, &page, &[&page])?.deferred);
            let pending_reason = replay_caches()
                .lock()
                .unwrap()
                .pending
                .get(&page)
                .map(|entry| entry.reason.clone());
            assert!(
                matches!(
                    pending_reason.as_ref(),
                    Some(PendingReason::Retryable(reason))
                        if reason == "paginated continuation has no explicit history_base"
                ),
                "expected unbounded missing history-base retry, got {pending_reason:?}"
            );
        }
        CODEX_SNAPSHOT_PARSE_COUNT.with(|count| assert_eq!(count.get(), 2));
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn upstream_4_paginated_fork_page_defers_when_explicit_predecessor_is_missing(
    ) -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let page = dir.path().join(format!(
            "rollout-2026-07-10T03-00-00-{CHILD_A_ID}_{CHILD_A_PAGE_2_ID}.jsonl"
        ));
        write_paginated_jsonl(
            &page,
            &[
                paginated_session_meta_at(
                    CHILD_A_ID,
                    Some(PARENT_ID),
                    Some(CHILD_A_PAGE_1_ID),
                    Some((100, 5000)),
                    "2026-07-10T03:02:00Z",
                ),
                token_count_at(2000, 200, 200, "2026-07-10T03:02:01Z"),
            ],
        );
        let db = Database::memory()?;
        let result = sync_test_file(&db, &page, &[&page])?;
        assert!(result.deferred);
        let conn = lock_conn!(db.conn);
        let rows: i64 = conn.query_row(
            "SELECT COUNT(*) FROM proxy_request_logs WHERE data_source='codex_session'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(rows, 0);
        Ok(())
    }

    #[test]
    fn upstream_4_paginated_shared_predecessor_reuses_parse_and_checks_same_stamp_edits() {
        use std::io::Write;

        for padding in [0, 256 * 1024] {
            let dir = tempdir().unwrap();
            let root = rollout_path(dir.path(), CHILD_A_ID);
            let write = |path: &Path, input| {
                write_paginated_jsonl(
                    path,
                    &[
                        session_meta(CHILD_A_ID),
                        token_count_at(input, 20, 10, "2026-07-10T03:00:01Z"),
                        json!({"type": "response_item", "payload": {"text": "x".repeat(padding)}}),
                    ],
                );
            };
            write(&root, 100);
            let before = fs::metadata(&root).unwrap();
            let cutoff = ContinuationLink {
                physical_id: CHILD_A_ID.to_string(),
                end_ordinal_exclusive: 3,
                end_byte_offset: before.len(),
            };
            let mut sources = ContinuationSources::default();
            CODEX_CONTINUATION_SOURCE_BYTES.with(|count| count.set(0));
            CODEX_CONTINUATION_VERIFY_BYTES.with(|count| count.set(0));
            for _ in 0..4 {
                let source = sources.read(&root, &cutoff).unwrap();
                assert_eq!(source.latest_total.unwrap().input, 100);
            }
            let can_verify = !sources.entries.is_empty();
            let has_revision = FileRevision::read(&root).is_some();
            let parses = if can_verify { 1 } else { 4 };
            let verifications = match (can_verify, has_revision) {
                (true, true) => 1,
                (true, false) => 4,
                _ => 0,
            };
            assert_eq!(
                CODEX_CONTINUATION_SOURCE_BYTES.with(std::cell::Cell::get),
                before.len() as usize * parses
            );
            CODEX_CONTINUATION_VERIFY_BYTES
                .with(|bytes| assert_eq!(bytes.get(), before.len() * verifications));
            write(&root, 150);
            fs::OpenOptions::new()
                .write(true)
                .open(&root)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(before.modified().unwrap()))
                .unwrap();
            assert_eq!(fs::metadata(&root).unwrap().len(), before.len());
            let updated = sources.read(&root, &cutoff).unwrap();
            assert_eq!(updated.latest_total.unwrap().input, 150);

            fs::OpenOptions::new()
                .append(true)
                .open(&root)
                .unwrap()
                .write_all(b"{\"ordinal\":3}\n")
                .unwrap();
            CODEX_CONTINUATION_SOURCE_BYTES.with(|count| count.set(0));
            CODEX_CONTINUATION_VERIFY_BYTES.with(|count| count.set(0));
            for _ in 0..3 {
                let source = sources.read(&root, &cutoff).unwrap();
                assert_eq!(source.latest_total.unwrap().input, 150);
            }
            let (parses, verifications) = match (can_verify, has_revision) {
                (true, true) => (0, 1),
                (true, false) => (0, 3),
                _ => (3, 0),
            };
            CODEX_CONTINUATION_SOURCE_BYTES
                .with(|bytes| assert_eq!(bytes.get(), before.len() as usize * parses));
            CODEX_CONTINUATION_VERIFY_BYTES
                .with(|bytes| assert_eq!(bytes.get(), before.len() * verifications));

            let replacement = dir.path().join("replacement.jsonl");
            write(&replacement, 175);
            fs::OpenOptions::new()
                .write(true)
                .open(&replacement)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(before.modified().unwrap()))
                .unwrap();
            fs::remove_file(&root).unwrap();
            fs::rename(replacement, &root).unwrap();
            let replaced = sources.read(&root, &cutoff).unwrap();
            assert_eq!(replaced.latest_total.unwrap().input, 175);
        }
    }

    #[test]
    #[serial_test::serial]
    fn upstream_4_paginated_fork_page_uses_exact_last_usage_without_predecessor(
    ) -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let page = dir.path().join(format!(
            "rollout-2026-07-10T03-00-00-{CHILD_A_ID}_{CHILD_A_PAGE_2_ID}.jsonl"
        ));
        write_paginated_jsonl(
            &page,
            &[
                paginated_session_meta_at(
                    CHILD_A_ID,
                    Some(PARENT_ID),
                    Some(CHILD_A_PAGE_1_ID),
                    Some((100, 5000)),
                    "2026-07-10T03:02:00Z",
                ),
                token_count_with_last_at(2000, 200, 200, 14, 4, 6, "test", "2026-07-10T03:02:01Z"),
            ],
        );
        let db = Database::memory()?;
        let result = sync_test_file(&db, &page, &[&page])?;
        assert_eq!((result.imported, result.deferred), (1, false));
        let conn = lock_conn!(db.conn);
        let input: i64 = conn.query_row(
            "SELECT SUM(input_tokens) FROM proxy_request_logs WHERE data_source='codex_session'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(input, 14);
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn upstream_4_paginated_reset_is_only_inferred_for_first_snapshot() -> Result<(), AppError> {
        for first_has_last in [false, true] {
            let dir = tempdir().unwrap();
            let root = rollout_path(dir.path(), CHILD_A_ID);
            let page = dir.path().join(format!(
                "rollout-2026-07-10T03-00-00-{CHILD_A_ID}_{CHILD_A_PAGE_1_ID}.jsonl"
            ));
            write_paginated_jsonl(
                &root,
                &[
                    session_meta(CHILD_A_ID),
                    token_count_at(1500, 150, 150, "2026-07-10T03:00:20Z"),
                ],
            );
            let mut first = token_count_at(1700, 170, 170, "2026-07-10T03:01:01Z");
            if first_has_last {
                first["payload"]["info"]["last_token_usage"] = serde_json::json!({
                    "input_tokens": 200, "cached_input_tokens": 20, "output_tokens": 20,
                });
            }
            write_paginated_jsonl(
                &page,
                &[
                    paginated_session_meta_at(
                        CHILD_A_ID,
                        None,
                        Some(CHILD_A_ID),
                        Some(history_base_cutoff(&root, 2)),
                        "2026-07-10T03:01:00Z",
                    ),
                    first,
                    token_count_at(100, 10, 10, "2026-07-10T03:01:02Z"),
                ],
            );
            let db = Database::memory()?;
            let files = [root.as_path(), page.as_path()];
            assert_eq!(sync_test_file(&db, &page, &files)?.imported, 1);
            let conn = lock_conn!(db.conn);
            let (rows, input): (i64, i64) = conn.query_row(
                "SELECT COUNT(*), SUM(input_tokens) FROM proxy_request_logs WHERE data_source='codex_session'",
                [], |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!((rows, input), (1, 200), "first_has_last={first_has_last}");
        }
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn upstream_4_paginated_direct_predecessor_with_last_only_cannot_use_older_total(
    ) -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let root = rollout_path(dir.path(), CHILD_A_ID);
        let page1 = dir.path().join(format!(
            "rollout-2026-07-10T03-00-00-{CHILD_A_ID}_{CHILD_A_PAGE_1_ID}.jsonl"
        ));
        let page2 = dir.path().join(format!(
            "rollout-2026-07-10T03-00-00-{CHILD_A_ID}_{CHILD_A_PAGE_2_ID}.jsonl"
        ));
        write_paginated_jsonl(
            &root,
            &[
                session_meta(CHILD_A_ID),
                token_count_at(1500, 150, 150, "2026-07-10T03:00:20Z"),
            ],
        );
        let mut last_only = token_count_at(1600, 160, 160, "2026-07-10T03:01:01Z");
        last_only["payload"]["info"] = serde_json::json!({"last_token_usage": {
            "input_tokens": 100, "cached_input_tokens": 10, "output_tokens": 10,
        }});
        write_paginated_jsonl(
            &page1,
            &[
                paginated_session_meta_at(
                    CHILD_A_ID,
                    None,
                    Some(CHILD_A_ID),
                    Some(history_base_cutoff(&root, 2)),
                    "2026-07-10T03:01:00Z",
                ),
                last_only,
            ],
        );
        write_paginated_jsonl(
            &page2,
            &[
                paginated_session_meta_at(
                    CHILD_A_ID,
                    None,
                    Some(CHILD_A_PAGE_1_ID),
                    Some(history_base_cutoff(&page1, 2)),
                    "2026-07-10T03:02:00Z",
                ),
                token_count_at(1700, 170, 170, "2026-07-10T03:02:01Z"),
            ],
        );
        let db = Database::memory()?;
        let files = [root.as_path(), page1.as_path(), page2.as_path()];
        assert_eq!(sync_test_file(&db, &page1, &files)?.imported, 1);
        assert!(
            sync_test_file(&db, &page2, &files)?.deferred,
            "a stale ancestor total must not substitute for direct predecessor usage"
        );
        let conn = lock_conn!(db.conn);
        let input: i64 = conn.query_row(
            "SELECT SUM(input_tokens) FROM proxy_request_logs WHERE data_source='codex_session'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(input, 100);
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn upstream_4_paginated_last_only_checkpoint_appends_and_rejects_unknown_total_atomically(
    ) -> Result<(), AppError> {
        use std::io::Write;
        let dir = tempdir().unwrap();
        let page = dir.path().join(format!(
            "rollout-2026-07-10T03-00-00-{CHILD_A_ID}_{CHILD_A_PAGE_1_ID}.jsonl"
        ));
        let last_only = |input, timestamp| {
            let mut value = token_count_at(input, input / 10, input / 10, timestamp);
            value["payload"]["info"] = serde_json::json!({"last_token_usage": {
                "input_tokens": input, "cached_input_tokens": input / 10, "output_tokens": input / 10,
            }});
            value
        };
        write_paginated_jsonl(
            &page,
            &[
                paginated_session_meta_at(
                    CHILD_A_ID,
                    None,
                    Some(CHILD_A_ID),
                    Some((2, 5000)),
                    "2026-07-10T03:01:00Z",
                ),
                last_only(100, "2026-07-10T03:01:01Z"),
            ],
        );
        let db = Database::memory()?;
        let files = [page.as_path()];
        assert_eq!(sync_test_file(&db, &page, &files)?.imported, 1);
        let append = |values: &[serde_json::Value]| {
            let contents = values
                .iter()
                .map(serde_json::Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n";
            fs::OpenOptions::new()
                .append(true)
                .open(&page)
                .unwrap()
                .write_all(contents.as_bytes())
                .unwrap();
        };
        append(&[last_only(50, "2026-07-10T03:01:02Z")]);
        clear_codex_replay_caches();
        let second = sync_test_file(&db, &page, &files)?;
        assert_eq!((second.imported, second.deferred), (1, false));
        assert_eq!(sync_test_file(&db, &page, &files)?.imported, 0);
        let before = load_codex_checkpoint(&db, &page)?.unwrap().last_byte_offset;
        append(&[
            last_only(25, "2026-07-10T03:01:03Z"),
            token_count_at(2000, 200, 200, "2026-07-10T03:01:04Z"),
        ]);
        clear_codex_replay_caches();
        assert!(sync_test_file(&db, &page, &files)?.deferred);
        assert_eq!(
            load_codex_checkpoint(&db, &page)?.unwrap().last_byte_offset,
            before
        );
        let conn = lock_conn!(db.conn);
        let (rows, input): (i64, i64) = conn.query_row("SELECT COUNT(*), SUM(input_tokens) FROM proxy_request_logs WHERE data_source='codex_session'", [], |row| Ok((row.get(0)?, row.get(1)?)))?;
        assert_eq!((rows, input), (2, 150));
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn upstream_4_paginated_last_only_consumption_invalidates_inherited_total_baseline(
    ) -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let root = rollout_path(dir.path(), CHILD_A_ID);
        let page = dir.path().join(format!(
            "rollout-2026-07-10T03-00-00-{CHILD_A_ID}_{CHILD_A_PAGE_1_ID}.jsonl"
        ));
        write_paginated_jsonl(
            &root,
            &[
                session_meta(CHILD_A_ID),
                token_count_at(1500, 150, 150, "2026-07-10T03:00:20Z"),
            ],
        );
        let mut last_only = token_count_at(1600, 160, 160, "2026-07-10T03:01:01Z");
        last_only["payload"]["info"] = serde_json::json!({"last_token_usage": {"input_tokens": 100, "cached_input_tokens": 10, "output_tokens": 10}});
        write_paginated_jsonl(
            &page,
            &[
                paginated_session_meta_at(
                    CHILD_A_ID,
                    None,
                    Some(CHILD_A_ID),
                    Some(history_base_cutoff(&root, 2)),
                    "2026-07-10T03:01:00Z",
                ),
                last_only,
                token_count_at(1700, 170, 170, "2026-07-10T03:01:02Z"),
            ],
        );
        let db = Database::memory()?;
        let result = sync_test_file(&db, &page, &[root.as_path(), page.as_path()])?;
        assert!(result.deferred, "exact-only consumption must not leave a stale inherited cumulative baseline authoritative");
        let conn = lock_conn!(db.conn);
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM proxy_request_logs WHERE data_source='codex_session'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(
            count, 0,
            "a deferred snapshot must not partially commit earlier last-only usage"
        );
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn upstream_4_paginated_first_exact_last_reset_realigns_future_total_baseline(
    ) -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let root = rollout_path(dir.path(), CHILD_A_ID);
        let page = dir.path().join(format!(
            "rollout-2026-07-10T03-00-00-{CHILD_A_ID}_{CHILD_A_PAGE_1_ID}.jsonl"
        ));
        write_paginated_jsonl(
            &root,
            &[
                session_meta(CHILD_A_ID),
                token_count_at(1500, 150, 150, "2026-07-10T03:00:20Z"),
            ],
        );
        let mut first = token_count_at(100, 10, 10, "2026-07-10T03:01:01Z");
        first["payload"]["info"]["last_token_usage"] = serde_json::json!({
            "input_tokens": 100, "cached_input_tokens": 10, "output_tokens": 10,
        });
        write_paginated_jsonl(
            &page,
            &[
                paginated_session_meta_at(
                    CHILD_A_ID,
                    None,
                    Some(CHILD_A_ID),
                    Some(history_base_cutoff(&root, 2)),
                    "2026-07-10T03:01:00Z",
                ),
                first,
                token_count_at(200, 20, 20, "2026-07-10T03:01:02Z"),
            ],
        );
        let db = Database::memory()?;
        let files = [root.as_path(), page.as_path()];
        assert_eq!(sync_test_file(&db, &page, &files)?.imported, 2);
        let conn = lock_conn!(db.conn);
        let input: i64 = conn.query_row(
            "SELECT SUM(input_tokens) FROM proxy_request_logs WHERE data_source='codex_session'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(input, 200);
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn upstream_4_paginated_fork_page_counter_reset_counts_current_total() -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let root = rollout_path(dir.path(), CHILD_A_ID);
        let page = dir.path().join(format!(
            "rollout-2026-07-10T03-00-00-{CHILD_A_ID}_{CHILD_A_PAGE_1_ID}.jsonl"
        ));
        write_paginated_jsonl(
            &root,
            &[
                session_meta(CHILD_A_ID),
                token_count_at(1500, 150, 150, "2026-07-10T03:00:20Z"),
            ],
        );
        write_paginated_jsonl(
            &page,
            &[
                paginated_session_meta_at(
                    CHILD_A_ID,
                    Some(PARENT_ID),
                    Some(CHILD_A_ID),
                    Some(history_base_cutoff(&root, 2)),
                    "2026-07-10T03:01:00Z",
                ),
                token_count_at(180, 18, 18, "2026-07-10T03:01:01Z"),
            ],
        );
        let db = Database::memory()?;
        let files = [root.as_path(), page.as_path()];
        assert_eq!(sync_test_file(&db, &root, &files)?.imported, 1);
        assert_eq!(sync_test_file(&db, &page, &files)?.imported, 1);
        let conn = lock_conn!(db.conn);
        let (rows, input): (i64, i64) = conn.query_row("SELECT COUNT(*), SUM(input_tokens) FROM proxy_request_logs WHERE data_source='codex_session'", [], |row| Ok((row.get(0)?, row.get(1)?)))?;
        assert_eq!((rows, input), (2, 1680));
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn upstream_4_paginated_cutoff_uses_prefix_and_componentwise_high_water() -> Result<(), AppError>
    {
        let dir = tempdir().unwrap();
        let root = rollout_path(dir.path(), CHILD_A_ID);
        let page = dir.path().join(format!(
            "rollout-2026-07-10T03-00-00-{CHILD_A_ID}_{CHILD_A_PAGE_1_ID}.jsonl"
        ));
        let root_prefix = [
            session_meta(CHILD_A_ID),
            token_count_at(1000, 100, 100, "2026-07-10T03:00:10Z"),
            // A stale rate-limit lane must not lower the inherited baseline.
            token_count_at(700, 70, 70, "2026-07-10T03:00:11Z"),
        ];
        write_paginated_jsonl(&root, &root_prefix);
        let cutoff = history_base_cutoff(&root, root_prefix.len() as u64);
        write_paginated_jsonl(
            &page,
            &[
                paginated_session_meta_at(
                    CHILD_A_ID,
                    Some(PARENT_ID),
                    Some(CHILD_A_ID),
                    Some(cutoff),
                    "2026-07-10T03:01:00Z",
                ),
                token_count_at(1100, 110, 110, "2026-07-10T03:01:01Z"),
            ],
        );
        let db = Database::memory()?;
        let files = [root.as_path(), page.as_path()];
        assert_eq!(sync_test_file(&db, &root, &files)?.imported, 1);

        // This later predecessor append is beyond the child's frozen cutoff.
        use std::io::Write;
        let appended = token_count_at(2000, 200, 200, "2026-07-10T03:00:12Z").to_string() + "\n";
        fs::OpenOptions::new()
            .append(true)
            .open(&root)
            .unwrap()
            .write_all(appended.as_bytes())
            .unwrap();
        assert_eq!(sync_test_file(&db, &root, &files)?.imported, 1);
        assert_eq!(sync_test_file(&db, &page, &files)?.imported, 1);

        let conn = lock_conn!(db.conn);
        let input: i64 = conn.query_row(
            "SELECT SUM(input_tokens) FROM proxy_request_logs WHERE data_source='codex_session'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(input, 2100);
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn upstream_4_paginated_invalid_cutoff_defers_without_billing() -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let root = rollout_path(dir.path(), CHILD_A_ID);
        let values = [
            session_meta(CHILD_A_ID),
            token_count_at(1000, 100, 100, "2026-07-10T03:00:10Z"),
        ];
        write_paginated_jsonl(&root, &values);
        let page = dir.path().join(format!(
            "rollout-2026-07-10T03-00-00-{CHILD_A_ID}_{CHILD_A_PAGE_1_ID}.jsonl"
        ));
        let valid_offset = fs::metadata(&root).unwrap().len();
        let invalid_cutoffs = [
            (values.len() as u64, valid_offset - 1),
            ((values.len() + 1) as u64, valid_offset),
        ];
        for (end_ordinal_exclusive, end_byte_offset) in invalid_cutoffs {
            write_paginated_jsonl(
                &page,
                &[
                    paginated_session_meta_at(
                        CHILD_A_ID,
                        Some(PARENT_ID),
                        Some(CHILD_A_ID),
                        Some((end_ordinal_exclusive, end_byte_offset)),
                        "2026-07-10T03:01:00Z",
                    ),
                    token_count_at(1200, 120, 120, "2026-07-10T03:01:01Z"),
                ],
            );
            let db = Database::memory()?;
            let result = sync_test_file(&db, &page, &[&root, &page])?;
            assert!(
                result.deferred,
                "accepted cutoff ({end_ordinal_exclusive}, {end_byte_offset})"
            );
            let conn = lock_conn!(db.conn);
            let rows: i64 = conn.query_row(
                "SELECT COUNT(*) FROM proxy_request_logs WHERE data_source='codex_session'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(rows, 0);
        }
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn ordinary_total_only_counter_rollback_keeps_incremental_high_water() -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let file = rollout_path(dir.path(), PARENT_ID);
        write_paginated_jsonl(
            &file,
            &[
                session_meta(PARENT_ID),
                token_count_at(100, 10, 10, "2026-07-10T03:00:01Z"),
                token_count_at(40, 4, 4, "2026-07-10T03:00:02Z"),
            ],
        );
        let db = Database::memory()?;
        let result = sync_test_file(&db, &file, &[&file])?;
        assert_eq!(result.imported, 1);
        let conn = lock_conn!(db.conn);
        let (rows, input): (i64, i64) = conn.query_row(
            "SELECT COUNT(*), SUM(input_tokens) FROM proxy_request_logs WHERE data_source='codex_session'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!((rows, input), (1, 100));
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn upstream_4_paginated_marker_does_not_exempt_single_uuid_fork() -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let parent = rollout_path(dir.path(), PARENT_ID);
        let child = dir
            .path()
            .join(format!("rollout-2026-07-10T03-00-00-{CHILD_B_ID}.jsonl"));
        write_paginated_jsonl(
            &parent,
            &[
                session_meta(PARENT_ID),
                token_count_at(1000, 100, 100, "2026-07-10T03:00:10Z"),
            ],
        );
        write_paginated_jsonl(
            &child,
            &[
                paginated_session_meta_at(
                    CHILD_B_ID,
                    Some(PARENT_ID),
                    Some(PARENT_ID),
                    Some((2, 1)),
                    "2026-07-10T03:01:00Z",
                ),
                token_count_at(1200, 120, 120, "2026-07-10T03:01:01Z"),
            ],
        );
        let db = Database::memory()?;
        let result = sync_test_file(&db, &child, &[&parent, &child])?;
        assert!(result.deferred);
        let conn = lock_conn!(db.conn);
        let rows: i64 = conn.query_row(
            "SELECT COUNT(*) FROM proxy_request_logs WHERE data_source='codex_session'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(rows, 0);
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn upstream_4_paginated_append_restart_uses_checkpoint_high_water() -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let root = rollout_path(dir.path(), CHILD_A_ID);
        let page = dir.path().join(format!(
            "rollout-2026-07-10T03-00-00-{CHILD_A_ID}_{CHILD_A_PAGE_1_ID}.jsonl"
        ));
        write_paginated_jsonl(
            &root,
            &[
                session_meta(CHILD_A_ID),
                token_count_at(1500, 150, 150, "2026-07-10T03:00:20Z"),
            ],
        );
        write_paginated_jsonl(
            &page,
            &[
                paginated_session_meta_at(
                    CHILD_A_ID,
                    Some(PARENT_ID),
                    Some(CHILD_A_ID),
                    Some(history_base_cutoff(&root, 2)),
                    "2026-07-10T03:01:00Z",
                ),
                token_count_at(1700, 170, 170, "2026-07-10T03:01:01Z"),
            ],
        );
        let db = Database::memory()?;
        let files = [root.as_path(), page.as_path()];
        assert_eq!(sync_test_file(&db, &root, &files)?.imported, 1);
        assert_eq!(sync_test_file(&db, &page, &files)?.imported, 1);
        use std::io::Write;
        let appended = token_count_at(1800, 180, 180, "2026-07-10T03:01:02Z").to_string() + "\n";
        fs::OpenOptions::new()
            .append(true)
            .open(&page)
            .unwrap()
            .write_all(appended.as_bytes())
            .unwrap();
        assert_eq!(sync_test_file(&db, &page, &files)?.imported, 1);
        assert_eq!(sync_test_file(&db, &page, &files)?.imported, 0);
        let conn = lock_conn!(db.conn);
        let (rows, input): (i64, i64) = conn.query_row("SELECT COUNT(*), SUM(input_tokens) FROM proxy_request_logs WHERE data_source='codex_session'", [], |row| Ok((row.get(0)?, row.get(1)?)))?;
        assert_eq!((rows, input), (3, 1800));
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn upstream_4_paginated_old_billed_checkpoint_defers_without_replaying() -> Result<(), AppError>
    {
        let dir = tempdir().unwrap();
        let root = rollout_path(dir.path(), CHILD_A_ID);
        let page = dir.path().join(format!(
            "rollout-2026-07-10T03-00-00-{CHILD_A_ID}_{CHILD_A_PAGE_1_ID}.jsonl"
        ));
        write_paginated_jsonl(
            &root,
            &[
                session_meta(CHILD_A_ID),
                token_count_at(1500, 150, 150, "2026-07-10T03:00:20Z"),
            ],
        );
        write_paginated_jsonl(
            &page,
            &[
                paginated_session_meta_at(
                    CHILD_A_ID,
                    Some(PARENT_ID),
                    Some(CHILD_A_ID),
                    Some(history_base_cutoff(&root, 2)),
                    "2026-07-10T03:01:00Z",
                ),
                token_count_at(1700, 170, 170, "2026-07-10T03:01:01Z"),
            ],
        );
        let db = Database::memory()?;
        let files = [root.as_path(), page.as_path()];
        sync_test_file(&db, &root, &files)?;
        sync_test_file(&db, &page, &files)?;
        let mut checkpoint = load_codex_checkpoint(&db, &page)?.unwrap();
        checkpoint.state.parent = ParentResolution::Parent(PARENT_ID.to_string());
        let checkpoint_json = serde_json::to_string(&checkpoint.state).unwrap();
        lock_conn!(db.conn).execute(
            "UPDATE codex_usage_file_checkpoints SET parser_state=?1 WHERE file_path=?2",
            rusqlite::params![checkpoint_json, page.to_string_lossy().to_string()],
        )?;
        let alias_dir = dir.path().join("alias");
        fs::create_dir(&alias_dir).unwrap();
        let alias_page = alias_dir.join(page.file_name().unwrap());
        fs::rename(&page, &alias_page).unwrap();
        use std::io::Write;
        let appended = token_count_at(1800, 180, 180, "2026-07-10T03:01:02Z").to_string() + "\n";
        fs::OpenOptions::new()
            .append(true)
            .open(&alias_page)
            .unwrap()
            .write_all(appended.as_bytes())
            .unwrap();
        let files = [root.as_path(), alias_page.as_path()];
        let result = sync_test_file(&db, &alias_page, &files)?;
        assert!(result.deferred);
        let conn = lock_conn!(db.conn);
        let (rows, input): (i64, i64) = conn.query_row("SELECT COUNT(*), SUM(input_tokens) FROM proxy_request_logs WHERE data_source='codex_session'", [], |row| Ok((row.get(0)?, row.get(1)?)))?;
        assert_eq!((rows, input), (2, 1700));
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn upstream_4_paginated_empty_checkpoint_reinitializes_when_predecessor_arrives(
    ) -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let root = rollout_path(dir.path(), CHILD_A_ID);
        let page = dir.path().join(format!(
            "rollout-2026-07-10T03-00-00-{CHILD_A_ID}_{CHILD_A_PAGE_1_ID}.jsonl"
        ));
        let root_values = [
            session_meta(CHILD_A_ID),
            token_count_at(1500, 150, 150, "2026-07-10T03:00:20Z"),
        ];
        let root_cutoff = (2, jsonl_contents(&root_values).len() as u64);
        write_paginated_jsonl(
            &page,
            &[paginated_session_meta_at(
                CHILD_A_ID,
                Some(PARENT_ID),
                Some(CHILD_A_ID),
                Some(root_cutoff),
                "2026-07-10T03:01:00Z",
            )],
        );
        let db = Database::memory()?;
        assert!(!sync_test_file(&db, &page, &[&page])?.deferred);
        CODEX_SNAPSHOT_PARSE_COUNT.with(|count| count.set(0));
        let unchanged = sync_test_file(&db, &page, &[&page])?;
        assert!(!unchanged.deferred);
        CODEX_SNAPSHOT_PARSE_COUNT.with(|count| assert_eq!(count.get(), 0));
        write_paginated_jsonl(&root, &root_values);
        use std::io::Write;
        let appended = token_count_at(1700, 170, 170, "2026-07-10T03:01:01Z").to_string() + "\n";
        fs::OpenOptions::new()
            .append(true)
            .open(&page)
            .unwrap()
            .write_all(appended.as_bytes())
            .unwrap();
        let files = [root.as_path(), page.as_path()];
        assert_eq!(sync_test_file(&db, &page, &files)?.imported, 1);
        let conn = lock_conn!(db.conn);
        let (rows, input): (i64, i64) = conn.query_row("SELECT COUNT(*), SUM(input_tokens) FROM proxy_request_logs WHERE data_source='codex_session'", [], |row| Ok((row.get(0)?, row.get(1)?)))?;
        assert_eq!((rows, input), (1, 200));
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn incremental_sync_hashes_committed_prefix_once_on_append() -> Result<(), AppError> {
        use std::io::Write;

        for padding in [0, 64 * 1024] {
            let dir = tempdir().unwrap();
            let file = rollout_path(dir.path(), PARENT_ID);
            write_jsonl(
                &file,
                &[
                    session_meta(PARENT_ID),
                    turn_context(),
                    json!({"type": "fixture", "payload": "x".repeat(padding)}),
                    token_count_at(10, 2, 3, "2026-09-14T00:00:01Z"),
                ],
            );
            let size = fs::metadata(&file).unwrap().len();
            let db = Database::memory()?;
            assert_eq!(sync_test_file(&db, &file, &[&file])?.imported, 1);
            assert_eq!(take_codex_append_bytes_read(&file), 0);

            let appended = token_count_at(20, 4, 7, "2026-09-14T00:00:02Z").to_string() + "\n";
            fs::OpenOptions::new()
                .append(true)
                .open(&file)
                .unwrap()
                .write_all(appended.as_bytes())
                .unwrap();
            clear_codex_replay_caches();
            CODEX_CHECKPOINT_PREFIX_BYTES_READ.with(|bytes| bytes.set(0));
            CODEX_SNAPSHOT_PARSE_COUNT.with(|count| count.set(0));
            assert_eq!(sync_test_file(&db, &file, &[&file])?.imported, 1);
            assert_eq!(take_codex_append_bytes_read(&file), appended.len() as u64);
            let current_size = size + appended.len() as u64;
            let has_revision = FileRevision::read(&file).is_some();
            let fallback_verify_bytes = if has_revision { 0 } else { current_size };
            CODEX_CHECKPOINT_PREFIX_BYTES_READ
                .with(|bytes| assert_eq!(bytes.get(), size + fallback_verify_bytes));
            CODEX_CHECKPOINT_PREFIX_BYTES_READ.with(|bytes| bytes.set(0));
            for _ in 0..3 {
                let unchanged = sync_test_file(&db, &file, &[&file])?;
                assert_eq!((unchanged.imported, unchanged.deferred), (0, false));
            }
            CODEX_SNAPSHOT_PARSE_COUNT.with(|count| assert_eq!(count.get(), 0));
            CODEX_CHECKPOINT_PREFIX_BYTES_READ.with(|bytes| {
                assert_eq!(bytes.get(), 6 * fallback_verify_bytes);
            });
            let conn = lock_conn!(db.conn);
            let rows: i64 = conn.query_row(
                "SELECT COUNT(*) FROM proxy_request_logs WHERE data_source='codex_session'",
                [],
                |row| row.get(0),
            )?;
            let checkpoint: (i64, i64) = conn.query_row("SELECT last_byte_offset, file_size FROM codex_usage_file_checkpoints WHERE file_path=?1", [file.to_string_lossy().to_string()], |row| Ok((row.get(0)?, row.get(1)?)))?;
            assert_eq!(rows, 2);
            assert_eq!(checkpoint.0, checkpoint.1);
        }
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn initial_sync_retries_in_place_middle_rewrite_with_restored_mtime() -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let path = rollout_path(dir.path(), PARENT_ID);
        let padding = serde_json::json!({ "type": "fixture", "payload": "x".repeat(CODEX_FINGERPRINT_BYTES) });
        let mut records = [
            session_meta(PARENT_ID),
            turn_context(),
            padding.clone(),
            token_count_at(10, 2, 3, "2026-09-14T00:00:01Z"),
            padding,
        ];
        write_jsonl(&path, &records);
        records[3] = token_count_at(20, 2, 3, "2026-09-14T00:00:01Z");
        let before = fs::read(&path).unwrap();
        let stamp = ParentFileStamp::from_file(&fs::File::open(&path).unwrap()).unwrap();
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        let rewrite_path = path.clone();
        BEFORE_CODEX_SNAPSHOT_REUSE.with(|hook| {
            hook.replace(Some(Box::new(move || {
                write_jsonl(&rewrite_path, &records);
                let writer = fs::OpenOptions::new()
                    .write(true)
                    .open(&rewrite_path)
                    .unwrap();
                writer
                    .set_times(fs::FileTimes::new().set_modified(modified))
                    .unwrap();
                drop(writer);
                let after = fs::read(&rewrite_path).unwrap();
                assert_eq!(
                    ParentFileStamp::from_file(&fs::File::open(&rewrite_path).unwrap()),
                    Some(stamp)
                );
                assert_ne!(before, after);
                assert_eq!(
                    before[..CODEX_FINGERPRINT_BYTES],
                    after[..CODEX_FINGERPRINT_BYTES]
                );
                assert_eq!(
                    before[before.len() - CODEX_FINGERPRINT_BYTES..],
                    after[after.len() - CODEX_FINGERPRINT_BYTES..]
                );
            })));
        });

        let db = Database::memory()?;
        let result = sync_test_file(&db, &path, &[&path]);
        assert!(
            matches!(result, Err(AppError::Config(_))),
            "the reused parse must reject a changed rollout"
        );
        assert_eq!(get_sync_state(&db, &path.to_string_lossy())?, (0, 0));
        assert_eq!(sync_test_file(&db, &path, &[&path])?.imported, 1);
        let conn = lock_conn!(db.conn);
        let input: i64 = conn.query_row(
            "SELECT input_tokens FROM proxy_request_logs WHERE data_source = 'codex_session'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(input, 20);
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn incremental_sync_rejects_middle_rewrites_without_reparsing_committed_prefix(
    ) -> Result<(), AppError> {
        for (replace, append) in [(false, false), (true, false), (false, true)] {
            let dir = tempdir().unwrap();
            let file = rollout_path(dir.path(), PARENT_ID);
            let padding =
                json!({"type": "fixture", "payload": "x".repeat(2 * CODEX_FINGERPRINT_BYTES)});
            write_jsonl(
                &file,
                &[
                    session_meta(PARENT_ID),
                    turn_context(),
                    padding.clone(),
                    token_count_at(10, 2, 3, "2026-09-14T00:00:01Z"),
                    padding,
                ],
            );
            let db = Database::memory()?;
            assert_eq!(sync_test_file(&db, &file, &[&file])?.imported, 1);
            let metadata = fs::metadata(&file).unwrap();
            let before = fs::read(&file).unwrap();
            let mut rewritten = before.clone();
            let index = rewritten.len() / 2;
            assert!(
                (CODEX_FINGERPRINT_BYTES..rewritten.len() - CODEX_FINGERPRINT_BYTES)
                    .contains(&index)
            );
            rewritten[index] ^= 1;
            if append {
                let appended = token_count_at(20, 4, 7, "2026-09-14T00:00:02Z").to_string() + "\n";
                rewritten.extend(appended.as_bytes());
            }
            let replacement = dir.path().join("replacement.jsonl");
            let path = if replace { &replacement } else { &file };
            fs::write(path, rewritten).unwrap();
            fs::OpenOptions::new()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(metadata.modified().unwrap()))
                .unwrap();
            if replace {
                fs::remove_file(&file).unwrap();
                fs::rename(path, &file).unwrap();
            }
            clear_codex_replay_caches();
            CODEX_CHECKPOINT_PREFIX_BYTES_READ.with(|bytes| bytes.set(0));
            CODEX_SNAPSHOT_PARSE_COUNT.with(|count| count.set(0));
            let result = sync_test_file(&db, &file, &[&file])?;
            assert!(result.deferred);
            CODEX_CHECKPOINT_PREFIX_BYTES_READ
                .with(|bytes| assert_eq!(bytes.get(), metadata.len()));
            CODEX_SNAPSHOT_PARSE_COUNT.with(|count| assert_eq!(count.get(), 0));
            assert_eq!(take_codex_append_bytes_read(&file), 0);
            if FileRevision::read(&file).is_some() {
                CODEX_CHECKPOINT_PREFIX_BYTES_READ.with(|bytes| bytes.set(0));
                for _ in 0..3 {
                    assert!(sync_test_file(&db, &file, &[&file])?.deferred);
                }
                CODEX_CHECKPOINT_PREFIX_BYTES_READ.with(|bytes| assert_eq!(bytes.get(), 0));
            }
            assert_eq!(
                load_codex_checkpoint(&db, &file)?.unwrap().last_byte_offset,
                metadata.len() as i64
            );
            let conn = lock_conn!(db.conn);
            let rows: i64 = conn.query_row(
                "SELECT COUNT(*) FROM proxy_request_logs WHERE data_source='codex_session'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(rows, 1);
        }
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn incremental_sync_accepts_same_size_completion_of_uncommitted_tail() -> Result<(), AppError> {
        use std::io::Write;

        let dir = tempdir().unwrap();
        let file = rollout_path(dir.path(), PARENT_ID);
        write_jsonl(
            &file,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                token_count(10, 2, 3),
            ],
        );
        let partial = token_count_at(20, 4, 7, "2026-09-14T00:00:02Z").to_string() + " ";
        fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap()
            .write_all(partial.as_bytes())
            .unwrap();
        let db = Database::memory()?;
        assert_eq!(sync_test_file(&db, &file, &[&file])?.imported, 1);
        let before = fs::metadata(&file).unwrap();
        let mut writer = fs::OpenOptions::new().write(true).open(&file).unwrap();
        writer.seek(SeekFrom::End(-1)).unwrap();
        writer.write_all(b"\n").unwrap();
        writer
            .set_times(fs::FileTimes::new().set_modified(before.modified().unwrap()))
            .unwrap();
        drop(writer);
        assert_eq!(fs::metadata(&file).unwrap().len(), before.len());
        assert_eq!(sync_test_file(&db, &file, &[&file])?.imported, 1);
        assert_eq!(sync_test_file(&db, &file, &[&file])?.imported, 0);
        assert_eq!(
            load_codex_checkpoint(&db, &file)?.unwrap().last_byte_offset,
            before.len() as i64
        );
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn incremental_sync_retries_split_utf8_line_before_advancing_checkpoint() -> Result<(), AppError>
    {
        let dir = tempdir().unwrap();
        let file = rollout_path(dir.path(), PARENT_ID);
        write_jsonl(
            &file,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                token_count_at(10, 2, 3, "2026-09-14T00:00:01Z"),
            ],
        );
        let db = Database::memory()?;
        assert_eq!(sync_test_file(&db, &file, &[&file])?.imported, 1);
        let partial_line =
            "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-😀\"}}\n".as_bytes();
        let split = partial_line
            .windows(4)
            .position(|bytes| bytes == [0xF0, 0x9F, 0x98, 0x80])
            .expect("emoji bytes")
            + 1;
        use std::io::Write;
        fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap()
            .write_all(&partial_line[..split])
            .unwrap();
        assert_eq!(sync_test_file(&db, &file, &[&file])?.imported, 0);
        let conn = lock_conn!(db.conn);
        let offset_before: i64 = conn.query_row(
            "SELECT last_byte_offset FROM codex_usage_file_checkpoints WHERE file_path=?1",
            [file.to_string_lossy().to_string()],
            |row| row.get(0),
        )?;
        drop(conn);
        fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap()
            .write_all(&partial_line[split..])
            .unwrap();
        let appended = token_count_at(20, 4, 7, "2026-09-14T00:00:02Z").to_string() + "\n";
        fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap()
            .write_all(appended.as_bytes())
            .unwrap();
        assert_eq!(sync_test_file(&db, &file, &[&file])?.imported, 1);
        let conn = lock_conn!(db.conn);
        let offset_after: i64 = conn.query_row(
            "SELECT last_byte_offset FROM codex_usage_file_checkpoints WHERE file_path=?1",
            [file.to_string_lossy().to_string()],
            |row| row.get(0),
        )?;
        assert!(offset_after > offset_before);
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn legacy_codex_checkpoint_replay_rejects_a_changed_verified_prefix() -> Result<(), AppError> {
        use std::io::Write;

        let dir = tempdir().unwrap();
        let parent = rollout_path(dir.path(), PARENT_ID);
        let child = rollout_path(dir.path(), CHILD_A_ID);
        write_jsonl(
            &parent,
            &[
                session_meta(PARENT_ID),
                token_count_at(100, 50, 10, "2026-07-10T03:00:01Z"),
                turn_context_at("2026-07-10T03:00:10Z"),
            ],
        );
        let padding =
            json!({"type": "fixture", "payload": "x".repeat(2 * CODEX_FINGERPRINT_BYTES)});
        write_jsonl(
            &child,
            &[
                session_meta_at(CHILD_A_ID, Some(PARENT_ID), None, "2026-07-10T03:00:05Z"),
                padding.clone(),
                token_count_at(100, 50, 10, "2026-07-10T03:00:06Z"),
                token_count_at(200, 100, 20, "2026-07-10T03:00:07Z"),
                padding,
            ],
        );
        let db = Database::memory()?;
        let files = [parent.as_path(), child.as_path()];
        assert_eq!(sync_test_file(&db, &child, &files)?.imported, 1);
        let mut checkpoint = load_codex_checkpoint(&db, &child)?.unwrap();
        assert!(matches!(
            checkpoint.state.parent,
            ParentResolution::Parent(_)
        ));
        checkpoint.state.replay_verification = None;
        checkpoint.state.checkpoint_proof = None;
        lock_conn!(db.conn).execute(
            "UPDATE codex_usage_file_checkpoints SET parser_state=?1 WHERE file_path=?2",
            rusqlite::params![
                serde_json::to_string(&checkpoint.state).unwrap(),
                child.to_str().unwrap()
            ],
        )?;

        let original = fs::read(&child).unwrap();
        let offset = original.len() / 2;
        assert!(
            (CODEX_FINGERPRINT_BYTES..original.len() - CODEX_FINGERPRINT_BYTES).contains(&offset)
        );
        let changed_byte = original[offset] ^ 1;
        let mtime = fs::metadata(&child).unwrap().modified().unwrap();
        CODEX_SNAPSHOT_TEST_HOOK.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move |path| {
                let mut opened = fs::OpenOptions::new().write(true).open(path).unwrap();
                opened.seek(SeekFrom::Start(offset as u64)).unwrap();
                opened.write_all(&[changed_byte]).unwrap();
                opened
                    .set_times(fs::FileTimes::new().set_modified(mtime))
                    .unwrap();
            }));
        });
        let error = sync_test_file(&db, &child, &files).unwrap_err();
        assert!(error
            .to_string()
            .contains("checkpoint prefix 在重放期间变化"));
        assert!(load_codex_checkpoint(&db, &child)?
            .unwrap()
            .state
            .checkpoint_proof
            .is_none());

        fs::write(&child, original).unwrap();
        assert_eq!(sync_test_file(&db, &child, &files)?.imported, 0);
        assert!(load_codex_checkpoint(&db, &child)?
            .unwrap()
            .state
            .checkpoint_proof
            .is_some());
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn incremental_sync_append_failure_rolls_back_all_usage_and_prefix_proof(
    ) -> Result<(), AppError> {
        use std::io::Write;

        let dir = tempdir().unwrap();
        let file = rollout_path(dir.path(), PARENT_ID);
        write_jsonl(
            &file,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                token_count(10, 2, 3),
            ],
        );
        let db = Database::memory()?;
        assert_eq!(sync_test_file(&db, &file, &[&file])?.imported, 1);
        let original_checkpoint = load_codex_checkpoint(&db, &file)?.unwrap();
        {
            let mut writer = fs::OpenOptions::new().append(true).open(&file).unwrap();
            for index in 0..=CODEX_INSERT_BATCH_SIZE {
                writeln!(
                    writer,
                    "{}",
                    token_count_at(20 + index as u64, 4, 7, "2026-09-14T00:00:02Z")
                )
                .unwrap();
            }
        }
        {
            let conn = lock_conn!(db.conn);
            let final_request_id = format!(
                "{CODEX_THREAD_REQUEST_ID_PREFIX}:{PARENT_ID}:{}",
                CODEX_INSERT_BATCH_SIZE + 2
            );
            conn.execute_batch(&format!(
                "CREATE TRIGGER fail_final_codex_append BEFORE INSERT ON proxy_request_logs
                 WHEN NEW.request_id = '{final_request_id}'
                 BEGIN SELECT RAISE(ABORT, 'fixture append failure'); END;"
            ))?;
        }
        let error = sync_test_file(&db, &file, &[&file]).unwrap_err();
        assert!(error.to_string().contains("fixture append failure"));
        let current = load_codex_checkpoint(&db, &file)?.unwrap();
        assert_eq!(
            current.last_byte_offset,
            original_checkpoint.last_byte_offset
        );
        assert_eq!(
            current.state.checkpoint_proof.unwrap().prefix_digest,
            original_checkpoint
                .state
                .checkpoint_proof
                .unwrap()
                .prefix_digest
        );
        {
            let conn = lock_conn!(db.conn);
            let rows: i64 = conn.query_row(
                "SELECT COUNT(*) FROM proxy_request_logs WHERE data_source='codex_session'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(rows, 1);
            conn.execute_batch("DROP TRIGGER fail_final_codex_append")?;
        }
        assert_eq!(
            sync_test_file(&db, &file, &[&file])?.imported as usize,
            CODEX_INSERT_BATCH_SIZE + 1
        );
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn incremental_sync_insert_failure_rolls_back_usage_metadata_and_checkpoint(
    ) -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let file = rollout_path(dir.path(), PARENT_ID);
        write_jsonl(
            &file,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                token_count_at(10, 2, 3, "2026-09-14T00:00:01Z"),
            ],
        );
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            conn.execute_batch(
                "CREATE TRIGGER fail_codex_usage_insert
                   BEFORE INSERT ON proxy_request_logs
                   WHEN NEW.data_source = 'codex_session'
                   BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END;",
            )?;
        }
        assert!(sync_test_file(&db, &file, &[&file]).is_err());
        let conn = lock_conn!(db.conn);
        let counts: (i64, i64, i64, i64) = conn.query_row(
            "SELECT
               (SELECT COUNT(*) FROM proxy_request_logs WHERE data_source='codex_session'),
               (SELECT COUNT(*) FROM codex_usage_file_checkpoints),
               (SELECT COUNT(*) FROM codex_usage_sessions),
               (SELECT COUNT(*) FROM session_log_sync WHERE file_path=?1)",
            [file.to_string_lossy().to_string()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(counts, (0, 0, 0, 0));
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn unchanged_resumed_and_single_uuid_rollouts_skip_full_parse() -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let db = Database::memory()?;
        let resumed = dir.path().join(format!(
            "rollout-2026-07-10T03-00-00-{PARENT_ID}_{CHILD_A_ID}.jsonl"
        ));
        let single = rollout_path(dir.path(), PARENT_ID);
        let files = [resumed.as_path(), single.as_path()];
        for (file, meta, root_records) in [
            (&resumed, session_meta(PARENT_ID), 1),
            (
                &single,
                serde_json::json!({"type":"session_meta","payload":{}}),
                0,
            ),
        ] {
            write_jsonl(file, &[meta, turn_context(), token_count(100, 50, 10)]);
            assert_eq!(sync_test_file(&db, file, &files)?.imported, 1);
            CODEX_SNAPSHOT_PARSE_COUNT.with(|count| count.set(0));
            CODEX_CHECKPOINT_ROOT_RECORDS.with(|count| count.set(0));
            for _ in 0..2 {
                let result = sync_test_file(&db, file, &files)?;
                assert!(!result.deferred);
                assert_eq!(result.imported, 0);
            }
            CODEX_SNAPSHOT_PARSE_COUNT.with(|count| assert_eq!(count.get(), 0));
            CODEX_CHECKPOINT_ROOT_RECORDS.with(|count| assert_eq!(count.get(), 2 * root_records));
        }
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn cold_and_unchanged_rollout_work_is_bounded_by_required_bytes() -> Result<(), AppError> {
        assert_codex_lookup_work_is_bounded()?;
        for padding_records in [0, 2048] {
            for kind in ["ordinary", "resumed", "empty_page"] {
                let dir = tempdir().unwrap();
                let db = Database::memory()?;
                let (file, meta) = match kind {
                    "ordinary" => (rollout_path(dir.path(), PARENT_ID), session_meta(PARENT_ID)),
                    "resumed" => (
                        rollout_path(dir.path(), &format!("{PARENT_ID}_{CHILD_A_ID}")),
                        session_meta(PARENT_ID),
                    ),
                    _ => (
                        rollout_path(dir.path(), &format!("{CHILD_A_ID}_{CHILD_A_PAGE_1_ID}")),
                        paginated_session_meta_at(
                            CHILD_A_ID,
                            None,
                            None,
                            None,
                            "2026-07-10T03:02:00Z",
                        ),
                    ),
                };
                let root_bytes = meta.to_string().len() as u64 + 1;
                let mut values = vec![meta];
                if kind != "empty_page" {
                    values.extend([turn_context(), token_count(100, 50, 10)]);
                }
                values.extend(std::iter::repeat_n(
                    json!({"type":"response_item", "payload":{"text":"fixture padding".repeat(64)}}),
                    padding_records,
                ));
                write_jsonl(&file, &values);
                let size = fs::metadata(&file).unwrap().len();
                CODEX_SNAPSHOT_PARSE_COUNT.with(|count| count.set(0));
                CODEX_SNAPSHOT_BYTES_READ.with(|bytes| bytes.set(0));
                CODEX_SNAPSHOT_VERIFY_BYTES_READ.with(|bytes| bytes.set(0));

                let initial = sync_test_file(&db, &file, &[&file])?;
                assert!(
                    !initial.deferred,
                    "{kind} with {padding_records} padding records"
                );
                assert_eq!(initial.imported, u32::from(kind != "empty_page"));
                CODEX_SNAPSHOT_PARSE_COUNT.with(|count| assert_eq!(count.get(), 1));
                CODEX_SNAPSHOT_BYTES_READ.with(|bytes| assert_eq!(bytes.get(), size));
                CODEX_SNAPSHOT_VERIFY_BYTES_READ.with(|bytes| assert_eq!(bytes.get(), size));

                CODEX_SNAPSHOT_PARSE_COUNT.with(|count| count.set(0));
                CODEX_SNAPSHOT_BYTES_READ.with(|bytes| bytes.set(0));
                CODEX_SNAPSHOT_VERIFY_BYTES_READ.with(|bytes| bytes.set(0));
                CODEX_CHECKPOINT_ROOT_RECORDS.with(|count| count.set(0));
                CODEX_CHECKPOINT_ROOT_BYTES_READ.with(|bytes| bytes.set(0));
                for _ in 0..2 {
                    let unchanged = sync_test_file(&db, &file, &[&file])?;
                    assert!(!unchanged.deferred);
                    assert_eq!(unchanged.imported, 0);
                }
                CODEX_SNAPSHOT_PARSE_COUNT.with(|count| assert_eq!(count.get(), 0));
                CODEX_SNAPSHOT_BYTES_READ.with(|bytes| assert_eq!(bytes.get(), 0));
                CODEX_SNAPSHOT_VERIFY_BYTES_READ.with(|bytes| assert_eq!(bytes.get(), 0));
                let root_probes = usize::from(kind != "ordinary") * 2;
                CODEX_CHECKPOINT_ROOT_RECORDS.with(|count| assert_eq!(count.get(), root_probes));
                CODEX_CHECKPOINT_ROOT_BYTES_READ.with(|bytes| {
                    assert_eq!(bytes.get(), root_probes as u64 * root_bytes);
                });
            }
        }
        Ok(())
    }

    #[test]
    fn upstream_protocol_resumed_rollout_accepts_leading_logical_thread_id() -> Result<(), AppError>
    {
        let dir = tempdir().unwrap();
        let file = dir.path().join(format!(
            "rollout-2026-08-26T17-18-13-{PARENT_ID}_{CHILD_A_ID}.jsonl"
        ));
        write_jsonl(
            &file,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                token_count_at(100, 50, 20, "2026-08-26T09:18:20Z"),
            ],
        );

        let parsed = parse_codex_file(&file, thread_id_from_filename(&file))?;
        assert!(
            !matches!(parsed.parent, ParentResolution::Deferred(_)),
            "a resumed rollout is not a cross-thread filename mismatch: {:?}",
            parsed.parent
        );
        assert_eq!(parsed.root_thread_id.as_deref(), Some(CHILD_A_ID));
        assert!(parsed.has_billable_tokens);
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn upstream_protocol_resumed_rollout_uses_physical_id_for_dedup_and_meta_id_for_session(
    ) -> Result<(), AppError> {
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let file = temp.path().join(format!(
            "rollout-2026-08-26T17-18-13-{PARENT_ID}_{CHILD_A_ID}.jsonl"
        ));
        write_jsonl(
            &file,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                token_count(100, 50, 10),
            ],
        );

        assert_eq!(sync_test_file(&db, &file, &[&file])?.imported, 1);
        let conn = lock_conn!(db.conn);
        let (request_id, session_id) = conn
            .prepare(
                "SELECT request_id, session_id FROM proxy_request_logs WHERE data_source = 'codex_session'",
            )?
            .query_row([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
        assert_eq!(
            request_id,
            format!("{CODEX_THREAD_REQUEST_ID_PREFIX}:{CHILD_A_ID}:1")
        );
        assert_eq!(session_id, PARENT_ID);
        Ok(())
    }

    #[test]
    fn upstream_protocol_single_uuid_filename_meta_mismatch_remains_deferred(
    ) -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let file = rollout_path(dir.path(), PARENT_ID);
        write_jsonl(
            &file,
            &[
                session_meta(CHILD_A_ID),
                turn_context(),
                token_count_at(1, 1, 1, "2026-07-10T03:00:02Z"),
            ],
        );
        let parsed = parse_codex_file(&file, thread_id_from_filename(&file))?;
        assert!(matches!(parsed.parent, ParentResolution::Deferred(_)));
        Ok(())
    }

    #[test]
    fn test_delta_first_event() {
        let prev = None;
        let current = CumulativeTokens {
            input: 17934,
            cached_input: 9600,
            output: 454,
        };
        let delta = compute_delta(&prev, &current);
        assert_eq!(delta.input, 17934);
        assert_eq!(delta.cached_input, 9600);
        assert_eq!(delta.output, 454);
        assert!(!delta.is_zero());
    }

    #[test]
    fn test_delta_subsequent_event() {
        let prev = Some(CumulativeTokens {
            input: 17934,
            cached_input: 9600,
            output: 454,
        });
        let current = CumulativeTokens {
            input: 36722,
            cached_input: 27904,
            output: 804,
        };
        let delta = compute_delta(&prev, &current);
        assert_eq!(delta.input, 36722 - 17934);
        assert_eq!(delta.cached_input, 27904 - 9600);
        assert_eq!(delta.output, 804 - 454);
    }

    #[test]
    fn test_delta_zero_at_task_boundary() {
        let prev = Some(CumulativeTokens {
            input: 58346,
            cached_input: 46976,
            output: 1045,
        });
        // task 边界：相同的累计值
        let current = CumulativeTokens {
            input: 58346,
            cached_input: 46976,
            output: 1045,
        };
        let delta = compute_delta(&prev, &current);
        assert!(delta.is_zero());
    }

    #[test]
    fn test_delta_saturating_sub() {
        // 异常情况：当前值小于前值（不应发生，但需防护）
        let prev = Some(CumulativeTokens {
            input: 100,
            cached_input: 50,
            output: 30,
        });
        let current = CumulativeTokens {
            input: 80,
            cached_input: 40,
            output: 20,
        };
        let delta = compute_delta(&prev, &current);
        assert_eq!(delta.input, 0);
        assert_eq!(delta.cached_input, 0);
        assert_eq!(delta.output, 0);
        assert!(delta.is_zero());
    }

    #[test]
    fn test_interleaved_counter_lanes_use_exact_last_usage() -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let file = rollout_path(dir.path(), PARENT_ID);
        let bengal_event = token_count_with_last_at(
            87_709_262,
            83_563_008,
            240_919,
            151_258,
            147_200,
            87,
            "codex_bengalfox",
            "2026-07-10T03:00:03Z",
        );
        write_jsonl(
            &file,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                token_count_with_last_at(
                    76_780_408,
                    73_010_432,
                    243_036,
                    175_074,
                    169_728,
                    6_827,
                    "codex",
                    "2026-07-10T03:00:02Z",
                ),
                bengal_event.clone(),
                token_count_with_last_at(
                    76_962_538,
                    73_180_160,
                    243_258,
                    182_130,
                    169_728,
                    222,
                    "codex",
                    "2026-07-10T03:00:04Z",
                ),
                // Repeated snapshots are notifications, not additional API usage.
                bengal_event,
            ],
        );

        let parsed = parse_codex_file(&file, Some(PARENT_ID.to_string()))?;
        let deltas = parsed
            .token_events
            .iter()
            .filter(|event| !event.delta.is_zero())
            .map(|event| {
                (
                    event.delta.input,
                    event.delta.cached_input,
                    event.delta.output,
                )
            })
            .collect::<Vec<_>>();

        assert_eq!(
            deltas,
            vec![
                (175_074, 169_728, 6_827),
                (151_258, 147_200, 87),
                (182_130, 169_728, 222),
            ]
        );
        assert!(parsed.token_events[3].delta.is_zero());
        Ok(())
    }

    #[test]
    fn test_cross_limit_snapshot_replay_is_not_double_counted() -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let file = rollout_path(dir.path(), PARENT_ID);
        write_jsonl(
            &file,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                token_count_with_last_at(1_000, 0, 10, 100, 0, 10, "codex", "2026-07-10T03:00:02Z"),
                token_count_with_last_at(
                    1_000,
                    0,
                    10,
                    100,
                    0,
                    10,
                    "codex_bengalfox",
                    "2026-07-10T03:00:03Z",
                ),
            ],
        );

        let parsed = parse_codex_file(&file, Some(PARENT_ID.to_string()))?;
        let deltas = parsed
            .token_events
            .iter()
            .filter(|event| !event.delta.is_zero())
            .map(|event| event.delta.input)
            .collect::<Vec<_>>();

        assert_eq!(deltas, vec![100]);
        Ok(())
    }

    #[test]
    fn test_adjacent_replay_burst_across_multiple_sources_is_deduped() -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let file = rollout_path(dir.path(), PARENT_ID);
        write_jsonl(
            &file,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                token_count_with_last_at(1_000, 0, 10, 100, 0, 10, "codex", "2026-07-10T03:00:02Z"),
                token_count_with_last_at(
                    1_000,
                    0,
                    10,
                    100,
                    0,
                    10,
                    "codex_bengalfox",
                    "2026-07-10T03:00:03Z",
                ),
                token_count_with_last_at(
                    1_000,
                    0,
                    10,
                    100,
                    0,
                    10,
                    "codex_spark",
                    "2026-07-10T03:00:04Z",
                ),
            ],
        );

        let parsed = parse_codex_file(&file, Some(PARENT_ID.to_string()))?;
        let deltas = parsed
            .token_events
            .iter()
            .filter(|event| !event.delta.is_zero())
            .map(|event| event.delta.input)
            .collect::<Vec<_>>();

        assert_eq!(deltas, vec![100]);
        Ok(())
    }

    #[test]
    fn test_cross_source_replay_remains_adjacent_across_non_token_events() -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let file = rollout_path(dir.path(), PARENT_ID);
        write_jsonl(
            &file,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                token_count_with_last_at(1_000, 0, 10, 100, 0, 10, "codex", "2026-07-10T03:00:02Z"),
                turn_context_for_model_at("gpt-5.6-sol", "2026-07-10T03:00:03Z"),
                token_count_with_last_at(
                    1_000,
                    0,
                    10,
                    100,
                    0,
                    10,
                    "codex_bengalfox",
                    "2026-07-10T03:00:04Z",
                ),
            ],
        );

        let parsed = parse_codex_file(&file, Some(PARENT_ID.to_string()))?;
        let deltas = parsed
            .token_events
            .iter()
            .filter(|event| !event.delta.is_zero())
            .map(|event| event.delta.input)
            .collect::<Vec<_>>();

        assert_eq!(deltas, vec![100]);
        Ok(())
    }

    #[test]
    fn test_same_source_repeat_is_deduped_after_another_source_advances() -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let file = rollout_path(dir.path(), PARENT_ID);
        write_jsonl(
            &file,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                token_count_with_last_at(1_000, 0, 10, 100, 0, 10, "codex", "2026-07-10T03:00:02Z"),
                token_count_with_last_at(
                    2_000,
                    0,
                    20,
                    100,
                    0,
                    10,
                    "codex_bengalfox",
                    "2026-07-10T03:00:03Z",
                ),
                // `codex` has not advanced since its X snapshot, so this is a
                // same-source replay even though another source was interleaved.
                token_count_with_last_at(1_000, 0, 10, 100, 0, 10, "codex", "2026-07-10T03:00:04Z"),
            ],
        );

        let parsed = parse_codex_file(&file, Some(PARENT_ID.to_string()))?;
        let deltas = parsed
            .token_events
            .iter()
            .filter(|event| !event.delta.is_zero())
            .map(|event| event.delta.input)
            .collect::<Vec<_>>();

        assert_eq!(deltas, vec![100, 100]);
        Ok(())
    }

    #[test]
    fn test_stale_cross_source_signature_does_not_swallow_reset() -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let file = rollout_path(dir.path(), PARENT_ID);
        write_jsonl(
            &file,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                // `codex` emits snapshot X.
                token_count_with_last_at(1_000, 0, 10, 100, 0, 10, "codex", "2026-07-10T03:00:02Z"),
                // X is replayed under another rate-limit source.
                token_count_with_last_at(
                    1_000,
                    0,
                    10,
                    100,
                    0,
                    10,
                    "codex_bengalfox",
                    "2026-07-10T03:00:03Z",
                ),
                // The original source advances to Y.
                token_count_with_last_at(2_000, 0, 20, 100, 0, 10, "codex", "2026-07-10T03:00:04Z"),
                // A genuine reset later reproduces X. The stale copy retained
                // by `codex_bengalfox` must not classify this as a replay.
                token_count_with_last_at(1_000, 0, 10, 100, 0, 10, "codex", "2026-07-10T03:00:05Z"),
            ],
        );

        let parsed = parse_codex_file(&file, Some(PARENT_ID.to_string()))?;
        let deltas = parsed
            .token_events
            .iter()
            .filter(|event| !event.delta.is_zero())
            .map(|event| event.delta.input)
            .collect::<Vec<_>>();

        assert_eq!(deltas, vec![100, 100, 100]);
        Ok(())
    }

    #[test]
    fn test_full_snapshot_dedupe_allows_counter_reset() -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let file = rollout_path(dir.path(), PARENT_ID);
        let first =
            token_count_with_last_at(100, 50, 10, 100, 50, 10, "codex", "2026-07-10T03:00:02Z");
        write_jsonl(
            &file,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                first.clone(),
                first,
                token_count_with_last_at(
                    200,
                    100,
                    20,
                    100,
                    50,
                    10,
                    "codex",
                    "2026-07-10T03:00:04Z",
                ),
                // A restarted counter may legitimately return to an older
                // total after another full snapshot has advanced the source.
                token_count_with_last_at(100, 50, 10, 50, 25, 5, "codex", "2026-07-10T03:00:05Z"),
            ],
        );

        let parsed = parse_codex_file(&file, Some(PARENT_ID.to_string()))?;
        let deltas = parsed
            .token_events
            .iter()
            .filter(|event| !event.delta.is_zero())
            .map(|event| event.delta.input)
            .collect::<Vec<_>>();

        assert_eq!(deltas, vec![100, 100, 50]);
        Ok(())
    }

    #[test]
    fn test_empty_last_usage_falls_back_to_total() -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let file = rollout_path(dir.path(), PARENT_ID);
        write_jsonl(
            &file,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                serde_json::json!({
                    "timestamp": "2026-07-10T03:00:02Z",
                    "type": "event_msg",
                    "payload": {
                        "type": "token_count",
                        "info": {
                            "total_token_usage": {
                                "input_tokens": 100,
                                "cached_input_tokens": 0,
                                "output_tokens": 10,
                                "reasoning_output_tokens": 0,
                                "total_tokens": 110
                            },
                            "last_token_usage": {}
                        }
                    }
                }),
            ],
        );

        let parsed = parse_codex_file(&file, Some(PARENT_ID.to_string()))?;
        let deltas = parsed
            .token_events
            .iter()
            .filter(|event| !event.delta.is_zero())
            .map(|event| event.delta.input)
            .collect::<Vec<_>>();

        assert_eq!(deltas, vec![100]);
        Ok(())
    }

    #[test]
    fn test_empty_total_does_not_enable_snapshot_deduplication() -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let file = rollout_path(dir.path(), PARENT_ID);
        let event = |limit_id: &str, timestamp: &str| {
            serde_json::json!({
                "timestamp": timestamp,
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "total_token_usage": {},
                        "last_token_usage": {
                            "input_tokens": 100,
                            "cached_input_tokens": 0,
                            "output_tokens": 10,
                            "reasoning_output_tokens": 0,
                            "total_tokens": 110
                        }
                    },
                    "rate_limits": { "limit_id": limit_id }
                }
            })
        };
        write_jsonl(
            &file,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                event("codex", "2026-07-10T03:00:02Z"),
                // Without a usable cumulative total, identical per-request
                // usage is not enough evidence that this is a replay.
                event("codex_bengalfox", "2026-07-10T03:00:03Z"),
            ],
        );

        let parsed = parse_codex_file(&file, Some(PARENT_ID.to_string()))?;
        let deltas = parsed
            .token_events
            .iter()
            .filter(|event| !event.delta.is_zero())
            .map(|event| event.delta.input)
            .collect::<Vec<_>>();

        assert_eq!(deltas, vec![100, 100]);
        Ok(())
    }

    #[test]
    fn test_total_fallback_uses_session_baseline_across_model_switch() -> Result<(), AppError> {
        let dir = tempdir().unwrap();
        let file = rollout_path(dir.path(), PARENT_ID);
        write_jsonl(
            &file,
            &[
                session_meta(PARENT_ID),
                turn_context_for_model_at("model-a", "2026-07-10T03:00:01Z"),
                token_count_at(100, 50, 10, "2026-07-10T03:00:02Z"),
                turn_context_for_model_at("model-b", "2026-07-10T03:00:03Z"),
                token_count_at(150, 75, 15, "2026-07-10T03:00:04Z"),
            ],
        );

        let parsed = parse_codex_file(&file, Some(PARENT_ID.to_string()))?;
        let deltas = parsed
            .token_events
            .iter()
            .filter(|event| !event.delta.is_zero())
            .map(|event| event.delta.input)
            .collect::<Vec<_>>();

        assert_eq!(deltas, vec![100, 50]);
        Ok(())
    }

    #[test]
    fn test_parse_cumulative_tokens_valid() {
        let json: serde_json::Value = serde_json::json!({
            "input_tokens": 17934,
            "cached_input_tokens": 9600,
            "output_tokens": 454,
            "reasoning_output_tokens": 233,
            "total_tokens": 18388
        });
        let tokens = parse_cumulative_tokens(&json).unwrap();
        assert_eq!(tokens.input, 17934);
        assert_eq!(tokens.cached_input, 9600);
        assert_eq!(tokens.output, 454);
    }

    #[test]
    fn test_parse_cumulative_tokens_null() {
        let json = serde_json::Value::Null;
        assert!(parse_cumulative_tokens(&json).is_none());
    }

    #[test]
    fn test_parse_cumulative_tokens_rejects_empty_object_but_accepts_explicit_zero() {
        assert!(parse_cumulative_tokens(&serde_json::json!({})).is_none());

        let tokens = parse_cumulative_tokens(&serde_json::json!({ "input_tokens": 0 }))
            .expect("an explicit zero is valid usage");
        assert_eq!(tokens.input, 0);
        assert_eq!(tokens.cached_input, 0);
        assert_eq!(tokens.output, 0);
    }

    #[test]
    fn test_parse_cumulative_tokens_alt_field_names() {
        // 某些版本可能使用 cache_read_input_tokens 而非 cached_input_tokens
        let json: serde_json::Value = serde_json::json!({
            "input_tokens": 1000,
            "cache_read_input_tokens": 500,
            "output_tokens": 200
        });
        let tokens = parse_cumulative_tokens(&json).unwrap();
        assert_eq!(tokens.cached_input, 500);
    }

    #[test]
    fn test_collect_codex_session_files_nonexistent() {
        let files = collect_codex_session_files(Path::new("/nonexistent/path"));
        assert!(files.is_empty());
    }

    #[test]
    #[serial_test::serial]
    fn test_thread_spawn_parent_strips_replay_and_keeps_live_usage() -> Result<(), AppError> {
        clear_codex_replay_caches();
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let parent = rollout_path(temp.path(), PARENT_ID);
        let child = rollout_path(temp.path(), CHILD_A_ID);
        write_jsonl(
            &parent,
            &[
                session_meta(PARENT_ID),
                token_count_at(1_000, 900, 100, "2026-07-10T03:00:01Z"),
                turn_context_at("2026-07-10T03:00:10Z"),
            ],
        );
        write_jsonl(
            &child,
            &[
                session_meta_at(CHILD_A_ID, None, Some(PARENT_ID), "2026-07-10T03:00:05Z"),
                turn_context(),
                token_count_at(1_000, 900, 100, "2026-07-10T03:00:06Z"),
                token_count_at(1_300, 1_050, 150, "2026-07-10T03:00:07Z"),
            ],
        );

        let result = sync_test_file(&db, &child, &[&parent, &child])?;
        assert_eq!(
            (result.imported, result.skipped, result.deferred),
            (1, 1, false)
        );

        let conn = lock_conn!(db.conn);
        let usage: (i64, i64, i64) = conn.query_row(
            "SELECT input_tokens, cache_read_tokens, output_tokens
             FROM proxy_request_logs WHERE request_id = ?1",
            [format!("{CODEX_THREAD_REQUEST_ID_PREFIX}:{CHILD_A_ID}:2")],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(usage, (300, 150, 50));
        Ok(())
    }

    #[test]
    fn test_legacy_thread_spawn_parent_is_preserved() {
        let payload = serde_json::json!({
            "source": {
                "thread_spawn": {
                    "parent_thread_id": PARENT_ID
                }
            }
        });

        assert!(matches!(
            explicit_parent_from_meta(&payload),
            ParentResolution::Parent(parent) if parent == PARENT_ID
        ));
    }

    #[test]
    #[serial_test::serial]
    fn test_filtered_parent_events_use_subsequence_prefix_alignment() -> Result<(), AppError> {
        clear_codex_replay_caches();
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let parent = rollout_path(temp.path(), PARENT_ID);
        let child = rollout_path(temp.path(), CHILD_A_ID);
        write_jsonl(
            &parent,
            &[
                session_meta(PARENT_ID),
                token_count_at(100, 50, 10, "2026-07-10T03:00:01Z"),
                token_count_at(200, 100, 20, "2026-07-10T03:00:02Z"),
                token_count_at(300, 150, 30, "2026-07-10T03:00:03Z"),
                turn_context_at("2026-07-10T03:00:10Z"),
            ],
        );
        write_jsonl(
            &child,
            &[
                session_meta_at(CHILD_A_ID, Some(PARENT_ID), None, "2026-07-10T03:00:05Z"),
                token_count_at(100, 50, 10, "2026-07-10T03:00:06Z"),
                token_count_at(300, 150, 30, "2026-07-10T03:00:07Z"),
                token_count_at(450, 220, 45, "2026-07-10T03:00:08Z"),
            ],
        );

        let result = sync_test_file(&db, &child, &[&parent, &child])?;
        assert_eq!((result.imported, result.skipped), (1, 2));
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn parent_timeline_cache_retention_bounds_real_lookup_work() {
        clear_codex_replay_caches();
        let dir = tempdir().unwrap();
        let cutoff = "2026-07-10T03:00:05Z".parse::<DateTime<Utc>>().unwrap();
        for ordinal in 0..257 {
            let parent = dir.path().join(format!("parent-{ordinal}.jsonl"));
            finish_retryable_snapshot_parent(&parent);
            let signatures = parent_signatures_before(&parent, cutoff).unwrap();
            assert_eq!(signatures.len(), 1, "cache pressure must not alter results");
            assert_eq!(signatures[0].total.as_ref().unwrap().input, Some(100));
        }
        {
            let caches = replay_caches().lock().unwrap();
            assert!(
                caches.parent_timelines.len() <= 256,
                "disposable parent timelines must not retain every file forever"
            );
            assert!(caches.parent_timeline_event_capacity() <= MAX_PARENT_TOTAL_EVENT_CAPACITY);
            assert!(
                caches.parent_timeline_retained_allocation_estimate() <= MAX_PARENT_TOTAL_BYTES
            );
            assert!(!caches
                .parent_timelines
                .contains_key(&dir.path().join("parent-0.jsonl")));
        }
        let admitted = dir.path().join("parent-256.jsonl");
        let admitted_size = fs::metadata(&admitted).unwrap().len();
        CODEX_PARENT_TIMELINE_PARSES.with(|count| count.set(0));
        CODEX_PARENT_TIMELINE_PARSE_BYTES.with(|bytes| bytes.set(0));
        CODEX_PARENT_TIMELINE_VERIFY_BYTES.with(|bytes| bytes.set(0));
        assert_eq!(
            parent_signatures_before(&admitted, cutoff).unwrap().len(),
            1
        );
        CODEX_PARENT_TIMELINE_PARSES.with(|count| assert_eq!(count.get(), 0));
        CODEX_PARENT_TIMELINE_PARSE_BYTES.with(|bytes| assert_eq!(bytes.get(), 0));
        let fallback_verify_bytes = if FileRevision::read(&admitted).is_some() {
            0
        } else {
            admitted_size
        };
        CODEX_PARENT_TIMELINE_VERIFY_BYTES
            .with(|bytes| assert_eq!(bytes.get(), fallback_verify_bytes));
        let evicted = dir.path().join("parent-0.jsonl");
        assert_eq!(parent_signatures_before(&evicted, cutoff).unwrap().len(), 1);
        CODEX_PARENT_TIMELINE_PARSES.with(|count| assert_eq!(count.get(), 1));
        let caches = replay_caches().lock().unwrap();
        assert_eq!(caches.parent_timelines.len(), MAX_PARENT_TIMELINES);
        assert!(caches.parent_timelines.contains_key(&evicted));
    }

    fn parent_timeline_with_capacity(capacity: usize) -> Arc<ParentTokenTimeline> {
        let mut events = Vec::with_capacity(capacity);
        if capacity > 0 {
            events.push(TimestampedTokenSignature {
                timestamp: "2026-07-10T03:00:01Z".parse().unwrap(),
                signature: TokenUsageSignature {
                    total: None,
                    last: None,
                },
            });
        }
        Arc::new(ParentTokenTimeline {
            events,
            max_timestamp: Some("2026-07-10T03:00:10Z".parse().unwrap()),
            has_token_without_timestamp: false,
        })
    }

    #[test]
    #[serial_test::serial]
    fn parent_timeline_cache_admission_counts_capacity_and_allocations_separately() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("stamp.jsonl");
        finish_retryable_snapshot_parent(&source);
        let stamp = ParentFileStamp::from_file(&fs::File::open(&source).unwrap()).unwrap();
        let digest = [0; 32];
        let mut caches = CodexReplayCaches::default();
        let oversized = parent_timeline_with_capacity(MAX_PARENT_TIMELINE_EVENT_CAPACITY + 1);
        assert_eq!(oversized.events.len(), 1);
        caches.retain_parent_timeline(
            Path::new("oversized-capacity"),
            stamp,
            None,
            digest,
            &oversized,
        );
        assert!(
            caches.parent_timelines.is_empty(),
            "capacity, not len, controls admission"
        );
        let empty = parent_timeline_with_capacity(0);
        let oversized_path = PathBuf::from("x".repeat(MAX_PARENT_TIMELINE_BYTES + 1));
        caches.retain_parent_timeline(&oversized_path, stamp, None, digest, &empty);
        assert!(
            caches.parent_timelines.is_empty(),
            "path allocation must not bypass per-entry budget"
        );
        for ordinal in 0..16 {
            let timeline = parent_timeline_with_capacity(MAX_PARENT_TIMELINE_EVENT_CAPACITY);
            assert_eq!(timeline.events.len(), 1);
            caches.retain_parent_timeline(
                Path::new(&format!("capacity-{ordinal}")),
                stamp,
                None,
                digest,
                &timeline,
            );
            assert!(caches.parent_timeline_event_capacity() <= MAX_PARENT_TOTAL_EVENT_CAPACITY);
            assert!(
                caches.parent_timeline_retained_allocation_estimate() <= MAX_PARENT_TOTAL_BYTES
            );
        }
        assert_eq!(
            caches.parent_timelines.len(),
            MAX_PARENT_TOTAL_EVENT_CAPACITY / MAX_PARENT_TIMELINE_EVENT_CAPACITY
        );
        assert_eq!(
            caches.parent_timeline_event_capacity(),
            MAX_PARENT_TOTAL_EVENT_CAPACITY
        );
        assert!(caches
            .parent_timelines
            .values()
            .all(|entry| entry.timeline.events.len() == 1));
        caches = CodexReplayCaches::default();
        for ordinal in 0..20 {
            // This is an in-memory admission key, never a physical filesystem
            // path: exercise byte pressure without Windows path-length issues.
            let path = PathBuf::from(format!("{}-{ordinal}", "x".repeat(512 * 1024)));
            caches.retain_parent_timeline(&path, stamp, None, digest, &empty);
            assert!(
                caches.parent_timeline_retained_allocation_estimate() <= MAX_PARENT_TOTAL_BYTES
            );
            assert_eq!(caches.parent_timeline_event_capacity(), 0);
        }
        assert!(!caches.parent_timelines.is_empty());
        assert!(
            caches.parent_timelines.len() < 20,
            "byte budget must evict independently of entry/record limits"
        );
        caches.next_parent_timeline_order = u64::MAX;
        caches.retain_parent_timeline(
            Path::new("after-sequence-wrap"),
            stamp,
            None,
            digest,
            &empty,
        );
        assert_eq!(caches.parent_timelines.len(), 1);
        assert_eq!(caches.next_parent_timeline_order, 1);
    }

    #[test]
    #[serial_test::serial]
    fn oversized_parent_timeline_returns_all_signatures_without_retaining_history() {
        clear_codex_replay_caches();
        let dir = tempdir().unwrap();
        let parent = rollout_path(dir.path(), PARENT_ID);
        let mut records = vec![session_meta(PARENT_ID)];
        records.extend(
            (0..MAX_PARENT_TIMELINE_EVENT_CAPACITY + 1)
                .map(|index| token_count_at(index as u64 + 100, 50, 10, "2026-07-10T03:00:01Z")),
        );
        records.push(turn_context_at("2026-07-10T03:00:10Z"));
        write_jsonl(&parent, &records);
        let cutoff = "2026-07-10T03:00:05Z".parse::<DateTime<Utc>>().unwrap();
        let size = fs::metadata(&parent).unwrap().len();
        CODEX_PARENT_TIMELINE_PARSES.with(|count| count.set(0));
        CODEX_PARENT_TIMELINE_PARSE_BYTES.with(|bytes| bytes.set(0));
        CODEX_PARENT_TIMELINE_VERIFY_BYTES.with(|bytes| bytes.set(0));
        for _ in 0..2 {
            let result = parent_signatures_before(&parent, cutoff).unwrap();
            assert_eq!(result.len(), MAX_PARENT_TIMELINE_EVENT_CAPACITY + 1);
            assert_eq!(
                result.last().unwrap().total.as_ref().unwrap().input,
                Some(MAX_PARENT_TIMELINE_EVENT_CAPACITY as u64 + 100)
            );
            assert!(replay_caches().lock().unwrap().parent_timelines.is_empty());
        }
        CODEX_PARENT_TIMELINE_PARSES.with(|count| assert_eq!(count.get(), 2));
        CODEX_PARENT_TIMELINE_PARSE_BYTES.with(|bytes| assert_eq!(bytes.get(), 2 * size));
        CODEX_PARENT_TIMELINE_VERIFY_BYTES.with(|bytes| assert_eq!(bytes.get(), 2 * size));
    }

    #[test]
    #[serial_test::serial]
    fn parent_timeline_cache_eviction_pruning_and_mutations_preserve_recovery(
    ) -> Result<(), AppError> {
        use std::io::Write;
        clear_codex_replay_caches();
        let dir = tempdir().unwrap();
        let parent = rollout_path(dir.path(), PARENT_ID);
        let child = rollout_path(dir.path(), CHILD_A_ID);
        let db = Database::memory()?;
        write_retryable_snapshot_fixture(&parent, &child, 128);
        assert!(sync_test_file(&db, &child, &[&parent, &child])?.deferred);
        assert_retryable_snapshot_waits_for_parent(&child);
        {
            let mut caches = replay_caches().lock().unwrap();
            assert!(caches.parent_timelines.contains_key(&parent));
            caches.retain_discovered_replay_derivatives(std::slice::from_ref(&child));
            assert!(caches.parent_timelines.is_empty());
            assert_eq!(caches.parent_timelines.capacity(), 0);
            assert_eq!(caches.retryable_snapshots.len(), 1);
        }
        fs::remove_file(&parent).unwrap();
        assert!(sync_test_file(&db, &child, &[&child])?.deferred);
        finish_retryable_snapshot_parent(&parent);
        assert_eq!(sync_test_file(&db, &child, &[&parent, &child])?.imported, 1);
        assert_eq!(sync_test_file(&db, &child, &[&parent, &child])?.imported, 0);
        let cutoff = "2026-07-10T03:00:15Z".parse::<DateTime<Utc>>().unwrap();
        fs::OpenOptions::new()
            .append(true)
            .open(&parent)
            .unwrap()
            .write_all(
                format!(
                    "{}\n{}\n",
                    token_count_at(200, 100, 20, "2026-07-10T03:00:12Z"),
                    turn_context_at("2026-07-10T03:00:20Z")
                )
                .as_bytes(),
            )
            .unwrap();
        assert_eq!(parent_signatures_before(&parent, cutoff).unwrap().len(), 2);
        let metadata = fs::metadata(&parent).unwrap();
        let before = fs::read(&parent).unwrap();
        let rewritten = String::from_utf8(before.clone())
            .unwrap()
            .replace("\"input_tokens\":200", "\"input_tokens\":300");
        assert_ne!(rewritten.as_bytes(), before);
        fs::write(&parent, rewritten).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&parent)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(metadata.modified().unwrap()))
            .unwrap();
        let result = parent_signatures_before(&parent, cutoff).unwrap();
        assert_eq!(result[1].total.as_ref().unwrap().input, Some(300));
        let replacement = dir.path().join("replacement.jsonl");
        fs::write(&replacement, &before).unwrap();
        fs::remove_file(&parent).unwrap();
        fs::rename(&replacement, &parent).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&parent)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(metadata.modified().unwrap()))
            .unwrap();
        let result = parent_signatures_before(&parent, cutoff).unwrap();
        assert_eq!(result[1].total.as_ref().unwrap().input, Some(200));
        fs::remove_file(&parent).unwrap();
        assert!(parent_signatures_before(&parent, cutoff).is_err());
        assert!(!replay_caches()
            .lock()
            .unwrap()
            .parent_timelines
            .contains_key(&parent));
        finish_retryable_snapshot_parent(&parent);
        assert_eq!(
            parent_signatures_before(&parent, "2026-07-10T03:00:05Z".parse().unwrap())
                .unwrap()
                .len(),
            1
        );
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn parent_timeline_cache_drops_entry_when_hit_validation_fails() {
        clear_codex_replay_caches();
        let dir = tempdir().unwrap();
        let parent = rollout_path(dir.path(), PARENT_ID);
        finish_retryable_snapshot_parent(&parent);
        let cutoff = "2026-07-10T03:00:05Z".parse::<DateTime<Utc>>().unwrap();
        assert_eq!(parent_signatures_before(&parent, cutoff).unwrap().len(), 1);
        assert!(replay_caches()
            .lock()
            .unwrap()
            .parent_timelines
            .contains_key(&parent));
        let changed = parent.clone();
        BEFORE_CODEX_PARENT_BYTES_VALIDATION_FINISH.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                fs::write(&changed, b"{}\n").unwrap();
            }))
        });
        assert!(parent_signatures_before(&parent, cutoff).is_err());
        assert!(!replay_caches()
            .lock()
            .unwrap()
            .parent_timelines
            .contains_key(&parent));
        finish_retryable_snapshot_parent(&parent);
        assert_eq!(parent_signatures_before(&parent, cutoff).unwrap().len(), 1);
    }

    #[test]
    #[serial_test::serial]
    fn test_parent_rollout_is_cached_once_across_fork_cutoffs() -> Result<(), AppError> {
        clear_codex_replay_caches();
        let temp = tempdir().unwrap();
        let parent = rollout_path(temp.path(), PARENT_ID);
        write_jsonl(
            &parent,
            &[
                session_meta(PARENT_ID),
                token_count_at(100, 50, 10, "2026-07-10T03:00:01Z"),
                token_count_at(200, 100, 20, "2026-07-10T03:00:10Z"),
                turn_context_at("2026-07-10T03:00:20Z"),
            ],
        );

        let early = "2026-07-10T03:00:05Z".parse::<DateTime<Utc>>().unwrap();
        let late = "2026-07-10T03:00:15Z".parse::<DateTime<Utc>>().unwrap();
        assert_eq!(parent_signatures_before(&parent, early).unwrap().len(), 1);
        let first_timeline =
            Arc::clone(&replay_caches().lock().unwrap().parent_timelines[&parent].timeline);
        assert_eq!(parent_signatures_before(&parent, late).unwrap().len(), 2);

        let caches = replay_caches().lock().unwrap();
        assert_eq!(caches.parent_timelines.len(), 1);
        assert!(Arc::ptr_eq(
            &first_timeline,
            &caches.parent_timelines[&parent].timeline
        ));
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn test_parent_rollout_cache_invalidates_after_append() -> Result<(), AppError> {
        clear_codex_replay_caches();
        let temp = tempdir().unwrap();
        let parent = rollout_path(temp.path(), PARENT_ID);
        let cutoff = "2026-07-10T03:00:15Z".parse::<DateTime<Utc>>().unwrap();
        write_jsonl(
            &parent,
            &[
                session_meta(PARENT_ID),
                token_count_at(100, 50, 10, "2026-07-10T03:00:01Z"),
                turn_context_at("2026-07-10T03:00:20Z"),
            ],
        );
        assert_eq!(parent_signatures_before(&parent, cutoff).unwrap().len(), 1);

        write_jsonl(
            &parent,
            &[
                session_meta(PARENT_ID),
                token_count_at(100, 50, 10, "2026-07-10T03:00:01Z"),
                token_count_at(200, 100, 20, "2026-07-10T03:00:10Z"),
                turn_context_at("2026-07-10T03:00:20Z"),
            ],
        );
        assert_eq!(parent_signatures_before(&parent, cutoff).unwrap().len(), 2);

        let caches = replay_caches().lock().unwrap();
        assert_eq!(caches.parent_timelines.len(), 1);
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn test_parent_rollout_content_error_cache_preserves_open_errors() {
        clear_codex_replay_caches();
        let temp = tempdir().unwrap();
        let parent = rollout_path(temp.path(), PARENT_ID);
        let cutoff = "2026-07-10T03:00:05Z".parse::<DateTime<Utc>>().unwrap();
        write_jsonl(
            &parent,
            &[
                session_meta(PARENT_ID),
                token_count_without_timestamp(100, 50, 10),
                turn_context_at("2026-07-10T03:00:20Z"),
            ],
        );

        let first_error = parent_signatures_before(&parent, cutoff).unwrap_err();
        assert!(first_error.contains("token_count 缺少有效 timestamp"));
        let cached_timeline =
            || Arc::clone(&replay_caches().lock().unwrap().parent_timelines[&parent].timeline);
        let first_timeline = cached_timeline();

        let second_error = parent_signatures_before(&parent, cutoff).unwrap_err();
        assert_eq!(second_error, first_error);
        assert!(Arc::ptr_eq(&first_timeline, &cached_timeline()));

        fs::remove_file(&parent).unwrap();
        let open_error = parent_signatures_before(&parent, cutoff).unwrap_err();
        assert!(open_error.contains("无法打开父 rollout"));
    }

    #[test]
    #[serial_test::serial]
    fn test_parent_rollout_nanosecond_cutoffs_are_exact() {
        clear_codex_replay_caches();
        let temp = tempdir().unwrap();
        let parent = rollout_path(temp.path(), PARENT_ID);
        write_jsonl(
            &parent,
            &[
                session_meta(PARENT_ID),
                token_count_at(100, 50, 10, "2026-07-10T03:00:00.000000500Z"),
                turn_context_at("2026-07-10T03:00:00.000000900Z"),
            ],
        );

        let before = "2026-07-10T03:00:00.000000300Z"
            .parse::<DateTime<Utc>>()
            .unwrap();
        let after = "2026-07-10T03:00:00.000000700Z"
            .parse::<DateTime<Utc>>()
            .unwrap();
        assert!(parent_signatures_before(&parent, before)
            .unwrap()
            .is_empty());
        assert_eq!(parent_signatures_before(&parent, after).unwrap().len(), 1);
        assert_eq!(replay_caches().lock().unwrap().parent_timelines.len(), 1);
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn test_parent_file_stamp_distinguishes_same_size_same_mtime_files() {
        use std::io::Write;

        let temp = tempdir().unwrap();
        let parent = rollout_path(temp.path(), PARENT_ID);
        let replacement = temp.path().join("replacement.jsonl");
        let values = [session_meta(PARENT_ID), token_count(100, 50, 10)];
        write_jsonl(&parent, &values);
        write_jsonl(&replacement, &values);
        let original_file = fs::File::open(&parent).unwrap();
        let original_metadata = original_file.metadata().unwrap();
        let replacement_file = fs::OpenOptions::new()
            .write(true)
            .open(&replacement)
            .unwrap();
        replacement_file
            .set_times(fs::FileTimes::new().set_modified(original_metadata.modified().unwrap()))
            .unwrap();
        let original_stamp = ParentFileStamp::from_file(&original_file).unwrap();
        let replacement_stamp = ParentFileStamp::from_file(&replacement_file).unwrap();
        assert_eq!(
            (original_stamp.size, original_stamp.modified_nanos),
            (replacement_stamp.size, replacement_stamp.modified_nanos)
        );
        assert_ne!(original_stamp, replacement_stamp);

        let mut append_file = fs::OpenOptions::new().append(true).open(&parent).unwrap();
        append_file.write_all(b"{\"future\":true}\n").unwrap();
        let grown_stamp = ParentFileStamp::from_file(&append_file).unwrap();
        assert!(original_stamp.same_identity(&grown_stamp));
        assert!(original_stamp.same_identity_and_not_shrunk(&grown_stamp));
        assert!(!original_stamp.same_identity_and_not_shrunk(&replacement_stamp));

        drop(append_file);
        let truncating_file = fs::OpenOptions::new().write(true).open(&parent).unwrap();
        truncating_file
            .set_len(original_stamp.size.saturating_sub(1))
            .unwrap();
        let shrunk_stamp = ParentFileStamp::from_file(&truncating_file).unwrap();
        assert!(!original_stamp.same_identity_and_not_shrunk(&shrunk_stamp));
    }

    #[test]
    #[serial_test::serial]
    fn test_empty_fork_imports_no_parent_usage() -> Result<(), AppError> {
        clear_codex_replay_caches();
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let parent = rollout_path(temp.path(), PARENT_ID);
        let child = rollout_path(temp.path(), CHILD_A_ID);
        write_jsonl(
            &parent,
            &[
                session_meta(PARENT_ID),
                token_count_at(100, 50, 10, "2026-07-10T03:00:01Z"),
                token_count_at(200, 100, 20, "2026-07-10T03:00:02Z"),
                turn_context_at("2026-07-10T03:00:10Z"),
            ],
        );
        write_jsonl(
            &child,
            &[
                session_meta_at(CHILD_A_ID, Some(PARENT_ID), None, "2026-07-10T03:00:05Z"),
                token_count_at(100, 50, 10, "2026-07-10T03:00:06Z"),
                token_count_at(200, 100, 20, "2026-07-10T03:00:07Z"),
                serde_json::json!({
                    "timestamp": "2026-07-10T03:00:08Z",
                    "type": "event_msg",
                    "payload": { "type": "thread_settings_applied" }
                }),
            ],
        );

        let result = sync_test_file(&db, &child, &[&parent, &child])?;
        assert_eq!(
            (result.imported, result.skipped, result.deferred),
            (0, 2, false)
        );
        let conn = lock_conn!(db.conn);
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM proxy_request_logs WHERE data_source = 'codex_session'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(count, 0);
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn test_conflicting_explicit_parents_are_deferred() -> Result<(), AppError> {
        clear_codex_replay_caches();
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let child = rollout_path(temp.path(), CHILD_A_ID);
        write_jsonl(
            &child,
            &[
                session_meta_at(
                    CHILD_A_ID,
                    Some(PARENT_ID),
                    Some(CHILD_B_ID),
                    "2026-07-10T03:00:05Z",
                ),
                token_count_at(100, 50, 10, "2026-07-10T03:00:06Z"),
            ],
        );

        let result = sync_test_file(&db, &child, &[&child])?;
        assert!(result.deferred);
        assert_eq!(get_sync_state(&db, &child.to_string_lossy())?, (0, 0));
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn test_parent_future_signature_cannot_extend_replay_prefix() -> Result<(), AppError> {
        clear_codex_replay_caches();
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let parent = rollout_path(temp.path(), PARENT_ID);
        let child = rollout_path(temp.path(), CHILD_A_ID);
        write_jsonl(
            &parent,
            &[
                session_meta(PARENT_ID),
                token_count_at(100, 50, 10, "2026-07-10T03:00:01Z"),
                token_count_at(200, 100, 20, "2026-07-10T03:00:06Z"),
            ],
        );
        write_jsonl(
            &child,
            &[
                session_meta_at(CHILD_A_ID, Some(PARENT_ID), None, "2026-07-10T03:00:05Z"),
                token_count_at(200, 100, 20, "2026-07-10T03:00:07Z"),
            ],
        );

        let result = sync_test_file(&db, &child, &[&parent, &child])?;
        assert_eq!(
            (result.imported, result.skipped, result.deferred),
            (1, 0, false)
        );
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn test_missing_parent_is_deferred_and_recovered_without_child_change() -> Result<(), AppError>
    {
        clear_codex_replay_caches();
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let parent = rollout_path(temp.path(), PARENT_ID);
        let child = rollout_path(temp.path(), CHILD_A_ID);
        write_jsonl(
            &child,
            &[
                session_meta_at(CHILD_A_ID, None, Some(PARENT_ID), "2026-07-10T03:00:05Z"),
                token_count_at(900, 400, 90, "2026-07-10T03:00:06Z"),
            ],
        );

        let deferred = sync_test_file(&db, &child, &[&child])?;
        assert!(deferred.deferred);
        assert_eq!(get_sync_state(&db, &child.to_string_lossy())?, (0, 0));

        write_jsonl(
            &parent,
            &[
                session_meta(PARENT_ID),
                token_count_at(100, 50, 10, "2026-07-10T03:00:01Z"),
                turn_context_at("2026-07-10T03:00:10Z"),
            ],
        );
        let recovered = sync_test_file(&db, &child, &[&parent, &child])?;
        assert_eq!((recovered.imported, recovered.deferred), (1, false));
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn test_billable_file_without_meta_is_deferred_without_cursor() -> Result<(), AppError> {
        clear_codex_replay_caches();
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let child = rollout_path(temp.path(), CHILD_A_ID);
        write_jsonl(&child, &[turn_context(), token_count(100, 50, 10)]);

        let result = sync_test_file(&db, &child, &[&child])?;
        assert!(result.deferred);
        assert_eq!(get_sync_state(&db, &child.to_string_lossy())?, (0, 0));

        std::thread::sleep(std::time::Duration::from_millis(2));
        write_jsonl(
            &child,
            &[
                turn_context(),
                token_count(100, 50, 10),
                session_meta_at(CHILD_A_ID, None, None, "2026-07-10T03:00:03Z"),
            ],
        );
        let recovered = sync_test_file(&db, &child, &[&child])?;
        assert_eq!((recovered.imported, recovered.deferred), (1, false));
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn test_non_billable_file_without_meta_advances_cursor() -> Result<(), AppError> {
        clear_codex_replay_caches();
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let child = rollout_path(temp.path(), CHILD_A_ID);
        write_jsonl(
            &child,
            &[
                turn_context(),
                token_count_at(0, 0, 0, "2026-07-10T03:00:02Z"),
            ],
        );

        let result = sync_test_file(&db, &child, &[&child])?;
        assert!(!result.deferred);
        assert_eq!(get_sync_state(&db, &child.to_string_lossy())?.1, 2);
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn test_subagents_use_filename_thread_ids() -> Result<(), AppError> {
        clear_codex_replay_caches();
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let child_a = rollout_path(temp.path(), CHILD_A_ID);
        let child_b = rollout_path(temp.path(), CHILD_B_ID);
        write_jsonl(
            &child_a,
            &[
                session_meta(CHILD_A_ID),
                turn_context(),
                token_count(100, 50, 10),
            ],
        );
        write_jsonl(
            &child_b,
            &[
                session_meta(CHILD_B_ID),
                turn_context(),
                token_count(200, 100, 20),
            ],
        );

        assert_eq!(
            sync_test_file(&db, &child_a, &[&child_a, &child_b])?.imported,
            1
        );
        assert_eq!(
            sync_test_file(&db, &child_b, &[&child_a, &child_b])?.imported,
            1
        );

        let conn = lock_conn!(db.conn);
        let request_ids = conn
            .prepare(
                "SELECT request_id FROM proxy_request_logs
                 WHERE data_source = 'codex_session' ORDER BY request_id",
            )?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        assert_eq!(
            request_ids,
            vec![
                format!("{CODEX_THREAD_REQUEST_ID_PREFIX}:{CHILD_A_ID}:1"),
                format!("{CODEX_THREAD_REQUEST_ID_PREFIX}:{CHILD_B_ID}:1")
            ]
        );
        Ok(())
    }

    #[test]
    #[serial_test::serial]
    fn test_archived_log_inherits_cursor_and_only_imports_appended_usage() -> Result<(), AppError> {
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let sessions = temp.path().join("sessions");
        let archived = temp.path().join("archived_sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::create_dir_all(&archived).unwrap();
        let source = rollout_path(&sessions, PARENT_ID);
        let archived_file = rollout_path(&archived, PARENT_ID);
        write_jsonl(
            &archived_file,
            &[
                session_meta(PARENT_ID),
                turn_context(),
                token_count(100, 50, 10),
                token_count(200, 100, 20),
            ],
        );

        {
            let conn = lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model, request_model,
                    input_tokens, output_tokens, cache_read_tokens,
                    total_cost_usd, latency_ms, status_code, session_id,
                    created_at, data_source
                ) VALUES ('codex_session:parent:2', '_codex_session', 'codex',
                          'gpt-5.6-sol', 'gpt-5.6-sol', 999, 99, 0, '0', 0,
                          200, 'parent', 1, 'codex_session')",
                [],
            )?;
        }
        let source_path = source.to_string_lossy().to_string();
        update_sync_state(&db, &source_path, 1, 3)?;

        assert_eq!(
            sync_test_file(&db, &archived_file, &[&archived_file])?.imported,
            1
        );
        assert_eq!(
            sync_test_file(&db, &archived_file, &[&archived_file])?.imported,
            0
        );

        let conn = lock_conn!(db.conn);
        let old_row_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM proxy_request_logs
             WHERE request_id = 'codex_session:parent:2'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(old_row_count, 1);
        let usage: (i64, i64, i64) = conn.query_row(
            "SELECT input_tokens, cache_read_tokens, output_tokens
             FROM proxy_request_logs
             WHERE request_id = ?1",
            [format!("{CODEX_THREAD_REQUEST_ID_PREFIX}:{PARENT_ID}:2")],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(usage, (100, 50, 10));
        drop(conn);
        assert_eq!(get_sync_state(&db, &archived_file.to_string_lossy())?.1, 4);

        Ok(())
    }

    #[test]
    fn test_insert_codex_session_skips_matching_proxy_log() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model, request_model,
                    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                    total_cost_usd, latency_ms, status_code, created_at, data_source
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                rusqlite::params![
                    "codex-proxy",
                    "openai",
                    "codex",
                    "gpt-5.4",
                    "gpt-5.4",
                    10,
                    2,
                    1,
                    7,
                    "0.01",
                    100,
                    200,
                    1000,
                    "proxy"
                ],
            )?;
        }

        let delta = DeltaTokens {
            input: 10,
            cached_input: 1,
            output: 2,
        };
        let mut suspected_duplicates = 0;
        let inserted = insert_codex_session_entry(
            &db,
            "codex-session-dup",
            &delta,
            "gpt-5.4",
            Some("session-1"),
            Some("1970-01-01T00:16:45Z"),
            &mut suspected_duplicates,
        )?;
        assert!(!inserted);

        let conn = lock_conn!(db.conn);
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM proxy_request_logs", [], |row| {
            row.get(0)
        })?;
        assert_eq!(count, 1);

        Ok(())
    }

    #[test]
    fn test_codex_session_duplicate_is_observed_but_still_inserted() -> Result<(), AppError> {
        let db = Database::memory()?;
        let delta = DeltaTokens {
            input: 10,
            cached_input: 1,
            output: 2,
        };
        let mut suspected_duplicates = 0;
        assert!(insert_codex_session_entry(
            &db,
            "codex-session-a",
            &delta,
            "gpt-5.4",
            Some("session-a"),
            Some("1970-01-01T00:16:40Z"),
            &mut suspected_duplicates,
        )?);
        assert!(insert_codex_session_entry(
            &db,
            "codex-session-b",
            &delta,
            "gpt-5.4",
            Some("session-b"),
            Some("1970-01-01T00:16:45Z"),
            &mut suspected_duplicates,
        )?);
        assert_eq!(suspected_duplicates, 1);

        let conn = lock_conn!(db.conn);
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM proxy_request_logs WHERE data_source = 'codex_session'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(count, 2);
        Ok(())
    }

    #[test]
    fn reset_codex_usage_only_removes_codex_rows_and_structural_cursors() -> Result<(), AppError> {
        let db = Database::memory()?;
        let temp = tempdir().unwrap();
        let wide_dir = temp.path();
        let current_codex = rollout_path(&wide_dir.join("sessions"), CHILD_A_ID);
        let legacy_codex =
            format!("C:\\old-codex\\archived_sessions\\rollout-old-{CHILD_B_ID}.jsonl");
        let gemini_cursor = wide_dir.join("gemini/sessions/session-123.json");
        let claude_cursor = wide_dir.join(format!("projects/rollout-{PARENT_ID}.jsonl"));

        {
            let conn = lock_conn!(db.conn);
            conn.execute_batch(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model, input_tokens,
                    output_tokens, cache_read_tokens, latency_ms, status_code,
                    created_at, data_source
                 ) VALUES
                    ('codex-row', '_codex_session', 'codex', 'gpt', 1, 1, 0, 0, 200, 1, 'codex_session'),
                    ('gemini-row', '_gemini_session', 'gemini', 'gemini', 1, 1, 0, 0, 200, 1, 'gemini_session');
                 INSERT INTO usage_daily_rollups (date, app_type, provider_id, model)
                 VALUES
                    ('2026-07-10', 'codex', '_codex_session', 'gpt'),
                    ('2026-07-10', 'gemini', '_gemini_session', 'gemini');",
            )?;
            for path in [
                current_codex.to_string_lossy().to_string(),
                legacy_codex,
                gemini_cursor.to_string_lossy().to_string(),
                claude_cursor.to_string_lossy().to_string(),
            ] {
                conn.execute(
                    "INSERT INTO session_log_sync
                     (file_path, last_modified, last_line_offset, last_synced_at)
                     VALUES (?1, 1, 1, 1)",
                    [path],
                )?;
            }

            reset_codex_usage_on_conn(&conn, wide_dir)?;
            let codex_rows: i64 = conn.query_row(
                "SELECT COUNT(*) FROM proxy_request_logs WHERE data_source = 'codex_session'",
                [],
                |row| row.get(0),
            )?;
            let gemini_rows: i64 = conn.query_row(
                "SELECT COUNT(*) FROM proxy_request_logs WHERE data_source = 'gemini_session'",
                [],
                |row| row.get(0),
            )?;
            let codex_rollups: i64 = conn.query_row(
                "SELECT COUNT(*) FROM usage_daily_rollups WHERE provider_id = '_codex_session'",
                [],
                |row| row.get(0),
            )?;
            let remaining_cursors: i64 =
                conn.query_row("SELECT COUNT(*) FROM session_log_sync", [], |row| {
                    row.get(0)
                })?;
            assert_eq!((codex_rows, gemini_rows, codex_rollups), (0, 1, 0));
            assert_eq!(remaining_cursors, 2);
        }
        Ok(())
    }

    // ── 模型名归一化测试 ──

    #[test]
    fn test_normalize_codex_model_lowercase() {
        assert_eq!(normalize_codex_model("GLM-4.6"), "glm-4.6");
        assert_eq!(normalize_codex_model("DeepSeek-Chat"), "deepseek-chat");
        assert_eq!(normalize_codex_model("GPT-5.4"), "gpt-5.4");
    }

    #[test]
    fn test_normalize_codex_model_strip_prefix() {
        assert_eq!(normalize_codex_model("openai/gpt-5.4"), "gpt-5.4");
        assert_eq!(
            normalize_codex_model("azure/gpt-5.2-codex"),
            "gpt-5.2-codex"
        );
        assert_eq!(normalize_codex_model("OPENAI/GPT-5.4"), "gpt-5.4");
    }

    #[test]
    fn test_normalize_codex_model_strip_iso_date() {
        assert_eq!(normalize_codex_model("gpt-5.4-2026-03-05"), "gpt-5.4");
        assert_eq!(
            normalize_codex_model("gpt-5.4-pro-2026-03-05"),
            "gpt-5.4-pro"
        );
    }

    #[test]
    fn test_normalize_codex_model_strip_compact_date() {
        assert_eq!(normalize_codex_model("gpt-5.4-20260305"), "gpt-5.4");
        assert_eq!(
            normalize_codex_model("claude-opus-4-6-20260206"),
            "claude-opus-4-6"
        );
    }

    #[test]
    fn test_normalize_codex_model_no_change() {
        assert_eq!(normalize_codex_model("gpt-5.4"), "gpt-5.4");
        assert_eq!(normalize_codex_model("gpt-5.2-codex"), "gpt-5.2-codex");
        assert_eq!(normalize_codex_model("o3"), "o3");
        assert_eq!(normalize_codex_model("deepseek-chat"), "deepseek-chat");
    }

    #[test]
    fn test_normalize_codex_model_combined() {
        // prefix + uppercase + ISO date
        assert_eq!(
            normalize_codex_model("openai/GPT-5.4-2026-03-05"),
            "gpt-5.4"
        );
        // prefix + compact date
        assert_eq!(normalize_codex_model("openai/gpt-5.4-20260305"), "gpt-5.4");
    }

    #[test]
    fn test_cached_clamped_to_input() {
        // cached > input 的异常场景应被 min() 钳制
        let prev = Some(CumulativeTokens {
            input: 100,
            cached_input: 0,
            output: 50,
        });
        let current = CumulativeTokens {
            input: 110,       // delta = 10
            cached_input: 80, // delta = 80（异常：大于 input delta）
            output: 60,
        };
        let delta = compute_delta(&prev, &current);
        // 钳制前：cached_input = 80, input = 10
        assert_eq!(delta.cached_input, 80);
        assert_eq!(delta.input, 10);
        // 实际钳制在调用侧：delta.cached_input.min(delta.input)
        let clamped = delta.cached_input.min(delta.input);
        assert_eq!(clamped, 10);
    }

    /// 真实语料回放验收 harness（仅手动运行，勿在 CI 跑）。
    ///
    /// 把真实 `~/.codex/sessions` 语料在内存库上做一次全量重导，输出计时与
    /// 结果快照。用于性能改动的行为等价验证：改动前后各跑一次，两侧
    /// `CODEX_REPLAY_OUT` 文件必须逐字节相同。
    ///
    /// ```bash
    /// CODEX_REPLAY_OUT=/tmp/replay.tsv \
    ///   cargo test --release replay_real_codex_corpus -- --ignored --nocapture
    /// ```
    #[test]
    #[serial_test::serial]
    #[ignore]
    fn replay_real_codex_corpus() -> Result<(), AppError> {
        let Some(real_home) = dirs::home_dir() else {
            eprintln!("[REPLAY] no home dir, skipping");
            return Ok(());
        };
        let real_sessions = real_home.join(".codex").join("sessions");
        if !real_sessions.is_dir() {
            eprintln!("[REPLAY] {} not found, skipping", real_sessions.display());
            return Ok(());
        }

        // 临时 HOME 里只放一个指向真实语料的只读 symlink，避免测试
        // 触碰真实 ~/.cc-switch / ~/.codex 下的任何其他内容。
        let temp = tempfile::tempdir().expect("create temp home");
        fs::create_dir_all(temp.path().join(".codex")).expect("mkdir .codex");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real_sessions, temp.path().join(".codex").join("sessions"))
            .expect("symlink sessions");
        let previous_home = std::env::var_os("CC_SWITCH_TEST_HOME");
        std::env::set_var("CC_SWITCH_TEST_HOME", temp.path());

        clear_codex_replay_caches();
        // CODEX_REPLAY_DISK=1 时用临时 HOME 下的磁盘库：逐行 autocommit 的
        // 主要成本是磁盘 journal fsync，内存库测不出真实写库开销。
        let db = if std::env::var("CODEX_REPLAY_DISK").is_ok() {
            Database::init()?
        } else {
            Database::memory()?
        };
        let start = std::time::Instant::now();
        let result = sync_codex_usage(&db)?;
        let full_elapsed = start.elapsed();
        eprintln!(
            "[REPLAY] full reimport: imported={} skipped={} suspected_dup={} deferred={} files={} errors={} elapsed={:.2?}",
            result.imported,
            result.skipped,
            result.suspected_duplicates,
            result.deferred_files,
            result.files_scanned,
            result.errors.len(),
            full_elapsed
        );

        let start = std::time::Instant::now();
        let steady = sync_codex_usage(&db)?;
        eprintln!(
            "[REPLAY] steady pass: imported={} deferred={} elapsed={:.2?}",
            steady.imported,
            steady.deferred_files,
            start.elapsed()
        );

        if let Ok(out_path) = std::env::var("CODEX_REPLAY_OUT") {
            use std::io::Write;
            let conn = lock_conn!(db.conn);
            let mut stmt = conn
                .prepare(
                    "SELECT request_id, model, request_model, input_tokens, output_tokens,
                            cache_read_tokens, cache_creation_tokens,
                            input_cost_usd, output_cost_usd, cache_read_cost_usd,
                            cache_creation_cost_usd, total_cost_usd,
                            session_id, provider_id, provider_type, status_code,
                            is_streaming, cost_multiplier, created_at, data_source
                     FROM proxy_request_logs
                     WHERE data_source = 'codex_session'
                     ORDER BY request_id",
                )
                .map_err(|e| AppError::Database(e.to_string()))?;
            let rows = stmt
                .query_map([], |row| {
                    let mut fields = Vec::with_capacity(20);
                    for idx in 0..20 {
                        fields.push(match row.get_ref(idx)? {
                            rusqlite::types::ValueRef::Null => "NULL".to_string(),
                            rusqlite::types::ValueRef::Integer(v) => v.to_string(),
                            rusqlite::types::ValueRef::Real(v) => v.to_string(),
                            rusqlite::types::ValueRef::Text(v) => {
                                String::from_utf8_lossy(v).into_owned()
                            }
                            rusqlite::types::ValueRef::Blob(v) => format!("blob:{}", v.len()),
                        });
                    }
                    Ok(fields.join("\t"))
                })
                .map_err(|e| AppError::Database(e.to_string()))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| AppError::Database(e.to_string()))?;
            let mut out = fs::File::create(&out_path).expect("create replay out file");
            for line in &rows {
                writeln!(out, "{line}").expect("write replay row");
            }
            eprintln!("[REPLAY] wrote {} rows to {out_path}", rows.len());
        }

        match previous_home {
            Some(value) => std::env::set_var("CC_SWITCH_TEST_HOME", value),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }
        Ok(())
    }
}
