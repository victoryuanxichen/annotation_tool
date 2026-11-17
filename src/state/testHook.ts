/**
 * E2E test hook. Installed when `import.meta.env.DEV` is true or the URL contains `e2e=1`.
 *
 *   window.__pa = {
 *     state(): AppState                                  // current store snapshot
 *     actions: Actions                                   // the contract actions
 *     player(): FramePlayer | null
 *     index(): FrameIndex | null                         // open video's frame index
 *     openDirectoryHandle(handle): Promise<void>         // like "Open folder" with a given handle (e.g. OPFS);
 *                                                        //   resolves once the first video is ready (or failed)
 *     openFileHandle(handle, parent?): Promise<void>     // like "Open file"; `parent` = its folder, if known
 *     setExportFolderHandle(handle): Promise<void>       // sets destination "Chosen folder" to this handle
 *     flushAutosave(): Promise<void>                     // writes any pending draft change now
 *     whenIdle(): Promise<void>                          // identity/sidecar checks + batch verification done
 *     readBarcode(): number | null                       // frame number decoded from the canvas pixels
 *
 *     // Fault injection and picker stand-ins (all reset by resetFs()):
 *     simulateWriteFailure(reason | null)                // every folder write fails with `reason`
 *                                                        //   ('permission_denied' also refuses write
 *                                                        //   permission, like a denied prompt); null = off
 *     denyPermission(mode | null)                        // ensure/queryPermission refuse `mode`
 *                                                        //   ('readwrite' = read-only folder); null = off
 *     importAnnotationFile(file: File): Promise<void>    // "Import file…" with this file, no native picker
 *     nextExportFolderPick(handle | null)                // the next "Choose folder" picker returns `handle`
 *                                                        //   (null = the user cancels)
 *     resetFs()                                          // removes every override above
 *   }
 *
 * Keep this surface stable: Playwright specs depend on it.
 */
import type { FrameIndex } from '../core/mp4/frameIndex';
import type { FramePlayer } from '../player';
import { containRect, decodeBarcode } from '../testing/barcode';
import type { WriteFailureReason } from '../fs';
import { handleDir } from '../fs/types';
import type { Actions, AppState } from './contract';
import type { ControllerApi } from './controller';
import { browserFsDeps, type FsDeps } from './deps';

export interface TestHook {
  state(): AppState;
  actions: Actions;
  player(): FramePlayer | null;
  index(): FrameIndex | null;
  openDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void>;
  openFileHandle(handle: FileSystemFileHandle, parent?: FileSystemDirectoryHandle): Promise<void>;
  setExportFolderHandle(handle: FileSystemDirectoryHandle): Promise<void>;
  flushAutosave(): Promise<void>;
  whenIdle(): Promise<void>;
  readBarcode(): number | null;
  simulateWriteFailure(reason: WriteFailureReason | null): void;
  denyPermission(mode: 'readwrite' | 'read' | null): void;
  importAnnotationFile(file: File): Promise<void>;
  nextExportFolderPick(handle: FileSystemDirectoryHandle | null): void;
  resetFs(): void;
}

declare global {
  interface Window {
    __pa?: TestHook;
  }
}

function enabled(): boolean {
  if (typeof window === 'undefined') return false;
  if (import.meta.env?.DEV) return true;
  return typeof location !== 'undefined' && /(?:^|[?&])e2e=1(?:&|$)/.test(location.search);
}

function readBarcode(api: ControllerApi<FramePlayer>): number | null {
  const index = api.getFrameIndex();
  const canvas = api.getCanvas();
  if (!index || !canvas || canvas.width === 0 || canvas.height === 0) return null;
  const off = new OffscreenCanvas(canvas.width, canvas.height);
  const ctx = off.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return decodeBarcode(img.data, img.width, containRect(img.width, img.height, index.displayWidth, index.displayHeight));
}

/** Composes the fault-injection overrides into one FsDeps patch. */
function createFsFaults(api: ControllerApi<FramePlayer>, real: FsDeps): Pick<TestHook, 'simulateWriteFailure' | 'denyPermission' | 'importAnnotationFile' | 'nextExportFolderPick' | 'resetFs'> {
  let writeFailure: WriteFailureReason | null = null;
  let denied: 'readwrite' | 'read' | null = null;
  let annotationFile: File | null = null;
  let exportPick: { handle: FileSystemDirectoryHandle | null } | null = null;
  const refuses = (mode: 'read' | 'readwrite'): boolean =>
    writeFailure === 'permission_denied' ? mode === 'readwrite' : denied === 'read' || (denied === 'readwrite' && mode === 'readwrite');
  const apply = (): void => {
    const o: Partial<FsDeps> = {};
    if (writeFailure !== null || denied !== null) {
      o.ensurePermission = (handle, mode, opts) => (refuses(mode) ? Promise.resolve(false) : real.ensurePermission(handle, mode, opts));
      o.queryPermission = (handle, mode) => (refuses(mode) ? Promise.resolve('denied' as PermissionState) : real.queryPermission(handle, mode));
    }
    if (writeFailure !== null) {
      const reason = writeFailure;
      o.writeTextFile = () => Promise.resolve({ ok: false, reason, message: 'Simulated write failure (test hook)' });
    } else if (denied !== null) {
      o.writeTextFile = (dir, name, text, opts) =>
        dir.kind === 'handle' && refuses('readwrite') ? Promise.resolve({ ok: false, reason: 'permission_denied', message: 'Simulated permission denial (test hook)' }) : real.writeTextFile(dir, name, text, opts);
    }
    if (annotationFile) {
      const file = annotationFile;
      o.pickAnnotationFile = () => {
        annotationFile = null;
        apply();
        return Promise.resolve(file);
      };
    }
    if (exportPick) {
      const { handle } = exportPick;
      o.pickExportFolder = () => {
        exportPick = null;
        apply();
        return Promise.resolve(handle ? handleDir(handle) : null);
      };
    }
    api.setFsOverrides(o);
  };
  return {
    simulateWriteFailure: (reason) => {
      writeFailure = reason;
      apply();
    },
    denyPermission: (mode) => {
      denied = mode;
      apply();
    },
    importAnnotationFile: async (file) => {
      annotationFile = file;
      apply();
      await api.actions.importFromFile();
    },
    nextExportFolderPick: (handle) => {
      exportPick = { handle };
      apply();
    },
    resetFs: () => {
      writeFailure = null;
      denied = null;
      annotationFile = null;
      exportPick = null;
      api.setFsOverrides({});
    },
  };
}

export function installTestHook(api: ControllerApi<FramePlayer>, realFs: FsDeps = browserFsDeps): void {
  if (!enabled()) return;
  const hook: TestHook = {
    state: () => api.store.getState(),
    actions: api.actions,
    player: () => api.getPlayer(),
    index: () => api.getFrameIndex(),
    openDirectoryHandle: (h) => api.openDirectoryHandle(h),
    openFileHandle: (h, parent) => api.openFileHandle(h, parent),
    setExportFolderHandle: (h) => api.setExportFolderHandle(h),
    flushAutosave: () => api.flushAutosave(),
    whenIdle: () => api.whenIdle(),
    readBarcode: () => readBarcode(api),
    ...createFsFaults(api, realFs),
  };
  window.__pa = hook;
}
