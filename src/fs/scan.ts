/** Recursive folder scan: finds MP4/M4V videos and their CSV/JSON sidecar candidates. */
import { iterateDirectory, isDirectoryHandle, isFileHandle } from './fsApi';
import { comparePaths, isHiddenName, isSidecarFor, isSkippedDirName, isVideoName, sidecarFormatOf, stemOf } from './names';
import { handleDir, joinRelPath, virtualDir, type DirRef, type SidecarFormat, type SidecarRef, type VideoEntry, type VideoSource } from './types';

export { sortEntries, type SortDir, type SortKey } from './sort';
export { naturalCompare, comparePaths, isSidecarFor } from './names';

export interface ScanProgress {
  /** `listing` while walking directories, `reading` while reading file sizes/dates. */
  readonly phase: 'listing' | 'reading';
  readonly dirsScanned: number;
  readonly videosFound: number;
  readonly filesRead: number;
  readonly filesToRead: number;
  /** Relative path of the directory or file being processed. */
  readonly currentPath: string;
}

export interface ScanOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ScanProgress) => void;
  /** Called for directories or files that could not be read; they are left out of the result. */
  onSkip?: (relPath: string, error: unknown) => void;
  /** Maximum concurrent `getFile()` calls (default 8). */
  concurrency?: number;
}

const DEFAULT_CONCURRENCY = 8;

interface ListedFile {
  readonly name: string;
  readonly handle: FileSystemFileHandle | null;
  readonly file: File | null;
}

interface Listing {
  readonly files: ListedFile[];
  readonly subdirs: DirRef[];
}

interface FileStat {
  readonly size: number;
  readonly lastModified: number;
}

interface PendingVideo {
  readonly dir: DirRef;
  readonly file: ListedFile;
  readonly sidecars: ListedFile[];
}

async function listHandleDir(handle: FileSystemDirectoryHandle, path: readonly string[]): Promise<Listing> {
  const files: ListedFile[] = [];
  const subdirs: DirRef[] = [];
  for await (const child of iterateDirectory(handle)) {
    if (isDirectoryHandle(child)) {
      if (!isSkippedDirName(child.name)) subdirs.push(handleDir(child, [...path, child.name]));
    } else if (isFileHandle(child) && !isHiddenName(child.name)) {
      files.push({ name: child.name, handle: child, file: null });
    }
  }
  return { files, subdirs };
}

function listDir(dir: DirRef): Promise<Listing> {
  if (dir.kind === 'handle') return listHandleDir(dir.handle, dir.path);
  const files: ListedFile[] = [];
  for (const [name, file] of dir.node.files) {
    if (!isHiddenName(name)) files.push({ name, handle: null, file });
  }
  const subdirs: DirRef[] = [];
  for (const [name, node] of dir.node.dirs) {
    if (!isSkippedDirName(name)) subdirs.push(virtualDir(node, [...dir.path, name]));
  }
  return Promise.resolve({ files, subdirs });
}

/**
 * Pairs sidecar candidates with videos in one directory. A sidecar matching several videos goes
 * to the one(s) with the longest stem, so `case_2.csv` belongs to `case_2.mp4`, not `case.mp4`.
 */
function pairVideos(dir: DirRef, files: readonly ListedFile[]): PendingVideo[] {
  const videos = files.filter((f) => isVideoName(f.name)).map((file) => ({ dir, file, sidecars: [] as ListedFile[] }));
  for (const candidate of files) {
    if (sidecarFormatOf(candidate.name) === null) continue;
    const matches = videos.filter((v) => isSidecarFor(stemOf(v.file.name), candidate.name));
    const longest = Math.max(0, ...matches.map((v) => stemOf(v.file.name).length));
    for (const v of matches) if (stemOf(v.file.name).length === longest) v.sidecars.push(candidate);
  }
  return videos;
}

async function walk(root: DirRef, opts: ScanOptions): Promise<PendingVideo[]> {
  const pending: PendingVideo[] = [];
  const stack: DirRef[] = [root];
  let dirsScanned = 0;
  while (stack.length > 0) {
    opts.signal?.throwIfAborted();
    const dir = stack.pop() as DirRef;
    const currentPath = dir.path.join('/');
    let listing: Listing;
    try {
      listing = await listDir(dir);
    } catch (err) {
      if (dir === root) throw err;
      opts.onSkip?.(currentPath, err);
      continue;
    }
    pending.push(...pairVideos(dir, listing.files));
    stack.push(...listing.subdirs.reverse());
    dirsScanned++;
    opts.onProgress?.({ phase: 'listing', dirsScanned, videosFound: pending.length, filesRead: 0, filesToRead: 0, currentPath });
  }
  return pending;
}

