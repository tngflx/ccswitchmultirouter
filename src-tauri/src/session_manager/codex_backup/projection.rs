use std::collections::HashSet;
use std::io::{self, BufRead, Write};
use std::path::Path;
use std::time::Duration;

use rusqlite::types::{ToSqlOutput, ValueRef};
use rusqlite::{params_from_iter, Connection, OpenFlags, ToSql};
use serde::de::{self, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};

const MAX_LINE_BYTES: usize = 64 * 1024 * 1024;
const INVALID_RECORD: &str = "The backup has an invalid Codex paginated history record.";
const INVALID_ORDER: &str =
    "The backup has missing, duplicate, or out-of-order Codex paginated history.";
const OUTSIDE_CURSOR: &str = "A Codex history record is outside its saved projection cursor.";
const UNSUPPORTED_SCHEMA: &str =
    "This Codex paginated history database uses an unsupported schema.";

pub(super) struct ProjectionScope<'a> {
    pub(super) rollout_id: &'a str,
    pub(super) size: u64,
    pub(super) end_ordinal_exclusive: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
enum Table {
    Cursor,
    Turn,
    Item,
    RealtimeItem,
}

const TABLES: [Table; 4] = [Table::Cursor, Table::Turn, Table::Item, Table::RealtimeItem];

#[derive(Debug, PartialEq, Serialize)]
#[serde(untagged)]
enum Cell {
    Integer(i64),
    Text(String),
    Null,
}

impl<'de> Deserialize<'de> for Cell {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Scalar;
        impl Visitor<'_> for Scalar {
            type Value = Cell;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a SQLite integer, string, or null")
            }

            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Cell, E> {
                Ok(Cell::Integer(value))
            }

            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Cell, E> {
                i64::try_from(value)
                    .map(Cell::Integer)
                    .map_err(|_| E::custom("integer outside the SQLite range"))
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Cell, E> {
                Ok(Cell::Text(value.to_owned()))
            }

            fn visit_unit<E: de::Error>(self) -> Result<Cell, E> {
                Ok(Cell::Null)
            }
        }
        deserializer.deserialize_any(Scalar)
    }
}

impl Cell {
    fn unsigned(&self) -> Option<u64> {
        match self {
            Self::Integer(value) => (*value).try_into().ok(),
            _ => None,
        }
    }
}

impl ToSql for Cell {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(match self {
            Self::Integer(value) => ValueRef::Integer(*value),
            Self::Text(value) => ValueRef::Text(value.as_bytes()),
            Self::Null => ValueRef::Null,
        }))
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Integer,
    Text,
    NullableInteger,
    NullableText,
}

impl Kind {
    fn accepts(self, value: &Cell) -> bool {
        matches!(
            (self, value),
            (Self::Integer | Self::NullableInteger, Cell::Integer(_))
                | (Self::Text | Self::NullableText, Cell::Text(_))
                | (Self::NullableInteger | Self::NullableText, Cell::Null)
        )
    }
}

#[derive(Clone, Copy)]
enum Missing {
    Required,
    Null,
    Zero,
    Empty,
}

impl Missing {
    fn value(self) -> Option<Cell> {
        match self {
            Self::Required => None,
            Self::Null => Some(Cell::Null),
            Self::Zero => Some(Cell::Integer(0)),
            Self::Empty => Some(Cell::Text(String::new())),
        }
    }

    fn expression(self) -> &'static str {
        match self {
            Self::Required => unreachable!("required projection column"),
            Self::Null => "NULL",
            Self::Zero => "0",
            Self::Empty => "''",
        }
    }
}

struct Column {
    name: &'static str,
    kind: Kind,
    missing: Missing,
}

impl Column {
    const fn required(name: &'static str, kind: Kind) -> Self {
        Self {
            name,
            kind,
            missing: Missing::Required,
        }
    }

    const fn optional(name: &'static str, kind: Kind, missing: Missing) -> Self {
        Self {
            name,
            kind,
            missing,
        }
    }
}

use self::Kind::{Integer, NullableInteger, NullableText, Text};

