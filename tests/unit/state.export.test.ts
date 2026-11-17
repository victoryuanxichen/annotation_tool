import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAnnotationFile } from '../../src/core/formats/import';
import { computeContentHash, newDraft } from '../../src/storage/drafts';
import type { WindowLike } from '../../src/state/deps';
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

async function mark(start: number, end: number, phase = PREP): Promise<void> {
  h.api.actions.selectPhase(phase);
  h.player.displayed = start;
  await h.api.actions.markStart();
  h.player.displayed = end;
  await h.api.actions.markFinish();
}

function current(): string | null {
  return h.state().batch.currentId;
}

describe('switch gate', () => {
  it('exports beside the video before switching; untouched videos are not exported', async () => {
    const fs = new FakeFs('videos', { 'a.mp4': videoBytes('a'), 'b.mp4': videoBytes('b'), 'c.mp4': videoBytes('c') });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    expect(h.state().batch.items.map((i) => i.relPath)).toEqual(['a.mp4', 'b.mp4', 'c.mp4']);
    expect(current()).toBe('a.mp4');

    await mark(10, 20);
    await h.api.actions.nextVideo();
    await h.idle();
    expect(current()).toBe('b.mp4');
    const text = fs.readText('a.phases.csv');
    expect(text).not.toBeNull();
    const parsed = parseAnnotationFile(text as string, 'a.phases.csv');
    expect(parsed.ok && parsed.file.records.map((r) => [r.startFrame, r.endFrame])).toEqual([[10, 20]]);
    expect(parsed.ok && parsed.file.video.sha256).toBe(sha256Hex(videoBytes('a')));
    expect(h.state().batch.items.find((i) => i.id === 'a.mp4')?.status).toBe('annotated');

    // b is untouched: switching exports nothing.
    await h.api.actions.nextVideo();
    await h.idle();
    expect(current()).toBe('c.mp4');
    expect(fs.readText('b.phases.csv')).toBeNull();
    expect(h.state().unexportedCount).toBe(0);

    // Back to a: the exported draft is loaded, clean.
    await h.api.actions.selectVideo('a.mp4');
    await h.idle();
    expect(h.state().editor.doc.segments).toHaveLength(1);
    expect(h.state().editor.dirty).toBe(false);
    expect(h.state().exportStatus.kind).toBe('exported');
  });

  it('stays on the video when validation fails', async () => {
    const fs = new FakeFs('videos', { 'a.mp4': videoBytes('a'), 'b.mp4': videoBytes('b') });
    const sha = sha256Hex(videoBytes('a'));
    // A stored draft with overlapping segments (e.g. from an older version) cannot be exported.
    const base = newDraft({ sha256: sha, fingerprint: `fp1:${videoBytes('a').length}:${sha}`, fileName: 'a.mp4', relPath: 'a.mp4', frameCount: 250, durationUs: 250 * 40000 });
    const phases = { [PREP]: { id: PREP, name: 'Preparation', color: '#fe8b83' } };
    const segments = [
      { id: 's1', phaseId: PREP, start: 0, end: 50 },
      { id: 's2', phaseId: PREP, start: 40, end: 60 },
    ];
    await h.drafts.save({ ...base, segments, phases, contentHash: computeContentHash(segments, phases), touched: true } as typeof base, 0);

    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    expect(h.state().video.identity).toBe('verified');
    expect(h.state().editor.issues.map((i) => i.code)).toEqual(['overlap']);
    expect(h.state().editor.dirty).toBe(true);

    await h.api.actions.nextVideo();
    expect(current()).toBe('a.mp4');
    const dlg = h.state().dialog;
    expect(dlg?.kind).toBe('switch-failed');
    if (dlg?.kind === 'switch-failed') {
      expect(dlg.targetItemId).toBe('b.mp4');
      expect(dlg.failure.reason).toBe('validation');
    }
    expect(h.state().video.loadPhase).toBe('ready');
    expect(h.state().editor.doc.segments).toHaveLength(2);

    await h.api.actions.resolveSwitchFailure('stay');
    expect(h.state().dialog).toBeNull();
    expect(current()).toBe('a.mp4');
  });

  it('stays on write failure; download-and-switch recovers', async () => {
    const fs = new FakeFs('videos', { 'a.mp4': videoBytes('a'), 'b.mp4': videoBytes('b') });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    await mark(0, 25);
    fs.permission.readwrite = 'denied';
    fs.requestResult = 'denied';

    await h.api.actions.nextVideo();
    expect(current()).toBe('a.mp4');
    const dlg = h.state().dialog;
    expect(dlg?.kind === 'switch-failed' && dlg.failure.reason).toBe('write');
    if (dlg?.kind === 'switch-failed' && dlg.failure.reason === 'write') {
      expect(dlg.failure.msg.key).toBe('ctl.export.failed.permission_denied');
    }
    expect(h.state().exportStatus.kind).toBe('error');
    expect(fs.readText('a.phases.csv')).toBeNull();

    await h.api.actions.resolveSwitchFailure('download-and-switch');
    await h.idle();
    expect(h.downloads.map((d) => d.name)).toEqual(['a.phases.csv']);
    expect(current()).toBe('b.mp4');
    expect(h.state().dialog).toBeNull();
    expect(h.state().unexportedCount).toBe(0);
  });

  it('switch-without-export keeps the draft and counts it for the leave warning', async () => {
    const handlers: ((e: BeforeUnloadEvent) => void)[] = [];
    const win = {
      addEventListener: (type: string, l: (e: BeforeUnloadEvent) => void) => {
        if (type === 'beforeunload') handlers.push(l);
      },
      removeEventListener: () => undefined,
      document: { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined },
    } as unknown as WindowLike;
    await h.cleanup();
    h = await createHarness({}, { window: win });

    const fs = new FakeFs('videos', { 'a.mp4': videoBytes('a'), 'b.mp4': videoBytes('b') });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    await mark(5, 15);
    fs.permission.readwrite = 'denied';
    fs.requestResult = 'denied';
    await h.api.actions.nextVideo();
    expect(h.state().dialog?.kind).toBe('switch-failed');

    await h.api.actions.resolveSwitchFailure('switch-without-export');
    await h.idle();
    expect(current()).toBe('b.mp4');
    expect(h.state().unexportedCount).toBe(1);
    expect(h.state().batch.items.find((i) => i.id === 'a.mp4')?.status).toBe('draft');
    const stored = await h.drafts.get(sha256Hex(videoBytes('a')));
    expect(stored?.segments.map((s) => [s.start, s.end])).toEqual([[5, 15]]);

    // Last video: the native leave warning fires.
    let prevented = false;
    const ev = { preventDefault: () => (prevented = true), returnValue: undefined } as unknown as BeforeUnloadEvent;
    handlers.forEach((fn) => fn(ev));
    expect(prevented).toBe(true);
  });

  it('warns on leaving the last video with unexported changes', async () => {
    const handlers: ((e: BeforeUnloadEvent) => void)[] = [];
    const win = {
      addEventListener: (type: string, l: (e: BeforeUnloadEvent) => void) => {
        if (type === 'beforeunload') handlers.push(l);
      },
      removeEventListener: () => undefined,
      document: { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined },
    } as unknown as WindowLike;
    await h.cleanup();
    h = await createHarness({}, { window: win });
    const fs = new FakeFs('videos', { 'only.mp4': videoBytes('only') });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    const fire = (): boolean => {
      let prevented = false;
      handlers.forEach((fn) => fn({ preventDefault: () => (prevented = true) } as unknown as BeforeUnloadEvent));
      return prevented;
    };
    expect(fire()).toBe(false);
    await mark(0, 10);
    expect(h.state().unexportedCount).toBe(1);
    expect(fire()).toBe(true);
    expect(await h.api.actions.exportNow()).toBe(true);
    expect(fire()).toBe(false);
    expect(h.state().unexportedCount).toBe(0);
  });
});

