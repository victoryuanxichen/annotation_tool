/**
 * Phase identity, colours and pure phase-library edits (SPEC §2, §7.4).
 * Phase IDs never change after creation; renaming only changes `name`.
 */
import { fnv1a64Hex } from './annotations';
import type { PhaseDef, PhaseLibrary, Preset } from './types';

export const PHASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_ID_LENGTH = 64;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/;

export function isValidPhaseId(id: string): boolean {
  return PHASE_ID_PATTERN.test(id);
}

export function isValidColor(color: string): boolean {
  return COLOR_PATTERN.test(color);
}

function toIdSet(ids: Iterable<string>): Set<string> {
  return ids instanceof Set ? (ids as Set<string>) : new Set(ids);
}

/** ASCII slug: accents folded, lowercased, non-alphanumeric runs collapsed to '-'. */
function asciiSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ID_LENGTH)
    .replace(/-+$/, '');
}

/** Appends `-2`, `-3`, … (truncating the base to stay within 64 chars) until the id is unused. */
function makeUnique(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, MAX_ID_LENGTH - suffix.length).replace(/[-._]+$/, '') + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Derives a phase id from a display name. Names without ASCII letters/digits (e.g. Chinese) get
 * `phase-` + 6 hex chars derived from the name, so the same name always proposes the same id.
 */
export function slugPhaseId(name: string, existingIds: Iterable<string> = []): string {
  const slug = asciiSlug(name.trim());
  const base = slug || `phase-${fnv1a64Hex(name.trim()).slice(0, 6)}`;
  return makeUnique(base, toIdSet(existingIds));
}

// --- Colours -----------------------------------------------------------------------------------

/**
 * 12 categorical colours for dark backgrounds: OKLCH lightness 0.76, chroma ≤ 0.14, hues spaced
 * ~30° apart and ordered so consecutive picks are far apart on the hue wheel. All reach ≥ 7.7:1
 * contrast against #16181b text.
 */
export const PHASE_PALETTE: readonly string[] = [
  '#fe8b83', // red
  '#74c878', // green
  '#79b4ff', // blue
  '#daa932', // amber
  '#21c9ca', // cyan
  '#d294ee', // violet
  '#f49752', // orange
  '#2fcda3', // teal
  '#a9a5fd', // indigo
  '#afbb47', // olive
  '#1bc3f3', // sky
  '#ef8bc5', // pink
];

