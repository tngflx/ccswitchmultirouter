//! On-demand transport of explicitly selected, unarchived Codex chats.

mod archive;
mod history_db;
mod profile;
mod projection;
mod rollout;
mod state;

#[cfg(test)]
mod tests;

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use chrono::DateTime;
use rusqlite::{Connection, OpenFlags, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tempfile::{NamedTempFile, TempDir};

use self::archive::{rollout_name_parts, Manifest, MemberDigest, SessionEntry, PROJECTION_FILE};
use self::profile::{checked_file, Profile};
use self::projection::ProjectionScope;
use self::rollout::{is_session_id, HistoryBase, RolloutSnapshot};
use self::state::{ThreadCatalog, ThreadMetadata};

const BUSY_TIMEOUT: Duration = Duration::from_secs(3);
static BACKUP_JOB: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupItem {
    session_id: String,
    source_path: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreview {
    manifest_hash: String,
    sessions: Vec<PreviewSession>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewSession {
    session_id: String,
    title: String,
    project_path: Option<String>,
    conflict: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    restored: usize,
    skipped: usize,
}

pub(crate) fn export(target: &Path, items: &[BackupItem]) -> Result<ExportOutcome, String> {
    let _job = start_job()?;
    export_from(&Profile::current()?, target, items)
}

pub(crate) fn inspect(source: &Path) -> Result<BackupPreview, String> {
    let _job = start_job()?;
    inspect_for(&Profile::current()?, source)
}

pub(crate) fn import(source: &Path, manifest_hash: &str) -> Result<ImportOutcome, String> {
    let _job = start_job()?;
    import_into(&Profile::current()?, source, manifest_hash)
}

fn start_job() -> Result<MutexGuard<'static, ()>, String> {
    BACKUP_JOB
        .try_lock()
        .map_err(|_| "Another Codex chat backup or restore is in progress.".into())
}

fn io_error(action: &str, error: io::Error) -> String {
    format!("{action}: {error}")
}

fn open_catalog(
    profile: &Profile,
    writable: bool,
) -> Result<Option<(Connection, ThreadCatalog)>, String> {
    let Some(path) = profile.state_db.as_deref() else {
        return Ok(None);
    };
    let flags = if writable {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let conn = Connection::open_with_flags(path, flags)
        .map_err(|error| format!("Could not open the Codex chat catalog: {error}"))?;
    conn.busy_timeout(BUSY_TIMEOUT)
        .map_err(|error| format!("Could not configure the Codex chat catalog: {error}"))?;
    let catalog = ThreadCatalog::new(&conn)?;
    Ok(Some((conn, catalog)))
}

fn export_from(
    profile: &Profile,
    target: &Path,
    items: &[BackupItem],
) -> Result<ExportOutcome, String> {
    if items.is_empty() || items.len() > archive::MAX_SESSIONS {
        return Err(format!(
            "Select between 1 and {} Codex chats to back up.",
            archive::MAX_SESSIONS
        ));
    }
    let wanted = items
        .iter()
        .map(|item| item.session_id.as_str())
        .collect::<HashSet<_>>();
    if wanted.len() != items.len() || wanted.iter().any(|id| !is_session_id(id)) {
        return Err("Select each valid Codex chat only once.".into());
    }
    let parent = target
        .parent()
        .filter(|parent| target.is_absolute() && parent.is_dir());
    let Some(parent) = parent else {
        return Err("Choose a file in an existing backup folder.".into());
    };
    let directory = TempDir::new_in(parent)
        .map_err(|error| io_error("Could not stage the Codex backup", error))?;
    let catalog = open_catalog(profile, false)?;
    let titles = profile.index_titles()?;
    let mut total = 0u64;
    let mut sources = Vec::with_capacity(items.len());
    let mut sessions = Vec::with_capacity(items.len());
    let mut snapshots = Vec::with_capacity(items.len());
    let mut rollout_ids = HashSet::new();
    for item in items {
        let source = profile.active_path(&item.source_path)?;
        let name = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("The selected Codex rollout has an invalid filename.")?;
        let (date, rollout_id) = rollout_name_parts(name)?;
        if !rollout_ids.insert(rollout_id.to_owned()) {
            return Err("The selected chats contain a duplicate Codex rollout.".into());
        }
        let mut file = File::open(&source)
            .map_err(|error| io_error("Could not open the selected Codex chat", error))?;
        let size = file
            .metadata()
            .map_err(|error| io_error("Could not read the selected chat size", error))?
            .len();
        total = total.saturating_add(size);
        if size > archive::MAX_MEMBER_BYTES || total > archive::MAX_TOTAL_BYTES {
            return Err("The selected Codex chats exceed the backup size limit.".into());
        }
        let staged_path = directory.path().join(name);
        let mut staged = BufWriter::new(
            File::create(&staged_path)
                .map_err(|error| io_error("Could not stage a Codex rollout", error))?,
        );
        let mut snapshot =
            rollout::copy_rollout(&mut file, &mut staged, size, &item.session_id, true)?;
        staged
            .flush()
            .map_err(|error| io_error("Could not save the staged Codex rollout", error))?;

        let paginated = snapshot.header.paginated;
        let registered = catalog
            .as_ref()
            .map(|(conn, schema)| schema.read_active(conn, &item.session_id, &source, paginated))
            .transpose()?
            .flatten();
        if paginated && registered.is_none() {
            return Err(format!(
                "Chat {} is missing its Codex catalog row. Open the chat in Codex and retry.",
                item.session_id
            ));
        }
        let project_path = registered
            .as_ref()
            .map(ThreadMetadata::cwd)
            .filter(|cwd| !cwd.is_empty())
            .or_else(|| {
                snapshot
                    .header
                    .payload
                    .get("cwd")
                    .and_then(serde_json::Value::as_str)
            })
            .filter(|cwd| !cwd.is_empty())
            .map(str::to_string);
        let title = registered
            .as_ref()
            .map(ThreadMetadata::title)
            .filter(|title| !title.is_empty())
            .or_else(|| titles.get(&item.session_id).map(String::as_str))
            .unwrap_or(&item.session_id)
            .to_owned();
        let updated_at_ms = registered
            .as_ref()
            .map(ThreadMetadata::updated_at_ms)
            .filter(|time| *time != 0)
            .or_else(|| {
                snapshot
                    .header
                    .timestamp
                    .as_deref()
                    .and_then(|time| DateTime::parse_from_rfc3339(time).ok())
                    .map(|time| time.timestamp_millis())
            })
            .unwrap_or_else(|| date.and_utc().timestamp_millis());
        let metadata = registered.unwrap_or_else(|| {
            ThreadMetadata::legacy_from_rollout(&snapshot.header, &title, updated_at_ms)
        });
        sessions.push(SessionEntry {
            session_id: item.session_id.clone(),
            rollout_name: name.to_owned(),
            title,
            project_path,
            updated_at_ms,
            paginated,
            metadata,
            digest: MemberDigest {
                size: snapshot.size,
                sha256: snapshot.sha256.clone(),
            },
        });
        // The lineage and checksums are enough once native metadata has been picked.
        snapshot.header.payload = serde_json::Value::Null;
        snapshots.push(snapshot);
        sources.push(source);
    }

    let plan = Lineage::verify(&sessions, &snapshots, directory.path())?;
    let scopes = plan.projection_scopes(&sessions, &snapshots)?;
    let projection_digest = if scopes.is_empty() {
        None
    } else {
        let path = profile
            .history_db
            .as_deref()
            .ok_or("Codex has no paginated history database for the selected chats.")?;
        let staged_path = directory.path().join(PROJECTION_FILE);
        let mut staged = BufWriter::new(
            File::create(&staged_path)
                .map_err(|error| io_error("Could not stage Codex paginated history", error))?,
        );
        projection::export_projection(path, &scopes, &mut staged)?;
        staged
            .flush()
            .map_err(|error| io_error("Could not save staged Codex paginated history", error))?;
        let size = fs::metadata(&staged_path)
            .map_err(|error| io_error("Could not read the staged history size", error))?
            .len();
        if size > archive::MAX_MEMBER_BYTES || total.saturating_add(size) > archive::MAX_TOTAL_BYTES
        {
            return Err("The selected Codex chats exceed the backup size limit.".into());
        }
        Some(MemberDigest {
            size,
            sha256: hash_prefix(&staged_path, size)?,
        })
    };
    let manifest = Manifest::new(sessions, projection_digest);
    let mut packaged = NamedTempFile::new_in(parent)
        .map_err(|error| io_error("Could not create the Codex backup", error))?;
    archive::write_package(packaged.as_file_mut(), &manifest, directory.path())?;
    packaged
        .as_file()
        .sync_all()
        .map_err(|error| io_error("Could not sync the Codex backup", error))?;

    // Codex can append during export. Recheck the saved bytes and both sources of
    // archival status before exposing the package at the chosen filename.
    for (entry, source) in manifest.sessions.iter().zip(&sources) {
        if hash_prefix(source, entry.digest.size)? != entry.digest.sha256 {
            return Err(format!(
                "Chat {} changed during backup. Refresh the list and retry.",
                entry.session_id
            ));
        }
    }
    let mut archive_ids = wanted;
    archive_ids.extend(plan.rollout_ids.iter().map(String::as_str));
    if !profile.occupied_rollout_ids(&archive_ids, true)?.is_empty() {
        return Err(
            "A selected chat was archived. Refresh the list and select its active chats again."
                .into(),
        );
    }
    for (entry, source) in manifest.sessions.iter().zip(&sources) {
        profile.active_path(source)?;
        if let Some((conn, schema)) = &catalog {
            let current = schema.read_active(conn, &entry.session_id, source, entry.paginated)?;
            if entry.paginated && current.is_none() {
                return Err(
                    "A selected chat changed during backup. Refresh the list and retry.".into(),
                );
            }
        }
    }
    packaged.persist_noclobber(target).map_err(|error| {
        io_error(
            "Could not publish the backup. Choose a new filename if it already exists",
            error.error,
        )
    })?;
    Ok(ExportOutcome {
        count: manifest.sessions.len(),
    })
}

fn hash_prefix(path: &Path, size: u64) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|error| io_error("Could not open saved Codex data for verification", error))?;
    let mut hash = Sha256::new();
    let mut remaining = size;
    let mut buffer = [0u8; 64 * 1024];
    let mut copied = 0u64;
    while remaining > 0 {
        let limit = remaining.min(buffer.len() as u64) as usize;
        let count = file
            .read(&mut buffer[..limit])
            .map_err(|error| io_error("Could not verify saved Codex data", error))?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
        copied += count as u64;
        remaining -= count as u64;
    }
    if copied != size {
        return Err("Saved Codex data became shorter during backup. Refresh and retry.".into());
    }
    Ok(hex::encode(hash.finalize()))
}

struct Lineage {
    rollout_ids: Vec<String>,
    parents: Vec<Option<usize>>,
    order: Vec<usize>,
}

impl Lineage {
    fn verify(
        entries: &[SessionEntry],
        snapshots: &[RolloutSnapshot],
        stage: &Path,
    ) -> Result<Self, String> {
        let rollout_ids = entries
            .iter()
            .map(|entry| rollout_name_parts(&entry.rollout_name).map(|(_, id)| id.to_owned()))
            .collect::<Result<Vec<_>, _>>()?;
        let indices = rollout_ids
            .iter()
            .enumerate()
            .map(|(index, id)| (id.as_str(), index))
            .collect::<HashMap<_, _>>();
        let mut parents = vec![None; entries.len()];
        let mut children = vec![Vec::new(); entries.len()];
        let mut cutoffs: HashMap<usize, Vec<&HistoryBase>> = HashMap::new();
        let mut order = Vec::with_capacity(entries.len());
        for (index, snapshot) in snapshots.iter().enumerate() {
            if let Some(base) = &snapshot.header.base {
                let parent = *indices.get(base.thread_id.as_str()).ok_or_else(|| {
                    format!("Chat {} needs the saved parent rollout {}. Include its unarchived parent in the backup.", entries[index].session_id, base.thread_id)
                })?;
                if !entries[parent].paginated {
                    return Err(
                        "A Codex fork references a parent with an incompatible history format."
                            .into(),
                    );
                }
                parents[index] = Some(parent);
                children[parent].push(index);
                cutoffs.entry(parent).or_default().push(base);
            } else {
                order.push(index);
            }
        }
        let mut next = 0;
        while let Some(&parent) = order.get(next) {
            order.extend_from_slice(&children[parent]);
            next += 1;
        }
        if order.len() != entries.len() {
            return Err("The Codex backup contains circular inherited chat history.".into());
        }
        for (parent, cutoffs) in cutoffs {
            let mut file =
                File::open(stage.join(&entries[parent].rollout_name)).map_err(|error| {
                    io_error("Could not open the staged Codex parent rollout", error)
                })?;
            rollout::validate_history_boundaries(&mut file, snapshots[parent].size, &cutoffs)?;
        }
        Ok(Self {
            rollout_ids,
            parents,
            order,
        })
    }

    fn projection_scopes<'a>(
        &'a self,
        entries: &[SessionEntry],
        snapshots: &[RolloutSnapshot],
    ) -> Result<Vec<ProjectionScope<'a>>, String> {
        entries
            .iter()
            .zip(snapshots)
            .zip(&self.rollout_ids)
            .filter(|((entry, _), _)| entry.paginated)
            .map(|((_, snapshot), id)| {
                Ok(ProjectionScope {
                    rollout_id: id,
                    size: snapshot.size,
                    end_ordinal_exclusive: snapshot
                        .end_ordinal_exclusive
                        .ok_or("A paginated chat lacks a complete Codex history ordinal.")?,
                })
            })
            .collect()
    }
}