describe('export targets', () => {
  it('writes into the chosen folder mirroring sub-directories (same-name videos do not collide)', async () => {
    const fs = new FakeFs('videos', { day1: { 'case.mp4': videoBytes('d1') }, day2: { 'case.mp4': videoBytes('d2') } });
    const out = new FakeFs('exports');
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    await h.api.setExportFolderHandle(out.root);
    expect(h.state().settings.exportDestination).toEqual({ kind: 'folder', folderName: 'exports' });
    h.api.actions.setExportFormat('both');

    await mark(0, 10);
    expect(await h.api.actions.exportNow()).toBe(true);
    await h.api.actions.selectVideo('day2/case.mp4');
    await h.idle();
    await mark(20, 30);
    await h.api.actions.exportNow();

    const d1 = parseAnnotationFile(out.readText('day1/case.phases.csv') as string, 'x');
    const d2 = parseAnnotationFile(out.readText('day2/case.phases.json') as string, 'x');
    expect(d1.ok && d1.file.video.sha256).toBe(sha256Hex(videoBytes('d1')));
    expect(d2.ok && d2.file.records[0].startFrame).toBe(20);
    expect(out.readText('day2/case.phases.csv')).not.toBeNull();
    expect(fs.readText('day1/case.phases.csv')).toBeNull();
    const st = h.state().exportStatus;
    expect(st.kind === 'exported' && st.targets).toEqual(['exports/day2/case.phases.csv', 'exports/day2/case.phases.json']);
  });

  it('overwrites only files of the same video', async () => {
    const other = sidecarText(videoBytes('someone-else'), 250, [], {});
    const fs = new FakeFs('videos', { 'a.mp4': videoBytes('a'), 'a.phases.csv': other });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    expect(h.state().video.sidecars[0].state).toBe('mismatch');
    expect(h.state().editor.doc.segments).toEqual([]);

    await mark(0, 10);
    expect(await h.api.actions.exportNow()).toBe(false);
    expect(fs.readText('a.phases.csv')).toBe(other);
    expect(h.state().exportStatus).toMatchObject({ kind: 'error', msg: { key: 'ctl.export.targetOtherVideo' } });
    expect(h.state().toasts.at(-1)?.msg.key).toBe('ctl.export.targetOtherVideo');

    fs.root.populate({ 'a.phases.csv': 'not, an, export\n1,2,3' });
    expect(await h.api.actions.exportNow()).toBe(false);
    expect(h.state().exportStatus).toMatchObject({ kind: 'error', msg: { key: 'ctl.export.targetUnparseable' } });

    // Our own earlier export (same sha256) is replaced.
    fs.root.populate({ 'a.phases.csv': sidecarText(videoBytes('a'), 250, [], {}) });
    expect(await h.api.actions.exportNow()).toBe(true);
    const p = parseAnnotationFile(fs.readText('a.phases.csv') as string, 'a');
    expect(p.ok && p.file.records.length).toBe(1);
  });

  it('exports the empty-annotation form for a touched, emptied draft', async () => {
    const fs = new FakeFs('videos', { 'a.mp4': videoBytes('a'), 'b.mp4': videoBytes('b') });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    await mark(0, 10);
    h.api.actions.deleteSegment(h.state().editor.doc.segments[0].id);
    expect(h.state().editor.touched).toBe(true);
    expect(h.state().editor.dirty).toBe(true);
    await h.api.actions.nextVideo();
    await h.idle();
    expect(current()).toBe('b.mp4');
    const text = fs.readText('a.phases.csv') as string;
    const lines = text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(`1,${sha256Hex(videoBytes('a'))},250,10000000,,,,,,`);
    const p = parseAnnotationFile(text, 'a');
    expect(p.ok && p.file.records).toEqual([]);
  });

  it('downloads directly when the destination is download', async () => {
    const fs = new FakeFs('videos', { 'a.mp4': videoBytes('a') });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    await h.api.actions.setExportDestination('download');
    h.api.actions.setExportFormat('json');
    await mark(3, 9);
    expect(await h.api.actions.exportNow()).toBe(true);
    expect(h.downloads.map((d) => d.name)).toEqual(['a.phases.json']);
    expect(fs.readText('a.phases.json')).toBeNull();
    expect(h.state().toasts.at(-1)?.msg.key).toBe('export.downloaded');
  });

  it('single file without folder access: export fails with a clear message, choose-folder recovers', async () => {
    const fs = new FakeFs('videos', { 'solo.mp4': videoBytes('solo') });
    const out = new FakeFs('out');
    await h.api.openFileHandle(fs.file('solo.mp4'));
    await h.idle();
    expect(h.state().batch.mode).toBe('file');
    expect(h.state().video.sourceFolder).toBe('needs-access');
    await mark(1, 2);
    expect(await h.api.actions.exportNow()).toBe(false);
    expect(h.state().exportStatus).toMatchObject({ kind: 'error', msg: { key: 'ctl.export.noSourceFolder' } });

    // Switching to another file hits the gate; choosing a folder exports and switches.
    h.deps.fs.pickExportFolder = async () => ({ kind: 'handle', handle: out.root, name: 'out', path: [], canWrite: () => true });
    const fs2 = new FakeFs('more', { 'next.mp4': videoBytes('next') });
    await h.api.openFileHandle(fs2.file('next.mp4'), fs2.root);
    expect(h.state().dialog?.kind).toBe('switch-failed');
    await h.api.actions.resolveSwitchFailure('choose-folder');
    await h.idle();
    expect(out.readText('solo.phases.csv')).not.toBeNull();
    expect(h.state().video.fileName).toBe('next.mp4');
    expect(h.state().settings.exportDestination.kind).toBe('folder');
  });
});

