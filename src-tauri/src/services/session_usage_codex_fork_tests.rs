//! Sanitized behavioral fixtures for copied Codex fork accounting.
//! The recorder rewrites inherited envelopes. Explicit coherent fork ordinals
//! plus complete content proof, not clocks/UUID contexts/resume markers alone,
//! certify replay. Literal no-authority fixtures deliberately remain deferred.

use super::*;
use serde_json::{json, Value};
use std::io::Write;
use tempfile::tempdir;

const PARENT: &str = "00000000-0000-4000-8000-000000000101";
const CHILD: &str = "00000000-0000-4000-8000-000000000102";
const OTHER: &str = "00000000-0000-4000-8000-000000000103";
const PARENT_TURN: &str = "00000000-0000-4000-8000-000000000201";
const CHILD_TURN: &str = "00000000-0000-4000-8000-000000000202";
const MODEL_A: &str = "gpt-5.6-sol";
const MODEL_B: &str = "gpt-5.6-luna";
const LIVE_TIME: &str = "2026-07-10T03:00:08Z";

fn record(timestamp: &str, kind: &str, payload: Value) -> Value {
    json!({ "timestamp": timestamp, "type": kind, "payload": payload })
}

fn meta(thread: &str, parent: Option<&str>, timestamp: &str) -> Value {
    let mut payload = json!({
        "id": thread,
        "timestamp": timestamp,
        "cwd": "/fixture",
        "originator": "fixture_codex",
        "cli_version": "0.0.0-test",
        "model_provider": "fixture-provider",
        "source": "cli"
    });
    if let Some(parent) = parent {
        payload["forked_from_id"] = json!(parent);
    }
    record(timestamp, "session_meta", payload)
}

fn context(turn: &str, model: &str, timestamp: &str) -> Value {
    record(
        timestamp,
        "turn_context",
        json!({ "turn_id": turn, "model": model }),
    )
}

fn token(total: u64, last: Option<u64>, timestamp: &str) -> Value {
    let counters = |input: u64| {
        json!({
            "input_tokens": input,
            "cached_input_tokens": input / 5,
            "output_tokens": input / 10,
            "reasoning_output_tokens": 0,
            "total_tokens": input + input / 10
        })
    };
    let mut info = json!({ "total_token_usage": counters(total) });
    if let Some(last) = last {
        info["last_token_usage"] = counters(last);
    }
    record(
        timestamp,
        "event_msg",
        json!({ "type": "token_count", "info": info }),
    )
}

fn settings(owner: Value) -> Value {
    record(
        "2026-07-10T03:00:06Z",
        "event_msg",
        json!({
            "type": "thread_settings_applied",
            "thread_id": owner,
            "thread_settings": { "model": MODEL_B, "model_provider_id": "fixture-provider" }
        }),
    )
}

fn number_records(records: &mut [Value]) {
    for (ordinal, record) in records.iter_mut().enumerate() {
        record["ordinal"] = json!(ordinal as u64);
    }
}

fn parent_history(last: bool) -> Vec<Value> {
    let mut records = vec![
        meta(PARENT, None, "2026-07-10T03:00:00Z"),
        context(PARENT_TURN, MODEL_A, "2026-07-10T03:00:01Z"),
        record(
            "2026-07-10T03:00:02Z",
            "response_item",
            json!({
                "type": "message", "id": "fixture-parent-user", "role": "user",
                "content": [{ "type": "input_text", "text": "fixture parent input" }]
            }),
        ),
        token(100, last.then_some(100), "2026-07-10T03:00:03Z"),
    ];
    number_records(&mut records);
    records
}

fn copied(history: &[Value]) -> Vec<Value> {
    history
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let mut copied = item.clone();
            copied["timestamp"] = json!(format!("2026-07-10T03:00:05.{index:03}Z"));
            copied["ordinal"] = json!((index + 1) as u64);
            copied
        })
        .collect()
}

fn child_before_marker(history: &[Value]) -> Vec<Value> {
    let mut root = meta(CHILD, Some(PARENT), "2026-07-10T03:00:05Z");
    root["ordinal"] = json!(0);
    root["payload"]["subagent_history_start_ordinal"] = json!((history.len() + 1) as u64);
    root["payload"]["forked_from_ordinal_exclusive"] = json!(history.len() as u64);
    let mut values = vec![root];
    values.extend(copied(history));
    values
}

fn live(last: bool) -> Vec<Value> {
    vec![
        context(CHILD_TURN, MODEL_B, "2026-07-10T03:00:07Z"),
        token(160, last.then_some(60), LIVE_TIME),
    ]
}

fn complete_child(history: &[Value], last: bool) -> Vec<Value> {
    let mut values = child_before_marker(history);
    values.push(settings(json!(CHILD)));
    values.extend(live(last));
    number_records(&mut values);
    values
}

