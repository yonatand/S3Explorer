// Canonical types shared with the Rust backend. See docs/CONTRACT.md.

export type ErrorCode =
  | "NotConnected" | "Auth" | "NoSuchBucket" | "NoSuchKey" | "AccessDenied"
  | "Network" | "Io" | "Cancelled" | "InvalidInput" | "Keychain" | "Conflict" | "NotSupported" | "Unknown";

export interface AppError { code: ErrorCode; message: string }

export interface ProfileInfo { name: string; region: string | null; hasCredentials: boolean }

export type ConnectionConfig =
  | { kind: "profile"; profile: string; region?: string | null; endpoint?: string | null }
  | {
      kind: "static";
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string | null;
      region: string;
      endpoint?: string | null;
      forcePathStyle?: boolean;
    };

export interface ConnectionInfo { label: string; region: string; endpoint: string | null; canListBuckets: boolean }

export interface Bucket { name: string; creationDate: string | null }

export interface FolderEntry { prefix: string; name: string }

export interface ObjectEntry {
  key: string;
  name: string;
  size: number;
  lastModified: string | null;
  etag: string | null;
  storageClass: string | null;
}

export interface ListPage {
  folders: FolderEntry[];
  objects: ObjectEntry[];
  nextContinuationToken: string | null;
  isTruncated: boolean;
}

export interface ObjectMeta extends ObjectEntry {
  contentType: string | null;
  metadata: Record<string, string>;
  versionId: string | null;
  /** v0.5.0: restore state from x-amz-restore; null when not applicable. */
  restore: { inProgress: boolean; expiresAt: string | null } | null;
  /** v0.5.0: true when the object must be restored before it can be read. */
  archived: boolean;
  /** Edit metadata (after v0.7.0): the Cache-Control and Content-Disposition headers. */
  cacheControl: string | null;
  contentDisposition: string | null;
}

export type TransferKind = "download" | "upload";
export type TransferStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";

export interface Transfer {
  id: string;
  kind: TransferKind;
  /** v0.5.0: set when the transfer belongs to a folder batch. */
  batchId?: string | null;
  bucket: string;
  key: string;
  localPath: string;
  totalBytes: number;
  transferredBytes: number;
  partsTotal: number;
  partsDone: number;
  bytesPerSec: number;
  status: TransferStatus;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** v0.9.0: the ETag a download was pinned to (If-Match on every part); null for uploads or when the server sent none. */
  etag?: string | null;
}

export const TRANSFER_PROGRESS_EVENT = "transfer:progress";

// ---- Settings (see "Settings" in docs/CONTRACT.md) ----

export interface TransferSettings {
  /** null = Auto (8 MiB; 16 MiB for objects over 1 GiB). Otherwise an integer number of MiB. */
  partSizeMib: number | null;
  /** Parts in flight per transfer. */
  maxConcurrentParts: number;
  /** Transfers running at once; the rest queue. */
  maxConcurrentTransfers: number;
}

export const DEFAULT_TRANSFER_SETTINGS: TransferSettings = {
  partSizeMib: null,
  maxConcurrentParts: 8,
  maxConcurrentTransfers: 4,
};

export const TRANSFER_SETTINGS_LIMITS = {
  partSizeMib: { min: 1, max: 256 },
  maxConcurrentParts: { min: 1, max: 32 },
  maxConcurrentTransfers: { min: 1, max: 10 },
} as const;

/** Part size Auto mode uses for objects up to 1 GiB / above 1 GiB. */
export const AUTO_PART_SIZE_MIB = { standard: 8, large: 16 } as const;
/** S3 minimum for non-final multipart upload parts. */
export const MIN_UPLOAD_PART_MIB = 5;

/** Result of `list_recent` (see "Newest files" in docs/CONTRACT.md). */
export interface RecentListing {
  /** At most 200, newest first. */
  objects: ObjectEntry[];
  /** Objects looked at. */
  scanned: number;
  /** The scan stopped at its limit before the end of the listing. */
  truncated: boolean;
}

// ---- v0.3.0 (see "v0.3.0 additions" in docs/CONTRACT.md) ----

