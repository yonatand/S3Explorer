//! "Sign in again" from the connect screen (v0.9.3): runs `aws login` / `aws sso login` for a
//! profile and streams what the CLI prints, so the user sees the URL and code it shows. The CLI
//! opens the browser and writes its own cache; the app never handles credentials.
//!
//! One run at a time, bounded by [`AWS_LOGIN_TIMEOUT`]. No shell: the `aws` executable is resolved
//! with the file manager's lookup rules and started directly with fixed arguments.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::sync::oneshot;

use crate::error::{AppError, AppResult, ErrorCode};

pub const AWS_LOGIN_OUTPUT_EVENT: &str = "aws-login:output";
pub const AWS_LOGIN_DONE_EVENT: &str = "aws-login:done";

/// A run is killed after this long (`AWS_LOGIN_TIMEOUT_MS` in `src/lib/types.ts`).
pub const AWS_LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// After the process ended, how long the pipe readers may still drain (a grandchild can hold them open).
const DRAIN_WAIT: Duration = Duration::from_secs(2);

/// Longest line forwarded, in characters; the rest of the line is dropped.
const MAX_LINE_CHARS: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AwsLoginKind {
    /// `aws login` (AWS CLI 2.32+ console sign-in, `login_session` profiles).
    Login,
    /// `aws sso login` (IAM Identity Center).
    Sso,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsLoginStarted {
    pub run_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsLoginOutput {
    pub run_id: String,
    pub line: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsLoginDone {
    pub run_id: String,
    /// `None` when the process was killed (cancelled or timed out) or ended without a code.
    pub exit_code: Option<i32>,
    pub cancelled: bool,
    pub timed_out: bool,
}

/// Where output lines and the final result go (the Tauri event emitter in the app).
pub trait AwsLoginSink: Send + Sync {
    fn output(&self, output: &AwsLoginOutput);
    fn done(&self, done: &AwsLoginDone);
}

/// `[A-Za-z0-9_.-]{1,64}`.
pub fn validate_profile(profile: &str) -> AppResult<()> {
    let ok = !profile.is_empty()
        && profile.len() <= 64
        && profile.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'));
    if ok {
        Ok(())
    } else {
        Err(AppError::invalid(format!("Not a valid profile name: {profile}")))
    }
}

/// The CLI arguments for a run.
pub fn args(kind: AwsLoginKind, profile: &str) -> Vec<String> {
    let mut a: Vec<String> = match kind {
        AwsLoginKind::Login => vec!["login".into()],
        AwsLoginKind::Sso => vec!["sso".into(), "login".into()],
    };
    a.push("--profile".into());
    a.push(profile.to_string());
    a
}

/// The `aws` executable on this process's `PATH` (see [`find_aws_in`]).
pub fn find_aws() -> AppResult<PathBuf> {
    let path = std::env::var_os("PATH");
    let pathext = std::env::var("PATHEXT").ok();
    find_aws_in(path.as_deref(), pathext.as_deref(), cfg!(windows))
}

/// The `aws` executable, with the file manager's lookup rules (absolute `PATH` entries only,
/// `PATHEXT` on Windows, shells refused). Blocking (file system).
pub fn find_aws_in(path_var: Option<&std::ffi::OsStr>, pathext: Option<&str>, windows: bool) -> AppResult<PathBuf> {
    crate::file_manager::find_program_in("aws", path_var, pathext, windows)
        .map_err(|_| AppError::invalid("The AWS CLI is not installed or not on PATH"))
}

struct Current {
    run_id: String,
    cancel: Option<oneshot::Sender<()>>,
}

/// The one sign-in run there may be.
pub struct AwsLoginRunner {
    current: Mutex<Option<Current>>,
    timeout: Duration,
}

impl Default for AwsLoginRunner {
    fn default() -> Self {
        Self::new(AWS_LOGIN_TIMEOUT)
    }
}

impl AwsLoginRunner {
    /// `timeout` is [`AWS_LOGIN_TIMEOUT`] in the app; tests use a short one.
    pub fn new(timeout: Duration) -> Self {
        Self { current: Mutex::new(None), timeout }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Current>> {
        self.current.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn is_running(&self) -> bool {
        self.lock().is_some()
    }

    /// Starts `exe` with [`args`] for `profile`; `Conflict` while another run is active.
    pub fn start(
        self: &Arc<Self>,
        exe: &Path,
        kind: AwsLoginKind,
        profile: &str,
        sink: Arc<dyn AwsLoginSink>,
    ) -> AppResult<String> {
        validate_profile(profile)?;
        let mut current = self.lock();
        if current.is_some() {
            return Err(AppError::new(ErrorCode::Conflict, "A sign-in is already running"));
        }
        let mut cmd = tokio::process::Command::new(exe);
        cmd.args(args(kind, profile))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| AppError::new(ErrorCode::Io, format!("Could not start the AWS CLI ({}): {e}", exe.display())))?;
        let run_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        *current = Some(Current { run_id: run_id.clone(), cancel: Some(tx) });
        drop(current);

        let readers: Vec<_> = [
            child.stdout.take().map(|p| Box::new(p) as Box<dyn AsyncRead + Send + Unpin>),
            child.stderr.take().map(|p| Box::new(p) as Box<dyn AsyncRead + Send + Unpin>),
        ]
        .into_iter()
        .flatten()
        .map(|pipe| tokio::spawn(forward_lines(pipe, run_id.clone(), sink.clone())))
        .collect();

        let this = self.clone();
        let id = run_id.clone();
        let timeout = self.timeout;
        tokio::spawn(async move {
            // Ok(code) when it exited by itself; Err(cancelled) when it is to be killed.
            let ended = tokio::select! {
                status = child.wait() => Ok(status.ok().and_then(|s| s.code())),
                _ = rx => Err(true),
                _ = tokio::time::sleep(timeout) => Err(false),
            };
            let (exit_code, cancelled, timed_out) = match ended {
                Ok(code) => (code, false, false),
                Err(cancelled) => {
                    kill(&mut child).await;
                    (None, cancelled, !cancelled)
                }
            };
            // Let the readers forward what is left, bounded: a grandchild may keep a pipe open.
            for r in readers {
                let abort = r.abort_handle();
                if tokio::time::timeout(DRAIN_WAIT, r).await.is_err() {
                    abort.abort();
                }
            }
            {
                let mut cur = this.lock();
                if cur.as_ref().is_some_and(|c| c.run_id == id) {
                    *cur = None;
                }
            }
            sink.done(&AwsLoginDone { run_id: id, exit_code, cancelled, timed_out });
        });
        Ok(run_id)
    }

    /// Kills the run `run_id`; a no-op when it already ended or is another run.
    pub fn cancel(&self, run_id: &str) {
        let mut cur = self.lock();
        if let Some(c) = cur.as_mut().filter(|c| c.run_id == run_id) {
            if let Some(tx) = c.cancel.take() {
                let _ = tx.send(());
            }
        }
    }

    /// Kills whatever run is active (disconnect, app exit).
    pub fn cancel_any(&self) {
        if let Some(c) = self.lock().as_mut() {
            if let Some(tx) = c.cancel.take() {
                let _ = tx.send(());
            }
        }
    }

    /// [`Self::cancel_any`], then waits up to `limit` for the run to end.
    pub async fn cancel_any_and_wait(&self, limit: Duration) {
        self.cancel_any();
        let deadline = tokio::time::Instant::now() + limit;
        while self.is_running() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

/// Kills the process and, on Windows, its children (a `.cmd` wrapper runs the real program as a
/// child of `cmd.exe`), then reaps it.
async fn kill(child: &mut tokio::process::Child) {
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let root = std::env::var_os("SystemRoot").map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from);
        let taskkill = root.join("System32").join("taskkill.exe");
        let mut tk = tokio::process::Command::new(taskkill);
        tk.args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            tk.creation_flags(CREATE_NO_WINDOW);
        }
        if let Ok(mut p) = tk.spawn() {
            let _ = tokio::time::timeout(Duration::from_secs(5), p.wait()).await;
        }
    }
    let _ = child.kill().await;
}

async fn forward_lines(pipe: Box<dyn AsyncRead + Send + Unpin>, run_id: String, sink: Arc<dyn AwsLoginSink>) {
    let mut reader = BufReader::new(pipe);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let text = String::from_utf8_lossy(&buf);
                let text = text.trim_end_matches(['\r', '\n']);
                let line: String = text.chars().take(MAX_LINE_CHARS).collect();
                sink.output(&AwsLoginOutput { run_id: run_id.clone(), line });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::ScratchDir;

    #[test]
    fn arguments_for_both_kinds() {
        assert_eq!(args(AwsLoginKind::Login, "work"), ["login", "--profile", "work"]);
        assert_eq!(args(AwsLoginKind::Sso, "dev.admin"), ["sso", "login", "--profile", "dev.admin"]);
        assert_eq!(serde_json::to_value(AwsLoginKind::Sso).expect("json"), "sso");
        assert_eq!(serde_json::from_str::<AwsLoginKind>("\"login\"").expect("json"), AwsLoginKind::Login);
        let done = AwsLoginDone { run_id: "r".into(), exit_code: None, cancelled: false, timed_out: true };
        assert_eq!(
            serde_json::to_value(&done).expect("json"),
            serde_json::json!({"runId": "r", "exitCode": null, "cancelled": false, "timedOut": true})
        );
    }

    #[test]
    fn profile_names() {
        for ok in ["default", "a", "dev-admin_2.prod", &"x".repeat(64)] {
            assert!(validate_profile(ok).is_ok(), "{ok}");
        }
        for bad in ["", "two words", "a;b", "a&b", "x\"y", "prof/../x", "ünï", &"x".repeat(65), "a\nb"] {
            let e = validate_profile(bad).expect_err(bad);
            assert_eq!(e.code, ErrorCode::InvalidInput);
        }
    }

    #[test]
    fn missing_cli_is_reported() {
        let d = ScratchDir::new("aws-none");
        let path = std::env::join_paths([d.0.clone()]).expect("join");
        let e = find_aws_in(Some(&path), Some(".EXE;.CMD"), cfg!(windows)).expect_err("none");
        assert_eq!(e.message, "The AWS CLI is not installed or not on PATH");
    }

    #[derive(Default)]
    struct Collect {
        lines: Mutex<Vec<String>>,
        done: Mutex<Option<AwsLoginDone>>,
    }
    impl AwsLoginSink for Collect {
        fn output(&self, o: &AwsLoginOutput) {
            self.lines.lock().expect("lock").push(o.line.clone());
        }
        fn done(&self, d: &AwsLoginDone) {
            *self.done.lock().expect("lock") = Some(d.clone());
        }
    }
    impl Collect {
        async fn wait_done(&self) -> AwsLoginDone {
            for _ in 0..1000 {
                if let Some(d) = self.done.lock().expect("lock").clone() {
                    return d;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            panic!("the run did not finish");
        }
    }

    /// A fake `aws` on a temp PATH: prints its arguments and two lines, then `exit_code`, or sleeps.
    fn fake_aws(behaviour: &str) -> (ScratchDir, PathBuf) {
        let d = ScratchDir::new("aws-fake");
        #[cfg(windows)]
        let (name, body) = (
            "aws.cmd",
            match behaviour {
                "sleep" => "@echo off\r\necho waiting\r\nping -n 60 127.0.0.1 >nul\r\n".to_string(),
                code => format!("@echo off\r\necho args %*\r\n1>&2 echo line two\r\nexit /b {code}\r\n"),
            },
        );
        #[cfg(not(windows))]
        let (name, body) = (
            "aws",
            match behaviour {
                "sleep" => "#!/bin/sh\necho waiting\nexec sleep 60\n".to_string(),
                code => format!("#!/bin/sh\necho args \"$@\"\necho line two 1>&2\nexit {code}\n"),
            },
        );
        std::fs::write(d.0.join(name), body).expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(d.0.join(name), std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        let path = std::env::join_paths([d.0.clone()]).expect("join");
        let exe = find_aws_in(Some(&path), Some(".COM;.EXE;.BAT;.CMD"), cfg!(windows)).expect("found");
        (d, exe)
    }

    #[tokio::test]
    async fn run_prints_and_exits_zero() {
        let (_d, exe) = fake_aws("0");
        let runner = Arc::new(AwsLoginRunner::new(Duration::from_secs(30)));
        let sink = Arc::new(Collect::default());
        let id = runner.start(&exe, AwsLoginKind::Sso, "work", sink.clone()).expect("start");
        let done = sink.wait_done().await;
        assert_eq!(done, AwsLoginDone { run_id: id, exit_code: Some(0), cancelled: false, timed_out: false });
        let mut lines = sink.lines.lock().expect("lock").clone();
        lines.sort();
        assert_eq!(lines, ["args sso login --profile work", "line two"]);
        assert!(!runner.is_running());
    }

    #[tokio::test]
    async fn run_exit_code_is_reported() {
        let (_d, exe) = fake_aws("3");
        let runner = Arc::new(AwsLoginRunner::new(Duration::from_secs(30)));
        let sink = Arc::new(Collect::default());
        runner.start(&exe, AwsLoginKind::Login, "work", sink.clone()).expect("start");
        let done = sink.wait_done().await;
        assert_eq!((done.exit_code, done.cancelled, done.timed_out), (Some(3), false, false));
        assert!(sink.lines.lock().expect("lock").contains(&"args login --profile work".to_string()));
    }

    #[tokio::test]
    async fn run_past_the_timeout_is_killed() {
        let (_d, exe) = fake_aws("sleep");
        let runner = Arc::new(AwsLoginRunner::new(Duration::from_millis(1500)));
        let sink = Arc::new(Collect::default());
        let started = std::time::Instant::now();
        runner.start(&exe, AwsLoginKind::Login, "work", sink.clone()).expect("start");
        let done = sink.wait_done().await;
        assert_eq!((done.exit_code, done.cancelled, done.timed_out), (None, false, true));
        assert!(started.elapsed() < Duration::from_secs(15), "{:?}", started.elapsed());
        assert_eq!(sink.lines.lock().expect("lock").first().map(String::as_str), Some("waiting"));
        assert!(!runner.is_running());
    }

    #[tokio::test]
    async fn one_run_at_a_time_and_cancel() {
        let (_d, exe) = fake_aws("sleep");
        let runner = Arc::new(AwsLoginRunner::new(Duration::from_secs(60)));
        let sink = Arc::new(Collect::default());
        let id = runner.start(&exe, AwsLoginKind::Login, "work", sink.clone()).expect("start");
        let e = runner.start(&exe, AwsLoginKind::Sso, "other", Arc::new(Collect::default())).expect_err("second");
        assert_eq!(e.code, ErrorCode::Conflict);
        // Cancelling another id is a no-op; the right id kills it.
        runner.cancel("not-this-run");
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(runner.is_running());
        runner.cancel(&id);
        let done = sink.wait_done().await;
        assert_eq!(done, AwsLoginDone { run_id: id.clone(), exit_code: None, cancelled: true, timed_out: false });
        runner.cancel(&id); // already ended: no-op
        // A new run may start now; cancel_any_and_wait (disconnect / exit) ends it.
        let sink2 = Arc::new(Collect::default());
        runner.start(&exe, AwsLoginKind::Login, "work", sink2.clone()).expect("start again");
        runner.cancel_any_and_wait(Duration::from_secs(15)).await;
        assert!(!runner.is_running());
        assert!(sink2.wait_done().await.cancelled);
    }
}
