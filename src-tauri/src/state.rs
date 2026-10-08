//! Application state: the active S3 connection and the transfer, batch and job managers.

use std::sync::Arc;
use std::time::Duration;

use aws_config::timeout::TimeoutConfig;
use aws_config::{BehaviorVersion, Region, SdkConfig};
use aws_credential_types::Credentials;
use aws_sdk_s3::config::{RequestChecksumCalculation, ResponseChecksumValidation};
use aws_sdk_s3::Client;
use dashmap::DashMap;
use tokio::sync::RwLock;

use crate::error::{is_access_denied, raw_status_and_region, AppError, AppResult};
use crate::batches::{BatchManager, BatchSink};
use crate::jobs::{JobManager, JobSink};
use crate::models::{AppSettings, ConnectionConfig, ConnectionInfo};
use crate::search::SearchRegistry;
use crate::settings::SettingsStore;
use crate::transfers::{ProgressSink, TransferManager};

const FALLBACK_REGION: &str = "us-east-1";

/// How long `disconnect { cancelActive: true }` waits for cancelled work to finish.
pub const DISCONNECT_WAIT: Duration = Duration::from_secs(10);

/// A live connection: base client plus a per-bucket cache of region-specific clients.
pub struct Connection {
    pub info: ConnectionInfo,
    /// Key of this connection's entry in `added-buckets.json`: the saved connection's id when it
    /// was opened from one (set by `connect_saved`), otherwise
    /// `profile:<name>@<endpoint or aws>` / `static:<accessKeyId>@<endpoint or aws>`.
    pub identity: String,
    base_client: Client,
    sdk_config: SdkConfig,
    region: String,
    endpoint: Option<String>,
    force_path_style: bool,
    /// Per bucket: its region and a client for it.
    bucket_clients: DashMap<String, (String, Client)>,
}

/// The region of `bucket`, asked with `HeadBucket` through `base` (any region). Works for a bucket
/// that is not in `ListBuckets` (shared from another account): S3 sends `x-amz-bucket-region` on
/// success and also on the 301 (wrong region), 400 and 403 (no permission) answers. An access
/// point ARN carries its region itself. `None` when it cannot be told (network error, 404, ...).
pub async fn discover_region(base: &Client, bucket: &str) -> Option<String> {
    if let Some(r) = crate::buckets::arn_region(bucket) {
        return Some(r.to_string());
    }
    let region = match base.head_bucket().bucket(bucket).send().await {
        Ok(out) => out.bucket_region().map(str::to_string),
        Err(e) => raw_status_and_region(&e).and_then(|(_, r)| r),
    };
    region.filter(|r| !r.is_empty())
}