export type ThemeMode = "system" | "light" | "dark";
/** The interface's accent colour (see "Accent colour" in docs/CONTRACT.md). */
export type AccentColor = "yellow" | "green" | "blue" | "red";
export const ACCENT_COLORS: readonly AccentColor[] = ["yellow", "green", "blue", "red"];

/** Flat settings object. Supersedes TransferSettings (kept above for reference of the transfer fields). */
export interface AppSettings extends TransferSettings {
  theme: ThemeMode;
  checkUpdatesOnStartup: boolean;
  /** See "Desktop notifications" in docs/CONTRACT.md. */
  notifyOnFinish: boolean;
  /** Interface scale in percent (see "Text size and weight" in docs/CONTRACT.md). */
  textSize: number;
  /** Font weight of ordinary text. */
  textWeight: number;
  accent: AccentColor;
  /** v0.4.0: show the Copy/Move confirmation even when nothing conflicts. Delete always confirms. */
  confirmCopyMove: boolean;
  /**
   * v0.6.0: program for "Show in folder" / "Open folder" with `{path}` and `{dir}` placeholders
   * (see "File manager override" in docs/CONTRACT.md); null = the system file manager.
   */
  fileManagerCommand: string | null;
  /**
   * v0.7.0: keyboard binding overrides, action id → chords (e.g. "Mod+R"); only actions that differ
   * from the defaults (see "Keyboard" in docs/CONTRACT.md). Default {}.
   */
  keybindings: Record<string, string[]>;
  /**
   * Bandwidth limits in KiB/s shared by all transfers (see "Bandwidth limit" in docs/CONTRACT.md);
   * null = unlimited. Integers within `BANDWIDTH_LIMITS` otherwise.
   */
  downloadLimitKibps: number | null;
  uploadLimitKibps: number | null;
  /** v0.8.0: load a preview (HEAD + bounded GET) as soon as a single file is selected. Default true. */
  previewAutomatically: boolean;
  /**
   * v0.9.0: the default keybinding map that `keybindings` overrides apply to. New installs get
   * "commander"; a settings file without the field loads "classic" (see "Keybinding presets").
   */
  keybindingsPreset: KeybindingsPreset;
}

/** Range of `downloadLimitKibps` / `uploadLimitKibps` (the backend enforces the same). */
export const BANDWIDTH_LIMITS = { minKibps: 64, maxKibps: 1_048_576 } as const;

/** Ranges and slider steps for the text settings (the backend enforces the same ranges). */
export const TEXT_SETTINGS_LIMITS = {
  textSize: { min: 80, max: 150, step: 5 },
  textWeight: { min: 300, max: 600, step: 50 },
} as const;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  ...DEFAULT_TRANSFER_SETTINGS,
  theme: "system",
  checkUpdatesOnStartup: true,
  notifyOnFinish: true,
  textSize: 100,
  textWeight: 400,
  accent: "yellow",
  confirmCopyMove: true,
  fileManagerCommand: null,
  keybindings: {},
  downloadLimitKibps: null,
  uploadLimitKibps: null,
  previewAutomatically: true,
  keybindingsPreset: "commander",
};

// Saved connections

export interface SavedConnection {
  id: string;
  name: string;
  kind: "profile" | "static";
  profile: string | null;
  accessKeyId: string | null;
  region: string | null;
  endpoint: string | null;
  forcePathStyle: boolean;
  hasSecret: boolean;
  lastUsedAt: string | null;
}

export interface SaveConnectionInput {
  id?: string | null;
  name: string;
  config: ConnectionConfig;
}

export const SAVED_CONNECTION_NAME_MAX = 64;

// Object operations (jobs)

export type JobKind = "delete" | "copy" | "move" | "tag" | "restore";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ConflictPolicy = "overwrite" | "skip";

export interface JobItem {
  from: string;
  to: string | null;
  isPrefix: boolean;
  /** v0.9.0, delete jobs only: delete the object only if its ETag still matches (If-Match); an object that changed is reported, not deleted. */
  etag?: string | null;
}

export interface JobRequest {
  kind: JobKind;
  srcBucket: string;
  destBucket: string | null;
  items: JobItem[];
  onConflict: ConflictPolicy;
  /** Required when kind is "tag"; must be absent otherwise. */
  tags?: TagOperation;
  /** Required when kind is "restore"; must be absent otherwise. */
  restore?: RestoreRequest;
}

