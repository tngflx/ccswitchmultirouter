use std::collections::HashSet;
use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use super::rollout::{copy_rollout, is_session_id, RolloutSnapshot};
use super::state::ThreadMetadata;

const FORMAT: &str = "ccswitch-codex-session-backup";
const VERSION: u32 = 1;
const MANIFEST_FILE: &str = "manifest.json";
const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;
pub(super) const PROJECTION_FILE: &str = "projection.jsonl";
pub(super) const MAX_SESSIONS: usize = 4_096;
pub(super) const MAX_MEMBER_BYTES: u64 = 16 * 1024 * 1024 * 1024;
pub(super) const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Manifest {
    format: String,
    version: u32,
    pub(super) sessions: Vec<SessionEntry>,
    pub(super) projection: Option<MemberDigest>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SessionEntry {
    pub(super) session_id: String,
    pub(super) rollout_name: String,
    pub(super) title: String,
    pub(super) project_path: Option<String>,
    pub(super) updated_at_ms: i64,
    pub(super) paginated: bool,
    pub(super) metadata: ThreadMetadata,
    pub(super) digest: MemberDigest,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct MemberDigest {
    pub(super) size: u64,
    pub(super) sha256: String,
}

impl Manifest {
    pub(super) fn new(sessions: Vec<SessionEntry>, projection: Option<MemberDigest>) -> Self {
        Self {
            format: FORMAT.into(),
            version: VERSION,
            sessions,
            projection,
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.format != FORMAT || self.version != VERSION {
            return Err("Unsupported Codex session backup format or version.".into());
        }
        if self.sessions.is_empty() || self.sessions.len() > MAX_SESSIONS {
            return Err("Invalid number of chats in the Codex session backup.".into());
        }

        let mut session_ids = HashSet::with_capacity(self.sessions.len());
        let mut rollout_names = HashSet::with_capacity(self.sessions.len());
        let mut needs_projection = false;
        let mut total = 0;
        for session in &self.sessions {
            rollout_name_parts(&session.rollout_name)?;
            if !is_session_id(&session.session_id)
                || !session_ids.insert(session.session_id.as_str())
                || !rollout_names.insert(session.rollout_name.as_str())
            {
                return Err("Invalid or duplicate chat in the Codex session backup.".into());
            }
            session.metadata.validate(session.paginated)?;
            session.digest.add_size(&mut total)?;
            needs_projection |= session.paginated;
        }
        if needs_projection != self.projection.is_some() {
            return Err(
                "The backup's history projection does not match its chat manifests.".into(),
            );
        }
        if let Some(projection) = &self.projection {
            projection.add_size(&mut total)?;
        }
        Ok(())
    }
}

impl MemberDigest {
    fn add_size(&self, total: &mut u64) -> Result<(), String> {
        if self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("Invalid SHA-256 digest in the Codex session backup.".into());
        }
        if self.size == 0 || self.size > MAX_MEMBER_BYTES || *total + self.size > MAX_TOTAL_BYTES {
            return Err("The Codex session backup exceeds its expanded size limit.".into());
        }
        *total += self.size;
        Ok(())
    }

    fn verify(&self, size: u64, sha256: &str) -> Result<(), String> {
        if self.size != size || self.sha256 != sha256 {
            return Err("A Codex session backup member failed its size or SHA-256 check.".into());
        }
        Ok(())
    }
}

pub(super) fn rollout_name_parts(name: &str) -> Result<(NaiveDateTime, &str), String> {
    let invalid_name = || "Invalid rollout filename in the Codex session backup.".to_owned();
    let body = name
        .strip_prefix("rollout-")
        .and_then(|name| name.strip_suffix(".jsonl"))
        .filter(|body| body.is_ascii() && body.len() == 56)
        .ok_or_else(invalid_name)?;
    let (timestamp, id_with_separator) = body.split_at(19);
    let id = id_with_separator
        .strip_prefix('-')
        .filter(|id| is_session_id(id))
        .ok_or_else(invalid_name)?;
    let date = NaiveDateTime::parse_from_str(timestamp, "%Y-%m-%dT%H-%M-%S")
        .map_err(|_| invalid_name())?;
    if date.format("%Y-%m-%dT%H-%M-%S").to_string() != timestamp {
        return Err(invalid_name());
    }
    Ok((date, id))
}

pub(super) fn write_package(
    file: &mut File,
    manifest: &Manifest,
    stage: &Path,
) -> Result<(), String> {
    manifest.validate()?;
    let bytes = serde_json::to_vec(manifest).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("The Codex session backup manifest exceeds its size limit.".into());
    }
    let mut writer = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    writer
        .start_file(MANIFEST_FILE, options)
        .map_err(|error| error.to_string())?;
    writer
        .write_all(&bytes)
        .map_err(|error| error.to_string())?;
    for session in &manifest.sessions {
        write_member(
            &mut writer,
            options,
            &format!("rollouts/{}", session.rollout_name),
            &stage.join(&session.rollout_name),
            &session.digest,
        )?;
    }
    if let Some(projection) = &manifest.projection {
        write_member(
            &mut writer,
            options,
            PROJECTION_FILE,
            &stage.join(PROJECTION_FILE),
            projection,
        )?;
    }
    writer.finish().map_err(|error| error.to_string())?;
    Ok(())
}

fn write_member(
    writer: &mut ZipWriter<&mut File>,
    options: SimpleFileOptions,
    name: &str,
    path: &Path,
    digest: &MemberDigest,
) -> Result<(), String> {
    let mut source = File::open(path).map_err(|error| error.to_string())?;
    writer
        .start_file(
            name,
            options.large_file(digest.size >= 2 * 1024 * 1024 * 1024),
        )
        .map_err(|error| error.to_string())?;
    copy_member(&mut source, writer, digest)
}

pub(super) fn read_package(
    file: File,
    stage: &Path,
    expected_hash: Option<&str>,
) -> Result<(Manifest, String, Vec<RolloutSnapshot>), String> {
    let mut directory_reader = file.try_clone().map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
    validate_directory(&mut directory_reader, &archive)?;

    let bytes = {
        let mut member = open_member(&mut archive, MANIFEST_FILE, None)?;
        if member.size() > MAX_MANIFEST_BYTES {
            return Err("The Codex session backup manifest exceeds its size limit.".into());
        }
        let mut bytes = Vec::with_capacity(member.size() as usize);
        let mut bounded = (&mut member).take(MAX_MANIFEST_BYTES + 1);
        bounded
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        check_end(&mut member)?;
        if bytes.len() as u64 != member.size() {
            return Err("The Codex session backup manifest has an invalid size.".into());
        }
        bytes
    };
    let hash = hex::encode(Sha256::digest(&bytes));
    if expected_hash.is_some_and(|expected| expected != hash) {
        return Err(
            "The Codex session backup changed after preview. Open it again to review it.".into(),
        );
    }
    let manifest: Manifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid Codex session backup manifest: {error}"))?;
    manifest.validate()?;
    let expected_members = 1 + manifest.sessions.len() + usize::from(manifest.projection.is_some());
    if archive.len() != expected_members {
        return Err("The contents of the Codex session backup do not match its manifest.".into());
    }

    let mut snapshots = Vec::with_capacity(manifest.sessions.len());
    for session in &manifest.sessions {
        let name = format!("rollouts/{}", session.rollout_name);
        let mut member = open_member(&mut archive, &name, Some(session.digest.size))?;
        let mut output = BufWriter::new(create_member(stage, &session.rollout_name)?);
        let mut snapshot = copy_rollout(
            &mut member,
            &mut output,
            session.digest.size,
            &session.session_id,
            false,
        )?;
        check_end(&mut member)?;
        session.digest.verify(snapshot.size, &snapshot.sha256)?;
        if snapshot.header.paginated != session.paginated {
            return Err("A saved Codex rollout's history mode does not match its manifest.".into());
        }
        output.flush().map_err(|error| error.to_string())?;
        // Restoring uses validated manifest metadata. Only keep the rollout's
        // lineage and size information once the raw header has been checked.
        snapshot.header.payload = serde_json::Value::Null;
        snapshots.push(snapshot);
    }
    if let Some(projection) = &manifest.projection {
        let mut member = open_member(&mut archive, PROJECTION_FILE, Some(projection.size))?;
        let mut output = create_member(stage, PROJECTION_FILE)?;
        copy_member(&mut member, &mut output, projection)?;
    }
    Ok((manifest, hash, snapshots))
}

fn create_member(stage: &Path, name: &str) -> Result<File, String> {
    File::options()
        .write(true)
        .create_new(true)
        .open(stage.join(name))
        .map_err(|error| format!("Could not stage a Codex session backup member: {error}"))
}

fn open_member<'a>(
    archive: &'a mut ZipArchive<File>,
    name: &str,
    size: Option<u64>,
) -> Result<zip::read::ZipFile<'a, File>, String> {
    let member = archive.by_name(name).map_err(|error| error.to_string())?;
    if member.name_raw() != name.as_bytes()
        || !member.is_file()
        || member
            .unix_mode()
            .is_some_and(|mode| !matches!(mode & 0o170000, 0 | 0o100000))
        || member.encrypted()
        || !matches!(
            member.compression(),
            CompressionMethod::Stored | CompressionMethod::Deflated
        )
        || size.is_some_and(|size| size != member.size())
    {
        return Err("A Codex session backup member has an invalid type or size.".into());
    }
    Ok(member)
}

