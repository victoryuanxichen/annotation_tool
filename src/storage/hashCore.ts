/**
 * Environment-independent hashing core: chunk iteration, fingerprinting and a priority scheduler.
 * The hasher and the byte source are injected, so this runs in the hash worker, on the main thread
 * as a fallback, and in node unit tests.
 */

export const MiB = 1024 * 1024;
export const HASH_CHUNK_SIZE = 8 * MiB;
export const FINGERPRINT_EDGE = 1 * MiB;
export const FINGERPRINT_PREFIX = 'fp1';

export type HashPriority = 'foreground' | 'background';
export type ByteRange = readonly [start: number, end: number];

export interface IncrementalHasher {
  update(data: Uint8Array): void;
  /** Lowercase hex digest; the hasher is not used afterwards. */
  digestHex(): string;
}

export type HasherFactory = () => IncrementalHasher | Promise<IncrementalHasher>;

export interface ChunkSource {
  readonly size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

export type ProgressCallback = (bytesDone: number, bytesTotal: number) => void;

export interface HashRequestOptions {
  priority?: HashPriority;
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
}

export function blobSource(blob: Blob): ChunkSource {
  return {
    size: blob.size,
    read: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()),
  };
}

export function* chunkRanges(size: number, chunkSize: number = HASH_CHUNK_SIZE): Generator<ByteRange> {
  if (!(chunkSize > 0)) throw new RangeError('chunkSize must be positive');
  for (let start = 0; start < size; start += chunkSize) yield [start, Math.min(size, start + chunkSize)];
}

/** Whole file when ≤ 2 MiB, else the first and last MiB. */
export function fingerprintRanges(size: number): ByteRange[] {
  if (size <= 2 * FINGERPRINT_EDGE) return size > 0 ? [[0, size]] : [];
  return [
    [0, FINGERPRINT_EDGE],
    [size - FINGERPRINT_EDGE, size],
  ];
}

export async function hashRanges(source: ChunkSource, ranges: Iterable<ByteRange>, createHasher: HasherFactory): Promise<string> {
  const hasher = await createHasher();
  for (const [start, end] of ranges) hasher.update(await source.read(start, end));
  return hasher.digestHex();
}

/** `fp1:<size>:<sha256(first 1 MiB ‖ last 1 MiB)>` — for instant draft lookup only. */
export async function computeFingerprint(source: ChunkSource, createHasher: HasherFactory): Promise<string> {
  const hex = await hashRanges(source, fingerprintRanges(source.size), createHasher);
  return `${FINGERPRINT_PREFIX}:${source.size}:${hex}`;
}

export function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('Hashing was cancelled', 'AbortError');
}

export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

interface Subscriber {
  priority: HashPriority;
  onProgress?: ProgressCallback;
  resolve: (hex: string) => void;
  reject: (e: unknown) => void;
  cleanup: () => void;
}

interface Job {
  key: string;
  seq: number;
  source: ChunkSource;
  priority: HashPriority;
  offset: number;
  hasher: IncrementalHasher | null;
  subscribers: Set<Subscriber>;
}

export interface HashJobSnapshot {
  key: string;
  priority: HashPriority;
  bytesDone: number;
  bytesTotal: number;
  subscribers: number;
}

export interface HashSchedulerOptions {
  createHasher: HasherFactory;
  chunkSize?: number;
  /** Awaited between chunks so new requests (e.g. worker messages) can preempt. */
  yieldBetweenChunks?: () => Promise<void>;
}

const RANK: Record<HashPriority, number> = { foreground: 0, background: 1 };

function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Hashes jobs one chunk at a time. Before every chunk the highest-priority job is chosen (FIFO within
 * a priority), so a foreground request preempts a running background job, which keeps its hasher
 * state and offset and later resumes where it stopped. Concurrent requests for the same key share
 * one job; a job is cancelled only when all of its requesters have aborted.
 */
