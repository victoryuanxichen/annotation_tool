import type { FrameIndex } from './mp4/frameIndex';

export class IndexError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'IndexError';
  }
}

export type IndexPriority = 'foreground' | 'background';

interface Pending {
  resolve: (i: FrameIndex) => void;
  reject: (e: Error) => void;
}

/**
 * One module worker per priority, so background batch indexing (verification of other videos)
 * never queues in front of the video the user is opening.
 */
class IndexWorkerSlot {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();

  index(file: File): Promise<FrameIndex> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.get().postMessage({ id, file });
      } catch (e) {
        this.pending.delete(id);
        reject(new IndexError('worker_failed', e instanceof Error ? e.message : String(e)));
      }
    });
  }

  /** Creates the worker now so its script is fetched while the local server is reachable. */
  warm(): void {
    if (typeof Worker === 'undefined') return;
    try {
      this.get();
    } catch {
      // Created again (and the error reported) on first real use.
    }
  }

  private get(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('../workers/index.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const { id, ok, index, error } = ev.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (ok) p.resolve(index as FrameIndex);
      else p.reject(new IndexError(error.code, error.message));
    };
    worker.onerror = (ev) => {
      if (this.worker !== worker) return;
      for (const p of this.pending.values()) p.reject(new IndexError('worker_failed', ev.message || 'index worker failed'));
      this.pending.clear();
      worker.terminate();
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }
}

const slots: Record<IndexPriority, IndexWorkerSlot> = {
  foreground: new IndexWorkerSlot(),
  background: new IndexWorkerSlot(),
};

/**
 * Builds the frame index off the main thread. Use `priority: 'background'` for batch
 * verification so it runs on its own worker and never delays opening a video.
 */
export function indexFile(file: File, opts?: { priority?: IndexPriority }): Promise<FrameIndex> {
  return slots[opts?.priority ?? 'foreground'].index(file);
}

/**
 * Starts both index workers so their scripts are loaded at app start: once the page has loaded,
 * opening a video keeps working even if the local server becomes unreachable.
 */
export function warmIndexWorkers(): void {
  slots.foreground.warm();
  slots.background.warm();
}

// Warm up as soon as the app imports this module in a browser page (no-op in tests and workers).
if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof Worker !== 'undefined') {
  setTimeout(warmIndexWorkers, 0);
}
