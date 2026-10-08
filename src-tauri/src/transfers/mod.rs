//! Background transfer manager (parallel ranged downloads, multipart uploads).

mod download;
pub(crate) mod gate;
pub mod plan;
mod upload;

use std::collections::{HashSet, VecDeque};
use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use std::panic::AssertUnwindSafe;

use aws_sdk_s3::Client;
use dashmap::DashMap;
use futures::FutureExt;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use crate::models::{now_iso, Transfer, TransferKind, TransferSettings, TransferStatus};
use gate::RunGate;

pub const MIB: u64 = 1024 * 1024;
const TICK: Duration = Duration::from_millis(100);
const RATE_WINDOW: Duration = Duration::from_secs(2);

/// Receives `Transfer` snapshots (the Tauri app emits them as `transfer:progress`).
pub trait ProgressSink: Send + Sync + 'static {
    fn emit(&self, transfer: &Transfer);
}

/// Told when a transfer that belongs to a batch starts running and when it reaches its final
/// state (called after its final `transfer:progress` event, before its run slot is released).
/// Never called while the transfer's own record is locked.
pub trait TransferObserver: Send + Sync + 'static {
    fn running(&self, transfer_id: &str);
    fn finished(&self, transfer: &Transfer);
}

/// Ties a transfer to its batch: the id it carries (`batchId`), the batch's cancel token (the
/// transfer's own token is a child of it, so cancelling the batch cancels every file, even one
/// started after the cancel) and the observer that aggregates it.
#[derive(Clone)]
pub struct BatchLink {
    pub batch_id: String,
    pub cancel: CancellationToken,
    pub observer: Arc<dyn TransferObserver>,
}

/// A sink that drops every event.
pub struct NoopSink;
impl ProgressSink for NoopSink {
    fn emit(&self, _transfer: &Transfer) {}
}

/// Any closure can be a sink (handy for tests).
impl<F: Fn(&Transfer) + Send + Sync + 'static> ProgressSink for F {
    fn emit(&self, transfer: &Transfer) {
        self(transfer)
    }
}

pub struct TransferEntry {
    seq: u64,
    record: Mutex<Transfer>,
    cancel: CancellationToken,
    finished: CancellationToken,
    transferred: AtomicU64,
    parts_done: AtomicU32,
    /// Parts currently in flight, and the high-water mark (observability for tests).
    parts_in_flight: AtomicUsize,
    peak_parts_in_flight: AtomicUsize,
    /// Part attempts that failed and were retried, and the bytes those attempts had received
    /// but that had to be fetched again (observability for tests and benchmarks).
    part_retries: AtomicU32,
    discarded_bytes: AtomicU64,
    /// Times a download's temp file was flushed to disk (`sync_all`) before the rename.
    file_syncs: AtomicU32,
    observer: Option<Arc<dyn TransferObserver>>,
}

/// Internal counters of one transfer, for tests and benchmarks (not part of the bridge contract).
#[derive(Debug, Clone, Copy, Default)]
pub struct TransferStats {
    pub peak_parts_in_flight: usize,
    pub part_retries: u32,
    pub discarded_bytes: u64,
    pub file_syncs: u32,
}

/// Panics or fails in a test, at a named point of a transfer (see [`TransferTuning::fault`]).
pub type FaultHook = Arc<dyn Fn(&str) + Send + Sync>;

/// Internal knobs, for tests only (never exposed to the UI).
#[doc(hidden)]
#[derive(Clone, Default)]
pub struct TransferTuning {
    /// Replaces the size-scaled per-attempt timeout of body-carrying upload requests.
    pub upload_attempt_timeout: Option<Duration>,
    /// Called with `"download"` / `"upload"` when a transfer starts running.
    pub fault: Option<FaultHook>,
}

/// Counts a part as in flight for its lifetime (see [`TransferEntry::part_started`]).
pub(crate) struct InFlight<'a>(&'a TransferEntry);

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.0.parts_in_flight.fetch_sub(1, Ordering::Relaxed);
    }
}

impl TransferEntry {
    fn lock(&self) -> MutexGuard<'_, Transfer> {
        // A poisoned lock only means another thread panicked mid-update; the data is still usable.
        self.record.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn set_totals(&self, total_bytes: u64, parts_total: u32) {
        let mut r = self.lock();
        r.total_bytes = total_bytes;
        r.parts_total = parts_total;
    }

    fn add_bytes(&self, n: u64) {
        self.transferred.fetch_add(n, Ordering::Relaxed);
    }

    fn note_retry(&self, discarded: u64) {
        self.part_retries.fetch_add(1, Ordering::Relaxed);
        self.discarded_bytes.fetch_add(discarded, Ordering::Relaxed);
    }

    fn part_done(&self) {
        self.parts_done.fetch_add(1, Ordering::Relaxed);
    }

    fn part_started(&self) -> InFlight<'_> {
        let now = self.parts_in_flight.fetch_add(1, Ordering::Relaxed) + 1;
        self.peak_parts_in_flight.fetch_max(now, Ordering::Relaxed);
        InFlight(self)
    }

    /// Copies counters into the record and returns a clone of it.
    fn snapshot(&self) -> Transfer {
        let mut r = self.lock();
        r.transferred_bytes = self.transferred.load(Ordering::Relaxed);
        r.parts_done = self.parts_done.load(Ordering::Relaxed);
        r.clone()
    }

    fn status(&self) -> TransferStatus {
        self.lock().status
    }
}

enum Job {
    /// `no_replace`: fail instead of replacing a file that already exists at `dest` (batch
    /// downloads under `onConflict: skip`); the single-file command replaces it.
    /// `version_id`: download that version instead of the current one (`download_object_version`).
    /// `within`: a folder download's root; the file must stay inside it (no links on the way).
    Download { dest: PathBuf, no_replace: bool, version_id: Option<String>, within: Option<PathBuf> },
    Upload { src: PathBuf },
}

/// The settings a transfer snapshots when it starts running.
#[derive(Debug, Clone, Copy)]
pub(crate) struct PartSettings {
    pub part_size_mib: Option<u32>,
    pub max_parts: usize,
    /// How many body-carrying requests may share the link at most (parts in flight per transfer
    /// x transfers running at once); scales the upload attempt timeout.
    pub link_share: u64,
    /// Test override for the upload attempt timeout.
    pub upload_attempt_timeout: Option<Duration>,
}

impl From<&TransferSettings> for PartSettings {
    fn from(s: &TransferSettings) -> Self {
        let max_parts = (s.max_concurrent_parts as usize).max(1);
        Self {
            part_size_mib: s.part_size_mib,
            max_parts,
            link_share: max_parts as u64 * u64::from(s.max_concurrent_transfers.max(1)),
            upload_attempt_timeout: None,
        }
    }
}