export interface JobPreview {
  objects: number;
  bytes: number;
  conflicts: number;
  truncated: boolean;
}

export interface JobError { key: string; message: string }

export interface Job {
  id: string;
  kind: JobKind;
  srcBucket: string;
  destBucket: string | null;
  label: string;
  phase: "listing" | "working" | "done";
  totalItems: number;
  doneItems: number;
  skippedItems: number;
  failedItems: number;
  totalBytes: number;
  doneBytes: number;
  status: JobStatus;
  error: string | null;
  errors: JobError[];
  startedAt: string;
  finishedAt: string | null;
}

export const JOB_PROGRESS_EVENT = "job:progress";
export const JOB_MAX_ITEMS = 10_000;

// Updates

export interface UpdateInfo {
  currentVersion: string;
  available: boolean;
  latestVersion: string | null;
  notes: string | null;
  publishedAt: string | null;
  canInstall: boolean;
  downloadUrl: string;
}

export type UpdatePhase = "downloading" | "installing" | "restarting";
export interface UpdateProgress { phase: UpdatePhase; downloadedBytes: number; totalBytes: number | null }

export const UPDATE_PROGRESS_EVENT = "update:progress";

/** Downloads buffer at most this much per in-flight part; larger parts are streamed to disk. */
export const DOWNLOAD_BUFFER_CAP_MIB = 16;

// ---- v0.4.0: the buckets update (see "v0.4.0 additions" in docs/CONTRACT.md) ----

// Shared buckets added by name
export interface AddedBucket {
  name: string;
  region: string | null;
  addedAt: string;
}

// Tags
export interface Tag { key: string; value: string }

export const TAG_LIMITS = {
  bucketMaxTags: 50,
  objectMaxTags: 10,
  keyMaxChars: 128,
  valueMaxChars: 256,
  reservedKeyPrefix: "aws:",
  /** Letters, numbers, spaces and + - = . _ : / @ */
  allowedChars: /^[\p{L}\p{N}\p{Z}+\-=._:/@]*$/u,
} as const;

export interface TagOperation {
  mode: "merge" | "replace";
  set: Tag[];
  remove: string[];
}

// Lifecycle
export type RuleStatus = "Enabled" | "Disabled";
export type TransitionStorageClass =
  | "STANDARD_IA" | "ONEZONE_IA" | "INTELLIGENT_TIERING" | "GLACIER_IR" | "GLACIER" | "DEEP_ARCHIVE";

/**
 * S3's transition waterfall: within a rule, each later transition must go to a class with a strictly
 * higher rank (STANDARD_IA → INTELLIGENT_TIERING → ONEZONE_IA → GLACIER_IR → GLACIER → DEEP_ARCHIVE).
 */
export const STORAGE_CLASS_RANK: Record<TransitionStorageClass, number> = {
  STANDARD_IA: 1,
  INTELLIGENT_TIERING: 2,
  ONEZONE_IA: 3,
  GLACIER_IR: 4,
  GLACIER: 5,
  DEEP_ARCHIVE: 6,
};

export interface LifecycleFilter {
  prefix: string | null;
  tags: Tag[];
  objectSizeGreaterThan: number | null;
  objectSizeLessThan: number | null;
}

export interface Transition { days: number | null; date: string | null; storageClass: TransitionStorageClass }
export interface Expiration { days: number | null; date: string | null; expiredObjectDeleteMarker: boolean }
export interface NoncurrentTransition { noncurrentDays: number; newerNoncurrentVersions: number | null; storageClass: TransitionStorageClass }
export interface NoncurrentExpiration { noncurrentDays: number; newerNoncurrentVersions: number | null }

export interface LifecycleRule {
  id: string;
  status: RuleStatus;
  filter: LifecycleFilter;
  transitions: Transition[];
  expiration: Expiration | null;
  noncurrentVersionTransitions: NoncurrentTransition[];
  noncurrentVersionExpiration: NoncurrentExpiration | null;
  abortIncompleteMultipartUpload: { daysAfterInitiation: number } | null;
}

export interface LifecycleConfiguration { rules: LifecycleRule[] }

