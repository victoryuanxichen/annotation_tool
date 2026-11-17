/** Persistent-storage request and quota estimate (SPEC §5). */

export interface StorageEstimateInfo {
  usage: number;
  quota: number;
  persisted: boolean | null;
}

type StorageManagerLike = Pick<StorageManager, 'persist' | 'persisted' | 'estimate'>;

let persistRequest: Promise<boolean> | null = null;

function storageManager(): StorageManagerLike | null {
  return typeof navigator !== 'undefined' && navigator.storage ? navigator.storage : null;
}

/** Asks once per page load for persistent storage; resolves false on any failure. */
export function requestPersistence(manager: StorageManagerLike | null = storageManager()): Promise<boolean> {
  persistRequest ??= (async () => {
    if (!manager?.persist) return false;
    try {
      return await manager.persist();
    } catch {
      return false;
    }
  })();
  return persistRequest;
}

export async function estimate(manager: StorageManagerLike | null = storageManager()): Promise<StorageEstimateInfo | null> {
  if (!manager?.estimate) return null;
  try {
    const [est, persisted] = await Promise.all([
      manager.estimate(),
      manager.persisted ? manager.persisted().catch(() => null) : Promise.resolve(null),
    ]);
    return { usage: est.usage ?? 0, quota: est.quota ?? 0, persisted };
  } catch {
    return null;
  }
}
