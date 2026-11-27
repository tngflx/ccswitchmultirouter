use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use rusqlite::Connection;
use serde_json::Value;

use crate::file_revision::FileRevision;
use crate::hermes_config::get_hermes_dir;
use crate::session_manager::{SessionMessage, SessionMeta};

use super::utils::{
    extract_text, parse_timestamp_to_ms, read_open_file_head_tail_lines, truncate_summary,
    FileCache, TITLE_MAX_CHARS,
};

const PROVIDER_ID: &str = "hermes";

static JSONL_SESSIONS: LazyLock<Mutex<FileCache<Option<SessionMeta>>>> =
    LazyLock::new(Mutex::default);

#[derive(Default)]
struct SqliteSessionCache {
    path: Option<PathBuf>,
    revision: Option<FileRevision>,
    sessions: Vec<SessionMeta>,
    #[cfg(test)]
    loads: usize,
}

static SQLITE_SESSIONS: LazyLock<Mutex<SqliteSessionCache>> = LazyLock::new(Mutex::default);

fn get_hermes_db_path() -> PathBuf {
    get_hermes_dir().join("state.db")
}

fn get_hermes_sessions_dir() -> PathBuf {
    get_hermes_dir().join("sessions")
}

/// Scan sessions from both SQLite database and JSONL transcript files,
/// with SQLite taking precedence on ID conflicts.
pub fn scan_sessions() -> Vec<SessionMeta> {
    let sqlite_sessions = scan_sessions_sqlite();
    let jsonl_sessions = scan_sessions_jsonl();

    if sqlite_sessions.is_empty() {
        return jsonl_sessions;
    }
    if jsonl_sessions.is_empty() {
        return sqlite_sessions;
    }

    let sqlite_ids: std::collections::HashSet<String> = sqlite_sessions
        .iter()
        .map(|s| s.session_id.clone())
        .collect();

    let mut merged = sqlite_sessions;
    for s in jsonl_sessions {
        if !sqlite_ids.contains(&s.session_id) {
            merged.push(s);
        }
    }
    merged
}

// ── SQLite scanning ─────────────────────────────────────────────────

fn scan_sessions_sqlite() -> Vec<SessionMeta> {
    let db_path = get_hermes_db_path();
    let mut cache = SQLITE_SESSIONS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    scan_sessions_sqlite_with_cache(&db_path, &mut cache)
}

fn scan_sessions_sqlite_with_cache(
    db_path: &Path,
    cache: &mut SqliteSessionCache,
) -> Vec<SessionMeta> {
    let revision = FileRevision::read(db_path);
    if revision.is_some() && cache.path.as_deref() == Some(db_path) && revision == cache.revision {
        return cache.sessions.clone();
    }

    let mut conn = match Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(c) => c,
        Err(_) => {
            cache.path = None;
            cache.revision = None;
            cache.sessions.clear();
            return Vec::new();
        }
    };

    if conn.busy_timeout(Duration::from_secs(2)).is_err() {
        cache.path = None;
        cache.revision = None;
        cache.sessions.clear();
        return Vec::new();
    }

    let snapshot = match conn.transaction() {
        Ok(snapshot) => snapshot,
        Err(_) => {
            cache.path = None;
            cache.revision = None;
            cache.sessions.clear();
            return Vec::new();
        }
    };
    if snapshot
        .query_row("SELECT count(*) FROM sqlite_schema", [], |_| Ok(()))
        .is_err()
    {
        cache.path = None;
        cache.revision = None;
        cache.sessions.clear();
        return Vec::new();
    }

    let journal_mode = snapshot
        .pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
        .unwrap_or_default();

    // Check if sessions table exists
    let has_sessions: bool = snapshot
        .query_row(
            "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='sessions'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);

    if !has_sessions {
        let rollback_journal = journal_mode.eq_ignore_ascii_case("delete")
            || journal_mode.eq_ignore_ascii_case("truncate")
            || journal_mode.eq_ignore_ascii_case("persist");
        let stable_revision = rollback_journal
            .then_some(revision)
            .flatten()
            .filter(|saved| FileRevision::read(db_path).as_ref() == Some(saved));
        cache.path = stable_revision.as_ref().map(|_| db_path.to_path_buf());
        cache.revision = stable_revision;
        cache.sessions.clear();
        return Vec::new();
    }

    // Query sessions — use flexible column access via pragma
    let columns = get_table_columns(&snapshot, "sessions");

    let query = "SELECT * FROM sessions ORDER BY rowid DESC LIMIT 500";
    let mut stmt = match snapshot.prepare(query) {
        Ok(s) => s,
        Err(_) => {
            cache.path = None;
            cache.revision = None;
            cache.sessions.clear();
            return Vec::new();
        }
    };

    let mut sessions = Vec::new();
    let rows = match stmt.query_map([], |row| Ok(row_to_json(row, &columns))) {
        Ok(r) => r,
        Err(_) => {
            cache.path = None;
            cache.revision = None;
            cache.sessions.clear();
            return Vec::new();
        }
    };

    let db_source = format!("sqlite:{}", db_path.display());

    for row_result in rows {
        match row_result {
            Ok(row) => {
                if let Some(meta) = sqlite_row_to_session_meta(&row, &db_source) {
                    sessions.push(meta);
                }
            }
            Err(_) => {
                cache.path = None;
                cache.revision = None;
                cache.sessions.clear();
                return Vec::new();
            }
        }
    }
    drop(stmt);
    drop(snapshot);

    let rollback_journal = journal_mode.eq_ignore_ascii_case("delete")
        || journal_mode.eq_ignore_ascii_case("truncate")
        || journal_mode.eq_ignore_ascii_case("persist");
    let stable_revision = rollback_journal
        .then_some(revision)
        .flatten()
        .filter(|saved| FileRevision::read(db_path).as_ref() == Some(saved));
    cache.path = stable_revision.as_ref().map(|_| db_path.to_path_buf());
    cache.revision = stable_revision;
    cache.sessions = if cache.revision.is_some() {
        sessions.clone()
    } else {
        Vec::new()
    };
    #[cfg(test)]
    {
        cache.loads += 1;
    }
    sessions
}

