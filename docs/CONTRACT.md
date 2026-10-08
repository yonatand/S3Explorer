# S3 Explorer — Backend/Frontend Contract

This file is the single source of truth for how the React frontend (`src/`) talks to the
Rust/Tauri backend (`src-tauri/`). Both sides implement exactly this. If something here must
change, change this file first.

## Stack

- Tauri v2, Rust 2021 edition, `aws-sdk-s3` 1.x, `tokio`.
- React 19 + TypeScript + Vite. Native dialogs via `@tauri-apps/plugin-dialog`.
- JSON over Tauri `invoke`. **All Rust structs serialize with `#[serde(rename_all = "camelCase")]`.**
  Command *parameters* are also camelCase on the JS side (Tauri converts snake_case Rust args
  to camelCase automatically, e.g. Rust `continuation_token` ⇄ JS `continuationToken`).
- The canonical TypeScript types live in `src/lib/types.ts`. Rust mirrors them exactly.

## Errors

Every command returns `Result<T, AppError>`. `AppError` serializes as:

```ts
interface AppError { code: ErrorCode; message: string }
type ErrorCode =
  | "NotConnected" | "Auth" | "NoSuchBucket" | "NoSuchKey" | "AccessDenied"
  | "Network" | "Io" | "Cancelled" | "InvalidInput" | "Unknown";
```

`message` is human-readable and safe to show in a toast.

## Commands

### Connection

| Command | Args | Returns |
|---|---|---|
| `list_profiles` | – | `ProfileInfo[]` — profiles parsed from `~/.aws/config` and `~/.aws/credentials` (merged, deduped; `region` if known). |
| `connect` | `{ config: ConnectionConfig }` | `ConnectionInfo` — builds the S3 client, verifies with `ListBuckets` (if that is denied, still connect but set `canListBuckets: false`). |
| `disconnect` | – | `void` |
| `connection_status` | – | `ConnectionInfo \| null` |

```ts
interface ProfileInfo { name: string; region: string | null; hasCredentials: boolean }

type ConnectionConfig =
  | { kind: "profile"; profile: string; region?: string | null; endpoint?: string | null }
  | { kind: "static"; accessKeyId: string; secretAccessKey: string; sessionToken?: string | null;
      region: string; endpoint?: string | null; forcePathStyle?: boolean };
// serde: #[serde(tag = "kind", rename_all = "camelCase")]; field names camelCase.
// `endpoint` enables MinIO / R2 / LocalStack. `forcePathStyle` defaults to true when endpoint is set.

interface ConnectionInfo { label: string; region: string; endpoint: string | null; canListBuckets: boolean }
```

### Browsing

| Command | Args | Returns |
|---|---|---|
| `list_buckets` | – | `Bucket[]` |
| `list_objects` | `{ bucket, prefix, continuationToken?, pageSize? }` | `ListPage` — one `ListObjectsV2` page with `Delimiter="/"`. Default `pageSize` 1000. The backend resolves and caches each bucket's region so cross-region buckets just work. |
| `head_object` | `{ bucket, key }` | `ObjectMeta` |

```ts
interface Bucket { name: string; creationDate: string | null }   // ISO-8601 UTC

interface FolderEntry { prefix: string; name: string }            // prefix = full "a/b/c/", name = "c"
interface ObjectEntry {
  key: string; name: string;            // name = last path segment
  size: number;                         // bytes
  lastModified: string | null;          // ISO-8601 UTC
  etag: string | null;
  storageClass: string | null;          // "STANDARD", "GLACIER", ...
}
interface ListPage {
  folders: FolderEntry[];
  objects: ObjectEntry[];               // excludes the "folder marker" object equal to the prefix itself
  nextContinuationToken: string | null;
  isTruncated: boolean;
}
interface ObjectMeta extends ObjectEntry {
  contentType: string | null;
  metadata: Record<string, string>;     // user metadata (x-amz-meta-*)
  versionId: string | null;
}
```

### Folders

| Command | Args | Returns |
|---|---|---|
| `create_folder` | `{ bucket, prefix }` | `void` — `prefix` must end with `/`; backend appends it if missing. Implemented as a zero-byte `PutObject`. |

`delete_folder` was removed in v0.3.0; folders are deleted with `start_job` (see "Object operations (jobs)").

### Transfers (downloads & uploads)

Transfers run in the background on the Rust side and report via events. Commands return
immediately with a transfer id.

| Command | Args | Returns |
|---|---|---|
| `start_download` | `{ bucket, key, destPath }` | `string` (transfer id). **Parallel ranged download:** `HeadObject` for size; if size > 8 MiB split into parts of 8 MiB (grow to 16 MiB when > 1 GiB), fetch up to 8 parts concurrently with `Range` GETs, write each part at its offset into a pre-sized temp file (`destPath + "." + first 8 chars of the transfer id + ".part"`, created exclusively, renamed on completion). Small objects: single GET. |
| `start_upload` | `{ bucket, key, srcPath }` | `string` (transfer id). Files > 8 MiB use multipart upload with up to 8 concurrent part uploads (part size 8 MiB, grown so parts ≤ 10 000); otherwise `PutObject`. Content-Type guessed from extension. On failure/cancel the multipart upload is aborted. |
| `cancel_transfer` | `{ id }` | `void` — cooperative cancel; partial `.part` files are removed. |
| `remove_transfer` | `{ id }` | `void` — forget a finished/failed/cancelled transfer. |
| `list_transfers` | – | `Transfer[]` |

```ts
type TransferKind = "download" | "upload";
type TransferStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
interface Transfer {
  id: string;
  kind: TransferKind;
  bucket: string;
  key: string;
  localPath: string;
  totalBytes: number;          // 0 until known
  transferredBytes: number;
  partsTotal: number;
  partsDone: number;
  bytesPerSec: number;         // rolling average, 0 when not running
  status: TransferStatus;
  error: string | null;
  startedAt: string;           // ISO-8601
  finishedAt: string | null;
}
```

Global concurrency: at most 4 transfers *running* at once (others `queued`); within a transfer
up to 8 concurrent parts.

## Events (Rust → JS)

| Event | Payload | Notes |
|---|---|---|
| `transfer:progress` | `Transfer` | Emitted at most every 100 ms per transfer while running, and always on every status change. |

## Frontend expectations

- `src/lib/api.ts` is the only place `invoke` is called; one typed function per command.
- When not running inside Tauri (`window.__TAURI_INTERNALS__` undefined), `api.ts` routes to
  `src/lib/mock.ts` which simulates a realistic account (a few buckets, thousands of objects,
  fake progress) so the UI can be developed and screenshotted with plain `npm run dev`.

## Backend behavior notes (implemented, frontend must respect)

- `remove_transfer` returns `InvalidInput` while the transfer is `queued`/`running`; cancel first. Unknown id is a no-op.
- `cancel_transfer` returns `InvalidInput` for unknown ids; finished transfers are a no-op.
- `list_objects` may return a page with no folders and no objects but `isTruncated: true` (the only
  key on the page was the hidden folder marker). Keep following `nextContinuationToken`. `pageSize` is capped at 1000.
- `start_download` / `start_upload` reject empty keys or keys ending in `/`. Uploads need the full object key.
- Upload progress advances per completed part (8 MiB steps); files <= 8 MiB jump 0 -> 100%. Downloads update continuously.
- First `transfer:progress` event has status `queued`; the last carries `finishedAt`. Fast transfers may emit only queued, running, final.
- `start_download` creates missing parent directories of `destPath` and overwrites an existing file.
- `create_folder` / `delete_folder` append the trailing `/` if missing and reject only `""` and `"/"`. Server-provided prefixes are never normalized or trimmed: `a//` and `/foo/` are distinct, legal prefixes and must be passed through byte-for-byte. `FolderEntry.name` can be `""` for a prefix like `a//`; the UI shows a placeholder.
- ETags are returned without surrounding quotes. `ErrorCode` values are PascalCase strings exactly as in `types.ts`.
- An `endpoint` without a scheme gets `https://` prepended. With a custom endpoint, path-style addressing
  is on unless `forcePathStyle` is `false`, and checksums are only sent where S3 requires them (MinIO/R2 compatibility).
- Toolchain: `src-tauri/rust-toolchain.toml` pins rustc 1.94.1 (required by aws-sdk-s3 1.152).
- `start_download` also returns `InvalidInput` when `destPath` is relative, contains a `..` component, or is the destination of another queued/running download (compared case-insensitively on Windows).
- Downloads are consistency-checked: every GET sends `If-Match` with the ETag from `HeadObject`; a transfer fails if the object changed, if received bytes differ from the expected size, or if the server ignores `Range`.
- Stalled connections (downloads): a response that sends no bytes is cut off by the SDK's stalled-stream protection (about 5 s) or our 30 s idle timeout; both surface as `Network`. The part is retried and **resumes from the bytes already written** (`Range` from the resume offset, still with `If-Match`). An attempt counts as progress only if it delivered at least 64 KiB (or the rest of the part, if smaller); a part fails after 3 consecutive attempts without progress, or when its total budget of `3 + ceil(partLen / 1 MiB)` attempts (at most 1,000) is used up. A response checksum mismatch fails immediately and is not retried. If every byte of a part has arrived and the connection then errors, the part is complete. `transferredBytes` never decreases. Both the single-request and the ranged path flush the file to disk before the final rename.
- Uploads: requests that carry a body (`PutObject`, `UploadPart`) do not use the SDK's read timeout, because it would include the time spent sending the body and break slow links. Each attempt instead has a timeout scaled to its size: `60 s + bodyLen × share / 32 KiB/s`, capped at 6 h, where `share` is `maxConcurrentParts × maxConcurrentTransfers` (the assumed minimum uplink is shared by everything in flight). A request whose server never answers therefore fails (after the SDK's retries) instead of hanging.
- Uploads stream each part from disk (no whole-part buffering). `CreateMultipartUpload` and `CompleteMultipartUpload` are not interruptible; cancel takes effect between them.
- Frontend: local file names derived from S3 keys are sanitized (path separators, reserved characters and names, `.`/`..`) and de-duplicated case-insensitively before download.
- Security: `tauri.conf.json` sets a restrictive CSP (`default-src 'self'`, `connect-src ipc: http://ipc.localhost`); `devCsp` is null so Vite HMR works in dev.

