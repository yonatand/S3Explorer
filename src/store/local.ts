// Local panes (v0.9.0): the local computer as a pane source (see "Pane sources" in
// docs/CONTRACT.md). The roots (drives, home), folder sizes on request, the file operations of a
// local pane (new folder, rename, recycle bin, open, show in folder), the source menu, and the
// editable path bar (for both kinds of pane). The pane state itself lives in ./panes.ts and its
// listing in ./app.ts (navigateLocal).

import { create } from "zustand";
import * as api from "../lib/api";
import type { AppError, LocalEntry, LocalRoot } from "../lib/types";
import { asFolderPrefix, basename } from "../lib/format";
import { parseS3Path } from "../lib/search";
import { plural } from "../lib/ops";
import { activePane, getPane, navigate, navigateLocal, openModal, refreshLocalPanesAt, revealObject, setPane, useApp } from "./app";
import { isLocalPane, usePanes, type PaneId } from "./panes";
import { getSelected } from "./view";
import { toast } from "./toasts";
import { copyText } from "./actions";
import { tooMany } from "./ops";

// ---- paths ---------------------------------------------------------------------------------------

/** Windows: drive letters and `\`; elsewhere `/`. Decided from the webview's own report. */
const WINDOWS = api.clientOS === "windows";

/**
 * Is `text` an absolute local path as typed (`C:\…`, `C:`, `/…` outside Windows, a UNC path
 * `\\server\share\…` or `//server/share`, or a device path, which the backend refuses with its own
 * message)?
 */
export function looksLocal(text: string): boolean {
  if (/^[A-Za-z]:([\\/]|$)/.test(text)) return true;
  if (/^(\\\\|\/\/)/.test(text)) return true;
  return !WINDOWS && text.startsWith("/");
}

/**
 * The share root of a UNC path exactly as typed (`\\server\share` or `//server/share`, either
 * separator), or null when `path` is not a UNC path naming a server and a share. Device paths
 * (`\\.\…`, `\\?\…`) are not UNC paths here.
 */
export function uncRoot(path: string): string | null {
  const m = /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)/.exec(path);
  if (!m || m[1] === "." || m[1] === "?") return null;
  return m[0];
}

/** A UNC path that names a server and a share (`\\server\share[\…]`, `//server/share[/…]`). */
export const isUncPath = (path: string) => uncRoot(path) !== null;

/**
 * Starts like a network or device path (`\\` or `//`) but is not one this app accepts: a device
 * path, or a server without a share. The backend refuses it with its own message (shown inline).
 */
const refusedUnc = (path: string) => /^(\\\\|\/\/)/.test(path) && !isUncPath(path);

/** The root of a mapped network drive: a drive whose label shows the UNC it maps to (`Z: (\\nas\data)`). */
function mappedDriveRoot(path: string): string | null {
  const m = /^([A-Za-z]:)/.exec(path);
  if (!m) return null;
  const drive = m[1].toLowerCase();
  const r = useLocalRoots.getState().roots.find((x) => x.kind === "drive" && x.path.slice(0, 2).toLowerCase() === drive);
  return r && /\([\\/]{2}[^)]+\)\s*$/.test(r.label) ? r.path : null;
}

/** A root that is a network location: a saved Network Location, or a mapped network drive. */
export const isNetworkRoot = (r: LocalRoot) => r.kind === "network" || (r.kind === "drive" && /\([\\/]{2}[^)]+\)\s*$/.test(r.label));

/**
 * Is `path` on a network location (a UNC path, or a mapped network drive)? Those have no recycle
 * bin, so this app never deletes there (see "Network locations in a local pane" in docs/CONTRACT.md).
 */
export const isNetworkPath = (path: string) => isUncPath(path) || mappedDriveRoot(path) !== null;

/** Why a delete on a network location isn't done here. */
export const NO_RECYCLE_BIN = "No recycle bin on a network location; delete it in the file manager";

/** "C:" means the drive root. */
const asTypedDir = (text: string) => (/^[A-Za-z]:$/.test(text) ? `${text}\\` : text);

