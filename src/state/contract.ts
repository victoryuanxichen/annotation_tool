/**
 * Contract between the application controller (src/state/**) and the UI (src/ui/**).
 * The UI reads state with `useApp(selector)` and calls `actions.*`; it never touches storage,
 * the file system or export code directly. Player rendering/seeking goes through `getPlayer()`.
 *
 * Message fields hold i18n keys (src/i18n/en.ts) + params, never pre-translated text, so the
 * language can switch at any time.
 */
import type { Segment, PhaseDef, PhaseLibrary, ExportFormatChoice } from '../core/types';

export type Lang = 'en' | 'zh-Hant';
export type Params = Record<string, string | number>;
export interface Msg {
  key: string;
  params?: Params;
}

// ---------------------------------------------------------------- batch
export type BatchStatus =
  | 'annotated' // verified sidecar matches, or the draft was exported and is unchanged since
  | 'draft' // local draft with changes not yet exported
  | 'unannotated' // nothing found
  | 'unverified' // sidecar candidate(s) present, not yet verified against the video hash
  | 'mismatch' // sidecar present but belongs to another video / fails verification
  | 'error'; // video cannot be indexed/decoded

export interface BatchItem {
  /** Relative path within the opened folder (forward slashes); unique within the batch. */
  id: string;
  relPath: string;
  name: string;
  size: number;
  lastModified: number;
  status: BatchStatus;
  statusDetail: Msg | null;
  sha256: string | null;
  segmentCount: number | null;
}

export type SortKey = 'name' | 'mtime' | 'size';
export type SortDir = 'asc' | 'desc';

export interface BatchState {
  mode: 'none' | 'file' | 'folder';
  rootName: string | null;
  /** Sorted by settings.sort. Prev/Next follow this order. */
  items: BatchItem[];
  currentId: string | null;
  scanning: boolean;
  scannedCount: number;
  /**
   * Background sidecar verification progress. `current` (0…1) is the hashing progress of the file
   * being verified now, so a bar can show (done + current) / total while a large file hashes.
   */
  verifying: { done: number; total: number; current?: number } | null;
  /** Write access to the source folder(s). 'virtual' = opened without File System Access API. */
  access: 'readwrite' | 'read' | 'needs-permission' | 'none' | 'virtual';
}

// ---------------------------------------------------------------- current video
export type LoadPhase = 'idle' | 'indexing' | 'loading' | 'ready' | 'error';

export interface SidecarStatus {
  name: string;
  relPath: string;
  state: 'checking' | 'match' | 'mismatch' | 'invalid';
  /** Problems found during verification (sha/frame count/duration/boundaries/parse). */
  problems: Msg[];
  segmentCount: number | null;
}

export interface VideoState {
  itemId: string | null;
  fileName: string | null;
  relPath: string | null;
  loadPhase: LoadPhase;
  error: Msg | null;
  frameCount: number;
  durationUs: number;
  /** Display only. */
  averageFps: number;
  variableFrameRate: boolean;
  width: number;
  height: number;
  hash: { state: 'idle' | 'hashing' | 'done' | 'error'; progress: number; sha256: string | null };
  /** How the draft was matched: by quick fingerprint (provisional) or by full SHA-256 (verified). */
  identity: 'none' | 'provisional' | 'verified';
  /** For single-file opens: whether the source folder is reachable for sidecars/exports. */
  sourceFolder: 'available' | 'needs-access' | 'unsupported';
  sidecars: SidecarStatus[];
  /** Index warnings (edit list, duplicate timestamps …) as messages. */
  warnings: Msg[];
}

// ---------------------------------------------------------------- editor
export interface AnnotationDoc {
  /** Sorted by start. Half-open [start, end). */
  segments: Segment[];
  /** Snapshot of every phase referenced by segments. */
  phases: Record<string, PhaseDef>;
}

export interface IssueView {
  code: 'overlap' | 'out_of_range' | 'empty' | 'invalid_phase' | 'not_integer';
  segmentIds: string[];
  msg: Msg;
}

