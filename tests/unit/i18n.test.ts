import { afterEach, describe, expect, it, vi } from 'vitest';
import { en, type MessageKey } from '../../src/i18n/en';
import { zhHant } from '../../src/i18n/zhHant';
import {
  detectLang,
  formatBytes,
  formatDateTime,
  formatNumber,
  formatTimecode,
  getLang,
  interpolate,
  isMessageKey,
  setLang,
  subscribeLang,
  t,
  translate,
} from '../../src/i18n';
import { parseIntInRange, resolveNumberCommit } from '../../src/ui/kit/TextInput';
import { middleTruncate, fitMiddle } from '../../src/ui/kit/MiddleEllipsis';
import { shortcutTokens, formatShortcut } from '../../src/ui/kit/Kbd';

const enKeys = Object.keys(en).sort();
const zhKeys = Object.keys(zhHant).sort();

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

afterEach(() => {
  setLang('en');
  vi.restoreAllMocks();
});

describe('catalogs', () => {
  it('zhHant has exactly the keys of en', () => {
    expect(zhKeys.filter((k) => !(k in en))).toEqual([]);
    expect(enKeys.filter((k) => !(k in zhHant))).toEqual([]);
    expect(zhKeys.length).toBe(enKeys.length);
  });

  it('has no empty or whitespace-only strings', () => {
    for (const [lang, catalog] of [['en', en], ['zh-Hant', zhHant]] as const) {
      const empty = Object.entries(catalog).filter(([, v]) => v.trim() === '');
      expect(empty, lang).toEqual([]);
    }
  });

  it('uses the same {placeholders} in both languages', () => {
    const mismatched = enKeys.filter(
      (k) => placeholders(en[k as MessageKey]).join() !== placeholders(zhHant[k as MessageKey]).join(),
    );
    expect(mismatched).toEqual([]);
  });

  it('keeps keys flat and dot-separated', () => {
    for (const k of enKeys) expect(k).toMatch(/^[a-zA-Z0-9]+(\.[a-zA-Z0-9_]+)+$/);
  });

  it('uses Traditional (Taiwan) forms, not Simplified', () => {
    // Characters that exist only in Simplified Chinese (这 帧 标 导 设 删 检 点 击 确 认 数 据 类 阶 录 档).
    const simplifiedOnly = /[这帧标导设删检点击确认数据类阶录档]/;
    const hits = Object.entries(zhHant).filter(([, v]) => simplifiedOnly.test(v));
    expect(hits).toEqual([]);
  });

  it('uses the agreed Taiwan terminology', () => {
    expect(zhHant['player.frame']).toBe('影格');
    expect(zhHant['tabs.checkpoints']).toBe('檢查點');
    expect(zhHant['tabs.export']).toBe('匯出');
    expect(zhHant['import.file']).toContain('匯入');
    expect(zhHant['save.label']).toBe('草稿');
    expect(zhHant['phase.panel']).toBe('階段');
    expect(zhHant['topbar.openFolder']).toContain('資料夾');
    expect(zhHant['mark.title']).toBe('標註');
  });
});

