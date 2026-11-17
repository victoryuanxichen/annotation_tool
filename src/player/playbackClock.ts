import { frameAtUs, type FrameIndex } from '../core/mp4/frameIndex';

/** Maps wall-clock time (performance.now) to the frame due on screen at the current rate. */
export class PlaybackClock {
  private baseTimeMs: number;
  private basePtsUs: number;

  constructor(
    private readonly index: Pick<FrameIndex, 'frameCount' | 'ptsUs'>,
    startFrame: number,
    private rate: number,
    nowMs: number,
  ) {
    this.baseTimeMs = nowMs;
    this.basePtsUs = index.ptsUs[startFrame];
  }

  dueUs(nowMs: number): number {
    return this.basePtsUs + (nowMs - this.baseTimeMs) * 1000 * this.rate;
  }

  dueFrame(nowMs: number): number {
    return frameAtUs(this.index, this.dueUs(nowMs));
  }

  /** Changes the rate without moving the current media time. */
  setRate(rate: number, nowMs: number): void {
    this.basePtsUs = this.dueUs(nowMs);
    this.baseTimeMs = nowMs;
    this.rate = rate;
  }
}
