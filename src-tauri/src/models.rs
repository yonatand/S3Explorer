//! Wire types. Mirrors `src/lib/types.ts` exactly (camelCase JSON).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    pub name: String,
    pub region: Option<String>,
    pub has_credentials: bool,
}

/// Connection parameters from the UI. `Debug` is implemented by hand so the secret access key
/// and session token can never end up in a log or panic message.
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConnectionConfig {
    #[serde(rename_all = "camelCase")]
    Profile {
        profile: String,
        #[serde(default)]
        region: Option<String>,
        #[serde(default)]
        endpoint: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Static {
        access_key_id: String,
        secret_access_key: String,
        #[serde(default)]
        session_token: Option<String>,
        region: String,
        #[serde(default)]
        endpoint: Option<String>,
        #[serde(default)]
        force_path_style: Option<bool>,
    },
}

impl std::fmt::Debug for ConnectionConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Profile { profile, region, endpoint } => f
                .debug_struct("Profile")
                .field("profile", profile)
                .field("region", region)
                .field("endpoint", endpoint)
                .finish(),
            Self::Static { access_key_id, secret_access_key: _, session_token, region, endpoint, force_path_style } => f
                .debug_struct("Static")
                .field("access_key_id", access_key_id)
                .field("secret_access_key", &"<redacted>")
                .field("session_token", &session_token.as_ref().map(|_| "<redacted>"))
                .field("region", region)
                .field("endpoint", endpoint)
                .field("force_path_style", force_path_style)
                .finish(),
        }
    }
}

// ---- Saved connections ---------------------------------------------------------------------

/// Longest saved-connection name, in characters after trimming (mirror `SAVED_CONNECTION_NAME_MAX`).
pub const SAVED_CONNECTION_NAME_MAX: usize = 64;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SavedConnectionKind {
    Profile,
    Static,
}

/// A saved connection as returned to the frontend. Never carries secret material.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    pub id: String,
    pub name: String,
    pub kind: SavedConnectionKind,
    pub profile: Option<String>,
    pub access_key_id: Option<String>,
    pub region: Option<String>,
    pub endpoint: Option<String>,
    pub force_path_style: bool,
    pub has_secret: bool,
    pub last_used_at: Option<String>,
}

/// `save_connection` argument. `config` may carry a secret, so `Debug` goes through
/// [`ConnectionConfig`]'s redacting implementation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConnectionInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub config: ConnectionConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub label: String,
    pub region: String,
    pub endpoint: Option<String>,
    pub can_list_buckets: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub name: String,
    pub creation_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub prefix: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectEntry {
    pub key: String,
    pub name: String,
    pub size: u64,
    pub last_modified: Option<String>,
    pub etag: Option<String>,
    pub storage_class: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPage {
    pub folders: Vec<FolderEntry>,
    pub objects: Vec<ObjectEntry>,
    pub next_continuation_token: Option<String>,
    pub is_truncated: bool,
}

/// `list_recent` stops scanning after this many objects and reports `truncated: true`.
pub const RECENT_SCAN_LIMIT: u64 = 20_000;
/// `list_recent` returns at most this many objects.
pub const RECENT_MAX_RESULTS: usize = 200;

/// The most recently modified objects under a prefix (`RecentListing` in `types.ts`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentListing {
    /// Newest first, at most [`RECENT_MAX_RESULTS`].
    pub objects: Vec<ObjectEntry>,
    /// Objects looked at.
    pub scanned: u64,
    /// The scan stopped at [`RECENT_SCAN_LIMIT`] before the end of the listing.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectMeta {
    pub key: String,
    pub name: String,
    pub size: u64,
    pub last_modified: Option<String>,
    pub etag: Option<String>,
    pub storage_class: Option<String>,
    pub content_type: Option<String>,
    pub metadata: HashMap<String, String>,
    pub version_id: Option<String>,
    /// v0.5.0: restore state from `x-amz-restore`; `None` when the header is absent.
    pub restore: Option<RestoreStatus>,
    /// v0.5.0: true when the object must be restored before it can be read.
    pub archived: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferKind {
    Download,
    Upload,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl TransferStatus {
    pub fn is_active(self) -> bool {
        matches!(self, TransferStatus::Queued | TransferStatus::Running)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub id: String,
    pub kind: TransferKind,
    /// The folder transfer (batch) this file belongs to; `null` for a single transfer.
    pub batch_id: Option<String>,
    pub bucket: String,
    pub key: String,
    pub local_path: String,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub parts_total: u32,
    pub parts_done: u32,
    pub bytes_per_sec: u64,
    pub status: TransferStatus,
    pub error: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

pub const TRANSFER_PROGRESS_EVENT: &str = "transfer:progress";

/// Inclusive limits for the transfer fields of [`AppSettings`] (mirror `TRANSFER_SETTINGS_LIMITS` in `types.ts`).
pub const PART_SIZE_MIB_MIN: u32 = 1;
pub const PART_SIZE_MIB_MAX: u32 = 256;
pub const MAX_CONCURRENT_PARTS_MIN: u32 = 1;
pub const MAX_CONCURRENT_PARTS_MAX: u32 = 32;
pub const MAX_CONCURRENT_TRANSFERS_MIN: u32 = 1;
pub const MAX_CONCURRENT_TRANSFERS_MAX: u32 = 10;
/// Defaults (mirror `DEFAULT_APP_SETTINGS` in `types.ts`).
pub const DEFAULT_MAX_CONCURRENT_PARTS: u32 = 8;
pub const DEFAULT_MAX_CONCURRENT_TRANSFERS: u32 = 4;

/// UI color theme. `System` follows the OS (`prefers-color-scheme`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    #[default]
    System,
    Light,
    Dark,
}

impl ThemeMode {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "system" => Some(Self::System),
            "light" => Some(Self::Light),
            "dark" => Some(Self::Dark),
            _ => None,
        }
    }
}

/// The interface's accent colour (`AccentColor` in `types.ts`).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AccentColor {
    #[default]
    Yellow,
    Green,
    Blue,
    Red,
}

