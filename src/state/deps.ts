/**
 * Everything the controller needs from the outside world, injectable so the controller can be unit
 * tested in node with fakes (player, file system, workers). `createBrowserDeps()` wires the real
 * modules.
 */
import type { FrameIndex } from '../core/mp4/frameIndex';
import { BlobByteReader, type ByteReader } from '../core/mp4/byteReader';
import { indexFile, warmIndexWorkers } from '../core/indexClient';
import type { PlayerSnapshot, SeekOutcome, SettledResult } from '../player/types';
import { FramePlayer } from '../player/FramePlayer';
import {
  CheckpointStore,
  DraftStore,
  HandleStore,
  HashCache,
  KvStore,
  fingerprint,
  requestPersistence,
  sha256,
  warmHashWorker,
  type AttachTarget,
  type Sha256Options,
} from '../storage';
import {
  downloadText,
  ensurePermission,
  handleDrop,
  isSidecarFor,
  isVideoName,
  pickAnnotationFile,
  pickExportFolder,
  pickFolder,
  pickVideoFile,
  queryPermission,
  readTextIfExists,
  requestSourceFolder,
  scanFolder,
  supportsFileSystemAccess,
  writeTextFile,
  type DirRef,
  type SidecarRef,
} from '../fs';
import { iterateDirectory, isFileHandle } from '../fs/fsApi';
import { sidecarFormatOf, stemOf } from '../fs/names';
import { joinRelPath } from '../fs/types';
import { detectLang } from '../i18n';

/** The FramePlayer surface the controller uses (FramePlayer satisfies it). */
export interface PlayerLike {
  load(index: FrameIndex, reader: ByteReader): Promise<void>;
  unload(): void;
  dispose(): void;
  seek(frame: number): Promise<SeekOutcome>;
  pause(): void;
  settled(timeoutMs?: number): Promise<SettledResult>;
  subscribe(fn: (s: PlayerSnapshot) => void): () => void;
  getSnapshot(): PlayerSnapshot;
  peekThumbnail(frame: number): ImageBitmap | null;
  /** Scrub preview: the decoded keyframe at or before `frame`, with its frame number. */
  peekPrecedingThumbnail(frame: number): { frame: number; bitmap: ImageBitmap } | null;
}

export interface FsDeps {
  pickVideoFile: typeof pickVideoFile;
  pickFolder: typeof pickFolder;
  pickAnnotationFile: typeof pickAnnotationFile;
  pickExportFolder: typeof pickExportFolder;
  scanFolder: typeof scanFolder;
  handleDrop: typeof handleDrop;
  requestSourceFolder: typeof requestSourceFolder;
  writeTextFile: typeof writeTextFile;
  readTextIfExists: typeof readTextIfExists;
  downloadText: typeof downloadText;
  ensurePermission: typeof ensurePermission;
  queryPermission: typeof queryPermission;
  /** Sidecar candidates for `videoName` among the direct children of `dir`. */
  listSidecars(dir: DirRef, videoName: string): Promise<SidecarRef[]>;
}

export type WindowLike = AttachTarget & {
  addEventListener(type: 'beforeunload', listener: (e: BeforeUnloadEvent) => void): void;
};

export interface EnvDeps {
  fileSystemAccess(): boolean;
  webCodecs(): boolean;
  requestPersistence(): Promise<boolean>;
  detectLang(): 'en' | 'zh-Hant';
  /** Null in tests: no beforeunload / pagehide wiring. */
  window: WindowLike | null;
}

