import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteDb, openDb, type DbProvider } from '../../src/storage/db';
import {
  Autosaver,
  DraftStore,
  computeContentHash,
  newDraft,
  pendingKey,
  type AutosaveStatus,
  type DraftMessage,
  type DraftRecord,
  type SaveResult,
} from '../../src/storage/drafts';
import { CheckpointStore } from '../../src/storage/checkpoints';
import { DEFAULT_SETTINGS, KvStore, mergeLibrary, mergeSettings } from '../../src/storage/kv';
import { HandleStore } from '../../src/storage/handles';
import { requestPersistence, estimate } from '../../src/storage/persist';
import type { PhaseLibrary } from '../../src/core/types';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const FP = 'fp1:1000:' + 'c'.repeat(64);

let dbName = '';
let db: DbProvider;
let seq = 0;
const stores: DraftStore[] = [];

beforeEach(() => {
  dbName = `test-${++seq}-${Math.random().toString(36).slice(2)}`;
  db = () => openDb({ name: dbName });
});

afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  await deleteDb(dbName);
});

function draftStore(tabId: string): DraftStore {
  const s = new DraftStore({ db, tabId });
  stores.push(s);
  return s;
}

function draft(overrides: Partial<DraftRecord> = {}): DraftRecord {
  const base = newDraft({ sha256: SHA_A, fingerprint: FP, fileName: 'case.mp4', relPath: null, frameCount: 250, durationUs: 10_000_000 });
  return { ...base, ...overrides };
}

const seg = (id: string, start: number, end: number, phaseId = 'prep') => ({ id, phaseId, start, end });
const phases = { prep: { id: 'prep', name: 'Preparation', color: '#336699' } };

function nextMessage(store: DraftStore): Promise<DraftMessage> {
  return new Promise((resolve) => {
    const off = store.subscribe((m) => {
      off();
      resolve(m);
    });
  });
}

describe('db', () => {
  it('creates all stores and indexes at version 1', async () => {
    const conn = await db();
    expect(conn.version).toBe(1);
    expect([...conn.objectStoreNames].sort()).toEqual(['checkpoints', 'drafts', 'handles', 'hashCache', 'kv']);
    const tx = conn.transaction(['drafts', 'checkpoints']);
    expect([...tx.objectStore('drafts').indexNames].sort()).toEqual(['fingerprint', 'sha256']);
    expect([...tx.objectStore('checkpoints').indexNames]).toEqual(['videoKey']);
  });

  it('reuses one connection and reconnects after a versionchange closes it', async () => {
    const a = await db();
    expect(await db()).toBe(a);
    a.onversionchange?.(new Event('versionchange') as IDBVersionChangeEvent);
    const b = await db();
    expect(b).not.toBe(a);
  });
});