struct StagedBackup {
    directory: TempDir,
    manifest: Manifest,
    hash: String,
    snapshots: Vec<RolloutSnapshot>,
    lineage: Lineage,
}

impl StagedBackup {
    fn open(source: &Path, expected_hash: Option<&str>) -> Result<Self, String> {
        let file = File::open(source)
            .map_err(|error| io_error("Could not open the Codex backup", error))?;
        let directory = TempDir::new()
            .map_err(|error| io_error("Could not stage the selected backup", error))?;
        let (manifest, hash, snapshots) =
            archive::read_package(file, directory.path(), expected_hash)?;
        let lineage = Lineage::verify(&manifest.sessions, &snapshots, directory.path())?;
        let scopes = lineage.projection_scopes(&manifest.sessions, &snapshots)?;
        match (manifest.projection.is_some(), scopes.is_empty()) {
            (true, false) => {
                projection::validate_projection(&mut open_projection(directory.path())?, &scopes)?;
            }
            (false, true) => {}
            _ => return Err("The Codex backup has inconsistent paginated history.".into()),
        }
        Ok(Self {
            directory,
            manifest,
            hash,
            snapshots,
            lineage,
        })
    }

    fn conflicts(
        &self,
        profile: &Profile,
        catalog: Option<(&Connection, &ThreadCatalog)>,
    ) -> Result<Vec<bool>, String> {
        let sessions = &self.manifest.sessions;
        let mut wanted = sessions
            .iter()
            .map(|entry| entry.session_id.as_str())
            .collect::<HashSet<_>>();
        wanted.extend(self.lineage.rollout_ids.iter().map(String::as_str));
        let occupied_files = profile.occupied_rollout_ids(&wanted, false)?;
        let occupied_threads = if let Some((conn, schema)) = catalog {
            schema.occupied_ids(conn, sessions.iter().map(|entry| entry.session_id.as_str()))?
        } else {
            BTreeSet::new()
        };
        let mut conflicts = vec![false; sessions.len()];
        for &index in &self.lineage.order {
            let entry = &sessions[index];
            let destination = profile.destination_path(&entry.rollout_name, false)?;
            let destination_exists = destination.symlink_metadata().is_ok();
            conflicts[index] = occupied_threads.contains(&entry.session_id)
                || occupied_files.contains(&entry.session_id)
                || occupied_files.contains(&self.lineage.rollout_ids[index])
                || destination_exists
                || self.lineage.parents[index].is_some_and(|parent| conflicts[parent]);
        }
        Ok(conflicts)
    }
}

