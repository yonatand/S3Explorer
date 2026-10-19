//! The local computer as a pane source (v0.9.0, "Pane sources" in `docs/CONTRACT.md`): roots,
//! bounded directory listings, new folder, rename, move to the recycle bin and a bounded size count.
//!
//! Free of Tauri types and blocking: the command layer (`commands/local.rs`) runs every function
//! here on a blocking thread.
//!
//! Rules (data safety):
//! - Only absolute paths with a drive letter or a UNC share (Windows, v0.9.1: `\\server\share[\…]`
//!   or `//server/share`) or a leading `/`; no `..` component. Device paths (`\\.\`, `\\?\`) and
//!   `\\server` without a share are `InvalidInput`.
//! - A listing or size scan on a UNC path that reads no entry for [`NETWORK_STALL`] fails `Io`
//!   ("network location did not respond") instead of hanging.
//! - Links (symbolic links, junctions) are never followed: listed as links, never listed into,
//!   never counted into, renamed and trashed as the link itself.
//! - Nothing here deletes permanently: `trash_paths` only moves to the recycle bin / trash, and on
//!   Windows refuses drives that have no recycle bin (anything but a fixed disk) and every UNC path.
//! - Nothing here replaces an existing file or folder.

use std::collections::VecDeque;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

use crate::batches::localname::{fold_with, sanitize_segment};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::search::SearchRegistry;

/// Most entries one `list_local_dir` returns (`LOCAL_LIMITS.maxEntries`).
pub const LOCAL_MAX_ENTRIES: usize = 50_000;
/// Most entries one `local_dir_size` looks at (`LOCAL_LIMITS.dirSizeMaxEntries`).
pub const LOCAL_DIR_SIZE_MAX_ENTRIES: u64 = 200_000;
/// How many listed directories `open_local` remembers (most recent kept).
pub const LISTED_DIRS_MAX: usize = 1_000;
/// Most paths one `trash_local` call takes (same bound as a job's items).
pub const TRASH_MAX_PATHS: usize = crate::models::JOB_MAX_ITEMS;
/// `local_dir_size` scans that run at once; more wait for a slot (still cancellable).
pub const LOCAL_DIR_SIZE_PARALLEL: usize = 4;
/// Most roots `list_local_roots` returns.
const ROOTS_MAX: usize = 64;
/// v0.9.1: a listing or size scan of a network location, or resolving the saved Network Locations,
/// fails after this long without progress.
pub const NETWORK_STALL: Duration = Duration::from_secs(15);
/// The message of that failure (`Io`).
pub const NETWORK_STALL_MESSAGE: &str = "network location did not respond";
/// The per-path failure of `trash_local` for a UNC path.
pub const NO_NETWORK_TRASH: &str = "no recycle bin on a network location; delete it in the file manager";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LocalRootKind {
    Drive,
    Home,
    Folder,
    /// v0.9.1: a saved Network Location (Windows), resolved to its UNC target.
    Network,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalRoot {
    pub path: String,
    pub label: String,
    pub kind: LocalRootKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    pub name: String,
    /// The listed directory joined with the name, as the OS returns it.
    pub path: String,
    pub is_dir: bool,
    /// 0 for directories and links.
    pub size: u64,
    /// RFC 3339, `None` when the OS does not tell.
    pub modified: Option<String>,
    /// The entry itself is a symbolic link or junction (never followed; listed with the files).
    pub is_symlink: bool,
    pub hidden: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalListing {
    pub dirs: Vec<LocalEntry>,
    pub files: Vec<LocalEntry>,
    pub truncated: bool,
    pub parent: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashFailure {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashResult {
    pub trashed: u64,
    pub failed: Vec<TrashFailure>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalDirSize {
    pub files: u64,
    pub bytes: u64,
    pub truncated: bool,
}

fn io_error(what: &str, path: &str, e: &std::io::Error) -> AppError {
    AppError::new(ErrorCode::Io, format!("Could not {what} {path}: {e}"))
}

/// Checks a path sent by the frontend and returns it unchanged as a `PathBuf`: absolute, with a
/// drive letter or (v0.9.1) a UNC share on Windows (no device or verbatim path, no `\\server`
/// without a share), no `..` component.
pub fn check_path(path: &str) -> AppResult<PathBuf> {
    if path.trim().is_empty() {
        return Err(AppError::invalid("A local path is required"));
    }
    let p = Path::new(path);
    #[cfg(windows)]
    if let Some(Component::Prefix(prefix)) = p.components().next() {
        use std::path::Prefix;
        match prefix.kind() {
            Prefix::Disk(_) => {}
            Prefix::UNC(server, share) => {
                // `//?/` and `//./` are device paths to Windows even with forward slashes.
                let bad = |c: &std::ffi::OsStr| c.is_empty() || c == "." || c == ".." || c == "?";
                if bad(server) || bad(share) {
                    return Err(AppError::invalid(format!(r"{path}: not a valid network path (\\server\share)")));
                }
            }
            _ => {
                return Err(AppError::invalid(format!(
                    r"{path}: device paths are not supported; use a path that starts with a drive letter or \\server\share"
                )))
            }
        }
    }
    if !p.is_absolute() {
        return Err(AppError::invalid(format!("{path}: the path must be absolute")));
    }
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AppError::invalid(format!("{path}: the path must not contain \"..\"")));
    }
    Ok(p.to_path_buf())
}

/// Whether `path` names a network location by UNC (`\\server\share`, `//server/share`, or the
/// verbatim `\\?\UNC\…`). Always `false` outside Windows.
pub fn is_unc(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::path::Prefix;
        matches!(path.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::UNC(..) | Prefix::VerbatimUNC(..)))
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

/// Progress of a blocking walk, read by [`watched`]: the time of the last entry read.
pub struct Heartbeat {
    start: Instant,
    /// Milliseconds after `start`.
    last: std::sync::atomic::AtomicU64,
}

impl Default for Heartbeat {
    fn default() -> Self {
        Self { start: Instant::now(), last: std::sync::atomic::AtomicU64::new(0) }
    }
}

impl Heartbeat {
    pub fn new() -> Self {
        Self::default()
    }

    /// Progress was made now.
    pub fn beat(&self) {
        let ms = u64::try_from(self.start.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.last.fetch_max(ms, Ordering::Relaxed);
    }

    /// How long since the last progress (or since the start).
    pub fn idle(&self) -> Duration {
        self.start.elapsed().saturating_sub(Duration::from_millis(self.last.load(Ordering::Relaxed)))
    }
}

/// Runs `work` on a blocking thread. With `stall`, a watchdog fails the call `Io`
/// ([`NETWORK_STALL_MESSAGE`]) once `work` has not beaten its [`Heartbeat`] for that long, and sets
/// `stop` so the walk ends at its next entry (a thread stuck inside the OS is abandoned; its
/// result is dropped). Without `stall` it simply waits for `work`.
pub async fn watched<T, F>(stall: Option<Duration>, stop: Arc<AtomicBool>, work: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(&Heartbeat, &AtomicBool) -> AppResult<T> + Send + 'static,
{
    let hb = Arc::new(Heartbeat::new());
    let (hb2, stop2) = (hb.clone(), stop.clone());
    let mut task = tokio::task::spawn_blocking(move || work(&hb2, &stop2));
    let Some(stall) = stall else { return task.await? };
    let tick = (stall / 4).clamp(Duration::from_millis(10), Duration::from_secs(1));
    loop {
        tokio::select! {
            r = &mut task => return r?,
            _ = tokio::time::sleep(tick) => {
                if hb.idle() >= stall {
                    stop.store(true, Ordering::Relaxed);
                    return Err(AppError::new(ErrorCode::Io, NETWORK_STALL_MESSAGE));
                }
            }
        }
    }
}

/// The stall bound for a path: [`NETWORK_STALL`] on a network location, none elsewhere.
pub fn stall_bound(path: &str) -> Option<Duration> {
    is_unc(Path::new(path)).then_some(NETWORK_STALL)
}

/// [`check_path`], then: exists (`Io` with the OS message otherwise), is a directory and is not
/// itself a link (`InvalidInput`).
fn check_dir(path: &str) -> AppResult<PathBuf> {
    let dir = check_path(path)?;
    let meta = std::fs::symlink_metadata(&dir).map_err(|e| io_error("open", path, &e))?;
    if meta.file_type().is_symlink() {
        return Err(AppError::invalid(format!(
            "{path} is a link (symbolic link or junction); links are not followed"
        )));
    }
    if !meta.is_dir() {
        return Err(AppError::invalid(format!("{path} is not a folder")));
    }
    Ok(dir)
}

/// A dotfile, or (Windows) the hidden attribute.
fn is_hidden(name: &str, meta: Option<&std::fs::Metadata>) -> bool {
    if name.starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        if meta.is_some_and(|m| m.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0) {
            return true;
        }
    }
    #[cfg(not(windows))]
    let _ = meta;
    false
}

fn rfc3339(t: std::time::SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn sort_entries(v: &mut [LocalEntry]) {
    v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.name.cmp(&b.name)));
}

/// `list_local_dir`: at most [`LOCAL_MAX_ENTRIES`] entries.
pub fn list_dir(path: &str, show_hidden: bool) -> AppResult<LocalListing> {
    list_dir_capped(path, show_hidden, LOCAL_MAX_ENTRIES)
}

/// Lists `path` without following any link: directories and files (links among the files), each
/// sorted by name (case-insensitive, then exact). Stops after `cap` shown entries
/// (`truncated: true` when more exist). Hidden entries are skipped unless `show_hidden`, and do not
/// count against the cap.
pub fn list_dir_capped(path: &str, show_hidden: bool, cap: usize) -> AppResult<LocalListing> {
    list_dir_watched(path, show_hidden, cap, &Heartbeat::new(), &AtomicBool::new(false))
}

/// [`list_dir_capped`] that beats `hb` for every entry read and ends `Cancelled` when `stop` is set
/// (see [`watched`]).
pub fn list_dir_watched(path: &str, show_hidden: bool, cap: usize, hb: &Heartbeat, stop: &AtomicBool) -> AppResult<LocalListing> {
    let dir = check_dir(path)?;
    hb.beat();
    let read = std::fs::read_dir(&dir).map_err(|e| io_error("read", path, &e))?;
    hb.beat();
    let mut out = LocalListing {
        parent: dir.parent().filter(|p| !p.as_os_str().is_empty()).map(|p| p.to_string_lossy().into_owned()),
        ..LocalListing::default()
    };
    let mut shown = 0usize;
    for entry in read {
        hb.beat();
        if stop.load(Ordering::Relaxed) {
            return Err(AppError::cancelled());
        }
        // An entry that vanished or cannot be read mid-listing is left out.
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        // `DirEntry::file_type` / `metadata` never traverse a link (lstat; on Windows the
        // directory entry itself).
        let file_type = entry.file_type().ok();
        let meta = entry.metadata().ok();
        let hidden = is_hidden(&name, meta.as_ref());
        if hidden && !show_hidden {
            continue;
        }
        if shown >= cap {
            out.truncated = true;
            break;
        }
        shown += 1;
        let is_symlink = file_type.is_some_and(|t| t.is_symlink());
        let is_dir = !is_symlink && file_type.is_some_and(|t| t.is_dir());
        let size = if is_dir || is_symlink { 0 } else { meta.as_ref().map_or(0, std::fs::Metadata::len) };
        let modified = meta.as_ref().and_then(|m| m.modified().ok()).map(rfc3339);
        let e = LocalEntry {
            path: dir.join(entry.file_name()).to_string_lossy().into_owned(),
            name,
            is_dir,
            size,
            modified,
            is_symlink,
            hidden,
        };
        if is_dir {
            out.dirs.push(e);
        } else {
            out.files.push(e);
        }
    }
    sort_entries(&mut out.dirs);
    sort_entries(&mut out.files);
    Ok(out)
}

/// The canonical path of a directory just listed, for [`ListedDirs`] (`None` if it cannot be told).
pub fn canonical_dir(path: &str) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok().map(|c| crate::local_open::plain(&c))
}

/// Folds a name for "same name?" on the platform's file system.
fn fold_name(name: &str) -> String {
    fold_with(name, cfg!(any(windows, target_os = "macos")), cfg!(target_os = "macos"))
}

/// A typed name (new folder, rename): trimmed, not empty, without a path separator, then the
/// download file name rules ([`sanitize_segment`]).
fn clean_name(typed: &str) -> AppResult<String> {
    let t = typed.trim();
    if t.is_empty() {
        return Err(AppError::invalid("A name is required"));
    }
    if t.contains(['/', '\\']) {
        return Err(AppError::invalid("A name cannot contain / or \\"));
    }
    Ok(sanitize_segment(t))
}

/// `create_local_dir`: a new folder `name` (sanitized) in `parent`; refuses an existing name.
pub fn create_dir(parent: &str, name: &str) -> AppResult<PathBuf> {
    let dir = check_dir(parent)?;
    let clean = clean_name(name)?;
    let target = dir.join(&clean);
    // `create_dir` fails on any existing entry (file, folder or link): never replaces.
    match std::fs::create_dir(&target) {
        Ok(()) => Ok(target),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(AppError::invalid(format!("{clean} already exists in {parent}")))
        }
        Err(e) => Err(io_error("create a folder in", parent, &e)),
    }
}

/// `rename_local`: renames `path` (a file, folder or link, never followed) to `new_name`
/// (sanitized) in the same folder. Refuses an existing target, except the source itself (a change
/// of case on a case-insensitive file system); never replaces.
pub fn rename(path: &str, new_name: &str) -> AppResult<PathBuf> {
    let src = check_path(path)?;
    let parent = src
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| AppError::invalid(format!("{path} cannot be renamed")))?;
    let old = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    std::fs::symlink_metadata(&src).map_err(|e| io_error("rename", path, &e))?;
    let clean = clean_name(new_name)?;
    if clean == old {
        return Ok(src);
    }
    let dst = parent.join(&clean);
    if blocked_by_existing(&src, &dst).map_err(|e| io_error("check", &dst.to_string_lossy(), &e))? {
        return Err(AppError::invalid(format!("{clean} already exists")));
    }
    rename_no_replace(&src, &dst).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            AppError::invalid(format!("{clean} already exists"))
        } else {
            io_error("rename", path, &e)
        }
    })?;
    Ok(dst)
}

