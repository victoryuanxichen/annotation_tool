/**
 * Pure operations on the annotation model (SPEC §2). Segments are half-open frame ranges
 * [start, end) kept sorted by start. No function here mutates its inputs.
 */
import type { Segment } from './types';

export type SegmentRejection = 'empty' | 'out_of_range' | 'overlap';

export type AddSegmentResult =
  | { ok: true; segments: Segment[]; replaced: Segment[] }
  | { ok: false; reason: SegmentRejection; conflicts: Segment[] };

export interface AddSegmentOptions {
  /** Trim or split existing segments so the new one fits. */
  replaceOverlaps?: boolean;
  /** N; when given, `end > N` is rejected as out of range. */
  frameCount?: number;
}

export type SegmentPatch = Partial<Pick<Segment, 'phaseId' | 'start' | 'end'>>;

export type UpdateSegmentResult =
  | { ok: true; segments: Segment[]; /** neighbours whose shared boundary moved */ linked: Segment[] }
  | { ok: false; reason: SegmentRejection | 'not_found'; conflicts: Segment[] };

export interface UpdateSegmentOptions {
  /** Moving a boundary shared with an adjacent segment moves the neighbour's boundary too. */
  linkAdjacent?: boolean;
}

export type ValidationCode = 'overlap' | 'out_of_range' | 'empty' | 'invalid_phase' | 'not_integer';

export interface ValidationIssue {
  code: ValidationCode;
  segmentIds: string[];
  /** Interpolation values for i18n messages. */
  params: Record<string, string | number>;
}

function compareSegments(a: Segment, b: Segment): number {
  return a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function sortSegments(segs: readonly Segment[]): Segment[] {
  return [...segs].sort(compareSegments);
}

function overlaps(a: Pick<Segment, 'start' | 'end'>, b: Pick<Segment, 'start' | 'end'>): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Reason a single range is unusable, or null when it is a valid non-empty in-range range. */
function rangeProblem(start: number, end: number, frameCount: number | undefined): SegmentRejection | null {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 'out_of_range';
  if (start < 0 || (frameCount !== undefined && end > frameCount)) return 'out_of_range';
  if (end <= start) return 'empty';
  return null;
}

let idCounter = 0;

/** Unique, opaque segment id (random part + per-session counter so ids never collide in a session). */
export function newSegmentId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  idCounter = (idCounter + 1) % 0x100000;
  return `s-${hex}${idCounter.toString(36)}`;
}

/** Parts of `existing` that remain after removing [cut.start, cut.end). */
function subtractRange(existing: Segment, cut: Pick<Segment, 'start' | 'end'>): Segment[] {
  const parts: Segment[] = [];
  if (existing.start < cut.start) parts.push({ ...existing, end: cut.start });
  if (existing.end > cut.end) {
    const id = parts.length ? newSegmentId() : existing.id;
    parts.push({ ...existing, id, start: cut.end });
  }
  return parts;
}

export function addSegment(
  segs: readonly Segment[],
  seg: Segment,
  options: AddSegmentOptions = {},
): AddSegmentResult {
  const problem = rangeProblem(seg.start, seg.end, options.frameCount);
  if (problem) return { ok: false, reason: problem, conflicts: [] };

  const conflicts = segs.filter((s) => overlaps(s, seg));
  if (conflicts.length && !options.replaceOverlaps) {
    return { ok: false, reason: 'overlap', conflicts: sortSegments(conflicts) };
  }
  const next: Segment[] = [{ ...seg }];
  for (const s of segs) {
    if (overlaps(s, seg)) next.push(...subtractRange(s, seg));
    else next.push(s);
  }
  return { ok: true, segments: sortSegments(next), replaced: sortSegments(conflicts) };
}

/**
 * Applies `patch` to segment `id`. With `linkAdjacent`, a moved start that was shared with the
 * previous segment's end (or a moved end shared with the next segment's start) moves that
 * neighbour's boundary as well. Rejects edits that would leave any segment empty, overlapping or
 * out of range.
 */
