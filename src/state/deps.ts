/**
 * Everything the controller needs from the outside world, injectable so the controller can be unit
 * tested in node with fakes (player, file system, workers). `createBrowserDeps()` wires the real
 * modules.
 */
import type { FrameIndex } from '../core/mp4/frameIndex';
import { BlobByteReader, type ByteReader } from '../core/mp4/byteReader';
import { indexFile } from '../core/indexClient';
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
  type AttachTarget,
  type Sha256Options,
} from '../storage';
import {
  downloadText,
  ensurePermission,
  handleDrop,
  isSidecarFor,
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
import { sidecarFormatOf } from '../fs/names';
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
  indexFile(file: File): Promise<FrameIndex>;
  createPlayer(canvas: HTMLCanvasElement): P;
  createReader(file: File): ByteReader;
  fs: FsDeps;
  env: EnvDeps;
  autosave?: { debounceMs?: number; maxWaitMs?: number };
  /** Timeout for confirming the displayed frame before a boundary is committed. */
  settleTimeoutMs?: number;
  now(): number;
}

async function listSidecars(dir: DirRef, videoName: string): Promise<SidecarRef[]> {
  const stem = videoName.replace(/\.[^.]*$/, '') || videoName;
  const out: SidecarRef[] = [];
  const add = (name: string, size: number, lastModified: number, readText: () => Promise<string>): void => {
    const format = sidecarFormatOf(name);
    if (!format || !isSidecarFor(stem, name)) return;
    out.push({ name, relPath: joinRelPath(dir.path, name), format, size, lastModified, readText });
  };
  if (dir.kind === 'virtual') {
    for (const [name, file] of dir.node.files) add(name, file.size, file.lastModified, () => file.text());
  } else {
    for await (const child of iterateDirectory(dir.handle)) {
      if (!isFileHandle(child) || sidecarFormatOf(child.name) === null || !isSidecarFor(stem, child.name)) continue;
      const file = await child.getFile();
      add(child.name, file.size, file.lastModified, async () => (await child.getFile()).text());
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