/// Windows: `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING`, so an existing target is an error
/// even if it appeared after the check (`std::fs::rename` would replace a file).
#[cfg(windows)]
fn rename_no_replace(src: &Path, dst: &Path) -> std::io::Result<()> {
    let (s, d) = (wide(src.as_os_str()), wide(dst.as_os_str()));
    // SAFETY: both are NUL-terminated UTF-16 strings that outlive the call.
    if unsafe { ffi::MoveFileExW(s.as_ptr(), d.as_ptr(), 0) } != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Elsewhere: refused when [`blocked_by_existing`] (a small window remains between the check and
/// the rename). A target that is the source itself (case-only rename on a case-insensitive file
/// system) is allowed.
#[cfg(not(windows))]
fn rename_no_replace(src: &Path, dst: &Path) -> std::io::Result<()> {
    if blocked_by_existing(src, dst)? {
        return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
    }
    std::fs::rename(src, dst)
}

/// Whether something other than `src` itself exists at `dst` (links are not followed). Shared by
/// every platform: on a case-insensitive file system `dst` differing from `src` only in case is
/// `src` itself.
fn blocked_by_existing(src: &Path, dst: &Path) -> std::io::Result<bool> {
    match std::fs::symlink_metadata(dst) {
        Ok(dst_meta) => {
            let src_meta = std::fs::symlink_metadata(src)?;
            Ok(!same_entry(src, &src_meta, dst, &dst_meta))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// `src` and `dst` name the same directory entry: same device and inode on Unix; on Windows the
/// same canonical path (the parent canonicalized, the name compared case-insensitively as NTFS
/// does), since a stable file id is not available there.
#[cfg(unix)]
fn same_entry(_src: &Path, a: &std::fs::Metadata, _dst: &Path, b: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev() && a.ino() == b.ino()
}

#[cfg(not(unix))]
fn same_entry(src: &Path, _a: &std::fs::Metadata, dst: &Path, _b: &std::fs::Metadata) -> bool {
    let key = |p: &Path| -> Option<String> {
        let parent = std::fs::canonicalize(p.parent()?).ok()?;
        Some(fold_name(&parent.join(p.file_name()?).to_string_lossy()))
    };
    matches!((key(src), key(dst)), (Some(a), Some(b)) if a == b)
}

#[cfg(windows)]
fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    s.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
mod ffi {
    pub const DRIVE_FIXED: u32 = 3;
    pub const DRIVE_REMOTE: u32 = 4;
    pub const NO_ERROR: u32 = 0;

    pub const RRF_RT_REG_DWORD: u32 = 0x0000_0010;
    // Predefined keys are sign-extended 32-bit values (`(HKEY)(ULONG_PTR)(LONG)0x80000001`).
    pub const HKEY_CURRENT_USER: isize = 0x8000_0001_u32 as i32 as isize;
    pub const HKEY_LOCAL_MACHINE: isize = 0x8000_0002_u32 as i32 as isize;

    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetLogicalDrives() -> u32;
        pub fn GetDriveTypeW(root: *const u16) -> u32;
        pub fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
        pub fn GetVolumeNameForVolumeMountPointW(mount_point: *const u16, volume_name: *mut u16, len: u32) -> i32;
    }

    #[link(name = "mpr")]
    extern "system" {
        pub fn WNetGetConnectionW(local: *const u16, remote: *mut u16, len: *mut u32) -> u32;
    }

    #[link(name = "advapi32")]
    extern "system" {
        pub fn RegGetValueW(
            key: isize,
            subkey: *const u16,
            value: *const u16,
            flags: u32,
            kind: *mut u32,
            data: *mut core::ffi::c_void,
            size: *mut u32,
        ) -> i32;
    }
}

/// The drive letter of a canonical (verbatim) path: only `\\?\X:\...`. A UNC share
/// (`\\?\UNC\...`), a volume mounted without a letter (`\\?\Volume{...}\...`), a device path
/// or a non-canonical path are refused with the reason.
#[cfg(windows)]
fn verbatim_drive(canonical: &Path) -> Result<char, String> {
    use std::path::Prefix;
    match canonical.components().next() {
        Some(Component::Prefix(p)) => match p.kind() {
            Prefix::VerbatimDisk(l) => Ok((l as char).to_ascii_uppercase()),
            Prefix::VerbatimUNC(..) | Prefix::UNC(..) => {
                Err("It is on a network share, which has no recycle bin; nothing was deleted. Delete it in your file manager.".into())
            }
            Prefix::Verbatim(v) if v.to_string_lossy().to_ascii_lowercase().starts_with("volume{") => Err(
                "It is on a volume mounted without a drive letter, whose recycle bin cannot be checked; nothing was deleted. Delete it in your file manager."
                    .into(),
            ),
            _ => Err("Its drive could not be determined, so it was not deleted.".into()),
        },
        _ => Err("Its drive could not be determined, so it was not deleted.".into()),
    }
}

/// `{GUID}` out of a volume name `\\?\Volume{GUID}\`.
#[cfg(windows)]
fn volume_guid(volume_name: &str) -> Option<&str> {
    let start = volume_name.find('{')?;
    let end = start + volume_name[start..].find('}')?;
    Some(&volume_name[start..=end])
}

#[cfg(windows)]
fn volume_name_of(letter: char) -> Option<String> {
    let root = wide(std::ffi::OsStr::new(&format!("{letter}:\\")));
    let mut buf = [0u16; 64];
    // SAFETY: `root` is NUL-terminated; `buf` is writable for the length passed.
    let ok = unsafe { ffi::GetVolumeNameForVolumeMountPointW(root.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) };
    if ok == 0 {
        return None;
    }
    let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..n]))
}

/// A DWORD registry value, `None` when absent.
#[cfg(windows)]
fn reg_dword(root: isize, subkey: &str, value: &str) -> Option<u32> {
    let (k, v) = (wide(std::ffi::OsStr::new(subkey)), wide(std::ffi::OsStr::new(value)));
    let mut data: u32 = 0;
    let mut size: u32 = 4;
    // SAFETY: NUL-terminated strings; `data` is a writable DWORD and `size` says so.
    let status = unsafe {
        ffi::RegGetValueW(root, k.as_ptr(), v.as_ptr(), ffi::RRF_RT_REG_DWORD, std::ptr::null_mut(), (&mut data as *mut u32).cast(), &mut size)
    };
    (status == 0).then_some(data)
}

/// The recycle bin settings of a volume: (`NukeOnDelete`, `MaxCapacity` in MB).
#[cfg(windows)]
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct BinSettings {
    nuke_on_delete: bool,
    max_capacity_mb: Option<u64>,
}

#[cfg(windows)]
const BITBUCKET: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket";

#[cfg(windows)]
fn bin_settings(letter: char) -> BinSettings {
    let per_volume = volume_name_of(letter)
        .as_deref()
        .and_then(volume_guid)
        .map(|g| format!("{BITBUCKET}\\Volume\\{g}"));
    let get = |value: &str| -> Option<u32> {
        per_volume.as_deref().and_then(|k| reg_dword(ffi::HKEY_CURRENT_USER, k, value))
    };
    // Group policy "Do not move deleted files to the Recycle Bin", the legacy global switch, then
    // the volume's own setting.
    let policy = reg_dword(ffi::HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Policies\Explorer", "NoRecycleFiles")
        .or_else(|| reg_dword(ffi::HKEY_LOCAL_MACHINE, r"Software\Microsoft\Windows\CurrentVersion\Policies\Explorer", "NoRecycleFiles"));
    let legacy = reg_dword(ffi::HKEY_CURRENT_USER, BITBUCKET, "NukeOnDelete")
        .or_else(|| reg_dword(ffi::HKEY_LOCAL_MACHINE, BITBUCKET, "NukeOnDelete"));
    let nuke = [policy, legacy, get("NukeOnDelete")].iter().any(|v| v.is_some_and(|n| n != 0));
    BinSettings { nuke_on_delete: nuke, max_capacity_mb: get("MaxCapacity").map(u64::from) }
}

/// Whether an item of `size` bytes (`truncated`: at least that much) fits in the bin: refused when
/// the bin is set to delete immediately, when it is larger than the bin, or when its size could
/// not be told (more entries than the bounded walk looks at).
#[cfg(windows)]
fn bin_accepts(bin: BinSettings, letter: char, size: u64, truncated: bool) -> Result<(), String> {
    if bin.nuke_on_delete {
        return Err(format!(
            "The recycle bin of drive {letter}: is set to remove files immediately, so it was not deleted. Delete it in your file manager."
        ));
    }
    if let Some(cap) = bin.max_capacity_mb {
        let mb = size.div_ceil(1024 * 1024);
        if mb > cap {
            return Err(format!(
                "It is larger ({mb} MB) than the recycle bin of drive {letter}: ({cap} MB), which would delete it permanently; nothing was deleted."
            ));
        }
        if truncated {
            return Err(format!(
                "It holds more than {LOCAL_DIR_SIZE_MAX_ENTRIES} entries, so it could not be confirmed to fit in the recycle bin of drive {letter}:; nothing was deleted."
            ));
        }
    }
    Ok(())
}

/// Windows: the drive that really holds `p` (its canonical parent: junctions and mount points
/// resolved) must be a fixed local disk. On a removable, network, optical or RAM drive the shell
/// would delete permanently, so those are refused.
#[cfg(windows)]
fn trash_drive(p: &Path) -> Result<char, String> {
    let parent = p.parent().ok_or_else(|| "A drive or root folder cannot be deleted".to_string())?;
    let canonical = std::fs::canonicalize(parent).map_err(|e| format!("Could not resolve its folder: {e}"))?;
    let letter = verbatim_drive(&canonical)?;
    let root = wide(std::ffi::OsStr::new(&format!("{letter}:\\")));
    // SAFETY: a NUL-terminated UTF-16 string that outlives the call.
    let kind = unsafe { ffi::GetDriveTypeW(root.as_ptr()) };
    if kind != ffi::DRIVE_FIXED {
        return Err(format!(
            "Drive {letter}: has no recycle bin (removable, network or optical drive); nothing was deleted. Delete it in your file manager."
        ));
    }
    Ok(letter)
}

/// Windows: every check before the item goes to the recycle bin.
#[cfg(windows)]
fn recycle_bin_ok(p: &Path, meta: &std::fs::Metadata) -> Result<(), String> {
    let letter = trash_drive(p)?;
    let bin = bin_settings(letter);
    let (size, truncated) = if meta.file_type().is_symlink() {
        (0, false) // the link itself goes to the bin
    } else if meta.is_dir() {
        let s = dir_size(&p.to_string_lossy(), LOCAL_DIR_SIZE_MAX_ENTRIES, &AtomicBool::new(false))
            .map_err(|e| format!("Could not measure it: {}", e.message))?;
        (s.bytes, s.truncated)
    } else {
        (meta.len(), false)
    };
    bin_accepts(bin, letter, size, truncated)
}

fn trash_context() -> trash::TrashContext {
    #[allow(unused_mut)]
    let mut ctx = trash::TrashContext::new();
    // The Finder method asks for permission to control Finder; the file manager call does not.
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        ctx.set_delete_method(DeleteMethod::NsFileManager);
    }
    ctx
}

/// Moves one path (as given; a link is moved as the link) to the recycle bin, and checks it is
/// gone afterwards.
fn trash_one(ctx: &trash::TrashContext, path: &str) -> Result<(), String> {
    // v0.9.1: a share has no recycle bin; refused as typed, before anything is resolved.
    if is_unc(Path::new(path)) {
        return Err(NO_NETWORK_TRASH.into());
    }
    let p = check_path(path).map_err(|e| e.message)?;
    if p.parent().is_none_or(|q| q.as_os_str().is_empty()) {
        return Err("A drive or root folder cannot be deleted".into());
    }
    let meta = match std::fs::symlink_metadata(&p) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err("It does not exist (any more)".into()),
        Err(e) => return Err(format!("Could not read it: {e}")),
    };
    #[cfg(windows)]
    recycle_bin_ok(&p, &meta)?;
    #[cfg(not(windows))]
    let _ = meta;
    // The trash crate canonicalizes only the parent and appends the name, so a link itself is
    // moved, never its target.
    ctx.delete(&p).map_err(|e| format!("Could not move it to the recycle bin: {e}"))?;
    // Never trust silence: it counts as trashed only when it is gone.
    match std::fs::symlink_metadata(&p) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err("It is still there after moving it to the recycle bin".into()),
        Err(e) => Err(format!("Could not check it after moving it to the recycle bin: {e}")),
    }
}