fn rollout(root: &Path, thread: &str) -> PathBuf {
    root.join(format!("rollout-2026-07-10T03-00-00-{thread}.jsonl"))
}

fn write_records(path: &Path, records: &[Value]) {
    let contents = records
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    fs::write(path, contents).unwrap();
}

// Positive fixtures declare exact physical boundaries. These writers make
// physical ordinals coherent without deriving/repairing the declared boundary.
// No-authority or deliberately malformed ordinal fixtures use write_records.
fn write_parent_records(path: &Path, records: &[Value]) {
    let mut numbered = records.to_vec();
    number_records(&mut numbered);
    write_records(path, &numbered);
}

fn has_declared_copy_boundary(root: &Value) -> bool {
    root.pointer("/payload/subagent_history_start_ordinal")
        .is_some()
        || root
            .pointer("/payload/forked_from_ordinal_exclusive")
            .is_some()
}

fn write_child_records(path: &Path, records: &[Value]) {
    let mut numbered = records.to_vec();
    if numbered.first().is_some_and(has_declared_copy_boundary) {
        number_records(&mut numbered);
    }
    write_records(path, &numbered);
}

fn append_records(path: &Path, records: &[Value]) {
    let existing = fs::read_to_string(path).unwrap();
    let root = serde_json::from_str::<Value>(existing.lines().next().unwrap()).unwrap();
    let next_ordinal = existing.bytes().filter(|byte| *byte == b'\n').count() as u64;
    let mut file = fs::OpenOptions::new().append(true).open(path).unwrap();
    for (offset, record) in records.iter().enumerate() {
        let mut record = record.clone();
        if has_declared_copy_boundary(&root) && record.get("ordinal").is_none() {
            record["ordinal"] = json!(next_ordinal + offset as u64);
        }
        writeln!(file, "{record}").unwrap();
    }
}

fn sync(db: &Database, child: &Path, parent: &Path) -> Result<CodexFileSyncResult, AppError> {
    let mut pass = CodexSyncPass::load(db)?;
    sync_single_codex_file(
        db,
        child,
        &build_rollout_index(&[parent.to_path_buf(), child.to_path_buf()]),
        &mut pass,
    )
}

#[derive(Debug, PartialEq, Eq)]
struct UsageRow {
    request_id: String,
    input: i64,
    cached: i64,
    output: i64,
    model: String,
}

