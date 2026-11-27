use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use regex::Regex;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::Value;

use crate::codex_config::{get_codex_config_dir, read_codex_config_text};
use crate::codex_state_db::codex_state_db_paths;
use crate::file_revision::FileRevision;
use crate::session_manager::{SessionMessage, SessionMeta};

use super::utils::{
    extract_text, parse_timestamp_to_ms, path_basename, read_head_tail_lines,
    read_open_file_head_tail_lines, truncate_summary, FileCache, TITLE_MAX_CHARS,
};

const PROVIDER_ID: &str = "codex";
const CODEX_SESSION_INDEX_FILENAME: &str = "session_index.jsonl";
const VSCODE_CONTEXT_PREFIX: &str = "# Context from my IDE setup:";
const CODEX_REQUEST_MARKER: &str = "my request for codex";

static SESSION_LISTING: LazyLock<Mutex<SessionListing>> = LazyLock::new(Mutex::default);

static UUID_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
        .unwrap()
});

#[derive(Deserialize)]
struct SessionIndexEntry {
    id: String,
    thread_name: String,
}

pub fn scan_sessions() -> Vec<SessionMeta> {
    let roots = session_roots();
    let config_dir = get_codex_config_dir();
    let config_text = read_codex_config_text().unwrap_or_default();
    let db_paths = codex_state_db_paths(&config_dir, &config_text);
    SESSION_LISTING
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .scan(
            &roots,
            &config_dir.join(CODEX_SESSION_INDEX_FILENAME),
            &db_paths,
        )
}

pub fn session_roots() -> Vec<PathBuf> {
    let config_dir = get_codex_config_dir();
    vec![
        config_dir.join("sessions"),
        config_dir.join("archived_sessions"),
    ]
}

pub(crate) fn archived_session_files() -> Vec<PathBuf> {
    let archived_root = get_codex_config_dir().join("archived_sessions");
    let mut files = Vec::new();
    collect_jsonl_files(&archived_root, &mut files);
    files.sort();
    files
}

pub(crate) fn session_id_for_delete(path: &Path) -> Option<String> {
    let (head, _) = read_head_tail_lines(path, 20, 0).ok()?;
    for line in head {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        if let Some(session_id) = value
            .pointer("/payload/id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            return Some(session_id.to_string());
        }
    }
    infer_session_id_from_filename(path)
}

pub(crate) fn validate_session_id(path: &Path, session_id: &str) -> Result<(), String> {
    let actual_session_id = session_id_for_delete(path).ok_or_else(|| {
        format!(
            "Failed to read Codex session ID from file {}",
            path.display()
        )
    })?;
    if actual_session_id != session_id {
        return Err(format!(
            "Codex session ID mismatch: expected {session_id}, found {actual_session_id}"
        ));
    }
    Ok(())
}

type ThreadTitles = HashMap<String, String>;

#[derive(Default)]
struct SessionListing {
    sessions: FileCache<Option<SessionMeta>>,
    title_index: FileCache<Arc<ThreadTitles>>,
    db_titles: HashMap<PathBuf, (FileRevision, Arc<ThreadTitles>)>,
    #[cfg(test)]
    title_queries: usize,
}

impl SessionListing {
    fn scan(&mut self, roots: &[PathBuf], index: &Path, db_paths: &[PathBuf]) -> Vec<SessionMeta> {
        let index_titles = self.title_index.refresh(|cache| {
            cache.read(index, |file| {
                read_thread_title_index(BufReader::new(file)).map(Arc::new)
            })
        });
        self.db_titles.retain(|path, _| db_paths.contains(path));
        let title_sources = db_paths
            .iter()
            .rev()
            .filter_map(|path| self.load_db_titles(path))
            .chain(index_titles)
            .collect::<Vec<_>>();

        let mut files = Vec::new();
        for root in roots {
            collect_jsonl_files(root, &mut files);
        }

        self.sessions.refresh(|cache| {
            files
                .into_iter()
                .filter_map(|path| {
                    let mut meta = cache.read(&path, |file| parse_open_session(&path, file))??;
                    if let Some(title) = title_sources
                        .iter()
                        .find_map(|titles| titles.get(&meta.session_id))
                    {
                        meta.title = Some(title.clone());
                    }
                    Some(meta)
                })
                .collect()
        })
    }

    fn load_db_titles(&mut self, path: &Path) -> Option<Arc<ThreadTitles>> {
        let revision = cacheable_db_revision(path);
        if let Some((saved, titles)) = self.db_titles.get(path) {
            if revision.as_ref() == Some(saved) {
                return Some(Arc::clone(titles));
            }
        }
        self.db_titles.remove(path);
        #[cfg(test)]
        {
            self.title_queries += 1;
        }
        let loaded = load_thread_titles_from_db_snapshot(path)?;
        let titles = Arc::new(loaded.titles);
        if let Some(revision) = loaded.cache_revision {
            self.db_titles
                .insert(path.to_path_buf(), (revision, Arc::clone(&titles)));
        }
        Some(titles)
    }
}

struct LoadedThreadTitles {
    titles: ThreadTitles,
    cache_revision: Option<FileRevision>,
}

fn cacheable_db_revision(path: &Path) -> Option<FileRevision> {
    FileRevision::read(path)
}