/// `trash_local`: each path on its own; a failure is reported for that path and the rest go on.
/// Blocking, and on Windows it initializes COM on the calling thread: call it on a thread of its
/// own (see `commands/local.rs`).
pub fn trash_paths(paths: &[String]) -> AppResult<TrashResult> {
    if paths.len() > TRASH_MAX_PATHS {
        return Err(AppError::invalid(format!("At most {TRASH_MAX_PATHS} items can be deleted at once")));
    }
    let ctx = trash_context();
    let mut out = TrashResult::default();
    for path in paths {
        match trash_one(&ctx, path) {
            Ok(()) => out.trashed += 1,
            Err(message) => out.failed.push(TrashFailure { path: path.clone(), message }),
        }
    }
    Ok(out)
}

/// Counts files and bytes under `path`, never following a link (links are neither counted nor
/// entered). Looks at no more than `limit` entries (`truncated: true` when it stopped there).
/// Unreadable subfolders are skipped; an unreadable `path` is `Io`. `stop` set: `Cancelled`.
/// Pending folders are kept as paths and opened one at a time, so at most one directory handle is
/// open, however wide or deep the tree.
pub fn dir_size(path: &str, limit: u64, stop: &AtomicBool) -> AppResult<LocalDirSize> {
    dir_size_with(path, limit, stop, &Heartbeat::new(), |p: &Path| std::fs::read_dir(p))
}

/// [`dir_size`] that beats `hb` for every folder opened and entry read (see [`watched`]).
pub fn dir_size_watched(path: &str, limit: u64, hb: &Heartbeat, stop: &AtomicBool) -> AppResult<LocalDirSize> {
    dir_size_with(path, limit, stop, hb, |p: &Path| std::fs::read_dir(p))
}

