/**
 * Import of export format v1 (CSV or JSON) and verification against an indexed video (SPEC §2.1).
 * Both stages report every problem they find, each with a code and i18n params.
 */
import { newSegmentId, sortSegments } from '../annotations';
import { isValidPhaseId } from '../phases';
import type { Segment } from '../types';
import { parseCsv, unprotectFormula, UTF8_BOM, type CsvRow } from './csv';
import {
  CSV_HEADER,
  FORMAT_NAME,
  FORMAT_VERSION,
  type CsvColumn,
  type ExportVideo,
  type ImportError,
  type MessageParams,
  type ParsedAnnotation,
  type ParsedRecord,
  type ParseResult,
  type VerifyProblem,
  type VerifyResult,
  type VideoIdentity,
} from './types';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const NUMBER_PATTERN = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const SEGMENT_COLUMNS = ['phase_id', 'phase_name', 'start_frame', 'end_frame', 'start_us', 'end_us'] as const;

/** Auto-detects JSON (`{` after an optional BOM) vs CSV and parses the file. */
export function parseAnnotationFile(text: string, nameHint: string): ParseResult {
  const body = text.startsWith(UTF8_BOM) ? text.slice(1) : text;
  const trimmed = body.trim();
  if (!trimmed) return fail([{ code: 'empty_file', params: { file: nameHint } }]);
  if (trimmed.startsWith('{') || /\.json$/i.test(nameHint)) return parseJsonFile(trimmed, nameHint);
  return parseCsvFile(body, nameHint);
}

function fail(errors: ImportError[]): ParseResult {
  return { ok: false, errors };
}

function parseNumber(value: string): number | null {
  const v = value.trim();
  return NUMBER_PATTERN.test(v) ? Number(v) : null;
}

function isNonNegativeInteger(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}

// --- Video metadata (shared by CSV and JSON) -----------------------------------------------------

interface RawVideo {
  sha256: unknown;
  frameCount: unknown;
  durationUs: unknown;
}

/** Validates video metadata; pushes `invalid_value` errors located by `where`. */
function checkVideo(raw: RawVideo, where: MessageParams, errors: ImportError[]): Omit<ExportVideo, 'fileName'> | null {
  const start = errors.length;
  const sha = typeof raw.sha256 === 'string' ? raw.sha256.trim().toLowerCase() : '';
  if (!SHA256_PATTERN.test(sha)) errors.push(invalidValue(where, 'video_sha256', raw.sha256));
  const { frameCount, durationUs } = raw;
  if (typeof frameCount !== 'number' || !isNonNegativeInteger(frameCount) || frameCount === 0) {
    errors.push(invalidValue(where, 'frame_count', frameCount));
  }
  if (typeof durationUs !== 'number' || !isNonNegativeInteger(durationUs)) {
    errors.push(invalidValue(where, 'duration_us', durationUs));
  }
  if (errors.length > start) return null;
  return { sha256: sha, frameCount: frameCount as number, durationUs: durationUs as number };
}

function invalidValue(where: MessageParams, field: string, value: unknown): ImportError {
  return { code: 'invalid_value', params: { ...where, field, value: displayValue(value) } };
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(value) ?? String(value);
}

// --- CSV ----------------------------------------------------------------------------------------

type ColumnMap = Record<CsvColumn, number>;

function stripBom(cell: string): string {
  return cell.startsWith(UTF8_BOM) ? cell.slice(1) : cell;
}

function mapHeader(cells: readonly string[]): { map: ColumnMap } | { error: ImportError } {
  const names = cells.map((c, i) => (i === 0 ? stripBom(c) : c).trim());
  const known = new Set<string>(CSV_HEADER);
  const missing = CSV_HEADER.filter((h) => !names.includes(h));
  const unexpected = names.filter((n, i) => !known.has(n) || names.indexOf(n) !== i);
  if (missing.length || unexpected.length) {
    return {
      error: {
        code: 'unknown_header',
        params: { missing: missing.join(', '), unexpected: unexpected.join(', '), expected: CSV_HEADER.join(',') },
      },
    };
  }
  const map = {} as ColumnMap;
  for (const h of CSV_HEADER) map[h] = names.indexOf(h);
  return { map };
}

