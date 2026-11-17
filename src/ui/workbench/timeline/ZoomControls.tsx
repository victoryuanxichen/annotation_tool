import type { ReactElement } from 'react';
import { formatNumber, useT } from '../../../i18n';
import { getPlayer } from '../../app';
import { IconButton } from '../../kit';
import { useFrameIndex } from '../../hooks';
import { useTimelineView, zoomFactor } from './view';

const STEP = 2;

/** Zoom out / factor (click = fit whole video) / zoom in, anchored at the playhead when visible. */
export function ZoomControls(): ReactElement {
  const t = useT();
  const index = useFrameIndex();
  const factor = useTimelineView((s) => zoomFactor(s));
  const canIn = useTimelineView((s) => s.spanUs > s.minSpanUs * 1.001);
  const canOut = useTimelineView((s) => s.spanUs < (s.domainEndUs - s.domainStartUs) * 0.999);
  const disabled = !index;

  const zoom = (f: number): void => {
    const v = useTimelineView.getState();
    const frame = getPlayer()?.getSnapshot().displayedFrame ?? null;
    const playhead = index && frame !== null && frame < index.frameCount ? index.ptsUs[frame] : null;
    const visible = playhead !== null && playhead >= v.startUs && playhead <= v.startUs + v.spanUs;
    v.zoomAt(f, visible ? playhead : v.startUs + v.spanUs / 2);
  };

  const label = formatNumber(factor, { maximumFractionDigits: factor < 10 ? 1 : 0 });

  return (
    <div className="wb-zoomctl">
      <IconButton icon="zoom-out" label={t('timeline.zoomOut')} disabled={disabled || !canOut} onClick={() => zoom(1 / STEP)} />
      <button
        type="button"
        className="wb-zoom"
        disabled={disabled || !canOut}
        title={t('timeline.zoomFit')}
        aria-label={t('timeline.zoomFit')}
        onClick={() => useTimelineView.getState().fit()}
      >
        {/* "Fit" rather than "1×", which would read like the playback rate next to it. */}
        {canOut ? t('ui.timeline.zoomFactor', { factor: label }) : t('ui.timeline.zoomFitted')}
      </button>
      <IconButton icon="zoom-in" label={t('timeline.zoomIn')} disabled={disabled || !canIn} onClick={() => zoom(STEP)} />
    </div>
  );
}