pub struct TransferManager {
    entries: DashMap<String, Arc<TransferEntry>>,
    /// Limits running transfers to `maxConcurrentTransfers`; resizable at runtime (see `gate`).
    running: Arc<RunGate>,
    settings: Mutex<TransferSettings>,
    sink: Arc<dyn ProgressSink>,
    seq: AtomicU64,
    /// Destinations (see [`dest_key`]) of queued/running downloads. The lock also serializes the
    /// "is this destination already being downloaded?" check with the insert. An index rather
    /// than a scan of `entries`: a folder download starts up to 50,000 transfers in a row.
    active_dests: Mutex<HashSet<String>>,
    tuning: TransferTuning,
}

/// Download destinations must be absolute and free of `..` so a crafted key can never
/// steer a write outside the folder the user picked.
fn validate_download_dest(dest: &Path) -> AppResult<()> {
    if dest.as_os_str().is_empty() {
        return Err(AppError::invalid("Destination path is required"));
    }
    if !dest.is_absolute() {
        return Err(AppError::invalid(format!("Destination must be an absolute path: {}", dest.display())));
    }
    if dest.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AppError::invalid(format!("Destination must not contain \"..\": {}", dest.display())));
    }
    Ok(())
}

/// Comparison key for "same local file" (case-insensitive and separator-agnostic on Windows).
/// One form per local file, with the same folding as folder downloads use
/// ([`crate::batches::localname::fold_with`]): case-insensitive on Windows and macOS (NTFS-like
/// per-character mapping), NFC-normalized on macOS.
fn dest_key(path: &str) -> String {
    let path = if cfg!(windows) { path.replace('/', "\\") } else { path.to_string() };
    crate::batches::localname::fold_with(&path, cfg!(any(windows, target_os = "macos")), cfg!(target_os = "macos"))
}

impl TransferManager {
    /// A manager with default settings.
    pub fn new(sink: Arc<dyn ProgressSink>) -> Arc<Self> {
        Self::with_settings(sink, TransferSettings::default())
    }

    pub fn with_settings(sink: Arc<dyn ProgressSink>, settings: TransferSettings) -> Arc<Self> {
        Self::with_tuning(sink, settings, TransferTuning::default())
    }

    #[doc(hidden)]
    pub fn with_tuning(sink: Arc<dyn ProgressSink>, settings: TransferSettings, tuning: TransferTuning) -> Arc<Self> {
        Arc::new(Self {
            entries: DashMap::new(),
            running: RunGate::new(settings.max_concurrent_transfers as usize),
            settings: Mutex::new(settings),
            sink,
            seq: AtomicU64::new(0),
            active_dests: Mutex::new(HashSet::new()),
            tuning,
        })
    }

    /// The settings new transfers will snapshot.
    pub fn settings(&self) -> TransferSettings {
        self.settings.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Applies new settings. Part size / parts in flight affect transfers that start running
    /// from now on; the transfer limit applies to the queue immediately. Callers validate first.
    pub fn apply_settings(&self, settings: &TransferSettings) {
        *self.settings.lock().unwrap_or_else(|p| p.into_inner()) = settings.clone();
        self.running.set_limit(settings.max_concurrent_transfers as usize);
    }

    /// Transfers holding a run slot right now.
    pub fn running_count(&self) -> usize {
        self.running.running()
    }

    /// Highest number of parts this transfer ever had in flight at once.
    pub fn peak_parts_in_flight(&self, id: &str) -> Option<usize> {
        self.entries.get(id).map(|e| e.peak_parts_in_flight.load(Ordering::Relaxed))
    }

    /// Internal counters of a transfer (peak parts in flight, part retries, discarded bytes).
    pub fn stats(&self, id: &str) -> Option<TransferStats> {
        self.entries.get(id).map(|e| TransferStats {
            peak_parts_in_flight: e.peak_parts_in_flight.load(Ordering::Relaxed),
            part_retries: e.part_retries.load(Ordering::Relaxed),
            discarded_bytes: e.discarded_bytes.load(Ordering::Relaxed),
            file_syncs: e.file_syncs.load(Ordering::Relaxed),
        })
    }

    /// Queues a download of `bucket/key` to `dest`. Must be called within a Tokio runtime.
    ///
    /// Rejects (`InvalidInput`) a relative destination, one containing `..`, and one that an
    /// active (queued/running) download already targets.
    pub fn start_download(self: &Arc<Self>, client: Client, bucket: &str, key: &str, dest: PathBuf) -> AppResult<String> {
        self.queue_download(client, bucket, key, dest, false, None, None, None)
    }

    /// Queues a download of one version of `bucket/key` (every request carries `versionId`).
    /// Otherwise as [`Self::start_download`].
    pub fn start_version_download(
        self: &Arc<Self>,
        client: Client,
        bucket: &str,
        key: &str,
        version_id: &str,
        dest: PathBuf,
    ) -> AppResult<String> {
        if version_id.is_empty() {
            return Err(AppError::invalid("versionId is required"));
        }
        self.queue_download(client, bucket, key, dest, false, Some(version_id.to_string()), None, None)
    }

    /// Queues one file of a folder download. With `no_replace` the transfer fails (and leaves
    /// the file untouched) when something already exists at `dest`, checked before the first
    /// request and again atomically at the final rename. Otherwise as [`Self::start_download`].
    #[allow(clippy::too_many_arguments)]
    pub fn start_batch_download(
        self: &Arc<Self>,
        client: Client,
        bucket: &str,
        key: &str,
        dest: PathBuf,
        root: &Path,
        no_replace: bool,
        link: BatchLink,
    ) -> AppResult<String> {
        self.queue_download(client, bucket, key, dest, no_replace, None, Some(link), Some(root.to_path_buf()))
    }

    #[allow(clippy::too_many_arguments)]
    fn queue_download(
        self: &Arc<Self>,
        client: Client,
        bucket: &str,
        key: &str,
        dest: PathBuf,
        no_replace: bool,
        version_id: Option<String>,
        link: Option<BatchLink>,
        within: Option<PathBuf>,
    ) -> AppResult<String> {
        validate_download_dest(&dest)?;
        let local = dest.to_string_lossy().into_owned();
        // Claim the destination, then release the lock before `start`: holding it across the
        // entry insert (a DashMap shard lock) closed a lock cycle with `run_job` (record lock, then
        // this lock) and `list`/`cancel_active` (shard lock, then record lock) that froze the app.
        // The claim alone keeps a second download out; it is released when the transfer ends.
        if !self.active_dests.lock().unwrap_or_else(|p| p.into_inner()).insert(dest_key(&local)) {
            return Err(AppError::invalid(format!(
                "Another download is already writing to {local}. Wait for it to finish or cancel it first."
            )));
        }
        Ok(self.start(client, TransferKind::Download, bucket, key, local, Job::Download { dest, no_replace, version_id, within }, link))
    }

    /// Queues an upload of `src` to `bucket/key`. Must be called within a Tokio runtime.
    pub fn start_upload(self: &Arc<Self>, client: Client, bucket: &str, key: &str, src: PathBuf) -> String {
        let local = src.to_string_lossy().into_owned();
        self.start(client, TransferKind::Upload, bucket, key, local, Job::Upload { src }, None)
    }

    /// Queues one file of a folder upload (see [`BatchLink`]).
    pub fn start_batch_upload(self: &Arc<Self>, client: Client, bucket: &str, key: &str, src: PathBuf, link: BatchLink) -> String {
        let local = src.to_string_lossy().into_owned();
        self.start(client, TransferKind::Upload, bucket, key, local, Job::Upload { src }, Some(link))
    }

    #[allow(clippy::too_many_arguments)]
    fn start(
        self: &Arc<Self>,
        client: Client,
        kind: TransferKind,
        bucket: &str,
        key: &str,
        local_path: String,
        job: Job,
        link: Option<BatchLink>,
    ) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let record = Transfer {
            id: id.clone(),
            kind,
            batch_id: link.as_ref().map(|l| l.batch_id.clone()),
            bucket: bucket.to_string(),
            key: key.to_string(),
            local_path,
            total_bytes: 0,
            transferred_bytes: 0,
            parts_total: 0,
            parts_done: 0,
            bytes_per_sec: 0,
            status: TransferStatus::Queued,
            error: None,
            started_at: now_iso(),
            finished_at: None,
        };
        let entry = Arc::new(TransferEntry {
            seq: self.seq.fetch_add(1, Ordering::Relaxed),
            record: Mutex::new(record),
            cancel: link.as_ref().map_or_else(CancellationToken::new, |l| l.cancel.child_token()),
            finished: CancellationToken::new(),
            transferred: AtomicU64::new(0),
            parts_done: AtomicU32::new(0),
            parts_in_flight: AtomicUsize::new(0),
            peak_parts_in_flight: AtomicUsize::new(0),
            part_retries: AtomicU32::new(0),
            discarded_bytes: AtomicU64::new(0),
            file_syncs: AtomicU32::new(0),
            observer: link.map(|l| l.observer),
        });
        self.entries.insert(id.clone(), entry.clone());
        self.sink.emit(&entry.snapshot());
        // Take the place in line now, in start order (see `RunGate::enqueue`).
        let waiter = self.running.enqueue();
        let me = self.clone();
        tokio::spawn(async move { me.run_job(entry, waiter, client, job).await });
        id
    }

