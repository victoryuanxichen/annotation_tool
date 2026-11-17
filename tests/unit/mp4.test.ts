import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { BufferByteReader, indexMp4, boundaryUs, frameAtUs, decodeStartFor, isIdrAccessUnit, Mp4Error } from '../../src/core/mp4';

const dir = path.resolve('tests/fixtures/videos');
const manifestPath = path.join(dir, 'manifest.json');
const manifest: Record<string, any> = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};

describe('MP4 frame index matches ffprobe ground truth', () => {
  for (const [name, m] of Object.entries(manifest)) {
    it(name, async () => {
      const buf = new Uint8Array(readFileSync(path.join(dir, name)));
      const idx = await indexMp4(new BufferByteReader(buf));
      expect(idx.frameCount).toBe(m.frame_count);
      expect(Array.from(idx.ptsUs)).toEqual(m.pts_us);
      expect(idx.codec).toMatch(/^avc1\.[0-9a-f]{6}$/);
      expect(idx.durationUs).toBeGreaterThan(idx.ptsUs[idx.frameCount - 1]);
      expect(boundaryUs(idx, idx.frameCount)).toBe(idx.durationUs);
      expect(boundaryUs(idx, 0)).toBe(idx.ptsUs[0]);
      // every frame maps back to itself
      for (let f = 0; f < idx.frameCount; f++) {
        expect(idx.sampleToFrame[idx.frameToSample[f]]).toBe(f);
        expect(frameAtUs(idx, idx.ptsUs[f])).toBe(f);
      }
      if (m.has_b_frames > 0) expect(idx.reordered).toBe(true);
      if (name.startsWith('vfr')) expect(idx.variableFrameRate).toBe(true);
      else expect(idx.variableFrameRate).toBe(false);
      // decode start is an IDR sync sample at or before the target in decode order
      const isIdr = (s: number) => isIdrAccessUnit(buf.subarray(idx.sampleOffsets[s], idx.sampleOffsets[s] + idx.sampleSizes[s]), idx.nalLengthSize);
      for (let f = 0; f < idx.frameCount; f += 7) {
        const s0 = decodeStartFor(idx, f, isIdr);
        expect(idx.sampleIsSync[s0]).toBe(1);
        expect(isIdr(s0)).toBe(true);
        expect(s0).toBeLessThanOrEqual(idx.frameToSample[f]);
      }
    });
  }
});

describe('MP4 error handling', () => {
  it('rejects non-MP4 data', async () => {
    const junk = new TextEncoder().encode('format_version,video_sha256\n1,abc\n');
    await expect(indexMp4(new BufferByteReader(junk))).rejects.toBeInstanceOf(Mp4Error);
  });
  it('rejects a truncated file without moov', async () => {
    const name = Object.keys(manifest)[0];
    if (!name) return;
    const buf = new Uint8Array(readFileSync(path.join(dir, name)));
    // faststart puts moov near the start; keep only ftyp
    const ftypSize = new DataView(buf.buffer, buf.byteOffset).getUint32(0);
    await expect(indexMp4(new BufferByteReader(buf.subarray(0, ftypSize)))).rejects.toMatchObject({ code: 'no_moov' });
  });
});
