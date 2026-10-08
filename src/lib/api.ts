// The single gateway between the UI and the backend.
// Inside Tauri every call goes through `invoke` / `listen`; in a plain browser
// (`npm run dev`) everything is routed to the in-memory mock in `./mock.ts`.

import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { join } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow, LogicalSize, type PhysicalSize } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  BATCH_PROGRESS_EVENT,
  JOB_PROGRESS_EVENT,
  TRANSFER_PROGRESS_EVENT,
  UPDATE_PROGRESS_EVENT,
  type AddedBucket,
  type AppError,
  type AppSettings,
  type Batch,
  type BatchPlanRequest,
  type BatchPreview,
  type Bucket,
  type BucketVersioning,
  type ConnectionConfig,
  type ConnectionInfo,
  type ErrorCode,
  type Job,
  type JobPreview,
  type JobRequest,
  type LifecycleConfiguration,
  type LifecycleIssue,
  type ListPage,
  type ObjectEntry,
  type ObjectMeta,
  type ProfileInfo,
  type RecentListing,
  type RestoreRequest,
  type SaveConnectionInput,
  type SavedConnection,
  type Tag,
  type Transfer,
  type UpdateInfo,
  type UpdateProgress,
  type VersionListing,
} from "./types";

export type Unlisten = () => void;

/** OS file drag & drop, normalized from the Tauri webview drag-drop event. */
export type FileDropEvent =
  | { type: "enter"; paths: string[] }
  | { type: "over" }
  | { type: "drop"; paths: string[] }
  | { type: "leave" };

/** The window's size when the app starts (mirrors `app.windows[0]` in src-tauri/tauri.conf.json). */
const DEFAULT_WINDOW = { width: 1280, height: 820 };
/** How the window was before `lockWindowSize(true)`, to restore it on unlock. */
let windowBeforeLock: { maximized: boolean; fullscreen: boolean; size: PhysicalSize } | null = null;

