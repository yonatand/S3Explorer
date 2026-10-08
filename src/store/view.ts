// Derived view of the current listing: filtered + sorted rows, folders first.

import { useMemo } from "react";
import type { FolderEntry, ObjectEntry, SearchHit } from "../lib/types";
import { matchesFilter, useApp, type SortState } from "./app";
import { hitId, useSearch } from "./search";

export type Row =
  | { kind: "folder"; id: string; name: string; folder: FolderEntry }
  | { kind: "object"; id: string; name: string; object: ObjectEntry };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

let cache: {
  folders: FolderEntry[];
  objects: ObjectEntry[];
  filter: string;
  sort: SortState;
  rows: Row[];
} | null = null;

export function computeRows(folders: FolderEntry[], objects: ObjectEntry[], filter: string, sort: SortState): Row[] {
  if (cache && cache.folders === folders && cache.objects === objects && cache.filter === filter && cache.sort === sort) {
    return cache.rows;
  }
  const match = (name: string) => matchesFilter(name, filter);
  const fr: Row[] = [];
  for (const folder of folders) if (match(folder.name)) fr.push({ kind: "folder", id: folder.prefix, name: folder.name, folder });
  const or: Row[] = [];
  for (const object of objects) if (match(object.name)) or.push({ kind: "object", id: object.key, name: object.name, object });

  const dir = sort.dir;
  const byName = (a: Row, b: Row) => collator.compare(a.name, b.name);
  // Folders have no size/date/class: they always sort by name.
  fr.sort((a, b) => (sort.key === "name" ? dir : 1) * byName(a, b));
  const val = (r: Row): number | string => {
    if (r.kind !== "object") return 0;
    switch (sort.key) {
      case "size":
        return r.object.size;
      case "modified":
        return r.object.lastModified ? Date.parse(r.object.lastModified) : 0;
      case "class":
        return r.object.storageClass ?? "";
      default:
        return 0;
    }
  };
  if (sort.key === "name") {
    or.sort((a, b) => dir * byName(a, b));
  } else {
    or.sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      const c = typeof va === "number" && typeof vb === "number" ? va - vb : collator.compare(String(va), String(vb));
      return c !== 0 ? dir * c : byName(a, b);
    });
  }
  const rows = fr.concat(or);
  cache = { folders, objects, filter, sort, rows };
  return rows;
}

export function useViewRows(): Row[] {
  const folders = useApp((s) => s.listing.folders);
  const objects = useApp((s) => s.listing.objects);
  const filter = useApp((s) => s.filter);
  const sort = useApp((s) => s.sort);
  return computeRows(folders, objects, filter, sort);
}

export function getViewRows(): Row[] {
  const s = useApp.getState();
  return computeRows(s.listing.folders, s.listing.objects, s.filter, s.sort);
}

/** The selected search hits, in result order (the results view is open). */
function selectedHits(selection: Set<string>, hits: SearchHit[]): { folders: FolderEntry[]; objects: ObjectEntry[] } {
  const folders: FolderEntry[] = [];
  const objects: ObjectEntry[] = [];
  if (selection.size) {
    for (const h of hits) {
      if (!selection.has(hitId(h))) continue;
      if (h.kind === "folder" && h.folder) folders.push(h.folder);
      else if (h.kind === "object" && h.entry) objects.push(h.entry);
    }
  }
  return { folders, objects };
}

/**
 * Selected entries, in listing order, limited to rows the current filter shows: an action never
 * includes an item the user can't see (setFilter also prunes hidden ones from the selection).
 * While search results are open, the selected result rows are the selection: their entries are
 * returned exactly as the search reported them (keys and prefixes byte-for-byte).
 */
export function getSelected(): { folders: FolderEntry[]; objects: ObjectEntry[] } {
  const search = useSearch.getState();
  if (search.open) return selectedHits(search.selection, search.result?.hits ?? []);
  const { selection, listing } = useApp.getState();
  if (!selection.size) return { folders: [], objects: [] };
  const visible = new Set(getViewRows().map((r) => r.id));
  return {
    folders: listing.folders.filter((f) => selection.has(f.prefix) && visible.has(f.prefix)),
    objects: listing.objects.filter((o) => selection.has(o.key) && visible.has(o.key)),
  };
}

/** Hook: counts of selected visible folders/objects (same rule as getSelected, results included). */
export function useSelectionInfo() {
  const selection = useApp((s) => s.selection);
  const rows = useViewRows();
  const searchOpen = useSearch((s) => s.open);
  const searchSelection = useSearch((s) => s.selection);
  const hits = useSearch((s) => s.result?.hits);
  return useMemo(() => {
    if (!searchOpen) return summarize(selection, rows);
    const { folders, objects } = selectedHits(searchSelection, hits ?? []);
    const asRows: Row[] = [
      ...folders.map((folder): Row => ({ kind: "folder", id: folder.prefix, name: folder.name, folder })),
      ...objects.map((object): Row => ({ kind: "object", id: object.key, name: object.name, object })),
    ];
    return summarize(new Set(asRows.map((r) => r.id)), asRows);
  }, [searchOpen, searchSelection, hits, selection, rows]);
}

/**
 * The folder the selected items are listed in: the open folder, or (search results) the folder all
 * selected hits share, else the deepest folder that contains them all.
 */
export function getSelectionPrefix(): string {
  const search = useSearch.getState();
  const { prefix } = useApp.getState();
  if (!search.open) return prefix;
  const { folders, objects } = getSelected();
  const parents = [
    ...folders.map((f) => f.prefix.slice(0, f.prefix.length - f.name.length - 1)),
    ...objects.map((o) => o.key.slice(0, o.key.length - o.name.length)),
  ];
  if (!parents.length) return prefix;
  let common = parents[0];
  for (const p of parents) {
    while (!p.startsWith(common)) {
      const cut = common.slice(0, -1).lastIndexOf("/");
      common = cut >= 0 ? common.slice(0, cut + 1) : "";
    }
  }
  return common;
}

function summarize(selection: Set<string>, rows: Row[]) {
  let folders = 0;
  let objects = 0;
  let bytes = 0;
  let singleFolder: FolderEntry | null = null;
  let singleObject: ObjectEntry | null = null;
  if (selection.size) {
    for (const r of rows) {
      if (!selection.has(r.id)) continue;
      if (r.kind === "folder") {
        folders++;
        singleFolder = r.folder;
      } else {
        objects++;
        bytes += r.object.size;
        singleObject = r.object;
      }
    }
  }
  return {
    folders,
    objects,
    bytes,
    folder: folders === 1 && objects === 0 ? singleFolder : null,
    object: objects === 1 && folders === 0 ? singleObject : null,
  };
}