fn normalize_endpoint(endpoint: Option<String>) -> Option<String> {
    let e = endpoint?.trim().trim_end_matches('/').to_string();
    if e.is_empty() {
        None
    } else if e.contains("://") {
        Some(e)
    } else {
        Some(format!("https://{e}"))
    }
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn build_client(sdk_config: &SdkConfig, region: &str, endpoint: Option<&str>, force_path_style: bool) -> Client {
    let mut b = aws_sdk_s3::config::Builder::from(sdk_config).region(Region::new(region.to_string()));
    if let Some(e) = endpoint {
        // Third-party S3 implementations (MinIO, R2, SeaweedFS, ...) are happiest with
        // path-style addressing and only the checksums the API strictly requires.
        b = b
            .endpoint_url(e)
            .force_path_style(force_path_style)
            .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
            .response_checksum_validation(ResponseChecksumValidation::WhenRequired);
    }
    Client::from_conf(b.build())
}

impl Connection {
    /// Builds the client from `config` and verifies it with `ListBuckets`.
    /// AccessDenied on ListBuckets still yields a connection (`canListBuckets: false`);
    /// any other error is returned.
    pub async fn open(config: ConnectionConfig) -> AppResult<Connection> {
        // `read_timeout` bounds the wait for a response (time to first byte), so a stalled
        // connection fails (as a retryable Network error) instead of hanging forever. No overall
        // operation timeout: large part transfers legitimately take long. Body stalls during
        // downloads are bounded separately (transfers::download::BODY_IDLE_TIMEOUT).
        let timeouts = TimeoutConfig::builder()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(30))
            .build();
        let (sdk_config, label, endpoint, force_path_style, identity) = match config {
            ConnectionConfig::Profile { profile, region, endpoint } => {
                let profile = profile.trim().to_string();
                if profile.is_empty() {
                    return Err(AppError::invalid("Profile name is required"));
                }
                let endpoint = normalize_endpoint(endpoint);
                let mut loader =
                    aws_config::defaults(BehaviorVersion::latest()).profile_name(&profile).timeout_config(timeouts);
                if let Some(r) = non_empty(region) {
                    loader = loader.region(Region::new(r));
                }
                if let Some(e) = &endpoint {
                    loader = loader.endpoint_url(e);
                }
                let identity = crate::buckets::identity_for("profile", &profile, endpoint.as_deref());
                (loader.load().await, profile, endpoint, true, identity)
            }
            ConnectionConfig::Static {
                access_key_id,
                secret_access_key,
                session_token,
                region,
                endpoint,
                force_path_style,
            } => {
                let access_key_id = access_key_id.trim().to_string();
                let secret_access_key = secret_access_key.trim().to_string();
                if access_key_id.is_empty() || secret_access_key.is_empty() {
                    return Err(AppError::invalid("Access key id and secret access key are required"));
                }
                let endpoint = normalize_endpoint(endpoint);
                let region = non_empty(Some(region)).unwrap_or_else(|| FALLBACK_REGION.to_string());
                let prefix: String = access_key_id.chars().take(8).collect();
                let identity = crate::buckets::identity_for("static", &access_key_id, endpoint.as_deref());
                let creds = Credentials::new(
                    access_key_id,
                    secret_access_key,
                    non_empty(session_token),
                    None,
                    "s3explorer-static",
                );
                let mut loader = aws_config::defaults(BehaviorVersion::latest())
                    .credentials_provider(creds)
                    .region(Region::new(region))
                    .timeout_config(timeouts);
                if let Some(e) = &endpoint {
                    loader = loader.endpoint_url(e);
                }
                (loader.load().await, format!("static:{prefix}"), endpoint, force_path_style.unwrap_or(true), identity)
            }
        };

        let region = sdk_config.region().map(|r| r.to_string()).unwrap_or_else(|| FALLBACK_REGION.to_string());
        let base_client = build_client(&sdk_config, &region, endpoint.as_deref(), force_path_style);

        let can_list_buckets = match base_client.list_buckets().send().await {
            Ok(_) => true,
            Err(e) => {
                let err = AppError::from(e);
                if !is_access_denied(&err) {
                    return Err(err);
                }
                false
            }
        };

        Ok(Connection {
            info: ConnectionInfo { label, region: region.clone(), endpoint: endpoint.clone(), can_list_buckets },
            identity,
            base_client,
            sdk_config,
            region,
            endpoint,
            force_path_style,
            bucket_clients: DashMap::new(),
        })
    }

    /// The connection-default client (used for account-level calls like ListBuckets).
    pub fn base_client(&self) -> &Client {
        &self.base_client
    }

    /// Returns a client configured for the bucket's region, resolving it once via
    /// [`discover_region`] and caching the result. With a custom endpoint, the base client is
    /// always used.
    pub async fn client_for_bucket(&self, bucket: &str) -> Client {
        self.resolve_bucket(bucket).await.0
    }

    /// Like [`Self::client_for_bucket`], plus the bucket's region (`None` with a custom endpoint
    /// or when it could not be determined; then the connection's default client is returned and
    /// nothing is cached, so the next call tries again).
    pub async fn resolve_bucket(&self, bucket: &str) -> (Client, Option<String>) {
        if self.endpoint.is_some() {
            return (self.base_client.clone(), None);
        }
        if let Some(c) = self.bucket_clients.get(bucket) {
            return (c.1.clone(), Some(c.0.clone()));
        }
        let Some(region) = discover_region(&self.base_client, bucket).await else {
            return (self.base_client.clone(), None);
        };
        let client = if region == self.region {
            self.base_client.clone()
        } else {
            build_client(&self.sdk_config, &region, None, self.force_path_style)
        };
        self.bucket_clients.insert(bucket.to_string(), (region.clone(), client.clone()));
        (client, Some(region))
    }
}

pub struct AppState {
    connection: RwLock<Option<Arc<Connection>>>,
    pub transfers: Arc<TransferManager>,
    pub jobs: Arc<JobManager>,
    pub batches: Arc<BatchManager>,
    /// Running `search_objects` calls by `searchId`.
    pub searches: SearchRegistry,
    pub settings: SettingsStore,
}

