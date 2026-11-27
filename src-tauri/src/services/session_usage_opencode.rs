//! OpenCode 会话日志使用追踪
//!
//! 从 ~/.local/share/opencode/opencode.db (SQLite) 中提取精确 token 使用数据。
//!
//! ## 数据流
//! ```text
//! ~/.local/share/opencode/opencode.db
//!   → session 表获取所有会话
//!   → message 表获取 assistant 消息
//!   → 解析 data JSON 提取 tokens/cost/model
//!   → proxy_request_logs 表
//! ```

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::file_revision::FileRevision;
use crate::json_projection::JsonProjection as UsageProjection;
use crate::opencode_config::get_opencode_db_path;
use crate::proxy::usage::calculator::CostCalculator;
use crate::proxy::usage::parser::TokenUsage;
use crate::services::session_usage::{
    load_session_sync_cursors, write_session_sync_cursor, SessionSyncCursor, SessionSyncResult,
};
use crate::services::usage_stats::{find_model_pricing, should_skip_session_insert, DedupKey};
use rust_decimal::Decimal;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::SystemTime;

/// 从 opencode message.data JSON 中提取的 token 和费用数据
struct OpenCodeMessageData {
    input_tokens: u32,
    output_tokens: u32,
    reasoning_tokens: u32,
    cache_read_tokens: u32,
    cache_write_tokens: u32,
    cost: f64,
    model_id: String,
    timestamp_ms: i64,
    // OpenCode offline logs expose message completion timing, not first-token timing.
    latency_ms: i64,
}

const OPENCODE_CACHE: UsageProjection = UsageProjection::Object(&[
    ("read", UsageProjection::Scalar),
    ("write", UsageProjection::Scalar),
]);
const OPENCODE_TOKENS: UsageProjection = UsageProjection::Object(&[
    ("input", UsageProjection::Scalar),
    ("output", UsageProjection::Scalar),
    ("reasoning", UsageProjection::Scalar),
    ("cache", OPENCODE_CACHE),
]);
const OPENCODE_TIME: UsageProjection = UsageProjection::Object(&[
    ("created", UsageProjection::Scalar),
    ("completed", UsageProjection::Scalar),
]);
const OPENCODE_MESSAGE: UsageProjection = UsageProjection::Object(&[
    ("role", UsageProjection::Scalar),
    ("tokens", OPENCODE_TOKENS),
    ("cost", UsageProjection::Scalar),
    ("modelID", UsageProjection::Scalar),
    ("time", OPENCODE_TIME),
]);

/// 同步 OpenCode 使用数据
pub fn sync_opencode_usage(db: &Database) -> Result<SessionSyncResult, AppError> {
    sync_opencode_database(db, &get_opencode_db_path())
}

