/** H.264 helpers for length-prefixed (avcC) sample data. */

/** NAL unit types present in a length-prefixed access unit. */
export function nalTypes(data: Uint8Array, nalLengthSize: number): number[] {
  const types: number[] = [];
  let o = 0;
  while (o + nalLengthSize <= data.byteLength) {
    let len = 0;
    for (let i = 0; i < nalLengthSize; i++) len = len * 256 + data[o + i];
    o += nalLengthSize;
    if (len === 0 || o + len > data.byteLength) break;
    types.push(data[o] & 0x1f);
    o += len;
  }
  return types;
}

/** True when the access unit contains an IDR slice (nal_unit_type 5). */
export function isIdrAccessUnit(data: Uint8Array, nalLengthSize: number): boolean {
  return nalTypes(data, nalLengthSize).includes(5);
}
