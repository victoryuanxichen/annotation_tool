import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeFs } from './helpers/fakeFs';
import { createHarness, videoBytes, type Harness } from './helpers/stateFakes';
import { MAX_VISIBLE_RECENT, showInVisibleRecent } from '../../src/state/recent';

const PREP = 'chole.preparation';
const CALOT = 'chole.calot-triangle-dissection';

let h: Harness;
let fs: FakeFs;

async function openCase(frames = 250): Promise<void> {
  fs = new FakeFs('root', { 'case.mp4': videoBytes('case') });
  h.frameCounts.set('case.mp4', frames);
  await h.api.openFileHandle(fs.file('case.mp4'), fs.root);
  await h.idle();
}

function segs(): [string, number, number][] {
  return h.state().editor.doc.segments.map((s) => [s.phaseId, s.start, s.end]);
}

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.cleanup();
});

describe('marking (Q/W/E/R)', () => {
  it('marks half-open segments at confirmed frames, E chains, R ends at N', async () => {
    await openCase(250);
    expect(h.state().video.loadPhase).toBe('ready');
    h.api.actions.selectPhase(PREP);

    h.player.displayed = 100;
    await h.api.actions.markStart();
    expect(h.state().editor.pendingStart).toBe(100);

    h.player.displayed = 150;
    await h.api.actions.markFinishAndNext();
    expect(segs()).toEqual([[PREP, 100, 150]]);
    expect(h.state().editor.pendingStart).toBe(150);
    expect(h.state().markFeedback).toMatchObject({ kind: 'ok', msg: { key: 'mark.added', params: { start: 100, end: 150 } } });

    h.api.actions.selectPhase(CALOT);
    h.player.displayed = 249; // last frame displayed; W makes [150, 249)
    await h.api.actions.markFinish();
    expect(segs()).toEqual([
      [PREP, 100, 150],
      [CALOT, 150, 249],
    ]);
    expect(h.state().editor.pendingStart).toBeNull();

    // R: through end of video includes the last frame: end = N.
    h.player.displayed = 249;
    await h.api.actions.markStart();
    await h.api.actions.undo(); // undo the pending start
    expect(h.state().editor.pendingStart).toBeNull();
    await h.api.actions.redo();
    expect(h.state().editor.pendingStart).toBe(249);
    await h.api.actions.markThroughEnd();
    expect(segs()).toContainEqual([CALOT, 249, 250]);
    expect(h.state().editor.touched).toBe(true);
    expect(h.state().editor.dirty).toBe(true);
    expect(h.state().batch.items[0].status).toBe('draft');
  });

  it('refuses to commit when the displayed frame cannot be confirmed', async () => {
    await openCase();
    h.api.actions.selectPhase(PREP);
    h.player.displayed = 10;
    await h.api.actions.markStart();

    h.player.displayed = 60;
    h.player.settleMode = 'hang';
    await h.api.actions.markFinish();
    expect(segs()).toEqual([]);
    expect(h.state().markFeedback).toMatchObject({ kind: 'error', msg: { key: 'ctl.mark.notConfirmed.timeout' } });
    expect(h.state().editor.pendingStart).toBe(10);

    h.player.settleMode = { error: 'decode_failed' };
    await h.api.actions.markFinish();
    expect(segs()).toEqual([]);
    expect(h.state().markFeedback).toMatchObject({ kind: 'error', msg: { key: 'ctl.mark.notConfirmed.decoder', params: { code: 'decode_failed' } } });

    h.player.settleMode = { error: 'decode_failed' };
    await h.api.actions.markStart();
    expect(h.state().editor.pendingStart).toBe(10);
  });

  it('shows a waiting state until the frame settles', async () => {
    await openCase();
    h.api.actions.selectPhase(PREP);
    h.player.holdSettle();
    h.player.displayed = 5;
    const p = h.api.actions.markStart();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.state().markFeedback?.kind).toBe('waiting');
    expect(h.state().editor.pendingStart).toBeNull();
    h.player.releaseSettle();
    await p;
    expect(h.state().editor.pendingStart).toBe(5);
  });

  it('uses the displayed frame directly during playback', async () => {
    await openCase();
    h.api.actions.selectPhase(PREP);
    h.player.displayed = 20;
    await h.api.actions.markStart();
    h.player.playing = true;
    h.player.displayed = 70;
    h.player.settleMode = { error: 'decode_failed' };
    const before = h.player.settleCalls;
    await h.api.actions.markFinish();
    expect(h.player.settleCalls).toBe(before);
    expect(segs()).toEqual([[PREP, 20, 70]]);
  });

  it('validates: no phase, no pending start, end <= start, not ready', async () => {
    const fresh = await createHarness();
    await fresh.api.actions.markStart();
    expect(fresh.state().markFeedback?.msg.key).toBe('mark.err.notReady');
    await fresh.cleanup();

    await openCase();
    h.player.displayed = 30;
    await h.api.actions.markFinish();
    expect(h.state().markFeedback?.msg.key).toBe('mark.err.noPhase');
    h.api.actions.selectPhase(PREP);
    await h.api.actions.markFinish();
    expect(h.state().markFeedback?.msg.key).toBe('mark.err.noPending');
    await h.api.actions.markThroughEnd();
    expect(h.state().markFeedback?.msg.key).toBe('mark.err.noPending');
    await h.api.actions.markStart();
    await h.api.actions.markFinish(); // same frame: empty range
    expect(h.state().markFeedback).toMatchObject({ kind: 'error', msg: { key: 'mark.err.endBeforeStart', params: { start: 30 } } });
    h.player.displayed = 10;
    await h.api.actions.markFinish();
    expect(h.state().markFeedback?.msg.key).toBe('mark.err.endBeforeStart');
    expect(segs()).toEqual([]);
  });

  it('rejects overlaps and offers "Replace overlapped frames"', async () => {
    await openCase();
    h.api.actions.selectPhase(PREP);
    h.player.displayed = 100;
    await h.api.actions.markStart();
    h.player.displayed = 200;
    await h.api.actions.markFinish();

    h.api.actions.selectPhase(CALOT);
    h.player.displayed = 150;
    await h.api.actions.markStart();
    h.player.displayed = 250 - 1;
    await h.api.actions.markFinishAndNext();
    const fb = h.state().markFeedback;
    expect(fb).toMatchObject({ kind: 'error', msg: { key: 'mark.err.overlap', params: { count: 1 } } });
    expect(fb?.action?.label.key).toBe('mark.replaceOverlapped');
    expect(segs()).toEqual([[PREP, 100, 200]]);

    fb?.action?.run();
    expect(segs()).toEqual([
      [PREP, 100, 150],
      [CALOT, 150, 249],
    ]);
    expect(h.state().editor.pendingStart).toBe(249); // E semantics kept by the remedy
    h.api.actions.undo();
    expect(segs()).toEqual([[PREP, 100, 200]]);
    expect(h.state().editor.pendingStart).toBe(150);
  });
});