export interface Backend {
  listProfiles(): Promise<ProfileInfo[]>;
  connect(config: ConnectionConfig): Promise<ConnectionInfo>;
  /** `cancelActive`: cancel every queued or running transfer, batch and job first. */
  disconnect(cancelActive: boolean): Promise<void>;
  connectionStatus(): Promise<ConnectionInfo | null>;
  listBuckets(): Promise<Bucket[]>;
  listObjects(bucket: string, prefix: string, continuationToken?: string | null, pageSize?: number): Promise<ListPage>;
  listRecent(bucket: string, prefix: string): Promise<RecentListing>;
  headObject(bucket: string, key: string): Promise<ObjectMeta>;
  createFolder(bucket: string, prefix: string): Promise<void>;
  // Shared buckets (added by name)
  listAddedBuckets(): Promise<AddedBucket[]>;
  addBucket(input: string): Promise<AddedBucket>;
  removeAddedBucket(name: string): Promise<void>;
  // Tags
  getBucketTags(bucket: string): Promise<Tag[]>;
  putBucketTags(bucket: string, tags: Tag[], expected: Tag[]): Promise<Tag[]>;
  getObjectTags(bucket: string, key: string): Promise<Tag[]>;
  putObjectTags(bucket: string, key: string, tags: Tag[], expected: Tag[]): Promise<Tag[]>;
  // Lifecycle configuration
  getLifecycle(bucket: string): Promise<LifecycleConfiguration | null>;
  validateLifecycle(config: LifecycleConfiguration): Promise<LifecycleIssue[]>;
  putLifecycle(bucket: string, config: LifecycleConfiguration, expected: LifecycleConfiguration | null): Promise<LifecycleConfiguration | null>;
  getBucketVersioning(bucket: string): Promise<BucketVersioning>;
  // Object operations (jobs)
  previewJob(request: JobRequest): Promise<JobPreview>;
  startJob(request: JobRequest): Promise<string>;
  cancelJob(id: string): Promise<void>;
  removeJob(id: string): Promise<void>;
  listJobs(): Promise<Job[]>;
  onJobProgress(cb: (j: Job) => void): Promise<Unlisten>;
  // Folder transfers (batches)
  /** `previewId`: a newer preview with the same id cancels the one still running (it rejects `Cancelled`). */
  previewBatch(request: BatchPlanRequest, previewId?: string): Promise<BatchPreview>;
  startBatch(request: BatchPlanRequest): Promise<string>;
  cancelBatch(id: string): Promise<void>;
  removeBatch(id: string): Promise<void>;
  listBatches(): Promise<Batch[]>;
  onBatchProgress(cb: (b: Batch) => void): Promise<Unlisten>;
  // Object versions
  listObjectVersions(bucket: string, key: string): Promise<VersionListing>;
  downloadObjectVersion(bucket: string, key: string, versionId: string, destPath: string): Promise<string>;
  restoreObjectVersion(bucket: string, key: string, versionId: string): Promise<ObjectEntry>;
  deleteObjectVersion(bucket: string, key: string, versionId: string): Promise<void>;
  // Archived objects
  restoreObject(bucket: string, key: string, request: RestoreRequest): Promise<void>;
  startDownload(bucket: string, key: string, destPath: string): Promise<string>;
  startUpload(bucket: string, key: string, srcPath: string): Promise<string>;
  cancelTransfer(id: string): Promise<void>;
  removeTransfer(id: string): Promise<void>;
  listTransfers(): Promise<Transfer[]>;
  onTransferProgress(cb: (t: Transfer) => void): Promise<Unlisten>;
  getSettings(): Promise<AppSettings>;
  updateSettings(settings: AppSettings): Promise<AppSettings>;
  // Saved connections
  listSavedConnections(): Promise<SavedConnection[]>;
  saveConnection(input: SaveConnectionInput): Promise<SavedConnection>;
  deleteSavedConnection(id: string): Promise<void>;
  connectSaved(id: string): Promise<ConnectionInfo>;
  // Updates
  checkForUpdate(): Promise<UpdateInfo>;
  installUpdate(): Promise<void>;
  onUpdateProgress(cb: (p: UpdateProgress) => void): Promise<Unlisten>;
  appVersion(): Promise<string>;
  openExternal(url: string): Promise<void>;
  notify(title: string, body?: string): Promise<void>;
  setWindowTitle(title: string): Promise<void>;
  /** Does the OS window have focus (not just the document)? */
  isWindowFocused(): Promise<boolean>;
  setZoom(scale: number): Promise<void>;
  lockWindowSize(locked: boolean): Promise<void>;
  // Platform helpers (dialogs, paths, shell, drag & drop)
  pickFiles(): Promise<string[]>;
  pickSavePath(defaultName: string): Promise<string | null>;
  pickDirectory(): Promise<string | null>;
  /** Choose a local folder to upload. */
  pickFolder(): Promise<string | null>;
  joinPath(dir: string, name: string): Promise<string>;
  revealInFolder(path: string): Promise<void>;
  onFileDrop(cb: (e: FileDropEvent) => void): Promise<Unlisten>;
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const ERROR_CODES: readonly string[] = [
  "NotConnected", "Auth", "NoSuchBucket", "NoSuchKey", "AccessDenied",
  "Network", "Io", "Cancelled", "InvalidInput", "Keychain", "Conflict", "NotSupported", "Unknown",
];

/** Turn whatever `invoke` (or a plugin) rejected with into an `AppError`. */
export function toAppError(e: unknown): AppError {
  if (e && typeof e === "object" && "message" in e) {
    const obj = e as { code?: unknown; message?: unknown };
    const code: ErrorCode =
      typeof obj.code === "string" && ERROR_CODES.includes(obj.code) ? (obj.code as ErrorCode) : "Unknown";
    return { code, message: String(obj.message ?? "Unknown error") };
  }
  if (typeof e === "string") return { code: "Unknown", message: e };
  return { code: "Unknown", message: "Unknown error" };
}

const tauriBackend: Backend = {
  listProfiles: () => invoke<ProfileInfo[]>("list_profiles"),
  connect: (config) => invoke<ConnectionInfo>("connect", { config }),
  disconnect: (cancelActive) => invoke<void>("disconnect", { cancelActive }),
  connectionStatus: () => invoke<ConnectionInfo | null>("connection_status"),
  listBuckets: () => invoke<Bucket[]>("list_buckets"),
  listObjects: (bucket, prefix, continuationToken, pageSize) =>
    invoke<ListPage>("list_objects", {
      bucket,
      prefix,
      continuationToken: continuationToken ?? null,
      pageSize: pageSize ?? null,
    }),
  listRecent: (bucket, prefix) => invoke<RecentListing>("list_recent", { bucket, prefix }),
  headObject: (bucket, key) => invoke<ObjectMeta>("head_object", { bucket, key }),
  createFolder: (bucket, prefix) => invoke<void>("create_folder", { bucket, prefix }),
  listAddedBuckets: () => invoke<AddedBucket[]>("list_added_buckets"),
  addBucket: (input) => invoke<AddedBucket>("add_bucket", { input }),
  removeAddedBucket: (name) => invoke<void>("remove_added_bucket", { name }),
  getBucketTags: (bucket) => invoke<Tag[]>("get_bucket_tags", { bucket }),
  putBucketTags: (bucket, tags, expected) => invoke<Tag[]>("put_bucket_tags", { bucket, tags, expected }),
  getObjectTags: (bucket, key) => invoke<Tag[]>("get_object_tags", { bucket, key }),
  putObjectTags: (bucket, key, tags, expected) => invoke<Tag[]>("put_object_tags", { bucket, key, tags, expected }),
  getLifecycle: (bucket) => invoke<LifecycleConfiguration | null>("get_lifecycle", { bucket }),
  validateLifecycle: (config) => invoke<LifecycleIssue[]>("validate_lifecycle", { config }),
  putLifecycle: (bucket, config, expected) => invoke<LifecycleConfiguration | null>("put_lifecycle", { bucket, config, expected }),
  getBucketVersioning: (bucket) => invoke<BucketVersioning>("get_bucket_versioning", { bucket }),
  previewJob: (request) => invoke<JobPreview>("preview_job", { request }),
  startJob: (request) => invoke<string>("start_job", { request }),
  cancelJob: (id) => invoke<void>("cancel_job", { id }),
  removeJob: (id) => invoke<void>("remove_job", { id }),
  listJobs: () => invoke<Job[]>("list_jobs"),
  onJobProgress: (cb) => listen<Job>(JOB_PROGRESS_EVENT, (e) => cb(e.payload)),
  previewBatch: (request, previewId) => invoke<BatchPreview>("preview_batch", { request, previewId: previewId ?? null }),
  startBatch: (request) => invoke<string>("start_batch", { request }),
  cancelBatch: (id) => invoke<void>("cancel_batch", { id }),
  removeBatch: (id) => invoke<void>("remove_batch", { id }),
  listBatches: () => invoke<Batch[]>("list_batches"),
  onBatchProgress: (cb) => listen<Batch>(BATCH_PROGRESS_EVENT, (e) => cb(e.payload)),
  listObjectVersions: (bucket, key) => invoke<VersionListing>("list_object_versions", { bucket, key }),
  downloadObjectVersion: (bucket, key, versionId, destPath) =>
    invoke<string>("download_object_version", { bucket, key, versionId, destPath }),
  restoreObjectVersion: (bucket, key, versionId) => invoke<ObjectEntry>("restore_object_version", { bucket, key, versionId }),
  deleteObjectVersion: (bucket, key, versionId) => invoke<void>("delete_object_version", { bucket, key, versionId }),
  restoreObject: (bucket, key, request) => invoke<void>("restore_object", { bucket, key, request }),
  startDownload: (bucket, key, destPath) => invoke<string>("start_download", { bucket, key, destPath }),
  startUpload: (bucket, key, srcPath) => invoke<string>("start_upload", { bucket, key, srcPath }),
  cancelTransfer: (id) => invoke<void>("cancel_transfer", { id }),
  removeTransfer: (id) => invoke<void>("remove_transfer", { id }),
  listTransfers: () => invoke<Transfer[]>("list_transfers"),
  onTransferProgress: (cb) => listen<Transfer>(TRANSFER_PROGRESS_EVENT, (e) => cb(e.payload)),
  getSettings: () => invoke<AppSettings>("get_settings"),
  updateSettings: (settings) => invoke<AppSettings>("update_settings", { settings }),
  listSavedConnections: () => invoke<SavedConnection[]>("list_saved_connections"),
  saveConnection: (input) => invoke<SavedConnection>("save_connection", { input }),
  deleteSavedConnection: (id) => invoke<void>("delete_saved_connection", { id }),
  connectSaved: (id) => invoke<ConnectionInfo>("connect_saved", { id }),
  checkForUpdate: () => invoke<UpdateInfo>("check_for_update"),
  installUpdate: () => invoke<void>("install_update"),
  onUpdateProgress: (cb) => listen<UpdateProgress>(UPDATE_PROGRESS_EVENT, (e) => cb(e.payload)),
  appVersion: () => getVersion(),
  openExternal: (url) => openUrl(url),
  setWindowTitle: (title) => getCurrentWindow().setTitle(title),
  isWindowFocused: () => getCurrentWindow().isFocused(),
  setZoom: (scale) => getCurrentWebview().setZoom(scale),
  async lockWindowSize(locked) {
    const win = getCurrentWindow();
    if (locked) {
      windowBeforeLock = { maximized: await win.isMaximized(), fullscreen: await win.isFullscreen(), size: await win.innerSize() };
      await win.setFullscreen(false);
      await win.unmaximize();
      await win.setSize(new LogicalSize(DEFAULT_WINDOW.width, DEFAULT_WINDOW.height));
    }
    await win.setResizable(!locked);
    await win.setMaximizable(!locked);
    if (!locked && windowBeforeLock) {
      // Put the window back the way it was.
      const before = windowBeforeLock;
      windowBeforeLock = null;
      await win.setSize(before.size);
      if (before.maximized) await win.maximize();
      if (before.fullscreen) await win.setFullscreen(true);
    }
  },
  async notify(title, body) {
    // The OS remembers the answer, so the permission prompt appears at most once.
    const granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  },

  async pickFiles() {
    const res = await open({ multiple: true, directory: false, title: "Upload files" });
    if (!res) return [];
    return Array.isArray(res) ? res : [res];
  },
  async pickSavePath(defaultName) {
    return (await save({ defaultPath: defaultName, title: "Download to" })) ?? null;
  },
  async pickDirectory() {
    const res = await open({ directory: true, multiple: false, title: "Download into folder" });
    return typeof res === "string" ? res : null;
  },
  async pickFolder() {
    const res = await open({ directory: true, multiple: false, title: "Upload folder" });
    return typeof res === "string" ? res : null;
  },
  joinPath: (dir, name) => join(dir, name),
  revealInFolder: (path) => revealItemInDir(path),
  onFileDrop: (cb) =>
    getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      switch (p.type) {
        case "enter":
          cb({ type: "enter", paths: p.paths });
          break;
        case "over":
          cb({ type: "over" });
          break;
        case "drop":
          cb({ type: "drop", paths: p.paths });
          break;
        case "leave":
          cb({ type: "leave" });
          break;
      }
    }),
};

