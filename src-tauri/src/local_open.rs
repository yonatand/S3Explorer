//! `open_local`: which local paths the app may open with the OS default application.
//!
//! Only what the app itself downloaded: the `localPath` of a completed download transfer, or the
//! folder of a finished download batch that wrote at least one file. Never a file type that could
//! run as a program, and never through a link that leaves the recorded destination folder.

use std::path::{Path, PathBuf};

use crate::batches::localname::fold_with;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::models::{Batch, BatchKind, Transfer, TransferKind, TransferStatus};

/// Extensions `open_local` refuses (case-insensitive); mirrors `OPEN_LOCAL_REFUSED_EXTENSIONS`.
pub const REFUSED_EXTENSIONS: [&str; 46] = [
    "exe", "bat", "cmd", "com", "scr", "pif", "cpl", "msc", "hta", "chm", "scf", "ps1", "psm1", "msi", "msp", "mst",
    "vbs", "vbe", "js", "jse", "ws", "wsf", "wsh", "wsc", "jar", "xll", "jnlp", "gadget", "application", "appref-ms",
    "settingcontent-ms", "diagcab", "library-ms", "search-ms", "py", "pyw", "sh", "command", "app", "terminal",
    "fileloc", "inetloc", "desktop", "reg", "lnk", "url",
];

pub const NOT_A_DOWNLOAD: &str = "Not a finished download";

/// Whether the file name ends in a refused extension. Trailing dots and spaces are ignored first
/// (Windows drops them, so `a.exe.` runs as `a.exe`); a dotfile like `.bashrc` has no extension.
pub fn refused_extension(path: &Path) -> bool {
    let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else { return false };
    let name = name.trim_end_matches(['.', ' ']);
    let ext = Path::new(name).extension().map(|e| e.to_string_lossy().to_ascii_lowercase());
    ext.is_some_and(|e| REFUSED_EXTENSIONS.contains(&e.as_str()))
}

fn refused_message(path: &Path) -> String {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string());
    format!("{name} could be run as a program; use Show in folder")
}

/// A canonical path without the Windows verbatim prefix (`\\?\C:\x` -> `C:\x`,
/// `\\?\UNC\srv\share` -> `\\srv\share`), so both sides compare alike and the shell accepts it.
pub fn plain(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p.to_path_buf()
    }
}

/// The comparison form: case folded where the file system ignores case.
fn folded(p: &Path) -> PathBuf {
    PathBuf::from(fold_with(&p.to_string_lossy(), cfg!(any(windows, target_os = "macos")), cfg!(target_os = "macos")))
}

fn canonical(p: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(p).ok().map(|c| plain(&c))
}

/// A path the app may open, with the folder it must stay inside.
struct Allowed {
    path: PathBuf,
    /// The recorded destination folder: the parent folder of the download or of the batch folder.
    root: PathBuf,
}

fn allowed(transfers: &[Transfer], batches: &[Batch]) -> Vec<Allowed> {
    let files = transfers
        .iter()
        .filter(|t| t.kind == TransferKind::Download && t.status == TransferStatus::Completed)
        .filter_map(|t| {
            let path = PathBuf::from(&t.local_path);
            let root = path.parent().filter(|p| !p.as_os_str().is_empty())?.to_path_buf();
            Some(Allowed { path, root })
        });
    let folders = batches
        .iter()
        .filter(|b| b.kind == BatchKind::Download && !b.status.is_active() && b.done_files > 0)
        .map(|b| {
            let path = PathBuf::from(&b.local_path);
            // The parent of the batch folder: a batch folder replaced by a link is refused too.
            let root = path.parent().filter(|p| !p.as_os_str().is_empty()).map_or_else(|| path.clone(), Path::to_path_buf);
            Allowed { path, root }
        });
    files.chain(folders).collect()
}

