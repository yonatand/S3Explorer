import { Fragment, useMemo, useRef, useState } from "react";
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
  ArrowLeft,
  ArrowRight,
  Columns2,
  CopyPlus,
  Folder,
  FolderInput,
  Star,
} from "lucide-react";
import { goHistory, navigate, readPref, refresh, setDetailsOpen, setFilter, setSplit, useApp, usePane, usePaneId, writePref } from "../store/app";
import { isLocalPane, otherPane, usePanes } from "../store/panes";
import { crossRefusal, locLabel, transferToOtherPane, type Loc } from "../store/cross";
import { isNetworkPath, localUp, NO_RECYCLE_BIN, openLocalNewFolder, requestLocalRename, requestLocalTrash } from "../store/local";
import { onPathBarClick, SourceButton } from "./LocalPane";
import { getSearch, leaveSearch, requestResultsFocus, rerunSearch, runSearch, scheduleSearch, searchScheduled, setSearchScope, usePaneSearch, useSearch } from "../store/search";
import { focusPaneListSoon, useKeyHint, withKey } from "../store/keyboard";
import { isBookmarked, toggleBookmark, useBookmarks } from "../store/bookmarks";
import { clearClipboard, useClipboard } from "../store/clipboard";
import { copySelection, requestDelete, requestPaste, requestRename, requestRestoreArchived } from "../store/ops";
import { ARCHIVED_REASON, isArchiveClass, useArchiveBlocked } from "../store/archive";
import { copyText, downloadObjects, openNewFolder, pickAndUpload } from "../store/actions";
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
const TYPING_HINT_KEY = "s3x.searchTypingHintDismissed";

/**
 * The search box, on its own row under the toolbar: typing filters the loaded rows at once and
 * searches 500 ms after the last keystroke (Enter searches right away); Esc clears it and leaves
 * the results. The scope control sits beside it. Mod+F, `/` and Alt+F7 (Total Commander) focus it
 * (key dispatcher); typing in the file list jumps to a row instead (v0.9.0). While the box is empty a hint shows the query syntax; while there is text, one
 * says what is being searched and that Enter searches now, since the scope is easy to miss.
 */
