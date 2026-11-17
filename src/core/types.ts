/** Shared domain types. Frame boundaries are integers in [0, N]; segments are half-open [start, end). */
export interface Segment {
  id: string;
  phaseId: string;
  start: number;
  end: number;
}

export interface PhaseDef {
  id: string;
  name: string;
  /** '#rrggbb' */
  color: string;
}

export interface Preset {
  id: string;
  /** Procedure type, e.g. "Laparoscopic cholecystectomy (example)". */
  name: string;
  phaseIds: string[];
  builtIn?: boolean;
}

export interface PhaseLibrary {
  phases: Record<string, PhaseDef>;
  presets: Preset[];
  activePresetId: string | null;
  /** Most recently used phase ids, most recent first. */
  recent: string[];
}

export type ExportFormatChoice = 'csv' | 'json' | 'both';

export interface VideoMeta {
  sha256: string;
  frameCount: number;
  durationUs: number;
  fileName: string;
}
