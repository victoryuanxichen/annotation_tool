/**
 * File-system abstractions shared by pickers, scanning, drag & drop and writing.
 *
 * A `DirRef` is either a real directory handle (File System Access API, Chromium) or a read-only
 * virtual directory assembled from a `File` list (`<input webkitdirectory>` or the legacy
 * `webkitGetAsEntry` drag & drop API).
 */

/** In-memory directory tree used when no directory handle is available. */
export interface VirtualDirNode {
  readonly name: string;
  readonly files: Map<string, File>;
  readonly dirs: Map<string, VirtualDirNode>;
}

interface DirRefCommon {
  readonly name: string;
  /** Path segments from the scan root to this directory (empty for the root itself). */
  readonly path: readonly string[];
  /**
   * Whether files can in principle be written into this directory. True for handle-backed
   * directories (permission may still need to be granted), false for virtual directories.
   */
  canWrite(): boolean;
}

export interface HandleDirRef extends DirRefCommon {
  readonly kind: 'handle';
  readonly handle: FileSystemDirectoryHandle;
}

export interface VirtualDirRef extends DirRefCommon {
  readonly kind: 'virtual';
  readonly node: VirtualDirNode;
}

export type DirRef = HandleDirRef | VirtualDirRef;

/** A video chosen by the user (picker, drop or batch entry), ready to be opened. */
export interface VideoSource {
  readonly name: string;
  /** Present when the browser provided a handle (allows `requestSourceFolder`). */
  readonly fileHandle: FileSystemFileHandle | null;
  readonly file: File;
  /** Directory containing the video, when known. */
  readonly parent: DirRef | null;
  /** Path relative to the opened folder, when the video came from a folder scan. */
  readonly relPath: string | null;
}

export type SidecarFormat = 'csv' | 'json';

export interface SidecarRef {
  readonly name: string;
  /** Forward-slash path relative to the scan root. */
  readonly relPath: string;
  readonly format: SidecarFormat;
  readonly size: number;
  readonly lastModified: number;
  /** Reads the current file contents (re-reads from disk for handle-backed files). */
  readText(): Promise<string>;
}

export interface VideoEntry {
  /** Same as `relPath`; unique within one scan. */
  readonly id: string;
  /** Forward-slash path relative to the scan root, e.g. `day1/case_003.mp4`. */
  readonly relPath: string;
  readonly name: string;
  /** File name without its final extension. */
  readonly stem: string;
  readonly dir: DirRef;
  /** Exactly one of `fileHandle` / `file` is non-null (handle for real dirs, File for virtual). */
  readonly fileHandle: FileSystemFileHandle | null;
  readonly file: File | null;
  readonly size: number;
  readonly lastModified: number;
  readonly sidecars: readonly SidecarRef[];
}

export function handleDir(handle: FileSystemDirectoryHandle, path: readonly string[] = []): HandleDirRef {
  return { kind: 'handle', handle, name: handle.name, path, canWrite: () => true };
}

export function virtualDir(node: VirtualDirNode, path: readonly string[] = []): VirtualDirRef {
  return { kind: 'virtual', node, name: node.name, path, canWrite: () => false };
}

export function emptyVirtualNode(name: string): VirtualDirNode {
  return { name, files: new Map(), dirs: new Map() };
}

/** Joins path segments (relative to the scan root) into a forward-slash relative path. */
export function joinRelPath(dirPath: readonly string[], name: string): string {
  return [...dirPath, name].join('/');
}
