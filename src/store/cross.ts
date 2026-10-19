// Transfers between an S3 pane and a local pane (v0.9.0, see "Transfers between panes" in
// docs/CONTRACT.md). S3 → local is a download (one transfer per object, one batch per folder) into
// the local directory; local → S3 an upload. A move is the same, then, for exactly the items whose
// transfer or batch ended `completed`, one delete job on S3 (download) or the recycle bin (upload).
//
// What is moved is captured when the action starts (a plan); the confirmation shows the plan, and
// Start sends exactly it. The pending deletes are kept here, in memory only: watched through the
// transfer and batch events (so removing a row from Activity changes nothing), dropped with the
// connection, and never persisted, so closing the app mid-way deletes nothing.

import * as api from "../lib/api";
import { JOB_MAX_ITEMS, type AppError, type Batch, type ConflictPolicy, type JobRequest, type Transfer } from "../lib/types";
import { asFolderPrefix, s3Uri, sanitizeFileName, uniqueFileName } from "../lib/format";
import { plural } from "../lib/ops";
import { activePane, getPane, isSplitShown, onConnectionChange, openModal, refreshLocalPanesAt, setTransfersOpen, shownOtherPane, useApp } from "./app";
import { isLocalPane, otherPane, type PaneId } from "./panes";
import { isBatchActive, onBatchFileFinished, onBatchUpdate, startBatch, useBatches } from "./batches";
import { isActive, onTransferFinished, scheduleTransferResync, useTransfers } from "./transfers";
import { requestTransferToOther, startConfirmedJob, tooMany, withoutArchived } from "./ops";
import { useSettings } from "./settings";
import { dropLocalSizes, isNetworkPath, sameLocalPath, selectedLocal, trashLocalPaths, typedParent } from "./local";
import { getSelected, getSelectionPrefix } from "./view";
import { toast, toastFailure } from "./toasts";

// ---- locations ---------------------------------------------------------------------------------

/** Where a pane is: a bucket and prefix, or a local directory. */
export type Loc = { kind: "s3"; bucket: string; prefix: string } | { kind: "local"; dir: string };

export function paneLoc(pane: PaneId): Loc | null {
  const s = getPane(pane);
  if (isLocalPane(s)) return { kind: "local", dir: s.local.dir };
  return s.bucket ? { kind: "s3", bucket: s.bucket, prefix: s.prefix } : null;
}

export const locLabel = (l: Loc) => (l.kind === "s3" ? s3Uri(l.bucket, l.prefix) : l.dir);

/** Why copy / move between these two kinds of location can't be done, or null. */
export function crossRefusal(from: Loc["kind"], to: Loc["kind"]): string | null {
  return from === "local" && to === "local" ? LOCAL_TO_LOCAL : null;
}

export const LOCAL_TO_LOCAL = "Copying or moving between two folders of this computer isn’t done here; use your file manager.";
export const LINK_MOVE = "Links can’t be moved; copy them instead.";

// ---- plans -------------------------------------------------------------------------------------

export type CrossItem =
  /** S3 object / folder, exact key or prefix as listed. */
  | { kind: "object"; key: string; name: string; size: number }
  | { kind: "prefix"; key: string; name: string }
  /** Local file / folder, exact path as listed. */
  | { kind: "file"; path: string; name: string; size: number; isSymlink: boolean }
  | { kind: "dir"; path: string; name: string; isSymlink: boolean };

export interface CrossPlan {
  id: number;
  direction: "download" | "upload";
  mode: "copy" | "cut";
  bucket: string;
  /** Download: the folder the objects were listed in. Upload: the destination prefix. */
  prefix: string;
  /** Download: the destination directory. Upload: the folder the files were listed in. */
  dir: string;
  items: CrossItem[];
  /**
   * The names already at the destination, listed when the action started: local names (download;
   * lower-cased unless the OS is case-sensitive) or S3 names at the prefix (upload, exact).
   * `complete`: the listing was not cut short, so a missing name means "not there".
   */
  existing: { files: Set<string>; dirs: Set<string>; complete: boolean };
  /** Upload only: names found by HeadObject when the listing was incomplete. */
  probed?: Set<string>;
  /**
   * v0.9.1: a move from a network location (no recycle bin). It uploads only: the files stay on the
   * share and nothing local is ever trashed (the confirmation says so).
   */
  stayOnShare: boolean;
}

