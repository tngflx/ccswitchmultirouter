use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::orchestration::{Run, Settings};
use rusqlite::{params, Connection, OptionalExtension};

const SETTINGS_KEY: &str = "multimodel_orchestration_v1";

impl Database {
    pub(crate) fn create_orchestration_tables(conn: &Connection) -> Result<(), AppError> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS orchestration_runs (
                id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS orchestration_runs_started
                ON orchestration_runs(started_at);",
        )
        .map_err(|e| AppError::Database(e.to_string()))
    }

    pub fn get_orchestration_settings(&self) -> Result<Settings, AppError> {
        match self.get_setting(SETTINGS_KEY)? {
            None => Ok(Settings::default()),
            Some(value) => {
                let settings: Settings = serde_json::from_str(&value).map_err(|e| {
                    AppError::Database(format!("Invalid orchestration settings: {e}"))
                })?;
                settings.validate().map_err(AppError::Message)?;
                Ok(settings)
            }
        }
    }

    pub fn save_orchestration_settings(&self, settings: &Settings) -> Result<(), AppError> {
        settings.validate().map_err(AppError::Message)?;
        let json = serde_json::to_string(settings).map_err(|e| AppError::Message(e.to_string()))?;
        self.set_setting(SETTINGS_KEY, &json)
    }

    pub fn save_orchestration_run(&self, run: &Run) -> Result<(), AppError> {
        let payload = serde_json::to_string(run).map_err(|e| AppError::Message(e.to_string()))?;
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT INTO orchestration_runs (id, started_at, payload) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
            params![run.id, run.started_at, payload],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        // Bound telemetry storage without removing active runs.
        conn.execute(
            "DELETE FROM orchestration_runs WHERE id NOT IN (
                SELECT id FROM orchestration_runs ORDER BY started_at DESC LIMIT 500
             ) AND json_extract(payload, '$.finishedAt') IS NOT NULL",
            [],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    pub fn list_orchestration_runs(&self) -> Result<Vec<Run>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare("SELECT payload FROM orchestration_runs ORDER BY started_at DESC LIMIT 100")
            .map_err(|e| AppError::Database(e.to_string()))?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| AppError::Database(e.to_string()))?;
        rows.map(|row| {
            let payload = row.map_err(|e| AppError::Database(e.to_string()))?;
            serde_json::from_str(&payload).map_err(|e| AppError::Database(e.to_string()))
        })
        .collect()
    }

    pub fn get_orchestration_run(&self, id: &str) -> Result<Option<Run>, AppError> {
        let conn = lock_conn!(self.conn);
        let payload = conn
            .query_row(
                "SELECT payload FROM orchestration_runs WHERE id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| AppError::Database(e.to_string()))?;
        payload
            .map(|value| {
                serde_json::from_str(&value).map_err(|e| AppError::Database(e.to_string()))
            })
            .transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_and_redacted_trace_round_trip() {
        let db = Database::memory().unwrap();
        assert!(!db.get_orchestration_settings().unwrap().enabled);
        db.save_orchestration_settings(&crate::orchestration::fixture())
            .unwrap();
        assert_eq!(db.get_orchestration_settings().unwrap().profiles.len(), 1);
        let run = Run {
            id: "run".into(),
            profile_id: "test".into(),
            app_type: "codex".into(),
            session_id: "session".into(),
            status: "verified".into(),
            started_at: 1,
            finished_at: Some(2),
            events: vec![],
        };
        db.save_orchestration_run(&run).unwrap();
        db.save_orchestration_run(&run).unwrap();
        assert_eq!(db.list_orchestration_runs().unwrap().len(), 1);
    }
}