fn open_projection(directory: &Path) -> Result<BufReader<File>, String> {
    File::open(directory.join(PROJECTION_FILE))
        .map(BufReader::new)
        .map_err(|error| io_error("Could not open the verified Codex paginated history", error))
}

fn inspect_for(profile: &Profile, source: &Path) -> Result<BackupPreview, String> {
    let staged = StagedBackup::open(source, None)?;
    let catalog = open_catalog(profile, false)?;
    let conflicts = staged.conflicts(
        profile,
        catalog.as_ref().map(|(conn, schema)| (conn, schema)),
    )?;
    let sessions = staged
        .manifest
        .sessions
        .into_iter()
        .zip(conflicts)
        .map(|(entry, conflict)| PreviewSession {
            session_id: entry.session_id,
            title: entry.title,
            project_path: entry.project_path,
            conflict,
        })
        .collect();
    Ok(BackupPreview {
        manifest_hash: staged.hash,
        sessions,
    })
}

fn attach_history(conn: &Connection, profile: &Profile) -> Result<(), String> {
    let path = profile.history_path_for_restore()?;
    if !checked_file(&path)? {
        let parent = path.parent().ok_or("Invalid Codex history directory.")?;
        let stage = NamedTempFile::new_in(parent).map_err(|error| {
            io_error(
                "Could not stage the destination Codex history database",
                error,
            )
        })?;
        history_db::initialize(stage.path())?;
        match stage.persist_noclobber(&path) {
            Ok(_) => {}
            Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(io_error(
                    "Could not install the Codex history database",
                    error.error,
                ))
            }
        }
    }
    // Codex may create the file between the existence check and the no-clobber install.
    if !checked_file(&path)? {
        return Err("The destination Codex history database disappeared during restore.".into());
    }
    let path = path
        .to_str()
        .ok_or("Invalid path for the Codex history database.")?;
    conn.execute("ATTACH DATABASE ?1 AS backup_history", [path])
        .map_err(|error| {
            format!("Could not open the destination Codex paginated history: {error}")
        })?;
    Ok(())
}