/** First palette colour not in use; when all are used, the least used (earliest on ties). */
export function pickColor(usedColors: Iterable<string>): string {
  const counts = new Map<string, number>(PHASE_PALETTE.map((c) => [c, 0]));
  for (const c of usedColors) {
    const key = c.toLowerCase();
    const n = counts.get(key);
    if (n !== undefined) counts.set(key, n + 1);
  }
  let best = PHASE_PALETTE[0];
  let bestCount = Infinity;
  for (const c of PHASE_PALETTE) {
    const n = counts.get(c) ?? 0;
    if (n < bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

// --- Built-in example library ------------------------------------------------------------------

interface ExamplePreset {
  id: string;
  name: string;
  phases: readonly (readonly [id: string, name: string])[];
}

const EXAMPLE_PRESETS: readonly ExamplePreset[] = [
  {
    id: 'preset.chole',
    name: 'Laparoscopic cholecystectomy (example)',
    phases: [
      ['chole.preparation', 'Preparation'],
      ['chole.calot-triangle-dissection', 'Calot triangle dissection'],
      ['chole.clipping-cutting', 'Clipping and cutting'],
      ['chole.gallbladder-dissection', 'Gallbladder dissection'],
      ['chole.gallbladder-packaging', 'Gallbladder packaging'],
      ['chole.cleaning-coagulation', 'Cleaning and coagulation'],
      ['chole.gallbladder-retraction', 'Gallbladder retraction'],
    ],
  },
  {
    id: 'preset.cataract',
    name: 'Cataract surgery (example)',
    phases: [
      ['cataract.incision', 'Incision'],
      ['cataract.viscoelastic-injection', 'Viscoelastic injection'],
      ['cataract.capsulorhexis', 'Capsulorhexis'],
      ['cataract.hydrodissection', 'Hydrodissection'],
      ['cataract.phacoemulsification', 'Phacoemulsification'],
      ['cataract.irrigation-aspiration', 'Irrigation/aspiration'],
      ['cataract.lens-implantation', 'Lens implantation'],
      ['cataract.viscoelastic-removal', 'Viscoelastic removal'],
      ['cataract.wound-closure', 'Wound closure'],
    ],
  },
];

/** Fresh default library with the two synthetic example presets (fully editable). */
export function createDefaultLibrary(): PhaseLibrary {
  const phases: Record<string, PhaseDef> = {};
  const presets: Preset[] = EXAMPLE_PRESETS.map((p) => {
    p.phases.forEach(([id, name], i) => {
      phases[id] = { id, name, color: PHASE_PALETTE[i % PHASE_PALETTE.length] };
    });
    return { id: p.id, name: p.name, phaseIds: p.phases.map(([id]) => id), builtIn: true };
  });
  return { phases, presets, activePresetId: presets[0].id, recent: [] };
}

// --- Library edits -----------------------------------------------------------------------------

export type LibraryError =
  | 'empty_name'
  | 'invalid_id'
  | 'duplicate_id'
  | 'invalid_color'
  | 'phase_not_found'
  | 'preset_not_found';

export type LibraryResult<T = object> = ({ ok: true; library: PhaseLibrary } & T) | { ok: false; reason: LibraryError };

export interface NewPhaseInput {
  name: string;
  /** Optional explicit id; derived from the name when omitted or blank. */
  id?: string;
  /** Optional '#rrggbb'; auto-assigned from the palette when omitted. */
  color?: string;
}

function usedColors(lib: PhaseLibrary): string[] {
  return Object.values(lib.phases).map((p) => p.color);
}

/** Adds a phase to the library and, when `presetId` is given, appends it to that preset. */
export function addPhase(
  lib: PhaseLibrary,
  input: NewPhaseInput,
  presetId: string | null = null,
): LibraryResult<{ phase: PhaseDef }> {
  const name = input.name.trim();
  if (!name) return { ok: false, reason: 'empty_name' };
  const explicitId = input.id?.trim();
  let id: string;
  if (explicitId) {
    if (!isValidPhaseId(explicitId)) return { ok: false, reason: 'invalid_id' };
    if (lib.phases[explicitId]) return { ok: false, reason: 'duplicate_id' };
    id = explicitId;
  } else {
    id = slugPhaseId(name, Object.keys(lib.phases));
  }
  const color = input.color?.toLowerCase() ?? pickColor(usedColors(lib));
  if (!isValidColor(color)) return { ok: false, reason: 'invalid_color' };
  if (presetId !== null && !lib.presets.some((p) => p.id === presetId)) return { ok: false, reason: 'preset_not_found' };

  const phase: PhaseDef = { id, name, color };
  const presets =
    presetId === null ? lib.presets : lib.presets.map((p) => (p.id === presetId ? { ...p, phaseIds: [...p.phaseIds, id] } : p));
  return { ok: true, library: { ...lib, phases: { ...lib.phases, [id]: phase }, presets }, phase };
}

function patchPhase(lib: PhaseLibrary, id: string, patch: Partial<Omit<PhaseDef, 'id'>>): LibraryResult {
  const phase = lib.phases[id];
  if (!phase) return { ok: false, reason: 'phase_not_found' };
  return { ok: true, library: { ...lib, phases: { ...lib.phases, [id]: { ...phase, ...patch } } } };
}

export function renamePhase(lib: PhaseLibrary, id: string, name: string): LibraryResult {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, reason: 'empty_name' };
  return patchPhase(lib, id, { name: trimmed });
}

export function recolorPhase(lib: PhaseLibrary, id: string, color: string): LibraryResult {
  const c = color.toLowerCase();
  if (!isValidColor(c)) return { ok: false, reason: 'invalid_color' };
  return patchPhase(lib, id, { color: c });
}

/**
 * Ensures every imported phase id exists in the library (new ones get a palette colour).
 * Existing phases keep their names; returns the phases that were added.
 */
export function mergeImportedPhases(
  lib: PhaseLibrary,
  entries: readonly { id: string; name: string }[],
): { library: PhaseLibrary; added: PhaseDef[] } {
  const phases = { ...lib.phases };
  const added: PhaseDef[] = [];
  for (const { id, name } of entries) {
    if (phases[id]) continue;
    const phase: PhaseDef = { id, name: name.trim() || id, color: pickColor(Object.values(phases).map((p) => p.color)) };
    phases[id] = phase;
    added.push(phase);
  }
  return added.length ? { library: { ...lib, phases }, added } : { library: lib, added };
}

function presetIdFor(name: string, taken: Iterable<string>): string {
  const slug = asciiSlug(name).slice(0, MAX_ID_LENGTH - 'preset.'.length);
  const base = slug ? `preset.${slug}` : `preset.${fnv1a64Hex(name).slice(0, 6)}`;
  return makeUnique(base, toIdSet(taken));
}

export function createPreset(
  lib: PhaseLibrary,
  name: string,
  phaseIds: readonly string[] = [],
): LibraryResult<{ preset: Preset }> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, reason: 'empty_name' };
  const preset: Preset = {
    id: presetIdFor(trimmed, lib.presets.map((p) => p.id)),
    name: trimmed,
    phaseIds: cleanPhaseIds(lib, phaseIds),
  };
  return { ok: true, library: { ...lib, presets: [...lib.presets, preset] }, preset };
}

