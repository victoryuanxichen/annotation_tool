/**
 * Deterministic large test videos: a fixture followed by one top-level MP4 `free` box of zeros.
 * The video track is unchanged (same frames, pts and duration); only size and SHA-256 differ.
 * The file is assembled inside OPFS (no large file on disk) and its SHA-256 computed here in node
 * from the same bytes.
 */
import type { Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CHUNK = 16 * 1024 * 1024;

function freeBoxHeader(padBytes: number): Uint8Array {
  const size = padBytes + 8;
  if (size > 0xffffffff) throw new RangeError('pad too large for a 32-bit box');
  const h = new Uint8Array(8);
  new DataView(h.buffer).setUint32(0, size);
  h.set([0x66, 0x72, 0x65, 0x65], 4); // 'free'
  return h;
}

export function paddedSha256(fixture: string, padBytes: number): string {
  const hash = createHash('sha256');
  hash.update(readFileSync(fileURLToPath(new URL(`../../fixtures/videos/${fixture}`, import.meta.url))));
  hash.update(freeBoxHeader(padBytes));
  const zeros = new Uint8Array(CHUNK);
  for (let left = padBytes; left > 0; left -= CHUNK) hash.update(left >= CHUNK ? zeros : zeros.subarray(0, left));
  return hash.digest('hex');
}

/** Writes `<OPFS>/<rel>` = fixture + free box of `padBytes` zero bytes. */
export async function writePaddedFixture(page: Page, rel: string, fixture: string, padBytes: number): Promise<void> {
  const header = Array.from(freeBoxHeader(padBytes));
  await page.evaluate(
    async ({ rel, fixture, padBytes, header, chunk }) => {
      let dir = await navigator.storage.getDirectory();
      const parts = rel.split('/');
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
      const res = await fetch(`/tests/fixtures/videos/${fixture}`);
      if (!res.ok) throw new Error(`fetch ${fixture}: ${res.status}`);
      const w = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
      await w.write(await res.arrayBuffer());
      await w.write(new Uint8Array(header));
      const zeros = new Uint8Array(chunk);
      for (let left = padBytes; left > 0; left -= chunk) await w.write(left >= chunk ? zeros : zeros.subarray(0, left));
      await w.close();
    },
    { rel, fixture, padBytes, header, chunk: CHUNK },
  );
}
