use std::path::PathBuf;

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::models::Transfer;
use crate::state::AppState;

#[tauri::command]
pub async fn start_download(
    state: State<'_, AppState>,
    bucket: String,
    key: String,
    dest_path: String,
) -> AppResult<String> {
    if key.is_empty() || key.ends_with('/') {
        return Err(AppError::invalid("A file key is required"));
    }
    if dest_path.trim().is_empty() {
        return Err(AppError::invalid("Destination path is required"));
    }
    let client = state.client_for_bucket(&bucket).await?;
    state.transfers.start_download(client, &bucket, &key, PathBuf::from(dest_path))
}

#[tauri::command]
pub async fn start_upload(
    state: State<'_, AppState>,
    bucket: String,
    key: String,
    src_path: String,
) -> AppResult<String> {
    if key.is_empty() || key.ends_with('/') {
        return Err(AppError::invalid("A file key is required"));
    }
    if src_path.trim().is_empty() {
        return Err(AppError::invalid("Source path is required"));
    }
    let client = state.client_for_bucket(&bucket).await?;
    Ok(state.transfers.start_upload(client, &bucket, &key, PathBuf::from(src_path)))
}

#[tauri::command]
pub async fn cancel_transfer(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.transfers.cancel(&id)
}

#[tauri::command]
pub async fn remove_transfer(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.transfers.remove(&id)
}

#[tauri::command]
pub async fn list_transfers(state: State<'_, AppState>) -> AppResult<Vec<Transfer>> {
    Ok(state.transfers.list())
}

/// Opens a finished download: a file with its default application, a folder in the file manager
/// (the `fileManagerCommand` override when set); see [`crate::local_open::resolve`] for what is
/// accepted.
#[tauri::command]
pub async fn open_local(app: tauri::AppHandle, state: State<'_, AppState>, path: String) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let (transfers, batches) = (state.transfers.list(), state.batches.list());
    let command = state.get_settings().file_manager_command;
    // Checking and opening both touch the file system and the shell: a blocking thread, never the runtime.
    tokio::task::spawn_blocking(move || {
        let real = crate::local_open::resolve(&path, &transfers, &batches)?;
        if let (true, Some(command)) = (real.is_dir(), command.as_deref()) {
            return crate::file_manager::launch(command, &real);
        }
        app.opener()
            .open_path(real.to_string_lossy().into_owned(), None::<&str>)
            .map_err(|e| AppError::new(crate::error::ErrorCode::Io, format!("Could not open {}: {e}", real.display())))
    })
    .await?
}

/// Shows `path` in the file manager: the system one (with the item selected) when `command` is
/// `None`, otherwise that program. Blocking.
fn reveal_with(app: &tauri::AppHandle, command: Option<&str>, path: &str) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let p = std::path::Path::new(path);
    if path.trim().is_empty() || !p.is_absolute() {
        return Err(AppError::invalid(format!("An absolute local path is required: {path}")));
    }
    match command {
        Some(command) => crate::file_manager::launch(command, p),
        None => app
            .opener()
            .reveal_item_in_dir(p)
            .map_err(|e| AppError::new(crate::error::ErrorCode::Io, format!("Could not show {path}: {e}"))),
    }
}

/// "Show in folder": the saved `fileManagerCommand`, or the system file manager.
#[tauri::command]
pub async fn reveal_local(app: tauri::AppHandle, state: State<'_, AppState>, path: String) -> AppResult<()> {
    let command = state.get_settings().file_manager_command;
    tokio::task::spawn_blocking(move || reveal_with(&app, command.as_deref(), &path)).await?
}

/// Like [`reveal_local`] with an unsaved command (the Settings "Try it" button).
#[tauri::command]
pub async fn try_file_manager(app: tauri::AppHandle, command: Option<String>, path: String) -> AppResult<()> {
    let command = crate::models::normalize_file_manager_command(command.as_deref())?;
    tokio::task::spawn_blocking(move || reveal_with(&app, command.as_deref(), &path)).await?
}