export function updateSegment(
  segs: readonly Segment[],
  id: string,
  patch: SegmentPatch,
  frameCount: number,
  options: UpdateSegmentOptions = {},
): UpdateSegmentResult {
  const target = segs.find((s) => s.id === id);
  if (!target) return { ok: false, reason: 'not_found', conflicts: [] };
  const updated: Segment = { ...target, ...patch, id };
  const problem = rangeProblem(updated.start, updated.end, frameCount);
  if (problem) return { ok: false, reason: problem, conflicts: [] };

  const changed = new Map<string, Segment>([[id, updated]]);
  if (options.linkAdjacent) {
    const linkStart = updated.start !== target.start;
    const linkEnd = updated.end !== target.end;
    for (const s of segs) {
      if (s.id === id) continue;
      if (linkStart && s.end === target.start) changed.set(s.id, { ...s, end: updated.start });
      else if (linkEnd && s.start === target.end) changed.set(s.id, { ...s, start: updated.end });
    }
  }

  const linked: Segment[] = [];
  for (const [cid, c] of changed) {
    if (cid === id) continue;
    const p = rangeProblem(c.start, c.end, frameCount);
    if (p) return { ok: false, reason: p, conflicts: [segs.find((s) => s.id === cid) as Segment] };
    linked.push(c);
  }

  const result = segs.map((s) => changed.get(s.id) ?? s);
  const conflicts = new Map<string, Segment>();
  for (const c of changed.values()) {
    for (const s of result) {
      if (s.id !== c.id && !changed.has(s.id) && overlaps(s, c)) conflicts.set(s.id, s);
    }
  }
  if (conflicts.size) return { ok: false, reason: 'overlap', conflicts: sortSegments([...conflicts.values()]) };
  return { ok: true, segments: sortSegments(result), linked: sortSegments(linked) };
}

export function deleteSegment(segs: readonly Segment[], id: string): Segment[] {
  return segs.filter((s) => s.id !== id);
}

export function relabelSegment(segs: readonly Segment[], id: string, phaseId: string): Segment[] {
  return segs.map((s) => (s.id === id ? { ...s, phaseId } : s));
}

/** Segment covering `frame` (i.e. start ≤ frame < end) in a sorted, non-overlapping list, or null. */
export function findSegmentAt(sorted: readonly Segment[], frame: number): Segment | null {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = sorted[mid];
    if (frame < s.start) hi = mid - 1;
    else if (frame >= s.end) lo = mid + 1;
    else return s;
  }
  return null;
}

/** All problems that block a training export. Gaps are allowed. */
export function validateForExport(
  segs: readonly Segment[],
  frameCount: number,
  phaseExists: (phaseId: string) => boolean,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const checkable: Segment[] = [];
  for (const s of segs) {
    if (!phaseExists(s.phaseId)) {
      issues.push({ code: 'invalid_phase', segmentIds: [s.id], params: { phaseId: s.phaseId } });
    }
    if (!Number.isSafeInteger(s.start) || !Number.isSafeInteger(s.end)) {
      issues.push({ code: 'not_integer', segmentIds: [s.id], params: { start: s.start, end: s.end } });
      continue;
    }
    if (s.start < 0 || s.end > frameCount) {
      issues.push({ code: 'out_of_range', segmentIds: [s.id], params: { start: s.start, end: s.end, frameCount } });
    }
    if (s.end <= s.start) {
      issues.push({ code: 'empty', segmentIds: [s.id], params: { start: s.start, end: s.end } });
      continue;
    }
    checkable.push(s);
  }
  const sorted = sortSegments(checkable);
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    for (let j = i + 1; j < sorted.length && sorted[j].start < a.end; j++) {
      const b = sorted[j];
      issues.push({
        code: 'overlap',
        segmentIds: [a.id, b.id],
        params: { from: b.start, to: Math.min(a.end, b.end), aStart: a.start, aEnd: a.end, bStart: b.start, bEnd: b.end },
      });
    }
  }
  return issues;
}

// --- Hashing -----------------------------------------------------------------------------------

const FNV64_OFFSET: readonly number[] = [0xcbf2, 0x9ce4, 0x8422, 0x2325];

/**
 * FNV-1a 64-bit over UTF-8 bytes, as 16 lowercase hex chars. Uses four 16-bit limbs
 * (most significant first) so it stays exact without BigInt.
 */
export function fnv1a64Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let [h3, h2, h1, h0] = FNV64_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    h0 ^= bytes[i];
    // multiply by the prime 0x100000001b3 = 2^40 + 0x1b3
    const t0 = h0 * 0x1b3;
    const t1 = h1 * 0x1b3;
    const t2 = h2 * 0x1b3;
    const t3 = h3 * 0x1b3;
    const c1 = t1 + (t0 >>> 16);
    const c2 = t2 + (c1 >>> 16) + (h0 << 8);
    const c3 = t3 + (c2 >>> 16) + (h1 << 8);
    h0 = t0 & 0xffff;
    h1 = c1 & 0xffff;
    h2 = c2 & 0xffff;
    h3 = c3 & 0xffff;
  }
  return [h3, h2, h1, h0].map((h) => h.toString(16).padStart(4, '0')).join('');
}

/**
 * Stable hash of exported content: segment ranges, phase ids and phase names, in sorted order.
 * Segment ids are excluded because they never reach an export.
 */
export function contentHash(segs: readonly Segment[], phaseNameOf: (phaseId: string) => string | undefined): string {
  const parts: string[] = ['v1'];
  for (const s of sortSegments(segs)) {
    parts.push(`${s.start}\u001f${s.end}\u001f${s.phaseId}\u001f${phaseNameOf(s.phaseId) ?? ''}`);
  }
  return `fnv1a64:${fnv1a64Hex(parts.join('\u001e'))}`;
}
