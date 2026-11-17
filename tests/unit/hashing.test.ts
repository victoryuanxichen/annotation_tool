import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { openAsBlob, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  HashScheduler,
  MiB,
  blobSource,
  chunkRanges,
  computeFingerprint,
  fingerprintRanges,
  isAbortError,
  type ChunkSource,
  type IncrementalHasher,
} from '../../src/storage/hashCore';
import { createWasmSha256 } from '../../src/storage/wasmHasher';
import { HashCache, hashCacheKey } from '../../src/storage/hashCache';
import { fingerprint, sha256, setHashBackend, type HashBackend } from '../../src/storage/hashing';
import { deleteDb, openDb } from '../../src/storage/db';

const dir = path.resolve('tests/fixtures/videos');
const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Record<string, { sha256: string; size: number }>;

const nodeSha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

function nodeHasher(): IncrementalHasher {
  const h = createHash('sha256');
  return { update: (d) => void h.update(d), digestHex: () => h.digest('hex') };
}

/** In-memory source that logs every read as `${label}:${start}`, with an optional hook. */
function memSource(label: string, data: Uint8Array, log: string[], onRead?: (start: number) => void): ChunkSource {
  return {
    size: data.byteLength,
    read: async (start, end) => {
      log.push(`${label}:${start}`);
      onRead?.(start);
      return data.slice(start, end);
    },
  };
}

const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);
const immediate = () => Promise.resolve();

describe('pure helpers', () => {
  it('chunkRanges covers the file exactly', () => {
    expect([...chunkRanges(0, 4)]).toEqual([]);
    expect([...chunkRanges(10, 4)]).toEqual([
      [0, 4],
      [4, 8],
      [8, 10],
    ]);
    expect([...chunkRanges(8, 4)]).toEqual([
      [0, 4],
      [4, 8],
    ]);
    expect(() => [...chunkRanges(8, 0)]).toThrow(RangeError);
  });

  it('fingerprintRanges: whole file up to 2 MiB, else first+last MiB', () => {
    expect(fingerprintRanges(0)).toEqual([]);
    expect(fingerprintRanges(2 * MiB)).toEqual([[0, 2 * MiB]]);
    expect(fingerprintRanges(2 * MiB + 1)).toEqual([
      [0, MiB],
      [MiB + 1, 2 * MiB + 1],
    ]);
  });
});

