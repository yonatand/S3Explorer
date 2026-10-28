//! S3 Explorer backend.
//!
//! S3 logic lives in plain modules (`ops`, `state`, `transfers`, `jobs`) that only need an
//! `aws_sdk_s3::Client` and a progress sink ([`transfers::ProgressSink`], [`jobs::JobSink`]);
//! the Tauri glue is in `commands`.

pub mod archive;
pub mod aws_login;
pub mod batches;
pub mod buckets;
pub mod commands;
pub mod error;
pub mod file_manager;
pub mod folder_size;
pub mod jobs;
pub mod keychain;
pub mod launch;
pub mod lifecycle;
pub mod local_fs;
pub mod local_open;
pub mod metadata;
pub mod models;
pub mod ops;
pub mod preview;
pub mod profiles;
pub mod saved;
pub mod search;
pub mod settings;
#[cfg(windows)]
pub mod shell_link;
pub mod state;
pub mod tags;
#[cfg(test)]
pub(crate) mod testutil;
pub mod transfers;
pub mod updates;
pub mod versions;
pub mod window_icon;
mod windows_shell;

use std::sync::Arc;

use tauri::{Emitter, Manager};

use crate::batches::BatchSink;
use crate::jobs::JobSink;
use crate::keychain::OsKeychain;
use crate::models::{Batch, Job, Transfer, BATCH_PROGRESS_EVENT, JOB_PROGRESS_EVENT, TRANSFER_PROGRESS_EVENT};
use crate::buckets::AddedBucketStore;
use crate::saved::ConnectionStore;
use crate::settings::SettingsStore;
use crate::state::AppState;
use crate::transfers::ProgressSink;
use crate::updates::UpdaterState;

/// Forwards transfer snapshots to the webview as `transfer:progress` events.
struct TauriSink(tauri::AppHandle);

impl ProgressSink for TauriSink {
    fn emit(&self, transfer: &Transfer) {
        let _ = self.0.emit(TRANSFER_PROGRESS_EVENT, transfer);
    }
}

/// Forwards job snapshots to the webview as `job:progress` events.
struct TauriJobSink(tauri::AppHandle);

impl JobSink for TauriJobSink {
    fn emit(&self, job: &Job) {
        let _ = self.0.emit(JOB_PROGRESS_EVENT, job);
    }
}

/// Forwards batch snapshots to the webview as `batch:progress` events.
struct TauriBatchSink(tauri::AppHandle);