fn check_end(input: &mut impl Read) -> Result<(), String> {
    // Read past the declared size to check both actual EOF and the ZIP CRC.
    match input.read(&mut [0]).map_err(|error| error.to_string())? {
        0 => Ok(()),
        _ => Err("A Codex session backup member exceeds its declared size.".into()),
    }
}

fn copy_member(
    input: &mut impl Read,
    output: &mut impl Write,
    digest: &MemberDigest,
) -> Result<(), String> {
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    let mut size = 0;
    while size < digest.size {
        let limit = (digest.size - size).min(buffer.len() as u64) as usize;
        let count = input
            .read(&mut buffer[..limit])
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        output
            .write_all(&buffer[..count])
            .map_err(|error| error.to_string())?;
        hash.update(&buffer[..count]);
        size += count as u64;
    }
    check_end(input)?;
    digest.verify(size, &hex::encode(hash.finalize()))
}

fn validate_directory(reader: &mut File, archive: &ZipArchive<File>) -> Result<(), String> {
    const CENTRAL_FILE_HEADER: [u8; 4] = *b"PK\x01\x02";
    const END_OF_CENTRAL_DIRECTORY: [u8; 4] = *b"PK\x05\x06";
    const ZIP64_END_OF_CENTRAL_DIRECTORY: [u8; 4] = *b"PK\x06\x06";

    // ZipArchive indexes members by name, collapsing duplicates. Walk the physical
    // directory entries to reject a member set with duplicate names.
    if archive.len() > MAX_SESSIONS + 2 || archive.offset() != 0 {
        return Err("Invalid member directory in the Codex session backup.".into());
    }
    reader
        .seek(SeekFrom::Start(archive.central_directory_start()))
        .map_err(|error| error.to_string())?;
    for _ in 0..archive.len() {
        let mut header = [0; 46];
        reader
            .read_exact(&mut header)
            .map_err(|error| error.to_string())?;
        if header[..4] != CENTRAL_FILE_HEADER {
            return Err("Invalid member directory in the Codex session backup.".into());
        }
        // Fixed ZIP header offsets for the filename, extra field and comment lengths.
        let variable_size = [28, 30, 32]
            .into_iter()
            .map(|index| u16::from_le_bytes([header[index], header[index + 1]]) as i64)
            .sum();
        reader
            .seek(SeekFrom::Current(variable_size))
            .map_err(|error| error.to_string())?;
    }
    let mut signature = [0; 4];
    reader
        .read_exact(&mut signature)
        .map_err(|error| error.to_string())?;
    if !matches!(
        signature,
        END_OF_CENTRAL_DIRECTORY | ZIP64_END_OF_CENTRAL_DIRECTORY
    ) {
        return Err("Unexpected or duplicate members in the Codex session backup.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const CHAT: &str = "01900000-0000-7000-8000-000000000001";
    const ROLLOUT_ID: &str = "01900000-0000-7000-8000-000000000099";
    const ROLLOUT_NAME: &str =
        "rollout-2026-11-01T10-00-00-01900000-0000-7000-8000-000000000099.jsonl";

    fn rollout() -> Vec<u8> {
        format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{CHAT}\"}}}}\n{{\"type\":\"response_item\",\"payload\":{{\"text\":\"one\"}}}}\n").into_bytes()
    }

    fn fixture(bytes: &[u8]) -> Manifest {
        Manifest::new(
            vec![SessionEntry {
                session_id: CHAT.into(),
                rollout_name: ROLLOUT_NAME.into(),
                title: "A test chat".into(),
                project_path: None,
                updated_at_ms: 1,
                paginated: false,
                metadata: serde_json::from_str("{}").unwrap(),
                digest: MemberDigest {
                    size: bytes.len() as u64,
                    sha256: hex::encode(Sha256::digest(bytes)),
                },
            }],
            None,
        )
    }

    fn make_archive(manifest: &Manifest, rollout_name: &str, bytes: &[u8]) -> File {
        let mut writer = ZipWriter::new(tempfile::tempfile().unwrap());
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        writer.start_file(MANIFEST_FILE, options).unwrap();
        serde_json::to_writer(&mut writer, manifest).unwrap();
        writer.start_file(rollout_name, options).unwrap();
        writer.write_all(bytes).unwrap();
        writer.finish().unwrap()
    }

    #[test]
    fn package_round_trip_preserves_rollout_bytes_and_distinct_ids() {
        let source = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let bytes = rollout();
        let manifest = fixture(&bytes);
        fs::write(source.path().join(ROLLOUT_NAME), &bytes).unwrap();
        let mut package = tempfile::tempfile().unwrap();
        write_package(&mut package, &manifest, source.path()).unwrap();

        let (restored, hash, snapshots) = read_package(package, destination.path(), None).unwrap();
        assert_eq!(restored.sessions[0].session_id, CHAT);
        assert_eq!(
            rollout_name_parts(&restored.sessions[0].rollout_name)
                .unwrap()
                .1,
            ROLLOUT_ID
        );
        assert_eq!(snapshots[0].sha256, restored.sessions[0].digest.sha256);
        assert_eq!(
            hash,
            format!(
                "{}",
                hex::encode(Sha256::digest(serde_json::to_vec(&manifest).unwrap()))
            )
        );
        assert_eq!(
            fs::read(destination.path().join(ROLLOUT_NAME)).unwrap(),
            bytes
        );
    }

    #[test]
    fn rejects_a_manifest_changed_since_preview_before_staging_rollouts() {
        let stage = tempfile::tempdir().unwrap();
        let bytes = rollout();
        let mut manifest = fixture(&bytes);
        let hash = format!(
            "{}",
            hex::encode(Sha256::digest(serde_json::to_vec(&manifest).unwrap()))
        );
        manifest.sessions[0].title = "Different chat title".into();
        let package = make_archive(&manifest, &format!("rollouts/{ROLLOUT_NAME}"), &bytes);
        let error = read_package(package, stage.path(), Some(&hash)).unwrap_err();
        assert!(error.contains("changed after preview"), "{error}");
        assert_eq!(fs::read_dir(stage.path()).unwrap().count(), 0);
    }

    #[test]
    fn rejects_valid_zip_with_replaced_rollout_content() {
        let stage = tempfile::tempdir().unwrap();
        let bytes = rollout();
        let manifest = fixture(&bytes);
        let tampered = String::from_utf8(bytes)
            .unwrap()
            .replace("\"one\"", "\"two\"");
        let package = make_archive(
            &manifest,
            &format!("rollouts/{ROLLOUT_NAME}"),
            tampered.as_bytes(),
        );
        let error = read_package(package, stage.path(), None).unwrap_err();
        assert!(error.contains("SHA-256"), "{error}");
    }

    #[test]
    fn rejects_a_traversal_name_and_oversized_manifest_member() {
        let stage = tempfile::tempdir().unwrap();
        let bytes = rollout();
        let mut manifest = fixture(&bytes);
        manifest.sessions[0].rollout_name = format!("../{ROLLOUT_NAME}");
        let package = make_archive(&manifest, &format!("rollouts/../{ROLLOUT_NAME}"), &bytes);
        let error = read_package(package, stage.path(), None).unwrap_err();
        assert!(error.contains("Invalid rollout filename"), "{error}");

        manifest.sessions[0].rollout_name = ROLLOUT_NAME.into();
        manifest.sessions[0].digest.size = MAX_MEMBER_BYTES + 1;
        let package = make_archive(&manifest, &format!("rollouts/{ROLLOUT_NAME}"), &bytes);
        let error = read_package(package, stage.path(), None).unwrap_err();
        assert!(error.contains("expanded size limit"), "{error}");
        assert_eq!(fs::read_dir(stage.path()).unwrap().count(), 0);
    }

    #[test]
    fn rejects_duplicate_central_directory_members_hidden_by_name_index() {
        let stage = tempfile::tempdir().unwrap();
        let bytes = rollout();
        let original_name = format!("rollouts/{ROLLOUT_NAME}");
        let other_name = original_name.replace("000000000099", "000000000088");
        let mut writer = ZipWriter::new(tempfile::tempfile().unwrap());
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        writer.start_file(MANIFEST_FILE, options).unwrap();
        serde_json::to_writer(&mut writer, &fixture(&bytes)).unwrap();
        for name in [&original_name, &other_name] {
            writer.start_file(name, options).unwrap();
            writer.write_all(&bytes).unwrap();
        }
        let mut file = writer.finish().unwrap();
        file.rewind().unwrap();
        let mut raw = Vec::new();
        file.read_to_end(&mut raw).unwrap();
        let replacements: Vec<_> = raw
            .windows(other_name.len())
            .enumerate()
            .filter_map(|(offset, candidate)| {
                (candidate == other_name.as_bytes()).then_some(offset)
            })
            .collect();
        assert_eq!(replacements.len(), 2);
        for offset in replacements {
            raw[offset..offset + other_name.len()].copy_from_slice(original_name.as_bytes());
        }
        file.rewind().unwrap();
        file.write_all(&raw).unwrap();

        let error = read_package(file, stage.path(), None).unwrap_err();
        assert!(error.contains("duplicate members"), "{error}");
        assert_eq!(fs::read_dir(stage.path()).unwrap().count(), 0);
    }
}
