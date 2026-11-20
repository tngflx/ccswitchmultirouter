//! Locating Codex's per-thread state SQLite databases.
//!
//! Codex stores thread metadata in `state_5.sqlite`, normally inside the Codex
//! config dir (`CODEX_HOME` / `~/.codex`). The SQLite location can be moved with
//! the `sqlite_home` key in `config.toml` or the `CODEX_SQLITE_HOME` env var;
//! when set, a second DB lives there. Both history migration and the session
//! list's title lookup need the same resolution, so it lives here once.

use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use toml_edit::DocumentMut;

use crate::config::get_home_dir;
use crate::proxy::providers::codex_reasoning::CodexReasoningEffort;

/// Filename of Codex's per-thread state database. Codex bumps the version
/// number across releases; update this single source of truth when a new state
/// DB version ships.
pub(crate) const CODEX_STATE_DB_FILENAME: &str = "state_5.sqlite";

/// Env var that overrides the Codex SQLite state directory.
const CODEX_SQLITE_HOME_ENV: &str = "CODEX_SQLITE_HOME";
const SESSION_META_HEAD_BYTES: u64 = 1024 * 1024;
const ROLLOUT_READ_CHUNK_BYTES: usize = 64 * 1024;
const MAX_TURN_CONTEXT_LINE_BYTES: usize = 1024 * 1024;

/// Resolve every candidate `state_5.sqlite` path: the config-dir DB plus, when
/// Codex is configured to keep its SQLite state elsewhere, that DB too.
///
/// `config_dir` is the Codex config dir (`~/.codex`); `config_text` is the raw
/// `config.toml` contents, used to detect a `sqlite_home` override.
pub(crate) fn codex_state_db_paths(config_dir: &Path, config_text: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    push_unique_path(&mut paths, config_dir.join(CODEX_STATE_DB_FILENAME));
    // Codex lets SQLite state move away from CODEX_HOME; config takes precedence.
    if let Some(sqlite_home) = sqlite_home_from_codex_config(config_text) {
        push_unique_path(&mut paths, sqlite_home.join(CODEX_STATE_DB_FILENAME));
    } else if let Some(sqlite_home) = sqlite_home_from_env() {
        push_unique_path(&mut paths, sqlite_home.join(CODEX_STATE_DB_FILENAME));
    }
    paths
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.contains(&path) {
        paths.push(path);
    }
}

fn sqlite_home_from_codex_config(config_text: &str) -> Option<PathBuf> {
    let doc = config_text.parse::<DocumentMut>().ok()?;
    let raw = doc.get("sqlite_home")?.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    Some(resolve_user_path(raw))
}

fn sqlite_home_from_env() -> Option<PathBuf> {
    let raw = std::env::var(CODEX_SQLITE_HOME_ENV).ok()?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    Some(resolve_user_path(raw))
}

fn resolve_user_path(raw: &str) -> PathBuf {
    if raw == "~" {
        return get_home_dir();
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        return get_home_dir().join(rest);
    }
    if let Some(rest) = raw.strip_prefix("~\\") {
        return get_home_dir().join(rest);
    }
    PathBuf::from(raw)
}

/// Resolve the state DB currently used by Codex.
///
/// Configured `sqlite_home` and `CODEX_SQLITE_HOME` take precedence, then the
/// normal Codex root DB, with the legacy `sqlite/state_5.sqlite` subdirectory as
/// the final compatibility fallback.
pub(crate) fn resolve_active_codex_state_db_path(
    config_dir: &Path,
    config_text: &str,
) -> Option<PathBuf> {
    if let Some(sqlite_home) = sqlite_home_from_codex_config(config_text) {
        let configured = sqlite_home.join(CODEX_STATE_DB_FILENAME);
        if configured.exists() {
            return Some(configured);
        }
    } else if let Some(sqlite_home) = sqlite_home_from_env() {
        let configured = sqlite_home.join(CODEX_STATE_DB_FILENAME);
        if configured.exists() {
            return Some(configured);
        }
    }

    let codex_root = config_dir.join(CODEX_STATE_DB_FILENAME);
    if codex_root.exists() {
        return Some(codex_root);
    }

    let sqlite_default = config_dir.join("sqlite").join(CODEX_STATE_DB_FILENAME);
    if sqlite_default.exists() {
        return Some(sqlite_default);
    }

    None
}