    async fn run_job(self: Arc<Self>, entry: Arc<TransferEntry>, waiter: gate::Waiter, client: Client, job: Job) {
        let permit = tokio::select! {
            biased;
            _ = entry.cancel.cancelled() => None,
            p = waiter.wait() => Some(p),
        };

        let result = match &permit {
            None => Err(AppError::cancelled()),
            Some(_) => {
                // Snapshot now (not at queue time): settings changed while queued still apply.
                let mut cfg = PartSettings::from(&self.settings());
                cfg.upload_attempt_timeout = self.tuning.upload_attempt_timeout;
                entry.lock().status = TransferStatus::Running;
                self.sink.emit(&entry.snapshot());
                if let Some(o) = &entry.observer {
                    let id = entry.lock().id.clone();
                    o.running(&id);
                }

                let stop = CancellationToken::new();
                let ticker = tokio::spawn(ticker(self.sink.clone(), entry.clone(), stop.clone()));
                let (id, bucket, key) = {
                    let r = entry.lock();
                    (r.id.clone(), r.bucket.clone(), r.key.clone())
                };
                let fault = self.tuning.fault.clone();
                let body = async {
                    match job {
                        Job::Download { dest, no_replace, version_id, within } => {
                            if let Some(f) = &fault {
                                f("download");
                            }
                            let src = download::Source { bucket: &bucket, key: &key, version_id: version_id.as_deref() };
                            download::run(&client, &entry, cfg, &id, src, &dest, no_replace, within.as_deref()).await
                        }
                        Job::Upload { src } => {
                            if let Some(f) = &fault {
                                f("upload");
                            }
                            upload::run(&client, &entry, cfg, &bucket, &key, &src).await
                        }
                    }
                };
                // A panic must not leave the transfer "running" forever (and the updater blocked):
                // it becomes a failure and the final event below is still sent. Release builds
                // use `panic = "abort"`, so there a panic still ends the whole process.
                // Boxed: a queued task (a folder transfer queues thousands at once) then holds a
                // pointer, not the whole download/upload state machine (about 20 KB each).
                let r = Box::pin(AssertUnwindSafe(body).catch_unwind()).await.unwrap_or_else(|p| Err(AppError::from_panic(&*p)));
                stop.cancel();
                let _ = ticker.await;
                r
            }
        };

        let released = {
            let mut rec = entry.lock();
            rec.bytes_per_sec = 0;
            rec.finished_at = Some(now_iso());
            match result {
                Ok(()) => {
                    rec.status = TransferStatus::Completed;
                    entry.transferred.store(rec.total_bytes, Ordering::Relaxed);
                    entry.parts_done.store(rec.parts_total, Ordering::Relaxed);
                }
                Err(e) if e.is_cancelled() || entry.cancel.is_cancelled() => {
                    rec.status = TransferStatus::Cancelled;
                }
                Err(e) => {
                    rec.status = TransferStatus::Failed;
                    rec.error = Some(e.message);
                }
            }
            // Lock order: never take `active_dests` while holding a record lock (see `queue_download`).
            (rec.kind == TransferKind::Download).then(|| dest_key(&rec.local_path))
        };
        if let Some(dest) = released {
            self.active_dests.lock().unwrap_or_else(|p| p.into_inner()).remove(&dest);
        }
        let last = entry.snapshot();
        self.sink.emit(&last);
        if let Some(o) = &entry.observer {
            o.finished(&last);
        }
        // Release the run slot only after the final event, so observers never see the next
        // queued transfer running while this one still looks running.
        drop(permit);
        entry.finished.cancel();
    }

    /// Cooperative cancel. No-op for transfers that already finished.
    pub fn cancel(&self, id: &str) -> AppResult<()> {
        let entry = self.entries.get(id).map(|e| e.clone()).ok_or_else(|| AppError::invalid("Unknown transfer id"))?;
        entry.cancel.cancel();
        Ok(())
    }

