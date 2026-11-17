/** Builds read-only virtual directory trees for browsers without directory handles. */
import { isHiddenName, isSkippedDirName } from './names';
import { emptyVirtualNode, virtualDir, type VirtualDirNode, type VirtualDirRef } from './types';

function childDir(parent: VirtualDirNode, name: string): VirtualDirNode {
  let child = parent.dirs.get(name);
  if (!child) {
    child = emptyVirtualNode(name);
    parent.dirs.set(name, child);
  }
  return child;
}

function relativeSegments(file: File): string[] {
  const rel = file.webkitRelativePath || '';
  return rel.split(/[\\/]/).filter((s) => s.length > 0);
}

/**
 * Builds a virtual root from an `<input webkitdirectory>` file list. Each file's
 * `webkitRelativePath` starts with the chosen folder's name, which becomes the root's name.
 * Files inside hidden folders or `node_modules` are dropped. Returns null for an empty list.
 */
export function virtualDirFromFiles(files: Iterable<File>): VirtualDirRef | null {
  let root: VirtualDirNode | null = null;
  for (const file of files) {
    const segs = relativeSegments(file);
    const rootName = segs.length > 1 ? segs[0] : '';
    root ??= emptyVirtualNode(rootName);
    const inner = segs.length > 1 ? segs.slice(1) : [file.name];
    if (inner.slice(0, -1).some(isSkippedDirName)) continue;
    let node = root;
    for (const seg of inner.slice(0, -1)) node = childDir(node, seg);
    node.files.set(inner[inner.length - 1], file);
  }
  return root ? virtualDir(root) : null;
}

function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function isDirEntry(entry: FileSystemEntry): entry is FileSystemDirectoryEntry {
  return entry.isDirectory;
}

function isFileEntry(entry: FileSystemEntry): entry is FileSystemFileEntry {
  return entry.isFile;
}

async function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  // readEntries returns results in batches (~100); an empty batch signals the end.
  for (;;) {
    const batch = await readBatch(reader);
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

async function fillNode(node: VirtualDirNode, dir: FileSystemDirectoryEntry, signal?: AbortSignal): Promise<void> {
  for (const entry of await readAllEntries(dir)) {
    signal?.throwIfAborted();
    if (isDirEntry(entry)) {
      if (isSkippedDirName(entry.name)) continue;
      await fillNode(childDir(node, entry.name), entry, signal);
    } else if (isFileEntry(entry) && !isHiddenName(entry.name)) {
      node.files.set(entry.name, await entryFile(entry));
    }
  }
}

/** Reads a legacy (webkitGetAsEntry) directory entry recursively into a virtual root. */
export async function virtualDirFromEntry(entry: FileSystemDirectoryEntry, signal?: AbortSignal): Promise<VirtualDirRef> {
  const root = emptyVirtualNode(entry.name);
  await fillNode(root, entry, signal);
  return virtualDir(root);
}

export { entryFile as fileFromEntry, isDirEntry, isFileEntry };
