/** Builds and serializes export format v1 (SPEC §2.1). */
import { sortSegments } from '../annotations';
import type { Segment, VideoMeta } from '../types';
import { protectFormula, writeCsv } from './csv';
import { CSV_HEADER, FORMAT_VERSION, type ExportDocument, type ExportRecord, type SidecarFormat } from './types';

export { serializeJson } from './json';

/**
 * Converts segments to export records ordered by start frame. Call `validateForExport` first:
 * a segment whose phase has no name is a programming error and throws.
 */
export function buildExportRecords(
  meta: VideoMeta,
  segments: readonly Segment[],
  phaseNameOf: (phaseId: string) => string | undefined,
  boundaryUs: (b: number) => number,
): ExportDocument {
  const records: ExportRecord[] = sortSegments(segments).map((s) => {
    const phaseName = phaseNameOf(s.phaseId);
    if (phaseName === undefined) throw new Error(`Unknown phase "${s.phaseId}" in segment ${s.id}`);
    return {
      phaseId: s.phaseId,
      phaseName,
      startFrame: s.start,
      endFrame: s.end,
      startUs: boundaryUs(s.start),
      endUs: boundaryUs(s.end),
    };
  });
  return {
    video: { sha256: meta.sha256, frameCount: meta.frameCount, durationUs: meta.durationUs, fileName: meta.fileName },
    records,
  };
}

/** CSV with BOM and CRLF. An empty annotation is one row with only the video columns filled. */
export function serializeCsv(doc: ExportDocument): string {
  const { video } = doc;
  const videoCells = [String(FORMAT_VERSION), video.sha256, String(video.frameCount), String(video.durationUs)];
  const rows: string[][] = [[...CSV_HEADER]];
  if (doc.records.length === 0) rows.push([...videoCells, '', '', '', '', '', '']);
  for (const r of doc.records) {
    rows.push([
      ...videoCells,
      protectFormula(r.phaseId),
      protectFormula(r.phaseName),
      String(r.startFrame),
      String(r.endFrame),
      String(r.startUs),
      String(r.endUs),
    ]);
  }
  return writeCsv(rows);
}

/** File name without directories and its last extension (`a/b/case.v2.mp4` → `case.v2`). */
export function videoStem(videoFileName: string): string {
  const base = videoFileName.split(/[\\/]/).pop() ?? videoFileName;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

export function defaultSidecarName(videoFileName: string, format: SidecarFormat): string {
  return `${videoStem(videoFileName)}.phases.${format}`;
}
