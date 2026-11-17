import type { ReactElement } from 'react';
import { formatTimecode, useT } from '../../i18n';
import { getPlayer, usePlayerSnapshot } from '../app';
import { releaseFocus, useFrameIndex, useReleaseAfterPointerPick } from '../hooks';
import { IconButton, NumberInput, Select } from '../kit';
import { ZoomControls } from './timeline/ZoomControls';

const RATES = ['0.25', '0.5', '1', '1.5', '2', '4'];

/** Playback controls, verified frame counter, jump-to-frame, timecode and timeline zoom. */
export function TransportBar(): ReactElement {
  const t = useT();
  const snap = usePlayerSnapshot();
  const index = useFrameIndex();
  const total = index?.frameCount ?? 0;
  const ready = snap.status === 'ready' && index !== null;
  const shown = snap.displayedFrame;
  const pending = snap.requestedFrame !== null && snap.requestedFrame !== shown ? snap.requestedFrame : null;
  const rate = String(snap.rate);
  const rates = RATES.includes(rate) ? RATES : [...RATES, rate].sort((a, b) => Number(a) - Number(b));
  const player = (): ReturnType<typeof getPlayer> => (ready ? getPlayer() : null);
  const rateFocus = useReleaseAfterPointerPick();

  return (
    <div className="wb-transport">
      <IconButton icon="skip-start" label={t('player.first')} kbd="Z" disabled={!ready} onClick={() => void player()?.seek(0)} />
      <IconButton
        icon="step-back"
        label={t('player.stepBack')}
        kbd="A"
        disabled={!ready}
        onClick={() => void player()?.step(-1)}
      />
      <IconButton
        icon={snap.playing ? 'pause' : 'play'}
        label={snap.playing ? t('player.pause') : t('player.play')}
        kbd="Space"
        variant="default"
        disabled={!ready}
        onClick={() => {
          const p = player();
          if (!p) return;
          if (snap.playing) p.pause();
          else p.play();
        }}
      />
      <IconButton
        icon="step-forward"
        label={t('player.stepForward')}
        kbd="D"
        disabled={!ready}
        onClick={() => void player()?.step(1)}
      />
      <IconButton
        icon="skip-end"
        label={t('player.last')}
        kbd="X"
        disabled={!ready}
        onClick={() => void player()?.seek(total - 1)}
      />
      <Select
        size="sm"
        mono
        aria-label={t('player.rate')}
        title={t('player.rate')}
        value={rate}
        disabled={!ready}
        onPointerDown={rateFocus.onPointerDown}
        onKeyDown={rateFocus.onKeyDown}
        onChange={(v) => {
          player()?.setRate(Number(v));
          rateFocus.picked();
        }}
        options={rates.map((r) => ({ value: r, label: t('player.rateValue', { rate: r }) }))}
      />
      <div className="wb-counter" title={shown === null ? undefined : t('player.currentFrame', { frame: shown, total })}>
        <NumberInput
          aria-label={t('player.jumpTo')}
          placeholder={t('player.jumpPlaceholder')}
          value={shown}
          min={0}
          max={Math.max(0, total - 1)}
          invalidMessage={t('player.jumpInvalid', { max: Math.max(0, total - 1) })}
          onCommit={(f) => {
            void player()?.seek(f);
            // Back to the shortcuts: the next D/A/Q should act on the video, not type here.
            releaseFocus();
          }}
          errorDisplay="float"
          disabled={!ready}
          data-testid="frame-input"
        />
        <span className="wb-total" data-testid="frame-total">
          / {index ? total : '—'}
        </span>
        <span className="wb-ghost" aria-hidden title={pending === null ? undefined : t('player.seeking', { frame: pending })}>
          {pending === null ? '' : `→ ${pending}`}
        </span>
        <span className="wb-tc" aria-label={t('player.time')} data-testid="timecode">
          {index && shown !== null && shown < total ? formatTimecode(index.ptsUs[shown]) : '--:--:--.---'}
        </span>
      </div>
      <div className="wb-transport-end">
        <ZoomControls />
      </div>
    </div>
  );
}
