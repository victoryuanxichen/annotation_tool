import type { ReactElement, Ref, SelectHTMLAttributes } from 'react';
import { Icon } from '../icons';
import { cx } from './internal';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectGroup<T extends string> {
  label: string;
  options: ReadonlyArray<SelectOption<T>>;
}

export interface SelectProps<T extends string>
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size' | 'value' | 'onChange' | 'children'> {
  value: T;
  onChange: (value: T) => void;
  options?: ReadonlyArray<SelectOption<T>>;
  groups?: ReadonlyArray<SelectGroup<T>>;
  size?: 'sm' | 'md';
  /** Mono + tabular numerals (rates, numeric choices). */
  mono?: boolean;
  /** Optional colour swatch shown before the value (phase relabel). */
  swatch?: string;
  invalid?: boolean;
  ref?: Ref<HTMLSelectElement>;
}

/** Native <select> (keyboard and screen-reader behaviour for free), styled to match the kit. */
export function Select<T extends string>({
  value,
  onChange,
  options = [],
  groups = [],
  size = 'md',
  mono = false,
  swatch,
  invalid = false,
  className,
  style,
  ...rest
}: SelectProps<T>): ReactElement {
  const renderOption = (o: SelectOption<T>): ReactElement => (
    <option key={o.value} value={o.value} disabled={o.disabled}>
      {o.label}
    </option>
  );
  return (
    <span
      className={cx('ui-select', `ui-select--${size}`, mono && 'ui-select--mono', swatch && 'ui-select--swatch', className)}
      style={style}
    >
      {swatch ? <span className="ui-select__swatch" style={{ background: swatch }} aria-hidden /> : null}
      <select
        value={value}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value as T)}
        {...rest}
      >
        {options.map(renderOption)}
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.options.map(renderOption)}
          </optgroup>
        ))}
      </select>
      <Icon name="chevron-down" size={14} className="ui-select__chevron" />
    </span>
  );
}
