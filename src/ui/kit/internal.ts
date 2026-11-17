/** Joins truthy class names. */
export function cx(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

/** Tabbable descendants in DOM order, excluding hidden ones. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('inert') && el.getClientRects().length > 0,
  );
}

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? navigator.platform ?? '';
  return /mac|iphone|ipad/i.test(platform);
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export type Placement = 'top' | 'bottom' | 'left' | 'right' | 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';

export interface Point {
  x: number;
  y: number;
}

const VIEWPORT_MARGIN = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function rawPosition(anchor: DOMRect, w: number, h: number, placement: Placement, gap: number): Point {
  switch (placement) {
    case 'top':
      return { x: anchor.left + anchor.width / 2 - w / 2, y: anchor.top - gap - h };
    case 'bottom':
      return { x: anchor.left + anchor.width / 2 - w / 2, y: anchor.bottom + gap };
    case 'left':
      return { x: anchor.left - gap - w, y: anchor.top + anchor.height / 2 - h / 2 };
    case 'right':
      return { x: anchor.right + gap, y: anchor.top + anchor.height / 2 - h / 2 };
    case 'bottom-start':
      return { x: anchor.left, y: anchor.bottom + gap };
    case 'bottom-end':
      return { x: anchor.right - w, y: anchor.bottom + gap };
    case 'top-start':
      return { x: anchor.left, y: anchor.top - gap - h };
    case 'top-end':
      return { x: anchor.right - w, y: anchor.top - gap - h };
  }
}

const FLIP: Readonly<Record<Placement, Placement>> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
  'bottom-start': 'top-start',
  'bottom-end': 'top-end',
  'top-start': 'bottom-start',
  'top-end': 'bottom-end',
};

function overflows(p: Point, w: number, h: number): boolean {
  return (
    p.y < VIEWPORT_MARGIN ||
    p.y + h > window.innerHeight - VIEWPORT_MARGIN ||
    p.x < VIEWPORT_MARGIN ||
    p.x + w > window.innerWidth - VIEWPORT_MARGIN
  );
}

/** Fixed-position coordinates for a floating box, flipped to the opposite side and clamped to the viewport. */
export function placeFloating(anchor: DOMRect, w: number, h: number, placement: Placement, gap = 6): Point {
  let p = rawPosition(anchor, w, h, placement, gap);
  if (overflows(p, w, h)) {
    const flipped = rawPosition(anchor, w, h, FLIP[placement], gap);
    if (!overflows(flipped, w, h)) p = flipped;
  }
  return {
    x: Math.round(clamp(p.x, VIEWPORT_MARGIN, window.innerWidth - w - VIEWPORT_MARGIN)),
    y: Math.round(clamp(p.y, VIEWPORT_MARGIN, window.innerHeight - h - VIEWPORT_MARGIN)),
  };
}
