import {
  useId,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { useT } from '../../i18n';
import { Icon, type IconName } from '../icons';
import { cx } from './internal';

export type ErrorDisplay = 'below' | 'float';

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  /** id of the control the label points at. */
  htmlFor?: string;
  errorId?: string;
  hintId?: string;
  errorDisplay?: ErrorDisplay;
  className?: string;
  children: ReactNode;
}

/**
 * Label + control + hint/error. With errorDisplay 'float' the error is drawn as an
 * overlay below the control so toolbars never shift when it appears.
 */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  errorId,
  hintId,
  errorDisplay = 'below',
  className,
  children,
}: FieldProps): ReactElement {
  return (
    <div className={cx('ui-field', errorDisplay === 'float' && 'ui-field--float', className)}>
      {label ? (
        <label className="ui-field__label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : null}
      {children}
      {error ? (
        <p id={errorId} className="ui-field__error" role="alert">
          <Icon name="alert" size={12} />
          <span>{error}</span>
        </p>
      ) : hint ? (
        <p id={hintId} className="ui-field__hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  errorDisplay?: ErrorDisplay;
  size?: 'sm' | 'md';
  /** Leading icon (e.g. search). */
  icon?: IconName;
  mono?: boolean;
  fieldClassName?: string;
  ref?: Ref<HTMLInputElement>;
}

export function TextInput({
  label,
  hint,
  error,
  errorDisplay = 'below',
  size = 'md',
  icon,
  mono = false,
  id,
  className,
  fieldClassName,
  type = 'text',
  ...rest
}: TextInputProps): ReactElement {
  const autoId = useId();
  const inputId = id ?? autoId;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;
  const describedBy = error ? errorId : hint ? hintId : undefined;
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      htmlFor={inputId}
      errorId={errorId}
      hintId={hintId}
      errorDisplay={errorDisplay}
      className={fieldClassName}
    >
      <span
        className={cx(
          'ui-input',
          `ui-input--${size}`,
          mono && 'ui-input--mono',
          icon && 'ui-input--icon',
          error && 'ui-input--invalid',
          className,
        )}
      >
        {icon ? <Icon name={icon} size={14} className="ui-input__icon" /> : null}
        <input
          id={inputId}
          type={type}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...rest}
        />
      </span>
    </Field>
  );
}

export interface NumberInputProps
  extends Omit<TextInputProps, 'value' | 'defaultValue' | 'onChange' | 'type' | 'error' | 'onKeyDown'> {
  /** Committed value shown while the field is not being edited. */
  value: number | null;
  /** Called on Enter with a valid integer within [min, max]. */
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  /** Overrides the default range/format message. */
  invalidMessage?: string;
  /** Error from outside (e.g. the commit was refused). */
  externalError?: string | null;
  /** Select the text on focus so typing replaces it. */
  selectOnFocus?: boolean;
}

export type ParseIntResult = { ok: true; value: number } | { ok: false; reason: 'format' | 'range' };

/** Parses a whole number, tolerating spaces, thousands separators and underscores. */
export function parseIntInRange(text: string, min: number, max: number): ParseIntResult {
  const cleaned = text.trim().replace(/[\s,_]/g, '');
  if (!/^-?\d+$/.test(cleaned)) return { ok: false, reason: 'format' };
  const value = Number(cleaned);
  if (!Number.isSafeInteger(value)) return { ok: false, reason: 'format' };
  if (value < min || value > max) return { ok: false, reason: 'range' };
  return { ok: true, value };
}

/**
 * Integer entry that commits on Enter. Invalid input shows an inline error and keeps focus;
 * Esc reverts (and does not bubble, so global Esc handlers are not triggered).
 */
export function NumberInput({
  value,
  onCommit,
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
  invalidMessage,
  externalError,
  selectOnFocus = true,
  mono = true,
  onFocus,
  onBlur,
  ...rest
}: NumberInputProps): ReactElement {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const messageFor = (reason: 'format' | 'range'): string => {
    if (invalidMessage) return invalidMessage;
    const bounded = min > Number.MIN_SAFE_INTEGER && max < Number.MAX_SAFE_INTEGER;
    return reason === 'range' || bounded ? t('kit.number.range', { min, max }) : t('kit.number.invalid');
  };

  const commit = (): void => {
    if (draft === null) return;
    const parsed = parseIntInRange(draft, min, max);
    if (!parsed.ok) {
      setError(messageFor(parsed.reason));
      return;
    }
    setError(null);
    setDraft(null);
    onCommit(parsed.value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setDraft(null);
      setError(null);
      e.currentTarget.blur();
    }
  };

  return (
    <TextInput
      {...rest}
      mono={mono}
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      value={draft ?? (value === null ? '' : String(value))}
      error={error ?? externalError ?? null}
      onChange={(e) => {
        setDraft(e.target.value);
        if (error) setError(null);
      }}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        if (selectOnFocus) e.currentTarget.select();
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setDraft(null);
        setError(null);
        onBlur?.(e);
      }}
    />
  );
}
