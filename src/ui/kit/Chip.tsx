import type { ButtonHTMLAttributes, CSSProperties, ReactElement, Ref } from 'react';
import { cx } from './internal';

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'color' | 'children'> {
  /** Phase colour, '#rrggbb'. */
  color: string;
  label: string;
  selected?: boolean;
  /** Shortcut digit shown at the end, e.g. "1" or "⇧1". */
  shortcut?: string;
  /** Maximum width in px before the label ellipsizes (full name stays in the title). */
  maxWidth?: number;
  ref?: Ref<HTMLButtonElement>;
}

/** Phase chip: swatch + label (+ shortcut). A toggle button; `selected` maps to aria-pressed. */
export function Chip({
  color,
  label,
  selected = false,
  shortcut,
  maxWidth = 200,
  className,
  style,
  title,
  type = 'button',
  ...rest
}: ChipProps): ReactElement {
  const chipStyle = { ...style, '--chip-color': color, maxWidth } as CSSProperties;
  return (
    <button
      type={type}
      className={cx('ui-chip', selected && 'ui-chip--selected', className)}
      aria-pressed={selected}
      title={title ?? label}
      style={chipStyle}
      {...rest}
    >
      <span className="ui-chip__swatch" aria-hidden />
      <span className="ui-chip__label">{label}</span>
      {shortcut ? (
        <span className="ui-chip__key" aria-hidden>
          {shortcut}
        </span>
      ) : null}
    </button>
  );
}

export interface SwatchProps {
  color: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/** Plain colour swatch for tables and the selected-phase display. */
export function Swatch({ color, size = 'md', className }: SwatchProps): ReactElement {
  return (
    <span
      className={cx('ui-swatch', `ui-swatch--${size}`, className)}
      style={{ '--chip-color': color } as CSSProperties}
      aria-hidden
    />
  );
}
