/**
 * Reads the frame-number barcode drawn by scripts/gen-videos.mjs from RGBA pixels.
 * `rect` is the region of the canvas where the video frame is drawn (letterbox excluded).
 * Returns the frame number, or null when the guards/checksum do not validate.
 */
export const BAR_CELLS = 24;
export const BAR_H_FRAC = 0.1;

export interface Rect { x: number; y: number; w: number; h: number }

export function decodeBarcode(data: Uint8ClampedArray, width: number, rect: Rect): number | null {
  const cellW = rect.w / BAR_CELLS;
  const y = Math.floor(rect.y + rect.h * BAR_H_FRAC * 0.5);
  const lum = (x: number) => {
    // average a small horizontal window at the cell centre
    let s = 0;
    let c = 0;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const px = Math.max(0, Math.min(width - 1, Math.round(x + dx)));
        const o = ((y + dy) * width + px) * 4;
        s += 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
        c++;
      }
    }
    return s / c;
  };
  const bits: number[] = [];
  for (let i = 0; i < BAR_CELLS; i++) bits.push(lum(rect.x + (i + 0.5) * cellW) > 128 ? 1 : 0);
  if (bits[0] !== 1 || bits[1] !== 0) return null;
  let n = 0;
  for (let i = 2; i < 22; i++) n = n * 2 + bits[i];
  const check = bits[22] * 2 + bits[23];
  if (check !== n % 4) return null;
  return n;
}

/** Letterboxed content rectangle for a video of size (vw, vh) drawn into a canvas (cw, ch). */
export function containRect(cw: number, ch: number, vw: number, vh: number): Rect {
  const s = Math.min(cw / vw, ch / vh);
  const w = vw * s;
  const h = vh * s;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}