## Settings (added after v1)

User-tunable transfer settings, owned and persisted by the backend.

```ts
interface TransferSettings {
  partSizeMib: number | null;      // null = Auto (8 MiB; 16 MiB for objects over 1 GiB). Integer 1..=256 otherwise.
  maxConcurrentParts: number;      // parts in flight per transfer. Integer 1..=32. Default 8.
  maxConcurrentTransfers: number;  // transfers running at once (others queue). Integer 1..=10. Default 4.
}
```

Defaults and limits are exported from `src/lib/types.ts` (`DEFAULT_TRANSFER_SETTINGS`,
`TRANSFER_SETTINGS_LIMITS`) and mirrored as constants in Rust.

| Command | Args | Returns |
|---|---|---|
| `get_settings` | – | `TransferSettings` — current values (defaults on first run). Works while disconnected. |
| `update_settings` | `{ settings: TransferSettings }` | `TransferSettings` — the stored values. Out-of-range or non-integer values are rejected with `InvalidInput` and a message naming the field; nothing is changed. Works while disconnected. |

Semantics:

- **Persistence:** stored as JSON (`settings.json`) in the app config directory
  (`app.path().app_config_dir()`), written atomically (temp file + rename). Loaded at startup; a
  missing, unreadable or invalid file falls back to defaults without failing startup. Unknown
  fields are ignored and missing fields take their default, so the file stays forward compatible.
- **When changes apply:** a transfer snapshots `partSizeMib` and `maxConcurrentParts` when it
  *starts running*; transfers already running keep theirs. `maxConcurrentTransfers` applies
  immediately to the queue: raising it lets queued transfers start at once; lowering it never
  interrupts running transfers, it only stops new ones from starting until the count drops below the limit.
