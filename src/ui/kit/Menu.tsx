import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { Icon, type IconName } from '../icons';
import { Button, IconButton, type ButtonVariant } from './Button';
import { Kbd } from './Kbd';
import { Popover } from './Popover';
import { cx, type Placement } from './internal';

export interface MenuAction {
  kind?: 'item';
  id: string;
  label: string;
  icon?: IconName;
  kbd?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Marks the item as the current choice (menuitemradio semantics). */
  checked?: boolean;
  onSelect: () => void;
}

export interface MenuSeparator {
  kind: 'separator';
  id: string;
}

export interface MenuLabel {
  kind: 'label';
  id: string;
  label: string;
}

export type MenuEntry = MenuAction | MenuSeparator | MenuLabel;

function isAction(entry: MenuEntry): entry is MenuAction {
  return entry.kind === undefined || entry.kind === 'item';
}

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  items: ReadonlyArray<MenuEntry>;
  placement?: Placement;
  'aria-label'?: string;
  id?: string;
  minWidth?: number;
}

/** Dropdown list of actions with arrow-key navigation; Enter/Space activates, Esc closes. */
export function Menu({ open, onClose, anchorRef, items, placement = 'bottom-end', id, minWidth = 180, ...aria }: MenuProps): ReactElement | null {
  const listRef = useRef<HTMLDivElement>(null);
  const hasChecks = items.some((it) => isAction(it) && it.checked !== undefined);

  const enabledButtons = (): HTMLButtonElement[] =>
    Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not([disabled])') ?? []);

  useEffect(() => {
    if (open) enabledButtons()[0]?.focus();
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const buttons = enabledButtons();
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (e.key === 'ArrowDown') next = buttons[(i + 1) % buttons.length];
    else if (e.key === 'ArrowUp') next = buttons[(i - 1 + buttons.length) % buttons.length];
    else if (e.key === 'Home') next = buttons[0];
    else if (e.key === 'End') next = buttons[buttons.length - 1];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  const select = (item: MenuAction): void => {
    onClose();
    anchorRef.current?.focus();
    item.onSelect();
  };

  return (
    <Popover
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      placement={placement}
      role="menu"
      aria-label={aria['aria-label']}
      initialFocus="none"
      id={id}
      className="ui-menu"
    >
      <div ref={listRef} onKeyDown={onKeyDown} style={{ minWidth }}>
        {items.map((item) => {
          if (item.kind === 'separator') return <div key={item.id} role="separator" className="ui-menu__sep" />;
          if (item.kind === 'label') return <div key={item.id} className="ui-menu__label">{item.label}</div>;
          return (
            <button
              key={item.id}
              type="button"
              role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={item.checked}
              tabIndex={-1}
              disabled={item.disabled}
              className={cx('ui-menu__item', item.danger && 'ui-menu__item--danger')}
              onClick={() => select(item)}
            >
              {hasChecks ? (
                <span className="ui-menu__check">{item.checked ? <Icon name="check" size={14} /> : null}</span>
              ) : null}
              {item.icon ? <Icon name={item.icon} className="ui-menu__icon" /> : null}
              <span className="ui-menu__text">{item.label}</span>
              {item.kbd ? <Kbd keys={item.kbd} className="ui-menu__kbd" /> : null}
            </button>
          );
        })}
      </div>
    </Popover>
  );
}

export interface MenuButtonProps {
  items: ReadonlyArray<MenuEntry>;
  /** Accessible name of the trigger (also its tooltip when icon-only). */
  label: string;
  /** Visible trigger text; omit for an icon-only trigger. */
  children?: ReactNode;
  icon?: IconName;
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  placement?: Placement;
  disabled?: boolean;
  className?: string;
}

/** A button that toggles a Menu. */
export function MenuButton({
  items,
  label,
  children,
  icon = 'more',
  variant = 'ghost',
  size = 'md',
  placement,
  disabled,
  className,
}: MenuButtonProps): ReactElement {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const common = {
    ref: anchorRef,
    disabled,
    className,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    onClick: () => setOpen((o) => !o),
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'ArrowDown' && !open) {
        e.preventDefault();
        setOpen(true);
      }
    },
  };
  return (
    <>
      {children ? (
        <Button {...common} variant={variant} size={size} icon={icon === 'more' ? undefined : icon} iconEnd="chevron-down">
          {children}
        </Button>
      ) : (
        <IconButton {...common} icon={icon} label={label} variant={variant} size={size} tooltip={!open} />
      )}
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} items={items} placement={placement} id={menuId} aria-label={label} />
    </>
  );
}
