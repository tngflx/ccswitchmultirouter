use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use chrono::{DateTime, FixedOffset};
use serde_json::Value;

use crate::file_revision::FileRevision;

/// Maximum number of characters for session titles (shared across providers).
pub const TITLE_MAX_CHARS: usize = 80;

pub(super) struct FileCache<T> {
    entries: HashMap<PathBuf, (FileRevision, T, u64)>,
    scan: u64,
    #[cfg(test)]
    pub(super) loads: usize,
}

impl<T> Default for FileCache<T> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            scan: 0,
            #[cfg(test)]
            loads: 0,
        }
    }
}

impl<T: Clone> FileCache<T> {
    pub(super) fn refresh<R>(&mut self, scan: impl FnOnce(&mut Self) -> R) -> R {
        self.scan = self.scan.wrapping_add(1);
        let result = scan(self);
        self.entries.retain(|_, entry| entry.2 == self.scan);
        result
    }

    pub(super) fn read<E>(
        &mut self,
        path: &Path,
        load: impl FnOnce(&mut File) -> Result<T, E>,
    ) -> Option<T> {
        let mut file = File::open(path).ok()?;
        let revision = FileRevision::from_file(&file);
        if let Some((saved, value, scan)) = self.entries.get_mut(path) {
            if revision.as_ref() == Some(saved) {
                *scan = self.scan;
                return Some(value.clone());
            }
        }

        #[cfg(test)]
        {
            self.loads += 1;
        }
        let value = load(&mut file).ok()?;
        // Reopen after reading so a replacement at the same path cannot publish stale metadata.
        let stable =
            revision.filter(|revision| FileRevision::read(path).as_ref() == Some(revision));
        if let Some(revision) = stable {
            self.entries
                .insert(path.to_path_buf(), (revision, value.clone(), self.scan));
        }
        Some(value)
    }
}

/// Read the first `head_n` lines and last `tail_n` lines from a file.
/// For small files (< 16 KB), reads all lines once to avoid unnecessary seeking.
pub fn read_head_tail_lines(
    path: &Path,
    head_n: usize,
    tail_n: usize,
) -> io::Result<(Vec<String>, Vec<String>)> {
    read_open_file_head_tail_lines(&mut File::open(path)?, head_n, tail_n)
}

pub(super) fn read_open_file_head_tail_lines(
    file: &mut File,
    head_n: usize,
    tail_n: usize,
) -> io::Result<(Vec<String>, Vec<String>)> {
    let file_len = file.metadata()?.len();

    // For small files, read all lines once and split
    if file_len < 16_384 {
        let reader = BufReader::new(file);
        let all = read_utf8_lines(reader.lines())?;
        let head = all.iter().take(head_n).cloned().collect();
        let skip = all.len().saturating_sub(tail_n);
        let tail = all.into_iter().skip(skip).collect();
        return Ok((head, tail));
    }

    // Read head lines from the beginning
    let reader = BufReader::new(&mut *file);
    let head = read_utf8_lines(reader.lines().take(head_n))?;

    // Seek to last ~16 KB for tail lines
    let seek_pos = file_len.saturating_sub(16_384);
    file.seek(SeekFrom::Start(seek_pos))?;
    let tail_reader = BufReader::new(file);
    let all_tail = read_utf8_lines(tail_reader.lines())?;

    // Skip first partial line if we seeked into the middle of a line
    let skip_first = if seek_pos > 0 { 1 } else { 0 };
    let usable: Vec<String> = all_tail.into_iter().skip(skip_first).collect();
    let skip = usable.len().saturating_sub(tail_n);
    let tail = usable.into_iter().skip(skip).collect();

    Ok((head, tail))
}

fn read_utf8_lines(lines: impl Iterator<Item = io::Result<String>>) -> io::Result<Vec<String>> {
    let mut result = Vec::new();
    for line in lines {
        match line {
            Ok(line) => result.push(line),
            Err(error) if error.kind() == io::ErrorKind::InvalidData => break,
            Err(error) => return Err(error),
        }
    }
    Ok(result)
}

pub fn parse_timestamp_to_ms(value: &Value) -> Option<i64> {
    // Integer: milliseconds (>1e12) or seconds
    if let Some(n) = value.as_i64() {
        return Some(if n > 1_000_000_000_000 { n } else { n * 1000 });
    }
    if let Some(n) = value.as_f64() {
        let n = n as i64;
        return Some(if n > 1_000_000_000_000 { n } else { n * 1000 });
    }
    // RFC3339 string
    let raw = value.as_str()?;
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|dt: DateTime<FixedOffset>| dt.timestamp_millis())
}

pub fn extract_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.to_string(),
        Value::Array(items) => items
            .iter()
            .filter_map(extract_text_from_item)
            .filter(|text| !text.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(map) => map
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        _ => String::new(),
    }
}

fn extract_text_from_item(item: &Value) -> Option<String> {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");

    // tool_use: show tool name
    if item_type == "tool_use" {
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        return Some(format!("[Tool: {name}]"));
    }

    // tool_result: extract nested content
    if item_type == "tool_result" {
        if let Some(content) = item.get("content") {
            let text = extract_text(content);
            if !text.is_empty() {
                return Some(text);
            }
        }
        return None;
    }

    if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
        return Some(text.to_string());
    }

    if let Some(text) = item.get("input_text").and_then(|v| v.as_str()) {
        return Some(text.to_string());
    }

    if let Some(text) = item.get("output_text").and_then(|v| v.as_str()) {
        return Some(text.to_string());
    }

    if let Some(content) = item.get("content") {
        let text = extract_text(content);
        if !text.is_empty() {
            return Some(text);
        }
    }

    None
}

pub fn truncate_summary(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }

    let mut result = trimmed.chars().take(max_chars).collect::<String>();
    result.push_str("...");
    result
}

pub fn path_basename(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed.trim_end_matches(['/', '\\']);
    let last = normalized
        .split(['/', '\\'])
        .next_back()
        .filter(|segment| !segment.is_empty())?;
    Some(last.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_timestamp_to_ms_supports_integers_and_rfc3339() {
        assert_eq!(
            parse_timestamp_to_ms(&json!(1_771_061_953_033_i64)),
            Some(1_771_061_953_033)
        );
        assert_eq!(
            parse_timestamp_to_ms(&json!(1_771_061_953_i64)),
            Some(1_771_061_953_000)
        );
        assert_eq!(
            parse_timestamp_to_ms(&json!("1970-01-01T00:00:01Z")),
            Some(1_000)
        );
    }
}
