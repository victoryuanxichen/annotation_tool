import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import { frameAtUs, type FrameIndex } from '../../../core/mp4';
import { useT } from '../../../i18n';
import { actions, getPlayer, useApp, usePlayerSnapshot } from '../../app';
import type { Segment } from '../../../core/types';
import { boundaryTime, useFrameIndex } from '../../hooks';
import { LAYOUT, drawTimeline, readColors, type DrawSegment, type TimelineColors, type TimelineModel } from './draw';
import { HoverPreview } from './HoverPreview';
import { useTimelineView } from './view';

const EDGE_HIT_PX = 5;
const CLICK_SLOP_PX = 4;
const UNKNOWN_PHASE_COLOR = '#6b737c';

type Drag =
  | { kind: 'scrub' }
  | { kind: 'click'; segId: string; x0: number }
  | { kind: 'overview'; grabUs: number }
  | { kind: 'edge'; segId: string; which: 'start' | 'end'; origin: number; current: number; min: number; max: number };

type Region = 'ruler' | 'lane' | 'overview';

function regionAt(y: number): Region {
  if (y >= LAYOUT.ovY - 3) return 'overview';
  if (y >= LAYOUT.laneY - 2) return 'lane';
  return 'ruler';
}

function viewUsAt(x: number): number {
  const v = useTimelineView.getState();
  return v.startUs + (x / Math.max(1, v.widthPx)) * v.spanUs;
}

function viewXAt(us: number): number {
  const v = useTimelineView.getState();
  return ((us - v.startUs) / v.spanUs) * v.widthPx;
}

function overviewUsAt(x: number): number {
  const v = useTimelineView.getState();
  return v.domainStartUs + (x / Math.max(1, v.widthPx)) * (v.domainEndUs - v.domainStartUs);
}

/** Nearest half-open boundary (0…N) to the time under x. */
function boundaryAtX(index: FrameIndex, x: number): number {
  const t = viewUsAt(x);
  const f = frameAtUs(index, t);
  const next = Math.min(index.frameCount, f + 1);
  return t - boundaryTime(index, f) <= boundaryTime(index, next) - t ? f : next;
}

function edgeAt(index: FrameIndex, segments: readonly Segment[], x: number): { seg: Segment; which: 'start' | 'end' } | null {
  let best: { seg: Segment; which: 'start' | 'end' } | null = null;
  let bestScore = Infinity;
  for (const seg of segments) {
    for (const which of ['start', 'end'] as const) {
      const bx = viewXAt(boundaryTime(index, seg[which]));
      const d = Math.abs(x - bx);
      if (d > EDGE_HIT_PX) continue;
      // On a shared boundary prefer the side the pointer is on.
      const onSide = which === 'end' ? x < bx : x >= bx;
      const score = d + (onSide ? 0 : 0.01);
      if (score < bestScore) {
        bestScore = score;
        best = { seg, which };
      }
    }
  }
  return best;
}

function segmentAt(index: FrameIndex, segments: readonly Segment[], x: number): Segment | null {
  const t = viewUsAt(x);
  return segments.find((s) => boundaryTime(index, s.start) <= t && t < boundaryTime(index, s.end)) ?? null;
}

