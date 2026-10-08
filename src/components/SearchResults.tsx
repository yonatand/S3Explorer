// Search results (v0.6.0): replace the object table while a search is open. A flat, virtualized
// list of hits (folders, then objects). The rows are the selection while the view is open, with the
// table's conventions, so every toolbar and context-menu action works on them (see getSelected).

import { memo, useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, ArrowLeft, Loader2, RefreshCw, SearchX, X } from "lucide-react";
import type { ParsedSearch, SearchHit } from "../lib/types";
import { highlightRanges, highlightTerms } from "../lib/search";
import { formatBytes, formatExact, formatRelative, formatStorageClass, s3Uri } from "../lib/format";
import { plural } from "../lib/ops";
import { navigate, openContextMenu, revealObject } from "../store/app";
import {
  cancelSearch,
  getHits,
  hitId,
  leaveSearch,
  rerunSearch,
  runSearch,
  setSearchScope,
  setSearchSelection,
  useSearch,
} from "../store/search";
import { copySelection, requestDelete, requestRename } from "../store/ops";
import { FileIcon } from "./FileIcon";

const ROW_H = 44;

/** `text[from, to)` with the parts inside `ranges` (offsets into the whole key) marked. */
function Marked({ text, from, to, ranges }: { text: string; from: number; to: number; ranges: [number, number][] }) {
  const parts: ReactNode[] = [];
  let at = from;
  for (const [a, b] of ranges) {
    const s = Math.max(a, from);
    const e = Math.min(b, to);
    if (e <= s) continue;
    if (s > at) parts.push(text.slice(at, s));
    parts.push(<mark key={s} className="hl">{text.slice(s, e)}</mark>);
    at = e;
  }
  if (at < to) parts.push(text.slice(at, to));
  return <>{parts}</>;
}

const HitRow = memo(function HitRow({
  hit,
  index,
  start,
  selected,
  focused,
  terms,
  showTags,
}: {
  hit: SearchHit;
  index: number;
  start: number;
  selected: boolean;
  focused: boolean;
  terms: string[];
  showTags: boolean;
}) {
  const folder = hit.kind === "folder" ? hit.folder : null;
  const entry = hit.kind === "object" ? hit.entry : null;
  // The full key (or prefix) is what matched; the name is its last segment, the rest its parent.
  const full = folder ? folder.prefix : (entry?.key ?? "");
  const name = folder ? folder.name : (entry?.name ?? "");
  const nameEnd = folder ? full.length - 1 : full.length;
  const parentEnd = nameEnd - name.length;
  const ranges = useMemo(() => highlightRanges(full, terms), [full, terms]);
  const sc = entry?.storageClass ?? null;
  return (
    <div
      className={`trow srow ${selected ? "selected" : ""} ${focused ? "focused" : ""} ${index % 2 ? "odd" : ""}`}
      data-index={index}
      data-kind={hit.kind}
      role="row"
      aria-selected={selected}
      style={{ transform: `translateY(${start}px)` }}
    >
      <div className="cell col-name" title={full}>
        <FileIcon name={name} folder={!!folder} size={16} />
        <div className="sname-wrap">
          <div className="sname">
            <span className="name-text">{name === "" ? <span className="dim">(empty name)</span> : <Marked text={full} from={parentEnd} to={nameEnd} ranges={ranges} />}</span>
            {hit.exact && (
              <span className="exact-tag" title="This is exactly what you typed">
                exact match
              </span>
            )}
            {showTags && hit.tags && hit.tags.length > 0 && (
              <span className="stags">
                {hit.tags.map((t) => (
                  <span key={t.key} className="tag-chip stag" title={`${t.key} = ${t.value}`}>
                    <span className="tag-chip-key">{t.key}</span>
                    {t.value !== "" && <span className="tag-chip-value">{t.value}</span>}
                  </span>
                ))}
              </span>
            )}
          </div>
          <div className="sfolder">
            {parentEnd === 0 ? <span className="dim">(bucket root)</span> : <Marked text={full} from={0} to={parentEnd} ranges={ranges} />}
          </div>
        </div>
      </div>
      <div className="cell col-size">{entry ? formatBytes(entry.size) : <span className="dim">—</span>}</div>
      <div className="cell col-modified" title={entry ? formatExact(entry.lastModified) : undefined}>
        {entry ? formatRelative(entry.lastModified) : <span className="dim">—</span>}
      </div>
      <div className="cell col-class">
        {entry ? <span className={`sc-pill sc-${(sc ?? "none").toLowerCase()}`}>{formatStorageClass(sc)}</span> : <span className="dim">Folder</span>}
      </div>
    </div>
  );
});