function isHeaderRow(cells: readonly string[], map: ColumnMap): boolean {
  return CSV_HEADER.every((h) => {
    const cell = cells[map[h]];
    return cell !== undefined && (map[h] === 0 ? stripBom(cell) : cell).trim() === h;
  });
}

interface CsvVideoRow {
  version: string;
  video: Omit<ExportVideo, 'fileName'>;
}

function parseCsvFile(text: string, sourceName: string): ParseResult {
  const parsed = parseCsv(text);
  if (!parsed.ok) return fail([{ code: 'csv_malformed', params: { line: parsed.error.line } }]);
  const [headerRow, ...dataRows] = parsed.rows;
  if (!headerRow) return fail([{ code: 'empty_file', params: { file: sourceName } }]);
  const header = mapHeader(headerRow.cells);
  if ('error' in header) return fail([header.error]);
  const { map } = header;

  const errors: ImportError[] = [];
  const records: ParsedRecord[] = [];
  let reference: (CsvVideoRow & { line: number }) | null = null;
  let dataRowCount = 0;

  for (const row of dataRows) {
    if (isHeaderRow(row.cells, map)) continue;
    dataRowCount++;
    if (row.cells.length !== CSV_HEADER.length) {
      errors.push({ code: 'column_count', params: { line: row.line, expected: CSV_HEADER.length, found: row.cells.length } });
      continue;
    }
    const cell = (c: CsvColumn): string => row.cells[map[c]];
    const videoRow = parseCsvVideo(cell, row.line, errors);
    if (videoRow) {
      if (!reference) reference = { ...videoRow, line: row.line };
      else compareVideoRows(reference, videoRow, row.line, errors);
    }
    const record = parseCsvSegment(cell, row, records.length + 1, errors);
    if (record) records.push(record);
  }

  if (dataRowCount === 0) errors.push({ code: 'no_rows', params: {} });
  if (errors.length || !reference) return fail(errors);
  return {
    ok: true,
    file: {
      format: 'csv',
      formatVersion: FORMAT_VERSION,
      sourceName,
      video: { ...reference.video, fileName: null },
      records,
    },
  };
}

function parseCsvVideo(cell: (c: CsvColumn) => string, line: number, errors: ImportError[]): CsvVideoRow | null {
  const version = cell('format_version').trim();
  if (version !== String(FORMAT_VERSION)) {
    errors.push({ code: 'unsupported_version', params: { line, version } });
    return null;
  }
  const where = { line };
  const num = (c: 'frame_count' | 'duration_us'): number | string => parseNumber(cell(c)) ?? cell(c);
  const video = checkVideo({ sha256: cell('video_sha256'), frameCount: num('frame_count'), durationUs: num('duration_us') }, where, errors);
  return video ? { version, video } : null;
}

function compareVideoRows(ref: CsvVideoRow & { line: number }, row: CsvVideoRow, line: number, errors: ImportError[]): void {
  const fields: [string, string | number, string | number][] = [
    ['video_sha256', ref.video.sha256, row.video.sha256],
    ['frame_count', ref.video.frameCount, row.video.frameCount],
    ['duration_us', ref.video.durationUs, row.video.durationUs],
  ];
  for (const [field, expected, found] of fields) {
    if (expected !== found) {
      errors.push({ code: 'mixed_video_metadata', params: { line, field, expected, found, firstLine: ref.line } });
    }
  }
}

/** Returns a record, or null for an empty-annotation row or a row with errors. */
function parseCsvSegment(
  cell: (c: CsvColumn) => string,
  row: CsvRow,
  ordinal: number,
  errors: ImportError[],
): ParsedRecord | null {
  if (SEGMENT_COLUMNS.every((c) => cell(c).trim() === '')) return null;
  const where = { line: row.line, segment: ordinal };
  const start = errors.length;
  const text = (c: 'phase_id' | 'phase_name'): string => unprotectFormula(cell(c));
  const num = (c: 'start_frame' | 'end_frame' | 'start_us' | 'end_us'): number => {
    const raw = cell(c);
    if (raw.trim() === '') {
      errors.push({ code: 'missing_field', params: { ...where, field: c } });
      return NaN;
    }
    const n = parseNumber(raw);
    if (n === null) errors.push(invalidValue(where, c, raw));
    return n ?? NaN;
  };
  const phaseId = text('phase_id');
  if (!isValidPhaseId(phaseId)) errors.push(invalidValue(where, 'phase_id', phaseId));
  const record: ParsedRecord = {
    phaseId,
    phaseName: text('phase_name'),
    startFrame: num('start_frame'),
    endFrame: num('end_frame'),
    startUs: num('start_us'),
    endUs: num('end_us'),
    ordinal,
    line: row.line,
  };
  return errors.length > start ? null : record;
}

