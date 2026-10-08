import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowDownUp,
  Bell,
  Cpu,
  FileStack,
  Info,
  Loader2,
  MousePointer2,
  Network,
  Palette,
  RefreshCcw,
  RotateCcw,
  Settings as SettingsIcon,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  AUTO_PART_SIZE_MIB,
  MIN_UPLOAD_PART_MIB,
  DEFAULT_APP_SETTINGS,
  TRANSFER_SETTINGS_LIMITS,
  type AppError,
  type AppSettings,
  type AccentColor,
  type ThemeMode,
} from "../lib/types";
import {
  GIB,
  MIB,
  planParts,
  normalizeFileManagerCommand,
  sameAppSettings,
  validateFileManagerCommand,
  validateInteger,
  worstCasePartMib,
} from "../lib/settings";
import { formatBytes } from "../lib/format";
import { applyAccent, applyTheme } from "../lib/theme";
import {
  applyTextStyle,
  closeSettings,
  loadSettings,
  openSettings,
  saveSettings,
  useSettings,
  type SettingsTabId,
} from "../store/settings";
import { toast } from "../store/toasts";
import { useUpdates } from "../store/updates";
import { AppearanceTab } from "./AppearanceTab";
import { BehaviorTab, type FileManagerDraft } from "./BehaviorTab";
import { NotificationsTab } from "./NotificationsTab";
import { UpdatesTab } from "./UpdatesTab";

// ---- draft model ------------------------------------------------------------------

type PartMode = "auto" | "custom";

/** Form state. Numbers are kept as the raw input strings so invalid input can be shown. */
interface TransferDraft {
  partMode: PartMode;
  partSize: string;
  parts: string;
  transfers: string;
}

/** One slice per tab. Every tab edits its own fields; the dialog has one Save for all of them. */
interface Draft {
  transfers: TransferDraft;
  theme: ThemeMode;
  checkUpdatesOnStartup: boolean;
  notifyOnFinish: boolean;
  textSize: number;
  textWeight: number;
  accent: AccentColor;
  confirmCopyMove: boolean;
  fileManager: FileManagerDraft;
}

type TransferErrors = Record<"partSize" | "parts" | "transfers", string | null>;

const toDraft = (s: AppSettings): Draft => ({
  transfers: {
    partMode: s.partSizeMib === null ? "auto" : "custom",
    partSize: String(s.partSizeMib ?? AUTO_PART_SIZE_MIB.standard),
    parts: String(s.maxConcurrentParts),
    transfers: String(s.maxConcurrentTransfers),
  },
  theme: s.theme,
  checkUpdatesOnStartup: s.checkUpdatesOnStartup,
  notifyOnFinish: s.notifyOnFinish,
  textSize: s.textSize,
  textWeight: s.textWeight,
  accent: s.accent,
  confirmCopyMove: s.confirmCopyMove,
  fileManager: { mode: s.fileManagerCommand ? "program" : "system", command: s.fileManagerCommand ?? "" },
});

/** Problem with the file-manager choice, or null. "This program" needs a command. */
function fileManagerError(f: FileManagerDraft): string | null {
  if (f.mode === "system") return null;
  const cmd = normalizeFileManagerCommand(f.command);
  return cmd === null ? "Enter a command, or choose System file manager." : validateFileManagerCommand(cmd);
}

function transferErrors(d: TransferDraft): TransferErrors {
  return {
    partSize: d.partMode === "custom" ? validateInteger("partSizeMib", d.partSize) : null,
    parts: validateInteger("maxConcurrentParts", d.parts),
    transfers: validateInteger("maxConcurrentTransfers", d.transfers),
  };
}

