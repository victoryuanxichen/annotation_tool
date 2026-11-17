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
 *   }
 *
 * Keep this surface stable: Playwright specs depend on it.
 */
import type { FrameIndex } from '../core/mp4/frameIndex';
import type { FramePlayer } from '../player';
import { containRect, decodeBarcode } from '../testing/barcode';
import type { Actions, AppState } from './contract';
import type { ControllerApi } from './controller';

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

export function installTestHook(api: ControllerApi<FramePlayer>): void {
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
  };
  window.__pa = hook;
}
