//! Gemini CLI 会话日志使用追踪
//!
//! 从 ~/.gemini/tmp/<project_hash>/chats/session-*.json 中提取精确 token 使用数据。
//!
//! ## 数据流
//! ```text
//! ~/.gemini/tmp/*/chats/session-*.json → 全量解析 → 费用计算 → proxy_request_logs 表
//! ```
//!
//! ## 与 Claude/Codex 解析器的差异
//! - JSON 格式（非 JSONL）：每个文件是单个 JSON 对象，包含 messages 数组
//! - 无需 delta 计算：tokens 字段是 per-message 独立值
//! - 无需状态恢复：不依赖前一条消息的累计值
//! - 天然去重：每条消息有唯一 id 字段

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::file_revision::FileRevision;
use crate::gemini_config::get_gemini_dir;
#[cfg(test)]
use crate::json_projection::take_usage_projected_bytes;
use crate::json_projection::JsonProjection;
use crate::proxy::usage::calculator::{CostCalculator, ModelPricing};
use crate::proxy::usage::parser::TokenUsage;
use crate::services::session_usage::{
    load_session_sync_cursors, metadata_modified_nanos, write_session_sync_cursor,
    SessionSyncCursor, SessionSyncResult,
};
use crate::services::usage_stats::{find_model_pricing, should_skip_session_insert, DedupKey};
use rust_decimal::Decimal;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// 从 Gemini message 中提取的 token 数据
#[derive(Debug)]
struct GeminiTokens {
    input: u32,
    output: u32,
    cached: u32,
    thoughts: u32,
}

