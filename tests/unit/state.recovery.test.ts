import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DraftStore, pendingKey } from '../../src/storage/drafts';
import { FakeFs } from './helpers/fakeFs';
import { createHarness, sha256Hex, sidecarText, videoBytes, type Harness } from './helpers/stateFakes';

const PREP = 'chole.preparation';
const NAMES = { prep: 'Preparation (file)', clip: 'Clipping' };

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.cleanup();
});

async function mark(start: number, end: number, phase = PREP): Promise<void> {
  h.api.actions.selectPhase(phase);
  h.player.displayed = start;
  await h.api.actions.markStart();
  h.player.displayed = end;
  await h.api.actions.markFinish();
}

function ranges(): [string, number, number][] {
  return h.state().editor.doc.segments.map((s) => [s.phaseId, s.start, s.end]);
}

describe('sidecar verification', () => {
  const fileSegs = [
    { phaseId: 'prep', start: 0, end: 100 },
    { phaseId: 'clip', start: 100, end: 250 },
  ];

  it('auto-imports a matching sidecar into an untouched draft', async () => {
    const fs = new FakeFs('v', { 'a.mp4': videoBytes('a'), 'a.phases.csv': sidecarText(videoBytes('a'), 250, fileSegs, NAMES) });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    expect(h.state().video.sidecars).toMatchObject([{ name: 'a.phases.csv', state: 'match', segmentCount: 2 }]);
    expect(ranges()).toEqual([
      ['prep', 0, 100],
      ['clip', 100, 250],
    ]);
    expect(h.state().editor.doc.phases.prep.name).toBe('Preparation (file)');
    expect(h.state().library.phases.clip?.name).toBe('Clipping');
    expect(h.state().editor.dirty).toBe(false);
    expect(h.state().exportStatus.kind).toBe('exported');
    expect(h.state().batch.items[0].status).toBe('annotated');
    expect(h.state().toasts.some((t) => t.msg.key === 'import.success')).toBe(true);
    expect(h.state().editor.canUndo).toBe(false);
  });

  it('asks before replacing a different draft and checkpoints it first', async () => {
    const fs = new FakeFs('v', { 'a.mp4': videoBytes('a'), 'b.mp4': videoBytes('b') });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    await mark(10, 20);
    // Leave without exporting so the draft stays local and differs from the file added later.
    fs.permission.readwrite = 'denied';
    fs.requestResult = 'denied';
    await h.api.actions.nextVideo();
    await h.api.actions.resolveSwitchFailure('switch-without-export');
    await h.idle();
    fs.permission.readwrite = 'granted';
    fs.root.populate({ 'a.phases.json': sidecarText(videoBytes('a'), 250, fileSegs, NAMES, 'json') });

    // Re-scan (sidecars are discovered by the folder scan) and open a.
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    const dlg = h.state().dialog;
    expect(dlg).toEqual({ kind: 'import-choice', sidecarName: 'a.phases.json', fileSegmentCount: 2, draftSegmentCount: 1 });
    expect(ranges()).toEqual([[PREP, 10, 20]]);

    await h.api.actions.resolveImportChoice('use-file');
    await h.idle();
    expect(h.state().dialog).toBeNull();
    expect(ranges()).toEqual([
      ['prep', 0, 100],
      ['clip', 100, 250],
    ]);
    expect(h.state().editor.dirty).toBe(false);
    const cps = h.state().checkpoints;
    expect(cps[0]).toMatchObject({ kind: 'auto-before-import', segmentCount: 1 });
    h.api.actions.undo();
    expect(ranges()).toEqual([[PREP, 10, 20]]);
  });

  it('keep-draft leaves the draft untouched', async () => {
    const fs = new FakeFs('v', { 'a.mp4': videoBytes('a') });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    await mark(1, 2);
    await h.api.flushAutosave();
    fs.root.populate({ 'a.phases.csv': sidecarText(videoBytes('a'), 250, fileSegs, NAMES) });
    // Reopening runs the export gate, which would replace the same-video file: make it fail.
    fs.permission.readwrite = 'denied';
    fs.requestResult = 'denied';
    await h.api.openDirectoryHandle(fs.root);
    expect(h.state().dialog?.kind).toBe('switch-failed');
    await h.api.actions.resolveSwitchFailure('switch-without-export');
    await h.idle();
    expect(h.state().dialog?.kind).toBe('import-choice');
    await h.api.actions.resolveImportChoice('keep-draft');
    expect(ranges()).toEqual([[PREP, 1, 2]]);
    expect(h.state().editor.dirty).toBe(true);
  });

  it('marks sidecars of other videos or broken files as mismatch/invalid and never loads them', async () => {
    const fs = new FakeFs('v', {
      'a.mp4': videoBytes('a'),
      'a.phases.csv': sidecarText(videoBytes('other'), 250, fileSegs, NAMES),
      'a_bad.json': '{"format":"phase-annotations","format_version":1,"video":{"sha256":"' + sha256Hex(videoBytes('a')) + '","frame_count":250,"duration_us":10000000},"segments":[{"phase_id":"p","phase_name":"P","start_frame":0,"end_frame":300,"start_us":0,"end_us":12000000}]}',
    });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    const sc = h.state().video.sidecars;
    const csv = sc.find((s) => s.name === 'a.phases.csv');
    const bad = sc.find((s) => s.name === 'a_bad.json');
    expect(csv?.state).toBe('mismatch');
    expect(csv?.problems.map((p) => p.key)).toContain('ctl.verify.sha256_mismatch');
    expect(bad?.state).toBe('invalid');
    expect(bad?.problems.map((p) => p.key)).toContain('ctl.verify.out_of_range');
    expect(ranges()).toEqual([]);
    expect(h.state().batch.items[0].status).toBe('mismatch');
  });

  it('verifies other videos in the background and reflects local drafts', async () => {
    const fs = new FakeFs('v', {
      'a.mp4': videoBytes('a'),
      'b.mp4': videoBytes('b'),
      'b.phases.csv': sidecarText(videoBytes('b'), 250, fileSegs, NAMES),
      'c.mp4': videoBytes('c'),
      'c.phases.csv': sidecarText(videoBytes('zzz'), 250, fileSegs, NAMES),
    });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    const status = (id: string): string | undefined => h.state().batch.items.find((i) => i.id === id)?.status;
    expect(status('a.mp4')).toBe('unannotated');
    expect(status('b.mp4')).toBe('annotated');
    expect(status('c.mp4')).toBe('mismatch');
    expect(h.state().batch.items.find((i) => i.id === 'b.mp4')?.segmentCount).toBe(2);
    expect(h.state().batch.verifying).toBeNull();

    h.api.actions.setSort('name', 'desc');
    expect(h.state().batch.items.map((i) => i.id)).toEqual(['c.mp4', 'b.mp4', 'a.mp4']);
    h.api.actions.setSort('name');
    expect(h.state().settings.sort).toEqual({ key: 'name', dir: 'asc' });
  });
});

