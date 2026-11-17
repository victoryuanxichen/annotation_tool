import { useRef, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react';
import { cx } from './internal';

export interface SplitterProps {
  /** Size in px of the region the splitter controls. */
  value: number;
  min: number;
  max: number;
  /** Live updates while dragging or pressing arrow keys. */
  onChange: (value: number) => void;
  /** Final value after a drag or key press (persist here). */
  onCommit?: (value: number) => void;
  /**
   * 'after': the controlled region is below the splitter (dragging up grows it).
   * 'before': it is above (dragging down grows it).
   */
  region?: 'after' | 'before';
  /** Keyboard step in px; Shift multiplies by 5. */
  step?: number;
  'aria-label': string;
  /** id of the controlled region. */
  'aria-controls'?: string;
  className?: string;
}

function clamp(v: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, v)));
}

/** Horizontal divider between stacked regions; draggable and keyboard-adjustable (arrows, Home/End). */
export function Splitter({
  value,
  min,
  max,
  onChange,
  onCommit,
  region = 'after',
  step = 8,
  className,
  ...aria
}: SplitterProps): ReactElement {
  const drag = useRef<{ startY: number; startValue: number; last: number } | null>(null);
  const sign = region === 'after' ? -1 : 1;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    drag.current = { startY: e.clientY, startValue: value, last: value };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d) return;
    const next = clamp(d.startValue + sign * (e.clientY - d.startY), min, max);
    if (next !== d.last) {
      d.last = next;
      onChange(next);
    }
  };

  const endDrag = (): void => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    onCommit?.(d.last);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const amount = e.shiftKey ? step * 5 : step;
    let next: number | null = null;
    if (e.key === 'ArrowUp') next = value - sign * amount;
    else if (e.key === 'ArrowDown') next = value + sign * amount;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    if (next === null) return;
    e.preventDefault();
    const clamped = clamp(next, min, max);
    onChange(clamped);
    onCommit?.(clamped);
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label={aria['aria-label']}
      aria-controls={aria['aria-controls']}
      tabIndex={0}
      className={cx('ui-splitter', className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    />
  );
}
