use std::collections::{HashMap, HashSet};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

use chrono::{DateTime, Datelike, SecondsFormat};
use serde::{Deserialize, Serialize};

use super::archive::{rollout_name_parts, SessionEntry};
use super::io_error;
use crate::codex_config::{get_codex_config_dir, read_codex_config_text};
use crate::codex_state_db::resolve_active_codex_state_db_path;

const ACTIVE: &str = "sessions";
const ARCHIVED: &str = "archived_sessions";
const INDEX: &str = "session_index.jsonl";

pub(super) struct Profile {
    pub(super) home: PathBuf,
    pub(super) state_db: Option<PathBuf>,
    pub(super) history_db: Option<PathBuf>,
}

impl Profile {
    pub(super) fn current() -> Result<Self, String> {
        let config = read_codex_config_text().map_err(|error| error.to_string())?;
        Self::from_root(get_codex_config_dir(), &config)
    }

    pub(super) fn from_root(home: PathBuf, config_text: &str) -> Result<Self, String> {
        if !home.is_absolute() || home.components().any(|part| part == Component::ParentDir) {
            return Err("The configured Codex profile must use an absolute directory path.".into());
        }
        checked_directory(&home, false)?;
        let state_db = resolve_active_codex_state_db_path(&home, config_text);
        if let Some(path) = &state_db {
            checked_file(path)?;
        }
        let sqlite_dir = state_db.as_deref().and_then(Path::parent);
        let history_db = sqlite_dir
            .filter(|path| *path != home)
            .and_then(latest_history_db)
            .or_else(|| latest_history_db(&home));
        Ok(Self {
            home,
            state_db,
            history_db,
        })
    }

    pub(super) fn active_path(&self, source: &Path) -> Result<PathBuf, String> {
        let missing = || "Select an existing Codex chat in the active sessions folder.".to_owned();
        if !checked_directory(&self.home, false)? {
            return Err(missing());
        }
        let root = self.home.join(ACTIVE);
        if !checked_directory(&root, false)? {
            return Err(missing());
        }
        let canonical_root = root.canonicalize().map_err(|error| {
            io_error("Could not resolve the active Codex sessions folder", error)
        })?;
        let relative = source
            .strip_prefix(&root)
            .or_else(|_| source.strip_prefix(&canonical_root))
            .map_err(|_| missing())?;
        let mut components = relative.components().peekable();
        let mut path = root;
        while let Some(component) = components.next() {
            let Component::Normal(name) = component else {
                return Err(missing());
            };
            path.push(name);
            if components.peek().is_some() && !checked_directory(&path, false)? {
                return Err(missing());
            }
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") || !checked_file(&path)? {
            return Err(missing());
        }
        let expected = canonical_root.join(relative);
        let canonical = path
            .canonicalize()
            .map_err(|error| io_error("Could not resolve the selected Codex chat", error))?;
        if canonical != expected {
            return Err(missing());
        }
        Ok(canonical)
    }

    pub(super) fn history_path_for_restore(&self) -> PathBuf {
        self.history_db
            .clone()
            .unwrap_or_else(|| self.home.join("thread_history.sqlite"))
    }

    pub(super) fn occupied_rollout_ids(
        &self,
        wanted: &HashSet<&str>,
        archived_only: bool,
    ) -> Result<HashSet<String>, String> {
        let mut found = HashSet::new();
        if wanted.is_empty() || !checked_directory(&self.home, false)? {
            return Ok(found);
        }
        let archived = self.home.join(ARCHIVED);
        let mut directories = vec![archived];
        if !archived_only {
            directories.push(self.home.join(ACTIVE));
        }
        while let Some(directory) = directories.pop() {
            if !checked_directory(&directory, false)? {
                continue;
            }
            let entries = fs::read_dir(directory)
                .map_err(|error| io_error("Could not list Codex session files", error))?;
            for entry in entries {
                let entry = entry
                    .map_err(|error| io_error("Could not list a Codex session file", error))?;
                let metadata = entry
                    .metadata()
                    .map_err(|error| io_error("Could not inspect a Codex session path", error))?;
                if is_link(&metadata) {
                    continue;
                }
                if metadata.is_dir() {
                    directories.push(entry.path());
                } else if metadata.is_file() {
                    let filename = entry.file_name();
                    if let Some(id) = filename
                        .to_str()
                        .and_then(|name| wanted_rollout_id(name, wanted))
                    {
                        found.insert(id.to_owned());
                        if found.len() == wanted.len() {
                            return Ok(found);
                        }
                    }
                }
            }
        }
        Ok(found)
    }

    pub(super) fn destination_path(
        &self,
        name: &str,
        create_dirs: bool,
    ) -> Result<PathBuf, String> {
        let (date, _) = rollout_name_parts(name)?;
        let mut path = self.home.clone();
        if create_dirs && metadata(&path)?.is_none() {
            fs::create_dir_all(&path)
                .map_err(|error| io_error("Could not create the Codex profile directory", error))?;
        }
        checked_directory(&path, false)?;
        for component in [
            ACTIVE.to_owned(),
            format!("{:04}", date.year()),
            format!("{:02}", date.month()),
            format!("{:02}", date.day()),
        ] {
            path.push(component);
            checked_directory(&path, create_dirs)?;
        }
        Ok(path.join(name))
    }