// --- JSON ---------------------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseJsonFile(text: string, sourceName: string): ParseResult {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (e) {
    return fail([{ code: 'invalid_json', params: { message: e instanceof Error ? e.message : String(e) } }]);
  }
  if (!isObject(root) || root.format !== FORMAT_NAME) {
    return fail([{ code: 'unsupported_format', params: { format: displayValue(isObject(root) ? root.format : root) } }]);
  }
  if (root.format_version !== FORMAT_VERSION) {
    return fail([{ code: 'unsupported_version', params: { version: displayValue(root.format_version) } }]);
  }
  const errors: ImportError[] = [];
  const video = parseJsonVideo(root.video, errors);
  const records = parseJsonSegments(root.segments, errors);
  if (errors.length || !video || !records) return fail(errors);
  return { ok: true, file: { format: 'json', formatVersion: FORMAT_VERSION, sourceName, video, records } };
}

function parseJsonVideo(raw: unknown, errors: ImportError[]): ExportVideo | null {
  if (!isObject(raw)) {
    errors.push({ code: 'missing_field', params: { field: 'video' } });
    return null;
  }
  for (const field of ['sha256', 'frame_count', 'duration_us']) {
    if (!(field in raw)) errors.push({ code: 'missing_field', params: { field: `video.${field}` } });
  }
  const fileName = raw.file_name;
  if (fileName !== undefined && fileName !== null && typeof fileName !== 'string') {
    errors.push(invalidValue({}, 'video.file_name', fileName));
  }
  const video = checkVideo({ sha256: raw.sha256, frameCount: raw.frame_count, durationUs: raw.duration_us }, {}, errors);
  return video ? { ...video, fileName: typeof fileName === 'string' ? fileName : null } : null;
}

function parseJsonSegments(raw: unknown, errors: ImportError[]): ParsedRecord[] | null {
  if (!Array.isArray(raw)) {
    errors.push({ code: 'missing_field', params: { field: 'segments' } });
    return null;
  }
  const records: ParsedRecord[] = [];
  raw.forEach((item: unknown, i) => {
    const record = parseJsonSegment(item, i + 1, errors);
    if (record) records.push(record);
  });
  return records;
}

function parseJsonSegment(item: unknown, ordinal: number, errors: ImportError[]): ParsedRecord | null {
  const where = { segment: ordinal };
  if (!isObject(item)) {
    errors.push(invalidValue(where, 'segment', item));
    return null;
  }
  const start = errors.length;
  const read = (name: string, ok: (v: unknown) => boolean): unknown => {
    const v = item[name];
    if (v === undefined) errors.push({ code: 'missing_field', params: { ...where, field: name } });
    else if (!ok(v)) errors.push(invalidValue(where, name, v));
    return v;
  };
  const isString = (v: unknown): boolean => typeof v === 'string';
  const isNumber = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
  const phaseId = read('phase_id', (v) => typeof v === 'string' && isValidPhaseId(v));
  const phaseName = read('phase_name', isString);
  const nums = (['start_frame', 'end_frame', 'start_us', 'end_us'] as const).map((f) => read(f, isNumber));
  if (errors.length > start) return null;
  const [startFrame, endFrame, startUs, endUs] = nums as number[];
  return { phaseId: phaseId as string, phaseName: phaseName as string, startFrame, endFrame, startUs, endUs, ordinal, line: null };
}

// --- Verification -------------------------------------------------------------------------------

function locate(r: ParsedRecord): MessageParams {
  return r.line === null ? { segment: r.ordinal } : { segment: r.ordinal, line: r.line };
}

/**
 * Checks, in order: sha256, frame_count, duration_us, then per segment integers, range, emptiness
 * and exact boundary times, then overlaps and consistent phase names per id. Reports everything.
 */
