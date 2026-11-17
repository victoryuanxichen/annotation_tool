/** Bounded undo/redo stacks of editor snapshots (segments + pending start). */
import type { AnnotationDoc } from './contract';

export interface EditorSnapshot {
  doc: AnnotationDoc;
  pendingStart: number | null;
}

export const HISTORY_LIMIT = 200;

export class History {
  private past: EditorSnapshot[] = [];
  private future: EditorSnapshot[] = [];

  constructor(private readonly limit = HISTORY_LIMIT) {}

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Records `before` (the state prior to a change) and drops the redo branch. */
  push(before: EditorSnapshot): void {
    this.past.push(before);
    if (this.past.length > this.limit) this.past.splice(0, this.past.length - this.limit);
    this.future = [];
  }

  undo(current: EditorSnapshot): EditorSnapshot | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(current);
    return prev;
  }

  redo(current: EditorSnapshot): EditorSnapshot | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(current);
    return next;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }

  get size(): number {
    return this.past.length;
  }
}
