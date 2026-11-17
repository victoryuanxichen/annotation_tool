/**
 * Video identity: quick fingerprint and full SHA-256 (SPEC §4). Work runs in `hash.worker.ts`; when
 * Worker is unavailable (node tests) the same scheduler runs in-thread.
 */
import {
  HashScheduler,
  abortError,
  blobSource,
  computeFingerprint,
  type HashPriority,
  type HashRequestOptions,
  type ProgressCallback,
} from './hashCore';
import { HashCache, hashCacheKey } from './hashCache';
import { deserializeError, type HashWorkerRequest, type HashWorkerResponse } from './hashProtocol';
import { createWasmSha256 } from './wasmHasher';

export { hashCacheKey } from './hashCache';
export type { HashPriority, ProgressCallback } from './hashCore';

export interface HashBackend {
  fingerprint(file: Blob): Promise<string>;
  /** Requests sharing `key` are de-duplicated into one job. */
  sha256(key: string, file: Blob, options: HashRequestOptions): Promise<string>;
}

export interface Sha256Options {
  priority?: HashPriority;
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
  /** Relative path within the opened folder, when known (part of the cache key). */
  relPath?: string | null;
  /** Pass null to bypass the IndexedDB cache. */
  cache?: HashCache | null;
}

class LocalBackend implements HashBackend {
  private readonly scheduler = new HashScheduler({ createHasher: createWasmSha256 });

  fingerprint(file: Blob): Promise<string> {
    return computeFingerprint(blobSource(file), createWasmSha256);
  }

  sha256(key: string, file: Blob, options: HashRequestOptions): Promise<string> {
    return this.scheduler.request(key, blobSource(file), options);
  }
}

interface PendingCall {
  resolve: (value: string) => void;
  reject: (e: unknown) => void;
  onProgress?: ProgressCallback;
}

class WorkerBackend implements HashBackend {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, PendingCall>();

  fingerprint(file: Blob): Promise<string> {
    return this.call({ type: 'fingerprint', id: ++this.seq, file }, {});
  }

  sha256(key: string, file: Blob, options: HashRequestOptions): Promise<string> {
    const priority = options.priority ?? 'background';
    return this.call({ type: 'sha256', id: ++this.seq, key, file, priority }, options);
  }

  private call(message: Exclude<HashWorkerRequest, { type: 'cancel' }>, options: HashRequestOptions): Promise<string> {
    const { signal, onProgress } = options;
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const id = message.id;
    return new Promise<string>((resolve, reject) => {
      const onAbort = (): void => {
        if (!this.pending.delete(id)) return;
        this.worker?.postMessage({ type: 'cancel', id } satisfies HashWorkerRequest);
        reject(abortError(signal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const done = (): void => signal?.removeEventListener('abort', onAbort);
      this.pending.set(id, {
        resolve: (v) => (done(), resolve(v)),
        reject: (e) => (done(), reject(e)),
        onProgress,
      });
      this.getWorker().postMessage(message);
    });
  }

  /** Creates the worker now so its script is fetched while the local server is reachable. */
  warm(): void {
    this.getWorker();
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('../workers/hash.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<HashWorkerResponse>) => this.onMessage(ev.data);
    worker.onerror = (ev) => this.fail(new Error(ev.message || 'hash worker failed'));
    this.worker = worker;
    return worker;
  }

  private onMessage(msg: HashWorkerResponse): void {
    const call = this.pending.get(msg.id);
    if (!call) return;
    if (msg.type === 'progress') {
      call.onProgress?.(msg.done, msg.total);
      return;
    }
    this.pending.delete(msg.id);
    if (msg.type === 'result') call.resolve(msg.value);
    else call.reject(deserializeError(msg.error));
  }

  private fail(error: Error): void {
    const calls = [...this.pending.values()];
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    for (const c of calls) c.reject(error);
  }
}

let backend: HashBackend | null = null;
let defaultCache: HashCache | null = null;
const blobKeys = new WeakMap<Blob, string>();
let blobSeq = 0;

function getBackend(): HashBackend {
  backend ??= typeof Worker === 'undefined' ? new LocalBackend() : new WorkerBackend();
  return backend;
}

/** Replaces the backend (tests); null restores the default on next use. */
export function setHashBackend(next: HashBackend | null): void {
  backend = next;
}

function isFileLike(b: Blob): b is File {
  return typeof (b as Partial<File>).name === 'string' && typeof (b as Partial<File>).lastModified === 'number';
}

function jobKey(file: Blob, relPath: string | null | undefined): string {
  if (isFileLike(file)) return hashCacheKey(file, relPath);
  let k = blobKeys.get(file);
  if (!k) {
    k = `blob#${++blobSeq}`;
    blobKeys.set(file, k);
  }
  return k;
}

/**
 * Starts the hash worker at app start instead of on the first video, so its module is already
 * loaded if the local server stops (or the network is emulated offline) afterwards.
 */
export function warmHashWorker(): void {
  const b = getBackend();
  if (b instanceof WorkerBackend) {
    try {
      b.warm();
    } catch {
      // Worker creation failures surface on first real use.
    }
  }
}

/** `fp1:<size>:<sha256 of first+last MiB>`; fast, for provisional draft lookup only. */
export function fingerprint(file: Blob): Promise<string> {
  return getBackend().fingerprint(file);
}

/** Full-file SHA-256 (lowercase hex), cached in IndexedDB by file identity. */
export async function sha256(file: Blob, options: Sha256Options = {}): Promise<string> {
  const { signal, onProgress, relPath } = options;
  if (signal?.aborted) throw abortError(signal);
  const cache = options.cache === undefined ? (defaultCache ??= new HashCache()) : options.cache;
  const cacheKey = isFileLike(file) ? hashCacheKey(file, relPath) : null;

  if (cache && cacheKey) {
    const hit = await cache.get(cacheKey).catch(() => null);
    if (signal?.aborted) throw abortError(signal);
    if (hit) {
      onProgress?.(file.size, file.size);
      return hit;
    }
  }

  const hex = await getBackend().sha256(jobKey(file, relPath), file, {
    priority: options.priority ?? 'background',
    onProgress,
    signal,
  });
  if (cache && cacheKey) await cache.put(cacheKey, hex).catch(() => undefined);
  return hex;
}