    pub(super) fn index_titles(&self) -> Result<HashMap<String, String>, String> {
        let path = self.home.join(INDEX);
        let mut titles = HashMap::new();
        if !checked_directory(&self.home, false)? || !checked_file(&path)? {
            return Ok(titles);
        }
        let file = File::open(path)
            .map_err(|error| io_error("Could not open the Codex chat name index", error))?;
        for line in BufReader::new(file).split(b'\n') {
            let line =
                line.map_err(|error| io_error("Could not read the Codex chat name index", error))?;
            if let Ok(entry) = serde_json::from_slice::<IndexTitle>(&line) {
                let id = entry.id.trim();
                let title = entry.thread_name.trim();
                if !id.is_empty() && !title.is_empty() {
                    titles.insert(id.to_owned(), title.to_owned());
                }
            }
        }
        Ok(titles)
    }

    pub(super) fn append_index<'a>(
        &self,
        sessions: impl IntoIterator<Item = &'a SessionEntry>,
    ) -> Result<(), String> {
        let mut records = Vec::new();
        for entry in sessions {
            let updated_at = DateTime::from_timestamp_millis(entry.updated_at_ms)
                .ok_or("The restored Codex chat has an invalid update timestamp.")?
                .to_rfc3339_opts(SecondsFormat::Millis, true);
            serde_json::to_writer(
                &mut records,
                &IndexRecord {
                    id: &entry.session_id,
                    thread_name: &entry.title,
                    updated_at: &updated_at,
                },
            )
            .map_err(|error| format!("Could not encode the restored chat name: {error}"))?;
            records.push(b'\n');
        }
        if records.is_empty() {
            return Ok(());
        }
        checked_directory(&self.home, false)?;
        let path = self.home.join(INDEX);
        checked_file(&path)?;
        append_records(&path, &records)
            .map_err(|error| io_error("Could not append to the Codex chat name index", error))
    }
}

#[derive(Deserialize)]
struct IndexTitle {
    id: String,
    thread_name: String,
}

#[derive(Serialize)]
struct IndexRecord<'a> {
    id: &'a str,
    thread_name: &'a str,
    updated_at: &'a str,
}

fn append_records(path: &Path, records: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .read(true)
        .append(true)
        .create(true)
        .open(path)?;
    if file.metadata()?.len() > 0 {
        let mut last_byte = [0];
        file.seek(SeekFrom::End(-1))?;
        file.read_exact(&mut last_byte)?;
        if last_byte[0] != b'\n' {
            file.write_all(b"\n")?;
        }
    }
    file.write_all(records)
}

fn latest_history_db(directory: &Path) -> Option<PathBuf> {
    fs::read_dir(directory)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            let version = name
                .to_str()?
                .strip_prefix("thread_history_")?
                .strip_suffix(".sqlite")?
                .parse::<u64>()
                .ok()?;
            let metadata = entry.metadata().ok()?;
            (metadata.is_file() && !is_link(&metadata)).then(|| (version, entry.path()))
        })
        .max_by_key(|(version, _)| *version)
        .map(|(_, path)| path)
}

fn wanted_rollout_id<'a>(name: &'a str, wanted: &HashSet<&str>) -> Option<&'a str> {
    let body = name.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    if body.len() != 56 || !wanted.contains(body.get(20..)?) {
        return None;
    }
    rollout_name_parts(name).ok().map(|(_, id)| id)
}

fn metadata(path: &Path) -> Result<Option<Metadata>, String> {
    match path.symlink_metadata() {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error("Could not inspect a Codex profile path", error)),
    }
}

fn checked_directory(path: &Path, create: bool) -> Result<bool, String> {
    let mut entry = metadata(path)?;
    if create && entry.is_none() {
        match fs::create_dir(path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(io_error("Could not create a Codex sessions folder", error)),
        }
        entry = metadata(path)?;
    }
    match entry {
        Some(metadata) if metadata.is_dir() && !is_link(&metadata) => Ok(true),
        Some(_) => Err("A Codex profile directory is a link or is not a directory.".into()),
        None => Ok(false),
    }
}

fn checked_file(path: &Path) -> Result<bool, String> {
    match metadata(path)? {
        Some(metadata) if metadata.is_file() && !is_link(&metadata) => Ok(true),
        Some(_) => Err("A Codex profile file is a link or is not a regular file.".into()),
        None => Ok(false),
    }
}

