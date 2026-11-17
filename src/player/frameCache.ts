interface Entry {
  bitmap: ImageBitmap;
  bytes: number;
  lastUse: number;
}

/**
 * Decoded-frame bitmaps keyed by frame number, bounded by a memory budget.
 *
 * Eviction removes the entry farthest from the anchor (the target or displayed frame), with
 * frames ahead counting half as far as frames behind so the cache keeps ~2:1 ahead:behind.
 * Equal distances fall back to least recently used. The pinned (displayed) frame is never evicted.
 */
export class FrameCache {
  private readonly entries = new Map<number, Entry>();
  private totalBytes = 0;
  private useClock = 0;
  private anchor = 0;
  private pinned: number | null = null;

  constructor(private readonly budgetBytes: number) {}

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  has(frame: number): boolean {
    return this.entries.has(frame);
  }

  /** Returns the bitmap and marks it as recently used. */
  get(frame: number): ImageBitmap | null {
    const e = this.entries.get(frame);
    if (!e) return null;
    e.lastUse = ++this.useClock;
    return e.bitmap;
  }

  /** Takes ownership of `bitmap` (closes it if the frame is already cached). */
  put(frame: number, bitmap: ImageBitmap): void {
    if (this.entries.has(frame)) {
      bitmap.close();
      return;
    }
    const bytes = bitmap.width * bitmap.height * 4;
    this.entries.set(frame, { bitmap, bytes, lastUse: ++this.useClock });
    this.totalBytes += bytes;
    this.evictOverBudget();
  }

  /** Swaps in a new bitmap for a cached frame (e.g. re-decoded at a larger size). */
  replace(frame: number, bitmap: ImageBitmap): void {
    this.delete(frame);
    this.put(frame, bitmap);
  }

  /** Width of the cached bitmap for `frame`, or 0 when not cached. */
  widthOf(frame: number): number {
    return this.entries.get(frame)?.bitmap.width ?? 0;
  }

  setAnchor(frame: number): void {
    this.anchor = frame;
  }

  pin(frame: number | null): void {
    this.pinned = frame;
  }

  /** Drops every unpinned entry outside [lo, hi]. */
  retainRange(lo: number, hi: number): void {
    for (const frame of [...this.entries.keys()]) {
      if ((frame < lo || frame > hi) && frame !== this.pinned) this.delete(frame);
    }
  }

  clear(): void {
    for (const e of this.entries.values()) e.bitmap.close();
    this.entries.clear();
    this.totalBytes = 0;
    this.pinned = null;
  }

  private evictOverBudget(): void {
    while (this.totalBytes > this.budgetBytes && this.entries.size > 1) {
      const victim = this.pickVictim();
      if (victim === null) return;
      this.delete(victim);
    }
  }

  private pickVictim(): number | null {
    let victim: number | null = null;
    let worstScore = -1;
    let worstUse = Infinity;
    for (const [frame, e] of this.entries) {
      if (frame === this.pinned) continue;
      const d = frame - this.anchor;
      const score = d >= 0 ? d / 2 : -d;
      if (score > worstScore || (score === worstScore && e.lastUse < worstUse)) {
        victim = frame;
        worstScore = score;
        worstUse = e.lastUse;
      }
    }
    return victim;
  }

  private delete(frame: number): void {
    const e = this.entries.get(frame);
    if (!e) return;
    e.bitmap.close();
    this.totalBytes -= e.bytes;
    this.entries.delete(frame);
  }
}