/// Read the current model for a Codex thread from its active state DB.
///
/// The proxy only consults this for compaction requests, where Codex may carry
/// the previous model in the request body even though the thread's current model
/// has already switched. Returning `None` keeps the existing body-based routing.
pub(crate) fn codex_thread_model(session_id: &str) -> Option<String> {
    let (_, db_path) = active_codex_state_db()?;
    codex_thread_model_from_db(session_id, &db_path)
}

fn codex_thread_model_from_db(session_id: &str, db_path: &Path) -> Option<String> {
    let conn = open_read_only(db_path)?;
    conn.query_row(
        "SELECT model FROM threads WHERE id = ?1",
        [session_id],
        |row| row.get(0),
    )
    .ok()
}

fn active_codex_state_db() -> Option<(PathBuf, PathBuf)> {
    let config_dir = crate::codex_config::get_codex_config_dir();
    let config_path = crate::codex_config::get_codex_config_path();
    let config_text = fs::read_to_string(config_path).unwrap_or_default();
    let db_path = resolve_active_codex_state_db_path(&config_dir, &config_text)?;
    Some((config_dir, db_path))
}

fn open_read_only(db_path: &Path) -> Option<rusqlite::Connection> {
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(250));
    Some(conn)
}

/// Read the recorded logical effort for one exact turn from its active rollout.
pub(crate) fn codex_turn_reasoning_effort(
    thread_id: &str,
    turn_id: &str,
    model: &str,
) -> Option<CodexReasoningEffort> {
    let (config_dir, db_path) = active_codex_state_db()?;
    codex_turn_reasoning_effort_from_db(&config_dir, &db_path, thread_id, turn_id, model)
}

fn codex_turn_reasoning_effort_from_db(
    config_dir: &Path,
    db_path: &Path,
    thread_id: &str,
    turn_id: &str,
    model: &str,
) -> Option<CodexReasoningEffort> {
    if uuid::Uuid::parse_str(thread_id).ok()?.to_string() != thread_id
        || turn_id.is_empty()
        || model.is_empty()
    {
        return None;
    }

    let conn = open_read_only(db_path)?;
    let raw_path: String = conn
        .query_row(
            "SELECT rollout_path FROM threads WHERE id = ?1",
            [thread_id],
            |row| row.get(0),
        )
        .ok()?;
    let config_root = config_dir.canonicalize().ok()?;
    let sessions = config_dir.join("sessions").canonicalize().ok()?;
    if !sessions.starts_with(&config_root) || sessions == config_root {
        return None;
    }
    let raw_path = Path::new(&raw_path);
    if !raw_path.is_absolute() || !is_rollout_file_name(raw_path) {
        return None;
    }
    let rollout = raw_path.canonicalize().ok()?;
    if !rollout.starts_with(&sessions) || !is_rollout_file_name(&rollout) || !rollout.is_file() {
        return None;
    }

    let mut file = File::open(rollout).ok()?;
    if read_rollout_session_id(&mut file)?.as_str() != thread_id {
        return None;
    }
    read_turn_context_effort(file, turn_id, model)
}

fn is_rollout_file_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
}

fn read_rollout_session_id(file: &mut File) -> Option<String> {
    let mut reader = BufReader::new(file.take(SESSION_META_HEAD_BYTES));
    let mut line = Vec::new();
    reader.read_until(b'\n', &mut line).ok()?;
    if line.last() != Some(&b'\n') {
        return None;
    }
    let entry: serde_json::Value = serde_json::from_slice(&line).ok()?;
    if entry.get("type")?.as_str()? != "session_meta" {
        return None;
    }
    Some(entry.get("payload")?.get("id")?.as_str()?.to_owned())
}

fn read_turn_context_effort(
    mut file: File,
    turn_id: &str,
    model: &str,
) -> Option<CodexReasoningEffort> {
    let mut end = file.metadata().ok()?.len();
    let mut chunk = vec![0; ROLLOUT_READ_CHUNK_BYTES];
    let mut line = Vec::new();
    // A turn can span arbitrarily large tool outputs. Read backwards in bounded
    // chunks and discard oversized lines and the possibly incomplete EOF line.
    let mut discard_line = true;
    while end > 0 {
        let start = end.saturating_sub(chunk.len() as u64);
        let bytes = &mut chunk[..(end - start) as usize];
        file.seek(SeekFrom::Start(start)).ok()?;
        file.read_exact(bytes).ok()?;
        for (index, fragment) in bytes.rsplit(|byte| *byte == b'\n').enumerate() {
            if index > 0 {
                if !discard_line && !line.is_empty() {
                    line.reverse();
                    if let Some(effort) = matching_turn_context_effort(&line, turn_id, model) {
                        return effort;
                    }
                }
                line.clear();
                discard_line = false;
            }
            if !discard_line {
                if line.len() + fragment.len() <= MAX_TURN_CONTEXT_LINE_BYTES {
                    line.extend(fragment.iter().rev().copied());
                } else {
                    discard_line = true;
                }
            }
        }
        end = start;
    }
    // The first line has already been validated as session_meta.
    None
}