    /// Forgets a finished transfer. Active transfers must be cancelled first.
    pub fn remove(&self, id: &str) -> AppResult<()> {
        let Some(entry) = self.entries.get(id).map(|e| e.clone()) else {
            return Ok(());
        };
        if entry.status().is_active() {
            return Err(AppError::invalid("Transfer is still active; cancel it first"));
        }
        self.entries.remove(id);
        Ok(())
    }

    /// Cancels every queued or running transfer (cooperatively) and returns tokens that fire
    /// once each of them reached its final state (after its final event).
    pub fn cancel_active(&self) -> Vec<CancellationToken> {
        self.entries
            .iter()
            .filter(|e| e.status().is_active())
            .map(|e| {
                e.cancel.cancel();
                e.finished.clone()
            })
            .collect()
    }

    /// True while any transfer is queued or running (the updater refuses to install then).
    pub fn has_active(&self) -> bool {
        self.entries.iter().any(|e| e.snapshot().status.is_active())
    }

    /// All known transfers, oldest first.
    pub fn list(&self) -> Vec<Transfer> {
        let mut v: Vec<(u64, Transfer)> = self.entries.iter().map(|e| (e.seq, e.snapshot())).collect();
        v.sort_by_key(|(s, _)| *s);
        v.into_iter().map(|(_, t)| t).collect()
    }

    pub fn get(&self, id: &str) -> Option<Transfer> {
        self.entries.get(id).map(|e| e.snapshot())
    }

    /// Waits until the transfer reaches a final state and returns it.
    pub async fn wait(&self, id: &str) -> Option<Transfer> {
        let entry = self.entries.get(id).map(|e| e.clone())?;
        entry.finished.cancelled().await;
        Some(entry.snapshot())
    }
}

/// Emits progress at most every 100 ms while a transfer runs, with a ~2 s rolling rate.
async fn ticker(sink: Arc<dyn ProgressSink>, entry: Arc<TransferEntry>, stop: CancellationToken) {
    let mut interval = tokio::time::interval(TICK);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut samples: VecDeque<(Instant, u64)> = VecDeque::new();
    let mut last: Option<(u64, u32, u64)> = None;
    loop {
        tokio::select! {
            biased;
            _ = stop.cancelled() => break,
            _ = interval.tick() => {}
        }
        let now = Instant::now();
        let bytes = entry.transferred.load(Ordering::Relaxed);
        samples.push_back((now, bytes));
        while samples.len() > 2 && samples.front().is_some_and(|(t, _)| now.duration_since(*t) > RATE_WINDOW) {
            samples.pop_front();
        }
        let bps = match samples.front() {
            Some((t0, b0)) => {
                let dt = now.duration_since(*t0).as_secs_f64();
                if dt > 0.05 {
                    (bytes.saturating_sub(*b0) as f64 / dt) as u64
                } else {
                    0
                }
            }
            None => 0,
        };
        entry.lock().bytes_per_sec = bps;
        let snap = entry.snapshot();
        let key = (snap.transferred_bytes, snap.parts_done, snap.bytes_per_sec);
        if last != Some(key) {
            last = Some(key);
            sink.emit(&snap);
        }
    }
}

/// Aborts a multipart upload when dropped while armed: if the task driving it panics or its
/// future is dropped, the upload (and the parts stored for it) would otherwise be left behind.
/// `Drop` cannot await, so the abort is spawned (best effort, needs a Tokio runtime). Normal
/// paths call [`abort`](Self::abort) or [`disarm`](Self::disarm) instead.
pub(crate) struct AbortOnDrop {
    client: Client,
    bucket: String,
    key: String,
    upload_id: String,
    armed: bool,
}

impl AbortOnDrop {
    pub(crate) fn new(client: &Client, bucket: &str, key: &str, upload_id: &str) -> Self {
        Self {
            client: client.clone(),
            bucket: bucket.to_string(),
            key: key.to_string(),
            upload_id: upload_id.to_string(),
            armed: true,
        }
    }

    /// Aborts now (best effort; deliberately not cancellable) and disarms.
    pub(crate) async fn abort(&mut self) {
        self.armed = false;
        let _ = self
            .client
            .abort_multipart_upload()
            .bucket(&self.bucket)
            .key(&self.key)
            .upload_id(&self.upload_id)
            .send()
            .await;
    }

    /// The upload was completed (or aborted) normally.
    pub(crate) fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            let req = self
                .client
                .abort_multipart_upload()
                .bucket(std::mem::take(&mut self.bucket))
                .key(std::mem::take(&mut self.key))
                .upload_id(std::mem::take(&mut self.upload_id));
            rt.spawn(async move {
                let _ = req.send().await;
            });
        }
    }
}

/// Runs `f` unless `token` is cancelled first.
async fn cancellable<T>(token: &CancellationToken, f: impl Future<Output = T>) -> AppResult<T> {
    tokio::select! {
        biased;
        _ = token.cancelled() => Err(AppError::cancelled()),
        v = f => Ok(v),
    }
}