export interface LifecycleIssue { ruleIndex: number | null; field: string | null; message: string }

export const LIFECYCLE_LIMITS = {
  maxRules: 1000,
  ruleIdMaxChars: 255,
  /** Minimum days before a transition to STANDARD_IA or ONEZONE_IA only (INTELLIGENT_TIERING and the archive classes may use day 0). */
  minDaysToInfrequentAccess: 30,
  /** Minimum gap in days between a STANDARD_IA / ONEZONE_IA transition and a later archive transition. */
  minDaysBetweenTiers: 30,
  newerNoncurrentVersions: { min: 1, max: 100 },
} as const;

export type BucketVersioning = "Enabled" | "Suspended" | "Off";

// ---- v0.5.0: folders, versions, archives (see "v0.5.0 additions" in docs/CONTRACT.md) ----

// Folder transfers (batches)
export type BatchKind = "upload" | "download";
export type BatchStatus = "planning" | "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";

export interface BatchPlanRequest {
  kind: BatchKind;
  bucket: string;
  prefix: string;
  localPath: string;
  onConflict: ConflictPolicy;
}

export interface BatchPreview {
  files: number;
  bytes: number;
  conflicts: number;
  skippedUnreadable: number;
  truncated: boolean;
  notes: string[];
}

export interface Batch {
  id: string;
  kind: BatchKind;
  bucket: string;
  prefix: string;
  localPath: string;
  label: string;
  totalFiles: number;
  doneFiles: number;
  skippedFiles: number;
  failedFiles: number;
  totalBytes: number;
  doneBytes: number;
  bytesPerSec: number;
  status: BatchStatus;
  error: string | null;
  errors: { path: string; message: string }[];
  startedAt: string;
  finishedAt: string | null;
}

export const BATCH_PROGRESS_EVENT = "batch:progress";
export const BATCH_LIMITS = { maxFiles: 50_000, maxBytes: 1024 ** 4 } as const;

// Object versions
export interface ObjectVersion {
  versionId: string;
  isLatest: boolean;
  isDeleteMarker: boolean;
  size: number;
  lastModified: string | null;
  etag: string | null;
  storageClass: string | null;
}

export interface VersionListing { versions: ObjectVersion[]; truncated: boolean }

// Archived objects
export type RestoreTier = "Bulk" | "Standard" | "Expedited";
export interface RestoreRequest { tier: RestoreTier; days: number }
export const RESTORE_DAYS = { min: 1, max: 365, default: 7 } as const;
/** Storage classes whose objects need a restore before they can be read. */
export const ARCHIVE_STORAGE_CLASSES = ["GLACIER", "DEEP_ARCHIVE"] as const;

// ---- v0.6.0: search, and the Activity menu (see "v0.6.0 additions" in docs/CONTRACT.md) ----

// Search in a bucket
export interface SearchQuery {
  bucket: string;
  /** Prefix to search under; "" = the whole bucket. */
  scope: string;
  /** The query as typed; parsed by the backend (words, "phrases", -exclusions, tag:key=value, path terms). */
  text: string;
  /** Max hits, 1..=1000. */
  limit: number;
}

export interface SearchTagTerm { key: string; value: string | null }

export interface ParsedSearch {
  /** Includes path terms; lowercased. */
  words: string[];
  phrases: string[];
  excluded: string[];
  tags: SearchTagTerm[];
  /** Set when the whole query is one unquoted path term: tried as a key with HeadObject. */
  exactPath: string | null;
  /** The prefix the scan actually listed (scope, possibly narrowed by a path term). */
  listPrefix: string;
}

export interface SearchHit {
  kind: "object" | "folder";
  /** Set for kind "object". */
  entry: ObjectEntry | null;
  /** Set for kind "folder"; the prefix is passed through byte-for-byte. */
  folder: FolderEntry | null;
  /** Objects only, and only when the query has tag terms. */
  tags: Tag[] | null;
  /** The exact-path hit (an object headed, or a folder listed, from `exactPath`). */
  exact: boolean;
}

