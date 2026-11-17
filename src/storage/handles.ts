/** Persisted FileSystemDirectoryHandles for "reconnect folder" (SPEC §5). */
import { defaultDb, singleRequest, type DbProvider } from './db';

export interface HandleRecord {
  id: string;
  /** Structured-cloned into IndexedDB; permission must be re-requested after a reload. */
  handle: FileSystemDirectoryHandle;
  name: string;
  savedAt: number;
}

export interface HandleStoreOptions {
  db?: DbProvider;
  now?: () => number;
}

export class HandleStore {
  private readonly db: DbProvider;
  private readonly now: () => number;

  constructor(options: HandleStoreOptions = {}) {
    this.db = options.db ?? defaultDb;
    this.now = options.now ?? Date.now;
  }

  async put(id: string, handle: FileSystemDirectoryHandle): Promise<HandleRecord> {
    const record: HandleRecord = { id, handle, name: handle.name, savedAt: this.now() };
    await singleRequest(this.db, 'handles', 'readwrite', (s) => s.put(record));
    return record;
  }

  async get(id: string): Promise<FileSystemDirectoryHandle | null> {
    const rec = await singleRequest<HandleRecord | undefined>(this.db, 'handles', 'readonly', (s) => s.get(id));
    return rec?.handle ?? null;
  }

  /** Newest first. */
  async list(): Promise<HandleRecord[]> {
    const all = await singleRequest<HandleRecord[]>(this.db, 'handles', 'readonly', (s) => s.getAll());
    return all.sort((a, b) => b.savedAt - a.savedAt);
  }

  async delete(id: string): Promise<void> {
    await singleRequest(this.db, 'handles', 'readwrite', (s) => s.delete(id));
  }
}
