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

const ROLLOUT_MARKER_OVERLAP_BYTES: usize = b"turn_context".len() - 1;

#[derive(Default)]
struct PendingRolloutLine {
    // Chunks are encountered newest-first. Only a chunk's leading fragment can
    // cross into the next read; retain its buffer rather than copy/reverse it.
    fragments: Vec<(Vec<u8>, usize)>,
    len: usize,
    has_marker: bool,
    head: [u8; ROLLOUT_MARKER_OVERLAP_BYTES],
    head_len: usize,
    discard: bool,
}

impl PendingRolloutLine {
    fn reset(&mut self, reusable: &mut Vec<Vec<u8>>) {
        reusable.extend(self.fragments.drain(..).map(|(chunk, _)| chunk));
        self.len = 0;
        self.has_marker = false;
        self.head_len = 0;
        self.discard = false;
    }

    fn marker_with_earlier(&self, earlier: &[u8]) -> bool {
        if self.has_marker || rollout_marker_in(earlier) {
            return true;
        }
        // This overlap only joins fragments of the same logical line. Reset at
        // every newline so marker bytes never join across separate JSON rows.
        let tail_len = earlier.len().min(ROLLOUT_MARKER_OVERLAP_BYTES);
        let mut boundary = [0; 2 * ROLLOUT_MARKER_OVERLAP_BYTES];
        boundary[..tail_len].copy_from_slice(&earlier[earlier.len() - tail_len..]);
        boundary[tail_len..tail_len + self.head_len].copy_from_slice(&self.head[..self.head_len]);
        rollout_marker_in(&boundary[..tail_len + self.head_len])
    }

    fn retain_prefix(&mut self, chunk: Vec<u8>, len: usize, reusable: &mut Vec<Vec<u8>>) {
        if self.discard || self.len + len > MAX_TURN_CONTEXT_LINE_BYTES {
            self.reset(reusable);
            self.discard = true;
            reusable.push(chunk);
            return;
        }
        if len == 0 {
            reusable.push(chunk);
            return;
        }
        let prefix = &chunk[..len];
        self.has_marker = self.marker_with_earlier(prefix);
        let mut head = [0; ROLLOUT_MARKER_OVERLAP_BYTES];
        let own_len = prefix.len().min(head.len());
        head[..own_len].copy_from_slice(&prefix[..own_len]);
        let carry_len = (head.len() - own_len).min(self.head_len);
        head[own_len..own_len + carry_len].copy_from_slice(&self.head[..carry_len]);
        self.head = head;
        self.head_len = own_len + carry_len;
        self.len += len;
        self.fragments.push((chunk, len));
        #[cfg(test)]
        record_rollout_proof_work(|work| {
            work.peak_retained_bytes = work
                .peak_retained_bytes
                .max(self.fragments.len() * ROLLOUT_READ_CHUNK_BYTES);
        });
    }

    fn matching_effort(
        &self,
        earlier: &[u8],
        turn_id: &str,
        model: &str,
    ) -> Option<Option<CodexReasoningEffort>> {
        let len = self.len + earlier.len();
        if self.discard
            || len == 0
            || len > MAX_TURN_CONTEXT_LINE_BYTES
            || !self.marker_with_earlier(earlier)
        {
            return None;
        }
        if self.fragments.is_empty() {
            return matching_turn_context_effort(earlier, turn_id, model);
        }
        // Only a candidate that spans read chunks needs a contiguous copy.
        // Parse exactly the bytes already screened; do not reread or cache proof.
        let mut line = Vec::with_capacity(len);
        line.extend_from_slice(earlier);
        for (chunk, used) in self.fragments.iter().rev() {
            line.extend_from_slice(&chunk[..*used]);
        }
        #[cfg(test)]
        record_rollout_proof_work(|work| work.assembled_bytes += line.len());
        matching_turn_context_effort(&line, turn_id, model)
    }
}

fn rollout_marker_in(bytes: &[u8]) -> bool {
    // A valid JSON string spelling turn_context contains either its literal
    // ASCII spelling or at least one ASCII Unicode escape beginning with \u00.
    memchr::memmem::find(bytes, b"turn_context").is_some()
        || memchr::memmem::find(bytes, br"\u00").is_some()
}