describe('HashScheduler', () => {
  it('foreground preempts background between chunks; background resumes without restarting', async () => {
    const log: string[] = [];
    const bgData = bytes(20, 1);
    const fgData = bytes(8, 2);
    const scheduler = new HashScheduler({ createHasher: nodeHasher, chunkSize: 4, yieldBetweenChunks: immediate });
    let fg: Promise<string> | undefined;
    const bg = scheduler.request('bg', memSource('bg', bgData, log, (start) => {
      if (start === 4) fg = scheduler.request('fg', memSource('fg', fgData, log), { priority: 'foreground' });
    }));
    expect(await bg).toBe(nodeSha(bgData));
    expect(await fg).toBe(nodeSha(fgData));
    expect(log).toEqual(['bg:0', 'bg:4', 'fg:0', 'fg:4', 'bg:8', 'bg:12', 'bg:16']);
  });

  it('runs background jobs one at a time in FIFO order', async () => {
    const log: string[] = [];
    const scheduler = new HashScheduler({ createHasher: nodeHasher, chunkSize: 4, yieldBetweenChunks: immediate });
    const a = scheduler.request('a', memSource('a', bytes(8, 1), log));
    const b = scheduler.request('b', memSource('b', bytes(8, 2), log));
    await Promise.all([a, b]);
    expect(log).toEqual(['a:0', 'a:4', 'b:0', 'b:4']);
  });

  it('de-duplicates concurrent requests and upgrades priority', async () => {
    const log: string[] = [];
    const data = bytes(12, 3);
    const scheduler = new HashScheduler({ createHasher: nodeHasher, chunkSize: 4, yieldBetweenChunks: immediate });
    const other = scheduler.request('other', memSource('other', bytes(12, 9), log));
    const first = scheduler.request('same', memSource('same', data, log));
    const progress = vi.fn();
    const second = scheduler.request('same', memSource('unused', data, log), { priority: 'foreground', onProgress: progress });
    expect(scheduler.size).toBe(2);
    expect(scheduler.snapshot()[0]).toMatchObject({ key: 'same', priority: 'foreground', subscribers: 2 });
    const [h1, h2] = await Promise.all([first, second, other]);
    expect(h1).toBe(nodeSha(data));
    expect(h2).toBe(h1);
    // The upgraded job ran first and was read once.
    expect(log.filter((l) => l.startsWith('same'))).toEqual(['same:0', 'same:4', 'same:8']);
    expect(log.some((l) => l.startsWith('unused'))).toBe(false);
    expect(log.indexOf('same:8')).toBeLessThan(log.indexOf('other:4'));
    expect(progress.mock.calls).toEqual([
      [4, 12],
      [8, 12],
      [12, 12],
    ]);
  });

  it('a late joiner gets current progress immediately', async () => {
    const log: string[] = [];
    const scheduler = new HashScheduler({ createHasher: nodeHasher, chunkSize: 4, yieldBetweenChunks: immediate });
    const progress = vi.fn();
    let joined: Promise<string> | undefined;
    const data = bytes(12, 4);
    const p = scheduler.request('k', memSource('k', data, log, (start) => {
      if (start === 8) joined = scheduler.request('k', memSource('k2', data, log), { onProgress: progress });
    }));
    await p;
    expect(await joined).toBe(nodeSha(data));
    expect(progress.mock.calls[0]).toEqual([8, 12]);
  });

  it('cancels a job when its only requester aborts, and others keep going', async () => {
    const log: string[] = [];
    const scheduler = new HashScheduler({ createHasher: nodeHasher, chunkSize: 4, yieldBetweenChunks: immediate });
    const ctrl = new AbortController();
    const cancelled = scheduler.request('bg', memSource('bg', bytes(20, 1), log, (start) => {
      if (start === 4) ctrl.abort();
    }), { signal: ctrl.signal });
    const rest = scheduler.request('next', memSource('next', bytes(4, 2), log));
    await expect(cancelled).rejects.toSatisfy(isAbortError);
    await rest;
    expect(log).toEqual(['bg:0', 'bg:4', 'next:0']);
    expect(scheduler.size).toBe(0);
  });

  it('keeps a shared job alive while one requester remains', async () => {
    const log: string[] = [];
    const data = bytes(12, 5);
    const scheduler = new HashScheduler({ createHasher: nodeHasher, chunkSize: 4, yieldBetweenChunks: immediate });
    const ctrl = new AbortController();
    const a = scheduler.request('k', memSource('k', data, log, (s) => {
      if (s === 4) ctrl.abort();
    }), { signal: ctrl.signal, priority: 'foreground' });
    const b = scheduler.request('k', memSource('k', data, log));
    await expect(a).rejects.toSatisfy(isAbortError);
    expect(await b).toBe(nodeSha(data));
    expect(log).toEqual(['k:0', 'k:4', 'k:8']);
  });

  it('rejects immediately for an already-aborted signal', async () => {
    const scheduler = new HashScheduler({ createHasher: nodeHasher });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(scheduler.request('k', memSource('k', bytes(4, 0), []), { signal: ctrl.signal })).rejects.toSatisfy(isAbortError);
    expect(scheduler.size).toBe(0);
  });

  it('propagates read errors to every requester and continues with other jobs', async () => {
    const scheduler = new HashScheduler({ createHasher: nodeHasher, chunkSize: 4, yieldBetweenChunks: immediate });
    const broken: ChunkSource = { size: 8, read: () => Promise.reject(new Error('NotReadableError')) };
    const a = scheduler.request('bad', broken);
    const b = scheduler.request('bad', broken);
    const ok = scheduler.request('ok', memSource('ok', bytes(3, 1), []));
    await expect(a).rejects.toThrow('NotReadableError');
    await expect(b).rejects.toThrow('NotReadableError');
    expect(await ok).toBe(nodeSha(bytes(3, 1)));
  });

  it('hashes an empty source', async () => {
    const scheduler = new HashScheduler({ createHasher: nodeHasher });
    expect(await scheduler.request('e', memSource('e', new Uint8Array(0), []))).toBe(nodeSha(new Uint8Array(0)));
  });
});