let backendPromise: Promise<Backend> | null = null;
function backend(): Promise<Backend> {
  if (!backendPromise) {
    backendPromise = isTauri ? Promise.resolve(tauriBackend) : import("./mock").then((m) => m.mockBackend);
  }
  return backendPromise;
}

type Fn<K extends keyof Backend> = Backend[K] extends (...a: infer A) => Promise<infer R> ? (...a: A) => Promise<R> : never;

/** Call a backend method; always rejects with a normalized `AppError`. */
async function call<K extends keyof Backend>(
  name: K,
  ...args: Parameters<Fn<K>>
): Promise<Awaited<ReturnType<Fn<K>>>> {
  try {
    const b = await backend();
    const fn = b[name] as unknown as (...a: Parameters<Fn<K>>) => ReturnType<Fn<K>>;
    return await fn.apply(b, args);
  } catch (e) {
    throw toAppError(e);
  }
}

export const listProfiles = () => call("listProfiles");
export const connect = (config: ConnectionConfig) => call("connect", config);
/** Drop the connection. `cancelActive` cancels queued and running transfers, batches and jobs first. */
export const disconnect = (cancelActive: boolean) => call("disconnect", cancelActive);
export const connectionStatus = () => call("connectionStatus");
export const listBuckets = () => call("listBuckets");
export const listObjects = (bucket: string, prefix: string, continuationToken?: string | null, pageSize?: number) =>
  call("listObjects", bucket, prefix, continuationToken, pageSize);
