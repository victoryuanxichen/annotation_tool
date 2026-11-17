/** H.264 helpers for length-prefixed (avcC) sample data. */

/** Payloads (header byte included) of the NAL units in a length-prefixed access unit. */
function nalUnits(data: Uint8Array, nalLengthSize: number): Uint8Array[] {
  const units: Uint8Array[] = [];
  let o = 0;
  while (o + nalLengthSize <= data.byteLength) {
    let len = 0;
    for (let i = 0; i < nalLengthSize; i++) len = len * 256 + data[o + i];
    o += nalLengthSize;
    if (len === 0 || o + len > data.byteLength) break;
    units.push(data.subarray(o, o + len));
    o += len;
  }
  return units;
}

/** NAL unit types present in a length-prefixed access unit. */
export function nalTypes(data: Uint8Array, nalLengthSize: number): number[] {
  return nalUnits(data, nalLengthSize).map((u) => u[0] & 0x1f);
}

/** True when the access unit contains an IDR slice (nal_unit_type 5). */
export function isIdrAccessUnit(data: Uint8Array, nalLengthSize: number): boolean {
  return nalTypes(data, nalLengthSize).includes(5);
}

/**
 * How decoding may start at this access unit:
 * - 'idr': it holds an IDR picture;
 * - 'recovery': an intra-only non-IDR picture carrying a recovery point SEI with
 *   recovery_frame_cnt 0 (H.264 D.2.8), i.e. an open-GOP random access point. Every picture at
 *   or after it in output order decodes exactly; leading pictures must be discarded;
 * - null: decoding cannot start here.
 */
export function randomAccessKind(data: Uint8Array, nalLengthSize: number): 'idr' | 'recovery' | null {
  const units = nalUnits(data, nalLengthSize);
  let recoveryPoint = false;
  let slices = 0;
  for (const u of units) {
    const type = u[0] & 0x1f;
    if (type === 5) return 'idr';
    if (type === 6 && seiHasExactRecoveryPoint(unescapeRbsp(u.subarray(1)))) recoveryPoint = true;
    if (type === 1) {
      if (!isIntraSlice(unescapeRbsp(u.subarray(1, 16)))) return null;
      slices++;
    }
    if (type === 2 || type === 3 || type === 4) return null; // data partitioning: not handled
  }
  return recoveryPoint && slices > 0 ? 'recovery' : null;
}

/** Removes emulation-prevention bytes (00 00 03 → 00 00). */
function unescapeRbsp(b: Uint8Array): Uint8Array {
  let zeros = 0;
  let needs = false;
  for (let i = 0; i < b.length; i++) {
    if (zeros >= 2 && b[i] === 3) {
      needs = true;
      break;
    }
    zeros = b[i] === 0 ? zeros + 1 : 0;
  }
  if (!needs) return b;
  const out: number[] = [];
  zeros = 0;
  for (let i = 0; i < b.length; i++) {
    if (zeros >= 2 && b[i] === 3) {
      zeros = 0;
      continue;
    }
    out.push(b[i]);
    zeros = b[i] === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

class BitReader {
  private pos = 0;
  constructor(private readonly b: Uint8Array) {}
  bit(): number {
    const byte = this.pos >> 3;
    if (byte >= this.b.length) throw new RangeError('end of data');
    const v = (this.b[byte] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }
  /** Unsigned Exp-Golomb code. */
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      if (++zeros > 31) throw new RangeError('bad exp-golomb code');
    }
    let v = 0;
    for (let i = 0; i < zeros; i++) v = v * 2 + this.bit();
    return 2 ** zeros - 1 + v;
  }
}

/** slice_type of a non-IDR slice header is I (2, 7) or SI (4, 9). */
function isIntraSlice(rbsp: Uint8Array): boolean {
  try {
    const r = new BitReader(rbsp);
    r.ue(); // first_mb_in_slice
    const t = r.ue() % 5;
    return t === 2 || t === 4;
  } catch {
    return false;
  }
}

/**
 * True when an SEI NAL (rbsp after the header byte) holds a recovery point with
 * recovery_frame_cnt 0 and exact_match_flag 1.
 */
function seiHasExactRecoveryPoint(rbsp: Uint8Array): boolean {
  let o = 0;
  while (o < rbsp.length && rbsp[o] !== 0x80) {
    let type = 0;
    while (o < rbsp.length && rbsp[o] === 0xff) {
      type += 255;
      o++;
    }
    if (o >= rbsp.length) return false;
    type += rbsp[o++];
    let size = 0;
    while (o < rbsp.length && rbsp[o] === 0xff) {
      size += 255;
      o++;
    }
    if (o >= rbsp.length) return false;
    size += rbsp[o++];
    if (o + size > rbsp.length) return false;
    if (type === 6) {
      try {
        const r = new BitReader(rbsp.subarray(o, o + size));
        return r.ue() === 0 && r.bit() === 1;
      } catch {
        return false;
      }
    }
    o += size;
  }
  return false;
}
