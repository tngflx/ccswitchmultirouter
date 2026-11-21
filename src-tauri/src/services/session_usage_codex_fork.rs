//! Positive content proof for copied Codex fork history.
//!
//! A fork recorder rewrites outer timestamps, and an owned settings event can
//! also appear on a later resume. Neither timestamp coverage nor that event by
//! itself proves which token records were inherited. Even a matching prefix
//! can include genuine live work from an old fork before its first resume
//! marker. This module requires an explicit, validated snapshot ordinal
//! boundary and exact matching for any inherited token usage records.

use super::{
    explicit_parent_from_meta, leading_thread_id_from_filename, parse_timestamp,
    thread_id_from_filename, ParentFileStamp, ParentResolution, RolloutIndex,
};
use crate::error::AppError;
use serde_json::Value;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

// A record can contain image/tool payloads. Bound only this additional proof
// reader; oversized/unverifiable history remains deferred, never guessed live.
const MAX_PROOF_RECORD_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum CopiedForkProof {
    Unavailable,
    Verified { first_live_line: i64 },
    Deferred(String),
}

#[derive(Debug)]
struct CandidateBoundary {
    copied_records: u64,
    marker_line: i64,
    copied_ordinal_end: Option<u64>,
    parent_ordinal_end: Option<u64>,
}

fn deferred(reason: &'static str) -> CopiedForkProof {
    CopiedForkProof::Deferred(reason.to_string())
}

fn uuid(value: Option<&Value>) -> Option<uuid::Uuid> {
    uuid::Uuid::parse_str(value?.as_str()?).ok()
}

fn meta_id(record: &Value) -> Option<uuid::Uuid> {
    if record.get("type")?.as_str()? != "session_meta" {
        return None;
    }
    let payload = record.get("payload")?;
    uuid(
        payload
            .get("id")
            .or_else(|| payload.get("thread_id"))
            .or_else(|| payload.get("threadId")),
    )
}

fn own_settings(record: &Value, child_id: uuid::Uuid) -> bool {
    record.get("type").and_then(Value::as_str) == Some("event_msg")
        && record.pointer("/payload/type").and_then(Value::as_str)
            == Some("thread_settings_applied")
        && uuid(record.pointer("/payload/thread_id")) == Some(child_id)
        && record
            .pointer("/payload/thread_settings")
            .is_some_and(Value::is_object)
}

/// Read one complete JSONL record without retaining a history/event cache.
/// Error reasons deliberately exclude the untrusted record and parse error.
fn read_record(reader: &mut impl BufRead) -> Result<Option<Value>, &'static str> {
    let mut bytes = Vec::new();
    let count = Read::take(&mut *reader, MAX_PROOF_RECORD_BYTES + 1)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| "fork 复制前缀读取失败")?;
    if count == 0 {
        return Ok(None);
    }
    if count as u64 > MAX_PROOF_RECORD_BYTES {
        return Err("fork 复制前缀记录超过验证大小上限");
    }
    if bytes.last() != Some(&b'\n') {
        return Err("fork 复制前缀含未完成的 JSONL 记录");
    }
    let record: Value =
        serde_json::from_slice(&bytes).map_err(|_| "fork 复制前缀含无效 JSON 或 UTF-8 记录")?;
    let Some(object) = record.as_object() else {
        return Err("fork 复制前缀记录不是 JSON 对象");
    };
    if object.get("type").and_then(Value::as_str).is_none()
        || !object.contains_key("payload")
        || parse_timestamp(object.get("timestamp")).is_none()
        || object
            .get("ordinal")
            .is_some_and(|value| value.as_u64().is_none())
    {
        return Err("fork 复制前缀记录缺少有效的 type/payload/envelope");
    }
    Ok(Some(record))
}

fn token_usage_signature(record: &Value) -> Option<&Value> {
    (record.get("type").and_then(Value::as_str) == Some("event_msg")
        && record.pointer("/payload/type").and_then(Value::as_str) == Some("token_count"))
    .then(|| record.pointer("/payload/info/total_token_usage"))
    .flatten()
}

/// Codex may replay, omit, or add non-accounting records while materializing a
/// fork. Token usage records are the boundary where content must remain exact.
/// Their cumulative totals must occur in the parent history in order. A
/// rewritten total defers the proof instead of risking double-counting.
fn token_usage_subsequence(child: &[Value], parent: &[Value]) -> bool {
    let child_tokens = child.iter().filter_map(token_usage_signature);
    let mut parent_tokens = parent.iter().filter_map(token_usage_signature);
    for child_token in child_tokens {
        if !parent_tokens.any(|parent_token| parent_token == child_token) {
            return false;
        }
    }
    true
}

