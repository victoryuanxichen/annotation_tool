import type { ButtonHTMLAttributes, ReactElement, ReactNode, Ref } from 'react';
import { Icon, type IconName } from '../icons';
import { Kbd, formatShortcut } from './Kbd';
import { Tooltip } from './Tooltip';
import { cx } from './internal';

export type ButtonVariant = 'primary' | 'default' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconEnd?: IconName;
  /** Shortcut shown as a key cap inside the button, e.g. "Q". */
  kbd?: string;
  /** Shows a busy state and disables the button. */
  busy?: boolean;
  fullWidth?: boolean;
  ref?: Ref<HTMLButtonElement>;
  children?: ReactNode;
}

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  iconEnd,
  kbd,
  busy = false,
  fullWidth = false,
  className,
  type = 'button',
  disabled,
  children,
  ...rest
}: ButtonProps): ReactElement {
  return (
    <button
      type={type}
      className={cx(
        'ui-btn',
        `ui-btn--${variant}`,
        `ui-btn--${size}`,
        fullWidth && 'ui-btn--full',
        busy && 'ui-btn--busy',
        !children && 'ui-btn--icon-only',
        className,
      )}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      aria-keyshortcuts={kbd ? formatShortcut(kbd) : undefined}
      {...rest}
    >
      {icon ? <Icon name={icon} className="ui-btn__icon" /> : null}
      {children ? <span className="ui-btn__label">{children}</span> : null}
      {iconEnd ? <Icon name={iconEnd} className="ui-btn__icon" /> : null}
      {kbd ? <Kbd keys={kbd} inverse={variant === 'primary' || variant === 'danger'} className="ui-btn__kbd" /> : null}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> {
  icon: IconName;
  /** Accessible name; also the tooltip text. */
  label: string;
  /** Shortcut shown in the tooltip. */
  kbd?: string;
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  /** Toggle state (aria-pressed). */
  pressed?: boolean;
  tooltip?: boolean;
  tooltipPlacement?: 'top' | 'bottom' | 'left' | 'right';
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({
  icon,
  label,
  kbd,
  variant = 'ghost',
  size = 'md',
  pressed,
  tooltip = true,
  tooltipPlacement = 'top',
  className,
  type = 'button',
  ...rest
}: IconButtonProps): ReactElement {
  const button = (
    <button
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      aria-keyshortcuts={kbd ? formatShortcut(kbd) : undefined}
      className={cx('ui-iconbtn', `ui-btn--${variant}`, `ui-iconbtn--${size}`, className)}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
  if (!tooltip) return button;
  return (
    <Tooltip content={label} kbd={kbd} placement={tooltipPlacement} describe={false}>
      {button}
    </Tooltip>
  );
}