impl AccentColor {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "yellow" => Some(Self::Yellow),
            "green" => Some(Self::Green),
            "blue" => Some(Self::Blue),
            "red" => Some(Self::Red),
            _ => None,
        }
    }
}

/// User settings (flat object, `AppSettings` in `types.ts`). `part_size_mib: None` means Auto.
///
/// Parsing goes through [`AppSettings::from_json_lenient`] (the on-disk file) or
/// [`AppSettings::from_json_strict`] (the `update_settings` argument); range checks are done by
/// [`AppSettings::validate`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub part_size_mib: Option<u32>,
    #[serde(default = "default_max_concurrent_parts")]
    pub max_concurrent_parts: u32,
    #[serde(default = "default_max_concurrent_transfers")]
    pub max_concurrent_transfers: u32,
    #[serde(default)]
    pub theme: ThemeMode,
    #[serde(default)]
    pub check_updates_on_startup: bool,
    #[serde(default = "default_notify_on_finish")]
    pub notify_on_finish: bool,
    /// Interface scale in percent.
    #[serde(default = "default_text_size")]
    pub text_size: u32,
    /// Font weight of ordinary text.
    #[serde(default = "default_text_weight")]
    pub text_weight: u32,
    #[serde(default)]
    pub accent: AccentColor,
    /// Show the Copy/Move confirmation even when the preview found no conflicts.
    #[serde(default = "default_confirm_copy_move")]
    pub confirm_copy_move: bool,
    /// v0.6.0: the program "Show in folder" / "Open folder" run instead of the system file
    /// manager (see `file_manager.rs`); `None` = the system file manager.
    #[serde(default)]
    pub file_manager_command: Option<String>,
}

/// Longest accepted `fileManagerCommand`, in characters.
pub const FILE_MANAGER_COMMAND_MAX: usize = 1024;

pub const TEXT_SIZE_MIN: u32 = 80;
pub const TEXT_SIZE_MAX: u32 = 150;
pub const DEFAULT_TEXT_SIZE: u32 = 100;
pub const TEXT_WEIGHT_MIN: u32 = 300;
pub const TEXT_WEIGHT_MAX: u32 = 600;
pub const DEFAULT_TEXT_WEIGHT: u32 = 400;

/// v0.2.0 name of the settings type; the transfer code only reads the transfer fields.
pub type TransferSettings = AppSettings;

fn default_max_concurrent_parts() -> u32 {
    DEFAULT_MAX_CONCURRENT_PARTS
}

fn default_max_concurrent_transfers() -> u32 {
    DEFAULT_MAX_CONCURRENT_TRANSFERS
}

fn default_notify_on_finish() -> bool {
    true
}

fn default_confirm_copy_move() -> bool {
    true
}

fn default_text_size() -> u32 {
    DEFAULT_TEXT_SIZE
}

fn default_text_weight() -> u32 {
    DEFAULT_TEXT_WEIGHT
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            part_size_mib: None,
            max_concurrent_parts: DEFAULT_MAX_CONCURRENT_PARTS,
            max_concurrent_transfers: DEFAULT_MAX_CONCURRENT_TRANSFERS,
            theme: ThemeMode::System,
            check_updates_on_startup: false,
            notify_on_finish: default_notify_on_finish(),
            text_size: DEFAULT_TEXT_SIZE,
            text_weight: DEFAULT_TEXT_WEIGHT,
            accent: AccentColor::Yellow,
            confirm_copy_move: default_confirm_copy_move(),
            file_manager_command: None,
        }
    }
}

fn part_size_error() -> crate::error::AppError {
    crate::error::AppError::invalid(format!(
        "partSizeMib must be an integer from {PART_SIZE_MIB_MIN} to {PART_SIZE_MIB_MAX}, or null for Auto"
    ))
}

fn parts_error() -> crate::error::AppError {
    crate::error::AppError::invalid(format!(
        "maxConcurrentParts must be an integer from {MAX_CONCURRENT_PARTS_MIN} to {MAX_CONCURRENT_PARTS_MAX}"
    ))
}

fn transfers_error() -> crate::error::AppError {
    crate::error::AppError::invalid(format!(
        "maxConcurrentTransfers must be an integer from {MAX_CONCURRENT_TRANSFERS_MIN} to {MAX_CONCURRENT_TRANSFERS_MAX}"
    ))
}

