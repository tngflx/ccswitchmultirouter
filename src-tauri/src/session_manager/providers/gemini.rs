use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::sync::{LazyLock, Mutex};

use serde_json::Value;

use crate::json_projection::JsonProjection;
use crate::session_manager::{SessionMessage, SessionMeta};

use super::utils::{parse_timestamp_to_ms, truncate_summary, FileCache};

const PROVIDER_ID: &str = "gemini";
static SESSION_FILES: LazyLock<Mutex<FileCache<Option<SessionMeta>>>> =
    LazyLock::new(Mutex::default);

pub fn scan_sessions() -> Vec<SessionMeta> {
    let gemini_dir = crate::gemini_config::get_gemini_dir();
    SESSION_FILES
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .refresh(|cache| scan_sessions_in_dir(&gemini_dir.join("tmp"), cache))
}

fn scan_sessions_in_dir(
    tmp_dir: &Path,
    cache: &mut FileCache<Option<SessionMeta>>,
) -> Vec<SessionMeta> {
    let mut sessions = Vec::new();

    // Iterate over project directories: tmp/<project_name>/chats/session-*.json
    let project_dirs = match std::fs::read_dir(tmp_dir) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };

    for entry in project_dirs.flatten() {
        let chats_dir = entry.path().join("chats");
        if !chats_dir.is_dir() {
            continue;
        }

        let chat_files = match std::fs::read_dir(&chats_dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        let project_root_file = entry.path().join(".project_root");
        let project_dir = std::fs::read_to_string(project_root_file).ok();

        for file_entry in chat_files.flatten() {
            let path = file_entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Some(meta) = cache
                .read(&path, |file| parse_open_session(&path, file))
                .flatten()
            {
                sessions.push(SessionMeta {
                    project_dir: project_dir.clone(),
                    ..meta
                });
            }
        }
    }

    sessions
}

pub fn load_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    let data = std::fs::read_to_string(path).map_err(|e| format!("Failed to read session: {e}"))?;
    let value: Value =
        serde_json::from_str(&data).map_err(|e| format!("Failed to parse session JSON: {e}"))?;

    let messages = value
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "No messages array found".to_string())?;

    let mut result = Vec::new();
    for msg in messages {
        let role = match msg.get("type").and_then(Value::as_str) {
            Some("gemini") => "assistant",
            Some("user") => "user",
            Some("info") | Some("error") => continue,
            Some(_) | None => continue,
        };

        // Gemini content may be a plain string or an array of {text: ...} objects
        let mut content = match msg.get("content") {
            Some(Value::String(s)) => s.to_string(),
            Some(Value::Array(items)) => items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        };

        // Append tool call names from the optional toolCalls array
        if let Some(Value::Array(calls)) = msg.get("toolCalls") {
            for call in calls {
                if let Some(name) = call.get("name").and_then(Value::as_str) {
                    if !content.is_empty() {
                        content.push('\n');
                    }
                    content.push_str(&format!("[Tool: {name}]"));
                }
            }
        }

        if content.trim().is_empty() {
            continue;
        }

        let ts = msg.get("timestamp").and_then(parse_timestamp_to_ms);

        result.push(SessionMessage {
            role: role.to_string(),
            content,
            ts,
        });
    }

    Ok(result)
}

pub fn delete_session(_root: &Path, path: &Path, session_id: &str) -> Result<bool, String> {
    let meta = parse_session(path).ok_or_else(|| {
        format!(
            "Failed to parse Gemini session metadata: {}",
            path.display()
        )
    })?;

    if meta.session_id != session_id {
        return Err(format!(
            "Gemini session ID mismatch: expected {session_id}, found {}",
            meta.session_id
        ));
    }

    std::fs::remove_file(path).map_err(|e| {
        format!(
            "Failed to delete Gemini session file {}: {e}",
            path.display()
        )
    })?;

    Ok(true)
}

fn parse_session(path: &Path) -> Option<SessionMeta> {
    parse_open_session(path, &mut File::open(path).ok()?)
        .ok()
        .flatten()
}

fn parse_open_session(
    path: &Path,
    file: &mut File,
) -> Result<Option<SessionMeta>, serde_json::Error> {
    // Session listing only needs a few scalar fields and the first user
    // message. Deserialize the messages through a streaming visitor so the
    // scanner never materializes the complete history as a `Value` tree.
    let metadata = match LISTING_METADATA.read(BufReader::new(file)) {
        Ok(metadata) => metadata,
        Err(error) if error.is_io() => return Err(error),
        // Cache an invalid snapshot only while its file revision stays the same.
        Err(_) => return Ok(None),
    };
    let Some(session_id) = metadata.get("sessionId").and_then(Value::as_str) else {
        return Ok(None);
    };
    let created_at = metadata.get("startTime").and_then(parse_timestamp_to_ms);
    let last_active_at = metadata.get("lastUpdated").and_then(parse_timestamp_to_ms);
    let title = listing_title(&metadata);

    let source_path = path.to_string_lossy().to_string();

    Ok(Some(SessionMeta {
        provider_id: PROVIDER_ID.to_string(),
        session_id: session_id.to_owned(),
        title: title.clone(),
        summary: title,
        project_dir: None, // (optionally) populated later
        created_at,
        last_active_at: last_active_at.or(created_at),
        source_path: Some(source_path),
        resume_command: Some(format!("gemini --resume {session_id}")),
    }))
}