impl AppState {
    /// The transfer manager starts with the store's (loaded) settings.
    pub fn new(
        sink: Arc<dyn ProgressSink>,
        job_sink: Arc<dyn JobSink>,
        batch_sink: Arc<dyn BatchSink>,
        settings: SettingsStore,
    ) -> Self {
        let transfers = TransferManager::with_settings(sink, settings.get());
        let batches = BatchManager::new(transfers.clone(), batch_sink);
        Self {
            connection: RwLock::new(None),
            transfers,
            jobs: JobManager::new(job_sink),
            batches,
            searches: SearchRegistry::new(),
            settings,
        }
    }

    pub fn get_settings(&self) -> AppSettings {
        self.settings.get()
    }

    /// Validates, persists and applies new settings (nothing changes on error).
    pub async fn update_settings(&self, settings: AppSettings) -> AppResult<AppSettings> {
        self.settings.update(settings, |s| self.transfers.apply_settings(s)).await
    }

    /// Cancels every queued or running transfer, batch and job (cooperatively) and waits up to
    /// `limit` for all of them to reach their final state, final events included. Returns how
    /// many were still active when the wait ended (0 when everything finished in time).
    pub async fn cancel_active_and_wait(&self, limit: Duration) -> usize {
        // Batches first: their cancel also stops them from starting more transfers.
        let mut pending = self.batches.cancel_active();
        pending.extend(self.jobs.cancel_active());
        pending.extend(self.transfers.cancel_active());
        let all = futures::future::join_all(pending.iter().map(|t| t.cancelled()));
        let _ = tokio::time::timeout(limit, all).await;
        pending.iter().filter(|t| !t.is_cancelled()).count()
    }

    /// `disconnect`: with `cancel_active`, first cancels all work and waits (up to `limit`) for
    /// its final events; then drops the connection. Without it, running work keeps its own
    /// clients and finishes in the background. Returns what [`Self::cancel_active_and_wait`] said
    /// (0 without `cancel_active`).
    pub async fn disconnect(&self, cancel_active: bool, limit: Duration) -> usize {
        let unfinished = if cancel_active { self.cancel_active_and_wait(limit).await } else { 0 };
        self.set_connection(None).await;
        unfinished
    }

    /// Replacing or dropping the connection cancels running searches (they belong to the old one).
    pub async fn set_connection(&self, conn: Option<Arc<Connection>>) {
        self.searches.cancel_all();
        *self.connection.write().await = conn;
        // Again once the lock is released: a search that started while the write waited holds the old client.
        self.searches.cancel_all();
    }

    pub async fn connection(&self) -> AppResult<Arc<Connection>> {
        self.connection.read().await.clone().ok_or_else(AppError::not_connected)
    }

    pub async fn connection_info(&self) -> Option<ConnectionInfo> {
        self.connection.read().await.as_ref().map(|c| c.info.clone())
    }

