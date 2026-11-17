/** JSON form of export format v1: UTF-8 without BOM, one segment object per line. */
import { FORMAT_NAME, FORMAT_VERSION, type ExportDocument, type ExportRecord } from './types';

type JsonScalar = string | number | null;

/** `{"a": 1, "b": "x"}` — single-line object with a space after `:` and `,`. */
function inlineObject(entries: readonly (readonly [string, JsonScalar])[]): string {
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')}}`;
}

function recordLine(r: ExportRecord): string {
  return inlineObject([
    ['phase_id', r.phaseId],
    ['phase_name', r.phaseName],
    ['start_frame', r.startFrame],
    ['end_frame', r.endFrame],
    ['start_us', r.startUs],
    ['end_us', r.endUs],
  ]);
}

export function serializeJson(doc: ExportDocument): string {
  const { video } = doc;
  const videoLine = inlineObject([
    ['sha256', video.sha256],
    ['frame_count', video.frameCount],
    ['duration_us', video.durationUs],
    ['file_name', video.fileName],
  ]);
  const segments = doc.records.length
    ? `[\n${doc.records.map((r) => `    ${recordLine(r)}`).join(',\n')}\n  ]`
    : '[]';
  return [
    '{',
    `  "format": ${JSON.stringify(FORMAT_NAME)},`,
    `  "format_version": ${FORMAT_VERSION},`,
    `  "video": ${videoLine},`,
    `  "segments": ${segments}`,
    '}',
    '',
  ].join('\n');
}
