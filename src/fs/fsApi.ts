/**
 * Typings for the parts of the File System Access API (and related Chromium-only APIs) that the
 * project's TypeScript DOM lib does not declare, plus feature-detection helpers. Everything here is
 * optional: callers must feature-detect before use.
 */

export type PermissionMode = 'read' | 'readwrite';

export interface PermissionDescriptorFs {
  mode: PermissionMode;
}

/** Permission methods Chromium exposes on FileSystemHandle. */
export interface PermissionCapableHandle {
  queryPermission?(descriptor: PermissionDescriptorFs): Promise<PermissionState>;
  requestPermission?(descriptor: PermissionDescriptorFs): Promise<PermissionState>;
}

/** Directory iteration methods (DOM.AsyncIterable lib is not enabled in this project). */
export interface IterableDirectoryHandle {
  values?(): AsyncIterable<FileSystemHandle>;
  entries?(): AsyncIterable<[string, FileSystemHandle]>;
}

export interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

export interface OpenFilePickerOptions {
  types?: FilePickerAcceptType[];
  excludeAcceptAllOption?: boolean;
  multiple?: boolean;
  id?: string;
  startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
}

export interface DirectoryPickerOptions {
  id?: string;
  mode?: PermissionMode;
  startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
}

export interface FsAccessGlobal {
  showOpenFilePicker?(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
  showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
}

export interface DataTransferItemWithHandle {
  getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
}

export function fsGlobal(): FsAccessGlobal {
  return globalThis as FsAccessGlobal;
}

export function hasOpenFilePicker(): boolean {
  return typeof fsGlobal().showOpenFilePicker === 'function';
}

export function hasDirectoryPicker(): boolean {
  return typeof fsGlobal().showDirectoryPicker === 'function';
}

export function isFileHandle(h: FileSystemHandle): h is FileSystemFileHandle {
  return h.kind === 'file';
}

export function isDirectoryHandle(h: FileSystemHandle): h is FileSystemDirectoryHandle {
  return h.kind === 'directory';
}

/** Iterates a directory's children, using whichever iteration method the browser provides. */
export async function* iterateDirectory(dir: FileSystemDirectoryHandle): AsyncGenerator<FileSystemHandle> {
  const it = dir as FileSystemDirectoryHandle & IterableDirectoryHandle;
  if (typeof it.values === 'function') {
    yield* it.values();
    return;
  }
  if (typeof it.entries === 'function') {
    for await (const [, handle] of it.entries()) yield handle;
    return;
  }
  throw new DOMException('Directory iteration is not supported', 'NotSupportedError');
}

/** The `name` of a DOMException / Error, or '' for anything else. */
export function errorName(err: unknown): string {
  if (err instanceof Error) return err.name;
  if (typeof err === 'object' && err !== null && 'name' in err && typeof err.name === 'string') return err.name;
  return '';
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

export function isAbortError(err: unknown): boolean {
  return errorName(err) === 'AbortError';
}

export function isNotFoundError(err: unknown): boolean {
  const name = errorName(err);
  return name === 'NotFoundError' || name === 'TypeMismatchError';
}
