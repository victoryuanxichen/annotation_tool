/** Drag & drop of a video file or a folder onto the window. */
import type { DataTransferItemWithHandle } from './fsApi';
import { isDirectoryHandle, isFileHandle } from './fsApi';
import { isVideoName } from './names';
import { handleDir, type DirRef, type VideoSource } from './types';
import { fileFromEntry, isDirEntry, isFileEntry, virtualDirFromEntry } from './virtual';

export type DropResult =
  | { kind: 'file'; source: VideoSource }
  | { kind: 'folder'; root: DirRef }
  | { kind: 'unsupported'; reason: 'empty' | 'not_video' };

/** Everything that must be read from a DataTransfer synchronously, inside the drop event. */
interface CapturedItem {
  readonly handle: Promise<FileSystemHandle | null> | null;
  readonly entry: FileSystemEntry | null;
  readonly file: File | null;
}

type Resolved =
  | { kind: 'dir-handle'; handle: FileSystemDirectoryHandle }
  | { kind: 'dir-entry'; entry: FileSystemDirectoryEntry }
  | { kind: 'file-handle'; handle: FileSystemFileHandle }
  | { kind: 'file-entry'; entry: FileSystemFileEntry }
  | { kind: 'file'; file: File };

function captureItem(item: DataTransferItem): CapturedItem {
  const withHandle = item as DataTransferItem & DataTransferItemWithHandle;
  let handle: Promise<FileSystemHandle | null> | null = null;
  if (typeof withHandle.getAsFileSystemHandle === 'function') {
    handle = withHandle.getAsFileSystemHandle().catch(() => null);
  }
  const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
  return { handle, entry, file: item.getAsFile() };
}

/**
 * Reads the drop payload. Must run synchronously inside the `drop` handler: the DataTransfer is
 * emptied once the event returns, so all handle requests are started here before any await.
 */
export function captureDrop(dt: DataTransfer): CapturedItem[] {
  const items = Array.from(dt.items ?? []).filter((i) => i.kind === 'file');
  if (items.length > 0) return items.map(captureItem);
  return Array.from(dt.files ?? []).map((file) => ({ handle: null, entry: null, file }));
}

async function resolveItem(item: CapturedItem): Promise<Resolved | null> {
  const handle = item.handle ? await item.handle : null;
  if (handle && isDirectoryHandle(handle)) return { kind: 'dir-handle', handle };
  if (handle && isFileHandle(handle)) return { kind: 'file-handle', handle };
  if (item.entry && isDirEntry(item.entry)) return { kind: 'dir-entry', entry: item.entry };
  if (item.entry && isFileEntry(item.entry)) return { kind: 'file-entry', entry: item.entry };
  return item.file ? { kind: 'file', file: item.file } : null;
}

function resolvedName(r: Resolved): string {
  return r.kind === 'file' ? r.file.name : r.kind === 'dir-handle' || r.kind === 'file-handle' ? r.handle.name : r.entry.name;
}

async function toSource(r: Resolved): Promise<VideoSource> {
  let fileHandle: FileSystemFileHandle | null = null;
  let file: File;
  if (r.kind === 'file-handle') {
    fileHandle = r.handle;
    file = await r.handle.getFile();
  } else if (r.kind === 'file-entry') {
    file = await fileFromEntry(r.entry);
  } else if (r.kind === 'file') {
    file = r.file;
  } else {
    throw new TypeError('Not a file');
  }
  return { name: file.name, fileHandle, file, parent: null, relPath: null };
}

/**
 * Resolves captured items: the first dropped folder wins; otherwise the first video file. Multiple
 * dropped files are not combined into a batch.
 */
export async function resolveDrop(items: readonly CapturedItem[], signal?: AbortSignal): Promise<DropResult> {
  const resolved = (await Promise.all(items.map(resolveItem))).filter((r): r is Resolved => r !== null);
  if (resolved.length === 0) return { kind: 'unsupported', reason: 'empty' };
  const dir = resolved.find((r) => r.kind === 'dir-handle' || r.kind === 'dir-entry');
  if (dir?.kind === 'dir-handle') return { kind: 'folder', root: handleDir(dir.handle) };
  if (dir?.kind === 'dir-entry') return { kind: 'folder', root: await virtualDirFromEntry(dir.entry, signal) };
  const video = resolved.find((r) => isVideoName(resolvedName(r)));
  if (!video) return { kind: 'unsupported', reason: 'not_video' };
  return { kind: 'file', source: await toSource(video) };
}

/** Convenience for a `drop` listener: captures synchronously, then resolves. */
export function handleDrop(dt: DataTransfer, signal?: AbortSignal): Promise<DropResult> {
  return resolveDrop(captureDrop(dt), signal);
}

export type { CapturedItem };
