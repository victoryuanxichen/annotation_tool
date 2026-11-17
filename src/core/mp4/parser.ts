/**
 * Minimal ISO-BMFF (MP4) parser that extracts what frame-accurate decoding needs from
 * the first H.264 video track: codec configuration, the complete sample table in
 * decode order (offset, size, DTS, CTS, duration, sync flag) and the edit list.
 *
 * Only the `moov` box is read into memory; media data is never touched here, so
 * indexing a multi-gigabyte file costs a few reads.
 */
import type { ByteReader } from './byteReader';

export class Mp4Error extends Error {
  constructor(
    public readonly code:
      | 'not_mp4'
      | 'no_moov'
      | 'fragmented'
      | 'no_video'
      | 'unsupported_codec'
      | 'encrypted'
      | 'corrupt',
    message: string,
  ) {
    super(message);
    this.name = 'Mp4Error';
  }
}

export interface EditListEntry {
  /** Duration in movie (mvhd) timescale. */
  segmentDuration: number;
  /** Start in media timescale, -1 for an empty edit. */
  mediaTime: number;
  mediaRate: number;
}

export interface RawVideoTrack {
  trackId: number;
  timescale: number;
  movieTimescale: number;
  /** 'avc1' | 'avc3' */
  sampleEntry: string;
  /** WebCodecs codec string, e.g. avc1.64001f */
  codec: string;
  /** avcC payload (AVCDecoderConfigurationRecord). */
  description: Uint8Array;
  /** NAL length field size in bytes (1, 2 or 4). */
  nalLengthSize: number;
  codedWidth: number;
  codedHeight: number;
  /** Track header presentation size (may differ from coded size). */
  displayWidth: number;
  displayHeight: number;
  sampleCount: number;
  /** Decode-order sample tables. */
  offsets: Float64Array;
  sizes: Uint32Array;
  dts: Float64Array;
  cts: Float64Array;
  durations: Float64Array;
  isSync: Uint8Array;
  edits: EditListEntry[];
}

interface Box {
  type: string;
  start: number; // offset of the box header within its buffer
  headerSize: number;
  size: number; // total size including header
}

const td = new TextDecoder('latin1');

function fourcc(b: Uint8Array, o: number): string {
  return td.decode(b.subarray(o, o + 4));
}

