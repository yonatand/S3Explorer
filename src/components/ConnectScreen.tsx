import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Cloud,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  LockKeyhole,
  LogIn,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  MapPin,
  Trash2,
  UserRound,
} from "lucide-react";
import * as api from "../lib/api";
import {
  SAVED_CONNECTION_NAME_MAX,
  type AppError,
  type AwsLoginDone,
  type AwsLoginKind,
  type AwsLoginOutput,
  type ConnectionConfig,
  type ProfileInfo,
  type SavedConnection,
} from "../lib/types";
import { formatExact, formatRelative, nameTone } from "../lib/format";
import { launchLabel, useLaunch } from "../store/launch";
import { connectionIdentity, forgetSavedConnection, readPref, setConnected, writePref } from "../store/app";
import { toast } from "../store/toasts";
import { Logo } from "./Logo";
import { SettingsButton } from "./SettingsDialog";
import { UpdatePill } from "./UpdateDialog";
import { ThemeToggle } from "./ThemeToggle";
import { TransferBackdrop } from "./TransferBackdrop";
import { useTileReorder } from "./useTileReorder";

type Mode = "profile" | "static";

/**
 * The last unsaved connection, remembered between launches for people who don't save
 * connections. Never contains secrets.
 */
interface LastUsed {
  mode: Mode;
  profile: string;
  profileRegion: string;
  profileEndpoint: string;
  accessKeyId: string;
  region: string;
  endpoint: string;
  forcePathStyle: boolean;
}

const PREF_KEY = "s3x.lastConnection";
/** The order the user dragged the connection tiles into: a list of saved-connection ids. */
const ORDER_KEY = "s3x.connectionOrder";
const KEYCHAIN_LINE = "Secret keys are stored in your operating system's keychain, not in a file.";

const LAST_USED_DEFAULTS: LastUsed = {
  mode: "profile",
  profile: "",
  profileRegion: "",
  profileEndpoint: "",
  accessKeyId: "",
  region: "us-east-1",
  endpoint: "",
  forcePathStyle: true,
};

function loadLastUsed(): LastUsed {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    return raw ? { ...LAST_USED_DEFAULTS, ...(JSON.parse(raw) as Partial<LastUsed>) } : LAST_USED_DEFAULTS;
  } catch {
    return LAST_USED_DEFAULTS;
  }
}

// ---- display helpers -----------------------------------------------------------------