fn matching_turn_context_effort(
    line: &[u8],
    turn_id: &str,
    model: &str,
) -> Option<Option<CodexReasoningEffort>> {
    let entry: serde_json::Value = serde_json::from_slice(line).ok()?;
    let payload = entry.get("payload")?;
    if entry.get("type")?.as_str()? != "turn_context"
        || payload.get("turn_id")?.as_str()? != turn_id
        || payload.get("model")?.as_str()? != model
    {
        return None;
    }
    // A matching record with an absent/unknown effort supersedes older ones.
    Some(
        payload
            .get("effort")
            .and_then(serde_json::Value::as_str)
            .and_then(|effort| effort.parse().ok()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    const THREAD_ID: &str = "019c0000-0000-7000-8000-000000000001";
    const OTHER_THREAD_ID: &str = "019c0000-0000-7000-8000-000000000002";
    const MODEL: &str = "gpt-6.2-sol-sublyx";

    fn turn_context(turn_id: &str, model: &str, effort: &str) -> String {
        format!(
            "{}\n",
            json!({"type": "turn_context", "payload": {
                "turn_id": turn_id, "model": model, "effort": effort,
            }})
        )
    }

    fn session_meta(thread_id: &str) -> String {
        format!(
            "{}\n",
            json!({"type": "session_meta", "payload": {"id": thread_id}})
        )
    }

    fn rollout_in(directory: &Path) -> PathBuf {
        fs::create_dir_all(directory).expect("create rollout directory");
        directory.join("rollout-2026-11-20T12-30-00.jsonl")
    }

    fn state_db_with_rollout(config_dir: &Path, rollout: &Path) -> PathBuf {
        let db_path = config_dir.join(CODEX_STATE_DB_FILENAME);
        let conn = rusqlite::Connection::open(&db_path).expect("open fixture state db");
        conn.execute_batch("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT);")
            .expect("create state db tables");
        conn.execute(
            "INSERT INTO threads (id, rollout_path) VALUES (?1, ?2)",
            [THREAD_ID, rollout.to_str().expect("rollout fixture path")],
        )
        .expect("seed state db");
        db_path
    }

    #[test]
    fn includes_config_sqlite_home() {
        let temp = tempdir().expect("tempdir");
        let sqlite_home = temp.path().join("sqlite-home");
        // TOML literal strings preserve Windows backslashes without escape parsing.
        let config_text = format!("sqlite_home = '''{}'''\n", sqlite_home.display());

        let paths = codex_state_db_paths(temp.path(), &config_text);

        assert_eq!(
            paths,
            vec![
                temp.path().join(CODEX_STATE_DB_FILENAME),
                sqlite_home.join(CODEX_STATE_DB_FILENAME),
            ]
        );
    }

    #[test]
    fn active_state_db_prefers_configured_home_and_query_reads_thread_model() {
        let temp = tempdir().expect("tempdir");
        let sqlite_home = temp.path().join("sqlite-home");
        std::fs::create_dir_all(&sqlite_home).expect("create sqlite home");
        let db_path = sqlite_home.join(CODEX_STATE_DB_FILENAME);
        let conn = rusqlite::Connection::open(&db_path).expect("open state db");
        conn.execute_batch(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, model TEXT); \
             INSERT INTO threads (id, model) VALUES ('t1', 'deepseek-v4-flash');",
        )
        .expect("seed state db");
        drop(conn);

        let config_text = format!("sqlite_home = '''{}'''\n", sqlite_home.display());
        let active =
            resolve_active_codex_state_db_path(temp.path(), &config_text).expect("active state db");
        assert_eq!(active, db_path);
        assert_eq!(
            codex_thread_model_from_db("t1", &db_path).as_deref(),
            Some("deepseek-v4-flash")
        );
        assert_eq!(codex_thread_model_from_db("missing", &db_path), None);
    }

    #[test]
    fn active_state_db_prefers_codex_root_when_no_override() {
        let temp = tempdir().expect("tempdir");
        let db_path = temp.path().join(CODEX_STATE_DB_FILENAME);
        std::fs::write(&db_path, b"root").expect("write root state db");

        let active = resolve_active_codex_state_db_path(temp.path(), "").expect("active state db");
        assert_eq!(active, db_path);
    }

    #[test]
    fn finds_exact_turn_effort_without_writing_state_or_rollout() {
        let temp = tempdir().expect("tempdir");
        let rollout = rollout_in(&temp.path().join("sessions/2026/11/20"));
        let mut contents = session_meta(THREAD_ID);
        contents.push_str(&turn_context("ordinary", MODEL, "xhigh"));
        contents.push_str(&turn_context("target", MODEL, "ultra"));
        contents.push_str(&turn_context("other", MODEL, "max"));
        contents.push_str(&turn_context("target", "another-model", "low"));
        contents.push_str(&turn_context("unknown-effort", MODEL, "unknown"));
        // An in-progress append cannot override a prior complete record.
        contents.push_str(turn_context("target", MODEL, "high").trim_end());
        fs::write(&rollout, &contents).expect("write fixture rollout");
        let db_path = state_db_with_rollout(temp.path(), &rollout);
        let db_before = fs::read(&db_path).expect("read fixture db bytes");
        let lookup = |thread_id, turn_id, model| {
            codex_turn_reasoning_effort_from_db(temp.path(), &db_path, thread_id, turn_id, model)
        };

        assert_eq!(
            lookup(THREAD_ID, "target", MODEL),
            Some(CodexReasoningEffort::Ultra)
        );
        assert_eq!(
            lookup(THREAD_ID, "ordinary", MODEL),
            Some(CodexReasoningEffort::XHigh)
        );
        assert_eq!(lookup(THREAD_ID, "unknown-effort", MODEL), None);
        assert_eq!(lookup(THREAD_ID, "missing-turn", MODEL), None);
        assert_eq!(lookup(THREAD_ID, "target", "missing-model"), None);
        assert_eq!(lookup(OTHER_THREAD_ID, "target", MODEL), None);
        assert_eq!(fs::read(&db_path).expect("read state db"), db_before);
        assert_eq!(fs::read_to_string(rollout).expect("read rollout"), contents);
    }

    #[test]
    fn ignores_rollouts_outside_sessions_or_with_invalid_first_session_meta() {
        for (directory, first_line) in [
            ("outside", session_meta(THREAD_ID)),
            ("sessions", session_meta(OTHER_THREAD_ID)),
            (
                "sessions",
                "{\"type\":\"session_meta\",\"payload\":{}}\n".into(),
            ),
            ("sessions", turn_context("earlier", MODEL, "high")),
        ] {
            let temp = tempdir().expect("tempdir");
            let rollout = rollout_in(&temp.path().join(directory));
            fs::create_dir_all(temp.path().join("sessions")).expect("create sessions directory");
            let contents =
                first_line + &session_meta(THREAD_ID) + &turn_context("target", MODEL, "ultra");
            fs::write(&rollout, contents).expect("write rollout");
            let db_path = state_db_with_rollout(temp.path(), &rollout);

            assert_eq!(
                codex_turn_reasoning_effort_from_db(
                    temp.path(),
                    &db_path,
                    THREAD_ID,
                    "target",
                    MODEL
                ),
                None
            );
        }
    }

    #[test]
    fn finds_current_turn_effort_behind_a_large_tool_result() {
        let temp = tempdir().expect("tempdir");
        let rollout = rollout_in(&temp.path().join("sessions"));
        let mut contents = session_meta(THREAD_ID);
        contents.push_str(&turn_context("target", MODEL, "xhigh"));
        contents.push_str(&turn_context("target", MODEL, "ultra"));
        contents.push_str(
            &json!({"type": "response_item", "payload": {
                "type": "function_call_output", "output": "x".repeat(2 * 1024 * 1024),
            }})
            .to_string(),
        );
        contents.push('\n');
        contents.push_str(&turn_context("recent", MODEL, "max"));
        contents.push_str(turn_context("target", MODEL, "high").trim_end());
        fs::write(&rollout, contents).expect("write rollout");

        let open = || File::open(&rollout).expect("open rollout");
        assert_eq!(
            read_turn_context_effort(open(), "target", MODEL),
            Some(CodexReasoningEffort::Ultra)
        );
        assert_eq!(
            read_turn_context_effort(open(), "recent", MODEL),
            Some(CodexReasoningEffort::Max)
        );
    }
}