fn sync_opencode_database(db: &Database, db_path: &Path) -> Result<SessionSyncResult, AppError> {
    if !db_path.exists() {
        return Ok(SessionSyncResult {
            imported: 0,
            skipped: 0,
            files_scanned: 0,
            suspected_duplicates: 0,
            deferred_files: 0,
            errors: vec![],
        });
    }

    let db_path_str = db_path.to_string_lossy();
    let revision_before_open = FileRevision::read(db_path);
    let mut opencode_conn =
        rusqlite::Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| AppError::Database(format!("无法打开 opencode.db: {e}")))?;
    let snapshot = opencode_conn.transaction()?;
    // Pin the SQLite snapshot before checking the file revision. A rollback
    // reader holds a shared database lock. WAL commits publish independently
    // of filesystem timestamps. PRAGMA data_version is connection-local, and
    // retaining this connection between polls can block Windows replacement,
    // so WAL checks message fingerprints inside each new snapshot.
    snapshot.query_row("SELECT count(*) FROM sqlite_schema", [], |_| Ok(()))?;
    let journal_mode: String =
        snapshot.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
    let rollback_revision = revision_before_open
        .filter(|revision| {
            matches!(journal_mode.as_str(), "delete" | "truncate" | "persist")
                && FileRevision::read(db_path).as_ref() == Some(revision)
        })
        .map(|revision| revision.fingerprint());

    let mut result = SessionSyncResult {
        imported: 0,
        skipped: 0,
        files_scanned: 1,
        suspected_duplicates: 0,
        deferred_files: 0,
        errors: vec![],
    };
    if let Some(revision) = rollback_revision {
        let cursor = load_session_sync_cursors(db, [db_path_str.to_string()])?;
        if cursor
            .get(db_path_str.as_ref())
            .and_then(|cursor| cursor.last_source_revision)
            == Some(revision)
        {
            return Ok(result);
        }
    }

    let sessions = query_session_ids(&snapshot)?;
    let keys = sessions
        .iter()
        .map(|session_id| format!("{db_path_str}:{session_id}"));
    let cursors = load_session_sync_cursors(db, keys)?;
    for session_id in &sessions {
        let key = format!("{db_path_str}:{session_id}");
        let previous = cursors
            .get(&key)
            .and_then(|cursor| cursor.last_tail_fingerprint);
        match sync_opencode_session(db, &snapshot, &key, session_id, previous) {
            Ok((imported, skipped)) => {
                result.imported += imported;
                result.skipped += skipped;
            }
            Err(error) => {
                let msg = format!("OpenCode 会话同步失败 {session_id}: {error}");
                log::warn!("[OPENCODE-SYNC] {msg}");
                result.errors.push(msg);
            }
        }
    }

    if result.errors.is_empty() {
        if let Some(revision) = rollback_revision {
            let conn = lock_conn!(db.conn);
            write_session_sync_cursor(
                &conn,
                &db_path_str,
                SessionSyncCursor {
                    last_source_revision: Some(revision),
                    ..Default::default()
                },
            )?;
        }
    }

    if result.imported > 0 {
        log::info!(
            "[OPENCODE-SYNC] 同步完成: 导入 {} 条, 跳过 {} 条, 扫描 {} 个会话",
            result.imported,
            result.skipped,
            sessions.len()
        );
    }

    Ok(result)
}

fn query_session_ids(conn: &rusqlite::Connection) -> Result<Vec<String>, AppError> {
    let mut stmt = conn
        .prepare("SELECT id FROM session ORDER BY time_updated, id")
        .map_err(|e| AppError::Database(format!("准备会话查询失败: {e}")))?;

    let rows = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| AppError::Database(format!("查询会话失败: {e}")))?;

    let mut sessions = Vec::new();
    for row in rows {
        sessions.push(row.map_err(|e| AppError::Database(format!("读取会话行失败: {e}")))?);
    }

    Ok(sessions)
}

const SESSION_MESSAGES: &str =
    "SELECT id, data FROM message WHERE session_id = ?1 ORDER BY time_created, id";