/** The separator a path uses. */
const sepOf = (path: string) => (path.includes("\\") || /^[A-Za-z]:/.test(path) ? "\\" : "/");

/**
 * The parent of a typed path (null at a root). Only for text the user typed; listed entries carry
 * their own paths and a listing reports its parent.
 */
export function typedParent(path: string): string | null {
  const sep = sepOf(path);
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
  if (/^[A-Za-z]:$/.test(trimmed) || trimmed === "" || trimmed === "/") return null;
  // A share root (`\\server\share`) has no parent: `\\server` alone is not a location.
  const unc = uncRoot(trimmed);
  if (unc !== null && unc.length >= trimmed.length) return null;
  const i =Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (i < 0) return null;
  const parent = trimmed.slice(0, i);
  if (/^[A-Za-z]:$/.test(parent)) return parent + "\\";
  return parent || sep;
}

/**
 * The path bar's segments of a directory: each one a prefix of the path string exactly as given
 * (`C:\Users\demo` → `C:\`, `C:\Users`, `C:\Users\demo`; `\\nas\data\sub` → `\\nas\data`,
 * `\\nas\data\sub`), so a click sends back a real path.
 */
export function localSegments(dir: string): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  const m = /^([A-Za-z]:)[\\/]?/.exec(dir);
  const unc = uncRoot(dir);
  let i = 0;
  if (m) {
    out.push({ name: m[1], path: m[1] + "\\" });
    i = m[0].length;
  } else if (unc !== null) {
    out.push({ name: unc, path: unc });
    i = unc.length + 1;
  } else if (dir.startsWith("/")) {
    out.push({ name: "/", path: "/" });
    i = 1;
  }
  while (i < dir.length) {
    const rest = dir.slice(i);
    const j = rest.search(/[\\/]/);
    const end = j < 0 ? dir.length : i + j;
    const name = dir.slice(i, end);
    if (name) out.push({ name, path: dir.slice(0, end) });
    i = end + 1;
  }
  return out;
}

/**
 * Same local path (case-insensitive on Windows and macOS), ignoring a trailing separator; on Windows
 * `/` and `\` are the same separator (`//nas/data` is `\\nas\data`).
 */
