// Pure helpers for transfer settings: validation and the part-size math described in
// "Settings" in docs/CONTRACT.md. Shared by the settings UI and the browser mock.

import {
  AUTO_PART_SIZE_MIB,
  MIN_UPLOAD_PART_MIB,
  ACCENT_COLORS,
  TEXT_SETTINGS_LIMITS,
  TRANSFER_SETTINGS_LIMITS,
  FILE_MANAGER_COMMAND_MAX,
  type AppSettings,
  type TransferKind,
  type TransferSettings, DOWNLOAD_BUFFER_CAP_MIB } from "./types";

export const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;
/** S3 limit on the number of parts in one multipart upload. */
const MAX_UPLOAD_PARTS = 10_000;

export type SettingsField = keyof TransferSettings;

/** Validation message for one integer field, or null when it is valid. */
export function validateInteger(field: SettingsField, value: unknown): string | null {
  const { min, max } = TRANSFER_SETTINGS_LIMITS[field];
  if (value === null || value === undefined || value === "") return "Enter a value.";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "Enter a number.";
  if (!Number.isInteger(n)) return "Must be a whole number.";
  if (n < min) return `Minimum is ${min}.`;
  if (n > max) return `Maximum is ${max}.`;
  return null;
}

/** First problem with a full settings object, naming the field; null when valid. */
export function validateSettings(s: TransferSettings): { field: SettingsField; message: string } | null {
  const fields: SettingsField[] = ["partSizeMib", "maxConcurrentParts", "maxConcurrentTransfers"];
  for (const field of fields) {
    if (field === "partSizeMib" && s.partSizeMib === null) continue;
    const v: unknown = s[field];
    const err = typeof v === "number" ? validateInteger(field, v) : "Must be a whole number.";
    if (err) return { field, message: err };
  }
  return null;
}

export const sameSettings = (a: TransferSettings, b: TransferSettings) =>
  a.partSizeMib === b.partSizeMib &&
  a.maxConcurrentParts === b.maxConcurrentParts &&
  a.maxConcurrentTransfers === b.maxConcurrentTransfers;

/** Download part size in bytes for an object of `size` bytes. */
export function downloadPartBytes(partSizeMib: number | null, size: number): number {
  if (partSizeMib !== null) return partSizeMib * MIB;
  return (size > GIB ? AUTO_PART_SIZE_MIB.large : AUTO_PART_SIZE_MIB.standard) * MIB;
}

/**
 * Upload part size in bytes, mirroring `upload_part_size` in src-tauri/src/transfers/plan.rs:
 * `max(setting, 5 MiB)` (Auto: 8 MiB at every size; the 16 MiB step is download-only), doubled
 * until the file fits in 10,000 parts.
 */
export function uploadPartBytes(partSizeMib: number | null, size: number): number {
  let part =
    partSizeMib === null ? AUTO_PART_SIZE_MIB.standard * MIB : Math.max(partSizeMib * MIB, MIN_UPLOAD_PART_MIB * MIB);
  while (Math.ceil(size / part) > MAX_UPLOAD_PARTS) part *= 2;
  return part;
}

/** Part size (bytes) and part count a transfer of `size` bytes uses. */
export function planParts(kind: TransferKind, partSizeMib: number | null, size: number) {
  const partBytes = kind === "upload" ? uploadPartBytes(partSizeMib, size) : downloadPartBytes(partSizeMib, size);
  return { partBytes, parts: size > partBytes ? Math.ceil(size / partBytes) : 1 };
}

/**
 * Worst-case memory held per in-flight download part, in MiB. Parts up to the buffer cap are held
 * whole; larger parts are streamed to disk, so memory stops growing with part size.
 */
export const worstCasePartMib = (partSizeMib: number | null) =>
  Math.min(partSizeMib ?? AUTO_PART_SIZE_MIB.large, DOWNLOAD_BUFFER_CAP_MIB);

/** Full settings comparison (every field). */
export const sameAppSettings = (a: AppSettings, b: AppSettings) =>
  sameSettings(a, b) &&
  a.theme === b.theme &&
  a.checkUpdatesOnStartup === b.checkUpdatesOnStartup &&
  a.notifyOnFinish === b.notifyOnFinish &&
  a.textSize === b.textSize &&
  a.textWeight === b.textWeight &&
  a.accent === b.accent &&
  a.confirmCopyMove === b.confirmCopyMove &&
  (a.fileManagerCommand ?? null) === (b.fileManagerCommand ?? null);

/** The file-manager command as the backend stores it: trimmed, empty becomes null. */
export function normalizeFileManagerCommand(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
}

/** Validation message for a (normalized) file-manager command, or null when it is acceptable. */
/** Control characters are C0, DEL and C1, as Rust's `char::is_control`. */
export function validateFileManagerCommand(v: string | null): string | null {
  if (v === null) return null;
  if (typeof v !== "string") return "Must be text.";
  if ([...v].length > FILE_MANAGER_COMMAND_MAX) return `At most ${FILE_MANAGER_COMMAND_MAX.toLocaleString("en-US")} characters.`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(v)) return "Must be one line, without control characters.";
  return null;
}

/** Like `validateSettings`, checking every field of the settings object. */
export function validateAppSettings(s: AppSettings): { field: keyof AppSettings; message: string } | null {
  const transfer = validateSettings(s);
  if (transfer) return transfer;
  if (s.theme !== "system" && s.theme !== "light" && s.theme !== "dark") {
    return { field: "theme", message: "Must be one of system, light, dark." };
  }
  if (typeof s.checkUpdatesOnStartup !== "boolean") return { field: "checkUpdatesOnStartup", message: "Must be true or false." };
  if (typeof s.notifyOnFinish !== "boolean") return { field: "notifyOnFinish", message: "Must be true or false." };
  for (const field of ["textSize", "textWeight"] as const) {
    const { min, max } = TEXT_SETTINGS_LIMITS[field];
    if (!Number.isInteger(s[field]) || s[field] < min || s[field] > max) {
      return { field, message: `Must be a whole number from ${min} to ${max}.` };
    }
  }
  if (!ACCENT_COLORS.includes(s.accent)) return { field: "accent", message: `Must be one of ${ACCENT_COLORS.join(", ")}.` };
  if (typeof s.confirmCopyMove !== "boolean") return { field: "confirmCopyMove", message: "Must be true or false." };
  const fm = validateFileManagerCommand(s.fileManagerCommand ?? null);
  if (fm) return { field: "fileManagerCommand", message: fm };
  return null;
}