fn read_turn_context_effort(
    mut file: File,
    turn_id: &str,
    model: &str,
) -> Option<CodexReasoningEffort> {
    let mut end = file.metadata().ok()?.len();
    let mut reusable = Vec::new();
    let mut pending = PendingRolloutLine {
        // The EOF suffix is not a complete record, even when it looks like JSON.
        discard: true,
        ..Default::default()
    };
    while end > 0 {
        let mut chunk = reusable.pop().unwrap_or_else(|| {
            #[cfg(test)]
            record_rollout_proof_work(|work| work.chunks_allocated += 1);
            vec![0; ROLLOUT_READ_CHUNK_BYTES]
        });
        let start = end.saturating_sub(ROLLOUT_READ_CHUNK_BYTES as u64);
        let bytes = &mut chunk[..(end - start) as usize];
        file.seek(SeekFrom::Start(start)).ok()?;
        file.read_exact(bytes).ok()?;
        #[cfg(test)]
        record_rollout_proof_work(|work| work.read_bytes += bytes.len());

        let mut line_end = bytes.len();
        for newline in memchr::memrchr_iter(b'\n', bytes) {
            if let Some(effort) =
                pending.matching_effort(&bytes[newline + 1..line_end], turn_id, model)
            {
                // Some(None) is a latest exact record with unknown/absent
                // effort. It must deny proof rather than scan to an older Ultra.
                return effort;
            }
            pending.reset(&mut reusable);
            line_end = newline;
        }
        pending.retain_prefix(chunk, line_end, &mut reusable);
        end = start;
    }
    // The remaining first line was already validated as session_meta.
    None
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Default)]
struct RolloutProofWork {
    read_bytes: usize,
    chunks_allocated: usize,
    assembled_bytes: usize,
    json_bytes: usize,
    peak_retained_bytes: usize,
}