describe('autosave, conflicts and recovery', () => {
  it('recovers a draft after a reload (new controller) and a rename', async () => {
    const fs = new FakeFs('v', { 'a.mp4': videoBytes('a') });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    await mark(30, 40);
    await h.api.flushAutosave();
    expect(h.state().save.kind).toBe('saved');
    const sha = sha256Hex(videoBytes('a'));
    expect((await h.drafts.get(sha))?.segments).toHaveLength(1);

    // "Crash": a second controller on the same database, file renamed.
    const h2 = await createHarness({ drafts: h.drafts, checkpoints: h.checkpoints, kv: h.deps.kv, handles: h.deps.handles, hashCache: h.deps.hashCache });
    const fs2 = new FakeFs('v2', { 'renamed.mp4': videoBytes('a') });
    await h2.api.openFileHandle(fs2.file('renamed.mp4'), fs2.root);
    await h2.idle();
    expect(h2.state().video.identity).toBe('verified');
    expect(h2.state().editor.doc.segments.map((s) => [s.start, s.end])).toEqual([[30, 40]]);
    expect(h2.state().editor.dirty).toBe(true);
    h2.api.dispose();
  });

  it('promotes a pending draft to its sha256 key', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    await h.cleanup();
    h = await createHarness({
      hashing: {
        fingerprint: async (file) => `fp1:${file.size}:x`,
        sha256: async (file) => {
          await gate;
          return sha256Hex(new Uint8Array(await file.arrayBuffer()));
        },
      },
    });
    const fs = new FakeFs('v', { 'a.mp4': videoBytes('a') });
    await h.api.openDirectoryHandle(fs.root);
    expect(h.state().video.hash.state).toBe('hashing');
    await mark(1, 5);
    await h.api.flushAutosave();
    const pk = pendingKey(`fp1:${videoBytes('a').length}:x`);
    expect((await h.drafts.get(pk))?.segments).toHaveLength(1);
    await h.api.actions.createCheckpoint('while pending');
    release();
    await h.idle();
    const sha = sha256Hex(videoBytes('a'));
    expect(await h.drafts.get(pk)).toBeNull();
    expect((await h.drafts.get(sha))?.segments).toHaveLength(1);
    expect(h.state().checkpoints.map((c) => c.name)).toEqual(['while pending']);
    await mark(10, 20);
    await h.api.flushAutosave();
    expect((await h.drafts.get(sha))?.segments).toHaveLength(2);
  });

  it('autosave conflict → stale banner; keep-mine checkpoints the stored version then overwrites', async () => {
    const fs = new FakeFs('v', { 'a.mp4': videoBytes('a') });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    await mark(0, 10);
    await h.api.flushAutosave();
    const sha = sha256Hex(videoBytes('a'));
    const stored = await h.drafts.get(sha);
    // Another tab (no shared channel) saves a newer revision.
    const other = new DraftStore({ db: h.db, tabId: 'tab-other', createChannel: () => null });
    const theirs = { ...stored!, segments: [{ id: 'o1', phaseId: PREP, start: 100, end: 120 }] };
    expect((await other.save(theirs, stored!.revision)).ok).toBe(true);

    await mark(50, 60);
    await h.api.flushAutosave();
    expect(h.state().save.kind).toBe('conflict');
    expect(h.state().stale).toMatchObject({ revision: stored!.revision + 1 });
    // Nothing was overwritten.
    expect((await h.drafts.get(sha))?.segments.map((s) => s.start)).toEqual([100]);

    await h.api.actions.resolveStale('keep-mine');
    await h.api.flushAutosave();
    expect(h.state().stale).toBeNull();
    const after = await h.drafts.get(sha);
    expect(after?.revision).toBe(stored!.revision + 2);
    expect(after?.segments.map((s) => s.start)).toEqual([0, 50]);
    expect(h.state().checkpoints[0]).toMatchObject({ kind: 'auto-before-conflict', segmentCount: 1 });
    expect(h.state().save.kind).toBe('saved');
  });

  it('another tab’s broadcast shows the banner immediately; load-newer keeps mine as a checkpoint', async () => {
    const fs = new FakeFs('v', { 'a.mp4': videoBytes('a') });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    await mark(0, 10);
    await h.api.flushAutosave();
    const sha = sha256Hex(videoBytes('a'));
    const stored = await h.drafts.get(sha);
    const other = new DraftStore({ db: h.db, tabId: 'tab-other', createChannel: () => h.hub.create() });
    await other.save({ ...stored!, segments: [{ id: 'o1', phaseId: PREP, start: 200, end: 210 }] }, stored!.revision);
    expect(h.state().stale).not.toBeNull();

    await h.api.actions.resolveStale('load-newer');
    expect(h.state().stale).toBeNull();
    expect(ranges()).toEqual([[PREP, 200, 210]]);
    expect(h.state().checkpoints[0]).toMatchObject({ kind: 'auto-before-conflict', segmentCount: 1 });
    await mark(220, 230);
    await h.api.flushAutosave();
    expect(h.state().save.kind).toBe('saved');
    expect((await h.drafts.get(sha))?.segments).toHaveLength(2);
    other.close();
  });
});

