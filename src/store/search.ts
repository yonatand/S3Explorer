// Search in a bucket (v0.6.0): the scope choice, the one search the toolbar runs, and — while the
// results are open — the selection (the result rows are the selection then; see getSelected in
// ./view.ts). Results live here, apart from the listing and the transfer stores, so progress events
// never re-render them.

import { create } from "zustand";
import * as api from "../lib/api";
import { SEARCH_LIMITS, type AppError, type SearchHit, type SearchResult } from "../lib/types";
import { parseS3Path } from "../lib/search";
import { navigate, onNavigate, setFilter, setSelection, useApp } from "./app";
import { jobRequest, onJobUpdate } from "./jobs";
import { toast } from "./toasts";

export type SearchScope = "folder" | "bucket";

/** What a search was asked for, captured when it started (the header shows exactly this). */
export interface SearchRequest {
  bucket: string;
  /** The prefix searched under; "" = the whole bucket. */
  scope: string;
  text: string;
}

interface SearchState {
  /** This folder (default) or the whole bucket; per session, not saved. */
  scope: SearchScope;
  /** The results view replaces the object table while this is true. */
  open: boolean;
  request: SearchRequest | null;
  result: SearchResult | null;
  error: AppError | null;
  loading: boolean;
  /** Bumped by every run; the results list resets its focus and scroll on change. */
  runSeq: number;
  /** Selected hits by `hitId`, the anchor for Shift ranges, and the keyboard focus. */
  selection: Set<string>;
  anchor: string | null;
  focus: string | null;
}

const emptySelection = { selection: new Set<string>(), anchor: null, focus: null };

export const useSearch = create<SearchState>(() => ({
  scope: "folder",
  open: false,
  request: null,
  result: null,
  error: null,
  loading: false,
  runSeq: 0,
  ...emptySelection,
}));

const set = useSearch.setState;
const get = useSearch.getState;

/** A hit's id in the selection: objects by key, folders by prefix (prefixed so the two never collide). */
export const hitId = (h: SearchHit): string => (h.kind === "folder" ? `f:${h.folder!.prefix}` : `o:${h.entry!.key}`);

/** The hits currently shown (empty while there is no result). */
export const getHits = (): SearchHit[] => get().result?.hits ?? [];

export function setSearchSelection(selection: Set<string>, anchor: string | null, focus: string | null) {
  set({ selection, anchor, focus });
}

let seq = 0;
/**
 * The id of the run in flight, or null. Each run has its own id ("toolbar:<n>"), so a late
 * cancel_search for one run can never stop the next; a new run cancels the previous one itself.
 */
let runningId: string | null = null;

const CANCELLED: AppError = { code: "Cancelled", message: "Search cancelled." };

/** Stop the backend scan of the run in flight, if any. */
function cancelRunning() {
  const id = runningId;
  runningId = null;
  if (id) api.cancelSearch(id).catch(() => {
    /* nothing running any more */
  });
}

export function setSearchScope(scope: SearchScope) {
  set({ scope });
}

async function start(request: SearchRequest) {
  cancelRunning();
  const mine = ++seq;
  const id = `toolbar:${mine}`;
  runningId = id;
  // The results replace the table: drop the table's selection so no toolbar action can include
  // rows the user cannot see. The results start with nothing selected.
  const app = useApp.getState();
  if (app.selection.size || app.focus || app.anchor) setSelection(new Set(), null, null);
  set({ open: true, request, result: null, error: null, loading: true, runSeq: mine, ...emptySelection });
  try {
    const result = await api.searchObjects({ bucket: request.bucket, scope: request.scope, text: request.text, limit: SEARCH_LIMITS.uiLimit }, id);
    if (runningId === id) runningId = null;
    if (mine !== seq) return;
    // The first row takes the keyboard focus (not the selection), so Enter opens it.
    const first = result.hits[0];
    set({ result, loading: false, ...emptySelection, focus: first ? hitId(first) : null });
  } catch (e) {
    if (runningId === id) runningId = null;
    if (mine !== seq) return;
    // A cancelled run (Cancel, disconnect) keeps its header and says so; never a blank view.
    const err = e as AppError;
    set({ loading: false, error: err.code === "Cancelled" ? CANCELLED : err });
  }
}

