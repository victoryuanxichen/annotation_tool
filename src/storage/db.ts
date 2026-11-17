/** IndexedDB connection management and small promise helpers (SPEC §5). */

export const DB_NAME = 'phase-annotator';
export const DB_VERSION = 1;

export type StoreName = 'drafts' | 'checkpoints' | 'kv' | 'handles' | 'hashCache';

/** Lazily yields an open database; every store accepts one so tests can isolate databases. */
export type DbProvider = () => Promise<IDBDatabase>;

export interface OpenDbOptions {
  /** Database name; defaults to `phase-annotator`. Tests use unique names. */
  name?: string;
  /** Defaults to `globalThis.indexedDB`. */
  factory?: IDBFactory;
  /** Called when the open request is blocked by another connection on an older version. */
  onBlocked?: () => void;
}

export class StorageUnavailableError extends Error {
  constructor(message = 'IndexedDB is not available in this browser') {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

const connections = new Map<string, Promise<IDBDatabase>>();

/**
 * Opens (or reuses) the connection for `name`. The cached connection is dropped when it closes or
 * another context requests a version change, so the next call reconnects transparently.
 */
export function openDb(options: OpenDbOptions = {}): Promise<IDBDatabase> {
  const name = options.name ?? DB_NAME;
  const cached = connections.get(name);
  if (cached) return cached;

  const forget = (): void => {
    if (connections.get(name) === pending) connections.delete(name);
  };
  const pending = connect(name, options, forget);
  connections.set(name, pending);
  pending.catch(forget);
  return pending;
}

/** Default provider for the app database. */
export const defaultDb: DbProvider = () => openDb();

function connect(name: string, options: OpenDbOptions, onGone: () => void): Promise<IDBDatabase> {
  const factory = options.factory ?? globalThis.indexedDB;
  if (!factory) return Promise.reject(new StorageUnavailableError());

  return new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(name, DB_VERSION);
    } catch (e) {
      reject(e instanceof Error ? e : new StorageUnavailableError(String(e)));
      return;
    }
    req.onupgradeneeded = (ev) => upgrade(req.result, ev.oldVersion);
    req.onblocked = () => options.onBlocked?.();
    req.onerror = () => reject(req.error ?? new StorageUnavailableError('Failed to open database'));
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        onGone();
      };
      db.onclose = onGone;
      resolve(db);
    };
  });
}

function upgrade(db: IDBDatabase, oldVersion: number): void {
  if (oldVersion < 1) {
    const drafts = db.createObjectStore('drafts', { keyPath: 'key' });
    drafts.createIndex('fingerprint', 'fingerprint', { unique: false });
    drafts.createIndex('sha256', 'sha256', { unique: false });
    const checkpoints = db.createObjectStore('checkpoints', { keyPath: 'id' });
    checkpoints.createIndex('videoKey', 'videoKey', { unique: false });
    db.createObjectStore('kv', { keyPath: 'k' });
    db.createObjectStore('handles', { keyPath: 'id' });
    db.createObjectStore('hashCache', { keyPath: 'k' });
  }
}

/** Closes and forgets the cached connection (tests, or before deleting the database). */
export async function closeDb(name: string = DB_NAME): Promise<void> {
  const cached = connections.get(name);
  connections.delete(name);
  if (!cached) return;
  try {
    (await cached).close();
  } catch {
    // The open had failed; nothing to close.
  }
}

export async function deleteDb(name: string = DB_NAME, factory: IDBFactory = globalThis.indexedDB): Promise<void> {
  await closeDb(name);
  await requestToPromise(factory.deleteDatabase(name));
}

export function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/** Resolves once the transaction commits; rejects if it errors or aborts. */
export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError'));
  });
}

/**
 * Runs `body` inside one transaction. `body` must issue its requests with callbacks (no awaits
 * between requests, which could let the transaction auto-commit) and return a getter for the
 * result, read only after the transaction has committed.
 */
export async function runTransaction<T>(
  provider: DbProvider,
  stores: StoreName | StoreName[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => () => T,
): Promise<T> {
  const db = await provider();
  const tx = db.transaction(stores, mode);
  const done = transactionDone(tx);
  let read: () => T;
  try {
    read = body(tx);
  } catch (e) {
    try {
      tx.abort();
    } catch {
      // Already finished.
    }
    done.catch(() => undefined);
    throw e;
  }
  await done;
  return read();
}

/** One request against one store; resolves with its result after the transaction commits. */
export function singleRequest<T>(
  provider: DbProvider,
  store: StoreName,
  mode: IDBTransactionMode,
  makeRequest: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return runTransaction(provider, store, mode, (tx) => {
    let result: T;
    const req = makeRequest(tx.objectStore(store));
    req.onsuccess = () => {
      result = req.result;
    };
    return () => result;
  });
}
