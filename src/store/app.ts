// Session + browsing + UI state. Transfers live in ./transfers.ts.

import { create } from "zustand";
import * as api from "../lib/api";
import type { AddedBucket, AppError, BatchPreview, Bucket, ConnectionInfo, FolderEntry, JobItem, JobRequest, ObjectEntry, ObjectVersion } from "../lib/types";
import { asFolderPrefix } from "../lib/format";
import { clearClipboard } from "./clipboard";
import { selectActiveBatchCount, useBatches } from "./batches";
import { selectActiveJobCount, useJobs } from "./jobs";
import { clearRecent } from "./recent";
import { clearArchive } from "./archive";
import { clearVersioning } from "./versions";
import { selectActiveCount, useTransfers } from "./transfers";

export type SortKey = "name" | "size" | "modified" | "class";
export interface SortState {
  key: SortKey;
  dir: 1 | -1;
}

export interface Listing {
  folders: FolderEntry[];
  objects: ObjectEntry[];
  token: string | null;
  truncated: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: AppError | null;
}

/** The single item being renamed (exact server key/prefix plus its last segment). */
export interface RenameTarget {
  bucket: string;
  key: string;
  isPrefix: boolean;
  name: string;
  /** The folder it lives in: `key` minus its name (and trailing "/" for folders). */
  parent: string;
}

export type Modal =
  | { kind: "newFolder" }
  /** Confirm a delete job; `request` is exactly what will be sent. */
  | { kind: "delete"; request: JobRequest }
  | { kind: "rename"; target: RenameTarget }
  /** Confirm a paste (copy or move job). `renamed` = names got a "(copy)" suffix. */
  /** `clearCut` = empty the in-app clipboard once started (pasting cut items; a drag leaves it alone). */
  | { kind: "paste"; request: JobRequest; mode: "copy" | "cut"; srcPrefix: string; destPrefix: string; renamed: boolean; clearCut: boolean }
  /** Add a bucket by name ("Shared with me"). */
  | { kind: "addBucket" }
  /** Forget an added bucket (never touches the bucket). */
  | { kind: "removeBucket"; name: string }
  | { kind: "bucketTags"; bucket: string }
  /** The bucket's lifecycle rules (load, edit, confirm, save the whole configuration). */
  | { kind: "lifecycle"; bucket: string }
  | { kind: "objectTags"; bucket: string; key: string }
  /** Tag several objects at once (a "tag" job). `items` are exact keys/prefixes from the selection. */
  | { kind: "bulkTags"; bucket: string; prefix: string; items: JobItem[] }
  /** Upload a local folder (a batch). `localPath` came from the picker or an OS drop. */
  | { kind: "uploadFolder"; bucket: string; prefix: string; localPath: string; initialPreview?: BatchPreview }
  /** Download folders (one batch each) into `dir`. `folders` are exact prefixes from the listing. */
  | { kind: "downloadFolders"; bucket: string; folders: FolderEntry[]; dir: string }
  /** Disconnect while transfers or jobs are still running. */
  | { kind: "disconnect"; running: number }
  /** Restore one archived object (restore_object). */
  | { kind: "restore"; bucket: string; key: string; storageClass: string | null }
  /** Restore the archived objects in a selection (a "restore" job). `items` are exact keys/prefixes. */
  | { kind: "bulkRestore"; bucket: string; prefix: string; items: JobItem[]; deepArchive: boolean; allDeep: boolean }
  /** Confirm an action on one version of an object (shown from the details panel). */
  | { kind: "versionAction"; action: "restore" | "delete" | "undelete"; bucket: string; key: string; version: ObjectVersion; onlyVersion: boolean; previousIsMarker: boolean }
  | null;

/** Modals that make sense without an open bucket. */
export const BUCKETLESS_MODALS: ReadonlySet<NonNullable<Modal>["kind"]> = new Set(["addBucket", "removeBucket", "bucketTags", "lifecycle", "disconnect"]);

export interface ContextMenuState {
  x: number;
  y: number;
}

