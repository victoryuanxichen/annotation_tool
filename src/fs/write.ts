/** Permission helpers, text writes into directories, and download fallback. */
import { errorMessage, errorName, isNotFoundError, type PermissionCapableHandle, type PermissionMode } from './fsApi';
import type { DirRef } from './types';

export type WriteFailureReason = 'permission_denied' | 'not_found' | 'no_space' | 'unsupported' | 'unknown';

export type WriteResult =
  | { ok: true }
  | { ok: false; reason: WriteFailureReason; message: string; /** DOMException name, when there was one. */ errorName?: string };

export interface PermissionOptions {
  /**
   * Whether to prompt when permission is not yet granted. Prompts only succeed during a user
   * gesture. Defaults to `navigator.userActivation.isActive` when available, else false.
   */
  request?: boolean;
}

/** Current permission state; handles without the permission API are assumed granted. */
export async function queryPermission(handle: FileSystemHandle, mode: PermissionMode): Promise<PermissionState> {
  const h = handle as FileSystemHandle & PermissionCapableHandle;
  if (typeof h.queryPermission !== 'function') return 'granted';
  try {
    return await h.queryPermission({ mode });
  } catch {
    return 'denied';
  }
}

function hasUserActivation(): boolean {
  const nav = (globalThis as { navigator?: { userActivation?: { isActive?: boolean } } }).navigator;
  return nav?.userActivation?.isActive === true;
}

/** Resolves true when `mode` access is granted, prompting first when allowed by `opts.request`. */
export async function ensurePermission(handle: FileSystemHandle, mode: PermissionMode, opts: PermissionOptions = {}): Promise<boolean> {
  const state = await queryPermission(handle, mode);
  if (state === 'granted') return true;
  const request = opts.request ?? hasUserActivation();
  const h = handle as FileSystemHandle & PermissionCapableHandle;
  if (!request || state === 'denied' || typeof h.requestPermission !== 'function') return false;
  try {
    return (await h.requestPermission({ mode })) === 'granted';
  } catch {
    // SecurityError when not triggered by a user gesture.
    return false;
  }
}

export function mapWriteError(err: unknown): Extract<WriteResult, { ok: false }> {
  const name = errorName(err);
  const message = errorMessage(err);
  const base = name ? { message, errorName: name } : { message };
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return { ok: false, reason: 'permission_denied', ...base };
    case 'NotFoundError':
      return { ok: false, reason: 'not_found', ...base };
    case 'QuotaExceededError':
      return { ok: false, reason: 'no_space', ...base };
    case 'NotSupportedError':
      return { ok: false, reason: 'unsupported', ...base };
    default:
      return { ok: false, reason: 'unknown', ...base };
  }
}

function isPlainFileName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !/[\\/]/.test(name);
}

/** True only when the lookup positively reports that no entry with this name exists. */
async function isMissing(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return false;
  } catch (err) {
    return errorName(err) === 'NotFoundError';
  }
}

async function writeWhole(file: FileSystemFileHandle, text: string): Promise<void> {
  // createWritable writes to a swap file that atomically replaces the target on close().
  const writable = await file.createWritable({ keepExistingData: false });
  try {
    await writable.write(text);
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => undefined);
    throw err;
  }
}

/**
 * Writes `text` (UTF-8) to `dir/name`, replacing any existing file. Never throws. Checks
 * `readwrite` permission first, prompting only when `opts.request` (or a live user gesture) allows.
 * If the file did not exist and the write fails, the empty file created for it is removed.
 */
export async function writeTextFile(dir: DirRef, name: string, text: string, opts: PermissionOptions = {}): Promise<WriteResult> {
  if (dir.kind !== 'handle') {
    return { ok: false, reason: 'unsupported', message: 'This folder was opened read-only; use download instead.' };
  }
  if (!isPlainFileName(name)) return { ok: false, reason: 'unknown', message: `Invalid file name: ${name}` };
  if (!(await ensurePermission(dir.handle, 'readwrite', opts))) {
    return { ok: false, reason: 'permission_denied', message: 'Write permission for this folder was not granted.' };
  }
  const wasMissing = await isMissing(dir.handle, name);
  let created = false;
  try {
    const file = await dir.handle.getFileHandle(name, { create: true });
    created = wasMissing;
    if (typeof file.createWritable !== 'function') {
      throw new DOMException('This browser cannot write files into folders.', 'NotSupportedError');
    }
    await writeWhole(file, text);
    return { ok: true };
  } catch (err) {
    if (created) await dir.handle.removeEntry(name).catch(() => undefined);
    return mapWriteError(err);
  }
}

/** Reads `dir/name` as text, or null when it does not exist. Other errors propagate. */
export async function readTextIfExists(dir: DirRef, name: string): Promise<string | null> {
  if (dir.kind === 'virtual') {
    const file = dir.node.files.get(name);
    return file ? file.text() : null;
  }
  try {
    const handle = await dir.handle.getFileHandle(name);
    return await (await handle.getFile()).text();
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

const REVOKE_DELAY_MS = 60_000;

/** Saves `text` through the browser's download mechanism. */
export function downloadText(name: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    // Revoking immediately can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}