function patchPreset(lib: PhaseLibrary, id: string, patch: Partial<Omit<Preset, 'id'>>): LibraryResult {
  if (!lib.presets.some((p) => p.id === id)) return { ok: false, reason: 'preset_not_found' };
  return { ok: true, library: { ...lib, presets: lib.presets.map((p) => (p.id === id ? { ...p, ...patch } : p)) } };
}

export function renamePreset(lib: PhaseLibrary, id: string, name: string): LibraryResult {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, reason: 'empty_name' };
  return patchPreset(lib, id, { name: trimmed });
}

/** Removes a preset (phases stay in the library: segments may reference them). */
export function deletePreset(lib: PhaseLibrary, id: string): PhaseLibrary {
  const presets = lib.presets.filter((p) => p.id !== id);
  if (presets.length === lib.presets.length) return lib;
  const activePresetId = lib.activePresetId === id ? (presets[0]?.id ?? null) : lib.activePresetId;
  return { ...lib, presets, activePresetId };
}

/** Replaces a preset's ordered phase list (unknown ids and duplicates are dropped). */
export function setPresetPhases(lib: PhaseLibrary, presetId: string, phaseIds: readonly string[]): LibraryResult {
  return patchPreset(lib, presetId, { phaseIds: cleanPhaseIds(lib, phaseIds) });
}

export function setActivePreset(lib: PhaseLibrary, presetId: string | null): LibraryResult {
  if (presetId !== null && !lib.presets.some((p) => p.id === presetId)) return { ok: false, reason: 'preset_not_found' };
  return { ok: true, library: { ...lib, activePresetId: presetId } };
}

function cleanPhaseIds(lib: PhaseLibrary, phaseIds: readonly string[]): string[] {
  return [...new Set(phaseIds)].filter((id) => lib.phases[id] !== undefined);
}

/** Phases of a preset in preset order. */
export function presetPhases(lib: PhaseLibrary, presetId: string): PhaseDef[] {
  const preset = lib.presets.find((p) => p.id === presetId);
  return preset ? preset.phaseIds.flatMap((id) => (lib.phases[id] ? [lib.phases[id]] : [])) : [];
}

/** Moves `id` to the front of the most-recently-used list (the UI shows the first 10). */
export function touchRecent(recent: readonly string[], id: string, max = Number.POSITIVE_INFINITY): string[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, max);
}

export function clearRecent(lib: PhaseLibrary): PhaseLibrary {
  return lib.recent.length ? { ...lib, recent: [] } : lib;
}