describe('translate', () => {
  it('interpolates {name} params, including numbers and repeated names', () => {
    expect(interpolate('{a} and {a} of {b}', { a: 1, b: 'x' })).toBe('1 and 1 of x');
    expect(translate('en', 'save.saved', { time: '14:02:11' })).toBe('Saved 14:02:11');
    expect(translate('zh-Hant', 'segments.count', { count: 3 })).toBe('3 個片段');
  });

  it('leaves unknown placeholders visible and ignores extra params', () => {
    expect(interpolate('Frame {frame}', {})).toBe('Frame {frame}');
    expect(interpolate('Frame {frame}', { frame: 5, other: 1 })).toBe('Frame 5');
    expect(interpolate('No params', undefined)).toBe('No params');
  });

  it('is plural-insensitive (one message for every count)', () => {
    expect(t('batch.count', { count: 1 })).toBe('Videos: 1');
    expect(t('batch.count', { count: 2 })).toBe('Videos: 2');
  });

  it('follows the current language', () => {
    expect(getLang()).toBe('en');
    expect(t('player.play')).toBe('Play');
    setLang('zh-Hant');
    expect(t('player.play')).toBe('播放');
    expect(getLang()).toBe('zh-Hant');
  });

  it('notifies subscribers once per actual change', () => {
    const fn = vi.fn();
    const off = subscribeLang(fn);
    setLang('zh-Hant');
    setLang('zh-Hant');
    setLang('en');
    off();
    setLang('zh-Hant');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('falls back to the key and warns once in dev for unknown keys', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bogus = 'nope.missing' as MessageKey;
    expect(translate('zh-Hant', bogus)).toBe('nope.missing');
    expect(translate('zh-Hant', bogus)).toBe('nope.missing');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(isMessageKey('nope.missing')).toBe(false);
    expect(isMessageKey('player.play')).toBe(true);
  });

  it('detects language from browser preferences', () => {
    expect(detectLang(['zh-TW', 'en'])).toBe('zh-Hant');
    expect(detectLang(['zh-Hant-HK'])).toBe('zh-Hant');
    expect(detectLang(['en-GB', 'zh-TW'])).toBe('en');
    expect(detectLang(['fr-FR', 'zh-CN'])).toBe('zh-Hant');
    expect(detectLang(['de-DE'])).toBe('en');
    expect(detectLang([])).toBe('en');
  });
});

describe('formatTimecode (µs → HH:MM:SS.mmm, locale-independent)', () => {
  it.each([
    [0, '00:00:00.000'],
    [40_000, '00:00:00.040'],
    [33_367, '00:00:00.033'], // 1 / 29.97 s
    [999, '00:00:00.000'], // sub-millisecond truncates
    [1_000_000, '00:00:01.000'],
    [59_999_999, '00:00:59.999'], // never rounds up into the next second
    [299_200_000, '00:04:59.200'],
    [3_600_000_000, '01:00:00.000'],
    [3_723_456_789, '01:02:03.456'],
    [360_000_000_000, '100:00:00.000'],
    [-1_500_000, '-00:00:01.500'],
    [1500.7, '00:00:00.001'],
  ])('%d µs → %s', (us, expected) => {
    expect(formatTimecode(us)).toBe(expected);
  });

  it('marks non-finite input', () => {
    expect(formatTimecode(Number.NaN)).toBe('--:--:--.---');
    expect(formatTimecode(Number.POSITIVE_INFINITY)).toBe('--:--:--.---');
  });

  it('does not depend on the language', () => {
    setLang('zh-Hant');
    expect(formatTimecode(3_723_456_789)).toBe('01:02:03.456');
  });
});

describe('number, byte and date formatting', () => {
  it('formats numbers for the locale', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(1234567, {}, 'zh-Hant')).toBe('1,234,567');
  });

  it('formats bytes with decimal units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1000)).toBe('1.0 KB');
    expect(formatBytes(412_558_336)).toBe('413 MB');
    expect(formatBytes(1_482_331_904)).toBe('1.5 GB');
    expect(formatBytes(-1)).toBe('—');
  });

  it('uses a 24-hour clock', () => {
    const late = new Date(2026, 0, 2, 23, 4, 5).getTime();
    expect(formatDateTime(late, 'time', 'en')).toBe('23:04:05');
    expect(formatDateTime(late, 'time', 'zh-Hant')).toBe('23:04:05');
    expect(formatDateTime(late, 'datetime', 'en')).toContain('23:04:05');
    expect(formatDateTime(Number.NaN)).toBe('—');
  });
});

describe('ui kit pure helpers', () => {
  it('parses whole numbers within a range', () => {
    expect(parseIntInRange(' 1,234 ', 0, 9000)).toEqual({ ok: true, value: 1234 });
    expect(parseIntInRange('12.5', 0, 9000)).toEqual({ ok: false, reason: 'format' });
    expect(parseIntInRange('', 0, 9000)).toEqual({ ok: false, reason: 'format' });
    expect(parseIntInRange('9001', 0, 9000)).toEqual({ ok: false, reason: 'range' });
    expect(parseIntInRange('-1', 0, 9000)).toEqual({ ok: false, reason: 'range' });
  });

  it('Enter in a number field commits the shown value when nothing was typed (jump field releases focus)', () => {
    expect(resolveNumberCommit(null, 4, 0, 249)).toEqual({ kind: 'commit', value: 4 });
    expect(resolveNumberCommit(null, null, 0, 249)).toEqual({ kind: 'none' });
    expect(resolveNumberCommit('120', 4, 0, 249)).toEqual({ kind: 'commit', value: 120 });
    expect(resolveNumberCommit('4d', 4, 0, 249)).toEqual({ kind: 'invalid', reason: 'format' });
    expect(resolveNumberCommit('250', 4, 0, 249)).toEqual({ kind: 'invalid', reason: 'range' });
  });

  it('truncates paths in the middle, keeping the file name when possible', () => {
    const path = 'site_a/2026-10/really/deep/case_003.mp4';
    expect(middleTruncate(path, 100)).toBe(path);
    const cut = middleTruncate(path, 20);
    expect(cut.length).toBe(21);
    expect(cut.endsWith('case_003.mp4')).toBe(true);
    expect(cut.startsWith('site')).toBe(true);
    // Monospace measure: 1 unit per char.
    expect(fitMiddle(path, 15, (s) => s.length)).toHaveLength(15);
    expect(fitMiddle(path, 1000, (s) => s.length)).toBe(path);
  });

  it('formats shortcuts per platform', () => {
    expect(shortcutTokens('Mod+Shift+Z', true)).toEqual(['⌘', '⇧', 'Z']);
    expect(formatShortcut('Mod+Shift+Z', false)).toBe('Ctrl+Shift+Z');
    expect(shortcutTokens('Ctrl++', false)).toEqual(['Ctrl', '+']);
    expect(shortcutTokens('Space', false)).toEqual(['Space']);
    expect(shortcutTokens('q', false)).toEqual(['Q']);
  });
});
