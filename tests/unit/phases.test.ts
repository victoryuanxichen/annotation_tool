import { describe, expect, it } from 'vitest';
import {
  addPhase,
  clearRecent,
  createDefaultLibrary,
  createPreset,
  deletePreset,
  isValidPhaseId,
  mergeImportedPhases,
  PHASE_PALETTE,
  pickColor,
  presetPhases,
  recolorPhase,
  renamePhase,
  renamePreset,
  setActivePreset,
  setPresetPhases,
  slugPhaseId,
  touchRecent,
} from '../../src/core/phases';
import type { PhaseLibrary } from '../../src/core/types';

function expectOk<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  expect(r.ok).toBe(true);
  return r as Extract<T, { ok: true }>;
}

describe('phase ids', () => {
  it('validates the id pattern', () => {
    expect(isValidPhaseId('prep')).toBe(true);
    expect(isValidPhaseId('chole.calot-triangle_1')).toBe(true);
    expect(isValidPhaseId('0')).toBe(true);
    expect(isValidPhaseId('a'.repeat(64))).toBe(true);
    expect(isValidPhaseId('a'.repeat(65))).toBe(false);
    expect(isValidPhaseId('')).toBe(false);
    expect(isValidPhaseId('-prep')).toBe(false);
    expect(isValidPhaseId('Prep')).toBe(false);
    expect(isValidPhaseId('prep phase')).toBe(false);
  });

  it('slugs names to ASCII ids', () => {
    expect(slugPhaseId('Calot triangle dissection', [])).toBe('calot-triangle-dissection');
    expect(slugPhaseId('  Irrigation/Aspiration  ', [])).toBe('irrigation-aspiration');
    expect(slugPhaseId('Résection — Phase 2', [])).toBe('resection-phase-2');
    expect(slugPhaseId('=SUM(A1)', [])).toBe('sum-a1');
  });

  it('falls back to phase- + 6 hex for names without ASCII letters', () => {
    const id = slugPhaseId('膽囊剝離', []);
    expect(id).toMatch(/^phase-[0-9a-f]{6}$/);
    expect(slugPhaseId('膽囊剝離', [])).toBe(id);
    expect(slugPhaseId('🔪', [])).toMatch(/^phase-[0-9a-f]{6}$/);
  });

  it('adds a uniqueness suffix and stays within 64 chars', () => {
    expect(slugPhaseId('Prep', ['prep'])).toBe('prep-2');
    expect(slugPhaseId('Prep', new Set(['prep', 'prep-2']))).toBe('prep-3');
    const long = 'x'.repeat(80);
    const id = slugPhaseId(long, ['x'.repeat(64)]);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(isValidPhaseId(id)).toBe(true);
    expect(id.endsWith('-2')).toBe(true);
  });
});

