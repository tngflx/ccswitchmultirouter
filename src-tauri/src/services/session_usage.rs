//! Claude Code 会话日志使用追踪
//!
//! 从 ~/.claude/projects/ 下的 JSONL 会话文件中提取 token 使用数据，
//! 实现无代理模式下的使用统计。
//!
//! ## 数据流
//! ```text
//! ~/.claude/projects/*/*.jsonl → 增量解析 → 去重 → 费用计算 → proxy_request_logs 表
//! ```

use crate::config::get_claude_config_dir;
use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::file_revision::FileRevision;
use crate::proxy::usage::calculator::{CostCalculator, ModelPricing};
use crate::proxy::usage::parser::TokenUsage;
use crate::services::usage_stats::{
    effective_usage_log_filter, find_model_pricing, should_skip_session_insert, DedupKey,
};
use rusqlite::OptionalExtension;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

/// 同步结果
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSyncResult {
    pub imported: u32,
    pub skipped: u32,
    pub files_scanned: u32,
    pub suspected_duplicates: u32,
    pub deferred_files: u32,
    pub errors: Vec<String>,
}

impl SessionSyncResult {
    pub fn merge(&mut self, other: SessionSyncResult) {
        self.imported = self.imported.saturating_add(other.imported);
        self.skipped = self.skipped.saturating_add(other.skipped);
        self.files_scanned = self.files_scanned.saturating_add(other.files_scanned);
        self.suspected_duplicates = self
            .suspected_duplicates
            .saturating_add(other.suspected_duplicates);
        self.deferred_files = self.deferred_files.saturating_add(other.deferred_files);
        self.errors.extend(other.errors);
    }
}

pub fn session_sync_mutex() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// One collector's persisted progress in `session_log_sync`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct SessionSyncCursor {
    pub(crate) last_modified: i64,
    pub(crate) last_line_offset: i64,
    pub(crate) last_byte_offset: Option<i64>,
    pub(crate) last_tail_fingerprint: Option<i64>,
    pub(crate) last_source_revision: Option<i64>,
    pub(crate) deferred_until: Option<i64>,
}

impl SessionSyncCursor {
    pub(crate) fn matches_source_revision(self, revision: Option<i64>, modified: i64) -> bool {
        revision.is_some()
            && revision == self.last_source_revision
            && modified == self.last_modified
    }
}

/// Load the discovered cursors under one lock and one indexed statement.
/// A failed lookup must not trigger a replay from an empty cursor.
pub(crate) fn load_session_sync_cursors(
    db: &Database,
    keys: impl IntoIterator<Item = String>,
) -> Result<HashMap<String, SessionSyncCursor>, AppError> {
    let conn = lock_conn!(db.conn);
    let mut statement = conn
        .prepare_cached(
            "SELECT last_modified, last_line_offset, last_byte_offset, last_tail_fingerprint,
                    last_source_revision, deferred_until
             FROM session_log_sync WHERE file_path = ?1",
        )
        .map_err(|error| AppError::Database(format!("读取会话同步游标失败: {error}")))?;
    let mut cursors = HashMap::new();
    for key in keys {
        let cursor = statement
            .query_row([&key], |row| {
                Ok(SessionSyncCursor {
                    last_modified: row.get(0)?,
                    last_line_offset: row.get(1)?,
                    last_byte_offset: row.get(2)?,
                    last_tail_fingerprint: row.get(3)?,
                    last_source_revision: row.get(4)?,
                    deferred_until: row.get(5)?,
                })
            })
            .optional()
            .map_err(|error| AppError::Database(format!("读取会话同步游标失败: {error}")))?;
        if let Some(cursor) = cursor {
            cursors.insert(key, cursor);
        }
    }
    Ok(cursors)
}

fn merge_sync_step(
    aggregate: &mut SessionSyncResult,
    name: &str,
    step: Result<SessionSyncResult, AppError>,
) {
    match step {
        Ok(result) => aggregate.merge(result),
        Err(error) => aggregate.errors.push(format!("{name} 同步失败: {error}")),
    }
}

/// 调用方必须持有 [`session_sync_mutex`]。此函数是同步内核，供后台任务、
/// 手动同步和 Codex 重建共享，避免 tokio Mutex 重入。
pub fn sync_all_unlocked(db: &Database) -> SessionSyncResult {
    let mut result = SessionSyncResult::default();
    merge_sync_step(&mut result, "Claude", sync_claude_session_logs(db));
    merge_sync_step(
        &mut result,
        "Codex",
        crate::services::session_usage_codex::sync_codex_usage(db),
    );
    merge_sync_step(
        &mut result,
        "Gemini",
        crate::services::session_usage_gemini::sync_gemini_usage(db),
    );
    merge_sync_step(
        &mut result,
        "OpenCode",
        crate::services::session_usage_opencode::sync_opencode_usage(db),
    );
    merge_sync_step(
        &mut result,
        "Grok Build",
        crate::services::session_usage_grokbuild::sync_grokbuild_usage(db),
    );
    merge_sync_step(
        &mut result,
        "Pi",
        crate::services::session_usage_pi::sync_pi_usage(db),
    );
    notify_sync_result(&result);
    result
}

pub(crate) fn notify_sync_result(result: &SessionSyncResult) {
    if result.imported > 0 {
        crate::usage_events::notify_log_recorded();
    }
}

/// 数据来源分布
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSourceSummary {
    pub data_source: String,
    pub request_count: u32,
    pub total_cost_usd: String,
}

/// 从 JSONL 中解析出的 assistant 消息使用数据
#[derive(Debug)]
struct ParsedAssistantUsage {
    message_id: String,
    model: String,
    input_tokens: u32,
    output_tokens: u32,
    cache_read_tokens: u32,
    cache_creation_tokens: u32,
    stop_reason: Option<String>,
    timestamp: Option<String>,
    session_id: Option<String>,
}

