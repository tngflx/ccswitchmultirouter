use sha2::{Digest, Sha256};
use std::fs::{File, Metadata};
use std::io::ErrorKind;
use std::path::Path;
use std::time::SystemTime;

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    FileBasicInfo, FileIdInfo, GetFileInformationByHandleEx, FILE_BASIC_INFO, FILE_ID_INFO,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FileIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(windows)]
    volume_serial: u64,
    #[cfg(windows)]
    file_id: [u8; 16],
}

impl FileIdentity {
    #[cfg(unix)]
    pub(crate) fn from_file(_file: &File, metadata: &Metadata) -> Option<Self> {
        Some(Self::from_metadata(metadata))
    }

    #[cfg(unix)]
    fn from_metadata(metadata: &Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    }

    #[cfg(windows)]
    pub(crate) fn from_file(file: &File, _metadata: &Metadata) -> Option<Self> {
        let mut info = FILE_ID_INFO::default();
        // SAFETY: the file owns the handle, and the API receives a writable FILE_ID_INFO.
        let success = unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileIdInfo,
                std::ptr::addr_of_mut!(info).cast(),
                std::mem::size_of::<FILE_ID_INFO>() as u32,
            )
        } != 0;
        success.then_some(Self {
            volume_serial: info.VolumeSerialNumber,
            file_id: info.FileId.Identifier,
        })
    }

    #[cfg(not(any(unix, windows)))]
    pub(crate) fn from_file(_file: &File, _metadata: &Metadata) -> Option<Self> {
        None
    }
}

/// A cheap change detector for a file-backed projection. Validate again after
/// loading before publishing a cache entry, and skip caching if unavailable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FileRevision {
    identity: FileIdentity,
    length: u64,
    modified: SystemTime,
    changed: (i64, i64),
}

impl FileRevision {
    pub(crate) fn from_file(file: &File) -> Option<Self> {
        let metadata = file.metadata().ok()?;
        Self::from_file_metadata(file, &metadata)
    }

    #[cfg(unix)]
    pub(crate) fn from_file_metadata(_file: &File, metadata: &Metadata) -> Option<Self> {
        Self::from_metadata(metadata)
    }

    #[cfg(unix)]
    fn from_metadata(metadata: &Metadata) -> Option<Self> {
        Some(Self {
            identity: FileIdentity::from_metadata(metadata),
            length: metadata.len(),
            modified: metadata.modified().ok()?,
            changed: (metadata.ctime(), metadata.ctime_nsec()),
        })
    }

    #[cfg(not(unix))]
    pub(crate) fn from_file_metadata(file: &File, metadata: &Metadata) -> Option<Self> {
        Some(Self {
            identity: FileIdentity::from_file(file, metadata)?,
            length: metadata.len(),
            modified: metadata.modified().ok()?,
            changed: file_change_time(file, metadata)?,
        })
    }

    pub(crate) fn read(path: &Path) -> Option<Self> {
        Self::read_optional(path).flatten()
    }

    /// Return `Some(None)` when the path is absent and `None` when its
    /// revision cannot be established.
    #[cfg(unix)]
    pub(crate) fn read_optional(path: &Path) -> Option<Option<Self>> {
        // Closing a file descriptor can release SQLite's POSIX locks on the
        // same inode, even when SQLite opened a different descriptor.
        match std::fs::metadata(path) {
            Ok(metadata) => Self::from_metadata(&metadata).map(Some),
            Err(error) if error.kind() == ErrorKind::NotFound => Some(None),
            Err(_) => None,
        }
    }

    #[cfg(not(unix))]
    pub(crate) fn read_optional(path: &Path) -> Option<Option<Self>> {
        match File::open(path) {
            Ok(file) => Self::from_file(&file).map(Some),
            Err(error) if error.kind() == ErrorKind::NotFound => Some(None),
            Err(_) => None,
        }
    }

    /// Compact persistent stamp for a snapshot cursor.
    pub(crate) fn fingerprint(&self) -> i64 {
        let mut digest = Sha256::new();
        digest.update(b"file-revision-v1");
        digest.update(self.length.to_le_bytes());
        let modified = self
            .modified
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|duration| duration.as_nanos() as i128)
            .unwrap_or_else(|error| -(error.duration().as_nanos() as i128));
        digest.update(modified.to_le_bytes());
        digest.update(self.changed.0.to_le_bytes());
        digest.update(self.changed.1.to_le_bytes());
        #[cfg(unix)]
        {
            digest.update(self.identity.device.to_le_bytes());
            digest.update(self.identity.inode.to_le_bytes());
        }
        #[cfg(windows)]
        {
            digest.update(self.identity.volume_serial.to_le_bytes());
            digest.update(self.identity.file_id);
        }
        let digest = digest.finalize();
        i64::from_le_bytes(digest[..8].try_into().expect("SHA-256 has 32 bytes"))
    }
}

// The change time also advances for in-place rewrites that preserve size and
// restore the last-write timestamp.
#[cfg(windows)]
fn file_change_time(file: &File, _metadata: &Metadata) -> Option<(i64, i64)> {
    let mut info = FILE_BASIC_INFO::default();
    // SAFETY: the file owns the handle, and the API receives a writable FILE_BASIC_INFO.
    let success = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileBasicInfo,
            std::ptr::addr_of_mut!(info).cast(),
            std::mem::size_of::<FILE_BASIC_INFO>() as u32,
        )
    } != 0;
    (success && info.ChangeTime != 0).then_some((info.ChangeTime, 0))
}

#[cfg(not(any(unix, windows)))]
fn file_change_time(_file: &File, _metadata: &Metadata) -> Option<(i64, i64)> {
    None
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::os::fd::AsRawFd;

    #[test]
    fn file_revision_path_read_preserves_posix_locks() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("source.db");
        let file = File::create(&path).unwrap();
        let fd = file.as_raw_fd();
        // SAFETY: a zero-initialized flock represents a whole-file lock from SEEK_SET.
        let mut lock: libc::flock = unsafe { std::mem::zeroed() };
        lock.l_type = libc::F_WRLCK as libc::c_short;
        // SAFETY: fd remains open and lock points to a valid struct flock.
        assert_eq!(
            unsafe { libc::fcntl(fd, libc::F_SETLK, std::ptr::addr_of!(lock)) },
            0
        );

        let revision = FileRevision::from_file(&file).unwrap();
        assert_eq!(FileRevision::read(&path), Some(revision));

        // An open-file-description lock query can see POSIX locks held by
        // this process, which a regular F_GETLK query would ignore.
        lock.l_type = libc::F_WRLCK as libc::c_short;
        // SAFETY: fd remains open and lock points to writable struct flock data.
        assert_eq!(
            unsafe { libc::fcntl(fd, libc::F_OFD_GETLK, std::ptr::addr_of_mut!(lock)) },
            0
        );
        assert_eq!(lock.l_type, libc::F_WRLCK as libc::c_short);
    }
}
