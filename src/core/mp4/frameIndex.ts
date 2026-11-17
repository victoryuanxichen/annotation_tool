/**
 * Frame index: maps presentation-order frame numbers (0..N-1) to decode-order samples and
 * to exact presentation timestamps.
 *
 * Frame numbering rule (documented in README):
 *   - Samples are sorted by composition time (CTS), ties broken by decode order.
 *   - With an edit list whose first non-empty edit starts at media time M (and an optional
 *     leading empty edit of duration E), a sample is presented at CTS - M + E and only
 *     samples with M <= CTS < M + edit duration are frames. This matches FFmpeg/ffprobe.
 *   - Frame k's timestamp in microseconds is round_half_up(ticks * 1e6 / timescale),
 *     computed with integers (no floating point).
 *   - The video's duration is the presentation end of the last frame: its timestamp plus its
 *     sample duration. The end-of-video boundary is frame N, whose time is the duration.
 *
 * The index is a plain object of typed arrays so it can be transferred from a worker.
 */
import type { RawVideoTrack } from './parser';
import { Mp4Error } from './parser';

export interface FrameIndex {
  codec: string;
  description: Uint8Array;
  nalLengthSize: number;
  codedWidth: number;
  codedHeight: number;
  displayWidth: number;
  displayHeight: number;
  timescale: number;
  /** Number of presented frames N. */
  frameCount: number;
  /** Presentation end of the last frame, in microseconds (time of boundary N). */
  durationUs: number;
  /** Presentation timestamps (ticks of `timescale`), by frame number. */
  ptsTicks: Float64Array;
  /** Presentation timestamps in integer microseconds, by frame number. */
  ptsUs: Float64Array;
  /** Frame number -> decode-order sample index. */
  frameToSample: Uint32Array;
  /** Decode-order sample index -> frame number, or -1 when the sample is not presented. */
  sampleToFrame: Int32Array;
  /** Decode-order sample tables. */
  sampleOffsets: Float64Array;
  sampleSizes: Uint32Array;
  sampleIsSync: Uint8Array;
  /** Decode indices of sync samples, ascending. */
  syncSamples: Uint32Array;
  /** Nominal (average) frame rate, for display only. Never used to compute boundaries. */
  averageFps: number;
  /** True when frame durations are not all equal. */
  variableFrameRate: boolean;
  /** True when presentation order differs from decode order (B-frames). */
  reordered: boolean;
  warnings: string[];
}

export function ticksToUs(ticks: number, timescale: number): number {
  // round half up, exact integer arithmetic
  const t = BigInt(Math.round(ticks));
  const ts = BigInt(timescale);
  const num = t * 1000000n;
  const q = num >= 0n ? (num + ts / 2n) / ts : -((-num + ts / 2n) / ts);
  return Number(q);
}

