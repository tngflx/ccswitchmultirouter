use std::fs;
use std::path::Path;

use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};

pub(super) const NATIVE_FILENAME: &str = "thread_history_1.sqlite";

// Codex rust-v0.171.0-alpha.13, state/thread_history_migrations. The schema below
// represents the result of migrations 1 through 9 on an empty database. SQLx
// verifies the SHA-384 of each original migration, including its whitespace.
const NATIVE_MIGRATIONS: [(i64, &str, &str); 9] = [
    (
        1,
        "thread history",
        "2ad9a4ab17df511fb73f03337133de94a172dc0a1f5729b5ef61fe106db03d1a43bdb5978b0cb7d7bc74071d3ca34a92",
    ),
    (
        2,
        "thread items item type",
        "ae61dbc1a6422530aa93914dbcac363a0238b86ae1a9d77eb041c75330e1283a0fcf93a043deeefcd6fd2c4037694bc4",
    ),
    (
        3,
        "turn rollout positions",
        "a51da2a11df7760d8f8cab221e82b36ce8c0a30f16d44f3602e7f0fbc622ca72f1c3e3ecf22a194e12c2222bdcb51afe",
    ),
    (
        4,
        "thread items updated at ordinal",
        "65f33b171bd3aafe9d24728b2ca6a5c720a3ab54aed472998f8acf7489f0d35b2dfd12258a2d17be993bf17098b5e50c",
    ),
    (
        5,
        "thread realtime items",
        "2fdad8e361dc1f828afacf10bd2eb1f511b02deef7fa234a9c412d0211de126d1cfad54b175c9c3a9731548f9084b437",
    ),
    (
        6,
        "thread turn ends",
        "02ed82d375adb58b5c0c09e0154f3331d507cea7af446d12324e5653cdba9a91f84afd38cf2a29f33030614689deb9de",
    ),
    (
        7,
        "thread item lifecycle timestamps",
        "9334adb4cda792116a47b69a19e3840ae3806b08773ef1794043fe0aa72891360acb1a0a8431084d53c568482c5fdd20",
    ),
    (
        8,
        "thread turn root",
        "94635cd58535adb1679f4ad07a9d14231b69004405fa88a22db1b6a7e5feac8b6b66ad97ea16fce464b99bff5b3548d3",
    ),
    (
        9,
        "realtime observation indexes",
        "4def92ea0f557ec6333bfe80798c89eb5ac3bd569058a502846fc630aed20f774cd8de3628cd8af740c1be94dd8216b1",
    ),
];

const SCHEMA: &str = r#"
CREATE TABLE _sqlx_migrations (
    version BIGINT PRIMARY KEY,
    description TEXT NOT NULL,
    installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    success BOOLEAN NOT NULL,
    checksum BLOB NOT NULL,
    execution_time BIGINT NOT NULL
);

CREATE TABLE thread_history_projection_state (
    thread_id TEXT PRIMARY KEY,
    next_rollout_byte_offset INTEGER NOT NULL,
    next_rollout_ordinal INTEGER NOT NULL
);

CREATE TABLE thread_turns (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    rollout_ordinal INTEGER NOT NULL,
    status TEXT NOT NULL,
    error_json TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    duration_ms INTEGER,
    first_user_item_id TEXT,
    final_agent_item_id TEXT,
    rollout_byte_offset INTEGER,
    rollout_end_ordinal INTEGER,
    rollout_end_byte_offset INTEGER,
    root_turn_id TEXT,
    PRIMARY KEY (thread_id, turn_id)
);
CREATE UNIQUE INDEX idx_thread_turns_page ON thread_turns(thread_id, rollout_ordinal);
CREATE INDEX idx_thread_turns_end_page ON thread_turns(thread_id, rollout_end_ordinal, turn_id)
    WHERE rollout_end_ordinal IS NOT NULL;

CREATE TABLE thread_items (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    rollout_ordinal INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    item_json TEXT NOT NULL,
    item_type TEXT NOT NULL DEFAULT '',
    updated_at_ordinal INTEGER NOT NULL DEFAULT 0,
    started_at_ms INTEGER,
    completed_at_ms INTEGER,
    PRIMARY KEY (thread_id, turn_id, item_id)
);
CREATE UNIQUE INDEX idx_thread_items_page ON thread_items(thread_id, rollout_ordinal);
CREATE INDEX idx_thread_items_by_turn_page ON thread_items(thread_id, turn_id, rollout_ordinal);
CREATE INDEX idx_thread_items_user_messages ON thread_items(thread_id, rollout_ordinal)
    WHERE item_type = 'userMessage';