fn read_thread_title_index(mut reader: impl BufRead) -> io::Result<ThreadTitles> {
    let mut titles = HashMap::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line)? == 0 {
            break;
        }
        let Ok(line) = std::str::from_utf8(&line) else {
            continue;
        };
        let Ok(entry) = serde_json::from_str::<SessionIndexEntry>(line.trim()) else {
            continue;
        };
        let id = entry.id.trim();
        let title = entry.thread_name.trim();
        if !id.is_empty() && !title.is_empty() {
            titles.insert(id.to_string(), truncate_summary(title, TITLE_MAX_CHARS));
        }
    }

    Ok(titles)
}

#[cfg(test)]
fn load_thread_titles_from_db(db_path: &Path) -> Option<ThreadTitles> {
    Some(load_thread_titles_from_db_snapshot(db_path)?.titles)
}

fn load_thread_titles_from_db_snapshot(db_path: &Path) -> Option<LoadedThreadTitles> {
    if !db_path.exists() {
        return None;
    }

    let revision_before_open = FileRevision::read(db_path);
    let conn = match Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(conn) => conn,
        Err(err) => {
            log::warn!(
                "Failed to open Codex state database {}: {err}",
                db_path.display()
            );
            return None;
        }
    };
    // Codex keeps this DB open and write-locked while running; without a busy
    // timeout a read during a write fails immediately and titles silently drop.
    if let Err(err) = conn.busy_timeout(Duration::from_secs(2)) {
        log::warn!(
            "Failed to set Codex state database busy timeout for {}: {err}",
            db_path.display()
        );
        return None;
    }

    let mut conn = conn;
    let snapshot = match conn.transaction() {
        Ok(snapshot) => snapshot,
        Err(err) => {
            log::warn!(
                "Failed to start Codex state database snapshot for {}: {err}",
                db_path.display()
            );
            return None;
        }
    };
    if let Err(err) = snapshot.query_row("SELECT count(*) FROM sqlite_schema", [], |_| Ok(())) {
        log::warn!(
            "Failed to pin Codex state database snapshot for {}: {err}",
            db_path.display()
        );
        return None;
    }
    let journal_mode: String =
        match snapshot.pragma_query_value(None, "journal_mode", |row| row.get(0)) {
            Ok(mode) => mode,
            Err(err) => {
                log::warn!(
                    "Failed to inspect Codex state database journal mode for {}: {err}",
                    db_path.display()
                );
                return None;
            }
        };

    // Mirror Codex's own `distinct_thread_metadata_title`: keep a title only
    // when it differs from the first user message. Push the comparison into SQL
    // (NULL-safe) so we never SELECT the unbounded `first_user_message` blob —
    // it can grow large enough to OOM (openai/codex#29007).
    let mut stmt = match snapshot.prepare(
        "SELECT id, title FROM threads \
         WHERE title <> '' \
         AND (first_user_message IS NULL OR TRIM(title) <> TRIM(first_user_message))",
    ) {
        Ok(stmt) => stmt,
        Err(err) => {
            log::warn!(
                "Failed to prepare Codex thread title query for {}: {err}",
                db_path.display()
            );
            return None;
        }
    };

    let mut rows = match stmt.query([]) {
        Ok(rows) => rows,
        Err(err) => {
            log::warn!(
                "Failed to query Codex thread titles from {}: {err}",
                db_path.display()
            );
            return None;
        }
    };

    let mut titles = HashMap::new();
    while let Some(row) = rows.next().ok()? {
        let (Ok(id), Ok(title)) = (row.get_ref(0), row.get_ref(1)) else {
            continue;
        };
        let (Ok(id), Ok(title)) = (id.as_str(), title.as_str()) else {
            continue;
        };
        let id = id.trim();
        let title = title.trim();
        if !id.is_empty() && !title.is_empty() {
            titles.insert(id.to_string(), truncate_summary(title, TITLE_MAX_CHARS));
        }
    }
    drop(rows);
    drop(stmt);
    let cache_revision = if matches!(journal_mode.as_str(), "delete" | "truncate" | "persist") {
        revision_before_open
            .filter(|revision| FileRevision::read(db_path).as_ref() == Some(revision))
    } else {
        None
    };

    Some(LoadedThreadTitles {
        titles,
        cache_revision,
    })
}

