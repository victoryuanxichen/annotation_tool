/** Shared types of the export format v1 (SPEC §2.1). */

export const FORMAT_NAME = 'phase-annotations';
export const FORMAT_VERSION = 1;

export const CSV_HEADER = [
  'format_version',
  'video_sha256',
  'frame_count',
  'duration_us',
  'phase_id',
  'phase_name',
  'start_frame',
  'end_frame',
  'start_us',
  'end_us',
] as const;

export type CsvColumn = (typeof CSV_HEADER)[number];

export type SidecarFormat = 'csv' | 'json';

export interface ExportVideo {
  sha256: string;
  frameCount: number;
  durationUs: number;
  /** Written to JSON only. */
  fileName: string | null;
}

export interface ExportRecord {
  phaseId: string;
  phaseName: string;
  startFrame: number;
  endFrame: number;
  startUs: number;
  endUs: number;
}

/** One annotation file: video metadata plus records ordered by start frame. */
export interface ExportDocument {
  video: ExportVideo;
  records: ExportRecord[];
}

export interface ParsedRecord extends ExportRecord {
  /** 1-based position among the file's segments. */
  ordinal: number;
  /** CSV line number where the row starts (null for JSON). */
  line: number | null;
}

export interface ParsedAnnotation extends ExportDocument {
  format: SidecarFormat;
  formatVersion: number;
  records: ParsedRecord[];
  /** File name the text came from (for messages). */
  sourceName: string;
}

export type ImportErrorCode =
  | 'empty_file'
  | 'invalid_json'
  | 'csv_malformed'
  | 'unsupported_format'
  | 'unsupported_version'
  | 'unknown_header'
  | 'column_count'
  | 'missing_field'
  | 'invalid_value'
  | 'mixed_video_metadata'
  | 'no_rows';

export type MessageParams = Record<string, string | number>;

export interface ImportError {
  code: ImportErrorCode;
  /** Interpolation values for i18n messages. */
  params: MessageParams;
}

export type ParseResult = { ok: true; file: ParsedAnnotation } | { ok: false; errors: ImportError[] };

export type VerifyProblemCode =
  | 'sha256_mismatch'
  | 'frame_count_mismatch'
  | 'duration_mismatch'
  | 'not_integer'
  | 'empty'
  | 'out_of_range'
  | 'time_mismatch'
  | 'overlap'
  | 'inconsistent_phase_name';

export interface VerifyProblem {
  code: VerifyProblemCode;
  params: MessageParams;
}

export interface VideoIdentity {
  sha256: string;
  frameCount: number;
  durationUs: number;
  /** Time in µs of boundary b ∈ [0, N]. */
  boundaryUs: (b: number) => number;
}

export type VerifyResult = { ok: true } | { ok: false; problems: VerifyProblem[] };