const plans = new Map<number, CrossPlan>();
let planSeq = 0;
export const crossPlan = (id: number) => plans.get(id);
export const dropCrossPlan = (id: number) => plans.delete(id);

const localCaseInsensitive = api.clientOS !== "other";
export const localNameKey = (n: string) => (localCaseInsensitive ? n.toLowerCase() : n);

/** At most this many pages are listed to learn what is already at an S3 destination. */
const DEST_PAGES = 5;
/** At most this many HeadObject probes for upload conflicts the listing could not answer. */
const MAX_PROBES = 100;

async function listExisting(dest: Loc): Promise<CrossPlan["existing"]> {
  const files = new Set<string>();
  const dirs = new Set<string>();
  if (dest.kind === "local") {
    const l = await api.listLocalDir(dest.dir, true);
    for (const d of l.dirs) dirs.add(localNameKey(d.name));
    for (const f of l.files) files.add(localNameKey(f.name));
    return { files, dirs, complete: !l.truncated };
  }
  let token: string | null = null;
  for (let i = 0; i < DEST_PAGES; i++) {
    const page = await api.listObjects(dest.bucket, dest.prefix, token, 1000);
    for (const f of page.folders) dirs.add(f.name);
    for (const o of page.objects) files.add(o.name);
    token = page.nextContinuationToken;
    if (!page.isTruncated || !token) return { files, dirs, complete: true };
  }
  return { files, dirs, complete: false };
}

/**
 * Copy or move between two panes of different kinds (or between a pane and a location dropped
 * onto): build the plan from exactly `items` and open its confirmation, or start a copy right away
 * when nothing needs asking. Resolves once the dialog is open (or the reason was shown).
 */
export async function requestCross(p: { from: Loc; to: Loc; mode: "copy" | "cut"; items: CrossItem[]; srcPane: PaneId }) {
  const { from, to, mode } = p;
  const refused = crossRefusal(from.kind, to.kind);
  if (refused) {
    toast.info(mode === "copy" ? "Nothing was copied" : "Nothing was moved", refused);
    return;
  }
  if (from.kind === to.kind) return; // S3 → S3 is the job path, not this one.
  let items = p.items;
  if (!items.length) return;
  if (tooMany(items.length, mode === "copy" ? "copy" : "move")) return;
  if (from.kind === "s3") {
    // Archived objects that aren't restored can't be read: left out, with the reason.
    const kept = await withoutArchived(
      from.bucket,
      items.map((i) => (i.kind === "object" ? { key: i.key, isPrefix: false, name: i.name } : { key: (i as { key: string }).key, isPrefix: true, name: i.name })),
      mode === "copy" ? "download" : "move",
      p.srcPane,
    );
    if (!kept) return;
    const keep = new Set(kept.map((k) => k.key));
    items = items.filter((i) => keep.has((i as { key: string }).key));
  } else if (mode === "cut") {
    const links = items.filter((i) => (i.kind === "file" || i.kind === "dir") && i.isSymlink);
    if (links.length) {
      items = items.filter((i) => !links.includes(i));
      toast.info(links.length === 1 ? `“${links[0].name}” is a link: left where it is` : `${plural(links.length, "link")} left where they are`, LINK_MOVE);
      if (!items.length) return;
    }
  }
  document.body.classList.add("busy-cursor");
  let existing: CrossPlan["existing"];
  let probed: Set<string> | undefined;
  try {
    existing = await listExisting(to);
    if (to.kind === "s3" && !existing.complete) {
      // The destination is larger than what was listed: ask S3 about each file that wasn't seen.
      probed = new Set();
      const unknown = items.filter((i) => i.kind === "file" && !existing.files.has(i.name)).slice(0, MAX_PROBES);
      await Promise.all(
        unknown.map(async (i) => {
          try {
            await api.headObject(to.bucket, asFolderPrefix(to.prefix) + i.name);
            probed!.add(i.name);
          } catch {
            /* not there (or not readable): treated as new */
          }
        }),
      );
    }
  } catch (e) {
    toast.error("Couldn’t check the destination", `${locLabel(to)}\n${(e as AppError).message}`);
    return;
  } finally {
    document.body.classList.remove("busy-cursor");
  }
  const plan: CrossPlan = {
    id: ++planSeq,
    direction: from.kind === "s3" ? "download" : "upload",
    mode,
    bucket: from.kind === "s3" ? from.bucket : (to as { bucket: string }).bucket,
    prefix: from.kind === "s3" ? from.prefix : (to as { prefix: string }).prefix,
    dir: from.kind === "local" ? from.dir : (to as { dir: string }).dir,
    items,
    existing,
    probed,
    stayOnShare: from.kind === "local" && mode === "cut" && (isNetworkPath(from.dir) || items.some((i) => "path" in i && isNetworkPath(i.path))),
  };
  plans.set(plan.id, plan);
  // A plain copy of files with nothing in the way may start at once ("Ask before copying or moving"
  // off). Folders (batches) and every move always confirm.
  const confirm = useSettings.getState().settings?.confirmCopyMove ?? true;
  const simple = mode === "copy" && items.every((i) => i.kind === "object" || i.kind === "file");
  if (!confirm && simple) {
    const targets = await planTargets(plan);
    if (!targets.some((t) => t.conflict || t.blocked)) {
      await startPlan(plan, targets, "skip");
      plans.delete(plan.id);
      return;
    }
  }
  openModal({ kind: "crossTransfer", planId: plan.id });
}