#[cfg(test)]
thread_local! {
    static GEMINI_SNAPSHOT_BYTES_READ: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

const GEMINI_TOKENS: JsonProjection = JsonProjection::Object(&[
    ("input", JsonProjection::Scalar),
    ("output", JsonProjection::Scalar),
    ("cached", JsonProjection::Scalar),
    ("thoughts", JsonProjection::Scalar),
]);
const GEMINI_MESSAGE: JsonProjection = JsonProjection::Object(&[
    ("type", JsonProjection::Scalar),
    ("tokens", GEMINI_TOKENS),
    ("id", JsonProjection::Scalar),
    ("model", JsonProjection::Scalar),
    ("timestamp", JsonProjection::Scalar),
]);
const GEMINI_SESSION: JsonProjection = JsonProjection::Object(&[
    ("sessionId", JsonProjection::Scalar),
    (
        "messages",
        JsonProjection::Array(&GEMINI_MESSAGE, |message| {
            gemini_message_tokens(message).is_some()
        }),
    ),
]);

/// 同步 Gemini 使用数据（从 JSON 会话日志）
pub fn sync_gemini_usage(db: &Database) -> Result<SessionSyncResult, AppError> {
    let gemini_dir = get_gemini_dir();

    let files = collect_gemini_session_files(&gemini_dir);

    let mut result = SessionSyncResult {
        imported: 0,
        skipped: 0,
        files_scanned: files.len() as u32,
        suspected_duplicates: 0,
        deferred_files: 0,
        errors: vec![],
    };

    if files.is_empty() {
        return Ok(result);
    }

    let keys = files.iter().map(|path| path.to_string_lossy().into_owned());
    let cursors = load_session_sync_cursors(db, keys)?;
    for file_path in &files {
        let path = file_path.to_string_lossy();
        let cursor = cursors.get(path.as_ref());
        match sync_single_gemini_file(db, file_path, cursor) {
            Ok((imported, skipped)) => {
                result.imported += imported;
                result.skipped += skipped;
            }
            Err(e) => {
                let msg = format!("Gemini 会话文件解析失败 {}: {e}", file_path.display());
                log::warn!("[GEMINI-SYNC] {msg}");
                result.errors.push(msg);
            }
        }
    }

    if result.imported > 0 {
        log::info!(
            "[GEMINI-SYNC] 同步完成: 导入 {} 条, 跳过 {} 条, 扫描 {} 个文件",
            result.imported,
            result.skipped,
            result.files_scanned
        );
    }

    Ok(result)
}

/// 收集所有 Gemini 会话 JSON 文件
fn collect_gemini_session_files(gemini_dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();

    let tmp_dir = gemini_dir.join("tmp");
    if !tmp_dir.is_dir() {
        return files;
    }

    // 遍历 tmp/<project_hash>/chats/session-*.json
    let project_dirs = match fs::read_dir(&tmp_dir) {
        Ok(entries) => entries,
        Err(_) => return files,
    };

    for entry in project_dirs.flatten() {
        let chats_dir = entry.path().join("chats");
        if !chats_dir.is_dir() {
            continue;
        }

        let chat_files = match fs::read_dir(&chats_dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for file_entry in chat_files.flatten() {
            let path = file_entry.path();
            let is_session = path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("session-") && n.ends_with(".json"))
                .unwrap_or(false);
            if is_session {
                files.push(path);
            }
        }
    }

    files
}

/// 同步单个 Gemini 会话 JSON 文件，返回 (imported, skipped)
fn sync_single_gemini_file(
    db: &Database,
    file_path: &Path,
    cursor: Option<&SessionSyncCursor>,
) -> Result<(u32, u32), AppError> {
    let file_path_str = file_path.to_string_lossy().to_string();
    let mut file =
        fs::File::open(file_path).map_err(|e| AppError::Config(format!("无法打开文件: {e}")))?;
    let metadata = file
        .metadata()
        .map_err(|e| AppError::Config(format!("无法读取文件元数据: {e}")))?;
    let file_modified = metadata_modified_nanos(&metadata);
    let revision = FileRevision::from_file_metadata(&file, &metadata);
    let mut content = String::new();

    // For this full-snapshot format the cursor fingerprint describes the file
    // revision. Legacy cursors have a timestamp and row count only.
    let revision_fingerprint = revision.map(|revision| revision.fingerprint());
    let content_fingerprint = if revision.is_none() {
        // Filesystems without a reliable change time can still skip parsing
        // once the content has been fingerprinted.
        file.read_to_string(&mut content)
            .map_err(|e| AppError::Config(format!("无法读取文件: {e}")))?;
        #[cfg(test)]
        GEMINI_SNAPSHOT_BYTES_READ.with(|bytes| bytes.set(bytes.get() + content.len()));
        let digest = Sha256::digest(content.as_bytes());
        Some(i64::from_le_bytes(
            digest[..8].try_into().expect("SHA-256 has 32 bytes"),
        ))
    } else {
        None
    };
    let next_cursor = SessionSyncCursor {
        last_modified: file_modified,
        last_byte_offset: Some(metadata.len() as i64),
        last_tail_fingerprint: content_fingerprint,
        last_source_revision: revision_fingerprint,
        ..Default::default()
    };
    if let Some(cursor) = cursor {
        if cursor.matches_source_revision(revision_fingerprint, file_modified)
            || (content_fingerprint.is_some()
                && cursor.last_tail_fingerprint == content_fingerprint)
        {
            return Ok((0, 0));
        }
        if cursor.last_tail_fingerprint.is_none()
            && cursor.last_source_revision.is_none()
            && file_modified <= cursor.last_modified
        {
            // Establish a revision for an already imported legacy snapshot
            // without replaying records whose detailed rows may be pruned.
            if revision.is_some() && FileRevision::read(file_path) != revision {
                return Err(AppError::Config(
                    "Gemini session changed while reading its revision".into(),
                ));
            }
            let conn = lock_conn!(db.conn);
            write_session_sync_cursor(
                &conn,
                &file_path_str,
                SessionSyncCursor {
                    last_line_offset: cursor.last_line_offset,
                    ..next_cursor
                },
            )?;
            return Ok((0, 0));
        }
    }

    if revision.is_some() {
        file.read_to_string(&mut content)
            .map_err(|e| AppError::Config(format!("无法读取文件: {e}")))?;
        #[cfg(test)]
        GEMINI_SNAPSHOT_BYTES_READ.with(|bytes| bytes.set(bytes.get() + content.len()));
        if FileRevision::read(file_path) != revision {
            return Err(AppError::Config(
                "Gemini session changed during read".into(),
            ));
        }
    }
    let value = GEMINI_SESSION
        .parse(&content)
        .map_err(|e| AppError::Config(format!("JSON 解析失败: {e}")))?;

    // 提取顶层 sessionId
    let session_id = value
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // 遍历 messages 数组
    let messages = value
        .get("messages")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);

    let mut imported: u32 = 0;
    let mut skipped: u32 = 0;
    let mut gemini_msg_count: i64 = 0;
    let conn = lock_conn!(db.conn);
    let tx = conn.unchecked_transaction()?;

    for msg in messages {
        let Some(tokens) = gemini_message_tokens(msg) else {
            continue;
        };

        gemini_msg_count += 1;

        // 提取消息 ID 和模型
        let message_id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("unknown");
        let model = msg
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let timestamp = msg.get("timestamp").and_then(|v| v.as_str());

        // 生成唯一 request_id
        let session_id_str = session_id.as_deref().unwrap_or("unknown");
        let request_id = format!("gemini_session:{session_id_str}:{message_id}");

        match insert_gemini_session_entry(
            &tx,
            &request_id,
            &tokens,
            model,
            session_id.as_deref(),
            timestamp,
        )? {
            true => imported += 1,
            false => skipped += 1,
        }
    }

    // 更新同步状态
    write_session_sync_cursor(
        &tx,
        &file_path_str,
        SessionSyncCursor {
            last_line_offset: gemini_msg_count,
            ..next_cursor
        },
    )?;
    tx.commit()?;

    Ok((imported, skipped))
}

