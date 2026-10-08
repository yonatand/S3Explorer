//! S3 Explorer backend.
//!
//! S3 logic lives in plain modules (`ops`, `state`, `transfers`, `jobs`) that only need an
//! `aws_sdk_s3::Client` and a progress sink ([`transfers::ProgressSink`], [`jobs::JobSink`]);
//! the Tauri glue is in `commands`.

pub mod archive;
pub mod batches;
pub mod buckets;
pub mod commands;
pub mod error;
pub mod file_manager;
pub mod jobs;
pub mod keychain;
pub mod lifecycle;
pub mod local_open;
pub mod models;
pub mod ops;
pub mod profiles;
pub mod saved;
pub mod search;
pub mod settings;
pub mod state;
pub mod tags;
#[cfg(test)]
pub(crate) mod testutil;
pub mod transfers;
pub mod updates;
pub mod versions;
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
    let context = tauri::generate_context!();
    // Before any window exists, so the taskbar ties every window to the installed shortcuts.
    windows_shell::set_app_user_model_id(&context.config().identifier);
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // The config windows exist by now; give them the taskbar icon of this executable.
            windows_shell::set_taskbar_icons(app);
            let sink: Arc<dyn ProgressSink> = Arc::new(TauriSink(app.handle().clone()));
            let job_sink: Arc<dyn JobSink> = Arc::new(TauriJobSink(app.handle().clone()));
            let batch_sink: Arc<dyn BatchSink> = Arc::new(TauriBatchSink(app.handle().clone()));
            // Never fail startup over settings or saved connections: no config dir means in-memory.
            let config_dir = app.path().app_config_dir().ok();
            let store = match &config_dir {
                Some(dir) => SettingsStore::load(dir.join(settings::SETTINGS_FILE)),
                None => SettingsStore::in_memory(Default::default()),
            };
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connection::list_profiles,
            commands::connection::connect,
            commands::connection::disconnect,
            commands::connection::connection_status,
            commands::browse::list_buckets,
            commands::browse::list_objects,
            commands::browse::list_recent,
            commands::browse::head_object,
            commands::folders::create_folder,
            commands::transfers::start_download,
            commands::transfers::start_upload,
            commands::transfers::cancel_transfer,
            commands::transfers::remove_transfer,
            commands::transfers::list_transfers,
            commands::batches::preview_batch,
            commands::batches::start_batch,
            commands::batches::cancel_batch,
            commands::batches::remove_batch,
            commands::batches::list_batches,
            commands::jobs::preview_job,
            commands::jobs::start_job,
            commands::jobs::cancel_job,
            commands::jobs::remove_job,
            commands::jobs::list_jobs,
            commands::settings::get_settings,
            commands::settings::update_settings,
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
            commands::transfers::open_local,
            commands::transfers::reveal_local,
            commands::transfers::try_file_manager,
        ])
        .run(context)
        .expect("error while running tauri application");
}
