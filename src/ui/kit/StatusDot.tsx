import type { ReactElement, ReactNode } from 'react';
import { cx } from './internal';

/**
 * Semantic tones. Each has a distinct shape as well as colour so state never relies on
 * colour alone: ok ● · busy ◌ (ring) · attention ● amber · danger ◆ · neutral ○ · accent ●.
 */
export type StatusTone = 'ok' | 'busy' | 'attention' | 'danger' | 'neutral' | 'accent';

export type SaveState = 'idle' | 'saving' | 'saved' | 'unsaved' | 'error';
export type BatchStatus = 'annotated' | 'draft' | 'unannotated' | 'unverified' | 'mismatch' | 'error';

export const SAVE_STATE_TONE: Readonly<Record<SaveState, StatusTone>> = {
  idle: 'neutral',
  saving: 'busy',
  saved: 'ok',
  unsaved: 'attention',
  error: 'danger',
};

export const BATCH_STATUS_TONE: Readonly<Record<BatchStatus, StatusTone>> = {
  annotated: 'ok',
  draft: 'attention',
  unannotated: 'neutral',
  unverified: 'busy',
  mismatch: 'danger',
  error: 'danger',
};

export interface StatusDotProps {
  tone: StatusTone;
  /** Always required: the state in words. */
  label: ReactNode;
  /** Keep the label for assistive tech only (dense lists with a column header). */
  hideLabel?: boolean;
  /** Extra explanation on hover. */
  title?: string;
  /** Colour the label text with the tone (top-bar save state). */
  tintLabel?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

export function StatusDot({
  tone,
  label,
  hideLabel = false,
  title,
  tintLabel = false,
  size = 'md',
  className,
}: StatusDotProps): ReactElement {
  return (
    <span
      className={cx('ui-status', `ui-status--${tone}`, `ui-status--${size}`, tintLabel && 'ui-status--tint', className)}
      title={title}
      data-tone={tone}
    >
      <span className="ui-status__dot" aria-hidden />
      <span className={hideLabel ? 'u-sr-only' : 'ui-status__label'}>{label}</span>
    </span>
  );
}