fn gemini_message_tokens(message: &Value) -> Option<GeminiTokens> {
    if message.get("type").and_then(Value::as_str) != Some("gemini") {
        return None;
    }
    let tokens = parse_gemini_tokens(message.get("tokens")?);
    (tokens.input != 0 || tokens.output != 0 || tokens.thoughts != 0 || tokens.cached != 0)
        .then_some(tokens)
}

/// 从 tokens JSON 对象中提取 token 数据
fn parse_gemini_tokens(tokens: &serde_json::Value) -> GeminiTokens {
    GeminiTokens {
        input: tokens.get("input").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        output: tokens.get("output").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        cached: tokens.get("cached").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        thoughts: tokens.get("thoughts").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
    }
}

/// 插入单条 Gemini 会话记录到 proxy_request_logs
fn insert_gemini_session_entry(
    conn: &rusqlite::Connection,
    request_id: &str,
    tokens: &GeminiTokens,
    model: &str,
    session_id: Option<&str>,
    timestamp: Option<&str>,
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

    // 合并 thoughts 到 output（思考 token 按输出计费）
    let output_tokens = tokens.output + tokens.thoughts;

    let dedup_key = DedupKey {
        app_type: "gemini",
        model,
        input_tokens: tokens.input,
        output_tokens,
        cache_read_tokens: tokens.cached,
        cache_creation_tokens: 0,
        created_at,
    };
    if should_skip_session_insert(conn, request_id, &dedup_key)? {
        return Ok(false);
    }

    // 计算费用
    let usage = TokenUsage {
        input_tokens: tokens.input,
        output_tokens,
        cache_read_tokens: tokens.cached,
        cache_creation_tokens: 0,
        model: Some(model.to_string()),
        message_id: None,
    };

    let pricing = find_gemini_pricing(conn, model);
    let multiplier = Decimal::from(1);
    let (input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost) = match pricing
    {
        Some(p) => {
            let cost = CostCalculator::calculate_for_app("gemini", &usage, &p, multiplier);
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

    // 使用 UPSERT：新记录插入，已存在记录更新 token 和费用（Gemini 全量重读可能携带更新值）
    conn.execute(
        "INSERT INTO proxy_request_logs (
            request_id, provider_id, app_type, model, request_model,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
            input_cost_usd, output_cost_usd, cache_read_cost_usd, cache_creation_cost_usd, total_cost_usd,
            latency_ms, first_token_ms, status_code, error_message, session_id,
            provider_type, is_streaming, cost_multiplier, created_at, data_source
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)
        ON CONFLICT(request_id) DO UPDATE SET
            model = excluded.model,
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            cache_read_tokens = excluded.cache_read_tokens,
            input_cost_usd = excluded.input_cost_usd,
            output_cost_usd = excluded.output_cost_usd,
            cache_read_cost_usd = excluded.cache_read_cost_usd,
            cache_creation_cost_usd = excluded.cache_creation_cost_usd,
            total_cost_usd = excluded.total_cost_usd
        WHERE input_tokens != excluded.input_tokens
           OR output_tokens != excluded.output_tokens
           OR cache_read_tokens != excluded.cache_read_tokens
           OR model != excluded.model",
        rusqlite::params![
            request_id,
            "_gemini_session",   // provider_id
            "gemini",            // app_type
            model,
            model,               // request_model = model
            tokens.input,
            output_tokens,
            tokens.cached,
            0i64,                // cache_creation_tokens
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
            Some("gemini_session"), // provider_type
            1i64,                // is_streaming
            "1.0",               // cost_multiplier
            created_at,
            "gemini_session",    // data_source
        ],
    )
    .map_err(|e| AppError::Database(format!("插入 Gemini 会话日志失败: {e}")))?;

    // changes() > 0 表示新插入或已更新，== 0 表示值完全相同（无实际变更）
    let changed = conn.changes() > 0;
    Ok(changed)
}

/// 查找 Gemini 模型定价
fn find_gemini_pricing(conn: &rusqlite::Connection, model_id: &str) -> Option<ModelPricing> {
    find_model_pricing(conn, model_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::session_usage::update_sync_state;

    fn sync_gemini_test_file(db: &Database, path: &Path) -> Result<(u32, u32), AppError> {
        let key = path.to_string_lossy().into_owned();
        let cursors = load_session_sync_cursors(db, [key.clone()])?;
        sync_single_gemini_file(db, path, cursors.get(&key))
    }

    #[test]
    fn gemini_usage_unchanged_snapshots_do_not_replay_json() -> Result<(), AppError> {
        let temp = tempfile::tempdir().unwrap();
        for padding in [16, 256 * 1024] {
            let db = Database::memory()?;
            let path = temp.path().join(format!("session-{padding}.json"));
            let first = r#"{"type":"gemini","id":"a","tokens":{"input":4}}"#;
            let second = r#"{"type":"gemini","id":"b","tokens":{"output":8}}"#;
            let ignored = "x".repeat(padding);
            let original =
                format!(r#"{{"sessionId":"s","content":"{ignored}","messages":[{first}]}}"#);
            fs::write(&path, &original).unwrap();
            let has_revision = FileRevision::read(&path).is_some();
            GEMINI_SNAPSHOT_BYTES_READ.with(|bytes| bytes.set(0));
            take_usage_projected_bytes();
            let sync = || sync_gemini_test_file(&db, &path);
            assert_eq!(sync()?, (1, 0));
            assert_eq!(take_usage_projected_bytes(), original.len());
            assert_eq!(
                GEMINI_SNAPSHOT_BYTES_READ.with(|bytes| bytes.replace(0)),
                original.len()
            );
            for _ in 0..8 {
                assert_eq!(sync()?, (0, 0));
            }
            assert_eq!(take_usage_projected_bytes(), 0);
            assert_eq!(
                GEMINI_SNAPSHOT_BYTES_READ.with(|bytes| bytes.replace(0)),
                if has_revision { 0 } else { original.len() * 8 }
            );

            let modified = fs::metadata(&path).unwrap().modified().unwrap();
            let updated = format!(
                r#"{{"sessionId":"s","content":"{ignored}","messages":[{first},{second}]}}"#
            );
            fs::write(&path, &updated).unwrap();
            restore_mtime(&path, modified);
            assert_eq!(sync()?, (1, 1));
            assert_eq!(take_usage_projected_bytes(), updated.len());

            let rewritten = updated.replace("\"id\":\"b\"", "\"id\":\"c\"");
            assert_eq!(rewritten.len(), updated.len());
            fs::write(&path, &rewritten).unwrap();
            restore_mtime(&path, modified);
            assert_eq!(sync()?, (1, 1));
            assert_eq!(take_usage_projected_bytes(), rewritten.len());

            let replacement_path = temp.path().join("replacement.json");
            let replacement = rewritten.replace("\"id\":\"c\"", "\"id\":\"d\"");
            fs::write(&replacement_path, &replacement).unwrap();
            restore_mtime(&replacement_path, modified);
            fs::rename(replacement_path, &path).unwrap();
            assert_eq!(sync()?, (1, 1));
            assert_eq!(take_usage_projected_bytes(), replacement.len());
            assert_eq!(sync()?, (0, 0));
            assert_eq!(take_usage_projected_bytes(), 0);
        }
        Ok(())
    }

    fn restore_mtime(path: &Path, modified: SystemTime) {
        fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
    }

    #[test]
    fn gemini_usage_upgrades_legacy_snapshot_cursor_without_replaying_history(
    ) -> Result<(), AppError> {
        let db = Database::memory()?;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.json");
        let original =
            r#"{"sessionId":"s","messages":[{"type":"gemini","id":"a","tokens":{"input":4}}]}"#;
        fs::write(&path, original).unwrap();
        let metadata = fs::metadata(&path).unwrap();
        let modified = metadata.modified().unwrap();
        let key = path.to_string_lossy().into_owned();
        update_sync_state(&db, &key, metadata_modified_nanos(&metadata), 1)?;

        take_usage_projected_bytes();
        assert_eq!(sync_gemini_test_file(&db, &path)?, (0, 0));
        assert_eq!(take_usage_projected_bytes(), 0);
        let cursor = load_session_sync_cursors(&db, [key.clone()])?[&key];
        assert_eq!(cursor.last_line_offset, 1);
        assert!(cursor.last_source_revision.is_some() || cursor.last_tail_fingerprint.is_some());

        let changed = original.replace("\"input\":4", "\"input\":8");
        fs::write(&path, &changed).unwrap();
        restore_mtime(&path, modified);
        assert_eq!(sync_gemini_test_file(&db, &path)?, (1, 0));
        assert_eq!(take_usage_projected_bytes(), changed.len());
        Ok(())
    }

    #[test]
    fn gemini_usage_projection_retains_only_billed_rows_and_fields() {
        for ignored_messages in [1, 512] {
            let mut document = String::from(
                r#"{"sessionId":{"ignored":true},"sessionId":"sample","messages":[
                    ["invalid message shape"],
                    {"type":"gemini","tokens":{"input":7},"tokens":true},
                    {"type":"gemini","id":"old","tokens":{"input":8,"input":9,"other":[1,2,3]}},
                    {"type":"gemini","id":"new","model":{"invalid":"model"},"tokens":{"cached":4}}
                "#,
            );
            let ignored_text = "x".repeat(1536);
            for _ in 0..ignored_messages {
                use std::fmt::Write;
                write!(
                    document,
                    r#",{{"type":"user","content":"{ignored_text}","tools":[{{"payload":"{ignored_text}"}}]}}"#,
                )
                .unwrap();
            }
            document.push_str("]}");

            let projected = GEMINI_SESSION.parse(&document).unwrap();
            assert_eq!(
                projected,
                serde_json::json!({
                    "sessionId": "sample",
                    "messages": [
                        {"type": "gemini", "id": "old", "tokens": {"input": 9}},
                        {"type": "gemini", "id": "new", "model": null, "tokens": {"cached": 4}}
                    ]
                })
            );
        }
        for invalid in [
            r#"{"messages":[],"skipped":{"invalid":}}"#,
            r#"{"messages":[],"skipped":"\uD800"}"#,
        ] {
            assert!(GEMINI_SESSION.parse(invalid).is_err());
        }
        let deeply_nested = format!(
            r#"{{"messages":[],"skipped":{}0{}}}"#,
            "[".repeat(128),
            "]".repeat(128)
        );
        assert!(GEMINI_SESSION.parse(&deeply_nested).is_err());
    }

    #[test]
    fn test_collect_gemini_session_files_nonexistent() {
        let files = collect_gemini_session_files(Path::new("/nonexistent/path"));
        assert!(files.is_empty());
    }

    #[test]
    fn test_insert_gemini_session_skips_matching_proxy_log() -> Result<(), AppError> {
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
                    "gemini-proxy",
                    "google",
                    "gemini",
                    "gemini-2.5-pro",
                    "gemini-2.5-pro",
                    10,
                    7,
                    1,
                    0,
                    "0.01",
                    100,
                    200,
                    1000,
                    "proxy"
                ],
            )?;
        }

        let tokens = GeminiTokens {
            input: 10,
            output: 2,
            cached: 1,
            thoughts: 5,
        };
        let conn = lock_conn!(db.conn);
        let inserted = insert_gemini_session_entry(
            &conn,
            "gemini-session-dup",
            &tokens,
            "gemini-2.5-pro",
            Some("session-1"),
            Some("1970-01-01T00:16:45Z"),
        )?;
        assert!(!inserted);

        let count: i64 = conn.query_row("SELECT COUNT(*) FROM proxy_request_logs", [], |row| {
            row.get(0)
        })?;
        assert_eq!(count, 1);

        Ok(())
    }

    #[test]
    fn test_parse_gemini_tokens() {
        let json: serde_json::Value = serde_json::json!({
            "input": 8522,
            "output": 29,
            "cached": 3138,
            "thoughts": 405,
            "tool": 0,
            "total": 8956
        });
        let tokens = parse_gemini_tokens(&json);
        assert_eq!(tokens.input, 8522);
        assert_eq!(tokens.output, 29);
        assert_eq!(tokens.cached, 3138);
        assert_eq!(tokens.thoughts, 405);
        // output + thoughts = 29 + 405 = 434（用于计费）
        assert_eq!(tokens.output + tokens.thoughts, 434);
    }

    #[test]
    fn test_parse_gemini_tokens_missing_fields() {
        // 缺少某些字段时应返回 0
        let json: serde_json::Value = serde_json::json!({
            "input": 100,
            "output": 50
        });
        let tokens = parse_gemini_tokens(&json);
        assert_eq!(tokens.input, 100);
        assert_eq!(tokens.output, 50);
        assert_eq!(tokens.cached, 0);
        assert_eq!(tokens.thoughts, 0);
    }

    #[test]
    fn test_parse_gemini_tokens_all_zero() {
        let json: serde_json::Value = serde_json::json!({
            "input": 0,
            "output": 0,
            "cached": 0,
            "thoughts": 0,
            "tool": 0,
            "total": 0
        });
        let tokens = parse_gemini_tokens(&json);
        assert_eq!(tokens.input, 0);
        assert_eq!(tokens.output, 0);
        // 全零（包括 cached=0）会被 sync 逻辑跳过
        assert!(
            tokens.input == 0 && tokens.output == 0 && tokens.thoughts == 0 && tokens.cached == 0
        );
    }

    #[test]
    fn test_parse_gemini_tokens_cache_only_not_skipped() {
        // 纯缓存命中消息（input/output/thoughts=0 但 cached>0）不应被跳过
        let json: serde_json::Value = serde_json::json!({
            "input": 0,
            "output": 0,
            "cached": 5000,
            "thoughts": 0
        });
        let tokens = parse_gemini_tokens(&json);
        assert_eq!(tokens.cached, 5000);
        // 跳过条件：所有四个字段都为 0 才跳过
        let should_skip =
            tokens.input == 0 && tokens.output == 0 && tokens.thoughts == 0 && tokens.cached == 0;
        assert!(!should_skip, "纯缓存命中记录不应被跳过");
    }
}