describe('DraftStore', () => {
  it('saves and loads; revision increments from the base', async () => {
    const store = draftStore('tab-a');
    const r1 = await store.save(draft({ segments: [seg('s1', 0, 10)], phases }), 0);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.record.revision).toBe(1);
    expect(r1.record.savedBy).toBe('tab-a');
    const loaded = await store.get(SHA_A);
    expect(loaded?.segments).toEqual([seg('s1', 0, 10)]);
    expect(loaded?.revision).toBe(1);
    const r2 = await store.save({ ...loaded!, segments: [] }, 1);
    expect(r2.ok && r2.record.revision).toBe(2);
    expect(await store.list()).toHaveLength(1);
    expect(await store.get('missing')).toBeNull();
  });

  it('rejects a key that does not match sha256/fingerprint', async () => {
    const store = draftStore('tab-a');
    await expect(store.save(draft({ key: SHA_B }), 0)).rejects.toThrow(TypeError);
  });

  it('detects a stale tab: B saves after A advanced → conflict, nothing written', async () => {
    const tabA = draftStore('tab-a');
    const tabB = draftStore('tab-b');
    const first = await tabA.save(draft({ segments: [seg('s1', 0, 10)], phases }), 0);
    expect(first.ok).toBe(true);
    // Both tabs now believe revision 1 is stored.
    const fromB = await tabB.get(SHA_A);
    expect(fromB?.revision).toBe(1);

    const a2 = await tabA.save(draft({ segments: [seg('s1', 0, 20)], phases }), 1);
    expect(a2.ok).toBe(true);

    const b2 = await tabB.save({ ...fromB!, segments: [seg('x', 5, 6)] }, 1);
    expect(b2.ok).toBe(false);
    if (b2.ok) return;
    expect(b2.conflict?.revision).toBe(2);
    expect(b2.conflict?.savedBy).toBe('tab-a');
    const stored = await tabA.get(SHA_A);
    expect(stored?.segments).toEqual([seg('s1', 0, 20)]);
    expect(stored?.revision).toBe(2);
  });

  it('only one of two concurrent saves from the same base succeeds', async () => {
    const tabA = draftStore('tab-a');
    const tabB = draftStore('tab-b');
    const results = await Promise.all([tabA.save(draft({ fileName: 'a' }), 0), tabB.save(draft({ fileName: 'b' }), 0)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('a missing record with a non-zero base is a conflict with null', async () => {
    const store = draftStore('tab-a');
    const r = await store.save(draft(), 3);
    expect(r).toEqual({ ok: false, conflict: null });
    expect(await store.get(SHA_A)).toBeNull();
  });

  it('broadcasts saves to other tabs only', async () => {
    const tabA = draftStore('tab-a');
    const tabB = draftStore('tab-b');
    const ownSpy = vi.fn();
    tabA.subscribe(ownSpy);
    const received = nextMessage(tabB);
    await tabA.save(draft(), 0);
    expect(await received).toEqual({ type: 'draft-saved', key: SHA_A, revision: 1, tabId: 'tab-a' });
    await new Promise((r) => setTimeout(r, 20));
    expect(ownSpy).not.toHaveBeenCalled();
  });

  it('findForVideo prefers sha256, falls back to fingerprint, never crosses a different sha256', async () => {
    const store = draftStore('tab-a');
    const pending = draft({ key: pendingKey(FP), sha256: null });
    await store.save(pending, 0);
    expect((await store.findForVideo({ fingerprint: FP }))?.match).toBe('fingerprint');
    expect((await store.findForVideo({ sha256: SHA_A, fingerprint: FP }))?.record.key).toBe(pendingKey(FP));

    await store.save(draft({ fileName: 'by-sha' }), 0);
    const bySha = await store.findForVideo({ sha256: SHA_A, fingerprint: FP });
    expect(bySha?.match).toBe('sha256');
    expect(bySha?.record.fileName).toBe('by-sha');

    // A draft of another video with an identical fingerprint must not match.
    await store.delete(pendingKey(FP));
    expect(await store.findForVideo({ sha256: SHA_B, fingerprint: FP })).toBeNull();
    expect(await store.findForVideo({ fingerprint: 'fp1:1:none' })).toBeNull();
  });

  it('promotePending re-keys the draft and its checkpoints atomically', async () => {
    const store = draftStore('tab-a');
    const checkpoints = new CheckpointStore({ db });
    const pk = pendingKey(FP);
    await store.save(draft({ key: pk, sha256: null, segments: [seg('s1', 0, 5)], phases }), 0);
    await checkpoints.create({ videoKey: pk, name: 'cp', kind: 'manual', segments: [], phases: {} });

    const result = await store.promotePending(pk, SHA_A);
    expect(result.kind).toBe('promoted');
    if (result.kind !== 'promoted') return;
    expect(result.record).toMatchObject({ key: SHA_A, sha256: SHA_A, revision: 2 });
    expect(await store.get(pk)).toBeNull();
    expect((await store.get(SHA_A))?.segments).toEqual([seg('s1', 0, 5)]);
    expect(await checkpoints.list(pk)).toHaveLength(0);
    expect(await checkpoints.list(SHA_A)).toHaveLength(1);
    expect(await store.promotePending(pk, SHA_A)).toEqual({ kind: 'not_found' });
  });

  it('promotePending reports a collision and keeps both drafts', async () => {
    const store = draftStore('tab-a');
    const pk = pendingKey(FP);
    await store.save(draft({ key: pk, sha256: null, fileName: 'pending.mp4' }), 0);
    await store.save(draft({ fileName: 'existing.mp4' }), 0);
    const result = await store.promotePending(pk, SHA_A);
    expect(result.kind).toBe('collision');
    if (result.kind !== 'collision') return;
    expect(result.collision.fileName).toBe('existing.mp4');
    expect(result.pending.fileName).toBe('pending.mp4');
    expect(await store.get(pk)).not.toBeNull();
    expect((await store.get(SHA_A))?.fileName).toBe('existing.mp4');
  });

  it('broadcasts promotions', async () => {
    const tabA = draftStore('tab-a');
    const tabB = draftStore('tab-b');
    const pk = pendingKey(FP);
    await tabA.save(draft({ key: pk, sha256: null }), 0);
    const received = nextMessage(tabB);
    await tabA.promotePending(pk, SHA_A);
    expect(await received).toEqual({ type: 'draft-promoted', from: pk, key: SHA_A, revision: 2, tabId: 'tab-a' });
  });
});

describe('computeContentHash', () => {
  it('ignores segment ids, colours and order; reflects names and boundaries', () => {
    const h = computeContentHash([seg('a', 0, 5), seg('b', 5, 9)], phases);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(computeContentHash([seg('y', 5, 9), seg('x', 0, 5)], { prep: { ...phases.prep, color: '#000000' } })).toBe(h);
    expect(computeContentHash([seg('a', 0, 5), seg('b', 5, 10)], phases)).not.toBe(h);
    expect(computeContentHash([seg('a', 0, 5), seg('b', 5, 9)], { prep: { ...phases.prep, name: 'Prep' } })).not.toBe(h);
    expect(computeContentHash([], {})).not.toBe(h);
  });
});

describe('CheckpointStore', () => {
  it('creates, lists newest first, gets, deletes and rekeys', async () => {
    let t = 1000;
    const store = new CheckpointStore({ db, now: () => t });
    const a = await store.create({ videoKey: SHA_A, name: 'first', kind: 'manual', segments: [seg('s', 0, 1)], phases });
    const b = await store.create({ videoKey: SHA_A, name: 'same ms', kind: 'auto-before-restore', segments: [], phases: {} });
    t = 5000;
    const c = await store.create({ videoKey: SHA_A, name: 'later', kind: 'auto-before-import', segments: [], phases: {} });
    await store.create({ videoKey: SHA_B, name: 'other video', kind: 'manual', segments: [], phases: {} });

    expect(b.createdAt).toBeGreaterThan(a.createdAt);
    expect((await store.list(SHA_A)).map((x) => x.name)).toEqual(['later', 'same ms', 'first']);
    expect(await store.get(a.id)).toEqual(a);

    await store.delete(b.id);
    expect(await store.get(b.id)).toBeNull();
    expect((await store.list(SHA_A)).map((x) => x.id)).toEqual([c.id, a.id]);

    expect(await store.rekey(SHA_A, 'new-key')).toBe(2);
    expect(await store.list(SHA_A)).toEqual([]);
    expect((await store.list('new-key')).map((x) => x.id)).toEqual([c.id, a.id]);
    expect(await store.list(SHA_B)).toHaveLength(1);
  });
});

describe('KvStore', () => {
  const library: PhaseLibrary = {
    phases: {
      prep: { id: 'prep', name: 'Preparation', color: '#336699' },
      close: { id: 'close', name: 'Closure', color: '#993366' },
    },
    presets: [{ id: 'lap', name: 'Lap chole (example)', phaseIds: ['prep', 'close'], builtIn: true }],
    activePresetId: 'lap',
    recent: ['close'],
  };
  const defaults = () => structuredClone(library);

  it('returns defaults when nothing is stored', async () => {
    const kv = new KvStore({ db });
    expect(await kv.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(await kv.getLibrary(defaults)).toEqual(library);
  });

  it('round-trips settings and library', async () => {
    const kv = new KvStore({ db });
    const s = { ...DEFAULT_SETTINGS, language: 'zh-Hant' as const, timelineZoom: 4, exportDestination: { kind: 'folder' as const, handleId: 'h1' } };
    await kv.setSettings(s);
    expect(await kv.getSettings()).toEqual(s);
    const updated = await kv.updateSettings({ exportFormat: 'both' });
    expect(updated).toEqual({ ...s, exportFormat: 'both' });
    const lib = { ...library, recent: ['prep', 'close'] };
    await kv.setLibrary(lib);
    expect(await kv.getLibrary(defaults)).toEqual(lib);
  });

  it('merges malformed or partial settings with defaults', async () => {
    const kv = new KvStore({ db });
    await kv.setRaw('settings', {
      language: 'fr',
      exportFormat: 'json',
      sort: { key: 'size' },
      bottomPanelHeight: 'tall',
      timelineZoom: -1,
      extra: true,
    });
    expect(await kv.getSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      exportFormat: 'json',
      sort: { key: 'size', dir: 'asc' },
    });
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings({ bottomPanelHeight: 5 }).bottomPanelHeight).toBe(120);
    expect(mergeSettings({ exportDestination: { kind: 'download', handleId: 'x' } }).exportDestination).toEqual({ kind: 'download' });
  });

  it('merges a damaged library: drops bad phases, dangling refs and unknown presets', () => {
    const merged = mergeLibrary(
      {
        phases: {
          prep: { id: 'prep', name: 'Prep', color: '#ABCDEF' },
          'Bad Id': { id: 'Bad Id', name: 'x', color: '#000000' },
          nocolor: { id: 'nocolor', name: 'No colour' },
        },
        presets: [{ id: 'p', name: 'P', phaseIds: ['prep', 'nocolor', 'prep'] }, { id: 7 }],
        activePresetId: 'gone',
        recent: ['nocolor', 'prep', 'prep', 3],
      },
      library,
    );
    expect(merged).toEqual({
      phases: { prep: { id: 'prep', name: 'Prep', color: '#abcdef' } },
      presets: [{ id: 'p', name: 'P', phaseIds: ['prep'] }],
      activePresetId: 'p',
      recent: ['prep'],
    });
    const partial = mergeLibrary({ recent: ['prep'] }, library);
    expect(partial).toEqual({ ...library, recent: ['prep'] });
  });
});

describe('HandleStore', () => {
  it('persists structured-cloneable handles by id', async () => {
    let t = 1;
    const store = new HandleStore({ db, now: () => t++ });
    const fakeHandle = { kind: 'directory', name: 'videos' } as unknown as FileSystemDirectoryHandle;
    await store.put('a', fakeHandle);
    await store.put('b', { kind: 'directory', name: 'other' } as unknown as FileSystemDirectoryHandle);
    expect((await store.get('a'))?.name).toBe('videos');
    expect((await store.list()).map((r) => r.id)).toEqual(['b', 'a']);
    await store.delete('a');
    expect(await store.get('a')).toBeNull();
  });
});

describe('persist', () => {
  it('asks for persistence once and swallows failures', async () => {
    const persist = vi.fn(() => Promise.reject(new Error('denied')));
    const manager = { persist, persisted: () => Promise.resolve(false), estimate: () => Promise.resolve({ usage: 5, quota: 10 }) };
    expect(await requestPersistence(manager)).toBe(false);
    expect(await requestPersistence(manager)).toBe(false);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(await estimate(manager)).toEqual({ usage: 5, quota: 10, persisted: false });
    expect(await estimate(null)).toBeNull();
  });
});

describe('Autosaver', () => {
  type SaveCall = { draft: DraftRecord; base: number; resolve: (r: SaveResult) => void; reject: (e: unknown) => void };

  function controlledStore() {
    const calls: SaveCall[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const store = {
      save: (d: DraftRecord, base: number) =>
        new Promise<SaveResult>((resolve, reject) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          const done = <T>(fn: (v: T) => void) => (v: T) => {
            inFlight--;
            fn(v);
          };
          calls.push({ draft: d, base, resolve: done(resolve), reject: done(reject) });
        }),
    };
    const ok = (call: SaveCall) => call.resolve({ ok: true, record: { ...call.draft, revision: call.base + 1, savedAt: Date.now() } });
    return { store, calls, ok, maxInFlight: () => maxInFlight };
  }

  let statuses: AutosaveStatus[];
  beforeEach(() => {
    vi.useFakeTimers();
    statuses = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const make = (store: { save: (d: DraftRecord, b: number) => Promise<SaveResult> }) =>
    new Autosaver({ store, onStatus: (s) => statuses.push(s) });
  const producerFor = (fileName: string) => () => draft({ fileName });

  it('debounces 300 ms', async () => {
    const c = controlledStore();
    const saver = make(c.store);
    saver.schedule(producerFor('v1'));
    await vi.advanceTimersByTimeAsync(200);
    saver.schedule(producerFor('v2'));
    await vi.advanceTimersByTimeAsync(299);
    expect(c.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0].draft.fileName).toBe('v2');
    expect(c.calls[0].base).toBe(0);
    c.ok(c.calls[0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.map((s) => s.state)).toEqual(['saving', 'saved']);
    expect(saver.hasPendingWork).toBe(false);
  });

  it('writes within the 1 s max wait under continuous changes', async () => {
    const c = controlledStore();
    const saver = make(c.store);
    for (let t = 0; t < 1000; t += 100) {
      saver.schedule(producerFor(`v${t}`));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0].draft.fileName).toBe('v900');
  });

  it('serialises writes and coalesces changes made during a write', async () => {
    const c = controlledStore();
    const saver = make(c.store);
    saver.schedule(producerFor('v1'));
    await vi.advanceTimersByTimeAsync(300);
    expect(c.calls).toHaveLength(1);

    saver.schedule(producerFor('v2'));
    saver.schedule(producerFor('v3'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.calls).toHaveLength(1); // still waiting for the first write

    c.ok(c.calls[0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.calls).toHaveLength(2);
    expect(c.calls[1].draft.fileName).toBe('v3');
    expect(c.calls[1].base).toBe(1); // revision learnt from the first save
    c.ok(c.calls[1]);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.maxInFlight()).toBe(1);
  });

  it('flush writes immediately and resolves after the queue drains', async () => {
    const c = controlledStore();
    const saver = make(c.store);
    saver.schedule(producerFor('v1'));
    const flushed = saver.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.calls).toHaveLength(1);
    let done = false;
    void flushed.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    c.ok(c.calls[0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.calls).toHaveLength(1);
  });

  it('reports errors, keeps the change and retries on demand', async () => {
    const c = controlledStore();
    const saver = make(c.store);
    saver.schedule(producerFor('v1'));
    await vi.advanceTimersByTimeAsync(300);
    c.calls[0].reject(new Error('QuotaExceeded'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(statuses.at(-1)?.state).toBe('error');
    expect(c.calls).toHaveLength(1);
    expect(saver.hasPendingWork).toBe(true);

    const retried = saver.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.calls).toHaveLength(2);
    expect(c.calls[1].draft.fileName).toBe('v1');
    c.ok(c.calls[1]);
    await retried;
    expect(statuses.at(-1)?.state).toBe('saved');
  });

  it('stops on conflict until resolved, then overwrites from the adopted base', async () => {
    const c = controlledStore();
    const saver = make(c.store);
    saver.schedule(producerFor('mine'));
    await vi.advanceTimersByTimeAsync(300);
    const newer = { ...draft({ fileName: 'theirs' }), revision: 7 };
    c.calls[0].resolve({ ok: false, conflict: newer });
    await vi.advanceTimersByTimeAsync(0);
    const last = statuses.at(-1);
    expect(last).toEqual({ state: 'conflict', key: SHA_A, stored: newer });

    saver.schedule(producerFor('mine-2'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.calls).toHaveLength(1); // blocked

    void saver.resolveConflict(SHA_A, 7);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.calls).toHaveLength(2);
    expect(c.calls[1].draft.fileName).toBe('mine-2');
    expect(c.calls[1].base).toBe(7);
  });

  it('works end-to-end against DraftStore', async () => {
    vi.useRealTimers();
    const store = draftStore('tab-a');
    const saver = new Autosaver({ store, debounceMs: 5, maxWaitMs: 20, onStatus: (s) => statuses.push(s) });
    saver.schedule(producerFor('a'));
    saver.schedule(producerFor('b'));
    await saver.flush();
    saver.schedule(producerFor('c'));
    await saver.flush();
    const stored = await store.get(SHA_A);
    expect(stored?.fileName).toBe('c');
    expect(stored?.revision).toBe(2);
  });

  it('flushes on visibilitychange:hidden and pagehide when attached', async () => {
    const c = controlledStore();
    const saver = make(c.store);
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
    const win = Object.assign(new EventTarget(), { document: doc });
    saver.attach(win);

    saver.schedule(producerFor('v1'));
    doc.dispatchEvent(new Event('visibilitychange')); // still visible → no flush
    await vi.advanceTimersByTimeAsync(0);
    expect(c.calls).toHaveLength(0);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.calls).toHaveLength(1);
    c.ok(c.calls[0]);
    await vi.advanceTimersByTimeAsync(0);

    saver.schedule(producerFor('v2'));
    win.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.calls).toHaveLength(2);
    c.ok(c.calls[1]);
    await vi.advanceTimersByTimeAsync(0);

    saver.detach();
    saver.schedule(producerFor('v3'));
    win.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.calls).toHaveLength(2);
  });
});