describe('undo / redo', () => {
  it('covers segment and pending-start changes and caps history', async () => {
    await openCase();
    h.api.actions.selectPhase(PREP);
    for (const [a, b] of [
      [0, 10],
      [10, 20],
    ]) {
      h.player.displayed = a;
      await h.api.actions.markStart();
      h.player.displayed = b;
      await h.api.actions.markFinish();
    }
    expect(segs()).toHaveLength(2);
    expect(h.state().editor.canUndo).toBe(true);
    h.api.actions.undo();
    expect(segs()).toHaveLength(1);
    expect(h.state().editor.pendingStart).toBe(10);
    h.api.actions.undo();
    expect(h.state().editor.pendingStart).toBeNull();
    expect(h.state().editor.canRedo).toBe(true);
    h.api.actions.redo();
    h.api.actions.redo();
    expect(segs()).toHaveLength(2);
    expect(h.state().editor.canRedo).toBe(false);

    const id = h.state().editor.doc.segments[0].id;
    h.api.actions.deleteSegment(id);
    expect(segs()).toHaveLength(1);
    h.api.actions.undo();
    expect(segs()).toHaveLength(2);
  });
});

describe('segment editing', () => {
  it('moves shared boundaries with linkAdjacent and confirms the frame first', async () => {
    await openCase();
    h.api.actions.selectPhase(PREP);
    h.player.displayed = 0;
    await h.api.actions.markStart();
    h.player.displayed = 100;
    await h.api.actions.markFinishAndNext();
    h.api.actions.selectPhase(CALOT);
    h.player.displayed = 200;
    await h.api.actions.markFinish();
    const second = h.state().editor.doc.segments[1];

    const ok = await h.api.actions.setSegmentBounds(second.id, { start: 120 }, { linkAdjacent: true });
    expect(ok).toBe(true);
    expect(h.player.seeks).toContain(120);
    expect(segs()).toEqual([
      [PREP, 0, 120],
      [CALOT, 120, 200],
    ]);

    const bad = await h.api.actions.setSegmentBounds(second.id, { start: 300 });
    expect(bad).toBe(false);
    expect(h.state().markFeedback?.kind).toBe('error');

    h.player.displayed = 180;
    await h.api.actions.setSegmentBoundaryToCurrent(second.id, 'end');
    expect(segs()[1]).toEqual([CALOT, 120, 180]);

    h.api.actions.relabelSegment(second.id, PREP);
    expect(segs()[1][0]).toBe(PREP);
    h.api.actions.selectSegment(second.id);
    expect(h.state().editor.selectedSegmentId).toBe(second.id);
    expect(h.player.displayed).toBe(120);
  });
});

