import { useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { cx } from './internal';

const ELLIPSIS = '…';
let measureCtx: CanvasRenderingContext2D | null = null;

function measurer(font: string): (s: string) => number {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  const ctx = measureCtx;
  if (!ctx) return (s) => s.length * 7;
  ctx.font = font;
  return (s) => ctx.measureText(s).width;
}

/**
 * Keeps `keep` characters of `text` around a middle ellipsis. While possible the final path
 * segment (the file name) stays whole; otherwise the split follows `tailRatio`.
 */
export function middleTruncate(text: string, keep: number, tailRatio = 0.6): string {
  if (keep >= text.length) return text;
  if (keep <= 0) return ELLIPSIS;
  const base = text.length - Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')) - 1;
  const minHead = 4;
  const tail = keep - minHead >= base ? Math.max(base, Math.ceil(keep * tailRatio)) : Math.ceil(keep * tailRatio);
  const head = Math.max(0, keep - tail);
  return text.slice(0, head) + ELLIPSIS + text.slice(text.length - tail);
}

/** Largest truncation of `text` whose measured width fits `available`. */
export function fitMiddle(text: string, available: number, measure: (s: string) => number, tailRatio?: number): string {
  if (measure(text) <= available) return text;
  let lo = 0;
  let hi = text.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(middleTruncate(text, mid, tailRatio)) <= available) lo = mid;
    else hi = mid - 1;
  }
  return middleTruncate(text, lo, tailRatio);
}

export interface MiddleEllipsisProps {
  text: string;
  /** Hover title; defaults to the full text. */
  title?: string;
  tailRatio?: number;
  className?: string;
}

/** Single-line text truncated in the middle (paths keep their file name); full text in the title. */
export function MiddleEllipsis({ text, title, tailRatio, className }: MiddleEllipsisProps): ReactElement {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = (): void => {
      // The hidden sizer holds the full text: if the DOM lays it out without overflow it fits,
      // whatever canvas measurement says (the two differ by sub-pixel amounts).
      const sizer = el.firstElementChild;
      if (sizer instanceof HTMLElement && sizer.scrollWidth <= sizer.clientWidth) {
        setShown(text);
        return;
      }
      const style = getComputedStyle(el);
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      // 1 px slack: canvas and DOM text widths differ by sub-pixel amounts.
      setShown(fitMiddle(text, el.clientWidth - 1, measurer(font), tailRatio));
    };
    update();
    void document.fonts?.ready.then(update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    document.fonts?.addEventListener('loadingdone', update);
    return () => {
      ro.disconnect();
      document.fonts?.removeEventListener('loadingdone', update);
    };
  }, [text, tailRatio]);

  return (
    <span ref={ref} className={cx('ui-mid', className)} title={title ?? text}>
      <span className="ui-mid__sizer" aria-hidden>
        {text}
      </span>
      <span aria-hidden>{shown}</span>
      <span className="u-sr-only">{text}</span>
    </span>
  );
}
