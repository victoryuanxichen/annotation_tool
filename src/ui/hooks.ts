import { useRef } from 'react';
import type { FrameIndex } from '../core/mp4';
import { getFrameIndex, useApp } from './app';
import type { AppState } from './app';

/**
 * The current video's frame index. `getFrameIndex()` is not reactive, so this subscribes to the
 * video fields that change whenever the index does.
 */
export function useFrameIndex(): FrameIndex | null {
  useApp((s) => s.video.itemId);
  useApp((s) => s.video.loadPhase);
  useApp((s) => s.video.frameCount);
  const index = getFrameIndex();
  return index && index.frameCount > 0 ? index : null;
}

/** Position of the open video in the sorted batch, or -1. */
export function selectCurrentIndex(s: AppState): number {
  const id = s.batch.currentId;
  return id === null ? -1 : s.batch.items.findIndex((it) => it.id === id);
}

/** Time of boundary b (0…N), tolerant of out-of-range values from invalid segments. */
export function boundaryTime(index: FrameIndex, b: number): number {
  const n = index.frameCount;
  const clamped = Math.min(n, Math.max(0, Math.round(b)));
  return clamped === n ? index.durationUs : index.ptsUs[clamped];
}

/** Duration as a compact timecode: hours are dropped when zero. */
export function formatDurationUs(us: number, format: (us: number) => string): string {
  const text = format(us);
  return text.startsWith('00:') ? text.slice(3) : text;
}

/** Gives focus back to the page so the global shortcuts work again (they ignore form fields). */
export function releaseFocus(): void {
  const el = document.activeElement;
  if (el instanceof HTMLElement && el !== document.body) el.blur();
}

/**
 * For native selects: after a value is picked with the pointer, release focus so the next
 * shortcut (Q, W, D …) is not swallowed by the select's type-ahead. Keyboard use keeps focus.
 */
export function useReleaseAfterPointerPick(): {
  onPointerDown: () => void;
  onKeyDown: () => void;
  picked: () => void;
} {
  const viaPointer = useRef(false);
  return {
    onPointerDown: () => {
      viaPointer.current = true;
    },
    onKeyDown: () => {
      viaPointer.current = false;
    },
    picked: () => {
      if (viaPointer.current) releaseFocus();
      viaPointer.current = false;
    },
  };
}
