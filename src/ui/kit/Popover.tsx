import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { cx, focusableWithin, placeFloating, type Placement, type Point } from './internal';

export type PopoverCloseReason = 'escape' | 'outside' | 'tab';

export interface PopoverProps {
  open: boolean;
  onClose: (reason: PopoverCloseReason) => void;
  anchorRef: RefObject<HTMLElement | null>;
  placement?: Placement;
  /** Fixed width in px; otherwise sized by content (min 160). */
  width?: number;
  maxHeight?: number;
  role?: 'dialog' | 'menu' | 'listbox';
  'aria-label'?: string;
  /** 'first' focuses the first focusable child; 'none' leaves focus (the caller manages it). */
  initialFocus?: 'first' | 'container' | 'none';
  /** Close when focus tabs out of the popover. */
  closeOnTabOut?: boolean;
  className?: string;
  children: ReactNode;
  id?: string;
}

/**
 * Floating panel anchored to an element. Closes on outside pointer-down (the anchor itself is
 * excluded so it can toggle), Esc (focus returns to the anchor), and optionally Tab-out.
 */
export function Popover(props: PopoverProps): ReactElement | null {
  if (!props.open) return null;
  return createPortal(<PopoverSurface {...props} />, document.body);
}

function PopoverSurface({
  onClose,
  anchorRef,
  placement = 'bottom-start',
  width,
  maxHeight = 360,
  role = 'dialog',
  initialFocus = 'first',
  closeOnTabOut = true,
  className,
  children,
  id,
  ...aria
}: PopoverProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Point | null>(null);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  useLayoutEffect(() => {
    const place = (): void => {
      const anchor = anchorRef.current;
      const el = ref.current;
      if (!anchor || !el) return;
      setPos(placeFloating(anchor.getBoundingClientRect(), el.offsetWidth, el.offsetHeight, placement, 4));
    };
    place();
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchorRef, placement]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (initialFocus === 'first') (focusableWithin(el)[0] ?? el).focus({ preventScroll: true });
    else if (initialFocus === 'container') el.focus({ preventScroll: true });
  }, [initialFocus]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node | null;
      if (!target || ref.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onCloseRef.current('outside');
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [anchorRef]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current('escape');
      anchorRef.current?.focus();
    } else if (e.key === 'Tab' && closeOnTabOut && ref.current) {
      const items = focusableWithin(ref.current);
      const atEdge = e.shiftKey ? document.activeElement === items[0] : document.activeElement === items[items.length - 1];
      if (items.length === 0 || atEdge) {
        e.preventDefault();
        onCloseRef.current('tab');
        anchorRef.current?.focus();
      }
    }
  };

  const style: CSSProperties = {
    left: pos?.x ?? -9999,
    top: pos?.y ?? -9999,
    width,
    maxHeight,
    // Hidden with opacity rather than visibility until placed: a visibility:hidden subtree
    // cannot take focus, and callers (Menu, initialFocus) focus a child on open.
    opacity: pos ? undefined : 0,
    pointerEvents: pos ? undefined : 'none',
  };

  return (
    <div
      ref={ref}
      id={id}
      role={role}
      aria-label={aria['aria-label']}
      tabIndex={-1}
      className={cx('ui-popover', className)}
      style={style}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}