fn stamp_unchanged_or_grew(current: ParentFileStamp, expected: ParentFileStamp) -> bool {
    expected.same_identity_and_not_shrunk(&current)
}

fn path_still_names(path: &Path, expected: ParentFileStamp) -> bool {
    File::open(path)
        .ok()
        .and_then(|file| ParentFileStamp::from_file(&file))
        .is_some_and(|current| stamp_unchanged_or_grew(current, expected))
}

fn inspect_child(
    child: &mut File,
    complete_bytes: u64,
    child_id: uuid::Uuid,
    parent_id: uuid::Uuid,
) -> Result<Option<CandidateBoundary>, &'static str> {
    let mut reader = BufReader::new(child.take(complete_bytes));
    let Some(root) = read_record(&mut reader)? else {
        return Ok(None);
    };
    if meta_id(&root) != Some(child_id) {
        return Err("fork 复制验证的首条 child session_meta 身份不一致");
    }
    let payload = root.get("payload").ok_or("fork child meta 缺少 payload")?;
    match explicit_parent_from_meta(payload) {
        ParentResolution::Parent(parent)
            if uuid::Uuid::parse_str(&parent).ok() == Some(parent_id) => {}
        _ => return Err("fork 复制验证的显式 parent 身份不一致"),
    }
    if payload
        .get("history_base")
        .is_some_and(|value| !value.is_null())
    {
        return Err("fork 引用历史需要精确的 ordinal/byte 基线验证，不能按复制历史导入");
    }
    let copied_ordinal_end = match payload.get("subagent_history_start_ordinal") {
        None | Some(Value::Null) => None,
        Some(value) => Some(
            value
                .as_u64()
                .filter(|value| *value > 0)
                .ok_or("fork 复制历史声明了无效的 own-start ordinal")?,
        ),
    };
    let parent_ordinal_end = match payload.get("forked_from_ordinal_exclusive") {
        None | Some(Value::Null) => None,
        Some(value) => Some(
            value
                .as_u64()
                .ok_or("fork 复制历史声明了无效的 parent ordinal 边界")?,
        ),
    };
    if copied_ordinal_end.is_some() && root.get("ordinal").and_then(Value::as_u64) != Some(0) {
        return Err("fork 复制历史的首条 ordinal 不是零");
    }

    let mut copied_records = 0u64;
    let mut starts_with_parent_meta = false;
    let mut saw_copied_meta = false;
    let mut line = 1i64;
    while let Some(record) = read_record(&mut reader)? {
        line = line.checked_add(1).ok_or("fork 复制历史行数溢出")?;
        if copied_ordinal_end.is_some()
            && record.get("ordinal").and_then(Value::as_u64) != Some((line - 1) as u64)
        {
            return Err("fork 复制历史 ordinal 不连续");
        }
        if record.get("type").and_then(Value::as_str) == Some("event_msg")
            && record.pointer("/payload/type").and_then(Value::as_str)
                == Some("thread_settings_applied")
            && uuid(record.pointer("/payload/thread_id")) == Some(child_id)
            && !record
                .pointer("/payload/thread_settings")
                .is_some_and(Value::is_object)
        {
            return Err("fork child own-settings 缺少有效的 thread_settings 对象");
        }
        if own_settings(&record, child_id) {
            if copied_records == 0 || !starts_with_parent_meta {
                return Err("fork own-settings 前缺少可验证的父 session_meta 复制前缀");
            }
            if copied_ordinal_end.is_some_and(|ordinal| ordinal != (line - 1) as u64) {
                return Err("fork own-settings 与声明的 own-start ordinal 不一致");
            }
            if copied_ordinal_end.is_none() && parent_ordinal_end.is_none() {
                // Full content equality cannot distinguish an old child's live
                // work from equal later parent records. A resume marker or a
                // turn ID is not immutable authority for the original copy.
                return Err("fork 复制历史缺少显式 ordinal 快照边界；不能按内容相等推断继承");
            }
            return Ok(Some(CandidateBoundary {
                copied_records,
                marker_line: line,
                copied_ordinal_end,
                parent_ordinal_end,
            }));
        }
        if record.get("type").and_then(Value::as_str) == Some("session_meta") {
            let copied_id = meta_id(&record).ok_or("fork 复制前缀含无效的 session_meta 身份")?;
            // Any later metadata is copied/ambiguous initialization, even if
            // it names an unexpected ancestor rather than the explicit parent.
            // Do not let a missing own marker route it through legacy matching.
            saw_copied_meta = true;
            if copied_id == child_id {
                return Err("fork 复制前缀包含 child 自身的 session_meta；不能验证无环继承");
            }
        }
        if copied_records == 0 {
            starts_with_parent_meta = meta_id(&record) == Some(parent_id);
        }
        copied_records = copied_records
            .checked_add(1)
            .ok_or("fork 复制历史记录数溢出")?;
    }
    if saw_copied_meta || copied_ordinal_end.is_some() || parent_ordinal_end.is_some() {
        return Err("fork 已发布复制历史，但 child 初始化边界尚未完成；下轮重试");
    }
    Ok(None)
}