fn rows(db: &Database) -> Result<Vec<UsageRow>, AppError> {
    let conn = lock_conn!(db.conn);
    let mut statement = conn.prepare(
        "SELECT request_id, input_tokens, cache_read_tokens, output_tokens, model
         FROM proxy_request_logs WHERE data_source='codex_session' ORDER BY request_id",
    )?;
    let result = statement
        .query_map([], |row| {
            Ok(UsageRow {
                request_id: row.get(0)?,
                input: row.get(1)?,
                cached: row.get(2)?,
                output: row.get(3)?,
                model: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(result)
}

fn expected_live(index: u32, input: i64) -> UsageRow {
    UsageRow {
        request_id: format!("{CODEX_THREAD_REQUEST_ID_PREFIX}:{CHILD}:{index}"),
        input,
        cached: input / 5,
        output: input / 10,
        model: MODEL_B.to_string(),
    }
}

fn assert_unverified(
    db: &Database,
    child: &Path,
    result: &CodexFileSyncResult,
) -> Result<(), AppError> {
    assert!(
        result.deferred,
        "incomplete or contradictory copy must stay deferred"
    );
    assert_eq!(result.imported, 0);
    assert!(
        rows(db)?.is_empty(),
        "unverified history must never produce billing facts"
    );
    assert_eq!(
        crate::services::session_usage::get_sync_state(db, &child.to_string_lossy())?,
        (0, 0)
    );
    assert!(
        load_codex_checkpoint(db, child)?.is_none(),
        "unverified copy must not gain an append checkpoint"
    );
    Ok(())
}

#[test]
#[serial_test::serial]
fn copied_root_idle_parent_imports_only_live_last_or_total_delta() -> Result<(), AppError> {
    for with_last in [true, false] {
        clear_codex_replay_caches();
        let dir = tempdir().unwrap();
        let db = Database::memory()?;
        let parent = rollout(dir.path(), PARENT);
        let child = rollout(dir.path(), CHILD);
        let history = parent_history(with_last);
        write_parent_records(&parent, &history);
        write_child_records(&child, &complete_child(&history, with_last));
        let result = sync(&db, &child, &parent)?;
        assert!(
            !result.deferred,
            "an exact copied parent prefix does not need a later parent timestamp"
        );
        assert_eq!(result.imported, 1);
        assert_eq!(rows(&db)?, vec![expected_live(2, 60)]);
        clear_codex_replay_caches();
        assert_eq!(sync(&db, &child, &parent)?.imported, 0);
        assert_eq!(rows(&db)?.len(), 1);
    }
    Ok(())
}

#[test]
#[serial_test::serial]
fn copied_root_live_old_signature_after_new_owned_turn_is_not_replay() -> Result<(), AppError> {
    clear_codex_replay_caches();
    let dir = tempdir().unwrap();
    let db = Database::memory()?;
    let parent = rollout(dir.path(), PARENT);
    let child = rollout(dir.path(), CHILD);
    let mut history = parent_history(true);
    history.push(token(200, Some(100), "2026-07-10T03:00:04Z"));
    write_parent_records(&parent, &history);
    let mut values = child_before_marker(&history);
    values.push(settings(json!(CHILD)));
    values.push(record(
        "2026-07-10T03:00:06.100Z",
        "event_msg",
        json!({ "type": "task_started", "turn_id": CHILD_TURN }),
    ));
    values.push(context(CHILD_TURN, MODEL_B, "2026-07-10T03:00:07Z"));
    values.push(token(100, Some(100), LIVE_TIME));
    write_child_records(&child, &values);
    assert_eq!(sync(&db, &child, &parent)?.imported, 1);
    assert_eq!(rows(&db)?, vec![expected_live(3, 100)]);
    Ok(())
}

#[test]
#[serial_test::serial]
fn copied_root_settings_marker_requires_valid_child_owner() -> Result<(), AppError> {
    for owner in [Some(json!(OTHER)), Some(json!("not-a-thread-id")), None] {
        clear_codex_replay_caches();
        let dir = tempdir().unwrap();
        let db = Database::memory()?;
        let parent = rollout(dir.path(), PARENT);
        let child = rollout(dir.path(), CHILD);
        let history = parent_history(true);
        write_parent_records(&parent, &history);
        let mut values = child_before_marker(&history);
        let mut marker = settings(owner.clone().unwrap_or(Value::Null));
        if owner.is_none() {
            marker["payload"]
                .as_object_mut()
                .unwrap()
                .remove("thread_id");
        }
        values.push(marker);
        values.extend(live(true));
        write_child_records(&child, &values);
        assert_unverified(&db, &child, &sync(&db, &child, &parent)?)?;
    }
    Ok(())
}

#[test]
#[serial_test::serial]
fn copied_root_late_resume_marker_cannot_swallow_earlier_live_usage() -> Result<(), AppError> {
    clear_codex_replay_caches();
    let dir = tempdir().unwrap();
    let db = Database::memory()?;
    let parent = rollout(dir.path(), PARENT);
    let child = rollout(dir.path(), CHILD);
    let history = parent_history(true);
    write_parent_records(&parent, &history);
    let mut values = child_before_marker(&history);
    values.extend(live(true));
    values.push(settings(json!(CHILD)));
    values.push(token(180, Some(20), "2026-07-10T03:00:09Z"));
    write_child_records(&child, &values);
    assert_unverified(&db, &child, &sync(&db, &child, &parent)?)?;
    Ok(())
}

#[test]
#[serial_test::serial]
fn copied_root_rejects_deleted_changed_or_extra_non_token_history() -> Result<(), AppError> {
    for mutation in 0..3 {
        clear_codex_replay_caches();
        let dir = tempdir().unwrap();
        let db = Database::memory()?;
        let parent = rollout(dir.path(), PARENT);
        let child = rollout(dir.path(), CHILD);
        let history = parent_history(true);
        write_parent_records(&parent, &history);
        let mut values = child_before_marker(&history);
        match mutation {
            0 => { values.remove(3); }
            1 => { values[3]["payload"]["id"] = json!("fixture-different-message"); }
            _ => values.insert(3, record("2026-07-10T03:00:05.500Z", "response_item", json!({
                "type": "function_call", "call_id": "fixture-tool-call", "name": "fixture_tool", "arguments": "{}"
            }))),
        }
        values.push(settings(json!(CHILD)));
        values.extend(live(true));
        write_child_records(&child, &values);
        assert_unverified(&db, &child, &sync(&db, &child, &parent)?)?;
    }
    Ok(())
}

#[test]
#[serial_test::serial]
fn copied_root_empty_marked_fork_has_no_billing_or_activity() -> Result<(), AppError> {
    clear_codex_replay_caches();
    let dir = tempdir().unwrap();
    let db = Database::memory()?;
    let parent = rollout(dir.path(), PARENT);
    let child = rollout(dir.path(), CHILD);
    let history = parent_history(true);
    write_parent_records(&parent, &history);
    let mut values = child_before_marker(&history);
    values.push(settings(json!(CHILD)));
    write_child_records(&child, &values);
    let result = sync(&db, &child, &parent)?;
    assert!(!result.deferred);
    assert_eq!(result.imported, 0);
    assert!(rows(&db)?.is_empty());
    let conn = lock_conn!(db.conn);
    let activity: (Option<i64>, Option<i64>, i64) = conn.query_row(
        "SELECT first_activity_at, last_activity_at, is_subagent FROM codex_usage_sessions WHERE session_id=?1",
        [CHILD], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    assert_eq!(
        activity,
        (None, None, 0),
        "copied parent tokens are not child activity or proof of a subagent"
    );
    Ok(())
}

#[test]
#[serial_test::serial]
fn copied_root_partial_copy_never_bills_inherited_append_after_reload() -> Result<(), AppError> {
    clear_codex_replay_caches();
    let dir = tempdir().unwrap();
    let db = Database::memory()?;
    let parent = rollout(dir.path(), PARENT);
    let child = rollout(dir.path(), CHILD);
    let history = parent_history(true);
    write_parent_records(&parent, &history);
    let complete = complete_child(&history, true);
    // Stop just before the copied token record: every line is complete, but
    // the fork's initialization batch has not reached its owned marker.
    write_child_records(&child, &complete[..4]);
    let first = sync(&db, &child, &parent)?;
    assert_unverified(&db, &child, &first)?;
    clear_codex_replay_caches();
    append_records(&child, &complete[4..]);
    let recovered = sync(&db, &child, &parent)?;
    assert!(!recovered.deferred);
    assert_eq!(recovered.imported, 1);
    assert_eq!(rows(&db)?, vec![expected_live(2, 60)]);
    clear_codex_replay_caches();
    assert_eq!(sync(&db, &child, &parent)?.imported, 0);
    Ok(())
}

#[test]
#[serial_test::serial]
fn copied_root_unchanged_child_recovers_when_parent_prefix_finishes() -> Result<(), AppError> {
    clear_codex_replay_caches();
    let dir = tempdir().unwrap();
    let db = Database::memory()?;
    let parent = rollout(dir.path(), PARENT);
    let child = rollout(dir.path(), CHILD);
    let history = parent_history(true);
    write_parent_records(&parent, &history[..3]);
    write_child_records(&child, &complete_child(&history, true));
    assert_unverified(&db, &child, &sync(&db, &child, &parent)?)?;
    let child_before = fs::read(&child).unwrap();
    append_records(&parent, &history[3..]);
    let recovered = sync(&db, &child, &parent)?;
    assert!(!recovered.deferred);
    assert_eq!(recovered.imported, 1);
    assert_eq!(rows(&db)?, vec![expected_live(2, 60)]);
    assert_eq!(fs::read(&child).unwrap(), child_before);
    Ok(())
}

#[test]
#[serial_test::serial]
fn copied_root_v1_metadata_checkpoint_recertifies_before_inherited_append() -> Result<(), AppError>
{
    clear_codex_replay_caches();
    let dir = tempdir().unwrap();
    let db = Database::memory()?;
    let parent = rollout(dir.path(), PARENT);
    let child = rollout(dir.path(), CHILD);
    let history = parent_history(true);
    write_parent_records(&parent, &history);
    let complete = complete_child(&history, true);
    write_child_records(&child, &complete[..4]);
    let snapshot = parse_codex_snapshot(&child)?;
    {
        let conn = lock_conn!(db.conn);
        save_codex_checkpoint_on_conn(
            &conn,
            &child,
            &snapshot.state,
            snapshot.complete_bytes,
            &snapshot.checkpoint_facts(),
        )?;
        let old_state = json!({
            "version": 1, "root_thread_id": CHILD, "meta_thread_id": CHILD,
            "root_meta_seen": true, "root_timestamp": "2026-07-10T03:00:05Z",
            "parent": { "Parent": PARENT }, "is_subagent": false,
            "current_model": MODEL_A, "total_high_water": null,
            "last_signature_by_source": {}, "previous_token_signature": null,
            "event_index": 0, "has_billable_tokens": false,
            "first_activity_at": null, "last_activity_at": null
        });
        conn.execute(
            "UPDATE codex_usage_file_checkpoints SET parser_state=?1 WHERE file_path=?2",
            rusqlite::params![old_state.to_string(), child.to_string_lossy().to_string()],
        )?;
    }
    append_records(&child, &complete[4..]);
    clear_codex_replay_caches();
    let recovered = sync(&db, &child, &parent)?;
    assert!(!recovered.deferred);
    assert_eq!(recovered.imported, 1);
    assert_eq!(rows(&db)?, vec![expected_live(2, 60)]);
    clear_codex_replay_caches();
    assert_eq!(sync(&db, &child, &parent)?.imported, 0);
    assert_eq!(rows(&db)?.len(), 1);
    Ok(())
}

#[test]
#[serial_test::serial]
fn copied_root_keeps_existing_verified_request_id_and_does_not_duplicate() -> Result<(), AppError> {
    clear_codex_replay_caches();
    let dir = tempdir().unwrap();
    let db = Database::memory()?;
    let parent = rollout(dir.path(), PARENT);
    let child = rollout(dir.path(), CHILD);
    let history = parent_history(true);
    write_parent_records(&parent, &history);
    write_child_records(&child, &complete_child(&history, true));
    let existing_id = format!("{CODEX_THREAD_REQUEST_ID_PREFIX}:{CHILD}:2");
    assert!(insert_codex_session_entry(
        &db,
        &existing_id,
        &DeltaTokens {
            input: 60,
            cached_input: 12,
            output: 6
        },
        MODEL_B,
        Some(CHILD),
        Some(LIVE_TIME),
        &mut 0
    )?);
    let result = sync(&db, &child, &parent)?;
    assert!(!result.deferred);
    assert_eq!(result.imported, 0);
    assert_eq!(rows(&db)?, vec![expected_live(2, 60)]);
    clear_codex_replay_caches();
    assert_eq!(sync(&db, &child, &parent)?.imported, 0);
    assert_eq!(rows(&db)?.len(), 1);
    Ok(())
}

#[test]
#[serial_test::serial]
fn copied_root_waits_for_own_marker_even_if_parent_has_a_later_timestamp() -> Result<(), AppError> {
    clear_codex_replay_caches();
    let dir = tempdir().unwrap();
    let db = Database::memory()?;
    let parent = rollout(dir.path(), PARENT);
    let child = rollout(dir.path(), CHILD);
    let history = parent_history(true);
    let mut parent_with_suffix = history.clone();
    parent_with_suffix.push(context(PARENT_TURN, MODEL_A, "2026-07-10T03:00:10Z"));
    write_parent_records(&parent, &parent_with_suffix);
    // The copied token is already published, but fork initialization has not
    // yet published its owned marker. A parent wall-clock watermark is not
    // permission to fall back to Legacy and checkpoint this incomplete copy.
    write_child_records(&child, &child_before_marker(&history));
    assert_unverified(&db, &child, &sync(&db, &child, &parent)?)?;
    let index = build_rollout_index(&[parent.clone(), child.clone()]);
    assert!(read_verified_codex_rollout_usage(&child, &index)?.is_none());

    clear_codex_replay_caches();
    let mut suffix = vec![settings(json!(CHILD))];
    suffix.extend(live(true));
    append_records(&child, &suffix);
    let recovered = sync(&db, &child, &parent)?;
    assert!(!recovered.deferred);
    assert_eq!(recovered.imported, 1);
    assert_eq!(rows(&db)?, vec![expected_live(2, 60)]);
    clear_codex_replay_caches();
    assert_eq!(sync(&db, &child, &parent)?.imported, 0);
    Ok(())
}

#[test]
#[serial_test::serial]
fn copied_root_test_reader_agrees_with_collector_on_live_and_unverified_history(
) -> Result<(), AppError> {
    for with_last in [true, false] {
        clear_codex_replay_caches();
        let dir = tempdir().unwrap();
        let db = Database::memory()?;
        let parent = rollout(dir.path(), PARENT);
        let child = rollout(dir.path(), CHILD);
        let history = parent_history(with_last);
        write_parent_records(&parent, &history);
        let mut values = complete_child(&history, with_last);
        write_child_records(&child, &values);
        let index = build_rollout_index(&[parent.clone(), child.clone()]);
        let verified = read_verified_codex_rollout_usage(&child, &index)?
            .expect("the test-only reader must accept the same exact copied prefix");
        assert_eq!(verified.len(), 1);
        assert_eq!(
            (
                verified[0].input_tokens,
                verified[0].cached_input_tokens,
                verified[0].output_tokens
            ),
            (60, 12, 6)
        );
        assert_eq!(verified[0].model, MODEL_B);
        assert_eq!(
            verified[0].timestamp,
            LIVE_TIME.parse::<DateTime<Utc>>().unwrap()
        );
        assert_eq!(sync(&db, &child, &parent)?.imported, 1);
        assert_eq!(rows(&db)?, vec![expected_live(2, 60)]);

        // Equal token totals cannot compensate for a changed non-token item.
        values[3]["payload"]["id"] = json!("fixture-unverified-reader-message");
        write_child_records(&child, &values);
        assert!(read_verified_codex_rollout_usage(&child, &index)?.is_none());
    }
    Ok(())
}

#[test]
#[serial_test::serial]
fn copied_root_owned_settings_selects_live_model_without_another_turn_context(
) -> Result<(), AppError> {
    clear_codex_replay_caches();
    let dir = tempdir().unwrap();
    let db = Database::memory()?;
    let parent = rollout(dir.path(), PARENT);
    let child = rollout(dir.path(), CHILD);
    let history = parent_history(true);
    write_parent_records(&parent, &history);
    let mut values = child_before_marker(&history);
    let mut marker = settings(json!(CHILD));
    marker["payload"]["thread_settings"]["model"] = json!("OpenAI/GPT-5.6-Luna-2026-07-10");
    values.push(marker);
    values.push(token(160, Some(60), LIVE_TIME));
    write_child_records(&child, &values);
    let index = build_rollout_index(&[parent.clone(), child.clone()]);
    let verified = read_verified_codex_rollout_usage(&child, &index)?.unwrap();
    assert_eq!(verified.len(), 1);
    assert_eq!(
        verified[0].model, MODEL_B,
        "the last inherited turn context must not price the live child turn"
    );
    let result = sync(&db, &child, &parent)?;
    assert!(!result.deferred);
    assert_eq!(result.imported, 1);
    assert_eq!(rows(&db)?, vec![expected_live(2, 60)]);
    Ok(())
}

#[test]
#[serial_test::serial]
fn copied_root_does_not_treat_compact_history_base_as_a_copied_prefix() -> Result<(), AppError> {
    clear_codex_replay_caches();
    let dir = tempdir().unwrap();
    let db = Database::memory()?;
    let parent = rollout(dir.path(), PARENT);
    let child = rollout(dir.path(), CHILD);
    let history = parent_history(true);
    write_parent_records(&parent, &history);
    let mut root = meta(CHILD, Some(PARENT), "2026-07-10T03:00:05Z");
    root["ordinal"] = json!(4);
    root["payload"]["history_base"] = json!({
        "thread_id": PARENT, "end_ordinal_exclusive": 4, "end_byte_offset": fs::metadata(&parent).unwrap().len()
    });
    let mut values = vec![root, settings(json!(CHILD))];
    values.extend(live(true));
    write_child_records(&child, &values);
    assert_unverified(&db, &child, &sync(&db, &child, &parent)?)?;
    let index = build_rollout_index(&[parent, child.clone()]);
    assert!(read_verified_codex_rollout_usage(&child, &index)?.is_none());
    Ok(())
}

#[test]
#[serial_test::serial]
fn copied_root_pending_future_parent_tokens_are_never_billed_before_owned_marker(
) -> Result<(), AppError> {
    clear_codex_replay_caches();
    let dir = tempdir().unwrap();
    let db = Database::memory()?;
    let parent = rollout(dir.path(), PARENT);
    let child = rollout(dir.path(), CHILD);
    let mut history = parent_history(true);
    // Legacy timestamp filtering would see only S1 before child creation and
    // then mistake the already-copied S2 for live child work.
    history.push(token(200, Some(100), "2026-07-10T03:00:06Z"));
    write_parent_records(&parent, &history);
    write_child_records(&child, &child_before_marker(&history));
    let pending = sync(&db, &child, &parent)?;
    assert!(
        rows(&db)?.is_empty(),
        "an incomplete copied initialization must not bill its future-timestamp parent token"
    );
    assert_unverified(&db, &child, &pending)?;

    append_records(
        &child,
        &[
            settings(json!(CHILD)),
            context(CHILD_TURN, MODEL_B, "2026-07-10T03:00:07Z"),
            token(260, Some(60), LIVE_TIME),
        ],
    );
    clear_codex_replay_caches();
    let recovered = sync(&db, &child, &parent)?;
    assert!(!recovered.deferred);
    assert_eq!(recovered.imported, 1);
    assert_eq!(rows(&db)?, vec![expected_live(3, 60)]);
    clear_codex_replay_caches();
    assert_eq!(sync(&db, &child, &parent)?.imported, 0);
    Ok(())
}

#[test]
#[serial_test::serial]
fn copied_root_zero_usage_recovery_clears_prior_pending_state() -> Result<(), AppError> {
    clear_codex_replay_caches();
    let dir = tempdir().unwrap();
    let db = Database::memory()?;
    let parent = rollout(dir.path(), PARENT);
    let child = rollout(dir.path(), CHILD);
    // A thread can fork after metadata/context/input publication but before
    // any billable token event. Its completion still resolves pending state.
    let history = parent_history(true)[..3].to_vec();
    write_parent_records(&parent, &history);
    write_child_records(&child, &child_before_marker(&history));
    assert_unverified(&db, &child, &sync(&db, &child, &parent)?)?;
    assert!(replay_caches().lock().unwrap().pending.contains_key(&child));

    append_records(&child, &[settings(json!(CHILD))]);
    let recovered = sync(&db, &child, &parent)?;
    assert!(!recovered.deferred);
    assert_eq!(recovered.imported, 0);
    assert!(rows(&db)?.is_empty());
    let checkpoint = load_codex_checkpoint(&db, &child)?
        .expect("a certified empty fork must save its checkpoint");
    assert_eq!(
        checkpoint.last_byte_offset,
        fs::metadata(&child).unwrap().len() as i64
    );
    let conn = lock_conn!(db.conn);
    let activity: (Option<i64>, Option<i64>) = conn.query_row(
        "SELECT first_activity_at, last_activity_at FROM codex_usage_sessions WHERE session_id=?1",
        [CHILD],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    assert_eq!(activity, (None, None));
    drop(conn);
    assert!(
        !replay_caches().lock().unwrap().pending.contains_key(&child),
        "successful no-billable reconciliation must clear the old deferred reason"
    );
    Ok(())
}

#[test]
#[serial_test::serial]
fn copied_root_reader_does_not_bill_an_uncommitted_jsonl_tail() -> Result<(), AppError> {
    clear_codex_replay_caches();
    let dir = tempdir().unwrap();
    let db = Database::memory()?;
    let parent = rollout(dir.path(), PARENT);
    let child = rollout(dir.path(), CHILD);
    let history = parent_history(true);
    write_parent_records(&parent, &history);
    let complete = complete_child(&history, true);
    write_child_records(&child, &complete[..complete.len() - 1]);
    let complete_prefix_bytes = fs::metadata(&child).unwrap().len() as i64;
    let uncommitted_token = complete.last().unwrap().to_string();
    fs::OpenOptions::new()
        .append(true)
        .open(&child)
        .unwrap()
        .write_all(uncommitted_token.as_bytes())
        .unwrap();
    assert_eq!(sync(&db, &child, &parent)?.imported, 0);
    assert!(rows(&db)?.is_empty());
    let checkpoint = load_codex_checkpoint(&db, &child)?.unwrap();
    assert_eq!(
        checkpoint.last_byte_offset, complete_prefix_bytes,
        "the collector checkpoint must stop at the last complete newline"
    );
    assert!(checkpoint.file_size > checkpoint.last_byte_offset);
    let index = build_rollout_index(&[parent.clone(), child.clone()]);
    let read_before_commit = read_verified_codex_rollout_usage(&child, &index)?.unwrap();
    assert!(
        read_before_commit.is_empty(),
        "the test reader must not report a live token the collector has not committed"
    );

    fs::OpenOptions::new()
        .append(true)
        .open(&child)
        .unwrap()
        .write_all(b"\n")
        .unwrap();
    clear_codex_replay_caches();
    let read_after_commit = read_verified_codex_rollout_usage(&child, &index)?.unwrap();
    assert_eq!(read_after_commit.len(), 1);
    assert_eq!(read_after_commit[0].input_tokens, 60);
    assert_eq!(read_after_commit[0].cached_input_tokens, 12);
    assert_eq!(read_after_commit[0].output_tokens, 6);
    assert_eq!(read_after_commit[0].model, MODEL_B);
    assert_eq!(sync(&db, &child, &parent)?.imported, 1);
    assert_eq!(rows(&db)?, vec![expected_live(2, 60)]);
    clear_codex_replay_caches();
    assert_eq!(sync(&db, &child, &parent)?.imported, 0);
    Ok(())
}

fn strip_ordinal_authority(records: &mut [Value]) {
    for record in records.iter_mut() {
        record.as_object_mut().unwrap().remove("ordinal");
    }
    if let Some(payload) = records.first_mut().and_then(|root| root.get_mut("payload")) {
        let payload = payload.as_object_mut().unwrap();
        payload.remove("subagent_history_start_ordinal");
        payload.remove("forked_from_ordinal_exclusive");
    }
}

fn assert_ambiguous_old_fork_stays_deferred(x_has_context: bool) -> Result<(), AppError> {
    clear_codex_replay_caches();
    let dir = tempdir().unwrap();
    let db = Database::memory()?;
    let parent = rollout(dir.path(), PARENT);
    let child = rollout(dir.path(), CHILD);
    // Old-format records carry neither a turn UUID nor response-item ID.
    // Their payload equality alone cannot establish immutable provenance.
    let base = vec![
        meta(PARENT, None, "2026-07-10T03:00:00Z"),
        record(
            "2026-07-10T03:00:01Z",
            "turn_context",
            json!({ "model": MODEL_A }),
        ),
        record(
            "2026-07-10T03:00:02Z",
            "response_item",
            json!({
                "type": "message", "role": "user",
                "content": [{ "type": "input_text", "text": "fixture unanchored input" }]
            }),
        ),
        token(100, Some(100), "2026-07-10T03:00:03Z"),
    ];
    let mut coincident_x = Vec::new();
    if x_has_context {
        coincident_x.push(record(
            "2026-07-10T03:00:04Z",
            "turn_context",
            json!({ "model": MODEL_B }),
        ));
        coincident_x.push(record(
            "2026-07-10T03:00:04.100Z",
            "response_item",
            json!({
                "type": "message", "role": "user",
                "content": [{ "type": "input_text", "text": "fixture coincidental input" }]
            }),
        ));
    }
    coincident_x.push(token(160, Some(60), "2026-07-10T03:00:04.200Z"));
    let mut full_parent = base.clone();
    full_parent.extend(coincident_x.clone());
    write_records(&parent, &full_parent);

    let mut values = child_before_marker(&base);
    // X is true old-child live history, not copied history. The parent happens
    // to contain identical anonymous payloads. Resume later adds the first own
    // settings marker, which must not retroactively turn child X into replay.
    for (index, mut actual_child_x) in coincident_x.into_iter().enumerate() {
        actual_child_x["timestamp"] = json!(format!("2026-07-10T03:00:07.{index:03}Z"));
        values.push(actual_child_x);
    }
    let mut resumed_marker = settings(json!(CHILD));
    resumed_marker["timestamp"] = json!("2026-07-10T03:00:10Z");
    values.push(resumed_marker);
    values.push(token(200, Some(40), "2026-07-10T03:00:11Z"));
    strip_ordinal_authority(&mut values);
    write_records(&child, &values);

    let result = sync(&db, &child, &parent)?;
    let observed = rows(&db)?;
    assert!(
        observed.is_empty(),
        "ambiguous old-child X must not be suppressed while only Y is billed: {observed:?}"
    );
    assert_unverified(&db, &child, &result)?;
    let index = build_rollout_index(&[parent, child.clone()]);
    assert!(
        read_verified_codex_rollout_usage(&child, &index)?.is_none(),
        "the test reader must not certify anonymous coincidental history either"
    );
    Ok(())
}

#[test]
#[serial_test::serial]
fn copied_root_ambiguous_old_fork_context_without_identity_stays_deferred() -> Result<(), AppError>
{
    assert_ambiguous_old_fork_stays_deferred(true)
}

#[test]
#[serial_test::serial]
fn copied_root_ambiguous_old_fork_tokens_only_extension_stays_deferred() -> Result<(), AppError> {
    assert_ambiguous_old_fork_stays_deferred(false)
}

#[test]
#[serial_test::serial]
fn copied_root_uuid_context_does_not_replace_missing_ordinal_authority() -> Result<(), AppError> {
    for has_earlier_child_tokens in [false, true] {
        clear_codex_replay_caches();
        let dir = tempdir().unwrap();
        let db = Database::memory()?;
        let parent = rollout(dir.path(), PARENT);
        let child = rollout(dir.path(), CHILD);
        let history = parent_history(true);
        let mut parent_values = history.clone();
        if has_earlier_child_tokens {
            parent_values.push(token(160, Some(60), "2026-07-10T03:00:04Z"));
        }
        strip_ordinal_authority(&mut parent_values);
        write_records(&parent, &parent_values);
        let mut values = child_before_marker(&history);
        if has_earlier_child_tokens {
            // A real child request can produce a token event before a fresh
            // child context (e.g. pre-turn compaction). The inherited UUID is
            // not immutable provenance for that event or a late resume marker.
            values.push(token(160, Some(60), "2026-07-10T03:00:07Z"));
            let mut late_marker = settings(json!(CHILD));
            late_marker["timestamp"] = json!("2026-07-10T03:00:10Z");
            values.push(late_marker);
            values.push(token(200, Some(40), "2026-07-10T03:00:11Z"));
        } else {
            values.push(settings(json!(CHILD)));
            values.extend(live(true));
        }
        strip_ordinal_authority(&mut values);
        write_records(&child, &values);
        assert_unverified(&db, &child, &sync(&db, &child, &parent)?)?;
        let index = build_rollout_index(&[parent, child.clone()]);
        assert!(read_verified_codex_rollout_usage(&child, &index)?.is_none());
    }
    Ok(())
}

#[test]
#[serial_test::serial]
fn copied_root_contradictory_declared_or_physical_ordinals_stay_deferred() -> Result<(), AppError> {
    for contradiction in 0..4 {
        clear_codex_replay_caches();
        let dir = tempdir().unwrap();
        let db = Database::memory()?;
        let parent = rollout(dir.path(), PARENT);
        let child = rollout(dir.path(), CHILD);
        let history = parent_history(true);
        write_parent_records(&parent, &history);
        let mut values = complete_child(&history, true);
        match contradiction {
            0 => values[0]["payload"]["subagent_history_start_ordinal"] = json!(6),
            1 => values[0]["payload"]["forked_from_ordinal_exclusive"] = json!(3),
            2 => values[1]["ordinal"] = json!(2),
            _ => values[history.len() + 1]["ordinal"] = json!(6),
        }
        // Literal writer preserves the intended contradiction; never repair a
        // malformed ordinal fixture with the positive-fixture numberer.
        write_records(&child, &values);
        assert_unverified(&db, &child, &sync(&db, &child, &parent)?)?;
        let index = build_rollout_index(&[parent, child.clone()]);
        assert!(read_verified_codex_rollout_usage(&child, &index)?.is_none());
    }
    Ok(())
}
