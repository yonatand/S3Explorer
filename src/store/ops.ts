// User-level object operations: delete, rename, copy/cut/paste. Everything that changes data
// goes through a confirmation modal that previews the exact request (see components/JobModals).

import * as api from "../lib/api";
import { JOB_MAX_ITEMS, type AppError, type Job, type JobItem, type JobRequest } from "../lib/types";
import { copyName, isJobActive, KIND_VERB, plural, touchesPrefix } from "../lib/ops";
import { s3Uri } from "../lib/format";
import { openModal, refreshInPlace, setTransfersOpen, useApp } from "./app";
import { clearClipboard, setClipboard, useClipboard, type ClipItem } from "./clipboard";
import { jobRequest, onJobUpdate, rememberJobRequest, useJobs } from "./jobs";
import { notifyInBackground } from "./notify";
import { useSettings } from "./settings";
import { toast, toastFailure } from "./toasts";
import { getSelected, getSelectionPrefix } from "./view";
import { ARCHIVED_MESSAGE, isArchiveClass, splitReadable, toastArchivedSkipped } from "./archive";

/** The current selection as clip items (exact keys/prefixes), folders first. */
export function selectedItems(): ClipItem[] {
  const { folders, objects } = getSelected();
  return [
    ...folders.map((f) => ({ key: f.prefix, isPrefix: true, name: f.name })),
    ...objects.map((o) => ({ key: o.key, isPrefix: false, name: o.name })),
  ];
}

export function tooMany(count: number, what: string): boolean {
  if (count <= JOB_MAX_ITEMS) return false;
  toast.error(
    `Too many items to ${what}`,
    `${count.toLocaleString()} items are selected; one operation can include at most ${JOB_MAX_ITEMS.toLocaleString()}. ` +
      "Select fewer items, or select the folder that contains them (a folder counts as one item).",
  );
  return true;
}

// ---- delete ---------------------------------------------------------------------------

export function requestDelete() {
  const { bucket } = useApp.getState();
  const items = selectedItems();
  if (!bucket || !items.length) return;
  if (tooMany(items.length, "delete")) return;
  const request: JobRequest = {
    kind: "delete",
    srcBucket: bucket,
    destBucket: null,
    // Verbatim: never normalize a server-provided key or prefix.
    items: items.map((i) => ({ from: i.key, to: null, isPrefix: i.isPrefix })),
    onConflict: "skip",
  };
  openModal({ kind: "delete", request });
}

// ---- tags -----------------------------------------------------------------------------------

/** Edit the tags of the selection: one object opens its tag editor; anything else a bulk tag job. */
export function requestBulkTags() {
  const { bucket } = useApp.getState();
  const prefix = getSelectionPrefix();
  const items = selectedItems();
  if (!bucket || !items.length) return;
  if (tooMany(items.length, "tag")) return;
  openModal({
    kind: "bulkTags",
    bucket,
    prefix,
    // Verbatim: never normalize a server-provided key or prefix.
    items: items.map((i) => ({ from: i.key, to: null, isPrefix: i.isPrefix })),
  });
}

// ---- archived objects ------------------------------------------------------------------------

/**
 * Leave out objects that are archived and not restored (they can't be copied or moved), with a
 * toast naming how many. Folders are kept: the backend fails archived objects inside per object.
 * Returns null when nothing is left.
 */
export async function withoutArchived(bucket: string, items: ClipItem[], action: string): Promise<ClipItem[] | null> {
  // The storage class as listed: the open folder's rows, or the selected search hits.
  const listed = new Map([...useApp.getState().listing.objects, ...getSelected().objects].map((o) => [o.key, o]));
  const objects = items.filter((i) => !i.isPrefix).map((i) => ({ key: i.key, storageClass: listed.get(i.key)?.storageClass ?? null }));
  const { blocked } = await splitReadable(bucket, objects);
  if (!blocked.length) return items;
  const out = new Set(blocked.map((o) => o.key));
  const kept = items.filter((i) => i.isPrefix || !out.has(i.key));
  if (!kept.length) {
    toast.error(items.length === 1 ? `Can’t ${action} “${items[0].name}”` : `Can’t ${action} these objects`, `${ARCHIVED_MESSAGE}.`);
    return null;
  }
  toastArchivedSkipped(blocked.length, action);
  return kept;
}

/**
 * Restore archived objects in the selection: one archived object opens the single restore dialog;
 * anything else (several, or folders) a "restore" job over the selected folders and archived objects.
 */