fn compare_parent(
    child_path: &Path,
    complete_bytes: u64,
    expected_child_stamp: ParentFileStamp,
    parent_path: &Path,
    child_id: uuid::Uuid,
    parent_id: uuid::Uuid,
    boundary: &CandidateBoundary,
) -> Result<(), &'static str> {
    let mut parent = File::open(parent_path).map_err(|_| "fork 复制验证无法打开父 rollout")?;
    let before =
        ParentFileStamp::from_file(&parent).ok_or("fork 复制验证无法保留父 rollout 文件身份")?;
    let mut child = File::open(child_path).map_err(|_| "fork 复制验证无法重开 child rollout")?;
    let child_before =
        ParentFileStamp::from_file(&child).ok_or("fork 复制验证无法保留 child rollout 文件身份")?;
    if !stamp_unchanged_or_grew(child_before, expected_child_stamp) {
        return Err("fork child 重开后的文件代际与已解析快照不一致；下轮重试");
    }
    let mut child_reader = BufReader::new((&mut child).take(complete_bytes));
    read_record(&mut child_reader)?.ok_or("fork child 首条记录在验证期间消失")?;
    let mut child_prefix = Vec::with_capacity(
        usize::try_from(boundary.copied_records).map_err(|_| "fork child 复制前缀过大")?,
    );
    for _ in 0..boundary.copied_records {
        child_prefix
            .push(read_record(&mut child_reader)?.ok_or("fork child 复制前缀在验证期间缩短")?);
    }
    let marker = read_record(&mut child_reader)?.ok_or("fork child own-settings 边界消失")?;
    if !own_settings(&marker, child_id) {
        return Err("fork child own-settings 身份在验证期间变化");
    }
    if boundary
        .copied_ordinal_end
        .is_some_and(|expected| marker.get("ordinal").and_then(Value::as_u64) != Some(expected))
    {
        return Err("fork child own-settings ordinal 在验证期间变化");
    }
    let mut parent_reader = BufReader::new(&mut parent);
    let mut parent_records = Vec::new();
    while let Some(record) = read_record(&mut parent_reader)? {
        parent_records.push(record);
    }
    let parent_root = parent_records
        .first()
        .ok_or("fork 父 rollout 缺少 canonical session_meta")?;
    let parent_string = parent_id.hyphenated().to_string();
    if meta_id(parent_root) != Some(parent_id)
        || (thread_id_from_filename(parent_path).as_deref() != Some(parent_string.as_str())
            && leading_thread_id_from_filename(parent_path).as_deref()
                != Some(parent_string.as_str()))
    {
        return Err("fork 父 rollout 的 canonical session_meta/文件身份不一致");
    }
    match explicit_parent_from_meta(
        parent_root
            .get("payload")
            .ok_or("fork 父 session_meta 缺少 payload")?,
    ) {
        ParentResolution::None => {}
        ParentResolution::Parent(ancestor) => {
            let ancestor = uuid::Uuid::parse_str(&ancestor)
                .map_err(|_| "fork 父 session_meta 含无效的显式 lineage UUID")?;
            if ancestor == parent_id || ancestor == child_id {
                return Err("fork 父 session_meta 的显式 lineage 存在直接环");
            }
        }
        ParentResolution::Deferred(_) => {
            return Err("fork 父 session_meta 的显式 lineage 不一致");
        }
    }
    if parent_root
        .pointer("/payload/history_base")
        .is_some_and(|value| !value.is_null())
    {
        return Err("fork 父 rollout 含引用历史，不能推断为完整物理复制前缀");
    }

    if child_prefix
        .first()
        .is_none_or(|record| meta_id(record) != Some(parent_id))
        || !token_usage_subsequence(&child_prefix, &parent_records)
    {
        return Err("fork 复制前缀含无法与 parent 对齐的 token usage；下轮重试");
    }
    if let Some(expected) = boundary.parent_ordinal_end {
        let expected = usize::try_from(expected).map_err(|_| "fork 父复制前缀 ordinal 边界过大")?;
        if parent_records.len() < expected
            || parent_records
                .iter()
                .take(expected)
                .enumerate()
                .any(|(offset, record)| {
                    record.get("ordinal").and_then(Value::as_u64) != Some(offset as u64)
                })
        {
            return Err("fork 父复制前缀 ordinal 不连续或缺失");
        }
    }
    drop(parent_reader);
    drop(child_reader);
    if !ParentFileStamp::from_file(&parent)
        .is_some_and(|current| stamp_unchanged_or_grew(current, before))
        || !path_still_names(parent_path, before)
        || !ParentFileStamp::from_file(&child)
            .is_some_and(|current| stamp_unchanged_or_grew(current, child_before))
        || !path_still_names(child_path, child_before)
    {
        return Err("fork rollout 在复制前缀验证期间变化；下轮重试");
    }
    Ok(())
}

