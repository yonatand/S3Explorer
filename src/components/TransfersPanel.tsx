import { memo, useCallback, useEffect, useMemo, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { create } from "zustand";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  FolderInput,
  FolderSearch,
  Trash2,
  X,
  CircleStop,
  CheckCircle2,
  XCircle,
  Clock,
  Ban,
  Tags,
  ArchiveRestore,
  FolderDown,
  FolderUp,
  ClipboardCopy,
  ExternalLink,
  LocateFixed,
} from "lucide-react";
import * as api from "../lib/api";
import type { AppError, Batch, BatchStatus, Job, JobKind, Transfer, TransferStatus } from "../lib/types";
import { isActive, selectActiveCount, useTransfers } from "../store/transfers";
import { jobRequest, removeJobs, selectActiveJobCount, useJobs } from "../store/jobs";
import { batchFraction, cancelBatch, isBatchActive, removeBatches, selectActiveBatchCount, useBatches } from "../store/batches";
import { navigate, revealObject, setTransfersOpen, useApp } from "../store/app";
import { closeSearch } from "../store/search";
import { copyText } from "../store/actions";
import { PopupMenu, type PopupMenuItem } from "./PopupMenu";
import { toast } from "../store/toasts";
import { basename, formatBytes, formatDuration, formatSpeed, refusedToOpen } from "../lib/format";
import { isJobActive, jobFraction, plural } from "../lib/ops";
import { shortVersionId, useVersionDownloads } from "../store/versions";

const STATUS_LABEL: Record<TransferStatus, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATUS_ICON: Record<TransferStatus, typeof Clock | null> = {
  queued: Clock,
  running: null,
  completed: CheckCircle2,
  failed: XCircle,
  cancelled: Ban,
};

async function cancel(id: string) {
  try {
    await api.cancelTransfer(id);
  } catch {
    /* unknown or already finished: nothing to do */
  }
}

/** Forget finished transfers. Active ones are skipped (the backend rejects them). */
async function removeTransfers(ids: string[]) {
  const { byId, remove } = useTransfers.getState();
  const finished = ids.filter((id) => !byId[id] || !isActive(byId[id]));
  const removed: string[] = [];
  for (const id of finished) {
    try {
      await api.removeTransfer(id);
      removed.push(id);
    } catch (e) {
      const err = e as AppError;
      // Unknown on the backend means it is already gone; drop it locally too.
      if (err.code === "InvalidInput" && byId[id] && isActive(byId[id])) continue;
      removed.push(id);
    }
  }
  remove(removed);
}

async function reveal(t: Pick<Transfer, "localPath">) {
  try {
    await api.revealInFolder(t.localPath);
  } catch (e) {
    toast.error("Could not show file", e as AppError);
  }
}