export function requestRestoreArchived() {
  const { bucket } = useApp.getState();
  const prefix = getSelectionPrefix();
  const { folders, objects } = getSelected();
  if (!bucket) return;
  const archived = objects.filter((o) => isArchiveClass(o.storageClass));
  if (!folders.length && objects.length === 1 && archived.length === 1) {
    openModal({ kind: "restore", bucket, key: archived[0].key, storageClass: archived[0].storageClass });
    return;
  }
  // Objects that aren't in an archive class would only be skipped: they are left out of the request.
  const items: JobItem[] = [
    ...folders.map((f) => ({ from: f.prefix, to: null, isPrefix: true })),
    ...archived.map((o) => ({ from: o.key, to: null, isPrefix: false })),
  ];
  if (!items.length) {
    toast.info("Nothing to restore", "None of the selected objects is archived.");
    return;
  }
  if (tooMany(items.length, "restore")) return;
  const deep = archived.filter((o) => o.storageClass === "DEEP_ARCHIVE").length;
  openModal({ kind: "bulkRestore", bucket, prefix, items, deepArchive: deep > 0, allDeep: !folders.length && deep === archived.length });
}

// ---- rename -------------------------------------------------------------------------------

export async function requestRename() {
  const { bucket } = useApp.getState();
  const items = selectedItems();
  if (!bucket || items.length !== 1) return;
  if (!(await withoutArchived(bucket, items, "rename"))) return;
  const it = items[0];
  // The parent is the exact key minus the exact name (and the folder's trailing "/").
  const tail = it.name.length + (it.isPrefix ? 1 : 0);
  const parent = it.key.slice(0, it.key.length - tail);
  if (it.key !== parent + it.name + (it.isPrefix ? "/" : "")) {
    toast.error("Can’t rename this item", "Its name doesn’t match its key.");
    return;
  }
  openModal({ kind: "rename", target: { bucket, key: it.key, isPrefix: it.isPrefix, name: it.name, parent } });
}

// ---- clipboard ------------------------------------------------------------------------------

export async function copySelection(mode: "copy" | "cut") {
  const { bucket } = useApp.getState();
  // Search results can come from several folders: the clipboard names the folder they share.
  const prefix = getSelectionPrefix();
  const selected = selectedItems();
  if (!bucket || !selected.length) return;
  if (tooMany(selected.length, mode === "copy" ? "copy" : "move")) return;
  const items = await withoutArchived(bucket, selected, mode === "copy" ? "copy" : "move");
  if (!items) return;
  setClipboard(mode, bucket, prefix, items);
  toast.info(
    `${plural(items.length, "item")} ${mode === "copy" ? "copied" : "cut"}`,
    `Open the destination folder and paste (Ctrl+V).`,
  );
}

/** Items to copy or move: where they come from (exact keys, as listed) and how. */
export interface TransferSource {
  mode: "copy" | "cut";
  bucket: string;
  /** The folder the items were listed in. */
  prefix: string;
  items: ClipItem[];
}

/** The folder the items go to. `taken` = names already in it, to suggest "(copy)" names (paste only). */
export interface TransferDest {
  bucket: string;
  prefix: string;
  taken?: { objects: Set<string>; folders: Set<string> };
}

/**
 * The copy/move request for `src` into `dest`, built the same way for paste and for drag and drop:
 * `to = dest.prefix + name` (folders with a trailing "/"), keys passed through verbatim. Returns the
 * reason when it can't be done; nothing is sent then.
 */