/** The selection of a pane as cross items (folders first), exactly as listed. */
export function crossItemsOf(pane: PaneId): CrossItem[] {
  const s = getPane(pane);
  if (isLocalPane(s)) {
    return selectedLocal(pane).map((e) =>
      e.isDir ? { kind: "dir", path: e.path, name: e.name, isSymlink: e.isSymlink } : { kind: "file", path: e.path, name: e.name, size: e.size, isSymlink: e.isSymlink },
    );
  }
  const { folders, objects } = getSelected(pane);
  return [
    ...folders.map((f): CrossItem => ({ kind: "prefix", key: f.prefix, name: f.name })),
    ...objects.map((o): CrossItem => ({ kind: "object", key: o.key, name: o.name, size: o.size })),
  ];
}

/**
 * Copy / move the active pane's selection to the other pane when the two are of different kinds.
 * Returns false when this isn't a cross transfer (S3 → S3 goes through the existing job path).
 */
export function requestCrossToOther(mode: "copy" | "cut"): boolean {
  const src = activePane();
  const dest = shownOtherPane();
  if (!dest) return false;
  const from = paneLoc(src);
  const to = paneLoc(dest);
  if (!from || !to || (from.kind === "s3" && to.kind === "s3")) return false;
  if (to.kind === "s3" && getPane(dest).search.open) {
    toast.info("Close the search results in the other pane first", "Its folder is behind the results; nothing was copied or moved.");
    return true;
  }
  // Search results in an S3 source pane: the folder the hits share (display only; keys are exact).
  const fromLoc: Loc = from.kind === "s3" ? { ...from, prefix: getSelectionPrefix(src) } : from;
  void requestCross({ from: fromLoc, to, mode, items: crossItemsOf(src), srcPane: src });
  return true;
}

/** Whether "copy / move to the other pane" is possible right now between the two panes' kinds, and why not. */
export function otherPaneRefusal(): string | null {
  if (!isSplitShown()) return useApp.getState().split ? "The window is too narrow for two panes" : "Open the split view first";
  const a = paneLoc(activePane());
  const b = paneLoc(otherPane(activePane()));
  if (!a) return "Open a bucket or a folder first";
  if (!b) return "Open a bucket or a folder in the other pane first";
  return crossRefusal(a.kind, b.kind);
}

// ---- targets -----------------------------------------------------------------------------------

export interface CrossTarget {
  item: CrossItem;
  /** Download: the local path the object / folder is written to. Upload: the key / prefix. */
  dest: string;
  /** Something with this name is already at the destination (a file the policy decides about). */
  conflict: boolean;
  /** The name is taken by the other kind (a folder where a file would go, or the reverse): never started. */
  blocked: string | null;
}

