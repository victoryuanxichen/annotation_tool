const MAX_BITMAP_WIDTH = 1920;
const MAX_BACKING_PX = 8192;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * Draws bitmaps letterboxed into a canvas whose backing store tracks its CSS size × devicePixelRatio.
 * The canvas must get its size from CSS (e.g. width/height 100%), not from its attributes.
 */
export class CanvasRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly observer: ResizeObserver | null;
  private video: Size = { width: 16, height: 9 };
  private current: ImageBitmap | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onResized: () => void = () => {},
    private readonly background = '#000',
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => this.onResize(entries));
    this.observer?.observe(canvas, { box: 'content-box' });
    this.syncSizeNow();
    this.fill();
  }

  setVideoSize(width: number, height: number): void {
    this.video = { width: Math.max(1, width), height: Math.max(1, height) };
  }

  /** Size for decoded-frame bitmaps: the letterboxed content area in device pixels, never upscaled. */
  bitmapSize(): Size {
    const { width: vw, height: vh } = this.video;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    let w = vw;
    if (cw > 1 && ch > 1) w = Math.min(vw, letterbox(cw, ch, vw, vh).w);
    w = Math.min(w, MAX_BITMAP_WIDTH);
    const width = Math.max(1, Math.round(w));
    const height = Math.max(1, Math.round((width * vh) / vw));
    return { width, height };
  }

  draw(bitmap: ImageBitmap): void {
    this.current = bitmap;
    this.paint();
  }

  /** Forgets the current bitmap (it may be closed afterwards) and blanks the canvas. */
  clear(): void {
    this.current = null;
    this.fill();
  }

  dispose(): void {
    this.observer?.disconnect();
    this.current = null;
  }

  private paint(): void {
    this.fill();
    const bmp = this.current;
    if (!bmp) return;
    const r = this.contentRect();
    this.ctx.imageSmoothingQuality = 'high';
    this.ctx.drawImage(bmp, r.x, r.y, r.w, r.h);
  }

  private contentRect(): Rect {
    const r = letterbox(this.canvas.width, this.canvas.height, this.video.width, this.video.height);
    const x = Math.round(r.x);
    const y = Math.round(r.y);
    return { x, y, w: Math.round(r.x + r.w) - x, h: Math.round(r.y + r.h) - y };
  }

  private fill(): void {
    this.ctx.fillStyle = this.background;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private onResize(entries: ResizeObserverEntry[]): void {
    const entry = entries[entries.length - 1];
    if (!entry) return;
    const { width, height } = backingSize(entry);
    this.resize(width, height);
  }

  /** Sizes the backing store before the first ResizeObserver callback so early frames are sharp. */
  private syncSizeNow(): void {
    const r = this.canvas.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    const dpr = window.devicePixelRatio || 1;
    this.resize(Math.round(r.width * dpr), Math.round(r.height * dpr), false);
  }

  private resize(rawWidth: number, rawHeight: number, notify = true): void {
    // Cap guards against a feedback loop when the canvas is not sized by CSS.
    const width = Math.min(MAX_BACKING_PX, rawWidth);
    const height = Math.min(MAX_BACKING_PX, rawHeight);
    if (width === this.canvas.width && height === this.canvas.height) return;
    // Assigning width/height clears the canvas, so repaint right away.
    this.canvas.width = width;
    this.canvas.height = height;
    this.paint();
    if (notify) this.onResized();
  }
}

function backingSize(entry: ResizeObserverEntry): Size {
  const device = entry.devicePixelContentBoxSize?.[0];
  if (device) return { width: Math.max(1, device.inlineSize), height: Math.max(1, device.blockSize) };
  const dpr = window.devicePixelRatio || 1;
  return {
    width: Math.max(1, Math.round(entry.contentRect.width * dpr)),
    height: Math.max(1, Math.round(entry.contentRect.height * dpr)),
  };
}

/** Largest rectangle with the video's aspect ratio centred in (cw, ch). Same math as the test barcode reader. */
export function letterbox(cw: number, ch: number, vw: number, vh: number): Rect {
  const s = Math.min(cw / vw, ch / vh);
  const w = vw * s;
  const h = vh * s;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}
