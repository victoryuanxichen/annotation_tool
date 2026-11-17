import type { FrameIndex } from './mp4/frameIndex';

export class IndexError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'IndexError';
  }
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (i: FrameIndex) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/index.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const { id, ok, index, error } = ev.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(index as FrameIndex);
      else p.reject(new IndexError(error.code, error.message));
    };
    worker.onerror = (ev) => {
      for (const p of pending.values()) p.reject(new IndexError('worker_failed', ev.message || 'index worker failed'));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

/** Builds the frame index off the main thread. */
export function indexFile(file: File): Promise<FrameIndex> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, file });
  });
}
