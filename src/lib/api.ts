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
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AWS_LOGIN_DONE_EVENT,
  AWS_LOGIN_OUTPUT_EVENT,
  BATCH_PROGRESS_EVENT,
  JOB_PROGRESS_EVENT,
  LAUNCH_OPEN_EVENT,
  TRANSFER_PROGRESS_EVENT,
  UPDATE_PROGRESS_EVENT,
  type AddedBucket,
  type AppError,
  type AppSettings,
  type AwsLoginDone,
  type AwsLoginKind,
  type AwsLoginOutput,
  type Batch,
  type BatchPlanRequest,
  type BatchPreview,
  type Bucket,
  type BucketVersioning,
  type ConnectionConfig,
  type ConnectionInfo,
  type ErrorCode,
  type FolderSize,
  type Job,
  type JobPreview,
  type JobRequest,
  type LifecycleConfiguration,
  type LocalDirSize,
  type LocalListing,
  type LocalRoot,
  type TrashResult,
  type LifecycleIssue,
  type AccentColor,
  type LaunchRequest,
  type ListPage,
  type MetadataEdit,
  type ObjectEntry,
  type ObjectMeta,
  type ObjectPreview,
  type ProfileInfo,
  type RecentListing,
  type RestoreRequest,
  type SaveConnectionInput,
  type SearchQuery,
  type SearchResult,
  type SavedConnection,
  type Tag,
  type Transfer,
  type UpdateInfo,
  type UpdateProgress,
  type VersionListing,
} from "./types";

export type Unlisten = () => void;

/** OS file drag & drop, normalized from the Tauri webview drag-drop event. */
/** Where the pointer is, in CSS pixels of the page (the pane under it receives a drop). */
export interface DropPoint {
  x: number;
  y: number;
}

export type FileDropEvent =
  | { type: "enter"; paths: string[]; position?: DropPoint }
  | { type: "over"; position?: DropPoint }
  | { type: "drop"; paths: string[]; position?: DropPoint }
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
  /** What is inside a file, read into memory without a download (see "Object preview" in the contract). */
  previewObject(bucket: string, key: string): Promise<ObjectPreview>;
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
  /** Copy the object onto itself with new headers (conditional on `edit.expectedEtag`); the object as read back. */
  updateObjectMetadata(edit: MetadataEdit): Promise<ObjectMeta>;
  // Lifecycle configuration
  getLifecycle(bucket: string): Promise<LifecycleConfiguration | null>;
  validateLifecycle(config: LifecycleConfiguration): Promise<LifecycleIssue[]>;
  putLifecycle(bucket: string, config: LifecycleConfiguration, expected: LifecycleConfiguration | null): Promise<LifecycleConfiguration | null>;
  getBucketVersioning(bucket: string): Promise<BucketVersioning>;
  // Search (v0.6.0)
  /** A newer search with the same `searchId` cancels the one still running (it rejects `Cancelled`). */
  searchObjects(query: SearchQuery, searchId: string): Promise<SearchResult>;
  /** Stop the running search with this id (it rejects `Cancelled`); no-op when none runs. */
  cancelSearch(searchId: string): Promise<void>;
  // Folder size
  /** Objects and bytes under `prefix`; a newer call with the same `id` cancels the older one. */
  folderSize(id: string, bucket: string, prefix: string): Promise<FolderSize>;
  /** Stop the scan with this id (it rejects `Cancelled`); no-op for an unknown id. */
  cancelFolderSize(id: string): Promise<void>;
  /** Open a finished download (file or folder) with the OS. */
  openLocal(path: string): Promise<void>;
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
  pauseBatch(id: string): Promise<void>;
  resumeBatch(id: string): Promise<void>;
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
  pauseTransfer(id: string): Promise<void>;
  resumeTransfer(id: string): Promise<void>;
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
  /** Show the item in the file manager (the system one, or the program set in Settings). */
  revealInFolder(path: string): Promise<void>;
  /** Like revealInFolder, but with an unsaved file-manager command (null = the system file manager). */
  tryFileManager(command: string | null, path: string): Promise<void>;
  /** Choose a program (the file-manager command's Browse…); null when cancelled. */
  pickProgram(): Promise<string | null>;
  onFileDrop(cb: (e: FileDropEvent) => void): Promise<Unlisten>;
  // Keyboard bindings export / import (v0.7.0)
  /** Choose where to export (a `.json` file); null when cancelled. */
  pickExportPath(defaultName: string): Promise<string | null>;
  /** Choose a `.json` file to import; null when cancelled. */
  pickImportFile(): Promise<string | null>;
  writeTextFile(path: string, content: string): Promise<void>;
  readTextFile(path: string): Promise<string>;
  // The local computer (v0.9.0, see "Pane sources" in docs/CONTRACT.md)
  listLocalRoots(): Promise<LocalRoot[]>;
  listLocalDir(path: string, showHidden: boolean): Promise<LocalListing>;
  createLocalDir(parent: string, name: string): Promise<void>;
  renameLocal(path: string, newName: string): Promise<void>;
  trashLocal(paths: string[]): Promise<TrashResult>;
  localDirSize(path: string, scanId: string): Promise<LocalDirSize>;
  // v0.9.0: the window icon follows the accent; the command line opens a location
  setWindowIcon(accent: AccentColor): Promise<void>;
  takeLaunchRequest(): Promise<LaunchRequest | null>;
  onLaunchOpen(cb: (req: LaunchRequest) => void): Promise<Unlisten>;
  // v0.9.3: sign in again with the AWS CLI (see "Profiles from `aws login`" in docs/CONTRACT.md)
  startAwsLogin(profile: string, kind: AwsLoginKind): Promise<{ runId: string }>;
  cancelAwsLogin(runId: string): Promise<void>;
  onAwsLoginOutput(cb: (e: AwsLoginOutput) => void): Promise<Unlisten>;
  onAwsLoginDone(cb: (e: AwsLoginDone) => void): Promise<Unlisten>;
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** The OS the webview runs on, from the browser's own report (the one place this is decided). */
export const clientOS: "windows" | "mac" | "other" = (() => {
  if (typeof navigator === "undefined") return "other";
  const p = `${navigator.platform} ${navigator.userAgent}`;
  return /win/i.test(navigator.platform) || /windows/i.test(p) ? "windows" : /mac/i.test(p) ? "mac" : "other";
})();

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

