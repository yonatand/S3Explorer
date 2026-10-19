//! v0.9.0 local panes: the local computer's file system (see `crate::local_fs` for the rules).
//! Every file system call runs on a blocking thread, never on the runtime.

use tauri::State;

use crate::error::{AppError, AppResult, ErrorCode};
use crate::local_fs::{self, LocalDirSize, LocalListing, LocalRoot, TrashResult};
use crate::state::AppState;

/// Drives, then (v0.9.1, Windows) the saved Network Locations resolved within 15 s, then home.
#[tauri::command]
pub async fn list_local_roots() -> AppResult<Vec<LocalRoot>> {
    local_fs::roots_with_network().await
}

/// Lists `path` and remembers it (canonical) so `open_local` may open the files shown. On a
/// network location (v0.9.1) the listing fails `Io` after 15 s without reading an entry.
#[tauri::command]
pub async fn list_local_dir(state: State<'_, AppState>, path: String, show_hidden: bool) -> AppResult<LocalListing> {
    let stall = local_fs::stall_bound(&path);
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (listing, canonical) = local_fs::watched(stall, stop, move |hb, stop| {
        let listing = local_fs::list_dir_watched(&path, show_hidden, local_fs::LOCAL_MAX_ENTRIES, hb, stop)?;
        hb.beat();
        AppResult::Ok((listing, local_fs::canonical_dir(&path)))
    })
    .await?;
    if let Some(dir) = canonical {
        state.listed_dirs.record(dir);
    }
    Ok(listing)
}

#[tauri::command]
pub async fn create_local_dir(parent: String, name: String) -> AppResult<()> {
    tokio::task::spawn_blocking(move || local_fs::create_dir(&parent, &name).map(|_| ())).await?
}

#[tauri::command]
pub async fn rename_local(path: String, new_name: String) -> AppResult<()> {
    tokio::task::spawn_blocking(move || local_fs::rename(&path, &new_name).map(|_| ())).await?
}

/// Moves each path to the recycle bin / trash. Runs on a thread of its own: on Windows the trash
/// crate initializes COM on the calling thread, which must not be a shared pool thread that other
/// code may have initialized differently.
#[tauri::command]
pub async fn trash_local(paths: Vec<String>) -> AppResult<TrashResult> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("trash-local".into())
        .spawn(move || {
            let _ = tx.send(local_fs::trash_paths(&paths));
        })
        .map_err(|e| AppError::new(ErrorCode::Io, format!("Could not start the recycle bin operation: {e}")))?;
    rx.await.map_err(|_| AppError::new(ErrorCode::Unknown, "The recycle bin operation stopped unexpectedly"))?
}

/// Files and bytes under `path`, bounded; a newer call with the same `scanId`, or
/// `cancel_folder_size` with it, ends this one `Cancelled`.
#[tauri::command]
pub async fn local_dir_size(state: State<'_, AppState>, path: String, scan_id: String) -> AppResult<LocalDirSize> {
    state.local_dir_sizes.run(&scan_id, path).await
}