function fileOf(listed: ListedFile): Promise<File> {
  if (listed.file) return Promise.resolve(listed.file);
  return (listed.handle as FileSystemFileHandle).getFile();
}

/** Runs `fn` over `items` with at most `limit` calls in flight; results keep input order. */
export async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      signal?.throwIfAborted();
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}

function makeSidecar(dir: DirRef, listed: ListedFile, stat: FileStat): SidecarRef {
  return {
    name: listed.name,
    relPath: joinRelPath(dir.path, listed.name),
    format: sidecarFormatOf(listed.name) as SidecarFormat,
    size: stat.size,
    lastModified: stat.lastModified,
    readText: async () => (await fileOf(listed)).text(),
  };
}

function makeEntry(v: PendingVideo, stat: FileStat, stats: Map<ListedFile, FileStat | null>): VideoEntry {
  const relPath = joinRelPath(v.dir.path, v.file.name);
  const sidecars: SidecarRef[] = [];
  for (const s of v.sidecars) {
    const st = stats.get(s);
    if (st) sidecars.push(makeSidecar(v.dir, s, st));
  }
  sidecars.sort((a, b) => comparePaths(a.name, b.name));
  return {
    id: relPath,
    relPath,
    name: v.file.name,
    stem: stemOf(v.file.name),
    dir: v.dir,
    fileHandle: v.file.handle,
    file: v.file.file,
    size: stat.size,
    lastModified: stat.lastModified,
    sidecars,
  };
}

async function statAll(pending: readonly PendingVideo[], opts: ScanOptions): Promise<Map<ListedFile, FileStat | null>> {
  const targets: { dir: DirRef; file: ListedFile }[] = [];
  const seen = new Set<ListedFile>();
  for (const v of pending) {
    for (const f of [v.file, ...v.sidecars]) {
      if (!seen.has(f)) {
        seen.add(f);
        targets.push({ dir: v.dir, file: f });
      }
    }
  }
  const stats = new Map<ListedFile, FileStat | null>();
  let filesRead = 0;
  const statOne = async ({ dir, file }: { dir: DirRef; file: ListedFile }): Promise<void> => {
    const relPath = joinRelPath(dir.path, file.name);
    try {
      const f = await fileOf(file);
      stats.set(file, { size: f.size, lastModified: f.lastModified });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      stats.set(file, null);
      opts.onSkip?.(relPath, err);
    }
    filesRead++;
    opts.onProgress?.({ phase: 'reading', dirsScanned: 0, videosFound: pending.length, filesRead, filesToRead: targets.length, currentPath: relPath });
  };
  await mapLimited(targets, opts.concurrency ?? DEFAULT_CONCURRENCY, statOne, opts.signal);
  return stats;
}

/**
 * Recursively lists videos under `root` (skipping hidden entries and `node_modules`), reading each
 * video's and sidecar's size and modification time with bounded concurrency. Entries are returned
 * in natural relative-path order. Rejects with an AbortError when `signal` aborts, and with the
 * underlying error when the root itself cannot be listed.
 */
export async function scanFolder(root: DirRef, opts: ScanOptions = {}): Promise<VideoEntry[]> {
  const pending = await walk(root, opts);
  const stats = await statAll(pending, opts);
  const entries: VideoEntry[] = [];
  for (const v of pending) {
    const stat = stats.get(v.file);
    if (stat) entries.push(makeEntry(v, stat, stats));
  }
  return entries.sort((a, b) => comparePaths(a.relPath, b.relPath));
}

/** Resolves a fresh `File` for an entry (handle-backed files are re-read so they are never stale). */
export async function openEntry(entry: VideoEntry): Promise<VideoSource> {
  const file = entry.fileHandle ? await entry.fileHandle.getFile() : (entry.file as File);
  return { name: entry.name, fileHandle: entry.fileHandle, file, parent: entry.dir, relPath: entry.relPath };
}
