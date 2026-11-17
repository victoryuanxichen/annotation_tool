/** Canvas drawing for the timeline. Pure functions of a model; no React. */
import { formatTimecode } from '../../../i18n';
import { frameAtUs, type FrameIndex } from '../../../core/mp4';
import { readableTextOn } from '../../../styles/palette';
import { boundaryTime } from '../../hooks';

/** Vertical layout in CSS px. */
export const LAYOUT = {
  rulerH: 28,
  laneY: 32,
  laneH: 28,
  ovY: 66,
  ovH: 8,
  height: 78,
} as const;

export interface TimelineColors {
  bg: string;
  well: string;
  line: string;
  lineStrong: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  danger: string;
  mono: string;
  sans: string;
}

export function readColors(el: Element): TimelineColors {
  const s = getComputedStyle(el);
  const v = (name: string, fallback: string): string => s.getPropertyValue(name).trim() || fallback;
  return {
    bg: v('--c-bg', '#16181b'),
    well: v('--c-well', '#0f1113'),
    line: v('--c-line', '#2c3036'),
    lineStrong: v('--c-line-strong', '#3a4048'),
    text: v('--c-text', '#e6e8eb'),
    muted: v('--c-text-muted', '#9aa1a9'),
    faint: v('--c-text-faint', '#737b84'),
    accent: v('--c-accent', '#4cc3e0'),
    danger: v('--c-danger', '#ee6b5d'),
    mono: v('--font-mono', 'monospace'),
    sans: v('--font-sans', 'sans-serif'),
  };
}

export interface DrawSegment {
  id: string;
  start: number;
  end: number;
  color: string;
  label: string;
  selected: boolean;
  issue: boolean;
}

export interface TimelineModel {
  index: FrameIndex | null;
  width: number;
  startUs: number;
  spanUs: number;
  domainStartUs: number;
  domainEndUs: number;
  segments: readonly DrawSegment[];
  pendingStart: number | null;
  displayedFrame: number | null;
  requestedFrame: number | null;
  hoverX: number | null;
  /** Boundary being dragged (preview until the controller confirms it). */
  dragBoundary: number | null;
}

/** Below this many px per frame the ruler is labelled by time, above it by frame number. */
export const FRAME_MODE_PX = 5;

const TIME_STEPS: ReadonlyArray<readonly [major: number, minor: number]> = [
  [0.05, 0.01],
  [0.1, 0.02],
  [0.2, 0.05],
  [0.5, 0.1],
  [1, 0.2],
  [2, 0.5],
  [5, 1],
  [10, 2],
  [15, 5],
  [30, 5],
  [60, 10],
  [120, 30],
  [300, 60],
  [600, 120],
  [900, 300],
  [1800, 300],
  [3600, 600],
  [7200, 1800],
  [14400, 3600],
];
const FRAME_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];

function shortTimecode(us: number, keepMs: boolean, hideHours: boolean): string {
  let text = formatTimecode(us);
  if (!keepMs) text = text.slice(0, -4);
  return hideHours && text.startsWith('00:') ? text.slice(3) : text;
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? '' : `${text.slice(0, lo)}…`;
}

let hatchCache: { color: string; pattern: CanvasPattern | null } | null = null;

function hatch(ctx: CanvasRenderingContext2D, color: string): CanvasPattern | null {
  if (hatchCache?.color === color) return hatchCache.pattern;
  const tile = document.createElement('canvas');
  tile.width = 8;
  tile.height = 8;
  const t = tile.getContext('2d');
  if (!t) return null;
  t.strokeStyle = color;
  t.lineWidth = 2;
  t.beginPath();
  t.moveTo(-2, 10);
  t.lineTo(10, -2);
  t.moveTo(6, 10);
  t.lineTo(10, 6);
  t.moveTo(-2, 2);
  t.lineTo(2, -2);
  t.stroke();
  hatchCache = { color, pattern: ctx.createPattern(tile, 'repeat') };
  return hatchCache.pattern;
}