describe('checkpoints', () => {
  it('restore keeps a pre-restore checkpoint and is undoable', async () => {
    const fs = new FakeFs('v', { 'a.mp4': videoBytes('a') });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    await mark(0, 10);
    await h.api.actions.createCheckpoint('one segment');
    await mark(20, 30);
    expect(h.state().checkpoints.map((c) => [c.name, c.kind, c.segmentCount])).toEqual([['one segment', 'manual', 1]]);

    await h.api.actions.restoreCheckpoint(h.state().checkpoints[0].id);
    expect(ranges()).toEqual([[PREP, 0, 10]]);
    const cps = h.state().checkpoints;
    expect(cps).toHaveLength(2);
    expect(cps[0]).toMatchObject({ kind: 'auto-before-restore', segmentCount: 2 });
    expect(h.state().toasts.at(-1)?.msg.key).toBe('checkpoints.restored');

    h.api.actions.undo();
    expect(ranges()).toHaveLength(2);

    await h.api.actions.deleteCheckpoint(cps[1].id);
    expect(h.state().checkpoints.map((c) => c.kind)).toEqual(['auto-before-restore']);
  });
});

describe('settings & library persistence', () => {
  it('persists language, export format and custom phases across controllers', async () => {
    h.api.actions.setLanguage('zh-Hant');
    h.api.actions.setExportFormat('json');
    const r = h.api.actions.addCustomPhase('縫合');
    expect(r.ok).toBe(true);
    const dup = h.api.actions.addCustomPhase('縫合');
    expect(dup.ok).toBe(false);
    const id = r.ok ? r.id : '';
    expect(id).toMatch(/^phase-[0-9a-f]{6}$/);
    expect(h.state().selectedPhaseId).toBe(id);
    const presetId = h.api.actions.createPreset('Suturing');
    h.api.actions.setPresetPhases(presetId, [id]);
    h.api.actions.setActivePreset(presetId);
    await new Promise((r2) => setTimeout(r2, 20));

    const h2 = await createHarness({ kv: h.deps.kv, handles: h.deps.handles });
    expect(h2.state().settings.language).toBe('zh-Hant');
    expect(h2.state().settings.exportFormat).toBe('json');
    expect(h2.state().library.phases[id]?.name).toBe('縫合');
    expect(h2.state().library.activePresetId).toBe(presetId);
    h2.api.actions.setLanguage('en');
    h2.api.dispose();
  });
});