#[cfg(test)]
thread_local! {
    static ROLLOUT_PROOF_WORK: std::cell::Cell<RolloutProofWork> = const { std::cell::Cell::new(RolloutProofWork {
        read_bytes: 0,
        chunks_allocated: 0,
        assembled_bytes: 0,
        json_bytes: 0,
        peak_retained_bytes: 0,
    }) };
    static TURN_CONTEXT_JSON_PARSES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn record_rollout_proof_work(update: impl FnOnce(&mut RolloutProofWork)) {
    ROLLOUT_PROOF_WORK.with(|work| {
        let mut current = work.get();
        update(&mut current);
        work.set(current);
    });
}

fn matching_turn_context_effort(
    line: &[u8],
    turn_id: &str,
    model: &str,
) -> Option<Option<CodexReasoningEffort>> {
    let line = std::str::from_utf8(line).ok()?;
    // A JSON string spelling turn_context contains either the literal or a
    // Unicode escape for one of its ASCII characters. Only these lines can match.
    if !line.contains("turn_context") && !line.contains(r"\u00") {
        return None;
    }
    #[cfg(test)]
    {
        TURN_CONTEXT_JSON_PARSES.set(TURN_CONTEXT_JSON_PARSES.get() + 1);
        record_rollout_proof_work(|work| work.json_bytes += line.len());
    }
    let entry: serde_json::Value = serde_json::from_str(line).ok()?;
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
    fn rollout_effort_skips_json_parsing_for_replayed_tool_outputs() {
        let temp = tempdir().unwrap();
        let rollout = rollout_in(temp.path());
        let target_line = turn_context("target", MODEL, "ultra");

        for output_bytes in [128, 3 * ROLLOUT_READ_CHUNK_BYTES] {
            let mut contents = session_meta(THREAD_ID);
            contents.push_str(&target_line);
            let output = json!({"type":"response_item","payload":{
                "type":"function_call_output","output":"x".repeat(output_bytes)
            }})
            .to_string();
            assert!(output.len() < MAX_TURN_CONTEXT_LINE_BYTES);
            for _ in 0..24 {
                contents.push_str(&output);
                contents.push('\n');
            }
            fs::write(&rollout, &contents).unwrap();

            for _ in 0..3 {
                TURN_CONTEXT_JSON_PARSES.set(0);
                ROLLOUT_PROOF_WORK.set(RolloutProofWork::default());
                let effort =
                    read_turn_context_effort(File::open(&rollout).unwrap(), "target", MODEL);
                assert_eq!(effort, Some(CodexReasoningEffort::Ultra));
                assert_eq!(TURN_CONTEXT_JSON_PARSES.get(), 1);
                let work = ROLLOUT_PROOF_WORK.get();
                assert_eq!(work.read_bytes, contents.len());
                assert!(
                    work.chunks_allocated
                        <= MAX_TURN_CONTEXT_LINE_BYTES / ROLLOUT_READ_CHUNK_BYTES + 2,
                    "{work:?}"
                );
                assert!(
                    work.assembled_bytes <= target_line.trim_end().len(),
                    "{work:?}"
                );
                assert_eq!(work.json_bytes, target_line.trim_end().len());
                assert!(
                    work.peak_retained_bytes
                        <= MAX_TURN_CONTEXT_LINE_BYTES + ROLLOUT_READ_CHUNK_BYTES,
                    "{work:?}"
                );
            }
        }
    }

    fn reference_rollout_effort(
        contents: &[u8],
        turn: &str,
        model: &str,
    ) -> Option<CodexReasoningEffort> {
        let mut effort = None;
        for line in contents.split_inclusive(|byte| *byte == b'\n').skip(1) {
            if line.last() != Some(&b'\n') || line.len() - 1 > MAX_TURN_CONTEXT_LINE_BYTES {
                continue;
            }
            let Ok(entry) = serde_json::from_slice::<serde_json::Value>(line) else {
                continue;
            };
            if entry.get("type").and_then(serde_json::Value::as_str) != Some("turn_context")
                || entry
                    .pointer("/payload/turn_id")
                    .and_then(serde_json::Value::as_str)
                    != Some(turn)
                || entry
                    .pointer("/payload/model")
                    .and_then(serde_json::Value::as_str)
                    != Some(model)
            {
                continue;
            }
            effort = entry
                .pointer("/payload/effort")
                .and_then(serde_json::Value::as_str)
                .and_then(|effort| effort.parse().ok());
        }
        effort
    }

    #[test]
    fn rollout_effort_screens_literal_and_escaped_markers_across_chunk_boundaries() {
        let temp = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
        let rollout = rollout_in(temp.path());
        for (marker, line) in [
            ("turn_context", turn_context("target", MODEL, "ultra")),
            (
                r"\u00",
                turn_context("target", MODEL, "ultra")
                    .replace("turn_context", r"tu\u0072n_context"),
            ),
        ] {
            for split in 0..=marker.len() {
                let mut contents = session_meta(THREAD_ID);
                let boundary = contents.len() + line.find(marker).unwrap() + split;
                contents.push_str(&line);
                let tail = "{\"type\":\"response_item\",\"payload\":\"";
                let end = "\"}\n";
                let padding = (boundary + ROLLOUT_READ_CHUNK_BYTES
                    - (contents.len() + tail.len() + end.len()) % ROLLOUT_READ_CHUNK_BYTES)
                    % ROLLOUT_READ_CHUNK_BYTES;
                contents.push_str(tail);
                contents.push_str(&"x".repeat(padding + ROLLOUT_READ_CHUNK_BYTES));
                contents.push_str(end);
                assert_eq!((contents.len() - boundary) % ROLLOUT_READ_CHUNK_BYTES, 0);
                fs::write(&rollout, &contents).unwrap();
                TURN_CONTEXT_JSON_PARSES.set(0);
                ROLLOUT_PROOF_WORK.set(RolloutProofWork::default());
                assert_eq!(
                    reference_rollout_effort(contents.as_bytes(), "target", MODEL),
                    Some(CodexReasoningEffort::Ultra)
                );
                assert_eq!(
                    read_turn_context_effort(File::open(&rollout).unwrap(), "target", MODEL),
                    Some(CodexReasoningEffort::Ultra)
                );
                assert_eq!(TURN_CONTEXT_JSON_PARSES.get(), 1);
                assert!(ROLLOUT_PROOF_WORK.get().assembled_bytes <= line.len());
            }
        }
    }

    #[test]
    fn rollout_effort_matches_reference_at_line_limits_and_delimiter_edges() {
        let temp = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
        let rollout = rollout_in(temp.path());
        let mut contents = session_meta(THREAD_ID);
        contents.push_str(&turn_context("target", MODEL, "high"));
        let mut exact = turn_context("target", MODEL, "ultra").trim_end().to_owned();
        exact.push_str(&" ".repeat(MAX_TURN_CONTEXT_LINE_BYTES - exact.len()));
        contents.push_str(&exact);
        contents.push('\n');
        let mut oversized = turn_context("target", MODEL, "low").trim_end().to_owned();
        oversized.push_str(&" ".repeat(MAX_TURN_CONTEXT_LINE_BYTES + 1 - oversized.len()));
        contents.push_str(&oversized);
        contents.push('\n');
        // A malformed newer candidate must not hide the last valid exact row.
        contents.push_str("{\"type\":\"turn_context\",not-json}\n\n");
        for suffix in ["", "\n", "{\"type\":\"turn_context\"}"] {
            let fixture = format!("{contents}{suffix}");
            fs::write(&rollout, fixture.as_bytes()).unwrap();
            assert_eq!(
                reference_rollout_effort(fixture.as_bytes(), "target", MODEL),
                Some(CodexReasoningEffort::Ultra)
            );
            assert_eq!(
                read_turn_context_effort(File::open(&rollout).unwrap(), "target", MODEL),
                Some(CodexReasoningEffort::Ultra)
            );
        }
        for effort in [serde_json::Value::Null, json!(17), json!("future-tier")] {
            let latest = json!({"type":"turn_context","payload": {
                "turn_id":"target", "model":MODEL, "effort":effort
            }});
            let fixture = format!("{contents}{latest}\n");
            fs::write(&rollout, fixture.as_bytes()).unwrap();
            assert_eq!(
                reference_rollout_effort(fixture.as_bytes(), "target", MODEL),
                None
            );
            assert_eq!(
                read_turn_context_effort(File::open(&rollout).unwrap(), "target", MODEL),
                None
            );
        }
        let absent = json!({"type":"turn_context","payload": {"turn_id":"target", "model":MODEL}});
        let fixture = format!("{contents}{absent}\n");
        fs::write(&rollout, fixture.as_bytes()).unwrap();
        assert_eq!(
            reference_rollout_effort(fixture.as_bytes(), "target", MODEL),
            None
        );
        assert_eq!(
            read_turn_context_effort(File::open(&rollout).unwrap(), "target", MODEL),
            None
        );
        // End a record exactly at each side of a reverse-read boundary.
        for length in [
            ROLLOUT_READ_CHUNK_BYTES - 1,
            ROLLOUT_READ_CHUNK_BYTES,
            ROLLOUT_READ_CHUNK_BYTES + 1,
        ] {
            let mut fixture = session_meta(THREAD_ID);
            fixture.push_str(&turn_context("target", MODEL, "ultra"));
            fixture.push_str(&"\n".repeat(length));
            fs::write(&rollout, fixture.as_bytes()).unwrap();
            assert_eq!(
                read_turn_context_effort(File::open(&rollout).unwrap(), "target", MODEL),
                reference_rollout_effort(fixture.as_bytes(), "target", MODEL)
            );
        }
    }

    #[test]
    fn rollout_effort_fresh_lookup_observes_same_stamp_rewrites_appends_and_replacement() {
        use std::io::Write;
        let temp = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
        let rollout = rollout_in(&temp.path().join("sessions"));
        let contents = session_meta(THREAD_ID)
            + &turn_context("target", MODEL, "ultra")
            + &turn_context("other_", MODEL, "low");
        fs::write(&rollout, session_meta(THREAD_ID)).unwrap();
        let db_path = state_db_with_rollout(temp.path(), &rollout);
        let lookup = || {
            codex_turn_reasoning_effort_from_db(temp.path(), &db_path, THREAD_ID, "target", MODEL)
        };
        assert_eq!(lookup(), None);
        let mut initial_append = fs::OpenOptions::new().append(true).open(&rollout).unwrap();
        initial_append
            .write_all(&contents.as_bytes()[session_meta(THREAD_ID).len()..])
            .unwrap();
        initial_append.flush().unwrap();
        drop(initial_append);
        assert_eq!(lookup(), Some(CodexReasoningEffort::Ultra));
        let stamp =
            filetime::FileTime::from_last_modification_time(&fs::metadata(&rollout).unwrap());
        let rewritten = contents.replace("other_", "target");
        assert_eq!(rewritten.len(), contents.len());
        fs::write(&rollout, &rewritten).unwrap();
        filetime::set_file_mtime(&rollout, stamp).unwrap();
        assert_eq!(lookup(), Some(CodexReasoningEffort::Low));
        assert_eq!(lookup(), Some(CodexReasoningEffort::Low));
        let mut writer = fs::OpenOptions::new().append(true).open(&rollout).unwrap();
        writer
            .write_all(turn_context("target", MODEL, "high").trim_end().as_bytes())
            .unwrap();
        writer.flush().unwrap();
        assert_eq!(lookup(), Some(CodexReasoningEffort::Low));
        writer.write_all(b"\n").unwrap();
        writer.flush().unwrap();
        drop(writer);
        assert_eq!(lookup(), Some(CodexReasoningEffort::High));
        let replacement = rollout.with_file_name("rollout-replacement.jsonl");
        fs::write(
            &replacement,
            session_meta(THREAD_ID) + &turn_context("target", MODEL, "xhigh"),
        )
        .unwrap();
        fs::remove_file(&rollout).unwrap();
        fs::rename(&replacement, &rollout).unwrap();
        assert_eq!(lookup(), Some(CodexReasoningEffort::XHigh));
        let relocated = rollout.with_file_name("rollout-relocated.jsonl");
        fs::write(
            &relocated,
            session_meta(THREAD_ID) + &turn_context("target", MODEL, "max"),
        )
        .unwrap();
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute(
            "UPDATE threads SET rollout_path = ?1 WHERE id = ?2",
            [relocated.to_str().unwrap(), THREAD_ID],
        )
        .unwrap();
        drop(conn);
        assert_eq!(lookup(), Some(CodexReasoningEffort::Max));
        fs::write(
            &relocated,
            session_meta(OTHER_THREAD_ID) + &turn_context("target", MODEL, "ultra"),
        )
        .unwrap();
        assert_eq!(lookup(), None);
    }

    #[test]
    fn rollout_effort_respects_escaped_keys_duplicate_types_and_latest_unknown_effort() {
        let temp = tempdir().unwrap();
        let rollout = rollout_in(temp.path());
        let mut contents = session_meta(THREAD_ID);
        contents.push_str(&turn_context("target", "m", "high"));
        contents.push_str(concat!(
            r#"{"type":"response_item","ty\u0070e":"tu\u0072n_context","pay\u006coad":{"turn_id":"target","model":"m","effort":"ultra"}}"#,
            "\n",
            r#"{"type":"turn_context","type":"event_msg","payload":{"turn_id":"target","model":"m","effort":"low"}}"#,
            "\n",
            r#"{"type":"response_item","payload":{"type":"turn_context","turn_id":"target","model":"m","effort":"low"}}"#,
            "\n"
        ));
        fs::write(&rollout, &contents).unwrap();
        let read = || read_turn_context_effort(File::open(&rollout).unwrap(), "target", "m");
        assert_eq!(read(), Some(CodexReasoningEffort::Ultra));

        contents.push_str(&turn_context("target", "m", "future-tier"));
        fs::write(&rollout, contents).unwrap();
        assert_eq!(read(), None);
    }

    #[test]
    fn rollout_effort_rejects_malformed_candidate_records() {
        let temp = tempdir().unwrap();
        let rollout = rollout_in(temp.path());
        let mut contents = session_meta(THREAD_ID).into_bytes();
        contents.extend_from_slice(turn_context("target", "m", "high").as_bytes());
        let prefix = br#"{"type":"turn_context","payload":{"turn_id":"target","model":"m","effort":"ultra"},"other":"#;
        for malformed in [
            b"1e9999".to_vec(),
            [b"\"".as_slice(), &[0xff], b"\""].concat(),
            format!("{}0{}", "[".repeat(150), "]".repeat(150)).into_bytes(),
        ] {
            contents.extend_from_slice(prefix);
            contents.extend_from_slice(&malformed);
            contents.extend_from_slice(b"}\n");
        }
        fs::write(&rollout, contents).unwrap();
        assert_eq!(
            read_turn_context_effort(File::open(&rollout).unwrap(), "target", "m"),
            Some(CodexReasoningEffort::High)
        );
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
