import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArchiveRestore, ClipboardPaste, Copy, CopyPlus, Download, FolderDown, FolderOpen, FolderPlus, FolderUp, Info, Link, LocateFixed, PencilLine, RefreshCw, Scissors, Tags, Trash2, Upload } from "lucide-react";
import { navigate, openContextMenu, openModal, refresh, revealObject, setDetailsOpen, setSelection, useApp } from "../store/app";
import { useSearch } from "../store/search";
import { copyText, downloadObjects, pickAndUpload } from "../store/actions";
import { pickAndUploadFolder, requestDownloadFolders } from "../store/folders";
import { getSelected } from "../store/view";
import { useClipboard } from "../store/clipboard";
import { copySelection, requestBulkTags, requestDelete, requestPaste, requestRename, requestRestoreArchived } from "../store/ops";
import { ARCHIVED_REASON, archiveId, isArchiveClass, useArchive, useArchiveBlocked } from "../store/archive";
import { s3Uri } from "../lib/format";
import { plural } from "../lib/ops";

interface Item {
  label: string;
  icon: ReactNode;
  action: () => void;
  danger?: boolean;
  hint?: string;
  disabled?: boolean;
  /** Tooltip, e.g. why the item is disabled. */
  title?: string;
}

export function ContextMenu() {
  const menu = useApp((s) => s.contextMenu);
  const bucket = useApp((s) => s.bucket);
  const clip = useClipboard((s) => s.clip);
  // Over search results the menu acts on the selected hits; there is no folder to upload or paste into.
  const inResults = useSearch((s) => s.open);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  // One archived object that isn't restored: actions that read it are disabled, with the reason.
  const current = menu && bucket ? getSelected() : null;
  const single = current && current.folders.length === 0 && current.objects.length === 1 ? current.objects[0] : null;
  const blocked = useArchiveBlocked(bucket, single);
  const singleInfo = useArchive((s) => (bucket && single ? s.byId[archiveId(bucket, single.key)] : undefined));

  useLayoutEffect(() => {
    if (!menu || !ref.current) {
      setPos(null);
      return;
    }
    const r = ref.current.getBoundingClientRect();
    const x = Math.min(menu.x, window.innerWidth - r.width - 6);
    const y = menu.y + r.height > window.innerHeight - 6 ? Math.max(6, menu.y - r.height) : menu.y;
    setPos({ x: Math.max(6, x), y });
    ref.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => openContextMenu(null);
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === "ArrowDown" ? (i + 1) % btns.length : (i - 1 + btns.length) % btns.length;
        btns[next]?.focus();
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("wheel", close, { passive: true });
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("wheel", close);
    };
  }, [menu]);

  if (!menu || !bucket) return null;

  const { folders, objects } = getSelected();
  const groups: Item[][] = [];
  const count = folders.length + objects.length;
  if (inResults && count === 0) return null;

  const pasteItem: Item = {
    label: clip ? `Paste ${plural(clip.items.length, "item")} here` : "Paste",
    icon: <ClipboardPaste size={14} />,
    action: () => requestPaste(),
    hint: "Ctrl+V",
    disabled: !clip,
  };
  const editItems = (n: number, archived = false): Item[] => {
    const why = archived ? { disabled: true, title: ARCHIVED_REASON } : {};
    return [
      { label: n > 1 ? `Copy ${n} items` : "Copy", icon: <CopyPlus size={14} />, action: () => void copySelection("copy"), hint: "Ctrl+C", ...why },
      { label: n > 1 ? `Cut ${n} items` : "Cut", icon: <Scissors size={14} />, action: () => void copySelection("cut"), hint: "Ctrl+X", ...why },
      ...(n === 1 ? [{ label: "Rename…", icon: <PencilLine size={14} />, action: () => void requestRename(), hint: "F2", ...why }] : []),
    ];
  };
  const restoreItem = (label: string): Item => ({ label, icon: <ArchiveRestore size={14} />, action: () => requestRestoreArchived() });
  const deleteItem = (n: number, folder: boolean): Item => ({
    label: n > 1 ? `Delete ${n} items…` : folder ? "Delete folder…" : "Delete…",
    icon: <Trash2 size={14} />,
    danger: true,
    action: () => requestDelete(),
    hint: "Del",
  });

  if (count === 0) {
    groups.push([
      { label: "Upload files…", icon: <Upload size={14} />, action: () => void pickAndUpload() },
      { label: "Upload folder…", icon: <FolderUp size={14} />, action: () => void pickAndUploadFolder() },
      { label: "New folder…", icon: <FolderPlus size={14} />, action: () => openModal({ kind: "newFolder" }) },
    ]);
    groups.push([pasteItem]);
    groups.push([{ label: "Refresh", icon: <RefreshCw size={14} />, action: () => refresh() }]);
  } else if (count === 1 && folders.length === 1) {
    const f = folders[0];
    groups.push([
      { label: inResults ? "Open folder" : "Open", icon: <FolderOpen size={14} />, action: () => navigate(bucket, f.prefix), hint: "Enter" },
      { label: "Download folder…", icon: <FolderDown size={14} />, action: () => void requestDownloadFolders([f]) },
    ]);
    groups.push([
      { label: "Copy key", icon: <Copy size={14} />, action: () => void copyText(f.prefix, "Key") },
      { label: "Copy S3 URI", icon: <Link size={14} />, action: () => void copyText(s3Uri(bucket, f.prefix), "S3 URI") },
    ]);
    groups.push(editItems(1));
    groups.push([
      { label: "Edit tags of everything inside…", icon: <Tags size={14} />, action: () => requestBulkTags() },
      restoreItem("Restore archived objects inside…"),
    ]);
    groups.push([deleteItem(1, true)]);
  } else if (count === 1) {
    const o = objects[0];
    const restoreState = !isArchiveClass(o.storageClass)
      ? null
      : !singleInfo
        ? { disabled: true, title: "Checking whether it is restored…" }
        : singleInfo.restore?.inProgress
          ? { disabled: true, title: "A restore is already in progress" }
          : !singleInfo.archived
            ? { disabled: true, title: "Already restored" }
            : {};
    if (inResults) {
      groups.push([{ label: "Go to object", icon: <LocateFixed size={14} />, action: () => revealObject(bucket, o.key, o.name), hint: "Enter" }]);
    }
    groups.push([
      {
        label: "Download…",
        icon: <Download size={14} />,
        action: () => void downloadObjects([o]),
        ...(blocked ? { disabled: true, title: ARCHIVED_REASON, hint: "Archived" } : {}),
      },
      ...(restoreState ? [{ ...restoreItem("Restore…"), ...restoreState }] : []),
    ]);
    groups.push([
      { label: "Copy key", icon: <Copy size={14} />, action: () => void copyText(o.key, "Key") },
      { label: "Copy S3 URI", icon: <Link size={14} />, action: () => void copyText(s3Uri(bucket, o.key), "S3 URI") },
    ]);
    groups.push(editItems(1, blocked));
    groups.push([
      { label: "Edit tags…", icon: <Tags size={14} />, action: () => openModal({ kind: "objectTags", bucket, key: o.key }) },
      {
        label: "Properties",
        icon: <Info size={14} />,
        action: () => {
          // Over results the hit is already the selection (the table's selection is not used there).
          if (!inResults) setSelection(new Set([o.key]), o.key, o.key);
          setDetailsOpen(true);
        },
      },
    ]);
    groups.push([deleteItem(1, false)]);
  } else {
    const keys = [...folders.map((f) => f.prefix), ...objects.map((o) => o.key)];
    const downloads: Item[] = [];
    if (objects.length) {
      downloads.push({
        label: `Download ${objects.length} object${objects.length === 1 ? "" : "s"}…`,
        icon: <Download size={14} />,
        action: () => void downloadObjects(objects),
      });
    }
    if (folders.length) {
      downloads.push({
        label: `Download ${folders.length} folder${folders.length === 1 ? "" : "s"}…`,
        icon: <FolderDown size={14} />,
        action: () => void requestDownloadFolders(folders),
      });
    }
    if (downloads.length) groups.push(downloads);
    groups.push([
      { label: `Copy ${keys.length} keys`, icon: <Copy size={14} />, action: () => void copyText(keys.join("\n"), "Keys") },
      {
        label: `Copy ${keys.length} S3 URIs`,
        icon: <Link size={14} />,
        action: () => void copyText(keys.map((k) => s3Uri(bucket, k)).join("\n"), "S3 URIs"),
      },
    ]);
    groups.push(editItems(count));
    const archived = objects.filter((x) => isArchiveClass(x.storageClass)).length;
    groups.push([
      { label: `Edit tags for ${count} items…`, icon: <Tags size={14} />, action: () => requestBulkTags() },
      ...(folders.length || archived ? [restoreItem("Restore archived…")] : []),
    ]);
    groups.push([deleteItem(count, false)]);
  }

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, visibility: pos ? "visible" : "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {groups.map((g, gi) => (
        <div key={gi} className="menu-group">
          {g.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={`menu-item ${item.danger ? "danger" : ""}`}
              disabled={item.disabled}
              title={item.title}
              onClick={() => {
                openContextMenu(null);
                item.action();
              }}
            >
              {item.icon}
              <span className="menu-label">{item.label}</span>
              {item.hint && <span className="menu-hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
