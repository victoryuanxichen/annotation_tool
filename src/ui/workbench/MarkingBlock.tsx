import type { ReactElement } from 'react';
import { useT } from '../../i18n';
import { actions, useApp } from '../app';
import { useMsg } from '../msg';
import { Icon, type IconName } from '../icons';
import { Button, IconButton } from '../kit';

const FEEDBACK_ICON: Readonly<Record<'ok' | 'error' | 'waiting', IconName>> = {
  ok: 'check',
  error: 'warning',
  waiting: 'history',
};

function PendingStart(): ReactElement {
  const t = useT();
  const pending = useApp((s) => s.editor.pendingStart);
  const active = pending !== null;
  return (
    <div className={active ? 'wb-pendingbox wb-pendingbox--active' : 'wb-pendingbox'} data-testid="pending-start">
      <span className="wb-pendingbox-label">{t('mark.pendingStart')}</span>
      <span className="wb-pendingbox-value">{active ? pending : '—'}</span>
      <IconButton
        icon="x"
        size="sm"
        label={t('mark.cancelPending')}
        kbd="Esc"
        disabled={!active}
        onClick={() => actions.cancelPendingStart()}
      />
    </div>
  );
}

function Feedback(): ReactElement {
  const tm = useMsg();
  const fb = useApp((s) => s.markFeedback);
  return (
    <div
      className={fb ? `wb-feedback wb-feedback--${fb.kind}` : 'wb-feedback'}
      role="status"
      aria-live="polite"
      data-testid="mark-feedback"
    >
      {fb ? (
        // A fresh key per message makes screen readers announce repeated identical text.
        <span key={fb.seq} className="wb-feedback-msg">
          <Icon name={FEEDBACK_ICON[fb.kind]} size={14} className="wb-feedback-icon" />
          <span>{tm(fb.msg)}</span>
        </span>
      ) : null}
      {fb?.action ? (
        <Button size="sm" variant="ghost" onClick={fb.action.run}>
          {tm(fb.action.label)}
        </Button>
      ) : null}
    </div>
  );
}

/** Pinned marking block: pending start, the four marking actions, and inline feedback. */
export function MarkingBlock(): ReactElement {
  const t = useT();
  const hasVideo = useApp((s) => s.video.itemId !== null || s.video.fileName !== null);
  const pending = useApp((s) => s.editor.pendingStart !== null);
  return (
    <section className="wb-section wb-section--pinned" aria-label={t('mark.title')}>
      <div className="wb-section-title">{t('mark.title')}</div>
      <PendingStart />
      <div className="wb-markgrid">
        <Button kbd="Q" title={t('mark.startLabel')} disabled={!hasVideo} onClick={() => void actions.markStart()}>
          {t('mark.start')}
        </Button>
        <Button
          kbd="W"
          variant={pending ? 'primary' : 'default'}
          title={t('mark.finishLabel')}
          disabled={!hasVideo}
          onClick={() => void actions.markFinish()}
        >
          {t('mark.finish')}
        </Button>
        <Button kbd="E" title={t('mark.finishNextLabel')} disabled={!hasVideo} onClick={() => void actions.markFinishAndNext()}>
          {t('mark.finishNext')}
        </Button>
        <Button kbd="R" title={t('mark.throughEndLabel')} disabled={!hasVideo} onClick={() => void actions.markThroughEnd()}>
          {t('mark.throughEnd')}
        </Button>
      </div>
      <Feedback />
    </section>
  );
}