fn import_into(
    profile: &Profile,
    source: &Path,
    expected_hash: &str,
) -> Result<ImportOutcome, String> {
    let staged = StagedBackup::open(source, Some(expected_hash))?;
    let mut catalog = open_catalog(profile, true)?;
    let mut files = InstalledRollouts::default();
    let restored = match catalog.as_mut() {
        Some((conn, schema)) => {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| {
                    format!("Could not reserve the Codex chat catalog for restore: {error}")
                })?;
            let conflicts = staged.conflicts(profile, Some((&tx, schema)))?;
            let selected = staged
                .lineage
                .order
                .iter()
                .copied()
                .filter(|&i| !conflicts[i])
                .collect::<Vec<_>>();
            let projection_ids = selected
                .iter()
                .filter(|&&i| staged.manifest.sessions[i].paginated)
                .map(|&i| staged.lineage.rollout_ids[i].clone())
                .collect::<HashSet<_>>();
            if !projection_ids.is_empty() {
                attach_history(&tx, profile)?;
                let scopes = staged
                    .lineage
                    .projection_scopes(&staged.manifest.sessions, &staged.snapshots)?;
                projection::restore_projection(
                    &tx,
                    &mut open_projection(staged.directory.path())?,
                    &scopes,
                    &projection_ids,
                )?;
            }
            for &index in &selected {
                let entry = &staged.manifest.sessions[index];
                let destination = profile.destination_path(&entry.rollout_name, true)?;
                schema.insert_thread(
                    &tx,
                    &entry.session_id,
                    &destination,
                    &entry.metadata,
                    entry.paginated,
                )?;
                files.install(
                    &staged.directory.path().join(&entry.rollout_name),
                    &destination,
                )?;
            }
            tx.commit()
                .map_err(|error| format!("Could not commit the restored Codex chats: {error}"))?;
            selected
        }
        None => {
            let conflicts = staged.conflicts(profile, None)?;
            let selected = staged
                .lineage
                .order
                .iter()
                .copied()
                .filter(|&i| !conflicts[i])
                .collect::<Vec<_>>();
            if selected
                .iter()
                .any(|&i| staged.manifest.sessions[i].paginated)
            {
                return Err("Open Codex once to initialize its chat catalog before restoring paginated chats.".into());
            }
            for &index in &selected {
                let entry = &staged.manifest.sessions[index];
                let destination = profile.destination_path(&entry.rollout_name, true)?;
                files.install(
                    &staged.directory.path().join(&entry.rollout_name),
                    &destination,
                )?;
            }
            selected
        }
    };
    files.commit();
    if !restored.is_empty() {
        if let Err(error) =
            profile.append_index(restored.iter().map(|&i| &staged.manifest.sessions[i]))
        {
            // The native DB and rollouts are canonical. The name index is a fallback.
            log::warn!("Could not update the Codex session name index after restore: {error}");
        }
    }
    Ok(ImportOutcome {
        restored: restored.len(),
        skipped: staged.manifest.sessions.len() - restored.len(),
    })
}