/** The settings a draft describes, or null while any field is invalid. */
function toSettings(d: Draft): AppSettings | null {
  const t = d.transfers;
  const errs = transferErrors(t);
  if (errs.partSize || errs.parts || errs.transfers) return null;
  if (fileManagerError(d.fileManager)) return null;
  return {
    partSizeMib: t.partMode === "auto" ? null : Number(t.partSize),
    maxConcurrentParts: Number(t.parts),
    maxConcurrentTransfers: Number(t.transfers),
    theme: d.theme,
    checkUpdatesOnStartup: d.checkUpdatesOnStartup,
    notifyOnFinish: d.notifyOnFinish,
    textSize: d.textSize,
    textWeight: d.textWeight,
    accent: d.accent,
    confirmCopyMove: d.confirmCopyMove,
    fileManagerCommand: d.fileManager.mode === "system" ? null : normalizeFileManagerCommand(d.fileManager.command),
  };
}

const DEFAULT_DRAFT = toDraft(DEFAULT_APP_SETTINGS);
const sameTransferDraft = (a: TransferDraft, b: TransferDraft) => {
  const x = toSettings({ ...DEFAULT_DRAFT, transfers: a });
  const y = toSettings({ ...DEFAULT_DRAFT, transfers: b });
  return !!x && !!y && sameAppSettings(x, y);
};

/** A field's number when valid, for live previews. */
const numberOrNull = (err: string | null, v: string) => (err ? null : Number(v));

// ---- tabs ---------------------------------------------------------------------------

interface TabContext {
  draft: Draft;
  update(next: Draft): void;
  disabled: boolean;
  /** The last save's error (the backend's message), for a tab to show under its field. */
  saveError: AppError | null;
}

interface SettingsTab {
  id: SettingsTabId;
  label: string;
  icon: LucideIcon;
  render(ctx: TabContext): ReactNode;
  /** The draft with this tab's fields reset to their defaults. */
  reset(d: Draft): Draft;
  /** Whether this tab's fields are at their defaults. */
  atDefaults(d: Draft): boolean;
}

/** Add a section by appending to this list (and its slice of `Draft`). */
const TABS: SettingsTab[] = [
  {
    id: "transfers",
    label: "Transfers",
    icon: ArrowDownUp,
    render: (ctx) => (
      <TransfersTab
        value={ctx.draft.transfers}
        disabled={ctx.disabled}
        onChange={(transfers) => ctx.update({ ...ctx.draft, transfers })}
      />
    ),
    reset: (d) => ({ ...d, transfers: DEFAULT_DRAFT.transfers }),
    atDefaults: (d) => sameTransferDraft(d.transfers, DEFAULT_DRAFT.transfers),
  },
  {
    id: "behavior",
    label: "Behavior",
    icon: MousePointer2,
    render: (ctx) => (
      <BehaviorTab
        confirmCopyMove={ctx.draft.confirmCopyMove}
        fileManager={ctx.draft.fileManager}
        fileManagerError={
          fileManagerError(ctx.draft.fileManager) ??
          (ctx.saveError && /filemanager|file manager|command/i.test(ctx.saveError.message) ? ctx.saveError.message : null)
        }
        disabled={ctx.disabled}
        onConfirmCopyMoveChange={(confirmCopyMove) => ctx.update({ ...ctx.draft, confirmCopyMove })}
        onFileManagerChange={(fileManager) => ctx.update({ ...ctx.draft, fileManager })}
      />
    ),
    reset: (d) => ({ ...d, confirmCopyMove: DEFAULT_DRAFT.confirmCopyMove, fileManager: DEFAULT_DRAFT.fileManager }),
    atDefaults: (d) => d.confirmCopyMove === DEFAULT_DRAFT.confirmCopyMove && d.fileManager.mode === "system",
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: Palette,
    render: (ctx) => (
      <AppearanceTab
        value={ctx.draft.theme}
        accent={ctx.draft.accent}
        textSize={ctx.draft.textSize}
        textWeight={ctx.draft.textWeight}
        disabled={ctx.disabled}
        onChange={(theme) => ctx.update({ ...ctx.draft, theme })}
        onAccentChange={(accent) => ctx.update({ ...ctx.draft, accent })}
        onTextSizeChange={(textSize) => ctx.update({ ...ctx.draft, textSize })}
        onTextWeightChange={(textWeight) => ctx.update({ ...ctx.draft, textWeight })}
      />
    ),
    reset: (d) => ({
      ...d,
      theme: DEFAULT_DRAFT.theme,
      accent: DEFAULT_DRAFT.accent,
      textSize: DEFAULT_DRAFT.textSize,
      textWeight: DEFAULT_DRAFT.textWeight,
    }),
    atDefaults: (d) =>
      d.theme === DEFAULT_DRAFT.theme &&
      d.accent === DEFAULT_DRAFT.accent &&
      d.textSize === DEFAULT_DRAFT.textSize &&
      d.textWeight === DEFAULT_DRAFT.textWeight,
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: Bell,
    render: (ctx) => (
      <NotificationsTab
        notifyOnFinish={ctx.draft.notifyOnFinish}
        disabled={ctx.disabled}
        onNotifyOnFinishChange={(notifyOnFinish) => ctx.update({ ...ctx.draft, notifyOnFinish })}
      />
    ),
    reset: (d) => ({ ...d, notifyOnFinish: DEFAULT_DRAFT.notifyOnFinish }),
    atDefaults: (d) => d.notifyOnFinish === DEFAULT_DRAFT.notifyOnFinish,
  },
  {
    id: "updates",
    label: "Updates",
    icon: RefreshCcw,
    render: (ctx) => (
      <UpdatesTab
        checkOnStartup={ctx.draft.checkUpdatesOnStartup}
        disabled={ctx.disabled}
        onCheckOnStartupChange={(checkUpdatesOnStartup) => ctx.update({ ...ctx.draft, checkUpdatesOnStartup })}
      />
    ),
    reset: (d) => ({ ...d, checkUpdatesOnStartup: DEFAULT_DRAFT.checkUpdatesOnStartup }),
    atDefaults: (d) => d.checkUpdatesOnStartup === DEFAULT_DRAFT.checkUpdatesOnStartup,
  },
];