function SearchBox() {
  const pane = usePaneId();
  const bucket = usePane((s) => s.bucket);
  const prefix = usePane((s) => s.prefix);
  const filter = usePane((s) => s.filter);
  const scope = useSearch((s) => s.scope);
  const searchOpen = usePaneSearch((s) => s.open);
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [hintDismissed, setHintDismissed] = useState(() => readPref<boolean>(HINT_KEY, false));
  const [typingHintDismissed, setTypingHintDismissed] = useState(() => readPref<boolean>(TYPING_HINT_KEY, false));
  const local = usePane((s) => isLocalPane(s));
  const disabled = !bucket;
  const searchKey = useKeyHint("nav.focusSearch");

  const clear = () => {
    leaveSearch(pane);
    focusPaneListSoon(pane);
  };
  const dismissHint = () => {
    setHintDismissed(true);
    writePref(HINT_KEY, true);
  };
  const dismissTypingHint = () => {
    setTypingHintDismissed(true);
    writePref(TYPING_HINT_KEY, true);
  };
  const folderTitle = `Search this folder: s3://${bucket ?? ""}/${prefix}`;
  // At the bucket root "this folder" is the whole bucket, so say so (as the results header does).
  const wholeBucket = scope === "bucket" || !prefix;

  return (
    <div className="search-wrap">
      <div className={`search-box toolbar-search ${searchOpen ? "searching" : ""}`}>
        <Search size={13} />
        <input
          ref={input}
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value, pane);
            scheduleSearch(e.target.value, pane);
          }}
          placeholder={wholeBucket ? "Search the whole bucket · as you type, Enter searches now" : "Search this folder · as you type, Enter searches now"}
          aria-label="Filter loaded items; searches as you type"
          title={local ? "Search works on S3 panes, not on this computer" : withKey("Search", searchKey)}
          spellCheck={false}
          disabled={disabled}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Escape") {
              e.preventDefault();
              clear();
            } else if (e.key === "Enter") {
              // Right away (no waiting for the typing to stop), and the results take the keyboard.
              e.preventDefault();
              const s = getSearch(pane);
              const same = s.open && s.request?.text === filter && !searchScheduled(pane);
              if (!same) runSearch(filter, pane);
              if (getSearch(pane).open) requestResultsFocus(pane);
            } else if (e.key === "ArrowDown" && !e.altKey && !e.ctrlKey && !e.metaKey && (getSearch(pane).open || searchScheduled(pane))) {
              e.preventDefault();
              requestResultsFocus(pane);
            }
          }}
        />
        {(filter || searchOpen) && (
          <button className="icon-btn" onClick={clear} aria-label="Clear" title="Clear (Esc)">
            <X size={12} />
          </button>
        )}
        {focused && filter && !typingHintDismissed && (
          <div className="search-hint typing" role="note" onMouseDown={(e) => e.preventDefault()}>
            <span>
              {wholeBucket ? (
                <>
                  Searching the <strong>whole bucket</strong>. <kbd>Enter</kbd> searches now.
                </>
              ) : (
                <>
                  Searching <strong>this folder only</strong>. <kbd>Enter</kbd> searches now · <strong>Whole bucket</strong> is on the right.
                </>
              )}
            </span>
            <button className="icon-btn" onClick={dismissTypingHint} aria-label="Dismiss hint" title="Got it, don't show again">
              <X size={11} />
            </button>
          </div>
        )}
        {focused && !filter && !hintDismissed && (
          <div className="search-hint" role="note" onMouseDown={(e) => e.preventDefault()}>
            <span>
              Searches as you type: <code>word</code> <code>"a phrase"</code> <code>-not</code> <code>tag:key=value</code> <code>folder/part</code>
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

/** The row under the toolbar that holds the search box and its scope, full width. */
export function SearchRow() {
  return (
    <div className="search-row">
      <SearchBox />
    </div>
  );
}

/** The other pane's destination when two panes are on screen: its bucket and folder, or null. */
export function useOtherPaneDest(): { bucket: string; prefix: string } | null {
  const loc = useOtherPaneLoc();
  return loc?.kind === "s3" ? { bucket: loc.bucket, prefix: loc.prefix } : null;
}

/** v0.9.0: the other pane's location when two panes are on screen (S3 or a local directory), or null. */
export function useOtherPaneLoc(): Loc | null {
  const shown = useApp((s) => s.split && !s.narrow);
  const other = otherPane(useApp((s) => s.activePane));
  const bucket = usePanes((s) => s[other].bucket);
  const prefix = usePanes((s) => s[other].prefix);
  const dir = usePanes((s) => (isLocalPane(s[other]) ? s[other].local!.dir : null));
  if (!shown) return null;
  if (dir !== null) return { kind: "local", dir };
  return bucket ? { kind: "s3", bucket, prefix } : null;
}

/** Split / Single: one toggle, pressed while two panes are open (Mod+2 / Mod+1 by default). */
function SplitButton() {
  const split = useApp((s) => s.split);
  const narrow = useApp((s) => s.narrow);
  const single = useKeyHint("view.single");
  const two = useKeyHint("view.split");
  const title = split
    ? narrow
      ? `${withKey("Single view", single)}. The second pane is hidden: the window is too narrow for two panes.`
      : `${withKey("Single view", single)}: keep only the active pane`
    : `${withKey("Split view", two)}: two panes side by side`;
  return (
    <button
      className={`icon-btn lg split-toggle ${split ? "active" : ""} ${split && narrow ? "hidden-pane" : ""}`}
      onClick={() => setSplit(!split)}
      title={title}
      aria-label={split ? "Single view" : "Split view"}
      aria-pressed={split}
    >
      <Columns2 size={15} />
    </button>
  );
}

export function Toolbar() {
  const bucket = usePane((s) => s.bucket);
  // v0.9.0: the active pane shows this computer. S3-only actions are disabled with the reason.
  const local = usePane((s) => isLocalPane(s));
  // A network location (v0.9.1): no recycle bin, so Delete is refused with the reason.
  const onShare = usePane((s) => !!s.local && isNetworkPath(s.local.dir));
  const prefix = usePane((s) => s.prefix);
  const loading = usePane((s) => s.listing.loading);
  const detailsOpen = useApp((s) => s.detailsOpen);
  // What the explorer shows: the panel while the active pane has a bucket or a local folder open (Explorer.tsx).
  const detailsShown = detailsOpen && (!!bucket || local);
  const searchOpen = usePaneSearch((s) => s.open);
  const searching = usePaneSearch((s) => s.loading);
  const sel = useSelectionInfo();
  const selCount = sel.folders + sel.objects;
  const clip = useClipboard((s) => s.clip);
  const disabled = !bucket && !local;
  // One archived object that isn't restored can't be downloaded, copied, moved or renamed.
  const blocked = useArchiveBlocked(bucket, sel.object);
  const dest = useOtherPaneLoc();
  const splitShown = useApp((s) => s.split && !s.narrow);
  const destUri = dest ? locLabel(dest) : "";
  // Between this computer and S3: copy = download / upload; two local panes: not here.
  const otherRefused = dest ? crossRefusal(local ? "local" : "s3", dest.kind) : null;
  const S3_ONLY = "Works on S3 panes, not on this computer";
  const CLIP_LOCAL = "The clipboard holds S3 items; use Copy to other pane between S3 and this computer";
  const why = (title: string) => (blocked ? ARCHIVED_REASON : title);
  // Restore is offered only when the selection holds archived objects (folders: context menu).
  const archivedCount = useMemo(
    () => (sel.objects ? getSelected().objects.filter((o) => isArchiveClass(o.storageClass)).length : 0),
    [sel],
  );
  const k = {
    copy: useKeyHint("act.copy"),
    cut: useKeyHint("act.cut"),
    paste: useKeyHint("act.paste"),
    rename: useKeyHint("act.rename"),
    toOther: useKeyHint("act.copyToOther"),
    moveOther: useKeyHint("act.moveToOther"),
    del: useKeyHint("act.delete"),
    up: useKeyHint("nav.up"),
    back: useKeyHint("nav.back"),
    forward: useKeyHint("nav.forward"),
    refresh: useKeyHint("nav.refresh"),
    newFolder: useKeyHint("act.newFolder"),
    download: useKeyHint("act.download"),
    details: useKeyHint("view.details"),
  };
  // Back / Forward follow the active pane's history.
  const paneId = usePaneId();
  const backOk = usePanes((s) => s[paneId].history.index > 0);
  const forwardOk = usePanes((s) => s[paneId].history.index < s[paneId].history.entries.length - 1);

  return (
    <div className={`toolbar ${dest || splitShown ? "split" : ""}`}>
      <div className="tool-group">
        {/* No folder is in view while search results are open: nothing to upload or create into. */}
        <UploadButton disabled={disabled || searchOpen || local} />
        <button
          className="btn"
          disabled={disabled || searchOpen}
          onClick={() => (local ? openLocalNewFolder() : openNewFolder())}
          title={searchOpen ? "Go back to a folder to create one" : withKey("New folder", k.newFolder)}
        >
          <FolderPlus size={14} />
          <span className="btn-label secondary">New folder</span>
        </button>
        <button
          className="btn"
          disabled={disabled || local || sel.objects + sel.folders === 0 || blocked}
          onClick={() => {
            // Objects selected: download those (as before). Only folders: download the folders.
            const { objects, folders } = getSelected();
            if (objects.length) void downloadObjects(objects);
            else void requestDownloadFolders(folders);
          }}
          title={
            local
              ? "These files are already on this computer"
              : blocked
              ? ARCHIVED_REASON
              : sel.objects > 1
              ? `Download ${sel.objects} objects`
              : sel.objects === 0 && sel.folders > 1
                ? `Download ${sel.folders} folders`
                : sel.objects === 0 && sel.folders === 1
                  ? withKey("Download folder", k.download)
                  : withKey("Download", k.download)
          }
        >
          <Download size={14} />
          <span className="btn-label secondary">Download</span>
        </button>
        <span className="tool-sep" />
        <button
          className="icon-btn lg"
          disabled={disabled || local || selCount === 0 || blocked}
          onClick={() => void copySelection("copy")}
          title={local ? CLIP_LOCAL : why(withKey("Copy", k.copy))}
          aria-label="Copy"
        >
          <Copy size={15} />
        </button>
        <button
          className="icon-btn lg"
          disabled={disabled || local || selCount === 0 || blocked}
          onClick={() => void copySelection("cut")}
          title={local ? CLIP_LOCAL : why(withKey("Cut", k.cut))}
          aria-label="Cut"
        >
          <Scissors size={15} />
        </button>
        <button
          className="icon-btn lg"
          disabled={disabled || local || !clip || searchOpen}
          onClick={() => requestPaste()}
          title={local ? CLIP_LOCAL : searchOpen ? "Go back to a folder to paste into it" : clip ? withKey("Paste into this folder", k.paste) : "Paste (clipboard is empty)"}
          aria-label="Paste"
        >
          <ClipboardPaste size={15} />
        </button>
        <button
          className="icon-btn lg"
          disabled={disabled || selCount !== 1 || blocked}
          onClick={() => (local ? requestLocalRename() : void requestRename())}
          title={why(withKey("Rename", k.rename))}
          aria-label="Rename"
        >
          <PencilLine size={15} />
        </button>
        {dest && (
          <>
            <button
              className="icon-btn lg"
              disabled={disabled || selCount === 0 || blocked || !!otherRefused}
              onClick={() => transferToOtherPane("copy")}
              title={otherRefused ?? (blocked ? ARCHIVED_REASON : `${withKey(local ? "Upload to other pane" : dest.kind === "local" ? "Download to other pane" : "Copy to other pane", k.toOther)}: ${destUri}`)}
              aria-label="Copy to other pane"
            >
              <CopyPlus size={15} />
            </button>
            <button
              className="icon-btn lg"
              disabled={disabled || selCount === 0 || blocked || !!otherRefused}
              onClick={() => transferToOtherPane("cut")}
              title={
                otherRefused ??
                (blocked
                  ? ARCHIVED_REASON
                  : `${withKey("Move to other pane", k.moveOther)}: ${destUri}${local ? (onShare ? " (the files stay on the network location: it has no recycle bin)" : " (then to the recycle bin here)") : dest.kind === "local" ? " (then the downloaded objects are deleted from S3)" : ""}`)
              }
              aria-label="Move to other pane"
            >
              <FolderInput size={15} />
            </button>
          </>
        )}
        {archivedCount > 0 && !local && (
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
          disabled={disabled || selCount === 0 || onShare}
          onClick={() => (local ? requestLocalTrash() : requestDelete())}
          title={onShare ? NO_RECYCLE_BIN : local ? withKey("Move to the recycle bin", k.del) : withKey(selCount > 1 ? `Delete ${selCount} items` : "Delete", k.del)}
          data-reason={onShare ? NO_RECYCLE_BIN : undefined}
        >
          <Trash2 size={14} />
          <span className="btn-label secondary">Delete</span>
        </button>
        <span className="tool-sep" />
        <button className="icon-btn lg tb-history" disabled={!backOk} onClick={() => goHistory(-1)} title={withKey("Back", k.back)} aria-label="Back">
          <ArrowLeft size={15} />
        </button>
        <button className="icon-btn lg tb-history" disabled={!forwardOk} onClick={() => goHistory(1)} title={withKey("Forward", k.forward)} aria-label="Forward">
          <ArrowRight size={15} />
        </button>
        <button
          className="icon-btn lg"
          disabled={disabled || (!local && !prefix)}
          onClick={() => (local ? localUp(paneId) : bucket && navigate(bucket, parentPrefix(prefix)))}
          title={withKey("Up one level", k.up)}
          aria-label="Up one level"
        >
          <ArrowUp size={15} />
        </button>
        <button
          className="icon-btn lg"
          disabled={disabled}
          onClick={() => (searchOpen ? rerunSearch() : refresh())}
          title={withKey(searchOpen ? "Search again" : "Refresh", k.refresh)}
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
        <SplitButton />
        {/* The details panel waits for an open bucket in the active pane; the toggle follows it. */}
        <button
          className={`icon-btn lg ${detailsShown ? "active" : ""}`}
          onClick={() => setDetailsOpen(!detailsOpen)}
          disabled={!bucket}
          aria-pressed={detailsShown}
          title={local ? `Details: ${S3_ONLY.toLowerCase()}` : bucket ? withKey(detailsOpen ? "Hide details" : "Show details", k.details) : "Open a bucket to see details"}
        >
          {detailsShown ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
        </button>
      </div>
    </div>
  );
}

export function Breadcrumbs() {
  const pane = usePaneId();
  const bucket = usePane((s) => s.bucket);
  const prefix = usePane((s) => s.prefix);
  const truncated = usePane((s) => s.listing.truncated);
  const loading = usePane((s) => s.listing.loading);
  const total = usePane((s) => s.listing.folders.length + s.listing.objects.length);
  const rows = useViewRows();
  const filter = usePane((s) => s.filter);
  const sel = useSelectionInfo();
  // While search results are open they say what they hold; the folder's counts would only confuse.
  const searchOpen = usePaneSearch((s) => s.open);
  const bookmarked = useBookmarks((s) => !!bucket && isBookmarked(s.items, bucket, prefix));
  const bookmarkKey = useKeyHint("nav.bookmark");
  const editKey = useKeyHint("nav.editPath");
  if (!bucket) return null;
  const segs = prefixSegments(prefix);
  const selCount = sel.folders + sel.objects;
  return (
    <div className="breadcrumbs" onClick={onPathBarClick(pane)} title={withKey("Click to type a path", editKey)}>
      <nav className="crumbs" aria-label="Path">
        <SourceButton pane={pane} />
        <button
          className={`crumb ${segs.length === 0 ? "current" : ""}`}
          onClick={() => navigate(bucket, "", pane)}
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
              onClick={() => navigate(bucket, s.prefix, pane)}
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
        <button
          className={`icon-btn crumb-star ${bookmarked ? "on" : ""}`}
          onClick={() => toggleBookmark(bucket, prefix)}
          title={withKey(bookmarked ? "Remove bookmark" : "Bookmark this folder", bookmarkKey)}
          aria-label={bookmarked ? "Remove bookmark" : "Bookmark this folder"}
          aria-pressed={bookmarked}
        >
          <Star size={12} fill={bookmarked ? "currentColor" : "none"} />
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
