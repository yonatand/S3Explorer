import { useId, useRef, useState, type KeyboardEvent } from "react";
import { FolderOpen, Loader2, Play, ShieldCheck } from "lucide-react";
import * as api from "../lib/api";
import type { AppError } from "../lib/types";
import { FILE_MANAGER_COMMAND_MAX } from "../lib/types";
import { normalizeFileManagerCommand } from "../lib/settings";
import { toast } from "../store/toasts";
import { useTransfers } from "../store/transfers";

/** "Show in folder opens": the system file manager, or a program the user names. */
export interface FileManagerDraft {
  mode: "system" | "program";
  /** The command as typed (kept while "System file manager" is chosen, so switching back restores it). */
  command: string;
}

/**
 * A path to show when trying a command. The backend decides what to reveal; the UI only needs an
 * absolute path: the newest finished download if there is one, else the drive or file-system root.
 */
function samplePath(): string {
  const { ids, byId } = useTransfers.getState();
  for (const id of ids) {
    const t = byId[id];
    if (t && t.kind === "download" && t.status === "completed") return t.localPath;
  }
  return api.clientOS === "windows" ? "C:\\" : "/";
}

/**
 * The command Browse… inserts for a chosen program: the path quoted (a `"` inside it escaped as
 * `\"`), then `"{dir}"`. On macOS an `.app` bundle is started with `open -a`.
 */
export function commandForProgram(program: string, os: typeof api.clientOS = api.clientOS): string {
  const quoted = `"${program.replace(/"/g, '\\"')}"`;
  if (os === "mac" && /\.app\/?$/i.test(program)) return `open -a ${quoted} "{dir}"`;
  return `${quoted} "{dir}"`;
}

function FileManagerField({
  value,
  error,
  disabled,
  onChange,
}: {
  value: FileManagerDraft;
  error: string | null;
  disabled: boolean;
  onChange(v: FileManagerDraft): void;
}) {
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const [trying, setTrying] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const modes = [
    { mode: "system" as const, label: "System file manager" },
    { mode: "program" as const, label: "This program" },
  ];
  const onRadioKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const next = (i + 1) % 2;
    onChange({ ...value, mode: modes[next].mode });
    refs.current[next]?.focus();
  };

  const browse = async () => {
    setBrowsing(true);
    try {
      const program = await api.pickProgram();
      if (program) {
        onChange({ mode: "program", command: commandForProgram(program) });
        requestAnimationFrame(() => input.current?.focus());
      }
    } catch (e) {
      toast.error("Could not open the file picker", e as AppError);
    } finally {
      setBrowsing(false);
    }
  };

  const tryIt = async () => {
    setTrying(true);
    try {
      await api.tryFileManager(normalizeFileManagerCommand(value.command), samplePath());
      toast.success("File manager started", "If nothing opened, check the command.");
    } catch (e) {
      toast.error("That command did not work", e as AppError);
    } finally {
      setTrying(false);
    }
  };

  return (
    <div className="set-field">
      <div className="set-field-head">
        <span className="set-label" id={`${id}-label`}>
          Show in folder opens
        </span>
        <p className="set-desc" id={`${id}-desc`}>
          What “Show in folder” and “Open folder” open in the Activity panel.
        </p>
      </div>
      <div className="segmented fm-segmented" role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={`${id}-desc`}>
        {modes.map((m, i) => (
          <button
            key={m.mode}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={value.mode === m.mode}
            tabIndex={value.mode === m.mode ? 0 : -1}
            className={value.mode === m.mode ? "active" : ""}
            disabled={disabled}
            onClick={() => onChange({ ...value, mode: m.mode })}
            onKeyDown={(e) => onRadioKey(e, i)}
          >
            {m.label}
          </button>
        ))}
      </div>
      {value.mode === "program" && (
        <div className="fm-program">
          <div className="fm-row">
            <input
              ref={input}
              id={`${id}-cmd`}
              className="mono fm-input"
              value={value.command}
              maxLength={FILE_MANAGER_COMMAND_MAX}
              spellCheck={false}
              autoComplete="off"
              placeholder={'"C:\\Program Files\\totalcmd\\TOTALCMD64.EXE" /O /T "{dir}"'}
              aria-label="File manager command"
              aria-invalid={!!error}
              aria-describedby={`${id}-err ${id}-help`}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, command: e.target.value })}
            />
            <button type="button" className="btn" onClick={() => void browse()} disabled={disabled || browsing}>
              {browsing ? <Loader2 size={14} className="spin" /> : <FolderOpen size={14} />} Browse…
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void tryIt()}
              disabled={disabled || trying || !normalizeFileManagerCommand(value.command)}
              title="Run the command as typed (not saved yet) on a sample folder"
            >
              {trying ? <Loader2 size={14} className="spin" /> : <Play size={14} />} Try it
            </button>
          </div>
          <p id={`${id}-help`} className="set-desc fm-help">
            <code>{"{path}"}</code> is the item, <code>{"{dir}"}</code> the folder that holds it; with neither,{" "}
            <code>{"{dir}"}</code> is added at the end.
          </p>
          <p id={`${id}-err`} className={`set-hint ${error ? "err-text" : ""}`} role={error ? "alert" : undefined}>
            {error ?? ""}
          </p>
        </div>
      )}
    </div>
  );
}

/** Settings → Behavior: how much the app asks before it changes data, and which file manager it opens. */
export function BehaviorTab({
  confirmCopyMove,
  fileManager,
  fileManagerError,
  disabled,
  onConfirmCopyMoveChange,
  onFileManagerChange,
}: {
  confirmCopyMove: boolean;
  fileManager: FileManagerDraft;
  fileManagerError: string | null;
  disabled: boolean;
  onConfirmCopyMoveChange(v: boolean): void;
  onFileManagerChange(v: FileManagerDraft): void;
}) {
  const id = useId();
  return (
    <div className="set-panel-body">
      <div className="set-field">
        <label className="toggle-row" htmlFor={`${id}-confirm`}>
          <span className="set-field-head">
            <span className="set-label">Ask before copying or moving</span>
            <span className="set-desc">
              Show what will be copied or moved, and where, before it starts. This applies to pasting and to dragging
              items onto a folder or bucket.
            </span>
          </span>
          <input
            id={`${id}-confirm`}
            type="checkbox"
            role="switch"
            className="switch"
            checked={confirmCopyMove}
            disabled={disabled}
            onChange={(e) => onConfirmCopyMoveChange(e.target.checked)}
          />
        </label>
        {!confirmCopyMove && (
          <p className="set-hint">
            Copy and move start right away when nothing is in the way. You can follow them, and cancel them, in the
            Activity panel.
          </p>
        )}
      </div>
      <div className="callout info" role="note">
        <ShieldCheck size={15} />
        <span>
          Even with this off, you are always asked when something at the destination would be overwritten, so you
          can choose to skip or replace it. Deleting always asks for confirmation.
        </span>
      </div>
      <FileManagerField value={fileManager} error={fileManagerError} disabled={disabled} onChange={onFileManagerChange} />
    </div>
  );
}