export function sameLocalPath(a: string, b: string): boolean {
  const n = (p: string) => {
    const q = api.clientOS === "windows" ? p.replace(/\//g, "\\") : p;
    return q.length > 1 ? q.replace(/[\\/]+$/, "") : q;
  };
  return api.clientOS === "other" ? n(a) === n(b) : n(a).toLowerCase() === n(b).toLowerCase();
}

// ---- roots -------------------------------------------------------------------------------------

interface RootsState {
  roots: LocalRoot[];
  loading: boolean;
  loaded: boolean;
  error: AppError | null;
}

export const useLocalRoots = create<RootsState>(() => ({ roots: [], loading: false, loaded: false, error: null }));

/** Load the drives and the home folder (once; `force` to reload). */
export async function loadLocalRoots(force = false): Promise<LocalRoot[]> {
  const s = useLocalRoots.getState();
  if (s.loading || (s.loaded && !force)) return s.roots;
  useLocalRoots.setState({ loading: true, error: null });
  try {
    const roots = await api.listLocalRoots();
    useLocalRoots.setState({ roots, loading: false, loaded: true });
    return roots;
  } catch (e) {
    useLocalRoots.setState({ loading: false, error: e as AppError });
    return [];
  }
}

/** Where a new local pane opens: the last local directory this session, else the home folder, else the first root. */
export async function defaultLocalDir(last: string | null): Promise<string | null> {
  if (last) return last;
  const roots = await loadLocalRoots();
  return (roots.find((r) => r.kind === "home") ?? roots[0])?.path ?? null;
}

// ---- the selected entries of a local pane ----------------------------------------------------

/** The selected entries of a local pane (visible rows only, folders first), with their listed details. */
export function selectedLocal(pane: PaneId = activePane()): LocalEntry[] {
  const s = getPane(pane);
  if (!isLocalPane(s)) return [];
  const { folders, objects } = getSelected(pane);
  const ids = [...folders.map((f) => f.prefix), ...objects.map((o) => o.key)];
  return ids.map((id) => s.local.entries.get(id)).filter((e): e is LocalEntry => !!e);
}

// ---- folder sizes ------------------------------------------------------------------------------

import { localSizeKey as sizeKey, useLocalSizes, type LocalSizeEntry } from "./localSizes";
export { useLocalSizes, type LocalSizeEntry } from "./localSizes";

/** Hook: the calculated size of a local folder (by its exact path). */
export const useLocalSize = (path: string) => useLocalSizes((s) => s.byPath[sizeKey(path)]);

let sizeSeq = 0;

/** Count the files and bytes under local folders (bounded, never following links). */
export function calculateLocalSizes(paths: string[]) {
  for (const path of paths) void calculateLocalSize(path);
}

async function calculateLocalSize(path: string) {
  const key = sizeKey(path);
  const cur = useLocalSizes.getState().byPath[key];
  if (cur?.running) return;
  const set = (e: LocalSizeEntry) => useLocalSizes.setState((s) => ({ byPath: { ...s.byPath, [key]: e } }));
  set({ size: cur?.size ?? null, running: true, error: null });
  // One scan id per folder: a newer scan of the same folder replaces the older one.
  const scanId = `local-size-${++sizeSeq}`;
  try {
    const size = await api.localDirSize(path, scanId);
    set({ size, running: false, error: null });
  } catch (e) {
    const err = e as AppError;
    set({ size: cur?.size ?? null, running: false, error: err.code === "Cancelled" ? null : err });
    if (err.code !== "Cancelled") toast.error(`Couldn’t calculate the size of “${basename(path)}”`, err.message);
  }
}

/** Forget sizes under a path that changed (a trash, a rename, a download into it). */
export function dropLocalSizes(path: string) {
  const k = sizeKey(path);
  useLocalSizes.setState((s) => {
    const byPath = { ...s.byPath };
    let changed = false;
    for (const p of Object.keys(byPath)) {
      if (p === k || k.startsWith(p.replace(/[\\/]+$/, "") + (k.includes("\\") ? "\\" : "/")) || p.startsWith(k)) {
        delete byPath[p];
        changed = true;
      }
    }
    return changed ? { byPath } : s;
  });
}

// ---- file operations ---------------------------------------------------------------------------

/** New folder in a local pane's directory (captured now). */
export function openLocalNewFolder(pane: PaneId = activePane()) {
  const s = getPane(pane);
  if (isLocalPane(s)) openModal({ kind: "localNewFolder", parent: s.local.dir });
}

export async function createLocalFolder(parent: string, name: string): Promise<boolean> {
  try {
    await api.createLocalDir(parent, name);
    toast.success("Folder created", `${name.trim()} in ${parent}`);
    refreshLocalPanesAt(parent);
    return true;
  } catch (e) {
    toast.error("Couldn’t create the folder", (e as AppError).message);
    return false;
  }
}

/** Rename the one selected local entry. */
export function requestLocalRename(pane: PaneId = activePane()) {
  const sel = selectedLocal(pane);
  if (sel.length !== 1) return;
  openModal({ kind: "localRename", path: sel[0].path, name: sel[0].name, isDir: sel[0].isDir });
}

export async function renameLocalEntry(path: string, newName: string): Promise<boolean> {
  try {
    await api.renameLocal(path, newName);
    toast.success("Renamed", `${basename(path)} → ${newName.trim()}`);
    dropLocalSizes(path);
    refreshLocalPanesAt(path);
    return true;
  } catch (e) {
    toast.error("Couldn’t rename", (e as AppError).message);
    return false;
  }
}

/** Why the selection of a local pane can't go to the recycle bin (a network location), or null. */
export function localTrashRefusal(pane: PaneId = activePane()): string | null {
  const s = getPane(pane);
  if (!isLocalPane(s)) return null;
  if (isNetworkPath(s.local.dir) || selectedLocal(pane).some((e) => isNetworkPath(e.path))) return NO_RECYCLE_BIN;
  return null;
}

/** Ask to move the selection of a local pane to the recycle bin (exact paths, captured now). */
export function requestLocalTrash(pane: PaneId = activePane()) {
  const sel = selectedLocal(pane);
  if (!sel.length) return;
  // A network location has no recycle bin: nothing there is ever deleted by this app.
  const why = localTrashRefusal(pane);
  if (why) {
    toast.info("Nothing was deleted", why);
    return;
  }
  // The same limit as a delete job: at most 10,000 paths in one go.
  if (tooMany(sel.length, "move to the recycle bin")) return;
  openModal({ kind: "localTrash", paths: sel.map((e) => e.path), dirs: sel.filter((e) => e.isDir && !e.isSymlink).length });
}

/** Move exactly `paths` to the recycle bin; toasts the result. Resolves with the paths that were trashed. */
export async function trashLocalPaths(paths: string[], what = "Moved to the recycle bin"): Promise<boolean> {
  try {
    const r = await api.trashLocal(paths);
    for (const p of paths) dropLocalSizes(p);
    const parents = new Set(paths.map((p) => typedParent(p) ?? p));
    for (const p of parents) refreshLocalPanesAt(p);
    if (r.failed.length) {
      toast.warning(
        r.trashed ? `${plural(r.trashed, "item")} moved to the recycle bin, ${r.failed.length} not` : "Nothing was moved to the recycle bin",
        r.failed
          .slice(0, 8)
          .map((f) => `${f.path}: ${f.message}`)
          .join("\n") + (r.failed.length > 8 ? `\n… and ${r.failed.length - 8} more` : ""),
      );
    } else toast.success(what, paths.length === 1 ? paths[0] : plural(r.trashed, "item"));
    return r.failed.length === 0;
  } catch (e) {
    toast.error("Couldn’t move to the recycle bin", (e as AppError).message);
    return false;
  }
}

/** Open a local file with its default program (the backend refuses programs and links). */
export async function openLocalFile(path: string) {
  try {
    await api.openLocal(path);
  } catch (e) {
    toast.error(`Couldn’t open “${basename(path)}”`, (e as AppError).message);
  }
}

/** Show a local entry in the file manager (`reveal_local`). */
export async function revealLocal(path: string) {
  try {
    await api.revealInFolder(path);
  } catch (e) {
    toast.error("Couldn’t show it in the file manager", (e as AppError).message);
  }
}

export function copyLocalPaths(paths: string[]) {
  if (paths.length) void copyText(paths.join("\n"), paths.length > 1 ? "Paths" : "Path");
}

/** Open a folder row of a local pane, or a file with its program. Links are never followed. */
export function openLocalEntry(pane: PaneId, path: string) {
  const s = getPane(pane);
  const e = isLocalPane(s) ? s.local.entries.get(path) : undefined;
  if (!e) return;
  if (e.isDir && !e.isSymlink) navigateLocal(e.path, pane);
  else if (e.isSymlink) toast.info("Links aren’t followed", "Open it in your file manager (Show in folder).");
  else void openLocalFile(e.path);
}

/** Up one level in a local pane: the parent the listing reported, else the typed parent. */
export function localUp(pane: PaneId): boolean {
  const s = getPane(pane);
  if (!isLocalPane(s)) return false;
  const parent = s.local.parent ?? typedParent(s.local.dir);
  if (!parent) return false;
  const from = s.local.dir;
  navigateLocal(parent, pane);
  // Select the folder we came from once it is listed (Commander-style).
  const unsub = afterNextListing(pane, (entries) => {
    const hit = [...entries.keys()].find((p) => sameLocalPath(p, from));
    if (hit) setPane(pane, { selection: new Set([hit]), anchor: hit, focus: hit, scrollTo: { id: hit, seq: Date.now() } });
  });
  setTimeout(unsub, 5000);
  return true;
}

/** Run `fn` once with the entries of the pane's next local listing. */
function afterNextListing(pane: PaneId, fn: (entries: ReadonlyMap<string, LocalEntry>) => void): () => void {
  let done = false;
  const unsub = paneListeners.add(pane, (entries) => {
    if (done) return;
    done = true;
    fn(entries);
  });
  return () => {
    done = true;
    unsub();
  };
}

/** Listeners for "a local pane got a new listing" (by pane), fed from the panes store. */
const paneListeners = {
  map: new Map<PaneId, Set<(entries: ReadonlyMap<string, LocalEntry>) => void>>(),
  add(pane: PaneId, cb: (entries: ReadonlyMap<string, LocalEntry>) => void) {
    let set = this.map.get(pane);
    if (!set) this.map.set(pane, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  },
};

usePanes.subscribe((s, prev) => {
  for (const pane of ["a", "b"] as const) {
    const cur = s[pane];
    const old = prev[pane];
    if (!cur.local || cur.local.entries === old.local?.entries || cur.listing.loading) continue;
    const cbs = paneListeners.map.get(pane);
    if (cbs) for (const cb of [...cbs]) cb(cur.local.entries);
  }
});

// ---- source menu -------------------------------------------------------------------------------

/** The pane's source menu (Alt+F1 / Alt+F2, the path bar's source button), at a point. */
export const useSourceMenu = create<{ menu: { pane: PaneId; x: number; y: number } | null }>(() => ({ menu: null }));

/** Open the source menu of a pane under its path bar (or at the pane's top-left corner). */
export function openSourceMenu(pane: PaneId, at?: { x: number; y: number }) {
  void loadLocalRoots();
  let pos = at;
  if (!pos) {
    const root = document.querySelector<HTMLElement>(`[data-pane="${pane}"]`);
    // Under the path bar's source button; a pane with nothing open has no path bar, so the menu goes
    // just inside the pane's top-left corner (below the pane's tab strip when it has one), never
    // below the whole pane (which made the menu flip up from the bottom of the window).
    const btn = root?.querySelector<HTMLElement>(".source-btn");
    if (btn) {
      const r = btn.getBoundingClientRect();
      pos = { x: r.left, y: r.bottom + 4 };
    } else if (root) {
      const r = root.getBoundingClientRect();
      const strip = root.querySelector<HTMLElement>(".tab-strip")?.getBoundingClientRect();
      pos = { x: r.left + 8, y: (strip ? strip.bottom : r.top) + 8 };
    } else pos = { x: 80, y: 120 };
  }
  useApp.setState({ contextMenu: null });
  useSourceMenu.setState({ menu: { pane, ...pos } });
}

export const closeSourceMenu = () => useSourceMenu.setState({ menu: null });

// ---- edit path ---------------------------------------------------------------------------------

/** Panes whose path bar is a text field right now. */
export const usePathEdit = create<{ editing: Partial<Record<PaneId, boolean>> }>(() => ({ editing: {} }));

export const startPathEdit = (pane: PaneId) => usePathEdit.setState((s) => ({ editing: { ...s.editing, [pane]: true } }));
export const stopPathEdit = (pane: PaneId) => usePathEdit.setState((s) => ({ editing: { ...s.editing, [pane]: false } }));

/** What the path field starts with: the S3 address of the folder, or the local directory. */
export function editablePath(pane: PaneId): string {
  const s = getPane(pane);
  if (isLocalPane(s)) return s.local.dir;
  return s.bucket ? `s3://${s.bucket}/${s.prefix}` : "";
}

const knownBucket = (name: string) => {
  const { buckets, addedBuckets } = useApp.getState();
  return buckets.some((b) => b.name === name) || addedBuckets.some((b) => b.name === name);
};

/**
 * Go where the typed path says (see "Edit path" in docs/CONTRACT.md). Resolves with an error to show
 * inline (the field stays open), or null once the pane went there.
 */
export async function goToTypedPath(pane: PaneId, raw: string): Promise<string | null> {
  const text = raw.trim();
  if (!text) return "Type an s3:// address, a folder of this bucket, or a folder on this computer.";
  const s3 = parseS3Path(text);
  if (s3) {
    if (!knownBucket(s3.bucket)) return `Bucket “${s3.bucket}” is not in this connection. Add it by name first.`;
    return goToS3(pane, s3.bucket, s3.path);
  }
  if (/^s3:/i.test(text)) return "An S3 address looks like s3://bucket/folder/.";
  if (looksLocal(text)) return goToLocal(pane, asTypedDir(text));
  const { bucket } = getPane(pane);
  if (!bucket) return WINDOWS ? "Type a full path such as C:\\Users, or an s3:// address." : "Type a full path such as /home, or an s3:// address.";
  // A bare prefix: from the top of the current bucket, exactly as typed.
  return goToS3(pane, bucket, text);
}

async function goToS3(pane: PaneId, bucket: string, path: string): Promise<string | null> {
  if (!path) {
    navigate(bucket, "", pane);
    return null;
  }
  const folder = asFolderPrefix(path);
  try {
    const page = await api.listObjects(bucket, folder, null, 1);
    if (page.folders.length || page.objects.length || page.isTruncated) {
      navigate(bucket, folder, pane);
      return null;
    }
  } catch (e) {
    return (e as AppError).message;
  }
  // Nothing under it: an object with exactly this key (opened in its folder, selected), or an empty
  // folder marker.
  if (!path.endsWith("/")) {
    try {
      await api.headObject(bucket, path);
      const name = path.slice(path.lastIndexOf("/") + 1);
      revealObject(bucket, path, name, pane);
      return null;
    } catch {
      /* not an object */
    }
  }
  try {
    await api.headObject(bucket, folder);
    navigate(bucket, folder, pane);
    return null;
  } catch {
    return `Nothing at s3://${bucket}/${path}`;
  }
}

async function goToLocal(pane: PaneId, path: string): Promise<string | null> {
  const s = getPane(pane);
  try {
    await api.listLocalDir(path, s.showHidden);
    navigateLocal(path, pane);
    return null;
  } catch (e) {
    const err = e as AppError;
    // A device path, a server without a share, or a path with "..": the backend's own words. Any
    // other InvalidInput (a file is "not a directory" there, or a link) still tries the parent with
    // the file selected, on a share too.
    if (err.code === "InvalidInput" && (refusedUnc(path) || path.split(/[\\/]/).includes(".."))) return err.message;
    // A file: open its folder with the file selected.
    const parent = typedParent(path);
    if (!parent) return err.message;
    try {
      const l = await api.listLocalDir(parent, true);
      const name = basename(path);
      const hit = l.files.find((f) => (api.clientOS === "other" ? f.name === name : f.name.toLowerCase() === name.toLowerCase()));
      if (!hit) return err.message;
      if (hit.hidden && !s.showHidden) setPane(pane, { showHidden: true });
      navigateLocal(parent, pane, { select: hit.path });
      return null;
    } catch {
      return err.message;
    }
  }
}

// ---- the sidebar's "This computer" group ---------------------------------------------------------

const LOCAL_OPEN_KEY = "s3x.localRootsOpen";

function readOpen(): boolean {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_OPEN_KEY) ?? "false") === true;
  } catch {
    return false;
  }
}

