import type { ByteReader } from '../core/mp4/byteReader';
import type { FrameIndex } from '../core/mp4/frameIndex';
import { CanvasRenderer } from './canvasRenderer';
import { RunDecoder, type DecodeRun } from './decodeRun';
import { PlayerFailure, toFailure } from './failure';
import { FrameCache } from './frameCache';
import { PlaybackClock } from './playbackClock';
import { SampleSource } from './sampleSource';
import { ThumbnailStrip } from './thumbnails';
import {
  MAX_RATE,
  MIN_RATE,
  type PlayerError,
  type PlayerSnapshot,
  type PlayerStats,
  type PlayerStatus,
  type SeekOutcome,
  type SettledResult,
} from './types';

const MEMORY_BUDGET_BYTES = 350 * 1024 * 1024;
const MAX_DECODE_QUEUE = 8;
const MAX_PENDING_BITMAPS = 12;
/** Extra samples read past the goal so the decoder's reorder delay does not cost another read. */
const READ_LOOKAHEAD_SAMPLES = 24;
/** Cost of decoder.reset() + configure(), in samples, when choosing between continuing and restarting. */
const RESTART_PENALTY_SAMPLES = 4;
const PREFETCH_AHEAD = 48;
const PREFETCH_BEHIND = 24;
const MAX_KEEP_AHEAD = 120;
const MAX_KEEP_BEHIND = 90;
const PLAY_KEEP_BEHIND = 16;
const DEFAULT_SETTLE_TIMEOUT_MS = 10_000;

interface Session {
  index: FrameIndex;
  source: SampleSource;
  decoder: RunDecoder;
  thumbs: ThumbnailStrip;
}

interface Goal {
  mode: 'seek' | 'play' | 'prefetch';
  /** Lowest frame the decoder must produce; a run that cannot reach it is restarted. */
  first: number;
  /** Feeding continues until the run has output this frame. */
  last: number;
}

type Step =
  | { kind: 'idle' }
  | { kind: 'wait' }
  | { kind: 'feed'; run: DecodeRun; horizon: number }
  | { kind: 'flush'; run: DecodeRun }
  | { kind: 'restart'; goal: Goal }
  | { kind: 'give-up'; goal: Goal };

const IDLE: Step = { kind: 'idle' };
const WAIT: Step = { kind: 'wait' };

