import { create } from 'zustand';

/**
 * Visible window of the timeline on the media time axis (µs). Shared by the timeline canvas and
 * the zoom controls in the transport bar. Pixels map to time linearly; frames are found with
 * `frameAtUs`, so variable-frame-rate videos are drawn at their true timestamps.
 */
export interface TimelineView {
  /** Identity of the configured video; a new key resets the view to the whole video. */
  key: string | null;
  domainStartUs: number;
  domainEndUs: number;
  /** Smallest span: about 12 px per (average) frame. */
  minSpanUs: number;
  startUs: number;
  spanUs: number;
  widthPx: number;
  /** Average frame duration, used only for zoom limits and tick density. */
  frameUs: number;
  configure(key: string | null, domainStartUs: number, domainEndUs: number, frameCount: number): void;
  setWidth(widthPx: number): void;
  /** factor > 1 zooms in; the time under `anchorUs` keeps its screen position. */
  zoomAt(factor: number, anchorUs: number): void;
  fit(): void;
  setStart(startUs: number): void;
  panPx(dx: number): void;
}

export const PX_PER_FRAME_MAX = 12;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

type Geometry = Pick<TimelineView, 'domainStartUs' | 'domainEndUs' | 'minSpanUs' | 'startUs' | 'spanUs'>;

function clampView(g: Geometry, startUs: number, spanUs: number): { startUs: number; spanUs: number } {
  const full = Math.max(1, g.domainEndUs - g.domainStartUs);
  const span = clamp(spanUs, Math.min(g.minSpanUs, full), full);
  const start = clamp(startUs, g.domainStartUs, g.domainEndUs - span);
  return { startUs: start, spanUs: span };
}

function minSpan(frameUs: number, widthPx: number): number {
  return Math.max(1, (widthPx / PX_PER_FRAME_MAX) * frameUs);
}

export const useTimelineView = create<TimelineView>((set, get) => ({
  key: null,
  domainStartUs: 0,
  domainEndUs: 1,
  minSpanUs: 1,
  startUs: 0,
  spanUs: 1,
  widthPx: 800,
  frameUs: 1,

  configure(key, domainStartUs, domainEndUs, frameCount) {
    const s = get();
    const end = Math.max(domainStartUs + 1, domainEndUs);
    const frameUs = frameCount > 0 ? (end - domainStartUs) / frameCount : 1;
    const geometry = { domainStartUs, domainEndUs: end, minSpanUs: minSpan(frameUs, s.widthPx) };
    if (key !== s.key) {
      set({ key, frameUs, ...geometry, startUs: domainStartUs, spanUs: end - domainStartUs });
      return;
    }
    set({ frameUs, ...geometry, ...clampView({ ...s, ...geometry }, s.startUs, s.spanUs) });
  },

  setWidth(widthPx) {
    const s = get();
    if (widthPx <= 0 || widthPx === s.widthPx) return;
    const minSpanUs = minSpan(s.frameUs, widthPx);
    set({ widthPx, minSpanUs, ...clampView({ ...s, minSpanUs }, s.startUs, s.spanUs) });
  },

  zoomAt(factor, anchorUs) {
    const s = get();
    if (!(factor > 0)) return;
    const ratio = s.spanUs > 0 ? (anchorUs - s.startUs) / s.spanUs : 0.5;
    const spanUs = s.spanUs / factor;
    const next = clampView(s, 0, spanUs);
    set(clampView(s, anchorUs - ratio * next.spanUs, next.spanUs));
  },

  fit() {
    const s = get();
    set({ startUs: s.domainStartUs, spanUs: s.domainEndUs - s.domainStartUs });
  },

  setStart(startUs) {
    const s = get();
    set(clampView(s, startUs, s.spanUs));
  },

  panPx(dx) {
    const s = get();
    set(clampView(s, s.startUs + (dx / Math.max(1, s.widthPx)) * s.spanUs, s.spanUs));
  },
}));

/** How many times the whole video is magnified (1 = whole video visible). */
export function zoomFactor(v: Pick<TimelineView, 'domainStartUs' | 'domainEndUs' | 'spanUs'>): number {
  return (v.domainEndUs - v.domainStartUs) / Math.max(1, v.spanUs);
}