/// Marks a file sparse (Windows; best effort, callers ignore errors).
///
/// Parts that stream to disk as they arrive write far ahead of the file's valid data length. On
/// a normal NTFS file each such write first makes the OS zero-fill the gap, so nearly every byte
/// hits the disk twice (zeros, then data): measured ~1.6x disk writes and ~25% lower throughput
/// on a 9.5 GiB download. The unwritten ranges of a sparse file need no zeroing. Filesystems without sparse support
/// (FAT32, exFAT) return an error and the download proceeds as before. Elsewhere `set_len`
/// already creates sparse files, so this is a no-op.
#[cfg(windows)]
fn set_sparse(file: &std::fs::File) -> std::io::Result<()> {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::ptr::{null, null_mut};
    const FSCTL_SET_SPARSE: u32 = 0x0009_00C4;
    #[link(name = "kernel32")]
    extern "system" {
        fn DeviceIoControl(
            device: *mut c_void,
            code: u32,
            in_buf: *const c_void,
            in_size: u32,
            out_buf: *mut c_void,
            out_size: u32,
            returned: *mut u32,
            overlapped: *mut c_void,
        ) -> i32;
    }
    let mut returned = 0u32;
    // SAFETY: `file` keeps the handle open for the duration of this synchronous call; no input
    // or output buffers are passed (a null input buffer means "set sparse").
    let ok = unsafe {
        DeviceIoControl(file.as_raw_handle(), FSCTL_SET_SPARSE, null(), 0, null_mut(), 0, &mut returned, null_mut())
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn set_sparse(_file: &std::fs::File) -> std::io::Result<()> {
    Ok(())
}

/// Positional write of the whole buffer (thread-safe on a shared handle).
fn write_all_at(file: &std::fs::File, buf: &[u8], offset: u64) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.write_all_at(buf, offset)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        let (mut buf, mut offset) = (buf, offset);
        while !buf.is_empty() {
            let n = file.seek_write(buf, offset)?;
            if n == 0 {
                return Err(std::io::Error::new(std::io::ErrorKind::WriteZero, "failed to write part"));
            }
            buf = &buf[n..];
            offset += n as u64;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{h, FakeS3, Reply, Req, ScratchDir};

    // ---- end-to-end against a scripted fake S3 ----

    async fn finished(tm: &TransferManager, id: &str, limit: Duration) -> Transfer {
        tokio::time::timeout(limit, tm.wait(id)).await.expect("transfer finished in time").expect("known")
    }

    fn manager(settings: TransferSettings, tuning: TransferTuning) -> Arc<TransferManager> {
        TransferManager::with_tuning(Arc::new(NoopSink), settings, tuning)
    }

    /// Serves an object of `size` bytes (byte i = i % 251). `serve` gets the requested range
    /// `(start, end)` and returns how many bytes to send before dropping the connection (`None` =
    /// all, normally). `chunked`: send the body chunked and drop it before the last chunk.
    async fn object_server(size: u64, serve: impl Fn(u64, u64) -> Option<u64> + Send + Sync + 'static, chunked: bool) -> FakeS3 {
        FakeS3::start(move |r: &Req| {
            let etag = h("ETag", "\"v1\"");
            match r.method.as_str() {
                "HEAD" => Reply::with_headers(200, vec![h("Content-Length", &size.to_string()), etag]),
                "GET" => {
                    let (status, start, end) = match r.header("range").and_then(|v| v.strip_prefix("bytes=")) {
                        Some(spec) => {
                            let (a, b) = spec.split_once('-').expect("range");
                            let (a, b): (u64, u64) = (a.parse().expect("start"), b.parse().expect("end"));
                            if a > b || b >= size {
                                return Reply::status(416);
                            }
                            (206, a, b)
                        }
                        None => (200, 0, size - 1),
                    };
                    let body: Vec<u8> = (start..=end).map(|i| (i % 251) as u8).collect();
                    let mut hs = vec![etag];
                    if status == 206 {
                        hs.push(h("Content-Range", &format!("bytes {start}-{end}/{size}")));
                    }
                    if chunked {
                        hs.push(h("Transfer-Encoding", "chunked"));
                        let mut b = format!("{:x}\r\n", body.len()).into_bytes();
                        b.extend_from_slice(&body);
                        b.extend_from_slice(b"\r\n"); // ... but never the final "0\r\n\r\n"
                        return Reply::Partial { status, headers: hs, body: b };
                    }
                    hs.push(h("Content-Length", &body.len().to_string()));
                    match serve(start, end) {
                        Some(n) => Reply::Partial { status, headers: hs, body: body[..(n as usize).min(body.len())].to_vec() },
                        None => Reply::Full { status, headers: hs, body },
                    }
                }
                _ => Reply::status(500),
            }
        })
        .await
    }

    fn expected(size: u64) -> Vec<u8> {
        (0..size).map(|i| (i % 251) as u8).collect()
    }

    fn gets(s3: &FakeS3) -> usize {
        s3.count(|r| r.method == "GET")
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_version_download_sends_the_version_on_every_request() {
        let dir = ScratchDir::new("dl-version");
        let size = 9 * MIB + 3;
        let s3 = object_server(size, |_, _| None, false).await;
        let settings = TransferSettings { part_size_mib: Some(1), ..TransferSettings::default() };
        let tm = manager(settings, TransferTuning::default());
        let dest = dir.0.join("v.bin");
        let id = tm.start_version_download(s3.client(), "b", "k", "3HL4kq.v/1", dest.clone()).expect("start");
        let t = finished(&tm, &id, Duration::from_secs(30)).await;
        assert_eq!(t.status, TransferStatus::Completed, "{:?}", t.error);
        assert_eq!(std::fs::read(&dest).expect("read"), expected(size));
        let reqs = s3.requests();
        assert!(gets(&s3) >= 10, "ranged parts");
        for r in &reqs {
            assert!(r.query.contains("versionId=3HL4kq.v%2F1"), "{} {} without the version: {}", r.method, r.path, r.query);
        }
        assert!(reqs.iter().filter(|r| r.method == "GET").all(|r| r.header("if-match") == Some("\"v1\"")), "still pinned by If-Match");
        assert!(tm.start_version_download(s3.client(), "b", "k", "", dir.0.join("x")).is_err(), "empty version id");

        // A version that does not exist: HeadObject's bare 404 names the version.
        let s3 = FakeS3::start(|_| Reply::status(404)).await;
        let id = tm.start_version_download(s3.client(), "b", "k", "gone", dir.0.join("g.bin")).expect("start");
        let t = finished(&tm, &id, Duration::from_secs(30)).await;
        assert_eq!(t.status, TransferStatus::Failed);
        assert_eq!(t.error.as_deref(), Some("Version gone of k does not exist."));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_peer_that_sends_one_byte_per_connection_fails_the_download() {
        let dir = ScratchDir::new("dl-1byte");
        let size = 2 * MIB; // one whole-object GET with the Auto part size
        let s3 = object_server(size, |_, _| Some(1), false).await;
        let tm = TransferManager::new(Arc::new(NoopSink));
        let dest = dir.0.join("obj.bin");
        let id = tm.start_download(s3.client(), "b", "k", dest.clone()).expect("start");
        // Before the fix every 1-byte attempt reset the failure count: ~2 million attempts.
        let t = finished(&tm, &id, Duration::from_secs(30)).await;
        assert_eq!(t.status, TransferStatus::Failed, "{:?}", t.error);
        assert_eq!(gets(&s3), 3, "3 attempts without meaningful progress");
        assert!(dir.files().is_empty(), "no .part left behind: {:?}", dir.files());
        assert!(t.transferred_bytes <= 3, "progress is monotonic and honest");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_part_has_a_total_attempt_budget() {
        let dir = ScratchDir::new("dl-budget");
        let size = 2 * MIB;
        // 64 KiB per connection counts as progress, but 2 MiB would need 32 attempts.
        let s3 = object_server(size, |_, _| Some(64 * 1024), false).await;
        let tm = TransferManager::new(Arc::new(NoopSink));
        let id = tm.start_download(s3.client(), "b", "k", dir.0.join("obj.bin")).expect("start");
        let t = finished(&tm, &id, Duration::from_secs(30)).await;
        assert_eq!(t.status, TransferStatus::Failed, "{:?}", t.error);
        assert_eq!(gets(&s3), 3 + 2, "3 + ceil(2 MiB / 1 MiB) attempts");
        assert!(dir.files().is_empty(), "{:?}", dir.files());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_flaky_but_working_link_still_finishes() {
        let dir = ScratchDir::new("dl-flaky");
        let size = 2 * MIB;
        // Each connection drops after 1 MiB: progress every time, done in 2 + 1 attempts.
        let s3 = object_server(size, |a, b| if b - a + 1 > MIB { Some(MIB) } else { None }, false).await;
        let tm = TransferManager::new(Arc::new(NoopSink));
        let dest = dir.0.join("obj.bin");
        let id = tm.start_download(s3.client(), "b", "k", dest.clone()).expect("start");
        let t = finished(&tm, &id, Duration::from_secs(30)).await;
        assert_eq!(t.status, TransferStatus::Completed, "{:?}", t.error);
        assert_eq!(std::fs::read(&dest).expect("file"), expected(size));
        assert_eq!(gets(&s3), 2);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn both_download_paths_sync_before_the_rename() {
        let dir = ScratchDir::new("dl-sync");
        // Single GET.
        let s3 = object_server(1000, |_, _| None, false).await;
        let tm = TransferManager::new(Arc::new(NoopSink));
        let dest = dir.0.join("small.bin");
        let id = tm.start_download(s3.client(), "b", "k", dest.clone()).expect("start");
        let t = finished(&tm, &id, Duration::from_secs(30)).await;
        assert_eq!(t.status, TransferStatus::Completed, "{:?}", t.error);
        assert_eq!(std::fs::read(&dest).expect("file"), expected(1000));
        assert_eq!(tm.stats(&id).expect("stats").file_syncs, 1, "single-GET path syncs");
        // Ranged (1 MiB parts).
        let size = 3 * MIB + 5;
        let s3 = object_server(size, |_, _| None, false).await;
        let settings = TransferSettings { part_size_mib: Some(1), ..TransferSettings::default() };
        let tm = manager(settings, TransferTuning::default());
        let dest = dir.0.join("big.bin");
        let id = tm.start_download(s3.client(), "b", "k", dest.clone()).expect("start");
        let t = finished(&tm, &id, Duration::from_secs(30)).await;
        assert_eq!(t.status, TransferStatus::Completed, "{:?}", t.error);
        assert_eq!(t.parts_total, 4);
        assert_eq!(std::fs::read(&dest).expect("file"), expected(size));
        assert_eq!(tm.stats(&id).expect("stats").file_syncs, 1, "ranged path syncs once");
        assert_eq!(dir.files().len(), 2, "no temp files: {:?}", dir.files());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_error_after_the_last_byte_completes_the_part() {
        let dir = ScratchDir::new("dl-tail");
        // Every byte arrives, then the connection drops before the end of the chunked body.
        let s3 = object_server(1000, |_, _| None, true).await;
        let tm = TransferManager::new(Arc::new(NoopSink));
        let dest = dir.0.join("obj.bin");
        let id = tm.start_download(s3.client(), "b", "k", dest.clone()).expect("start");
        let t = finished(&tm, &id, Duration::from_secs(30)).await;
        // Before the fix: a retry with "bytes=1000-999", answered 416 (InvalidRange).
        assert_eq!(t.status, TransferStatus::Completed, "{:?}", t.error);
        assert_eq!(std::fs::read(&dest).expect("file"), expected(1000));
        assert_eq!(gets(&s3), 1, "no retry");
        assert!(s3.requests().iter().all(|r| r.header("range").is_none()));
        // Same for a ranged part.
        let size = 2 * MIB + 10;
        let s3 = object_server(size, |_, _| None, true).await;
        let tm = manager(TransferSettings { part_size_mib: Some(1), ..TransferSettings::default() }, TransferTuning::default());
        let dest = dir.0.join("big.bin");
        let id = tm.start_download(s3.client(), "b", "k", dest.clone()).expect("start");
        let t = finished(&tm, &id, Duration::from_secs(30)).await;
        assert_eq!(t.status, TransferStatus::Completed, "{:?}", t.error);
        assert_eq!(std::fs::read(&dest).expect("file"), expected(size));
        assert_eq!(gets(&s3), 3);
    }

    /// Upload server: answers everything, except that requests carrying a body (`PUT` with
    /// content) are read completely and never answered.
    async fn black_hole_for_bodies() -> FakeS3 {
        FakeS3::start(|r: &Req| match r.method.as_str() {
            "PUT" if !r.body.is_empty() => Reply::Hang,
            "POST" if r.has_query("uploads") => Reply::xml(
                200,
                r#"<InitiateMultipartUploadResult><Bucket>b</Bucket><Key>k</Key><UploadId>U1</UploadId></InitiateMultipartUploadResult>"#,
            ),
            "DELETE" if r.has_query("uploadId") => Reply::status(204),
            _ => Reply::status(500),
        })
        .await
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_upload_whose_server_never_answers_fails_within_the_bound() {
        let dir = ScratchDir::new("up-hang");
        let small = dir.0.join("small.bin");
        std::fs::write(&small, vec![7u8; 4096]).expect("write");
        let s3 = black_hole_for_bodies().await;
        let bound = Duration::from_secs(2);
        let tm = manager(TransferSettings::default(), TransferTuning { upload_attempt_timeout: Some(bound), fault: None });
        let t0 = Instant::now();
        let id = tm.start_upload(s3.client(), "b", "k", small);
        // Before the fix there was no bound at all once the body was sent.
        let t = finished(&tm, &id, Duration::from_secs(40)).await;
        let took = t0.elapsed();
        assert_eq!(t.status, TransferStatus::Failed, "{:?}", t.error);
        assert!(t.error.as_deref().unwrap_or_default().contains("timed out"), "{:?}", t.error);
        let puts = s3.count(|r| r.method == "PUT");
        assert_eq!(puts, 3, "the SDK retried the timed-out attempt");
        assert!(took >= bound * 3 && took < Duration::from_secs(20), "{took:?}");
        assert!(s3.requests().iter().filter(|r| r.method == "PUT").all(|r| r.body.len() == 4096), "whole body each time");

        // Multipart: the part never gets an answer; the transfer fails and the upload is aborted.
        let big = dir.0.join("big.bin");
        std::fs::write(&big, vec![9u8; 6 * MIB as usize]).expect("write");
        let s3 = black_hole_for_bodies().await;
        let settings = TransferSettings { part_size_mib: Some(5), ..TransferSettings::default() };
        let tm = manager(settings, TransferTuning { upload_attempt_timeout: Some(bound), fault: None });
        let id = tm.start_upload(s3.client(), "b", "k", big);
        let t = finished(&tm, &id, Duration::from_secs(40)).await;
        assert_eq!(t.status, TransferStatus::Failed, "{:?}", t.error);
        assert_eq!(s3.count(|r| r.method == "DELETE" && r.query.contains("uploadId=U1")), 1, "aborted");
        assert!(!tm.has_active());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_panicking_transfer_still_finishes() {
        let dir = ScratchDir::new("panic");
        let src = dir.0.join("f.bin");
        std::fs::write(&src, b"x").expect("write");
        let fault: FaultHook = Arc::new(|what: &str| {
            if what == "upload" {
                panic!("injected fault in {what}");
            }
        });
        let s3 = black_hole_for_bodies().await;
        let tm = manager(TransferSettings::default(), TransferTuning { upload_attempt_timeout: None, fault: Some(fault) });
        let id = tm.start_upload(s3.client(), "b", "k", src);
        let t = finished(&tm, &id, Duration::from_secs(10)).await;
        assert_eq!(t.status, TransferStatus::Failed);
        assert!(t.finished_at.is_some());
        assert!(t.error.as_deref().unwrap_or_default().contains("injected fault in upload"), "{:?}", t.error);
        assert!(!tm.has_active());
        assert_eq!(tm.running_count(), 0, "run slot released");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_dropped_multipart_upload_is_aborted() {
        let s3 = black_hole_for_bodies().await;
        let c = s3.client();
        // Dropped while armed (what a panic or a dropped future does): the abort is sent.
        drop(AbortOnDrop::new(&c, "b", "k", "U1"));
        // Disarmed (completed normally): nothing is sent.
        let mut done = AbortOnDrop::new(&c, "b", "k", "U2");
        done.disarm();
        drop(done);
        let deadline = Instant::now() + Duration::from_secs(10);
        while s3.count(|r| r.method == "DELETE") == 0 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        let deletes: Vec<String> = s3.requests().into_iter().filter(|r| r.method == "DELETE").map(|r| r.query).collect();
        assert_eq!(deletes.len(), 1, "{deletes:?}");
        assert!(deletes[0].contains("uploadId=U1"));
    }

    struct CountingObserver(Mutex<Vec<(String, TransferStatus)>>);
    impl TransferObserver for CountingObserver {
        fn running(&self, id: &str) {
            self.0.lock().unwrap().push((id.to_string(), TransferStatus::Running));
        }
        fn finished(&self, t: &Transfer) {
            self.0.lock().unwrap().push((t.id.clone(), t.status));
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_no_replace_download_never_overwrites() {
        let dir = ScratchDir::new("dl-noreplace");
        let s3 = object_server(1000, |_, _| None, false).await;
        let tm = TransferManager::new(Arc::new(NoopSink));
        let dest = dir.0.join("exists.bin");
        std::fs::write(&dest, b"keep me").expect("write");
        let obs = Arc::new(CountingObserver(Mutex::new(Vec::new())));
        let link = BatchLink { batch_id: "B1".into(), cancel: CancellationToken::new(), observer: obs.clone() };
        let id = tm.start_batch_download(s3.client(), "b", "k", dest.clone(), &dir.0, true, link.clone()).expect("start");
        let t = finished(&tm, &id, Duration::from_secs(30)).await;
        assert_eq!(t.status, TransferStatus::Failed);
        assert!(t.error.as_deref().unwrap_or_default().starts_with("A file already exists at "), "{:?}", t.error);
        assert_eq!(t.batch_id.as_deref(), Some("B1"));
        assert_eq!(std::fs::read(&dest).expect("read"), b"keep me", "left untouched");
        assert!(s3.requests().is_empty(), "no request for a file that will be refused");
        assert_eq!(dir.files().len(), 1, "no .part left: {:?}", dir.files());
        // The observer saw it start and finish.
        let seen = obs.0.lock().unwrap().clone();
        assert_eq!(seen, vec![(id.clone(), TransferStatus::Running), (id.clone(), TransferStatus::Failed)]);
        // A free destination downloads normally in the same mode.
        let free = dir.0.join("free.bin");
        let id = tm.start_batch_download(s3.client(), "b", "k", free.clone(), &dir.0, true, link.clone()).expect("start");
        assert_eq!(finished(&tm, &id, Duration::from_secs(30)).await.status, TransferStatus::Completed);
        assert_eq!(std::fs::read(&free).expect("read"), expected(1000));
        // The single-file command (and no_replace = false) keeps replacing.
        let id = tm.start_download(s3.client(), "b", "k", dest.clone()).expect("start");
        let t = finished(&tm, &id, Duration::from_secs(30)).await;
        assert_eq!(t.status, TransferStatus::Completed);
        assert_eq!(t.batch_id, None);
        assert_eq!(std::fs::read(&dest).expect("read"), expected(1000));
        // Cancelling the batch token cancels a file started after the cancel.
        link.cancel.cancel();
        let id = tm.start_batch_download(s3.client(), "b", "k", dir.0.join("late.bin"), &dir.0, false, link).expect("start");
        assert_eq!(finished(&tm, &id, Duration::from_secs(30)).await.status, TransferStatus::Cancelled);
        assert!(!dir.0.join("late.bin").exists());
    }

    /// Regression (v0.5.0 e2e): starting downloads held `active_dests` across the entry insert
    /// while a finishing transfer held its record lock and waited for `active_dests`, and a
    /// listing held a shard lock and waited for that record lock: all three blocked forever (the
    /// app froze when "Cancel them and disconnect" ran during a folder download). Starts, ends,
    /// listings and cancels race here; a watchdog turns a deadlock into a failure.
    #[test]
    fn starting_finishing_and_listing_downloads_never_deadlock() {
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(4).enable_all().build().expect("runtime");
            rt.block_on(async {
                let dir = ScratchDir::new("dl-lock-order");
                let s3 = object_server(16, |_, _| None, false).await;
                let tm = manager(TransferSettings { max_concurrent_transfers: 8, ..TransferSettings::default() }, TransferTuning::default());
                let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
                let listers: Vec<_> = (0..3)
                    .map(|i| {
                        let (tm, stop) = (tm.clone(), stop.clone());
                        std::thread::spawn(move || {
                            while !stop.load(Ordering::Relaxed) {
                                let _ = tm.list();
                                let _ = tm.has_active();
                                if i == 0 {
                                    let _ = tm.cancel_active();
                                }
                            }
                        })
                    })
                    .collect();
                let mut ids = Vec::new();
                for n in 0..3000 {
                    ids.push(tm.start_download(s3.client(), "b", "k", dir.0.join(format!("f{n}.bin"))).expect("start"));
                    if n % 64 == 63 {
                        tokio::task::yield_now().await;
                    }
                }
                for id in &ids {
                    tm.wait(id).await;
                }
                stop.store(true, Ordering::Relaxed);
                for l in listers {
                    l.join().expect("lister");
                }
            });
            let _ = done_tx.send(());
        });
        done_rx.recv_timeout(Duration::from_secs(120)).expect("starts, finishes and listings deadlocked");
    }

    /// M3 (review): a 50,000-file batch queues 50,000 tasks at once. A queued task must stay
    /// small: the download/upload state machine is boxed and only allocated once it runs.
    #[tokio::test]
    async fn a_queued_transfer_task_is_small() {
        let s3 = FakeS3::start(|_| Reply::status(500)).await;
        let tm = TransferManager::new(Arc::new(NoopSink));
        let entry = Arc::new(TransferEntry {
            seq: 0,
            record: Mutex::new(Transfer {
                id: "t".into(),
                kind: TransferKind::Download,
                batch_id: None,
                bucket: "b".into(),
                key: "k".into(),
                local_path: "x".into(),
                total_bytes: 0,
                transferred_bytes: 0,
                parts_total: 0,
                parts_done: 0,
                bytes_per_sec: 0,
                status: TransferStatus::Queued,
                error: None,
                started_at: now_iso(),
                finished_at: None,
            }),
            cancel: CancellationToken::new(),
            finished: CancellationToken::new(),
            transferred: AtomicU64::new(0),
            parts_done: AtomicU32::new(0),
            parts_in_flight: AtomicUsize::new(0),
            peak_parts_in_flight: AtomicUsize::new(0),
            part_retries: AtomicU32::new(0),
            discarded_bytes: AtomicU64::new(0),
            file_syncs: AtomicU32::new(0),
            observer: None,
        });
        let jobs = [
            Job::Download { dest: PathBuf::from("x"), no_replace: false, version_id: None, within: None },
            Job::Upload { src: PathBuf::from("x") },
        ];
        for job in jobs {
            let fut = tm.clone().run_job(entry.clone(), tm.running.enqueue(), s3.client(), job);
            let size = std::mem::size_of_val(&fut);
            eprintln!("run_job future: {size} bytes");
            assert!(size < 2048, "a queued transfer task holds {size} bytes");
        }
    }

    /// L6 (review): a folder-upload file replaced by a symbolic link after planning is not
    /// followed; a single upload of a link keeps working.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_batch_upload_does_not_follow_a_link() {
        let dir = ScratchDir::new("up-link");
        let target = dir.0.join("secret.txt");
        std::fs::write(&target, b"outside").expect("target");
        let link = dir.0.join("planned.txt");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&target, &link);
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&target, &link);
        if let Err(e) = made {
            eprintln!("skipped: cannot create a file symlink here ({e})");
            return;
        }
        let s3 = FakeS3::start(|_| Reply::with_headers(200, vec![h("ETag", "\"e\"")])).await;
        let tm = TransferManager::new(Arc::new(NoopSink));
        let obs = Arc::new(CountingObserver(Mutex::new(Vec::new())));
        let blink = BatchLink { batch_id: "B1".into(), cancel: CancellationToken::new(), observer: obs };
        let id = tm.start_batch_upload(s3.client(), "b", "k", link.clone(), blink);
        let t = finished(&tm, &id, Duration::from_secs(30)).await;
        assert_eq!(t.status, TransferStatus::Failed, "{t:?}");
        assert!(t.error.as_deref().unwrap_or_default().contains("link"), "{:?}", t.error);
        assert!(s3.requests().is_empty(), "nothing sent");
        let id = tm.start_upload(s3.client(), "b", "k", link);
        assert_eq!(finished(&tm, &id, Duration::from_secs(30)).await.status, TransferStatus::Completed);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn one_writer_per_destination_is_released_at_the_end() {
        let dir = ScratchDir::new("dl-busy");
        let s3 = object_server(1000, |_, _| None, false).await;
        let tm = manager(TransferSettings { max_concurrent_transfers: 1, ..TransferSettings::default() }, TransferTuning::default());
        let dest = dir.0.join("Same.bin");
        let a = tm.start_download(s3.client(), "b", "k", dest.clone()).expect("first");
        let other_case = dir.0.join(if cfg!(windows) { "same.BIN" } else { "Same.bin" });
        assert!(tm.start_download(s3.client(), "b", "k", other_case).is_err(), "second writer refused");
        finished(&tm, &a, Duration::from_secs(30)).await;
        let b = tm.start_download(s3.client(), "b", "k", dest).expect("free again after the first finished");
        assert_eq!(finished(&tm, &b, Duration::from_secs(30)).await.status, TransferStatus::Completed);
    }

    #[test]
    fn download_dest_validation() {
        let abs = std::env::temp_dir().join("x.bin");
        assert!(validate_download_dest(&abs).is_ok());
        assert!(validate_download_dest(Path::new("")).is_err());
        assert!(validate_download_dest(Path::new("relative/x.bin")).is_err());
        assert!(validate_download_dest(&std::env::temp_dir().join("..").join("x.bin")).is_err());
        assert!(validate_download_dest(&std::env::temp_dir().join("a").join("..").join("..").join("x")).is_err());
    }

    #[test]
    fn sparse_file_reads_back_zeros_and_data() {
        let path = std::env::temp_dir().join(format!("s3x-sparse-{}.bin", uuid::Uuid::new_v4()));
        let file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).unwrap();
        let sparse = set_sparse(&file);
        if cfg!(windows) {
            // The temp dir is NTFS on Windows dev machines and CI runners.
            assert!(sparse.is_ok(), "{sparse:?}");
        }
        file.set_len(3 * MIB).unwrap();
        write_all_at(&file, b"tail", 3 * MIB - 4).unwrap();
        write_all_at(&file, b"head", 0).unwrap();
        drop(file);
        let got = std::fs::read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(got.len() as u64, 3 * MIB);
        assert_eq!(&got[..4], b"head");
        assert_eq!(&got[got.len() - 4..], b"tail");
        assert!(got[4..got.len() - 4].iter().all(|b| *b == 0));
    }

    #[test]
    fn dest_key_matches_same_file() {
        assert_eq!(dest_key("/a/b"), dest_key("/a/b"));
        if cfg!(windows) {
            assert_eq!(dest_key(r"C:\Dl\Report.pdf"), dest_key("c:/dl/report.PDF"));
            assert_eq!(dest_key("C:\\dl\\\u{3a3}\u{3a3}.txt"), dest_key("c:/dl/\u{3c3}\u{3c3}.txt"), "sigma forms are one file");
        }
    }
}