/// Checks `requested` against the finished downloads and returns the canonical path to open.
/// Blocking (file system); call through `spawn_blocking`.
pub fn resolve(requested: &str, transfers: &[Transfer], batches: &[Batch]) -> AppResult<PathBuf> {
    let req = Path::new(requested);
    if requested.trim().is_empty() || !req.is_absolute() {
        return Err(AppError::invalid(NOT_A_DOWNLOAD));
    }
    // Refuse by the name asked for before touching the disk.
    if refused_extension(req) {
        return Err(AppError::new(ErrorCode::NotSupported, refused_message(req)));
    }
    let candidates = allowed(transfers, batches);
    let Some(real) = canonical(req) else {
        // A finished download that is gone from the disk gets a clearer message.
        let known = candidates.iter().any(|a| folded(&a.path) == folded(req));
        return Err(AppError::invalid(if known {
            format!("{requested} no longer exists")
        } else {
            NOT_A_DOWNLOAD.to_string()
        }));
    };
    let real_cmp = folded(&real);
    let Some(hit) = candidates.iter().find(|a| canonical(&a.path).is_some_and(|c| folded(&c) == real_cmp)) else {
        return Err(AppError::invalid(NOT_A_DOWNLOAD));
    };
    // Never through a link that leaves the recorded folder.
    let inside = canonical(&hit.root).is_some_and(|root| real_cmp.starts_with(folded(&root)));
    if !inside {
        return Err(AppError::invalid(format!(
            "{NOT_A_DOWNLOAD}: {requested} leads outside {} (a link to another location)",
            hit.root.display()
        )));
    }
    // And by what it really is (a link inside the folder could point at a program).
    if refused_extension(&real) {
        return Err(AppError::new(ErrorCode::NotSupported, refused_message(&real)));
    }
    Ok(real)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::BatchStatus;
    use crate::testutil::{dir_link, ScratchDir};

    #[test]
    fn refused_extensions() {
        for name in [
            "a.exe", "A.EXE", "setup.Msi", "x.ps1", "x.PSM1", "run.sh", "f.js", "short.lnk", "web.URL", "My.App", "a.exe.",
            "a.exe . ", "archive.tar.jar",
        ] {
            assert!(refused_extension(Path::new(name)), "{name}");
        }
        for name in [
            "a.txt", "README", ".bashrc", ".exe", "exe", "a.exe.txt", "photo.jpeg", "a.json", "notes.shx", "x.", "", "dir/",
        ] {
            assert!(!refused_extension(Path::new(name)), "{name}");
        }
        assert!(refused_extension(Path::new("C:/dl/tool.Bat")));
        assert_eq!(REFUSED_EXTENSIONS.len(), 46);
        for name in ["a.PIF", "x.hta", "y.appref-ms", "z.settingcontent-ms", "s.Py", "t.pyw", "u.terminal", "v.desktop", "w.inetloc"] {
            assert!(refused_extension(Path::new(name)), "{name}");
        }
    }

    /// The list is exactly `OPEN_LOCAL_REFUSED_EXTENSIONS` in `src/lib/types.ts`, in the same order.
    #[test]
    fn refused_extensions_match_the_contract() {
        let ts = include_str!("../../src/lib/types.ts");
        let start = ts.find("OPEN_LOCAL_REFUSED_EXTENSIONS = [").expect("constant in types.ts");
        let body = &ts[start..];
        let body = &body[body.find('[').expect("[") + 1..body.find(']').expect("]")];
        let listed: Vec<&str> = body.split(',').map(|s| s.trim().trim_matches('"')).filter(|s| !s.is_empty()).collect();
        assert_eq!(listed, REFUSED_EXTENSIONS);
    }

    #[test]
    fn plain_strips_the_verbatim_prefix() {
        assert_eq!(plain(Path::new(r"\\?\C:\dl\a.txt")), PathBuf::from(r"C:\dl\a.txt"));
        assert_eq!(plain(Path::new(r"\\?\UNC\srv\share\a")), PathBuf::from(r"\\srv\share\a"));
        assert_eq!(plain(Path::new("/home/u/a")), PathBuf::from("/home/u/a"));
    }

    fn transfer(path: &Path, status: TransferStatus, kind: TransferKind) -> Transfer {
        Transfer {
            id: "t".into(),
            kind,
            batch_id: None,
            bucket: "b".into(),
            key: "k".into(),
            local_path: path.to_string_lossy().into_owned(),
            total_bytes: 1,
            transferred_bytes: 1,
            parts_total: 1,
            parts_done: 1,
            bytes_per_sec: 0,
            status,
            error: None,
            started_at: String::new(),
            finished_at: None,
        }
    }

    fn batch(path: &Path, status: BatchStatus, done_files: u64) -> Batch {
        Batch {
            id: "x".into(),
            kind: BatchKind::Download,
            bucket: "b".into(),
            prefix: "p/".into(),
            local_path: path.to_string_lossy().into_owned(),
            label: String::new(),
            total_files: 1,
            done_files,
            skipped_files: 0,
            failed_files: 0,
            total_bytes: 0,
            done_bytes: 0,
            bytes_per_sec: 0,
            status,
            error: None,
            errors: Vec::new(),
            started_at: String::new(),
            finished_at: None,
        }
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn only_finished_downloads_open() {
        let dir = ScratchDir::new("open-local");
        let file = dir.0.join("report.txt");
        std::fs::write(&file, b"x").expect("write");
        let prog = dir.0.join("tool.exe");
        std::fs::write(&prog, b"x").expect("write");
        let folder = dir.0.join("photos");
        std::fs::create_dir(&folder).expect("mkdir");

        let done = vec![transfer(&file, TransferStatus::Completed, TransferKind::Download)];
        let opened = resolve(&s(&file), &done, &[]).expect("completed download");
        assert!(opened.ends_with("report.txt"));
        assert!(!opened.to_string_lossy().starts_with(r"\\?\"), "{}", opened.display());
        // Case-insensitive where the file system is.
        if cfg!(windows) {
            assert!(resolve(&s(&file).to_uppercase(), &done, &[]).is_ok());
        }
        // Any other state, an upload, or a file not in the list.
        for (status, kind) in [
            (TransferStatus::Running, TransferKind::Download),
            (TransferStatus::Failed, TransferKind::Download),
            (TransferStatus::Cancelled, TransferKind::Download),
            (TransferStatus::Completed, TransferKind::Upload),
        ] {
            let e = resolve(&s(&file), &[transfer(&file, status, kind)], &[]).unwrap_err();
            assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, NOT_A_DOWNLOAD), "{status:?} {kind:?}");
        }
        assert_eq!(resolve(&s(&dir.0.join("other.txt")), &done, &[]).unwrap_err().code, ErrorCode::InvalidInput);
        assert_eq!(resolve("relative.txt", &done, &[]).unwrap_err().code, ErrorCode::InvalidInput);
        // A completed download of a program is refused as NotSupported.
        let e = resolve(&s(&prog), &[transfer(&prog, TransferStatus::Completed, TransferKind::Download)], &[]).unwrap_err();
        assert_eq!(e.code, ErrorCode::NotSupported);
        assert_eq!(e.message, "tool.exe could be run as a program; use Show in folder");
        // A finished download that was deleted since.
        std::fs::remove_file(&file).expect("rm");
        let e = resolve(&s(&file), &done, &[]).unwrap_err();
        assert!(e.message.contains("no longer exists"), "{}", e.message);

        // Folder downloads: finished with files done; not active, not with nothing done.
        assert!(resolve(&s(&folder), &[], &[batch(&folder, BatchStatus::Completed, 3)]).is_ok());
        assert!(resolve(&s(&folder), &[], &[batch(&folder, BatchStatus::Failed, 1)]).is_ok());
        for b in [batch(&folder, BatchStatus::Running, 3), batch(&folder, BatchStatus::Completed, 0)] {
            assert_eq!(resolve(&s(&folder), &[], &[b]).unwrap_err().code, ErrorCode::InvalidInput);
        }
        // A folder path is not a file download's path.
        assert!(resolve(&s(&dir.0), &done, &[]).is_err());
    }

    #[test]
    fn never_through_a_link_that_leaves_the_folder() {
        let dir = ScratchDir::new("open-local-link");
        let outside = ScratchDir::new("open-local-outside");
        std::fs::write(outside.0.join("secret.txt"), b"x").expect("write");
        // The recorded download path is a link (junction) to a folder outside its parent.
        let link = dir.0.join("looks-like-a-download");
        dir_link(&link, &outside.0);
        let rec = vec![transfer(&link, TransferStatus::Completed, TransferKind::Download)];
        let e = resolve(&s(&link), &rec, &[]).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidInput);
        assert!(e.message.contains("a link to another location"), "{}", e.message);
        // The target, asked for directly, is not a recorded download either.
        assert!(resolve(&s(&outside.0), &rec, &[]).is_err());
    }

    #[test]
    fn a_batch_folder_replaced_by_a_link_is_refused() {
        let dir = ScratchDir::new("open-local-batch-link");
        let outside = ScratchDir::new("open-local-batch-outside");
        // The recorded batch folder is now a junction to somewhere else.
        let batch_dir = dir.0.join("photos");
        dir_link(&batch_dir, &outside.0);
        let rec = [batch(&batch_dir, BatchStatus::Completed, 2)];
        let e = resolve(&s(&batch_dir), &[], &rec).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidInput);
        assert!(e.message.contains("a link to another location"), "{}", e.message);
        // A plain batch folder still opens, and a folder named like a program is refused.
        let plain_dir = dir.0.join("plain");
        std::fs::create_dir(&plain_dir).expect("mkdir");
        assert!(resolve(&s(&plain_dir), &[], &[batch(&plain_dir, BatchStatus::Completed, 1)]).is_ok());
        let app_dir = dir.0.join("Tool.app");
        std::fs::create_dir(&app_dir).expect("mkdir");
        let e = resolve(&s(&app_dir), &[], &[batch(&app_dir, BatchStatus::Completed, 1)]).unwrap_err();
        assert_eq!(e.code, ErrorCode::NotSupported);
    }
}
