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
  checkUpdatesOnStartup: boolean;   // default false until v0.7.0, true from v0.8.0 (see "Update popup")
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
| `path:a b/c.txt` or `path:"a b/c.txt"` | a path term that may contain spaces (the `path:` prefix is case-insensitive; quotes group as usual and are dropped); it narrows the listing and is exact-path eligible like an unquoted path term |

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

### Search: folders are hits, and results carry a selection (settled after the first dev run)

**Folders are results.** The scan derives every folder below `listPrefix` from the keys it sees (each
`/`-delimited ancestor of a key, plus folder-marker keys ending in `/`). A folder is a hit when its full
prefix matches every word, phrase and exclusion term (same matching as objects, on the full prefix string).
Queries with tag terms produce no folder hits (folders have no tags). Folder hits are de-duplicated, come
**before** object hits (as in the table), are in prefix order, and count toward `limit`.

```ts
interface SearchHit {
  kind: "object" | "folder";
  entry: ObjectEntry | null;     // kind "object"
  folder: FolderEntry | null;    // kind "folder"; prefix passed through byte-for-byte
  tags: Tag[] | null;            // objects only, when the query has tag terms
  exact: boolean;                // the exact-path hit (object or folder)
}
```

**Exact path for folders.** When the whole query is a single unquoted path term, besides the `HeadObject`
on the key the backend also checks the term as a folder: `ListObjectsV2` with `prefix` = the term with a
`/` appended if it lacks one, `max-keys` 1. If anything is listed, the folder is an exact hit (`kind:
"folder"`, `exact: true`) placed first. Both checks run; an exact object and an exact folder can both exist.
The folder check is never skipped for a term ending in `/` (that is the common pasted form).

**`s3://` paths.** The frontend accepts a pasted `s3://<bucket>/<key or prefix>` as the whole query: it
strips the scheme and bucket, switches to that bucket first when it differs from the open one and is in the
bucket list (otherwise toasts "Bucket <name> is not in this connection"), and searches the rest as a lone
path term with scope `""`, sent as `path:"<rest>"` (quotes inside escaped as `\"`) so a path with spaces stays one term.
Hits removed after a job are removed when the job **finishes**, and only the keys it reports done (failed keys stay).

**Selection and actions in the results view.** While results are open, the result rows **are** the
selection: click, Ctrl/Cmd-click, Shift-click and the keyboard select exactly as in the object table, and
`getSelected()` returns the selected hits as `{ folders, objects }`. Every toolbar and context-menu action
that works on a table selection works on a results selection with the same confirmations: Download,
Delete, Copy, Cut, Rename (single), Tags, Restore, Properties (details panel) and Versions for a single
object. Upload, New folder and Paste are disabled while results are open (no visible target folder). The
results context menu offers the same items as the table's, plus "Go to object" / "Open folder". Enter or
double-click on an object goes to it; on a folder it navigates into it. After a delete, rename, cut-paste
or move started from the results, the affected hits are removed from the list immediately. When results
arrive, the first row takes focus (so a pasted path followed by Enter twice opens it).

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
  `try_file_manager` with the *unsaved* field value on the newest completed download, or the file-system root when there is none, (`try_file_manager
  { command, path }` below) and toasts the error if it fails. Saving an invalid command is refused with
  the backend's message under the field, like the other settings.

| Command | Args | Returns |
|---|---|---|
| `try_file_manager` | `{ command: string | null, path: string }` | `void`. Same as `reveal_local` but with the given command instead of the saved setting, so the user can test before saving. |

- The command never runs through a shell, so there is no quoting the user can get wrong beyond the double
  quotes above; `%VAR%` and `$VAR` are not expanded. The one exception is a `.bat`/`.cmd` program, which
  Windows itself runs through `cmd.exe` (arguments are escaped by the runtime); Browse… therefore offers
  only `.exe`/`.com` on Windows. A program whose file name is a shell or script host (`cmd`, `powershell`,
  `pwsh`, `wscript`, `cscript`, `mshta`, `sh`, `bash`, `zsh`, `fish`, with or without `.exe`) is refused
  with `InvalidInput`: a file manager is never one of those. A program with a relative directory part is
  refused, and relative `PATH` entries are skipped, so nothing depends on the working directory. On Windows
  a bare name without an extension tries only the `PATHEXT` extensions (like `cmd.exe` does), never the
  extensionless file. On macOS, choosing an `.app` bundle in Browse… inserts `open -a "<bundle>" "{dir}"`.

### Hidden game (from PR #2): window lock

`lockWindowSize(true)` is called when the start-screen game begins and must be undone on **every** exit:
Esc/game over (already), and the start screen unmounting while the game is open (connecting from a saved
connection that auto-connects, the window being closed). Implement as an unmount effect in
`TransferBackdrop` that unlocks when `playing` is true.

### IAM permissions added in this version

None. Search uses `s3:ListBucket`, `s3:GetObject` (HeadObject) and `s3:GetObjectTagging`, which browsing,
downloading and tag viewing already require.

## v0.7.0 additions — two panes

Frontend only. No new command, type or event; copy and move between panes use the existing `copy` and
`move` jobs (`start_job`) with their previews and confirmations, so every rule in "Object operations
(jobs)" and "Confirmations for copy and move" applies unchanged.

### Split view

- The main area can show **one or two explorer panes side by side**, each with its own bucket, folder,
  listing, sort, filter, selection, scroll position and search results, on the **same connection** (two
  connections at once are out of scope). A toolbar button (**Split**, icon `Columns2`) and `Ctrl+2`
  open the second pane; the same button (**Single**) and `Ctrl+1` close it (`Mod+1`/`Mod+2` in the keyboard registry). The choice persists
  (`s3x.split`). The second pane opens at the first pane's bucket and folder.
- Exactly one pane is **active** at any time: the last one clicked, focused or navigated. The active pane
  has a visible marker (its path bar and table border take the accent; the other pane is dimmed slightly).
  Everything that acted on "the current folder" before acts on the active pane: the toolbar (Upload, New
  folder, Download, Delete, Copy, Cut, Paste, Rename, Tags, Up, Refresh, the search box and scope), the
  details panel, the sidebar's bucket click and "Newest files", drops of OS files onto the window (they
  upload into the pane under the pointer, else the active pane), notifications' "go to", keyboard
  shortcuts, the context menu, and the Activity menu's "Go to …" items (which open in the active pane).
- Each pane has its own **path bar** (breadcrumbs, item count, truncation note) above its table; the
  toolbar stays single, at the top, and acts on the active pane. In split view the path bars carry the
  pane's bucket name as the first crumb so two buckets are distinguishable at a glance.
- `Tab` while focus is in a pane's table (or results list) moves focus and activity to the other pane and
  restores its focused row; `Shift+Tab` goes back. Everything else about `Tab` is unchanged.
- Closing the split keeps the **active** pane and drops the other. Disconnecting resets both panes; the
  split preference stays. Below a main-area width of 560 px the second pane is hidden (not closed) and a
  note in the toolbar button's tooltip says why; at the default window size with the details panel open
  (about 748 px) both panes must be visible, with each pane's columns adapting to its own width.

### Copy and move between panes

- In split view the toolbar gains **Copy to other pane** and **Move to other pane** (default keys `Mod+Shift+C` / `Mod+Shift+X`, see "Keyboard" below; `F5`/`F6` were the first choice and were dropped because `F5` is Refresh),
  enabled when the active pane has a selection and the other pane shows a bucket. The row context menu
  gets the same two items. Both call the existing paste flow with the selection of the active pane as the
  source and the other pane's bucket + folder as the destination: the same preview, the same conflict
  handling, the same confirmation (and the same skipping of it when `confirmCopyMove` is off and nothing
  conflicts), the same refusal to write into a source.
- **Drag and drop across panes:** rows dragged from one pane can be dropped on a folder row of the other
  pane (into that folder), on its path bar crumbs (into that crumb), or on the **empty area / any object
  row of the other pane's table** (into the pane's current folder). The badge and `Ctrl`/`Option`-to-copy
  behave as in "Drag and drop to move or copy". Dropping on the pane the drag started in follows the
  existing rules (folder rows and crumbs only; the current folder is refused as a no-op).
- The source selection is captured when the action starts (keys/prefixes byte-for-byte); the destination
  is the other pane's bucket and prefix at that moment; neither is recomputed later.
- When a job finishes, **both** panes refresh in place if they show a bucket the job touched (source or
  destination), so the moved rows disappear on one side and appear on the other. A pane whose folder was
  moved or deleted out from under it navigates to the nearest existing ancestor with a toast.
- The in-app clipboard is shared: copy/cut in one pane, paste in the other, works as today.

### State shape (for the implementation)

Pane state (`bucket`, `prefix`, `listing`, `selection`, `anchor`, `focus`, `sort`, `filter`, `reveal`,
`scrollTo`, search results) moves out of the single app store into a pane store keyed by pane id
(`"a" | "b"`), with `activePane` in the app store. Components inside a pane get their pane id from a
React context; the existing exported actions (`navigate`, `setSelection`, `setFilter`, `getSelected`,
`refresh`, `loadMore`, `revealObject`, search run/close …) keep their signatures and act on the active
pane, with an optional explicit pane parameter where a caller needs the other one (drag drop, F5/F6,
"go to" from Activity). `useApp` consumers of pane fields become pane-store consumers. The mock changes only to pass the
pointer position of a simulated OS file drop (`FileDropEvent.position`, filled from Tauri's drag-drop payload in the real app). The invariants that already hold per listing (selection pruned by filter, `reveal` cleared on
user selection, results closed on navigation) hold per pane.

Settled after the first implementation: the Split button is one toggle with a pressed state (lucide has a single
columns icon); the search scope control is shared by both panes while results, selection and filter are per pane;
after a reconnect with the split remembered, opening a bucket while the other pane is empty opens the same place
in both panes.

### Verification specific to this version