fn sqlite_row_to_session_meta(row: &Value, db_source: &str) -> Option<SessionMeta> {
    let obj = row.as_object()?;

    let session_id = obj.get("id").and_then(Value::as_str)?.to_string();

    let title = obj
        .get("title")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| truncate_summary(s, TITLE_MAX_CHARS).to_string());

    let cwd = obj
        .get("cwd")
        .or_else(|| obj.get("directory"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let started_at = obj
        .get("started_at")
        .or_else(|| obj.get("created_at"))
        .and_then(parse_timestamp_to_ms);

    let ended_at = obj
        .get("ended_at")
        .or_else(|| obj.get("updated_at"))
        .and_then(parse_timestamp_to_ms);

    let source_path = format!("{}#{}", db_source, session_id);

    Some(SessionMeta {
        provider_id: PROVIDER_ID.to_string(),
        session_id,
        title,
        summary: None,
        project_dir: cwd,
        created_at: started_at,
        last_active_at: ended_at.or(started_at),
        source_path: Some(source_path),
        resume_command: None,
    })
}

/// Get column names for a table.
fn get_table_columns(conn: &Connection, table: &str) -> Vec<String> {
    let query = format!("PRAGMA table_info({table})");
    let mut stmt = match conn.prepare(&query) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = match stmt.query_map([], |row| {
        let name: String = row.get(1)?;
        Ok(name)
    }) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    rows.flatten().collect()
}

/// Convert a SQLite row to a JSON Value using known column names.
fn row_to_json(row: &rusqlite::Row, columns: &[String]) -> Value {
    let mut map = serde_json::Map::new();
    for (i, col) in columns.iter().enumerate() {
        // Try string first, then integer, then float, then null
        if let Ok(val) = row.get::<_, String>(i) {
            map.insert(col.clone(), Value::String(val));
        } else if let Ok(val) = row.get::<_, i64>(i) {
            map.insert(col.clone(), Value::Number(val.into()));
        } else if let Ok(val) = row.get::<_, f64>(i) {
            if let Some(n) = serde_json::Number::from_f64(val) {
                map.insert(col.clone(), Value::Number(n));
            }
        } else {
            map.insert(col.clone(), Value::Null);
        }
    }
    Value::Object(map)
}

/// Load messages from the Hermes SQLite database.
pub fn load_messages_sqlite(source: &str) -> Result<Vec<SessionMessage>, String> {
    let (db_path, session_id) = parse_sqlite_source(source)
        .ok_or_else(|| format!("Invalid SQLite source reference: {source}"))?;

    let conn = Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("Failed to open Hermes database: {e}"))?;

    // Try querying with common column names
    let query =
        "SELECT role, content, created_at FROM messages WHERE session_id = ?1 ORDER BY created_at ASC";

    let mut stmt = conn
        .prepare(query)
        .map_err(|e| format!("Failed to prepare messages query: {e}"))?;

    let rows = stmt
        .query_map([session_id.as_str()], |row| {
            let role: String = row.get(0)?;
            let content: String = row.get(1)?;
            let ts: Option<i64> = row.get(2).ok();
            Ok((role, content, ts))
        })
        .map_err(|e| format!("Failed to query messages: {e}"))?;

    let mut messages = Vec::new();
    for row in rows.flatten() {
        let (role, content, ts) = row;
        if content.trim().is_empty() {
            continue;
        }
        let ts_ms = ts.and_then(|v| parse_timestamp_to_ms(&Value::Number(v.into())));
        messages.push(SessionMessage {
            role,
            content,
            ts: ts_ms,
        });
    }

    Ok(messages)
}

