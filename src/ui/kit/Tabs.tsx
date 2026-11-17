import { useRef, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { cx } from './internal';

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  /** Small count shown after the label (e.g. number of segments). */
  count?: number;
  disabled?: boolean;
}

export interface TabsProps<T extends string> {
  items: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (id: T) => void;
  /** Prefix for tab/panel ids; pair with <TabPanel idBase=…>. */
  idBase: string;
  'aria-label'?: string;
  /** Content aligned to the end of the tab strip (e.g. a toolbar). */
  trailing?: ReactNode;
  className?: string;
}

export const tabId = (idBase: string, id: string): string => `${idBase}-tab-${id}`;
export const panelId = (idBase: string, id: string): string => `${idBase}-panel-${id}`;

/** WAI-ARIA tablist with roving focus; arrows move and activate, Home/End jump. */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  idBase,
  trailing,
  className,
  ...aria
}: TabsProps<T>): ReactElement {
  const listRef = useRef<HTMLDivElement>(null);

  const focusTab = (id: T): void => {
    onChange(id);
    listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(tabId(idBase, id))}`)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const enabled = items.filter((it) => !it.disabled);
    const index = enabled.findIndex((it) => it.id === value);
    let next: TabItem<T> | undefined;
    if (e.key === 'ArrowRight') next = enabled[(index + 1) % enabled.length];
    else if (e.key === 'ArrowLeft') next = enabled[(index - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (!next) return;
    e.preventDefault();
    focusTab(next.id);
  };

  return (
    <div className={cx('ui-tabs', className)}>
      <div ref={listRef} role="tablist" aria-label={aria['aria-label']} className="ui-tabs__list" onKeyDown={onKeyDown}>
        {items.map((it) => {
          const selected = it.id === value;
          return (
            <button
              key={it.id}
              type="button"
              role="tab"
              id={tabId(idBase, it.id)}
              aria-selected={selected}
              aria-controls={panelId(idBase, it.id)}
              tabIndex={selected ? 0 : -1}
              disabled={it.disabled}
              className={cx('ui-tab', selected && 'ui-tab--selected')}
              onClick={() => onChange(it.id)}
            >
              <span>{it.label}</span>
              {it.count !== undefined ? <span className="ui-tab__count">{it.count}</span> : null}
            </button>
          );
        })}
      </div>
      {trailing ? <div className="ui-tabs__trailing">{trailing}</div> : null}
    </div>
  );
}

export interface TabPanelProps {
  idBase: string;
  id: string;
  active: boolean;
  /** Keep the panel mounted (hidden) when inactive, preserving its state. */
  keepMounted?: boolean;
  className?: string;
  children?: ReactNode;
}

export function TabPanel({ idBase, id, active, keepMounted = false, className, children }: TabPanelProps): ReactElement | null {
  if (!active && !keepMounted) return null;
  return (
    <div
      role="tabpanel"
      id={panelId(idBase, id)}
      aria-labelledby={tabId(idBase, id)}
      hidden={!active}
      tabIndex={0}
      className={cx('ui-tabpanel', className)}
    >
      {children}
    </div>
  );
}