/**
 * Search the open bucket for `text` in the chosen scope. Does nothing for a blank query. A pasted
 * `s3://bucket/path` (the whole query) searches that path in the whole bucket, opening the bucket
 * first when it is another one of this connection's buckets.
 */
export function runSearch(text: string) {
  const { bucket, prefix, buckets, addedBuckets } = useApp.getState();
  if (!bucket || !text.trim()) return;
  const s3 = parseS3Path(text);
  if (s3) {
    if (s3.bucket !== bucket) {
      const known = buckets.some((b) => b.name === s3.bucket) || addedBuckets.some((b) => b.name === s3.bucket);
      if (!known) {
        toast.error(`Bucket ${s3.bucket} is not in this connection`, "Add it by name first, or open a bucket you can see.");
        return;
      }
      navigate(s3.bucket, "");
    }
    // Nothing after the bucket: opening it is all there is to do.
    if (!s3.path) return;
    // One path term, even with spaces: `path:"<rest>"`, a quote inside escaped as `\"`.
    void start({ bucket: s3.bucket, scope: "", text: `path:"${s3.path.replace(/"/g, '\\"')}"` });
    return;
  }
  void start({ bucket, scope: get().scope === "folder" ? prefix : "", text });
}

/** Run the same search again (Refresh). */
export function rerunSearch() {
  const { request, open } = get();
  if (open && request) void start(request);
}

/** Stop the running search (the backend scan stops too). The view keeps its header and says it was cancelled. */
export function cancelSearch() {
  if (!get().loading) return;
  seq++;
  set({ loading: false, error: CANCELLED });
  cancelRunning();
}

/** Leave the results view (Back to folder, Esc, a different bucket, disconnect). */
export function closeSearch() {
  if (!get().open && !get().loading) return;
  cancelRunning();
  seq++;
  set({ open: false, request: null, result: null, error: null, loading: false, ...emptySelection });
}

/**
 * Back to the folder (the Back button, Esc): close the results and clear the box, whose text
 * would otherwise go on filtering the folder's rows.
 */
export function leaveSearch() {
  closeSearch();
  setFilter("");
}

/** Drop hits (and their selection) that a finished job deleted or moved away. */
function removeHits(gone: (h: SearchHit) => boolean) {
  const { result, selection, anchor, focus } = get();
  if (!result) return;
  const hits = result.hits.filter((h) => !gone(h));
  if (hits.length === result.hits.length) return;
  const ids = new Set(hits.map(hitId));
  const keep = new Set([...selection].filter((id) => ids.has(id)));
  set({
    result: { ...result, hits },
    selection: keep,
    anchor: anchor && ids.has(anchor) ? anchor : null,
    focus: focus && ids.has(focus) ? focus : hits[0] ? hitId(hits[0]) : null,
  });
}

// A delete, rename or move that finished takes its sources out of the results: they no longer
// exist at those keys. Items the job reports as failed stay; a cancelled job (unknown progress)
// or one whose failures are not all listed changes nothing.
onJobUpdate((j, prev) => {
  const finished = j.status !== "running" && j.status !== "queued" && (!prev || prev.status === "running" || prev.status === "queued");
  if (!finished || (j.kind !== "delete" && j.kind !== "move")) return;
  if (j.status === "cancelled" || (j.status === "failed" && j.error) || j.failedItems > j.errors.length) return;
  const req = jobRequest(j.id);
  const { request } = get();
  if (!req || !request || req.srcBucket !== request.bucket) return;
  const failed = new Set(j.errors.map((e) => e.key));
  const keyOf = (h: SearchHit) => (h.kind === "folder" ? h.folder!.prefix : h.entry!.key);
  removeHits((h) => {
    const k = keyOf(h);
    // Keep a hit that failed, and a folder that still holds something that failed.
    for (const f of failed) if (f === k || (h.kind === "folder" && f.startsWith(k))) return false;
    return req.items.some((it) => (it.isPrefix ? k.startsWith(it.from) : !it.isPrefix && h.kind === "object" && k === it.from));
  });
});

// Every navigation closes the results, even to the current folder (a newest file, a breadcrumb, a
// bucket click): `revealObject` selects a row in the table, which must never sit behind the results.
onNavigate(closeSearch);
// So do a change of bucket or connection.
useApp.subscribe((s, prev) => {
  if (s.bucket !== prev.bucket || s.prefix !== prev.prefix || s.connection !== prev.connection) closeSearch();
});
