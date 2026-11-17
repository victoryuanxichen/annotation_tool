import { useRef, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { Icon, type IconName } from '../icons';
import { cx } from './internal';

export interface SegmentOption<T extends string> {
  value: T;
  label?: ReactNode;
  icon?: IconName;
  /** Required when the option shows only an icon. */
  ariaLabel?: string;
  disabled?: boolean;
  title?: string;
}

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (value: T) => void;
  'aria-label': string;
  size?: 'sm' | 'md';
  fullWidth?: boolean;
  disabled?: boolean;
  className?: string;
}

/** Single-choice radio group rendered as joined buttons; arrows move the selection. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  fullWidth = false,
  disabled = false,
  className,
  ...aria
}: SegmentedControlProps<T>): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const enabled = options.filter((o) => !o.disabled);
    const i = enabled.findIndex((o) => o.value === value);
    let next: SegmentOption<T> | undefined;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = enabled[(i + 1) % enabled.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = enabled[(i - 1 + enabled.length) % enabled.length];
    if (!next || disabled) return;
    e.preventDefault();
    onChange(next.value);
    const idx = options.indexOf(next);
    rootRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[idx]?.focus();
  };

  return (
    <div
      ref={rootRef}
      role="radiogroup"
      aria-label={aria['aria-label']}
      aria-disabled={disabled || undefined}
      className={cx('ui-seg', `ui-seg--${size}`, fullWidth && 'ui-seg--full', className)}
      onKeyDown={onKeyDown}
    >
      {options.map((o) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={o.ariaLabel}
            title={o.title ?? o.ariaLabel}
            tabIndex={checked ? 0 : -1}
            disabled={disabled || o.disabled}
            className={cx('ui-seg__opt', checked && 'ui-seg__opt--checked')}
            onClick={() => onChange(o.value)}
          >
            {o.icon ? <Icon name={o.icon} /> : null}
            {o.label !== undefined ? <span>{o.label}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