CREATE INDEX idx_thread_items_updated_page ON thread_items(thread_id, updated_at_ordinal);
CREATE INDEX idx_thread_items_by_turn_updated_page
    ON thread_items(thread_id, turn_id, updated_at_ordinal);

CREATE TABLE thread_realtime_items (
    thread_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    rollout_ordinal INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    item_type TEXT NOT NULL,
    item_json TEXT NOT NULL,
    PRIMARY KEY (thread_id, item_id)
);
CREATE UNIQUE INDEX idx_thread_realtime_items_page ON thread_realtime_items(thread_id, rollout_ordinal);
CREATE INDEX idx_thread_realtime_items_boundary ON thread_realtime_items(thread_id, rollout_ordinal)
    WHERE item_type IN ('realtime_session_started', 'realtime_session_closed');
CREATE INDEX idx_thread_realtime_observed
    ON thread_realtime_items(thread_id, json_extract(item_json, '$.observed_at_ms'), rollout_ordinal, item_id)
    WHERE json_extract(item_json, '$.observed_at_ms') IS NOT NULL;
CREATE INDEX idx_thread_realtime_session_observed
    ON thread_realtime_items(thread_id, json_extract(item_json, '$.realtime_session_id'),
        json_extract(item_json, '$.observed_at_ms'), rollout_ordinal, item_id)
    WHERE json_extract(item_json, '$.observed_at_ms') IS NOT NULL;
CREATE INDEX idx_thread_realtime_session_position
    ON thread_realtime_items(thread_id, json_extract(item_json, '$.realtime_session_id'), rollout_ordinal, item_id)
    WHERE json_extract(item_json, '$.observed_at_ms') IS NOT NULL;

CREATE TRIGGER thread_realtime_items_projection_cleanup
AFTER DELETE ON thread_history_projection_state
BEGIN
    DELETE FROM thread_realtime_items WHERE thread_id = OLD.thread_id;
END;
"#;

/// Initializes a private, empty staging file for a profile without a history database.
pub(super) fn initialize(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect the staged Codex history database: {error}"))?;
    if !metadata.is_file() || metadata.len() != 0 {
        return Err("The staged Codex history database must be an empty file.".into());
    }

    let initialize_schema = || -> rusqlite::Result<()> {
        let mut db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(SCHEMA)?;
        let mut store_migration = tx.prepare(
            "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
             VALUES (?1, ?2, TRUE, ?3, -1)",
        )?;
        for (version, description, digest) in NATIVE_MIGRATIONS {
            let checksum = hex::decode(digest).expect("pinned SHA-384 migration checksum");
            store_migration.execute(params![version, description, checksum])?;
        }
        drop(store_migration);
        tx.commit()
    };
    initialize_schema()
        .map_err(|error| format!("Could not initialize the staged Codex history database: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initializes_native_schema_and_migration_ledger() {
        let staged = tempfile::NamedTempFile::new().unwrap();
        initialize(staged.path()).unwrap();

        let db = Connection::open(staged.path()).unwrap();
        let ledger = db
            .prepare(
                "SELECT version, description, hex(checksum) FROM _sqlx_migrations
                 WHERE success = TRUE AND typeof(checksum) = 'blob' ORDER BY version",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?.to_ascii_lowercase(),
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            ledger,
            NATIVE_MIGRATIONS.map(|(version, description, digest)| (
                version,
                description.to_owned(),
                digest.to_owned()
            ))
        );

        db.execute_batch(
            r#"
            INSERT INTO thread_history_projection_state VALUES ('rollout', 42, 5);
            INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status, root_turn_id)
                VALUES ('rollout', 'turn', 1, 'completed', 'root-turn');
            INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms,
                item_json, started_at_ms, completed_at_ms)
                VALUES ('rollout', 'turn', 'item', 2, 10, '{}', 10, 11);
            INSERT INTO thread_realtime_items VALUES ('rollout', 'realtime-item', 3, 12,
                'realtime_session_started', '{"observed_at_ms": 12, "realtime_session_id": "observed"}');
            DELETE FROM thread_history_projection_state WHERE thread_id = 'rollout';
            "#,
        )
        .unwrap();
        let realtime_items: i64 = db
            .query_row("SELECT count(*) FROM thread_realtime_items", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(realtime_items, 0);
        assert!(initialize(staged.path()).is_err());
    }
}
