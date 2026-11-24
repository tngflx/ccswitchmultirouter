use std::borrow::Cow;
use std::io::{BufRead, BufReader, Read, Write};

use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

const READ_BUFFER_BYTES: usize = 64 * 1024;
const MAX_RECORD_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug)]
pub(super) struct HistoryBase {
    pub(super) thread_id: String,
    pub(super) end_byte_offset: u64,
    pub(super) end_ordinal_exclusive: u64,
}

#[derive(Debug)]
pub(super) struct RolloutHeader {
    pub(super) paginated: bool,
    pub(super) base: Option<HistoryBase>,
    pub(super) payload: Value,
    pub(super) timestamp: Option<String>,
}

#[derive(Debug)]
pub(super) struct RolloutSnapshot {
    pub(super) header: RolloutHeader,
    pub(super) size: u64,
    pub(super) sha256: String,
    pub(super) end_ordinal_exclusive: Option<u64>,
}

#[derive(Deserialize)]
struct SessionMetaRecord<'a> {
    #[serde(rename = "type", borrow)]
    kind: Cow<'a, str>,
    payload: Value,
    timestamp: Option<String>,
    ordinal: Option<Value>,
}

// Parse enough to validate the record and optionally read its ordinal. Large
// tool results and message contents stay in the reusable byte buffer.
#[derive(Deserialize)]
struct RecordFields<'a> {
    #[serde(rename = "type", borrow)]
    kind: Cow<'a, str>,
    ordinal: Option<u64>,
}

pub(super) fn is_session_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
        })
}

fn read_record(reader: &mut impl BufRead, record: &mut Vec<u8>) -> Result<usize, String> {
    record.clear();
    let size = reader
        .take(MAX_RECORD_BYTES as u64)
        .read_until(b'\n', record)
        .map_err(|error| format!("Could not read the Codex rollout: {error}"))?;
    if size == MAX_RECORD_BYTES && !record.ends_with(b"\n") {
        return Err("A Codex rollout record exceeds the 64 MiB backup limit.".into());
    }
    Ok(size)
}

fn read_history_base(payload: &Value, paginated: bool) -> Result<Option<HistoryBase>, String> {
    let Some(base) = payload.get("history_base").filter(|base| !base.is_null()) else {
        return Ok(None);
    };
    if !paginated {
        return Err(
            "A Codex rollout declares inherited history without paginated history mode.".into(),
        );
    }
    let thread_id = base
        .get("thread_id")
        .and_then(Value::as_str)
        .filter(|id| is_session_id(id));
    let boundary = |key| base.get(key).and_then(Value::as_u64).filter(|&n| n > 0);
    match (
        thread_id,
        boundary("end_byte_offset"),
        boundary("end_ordinal_exclusive"),
    ) {
        (Some(thread_id), Some(end_byte_offset), Some(end_ordinal_exclusive)) => {
            Ok(Some(HistoryBase {
                thread_id: thread_id.to_owned(),
                end_byte_offset,
                end_ordinal_exclusive,
            }))
        }
        _ => Err("The Codex rollout has an invalid inherited history boundary.".into()),
    }
}

