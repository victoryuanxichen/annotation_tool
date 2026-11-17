import type { ReactElement } from 'react';
import { cx, isMacPlatform } from './internal';

const MAC_NAMES: Readonly<Record<string, string>> = {
  mod: '⌘', cmd: '⌘', meta: '⌘', ctrl: '⌃', shift: '⇧', alt: '⌥', option: '⌥',
};
const PC_NAMES: Readonly<Record<string, string>> = {
  mod: 'Ctrl', cmd: 'Ctrl', meta: 'Win', ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', option: 'Alt',
};
const COMMON_NAMES: Readonly<Record<string, string>> = {
  space: 'Space', esc: 'Esc', escape: 'Esc', enter: '↵', return: '↵', tab: 'Tab',
  arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓', left: '←', right: '→', up: '↑', down: '↓',
  backspace: '⌫', delete: 'Del', home: 'Home', end: 'End', pageup: 'PgUp', pagedown: 'PgDn',
};

/** Splits "Mod+Shift+Z" into display tokens; "Mod" is ⌘ on macOS and Ctrl elsewhere. A literal "+" key is "Plus" or a trailing "+". */
export function shortcutTokens(keys: string, mac: boolean = isMacPlatform()): string[] {
  const parts = keys.split('+');
  if (keys.endsWith('+')) parts.splice(parts.length - 2, 2, '+');
  return parts
    .map((raw) => raw.trim())
    .filter((raw) => raw.length > 0)
    .map((raw) => {
      const lower = raw.toLowerCase();
      if (lower === 'plus') return '+';
      return (mac ? MAC_NAMES : PC_NAMES)[lower] ?? COMMON_NAMES[lower] ?? (raw.length === 1 ? raw.toUpperCase() : raw);
    });
}

/** Plain-text form for titles and aria labels, e.g. "⌘⇧Z" or "Ctrl+Shift+Z". */
export function formatShortcut(keys: string, mac: boolean = isMacPlatform()): string {
  return shortcutTokens(keys, mac).join(mac ? '' : '+');
}

export interface KbdProps {
  /** Key combination, e.g. "Q", "Shift+A", "Mod+Shift+Z", "Space". */
  keys: string;
  size?: 'sm' | 'md';
  /** On-accent style for use inside primary buttons. */
  inverse?: boolean;
  className?: string;
}

export function Kbd({ keys, size = 'sm', inverse = false, className }: KbdProps): ReactElement {
  const tokens = shortcutTokens(keys);
  return (
    <span className={cx('ui-kbd-group', className)} aria-label={formatShortcut(keys)}>
      {tokens.map((token, i) => (
        <kbd key={i} aria-hidden className={cx('ui-kbd', `ui-kbd--${size}`, inverse && 'ui-kbd--inverse')}>
          {token}
        </kbd>
      ))}
    </span>
  );
}