export interface ControllerDeps<P extends PlayerLike = PlayerLike> {
  drafts: Pick<DraftStore, 'get' | 'findForVideo' | 'save' | 'promotePending' | 'delete' | 'subscribe'>;
  checkpoints: Pick<CheckpointStore, 'create' | 'list' | 'get' | 'delete' | 'rekey'>;
  kv: Pick<KvStore, 'getRaw' | 'getSettings' | 'setSettings' | 'getLibrary' | 'setLibrary'>;
  handles: Pick<HandleStore, 'get' | 'put' | 'delete'>;
  hashCache: Pick<HashCache, 'get'>;
  hashing: {
    fingerprint(file: File): Promise<string>;
    sha256(file: File, options: Sha256Options): Promise<string>;
  };
  indexFile(file: File, opts?: { priority?: 'foreground' | 'background' }): Promise<FrameIndex>;
  createPlayer(canvas: HTMLCanvasElement): P;
  createReader(file: File): ByteReader;
  fs: FsDeps;
  env: EnvDeps;
  autosave?: { debounceMs?: number; maxWaitMs?: number };
  /** Timeout for confirming the displayed frame before a boundary is committed. */
  settleTimeoutMs?: number;
  now(): number;
}

/**
 * Keeps only the candidates that belong to `videoName` under the folder scan's pairing rule: a
 * sidecar matching several videos of the same folder goes to the one(s) with the longest stem, so
 * `case_2.phases.csv` belongs to `case_2.mp4`, never to `case.mp4`.
 */
export function pairSidecarNames(videoName: string, fileNames: readonly string[]): string[] {
  const stem = stemOf(videoName);
  const stems = fileNames.filter(isVideoName).map(stemOf);
  if (!stems.some((s) => s.toLowerCase() === stem.toLowerCase())) stems.push(stem);
  return fileNames.filter((name) => {
    if (sidecarFormatOf(name) === null || !isSidecarFor(stem, name)) return false;
    return !stems.some((other) => other.length > stem.length && isSidecarFor(other, name));
  });
}

async function listSidecars(dir: DirRef, videoName: string): Promise<SidecarRef[]> {
  const out: SidecarRef[] = [];
  if (dir.kind === 'virtual') {
    const names = pairSidecarNames(videoName, [...dir.node.files.keys()]);
    for (const name of names) {
      const file = dir.node.files.get(name) as File;
      out.push({ name, relPath: joinRelPath(dir.path, name), format: sidecarFormatOf(name) as 'csv' | 'json', size: file.size, lastModified: file.lastModified, readText: () => file.text() });
    }
  } else {
    const handles = new Map<string, FileSystemFileHandle>();
    for await (const child of iterateDirectory(dir.handle)) if (isFileHandle(child)) handles.set(child.name, child);
    for (const name of pairSidecarNames(videoName, [...handles.keys()])) {
      const handle = handles.get(name) as FileSystemFileHandle;
      const file = await handle.getFile();
      out.push({ name, relPath: joinRelPath(dir.path, name), format: sidecarFormatOf(name) as 'csv' | 'json', size: file.size, lastModified: file.lastModified, readText: async () => (await handle.getFile()).text() });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export const browserFsDeps: FsDeps = {
  pickVideoFile,
  pickFolder,
  pickAnnotationFile,
  pickExportFolder,
  scanFolder,
  handleDrop,
  requestSourceFolder,
  writeTextFile,
  readTextIfExists,
  downloadText,
  ensurePermission,
  queryPermission,
  listSidecars,
};

/** Real modules: IndexedDB stores, workers, FramePlayer, File System Access API. */
export function createBrowserDeps(): ControllerDeps<FramePlayer> {
  // Load the hash worker now rather than on the first video (offline after load, server stopped).
  warmHashWorker();
  warmIndexWorkers();
  return {
    drafts: new DraftStore(),
    checkpoints: new CheckpointStore(),
    kv: new KvStore(),
    handles: new HandleStore(),
    hashCache: new HashCache(),
    hashing: { fingerprint, sha256 },
    indexFile,
    createPlayer: (canvas) => new FramePlayer(canvas),
    createReader: (file) => new BlobByteReader(file),
    fs: browserFsDeps,
    env: {
      fileSystemAccess: supportsFileSystemAccess,
      webCodecs: () => typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined',
      requestPersistence: () => requestPersistence(),
      detectLang: () => detectLang(),
      window: typeof window === 'undefined' ? null : window,
    },
    now: () => Date.now(),
  };
}