export function Timeline(): ReactElement {
  const t = useT();
  const index = useFrameIndex();
  const itemId = useApp((s) => s.video.itemId);
  const segments = useApp((s) => s.editor.doc.segments);
  const docPhases = useApp((s) => s.editor.doc.phases);
  const libPhases = useApp((s) => s.library.phases);
  const selectedId = useApp((s) => s.editor.selectedSegmentId);
  const issues = useApp((s) => s.editor.issues);
  const pendingStart = useApp((s) => s.editor.pendingStart);
  const snap = usePlayerSnapshot();
  const view = useTimelineView(
    useShallow((s) => ({ startUs: s.startUs, spanUs: s.spanUs, domainStartUs: s.domainStartUs, domainEndUs: s.domainEndUs })),
  );

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const colorsRef = useRef<TimelineColors | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const rafRef = useRef(0);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ x: number; frame: number } | null>(null);
  const [dragBoundary, setDragBoundary] = useState<number | null>(null);
  const [cursor, setCursor] = useState('default');

  // A new video resets the view to the whole video; a re-index of the same video keeps it.
  useEffect(() => {
    const v = useTimelineView.getState();
    if (!index) v.configure(null, 0, 1, 0);
    else v.configure(itemId, index.ptsUs[0], index.durationUs, index.frameCount);
  }, [index, itemId]);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    colorsRef.current = readColors(el);
    const ro = new ResizeObserver(() => {
      const w = Math.floor(el.clientWidth);
      setWidth(w);
      useTimelineView.getState().setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const drawSegments = useMemo<DrawSegment[]>(() => {
    const flagged = new Set(issues.flatMap((i) => i.segmentIds));
    return segments.map((s) => {
      const phase = libPhases[s.phaseId] ?? docPhases[s.phaseId];
      return {
        id: s.id,
        start: s.start,
        end: s.end,
        color: phase?.color ?? UNKNOWN_PHASE_COLOR,
        label: phase?.name ?? s.phaseId,
        selected: s.id === selectedId,
        issue: flagged.has(s.id),
      };
    });
  }, [segments, libPhases, docPhases, selectedId, issues]);

  const model: TimelineModel = {
    index,
    width,
    ...view,
    segments: drawSegments,
    pendingStart,
    displayedFrame: snap.displayedFrame,
    requestedFrame: snap.requestedFrame,
    hoverX: hover?.x ?? null,
    dragBoundary,
  };
  const modelRef = useRef(model);

  const paint = useCallback(() => {
    rafRef.current = 0;
    const canvas = canvasRef.current;
    const colors = colorsRef.current;
    const m = modelRef.current;
    if (!canvas || !colors || m.width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(m.width * dpr);
    const h = Math.round(LAYOUT.height * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawTimeline(ctx, m, colors);
  }, []);

  // Every render means an input changed: store the model and paint on the next frame.
  useLayoutEffect(() => {
    modelRef.current = model;
    if (!rafRef.current) rafRef.current = requestAnimationFrame(paint);
  });
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  // Keep the playhead in view while playing or stepping (not while the pointer drives it).
  const playing = snap.playing;
  const displayed = snap.displayedFrame;
  useEffect(() => {
    if (displayed === null || !index || dragRef.current || displayed >= index.frameCount) return;
    const v = useTimelineView.getState();
    const t0 = index.ptsUs[displayed];
    const t1 = boundaryTime(index, displayed + 1);
    const end = v.startUs + v.spanUs;
    if (playing) {
      if (t0 < v.startUs || t1 > v.startUs + v.spanUs * 0.95) v.setStart(t0 - v.spanUs * 0.05);
    } else if (t0 < v.startUs || t1 > end) {
      v.setStart(t0 - v.spanUs / 2);
    }
  }, [displayed, playing, index]);

  // Wheel: Ctrl/⌘ zooms at the pointer; otherwise pans. Needs a non-passive listener.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      e.preventDefault();
      const v = useTimelineView.getState();
      if (e.ctrlKey || e.metaKey) {
        const x = e.clientX - el.getBoundingClientRect().left;
        v.zoomAt(Math.exp(-dy * 0.0025), viewUsAt(x));
      } else if (e.shiftKey) {
        v.panPx(dy || dx);
      } else {
        v.panPx(Math.abs(dx) > Math.abs(dy) ? dx : dy);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const local = (e: PointerEvent<HTMLElement>): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(Math.max(0, e.clientX - rect.left), rect.width), y: e.clientY - rect.top };
  };

  const scrubTo = (x: number): void => {
    if (!index) return;
    const frame = frameAtUs(index, viewUsAt(x));
    setHover({ x, frame });
    // Latest seek wins: the player coalesces, so every move simply seeks.
    void getPlayer()?.seek(frame);
  };

  const updateHover = (x: number, y: number): void => {
    if (!index) return;
    const region = regionAt(y);
    if (region === 'overview') {
      setHover(null);
      setCursor('grab');
      return;
    }
    setHover({ x, frame: frameAtUs(index, viewUsAt(x)) });
    if (region === 'lane') {
      if (edgeAt(index, segments, x)) setCursor('ew-resize');
      else setCursor(segmentAt(index, segments, x) ? 'pointer' : 'default');
    } else setCursor('default');
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || !index) return;
    const { x, y } = local(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    const region = regionAt(y);
    if (region === 'overview') {
      const v = useTimelineView.getState();
      const at = overviewUsAt(x);
      const inside = at >= v.startUs && at <= v.startUs + v.spanUs;
      const grabUs = inside ? at - v.startUs : v.spanUs / 2;
      if (!inside) v.setStart(at - grabUs);
      dragRef.current = { kind: 'overview', grabUs };
      setCursor('grabbing');
      return;
    }
    if (region === 'lane') {
      const edge = edgeAt(index, segments, x);
      if (edge) {
        const origin = edge.seg[edge.which];
        const min = edge.which === 'start' ? 0 : edge.seg.start + 1;
        const max = edge.which === 'start' ? edge.seg.end - 1 : index.frameCount;
        dragRef.current = { kind: 'edge', segId: edge.seg.id, which: edge.which, origin, current: origin, min, max };
        setDragBoundary(origin);
        setHover(null);
        return;
      }
      const seg = segmentAt(index, segments, x);
      if (seg) {
        dragRef.current = { kind: 'click', segId: seg.id, x0: x };
        return;
      }
    }
    dragRef.current = { kind: 'scrub' };
    scrubTo(x);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const { x, y } = local(e);
    const d = dragRef.current;
    if (!d) {
      updateHover(x, y);
      return;
    }
    if (!index) return;
    switch (d.kind) {
      case 'scrub':
        scrubTo(x);
        break;
      case 'click':
        if (Math.abs(x - d.x0) > CLICK_SLOP_PX) {
          dragRef.current = { kind: 'scrub' };
          scrubTo(x);
        }
        break;
      case 'overview':
        useTimelineView.getState().setStart(overviewUsAt(x) - d.grabUs);
        break;
      case 'edge': {
        const b = Math.min(d.max, Math.max(d.min, boundaryAtX(index, x)));
        if (b !== d.current) {
          d.current = b;
          setDragBoundary(b);
          // Show the first frame after the boundary (the frame the controller will confirm).
          void getPlayer()?.seek(Math.min(b, index.frameCount - 1));
        }
        break;
      }
    }
  };

  const endDrag = (commit: boolean): void => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.kind === 'overview') setCursor('grab');
    if (d.kind === 'click' && commit) actions.selectSegment(d.segId, { seek: true });
    if (d.kind === 'edge') {
      if (commit && d.current !== d.origin) {
        const bounds = d.which === 'start' ? { start: d.current } : { end: d.current };
        void actions.setSegmentBounds(d.segId, bounds, { linkAdjacent: true }).finally(() => setDragBoundary(null));
      } else setDragBoundary(null);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const player = getPlayer();
    if (!player || !index) return;
    const big = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') void player.step(-big);
    else if (e.key === 'ArrowRight') void player.step(big);
    else if (e.key === 'Home') void player.seek(0);
    else if (e.key === 'End') void player.seek(index.frameCount - 1);
    else return;
    e.preventDefault();
  };

  const total = index?.frameCount ?? 0;
  const anchorRect = hover && wrapRef.current ? wrapRef.current.getBoundingClientRect() : null;

  return (
    <div
      ref={wrapRef}
      className="wb-timeline"
      role="slider"
      tabIndex={index ? 0 : -1}
      aria-label={t('timeline.label')}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, total - 1)}
      aria-valuenow={snap.displayedFrame ?? 0}
      aria-valuetext={snap.displayedFrame === null ? undefined : t('player.currentFrame', { frame: snap.displayedFrame, total })}
      aria-disabled={!index || undefined}
      style={{ cursor }}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => endDrag(true)}
      onPointerCancel={() => endDrag(false)}
      onPointerLeave={() => {
        if (!dragRef.current) setHover(null);
      }}
    >
      <canvas ref={canvasRef} className="wb-timeline-canvas" style={{ height: LAYOUT.height }} aria-hidden />
      {hover && anchorRect && index && dragBoundary === null ? (
        <HoverPreview anchor={anchorRect} x={hover.x} frame={hover.frame} timeUs={index.ptsUs[hover.frame]} />
      ) : null}
    </div>
  );
}
