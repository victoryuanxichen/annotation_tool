import type { ReactElement, ReactNode } from 'react';
import { cx } from './internal';

export interface EmptyStateProps {
  /** One line saying what is missing and how to get it. */
  message: ReactNode;
  action?: ReactNode;
  /** Align to the start (inside tables) instead of centring in the region. */
  align?: 'center' | 'start';
  className?: string;
}

export function EmptyState({ message, action, align = 'center', className }: EmptyStateProps): ReactElement {
  return (
    <div className={cx('ui-empty', `ui-empty--${align}`, className)}>
      <p className="ui-empty__msg">{message}</p>
      {action ? <div className="ui-empty__action">{action}</div> : null}
    </div>
  );
}
