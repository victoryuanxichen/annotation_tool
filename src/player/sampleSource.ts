import type { ByteReader } from '../core/mp4/byteReader';
import type { FrameIndex } from '../core/mp4/frameIndex';
import { decodeStartFor } from '../core/mp4/frameIndex';
import { isIdrAccessUnit } from '../core/mp4/avc';
import { PlayerFailure } from './failure';

const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const MAX_BATCH_SAMPLES = 512;
/** Samples separated by more than this many bytes (e.g. interleaved audio) end a batch. */
const MAX_GAP_BYTES = 64 * 1024;

const IDR_UNKNOWN = 0;
const IDR_YES = 1;
const IDR_NO = -1;

interface ReadWindow {
  first: number;
  last: number;
  base: number;
  bytes: Uint8Array;
}

/**
 * Encoded sample access for the decoders. Foreground reads are batched: one `ByteReader.read`
 * covers a run of decode-order samples, which are then served as subarrays. IDR checks are
 * cached per sample.
 */
export class SampleSource {
  private readonly idr: Int8Array;
  private window: ReadWindow | null = null;
  reads = 0;

  constructor(
    private readonly index: FrameIndex,
    private readonly reader: ByteReader,
  ) {
    this.idr = new Int8Array(index.sampleSizes.length);
  }

  get sampleCount(): number {
    return this.index.sampleSizes.length;
  }

  /**
   * Bytes of sample `s`. When `s` is not in the current read window, reads a new window
   * starting at `s` that extends towards `horizon` (inclusive) when the bytes are contiguous.
   */
  async sample(s: number, horizon: number): Promise<Uint8Array> {
    let w = this.window;
    if (!w || s < w.first || s > w.last) {
      w = await this.readWindow(s, horizon);
      this.window = w;
    }
    const start = this.index.sampleOffsets[s] - w.base;
    return w.bytes.subarray(start, start + this.index.sampleSizes[s]);
  }

  /** Unbuffered read of one sample; does not disturb the foreground read window. */
  async readOne(s: number): Promise<Uint8Array> {
    const data = await this.read(this.index.sampleOffsets[s], this.index.sampleSizes[s]);
    this.noteIdr(s, data);
    return data;
  }

  /** Cached IDR verdict, or undefined when the sample has not been inspected yet. */
  idrKnown(s: number): boolean | undefined {
    const v = this.idr[s];
    return v === IDR_UNKNOWN ? undefined : v === IDR_YES;
  }

  /**
   * Same as `decodeStartFor`, with every candidate start sample verified to be an IDR picture.
   * A candidate is inspected by reading a foreground window from it towards `horizon`, so the
   * run that follows usually needs no further read.
   */
  async resolveDecodeStart(frame: number, horizon: number): Promise<number> {
    for (;;) {
      const s = this.estimateDecodeStart(frame);
      if (this.idr[s] !== IDR_UNKNOWN || !this.index.sampleIsSync[s]) return s;
      this.window = await this.readWindow(s, horizon);
    }
  }

  /** `decodeStartFor` treating uninspected sync samples as IDR (exact once they are inspected). */
  estimateDecodeStart(frame: number): number {
    return decodeStartFor(this.index, frame, (s) => this.idr[s] !== IDR_NO);
  }

  private noteIdr(s: number, data: Uint8Array): void {
    if (this.idr[s] === IDR_UNKNOWN) {
      this.idr[s] = isIdrAccessUnit(data, this.index.nalLengthSize) ? IDR_YES : IDR_NO;
    }
  }

  private async readWindow(first: number, horizon: number): Promise<ReadWindow> {
    const { sampleOffsets: off, sampleSizes: size } = this.index;
    const base = off[first];
    let end = base + size[first];
    let last = first;
    const maxLast = Math.min(this.sampleCount - 1, Math.max(first, horizon));
    while (last < maxLast && last - first + 1 < MAX_BATCH_SAMPLES) {
      const o = off[last + 1];
      const e = o + size[last + 1];
      if (o < base || o > end + MAX_GAP_BYTES || Math.max(end, e) - base > MAX_BATCH_BYTES) break;
      end = Math.max(end, e);
      last++;
    }
    const bytes = await this.read(base, end - base);
    if (this.idr[first] === IDR_UNKNOWN && this.index.sampleIsSync[first]) {
      this.noteIdr(first, bytes.subarray(0, size[first]));
    }
    return { first, last, base, bytes };
  }

  private async read(offset: number, length: number): Promise<Uint8Array> {
    this.reads++;
    let bytes: Uint8Array;
    try {
      bytes = await this.reader.read(offset, length);
    } catch (e) {
      throw new PlayerFailure('read_failed', `Could not read video data: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (bytes.byteLength < length) {
      throw new PlayerFailure('read_failed', `Short read at byte ${offset}: got ${bytes.byteLength} of ${length}`);
    }
    return bytes;
  }
}