function endpointHost(endpoint: string | null): string {
  if (!endpoint) return "AWS";
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`).host || endpoint;
  } catch {
    return endpoint;
  }
}

const shortKey = (k: string) => (k.length > 12 ? `${k.slice(0, 4)}…${k.slice(-4)}` : k);

/** Message for an error from a saved-connection command; keychain errors get specific advice. */
function describeError(e: AppError, during: "save" | "connect"): string {
  if (e.code !== "Keychain") return e.message;
  const what =
    during === "save"
      ? "Couldn't save to your operating system's keychain."
      : "Couldn't read the secret key from your operating system's keychain.";
  return `${what} The keychain may be locked or unavailable. Unlock it (or sign in to your desktop session) and try again. Details: ${e.message}`;
}

// ---- expired aws login / sso session (v0.9.3) -----------------------------------------------

/** The backend's wording for an expired `aws login` / `aws sso login` session. */
const EXPIRED_PREFIX = "Your AWS sign-in has expired";
/** The sign-in log shows at most this many of the CLI's lines, newest last. */
const SIGNIN_LOG_LINES = 20;

interface ExpiredSession {
  headline: string;
  /** The SDK's text after "Details: " (empty when the backend sent none). */
  details: string;
  kind: AwsLoginKind;
}

function parseExpired(e: AppError | null): ExpiredSession | null {
  if (!e || e.code !== "Auth" || !e.message.startsWith(EXPIRED_PREFIX)) return null;
  const [headline, ...rest] = e.message.split(/\r?\n\s*\r?\n/);
  return {
    headline: headline.trim(),
    details: rest.join("\n\n").trim().replace(/^Details:\s*/, ""),
    kind: /aws sso login/.test(e.message) ? "sso" : "login",
  };
}

/** `code` spans in the backend's message become <code>. */
function withCode(text: string) {
  return text.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>));
}

type SignInStatus = "starting" | "running" | "failed" | "cancelled" | "timedOut" | "error";
interface SignInState {
  status: SignInStatus;
  lines: string[];
  exitCode?: number | null;
  /** Why the CLI could not be started. */
  message?: string;
}
interface SignInRun {
  /** Null until `start_aws_login` answers; events that arrive before are buffered and replayed. */
  runId: string | null;
  buffer: (AwsLoginOutput | AwsLoginDone)[];
  /** Cancel the run as soon as its id is known. */
  cancel: boolean;
}
const signInActive = (s: SignInState | null) => s?.status === "starting" || s?.status === "running";

function signInOutcome(s: SignInState): string | null {
  switch (s.status) {
    case "failed":
      return s.exitCode == null ? "Sign in failed." : `Sign in failed (exit ${s.exitCode}).`;
    case "cancelled":
      return "Sign in cancelled.";
    case "timedOut":
      return "Sign in timed out after 10 minutes.";
    case "error":
      return s.message ?? "Couldn't start the AWS CLI.";
    default:
      return null;
  }
}

const isMissingSecret = (e: AppError, c: SavedConnection) =>
  e.code === "InvalidInput" && c.kind === "static" && (!c.hasSecret || /secret/i.test(e.message));

// ---- saved connection row --------------------------------------------------------------

function RowMenu({
  conn,
  anchor,
  point,
  onConnect,
  onEdit,
  onDelete,
  onClose,
}: {
  conn: SavedConnection;
  anchor: RefObject<HTMLButtonElement | null>;
  /** Where the tile was right-clicked; null when the menu was opened from the ⋯ button. */
  point: { x: number; y: number } | null;
  onConnect(): void;
  onEdit(): void;
  onDelete(): void;
  onClose(refocus: boolean): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Fixed position so the scrolling list never clips the menu: at the pointer after a right-click,
  // otherwise under the trigger. Either way it flips up and shifts left to stay inside the window.
  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect();
    const m = ref.current?.getBoundingClientRect();
    if (!a || !m) return;
    const left = point ? point.x : a.right - m.width;
    const below = point ? point.y : a.bottom + 4;
    const above = (point ? point.y : a.top - 4) - m.height;
    const top = below + m.height > window.innerHeight - 6 ? Math.max(6, above) : below;
    setPos({ left: Math.max(6, Math.min(left, window.innerWidth - m.width - 6)), top });
  }, [anchor, point]);

  // Focus the first item once the menu is visible (hidden elements can't take focus).
  const placed = pos !== null;
  useEffect(() => {
    if (placed) ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [placed]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) onClose(false);
    };
    const dismiss = () => onClose(false);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("wheel", dismiss, { passive: true });
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("wheel", dismiss);
    };
  }, [anchor, onClose]);

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? (i + 1) % btns.length : (i - 1 + btns.length) % btns.length;
      btns[next]?.focus();
    } else if (e.key === "Tab") {
      onClose(false);
    }
  };

  return (
    <div
      ref={ref}
      className="context-menu row-menu"
      role="menu"
      aria-label={`Actions for ${conn.name}`}
      onKeyDown={onKey}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}
    >
      <button type="button" role="menuitem" className="menu-item" onClick={onConnect}>
        <LogIn size={14} />
        <span className="menu-label">Connect</span>
      </button>
      <button type="button" role="menuitem" className="menu-item" onClick={onEdit}>
        <Pencil size={14} />
        <span className="menu-label">Edit…</span>
      </button>
      <button type="button" role="menuitem" className="menu-item danger" onClick={onDelete}>
        <Trash2 size={14} />
        <span className="menu-label">Delete…</span>
      </button>
    </div>
  );
}

function SavedRow({
  conn,
  busy,
  disabled,
  dragging,
  menuOpen,
  onDragStart,
  onConnect,
  onToggleMenu,
  onEdit,
  onDelete,
}: {
  conn: SavedConnection;
  busy: boolean;
  disabled: boolean;
  /** This tile is being dragged to a new place. */
  dragging: boolean;
  menuOpen: boolean;
  onDragStart(e: ReactPointerEvent): void;
  onConnect(): void;
  onToggleMenu(open: boolean): void;
  onEdit(): void;
  onDelete(): void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuPoint, setMenuPoint] = useState<{ x: number; y: number } | null>(null);
  // A cloud for AWS itself, a server for a custom endpoint (MinIO, R2…).
  const Icon = conn.endpoint ? Server : Cloud;
  const meta: { text: string; mono?: boolean }[] = [{ text: endpointHost(conn.endpoint) }];
  if (conn.region) meta.push({ text: conn.region });
  if (conn.kind === "profile") meta.push({ text: `profile ${conn.profile ?? "?"}` });
  else if (conn.accessKeyId) meta.push({ text: shortKey(conn.accessKeyId), mono: true });
  const missing = conn.kind === "static" && !conn.hasSecret;
  return (
    <li
      // The tone class gives the whole tile its colour: the badge, and the border while dragging.
      className={`saved-row tone-${nameTone(conn.name)} ${menuOpen ? "menu-open" : ""} ${dragging ? "dragging" : ""}`}
      data-id={conn.id}
      onPointerDown={(e) => {
        // The ⋯ button and its menu are not drag handles.
        if (!(e.target as Element).closest(".saved-more")) onDragStart(e);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (disabled) return;
        setMenuPoint({ x: e.clientX, y: e.clientY });
        onToggleMenu(true);
      }}
    >
      <button
        type="button"
        className="saved-main"
        onClick={onConnect}
        disabled={disabled}
        aria-label={`Connect to ${conn.name}`}
        aria-describedby={`saved-meta-${conn.id}`}
      >
        <span className="saved-icon" aria-hidden="true">
          <Icon size={22} />
        </span>
        <span className="saved-text">
          <span className="saved-name">{conn.name}</span>
          <span className="saved-meta" id={`saved-meta-${conn.id}`}>
            {meta.map((m, i) => (
              <span key={i} className={m.mono ? "mono" : undefined}>
                {m.text}
              </span>
            ))}
            {missing && <span className="saved-warn">secret missing</span>}
          </span>
        </span>
        <span className="saved-used" title={conn.lastUsedAt ? `Last used ${formatExact(conn.lastUsedAt)}` : undefined}>
          {conn.lastUsedAt ? `Opened ${formatRelative(conn.lastUsedAt)}` : "Not opened yet"}
        </span>
        {busy && <Loader2 size={15} className="spin saved-go" />}
      </button>
      <div className="saved-more">
        <button
          ref={triggerRef}
          type="button"
          className="icon-btn lg"
          aria-label={`More actions for ${conn.name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={disabled}
          onClick={() => {
            setMenuPoint(null);
            onToggleMenu(!menuOpen);
          }}
        >
          <MoreHorizontal size={15} />
        </button>
        {menuOpen && (
          <RowMenu
            conn={conn}
            anchor={triggerRef}
            point={menuPoint}
            onConnect={() => {
              onToggleMenu(false);
              onConnect();
            }}
            onEdit={onEdit}
            onDelete={onDelete}
            onClose={(refocus) => {
              onToggleMenu(false);
              if (refocus) triggerRef.current?.focus();
            }}
          />
        )}
      </div>
    </li>
  );
}