- **Download splitting:** an object is split when its size is greater than the part size
  (Auto keeps today's behavior exactly: threshold 8 MiB, parts 8 MiB, 16 MiB above 1 GiB).
  Part count is `ceil(size / partSize)`.
- **Upload splitting:** S3 requires every non-final part to be at least 5 MiB and at most 10,000
  parts. Uploads therefore use `max(partSize, 5 MiB)`, grown further if needed to stay within
  10,000 parts; a file is multipart when larger than that effective part size. Auto keeps today's behavior.
- **Memory:** a download holds up to `maxConcurrentParts × min(partSize, 16 MiB)` in RAM per running
  transfer: parts up to 16 MiB are held whole and written once, larger parts are streamed to disk in
  1 MiB batches (v0.3.0; before that memory grew with part size). Uploads stream from disk. The UI
  shows this estimate (`DOWNLOAD_BUFFER_CAP_MIB` in `types.ts`) and warns above 1 GiB total
  (`maxConcurrentTransfers × maxConcurrentParts × min(partSize, 16 MiB)`).
- `Transfer.partsTotal` reflects the part size the transfer actually used.

Implementation notes (settled during implementation):

- **Upload Auto** is 8 MiB at every file size; the 16 MiB step above 1 GiB applies to downloads only.
- **Upload part growth** past the 10,000-part limit is by doubling the effective part size (5 → 10 → 20 MiB …),
  not the smallest size that fits.
- `update_settings` requires all three fields. `partSizeMib` must be present as `null` or an integer. Error
  messages start with the field name, e.g. `maxConcurrentParts must be an integer from 1 to 32`.
- A settings file that fails to parse falls back to defaults wholesale; one that parses but has out-of-range
  values keeps its valid fields and resets only the bad ones.
- Queued transfers start in FIFO order. A transfer's run slot is released after its final progress event, so the
  number of transfers reported `running` never exceeds `maxConcurrentTransfers` (except right after lowering it).
- A disk failure while saving returns `Io` and leaves the active settings unchanged.

## v0.3.0 additions

Everything in this section is new in v0.3.0. Where it changes an earlier section, this section wins.

### App settings (extends "Settings")

The settings object stays flat and keeps its three transfer fields. Two fields are added and the
TypeScript type is renamed `AppSettings` (`TransferSettings` remains as an alias).

```ts
type ThemeMode = "system" | "light" | "dark";
interface AppSettings {
  partSizeMib: number | null;
  maxConcurrentParts: number;
  maxConcurrentTransfers: number;
  theme: ThemeMode;                 // default "system"
  checkUpdatesOnStartup: boolean;   // default false
}
```

- `get_settings` / `update_settings` keep their names and semantics. `update_settings` requires all
  five fields and rejects an unknown `theme` or a non-boolean `checkUpdatesOnStartup` with `InvalidInput`.
- A `settings.json` written by v0.2.0 (three fields) loads with the two new fields at their defaults.
- **Theme:** the frontend applies `theme` by setting `data-theme="light" | "dark"` on `<html>`, or
  removing the attribute for `"system"` (then `prefers-color-scheme` decides). It applies instantly
  on change in the Settings dialog (live preview) and reverts if the dialog is cancelled. To avoid a
  flash at startup the frontend mirrors the last saved theme in `localStorage` and applies it before
  first render; the backend value is the source of truth.

### Desktop notifications (added after v0.3.0)

`AppSettings` gains one field:

```ts
notifyOnFinish: boolean;   // default true
```

- `update_settings` requires every field of `AppSettings` (see the current list in `src/lib/types.ts`) and
  rejects a non-boolean `notifyOnFinish` with `InvalidInput`. A `settings.json` without the field loads with it at its default.
- With `notifyOnFinish` true the frontend shows an OS notification when a background job finishes
  and when the last active transfer finishes, but only while the app window is not focused. In-app
  toasts are unchanged.
- Notifications go through the Tauri notification plugin (`notification:default` capability).
  `src/lib/api.ts` asks for permission on first use and does nothing if it is denied. There is no
  new command or event.

### Text size and weight (added after v0.3.0)

`AppSettings` gains two fields, both set with sliders in Settings under Appearance:

```ts
textSize: number;     // percent, integer 80 to 150, default 100
textWeight: number;   // font weight of ordinary text, integer 300 to 600, default 400
```

- `update_settings` requires every field of `AppSettings` and rejects a non-integer or out-of-range value with
  `InvalidInput` naming the field. A `settings.json` without the fields, or with a bad value in
  one of them, loads that field at its default.
- **Size** scales the whole interface, not only the letters: the frontend sets the webview's zoom to
  `textSize / 100` (capability `core:webview:allow-set-webview-zoom`), so layout, icons and
  pointer coordinates stay consistent.
- **Weight** is applied as the font weight of ordinary text. Headings and emphasised text keep
  their own, heavier weights.
- Like the theme, both preview live in the Settings dialog and revert if it is cancelled.

### Accent colour (added after v0.3.0)

`AppSettings` gains one field, chosen in Settings under Appearance:

```ts
type AccentColor = "yellow" | "green" | "blue" | "red";
accent: AccentColor;   // default "yellow"
```

- `update_settings` requires every field of `AppSettings` and rejects an unknown `accent` with `InvalidInput`.
  A `settings.json` without the field, or with an unknown value, loads it as `"yellow"`.
- The frontend applies it by setting `data-accent` on `<html>` (always set once settings are loaded; the
  pre-paint script in `public/theme-init.js` sets it only for green, blue and red, since yellow is the CSS default). Buttons,
  selection, focus rings, the start screen's pulses and the logo inside the app follow it; the app
  icon in the taskbar does not.
- It previews live in the Settings dialog like the theme, and is mirrored in `localStorage` so the
  right colour is there before the first render.

### Newest files (added after v0.3.0)

S3 lists keys in name order only, so "what was added last?" needs a scan.

| Command | Args | Returns |
|---|---|---|
| `list_recent` | `{ bucket, prefix }` | `RecentListing` — the most recently modified objects under `prefix` at any depth (no delimiter), newest first. |

```ts
interface RecentListing {
  objects: ObjectEntry[];   // at most 200, newest first
  scanned: number;          // objects looked at
  truncated: boolean;       // true when the scan stopped at the limit before the end of the listing
}
```

- The scan stops after 20,000 objects. `truncated: true` then means newer objects may exist beyond
  what was scanned; the frontend must say so and never present a truncated result as complete.
- Folder markers (keys ending in `/`) are skipped and not counted. Objects without a modification
  time sort last. Paging follows the same rules as every other listing: a repeated continuation
  token is an error, never a silent stop.
- Read-only: it uses `ListObjectsV2`, the permission browsing already needs.
- The frontend shows the newest files of the open bucket in the sidebar, below the bucket list,
  and filters them there by age, file type and a search over the key.

### Saved connections

Named connections the user can reuse. Metadata is stored in `connections.json` in the app config
directory (atomic writes, lenient load, same rules as `settings.json`). **Secrets are stored only in
the operating system keychain** (Windows Credential Manager, macOS Keychain, Linux Secret Service),
service name `dev.s3explorer.app`, account = the connection id. Secrets are never written to
`connections.json`, never logged, and never returned to the frontend.

```ts
interface SavedConnection {
  id: string;                    // uuid, assigned by the backend
  name: string;                  // unique, case-insensitive, 1..=64 chars after trimming
  kind: "profile" | "static";
  profile: string | null;        // kind = "profile"
  accessKeyId: string | null;    // kind = "static"
  region: string | null;
  endpoint: string | null;
  forcePathStyle: boolean;
  hasSecret: boolean;            // kind = "static": a secret is present in the keychain
  lastUsedAt: string | null;     // ISO-8601, updated by connect_saved
}

interface SaveConnectionInput {
  id?: string | null;            // present = update that connection, absent = create
  name: string;
  config: ConnectionConfig;      // same shape as `connect`
}
```

| Command | Args | Returns |
|---|---|---|
| `list_saved_connections` | – | `SavedConnection[]` sorted by `lastUsedAt` desc (never-used last), then name. Works while disconnected. |
| `save_connection` | `{ input: SaveConnectionInput }` | `SavedConnection`. For `static`, `secretAccessKey` is written to the keychain. On update, an empty `secretAccessKey` means "keep the stored secret". A `sessionToken` is never saved (temporary credentials are not savable): reject with `InvalidInput` if one is supplied. Duplicate name → `InvalidInput`. |
| `delete_saved_connection` | `{ id }` | `void`. Removes metadata and the keychain entry. Unknown id is a no-op. |
| `connect_saved` | `{ id }` | `ConnectionInfo`. Loads the secret from the keychain and connects exactly like `connect`. `label` is the saved name. Updates `lastUsedAt`. |

- New `ErrorCode` value: `"Keychain"` — the OS keychain is unavailable or refused access. `save_connection`
  fails with it and stores nothing (no half-saved connection). `connect_saved` fails with it, or with
  `InvalidInput` and a clear message if the secret is missing (`hasSecret: false`), so the UI can ask
  the user to re-enter the secret.
- Deleting a saved connection does not disconnect an active session that was started from it.

### Object operations (jobs)

Delete, copy, move and rename for objects and folders. Rename is a move within the same folder. S3
has no rename or move: both are implemented as copy, then delete of the source. These can be long
running, so they run in the background as **jobs**, reported by events like transfers.

```ts
type JobKind = "delete" | "copy" | "move";
type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
type ConflictPolicy = "overwrite" | "skip";

interface JobItem {
  from: string;            // source key, or source prefix ending in "/" when isPrefix
  to: string | null;       // destination key / prefix (ending in "/" when isPrefix); null for delete
  isPrefix: boolean;
}

interface JobRequest {
  kind: JobKind;
  srcBucket: string;
  destBucket: string | null;       // null for delete; may equal srcBucket
  items: JobItem[];                // 1..=10,000 items
  onConflict: ConflictPolicy;      // ignored for delete
}

interface JobPreview {
  objects: number;                 // objects that would be affected (prefixes expanded)
  bytes: number;
  conflicts: number;               // destination keys that already exist (copy/move)
  truncated: boolean;              // true when counting stopped at 100,000 objects; numbers are lower bounds
}

interface JobError { key: string; message: string }

interface Job {
  id: string;
  kind: JobKind;
  srcBucket: string;
  destBucket: string | null;
  label: string;                   // short human description, e.g. "Move 3 items to backups/2026/"
  phase: "listing" | "working" | "done";
  totalItems: number;              // objects discovered so far; final once phase != "listing"
  doneItems: number;               // objects fully processed successfully
  skippedItems: number;            // skipped because of onConflict = "skip"
  failedItems: number;
  totalBytes: number;
  doneBytes: number;
  status: JobStatus;
  error: string | null;            // job-level failure (e.g. listing failed)
  errors: JobError[];              // first 50 per-object errors
  startedAt: string;
  finishedAt: string | null;
}
```

| Command | Args | Returns |
|---|---|---|
| `preview_job` | `{ request: JobRequest }` | `JobPreview` — validates the request and counts what it would touch, without changing anything. |
| `start_job` | `{ request: JobRequest }` | `string` (job id). Validates, then runs in the background. |
| `cancel_job` | `{ id }` | `void` — cooperative. Work already done stays done. |
| `remove_job` | `{ id }` | `void` — forget a finished job. `InvalidInput` while queued/running. |
| `list_jobs` | – | `Job[]` |

Event `job:progress`, payload `Job`: at most every 100 ms per job while running, and always on
status or phase change. First event has status `queued`; the last carries `finishedAt`.

**Semantics (data safety — these are requirements, not suggestions):**

- **Keys and prefixes are opaque** and passed through byte for byte (see `.claude/rules/data-safety.md`).
  Prefix items must end with `/`; a prefix of `""` or `"/"` is rejected.
- **Validation (`InvalidInput`, nothing is changed):** empty items; a copy/move whose destination
  equals its source; a prefix copied or moved into itself or a descendant of itself (same bucket,
  `to` starts with `from`); two items that would write the same destination key; `to` missing for
  copy/move or present for delete; an object destination ending in `/`.
- **Prefix expansion** lists every key under `from` (no delimiter, paginated) and maps
  `from + rest` → `to + rest`. The folder marker object is included. An item whose prefix matches
  nothing is reported as a per-item error, not silently ignored.
- **Copy:** `CopyObject` for objects up to 5 GiB; multipart copy (`UploadPartCopy`, parts of 256 MiB, doubled
  as needed up to S3's 5 GiB part maximum to stay ≤ 10,000 parts) above that, aborted on failure or cancel. The source's
  storage class, content type and user metadata are preserved. Objects that cannot be read (e.g.
  archived in Glacier and not restored) fail individually with a clear message.
- **Conflicts:** with `skip`, an existing destination key is left untouched, counted in
  `skippedItems`, and **its source is not deleted** even in a move. With `overwrite` it is replaced.
- **Move = copy, then delete the source of each object whose copy succeeded.** A source is deleted
  only after its own copy is confirmed. If a copy fails, that source is never deleted. Sources are
  deleted in batches as the job progresses, not all at the end, so a cancelled move leaves each
  object in exactly one place.
- **Delete:** `DeleteObjects` in batches of 1,000; per-key errors from the response are collected.
  On a versioned bucket this adds delete markers (older versions remain).
- **Final status:** `completed` when every object succeeded or was skipped; `failed` when the job
  could not run or at least one object failed (then `failedItems > 0`, details in `errors`);
  `cancelled` when cancelled. `doneItems + skippedItems + failedItems == totalItems` at the end
  unless cancelled.
- **Concurrency:** up to 16 object operations in flight per job; at most 2 jobs run at once, others
  queue (FIFO). Jobs do not count against `maxConcurrentTransfers`.
- Jobs work across buckets on the current connection, including buckets in different regions.

`delete_folder` is **removed**; the UI uses `start_job` with `kind: "delete"`.

**Details settled during implementation:**

- **Two phases, strictly in order.** The whole listing phase (prefix expansion and, for copy/move, conflict
  detection) finishes before the first object is changed. If expansion shows that two sources map to the same
  destination key, the job fails with a job-level `error` and nothing is changed.
- **Request-time validation** additionally rejects identical `to` values and a destination nested inside another
  item's destination prefix.
- **Duplicate or overlapping sources** (the same key reached through two items) are de-duplicated; each object is
  processed once.
- **A prefix that matches nothing** counts as one item in `totalItems` and `failedItems`, with an error saying
  nothing was found under it.
- **A missing object key:** for delete it counts as done (deleting is idempotent in S3); for copy/move it is a
  per-object failure.
- `phase` is `"done"` in every final status, including `failed` and `cancelled`.
- `label` is written by the backend for display as-is: `Delete N items`, `Copy N items to <dest prefix or bucket>`,
  `Move N items to <dest>`, and for a single-item move within one folder `Rename <old name> to <new name>`.
- `cancel_job` returns `InvalidInput` for an unknown id and is a no-op for a finished job (same as transfers).
- `install_update` is refused while any job is queued or running, as for transfers.
- The frontend sends `onConflict: "skip"` unless the user explicitly chose Overwrite, so an object that appears
  at the destination after the preview is never overwritten silently.

**Safety rules added by the backend implementation (all enforced, all tested):**

- **A job can never write into its own sources.** In the same bucket, any destination range that overlaps any
  source range of the same or another item is rejected with `InvalidInput` (e.g. `a/b/` → `a/`, the rotation
  `x/` → `y/` with `y/` → `z/`, swaps, or pasting into a folder that is itself being moved). Without this an
  overwriting move could replace a source and then delete its own destination. Two further guards back it up:
  after expansion the job fails before any change if a destination key equals a source key, and at run time a
  move refuses to delete any key that the same job writes.
- **A source is deleted only after its copy is proven.** The copy response must carry an ETag and a `HeadObject`
  of the destination must show the expected size. The delete of the source is conditional on the ETag that was
  copied, so a source that was overwritten in the meantime is kept (reported as a per-object failure saying the
  copy exists and the original remains).
- **Copies are conditional on the source seen during listing** (`x-amz-copy-source-if-match`): an object that
  changed after listing fails instead of copying something unexpected.
- **`skip` is enforced on the server where possible** with `If-None-Match: *`, so a destination created after the
  listing is still not overwritten. A server that answers NotImplemented falls back to the listing-phase check.
  A server that rejects ETag-conditional deletes gets one retry without the condition for the affected keys.
- **Overlapping sources in copy/move** (an object reachable through two items): the first item in request order
  wins and the object is copied once.
- **Listing-phase errors fail the whole job before any change** (for example a `HeadObject` error other than
  not-found, or a truncated listing without a continuation token).
- **Cancel:** copies already in flight finish and their sources are deleted, so no object is left in both places
  by a cancelled move; a multipart copy stops between parts and is aborted.
- Concurrency inside a job: 16 object copies, 4 parts per multipart copy, 4 `DeleteObjects` batches. Source
  deletes are flushed every 500 ms or 1,000 keys, so `doneItems` of a move can trail the copies briefly.
- `destBucket` on a delete request is rejected. `remove_job` with an unknown id is a no-op.
- Labels: a single item is named (`Delete report.pdf`, `Rename old.txt to new.txt`, `Move a to bucket/q/`);
  several items read `Copy 1,234 items to bucket/prefix/`.
- Not preserved by a copy: ACLs, the checksum algorithm, SSE-C. Tags are carried over (best effort for multipart
  copies). Content headers, user metadata and storage class are carried over explicitly.
- During listing `totalItems` is a running count and becomes exact when the phase changes to `working`.

**Added after the v0.3.0 code review (all enforced, each with a regression test):**

- **A delete is counted only when the server confirms it.** A key counts as deleted only if the `DeleteObjects`
  response lists it under `Deleted`. A key in neither list gets one `HeadObject` (not found → deleted); otherwise
  it is a per-object failure ("The server did not confirm the delete."). An error entry that names no key fails
  its whole batch. The same rule governs the source deletes of a move: an unconfirmed source is reported as
  "the copy exists and the original remains", never as moved.
- **A move needs an ETag for every source.** If the listing has none, the listing phase fetches it with
  `HeadObject`; if there is still none, that object is not moved. Copies do not need one.
- **Listings follow the continuation token**, whatever `IsTruncated` says. A truncated page without a token, or a
  token the server already returned, is an error; a partial listing is never acted on. For `list_objects`,
  `isTruncated` is true exactly when `nextContinuationToken` is non-null.
- **Server-side copies** have a timeout scaled to the object size (`5 min + bytes / 2 MiB/s`, between 15 min and 6 h).
- In development and test builds a panic inside a job or transfer ends it as `failed` and releases its slot; an
  unfinished multipart upload or copy is aborted when its task is dropped. Release builds abort the process on
  panic, as before.

### Updates

The app can check GitHub Releases for a newer version and install it. Installation uses the Tauri
updater plugin, which only installs packages signed with this project's updater key.

```ts
interface UpdateInfo {
  currentVersion: string;          // e.g. "0.3.0"
  available: boolean;
  latestVersion: string | null;    // null when the check could not determine it
  notes: string | null;            // patch notes (markdown) of the latest release
  publishedAt: string | null;      // ISO-8601
  canInstall: boolean;             // a signed update package exists for this platform
  downloadUrl: string;             // release page to open when canInstall is false
}

type UpdatePhase = "downloading" | "installing" | "restarting";
interface UpdateProgress { phase: UpdatePhase; downloadedBytes: number; totalBytes: number | null }
```

| Command | Args | Returns |
|---|---|---|
| `check_for_update` | – | `UpdateInfo`. Works while disconnected. Network failure → `Network` error. |
| `install_update` | – | `void`. Downloads and installs the update found by the last check, emitting `update:progress`, then restarts the app. `InvalidInput` if no installable update is known. Refused with `InvalidInput` while any transfer or job is queued or running (the UI must say so). |

- Source of truth: `https://github.com/yonatand/S3Explorer/releases/latest`. Pre-releases are ignored.
- `check_for_update` first asks the updater plugin (endpoint
  `https://github.com/yonatand/S3Explorer/releases/latest/download/latest.json`). If that manifest is
  missing or has no entry for this platform, it falls back to the GitHub API
  (`/repos/yonatand/S3Explorer/releases/latest`), compares versions, and returns `canInstall: false`
  with `downloadUrl` set, so the user can still be told and download manually.
- Signature verification is mandatory for installation and is never bypassed. The updater public key
  is embedded in `tauri.conf.json`; the private key is never in the repository.
- With `checkUpdatesOnStartup` true the frontend calls `check_for_update` once, a few seconds after
  startup, silently; it only shows a non-blocking notice when an update is available. It never
  installs without the user clicking.
- Event `update:progress`, payload `UpdateProgress`.

### v0.3.0 backend notes (settings, saved connections, updates)

- **Settings file loading** is per field: a field with a wrong type or out-of-range value resets to its own
  default and the others are kept. Text that is not JSON at all resets everything. (Supersedes the earlier
  "fails to parse falls back wholesale" wording.)
- **`hasSecret` when the keychain cannot be read** while listing is reported as `false` rather than failing the
  whole list; connecting then returns the real `Keychain` error.
- **No half-saved connections:** if the keychain write fails nothing is stored; if the metadata write fails the
  keychain change is rolled back (new secret removed, or the previous secret restored).
- **`forcePathStyle`** is stored as the value `connect` actually used.
- **Update progress on Windows** ends with `installing`: the installer takes over, closes the app and restarts
  it. `restarting` is emitted on macOS and Linux only.
- **`check_for_update` when the repository has no releases** returns `available: false`, not an error.
- **A stalled update download** (60 s without data) is abandoned with a `Network` error. Signature verification is unaffected.
- **Opening links:** the app may open only `https://github.com/yonatand/S3Explorer/*` in the browser
  (capability scope). `downloadUrl` is always inside that prefix.
- **Messages the UI relies on:** a missing secret → `InvalidInput` containing the word "secret"; installs
  refused while transfers or file operations run → `InvalidInput` saying so; a package that fails signature
  verification is never installed and reports that plainly.
- **Linux** needs a running Secret Service (gnome-keyring, KWallet) to save or use connections with a secret;
  without one those actions return a `Keychain` error. AWS-profile connections need no keychain.

### UI text: units

Sizes and speeds are computed in binary units and must be labelled that way: `KiB`, `MiB`, `GiB`,
`MiB/s`.

### Window title (added after v0.3.0)

The frontend sets the window title to the connection label while connected and "S3 Explorer" otherwise,
through `getCurrentWindow().setTitle()` (capability `core:window:allow-set-title`). No command.

**`AppSettings` as of the redesign** (every field required by `update_settings`; a missing or invalid field
in `settings.json` loads at its default): `partSizeMib`, `maxConcurrentParts`, `maxConcurrentTransfers`,
`theme`, `checkUpdatesOnStartup`, `notifyOnFinish`, `textSize`, `textWeight`, `accent`. v0.4.0 adds
`confirmCopyMove` below.

## v0.4.0 additions — the buckets update

Everything in this section is new in v0.4.0. Where it changes an earlier section, this section wins.
New `ErrorCode` values: `"Conflict"` (the server-side state changed since it was read) and
`"NotSupported"` (the server does not implement this S3 feature; MinIO, R2, SeaweedFS and others
implement lifecycle and tagging only partly).

### Shared buckets (buckets added by name)

A bucket shared from another AWS account (or another account on an S3-compatible service with the
same sharing model) does not appear in `ListBuckets`. The user adds it by name and the app remembers
it for that connection.

```ts
interface AddedBucket {
  name: string;
  region: string | null;        // discovered with HeadBucket; null when the endpoint is custom
  addedAt: string;              // ISO-8601
}
```

| Command | Args | Returns |
|---|---|---|
| `list_added_buckets` | – | `AddedBucket[]` for the current connection, sorted by name. |
| `add_bucket` | `{ input }` | `AddedBucket`. `input` may be a bare bucket name, an `s3://name/...` URI (the path is ignored), or a bucket ARN `arn:aws:s3:::name`; access point ARNs and aliases are accepted as-is as the bucket value. Verifies with `HeadBucket` (resolving and caching the region, as browsing already does) and then one `ListObjectsV2` with `max-keys=1`. Not found → `NoSuchBucket`; no permission → `AccessDenied` with a message saying the bucket exists but these credentials cannot list it; both leave nothing stored. Already added → returns the existing entry. |
| `remove_added_bucket` | `{ name }` | `void`. Forgets the bucket locally. **Never touches the bucket or its contents.** Unknown name is a no-op. |

- **Storage:** `added-buckets.json` in the app config directory (atomic writes, lenient load), keyed by
  connection identity: a saved connection's id; otherwise `profile:<name>@<endpoint or aws>` or
  `static:<accessKeyId>@<endpoint or aws>`. A connection with no entry has an empty list.
- Added buckets behave like listed buckets everywhere (browse, transfers, jobs, tags, lifecycle). The
  UI shows them in their own sidebar group ("Shared with me") with a remove action, and `list_buckets`
  results that happen to include an added bucket show it once, in the normal list.
- Bucket-level features (lifecycle, bucket tags) on a shared bucket are usually denied: the UI shows
  "You don't have permission for this on this bucket" rather than a generic error, and never retries
  in a loop.

### Tags (buckets and objects)

```ts
interface Tag { key: string; value: string }
```

Limits, enforced by the backend (`InvalidInput` naming the problem) and mirrored live in the UI:
a bucket holds at most 50 tags, an object at most 10; `key` 1..=128 and `value` 0..=256 Unicode
characters; keys unique and case-sensitive; keys may not start with `aws:` (reserved). Allowed
characters are letters, numbers, spaces and `+ - = . _ : / @`.

| Command | Args | Returns |
|---|---|---|
| `get_bucket_tags` | `{ bucket }` | `Tag[]` — `[]` when the bucket has no tag set. |
| `put_bucket_tags` | `{ bucket, tags, expected }` | `Tag[]` (the stored set). **Replaces the whole set.** `expected` is the set the UI loaded; if the bucket's current tags differ from it the command fails with `Conflict` and changes nothing (the message includes nothing sensitive; the UI reloads and shows the current set). An empty `tags` deletes the tag set (`DeleteBucketTagging`). |
| `get_object_tags` | `{ bucket, key }` | `Tag[]` |
| `put_object_tags` | `{ bucket, key, tags, expected }` | `Tag[]` — same replace / `expected` / empty-deletes semantics for one object. |

**Bulk tag editing** is a job (see "Object operations"): `JobKind` gains `"tag"`, and `JobRequest`
gains an optional `tags` field that is required for that kind and rejected for the others:

```ts
type JobKind = "delete" | "copy" | "move" | "tag";
interface TagOperation {
  mode: "merge" | "replace";
  set: Tag[];        // keys to add or update (replace: the complete new set)
  remove: string[];  // merge only: keys to remove
}
// JobRequest: { kind: "tag", srcBucket, destBucket: null, items, onConflict: "skip" (ignored), tags: TagOperation }
```

- `merge` reads each object's tags, applies `set` and `remove`, and writes the result; an object whose
  result would exceed 10 tags is a per-object failure ("would have N tags; the limit is 10") and is left
  unchanged. `replace` writes `set` as the complete tag set of every object (an empty `set` removes all tags).
- Per object: `GetObjectTagging` (merge only) then `PutObjectTagging` (or `DeleteObjectTagging` when
  the result is empty). Counters, phases, cancel and errors as for other jobs; `doneBytes`/`totalBytes`
  stay 0. Up to 16 objects in flight.
- `preview_job` for `kind: "tag"` counts objects and bytes as usual; `conflicts` is 0.
- Objects with tags show them in the details panel (read on selection with `get_object_tags`).

### Lifecycle configuration

The full S3 lifecycle rule model, edited as a whole. S3 stores lifecycle as one document:
`PutBucketLifecycleConfiguration` **replaces every rule**. The app therefore always loads the full
configuration, edits it, and writes the full result back, and it refuses to write over a configuration
that changed since it was loaded.

```ts
type RuleStatus = "Enabled" | "Disabled";
type TransitionStorageClass =
  | "STANDARD_IA" | "ONEZONE_IA" | "INTELLIGENT_TIERING" | "GLACIER_IR" | "GLACIER" | "DEEP_ARCHIVE";

interface LifecycleFilter {
  prefix: string | null;                 // null = no prefix condition
  tags: Tag[];                           // all must match
  objectSizeGreaterThan: number | null;  // bytes
  objectSizeLessThan: number | null;     // bytes
}
// An empty filter (null, [], null, null) applies the rule to the whole bucket.
// Serialization to S3: one condition → Prefix / Tag / ObjectSizeGreaterThan / ObjectSizeLessThan directly;
// several → And { Prefix, Tags, ObjectSizeGreaterThan, ObjectSizeLessThan }; none → Filter {} .
// A legacy rule with a top-level Prefix (no Filter) is read as filter.prefix and written back as a Filter.

interface Transition { days: number | null; date: string | null; storageClass: TransitionStorageClass }
interface Expiration { days: number | null; date: string | null; expiredObjectDeleteMarker: boolean }
interface NoncurrentTransition { noncurrentDays: number; newerNoncurrentVersions: number | null; storageClass: TransitionStorageClass }
interface NoncurrentExpiration { noncurrentDays: number; newerNoncurrentVersions: number | null }

interface LifecycleRule {
  id: string;                                   // 1..=255 chars, unique within the configuration
  status: RuleStatus;
  filter: LifecycleFilter;
  transitions: Transition[];
  expiration: Expiration | null;
  noncurrentVersionTransitions: NoncurrentTransition[];
  noncurrentVersionExpiration: NoncurrentExpiration | null;
  abortIncompleteMultipartUpload: { daysAfterInitiation: number } | null;
}

interface LifecycleConfiguration { rules: LifecycleRule[] }   // at most 1,000 rules

interface LifecycleIssue { ruleIndex: number | null; field: string | null; message: string }
```

| Command | Args | Returns |
|---|---|---|
| `get_lifecycle` | `{ bucket }` | `LifecycleConfiguration \| null` — `null` when the bucket has no configuration. A server that does not implement lifecycle → `NotSupported`. |
| `validate_lifecycle` | `{ config }` | `LifecycleIssue[]` — pure, local, no network; `[]` means valid. The UI calls it live while editing (debounced) and the backend runs the same function before writing. |
| `put_lifecycle` | `{ bucket, config, expected }` | `LifecycleConfiguration \| null` (what is now stored). Validates (any issue → `InvalidInput` with the issues in the message, nothing written). Re-reads the current configuration and compares it with `expected` (the one the UI loaded, or `null`); a difference → `Conflict`, nothing written. `config.rules` empty → `DeleteBucketLifecycle`. |
| `get_bucket_versioning` | `{ bucket }` | `"Enabled" \| "Suspended" \| "Off"` — shown in the editor because noncurrent-version actions only matter with versioning. |

**Validation rules (`validate_lifecycle`, every one unit-tested):** 1..=1,000 rules; ids 1..=255,
unique; every rule has at least one action; per action exactly one of `days` / `date` (integer days;
`date` an ISO-8601 date at midnight UTC); **a transition may use `days` = 0** (AWS allows moving objects
to INTELLIGENT_TIERING, GLACIER_IR, GLACIER or DEEP_ARCHIVE on day 0) while expiration `days` ≥ 1; a rule
uses days for all of its transitions and its expiration, or dates for all of them, never a mix;
transitions within a rule follow S3's waterfall strictly (STANDARD_IA → INTELLIGENT_TIERING → ONEZONE_IA →
GLACIER_IR → GLACIER → DEEP_ARCHIVE; each later transition goes to a strictly later class, so STANDARD_IA →
ONEZONE_IA is allowed and nothing moves back); **only STANDARD_IA and ONEZONE_IA**
need `days` ≥ 30 (INTELLIGENT_TIERING and the archive classes have no minimum); a later transition to
GLACIER_IR / GLACIER / DEEP_ARCHIVE after a STANDARD_IA or ONEZONE_IA transition must be at least 30 days
after it (no such gap is required after INTELLIGENT_TIERING); expiration must come after every transition (days greater, or date later); `expiredObjectDeleteMarker`
cannot be combined with `days`/`date` in the same expiration, and (like `abortIncompleteMultipartUpload`)
cannot be used in a rule whose filter has tags or object-size conditions; `objectSizeGreaterThan` <
`objectSizeLessThan` when both set; filter tags follow the tag limits; a rule with no filter conditions is
allowed (whole bucket) and the editor must say so in words. Noncurrent `noncurrentDays` ≥ 1 and
`newerNoncurrentVersions` 1..=100. Days and sizes are integers.

**UI requirements (the hard part):** rules listed with a one-line plain-language summary each
("Objects under logs/ with tag env=prod move to Glacier after 90 days and are deleted after 365 days");
a rule editor form covering every field above with inline validation from `validate_lifecycle`; enable/
disable, duplicate, delete and reorder rules; the bucket's versioning state shown, with noncurrent actions
explained; a read-only "as JSON" view of the whole configuration; and before saving, a confirmation that
lists what changed (rules added, removed, changed) and, in red, every rule that **deletes data** (any
expiration or noncurrent expiration), because a lifecycle rule can delete a whole bucket's contents
silently a day later. Saving when nothing changed is a no-op. A `Conflict` reloads the configuration and
tells the user someone else changed it.

**Lifecycle details settled during implementation:**

- `LifecycleIssue.field` values: `id`, `status`, `filter.prefix`, `filter.tags`, `filter.tags[i].key`,
  `filter.objectSizeGreaterThan`, `filter.objectSizeLessThan`, `transitions[i].days`, `transitions[i].date`,
  `transitions[i].storageClass`, `expiration.days`, `expiration.date`, `expiration.expiredObjectDeleteMarker`,
  `noncurrentVersionTransitions[i].noncurrentDays`, `noncurrentVersionTransitions[i].newerNoncurrentVersions`,
  `noncurrentVersionTransitions[i].storageClass`, `noncurrentVersionExpiration.noncurrentDays`,
  `noncurrentVersionExpiration.newerNoncurrentVersions`, `abortIncompleteMultipartUpload.daysAfterInitiation`.
  A rule-level issue ("this rule does nothing") has `ruleIndex` set and `field` null; a duplicate id is reported
  on the later rule with `field` null; the rule-count issue has both null. Tag value problems are reported on
  `filter.tags[i].key`.
- Extra validation beyond the list above: a filter prefix is at most 1,024 bytes; a filter has at most 10 tags
  (an object never has more); `objectSizeGreaterThan` ≥ 0 and `objectSizeLessThan` ≥ 1; noncurrent transitions
  have distinct classes and get colder over time, and a noncurrent expiration comes after all of them.
- `prefix: ""` can come back from the server (legacy rules) and means the whole bucket; it is kept as-is and
  compares equal to `null`. `expiredObjectDeleteMarker: false` is written as absent.
- `put_lifecycle` passes the server's `TransitionDefaultMinimumObjectSize` back unchanged, writes nothing when
  the result equals what is stored, and after writing reads back: if the server stored something different it
  restores the previous configuration and returns `NotSupported` naming what was dropped (the UI must reload).
  A configuration containing a storage class, status or shape this version does not understand is refused
  (`Unknown`, message says so) and can neither be shown nor written, so nothing is ever dropped.
- Dates are returned as `YYYY-MM-DDT00:00:00Z`; `YYYY-MM-DD` is accepted as input. A date that is today or in
  the past is valid for S3 and means "every matching object, and every new one, is deleted (or moved) at the
  next daily run": `validate_lifecycle` reports it as a warning-style issue (`field` set, message says so) that
  does not block saving, and the UI summary and confirmation use that wording.
- **Eventual consistency.** Bucket configuration propagates with a lag, so a read-back right after a write may
  still show the configuration from before the write. `put_lifecycle` treats a read-back equal to the
  pre-write configuration as lag (polls with backoff for up to ~20 s) and never "restores" in that case. It
  restores the previous configuration only when two consecutive reads show something that is neither the
  requested nor the pre-write configuration. If the write errored but the read-back shows the requested
  configuration, the save is reported as successful.
- **A failed read-back after a successful write is not a failed save.** `put_lifecycle`, `put_bucket_tags` and
  `put_object_tags` then return an error whose message starts with "Saved, but reading back failed"; the UI
  must reload and must not say "nothing was changed".
- **AWS system tags** (keys starting with `aws:`) can exist on buckets created by CloudFormation and others.
  `get_*_tags` returns them; the UI shows them read-only; `put_*_tags` accepts an `aws:` key only when the same
  key and value are present in `expected` (pass-through), never writes a changed one, and never issues
  `DeleteBucketTagging` / `DeleteObjectTagging` while `expected` contains an `aws:` tag (it writes the set with
  only the system tags instead).
- Allowed tag characters follow AWS: any Unicode letter, number or space separator (p{L} p{N} p{Z}) plus
  `+ - = . _ : / @`.
- HTTP 405 on an object-level tagging call means the current version is a delete marker; it is a per-object
  "the object was deleted" failure, not `NotSupported`. `NotSupported` is reserved for the server answering
  NotImplemented or 501.
- The frontend sends `expected` = the configuration it loaded (or the server snapshot re-read after a
  `Conflict`), order-sensitive.

### Confirmations for copy and move (setting)

`AppSettings` gains `confirmCopyMove: boolean` (default `true`); `update_settings` requires it like the
other fields and a `settings.json` without it loads `true`.

- `true`: paste (and drag-and-drop) shows the Copy/Move confirmation as today.
- `false`: when the preview finds **no conflicts**, the copy or move starts immediately after the preview
  and a toast says what started; when the preview finds conflicts, the dialog is shown exactly as today,
  because choosing Skip or Overwrite can never be skipped. Previews and validation still run every time.
- **The delete confirmation is never affected by any setting.**

### Drag and drop to move or copy (frontend only)

Rows (objects and folders, the whole current selection, or the dragged row if it is not selected) can
be dragged and dropped onto: a folder row in the table, a segment of the path bar (move to that parent),
or a bucket in the sidebar (move to that bucket's root, including added buckets). A drop builds the same
`JobRequest` as paste (`to = targetPrefix + name`, folders with a trailing `/`), runs `preview_job`, and
follows the confirmation setting above. **Holding Ctrl (Option on macOS) copies instead of moving**, and the
mode is shown while dragging: a badge following the pointer reads "Move N items" / "Copy N items" with a
distinct icon, the drop effect/cursor changes, and it updates live as the key is pressed or released.
Dropping onto the current folder, onto one of the dragged items, or into a descendant of a dragged folder
is refused with a message (the backend rejects these too). A drag starts only after a small pointer
movement; Esc cancels. This is internal HTML5/pointer dragging and must not break the existing OS file
drop (upload); verify on the real executable, where Tauri's native drag-drop handling can swallow HTML5
drop events on Windows.

### Taskbar / Start menu icon (bug)

Reported after v0.3.0 on an installed copy launched like a user: the window shows the app icon but the
taskbar and Start menu show the default Tauri icon. The redesign has since replaced the icon again
(white bucket on a yellow tile). Fix for v0.4.0 and verify on the installed release artifact, checking
every size inside the exe's icon resource, the installer's shortcut icon, and Windows' icon cache.

### IAM permissions added in this version

`s3:GetBucketTagging`, `s3:PutBucketTagging` (bucket tags; `PutBucketTagging` also covers deletion),
`s3:GetObjectTagging`, `s3:PutObjectTagging`, `s3:DeleteObjectTagging` (object tags),
`s3:GetLifecycleConfiguration`, `s3:PutLifecycleConfiguration` (lifecycle; `Put` also covers deletion),
`s3:GetBucketVersioning`. Adding a shared bucket needs only `s3:ListBucket` on it.

## v0.5.0 additions — folders, versions, archives

Everything in this section is new in v0.5.0. Where it changes an earlier section, this section wins.
Decisions taken by default (the user approved the plan without changing them): a folder download
skips local files that already exist unless Overwrite is chosen in the confirmation; permanent
deletion of a single object version is included, behind its own confirmation.

### Folder transfers (batches)

A folder upload or download is a **batch**: many transfers started together and shown as one entry.
Each file inside is an ordinary transfer (same parts, resume, limits, cancel). The batch adds
planning, a preview, one progress bar and one place for failures.

```ts
type BatchKind = "upload" | "download";
type BatchStatus = "planning" | "queued" | "running" | "completed" | "failed" | "cancelled";

interface BatchPlanRequest {
  kind: BatchKind;
  bucket: string;
  prefix: string;              // upload: destination prefix ("" or ending in "/"); download: source prefix (ending in "/")
  localPath: string;           // upload: the folder to walk; download: the directory to write into
  onConflict: ConflictPolicy;  // "skip" | "overwrite": applies to files that already exist at the destination
}

interface BatchPreview {
  files: number;               // files that would be transferred
  bytes: number;
  conflicts: number;           // destination files/objects that already exist
  skippedUnreadable: number;   // upload only: local files that could not be read (listed in `notes`)
  truncated: boolean;          // true when planning stopped at the limit; counts are lower bounds
  notes: string[];             // human-readable, first 50 (unreadable paths, symlinks skipped, long paths)
}

interface Batch {
  id: string;
  kind: BatchKind;
  bucket: string;
  prefix: string;
  localPath: string;
  label: string;               // "Upload photos/ (1,204 files)" / "Download logs/ to D:\dl"
  totalFiles: number;
  doneFiles: number;
  skippedFiles: number;
  failedFiles: number;
  totalBytes: number;
  doneBytes: number;
  bytesPerSec: number;
  status: BatchStatus;
  error: string | null;
  errors: { path: string; message: string }[];   // first 50 per-file failures (path = key for download, local path for upload)
  startedAt: string;
  finishedAt: string | null;
}
```

| Command | Args | Returns |
|---|---|---|
| `preview_batch` | `{ request: BatchPlanRequest }` | `BatchPreview` — walks the local folder (upload) or lists the prefix (download), checks what exists at the destination, changes nothing. |
| `start_batch` | `{ request }` | `string` (batch id). Plans again (the preview may be stale), then feeds transfers to the normal transfer queue. |
| `cancel_batch` | `{ id }` | `void` — cancels the batch's queued and running transfers; finished files stay. |
| `remove_batch` | `{ id }` | `void` — `InvalidInput` while planning/queued/running. |
| `list_batches` | – | `Batch[]` |

Event `batch:progress`, payload `Batch`, throttled to 100 ms, always on status change; first event
`planning`, last carries `finishedAt`. The per-file transfers still emit `transfer:progress` and
carry a new optional field `batchId: string | null` so the UI can fold them under their batch.

Semantics:

- **Limits:** at most 50,000 files and 1 TiB per batch (`InvalidInput` beyond that, with the count);
  planning stops at the limit with `truncated: true` in the preview so the UI can say so.
- **Upload mapping:** local `folder/sub/file.txt` → key `prefix + "sub/file.txt"` with `/` separators;
  empty sub-folders are not created as markers; symbolic links and reparse points are skipped and
  noted; hidden/system files are included; the folder's own name is NOT prepended (the UI offers
  `prefix + folderName + "/"` as the default destination, so the user sees the final prefix).
- **Download mapping:** key `prefix + "a/b/c.txt"` → `localPath/a/b/c.txt`, every segment sanitized
  with the same rule as single downloads (`\ / : * ? " < > |`, control chars, `.`/`..`, trailing
  dots and spaces, reserved names); two keys that sanitize to the same local path are a per-file
  failure for the second one, never a silent overwrite. The folder marker object is skipped.
  A key segment that is empty (`a//b`) becomes `_`.
- **Conflicts:** `skip` leaves the existing destination untouched and counts it in `skippedFiles`;
  `overwrite` replaces it. Nothing is ever overwritten with `skip`; the single-file
  `start_download` keeps its existing overwrite behavior.
- **Transfers inside a batch** use the user's part size / parallel parts settings and the global
  `maxConcurrentTransfers` limit; a batch does not get more slots than single transfers would.
  Within a batch, files start in path order.
- **Counters:** `doneFiles + skippedFiles + failedFiles == totalFiles` at the end unless cancelled;
  status `completed` only when `failedFiles == 0`; `failed` when any file failed (the others are
  still transferred); `cancelled` on cancel.
- **Planning errors** (folder unreadable, prefix listing fails) fail the batch before any transfer.
- The OS drop of a **directory** onto the window opens the upload-folder flow (preview + confirm)
  instead of being rejected.

**Batch details settled during implementation:**,,- `preview_batch` for an upload answers `InvalidInput` ("<path> is not a folder") before any S3 call when `localPath` is a,  plain file; the frontend uses this to tell dropped files from dropped folders. A missing or unreadable folder is `Io`.,- Over-limit batches are not rejected synchronously: planning runs inside the batch (first event `planning`), and an,  over-limit plan ends the batch `failed` with an `error` naming the limit. Only malformed requests (bad prefix,,  relative path) are rejected by the command itself. The UI disables Start when a preview is `truncated`.,- Unreadable local files count as failed files (listed in `errors`), so such an upload ends `failed`; the preview,  reports them as `skippedUnreadable`.,- A file that appears at the destination between planning and transfer under `skip` is left unchanged and counted as,  skipped. Upload under `skip` sends no `If-None-Match` (not supported by every server), so an object written by,  someone else in that window can still be overwritten.,- Statuses only move forward: planning → queued → running → final; a batch with nothing to transfer goes from,  planning straight to its final status. `doneBytes` includes bytes moved by files that later failed.,- Download requests need a non-empty prefix ending in `/` (no bucket-root download). Zero-byte folder markers are,  skipped silently; a marker with data is a per-file failure. Symlinks and junctions are skipped and noted.,- `remove_batch` also forgets the batch's transfers. An active batch blocks `install_update` like transfers and jobs.,- Known limit: every batch file still emits its own `transfer:progress` events (at least three), so a 50,000-file,  batch sends well over 100,000 events to the webview. The frontend batches them per animation frame.,,### Object versions

For buckets with versioning Enabled or Suspended.

```ts
interface ObjectVersion {
  versionId: string;           // "null" is a legitimate id for objects written before versioning
  isLatest: boolean;
  isDeleteMarker: boolean;
  size: number;                // 0 for delete markers
  lastModified: string | null;
  etag: string | null;
  storageClass: string | null;
}
interface VersionListing { versions: ObjectVersion[]; truncated: boolean }   // newest first, at most 1,000
```

| Command | Args | Returns |
|---|---|---|
| `list_object_versions` | `{ bucket, key }` | `VersionListing` — `ListObjectVersions` with `prefix = key`, filtered to exact key matches, newest first. On a bucket that never had versioning: one entry with `versionId: "null"`. |
| `download_object_version` | `{ bucket, key, versionId, destPath }` | `string` (transfer id) — the normal parallel download with `versionId` on every request; `If-Match` still applies. |
| `restore_object_version` | `{ bucket, key, versionId }` | `ObjectEntry` (the new current version) — `CopyObject` of that version onto the same key (`x-amz-copy-source` with `?versionId=`), preserving metadata, content type, storage class and tags of that version. Objects over 5 GiB use multipart copy. `InvalidInput` if the version is a delete marker or already the latest. |
| `delete_object_version` | `{ bucket, key, versionId }` | `void` — **permanent**: `DeleteObject` with `versionId`. Also how a delete marker is removed (which "undeletes" the object). Requires `s3:DeleteObjectVersion`. |

- Restoring is non-destructive: the old current version becomes a noncurrent version.
- The UI shows versions only when the bucket's versioning state is Enabled or Suspended (already
  fetched for lifecycle); it offers "Permanently delete this version" only behind a confirmation
  that says it cannot be undone and names the version id and date. Deleting the current version of
  a plain object stays a normal delete.

