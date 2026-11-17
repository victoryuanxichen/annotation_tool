/** Messages between `hashing.ts` and `hash.worker.ts`. */
import type { HashPriority } from './hashCore';

export type HashWorkerRequest =
  | { type: 'sha256'; id: number; key: string; file: Blob; priority: HashPriority }
  | { type: 'fingerprint'; id: number; file: Blob }
  | { type: 'cancel'; id: number };

export interface SerializedError {
  name: string;
  message: string;
}

export type HashWorkerResponse =
  | { type: 'progress'; id: number; done: number; total: number }
  | { type: 'result'; id: number; value: string }
  | { type: 'error'; id: number; error: SerializedError };

export function serializeError(e: unknown): SerializedError {
  if (typeof e === 'object' && e !== null) {
    const { name, message } = e as { name?: unknown; message?: unknown };
    return { name: typeof name === 'string' ? name : 'Error', message: typeof message === 'string' ? message : String(e) };
  }
  return { name: 'Error', message: String(e) };
}

export function deserializeError(e: SerializedError): Error {
  if (e.name === 'AbortError') return new DOMException(e.message, 'AbortError') as unknown as Error;
  const err = new Error(e.message);
  err.name = e.name;
  return err;
}
