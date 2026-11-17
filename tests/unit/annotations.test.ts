import { describe, expect, it } from 'vitest';
import {
  addSegment,
  contentHash,
  deleteSegment,
  findSegmentAt,
  fnv1a64Hex,
  newSegmentId,
  relabelSegment,
  sortSegments,
  updateSegment,
  validateForExport,
} from '../../src/core/annotations';
import type { Segment } from '../../src/core/types';

const seg = (id: string, start: number, end: number, phaseId = 'p'): Segment => ({ id, phaseId, start, end });
const ranges = (segs: readonly Segment[]): [number, number][] => segs.map((s) => [s.start, s.end]);

describe('sortSegments / findSegmentAt', () => {
  it('sorts by start without mutating', () => {
    const input = [seg('b', 50, 60), seg('a', 0, 10), seg('c', 20, 30)];
    const copy = structuredClone(input);
    expect(sortSegments(input).map((s) => s.id)).toEqual(['a', 'c', 'b']);
    expect(input).toEqual(copy);
  });

  it('finds the segment covering a frame (half-open)', () => {
    const segs = [seg('a', 0, 250), seg('b', 250, 400), seg('c', 500, 600)];
    expect(findSegmentAt(segs, 0)?.id).toBe('a');
    expect(findSegmentAt(segs, 249)?.id).toBe('a');
    expect(findSegmentAt(segs, 250)?.id).toBe('b');
    expect(findSegmentAt(segs, 399)?.id).toBe('b');
    expect(findSegmentAt(segs, 400)).toBeNull();
    expect(findSegmentAt(segs, 599)?.id).toBe('c');
    expect(findSegmentAt(segs, 600)).toBeNull();
    expect(findSegmentAt([], 3)).toBeNull();
  });
});

