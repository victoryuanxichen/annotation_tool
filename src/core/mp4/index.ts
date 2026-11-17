export * from './byteReader';
export * from './parser';
export * from './frameIndex';
export * from './avc';
import type { ByteReader } from './byteReader';
import { parseMp4 } from './parser';
import { buildFrameIndex, type FrameIndex } from './frameIndex';

export async function indexMp4(reader: ByteReader): Promise<FrameIndex> {
  return buildFrameIndex(await parseMp4(reader));
}