interface AppState {
  connection: ConnectionInfo | null;
  buckets: Bucket[];
  bucketsLoading: boolean;
  bucketsError: AppError | null;
  /** Buckets added by name for this connection ("Shared with me"; the whole list when ListBuckets is denied). */
  addedBuckets: AddedBucket[];
  addedLoading: boolean;
  addedError: AppError | null;

  bucket: string | null;
  prefix: string;
  listing: Listing;

  selection: Set<string>;
  anchor: string | null;
  focus: string | null;

  sort: SortState;
  filter: string;

  /** An object to select once the page that holds it is loaded (opening a newest file). */
  reveal: string | null;
  /** Ask the table to scroll a row into view; `seq` makes repeated requests distinct. */
  scrollTo: { id: string; seq: number } | null;

  detailsOpen: boolean;
  transfersOpen: boolean;
  modal: Modal;
  contextMenu: ContextMenuState | null;
}

const emptyListing: Listing = {
  folders: [],
  objects: [],
  token: null,
  truncated: false,
  loading: false,
  loadingMore: false,
  error: null,
};

const PAGE_SIZE = 1000;

export const readPref = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
};
export const writePref = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
};

export const useApp = create<AppState>(() => ({
  connection: null,
  buckets: [],
  bucketsLoading: false,
  bucketsError: null,
  addedBuckets: [],
  addedLoading: false,
  addedError: null,
  bucket: null,
  prefix: "",
  listing: emptyListing,
  selection: new Set(),
  anchor: null,
  focus: null,
  sort: readPref<SortState>("s3x.sort", { key: "name", dir: 1 }),
  filter: "",
  reveal: null,
  scrollTo: null,
  detailsOpen: readPref("s3x.detailsOpen", true),
  transfersOpen: false,
  modal: null,
  contextMenu: null,
}));

const set = useApp.setState;
const get = useApp.getState;

let listSeq = 0;

/**
 * Fetch one page, but keep following the continuation token while the backend returns
 * empty-but-truncated pages (e.g. a page whose only key was the hidden folder marker).
 */
async function fetchPage(bucket: string, prefix: string, token: string | null, seq: number) {
  let page = await api.listObjects(bucket, prefix, token, PAGE_SIZE);
  let guard = 0;
  while (page.isTruncated && page.nextContinuationToken && !page.folders.length && !page.objects.length && guard++ < 50) {
    if (seq !== listSeq) break;
    page = await api.listObjects(bucket, prefix, page.nextContinuationToken, PAGE_SIZE);
  }
  return page;
}

// ---- connection ------------------------------------------------------------------

/** The saved connection the app is connected through (null: connected without saving, or not connected). */
let savedConnectionId: string | null = null;

export function setConnected(info: ConnectionInfo, savedId: string | null = null) {
  savedConnectionId = savedId;
  clearClipboard();
  clearRecent();
  clearArchive();
  clearVersioning();
  set({
    connection: info,
    buckets: [],
    bucketsError: null,
    addedBuckets: [],
    addedError: null,
    bucket: null,
    prefix: "",
    listing: emptyListing,
    selection: new Set(),
    filter: "",
    reveal: null,
  });
  if (info.canListBuckets) void loadBuckets();
  void loadAddedBuckets();
}

/** `cancelActive`: cancel every queued or running transfer, folder transfer and job before disconnecting. */
export async function disconnect(cancelActive = false) {
  try {
    await api.disconnect(cancelActive);
  } catch {
    /* disconnect is best effort */
  }
  listSeq++;
  savedConnectionId = null;
  clearClipboard();
  clearRecent();
  clearArchive();
  clearVersioning();
  set({
    connection: null,
    buckets: [],
    addedBuckets: [],
    bucket: null,
    prefix: "",
    listing: emptyListing,
    selection: new Set(),
    reveal: null,
    modal: null,
    contextMenu: null,
  });
}

