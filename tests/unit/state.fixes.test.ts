/**
 * Regression tests for the acceptance/review findings fixed in src/state and src/storage:
 * in-flight marks, provisional-identity autosave, per-key conflicts, sidecar pairing, batch
 * statuses from fingerprints, read-only export, stale-tab export guard, checkpoint failures.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Autosaver } from '../../src/storage/autosave';
import { DraftStore, newDraft, pendingKey, type DraftRecord, type SaveResult } from '../../src/storage/drafts';
import { pairSidecarNames } from '../../src/state/deps';
import { FakeFs } from './helpers/fakeFs';
import { createHarness, sha256Hex, sidecarText, videoBytes, type Harness } from './helpers/stateFakes';

const PREP = 'chole.preparation';

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.cleanup();
});

async function mark(start: number, end: number, phase = PREP, hh: Harness = h): Promise<void> {
  hh.api.actions.selectPhase(phase);
  hh.player.displayed = start;
  await hh.api.actions.markStart();
  hh.player.displayed = end;
  await hh.api.actions.markFinish();
}

function ranges(hh: Harness = h): [number, number][] {
  return hh.state().editor.doc.segments.map((s) => [s.start, s.end]);
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

describe('marks while a seek is in flight', () => {
  async function open(): Promise<void> {
    const fs = new FakeFs('v', { 'case.mp4': videoBytes('case') });
    h.frameCounts.set('case.mp4', 4000);
    await h.api.openFileHandle(fs.file('case.mp4'), fs.root);
    await h.idle();
    h.api.actions.selectPhase(PREP);
  }

  it('commits the frame targeted at the key press, refuses when later navigation replaced it', async () => {
    await open();
    h.player.displayed = 10;
    await h.api.actions.markStart();

    // Jump to 2099 is in flight (10 still shown) when W is pressed; D then moves on to 2100.
    h.player.requested = 2099;
    h.player.holdSettle();
    const w = h.api.actions.markFinish();
    h.player.requested = null;
    h.player.displayed = 2100;
    h.player.releaseSettle();
    await w;
    expect(ranges()).toEqual([]);
    expect(h.state().markFeedback).toMatchObject({ kind: 'error', msg: { key: 'ctl.mark.notConfirmed.moved' } });
    expect(h.state().editor.pendingStart).toBe(10);

    // Same, but 2099 is shown before anything else: committed exactly there.
    h.player.requested = 2099;
    h.player.holdSettle();
    const w2 = h.api.actions.markFinish();
    h.player.requested = null;
    h.player.displayed = 2099;
    h.player.releaseSettle();
    await w2;
    expect(ranges()).toEqual([[10, 2099]]);
  });

  it('serialises marks: R right after a still-confirming Q uses that start', async () => {
    await open();
    h.player.displayed = 3000;
    h.player.holdSettle();
    const q = h.api.actions.markStart();
    const r = h.api.actions.markThroughEnd();
    h.player.releaseSettle();
    await Promise.all([q, r]);
    expect(ranges()).toEqual([[3000, 4000]]);
    expect(h.state().markFeedback).toMatchObject({ kind: 'ok', msg: { key: 'mark.added' } });
  });

  it('a boundary edit interrupted by another seek says so instead of failing silently', async () => {
    await open();
    await mark(0, 10);
    const id = h.state().editor.doc.segments[0].id;
    h.player.supersedeNextSeek = true;
    const ok = await h.api.actions.setSegmentBounds(id, { end: 2500 });
    expect(ok).toBe(false);
    expect(ranges()).toEqual([[0, 10]]);
    expect(h.state().markFeedback).toMatchObject({ kind: 'error', msg: { key: 'ctl.mark.notConfirmed.moved' } });
  });
});

describe('autosave while the full SHA-256 is still running', () => {
  it('a reopened (renamed) video with a sha256 draft saves edits under its pending key at once, then promotes them', async () => {
    const fs = new FakeFs('v', { 'a.mp4': videoBytes('a') });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    await mark(10, 20);
    await h.api.flushAutosave();
    const sha = sha256Hex(videoBytes('a'));
    const before = await h.drafts.get(sha);
    expect(before?.segments).toHaveLength(1);

    const hash = gate();
    const h2 = await createHarness({
      drafts: h.drafts,
      checkpoints: h.checkpoints,
      kv: h.deps.kv,
      handles: h.deps.handles,
      hashCache: h.deps.hashCache,
      hashing: {
        fingerprint: h.deps.hashing.fingerprint,
        sha256: async (file) => {
          await hash.promise;
          return sha256Hex(new Uint8Array(await file.arrayBuffer()));
        },
      },
    });
    try {
      const fs2 = new FakeFs('v2', { 'renamed.mp4': videoBytes('a') });
      await h2.api.openFileHandle(fs2.file('renamed.mp4'), fs2.root);
      expect(h2.state().video.identity).toBe('provisional');
      expect(ranges(h2)).toEqual([[10, 20]]);
      await mark(30, 40, PREP, h2);
      await h2.api.flushAutosave();
      // Durable before the hash finishes (a crash now keeps the edit), and the UI says so.
      const fp = await h2.deps.hashing.fingerprint(new File([videoBytes('a') as Uint8Array<ArrayBuffer>], 'renamed.mp4'));
      const pending = (await h.drafts.get(pendingKey(fp))) as (DraftRecord & { basedOn?: unknown }) | null;
      expect(pending?.segments.map((s) => [s.start, s.end])).toEqual([
        [10, 20],
        [30, 40],
      ]);
      expect(pending?.basedOn).toEqual({ sha256: sha, revision: before?.revision });
      expect(h2.state().save.kind).toBe('saved');

      hash.release();
      await h2.idle();
      expect(h2.state().video.identity).toBe('verified');
      expect(await h.drafts.get(pendingKey(fp))).toBeNull();
      expect((await h.drafts.get(sha))?.segments.map((s) => [s.start, s.end])).toEqual([
        [10, 20],
        [30, 40],
      ]);
      // A plain continuation: no "other draft" checkpoint.
      expect(h2.state().checkpoints).toEqual([]);
    } finally {
      hash.release();
      h2.api.dispose();
    }
  });

  it('after a crash during hashing the pending edits are recovered and promoted without a conflict', async () => {
    const fs = new FakeFs('v', { 'a.mp4': videoBytes('a') });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    await mark(10, 20);
    await h.api.flushAutosave();
    const sha = sha256Hex(videoBytes('a'));

    const shared = { drafts: h.drafts, checkpoints: h.checkpoints, kv: h.deps.kv, handles: h.deps.handles, hashCache: h.deps.hashCache };
    const never = gate();
    const crashed = await createHarness({ ...shared, hashing: { fingerprint: h.deps.hashing.fingerprint, sha256: () => never.promise.then(() => '') } });
    const fs2 = new FakeFs('v2', { 'copy.mp4': videoBytes('a') });
    await crashed.api.openFileHandle(fs2.file('copy.mp4'), fs2.root);
    await mark(30, 40, PREP, crashed);
    await crashed.api.flushAutosave();
    crashed.api.dispose(); // killed before the hash finished

    const h3 = await createHarness(shared);
    try {
      await h3.api.openFileHandle(fs2.file('copy.mp4'), fs2.root);
      await h3.idle();
      expect(ranges(h3)).toEqual([
        [10, 20],
        [30, 40],
      ]);
      expect((await h.drafts.get(sha))?.segments).toHaveLength(2);
      expect(h3.state().checkpoints).toEqual([]);
    } finally {
      h3.api.dispose();
    }
  });

  it('a fingerprint match of another video is never carried into this video (edits kept as a checkpoint)', async () => {
    await h.cleanup();
    const hash = gate();
    h = await createHarness({
      hashing: {
        fingerprint: async () => 'fp1:same', // two different videos sharing a fingerprint
        sha256: async (file) => {
          if (file.name === 'b.mp4') await hash.promise;
          return sha256Hex(new Uint8Array(await file.arrayBuffer()));
        },
      },
    });
    const fs = new FakeFs('v', { 'a.mp4': videoBytes('a'), 'b.mp4': videoBytes('b') });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    await mark(0, 10);
    await h.api.flushAutosave();
    const shaA = sha256Hex(videoBytes('a'));
    const shaB = sha256Hex(videoBytes('b'));
    await h.api.actions.resolveSwitchFailure('stay');
    const next = h.api.actions.nextVideo();
    await next;
    expect(h.state().batch.currentId).toBe('b.mp4');
    expect(h.state().video.identity).toBe('provisional');
    expect(ranges()).toEqual([[0, 10]]);
    await mark(50, 60);
    hash.release();
    await h.idle();
    expect(ranges()).toEqual([]);
    expect(h.state().toasts.some((t) => t.msg.key === 'ctl.video.provisionalMismatch')).toBe(true);
    expect(h.state().checkpoints[0]).toMatchObject({ kind: 'auto-before-conflict', segmentCount: 2 });
    expect((await h.drafts.get(shaA))?.segments.map((s) => [s.start, s.end])).toEqual([[0, 10]]);
    expect(await h.drafts.get(shaB)).toBeNull();
    expect(await h.drafts.get(pendingKey('fp1:same'))).toBeNull();
  });
});

describe('autosave conflicts are per draft', () => {
  it('Autosaver: a conflict on one key does not block another key', async () => {
    const saved: string[] = [];
    let conflictKey = 'a';
    const store = {
      save: async (d: DraftRecord, base: number): Promise<SaveResult> => {
        if (d.key === conflictKey) return { ok: false, conflict: null };
        saved.push(d.key);
        return { ok: true, record: { ...d, revision: base + 1 } };
      },
    };
    const saver = new Autosaver({ store, debounceMs: 1, maxWaitMs: 2 });
    const draft = (sha: string): DraftRecord => newDraft({ sha256: sha, fingerprint: 'f', fileName: 'x', relPath: null, frameCount: 1, durationUs: 1 });
    saver.schedule(() => draft('a'));
    await saver.flush();
    expect(saver.isBlocked('a')).toBe(true);
    saver.schedule(() => draft('a'));
    await saver.flush();
    expect(saved).toEqual([]);
    saver.schedule(() => draft('b'));
    await saver.flush();
    expect(saved).toEqual(['b']);
    saver.clearConflict('a');
    conflictKey = '';
    saver.schedule(() => draft('a'));
    await saver.flush();
    expect(saved).toEqual(['b', 'a']);
  });

  it('leaving a conflicted video keeps this tab’s version as a checkpoint and the next video autosaves', async () => {
    const fs = new FakeFs('v', { 'a.mp4': videoBytes('a'), 'b.mp4': videoBytes('b') });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    await mark(0, 10);
    await h.api.flushAutosave();
    const shaA = sha256Hex(videoBytes('a'));
    const stored = await h.drafts.get(shaA);
    const other = new DraftStore({ db: h.db, tabId: 'tab-other', createChannel: () => null });
    await other.save({ ...stored!, segments: [{ id: 'o', phaseId: PREP, start: 100, end: 120 }] }, stored!.revision);
    await mark(50, 60);
    await h.api.flushAutosave();
    expect(h.state().save.kind).toBe('conflict');

    // The older version is never exported over the file beside the video.
    expect(await h.api.actions.exportNow()).toBe(false);
    expect(fs.readText('a.phases.csv')).toBeNull();
    await h.api.actions.nextVideo();
    expect(h.state().dialog).toMatchObject({ kind: 'switch-failed', failure: { reason: 'write', msg: { key: 'stale.banner' } } });
    expect(fs.readText('a.phases.csv')).toBeNull();
    await h.api.actions.resolveSwitchFailure('switch-without-export');
    expect(h.state().batch.currentId).toBe('b.mp4');
    await h.idle();

    await mark(30, 60);
    await h.api.flushAutosave();
    expect(h.state().save.kind).toBe('saved');
    expect((await h.drafts.get(sha256Hex(videoBytes('b'))))?.segments).toHaveLength(1);
    // A keeps the other tab's version; this tab's version is a checkpoint of A.
    expect((await h.drafts.get(shaA))?.segments.map((s) => s.start)).toEqual([100]);
    const cps = await h.checkpoints.list(shaA);
    expect(cps.map((c) => c.segments.map((s) => s.start))).toEqual([[0, 50]]);
    other.close();
  });
});

describe('checkpoint failures abort replacement', () => {
  it('load-newer keeps this tab’s version when the checkpoint cannot be stored', async () => {
    const fs = new FakeFs('v', { 'a.mp4': videoBytes('a') });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    await mark(0, 10);
    await h.api.flushAutosave();
    const sha = sha256Hex(videoBytes('a'));
    const stored = await h.drafts.get(sha);
    const other = new DraftStore({ db: h.db, tabId: 'tab-other', createChannel: () => h.hub.create() });
    await other.save({ ...stored!, segments: [{ id: 'o', phaseId: PREP, start: 200, end: 210 }] }, stored!.revision);
    expect(h.state().stale).not.toBeNull();
    const create = h.checkpoints.create.bind(h.checkpoints);
    h.checkpoints.create = () => Promise.reject(new Error('QuotaExceededError'));
    await h.api.actions.resolveStale('load-newer');
    expect(ranges()).toEqual([[0, 10]]);
    expect(h.state().stale).not.toBeNull();
    expect(h.state().toasts.some((t) => t.msg.key === 'ctl.checkpoint.failed')).toBe(true);
    h.checkpoints.create = create;
    other.close();
  });
});

describe('sidecar pairing', () => {
  it('pure rule: a longer-stem neighbour keeps its sidecar', () => {
    const names = ['case.mp4', 'case_2.mp4', 'case_2.phases.csv', 'case.phases.json', 'case.v2.phases.csv'];
    expect(pairSidecarNames('case.mp4', names)).toEqual(['case.phases.json', 'case.v2.phases.csv']);
    expect(pairSidecarNames('case_2.mp4', names)).toEqual(['case_2.phases.csv']);
    expect(pairSidecarNames('case.mp4', [...names, 'case.v2.mp4'])).toEqual(['case.phases.json']);
  });

  it('opening case.mp4 does not list case_2.phases.csv nor turn it into a mismatch', async () => {
    const fs = new FakeFs('v', {
      'case.mp4': videoBytes('case'),
      'case_2.mp4': videoBytes('case2'),
      'case_2.phases.csv': sidecarText(videoBytes('case2'), 250, [{ phaseId: 'p', start: 0, end: 10 }], { p: 'P' }),
    });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    const status = (id: string): string | undefined => h.state().batch.items.find((i) => i.id === id)?.status;
    await h.api.actions.selectVideo('case.mp4');
    await h.idle();
    expect(h.state().batch.currentId).toBe('case.mp4');
    expect(h.state().video.sidecars).toEqual([]);
    expect(status('case.mp4')).toBe('unannotated');
    expect(status('case_2.mp4')).toBe('annotated');
    await h.api.actions.selectVideo('case_2.mp4');
    await h.idle();
    expect(status('case.mp4')).toBe('unannotated');
    expect(status('case_2.mp4')).toBe('annotated');
  });
});

describe('batch statuses and leave warning', () => {
  it('videos never hashed in this browser show their local drafts (fingerprint lookup) and count as unexported', async () => {
    const fs = new FakeFs('v', { 'a.mp4': videoBytes('a'), 'b.mp4': videoBytes('b') });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    await h.api.actions.selectVideo('b.mp4');
    await h.idle();
    await mark(10, 20);
    await h.api.flushAutosave();

    // Reload: a new controller on the same database; the hash cache does not know these files.
    const h2 = await createHarness({ drafts: h.drafts, checkpoints: h.checkpoints, kv: h.deps.kv, handles: h.deps.handles, hashCache: h.deps.hashCache });
    try {
      await h2.api.openDirectoryHandle(fs.root);
      await h2.idle();
      expect(h2.state().batch.currentId).toBe('a.mp4');
      expect(h2.state().batch.items.find((i) => i.id === 'b.mp4')).toMatchObject({ status: 'draft', segmentCount: 1 });
      expect(h2.state().unexportedCount).toBe(1);
    } finally {
      h2.api.dispose();
    }
  });

  it('chip slots stay where they are when another video opens', async () => {
    const fs = new FakeFs('v', { 'a.mp4': videoBytes('a'), 'b.mp4': videoBytes('b') });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    const ids = Object.keys(h.state().library.phases);
    h.api.actions.setActivePreset(null);
    for (const id of ids.slice(0, 3)) {
      h.api.actions.selectPhase(id);
    }
    await mark(0, 5, ids[2]);
    await mark(5, 10, ids[0]);
    const before = h.state().visibleRecent;
    await h.api.actions.resolveSwitchFailure('stay');
    await h.api.actions.nextVideo();
    await h.idle();
    expect(h.state().batch.currentId).toBe('b.mp4');
    expect(h.state().visibleRecent).toEqual(before);
  });
});

describe('export destinations', () => {
  it('a folder with read access only downloads, as its notice says, instead of writing beside the video', async () => {
    const fs = new FakeFs('v', { 'a.mp4': videoBytes('a'), 'b.mp4': videoBytes('b') });
    fs.permission.readwrite = 'prompt';
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    expect(h.state().batch.access).toBe('read');
    await mark(10, 20);
    await h.api.actions.nextVideo();
    expect(h.state().batch.currentId).toBe('b.mp4');
    expect(h.downloads.map((d) => d.name)).toEqual(['a.phases.csv']);
    expect(fs.readText('a.phases.csv')).toBeNull();
  });

  it('Export now failure offers "Download instead"', async () => {
    const fs = new FakeFs('v', { 'a.mp4': videoBytes('a') });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    await mark(10, 20);
    h.api.setFsOverrides({ writeTextFile: async () => ({ ok: false, reason: 'no_space', message: 'full' }) });
    expect(await h.api.actions.exportNow()).toBe(false);
    const toast = h.state().toasts.find((t) => t.kind === 'error');
    expect(toast?.action?.label.key).toBe('switch.download');
    toast?.action?.run();
    await h.idle();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.downloads.map((d) => d.name)).toEqual(['a.phases.csv']);
    expect(h.state().exportStatus.kind).toBe('exported');
    h.api.setFsOverrides({});
  });

  it('overwriting a same-video file the user did not import keeps its annotations as a checkpoint', async () => {
    const fs = new FakeFs('v', { 'a.mp4': videoBytes('a'), 'b.mp4': videoBytes('b') });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    await mark(10, 20);
    await h.api.flushAutosave();
    // A colleague's export of the same video appears; the user keeps the draft.
    await fs.root.getFileHandle('a.phases.csv', { create: true }).then(async (fh) => {
      const w = await fh.createWritable();
      await w.write(sidecarText(videoBytes('a'), 250, [{ phaseId: 'x', start: 100, end: 150 }], { x: 'X' }));
      await w.close();
    });
    await h.api.actions.exportNow();
    const cps = await h.checkpoints.list(sha256Hex(videoBytes('a')));
    expect(cps.map((c) => c.segments.map((s) => [s.start, s.end]))).toEqual([[[100, 150]]]);
    expect(fs.readText('a.phases.csv')).toContain('10');
    // Re-exporting our own file again does not add another checkpoint.
    await mark(30, 40);
    await h.api.actions.exportNow();
    expect(await h.checkpoints.list(sha256Hex(videoBytes('a')))).toHaveLength(1);
  });
});