describe('visible recent chips', () => {
  it('pure rule: replace the least recent visible chip in place', () => {
    const visible = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const recent = ['c', 'a', 'b', 'd', 'e', 'f', 'g', 'h', 'j', 'i'];
    expect(showInVisibleRecent(visible, 'a', recent)).toBe(visible);
    const next = showInVisibleRecent(visible, 'z', recent);
    expect(next).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'z', 'j']);
    expect(showInVisibleRecent(['a'], 'z', [])).toEqual(['a', 'z']);
  });

  it('stays stable while phases are used and selected', async () => {
    await openCase();
    // No active preset: the chips start empty and fill in order of first use.
    h.api.actions.setActivePreset(null);
    expect(h.state().visibleRecent).toEqual([]);
    const lib = h.state().library;
    const ids = Object.keys(lib.phases);
    expect(ids.length).toBeGreaterThan(MAX_VISIBLE_RECENT + 1);
    // Use eleven phases: the visible list fills up in order of first use.
    for (let i = 0; i <= MAX_VISIBLE_RECENT; i++) {
      h.api.actions.selectPhase(ids[i]);
      h.player.displayed = i * 10;
      await h.api.actions.markStart();
      h.player.displayed = i * 10 + 5;
      await h.api.actions.markFinish();
    }
    const visible = h.state().visibleRecent;
    expect(visible).toHaveLength(MAX_VISIBLE_RECENT);
    // ids[0] was least recent when ids[10] was used, so ids[10] took slot 0.
    expect(visible[0]).toBe(ids[MAX_VISIBLE_RECENT]);
    expect(visible.slice(1)).toEqual(ids.slice(1, MAX_VISIBLE_RECENT));
    expect(h.state().library.recent[0]).toBe(ids[MAX_VISIBLE_RECENT]);

    // Using a visible phase reorders library.recent but never the chips.
    h.api.actions.selectRecentSlot(5);
    expect(h.state().selectedPhaseId).toBe(visible[4]);
    h.player.displayed = 200;
    await h.api.actions.markStart();
    h.player.displayed = 210;
    await h.api.actions.markFinish();
    expect(h.state().visibleRecent).toEqual(visible);
    expect(h.state().library.recent[0]).toBe(visible[4]);

    // Selecting a hidden phase replaces the least recent visible chip only.
    h.api.actions.selectPhase(ids[0]);
    const after = h.state().visibleRecent;
    expect(after.filter((id, i) => id !== visible[i])).toEqual([ids[0]]);
    expect(after.indexOf(ids[0])).toBe(1); // ids[1] was the least recently used visible phase

    // Reopening a video recomputes the chips from library.recent.
    h.api.actions.clearRecent();
    expect(h.state().visibleRecent).toEqual([]);
    expect(h.state().library.recent).toEqual([]);
  });

  it('tops up the chips from the active preset until phases have been used', async () => {
    await openCase();
    const lib = h.state().library;
    const preset = lib.presets.find((p) => p.id === lib.activePresetId);
    expect(preset).toBeDefined();
    expect(lib.recent).toEqual([]);
    expect(h.state().visibleRecent).toEqual(preset?.phaseIds.slice(0, MAX_VISIBLE_RECENT));
    // Slot 2 works on a first session.
    h.api.actions.selectRecentSlot(2);
    expect(h.state().selectedPhaseId).toBe(preset?.phaseIds[1]);
    // Switching preset while nothing has been used follows the new preset.
    const other = lib.presets.find((p) => p.id !== lib.activePresetId);
    h.api.actions.setActivePreset(other?.id ?? null);
    expect(h.state().visibleRecent).toEqual(other?.phaseIds.slice(0, MAX_VISIBLE_RECENT));
  });
});