impl Table {
    fn name(self) -> &'static str {
        match self {
            Self::Cursor => "thread_history_projection_state",
            Self::Turn => "thread_turns",
            Self::Item => "thread_items",
            Self::RealtimeItem => "thread_realtime_items",
        }
    }

    fn columns(self) -> &'static [Column] {
        match self {
            Self::Cursor => {
                const {
                    &[
                        Column::required("next_rollout_byte_offset", Integer),
                        Column::required("next_rollout_ordinal", Integer),
                    ]
                }
            }
            Self::Turn => {
                const {
                    &[
                        Column::required("rollout_ordinal", Integer),
                        Column::required("turn_id", Text),
                        Column::required("status", Text),
                        Column::required("error_json", NullableText),
                        Column::required("started_at", NullableInteger),
                        Column::required("completed_at", NullableInteger),
                        Column::required("duration_ms", NullableInteger),
                        Column::required("first_user_item_id", NullableText),
                        Column::required("final_agent_item_id", NullableText),
                        Column::optional("rollout_byte_offset", NullableInteger, Missing::Null),
                        Column::optional("rollout_end_ordinal", NullableInteger, Missing::Null),
                        Column::optional("rollout_end_byte_offset", NullableInteger, Missing::Null),
                        Column::optional("root_turn_id", NullableText, Missing::Null),
                    ]
                }
            }
            Self::Item => {
                const {
                    &[
                        Column::required("rollout_ordinal", Integer),
                        Column::required("turn_id", Text),
                        Column::required("item_id", Text),
                        Column::required("created_at_ms", Integer),
                        Column::required("item_json", Text),
                        Column::optional("item_type", Text, Missing::Empty),
                        Column::optional("updated_at_ordinal", Integer, Missing::Zero),
                        Column::optional("started_at_ms", NullableInteger, Missing::Null),
                        Column::optional("completed_at_ms", NullableInteger, Missing::Null),
                    ]
                }
            }
            Self::RealtimeItem => {
                const {
                    &[
                        Column::required("rollout_ordinal", Integer),
                        Column::required("item_id", Text),
                        Column::required("created_at_ms", Integer),
                        Column::required("item_type", Text),
                        Column::required("item_json", Text),
                    ]
                }
            }
        }
    }
}

#[derive(Default)]
struct RecordLine(Vec<u8>);