describe('integration fixes', () => {
  it('finds a sidecar exported after the folder scan when the video is reopened', async () => {
    const fs = new FakeFs('videos', { 'a.mp4': videoBytes('a'), 'b.mp4': videoBytes('b') });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    await mark(10, 20);
    await h.api.actions.nextVideo();
    await h.idle();
    await h.api.actions.prevVideo();
    await h.idle();
    expect(current()).toBe('a.mp4');
    expect(h.state().video.sidecars.map((s) => [s.name, s.state])).toEqual([['a.phases.csv', 'match']]);
    expect(h.state().dialog).toBeNull();
  });

  it('close folder asks first with unexported changes; a second call leaves without exporting', async () => {
    const fs = new FakeFs('videos', { 'a.mp4': videoBytes('a'), 'b.mp4': videoBytes('b') });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    await mark(10, 20);
    await h.api.actions.closeBatch();
    expect(h.state().dialog).toEqual({ kind: 'confirm-close-batch', unexportedCount: 1 });
    expect(h.state().batch.mode).toBe('folder');

    h.api.actions.closeDialog();
    await h.api.actions.closeBatch();
    expect(h.state().dialog?.kind).toBe('confirm-close-batch');
    await h.api.actions.closeBatch(); // "Leave anyway"
    expect(h.state().dialog).toBeNull();
    expect(h.state().batch.mode).toBe('none');
    expect(fs.readText('a.phases.csv')).toBeNull();
    expect(h.state().unexportedCount).toBe(1);
  });

  it('close folder without unexported changes closes at once', async () => {
    const fs = new FakeFs('videos', { 'a.mp4': videoBytes('a') });
    await h.api.openDirectoryHandle(fs.root);
    await h.idle();
    await h.api.actions.closeBatch();
    expect(h.state().dialog).toBeNull();
    expect(h.state().batch.mode).toBe('none');
  });
});