/** Disconnect, but ask first while transfers or file operations are still running. */
export function requestDisconnect() {
  // A folder transfer counts once (its files are not in the transfer list).
  const running =
    selectActiveCount(useTransfers.getState()) + selectActiveJobCount(useJobs.getState()) + selectActiveBatchCount(useBatches.getState());
  if (running > 0) openModal({ kind: "disconnect", running });
  else void disconnect();
}

/**
 * A saved connection was deleted. The backend also forgets the buckets added by name for it, so if
 * it is the one in use, the cached list of added buckets goes too.
 */
export function forgetSavedConnection(id: string) {
  if (savedConnectionId !== id) return;
  savedConnectionId = null;
  set({ addedBuckets: [], addedError: null });
}

export async function loadBuckets() {
  set({ bucketsLoading: true, bucketsError: null });
  try {
    const buckets = await api.listBuckets();
    buckets.sort((a, b) => a.name.localeCompare(b.name));
    set({ buckets, bucketsLoading: false });
  } catch (e) {
    set({ bucketsLoading: false, bucketsError: e as AppError });
  }
}

// ---- buckets added by name ("Shared with me") ----------------------------------------------

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

export async function loadAddedBuckets() {
  set({ addedLoading: true, addedError: null });
  try {
    const added = await api.listAddedBuckets();
    set({ addedBuckets: [...added].sort(byName), addedLoading: false });
  } catch (e) {
    set({ addedLoading: false, addedError: e as AppError });
  }
}

/** Add a bucket by name, `s3://` URI or ARN. Rejects with the backend's `AppError` (nothing is stored then). */
export async function addSharedBucket(input: string): Promise<AddedBucket> {
  const added = await api.addBucket(input.trim());
  set((s) => ({
    addedBuckets: [...s.addedBuckets.filter((b) => b.name !== added.name), added].sort(byName),
  }));
  return added;
}

/** Forget an added bucket. Only the local list changes; the bucket and its contents are untouched. */
export async function removeSharedBucket(name: string): Promise<void> {
  await api.removeAddedBucket(name);
  const { bucket, buckets } = get();
  set((s) => ({ addedBuckets: s.addedBuckets.filter((b) => b.name !== name) }));
  // Close it if it was open and is not also in the regular list.
  if (bucket === name && !buckets.some((b) => b.name === name)) {
    listSeq++;
    set({ bucket: null, prefix: "", listing: emptyListing, selection: new Set(), anchor: null, focus: null, reveal: null });
  }
}

// ---- navigation / listing ------------------------------------------------------------

const navigateListeners = new Set<() => void>();
/**
 * Called at the start of every navigation (any `navigate` or `revealObject`, including to the
 * current folder), before the selection changes. The search results close here.
 */
export function onNavigate(cb: () => void): () => void {
  navigateListeners.add(cb);
  return () => navigateListeners.delete(cb);
}

export function navigate(bucket: string, prefix: string) {
  navigateListeners.forEach((cb) => cb());
  // Server-provided prefixes are used verbatim (see asFolderPrefix / normalizePrefix).
  const p = asFolderPrefix(prefix);
  set({
    bucket,
    prefix: p,
    selection: new Set(),
    anchor: null,
    focus: null,
    filter: "",
    contextMenu: null,
    reveal: null,
  });
  void loadFirstPage();
}

let scrollSeq = 0;

/**
 * Open the folder that holds `key` with the object selected and scrolled into view. The object may
 * be beyond the first page of a large folder, so pages are loaded until it is found.
 */
export function revealObject(bucket: string, key: string, name: string) {
  navigate(bucket, key.slice(0, key.length - name.length));
  set({ reveal: key, selection: new Set([key]), anchor: key, focus: key });
}

/** At most this many extra pages are loaded looking for a revealed object. */
const REVEAL_MAX_PAGES = 30;

