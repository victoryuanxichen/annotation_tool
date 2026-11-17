import { useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { formatTimecode, useT } from '../../../i18n';
import { getThumbnail } from '../../app';

const THUMB_W = 160;
const THUMB_H = 90;
const BOX_W = THUMB_W + 8;
const BOX_H = THUMB_H + 34;
const NOTE_H = 16;

export interface HoverPreviewProps {
  /** Timeline box in viewport coordinates. */
  anchor: DOMRect;
  /** Pointer x within the timeline. */
  x: number;
  frame: number;
  timeUs: number;
}

/** Scrub preview above the timeline: preceding keyframe thumbnail, frame number and time. */
export function HoverPreview({ anchor, x, frame, timeUs }: HoverPreviewProps): ReactElement {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Frame of the keyframe picture actually drawn (null: none decoded yet).
  const [shownFrame, setShownFrame] = useState<number | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = THUMB_W * dpr;
    canvas.height = THUMB_H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#050607';
    ctx.fillRect(0, 0, THUMB_W, THUMB_H);
    const thumb = getThumbnail(frame);
    setShownFrame(thumb ? thumb.frame : null);
    if (!thumb) return;
    const { bitmap } = thumb;
    const scale = Math.min(THUMB_W / bitmap.width, THUMB_H / bitmap.height);
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    ctx.drawImage(bitmap, (THUMB_W - w) / 2, (THUMB_H - h) / 2, w, h);
  }, [frame]);

  const left = Math.round(Math.min(Math.max(8, anchor.left + x - BOX_W / 2), window.innerWidth - BOX_W - 8));
  const showNote = shownFrame !== null && shownFrame !== frame;
  const top = Math.round(Math.max(8, anchor.top - BOX_H - (showNote ? NOTE_H : 0) - 6));

  return createPortal(
    <div className="wb-preview" style={{ left, top, width: BOX_W }} aria-hidden>
      <canvas ref={canvasRef} style={{ width: THUMB_W, height: THUMB_H }} />
      <div className="wb-preview-text">
        <span>{t('timeline.hoverFrame', { frame })}</span>
        <span className="u-mono">{formatTimecode(timeUs)}</span>
      </div>
      {showNote ? (
        <div className="wb-preview-note" data-testid="hover-preview-keyframe">
          {t('timeline.hoverKeyframe', { frame: shownFrame })}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