fn dir_size_with<I>(
    path: &str,
    limit: u64,
    stop: &AtomicBool,
    hb: &Heartbeat,
    mut open: impl FnMut(&Path) -> std::io::Result<I>,
) -> AppResult<LocalDirSize>
where
    I: Iterator<Item = std::io::Result<std::fs::DirEntry>>,
{
    let root = check_dir(path)?;
    hb.beat();
    let mut out = LocalDirSize::default();
    let mut seen: u64 = 0;
    let mut pending: Vec<PathBuf> = Vec::new();
    let mut current = Some(open(&root).map_err(|e| io_error("read", path, &e))?);
    loop {
        hb.beat();
        let Some(read) = current.take() else {
            let Some(next) = pending.pop() else { break };
            if stop.load(Ordering::Relaxed) {
                return Err(AppError::cancelled());
            }
            // An unreadable subfolder is skipped.
            current = open(&next).ok();
            continue;
        };
        for entry in read {
            hb.beat();
            if stop.load(Ordering::Relaxed) {
                return Err(AppError::cancelled());
            }
            let Ok(entry) = entry else { continue };
            if seen >= limit {
                out.truncated = true;
                return Ok(out);
            }
            seen += 1;
            let Ok(t) = entry.file_type() else { continue };
            if t.is_symlink() {
                continue;
            }
            if t.is_dir() {
                pending.push(entry.path());
            } else if t.is_file() {
                out.files += 1;
                out.bytes = out.bytes.saturating_add(entry.metadata().map_or(0, |m| m.len()));
            }
        }
        // `read` (this folder's handle) is closed here, before the next one is opened.
    }
    Ok(out)
}

/// Sets the flag when dropped: a cancelled scan's future is dropped, which stops its walk.
struct StopOnDrop(Arc<AtomicBool>);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// Running `local_dir_size` scans by `scanId`: a newer call with the id cancels the older one, as
/// does `cancel_folder_size` with that id. At most [`LOCAL_DIR_SIZE_PARALLEL`] walk at once.
pub struct LocalDirSizes {
    running: SearchRegistry,
    slots: Semaphore,
}

impl Default for LocalDirSizes {
    fn default() -> Self {
        Self { running: SearchRegistry::new(), slots: Semaphore::new(LOCAL_DIR_SIZE_PARALLEL) }
    }
}

impl LocalDirSizes {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn run(&self, id: &str, path: String) -> AppResult<LocalDirSize> {
        self.run_with_limit(id, path, LOCAL_DIR_SIZE_MAX_ENTRIES).await
    }

    async fn run_with_limit(&self, id: &str, path: String, limit: u64) -> AppResult<LocalDirSize> {
        let stop = Arc::new(AtomicBool::new(false));
        let guard = StopOnDrop(stop.clone());
        self.running
            .run(id, async move {
                let _guard = guard;
                let _slot = self.slots.acquire().await.map_err(|_| AppError::cancelled())?;
                let stall = stall_bound(&path);
                watched(stall, stop, move |hb, stop| dir_size_watched(&path, limit, hb, stop)).await
            })
            .await
    }

    pub fn cancel(&self, id: &str) {
        self.running.cancel(id);
    }

    pub fn running(&self) -> usize {
        self.running.running()
    }
}

/// The directories listed by `list_local_dir` this session (canonical, most recent last, at most
/// [`LISTED_DIRS_MAX`]): `open_local` opens files directly inside them.
#[derive(Default)]
pub struct ListedDirs {
    dirs: Mutex<VecDeque<PathBuf>>,
}

impl ListedDirs {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(&self, canonical: PathBuf) {
        let key = fold_name(&canonical.to_string_lossy());
        let mut dirs = self.dirs.lock().unwrap_or_else(|e| e.into_inner());
        dirs.retain(|d| fold_name(&d.to_string_lossy()) != key);
        dirs.push_back(canonical);
        while dirs.len() > LISTED_DIRS_MAX {
            dirs.pop_front();
        }
    }

    pub fn snapshot(&self) -> Vec<PathBuf> {
        self.dirs.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect()
    }
}

fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).filter(|h| !h.is_empty()).map(PathBuf::from).filter(|p| p.is_absolute())
}

/// `list_local_roots`: Windows, every ready drive letter (`drive`); elsewhere `/` (`drive`) and,
/// as `folder` roots, the mounts under
/// `/Volumes` (macOS) or `/media`, `/run/media` and `/mnt` (one level, a folder named after the
/// user is looked into); then the home folder.
pub fn roots() -> Vec<LocalRoot> {
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        // SAFETY: no arguments; returns a bit mask of the drive letters.
        let mask = unsafe { ffi::GetLogicalDrives() };
        for i in 0..26u8 {
            if mask & (1 << i) == 0 {
                continue;
            }
            let letter = (b'A' + i) as char;
            let root = format!("{letter}:\\");
            // Ready: an empty card reader or optical drive fails here.
            if std::fs::metadata(&root).is_ok_and(|m| m.is_dir()) {
                let label = drive_label(letter, mapped_unc(letter).as_deref());
                out.push(LocalRoot { path: root, label, kind: LocalRootKind::Drive });
            }
        }
    }
    #[cfg(not(windows))]
    {
        out.push(LocalRoot { path: "/".into(), label: "/".into(), kind: LocalRootKind::Drive });
        let bases: &[&str] = if cfg!(target_os = "macos") { &["/Volumes"] } else { &["/media", "/run/media", "/mnt"] };
        let user = std::env::var("USER").ok().filter(|u| !u.is_empty());
        for base in bases {
            for dir in plain_subdirs(Path::new(base)) {
                let is_user = user.as_deref().is_some_and(|u| dir.file_name().is_some_and(|n| n == u));
                if is_user && *base != "/mnt" {
                    for mount in plain_subdirs(&dir) {
                        push_mount(&mut out, &mount);
                    }
                } else {
                    push_mount(&mut out, &dir);
                }
            }
        }
    }
    out.truncate(ROOTS_MAX - 1);
    if let Some(home) = home_dir() {
        out.push(LocalRoot { path: home.to_string_lossy().into_owned(), label: "Home".into(), kind: LocalRootKind::Home });
    }
    out
}

/// A drive's label: `Z:`, or for a mapped network drive the share it maps to, `Z: (\\nas\data)`.
fn drive_label(letter: char, unc: Option<&str>) -> String {
    match unc {
        Some(u) if !u.is_empty() => format!("{letter}: ({u})"),
        _ => format!("{letter}:"),
    }
}

/// The UNC a mapped network drive letter stands for (`WNetGetConnectionW`), `None` for any other drive.
#[cfg(windows)]
fn mapped_unc(letter: char) -> Option<String> {
    let root = wide(std::ffi::OsStr::new(&format!("{letter}:\\")));
    // SAFETY: a NUL-terminated UTF-16 string that outlives the call.
    if unsafe { ffi::GetDriveTypeW(root.as_ptr()) } != ffi::DRIVE_REMOTE {
        return None;
    }
    let local = wide(std::ffi::OsStr::new(&format!("{letter}:")));
    let mut buf = vec![0u16; 1024];
    let mut len = buf.len() as u32;
    // SAFETY: `local` is NUL-terminated; `buf` is writable for `len` characters.
    let status = unsafe { ffi::WNetGetConnectionW(local.as_ptr(), buf.as_mut_ptr(), &mut len) };
    if status != ffi::NO_ERROR {
        return None;
    }
    let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..n])).filter(|u| !u.is_empty())
}

/// A saved Network Location as a root: its UNC target, labelled with the shortcut folder's name.
/// `None` when the target is not an accepted UNC path (a web or FTP location, a local folder).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn network_root(name: &str, target: &str) -> Option<LocalRoot> {
    let name = name.trim();
    if name.is_empty() || !is_unc(Path::new(target)) || check_path(target).is_err() {
        return None;
    }
    Some(LocalRoot { path: target.to_string(), label: name.to_string(), kind: LocalRootKind::Network })
}

/// `%APPDATA%\Microsoft\Windows\Network Shortcuts`, where Windows keeps the Network Locations.
#[cfg(windows)]
fn network_shortcuts_dir() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA").filter(|a| !a.is_empty()).map(PathBuf::from)?;
    Some(appdata.join("Microsoft").join("Windows").join("Network Shortcuts"))
}

/// Each `<dir>\<name>\target.lnk` (sorted by name, links never entered) resolved through
/// [`crate::shell_link`] and handed to `each` as soon as it is known; unresolvable or non-UNC
/// targets are skipped. Initializes COM on the calling thread: call on a thread of its own.
#[cfg(windows)]
fn scan_network_shortcuts(dir: &Path, mut each: impl FnMut(LocalRoot) -> bool) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    let mut folders: Vec<(String, PathBuf)> = read
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir() && !t.is_symlink()))
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .collect();
    folders.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()).then_with(|| a.0.cmp(&b.0)));
    let _com = crate::shell_link::ComApartment::init();
    for (name, folder) in folders {
        let lnk = folder.join("target.lnk");
        if !std::fs::symlink_metadata(&lnk).is_ok_and(|m| m.is_file()) {
            continue;
        }
        let Ok(target) = crate::shell_link::target(&lnk) else { continue };
        if let Some(root) = network_root(&name, &target) {
            if !each(root) {
                return;
            }
        }
    }
}

/// The saved Network Locations found in `dir` within `bound` (on a thread of its own, COM
/// initialized there); whatever resolved before the bound is kept, the rest is dropped.
#[cfg(windows)]
async fn network_roots_in(dir: PathBuf, bound: Duration) -> Vec<LocalRoot> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let spawned = std::thread::Builder::new()
        .name("network-locations".into())
        .spawn(move || scan_network_shortcuts(&dir, |root| tx.send(root).is_ok()));
    if spawned.is_err() {
        return Vec::new();
    }
    let deadline = tokio::time::Instant::now() + bound;
    let mut out = Vec::new();
    while let Ok(Some(root)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        out.push(root);
        if out.len() >= ROOTS_MAX {
            break;
        }
    }
    // Dropping `rx` ends the scan at its next shortcut.
    out
}

/// `list_local_roots` (v0.9.1): [`roots`], with the saved Network Locations (Windows) after the
/// drives, resolved within [`NETWORK_STALL`].
pub async fn roots_with_network() -> AppResult<Vec<LocalRoot>> {
    let mut out = tokio::task::spawn_blocking(roots).await?;
    #[cfg(windows)]
    if let Some(dir) = network_shortcuts_dir() {
        let network = network_roots_in(dir, NETWORK_STALL).await;
        out = merge_network(out, network);
    }
    Ok(out)
}