export const listRecent = (bucket: string, prefix: string) => call("listRecent", bucket, prefix);
export const headObject = (bucket: string, key: string) => call("headObject", bucket, key);
export const createFolder = (bucket: string, prefix: string) => call("createFolder", bucket, prefix);
export const listAddedBuckets = () => call("listAddedBuckets");
/** `input` is a bucket name, an `s3://` URI or an ARN, as typed (trimmed). */
export const addBucket = (input: string) => call("addBucket", input);
/** Forget a bucket added by name. Never touches the bucket itself. */
export const removeAddedBucket = (name: string) => call("removeAddedBucket", name);
export const getBucketTags = (bucket: string) => call("getBucketTags", bucket);
/** Replace the bucket's tag set; fails with `Conflict` when the current set differs from `expected`. */
export const putBucketTags = (bucket: string, tags: Tag[], expected: Tag[]) => call("putBucketTags", bucket, tags, expected);
export const getObjectTags = (bucket: string, key: string) => call("getObjectTags", bucket, key);
/** Replace the object's tag set; fails with `Conflict` when the current set differs from `expected`. */
export const putObjectTags = (bucket: string, key: string, tags: Tag[], expected: Tag[]) =>
  call("putObjectTags", bucket, key, tags, expected);
/** `null` when the bucket has no lifecycle configuration; `NotSupported` when the server has no lifecycle. */
export const getLifecycle = (bucket: string) => call("getLifecycle", bucket);
/** Every problem with `config`, placed by rule index and field; `[]` = valid. Local, no network. */
export const validateLifecycle = (config: LifecycleConfiguration) => call("validateLifecycle", config);
/**
 * Replace the bucket's whole lifecycle configuration (no rules: delete it). Fails with `Conflict` when
 * the stored configuration differs from `expected` (the one the editor loaded, or null).
 */