export interface SearchResult {
  /** Exact hits first, then folders in prefix order, then objects in key order. */
  hits: SearchHit[];
  /** Keys the scan looked at. */
  scanned: number;
  /** GetObjectTagging calls made. */
  tagLookups: number;
  /** A cap stopped the search before the end of the listing. */
  truncated: boolean;
  /** Which cap, in words, when truncated. */
  reason: string | null;
  parsed: ParsedSearch;
}

export const FILE_MANAGER_COMMAND_MAX = 1024;

/** v0.9.0: the two shipped default keybinding maps (see "Keybinding presets" in docs/CONTRACT.md). */
export type KeybindingsPreset = "commander" | "classic";

// ---- v0.9.0: pane sources, the local computer (see "Pane sources" in docs/CONTRACT.md) ----

export type PaneSource = { kind: "s3" } | { kind: "local" };

export interface LocalRoot { path: string; label: string; kind: "drive" | "home" | "folder" | "network" }

export interface LocalEntry {
  name: string;
  /** Absolute, as the OS returns it; sent back verbatim. */
  path: string;
  isDir: boolean;
  /** 0 for directories. */
  size: number;
  /** RFC 3339, or null when unknown. */
  modified: string | null;
  /** The entry itself is a symlink or junction: shown with a badge, never followed. */
  isSymlink: boolean;
  hidden: boolean;
}

export interface LocalListing { dirs: LocalEntry[]; files: LocalEntry[]; truncated: boolean; parent: string | null }

export interface TrashResult { trashed: number; failed: { path: string; message: string }[] }

export interface LocalDirSize { files: number; bytes: number; truncated: boolean }

export const LOCAL_LIMITS = { maxEntries: 50_000, dirSizeMaxEntries: 200_000 } as const;

/** v0.9.0: what the command line asked the app to open (see "Command line" in docs/CONTRACT.md). */
export interface LaunchRequest {
  connection: string | null;
  local: string | null;
  s3: { bucket: string; prefix: string } | null;
  raw: string[];
}

export const LAUNCH_OPEN_EVENT = "launch:open";

/** Limits for `AppSettings.keybindings` and the export/import file (see "Keyboard" in docs/CONTRACT.md). */
export const KEYBINDING_LIMITS = {
  maxActions: 200,
  idMaxChars: 64,
  maxChordsPerAction: 4,
  chordMaxChars: 40,
  fileMaxBytes: 65_536,
} as const;

export const SEARCH_LIMITS = {
  /** Keys scanned per search before the result is truncated. */
  maxScan: 50_000,
  /** GetObjectTagging calls per search before the result is truncated. */
  maxTagLookups: 2_000,
  hits: { min: 1, max: 1000 },
  /** What the UI asks for. */
  uiLimit: 500,
} as const;

/** `open_local` refuses these extensions (case-insensitive): the file could run as a program. */
export const OPEN_LOCAL_REFUSED_EXTENSIONS = [
  "exe", "bat", "cmd", "com", "scr", "pif", "cpl", "msc", "hta", "chm", "scf", "ps1", "psm1", "msi", "msp", "mst",
  "vbs", "vbe", "js", "jse", "ws", "wsf", "wsh", "wsc", "jar", "xll", "jnlp", "gadget", "application", "appref-ms",
  "settingcontent-ms", "diagcab", "library-ms", "search-ms", "py", "pyw", "sh", "command", "app", "terminal",
  "fileloc", "inetloc", "desktop", "reg", "lnk", "url",
] as const;

// ---- Folder size (see "Folder size" in docs/CONTRACT.md) ----

/** Result of `folder_size`. */
export interface FolderSize {
  /** Objects counted (folder markers, keys ending in "/", are not counted). */
  objects: number;
  bytes: number;
  /** Keys listed, folder markers included. */
  scanned: number;
  /** Stopped at FOLDER_SIZE_SCAN_LIMIT: the numbers are a lower bound. */
  truncated: boolean;
}

/** `folder_size` lists at most this many keys. */
export const FOLDER_SIZE_SCAN_LIMIT = 200_000;

// ---- Bookmarks (added on request after v0.7.0; frontend only, see "Bookmarks" in docs/CONTRACT.md) ----

/** A bookmarked folder, stored per connection in localStorage. */
export interface Bookmark {
  bucket: string;
  /** Verbatim from the server, "" for a bucket root. */
  prefix: string;
  /** Defaults to the folder name, or the bucket name at a root. */
  label: string;
}

