import { useId, type ReactElement, type ReactNode } from 'react';
import { cx } from './internal';

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}

export function Checkbox({ checked, onChange, label, description, disabled, className }: CheckboxProps): ReactElement {
  const id = useId();
  return (
    <div className={cx('ui-check', disabled && 'ui-check--disabled', className)}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={description ? `${id}-desc` : undefined}
        onChange={(e) => onChange(e.target.checked)}
      />
      <label htmlFor={id}>{label}</label>
      {description ? (
        <p id={`${id}-desc`} className="ui-check__desc">
          {description}
        </p>
      ) : null}
    </div>
  );
}