    pub async fn client_for_bucket(&self, bucket: &str) -> AppResult<Client> {
        if bucket.trim().is_empty() {
            return Err(AppError::invalid("Bucket name is required"));
        }
        Ok(self.connection().await?.client_for_bucket(bucket).await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{h, FakeS3, Reply};

    #[tokio::test]
    async fn region_of_a_bucket_not_in_list_buckets() {
        // 301: the bucket lives in another region (HeadBucket sent to the wrong one)
        let fake = FakeS3::start(|_| Reply::with_headers(301, vec![h("x-amz-bucket-region", "eu-central-1")])).await;
        assert_eq!(discover_region(&fake.client(), "shared").await.as_deref(), Some("eu-central-1"));
        // 403: no permission on someone else's bucket, the header is still sent
        let fake = FakeS3::start(|_| Reply::with_headers(403, vec![h("x-amz-bucket-region", "ap-south-1")])).await;
        assert_eq!(discover_region(&fake.client(), "shared").await.as_deref(), Some("ap-south-1"));
        // 400 (AuthorizationHeaderMalformed for a region mismatch) with the header
        let fake = FakeS3::start(|_| Reply::with_headers(400, vec![h("x-amz-bucket-region", "us-west-2")])).await;
        assert_eq!(discover_region(&fake.client(), "shared").await.as_deref(), Some("us-west-2"));
        // 200 with the header
        let fake = FakeS3::start(|_| Reply::with_headers(200, vec![h("x-amz-bucket-region", "us-east-1")])).await;
        assert_eq!(discover_region(&fake.client(), "mine").await.as_deref(), Some("us-east-1"));
        // 404 without a header: unknown
        let fake = FakeS3::start(|_| Reply::status(404)).await;
        assert_eq!(discover_region(&fake.client(), "missing").await, None);
        // an access point ARN carries its region; no request is made
        let fake = FakeS3::start(|_| Reply::status(500)).await;
        let arn = "arn:aws:s3:sa-east-1:123456789012:accesspoint/ap";
        assert_eq!(discover_region(&fake.client(), arn).await.as_deref(), Some("sa-east-1"));
        assert_eq!(fake.requests().len(), 0);
    }

    #[derive(Default)]
    struct Finals {
        transfers: std::sync::Mutex<Vec<crate::models::Transfer>>,
        jobs: std::sync::Mutex<Vec<crate::models::Job>>,
        batches: std::sync::Mutex<Vec<crate::models::Batch>>,
    }

    /// An AppState whose sinks record every event, connected to `fake`.
    async fn connected_state(fake: &FakeS3) -> (AppState, Arc<Finals>) {
        let rec = Arc::new(Finals::default());
        let (a, b, c) = (rec.clone(), rec.clone(), rec.clone());
        let sink: Arc<dyn ProgressSink> = Arc::new(move |t: &crate::models::Transfer| a.transfers.lock().expect("lock").push(t.clone()));
        let job_sink: Arc<dyn JobSink> = Arc::new(move |j: &crate::models::Job| b.jobs.lock().expect("lock").push(j.clone()));
        let batch_sink: Arc<dyn BatchSink> = Arc::new(move |x: &crate::models::Batch| c.batches.lock().expect("lock").push(x.clone()));
        let state = AppState::new(sink, job_sink, batch_sink, SettingsStore::in_memory(Default::default()));
        let conn = Connection::open(ConnectionConfig::Static {
            access_key_id: "test".into(),
            secret_access_key: "test".into(),
            session_token: None,
            region: "us-east-1".into(),
            endpoint: Some(fake.endpoint.clone()),
            force_path_style: Some(true),
        })
        .await
        .expect("connect");
        state.set_connection(Some(Arc::new(conn))).await;
        (state, rec)
    }

    const NO_BUCKETS: &str = "<ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>";

    /// A search that starts while `set_connection` waits for the write lock (it already ran its
    /// first cancel) must still be cancelled: it would otherwise keep the old connection's client.
    #[tokio::test(flavor = "multi_thread")]
    async fn set_connection_cancels_a_search_started_while_it_waited() {
        let sink: Arc<dyn ProgressSink> = Arc::new(|_: &crate::models::Transfer| {});
        let job_sink: Arc<dyn JobSink> = Arc::new(|_: &crate::models::Job| {});
        let batch_sink: Arc<dyn BatchSink> = Arc::new(|_: &crate::models::Batch| {});
        let state = Arc::new(AppState::new(sink, job_sink, batch_sink, SettingsStore::in_memory(Default::default())));
        let reader = state.connection.read().await; // holds off the write
        let setter = tokio::spawn({
            let s = state.clone();
            async move { s.set_connection(None).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await; // the first cancel has run, the write waits
        assert!(!setter.is_finished());
        let search = tokio::spawn({
            let s = state.clone();
            async move { s.searches.run("late", std::future::pending::<AppResult<()>>()).await }
        });
        while state.searches.running() == 0 {
            tokio::task::yield_now().await;
        }
        drop(reader);
        setter.await.expect("join");
        let r = tokio::time::timeout(Duration::from_secs(5), search).await.expect("the search ended").expect("join");
        assert!(r.unwrap_err().is_cancelled());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn disconnect_with_cancel_active_waits_for_every_final_event() {
        use crate::models::{BatchKind, BatchPlanRequest, BatchStatus, ConflictPolicy, JobItem, JobKind, JobRequest, JobStatus, TransferStatus};
        let fake = FakeS3::start(|r| match r.method.as_str() {
            "GET" if r.path == "/" => Reply::xml(200, NO_BUCKETS),
            "GET" if r.has_query("list-type") && r.query.contains("prefix=dl%2F") => Reply::xml(
                200,
                "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>dl/a</Key><Size>5</Size></Contents><Contents><Key>dl/b</Key><Size>5</Size></Contents><Contents><Key>dl/c</Key><Size>5</Size></Contents></ListBucketResult>",
            ),
            // Everything else (the job's listing, every HEAD) never answers.
            _ => Reply::Hang,
        })
        .await;
        let (state, rec) = connected_state(&fake).await;
        let client = state.client_for_bucket("b").await.expect("client");
        let dir = crate::testutil::ScratchDir::new("disconnect");
        let t = state.transfers.start_download(client.clone(), "b", "single", dir.0.join("single")).expect("download");
        let batch = state
            .batches
            .start(
                BatchPlanRequest {
                    kind: BatchKind::Download,
                    bucket: "b".into(),
                    prefix: "dl/".into(),
                    local_path: dir.0.join("batch").to_string_lossy().into_owned(),
                    on_conflict: ConflictPolicy::Overwrite,
                },
                client.clone(),
            )
            .expect("batch");
        let job = state
            .jobs
            .start(
                JobRequest {
                    kind: JobKind::Delete,
                    src_bucket: "b".into(),
                    dest_bucket: None,
                    items: vec![JobItem { from: "x/".into(), to: None, is_prefix: true }],
                    on_conflict: ConflictPolicy::Skip,
                    tags: None,
                    restore: None,
                },
                client,
                None,
            )
            .expect("job");
        // Let the batch start its transfers and everything reach its hanging request.
        for _ in 0..100 {
            if state.batches.transfer_ids(&batch).len() == 3 && fake.count(|r| r.method == "HEAD") >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(state.batches.transfer_ids(&batch).len(), 3, "the batch started its transfers");
        assert!(state.transfers.has_active() && state.jobs.has_active() && state.batches.has_active());

        let started = std::time::Instant::now();
        let unfinished = state.disconnect(true, Duration::from_secs(10)).await;
        assert_eq!(unfinished, 0);
        assert!(started.elapsed() < Duration::from_secs(5), "cooperative cancel is quick: {:?}", started.elapsed());
        assert!(state.connection_info().await.is_none(), "the connection is gone");
        assert!(!state.transfers.has_active() && !state.jobs.has_active() && !state.batches.has_active());
        // Every final event was emitted before disconnect returned.
        let finals = |status| rec.transfers.lock().expect("lock").iter().filter(|x| x.finished_at.is_some() && x.status == status).count();
        assert_eq!(finals(TransferStatus::Cancelled), 4, "single + 3 batch files");
        assert_eq!(state.transfers.get(&t).map(|x| x.status), Some(TransferStatus::Cancelled));
        let jobs = rec.jobs.lock().expect("lock").clone();
        assert!(jobs.iter().any(|j| j.id == job && j.finished_at.is_some() && j.status == JobStatus::Cancelled));
        let batches = rec.batches.lock().expect("lock").clone();
        assert!(batches.iter().any(|b| b.id == batch && b.finished_at.is_some() && b.status == BatchStatus::Cancelled));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn disconnect_without_cancel_lets_work_finish() {
        use crate::models::TransferStatus;
        let fake = FakeS3::start(|r| match r.method.as_str() {
            "GET" if r.path == "/" => Reply::xml(200, NO_BUCKETS),
            "HEAD" => Reply::with_headers(200, vec![h("Content-Length", "5"), h("ETag", "\"e\"")]),
            "GET" => Reply::Full { status: 200, headers: vec![h("ETag", "\"e\"")], body: b"hello".to_vec() },
            _ => Reply::status(500),
        })
        .await;
        let (state, _) = connected_state(&fake).await;
        let client = state.client_for_bucket("b").await.expect("client");
        let dir = crate::testutil::ScratchDir::new("disconnect-keep");
        let t = state.transfers.start_download(client, "b", "k", dir.0.join("k")).expect("download");
        assert_eq!(state.disconnect(false, Duration::from_secs(10)).await, 0);
        assert!(state.connection_info().await.is_none());
        let done = tokio::time::timeout(Duration::from_secs(10), state.transfers.wait(&t)).await.expect("finished").expect("known");
        assert_eq!(done.status, TransferStatus::Completed, "{:?}", done.error);
        assert_eq!(std::fs::read(dir.0.join("k")).expect("file"), b"hello");
    }
}
