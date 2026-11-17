/** Batch list ordering. */
import { comparePaths } from './names';

export type SortKey = 'name' | 'mtime' | 'size';
export type SortDir = 'asc' | 'desc';

export interface SortableEntry {
  readonly relPath: string;
  readonly size: number;
  readonly lastModified: number;
}

function primary(key: SortKey, a: SortableEntry, b: SortableEntry): number {
  switch (key) {
    case 'name':
      return comparePaths(a.relPath, b.relPath);
    case 'mtime':
      return a.lastModified - b.lastModified;
    case 'size':
      return a.size - b.size;
  }
}

/**
 * Returns a new array sorted by relative path (natural, case-insensitive), modification time or
 * size. Ties on time/size fall back to ascending path order regardless of `dir`, so the order is
 * stable and predictable.
 */
export function sortEntries<T extends SortableEntry>(entries: readonly T[], key: SortKey, dir: SortDir = 'asc'): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => sign * primary(key, a, b) || comparePaths(a.relPath, b.relPath));
}
