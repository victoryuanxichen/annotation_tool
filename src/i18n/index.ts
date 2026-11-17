import { useCallback, useSyncExternalStore } from 'react';
import { en, type MessageKey } from './en';
import { zhHant } from './zhHant';

export type { MessageKey };
export type Lang = 'en' | 'zh-Hant';
export type MessageParams = Readonly<Record<string, string | number>>;
export type Translate = (key: MessageKey, params?: MessageParams) => string;

export const LANGS: readonly Lang[] = ['en', 'zh-Hant'];

/** Native-language label key for each language (labels are identical in every catalog). */
export const LANG_LABEL_KEY: Readonly<Record<Lang, MessageKey>> = { en: 'lang.en', 'zh-Hant': 'lang.zhHant' };

const CATALOGS: Readonly<Record<Lang, Readonly<Partial<Record<string, string>>>>> = {
  en,
  'zh-Hant': zhHant,
};

const LOCALE: Readonly<Record<Lang, string>> = { en: 'en-US', 'zh-Hant': 'zh-TW' };

// ---------------------------------------------------------------------------
// Lookup

const warned = new Set<string>();

function warnOnce(message: string): void {
  if (!import.meta.env.DEV || warned.has(message)) return;
  warned.add(message);
  console.warn(`[i18n] ${message}`);
}

export function isMessageKey(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(en, key);
}

/** Replaces `{name}` placeholders; unknown placeholders are left visible so they are noticed. */
export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** Translate in an explicit language. Falls back to English, then to the key itself. */
export function translate(lang: Lang, key: MessageKey, params?: MessageParams): string {
  const own = CATALOGS[lang][key];
  if (own !== undefined && own !== '') return interpolate(own, params);
  const fallback = CATALOGS.en[key];
  if (fallback !== undefined) {
    if (lang !== 'en') warnOnce(`Missing "${key}" in ${lang}; using English.`);
    return interpolate(fallback, params);
  }
  warnOnce(`Unknown message key "${key}".`);
  return key;
}

// ---------------------------------------------------------------------------
// Current-language store

let current: Lang = 'en';
const listeners = new Set<() => void>();

export function isLang(value: unknown): value is Lang {
  return value === 'en' || value === 'zh-Hant';
}

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  for (const fn of listeners) fn();
}

/** Subscribe to language changes (e.g. to persist the choice). Returns an unsubscribe function. */
export function subscribeLang(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Best guess from browser preferences: any Chinese preference maps to Traditional Chinese. */
export function detectLang(preferred?: readonly string[]): Lang {
  const prefs = preferred ?? (typeof navigator === 'undefined' ? [] : navigator.languages);
  for (const tag of prefs) {
    const lower = tag.toLowerCase();
    if (lower.startsWith('zh')) return 'zh-Hant';
    if (lower.startsWith('en')) return 'en';
  }
  return 'en';
}

export function localeOf(lang: Lang = current): string {
  return LOCALE[lang];
}

/** Translate in the current language (non-reactive; use `useT()` inside components). */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(current, key, params);
}

export function useLang(): Lang {
  return useSyncExternalStore(subscribeLang, getLang, getLang);
}

/** Returns a translate function bound to the current language; components re-render on change. */
export function useT(): Translate {
  const lang = useLang();
  return useCallback((key: MessageKey, params?: MessageParams) => translate(lang, key, params), [lang]);
}

// ---------------------------------------------------------------------------
// Formatting

const formatterCache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();

function numberFormat(lang: Lang, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `n|${lang}|${JSON.stringify(options)}`;
  let f = formatterCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(LOCALE[lang], options);
    formatterCache.set(key, f);
  }
  return f as Intl.NumberFormat;
}

export type DateTimeStyle = 'datetime' | 'date' | 'time' | 'shortDatetime';

const DATE_OPTIONS: Readonly<Record<DateTimeStyle, Intl.DateTimeFormatOptions>> = {
  datetime: {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  },
  shortDatetime: { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  date: { year: 'numeric', month: '2-digit', day: '2-digit' },
  time: { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' },
};

function dateFormat(lang: Lang, style: DateTimeStyle): Intl.DateTimeFormat {
  const key = `d|${lang}|${style}`;
  let f = formatterCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(LOCALE[lang], DATE_OPTIONS[style]);
    formatterCache.set(key, f);
  }
  return f as Intl.DateTimeFormat;
}

export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}, lang: Lang = current): string {
  return numberFormat(lang, options).format(value);
}

/** Dates and times use a 24-hour clock in every language. */
export function formatDateTime(value: number | Date, style: DateTimeStyle = 'datetime', lang: Lang = current): string {
  const date = typeof value === 'number' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return dateFormat(lang, style).format(date);
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Decimal (SI) units, as shown by macOS Finder: 1 KB = 1000 B. */
export function formatBytes(bytes: number, lang: Lang = current): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let unit = 0;
  let value = bytes;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  const text = numberFormat(lang, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
  return `${text} ${BYTE_UNITS[unit]}`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Microseconds → 'HH:MM:SS.mmm' (locale-independent). Truncates toward zero so a frame's
 * timecode never rounds up into the next frame's millisecond. Hours grow past 99 if needed.
 */
export function formatTimecode(us: number): string {
  if (!Number.isFinite(us)) return '--:--:--.---';
  const sign = us < 0 ? '-' : '';
  const totalMs = Math.floor(Math.abs(us) / 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${sign}${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}