export function buildTransferRequest(
  src: TransferSource,
  dest: TransferDest,
): { ok: true; request: JobRequest; renamed: boolean } | { ok: false; title: string; detail?: string; info?: boolean } {
  const sameBucket = src.bucket === dest.bucket;
  const sameFolder = sameBucket && src.prefix === dest.prefix;
  if (sameFolder && (src.mode === "cut" || !dest.taken)) {
    return { ok: false, info: true, title: src.mode === "cut" ? "Nothing to move" : "Nothing to copy", detail: "The items are already in this folder." };
  }
  // A folder can't go into itself or anything inside it.
  if (sameBucket) {
    const into = src.items.find((i) => i.isPrefix && dest.prefix.startsWith(i.key));
    if (into) {
      return {
        ok: false,
        // `taken` is only passed by paste, which keeps its own wording.
        title: `Can’t ${dest.taken ? "paste" : src.mode === "cut" ? "move" : "copy"} a folder into itself`,
        detail: `“${into.key}” would be ${src.mode === "cut" ? "moved" : "copied"} into ${dest.prefix === into.key ? "itself" : `its own subfolder “${dest.prefix}”`}.`,
      };
    }
  }
  // Items picked from search results can come from several folders. When only some of them are
  // already in the destination, a copy would duplicate those and a move would be a no-op on
  // them: refuse instead of guessing.
  if (sameBucket) {
    const parentOf = (i: ClipItem) => i.key.slice(0, i.key.length - i.name.length - (i.isPrefix ? 1 : 0));
    const here = src.items.filter((i) => parentOf(i) === dest.prefix).length;
    if (here > 0 && here < src.items.length) {
      return {
        ok: false,
        info: true,
        title: "Some items are already in this folder",
        detail: `${plural(here, "item")} of ${src.items.length} are already in “${dest.prefix || "the top of the bucket"}”. Copy or cut only the others.`,
      };
    }
  }
  let renamed = false;
  const items: JobItem[] = [];
  if (sameFolder && dest.taken) {
    // Copy into the same folder: suggest "name (copy).ext" so the request is valid.
    const takenObjects = new Set(dest.taken.objects);
    const takenFolders = new Set(dest.taken.folders);
    for (const it of src.items) {
      const taken = it.isPrefix ? takenFolders : takenObjects;
      const name = copyName(it.name, it.isPrefix, taken);
      taken.add(name);
      renamed = true;
      items.push({ from: it.key, to: dest.prefix + name + (it.isPrefix ? "/" : ""), isPrefix: it.isPrefix });
    }
  } else {
    for (const it of src.items) {
      items.push({ from: it.key, to: dest.prefix + it.name + (it.isPrefix ? "/" : ""), isPrefix: it.isPrefix });
    }
  }
  const request: JobRequest = {
    kind: src.mode === "cut" ? "move" : "copy",
    srcBucket: src.bucket,
    destBucket: dest.bucket,
    items,
    onConflict: "skip",
  };
  return { ok: true, request, renamed };
}

/** Build the paste request for the current folder, or explain why it can’t be done. */
export function requestPaste() {
  const { bucket, prefix, listing } = useApp.getState();
  const clip = useClipboard.getState().clip;
  if (!bucket || !clip || !clip.items.length) return;
  if (tooMany(clip.items.length, "paste")) return;
  const built = buildTransferRequest(clip, {
    bucket,
    prefix,
    taken: { objects: new Set(listing.objects.map((o) => o.name)), folders: new Set(listing.folders.map((f) => f.name)) },
  });
  if (!built.ok) {
    if (built.info) toast.info(built.title, built.detail);
    else toast.error(built.title, built.detail);
    return;
  }
  void confirmOrStart({
    request: built.request,
    mode: clip.mode,
    srcPrefix: clip.prefix,
    destPrefix: prefix,
    renamed: built.renamed,
    clearCut: clip.mode === "cut",
  });
}

let checking = false;

/**
 * Show the copy/move confirmation, or (with "Ask before copying or moving" off) start right away
 * when the preview finds nothing in the way. Conflicts, an empty preview or a preview error always
 * open the dialog, which shows them; the request started is exactly the one previewed.
 */
export async function confirmOrStart(p: {
  request: JobRequest;
  mode: "copy" | "cut";
  srcPrefix: string;
  destPrefix: string;
  renamed: boolean;
  /** Empty the in-app clipboard once the job starts (a paste of cut items; not a drag). */
  clearCut: boolean;
}) {
  const confirm = useSettings.getState().settings?.confirmCopyMove ?? true;
  const dialog = () => openModal({ kind: "paste", ...p });
  if (confirm || p.renamed) {
    dialog();
    return;
  }
  if (checking) {
    // One preview at a time; say so instead of dropping the request silently.
    toast.info("Another drop is still being prepared", "Nothing was started for this one. Try again in a moment.");
    return;
  }
  checking = true;
  document.body.classList.add("busy-cursor");
  try {
    let preview;
    try {
      preview = await api.previewJob(p.request);
    } catch {
      dialog(); // shows the error, with Retry
      return;
    }
    if (preview.conflicts > 0 || preview.objects === 0) {
      dialog();
      return;
    }
    // Nothing in the way: "skip" is sent, so anything that appears at the destination meanwhile is kept.
    const request: JobRequest = { ...p.request, onConflict: "skip" };
    const id = await startConfirmedJob(request, { clearCut: p.clearCut, openPanel: false });
    if (!id) return;
    const n = p.request.items.length;
    toast.info(
      `${p.mode === "cut" ? "Moving" : "Copying"} ${plural(n, "item")} to ${s3Uri(request.destBucket ?? "", p.destPrefix)}`,
      `${plural(preview.objects, "object")}${preview.truncated ? " or more" : ""}. Nothing at the destination is overwritten.`,
      { label: "View", run: () => openJobDetails(id) },
    );
  } finally {
    checking = false;
    document.body.classList.remove("busy-cursor");
  }
}

// ---- starting jobs -------------------------------------------------------------------------

