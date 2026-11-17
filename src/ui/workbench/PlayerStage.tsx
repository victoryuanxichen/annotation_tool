import { useCallback, type ReactElement, type ReactNode } from 'react';
import { useT, type MessageKey } from '../../i18n';
import { actions, useApp, usePlayerSnapshot } from '../app';
import { useMsg } from '../msg';
import { useUi } from '../uiStore';
import { Banner, Button, ProgressBar } from '../kit';
import { Icon } from '../icons';

const PLAYER_ERROR_KEY: Readonly<Record<string, MessageKey>> = {
  codec_unsupported: 'player.error.codec_unsupported',
  decode_failed: 'player.error.decode_failed',
  read_failed: 'player.error.read_failed',
  webcodecs_missing: 'player.error.webcodecs_missing',
};

/** The dominant video canvas, letterboxed by the player, with state overlays only when needed. */
export function PlayerStage(): ReactElement {
  const t = useT();
  // Stable ref callback: the controller owns the canvas once attached.
  const canvasRef = useCallback((el: HTMLCanvasElement | null) => actions.attachCanvas(el), []);
  return (
    <div className="wb-well">
      <canvas ref={canvasRef} className="wb-canvas" role="img" aria-label={t('player.canvasLabel')} data-testid="player-canvas" />
      <StageOverlay />
      <StaleBanner />
      <DropOverlay />
    </div>
  );
}

function Overlay({ tone = 'info', children }: { tone?: 'info' | 'danger'; children: ReactNode }): ReactElement {
  return (
    <div className={`wb-stage-overlay wb-stage-overlay--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <div className="wb-stage-msg">{children}</div>
    </div>
  );
}

function StageOverlay(): ReactElement | null {
  const t = useT();
  const tm = useMsg();
  const hasVideo = useApp((s) => s.video.itemId !== null || s.video.fileName !== null);
  const loadPhase = useApp((s) => s.video.loadPhase);
  const videoError = useApp((s) => s.video.error);
  const webCodecs = useApp((s) => s.capabilities.webCodecs);
  const scanning = useApp((s) => s.batch.scanning);
  const scanned = useApp((s) => s.batch.scannedCount);
  const { status, error: playerError } = usePlayerSnapshot();

  if (!webCodecs) {
    return (
      <Overlay tone="danger">
        <Icon name="alert" size={20} />
        <p>{t('notice.unsupportedBrowser')}</p>
      </Overlay>
    );
  }
  if (!hasVideo) {
    if (scanning) {
      return (
        <Overlay>
          <p>{t('batch.scanning', { count: scanned })}</p>
          <ProgressBar value={null} label={t('batch.scanning', { count: scanned })} className="wb-stage-progress" />
        </Overlay>
      );
    }
    return (
      <Overlay>
        <p>{t('video.empty')}</p>
        <div className="wb-stage-actions">
          <Button icon="file" onClick={() => void actions.openFile()}>
            {t('topbar.openFile')}
          </Button>
          <Button icon="folder" onClick={() => void actions.openFolder()}>
            {t('topbar.openFolder')}
          </Button>
        </div>
        <p className="wb-stage-hint">{t('video.drop')}</p>
      </Overlay>
    );
  }
  if (loadPhase === 'error') {
    return (
      <Overlay tone="danger">
        <Icon name="alert" size={20} />
        <p className="wb-stage-title">{t('video.status.error')}</p>
        <p>{tm(videoError)}</p>
      </Overlay>
    );
  }
  if (loadPhase === 'indexing' || loadPhase === 'loading') {
    const label = loadPhase === 'indexing' ? t('video.status.indexing') : t('video.status.loading');
    return (
      <Overlay>
        <p>{label}</p>
        <ProgressBar value={null} label={label} className="wb-stage-progress" />
      </Overlay>
    );
  }
  if (status === 'error' && playerError) {
    const key = PLAYER_ERROR_KEY[playerError.code];
    return (
      <Overlay tone="danger">
        <Icon name="alert" size={20} />
        <p>{key ? t(key) : playerError.message}</p>
      </Overlay>
    );
  }
  return null;
}

function StaleBanner(): ReactElement | null {
  const t = useT();
  const stale = useApp((s) => s.stale);
  if (!stale) return null;
  return (
    <div className="wb-stage-banner">
      <Banner
        tone="warning"
        actions={
          <>
            <Button size="sm" onClick={() => void actions.resolveStale('keep-mine')}>
              {t('stale.keepMine')}
            </Button>
            <Button size="sm" variant="primary" onClick={() => void actions.resolveStale('load-newer')}>
              {t('stale.loadNewer')}
            </Button>
          </>
        }
      >
        {t('stale.banner')} <span className="u-muted">{t('stale.note')}</span>
      </Banner>
    </div>
  );
}

function DropOverlay(): ReactElement | null {
  const t = useT();
  const on = useUi((s) => s.dragOver);
  if (!on) return null;
  return (
    <div className="wb-drop" aria-hidden>
      <Icon name="upload" size={20} />
      <span>{t('video.drop')}</span>
    </div>
  );
}
