// Formatting and S3 key/path helpers. Pure functions only.

import { OPEN_LOCAL_REFUSED_EXTENSIONS } from "./types";

/** Binary units: sizes are computed in powers of 1024, so they are labelled KiB, MiB, ... */
const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(digits)} ${UNITS[i]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec) return "—";
  const mb = bytesPerSec / (1024 * 1024);
  return `${mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)} MiB/s`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const shortDateYear = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });
const exactFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Date and time to the minute ("6 Oct 2026, 19:03"); "" for a missing date. */
export function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : dateTimeFmt.format(new Date(t));
}

export function formatRelative(iso: string | null, now = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = (t - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), "day");
  const d = new Date(t);
  return d.getFullYear() === new Date(now).getFullYear() ? shortDate.format(d) : shortDateYear.format(d);
}

export function formatExact(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : exactFmt.format(new Date(t));
}

/** "GLACIER_IR" -> "Glacier IR" */
export function formatStorageClass(sc: string | null): string {
  if (!sc) return "—";
  return sc
    .split("_")
    .map((w) => (w.length <= 2 ? w : w[0] + w.slice(1).toLowerCase()))
    .join(" ");
}

// ---- S3 key helpers -------------------------------------------------------

/**
 * Normalize a user-typed path: no leading slash, no empty segments, trailing slash unless empty.
 * Only for names the user types. Never apply it to prefixes that came from the server: S3 keys
 * may contain "//" or a leading "/", and normalizing those would point at a different folder.
 */
export function normalizePrefix(prefix: string): string {
  const segs = prefix.split("/").filter((s) => s.length > 0);
  return segs.length ? segs.join("/") + "/" : "";
}

/** Ensure a server-side folder prefix ends with "/" ("" stays ""), without touching anything else. */
export function asFolderPrefix(prefix: string): string {
  return !prefix || prefix.endsWith("/") ? prefix : prefix + "/";
}

/**
 * Join an existing (server-provided, verbatim) prefix with a user-typed relative name
 * ("c.txt" or "c/d/"). The name is normalized (no empty segments); the prefix is kept as is.
 */
export function joinKey(prefix: string, name: string): string {
  const p = asFolderPrefix(prefix);
  const trailing = name.endsWith("/");
  const n = name
    .split("/")
    .filter((s) => s.length > 0)
    .join("/");
  if (!n) return p;
  return p + n + (trailing ? "/" : "");
}

/** Raw segments of a folder prefix, keeping empty ones: "a//" -> ["a", ""], "/x/" -> ["", "x"]. */
function rawSegments(prefix: string): string[] {
  if (!prefix) return [];
  const segs = asFolderPrefix(prefix).split("/");
  segs.pop(); // the empty string after the trailing "/"
  return segs;
}

/** Parent prefix of a folder prefix: "a/b/" -> "a/", "a/" -> "", "a//" -> "a/". */
export function parentPrefix(prefix: string): string {
  const segs = rawSegments(prefix);
  segs.pop();
  return segs.length ? segs.join("/") + "/" : "";
}

/** Prefix segments for breadcrumbs: "a/b/" -> [{name:"a",prefix:"a/"},{name:"b",prefix:"a/b/"}]. */
export function prefixSegments(prefix: string): { name: string; prefix: string }[] {
  const segs = rawSegments(prefix);
  return segs.map((name, i) => ({ name, prefix: segs.slice(0, i + 1).join("/") + "/" }));
}

/** Display text for a key segment; an empty segment (from "a//") would otherwise be invisible. */
export function displayName(name: string): string {
  return name === "" ? "(empty name)" : name;
}

/**
 * Windows device names, any case, with or without an extension: CON PRN AUX NUL CONIN$ CONOUT$,
 * COM1-9 and LPT1-9 plus the superscript digits ¹ ² ³. The stem (the text before the first ".")
 * is compared with its trailing spaces removed, because Windows ignores them: "CON .txt" is CON.
 * The backend's `sanitize_segment` (src-tauri/src/batches/localname.rs) applies the same rule.
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³]) *(\..*)?$/i;

/**
 * Turn an S3 name segment into a safe local file name. Keys are only split on "/", so a
 * segment may still hold "\", "..", "C:\..." or control characters; any of those could
 * escape the chosen folder or fail on Windows.
 */
export function sanitizeFileName(name: string): string {
  let n = name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_");
  n = n.replace(/[. ]+$/, ""); // Windows silently strips trailing dots/spaces
  if (n === "" || n === "." || n === "..") n = "_";
  if (WINDOWS_RESERVED.test(n)) n = "_" + n;
  return n;
}

/**
 * Make `name` unique (case-insensitively) within `taken`, as "name (1).ext", "name (2).ext", ...
 * Adds the chosen name to `taken` (stored lower-cased).
 */
export function uniqueFileName(name: string, taken: Set<string>): string {
  let candidate = name;
  if (taken.has(candidate.toLowerCase())) {
    const dot = name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    for (let i = 1; taken.has(candidate.toLowerCase()); i++) candidate = `${stem} (${i})${ext}`;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/** Number of tile colours defined in styles.css (--tone-0 … --tone-3). */
const TONE_COUNT = 4;

/** A stable tile colour (0 … TONE_COUNT - 1) for a name: the same name always gets the same colour. */
export function nameTone(name: string): number {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return hash % TONE_COUNT;
}

/** Last path segment of a local filesystem path (handles both \ and /). */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function s3Uri(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`;
}

export function extension(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Returns an error message, or null when the folder name is acceptable. */
export function validateFolderName(name: string): string | null {
  const segs = name.trim().split("/").filter(Boolean);
  if (segs.length === 0) return "Enter a folder name";
  if (segs.some((s) => s === "." || s === "..")) return "“.” and “..” are not allowed as names";
  if (new TextEncoder().encode(segs.join("/")).length > 1000) return "Name is too long";
  return null;
}

const REFUSED_TO_OPEN = new Set<string>(OPEN_LOCAL_REFUSED_EXTENSIONS);

/**
 * `open_local` refuses this file (or folder, `x.app`): the OS could run it as a program, so the UI
 * does not offer "Open file" / "Open folder". Trailing dots and spaces are ignored first, as the
 * backend does (Windows drops them: `a.exe.` runs as `a.exe`); a dotfile like `.bashrc` has none.
 */
export function refusedToOpen(localPath: string): boolean {
  const name = basename(localPath).replace(/[. ]+$/, "");
  const dot = name.lastIndexOf(".");
  return dot > 0 && REFUSED_TO_OPEN.has(name.slice(dot + 1).toLowerCase());
}