/// Delete a session from the Hermes SQLite database.
pub fn delete_session_sqlite(session_id: &str, source: &str) -> Result<bool, String> {
    let (db_path, ref_session_id) = parse_sqlite_source(source)
        .ok_or_else(|| format!("Invalid SQLite source reference: {source}"))?;
    let db_path = db_path
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize Hermes database path: {e}"))?;
    let expected_db_path = get_hermes_db_path()
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize expected Hermes database path: {e}"))?;

    if ref_session_id != session_id {
        return Err(format!(
            "Hermes SQLite session ID mismatch: expected {session_id}, found {ref_session_id}"
        ));
    }
    if db_path != expected_db_path {
        return Err("SQLite path does not match expected Hermes database".to_string());
    }

    let conn =
        Connection::open(&db_path).map_err(|e| format!("Failed to open Hermes database: {e}"))?;

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Failed to begin transaction: {e}"))?;

    // Delete messages first (child records)
    let _ = tx.execute("DELETE FROM messages WHERE session_id = ?1", [session_id]);

    let deleted = tx
        .execute("DELETE FROM sessions WHERE id = ?1", [session_id])
        .map_err(|e| format!("Failed to delete Hermes session: {e}"))?;

    tx.commit()
        .map_err(|e| format!("Failed to commit session deletion: {e}"))?;

    Ok(deleted > 0)
}

fn parse_sqlite_source(source: &str) -> Option<(PathBuf, String)> {
    let rest = source.strip_prefix("sqlite:")?;
    let hash_pos = rest.rfind('#')?;
    let db_path = PathBuf::from(&rest[..hash_pos]);
    let session_id = rest[hash_pos + 1..].to_string();
    if session_id.is_empty() {
        return None;
    }
    Some((db_path, session_id))
}

// ── JSONL scanning ──────────────────────────────────────────────────

fn scan_sessions_jsonl() -> Vec<SessionMeta> {
    let sessions_dir = get_hermes_sessions_dir();
    let mut cache = JSONL_SESSIONS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    cache.refresh(|cache| scan_sessions_jsonl_in_dir(&sessions_dir, cache))
}

fn scan_sessions_jsonl_in_dir(
    sessions_dir: &Path,
    cache: &mut FileCache<Option<SessionMeta>>,
) -> Vec<SessionMeta> {
    if !sessions_dir.exists() {
        return Vec::new();
    }

    let entries = match std::fs::read_dir(sessions_dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str());
        if ext != Some("jsonl") && ext != Some("json") {
            continue;
        }
        if let Some(meta) = cache
            .read(&path, |file| {
                Ok::<_, std::io::Error>(parse_jsonl_session_from_file(&path, file))
            })
            .flatten()
        {
            sessions.push(meta);
        }
    }
    sessions
}

#[cfg(test)]
fn parse_jsonl_session(path: &Path) -> Option<SessionMeta> {
    let mut file = File::open(path).ok()?;
    parse_jsonl_session_from_file(path, &mut file)
}

