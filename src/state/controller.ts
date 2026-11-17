/**
 * Application controller (SPEC §7): owns the zustand store and implements every contract action.
 * All side effects go through `ControllerDeps` so the whole controller runs in node tests.
 *
 * Invariants:
 * - Nothing here throws into React: every action catches and reports through toasts, markFeedback
 *   or state, using i18n message keys.
 * - Every async step of the video lifecycle re-checks `this.video === cv` (load token) so a user
 *   who switched videos meanwhile is never affected by stale work.
 * - Boundaries are committed only with a frame confirmed by the player (`settled`).
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  addSegment,
  deleteSegment as deleteSegmentOp,
  newSegmentId,
  relabelSegment as relabelSegmentOp,
  updateSegment,
  validateForExport,
  type SegmentRejection,
} from '../core/annotations';
import { parseAnnotationFile, toSegments, verifyAgainstVideo } from '../core/formats/import';
import type { ParsedAnnotation, SidecarFormat } from '../core/formats/types';
import { boundaryUs, type FrameIndex } from '../core/mp4/frameIndex';
import * as phaseOps from '../core/phases';
import type { PhaseDef, PhaseLibrary, Segment } from '../core/types';
import { handleDir, openEntry, sortEntries, type DirRef, type HandleDirRef, type SidecarRef, type VideoEntry, type VideoSource } from '../fs';
import { formatDateTime, setLang, t, type MessageKey } from '../i18n';
import {
  Autosaver,
  computeContentHash,
  hashCacheKey,
  isAbortError,
  newDraft,
  pendingKey,
  type AutosaveStatus,
  type DraftMessage,
  type DraftRecord,
  type Settings as StoredSettings,
} from '../storage';
import type {
  Actions,
  AnnotationDoc,
  AppState,
  BatchItem,
  CheckpointSummary,
  DialogState,
  ExportDestination,
  ExportStatus,
  IssueView,
  Lang,
  Msg,
  SidecarStatus,
  SortDir,
  SortKey,
  SwitchFailure,
  Toast,
} from './contract';
import type { ControllerDeps, PlayerLike } from './deps';
import { formatsFor, runExport, type ExportPlace } from './exporter';
import { History, type EditorSnapshot } from './history';
import { createInitialState, DEFAULT_APP_SETTINGS, emptyBatch, emptyEditor, emptyVideo } from './initialState';
import {
  errorCode,
  errorText,
  indexWarningMsg,
  isIdentityProblem,
  issueView,
  msg,
  parseErrorMsg,
  verifyProblemMsg,
} from './messages';
import { initialVisibleRecent, showInVisibleRecent } from './recent';

export const LAST_FOLDER_HANDLE_ID = 'last-folder';
export const EXPORT_FOLDER_HANDLE_ID = 'export-folder';
const RECENT_LIMIT = 50;
const DEFAULT_SETTLE_TIMEOUT_MS = 1500;

/** Drafts written by this controller carry `touched` (absent on older records = touched). */
export type StoredDraft = DraftRecord & { touched?: boolean };

interface ItemRecord {
  id: string;
  entry: VideoEntry | null;
  source: VideoSource | null;
  sha256: string | null;
  draft: StoredDraft | null;
  sidecarResult: 'match' | 'mismatch' | 'invalid' | null;
  sidecarDetail: Msg | null;
  matchedSegments: number | null;
  loadError: Msg | null;
}

interface SidecarCheck {
  ref: SidecarRef;
  status: SidecarStatus;
  parsed: ParsedAnnotation | null;
}

interface PendingImport {
  parsed: ParsedAnnotation;
  label: string;
  fileName: string;
  format: SidecarFormat;
  at: number;
}

/** The open video. Mutable; producers and async steps hold a reference to it. */
interface Video {
  itemId: string;
  name: string;
  relPath: string | null;
  file: File;
  fileHandle: FileSystemFileHandle | null;
  dir: DirRef | null;
  subdirs: string[];
  index: FrameIndex | null;
  fingerprint: string | null;
  sha256: string | null;
  hashState: 'idle' | 'hashing' | 'done' | 'error';
  hashDone: Promise<string | null>;
  abort: AbortController;
  meta: StoredDraft;
  doc: AnnotationDoc;
  touched: boolean;
  /** Saves are held back while the draft identity is provisional or being promoted. */
  deferSaves: boolean;
  saveWanted: boolean;
  history: History;
  sidecars: SidecarCheck[];
  pendingImport: PendingImport | null;
  playerLoad: Promise<void> | null;
  loadFailed: boolean;
  exporting: boolean;
  exportError: Msg | null;
  lifecycle: Promise<void>;
}

interface PendingSwitch {
  targetItemId: string | null;
  run: () => Promise<void>;
}

type ExportOutcome = { ok: true } | { ok: false; failure: SwitchFailure };

export interface ControllerApi<P extends PlayerLike> {
  store: StoreApi<AppState>;
  actions: Actions;
  getPlayer(): P | null;
  /** Called when the player instance changes (canvas attached). */
  onPlayerChange(fn: () => void): () => void;
  getFrameIndex(): FrameIndex | null;
  /** The canvas the player renders into (last attached). */
  getCanvas(): HTMLCanvasElement | null;
  getThumbnail(frame: number): ImageBitmap | null;
  /** Test/e2e helpers (see src/state/testHook.ts). */
  openDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void>;
  openFileHandle(handle: FileSystemFileHandle, parent?: FileSystemDirectoryHandle): Promise<void>;
  openSource(source: VideoSource): Promise<void>;
  openRoot(root: DirRef): Promise<void>;
  setExportFolderHandle(handle: FileSystemDirectoryHandle): Promise<void>;
  flushAutosave(): Promise<void>;
  /** Resolves when the open video's identity/sidecar work and batch verification are finished. */
  whenIdle(): Promise<void>;
  dispose(): void;
}

/** Chips shown when a video opens: recent phases, topped up from the active preset. */
function visibleFor(lib: PhaseLibrary): string[] {
  const preset = lib.presets.find((p) => p.id === lib.activePresetId);
  return initialVisibleRecent(lib.recent, (id) => id in lib.phases, preset?.phaseIds ?? []);
}

function phaseExistsIn(doc: AnnotationDoc, lib: PhaseLibrary): (id: string) => boolean {
  return (id) => id in doc.phases || id in lib.phases;
}

function snapshotPhases(segments: readonly Segment[], prev: Record<string, PhaseDef>, lib: PhaseLibrary, prefer?: string): Record<string, PhaseDef> {
  const out: Record<string, PhaseDef> = {};
  for (const s of segments) {
    if (out[s.phaseId]) continue;
    const def = s.phaseId === prefer ? (lib.phases[s.phaseId] ?? prev[s.phaseId]) : (prev[s.phaseId] ?? lib.phases[s.phaseId]);
    if (def) out[s.phaseId] = { ...def };
  }
  return out;
}

function draftIsDirty(d: StoredDraft): boolean {
  return (d.touched ?? true) && d.contentHash !== d.exported?.contentHash;
}

function rejectionMsg(reason: SegmentRejection | 'not_found', start: number, conflicts: number): Msg {
  switch (reason) {
    case 'overlap':
      return msg('mark.err.overlap', { count: conflicts });
    case 'empty':
      return msg('mark.err.endBeforeStart', { start });
    case 'out_of_range':
      return msg('mark.err.outOfRange');
    case 'not_found':
      return msg('ctl.edit.notFound');
  }
}

export function createController<P extends PlayerLike>(deps: ControllerDeps<P>): ControllerApi<P> {
  return new Controller(deps).api();
}

class Controller<P extends PlayerLike> {
  readonly store: StoreApi<AppState> = createStore<AppState>()(() => createInitialState());
  private readonly autosaver: Autosaver;
  private readonly settleTimeout: number;

  private player: P | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private playerWaiters: ((p: P) => void)[] = [];
  private readonly playerListeners = new Set<() => void>();

  private items = new Map<string, ItemRecord>();
  private batchGen = 0;
  private scanAbort: AbortController | null = null;
  private bgAbort: AbortController | null = null;
  private bgWork: Promise<void> = Promise.resolve();
  private video: Video | null = null;
  private loadToken = 0;
  private exportFolder: HandleDirRef | null = null;
  private rememberedFolder: FileSystemDirectoryHandle | null = null;
  private pendingSwitch: PendingSwitch | null = null;
  private switching = false;
  /** Draft keys / item ids of videos left this session with unexported changes. */
  private readonly unexported = new Set<string>();
  private toastSeq = 0;
  private feedbackSeq = 0;
  private libraryChain: Promise<void> = Promise.resolve();
  private settingsChain: Promise<void> = Promise.resolve();
  private initStarted = false;
  private readonly cleanups: (() => void)[] = [];

  constructor(private readonly deps: ControllerDeps<P>) {
    this.settleTimeout = deps.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
    this.autosaver = new Autosaver({
      store: deps.drafts,
      onStatus: (s) => this.onSaveStatus(s),
      debounceMs: deps.autosave?.debounceMs,
      maxWaitMs: deps.autosave?.maxWaitMs,
      now: deps.now,
    });
  }

  // ================================================================ plumbing

  private get s(): AppState {
    return this.store.getState();
  }

  private set(patch: Partial<AppState>): void {
    this.store.setState(patch);
  }

  private toast(kind: Toast['kind'], m: Msg, opts: { action?: Toast['action']; timeout?: number | null } = {}): void {
    const id = ++this.toastSeq;
    const timeout = opts.timeout !== undefined ? opts.timeout : kind === 'error' ? 10000 : kind === 'warning' ? 7000 : 4000;
    const toast: Toast = { id, kind, msg: m, timeout, ...(opts.action ? { action: opts.action } : {}) };
    this.set({ toasts: [...this.s.toasts, toast].slice(-6) });
    if (timeout !== null) setTimeout(() => this.dismissToast(id), timeout);
  }

  private feedback(kind: 'ok' | 'error' | 'waiting', m: Msg, action?: { label: Msg; run: () => void }): void {
    this.set({ markFeedback: { seq: ++this.feedbackSeq, kind, msg: m, ...(action ? { action } : {}) } });
  }

  private clearWaiting(): void {
    if (this.s.markFeedback?.kind === 'waiting') this.set({ markFeedback: null });
  }