export interface EditorState {
  doc: AnnotationDoc;
  pendingStart: number | null;
  selectedSegmentId: string | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Live validation of doc (same rules as export). */
  issues: IssueView[];
  /** The user has edited this video's annotations (persisted with the draft). */
  touched: boolean;
  /** touched && content differs from the last successful export / verified import. */
  dirty: boolean;
}

export type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; msg: Msg }
  | { kind: 'conflict' };

export type ExportStatus =
  | { kind: 'none' } // nothing to export yet (untouched)
  | { kind: 'dirty' } // unexported changes
  | { kind: 'exporting' }
  | { kind: 'exported'; at: number; targets: string[] }
  | { kind: 'error'; msg: Msg };

export interface MarkFeedback {
  /** Increments on each new message so the UI can re-announce identical text. */
  seq: number;
  kind: 'ok' | 'error' | 'waiting';
  msg: Msg;
  /** Optional one-click remedy, e.g. "Replace overlapped frames". */
  action?: { label: Msg; run: () => void };
}

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  msg: Msg;
  action?: { label: Msg; run: () => void };
  /** ms; null = sticky until dismissed. */
  timeout: number | null;
}

export interface CheckpointSummary {
  id: string;
  name: string;
  createdAt: number;
  kind: 'manual' | 'auto-before-restore' | 'auto-before-import' | 'auto-before-conflict';
  segmentCount: number;
}

export type ExportDestination =
  | { kind: 'beside' }
  | { kind: 'folder'; folderName: string }
  | { kind: 'download' };

export interface Settings {
  language: Lang;
  exportFormat: ExportFormatChoice;
  exportDestination: ExportDestination;
  sort: { key: SortKey; dir: SortDir };
  bottomPanelHeight: number;
}

export type SwitchFailure =
  | { reason: 'validation'; issues: IssueView[] }
  | { reason: 'write'; msg: Msg; canDownload: true }
  | { reason: 'hash_pending' };

export type DialogState =
  | { kind: 'help' }
  | { kind: 'presets' }
  | { kind: 'switch-failed'; targetItemId: string | null; failure: SwitchFailure }
  | {
      kind: 'import-choice';
      sidecarName: string;
      fileSegmentCount: number;
      draftSegmentCount: number;
    }
  | { kind: 'confirm-close-batch'; unexportedCount: number }
  | { kind: 'checkpoint-name'; defaultName: string };

export interface StaleBanner {
  /** Revision saved by another tab. */
  revision: number;
  savedAt: number;
}

export interface AppState {
  ready: boolean; // settings + library loaded
  capabilities: { fileSystemAccess: boolean; webCodecs: boolean; persistentStorage: boolean | null };
  settings: Settings;
  library: PhaseLibrary;
  selectedPhaseId: string | null;
  /**
   * Chip order shown directly in the phase panel (max 10). Stable while working and across video
   * switches (slots are kept when a video opens; free slots are topped up from library.recent and
   * the active preset); a newly used phase not shown replaces the least recent visible chip in
   * place, so other chips never move. Rebuilt from library.recent only by "Clear recent".
   */
  visibleRecent: string[];
  batch: BatchState;
  video: VideoState;
  editor: EditorState;
  checkpoints: CheckpointSummary[];
  save: SaveStatus;
  exportStatus: ExportStatus;
  stale: StaleBanner | null;
  markFeedback: MarkFeedback | null;
  toasts: Toast[];
  dialog: DialogState | null;
  /** Videos opened this session whose changes were never exported (for the leave warning). */
  unexportedCount: number;
}

// ---------------------------------------------------------------- actions
export interface Actions {
  // lifecycle
  init(): Promise<void>;
  attachCanvas(canvas: HTMLCanvasElement | null): void;