/** The webview reports drop positions in physical pixels; the page works in CSS pixels. */
function toCssPoint(p: { x: number; y: number } | undefined): DropPoint | undefined {
  if (!p) return undefined;
  const scale = window.devicePixelRatio || 1;
  return { x: p.x / scale, y: p.y / scale };
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
  previewObject: (bucket, key) => invoke<ObjectPreview>("preview_object", { bucket, key }),
  createFolder: (bucket, prefix) => invoke<void>("create_folder", { bucket, prefix }),
  listAddedBuckets: () => invoke<AddedBucket[]>("list_added_buckets"),
  addBucket: (input) => invoke<AddedBucket>("add_bucket", { input }),
  removeAddedBucket: (name) => invoke<void>("remove_added_bucket", { name }),
  getBucketTags: (bucket) => invoke<Tag[]>("get_bucket_tags", { bucket }),
  putBucketTags: (bucket, tags, expected) => invoke<Tag[]>("put_bucket_tags", { bucket, tags, expected }),
  getObjectTags: (bucket, key) => invoke<Tag[]>("get_object_tags", { bucket, key }),
  putObjectTags: (bucket, key, tags, expected) => invoke<Tag[]>("put_object_tags", { bucket, key, tags, expected }),
  updateObjectMetadata: (edit) => invoke<ObjectMeta>("update_object_metadata", { edit }),
  getLifecycle: (bucket) => invoke<LifecycleConfiguration | null>("get_lifecycle", { bucket }),
  validateLifecycle: (config) => invoke<LifecycleIssue[]>("validate_lifecycle", { config }),
  putLifecycle: (bucket, config, expected) => invoke<LifecycleConfiguration | null>("put_lifecycle", { bucket, config, expected }),
  getBucketVersioning: (bucket) => invoke<BucketVersioning>("get_bucket_versioning", { bucket }),
  searchObjects: (query, searchId) => invoke<SearchResult>("search_objects", { query, searchId }),
  cancelSearch: (searchId) => invoke<void>("cancel_search", { searchId }),
  folderSize: (id, bucket, prefix) => invoke<FolderSize>("folder_size", { id, bucket, prefix }),
  cancelFolderSize: (id) => invoke<void>("cancel_folder_size", { id }),
  openLocal: (path) => invoke<void>("open_local", { path }),
  previewJob: (request) => invoke<JobPreview>("preview_job", { request }),
  startJob: (request) => invoke<string>("start_job", { request }),
  cancelJob: (id) => invoke<void>("cancel_job", { id }),
  removeJob: (id) => invoke<void>("remove_job", { id }),
  listJobs: () => invoke<Job[]>("list_jobs"),
  onJobProgress: (cb) => listen<Job>(JOB_PROGRESS_EVENT, (e) => cb(e.payload)),
  previewBatch: (request, previewId) => invoke<BatchPreview>("preview_batch", { request, previewId: previewId ?? null }),
  startBatch: (request) => invoke<string>("start_batch", { request }),
  cancelBatch: (id) => invoke<void>("cancel_batch", { id }),
  pauseBatch: (id) => invoke<void>("pause_batch", { id }),
  resumeBatch: (id) => invoke<void>("resume_batch", { id }),
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
  pauseTransfer: (id) => invoke<void>("pause_transfer", { id }),
  resumeTransfer: (id) => invoke<void>("resume_transfer", { id }),
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
  revealInFolder: (path) => invoke<void>("reveal_local", { path }),
  tryFileManager: (command, path) => invoke<void>("try_file_manager", { command, path }),
  async pickProgram() {
    // Windows: .exe/.com only (a .bat/.cmd would run through cmd.exe).
    const res = await open({
      multiple: false,
      directory: false,
      title: "Choose a file manager",
      ...(clientOS === "windows" ? { filters: [{ name: "Programs", extensions: ["exe", "com"] }] } : {}),
    });
    return typeof res === "string" ? res : null;
  },
  async pickExportPath(defaultName) {
    return (await save({ defaultPath: defaultName, title: "Export keyboard shortcuts", filters: [{ name: "JSON", extensions: ["json"] }] })) ?? null;
  },
  async pickImportFile() {
    const res = await open({ multiple: false, directory: false, title: "Import keyboard shortcuts", filters: [{ name: "JSON", extensions: ["json"] }] });
    return typeof res === "string" ? res : null;
  },
  writeTextFile: (path, content) => invoke<void>("write_text_file", { path, content }),
  readTextFile: (path) => invoke<string>("read_text_file", { path }),
  listLocalRoots: () => invoke<LocalRoot[]>("list_local_roots"),
  listLocalDir: (path, showHidden) => invoke<LocalListing>("list_local_dir", { path, showHidden }),
  createLocalDir: (parent, name) => invoke<void>("create_local_dir", { parent, name }),
  renameLocal: (path, newName) => invoke<void>("rename_local", { path, newName }),
  trashLocal: (paths) => invoke<TrashResult>("trash_local", { paths }),
  localDirSize: (path, scanId) => invoke<LocalDirSize>("local_dir_size", { path, scanId }),
  setWindowIcon: (accent) => invoke<void>("set_window_icon", { accent }),
  takeLaunchRequest: () => invoke<LaunchRequest | null>("take_launch_request"),
  onLaunchOpen: (cb) => listen<LaunchRequest>(LAUNCH_OPEN_EVENT, (e) => cb(e.payload)),
  startAwsLogin: (profile, kind) => invoke<{ runId: string }>("start_aws_login", { profile, kind }),
  cancelAwsLogin: (runId) => invoke<void>("cancel_aws_login", { runId }),
  onAwsLoginOutput: (cb) => listen<AwsLoginOutput>(AWS_LOGIN_OUTPUT_EVENT, (e) => cb(e.payload)),
  onAwsLoginDone: (cb) => listen<AwsLoginDone>(AWS_LOGIN_DONE_EVENT, (e) => cb(e.payload)),
  onFileDrop: (cb) =>
    getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      switch (p.type) {
        case "enter":
          cb({ type: "enter", paths: p.paths, position: toCssPoint(p.position) });
          break;
        case "over":
          cb({ type: "over", position: toCssPoint(p.position) });
          break;
        case "drop":
          cb({ type: "drop", paths: p.paths, position: toCssPoint(p.position) });
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
export const previewObject = (bucket: string, key: string) => call("previewObject", bucket, key);
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
export const updateObjectMetadata = (edit: MetadataEdit) => call("updateObjectMetadata", edit);
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
/**
 * Search the bucket by a bounded scan of its keys (see "Search in a bucket" in docs/CONTRACT.md).
 * A newer call with the same `searchId` cancels this one, which then rejects with `Cancelled`.
 */
export const searchObjects = (query: SearchQuery, searchId: string) => call("searchObjects", query, searchId);
/** Stop the running search with this id; it then rejects with `Cancelled`. No-op when none runs. */
export const cancelSearch = (searchId: string) => call("cancelSearch", searchId);
/**
 * Count the objects and bytes under `prefix` (verbatim) by a bounded scan (see "Folder size" in
 * docs/CONTRACT.md). At most four run at once; `cancelFolderSize(id)` makes this reject `Cancelled`.
 */
export const folderSize = (id: string, bucket: string, prefix: string) => call("folderSize", id, bucket, prefix);
export const cancelFolderSize = (id: string) => call("cancelFolderSize", id);
/**
 * Open a finished download with the OS default application (a file) or the file manager (a
 * folder). The backend accepts the local path of a completed download or finished folder
 * download, and (v0.9.0) a file browsed to in a local pane; it refuses files that could run as a
 * program (`NotSupported`).
 */
export const openLocal = (path: string) => call("openLocal", path);
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
/** Pause every queued or running file of the folder transfer; files it starts later start paused. */
export const pauseBatch = (id: string) => call("pauseBatch", id);
export const resumeBatch = (id: string) => call("resumeBatch", id);
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
/** Stop moving data but keep the finished parts; `paused` gives the run slot back. */
export const pauseTransfer = (id: string) => call("pauseTransfer", id);
/** Back to the queue at its place; continues with the missing parts. */
export const resumeTransfer = (id: string) => call("resumeTransfer", id);
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
/** Show the item in the file manager: the system one, or the program set in Settings (`reveal_local`). */
export const revealInFolder = (path: string) => call("revealInFolder", path);
/** Test a file-manager command before saving it (`try_file_manager`); null = the system file manager. */
export const tryFileManager = (command: string | null, path: string) => call("tryFileManager", command, path);
/** The file picker for the file-manager command's Browse… button. */
export const pickProgram = () => call("pickProgram");
export const onFileDrop = (cb: (e: FileDropEvent) => void) => call("onFileDrop", cb);
export const pickExportPath = (defaultName: string) => call("pickExportPath", defaultName);
export const pickImportFile = () => call("pickImportFile");
export const writeTextFile = (path: string, content: string) => call("writeTextFile", path, content);
export const readTextFile = (path: string) => call("readTextFile", path);

// ---- the local computer (v0.9.0) ---------------------------------------------------------------
/** The drives and the home folder a local pane can start from. */
export const listLocalRoots = () => call("listLocalRoots");
/** One directory, sorted by name, at most 50,000 entries (`truncated` past that); never follows links. */
export const listLocalDir = (path: string, showHidden: boolean) => call("listLocalDir", path, showHidden);
/** Create `name` (sanitized by the backend) in `parent`; refuses an existing name. */
export const createLocalDir = (parent: string, name: string) => call("createLocalDir", parent, name);
/** Rename in the same directory; refuses an existing target, never replaces. */
export const renameLocal = (path: string, newName: string) => call("renameLocal", path, newName);
/** Move to the OS recycle bin / trash (never a permanent delete); a link is trashed as the link. */
export const trashLocal = (paths: string[]) => call("trashLocal", paths);
/** Files and bytes under a local folder, bounded (200,000 entries); a newer call with the same id cancels. */
export const localDirSize = (path: string, scanId: string) => call("localDirSize", path, scanId);

/** v0.9.0: the window and taskbar icon in the accent colour (the installed shortcut stays yellow). */
export const setWindowIcon = (accent: AccentColor) => call("setWindowIcon", accent);
/** The location the app was started with (`s3explorer [--connection <name>] [<location>]`), once; null after. */
export const takeLaunchRequest = () => call("takeLaunchRequest");
/** A second launch handed its arguments to this running instance (single instance). */
export const onLaunchOpen = (cb: (req: LaunchRequest) => void) => call("onLaunchOpen", cb);

// ---- sign in again with the AWS CLI (v0.9.3) ---------------------------------------------------
/**
 * Run `aws login --profile <profile>` (or `aws sso login`) for the user. One run at a time
 * (`Conflict`); `InvalidInput` when the CLI is missing or the profile name is invalid.
 */
export const startAwsLogin = (profile: string, kind: AwsLoginKind) => call("startAwsLogin", profile, kind);
/** Kill the running CLI; no-op when it already ended. */
export const cancelAwsLogin = (runId: string) => call("cancelAwsLogin", runId);
/** Each line the CLI prints (stdout and stderr). */
export const onAwsLoginOutput = (cb: (e: AwsLoginOutput) => void) => call("onAwsLoginOutput", cb);
/** The run ended: exit code, cancelled, or timed out after 10 minutes. */
export const onAwsLoginDone = (cb: (e: AwsLoginDone) => void) => call("onAwsLoginDone", cb);
