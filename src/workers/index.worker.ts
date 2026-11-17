/// <reference lib="webworker" />
import { BlobByteReader, indexMp4, describeMp4Error } from '../core/mp4';

self.onmessage = async (ev: MessageEvent<{ id: number; file: File }>) => {
  const { id, file } = ev.data;
  try {
    const index = await indexMp4(new BlobByteReader(file));
    const transfer = [
      index.ptsTicks.buffer, index.ptsUs.buffer, index.frameToSample.buffer, index.sampleToFrame.buffer,
      index.sampleOffsets.buffer, index.sampleSizes.buffer, index.sampleIsSync.buffer, index.syncSamples.buffer,
    ] as ArrayBuffer[];
    (self as unknown as Worker).postMessage({ id, ok: true, index }, transfer);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: describeMp4Error(e) });
  }
};