export const putLifecycle = (bucket: string, config: LifecycleConfiguration, expected: LifecycleConfiguration | null) =>
  call("putLifecycle", bucket, config, expected);
export const getBucketVersioning = (bucket: string) => call("getBucketVersioning", bucket);
export const previewJob = (request: JobRequest) => call("previewJob", request);
export const startJob = (request: JobRequest) => call("startJob", request);
export const cancelJob = (id: string) => call("cancelJob", id);
export const removeJob = (id: string) => call("removeJob", id);
export const listJobs = () => call("listJobs");
export const onJobProgress = (cb: (j: Job) => void) => call("onJobProgress", cb);
/** Walk the local folder (upload) or list the prefix (download) and report what would happen. Changes nothing. */
export const previewBatch = (request: BatchPlanRequest, previewId?: string) => call("previewBatch", request, previewId);
/** Plan again and start the folder transfer; returns the batch id. */
export const startBatch = (request: BatchPlanRequest) => call("startBatch", request);
export const cancelBatch = (id: string) => call("cancelBatch", id);
export const removeBatch = (id: string) => call("removeBatch", id);
export const listBatches = () => call("listBatches");
export const onBatchProgress = (cb: (b: Batch) => void) => call("onBatchProgress", cb);
/**
 * Is `path` (from an OS drop, which gives paths only) a local folder? There is no file-system
 * plugin, so this asks `preview_batch` to plan an upload of it: the backend answers `InvalidInput`
 * with exactly "<path> is not a folder" for anything that is not a directory. Resolves with the
 * preview when it is a folder, `null` only for that answer, and rejects with any other error,
 * including other `InvalidInput`s (a bad prefix, for example), which must not be read as "a file".
 */