  // files & batch
  openFile(): Promise<void>;
  openFolder(): Promise<void>;
  openDropped(dt: DataTransfer): Promise<void>;
  /** Re-request permission for a remembered folder (needs a user gesture). */
  reconnectFolder(): Promise<void>;
  requestSourceFolderAccess(): Promise<void>;
  /** Switch video with the export gate (SPEC §7.7). */
  selectVideo(itemId: string): Promise<void>;
  nextVideo(): Promise<void>;
  prevVideo(): Promise<void>;
  setSort(key: SortKey, dir?: SortDir): void;
  closeBatch(): Promise<void>;

  // marking (all commit only after the player confirms the displayed frame)
  markStart(): Promise<void>;
  markFinish(): Promise<void>;
  markFinishAndNext(): Promise<void>;
  markThroughEnd(): Promise<void>;
  cancelPendingStart(): void;
  selectPhase(phaseId: string): void;
  /** 1-based slot in visibleRecent. */
  selectRecentSlot(slot: number): void;

  // segment editing
  selectSegment(id: string | null, opts?: { seek?: boolean }): void;
  relabelSegment(id: string, phaseId: string): void;
  /** Absolute boundary edit (validated; linkAdjacent moves a shared neighbour boundary too). */
  setSegmentBounds(id: string, bounds: { start?: number; end?: number }, opts?: { linkAdjacent?: boolean }): Promise<boolean>;
  /** Sets start or end of a segment to the confirmed displayed frame. */
  setSegmentBoundaryToCurrent(id: string, which: 'start' | 'end'): Promise<void>;
  deleteSegment(id: string): void;
  undo(): void;
  redo(): void;

  // phases & presets
  addCustomPhase(name: string, id?: string): { ok: true; id: string } | { ok: false; msg: Msg };
  renamePhase(id: string, name: string): void;
  recolorPhase(id: string, color: string): void;
  createPreset(name: string): string;
  renamePreset(id: string, name: string): void;
  deletePreset(id: string): void;
  setPresetPhases(id: string, phaseIds: string[]): void;
  setActivePreset(id: string | null): void;
  clearRecent(): void;

  // checkpoints
  createCheckpoint(name: string): Promise<void>;
  restoreCheckpoint(id: string): Promise<void>;
  deleteCheckpoint(id: string): Promise<void>;

  // export / import
  exportNow(): Promise<boolean>;
  setExportFormat(f: ExportFormatChoice): void;
  /** 'folder' opens a picker. */
  setExportDestination(kind: ExportDestination['kind']): Promise<void>;
  importFromFile(): Promise<void>;
  importSidecar(relPath: string): Promise<void>;
  resolveImportChoice(choice: 'use-file' | 'keep-draft'): Promise<void>;
  resolveSwitchFailure(choice: 'download-and-switch' | 'choose-folder' | 'switch-without-export' | 'stay'): Promise<void>;
  resolveStale(choice: 'load-newer' | 'keep-mine'): Promise<void>;
  retrySave(): void;

  // ui
  setLanguage(lang: Lang): void;
  openDialog(d: DialogState): void;
  closeDialog(): void;
  dismissToast(id: number): void;
  setBottomPanelHeight(px: number): void;
}

/**
 * Module exports that src/state/index.ts MUST provide (implemented by the controller):
 *
 *   export const useApp: <T>(selector: (s: AppState) => T) => T;   // zustand hook (use shallow/useShallow for objects)
 *   export const appStore: { getState(): AppState; subscribe(fn): () => void };
 *   export const actions: Actions;
 *   export function getPlayer(): FramePlayer | null;               // src/player FramePlayer
 *   export function usePlayerSnapshot(): PlayerSnapshot;           // re-renders at most once per animation frame
 *   export function getFrameIndex(): FrameIndex | null;            // current video's index (ptsUs, durationUs …)
 *   export function getThumbnail(frame: number): { frame: number; bitmap: ImageBitmap } | null;
 *     // scrub preview: decoded keyframe at or before `frame` (never a later picture) + its frame number
 *
 * Player commands from the UI (play/pause/seek/step/rate) call getPlayer() directly; marking and
 * boundary edits go through actions so the controller can confirm the displayed frame first.
 */