const PERMISSION_ACTION: Record<JobRequest["kind"], string> = {
  delete: "delete files",
  copy: "copy files",
  move: "move files",
  tag: "change tags",
  restore: "restore archived files",
};

/** Start a confirmed job. Returns the job id, or null after showing the error. */
export async function startConfirmedJob(
  request: JobRequest,
  opts: { clearCut?: boolean; openPanel?: boolean } = {},
): Promise<string | null> {
  try {
    const id = await api.startJob(request);
    rememberJobRequest(id, request);
    if (opts.clearCut) clearClipboard();
    if (opts.openPanel !== false) setTransfersOpen(true);
    return id;
  } catch (e) {
    toastFailure(`Couldn’t start the ${KIND_VERB[request.kind].noun}`, e as AppError, PERMISSION_ACTION[request.kind]);
    return null;
  }
}

// ---- effects: keep the listing in sync and report results -----------------------------------

function touchesView(job: Job): boolean {
  const { bucket, prefix } = useApp.getState();
  if (!bucket) return false;
  const req = jobRequest(job.id);
  if (!req) return job.srcBucket === bucket || job.destBucket === bucket;
  for (const it of req.items) {
    if (req.srcBucket === bucket && touchesPrefix(it.from, prefix)) return true;
    if (req.destBucket === bucket && it.to !== null && touchesPrefix(it.to, prefix)) return true;
  }
  return false;
}

export function openJobDetails(id: string) {
  useJobs.getState().setExpanded(id, true);
  setTransfersOpen(true);
  requestAnimationFrame(() => document.getElementById(`job-${id}`)?.scrollIntoView({ block: "nearest" }));
}

function reportFinished(j: Job) {
  const verb = KIND_VERB[j.kind];
  const view = { label: "View", run: () => openJobDetails(j.id) };
  if (j.status === "cancelled") {
    const processed = j.doneItems + j.skippedItems + j.failedItems;
    toast.info(
      `${verb.present} cancelled`,
      `${j.label}\n${processed.toLocaleString()} of ${j.totalItems.toLocaleString()} objects were processed before it stopped` +
        (j.kind === "move" ? ". Objects moved so far are in the destination; the rest are still in the source." : "."),
      view,
    );
    return;
  }
  if (j.status === "failed" && j.error) {
    toast.error(`${verb.present} failed`, `${j.label}\n${j.error}`, view);
    return;
  }
  // A restore job only asks S3: the objects become readable hours later.
  const restore = j.kind === "restore";
  const parts = [restore ? `restore requested for ${plural(j.doneItems, "object")}` : `${plural(j.doneItems, "object")} ${verb.past.toLowerCase()}`];
  if (j.skippedItems) {
    parts.push(
      j.kind === "restore"
        ? `${j.skippedItems.toLocaleString()} skipped (not archived, or already being restored)`
        : `${j.skippedItems.toLocaleString()} skipped (already existed)`,
    );
  }
  if (j.failedItems) parts.push(`${j.failedItems.toLocaleString()} failed`);
  if (j.failedItems || j.skippedItems) {
    const title = j.failedItems ? `${verb.present} finished with ${plural(j.failedItems, "failure")}` : `${verb.present} finished, some skipped`;
    toast.warning(title, `${j.label}\n${parts.join(" · ")}`, view);
  } else {
    toast.success(restore ? `Restore requested for ${plural(j.doneItems, "object")}` : `${verb.past} ${plural(j.doneItems, "object")}`, j.label);
  }
}

const REFRESH_EVERY_MS = 2000;
let lastRefresh = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Refresh the open listing in place: right away (`now`), or at most every 2 s while work is running. */
export function scheduleRefresh(now: boolean) {
  if (now) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    lastRefresh = Date.now();
    void refreshInPlace();
    return;
  }
  if (refreshTimer) return;
  const wait = Math.max(0, lastRefresh + REFRESH_EVERY_MS - Date.now());
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    lastRefresh = Date.now();
    void refreshInPlace();
  }, wait);
}

/** Install once (Explorer): listing refresh while jobs touch the visible folder, and completion toasts. */
export function installJobEffects(): () => void {
  const off = onJobUpdate((j, prev) => {
    const finished = !isJobActive(j) && (!prev || isJobActive(prev));
    if (finished) {
      reportFinished(j);
      if (j.status !== "cancelled") {
        notifyInBackground(`${KIND_VERB[j.kind].present} ${j.status === "failed" ? "failed" : "finished"}`, j.label);
      }
    }
    if (!touchesView(j)) return;
    if (finished) scheduleRefresh(true);
    else if (j.status === "running" && j.phase === "working" && (!prev || prev.doneItems !== j.doneItems)) scheduleRefresh(false);
  });
  return () => {
    off();
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
  };
}
