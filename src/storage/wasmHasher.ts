/** hash-wasm SHA-256 adapter for the hashing core. */
import { createSHA256 } from 'hash-wasm';
import type { IncrementalHasher } from './hashCore';

export async function createWasmSha256(): Promise<IncrementalHasher> {
  const hasher = await createSHA256();
  hasher.init();
  return {
    update: (data) => void hasher.update(data),
    digestHex: () => hasher.digest('hex'),
  };
}