/** Where each item goes and what is in the way, from the names listed when the plan was made. */
export async function planTargets(plan: CrossPlan): Promise<CrossTarget[]> {
  const out: CrossTarget[] = [];
  if (plan.direction === "download") {
    // Local names are sanitized and made unique within the selection (case-insensitively), so two
    // objects never target the same file; the existing names decide conflicts.
    const taken = new Set<string>();
    for (const item of plan.items) {
      const name = uniqueFileName(sanitizeFileName(item.name), taken);
      const k = localNameKey(name);
      const dest = await api.joinPath(plan.dir, name);
      if (item.kind === "object") {
        const blocked = plan.existing.dirs.has(k) ? `A folder named “${name}” is already there.` : null;
        out.push({ item, dest, conflict: !blocked && plan.existing.files.has(k), blocked });
      } else {
        const blocked = plan.existing.files.has(k) ? `A file named “${name}” is already there.` : null;
        out.push({ item, dest, conflict: false, blocked });
      }
    }
    return out;
  }
  const prefix = asFolderPrefix(plan.prefix);
  for (const item of plan.items) {
    if (item.kind === "file") {
      const blocked = plan.existing.dirs.has(item.name) ? `A folder “${item.name}/” is already there.` : null;
      const there = plan.existing.files.has(item.name) || !!plan.probed?.has(item.name);
      out.push({ item, dest: prefix + item.name, conflict: !blocked && there, blocked });
    } else {
      out.push({ item, dest: prefix + item.name + "/", conflict: false, blocked: null });
    }
  }
  return out;
}

// ---- starting, and the pending deletes of a move -------------------------------------------------

/** One started transfer or batch of a move. */
interface Tracked {
  kind: "transfer" | "batch";
  id: string;
}

/**
 * One source to remove once its copy completed: an S3 object key (download; with the ETag the
 * download was pinned to, so the delete is conditional) or a local file path (upload). Never a
 * prefix or a folder: a folder's files are listed one by one from its batch's completed transfers.
 */
interface Done {
  source: string;
  etag: string | null;
}

interface PendingMove {
  seq: number;
  direction: "download" | "upload";
  bucket: string;
  label: string;
  /** Tracked transfers and batches still running, by id. */
  waiting: Map<string, Tracked>;
  completed: Done[];
  /** Items that ended otherwise (failed, cancelled, skipped, or never started). */
  kept: number;
  /** Still starting: don't finish before every item was started. */
  starting: boolean;
  /**
   * Fallback only (when `list_transfers` can't be read): the completed per-file transfers of this
   * move's batches seen in events, by batch id.
   */
  batchFiles: Map<string, Map<string, Done>>;
  /** Batches that finished and are being closed (their completed files being read), by id. */
  batchClosing: Map<string, { batch: Batch; timer: ReturnType<typeof setTimeout> | null }>;
}

const pending = new Set<PendingMove>();
let moveSeq = 0;

/** Pending moves (test and debugging aid; nothing outside reads it to decide). */
export const pendingMoveCount = () => pending.size;

/** The source of a completed transfer of a move: the key on S3 (download) or the local path (upload). */
const doneOf = (direction: PendingMove["direction"], t: Transfer): Done =>
  direction === "download" ? { source: t.key, etag: t.etag ?? null } : { source: t.localPath, etag: null };

/**
 * Start a confirmed plan: exactly its targets, minus the blocked ones and (with `skip`) the
 * conflicting files. A move also registers the delete that follows. Resolves with the count started.
 */
export async function startPlan(plan: CrossPlan, targets: CrossTarget[], onConflict: ConflictPolicy): Promise<number> {
  // A move from a network location uploads only: no pending trash is ever registered for it.
  const move: PendingMove | null =
    plan.mode === "cut" && !plan.stayOnShare
      ? {
          seq: ++moveSeq,
          direction: plan.direction,
          bucket: plan.bucket,
          label: plan.direction === "download" ? `to ${plan.dir}` : `to ${s3Uri(plan.bucket, plan.prefix)}`,
          waiting: new Map(),
          completed: [],
          kept: 0,
          starting: true,
          batchFiles: new Map(),
          batchClosing: new Map(),
        }
      : null;
  if (move) pending.add(move);
  let started = 0;
  const failures: string[] = [];
  for (const t of targets) {
    if (t.blocked || (t.conflict && onConflict === "skip")) {
      if (move) move.kept++;
      continue;
    }
    try {
      let tracked: Tracked;
      const it = t.item;
      if (it.kind === "object") {
        tracked = { kind: "transfer", id: await api.startDownload(plan.bucket, it.key, t.dest) };
      } else if (it.kind === "prefix") {
        tracked = { kind: "batch", id: await startBatch({ kind: "download", bucket: plan.bucket, prefix: it.key, localPath: t.dest, onConflict }) };
      } else if (it.kind === "file") {
        tracked = { kind: "transfer", id: await api.startUpload(plan.bucket, t.dest, it.path) };
      } else {
        tracked = { kind: "batch", id: await startBatch({ kind: "upload", bucket: plan.bucket, prefix: t.dest, localPath: it.path, onConflict }) };
      }
      started++;
      if (move) {
        move.waiting.set(tracked.id, tracked);
        if (tracked.kind === "batch") move.batchFiles.set(tracked.id, new Map());
        // It may have finished before it was registered here.
        settleIfFinished(move, tracked);
      }
    } catch (e) {
      if (move) move.kept++;
      failures.push(`${t.item.name}: ${(e as AppError).message}`);
    }
  }
  if (failures.length) {
    toastFailure(
      started ? `${plural(failures.length, "item")} didn’t start` : `Nothing was ${plan.direction === "download" ? "downloaded" : "uploaded"}`,
      failures.slice(0, 8).join("\n"),
      plan.direction === "download" ? "download files" : "upload files",
    );
  }
  if (started) {
    setTransfersOpen(true);
    scheduleTransferResync();
    const verb = plan.direction === "download" ? (plan.mode === "cut" ? "Moving" : "Downloading") : plan.mode === "cut" && !plan.stayOnShare ? "Moving" : "Uploading";
    toast.info(
      `${verb} ${plural(started, "item")}`,
      plan.direction === "download" ? `to ${plan.dir}` : `to ${s3Uri(plan.bucket, plan.prefix)}${plan.stayOnShare ? ". The files stay on the network location." : ""}`,
    );
  }
  if (move) {
    move.starting = false;
    maybeFinish(move);
  }
  return started;
}

