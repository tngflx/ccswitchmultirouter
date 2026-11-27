use std::fs;
use std::path::Path;

use rusqlite::{params, Connection, OpenFlags};
use serde_json::json;
use tempfile::tempdir;

use super::{export_from, history_db, import_into, inspect_for, BackupItem, Profile};
use crate::codex_state_db::CODEX_STATE_DB_FILENAME;

const SESSION_ID: &str = "01234567-89ab-cdef-0123-456789abcdef";
const ROLLOUT_NAME: &str = "rollout-2026-03-07T12-00-00-01234567-89ab-cdef-0123-456789abcdef.jsonl";

fn profile(home: &Path, sqlite_home: &Path) -> Profile {
    let config = format!(
        "sqlite_home = {}",
        toml_edit::Value::from(sqlite_home.to_str().unwrap())
    );
    Profile::from_root(home.to_path_buf(), &config).unwrap()
}

#[test]
fn legacy_backup_round_trip_preserves_rollout_and_skips_duplicate_restore() {
    let root = tempdir().unwrap();
    let source_home = root.path().join("source");
    let destination_home = root.path().join("destination");
    let source = profile(&source_home, &source_home);
    let destination = profile(&destination_home, &destination_home);
    let session_id = "01234567-89ab-cdef-0123-456789abcdef";
    let title = "Example conversation";
    let project_path = "/projects/example";
    let rollout_name = format!("rollout-2026-03-07T12-00-00-{session_id}.jsonl");
    let source_path = source.destination_path(&rollout_name, true).unwrap();
    let header = json!({
        "timestamp": "2026-03-07T12:00:00Z",
        "type": "session_meta",
        "payload": { "id": session_id, "cwd": project_path }
    });
    let message = json!({
        "type": "response_item",
        "payload": { "type": "message", "role": "user", "content": [] }
    });
    let rollout = format!("{header}\n{message}\n");
    fs::write(&source_path, &rollout).unwrap();
    let index_entry = json!({ "id": session_id, "thread_name": title });
    fs::write(
        source.home.join("session_index.jsonl"),
        format!("{index_entry}\n"),
    )
    .unwrap();

    let backup_path = root.path().join("session-backup.zip");
    let exported = export_from(
        &source,
        &backup_path,
        &[BackupItem {
            session_id: session_id.to_owned(),
            source_path,
        }],
    )
    .unwrap();
    assert_eq!(exported.count, 1);

    let preview = inspect_for(&destination, &backup_path).unwrap();
    assert_eq!(preview.sessions.len(), 1);
    assert_eq!(preview.sessions[0].session_id, session_id);
    assert_eq!(preview.sessions[0].title, title);
    assert_eq!(
        preview.sessions[0].project_path.as_deref(),
        Some(project_path)
    );
    assert!(!preview.sessions[0].conflict);
    assert!(!destination.home.exists());

    let restored = import_into(&destination, &backup_path, &preview.manifest_hash).unwrap();
    assert_eq!((restored.restored, restored.skipped), (1, 0));
    let restored_path = destination.destination_path(&rollout_name, false).unwrap();
    assert_eq!(fs::read(&restored_path).unwrap(), rollout.as_bytes());
    let index_path = destination.home.join("session_index.jsonl");
    let restored_index = fs::read_to_string(&index_path).unwrap();
    assert_eq!(restored_index.lines().count(), 1);
    assert_eq!(destination.index_titles().unwrap()[session_id], title);

    let second_preview = inspect_for(&destination, &backup_path).unwrap();
    assert!(second_preview.sessions[0].conflict);
    let duplicate = import_into(&destination, &backup_path, &second_preview.manifest_hash).unwrap();
    assert_eq!((duplicate.restored, duplicate.skipped), (0, 1));
    assert_eq!(fs::read(&restored_path).unwrap(), rollout.as_bytes());
    assert_eq!(fs::read_to_string(&index_path).unwrap(), restored_index);
}

fn initialize_catalog(sqlite_home: &Path) -> Connection {
    fs::create_dir_all(sqlite_home).unwrap();
    let connection = Connection::open(sqlite_home.join(CODEX_STATE_DB_FILENAME)).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE threads (
                id TEXT PRIMARY KEY,
                rollout_path TEXT NOT NULL,
                archived INTEGER NOT NULL DEFAULT 0,
                title TEXT NOT NULL,
                history_mode TEXT NOT NULL
            );",
        )
        .unwrap();
    connection
}