async function continueReveal() {
  for (let pages = 0; pages <= REVEAL_MAX_PAGES; ) {
    const s = get();
    const key = s.reveal;
    if (!key) return;
    if (s.listing.objects.some((o) => o.key === key)) {
      set({ reveal: null, selection: new Set([key]), anchor: key, focus: key, scrollTo: { id: key, seq: ++scrollSeq } });
      return;
    }
    if (s.listing.loading || s.listing.loadingMore) {
      // A page is on its way (e.g. infinite scroll asked first): wait for it.
      await new Promise((r) => setTimeout(r, 80));
      continue;
    }
    if (!s.listing.truncated || !s.listing.token || s.listing.error) break;
    pages++;
    await loadMore();
  }
  // Not found (deleted meanwhile, or too far down): don't leave an invisible selection behind.
  if (get().reveal) set({ reveal: null, selection: new Set(), anchor: null, focus: null });
}

export function refresh() {
  void loadFirstPage(true);
}

async function loadFirstPage(keepSelection = false) {
  const { bucket, prefix } = get();
  if (!bucket) return;
  const seq = ++listSeq;
  set((s) => ({
    listing: keepSelection
      ? { ...s.listing, loading: true, error: null }
      : { ...emptyListing, loading: true },
  }));
  try {
    const page = await fetchPage(bucket, prefix, null, seq);
    if (seq !== listSeq) return;
    set((s) => {
      // Keep only selected ids that still exist (and an object being revealed, which may be on a later page).
      const ids = new Set<string>([...page.folders.map((f) => f.prefix), ...page.objects.map((o) => o.key)]);
      const selection = new Set([...s.selection].filter((id) => ids.has(id) || id === s.reveal));
      return {
        listing: {
          folders: page.folders,
          objects: page.objects,
          token: page.nextContinuationToken,
          truncated: page.isTruncated,
          loading: false,
          loadingMore: false,
          error: null,
        },
        selection,
      };
    });
    if (get().reveal) void continueReveal();
  } catch (e) {
    if (seq !== listSeq) return;
    set({ listing: { ...emptyListing, error: e as AppError } });
  }
}

let inPlace: Promise<void> | null = null;
let inPlaceAgain = false;

/**
 * Re-list the current folder after something changed it (a job), without the loading state:
 * reloads as many entries as were loaded before so the scroll position survives, keeps the
 * selection for entries that still exist and drops the rest. Concurrent calls coalesce.
 */
export function refreshInPlace(): Promise<void> {
  if (inPlace) {
    inPlaceAgain = true;
    return inPlace;
  }
  inPlace = (async () => {
    do {
      inPlaceAgain = false;
      await reloadKeepingPosition();
    } while (inPlaceAgain);
  })().finally(() => {
    inPlace = null;
  });
  return inPlace;
}

async function reloadKeepingPosition() {
  const { bucket, prefix, listing } = get();
  if (!bucket || listing.loading) return;
  const want = Math.max(1, listing.folders.length + listing.objects.length);
  const seq = ++listSeq;
  const folders: FolderEntry[] = [];
  const objects: ObjectEntry[] = [];
  let token: string | null = null;
  let truncated = false;
  try {
    do {
      const page = await fetchPage(bucket, prefix, token, seq);
      if (seq !== listSeq) return;
      folders.push(...page.folders);
      objects.push(...page.objects);
      token = page.nextContinuationToken;
      truncated = page.isTruncated;
    } while (truncated && token && folders.length + objects.length < want);
  } catch {
    // Keep showing what we had; the next refresh (or the user) can retry.
    return;
  }
  if (seq !== listSeq) return;
  set((s) => {
    const ids = new Set<string>([...folders.map((f) => f.prefix), ...objects.map((o) => o.key)]);
    const selection = new Set([...s.selection].filter((id) => ids.has(id)));
    return {
      listing: { folders, objects, token, truncated, loading: false, loadingMore: false, error: null },
      selection: selection.size === s.selection.size ? s.selection : selection,
      anchor: s.anchor && ids.has(s.anchor) ? s.anchor : null,
      focus: s.focus && ids.has(s.focus) ? s.focus : null,
    };
  });
}