export async function probeFolder(request: BatchPlanRequest): Promise<BatchPreview | null> {
  try {
    return await previewBatch(request);
  } catch (e) {
    if (isNotAFolder(e as AppError)) return null;
    throw e;
  }
}
/** The backend's "<path> is not a folder" answer to an upload preview of a plain file. */
export const isNotAFolder = (e: AppError | null | undefined): boolean =>
  e?.code === "InvalidInput" && typeof e.message === "string" && e.message.endsWith(" is not a folder");
/** Every version of exactly `key`, newest first (at most 1,000; `truncated` beyond that). */
export const listObjectVersions = (bucket: string, key: string) => call("listObjectVersions", bucket, key);
/** Download one version (the normal parallel download, pinned to `versionId`). Returns the transfer id. */
export const downloadObjectVersion = (bucket: string, key: string, versionId: string, destPath: string) =>
  call("downloadObjectVersion", bucket, key, versionId, destPath);
/** Copy an older version over the current one. Non-destructive: the current version becomes a previous one. */
export const restoreObjectVersion = (bucket: string, key: string, versionId: string) =>
  call("restoreObjectVersion", bucket, key, versionId);
/** Permanently delete one version (or remove a delete marker). Cannot be undone. */
export const deleteObjectVersion = (bucket: string, key: string, versionId: string) =>
  call("deleteObjectVersion", bucket, key, versionId);
/** Ask S3 to restore an archived object for `request.days` days. `Conflict` when already in progress. */
export const restoreObject = (bucket: string, key: string, request: RestoreRequest) => call("restoreObject", bucket, key, request);
export const startDownload = (bucket: string, key: string, destPath: string) =>
  call("startDownload", bucket, key, destPath);
export const startUpload = (bucket: string, key: string, srcPath: string) => call("startUpload", bucket, key, srcPath);
export const cancelTransfer = (id: string) => call("cancelTransfer", id);
export const removeTransfer = (id: string) => call("removeTransfer", id);
export const listTransfers = () => call("listTransfers");
export const onTransferProgress = (cb: (t: Transfer) => void) => call("onTransferProgress", cb);
export const getSettings = () => call("getSettings");
export const updateSettings = (settings: AppSettings) => call("updateSettings", settings);

export const listSavedConnections = () => call("listSavedConnections");
export const saveConnection = (input: SaveConnectionInput) => call("saveConnection", input);
export const deleteSavedConnection = (id: string) => call("deleteSavedConnection", id);
export const connectSaved = (id: string) => call("connectSaved", id);

export const checkForUpdate = () => call("checkForUpdate");
export const installUpdate = () => call("installUpdate");
export const onUpdateProgress = (cb: (p: UpdateProgress) => void) => call("onUpdateProgress", cb);
export const appVersion = () => call("appVersion");
/** Open an http(s) URL in the system browser. */
export const openExternal = (url: string): Promise<void> =>
  /^https:\/\//i.test(url)
    ? call("openExternal", url)
    : Promise.reject<void>({ code: "InvalidInput", message: "Only https links can be opened." } satisfies AppError);
/** Show an OS notification. Asks for permission on first use and does nothing if it is denied. */
export const notify = (title: string, body?: string) => call("notify", title, body);
/** Set the text in the OS window title bar and taskbar. */
export const setWindowTitle = (title: string) => call("setWindowTitle", title);
/** True when the OS window has focus (the webview's `document.hasFocus()` can disagree). */
export const isWindowFocused = () => call("isWindowFocused");
/** Scale the whole interface: 1 is normal size. */
export const setZoom = (scale: number) => call("setZoom", scale);
/**
 * Locked: the window goes to its default size and can be neither resized nor maximized. Unlocked:
 * it gets its previous size and state back.
 */
export const lockWindowSize = (locked: boolean) => call("lockWindowSize", locked);

export const pickFiles = () => call("pickFiles");
export const pickSavePath = (defaultName: string) => call("pickSavePath", defaultName);
export const pickDirectory = () => call("pickDirectory");
export const pickFolder = () => call("pickFolder");
export const joinPath = (dir: string, name: string) => call("joinPath", dir, name);
export const revealInFolder = (path: string) => call("revealInFolder", path);
export const onFileDrop = (cb: (e: FileDropEvent) => void) => call("onFileDrop", cb);
