import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Download,
  FileUp,
  FolderUp,
  FolderPlus,
  PanelRightClose,
  PanelRightOpen,
  PencilLine,
  RefreshCw,
  Scissors,
  Search,
  Trash2,
  Upload,
  X,
  Archive,
  ArchiveRestore,
  ArrowUp,
  Folder,
} from "lucide-react";
import { navigate, openModal, readPref, refresh, setDetailsOpen, setFilter, useApp, writePref } from "../store/app";
import { leaveSearch, rerunSearch, runSearch, setSearchScope, useSearch } from "../store/search";
import { clearClipboard, useClipboard } from "../store/clipboard";
import { copySelection, requestDelete, requestPaste, requestRename, requestRestoreArchived } from "../store/ops";
import { ARCHIVED_REASON, isArchiveClass, useArchiveBlocked } from "../store/archive";
import { copyText, downloadObjects, pickAndUpload } from "../store/actions";
import { pickAndUploadFolder, requestDownloadFolders } from "../store/folders";
import { PopupMenu } from "./PopupMenu";
import { getSelected, useSelectionInfo, useViewRows } from "../store/view";
import { displayName, formatBytes, parentPrefix, prefixSegments, s3Uri } from "../lib/format";
import { plural } from "../lib/ops";

function clipTitle(mode: "copy" | "cut", keys: string[]): string {
  const shown = keys.slice(0, 20).join("\n");
  const more = keys.length > 20 ? `\n… and ${keys.length - 20} more` : "";
  return `${mode === "cut" ? "Cut (moves on paste)" : "Copied"}:\n${shown}${more}`;
}

/** "Upload" (files) with a menu button next to it for "Upload files…" / "Upload folder…". */
function UploadButton({ disabled }: { disabled: boolean }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const caret = useRef<HTMLButtonElement>(null);
  const openMenu = () => {
    const r = caret.current?.getBoundingClientRect();
    if (r) setMenu({ x: r.left - 70, y: r.bottom + 4 });
  };
  return (
    <span className="split-btn">
      <button className="btn btn-primary split-main" disabled={disabled} onClick={() => void pickAndUpload()} title="Upload files">
        <Upload size={14} />
        <span className="btn-label">Upload</span>
      </button>
      <button
        ref={caret}
        className="btn btn-primary split-caret"
        disabled={disabled}
        onClick={() => (menu ? setMenu(null) : openMenu())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            openMenu();
          }
        }}
        title="More ways to upload"
        aria-label="More ways to upload"
        aria-haspopup="menu"
        aria-expanded={!!menu}
      >
        <ChevronDown size={13} />
      </button>
      {menu && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          label="Upload"
          onClose={() => {
            setMenu(null);
            caret.current?.focus();
          }}
          groups={[
            [
              { label: "Upload files…", icon: <FileUp size={14} />, action: () => void pickAndUpload() },
              { label: "Upload folder…", icon: <FolderUp size={14} />, action: () => void pickAndUploadFolder() },
            ],
          ]}
        />
      )}
    </span>
  );
}

const HINT_KEY = "s3x.searchHintDismissed";

/**
 * The toolbar box: typing filters the loaded rows (unchanged), Enter searches the bucket, Ctrl+F
 * focuses it, Esc clears it and leaves the results. The scope control sits beside it.
 */
function SearchBox() {
  const bucket = useApp((s) => s.bucket);
  const prefix = useApp((s) => s.prefix);
  const filter = useApp((s) => s.filter);
  const scope = useSearch((s) => s.scope);
  const searchOpen = useSearch((s) => s.open);
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [hintDismissed, setHintDismissed] = useState(() => readPref<boolean>(HINT_KEY, false));
  const disabled = !bucket;

  // Ctrl+F (Cmd+F) focuses the box, unless a dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "f") return;
      if (useApp.getState().modal) return;
      e.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const clear = leaveSearch;
  const dismissHint = () => {
    setHintDismissed(true);
    writePref(HINT_KEY, true);
  };
  const folderTitle = `Search this folder: s3://${bucket ?? ""}/${prefix}`;

  return (
    <div className="search-wrap">
      <div className={`search-box toolbar-search ${searchOpen ? "searching" : ""}`}>
        <Search size={13} />
        <input
          ref={input}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter · press Enter to search"
          aria-label="Filter loaded items; press Enter to search"
          spellCheck={false}
          disabled={disabled}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              clear();
            } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              runSearch(filter);
            }
          }}
        />
        {(filter || searchOpen) && (
          <button className="icon-btn" onClick={clear} aria-label="Clear" title="Clear (Esc)">
            <X size={12} />
          </button>
        )}
        {focused && !filter && !hintDismissed && (
          <div className="search-hint" role="note" onMouseDown={(e) => e.preventDefault()}>
            <span>
              Enter searches: <code>word</code> <code>"a phrase"</code> <code>-not</code> <code>tag:key=value</code> <code>folder/part</code>
            </span>
            <button className="icon-btn" onClick={dismissHint} aria-label="Dismiss hint" title="Don't show again">
              <X size={11} />
            </button>
          </div>
        )}
      </div>
      <div className="segmented scope-seg" role="group" aria-label="Search scope">
        <button
          className={scope === "folder" ? "active" : ""}
          aria-pressed={scope === "folder"}
          disabled={disabled}
          onClick={() => setSearchScope("folder")}
          title={folderTitle}
        >
          <Folder size={12} />
          <span className="seg-long">This folder</span>
          <span className="seg-short">Folder</span>
        </button>
        <button
          className={scope === "bucket" ? "active" : ""}
          aria-pressed={scope === "bucket"}
          disabled={disabled}
          onClick={() => setSearchScope("bucket")}
          title={`Search the whole bucket: s3://${bucket ?? ""}/`}
        >
          <Archive size={12} />
          <span className="seg-long">Whole bucket</span>
          <span className="seg-short">Bucket</span>
        </button>
      </div>
    </div>
  );
}

