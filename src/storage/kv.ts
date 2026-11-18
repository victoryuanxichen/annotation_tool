/** Typed key-value settings with defaults and schema-tolerant merging (SPEC §5). */
import type { ExportFormatChoice, PhaseDef, PhaseLibrary, Preset } from '../core/types';
import { defaultDb, singleRequest, type DbProvider } from './db';

export type Language = 'en' | 'zh-Hant';
export type ThemePref = 'dark' | 'light' | 'system';
export type ExportDestinationKind = 'beside' | 'folder' | 'download';
export type SortKey = 'name' | 'mtime' | 'size';
export type SortDir = 'asc' | 'desc';

export interface ExportDestination {
  kind: ExportDestinationKind;
  /** For kind 'folder': id of the persisted directory handle (see handles.ts). */
  handleId?: string;
}

export interface Settings {
  language: Language;
  theme: ThemePref;
  exportFormat: ExportFormatChoice;
  exportDestination: ExportDestination;
  sort: { key: SortKey; dir: SortDir };
  bottomPanelHeight: number;
  timelineZoom?: number;
}

const defaultSettings: Settings = {
  language: 'en',
  theme: 'dark',
  exportFormat: 'csv',
  exportDestination: { kind: 'beside' },
  sort: { key: 'name', dir: 'asc' },
  bottomPanelHeight: 260,
};
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze(defaultSettings);

const MIN_PANEL_HEIGHT = 120;
const MAX_PANEL_HEIGHT = 2000;
const PHASE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

type Raw = Record<string, unknown>;

function isObject(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Missing, unknown or malformed fields fall back to `defaults`; unknown keys are dropped. */
export function mergeSettings(raw: unknown, defaults: Settings = DEFAULT_SETTINGS): Settings {
  const r = isObject(raw) ? raw : {};
  const dest = isObject(r.exportDestination) ? r.exportDestination : {};
  const sort = isObject(r.sort) ? r.sort : {};
  const destKind = oneOf(dest.kind, ['beside', 'folder', 'download'], defaults.exportDestination.kind);
  const exportDestination: ExportDestination = { kind: destKind };
  if (destKind === 'folder') {
    const handleId = typeof dest.handleId === 'string' ? dest.handleId : defaults.exportDestination.handleId;
    if (handleId !== undefined) exportDestination.handleId = handleId;
  }
  const settings: Settings = {
    language: oneOf(r.language, ['en', 'zh-Hant'], defaults.language),
    theme: oneOf(r.theme, ['dark', 'light', 'system'], defaults.theme),
    exportFormat: oneOf(r.exportFormat, ['csv', 'json', 'both'], defaults.exportFormat),
    exportDestination,
    sort: {
      key: oneOf(sort.key, ['name', 'mtime', 'size'], defaults.sort.key),
      dir: oneOf(sort.dir, ['asc', 'desc'], defaults.sort.dir),
    },
    bottomPanelHeight: finite(r.bottomPanelHeight)
      ? Math.min(MAX_PANEL_HEIGHT, Math.max(MIN_PANEL_HEIGHT, Math.round(r.bottomPanelHeight)))
      : defaults.bottomPanelHeight,
  };
  const zoom = finite(r.timelineZoom) && r.timelineZoom > 0 ? r.timelineZoom : defaults.timelineZoom;
  if (zoom !== undefined) settings.timelineZoom = zoom;
  return settings;
}

function parsePhase(id: string, v: unknown): PhaseDef | null {
  if (!isObject(v) || !PHASE_ID_RE.test(id) || v.id !== id) return null;
  if (typeof v.name !== 'string' || v.name.trim() === '') return null;
  if (typeof v.color !== 'string' || !COLOR_RE.test(v.color)) return null;
  return { id, name: v.name, color: v.color.toLowerCase() };
}

function parsePreset(v: unknown, phases: Record<string, PhaseDef>): Preset | null {
  if (!isObject(v) || typeof v.id !== 'string' || typeof v.name !== 'string' || !Array.isArray(v.phaseIds)) return null;
  const phaseIds = unique(v.phaseIds.filter((p): p is string => typeof p === 'string' && p in phases));
  const preset: Preset = { id: v.id, name: v.name, phaseIds };
  if (v.builtIn === true) preset.builtIn = true;
  return preset;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/**
 * Validates a stored library against `defaults`: each section that is missing or malformed falls back
 * to the default; individual malformed phases/presets are dropped; dangling phase references are
 * removed. A stored library fully replaces default phases/presets (users may delete built-ins).
 */
export function mergeLibrary(raw: unknown, defaults: PhaseLibrary): PhaseLibrary {
  const r = isObject(raw) ? raw : {};
  const phases: Record<string, PhaseDef> = {};
  if (isObject(r.phases)) {
    for (const [id, v] of Object.entries(r.phases)) {
      const p = parsePhase(id, v);
      if (p) phases[id] = p;
    }
  } else {
    Object.assign(phases, defaults.phases);
  }

  const presets = Array.isArray(r.presets)
    ? r.presets.map((p) => parsePreset(p, phases)).filter((p): p is Preset => p !== null)
    : defaults.presets.map((p) => ({ ...p, phaseIds: p.phaseIds.filter((id) => id in phases) }));
  const presetIds = new Set(presets.map((p) => p.id));
  const uniquePresets = presets.filter((p, i) => presets.findIndex((q) => q.id === p.id) === i);

  const recentSource = Array.isArray(r.recent) ? r.recent : defaults.recent;
  const recent = unique(recentSource.filter((id): id is string => typeof id === 'string' && id in phases));

  const activeCandidates = [r.activePresetId, defaults.activePresetId];
  const active = activeCandidates.find((id): id is string => typeof id === 'string' && presetIds.has(id));
  return {
    phases,
    presets: uniquePresets,
    activePresetId: active ?? uniquePresets[0]?.id ?? null,
    recent,
  };
}

interface KvRow {
  k: string;
  v: unknown;
}

export interface KvStoreOptions {
  db?: DbProvider;
}

export class KvStore {
  private readonly db: DbProvider;

  constructor(options: KvStoreOptions = {}) {
    this.db = options.db ?? defaultDb;
  }

  async getRaw(key: string): Promise<unknown> {
    const row = await singleRequest<KvRow | undefined>(this.db, 'kv', 'readonly', (s) => s.get(key));
    return row?.v;
  }

  async setRaw(key: string, value: unknown): Promise<void> {
    const row: KvRow = { k: key, v: value };
    await singleRequest(this.db, 'kv', 'readwrite', (s) => s.put(row));
  }

  async getSettings(defaults: Settings = DEFAULT_SETTINGS): Promise<Settings> {
    return mergeSettings(await this.getRaw('settings'), defaults);
  }

  async setSettings(settings: Settings): Promise<void> {
    await this.setRaw('settings', mergeSettings(settings));
  }

  /** Reads, applies `patch`, validates and writes back; returns the stored result. */
  async updateSettings(patch: Partial<Settings>, defaults: Settings = DEFAULT_SETTINGS): Promise<Settings> {
    const next = mergeSettings({ ...(await this.getSettings(defaults)), ...patch }, defaults);
    await this.setRaw('settings', next);
    return next;
  }

  /** `defaults` is provided by the phases module (kept out of storage to avoid a dependency). */
  async getLibrary(defaults: () => PhaseLibrary): Promise<PhaseLibrary> {
    const raw = await this.getRaw('library');
    return raw === undefined ? defaults() : mergeLibrary(raw, defaults());
  }

  async setLibrary(library: PhaseLibrary): Promise<void> {
    await this.setRaw('library', library);
  }
}