#[cfg(test)]
thread_local! {
    static OPENCODE_FINGERPRINTED_BYTES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static OPENCODE_FINGERPRINTED_SESSIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn message_fingerprint(conn: &rusqlite::Connection, session_id: &str) -> Result<i64, AppError> {
    let mut digest = Sha256::new();
    digest.update(b"opencode-session-messages-v1");
    let mut stmt = conn.prepare_cached(SESSION_MESSAGES)?;
    let mut rows = stmt.query([session_id])?;
    #[cfg(test)]
    OPENCODE_FINGERPRINTED_SESSIONS.with(|sessions| sessions.set(sessions.get() + 1));
    while let Some(row) = rows.next()? {
        let id = row.get_ref(0)?.as_str().map_err(rusqlite::Error::from)?;
        let value = row.get_ref(1)?;
        let rusqlite::types::ValueRef::Text(data) = value else {
            return Err(
                rusqlite::Error::InvalidColumnType(1, "data".into(), value.data_type()).into(),
            );
        };
        #[cfg(test)]
        OPENCODE_FINGERPRINTED_BYTES.with(|bytes| bytes.set(bytes.get() + data.len()));
        for field in [id.as_bytes(), data] {
            digest.update((field.len() as u64).to_le_bytes());
            digest.update(field);
        }
    }
    let digest = digest.finalize();
    Ok(i64::from_le_bytes(
        digest[..8].try_into().expect("SHA-256 has 32 bytes"),
    ))
}

fn sync_opencode_session(
    db: &Database,
    snapshot: &rusqlite::Connection,
    key: &str,
    session_id: &str,
    previous: Option<i64>,
) -> Result<(u32, u32), AppError> {
    let fingerprint = message_fingerprint(snapshot, session_id)?;
    if previous == Some(fingerprint) {
        return Ok((0, 0));
    }

    let messages = query_assistant_messages(snapshot, session_id)?;
    let mut conn = lock_conn!(db.conn);
    let transaction = conn.transaction()?;
    let mut imported = 0;
    let mut skipped = 0;
    for (message_id, msg_data) in &messages {
        let request_id = format!("opencode_session:{session_id}:{message_id}");
        if insert_opencode_message(&transaction, &request_id, msg_data, session_id)? {
            imported += 1;
        } else {
            skipped += 1;
        }
    }

    // Pending messages are part of the fingerprint and will be retried when
    // they change, even when OpenCode keeps their update timestamps.
    write_session_sync_cursor(
        &transaction,
        key,
        SessionSyncCursor {
            last_tail_fingerprint: Some(fingerprint),
            ..Default::default()
        },
    )?;
    transaction.commit()?;
    Ok((imported, skipped))
}

/// 查询某会话的已完成 assistant 消息
fn query_assistant_messages(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Vec<(String, OpenCodeMessageData)>, AppError> {
    let mut stmt = conn
        .prepare_cached(SESSION_MESSAGES)
        .map_err(|e| AppError::Database(format!("准备消息查询失败: {e}")))?;

    let rows = stmt
        .query_map([session_id], |row| {
            let id = row.get::<_, String>(0)?;
            let data = row.get_ref(1)?.as_str()?;
            Ok((id, OPENCODE_MESSAGE.parse(data)))
        })
        .map_err(|e| AppError::Database(format!("查询消息失败: {e}")))?;

    let mut messages = Vec::new();
    for row in rows {
        let (message_id, projected) =
            row.map_err(|e| AppError::Database(format!("读取消息行失败: {e}")))?;

        // 只处理 assistant 消息
        let value = match projected {
            Ok(v) => v,
            Err(_) => continue,
        };

        if value.get("role").and_then(|r| r.as_str()) != Some("assistant") {
            continue;
        }

        // 必须有 tokens 字段
        if value.get("tokens").is_none() {
            continue;
        }

        // 跳过未完成的消息：进行中只有半截 token，且因 INSERT OR IGNORE 无法回填
        if value.get("time").and_then(|t| t.get("completed")).is_none() {
            continue;
        }

        if let Some(msg_data) = parse_message_data(&value) {
            messages.push((message_id, msg_data));
        }
    }

    Ok(messages)
}

/// 解析 opencode message.data JSON 为结构化数据
fn parse_message_data(value: &serde_json::Value) -> Option<OpenCodeMessageData> {
    let tokens = value.get("tokens")?;

    let input_tokens = tokens.get("input").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let output_tokens = tokens.get("output").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let reasoning_tokens = tokens
        .get("reasoning")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;

    let cache_obj = tokens.get("cache");
    let cache_read_tokens = cache_obj
        .and_then(|c| c.get("read"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let cache_write_tokens = cache_obj
        .and_then(|c| c.get("write"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;

    // 跳过全零 token 的消息
    if input_tokens == 0
        && output_tokens == 0
        && reasoning_tokens == 0
        && cache_read_tokens == 0
        && cache_write_tokens == 0
    {
        return None;
    }

    let cost = value.get("cost").and_then(|v| v.as_f64()).unwrap_or(0.0);

    let model_id = value
        .get("modelID")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    let timestamp_ms = value
        .get("time")
        .and_then(|t| t.get("created"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    let latency_ms = derive_latency_ms(value, timestamp_ms);

    Some(OpenCodeMessageData {
        input_tokens,
        output_tokens,
        reasoning_tokens,
        cache_read_tokens,
        cache_write_tokens,
        cost,
        model_id,
        timestamp_ms,
        latency_ms,
    })
}

/// Derive elapsed message latency from OpenCode's offline timing fields.
///
/// Offline history has no measured first-token timestamp, so this value is
/// deliberately kept separate from `first_token_ms`. Invalid, missing, or
/// non-forward timestamps produce zero rather than inventing a duration.
fn derive_latency_ms(value: &serde_json::Value, created_ms: i64) -> i64 {
    let Some(completed_ms) = value
        .get("time")
        .and_then(|time| time.get("completed"))
        .and_then(|value| value.as_i64())
    else {
        return 0;
    };

    if created_ms <= 0 || completed_ms <= 0 || completed_ms <= created_ms {
        return 0;
    }

    completed_ms.checked_sub(created_ms).unwrap_or(0)
}

/// 插入单条 OpenCode 消息记录到 proxy_request_logs
fn insert_opencode_message(
    conn: &rusqlite::Connection,
    request_id: &str,
    msg: &OpenCodeMessageData,
    session_id: &str,
) -> Result<bool, AppError> {
    let created_at = if msg.timestamp_ms > 0 {
        msg.timestamp_ms / 1000
    } else {
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    };

    // OpenCode 使用 Anthropic 风格：input 是新鲜输入，cache 单独计
    // output 包含 reasoning tokens（按输出计费）
    let output_with_reasoning = msg.output_tokens + msg.reasoning_tokens;

    let dedup_key = DedupKey {
        app_type: "opencode",
        model: &msg.model_id,
        input_tokens: msg.input_tokens,
        output_tokens: output_with_reasoning,
        cache_read_tokens: msg.cache_read_tokens,
        cache_creation_tokens: msg.cache_write_tokens,
        created_at,
    };
    if should_skip_session_insert(conn, request_id, &dedup_key)? {
        return Ok(false);
    }

    // 如果 opencode 已经提供了费用，直接使用；否则从模型定价计算
    let (input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost) =
        if msg.cost > 0.0 {
            // opencode 已计算费用，直接使用
            // 简化处理：全部放入 total_cost（opencode 的 cost 是聚合值，无法精确拆分）
            (
                "0".to_string(),
                "0".to_string(),
                "0".to_string(),
                "0".to_string(),
                msg.cost.to_string(),
            )
        } else {
            // opencode 费用为 0（如免费模型），尝试用 cc-switch 自带的模型定价计算
            let usage = TokenUsage {
                input_tokens: msg.input_tokens,
                output_tokens: output_with_reasoning,
                cache_read_tokens: msg.cache_read_tokens,
                cache_creation_tokens: msg.cache_write_tokens,
                model: Some(msg.model_id.clone()),
                message_id: None,
            };

            match find_model_pricing(conn, &msg.model_id) {
                Some(pricing) => {
                    let cost = CostCalculator::calculate_for_app(
                        "opencode",
                        &usage,
                        &pricing,
                        Decimal::from(1),
                    );
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
            }
        };

    let inserted_rows = conn.execute(
        "INSERT OR IGNORE INTO proxy_request_logs (
            request_id, provider_id, app_type, model, request_model,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
            input_cost_usd, output_cost_usd, cache_read_cost_usd, cache_creation_cost_usd, total_cost_usd,
            latency_ms, first_token_ms, status_code, error_message, session_id,
            provider_type, is_streaming, cost_multiplier, created_at, data_source
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)",
        rusqlite::params![
            request_id,
            "_opencode_session",   // provider_id
            "opencode",            // app_type
            msg.model_id,
            msg.model_id,          // request_model = model
            msg.input_tokens,
            output_with_reasoning,
            msg.cache_read_tokens,
            msg.cache_write_tokens,
            input_cost,
            output_cost,
            cache_read_cost,
            cache_creation_cost,
            total_cost,
            msg.latency_ms,         // offline message elapsed time
            Option::<i64>::None,   // first_token_ms
            200i64,                // status_code
            Option::<String>::None,// error_message
            Some(session_id.to_string()),
            Some("opencode_session"), // provider_type
            1i64,                  // is_streaming
            "1.0",                 // cost_multiplier
            created_at,
            "opencode_session",    // data_source
        ],
    )
    .map_err(|e| AppError::Database(format!("插入 OpenCode 会话日志失败: {e}")))?;

    Ok(inserted_rows > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json_projection::take_usage_projected_bytes;
    use crate::services::session_usage::update_sync_state;
    use std::fs;

    fn take_fingerprint_work() -> (usize, usize) {
        (
            OPENCODE_FINGERPRINTED_SESSIONS.with(|sessions| sessions.replace(0)),
            OPENCODE_FINGERPRINTED_BYTES.with(|bytes| bytes.replace(0)),
        )
    }

    fn create_opencode_source(path: &Path) -> rusqlite::Result<rusqlite::Connection> {
        let source = rusqlite::Connection::open(path)?;
        source.execute_batch(
            "CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER);
             CREATE TABLE message (
                 id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
                 time_updated INTEGER, data TEXT
             );
             CREATE INDEX message_session ON message (session_id, time_created, id);",
        )?;
        Ok(source)
    }

    #[test]
    fn test_parse_message_data_full() {
        let json: serde_json::Value = serde_json::json!({
            "role": "assistant",
            "cost": 0.0023113,
            "tokens": {
                "total": 56554,
                "input": 3272,
                "output": 383,
                "reasoning": 419,
                "cache": {
                    "write": 0,
                    "read": 52480
                }
            },
            "modelID": "deepseek-v4-pro",
            "providerID": "deepseek",
            "time": {
                "created": 1779755333700i64,
                "completed": 1779755350639i64
            }
        });
        let data = parse_message_data(&json).unwrap();
        assert_eq!(data.input_tokens, 3272);
        assert_eq!(data.output_tokens, 383);
        assert_eq!(data.reasoning_tokens, 419);
        assert_eq!(data.cache_read_tokens, 52480);
        assert_eq!(data.cache_write_tokens, 0);
        assert!((data.cost - 0.0023113).abs() < 1e-10);
        assert_eq!(data.model_id, "deepseek-v4-pro");
        assert_eq!(data.timestamp_ms, 1779755333700);
        assert_eq!(data.latency_ms, 16939);
    }

    #[test]
    fn test_parse_message_data_latency_fallbacks() {
        let cases = [
            (
                serde_json::json!({"created": 1000, "completed": 2500}),
                1500,
            ),
            (serde_json::json!({"created": 1000, "completed": 1000}), 0),
            (serde_json::json!({"created": 1000, "completed": 999}), 0),
            (serde_json::json!({"created": 0, "completed": 2500}), 0),
            (serde_json::json!({"created": -1, "completed": 2500}), 0),
            (serde_json::json!({"created": 1000, "completed": 0}), 0),
            (serde_json::json!({"created": 1000, "completed": -1}), 0),
            (serde_json::json!({"created": 1000}), 0),
            (serde_json::json!({"created": "1000", "completed": 2500}), 0),
            (serde_json::json!({"created": 1000, "completed": null}), 0),
            (
                serde_json::json!({"created": i64::MAX - 1, "completed": i64::MAX}),
                1,
            ),
            (
                serde_json::json!({"created": 1, "completed": i64::MAX}),
                i64::MAX - 1,
            ),
        ];

        for (time, expected_latency_ms) in cases {
            let value = serde_json::json!({
                "tokens": {"input": 1000, "output": 200},
                "modelID": "timing-model",
                "time": time,
            });
            assert_eq!(
                parse_message_data(&value).unwrap().latency_ms,
                expected_latency_ms
            );
        }

        let missing_time = serde_json::json!({
            "tokens": {"input": 1000, "output": 200},
            "modelID": "timing-model",
        });
        assert_eq!(parse_message_data(&missing_time).unwrap().latency_ms, 0);
    }
    #[test]
    fn test_insert_opencode_persists_offline_latency_without_first_token() -> Result<(), AppError> {
        let db = Database::memory().unwrap();
        let value = serde_json::json!({
            "tokens": {"input": 1000, "output": 200, "reasoning": 10},
            "cost": 0.25,
            "modelID": "test-timing-model",
            "time": {"created": 1000000, "completed": 1001500},
        });
        let msg = parse_message_data(&value).unwrap();
        let request_id = "opencode_session:timing:message";
        let conn = lock_conn!(db.conn);
        assert!(insert_opencode_message(&conn, request_id, &msg, "timing").unwrap());
        assert!(!insert_opencode_message(&conn, request_id, &msg, "timing").unwrap());
        let row = conn
            .query_row(
                "SELECT latency_ms, first_token_ms, input_tokens, output_tokens, total_cost_usd, COUNT(*)
                 FROM proxy_request_logs WHERE request_id = ?1",
                [request_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, u32>(2)?,
                        row.get::<_, u32>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(row, (1500, None, 1000, 210, "0.25".into(), 1));
        Ok(())
    }
    #[test]
    fn test_parse_message_data_missing_cache() {
        let json: serde_json::Value = serde_json::json!({
            "role": "assistant",
            "cost": 0.0,
            "tokens": {
                "input": 1000,
                "output": 200
            },
            "modelID": "mimo-v2.5-pro",
            "time": { "created": 1779755333700i64 }
        });
        let data = parse_message_data(&json).unwrap();
        assert_eq!(data.input_tokens, 1000);
        assert_eq!(data.output_tokens, 200);
        assert_eq!(data.reasoning_tokens, 0);
        assert_eq!(data.cache_read_tokens, 0);
        assert_eq!(data.cache_write_tokens, 0);
    }

    #[test]
    fn test_parse_message_data_skips_zero_tokens() {
        let json: serde_json::Value = serde_json::json!({
            "role": "assistant",
            "tokens": {
                "input": 0,
                "output": 0,
                "reasoning": 0,
                "cache": { "read": 0, "write": 0 }
            },
            "modelID": "test"
        });
        assert!(parse_message_data(&json).is_none());
    }

    #[test]
    fn test_parse_message_data_ignores_role() {
        // parse_message_data does not filter by role; that's the caller's job
        let json: serde_json::Value = serde_json::json!({
            "role": "user",
            "tokens": { "input": 100, "output": 0 }
        });
        let data = parse_message_data(&json).unwrap();
        assert_eq!(data.input_tokens, 100);
    }

    #[test]
    fn test_query_assistant_messages_skips_incomplete() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);",
        )
        .unwrap();

        let done = serde_json::json!({
            "role": "assistant",
            "tokens": { "input": 1000, "output": 200 },
            "modelID": "m",
            "time": { "created": 1, "completed": 2 }
        })
        .to_string();
        let in_progress = serde_json::json!({
            "role": "assistant",
            "tokens": { "input": 500, "output": 0 },
            "modelID": "m",
            "time": { "created": 3 }
        })
        .to_string();

        conn.execute(
            "INSERT INTO message VALUES ('done', 's1', 1, ?1), ('wip', 's1', 2, ?2)",
            rusqlite::params![done, in_progress],
        )
        .unwrap();

        let result = query_assistant_messages(&conn, "s1").unwrap();
        // 只返回已完成（带 time.completed）的消息，半截的被跳过
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].0, "done");
    }

    #[test]
    fn opencode_usage_projection_retains_fixed_fields_for_large_messages() {
        for content_bytes in [16, 256 * 1024] {
            let content = "x".repeat(content_bytes);
            let data = format!(
                r#"{{"role":"assistant","tokens":false,"tokens":{{"input":4,"cache":{{"read":2,"unknown":[0]}}}},
                    "modelID":"model","content":"{content}","time":{{"created":1000,"completed":2000}},
                    "extra":{{"payload":"{content}"}}}}"#,
            );
            let result = OPENCODE_MESSAGE.parse(&data).unwrap();
            assert_eq!(
                result,
                serde_json::json!({
                    "role": "assistant",
                    "tokens": {"input": 4, "cache": {"read": 2}},
                    "modelID": "model",
                    "time": {"created": 1000, "completed": 2000}
                })
            );
            let usage = parse_message_data(&result).unwrap();
            assert_eq!(usage.input_tokens, 4);
            assert_eq!(usage.cache_read_tokens, 2);
            assert_eq!(usage.latency_ms, 1000);
        }
        for invalid in [
            r#"{"role":"assistant","ignored":[,]}"#,
            r#"{"role":"assistant","ignored":"\uD800"}"#,
        ] {
            assert!(OPENCODE_MESSAGE.parse(invalid).is_err());
        }
    }

    #[test]
    fn opencode_usage_unchanged_sessions_do_not_replay_json() -> Result<(), AppError> {
        let temp = tempfile::tempdir().unwrap();
        for padding in [16, 256 * 1024] {
            let db = Database::memory()?;
            let path = temp.path().join(format!("opencode-{padding}.db"));
            let source = create_opencode_source(&path)?;
            source
                .execute_batch("INSERT INTO session VALUES ('stable', 100), ('pending', 100);")?;
            let ignored = "x".repeat(padding);
            let stable = format!(
                r#"{{"role":"assistant","tokens":{{"input":4}},"time":{{"created":100,"completed":200}},"content":"{ignored}"}}"#
            );
            let completed = r#"{"role":"assistant","tokens":{"input":8},"time":{"created":100,"completed":201}}"#;
            let pending = format!(
                "{:width$}",
                r#"{"role":"assistant","tokens":{"input":8},"time":{"created":100}}"#,
                width = completed.len()
            );
            source.execute(
                "INSERT INTO message VALUES
                 ('a', 'stable', 100, 200, ?1), ('b', 'pending', 100, 200, ?2)",
                rusqlite::params![stable, pending],
            )?;
            drop(source);
            let before = fs::metadata(&path).unwrap();
            take_usage_projected_bytes();
            take_fingerprint_work();
            assert_eq!(sync_opencode_database(&db, &path)?.imported, 1);
            assert_eq!(take_usage_projected_bytes(), stable.len() + pending.len());
            assert_eq!(take_fingerprint_work(), (2, stable.len() + pending.len()));
            for _ in 0..8 {
                assert_eq!(sync_opencode_database(&db, &path)?.imported, 0);
            }
            assert_eq!(take_usage_projected_bytes(), 0);
            assert_eq!(take_fingerprint_work(), (0, 0));

            let source = rusqlite::Connection::open(&path)?;
            source.execute("UPDATE message SET data = ?1 WHERE id = 'b'", [completed])?;
            drop(source);
            fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(before.modified().unwrap()))
                .unwrap();
            let after = fs::metadata(&path).unwrap();
            assert_eq!(before.len(), after.len());
            assert_eq!(before.modified().unwrap(), after.modified().unwrap());
            assert_eq!(sync_opencode_database(&db, &path)?.imported, 1);
            assert_eq!(take_usage_projected_bytes(), completed.len());
            assert_eq!(take_fingerprint_work(), (2, stable.len() + completed.len()));
        }
        Ok(())
    }

    #[test]
    fn opencode_usage_wal_imports_committed_same_timestamp_edits() -> Result<(), AppError> {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("opencode.db");
        let db = Database::memory()?;
        let mut source = create_opencode_source(&path)?;
        source.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA wal_autocheckpoint = 0;
             INSERT INTO session VALUES ('s1', 100), ('s2', 100);",
        )?;
        let complete =
            r#"{"role":"assistant","tokens":{"input":8},"time":{"created":100,"completed":200}}"#;
        // Preparing the same row for import can leave its ID, timestamps,
        // payload length and session message count unchanged.
        let pending = format!(
            "{:width$}",
            r#"{"role":"assistant","tokens":{"input":8},"time":{"created":100}}"#,
            width = complete.len()
        );
        assert_eq!(pending.len(), complete.len());
        let stable = format!(
            r#"{{"role":"assistant","tokens":{{"input":4}},"time":{{"created":100,"completed":200}},"content":"{}"}}"#,
            "x".repeat(256 * 1024)
        );
        source.execute(
            "INSERT INTO message VALUES ('pending', 's1', 100, 200, ?1),
                                        ('stable', 's2', 100, 200, ?2)",
            rusqlite::params![pending, stable],
        )?;
        // Legacy cursors stored only a high timestamp.
        let path_str = path.to_string_lossy();
        for key in [path_str.to_string(), format!("{path_str}:s1")] {
            update_sync_state(&db, &key, i64::MAX, 0)?;
        }
        take_usage_projected_bytes();
        take_fingerprint_work();
        assert_eq!(sync_opencode_database(&db, &path)?.imported, 1);
        assert_eq!(take_usage_projected_bytes(), stable.len() + pending.len());
        assert_eq!(take_fingerprint_work(), (2, stable.len() + pending.len()));

        let writer = source.transaction()?;
        writer.execute(
            "UPDATE message SET data = ?1 WHERE id = 'pending'",
            [complete],
        )?;
        for _ in 0..3 {
            assert_eq!(sync_opencode_database(&db, &path)?.imported, 0);
        }
        assert_eq!(take_usage_projected_bytes(), 0);
        assert_eq!(
            take_fingerprint_work(),
            (6, 3 * (stable.len() + pending.len()))
        );

        writer.commit()?;
        assert_eq!(sync_opencode_database(&db, &path)?.imported, 1);
        assert_eq!(take_usage_projected_bytes(), complete.len());
        assert_eq!(take_fingerprint_work(), (2, stable.len() + complete.len()));
        Ok(())
    }

    #[test]
    fn opencode_usage_detects_replacement_with_same_size_and_timestamp() -> Result<(), AppError> {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("opencode.db");
        let replacement = temp.path().join("replacement.db");
        let db = Database::memory()?;
        let message =
            r#"{"role":"assistant","tokens":{"input":8},"time":{"created":100,"completed":200}}"#;
        for (source_path, message_id) in [(&path, "old"), (&replacement, "new")] {
            let source = create_opencode_source(source_path)?;
            source.execute("INSERT INTO session VALUES ('s1', 100)", [])?;
            source.execute(
                "INSERT INTO message VALUES (?1, 's1', 100, 200, ?2)",
                rusqlite::params![message_id, message],
            )?;
        }
        let before = fs::metadata(&path).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&replacement)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(before.modified().unwrap()))
            .unwrap();
        let after = fs::metadata(&replacement).unwrap();
        assert_eq!(before.len(), after.len());
        assert_eq!(before.modified().unwrap(), after.modified().unwrap());

        assert_eq!(sync_opencode_database(&db, &path)?.imported, 1);
        fs::remove_file(&path).unwrap();
        fs::rename(&replacement, &path).unwrap();
        assert_eq!(sync_opencode_database(&db, &path)?.imported, 1);
        assert_eq!(sync_opencode_database(&db, &path)?.imported, 0);
        Ok(())
    }

    #[test]
    fn opencode_usage_rolls_back_import_when_cursor_write_fails() -> Result<(), AppError> {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("opencode.db");
        let db = Database::memory()?;
        let source = create_opencode_source(&path)?;
        source.execute_batch(
            "INSERT INTO session VALUES ('s1', 100);
             INSERT INTO message VALUES (
                 'm1', 's1', 100, 200,
                 '{\"role\":\"assistant\",\"tokens\":{\"input\":8},\"time\":{\"created\":100,\"completed\":200}}'
             );",
        )?;
        lock_conn!(db.conn).execute_batch(
            "CREATE TRIGGER fail_sync BEFORE INSERT ON session_log_sync
             BEGIN SELECT RAISE(ABORT, 'fixture cursor error'); END;",
        )?;
        let failed = sync_opencode_database(&db, &path)?;
        assert_eq!(failed.imported, 0);
        assert_eq!(failed.errors.len(), 1);
        let rows = lock_conn!(db.conn).query_row(
            "SELECT COUNT(*) FROM proxy_request_logs WHERE data_source = 'opencode_session'",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        assert_eq!(rows, 0);
        lock_conn!(db.conn).execute_batch("DROP TRIGGER fail_sync")?;
        assert_eq!(sync_opencode_database(&db, &path)?.imported, 1);
        assert_eq!(sync_opencode_database(&db, &path)?.imported, 0);
        Ok(())
    }
}