class View {
  readonly dv: DataView;
  constructor(public readonly b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  u8(o: number) {
    return this.dv.getUint8(o);
  }
  u16(o: number) {
    return this.dv.getUint16(o);
  }
  u32(o: number) {
    return this.dv.getUint32(o);
  }
  i32(o: number) {
    return this.dv.getInt32(o);
  }
  u64(o: number) {
    const v = this.dv.getBigUint64(o);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Mp4Error('corrupt', '64-bit value too large');
    return Number(v);
  }
  i64(o: number) {
    const v = this.dv.getBigInt64(o);
    return Number(v);
  }
}

function* children(v: View, start: number, end: number): Generator<Box> {
  let o = start;
  while (o + 8 <= end) {
    let size = v.u32(o);
    const type = fourcc(v.b, o + 4);
    let headerSize = 8;
    if (size === 1) {
      if (o + 16 > end) throw new Mp4Error('corrupt', `truncated large box ${type}`);
      size = v.u64(o + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < headerSize || o + size > end) throw new Mp4Error('corrupt', `box ${type} overruns its parent`);
    yield { type, start: o, headerSize, size };
    o += size;
  }
}

function find(v: View, parent: Box | { start: number; headerSize: number; size: number }, type: string, skip = 0): Box | null {
  for (const c of children(v, parent.start + parent.headerSize + skip, parent.start + parent.size)) {
    if (c.type === type) return c;
  }
  return null;
}

function findAll(v: View, parent: Box, type: string): Box[] {
  const out: Box[] = [];
  for (const c of children(v, parent.start + parent.headerSize, parent.start + parent.size)) if (c.type === type) out.push(c);
  return out;
}

function path(v: View, parent: Box, ...types: string[]): Box | null {
  let cur: Box | null = parent;
  for (const t of types) {
    if (!cur) return null;
    cur = find(v, cur, t);
  }
  return cur;
}

/** Scan top-level boxes by reading only their headers. */
async function scanTopLevel(reader: ByteReader): Promise<{ type: string; offset: number; size: number; headerSize: number }[]> {
  const boxes: { type: string; offset: number; size: number; headerSize: number }[] = [];
  let o = 0;
  const total = reader.size;
  while (o + 8 <= total) {
    const h = await reader.read(o, 16);
    const v = new View(h);
    let size = v.u32(0);
    const type = fourcc(h, 4);
    let headerSize = 8;
    if (size === 1) {
      if (h.byteLength < 16) throw new Mp4Error('corrupt', 'truncated large box header');
      size = v.u64(8);
      headerSize = 16;
    } else if (size === 0) size = total - o;
    if (!/^[\x20-\x7e]{4}$/.test(type)) {
      if (boxes.length === 0) throw new Mp4Error('not_mp4', 'File does not start with an MP4 box');
      break; // trailing garbage
    }
    if (size < headerSize) throw new Mp4Error('corrupt', `invalid size for top-level box ${type}`);
    boxes.push({ type, offset: o, size: Math.min(size, total - o), headerSize });
    o += size;
  }
  if (boxes.length === 0 || !['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'styp', 'uuid'].includes(boxes[0].type)) {
    throw new Mp4Error('not_mp4', 'Not an MP4 file');
  }
  return boxes;
}

export async function parseMp4(reader: ByteReader): Promise<RawVideoTrack> {
  const top = await scanTopLevel(reader);
  if (top.some((b) => b.type === 'moof')) {
    throw new Mp4Error('fragmented', 'Fragmented MP4 (moof boxes) is not supported in this release');
  }
  const moovInfo = top.find((b) => b.type === 'moov');
  if (!moovInfo) throw new Mp4Error('no_moov', 'MP4 has no movie header (moov); the file may be incomplete');
  const moovBytes = await reader.read(moovInfo.offset, moovInfo.size);
  if (moovBytes.byteLength < moovInfo.size) throw new Mp4Error('corrupt', 'moov box is truncated');
  const v = new View(moovBytes);
  const moov: Box = { type: 'moov', start: 0, headerSize: moovInfo.headerSize, size: moovInfo.size };
  if (find(v, moov, 'mvex')) throw new Mp4Error('fragmented', 'Fragmented MP4 (mvex) is not supported in this release');

  const mvhd = find(v, moov, 'mvhd');
  if (!mvhd) throw new Mp4Error('corrupt', 'missing mvhd');
  const mvhdBody = mvhd.start + mvhd.headerSize;
  const movieTimescale = v.u8(mvhdBody) === 1 ? v.u32(mvhdBody + 20) : v.u32(mvhdBody + 12);

  let sawVideo = false;
  let unsupported: string | null = null;
  for (const trak of findAll(v, moov, 'trak')) {
    const hdlr = path(v, trak, 'mdia', 'hdlr');
    if (!hdlr) continue;
    const handler = fourcc(v.b, hdlr.start + hdlr.headerSize + 8);
    if (handler !== 'vide') continue;
    sawVideo = true;
    const stsd = path(v, trak, 'mdia', 'minf', 'stbl', 'stsd');
    if (!stsd) continue;
    const entry = find(v, stsd, 'avc1', 8) ?? find(v, stsd, 'avc3', 8);
    if (!entry) {
      const first = children(v, stsd.start + stsd.headerSize + 8, stsd.start + stsd.size).next().value as Box | undefined;
      unsupported = first?.type ?? 'unknown';
      continue;
    }
    return parseTrack(v, trak, entry, movieTimescale);
  }
  if (unsupported === 'encv') throw new Mp4Error('encrypted', 'Encrypted video tracks are not supported');
  if (unsupported) throw new Mp4Error('unsupported_codec', `Video codec "${unsupported}" is not supported; this release supports H.264 (avc1)`);
  if (!sawVideo) throw new Mp4Error('no_video', 'MP4 contains no video track');
  throw new Mp4Error('no_video', 'MP4 video track has no sample description');
}

function parseTrack(v: View, trak: Box, entry: Box, movieTimescale: number): RawVideoTrack {
  const tkhd = find(v, trak, 'tkhd');
  if (!tkhd) throw new Mp4Error('corrupt', 'missing tkhd');
  const tb = tkhd.start + tkhd.headerSize;
  const tkVersion = v.u8(tb);
  const trackId = tkVersion === 1 ? v.u32(tb + 20) : v.u32(tb + 12);
  const whOff = tkVersion === 1 ? tb + 88 : tb + 76;
  const displayWidth = Math.round(v.u32(whOff) / 65536);
  const displayHeight = Math.round(v.u32(whOff + 4) / 65536);

  const mdhd = path(v, trak, 'mdia', 'mdhd');
  if (!mdhd) throw new Mp4Error('corrupt', 'missing mdhd');
  const mb = mdhd.start + mdhd.headerSize;
  const timescale = v.u8(mb) === 1 ? v.u32(mb + 20) : v.u32(mb + 12);
  if (!timescale) throw new Mp4Error('corrupt', 'zero media timescale');

  // Sample entry (VisualSampleEntry): 8 reserved/dataref + 16 predefined + width/height at +24/+26
  const eb = entry.start + entry.headerSize;
  const codedWidth = v.u16(eb + 24);
  const codedHeight = v.u16(eb + 26);
  const avcC = find(v, entry, 'avcC', 78);
  if (!avcC) throw new Mp4Error('corrupt', 'H.264 sample entry has no avcC configuration');
  const description = v.b.slice(avcC.start + avcC.headerSize, avcC.start + avcC.size);
  if (description.byteLength < 7) throw new Mp4Error('corrupt', 'avcC too short');
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  const codec = `avc1.${hex(description[1])}${hex(description[2])}${hex(description[3])}`;
  const nalLengthSize = (description[4] & 3) + 1;

  const stbl = path(v, trak, 'mdia', 'minf', 'stbl')!;
  // --- stsz / stz2
  let sizes: Uint32Array;
  const stsz = find(v, stbl, 'stsz');
  if (stsz) {
    const o = stsz.start + stsz.headerSize;
    const fixed = v.u32(o + 4);
    const count = v.u32(o + 8);
    sizes = new Uint32Array(count);
    if (fixed) sizes.fill(fixed);
    else {
      if (o + 12 + count * 4 > stsz.start + stsz.size) throw new Mp4Error('corrupt', 'stsz truncated');
      for (let i = 0; i < count; i++) sizes[i] = v.u32(o + 12 + i * 4);
    }
  } else {
    const stz2 = find(v, stbl, 'stz2');
    if (!stz2) throw new Mp4Error('corrupt', 'missing stsz');
    const o = stz2.start + stz2.headerSize;
    const field = v.u8(o + 7);
    const count = v.u32(o + 8);
    sizes = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      if (field === 16) sizes[i] = v.u16(o + 12 + i * 2);
      else if (field === 8) sizes[i] = v.u8(o + 12 + i);
      else if (field === 4) {
        const byte = v.u8(o + 12 + (i >> 1));
        sizes[i] = i & 1 ? byte & 15 : byte >> 4;
      } else throw new Mp4Error('corrupt', 'bad stz2 field size');
    }
  }
  const n = sizes.length;
  if (n === 0) throw new Mp4Error('no_video', 'Video track has no samples');

  // --- stts -> dts, durations
  const stts = find(v, stbl, 'stts');
  if (!stts) throw new Mp4Error('corrupt', 'missing stts');
  const dts = new Float64Array(n);
  const durations = new Float64Array(n);
  {
    const o = stts.start + stts.headerSize;
    const entries = v.u32(o + 4);
    let i = 0;
    let t = 0;
    for (let e = 0; e < entries && i < n; e++) {
      const count = v.u32(o + 8 + e * 8);
      const delta = v.u32(o + 12 + e * 8);
      for (let k = 0; k < count && i < n; k++, i++) {
        dts[i] = t;
        durations[i] = delta;
        t += delta;
      }
    }
    if (i < n) throw new Mp4Error('corrupt', 'stts covers fewer samples than stsz');
  }

  // --- ctts -> cts
  const cts = new Float64Array(n);
  const ctts = find(v, stbl, 'ctts');
  if (ctts) {
    const o = ctts.start + ctts.headerSize;
    const entries = v.u32(o + 4);
    let i = 0;
    for (let e = 0; e < entries && i < n; e++) {
      const count = v.u32(o + 8 + e * 8);
      // Version 0 is nominally unsigned but some muxers store negative offsets; read as signed.
      const off = v.i32(o + 12 + e * 8);
      for (let k = 0; k < count && i < n; k++, i++) cts[i] = dts[i] + off;
    }
    for (; i < n; i++) cts[i] = dts[i];
  } else cts.set(dts);

  // --- stss
  const isSync = new Uint8Array(n);
  const stss = find(v, stbl, 'stss');
  if (stss) {
    const o = stss.start + stss.headerSize;
    const entries = v.u32(o + 4);
    for (let e = 0; e < entries; e++) {
      const s = v.u32(o + 8 + e * 4) - 1;
      if (s >= 0 && s < n) isSync[s] = 1;
    }
  } else isSync.fill(1);
  if (!isSync[0]) {
    // Decoding must begin somewhere; treat the first sample as a sync point (validated later via NAL type).
    isSync[0] = 1;
  }

  // --- chunk offsets (stco/co64) + stsc
  const stco = find(v, stbl, 'stco');
  const co64 = find(v, stbl, 'co64');
  let chunkOffsets: Float64Array;
  if (stco) {
    const o = stco.start + stco.headerSize;
    const c = v.u32(o + 4);
    chunkOffsets = new Float64Array(c);
    for (let i = 0; i < c; i++) chunkOffsets[i] = v.u32(o + 8 + i * 4);
  } else if (co64) {
    const o = co64.start + co64.headerSize;
    const c = v.u32(o + 4);
    chunkOffsets = new Float64Array(c);
    for (let i = 0; i < c; i++) chunkOffsets[i] = v.u64(o + 8 + i * 8);
  } else throw new Mp4Error('corrupt', 'missing stco/co64');

  const stsc = find(v, stbl, 'stsc');
  if (!stsc) throw new Mp4Error('corrupt', 'missing stsc');
  const offsets = new Float64Array(n);
  {
    const o = stsc.start + stsc.headerSize;
    const entries = v.u32(o + 4);
    let sample = 0;
    for (let e = 0; e < entries; e++) {
      const firstChunk = v.u32(o + 8 + e * 12) - 1;
      const perChunk = v.u32(o + 12 + e * 12);
      const nextFirst = e + 1 < entries ? v.u32(o + 8 + (e + 1) * 12) - 1 : chunkOffsets.length;
      for (let c = firstChunk; c < nextFirst && sample < n; c++) {
        let off = chunkOffsets[c];
        for (let k = 0; k < perChunk && sample < n; k++, sample++) {
          offsets[sample] = off;
          off += sizes[sample];
        }
      }
    }
    if (sample < n) throw new Mp4Error('corrupt', 'stsc/stco cover fewer samples than stsz');
  }

  // --- edit list
  const edits: EditListEntry[] = [];
  const elst = path(v, trak, 'edts', 'elst');
  if (elst) {
    const o = elst.start + elst.headerSize;
    const version = v.u8(o);
    const entries = v.u32(o + 4);
    let p = o + 8;
    for (let e = 0; e < entries; e++) {
      if (version === 1) {
        edits.push({ segmentDuration: v.u64(p), mediaTime: v.i64(p + 8), mediaRate: v.i32(p + 16) / 65536 });
        p += 20;
      } else {
        edits.push({ segmentDuration: v.u32(p), mediaTime: v.i32(p + 4), mediaRate: v.i32(p + 8) / 65536 });
        p += 12;
      }
    }
  }

  return {
    trackId,
    timescale,
    movieTimescale,
    sampleEntry: entry.type,
    codec,
    description,
    nalLengthSize,
    codedWidth,
    codedHeight,
    displayWidth: displayWidth || codedWidth,
    displayHeight: displayHeight || codedHeight,
    sampleCount: n,
    offsets,
    sizes,
    dts,
    cts,
    durations,
    isSync,
    edits,
  };
}