/** Whether the sidebar's "This computer" group is expanded (remembered). */
export const useLocalRootsOpen = create<{ open: boolean }>(() => ({ open: readOpen() }));

export function setLocalRootsOpen(open: boolean) {
  useLocalRootsOpen.setState({ open });
  try {
    localStorage.setItem(LOCAL_OPEN_KEY, JSON.stringify(open));
  } catch {
    /* storage unavailable */
  }
  if (open) void loadLocalRoots();
}

/**
 * Give the keyboard to the first "This computer" row (ArrowDown past the last bucket):
 * expands the group and waits for its rows. Resolves false when there are none.
 */
export async function focusComputer(): Promise<boolean> {
  setLocalRootsOpen(true);
  await loadLocalRoots();
  for (let i = 0; i < 30; i++) {
    const row = document.querySelector<HTMLElement>(".local-roots .local-root");
    if (row) {
      row.focus();
      row.scrollIntoView({ block: "nearest" });
      return true;
    }
    await new Promise((r) => requestAnimationFrame(r));
  }
  return false;
}

/**
 * Open a local path in a pane (the command line, see store/launch.ts): a directory, or a file's
 * directory with the file selected. Resolves with an error to show, or null.
 */
export const openLocalPath = (pane: PaneId, path: string) => goToLocal(pane, path);
