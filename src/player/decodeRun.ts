import { isAbortError } from './failure';

/**
 * One decode run: samples fed in decode order starting at a verified IDR sample.
 * Chunk timestamps are frame numbers, so every output's timestamp is its frame number.
 */
export interface DecodeRun {
  readonly id: number;
  readonly startSample: number;
  /** Frame of the start keyframe; outputs presented before it are discarded (open-GOP leading pictures). */
  readonly minFrame: number;
  /** First frame this run was started for (used to detect frames the decoder never produces). */
  readonly goalFirst: number;
  nextSample: number;
  /** Highest frame output so far, -1 before the first output. */
  lastOutput: number;
  goalDelivered: boolean;
  /** flush() was called; the run cannot be continued (the decoder then needs a key chunk). */
  flushed: boolean;
}

export interface DecoderSink {
  /** Receives ownership of a verified output frame. */
  frame(frame: VideoFrame, frameNumber: number): void;
  error(e: unknown): void;
  /** The decoder can take more work (queue shrank, or a reclaimed decoder can be recreated). */
  dequeue(): void;
}

/**
 * Foreground `VideoDecoder` wrapper that tags outputs with the run that produced them.
 * If the browser reclaims the codec (e.g. a background tab), the next run transparently
 * creates a new decoder.
 */
export class RunDecoder {
  private decoder: VideoDecoder;
  private runSeq = 0;
  private disposed = false;
  run: DecodeRun | null = null;

  constructor(
    private readonly config: VideoDecoderConfig,
    private readonly sampleToFrame: Int32Array,
    private readonly sink: DecoderSink,
  ) {
    this.decoder = this.create();
  }

  get queueSize(): number {
    return this.decoder.decodeQueueSize;
  }

  /** True after close() or a real decode error; a reclaimed decoder is not "closed". */
  get closed(): boolean {
    return this.disposed;
  }

  /** Discards all pending work (decoder.reset) and starts a new run at `startSample`. */
  start(startSample: number, goalFirst: number): DecodeRun {
    if (this.decoder.state === 'closed') this.decoder = this.create();
    else if (this.decoder.state === 'configured') this.decoder.reset();
    this.decoder.configure(this.config);
    const f = this.sampleToFrame[startSample];
    this.run = {
      id: ++this.runSeq,
      startSample,
      minFrame: f >= 0 ? f : 0,
      goalFirst,
      nextSample: startSample,
      lastOutput: -1,
      goalDelivered: false,
      flushed: false,
    };
    return this.run;
  }

  /** Feeds the run's next sample. */
  feed(run: DecodeRun, data: Uint8Array): void {
    const s = run.nextSample;
    const f = this.sampleToFrame[s];
    this.decoder.decode(
      new EncodedVideoChunk({
        type: s === run.startSample ? 'key' : 'delta',
        // Non-presented samples get unique negative timestamps; their outputs are dropped.
        timestamp: f >= 0 ? f : -(s + 1),
        data,
      }),
    );
    run.nextSample = s + 1;
  }

  /** Emits every pending output of the run (end of stream). */
  async flush(run: DecodeRun): Promise<void> {
    run.flushed = true;
    try {
      await this.decoder.flush();
    } catch (e) {
      // Aborted by reset(), or the decoder failed/was reclaimed (reported via onError).
      if (isAbortError(e) || this.run !== run) return;
      throw e;
    }
  }

  close(): void {
    this.disposed = true;
    this.run = null;
    if (this.decoder.state !== 'closed') this.decoder.close();
  }

  private create(): VideoDecoder {
    const decoder = new VideoDecoder({
      output: (frame) => this.onOutput(frame),
      error: (e) => this.onError(decoder, e),
    });
    decoder.addEventListener('dequeue', () => this.sink.dequeue());
    return decoder;
  }

  private onError(decoder: VideoDecoder, e: unknown): void {
    if (decoder !== this.decoder || this.disposed) return;
    this.run = null;
    // Chrome reclaims idle codecs with QuotaExceededError; that is recoverable by starting over.
    if (e instanceof DOMException && e.name === 'QuotaExceededError') {
      this.sink.dequeue();
      return;
    }
    this.disposed = true;
    this.sink.error(e);
  }

  private onOutput(frame: VideoFrame): void {
    const run = this.run;
    const f = frame.timestamp;
    if (!run || f < run.minFrame) {
      frame.close();
      return;
    }
    if (f > run.lastOutput) run.lastOutput = f;
    if (f === run.goalFirst) run.goalDelivered = true;
    this.sink.frame(frame, f);
  }
}