export function Toolbar() {
  const bucket = useApp((s) => s.bucket);
  const prefix = useApp((s) => s.prefix);
  const loading = useApp((s) => s.listing.loading);
  const detailsOpen = useApp((s) => s.detailsOpen);
  const searchOpen = useSearch((s) => s.open);
  const searching = useSearch((s) => s.loading);
  const sel = useSelectionInfo();
  const selCount = sel.folders + sel.objects;
  const clip = useClipboard((s) => s.clip);
  const disabled = !bucket;
  // One archived object that isn't restored can't be downloaded, copied, moved or renamed.
  const blocked = useArchiveBlocked(bucket, sel.object);
  const why = (title: string) => (blocked ? ARCHIVED_REASON : title);
  // Restore is offered only when the selection holds archived objects (folders: context menu).
  const archivedCount = useMemo(
    () => (sel.objects ? getSelected().objects.filter((o) => isArchiveClass(o.storageClass)).length : 0),
    [sel],
  );

  return (
    <div className="toolbar">
      <div className="tool-group">
        {/* No folder is in view while search results are open: nothing to upload or create into. */}
        <UploadButton disabled={disabled || searchOpen} />
        <button className="btn" disabled={disabled || searchOpen} onClick={() => openModal({ kind: "newFolder" })} title={searchOpen ? "Go back to a folder to create one" : "New folder"}>
          <FolderPlus size={14} />
          <span className="btn-label secondary">New folder</span>
        </button>
        <button
          className="btn"
          disabled={disabled || sel.objects + sel.folders === 0 || blocked}
          onClick={() => {
            // Objects selected: download those (as before). Only folders: download the folders.
            const { objects, folders } = getSelected();
            if (objects.length) void downloadObjects(objects);
            else void requestDownloadFolders(folders);
          }}
          title={
            blocked
              ? ARCHIVED_REASON
              : sel.objects > 1
              ? `Download ${sel.objects} objects`
              : sel.objects === 0 && sel.folders > 1
                ? `Download ${sel.folders} folders`
                : sel.objects === 0 && sel.folders === 1
                  ? "Download folder"
                  : "Download"
          }
        >
          <Download size={14} />
          <span className="btn-label secondary">Download</span>
        </button>
        <span className="tool-sep" />
        <button
          className="icon-btn lg"
          disabled={disabled || selCount === 0 || blocked}
          onClick={() => void copySelection("copy")}
          title={why("Copy (Ctrl+C)")}
          aria-label="Copy"
        >
          <Copy size={15} />
        </button>
        <button
          className="icon-btn lg"
          disabled={disabled || selCount === 0 || blocked}
          onClick={() => void copySelection("cut")}
          title={why("Cut (Ctrl+X)")}
          aria-label="Cut"
        >
          <Scissors size={15} />
        </button>
        <button
          className="icon-btn lg"
          disabled={disabled || !clip || searchOpen}
          onClick={() => requestPaste()}
          title={searchOpen ? "Go back to a folder to paste into it" : clip ? `Paste into this folder (Ctrl+V)` : "Paste (clipboard is empty)"}
          aria-label="Paste"
        >
          <ClipboardPaste size={15} />
        </button>
        <button
          className="icon-btn lg"
          disabled={disabled || selCount !== 1 || blocked}
          onClick={() => void requestRename()}
          title={why("Rename (F2)")}
          aria-label="Rename"
        >
          <PencilLine size={15} />
        </button>
        {archivedCount > 0 && (
          <button
            className="icon-btn lg"
            disabled={disabled}
            onClick={() => requestRestoreArchived()}
            title={archivedCount === 1 && selCount === 1 ? "Restore from the archive…" : `Restore archived objects (${archivedCount.toLocaleString()})…`}
            aria-label="Restore archived"
          >
            <ArchiveRestore size={15} />
          </button>
        )}
        <button
          className="btn btn-danger-ghost"
          disabled={disabled || selCount === 0}
          onClick={() => requestDelete()}
          title={selCount > 1 ? `Delete ${selCount} items (Delete)` : "Delete (Delete)"}
        >
          <Trash2 size={14} />
          <span className="btn-label secondary">Delete</span>
        </button>
        <span className="tool-sep" />
        <button className="icon-btn lg" disabled={disabled || !prefix} onClick={() => bucket && navigate(bucket, parentPrefix(prefix))} title="Up one level (Backspace)">
          <ArrowUp size={15} />
        </button>
        <button
          className="icon-btn lg"
          disabled={disabled}
          onClick={() => (searchOpen ? rerunSearch() : refresh())}
          title={searchOpen ? "Search again" : "Refresh"}
        >
          <RefreshCw size={15} className={(searchOpen ? searching : loading) ? "spin" : ""} />
        </button>
      </div>
      <div className="tool-group right">
        {clip && (
          <div className={`clip-chip ${clip.mode}`} title={clipTitle(clip.mode, clip.items.map((i) => i.key))}>
            {clip.mode === "cut" ? <Scissors size={12} /> : <Copy size={12} />}
            <span className="clip-count">
              {plural(clip.items.length, "item")} {clip.mode === "cut" ? "cut" : "copied"}
            </span>
            <span className="clip-from">
              from <span className="mono">{s3Uri(clip.bucket, clip.prefix).slice(5)}</span>
            </span>
            <button className="icon-btn" onClick={clearClipboard} aria-label="Clear clipboard" title="Clear clipboard">
              <X size={12} />
            </button>
          </div>
        )}
        <SearchBox />
        <button
          className={`icon-btn lg ${detailsOpen ? "active" : ""}`}
          onClick={() => setDetailsOpen(!detailsOpen)}
          title={detailsOpen ? "Hide details" : "Show details"}
        >
          {detailsOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
        </button>
      </div>
    </div>
  );
}

export function Breadcrumbs() {
  const bucket = useApp((s) => s.bucket);
  const prefix = useApp((s) => s.prefix);
  const truncated = useApp((s) => s.listing.truncated);
  const loading = useApp((s) => s.listing.loading);
  const total = useApp((s) => s.listing.folders.length + s.listing.objects.length);
  const rows = useViewRows();
  const filter = useApp((s) => s.filter);
  const sel = useSelectionInfo();
  // While search results are open they say what they hold; the folder's counts would only confuse.
  const searchOpen = useSearch((s) => s.open);
  if (!bucket) return null;
  const segs = prefixSegments(prefix);
  const selCount = sel.folders + sel.objects;
  return (
    <div className="breadcrumbs">
      <nav className="crumbs" aria-label="Path">
        <button
          className={`crumb ${segs.length === 0 ? "current" : ""}`}
          onClick={() => navigate(bucket, "")}
          title={`s3://${bucket}/`}
          data-drop-bucket={bucket}
          data-drop-prefix=""
        >
          <Archive size={13} />
          {bucket}
        </button>
        {segs.map((s, i) => (
          <Fragment key={s.prefix}>
            <ChevronRight size={13} className="crumb-sep" />
            <button
              className={`crumb ${i === segs.length - 1 ? "current" : ""}`}
              onClick={() => navigate(bucket, s.prefix)}
              title={`s3://${bucket}/${s.prefix}`}
              data-drop-bucket={bucket}
              data-drop-prefix={s.prefix}
            >
              {displayName(s.name)}
            </button>
          </Fragment>
        ))}
        <button
          className="icon-btn crumb-copy"
          onClick={() => void copyText(s3Uri(bucket, prefix), "Path")}
          title={`Copy path: ${s3Uri(bucket, prefix)}`}
          aria-label="Copy path"
        >
          <Copy size={12} />
        </button>
      </nav>
      <div className="crumb-info muted" hidden={searchOpen}>
        {selCount > 0 && (
          <span className="sel-info">
            {selCount.toLocaleString()} selected{sel.objects > 0 ? ` · ${formatBytes(sel.bytes)}` : ""}
            <span className="dot-sep">·</span>
          </span>
        )}
        {loading && total === 0
          ? "Loading…"
          : filter
            ? `${rows.length.toLocaleString()} of ${total.toLocaleString()}${truncated ? "+" : ""} items`
            : `${total.toLocaleString()}${truncated ? "+" : ""} items`}
      </div>
    </div>
  );
}
