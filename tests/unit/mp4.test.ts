import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { BufferByteReader, indexMp4, boundaryUs, frameAtUs, decodeStartFor, isIdrAccessUnit, randomAccessKind, Mp4Error } from '../../src/core/mp4';

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

describe('random access points (open GOP)', () => {
  const load = async (name: string) => {
    const buf = new Uint8Array(readFileSync(path.join(dir, name)));
    const idx = await indexMp4(new BufferByteReader(buf));
    const au = (s: number) => buf.subarray(idx.sampleOffsets[s], idx.sampleOffsets[s] + idx.sampleSizes[s]);
    return { idx, au };
  };

  it.skipIf(!manifest['open_gop30.mp4'])('classifies IDRs and recovery-point I pictures', async () => {
    const { idx, au } = await load('open_gop30.mp4');
    const kinds = Array.from(idx.syncSamples, (s) => randomAccessKind(au(s), idx.nalLengthSize));
    expect(kinds[0]).toBe('idr');
    expect(kinds.slice(1).length).toBeGreaterThan(0);
    for (const k of kinds.slice(1)) expect(k).toBe('recovery');
    // A non-sync P/B sample is never a random access point.
    const nonSync = Array.from({ length: idx.sampleSizes.length }, (_, s) => s).filter((s) => !idx.sampleIsSync[s]);
    for (const s of nonSync) expect(randomAccessKind(au(s), idx.nalLengthSize), `sample ${s}`).toBeNull();
  });

  it.skipIf(!manifest['open_gop30.mp4'])('decode start uses the closest recovery point that is not a leading-picture start', async () => {
    const { idx, au } = await load('open_gop30.mp4');
    const ok = (s: number) => randomAccessKind(au(s), idx.nalLengthSize) !== null;
    for (let f = 0; f < idx.frameCount; f++) {
      const s0 = decodeStartFor(idx, f, ok);
      expect(ok(s0)).toBe(true);
      expect(s0).toBeLessThanOrEqual(idx.frameToSample[f]);
      // The start picture is presented at or before f (f is not one of its leading pictures).
      expect(idx.sampleToFrame[s0]).toBeLessThanOrEqual(f);
      // No later usable start exists that would also work.
      for (const s of idx.syncSamples) {
        if (s > s0 && s <= idx.frameToSample[f] && ok(s)) expect(idx.sampleToFrame[s]).toBeGreaterThan(f);
      }
    }
    // The last frame no longer needs the whole file from the IDR at sample 0.
    expect(decodeStartFor(idx, idx.frameCount - 1, ok)).toBeGreaterThan(0);
  });

  it('closed-GOP fixtures only have IDR starts', async () => {
    for (const name of ['cfr25_bframes.mp4', 'long720p_gop300.mp4']) {
      if (!manifest[name]) continue;
      const { idx, au } = await load(name);
      for (const s of idx.syncSamples) expect(randomAccessKind(au(s), idx.nalLengthSize)).toBe('idr');
    }
  });

  it('parses a synthetic recovery point SEI with emulation prevention and rejects P slices', () => {
    const nal = (bytes: number[]) => [0, 0, 0, bytes.length, ...bytes];
    // SEI: type 6, size 1, payload 0xc4 = recovery_frame_cnt 0, exact_match 1; then rbsp trailing 0x80.
    const sei = [0x06, 0x06, 0x01, 0xc4, 0x80];
    // Non-IDR slice header: first_mb 0 ('1'), slice_type 7 ('0001000') → I.
    const iSlice = [0x01, 0x88, 0x84, 0x00];
    // slice_type 5 ('00110') → P.
    const pSlice = [0x01, 0x8c, 0x80, 0x00];
    const sei2 = [0x06, 0x06, 0x01, 0x84, 0x80]; // exact_match_flag 0
    const seiCnt = [0x06, 0x06, 0x01, 0x5c, 0x80]; // recovery_frame_cnt 1
    // A preceding user-data SEI whose payload needs emulation prevention (00 00 03 01).
    const userData = [0x06, 0x05, 0x04, 0x00, 0x00, 0x03, 0x01, 0x02, 0x06, 0x01, 0xc4, 0x80];
    const au = (...nals: number[][]) => Uint8Array.from(nals.flatMap(nal));
    expect(randomAccessKind(au(sei, iSlice), 4)).toBe('recovery');
    expect(randomAccessKind(au(userData, iSlice), 4)).toBe('recovery');
    expect(randomAccessKind(au(sei, pSlice), 4)).toBeNull();
    expect(randomAccessKind(au(iSlice), 4)).toBeNull();
    expect(randomAccessKind(au(sei2, iSlice), 4)).toBeNull();
    expect(randomAccessKind(au(seiCnt, iSlice), 4)).toBeNull();
    expect(randomAccessKind(au([0x65, 0x88, 0x80]), 4)).toBe('idr');
  });
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
