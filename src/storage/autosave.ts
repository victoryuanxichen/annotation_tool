/** Debounced, serialised draft autosave (SPEC §7.8). */
import type { DraftRecord, SaveResult } from './drafts';

/** Produces the latest draft at write time; null means "nothing to save". */
export type DraftProducer = () => DraftRecord | null;

export type AutosaveStatus =
  | { state: 'idle' }
  | { state: 'saving'; key: string }
  | { state: 'saved'; key: string; at: number; record: DraftRecord }
  | { state: 'error'; key: string | null; error: unknown }
  /** `stored` is the newer record, or null when it was deleted/re-keyed elsewhere. */
  | { state: 'conflict'; key: string; stored: DraftRecord | null };

export interface AutosaverOptions {
  store: { save(draft: DraftRecord, baseRevision: number): Promise<SaveResult> };
  onStatus?: (status: AutosaveStatus) => void;
  debounceMs?: number;
  maxWaitMs?: number;
  now?: () => number;
}

/** Minimal window surface needed for flush-on-hide; real `window` satisfies it. */
export interface AttachTarget {
  addEventListener(type: 'pagehide', listener: () => void): void;
  removeEventListener(type: 'pagehide', listener: () => void): void;
  document: {
    readonly visibilityState: DocumentVisibilityState;
    addEventListener(type: 'visibilitychange', listener: () => void): void;
    removeEventListener(type: 'visibilitychange', listener: () => void): void;
  };
}

type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Coalesces rapid changes into at most one write per debounce window (bounded by max wait) and
 * never has two writes in flight. A conflict blocks further writes until `resolveConflict`.
 */
export class Autosaver {
  private readonly store: AutosaverOptions['store'];
  private readonly onStatus: (status: AutosaveStatus) => void;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;

  private pending: DraftProducer | null = null;
  /** Set when the debounce/max-wait fired or a flush was requested. */
  private due = false;
  private blocked = false;
  private firstScheduledAt: number | null = null;
  private timer: TimerHandle | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly revisions = new Map<string, number>();
  private detachFn: (() => void) | null = null;
  private lastStatus: AutosaveStatus = { state: 'idle' };

  constructor(options: AutosaverOptions) {
    this.store = options.store;
    this.onStatus = options.onStatus ?? (() => undefined);
    this.debounceMs = options.debounceMs ?? 300;
    this.maxWaitMs = options.maxWaitMs ?? 1000;
    this.now = options.now ?? Date.now;
  }

  get status(): AutosaveStatus {
    return this.lastStatus;
  }

  /** True while a change is waiting to be written or a write is in flight. */
  get hasPendingWork(): boolean {
    return this.pending !== null || this.inFlight !== null;
  }

  schedule(producer: DraftProducer): void {
    this.pending = producer;
    if (this.blocked) return;
    const t = this.now();
    this.firstScheduledAt ??= t;
    const deadline = Math.min(t + this.debounceMs, this.firstScheduledAt + this.maxWaitMs);
    this.setTimer(Math.max(0, deadline - t));
  }

  /** Writes any pending change now (after an in-flight write). Resolves when the queue is drained. */
  flush(): Promise<void> {
    this.clearTimer();
    if (this.pending) this.due = true;
    return this.drain();
  }

  /** Re-attempts the last failed write. */
  retry(): Promise<void> {
    return this.flush();
  }

  /**
   * Adopts `baseRevision` for `key` and unblocks writes. Use after "Keep mine" (base = stored
   * revision, then the pending draft overwrites) or "Load newer version" (after replacing state).
   */
  resolveConflict(key: string, baseRevision: number): Promise<void> {
    this.revisions.set(key, baseRevision);
    this.blocked = false;
    return this.flush();
  }

  /** Records a revision this tab now knows is stored (e.g. after promotePending). */
  rebase(key: string, revision: number): void {
    this.revisions.set(key, revision);
  }

  /** Drops any unsaved change and timers (e.g. after loading a newer version). */
  discardPending(): void {
    this.clearTimer();
    this.pending = null;
    this.due = false;
  }

  attach(target: AttachTarget): void {
    this.detach();
    const onHide = (): void => void this.flush();
    const onVisibility = (): void => {
      if (target.document.visibilityState === 'hidden') onHide();
    };
    target.addEventListener('pagehide', onHide);
    target.document.addEventListener('visibilitychange', onVisibility);
    this.detachFn = () => {
      target.removeEventListener('pagehide', onHide);
      target.document.removeEventListener('visibilitychange', onVisibility);
    };
  }

  detach(): void {
    this.detachFn?.();
    this.detachFn = null;
  }

  dispose(): void {
    this.detach();
    this.discardPending();
  }

  private setTimer(delayMs: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.due = true;
      void this.drain();
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private canWrite(): boolean {
    return this.pending !== null && this.due && !this.blocked;
  }

  private drain(): Promise<void> {
    if (this.inFlight) return this.inFlight.then(() => this.drain());
    if (!this.canWrite()) return Promise.resolve();
    const tracked = this.writeOnce().then(() => {
      this.inFlight = null;
    });
    this.inFlight = tracked;
    return tracked.then(() => this.drain());
  }

  private async writeOnce(): Promise<void> {
    const producer = this.pending;
    this.pending = null;
    this.due = false;
    this.firstScheduledAt = null;
    if (!producer) return;

    let draft: DraftRecord | null;
    try {
      draft = producer();
    } catch (error) {
      this.emit({ state: 'error', key: null, error });
      return;
    }
    if (!draft) return;

    const base = Math.max(draft.revision, this.revisions.get(draft.key) ?? 0);
    this.emit({ state: 'saving', key: draft.key });
    let result: SaveResult;
    try {
      result = await this.store.save(draft, base);
    } catch (error) {
      this.pending ??= producer;
      this.emit({ state: 'error', key: draft.key, error });
      return;
    }
    if (result.ok) {
      this.revisions.set(result.record.key, result.record.revision);
      this.emit({ state: 'saved', key: result.record.key, at: result.record.savedAt, record: result.record });
    } else {
      this.blocked = true;
      this.pending ??= producer;
      this.clearTimer();
      this.emit({ state: 'conflict', key: draft.key, stored: result.conflict });
    }
  }

  private emit(status: AutosaveStatus): void {
    this.lastStatus = status;
    try {
      this.onStatus(status);
    } catch {
      // A failing listener must not break the save queue.
    }
  }
}
