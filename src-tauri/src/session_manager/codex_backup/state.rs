use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use chrono::DateTime;
use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::rollout::RolloutHeader;

const TEXT_COLUMNS: &[&str] = &[
    "title",
    "name",
    "preview",
    "first_user_message",
    "cwd",
    "source",
    "thread_source",
    "model_provider",
    "model",
    "reasoning_effort",
    "cli_version",
    "history_mode",
    "git_sha",
    "git_branch",
];
const INTEGER_COLUMNS: &[&str] = &[
    "created_at",
    "updated_at",
    "recency_at",
    "created_at_ms",
    "updated_at_ms",
    "recency_at_ms",
    "has_user_event",
    "tokens_used",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
enum Field {
    Integer(i64),
    Text(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub(super) struct ThreadMetadata(BTreeMap<String, Field>);

impl ThreadMetadata {
    fn text(&self, name: &str) -> Option<&str> {
        match self.0.get(name) {
            Some(Field::Text(value)) => Some(value),
            _ => None,
        }
    }

    fn integer(&self, name: &str) -> Option<i64> {
        match self.0.get(name) {
            Some(Field::Integer(value)) => Some(*value),
            _ => None,
        }
    }

    pub(super) fn title(&self) -> &str {
        ["name", "title", "preview", "first_user_message"]
            .into_iter()
            .filter_map(|name| self.text(name))
            .find(|value| !value.trim().is_empty())
            .unwrap_or_default()
    }

    pub(super) fn cwd(&self) -> &str {
        self.text("cwd").unwrap_or_default()
    }

    fn timestamp_ms(&self, seconds: &str, millis: &str) -> Option<i64> {
        self.integer(millis).or_else(|| {
            self.integer(seconds)
                .and_then(|value| value.checked_mul(1000))
        })
    }

    pub(super) fn updated_at_ms(&self) -> i64 {
        self.timestamp_ms("updated_at", "updated_at_ms")
            .unwrap_or_default()
    }

    pub(super) fn validate(&self, paginated: bool) -> Result<(), String> {
        for (name, value) in &self.0 {
            let valid = match value {
                Field::Text(_) => TEXT_COLUMNS.contains(&name.as_str()),
                Field::Integer(_) => INTEGER_COLUMNS.contains(&name.as_str()),
            };
            if !valid {
                return Err("The backup contains unsupported Codex chat metadata.".into());
            }
        }
        match (self.text("history_mode"), paginated) {
            (Some("paginated"), true) | (None | Some("legacy"), false) => Ok(()),
            _ => Err(
                "The Codex catalog and rollout disagree about the chat's history format.".into(),
            ),
        }
    }

    pub(super) fn legacy_from_rollout(
        header: &RolloutHeader,
        title: &str,
        updated_at_ms: i64,
    ) -> Self {
        let mut metadata = BTreeMap::new();
        let created_at_ms = header
            .timestamp
            .as_deref()
            .and_then(|timestamp| DateTime::parse_from_rfc3339(timestamp).ok())
            .map(|date| date.timestamp_millis())
            .unwrap_or(updated_at_ms);
        for (name, value) in [
            ("created_at_ms", created_at_ms),
            ("updated_at_ms", updated_at_ms.max(created_at_ms)),
            ("has_user_event", i64::from(!title.is_empty())),
        ] {
            metadata.insert(name.to_owned(), Field::Integer(value));
        }
        for (name, value) in [
            ("title", title),
            ("preview", title),
            ("first_user_message", title),
            ("history_mode", "legacy"),
        ] {
            metadata.insert(name.to_owned(), Field::Text(value.to_owned()));
        }
        for name in [
            "source",
            "thread_source",
            "cwd",
            "model_provider",
            "model",
            "cli_version",
        ] {
            if let Some(value) = header.payload.get(name).and_then(serde_json::Value::as_str) {
                metadata.insert(name.to_owned(), Field::Text(value.to_owned()));
            }
        }
        Self(metadata)
    }

    fn value(&self, name: &str) -> Option<Value> {
        self.0.get(name).map(|field| match field {
            Field::Integer(value) => Value::Integer(*value),
            Field::Text(value) => Value::Text(value.clone()),
        })
    }
}

pub(super) struct ThreadCatalog {
    columns: BTreeSet<String>,
    text_columns: Vec<&'static str>,
    integer_columns: Vec<&'static str>,
    select_sql: String,
}

impl ThreadCatalog {
    pub(super) fn new(connection: &Connection) -> Result<Self, String> {
        let mut statement = connection
            .prepare("PRAGMA main.table_info('threads')")
            .map_err(catalog_error)?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(catalog_error)?
            .collect::<Result<BTreeSet<_>, _>>()
            .map_err(catalog_error)?;
        if !["id", "rollout_path", "archived"]
            .iter()
            .all(|name| columns.contains(*name))
        {
            return Err("The Codex state database is missing a compatible chat catalog.".into());
        }
        let present = |allowed: &[&'static str]| -> Vec<&'static str> {
            allowed
                .iter()
                .copied()
                .filter(|name| columns.contains(*name))
                .collect()
        };
        let text_columns = present(TEXT_COLUMNS);
        let integer_columns = present(INTEGER_COLUMNS);
        let archive_timestamp = if columns.contains("archived_at") {
            "archived_at IS NOT NULL"
        } else {
            "0"
        };
        let mut fields = vec!["rollout_path", "archived", archive_timestamp];
        fields.extend(text_columns.iter().chain(&integer_columns).copied());
        let select_sql = format!(
            "SELECT {} FROM main.threads WHERE id = ?1",
            fields.join(", ")
        );
        Ok(Self {
            columns,
            text_columns,
            integer_columns,
            select_sql,
        })
    }

    pub(super) fn read_active(
        &self,
        connection: &Connection,
        id: &str,
        canonical_source: &Path,
        paginated: bool,
    ) -> Result<Option<ThreadMetadata>, String> {
        let mut statement = connection
            .prepare_cached(&self.select_sql)
            .map_err(catalog_error)?;
        let mut rows = statement.query([id]).map_err(catalog_error)?;
        let Some(row) = rows.next().map_err(catalog_error)? else {
            return Ok(None);
        };
        if row.get::<_, i64>(1).map_err(catalog_error)? != 0
            || row.get::<_, bool>(2).map_err(catalog_error)?
        {
            return Err("An archived Codex chat cannot be included in a backup.".into());
        }
        let source = row.get::<_, String>(0).map_err(catalog_error)?;
        let source = Path::new(&source);
        if !source.is_absolute() || source.canonicalize().as_deref().ok() != Some(canonical_source)
        {
            return Err(
                "The Codex catalog points to a different rollout for the selected chat.".into(),
            );
        }

        let mut fields = BTreeMap::new();
        for (index, name) in self.text_columns.iter().enumerate() {
            if let Some(value) = row
                .get::<_, Option<String>>(index + 3)
                .map_err(catalog_error)?
            {
                fields.insert((*name).to_owned(), Field::Text(value));
            }
        }
        for (index, name) in self.integer_columns.iter().enumerate() {
            if let Some(value) = row
                .get::<_, Option<i64>>(index + 3 + self.text_columns.len())
                .map_err(catalog_error)?
            {
                fields.insert((*name).to_owned(), Field::Integer(value));
            }
        }
        let metadata = ThreadMetadata(fields);
        metadata.validate(paginated)?;
        Ok(Some(metadata))
    }

    pub(super) fn occupied_ids<'a>(
        &self,
        connection: &Connection,
        ids: impl IntoIterator<Item = &'a str>,
    ) -> Result<BTreeSet<String>, String> {
        let mut statement = connection
            .prepare_cached("SELECT id FROM main.threads WHERE id = ?1")
            .map_err(catalog_error)?;
        let mut occupied = BTreeSet::new();
        for id in ids {
            if let Some(found) = statement
                .query_row([id], |row| row.get(0))
                .optional()
                .map_err(catalog_error)?
            {
                occupied.insert(found);
            }
        }
        Ok(occupied)
    }

    pub(super) fn insert_thread(
        &self,
        connection: &Connection,
        id: &str,
        absolute_path: &Path,
        metadata: &ThreadMetadata,
        paginated: bool,
    ) -> Result<(), String> {
        metadata.validate(paginated)?;
        if paginated && !self.columns.contains("history_mode") {
            return Err("Update Codex before restoring this backup. The current chat catalog does not support paginated history.".into());
        }
        let path = absolute_path
            .to_str()
            .filter(|_| absolute_path.is_absolute())
            .ok_or("The restored Codex rollout needs an absolute Unicode path.")?;
        let updated_at = metadata.updated_at_ms();
        let created_at = metadata
            .timestamp_ms("created_at", "created_at_ms")
            .unwrap_or(updated_at);
        let recency = metadata
            .timestamp_ms("recency_at", "recency_at_ms")
            .unwrap_or(updated_at);
        let mut fields = vec![
            ("id", Value::Text(id.into())),
            ("rollout_path", Value::Text(path.into())),
            ("archived", Value::Integer(0)),
        ];
        let defaults = [
            ("created_at", Value::Integer(created_at.div_euclid(1000))),
            ("created_at_ms", Value::Integer(created_at)),
            ("updated_at", Value::Integer(updated_at.div_euclid(1000))),
            ("updated_at_ms", Value::Integer(updated_at)),
            ("recency_at", Value::Integer(recency.div_euclid(1000))),
            ("recency_at_ms", Value::Integer(recency)),
            (
                "has_user_event",
                Value::Integer(i64::from(!metadata.title().is_empty())),
            ),
            ("tokens_used", Value::Integer(0)),
            ("title", Value::Text(metadata.title().into())),
            ("cwd", Value::Text(metadata.cwd().into())),
            ("preview", Value::Text(metadata.title().into())),
            ("first_user_message", Value::Text(String::new())),
            ("source", Value::Text("vscode".into())),
            ("thread_source", Value::Text("user".into())),
            ("model_provider", Value::Text("openai".into())),
            ("cli_version", Value::Text(String::new())),
            ("sandbox_policy", Value::Text(String::new())),
            ("approval_mode", Value::Text(String::new())),
            ("history_mode", Value::Text("legacy".into())),
        ];
        for (name, fallback) in defaults {
            if self.columns.contains(name) {
                fields.push((name, metadata.value(name).unwrap_or(fallback)));
            }
        }
        for name in ["name", "model", "reasoning_effort", "git_sha", "git_branch"] {
            if let Some(value) = metadata.value(name).filter(|_| self.columns.contains(name)) {
                fields.push((name, value));
            }
        }
        let names = fields.iter().map(|(name, _)| *name).collect::<Vec<_>>();
        let placeholders = vec!["?"; names.len()].join(", ");
        let sql = format!(
            "INSERT INTO main.threads ({}) VALUES ({placeholders})",
            names.join(", ")
        );
        connection
            .prepare_cached(&sql)
            .and_then(|mut statement| {
                statement.execute(params_from_iter(fields.iter().map(|(_, value)| value)))
            })
            .map_err(|_| "Could not register the restored Codex chat. Its ID may already exist, or Codex may have a newer chat catalog.".to_string())?;
        Ok(())
    }
}

fn catalog_error(error: rusqlite::Error) -> String {
    match error {
        rusqlite::Error::SqliteFailure(error, _) => {
            format!("Could not read the Codex chat catalog ({:?}).", error.code)
        }
        _ => "Could not read the Codex chat catalog. Its schema or data is invalid.".into(),
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::params;
    use serde_json::{json, Value as JsonValue};
    use tempfile::NamedTempFile;

    use super::*;

    fn legacy_catalog() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (
                    id TEXT PRIMARY KEY,
                    rollout_path TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    source TEXT NOT NULL,
                    model_provider TEXT NOT NULL,
                    cwd TEXT NOT NULL,
                    title TEXT NOT NULL,
                    sandbox_policy TEXT NOT NULL,
                    approval_mode TEXT NOT NULL,
                    archived INTEGER NOT NULL,
                    archived_at INTEGER
                );",
            )
            .unwrap();
        connection
    }

    fn legacy_metadata() -> ThreadMetadata {
        ThreadMetadata::legacy_from_rollout(
            &RolloutHeader {
                paginated: false,
                base: None,
                payload: json!({ "cwd": "/projects/example", "source": "vscode" }),
                timestamp: Some("2026-11-20T01:00:00.123Z".into()),
            },
            "Continue example fix",
            1_795_140_000_789,
        )
    }

    #[test]
    fn rejects_archived_rows_and_unrelated_rollout_paths() {
        let connection = legacy_catalog();
        let catalog = ThreadCatalog::new(&connection).unwrap();
        let rollout = NamedTempFile::new().unwrap();
        let other = NamedTempFile::new().unwrap();
        let canonical = rollout.path().canonicalize().unwrap();
        assert!(catalog
            .read_active(&connection, "absent", &canonical, false)
            .unwrap()
            .is_none());
        catalog
            .insert_thread(&connection, "a", rollout.path(), &legacy_metadata(), false)
            .unwrap();
        assert!(catalog
            .read_active(
                &connection,
                "a",
                &other.path().canonicalize().unwrap(),
                false
            )
            .unwrap_err()
            .contains("different rollout"));
        for (archived, timestamp) in [(1, None), (0, Some(1_795_140_000))] {
            connection
                .execute(
                    "UPDATE threads SET archived = ?1, archived_at = ?2 WHERE id = 'a'",
                    params![archived, timestamp],
                )
                .unwrap();
            assert!(catalog
                .read_active(&connection, "a", &canonical, false)
                .unwrap_err()
                .contains("archived"));
        }
        assert_eq!(
            catalog.occupied_ids(&connection, ["a", "absent"]).unwrap(),
            BTreeSet::from(["a".into()])
        );
    }

    #[test]
    fn inserts_legacy_rollout_metadata_with_destination_path_and_no_overwrite() {
        let connection = legacy_catalog();
        let catalog = ThreadCatalog::new(&connection).unwrap();
        let rollout = NamedTempFile::new().unwrap();
        let other = NamedTempFile::new().unwrap();
        let metadata = legacy_metadata();
        catalog
            .insert_thread(&connection, "a", rollout.path(), &metadata, false)
            .unwrap();
        assert!(catalog
            .insert_thread(&connection, "a", other.path(), &metadata, false)
            .is_err());
        let restored = catalog
            .read_active(
                &connection,
                "a",
                &rollout.path().canonicalize().unwrap(),
                false,
            )
            .unwrap()
            .unwrap();
        assert_eq!(restored.title(), metadata.title());
        assert_eq!(restored.cwd(), metadata.cwd());
        assert_eq!(
            restored.updated_at_ms(),
            metadata.updated_at_ms().div_euclid(1000) * 1000
        );
    }

    #[test]
    fn round_trips_paginated_catalog_metadata_across_profiles() {
        let source = legacy_catalog();
        let destination = legacy_catalog();
        for connection in [&source, &destination] {
            connection
                .execute_batch(
                    "ALTER TABLE threads ADD COLUMN history_mode TEXT NOT NULL DEFAULT 'legacy';
                     ALTER TABLE threads ADD COLUMN name TEXT;
                     ALTER TABLE threads ADD COLUMN updated_at_ms INTEGER;
                     ALTER TABLE threads ADD COLUMN reasoning_effort TEXT;
                     ALTER TABLE threads ADD COLUMN recency_at_ms INTEGER;
                     ALTER TABLE threads ADD COLUMN creator_account_id TEXT;
                     ALTER TABLE threads ADD COLUMN git_origin_url TEXT;",
                )
                .unwrap();
        }
        let old_rollout = NamedTempFile::new().unwrap();
        let new_rollout = NamedTempFile::new().unwrap();
        let source_catalog = ThreadCatalog::new(&source).unwrap();
        source_catalog
            .insert_thread(&source, "a", old_rollout.path(), &legacy_metadata(), false)
            .unwrap();
        source
            .execute(
                "UPDATE threads SET history_mode = 'paginated', name = 'Fix title',
                    updated_at_ms = 1795140000123, reasoning_effort = 'high',
                    recency_at_ms = 1795140001123, creator_account_id = 'fixture-account',
                    git_origin_url = 'https://git.example/test.git' WHERE id = 'a'",
                [],
            )
            .unwrap();
        let canonical = old_rollout.path().canonicalize().unwrap();
        assert!(source_catalog
            .read_active(&source, "a", &canonical, false)
            .is_err());
        let metadata = source_catalog
            .read_active(&source, "a", &canonical, true)
            .unwrap()
            .unwrap();
        assert_eq!(metadata.title(), "Fix title");
        assert_eq!(metadata.updated_at_ms(), 1_795_140_000_123);
        let serialized = serde_json::to_value(&metadata).unwrap();
        for name in [
            "id",
            "rollout_path",
            "archived",
            "archived_at",
            "sandbox_policy",
            "approval_mode",
            "creator_account_id",
            "git_origin_url",
        ] {
            assert!(serialized.get(name).is_none());
        }
        let metadata = serde_json::from_value(serialized).unwrap();
        let destination_catalog = ThreadCatalog::new(&destination).unwrap();
        destination_catalog
            .insert_thread(&destination, "a", new_rollout.path(), &metadata, true)
            .unwrap();
        let restored = destination_catalog
            .read_active(
                &destination,
                "a",
                &new_rollout.path().canonicalize().unwrap(),
                true,
            )
            .unwrap()
            .unwrap();
        assert_eq!(restored.text("reasoning_effort"), Some("high"));
        assert_eq!(restored.integer("recency_at_ms"), Some(1_795_140_001_123));
        assert_eq!(restored.updated_at_ms(), 1_795_140_000_123);
        assert_eq!(restored.title(), "Fix title");

        let older = legacy_catalog();
        let old_catalog = ThreadCatalog::new(&older).unwrap();
        assert!(old_catalog
            .insert_thread(&older, "a", new_rollout.path(), &metadata, true)
            .unwrap_err()
            .contains("Update Codex"));
    }

    #[test]
    fn rejects_prohibited_or_mistyped_manifest_metadata() {
        for manifest in [
            json!({ "archived": 0 }),
            json!({ "rollout_path": "outside.jsonl" }),
            json!({ "approval_mode": "never" }),
            json!({ "updated_at_ms": "1" }),
        ] {
            let metadata = serde_json::from_value::<ThreadMetadata>(manifest).unwrap();
            assert!(metadata.validate(false).is_err());
        }
        assert!(serde_json::from_value::<ThreadMetadata>(JsonValue::Null).is_err());
    }
}