impl Write for RecordLine {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) >= MAX_LINE_BYTES {
            return Err(io::Error::other(
                "projection record exceeds the backup limit",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct Schema {
    table: Table,
    present: Vec<bool>,
}

impl Schema {
    fn read(conn: &Connection, database: &str, table: Table) -> Result<Option<Self>, String> {
        let mut stmt = conn
            .prepare_cached("SELECT name FROM pragma_table_info(?1, ?2)")
            .map_err(|_| UNSUPPORTED_SCHEMA)?;
        let names = stmt
            .query_map([table.name(), database], |row| row.get::<_, String>(0))
            .map_err(|_| UNSUPPORTED_SCHEMA)?
            .collect::<rusqlite::Result<HashSet<_>>>()
            .map_err(|_| UNSUPPORTED_SCHEMA)?;
        if names.is_empty() && table == Table::RealtimeItem {
            return Ok(None);
        }
        let mut known_count = 1;
        let mut present = Vec::new();
        for column in table.columns() {
            let found = names.contains(column.name);
            if !found && matches!(column.missing, Missing::Required) {
                return Err(UNSUPPORTED_SCHEMA.into());
            }
            present.push(found);
            known_count += usize::from(found);
        }
        if !names.contains("thread_id") || names.len() != known_count {
            return Err(UNSUPPORTED_SCHEMA.into());
        }
        Ok(Some(Self { table, present }))
    }

    fn select(&self) -> String {
        let fields = self
            .table
            .columns()
            .iter()
            .zip(&self.present)
            .map(|(column, present)| {
                if *present {
                    column.name
                } else {
                    column.missing.expression()
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        let order = if self.table == Table::Cursor {
            ""
        } else {
            " ORDER BY rollout_ordinal"
        };
        format!(
            "SELECT {fields} FROM main.{} WHERE thread_id = ?1{order}",
            self.table.name()
        )
    }

    fn insert(&self) -> String {
        let fields = self
            .table
            .columns()
            .iter()
            .zip(&self.present)
            .filter_map(|(column, present)| present.then_some(column.name));
        let fields = std::iter::once("thread_id")
            .chain(fields)
            .collect::<Vec<_>>();
        let parameters = vec!["?"; fields.len()].join(", ");
        format!(
            "INSERT INTO backup_history.{} ({}) VALUES ({parameters})",
            self.table.name(),
            fields.join(", ")
        )
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Record {
    rollout_id: String,
    table: Table,
    #[serde(deserialize_with = "deserialize_cells")]
    values: Vec<Cell>,
}

fn deserialize_cells<'de, D>(deserializer: D) -> Result<Vec<Cell>, D::Error>
where
    D: Deserializer<'de>,
{
    struct Cells;
    impl<'de> Visitor<'de> for Cells {
        type Value = Vec<Cell>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a fixed-width projection row")
        }

        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            let limit = Table::Turn.columns().len();
            let mut cells = Vec::with_capacity(limit);
            while cells.len() < limit {
                let Some(cell) = seq.next_element()? else {
                    return Ok(cells);
                };
                cells.push(cell);
            }
            if seq.next_element::<de::IgnoredAny>()?.is_some() {
                return Err(de::Error::invalid_length(limit + 1, &self));
            }
            Ok(cells)
        }
    }
    deserializer.deserialize_seq(Cells)
}

#[derive(Clone, Copy)]
struct Cursor {
    bytes: u64,
    ordinal: u64,
}

impl Cursor {
    fn read(scope: &ProjectionScope<'_>, values: &[Cell]) -> Result<Self, String> {
        let bytes = values[0].unsigned().ok_or(INVALID_RECORD)?;
        let ordinal = values[1].unsigned().ok_or(INVALID_RECORD)?;
        if bytes > scope.size
            || ordinal > scope.end_ordinal_exclusive
            || (bytes == scope.size) != (ordinal == scope.end_ordinal_exclusive)
            || (bytes == 0) != (ordinal == 0)
        {
            return Err("The Codex history cursor differs from the saved rollout. Retry after the current write finishes.".into());
        }
        Ok(Self { bytes, ordinal })
    }

    fn row_ordinal(self, record: &Record) -> Result<u64, String> {
        let ordinal = record.values[0].unsigned().ok_or(INVALID_RECORD)?;
        if ordinal >= self.ordinal {
            return Err(OUTSIDE_CURSOR.into());
        }
        let upper_bound = |value: &Cell, end: u64| {
            if *value == Cell::Null || value.unsigned().is_some_and(|n| n <= end) {
                Ok(())
            } else {
                Err(OUTSIDE_CURSOR)
            }
        };
        match record.table {
            Table::Turn => {
                upper_bound(&record.values[9], self.bytes.saturating_sub(1))?;
                upper_bound(&record.values[10], self.ordinal - 1)?;
                upper_bound(&record.values[11], self.bytes)?;
            }
            Table::Item => upper_bound(&record.values[6], self.ordinal - 1)?,
            Table::RealtimeItem | Table::Cursor => {}
        }
        Ok(ordinal)
    }
}

struct RecordOrder<'a> {
    scopes: &'a [ProjectionScope<'a>],
    current_scope: usize,
    cursor: Option<Cursor>,
    previous: Option<(Table, u64)>,
}

impl<'a> RecordOrder<'a> {
    fn new(scopes: &'a [ProjectionScope<'a>]) -> Self {
        Self {
            scopes,
            current_scope: 0,
            cursor: None,
            previous: None,
        }
    }

    fn accept(&mut self, record: &Record) -> Result<(), String> {
        let columns = record.table.columns();
        if record.values.len() != columns.len()
            || !record
                .values
                .iter()
                .zip(columns)
                .all(|(value, col)| col.kind.accepts(value))
        {
            return Err(INVALID_RECORD.into());
        }
        if record.table == Table::Cursor {
            let scope = self
                .scopes
                .get(self.current_scope)
                .filter(|scope| scope.rollout_id == record.rollout_id)
                .ok_or(INVALID_ORDER)?;
            self.cursor = Some(Cursor::read(scope, &record.values)?);
            self.current_scope += 1;
            self.previous = None;
        } else {
            let cursor = self.cursor.ok_or(INVALID_ORDER)?;
            if self.scopes[self.current_scope - 1].rollout_id != record.rollout_id {
                return Err(INVALID_ORDER.into());
            }
            let key = (record.table, cursor.row_ordinal(record)?);
            if self.previous.is_some_and(|previous| previous >= key) {
                return Err(INVALID_ORDER.into());
            }
            self.previous = Some(key);
        }
        Ok(())
    }

    fn finish(self) -> Result<(), String> {
        if self.current_scope != self.scopes.len() {
            return Err(INVALID_ORDER.into());
        }
        Ok(())
    }
}

pub(super) fn export_projection(
    database: &Path,
    selected: &[ProjectionScope<'_>],
    output: &mut impl Write,
) -> Result<(), String> {
    let mut conn = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "Could not open the source Codex paginated history database.")?;
    conn.busy_timeout(Duration::from_secs(3))
        .map_err(|_| "Could not configure the Codex history database.")?;
    let tx = conn
        .transaction()
        .map_err(|_| "Could not read a snapshot of Codex paginated history.")?;
    let schemas = TABLES
        .into_iter()
        .filter_map(|table| Schema::read(&tx, "main", table).transpose())
        .collect::<Result<Vec<_>, _>>()?;
    let queries = schemas.iter().map(Schema::select).collect::<Vec<_>>();
    let mut order = RecordOrder::new(selected);
    let mut line = RecordLine::default();
    for scope in selected {
        for (schema, query) in schemas.iter().zip(&queries) {
            let mut stmt = tx.prepare_cached(query).map_err(|_| UNSUPPORTED_SCHEMA)?;
            let mut rows = stmt
                .query([scope.rollout_id])
                .map_err(|_| "Could not query the selected Codex history.")?;
            while let Some(row) = rows
                .next()
                .map_err(|_| "Could not read the selected Codex history.")?
            {
                let mut values = Vec::with_capacity(schema.present.len());
                for index in 0..schema.present.len() {
                    let value = match row.get_ref(index).map_err(|_| INVALID_RECORD)? {
                        ValueRef::Integer(value) => Cell::Integer(value),
                        ValueRef::Text(value) if value.len() < MAX_LINE_BYTES => Cell::Text(
                            std::str::from_utf8(value)
                                .map_err(|_| INVALID_RECORD)?
                                .to_owned(),
                        ),
                        ValueRef::Null => Cell::Null,
                        _ => return Err(INVALID_RECORD.into()),
                    };
                    values.push(value);
                }
                let record = Record {
                    rollout_id: scope.rollout_id.into(),
                    table: schema.table,
                    values,
                };
                order.accept(&record)?;
                line.0.clear();
                serde_json::to_writer(&mut line, &record).map_err(|_| {
                    "A Codex paginated history record exceeds the 64 MiB backup limit."
                })?;
                line.0.push(b'\n');
                output
                    .write_all(&line.0)
                    .map_err(|_| "Could not write the backed-up Codex history.")?;
            }
        }
    }
    order.finish()
}

fn read_projection(
    input: &mut impl BufRead,
    selected: &[ProjectionScope<'_>],
    mut visit: impl FnMut(Record) -> Result<(), String>,
) -> Result<(), String> {
    let mut order = RecordOrder::new(selected);
    let mut line = Vec::new();
    loop {
        line.clear();
        let mut bounded = std::io::Read::take(&mut *input, MAX_LINE_BYTES as u64);
        let size = bounded
            .read_until(b'\n', &mut line)
            .map_err(|_| "Could not read the backed-up Codex history.")?;
        if size == 0 {
            break;
        }
        if !line.ends_with(b"\n") {
            return Err(INVALID_RECORD.into());
        }
        let record = serde_json::from_slice(&line).map_err(|_| INVALID_RECORD)?;
        order.accept(&record)?;
        visit(record)?;
    }
    order.finish()
}

pub(super) fn validate_projection(
    input: &mut impl BufRead,
    selected: &[ProjectionScope<'_>],
) -> Result<(), String> {
    read_projection(input, selected, |_| Ok(()))
}

pub(super) fn restore_projection(
    conn: &Connection,
    input: &mut impl BufRead,
    selected: &[ProjectionScope<'_>],
    restore: &HashSet<String>,
) -> Result<(), String> {
    let schemas = TABLES
        .map(|table| Schema::read(conn, "backup_history", table))
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;
    let inserts = schemas
        .iter()
        .map(|schema| schema.as_ref().map(Schema::insert))
        .collect::<Vec<_>>();
    for schema in schemas.iter().flatten() {
        let query = format!(
            "SELECT EXISTS(SELECT 1 FROM backup_history.{} WHERE thread_id = ?1)",
            schema.table.name()
        );
        let mut stmt = conn
            .prepare_cached(&query)
            .map_err(|_| UNSUPPORTED_SCHEMA)?;
        for rollout_id in restore {
            if stmt
                .query_row([rollout_id], |row| row.get::<_, bool>(0))
                .map_err(|_| "Could not check destination Codex history.")?
            {
                return Err(
                    "The destination already has history for a Codex rollout in this backup."
                        .into(),
                );
            }
        }
    }
    read_projection(input, selected, |record| {
        if !restore.contains(&record.rollout_id) {
            return Ok(());
        }
        let index = record.table as usize;
        let schema = schemas[index].as_ref().ok_or(UNSUPPORTED_SCHEMA)?;
        let query = inserts[index].as_ref().ok_or(UNSUPPORTED_SCHEMA)?;
        let mut values = Vec::with_capacity(record.values.len() + 1);
        values.push(Cell::Text(record.rollout_id));
        for ((value, column), present) in record
            .values
            .into_iter()
            .zip(record.table.columns())
            .zip(&schema.present)
        {
            if *present {
                values.push(value);
            } else if column.missing.value().as_ref() != Some(&value) {
                return Err(UNSUPPORTED_SCHEMA.into());
            }
        }
        conn.prepare_cached(query)
            .map_err(|_| UNSUPPORTED_SCHEMA)?
            .execute(params_from_iter(values.iter()))
            .map_err(|_| "Could not insert the backed-up Codex history.")?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const FIRST: &str = "11111111-1111-4111-8111-111111111111";
    const SECOND: &str = "22222222-2222-4222-8222-222222222222";
    const OTHER: &str = "33333333-3333-4333-8333-333333333333";

    // The original Codex projection schema exercises migration defaults when
    // newer columns and realtime history are absent.
    const EARLY_SCHEMA: &str = "
        CREATE TABLE thread_history_projection_state (
            thread_id TEXT PRIMARY KEY,
            next_rollout_byte_offset INTEGER NOT NULL,
            next_rollout_ordinal INTEGER NOT NULL
        );
        CREATE TABLE thread_turns (
            thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL,
            status TEXT NOT NULL, error_json TEXT, started_at INTEGER, completed_at INTEGER,
            duration_ms INTEGER, first_user_item_id TEXT, final_agent_item_id TEXT,
            PRIMARY KEY (thread_id, turn_id), UNIQUE (thread_id, rollout_ordinal)
        );
        CREATE TABLE thread_items (
            thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
            rollout_ordinal INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, item_json TEXT NOT NULL,
            PRIMARY KEY (thread_id, turn_id, item_id), UNIQUE (thread_id, rollout_ordinal)
        );";

    const LATER_COLUMNS: &str = "
        ALTER TABLE thread_turns ADD COLUMN rollout_byte_offset INTEGER;
        ALTER TABLE thread_turns ADD COLUMN rollout_end_ordinal INTEGER;
        ALTER TABLE thread_turns ADD COLUMN rollout_end_byte_offset INTEGER;
        ALTER TABLE thread_turns ADD COLUMN root_turn_id TEXT;
        ALTER TABLE thread_items ADD COLUMN item_type TEXT NOT NULL DEFAULT '';
        ALTER TABLE thread_items ADD COLUMN updated_at_ordinal INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE thread_items ADD COLUMN started_at_ms INTEGER;
        ALTER TABLE thread_items ADD COLUMN completed_at_ms INTEGER;
        CREATE TABLE thread_realtime_items (
            thread_id TEXT NOT NULL, item_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL, item_type TEXT NOT NULL, item_json TEXT NOT NULL,
            PRIMARY KEY (thread_id, item_id), UNIQUE (thread_id, rollout_ordinal)
        );";

    fn open_history(path: &Path, latest: bool) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(EARLY_SCHEMA).unwrap();
        if latest {
            conn.execute_batch(LATER_COLUMNS).unwrap();
        }
        conn
    }

    fn add_history(conn: &Connection, id: &str, latest: bool) {
        conn.execute(
            "INSERT INTO thread_history_projection_state VALUES (?, 100, 5)",
            [id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status) VALUES (?, 'turn', 2, 'completed')",
            [id],
        ).unwrap();
        conn.execute(
            "INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json)
             VALUES (?, 'turn', 'item', 3, 10, '{}')",
            [id],
        ).unwrap();
        if latest {
            conn.execute(
                "UPDATE thread_turns SET rollout_byte_offset=20, rollout_end_ordinal=4,
                 rollout_end_byte_offset=100, root_turn_id='root' WHERE thread_id=?",
                [id],
            )
            .unwrap();
            conn.execute(
                "UPDATE thread_items SET updated_at_ordinal=4, started_at_ms=10,
                 completed_at_ms=11, item_type='userMessage' WHERE thread_id=?",
                [id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO thread_realtime_items VALUES (?, 'rt', 4, 20, 'observation', '{}')",
                [id],
            )
            .unwrap();
        }
    }

    fn scope(id: &str) -> ProjectionScope<'_> {
        ProjectionScope {
            rollout_id: id,
            size: 100,
            end_ordinal_exclusive: 5,
        }
    }

    fn attach_history(path: &Path) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "ATTACH DATABASE ? AS backup_history",
            [path.to_str().unwrap()],
        )
        .unwrap();
        conn
    }

    #[test]
    fn exports_only_selected_rollouts_and_restores_only_requested_rows() {
        let dir = tempdir().unwrap();
        let source_path = dir.path().join("source.sqlite");
        let source = open_history(&source_path, true);
        for id in [FIRST, SECOND, OTHER] {
            add_history(&source, id, true);
        }
        let scopes = [scope(SECOND), scope(FIRST)];
        let mut exported = Vec::new();
        export_projection(&source_path, &scopes, &mut exported).unwrap();
        let text = std::str::from_utf8(&exported).unwrap();
        assert_eq!(text.lines().count(), 8);
        assert!(!text.contains(OTHER));
        validate_projection(&mut exported.as_slice(), &scopes).unwrap();

        let dest_path = dir.path().join("dest.sqlite");
        let dest = open_history(&dest_path, true);
        add_history(&dest, OTHER, true);
        let mut conn = attach_history(&dest_path);
        let tx = conn.transaction().unwrap();
        restore_projection(
            &tx,
            &mut exported.as_slice(),
            &scopes,
            &HashSet::from([FIRST.into()]),
        )
        .unwrap();
        tx.commit().unwrap();
        for table in TABLES {
            let sql = format!("SELECT thread_id FROM {} ORDER BY thread_id", table.name());
            let mut stmt = dest.prepare(&sql).unwrap();
            let ids = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            assert_eq!(ids, [FIRST, OTHER]);
        }
        let turn = dest
            .query_row(
                "SELECT rollout_end_byte_offset, root_turn_id FROM thread_turns WHERE thread_id=?",
                [FIRST],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .unwrap();
        assert_eq!(turn, (100, "root".into()));
        let item = dest
            .query_row(
                "SELECT updated_at_ordinal, completed_at_ms FROM thread_items WHERE thread_id=?",
                [FIRST],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .unwrap();
        assert_eq!(item, (4, 11));
    }

    #[test]
    fn blocks_existing_projection_before_inserting_any_rows() {
        let dir = tempdir().unwrap();
        let source_path = dir.path().join("source.sqlite");
        let source = open_history(&source_path, false);
        add_history(&source, FIRST, false);
        add_history(&source, SECOND, false);
        let scopes = [scope(FIRST), scope(SECOND)];
        let mut exported = Vec::new();
        export_projection(&source_path, &scopes, &mut exported).unwrap();

        let dest_path = dir.path().join("dest.sqlite");
        let dest = open_history(&dest_path, false);
        add_history(&dest, SECOND, false);
        let mut conn = attach_history(&dest_path);
        let tx = conn.transaction().unwrap();
        let error = restore_projection(
            &tx,
            &mut exported.as_slice(),
            &scopes,
            &HashSet::from([FIRST.into(), SECOND.into()]),
        )
        .unwrap_err();
        assert!(error.contains("already has history"));
        assert_eq!(tx.query_row(
            "SELECT COUNT(*) FROM backup_history.thread_history_projection_state WHERE thread_id=?",
            [FIRST],
            |row| row.get::<_, i64>(0),
        ).unwrap(), 0);
    }

    #[test]
    fn validates_cursor_and_all_row_boundaries_with_generic_errors() {
        fn record(id: &str, table: &str, values: serde_json::Value) -> String {
            let row = serde_json::json!({"rollout_id": id, "table": table, "values": values});
            format!("{row}\n")
        }
        use serde_json::json;
        let scopes = [scope(FIRST)];
        let cursor = record(FIRST, "cursor", json!([100, 5]));
        let late_bytes = record(FIRST, "cursor", json!([101, 5]));
        let late_ordinal = record(FIRST, "cursor", json!([100, 6]));
        let mismatched = record(FIRST, "cursor", json!([100, 4]));
        let foreign = record(OTHER, "cursor", json!([100, 5]));
        let bad_kind = record(FIRST, "cursor", json!([100, true]));
        let too_many = record(FIRST, "cursor", json!(vec![0; 14]));
        let late_turn = record(
            FIRST,
            "turn",
            json!([
                2,
                "turn",
                "completed",
                null,
                null,
                null,
                null,
                null,
                null,
                10,
                5,
                80,
                null
            ]),
        );
        let late_item = record(
            FIRST,
            "item",
            json!([
                3,
                "turn",
                "item",
                10,
                "private conversation",
                "",
                5,
                null,
                null
            ]),
        );
        let late_realtime = record(
            FIRST,
            "realtime_item",
            json!([5, "rt", 10, "observation", "{}"]),
        );
        let starting_after_end = record(
            FIRST,
            "turn",
            json!([
                2,
                "turn",
                "completed",
                null,
                null,
                null,
                null,
                null,
                null,
                100,
                4,
                100,
                null
            ]),
        );
        let item = record(
            FIRST,
            "item",
            json!([3, "turn", "item", 10, "{}", "", 3, null, null]),
        );
        let lagging = record(FIRST, "cursor", json!([80, 4]));
        for rejected in [
            late_bytes,
            late_ordinal,
            mismatched,
            foreign,
            bad_kind,
            too_many,
            format!("{cursor}{late_turn}"),
            format!("{cursor}{late_item}"),
            format!("{cursor}{late_realtime}"),
            format!("{cursor}{starting_after_end}"),
            format!("{cursor}{cursor}"),
            format!("{cursor}{item}{item}"),
            cursor.trim_end().into(),
            String::new(),
        ] {
            let error = validate_projection(&mut rejected.as_bytes(), &scopes).unwrap_err();
            assert!(!error.contains("private conversation"));
        }
        validate_projection(&mut lagging.as_bytes(), &scopes).unwrap();
        validate_projection(&mut format!("{cursor}{item}").as_bytes(), &scopes).unwrap();
    }
}
