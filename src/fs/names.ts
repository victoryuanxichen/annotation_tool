/** Pure helpers for file names: classification, stems, sidecar matching and natural ordering. */
import type { SidecarFormat } from './types';

const VIDEO_EXT = /\.(mp4|m4v)$/i;
const SIDECAR_EXT = /\.(csv|json)$/i;
const SIDECAR_STEM_SEPARATORS = new Set(['.', '_', '-', ' ']);
const SKIPPED_DIRS = new Set(['node_modules']);

/** Hidden entries (dot files, e.g. `.DS_Store`, `.git`, Chromium `.crswap` temp files). */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.');
}

export function isSkippedDirName(name: string): boolean {
  return isHiddenName(name) || SKIPPED_DIRS.has(name.toLowerCase());
}

export function isVideoName(name: string): boolean {
  return !isHiddenName(name) && VIDEO_EXT.test(name);
}

export function sidecarFormatOf(name: string): SidecarFormat | null {
  if (isHiddenName(name)) return null;
  const m = SIDECAR_EXT.exec(name);
  return m ? (m[1].toLowerCase() as SidecarFormat) : null;
}

/** Name without its final extension (`case.v2.mp4` → `case.v2`). */
export function stemOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * True when `fileName` is a sidecar candidate for a video with `stem`: a .csv/.json whose name
 * starts with the stem (case-insensitive) immediately followed by `.`, `_`, `-` or space.
 * `case.csv`, `case.phases.csv`, `case_annotations.json` match `case`; `case2.csv` does not.
 */
export function isSidecarFor(stem: string, fileName: string): boolean {
  if (sidecarFormatOf(fileName) === null || stem.length === 0) return false;
  if (fileName.length <= stem.length) return false;
  if (fileName.slice(0, stem.length).toLowerCase() !== stem.toLowerCase()) return false;
  return SIDECAR_STEM_SEPARATORS.has(fileName[stem.length]);
}

/**
 * True when `fileName` is a sidecar of video `videoName` in a folder whose files are `siblings`
 * (the names of all files in that folder; `videoName` may or may not be among them). A candidate
 * that several videos match belongs to the one(s) with the longest stem, so `case_2.csv` and
 * `case.v2.phases.csv` belong to `case_2.mp4` / `case.v2.mp4`, not to `case.mp4`.
 */
export function ownsSidecar(videoName: string, fileName: string, siblings: Iterable<string>): boolean {
  const stem = stemOf(videoName);
  if (!isSidecarFor(stem, fileName)) return false;
  for (const other of siblings) {
    if (other === videoName || !isVideoName(other)) continue;
    const otherStem = stemOf(other);
    if (otherStem.length > stem.length && isSidecarFor(otherStem, fileName)) return false;
  }
  return true;
}

/** The sidecars of `videoName` among `fileNames` (all files of its folder), by `ownsSidecar`. */
export function sidecarNamesFor(videoName: string, fileNames: readonly string[]): string[] {
  return fileNames.filter((n) => ownsSidecar(videoName, n, fileNames));
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Case-insensitive, numeric-aware comparison (`case2` < `case10`), with a deterministic tiebreak. */
export function naturalCompare(a: string, b: string): number {
  const c = collator.compare(a, b);
  if (c !== 0) return c;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compares forward-slash paths segment by segment so folder boundaries sort predictably. */
export function comparePaths(a: string, b: string): number {
  const as = a.split('/');
  const bs = b.split('/');
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const c = naturalCompare(as[i], bs[i]);
    if (c !== 0) return c;
  }
  return as.length - bs.length;
}