function settleIfFinished(move: PendingMove, t: Tracked) {
  if (t.kind === "transfer") {
    const cur = useTransfers.getState().byId[t.id];
    if (cur && !isActive(cur)) settleTransfer(move, cur);
  } else {
    const cur = useBatches.getState().byId[t.id];
    if (cur && !isBatchActive(cur)) settleBatch(move, cur);
  }
}

/** A single transfer of a move ended: only `completed` counts. */
function settleTransfer(move: PendingMove, t: Transfer) {
  if (!move.waiting.has(t.id)) return;
  move.waiting.delete(t.id);
  if (t.status === "completed") move.completed.push(doneOf(move.direction, t));
  else move.kept++;
  maybeFinish(move);
}

/** How long a finished batch waits for its last file events, when `list_transfers` can't be read. */
const BATCH_FILES_WAIT_MS = 3000;

/**
 * A batch of a move finished: its sources are exactly the per-file transfers that ended
 * `completed`, read from `list_transfers` (by batch id). Never the prefix or the folder: folder
 * markers, entries the planner skipped, links, files added after planning and emptied folders stay.
 */
function settleBatch(move: PendingMove, b: Batch) {
  if (!move.waiting.has(b.id) || move.batchClosing.has(b.id)) return;
  move.batchClosing.set(b.id, { batch: b, timer: null });
  void api
    .listTransfers()
    .then((all) => {
      const done = all.filter((t) => t.batchId === b.id && t.status === "completed").map((t) => doneOf(move.direction, t));
      closeBatch(move, b.id, done);
    })
    .catch(() => {
      // Fallback: the completed files seen in events, once as many as the batch reports done arrived (bounded wait).
      const closing = move.batchClosing.get(b.id);
      if (!closing) return;
      closing.timer = setTimeout(() => closeBatch(move, b.id, [...(move.batchFiles.get(b.id)?.values() ?? [])]), BATCH_FILES_WAIT_MS);
      maybeCloseFromEvents(move, b.id);
    });
}

function maybeCloseFromEvents(move: PendingMove, id: string) {
  const closing = move.batchClosing.get(id);
  const files = move.batchFiles.get(id);
  if (closing?.timer && files && files.size >= closing.batch.doneFiles) closeBatch(move, id, [...files.values()]);
}

function closeBatch(move: PendingMove, id: string, done: Done[]) {
  const closing = move.batchClosing.get(id);
  if (!closing || !move.waiting.has(id)) return;
  if (closing.timer) clearTimeout(closing.timer);
  move.batchClosing.delete(id);
  move.batchFiles.delete(id);
  move.waiting.delete(id);
  move.completed.push(...done);
  const notDone = Math.max(0, closing.batch.totalFiles - done.length);
  move.kept += done.length ? notDone : Math.max(1, notDone);
  maybeFinish(move);
}