fn parse_header(bytes: &[u8], session_id: &str) -> Result<(RolloutHeader, Option<u64>), String> {
    let invalid_header = "The Codex rollout has invalid session metadata.";
    if !bytes.trim_ascii_start().starts_with(b"{") {
        return Err(invalid_header.into());
    }
    let SessionMetaRecord {
        kind,
        payload,
        timestamp,
        ordinal,
    } = serde_json::from_slice(bytes).map_err(|_| invalid_header)?;
    if kind != "session_meta" || payload.get("id").and_then(Value::as_str) != Some(session_id) {
        return Err("The Codex rollout does not belong to the selected chat.".into());
    }
    let paginated = match payload.get("history_mode") {
        None | Some(Value::Null) => false,
        Some(Value::String(mode)) if mode == "legacy" => false,
        Some(Value::String(mode)) if mode == "paginated" => true,
        _ => return Err("The Codex rollout uses an unsupported history mode.".into()),
    };
    let base = read_history_base(&payload, paginated)?;
    let timestamp = timestamp.or_else(|| {
        payload
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    let header = RolloutHeader {
        paginated,
        base,
        payload,
        timestamp,
    };
    Ok((header, ordinal.as_ref().and_then(Value::as_u64)))
}

fn record_fields(bytes: &[u8]) -> Result<RecordFields<'_>, String> {
    let invalid_record = "The Codex rollout contains an invalid JSONL record.";
    if !bytes.trim_ascii_start().starts_with(b"{") {
        return Err(invalid_record.into());
    }
    // Validate UTF-8 even for payloads the deserializer visits as ignored values.
    let text = std::str::from_utf8(bytes).map_err(|_| invalid_record)?;
    let fields: RecordFields = serde_json::from_str(text).map_err(|_| invalid_record)?;
    if fields.kind.is_empty() {
        return Err(invalid_record.into());
    }
    Ok(fields)
}

pub(super) fn copy_rollout(
    input: &mut impl Read,
    output: &mut impl Write,
    limit: u64,
    session_id: &str,
    allow_partial_tail: bool,
) -> Result<RolloutSnapshot, String> {
    if !is_session_id(session_id) {
        return Err("Invalid Codex chat ID.".into());
    }

    let mut reader = BufReader::with_capacity(READ_BUFFER_BYTES, input.take(limit));
    let mut record = Vec::new();
    read_record(&mut reader, &mut record)?;
    if !record.ends_with(b"\n") {
        return Err("The Codex rollout has no complete session metadata record.".into());
    }
    let (header, ordinal) = parse_header(&record, session_id)?;
    let mut end_ordinal_exclusive = None;
    if header.paginated {
        end_ordinal_exclusive = Some(next_ordinal(ordinal, None)?);
    }
    let mut digest = Sha256::new();
    let mut size = 0;
    loop {
        output
            .write_all(&record)
            .map_err(|error| format!("Could not save the Codex rollout: {error}"))?;
        digest.update(&record);
        size += record.len() as u64;

        if read_record(&mut reader, &mut record)? == 0 {
            break;
        }
        if !record.ends_with(b"\n") {
            if !allow_partial_tail {
                return Err("The saved Codex rollout ends with an incomplete record.".into());
            }
            break;
        }
        let fields = record_fields(&record)?;
        if header.paginated {
            end_ordinal_exclusive = Some(next_ordinal(fields.ordinal, end_ordinal_exclusive)?);
        }
    }

    if reader.get_ref().limit() != 0 {
        return Err("The Codex rollout ended before the captured size.".into());
    }
    Ok(RolloutSnapshot {
        header,
        size,
        sha256: hex::encode(digest.finalize()),
        end_ordinal_exclusive,
    })
}

fn next_ordinal(ordinal: Option<u64>, previous_end: Option<u64>) -> Result<u64, String> {
    let next = ordinal
        .and_then(|ordinal| ordinal.checked_add(1))
        .ok_or("A paginated Codex rollout record has no valid ordinal.")?;
    if previous_end.is_some_and(|previous| next <= previous) {
        return Err("Paginated Codex rollout ordinals are out of order.".into());
    }
    Ok(next)
}

/// Verify every referenced boundary in one pass through the parent prefix.
/// Callers have already verified the parent ID and paginated history mode.
pub(super) fn validate_history_boundaries(
    parent: &mut impl Read,
    parent_size: u64,
    cutoffs: &[&HistoryBase],
) -> Result<(), String> {
    let mut cutoffs = cutoffs.to_vec();
    cutoffs.sort_unstable_by_key(|base| base.end_byte_offset);
    let Some(last) = cutoffs.last() else {
        return Ok(());
    };
    let prefix_size = last.end_byte_offset;
    if prefix_size > parent_size || cutoffs[0].end_byte_offset == 0 {
        return Err("Inherited history extends outside the saved parent rollout.".into());
    }

    let mut reader = BufReader::with_capacity(READ_BUFFER_BYTES, parent.take(prefix_size));
    let mut record = Vec::new();
    let mut offset = 0;
    let mut pending = cutoffs.into_iter().peekable();
    while let Some(cutoff) = pending.peek() {
        offset += read_record(&mut reader, &mut record)? as u64;
        if !record.ends_with(b"\n") || offset > cutoff.end_byte_offset {
            return Err("Inherited history does not end on a complete JSONL record.".into());
        }
        if offset < cutoff.end_byte_offset {
            continue;
        }

        let ordinal_exclusive = record_fields(&record)?
            .ordinal
            .and_then(|ordinal| ordinal.checked_add(1));
        while pending
            .peek()
            .is_some_and(|base| base.end_byte_offset == offset)
        {
            let cutoff = pending.next().expect("a checked cutoff is present");
            if ordinal_exclusive != Some(cutoff.end_ordinal_exclusive) {
                return Err("Inherited history does not match the saved parent ordinal.".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    const CHAT: &str = "01a00000-0000-7000-8000-000000000080";
    const PARENT: &str = "01a00000-0000-7000-8000-000000000081";

    fn header(id: &str, payload_fields: &str) -> String {
        format!("{{\"timestamp\":\"2026-11-01T10:00:00Z\",\"ordinal\":0,\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\"{payload_fields}}}}}\n")
    }

    #[test]
    fn saves_only_complete_records_in_captured_prefix_of_a_growing_rollout() {
        let tool_result = "x".repeat(READ_BUFFER_BYTES * 3);
        let mut prefix = header(CHAT, "");
        prefix.push_str(&format!(
            "{{\"ordinal\":1,\"type\":\"response_item\",\"payload\":{{\"output\":\"{tool_result}\"}}}}\r\n"
        ));
        prefix.push_str(&header(PARENT, ""));
        let mut captured = prefix.clone();
        captured.push_str("{\"ordinal\":2,\"type\":\"event_");
        let limit = captured.len() as u64;
        captured.push_str("msg\",\"payload\":{}}\n{\"type\":\"event_msg\"}\n");

        let mut source = Cursor::new(captured.as_bytes());
        let mut saved = Vec::new();
        let snapshot = copy_rollout(&mut source, &mut saved, limit, CHAT, true).unwrap();
        assert_eq!(source.position(), limit);
        assert_eq!(saved, prefix.as_bytes());
        assert_eq!(snapshot.size, prefix.len() as u64);
        assert_eq!(
            snapshot.sha256,
            hex::encode(Sha256::digest(prefix.as_bytes()))
        );
        assert_eq!(
            snapshot.header.timestamp.as_deref(),
            Some("2026-11-01T10:00:00Z")
        );
        assert_eq!(snapshot.header.payload["id"], CHAT);
        assert!(!snapshot.header.paginated);
        assert_eq!(snapshot.end_ordinal_exclusive, None);
    }

    #[test]
    fn rejects_a_foreign_header_and_a_corrupt_or_incomplete_saved_record() {
        let good_header = header(CHAT, "");
        let foreign_header = header(PARENT, "");
        for invalid in [
            foreign_header.as_bytes().to_vec(),
            format!("[\"session_meta\",{{\"id\":\"{CHAT}\"}},null]\n").into_bytes(),
            format!("{good_header}[\"event_msg\",1]\n").into_bytes(),
            format!("{good_header}{{\"type\":\"event_msg\",\"payload\":{{oops}}}}\n").into_bytes(),
            format!("{good_header}{{\"type\":\"event_msg\"}}").into_bytes(),
            [
                good_header.as_bytes(),
                b"{\"type\":\"event_msg\",\"payload\":\"\xff\"}\n",
            ]
            .concat(),
        ] {
            assert!(copy_rollout(
                &mut invalid.as_slice(),
                &mut std::io::sink(),
                invalid.len() as u64,
                CHAT,
                false
            )
            .is_err());
        }
        let invalid = format!("{good_header}{{\"type\":!}}\n");
        assert!(copy_rollout(
            &mut invalid.as_bytes(),
            &mut std::io::sink(),
            invalid.len() as u64,
            CHAT,
            true
        )
        .is_err());
    }

    #[test]
    fn rejects_a_rollout_that_shrinks_before_the_captured_length() {
        let header = header(CHAT, "");
        let error = copy_rollout(
            &mut header.as_bytes(),
            &mut std::io::sink(),
            header.len() as u64 + 32,
            CHAT,
            true,
        )
        .unwrap_err();
        assert!(error.contains("before the captured size"));
    }

    #[test]
    fn paginated_frontier_ignores_the_incomplete_tail_and_allows_ordinal_gaps() {
        let mut input = header(CHAT, ",\"history_mode\":\"paginated\"");
        input.push_str("{\"type\":\"event_msg\",\"ordinal\":5}\n");
        input.push_str("{\"type\":\"event_msg\",\"ordinal\":9");
        let snapshot = copy_rollout(
            &mut input.as_bytes(),
            &mut std::io::sink(),
            input.len() as u64,
            CHAT,
            true,
        )
        .unwrap();
        assert_eq!(snapshot.end_ordinal_exclusive, Some(6));
    }

    #[test]
    fn rejects_missing_overflowing_or_non_increasing_paginated_ordinals() {
        let meta = header(CHAT, ",\"history_mode\":\"paginated\"");
        let missing_header_ordinal = meta.replace("\"ordinal\":0,", "");
        let maximum_ordinal = format!("{{\"type\":\"event_msg\",\"ordinal\":{}}}\n", u64::MAX);
        for invalid in [
            missing_header_ordinal,
            format!("{meta}{{\"type\":\"event_msg\"}}\n"),
            format!("{meta}{maximum_ordinal}"),
            format!("{meta}{{\"type\":\"event_msg\",\"ordinal\":0}}\n"),
            format!("{meta}{{\"type\":\"event_msg\",\"ordinal\":2}}\n{{\"type\":\"event_msg\",\"ordinal\":1}}\n"),
        ] {
            assert!(copy_rollout(
                &mut invalid.as_bytes(),
                &mut std::io::sink(),
                invalid.len() as u64,
                CHAT,
                false,
            )
            .is_err());
        }
    }

    #[test]
    fn proves_fork_boundaries_against_the_exact_parent_prefix() {
        let meta = header(PARENT, ",\"history_mode\":\"paginated\"");
        let parent_prefix = format!("{meta}{{\"type\":\"event_msg\",\"ordinal\":1}}\n");
        let parent = format!("{parent_prefix}{{\"type\":\"event_msg\",\"ordinal\":2}}\n");
        let child = header(CHAT, &format!(
            ",\"history_mode\":\"paginated\",\"history_base\":{{\"thread_id\":\"{PARENT}\",\"end_ordinal_exclusive\":2,\"end_byte_offset\":{}}}",
            parent_prefix.len()
        )).replacen("\"ordinal\":0", "\"ordinal\":2", 1);
        let snapshot = copy_rollout(
            &mut child.as_bytes(),
            &mut std::io::sink(),
            child.len() as u64,
            CHAT,
            false,
        )
        .unwrap();
        assert!(snapshot.header.paginated);
        assert_eq!(snapshot.end_ordinal_exclusive, Some(3));
        let base = snapshot.header.base.unwrap();
        assert_eq!(base.thread_id, PARENT);
        let first = HistoryBase {
            thread_id: PARENT.into(),
            end_byte_offset: meta.len() as u64,
            end_ordinal_exclusive: 1,
        };
        let mut source = Cursor::new(parent.as_bytes());
        validate_history_boundaries(&mut source, parent.len() as u64, &[&base, &first, &base])
            .unwrap();
        assert_eq!(source.position(), parent_prefix.len() as u64);

        let wrong_ordinal = HistoryBase {
            end_ordinal_exclusive: 3,
            ..base
        };
        assert!(validate_history_boundaries(
            &mut parent.as_bytes(),
            parent.len() as u64,
            &[&wrong_ordinal]
        )
        .is_err());
        let wrong_byte = HistoryBase {
            end_byte_offset: parent_prefix.len() as u64 - 1,
            ..wrong_ordinal
        };
        assert!(validate_history_boundaries(
            &mut parent.as_bytes(),
            parent.len() as u64,
            &[&wrong_byte]
        )
        .is_err());
    }
}