const LISTING_MESSAGE: JsonProjection = JsonProjection::Object(&[
    ("type", JsonProjection::Scalar),
    ("content", JsonProjection::Scalar),
]);
const LISTING_METADATA: JsonProjection = JsonProjection::Object(&[
    ("sessionId", JsonProjection::Scalar),
    ("startTime", JsonProjection::Scalar),
    ("lastUpdated", JsonProjection::Scalar),
    (
        "messages",
        JsonProjection::First(&LISTING_MESSAGE, |message| {
            message.get("type").and_then(Value::as_str) == Some("user")
        }),
    ),
]);

fn listing_title(metadata: &Value) -> Option<String> {
    metadata
        .pointer("/messages/content")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .map(|text| truncate_summary(text, 160))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json_projection::take_first_match_candidates;
    use tempfile::tempdir;

    #[test]
    fn delete_session_removes_json_file() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session-2026-03-06T10-17-test.json");
        std::fs::write(
            &path,
            r#"{
              "sessionId": "gemini-session-123",
              "startTime": "2026-03-06T10:17:58.000Z",
              "lastUpdated": "2026-03-06T10:20:00.000Z",
              "messages": [
                {
                  "id": "msg-1",
                  "timestamp": "2026-03-06T10:17:58.000Z",
                  "type": "user",
                  "content": "hello"
                }
              ]
            }"#,
        )
        .expect("write session");

        delete_session(temp.path(), &path, "gemini-session-123").expect("delete session");

        assert!(!path.exists());
    }

    #[test]
    fn load_messages_handles_array_content() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.json");
        std::fs::write(
            &path,
            r#"{
              "sessionId": "test",
              "messages": [
                {"id":"1","timestamp":"2026-03-06T10:00:00Z","type":"user","content":[{"text":"hello"}]},
                {"id":"2","timestamp":"2026-03-06T10:00:01Z","type":"gemini","content":"world"},
                {"id":"3","timestamp":"2026-03-06T10:00:02Z","type":"info","content":"system info"},
                {"id":"4","timestamp":"2026-03-06T10:00:03Z","type":"error","content":"MCP ERROR"}
              ]
            }"#,
        )
        .expect("write");

        let msgs = load_messages(&path).expect("load");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].content, "hello");
        assert_eq!(msgs[1].role, "assistant");
        assert_eq!(msgs[1].content, "world");
    }

    #[test]
    fn load_messages_includes_tool_calls() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.json");
        std::fs::write(
            &path,
            r#"{
              "sessionId": "test",
              "messages": [
                {"id":"1","timestamp":"2026-03-10T08:24:50Z","type":"gemini","content":"","toolCalls":[{"id":"call_1","name":"web_search","args":{"query":"test"}}]},
                {"id":"2","timestamp":"2026-03-10T08:25:00Z","type":"gemini","content":"Here are the results.","toolCalls":[{"id":"call_2","name":"web_fetch","args":{"url":"http://example.com"}}]}
              ]
            }"#,
        )
        .expect("write");

        let msgs = load_messages(&path).expect("load");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "assistant");
        assert!(msgs[0].content.contains("[Tool: web_search]"));
        assert_eq!(msgs[1].role, "assistant");
        assert!(msgs[1].content.contains("Here are the results."));
        assert!(msgs[1].content.contains("[Tool: web_fetch]"));
    }

    #[test]
    fn listing_metadata_only_deserializes_messages_through_first_user_message() {
        for history_len in [1, 2_000] {
            let history = r#",{"type":"gemini","content":{"nested":["unneeded response"]}}"#
                .repeat(history_len);
            let json = format!(
                r#"{{"sessionId":"streamed","messages":[null,{{"type":"user","content":"first request"}}{history}],"lastUpdated":"2026-03-06T10:20:00Z"}}"#
            );
            take_first_match_candidates();
            let metadata = LISTING_METADATA
                .read(BufReader::new(json.as_bytes()))
                .expect("parse metadata");
            assert_eq!(take_first_match_candidates(), 2);
            assert_eq!(listing_title(&metadata).as_deref(), Some("first request"));
            assert_eq!(
                metadata.get("lastUpdated").and_then(parse_timestamp_to_ms),
                Some(1_772_792_400_000)
            );
        }
    }

    #[test]
    fn listing_keeps_legacy_title_semantics_for_nonstring_content() {
        let json = r#"{"sessionId":"legacy","messages":[{"type":"user","content":[{"text":"first"}]},{"type":"user","content":"later"}]}"#;
        take_first_match_candidates();
        let metadata = LISTING_METADATA
            .read(json.as_bytes())
            .expect("parse metadata");
        assert_eq!(listing_title(&metadata), None);
        assert_eq!(take_first_match_candidates(), 1);
    }

    #[test]
    fn listing_validates_discarded_gemini_history() {
        for discarded in [b"1e9999".as_slice(), br#""\uD800""#, b"\"\xff\""] {
            let mut json = br#"{"sessionId":"invalid","messages":[{"type":"user","content":"prompt"},{"content":"#.to_vec();
            json.extend_from_slice(discarded);
            json.extend_from_slice(b"}]}");
            assert!(serde_json::from_slice::<Value>(&json).is_err());
            assert!(LISTING_METADATA.read(json.as_slice()).is_err());
        }
    }

    #[test]
    fn listing_skips_unchanged_invalid_gemini_histories_and_recovers_on_rewrite() {
        for history_len in [1, 2_000] {
            let temp = tempdir().expect("tempdir");
            let chats = temp.path().join("project").join("chats");
            std::fs::create_dir_all(&chats).unwrap();
            let chat = chats.join("session.json");
            let history = r#",{"type":"gemini","content":"large response"}"#.repeat(history_len);
            let valid = format!(
                r#"{{"sessionId":"repaired","messages":[{{"type":"user","content":"Restored prompt"}}{history}]}}"#,
            );
            let mut invalid = valid.clone();
            assert_eq!(invalid.pop(), Some('}'));
            invalid.push(']');
            std::fs::write(&chat, invalid).unwrap();
            let mtime = filetime::FileTime::from_last_modification_time(&chat.metadata().unwrap());
            let refresh = |cache: &mut FileCache<Option<SessionMeta>>| {
                cache.refresh(|cache| scan_sessions_in_dir(temp.path(), cache))
            };
            let mut cache = FileCache::default();
            for _ in 0..5 {
                assert!(refresh(&mut cache).is_empty());
            }
            assert_eq!(cache.loads, 1);

            std::fs::write(&chat, valid).unwrap();
            filetime::set_file_mtime(&chat, mtime).unwrap();
            let sessions = refresh(&mut cache);
            assert_eq!(sessions.len(), 1);
            assert_eq!(sessions[0].title.as_deref(), Some("Restored prompt"));
            assert_eq!(cache.loads, 2);
        }
    }

    #[test]
    fn listing_reuses_unchanged_histories_and_reloads_revisions() {
        for history_len in [1, 2_000] {
            let temp = tempdir().expect("tempdir");
            let project = temp.path().join("project");
            let chats = project.join("chats");
            std::fs::create_dir_all(&chats).unwrap();
            let project_root = project.join(".project_root");
            std::fs::write(&project_root, "original-project-path").unwrap();
            let chat = chats.join("session.json");
            let history = r#",{"type":"gemini","content":"large response"}"#.repeat(history_len);
            let session_json = |id, title| {
                format!(
                    r#"{{"sessionId":"{id}","messages":[{{"type":"user","content":"{title}"}}{history}]}}"#,
                )
            };
            std::fs::write(&chat, session_json("original", "Initial prompt")).unwrap();
            let refresh = |cache: &mut FileCache<Option<SessionMeta>>| {
                cache.refresh(|cache| scan_sessions_in_dir(temp.path(), cache))
            };
            let mut cache = FileCache::default();
            for _ in 0..5 {
                let sessions = refresh(&mut cache);
                assert_eq!(sessions.len(), 1);
                assert_eq!(sessions[0].title.as_deref(), Some("Initial prompt"));
            }
            assert_eq!(cache.loads, 1);

            std::fs::write(&project_root, "changed-project-path").unwrap();
            let sessions = refresh(&mut cache);
            assert_eq!(
                sessions[0].project_dir.as_deref(),
                Some("changed-project-path")
            );
            assert_eq!(cache.loads, 1);

            let metadata = chat.metadata().unwrap();
            let mtime = filetime::FileTime::from_last_modification_time(&metadata);
            std::fs::write(&chat, session_json("original", "Updated prompt")).unwrap();
            filetime::set_file_mtime(&chat, mtime).unwrap();
            assert_eq!(metadata.len(), chat.metadata().unwrap().len());
            let sessions = refresh(&mut cache);
            assert_eq!(sessions[0].title.as_deref(), Some("Updated prompt"));
            assert_eq!(cache.loads, 2);

            let replacement = project.join("replacement.json");
            std::fs::write(&replacement, session_json("replaced", "Updated prompt")).unwrap();
            filetime::set_file_mtime(&replacement, mtime).unwrap();
            std::fs::rename(replacement, &chat).unwrap();
            let sessions = refresh(&mut cache);
            assert_eq!(sessions[0].session_id, "replaced");
            assert_eq!(cache.loads, 3);

            std::fs::rename(&chat, chats.join("renamed.json")).unwrap();
            let sessions = refresh(&mut cache);
            assert!(sessions[0]
                .source_path
                .as_ref()
                .unwrap()
                .ends_with("renamed.json"));
            assert_eq!(cache.loads, 4);

            std::fs::remove_file(chats.join("renamed.json")).unwrap();
            assert!(refresh(&mut cache).is_empty());
            assert_eq!(cache.loads, 4);
        }
    }
}
