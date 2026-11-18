import { createDefaultLibrary } from '../core/phases';
import type { AppState, BatchState, EditorState, Settings, VideoState } from './contract';

export const DEFAULT_APP_SETTINGS: Settings = {
  language: 'en',
  theme: 'dark',
  exportFormat: 'csv',
  exportDestination: { kind: 'beside' },
  sort: { key: 'name', dir: 'asc' },
  bottomPanelHeight: 260,
};

export function emptyBatch(): BatchState {
  return { mode: 'none', rootName: null, items: [], currentId: null, scanning: false, scannedCount: 0, verifying: null, access: 'none' };
}

export function emptyVideo(): VideoState {
  return {
    itemId: null,
    fileName: null,
    relPath: null,
    loadPhase: 'idle',
    error: null,
    frameCount: 0,
    durationUs: 0,
    averageFps: 0,
    variableFrameRate: false,
    width: 0,
    height: 0,
    hash: { state: 'idle', progress: 0, sha256: null },
    identity: 'none',
    sourceFolder: 'unsupported',
    sidecars: [],
    warnings: [],
  };
}

export function emptyEditor(): EditorState {
  return {
    doc: { segments: [], phases: {} },
    pendingStart: null,
    selectedSegmentId: null,
    canUndo: false,
    canRedo: false,
    issues: [],
    touched: false,
    dirty: false,
  };
}

export function createInitialState(): AppState {
  return {
    ready: false,
    capabilities: { fileSystemAccess: false, webCodecs: false, persistentStorage: null },
    settings: { ...DEFAULT_APP_SETTINGS },
    library: createDefaultLibrary(),
    selectedPhaseId: null,
    visibleRecent: [],
    batch: emptyBatch(),
    video: emptyVideo(),
    editor: emptyEditor(),
    checkpoints: [],
    save: { kind: 'idle' },
    exportStatus: { kind: 'none' },
    stale: null,
    markFeedback: null,
    toasts: [],
    dialog: null,
    unexportedCount: 0,
  };
}
