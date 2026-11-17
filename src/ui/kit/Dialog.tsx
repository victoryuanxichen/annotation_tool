import {
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n';
import { Icon, type IconName } from '../icons';
import { IconButton } from './Button';
import { cx, focusableWithin } from './internal';

let openModals = 0;

/** True while any kit Dialog is open — global shortcut handlers should stand down. */
export function isModalOpen(): boolean {
  return openModals > 0;
}

function trackModal(delta: 1 | -1): void {
  openModals = Math.max(0, openModals + delta);
  if (openModals > 0) document.body.dataset.modalOpen = 'true';
  else delete document.body.dataset.modalOpen;
}

export type DialogSize = 'sm' | 'md' | 'lg';
export type DialogTone = 'default' | 'warning' | 'danger';

export interface DialogProps {
  open: boolean;
  /** Called on Esc, backdrop click and the close button (only when `dismissible`). */
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  size?: DialogSize;
  /** Adds a leading state icon to the title; does not colour the dialog. */
  tone?: DialogTone;
  /** Footer actions, right-aligned; put the primary action last. */
  footer?: ReactNode;
  /** Content aligned to the start of the footer (e.g. a note). */
  footerNote?: ReactNode;
  /** Element to focus on open; defaults to the first focusable element in the body/footer. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** When false, Esc/backdrop/close button do nothing (decision dialogs). */
  dismissible?: boolean;
  className?: string;
  children?: ReactNode;
  'data-testid'?: string;
}

const TONE_ICON: Readonly<Record<Exclude<DialogTone, 'default'>, IconName>> = {
  warning: 'warning',
  danger: 'alert',
};

/**
 * Modal dialog: portal + scrim, aria-modal, focus trap (Tab cycles), Esc closes, focus
 * returns to the previously focused element on close.
 */
export function Dialog(props: DialogProps): ReactElement | null {
  if (!props.open) return null;
  return createPortal(<DialogSurface {...props} />, document.body);
}

function DialogSurface({
  onClose,
  title,
  description,
  size = 'md',
  tone = 'default',
  footer,
  footerNote,
  initialFocusRef,
  dismissible = true,
  className,
  children,
  'data-testid': testId,
}: DialogProps): ReactElement {
  const t = useT();
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);

  useLayoutEffect(() => {
    returnTo.current = document.activeElement;
    trackModal(1);
    const panel = panelRef.current;
    if (panel) {
      const target =
        initialFocusRef?.current ??
        focusableWithin(panel).find((el) => !el.closest('.ui-dialog__head')) ??
        panel;
      target.focus();
    }
    return () => {
      trackModal(-1);
      const prev = returnTo.current;
      if (prev instanceof HTMLElement && prev.isConnected) prev.focus();
    };
    // Mount/unmount only: focus is placed once when the dialog opens.
  }, []);

  // Keep a pointer-down-then-drag that ends on the scrim from closing the dialog.
  const downOnScrim = useRef(false);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const panel = panelRef.current;
    if (!panel) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      if (dismissible) onClose();
      return;
    }
    // Events from portaled children (popovers) bubble here through React; leave them alone.
    if (e.key !== 'Tab' || !(e.target instanceof Node) || !panel.contains(e.target)) return;
    const items = focusableWithin(panel);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="ui-scrim"
      onPointerDown={(e) => {
        downOnScrim.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnScrim.current && dismissible) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cx('ui-dialog', `ui-dialog--${size}`, className)}
        onKeyDown={onKeyDown}
        data-testid={testId}
      >
        <header className="ui-dialog__head">
          {tone !== 'default' ? (
            <Icon name={TONE_ICON[tone]} className={cx('ui-dialog__tone', `ui-dialog__tone--${tone}`)} />
          ) : null}
          <h2 id={titleId} className="ui-dialog__title">
            {title}
          </h2>
          {dismissible ? (
            <IconButton icon="x" label={t('kit.dialog.close')} size="sm" tooltip={false} onClick={onClose} />
          ) : null}
        </header>
        {description ? (
          <p id={descId} className="ui-dialog__desc">
            {description}
          </p>
        ) : null}
        {children ? <div className="ui-dialog__body">{children}</div> : null}
        {footer || footerNote ? (
          <footer className="ui-dialog__foot">
            {footerNote ? <div className="ui-dialog__note">{footerNote}</div> : null}
            <div className="ui-dialog__actions">{footer}</div>
          </footer>
        ) : null}
      </div>
    </div>
  );
}