describe('addSegment', () => {
  const base = [seg('a', 0, 100), seg('b', 100, 200)];

  it('inserts sorted and does not mutate the input', () => {
    const r = addSegment(base, seg('n', 300, 400), { frameCount: 500 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.segments.map((s) => s.id)).toEqual(['a', 'b', 'n']);
    expect(r.replaced).toEqual([]);
    expect(base).toHaveLength(2);
  });

  it('accepts an adjacent segment sharing a boundary', () => {
    const r = addSegment(base, seg('n', 200, 250));
    expect(r.ok).toBe(true);
  });

  it('accepts a segment ending at N (end of video)', () => {
    expect(addSegment(base, seg('n', 200, 500), { frameCount: 500 }).ok).toBe(true);
    const r = addSegment(base, seg('n', 200, 501), { frameCount: 500 });
    expect(r).toEqual({ ok: false, reason: 'out_of_range', conflicts: [] });
  });

  it('rejects empty, negative and non-integer ranges', () => {
    expect(addSegment([], seg('n', 5, 5))).toMatchObject({ ok: false, reason: 'empty' });
    expect(addSegment([], seg('n', 6, 5))).toMatchObject({ ok: false, reason: 'empty' });
    expect(addSegment([], seg('n', -1, 5))).toMatchObject({ ok: false, reason: 'out_of_range' });
    expect(addSegment([], seg('n', 1.5, 5))).toMatchObject({ ok: false, reason: 'out_of_range' });
    expect(addSegment([], seg('n', 0, Number.NaN))).toMatchObject({ ok: false, reason: 'out_of_range' });
  });

  it('rejects overlaps and lists the conflicting segments', () => {
    const r = addSegment(base, seg('n', 50, 150));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('overlap');
    expect(r.conflicts.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('replaceOverlaps trims neighbours', () => {
    const r = addSegment(base, seg('n', 50, 150, 'q'), { replaceOverlaps: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ranges(r.segments)).toEqual([[0, 50], [50, 150], [150, 200]]);
    expect(r.segments.map((s) => s.id)).toEqual(['a', 'n', 'b']);
    expect(r.replaced.map((s) => s.id)).toEqual(['a', 'b']);
    expect(r.replaced[0]).toEqual(seg('a', 0, 100)); // originals are reported
  });

  it('replaceOverlaps splits a segment that contains the new one', () => {
    const r = addSegment([seg('a', 0, 100)], seg('n', 40, 60, 'q'), { replaceOverlaps: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ranges(r.segments)).toEqual([[0, 40], [40, 60], [60, 100]]);
    expect(r.segments[0].id).toBe('a');
    expect(r.segments[2].id).not.toBe('a');
    expect(r.segments[2].phaseId).toBe('p');
    expect(new Set(r.segments.map((s) => s.id)).size).toBe(3);
  });

  it('replaceOverlaps removes fully covered segments', () => {
    const r = addSegment([seg('a', 10, 20), seg('b', 30, 40), seg('c', 50, 60)], seg('n', 5, 45), { replaceOverlaps: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.segments.map((s) => s.id)).toEqual(['n', 'c']);
    expect(r.replaced.map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('updateSegment', () => {
  const N = 500;
  const adjacent = [seg('a', 0, 250), seg('b', 250, 400), seg('c', 450, 500)];

  it('moves a boundary without linking when it does not create an overlap', () => {
    const r = updateSegment(adjacent, 'b', { end: 420 }, N);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ranges(r.segments)).toEqual([[0, 250], [250, 420], [450, 500]]);
    expect(r.linked).toEqual([]);
  });

  it('rejects an overlapping edit without linkAdjacent', () => {
    const r = updateSegment(adjacent, 'b', { start: 240 }, N);
    expect(r).toMatchObject({ ok: false, reason: 'overlap' });
    if (!r.ok) expect(r.conflicts.map((s) => s.id)).toEqual(['a']);
  });

  it('linkAdjacent moves a shared boundary on both sides (left)', () => {
    const r = updateSegment(adjacent, 'b', { start: 240 }, N, { linkAdjacent: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ranges(r.segments)).toEqual([[0, 240], [240, 400], [450, 500]]);
    expect(r.linked.map((s) => s.id)).toEqual(['a']);
  });

  it('linkAdjacent moves a shared boundary on both sides (right, opening no gap)', () => {
    const r = updateSegment(adjacent, 'a', { end: 260 }, N, { linkAdjacent: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ranges(r.segments)).toEqual([[0, 260], [260, 400], [450, 500]]);
  });

  it('linkAdjacent does not link across a gap', () => {
    const r = updateSegment(adjacent, 'b', { end: 430 }, N, { linkAdjacent: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(ranges(r.segments)).toEqual([[0, 250], [250, 430], [450, 500]]);
    expect(updateSegment(adjacent, 'b', { end: 460 }, N, { linkAdjacent: true })).toMatchObject({ ok: false, reason: 'overlap' });
  });

  it('linkAdjacent rejects edits that would empty the neighbour', () => {
    const r = updateSegment(adjacent, 'b', { start: 0 }, N, { linkAdjacent: true });
    expect(r).toMatchObject({ ok: false, reason: 'empty' });
    if (!r.ok) expect(r.conflicts.map((s) => s.id)).toEqual(['a']);
  });

  it('rejects empty, out-of-range and unknown ids', () => {
    expect(updateSegment(adjacent, 'b', { end: 250 }, N)).toMatchObject({ ok: false, reason: 'empty' });
    expect(updateSegment(adjacent, 'c', { end: 501 }, N)).toMatchObject({ ok: false, reason: 'out_of_range' });
    expect(updateSegment(adjacent, 'a', { start: -1 }, N)).toMatchObject({ ok: false, reason: 'out_of_range' });
    expect(updateSegment(adjacent, 'zz', { start: 1 }, N)).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('can relabel through a patch and keeps the id', () => {
    const r = updateSegment(adjacent, 'a', { phaseId: 'x', id: 'hacked' } as never, N);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.segments[0]).toEqual(seg('a', 0, 250, 'x'));
  });
});

describe('deleteSegment / relabelSegment', () => {
  const segs = [seg('a', 0, 10), seg('b', 10, 20)];
  it('deletes by id', () => {
    expect(deleteSegment(segs, 'a').map((s) => s.id)).toEqual(['b']);
    expect(deleteSegment(segs, 'missing')).toEqual(segs);
  });
  it('relabels by id without mutating', () => {
    const out = relabelSegment(segs, 'b', 'x');
    expect(out[1].phaseId).toBe('x');
    expect(segs[1].phaseId).toBe('p');
  });
});

describe('validateForExport', () => {
  const exists = (id: string): boolean => id !== 'ghost';

  it('accepts adjacent, gapped and end-of-video segments', () => {
    expect(validateForExport([seg('a', 0, 250), seg('b', 250, 300), seg('c', 400, 500)], 500, exists)).toEqual([]);
    expect(validateForExport([], 500, exists)).toEqual([]);
  });

  it('reports every code with segment ids and params', () => {
    const issues = validateForExport(
      [seg('a', 0, 100), seg('b', 90, 120), seg('c', 130, 130), seg('d', 400, 510), seg('e', 1.5, 3), seg('f', 200, 210, 'ghost')],
      500,
      exists,
    );
    const byCode = Object.fromEntries(issues.map((i) => [i.code, i]));
    expect(issues.map((i) => i.code).sort()).toEqual(['empty', 'invalid_phase', 'not_integer', 'out_of_range', 'overlap']);
    expect(byCode.overlap.segmentIds).toEqual(['a', 'b']);
    expect(byCode.overlap.params).toMatchObject({ from: 90, to: 100 });
    expect(byCode.empty.segmentIds).toEqual(['c']);
    expect(byCode.out_of_range).toMatchObject({ segmentIds: ['d'], params: { start: 400, end: 510, frameCount: 500 } });
    expect(byCode.not_integer.segmentIds).toEqual(['e']);
    expect(byCode.invalid_phase).toMatchObject({ segmentIds: ['f'], params: { phaseId: 'ghost' } });
  });

  it('reports each overlapping pair, including nested ones', () => {
    const issues = validateForExport([seg('a', 0, 100), seg('b', 10, 20), seg('c', 30, 40)], 500, exists);
    expect(issues.map((i) => i.segmentIds)).toEqual([['a', 'b'], ['a', 'c']]);
  });
});

describe('hashing and ids', () => {
  it('fnv1a64Hex matches reference vectors', () => {
    expect(fnv1a64Hex('')).toBe('cbf29ce484222325');
    expect(fnv1a64Hex('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64Hex('foobar')).toBe('85944171f73967e8');
  });

  it('contentHash is deterministic, order-insensitive and ignores segment ids', () => {
    const names: Record<string, string> = { p: 'Prep', q: 'Dissection' };
    const nameOf = (id: string): string | undefined => names[id];
    const h1 = contentHash([seg('a', 0, 10), seg('b', 10, 20, 'q')], nameOf);
    const h2 = contentHash([seg('y', 10, 20, 'q'), seg('x', 0, 10)], nameOf);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    expect(contentHash([seg('a', 0, 11), seg('b', 11, 20, 'q')], nameOf)).not.toBe(h1);
    expect(contentHash([seg('a', 0, 10), seg('b', 10, 20, 'q')], (id) => (id === 'q' ? 'Renamed' : names[id]))).not.toBe(h1);
    expect(contentHash([], nameOf)).toBe(contentHash([], nameOf));
    expect(contentHash([], nameOf)).not.toBe(h1);
  });

  it('newSegmentId is unique', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newSegmentId()));
    expect(ids.size).toBe(2000);
  });
});