/// Return a positive copied-history boundary without relying on wall-clock
/// coverage. `first_live_line` is the line immediately AFTER the owned marker.
/// Missing markers keep the conservative legacy path available only when no
/// copied metadata/explicit ordinal boundary has appeared. Copied history
/// requires an explicit, validated ordinal snapshot boundary; an owned marker
/// and content equality alone cannot exclude pre-resume live child work.
/// Incomplete initialization and contradictory/unsupported proof stay deferred.
pub(super) fn certify_copied_rollout(
    child_path: &Path,
    complete_bytes: i64,
    child_id: &str,
    parent_id: &str,
    rollout_index: &RolloutIndex,
    expected_child_stamp: Option<ParentFileStamp>,
) -> Result<CopiedForkProof, AppError> {
    let Some(complete_bytes) = u64::try_from(complete_bytes).ok() else {
        return Ok(deferred("fork child 完整记录边界无效"));
    };
    let (Ok(child_id), Ok(parent_id)) = (
        uuid::Uuid::parse_str(child_id),
        uuid::Uuid::parse_str(parent_id),
    ) else {
        return Ok(deferred("fork 复制验证需要有效的 child/parent UUID"));
    };
    if child_id == parent_id {
        return Ok(deferred("fork child 与 parent 身份相同"));
    }
    let mut child = File::open(child_path)
        .map_err(|_| AppError::Config("无法打开 child rollout 以验证复制前缀".to_string()))?;
    let Some(child_before) = ParentFileStamp::from_file(&child) else {
        return Ok(deferred("fork 复制验证无法保留 child rollout 文件身份"));
    };
    if !expected_child_stamp.is_some_and(|expected| stamp_unchanged_or_grew(child_before, expected))
    {
        return Ok(deferred(
            "fork child 文件代际与已解析快照不一致或快照身份缺失；下轮重试",
        ));
    }
    if complete_bytes > child_before.size {
        return Ok(deferred("fork child 尚未发布请求的完整记录边界"));
    }
    let boundary = match inspect_child(&mut child, complete_bytes, child_id, parent_id) {
        Ok(Some(boundary)) => boundary,
        Ok(None) => {
            if !ParentFileStamp::from_file(&child)
                .is_some_and(|current| stamp_unchanged_or_grew(current, child_before))
                || !path_still_names(child_path, child_before)
            {
                return Ok(deferred("fork child 在复制前缀验证期间变化；下轮重试"));
            }
            return Ok(CopiedForkProof::Unavailable);
        }
        Err(reason) => return Ok(deferred(reason)),
    };
    let parent_string = parent_id.hyphenated().to_string();
    let Some(candidates) = rollout_index
        .get(&parent_string)
        .filter(|paths| !paths.is_empty())
    else {
        return Ok(deferred("fork 复制前缀缺少可验证的父 rollout"));
    };
    let mut matching_parent = false;
    let mut last_reason = None;
    for candidate in candidates {
        match compare_parent(
            child_path,
            complete_bytes,
            child_before,
            candidate,
            child_id,
            parent_id,
            &boundary,
        ) {
            Ok(()) => {
                matching_parent = true;
                break;
            }
            Err(reason) => last_reason = Some(reason),
        }
    }
    if !matching_parent {
        return Ok(deferred(
            last_reason.unwrap_or("fork 复制前缀缺少匹配的父 rollout"),
        ));
    }
    if !ParentFileStamp::from_file(&child)
        .is_some_and(|current| stamp_unchanged_or_grew(current, child_before))
        || !path_still_names(child_path, child_before)
    {
        return Ok(deferred("fork child 在复制前缀验证期间变化；下轮重试"));
    }
    let Some(first_live_line) = boundary.marker_line.checked_add(1) else {
        return Ok(deferred("fork child live 边界行数溢出"));
    };
    Ok(CopiedForkProof::Verified { first_live_line })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;
    use tempfile::TempDir;

    const PARENT: &str = "00000000-0000-4000-8000-000000000001";
    const CHILD: &str = "00000000-0000-4000-8000-000000000002";
    const OTHER: &str = "00000000-0000-4000-8000-000000000003";

    fn meta(id: &str, parent: Option<&str>) -> Value {
        json!({
            "timestamp": "2026-10-20T00:00:00Z", "type": "session_meta",
            "payload": { "id": id, "forked_from_id": parent, "source": "cli" }
        })
    }

    fn token() -> Value {
        json!({
            "timestamp": "2026-10-20T00:00:01Z", "type": "event_msg",
            "payload": { "type": "token_count", "info": {
                "total_token_usage": { "input_tokens": 100, "output_tokens": 10 }
            } }
        })
    }

    fn marker() -> Value {
        json!({
            "timestamp": "2026-10-21T00:00:01Z", "type": "event_msg",
            "payload": { "type": "thread_settings_applied", "thread_id": CHILD,
                         "thread_settings": { "model": "fixture-model" } }
        })
    }

    fn write(path: &Path, records: &[Value]) {
        let lines = records
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        fs::write(path, lines).unwrap();
    }

    fn fixture(
        parent_records: &[Value],
        child_prefix: &[Value],
    ) -> (TempDir, PathBuf, RolloutIndex) {
        let directory = tempfile::tempdir().unwrap();
        let parent = directory.path().join(format!("rollout-{PARENT}.jsonl"));
        let child = directory.path().join(format!("rollout-{CHILD}.jsonl"));
        let mut parent_records = parent_records.to_vec();
        for (ordinal, record) in parent_records.iter_mut().enumerate() {
            record["ordinal"] = json!(ordinal);
        }
        write(&parent, &parent_records);
        let copied_records = child_prefix.len();
        let mut root = meta(CHILD, Some(PARENT));
        root["ordinal"] = json!(0);
        root["payload"]["subagent_history_start_ordinal"] = json!(copied_records + 1);
        root["payload"]["forked_from_ordinal_exclusive"] = json!(parent_records.len());
        let mut records = vec![root];
        for (offset, record) in child_prefix.iter().enumerate() {
            let mut record = record.clone();
            record["ordinal"] = json!(offset + 1);
            records.push(record);
        }
        let mut settings = marker();
        settings["ordinal"] = json!(copied_records + 1);
        records.push(settings);
        write(&child, &records);
        let mut index = RolloutIndex::new();
        index.insert(PARENT.to_string(), vec![parent]);
        (directory, child, index)
    }

    fn rewrite(path: &Path, change: impl FnOnce(&mut Vec<Value>)) {
        let mut records = fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect::<Vec<Value>>();
        change(&mut records);
        write(path, &records);
    }

    fn remove_ordinal_authority(child: &Path) {
        rewrite(child, |records| {
            let root = records[0]["payload"].as_object_mut().unwrap();
            root.remove("subagent_history_start_ordinal");
            root.remove("forked_from_ordinal_exclusive");
            for record in records {
                record.as_object_mut().unwrap().remove("ordinal");
            }
        });
    }

    fn proof(child: &Path, index: &RolloutIndex) -> CopiedForkProof {
        let expected = ParentFileStamp::from_file(&File::open(child).unwrap()).unwrap();
        certify_copied_rollout(
            child,
            fs::metadata(child).unwrap().len() as i64,
            CHILD,
            PARENT,
            index,
            Some(expected),
        )
        .unwrap()
    }

    #[test]
    fn complete_parent_prefix_is_proven_without_future_parent_activity() {
        let parent = vec![meta(PARENT, None), token()];
        let copied = parent
            .iter()
            .cloned()
            .map(|mut record| {
                record["timestamp"] = json!("2026-10-21T00:00:00Z");
                record
            })
            .collect::<Vec<_>>();
        let (_directory, child, index) = fixture(&parent, &copied);
        assert_eq!(
            proof(&child, &index),
            CopiedForkProof::Verified { first_live_line: 5 }
        );
    }

    #[test]
    fn complete_parent_prefix_survives_child_growth_after_snapshot() {
        let parent = vec![meta(PARENT, None), token()];
        let copied = parent
            .iter()
            .cloned()
            .map(|mut record| {
                record["timestamp"] = json!("2026-10-21T00:00:00Z");
                record
            })
            .collect::<Vec<_>>();
        let (_directory, child, index) = fixture(&parent, &copied);
        let expected = ParentFileStamp::from_file(&File::open(&child).unwrap()).unwrap();
        let complete_bytes = expected.size as i64;
        let mut append = fs::OpenOptions::new().append(true).open(&child).unwrap();
        append.write_all(b"{\"future\":true}\n").unwrap();
        let result = certify_copied_rollout(
            &child,
            complete_bytes,
            CHILD,
            PARENT,
            &index,
            Some(expected),
        )
        .unwrap();
        assert_eq!(result, CopiedForkProof::Verified { first_live_line: 5 });
    }

    #[test]
    fn replayed_prefix_without_token_usage_accepts_codex_rewrites() {
        let parent = vec![
            meta(PARENT, None),
            json!({
                "timestamp": "2026-10-20T00:00:02Z",
                "type": "compacted",
                "payload": { "compaction_response_id": "resp_parent" }
            }),
            json!({
                "timestamp": "2026-10-20T00:00:03Z",
                "type": "world_state",
                "payload": { "state": { "cwd": "D:\\repos\\parent" } }
            }),
        ];
        let replayed = vec![
            meta(PARENT, None),
            json!({
                "timestamp": "2026-10-21T00:00:02Z",
                "type": "compacted",
                "payload": { "compaction_response_id": "resp_rewritten" }
            }),
            json!({
                "timestamp": "2026-10-21T00:00:03Z",
                "type": "world_state",
                "payload": { "state": { "cwd": "D:\\repos\\child" } }
            }),
        ];
        let (_directory, child, index) = fixture(&parent, &replayed);
        assert_eq!(
            proof(&child, &index),
            CopiedForkProof::Verified { first_live_line: 6 }
        );
    }

    #[test]
    fn replayed_prefix_accepts_child_only_non_accounting_records() {
        let parent = vec![
            meta(PARENT, None),
            json!({
                "timestamp": "2026-10-20T00:00:02Z",
                "type": "compacted",
                "payload": { "compaction_response_id": "resp_parent" }
            }),
        ];
        let replayed = vec![
            meta(PARENT, None),
            json!({
                "timestamp": "2026-10-21T00:00:02Z",
                "type": "compacted",
                "payload": { "compaction_response_id": "resp_rewritten" }
            }),
            json!({
                "timestamp": "2026-10-21T00:00:03Z",
                "type": "event_msg",
                "payload": { "type": "turn_aborted", "reason": "harness" }
            }),
            json!({
                "timestamp": "2026-10-21T00:00:04Z",
                "type": "response_item",
                "payload": { "type": "message", "role": "developer" }
            }),
        ];
        let (_directory, child, index) = fixture(&parent, &replayed);
        assert_eq!(
            proof(&child, &index),
            CopiedForkProof::Verified { first_live_line: 7 }
        );
    }

    #[test]
    fn proof_accepts_a_matching_parent_candidate_after_a_stale_rollout() {
        let parent = vec![meta(PARENT, None), token()];
        let (directory, child, mut index) = fixture(&parent, &parent);
        let stale = directory
            .path()
            .join(format!("rollout-stale-{PARENT}.jsonl"));
        let mut stale_records = parent.clone();
        for (ordinal, record) in stale_records.iter_mut().enumerate() {
            record["ordinal"] = json!(ordinal);
        }
        stale_records[1]["payload"]["info"]["total_token_usage"]["output_tokens"] = json!(999);
        write(&stale, &stale_records);
        index.get_mut(PARENT).unwrap().insert(0, stale);

        assert_eq!(
            proof(&child, &index),
            CopiedForkProof::Verified { first_live_line: 5 }
        );
    }

    #[test]
    fn transformed_token_count_cannot_certify_inherited_usage() {
        let parent = vec![meta(PARENT, None), token()];
        let (_directory, child, index) = fixture(&parent, &parent);
        rewrite(&child, |records| {
            records[2]["payload"]["info"]["total_token_usage"]["output_tokens"] = json!(999);
        });
        assert!(matches!(
            proof(&child, &index),
            CopiedForkProof::Deferred(_)
        ));
    }

    #[test]
    fn short_parent_cannot_satisfy_declared_ordinal_boundary() {
        let parent = vec![meta(PARENT, None)];
        let copied = vec![
            meta(PARENT, None),
            json!({
                "timestamp": "2026-10-20T00:00:02Z",
                "type": "compacted",
                "payload": { "compaction_response_id": "resp_rewritten" }
            }),
        ];
        let (_directory, child, index) = fixture(&parent, &copied);
        rewrite(&child, |records| {
            records[0]["payload"]["forked_from_ordinal_exclusive"] = json!(3);
        });
        assert!(matches!(
            proof(&child, &index),
            CopiedForkProof::Deferred(_)
        ));
    }

    #[test]
    fn either_explicit_ordinal_contract_can_certify_a_complete_copy() {
        for absent in [
            "subagent_history_start_ordinal",
            "forked_from_ordinal_exclusive",
        ] {
            let parent = vec![meta(PARENT, None), token()];
            let (_directory, child, index) = fixture(&parent, &parent);
            rewrite(&child, |records| {
                records[0]["payload"]
                    .as_object_mut()
                    .unwrap()
                    .remove(absent);
            });
            assert_eq!(
                proof(&child, &index),
                CopiedForkProof::Verified { first_live_line: 5 },
                "the remaining valid explicit ordinal contract must suffice when {absent} is absent"
            );
        }
    }

    #[test]
    fn copied_prefix_without_explicit_ordinal_boundary_remains_deferred() {
        let parent = vec![meta(PARENT, None), token()];
        let (_directory, child, index) = fixture(&parent, &parent);
        remove_ordinal_authority(&child);
        let result = proof(&child, &index);
        assert!(
            matches!(result, CopiedForkProof::Deferred(_)),
            "an equal prefix plus owned settings cannot prove an old fork's snapshot: {result:?}"
        );
    }

    #[test]
    fn uuid_turn_context_does_not_authorize_a_late_settings_boundary() {
        let context = json!({
            "timestamp": "2026-10-20T00:00:00Z", "type": "turn_context",
            "payload": { "turn_id": OTHER, "model": "fixture-model" }
        });
        let parent = vec![meta(PARENT, None), context, token()];
        let (_directory, child, index) = fixture(&parent, &parent);
        remove_ordinal_authority(&child);
        let result = proof(&child, &index);
        assert!(
            matches!(result, CopiedForkProof::Deferred(_)),
            "even a UUID context does not establish the original copied boundary: {result:?}"
        );
    }

    #[test]
    fn malformed_or_contradictory_ordinal_contract_cannot_be_ignored() {
        for (field, invalid) in [
            ("subagent_history_start_ordinal", json!("3")),
            ("subagent_history_start_ordinal", json!(0)),
            ("subagent_history_start_ordinal", json!(4)),
            ("forked_from_ordinal_exclusive", json!("2")),
            ("forked_from_ordinal_exclusive", json!(-1)),
            ("forked_from_ordinal_exclusive", json!(3)),
        ] {
            let parent = vec![meta(PARENT, None), token()];
            let (_directory, child, index) = fixture(&parent, &parent);
            rewrite(&child, |records| records[0]["payload"][field] = invalid);
            let result = proof(&child, &index);
            assert!(
                matches!(result, CopiedForkProof::Deferred(_)),
                "invalid {field} must not be bypassed by the other valid contract: {result:?}"
            );
        }
    }

    #[test]
    fn copied_child_ordinals_must_be_contiguous() {
        let parent = vec![meta(PARENT, None), token()];
        let (_directory, child, index) = fixture(&parent, &parent);
        rewrite(&child, |records| records[2]["ordinal"] = json!(7));
        assert!(matches!(
            proof(&child, &index),
            CopiedForkProof::Deferred(_)
        ));
    }

    #[test]
    fn declared_parent_prefix_ordinals_must_be_contiguous() {
        let parent = vec![meta(PARENT, None), token()];
        let (_directory, child, index) = fixture(&parent, &parent);
        rewrite(&index[PARENT][0], |records| {
            records[1]["ordinal"] = json!(7)
        });
        assert!(matches!(
            proof(&child, &index),
            CopiedForkProof::Deferred(_)
        ));
    }

    #[test]
    fn parent_back_reference_to_child_is_not_a_copy_proof() {
        let parent = vec![meta(PARENT, Some(CHILD)), token()];
        let (_directory, child, index) = fixture(&parent, &parent);
        assert!(matches!(
            proof(&child, &index),
            CopiedForkProof::Deferred(_)
        ));
    }

    #[test]
    fn conflicting_parent_lineage_is_not_a_copy_proof() {
        let mut root = meta(PARENT, Some(OTHER));
        root["payload"]["source"] =
            json!({"subagent": {"thread_spawn": {"parent_thread_id": CHILD}}});
        let parent = vec![root, token()];
        let (_directory, child, index) = fixture(&parent, &parent);
        assert!(matches!(
            proof(&child, &index),
            CopiedForkProof::Deferred(_)
        ));
    }

    #[test]
    fn copied_meta_cannot_reintroduce_the_current_child() {
        let parent = vec![meta(PARENT, None), meta(CHILD, Some(PARENT)), token()];
        let (_directory, child, index) = fixture(&parent, &parent);
        assert!(matches!(
            proof(&child, &index),
            CopiedForkProof::Deferred(_)
        ));
    }
    #[test]
    fn published_copied_prefix_without_own_settings_remains_deferred() {
        let parent = vec![meta(PARENT, None), token()];
        let (_directory, child, index) = fixture(&parent, &parent);
        let mut records = vec![meta(CHILD, Some(PARENT))];
        records.extend(parent);
        write(&child, &records);
        assert!(matches!(
            proof(&child, &index),
            CopiedForkProof::Deferred(_)
        ));
    }

    #[test]
    fn foreign_copied_meta_without_own_settings_cannot_escape_to_legacy_resolution() {
        let parent = vec![meta(PARENT, None), token()];
        let (_directory, child, index) = fixture(&parent, &parent);
        write(
            &child,
            &[meta(CHILD, Some(PARENT)), meta(OTHER, None), token()],
        );
        let result = proof(&child, &index);
        assert!(
            matches!(result, CopiedForkProof::Deferred(_)),
            "ambiguous copied metadata must not escape to legacy resolution: {result:?}"
        );
    }

    #[test]
    fn legacy_without_copied_metadata_keeps_legacy_resolution_available() {
        let parent = vec![meta(PARENT, None), token()];
        let (_directory, child, index) = fixture(&parent, &parent);
        write(&child, &[meta(CHILD, Some(PARENT)), token()]);
        assert_eq!(proof(&child, &index), CopiedForkProof::Unavailable);
    }
    #[test]
    fn proof_requires_the_parsed_child_file_stamp() {
        let parent = vec![meta(PARENT, None), token()];
        let (_directory, child, index) = fixture(&parent, &parent);
        let result = certify_copied_rollout(
            &child,
            fs::metadata(&child).unwrap().len() as i64,
            CHILD,
            PARENT,
            &index,
            None,
        )
        .unwrap();
        assert!(
            matches!(result, CopiedForkProof::Deferred(_)),
            "copied-prefix proof requires the file stamp of the parsed child: {result:?}"
        );
    }

    #[test]
    fn proof_rejects_replacement_of_the_parsed_child_generation() {
        let parent = vec![meta(PARENT, None), token()];
        let (directory, child, index) = fixture(&parent, &parent);
        let bytes = fs::read(&child).unwrap();
        let modified = fs::metadata(&child).unwrap().modified().unwrap();
        let expected = ParentFileStamp::from_file(&File::open(&child).unwrap()).unwrap();
        // Keep A alive under another path so the replacement B cannot reuse
        // A's inode/file ID. Preserve size and mtime: generation is authority.
        fs::rename(&child, directory.path().join("prior-child.jsonl")).unwrap();
        fs::write(&child, bytes).unwrap();
        let replacement = File::options().write(true).open(&child).unwrap();
        replacement
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
        let current = ParentFileStamp::from_file(&replacement).unwrap();
        assert_eq!(expected.size, current.size);
        assert_eq!(expected.modified_nanos, current.modified_nanos);
        assert_ne!(
            expected, current,
            "the fixture must replace native identity"
        );
        let result = certify_copied_rollout(
            &child,
            current.size as i64,
            CHILD,
            PARENT,
            &index,
            Some(expected),
        )
        .unwrap();
        assert!(
            matches!(result, CopiedForkProof::Deferred(_)),
            "a proof from a different child generation must not certify parsed tokens: {result:?}"
        );
    }
}