describe('real fixtures (hash-wasm vs node:crypto vs ffprobe manifest)', () => {
  const names = Object.keys(manifest);
  it('includes a file larger than 2 MiB', () => {
    expect(names.some((n) => manifest[n].size > 2 * MiB)).toBe(true);
  });

  for (const name of names) {
    it(name, async () => {
      const file = path.join(dir, name);
      const buf = new Uint8Array(readFileSync(file));
      const blob = await openAsBlob(file);
      expect(blob.size).toBe(manifest[name].size);

      const fpBytes = buf.byteLength <= 2 * MiB ? buf : Buffer.concat([buf.subarray(0, MiB), buf.subarray(buf.byteLength - MiB)]);
      expect(await computeFingerprint(blobSource(blob), createWasmSha256)).toBe(`fp1:${buf.byteLength}:${nodeSha(fpBytes)}`);

      // Odd chunk size forces several chunks (and a partial last one) even on small files.
      const scheduler = new HashScheduler({ createHasher: createWasmSha256, chunkSize: 64 * 1024 + 7 });
      const hex = await scheduler.request(name, blobSource(blob), { priority: 'foreground' });
      expect(hex).toBe(nodeSha(buf));
      expect(hex).toBe(manifest[name].sha256);
    });
  }
});

describe('hashing.ts (in-thread backend, IndexedDB cache)', () => {
  const dbName = 'hash-cache-test';
  afterEach(async () => {
    setHashBackend(null);
    await deleteDb(dbName);
  });

  async function fixtureFile(name: string): Promise<File> {
    const blob = await openAsBlob(path.join(dir, name));
    return new File([blob], name, { lastModified: 1_700_000_000_000 });
  }

  it('computes sha256 and fingerprint, then serves sha256 from the cache', async () => {
    const cache = new HashCache({ db: () => openDb({ name: dbName }) });
    const file = await fixtureFile('long720p_gop300.mp4');
    const progress = vi.fn();
    const hex = await sha256(file, { priority: 'foreground', onProgress: progress, cache, relPath: 'a/long.mp4' });
    expect(hex).toBe(manifest['long720p_gop300.mp4'].sha256);
    expect(progress).toHaveBeenLastCalledWith(file.size, file.size);
    expect(await cache.get(hashCacheKey(file, 'a/long.mp4'))).toBe(hex);
    expect(hashCacheKey(file, 'a/long.mp4')).toBe(`long720p_gop300.mp4|${file.size}|1700000000000|a/long.mp4`);
    expect(await fingerprint(file)).toMatch(new RegExp(`^fp1:${file.size}:[0-9a-f]{64}$`));

    const backend: HashBackend = { fingerprint: vi.fn(), sha256: vi.fn() };
    setHashBackend(backend);
    expect(await sha256(file, { cache, relPath: 'a/long.mp4' })).toBe(hex);
    expect(backend.sha256).not.toHaveBeenCalled();
    // A different relPath is a different cache key.
    vi.mocked(backend.sha256).mockResolvedValue('f'.repeat(64));
    expect(await sha256(file, { cache, relPath: 'b/long.mp4' })).toBe('f'.repeat(64));
  });

  it('distinguishes same-name files and de-duplicates concurrent requests by identity', async () => {
    const a = await fixtureFile('same_name_a.mp4');
    const b = await fixtureFile('same_name_b.mp4');
    const renamedA = new File([a], 'case.mp4', { lastModified: 1 });
    const renamedB = new File([b], 'case.mp4', { lastModified: 1 });
    const [ha, hb] = await Promise.all([sha256(renamedA, { cache: null }), sha256(renamedB, { cache: null })]);
    expect(ha).toBe(manifest['same_name_a.mp4'].sha256);
    expect(hb).toBe(manifest['same_name_b.mp4'].sha256);

    const calls: string[] = [];
    setHashBackend({
      fingerprint: () => Promise.resolve(''),
      sha256: (key) => {
        calls.push(key);
        return Promise.resolve('0'.repeat(64));
      },
    });
    await Promise.all([sha256(renamedA, { cache: null, relPath: 'x' }), sha256(renamedA, { cache: null, relPath: 'x' })]);
    // Both requests carry the same job key, which the scheduler de-duplicates (see HashScheduler tests).
    expect(calls).toEqual([hashCacheKey(renamedA, 'x'), hashCacheKey(renamedA, 'x')]);
  });

  it('honours an aborted signal before any work', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(sha256(await fixtureFile('tiny3.mp4'), { signal: ctrl.signal, cache: null })).rejects.toSatisfy(isAbortError);
  });
});