function drawRuler(
  ctx: CanvasRenderingContext2D,
  m: TimelineModel,
  index: FrameIndex,
  c: TimelineColors,
  x: (us: number) => number,
): void {
  const w = m.width;
  const rulerH = LAYOUT.rulerH;
  const pxPerUs = w / m.spanUs;
  const frameUs = (m.domainEndUs - m.domainStartUs) / index.frameCount;
  const framePx = frameUs * pxPerUs;
  const hideHours = m.domainEndUs < 3600e6;
  ctx.font = `10px ${c.mono}`;
  ctx.textBaseline = 'alphabetic';

  if (framePx >= FRAME_MODE_PX) {
    const k = FRAME_STEPS.find((s) => s * framePx >= 76) ?? FRAME_STEPS[FRAME_STEPS.length - 1];
    const f0 = frameAtUs(index, m.startUs);
    const f1 = frameAtUs(index, m.startUs + m.spanUs);
    for (let f = f0; f <= f1; f += 1) {
      const fx = Math.round(x(index.ptsUs[f])) + 0.5;
      const major = f % k === 0;
      ctx.fillStyle = major ? '#4a515a' : c.lineStrong;
      ctx.fillRect(fx - 0.5, rulerH - (major ? 9 : 4), 1, major ? 9 : 4);
      if (!major) continue;
      ctx.fillStyle = c.muted;
      ctx.fillText(String(f), fx + 3, 10);
      ctx.fillStyle = c.faint;
      ctx.fillText(shortTimecode(index.ptsUs[f], true, hideHours), fx + 3, 20);
    }
    return;
  }

  const [majorS, minorS] = TIME_STEPS.find(([s]) => s * 1e6 * pxPerUs >= 72) ?? TIME_STEPS[TIME_STEPS.length - 1];
  const majorUs = majorS * 1e6;
  const minorUs = minorS * 1e6;
  const showMinor = minorUs * pxPerUs >= 6;
  const step = showMinor ? minorUs : majorUs;
  const first = Math.floor(m.startUs / step) * step;
  const end = m.startUs + m.spanUs;
  for (let us = first; us <= end; us += step) {
    const tx = Math.round(x(us)) + 0.5;
    if (tx < -1) continue;
    const major = Math.abs(us / majorUs - Math.round(us / majorUs)) < 1e-6;
    ctx.fillStyle = major ? '#4a515a' : c.lineStrong;
    ctx.fillRect(tx - 0.5, rulerH - (major ? 9 : 4), 1, major ? 9 : 4);
    if (major) {
      ctx.fillStyle = c.faint;
      ctx.fillText(shortTimecode(Math.round(us), majorS < 1, hideHours), tx + 3, 12);
    }
  }
}

function drawSegments(
  ctx: CanvasRenderingContext2D,
  m: TimelineModel,
  index: FrameIndex,
  c: TimelineColors,
  x: (us: number) => number,
): void {
  const { laneY, laneH } = LAYOUT;
  ctx.font = `500 11px ${c.sans}`;
  ctx.textBaseline = 'middle';
  let selected: { x0: number; x1: number } | null = null;
  for (const seg of m.segments) {
    const x0 = x(boundaryTime(index, seg.start));
    const x1 = x(boundaryTime(index, seg.end));
    if (x1 < -2 || x0 > m.width + 2) continue;
    const left = Math.round(Math.max(-2, x0));
    const right = Math.round(Math.min(m.width + 2, x1));
    const width = Math.max(1, right - left - (right - left > 3 ? 1 : 0));
    ctx.fillStyle = seg.color;
    ctx.fillRect(left, laneY, width, laneH);
    ctx.fillStyle = 'rgb(0 0 0 / 0.2)';
    ctx.fillRect(left, laneY, width, laneH);
    if (seg.issue) {
      const pattern = hatch(ctx, c.danger);
      if (pattern) {
        ctx.fillStyle = pattern;
        ctx.fillRect(left, laneY, width, laneH);
      }
      ctx.strokeStyle = c.danger;
      ctx.lineWidth = 1;
      ctx.strokeRect(left + 0.5, laneY + 0.5, width - 1, laneH - 1);
    }
    if (width > 28) {
      const textX = Math.max(left, 0) + 6;
      const room = Math.min(right, m.width) - textX - 4;
      const text = room > 12 ? fitText(ctx, seg.label, room) : '';
      if (text) {
        ctx.fillStyle = readableTextOn(seg.color);
        ctx.fillText(text, textX, laneY + laneH / 2 + 0.5);
      }
    }
    if (seg.selected) selected = { x0: left, x1: left + width };
  }
  if (selected) {
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(selected.x0 - 1, laneY - 2, selected.x1 - selected.x0 + 2, laneH + 4);
  }
}