fn theme_error() -> crate::error::AppError {
    crate::error::AppError::invalid(r#"theme must be "system", "light" or "dark""#)
}

fn check_updates_error() -> crate::error::AppError {
    crate::error::AppError::invalid("checkUpdatesOnStartup must be true or false")
}

fn notify_error() -> crate::error::AppError {
    crate::error::AppError::invalid("notifyOnFinish must be true or false")
}

fn text_size_error() -> crate::error::AppError {
    crate::error::AppError::invalid(format!("textSize must be an integer from {TEXT_SIZE_MIN} to {TEXT_SIZE_MAX}"))
}

fn text_weight_error() -> crate::error::AppError {
    crate::error::AppError::invalid(format!(
        "textWeight must be an integer from {TEXT_WEIGHT_MIN} to {TEXT_WEIGHT_MAX}"
    ))
}

fn confirm_copy_move_error() -> crate::error::AppError {
    crate::error::AppError::invalid("confirmCopyMove must be true or false")
}

fn file_manager_error() -> crate::error::AppError {
    crate::error::AppError::invalid(format!(
        "fileManagerCommand must be null or one line of at most {FILE_MANAGER_COMMAND_MAX} characters without control characters"
    ))
}

/// `fileManagerCommand` normalized: trimmed, empty -> `None`; `InvalidInput` (naming the field)
/// when too long or when it holds a control character.
pub fn normalize_file_manager_command(v: Option<&str>) -> crate::error::AppResult<Option<String>> {
    let Some(t) = v.map(str::trim).filter(|t| !t.is_empty()) else { return Ok(None) };
    if t.chars().count() > FILE_MANAGER_COMMAND_MAX || t.chars().any(char::is_control) {
        return Err(file_manager_error());
    }
    Ok(Some(t.to_string()))
}

fn accent_error() -> crate::error::AppError {
    crate::error::AppError::invalid(r#"accent must be "yellow", "green", "blue" or "red""#)
}

fn part_size_ok(v: Option<u32>) -> bool {
    v.is_none_or(|v| (PART_SIZE_MIB_MIN..=PART_SIZE_MIB_MAX).contains(&v))
}

fn parts_ok(v: u32) -> bool {
    (MAX_CONCURRENT_PARTS_MIN..=MAX_CONCURRENT_PARTS_MAX).contains(&v)
}

fn transfers_ok(v: u32) -> bool {
    (MAX_CONCURRENT_TRANSFERS_MIN..=MAX_CONCURRENT_TRANSFERS_MAX).contains(&v)
}

fn text_size_ok(v: u32) -> bool {
    (TEXT_SIZE_MIN..=TEXT_SIZE_MAX).contains(&v)
}

fn text_weight_ok(v: u32) -> bool {
    (TEXT_WEIGHT_MIN..=TEXT_WEIGHT_MAX).contains(&v)
}

/// A JSON value as a `u32`, only if it is a non-negative integer that fits.
fn json_u32(v: &serde_json::Value) -> Option<u32> {
    v.as_u64().and_then(|n| u32::try_from(n).ok())
}

impl AppSettings {
    /// Rejects (`InvalidInput`, naming the field and its range) the first out-of-range field.
    /// `theme`, `checkUpdatesOnStartup` and `notifyOnFinish` are valid by construction.
    pub fn validate(&self) -> crate::error::AppResult<()> {
        if !part_size_ok(self.part_size_mib) {
            return Err(part_size_error());
        }
        if !parts_ok(self.max_concurrent_parts) {
            return Err(parts_error());
        }
        if !transfers_ok(self.max_concurrent_transfers) {
            return Err(transfers_error());
        }
        if !text_size_ok(self.text_size) {
            return Err(text_size_error());
        }
        if !text_weight_ok(self.text_weight) {
            return Err(text_weight_error());
        }
        if normalize_file_manager_command(self.file_manager_command.as_deref())? != self.file_manager_command {
            return Err(file_manager_error());
        }
        Ok(())
    }

    /// Replaces each out-of-range field with its default.
    pub fn sanitized(self) -> Self {
        let d = Self::default();
        Self {
            part_size_mib: if part_size_ok(self.part_size_mib) { self.part_size_mib } else { d.part_size_mib },
            max_concurrent_parts: if parts_ok(self.max_concurrent_parts) {
                self.max_concurrent_parts
            } else {
                d.max_concurrent_parts
            },
            max_concurrent_transfers: if transfers_ok(self.max_concurrent_transfers) {
                self.max_concurrent_transfers
            } else {
                d.max_concurrent_transfers
            },
            text_size: if text_size_ok(self.text_size) { self.text_size } else { d.text_size },
            text_weight: if text_weight_ok(self.text_weight) { self.text_weight } else { d.text_weight },
            file_manager_command: normalize_file_manager_command(self.file_manager_command.as_deref()).unwrap_or(None),
            ..self
        }
    }

    /// Lenient parse of the on-disk file: never fails. A value that is not an object yields the
    /// defaults; each field that is missing, of the wrong type, unknown (`theme`) or out of range
    /// takes its default on its own, so one bad field never resets the others. Unknown fields are
    /// ignored (forward compatible; a v0.2.0 file with three fields loads with the new ones at
    /// their defaults).
    pub fn from_json_lenient(v: &serde_json::Value) -> Self {
        let d = Self::default();
        let Some(obj) = v.as_object() else { return d };
        let part_size_mib = match obj.get("partSizeMib") {
            None | Some(serde_json::Value::Null) => None,
            Some(v) => json_u32(v).filter(|n| part_size_ok(Some(*n))),
        };
        Self {
            part_size_mib,
            max_concurrent_parts: obj
                .get("maxConcurrentParts")
                .and_then(json_u32)
                .filter(|n| parts_ok(*n))
                .unwrap_or(d.max_concurrent_parts),
            max_concurrent_transfers: obj
                .get("maxConcurrentTransfers")
                .and_then(json_u32)
                .filter(|n| transfers_ok(*n))
                .unwrap_or(d.max_concurrent_transfers),
            theme: obj.get("theme").and_then(serde_json::Value::as_str).and_then(ThemeMode::parse).unwrap_or(d.theme),
            check_updates_on_startup: obj
                .get("checkUpdatesOnStartup")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(d.check_updates_on_startup),
            notify_on_finish: obj
                .get("notifyOnFinish")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(d.notify_on_finish),
            text_size: obj.get("textSize").and_then(json_u32).filter(|n| text_size_ok(*n)).unwrap_or(d.text_size),
            text_weight: obj
                .get("textWeight")
                .and_then(json_u32)
                .filter(|n| text_weight_ok(*n))
                .unwrap_or(d.text_weight),
            accent: obj
                .get("accent")
                .and_then(serde_json::Value::as_str)
                .and_then(AccentColor::parse)
                .unwrap_or(d.accent),
            confirm_copy_move: obj
                .get("confirmCopyMove")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(d.confirm_copy_move),
            file_manager_command: obj
                .get("fileManagerCommand")
                .and_then(serde_json::Value::as_str)
                .and_then(|c| normalize_file_manager_command(Some(c)).ok().flatten()),
        }
    }

    /// Strict parse of the `update_settings` argument: all eleven fields must be present
    /// (`fileManagerCommand` a string or `null`; trimmed, empty becomes `null`). Transfer
    /// and text fields must be in-range integers (`partSizeMib` may be `null`); `theme` one of the
    /// three modes and `accent` one of the four colours; `checkUpdatesOnStartup` and
    /// `notifyOnFinish` and `confirmCopyMove` booleans. Anything else is
    /// `InvalidInput` naming the field.
    /// Unknown fields are ignored.
    pub fn from_json_strict(v: &serde_json::Value) -> crate::error::AppResult<Self> {
        let obj = v.as_object().ok_or_else(|| crate::error::AppError::invalid("settings must be an object"))?;
        let int = |name: &str, err: fn() -> crate::error::AppError| -> crate::error::AppResult<u32> {
            obj.get(name).and_then(json_u32).ok_or_else(err)
        };
        let part_size_mib = match obj.get("partSizeMib") {
            Some(serde_json::Value::Null) => None,
            Some(_) => Some(int("partSizeMib", part_size_error)?),
            None => return Err(part_size_error()),
        };
        let s = Self {
            part_size_mib,
            max_concurrent_parts: int("maxConcurrentParts", parts_error)?,
            max_concurrent_transfers: int("maxConcurrentTransfers", transfers_error)?,
            theme: obj
                .get("theme")
                .and_then(serde_json::Value::as_str)
                .and_then(ThemeMode::parse)
                .ok_or_else(theme_error)?,
            check_updates_on_startup: obj
                .get("checkUpdatesOnStartup")
                .and_then(serde_json::Value::as_bool)
                .ok_or_else(check_updates_error)?,
            notify_on_finish: obj
                .get("notifyOnFinish")
                .and_then(serde_json::Value::as_bool)
                .ok_or_else(notify_error)?,
            text_size: int("textSize", text_size_error)?,
            text_weight: int("textWeight", text_weight_error)?,
            accent: obj
                .get("accent")
                .and_then(serde_json::Value::as_str)
                .and_then(AccentColor::parse)
                .ok_or_else(accent_error)?,
            confirm_copy_move: obj
                .get("confirmCopyMove")
                .and_then(serde_json::Value::as_bool)
                .ok_or_else(confirm_copy_move_error)?,
            file_manager_command: match obj.get("fileManagerCommand") {
                Some(serde_json::Value::Null) => None,
                Some(serde_json::Value::String(c)) => {
                    normalize_file_manager_command(Some(c))?
                }
                _ => return Err(file_manager_error()),
            },
        };
        s.validate()?;
        Ok(s)
    }
}

// ---- Object operations (jobs) --------------------------------------------------------------

pub const JOB_PROGRESS_EVENT: &str = "job:progress";
/// Most items one job request may contain (mirror `JOB_MAX_ITEMS` in `types.ts`).
pub const JOB_MAX_ITEMS: usize = 10_000;
/// `preview_job` stops counting at this many objects (`truncated: true`).
pub const JOB_PREVIEW_CAP: u64 = 100_000;
/// `Job.errors` keeps the first this-many per-object errors.
pub const JOB_MAX_ERRORS: usize = 50;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JobKind {
    Delete,
    Copy,
    Move,
    /// Bulk tag editing (`JobRequest.tags`).
    Tag,
    /// Bulk restore of archived objects (`JobRequest.restore`).
    Restore,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl JobStatus {
    pub fn is_active(self) -> bool {
        matches!(self, JobStatus::Queued | JobStatus::Running)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ConflictPolicy {
    Overwrite,
    /// The default when the field is missing: never overwrite silently.
    #[default]
    Skip,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JobPhase {
    Listing,
    Working,
    Done,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobItem {
    pub from: String,
    #[serde(default)]
    pub to: Option<String>,
    pub is_prefix: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobRequest {
    pub kind: JobKind,
    pub src_bucket: String,
    #[serde(default)]
    pub dest_bucket: Option<String>,
    pub items: Vec<JobItem>,
    #[serde(default)]
    pub on_conflict: ConflictPolicy,
    /// Required for `kind: "tag"`, rejected for the other kinds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<TagOperation>,
    /// Required for `kind: "restore"`, rejected for the other kinds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore: Option<RestoreRequest>,
}

// ---- v0.4.0: tags and buckets added by name -------------------------------------------------

/// One S3 tag (`Tag` in `types.ts`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub key: String,
    pub value: String,
}

impl Tag {
    pub fn new(key: impl Into<String>, value: impl Into<String>) -> Self {
        Self { key: key.into(), value: value.into() }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TagMode {
    Merge,
    Replace,
}

/// What a bulk tag job does to every object (`TagOperation` in `types.ts`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TagOperation {
    pub mode: TagMode,
    #[serde(default)]
    pub set: Vec<Tag>,
    #[serde(default)]
    pub remove: Vec<String>,
}

/// A bucket the user added by name (`AddedBucket` in `types.ts`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AddedBucket {
    pub name: String,
    pub region: Option<String>,
    pub added_at: String,
}

// ---- v0.4.0: lifecycle configuration (see "Lifecycle configuration" in docs/CONTRACT.md) ------
//
// Numbers (days, sizes, version counts) are `serde_json::Number` so that a value the UI sends that
// is not a whole number (1.5, -3) reaches `validate_lifecycle` and becomes a placed issue instead
// of failing deserialization. Values read from S3 are always whole numbers.
// Fields the contract types as required numbers are `Option` here for the same reason (an empty
// form field sent as `null` is an issue, not a bridge error); values read from S3 always set them.

/// `RuleStatus` in `types.ts` (S3's own spelling).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "PascalCase")]
pub enum RuleStatus {
    Enabled,
    Disabled,
}

/// `TransitionStorageClass` in `types.ts` (S3's own spelling).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StorageClass {
    StandardIa,
    OnezoneIa,
    IntelligentTiering,
    GlacierIr,
    Glacier,
    DeepArchive,
}

impl StorageClass {
    /// S3's name for the class (`STANDARD_IA`, ...), as in the JSON.
    pub fn as_str(self) -> &'static str {
        match self {
            StorageClass::StandardIa => "STANDARD_IA",
            StorageClass::OnezoneIa => "ONEZONE_IA",
            StorageClass::IntelligentTiering => "INTELLIGENT_TIERING",
            StorageClass::GlacierIr => "GLACIER_IR",
            StorageClass::Glacier => "GLACIER",
            StorageClass::DeepArchive => "DEEP_ARCHIVE",
        }
    }

    /// Position in S3's transition waterfall (`STORAGE_CLASS_RANK` in `types.ts`): STANDARD_IA →
    /// INTELLIGENT_TIERING → ONEZONE_IA → GLACIER_IR → GLACIER → DEEP_ARCHIVE. A later transition
    /// must go to a strictly higher rank.
    pub fn rank(self) -> u8 {
        match self {
            StorageClass::StandardIa => 1,
            StorageClass::IntelligentTiering => 2,
            StorageClass::OnezoneIa => 3,
            StorageClass::GlacierIr => 4,
            StorageClass::Glacier => 5,
            StorageClass::DeepArchive => 6,
        }
    }

    /// GLACIER_IR, GLACIER and DEEP_ARCHIVE.
    pub fn is_archive(self) -> bool {
        self.rank() >= 4
    }
}

/// `LifecycleFilter` in `types.ts`. All conditions empty: the rule applies to the whole bucket.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleFilter {
    #[serde(default)]
    pub prefix: Option<String>,
    #[serde(default)]
    pub tags: Vec<Tag>,
    #[serde(default)]
    pub object_size_greater_than: Option<serde_json::Number>,
    #[serde(default)]
    pub object_size_less_than: Option<serde_json::Number>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleTransition {
    #[serde(default)]
    pub days: Option<serde_json::Number>,
    #[serde(default)]
    pub date: Option<String>,
    pub storage_class: StorageClass,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleExpiration {
    #[serde(default)]
    pub days: Option<serde_json::Number>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub expired_object_delete_marker: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NoncurrentTransition {
    #[serde(default)]
    pub noncurrent_days: Option<serde_json::Number>,
    #[serde(default)]
    pub newer_noncurrent_versions: Option<serde_json::Number>,
    pub storage_class: StorageClass,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct NoncurrentExpiration {
    #[serde(default)]
    pub noncurrent_days: Option<serde_json::Number>,
    #[serde(default)]
    pub newer_noncurrent_versions: Option<serde_json::Number>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AbortIncompleteMultipartUpload {
    #[serde(default)]
    pub days_after_initiation: Option<serde_json::Number>,
}

/// `LifecycleRule` in `types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleRule {
    #[serde(default)]
    pub id: String,
    pub status: RuleStatus,
    #[serde(default)]
    pub filter: LifecycleFilter,
    #[serde(default)]
    pub transitions: Vec<LifecycleTransition>,
    #[serde(default)]
    pub expiration: Option<LifecycleExpiration>,
    #[serde(default)]
    pub noncurrent_version_transitions: Vec<NoncurrentTransition>,
    #[serde(default)]
    pub noncurrent_version_expiration: Option<NoncurrentExpiration>,
    #[serde(default)]
    pub abort_incomplete_multipart_upload: Option<AbortIncompleteMultipartUpload>,
}

/// `LifecycleConfiguration` in `types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleConfiguration {
    #[serde(default)]
    pub rules: Vec<LifecycleRule>,
}

/// `LifecycleIssue` in `types.ts`: `rule_index`/`field` place the message in the editor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleIssue {
    pub rule_index: Option<usize>,
    pub field: Option<String>,
    pub message: String,
}

/// `BucketVersioning` in `types.ts`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub enum BucketVersioning {
    Enabled,
    Suspended,
    Off,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct JobPreview {
    pub objects: u64,
    pub bytes: u64,
    pub conflicts: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobError {
    pub key: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub kind: JobKind,
    pub src_bucket: String,
    pub dest_bucket: Option<String>,
    pub label: String,
    pub phase: JobPhase,
    pub total_items: u64,
    pub done_items: u64,
    pub skipped_items: u64,
    pub failed_items: u64,
    pub total_bytes: u64,
    pub done_bytes: u64,
    pub status: JobStatus,
    pub error: Option<String>,
    pub errors: Vec<JobError>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

// ---- v0.5.0: folder transfers (batches) ----

pub const BATCH_PROGRESS_EVENT: &str = "batch:progress";
/// Most files in one batch (mirror `BATCH_LIMITS.maxFiles` in `types.ts`).
pub const BATCH_MAX_FILES: u64 = 50_000;
/// Most bytes in one batch: 1 TiB (mirror `BATCH_LIMITS.maxBytes`).
pub const BATCH_MAX_BYTES: u64 = 1024 * 1024 * 1024 * 1024;
/// `Batch.errors` and `BatchPreview.notes` keep the first this many entries.
pub const BATCH_MAX_ERRORS: usize = 50;
pub const BATCH_MAX_NOTES: usize = 50;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BatchKind {
    Upload,
    Download,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BatchStatus {
    Planning,
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl BatchStatus {
    pub fn is_active(self) -> bool {
        matches!(self, BatchStatus::Planning | BatchStatus::Queued | BatchStatus::Running)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BatchPlanRequest {
    pub kind: BatchKind,
    pub bucket: String,
    /// Upload: destination prefix ("" or ending in "/"). Download: source prefix (ending in "/").
    pub prefix: String,
    /// Upload: the folder to walk. Download: the directory to write into.
    pub local_path: String,
    #[serde(default)]
    pub on_conflict: ConflictPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BatchPreview {
    pub files: u64,
    pub bytes: u64,
    pub conflicts: u64,
    pub skipped_unreadable: u64,
    pub truncated: bool,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BatchError {
    /// The key (download) or the local path (upload).
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub id: String,
    pub kind: BatchKind,
    pub bucket: String,
    pub prefix: String,
    pub local_path: String,
    pub label: String,
    pub total_files: u64,
    pub done_files: u64,
    pub skipped_files: u64,
    pub failed_files: u64,
    pub total_bytes: u64,
    pub done_bytes: u64,
    pub bytes_per_sec: u64,
    pub status: BatchStatus,
    pub error: Option<String>,
    pub errors: Vec<BatchError>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

/// Current time as ISO-8601 UTC with millisecond precision.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Formats an S3 timestamp as ISO-8601 UTC.
pub fn fmt_dt(dt: Option<&aws_smithy_types::DateTime>) -> Option<String> {
    dt.and_then(|d| d.fmt(aws_smithy_types::date_time::Format::DateTime).ok())
}

/// Strips the surrounding quotes S3 puts around ETags.
pub fn clean_etag(etag: Option<&str>) -> Option<String> {
    etag.map(|e| e.trim_matches('"').to_string())
}

/// Last path segment of a key or prefix ("a/b/c/" -> "c", "a/b.txt" -> "b.txt").
pub fn last_segment(path: &str) -> String {
    // Strip exactly one trailing '/' (a folder prefix); "a//" is the folder named "" inside "a/".
    let trimmed = path.strip_suffix('/').unwrap_or(path);
    trimmed.rsplit('/').next().unwrap_or(trimmed).to_string()
}

// ---- v0.5.0: object versions and archived objects ----

/// Most versions `list_object_versions` returns (`truncated: true` beyond that).
pub const VERSION_LIST_MAX: usize = 1000;

/// One version (or delete marker) of a key (`ObjectVersion` in `types.ts`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObjectVersion {
    /// `"null"` for objects written before versioning was enabled.
    pub version_id: String,
    pub is_latest: bool,
    pub is_delete_marker: bool,
    /// 0 for delete markers.
    pub size: u64,
    pub last_modified: Option<String>,
    pub etag: Option<String>,
    pub storage_class: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VersionListing {
    /// Newest first, at most [`VERSION_LIST_MAX`].
    pub versions: Vec<ObjectVersion>,
    pub truncated: bool,
}

/// Retrieval tier of a restore. Serialized exactly as S3 names them: `Bulk`, `Standard`, `Expedited`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum RestoreTier {
    Bulk,
    Standard,
    Expedited,
}

impl RestoreTier {
    pub fn as_str(self) -> &'static str {
        match self {
            RestoreTier::Bulk => "Bulk",
            RestoreTier::Standard => "Standard",
            RestoreTier::Expedited => "Expedited",
        }
    }
}

/// `RestoreRequest` in `types.ts`. `days` is signed so an out-of-range value is an
/// `InvalidInput` with a message, not a deserialization failure.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreRequest {
    pub tier: RestoreTier,
    /// How long the restored copy stays readable, [`RESTORE_DAYS_MIN`]..=[`RESTORE_DAYS_MAX`].
    pub days: i64,
}

pub const RESTORE_DAYS_MIN: i64 = 1;
pub const RESTORE_DAYS_MAX: i64 = 365;

/// Restore state from the `x-amz-restore` header (`ObjectMeta.restore` in `types.ts`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreStatus {
    pub in_progress: bool,
    /// ISO-8601 when the restored copy expires (only once the restore finished).
    pub expires_at: Option<String>,
}

// ---- v0.6.0: search in a bucket ------------------------------------------------------------

/// `search_objects` stops after looking at this many keys (folder markers are not counted).
pub const SEARCH_MAX_SCAN: u64 = 50_000;
/// `search_objects` makes at most this many `GetObjectTagging` calls.
pub const SEARCH_MAX_TAG_LOOKUPS: u64 = 2_000;
/// `search_objects` lists at most this many `ListObjectsV2` pages (a bucket of folder markers).
pub const SEARCH_MAX_PAGES: u64 = 200;
/// Inclusive range of `SearchQuery.limit`.
pub const SEARCH_LIMIT_MIN: i64 = 1;
pub const SEARCH_LIMIT_MAX: i64 = 1000;
/// `GetObjectTagging` calls in flight at once.
pub const SEARCH_TAG_PARALLELISM: usize = 16;

/// `SearchQuery` in `types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub bucket: String,
    /// Prefix to search under; "" = the whole bucket.
    pub scope: String,
    /// The query as typed.
    pub text: String,
    /// Max hits, 1..=1000.
    pub limit: i64,
}

/// `tag:key=value` (`value: Some`) or `tag:key` (`value: None`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchTagTerm {
    pub key: String,
    pub value: Option<String>,
}

/// `ParsedSearch` in `types.ts`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParsedSearch {
    /// Includes path terms; lowercased.
    pub words: Vec<String>,
    pub phrases: Vec<String>,
    pub excluded: Vec<String>,
    pub tags: Vec<SearchTagTerm>,
    /// The whole query when it is one unquoted path term, exactly as typed.
    pub exact_path: Option<String>,
    /// The prefix the scan listed.
    pub list_prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub kind: SearchHitKind,
    /// Set for `kind: "object"`.
    pub entry: Option<ObjectEntry>,
    /// Set for `kind: "folder"`; the prefix is passed through byte-for-byte.
    pub folder: Option<FolderEntry>,
    /// Objects only, and only when the query has tag terms.
    pub tags: Option<Vec<Tag>>,
    /// The exact-path hit (an object headed, or a folder listed, from `exact_path`).
    pub exact: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SearchHitKind {
    Object,
    Folder,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    /// The exact hit first (if any), then in key order.
    pub hits: Vec<SearchHit>,
    pub scanned: u64,
    pub tag_lookups: u64,
    pub truncated: bool,
    pub reason: Option<String>,
    pub parsed: ParsedSearch,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_config_json() {
        let c: ConnectionConfig = serde_json::from_str(
            r#"{"kind":"static","accessKeyId":"a","secretAccessKey":"b","region":"us-east-1","endpoint":"http://x","forcePathStyle":false}"#,
        )
        .expect("parse static");
        assert!(matches!(c, ConnectionConfig::Static { force_path_style: Some(false), .. }));
        let p: ConnectionConfig =
            serde_json::from_str(r#"{"kind":"profile","profile":"dev"}"#).expect("parse profile");
        assert!(matches!(p, ConnectionConfig::Profile { region: None, endpoint: None, .. }));
    }

    #[test]
    fn transfer_json() {
        let t = Transfer {
            id: "x".into(),
            kind: TransferKind::Download,
            batch_id: None,
            bucket: "b".into(),
            key: "k".into(),
            local_path: "p".into(),
            total_bytes: 1,
            transferred_bytes: 0,
            parts_total: 1,
            parts_done: 0,
            bytes_per_sec: 0,
            status: TransferStatus::Queued,
            error: None,
            started_at: now_iso(),
            finished_at: None,
        };
        let v = serde_json::to_value(&t).expect("ser");
        assert_eq!(v["kind"], "download");
        assert_eq!(v["status"], "queued");
        assert!(v.get("localPath").is_some());
        assert!(v.get("bytesPerSec").is_some());
        assert_eq!(v["batchId"], serde_json::Value::Null, "batchId is always present");
        let e = serde_json::to_value(crate::error::AppError::not_connected()).expect("ser");
        assert_eq!(e["code"], "NotConnected");
    }

    #[test]
    fn job_json() {
        let r: JobRequest = serde_json::from_str(
            r#"{"kind":"move","srcBucket":"a","destBucket":"b","items":[{"from":"x/","to":"y/","isPrefix":true}],"onConflict":"overwrite"}"#,
        )
        .expect("parse request");
        assert_eq!(r.kind, JobKind::Move);
        assert_eq!(r.dest_bucket.as_deref(), Some("b"));
        assert_eq!(r.on_conflict, ConflictPolicy::Overwrite);
        assert!(r.items[0].is_prefix);
        let d: JobRequest = serde_json::from_str(
            r#"{"kind":"delete","srcBucket":"a","destBucket":null,"items":[{"from":"k","to":null,"isPrefix":false}]}"#,
        )
        .expect("parse delete");
        assert_eq!(d.on_conflict, ConflictPolicy::Skip, "missing onConflict defaults to skip");
        assert!(d.dest_bucket.is_none() && d.items[0].to.is_none());
        let j = Job {
            id: "i".into(),
            kind: JobKind::Copy,
            src_bucket: "a".into(),
            dest_bucket: None,
            label: "l".into(),
            phase: JobPhase::Listing,
            total_items: 0,
            done_items: 0,
            skipped_items: 0,
            failed_items: 0,
            total_bytes: 0,
            done_bytes: 0,
            status: JobStatus::Queued,
            error: None,
            errors: vec![JobError { key: "k".into(), message: "m".into() }],
            started_at: now_iso(),
            finished_at: None,
        };
        let v = serde_json::to_value(&j).expect("ser");
        for f in [
            "id", "kind", "srcBucket", "destBucket", "label", "phase", "totalItems", "doneItems", "skippedItems",
            "failedItems", "totalBytes", "doneBytes", "status", "error", "errors", "startedAt", "finishedAt",
        ] {
            assert!(v.get(f).is_some(), "missing {f}");
        }
        assert_eq!(v.as_object().map(|o| o.len()), Some(17));
        assert_eq!(v["kind"], "copy");
        assert_eq!(v["phase"], "listing");
        assert_eq!(v["status"], "queued");
        assert_eq!(v["destBucket"], serde_json::Value::Null);
        let p = serde_json::to_value(JobPreview { objects: 1, bytes: 2, conflicts: 3, truncated: true }).expect("ser");
        assert_eq!(p, serde_json::json!({"objects":1,"bytes":2,"conflicts":3,"truncated":true}));
        for (k, s) in [(JobPhase::Working, "working"), (JobPhase::Done, "done")] {
            assert_eq!(serde_json::to_value(k).expect("ser"), s);
        }
        for (k, s) in [(JobStatus::Completed, "completed"), (JobStatus::Failed, "failed"), (JobStatus::Cancelled, "cancelled"), (JobStatus::Running, "running")] {
            assert_eq!(serde_json::to_value(k).expect("ser"), s);
        }
        assert_eq!(serde_json::to_value(JobKind::Delete).expect("ser"), "delete");
        assert_eq!(serde_json::to_value(ConflictPolicy::Skip).expect("ser"), "skip");
    }

    #[test]
    fn batch_json() {
        let r: BatchPlanRequest = serde_json::from_str(
            r#"{"kind":"download","bucket":"b","prefix":"logs/","localPath":"D:\\dl","onConflict":"overwrite"}"#,
        )
        .expect("parse");
        assert_eq!(r.kind, BatchKind::Download);
        assert_eq!(r.local_path, "D:\\dl");
        assert_eq!(r.on_conflict, ConflictPolicy::Overwrite);
        let p = serde_json::to_value(BatchPreview { files: 1, bytes: 2, conflicts: 3, skipped_unreadable: 4, truncated: true, notes: vec!["n".into()] })
            .expect("ser");
        assert_eq!(p, serde_json::json!({"files":1,"bytes":2,"conflicts":3,"skippedUnreadable":4,"truncated":true,"notes":["n"]}));
        let b = Batch {
            id: "i".into(),
            kind: BatchKind::Upload,
            bucket: "b".into(),
            prefix: "p/".into(),
            local_path: "/x".into(),
            label: "l".into(),
            total_files: 0,
            done_files: 0,
            skipped_files: 0,
            failed_files: 0,
            total_bytes: 0,
            done_bytes: 0,
            bytes_per_sec: 0,
            status: BatchStatus::Planning,
            error: None,
            errors: vec![BatchError { path: "k".into(), message: "m".into() }],
            started_at: now_iso(),
            finished_at: None,
        };
        let v = serde_json::to_value(&b).expect("ser");
        for f in [
            "id", "kind", "bucket", "prefix", "localPath", "label", "totalFiles", "doneFiles", "skippedFiles", "failedFiles",
            "totalBytes", "doneBytes", "bytesPerSec", "status", "error", "errors", "startedAt", "finishedAt",
        ] {
            assert!(v.get(f).is_some(), "missing {f}");
        }
        assert_eq!(v.as_object().map(|o| o.len()), Some(18));
        assert_eq!(v["kind"], "upload");
        assert_eq!(v["status"], "planning");
        assert_eq!(v["errors"][0], serde_json::json!({"path":"k","message":"m"}));
        for (k, s) in [(BatchStatus::Queued, "queued"), (BatchStatus::Running, "running"), (BatchStatus::Completed, "completed"), (BatchStatus::Failed, "failed"), (BatchStatus::Cancelled, "cancelled")] {
            assert_eq!(serde_json::to_value(k).expect("ser"), s);
        }
        assert_eq!(BATCH_MAX_BYTES, 1u64 << 40);
    }

    #[test]
    fn segments() {
        assert_eq!(last_segment("a/b/c/"), "c");
        assert_eq!(last_segment("a/b.txt"), "b.txt");
        assert_eq!(last_segment("top"), "top");
        assert_eq!(last_segment("a//"), "");
        assert_eq!(last_segment("/"), "");
        assert_eq!(last_segment("/foo/"), "foo");
    }
}