function Header() {
  const request = useSearch((s) => s.request);
  const result = useSearch((s) => s.result);
  const error = useSearch((s) => s.error);
  const loading = useSearch((s) => s.loading);
  if (!request) return null;
  const where = request.scope ? (
    <span className="mono" title={s3Uri(request.bucket, request.scope)}>
      {request.scope}
    </span>
  ) : (
    "the whole bucket"
  );
  const listed = result && result.parsed.listPrefix !== request.scope ? result.parsed.listPrefix : null;
  return (
    <div className="search-head">
      <button className="btn btn-ghost search-back" style={{ flex: "none" }} onClick={leaveSearch} title="Back to the folder (Esc)">
        <ArrowLeft size={14} /> Back to folder
      </button>
      <div className="search-summary" role="status" aria-live="polite">
        {loading ? (
          <>
            <Loader2 size={14} className="spin" />
            <span>
              Searching for <b className="q">“{request.text}”</b> in {where}…
            </span>
          </>
        ) : error ? (
          error.code === "Cancelled" ? (
            <span>
              Search for <b className="q">“{request.text}”</b> cancelled.
            </span>
          ) : (
            <span className="err-text">
              <AlertTriangle size={13} /> Search failed: {error.message}
            </span>
          )
        ) : result ? (
          <>
            <span>
              <b>{plural(result.hits.length, "result")}</b> for <b className="q">“{request.text}”</b> in {where}
              <span className="dot-sep">·</span>
              scanned {plural(result.scanned, "object")}
              {result.tagLookups > 0 && (
                <>
                  <span className="dot-sep">·</span>
                  {plural(result.tagLookups, "tag lookup")}
                </>
              )}
              {listed !== null && (
                <>
                  <span className="dot-sep">·</span>
                  listed <span className="mono" title={s3Uri(request.bucket, listed)}>{listed || "(bucket root)"}</span>
                </>
              )}
            </span>
            {result.truncated && (
              <span className="search-trunc" title="The search stopped before the end of the listing: there may be more matches.">
                <AlertTriangle size={12} /> Incomplete: {result.reason ?? "stopped early"}
              </span>
            )}
          </>
        ) : null}
      </div>
      {loading ? (
        <button className="btn" onClick={cancelSearch}>
          <X size={14} /> Cancel
        </button>
      ) : (
        <button className="icon-btn lg" onClick={rerunSearch} title="Search again" aria-label="Search again">
          <RefreshCw size={15} />
        </button>
      )}
    </div>
  );
}

/** Open a hit: an object is shown in its folder (selected), a folder is opened. */
function openHit(hit: SearchHit) {
  const bucket = useSearch.getState().request?.bucket;
  if (!bucket) return;
  // Navigating closes the results (see store/search.ts).
  if (hit.kind === "folder" && hit.folder) navigate(bucket, hit.folder.prefix);
  else if (hit.entry) revealObject(bucket, hit.entry.key, hit.entry.name);
}

type SelectMode = "single" | "toggle" | "range" | "range-add";

/** The table's selection rules, over the hits. */
function selectIndex(index: number, mode: SelectMode) {
  const hits = getHits();
  const hit = hits[index];
  if (!hit) return;
  const id = hitId(hit);
  const { selection, anchor } = useSearch.getState();
  if (mode === "toggle") {
    const next = new Set(selection);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSearchSelection(next, id, id);
  } else if (mode === "range" || mode === "range-add") {
    const a = anchor ? hits.findIndex((h) => hitId(h) === anchor) : -1;
    const from = a < 0 ? index : Math.min(a, index);
    const to = a < 0 ? index : Math.max(a, index);
    const next = mode === "range-add" ? new Set(selection) : new Set<string>();
    for (let i = from; i <= to; i++) next.add(hitId(hits[i]));
    setSearchSelection(next, a < 0 ? id : anchor, id);
  } else {
    setSearchSelection(new Set([id]), id, id);
  }
}