Browser click-through against the mock, in both themes and at 1000 / 1280 / 1700 px: split and single
toggles and persistence; independent navigation, filter, sort, selection and search per pane; the active
marker following clicks, focus and `Tab`; toolbar actions targeting the active pane only (download starts
for the active pane's selection; New folder creates in the active pane); F5/F6 and cross-pane drag onto a
folder row, a crumb and the empty area, each starting a job whose request is exactly the captured keys and
the other pane's folder; a move's rows leaving one pane and arriving in the other on completion; the
same-pane drag rules unchanged; OS-file drop uploading into the pane under the pointer; search results
open in one pane while the other browses; closing the split keeping the active pane; disconnect resetting
both; keyboard shortcuts (`Delete`, `F2`, `Ctrl+C/X/V`, `Backspace`, `Ctrl+F`) applying to the active
pane; no transfer-progress re-renders of either table.

### Keyboard: configurable bindings, search as you type, no mouse needed

Also in v0.7.0. Backend: one settings field and two file commands. Frontend: one key dispatcher that
replaces the scattered `keydown` handlers, a Keyboard tab in Settings, search debounce, type-to-search,
and per-pane history.

#### Chords and actions

A **chord** is written `Mod+Shift+K`: zero or more modifiers from `Mod`, `Ctrl`, `Alt`, `Shift`, `Meta`
in that order, then one key name. `Mod` means `Ctrl` on Windows and Linux and `Cmd` (`Meta`) on macOS, and
is what defaults and exported files use so they stay portable; `Ctrl` and `Meta` are literal. Key names
are `KeyboardEvent.key` normalised: letters upper-case (`K`), digits, `F1`..`F24`, `Enter`, `Escape`,
`Backspace`, `Delete`, `Insert`, `Tab`, `Space`, `ArrowUp/Down/Left/Right`, `Home`, `End`, `PageUp`,
`PageDown`, punctuation as typed (`/`, `?`, `,`, `.`, `\`, `[`, `]`), and the extra mouse buttons `Mouse4`
(`MouseEvent.button === 3`, the browser's Back button) and `Mouse5` (`button === 4`, Forward), with modifiers.
A mouse-button chord fires on `mousedown` in the explorer (the webview's own history navigation is
prevented on `mousedown`, `mouseup` and `auxclick` for those buttons, bound or not), acts on the pane under
the pointer (else the active pane), is recordable in Settings → Keyboard like a key, and belongs to the
`global` context. Display uses the platform's
symbols on macOS (⌘ ⌥ ⇧ ⌃) and words elsewhere.

Every action has an id, a label, a group, a **context** and a list of default chords (at most 4 chords per
action). Contexts decide where a chord fires:

| Context | Fires when |
|---|---|
| `global` | anywhere in the explorer except inside a text field, unless the chord has `Mod`, `Alt` or is an F-key; never while a dialog, context menu or Settings is open (except `view.settings`, `help.shortcuts` and `sel.none`) |
| `files` | focus is in a pane's table or results list (the active pane) |
| `search` | focus is in the toolbar search box |

Default bindings (the frontend's registry in `src/lib/keys.ts` is the source of truth; this table must match it):

| Group / action id | Label | Context | Defaults |
|---|---|---|---|
| **Navigate** `nav.open` | Open folder / go to object | files | `Enter` |
| `nav.up` | Up one level | global | `Backspace`, `Alt+ArrowUp` |
| `nav.back` / `nav.forward` | Back / Forward (per-pane history) | global | `Alt+ArrowLeft`, `Mouse4` / `Alt+ArrowRight`, `Mouse5` |
| `nav.root` | Bucket root | global | `Mod+Home` |
| `nav.refresh` | Refresh | global | `F5`, `Mod+R` |
| `nav.focusFiles` | Focus the file list | global | `Mod+E` |
| `nav.focusBuckets` | Focus the bucket list | global | `Mod+B` |
| `nav.focusSearch` | Search | global | `Mod+F`, `/` |
| `nav.searchScope` | Toggle search scope (this folder / whole bucket) | global | `Mod+Shift+F` |
| `nav.bookmark` | Bookmark this folder (see "Bookmarks") | global | `Mod+Shift+D` |
| `nav.nextPane` / `nav.prevPane` | Next / previous pane | files | `Tab` / `Shift+Tab` |
| `view.single` / `view.split` | Single view / Split view | global | `Mod+1` / `Mod+2` |
| `view.details` | Toggle details panel | global | `Mod+I` |
| `view.activity` | Toggle Activity panel | global | `Mod+J` |
| `view.settings` | Settings | global | `Mod+,` |
| `help.shortcuts` | Keyboard shortcuts (cheat sheet) | global | `F1`, `?` |
| **Select** `sel.up` / `sel.down` | Move focus up / down | files | `ArrowUp` / `ArrowDown` |
| `sel.pageUp` / `sel.pageDown` | Page up / down | files | `PageUp` / `PageDown` |
| `sel.first` / `sel.last` | First / last row | files | `Home` / `End` |
| `sel.toggle` | Toggle selection of the focused row | files | `Space` |
| `sel.toggleNext` | Toggle and move down | files | `Insert` |
| `sel.all` | Select all | files | `Mod+A` |
| `sel.none` | Clear selection (or close results) | files | `Escape` |
| `sel.menu` | Context menu | files | `ContextMenu`, `Shift+F10` |
| **Act** `act.upload` | Upload files | global | `Mod+U` |
| `act.uploadFolder` | Upload folder | global | `Mod+Shift+U` |
| `act.download` | Download (objects or folders) | global | `Mod+D` |
| `act.newFolder` | New folder | global | `F7` |
| `act.delete` | Delete | files | `Delete`, `F8` |
| `act.rename` | Rename | files | `F2` |
| `act.copy` / `act.cut` / `act.paste` | Copy / Cut / Paste (in-app clipboard) | files | `Mod+C` / `Mod+X` / `Mod+V` |
| `act.copyToOther` / `act.moveToOther` | Copy / Move to other pane | global | `Mod+Shift+C` / `Mod+Shift+X` |
| `act.copyKey` | Copy key | files | `Mod+Shift+K` |
| `act.copyUri` | Copy S3 URI | files | `Mod+Shift+L` |
| `act.tags` | Tags | files | `Mod+T` |
| `act.versions` | Show versions (details panel, Versions section) | files | `Mod+Shift+V` |
| `act.restore` | Restore archived | files | (none) |
| `act.preview` | Quick look (added with "Object preview") | files | `F3` |
| `act.disconnect` | Disconnect | global | `Mod+Shift+Q` |
| **v0.8.0** `tab.new` / `tab.close` / `tab.reopen` | New tab / Close tab / Reopen closed tab | global | `Mod+N` / `Mod+W` (macOS `Mod+Shift+W`) / `Mod+Shift+T` |
| `tab.next` / `tab.prev` | Next / previous tab | global | `Mod+Tab`, `Mod+PageDown` / `Mod+Shift+Tab`, `Mod+PageUp` |
| `view.history` | Show the history (Activity) | global | `Mod+H` (macOS `Mod+Shift+H`) |
| `act.editMetadata` | Edit content type and metadata | files | `Mod+M` (macOS unbound) |
| `act.folderSize` | Calculate folder size | files | (none) |
| `act.pauseAll` / `act.resumeAll` | Pause all / Resume all transfers | global | (none) |
| **v0.9.0** `source.pickLeft` / `source.pickRight` | Choose the left / right pane's source (bucket or local drive) | global | `Alt+F1` / `Alt+F2` |
| `nav.editPath` | Edit the path | global | `Mod+L` |
| `nav.syncOther` | Show this location in the other pane | global | `Mod+Shift+ArrowRight`, `Mod+Shift+ArrowLeft` |
| `local.toggleHidden` | Show hidden files (local pane) | global | `Mod+.` |
| (preset `commander` differences) `act.copyToOther` / `act.moveToOther` `F5` / `F6`; `act.rename` `Shift+F6`; `nav.refresh` `F2`, `Mod+R`; `nav.focusSearch` `Alt+F7`, `Mod+F`, `/`; `act.tags` `Alt+Shift+T`; `act.folderSize` `Alt+Shift+L`; `tab.new` `Mod+T`, `Mod+N` | | | |

`Shift` held with `sel.up/down/pageUp/pageDown/first/last` extends the selection (a fixed rule, not a
separate binding). **`F5` and `F6` are no longer Copy/Move to other pane**; `F5` refreshes the active pane
exactly like the Refresh button (fixes the "F5 reloads the window" bug). The webview's own reload, print,
find and view-source shortcuts (`F5`, `Ctrl+F5`, `Ctrl+Shift+R`, `Ctrl+R`, `Ctrl+P`, `Ctrl+U`,
`Ctrl+F`, `F3`, `F7`, `F12`-less) are always prevented at the window level, whether or not a binding
uses them, so no key can ever reload or leave the page.

#### Dispatcher rules

- One capture-phase `keydown` listener in `Explorer.tsx` builds the chord from the event, finds the
  action bound to it in the current context, calls `preventDefault()` and runs it. Handlers in
  `ObjectTable.tsx`, `SearchResults.tsx`, `Toolbar.tsx`, `Sidebar.tsx` and `Explorer.tsx` that
  hard-code keys are removed in favour of the registry (dialogs, menus, the game and the connect screen
  keep their own local keys).
- A chord bound in `files` wins over the same chord in `global` when focus is in the file list.
- An action that is not available right now (no selection, no bucket, no other pane, archived object)
  does nothing and shows the same disabled reason the toolbar shows, as a toast, when the key has no
  other meaning.
- **Type to jump (v0.9.0, replaces type-to-search):** printable characters typed in the file list with no
  modifier (or only `Shift`) that are not bound to an action build a prefix (reset 1 s after the last key,
  `Backspace` removes a character, `Escape` clears) and move focus and selection to the first visible row
  whose name starts with it, case-insensitively, like Windows Explorer; typing the same single letter again
  cycles through rows starting with it. No match: nothing moves. Works in S3 panes, local panes and search
  results. The bucket search box is reached with its own keys (`Mod+F`, `/`, `Alt+F7`).
- `Escape` in the search box clears it and returns focus to the active pane's list (unchanged).

#### Search as you type

- The toolbar box runs the bucket search **500 ms after the last keystroke** when the text is non-empty,
  instead of waiting for `Enter`; `Enter` still runs it immediately. Typing more cancels the running
  search (existing `searchId` rule) and schedules a new one. During the 500 ms the instant row filter
  still applies as today. Clearing the box closes the results and cancels. The hint says "searches as
  you type". Results keep focus where it was: the box keeps focus while typing; `ArrowDown` or `Enter`
  from the box moves focus to the first result row.

#### History

Each pane keeps a history of `{bucket, prefix}` it navigated to (cap 100), browser-style: `nav.back`
and `nav.forward` move through it; a new navigation truncates the forward list. The sidebar's bucket
click, breadcrumbs, `nav.up`, `nav.open`, "Go to …" and reveals all push; Back/Forward do not. History is
per pane and cleared on disconnect.

#### Settings → Keyboard

- Lists every action by group with its chords as removable chips, a **Record** button per action (press
  the chord; `Escape` cancels; shows the chord live), a per-action **Reset**, **Reset all**, and
  **Export…** / **Import…**.
- A chord may be bound to only one action per context (`files` and `global` count as the same context for
  this check, since `files` wins silently otherwise); a conflict is shown inline on both actions and Save is
  disabled until resolved. A chord that is only a printable character without modifiers is allowed (like
  `/` and `?`) but shown with a note that it disables type-to-search for that character. `Tab` without
  modifiers can only be bound to pane switching.
- Saved in `AppSettings.keybindings` as **overrides only**: `{ "<action id>": ["Mod+R", "F5"] }` for
  actions whose chords differ from the defaults (an empty array unbinds). Unknown action ids are kept
  (a newer version may know them) but shown under "Unknown actions" with a Remove button.
- **Export** writes `{ "s3explorer": "keybindings", "version": 1, "bindings": { <every action id>: [chords] } }`
  (all actions, not only overrides) to a `.json` file the user picks with the save dialog.
  **Import** reads such a file, validates it (ids, chord syntax, limits), shows a preview of what changes
  and what is unknown, and applies on confirm (as overrides vs the defaults). Both go through the backend
  commands below; the frontend never touches the file system directly.

```ts
// AppSettings (v0.7.0)
keybindings: Record<string, string[]>;   // overrides only; default {}
export const KEYBINDING_LIMITS = { maxActions: 200, idMaxChars: 64, maxChordsPerAction: 4, chordMaxChars: 40, fileMaxBytes: 65_536 } as const;
```

| Command | Args | Returns |
|---|---|---|
| `write_text_file` | `{ path, content }` | `void`. Writes `content` (UTF-8, at most 65,536 bytes) to `path`, which must be absolute, end in `.json`, and whose parent directory must exist; overwrites. Used by Export after the save dialog. `InvalidInput` otherwise, `Io` on failure. |
| `read_text_file` | `{ path }` | `string`. Reads an absolute `.json` path of at most 65,536 bytes as UTF-8 (`InvalidInput` for anything else, including a larger file). Used by Import after the open dialog. |

`update_settings` validates `keybindings`: at most 200 entries; ids 1..=64 chars of `[A-Za-z0-9_.-]`;
at most 4 chords per id; each chord 1..=40 printable ASCII chars; a `settings.json` without the field
loads `{}`.

#### Profiles from `aws login`

A profile whose only credential key is `login_session` (written by `aws login`, AWS CLI 2.32+) counts as
`hasCredentials: true`. The SDK's `credentials-login` provider resolves and refreshes it from
`~/.aws/login/cache`; an expired session surfaces as an `Auth` error whose message tells the user to run
`aws login` again.

#### IAM permissions added in this version

None.

## v0.8.0 additions

### Folder size (added on request after v0.7.0)

How much is in a folder, on demand. S3 keeps no folder totals, so the size is a bounded, cancellable
scan of every key under the prefix.

```ts
interface FolderSize {
  objects: number;     // objects counted (folder markers, keys ending in "/", are not counted)
  bytes: number;       // sum of the counted objects' sizes
  scanned: number;     // keys listed, folder markers included
  truncated: boolean;  // stopped at FOLDER_SIZE_SCAN_LIMIT: the numbers are a lower bound
}
export const FOLDER_SIZE_SCAN_LIMIT = 200_000;
```

| Command | Args | Returns |
|---|---|---|
| `folder_size` | `{ id, bucket, prefix }` | `FolderSize`. A flat `ListObjectsV2` (no delimiter) under `prefix`, verbatim, page by page, stopping at the limit. `id` is chosen by the frontend; a newer call with the same `id` cancels the older one (`Cancelled`). |
| `cancel_folder_size` | `{ id }` | `void`. The running scan stops at its next page and the call above rejects with `Cancelled`. Unknown id: no-op. |

Backend rules:

- A listing is complete only when there is no continuation token; paging follows the same rules as
  every other listing (a repeated token, or "truncated" without a token, is an error, never a silent
  stop). The scan lists at most `FOLDER_SIZE_SCAN_LIMIT` keys (pages are requested no larger than what
  is left) and at most 2,000 pages; stopping at either bound with more pages left is `truncated: true`.
- At most 4 scans run at once; more wait for a slot (cancellable while waiting). Disconnecting or
  connecting elsewhere cancels every scan.
- `prefix` is sent exactly as given (no normalization); `""` is the whole bucket.

Frontend:

- Right-click a folder: **Calculate size**. Details panel with one folder selected: a **Size** row with a
  **Calculate** button. While scanning: a spinner and **Cancel**. Result: "1,234 objects · 5.6 GiB",
  prefixed "At least" when truncated, with the time it was calculated (and a Recalculate button).
- Results are cached per bucket + prefix for the session (cleared on disconnect) and dropped when
  anything under that prefix is uploaded, deleted, moved, copied, renamed or restored as a version (the
  `transfer:progress`, `batch:progress` and `job:progress` events, and the app's own version actions,
  tell the frontend): a cached size is cleared by changes made in this app. Changes made elsewhere
  (another client, a lifecycle rule) are not seen until the folder is recalculated.
- The file table's Size column shows the cached size for folders that have one (muted, "≥" when
  truncated), "—" otherwise.
- Details with several folders selected (and nothing else): one button calculates all of them (each its
  own scan, at most 4 at once), shown summed, "At least" when any is truncated.

IAM: none new (`s3:ListBucket` is already required).

### Bookmarks (added on request after v0.7.0)

Folders you go back to often, one click away. Frontend only: no new command, type or event.

```ts
/** A bookmarked folder. Frontend-only (localStorage), never sent to the backend. */
export interface Bookmark {
  bucket: string;
  prefix: string;   // verbatim from the server (as the pane had it), "" for a bucket root
  label: string;    // defaults to the folder name, or the bucket name at a root
}
export const BOOKMARKS_MAX = 100;   // per connection
```

- **Storage.** Per connection in `localStorage` under `s3x.bookmarks.<connection key>`, as a JSON array in
  the user's order. The key is the saved connection's id when connected through a saved connection;
  otherwise `<label>|<region>|<endpoint or "">` from `ConnectionInfo` (the label is `profile:<name>` or
  `static:<first 8 characters of the access key id>`; never a secret). After a window reload the app is
  reconnected without a saved id, so the saved id in use is also kept in `sessionStorage` and reused when the
  reconnected `ConnectionInfo` matches it. At most 100 per connection; a bookmark is identified by
  `bucket` + `prefix` (no duplicates). Reads and writes never throw; an unreadable or malformed entry is
  ignored. Deleting a saved connection also removes its bookmarks (`s3x.bookmarks.saved:<id>`); the key is `connectionKey()` (see "Integration decisions").
- **Prefixes are used verbatim** (see "Data safety"): the stored prefix is exactly the pane's prefix, and
  opening a bookmark navigates to exactly that prefix.
- **Path bar.** A star button at the end of the path bar toggles a bookmark for that pane's current folder
  (filled when bookmarked). Key action `nav.bookmark` "Bookmark this folder" (group Navigate, context
  `global`, default `Mod+Shift+D`) does the same for the active pane.
- **Bookmarks bar.** A slim row (30 px) directly under the toolbar, across the explorer (both panes),
  shown only when there is at least one bookmark. Each bookmark is a chip (bookmark icon + label, at most
  200 px wide, the full `s3://bucket/prefix` as tooltip), in the stored order. Click (or Enter) opens it in
  the active pane; middle-click or `Mod`+click opens it in the other pane while two panes are shown (in the
  active pane otherwise). Chips reorder by dragging within the bar. Right-click (or the context-menu key):
  Open, Open in other pane (only while two panes are shown), Rename bookmark (inline; an empty name restores
  the default label; `F2` on a chip too), Remove bookmark. The chip of the active pane's folder is marked.
- **Overflow.** Chips that do not fit go, in order, into a "»" button at the right end of the bar; it opens
  a menu listing them (click / middle-click / `Mod`+click and the same right-click menu as a chip; arrow
  keys move, Escape closes). Which chips fit is measured from their rendered widths whenever the bar or the
  labels change size, so every bookmark is always either a chip or in that menu.
- **Several windows.** Every change re-reads the list from storage before writing it, and a window follows
  the `storage` event for its connection's key, so two windows on one connection never drop each other's
  bookmarks.
- **Right-click menus.** A folder row in the file table, or a folder hit in search results: "Bookmark
  folder", or "Remove bookmark" when it already is one. With several items selected that include folders:
  "Bookmark N folders" adds every selected folder not yet bookmarked (disabled when all are), up to the
  cap (the toast says how many were added when the cap stops it). A bucket in the sidebar: "Bookmark
  bucket" / "Remove bookmark" for its root (`prefix: ""`). Every prefix is the listed one, verbatim.
- A bookmark whose bucket is gone or inaccessible shows the usual listing error when opened and stays in
  the list.

#### IAM permissions added in this version

None.

### Tabs (added on request after v0.7.0)

Several locations open at once in each pane. Frontend only; no new command, type or event.

- Each pane (see "Split view" and "State shape" in the v0.7.0 section) holds a list of **tabs** and an
  active tab. A tab owns what a pane owned in v0.7.0: bucket, prefix, listing, sort, selection, filter (the
  search box text), search results, history. Switching tabs restores all of it at once, with the table's
  scroll position, without a refetch, unless the cached listing is older than 60 s or something changed
  that folder while the tab was hidden; it is then refreshed in place in the background. A search or a
  listing still running when its tab is hidden stops (the search says it was cancelled; the listing loads
  again when the tab is shown).
- The **tab strip** sits above each pane's path bar and appears only when the pane has 2 or more tabs. Each
  tab: a folder icon, the folder name (the bucket name at a bucket root), a close button shown on hover and
  on the active tab; the full `s3://` path as tooltip. Middle-click closes. Tabs reorder by dragging within
  their pane (pointer events, like the saved-connection tiles). At most **20 tabs per pane**; asking for a
  21st shows a toast and opens nothing.
- **Dropping rows onto a tab** (either pane): rows dragged from a table highlight a tab they are over and,
  released there, go into that tab's folder exactly as a drop on a folder row or path-bar crumb does
  ("Drag and drop to move or copy"): `Ctrl` / `Option` copies, the same refusals, preview, confirmation
  setting and job, with the items captured when the drag started. The tab the rows were dragged from is no
  target (no highlight, nothing happens). Hovering a tab for **600 ms** during the drag shows it, so its
  file list (empty area or object rows) becomes a target too, including in the pane the drag started in;
  the drag keeps its captured items (and their storage classes, for the archived-object check).
- **Moving a tab to the other pane:** only while two panes are on screen. A tab dragged and released over
  the other pane's tab strip (at the position under the pointer) or, when that pane has one tab, its path
  bar (after its shown tab) moves there with its whole state (listing, selection, filter, search results,
  history, scroll) and is shown; the target is highlighted during the drag. Released on its own strip it
  only reorders. The last tab of a pane can't be dragged (its strip is hidden); a pane already at 20 tabs
  refuses with a toast. A search or listing running in the tab stops as when it is hidden.
- Key actions (in `src/lib/keys.ts`, group Navigate, context `global`; none of these defaults was taken):

  | Action id | Label | Defaults |
  |---|---|---|
  | `tab.new` | New tab (duplicates the current location) | `Mod+N` |
  | `tab.close` | Close tab | `Mod+W` (macOS `Mod+Shift+W`: Cmd+W closes the window) |
  | `tab.next` | Next tab | `Mod+Tab`, `Mod+PageDown` |
  | `tab.prev` | Previous tab | `Mod+Shift+Tab`, `Mod+PageUp` |
  | `tab.reopen` | Reopen closed tab | `Mod+Shift+T` |

  On macOS `Cmd+Tab` / `Cmd+Shift+Tab` belong to the system; `Cmd+PageDown` / `Cmd+PageUp` work there.
  Closing the last tab of a pane does nothing: the pane stays on its location (never an empty pane).
  A new tab opens right after the current one. "New tab" copies the location and its loaded listing, with
  no selection, filter, results or history behind it. "Reopen closed tab" brings back the last closed tabs
  (up to 20, this connection only) at their location, in the pane they were closed in when it is shown
  (else the active pane).
- Folder rows: the context menu of a single folder has **Open in new tab** (the new tab becomes the shown
  one); **middle-click** on a folder row opens it in a new tab in the background. Both use the folder's
  prefix verbatim. The same for buckets in the sidebar: middle-click opens the bucket's root in a new
  background tab of the active pane, and the bucket's menu has **Open in new tab** (shown at once). The
  20-tab cap applies (same toast). A pane with nothing open just opens the place instead of adding a tab.
- Open tabs are remembered **per connection** in `localStorage` (`s3x.tabs`: per connection, per pane, the
  tabs' bucket and prefix and which one is active; nothing else), and restored on reconnect (the second pane
  only when the split is on). The connection is identified by `connectionKey()` (the saved-connection id, else kind + profile or access key id + endpoint + region; see "Integration decisions"), never by its label alone,
  endpoint and region. Reads and writes never throw; malformed data is ignored.
- Everything that acts on "the active pane" acts on the active pane's shown tab. Transfers, jobs and their
  events keep working whichever tab is shown. A job, upload or new folder that changes a folder refreshes
  the shown tabs showing it at once and marks hidden tabs showing it for a refresh when they are shown (a
  hidden tab whose folder a move or delete took away goes to the nearest existing ancestor then, as a shown
  pane does). Search hits removed by a finished delete or move leave hidden tabs' results too. "Remove from
  list" of an added bucket closes the hidden tabs showing it.
- Closing the split drops the other pane's tabs; disconnecting resets every pane to one empty tab and forgets
  the closed-tab list (the remembered tabs stay in `localStorage`).

### Edit content type and metadata (added on request after v0.7.0)

S3 cannot change an object's headers in place; the app copies the object onto itself with the new headers.

```ts
interface MetadataEdit {
  bucket: string;
  key: string;                       // verbatim
  expectedEtag: string;              // the ETag the dialog showed; the copy is conditional on it
  expectedLastModified: string;      // the LastModified the dialog showed (ISO-8601, as in ObjectMeta); also a condition
  contentType: string;               // 1..=255 printable ASCII
  cacheControl: string | null;       // null = no Cache-Control header
  contentDisposition: string | null; // null = no Content-Disposition header
  metadata: Record<string, string>;  // user metadata, replaces the old set entirely
}
export const METADATA_LIMITS = { maxTotalBytes: 2048, maxKeyChars: 128 } as const;

// ObjectMeta gains (read by head_object, shown as "before" in the dialog):
cacheControl: string | null;
contentDisposition: string | null;
```

| Command | Args | Returns |
|---|---|---|
| `update_object_metadata` | `{ edit: MetadataEdit }` | `ObjectMeta` (fresh, after the copy). |

Rules:
- `HeadObject` first; its ETag must equal `expectedEtag` (compared without quotes) and its LastModified must equal
  `expectedLastModified` (to the second), otherwise `Conflict`. An unparsable `expectedLastModified` is `InvalidInput`.
- One `CopyObject` with the object as both source and destination (current version, copy source
  percent-encoded like the jobs), `MetadataDirective=REPLACE`, `CopySourceIfMatch=expectedEtag`,
  `CopySourceIfUnmodifiedSince=expectedLastModified`,
  `TaggingDirective=COPY`, keeping the storage class and the server-side encryption settings
  (`ServerSideEncryption`, `SSEKMSKeyId`, `BucketKeyEnabled`) read by that `HeadObject`. Headers the dialog
  does not edit but `REPLACE` would drop are carried over unchanged: `Content-Encoding`, `Content-Language`,
  `Expires`, `x-amz-website-redirect-location`. The copy is not cancellable and its timeout scales with the
  size like job copies. A response without a `CopyObjectResult` ETag is not a success.
- Afterwards `HeadObject` verifies the result; "no error" is not confirmation. Content type, Cache-Control,
  Content-Disposition and the user metadata must equal what was sent, the size and storage class must be
  unchanged, the ETag must equal the copy's, and the tag count must be unchanged when the server reports it.
  A mismatch is `Unknown` naming the field ("the edit was written but ..."); a failed read-back is
  `saved_but_unread` (keeps the code). The frontend then reloads the details and never says nothing changed.
- Refused with `InvalidInput` and a clear message, before anything is written: objects over 5 GiB
  (single-request copy limit), objects in GLACIER or DEEP_ARCHIVE whether restored or not (`NotSupported`: the
  copy would re-archive the data), Intelligent-Tiering archive tiers that are not restored, objects encrypted with a customer key
  (SSE-C), an `Expires` header that cannot be parsed back, metadata keys that are not lowercase HTTP token
  characters (regex ``^[a-z0-9!#$%&'*+.^_`|~-]+$``) or longer than 128 chars, empty metadata keys
  (empty values are allowed), values that are not printable ASCII
  (control characters, and non-ASCII, which S3 would store RFC 2047-encoded so the read-back could not match),
  values or header fields with leading or trailing spaces (HTTP trims them), more than 2 KiB of user metadata in
  total (keys + values in UTF-8 bytes, as S3 counts it), an empty content type, an empty string for
  Cache-Control or Content-Disposition (send `null`), and header fields that are not printable ASCII.
- If the object changed (the `HeadObject` check, or a 412 from either copy condition), the error is `Conflict`:
  the object changed since the dialog opened and nothing was written.
  Why both conditions: a single-part object's ETag is the MD5 of its body, so another client's metadata-only edit
  keeps the ETag and only LastModified reveals it. Limits, stated plainly rather than claimed airtight:
  - S3 compares LastModified at one-second resolution, so a change within the same second as the dialog's read
    can still slip through.
  - AWS evaluates the pair per RFC 7232: when `CopySourceIfMatch` holds, `CopySourceIfUnmodifiedSince` is ignored
    and the copy proceeds. On AWS the LastModified guard is therefore the backend's `HeadObject` check, which leaves
    the milliseconds between that `HeadObject` and the `CopyObject` unguarded for metadata-only changes. Body changes
    are always caught by `CopySourceIfMatch`.
- On a versioned bucket this creates a new version (the old one remains); the dialog says so. A restored
  archived object is written back to its archive storage class, so the new copy needs a new restore to be read;
  the dialog says so too. Object ACLs, Object Lock retention and legal holds are not carried over (ACL editing
  and object lock are out of scope).

Frontend: in the details panel's "More details", an **Edit** button next to the metadata opens a dialog:
Content type (text field with a datalist of common types), Cache-Control, Content-Disposition, and a
key/value list of user metadata (add, edit, remove rows), with inline validation mirroring the rules above
and a live byte counter (`n of 2,048 bytes`). Save shows a confirmation summarising what changes
(before → after for each changed field, byte-for-byte what will be sent), then runs; success refreshes the
details. Errors show in the dialog; `Conflict` offers to reload the current values.

IAM: `s3:GetObject` and `s3:PutObject` on the object, plus `s3:GetObjectTagging` and `s3:PutObjectTagging`
for `TaggingDirective=COPY`; with SSE-KMS, `kms:Decrypt` and `kms:GenerateDataKey` on the key.

### Object preview (added on request after v0.7.0)

See what is inside a file without downloading it.

```ts
type PreviewKind = "text" | "image" | "unsupported";
interface ObjectPreview {
  kind: PreviewKind;
  contentType: string | null;  // as stored in S3
  size: number;                // the object's full size
  truncated: boolean;          // text only: just the first PREVIEW_LIMITS.textMaxBytes were read
  text: string | null;         // kind "text": UTF-8, invalid sequences replaced
  dataBase64: string | null;   // kind "image": the whole object
  reason: string | null;       // kind "unsupported": a short user-facing reason
}
export const PREVIEW_LIMITS = { textMaxBytes: 262_144, imageMaxBytes: 10_485_760, imageAutoBytes: 2_097_152 } as const;
```

| Command | Args | Returns |
|---|---|---|
| `preview_object` | `{ bucket, key }` | `ObjectPreview`. HeadObject, then at most two ranged GetObject calls pinned to the ETag with `If-Match`. The key is sent verbatim. |

#### Backend

- **Kind**, from the key's extension (case-insensitive; the whole name for `Dockerfile`) and the content
  type (parameters ignored):
  - Images: extensions `png jpg jpeg gif webp bmp ico avif svg`, or the matching `image/*` content
    types. SVG is shown only through `<img>`, where scripts never run.
  - Text: content types `text/*`, `application/json`, `application/xml`, `application/x-yaml`, or
    extensions `txt md markdown json jsonl csv tsv log xml yaml yml toml ini conf cfg env sql sh bat ps1 py
    js mjs ts tsx jsx css scss html htm rs go java kt c h cpp cs rb php swift tf hcl properties gitignore
    dockerfile`. An image extension wins over a text content type and vice versa.
  - Anything else: the first 8 KiB are read; valid UTF-8 (a multi-byte character cut at the end of the
    sample is allowed) without NUL bytes is text, otherwise `unsupported` with reason "Binary file".
- **Text** reads a single ranged GET of the first `min(size, textMaxBytes)` bytes; `truncated` when the
  object is bigger. A character cut by the limit is dropped, not replaced. An empty object is text `""`
  without a GET.
- **Images** larger than `imageMaxBytes` are `unsupported` ("Too large to preview"); otherwise the
  whole object is read and returned base64-encoded.
- **Archived** objects (GLACIER / DEEP_ARCHIVE / Intelligent-Tiering archive tiers not restored, or a
  GET answered `InvalidObjectState`) are `unsupported` ("Archived: restore it to preview").
- A ranged response whose length or `Content-Range` does not match the request is an error, never a
  silently short preview. A body that stalls for 30 s is a `Network` error, and the whole read is bounded
  by the same size-scaled limit as a transfer request (60 s + 1 s per 32 KiB). An object that changed
  between HeadObject and GetObject (`PreconditionFailed`) is a `Conflict` error ("changed while it was
  read").

#### Frontend

- **Details panel**, one object selected: a "Preview" section at the top. Text and images up to
  `imageAutoBytes` load automatically; bigger images (up to `imageMaxBytes`) show "Load preview (n MiB)".
  A response for an object that is no longer selected is ignored. Errors show inline with Retry.
- **Rendering:** images fit the panel width, shown with `<img>` from a `blob:` URL created from the
  bytes and revoked when it changes (the CSP already allows `img-src blob:`; it is not loosened). JSON is
  pretty-printed when it parses. CSV/TSV render as a small table of the first 200 rows. Everything else
  is monospace text with soft wrap. "Showing the first 256 KiB" when `truncated`.
- **Quick look:** key action `act.preview`, label "Quick look", group Act, context `files`, default `F3`
  (F3 is in the always-prevented list, so the webview's find never opens). Opens a large modal with the
  same preview; `Escape` closes; `ArrowUp`/`ArrowDown` while it is open move the selection and the
  preview follows. Also in the object context menu. Not available for folders or several selected
  items. No PDF, video or audio in this version.

#### IAM permissions added in this version

None (`s3:GetObject` is already required).

### History (added on request after v0.7.0)

Finished transfers, folder transfers and file operations (jobs) are remembered across restarts.
Frontend only; no new commands.

```ts
type HistoryTransferKind = "download" | "upload" | "folderDownload" | "folderUpload";
type HistoryJobKind = "copy" | "move" | "rename" | "delete" | "tag" | "restore";

interface HistoryJob {
  srcBucket: string;
  srcPrefix: string;           // folder holding the chosen items (verbatim); "" = bucket root
  destBucket: string | null;   // copy / move / rename only
  destPrefix: string | null;   // folder the items went to (verbatim)
  items: number;               // items the user chose (keys or prefixes)
  first: string;               // the first chosen key or prefix (verbatim)
  firstTo: string | null;      // where it went (verbatim)
  objects: number;             // objects covered once folders were expanded (Job.totalItems)
  done: number; skipped: number; failed: number;
  firstError: string | null;   // "key: message" of the first per-object failure
  label: string;               // the backend's Job.label (shown when the request is not known)
}

interface HistoryEntry {
  connectionKey: string;       // connectionKey() of the connection it was recorded on; "" for older entries
  id: string;                  // the transfer, batch or job id
  kind: HistoryTransferKind | HistoryJobKind;
  status: "completed" | "failed" | "cancelled";
  bucket: string;              // a job's source bucket
  key: string;                 // object key, the prefix for folder transfers, a job's srcPrefix (verbatim)
  localPath: string;           // file or folder on this computer; "" for jobs
  bytes: number;               // bytes transferred / copied; 0 for delete, tag, restore (not meaningful)
  files: number;               // 1 for single transfers; done files / objects otherwise
  connection: string;          // display label of the connection it ran on
  finishedAt: string;          // ISO-8601
  error: string | null;        // the transfer's or job's error, else a job's firstError
  versionId?: string | null;   // set when a download fetched an older version of the object
  job?: HistoryJob | null;     // set exactly for the job kinds
}
```

- Recorded when a transfer, folder transfer or job reaches a final status (from the existing stores and
  events: `onTransferFinished` for single transfers, `onBatchUpdate` for batches, `onJobUpdate` for
  jobs; the per-file transfers of a batch are not recorded on their own). An entry with the same `id`
  replaces the older one. `bytes` is the transferred bytes (a batch's `doneBytes`, a copy or move job's
  `doneBytes`), `files` is a batch's `doneFiles` or a job's `doneItems`.
- A job's items come from the request it was started with (`jobRequest`, known for every job started in
  this session). A `move` of exactly one item whose destination is in the same bucket and the same
  folder as the source is recorded as `rename`. Every key and prefix is stored verbatim.
- Stored in `localStorage` `s3x.transferHistory` as one JSON array (transfers and jobs together),
  newest first, capped at 400 transfers and 100 jobs (separately, so a large multi-download cannot evict the jobs); reads and writes never throw (a corrupt or unavailable
  store reads as empty, malformed entries are dropped). No secrets, no file contents.
- `versionId` keeps "Download again" of a version download fetching that version, not the current object.

Frontend:
- The Activity panel gets two tabs: **Now** (what it showed before) and **History**. History lists
  entries newest first, virtualized, with: icon by kind, name, bucket path muted, size or count, when
  (relative, exact on hover), status. Filter chips **All**, **Transfers**, **File operations** and a
  search box (name, key, bucket, local path or a job's source / destination, case-insensitive) narrow it.
- Job rows read as a sentence per kind: "Moved 12 items to reports/2026/", "Copied a.txt to
  other-bucket/x/", "Deleted 3 items from images/", "Renamed a.txt to b.txt", "Tagged 4 items in docs/",
  "Requested restore of b.iso in archive/" (a job that failed or was cancelled uses the imperative:
  "Move 12 items to …"). The second line is the source → destination, or the error. The size column
  shows bytes for copy / move / rename, else the objects done, with failed or skipped counts below. The
  tooltip lists source, destination, counts, the first failure and the connection.
- Transfer row actions (buttons on hover and the right-click menu / menu key):
  - **Open file** / **Open folder** and **Show in folder** for completed downloads. Open goes through
    `open_local`, which only accepts finished downloads the backend still knows (this session); any
    refusal or a missing file is a calm info toast pointing at Show in folder. Open is hidden for the
    `OPEN_LOCAL_REFUSED_EXTENSIONS`. Show in folder uses `reveal_local`; failure is a calm toast.
  - **Go to object** (single transfers, uploads too: navigates to its folder and selects it) /
    **Go to folder** (folder transfers: opens the prefix). Disabled with "Other connection" when the
    bucket is not one of the current connection's buckets, as in the Now tab.
  - **Download again** / **Upload again** re-run the transfer through the existing commands with the
    usual confirmations: a single download asks for the save path (`start_download`, or
    `download_object_version` for a version), a single upload starts `start_upload` to the same key
    from the same local file (as a normal upload does), a folder download opens the folder-download
    confirmation into the original parent folder, a folder upload opens the folder-upload confirmation
    with the original local folder. Needs the bucket to be in the current connection.
  - **Copy key** (single transfers) / **Copy prefix** (folders), **Copy local path**, **Remove from history**.
- Job row actions: **Go to destination** (copy, move, rename: selects the object for a single object,
  else opens the destination folder), **Go to folder** (delete: the source folder) or **Go to object** /
  **Go to folder** (tag, restore: the source), disabled with "Other connection" as above;
  **Copy source path**, **Copy destination path** (copy, move, rename), **Copy first failure** (when
  there is one), **Remove from history**. Jobs are never offered again: a stale repeat of a delete or
  move is unsafe.
- **Clear history** in the panel bar asks for confirmation, then empties the store.
- Desktop notifications and the Now tab are unchanged.

### Bandwidth limit (added on request after v0.7.0)

Keeps transfers from filling the connection.

```ts
// AppSettings gains:
downloadLimitKibps: number | null;  // null = unlimited (default); else an integer 64..=1_048_576 KiB/s
uploadLimitKibps: number | null;    // same
export const BANDWIDTH_LIMITS = { minKibps: 64, maxKibps: 1_048_576 } as const;
```

- `update_settings` validates both fields strictly: each must be present, `null` or an integer in range;
  anything else is `InvalidInput` with a message starting with the field name. A `settings.json` without
  them (or with an invalid value) loads `null` for that field alone, like every other settings field.
- **One shared limiter per direction** across all transfers and folder transfers: a token bucket refilled
  continuously at the limit, with a burst of 256 KiB. Downloads take tokens for the bytes read from S3 (each
  body chunk as it arrives); uploads for the bytes sent (the request body is throttled as the HTTP client
  reads it, so an SDK retry of a part is throttled again). Waiters are served in arrival order, so parallel
  parts and transfers share the limit evenly. Server-side copies (jobs) are not limited.
- **Live:** changing either field applies to running transfers within a second, without restarting them.
  Setting `null` releases every waiter at once.
- **Never a hang:** waiting on the limiter is not a stall. The download body idle timeout (30 s) covers only
  the wait for the next chunk from the network, never the wait for tokens. While an upload limit is set, the
  upload attempt timeout is computed from the limit itself: base + part length × (the most requests the
  settings allow, 32 parts × 10 transfers) ÷ the limit in bytes per second, with no 6-hour cap in that case,
  so a limited healthy link never hits it at any part size; without a limit it assumes 32 KiB/s shared by the
  current parts × transfers, capped at 6 hours. A part already in flight when a limit is switched on keeps the timeout it was
  sent with. A waiter dropped before its bytes were allowed (cancel, pause, attempt timeout) refunds them,
  capped at one burst, so other transfers never pay for abandoned tickets.
- Live speed and ETA in Activity reflect the limited speed naturally (they are measured, not computed
  from the limit).
- **UI:** Settings → Transfers gets "Download speed limit" and "Upload speed limit", each an "Unlimited"
  switch plus a number field with a unit select (KiB/s, MiB/s), validated against the range; the impact
  summary mentions an active limit. The Activity bar shows a small "Limited to x MiB/s" note while a limit
  is active.

#### IAM permissions added in this version

None.

### Pause and resume transfers (added on request after v0.7.0)

- `TransferStatus` gains `"paused"`. `BatchStatus` gains `"paused"` too (a folder transfer paused as a whole).
- `paused` counts as active everywhere "active" is used: `remove_transfer` / `remove_batch` refuse it, the
  updater refuses to install while one exists, and `disconnect` with `cancelActive` cancels it.

| Command | Args | Returns |
|---|---|---|
| `pause_transfer` | `{ id }` | `void`. A running or queued download or upload stops moving data and becomes `paused`. `InvalidInput` for an unknown id or a finished transfer; no-op if already paused. |
| `resume_transfer` | `{ id }` | `void`. A paused transfer goes back to the queue (`queued`), keeping its place behind transfers that were queued before it was paused. No-op unless paused (`InvalidInput` for an unknown id). |
| `pause_batch` | `{ id }` | `void`. Pauses every queued or running file of the folder transfer and stops starting new ones (files it starts from now on start `paused`); the batch becomes `paused` (one still `planning` keeps planning and becomes `paused` when it would become `queued`). `InvalidInput` for an unknown id or a finished batch; no-op if already paused. |
| `resume_batch` | `{ id }` | `void`. Resumes the batch's paused files and goes back to `queued` (then `running` as soon as one of its files runs again). No-op unless paused. |

Behaviour:
- Pausing cancels the in-flight part requests. Parts already written stay: downloads keep the temp file and the
  record of finished parts (in memory); uploads keep the multipart upload id and the finished parts. Progress
  shown (`transferredBytes`, `partsDone`) stays at the bytes of finished parts; `bytesPerSec` is 0 while paused.
  A transfer in a step that cannot be interrupted (CreateMultipartUpload, CompleteMultipartUpload, the final
  flush and rename) finishes that step first; if it was the last step the transfer simply completes.
- Resuming a download continues with the missing parts only, with `If-Match` on the ETag captured at start: if
  the object changed meanwhile, the transfer fails with the usual message and the temp file is removed. (A server
  that returned no ETag gets a HeadObject on resume instead; a different size or Last-Modified fails it the same
  way.) A folder download re-checks its destination for links on resume. A small file fetched with one GET starts
  over.
- Resuming an upload continues the same multipart upload with the missing parts; the local file's size and
  modified time are re-checked first and a change fails the transfer (and aborts the multipart upload). A small
  file sent with one PutObject is sent again.
- A paused transfer does not count toward the simultaneous-transfers limit (it gives its run slot back).
- Cancel works on a paused transfer or batch (download: temp file removed; upload: multipart upload aborted).
  The destination of a paused download stays reserved (no second download to the same file).
- Paused state lives in memory only. On app exit, every active transfer, folder transfer and job (running, queued
  or paused) is cancelled like a cancel (uploads aborted, downloads' temp files removed), waiting at most 10 s. Resume across restarts is out of scope.
- Events: `transfer:progress` / `batch:progress` carry the new status; payloads are otherwise unchanged.

Frontend: a Pause / Resume button next to Cancel on each transfer row and folder-transfer row in Activity, also
in its right-click menu; "Paused" status with the progress bar dimmed; a "Pause all" / "Resume all" button in the
Activity bar when relevant (it applies to single transfers and folder transfers, not to a batch's own files
individually). Keyboard: none new.

#### IAM permissions added in this version

None (pausing and resuming use the same calls as a transfer).


### Update popup

Users did not notice new versions: the startup check was off by default and, when on, only raised a
toast. From v0.8.0:

- `checkUpdatesOnStartup` **defaults to true** for new installs (backend default and
  `DEFAULT_APP_SETTINGS`). A `settings.json` that lacks the field loads `true`; one that says `false`
  is respected, so existing settings keep their value. The
  Updates tab's switch is unchanged.
- At launch everything about versions goes into **one dialog** (`.version-modal`, `UpdateDialog.tsx`).
  When the silent startup check finds a newer version it holds the **update offer**: the running version, the new version, its release notes (the
  `notes` markdown from `UpdateInfo`, rendered by the same safe `Markdown`), and the same card as
  Settings → Updates, with **Later** and **Install and restart** (or **Open download page** when
  `canInstall` is false; the running-transfers warning stays in the card).
  - Later closes it and remembers that version (`localStorage` `s3x.updateLaterVersion`): the popup
    opens again only for a newer version. While the popup is dismissed a pill in the title bar
    (explorer and start screen) reads "vX.Y.Z available" and reopens it.
  - Esc and the backdrop close it, except while an install is in progress.
- **What's new after an update.** `CHANGELOG.md` is bundled into the frontend at build time
  (`import ... from "../../CHANGELOG.md?raw"`, `src/lib/changelog.ts`). At every launch the frontend
  compares the running version (`app_version`) with `localStorage` `s3x.seenVersion`: a fresh install
  (no `s3x.*` preference at all) only records it; a launch without it but with other `s3x.*`
  preferences (an upgrade from a version that did not record it), or on a different version, records it and opens **What's new in vX**
  with that version's `## [X.Y.Z]` section. No section, no dialog. If the startup check then finds an
  update, the dialog shows the update offer instead (a newer version's notes matter more than the
  running one's); the two are never shown together.
- Nothing is ever installed without the user clicking Install; the backend commands are unchanged.

Consequence for releases: the `## [X.Y.Z]` section of `CHANGELOG.md` is what users read in the app,
before and after updating. Every tag must come with one that explains each change (see
`.claude/rules/versioning.md`).

### Search row

The search box leaves the toolbar's right group and gets its **own row** between the toolbar and the
panes' path bars (`SearchRow` in `Toolbar.tsx`, `.search-row`), full width, with the scope control
("This folder" / "Whole bucket") at its right. In split view the row spans both panes and, as before,
acts on the active pane. The toolbar's right group keeps the clipboard chip, the split toggle and the
details toggle.

The placeholder names the scope ("Search this folder · as you type, Enter searches now"). While the
box has text and the focus, a dismissable hint under it says what is being searched: this folder only
(and that **Whole bucket** on the right searches everything) or the whole bucket, that results come
half a second after typing stops, and that Enter searches right away. Dismissing it is remembered
(`localStorage` `s3x.searchTypingHintDismissed`), like the syntax hint shown while the box is empty.
Search behaviour itself is unchanged.

#### IAM permissions added in this version

None.

### Integration decisions (orchestrator, after review of the ten PRs)

- `AppSettings` gains `previewAutomatically: boolean` (default `true`; `update_settings` requires it; a
  `settings.json` without it loads `true`). When `false`, selecting a file shows a **Preview** button in the
  details panel instead of fetching; Quick look (`F3`) always fetches. Settings → Behavior holds the toggle
  "Preview files automatically" with the note that each preview is a HEAD plus a bounded GET.
- The hidden game from PR #4 has no developer keys in any build; a cheat code typed during the game
  (`iddqd`, letters in sequence within 2 s) toggles god mode with an on-screen notice, and a run with god
  mode on never records a best score.
- Persisted per-connection state (tabs, bookmarks, history) is keyed by one `connectionKey()`: the saved
  connection id, else kind + profile or access key id + endpoint + region; never the display label alone.
  Deleting a saved connection forgets all three.
- Every action the PRs add is registered in the keyboard registry (bound or unbound) so it appears in
  Settings → Keyboard and the cheat sheet; the defaults table is extended with the final rows.
- "Later" on the update popup is remembered per version; the details panel stays hidden until a bucket
  is open; folder sizes are "cleared by changes made in this app", not "never stale".

## v0.9.0 additions — Commander mode (issue #13)

Four requests from issue #13 (five new action ids): Total Commander keybindings as the default without changing existing users'
bindings; a pane that shows the local computer so copy = download and move = download + delete; an
editable path; and syncing the other pane to this one.

### Keybinding presets

A **preset** is a complete default map (every action id → chords). Two presets ship:

| Preset id | Meaning |
|---|---|
| `commander` | Total Commander layout: `F5` / `F6` copy / move to the other pane, `Shift+F6` rename, `F2` refresh (`Mod+R` too), `Alt+F7` focus search (plus `Mod+F`, `/`), `Alt+Shift+T` tags, `Alt+Shift+L` folder size, `Mod+T` and `Mod+N` new tab, `Alt+F1` / `Alt+F2` choose the left / right pane's source (new, below), `Mod+L` edit path (new), `Mod+Shift+ArrowRight` / `Mod+Shift+ArrowLeft` sync the other pane (new). Everything else as in `classic`. The exact map is the file attached to issue #13 plus the four new actions; it lives in `src/lib/keys.ts` as `PRESETS.commander` and is the source of truth. |
| `classic` | The v0.7.0/v0.8.0 defaults exactly as they are today (`F5` refresh, `F2` rename, `Mod+Shift+C/X` copy/move to the other pane, …) plus the four new actions on the same chords as `commander` where free (`Mod+L`, `Mod+Shift+ArrowLeft/Right`, `Alt+F1`/`Alt+F2`). |

```ts
// AppSettings (v0.9.0)
keybindingsPreset: "commander" | "classic";   // the default map that `keybindings` overrides apply to
```

- `DEFAULT_APP_SETTINGS.keybindingsPreset` is `"commander"`: **new installs get Total Commander keys.**
- **A `settings.json` without the field loads `"classic"`**, and so does a **missing** `settings.json` when the
  app's config directory already holds any other file (`connections.json`, `added-buckets.json`, …): that is an
  existing install that never saved settings. Only a truly fresh install (empty or absent config directory)
  gets `commander`. That is the whole upgrade story: an existing
  user's effective bindings do not change by one key, and their `keybindings` overrides keep meaning what
  they meant. `update_settings` requires the field (strict), like every other field.
- **There is no preset control in the UI, and there is only one default map: Total Commander** (user
  decisions 2026-10-14). The field is a one-time **migration marker**: when the frontend loads settings with
  `keybindingsPreset: "classic"` (an upgraded install), it computes that user's effective map (classic
  defaults + their overrides), writes it back as explicit `keybindings` overrides against the Commander
  defaults (existing overrides win; actions equal to the Commander default are not stored), saves with
  `keybindingsPreset: "commander"`, and shows a one-time toast "Your keyboard shortcuts were kept. Reset all in
  Settings → Keyboard switches to the Total Commander layout." After that `classic` never appears again.
  Settings → Keyboard shows the actions, the chords and Record / Reset / Reset all / Export / Import as before;
  **"Reset all" returns to the Total Commander defaults for everyone**. Export writes `preset: "commander"`;
  importing a file with `preset: "classic"` converts it the same way. The cheat sheet and tooltips follow the
  effective map as before.
- Export files gain `"preset": "commander" | "classic"`; import applies the preset and then the
  bindings. A file without `preset` (v0.8.0 export) imports as full explicit bindings, as today.
- The always-prevented webview keys (F5, Ctrl+R, …) stay prevented in both presets.

### Pane sources: S3 or the local computer

A pane shows one **source**: this connection's S3 (a bucket and prefix, as today) or **the local
computer** (a directory). Everything that worked on an S3 pane keeps working; a local pane adds a
Commander-style view of the disk, and transfers between the two panes are the existing downloads and
uploads.

```ts
type PaneSource = { kind: "s3" } | { kind: "local" };
interface LocalRoot { path: string; label: string; kind: "drive" | "home" | "folder" }   // C:\, D:\, Home… ("folder" = a mount under /media, /mnt, /Volumes)
interface LocalEntry {
  name: string;
  path: string;              // absolute, as the OS returns it
  isDir: boolean;
  size: number;              // 0 for directories
  modified: string | null;   // RFC 3339
  isSymlink: boolean;        // the entry itself is a symlink/junction (shown, never followed)
  hidden: boolean;           // dotfile or hidden attribute
}
interface LocalListing { dirs: LocalEntry[]; files: LocalEntry[]; truncated: boolean; parent: string | null }
```

| Command | Args | Returns |
|---|---|---|
| `list_local_roots` | `{}` | `LocalRoot[]`: on Windows every ready drive letter plus the user's home; on macOS/Linux `/`, `/Volumes` or `/media`, `/mnt` mounts that exist, and the home. |
| `list_local_dir` | `{ path, showHidden }` | `LocalListing`, sorted by name, **capped at 50,000 entries** (`truncated: true` past that), never following symlinks, `InvalidInput` for a relative path, `Io` with the OS message when unreadable (permissions, missing). `parent` is the parent directory or null at a root. |
| `create_local_dir` | `{ parent, name }` | `void`. Name sanitized with the same rules as download file names; refuses an existing name. |
| `rename_local` | `{ path, newName }` | `void`. Same directory only; refuses an existing target; never replaces. |
| `trash_local` | `{ paths: string[] }` | `{ trashed: number; failed: { path: string; message: string }[] }`. Moves to the OS recycle bin / trash (the `trash` crate), **never a permanent delete**: on Windows the volume is determined from the **canonical** parent (junctions and mount points resolved), must be a fixed local disk with a recycle bin that is enabled (no "remove immediately" setting) and large enough for the item, otherwise the path is reported as failed and left in place; a symlink is trashed as the link, never its target. At most 10,000 paths per call. |
| `local_dir_size` | `{ path, scanId }` | `{ files, bytes, truncated }`, bounded like folder size (200,000 entries), never follows symlinks, holds at most one directory handle at a time (pending directories are kept as paths). A newer call with the same `scanId` cancels the older one, and `cancel_folder_size { id }` cancels a local scan too. |

- **Choosing a source:** `Alt+F1` (left pane) / `Alt+F2` (right pane), the pane's path-bar menu, and the
  sidebar's new "This computer" group (the local roots, discreet: one collapsible group under the buckets)
  open a source menu listing the connection's buckets and the local roots. Picking a local root turns the
  pane into a local pane at that root; picking a bucket turns it back into an S3 pane. In single-pane
  view `Alt+F1` acts on the one pane and `Alt+F2` opens the split with a local pane on the right.
- **Local pane UI:** the same table (Name, Size, Modified; no storage class), the same selection and
  keyboard rules, folders first, a hidden-files toggle in the path bar (per session), `Enter`/`Backspace`
  navigate, the path bar shows the directory, "Open in file manager" uses the existing `reveal_local`
  rule for directories, "Open" on a file uses `open_local` **extended to accept any file the user
  browsed to in a local pane** (same extension refusal list, same link rule). Right-click: Open, Show in
  folder, New folder, Rename, Delete (to recycle bin, with the usual confirmation listing exact paths),
  Calculate size, Copy path. Search, tags, versions, lifecycle, metadata and preview are S3-only and are
  disabled with a reason on a local pane (preview of local files is out of scope for v0.9.0).
- **Transfers between panes** (toolbar Copy/Move to other pane, `F5`/`F6` in `commander`, drag and drop,
  context menu), by pane kinds:
  - S3 → local **copy**: `start_download` per object / `start_batch` download per folder into the local
    pane's directory (the existing conflict preview, name sanitizing, link rules). **Move**: the same,
    then one delete job for **exactly the object keys whose download completed** (single transfers by
    key; for a folder batch, the keys of its per-file transfers that ended `completed`, never the prefix
    itself, so an object added under the folder after the move was planned is never deleted and folder
    markers are left in place). Each item carries the **ETag the download was pinned to** (`JobItem.etag`), and the delete job deletes
    conditionally (If-Match, the same mechanism the S3→S3 move uses): an object rewritten during the move is
    left in place and reported as "changed on S3, not deleted". The existing `delete` job runs it with no
    extra confirmation beyond the move's own, which lists the items and says they will be deleted from S3
    after download. Anything that failed, was cancelled
    or was skipped is **not** deleted. Closing the app mid-way deletes nothing.
  - local → S3 **copy**: `start_upload` per file / `start_batch` upload per folder to the S3 pane's
    bucket + prefix (existing conflict preview). **Move**: the same, then `trash_local` for exactly the
    **files** whose transfer ended `completed` (single files by path; for a folder batch, the local paths of its
    per-file transfers that ended `completed`, never the folder itself, so entries the planner skipped, links,
    and files created after planning stay where they are; emptied folders are left in place). To the recycle
    bin; the confirmation says so.
  - local → local: copy/move on disk are **out of scope** (use the OS); the actions are disabled with that
    reason. S3 → S3 is unchanged.
  - The source selection and the destination directory/prefix are captured when the action starts; the
    post-completion delete uses exactly the captured items that completed, matched by transfer id.
- **Data safety for local panes:** every path shown is sent back verbatim; `trash_local` never bypasses
  the recycle bin; symlinks and junctions are listed with a link badge and refused as sources of a move
  (copy works, as a file); listings are bounded; a local pane never lists outside the roots the OS exposes
  (no UNC or device paths typed by hand: `InvalidInput`).
- **Keyboard:** `source.pickLeft` (`Alt+F1`), `source.pickRight` (`Alt+F2`), `local.toggleHidden`
  (`Mod+.`), everything else reuses existing actions on the local pane (`act.delete` = trash,
  `act.newFolder`, `act.rename`, `act.folderSize`, `act.copyToOther`, `act.moveToOther`).
- **History** records local transfers like any transfer (they already are transfers); the per-connection
  key applies to the S3 side.

### Edit path

`nav.editPath` (`Mod+L` in both presets) turns the active pane's path bar into a text field holding the
current location (`s3://bucket/prefix/` for S3 panes, the directory for local panes). `Enter` navigates:
an `s3://` address switches bucket if needed (same rules as the search box's `s3://` paste); a bare prefix
is relative to the current bucket; an absolute local path turns the pane into a local pane at that
directory (or its parent, selecting the file, when it is a file); a non-existent target shows the error
inline and keeps the field open. `Esc` cancels. Clicking the path bar's empty area also opens it.

### Sync the other pane

`nav.syncOther` (`Mod+Shift+ArrowRight` when the active pane is the left one, `Mod+Shift+ArrowLeft` when
it is the right one; both chords are bound to the one action, which always targets the other pane) makes
the other pane show the active pane's source and location (bucket + prefix, or local directory). It opens
the split if needed. Nothing is selected in the target pane afterwards.

### Window icon follows the accent

The logo drawn in the app takes the accent colour, but the window and taskbar icon was always the yellow
installed icon. From v0.9.0 the running window's icon matches the accent:

| Command | Args | Returns |
|---|---|---|
| `set_window_icon` | `{ accent: AccentColor }` | `void`. Sets the main window's icon (both the title-bar and the taskbar/Alt-Tab sizes) to the bundled icon for that accent. Icons are bundled in the executable (`src-tauri/icons/accent/<accent>-32.png` and `<accent>-256.png`, rendered from the app's logo with the same gradient the UI uses), so no file access and no network. `InvalidInput` for an unknown accent. |

- The frontend calls it once after settings load and whenever the accent setting changes (also in the
  Settings dialog's live preview, reverting on cancel). The mock ignores it.
- The icon of a pinned taskbar or Start-menu shortcut comes from the installer and stays yellow; only the
  running window (title bar, taskbar button, Alt-Tab) follows the accent. The changelog says so.

### Command line: open the app at a location

```
s3explorer [--connection <saved connection name>] [<location>]
s3explorer --help
```

`<location>` is an absolute local path (a directory, or a file: its directory with the file selected) or an
`s3://bucket[/prefix]` address. Relative paths are resolved against the current directory of the shell that
launched the app. UNC and device paths are refused like everywhere else.

```ts
interface LaunchRequest {
  connection: string | null;                 // --connection value, verbatim
  local: string | null;                      // absolute local path (file or directory), as given after resolving
  s3: { bucket: string; prefix: string } | null;
  raw: string[];                             // the arguments after the executable, for the error message
}
```

| Command | Args | Returns |
|---|---|---|
| `take_launch_request` | `{}` | `LaunchRequest \| null`. The request parsed from the process arguments, returned once (later calls return null). Parse errors (unknown option, two locations, a malformed `s3://`) are `InvalidInput` with the usage text. |

| Event | Payload |
|---|---|
| `launch:open` | `LaunchRequest`. Emitted when a second launch of the app hands its arguments to the running instance (single-instance behaviour: the second process exits at once; the running window is shown and focused). |

- **Single instance.** The app uses the single-instance plugin: launching `s3explorer <location>` while the
  app runs does not open a second window; the running instance receives `launch:open`.
- **Frontend behaviour.** On start, after settings load, the frontend calls `take_launch_request`. With a
  request: if a connection is open, apply it; else pick the saved connection named by `--connection`
  (exact name, case-insensitive) or, without it, the most recently used saved connection; connect with it
  (secret from the keychain, no prompt), then apply. With no saved connection the connect screen shows a
  note "Connect to open <location>" and applies the request after the user connects. Applying: an `s3`
  location opens the bucket and prefix in the active pane (a bucket not in the list is added as a shared
  bucket by name, same rules as the "+" button; failure toasts); a `local` location opens a local pane
  (the active pane in single view; in split view the pane that is not showing S3, else the right pane),
  selecting the file when a file was given. `launch:open` applies the same way at any time.
- `--help` prints the usage to stdout and exits 0 (visible when run from a terminal); an invalid command
  line prints the usage and exits 2 before any window opens.

### Source menu type-ahead

In the `Alt+F1` / `Alt+F2` source menu, typing selects: the typed prefix (same rules as type-to-jump) moves the
highlight to the first entry whose label starts with it (a drive letter like `d` selects `D:\`; `ac` selects the
first bucket starting with "ac"); `Enter` opens it, `Escape` closes. The same applies to the path-bar source menu.

### Dialog default buttons

Confirmation dialogs for copy, move, folder transfers and cross-pane transfers focus their **action** button
(Copy / Move / Download / Upload) when they open, so `Enter` confirms; `Escape` cancels. The delete and
recycle-bin confirmations keep focusing **Cancel** (deleting must never be one accidental `Enter` away).

### Performance budget

Interactions must feel instant on the dev build: switching panes (`Tab`), tabs (`Mod+Tab`) and rows (arrows) run
no more than one render of the components that actually change (the two pane shells, the two tables' rows that
gained or lost focus) and under 16 ms of main-thread work in the mock at 10,000 rows; a keydown that is not
bound costs no store writes and no DOM queries beyond the focused element. Transfer progress events never
render tables, path bars, tab strips or the sidebar. Measured with the browser harness (CDP Performance
profile) and asserted in the suite.

Settled by the v0.9.0 performance pass (behaviour changes that follow from the budget):

- **Newest files** renders at most 40 rows and a "Show more (N more)" row; it keeps showing the last S3
  bucket's list while a local pane is active (reset on a connection change or when that bucket is removed).
- **The details column stays mounted** when the active pane is local, with the body "Details are for S3
  panes", so switching panes never relayouts the workspace or restarts metadata reads.
- **No transitions on pane switch**: the inactive pane is dimmed statically; breadcrumbs have no hover
  transition.
- Rows are sorted once per listing and sort key (dates parsed once, names lower-cased once) and filtered
  afterwards; `getSelected`, selection summaries and the filter prune loop over the selection, not the rows.

### Scope note

The local pane makes "dragging objects out of the app" partly unnecessary (copy to a local pane instead);
it stays out of scope as a drag target. Sync (two-way mirroring) stays out of scope: `nav.syncOther` only
navigates.

### IAM permissions added in this version

None. Moves from S3 to local use `DeleteObject(s)` after download, which the Delete row already covers.

## v0.9.1 additions — network locations, taskbar icon

### Network locations in a local pane

A local pane can show a Windows network location: a UNC path (`\\server\share\folder`), a mapped network
drive, or one of the user's saved **Network Locations** (the shortcuts Windows keeps under "This PC").

- **Path rules change.** `\\server\share[\…]` (and the `//server/share` spelling) is now an accepted absolute
  path in every local command and in the edit-path field and the command line. Device paths (`\\.\`,
  `\\?\`), `\\server` without a share, and `..` components stay `InvalidInput`.
- **`list_local_roots`** gains, after the drives: the saved Network Locations (Windows: the entries of
  `%APPDATA%\Microsoft\Windows\Network Shortcuts`, each resolved from its `target.lnk` to its UNC target;
  unresolvable ones skipped) with `kind: "network"` and the shortcut's name as label; mapped drives stay
  drives but their label shows the UNC they map to (`Z: (\\nas\data)`). On macOS/Linux, mounted network
  shares already appear as `"folder"` roots; nothing changes.
- **Listing** a network location works like any directory, with one more bound: a listing or folder-size
  scan on a UNC path that makes no progress for 15 s fails with `Io` ("network location did not respond")
  instead of hanging the pane; the same bound applies to resolving a Network Location shortcut.
- **Recycle bin:** network locations have none. `trash_local` refuses every UNC path (per-path failure
  "no recycle bin on a network location; delete it in the file manager"), so nothing on a share is ever
  deleted by this app. Moves *from* a share to S3 therefore upload only (the confirmation says the files
  stay on the share); moves *to* a share from S3 delete from S3 as usual.
- **Open / Show in folder / Calculate size / New folder / Rename** work on shares. `open_local`'s
  browsed-file rule applies unchanged.
- **UI:** the source menu (`Alt+F1`/`F2`) and the sidebar's "This computer" group list the network
  locations after the drives with a network icon; the edit-path field and the command line accept a
  typed `\\server\share\…`; a network path in the path bar shows a network icon in its first crumb.

```ts
// LocalRoot.kind (v0.9.1)
kind: "drive" | "home" | "folder" | "network";
```

### Taskbar icon follows the accent (bug)

`set_window_icon` changed the title-bar icon but the taskbar button kept the installed icon. On Windows the
command now sets the window's small and big icons (`WM_SETICON`), **and the window class icons**
(`GCLP_HICON`, `GCLP_HICONSM`), and notifies the shell so the taskbar button repaints; the previous
accent's icons are destroyed after the swap. The startup icon is applied from the saved accent before the
window is shown, so the taskbar never shows the installed icon first when the accent is not yellow. A pinned
taskbar or Start-menu shortcut still shows the installer's icon (that is Windows reading the shortcut).

**v0.9.2:** the installed build sets an AppUserModelID (needed since v0.4.0 for the taskbar icon), and with an
ID the taskbar takes the running button's icon from the matching Start-menu shortcut, not from the window, so
the v0.9.1 fix only worked in dev builds. `set_window_icon` now also writes the accent's icon as an `.ico` file
(PNG-in-ICO, 32 and 256 px) under the app's config directory (`icons\<accent>.ico`) and sets the main
window's property store: `System.AppUserModel.RelaunchIconResource` = that file (`"<path>,0"`),
`System.AppUserModel.RelaunchCommand` = the executable's path, `System.AppUserModel.RelaunchDisplayNameResource`
= "S3 Explorer" (Windows requires the three together). The taskbar uses the relaunch icon for the running
button of an app grouped by ID. This is done at startup (before the window shows) and on every accent change,
after the window and class icons. A shortcut pinned to the taskbar keeps the icon it was pinned with; the app
never edits shortcuts.

**Verified 2026-10-19:** the relaunch properties alone do not change the running button; what does is giving the
*window* its own `System.AppUserModel.ID` = `<identifier>.<accent>` (the process keeps the plain identifier for
notifications), set before the window is shown and on every accent change, before the icons. With that, the
button shows the saved accent at start and switches live; no hide/show of the window is needed. Tested with the
taskbar screenshot procedure in the `smoke-test` skill.

### IAM permissions added in this version

None.
