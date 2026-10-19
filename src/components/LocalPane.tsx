// Local panes (v0.9.0, see "Pane sources" in docs/CONTRACT.md): the path bar of a local pane, its
// right-click menu, the size cell of its folders, its dialogs (new folder, rename, recycle bin),
// the source menu (Alt+F1 / Alt+F2 / the path bar's source button) and the editable path (Mod+L, a
// click on the path bar's empty area). The cross-pane transfer confirmation is CrossTransferDialog.tsx.

import { Fragment, memo, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  Calculator,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Copy,
  CopyPlus,
  Eye,
  EyeOff,
  ExternalLink,
  FolderInput,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Home,
  Loader2,
  Network,
  PencilLine,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { formatBytes, s3Uri } from "../lib/format";
import { plural, splitExt } from "../lib/ops";
import type { LocalRoot } from "../lib/types";
import { navigate, navigateLocal, openModal, refresh, setShowHidden, useApp, usePane, usePaneId } from "../store/app";
import { isLocalPane, usePanes, type PaneId, type PaneState } from "../store/panes";
import {
  calculateLocalSizes,
  closeSourceMenu,
  copyLocalPaths,
  createLocalFolder,
  editablePath,
  goToTypedPath,
  isNetworkPath,
  isNetworkRoot,
  localSegments,
  NO_RECYCLE_BIN,
  openLocalEntry,
  openLocalNewFolder,
  openSourceMenu,
  renameLocalEntry,
  requestLocalRename,
  requestLocalTrash,
  revealLocal,
  selectedLocal,
  startPathEdit,
  stopPathEdit,
  trashLocalPaths,
  useLocalRoots,
  useLocalSize,
  usePathEdit,
  useSourceMenu,
} from "../store/local";
import { otherPaneRefusal, paneLoc, transferToOtherPane, LINK_MOVE } from "../store/cross";
import { useKeyHint, withKey } from "../store/keyboard";
import { useSelectionInfo, useViewRows } from "../store/view";
import { focusPaneListSoon } from "../store/keyboard";
import { PopupMenu, type PopupMenuItem } from "./PopupMenu";
import { ModalShell } from "./Modals";

// ---- the size cell of a local folder -------------------------------------------------------------

export const LocalSizeCell = memo(function LocalSizeCell({ path }: { path: string }) {
  const e = useLocalSize(path);
  if (e?.size) {
    return (
      <span className="dim" title={`${e.running ? "Recalculating… " : ""}${plural(e.size.files, "file")}${e.size.truncated ? " at least (the count stopped at its limit)" : ""}`}>
        {e.running && <Loader2 size={11} className="spin fsize-cell-spin" aria-label="Recalculating size" />}
        {e.size.truncated ? "≥ " : ""}
        {formatBytes(e.size.bytes)}
      </span>
    );
  }
  if (e?.running) return <Loader2 size={12} className="spin dim" aria-label="Calculating size" />;
  return <span className="dim">—</span>;
});

// ---- source button and menu ----------------------------------------------------------------------

/** The path bar's first control: which source the pane shows; opens the source menu. */
export function SourceButton({ pane }: { pane: PaneId }) {
  const local = usePane((s) => isLocalPane(s));
  const onShare = usePane((s) => !!s.local && isNetworkPath(s.local.dir));
  const hint = useKeyHint(pane === "a" ? "source.pickLeft" : "source.pickRight");
  return (
    <button
      type="button"
      className={`source-btn ${local ? "local" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        openSourceMenu(pane, { x: r.left, y: r.bottom + 4 });
      }}
      title={withKey(local ? "This computer: choose another source" : "S3: choose another source", hint)}
      aria-label="Choose the source of this pane"
      aria-haspopup="menu"
    >
      {onShare ? <Network size={13} /> : local ? <HardDrive size={13} /> : <Cloud size={13} />}
      <ChevronDown size={11} className="source-caret" />
    </button>
  );
}

/** The icon of a local root: home, a network location (saved, or a mapped network drive), a drive, a mount. */
export const rootIcon = (r: LocalRoot, size = 14, className?: string) =>
  r.kind === "home" ? (
    <Home size={size} className={className} />
  ) : isNetworkRoot(r) ? (
    <Network size={size} className={className} />
  ) : r.kind === "drive" ? (
    <HardDrive size={size} className={className} />
  ) : (
    <FolderOpen size={size} className={className} />
  );

/** The source menu: the local roots first (like Total Commander's drive list), then this connection's buckets. Rendered once (Explorer). */
export function SourceMenu() {
  const menu = useSourceMenu((s) => s.menu);
  const buckets = useApp((s) => s.buckets);
  const added = useApp((s) => s.addedBuckets);
  const roots = useLocalRoots((s) => s.roots);
  const rootsLoading = useLocalRoots((s) => s.loading);
  const pane = menu?.pane;
  const current = usePaneSource(pane);
  if (!menu || !pane) return null;
  const names = [...new Set([...buckets.map((b) => b.name), ...added.map((b) => b.name)])];
  const MAX = 40;
  const pick = (fn: () => void) => () => {
    fn();
    focusPaneListSoon(pane);
  };
  const bucketItems: PopupMenuItem[] = names.slice(0, MAX).map((name) => ({
    label: name,
    icon: current.bucket === name ? <Check size={14} /> : <Archive size={14} />,
    action: pick(() => navigate(name, "", pane)),
    hint: current.bucket === name ? "open" : undefined,
  }));
  if (names.length > MAX) bucketItems.push({ label: `${names.length - MAX} more in the bucket list`, icon: <Archive size={14} />, action: () => {}, disabled: true });
  if (!names.length) bucketItems.push({ label: "No buckets", icon: <Archive size={14} />, action: () => {}, disabled: true });
  const rootItems: PopupMenuItem[] = roots.map((r) => ({
    label: r.label,
    icon: current.dir && sameRoot(current.dir, r.path) ? <Check size={14} /> : rootIcon(r),
    action: pick(() => navigateLocal(r.path, pane)),
    title: r.path,
    hint: r.path === r.label ? undefined : r.path,
  }));
  if (!roots.length) rootItems.push({ label: rootsLoading ? "Loading this computer…" : "This computer is unavailable", icon: <HardDrive size={14} />, action: () => {}, disabled: true });
  return (
    <PopupMenu
      x={menu.x}
      y={menu.y}
      label={pane === "a" ? "Source of the left pane" : "Source of the right pane"}
      className="source-menu"
      onClose={closeSourceMenu}
      headings={["This computer", "S3 buckets"]}
      typeAhead
      groups={[rootItems, bucketItems]}
    />
  );
}

const sameRoot = (dir: string, root: string) => dir.toLowerCase() === root.toLowerCase();

function usePaneSource(pane: PaneId | undefined): { bucket: string | null; dir: string | null } {
  const bucket = useAppPane(pane, (s) => s.bucket);
  const dir = useAppPane(pane, (s) => s.local?.dir ?? null);
  return { bucket, dir };
}

function useAppPane<T>(pane: PaneId | undefined, sel: (p: PaneState) => T): T {
  return usePanes((s) => sel(s[pane ?? "a"]));
}

// ---- the editable path -----------------------------------------------------------------------------

/** The path bar as a text field: Enter goes there, Esc (or leaving it) cancels; errors stay inline. */
export function PathEditField({ pane }: { pane: PaneId }) {
  const [text, setText] = useState(() => editablePath(pane));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const cancel = () => {
    stopPathEdit(pane);
    focusPaneListSoon(pane);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const err = await goToTypedPath(pane, text);
    setBusy(false);
    if (err) {
      setError(err);
      requestAnimationFrame(() => ref.current?.focus());
      return;
    }
    cancel();
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  };
  return (
    <form className={`path-edit ${error ? "invalid" : ""}`} onSubmit={submit} onClick={(e) => e.stopPropagation()}>
      <input
        ref={ref}
        className="path-edit-input mono"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (!busy) stopPathEdit(pane);
        }}
        spellCheck={false}
        autoComplete="off"
        aria-label="Path: an s3:// address, a folder of this bucket, or a folder on this computer"
        aria-invalid={!!error}
        aria-describedby={error ? `path-err-${pane}` : undefined}
        placeholder="s3://bucket/folder/  ·  folder/  ·  C:\\Users"
        // Read-only (not disabled) while it goes there: a disabled field loses the focus, and Esc
        // right after an inline error then reached nothing.
        readOnly={busy}
        aria-busy={busy}
      />
      {busy && <Loader2 size={13} className="spin path-edit-spin" />}
      {error && (
        <span id={`path-err-${pane}`} className="path-edit-error" role="alert" title={error}>
          <AlertCircle size={12} /> {error}
        </span>
      )}
    </form>
  );
}

/** Clicking the path bar's empty area (not a crumb or a button) opens the editable path. */
export function onPathBarClick(pane: PaneId) {
  return (e: ReactMouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest("button, a, input, form")) return;
    startPathEdit(pane);
  };
}

export const usePathEditing = (pane: PaneId) => usePathEdit((s) => !!s.editing[pane]);

// ---- the local path bar ----------------------------------------------------------------------------

export function LocalPathBar() {
  const pane = usePaneId();
  const dir = usePane((s) => s.local?.dir ?? "");
  const truncated = usePane((s) => !!s.local?.truncated);
  const showHidden = usePane((s) => s.showHidden);
  const loading = usePane((s) => s.listing.loading);
  const total = usePane((s) => s.listing.folders.length + s.listing.objects.length);
  const rows = useViewRows();
  const filter = usePane((s) => s.filter);
  const sel = useSelectionInfo();
  const hiddenKey = useKeyHint("local.toggleHidden");
  const editKey = useKeyHint("nav.editPath");
  const segs = useMemo(() => localSegments(dir), [dir]);
  // A network location (a UNC path or a mapped network drive) shows a network icon in its first crumb.
  const onShare = useMemo(() => isNetworkPath(dir), [dir]);
  const selCount = sel.folders + sel.objects;
  return (
    <div className="breadcrumbs local-bar" onClick={onPathBarClick(pane)} title={withKey("Click to type a path", editKey)}>
      <nav className="crumbs" aria-label="Path">
        <SourceButton pane={pane} />
        {segs.map((s, i) => (
          <Fragment key={s.path}>
            {i > 0 && <ChevronRight size={13} className="crumb-sep" />}
            <button
              className={`crumb ${i === segs.length - 1 ? "current" : ""}`}
              onClick={() => navigateLocal(s.path, pane)}
              title={s.path}
              data-drop-local={s.path}
            >
              {i === 0 && (onShare ? <Network size={13} className="crumb-net" aria-label="Network location" /> : <HardDrive size={13} />)}
              {s.name}
            </button>
          </Fragment>
        ))}
        <button className="icon-btn crumb-copy" onClick={() => copyLocalPaths([dir])} title={`Copy path: ${dir}`} aria-label="Copy path">
          <Copy size={12} />
        </button>
        <button
          className={`icon-btn crumb-hidden ${showHidden ? "on" : ""}`}
          onClick={() => setShowHidden(pane, !showHidden)}
          title={withKey(showHidden ? "Hide hidden files" : "Show hidden files", hiddenKey)}
          aria-label={showHidden ? "Hide hidden files" : "Show hidden files"}
          aria-pressed={showHidden}
        >
          {showHidden ? <Eye size={12} /> : <EyeOff size={12} />}
        </button>
      </nav>
      <div className="crumb-info muted">
        {selCount > 0 && (
          <span className="sel-info">
            {selCount.toLocaleString()} selected{sel.objects > 0 ? ` · ${formatBytes(sel.bytes)}` : ""}
            <span className="dot-sep">·</span>
          </span>
        )}
        {truncated && (
          <span className="warn-text" title="The folder has more than 50,000 entries; only the first 50,000 are listed.">
            first 50,000 only<span className="dot-sep">·</span>
          </span>
        )}
        {loading && total === 0
          ? "Loading…"
          : filter
            ? `${rows.length.toLocaleString()} of ${total.toLocaleString()} items`
            : `${total.toLocaleString()} items`}
      </div>
    </div>
  );
}

// ---- right-click menu of a local pane ------------------------------------------------------------

interface MenuItem {
  label: string;
  icon: ReactNode;
  action: () => void;
  danger?: boolean;
  hint?: string;
  disabled?: boolean;
  title?: string;
}

/** The items of a local pane's context menu for its selection (or the folder, with nothing selected). */
export function useLocalMenuGroups(pane: PaneId): MenuItem[][] {
  const k = {
    open: useKeyHint("nav.open"),
    newFolder: useKeyHint("act.newFolder"),
    rename: useKeyHint("act.rename"),
    del: useKeyHint("act.delete"),
    toOther: useKeyHint("act.copyToOther"),
    moveOther: useKeyHint("act.moveToOther"),
    refresh: useKeyHint("nav.refresh"),
    size: useKeyHint("act.folderSize"),
    copyKey: useKeyHint("act.copyKey"),
  };
  const dir = usePane((s) => s.local?.dir ?? "");
  const split = useApp((s) => s.split && !s.narrow);
  const sel = selectedLocal(pane);
  const groups: MenuItem[][] = [];
  const other = split ? otherPaneRefusal() : "Open the split view first";
  const otherLoc = split ? paneLoc(pane === "a" ? "b" : "a") : null;
  const toOther: MenuItem[] = otherLoc
    ? [
        {
          label: "Upload to other pane",
          icon: <CopyPlus size={14} />,
          action: () => transferToOtherPane("copy"),
          hint: k.toOther,
          ...(other ? { disabled: true, title: other } : { title: `Copy to ${otherLoc.kind === "s3" ? s3Uri(otherLoc.bucket, otherLoc.prefix) : otherLoc.dir}` }),
        },
        {
          label: "Move to other pane",
          icon: <FolderInput size={14} />,
          action: () => transferToOtherPane("cut"),
          hint: k.moveOther,
          ...(other
            ? { disabled: true, title: other }
            : sel.some((e) => e.isSymlink)
              ? { title: `${LINK_MOVE} (they are left out)` }
              : isNetworkPath(dir)
                ? { title: "Upload only: the files stay on the network location (it has no recycle bin)" }
                : { title: "Upload, then move what was uploaded to the recycle bin" }),
        },
      ]
    : [];
  if (!sel.length) {
    groups.push([
      { label: "New folder…", icon: <FolderPlus size={14} />, action: () => openLocalNewFolder(pane), hint: k.newFolder },
      { label: "Show in folder", icon: <ExternalLink size={14} />, action: () => void revealLocal(dir) },
      { label: "Copy path", icon: <Copy size={14} />, action: () => copyLocalPaths([dir]) },
    ]);
    groups.push([{ label: "Refresh", icon: <RefreshCw size={14} />, action: () => void refresh(pane), hint: k.refresh }]);
    return groups;
  }
  const one = sel.length === 1 ? sel[0] : null;
  const dirs = sel.filter((e) => e.isDir && !e.isSymlink);
  const first: MenuItem[] = [];
  if (one) {
    first.push({
      label: "Open",
      icon: one.isDir ? <FolderOpen size={14} /> : <ExternalLink size={14} />,
      action: () => openLocalEntry(pane, one.path),
      hint: k.open,
      ...(one.isSymlink ? { disabled: true, title: "Links aren’t followed" } : {}),
    });
  }
  first.push({ label: "Show in folder", icon: <FolderOpen size={14} />, action: () => void revealLocal(sel[0].path) });
  if (dirs.length) {
    first.push({
      label: dirs.length === 1 ? "Calculate size" : `Calculate size of ${plural(dirs.length, "folder")}`,
      icon: <Calculator size={14} />,
      action: () => calculateLocalSizes(dirs.map((d) => d.path)),
      hint: k.size,
    });
  }
  groups.push(first);
  groups.push([{ label: one ? "Copy path" : `Copy ${sel.length} paths`, icon: <Copy size={14} />, action: () => copyLocalPaths(sel.map((e) => e.path)), hint: k.copyKey }]);
  groups.push([
    ...(one ? [{ label: "Rename…", icon: <PencilLine size={14} />, action: () => requestLocalRename(pane), hint: k.rename }] : []),
    ...toOther,
    { label: "New folder…", icon: <FolderPlus size={14} />, action: () => openLocalNewFolder(pane), hint: k.newFolder },
  ]);
  // A network location has no recycle bin: Delete is shown disabled, with the reason.
  const onShare = isNetworkPath(dir) || sel.some((e) => isNetworkPath(e.path));
  groups.push([
    onShare
      ? { label: "Delete", icon: <Trash2 size={14} />, action: () => {}, hint: k.del, disabled: true, title: NO_RECYCLE_BIN }
      : {
          label: sel.length > 1 ? `Move ${sel.length} items to the recycle bin…` : "Move to the recycle bin…",
          icon: <Trash2 size={14} />,
          danger: true,
          action: () => requestLocalTrash(pane),
          hint: k.del,
        },
  ]);
  return groups;
}

// ---- dialogs ---------------------------------------------------------------------------------------

export function LocalNewFolderModal({ parent }: { parent: string }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const titleId = useId();
  const close = () => openModal(null);
  const trimmed = name.trim();
  const error = !trimmed ? "Enter a name" : /[\\/]/.test(trimmed) ? "A name can’t contain \\ or /" : trimmed === "." || trimmed === ".." ? "“.” and “..” are not allowed as names" : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (error || busy) return;
    setBusy(true);
    const ok = await createLocalFolder(parent, trimmed);
    setBusy(false);
    if (ok) close();
  };
  return (
    <ModalShell onClose={close} busy={busy} labelledBy={titleId}>
      <form onSubmit={submit}>
        <div className="modal-head">
          <div className="modal-icon">
            <FolderPlus size={18} />
          </div>
          <div>
            <h2 id={titleId}>New folder</h2>
            <p className="muted small mono">{parent}</p>
          </div>
        </div>
        <label className="field">
          <span className="field-label">Folder name</span>
          <input data-autofocus value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} aria-invalid={touched && !!error} />
        </label>
        <p className={`hint ${touched && error ? "err-text" : ""}`}>
          {touched && error ? error : "Characters this computer can’t use in a name are replaced with “_”."}
        </p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || (touched && !!error)}>
            {busy && <Loader2 size={14} className="spin" />} Create
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

export function LocalRenameModal({ path, name: current, isDir }: { path: string; name: string; isDir: boolean }) {
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const close = () => openModal(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, isDir ? current.length : splitExt(current)[0].length);
  }, [current, isDir]);
  const name = value.trim();
  const error = !name ? "Enter a name" : /[\\/]/.test(name) ? "A name can’t contain \\ or /. Renaming stays in the same folder." : name === current ? "The new name is the same as the current one" : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (error || busy) return;
    setBusy(true);
    const ok = await renameLocalEntry(path, name);
    setBusy(false);
    if (ok) close();
  };
  return (
    <ModalShell onClose={close} busy={busy} labelledBy={titleId}>
      <form onSubmit={submit}>
        <div className="modal-head">
          <div className="modal-icon">
            <PencilLine size={18} />
          </div>
          <div>
            <h2 id={titleId}>Rename {isDir ? "folder" : "file"}</h2>
            <p className="muted small mono">{path}</p>
          </div>
        </div>
        <label className="field">
          <span className="field-label">New name</span>
          <input ref={ref} value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} aria-invalid={!!error && value !== current} />
        </label>
        <p className={`hint ${error && value !== current ? "err-text" : ""}`}>
          {error && value !== current ? error : "Nothing is replaced: a name that is already taken is refused."}
        </p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !!error}>
            {busy && <Loader2 size={14} className="spin" />} Rename
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

/** At most this many paths are listed in the recycle-bin confirmation (all of them are sent). */
const TRASH_LIST_MAX = 200;

/** Confirm moving exactly `paths` to the recycle bin (never a permanent delete). */
export function LocalTrashModal({ paths, dirs }: { paths: string[]; dirs: number }) {
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const close = () => openModal(null);
  const n = paths.length;
  const confirm = async () => {
    setBusy(true);
    await trashLocalPaths(paths);
    setBusy(false);
    close();
  };
  return (
    <ModalShell onClose={close} busy={busy} labelledBy={titleId} wide={n > 1}>
      <div className="modal-head">
        <div className="modal-icon danger">
          <Trash2 size={18} />
        </div>
        <div>
          <h2 id={titleId}>{n === 1 ? "Move this to the recycle bin?" : `Move ${plural(n, "item")} to the recycle bin?`}</h2>
          <p className="muted small">On this computer. You can restore {n === 1 ? "it" : "them"} from the recycle bin.</p>
        </div>
      </div>
      <div className="key-list-wrap">
        <div className="key-list-head">
          <span>These exact paths go to the recycle bin</span>
        </div>
        <ol className="key-list mono" aria-label="Paths to move to the recycle bin">
          {paths.slice(0, TRASH_LIST_MAX).map((p) => (
            <li key={p}>
              <span className="key-text">{p}</span>
            </li>
          ))}
          {n > TRASH_LIST_MAX && <li className="muted">… and {(n - TRASH_LIST_MAX).toLocaleString()} more</li>}
        </ol>
      </div>
      {dirs > 0 && (
        <div className="callout warn">
          <AlertTriangle size={14} />
          <span>
            <strong>Everything inside {dirs === 1 ? "this folder" : `these ${dirs} folders`} goes with it</strong>, to the recycle bin.
          </span>
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={close} disabled={busy} data-autofocus>
          Cancel
        </button>
        <button type="button" className="btn btn-danger" onClick={() => void confirm()} disabled={busy}>
          {busy && <Loader2 size={14} className="spin" />} Move to the recycle bin
        </button>
      </div>
    </ModalShell>
  );
}