export function SearchResults() {
  const result = useSearch((s) => s.result);
  const request = useSearch((s) => s.request);
  const loading = useSearch((s) => s.loading);
  const runSeq = useSearch((s) => s.runSeq);
  const selection = useSearch((s) => s.selection);
  const focusId = useSearch((s) => s.focus);
  const hits = result?.hits ?? [];
  const parsed: ParsedSearch | null = result?.parsed ?? null;
  const terms = useMemo(() => (parsed ? highlightTerms(parsed) : []), [parsed]);
  const showTags = !!parsed && parsed.tags.length > 0;
  const scrollRef = useRef<HTMLDivElement>(null);
  const focusIndex = useMemo(() => (focusId ? hits.findIndex((h) => hitId(h) === focusId) : -1), [hits, focusId]);

  const virtualizer = useVirtualizer({
    count: hits.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  // A new run starts at the top.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [runSeq]);

  // Results arrived: the list takes the keyboard, with the first row focused (Enter opens it).
  useEffect(() => {
    if (result) scrollRef.current?.focus();
  }, [result === null, runSeq]); // eslint-disable-line react-hooks/exhaustive-deps

  const indexFromEvent = (e: ReactMouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
    return el ? Number(el.dataset.index) : -1;
  };

  const onClick = (e: ReactMouseEvent) => {
    const index = indexFromEvent(e);
    if (index < 0) {
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey) setSearchSelection(new Set(), null, null);
      return;
    }
    const multi = e.ctrlKey || e.metaKey;
    selectIndex(index, e.shiftKey ? (multi ? "range-add" : "range") : multi ? "toggle" : "single");
  };

  const onContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    const index = indexFromEvent(e);
    if (index < 0) return; // no folder in view: nothing to offer for empty space
    if (!useSearch.getState().selection.has(hitId(hits[index]))) selectIndex(index, "single");
    openContextMenu({ x: e.clientX, y: e.clientY });
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!hits.length) {
      if (e.key === "Escape") leaveSearch();
      return;
    }
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 300) / ROW_H) - 1);
    const move = (to: number) => {
      const next = Math.max(0, Math.min(hits.length - 1, to));
      selectIndex(next, e.shiftKey ? "range" : "single");
      virtualizer.scrollToIndex(next, { align: "auto" });
    };
    const ctrl = e.ctrlKey || e.metaKey;
    const { selection } = useSearch.getState();
    switch (e.key) {
      case "ArrowDown":
        move(focusIndex < 0 ? 0 : focusIndex + 1);
        break;
      case "ArrowUp":
        move(focusIndex < 0 ? hits.length - 1 : focusIndex - 1);
        break;
      case "PageDown":
        move(focusIndex + page);
        break;
      case "PageUp":
        move(focusIndex - page);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(hits.length - 1);
        break;
      case " ":
        if (focusIndex >= 0) selectIndex(focusIndex, "toggle");
        break;
      case "Enter":
        if (focusIndex >= 0) openHit(hits[focusIndex]);
        break;
      case "Escape":
        // Like the table: Esc clears the selection first; with nothing selected it leaves the results.
        if (selection.size) setSearchSelection(new Set(), null, useSearch.getState().focus);
        else leaveSearch();
        break;
      case "Delete":
        if (ctrl || e.altKey || !selection.size) return;
        requestDelete();
        break;
      case "F2":
        if (selection.size !== 1) return;
        void requestRename();
        break;
      case "a":
      case "A":
        if (!ctrl) return;
        setSearchSelection(new Set(hits.map(hitId)), hitId(hits[0]), useSearch.getState().focus);
        break;
      case "c":
      case "C":
      case "x":
      case "X":
        if (!ctrl || e.altKey || e.shiftKey || !selection.size) return;
        void copySelection(e.key.toLowerCase() === "x" ? "cut" : "copy");
        break;
      case "ContextMenu":
      case "F10": {
        if (e.key === "F10" && !e.shiftKey) return;
        const index = focusIndex >= 0 ? focusIndex : 0;
        if (!selection.has(hitId(hits[index]))) selectIndex(index, "single");
        const row = scrollRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
        const r = row?.getBoundingClientRect() ?? scrollRef.current!.getBoundingClientRect();
        openContextMenu({ x: r.left + 40, y: r.top + Math.min(r.height, ROW_H) });
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  let body: ReactNode;
  if (!result) {
    body = loading ? (
      <div className="table-empty">
        <Loader2 size={28} className="spin" strokeWidth={1.5} />
        <div className="muted">Scanning keys…</div>
      </div>
    ) : null;
  } else if (!hits.length) {
    body = (
      <div className="table-empty">
        <SearchX size={36} strokeWidth={1.25} />
        <div className="empty-title">No matches</div>
        <div className="muted">
          {result.truncated ? "Nothing matched before the search stopped." : `Nothing ${request?.scope ? "in this folder" : "in this bucket"} matches.`}
        </div>
        {request?.scope && (
          <button
            className="btn"
            onClick={() => {
              setSearchScope("bucket");
              runSearch(request.text);
            }}
          >
            Search the whole bucket
          </button>
        )}
      </div>
    );
  } else {
    body = (
      <div className="vlist" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const hit = hits[vi.index];
          const id = hitId(hit);
          return (
            <HitRow
              key={`${hit.exact ? "exact:" : ""}${id}`}
              hit={hit}
              index={vi.index}
              start={vi.start}
              selected={selection.has(id)}
              focused={focusIndex === vi.index}
              terms={terms}
              showTags={showTags}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div className="object-table search-results" role="grid" aria-label="Search results" aria-rowcount={hits.length} aria-multiselectable>
      <Header />
      <div className="thead" role="row">
        <div className="th col-name" role="columnheader">Name</div>
        <div className="th col-size" role="columnheader">Size</div>
        <div className="th col-modified" role="columnheader">Last modified</div>
        <div className="th col-class" role="columnheader">Storage class</div>
      </div>
      <div
        className="tbody"
        ref={scrollRef}
        tabIndex={0}
        style={{ ["--row-h" as string]: `${ROW_H}px` }}
        onKeyDown={onKeyDown}
        onClick={onClick}
        onDoubleClick={(e) => {
          const i = indexFromEvent(e);
          if (i >= 0 && hits[i] && !e.ctrlKey && !e.metaKey && !e.shiftKey) openHit(hits[i]);
        }}
        onContextMenu={onContextMenu}
      >
        {body}
      </div>
    </div>
  );
}