#[test]
fn paginated_backup_restores_to_native_history_beside_initialized_catalog() {
    let root = tempdir().unwrap();
    let source_home = root.path().join("source");
    let source_catalog = initialize_catalog(&source_home);
    let source_history_path = source_home.join(history_db::NATIVE_FILENAME);
    fs::write(&source_history_path, []).unwrap();
    history_db::initialize(&source_history_path).unwrap();
    let source = profile(&source_home, &source_home);
    let source_rollout = source.destination_path(ROLLOUT_NAME, true).unwrap();
    let header = json!({
        "timestamp": "2026-03-07T12:00:00Z",
        "ordinal": 0,
        "type": "session_meta",
        "payload": { "id": SESSION_ID, "history_mode": "paginated" }
    });
    let rollout = format!("{header}\n");
    fs::write(&source_rollout, &rollout).unwrap();
    source_catalog
        .execute(
            "INSERT INTO threads (id, rollout_path, title, history_mode) VALUES (?1, ?2, ?3, 'paginated')",
            params![SESSION_ID, source_rollout.to_str().unwrap(), "Ongoing fix"],
        )
        .unwrap();
    let cursor = (rollout.len() as i64, 1i64);
    Connection::open(&source_history_path)
        .unwrap()
        .execute(
            "INSERT INTO thread_history_projection_state VALUES (?1, ?2, ?3)",
            params![SESSION_ID, cursor.0, cursor.1],
        )
        .unwrap();

    let backup_path = root.path().join("paginated.zip");
    export_from(
        &source,
        &backup_path,
        &[BackupItem {
            session_id: SESSION_ID.into(),
            source_path: source_rollout,
        }],
    )
    .unwrap();

    let destination_home = root.path().join("destination");
    let destination_sqlite = root.path().join("destination-sqlite");
    let uninitialized = profile(&destination_home, &destination_sqlite);
    let preview = inspect_for(&uninitialized, &backup_path).unwrap();
    assert!(!preview.sessions[0].conflict);
    let error = import_into(&uninitialized, &backup_path, &preview.manifest_hash)
        .err()
        .expect("paginated restore requires the native state catalog");
    assert!(error.contains("Open Codex once"));
    assert!(!destination_home.exists());
    assert!(!destination_sqlite.exists());

    let destination_catalog = initialize_catalog(&destination_sqlite);
    fs::create_dir(&destination_home).unwrap();
    let stale_history_path = destination_home.join(history_db::NATIVE_FILENAME);
    fs::write(&stale_history_path, b"unused old file").unwrap();
    let destination = profile(&destination_home, &destination_sqlite);
    assert!(destination.history_db.is_none());
    let preview = inspect_for(&destination, &backup_path).unwrap();
    let restored = import_into(&destination, &backup_path, &preview.manifest_hash).unwrap();
    assert_eq!((restored.restored, restored.skipped), (1, 0));

    let restored_path = destination.destination_path(ROLLOUT_NAME, false).unwrap();
    assert_eq!(fs::read(&restored_path).unwrap(), rollout.as_bytes());
    let (registered_path, mode, archived): (String, String, i64) = destination_catalog
        .query_row(
            "SELECT rollout_path, history_mode, archived FROM threads WHERE id = ?1",
            [SESSION_ID],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(Path::new(&registered_path), restored_path);
    assert_eq!(mode, "paginated");
    assert_eq!(archived, 0);
    let history = Connection::open_with_flags(
        destination_sqlite.join(history_db::NATIVE_FILENAME),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let restored_cursor: (i64, i64) = history
        .query_row(
            "SELECT next_rollout_byte_offset, next_rollout_ordinal
             FROM thread_history_projection_state WHERE thread_id = ?1",
            [SESSION_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(restored_cursor, cursor);
    assert_eq!(fs::read(stale_history_path).unwrap(), b"unused old file");
}

#[test]
fn archived_rollout_cannot_be_exported_even_when_an_active_copy_exists() {
    let root = tempdir().unwrap();
    let source = profile(root.path(), root.path());
    let active = source.destination_path(ROLLOUT_NAME, true).unwrap();
    let header = json!({ "type": "session_meta", "payload": { "id": SESSION_ID } });
    fs::write(&active, format!("{header}\n")).unwrap();
    let archived_dir = root.path().join("archived_sessions");
    fs::create_dir(&archived_dir).unwrap();
    let archived = archived_dir.join(ROLLOUT_NAME);
    fs::copy(&active, &archived).unwrap();
    let target = root.path().join("archive.zip");

    for (source_path, expected) in [(archived, "active sessions folder"), (active, "archived")] {
        let error = export_from(
            &source,
            &target,
            &[BackupItem {
                session_id: SESSION_ID.into(),
                source_path,
            }],
        )
        .err()
        .expect("an archived chat must never produce a backup");
        assert!(error.contains(expected), "{error}");
        assert!(!target.exists());
    }
}