#[cfg_attr(not(windows), allow(dead_code))]
/// Inserts `network` after the drives (before the home folder), keeping at most [`ROOTS_MAX`]
/// roots; the home folder is never the one dropped.
fn merge_network(mut roots: Vec<LocalRoot>, network: Vec<LocalRoot>) -> Vec<LocalRoot> {
    let home = roots.iter().position(|r| r.kind == LocalRootKind::Home).map(|i| roots.remove(i));
    roots.extend(network);
    roots.truncate(ROOTS_MAX - usize::from(home.is_some()));
    roots.extend(home);
    roots
}

/// Subfolders of `dir` that are not links, sorted.
#[cfg(not(windows))]
fn plain_subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut v: Vec<PathBuf> =
        read.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir() && !t.is_symlink())).map(|e| e.path()).collect();
    v.sort();
    v
}

#[cfg(not(windows))]
fn push_mount(out: &mut Vec<LocalRoot>, p: &Path) {
    let label = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string());
    out.push(LocalRoot { path: p.to_string_lossy().into_owned(), label, kind: LocalRootKind::Folder });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{dir_link, ScratchDir};

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    fn code<T: std::fmt::Debug>(r: AppResult<T>) -> ErrorCode {
        r.expect_err("should fail").code
    }

    fn names(v: &[LocalEntry]) -> Vec<&str> {
        v.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn relative_and_device_paths_are_refused() {
        let mut bad = vec!["", "  ", "relative", "sub/dir", "./x"];
        if cfg!(windows) {
            bad.extend([
                // v0.9.1: a server without a share, or `.`/`..` as either, is not a share.
                r"\\server",
                r"\\server\",
                "//server",
                r"\\server\..\x",
                r"\\..\share\x",
                r"\\server\.\x",
                r"\\server\share\..\other",
                "//server/share/../x",
                r"\\.\C:\",
                "//./C:/x",
                "//?/C:/x",
                r"\\.\PhysicalDrive0",
                r"\\?\C:\Windows",
                r"\\?\UNC\server\share",
                r"C:relative",
                r"\no-drive",
                r"C:\Windows\..\Users",
            ]);
        } else {
            bad.push("/tmp/../etc");
        }
        for p in bad {
            assert_eq!(code(check_path(p)), ErrorCode::InvalidInput, "{p:?}");
            assert_eq!(code(list_dir(p, true)), ErrorCode::InvalidInput, "{p:?}");
            assert_eq!(code(dir_size(p, 10, &AtomicBool::new(false))), ErrorCode::InvalidInput, "{p:?}");
            assert_eq!(code(create_dir(p, "x")), ErrorCode::InvalidInput, "{p:?}");
            assert_eq!(code(rename(p, "x")), ErrorCode::InvalidInput, "{p:?}");
        }
        let ok = if cfg!(windows) { r"C:\Windows" } else { "/tmp" };
        assert_eq!(check_path(ok).expect("absolute"), PathBuf::from(ok));
    }

    /// v0.9.1: UNC shares are absolute paths, returned unchanged.
    #[cfg(windows)]
    #[test]
    fn unc_shares_are_accepted() {
        for ok in [r"\\server\share", r"\\server\share\", r"\\server\share\dir\f.txt", "//server/share", "//server/share/dir", r"\\nas.local\c$\x y"] {
            assert_eq!(check_path(ok).unwrap_or_else(|e| panic!("{ok}: {}", e.message)), PathBuf::from(ok));
            assert!(is_unc(Path::new(ok)), "{ok}");
            assert_eq!(stall_bound(ok), Some(NETWORK_STALL), "{ok}");
        }
        assert!(is_unc(Path::new(r"\\?\UNC\server\share\x")));
        for not in [r"C:\x", r"\\?\C:\x", r"\\.\C:\x", "relative", r"\\server"] {
            assert!(!is_unc(Path::new(not)), "{not}");
        }
        assert_eq!(stall_bound(r"C:\x"), None);
        // A share's root has no parent, like a drive root.
        assert_eq!(Path::new(r"\\server\share\").parent(), None);
    }

    #[test]
    fn heartbeat_measures_time_since_the_last_progress() {
        let hb = Heartbeat::new();
        std::thread::sleep(Duration::from_millis(30));
        assert!(hb.idle() >= Duration::from_millis(30));
        hb.beat();
        assert!(hb.idle() < Duration::from_millis(30));
    }

    #[tokio::test]
    async fn the_watchdog_fails_a_walk_that_stops_making_progress() {
        let stop = Arc::new(AtomicBool::new(false));
        let started = Instant::now();
        let e = watched(Some(Duration::from_millis(150)), stop.clone(), |hb, stop| {
            hb.beat();
            // Stuck (like a share that stopped answering), until told to stop.
            let until = Instant::now() + Duration::from_secs(10);
            while !stop.load(Ordering::Relaxed) && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(5));
            }
            AppResult::Ok(())
        })
        .await
        .expect_err("stalled");
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::Io, NETWORK_STALL_MESSAGE));
        assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
        assert!(stop.load(Ordering::Relaxed), "the walk is told to stop");
        // Steady progress, slower in total than the bound: never fails.
        let got = watched(Some(Duration::from_millis(150)), Arc::new(AtomicBool::new(false)), |hb, _| {
            for _ in 0..8 {
                std::thread::sleep(Duration::from_millis(40));
                hb.beat();
            }
            AppResult::Ok(7)
        })
        .await
        .expect("steady");
        assert_eq!(got, 7);
        // No bound: waits for the work, errors pass through.
        let e = watched(None, Arc::new(AtomicBool::new(false)), |_, _| AppResult::<()>::Err(AppError::invalid("x")))
            .await
            .expect_err("passes through");
        assert_eq!(e.code, ErrorCode::InvalidInput);
        assert_eq!(NETWORK_STALL, Duration::from_secs(15));
    }

    /// A `read_dir` whose `n`-th entry takes `delay` (a share that stops answering mid-folder).
    struct Slow {
        inner: std::fs::ReadDir,
        read: usize,
        stall_at: usize,
        delay: Duration,
    }

    impl Iterator for Slow {
        type Item = std::io::Result<std::fs::DirEntry>;
        fn next(&mut self) -> Option<Self::Item> {
            self.read += 1;
            if self.read == self.stall_at {
                std::thread::sleep(self.delay);
            }
            self.inner.next()
        }
    }

    #[tokio::test]
    async fn a_size_scan_that_stalls_fails_with_network_did_not_respond() {
        let d = ScratchDir::new("local-size-stall");
        for i in 0..5 {
            std::fs::write(d.0.join(format!("f{i}")), b"ab").expect("write");
        }
        let scan = |stall_at: usize, delay: Duration, bound: Duration| {
            let p = s(&d.0);
            watched(Some(bound), Arc::new(AtomicBool::new(false)), move |hb, stop| {
                dir_size_with(&p, 100, stop, hb, |q: &Path| {
                    std::fs::read_dir(q).map(|inner| Slow { inner, read: 0, stall_at, delay })
                })
            })
        };
        let started = Instant::now();
        let e = scan(3, Duration::from_secs(2), Duration::from_millis(200)).await.expect_err("stalled");
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::Io, NETWORK_STALL_MESSAGE));
        assert!(started.elapsed() < Duration::from_millis(1500), "{:?}", started.elapsed());
        // A pause shorter than the bound is fine.
        let got = scan(3, Duration::from_millis(50), Duration::from_millis(400)).await.expect("short pause");
        assert_eq!(got, LocalDirSize { files: 5, bytes: 10, truncated: false });
    }

    #[test]
    fn a_listing_beats_for_every_entry_and_stops_when_told() {
        let d = ScratchDir::new("local-list-watched");
        for i in 0..3 {
            std::fs::write(d.0.join(format!("f{i}")), b"x").expect("write");
        }
        let hb = Heartbeat::new();
        std::thread::sleep(Duration::from_millis(30));
        let l = list_dir_watched(&s(&d.0), true, 10, &hb, &AtomicBool::new(false)).expect("list");
        assert_eq!(l.files.len(), 3);
        assert!(hb.idle() < Duration::from_millis(30));
        assert!(list_dir_watched(&s(&d.0), true, 10, &hb, &AtomicBool::new(true)).expect_err("stopped").is_cancelled());
    }

    /// v0.9.1: nothing on a share goes to a recycle bin, whatever the spelling.
    #[cfg(windows)]
    #[test]
    fn trash_refuses_every_network_path() {
        let paths: Vec<String> = [r"\\server\share\f.txt", "//server/share/dir", r"\\server\share", r"\\?\UNC\server\share\f"]
            .iter()
            .map(|p| p.to_string())
            .collect();
        let r = trash_paths(&paths).expect("trash");
        assert_eq!(r.trashed, 0);
        assert_eq!(r.failed.len(), paths.len());
        for (f, p) in r.failed.iter().zip(&paths) {
            assert_eq!((f.path.as_str(), f.message.as_str()), (p.as_str(), NO_NETWORK_TRASH));
        }
    }

    /// A link on a local disk that leads to a share: the canonical-volume check refuses it. Needs
    /// the right to create symbolic links and a reachable administrative share on this machine.
    #[cfg(windows)]
    #[test]
    fn a_link_to_a_share_is_refused_by_the_volume_check() {
        let d = ScratchDir::new("local-trash-unc-link");
        let share = r"\\localhost\C$\Windows";
        if std::fs::metadata(share).is_err() {
            println!("skipping: {share} is not reachable here");
            return;
        }
        let link = d.0.join("to-share");
        if let Err(e) = std::os::windows::fs::symlink_dir(share, &link) {
            println!("skipping: cannot create a symbolic link here ({e})");
            return;
        }
        let e = trash_drive(&link.join("win.ini")).expect_err("on a share");
        assert!(e.contains("network share"), "{e}");
        let r = trash_paths(&[s(&link.join("win.ini"))]).expect("trash");
        assert_eq!(r.trashed, 0);
        assert!(Path::new(share).join("win.ini").exists());
    }

    #[test]
    fn drive_labels_show_the_share_of_a_mapped_drive() {
        assert_eq!(drive_label('C', None), "C:");
        assert_eq!(drive_label('Z', Some(r"\\nas\data")), r"Z: (\\nas\data)");
        assert_eq!(drive_label('Y', Some("")), "Y:");
        #[cfg(windows)]
        assert_eq!(mapped_unc('C'), None, "a fixed disk is not mapped");
    }

    #[test]
    fn network_roots_need_a_unc_target_and_a_name() {
        if cfg!(windows) {
            let r = network_root(" NAS media ", r"\\nas\media\films").expect("unc");
            assert_eq!(r, LocalRoot { path: r"\\nas\media\films".into(), label: "NAS media".into(), kind: LocalRootKind::Network });
            assert_eq!(serde_json::to_value(r).expect("ser")["kind"], "network");
            assert!(network_root("x", "//nas/media").is_some());
        }
        for bad in [r"C:\Users", "https://example.com/dav", "ftp://host/", r"\\server", r"\\server\..\x", ""] {
            assert_eq!(network_root("x", bad), None, "{bad}");
        }
        assert_eq!(network_root("  ", r"\\nas\media"), None);
    }

    #[test]
    fn network_roots_go_after_the_drives_and_before_home() {
        let root = |p: &str, kind| LocalRoot { path: p.into(), label: p.into(), kind };
        let drives = vec![root("C", LocalRootKind::Drive), root("D", LocalRootKind::Drive), root("H", LocalRootKind::Home)];
        let net = vec![root("N1", LocalRootKind::Network), root("N2", LocalRootKind::Network)];
        let got: Vec<String> = merge_network(drives, net).into_iter().map(|r| r.path).collect();
        assert_eq!(got, ["C", "D", "N1", "N2", "H"]);
        // Capped, the home folder kept.
        let many: Vec<LocalRoot> = (0..100).map(|i| root(&format!("N{i}"), LocalRootKind::Network)).collect();
        let got = merge_network(vec![root("C", LocalRootKind::Drive), root("H", LocalRootKind::Home)], many);
        assert_eq!(got.len(), ROOTS_MAX);
        assert_eq!(got.last().map(|r| r.kind), Some(LocalRootKind::Home));
        assert_eq!(got[0].path, "C");
    }

    /// A Network Shortcuts folder built in a scratch dir: entries whose `target.lnk` resolves to a
    /// share are listed by folder name; a local target, a missing or broken shortcut is skipped.
    #[cfg(windows)]
    #[tokio::test]
    async fn network_shortcuts_are_resolved_and_filtered() {
        let d = ScratchDir::new("local-netshortcuts");
        let make = |name: &str, target: &str| -> Result<(), String> {
            let folder = d.0.join(name);
            std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
            let lnk = folder.join("target.lnk");
            let target = target.to_string();
            // COM on a thread of its own, as in the app.
            std::thread::spawn(move || {
                let _com = crate::shell_link::ComApartment::init();
                crate::shell_link::create(&lnk, &target)
            })
            .join()
            .map_err(|_| "panicked".to_string())?
        };
        let local = d.0.join("local target");
        std::fs::create_dir(&local).expect("mkdir");
        if let Err(e) = make("Local folder", &local.to_string_lossy()) {
            println!("skipping: could not create a shortcut through COM here ({e})");
            return;
        }
        std::fs::create_dir(d.0.join("No shortcut")).expect("mkdir");
        std::fs::create_dir(d.0.join("Broken")).expect("mkdir");
        std::fs::write(d.0.join("Broken").join("target.lnk"), b"junk").expect("write");
        // A share that does not exist: the shortcut stores its UNC path all the same.
        let unc_ok = make("Team share", r"\\localhost\s3x-no-such-share\docs").is_ok();
        let got = network_roots_in(d.0.clone(), NETWORK_STALL).await;
        if unc_ok {
            assert_eq!(got.len(), 1, "{got:?}");
            assert_eq!((got[0].label.as_str(), got[0].kind), ("Team share", LocalRootKind::Network));
            assert!(got[0].path.to_ascii_lowercase().starts_with(r"\\localhost\s3x-no-such-share"), "{got:?}");
        } else {
            println!("skipping the share half: a shortcut to a UNC path could not be created here");
            assert!(got.is_empty(), "{got:?}");
        }
        // A bound of zero returns at once with whatever arrived (here: nothing yet, or less).
        let quick = network_roots_in(d.0.clone(), Duration::ZERO).await;
        assert!(quick.len() <= got.len());
        // A missing folder: no roots, no error.
        assert!(network_roots_in(d.0.join("missing"), NETWORK_STALL).await.is_empty());
    }

    #[test]
    fn lists_sorted_dirs_and_files_with_metadata() {
        let d = ScratchDir::new("local-list");
        std::fs::write(d.0.join("b.txt"), b"12345").expect("write");
        std::fs::write(d.0.join("A.txt"), b"1").expect("write");
        std::fs::write(d.0.join("c.bin"), b"").expect("write");
        std::fs::create_dir(d.0.join("zeta")).expect("mkdir");
        std::fs::create_dir(d.0.join("Alpha")).expect("mkdir");
        std::fs::write(d.0.join("zeta").join("inner"), b"x").expect("write");
        let l = list_dir(&s(&d.0), false).expect("list");
        assert_eq!(names(&l.dirs), ["Alpha", "zeta"]);
        assert_eq!(names(&l.files), ["A.txt", "b.txt", "c.bin"]);
        assert!(!l.truncated);
        assert_eq!(l.parent.as_deref(), d.0.parent().map(|p| p.to_string_lossy().into_owned()).as_deref());
        let b = &l.files[1];
        assert_eq!((b.size, b.is_dir, b.is_symlink, b.hidden), (5, false, false, false));
        assert_eq!(b.path, s(&d.0.join("b.txt")));
        assert!(b.modified.as_deref().is_some_and(|m| m.ends_with('Z') && m.contains('T')), "{:?}", b.modified);
        let z = &l.dirs[1];
        assert_eq!((z.size, z.is_dir), (0, true));
        // Serialized camelCase, as in types.ts.
        let v = serde_json::to_value(b).expect("ser");
        for k in ["name", "path", "isDir", "size", "modified", "isSymlink", "hidden"] {
            assert!(v.get(k).is_some(), "{k}");
        }
        let v = serde_json::to_value(&l).expect("ser");
        for k in ["dirs", "files", "truncated", "parent"] {
            assert!(v.get(k).is_some(), "{k}");
        }
        // A root has no parent.
        let root = if cfg!(windows) { r"C:\" } else { "/" };
        assert_eq!(list_dir_capped(root, false, 1).expect("root").parent, None);
    }

    #[test]
    fn missing_file_and_unreadable_paths() {
        let d = ScratchDir::new("local-missing");
        let missing = d.0.join("nope");
        let e = list_dir(&s(&missing), true).expect_err("missing");
        assert_eq!(e.code, ErrorCode::Io);
        assert!(e.message.contains("nope"), "{}", e.message);
        std::fs::write(d.0.join("f.txt"), b"x").expect("write");
        assert_eq!(code(list_dir(&s(&d.0.join("f.txt")), true)), ErrorCode::InvalidInput);
    }

    #[test]
    fn hidden_entries() {
        let d = ScratchDir::new("local-hidden");
        std::fs::write(d.0.join(".dotfile"), b"x").expect("write");
        std::fs::create_dir(d.0.join(".dotdir")).expect("mkdir");
        std::fs::write(d.0.join("shown.txt"), b"x").expect("write");
        let attr = d.0.join("attr-hidden.txt");
        std::fs::write(&attr, b"x").expect("write");
        let attrib_ok = cfg!(windows)
            && std::process::Command::new("attrib").arg("+h").arg(&attr).output().is_ok_and(|o| o.status.success());
        if cfg!(windows) && !attrib_ok {
            println!("skipping the hidden attribute half: `attrib +h` is not available");
        }
        let l = list_dir(&s(&d.0), false).expect("list");
        let mut want = vec!["shown.txt"];
        if !attrib_ok {
            want.insert(0, "attr-hidden.txt");
        }
        assert_eq!(names(&l.files), want);
        assert!(l.dirs.is_empty());
        let all = list_dir(&s(&d.0), true).expect("list");
        assert_eq!(names(&all.dirs), [".dotdir"]);
        assert_eq!(names(&all.files), [".dotfile", "attr-hidden.txt", "shown.txt"]);
        let hidden: Vec<bool> = all.files.iter().map(|e| e.hidden).collect();
        assert_eq!(hidden, [true, attrib_ok, false]);
        assert!(all.dirs[0].hidden);
    }

    #[test]
    fn links_are_listed_never_followed() {
        let d = ScratchDir::new("local-links");
        let outside = ScratchDir::new("local-links-out");
        std::fs::write(outside.0.join("secret.txt"), b"secret").expect("write");
        let link = d.0.join("link");
        dir_link(&link, &outside.0);
        let l = list_dir(&s(&d.0), true).expect("list");
        assert!(l.dirs.is_empty());
        assert_eq!(names(&l.files), ["link"]);
        let e = &l.files[0];
        assert_eq!((e.is_symlink, e.is_dir, e.size), (true, false, 0));
        // Listing or sizing the link itself is refused.
        assert_eq!(code(list_dir(&s(&link), true)), ErrorCode::InvalidInput);
        assert_eq!(code(dir_size(&s(&link), 100, &AtomicBool::new(false))), ErrorCode::InvalidInput);
        assert_eq!(code(create_dir(&s(&link), "x")), ErrorCode::InvalidInput);
        assert!(!outside.0.join("x").exists());
    }

    #[test]
    fn cap_truncates() {
        let d = ScratchDir::new("local-cap");
        for i in 0..5 {
            std::fs::write(d.0.join(format!("f{i}")), b"").expect("write");
        }
        std::fs::write(d.0.join(".h"), b"").expect("write");
        let l = list_dir_capped(&s(&d.0), false, 5).expect("list");
        assert_eq!((l.files.len(), l.truncated), (5, false), "hidden entries do not count");
        let l = list_dir_capped(&s(&d.0), true, 5).expect("list");
        assert_eq!((l.files.len(), l.truncated), (5, true));
        let l = list_dir_capped(&s(&d.0), false, 3).expect("list");
        assert_eq!((l.files.len(), l.truncated), (3, true));
    }

    #[test]
    fn cap_is_fifty_thousand() {
        let d = ScratchDir::new("local-cap-50k");
        for i in 0..=LOCAL_MAX_ENTRIES {
            std::fs::File::create(d.0.join(format!("{i:05}"))).expect("create");
        }
        let l = list_dir(&s(&d.0), false).expect("list");
        assert_eq!(LOCAL_MAX_ENTRIES, 50_000);
        assert_eq!((l.files.len(), l.truncated), (50_000, true));
        std::fs::remove_file(d.0.join("00000")).expect("rm");
        let l = list_dir(&s(&d.0), false).expect("list");
        assert_eq!((l.files.len(), l.truncated), (50_000, false));
    }

    #[test]
    fn limits_match_types_ts() {
        let ts = include_str!("../../src/lib/types.ts");
        assert!(ts.contains("LOCAL_LIMITS = { maxEntries: 50_000, dirSizeMaxEntries: 200_000 }"));
        assert_eq!(LOCAL_DIR_SIZE_MAX_ENTRIES, 200_000);
    }

    #[test]
    fn create_folder_sanitizes_and_never_replaces() {
        let d = ScratchDir::new("local-mkdir");
        let p = s(&d.0);
        let made = create_dir(&p, "  a:b?  ").expect("create");
        assert_eq!(made, d.0.join("a_b_"));
        assert!(made.is_dir());
        assert_eq!(create_dir(&p, "CON").expect("reserved"), d.0.join("_CON"));
        assert_eq!(create_dir(&p, "dots...").expect("dots"), d.0.join("dots"));
        // Existing folder or file of that name: refused, untouched.
        std::fs::write(d.0.join("taken"), b"keep").expect("write");
        let e = create_dir(&p, "taken").expect_err("exists");
        assert_eq!(e.code, ErrorCode::InvalidInput);
        assert!(e.message.contains("already exists"), "{}", e.message);
        assert_eq!(std::fs::read(d.0.join("taken")).expect("read"), b"keep");
        assert_eq!(code(create_dir(&p, "a_b_")), ErrorCode::InvalidInput);
        for bad in ["", "   ", "x/y", r"x\y"] {
            assert_eq!(code(create_dir(&p, bad)), ErrorCode::InvalidInput, "{bad:?}");
        }
        assert_eq!(code(create_dir(&s(&d.0.join("missing")), "x")), ErrorCode::Io);
    }

    #[test]
    fn rename_never_replaces() {
        let d = ScratchDir::new("local-rename");
        let a = d.0.join("a.txt");
        let b = d.0.join("b.txt");
        std::fs::write(&a, b"A").expect("write");
        std::fs::write(&b, b"B").expect("write");
        std::fs::create_dir(d.0.join("dir")).expect("mkdir");
        std::fs::create_dir(d.0.join("empty")).expect("mkdir");
        // Onto an existing file, and a folder onto an existing (empty) folder: refused, both kept.
        let e = rename(&s(&a), "b.txt").expect_err("exists");
        assert!(e.message.contains("already exists"), "{}", e.message);
        assert_eq!(code(rename(&s(&d.0.join("dir")), "empty")), ErrorCode::InvalidInput);
        assert_eq!(code(rename(&s(&a), "dir")), ErrorCode::InvalidInput);
        assert_eq!((std::fs::read(&a).expect("a"), std::fs::read(&b).expect("b")), (b"A".to_vec(), b"B".to_vec()));
        assert!(d.0.join("dir").is_dir() && d.0.join("empty").is_dir());
        if cfg!(windows) {
            // Another entry of the same name in a different case exists: refused on a case-insensitive disk.
            assert_eq!(code(rename(&s(&a), "B.TXT")), ErrorCode::InvalidInput);
        }
        // The no-replace primitive itself refuses an existing target.
        assert_eq!(rename_no_replace(&a, &b).expect_err("exists").kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&b).expect("b"), b"B");
        // Same directory only.
        for bad in ["../x.txt", "sub/x.txt", r"sub\x.txt", "", " "] {
            assert_eq!(code(rename(&s(&a), bad)), ErrorCode::InvalidInput, "{bad:?}");
        }
        // A plain rename (sanitized), and a change of case.
        let got = rename(&s(&a), "c:d.txt").expect("rename");
        assert_eq!(got, d.0.join("c_d.txt"));
        assert!(!a.exists() && got.is_file());
        let got = rename(&s(&got), "C_D.txt").expect("case only");
        let listed = list_dir(&s(&d.0), true).expect("list");
        assert!(names(&listed.files).contains(&"C_D.txt"), "{:?}", names(&listed.files));
        assert_eq!(std::fs::read(&got).expect("read"), b"A");
        assert_eq!(code(rename(&s(&d.0.join("missing")), "x")), ErrorCode::Io);
    }

    #[test]
    fn rename_a_link_renames_the_link() {
        let d = ScratchDir::new("local-rename-link");
        let outside = ScratchDir::new("local-rename-link-out");
        std::fs::write(outside.0.join("f"), b"x").expect("write");
        let link = d.0.join("link");
        dir_link(&link, &outside.0);
        let got = rename(&s(&link), "renamed").expect("rename");
        assert!(std::fs::symlink_metadata(&got).expect("meta").file_type().is_symlink());
        assert_eq!(outside.files(), ["f"]);
    }

    #[test]
    fn trash_moves_to_the_recycle_bin_and_keeps_link_targets() {
        let d = ScratchDir::new("local-trash");
        let outside = ScratchDir::new("local-trash-out");
        std::fs::write(outside.0.join("target.txt"), b"keep me").expect("write");
        let file = d.0.join("file.txt");
        std::fs::write(&file, b"x").expect("write");
        let folder = d.0.join("folder");
        std::fs::create_dir(&folder).expect("mkdir");
        std::fs::write(folder.join("inner.txt"), b"y").expect("write");
        let link = d.0.join("link");
        dir_link(&link, &outside.0);
        std::fs::write(d.0.join("kept.txt"), b"z").expect("write");

        let paths = vec![
            s(&file),
            "relative.txt".to_string(),
            s(&d.0.join("missing.txt")),
            s(&link),
            s(&folder),
            if cfg!(windows) { r"C:\".to_string() } else { "/".to_string() },
        ];
        let r = trash_paths(&paths).expect("trash");
        assert_eq!(r.trashed, 3, "{r:?}");
        let failed: Vec<&str> = r.failed.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(failed, [paths[1].as_str(), paths[2].as_str(), paths[5].as_str()]);
        assert!(r.failed.iter().all(|f| !f.message.is_empty()));
        // What survived: the untouched file, and the link's target with its content.
        assert_eq!(d.files(), ["kept.txt"]);
        assert_eq!(std::fs::read(outside.0.join("target.txt")).expect("target"), b"keep me");
        assert_eq!(outside.files(), ["target.txt"]);
        // Too many paths at once.
        assert_eq!(code(trash_paths(&vec![String::new(); TRASH_MAX_PATHS + 1])), ErrorCode::InvalidInput);
        assert_eq!(trash_paths(&[]).expect("empty"), TrashResult::default());
    }

    #[cfg(windows)]
    #[test]
    fn the_volume_comes_from_the_canonical_verbatim_prefix() {
        assert_eq!(verbatim_drive(Path::new(r"\\?\C:\Users\x")), Ok('C'));
        assert_eq!(verbatim_drive(Path::new(r"\\?\d:\")), Ok('D'));
        for bad in [
            r"\\?\UNC\server\share\x",
            r"\\server\share\x",
            r"\\?\Volume{0f1e2d3c-1111-2222-3333-444455556666}\dir",
            r"\\.\C:\x",
            r"C:\x",
            "relative",
        ] {
            assert!(verbatim_drive(Path::new(bad)).is_err(), "{bad}");
        }
        assert!(verbatim_drive(Path::new(r"\\?\UNC\s\h")).unwrap_err().contains("network share"));
        assert!(verbatim_drive(Path::new(r"\\?\Volume{ab}\x")).unwrap_err().contains("without a drive letter"));
        assert_eq!(volume_guid(r"\\?\Volume{0f1e2d3c-1111}\"), Some("{0f1e2d3c-1111}"));
        assert_eq!(volume_guid("nothing"), None);
        // The real C: has a volume name and readable (possibly absent) bin settings.
        assert!(volume_name_of('C').and_then(|v| volume_guid(&v).map(str::to_string)).is_some());
        let _ = bin_settings('C');
    }

    #[cfg(windows)]
    #[test]
    fn the_bin_must_be_enabled_and_large_enough() {
        let on = BinSettings { nuke_on_delete: false, max_capacity_mb: Some(10) };
        assert!(bin_accepts(on, 'C', 10 * 1024 * 1024, false).is_ok());
        let e = bin_accepts(on, 'C', 10 * 1024 * 1024 + 1, false).unwrap_err();
        assert!(e.contains("larger") && e.contains("11 MB") && e.contains("10 MB"), "{e}");
        assert!(bin_accepts(on, 'C', 5, true).unwrap_err().contains("could not be confirmed"));
        let nuke = BinSettings { nuke_on_delete: true, max_capacity_mb: None };
        assert!(bin_accepts(nuke, 'C', 0, false).unwrap_err().contains("remove files immediately"));
        // No capacity known: only the switch is checked.
        assert!(bin_accepts(BinSettings::default(), 'C', u64::MAX, true).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn only_fixed_drives_have_a_recycle_bin() {
        let d = ScratchDir::new("local-trash-drive");
        std::fs::write(d.0.join("f"), b"x").expect("write");
        let here = d.0.to_string_lossy().chars().next().map(|c| c.to_ascii_uppercase()).expect("drive");
        assert_eq!(trash_drive(&d.0.join("f")), Ok(here));
        // A missing folder cannot be resolved; a root has no parent.
        assert!(trash_drive(&d.0.join("missing").join("f")).is_err());
        assert!(trash_drive(Path::new(r"C:\")).is_err());
        // A drive letter that is not mounted cannot be resolved either.
        // SAFETY: no arguments.
        let mask = unsafe { ffi::GetLogicalDrives() };
        if let Some(i) = (0..26u8).rev().find(|i| mask & (1 << i) == 0) {
            let p = format!("{}:\\x\\y", (b'A' + i) as char);
            assert!(trash_drive(Path::new(&p)).is_err(), "{p}");
        }
    }

    /// A junction to a folder on another drive: the item really lives on that drive.
    #[cfg(windows)]
    #[test]
    fn the_drive_of_an_item_behind_a_junction_is_the_target_drive() {
        let d = ScratchDir::new("local-trash-junction");
        let here = d.0.to_string_lossy().chars().next().map(|c| c.to_ascii_uppercase()).expect("drive");
        let other_base = std::env::temp_dir();
        let there = other_base.to_string_lossy().chars().next().map(|c| c.to_ascii_uppercase()).expect("drive");
        if here == there {
            println!("skipping: the scratch folder and the temp folder are both on {here}:, no second drive to point a junction at");
            return;
        }
        let target = other_base.join(format!("s3x-junction-target-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&target).expect("mkdir");
        std::fs::write(target.join("f.txt"), b"x").expect("write");
        let link = d.0.join("link");
        dir_link(&link, &target);
        assert_eq!(trash_drive(&link.join("f.txt")), Ok(there), "the target's drive, not {here}:");
        // The junction itself lives on this drive.
        assert_eq!(trash_drive(&link), Ok(here));
        let _ = std::fs::remove_dir_all(&target);
    }

    #[test]
    fn an_existing_target_blocks_unless_it_is_the_source() {
        let d = ScratchDir::new("local-blocked");
        let a = d.0.join("a.txt");
        std::fs::write(&a, b"A").expect("write");
        std::fs::write(d.0.join("b.txt"), b"B").expect("write");
        assert!(!blocked_by_existing(&a, &d.0.join("new.txt")).expect("absent"));
        assert!(blocked_by_existing(&a, &d.0.join("b.txt")).expect("other"));
        assert!(!blocked_by_existing(&a, &a).expect("itself"));
        if cfg!(any(windows, target_os = "macos")) {
            assert!(!blocked_by_existing(&a, &d.0.join("A.TXT")).expect("case only"));
        }
    }

    fn tree(d: &Path) {
        std::fs::write(d.join("a"), b"12345").expect("write");
        std::fs::create_dir_all(d.join("sub").join("deeper")).expect("mkdir");
        std::fs::write(d.join("sub").join("b"), b"123").expect("write");
        std::fs::write(d.join("sub").join("deeper").join("c"), b"12").expect("write");
    }

    #[test]
    fn dir_size_counts_without_following_links() {
        let d = ScratchDir::new("local-size");
        let outside = ScratchDir::new("local-size-out");
        tree(&d.0);
        std::fs::write(outside.0.join("big"), vec![0u8; 4096]).expect("write");
        dir_link(&d.0.join("sub").join("link"), &outside.0);
        let stop = AtomicBool::new(false);
        let got = dir_size(&s(&d.0), LOCAL_DIR_SIZE_MAX_ENTRIES, &stop).expect("size");
        assert_eq!(got, LocalDirSize { files: 3, bytes: 10, truncated: false });
        // Entries are bounded (folders and links count as entries).
        let got = dir_size(&s(&d.0), 2, &stop).expect("size");
        assert!(got.truncated && got.files <= 2, "{got:?}");
        let v = serde_json::to_value(got).expect("ser");
        assert_eq!(v.as_object().map(|o| o.len()), Some(3));
        assert_eq!(code(dir_size(&s(&d.0.join("missing")), 10, &stop)), ErrorCode::Io);
        // A set flag stops the walk.
        let e = dir_size(&s(&d.0), 100, &AtomicBool::new(true)).expect_err("stopped");
        assert!(e.is_cancelled());
    }

    /// A `read_dir` that counts how many handles are open at once.
    struct Counted {
        inner: std::fs::ReadDir,
        live: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl Iterator for Counted {
        type Item = std::io::Result<std::fs::DirEntry>;
        fn next(&mut self) -> Option<Self::Item> {
            self.inner.next()
        }
    }

    impl Drop for Counted {
        fn drop(&mut self) {
            self.live.fetch_sub(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn dir_size_holds_one_handle_at_a_time() {
        let d = ScratchDir::new("local-size-wide");
        // 2,000 folders: 40 chains, each 50 deep, a file at every level.
        for chain in 0..40 {
            let mut p = d.0.join(format!("c{chain}"));
            for level in 0..50 {
                if level > 0 {
                    p = p.join("d");
                }
                std::fs::create_dir_all(&p).expect("mkdir");
                std::fs::write(p.join("f"), b"ab").expect("write");
            }
        }
        let live = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (most, opened) = (Arc::new(std::sync::atomic::AtomicUsize::new(0)), Arc::new(std::sync::atomic::AtomicUsize::new(0)));
        let open = |p: &Path| -> std::io::Result<Counted> {
            let inner = std::fs::read_dir(p)?;
            let now = live.fetch_add(1, Ordering::SeqCst) + 1;
            most.fetch_max(now, Ordering::SeqCst);
            opened.fetch_add(1, Ordering::SeqCst);
            Ok(Counted { inner, live: live.clone() })
        };
        let got = dir_size_with(&s(&d.0), LOCAL_DIR_SIZE_MAX_ENTRIES, &AtomicBool::new(false), &Heartbeat::new(), open).expect("size");
        assert_eq!(got, LocalDirSize { files: 2000, bytes: 4000, truncated: false });
        assert_eq!(opened.load(Ordering::SeqCst), 2001, "every folder once, plus the root");
        assert_eq!(most.load(Ordering::SeqCst), 1, "one directory handle at a time");
        assert_eq!(live.load(Ordering::SeqCst), 0);
        // And through the real `read_dir`.
        assert_eq!(dir_size(&s(&d.0), LOCAL_DIR_SIZE_MAX_ENTRIES, &AtomicBool::new(false)).expect("size"), got);
    }

    #[test]
    fn dropping_a_scan_stops_its_walk() {
        let flag = Arc::new(AtomicBool::new(false));
        drop(StopOnDrop(flag.clone()));
        assert!(flag.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn dir_size_scans_are_cancellable_by_id() {
        let d = ScratchDir::new("local-size-cancel");
        tree(&d.0);
        let scans = Arc::new(LocalDirSizes::new());
        // Hold every slot so the scans wait (deterministically) until released.
        let held = scans.slots.acquire_many(LOCAL_DIR_SIZE_PARALLEL as u32).await.expect("slots");
        let spawn = |id: &'static str| {
            let (scans, p) = (scans.clone(), s(&d.0));
            tokio::spawn(async move { scans.run(id, p).await })
        };
        let a = spawn("x");
        let other = spawn("y");
        while scans.running() < 2 {
            tokio::task::yield_now().await;
        }
        // A newer call with the same id cancels the older one.
        let b = spawn("x");
        assert!(a.await.expect("join").expect_err("replaced").is_cancelled());
        // `cancel` by id.
        scans.cancel("y");
        assert!(other.await.expect("join").expect_err("cancelled").is_cancelled());
        scans.cancel("unknown");
        drop(held);
        assert_eq!(b.await.expect("join").expect("size"), LocalDirSize { files: 3, bytes: 10, truncated: false });
        assert_eq!(scans.running(), 0);
        // The bound applies through the registry too.
        let got = scans.run_with_limit("z", s(&d.0), 1).await.expect("size");
        assert!(got.truncated);
    }

    #[test]
    fn listed_dirs_are_bounded_and_deduplicated() {
        let l = ListedDirs::new();
        for i in 0..LISTED_DIRS_MAX + 5 {
            l.record(PathBuf::from(format!("/d/{i}")));
        }
        let snap = l.snapshot();
        assert_eq!(snap.len(), LISTED_DIRS_MAX);
        assert_eq!(snap[0], PathBuf::from("/d/5"));
        l.record(PathBuf::from("/d/5"));
        let snap = l.snapshot();
        assert_eq!(snap.len(), LISTED_DIRS_MAX);
        assert_eq!(snap.last(), Some(&PathBuf::from("/d/5")));
        assert_eq!(snap[0], PathBuf::from("/d/6"));
    }

    #[test]
    fn roots_include_home_and_a_drive() {
        let r = roots();
        assert!(r.iter().any(|x| x.kind == LocalRootKind::Home));
        assert!(r.iter().any(|x| x.kind == LocalRootKind::Drive));
        let v = serde_json::to_value(LocalRootKind::Folder).expect("ser");
        assert_eq!(v, "folder");
        if cfg!(windows) {
            assert!(r.iter().any(|x| x.path == r"C:\" && x.label == "C:"), "{r:?}");
        }
        assert!(r.iter().all(|x| Path::new(&x.path).is_absolute()));
        let v = serde_json::to_value(&r[0]).expect("ser");
        assert_eq!(v["kind"], "drive");
    }
}