impl BatchSink for TauriBatchSink {
    fn emit(&self, batch: &Batch) {
        let _ = self.0.emit(BATCH_PROGRESS_EVENT, batch);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The command line first: `--help` and an invalid command line end here, before any window.
    let args: Vec<String> = std::env::args_os().skip(1).map(|a| a.to_string_lossy().into_owned()).collect();
    let cwd = std::env::current_dir().unwrap_or_default();
    let launch_request = match launch::parse(&args, &cwd) {
        Ok(launch::Parsed::Help) => {
            launch::print(launch::USAGE, false);
            std::process::exit(0);
        }
        Ok(launch::Parsed::Request(r)) => r,
        Err(reason) => {
            launch::print(&format!("s3explorer: {reason}\n\n{}", launch::USAGE), true);
            std::process::exit(2);
        }
    };
    let context = tauri::generate_context!();
    // Before any window exists, so the taskbar ties every window to the installed shortcuts.
    windows_shell::set_app_user_model_id(&context.config().identifier);
    tauri::Builder::default()
        // First plugin, as the plugin requires: a second launch hands its command line over and exits.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            let args: Vec<String> = argv.into_iter().skip(1).collect();
            match launch::parse(&args, std::path::Path::new(&cwd)) {
                Ok(launch::Parsed::Request(Some(req))) => {
                    let _ = app.emit(launch::LAUNCH_OPEN_EVENT, req);
                }
                Ok(_) => {}
                // The second process already refused an invalid command line; never crash over one.
                Err(reason) => eprintln!("Ignored the command line of a second launch: {reason}"),
            }
        }))
        .manage(launch::LaunchState::new(launch_request))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let sink: Arc<dyn ProgressSink> = Arc::new(TauriSink(app.handle().clone()));
            let job_sink: Arc<dyn JobSink> = Arc::new(TauriJobSink(app.handle().clone()));
            let batch_sink: Arc<dyn BatchSink> = Arc::new(TauriBatchSink(app.handle().clone()));
            // Never fail startup over settings or saved connections: no config dir means in-memory.
            let config_dir = app.path().app_config_dir().ok();
            let store = match &config_dir {
                Some(dir) => SettingsStore::load(dir.join(settings::SETTINGS_FILE)),
                None => SettingsStore::in_memory(Default::default()),
            };
            // v0.9.1: the main window is created hidden (`visible: false` in tauri.conf.json) so
            // its first icon is already the saved accent's: the taskbar never shows another one
            // first. Shown whatever happens with the icon.
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = window_icon::apply(&window, store.get().accent) {
                    eprintln!("{}", e.message);
                    // At least the large icon of this executable, as before v0.9.1.
                    windows_shell::set_taskbar_icons(app);
                }
                if let Err(e) = window.show() {
                    eprintln!("Could not show the main window: {e}");
                }
            }
            let keychain = Arc::new(OsKeychain::new());
            let connections = match &config_dir {
                Some(dir) => ConnectionStore::load(dir.join(saved::CONNECTIONS_FILE), keychain),
                None => ConnectionStore::in_memory(keychain),
            };
            let added = match &config_dir {
                Some(dir) => AddedBucketStore::load(dir.join(buckets::ADDED_BUCKETS_FILE)),
                None => AddedBucketStore::in_memory(),
            };
            app.manage(AppState::new(sink, job_sink, batch_sink, store));
            app.manage(added);
            app.manage(connections);
            app.manage(UpdaterState::default());
            app.manage(commands::aws_login::AwsLoginState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connection::list_profiles,
            commands::connection::connect,
            commands::connection::disconnect,
            commands::connection::connection_status,
            commands::aws_login::start_aws_login,
            commands::aws_login::cancel_aws_login,
            commands::browse::list_buckets,
            commands::browse::list_objects,
            commands::browse::list_recent,
            commands::browse::head_object,
            commands::browse::preview_object,
            commands::folders::create_folder,
            commands::transfers::start_download,
            commands::transfers::start_upload,
            commands::transfers::cancel_transfer,
            commands::transfers::pause_transfer,
            commands::transfers::resume_transfer,
            commands::transfers::remove_transfer,
            commands::transfers::list_transfers,
            commands::batches::preview_batch,
            commands::batches::start_batch,
            commands::batches::cancel_batch,
            commands::batches::pause_batch,
            commands::batches::resume_batch,
            commands::batches::remove_batch,
            commands::batches::list_batches,
            commands::jobs::preview_job,
            commands::jobs::start_job,
            commands::jobs::cancel_job,
            commands::jobs::remove_job,
            commands::jobs::list_jobs,
            commands::settings::get_settings,
            commands::settings::update_settings,
            commands::settings::set_window_icon,
            commands::settings::take_launch_request,
            commands::saved::list_saved_connections,
            commands::saved::save_connection,
            commands::saved::delete_saved_connection,
            commands::saved::connect_saved,
            commands::updates::check_for_update,
            commands::updates::install_update,
            commands::buckets::list_added_buckets,
            commands::buckets::add_bucket,
            commands::buckets::remove_added_bucket,
            commands::tags::get_bucket_tags,
            commands::tags::put_bucket_tags,
            commands::tags::get_object_tags,
            commands::tags::put_object_tags,
            commands::metadata::update_object_metadata,
            commands::lifecycle::get_lifecycle,
            commands::lifecycle::validate_lifecycle,
            commands::lifecycle::put_lifecycle,
            commands::lifecycle::get_bucket_versioning,
            commands::versions::list_object_versions,
            commands::versions::download_object_version,
            commands::versions::restore_object_version,
            commands::versions::delete_object_version,
            commands::versions::restore_object,
            commands::search::search_objects,
            commands::search::cancel_search,
            commands::folder_size::folder_size,
            commands::folder_size::cancel_folder_size,
            commands::transfers::open_local,
            commands::transfers::reveal_local,
            commands::transfers::try_file_manager,
            commands::files::write_text_file,
            commands::files::read_text_file,
            commands::local::list_local_roots,
            commands::local::list_local_dir,
            commands::local::create_local_dir,
            commands::local::rename_local,
            commands::local::trash_local,
            commands::local::local_dir_size,
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            // Nothing survives a restart: cancel every running, queued or paused transfer, folder
            // transfer and job, so no multipart upload or temp file is left behind (abort what you
            // start). Bounded by EXIT_WAIT.
            if let tauri::RunEvent::Exit = event {
                // A running `aws login` is killed with the app (kill_on_drop alone needs the task to drop).
                if let Some(login) = app.try_state::<commands::aws_login::AwsLoginState>() {
                    tauri::async_runtime::block_on(login.0.cancel_any_and_wait(AWS_LOGIN_EXIT_WAIT));
                }
                if let Some(state) = app.try_state::<AppState>() {
                    tauri::async_runtime::block_on(state.cancel_active_and_wait(EXIT_WAIT));
                }
            }
        });
}

/// How long app exit waits for a running `aws login` to be killed.
const AWS_LOGIN_EXIT_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// How long app exit waits for active transfers and jobs to clean up.
const EXIT_WAIT: std::time::Duration = std::time::Duration::from_secs(10);