// ---- controls -------------------------------------------------------------------------

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

function NumberSliderField(props: {
  label: string;
  description: string;
  value: string;
  error: string | null;
  min: number;
  max: number;
  disabled: boolean;
  onChange(v: string): void;
}) {
  const id = useId();
  const { min, max } = props;
  const parsed = Number.parseInt(props.value, 10);
  const sliderValue = clamp(Number.isFinite(parsed) ? parsed : min, min, max);
  const fill = ((sliderValue - min) / (max - min)) * 100;
  return (
    <div className="set-field">
      <div className="set-field-head">
        <label className="set-label" htmlFor={`${id}-num`}>
          {props.label}
        </label>
        <p className="set-desc" id={`${id}-desc`}>
          {props.description}
        </p>
      </div>
      <div className="slider-row">
        <input
          type="range"
          className="range"
          min={min}
          max={max}
          step={1}
          value={sliderValue}
          disabled={props.disabled}
          aria-label={`${props.label} slider`}
          aria-describedby={`${id}-desc`}
          style={{ "--fill": `${fill}%` } as CSSProperties}
          onChange={(e) => props.onChange(e.target.value)}
        />
        <input
          id={`${id}-num`}
          type="number"
          className="num-input"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={props.value}
          disabled={props.disabled}
          aria-invalid={!!props.error}
          aria-describedby={`${id}-desc ${id}-err`}
          onChange={(e) => props.onChange(e.target.value)}
        />
      </div>
      <p id={`${id}-err`} className={`set-hint ${props.error ? "err-text" : ""}`}>
        {props.error ?? `${min}–${max}`}
      </p>
    </div>
  );
}

const PART_CHIPS = [4, 8, 16, 32, 64, 128].filter(
  (n) => n >= TRANSFER_SETTINGS_LIMITS.partSizeMib.min && n <= TRANSFER_SETTINGS_LIMITS.partSizeMib.max,
);