export const BOOKMARKS_MAX = 100;

// Edit content type and metadata (added on request after v0.7.0)
/** One object's headers to write by copying it onto itself (`update_object_metadata`). */
export interface MetadataEdit {
  bucket: string;
  /** Verbatim. */
  key: string;
  /** The ETag the dialog showed; the copy is conditional on it. */
  expectedEtag: string;
  /** The LastModified the dialog showed (ISO-8601, as in ObjectMeta); the copy is conditional on it too. */
  expectedLastModified: string;
  /** 1..=255 printable ASCII. */
  contentType: string;
  /** null = no header. */
  cacheControl: string | null;
  /** null = no header. */
  contentDisposition: string | null;
  /** User metadata; replaces the old set entirely. */
  metadata: Record<string, string>;
}

export const METADATA_LIMITS = { maxTotalBytes: 2048, maxKeyChars: 128 } as const;

// ---- Object preview (see "Object preview" in docs/CONTRACT.md) ----

export type PreviewKind = "text" | "image" | "unsupported";

export interface ObjectPreview {
  kind: PreviewKind;
  /** As stored in S3. */
  contentType: string | null;
  /** The object's full size. */
  size: number;
  /** Text only: just the first `PREVIEW_LIMITS.textMaxBytes` were read. */
  truncated: boolean;
  /** Kind "text": UTF-8, invalid sequences replaced. */
  text: string | null;
  /** Kind "image": the whole object. */
  dataBase64: string | null;
  /** Kind "unsupported": a short user-facing reason. */
  reason: string | null;
}

export const PREVIEW_LIMITS = { textMaxBytes: 262_144, imageMaxBytes: 10_485_760, imageAutoBytes: 2_097_152 } as const;

// ---- History (added after v0.7.0; frontend only, see "History" in docs/CONTRACT.md) ----

export type HistoryTransferKind = "download" | "upload" | "folderDownload" | "folderUpload";
/** File operations (jobs); a move of one item within its folder is recorded as "rename". */
export type HistoryJobKind = "copy" | "move" | "rename" | "delete" | "tag" | "restore";
export type HistoryKind = HistoryTransferKind | HistoryJobKind;

/** What a finished job did (set exactly when the entry's kind is a `HistoryJobKind`). */
export interface HistoryJob {
  srcBucket: string;
  /** The folder holding the chosen items (verbatim); "" for the bucket root. */
  srcPrefix: string;
  destBucket: string | null;
  /** The folder the items went to (verbatim); null for delete / tag / restore. */
  destPrefix: string | null;
  /** Items the user chose (keys or prefixes). */
  items: number;
  /** The first chosen key or prefix, and where it went (verbatim). */
  first: string;
  firstTo: string | null;
  /** Objects the job covered once folders were expanded, and how they ended. */
  objects: number;
  done: number;
  skipped: number;
  failed: number;
  firstError: string | null;
  /** The backend's label for the job, shown when the request is not known. */
  label: string;
}

export interface HistoryEntry {
  /** `connectionKey()` of the connection the entry was recorded on; "" in entries from before the field existed. */
  connectionKey: string;
  /** The transfer, batch or job id. */
  id: string;
  kind: HistoryKind;
  status: "completed" | "failed" | "cancelled";
  /** The bucket (a job's source bucket). */
  bucket: string;
  /** Object key, or the prefix for folder transfers; a job's source folder (verbatim). */
  key: string;
  /** File or folder on this computer; "" for jobs. */
  localPath: string;
  /** Bytes transferred or copied; 0 when not known (deletes, tags, restores). */
  bytes: number;
  /** Files transferred (1 for single transfers); objects done for jobs. */
  files: number;
  /** Display label of the connection it ran on. */
  connection: string;
  /** ISO-8601. */
  finishedAt: string;
  error: string | null;
  /** Set when a download fetched an older version of the object. */
  versionId?: string | null;
  /** Set for file operations. */
  job?: HistoryJob | null;
}

export const HISTORY_STORAGE_KEY = "s3x.transferHistory";
export const HISTORY_MAX_ENTRIES = 500;
