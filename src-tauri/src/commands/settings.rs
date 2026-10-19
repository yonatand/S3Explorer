use tauri::State;

use crate::error::{AppError, AppResult, ErrorCode};
use crate::models::AppSettings;
use crate::state::AppState;

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> AppResult<AppSettings> {
    Ok(state.get_settings())
}

/// Takes raw JSON so a non-integer or missing field comes back as `InvalidInput` naming the field
/// (typed deserialization would fail before the command runs, with a generic Tauri error).
#[tauri::command]
pub async fn update_settings(state: State<'_, AppState>, settings: serde_json::Value) -> AppResult<AppSettings> {
    let settings = AppSettings::from_json_strict(&settings)?;
    state.update_settings(settings).await
}

/// v0.9.0: the main window's icon (title bar and taskbar / Alt+Tab) in the accent colour, from the
/// icons bundled in the executable. `accent` is taken as a string so an unknown one is
/// `InvalidInput` (see `window_icon::parse_accent`). v0.9.1: on Windows the window class icons are
/// replaced too and the taskbar button is refreshed (see `window_icon::apply`).
#[tauri::command]
pub async fn set_window_icon(app: tauri::AppHandle, accent: String) -> AppResult<()> {
    use tauri::Manager;
    let accent = crate::window_icon::parse_accent(&accent)?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::new(ErrorCode::Unknown, "The main window is not open"))?;
    #[cfg(windows)]
    {
        // Win32 icon calls belong on the window's own thread.
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(crate::window_icon::apply(&window, accent));
        })
        .map_err(|e| AppError::new(ErrorCode::Unknown, format!("Could not set the window icon: {e}")))?;
        rx.await.map_err(|_| AppError::new(ErrorCode::Unknown, "Could not set the window icon"))?
    }
    #[cfg(not(windows))]
    {
        let _ = &app;
        crate::window_icon::apply(&window, accent)
    }
}

/// v0.9.0: the request parsed from this process's command line, once (`null` afterwards and when
/// there was none). An invalid command line never gets here: the app exits with the usage first.
#[tauri::command]
pub async fn take_launch_request(
    launch: State<'_, crate::launch::LaunchState>,
) -> AppResult<Option<crate::launch::LaunchRequest>> {
    Ok(launch.take())
}