#[derive(Default)]
struct InstalledRollouts {
    paths: Vec<PathBuf>,
}

impl InstalledRollouts {
    fn install(&mut self, staged: &Path, destination: &Path) -> Result<(), String> {
        match fs::hard_link(staged, destination) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return Err(
                    "A Codex rollout appeared during restore. Review the backup again.".into(),
                );
            }
            Err(_) => {
                let mut source = File::open(staged)
                    .map_err(|error| io_error("Could not open the staged Codex rollout", error))?;
                let parent = destination
                    .parent()
                    .ok_or("Invalid Codex rollout directory.")?;
                let mut local = NamedTempFile::new_in(parent).map_err(|error| {
                    io_error(
                        "Could not stage the rollout in the destination profile",
                        error,
                    )
                })?;
                io::copy(&mut source, local.as_file_mut()).map_err(|error| {
                    io_error("Could not copy the verified Codex rollout", error)
                })?;
                local.as_file().sync_all().map_err(|error| {
                    io_error("Could not sync the restored Codex rollout", error)
                })?;
                local.persist_noclobber(destination).map_err(|error| {
                    io_error("Could not install the Codex rollout", error.error)
                })?;
            }
        }
        self.paths.push(destination.to_path_buf());
        Ok(())
    }

    fn commit(mut self) {
        self.paths.clear();
    }
}

impl Drop for InstalledRollouts {
    fn drop(&mut self) {
        for path in &self.paths {
            if let Err(error) = fs::remove_file(path) {
                log::warn!("Could not roll back a staged Codex rollout: {error}");
            }
        }
    }
}