// ---- delete confirmation -----------------------------------------------------------------

function DeleteSavedModal({ conn, onClose, onDeleted }: { conn: SavedConnection; onClose(): void; onDeleted(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteSavedConnection(conn.id);
      // The backend forgets the connection's added buckets too; drop them from the UI if it is in use.
      forgetSavedConnection(conn.id);
      toast.success(`Deleted “${conn.name}”`);
      onDeleted();
    } catch (e) {
      setError(e as AppError);
      setBusy(false);
    }
  };

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && !busy) {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab" && dialogRef.current) {
      const items = [...dialogRef.current.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()} onKeyDown={onKey}>
      <div ref={dialogRef} className="modal" role="alertdialog" aria-modal="true" aria-labelledby="del-saved-title" aria-describedby="del-saved-desc">
        <div className="modal-head">
          <div className="modal-icon danger">
            <AlertTriangle size={18} />
          </div>
          <div>
            <h2 id="del-saved-title">Delete “{conn.name}”?</h2>
            <p className="muted small">The saved connection is removed from S3 Explorer.</p>
          </div>
        </div>
        <p className="modal-text" id="del-saved-desc">
          {conn.kind === "static" ? (
            <>
              The secret key stored for it in your operating system's keychain is <strong>removed too</strong>. Your
              data in S3 is not affected.
            </>
          ) : (
            <>Your AWS profile in ~/.aws is not changed, and your data in S3 is not affected.</>
          )}
        </p>
        {error && (
          <div className="form-error" role="alert">
            <AlertCircle size={15} />
            <span>{describeError(error, "save")}</span>
          </div>
        )}
        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" onClick={() => void confirm()} disabled={busy}>
            {busy && <Loader2 size={14} className="spin" />} {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- screen ------------------------------------------------------------------------------

type View = "loading" | "saved" | "form";

export function ConnectScreen() {
  const launch = useLaunch((s) => s.pending);
  const [lastUsed] = useState(loadLastUsed);
  const [mode, setMode] = useState<Mode>(lastUsed.mode);
  const [profiles, setProfiles] = useState<ProfileInfo[] | null>(null);
  const [profilesError, setProfilesError] = useState<AppError | null>(null);
  const [profile, setProfile] = useState(lastUsed.profile);
  const [profileRegion, setProfileRegion] = useState(lastUsed.profileRegion);
  const [profileEndpoint, setProfileEndpoint] = useState(lastUsed.profileEndpoint);
  const [showAdvanced, setShowAdvanced] = useState(!!(lastUsed.profileRegion || lastUsed.profileEndpoint));

  const [accessKeyId, setAccessKeyId] = useState(lastUsed.accessKeyId);
  const [secret, setSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [sessionToken, setSessionToken] = useState("");
  const [region, setRegion] = useState(lastUsed.region);
  const [endpoint, setEndpoint] = useState(lastUsed.endpoint);
  const [forcePathStyle, setForcePathStyle] = useState(lastUsed.forcePathStyle);

  // Saved connections
  const [saved, setSaved] = useState<SavedConnection[] | null>(null);
  const [savedError, setSavedError] = useState<AppError | null>(null);
  const [view, setView] = useState<View>("loading");
  const [editing, setEditing] = useState<SavedConnection | null>(null);
  const [editNotice, setEditNotice] = useState<string | null>(null);
  // New connections are saved unless the box is unticked.
  const [saveChecked, setSaveChecked] = useState(true);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [saveError, setSaveError] = useState<AppError | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SavedConnection | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  // Sign in again (v0.9.3): the profile of the failed attempt, how to retry it, and the CLI run.
  const [attemptProfile, setAttemptProfile] = useState<string | null>(null);
  const retryRef = useRef<(() => void) | null>(null);
  const [signIn, setSignIn] = useState<SignInState | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const runRef = useRef<SignInRun | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);
  const secretRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLFormElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const onSignInEvent = (e: AwsLoginOutput | AwsLoginDone) => {
    const run = runRef.current;
    if (!run) return;
    if (run.runId === null) {
      run.buffer.push(e);
      return;
    }
    if (e.runId !== run.runId) return;
    if ("line" in e) {
      setSignIn((cur) => (cur ? { ...cur, status: "running", lines: [...cur.lines, e.line].slice(-SIGNIN_LOG_LINES) } : cur));
      return;
    }
    runRef.current = null;
    if (e.exitCode === 0 && !e.cancelled && !e.timedOut) {
      setSignIn(null);
      retryRef.current?.();
      return;
    }
    const status: SignInStatus = e.cancelled ? "cancelled" : e.timedOut ? "timedOut" : "failed";
    setSignIn((cur) => ({ lines: cur?.lines ?? [], status, exitCode: e.exitCode }));
  };
  // The listeners are registered once; the handler they call is always the latest render's.
  const onSignInEventRef = useRef(onSignInEvent);
  onSignInEventRef.current = onSignInEvent;

  useEffect(() => {
    let alive = true;
    const unlisten: api.Unlisten[] = [];
    const keep = (u: api.Unlisten) => {
      if (alive) unlisten.push(u);
      else u();
    };
    void api.onAwsLoginOutput((e) => onSignInEventRef.current(e)).then(keep, () => undefined);
    void api.onAwsLoginDone((e) => onSignInEventRef.current(e)).then(keep, () => undefined);
    return () => {
      alive = false;
      unlisten.forEach((u) => u());
      // Leaving the connect screen cancels a running sign-in.
      const run = runRef.current;
      runRef.current = null;
      if (run?.runId) void api.cancelAwsLogin(run.runId).catch(() => undefined);
      else if (run) run.cancel = true;
    };
  }, []);

  /** Cancel a running sign-in (if any) and forget its state. */
  const stopSignIn = () => {
    const run = runRef.current;
    runRef.current = null;
    if (run?.runId) void api.cancelAwsLogin(run.runId).catch(() => undefined);
    else if (run) run.cancel = true;
    setSignIn(null);
  };

  const startSignIn = async (profileName: string, kind: AwsLoginKind) => {
    if (runRef.current) return;
    const run: SignInRun = { runId: null, buffer: [], cancel: false };
    runRef.current = run;
    setSignIn({ status: "starting", lines: [] });
    try {
      const { runId } = await api.startAwsLogin(profileName, kind);
      if (run.cancel || runRef.current !== run) {
        // Cancelled, or the screen was left, before the run had an id.
        void api.cancelAwsLogin(runId).catch(() => undefined);
        return;
      }
      run.runId = runId;
      setSignIn((cur) => (cur ? { ...cur, status: "running" } : cur));
      const buffered = run.buffer;
      run.buffer = [];
      for (const e of buffered) if (e.runId === runId) onSignInEvent(e);
    } catch (e) {
      if (runRef.current !== run) return;
      runRef.current = null;
      setSignIn({ status: "error", lines: [], message: (e as AppError).message });
    }
  };

  const cancelSignIn = () => {
    const run = runRef.current;
    if (!run) return;
    if (run.runId) {
      // The done event (cancelled: true) settles the state.
      void api.cancelAwsLogin(run.runId).catch(() => undefined);
    } else {
      run.cancel = true;
      runRef.current = null;
      setSignIn((cur) => ({ lines: cur?.lines ?? [], status: "cancelled" }));
    }
  };

  const loadProfiles = async () => {
    setProfiles(null);
    setProfilesError(null);
    try {
      const list = await api.listProfiles();
      setProfiles(list);
      setProfile((cur) => {
        if (cur && list.some((p) => p.name === cur && p.hasCredentials)) return cur;
        return list.find((p) => p.hasCredentials)?.name ?? "";
      });
    } catch (e) {
      setProfilesError(e as AppError);
      setProfiles([]);
    }
  };

  const loadSaved = async (): Promise<SavedConnection[]> => {
    try {
      const list = await api.listSavedConnections();
      setSaved(list);
      setSavedError(null);
      return list;
    } catch (e) {
      setSavedError(e as AppError);
      setSaved((cur) => cur ?? []);
      return saved ?? [];
    }
  };

  useEffect(() => {
    void loadProfiles();
    void loadSaved().then((list) => setView(list.length ? "saved" : "form"));
  }, []);

  // One turn of the wheel moves the tile list by a whole page (two rows); CSS snapping settles it.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    let lastTurn = 0;
    const onWheel = (e: WheelEvent) => {
      if (list.scrollHeight <= list.clientHeight) return;
      e.preventDefault();
      // A trackpad sends a burst of wheel events for one gesture; act on the first only.
      if (e.timeStamp - lastTurn < 500) return;
      lastTurn = e.timeStamp;
      list.scrollBy({ top: Math.sign(e.deltaY) * list.clientHeight, behavior: "smooth" });
    };
    list.addEventListener("wheel", onWheel, { passive: false });
    return () => list.removeEventListener("wheel", onWheel);
  }, [view]);

  // Tiles appear in the order the user dragged them into; connections not placed yet come last, in
  // the backend's order (most recently used first).
  const [order, setOrder] = useState(() => readPref<string[]>(ORDER_KEY, []));
  const place = (c: SavedConnection) => (order.includes(c.id) ? order.indexOf(c.id) : order.length);
  const tiles = [...(saved ?? [])].sort((a, b) => place(a) - place(b));
  const reorder = useTileReorder(
    tiles.map((c) => c.id),
    (ids) => {
      setOrder(ids);
      writePref(ORDER_KEY, ids);
    },
  );

  const signingIn = signInActive(signIn);
  const busy = connecting || busyId !== null || signingIn;
  const hasSaved = !!saved && saved.length > 0;
  const tokenEntered = mode === "static" && !!sessionToken.trim();
  /** Saving applies: always while editing; otherwise when the box is checked and no session token blocks it. */
  const wantsSave = !!editing || (saveChecked && !tokenEntered);
  const keepsSecret = !!editing && editing.kind === "static" && editing.hasSecret;

  /** Name for a new connection when the field is left empty: the profile, endpoint host or region, made unique. */
  const suggestName = () => {
    const base = mode === "profile" ? profile || "AWS profile" : endpoint.trim() ? endpointHost(endpoint.trim()) : `AWS ${region.trim() || "S3"}`;
    const taken = new Set((saved ?? []).map((c) => c.name.toLowerCase()));
    let candidate = base.slice(0, SAVED_CONNECTION_NAME_MAX);
    for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${base.slice(0, SAVED_CONNECTION_NAME_MAX - 5)} (${i})`;
    return candidate;
  };
  // A new connection may leave the name empty and take the suggestion; an edited one may not.
  const trimmedName = name.trim() || (editing ? "" : suggestName());
  const nameError = !wantsSave
    ? null
    : !trimmedName
      ? "Enter a name for this connection."
      : [...trimmedName].length > SAVED_CONNECTION_NAME_MAX
        ? `Use at most ${SAVED_CONNECTION_NAME_MAX} characters.`
        : saved?.some((c) => c.id !== editing?.id && c.name.toLowerCase() === trimmedName.toLowerCase())
          ? `A saved connection named “${trimmedName}” already exists.`
          : null;

  const secretOk = !!secret.trim() || keepsSecret;
  const canSubmit = !busy && (mode === "profile" ? !!profile : !!accessKeyId.trim() && secretOk && !!region.trim());
  /** An empty name is only flagged once the field was touched; other name problems show at once. */
  const showNameError = !!nameError && (nameTouched || !!trimmedName);

  const clearErrors = () => {
    // Starting another connection (or leaving this view) cancels a running sign-in.
    stopSignIn();
    setShowDetails(false);
    setAttemptProfile(null);
    retryRef.current = null;
    setError(null);
    setErrorText(null);
    setSaveError(null);
  };

  const fillFromLastUsed = () => {
    setMode(lastUsed.mode);
    setProfile(lastUsed.profile || profiles?.find((p) => p.hasCredentials)?.name || "");
    setProfileRegion(lastUsed.profileRegion);
    setProfileEndpoint(lastUsed.profileEndpoint);
    setShowAdvanced(!!(lastUsed.profileRegion || lastUsed.profileEndpoint));
    setAccessKeyId(lastUsed.accessKeyId);
    setRegion(lastUsed.region);
    setEndpoint(lastUsed.endpoint);
    setForcePathStyle(lastUsed.forcePathStyle);
    setSecret("");
    setSessionToken("");
  };

  const focusFirstField = () => requestAnimationFrame(() => cardRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus());

  const openNew = () => {
    clearErrors();
    setEditing(null);
    setEditNotice(null);
    setSaveChecked(true);
    setName("");
    setNameTouched(false);
    fillFromLastUsed();
    setView("form");
    focusFirstField();
  };

  const openEdit = (c: SavedConnection, notice: string | null = null) => {
    clearErrors();
    setMenuFor(null);
    setEditing(c);
    setEditNotice(notice);
    setName(c.name);
    setNameTouched(false);
    setMode(c.kind);
    if (c.kind === "profile") {
      setProfile(c.profile ?? "");
      setProfileRegion(c.region ?? "");
      setProfileEndpoint(c.endpoint ?? "");
      setShowAdvanced(!!(c.region || c.endpoint));
    } else {
      setAccessKeyId(c.accessKeyId ?? "");
      setRegion(c.region ?? "");
      setEndpoint(c.endpoint ?? "");
      setForcePathStyle(c.forcePathStyle);
    }
    setSecret("");
    setShowSecret(false);
    setSessionToken("");
    setView("form");
    requestAnimationFrame(() => (notice ? secretRef.current : nameRef.current)?.focus());
  };

  const backToSaved = () => {
    clearErrors();
    setEditing(null);
    setEditNotice(null);
    fillFromLastUsed();
    setView(hasSaved ? "saved" : "form");
  };

  const buildConfig = (): ConnectionConfig =>
    mode === "profile"
      ? { kind: "profile", profile, region: profileRegion.trim() || null, endpoint: profileEndpoint.trim() || null }
      : {
          kind: "static",
          accessKeyId: accessKeyId.trim(),
          secretAccessKey: secret.trim(),
          sessionToken: wantsSave ? null : sessionToken.trim() || null,
          region: region.trim(),
          endpoint: endpoint.trim() || null,
          forcePathStyle: endpoint.trim() ? forcePathStyle : undefined,
        };

  /** Connect through `connect_saved` (updates lastUsedAt). Opens Edit when the secret is missing. */
  const connectSaved = async (c: SavedConnection, fromForm: boolean) => {
    clearErrors();
    if (fromForm) setConnecting(true);
    else setBusyId(c.id);
    try {
      const info = await api.connectSaved(c.id);
      setConnected(info, c.id);
    } catch (e) {
      const err = e as AppError;
      setConnecting(false);
      setBusyId(null);
      const list = await loadSaved();
      const fresh = list.find((x) => x.id === c.id) ?? c;
      if (isMissingSecret(err, fresh)) {
        openEdit(fresh, `The secret key for “${fresh.name}” isn't in the keychain any more. Enter it again to connect.`);
        return;
      }
      setError(err);
      setErrorText(describeError(err, "connect"));
      setAttemptProfile(fresh.kind === "profile" ? (fresh.profile ?? null) : null);
      retryRef.current = () => void connectSaved(fresh, fromForm);
      if (fromForm) setEditing(fresh);
    }
  };

  /** `again`: retry exactly this configuration (after Sign in again). */
  const connectWithoutSaving = async (again?: ConnectionConfig) => {
    const config = again ?? buildConfig();
    setConnecting(true);
    clearErrors();
    try {
      const info = await api.connect(config);
      const toRemember: LastUsed = {
        mode,
        profile,
        profileRegion: profileRegion.trim(),
        profileEndpoint: profileEndpoint.trim(),
        accessKeyId: accessKeyId.trim(),
        region: region.trim(),
        endpoint: endpoint.trim(),
        forcePathStyle,
      };
      writePref(PREF_KEY, toRemember);
      setConnected(info, null, connectionIdentity(config, info));
    } catch (err) {
      setError(err as AppError);
      setErrorText((err as AppError).message);
      setAttemptProfile(config.kind === "profile" ? config.profile : null);
      retryRef.current = () => void connectWithoutSaving(config);
      setConnecting(false);
    }
  };

  const run = async (connectAfter: boolean) => {
    setNameTouched(true);
    if (!canSubmit) return;
    if (wantsSave && nameError) {
      nameRef.current?.focus();
      return;
    }
    if (!wantsSave) {
      await connectWithoutSaving();
      return;
    }
    clearErrors();
    setConnecting(true);
    let stored: SavedConnection;
    try {
      // On update an empty secret keeps the stored one.
      stored = await api.saveConnection({ id: editing?.id ?? null, name: trimmedName, config: buildConfig() });
    } catch (e) {
      // Nothing was saved; never fall back to connecting silently.
      setSaveError(e as AppError);
      setConnecting(false);
      return;
    }
    setSaved((cur) => [...(cur ?? []).filter((c) => c.id !== stored.id), stored]);
    // From here on this form edits the stored connection, so retrying never creates a duplicate.
    setEditing(stored);
    setSaveChecked(false);
    setSecret("");
    if (!connectAfter) {
      setConnecting(false);
      toast.success(`Saved “${stored.name}”`);
      await loadSaved();
      setEditing(null);
      setEditNotice(null);
      fillFromLastUsed();
      setView("saved");
      return;
    }
    await connectSaved(stored, true);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(true);
  };

  // ---- render ----

  const header = (
    <div className="connect-head">
      <Logo size={40} />
      <div>
        <h1>S3 Explorer</h1>
        <p className="muted">Connect to Amazon S3 or any S3-compatible storage.</p>
      </div>
    </div>
  );
  // v0.9.0: the app was started with a location (command line); it opens once connected.
  const launchNote = launch && (
    <div className="callout info launch-note" role="status">
      <MapPin size={14} />
      <span>
        Connect to open <span className="mono">{launchLabel(launch)}</span>
      </span>
    </div>
  );

  const expired = parseExpired(error);
  const signInLines = signIn?.lines ?? [];
  const signInNote = signIn && signInOutcome(signIn);
  const errorBox = expired ? (
    <div className="form-error signin-error" role="alert">
      <AlertCircle size={15} />
      <div className="form-error-body">
        <span className="signin-headline">{withCode(expired.headline)}</span>
        {expired.details && (
          <>
            <button
              type="button"
              className="link-btn signin-details-toggle"
              aria-expanded={showDetails}
              aria-controls="signin-details"
              onClick={() => setShowDetails((v) => !v)}
            >
              <ChevronRight size={12} className={showDetails ? "rot90" : ""} />
              {showDetails ? "Hide details" : "Show details"}
            </button>
            {showDetails && (
              <p id="signin-details" className="signin-details">
                {expired.details}
              </p>
            )}
          </>
        )}
        {signInLines.length > 0 && (
          <pre className="signin-log" aria-label="AWS CLI output" aria-live="polite">
            {signInLines.join("\n")}
          </pre>
        )}
        {signInNote && <strong className="signin-outcome">{signInNote}</strong>}
        {attemptProfile && (
          <div className="signin-actions">
            {signingIn ? (
              <>
                <button type="button" className="btn signin-cancel" onClick={cancelSignIn}>
                  Cancel
                </button>
                <span className="signin-wait">
                  <Loader2 size={13} className="spin" /> Finish signing in in your browser…
                </span>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-primary signin-btn"
                onClick={() => void startSignIn(attemptProfile, expired.kind)}
                disabled={connecting || busyId !== null}
              >
                <LogIn size={14} /> Sign in again
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  ) : (error || savedError) && (
    <div className="form-error" role="alert">
      <AlertCircle size={15} />
      <span>{errorText ?? error?.message ?? `Couldn't load saved connections: ${savedError?.message}`}</span>
    </div>
  );

  if (view === "loading") {
    return (
      <div className="connect-screen">

        <TransferBackdrop />
        <div className="screen-corner">
          <UpdatePill />
          <ThemeToggle />
          <SettingsButton />
        </div>
        <div className="connect-card" aria-busy="true">
          {header}
          {launchNote}
          <div className="profile-list">
            {[0, 1, 2].map((i) => (
              <div key={i} className="profile-row skeleton" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (view === "saved") {
    return (
      <div className="connect-screen">

        <TransferBackdrop />
        <div className="screen-corner">
          <UpdatePill />
          <ThemeToggle />
          <SettingsButton />
        </div>
        <div className="connect-home">
          <div className="brand">S3 Explorer</div>
          <div className="home-title">
            <h1>Welcome back</h1>
            <p className="muted">Choose a connection to open your storage.</p>
          </div>
          <ul ref={listRef} className="saved-list" aria-label="Saved connections" onClickCapture={reorder.onClickCapture}>
            {tiles.map((c) => (
              <SavedRow
                key={c.id}
                conn={c}
                busy={busyId === c.id}
                disabled={busy}
                dragging={reorder.draggingId === c.id}
                onDragStart={(e) => reorder.onPointerDown(e, c.id)}
                menuOpen={menuFor === c.id}
                onConnect={() => void connectSaved(c, false)}
                onToggleMenu={(open) => setMenuFor(open ? c.id : null)}
                onEdit={() => openEdit(c)}
                onDelete={() => {
                  setMenuFor(null);
                  setDeleting(c);
                }}
              />
            ))}
            <li className="saved-row saved-new">
              <button type="button" className="saved-main" onClick={openNew} disabled={busy}>
                <span className="saved-icon" aria-hidden="true">
                  <Plus size={20} />
                </span>
                <span className="saved-name">New connection</span>
              </button>
            </li>
          </ul>
          <p className="hint">
            <LockKeyhole size={12} /> {KEYCHAIN_LINE}
          </p>
          {errorBox}
        </div>
        {deleting && (
          <DeleteSavedModal
            conn={deleting}
            onClose={() => setDeleting(null)}
            onDeleted={() => {
              setDeleting(null);
              void loadSaved().then((list) => {
                if (!list.length) openNew();
              });
            }}
          />
        )}
      </div>
    );
  }

  const nameField = (
    <label className="field">
      <span className="field-label">Name</span>
      <input
        ref={nameRef}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setSaveError(null);
        }}
        onBlur={() => setNameTouched(true)}
        maxLength={SAVED_CONNECTION_NAME_MAX}
        placeholder={editing ? "e.g. Production" : suggestName()}
        spellCheck={false}
        aria-invalid={showNameError || saveError?.code === "InvalidInput"}
        aria-describedby="save-name-msg"
      />
    </label>
  );

  const nameMessage =
    saveError && saveError.code === "InvalidInput" ? (
      <p id="save-name-msg" className="hint err-text" role="alert">
        {saveError.message}
      </p>
    ) : showNameError ? (
      <p id="save-name-msg" className="hint err-text">
        {nameError}
      </p>
    ) : (
      <p id="save-name-msg" className="hint">
        {mode === "static" ? (
          <>
            <LockKeyhole size={12} /> {KEYCHAIN_LINE}
          </>
        ) : (
          "Saves the profile name, region and endpoint. Credentials stay in ~/.aws."
        )}
      </p>
    );

  return (
    <div className="connect-screen">

      <TransferBackdrop />
      <div className="screen-corner">
        <UpdatePill />
        <ThemeToggle />
        <SettingsButton />
      </div>
      <form ref={cardRef} className="connect-card" onSubmit={submit} noValidate>
        {header}
        {launchNote}

        {(hasSaved || editing) && (
          <div className="form-nav">
            <button type="button" className="btn" onClick={backToSaved} disabled={busy}>
              <ArrowLeft size={14} /> Back
            </button>
            {editing && (
              <span className="form-nav-title">
                Editing <strong>{editing.name}</strong>
              </span>
            )}
          </div>
        )}

        {editNotice && (
          <div className="callout warn" role="alert">
            <AlertTriangle size={15} />
            <span>{editNotice}</span>
          </div>
        )}

        <div className="segmented" role="tablist" aria-label="Connection type">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "profile"}
            className={mode === "profile" ? "active" : ""}
            onClick={() => setMode("profile")}
            disabled={!!editing && editing.kind !== "profile"}
            data-autofocus={mode === "profile" ? "" : undefined}
          >
            <UserRound size={14} /> AWS profile
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "static"}
            className={mode === "static" ? "active" : ""}
            onClick={() => setMode("static")}
            disabled={!!editing && editing.kind !== "static"}
            data-autofocus={mode === "static" ? "" : undefined}
          >
            <KeyRound size={14} /> Access keys
          </button>
        </div>

        {mode === "profile" ? (
          <div className="connect-body">
            <div className="field-label-row">
              <span className="field-label">Profiles from ~/.aws</span>
              <button type="button" className="link-btn" onClick={() => void loadProfiles()}>
                <RefreshCw size={12} /> Reload
              </button>
            </div>
            <div className="profile-list" role="radiogroup" aria-label="AWS profiles">
              {profiles === null && [0, 1, 2].map((i) => <div key={i} className="profile-row skeleton" />)}
              {profiles?.length === 0 && (
                <div className="empty-note">
                  {profilesError ? profilesError.message : "No profiles found. Use access keys instead."}
                </div>
              )}
              {profiles?.map((p) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={profile === p.name}
                  key={p.name}
                  disabled={!p.hasCredentials}
                  className={`profile-row ${profile === p.name ? "selected" : ""}`}
                  onClick={() => setProfile(p.name)}
                  onDoubleClick={(e) => {
                    setProfile(p.name);
                    (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
                  }}
                  title={p.hasCredentials ? undefined : "No credentials found for this profile"}
                >
                  <span className="radio-dot" />
                  <span className="profile-name">{p.name}</span>
                  {!p.hasCredentials && <span className="profile-note">no credentials</span>}
                  <span className="region-chip">{p.region ?? "default region"}</span>
                </button>
              ))}
            </div>

            <button type="button" className="disclosure" onClick={() => setShowAdvanced((v) => !v)} aria-expanded={showAdvanced}>
              <ChevronRight size={14} className={showAdvanced ? "rot90" : ""} /> Advanced
            </button>
            {showAdvanced && (
              <div className="grid-2">
                <label className="field">
                  <span className="field-label">Region override</span>
                  <input value={profileRegion} onChange={(e) => setProfileRegion(e.target.value)} placeholder="from profile" spellCheck={false} />
                </label>
                <label className="field">
                  <span className="field-label">Custom endpoint</span>
                  <input value={profileEndpoint} onChange={(e) => setProfileEndpoint(e.target.value)} placeholder="https://…" spellCheck={false} />
                </label>
              </div>
            )}
          </div>
        ) : (
          <div className="connect-body">
            <label className="field">
              <span className="field-label">Access key ID</span>
              <input
                value={accessKeyId}
                onChange={(e) => setAccessKeyId(e.target.value)}
                placeholder="AKIA…"
                autoComplete="off"
                spellCheck={false}
                className="mono"
              />
            </label>
            <label className="field">
              <span className="field-label">Secret access key</span>
              <div className="input-affix">
                <input
                  ref={secretRef}
                  type={showSecret ? "text" : "password"}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={keepsSecret ? "Leave blank to keep the saved secret" : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  className="mono"
                />
                <button type="button" className="icon-btn" onClick={() => setShowSecret((v) => !v)} aria-label={showSecret ? "Hide secret" : "Show secret"}>
                  {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </label>
            {!editing && (
              <label className="field">
                <span className="field-label">
                  Session token <span className="optional">optional</span>
                </span>
                <input value={sessionToken} onChange={(e) => setSessionToken(e.target.value)} autoComplete="off" spellCheck={false} className="mono" />
              </label>
            )}
            <div className="grid-2">
              <label className="field">
                <span className="field-label">Region</span>
                <input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-east-1" spellCheck={false} />
              </label>
              <label className="field">
                <span className="field-label">
                  Endpoint <span className="optional">MinIO, R2…</span>
                </span>
                <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://…" spellCheck={false} />
              </label>
            </div>
            <label className={`check ${endpoint.trim() ? "" : "disabled"}`}>
              <input
                type="checkbox"
                checked={forcePathStyle}
                disabled={!endpoint.trim()}
                onChange={(e) => setForcePathStyle(e.target.checked)}
              />
              <Server size={13} />
              Force path-style addressing
            </label>
          </div>
        )}

        <div className="save-box">
          {editing ? (
            <>
              {nameField}
              {nameMessage}
            </>
          ) : (
            <>
              <label className={`check ${tokenEntered ? "disabled" : ""}`}>
                <input
                  type="checkbox"
                  checked={saveChecked && !tokenEntered}
                  disabled={tokenEntered}
                  aria-describedby={tokenEntered ? "save-token-note" : undefined}
                  onChange={(e) => {
                    setSaveChecked(e.target.checked);
                    setSaveError(null);
                    if (e.target.checked) {
                      if (!name.trim()) setName(suggestName());
                      requestAnimationFrame(() => nameRef.current?.select());
                    }
                  }}
                />
                Save this connection
              </label>
              {tokenEntered ? (
                <p id="save-token-note" className="hint">
                  Temporary credentials with a session token can't be saved.
                </p>
              ) : saveChecked ? (
                <>
                  {nameField}
                  {nameMessage}
                </>
              ) : mode === "static" ? (
                <p className="hint">Secrets stay in memory unless you save the connection.</p>
              ) : null}
            </>
          )}
        </div>

        {saveError && saveError.code !== "InvalidInput" && (
          <div className="form-error" role="alert">
            <AlertCircle size={15} />
            <div className="form-error-body">
              <span>
                <strong>The connection was not saved.</strong> {describeError(saveError, "save")}
              </span>
              {!editing && (
                <button type="button" className="btn" onClick={() => void connectWithoutSaving()} disabled={busy}>
                  Connect without saving
                </button>
              )}
            </div>
          </div>
        )}
        {errorBox}

        {editing ? (
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => void run(false)} disabled={!canSubmit}>
              Save
            </button>
            <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
              {connecting ? <Loader2 size={15} className="spin" /> : null}
              {connecting ? "Connecting…" : "Save and connect"}
            </button>
          </div>
        ) : (
          <button type="submit" className="btn btn-primary btn-block" disabled={!canSubmit}>
            {connecting ? <Loader2 size={15} className="spin" /> : null}
            {connecting ? "Connecting…" : wantsSave ? "Save and connect" : "Connect"}
          </button>
        )}
      </form>
    </div>
  );
}
