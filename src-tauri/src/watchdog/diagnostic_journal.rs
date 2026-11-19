use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

pub(super) const MAX_BYTES: usize = 1024 * 1024;
const RETAIN_BYTES: usize = MAX_BYTES / 2;
const MAX_RECORD_BYTES: usize = 64 * 1024;

/// Read a bounded suffix, beginning at a complete record boundary even if
/// an older binary left a very large file or a malformed, oversized record.
pub(super) fn tail(path: &Path) -> io::Result<Vec<u8>> {
    read_tail(File::open(path)?, MAX_BYTES)
}

fn read_tail(mut file: File, max_bytes: usize) -> io::Result<Vec<u8>> {
    let end = file.seek(SeekFrom::End(0))?;
    let start = end.saturating_sub(max_bytes as u64);
    let offset = start.saturating_sub(1);
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = Vec::with_capacity((end - offset) as usize);
    file.take(end - offset).read_to_end(&mut bytes)?;
    if start > 0 {
        let first_complete = bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |newline| newline + 1);
        bytes.drain(..first_complete);
    }
    Ok(bytes)
}

pub(super) fn append(path: &Path, value: &impl Serialize) -> io::Result<()> {
    let mut record = serde_json::to_vec(value).map_err(io::Error::other)?;
    record.push(b'\n');
    if record.len() > MAX_RECORD_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "diagnostic record exceeds the journal record limit",
        ));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // Use a separate, stable inode because compaction replaces the journal.
    // Keep the lock file in place so another writer cannot lock a new inode.
    let lock_path = path.with_extension("jsonl.lock");
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)?;
    lock.lock()?;
    let mut file = OpenOptions::new()
        .read(true)
        .append(true)
        .create(true)
        .open(path)?;
    let end = file.seek(SeekFrom::End(0))?;
    if end.saturating_add(record.len() as u64 + 1) > MAX_BYTES as u64 {
        let mut retained = read_tail(file, RETAIN_BYTES)?;
        if !retained.is_empty() && !retained.ends_with(b"\n") {
            retained.push(b'\n');
        }
        retained.extend_from_slice(&record);
        return crate::config::atomic_write(path, &retained).map_err(io::Error::other);
    }
    if end > 0 {
        file.seek(SeekFrom::End(-1))?;
        let mut last = [0];
        file.read_exact(&mut last)?;
        if last[0] != b'\n' {
            // Isolate a torn record rather than concatenating the next event.
            record.insert(0, b'\n');
        }
    }
    file.write_all(&record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn append_compacts_legacy_journal_and_preserves_complete_recent_records() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("diagnostics.jsonl");
        let mut bytes = vec![0xff; 2 * MAX_BYTES];
        bytes.extend_from_slice(b"\n{\"sequence\":1}\n{\"torn\":");
        fs::write(&path, bytes).unwrap();

        let record = json!({"sequence": 2});
        append(&path, &record).unwrap();

        assert!(fs::metadata(&path).unwrap().len() <= MAX_BYTES as u64);
        let retained = tail(&path).unwrap();
        let decoded = retained
            .split(|byte| *byte == b'\n')
            .filter_map(|line| serde_json::from_slice::<serde_json::Value>(line).ok())
            .collect::<Vec<_>>();
        assert_eq!(decoded, vec![json!({"sequence": 1}), record]);
    }
}
