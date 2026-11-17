import type { ReactElement } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { formatNumber, useT, type Translate } from '../../i18n';
import { actions, useApp } from '../app';
import type { VideoState } from '../app';
import { selectCurrentIndex } from '../hooks';
import { useMsg, type TranslateMsg } from '../msg';
import { Button, MiddleEllipsis, StatusDot, type StatusTone } from '../kit';

interface StatusView {
  tone: StatusTone;
  label: string;
  title?: string;
}

function percentOf(progress: number): number {
  // Progress is a 0…1 fraction; tolerate a 0…100 percentage too.
  return Math.round(Math.min(100, Math.max(0, progress <= 1 ? progress * 100 : progress)));
}

function statusOf(v: VideoState, t: Translate, tm: TranslateMsg): StatusView | null {
  if (v.itemId === null && v.fileName === null) return null;
  switch (v.loadPhase) {
    case 'idle':
      return null;
    case 'indexing':
      return { tone: 'busy', label: t('video.status.indexing') };
    case 'loading':
      return { tone: 'busy', label: t('video.status.loading') };
    case 'error':
      return { tone: 'danger', label: t('video.status.error'), title: tm(v.error) || undefined };
    case 'ready':
      if (v.hash.state === 'hashing') {
        return {
          tone: 'busy',
          label: t('video.status.hashing', { percent: percentOf(v.hash.progress) }),
          title: t('video.identity.provisional'),
        };
      }
      return {
        tone: v.identity === 'verified' ? 'ok' : 'neutral',
        label: t('video.status.ready'),
        title:
          v.identity === 'verified'
            ? t('video.identity.verified')
            : v.identity === 'provisional'
              ? t('video.identity.provisional')
              : undefined,
      };
  }
}

/** Filename row above the video: Previous · path · status · meta · Next (fixed positions). */
export function VideoHeader(): ReactElement {
  const t = useT();
  const tm = useMsg();
  const video = useApp((s) => s.video);
  const { index, count } = useApp(useShallow((s) => ({ index: selectCurrentIndex(s), count: s.batch.items.length })));
  const status = statusOf(video, t, tm);
  const path = video.relPath ?? video.fileName;
  const hasPrev = index > 0;
  const hasNext = index >= 0 && index < count - 1;
  const ready = video.loadPhase === 'ready';

  const meta = ready
    ? [
        `${video.width}×${video.height}`,
        video.variableFrameRate
          ? t('video.vfr')
          : t('video.fps', { fps: formatNumber(video.averageFps, { maximumFractionDigits: 3 }) }),
      ].join(' · ')
    : '';

  return (
    <div className="wb-filebar">
      <Button
        size="sm"
        icon="chevron-left"
        variant="ghost"
        aria-label={t('video.prevLabel')}
        title={t('video.prevLabel')}
        disabled={!hasPrev}
        onClick={() => void actions.prevVideo()}
      >
        {t('video.prev')}
      </Button>
      <div className="wb-file">
        {path ? <MiddleEllipsis text={path} className="wb-file-path" /> : <span className="wb-file-none">{t('video.none')}</span>}
        {status ? (
          <StatusDot tone={status.tone} size="sm" label={status.label} title={status.title} className="wb-file-status" />
        ) : null}
        {meta ? <span className="wb-file-meta u-tnum">{meta}</span> : null}
        {video.warnings.length > 0 ? (
          <span className="wb-file-warn" title={video.warnings.map((w) => tm(w)).join('\n')}>
            {t('video.indexWarnings', { count: video.warnings.length })}
          </span>
        ) : null}
      </div>
      <Button
        size="sm"
        iconEnd="chevron-right"
        variant="ghost"
        aria-label={t('video.nextLabel')}
        title={t('video.nextLabel')}
        disabled={!hasNext}
        onClick={() => void actions.nextVideo()}
      >
        {t('video.next')}
      </Button>
    </div>
  );
}