### Restoring archived objects

Objects in `GLACIER`, `DEEP_ARCHIVE` (and `INTELLIGENT_TIERING`'s archive tiers) cannot be read until
restored. `ObjectMeta` gains:

```ts
restore: { inProgress: boolean; expiresAt: string | null } | null;   // from the x-amz-restore header; null when not applicable
archived: boolean;                                                  // true when a restore is required to read the object
```

```ts
type RestoreTier = "Bulk" | "Standard" | "Expedited";
interface RestoreRequest { tier: RestoreTier; days: number }        // days 1..=365: how long the restored copy stays readable
```

| Command | Args | Returns |
|---|---|---|
| `restore_object` | `{ bucket, key, request }` | `void` — `RestoreObject`. Already in progress → `Conflict` ("already being restored"). Not archived → `InvalidInput`. `Expedited` on `DEEP_ARCHIVE` → `InvalidInput` (S3 does not offer it). |

Bulk restore is a job: `JobKind` gains `"restore"` and `JobRequest` gains `restore?: RestoreRequest`
(required for that kind, rejected for others; `destBucket` and every `to` null). Per object:
`HeadObject` to decide (not archived → skipped, in progress → skipped with a note), then
`RestoreObject`; failures per object. Counters and events as for other jobs.

- The UI shows restore status in the details panel, offers Restore on archived selections with the
  tier, the days, a plain note on cost and typical waiting time per tier (Expedited minutes, Standard
  hours, Bulk up to a day or more for Deep Archive), and disables download/copy/move for archived
  objects that are not restored, with the reason.

**Versions and restore details settled during implementation:**,,- `download_object_version` and `delete_object_version` look the version up first (S3 deletes an unknown id,  silently); an unknown version → `NoSuchKey` naming it. Delete re-checks afterwards and reports `Unknown` if the,  version is still listed. Restoring a version does not use `If-Match` (version ids are immutable).,- A delete marker cannot be downloaded or restored (`InvalidInput`); removing it with `delete_object_version` brings,  the object back. Restoring the current version is `InvalidInput`.,- A never-versioned bucket (or a server without `ListObjectVersions`) lists the current object as version `"null"`;,  a missing key lists nothing. At most 100,000 versions are scanned when looking one up.,- `head_object`: `archived` is true for GLACIER / DEEP_ARCHIVE, or INTELLIGENT_TIERING with an archive status, unless a,  finished restore has not yet expired; a restored copy is `archived: false` with `restore.expiresAt` set.,- A single `restore_object` on an already-restored object is sent (S3 extends the restored copy); the restore job,  skips such objects, and skips in-progress ones, counting both as skipped (`Job` has no notes field). For,  Intelligent-Tiering archive tiers `Days` is omitted and Expedited is refused like Deep Archive. A server without,  `RestoreObject` stops a restore job with a job-level `NotSupported`.,- Reading an archived, unrestored object anywhere (download, copy, move, rename) fails with,  `InvalidObjectState: The object is archived; restore it first.`,- `disconnect`: `cancelActive` missing counts as false. With true, cancellation is awaited for at most 10 s, then the,  connection is dropped regardless.,- `delete_saved_connection` reports an error if the connection was deleted but its added buckets could not be removed.,,### Disconnect stops work

`disconnect` gains an argument: `{ cancelActive: boolean }`. With `true`, every queued or running
transfer, batch and job is cancelled before the connection is dropped (cooperative; the final
events are emitted). With `false` (today's behavior) they finish in the background. The frontend
asks when anything is active: "N operations are still running." with **Cancel them and disconnect**,
**Let them finish**, and **Stay connected**.

### Smaller changes

- `notifyOnFinish` uses the OS window focus (`isFocused()`), not the document's.
- `delete_saved_connection` also removes that connection's added buckets.
- `Transfer.batchId` (see above).

### IAM permissions added in this version

`s3:ListBucketVersions` (list versions), `s3:GetObjectVersion` (download or restore a version;
`CopyObject` of a version reads it), `s3:DeleteObjectVersion` (permanent delete), `s3:RestoreObject`
(restore archived objects). Folder transfers need nothing beyond single transfers.

**Batch details settled after the v0.5.0 review and end-to-end run:**

- `preview_batch` accepts an optional `previewId: string`; a newer preview with the same id cancels the older one,
  which fails with `Cancelled`. The frontend sends `<dialog id>:<n>`. Closing a dialog does not cancel a running preview.
- A folder download never writes through a symlink or junction below its root: planning fails a file whose path
  crosses one ("Not downloaded: <path> is a link to another location"), a final component that is itself a link is a
  per-file failure (never replaced), and at run time the canonical parent must lie inside the canonical root. Only
  name-surrogate reparse points (symlinks, junctions) count; cloud-file placeholder folders are ordinary folders.
- A batch upload refuses a local file that became a symlink after planning.
- Upload conflict checks list only the planned key range (`StartAfter` below the smallest key, stop past the largest),
  capped at 200,000 keys, with a `HeadObject` per planned file beyond that.
- Local-name collisions fold case per character like NTFS (so `ΣΣ`, `σσ` and `σς` collide) and NFC-normalize on
  macOS. Reserved names also include `CONIN$`, `CONOUT$` and `COM`/`LPT` followed by a superscript 1–3; trailing
  spaces are trimmed from the stem before the check. Over-long names get a shortened temp name.
- Queued transfer tasks are boxed so a 50,000-file batch does not hold 50,000 full-size futures.
- Transfer-manager locks are never held across another lock; a stress test guards the ordering (a disconnect
  deadlock was found this way).

## v0.6.0 additions — search, and the Activity menu

Everything in this section is new in v0.6.0. Where it changes an earlier section, this section wins.

### Search in a bucket

S3 has no server-side search. Searching is a **bounded scan** of keys (the same mechanism as "Newest
files"), narrowed as much as the query allows, with one query language that covers paths, keywords
and tags:

| Term | Meaning |
|---|---|
| `word` | the key contains `word` (case-insensitive, Unicode lowercase on both sides; no normalization) |
| `"two words"` | the key contains the phrase, including the space |
| `-word` / `-"phrase"` | the key does not contain it |
| `tag:key=value` | the object has a tag with exactly that key (case-sensitive, as S3) and that value (case-insensitive) |
| `tag:key` | the object has a tag with that key, any value |
| a term with `/` (a **path term**) | matched like a word, and additionally used to narrow the listing (below) |

Terms are separated by Unicode whitespace; every term must match (AND). Quotes group inside a term as
well as around it: `tag:Project="Big Data"` is one tag term with the value `Big Data`, and `foo"bar baz"`
is the single word `foobar baz`; an unterminated quote runs to the end of the text. The `tag:` and `-`
prefixes are matched case-insensitively (`TAG:k` is a tag term). Empty phrases (`""`) are dropped before
anything else is decided. A term is path-like when it contains `/` and is not quoted. The Rust parser is
authoritative; the mock mirrors it and uses the same reason wording ("Stopped at N results"). Matching is always against the **full key** (so `invoice 2026` finds
`billing/2026/invoice-0412.pdf`), never against a display name.

```ts
interface SearchQuery {
  bucket: string;
  scope: string;    // prefix to search under ("" = whole bucket); the UI sends the current folder or ""
  text: string;     // the query as typed; the backend parses it
  limit: number;    // max hits, 1..=1000; the UI sends 500
}
interface SearchTagTerm { key: string; value: string | null }
interface ParsedSearch {
  words: string[];          // includes path terms, lowercased
  phrases: string[];        // lowercased
  excluded: string[];       // lowercased words and phrases
  tags: SearchTagTerm[];
  exactPath: string | null; // set when the whole query is one unquoted path term: tried as a key with HeadObject
  listPrefix: string;       // the prefix the scan actually listed (scope, possibly narrowed by a path term)
}
interface SearchHit {
  entry: ObjectEntry;
  tags: Tag[] | null;       // filled only when the query has tag terms
  exact: boolean;           // true for the HeadObject hit on `exactPath`
}
interface SearchResult {
  hits: SearchHit[];        // the exact hit first (if any), then in key order
  scanned: number;          // keys the scan looked at (the exact-path HeadObject is not counted)
  tagLookups: number;       // GetObjectTagging calls made
  truncated: boolean;       // a cap stopped the search before the end of the listing
  reason: string | null;    // which cap, in words, when truncated; e.g. "Stopped after scanning 50,000 objects"
  parsed: ParsedSearch;
}
```

| Command | Args | Returns |
|---|---|---|
| `search_objects` | `{ query: SearchQuery, searchId: string }` | `SearchResult`. A newer call with the same `searchId` cancels the older one, which fails with `Cancelled` (same rule as `preview_batch`), so typing never queues scans. An empty query (no terms after parsing) is `InvalidInput`. |
| `cancel_search` | `{ searchId: string }` | `void`. Cancels the running search with that id (it fails with `Cancelled`); no-op when none is running. The UI's Cancel button calls it, and so does closing the results view while a search runs. |

A `search_objects` call that fails validation (empty query, bad limit) still cancels an older search with the same `searchId` first.

Backend behavior:

- **Narrowing.** The listing prefix starts as `scope`. If the query has a path term, let `dir` be the
  term up to and including its last `/`: when `dir` starts with `scope`, list `dir` instead; when
  `scope` starts with `dir`, keep `scope`; otherwise keep `scope` (the term can still match as a word).
  With several path terms use the longest `dir` that qualifies. `parsed.listPrefix` reports the choice.
- **Narrowing fallback.** S3 prefixes are case-sensitive, so a narrowed listing uses the path term with the
  case typed. When the narrowed listing (`listPrefix` longer than `scope`) ends with **zero keys scanned**, the
  scan runs again from `scope` so the path term can still match as a case-insensitive word (`Photos/2024` then
  finds `photos/2024/x.jpg`); `parsed.listPrefix` reports `scope` and `scanned` counts only the second scan.
  A narrowed listing that found keys but no hits is not retried.
- **Exact path.** When the whole query is a single unquoted path term, `HeadObject` that key first
  (it may be outside `scope`; the key is sent byte-for-byte as typed, never normalized). A hit becomes
  `hits[0]` with `exact: true`. Any head error other than `Network`, `Auth` and `NoSuchBucket` (so also
  `NoSuchKey`, `AccessDenied`, and 400/301-style `Unknown` errors) means "no exact hit", never a failed search. The scan
  still runs and skips that key if it meets it again. A path term ending in `/` is reported as `exactPath`
  but never headed: a folder marker is never an exact hit.
- **Scan caps.** Stop after **50,000 keys** scanned, or when `limit` hits are found, or after **200 listing
  pages** (a bucket made mostly of folder markers would otherwise be listed to its end). Folder markers
  (keys ending in `/`) are skipped and not counted as scanned keys. Paging follows the usual rule: a repeated
  continuation token is an error, never a silent stop. Stopping before the end of the listing is
  `truncated: true` with a `reason`; the frontend never presents a truncated result as complete.
- **Tags.** Tags are not in the listing, so a query with tag terms narrows by its word, phrase,
  exclusion and path terms first, then calls `GetObjectTagging` for each remaining candidate, 16 in
  flight, in key order, capped at **2,000 lookups** per search (then `truncated`, reason names the tag
  cap). Candidates that fail the tag check are not hits. `NoSuchKey` on a lookup (deleted meanwhile)
  drops the candidate; any other error fails the search. `AccessDenied` on the first lookup fails the
  search with a message that says tag search needs `s3:GetObjectTagging`.
- **Cancellation.** The scan checks for cancellation between pages and between tag lookups.
  Disconnecting cancels running searches.
- Read-only: `ListObjectsV2`, `HeadObject` and `GetObjectTagging` (all permissions earlier versions already need).
- Shared buckets (added by name) search the same way.

Frontend:

- The toolbar box becomes **"Filter · press Enter to search"**: typing still filters the loaded rows
  instantly (unchanged); **Enter** runs `search_objects` with the box's text, `Ctrl+F` focuses the box,
  **Esc** clears it (and leaves the results view if open). A segmented control beside the box chooses
  the scope, **This folder** (default; `scope` = current prefix) or **Whole bucket** (`scope` = `""`);
  the choice persists per session.
- Results replace the object table in the main area until dismissed: a header line ("*n* results for
  *query* in *scope* · scanned *m* objects", with the truncation reason when truncated and a "Searching…"
  state with a Cancel button while running), a "Back to folder" button, and a **virtualized** flat list.
  Each row: file icon, the key's name with the matched words/phrases highlighted, the key's folder
  (dimmed, with the match highlighted too), size, last modified, storage class, and the object's tags as
  chips when the query had tag terms; the exact-path hit is marked "exact match".
- Row actions: double-click or Enter **goes to the object** (`revealObject`: opens its folder with it
  selected); right-click (and the keyboard menu key) opens a `PopupMenu` with Go to object, Download,
  Copy S3 URI, Copy key. Download reuses the existing download flow (same confirmations and destination
  picker). Multi-select is not needed in v0.6.0.
- The hint under the box (shown while it has focus and is empty, dismissable) explains the forms in one
  line: `word`, `"a phrase"`, `-not`, `tag:key=value`, `folder/part`.
- Changing bucket or disconnecting closes the results view. Refresh re-runs the same search.
- The mock implements the same parser and scan over its in-memory buckets, including tag terms and the caps.

### Activity right-click menu

Every row in the Activity panel (transfers, folder transfers, jobs) opens a context menu on right-click
and on the keyboard menu key (`Shift+F10` / `ContextMenu`) when the row is focused (rows become focusable).
The existing inline buttons stay. Items, in this order, separated into groups as listed:

- **Download (completed):** Open file · Show in folder — Go to object · Copy key · Copy local path — Remove from list.
- **Download (queued/running):** Cancel — Go to object · Copy key.
- **Download (failed/cancelled):** Go to object · Copy key · Copy local path — Remove from list.
- **Upload (completed):** Go to object · Show in folder (the local source) · Copy key · Copy local path — Remove from list.
  Running: Cancel — Copy key. Failed/cancelled: Copy key · Copy local path — Remove from list.
- **Folder download (finished, `doneFiles > 0`):** Open folder · Show in folder — Go to folder (navigate
  to `prefix`) · Copy local path — Remove from list. Active: Cancel — Go to folder. Nothing done: Go to folder · Copy local path — Remove from list.
- **Folder upload:** Go to folder · Show in folder · Copy local path — Cancel while active, else Remove from list.
- **Job:** Go to source (`srcBucket`, the first item's folder) · Go to destination (copy/move only:
  `destBucket`, the first item's destination folder) — Copy failures (only when `errors` is non-empty:
  one `key — message` per line) — Cancel while active, else Remove from list.
- "Go to …" uses `revealObject` for an object and `navigate` for a folder; it is disabled with a tooltip
  when the row's bucket is not in the current connection's bucket list (a different connection).
- "Copy …" items use the OS clipboard (`copyText`) and toast on failure, like the lifecycle dialog.
- "Remove from list" calls the existing `remove_*` command; "Clear finished" stays.

| Command | Args | Returns |
|---|---|---|
| `open_local` | `{ path }` | `void`. Opens a local file with the OS default application, or a local directory in the file manager, via the opener plugin's `open_path` on the Rust side (no new webview capability). The backend accepts **only** a path that is the `localPath` of a `completed` download transfer still in the transfer list, or the `localPath` of a download batch that is no longer active and has `doneFiles > 0`. Compared after canonicalizing both sides (case-insensitively on Windows). Anything else is `InvalidInput` ("Not a finished download"). |

- `open_local` refuses to open a file whose extension is one of
  `exe bat cmd com scr pif cpl msc hta chm scf ps1 psm1 msi msp mst vbs vbe js jse ws wsf wsh wsc jar xll jnlp gadget application appref-ms settingcontent-ms diagcab library-ms search-ms py pyw sh command app terminal fileloc inetloc desktop reg lnk url`
  (case-insensitive) with `NotSupported` ("… could be run as a program; use Show in folder"). The
  frontend hides "Open file" for those extensions instead of offering an item that fails.
- `open_local` never follows the path through a symlink or junction whose target leaves the recorded
  destination directory: the canonical path must still start with the canonical parent recorded for
  the transfer (same rule as folder downloads). For a folder batch the recorded parent is the parent of
  the batch directory, so a batch directory replaced by a junction is refused too. The extension rule
  applies to directories as well (a batch folder named `x.app` is refused, and the UI hides "Open folder").
  Opening runs on a blocking thread, never on the async runtime.
- The frontend closes the results view on **every** navigation (any `navigate`/`revealObject`, including
  to the current folder, a newest-files click, a breadcrumb or bucket click), so a selection can never
  exist behind the results. A cancelled run keeps showing "cancelled" in the header, never a blank view.

### File manager override (setting)

By default "Show in folder" opens the OS file manager with the item selected, and "Open folder" opens a
directory in it. The user can point both at a different program instead (Total Commander, Files, Directory
Opus, Dolphin, …).

`AppSettings` gains `fileManagerCommand: string | null` (default `null`). `update_settings` requires the field
like the others; a `settings.json` without it loads `null`. Validation: trimmed; empty becomes `null`; at
most 1,024 characters; no control characters.

```ts
// AppSettings (v0.6.0)
fileManagerCommand: string | null;  // null = the system file manager
```

The command is one line, split into a program and arguments by the backend (double quotes group, `\"`
is a literal quote, no shell is ever involved), with two placeholders that are replaced **inside an
argument** after splitting, so a path with spaces never breaks apart:

| Placeholder | Replaced by |
|---|---|
| `{path}` | the item itself (the downloaded file, or the folder for "Open folder") |
| `{dir}` | the directory that contains the item (for a folder: the folder itself) |

If the command names no placeholder, `{dir}` is appended as the last argument. Examples:
`"C:\Program Files\totalcmd\TOTALCMD64.EXE" /O /T "{dir}"`, `nautilus --select "{path}"`,
`open -R "{path}"`.

| Command | Args | Returns |
|---|---|---|
| `reveal_local` | `{ path }` | `void`. With `fileManagerCommand` null: the opener plugin's reveal (select the item in the OS file manager), on the Rust side. Otherwise: spawn the program with the substituted arguments, detached, without waiting. The program must exist as a file, or be a bare name found on `PATH` (with `PATHEXT` on Windows); the resolved absolute path is what runs (`InvalidInput` "File manager not found: …" otherwise); a spawn failure is `Io` with the OS message. The path itself is not restricted (reveal only shows it), but it must be absolute. |

- `open_local` on a **directory** goes through the same override (`{path}` = `{dir}` = the directory);
  `open_local` on a file still opens the file with its default application, never the file manager.
- The frontend no longer calls the opener plugin's `revealItemInDir` directly: `api.revealInFolder`
  invokes `reveal_local`, and the `opener:allow-reveal-item-in-dir` capability is removed from
  `capabilities/default.json`.
- **Settings UI (Behavior tab):** a group "Show in folder opens" with two choices, **System file
  manager** (default) and **This program**, which reveals a text field for the command, a **Browse…**
  button (the dialog plugin's file picker, which inserts the chosen program quoted, followed by
  ` "{dir}"`), a one-line explanation of `{path}` and `{dir}`, and a **Try it** button that calls
  `reveal_local` on the settings file's directory with the *unsaved* field value (`try_file_manager
  { command, path }` below) and toasts the error if it fails. Saving an invalid command is refused with
  the backend's message under the field, like the other settings.

| Command | Args | Returns |
|---|---|---|
| `try_file_manager` | `{ command: string | null, path: string }` | `void`. Same as `reveal_local` but with the given command instead of the saved setting, so the user can test before saving. |

- The command never runs through a shell, so there is no quoting the user can get wrong beyond the double
  quotes above; `%VAR%` and `$VAR` are not expanded.

### Hidden game (from PR #2): window lock

`lockWindowSize(true)` is called when the start-screen game begins and must be undone on **every** exit:
Esc/game over (already), and the start screen unmounting while the game is open (connecting from a saved
connection that auto-connects, the window being closed). Implement as an unmount effect in
`TransferBackdrop` that unlocks when `playing` is true.

### IAM permissions added in this version

None. Search uses `s3:ListBucket`, `s3:GetObject` (HeadObject) and `s3:GetObjectTagging`, which browsing,
downloading and tag viewing already require.
