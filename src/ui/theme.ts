/**
 * Colour theme. The preference ('dark' | 'light' | 'system') lives in settings (IndexedDB);
 * this module turns it into `<html data-theme="dark|light">` and follows the OS when the
 * preference is 'system'. The preference is mirrored to localStorage so the inline script in
 * index.html can set the right theme before the first paint (IndexedDB is async).
 */
import { useSyncExternalStore } from 'react';

export type ThemePref = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'pa-theme';
const PREFS: readonly ThemePref[] = ['dark', 'light', 'system'];

let pref: ThemePref = readMirroredPref();
let resolved: ResolvedTheme = currentAttr() ?? resolve(pref);
const listeners = new Set<() => void>();
let media: MediaQueryList | null = null;

function readMirroredPref(): ThemePref {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(THEME_STORAGE_KEY) : null;
    return v && (PREFS as readonly string[]).includes(v) ? (v as ThemePref) : 'dark';
  } catch {
    return 'dark';
  }
}

function currentAttr(): ResolvedTheme | null {
  if (typeof document === 'undefined') return null;
  const v = document.documentElement.dataset.theme;
  return v === 'light' || v === 'dark' ? v : null;
}

function systemPrefersLight(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
}

function resolve(p: ThemePref): ResolvedTheme {
  if (p === 'system') return systemPrefersLight() ? 'light' : 'dark';
  return p;
}

function update(): void {
  const next = resolve(pref);
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = next;
  if (next === resolved) return;
  resolved = next;
  for (const l of listeners) l();
}

function onSystemChange(): void {
  if (pref === 'system') update();
}

/** Applies a preference (called once settings are loaded, and on every change). */
export function applyTheme(p: ThemePref): void {
  pref = p;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, p);
  } catch {
    // Private mode / blocked storage: the theme still applies for this session.
  }
  if (!media && typeof matchMedia === 'function') {
    media = matchMedia('(prefers-color-scheme: light)');
    media.addEventListener('change', onSystemChange);
  }
  update();
}

export function getResolvedTheme(): ResolvedTheme {
  return resolved;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Re-renders when the effective theme changes (canvas drawings must re-read colours). */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, getResolvedTheme, getResolvedTheme);
}