export async function loadMore() {
  const { bucket, prefix, listing } = get();
  if (!bucket || !listing.truncated || !listing.token || listing.loadingMore || listing.loading) return;
  const seq = listSeq;
  set({ listing: { ...listing, loadingMore: true } });
  try {
    const page = await fetchPage(bucket, prefix, listing.token, seq);
    if (seq !== listSeq) return;
    const cur = get().listing;
    // De-duplicate: entries upserted locally (finished uploads, new folders) may also arrive in a later page.
    const haveFolders = new Set(cur.folders.map((f) => f.prefix));
    const haveObjects = new Set(cur.objects.map((o) => o.key));
    set({
      listing: {
        ...cur,
        folders: cur.folders.concat(page.folders.filter((f) => !haveFolders.has(f.prefix))),
        objects: cur.objects.concat(page.objects.filter((o) => !haveObjects.has(o.key))),
        token: page.nextContinuationToken,
        truncated: page.isTruncated,
        loadingMore: false,
      },
    });
  } catch (e) {
    if (seq !== listSeq) return;
    set({ listing: { ...get().listing, loadingMore: false, error: e as AppError } });
  }
}

/** Insert or update an object in the current listing (after an upload completes). */
export function upsertListedObject(bucket: string, obj: ObjectEntry) {
  const s = get();
  if (s.bucket !== bucket || s.listing.loading) return;
  const objects = s.listing.objects.slice();
  const i = objects.findIndex((o) => o.key === obj.key);
  if (i >= 0) objects[i] = obj;
  else objects.push(obj);
  set({ listing: { ...s.listing, objects } });
}

/** Ensure a sub-folder entry exists in the current listing (after an upload into a new sub-path). */
export function upsertListedFolder(bucket: string, folder: FolderEntry) {
  const s = get();
  if (s.bucket !== bucket || s.listing.loading) return;
  if (s.listing.folders.some((f) => f.prefix === folder.prefix)) return;
  set({ listing: { ...s.listing, folders: [...s.listing.folders, folder] } });
}

// ---- selection / view -----------------------------------------------------------------

export function setSelection(selection: Set<string>, anchor: string | null, focus: string | null) {
  // The user chose something else: stop looking for an object that was being revealed.
  set({ selection, anchor, focus, reveal: null });
}

export function setSort(key: SortKey) {
  const cur = get().sort;
  const sort: SortState = cur.key === key ? { key, dir: cur.dir === 1 ? -1 : 1 } : { key, dir: key === "modified" || key === "size" ? -1 : 1 };
  set({ sort });
  writePref("s3x.sort", sort);
}

/** The quick filter's row predicate (shared with the derived view in ./view.ts). */
export function matchesFilter(name: string, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  return !f || name.toLowerCase().includes(f);
}

/**
 * Change the quick filter. Selected rows the new filter hides are dropped from the selection
 * (and the anchor/focus if hidden), so an action never includes an item the user can't see.
 * Clearing the filter later does not bring them back.
 */
export function setFilter(filter: string) {
  set((s) => {
    if (!s.selection.size && !s.anchor && !s.focus) return { filter };
    const visible = new Set<string>();
    for (const f of s.listing.folders) if (matchesFilter(f.name, filter)) visible.add(f.prefix);
    for (const o of s.listing.objects) if (matchesFilter(o.name, filter)) visible.add(o.key);
    const selection = new Set([...s.selection].filter((id) => visible.has(id)));
    return {
      filter,
      selection: selection.size === s.selection.size ? s.selection : selection,
      anchor: s.anchor && visible.has(s.anchor) ? s.anchor : null,
      focus: s.focus && visible.has(s.focus) ? s.focus : null,
    };
  });
}

export function setDetailsOpen(open: boolean) {
  set({ detailsOpen: open });
  writePref("s3x.detailsOpen", open);
}

export function setTransfersOpen(open: boolean) {
  set({ transfersOpen: open });
}

export function openModal(modal: Modal) {
  set({ modal, contextMenu: null });
}

export function openContextMenu(menu: ContextMenuState | null) {
  set({ contextMenu: menu });
}
