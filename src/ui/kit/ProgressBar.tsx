import type { ReactElement } from 'react';
import { cx } from './internal';

export interface ProgressBarProps {
  /** 0…1, or null for indeterminate. */
  value: number | null;
  label: string;
  className?: string;
}

/** 2 px progress line for background work (hashing, scanning). */
export function ProgressBar({ value, label, className }: ProgressBarProps): ReactElement {
  const pct = value === null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      className={cx('ui-progress', pct === null && 'ui-progress--indeterminate', className)}
    >
      <div className="ui-progress__bar" style={pct === null ? undefined : { width: `${pct}%` }} />
    </div>
  );
}
