import type { FrameIndex } from '../core/mp4/frameIndex';
import type { SampleSource } from './sampleSource';

const THUMB_WIDTH = 160;
const MAX_THUMBS = 240;

/**
 * Keyframe thumbnails for the scrub preview, decoded in the background with a second decoder.
 * Each IDR sample is decoded on its own (key chunk + flush). Before every sample the strip awaits
 * `gate`, which resolves only while the foreground decoder is idle.
 */
export class ThumbnailStrip {
  private readonly frames: number[] = [];
  private readonly bitmaps: ImageBitmap[] = [];
  private decoder: VideoDecoder | null = null;
  private output: VideoFrame | null = null;
  private disposed = false;

  constructor(
    private readonly index: FrameIndex,
    private readonly source: SampleSource,
    private readonly config: VideoDecoderConfig,
    private readonly gate: () => Promise<void>,
  ) {}

  get count(): number {
    return this.frames.length;
  }

  start(): void {
    void this.run().catch(() => {
      // Thumbnails are best effort; the foreground player reports real failures.
    }).finally(() => this.closeDecoder());
  }

  /** Thumbnail of the keyframe nearest to `frame`, or null when none is ready yet. */
  nearest(frame: number): ImageBitmap | null {
    const fs = this.frames;
    if (fs.length === 0) return null;
    let lo = 0;
    let hi = fs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (fs[mid] < frame) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && frame - fs[lo - 1] < Math.abs(fs[lo] - frame)) lo--;
    return this.bitmaps[lo];
  }

  dispose(): void {
    this.disposed = true;
    this.closeDecoder();
    for (const b of this.bitmaps) b.close();
    this.bitmaps.length = 0;
    this.frames.length = 0;
  }

  private async run(): Promise<void> {
    const size = this.thumbSize();
    this.decoder = new VideoDecoder({
      output: (f) => this.collect(f),
      error: () => this.closeDecoder(),
    });
    this.decoder.configure({ ...this.config, optimizeForLatency: true });
    for (const s of coarseToFine(pickEvenly(this.index.syncSamples, MAX_THUMBS))) {
      await this.gate();
      if (this.disposed || !this.decoder || this.decoder.state === 'closed') return;
      const frame = this.index.sampleToFrame[s];
      if (frame < 0) continue;
      const data = await this.source.readOne(s);
      if (this.source.idrKnown(s) !== true) continue;
      const out = await this.decodeOne(data, frame);
      if (!out) continue;
      try {
        const bmp = await createImageBitmap(out, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'medium' });
        if (this.disposed) bmp.close();
        else this.insert(frame, bmp);
      } finally {
        out.close();
      }
    }
  }

  private async decodeOne(data: Uint8Array, frame: number): Promise<VideoFrame | null> {
    const decoder = this.decoder;
    if (!decoder || decoder.state === 'closed') return null;
    decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: frame, data }));
    await decoder.flush();
    const out = this.output;
    this.output = null;
    if (out && out.timestamp !== frame) {
      out.close();
      return null;
    }
    return out;
  }

  private collect(frame: VideoFrame): void {
    this.output?.close();
    this.output = frame;
  }

  private insert(frame: number, bmp: ImageBitmap): void {
    let i = this.frames.length;
    while (i > 0 && this.frames[i - 1] > frame) i--;
    if (this.frames[i - 1] === frame) {
      bmp.close();
      return;
    }
    this.frames.splice(i, 0, frame);
    this.bitmaps.splice(i, 0, bmp);
  }

  private thumbSize(): { width: number; height: number } {
    const { displayWidth: w, displayHeight: h } = this.index;
    const width = Math.min(THUMB_WIDTH, w);
    return { width, height: Math.max(1, Math.round((width * h) / w)) };
  }

  private closeDecoder(): void {
    this.output?.close();
    this.output = null;
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
  }
}

function pickEvenly(samples: Uint32Array, max: number): number[] {
  if (samples.length <= max) return Array.from(samples);
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(samples[Math.floor((i * samples.length) / max)]);
  return out;
}

/** Reorders so early items already cover the whole range (every 2^k-th item first). */
function coarseToFine(items: number[]): number[] {
  const out: number[] = [];
  const seen = new Uint8Array(items.length);
  let stride = 1;
  while (stride * 2 < items.length) stride *= 2;
  for (; stride >= 1; stride >>= 1) {
    for (let i = 0; i < items.length; i += stride) {
      if (!seen[i]) {
        seen[i] = 1;
        out.push(items[i]);
      }
    }
  }
  return out;
}
