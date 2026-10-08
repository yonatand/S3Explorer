import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, Globe, LogOut, MapPin, UploadCloud } from "lucide-react";
import * as api from "../lib/api";
import { readPref, requestDisconnect, useApp, writePref } from "../store/app";
import { installTransferEffects } from "../store/actions";
import { handleOsDrop, installBatchEffects } from "../store/folders";
import { installJobEffects } from "../store/ops";
import { installTagEffects } from "../store/tags";
import { installArchiveEffects } from "../store/archive";
import { DragBadge } from "./RowDrag";
import { Sidebar } from "./Sidebar";
import { Breadcrumbs, Toolbar } from "./Toolbar";
import { ObjectTable } from "./ObjectTable";
import { SearchResults } from "./SearchResults";
import { useSearch } from "../store/search";
import { toast } from "../store/toasts";
import { DetailsPanel } from "./DetailsPanel";
import { ActivityPanel } from "./TransfersPanel";
import { ContextMenu } from "./ContextMenu";
import { Modals } from "./Modals";
import { Logo } from "./Logo";
import { SettingsButton } from "./SettingsDialog";
import { ThemeToggle } from "./ThemeToggle";

function ConnectionChip() {
  const conn = useApp((s) => s.connection);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (!conn) return null;
  return (
    <div className="conn-chip-wrap" ref={ref}>
      <button className="conn-chip" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="status-dot" />
        <span className="conn-label">{conn.label}</span>
        <span className="conn-region">{conn.region}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="popover">
          <div className="popover-head">
            <span className="popover-status">
              <span className="status-dot" /> Connected
            </span>
            <span className="popover-name">{conn.label}</span>
          </div>
          <div className="popover-row">
            <span className="muted">
              <MapPin size={13} /> Region
            </span>
            <span>{conn.region}</span>
          </div>
          <div className="popover-row">
            <span className="muted">
              <Globe size={13} /> Endpoint
            </span>
            <span title={conn.endpoint ?? undefined}>{conn.endpoint ?? "AWS"}</span>
          </div>
          {!conn.canListBuckets && <div className="popover-note">This connection is not allowed to list buckets.</div>}
          <button
            className="btn btn-danger-ghost popover-action"
            onClick={() => {
              setOpen(false);
              requestDisconnect();
            }}
          >
            <LogOut size={14} /> Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

function useFileDrop() {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let unlisten: api.Unlisten | null = null;
    let disposed = false;
    api
      .onFileDrop((e) => {
        if (e.type === "enter" || e.type === "over") setDragging(true);
        else if (e.type === "leave") setDragging(false);
        else {
          setDragging(false);
          // Files upload right away; a folder opens the upload-folder confirmation. Not while search
          // results are open: no folder is in view to upload into.
          if (!e.paths.length) return;
          if (useSearch.getState().open) toast.info("Go back to a folder to upload", "Search results are open; nothing was uploaded.");
          else void handleOsDrop(e.paths);
        }
      })
      .then((u) => (disposed ? u() : (unlisten = u)))
      .catch(() => {
        /* drag & drop unavailable */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  return dragging;
}

const SIDEBAR_WIDTH_KEY = "s3x.sidebarWidth";
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 640;

/**
 * The sidebar's width as set by dragging its border, or null while it follows the window size.
 * During a drag the width is written straight to the element, so the file table does not re-render
 * on every pointer move; the state and the saved preference are updated once, on release.
 */
function useSidebarResize() {
  const workspace = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => readPref<number | null>(SIDEBAR_WIDTH_KEY, null));

  const save = (next: number | null) => {
    setWidth(next);
    writePref(SIDEBAR_WIDTH_KEY, next);
  };
  const onPointerDown = (e: ReactPointerEvent) => {
    const el = workspace.current;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    const left = el.getBoundingClientRect().left;
    let latest = width;
    const onMove = (move: PointerEvent) => {
      latest = Math.round(Math.min(Math.max(move.clientX - left, SIDEBAR_MIN), SIDEBAR_MAX));
      el.style.setProperty("--sidebar-w", `${latest}px`);
    };
    const onEnd = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      save(latest);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  const style = width === null ? undefined : ({ "--sidebar-w": `${width}px` } as CSSProperties);
  return { workspace, style, onPointerDown, reset: () => save(null) };
}

export function Explorer() {
  const bucket = useApp((s) => s.bucket);
  // Details describe an item inside a bucket, so the panel stays closed until one is open.
  const detailsOpen = useApp((s) => s.detailsOpen) && bucket !== null;
  const prefix = useApp((s) => s.prefix);
  const searchOpen = useSearch((s) => s.open) && bucket !== null;
  const dragging = useFileDrop();
  const sidebar = useSidebarResize();

  useEffect(() => installTransferEffects(), []);
  useEffect(() => installJobEffects(), []);
  useEffect(() => installBatchEffects(), []);
  useEffect(() => installTagEffects(), []);
  useEffect(() => installArchiveEffects(), []);

  return (
    <div className="app">
      <header className="titlebar">
        <button type="button" className="brand brand-link" onClick={requestDisconnect} title="Back to connections">
          <Logo size={26} />
          <span>S3 Explorer</span>
        </button>
        <div className="spacer" />
        <ConnectionChip />
        <ThemeToggle />
        <SettingsButton />
      </header>
      <div ref={sidebar.workspace} className={`workspace ${detailsOpen ? "with-details" : ""}`} style={sidebar.style}>
        <Sidebar />
        <div
          className="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the sidebar"
          title="Drag to resize. Double-click to reset."
          onPointerDown={sidebar.onPointerDown}
          onDoubleClick={sidebar.reset}
        />
        <main className="browser">
          {bucket && <Toolbar />}
          {bucket && <Breadcrumbs />}
          <div className="table-wrap">
            {searchOpen ? <SearchResults /> : <ObjectTable />}
            {dragging && (
              <div className={`drop-overlay ${bucket ? "" : "disabled"}`}>
                <div className="drop-card">
                  <UploadCloud size={34} strokeWidth={1.5} />
                  <div className="drop-title">
                    {!bucket ? "Select a bucket first" : searchOpen ? "Go back to a folder to upload" : "Drop files or a folder to upload"}
                  </div>
                  {bucket && <div className="muted mono small">s3://{bucket}/{prefix}</div>}
                </div>
              </div>
            )}
          </div>
        </main>
        {detailsOpen && <DetailsPanel />}
      </div>
      <ActivityPanel />
      <ContextMenu />
      <Modals />
      <DragBadge />
    </div>
  );
}