fn parse_jsonl_session_from_file(file_path: &Path, file: &mut File) -> Option<SessionMeta> {
    // Read head (metadata + first user message) and tail (last timestamp)
    let (head, tail) = read_open_file_head_tail_lines(file, 30, 10).ok()?;

    let mut first_user_msg: Option<String> = None;
    let mut first_ts: Option<i64> = None;
    let mut last_ts: Option<i64> = None;
    let mut session_id: Option<String> = None;
    let mut title: Option<String> = None;
    let mut cwd: Option<String> = None;

    // Process head lines for metadata and first user message
    for line in &head {
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let ts = value
            .get("timestamp")
            .or_else(|| value.get("ts"))
            .and_then(parse_timestamp_to_ms);

        if first_ts.is_none() {
            first_ts = ts;
        }
        last_ts = ts.or(last_ts);

        let line_type = value.get("type").and_then(Value::as_str).unwrap_or("");

        // Extract session metadata from session-type lines
        if line_type == "session" || line_type == "init" {
            if session_id.is_none() {
                session_id = value
                    .get("id")
                    .or_else(|| value.get("sessionId"))
                    .and_then(Value::as_str)
                    .map(|s| s.to_string());
            }
            if title.is_none() {
                title = value
                    .get("title")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
            }
            if cwd.is_none() {
                cwd = value
                    .get("cwd")
                    .or_else(|| value.get("directory"))
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
            }
        }

        if first_user_msg.is_none() {
            let role = value
                .get("role")
                .or_else(|| value.get("message").and_then(|m| m.get("role")))
                .and_then(Value::as_str);

            if role == Some("user") {
                let content = value
                    .get("content")
                    .or_else(|| value.get("message").and_then(|m| m.get("content")));
                if let Some(c) = content {
                    let text = extract_text(c);
                    if !text.trim().is_empty() {
                        first_user_msg = Some(truncate_summary(&text, TITLE_MAX_CHARS).to_string());
                    }
                }
            }
        }
    }

    // Process tail lines for the most recent timestamp
    for line in tail.iter().rev() {
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ts = value
            .get("timestamp")
            .or_else(|| value.get("ts"))
            .and_then(parse_timestamp_to_ms);
        if let Some(t) = ts {
            last_ts = Some(t);
            break;
        }
    }

    // Fall back to filename as session ID
    let session_id = session_id.unwrap_or_else(|| {
        file_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string()
    });

    let source_path = file_path.to_string_lossy().to_string();

    Some(SessionMeta {
        provider_id: PROVIDER_ID.to_string(),
        session_id,
        title: title.or_else(|| first_user_msg.clone()),
        summary: first_user_msg,
        project_dir: cwd,
        created_at: first_ts,
        last_active_at: last_ts.or(first_ts),
        source_path: Some(source_path),
        resume_command: None,
    })
}

/// Load messages from a Hermes JSONL transcript file.
pub fn load_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open session file: {e}"))?;
    let reader = BufReader::new(file);
    let mut messages = Vec::new();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // Support both flat messages and nested {type:"message", message:{...}} format
        let (role_val, content_val, ts_val) =
            if value.get("type").and_then(Value::as_str) == Some("message") {
                let msg = match value.get("message") {
                    Some(m) => m,
                    None => continue,
                };
                (
                    msg.get("role"),
                    msg.get("content"),
                    value.get("timestamp").or_else(|| msg.get("ts")),
                )
            } else {
                (
                    value.get("role"),
                    value.get("content"),
                    value.get("timestamp").or_else(|| value.get("ts")),
                )
            };

        let role = match role_val.and_then(Value::as_str) {
            Some(r) => r.to_string(),
            None => continue,
        };

        let content = content_val.map(extract_text).unwrap_or_default();
        if content.trim().is_empty() {
            continue;
        }

        let ts = ts_val.and_then(parse_timestamp_to_ms);
        messages.push(SessionMessage { role, content, ts });
    }

    Ok(messages)
}