export class HashScheduler {
  private readonly createHasher: HasherFactory;
  private readonly chunkSize: number;
  private readonly yieldFn: () => Promise<void>;
  private readonly jobs = new Map<string, Job>();
  private seq = 0;
  private running = false;

  constructor(options: HashSchedulerOptions) {
    this.createHasher = options.createHasher;
    this.chunkSize = options.chunkSize ?? HASH_CHUNK_SIZE;
    this.yieldFn = options.yieldBetweenChunks ?? macrotask;
    if (!(this.chunkSize > 0)) throw new RangeError('chunkSize must be positive');
  }

  request(key: string, source: ChunkSource, options: HashRequestOptions = {}): Promise<string> {
    const { signal, onProgress } = options;
    const priority = options.priority ?? 'background';
    if (signal?.aborted) return Promise.reject(abortError(signal));

    let job = this.jobs.get(key);
    if (!job) {
      job = { key, seq: this.seq++, source, priority, offset: 0, hasher: null, subscribers: new Set() };
      this.jobs.set(key, job);
    }
    const target = job;
    const promise = new Promise<string>((resolve, reject) => {
      const sub: Subscriber = { priority, onProgress, resolve, reject, cleanup: () => undefined };
      if (signal) {
        const onAbort = (): void => this.unsubscribe(target, sub, abortError(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        sub.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      target.subscribers.add(sub);
    });
    this.refreshPriority(target);
    if (target.offset > 0) onProgress?.(target.offset, target.source.size);
    void this.pump();
    return promise;
  }

  snapshot(): HashJobSnapshot[] {
    return this.ordered().map((j) => ({
      key: j.key,
      priority: j.priority,
      bytesDone: j.offset,
      bytesTotal: j.source.size,
      subscribers: j.subscribers.size,
    }));
  }

  get size(): number {
    return this.jobs.size;
  }

  private ordered(): Job[] {
    return [...this.jobs.values()].sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.seq - b.seq);
  }

  private refreshPriority(job: Job): void {
    let best: HashPriority = 'background';
    for (const s of job.subscribers) if (s.priority === 'foreground') best = 'foreground';
    job.priority = best;
  }

  private unsubscribe(job: Job, sub: Subscriber, reason: unknown): void {
    if (!job.subscribers.delete(sub)) return;
    sub.cleanup();
    sub.reject(reason);
    if (job.subscribers.size === 0) this.removeJob(job);
    else this.refreshPriority(job);
  }

  private removeJob(job: Job): void {
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    job.hasher = null;
  }

  private settle(job: Job, outcome: { hex: string } | { error: unknown }): void {
    this.removeJob(job);
    for (const sub of job.subscribers) {
      sub.cleanup();
      if ('hex' in outcome) sub.resolve(outcome.hex);
      else sub.reject(outcome.error);
    }
    job.subscribers.clear();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.ordered()[0]; job; job = this.ordered()[0]) {
        await this.step(job);
        if (this.jobs.size > 0) await this.yieldFn();
      }
    } finally {
      this.running = false;
    }
  }

  /** Advances `job` by one chunk (or finishes it). Never throws. */
  private async step(job: Job): Promise<void> {
    const live = (): boolean => this.jobs.get(job.key) === job;
    try {
      job.hasher ??= await this.createHasher();
      if (!live()) return;
      const total = job.source.size;
      if (job.offset < total) {
        const end = Math.min(total, job.offset + this.chunkSize);
        const bytes = await job.source.read(job.offset, end);
        if (!live() || !job.hasher) return;
        if (bytes.byteLength !== end - job.offset) throw new Error(`Short read at ${job.offset}: file changed?`);
        job.hasher.update(bytes);
        job.offset = end;
        for (const sub of job.subscribers) sub.onProgress?.(job.offset, total);
      }
      if (job.offset >= total) this.settle(job, { hex: job.hasher.digestHex() });
    } catch (error) {
      if (live()) this.settle(job, { error });
    }
  }
}