describe('palette', () => {
  it('has 12 distinct #rrggbb colours', () => {
    expect(PHASE_PALETTE).toHaveLength(12);
    expect(new Set(PHASE_PALETTE).size).toBe(12);
    for (const c of PHASE_PALETTE) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('colours have similar luminance and readable dark text', () => {
    const lum = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const v = parseInt(hex.slice(i, i + 2), 16) / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const darkText = lum('#16181b');
    for (const c of PHASE_PALETTE) expect((lum(c) + 0.05) / (darkText + 0.05)).toBeGreaterThan(7);
    const ls = PHASE_PALETTE.map(lum);
    expect(Math.max(...ls) / Math.min(...ls)).toBeLessThan(1.25);
  });

  it('pickColor picks the first unused colour, then the least used', () => {
    expect(pickColor([])).toBe(PHASE_PALETTE[0]);
    expect(pickColor([PHASE_PALETTE[0].toUpperCase(), PHASE_PALETTE[1]])).toBe(PHASE_PALETTE[2]);
    const all = [...PHASE_PALETTE, ...PHASE_PALETTE.slice(0, 3)];
    expect(pickColor(all)).toBe(PHASE_PALETTE[3]);
    expect(pickColor(['#000000'])).toBe(PHASE_PALETTE[0]);
  });
});

describe('default library', () => {
  it('contains the two example presets with stable ids', () => {
    const lib = createDefaultLibrary();
    expect(lib.presets.map((p) => p.name)).toEqual(['Laparoscopic cholecystectomy (example)', 'Cataract surgery (example)']);
    const [chole, cataract] = lib.presets;
    expect(chole.phaseIds).toHaveLength(7);
    expect(chole.phaseIds[0]).toBe('chole.preparation');
    expect(presetPhases(lib, chole.id).map((p) => p.name)).toEqual([
      'Preparation',
      'Calot triangle dissection',
      'Clipping and cutting',
      'Gallbladder dissection',
      'Gallbladder packaging',
      'Cleaning and coagulation',
      'Gallbladder retraction',
    ]);
    expect(cataract.phaseIds[0]).toBe('cataract.incision');
    expect(cataract.phaseIds).toHaveLength(9);
    for (const p of Object.values(lib.phases)) {
      expect(isValidPhaseId(p.id)).toBe(true);
      expect(PHASE_PALETTE).toContain(p.color);
    }
    expect(new Set(presetPhases(lib, chole.id).map((p) => p.color)).size).toBe(7);
    expect(lib.activePresetId).toBe(chole.id);
    expect(lib.recent).toEqual([]);
    expect(createDefaultLibrary()).toEqual(lib);
  });
});

describe('library edits', () => {
  const fresh = (): PhaseLibrary => createDefaultLibrary();

  it('addPhase derives an id, assigns a colour and optionally appends to a preset', () => {
    const lib = fresh();
    const r = expectOk(addPhase(lib, { name: 'Bleeding control' }, 'preset.chole'));
    expect(r.phase.id).toBe('bleeding-control');
    expect(PHASE_PALETTE).toContain(r.phase.color);
    expect(r.library.presets[0].phaseIds.at(-1)).toBe('bleeding-control');
    expect(lib.phases['bleeding-control']).toBeUndefined();
    const again = expectOk(addPhase(r.library, { name: 'Bleeding control' }));
    expect(again.phase.id).toBe('bleeding-control-2');
  });

  it('addPhase validates input', () => {
    const lib = fresh();
    expect(addPhase(lib, { name: '  ' })).toEqual({ ok: false, reason: 'empty_name' });
    expect(addPhase(lib, { name: 'X', id: 'Bad Id' })).toEqual({ ok: false, reason: 'invalid_id' });
    expect(addPhase(lib, { name: 'X', id: 'chole.preparation' })).toEqual({ ok: false, reason: 'duplicate_id' });
    expect(addPhase(lib, { name: 'X', color: 'red' })).toEqual({ ok: false, reason: 'invalid_color' });
    expect(addPhase(lib, { name: 'X' }, 'nope')).toEqual({ ok: false, reason: 'preset_not_found' });
    expect(expectOk(addPhase(lib, { name: '中文', id: 'custom.cn', color: '#ABCDEF' })).phase).toEqual({
      id: 'custom.cn',
      name: '中文',
      color: '#abcdef',
    });
  });

  it('renamePhase keeps the id; recolorPhase validates', () => {
    const lib = fresh();
    const r = expectOk(renamePhase(lib, 'chole.preparation', 'Setup'));
    expect(r.library.phases['chole.preparation']).toMatchObject({ id: 'chole.preparation', name: 'Setup' });
    expect(renamePhase(lib, 'chole.preparation', '')).toEqual({ ok: false, reason: 'empty_name' });
    expect(renamePhase(lib, 'nope', 'x')).toEqual({ ok: false, reason: 'phase_not_found' });
    expect(expectOk(recolorPhase(lib, 'chole.preparation', '#112233')).library.phases['chole.preparation'].color).toBe('#112233');
    expect(recolorPhase(lib, 'chole.preparation', '#12345')).toEqual({ ok: false, reason: 'invalid_color' });
  });

  it('creates, renames, edits and deletes presets', () => {
    const lib = fresh();
    const c = expectOk(createPreset(lib, 'My procedure', ['chole.preparation', 'missing', 'chole.preparation']));
    expect(c.preset).toMatchObject({ id: 'preset.my-procedure', phaseIds: ['chole.preparation'] });
    expect(expectOk(createPreset(c.library, 'My procedure')).preset.id).toBe('preset.my-procedure-2');
    expect(createPreset(lib, ' ')).toEqual({ ok: false, reason: 'empty_name' });

    const renamed = expectOk(renamePreset(c.library, c.preset.id, 'Renamed')).library;
    expect(renamed.presets.at(-1)?.name).toBe('Renamed');
    expect(renamePreset(lib, 'nope', 'x')).toEqual({ ok: false, reason: 'preset_not_found' });

    const reordered = expectOk(setPresetPhases(renamed, 'preset.chole', ['chole.clipping-cutting', 'chole.preparation'])).library;
    expect(reordered.presets[0].phaseIds).toEqual(['chole.clipping-cutting', 'chole.preparation']);
    expect(reordered.phases['chole.gallbladder-dissection']).toBeDefined(); // phases are never deleted

    const deleted = deletePreset(reordered, 'preset.chole');
    expect(deleted.presets.map((p) => p.id)).not.toContain('preset.chole');
    expect(deleted.activePresetId).toBe('preset.cataract');
    expect(deletePreset(deleted, 'nope')).toBe(deleted);
    expect(expectOk(setActivePreset(deleted, null)).library.activePresetId).toBeNull();
    expect(setActivePreset(deleted, 'preset.chole')).toEqual({ ok: false, reason: 'preset_not_found' });
  });

  it('mergeImportedPhases adds only unknown ids', () => {
    const lib = fresh();
    const r = mergeImportedPhases(lib, [
      { id: 'chole.preparation', name: 'Other name' },
      { id: 'imported', name: 'Imported' },
    ]);
    expect(r.added.map((p) => p.id)).toEqual(['imported']);
    expect(r.library.phases['chole.preparation'].name).toBe('Preparation');
    expect(mergeImportedPhases(lib, [{ id: 'chole.preparation', name: 'x' }]).library).toBe(lib);
  });

  it('touchRecent keeps a full MRU list; clearRecent empties it', () => {
    let recent: string[] = [];
    for (const id of ['a', 'b', 'c', 'a', 'd']) recent = touchRecent(recent, id);
    expect(recent).toEqual(['d', 'a', 'c', 'b']);
    const many = Array.from({ length: 15 }, (_, i) => `p${i}`).reduce<string[]>((r, id) => touchRecent(r, id), []);
    expect(many).toHaveLength(15);
    expect(touchRecent(many, 'x', 10)).toHaveLength(10);
    const lib = { ...fresh(), recent };
    expect(clearRecent(lib).recent).toEqual([]);
  });
});
