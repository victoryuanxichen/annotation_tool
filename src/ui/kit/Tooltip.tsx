import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Kbd } from './Kbd';
import { placeFloating, type Placement, type Point } from './internal';

const SHOW_DELAY_MS = 400;
/** After a tooltip hides, neighbours show instantly for this long (scanning a toolbar). */
const WARM_WINDOW_MS = 500;
let lastHiddenAt = 0;

export interface TooltipProps {
  content: ReactNode;
  /** Keyboard shortcut shown as key caps after the content. */
  kbd?: string;
  placement?: Extract<Placement, 'top' | 'bottom' | 'left' | 'right'>;
  disabled?: boolean;
  /**
   * Link the tooltip to the child with aria-describedby. Turn off when the tooltip only
   * repeats the child's accessible name (e.g. IconButton).
   */
  describe?: boolean;
  /** A single element; it must forward DOM events (any intrinsic element or kit control does). */
  children: ReactElement;
}

/** Small delayed tooltip for hover and keyboard focus. Hides on press, Esc, and scroll. */
export function Tooltip({
  content,
  kbd,
  placement = 'top',
  disabled = false,
  describe = true,
  children,
}: TooltipProps): ReactElement {
  const id = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Point | null>(null);

  const clearTimer = (): void => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  };

  const show = useCallback(() => {
    if (disabled) return;
    clearTimer();
    const warm = performance.now() - lastHiddenAt < WARM_WINDOW_MS;
    if (warm) setOpen(true);
    else timer.current = window.setTimeout(() => setOpen(true), SHOW_DELAY_MS);
  }, [disabled]);

  const hide = useCallback(() => {
    clearTimer();
    setOpen((was) => {
      if (was) lastHiddenAt = performance.now();
      return false;
    });
    setPos(null);
  }, []);

  useEffect(() => () => clearTimer(), []);
  useEffect(() => {
    if (disabled) hide();
  }, [disabled, hide]);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = wrapRef.current?.firstElementChild;
    const tip = tipRef.current;
    if (!anchor || !tip) return;
    setPos(placeFloating(anchor.getBoundingClientRect(), tip.offsetWidth, tip.offsetHeight, placement));
  }, [open, placement, content, kbd]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, [open, hide]);

  const child =
    describe && open && isValidElement<Record<string, unknown>>(children)
      ? cloneElement(children, { 'aria-describedby': id })
      : children;

  return (
    <span
      ref={wrapRef}
      className="ui-tooltip-anchor"
      onMouseEnter={show}
      onMouseLeave={hide}
      onPointerDown={hide}
      onFocus={(e) => {
        if (e.target instanceof Element && e.target.matches(':focus-visible')) show();
      }}
      onBlur={hide}
    >
      {child}
      {open
        ? createPortal(
            <div
              ref={tipRef}
              id={id}
              role="tooltip"
              className="ui-tooltip"
              data-placed={pos ? '' : undefined}
              style={pos ? { left: pos.x, top: pos.y } : { left: -9999, top: -9999 }}
            >
              <span className="ui-tooltip__text">{content}</span>
              {kbd ? <Kbd keys={kbd} className="ui-tooltip__kbd" /> : null}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
