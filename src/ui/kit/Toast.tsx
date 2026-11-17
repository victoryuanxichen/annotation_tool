import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import { useT } from '../../i18n';
import { Icon, type IconName } from '../icons';
import { IconButton } from './Button';
import { cx } from './internal';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction {
  label: string;
  onAction: () => void;
}

export interface ToastOptions {
  kind?: ToastKind;
  message: string;
  detail?: string;
  action?: ToastAction;
  /** ms before auto-dismiss; null keeps it until dismissed. Errors never auto-dismiss. */
  durationMs?: number | null;
  /** Reusing an id replaces that toast in place (e.g. repeated "Saved"). */
  id?: string;
}

export interface ToastRecord {
  id: string | number;
  kind: ToastKind;
  message: string;
  detail?: string;
  action?: ToastAction;
  durationMs: number | null;
}

const DEFAULT_DURATION: Readonly<Record<ToastKind, number | null>> = {
  info: 4000,
  success: 3000,
  warning: 7000,
  error: null,
};
const MAX_VISIBLE = 4;

let toasts: readonly ToastRecord[] = [];
let seq = 0;
const listeners = new Set<() => void>();

function emit(next: readonly ToastRecord[]): void {
  toasts = next;
  for (const fn of listeners) fn();
}

function show(options: ToastOptions): string {
  const kind = options.kind ?? 'info';
  const id = options.id ?? `toast-${++seq}`;
  const record: ToastRecord = {
    id,
    kind,
    message: options.message,
    detail: options.detail,
    action: options.action,
    durationMs: kind === 'error' ? null : options.durationMs === undefined ? DEFAULT_DURATION[kind] : options.durationMs,
  };
  const existing = toasts.findIndex((t) => t.id === id);
  let next = existing >= 0 ? toasts.map((t, i) => (i === existing ? record : t)) : [...toasts, record];
  // Drop the oldest dismissible toasts first; errors stay until acknowledged.
  while (next.length > MAX_VISIBLE) {
    const victim = next.findIndex((t) => t.kind !== 'error');
    next = next.filter((_, i) => i !== (victim >= 0 ? victim : 0));
  }
  emit(next);
  return id;
}

function dismiss(id: ToastRecord['id']): void {
  if (toasts.some((t) => t.id === id)) emit(toasts.filter((t) => t.id !== id));
}

type ShortOptions = Omit<ToastOptions, 'kind' | 'message'>;

/** Imperative toast API usable from anywhere (state modules included). */
export const toast = {
  show,
  dismiss,
  clear: (): void => emit([]),
  info: (message: string, o: ShortOptions = {}): string => show({ ...o, message, kind: 'info' }),
  success: (message: string, o: ShortOptions = {}): string => show({ ...o, message, kind: 'success' }),
  warning: (message: string, o: ShortOptions = {}): string => show({ ...o, message, kind: 'warning' }),
  error: (message: string, o: ShortOptions = {}): string => show({ ...o, message, kind: 'error' }),
};

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useToasts(): readonly ToastRecord[] {
  return useSyncExternalStore(subscribe, () => toasts, () => toasts);
}

const KIND_ICON: Readonly<Record<ToastKind, IconName>> = {
  info: 'info',
  success: 'check',
  warning: 'warning',
  error: 'alert',
};

function ToastItem({ record, onDismiss }: { record: ToastRecord; onDismiss: (id: ToastRecord['id']) => void }): ReactElement {
  const t = useT();
  const [paused, setPaused] = useState(false);
  const remaining = useRef(record.durationMs);
  const startedAt = useRef(0);
  // Callers may pass a fresh onDismiss each render; keep the timer independent of it.
  const dismissRef = useRef(onDismiss);
  useLayoutEffect(() => {
    dismissRef.current = onDismiss;
  });

  useEffect(() => {
    remaining.current = record.durationMs;
  }, [record]);

  useEffect(() => {
    if (paused || remaining.current === null) return;
    startedAt.current = performance.now();
    const handle = window.setTimeout(() => dismissRef.current(record.id), remaining.current);
    return () => {
      window.clearTimeout(handle);
      if (remaining.current !== null) remaining.current -= performance.now() - startedAt.current;
    };
  }, [paused, record]);

  return (
    <div
      className={cx('ui-toast', `ui-toast--${record.kind}`)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      data-kind={record.kind}
    >
      <Icon name={KIND_ICON[record.kind]} className="ui-toast__icon" />
      <div className="ui-toast__body">
        <p className="ui-toast__msg">{record.message}</p>
        {record.detail ? (
          <p className="ui-toast__detail" title={record.detail}>
            {record.detail}
          </p>
        ) : null}
        {record.action ? (
          <button
            type="button"
            className="ui-toast__action"
            onClick={() => {
              onDismiss(record.id);
              record.action?.onAction();
            }}
          >
            {record.action.label}
          </button>
        ) : null}
      </div>
      <IconButton icon="x" size="sm" label={t('kit.toast.dismiss')} tooltip={false} onClick={() => onDismiss(record.id)} />
    </div>
  );
}

export interface ToastRegionProps {
  /** Controlled mode: render these instead of the built-in `toast` store. */
  toasts?: readonly ToastRecord[];
  onDismiss?: (id: ToastRecord['id']) => void;
}

/** Mount once near the app root. Polite live region; newest toast at the bottom. */
export function ToastRegion({ toasts: controlled, onDismiss = dismiss }: ToastRegionProps = {}): ReactElement {
  const t = useT();
  const internal = useToasts();
  const list = controlled ?? internal;
  return (
    <section className="ui-toasts" aria-live="polite" aria-relevant="additions text" aria-label={t('kit.toast.region')}>
      {list.map((record) => (
        <ToastItem key={record.id} record={record} onDismiss={onDismiss} />
      ))}
    </section>
  );
}