function PartSizeField({
  value,
  error,
  disabled,
  onChange,
}: {
  value: TransferDraft;
  error: string | null;
  disabled: boolean;
  onChange(next: Partial<TransferDraft>): void;
}) {
  const id = useId();
  const { min, max } = TRANSFER_SETTINGS_LIMITS.partSizeMib;
  const modes: { mode: PartMode; label: string }[] = [
    { mode: "auto", label: "Auto" },
    { mode: "custom", label: "Custom" },
  ];
  const custom = value.partMode === "custom";
  const n = numberOrNull(error, value.partSize);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onRadioKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const next = (i + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1) + modes.length) % modes.length;
    onChange({ partMode: modes[next].mode });
    refs.current[next]?.focus();
  };

  return (
    <div className="set-field">
      <div className="set-field-head">
        <span className="set-label" id={`${id}-label`}>
          Part size
        </span>
        <p className="set-desc" id={`${id}-desc`}>
          Large objects are transferred in parts. Objects no larger than one part download in a single request.
        </p>
      </div>
      <div className="segmented set-segmented" role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={`${id}-desc`}>
        {modes.map((m, i) => (
          <button
            key={m.mode}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={value.partMode === m.mode}
            tabIndex={value.partMode === m.mode ? 0 : -1}
            className={value.partMode === m.mode ? "active" : ""}
            disabled={disabled}
            onClick={() => onChange({ partMode: m.mode })}
            onKeyDown={(e) => onRadioKey(e, i)}
          >
            {m.label}
          </button>
        ))}
      </div>
      {!custom ? (
        <p className="set-hint">
          {AUTO_PART_SIZE_MIB.standard} MiB parts; {AUTO_PART_SIZE_MIB.large} MiB for files over 1 GiB.
        </p>
      ) : (
        <>
          <div className="part-custom">
            <div className="num-affix">
              <input
                id={`${id}-num`}
                type="number"
                className="num-input"
                inputMode="numeric"
                min={min}
                max={max}
                step={1}
                value={value.partSize}
                disabled={disabled}
                aria-label="Custom part size in MiB"
                aria-invalid={!!error}
                aria-describedby={`${id}-err`}
                onChange={(e) => onChange({ partSize: e.target.value })}
              />
              <span className="num-unit" aria-hidden="true">
                MiB
              </span>
            </div>
            <div className="chips" role="group" aria-label="Quick part sizes">
              {PART_CHIPS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`chip ${n === c ? "active" : ""}`}
                  aria-pressed={n === c}
                  disabled={disabled}
                  onClick={() => onChange({ partSize: String(c) })}
                >
                  {c} MiB
                </button>
              ))}
            </div>
          </div>
          <p id={`${id}-err`} className={`set-hint ${error ? "err-text" : ""}`}>
            {error ?? `${min}–${max} MiB. Uploads use at least ${MIN_UPLOAD_PART_MIB} MiB parts (S3 minimum).`}
          </p>
          {n !== null && n < MIN_UPLOAD_PART_MIB && (
            <div className="callout warn" role="note">
              <AlertTriangle size={15} />
              <span>
                Uploads will use <strong>{MIN_UPLOAD_PART_MIB} MiB</strong> parts: S3 requires every part except the
                last to be at least {MIN_UPLOAD_PART_MIB} MiB. Downloads use {n} MiB parts.
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---- impact summary ---------------------------------------------------------------------

function ImpactSummary({ value, errors }: { value: TransferDraft; errors: TransferErrors }) {
  const partMib = value.partMode === "auto" ? null : numberOrNull(errors.partSize, value.partSize);
  const partValid = value.partMode === "auto" || partMib !== null;
  const parts = numberOrNull(errors.parts, value.parts);
  const transfers = numberOrNull(errors.transfers, value.transfers);

  const connections = parts !== null && transfers !== null ? parts * transfers : null;
  const worstPart = partValid ? worstCasePartMib(partMib) * MIB : null;
  const memory = worstPart !== null && parts !== null && transfers !== null ? transfers * parts * worstPart : null;
  const level = memory === null ? "ok" : memory > 4 * GIB ? "danger" : memory > GIB ? "warn" : "ok";

  const dl = partValid ? planParts("download", partMib, GIB) : null;
  const ul = partValid ? planParts("upload", partMib, GIB) : null;
  const big = partValid && partMib === null ? planParts("download", null, 4 * GIB) : null;
  const dash = "—";

  return (
    <section className="impact" aria-labelledby="impact-title">
      <h3 className="section-title" id="impact-title">
        Impact
      </h3>
      <div className="impact-grid">
        <div className="stat">
          <div className="stat-label">
            <Network size={13} /> Max connections
          </div>
          <div className="stat-value">{connections ?? dash}</div>
          <div className="stat-sub">
            {transfers ?? dash} {transfers === 1 ? "transfer" : "transfers"} × {parts ?? dash} {parts === 1 ? "part" : "parts"}
          </div>
        </div>
        <div className={`stat stat-${level}`}>
          <div className="stat-label">
            <Cpu size={13} /> Peak download memory
          </div>
          <div className="stat-value">{memory === null ? dash : formatBytes(memory)}</div>
          <div className="stat-sub">
            {worstPart !== null && parts !== null ? `${formatBytes(parts * worstPart)} per transfer` : dash}
            {partMib === null && partValid ? ` (worst case, ${AUTO_PART_SIZE_MIB.large} MiB parts)` : ""}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">
            <FileStack size={13} /> Example
          </div>
          <div className="stat-value">{dl ? `${dl.parts.toLocaleString()} ${dl.parts === 1 ? "part" : "parts"}` : dash}</div>
          <div className="stat-sub">
            {dl ? `A 1 GiB file → ${dl.parts.toLocaleString()} × ${dl.partBytes / MIB} MiB` : "A 1 GiB file"}
            {ul && dl && ul.parts !== dl.parts ? `; upload → ${ul.parts.toLocaleString()} × ${ul.partBytes / MIB} MiB` : ""}
            {big ? `; 4 GiB → ${big.parts} × ${big.partBytes / MIB} MiB` : ""}
          </div>
        </div>
      </div>
      {level !== "ok" && memory !== null && (
        <div className={`callout ${level}`} role="note">
          <AlertTriangle size={15} />
          <span>
            {level === "danger" ? <strong>Very high memory use. </strong> : <strong>High memory use. </strong>}
            Running downloads may hold up to {formatBytes(memory)} in RAM.
            {level === "danger"
              ? " This can exhaust memory on most machines; lower parallel parts or simultaneous transfers."
              : " Consider fewer parallel parts or fewer simultaneous transfers."}
          </span>
        </div>
      )}
    </section>
  );
}

// ---- the Transfers tab --------------------------------------------------------------------

function TransfersTab({
  value,
  disabled,
  onChange,
}: {
  value: TransferDraft;
  disabled: boolean;
  onChange(next: TransferDraft): void;
}) {
  const errors = transferErrors(value);
  const set = (p: Partial<TransferDraft>) => onChange({ ...value, ...p });
  const L = TRANSFER_SETTINGS_LIMITS;
  return (
    <div className="set-panel-body">
      <PartSizeField value={value} error={errors.partSize} disabled={disabled} onChange={set} />
      <NumberSliderField
        label="Parallel parts per transfer"
        description="How many parts of one file are transferred at the same time."
        value={value.parts}
        error={errors.parts}
        min={L.maxConcurrentParts.min}
        max={L.maxConcurrentParts.max}
        disabled={disabled}
        onChange={(v) => set({ parts: v })}
      />
      <NumberSliderField
        label="Simultaneous transfers"
        description="How many downloads and uploads run at once. The rest wait in the queue."
        value={value.transfers}
        error={errors.transfers}
        min={L.maxConcurrentTransfers.min}
        max={L.maxConcurrentTransfers.max}
        disabled={disabled}
        onChange={(v) => set({ transfers: v })}
      />
      <ImpactSummary value={value} errors={errors} />
      <div className="callout info" role="note">
        <Info size={15} />
        <span>
          Part size and parallel parts apply to transfers that start after saving. The simultaneous-transfers limit
          applies to the queue immediately and never interrupts running transfers.
        </span>
      </div>
    </div>
  );
}

// ---- dialog ----------------------------------------------------------------------------------

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

function SettingsDialogInner() {
  const saved = useSettings((s) => s.settings);
  const loading = useSettings((s) => s.loading);
  const loadError = useSettings((s) => s.error);
  const saving = useSettings((s) => s.saving);

  const [tab, setTab] = useState<SettingsTabId>(() => useSettings.getState().initialTab);
  const [draft, setDraft] = useState<Draft | null>(() => (saved ? toDraft(saved) : null));
  const [saveError, setSaveError] = useState<AppError | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const keepEditingRef = useRef<HTMLButtonElement>(null);

  // The settings may arrive after the dialog opened (first load still in flight).
  useEffect(() => {
    if (saved && !draft) setDraft(toDraft(saved));
  }, [saved, draft]);

  // Live theme preview; closing the dialog re-applies the saved theme (see closeSettings).
  const previewTheme = draft?.theme;
  useEffect(() => {
    if (previewTheme) applyTheme(previewTheme);
  }, [previewTheme]);
  // Live accent preview, reverted the same way.
  const previewAccent = draft?.accent;
  useEffect(() => {
    if (previewAccent) applyAccent(previewAccent);
  }, [previewAccent]);
  // Live text preview, reverted the same way.
  const [previewSize, previewWeight] = [draft?.textSize, draft?.textWeight];
  useEffect(() => {
    if (previewSize && previewWeight) applyTextStyle(previewSize, previewWeight);
  }, [previewSize, previewWeight]);

  // Initial focus on the active tab; restore focus to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    tabRefs.current[Math.max(0, TABS.findIndex((t) => t.id === tab))]?.focus();
    return () => {
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    if (confirmDiscard) keepEditingRef.current?.focus();
  }, [confirmDiscard]);

  const next = draft ? toSettings(draft) : null;
  const dirty = !!draft && !!saved && (next === null || !sameAppSettings(next, saved));
  const canSave = !!next && dirty && !saving;

  const update = (d: Draft) => {
    setDraft(d);
    setSaveError(null);
    setConfirmDiscard(false);
  };

  /** Hide the discard prompt and keep focus inside the dialog (its buttons unmount). */
  const keepEditing = () => {
    setConfirmDiscard(false);
    requestAnimationFrame(() => dialogRef.current?.focus());
  };

  /** Esc, the backdrop and the close button: ask before discarding unsaved edits. */
  const requestClose = () => {
    if (saving) return;
    if (dirty) setConfirmDiscard(true);
    else closeSettings();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave || !next) return;
    setSaveError(null);
    try {
      await saveSettings(next);
      toast.success("Settings saved");
      closeSettings();
    } catch (err) {
      const appErr = err as AppError;
      setSaveError(appErr);
      toast.error("Couldn't save settings", appErr);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keep keys inside the dialog: the explorer's global shortcuts must not see them.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      if (confirmDiscard) keepEditing();
      else requestClose();
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;
    const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !dialogRef.current.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let to = -1;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") to = (i + 1) % TABS.length;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") to = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = TABS.length - 1;
    if (to < 0) return;
    e.preventDefault();
    setTab(TABS[to].id);
    tabRefs.current[to]?.focus();
  };

  const current = TABS.find((t) => t.id === tab) ?? TABS[0];
  const ready = !!draft && !!saved;
  const atDefaults = !!draft && current.atDefaults(draft);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && requestClose()} onKeyDown={onKeyDown}>
      <div
        ref={dialogRef}
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
      >
        <form className="settings-form" onSubmit={(e) => void submit(e)} noValidate>
          <header className="settings-head">
            <div className="modal-icon">
              <SettingsIcon size={17} />
            </div>
            <h2 id="settings-title">Settings</h2>
            <div className="spacer" />
            <button type="button" className="icon-btn lg" onClick={requestClose} aria-label="Close settings" title="Close (Esc)" disabled={saving}>
              <X size={16} />
            </button>
          </header>
          <div className="settings-main">
            <nav className="settings-nav" role="tablist" aria-orientation="vertical" aria-label="Settings sections">
              {TABS.map((t, i) => {
                const Icon = t.icon;
                const selected = t.id === current.id;
                return (
                  <button
                    key={t.id}
                    ref={(el) => {
                      tabRefs.current[i] = el;
                    }}
                    type="button"
                    role="tab"
                    id={`settings-tab-${t.id}`}
                    aria-selected={selected}
                    aria-controls={`settings-panel-${t.id}`}
                    tabIndex={selected ? 0 : -1}
                    className={`settings-tab ${selected ? "active" : ""}`}
                    onClick={() => setTab(t.id)}
                    onKeyDown={(e) => onTabKey(e, i)}
                  >
                    <Icon size={15} /> {t.label}
                  </button>
                );
              })}
            </nav>
            <div
              className="settings-panel"
              role="tabpanel"
              id={`settings-panel-${current.id}`}
              aria-labelledby={`settings-tab-${current.id}`}
            >
              <h3 className="settings-panel-title">{current.label}</h3>
              {ready ? (
                current.render({ draft: draft!, update, disabled: saving, saveError })
              ) : loadError ? (
                <div className="settings-state">
                  <div className="form-error">
                    <AlertCircle size={15} />
                    <span>Couldn't load settings: {loadError.message}</span>
                  </div>
                  <button type="button" className="btn" onClick={() => void loadSettings()} disabled={loading}>
                    {loading && <Loader2 size={14} className="spin" />} Retry
                  </button>
                </div>
              ) : (
                <div className="settings-state muted">
                  <Loader2 size={16} className="spin" /> Loading settings…
                </div>
              )}
            </div>
          </div>
          {saveError && (
            <div className="form-error settings-error" role="alert">
              <AlertCircle size={15} />
              <span>{saveError.message}</span>
            </div>
          )}
          <footer className="settings-foot">
            {confirmDiscard ? (
              <>
                <span className="confirm-text" role="alert">
                  <AlertTriangle size={14} /> Discard unsaved changes?
                </span>
                <div className="spacer" />
                <button ref={keepEditingRef} type="button" className="btn" onClick={keepEditing}>
                  Keep editing
                </button>
                <button type="button" className="btn btn-danger" onClick={closeSettings}>
                  Discard
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={() => draft && update(current.reset(draft))}
                  disabled={!ready || saving || atDefaults}
                  title={`Reset the ${current.label} settings to their defaults. Changes still need to be saved.`}
                >
                  <RotateCcw size={13} /> Reset to defaults
                </button>
                <div className="spacer" />
                {dirty && !saving && <span className="unsaved muted small">Unsaved changes</span>}
                <button type="button" className="btn" onClick={closeSettings} disabled={saving}>
                  {dirty ? "Cancel" : "Close"}
                </button>
                <button type="submit" className="btn btn-primary" disabled={!canSave}>
                  {saving && <Loader2 size={14} className="spin" />} {saving ? "Saving…" : "Save"}
                </button>
              </>
            )}
          </footer>
        </form>
      </div>
    </div>
  );
}

export function SettingsDialog() {
  const open = useSettings((s) => s.open);
  // Mounting fresh on every open discards any previous draft.
  return open ? <SettingsDialogInner /> : null;
}

export function SettingsButton({ className = "" }: { className?: string }) {
  const open = useSettings((s) => s.open);
  const notice = useUpdates((s) => s.notice);
  return (
    <button
      type="button"
      className={`icon-btn lg settings-btn ${className}`}
      onClick={() => openSettings(notice ? "updates" : "transfers")}
      aria-label={notice ? "Settings (update available)" : "Settings"}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={notice ? "Settings: an update is available" : "Settings"}
    >
      <SettingsIcon size={15} />
      {notice && <span className="notice-dot" aria-hidden="true" />}
    </button>
  );
}