pub fn load_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open session file: {e}"))?;
    let reader = BufReader::new(file);
    let mut messages: Vec<SessionMessage> = Vec::new();

    for line in reader.lines() {
        let line = match line {
            Ok(value) => value,
            Err(_) => continue,
        };
        let value: Value = match serde_json::from_str(&line) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };

        let payload = match value.get("payload") {
            Some(payload) => payload,
            None => continue,
        };
        let envelope_type = value.get("type").and_then(Value::as_str);
        let payload_type = payload.get("type").and_then(Value::as_str);

        // Visible history is reconstructed from authoritative user events and final
        // assistant messages. response_item user/developer records are model-input
        // transcripts and function items are tool plumbing, not ordinary chat rows.
        let (role, content) = match (envelope_type, payload_type) {
            (Some("event_msg"), Some("user_message")) => (
                "user".to_string(),
                payload
                    .get("message")
                    .or_else(|| payload.get("text"))
                    .and_then(Value::as_str)
                    .and_then(crate::codex_history_migration::visible_rollout_user_message)
                    .unwrap_or_default(),
            ),
            (Some("event_msg"), Some("item_completed"))
                if payload.pointer("/item/type").and_then(Value::as_str)
                    == Some("user_message") =>
            {
                (
                    "user".to_string(),
                    crate::codex_history_migration::visible_rollout_user_message(
                        &payload
                            .pointer("/item/content")
                            .map(extract_text)
                            .unwrap_or_default(),
                    )
                    .unwrap_or_default(),
                )
            }
            (Some("response_item"), Some("message"))
                if payload.get("role").and_then(Value::as_str) == Some("assistant") =>
            {
                (
                    "assistant".to_string(),
                    payload.get("content").map(extract_text).unwrap_or_default(),
                )
            }
            (Some("response_item"), Some("message"))
                if payload.get("role").and_then(Value::as_str) == Some("user") =>
            {
                (
                    "user".to_string(),
                    crate::codex_history_migration::visible_rollout_user_message(
                        &payload.get("content").map(extract_text).unwrap_or_default(),
                    )
                    .unwrap_or_default(),
                )
            }
            _ => continue,
        };

        if content.trim().is_empty() {
            continue;
        }

        let ts = value.get("timestamp").and_then(parse_timestamp_to_ms);

        if messages
            .last()
            .is_some_and(|previous| previous.role == role && previous.content == content)
        {
            continue;
        }
        messages.push(SessionMessage { role, content, ts });
    }

    Ok(messages)
}

pub fn delete_session(_root: &Path, path: &Path, session_id: &str) -> Result<bool, String> {
    validate_session_id(path, session_id)?;

    std::fs::remove_file(path).map_err(|e| {
        format!(
            "Failed to delete Codex session file {}: {e}",
            path.display()
        )
    })?;

    Ok(true)
}

#[cfg(test)]
fn parse_session(path: &Path) -> Option<SessionMeta> {
    parse_open_session(path, &mut File::open(path).ok()?)
        .ok()
        .flatten()
}

fn parse_open_session(path: &Path, file: &mut File) -> io::Result<Option<SessionMeta>> {
    let (head, tail) = read_open_file_head_tail_lines(file, 10, 30)?;

    let mut session_id: Option<String> = None;
    let mut project_dir: Option<String> = None;
    let mut created_at: Option<i64> = None;
    let mut first_user_message: Option<String> = None;

    // Extract metadata and first user message from head lines
    for line in &head {
        let value: Value = match serde_json::from_str(line) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        if created_at.is_none() {
            created_at = value.get("timestamp").and_then(parse_timestamp_to_ms);
        }
        if value.get("type").and_then(Value::as_str) == Some("session_meta") {
            if let Some(payload) = value.get("payload") {
                if is_subagent_source(payload.get("source")) {
                    return Ok(None);
                }
                if session_id.is_none() {
                    session_id = payload
                        .get("id")
                        .and_then(Value::as_str)
                        .map(|s| s.to_string());
                }
                if project_dir.is_none() {
                    project_dir = payload
                        .get("cwd")
                        .and_then(Value::as_str)
                        .map(|s| s.to_string());
                }
                if let Some(ts) = payload.get("timestamp").and_then(parse_timestamp_to_ms) {
                    created_at.get_or_insert(ts);
                }
            }
        }
        // Extract first user message as title candidate
        if first_user_message.is_none()
            && value.get("type").and_then(Value::as_str) == Some("response_item")
        {
            if let Some(payload) = value.get("payload") {
                if payload.get("type").and_then(Value::as_str) == Some("message")
                    && payload.get("role").and_then(Value::as_str) == Some("user")
                {
                    let text = payload.get("content").map(extract_text).unwrap_or_default();
                    if let Some(title) = title_candidate_from_user_message(&text) {
                        first_user_message = Some(title);
                    }
                }
            }
        }
        if session_id.is_some()
            && project_dir.is_some()
            && created_at.is_some()
            && first_user_message.is_some()
        {
            break;
        }
    }

    // Extract last_active_at and summary from tail lines (reverse order)
    let mut last_active_at: Option<i64> = None;
    let mut summary: Option<String> = None;

    for line in tail.iter().rev() {
        let value: Value = match serde_json::from_str(line) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        if last_active_at.is_none() {
            last_active_at = value.get("timestamp").and_then(parse_timestamp_to_ms);
        }
        if summary.is_none() && value.get("type").and_then(Value::as_str) == Some("response_item") {
            if let Some(payload) = value.get("payload") {
                if payload.get("type").and_then(Value::as_str) == Some("message") {
                    let text = payload.get("content").map(extract_text).unwrap_or_default();
                    if !text.trim().is_empty() {
                        summary = Some(text);
                    }
                }
            }
        }
        if last_active_at.is_some() && summary.is_some() {
            break;
        }
    }

    let Some(session_id) = session_id.or_else(|| infer_session_id_from_filename(path)) else {
        return Ok(None);
    };

    let title = first_user_message
        .map(|t| truncate_summary(&t, TITLE_MAX_CHARS))
        .or_else(|| {
            project_dir
                .as_deref()
                .and_then(path_basename)
                .map(|v| v.to_string())
        });

    let summary = summary.map(|text| truncate_summary(&text, 160));

    Ok(Some(SessionMeta {
        provider_id: PROVIDER_ID.to_string(),
        session_id: session_id.clone(),
        title,
        summary,
        project_dir,
        created_at,
        last_active_at,
        source_path: Some(path.to_string_lossy().to_string()),
        resume_command: Some(format!("codex resume {session_id}")),
    }))
}

