// The confirmation of a copy or move between an S3 pane and a local pane (v0.9.0, see "Transfers
// between panes" in docs/CONTRACT.md). Loaded on first use.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, ArrowRight, FolderDown, FolderUp, Info, Loader2 } from "lucide-react";
import { formatBytes, s3Uri } from "../lib/format";
import { plural } from "../lib/ops";
import type { BatchPreview, ConflictPolicy } from "../lib/types";
import { openModal } from "../store/app";
import { crossPlan, dropCrossPlan, planTargets, startPlan, type CrossPlan, type CrossTarget } from "../store/cross";
import { ConflictChoice, ModalShell, useDefaultAction } from "./Modals";
import { useBatchPreviews } from "./BatchDialogs";

// ---- cross-pane transfer confirmation -------------------------------------------------------------

/**
 * Copy or move between an S3 pane and a local pane: the exact items, where each goes, what is
 * already there (and the Skip / Overwrite choice), the folder previews, and for a move what is
 * deleted afterwards. Start sends exactly the plan (see store/cross.ts).
 */
export function CrossTransferModal({ planId }: { planId: number }) {
  const plan = useMemo(() => crossPlan(planId), [planId]);
  return plan ? <CrossTransferBody planId={planId} plan={plan} /> : null;
}

function CrossTransferBody({ planId, plan }: { planId: number; plan: CrossPlan }) {
  const [targets, setTargets] = useState<CrossTarget[] | null>(null);
  const [policy, setPolicy] = useState<ConflictPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const close = () => {
    dropCrossPlan(planId);
    openModal(null);
  };
  useEffect(() => {
    if (!plan) return;
    let live = true;
    void planTargets(plan).then((t) => live && setTargets(t));
    return () => {
      live = false;
    };
  }, [plan]);
  // Folder previews (files, bytes, conflicts), the same as the folder transfer dialogs.
  const folderTargets = useMemo(() => (targets ?? []).filter((t) => (t.item.kind === "prefix" || t.item.kind === "dir") && !t.blocked), [targets]);
  const requests = useMemo(
    () =>
      plan && targets
        ? folderTargets.map((t) =>
            plan.direction === "download"
              ? { kind: "download" as const, bucket: plan.bucket, prefix: (t.item as { key: string }).key, localPath: t.dest, onConflict: "skip" as const }
              : { kind: "upload" as const, bucket: plan.bucket, prefix: t.dest, localPath: (t.item as { path: string }).path, onConflict: "skip" as const },
          )
        : null,
    [plan, targets, folderTargets],
  );
  const [states, retry] = useBatchPreviews(requests, 0);
  const actionRef = useRef<HTMLButtonElement>(null);
  const download = plan.direction === "download";
  // A move from a network location (v0.9.1) uploads only: the files stay on the share.
  const stayOnShare = plan.stayOnShare;
  const move = plan.mode === "cut" && !stayOnShare;
  const loadingFolders = !!states && states.some((s) => s.status === "loading");
  const folderErrors = states ? states.filter((s) => s.status === "error").length : 0;
  const previewOf = (i: number) => (states?.[i]?.status === "ok" ? (states[i] as { preview: BatchPreview }).preview : null);
  const fileConflicts = (targets ?? []).filter((t) => t.conflict).length;
  const folderConflicts = folderTargets.reduce((n, _, i) => n + (previewOf(i)?.conflicts ?? 0), 0);
  const conflicts = fileConflicts + folderConflicts;
  const truncatedFolders = folderTargets.filter((_, i) => previewOf(i)?.truncated);
  const blocked = (targets ?? []).filter((t) => t.blocked);
  const ready = !!targets && !loadingFolders && folderErrors === 0;
  const startable = (targets ?? []).filter((t) => !t.blocked && !(t.conflict && policy === "skip"));
  const canStart = ready && truncatedFolders.length === 0 && (conflicts === 0 || policy !== null) && startable.length > 0 && !busy;
  const overwrite = conflicts > 0 && policy === "overwrite";
  const destLabel = download ? plan.dir : s3Uri(plan.bucket, plan.prefix);
  const srcLabel = download ? s3Uri(plan.bucket, plan.prefix) : plan.dir;
  const verb = move ? "Move" : download ? "Download" : "Upload";
  // Enter confirms once the plan is checked (focus moves to the action button).
  useDefaultAction(actionRef, canStart);

  const start = async () => {
    if (!canStart || !targets) return;
    setBusy(true);
    const started = await startPlan(plan, targets, conflicts > 0 && policy ? policy : "skip");
    setBusy(false);
    if (started) close();
  };

  return (
    <ModalShell onClose={close} busy={busy} labelledBy={titleId} wide>
      <div className="modal-head">
        <div className={`modal-icon ${move ? "warn" : ""}`}>{download ? <FolderDown size={18} /> : <FolderUp size={18} />}</div>
        <div className="grow">
          <h2 id={titleId}>
            {verb} {plural(plan.items.length, "item")} {download ? "to this computer" : "to S3"}?
          </h2>
          <p className="muted small">
            {download ? "Downloaded" : "Uploaded"} from <span className="mono">{srcLabel}</span>
          </p>
        </div>
      </div>
      <div className="batch-dest">
        <div className="route-end grow">
          <span className="route-label">{download ? "Save into" : "Upload into"}</span>
          <span className="mono key-text">{destLabel}</span>
        </div>
      </div>
      <div className="key-list-wrap">
        <div className="key-list-head">
          <span>{download ? "Exact keys and folders (bucket → this computer)" : "Exact paths (this computer → bucket)"}</span>
        </div>
        <ol className="key-list mono batch-folder-list" aria-label="Items to transfer">
          {(targets ?? plan.items.map((item) => ({ item, dest: "…", conflict: false, blocked: null }))).map((t) => {
            const folder = t.item.kind === "prefix" || t.item.kind === "dir";
            const src = "key" in t.item ? t.item.key : t.item.path;
            const fi = folderTargets.indexOf(t as CrossTarget);
            const st = fi >= 0 ? states?.[fi] : undefined;
            return (
              <li key={src} className="with-dest">
                <span className="key-kind">{folder ? "folder" : "file"}</span>
                <span className="key-text">{src}</span>
                <ArrowRight size={12} className="key-arrow" aria-label="to" />
                <span className="batch-folder-dest">
                  <span className="key-text">{t.dest}</span>
                  <span className="batch-folder-count">
                    {t.blocked ? (
                      <span className="err-text">{t.blocked} Not transferred.</span>
                    ) : t.conflict ? (
                      <span className="warn-text">already there</span>
                    ) : folder ? (
                      !st || st.status === "loading" ? (
                        <>
                          <Loader2 size={11} className="spin" /> counting…
                        </>
                      ) : st.status === "error" ? (
                        <span className="err-text">{st.error.message}</span>
                      ) : (
                        <>
                          {plural(st.preview.files, "file")}, {formatBytes(st.preview.bytes)}
                          {st.preview.conflicts > 0 && <span className="warn-text"> · {st.preview.conflicts.toLocaleString()} already there</span>}
                        </>
                      )
                    ) : (
                      "size" in t.item && <span className="muted">{formatBytes(t.item.size)}</span>
                    )}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      {folderErrors > 0 && (
        <div className="inline-error" role="alert">
          <AlertCircle size={14} />
          <div className="grow">A folder couldn’t be checked. Nothing has been transferred.</div>
          <button type="button" className="btn btn-sm" onClick={retry}>
            Retry
          </button>
        </div>
      )}
      {truncatedFolders.length > 0 && (
        <div className="callout danger">
          <AlertTriangle size={14} />
          <span>A folder is too large for one transfer. Transfer its sub-folders instead.</span>
        </div>
      )}
      {blocked.length > 0 && <p className="hint err-text">{plural(blocked.length, "item")} can’t go there: the name is taken by {blocked.length === 1 ? "a file or folder" : "files or folders"} of the other kind.</p>}
      {!plan.existing.complete && (
        <p className="hint warn-text">The destination holds more than could be checked; {download ? "files" : "objects"} not seen may be replaced.</p>
      )}
      {stayOnShare && (
        <div className="callout info stay-on-share" role="note">
          <Info size={14} />
          <span>
            <strong>The files stay on the network location.</strong> It has no recycle bin, so moving from it uploads only: nothing on the share is
            deleted by this app. Once you have checked the upload, delete the files in the file manager.
          </span>
        </div>
      )}
      {move && (
        <div className="callout warn" role="note">
          <AlertTriangle size={14} />
          <span>
            {download ? (
              <>
                <strong>The downloaded objects will be deleted from S3 after the download finishes (only the ones that complete).</strong> For a folder,
                that is each of its objects that was downloaded; the folder itself, anything added to it meanwhile, and anything that fails, is
                cancelled or skipped stay in the bucket. Cancelling the move later still deletes the objects whose download had already completed.
              </>
            ) : (
              <>
                <strong>Moved to the recycle bin after upload:</strong> each file above, and each uploaded file of a folder above, goes to the recycle bin of this computer once its upload
                completes (a folder's own files one by one; the folder itself stays). Anything that fails, is cancelled or skipped stays where it is.
                Cancelling the move later still moves the files that had already been uploaded.
              </>
            )}
          </span>
        </div>
      )}
      {conflicts > 0 && (
        <ConflictChoice
          policy={policy}
          onChange={setPolicy}
          legend={
            <>
              {plural(conflicts, "file")} already {conflicts === 1 ? "exists" : "exist"} {download ? "on this computer" : "in the bucket"}. Choose what happens to{" "}
              {conflicts === 1 ? "it" : "them"}:
            </>
          }
          skipText={download ? "Files already on this computer are left untouched; those objects are not downloaded." : "Objects already in the bucket are left untouched; those files are not uploaded."}
          overwriteText={download ? "The files on this computer are replaced. This cannot be undone." : "The objects in the bucket are replaced. On a bucket without versioning this cannot be undone."}
        />
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={close} disabled={busy} data-autofocus data-default-from>
          Cancel
        </button>
        <button ref={actionRef} type="button" className={`btn ${overwrite ? "btn-danger" : "btn-primary"}`} onClick={() => void start()} disabled={!canStart}>
          {(busy || !ready) && <Loader2 size={14} className="spin" />}
          {busy ? "Starting…" : `${verb}${startable.length ? ` ${plural(startable.length, "item")}` : ""}${overwrite ? ", overwrite" : ""}`}
        </button>
      </div>
    </ModalShell>
  );
}
