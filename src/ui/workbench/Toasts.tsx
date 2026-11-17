import { useMemo, type ReactElement } from 'react';
import { useT, type Translate } from '../../i18n';
import { actions, useApp } from '../app';
import type { Toast } from '../app';
import { translateMsg } from '../msg';
import { ToastRegion, type ToastRecord } from '../kit';

// The kit restarts a toast's timer when its record object changes, so records are cached per
// toast (and language) to keep other toasts' timers running when one is added or dismissed.
const cache = new WeakMap<Toast, { t: Translate; record: ToastRecord }>();

function recordOf(toast: Toast, t: Translate): ToastRecord {
  const hit = cache.get(toast);
  if (hit && hit.t === t) return hit.record;
  const record: ToastRecord = {
    id: toast.id,
    kind: toast.kind,
    message: translateMsg(t, toast.msg),
    action: toast.action ? { label: translateMsg(t, toast.action.label), onAction: toast.action.run } : undefined,
    durationMs: toast.timeout,
  };
  cache.set(toast, { t, record });
  return record;
}

/** Binds the kit toast region to state.toasts. */
export function Toasts(): ReactElement {
  const t = useT();
  const toasts = useApp((s) => s.toasts);
  const records = useMemo(() => toasts.map((toast) => recordOf(toast, t)), [toasts, t]);
  return <ToastRegion toasts={records} onDismiss={(id) => actions.dismissToast(Number(id))} />;
}