fn is_subagent_source(source: Option<&Value>) -> bool {
    source
        .and_then(|value| value.as_object())
        .map(|source| source.contains_key("subagent"))
        .unwrap_or(false)
}

fn title_candidate_from_user_message(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty()
        || trimmed.starts_with("# AGENTS.md")
        || trimmed.starts_with("<environment_context>")
    {
        return None;
    }

    if trimmed.starts_with(VSCODE_CONTEXT_PREFIX) {
        return extract_codex_prompt_from_ide_context(trimmed);
    }

    Some(trimmed.to_string())
}

fn extract_codex_prompt_from_ide_context(text: &str) -> Option<String> {
    let normalized = text.replace("\r\n", "\n");
    let lines = normalized.lines().collect::<Vec<_>>();

    // VS Code injects the real prompt as the LAST "## My request for Codex:"
    // section, so keep the final matching heading. Earlier matches can be
    // headings that live inside the active selection / open file content.
    // Trade-off: if the request body itself repeats the heading, the title
    // truncates to its trailing part (rare; covered by tests below).
    let mut prompt: Option<String> = None;
    for (index, line) in lines.iter().enumerate() {
        let Some(inline_prompt) = codex_request_heading_payload(line) else {
            continue;
        };

        if !inline_prompt.is_empty() {
            prompt = Some(inline_prompt.to_string());
            continue;
        }

        let following_prompt = lines[index + 1..].join("\n").trim().to_string();
        prompt = (!following_prompt.is_empty()).then_some(following_prompt);
    }

    prompt
}

fn codex_request_heading_payload(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    if !trimmed.starts_with('#') {
        return None;
    }

    let heading = trimmed.trim_start_matches('#').trim_start();
    let lowered = heading.to_ascii_lowercase();
    if !lowered.starts_with(CODEX_REQUEST_MARKER) {
        return None;
    }

    let suffix = heading[CODEX_REQUEST_MARKER.len()..].trim_start();
    if suffix.is_empty() {
        return Some("");
    }

    let Some(separator) = suffix.chars().next() else {
        return Some("");
    };
    if !matches!(separator, ':' | '：' | '-' | '—') {
        return None;
    }

    Some(
        suffix
            .trim_start_matches(|c: char| c.is_whitespace() || matches!(c, ':' | '：' | '-' | '—'))
            .trim(),
    )
}

fn infer_session_id_from_filename(path: &Path) -> Option<String> {
    let file_name = path.file_name()?.to_string_lossy();
    UUID_RE.find(&file_name).map(|mat| mat.as_str().to_string())
}