/// 同步 Claude Code 会话日志到使用统计数据库
pub fn sync_claude_session_logs(db: &Database) -> Result<SessionSyncResult, AppError> {
    let projects_dir = get_claude_config_dir().join("projects");
    if !projects_dir.exists() {
        return Ok(SessionSyncResult {
            imported: 0,
            skipped: 0,
            files_scanned: 0,
            suspected_duplicates: 0,
            deferred_files: 0,
            errors: vec![],
        });
    }

    let mut result = SessionSyncResult {
        imported: 0,
        skipped: 0,
        files_scanned: 0,
        suspected_duplicates: 0,
        deferred_files: 0,
        errors: vec![],
    };

    // 收集所有 .jsonl 文件
    let jsonl_files = collect_jsonl_files(&projects_dir);
    let keys = jsonl_files
        .iter()
        .map(|path| path.to_string_lossy().into_owned());
    let cursors = load_session_sync_cursors(db, keys)?;

    for file_path in &jsonl_files {
        result.files_scanned += 1;

        let cursor = cursors.get(file_path.to_string_lossy().as_ref());
        match sync_single_file(db, file_path, cursor) {
            Ok(file_sync) => {
                result.imported += file_sync.imported;
                result.skipped += file_sync.skipped;
                if file_sync.incomplete_tail || file_sync.read_error.is_some() {
                    result.deferred_files += 1;
                }
                if let Some(error) = file_sync.read_error {
                    let msg = format!(
                        "{}: 读取中断，已入库部分保留、下轮从断点续读: {error}",
                        file_path.display()
                    );
                    log::warn!("[SESSION-SYNC] {msg}");
                    result.errors.push(msg);
                }
                if let Some(reason) = file_sync.pinned_rewrite {
                    result.errors.push(format!(
                        "{}: 检测到文件被外部{reason}，改写区间已跳过以防重复计数（不会再导入）",
                        file_path.display()
                    ));
                }
            }
            Err(e) => {
                let msg = format!("{}: {e}", file_path.display());
                log::warn!("[SESSION-SYNC] 文件解析失败: {msg}");
                result.errors.push(msg);
            }
        }
    }

    if result.imported > 0 {
        log::info!(
            "[SESSION-SYNC] 同步完成: 导入 {} 条, 跳过 {} 条, 扫描 {} 个文件",
            result.imported,
            result.skipped,
            result.files_scanned
        );
    }

    Ok(result)
}

/// 收集目录下所有 .jsonl 文件（含子 agent 文件）
///
/// 扫描固定深度，不使用递归，避免死循环：
///   projects_dir/项目目录/*.jsonl                                      (主会话)
///   projects_dir/项目目录/SESSION_ID/subagents/*.jsonl                  (Task/Agent 子 agent)
///   projects_dir/项目目录/SESSION_ID/subagents/workflows/wf_*/*.jsonl   (Workflow 子 agent)
///
/// 最后一层是 Claude Code Workflow 功能产生的子 agent transcript，比普通子
/// agent 多嵌套一层 `workflows/wf_<ID>/`。漏掉这一层会让 Workflow 的 token
/// 用量完全不计入统计；`journal.jsonl` 不含 `type=="assistant"` 行，解析时
/// 会被 `sync_single_file` 天然跳过，因此这里无需按文件名过滤。
fn collect_jsonl_files(projects_dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();

    for path in cached_directory_children(projects_dir) {
        if !path.is_dir() {
            continue;
        }
        // 每个项目目录下的 .jsonl 文件
        for sub_path in cached_directory_children(&path) {
            if sub_path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                // 主会话 JSONL 文件
                files.push(sub_path);
            } else if sub_path.is_dir() {
                // 扫描子 agent 目录: 项目/SESSION_ID/subagents/*.jsonl
                let subagents_dir = sub_path.join("subagents");
                if subagents_dir.is_dir() {
                    push_jsonl_children(&subagents_dir, &mut files);

                    // 额外下探 Workflow 子 agent:
                    // 项目/SESSION_ID/subagents/workflows/wf_<ID>/*.jsonl
                    let workflows_dir = subagents_dir.join("workflows");
                    if workflows_dir.is_dir() {
                        for wf_path in cached_directory_children(&workflows_dir) {
                            if wf_path.is_dir() {
                                push_jsonl_children(&wf_path, &mut files);
                            }
                        }
                    }
                }
            }
        }
    }

    files
}