function maybeFinish(move: PendingMove) {
  if (move.starting || move.waiting.size) return;
  pending.delete(move);
  const done = move.completed;
  const total = done.length + move.kept;
  if (!done.length) {
    if (total) toast.warning("Nothing was moved", `None of the ${plural(total, "item")} finished, so ${move.direction === "download" ? "nothing was deleted from S3" : "nothing was moved to the recycle bin"}.`);
    return;
  }
  const partial = move.kept > 0 ? ` ${plural(move.kept, "item")} that didn’t finish ${move.kept === 1 ? "stays" : "stay"} where ${move.kept === 1 ? "it is" : "they are"}.` : "";
  if (move.direction === "download") {
    // Exactly the object keys whose download completed, verbatim, never a prefix, each with the ETag
    // its download was pinned to: the delete is conditional, so an object rewritten meanwhile stays
    // (the job reports it). One job (one per 10,000 keys, the job limit, for a very large folder).
    for (let i = 0; i < done.length; i += JOB_MAX_ITEMS) {
      const request: JobRequest = {
        kind: "delete",
        srcBucket: move.bucket,
        destBucket: null,
        items: done.slice(i, i + JOB_MAX_ITEMS).map((d) => ({ from: d.source, to: null, isPrefix: false, etag: d.etag })),
        onConflict: "skip",
      };
      void startConfirmedJob(request, { openPanel: false }).then((id) => {
        if (id && i === 0) toast.info(`Moved ${plural(done.length, "object")} ${move.label}`, `Deleting ${done.length === 1 ? "it" : "them"} from S3 now.${partial}`);
      });
    }
  } else {
    // Exactly the local files whose upload completed (a folder's own files one by one, never the
    // folder). Never a file on a network location (no recycle bin; such a move never gets here).
    const paths = done.map((d) => d.source).filter((p) => !isNetworkPath(p));
    if (!paths.length) return;
    void trashLocalPaths(paths, `Moved ${plural(done.length, "file")} ${move.label}`).then(() => {
      if (partial) toast.info("Some items were not moved", partial.trim());
    });
  }
}

/** Install once (Explorer): settle pending moves from transfer / batch events, refresh local panes after downloads. */
export function installCrossEffects(): () => void {
  const offT = onTransferFinished((t: Transfer) => {
    for (const m of [...pending]) if (m.waiting.has(t.id)) settleTransfer(m, t);
    if (t.kind === "download" && t.status === "completed") localChanged(typedParent(t.localPath) ?? t.localPath);
  });
  const offB = onBatchUpdate((b: Batch, prev) => {
    const finished = !isBatchActive(b) && (!prev || isBatchActive(prev));
    if (finished) for (const m of [...pending]) if (m.waiting.has(b.id)) settleBatch(m, b);
    if (b.kind === "download" && (finished || (prev && prev.doneFiles !== b.doneFiles))) localChanged(b.localPath);
  });
  // The files of a batch of a move, for the fallback above.
  const offF = onBatchFileFinished((t: Transfer) => {
    if (t.status !== "completed" || !t.batchId) return;
    for (const m of pending) {
      const files = m.batchFiles.get(t.batchId);
      if (!files) continue;
      files.set(t.id, doneOf(m.direction, t));
      maybeCloseFromEvents(m, t.batchId);
    }
  });
  // A new connection or a disconnect: a delete must never reach another connection's bucket.
  const offC = onConnectionChange((key) => {
    if (key !== null || !pending.size) return;
    const n = pending.size;
    for (const m of pending) for (const c of m.batchClosing.values()) if (c.timer) clearTimeout(c.timer);
    pending.clear();
    toast.info(n === 1 ? "A move was stopped" : `${n} moves were stopped`, "Nothing more is deleted for them; their sources are kept.");
  });
  return () => {
    offT();
    offB();
    offF();
    offC();
  };
}

/** Local folders changed by downloads: list them again, at most every 1.5 s per folder. */
const changedAt = new Map<string, ReturnType<typeof setTimeout>>();
function localChanged(path: string) {
  const k = localNameKey(path);
  dropLocalSizes(path);
  if (changedAt.has(k)) return;
  changedAt.set(
    k,
    setTimeout(() => {
      changedAt.delete(k);
      refreshLocalPanesAt(path);
    }, 300),
  );
}

/** For the drag badge and drop: is `dir` the local folder `items` come from (a no-op drop)? */
export const sameLocalDir = sameLocalPath;

/**
 * Copy / move to the other pane, whatever the two panes show: between S3 and this computer the
 * transfers here; S3 → S3 the existing job (paste-like confirmation).
 */
export function transferToOtherPane(mode: "copy" | "cut") {
  if (!requestCrossToOther(mode)) void requestTransferToOther(mode);
}