fn collect_jsonl_files(root: &Path, files: &mut Vec<PathBuf>) {
    if !root.exists() {
        return;
    }

    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let is_dir = entry.file_type().map_or_else(
            |_| path.is_dir(),
            |kind| kind.is_dir() || (kind.is_symlink() && path.is_dir()),
        );
        if is_dir {
            collect_jsonl_files(&path, files);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_state_db::CODEX_STATE_DB_FILENAME;
    use std::io::Read;
    use tempfile::tempdir;

    fn write_codex_session(path: &Path, session_id: &str, message: &str) {
        std::fs::write(
            path,
            format!(
                "{{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{session_id}\",\"cwd\":\"/tmp/project\"}}}}\n\
                 {{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":\"{message}\"}}}}\n",
            ),
        )
        .expect("write session");
    }

    #[test]
    fn scan_sessions_in_roots_includes_active_and_archived_files() {
        let temp = tempdir().expect("tempdir");
        let active = temp.path().join("sessions");
        let archived = temp.path().join("archived_sessions");
        std::fs::create_dir_all(&active).expect("active dir");
        std::fs::create_dir_all(&archived).expect("archived dir");

        write_codex_session(&active.join("active.jsonl"), "active-id", "Active session");
        write_codex_session(
            &archived.join("archived.jsonl"),
            "archived-id",
            "Archived session",
        );

        let sessions = SessionListing::default().scan(
            &[active, archived],
            &temp.path().join(CODEX_SESSION_INDEX_FILENAME),
            &[],
        );
        let ids = sessions
            .into_iter()
            .map(|session| session.session_id)
            .collect::<Vec<_>>();

        assert!(ids.contains(&"active-id".to_string()));
        assert!(ids.contains(&"archived-id".to_string()));
    }

    #[test]
    fn delete_session_removes_jsonl_file() {
        let temp = tempdir().expect("tempdir");
        let path = temp
            .path()
            .join("rollout-2026-03-06T21-50-12-019cc369-bd7c-7891-b371-7b20b4fe0b18.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"019cc369-bd7c-7891-b371-7b20b4fe0b18\",\"cwd\":\"/tmp/project\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"hello\"}}\n"
            ),
        )
        .expect("write session");

        delete_session(temp.path(), &path, "019cc369-bd7c-7891-b371-7b20b4fe0b18")
            .expect("delete session");

        assert!(!path.exists());
    }

    #[test]
    fn parse_session_uses_first_user_message_as_title() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-id\",\"cwd\":\"/tmp/project\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"How do I deploy?\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:14Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":\"Here is how...\"}}\n"
            ),
        )
        .expect("write");

        let meta = parse_session(&path).unwrap();
        assert_eq!(meta.title.as_deref(), Some("How do I deploy?"));
    }

    #[test]
    fn scan_session_prefers_thread_title() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-id\",\"cwd\":\"/tmp/project\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"How do I deploy?\"}}\n"
            ),
        )
        .expect("write");

        let index = temp.path().join(CODEX_SESSION_INDEX_FILENAME);
        std::fs::write(
            &index,
            r#"{"id":"test-id","thread_name":"Renamed deployment thread"}"#,
        )
        .expect("write title index");

        let mut listing = SessionListing::default();
        let sessions = listing.scan(&[temp.path().to_path_buf()], &index, &[]);
        let session = sessions.iter().find(|meta| meta.session_id == "test-id");
        assert_eq!(
            session.and_then(|meta| meta.title.as_deref()),
            Some("Renamed deployment thread")
        );
    }

    #[test]
    fn load_thread_titles_from_state_db_trims_and_filters_titles() {
        let temp = tempdir().expect("tempdir");
        let db_path = temp.path().join(CODEX_STATE_DB_FILENAME);
        let conn = Connection::open(&db_path).expect("open sqlite db");
        conn.execute(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, first_user_message TEXT NOT NULL)",
            [],
        )
        .expect("create threads table");
        conn.execute(
            "INSERT INTO threads (id, title, first_user_message) VALUES (?1, ?2, ?3)",
            ("thread-1", "  Renamed Codex thread  ", "First prompt"),
        )
        .expect("insert renamed thread");
        conn.execute(
            "INSERT INTO threads (id, title, first_user_message) VALUES (?1, ?2, ?3)",
            ("thread-2", "   ", "First prompt"),
        )
        .expect("insert blank thread");
        conn.execute(
            "INSERT INTO threads (id, title, first_user_message) VALUES (?1, ?2, ?3)",
            ("thread-3", "  First prompt  ", "First prompt"),
        )
        .expect("insert first-message title");
        drop(conn);

        let titles = load_thread_titles_from_db(&db_path).expect("load titles");

        assert_eq!(
            titles.get("thread-1").map(String::as_str),
            Some("Renamed Codex thread")
        );
        assert!(!titles.contains_key("thread-2"));
        assert!(!titles.contains_key("thread-3"));
    }

    #[test]
    fn load_thread_titles_from_state_db_keeps_title_when_first_user_message_null() {
        let temp = tempdir().expect("tempdir");
        let db_path = temp.path().join(CODEX_STATE_DB_FILENAME);
        let conn = Connection::open(&db_path).expect("open sqlite db");
        // Codex stores first_user_message as a nullable column (Option<String>);
        // a renamed thread can have a title before any first message is synced.
        conn.execute(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, first_user_message TEXT)",
            [],
        )
        .expect("create threads table");
        conn.execute(
            "INSERT INTO threads (id, title, first_user_message) VALUES (?1, ?2, NULL)",
            ("thread-1", "Renamed thread"),
        )
        .expect("insert renamed thread without first message");
        conn.execute(
            "INSERT INTO threads (id, title, first_user_message) VALUES (?1, ?2, ?3)",
            ("thread-2", "First prompt", "First prompt"),
        )
        .expect("insert first-message title");
        drop(conn);

        let titles = load_thread_titles_from_db(&db_path).expect("load titles");

        // Kept: title present and no first message to compare against.
        assert_eq!(
            titles.get("thread-1").map(String::as_str),
            Some("Renamed thread")
        );
        // Filtered: title equals the first user message.
        assert!(!titles.contains_key("thread-2"));
    }

    #[test]
    fn load_thread_titles_from_session_index_uses_latest_name() {
        let temp = tempdir().expect("tempdir");
        let index_path = temp.path().join(CODEX_SESSION_INDEX_FILENAME);
        std::fs::write(
            &index_path,
            concat!(
                "{\"id\":\"thread-1\",\"thread_name\":\"Old name\",\"updated_at\":\"2026-07-01T00:00:00Z\"}\n",
                "{\"id\":\"thread-2\",\"thread_name\":\"   \",\"updated_at\":\"2026-07-01T00:00:00Z\"}\n",
                "not json\n",
                "{\"id\":\"thread-1\",\"thread_name\":\"  New name  \",\"updated_at\":\"2026-07-02T00:00:00Z\"}\n"
            ),
        )
        .expect("write session index");

        let titles =
            read_thread_title_index(BufReader::new(File::open(index_path).expect("open index")))
                .unwrap();

        assert_eq!(titles.get("thread-1").map(String::as_str), Some("New name"));
        assert!(!titles.contains_key("thread-2"));
    }

    #[test]
    fn session_listing_retries_title_index_after_io_failure() {
        struct FailedRead;

        impl Read for FailedRead {
            fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::other("simulated index I/O failure"))
            }
        }

        let temp = tempdir().expect("tempdir");
        let path = temp.path().join(CODEX_SESSION_INDEX_FILENAME);
        std::fs::write(
            &path,
            b"{\"id\":\"thread-1\",\"thread_name\":\"Current title\"}\n",
        )
        .unwrap();
        let mut cache = FileCache::default();
        let failed = cache.refresh(|cache| {
            cache.read(&path, |file| {
                read_thread_title_index(BufReader::new(file.chain(FailedRead)))
            })
        });
        assert!(failed.is_none());

        for _ in 0..5 {
            let titles = cache
                .refresh(|cache| {
                    cache.read(&path, |file| read_thread_title_index(BufReader::new(file)))
                })
                .expect("retry index");
            assert_eq!(titles.get("thread-1").unwrap(), "Current title");
        }
        assert_eq!(cache.loads, 2);
    }

    #[test]
    fn load_thread_titles_prefers_state_db_explicit_title_over_session_index() {
        let temp = tempdir().expect("tempdir");
        let index_path = temp.path().join(CODEX_SESSION_INDEX_FILENAME);
        std::fs::write(
            &index_path,
            concat!(
                "{\"id\":\"thread-1\",\"thread_name\":\"Legacy name\",\"updated_at\":\"2026-07-01T00:00:00Z\"}\n",
                "{\"id\":\"thread-2\",\"thread_name\":\"Legacy fallback\",\"updated_at\":\"2026-07-01T00:00:00Z\"}\n"
            ),
        )
        .expect("write session index");

        let db_path = temp.path().join(CODEX_STATE_DB_FILENAME);
        let conn = Connection::open(&db_path).expect("open sqlite db");
        conn.execute(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, first_user_message TEXT NOT NULL)",
            [],
        )
        .expect("create threads table");
        conn.execute(
            "INSERT INTO threads (id, title, first_user_message) VALUES (?1, ?2, ?3)",
            ("thread-1", "SQLite name", "First prompt"),
        )
        .expect("insert sqlite title");
        conn.execute(
            "INSERT INTO threads (id, title, first_user_message) VALUES (?1, ?2, ?3)",
            ("thread-2", "First prompt", "First prompt"),
        )
        .expect("insert first-message sqlite title");
        drop(conn);

        let sessions_dir = temp.path().join("sessions");
        std::fs::create_dir(&sessions_dir).expect("session directory");
        write_codex_session(
            &sessions_dir.join("first.jsonl"),
            "thread-1",
            "First prompt",
        );
        write_codex_session(
            &sessions_dir.join("second.jsonl"),
            "thread-2",
            "First prompt",
        );
        let titles = SessionListing::default()
            .scan(&[sessions_dir], &index_path, &[db_path])
            .into_iter()
            .filter_map(|meta| Some((meta.session_id, meta.title?)))
            .collect::<ThreadTitles>();

        assert_eq!(
            titles.get("thread-1").map(String::as_str),
            Some("SQLite name")
        );
        assert_eq!(
            titles.get("thread-2").map(String::as_str),
            Some("Legacy fallback")
        );
    }

    #[test]
    fn session_listing_reuses_rollouts_and_index_across_refreshes() {
        for file_count in [1, 64] {
            let temp = tempdir().expect("tempdir");
            let sessions = temp.path().join("sessions");
            std::fs::create_dir(&sessions).expect("session directory");
            for id in 0..file_count {
                write_codex_session(
                    &sessions.join(format!("{id}.jsonl")),
                    &id.to_string(),
                    "Prompt",
                );
            }
            let index = temp.path().join(CODEX_SESSION_INDEX_FILENAME);
            std::fs::write(&index, r#"{"id":"0","thread_name":"Old title"}"#).unwrap();
            let mut listing = SessionListing::default();
            let roots = [sessions.clone()];
            for _ in 0..5 {
                assert_eq!(listing.scan(&roots, &index, &[]).len(), file_count);
            }
            assert_eq!(listing.sessions.loads, file_count);
            assert_eq!(listing.title_index.loads, 1);

            let stamp = filetime::FileTime::from_last_modification_time(&index.metadata().unwrap());
            std::fs::write(&index, r#"{"id":"0","thread_name":"New title"}"#).unwrap();
            filetime::set_file_mtime(&index, stamp).unwrap();
            let sessions = listing.scan(&roots, &index, &[]);
            let renamed = sessions.iter().find(|meta| meta.session_id == "0").unwrap();
            assert_eq!(renamed.title.as_deref(), Some("New title"));
            assert_eq!(listing.sessions.loads, file_count);
            assert_eq!(listing.title_index.loads, 2);

            std::fs::remove_file(roots[0].join("0.jsonl")).unwrap();
            assert_eq!(listing.scan(&roots, &index, &[]).len(), file_count - 1);
            assert_eq!(listing.sessions.loads, file_count);
        }
    }

    #[test]
    fn session_listing_reloads_titles_for_wal_commits_without_reparsing_rollouts() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path().join("sessions");
        std::fs::create_dir(&root).expect("session directory");
        write_codex_session(&root.join("test.jsonl"), "test-id", "Prompt");
        let roots = [root];
        let index = temp.path().join(CODEX_SESSION_INDEX_FILENAME);
        let db_paths = [temp.path().join(CODEX_STATE_DB_FILENAME)];
        let conn = Connection::open(&db_paths[0]).expect("open database");
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, first_user_message TEXT);
             INSERT INTO threads VALUES ('test-id', 'Database title', 'Prompt');",
        )
        .expect("seed database");

        let mut listing = SessionListing::default();
        for _ in 0..5 {
            let listed = listing.scan(&roots, &index, &db_paths);
            assert_eq!(listed[0].title.as_deref(), Some("Database title"));
        }
        assert_eq!(listing.title_queries, 5);
        assert_eq!(listing.sessions.loads, 1);
        assert!(!listing.db_titles.contains_key(&db_paths[0]));

        conn.execute("UPDATE threads SET title = 'Changed title'", [])
            .expect("rename thread");
        let listed = listing.scan(&roots, &index, &db_paths);
        assert_eq!(listed[0].title.as_deref(), Some("Changed title"));

        conn.execute_batch("PRAGMA wal_checkpoint(RESTART)")
            .expect("restart WAL");
        let listed = listing.scan(&roots, &index, &db_paths);
        assert_eq!(listed[0].title.as_deref(), Some("Changed title"));
        let title_queries_after_checkpoint = listing.title_queries;
        let db_before = FileRevision::read(&db_paths[0]).unwrap();
        let wal_path = temp.path().join(format!("{CODEX_STATE_DB_FILENAME}-wal"));
        let wal_len_before = wal_path.metadata().unwrap().len();
        conn.execute("UPDATE threads SET title = 'Updated title'", [])
            .expect("rename thread using the existing WAL space");
        assert_eq!(FileRevision::read(&db_paths[0]), Some(db_before));
        assert_eq!(wal_path.metadata().unwrap().len(), wal_len_before);
        let listed = listing.scan(&roots, &index, &db_paths);
        assert_eq!(listed[0].title.as_deref(), Some("Updated title"));

        conn.execute("DELETE FROM threads", [])
            .expect("delete thread");
        let listed = listing.scan(&roots, &index, &db_paths);
        assert_eq!(listed[0].title.as_deref(), Some("Prompt"));
        assert_eq!(listing.title_queries, title_queries_after_checkpoint + 2);
        assert_eq!(listing.sessions.loads, 1);

        drop(conn);
        let replacement = temp.path().join("replacement.sqlite");
        Connection::open(&replacement)
            .unwrap()
            .execute_batch(
                "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, first_user_message TEXT);
                 INSERT INTO threads VALUES ('test-id', 'Replacement title', 'Prompt');",
            )
            .unwrap();
        std::fs::rename(&replacement, &db_paths[0]).expect("replace database");
        let listed = listing.scan(&roots, &index, &db_paths);
        assert_eq!(listed[0].title.as_deref(), Some("Replacement title"));
        assert_eq!(listing.title_queries, title_queries_after_checkpoint + 3);
        assert_eq!(listing.sessions.loads, 1);
    }

    #[test]
    fn session_listing_reuses_rollback_titles_until_database_changes() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join(CODEX_STATE_DB_FILENAME);
        let conn = Connection::open(&path).expect("open database");
        conn.execute_batch(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, first_user_message TEXT);
             INSERT INTO threads VALUES ('test-id', 'Database title', 'Prompt');",
        )
        .expect("seed database");

        let mut listing = SessionListing::default();
        for _ in 0..5 {
            let titles = listing.load_db_titles(&path).expect("load titles");
            assert_eq!(titles.get("test-id").unwrap(), "Database title");
        }
        assert_eq!(listing.title_queries, 1);

        conn.execute("UPDATE threads SET title = 'Changed title'", [])
            .expect("rename thread");
        let titles = listing.load_db_titles(&path).expect("load updated titles");
        assert_eq!(titles.get("test-id").unwrap(), "Changed title");
        assert_eq!(listing.title_queries, 2);
    }

    #[test]
    fn parse_session_skips_agents_md_injection() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-id\",\"cwd\":\"/tmp/project\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"developer\",\"content\":\"<permissions>\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"# AGENTS.md instructions for /tmp/project\\n<INSTRUCTIONS>Do stuff</INSTRUCTIONS>\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:14Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"Fix the login bug\"}}\n"
            ),
        )
        .expect("write");

        let meta = parse_session(&path).unwrap();
        // Should skip AGENTS.md injection and use the real user message
        assert_eq!(meta.title.as_deref(), Some("Fix the login bug"));
    }

    #[test]
    fn parse_session_skips_subagent_sessions() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-04-28T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"subagent-id\",\"cwd\":\"/tmp/project\",\"originator\":\"codex-tui\",\"source\":{\"subagent\":{\"thread_spawn\":{\"parent_thread_id\":\"parent-id\",\"depth\":1,\"agent_role\":\"explorer\"}}}}}\n",
                "{\"timestamp\":\"2026-04-28T10:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"Inspect the project\"}}\n"
            ),
        )
        .expect("write");

        assert!(parse_session(&path).is_none());
    }

    #[test]
    fn parse_session_skips_environment_context_injection() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-id\",\"cwd\":\"/tmp/project\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"<environment_context>\\n  <cwd>/tmp/project</cwd>\\n</environment_context>\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:14Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"Fix the login bug\"}}\n"
            ),
        )
        .expect("write");

        let meta = parse_session(&path).unwrap();
        // Should skip environment_context injection and use the real user message
        assert_eq!(meta.title.as_deref(), Some("Fix the login bug"));
    }

    #[test]
    fn parse_session_extracts_vscode_ide_request_as_title() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-id\",\"cwd\":\"/tmp/project\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"# Context from my IDE setup:\\n\\n## Active file: src/main.ts\\n\\n## My request for Codex:\\nFix the session title preview\"}}\n"
            ),
        )
        .expect("write");

        let meta = parse_session(&path).unwrap();
        assert_eq!(meta.title.as_deref(), Some("Fix the session title preview"));
    }

    #[test]
    fn parse_session_extracts_inline_vscode_ide_request_as_title() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-id\",\"cwd\":\"/tmp/project\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"# Context from my IDE setup:\\n\\n## My request for Codex: Fix the TOC preview\"}}\n"
            ),
        )
        .expect("write");

        let meta = parse_session(&path).unwrap();
        assert_eq!(meta.title.as_deref(), Some("Fix the TOC preview"));
    }

    #[test]
    fn parse_session_ignores_marker_mentions_before_request_heading() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-id\",\"cwd\":\"/tmp/project\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"# Context from my IDE setup:\\n\\n## Active selection:\\nMy request for Codex: not the prompt\\n\\n## My request for Codex:\\nUse the real request heading\"}}\n"
            ),
        )
        .expect("write");

        let meta = parse_session(&path).unwrap();
        assert_eq!(meta.title.as_deref(), Some("Use the real request heading"));
    }

    #[test]
    fn parse_session_uses_last_request_heading_when_selection_has_one() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-id\",\"cwd\":\"/tmp/project\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"# Context from my IDE setup:\\n\\n## Active selection: docs/codex-format.md\\n## My request for Codex:\\nselected document content, not the real request\\n\\n## My request for Codex:\\nUse the last request heading\"}}\n"
            ),
        )
        .expect("write");

        let meta = parse_session(&path).unwrap();
        assert_eq!(meta.title.as_deref(), Some("Use the last request heading"));
    }

    // Known limitation: the IDE marker is matched purely by text, so a
    // "## My request for Codex:" line inside the real request body is treated as
    // a new boundary and only the trailing part is kept. This pins the
    // best-effort behavior; fully fixing it needs structured IDE section data
    // that the Codex VS Code context does not provide.
    #[test]
    fn parse_session_keeps_trailing_part_when_request_body_repeats_heading() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-id\",\"cwd\":\"/tmp/project\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"# Context from my IDE setup:\\n\\n## Active file: foo.ts\\n\\n## My request for Codex:\\nDocument the format, for example:\\n## My request for Codex:\\nand the rest follows.\"}}\n"
            ),
        )
        .expect("write");

        let meta = parse_session(&path).unwrap();
        assert_eq!(meta.title.as_deref(), Some("and the rest follows."));
    }

    #[test]
    fn parse_session_skips_vscode_ide_context_without_request() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-id\",\"cwd\":\"/tmp/project\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"# Context from my IDE setup:\\n\\n## Active file: src/main.ts\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:14Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"Fix the login bug\"}}\n"
            ),
        )
        .expect("write");

        let meta = parse_session(&path).unwrap();
        assert_eq!(meta.title.as_deref(), Some("Fix the login bug"));
    }

    #[test]
    fn parse_session_falls_back_to_dir_basename() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-id\",\"cwd\":\"/tmp/my-project\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":\"Hello\"}}\n"
            ),
        )
        .expect("write");

        let meta = parse_session(&path).unwrap();
        // No user message → falls back to dir basename
        assert_eq!(meta.title.as_deref(), Some("my-project"));
    }

    #[test]
    fn parse_session_truncates_long_title() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        let long_msg = "a".repeat(200);
        std::fs::write(
            &path,
            format!(
                "{{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"test-id\",\"cwd\":\"/tmp/p\"}}}}\n\
                 {{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":\"{long_msg}\"}}}}\n",
            ),
        )
        .expect("write");

        let meta = parse_session(&path).unwrap();
        let title = meta.title.unwrap();
        assert!(title.len() <= TITLE_MAX_CHARS + 3); // +3 for "..."
        assert!(title.ends_with("..."));
    }

    #[test]
    fn load_messages_excludes_tool_plumbing_from_visible_chat() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-id\",\"cwd\":\"/tmp\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"list files\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:14Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"shell\",\"arguments\":\"{\\\"cmd\\\":[\\\"ls\\\"]}\",\"call_id\":\"call_1\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:15Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"call_1\",\"output\":\"file1.txt\\nfile2.txt\"}}\n",
                "{\"timestamp\":\"2026-03-06T21:50:16Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Done.\"}]}}\n",
            ),
        )
        .expect("write");

        let msgs = load_messages(&path).expect("load");
        assert_eq!(msgs.len(), 2);

        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].content, "list files");

        assert_eq!(msgs[1].role, "assistant");
        assert_eq!(msgs[1].content, "Done.");
    }

    #[test]
    fn load_messages_excludes_developer_and_recovery_transcripts() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"developer\",\"content\":\"tool instructions\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"<environment_context>\\n<cwd>C:\\\\work</cwd>\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"call_1\",\"output\":\"secret tool state\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"real request\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":\"real answer\"}}\n"
            ),
        )
        .expect("write");

        let messages = load_messages(&path).expect("load");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].content, "real request");
        assert_eq!(messages[1].content, "real answer");
    }
}