export function buildFrameIndex(track: RawVideoTrack): FrameIndex {
  const n = track.sampleCount;
  const warnings: string[] = [];

  // --- Edit list interpretation
  let mediaStart = 0; // M (media timescale)
  let mediaEnd = Infinity; // M + segment duration (media timescale)
  let presentationOffset = 0; // E converted to media timescale
  const edits = track.edits;
  if (edits.length) {
    let i = 0;
    while (i < edits.length && edits[i].mediaTime === -1) {
      presentationOffset += Math.round((edits[i].segmentDuration * track.timescale) / track.movieTimescale);
      i++;
    }
    const nonEmpty = edits.slice(i).filter((e) => e.mediaTime !== -1);
    if (nonEmpty.length >= 1) {
      const e = nonEmpty[0];
      mediaStart = e.mediaTime;
      if (e.segmentDuration > 0 && nonEmpty.length === 1) {
        mediaEnd = mediaStart + (e.segmentDuration * track.timescale) / track.movieTimescale;
      }
      if (e.mediaRate !== 1) warnings.push('edit_list_rate');
      if (nonEmpty.length > 1) warnings.push('edit_list_complex');
    }
  }

  // --- Determine presented samples (within the edit window)
  const order: number[] = [];
  let minCts = Infinity;
  for (let s = 0; s < n; s++) minCts = Math.min(minCts, track.cts[s]);
  for (let s = 0; s < n; s++) {
    const c = track.cts[s];
    if (c < mediaStart || c >= mediaEnd) continue;
    order.push(s);
  }
  if (order.length === 0) {
    // Edit list excludes everything: fall back to presenting all samples.
    warnings.push('edit_list_ignored');
    for (let s = 0; s < n; s++) order.push(s);
    mediaStart = minCts;
    presentationOffset = 0;
  } else if (order.length < n) {
    warnings.push('edit_list_trimmed');
  }
  order.sort((a, b) => track.cts[a] - track.cts[b] || a - b);

  const N = order.length;
  const frameToSample = new Uint32Array(N);
  const sampleToFrame = new Int32Array(n).fill(-1);
  const ptsTicks = new Float64Array(N);
  const ptsUs = new Float64Array(N);
  let reordered = false;
  let dupPts = false;
  for (let f = 0; f < N; f++) {
    const s = order[f];
    frameToSample[f] = s;
    sampleToFrame[s] = f;
    ptsTicks[f] = track.cts[s] - mediaStart + presentationOffset;
    ptsUs[f] = ticksToUs(ptsTicks[f], track.timescale);
    if (f > 0) {
      if (s < frameToSample[f - 1]) reordered = true;
      if (ptsUs[f] <= ptsUs[f - 1]) dupPts = true;
    }
  }
  if (dupPts) warnings.push('duplicate_timestamps');

  // Duration of the last frame: its sample duration; if zero, use the previous frame interval.
  const lastSample = frameToSample[N - 1];
  let lastDur = track.durations[lastSample];
  if (!(lastDur > 0)) {
    lastDur = N > 1 ? ptsTicks[N - 1] - ptsTicks[N - 2] : 1;
    warnings.push('last_frame_duration_estimated');
  }
  let endTicks = ptsTicks[N - 1] + lastDur;
  if (mediaEnd !== Infinity) {
    // Do not extend beyond the edit window end.
    const windowEnd = mediaEnd - mediaStart + presentationOffset;
    if (windowEnd > ptsTicks[N - 1] && windowEnd < endTicks) endTicks = windowEnd;
  }
  const durationUs = ticksToUs(endTicks, track.timescale);

  // Frame-rate characterization (display only)
  let variable = false;
  if (N > 2) {
    const d0 = ptsTicks[1] - ptsTicks[0];
    for (let f = 2; f < N; f++) {
      if (Math.abs(ptsTicks[f] - ptsTicks[f - 1] - d0) > 1) {
        variable = true;
        break;
      }
    }
  }
  const spanUs = durationUs - ptsUs[0];
  const averageFps = spanUs > 0 ? (N * 1e6) / spanUs : 0;

  const sync: number[] = [];
  for (let s = 0; s < n; s++) if (track.isSync[s]) sync.push(s);

  return {
    codec: track.codec,
    description: track.description,
    nalLengthSize: track.nalLengthSize,
    codedWidth: track.codedWidth,
    codedHeight: track.codedHeight,
    displayWidth: track.displayWidth,
    displayHeight: track.displayHeight,
    timescale: track.timescale,
    frameCount: N,
    durationUs,
    ptsTicks,
    ptsUs,
    frameToSample,
    sampleToFrame,
    sampleOffsets: track.offsets,
    sampleSizes: track.sizes,
    sampleIsSync: track.isSync,
    syncSamples: Uint32Array.from(sync),
    averageFps,
    variableFrameRate: variable,
    reordered,
    warnings,
  };
}

/** Time of a half-open boundary b in [0, N]: frame b's timestamp, or the duration for b = N. */
export function boundaryUs(index: Pick<FrameIndex, 'frameCount' | 'ptsUs' | 'durationUs'>, b: number): number {
  if (!Number.isInteger(b) || b < 0 || b > index.frameCount) throw new RangeError(`boundary ${b} out of range`);
  return b === index.frameCount ? index.durationUs : index.ptsUs[b];
}

/** Frame whose presentation interval contains time t (µs). Clamps to [0, N-1]. */
export function frameAtUs(index: Pick<FrameIndex, 'frameCount' | 'ptsUs'>, t: number): number {
  const a = index.ptsUs;
  if (t <= a[0]) return 0;
  let lo = 0;
  let hi = index.frameCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (a[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The decode-order sample from which decoding must start to reconstruct frame f, and the last
 * sample that must be fed. `isIdr` lets the caller reject sync samples that are not IDR pictures
 * (e.g. open-GOP recovery points), moving the start further back.
 */
export function decodeStartFor(index: FrameIndex, f: number, isIdr?: (sample: number) => boolean): number {
  const target = index.frameToSample[f];
  // Largest sync sample <= target
  const sync = index.syncSamples;
  let lo = 0;
  let hi = sync.length - 1;
  let k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sync[mid] <= target) {
      k = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (k < 0) return 0;
  // Leading pictures (presented before their sync sample) may reference the previous GOP.
  while (k > 0) {
    const s = sync[k];
    const sf = index.sampleToFrame[s];
    const leading = sf >= 0 && f < sf;
    const idrOk = isIdr ? isIdr(s) : true;
    if (!leading && idrOk) break;
    k--;
  }
  return sync[k] ?? 0;
}

export function describeMp4Error(e: unknown): { code: string; message: string } {
  if (e instanceof Mp4Error) return { code: e.code, message: e.message };
  return { code: 'corrupt', message: e instanceof Error ? e.message : String(e) };
}