/// Delete a Hermes JSONL session file.
pub fn delete_session(_root: &Path, path: &Path, _session_id: &str) -> Result<bool, String> {
    std::fs::remove_file(path).map_err(|e| {
        format!(
            "Failed to delete Hermes session file {}: {e}",
            path.display()
        )
    })?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn parse_sqlite_source_valid() {
        let (path, id) = parse_sqlite_source("sqlite:/home/user/.hermes/state.db#session-123")
            .expect("should parse");
        assert_eq!(path, PathBuf::from("/home/user/.hermes/state.db"));
        assert_eq!(id, "session-123");
    }

    #[test]
    fn parse_sqlite_source_invalid() {
        assert!(parse_sqlite_source("not-sqlite").is_none());
        assert!(parse_sqlite_source("sqlite:").is_none());
        assert!(parse_sqlite_source("sqlite:/path#").is_none());
    }

    #[test]
    fn parse_jsonl_session_extracts_metadata() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("test-session.jsonl");
        let mut f = File::create(&path).expect("create");
        writeln!(
            f,
            r#"{{"type":"session","id":"s1","title":"My Session","cwd":"/home/user/project"}}"#
        )
        .unwrap();
        writeln!(f, r#"{{"type":"message","message":{{"role":"user","content":"Hello world"}},"timestamp":"2026-01-01T00:00:00Z"}}"#).unwrap();
        writeln!(f, r#"{{"type":"message","message":{{"role":"assistant","content":"Hi there"}},"timestamp":"2026-01-01T00:01:00Z"}}"#).unwrap();
        f.flush().unwrap();

        let meta = parse_jsonl_session(&path).expect("should parse");
        assert_eq!(meta.session_id, "s1");
        assert_eq!(meta.title.as_deref(), Some("My Session"));
        assert_eq!(meta.project_dir.as_deref(), Some("/home/user/project"));
        assert!(meta.created_at.is_some());
        assert!(meta.last_active_at.is_some());
    }

    #[test]
    fn parse_jsonl_session_fallback_to_filename() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("my-session.jsonl");
        let mut f = File::create(&path).expect("create");
        writeln!(f, r#"{{"role":"user","content":"Hello","ts":1700000000}}"#).unwrap();
        f.flush().unwrap();

        let meta = parse_jsonl_session(&path).expect("should parse");
        assert_eq!(meta.session_id, "my-session");
        assert!(meta.title.is_some()); // Falls back to first user message
    }

    #[test]
    fn jsonl_listing_reuses_unchanged_metadata_and_reloads_revisions() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("cached-session.jsonl");
        std::fs::write(
            &path,
            "{\"type\":\"session\",\"id\":\"s1\",\"title\":\"First\"}\n",
        )
        .expect("write session");

        let mut cache = FileCache::default();
        for _ in 0..5 {
            let sessions = cache.refresh(|cache| scan_sessions_jsonl_in_dir(dir.path(), cache));
            assert_eq!(sessions.len(), 1);
            assert_eq!(sessions[0].title.as_deref(), Some("First"));
        }
        assert_eq!(cache.loads, 1);

        std::fs::write(
            &path,
            "{\"type\":\"session\",\"id\":\"s1\",\"title\":\"Second\"}\n",
        )
        .expect("rewrite session");
        let sessions = cache.refresh(|cache| scan_sessions_jsonl_in_dir(dir.path(), cache));
        assert_eq!(sessions[0].title.as_deref(), Some("Second"));
        assert_eq!(cache.loads, 2);
    }

    #[test]
    fn sqlite_listing_reuses_unchanged_rollback_snapshot() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("state.db");
        let conn = Connection::open(&path).expect("open database");
        conn.execute_batch(
            "CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                title TEXT,
                cwd TEXT,
                started_at TEXT,
                ended_at TEXT
            );
            INSERT INTO sessions VALUES (
                's1', 'First', '/tmp/project',
                '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z'
            );",
        )
        .expect("seed database");
        drop(conn);

        let mut cache = SqliteSessionCache::default();
        for _ in 0..5 {
            let sessions = scan_sessions_sqlite_with_cache(&path, &mut cache);
            assert_eq!(sessions.len(), 1);
            assert_eq!(sessions[0].title.as_deref(), Some("First"));
        }
        assert_eq!(cache.loads, 1);

        let conn = Connection::open(&path).expect("reopen database");
        conn.execute("UPDATE sessions SET title = 'Second'", [])
            .expect("rewrite database");
        drop(conn);
        let sessions = scan_sessions_sqlite_with_cache(&path, &mut cache);
        assert_eq!(sessions[0].title.as_deref(), Some("Second"));
        assert_eq!(cache.loads, 2);
    }

    #[test]
    fn load_messages_flat_format() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("session.jsonl");
        let mut f = File::create(&path).expect("create");
        writeln!(
            f,
            r#"{{"role":"user","content":"What is Rust?","ts":1700000000}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"role":"assistant","content":"A systems programming language.","ts":1700000001}}"#
        )
        .unwrap();
        f.flush().unwrap();

        let msgs = load_messages(&path).expect("should load");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[1].role, "assistant");
    }

    #[test]
    fn load_messages_nested_format() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("session.jsonl");
        let mut f = File::create(&path).expect("create");
        writeln!(f, r#"{{"type":"session","id":"s1"}}"#).unwrap();
        writeln!(f, r#"{{"type":"message","message":{{"role":"user","content":"Hello"}},"timestamp":"2026-01-01T00:00:00Z"}}"#).unwrap();
        writeln!(f, r#"{{"type":"message","message":{{"role":"assistant","content":"Hi"}},"timestamp":"2026-01-01T00:01:00Z"}}"#).unwrap();
        f.flush().unwrap();

        let msgs = load_messages(&path).expect("should load");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert!(msgs[0].ts.is_some());
    }

    #[test]
    fn delete_session_removes_file() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("session.jsonl");
        File::create(&path).expect("create");
        assert!(path.exists());

        delete_session(dir.path(), &path, "session").expect("should delete");
        assert!(!path.exists());
    }
}