export function verifyAgainstVideo(parsed: ParsedAnnotation, video: VideoIdentity): VerifyResult {
  const problems: VerifyProblem[] = [];
  const meta: [VerifyProblem['code'], string | number, string | number][] = [
    ['sha256_mismatch', video.sha256.toLowerCase(), parsed.video.sha256],
    ['frame_count_mismatch', video.frameCount, parsed.video.frameCount],
    ['duration_mismatch', video.durationUs, parsed.video.durationUs],
  ];
  for (const [code, expected, found] of meta) {
    if (expected !== found) problems.push({ code, params: { expected, found } });
  }

  const inRange: ParsedRecord[] = [];
  for (const r of parsed.records) {
    if (checkRecord(r, video, problems)) inRange.push(r);
  }
  problems.push(...findOverlaps(inRange), ...findNameConflicts(parsed.records));
  return problems.length ? { ok: false, problems } : { ok: true };
}

/** Per-record checks; returns true when the record is a valid in-range range (for overlap checks). */
function checkRecord(r: ParsedRecord, video: VideoIdentity, problems: VerifyProblem[]): boolean {
  const where = locate(r);
  const ints: [string, number][] = [
    ['start_frame', r.startFrame],
    ['end_frame', r.endFrame],
    ['start_us', r.startUs],
    ['end_us', r.endUs],
  ];
  let integral = true;
  for (const [field, value] of ints) {
    if (!Number.isSafeInteger(value)) {
      problems.push({ code: 'not_integer', params: { ...where, field, value } });
      if (field.endsWith('_frame')) integral = false;
    }
  }
  if (!integral) return false;
  const N = video.frameCount;
  const range = { ...where, start: r.startFrame, end: r.endFrame, frameCount: N };
  if (r.startFrame < 0 || r.endFrame > N) {
    problems.push({ code: 'out_of_range', params: range });
    return false;
  }
  if (r.endFrame <= r.startFrame) {
    problems.push({ code: 'empty', params: range });
    return false;
  }
  const times: [string, number, number][] = [
    ['start_us', video.boundaryUs(r.startFrame), r.startUs],
    ['end_us', video.boundaryUs(r.endFrame), r.endUs],
  ];
  for (const [field, expected, found] of times) {
    if (expected !== found) problems.push({ code: 'time_mismatch', params: { ...where, field, expected, found } });
  }
  return true;
}

function findOverlaps(records: readonly ParsedRecord[]): VerifyProblem[] {
  const sorted = [...records].sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame);
  const problems: VerifyProblem[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    for (let j = i + 1; j < sorted.length && sorted[j].startFrame < a.endFrame; j++) {
      const b = sorted[j];
      problems.push({
        code: 'overlap',
        params: { a: a.ordinal, b: b.ordinal, from: b.startFrame, to: Math.min(a.endFrame, b.endFrame) },
      });
    }
  }
  return problems;
}

function findNameConflicts(records: readonly ParsedRecord[]): VerifyProblem[] {
  const names = new Map<string, string[]>();
  for (const r of records) {
    const list = names.get(r.phaseId) ?? [];
    if (!list.includes(r.phaseName)) list.push(r.phaseName);
    names.set(r.phaseId, list);
  }
  return [...names]
    .filter(([, list]) => list.length > 1)
    .map(([phaseId, list]) => ({ code: 'inconsistent_phase_name', params: { phaseId, names: list.join(' | ') } }));
}

// --- Conversion ---------------------------------------------------------------------------------

/** Turns a verified file into sorted segments (fresh ids) and the phases it references. */
export function toSegments(
  parsed: ParsedAnnotation,
  makeId: () => string = newSegmentId,
): { segments: Segment[]; phases: { id: string; name: string }[] } {
  const segments = sortSegments(
    parsed.records.map((r) => ({ id: makeId(), phaseId: r.phaseId, start: r.startFrame, end: r.endFrame })),
  );
  const phases = new Map<string, string>();
  for (const r of parsed.records) if (!phases.has(r.phaseId)) phases.set(r.phaseId, r.phaseName || r.phaseId);
  return { segments, phases: [...phases].map(([id, name]) => ({ id, name })) };
}
