import { en } from '../../i18n/en';
import type { MessageKey, Translate } from '../../i18n';
import type { PhaseDef, PhaseLibrary, Preset } from '../../core/types';

/** Built-in example presets keep a translated name until the user renames them. */
const BUILT_IN_NAMES: ReadonlyArray<MessageKey> = ['preset.cholecystectomy', 'preset.cataract'];

export function presetLabel(preset: Preset, t: Translate): string {
  const key = BUILT_IN_NAMES.find((k) => en[k] === preset.name);
  return key ? t(key) : preset.name;
}

export interface PhaseGroup {
  id: string;
  label: string;
  phases: PhaseDef[];
}

/** Library phases grouped by preset (active preset first) plus "Custom" for phases in no preset. */
export function phaseGroups(lib: PhaseLibrary, t: Translate): PhaseGroup[] {
  const presets = [...lib.presets].sort((a, b) => Number(b.id === lib.activePresetId) - Number(a.id === lib.activePresetId));
  const inPreset = new Set<string>();
  const groups: PhaseGroup[] = presets.map((p) => {
    p.phaseIds.forEach((id) => inPreset.add(id));
    return {
      id: p.id,
      label: presetLabel(p, t),
      phases: p.phaseIds.map((id) => lib.phases[id]).filter((ph): ph is PhaseDef => ph !== undefined),
    };
  });
  const custom = Object.values(lib.phases).filter((p) => !inPreset.has(p.id));
  if (custom.length > 0) groups.push({ id: 'custom', label: t('preset.custom'), phases: custom });
  return groups.filter((g) => g.phases.length > 0);
}

/** Recent-chip shortcut label: slots 1–5 are digits, 6–10 are Shift+digit. */
export function slotLabel(slot: number): string {
  return slot <= 5 ? String(slot) : `⇧${slot - 5}`;
}
