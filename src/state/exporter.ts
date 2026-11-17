/**
 * Writes an export (CSV and/or JSON) to its destination without ever clobbering a file that belongs
 * to another video: an existing target is overwritten only when it parses as an annotation export
 * with the same video SHA-256.
 */
import type { Segment } from '../core/types';
import { buildExportRecords, defaultSidecarName, serializeCsv, serializeJson } from '../core/formats/export';
import { parseAnnotationFile } from '../core/formats/import';
import type { ExportDocument, SidecarFormat } from '../core/formats/types';
import { handleDir, joinRelPath, type DirRef, type HandleDirRef } from '../fs/types';
import { mapWriteError } from '../fs/write';
import type { ExportTarget } from '../storage';
import type { Msg } from './contract';
import type { FsDeps } from './deps';
import { msg, writeFailureMsg } from './messages';

export type ExportPlace =
  | { kind: 'beside'; dir: DirRef | null }
  /** `subdirs`: the video's directories relative to the batch root, mirrored under the folder. */
  | { kind: 'folder'; root: HandleDirRef | null; subdirs: readonly string[] }
  | { kind: 'download' };

export interface ExportJob {
  video: { sha256: string; frameCount: number; durationUs: number; fileName: string };
  segments: readonly Segment[];
  phaseNameOf: (phaseId: string) => string | undefined;
  boundaryUs: (b: number) => number;
  formats: readonly SidecarFormat[];
  place: ExportPlace;
  /** Whether permission prompts are allowed (call made from a user gesture). */
  request: boolean;
}

export type ExportResult = { ok: true; targets: ExportTarget[] } | { ok: false; msg: Msg; canDownload: boolean };

const MIME: Record<SidecarFormat, string> = { csv: 'text/csv;charset=utf-8', json: 'application/json;charset=utf-8' };

export function formatsFor(choice: 'csv' | 'json' | 'both'): SidecarFormat[] {
  return choice === 'both' ? ['csv', 'json'] : [choice];
}

function serialize(doc: ExportDocument, format: SidecarFormat): string {
  return format === 'csv' ? serializeCsv(doc) : serializeJson(doc);
}

async function resolveFolder(
  fs: FsDeps,
  root: HandleDirRef,
  subdirs: readonly string[],
  request: boolean,
): Promise<{ ok: true; dir: HandleDirRef } | { ok: false; msg: Msg }> {
  if (!(await fs.ensurePermission(root.handle, 'readwrite', { request }))) {
    return { ok: false, msg: writeFailureMsg('permission_denied', '') };
  }
  try {
    let handle = root.handle;
    for (const name of subdirs) handle = await handle.getDirectoryHandle(name, { create: true });
    return { ok: true, dir: handleDir(handle, [root.name, ...subdirs]) };
  } catch (e) {
    const f = mapWriteError(e);
    return { ok: false, msg: writeFailureMsg(f.reason, f.message) };
  }
}

/** Refuses to overwrite files that are unreadable as exports or belong to another video. */
async function checkExisting(fs: FsDeps, dir: DirRef, name: string, sha256: string): Promise<Msg | null> {
  let text: string | null;
  try {
    text = await fs.readTextIfExists(dir, name);
  } catch {
    return msg('ctl.export.readFailed', { file: name });
  }
  if (text === null) return null;
  const parsed = parseAnnotationFile(text, name);
  if (!parsed.ok) return msg('ctl.export.targetUnparseable', { file: name });
  if (parsed.file.video.sha256.toLowerCase() !== sha256.toLowerCase()) return msg('ctl.export.targetOtherVideo', { file: name });
  return null;
}

export async function runExport(fs: FsDeps, job: ExportJob): Promise<ExportResult> {
  const doc = buildExportRecords(
    { sha256: job.video.sha256, frameCount: job.video.frameCount, durationUs: job.video.durationUs, fileName: job.video.fileName },
    job.segments,
    job.phaseNameOf,
    job.boundaryUs,
  );
  const files = job.formats.map((format) => ({ format, name: defaultSidecarName(job.video.fileName, format), text: serialize(doc, format) }));

  if (job.place.kind === 'download') {
    try {
      for (const f of files) fs.downloadText(f.name, f.text, MIME[f.format]);
    } catch (e) {
      const f = mapWriteError(e);
      return { ok: false, msg: writeFailureMsg(f.reason, f.message), canDownload: false };
    }
    return { ok: true, targets: files.map((f) => ({ label: f.name, format: f.format })) };
  }

  let dir: DirRef;
  if (job.place.kind === 'beside') {
    if (!job.place.dir) return { ok: false, msg: msg('ctl.export.noSourceFolder'), canDownload: true };
    dir = job.place.dir;
  } else {
    if (!job.place.root) return { ok: false, msg: msg('ctl.export.noExportFolder'), canDownload: true };
    const r = await resolveFolder(fs, job.place.root, job.place.subdirs, job.request);
    if (!r.ok) return { ok: false, msg: r.msg, canDownload: true };
    dir = r.dir;
  }

  for (const f of files) {
    const problem = await checkExisting(fs, dir, f.name, job.video.sha256);
    if (problem) return { ok: false, msg: problem, canDownload: true };
  }
  const targets: ExportTarget[] = [];
  for (const f of files) {
    const res = await fs.writeTextFile(dir, f.name, f.text, { request: job.request });
    if (!res.ok) return { ok: false, msg: writeFailureMsg(res.reason, res.message), canDownload: true };
    targets.push({ label: joinRelPath(dir.path, f.name), format: f.format });
  }
  return { ok: true, targets };
}
