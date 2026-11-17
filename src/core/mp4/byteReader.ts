/** Random-access byte source. Implemented for browser File/Blob and (in tests) Node buffers. */
export interface ByteReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export class BlobByteReader implements ByteReader {
  constructor(private readonly blob: Blob) {}
  get size(): number {
    return this.blob.size;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    const end = Math.min(this.blob.size, offset + length);
    if (offset < 0 || offset > end) throw new RangeError(`read out of range: ${offset}+${length}`);
    return new Uint8Array(await this.blob.slice(offset, end).arrayBuffer());
  }
}

export class BufferByteReader implements ByteReader {
  constructor(private readonly buf: Uint8Array) {}
  get size(): number {
    return this.buf.byteLength;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    return this.buf.subarray(offset, Math.min(this.buf.byteLength, offset + length));
  }
}
