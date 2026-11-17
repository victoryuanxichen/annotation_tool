/**
 * User-facing pickers. Uses the File System Access API where available (Chromium) and falls back
 * to hidden `<input type=file>` elements elsewhere. All pickers resolve null when cancelled.
 */
import { errorName, fsGlobal, hasDirectoryPicker, hasOpenFilePicker, isAbortError, type FilePickerAcceptType } from './fsApi';
import { handleDir, type DirRef, type HandleDirRef, type VideoSource } from './types';
import { virtualDirFromFiles } from './virtual';

const VIDEO_ACCEPT = '.mp4,.m4v,video/mp4';
const ANNOTATION_ACCEPT = '.csv,.json,text/csv,application/json';

const VIDEO_TYPES: FilePickerAcceptType[] = [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4', '.m4v'] } }];
const ANNOTATION_TYPES: FilePickerAcceptType[] = [
  { description: 'Annotations (CSV or JSON)', accept: { 'text/csv': ['.csv'], 'application/json': ['.json'] } },
];

/** True when both file and directory pickers of the File System Access API exist. */
export function supportsFileSystemAccess(): boolean {
  return hasOpenFilePicker() && hasDirectoryPicker();
}

interface InputOptions {
  accept?: string;
  directory?: boolean;
}

/** Delay after the window regains focus before treating a silent file dialog as cancelled. */
const FOCUS_CANCEL_DELAY_MS = 1000;

/**
 * Opens a hidden file input and resolves with the chosen files, or null when cancelled. Browsers
 * that fire the input `cancel` event use it; others fall back to a delayed window-focus check.
 */
export function pickWithInput(opts: InputOptions): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';
    if (opts.accept) input.accept = opts.accept;
    if (opts.directory) input.webkitdirectory = true;
    let done = false;
    const finish = (files: File[] | null): void => {
      if (done) return;
      done = true;
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(files && files.length > 0 ? files : null);
    };
    const onFocus = (): void => {
      setTimeout(() => finish(input.files ? Array.from(input.files) : null), FOCUS_CANCEL_DELAY_MS);
    };
    input.addEventListener('change', () => finish(input.files ? Array.from(input.files) : null));
    if ('oncancel' in input) input.addEventListener('cancel', () => finish(null));
    else window.addEventListener('focus', onFocus, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

/** SecurityError means the API exists but is blocked here (e.g. cross-origin iframe): use inputs. */
function shouldFallBack(err: unknown): boolean {
  return errorName(err) === 'SecurityError';
}

async function openOneFile(types: FilePickerAcceptType[], id: string): Promise<FileSystemFileHandle | null | 'fallback'> {
  const g = fsGlobal();
  if (typeof g.showOpenFilePicker !== 'function') return 'fallback';
  try {
    const [handle] = await g.showOpenFilePicker({ types, multiple: false, id });
    return handle ?? null;
  } catch (err) {
    if (isAbortError(err)) return null;
    if (shouldFallBack(err)) return 'fallback';
    throw err;
  }
}

export async function pickVideoFile(): Promise<VideoSource | null> {
  const handle = await openOneFile(VIDEO_TYPES, 'videos');
  if (handle === 'fallback') {
    const files = await pickWithInput({ accept: VIDEO_ACCEPT });
    const file = files?.[0];
    return file ? { name: file.name, fileHandle: null, file, parent: null, relPath: null } : null;
  }
  if (handle === null) return null;
  const file = await handle.getFile();
  return { name: file.name, fileHandle: handle, file, parent: null, relPath: null };
}

/** Manual annotation import (CSV or JSON). */
export async function pickAnnotationFile(): Promise<File | null> {
  const handle = await openOneFile(ANNOTATION_TYPES, 'annotations');
  if (handle === 'fallback') return (await pickWithInput({ accept: ANNOTATION_ACCEPT }))?.[0] ?? null;
  return handle ? handle.getFile() : null;
}

async function pickDirectoryHandle(id: string): Promise<FileSystemDirectoryHandle | null | 'fallback'> {
  const g = fsGlobal();
  if (typeof g.showDirectoryPicker !== 'function') return 'fallback';
  try {
    return await g.showDirectoryPicker({ mode: 'readwrite', id });
  } catch (err) {
    if (isAbortError(err)) return null;
    if (shouldFallBack(err)) return 'fallback';
    throw err;
  }
}

/**
 * Picks a video folder: a writable handle on Chromium, otherwise a read-only virtual folder built
 * from `<input webkitdirectory>` (exports then go to downloads).
 */
export async function pickFolder(): Promise<DirRef | null> {
  const handle = await pickDirectoryHandle('videos');
  if (handle === 'fallback') {
    const files = await pickWithInput({ directory: true });
    return files ? virtualDirFromFiles(files) : null;
  }
  return handle ? handleDir(handle) : null;
}

/**
 * Picks a destination folder for exports. Resolves null when cancelled or when the browser cannot
 * write into folders (check `supportsFileSystemAccess()` to tell these apart up front).
 */
export async function pickExportFolder(): Promise<HandleDirRef | null> {
  const handle = await pickDirectoryHandle('exports');
  return handle && handle !== 'fallback' ? handleDir(handle) : null;
}