#[cfg(windows)]
fn is_link(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "019cc369-bd7c-7891-b371-7b20b4fe0b18";
    const OTHER_ID: &str = "019cc369-bd7c-7891-b371-7b20b4fe0b19";
    const NAME: &str = "rollout-2026-03-06T21-50-12-019cc369-bd7c-7891-b371-7b20b4fe0b18.jsonl";

    fn profile(home: PathBuf) -> Profile {
        let sqlite_home = serde_json::to_string(&home).unwrap();
        Profile::from_root(home, &format!("sqlite_home = {sqlite_home}")).unwrap()
    }

    #[test]
    fn chooses_native_destination_and_rejects_archived_sources() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join(".codex");
        let profile = profile(home.clone());
        let expected = home
            .join("sessions")
            .join("2026")
            .join("03")
            .join("06")
            .join(NAME);
        assert_eq!(profile.destination_path(NAME, false).unwrap(), expected);
        assert!(!home.exists());
        let active = profile.destination_path(NAME, true).unwrap();
        fs::write(&active, "active").unwrap();
        let canonical = active.canonicalize().unwrap();
        assert_eq!(profile.active_path(&active).unwrap(), canonical);
        assert_eq!(profile.active_path(&canonical).unwrap(), canonical);

        let archived = home.join(ARCHIVED);
        fs::create_dir(&archived).unwrap();
        let archived = archived.join(NAME);
        fs::write(&archived, "archived").unwrap();
        assert!(profile.active_path(&archived).is_err());
        assert!(profile.destination_path("../archive.jsonl", true).is_err());
    }

    #[test]
    fn detects_duplicate_rollout_ids_without_reading_histories() {
        let temp = tempfile::tempdir().unwrap();
        let profile = profile(temp.path().to_path_buf());
        let active = profile.destination_path(NAME, true).unwrap();
        File::create(&active).unwrap().set_len(1024 * 1024).unwrap();

        let archived = temp.path().join(ARCHIVED);
        fs::create_dir(&archived).unwrap();
        let duplicate = NAME.replace("2026-03-06", "2024-01-10");
        fs::write(archived.join(duplicate), [0xff]).unwrap();
        let other_name = NAME.replace(ID, OTHER_ID);
        fs::write(active.with_file_name(other_name), []).unwrap();
        let wanted = HashSet::from([ID, OTHER_ID]);
        assert_eq!(
            profile.occupied_rollout_ids(&wanted, true).unwrap(),
            HashSet::from([ID.to_owned()])
        );
        assert_eq!(
            profile.occupied_rollout_ids(&wanted, false).unwrap(),
            HashSet::from([ID.to_owned(), OTHER_ID.to_owned()])
        );
    }

    #[test]
    fn excludes_linked_directories_from_lookup_and_restore() {
        let temp = tempfile::tempdir().unwrap();
        let profile = profile(temp.path().join(".codex"));
        let external = temp.path().join("external");
        fs::create_dir(&external).unwrap();
        fs::write(external.join(NAME), "outside").unwrap();
        let active = profile.home.join(ACTIVE);
        fs::create_dir_all(&active).unwrap();
        let linked = active.join("2026");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&external, &linked).unwrap();
        #[cfg(windows)]
        if let Err(error) = std::os::windows::fs::symlink_dir(&external, &linked) {
            if error.raw_os_error() == Some(1314) {
                return;
            }
            panic!("Could not create test symlink: {error}");
        }
        assert!(profile.active_path(&linked.join(NAME)).is_err());
        assert!(profile.destination_path(NAME, false).is_err());
        assert!(profile.destination_path(NAME, true).is_err());
        assert!(profile
            .occupied_rollout_ids(&HashSet::from([ID]), false)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn appending_chat_titles_preserves_existing_index_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let profile = profile(temp.path().to_path_buf());
        let path = temp.path().join(INDEX);
        let old = format!("invalid line\n{{\"id\":\"{ID}\",\"thread_name\":\"Existing\"}}");
        let record = format!("{{\"id\":\"{OTHER_ID}\",\"thread_name\":\"Restored\",\"updated_at\":\"2026-03-06T21:50:12.000Z\"}}\n");
        fs::write(&path, &old).unwrap();
        append_records(&path, record.as_bytes()).unwrap();
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            format!("{old}\n{record}")
        );
        assert_eq!(
            profile.index_titles().unwrap(),
            HashMap::from([
                (ID.to_owned(), "Existing".to_owned()),
                (OTHER_ID.to_owned(), "Restored".to_owned())
            ])
        );
    }

    #[test]
    fn prefers_latest_numbered_history_beside_configured_state() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let sqlite = temp.path().join("sqlite");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&sqlite).unwrap();
        fs::write(home.join("thread_history_90.sqlite"), []).unwrap();
        for name in [
            "state_5.sqlite",
            "thread_history_2.sqlite",
            "thread_history_10.sqlite",
            "thread_history_99.sqlite-wal",
        ] {
            fs::write(sqlite.join(name), []).unwrap();
        }
        fs::create_dir(sqlite.join("thread_history_99.sqlite")).unwrap();
        let sqlite_home = serde_json::to_string(&sqlite).unwrap();
        let profile = Profile::from_root(home, &format!("sqlite_home = {sqlite_home}")).unwrap();
        assert_eq!(profile.state_db, Some(sqlite.join("state_5.sqlite")));
        assert_eq!(
            profile.history_db,
            Some(sqlite.join("thread_history_10.sqlite"))
        );
    }
}