function drawOverview(ctx: CanvasRenderingContext2D, m: TimelineModel, index: FrameIndex, c: TimelineColors): void {
  const { ovY, ovH } = LAYOUT;
  const full = m.domainEndUs - m.domainStartUs;
  const ox = (us: number): number => ((us - m.domainStartUs) / full) * m.width;
  ctx.fillStyle = c.well;
  ctx.fillRect(0, ovY, m.width, ovH);
  ctx.globalAlpha = 0.75;
  for (const seg of m.segments) {
    const x0 = ox(boundaryTime(index, seg.start));
    const x1 = ox(boundaryTime(index, seg.end));
    ctx.fillStyle = seg.color;
    ctx.fillRect(x0, ovY + 2, Math.max(1, x1 - x0), ovH - 4);
  }
  ctx.globalAlpha = 1;
  const wx0 = ox(m.startUs);
  const ww = Math.max(6, ox(m.startUs + m.spanUs) - wx0);
  ctx.fillStyle = 'rgb(154 161 169 / 0.28)';
  ctx.fillRect(wx0, ovY, ww, ovH);
  ctx.strokeStyle = 'rgb(154 161 169 / 0.65)';
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(wx0) + 0.5, ovY + 0.5, Math.round(ww) - 1, ovH - 1);
  if (m.displayedFrame !== null) {
    ctx.fillStyle = c.accent;
    ctx.fillRect(Math.round(ox(index.ptsUs[m.displayedFrame])), ovY, 1, ovH);
  }
}

export function drawTimeline(ctx: CanvasRenderingContext2D, m: TimelineModel, c: TimelineColors): void {
  const { rulerH, laneY, laneH, ovY } = LAYOUT;
  const w = m.width;
  ctx.clearRect(0, 0, w, LAYOUT.height);
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, w, LAYOUT.height);
  ctx.fillStyle = c.line;
  ctx.fillRect(0, rulerH, w, 1);
  ctx.fillStyle = 'rgb(255 255 255 / 0.018)';
  ctx.fillRect(0, laneY, w, laneH);

  const index = m.index;
  if (!index || index.frameCount === 0 || m.spanUs <= 0) return;
  const x = (us: number): number => ((us - m.startUs) / m.spanUs) * w;
  const n = index.frameCount;
  const frameX = (f: number): number => x(boundaryTime(index, f));

  drawRuler(ctx, m, index, c, x);
  drawSegments(ctx, m, index, c, x);

  // Pending start: marker line plus a faint span up to the playhead.
  if (m.pendingStart !== null && m.pendingStart >= 0 && m.pendingStart <= n) {
    const px = Math.round(frameX(m.pendingStart));
    if (m.displayedFrame !== null && m.displayedFrame > m.pendingStart) {
      const hx = frameX(m.displayedFrame);
      ctx.fillStyle = 'rgb(230 232 235 / 0.08)';
      ctx.fillRect(px, rulerH - 2, hx - px, laneY + laneH - rulerH + 4);
    }
    ctx.fillStyle = c.text;
    ctx.fillRect(px - 1, rulerH - 2, 2, laneY + laneH - rulerH + 4);
    ctx.fillRect(px - 1, rulerH - 4, 9, 2);
  }

  if (m.hoverX !== null) {
    ctx.fillStyle = 'rgb(230 232 235 / 0.28)';
    ctx.fillRect(Math.round(m.hoverX), 0, 1, laneY + laneH);
  }

  if (m.dragBoundary !== null) {
    const bx = Math.round(frameX(m.dragBoundary));
    ctx.fillStyle = c.accent;
    ctx.fillRect(bx - 1, laneY - 4, 2, laneH + 8);
    ctx.font = `500 10px ${c.mono}`;
    ctx.textBaseline = 'alphabetic';
    const label = String(m.dragBoundary);
    const tw = ctx.measureText(label).width + 8;
    const lx = Math.min(Math.max(0, bx - tw / 2), w - tw);
    ctx.fillStyle = c.accent;
    ctx.fillRect(lx, 2, tw, 14);
    ctx.fillStyle = '#071519';
    ctx.fillText(label, lx + 4, 12);
  }

  if (m.requestedFrame !== null && m.requestedFrame !== m.displayedFrame && m.requestedFrame < n) {
    const gx = Math.round(frameX(m.requestedFrame)) + 0.5;
    ctx.strokeStyle = 'rgb(76 195 224 / 0.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, laneY + laneH + 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (m.displayedFrame !== null && m.displayedFrame < n) {
    const f = m.displayedFrame;
    const hx = frameX(f);
    const hw = frameX(f + 1) - hx;
    if (hw >= 3) {
      ctx.fillStyle = 'rgb(76 195 224 / 0.16)';
      ctx.fillRect(hx, 0, hw, laneY + laneH + 2);
    }
    const lx = Math.round(hx);
    ctx.fillStyle = c.accent;
    ctx.fillRect(lx, 0, 1, ovY - 2);
    ctx.beginPath();
    ctx.moveTo(lx - 5, 0);
    ctx.lineTo(lx + 6, 0);
    ctx.lineTo(lx + 0.5, 6);
    ctx.closePath();
    ctx.fill();
  }

  drawOverview(ctx, m, index, c);
}