  /** Runs an action body, reporting unexpected errors instead of throwing into React. */
  private async guard<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!isAbortError(e)) {
        console.error(e);
        this.toast('error', msg('ctl.error.unexpected', { message: errorText(e) }));
      }
      return fallback;
    }
  }

  private guardSync<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (e) {
      console.error(e);
      this.toast('error', msg('ctl.error.unexpected', { message: errorText(e) }));
      return fallback;
    }
  }

  // ================================================================ init & persistence

  private async init(): Promise<void> {
    if (this.initStarted) return;
    this.initStarted = true;
    const { deps } = this;
    const capabilities = { fileSystemAccess: safe(() => deps.env.fileSystemAccess(), false), webCodecs: safe(() => deps.env.webCodecs(), false), persistentStorage: null };
    let settings = { ...DEFAULT_APP_SETTINGS };
    let library = this.s.library;
    try {
      const raw = await deps.kv.getRaw('settings');
      const stored = await deps.kv.getSettings();
      library = await deps.kv.getLibrary(phaseOps.createDefaultLibrary);
      let exportDestination: ExportDestination = stored.exportDestination.kind === 'folder' ? { kind: 'beside' } : { kind: stored.exportDestination.kind };
      if (stored.exportDestination.kind === 'folder') {
        const handle = await deps.handles.get(EXPORT_FOLDER_HANDLE_ID).catch(() => null);
        if (handle) {
          this.exportFolder = handleDir(handle);
          exportDestination = { kind: 'folder', folderName: handle.name };
        }
      }
      settings = {
        language: raw === undefined ? deps.env.detectLang() : stored.language,
        exportFormat: stored.exportFormat,
        exportDestination,
        sort: stored.sort,
        bottomPanelHeight: stored.bottomPanelHeight,
      };
    } catch (e) {
      this.toast('error', msg('ctl.storage.unavailable', { message: errorText(e) }), { timeout: null });
    }
    setLang(settings.language);
    this.set({
      ready: true,
      capabilities,
      settings,
      library,
      visibleRecent: visibleFor(library),
    });

    deps.env
      .requestPersistence()
      .then((persisted) => this.set({ capabilities: { ...this.s.capabilities, persistentStorage: persisted } }))
      .catch(() => undefined);

    this.cleanups.push(deps.drafts.subscribe((m) => this.onDraftMessage(m)));
    const win = deps.env.window;
    if (win) {
      this.autosaver.attach(win);
      win.addEventListener('beforeunload', (e: BeforeUnloadEvent) => {
        void this.autosaver.flush();
        if (this.s.editor.dirty || this.s.unexportedCount > 0) {
          e.preventDefault();
          e.returnValue = '';
        }
      });
    }

    const remembered = await deps.handles.get(LAST_FOLDER_HANDLE_ID).catch(() => null);
    if (remembered && this.s.batch.mode === 'none') {
      this.rememberedFolder = remembered;
      const state = await deps.fs.queryPermission(remembered, 'readwrite').catch((): PermissionState => 'denied');
      if (this.s.batch.mode !== 'none') return;
      // Not awaited: the first video waits for the canvas, which may mount after init resolves.
      if (state === 'granted') void this.guard(() => this.openFolderRoot(handleDir(remembered), 'readwrite'), undefined);
      else this.set({ batch: { ...emptyBatch(), rootName: remembered.name, access: 'needs-permission' } });
    }
  }

  private persistLibrary(): void {
    this.libraryChain = this.libraryChain
      .then(() => this.deps.kv.setLibrary(this.s.library))
      .catch((e) => this.toast('error', msg('save.failedDetail', { reason: errorText(e) })));
  }

  private persistSettings(): void {
    this.settingsChain = this.settingsChain
      .then(() => {
        const s = this.s.settings;
        const stored: StoredSettings = {
          language: s.language,
          exportFormat: s.exportFormat,
          exportDestination: s.exportDestination.kind === 'folder' ? { kind: 'folder', handleId: EXPORT_FOLDER_HANDLE_ID } : { kind: s.exportDestination.kind },
          sort: s.sort,
          bottomPanelHeight: s.bottomPanelHeight,
        };
        return this.deps.kv.setSettings(stored);
      })
      .catch((e) => this.toast('error', msg('save.failedDetail', { reason: errorText(e) })));
  }

  private setLibrary(library: PhaseLibrary): void {
    this.set({ library });
    this.persistLibrary();
  }

  // ================================================================ player

  private attachCanvas(canvas: HTMLCanvasElement | null): void {
    if (!canvas || (canvas === this.canvas && this.player)) return;
    let next: P;
    try {
      next = this.deps.createPlayer(canvas);
    } catch (e) {
      this.toast('error', msg('ctl.error.unexpected', { message: errorText(e) }));
      return;
    }
    const old = this.player;
    this.canvas = canvas;
    this.player = next;
    old?.dispose();
    const cv = this.video;
    if (cv?.index && old) cv.playerLoad = next.load(cv.index, this.deps.createReader(cv.file)).catch(() => undefined);
    const waiters = this.playerWaiters;
    this.playerWaiters = [];
    for (const w of waiters) w(next);
    for (const fn of this.playerListeners) fn();
  }

  private ensurePlayer(): Promise<P> {
    if (this.player) return Promise.resolve(this.player);
    return new Promise((resolve) => this.playerWaiters.push(resolve));
  }

  // ================================================================ batch

  private makeItemRecord(id: string, entry: VideoEntry | null, source: VideoSource | null): ItemRecord {
    return { id, entry, source, sha256: null, draft: null, sidecarResult: null, sidecarDetail: null, matchedSegments: null, loadError: null };
  }

  private baseItem(rec: ItemRecord): BatchItem {
    const e = rec.entry;
    const file = rec.source?.file;
    const relPath = e?.relPath ?? rec.source?.relPath ?? rec.source?.name ?? rec.id;
    return {
      id: rec.id,
      relPath,
      name: e?.name ?? rec.source?.name ?? rec.id,
      size: e?.size ?? file?.size ?? 0,
      lastModified: e?.lastModified ?? file?.lastModified ?? 0,
      status: 'unannotated',
      statusDetail: null,
      sha256: null,
      segmentCount: null,
    };
  }

  private sidecarCount(rec: ItemRecord): number {
    return rec.entry?.sidecars.length ?? 0;
  }

  /** Status of an item that is not open, from what background work and previous visits found. */
  private recordStatus(rec: ItemRecord): Pick<BatchItem, 'status' | 'statusDetail' | 'segmentCount'> {
    if (rec.loadError) return { status: 'error', statusDetail: rec.loadError, segmentCount: null };
    const d = rec.draft;
    if (d && draftIsDirty(d)) return { status: 'draft', statusDetail: null, segmentCount: d.segments.length };
    if (d?.exported && d.exported.contentHash === d.contentHash) return { status: 'annotated', statusDetail: null, segmentCount: d.segments.length };
    if (rec.sidecarResult === 'match') return { status: 'annotated', statusDetail: null, segmentCount: rec.matchedSegments };
    if (rec.sidecarResult) return { status: 'mismatch', statusDetail: rec.sidecarDetail, segmentCount: null };
    if (this.sidecarCount(rec) > 0) return { status: 'unverified', statusDetail: null, segmentCount: null };
    return { status: 'unannotated', statusDetail: null, segmentCount: null };
  }

  private videoStatus(cv: Video): Pick<BatchItem, 'status' | 'statusDetail' | 'segmentCount'> {
    const segs = cv.doc.segments.length;
    if (cv.loadFailed) return { status: 'error', statusDetail: this.s.video.error, segmentCount: null };
    if (this.isDirty(cv)) return { status: 'draft', statusDetail: null, segmentCount: segs };
    const hash = computeContentHash(cv.doc.segments, cv.doc.phases);
    if (cv.meta.exported && cv.meta.exported.contentHash === hash) return { status: 'annotated', statusDetail: null, segmentCount: segs };
    if (cv.sidecars.some((c) => c.status.state === 'match')) return { status: 'annotated', statusDetail: null, segmentCount: segs };
    if (cv.sidecars.some((c) => c.status.state === 'checking')) return { status: 'unverified', statusDetail: null, segmentCount: null };
    const bad = cv.sidecars.find((c) => c.status.state === 'mismatch' || c.status.state === 'invalid');
    if (bad) return { status: 'mismatch', statusDetail: bad.status.problems[0] ?? null, segmentCount: null };
    return { status: 'unannotated', statusDetail: null, segmentCount: null };
  }

  private updateItem(id: string, patch: Partial<BatchItem>): void {
    const b = this.s.batch;
    const i = b.items.findIndex((it) => it.id === id);
    if (i < 0) return;
    const cur = b.items[i];
    const changed = (Object.keys(patch) as (keyof BatchItem)[]).some((k) => cur[k] !== patch[k]);
    if (!changed) return;
    const items = [...b.items];
    items[i] = { ...cur, ...patch };
    this.set({ batch: { ...b, items } });
  }

  private applyRecordStatus(rec: ItemRecord): void {
    if (this.video?.itemId === rec.id) return;
    this.updateItem(rec.id, { ...this.recordStatus(rec), sha256: rec.sha256 });
  }

  private applyVideoStatus(cv: Video): void {
    if (this.video !== cv) return;
    this.updateItem(cv.itemId, { ...this.videoStatus(cv), sha256: cv.sha256 });
  }

  private sortedItems(items: BatchItem[]): BatchItem[] {
    const { key, dir } = this.s.settings.sort;
    return sortEntries(items, key, dir);
  }

  private async openFolderRoot(root: DirRef, knownAccess?: 'readwrite' | 'read'): Promise<void> {
    await this.leaveCurrent();
    const gen = ++this.batchGen;
    this.scanAbort?.abort();
    this.bgAbort?.abort();
    const scanAbort = new AbortController();
    this.scanAbort = scanAbort;
    this.items = new Map();
    let access: AppState['batch']['access'] = 'virtual';
    if (root.kind === 'handle') {
      access = knownAccess ?? ((await this.deps.fs.queryPermission(root.handle, 'readwrite').catch(() => 'denied')) === 'granted' ? 'readwrite' : 'read');
      this.rememberedFolder = root.handle;
      this.deps.handles.put(LAST_FOLDER_HANDLE_ID, root.handle).catch(() => undefined);
    }
    if (gen !== this.batchGen) return;
    this.set({ batch: { ...emptyBatch(), mode: 'folder', rootName: root.name, scanning: true, access } });

    let entries: VideoEntry[];
    try {
      entries = await this.deps.fs.scanFolder(root, {
        signal: scanAbort.signal,
        onProgress: (p) => {
          if (gen === this.batchGen && p.videosFound !== this.s.batch.scannedCount) this.set({ batch: { ...this.s.batch, scannedCount: p.videosFound } });
        },
      });
    } catch (e) {
      if (gen !== this.batchGen) return;
      this.set({ batch: { ...this.s.batch, scanning: false } });
      if (!isAbortError(e)) this.toast('error', msg('ctl.folder.scanFailed', { name: root.name, message: errorText(e) }));
      return;
    }
    if (gen !== this.batchGen) return;
    for (const e of entries) this.items.set(e.id, this.makeItemRecord(e.id, e, null));
    const items = this.sortedItems(entries.map((e) => this.recordToItem(this.items.get(e.id) as ItemRecord)));
    this.set({ batch: { ...this.s.batch, items, scanning: false, scannedCount: entries.length } });
    if (items.length === 0) {
      this.toast('info', msg('ctl.folder.noVideos', { name: root.name }));
      return;
    }
    const bg = new AbortController();
    this.bgAbort = bg;
    this.bgWork = this.verifyBatch(gen, bg.signal).catch(() => undefined);
    await this.openVideo(items[0].id);
  }

  private recordToItem(rec: ItemRecord): BatchItem {
    return { ...this.baseItem(rec), ...this.recordStatus(rec) };
  }

  private async openSingle(source: VideoSource): Promise<void> {
    await this.leaveCurrent();
    this.batchGen++;
    this.scanAbort?.abort();
    this.bgAbort?.abort();
    const id = source.relPath ?? source.name;
    const rec = this.makeItemRecord(id, null, source);
    this.items = new Map([[id, rec]]);
    const access: AppState['batch']['access'] = source.parent ? (source.parent.kind === 'virtual' ? 'virtual' : 'readwrite') : 'none';
    this.set({ batch: { ...emptyBatch(), mode: 'file', items: [this.recordToItem(rec)], access } });
    await this.openVideo(id);
  }

  /** One at a time, background priority: drafts via the hash cache, then sidecar verification. */
  private async verifyBatch(gen: number, signal: AbortSignal): Promise<void> {
    const live = (): boolean => gen === this.batchGen && !signal.aborted;
    for (const rec of this.items.values()) {
      if (!live()) return;
      const e = rec.entry;
      if (!e) continue;
      const sha = await this.deps.hashCache.get(hashCacheKey({ name: e.name, size: e.size, lastModified: e.lastModified }, e.relPath)).catch(() => null);
      if (!live()) return;
      if (sha) {
        rec.sha256 = sha;
        rec.draft = ((await this.deps.drafts.get(sha).catch(() => null)) as StoredDraft | null) ?? null;
      }
      this.applyRecordStatus(rec);
    }
    const todo = [...this.items.values()].filter((r) => this.sidecarCount(r) > 0);
    if (todo.length === 0) return;
    let done = 0;
    this.set({ batch: { ...this.s.batch, verifying: { done, total: todo.length } } });
    for (const rec of todo) {
      if (!live()) return;
      await this.foregroundIdle(live);
      if (!live()) return;
      if (this.video?.itemId !== rec.id && rec.sidecarResult === null) await this.verifyItem(rec, signal).catch(() => undefined);
      if (!live()) return;
      done++;
      this.set({ batch: { ...this.s.batch, verifying: done < todo.length ? { done, total: todo.length } : null } });
    }
  }

  private async foregroundIdle(live: () => boolean): Promise<void> {
    for (;;) {
      const cv = this.video;
      const phase = this.s.video.loadPhase;
      const busy = cv !== null && (cv.hashState === 'hashing' || phase === 'indexing' || phase === 'loading');
      if (!busy || !live()) return;
      await sleep(200);
    }
  }

  private async verifyItem(rec: ItemRecord, signal: AbortSignal): Promise<void> {
    const e = rec.entry as VideoEntry;
    const file = e.file ?? (await (e.fileHandle as FileSystemFileHandle).getFile());
    const sha = rec.sha256 ?? (await this.deps.hashing.sha256(file, { priority: 'background', relPath: e.relPath, signal }));
    rec.sha256 = sha;
    if (!rec.draft) rec.draft = ((await this.deps.drafts.get(sha).catch(() => null)) as StoredDraft | null) ?? null;
    let index: FrameIndex;
    try {
      index = await this.deps.indexFile(file);
    } catch (err) {
      rec.loadError = msg('ctl.video.indexFailed', { file: e.name, code: errorCode(err) });
      this.applyRecordStatus(rec);
      return;
    }
    if (signal.aborted) return;
    const results = await Promise.all(e.sidecars.map((ref) => this.checkSidecar(ref, sha, index)));
    const match = results.find((r) => r.status.state === 'match');
    if (match) {
      rec.sidecarResult = 'match';
      rec.matchedSegments = match.status.segmentCount;
    } else {
      const first = results[0];
      rec.sidecarResult = first?.status.state === 'invalid' ? 'invalid' : 'mismatch';
      rec.sidecarDetail = first?.status.problems[0] ?? null;
    }
    this.applyRecordStatus(rec);
  }

  // ================================================================ switching

  private isDirty(cv: Video): boolean {
    return cv.touched && cv.meta.exported?.contentHash !== computeContentHash(cv.doc.segments, cv.doc.phases);
  }

  private unexportedCount(): number {
    const cv = this.video;
    const current = cv && this.isDirty(cv) && !this.unexported.has(cv.meta.key) ? 1 : 0;
    return this.unexported.size + current;
  }

  /**
   * Export gate before leaving the current video (SPEC §7.7). `run` performs the switch; it is
   * kept for the switch-failed dialog's recovery actions.
   */
  private async switchGate(targetItemId: string | null, run: () => Promise<void>): Promise<void> {
    if (this.switching) return;
    this.switching = true;
    let proceed = true;
    try {
      const cv = this.video;
      if (cv) {
        await this.autosaver.flush();
        if (this.video === cv && this.isDirty(cv)) {
          const r = await this.exportCurrent({ request: true });
          if (!r.ok) {
            proceed = false;
            this.pendingSwitch = { targetItemId, run };
            this.set({ dialog: { kind: 'switch-failed', targetItemId, failure: r.failure } });
          }
        }
      }
    } finally {
      this.switching = false;
    }
    if (proceed) await run();
  }

  /** Leaves the open video: final save, status bookkeeping, player unload. */
  private async leaveCurrent(): Promise<void> {
    const cv = this.video;
    if (!cv) return;
    if (cv.deferSaves && cv.saveWanted && cv.fingerprint) {
      // Identity never verified: keep the edits under the pending key rather than a draft of a
      // video that may be a different one.
      const key = pendingKey(cv.fingerprint);
      const stored = await this.deps.drafts.get(key).catch(() => null);
      cv.meta = { ...cv.meta, key, sha256: null, revision: stored?.revision ?? 0 };
      cv.deferSaves = false;
      this.scheduleSave(cv);
    }
    await this.autosaver.flush();
    if (this.video !== cv) return;
    cv.abort.abort();
    if (this.isDirty(cv)) this.unexported.add(cv.meta.key);
    const rec = this.items.get(cv.itemId);
    if (rec) {
      rec.sha256 = cv.sha256 ?? rec.sha256;
      rec.draft = cv.touched ? this.buildDraft(cv) : rec.draft;
      if (cv.loadFailed) rec.loadError = this.s.video.error;
      const match = cv.sidecars.find((c) => c.status.state === 'match');
      if (match) {
        rec.sidecarResult = 'match';
        rec.matchedSegments = match.status.segmentCount;
      } else if (cv.sidecars.length && cv.sidecars.every((c) => c.status.state === 'mismatch' || c.status.state === 'invalid')) {
        rec.sidecarResult = 'mismatch';
        rec.sidecarDetail = cv.sidecars[0].status.problems[0] ?? null;
      }
    }
    this.video = null;
    this.pendingSwitch = null;
    this.player?.unload();
    if (rec) this.applyRecordStatus(rec);
    this.set({
      video: emptyVideo(),
      editor: emptyEditor(),
      checkpoints: [],
      exportStatus: { kind: 'none' },
      stale: null,
      markFeedback: null,
      dialog: this.s.dialog?.kind === 'switch-failed' || this.s.dialog?.kind === 'import-choice' ? null : this.s.dialog,
      unexportedCount: this.unexported.size,
      batch: { ...this.s.batch, currentId: null },
    });
  }

  // ================================================================ video lifecycle

  private async openVideo(itemId: string): Promise<void> {
    const rec = this.items.get(itemId);
    if (!rec) return;
    await this.leaveCurrent();
    const token = ++this.loadToken;
    const lib = this.s.library;
    const baseName = rec.entry?.name ?? rec.source?.name ?? itemId;
    const relPath = rec.entry?.relPath ?? rec.source?.relPath ?? null;
    const sourceFolder: AppState['video']['sourceFolder'] = rec.entry || rec.source?.parent ? 'available' : rec.source?.fileHandle && this.s.capabilities.fileSystemAccess ? 'needs-access' : 'unsupported';
    this.set({
      batch: { ...this.s.batch, currentId: itemId },
      video: { ...emptyVideo(), itemId, fileName: baseName, relPath, loadPhase: 'indexing', sourceFolder },
      editor: emptyEditor(),
      checkpoints: [],
      exportStatus: { kind: 'none' },
      stale: null,
      save: { kind: 'idle' },
      markFeedback: null,
      visibleRecent: visibleFor(lib),
    });

    let source: VideoSource;
    try {
      source = rec.source ?? (await openEntry(rec.entry as VideoEntry));
    } catch (e) {
      if (token !== this.loadToken) return;
      this.failLoadEarly(rec, msg('ctl.video.readFailed', { file: baseName, message: errorText(e) }));
      return;
    }
    if (token !== this.loadToken) return;

    const abort = new AbortController();
    const cv: Video = {
      itemId,
      name: source.name,
      relPath,
      file: source.file,
      fileHandle: source.fileHandle,
      dir: rec.entry?.dir ?? source.parent,
      subdirs: rec.entry ? [...rec.entry.dir.path] : [],
      index: null,
      fingerprint: null,
      sha256: null,
      hashState: 'idle',
      hashDone: Promise.resolve(null),
      abort,
      meta: newDraft({ sha256: null, fingerprint: '', fileName: source.name, relPath, frameCount: 0, durationUs: 0 }),
      doc: { segments: [], phases: {} },
      touched: false,
      deferSaves: true,
      saveWanted: false,
      history: new History(),
      sidecars: [],
      pendingImport: null,
      playerLoad: null,
      loadFailed: false,
      exporting: false,
      exportError: null,
      lifecycle: Promise.resolve(),
    };
    this.video = cv;
    this.set({ unexportedCount: this.unexportedCount() });

    let index: FrameIndex;
    try {
      index = await this.deps.indexFile(source.file);
    } catch (e) {
      if (this.video !== cv) return;
      this.failLoad(cv, msg('ctl.video.indexFailed', { file: source.name, code: errorCode(e) }));
      return;
    }
    if (this.video !== cv) return;
    cv.index = index;
    cv.meta = { ...cv.meta, frameCount: index.frameCount, durationUs: index.durationUs };
    this.set({
      video: {
        ...this.s.video,
        loadPhase: 'loading',
        frameCount: index.frameCount,
        durationUs: index.durationUs,
        averageFps: index.averageFps,
        variableFrameRate: index.variableFrameRate,
        width: index.displayWidth,
        height: index.displayHeight,
        warnings: index.warnings.map(indexWarningMsg),
      },
    });

    cv.hashDone = this.startHash(cv);
    const lookup = this.lookupDraft(cv).catch((e) => {
      if (!isAbortError(e)) console.error(e);
    });
    const sidecarList = this.discoverSidecars(cv);

    const player = await this.ensurePlayer();
    if (this.video !== cv) return;
    cv.playerLoad = player.load(index, this.deps.createReader(source.file)).catch(() => undefined);
    for (;;) {
      const p = this.player;
      await cv.playerLoad;
      if (this.player === p) break;
    }
    await lookup;
    await sidecarList;
    if (this.video !== cv) return;
    const snap = (this.player as P).getSnapshot();
    if (snap.status === 'error' || snap.status === 'empty') {
      const code = snap.error?.code ?? 'decode_failed';
      this.failLoad(cv, msg(`player.error.${code}`));
      return;
    }
    this.set({ video: { ...this.s.video, loadPhase: 'ready' } });
    this.syncEditor(cv);
    cv.lifecycle = this.verifyIdentity(cv).catch((e) => {
      if (!isAbortError(e)) {
        console.error(e);
        this.toast('error', msg('ctl.error.unexpected', { message: errorText(e) }));
      }
    });
  }

  private failLoadEarly(rec: ItemRecord, m: Msg): void {
    rec.loadError = m;
    this.set({ video: { ...this.s.video, loadPhase: 'error', error: m } });
    this.updateItem(rec.id, { status: 'error', statusDetail: m });
  }

  private failLoad(cv: Video, m: Msg): void {
    cv.loadFailed = true;
    cv.abort.abort();
    this.set({ video: { ...this.s.video, loadPhase: 'error', error: m } });
    this.applyVideoStatus(cv);
  }

  private startHash(cv: Video): Promise<string | null> {
    cv.hashState = 'hashing';
    this.set({ video: { ...this.s.video, hash: { state: 'hashing', progress: 0, sha256: null } } });
    let lastPct = -1;
    return this.deps.hashing
      .sha256(cv.file, {
        priority: 'foreground',
        relPath: cv.relPath,
        signal: cv.abort.signal,
        onProgress: (done, total) => {
          if (this.video !== cv) return;
          const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
          if (pct === lastPct) return;
          lastPct = pct;
          this.set({ video: { ...this.s.video, hash: { state: 'hashing', progress: pct / 100, sha256: null } } });
        },
      })
      .then(
        (sha) => {
          cv.sha256 = sha;
          cv.hashState = 'done';
          if (this.video === cv) this.set({ video: { ...this.s.video, hash: { state: 'done', progress: 1, sha256: sha } } });
          return sha;
        },
        (e) => {
          cv.hashState = 'error';
          if (this.video === cv && !isAbortError(e)) {
            this.set({ video: { ...this.s.video, hash: { state: 'error', progress: 0, sha256: null } } });
            this.toast('error', msg('ctl.video.hashFailed', { file: cv.name, message: errorText(e) }));
          }
          return null;
        },
      );
  }

  /** Fingerprint → provisional draft (instant), before the full hash is known. */
  private async lookupDraft(cv: Video): Promise<void> {
    const fp = await this.deps.hashing.fingerprint(cv.file);
    if (this.video !== cv) return;
    cv.fingerprint = fp;
    const index = cv.index as FrameIndex;
    cv.meta = newDraft({ sha256: null, fingerprint: fp, fileName: cv.name, relPath: cv.relPath, frameCount: index.frameCount, durationUs: index.durationUs });
    cv.deferSaves = false;
    const found = await this.deps.drafts.findForVideo({ fingerprint: fp }).catch(() => null);
    if (this.video !== cv) return;
    if (found) {
      this.adoptDraft(cv, found.record as StoredDraft);
      // A draft keyed by a known sha256 may belong to another video until our own hash confirms it.
      if (found.record.sha256 !== null) cv.deferSaves = true;
      this.set({ video: { ...this.s.video, identity: 'provisional' } });
    }
    await this.refreshCheckpoints(cv);
  }

  private adoptDraft(cv: Video, record: StoredDraft): void {
    const index = cv.index as FrameIndex;
    cv.meta = { ...record, fileName: cv.name, relPath: cv.relPath, frameCount: index.frameCount, durationUs: index.durationUs, fingerprint: cv.fingerprint ?? record.fingerprint };
    cv.doc = { segments: record.segments, phases: record.phases };
    cv.touched = record.touched ?? true;
    this.ensureLibraryHas(cv.doc.phases);
    this.autosaver.rebase(record.key, record.revision);
    this.syncEditor(cv);
  }

  /** After the full hash: verify/promote the draft identity, then verify sidecars. */
  private async verifyIdentity(cv: Video): Promise<void> {
    const sha = await cv.hashDone;
    if (this.video !== cv || sha === null) return;
    this.applyVideoStatus(cv);
    const fp = cv.fingerprint ?? '';
    const { drafts } = this.deps;

    if (cv.meta.sha256 !== null && cv.meta.sha256 !== sha) {
      // The fingerprint matched a draft of a different video: drop that association.
      const bySha = await drafts.findForVideo({ sha256: sha, fingerprint: fp }).catch(() => null);
      if (this.video !== cv) return;
      const index = cv.index as FrameIndex;
      const fresh = newDraft({ sha256: sha, fingerprint: fp, fileName: cv.name, relPath: cv.relPath, frameCount: index.frameCount, durationUs: index.durationUs });
      if (bySha?.match === 'sha256' && !cv.touched) {
        this.adoptDraft(cv, bySha.record as StoredDraft);
      } else {
        cv.meta = { ...fresh, revision: bySha?.match === 'sha256' ? bySha.record.revision : 0 };
        if (!cv.touched) {
          cv.doc = { segments: [], phases: {} };
          cv.history.clear();
        }
      }
      this.toast('warning', msg('ctl.video.provisionalMismatch'));
    } else if (cv.meta.sha256 === null) {
      cv.deferSaves = true;
      await this.autosaver.flush();
      if (this.video !== cv) return;
      await this.promote(cv, sha);
      if (this.video !== cv) return;
    }
    cv.deferSaves = false;
    if (cv.saveWanted) this.scheduleSave(cv);
    this.set({ video: { ...this.s.video, identity: 'verified' } });
    await this.refreshCheckpoints(cv);
    this.syncEditor(cv);
    await this.verifySidecars(cv);
  }

  private async promote(cv: Video, sha: string): Promise<void> {
    const { drafts, checkpoints } = this.deps;
    const pk = cv.meta.key;
    const result = cv.meta.revision > 0 ? await drafts.promotePending(pk, sha) : ({ kind: 'not_found' } as const);
    if (this.video !== cv) return;
    if (result.kind === 'promoted') {
      cv.meta = { ...cv.meta, key: sha, sha256: sha, revision: result.record.revision, savedAt: result.record.savedAt };
      this.autosaver.rebase(sha, result.record.revision);
      return;
    }
    const existing = (result.kind === 'collision' ? result.collision : await drafts.get(sha).catch(() => null)) as StoredDraft | null;
    if (this.video !== cv) return;
    await checkpoints.rekey(pk, sha).catch(() => 0);
    if (!existing) {
      cv.meta = { ...cv.meta, key: sha, sha256: sha };
      if (cv.touched) cv.saveWanted = true;
      return;
    }
    const keepMine = cv.touched && (result.kind !== 'collision' || result.pending.savedAt >= existing.savedAt);
    if (keepMine) {
      await checkpoints
        .create({ videoKey: sha, name: t('ctl.checkpoint.otherDraft', { file: existing.fileName }), kind: 'auto-before-conflict', segments: existing.segments, phases: existing.phases })
        .catch(() => undefined);
      cv.meta = { ...cv.meta, key: sha, sha256: sha, revision: existing.revision, exported: cv.meta.exported ?? existing.exported };
      this.autosaver.rebase(sha, existing.revision);
      cv.saveWanted = true;
      this.toast('info', msg('ctl.video.collisionKept', { file: existing.fileName }));
    } else {
      if (cv.touched) {
        await checkpoints
          .create({ videoKey: sha, name: t('ctl.checkpoint.otherDraft', { file: cv.meta.fileName }), kind: 'auto-before-conflict', segments: cv.doc.segments, phases: cv.doc.phases })
          .catch(() => undefined);
        this.toast('info', msg('ctl.video.collisionLoaded', { file: existing.fileName }));
      }
      this.adoptDraft(cv, existing);
      cv.history.clear();
    }
    if (result.kind === 'collision') await drafts.delete(pk).catch(() => undefined);
  }

  // ================================================================ sidecars

  private async discoverSidecars(cv: Video): Promise<void> {
    const rec = this.items.get(cv.itemId);
    let refs: SidecarRef[] = [];
    const entry = rec?.entry;
    // List the folder again: the scan is a snapshot, and sidecars written since (our own exports
    // on Next, files the user added) must be found when the video is reopened.
    if (entry && entry.dir.kind === 'virtual') refs = [...entry.sidecars];
    else if (entry) refs = await this.deps.fs.listSidecars(entry.dir, cv.name).catch(() => [...entry.sidecars]);
    else if (cv.dir) refs = await this.deps.fs.listSidecars(cv.dir, cv.name).catch(() => []);
    if (this.video !== cv) return;
    cv.sidecars = refs.map((ref) => ({ ref, parsed: null, status: { name: ref.name, relPath: ref.relPath, state: 'checking', problems: [], segmentCount: null } }));
    this.publishSidecars(cv);
  }

  private publishSidecars(cv: Video): void {
    if (this.video !== cv) return;
    this.set({ video: { ...this.s.video, sidecars: cv.sidecars.map((c) => c.status) } });
    this.applyVideoStatus(cv);
  }

  private async checkSidecar(ref: SidecarRef, sha: string, index: FrameIndex): Promise<SidecarCheck> {
    const base = { name: ref.name, relPath: ref.relPath };
    let text: string;
    try {
      text = await ref.readText();
    } catch (e) {
      return { ref, parsed: null, status: { ...base, state: 'invalid', problems: [msg('ctl.sidecar.readFailed', { file: ref.name, message: errorText(e) })], segmentCount: null } };
    }
    const parsed = parseAnnotationFile(text, ref.name);
    if (!parsed.ok) return { ref, parsed: null, status: { ...base, state: 'invalid', problems: parsed.errors.map(parseErrorMsg), segmentCount: null } };
    const v = verifyAgainstVideo(parsed.file, { sha256: sha, frameCount: index.frameCount, durationUs: index.durationUs, boundaryUs: (b) => boundaryUs(index, b) });
    if (v.ok) return { ref, parsed: parsed.file, status: { ...base, state: 'match', problems: [], segmentCount: parsed.file.records.length } };
    const state = v.problems.some(isIdentityProblem) ? 'mismatch' : 'invalid';
    return { ref, parsed: null, status: { ...base, state, problems: v.problems.map(verifyProblemMsg), segmentCount: parsed.file.records.length } };
  }

  private async verifySidecars(cv: Video): Promise<void> {
    const sha = cv.sha256;
    const index = cv.index;
    if (!sha || !index) return;
    const checks = await Promise.all(cv.sidecars.map((c) => this.checkSidecar(c.ref, sha, index)));
    if (this.video !== cv) return;
    cv.sidecars = checks;
    this.publishSidecars(cv);
    const matches = checks.filter((c) => c.status.state === 'match' && c.parsed);
    if (matches.length === 0) return;
    const best = [...matches].sort((a, b) => b.ref.lastModified - a.ref.lastModified)[0];
    this.offerImport(cv, {
      parsed: best.parsed as ParsedAnnotation,
      label: best.ref.relPath,
      fileName: best.ref.name,
      format: best.ref.format,
      at: best.ref.lastModified,
    }, false);
  }

  /** Builds the doc for a verified file; adds unknown phases to the library. */
  private docFromParsed(parsed: ParsedAnnotation): AnnotationDoc {
    const { segments, phases } = toSegments(parsed);
    const merged = phaseOps.mergeImportedPhases(this.s.library, phases);
    if (merged.added.length) this.setLibrary(merged.library);
    const lib = merged.library;
    const snapshot: Record<string, PhaseDef> = {};
    for (const p of phases) snapshot[p.id] = { id: p.id, name: p.name, color: lib.phases[p.id]?.color ?? phaseOps.PHASE_PALETTE[0] };
    return { segments, phases: snapshot };
  }

  /**
   * A verified file is available: auto-import into an untouched/empty draft, recognise an identical
   * draft as exported, otherwise ask (sidecars) or import with a checkpoint (manual import).
   */
  private offerImport(cv: Video, imp: PendingImport, manual: boolean): void {
    const fileDoc = this.docFromParsed(imp.parsed);
    const fileHash = computeContentHash(fileDoc.segments, fileDoc.phases);
    const draftHash = computeContentHash(cv.doc.segments, cv.doc.phases);
    const baseline = { contentHash: fileHash, at: imp.at, targets: [{ label: imp.label, format: imp.format }] };
    const emptyDraft = cv.doc.segments.length === 0 && (!cv.touched || cv.meta.exported === null);
    if (draftHash === fileHash && (cv.touched || cv.doc.segments.length > 0)) {
      if (cv.meta.exported?.contentHash !== fileHash) {
        cv.meta = { ...cv.meta, exported: baseline };
        if (cv.touched) this.scheduleSave(cv);
      }
      if (manual) this.toast('info', msg('ctl.import.identical', { file: imp.fileName }));
      this.syncEditor(cv);
      return;
    }
    if (!cv.touched || emptyDraft) {
      cv.doc = fileDoc;
      cv.meta = { ...cv.meta, exported: baseline };
      if (manual) {
        cv.touched = true;
        this.scheduleSave(cv);
      } else if (cv.touched) this.scheduleSave(cv);
      if (!manual) cv.history.clear();
      this.set({ editor: { ...this.s.editor, selectedSegmentId: null } });
      this.syncEditor(cv);
      this.toast('success', msg('import.success', { file: imp.fileName }));
      return;
    }
    if (!manual && cv.meta.exported?.contentHash === fileHash) return; // our own last export; draft has newer changes
    cv.pendingImport = imp;
    this.set({
      dialog: { kind: 'import-choice', sidecarName: imp.fileName, fileSegmentCount: fileDoc.segments.length, draftSegmentCount: cv.doc.segments.length },
    });
  }

  private async applyImportReplacing(cv: Video, imp: PendingImport): Promise<void> {
    await this.deps.checkpoints
      .create({ videoKey: cv.meta.key, name: t('ctl.checkpoint.beforeImport', { file: imp.fileName }), kind: 'auto-before-import', segments: cv.doc.segments, phases: cv.doc.phases })
      .catch((e) => this.toast('error', msg('ctl.checkpoint.failed', { message: errorText(e) })));
    if (this.video !== cv) return;
    const doc = this.docFromParsed(imp.parsed);
    this.commitDoc(cv, doc, { selected: null });
    cv.meta = { ...cv.meta, exported: { contentHash: computeContentHash(doc.segments, doc.phases), at: imp.at, targets: [{ label: imp.label, format: imp.format }] } };
    this.scheduleSave(cv);
    this.syncEditor(cv);
    await this.refreshCheckpoints(cv);
    this.toast('success', msg('import.success', { file: imp.fileName }));
  }

  private async waitForSha(cv: Video): Promise<string | null> {
    return cv.sha256 ?? (await cv.hashDone);
  }

  // ================================================================ editor core

  private ensureLibraryHas(phases: Record<string, PhaseDef>): void {
    const entries = Object.values(phases).map((p) => ({ id: p.id, name: p.name }));
    const merged = phaseOps.mergeImportedPhases(this.s.library, entries);
    if (merged.added.length) this.setLibrary(merged.library);
  }

  private snapshot(cv: Video): EditorSnapshot {
    return { doc: cv.doc, pendingStart: this.s.editor.pendingStart };
  }

  /** Records history, replaces the doc, marks touched, schedules autosave, updates the editor. */
  private commitDoc(cv: Video, doc: AnnotationDoc, opts: { pendingStart?: number | null; selected?: string | null; history?: boolean } = {}): void {
    if (opts.history !== false) cv.history.push(this.snapshot(cv));
    cv.doc = doc;
    cv.touched = true;
    cv.exportError = null;
    const editor = { ...this.s.editor };
    if (opts.pendingStart !== undefined) editor.pendingStart = opts.pendingStart;
    if (opts.selected !== undefined) editor.selectedSegmentId = opts.selected;
    if (editor.selectedSegmentId && !doc.segments.some((s) => s.id === editor.selectedSegmentId)) editor.selectedSegmentId = null;
    this.set({ editor });
    this.scheduleSave(cv);
    this.syncEditor(cv);
  }

  private setPending(cv: Video, pendingStart: number | null): void {
    cv.history.push(this.snapshot(cv));
    this.set({ editor: { ...this.s.editor, pendingStart } });
    this.syncEditor(cv);
  }

  private deriveExportStatus(cv: Video, dirty: boolean): ExportStatus {
    if (cv.exporting) return { kind: 'exporting' };
    if (cv.exportError && dirty) return { kind: 'error', msg: cv.exportError };
    if (dirty) return { kind: 'dirty' };
    const ex = cv.meta.exported;
    if (ex && ex.contentHash === computeContentHash(cv.doc.segments, cv.doc.phases)) {
      return { kind: 'exported', at: ex.at, targets: ex.targets.map((x) => x.label) };
    }
    return { kind: 'none' };
  }

  private syncEditor(cv: Video): void {
    if (this.video !== cv) return;
    const lib = this.s.library;
    const dirty = this.isDirty(cv);
    const frameCount = cv.index?.frameCount ?? 0;
    const issues: IssueView[] = frameCount > 0 ? validateForExport(cv.doc.segments, frameCount, phaseExistsIn(cv.doc, lib)).map(issueView) : [];
    this.set({
      editor: {
        ...this.s.editor,
        doc: cv.doc,
        canUndo: cv.history.canUndo,
        canRedo: cv.history.canRedo,
        issues,
        touched: cv.touched,
        dirty,
      },
      exportStatus: this.deriveExportStatus(cv, dirty),
      unexportedCount: this.unexportedCount(),
    });
    this.applyVideoStatus(cv);
  }

  private buildDraft(cv: Video): StoredDraft {
    return {
      ...cv.meta,
      segments: cv.doc.segments,
      phases: cv.doc.phases,
      contentHash: computeContentHash(cv.doc.segments, cv.doc.phases),
      touched: cv.touched,
    };
  }

  /** Whether the video has a usable draft key (pending fingerprint key or sha256). */
  private hasKey(cv: Video): boolean {
    return cv.meta.sha256 !== null || !!cv.fingerprint;
  }

  private scheduleSave(cv: Video): void {
    if (cv.deferSaves || !this.hasKey(cv)) {
      cv.saveWanted = true;
      return;
    }
    cv.saveWanted = false;
    // Show the pending write right away rather than "No changes" during the debounce; errors
    // and conflicts stay visible until resolved.
    const shown = this.s.save.kind;
    if (this.video === cv && shown !== 'error' && shown !== 'conflict' && shown !== 'saving') this.set({ save: { kind: 'saving' } });
    this.autosaver.schedule(() => this.buildDraft(cv));
  }

  private onSaveStatus(st: AutosaveStatus): void {
    const cv = this.video;
    const isCurrent = (key: string | null): boolean => cv !== null && key === cv.meta.key;
    switch (st.state) {
      case 'saving':
        if (isCurrent(st.key)) this.set({ save: { kind: 'saving' } });
        break;
      case 'saved': {
        const rec = this.items.get(cv?.itemId ?? '');
        if (cv && isCurrent(st.key)) {
          cv.meta = { ...cv.meta, revision: st.record.revision, savedAt: st.record.savedAt };
          this.set({ save: { kind: 'saved', at: st.at } });
          if (rec) rec.draft = st.record as StoredDraft;
        } else {
          for (const r of this.items.values()) if (r.sha256 === st.key) r.draft = st.record as StoredDraft;
        }
        break;
      }
      case 'error':
        this.set({ save: { kind: 'error', msg: msg('save.failedDetail', { reason: errorText(st.error) }) } });
        break;
      case 'conflict':
        if (cv && isCurrent(st.key)) {
          this.set({
            save: { kind: 'conflict' },
            stale: { revision: st.stored?.revision ?? 0, savedAt: st.stored?.savedAt ?? this.deps.now() },
          });
        } else {
          this.toast('warning', msg('ctl.save.conflictOther'));
        }
        break;
      default:
        break;
    }
  }

  private onDraftMessage(m: DraftMessage): void {
    const cv = this.video;
    if (!cv) return;
    const key = cv.meta.key;
    if ((m.type === 'draft-saved' && m.key === key && m.revision > cv.meta.revision) || (m.type === 'draft-promoted' && m.from === key)) {
      this.set({ stale: { revision: m.revision, savedAt: this.deps.now() } });
    }
  }

  private async refreshCheckpoints(cv: Video): Promise<void> {
    const key = cv.meta.key;
    if (!this.hasKey(cv)) return;
    const list = await this.deps.checkpoints.list(key).catch(() => []);
    if (this.video !== cv || cv.meta.key !== key) return;
    const checkpoints: CheckpointSummary[] = list.map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt, kind: c.kind, segmentCount: c.segments.length }));
    this.set({ checkpoints });
  }

  // ================================================================ marking

  private readyVideo(): Video | null {
    const cv = this.video;
    if (!cv || !cv.index || this.s.video.loadPhase !== 'ready' || !this.player) return null;
    return cv;
  }

  /** The displayed frame, confirmed by the player; null (with feedback) when it cannot be. */
  private async confirmFrame(cv: Video): Promise<number | null> {
    const player = this.player;
    if (!player) {
      this.feedback('error', msg('mark.err.notReady'));
      return null;
    }
    const snap = player.getSnapshot();
    if (snap.status !== 'ready') {
      this.feedback('error', snap.status === 'error' ? msg('ctl.mark.notConfirmed.decoder', { code: snap.error?.code ?? 'decode_failed' }) : msg('mark.err.notReady'));
      return null;
    }
    if (snap.playing && snap.displayedFrame !== null) return snap.displayedFrame;
    this.feedback('waiting', msg('ctl.mark.waiting'));
    const r = await player.settled(this.settleTimeout);
    if (this.video !== cv || this.player !== player) {
      this.clearWaiting();
      return null;
    }
    if ('error' in r) {
      if (r.error === 'timeout') this.feedback('error', msg('ctl.mark.notConfirmed.timeout'));
      else if (r.error === 'empty' || r.error === 'unloaded') this.feedback('error', msg('mark.err.notReady'));
      else this.feedback('error', msg('ctl.mark.notConfirmed.decoder', { code: r.error }));
      return null;
    }
    return r.frame;
  }

  private async markStart(): Promise<void> {
    const cv = this.readyVideo();
    if (!cv) return this.feedback('error', msg('mark.err.notReady'));
    const frame = await this.confirmFrame(cv);
    if (frame === null || this.video !== cv) return;
    this.setPending(cv, frame);
    this.feedback('ok', msg('ctl.mark.startSet', { frame }));
  }

  private async finish(mode: 'finish' | 'next' | 'end'): Promise<void> {
    const cv = this.readyVideo();
    if (!cv) return this.feedback('error', msg('mark.err.notReady'));
    const phaseId = this.s.selectedPhaseId;
    if (!phaseId || !(phaseId in this.s.library.phases)) return this.feedback('error', msg('mark.err.noPhase'));
    if (this.s.editor.pendingStart === null) return this.feedback('error', msg('mark.err.noPending'));
    const N = (cv.index as FrameIndex).frameCount;
    let end: number;
    if (mode === 'end') {
      end = N;
    } else {
      const frame = await this.confirmFrame(cv);
      if (frame === null || this.video !== cv) return;
      end = frame;
    }
    const start = this.s.editor.pendingStart;
    if (start === null) return this.feedback('error', msg('mark.err.noPending'));
    if (end <= start) return this.feedback('error', msg('mark.err.endBeforeStart', { start }));
    this.addSegmentCommit(cv, phaseId, start, end, mode === 'next' ? end : null, false);
  }

  private addSegmentCommit(cv: Video, phaseId: string, start: number, end: number, nextPending: number | null, replace: boolean): void {
    if (this.video !== cv) return;
    const lib = this.s.library;
    const phase = lib.phases[phaseId];
    if (!phase) return this.feedback('error', msg('mark.err.noPhase'));
    const N = (cv.index as FrameIndex).frameCount;
    const seg: Segment = { id: newSegmentId(), phaseId, start, end };
    const r = addSegment(cv.doc.segments, seg, { frameCount: N, replaceOverlaps: replace });
    if (!r.ok) {
      const m = rejectionMsg(r.reason, start, r.conflicts.length);
      if (r.reason === 'overlap') {
        return this.feedback('error', m, {
          label: msg('mark.replaceOverlapped'),
          run: () => this.guardSync(() => this.addSegmentCommit(cv, phaseId, start, end, nextPending, true), undefined),
        });
      }
      return this.feedback('error', m);
    }
    const doc: AnnotationDoc = { segments: r.segments, phases: snapshotPhases(r.segments, cv.doc.phases, lib, phaseId) };
    this.commitDoc(cv, doc, { pendingStart: nextPending });
    this.useRecent(phaseId);
    const params = { phase: phase.name, start, end, last: end - 1, count: r.replaced.length };
    this.feedback('ok', msg(replace && r.replaced.length ? 'ctl.mark.addedReplacing' : 'mark.added', params));
  }

  /** library.recent gets the phase first; visible chips follow the stable replacement rule. */
  private useRecent(phaseId: string): void {
    const lib = this.s.library;
    const visibleRecent = showInVisibleRecent(this.s.visibleRecent, phaseId, lib.recent);
    const recent = phaseOps.touchRecent(lib.recent, phaseId, RECENT_LIMIT);
    this.set({ visibleRecent });
    if (recent.join('\n') !== lib.recent.join('\n')) this.setLibrary({ ...lib, recent });
  }

  // ================================================================ segment editing

  private async setSegmentBounds(id: string, bounds: { start?: number; end?: number }, opts?: { linkAdjacent?: boolean }): Promise<boolean> {
    const cv = this.readyVideo();
    if (!cv) {
      this.feedback('error', msg('mark.err.notReady'));
      return false;
    }
    const N = (cv.index as FrameIndex).frameCount;
    const link = opts?.linkAdjacent ?? false;
    const target = cv.doc.segments.find((s) => s.id === id);
    if (!target) {
      this.feedback('error', msg('ctl.edit.notFound'));
      return false;
    }
    const dry = updateSegment(cv.doc.segments, id, bounds, N, { linkAdjacent: link });
    if (!dry.ok) {
      this.feedback('error', rejectionMsg(dry.reason, bounds.start ?? target.start, dry.conflicts.length));
      return false;
    }
    // Commit only after the frame at the moved boundary is on screen.
    const moved = bounds.start !== undefined && bounds.start !== target.start ? bounds.start : bounds.end;
    if (moved !== undefined) {
      const player = this.player as P;
      if (player.getSnapshot().playing) player.pause();
      this.feedback('waiting', msg('ctl.mark.waiting'));
      const outcome = await player.seek(Math.min(moved, N - 1));
      if (this.video !== cv) return false;
      if (!outcome.ok) {
        if (outcome.superseded) this.clearWaiting();
        else this.feedback('error', outcome.error === 'not_ready' || outcome.error === 'unloaded' ? msg('mark.err.notReady') : msg('ctl.mark.notConfirmed.decoder', { code: outcome.error }));
        return false;
      }
      const confirmed = await this.confirmFrame(cv);
      if (confirmed === null || this.video !== cv) return false;
    }
    const r = updateSegment(cv.doc.segments, id, bounds, N, { linkAdjacent: link });
    if (!r.ok) {
      this.feedback('error', rejectionMsg(r.reason, bounds.start ?? target.start, r.conflicts.length));
      return false;
    }
    this.commitDoc(cv, { segments: r.segments, phases: cv.doc.phases });
    const seg = r.segments.find((s) => s.id === id) as Segment;
    this.feedback('ok', msg('ctl.edit.boundsUpdated', { start: seg.start, end: seg.end, last: seg.end - 1 }));
    return true;
  }

  private async setSegmentBoundaryToCurrent(id: string, which: 'start' | 'end'): Promise<void> {
    const cv = this.readyVideo();
    if (!cv) return this.feedback('error', msg('mark.err.notReady'));
    const frame = await this.confirmFrame(cv);
    if (frame === null || this.video !== cv) return;
    const N = (cv.index as FrameIndex).frameCount;
    const target = cv.doc.segments.find((s) => s.id === id);
    if (!target) return this.feedback('error', msg('ctl.edit.notFound'));
    const patch = which === 'start' ? { start: frame } : { end: frame };
    const r = updateSegment(cv.doc.segments, id, patch, N);
    if (!r.ok) return this.feedback('error', rejectionMsg(r.reason, which === 'start' ? frame : target.start, r.conflicts.length));
    this.commitDoc(cv, { segments: r.segments, phases: cv.doc.phases });
    const seg = r.segments.find((s) => s.id === id) as Segment;
    this.feedback('ok', msg('ctl.edit.boundsUpdated', { start: seg.start, end: seg.end, last: seg.end - 1 }));
  }

  private relabelSegment(id: string, phaseId: string): void {
    const cv = this.video;
    if (!cv) return;
    const lib = this.s.library;
    const phase = lib.phases[phaseId];
    if (!phase || !cv.doc.segments.some((s) => s.id === id)) return this.feedback('error', msg(phase ? 'ctl.edit.notFound' : 'mark.err.noPhase'));
    const segments = relabelSegmentOp(cv.doc.segments, id, phaseId);
    this.commitDoc(cv, { segments, phases: snapshotPhases(segments, cv.doc.phases, lib, phaseId) });
    this.useRecent(phaseId);
    this.feedback('ok', msg('ctl.edit.relabelled', { phase: phase.name }));
  }

  private deleteSegment(id: string): void {
    const cv = this.video;
    if (!cv || !cv.doc.segments.some((s) => s.id === id)) return;
    const segments = deleteSegmentOp(cv.doc.segments, id);
    this.commitDoc(cv, { segments, phases: snapshotPhases(segments, cv.doc.phases, this.s.library) });
    this.feedback('ok', msg('segments.deleted'));
  }

  private selectSegment(id: string | null, opts?: { seek?: boolean }): void {
    const cv = this.video;
    if (!cv) return;
    const seg = id ? cv.doc.segments.find((s) => s.id === id) : undefined;
    this.set({ editor: { ...this.s.editor, selectedSegmentId: seg ? seg.id : null } });
    if (seg && opts?.seek !== false && this.player && this.s.video.loadPhase === 'ready') {
      this.player.pause();
      void this.player.seek(seg.start);
    }
  }

  private undoRedo(kind: 'undo' | 'redo'): void {
    const cv = this.video;
    if (!cv) return;
    const current = this.snapshot(cv);
    const next = kind === 'undo' ? cv.history.undo(current) : cv.history.redo(current);
    if (!next) return this.feedback('error', msg(kind === 'undo' ? 'mark.nothingToUndo' : 'mark.nothingToRedo'));
    const docChanged = next.doc !== cv.doc;
    this.set({ editor: { ...this.s.editor, pendingStart: next.pendingStart } });
    if (docChanged) this.commitDoc(cv, next.doc, { history: false });
    else this.syncEditor(cv);
    this.feedback('ok', msg(kind === 'undo' ? 'ctl.undo.done' : 'ctl.redo.done'));
  }

  // ================================================================ phases & presets

  private selectPhase(phaseId: string): void {
    const lib = this.s.library;
    if (!(phaseId in lib.phases)) return;
    this.set({ selectedPhaseId: phaseId, visibleRecent: showInVisibleRecent(this.s.visibleRecent, phaseId, lib.recent) });
  }

  private libraryEdit(result: phaseOps.LibraryResult): boolean {
    if (!result.ok) {
      this.toast('error', msg('ctl.preset.failed', { reason: result.reason }));
      return false;
    }
    this.setLibrary(result.library);
    return true;
  }

  private addCustomPhase(name: string, id?: string): { ok: true; id: string } | { ok: false; msg: Msg } {
    const lib = this.s.library;
    const trimmed = name.trim();
    const existing = Object.values(lib.phases).find((p) => p.name.trim().toLowerCase() === trimmed.toLowerCase());
    if (trimmed && existing) return { ok: false, msg: msg('phase.err.nameTaken', { name: existing.name }) };
    const r = phaseOps.addPhase(lib, { name, id });
    if (!r.ok) {
      const reason = r.reason;
      if (reason === 'empty_name') return { ok: false, msg: msg('phase.err.nameRequired') };
      if (reason === 'invalid_id') return { ok: false, msg: msg('phase.err.idInvalid') };
      if (reason === 'duplicate_id') {
        const pid = (id ?? '').trim();
        return { ok: false, msg: msg('phase.err.idTaken', { id: pid, name: lib.phases[pid]?.name ?? pid }) };
      }
      return { ok: false, msg: msg('ctl.preset.failed', { reason }) };
    }
    this.setLibrary(r.library);
    this.selectPhase(r.phase.id);
    return { ok: true, id: r.phase.id };
  }

  private renamePhase(id: string, name: string): void {
    if (!this.libraryEdit(phaseOps.renamePhase(this.s.library, id, name))) return;
    this.refreshDocPhase(id);
  }

  private recolorPhase(id: string, color: string): void {
    if (!this.libraryEdit(phaseOps.recolorPhase(this.s.library, id, color))) return;
    this.refreshDocPhase(id);
  }

  /** Keeps the open doc's phase snapshot in line with a library edit (names reach the export). */
  private refreshDocPhase(id: string): void {
    const cv = this.video;
    const def = this.s.library.phases[id];
    if (!cv || !def || !(id in cv.doc.phases)) return;
    const prev = cv.doc.phases[id];
    if (prev.name === def.name && prev.color === def.color) return;
    cv.doc = { segments: cv.doc.segments, phases: { ...cv.doc.phases, [id]: { ...def } } };
    if (cv.touched) this.scheduleSave(cv);
    this.syncEditor(cv);
  }

  // ================================================================ checkpoints

  private async createCheckpoint(name: string): Promise<void> {
    const cv = this.video;
    if (!cv || !this.hasKey(cv)) return this.toast('error', msg('ctl.checkpoint.noVideo'));
    const finalName = name.trim() || t('checkpoints.defaultName', { time: formatDateTime(this.deps.now(), 'shortDatetime') });
    await this.deps.checkpoints.create({ videoKey: cv.meta.key, name: finalName, kind: 'manual', segments: cv.doc.segments, phases: cv.doc.phases });
    await this.refreshCheckpoints(cv);
    this.toast('success', msg('checkpoints.created', { name: finalName }));
  }

  private async restoreCheckpoint(id: string): Promise<void> {
    const cv = this.video;
    if (!cv || !this.hasKey(cv)) return this.toast('error', msg('ctl.checkpoint.noVideo'));
    const cp = await this.deps.checkpoints.get(id);
    if (this.video !== cv) return;
    if (!cp) return this.toast('error', msg('ctl.checkpoint.notFound'));
    await this.deps.checkpoints.create({
      videoKey: cv.meta.key,
      name: t('ctl.checkpoint.beforeRestore', { name: cp.name }),
      kind: 'auto-before-restore',
      segments: cv.doc.segments,
      phases: cv.doc.phases,
    });
    if (this.video !== cv) return;
    this.ensureLibraryHas(cp.phases);
    this.commitDoc(cv, { segments: cp.segments, phases: cp.phases }, { selected: null });
    await this.refreshCheckpoints(cv);
    this.toast('success', msg('checkpoints.restored', { name: cp.name }));
  }

  private async deleteCheckpoint(id: string): Promise<void> {
    await this.deps.checkpoints.delete(id);
    if (this.video) await this.refreshCheckpoints(this.video);
  }

  // ================================================================ export

  private exportPlace(cv: Video, kind: ExportDestination['kind']): ExportPlace {
    if (kind === 'download') return { kind: 'download' };
    if (kind === 'folder') return { kind: 'folder', root: this.exportFolder, subdirs: cv.subdirs };
    // Read-only virtual folders and browsers without the File System Access API can only download.
    if (cv.dir?.kind === 'virtual' || !this.s.capabilities.fileSystemAccess) return { kind: 'download' };
    return { kind: 'beside', dir: cv.dir };
  }

  private async exportCurrent(opts: { request: boolean; destination?: ExportDestination['kind'] }): Promise<ExportOutcome> {
    const cv = this.video;
    const fail = (m: Msg): ExportOutcome => ({ ok: false, failure: { reason: 'write', msg: m, canDownload: true } });
    if (!cv || !cv.index || cv.loadFailed) return fail(msg('ctl.export.notReady'));
    const index = cv.index;
    cv.exporting = true;
    this.syncEditor(cv);
    try {
      const sha = await this.waitForSha(cv);
      if (this.video !== cv) return fail(msg('ctl.export.notReady'));
      if (!sha) {
        cv.exportError = msg('ctl.export.hashFailed');
        return fail(cv.exportError);
      }
      const doc = cv.doc;
      const lib = this.s.library;
      const issues = validateForExport(doc.segments, index.frameCount, phaseExistsIn(doc, lib));
      if (issues.length) {
        cv.exportError = msg('ctl.export.validation', { count: issues.length });
        return { ok: false, failure: { reason: 'validation', issues: issues.map(issueView) } };
      }
      const kind = opts.destination ?? this.s.settings.exportDestination.kind;
      const place = this.exportPlace(cv, kind);
      const r = await runExport(this.deps.fs, {
        video: { sha256: sha, frameCount: index.frameCount, durationUs: index.durationUs, fileName: cv.name },
        segments: doc.segments,
        phaseNameOf: (id) => doc.phases[id]?.name ?? lib.phases[id]?.name,
        boundaryUs: (b) => boundaryUs(index, b),
        formats: formatsFor(this.s.settings.exportFormat),
        place,
        request: opts.request,
      });
      if (!r.ok) {
        cv.exportError = r.msg;
        return fail(r.msg);
      }
      cv.exportError = null;
      cv.touched = true;
      cv.meta = { ...cv.meta, exported: { contentHash: computeContentHash(doc.segments, doc.phases), at: this.deps.now(), targets: r.targets } };
      this.unexported.delete(cv.meta.key);
      if (this.video === cv) {
        this.scheduleSave(cv);
        void this.autosaver.flush();
      }
      const files = r.targets.map((x) => x.label).join(', ');
      this.toast('success', msg(place.kind === 'download' ? 'export.downloaded' : 'export.success', { file: files }));
      return { ok: true };
    } finally {
      cv.exporting = false;
      this.syncEditor(cv);
    }
  }

  private async setExportFolder(dir: HandleDirRef): Promise<void> {
    this.exportFolder = dir;
    await this.deps.handles.put(EXPORT_FOLDER_HANDLE_ID, dir.handle).catch(() => undefined);
    this.set({ settings: { ...this.s.settings, exportDestination: { kind: 'folder', folderName: dir.name } } });
    this.persistSettings();
  }

  private async resolveSwitchFailure(choice: 'download-and-switch' | 'choose-folder' | 'switch-without-export' | 'stay'): Promise<void> {
    const pending = this.pendingSwitch;
    const dialog = this.s.dialog;
    if (choice === 'stay' || !pending) {
      this.pendingSwitch = null;
      if (dialog?.kind === 'switch-failed') this.set({ dialog: null });
      return;
    }
    if (choice === 'switch-without-export') {
      const cv = this.video;
      if (cv && this.isDirty(cv)) this.unexported.add(cv.meta.key);
      this.pendingSwitch = null;
      this.set({ dialog: null, unexportedCount: this.unexportedCount() });
      await pending.run();
      return;
    }
    let destination: ExportDestination['kind'] = 'download';
    if (choice === 'choose-folder') {
      const dir = await this.deps.fs.pickExportFolder();
      if (!dir) return;
      await this.setExportFolder(dir);
      destination = 'folder';
    }
    const r = await this.exportCurrent({ request: true, destination });
    if (!r.ok) {
      this.set({ dialog: { kind: 'switch-failed', targetItemId: pending.targetItemId, failure: r.failure } });
      return;
    }
    this.pendingSwitch = null;
    this.set({ dialog: null });
    await pending.run();
  }

  // ================================================================ stale tab

  private async resolveStale(choice: 'load-newer' | 'keep-mine'): Promise<void> {
    const cv = this.video;
    if (!cv) return this.set({ stale: null });
    const key = cv.meta.key;
    const stored = ((await this.deps.drafts.get(key).catch(() => null)) as StoredDraft | null) ?? null;
    if (this.video !== cv) return;
    const { checkpoints } = this.deps;
    if (choice === 'load-newer') {
      await checkpoints
        .create({ videoKey: key, name: t('ctl.checkpoint.mineBeforeNewer'), kind: 'auto-before-conflict', segments: cv.doc.segments, phases: cv.doc.phases })
        .catch(() => undefined);
      this.autosaver.discardPending();
      cv.saveWanted = false;
      if (stored) {
        cv.history.push(this.snapshot(cv));
        cv.meta = { ...stored, fileName: cv.name, relPath: cv.relPath };
        cv.doc = { segments: stored.segments, phases: stored.phases };
        cv.touched = stored.touched ?? true;
        this.ensureLibraryHas(cv.doc.phases);
      }
      await this.autosaver.resolveConflict(key, stored?.revision ?? 0);
      this.set({ stale: null, save: stored ? { kind: 'saved', at: stored.savedAt } : { kind: 'idle' } });
      this.toast('info', msg('ctl.stale.loaded'));
    } else {
      if (stored) {
        await checkpoints
          .create({ videoKey: key, name: t('ctl.checkpoint.otherTab', { revision: stored.revision }), kind: 'auto-before-conflict', segments: stored.segments, phases: stored.phases })
          .catch(() => undefined);
      }
      cv.meta = { ...cv.meta, revision: stored?.revision ?? 0 };
      this.set({ stale: null });
      this.autosaver.schedule(() => this.buildDraft(cv));
      await this.autosaver.resolveConflict(key, stored?.revision ?? 0);
      this.toast('info', msg('ctl.stale.kept'));
    }
    await this.refreshCheckpoints(cv);
    this.syncEditor(cv);
  }

  // ================================================================ opening

  private async openFile(): Promise<void> {
    const src = await this.deps.fs.pickVideoFile();
    if (!src) return;
    await this.openSource(src);
  }

  private async openSource(src: VideoSource): Promise<void> {
    await this.switchGate(null, () => this.openSingle(src));
  }

  private async openRoot(root: DirRef): Promise<void> {
    await this.switchGate(null, () => this.openFolderRoot(root));
  }

  private async openFolder(): Promise<void> {
    const root = await this.deps.fs.pickFolder();
    if (!root) return;
    await this.openRoot(root);
  }

  private async openDropped(dt: DataTransfer): Promise<void> {
    // handleDrop must read the DataTransfer synchronously, before any await.
    const pending = this.deps.fs.handleDrop(dt);
    const r = await pending;
    if (r.kind === 'unsupported') return this.toast('warning', msg('ctl.drop.notVideo'));
    if (r.kind === 'file') await this.openSource(r.source);
    else await this.openRoot(r.root);
  }

  private async reconnectFolder(): Promise<void> {
    const handle = this.rememberedFolder ?? (await this.deps.handles.get(LAST_FOLDER_HANDLE_ID).catch(() => null));
    if (!handle) return;
    const { fs } = this.deps;
    let access: 'readwrite' | 'read' | null = null;
    if (await fs.ensurePermission(handle, 'readwrite', { request: true })) access = 'readwrite';
    else if (await fs.ensurePermission(handle, 'read', { request: true })) access = 'read';
    if (!access) {
      this.toast('warning', msg('folder.denied'));
      this.set({ batch: { ...this.s.batch, access: 'needs-permission', rootName: handle.name } });
      return;
    }
    await this.switchGate(null, () => this.openFolderRoot(handleDir(handle), access));
  }

  private async requestSourceFolderAccess(): Promise<void> {
    const cv = this.video;
    if (!cv) return;
    if (!cv.fileHandle) return this.set({ video: { ...this.s.video, sourceFolder: 'unsupported' } });
    const r = await this.deps.fs.requestSourceFolder(cv.fileHandle);
    if (this.video !== cv) return;
    if (!r.ok) {
      if (r.reason === 'unsupported') this.set({ video: { ...this.s.video, sourceFolder: 'unsupported' } });
      if (r.reason === 'not_containing') this.toast('warning', msg('folder.wrongFolder'));
      else if (r.reason === 'error') this.toast('error', msg('folder.denied'));
      return;
    }
    cv.dir = r.dir;
    const rec = this.items.get(cv.itemId);
    if (rec?.source) rec.source = { ...rec.source, parent: r.dir };
    this.set({ video: { ...this.s.video, sourceFolder: 'available' }, batch: { ...this.s.batch, access: r.writable ? 'readwrite' : 'read' } });
    await this.discoverSidecars(cv);
    if (this.video === cv && cv.sha256) await this.verifySidecars(cv);
  }

  private async navigate(delta: 1 | -1): Promise<void> {
    const b = this.s.batch;
    const i = b.items.findIndex((it) => it.id === b.currentId);
    const target = b.items[i + delta];
    if (i < 0 || !target) return;
    await this.selectVideo(target.id);
  }

  private async selectVideo(itemId: string): Promise<void> {
    if (itemId === this.s.batch.currentId && this.video) return;
    if (!this.items.has(itemId)) return;
    await this.switchGate(itemId, () => this.openVideo(itemId));
  }

  /**
   * Close folder (SPEC §7.8). With unexported changes the first call opens the
   * `confirm-close-batch` dialog; calling it again while that dialog is open is the user's
   * "Leave anyway" and closes without exporting (drafts stay saved in this browser).
   */
  private async closeBatch(): Promise<void> {
    const close = async (): Promise<void> => {
      await this.leaveCurrent();
      this.batchGen++;
      this.scanAbort?.abort();
      this.bgAbort?.abort();
      this.items = new Map();
      this.set({ batch: emptyBatch(), dialog: null, unexportedCount: this.unexportedCount() });
    };
    if (this.s.dialog?.kind === 'confirm-close-batch') {
      this.set({ dialog: null });
      await close();
      return;
    }
    const count = this.unexportedCount();
    if (count > 0) {
      this.set({ dialog: { kind: 'confirm-close-batch', unexportedCount: count } });
      return;
    }
    await this.switchGate(null, close);
  }

  // ================================================================ import

  private async importFromFile(): Promise<void> {
    const cv = this.video;
    if (!cv) return this.toast('error', msg('ctl.export.notReady'));
    const file = await this.deps.fs.pickAnnotationFile();
    if (!file || this.video !== cv) return;
    const text = await file.text();
    await this.importText(cv, text, file.name, file.name, file.lastModified);
  }

  private async importText(cv: Video, text: string, fileName: string, label: string, at: number): Promise<void> {
    const parsed = parseAnnotationFile(text, fileName);
    if (!parsed.ok) return this.toast('error', parsed.errors.length ? parseErrorMsg(parsed.errors[0]) : msg('import.failed', { file: fileName }));
    const sha = await this.waitForSha(cv);
    if (this.video !== cv || !cv.index) return;
    if (!sha) return this.toast('error', msg('ctl.export.hashFailed'));
    const index = cv.index;
    const v = verifyAgainstVideo(parsed.file, { sha256: sha, frameCount: index.frameCount, durationUs: index.durationUs, boundaryUs: (b) => boundaryUs(index, b) });
    if (!v.ok) {
      return this.toast('error', msg('ctl.import.rejected', { file: fileName, count: v.problems.length }), {
        action: { label: msg('common.details'), run: () => this.toast('info', verifyProblemMsg(v.problems[0]), { timeout: null }) },
      });
    }
    this.offerImport(cv, { parsed: parsed.file, label, fileName, format: parsed.file.format, at }, true);
  }

  private async importSidecar(relPath: string): Promise<void> {
    const cv = this.video;
    if (!cv) return;
    const check = cv.sidecars.find((c) => c.ref.relPath === relPath);
    if (!check) return this.toast('error', msg('import.failed', { file: relPath }));
    let text: string;
    try {
      text = await check.ref.readText();
    } catch (e) {
      return this.toast('error', msg('ctl.sidecar.readFailed', { file: check.ref.name, message: errorText(e) }));
    }
    if (this.video !== cv) return;
    await this.importText(cv, text, check.ref.name, check.ref.relPath, check.ref.lastModified);
  }

  private async resolveImportChoice(choice: 'use-file' | 'keep-draft'): Promise<void> {
    const cv = this.video;
    const imp = cv?.pendingImport ?? null;
    if (this.s.dialog?.kind === 'import-choice') this.set({ dialog: null });
    if (!cv || !imp) return;
    cv.pendingImport = null;
    if (choice === 'use-file') await this.applyImportReplacing(cv, imp);
  }

  // ================================================================ settings & ui

  private setSort(key: SortKey, dir?: SortDir): void {
    const cur = this.s.settings.sort;
    const nextDir: SortDir = dir ?? (cur.key === key ? (cur.dir === 'asc' ? 'desc' : 'asc') : 'asc');
    this.set({ settings: { ...this.s.settings, sort: { key, dir: nextDir } } });
    this.set({ batch: { ...this.s.batch, items: this.sortedItems(this.s.batch.items) } });
    this.persistSettings();
  }

  private setLanguage(lang: Lang): void {
    setLang(lang);
    this.set({ settings: { ...this.s.settings, language: lang } });
    this.persistSettings();
  }

  private closeDialog(): void {
    const d = this.s.dialog;
    if (d?.kind === 'import-choice' && this.video) this.video.pendingImport = null;
    if (d?.kind === 'switch-failed') this.pendingSwitch = null;
    this.set({ dialog: null });
  }

  private dismissToast(id: number): void {
    if (this.s.toasts.some((x) => x.id === id)) this.set({ toasts: this.s.toasts.filter((x) => x.id !== id) });
  }

  // ================================================================ public surface

  private buildActions(): Actions {
    const a = <A extends unknown[]>(fn: (...args: A) => Promise<void>) => (...args: A): Promise<void> => this.guard(() => fn(...args), undefined);
    const s = <A extends unknown[], R>(fn: (...args: A) => R, fallback: R) => (...args: A): R => this.guardSync(() => fn(...args), fallback);
    return {
      init: a(() => this.init()),
      attachCanvas: s((c: HTMLCanvasElement | null) => this.attachCanvas(c), undefined),

      openFile: a(() => this.openFile()),
      openFolder: a(() => this.openFolder()),
      openDropped: a((dt: DataTransfer) => this.openDropped(dt)),
      reconnectFolder: a(() => this.reconnectFolder()),
      requestSourceFolderAccess: a(() => this.requestSourceFolderAccess()),
      selectVideo: a((id: string) => this.selectVideo(id)),
      nextVideo: a(() => this.navigate(1)),
      prevVideo: a(() => this.navigate(-1)),
      setSort: s((key: SortKey, dir?: SortDir) => this.setSort(key, dir), undefined),
      closeBatch: a(() => this.closeBatch()),

      markStart: a(() => this.markStart()),
      markFinish: a(() => this.finish('finish')),
      markFinishAndNext: a(() => this.finish('next')),
      markThroughEnd: a(() => this.finish('end')),
      cancelPendingStart: s(() => {
        const cv = this.video;
        if (cv && this.s.editor.pendingStart !== null) {
          this.setPending(cv, null);
          this.feedback('ok', msg('ctl.mark.pendingCleared'));
        }
      }, undefined),
      selectPhase: s((id: string) => this.selectPhase(id), undefined),
      selectRecentSlot: s((slot: number) => {
        const id = this.s.visibleRecent[slot - 1];
        if (id) this.selectPhase(id);
      }, undefined),

      selectSegment: s((id: string | null, opts?: { seek?: boolean }) => this.selectSegment(id, opts), undefined),
      relabelSegment: s((id: string, phaseId: string) => this.relabelSegment(id, phaseId), undefined),
      setSegmentBounds: (id, bounds, opts) => this.guard(() => this.setSegmentBounds(id, bounds, opts), false),
      setSegmentBoundaryToCurrent: a((id: string, which: 'start' | 'end') => this.setSegmentBoundaryToCurrent(id, which)),
      deleteSegment: s((id: string) => this.deleteSegment(id), undefined),
      undo: s(() => this.undoRedo('undo'), undefined),
      redo: s(() => this.undoRedo('redo'), undefined),

      addCustomPhase: (name, id) => this.guardSync(() => this.addCustomPhase(name, id), { ok: false, msg: msg('ctl.preset.failed', { reason: 'error' }) }),
      renamePhase: s((id: string, name: string) => this.renamePhase(id, name), undefined),
      recolorPhase: s((id: string, color: string) => this.recolorPhase(id, color), undefined),
      createPreset: (name) =>
        this.guardSync(() => {
          const r = phaseOps.createPreset(this.s.library, name);
          if (!this.libraryEdit(r) || !r.ok) return '';
          return r.preset.id;
        }, ''),
      renamePreset: s((id: string, name: string) => void this.libraryEdit(phaseOps.renamePreset(this.s.library, id, name)), undefined),
      deletePreset: s((id: string) => this.setLibrary(phaseOps.deletePreset(this.s.library, id)), undefined),
      setPresetPhases: s((id: string, ids: string[]) => void this.libraryEdit(phaseOps.setPresetPhases(this.s.library, id, ids)), undefined),
      setActivePreset: s((id: string | null) => {
        if (!this.libraryEdit(phaseOps.setActivePreset(this.s.library, id))) return;
        // Chips that only show the preset (nothing used yet) follow the newly active preset.
        if (this.s.library.recent.length === 0) this.set({ visibleRecent: visibleFor(this.s.library) });
      }, undefined),
      clearRecent: s(() => {
        const lib = phaseOps.clearRecent(this.s.library);
        this.setLibrary(lib);
        this.set({ visibleRecent: visibleFor(lib) });
      }, undefined),

      createCheckpoint: a((name: string) => this.createCheckpoint(name)),
      restoreCheckpoint: a((id: string) => this.restoreCheckpoint(id)),
      deleteCheckpoint: a((id: string) => this.deleteCheckpoint(id)),

      exportNow: () =>
        this.guard(async () => {
          const r = await this.exportCurrent({ request: true });
          if (!r.ok) {
            const m = r.failure.reason === 'write' ? r.failure.msg : r.failure.reason === 'validation' ? msg('ctl.export.validation', { count: r.failure.issues.length }) : msg('switch.hashPending');
            this.toast('error', m);
          }
          return r.ok;
        }, false),
      setExportFormat: s((f: AppState['settings']['exportFormat']) => {
        this.set({ settings: { ...this.s.settings, exportFormat: f } });
        this.persistSettings();
      }, undefined),
      setExportDestination: a(async (kind: ExportDestination['kind']) => {
        if (kind === 'folder') {
          const dir = await this.deps.fs.pickExportFolder();
          if (dir) await this.setExportFolder(dir);
          return;
        }
        this.set({ settings: { ...this.s.settings, exportDestination: { kind } } });
        this.persistSettings();
      }),
      importFromFile: a(() => this.importFromFile()),
      importSidecar: a((relPath: string) => this.importSidecar(relPath)),
      resolveImportChoice: a((c: 'use-file' | 'keep-draft') => this.resolveImportChoice(c)),
      resolveSwitchFailure: a((c: 'download-and-switch' | 'choose-folder' | 'switch-without-export' | 'stay') => this.resolveSwitchFailure(c)),
      resolveStale: a((c: 'load-newer' | 'keep-mine') => this.resolveStale(c)),
      retrySave: s(() => void this.autosaver.retry(), undefined),

      setLanguage: s((lang: Lang) => this.setLanguage(lang), undefined),
      openDialog: s((d: DialogState) => this.set({ dialog: d }), undefined),
      closeDialog: s(() => this.closeDialog(), undefined),
      dismissToast: s((id: number) => this.dismissToast(id), undefined),
      setBottomPanelHeight: s((px: number) => {
        const h = Math.max(120, Math.min(2000, Math.round(px)));
        if (h === this.s.settings.bottomPanelHeight) return;
        this.set({ settings: { ...this.s.settings, bottomPanelHeight: h } });
        this.persistSettings();
      }, undefined),
    };
  }

  api(): ControllerApi<P> {
    const actions = this.buildActions();
    return {
      store: this.store,
      actions,
      getPlayer: () => this.player,
      onPlayerChange: (fn) => {
        this.playerListeners.add(fn);
        return () => this.playerListeners.delete(fn);
      },
      getFrameIndex: () => this.video?.index ?? null,
      getCanvas: () => this.canvas,
      getThumbnail: (frame) => this.player?.peekThumbnail(frame) ?? null,
      openDirectoryHandle: (handle) => this.guard(() => this.openRoot(handleDir(handle)), undefined),
      openFileHandle: (handle, parent) =>
        this.guard(async () => {
          const file = await handle.getFile();
          await this.openSource({ name: file.name, fileHandle: handle, file, parent: parent ? handleDir(parent) : null, relPath: null });
        }, undefined),
      openSource: (source) => this.guard(() => this.openSource(source), undefined),
      openRoot: (root) => this.guard(() => this.openRoot(root), undefined),
      setExportFolderHandle: (handle) => this.guard(() => this.setExportFolder(handleDir(handle)), undefined),
      flushAutosave: () => this.autosaver.flush(),
      whenIdle: async () => {
        for (let i = 0; i < 3; i++) {
          await this.video?.lifecycle;
          await this.bgWork;
          await this.autosaver.flush();
        }
      },
      dispose: () => {
        for (const c of this.cleanups.splice(0)) c();
        this.autosaver.dispose();
        this.bgAbort?.abort();
        this.scanAbort?.abort();
        this.video?.abort.abort();
        this.player?.dispose();
      },
    };
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type { MessageKey };
