//! `start_aws_login` / `cancel_aws_login` (v0.9.3): "Sign in again" for an expired profile.

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::aws_login::{
    self, AwsLoginDone, AwsLoginKind, AwsLoginOutput, AwsLoginRunner, AwsLoginSink, AwsLoginStarted,
    AWS_LOGIN_DONE_EVENT, AWS_LOGIN_OUTPUT_EVENT,
};
use crate::error::AppResult;

/// The app's one sign-in runner (managed state).
#[derive(Default)]
pub struct AwsLoginState(pub Arc<AwsLoginRunner>);

struct TauriAwsLoginSink(AppHandle);

impl AwsLoginSink for TauriAwsLoginSink {
    fn output(&self, output: &AwsLoginOutput) {
        let _ = self.0.emit(AWS_LOGIN_OUTPUT_EVENT, output);
    }
    fn done(&self, done: &AwsLoginDone) {
        let _ = self.0.emit(AWS_LOGIN_DONE_EVENT, done);
    }
}

#[tauri::command]
pub async fn start_aws_login(
    app: AppHandle,
    state: State<'_, AwsLoginState>,
    profile: String,
    kind: AwsLoginKind,
) -> AppResult<AwsLoginStarted> {
    aws_login::validate_profile(&profile)?;
    let exe = tokio::task::spawn_blocking(aws_login::find_aws).await??;
    let sink: Arc<dyn AwsLoginSink> = Arc::new(TauriAwsLoginSink(app));
    let run_id = state.0.start(&exe, kind, &profile, sink)?;
    Ok(AwsLoginStarted { run_id })
}

#[tauri::command]
pub async fn cancel_aws_login(state: State<'_, AwsLoginState>, run_id: String) -> AppResult<()> {
    state.0.cancel(&run_id);
    Ok(())
}
