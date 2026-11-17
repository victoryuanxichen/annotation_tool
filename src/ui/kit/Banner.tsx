import type { ReactElement, ReactNode } from 'react';
import { useT } from '../../i18n';
import { Icon, type IconName } from '../icons';
import { IconButton } from './Button';
import { cx } from './internal';

export type BannerTone = 'info' | 'warning' | 'danger' | 'success';

const TONE_ICON: Readonly<Record<BannerTone, IconName>> = {
  info: 'info',
  warning: 'warning',
  danger: 'alert',
  success: 'check',
};

export interface BannerProps {
  tone?: BannerTone;
  children: ReactNode;
  /** Buttons aligned to the end. */
  actions?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  className?: string;
}

/** Full-width inline notice (stale tab, folder access, browser support). Not a toast. */
export function Banner({ tone = 'info', children, actions, onDismiss, dismissLabel, className }: BannerProps): ReactElement {
  const t = useT();
  return (
    <div className={cx('ui-banner', `ui-banner--${tone}`, className)} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={TONE_ICON[tone]} className="ui-banner__icon" />
      <div className="ui-banner__msg">{children}</div>
      {actions ? <div className="ui-banner__actions">{actions}</div> : null}
      {onDismiss ? <IconButton icon="x" size="sm" label={dismissLabel ?? t('notice.dismiss')} tooltip={false} onClick={onDismiss} /> : null}
    </div>
  );
}