/// 将 `dir` 下直接子层的所有 `.jsonl` 文件追加到 `files`（不递归）。
fn push_jsonl_children(dir: &Path, files: &mut Vec<PathBuf>) {
    for path in cached_directory_children(dir) {
        if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
}

#[derive(Clone)]
struct CachedDirectoryChildren {
    modified: i64,
    length: u64,
    children: Vec<PathBuf>,
}

static CLAUDE_DIRECTORY_CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedDirectoryChildren>>> =
    OnceLock::new();

/// Directory membership changes are much less frequent than session polls.
/// Reuse the discovered child paths while the directory metadata is stable.
/// Individual JSONL files still pass through `FileRevision`, so edits inside a
/// stable directory remain visible to the incremental parser.
fn cached_directory_children(dir: &Path) -> Vec<PathBuf> {
    let metadata = match fs::metadata(dir) {
        Ok(metadata) => metadata,
        Err(_) => return Vec::new(),
    };
    let modified = metadata_modified_nanos(&metadata);
    let length = metadata.len();
    let cache = CLAUDE_DIRECTORY_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut cache = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(cached) = cache.get(dir) {
        if cached.modified == modified && cached.length == length {
            return cached.children.clone();
        }
    }
    #[cfg(test)]
    CLAUDE_DIRECTORY_READS.with(|count| count.set(count.get() + 1));
    let children: Vec<PathBuf> = match fs::read_dir(dir) {
        Ok(entries) => entries.flatten().map(|entry| entry.path()).collect(),
        Err(_) => return Vec::new(),
    };
    if cache.len() >= 2048 {
        cache.clear();
    }
    cache.insert(
        dir.to_path_buf(),
        CachedDirectoryChildren {
            modified,
            length,
            children: children.clone(),
        },
    );
    children
}

#[derive(Debug, Default)]
struct ClaudeFileSync {
    imported: u32,
    skipped: u32,
    incomplete_tail: bool,
    read_error: Option<String>,
    pinned_rewrite: Option<&'static str>,
}

const CLAUDE_TAIL_FINGERPRINT_BYTES: i64 = 4096;

#[cfg(test)]
thread_local! {
    static CLAUDE_TAIL_READ_BYTES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static CLAUDE_PARSED_BYTES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static CLAUDE_DIRECTORY_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn claude_tail_fingerprint(tail: &[u8]) -> i64 {
    let mut hasher = Sha256::new();
    hasher.update(b"claude-session-tail-v1");
    hasher.update(tail);
    let digest = hasher.finalize();
    i64::from(u32::from_be_bytes(
        digest[..4].try_into().unwrap_or_default(),
    ))
}

/// 读取 `end` 之前的尾部指纹窗口，返回时文件位置恰好位于 `end`。
fn read_claude_tail_before(file: &mut fs::File, end: i64) -> Result<Vec<u8>, AppError> {
    let len = end.clamp(0, CLAUDE_TAIL_FINGERPRINT_BYTES);
    let mut tail = vec![0u8; len as usize];
    file.seek(SeekFrom::Start((end - len) as u64))
        .map_err(|e| AppError::Config(format!("无法定位 Claude 会话文件偏移: {e}")))?;
    if len > 0 {
        file.read_exact(&mut tail)
            .map_err(|e| AppError::Config(format!("无法读取 Claude 游标边界尾部: {e}")))?;
    }
    #[cfg(test)]
    CLAUDE_TAIL_READ_BYTES.with(|count| count.set(count.get() + tail.len()));
    Ok(tail)
}

fn push_claude_committed_tail(tail: &mut Vec<u8>, bytes: &[u8]) {
    tail.extend_from_slice(bytes);
    let max = CLAUDE_TAIL_FINGERPRINT_BYTES as usize;
    if tail.len() > max {
        tail.drain(..tail.len() - max);
    }
}

/// 同步单个 Claude JSONL 文件。
///
/// 字节游标只越过以换行符结束的完整记录。旧行号游标会先转换到对应字节
/// 边界，不回放已经处理的历史。检测到截断或游标前尾部被改写时，将游标
/// 钉到当前 EOF，避免 rollup/prune 后已无明细去重证据的历史被重复累计。
fn sync_single_file(
    db: &Database,
    file_path: &Path,
    cursor: Option<&SessionSyncCursor>,
) -> Result<ClaudeFileSync, AppError> {
    let file_path_str = file_path.to_string_lossy().to_string();

    let mut file =
        fs::File::open(file_path).map_err(|e| AppError::Config(format!("无法打开文件: {e}")))?;
    let metadata = file
        .metadata()
        .map_err(|e| AppError::Config(format!("无法读取文件元数据: {e}")))?;
    let file_modified = metadata_modified_nanos(&metadata);
    let file_size = metadata.len() as i64;
    let revision = FileRevision::from_file_metadata(&file, &metadata);
    let revision_fingerprint = revision.map(|revision| revision.fingerprint());

    let last_modified = cursor.map_or(0, |value| value.last_modified);
    let last_byte_offset = cursor.and_then(|value| value.last_byte_offset);
    let last_fingerprint = cursor.and_then(|value| value.last_tail_fingerprint);

    if let Some(cursor) =
        cursor.filter(|cursor| cursor.matches_source_revision(revision_fingerprint, file_modified))
    {
        return Ok(ClaudeFileSync {
            incomplete_tail: cursor
                .last_byte_offset
                .is_some_and(|offset| offset < file_size),
            ..Default::default()
        });
    }

    let (start_byte, legacy_lines, mut tail_bytes) = match last_byte_offset {
        Some(offset) => {
            let truncated = !(0..=file_size).contains(&offset);
            let seed = if truncated {
                None
            } else {
                Some(read_claude_tail_before(&mut file, offset)?)
            };
            let rewritten = match (&seed, last_fingerprint) {
                (Some(bytes), Some(expected)) => claude_tail_fingerprint(bytes) != expected,
                _ => false,
            };
            if truncated || rewritten {
                let reason = if truncated { "截断" } else { "重写" };
                log::warn!(
                    "[SESSION-SYNC] Claude 会话文件被外部{reason}，游标钉至 EOF、不重放旧区间: {}",
                    file_path.display()
                );
                let tail = read_claude_tail_before(&mut file, file_size)?;
                let fingerprint = claude_tail_fingerprint(&tail);
                if revision.is_some() && FileRevision::read(file_path) != revision {
                    return Err(AppError::Config(
                        "Claude session changed during read".into(),
                    ));
                }
                let conn = lock_conn!(db.conn);
                write_session_sync_cursor(
                    &conn,
                    &file_path_str,
                    SessionSyncCursor {
                        last_modified: file_modified,
                        last_byte_offset: Some(file_size),
                        last_tail_fingerprint: Some(fingerprint),
                        last_source_revision: revision_fingerprint,
                        ..Default::default()
                    },
                )?;
                return Ok(ClaudeFileSync {
                    pinned_rewrite: Some(reason),
                    ..Default::default()
                });
            }
            if revision.is_none() && offset == file_size && file_modified <= last_modified {
                return Ok(ClaudeFileSync::default());
            }
            (offset, 0, seed.unwrap_or_default())
        }
        None => (
            0,
            cursor.map_or(0, |value| value.last_line_offset.max(0)),
            Vec::new(),
        ),
    };

    let mut reader = BufReader::new(file);
    let mut committed_offset = start_byte;
    let mut incomplete_tail = false;
    let mut buffer = Vec::new();

    // 旧游标的前 L 行只转换字节位置，不重新解析或导入。
    let mut skipped_legacy_lines = 0;
    while skipped_legacy_lines < legacy_lines {
        buffer.clear();
        let read = reader
            .read_until(b'\n', &mut buffer)
            .map_err(|e| AppError::Config(format!("转换 Claude 旧行号游标失败: {e}")))?;
        if read == 0 {
            break;
        }
        push_claude_committed_tail(&mut tail_bytes, &buffer);
        committed_offset += read as i64;
        skipped_legacy_lines += 1;
    }

    let mut read_error = None;
    let mut messages: HashMap<String, ParsedAssistantUsage> = HashMap::new();
    let mut current_session_id: Option<String> = None;

    loop {
        buffer.clear();
        let read = match reader.read_until(b'\n', &mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) => {
                read_error = Some(error.to_string());
                break;
            }
        };
        if buffer.ends_with(b"\n") {
            push_claude_committed_tail(&mut tail_bytes, &buffer);
            committed_offset += read as i64;
        } else {
            incomplete_tail = true;
        }

        if buffer.iter().all(u8::is_ascii_whitespace) {
            continue;
        }

        #[cfg(test)]
        CLAUDE_PARSED_BYTES.with(|count| count.set(count.get() + buffer.len()));
        let value: serde_json::Value = match serde_json::from_slice(&buffer) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // 提取 session ID (从 system 或首条消息)
        if current_session_id.is_none() {
            if let Some(sid) = value.get("sessionId").and_then(|v| v.as_str()) {
                current_session_id = Some(sid.to_string());
            }
        }

        // 只处理 assistant 类型的消息
        if value.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }

        let message = match value.get("message") {
            Some(m) => m,
            None => continue,
        };

        let msg_id = match message.get("id").and_then(|v| v.as_str()) {
            Some(id) => id.to_string(),
            None => continue,
        };

        let usage = match message.get("usage") {
            Some(u) => u,
            None => continue,
        };

        let parsed = ParsedAssistantUsage {
            message_id: msg_id.clone(),
            model: message
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string(),
            input_tokens: usage
                .get("input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32,
            output_tokens: usage
                .get("output_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32,
            cache_read_tokens: usage
                .get("cache_read_input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32,
            cache_creation_tokens: usage
                .get("cache_creation_input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32,
            stop_reason: message
                .get("stop_reason")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            timestamp: value
                .get("timestamp")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            session_id: current_session_id.clone(),
        };

        // 按 message.id 去重：优先保留有 stop_reason 的条目，否则保留最新的
        let should_replace = match messages.get(&msg_id) {
            None => true,
            Some(existing) => {
                // 新条目有 stop_reason 而旧条目没有 → 替换
                if parsed.stop_reason.is_some() && existing.stop_reason.is_none() {
                    true
                }
                // 两个都有或都没有 stop_reason → 取 output_tokens 更大的
                else if parsed.stop_reason.is_some() == existing.stop_reason.is_some() {
                    parsed.output_tokens > existing.output_tokens
                } else {
                    false
                }
            }
        };

        if should_replace {
            messages.insert(msg_id, parsed);
        }
    }

    if revision.is_some() && FileRevision::read(file_path) != revision {
        return Err(AppError::Config(
            "Claude session changed during read".into(),
        ));
    }
    let mut imported: u32 = 0;
    let mut skipped: u32 = 0;
    let conn = lock_conn!(db.conn);
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AppError::Database(format!("启动 Claude 会话用量导入事务失败: {e}")))?;

    for msg in messages.values() {
        // 只要产生了真实计费 token 就导入，不再强制要求 stop_reason 或 output>0。
        //
        // Anthropic 在受理请求时即对 input + cache_read + cache_creation 计费
        // （这些在请求开始就确定），output 按实际生成量计。Workflow / 子 agent 的
        // 并行短命请求经常只写了 message_start 快照（output=1、stop_reason=None）
        // 却没有写最终块，但其 cache/input 成本已被真实计费。旧逻辑用 stop_reason
        // 非空 + output>0 双重过滤，会把这类请求整条丢弃，实测系统性低估约 4.1%，
        // 且 92% 集中在 workflow/subagent。这里改为「任一计费维度 > 0 即导入」。
        //
        // 去重选择逻辑（上方按 message.id 取 stop_reason 优先 / output 最大者）保持
        // 不变：它选出的代表行的 input/cache 本就准确；request_id = session:msg_id
        // 主键 + INSERT OR IGNORE 保证一个 message 仍只落库一次，放宽 gate 不会双算。
        let has_billable_tokens = msg.input_tokens > 0
            || msg.output_tokens > 0
            || msg.cache_read_tokens > 0
            || msg.cache_creation_tokens > 0;
        if !has_billable_tokens {
            continue;
        }

        let request_id = format!(
            "{}{}",
            crate::proxy::usage::parser::SESSION_REQUEST_ID_PREFIX,
            msg.message_id
        );

        match insert_session_log_entry_on_conn(&tx, &request_id, msg) {
            Ok(true) => imported += 1,
            Ok(false) => skipped += 1,
            Err(e) => {
                log::warn!("[SESSION-SYNC] 插入失败 ({}): {e}", msg.message_id);
                skipped += 1;
            }
        }
    }

    // 读取错误时保留旧 mtime，确保下一轮从已提交的字节边界续读。
    let stamped_modified = if read_error.is_some() {
        last_modified
    } else {
        file_modified
    };
    let fingerprint = claude_tail_fingerprint(&tail_bytes);
    write_session_sync_cursor(
        &tx,
        &file_path_str,
        SessionSyncCursor {
            last_modified: stamped_modified,
            last_byte_offset: Some(committed_offset),
            last_tail_fingerprint: Some(fingerprint),
            last_source_revision: revision_fingerprint.filter(|_| read_error.is_none()),
            ..Default::default()
        },
    )?;
    tx.commit()
        .map_err(|e| AppError::Database(format!("提交 Claude 会话用量导入事务失败: {e}")))?;

    Ok(ClaudeFileSync {
        imported,
        skipped,
        incomplete_tail,
        read_error,
        pinned_rewrite: None,
    })
}

pub(crate) fn write_session_sync_cursor(
    conn: &rusqlite::Connection,
    file_path: &str,
    cursor: SessionSyncCursor,
) -> Result<(), AppError> {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);

    conn.prepare_cached(
        "INSERT OR REPLACE INTO session_log_sync
             (file_path, last_modified, last_line_offset, last_synced_at, last_byte_offset,
              last_tail_fingerprint, last_source_revision, deferred_until)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .and_then(|mut statement| {
        statement.execute(rusqlite::params![
            file_path,
            cursor.last_modified,
            cursor.last_line_offset,
            now,
            cursor.last_byte_offset,
            cursor.last_tail_fingerprint,
            cursor.last_source_revision,
            cursor.deferred_until
        ])
    })
    .map_err(|e| AppError::Database(format!("更新会话同步状态失败: {e}")))?;
    Ok(())
}

/// Read the legacy progress fields in import regressions.
#[cfg(test)]
pub(crate) fn get_sync_state(db: &Database, file_path: &str) -> Result<(i64, i64), AppError> {
    let conn = lock_conn!(db.conn);
    let result = conn.query_row(
        "SELECT last_modified, last_line_offset FROM session_log_sync WHERE file_path = ?1",
        rusqlite::params![file_path],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    );
    Ok(result.unwrap_or((0, 0)))
}

/// 返回文件 mtime 的纳秒时间戳。
///
/// `session_log_sync.last_modified` 旧数据是秒级时间戳；新写入纳秒值不需要
/// schema 迁移，旧值会自然触发一次增量重扫，并继续依赖行 offset 避免重复导入。
pub(crate) fn metadata_modified_nanos(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

/// 更新 session_log_sync 表中某条目的同步进度。
///
/// Shared by all session_usage_* parsers.
pub(crate) fn update_sync_state(
    db: &Database,
    file_path: &str,
    last_modified: i64,
    last_offset: i64,
) -> Result<(), AppError> {
    let conn = lock_conn!(db.conn);
    update_sync_state_on_conn(&conn, file_path, last_modified, last_offset)
}

/// [`update_sync_state`] 的免锁版本，供调用方在已持锁的事务内把游标推进
/// 与数据插入绑成原子提交。
pub(crate) fn update_sync_state_on_conn(
    conn: &rusqlite::Connection,
    file_path: &str,
    last_modified: i64,
    last_offset: i64,
) -> Result<(), AppError> {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    conn.prepare_cached(
        "INSERT OR REPLACE INTO session_log_sync (file_path, last_modified, last_line_offset, last_synced_at)
         VALUES (?1, ?2, ?3, ?4)",
    )
    .and_then(|mut stmt| stmt.execute(rusqlite::params![file_path, last_modified, last_offset, now]))
    .map_err(|e| AppError::Database(format!("更新同步状态失败: {e}")))?;
    Ok(())
}

/// 插入单条会话日志到 proxy_request_logs，返回是否成功插入。
/// 调用方持有数据库连接锁，Claude 扫描借此将数据与游标放进同一事务。
fn insert_session_log_entry_on_conn(
    conn: &rusqlite::Connection,
    request_id: &str,
    msg: &ParsedAssistantUsage,
) -> Result<bool, AppError> {
    let created_at = msg
        .timestamp
        .as_ref()
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
        app_type: "claude",
        model: &msg.model,
        input_tokens: msg.input_tokens,
        output_tokens: msg.output_tokens,
        cache_read_tokens: msg.cache_read_tokens,
        cache_creation_tokens: msg.cache_creation_tokens,
        created_at,
    };
    if should_skip_session_insert(conn, request_id, &dedup_key)? {
        return Ok(false);
    }

    // 计算费用
    let usage = TokenUsage {
        input_tokens: msg.input_tokens,
        output_tokens: msg.output_tokens,
        cache_read_tokens: msg.cache_read_tokens,
        cache_creation_tokens: msg.cache_creation_tokens,
        model: Some(msg.model.clone()),
        message_id: None,
    };

    let pricing = find_model_pricing_for_session(conn, &msg.model);
    let multiplier = Decimal::from(1);
    let (input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost) = match pricing
    {
        Some(p) => {
            let cost = CostCalculator::calculate(&usage, &p, multiplier);
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
        .execute(
            "INSERT OR IGNORE INTO proxy_request_logs (
            request_id, provider_id, app_type, model, request_model,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
            input_cost_usd, output_cost_usd, cache_read_cost_usd, cache_creation_cost_usd, total_cost_usd,
            latency_ms, first_token_ms, status_code, error_message, session_id,
            provider_type, is_streaming, cost_multiplier, created_at, data_source
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)",
            rusqlite::params![
                request_id,
                "_session",         // provider_id: 标记为会话来源
                "claude",           // app_type
                msg.model,
                msg.model,          // request_model = model
                msg.input_tokens,
                msg.output_tokens,
                msg.cache_read_tokens,
                msg.cache_creation_tokens,
                input_cost,
                output_cost,
                cache_read_cost,
                cache_creation_cost,
                total_cost,
                0i64,               // latency_ms: 会话日志无此数据
                Option::<i64>::None, // first_token_ms
                200i64,             // status_code: 会话日志中的请求只要产生计费 token 即视为成功
                Option::<String>::None, // error_message
                msg.session_id,
                Some("session_log"), // provider_type
                1i64,               // is_streaming: Claude Code 通常使用流式
                "1.0",              // cost_multiplier
                created_at,
                "session_log",      // data_source
            ],
        )
        .map_err(|e| AppError::Database(format!("插入会话日志失败: {e}")))?;

    Ok(inserted_rows > 0)
}

#[cfg(test)]
fn insert_session_log_entry(
    db: &Database,
    request_id: &str,
    msg: &ParsedAssistantUsage,
) -> Result<bool, AppError> {
    let conn = lock_conn!(db.conn);
    insert_session_log_entry_on_conn(&conn, request_id, msg)
}

/// 从 model_pricing 表查找模型定价（支持模糊匹配）
fn find_model_pricing_for_session(
    conn: &rusqlite::Connection,
    model_id: &str,
) -> Option<ModelPricing> {
    find_model_pricing(conn, model_id)
}

/// 查询数据来源分布统计
pub fn get_data_source_breakdown(db: &Database) -> Result<Vec<DataSourceSummary>, AppError> {
    let conn = lock_conn!(db.conn);

    let effective_filter = effective_usage_log_filter("l");
    let sql = format!(
        "SELECT COALESCE(l.data_source, 'proxy') as ds, COUNT(*) as cnt,
                COALESCE(SUM(CAST(l.total_cost_usd AS REAL)), 0) as cost
         FROM proxy_request_logs l
         WHERE {effective_filter}
         GROUP BY ds
         ORDER BY cnt DESC"
    );

    let mut stmt = conn.prepare(&sql)?;

    let rows = stmt.query_map([], |row| {
        Ok(DataSourceSummary {
            data_source: row.get(0)?,
            request_count: row.get::<_, i64>(1)? as u32,
            total_cost_usd: format!("{:.6}", row.get::<_, f64>(2)?),
        })
    })?;

    let mut summaries = Vec::new();
    for row in rows {
        summaries.push(row.map_err(|e| AppError::Database(e.to_string()))?);
    }

    Ok(summaries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upstream_session_cursor_assistant_line(message_id: &str, output_tokens: u32) -> String {
        format!(
            r#"{{"type":"assistant","message":{{"id":"{message_id}","model":"claude-opus-4-8","usage":{{"input_tokens":10,"output_tokens":{output_tokens},"cache_read_input_tokens":100,"cache_creation_input_tokens":50}},"stop_reason":"end_turn"}},"timestamp":"2026-06-07T13:01:23Z","sessionId":"session-x"}}"#
        )
    }

    fn upstream_session_cursor_bump_mtime(path: &Path) {
        let later = SystemTime::now() + std::time::Duration::from_secs(2);
        let file = fs::OpenOptions::new().append(true).open(path).unwrap();
        file.set_times(fs::FileTimes::new().set_modified(later))
            .unwrap();
    }

    fn sync_claude_test_file(db: &Database, path: &Path) -> Result<ClaudeFileSync, AppError> {
        let cursors = load_session_sync_cursors(db, [path.to_string_lossy().into_owned()])?;
        let cursor = cursors.get(path.to_string_lossy().as_ref()).copied();
        sync_single_file(db, path, cursor.as_ref())
    }

    #[test]
    fn sync_result_notification_is_coalesced_to_one_call() {
        crate::usage_events::take_test_notify_count();
        notify_sync_result(&SessionSyncResult::default());
        let result = SessionSyncResult {
            imported: 25,
            ..SessionSyncResult::default()
        };
        notify_sync_result(&result);
        assert_eq!(crate::usage_events::take_test_notify_count(), 1);
    }

    #[tokio::test]
    async fn session_sync_mutex_serializes_callers() {
        let first = session_sync_mutex().lock().await;
        assert!(session_sync_mutex().try_lock().is_err());
        drop(first);
        assert!(session_sync_mutex().try_lock().is_ok());
    }

    #[test]
    fn test_parse_usage_from_jsonl_line() {
        let line = r#"{"type":"assistant","message":{"id":"msg_test123","model":"claude-opus-4-6","usage":{"input_tokens":3,"output_tokens":150,"cache_read_input_tokens":5000,"cache_creation_input_tokens":10000},"stop_reason":"end_turn"},"timestamp":"2026-04-05T12:00:00Z","sessionId":"session-abc"}"#;

        let value: serde_json::Value = serde_json::from_str(line).unwrap();
        assert_eq!(
            value.get("type").and_then(|t| t.as_str()),
            Some("assistant")
        );

        let message = value.get("message").unwrap();
        let usage = message.get("usage").unwrap();

        assert_eq!(usage.get("input_tokens").unwrap().as_u64().unwrap(), 3);
        assert_eq!(usage.get("output_tokens").unwrap().as_u64().unwrap(), 150);
        assert_eq!(
            usage
                .get("cache_read_input_tokens")
                .unwrap()
                .as_u64()
                .unwrap(),
            5000
        );
        assert_eq!(
            usage
                .get("cache_creation_input_tokens")
                .unwrap()
                .as_u64()
                .unwrap(),
            10000
        );
        assert_eq!(
            message.get("stop_reason").unwrap().as_str().unwrap(),
            "end_turn"
        );
    }

    #[test]
    fn test_dedup_by_message_id() {
        // 同一个 message.id 有多条，应该取 stop_reason 有值的那条
        let mut messages: HashMap<String, ParsedAssistantUsage> = HashMap::new();

        // 中间条目（无 stop_reason）
        let intermediate = ParsedAssistantUsage {
            message_id: "msg_1".to_string(),
            model: "claude-opus-4-6".to_string(),
            input_tokens: 3,
            output_tokens: 26,
            cache_read_tokens: 5000,
            cache_creation_tokens: 10000,
            stop_reason: None,
            timestamp: Some("2026-04-05T12:00:00Z".to_string()),
            session_id: None,
        };
        messages.insert("msg_1".to_string(), intermediate);

        // 最终条目（有 stop_reason）
        let final_entry = ParsedAssistantUsage {
            message_id: "msg_1".to_string(),
            model: "claude-opus-4-6".to_string(),
            input_tokens: 3,
            output_tokens: 1349,
            cache_read_tokens: 5000,
            cache_creation_tokens: 10000,
            stop_reason: Some("end_turn".to_string()),
            timestamp: Some("2026-04-05T12:00:00Z".to_string()),
            session_id: None,
        };

        // 应该替换
        let should_replace = final_entry.stop_reason.is_some()
            && messages.get("msg_1").unwrap().stop_reason.is_none();
        assert!(should_replace);

        messages.insert("msg_1".to_string(), final_entry);
        assert_eq!(messages.get("msg_1").unwrap().output_tokens, 1349);
    }

    #[test]
    fn test_insert_claude_session_skips_matching_proxy_log() -> Result<(), AppError> {
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
                    "proxy-different-id",
                    "openai-compatible",
                    "claude",
                    "claude-sonnet-4-5",
                    "claude-sonnet-4-5",
                    100,
                    20,
                    10,
                    5,
                    "0.10",
                    100,
                    200,
                    1000,
                    "proxy"
                ],
            )?;
        }

        let msg = ParsedAssistantUsage {
            message_id: "msg_1".to_string(),
            model: "claude-sonnet-4-5".to_string(),
            input_tokens: 100,
            output_tokens: 20,
            cache_read_tokens: 10,
            cache_creation_tokens: 5,
            stop_reason: Some("end_turn".to_string()),
            timestamp: Some("1970-01-01T00:16:45Z".to_string()),
            session_id: Some("session-1".to_string()),
        };

        let inserted = insert_session_log_entry(&db, "session:msg_1", &msg)?;
        assert!(!inserted);

        let conn = lock_conn!(db.conn);
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM proxy_request_logs", [], |row| {
            row.get(0)
        })?;
        assert_eq!(count, 1);

        Ok(())
    }

    #[test]
    fn test_collect_jsonl_files_includes_subagents() {
        let tmp = std::env::temp_dir().join(format!("cc-switch-test-{}", uuid::Uuid::new_v4()));
        let project = tmp.join("project");
        let session_dir = project.join("test-session");
        let subagents_dir = session_dir.join("subagents");
        fs::create_dir_all(&subagents_dir).unwrap();

        fs::write(project.join("main.jsonl"), "{}").unwrap();
        fs::write(subagents_dir.join("agent-abc.jsonl"), "{}").unwrap();

        let files = collect_jsonl_files(&tmp);
        assert_eq!(files.len(), 2);
        let paths: Vec<String> = files
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        assert!(paths.iter().any(|p| p.contains("main.jsonl")));
        assert!(paths.iter().any(|p| p.contains("agent-abc.jsonl")));

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn collect_jsonl_files_reuses_unchanged_directory_listings() {
        let tmp = std::env::temp_dir().join(format!("cc-switch-test-{}", uuid::Uuid::new_v4()));
        let project = tmp.join("project");
        let session_dir = project.join("session");
        let subagents_dir = session_dir.join("subagents");
        let workflow_dir = subagents_dir.join("workflows").join("wf_test");
        fs::create_dir_all(&workflow_dir).unwrap();
        fs::write(project.join("main.jsonl"), "{}\n").unwrap();
        fs::write(subagents_dir.join("agent.jsonl"), "{}\n").unwrap();
        fs::write(workflow_dir.join("agent.jsonl"), "{}\n").unwrap();

        CLAUDE_DIRECTORY_READS.with(|count| count.set(0));
        let first = collect_jsonl_files(&tmp);
        let first_reads = CLAUDE_DIRECTORY_READS.with(std::cell::Cell::get);
        let second = collect_jsonl_files(&tmp);
        let second_reads = CLAUDE_DIRECTORY_READS.with(std::cell::Cell::get) - first_reads;

        assert_eq!(first.len(), 3);
        assert_eq!(second, first);
        assert_eq!(first_reads, 6);
        assert_eq!(second_reads, 0);

        fs::write(project.join("new-session.jsonl"), "{}\n").unwrap();
        let third = collect_jsonl_files(&tmp);
        assert_eq!(
            third.len(),
            4,
            "new files must invalidate the directory cache"
        );
        assert!(third.iter().any(|path| path.ends_with("new-session.jsonl")));

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn test_collect_jsonl_files_includes_workflow_subagents() {
        // Claude Code Workflow 把子 agent transcript 嵌在
        // 项目/SESSION_ID/subagents/workflows/wf_<ID>/ 下，比普通子 agent 深一层。
        let tmp = std::env::temp_dir().join(format!("cc-switch-test-{}", uuid::Uuid::new_v4()));
        let project = tmp.join("project");
        let session_dir = project.join("test-session");
        let subagents_dir = session_dir.join("subagents");
        let wf_dir = subagents_dir.join("workflows").join("wf_test123");
        fs::create_dir_all(&wf_dir).unwrap();

        fs::write(project.join("main.jsonl"), "{}").unwrap();
        fs::write(subagents_dir.join("agent-plain.jsonl"), "{}").unwrap();
        fs::write(wf_dir.join("agent-wf.jsonl"), "{}").unwrap();
        // journal.jsonl 也会被收集，但解析时因无 assistant 行而产出 0 条
        fs::write(wf_dir.join("journal.jsonl"), "{}").unwrap();

        let files = collect_jsonl_files(&tmp);
        let paths: Vec<String> = files
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();

        // 主会话 + 普通子 agent + Workflow 子 agent(agent-wf + journal) = 4
        assert_eq!(files.len(), 4);
        assert!(paths.iter().any(|p| p.contains("main.jsonl")));
        assert!(paths.iter().any(|p| p.contains("agent-plain.jsonl")));
        assert!(
            paths.iter().any(|p| p.contains("agent-wf.jsonl")),
            "Workflow 子 agent transcript 必须被收集"
        );

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn test_sync_imports_billable_message_without_stop_reason() -> Result<(), AppError> {
        // 回归：stop_reason 缺失但有真实 cache/input 成本的 message（Workflow /
        // 子 agent 常见的「只有 message_start 快照、没写最终块」形态）必须被计入，
        // 不能因缺 stop_reason 或 output==0 而整条丢弃；全 0 token 的占位行仍应跳过。
        let db = Database::memory()?;
        let tmp = std::env::temp_dir().join(format!("cc-switch-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("agent-wf.jsonl");

        // 第一行：无 stop_reason、output=1，但 cache_read/cache_creation 很大 → 应导入
        // 第二行：全部 token 为 0 → 应跳过（无计费意义）
        let billable = r#"{"type":"assistant","message":{"id":"msg_nostop","model":"claude-opus-4-8","usage":{"input_tokens":2,"output_tokens":1,"cache_read_input_tokens":48719,"cache_creation_input_tokens":2061}},"timestamp":"2026-06-07T13:01:23Z","sessionId":"session-wf"}"#;
        let empty = r#"{"type":"assistant","message":{"id":"msg_empty","model":"claude-opus-4-8","usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}},"timestamp":"2026-06-07T13:01:24Z","sessionId":"session-wf"}"#;
        fs::write(&file, format!("{billable}\n{empty}\n")).unwrap();

        let file_sync = sync_claude_test_file(&db, &file)?;
        assert_eq!(
            file_sync.imported, 1,
            "有 cache 成本但无 stop_reason 的 message 必须被导入"
        );

        let conn = lock_conn!(db.conn);
        let cache_read: i64 = conn.query_row(
            "SELECT cache_read_tokens FROM proxy_request_logs WHERE request_id = 'session:msg_nostop'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(cache_read, 48719, "cache_read 必须被完整记录");
        let empty_exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM proxy_request_logs WHERE request_id = 'session:msg_empty')",
            [],
            |row| row.get(0),
        )?;
        assert!(!empty_exists, "全 0 token 的 message 应被跳过");
        drop(conn);

        fs::remove_dir_all(&tmp).ok();
        Ok(())
    }

    #[test]
    fn upstream_session_cursor_partial_line_is_imported_after_completion() -> Result<(), AppError> {
        let db = Database::memory()?;
        let tmp = std::env::temp_dir().join(format!("cc-switch-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("session.jsonl");
        let first_line = format!(
            "{}\n",
            upstream_session_cursor_assistant_line("msg_complete", 5)
        );
        let second_line = upstream_session_cursor_assistant_line("msg_partial", 6);
        let (head, tail) = second_line.split_at(second_line.len() / 2);
        fs::write(&file, format!("{first_line}{head}")).unwrap();

        let first_sync = sync_claude_test_file(&db, &file)?;
        assert_eq!(first_sync.imported, 1);

        let mut content = fs::read(&file).unwrap();
        content.extend_from_slice(format!("{tail}\n").as_bytes());
        fs::write(&file, content).unwrap();
        upstream_session_cursor_bump_mtime(&file);

        let second_sync = sync_claude_test_file(&db, &file)?;
        assert_eq!(second_sync.imported, 1, "补全后的半行不能被旧行号游标跳过");

        fs::remove_dir_all(&tmp).ok();
        Ok(())
    }

    #[test]
    fn upstream_session_cursor_unchanged_incomplete_tail_does_no_content_work(
    ) -> Result<(), AppError> {
        let temp = tempfile::tempdir().unwrap();
        for padding in [16, 256 * 1024] {
            let db = Database::memory()?;
            let path = temp.path().join(format!("session-{padding}.jsonl"));
            let first = upstream_session_cursor_assistant_line("msg_first", 4);
            let pending = upstream_session_cursor_assistant_line("msg_pending", 6);
            let prefix = format!("{first}\n");
            let incomplete = format!(r#"{{"padding":"{}","#, "x".repeat(padding));
            let rest = pending.strip_prefix('{').unwrap();
            fs::write(&path, format!("{prefix}{incomplete}")).unwrap();
            if FileRevision::read(&path).is_none() {
                continue;
            }
            assert_eq!(sync_claude_test_file(&db, &path)?.imported, 1);
            CLAUDE_TAIL_READ_BYTES.with(|count| count.set(0));
            CLAUDE_PARSED_BYTES.with(|count| count.set(0));

            for _ in 0..8 {
                let sync = sync_claude_test_file(&db, &path)?;
                assert_eq!((sync.imported, sync.skipped), (0, 0));
                assert!(sync.incomplete_tail);
            }
            assert_eq!(CLAUDE_TAIL_READ_BYTES.with(std::cell::Cell::get), 0);
            assert_eq!(CLAUDE_PARSED_BYTES.with(std::cell::Cell::get), 0);

            let suffix = format!("{incomplete}{rest}\n");
            fs::write(&path, format!("{prefix}{suffix}")).unwrap();
            let sync = sync_claude_test_file(&db, &path)?;
            assert_eq!((sync.imported, sync.skipped), (1, 0));
            assert!(!sync.incomplete_tail);
            assert_eq!(
                CLAUDE_TAIL_READ_BYTES.with(std::cell::Cell::get),
                prefix.len()
            );
            assert_eq!(CLAUDE_PARSED_BYTES.with(std::cell::Cell::get), suffix.len());
        }
        Ok(())
    }

    #[test]
    fn upstream_session_cursor_rewrite_with_growth_does_not_import_rewritten_range(
    ) -> Result<(), AppError> {
        let db = Database::memory()?;
        let tmp = std::env::temp_dir().join(format!("cc-switch-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("session.jsonl");
        fs::write(
            &file,
            format!(
                "{}\n",
                upstream_session_cursor_assistant_line("msg_original", 5)
            ),
        )
        .unwrap();
        assert_eq!(sync_claude_test_file(&db, &file)?.imported, 1);

        fs::write(
            &file,
            format!(
                "{}\n{}\n",
                upstream_session_cursor_assistant_line("msg_rewrite0", 5),
                upstream_session_cursor_assistant_line("msg_rewrite1", 6)
            ),
        )
        .unwrap();
        upstream_session_cursor_bump_mtime(&file);

        let rewrite_sync = sync_claude_test_file(&db, &file)?;
        assert_eq!(
            rewrite_sync.imported, 0,
            "检测到非追加改写后必须钉住 EOF，不能导入改写区间"
        );
        assert_eq!(rewrite_sync.pinned_rewrite, Some("重写"));

        fs::remove_dir_all(&tmp).ok();
        Ok(())
    }

    #[test]
    fn upstream_session_cursor_equal_timestamp_keeps_append_and_rewrite_recovery(
    ) -> Result<(), AppError> {
        let db = Database::memory()?;
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("session.jsonl");
        let original = upstream_session_cursor_assistant_line("msg_old", 5);
        let appended = upstream_session_cursor_assistant_line("msg_app", 6);
        fs::write(&path, format!("{original}\n")).unwrap();
        let stamp = fs::metadata(&path).unwrap().modified().unwrap();
        let restore_stamp = || {
            fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(stamp))
                .unwrap();
        };
        assert_eq!(sync_claude_test_file(&db, &path)?.imported, 1);
        fs::write(&path, format!("{original}\n{appended}\n")).unwrap();
        restore_stamp();
        let next = sync_claude_test_file(&db, &path)?;
        assert_eq!((next.imported, next.skipped), (1, 0));
        let rewritten = upstream_session_cursor_assistant_line("msg_new", 7);
        fs::write(&path, format!("{original}\n{rewritten}\n")).unwrap();
        restore_stamp();
        let next = sync_claude_test_file(&db, &path)?;
        assert_eq!(next.imported, 0);
        assert_eq!(next.pinned_rewrite, Some("重写"));
        Ok(())
    }

    #[test]
    fn upstream_session_cursor_append_reads_only_new_suffix() -> Result<(), AppError> {
        let db = Database::memory()?;
        let tmp = std::env::temp_dir().join(format!("cc-switch-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("session.jsonl");
        fs::write(
            &file,
            format!(
                "{}\n{}\n",
                upstream_session_cursor_assistant_line("msg_a", 5),
                upstream_session_cursor_assistant_line("msg_b", 6)
            ),
        )
        .unwrap();
        let first = sync_claude_test_file(&db, &file)?;
        assert_eq!((first.imported, first.skipped), (2, 0));

        let mut content = fs::read(&file).unwrap();
        content.extend_from_slice(
            format!("{}\n", upstream_session_cursor_assistant_line("msg_c", 7)).as_bytes(),
        );
        fs::write(&file, content).unwrap();
        upstream_session_cursor_bump_mtime(&file);

        let second = sync_claude_test_file(&db, &file)?;
        assert_eq!(
            (second.imported, second.skipped),
            (1, 0),
            "追加扫描不能重新解析并跳过旧前缀"
        );

        fs::remove_dir_all(&tmp).ok();
        Ok(())
    }

    #[test]
    fn upstream_session_cursor_unterminated_valid_tail_does_not_advance_cursor(
    ) -> Result<(), AppError> {
        let db = Database::memory()?;
        let tmp = std::env::temp_dir().join(format!("cc-switch-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("session.jsonl");
        fs::write(&file, upstream_session_cursor_assistant_line("msg_tail", 5)).unwrap();

        let first = sync_claude_test_file(&db, &file)?;
        assert_eq!(first.imported, 1);
        assert!(first.incomplete_tail);
        let cursor = load_session_sync_cursors(&db, [file.to_string_lossy().into_owned()])?
            .get(file.to_string_lossy().as_ref())
            .copied()
            .expect("Claude cursor");
        assert_eq!(cursor.last_byte_offset, Some(0));

        let mut content = fs::read(&file).unwrap();
        content.extend_from_slice(
            format!(
                "\n{}\n",
                upstream_session_cursor_assistant_line("msg_after_tail", 6)
            )
            .as_bytes(),
        );
        fs::write(&file, content).unwrap();
        upstream_session_cursor_bump_mtime(&file);

        let second = sync_claude_test_file(&db, &file)?;
        assert_eq!((second.imported, second.skipped), (1, 1));
        assert!(!second.incomplete_tail);

        fs::remove_dir_all(&tmp).ok();
        Ok(())
    }

    #[test]
    fn upstream_session_cursor_truncation_pins_eof_then_allows_future_append(
    ) -> Result<(), AppError> {
        let db = Database::memory()?;
        let tmp = std::env::temp_dir().join(format!("cc-switch-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("session.jsonl");
        fs::write(
            &file,
            format!(
                "{}\n{}\n",
                upstream_session_cursor_assistant_line("msg_a", 5),
                upstream_session_cursor_assistant_line("msg_b", 6)
            ),
        )
        .unwrap();
        assert_eq!(sync_claude_test_file(&db, &file)?.imported, 2);

        fs::write(&file, "{}\n").unwrap();
        upstream_session_cursor_bump_mtime(&file);
        let truncated = sync_claude_test_file(&db, &file)?;
        assert_eq!(truncated.imported, 0);
        assert_eq!(truncated.pinned_rewrite, Some("截断"));
        let pinned_offset = load_session_sync_cursors(&db, [file.to_string_lossy().into_owned()])?
            .get(file.to_string_lossy().as_ref())
            .and_then(|cursor| cursor.last_byte_offset);
        assert_eq!(pinned_offset, Some(3));

        let mut content = fs::read(&file).unwrap();
        content.extend_from_slice(
            format!(
                "{}\n",
                upstream_session_cursor_assistant_line("msg_after_truncate", 7)
            )
            .as_bytes(),
        );
        fs::write(&file, content).unwrap();
        upstream_session_cursor_bump_mtime(&file);
        assert_eq!(sync_claude_test_file(&db, &file)?.imported, 1);

        fs::remove_dir_all(&tmp).ok();
        Ok(())
    }

    #[test]
    fn upstream_session_cursor_legacy_line_cursor_converts_without_reimport() -> Result<(), AppError>
    {
        let db = Database::memory()?;
        let tmp = std::env::temp_dir().join(format!("cc-switch-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("session.jsonl");
        fs::write(
            &file,
            format!(
                "{}\n{}\n",
                upstream_session_cursor_assistant_line("msg_old", 5),
                upstream_session_cursor_assistant_line("msg_new", 6)
            ),
        )
        .unwrap();
        {
            let conn = lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO session_log_sync
                    (file_path, last_modified, last_line_offset, last_synced_at,
                     last_byte_offset, last_tail_fingerprint)
                 VALUES (?1, 0, 1, 1, NULL, NULL)",
                rusqlite::params![file.to_string_lossy().as_ref()],
            )?;
        }

        let sync = sync_claude_test_file(&db, &file)?;
        assert_eq!((sync.imported, sync.skipped), (1, 0));
        let conn = lock_conn!(db.conn);
        let old_exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM proxy_request_logs WHERE request_id = 'session:msg_old')",
            [],
            |row| row.get(0),
        )?;
        let new_exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM proxy_request_logs WHERE request_id = 'session:msg_new')",
            [],
            |row| row.get(0),
        )?;
        assert!(!old_exists, "旧行号覆盖的历史不能被重放");
        assert!(new_exists);
        drop(conn);

        fs::remove_dir_all(&tmp).ok();
        Ok(())
    }
}