interface SettleWaiter {
  resolve: (r: SettledResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Frame-accurate player (SPEC §3): WebCodecs decoding into an ImageBitmap cache drawn on a canvas.
 * `displayedFrame` is the decoder timestamp of the bitmap last drawn, so it is always the frame
 * whose pixels are on screen.
 */
export class FramePlayer {
  private readonly renderer: CanvasRenderer;
  private readonly cache = new FrameCache(MEMORY_BUDGET_BYTES);
  private readonly listeners = new Set<(s: PlayerSnapshot) => void>();
  private readonly pendingBitmaps = new Set<number>();
  /** Frames the decoder failed to produce during prefetch/playback; skipped until the next load. */
  private readonly unavailable = new Set<number>();
  private session: Session | null = null;
  private loadSeq = 0;

  private status: PlayerStatus = 'empty';
  private error: PlayerError | null = null;
  private displayed: number | null = null;
  private target: number | null = null;
  private playing = false;
  private rate = 1;
  private clock: PlaybackClock | null = null;
  /** Displayed frame to re-decode at the current canvas size after a resize. */
  private upgradeFrame: number | null = null;
  private keepAhead = 32;
  private keepBehind = 16;

  private seekResolvers: ((o: SeekOutcome) => void)[] = [];
  private settleWaiters: SettleWaiter[] = [];
  private idleWaiters: (() => void)[] = [];
  private pumping = false;
  private pumpAgain = false;
  private rafId = 0;
  private snapshot: PlayerSnapshot | null = null;
  private notifyPending = false;
  private notifyToken = 0;
  private readonly counters = { runs: 0, samplesFed: 0, bitmapsCreated: 0, framesDropped: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new CanvasRenderer(canvas, () => this.onCanvasResized());
  }

  // ------------------------------------------------------------------ public API

  /** Loads a video and resolves once frame 0 is displayed (or the player is in an error state). */
  async load(index: FrameIndex, reader: ByteReader): Promise<void> {
    this.unload();
    const seq = ++this.loadSeq;
    this.status = 'loading';
    this.markChanged();
    if (!hasWebCodecs()) {
      this.fail(new PlayerFailure('webcodecs_missing', 'This browser does not support WebCodecs video decoding.'));
      return;
    }
    if (index.frameCount < 1) {
      this.fail(new PlayerFailure('decode_failed', 'The video has no frames.'));
      return;
    }
    const config = decoderConfig(index);
    if (!(await isSupported(config))) {
      if (seq === this.loadSeq) {
        this.fail(new PlayerFailure('codec_unsupported', `${index.codec} ${index.codedWidth}×${index.codedHeight} cannot be decoded by this browser.`));
      }
      return;
    }
    if (seq !== this.loadSeq) return;
    this.renderer.setVideoSize(index.displayWidth, index.displayHeight);
    this.updateKeepWindows();
    try {
      const source = new SampleSource(index, reader);
      const decoder = new RunDecoder(config, index.sampleToFrame, {
        frame: (frame, f) => this.onDecoded(seq, frame, f),
        error: (e) => seq === this.loadSeq && this.fail(toFailure(e, 'decode_failed')),
        dequeue: () => seq === this.loadSeq && this.pump(),
      });
      const thumbs = new ThumbnailStrip(index, source, config, () => this.whenIdle());
      this.session = { index, source, decoder, thumbs };
    } catch (e) {
      this.fail(toFailure(e, 'decode_failed'));
      return;
    }
    void this.seek(0);
    await this.settled(Infinity);
  }

  unload(): void {
    this.loadSeq++;
    this.stopClock();
    this.playing = false;
    const s = this.session;
    this.session = null;
    s?.decoder.close();
    s?.thumbs.dispose();
    this.renderer.clear();
    this.cache.clear();
    this.pendingBitmaps.clear();
    this.unavailable.clear();
    this.target = null;
    this.displayed = null;
    this.upgradeFrame = null;
    this.status = 'empty';
    this.error = null;
    this.resolveSeeks({ ok: false, superseded: false, error: 'unloaded' });
    this.flushSettled();
    this.flushIdle();
    this.markChanged();
  }

  /** Unloads and stops observing the canvas. */
  dispose(): void {
    this.unload();
    this.renderer.dispose();
    this.listeners.clear();
  }

  /** Shows `frame` (clamped to the video). Latest seek wins; earlier pending seeks resolve superseded. */
  seek(frame: number): Promise<SeekOutcome> {
    const s = this.session;
    if (!s || this.status === 'error' || this.status === 'empty') {
      return Promise.resolve({ ok: false, superseded: false, error: this.error?.code ?? 'not_ready' });
    }
    const f = clampFrame(frame, s.index.frameCount);
    this.resolveSeeks({ ok: false, superseded: true });
    const outcome = new Promise<SeekOutcome>((resolve) => this.seekResolvers.push(resolve));
    if (f === this.displayed) {
      this.target = null;
      if (this.playing) this.clock = null;
      this.cache.setAnchor(f);
      this.resolveSeeks({ ok: true, superseded: false, frame: f });
      this.flushSettled();
    } else {
      this.target = f;
      this.cache.setAnchor(f);
      this.presentTarget();
    }
    this.markChanged();
    this.pump();
    return outcome;
  }

  /** Seeks relative to the pending target (or the displayed frame). Pauses playback. */
  step(delta: number): Promise<SeekOutcome> {
    if (this.playing) this.pause();
    const base = this.target ?? this.displayed;
    if (base === null) return this.seek(0);
    return this.seek(base + Math.trunc(delta));
  }

  play(): void {
    const s = this.session;
    if (!s || this.status !== 'ready' || this.playing) return;
    if (this.target === null && this.displayed === s.index.frameCount - 1) return;
    this.playing = true;
    this.clock = null;
    this.rafId = requestAnimationFrame(this.tick);
    this.markChanged();
    this.pump();
  }

  pause(): void {
    if (!this.playing) return;
    this.stopPlayback();
  }

  setRate(r: number): void {
    if (!Number.isFinite(r)) return;
    const rate = Math.min(MAX_RATE, Math.max(MIN_RATE, r));
    if (rate === this.rate) return;
    this.clock?.setRate(rate, performance.now());
    this.rate = rate;
    this.markChanged();
  }

  /**
   * Resolves with the displayed frame once no seek is pending (immediately during playback), or
   * with an error: a player error code, 'timeout', or 'empty'.
   */
  settled(timeoutMs = DEFAULT_SETTLE_TIMEOUT_MS): Promise<SettledResult> {
    const now = this.settledResult();
    if (now) return Promise.resolve(now);
    return new Promise((resolve) => {
      const waiter: SettleWaiter = { resolve, timer: null };
      if (Number.isFinite(timeoutMs)) {
        waiter.timer = setTimeout(() => {
          this.settleWaiters = this.settleWaiters.filter((w) => w !== waiter);
          resolve({ error: 'timeout' });
        }, timeoutMs);
      }
      this.settleWaiters.push(waiter);
    });
  }

  subscribe(fn: (s: PlayerSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getSnapshot(): PlayerSnapshot {
    if (!this.snapshot) {
      this.snapshot = Object.freeze({
        status: this.status,
        displayedFrame: this.displayed,
        requestedFrame: this.target,
        playing: this.playing,
        rate: this.rate,
        error: this.error,
      });
    }
    return this.snapshot;
  }

  /** Nearest decoded keyframe thumbnail (~160 px wide) for the scrub preview. */
  peekThumbnail(frame: number): ImageBitmap | null {
    return this.session?.thumbs.nearest(frame) ?? null;
  }

  getStats(): PlayerStats {
    return {
      ...this.counters,
      reads: this.session?.source.reads ?? 0,
      cachedFrames: this.cache.size,
      cachedBytes: this.cache.bytes,
      thumbnails: this.session?.thumbs.count ?? 0,
    };
  }

  // ------------------------------------------------------------------ presentation

  private presentTarget(): void {
    const t = this.target;
    if (t === null) return;
    const bmp = this.cache.get(t);
    if (!bmp) return;
    this.target = null;
    this.present(t, bmp);
    if (this.playing) this.clock = null;
    this.resolveSeeks({ ok: true, superseded: false, frame: t });
    this.flushSettled();
  }

  /** The only place that draws a frame; `displayed` changes right after the draw. */
  private present(f: number, bmp: ImageBitmap): void {
    this.renderer.draw(bmp);
    this.cache.pin(f);
    this.displayed = f;
    if (this.target === null) this.cache.setAnchor(f);
    if (this.upgradeFrame !== f) this.upgradeFrame = null;
    if (this.status === 'loading') {
      this.status = 'ready';
      this.session?.thumbs.start();
    }
    this.markChanged();
  }

  private readonly tick = (now: number): void => {
    this.rafId = 0;
    const s = this.session;
    if (!this.playing || !s) return;
    if (this.target === null) this.advancePlayback(s, now);
    if (this.playing) {
      this.rafId = requestAnimationFrame(this.tick);
      this.pump();
    }
  };

  /** Presents the newest decoded frame that is due, dropping older ones. Never goes backwards. */
  private advancePlayback(s: Session, now: number): void {
    const d = this.displayed;
    const last = s.index.frameCount - 1;
    if (d === null) return;
    if (d >= last) {
      this.stopPlayback();
      return;
    }
    if (!this.clock) {
      // Start the clock only once the next frame is ready, so a cold start does not drop frames.
      if (this.cache.has(d + 1)) this.clock = new PlaybackClock(s.index, d, this.rate, now);
      return;
    }
    const due = this.clock.dueFrame(now);
    for (let f = due; f > d; f--) {
      const bmp = this.cache.get(f);
      if (!bmp) continue;
      this.counters.framesDropped += f - d - 1;
      this.present(f, bmp);
      this.cache.retainRange(f - PLAY_KEEP_BEHIND, Number.POSITIVE_INFINITY);
      break;
    }
    if (this.displayed === last) this.stopPlayback();
  }

  private stopPlayback(): void {
    this.playing = false;
    this.stopClock();
    if (this.displayed !== null && this.target === null) this.cache.setAnchor(this.displayed);
    this.markChanged();
    this.pump();
  }

  private stopClock(): void {
    this.clock = null;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  // ------------------------------------------------------------------ decoded frames

  /** Whether a decoded frame is worth converting to a bitmap. */
  private wants(f: number): boolean {
    if (f === this.upgradeFrame) return !this.pendingBitmaps.has(f);
    if (this.cache.has(f) || this.pendingBitmaps.has(f) || this.unavailable.has(f)) return false;
    const t = this.target;
    if (t !== null) return f >= t - this.keepBehind && f <= t + this.keepAhead;
    const d = this.displayed ?? 0;
    if (this.playing) {
      const due = this.clock ? this.clock.dueFrame(performance.now()) : d + 1;
      return f >= Math.max(d + 1, due) && f <= d + this.keepAhead;
    }
    return f >= d - this.keepBehind && f <= d + this.keepAhead;
  }

  private onDecoded(seq: number, frame: VideoFrame, f: number): void {
    if (seq !== this.loadSeq || !this.wants(f)) {
      if (this.playing && f <= (this.displayed ?? -1) + this.keepAhead) this.counters.framesDropped++;
      frame.close();
      return;
    }
    this.pendingBitmaps.add(f);
    const size = this.renderer.bitmapSize();
    const resize =
      size.width === frame.displayWidth && size.height === frame.displayHeight
        ? undefined
        : { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'medium' as const };
    createImageBitmap(frame, resize).then(
      (bmp) => {
        frame.close();
        if (seq !== this.loadSeq) bmp.close();
        else this.onBitmap(f, bmp);
      },
      (e: unknown) => {
        frame.close();
        if (seq !== this.loadSeq) return;
        this.pendingBitmaps.delete(f);
        this.fail(toFailure(e, 'decode_failed'));
      },
    );
  }

  private onBitmap(f: number, bmp: ImageBitmap): void {
    this.pendingBitmaps.delete(f);
    this.counters.bitmapsCreated++;
    if (f === this.upgradeFrame && this.cache.has(f)) {
      this.upgradeFrame = null;
      if (f === this.displayed) this.renderer.draw(bmp);
      this.cache.replace(f, bmp);
    } else {
      this.cache.put(f, bmp);
      if (f === this.target) this.presentTarget();
    }
    this.pump();
  }

  private onCanvasResized(): void {
    this.updateKeepWindows();
    const d = this.displayed;
    if (d === null || !this.session) return;
    const want = this.renderer.bitmapSize().width;
    const have = this.cache.widthOf(d);
    if (have > 0 && Math.abs(want - have) > have * 0.2) {
      // Bitmaps of the old size would stay blurry or waste memory; re-decode around the frame.
      this.cache.retainRange(d, d);
      this.upgradeFrame = d;
      this.pump();
    }
  }

  private updateKeepWindows(): void {
    const { width, height } = this.renderer.bitmapSize();
    const capacity = Math.max(24, Math.floor(MEMORY_BUDGET_BYTES / (width * height * 4)));
    const ahead = Math.floor((capacity * 2) / 3);
    this.keepAhead = Math.min(MAX_KEEP_AHEAD, ahead);
    this.keepBehind = Math.min(MAX_KEEP_BEHIND, capacity - ahead);
  }

  // ------------------------------------------------------------------ decode scheduling

  /** Single-flight scheduler: repeatedly plans and executes one decode step until idle or blocked. */
  private pump(): void {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    void this.pumpLoop().finally(() => {
      this.pumping = false;
      if (this.pumpAgain) {
        this.pumpAgain = false;
        this.pump();
      }
    });
  }

  private async pumpLoop(): Promise<void> {
    const s = this.session;
    if (!s) return;
    try {
      for (;;) {
        this.pumpAgain = false;
        const step = this.planStep(s);
        if (step.kind === 'idle') {
          this.flushIdle();
          return;
        }
        if (step.kind === 'wait') return;
        await this.execute(s, step);
        if (this.session !== s || this.status === 'error') return;
      }
    } catch (e) {
      if (this.session === s) this.fail(toFailure(e, 'decode_failed'));
    }
  }

  private planStep(s: Session): Step {
    if (this.status === 'error' || s.decoder.closed) return IDLE;
    const goal = this.currentGoal(s);
    if (goal === null) return IDLE;
    if (goal === 'wait') return WAIT;
    const run = s.decoder.run;
    if (run && this.canContinue(s, run, goal.first)) {
      if (s.decoder.queueSize >= MAX_DECODE_QUEUE || this.pendingBitmaps.size >= MAX_PENDING_BITMAPS) return WAIT;
      if (run.nextSample >= s.source.sampleCount) return { kind: 'flush', run };
      return { kind: 'feed', run, horizon: s.index.frameToSample[goal.last] + READ_LOOKAHEAD_SAMPLES };
    }
    const exhausted = run !== null && (run.flushed || run.lastOutput >= goal.first);
    if (exhausted && run.goalFirst === goal.first && !run.goalDelivered) return { kind: 'give-up', goal };
    return { kind: 'restart', goal };
  }

  /** What the decoder should produce next: the seek target, upcoming playback frames, or prefetch. */
  private currentGoal(s: Session): Goal | 'wait' | null {
    const t = this.target;
    if (t !== null) {
      return this.cache.has(t) || this.pendingBitmaps.has(t) ? 'wait' : { mode: 'seek', first: t, last: t };
    }
    const d = this.displayed;
    if (d === null) return null;
    const last = s.index.frameCount - 1;
    if (this.playing) {
      if (d >= last) return 'wait';
      const due = this.clock ? this.clock.dueFrame(performance.now()) : d + 1;
      const lo = Math.max(d + 1, due);
      const range = this.missingRange(lo, Math.min(last, lo + this.playLead()));
      return range ? { mode: 'play', ...range } : 'wait';
    }
    if (this.upgradeFrame === d) {
      return this.pendingBitmaps.has(d) ? 'wait' : { mode: 'prefetch', first: d, last: d };
    }
    const ahead = this.missingRange(d + 1, Math.min(last, d + Math.min(PREFETCH_AHEAD, this.keepAhead)));
    if (ahead) return { mode: 'prefetch', ...ahead };
    const behind = this.missingRange(Math.max(0, d - Math.min(PREFETCH_BEHIND, this.keepBehind)), d - 1);
    return behind ? { mode: 'prefetch', ...behind } : null;
  }

  private missingRange(lo: number, hi: number): { first: number; last: number } | null {
    let first = -1;
    let lastMissing = -1;
    for (let f = lo; f <= hi; f++) {
      if (this.cache.has(f) || this.pendingBitmaps.has(f) || this.unavailable.has(f)) continue;
      if (first < 0) first = f;
      lastMissing = f;
    }
    return first < 0 ? null : { first, last: lastMissing };
  }

  private playLead(): number {
    return Math.min(this.keepAhead, Math.ceil(6 + 6 * this.rate));
  }

  /**
   * Whether the current run will produce `first` if we keep feeding it, and that doing so is
   * no more expensive than a reset and a new run from the frame's own IDR sample.
   */
  private canContinue(s: Session, run: DecodeRun, first: number): boolean {
    if (run.flushed || run.lastOutput >= first || first < run.minFrame) return false;
    const fs = s.index.frameToSample[first];
    if (fs < run.startSample) return false;
    const continueCost = fs - run.nextSample;
    if (continueCost <= 0) return true;
    const restartCost = fs - s.source.estimateDecodeStart(first) + RESTART_PENALTY_SAMPLES;
    return continueCost <= restartCost;
  }

  private async execute(s: Session, step: Step): Promise<void> {
    switch (step.kind) {
      case 'feed': {
        const data = await s.source.sample(step.run.nextSample, step.horizon);
        if (this.session !== s || s.decoder.run !== step.run || this.status === 'error') return;
        s.decoder.feed(step.run, data);
        this.counters.samplesFed++;
        return;
      }
      case 'flush':
        await s.decoder.flush(step.run);
        return;
      case 'restart':
        await this.restart(s, step.goal);
        return;
      case 'give-up':
        this.giveUp(step.goal);
        return;
      default:
        return;
    }
  }

  private async restart(s: Session, goal: Goal): Promise<void> {
    const start = await s.source.resolveDecodeStart(goal.first, s.index.frameToSample[goal.last] + READ_LOOKAHEAD_SAMPLES);
    if (this.session !== s || this.status === 'error') return;
    const current = this.currentGoal(s);
    // The goal moved while the start sample was being verified: plan again.
    if (current === null || current === 'wait' || current.first !== goal.first) return;
    s.decoder.start(start, goal.first);
    this.counters.runs++;
  }

  private giveUp(goal: Goal): void {
    if (goal.mode === 'seek') {
      this.fail(new PlayerFailure('decode_failed', `The decoder did not produce frame ${goal.first}.`));
    } else if (goal.first === this.upgradeFrame) {
      this.upgradeFrame = null;
    } else {
      this.unavailable.add(goal.first);
    }
  }

  // ------------------------------------------------------------------ state + notifications

  private fail(failure: PlayerFailure): void {
    if (this.status === 'error') return;
    this.status = 'error';
    this.error = { code: failure.code, message: failure.message };
    this.target = null;
    this.playing = false;
    this.stopClock();
    this.session?.decoder.close();
    this.session?.thumbs.dispose();
    this.resolveSeeks({ ok: false, superseded: false, error: failure.code });
    this.flushSettled();
    this.flushIdle();
    this.markChanged();
  }

  private resolveSeeks(outcome: SeekOutcome): void {
    const resolvers = this.seekResolvers;
    this.seekResolvers = [];
    for (const r of resolvers) r(outcome);
  }

  private settledResult(): SettledResult | null {
    if (this.status === 'error') return { error: this.error?.code ?? 'decode_failed' };
    if (this.status === 'empty') return { error: 'empty' };
    if (this.target !== null || this.displayed === null) return null;
    return { frame: this.displayed };
  }

  private flushSettled(): void {
    const result = this.settledResult();
    if (!result) return;
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const w of waiters) {
      if (w.timer !== null) clearTimeout(w.timer);
      w.resolve(result);
    }
  }

  /** Resolves when the foreground decoder has nothing to do (used to pace background thumbnails). */
  private whenIdle(): Promise<void> {
    const s = this.session;
    if (!s || this.status === 'error' || (!this.pumping && this.planStep(s).kind === 'idle')) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private flushIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  /** Invalidates the snapshot; subscribers hear about it at most once per animation frame. */
  private markChanged(): void {
    this.snapshot = null;
    if (this.notifyPending) return;
    this.notifyPending = true;
    const token = ++this.notifyToken;
    const deliver = (): void => {
      if (!this.notifyPending || token !== this.notifyToken) return;
      this.notifyPending = false;
      const snap = this.getSnapshot();
      for (const fn of this.listeners) fn(snap);
    };
    requestAnimationFrame(deliver);
    // rAF does not run in background tabs; make sure state still propagates.
    setTimeout(deliver, 100);
  }
}

function hasWebCodecs(): boolean {
  return (
    typeof VideoDecoder !== 'undefined' &&
    typeof EncodedVideoChunk !== 'undefined' &&
    typeof createImageBitmap !== 'undefined'
  );
}

function decoderConfig(index: FrameIndex): VideoDecoderConfig {
  return {
    codec: index.codec,
    description: index.description,
    codedWidth: index.codedWidth,
    codedHeight: index.codedHeight,
    displayAspectWidth: index.displayWidth,
    displayAspectHeight: index.displayHeight,
    optimizeForLatency: true,
  };
}

async function isSupported(config: VideoDecoderConfig): Promise<boolean> {
  try {
    return (await VideoDecoder.isConfigSupported(config)).supported === true;
  } catch {
    return false;
  }
}

function clampFrame(frame: number, frameCount: number): number {
  const f = Number.isFinite(frame) ? Math.round(frame) : 0;
  return Math.min(frameCount - 1, Math.max(0, f));
}
