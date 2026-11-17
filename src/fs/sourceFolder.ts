/** "Allow folder access" for a single opened video: locate the folder that contains it. */
import { errorMessage, fsGlobal, isAbortError, isNotFoundError } from './fsApi';
import { handleDir, type DirRef, type HandleDirRef } from './types';
import { queryPermission } from './write';

export type SourceFolderFailure = 'unsupported' | 'cancelled' | 'not_containing' | 'error';

export type SourceFolderResult =
  | {
      ok: true;
      /** The video's direct parent directory (treated as its own root: `path` is empty). */
      dir: HandleDirRef;
      /** Directories from the chosen folder down to the parent; empty when the parent was chosen. */
      walked: string[];
      /** Whether `readwrite` permission is granted (exports beside the video possible). */
      writable: boolean;
    }
  | { ok: false; reason: SourceFolderFailure; message?: string };

/** `isSameEntry` with a feature check; false when unsupported. */
export async function sameEntry(a: FileSystemHandle, b: FileSystemHandle): Promise<boolean> {
  if (a.kind !== b.kind || typeof a.isSameEntry !== 'function') return false;
  try {
    return await a.isSameEntry(b);
  } catch {
    return false;
  }
}

/** Looks up a direct child file by name. Returns a handle (real dirs) or a File (virtual dirs). */
export async function findFileInDir(dir: DirRef, name: string): Promise<FileSystemFileHandle | File | null> {
  if (dir.kind === 'virtual') return dir.node.files.get(name) ?? null;
  try {
    return await dir.handle.getFileHandle(name);
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

/** Walks from `root` down through `segments` (directory names). */
export async function descend(root: FileSystemDirectoryHandle, segments: readonly string[]): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const seg of segments) dir = await dir.getDirectoryHandle(seg);
  return dir;
}

async function locateParent(chosen: FileSystemDirectoryHandle, fileHandle: FileSystemFileHandle): Promise<SourceFolderResult> {
  const path = await chosen.resolve(fileHandle);
  if (path === null || path.length === 0) return { ok: false, reason: 'not_containing' };
  const walked = path.slice(0, -1);
  const parent = await descend(chosen, walked);
  const found = await findFileInDir(handleDir(parent), fileHandle.name);
  if (!found || found instanceof File || !(await sameEntry(found, fileHandle))) {
    return { ok: false, reason: 'not_containing' };
  }
  const writable = (await queryPermission(parent, 'readwrite')) === 'granted';
  return { ok: true, dir: handleDir(parent), walked, writable };
}

/**
 * Asks the user for the folder containing `fileHandle` (the picker starts there). Accepts the
 * parent itself or any ancestor; for an ancestor, walks down to the direct parent. Must be called
 * from a user gesture.
 */
export async function requestSourceFolder(fileHandle: FileSystemFileHandle): Promise<SourceFolderResult> {
  const g = fsGlobal();
  if (typeof g.showDirectoryPicker !== 'function') return { ok: false, reason: 'unsupported' };
  let chosen: FileSystemDirectoryHandle;
  try {
    chosen = await g.showDirectoryPicker({ startIn: fileHandle, mode: 'readwrite', id: 'videos' });
  } catch (err) {
    if (isAbortError(err)) return { ok: false, reason: 'cancelled' };
    return { ok: false, reason: 'error', message: errorMessage(err) };
  }
  try {
    return await locateParent(chosen, fileHandle);
  } catch (err) {
    return { ok: false, reason: 'error', message: errorMessage(err) };
  }
}
