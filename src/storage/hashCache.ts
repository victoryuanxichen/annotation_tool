/** IndexedDB cache of full-file SHA-256 results keyed by file identity (SPEC §4). */
import { defaultDb, singleRequest, type DbProvider } from './db';

export interface FileIdentity {
  name: string;
  size: number;
  lastModified: number;
}

export interface HashCacheEntry {
  k: string;
  sha256: string;
  at: number;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/** `name|size|lastModified|relPath` (relPath empty when unknown). */
export function hashCacheKey(file: FileIdentity, relPath?: string | null): string {
  return `${file.name}|${file.size}|${file.lastModified}|${relPath ?? ''}`;
}

export interface HashCacheOptions {
  db?: DbProvider;
  now?: () => number;
}

export class HashCache {
  private readonly db: DbProvider;
  private readonly now: () => number;

  constructor(options: HashCacheOptions = {}) {
    this.db = options.db ?? defaultDb;
    this.now = options.now ?? Date.now;
  }

  async get(key: string): Promise<string | null> {
    const row = await singleRequest<HashCacheEntry | undefined>(this.db, 'hashCache', 'readonly', (s) => s.get(key));
    return row && SHA256_RE.test(row.sha256) ? row.sha256 : null;
  }

  async put(key: string, sha256: string): Promise<void> {
    if (!SHA256_RE.test(sha256)) throw new TypeError('Not a lowercase sha256 hex digest');
    const row: HashCacheEntry = { k: key, sha256, at: this.now() };
    await singleRequest(this.db, 'hashCache', 'readwrite', (s) => s.put(row));
  }

  async delete(key: string): Promise<void> {
    await singleRequest(this.db, 'hashCache', 'readwrite', (s) => s.delete(key));
  }
}