const TransferRow = memo(function TransferRow({ id }: { id: string }) {
  const t = useTransfers((s) => s.byId[id]);
  const versionId = useVersionDownloads((s) => s.byTransfer[id]);
  if (!t) return null;
  // A download of an older version says which one (the Transfer itself carries no label).
  const name = versionId ? `${basename(t.key)} (version ${shortVersionId(versionId)})` : basename(t.key);
  const pct = t.totalBytes > 0 ? Math.min(100, (t.transferredBytes / t.totalBytes) * 100) : 0;
  // Uploads only advance per completed part: show an indeterminate bar until bytes move.
  const indeterminate = (t.status === "running" && t.transferredBytes === 0) || t.status === "queued";
  const eta = t.status === "running" && t.bytesPerSec > 0 ? (t.totalBytes - t.transferredBytes) / t.bytesPerSec : NaN;
  const DirIcon = t.kind === "download" ? ArrowDownToLine : ArrowUpFromLine;
  const StatusIcon = STATUS_ICON[t.status];
  const where =
    t.kind === "download"
      ? `s3://${t.bucket}/${t.key}${versionId ? ` (version ${versionId})` : ""} → ${t.localPath}`
      : `${t.localPath} → s3://${t.bucket}/${t.key}`;
  return (
    <div className={`xrow status-${t.status}`} {...menuProps("transfer", id)}>
      <div className={`xdir ${t.kind}`} title={t.kind === "download" ? "Download" : "Upload"}>
        <DirIcon size={14} />
      </div>
      <div className="xname">
        <div className="xname-main" title={where}>
          {name}
        </div>
        <div className="xname-sub" title={t.error ?? where}>
          {t.status === "failed" && t.error ? <span className="err-text">{t.error}</span> : where}
        </div>
      </div>
      <div className="xprogress">
        <div className={`pbar ${indeterminate ? "indeterminate" : ""} ${t.status === "queued" ? "queued" : ""}`}>
          {!indeterminate && <div className="pbar-fill" style={{ transform: `scaleX(${pct / 100})` }} />}
        </div>
        <div className="xbytes">
          {formatBytes(t.transferredBytes)} / {t.totalBytes ? formatBytes(t.totalBytes) : "?"}
        </div>
      </div>
      <div className="xnum xspeed">{t.status === "running" ? formatSpeed(t.bytesPerSec) : ""}</div>
      <div className="xnum xparts" title="Parts done / total">
        {t.partsTotal > 1 ? `${t.partsDone}/${t.partsTotal}` : ""}
      </div>
      <div className="xnum xeta">{t.status === "running" ? formatDuration(eta) : ""}</div>
      <div className={`xstatus s-${t.status}`}>
        {StatusIcon ? <StatusIcon size={13} /> : <span className="pulse-dot" />}
        {t.status === "running" ? (indeterminate ? "Starting" : `${pct.toFixed(0)}%`) : STATUS_LABEL[t.status]}
      </div>
      <div className="xactions">
        {t.kind === "download" && t.status === "completed" && (
          <button className="icon-btn" onClick={() => void reveal(t)} title="Show in folder">
            <FolderSearch size={14} />
          </button>
        )}
        {isActive(t) ? (
          <button className="icon-btn" onClick={() => void cancel(t.id)} title="Cancel">
            <CircleStop size={14} />
          </button>
        ) : (
          <button className="icon-btn" onClick={() => void removeTransfers([t.id])} title="Remove from list">
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
});

const JOB_ICON: Record<JobKind, typeof Copy> = { delete: Trash2, copy: Copy, move: FolderInput, tag: Tags, restore: ArchiveRestore };
const JOB_KIND_LABEL: Record<JobKind, string> = { delete: "Delete", copy: "Copy", move: "Move", tag: "Tag", restore: "Restore" };

async function cancelJob(id: string) {
  try {
    await api.cancelJob(id);
  } catch {
    /* unknown or already finished */
  }
}

function jobWhere(j: Job): string {
  if ((j.kind === "copy" || j.kind === "move") && j.destBucket && j.destBucket !== j.srcBucket) return `${j.srcBucket} → ${j.destBucket}`;
  return `in ${j.srcBucket}`;
}

function jobProgressText(j: Job): string {
  if (j.status === "queued") return "Queued: waits for a running job";
  if (j.phase === "listing") return `Listing… ${plural(j.totalItems, "object")} found`;
  const processed = j.doneItems + j.skippedItems + j.failedItems;
  const objects = `${processed.toLocaleString()} / ${j.totalItems.toLocaleString()} objects`;
  // Deletes, tag edits and restore requests move no data (their byte counters aren't meaningful).
  if (j.kind === "delete" || j.kind === "tag" || j.kind === "restore") return objects;
  return `${objects} · ${formatBytes(j.doneBytes)} / ${formatBytes(j.totalBytes)}`;
}

const JobRow = memo(function JobRow({ id }: { id: string }) {
  const j = useJobs((s) => s.byId[id]);
  const expanded = useJobs((s) => !!s.expanded[id]);
  if (!j) return null;
  const Icon = JOB_ICON[j.kind];
  const active = isJobActive(j);
  const pct = jobFraction(j) * 100;
  const indeterminate = j.status === "queued" || (j.status === "running" && j.phase === "listing");
  const StatusIcon = STATUS_ICON[j.status];
  const hasProblems = j.failedItems > 0 || !!j.error;
  const canExpand = j.errors.length > 0 || !!j.error;
  const statusText =
    j.status === "running"
      ? j.phase === "listing"
        ? "Listing"
        : `${pct.toFixed(0)}%`
      : j.status === "failed"
        ? "Failed"
        : STATUS_LABEL[j.status];
  return (
    <div id={`job-${id}`} className={`jobwrap ${hasProblems ? "has-problems" : ""}`}>
      <div className={`xrow jrow status-${j.status}`} {...menuProps("job", id)}>
        <div className={`xdir job-${j.kind}`} title={JOB_KIND_LABEL[j.kind]}>
          <Icon size={14} />
        </div>
        <div className="xname">
          <div className="xname-main" title={j.label}>
            {j.label}
          </div>
          <div className="xname-sub" title={j.error ?? jobWhere(j)}>
            {j.error ? <span className="err-text">{j.error}</span> : jobWhere(j)}
          </div>
        </div>
        <div className="xprogress">
          <div className={`pbar ${indeterminate ? "indeterminate" : ""} ${j.status === "queued" ? "queued" : ""}`}>
            {!indeterminate && <div className="pbar-fill" style={{ transform: `scaleX(${pct / 100})` }} />}
          </div>
          <div className="xbytes">{jobProgressText(j)}</div>
        </div>
        <div className="jcounts">
          {j.skippedItems > 0 && (
            <span
              className="jcount skipped"
              title={j.kind === "restore" ? "Not archived, already restored, or a restore is already in progress" : "Already at the destination: left untouched"}
            >
              {j.skippedItems.toLocaleString()} skipped
            </span>
          )}
          {j.failedItems > 0 && <span className="jcount failed">{j.failedItems.toLocaleString()} failed</span>}
        </div>
        <div className={`xstatus s-${j.status}`}>
          {StatusIcon ? <StatusIcon size={13} /> : <span className="pulse-dot" />}
          {statusText}
        </div>
        <div className="xactions">
          {canExpand && (
            <button
              className="icon-btn"
              onClick={() => useJobs.getState().setExpanded(id, !expanded)}
              title={expanded ? "Hide errors" : "Show errors"}
              aria-label={expanded ? "Hide errors" : "Show errors"}
              aria-expanded={expanded}
              aria-controls={`job-errors-${id}`}
            >
              <ChevronRight size={14} className={expanded ? "rot90" : ""} />
            </button>
          )}
          {active ? (
            <button className="icon-btn" onClick={() => void cancelJob(j.id)} title="Cancel" aria-label="Cancel job">
              <CircleStop size={14} />
            </button>
          ) : (
            <button className="icon-btn" onClick={() => void removeJobs([j.id])} title="Remove from list" aria-label="Remove job">
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      {expanded && canExpand && (
        <div className="jerrors" id={`job-errors-${id}`}>
          {j.error && (
            <div className="jerror">
              <AlertTriangle size={12} />
              <span className="jerror-msg">{j.error}</span>
            </div>
          )}
          {j.errors.map((e, i) => (
            <div key={i} className="jerror">
              <span className="jerror-key mono">{e.key}</span>
              <span className="jerror-msg">{e.message}</span>
            </div>
          ))}
          {j.failedItems > j.errors.length && (
            <div className="jerror-more muted">
              Showing the first {j.errors.length} of {j.failedItems.toLocaleString()} errors.
            </div>
          )}
        </div>
      )}
    </div>
  );
});

// ---- folder transfers (batches) ------------------------------------------------------------------

const BATCH_STATUS_LABEL: Record<BatchStatus, string> = { ...STATUS_LABEL, planning: "Planning" };
const BATCH_STATUS_ICON: Record<BatchStatus, typeof Clock | null> = { ...STATUS_ICON, planning: null };
/** At most this many running files are listed under an expanded batch. */
const BATCH_FILES_SHOWN = 8;

function batchWhere(b: Batch): string {
  return b.kind === "upload" ? `${b.localPath} → s3://${b.bucket}/${b.prefix}` : `s3://${b.bucket}/${b.prefix} → ${b.localPath}`;
}

function batchProgressText(b: Batch): string {
  if (b.status === "planning") return b.kind === "upload" ? "Reading the folder…" : "Listing the folder…";
  if (b.status === "queued" && b.doneFiles + b.failedFiles === 0) return `Queued: ${plural(b.totalFiles, "file")}, waiting for a free transfer slot`;
  return `${(b.doneFiles + b.skippedFiles + b.failedFiles).toLocaleString()} / ${b.totalFiles.toLocaleString()} files · ${formatBytes(b.doneBytes)} / ${formatBytes(b.totalBytes)}`;
}

/** The files of a batch that are transferring right now (bounded by the transfer limit). */
function BatchFiles({ id }: { id: string }) {
  const files = useBatches((s) => s.files[id]);
  const list = useMemo(
    () => Object.values(files ?? {}).sort((a, b) => (a.status === b.status ? a.key.localeCompare(b.key) : a.status === "running" ? -1 : 1)),
    [files],
  );
  if (!list.length) return null;
  const shown = list.slice(0, BATCH_FILES_SHOWN);
  return (
    <div className="bfiles" aria-label="Files transferring now">
      <div className="bsection">Transferring now</div>
      {shown.map((t) => {
        const pct = t.totalBytes > 0 ? Math.min(100, (t.transferredBytes / t.totalBytes) * 100) : 0;
        const indeterminate = t.status === "queued" || t.transferredBytes === 0;
        return (
          <div key={t.id} className="bfile">
            <span className="bfile-name mono" title={t.kind === "upload" ? `${t.localPath} → ${t.key}` : `${t.key} → ${t.localPath}`}>
              {t.key}
            </span>
            <span className={`pbar ${indeterminate ? "indeterminate" : ""} ${t.status === "queued" ? "queued" : ""}`}>
              {!indeterminate && <span className="pbar-fill" style={{ transform: `scaleX(${pct / 100})` }} />}
            </span>
            <span className="bfile-num">{t.status === "queued" ? "Queued" : `${formatBytes(t.transferredBytes)} / ${formatBytes(t.totalBytes)}`}</span>
          </div>
        );
      })}
      {list.length > shown.length && <div className="muted small">and {(list.length - shown.length).toLocaleString()} more starting</div>}
    </div>
  );
}

const BatchRow = memo(function BatchRow({ id }: { id: string }) {
  const b = useBatches((s) => s.byId[id]);
  const expanded = useBatches((s) => !!s.expanded[id]);
  if (!b) return null;
  const Icon = b.kind === "upload" ? FolderUp : FolderDown;
  const active = isBatchActive(b);
  const pct = batchFraction(b) * 100;
  const indeterminate = b.status === "planning" || (b.status === "queued" && b.doneBytes === 0);
  const StatusIcon = BATCH_STATUS_ICON[b.status];
  const hasProblems = b.failedFiles > 0 || !!b.error;
  const canExpand = b.errors.length > 0 || !!b.error || b.status === "running" || b.status === "queued";
  const statusText = b.status === "running" ? `${pct.toFixed(0)}%` : BATCH_STATUS_LABEL[b.status];
  const where = batchWhere(b);
  return (
    <div id={`batch-${id}`} className={`jobwrap batchwrap ${hasProblems ? "has-problems" : ""}`}>
      <div className={`xrow jrow brow status-${b.status}`} {...menuProps("batch", id)}>
        <div className={`xdir ${b.kind}`} title={b.kind === "upload" ? "Folder upload" : "Folder download"}>
          <Icon size={14} />
        </div>
        <div className="xname">
          <div className="xname-main" title={b.label}>
            {b.label}
          </div>
          <div className="xname-sub" title={b.error ?? where}>
            {b.error ? <span className="err-text">{b.error}</span> : where}
          </div>
        </div>
        <div className="xprogress">
          <div className={`pbar ${indeterminate ? "indeterminate" : ""} ${b.status === "queued" ? "queued" : ""}`}>
            {!indeterminate && <div className="pbar-fill" style={{ transform: `scaleX(${pct / 100})` }} />}
          </div>
          <div className="xbytes">{batchProgressText(b)}</div>
        </div>
        <div className="jcounts">
          {b.status === "running" && b.bytesPerSec > 0 && <span className="jcount speed">{formatSpeed(b.bytesPerSec)}</span>}
          {b.skippedFiles > 0 && <span className="jcount skipped">{b.skippedFiles.toLocaleString()} skipped</span>}
          {b.failedFiles > 0 && <span className="jcount failed">{b.failedFiles.toLocaleString()} failed</span>}
        </div>
        <div className={`xstatus s-${b.status === "planning" ? "running" : b.status}`}>
          {StatusIcon ? <StatusIcon size={13} /> : <span className="pulse-dot" />}
          {statusText}
        </div>
        <div className="xactions">
          {b.kind === "download" && !active && b.doneFiles > 0 && (
            <button className="icon-btn" onClick={() => void reveal({ localPath: b.localPath })} title="Show in folder" aria-label="Show in folder">
              <FolderSearch size={14} />
            </button>
          )}
          {canExpand && (
            <button
              className="icon-btn"
              onClick={() => useBatches.getState().setExpanded(id, !expanded)}
              title={expanded ? "Hide details" : "Show details"}
              aria-label={expanded ? "Hide details" : "Show details"}
              aria-expanded={expanded}
              aria-controls={`batch-details-${id}`}
            >
              <ChevronRight size={14} className={expanded ? "rot90" : ""} />
            </button>
          )}
          {active ? (
            <button className="icon-btn" onClick={() => void cancelBatch(b.id)} title="Cancel" aria-label="Cancel folder transfer">
              <CircleStop size={14} />
            </button>
          ) : (
            <button className="icon-btn" onClick={() => void removeBatches([b.id])} title="Remove from list" aria-label="Remove folder transfer">
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      {expanded && canExpand && (
        <div className="jerrors" id={`batch-details-${id}`}>
          {active && <BatchFiles id={id} />}
          {b.error && (
            <div className="jerror">
              <AlertTriangle size={12} />
              <span className="jerror-msg">{b.error}</span>
            </div>
          )}
          {b.errors.length > 0 && <div className="bsection">{b.failedFiles === 1 ? "Failed file" : "Failed files"}</div>}
          {b.errors.map((e, i) => (
            <div key={i} className="jerror">
              <span className="jerror-key mono">{e.path}</span>
              <span className="jerror-msg">{e.message}</span>
            </div>
          ))}
          {b.failedFiles > b.errors.length && (
            <div className="jerror-more muted">
              and {(b.failedFiles - b.errors.length).toLocaleString()} more failed files (the first {b.errors.length} are listed).
            </div>
          )}
        </div>
      )}
    </div>
  );
});

// ---- right-click menu (v0.6.0) -----------------------------------------------------------------

type MenuTarget = { kind: "transfer" | "batch" | "job"; id: string; x: number; y: number; el: HTMLElement | null };

/** The one open Activity menu (rows only set it; the panel renders it). */
const useActivityMenu = create<{ menu: MenuTarget | null }>(() => ({ menu: null }));

/** Row props that open the menu on right-click and on the keyboard menu key (ContextMenu, Shift+F10). */
function menuProps(kind: MenuTarget["kind"], id: string) {
  return {
    tabIndex: 0,
    onContextMenu: (e: ReactMouseEvent<HTMLElement>) => {
      e.preventDefault();
      useActivityMenu.setState({ menu: { kind, id, x: e.clientX, y: e.clientY, el: e.currentTarget } });
    },
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
      if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey)) return;
      e.preventDefault();
      const el = e.currentTarget;
      const r = el.getBoundingClientRect();
      useActivityMenu.setState({ menu: { kind, id, x: r.left + 40, y: r.bottom - 6, el } });
    },
  };
}

/** The folder that holds a key or prefix: "a/b/c.txt" -> "a/b/", "a/b/" -> "a/", "a//" -> "a/". */
function folderOf(keyOrPrefix: string): string {
  const body = keyOrPrefix.endsWith("/") ? keyOrPrefix.slice(0, -1) : keyOrPrefix;
  return body.slice(0, body.lastIndexOf("/") + 1);
}

type KnownBucket = (bucket: string | null | undefined) => boolean;

/** Is `bucket` one of the current connection's buckets (listed or added by name)? */
function useKnownBucket(): KnownBucket {
  const connected = useApp((s) => !!s.connection);
  const buckets = useApp((s) => s.buckets);
  const added = useApp((s) => s.addedBuckets);
  return useCallback(
    (bucket) => !!bucket && connected && (buckets.some((b) => b.name === bucket) || added.some((b) => b.name === bucket)),
    [connected, buckets, added],
  );
}

async function openLocal(path: string, what: string) {
  try {
    await api.openLocal(path);
  } catch (e) {
    toast.error(`Could not open ${what}`, e as AppError);
  }
}

/** "Go to …": disabled, with the reason, when the bucket is not in this connection. */
function goItem(label: string, bucket: string, known: boolean, go: () => void): PopupMenuItem {
  return known
    ? { label, icon: <LocateFixed size={14} />, action: go }
    : {
        label,
        icon: <LocateFixed size={14} />,
        action: () => {},
        disabled: true,
        hint: "Other connection",
        title: `s3://${bucket} is not one of this connection's buckets`,
      };
}

const goObject = (bucket: string, key: string) => {
  closeSearch();
  revealObject(bucket, key, key.slice(key.lastIndexOf("/") + 1));
};
const goFolder = (bucket: string, prefix: string) => {
  closeSearch();
  navigate(bucket, prefix);
};

const copyKeyItem = (key: string): PopupMenuItem => ({ label: "Copy key", icon: <Copy size={14} />, action: () => void copyText(key, "Key") });
const copyPathItem = (path: string): PopupMenuItem => ({
  label: "Copy local path",
  icon: <ClipboardCopy size={14} />,
  action: () => void copyText(path, "Local path"),
});
const showItem = (path: string): PopupMenuItem => ({ label: "Show in folder", icon: <FolderSearch size={14} />, action: () => void reveal({ localPath: path }) });
const cancelItem = (run: () => void): PopupMenuItem => ({ label: "Cancel", icon: <CircleStop size={14} />, action: run });
/**
 * "Remove from list" takes the row away: keep the keyboard focus in the panel by moving it to the
 * next row, else the previous one, else the panel's toggle.
 */
const removeItem = (el: HTMLElement | null, run: () => Promise<void>): PopupMenuItem => ({
  label: "Remove from list",
  icon: <X size={14} />,
  action: () => {
    const rows = [...document.querySelectorAll<HTMLElement>(".transfers-body .xrow[tabindex]")];
    const i = el ? rows.indexOf(el) : -1;
    const next = i >= 0 ? (rows[i + 1] ?? rows[i - 1] ?? null) : null;
    // After the removal has rendered (a frame later), unless the backend kept the row.
    void run().finally(() =>
      requestAnimationFrame(() => {
        if (el?.isConnected) return;
        const target = next?.isConnected ? next : document.querySelector<HTMLElement>(".transfers-toggle");
        target?.focus();
      }),
    );
  },
});

function transferGroups(t: Transfer, known: boolean, el: HTMLElement | null): PopupMenuItem[][] {
  const go = goItem("Go to object", t.bucket, known, () => goObject(t.bucket, t.key));
  const remove = removeItem(el, () => removeTransfers([t.id]));
  if (isActive(t)) {
    const stop = cancelItem(() => void cancel(t.id));
    return t.kind === "download" ? [[stop], [go, copyKeyItem(t.key)]] : [[stop], [copyKeyItem(t.key)]];
  }
  if (t.kind === "download") {
    if (t.status === "completed") {
      const open: PopupMenuItem[] = refusedToOpen(t.localPath)
        ? []
        : [{ label: "Open file", icon: <ExternalLink size={14} />, action: () => void openLocal(t.localPath, "the file") }];
      return [[...open, showItem(t.localPath)], [go, copyKeyItem(t.key), copyPathItem(t.localPath)], [remove]];
    }
    return [[go, copyKeyItem(t.key), copyPathItem(t.localPath)], [remove]];
  }
  if (t.status === "completed") return [[go, showItem(t.localPath), copyKeyItem(t.key), copyPathItem(t.localPath)], [remove]];
  return [[copyKeyItem(t.key), copyPathItem(t.localPath)], [remove]];
}

function batchGroups(b: Batch, known: boolean, el: HTMLElement | null): PopupMenuItem[][] {
  const go = goItem("Go to folder", b.bucket, known, () => goFolder(b.bucket, b.prefix));
  const active = isBatchActive(b);
  const stop = cancelItem(() => void cancelBatch(b.id));
  const remove = removeItem(el, () => removeBatches([b.id]));
  if (b.kind === "upload") return [[go, showItem(b.localPath), copyPathItem(b.localPath)], [active ? stop : remove]];
  if (active) return [[stop], [go]];
  if (b.doneFiles > 0) {
    const open: PopupMenuItem[] = refusedToOpen(b.localPath)
      ? []
      : [{ label: "Open folder", icon: <ExternalLink size={14} />, action: () => void openLocal(b.localPath, "the folder") }];
    return [
      [...open, showItem(b.localPath)],
      [go, copyPathItem(b.localPath)],
      [remove],
    ];
  }
  return [[go, copyPathItem(b.localPath)], [remove]];
}

function jobGroups(j: Job, known: KnownBucket, el: HTMLElement | null): PopupMenuItem[][] {
  // Jobs carry no item list; the request they were started with does (this session only).
  const first = jobRequest(j.id)?.items[0];
  const go: PopupMenuItem[] = [goItem("Go to source", j.srcBucket, known(j.srcBucket), () => goFolder(j.srcBucket, first ? folderOf(first.from) : ""))];
  if ((j.kind === "copy" || j.kind === "move") && j.destBucket) {
    const dest = j.destBucket;
    go.push(goItem("Go to destination", dest, known(dest), () => goFolder(dest, first?.to ? folderOf(first.to) : "")));
  }
  const failures: PopupMenuItem[] = j.errors.length
    ? [
        {
          label: "Copy failures",
          icon: <ClipboardCopy size={14} />,
          action: () =>
            void copyText(j.errors.map((e) => `${e.key} — ${e.message}`).join("\n"), j.errors.length === 1 ? "Failure" : `${j.errors.length} failures`),
        },
      ]
    : [];
  return [go, failures, [isJobActive(j) ? cancelItem(() => void cancelJob(j.id)) : removeItem(el, () => removeJobs([j.id]))]];
}

/** The open menu. Items follow the row's status, but byte counters (10 Hz) do not re-render it. */
function ActivityMenu() {
  const menu = useActivityMenu((s) => s.menu);
  const known = useKnownBucket();
  const tSig = useTransfers((s) => (menu?.kind === "transfer" ? s.byId[menu.id]?.status : undefined));
  const bSig = useBatches((s) => {
    const b = menu?.kind === "batch" ? s.byId[menu.id] : undefined;
    return b ? `${b.status}|${b.doneFiles > 0}` : undefined;
  });
  const jSig = useJobs((s) => {
    const j = menu?.kind === "job" ? s.byId[menu.id] : undefined;
    return j ? `${j.status}|${j.errors.length}` : undefined;
  });
  const groups = useMemo(() => {
    if (!menu) return null;
    if (menu.kind === "transfer") {
      const t = useTransfers.getState().byId[menu.id];
      return t ? transferGroups(t, known(t.bucket), menu.el) : null;
    }
    if (menu.kind === "batch") {
      const b = useBatches.getState().byId[menu.id];
      return b ? batchGroups(b, known(b.bucket), menu.el) : null;
    }
    const j = useJobs.getState().byId[menu.id];
    return j ? jobGroups(j, known, menu.el) : null;
    // The signatures stand for the row state the items depend on.
  }, [menu, known, tSig, bSig, jSig]);
  const close = useCallback(() => {
    const el = useActivityMenu.getState().menu?.el;
    useActivityMenu.setState({ menu: null });
    if (el?.isConnected) el.focus();
  }, []);
  // The row went away (removed from the list): close.
  useEffect(() => {
    if (menu && !groups) useActivityMenu.setState({ menu: null });
  }, [menu, groups]);
  if (!menu || !groups) return null;
  return <PopupMenu x={menu.x} y={menu.y} groups={groups} onClose={close} label="Activity item" />;
}

/** Overall progress of everything active: each transfer, job or folder transfer weighs the same. */
function Summary() {
  const transfers = useTransfers((s) => {
    let speed = 0;
    let frac = 0;
    let n = 0;
    for (const id of s.ids) {
      const t = s.byId[id];
      if (t && isActive(t)) {
        speed += t.bytesPerSec;
        frac += t.totalBytes ? Math.min(1, t.transferredBytes / t.totalBytes) : 0;
        n++;
      }
    }
    return `${speed}|${frac}|${n}`;
  });
  const jobs = useJobs((s) => {
    let frac = 0;
    let n = 0;
    for (const id of s.ids) {
      const j = s.byId[id];
      if (j && isJobActive(j)) {
        frac += jobFraction(j);
        n++;
      }
    }
    return `${frac}|${n}`;
  });
  const batches = useBatches((s) => {
    let speed = 0;
    let frac = 0;
    let n = 0;
    for (const id of s.ids) {
      const b = s.byId[id];
      if (b && isBatchActive(b)) {
        speed += b.bytesPerSec;
        frac += batchFraction(b);
        n++;
      }
    }
    return `${speed}|${frac}|${n}`;
  });
  const [tSpeed, tFrac, tN] = transfers.split("|").map(Number);
  const [jFrac, jN] = jobs.split("|").map(Number);
  const [bSpeed, bFrac, bN] = batches.split("|").map(Number);
  const n = tN + jN + bN;
  if (!n) return null;
  const speed = tSpeed + bSpeed;
  const pct = Math.min(100, ((tFrac + jFrac + bFrac) / n) * 100);
  return (
    <span className="xsummary">
      <span className="mini-bar">
        <span style={{ transform: `scaleX(${pct / 100})` }} />
      </span>
      {pct.toFixed(0)}%{tN + bN > 0 && speed > 0 ? ` · ${formatSpeed(speed)}` : ""}
    </span>
  );
}

type ActivityRow = { kind: "job" | "transfer" | "batch"; id: string };

/** Bottom panel: transfers (uploads/downloads) and jobs (delete/copy/move), newest first. */
export function ActivityPanel() {
  const open = useApp((s) => s.transfersOpen);
  const transferIds = useTransfers((s) => s.ids);
  const jobIds = useJobs((s) => s.ids);
  const batchIds = useBatches((s) => s.ids);
  const activeTransfers = useTransfers(selectActiveCount);
  const activeJobs = useJobs(selectActiveJobCount);
  const activeBatches = useBatches(selectActiveBatchCount);
  // Transfers inside a folder transfer are not in the transfer list: a batch counts once.
  const active = activeTransfers + activeJobs + activeBatches;
  const total = transferIds.length + jobIds.length + batchIds.length;
  const finishedCount = total - active;

  // Start times never change, so this only re-sorts when rows are added or removed.
  const rows = useMemo<ActivityRow[]>(() => {
    const t = useTransfers.getState().byId;
    const j = useJobs.getState().byId;
    const bt = useBatches.getState().byId;
    const all = [
      ...batchIds.map((id) => ({ kind: "batch" as const, id, at: bt[id]?.startedAt ?? "" })),
      ...jobIds.map((id) => ({ kind: "job" as const, id, at: j[id]?.startedAt ?? "" })),
      ...transferIds.map((id) => ({ kind: "transfer" as const, id, at: t[id]?.startedAt ?? "" })),
    ];
    return all.sort((a, b) => b.at.localeCompare(a.at));
  }, [jobIds, transferIds, batchIds]);

  const clearFinished = () => {
    const ts = useTransfers.getState();
    void removeTransfers(ts.ids.filter((id) => ts.byId[id] && !isActive(ts.byId[id])));
    const js = useJobs.getState();
    void removeJobs(js.ids.filter((id) => js.byId[id] && !isJobActive(js.byId[id])));
    const bs = useBatches.getState();
    void removeBatches(bs.ids.filter((id) => bs.byId[id] && !isBatchActive(bs.byId[id])));
  };

  return (
    <section className={`transfers ${open ? "open" : ""}`} aria-label="Activity">
      <div className="transfers-bar">
        <button className="transfers-toggle" onClick={() => setTransfersOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          <span>Activity</span>
          {active > 0 && (
            <span
              className="badge"
              title={`${activeTransfers} transfers, ${activeBatches} folder transfers, ${activeJobs} file operations active`}
            >
              {active}
            </span>
          )}
          {active === 0 && total > 0 && <span className="muted small">{total} finished</span>}
        </button>
        <Summary />
        <div className="spacer" />
        {open && finishedCount > 0 && (
          <button className="link-btn" onClick={clearFinished}>
            Clear finished
          </button>
        )}
      </div>
      {open && (
        <div className="transfers-body">
          {total === 0 ? (
            <div className="empty-note">Nothing here yet. Uploads, downloads and file operations show their progress here.</div>
          ) : (
            rows.map((r) =>
              r.kind === "job" ? (
                <JobRow key={r.id} id={r.id} />
              ) : r.kind === "batch" ? (
                <BatchRow key={r.id} id={r.id} />
              ) : (
                <TransferRow key={r.id} id={r.id} />
              ),
            )
          )}
        </div>
      )}
      <ActivityMenu />
    </section>
  );
}
