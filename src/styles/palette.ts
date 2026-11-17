/**
 * 12-colour categorical palette for phases, tuned for the graphite background:
 * similar lightness (so no phase looks "more important"), distinct hues, and no
 * hue close to the cyan UI accent so selection/playhead never read as a phase.
 * Mirrors --phase-1 … --phase-12 in tokens.css.
 */
export const PHASE_PALETTE: readonly string[] = [
  '#e5675b', // coral
  '#ec9a46', // orange
  '#dcc24c', // ochre
  '#9ccb5a', // lime
  '#4bb57a', // green
  '#33a596', // teal
  '#5b9cf0', // blue
  '#8c7ef0', // violet
  '#c06ad6', // purple
  '#e26aa4', // pink
  '#b38a62', // umber
  '#98a3af', // slate
];

/** Palette colour for the n-th phase (wraps around). */
export function phaseColor(index: number): string {
  const n = PHASE_PALETTE.length;
  return PHASE_PALETTE[((Math.trunc(index) % n) + n) % n];
}

function channel(hex: string, offset: number): number {
  const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Near-black or near-white text, whichever contrasts better with a '#rrggbb' fill. */
export function readableTextOn(hex: string): '#101214' | '#f4f5f6' {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return '#f4f5f6';
  const l = 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
  return l > 0.22 ? '#101214' : '#f4f5f6';
}
