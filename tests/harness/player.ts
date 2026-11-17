/// <reference types="vite/client" />
/**
 * Test harness for FramePlayer: /tests/harness/player.html?v=<fixture>
 * Fault injection: &nowebcodecs=1 (no VideoDecoder), &unsupported=1 (isConfigSupported → false).
 * Exposes window.__player, window.__readBarcode() and fixture facts for Playwright.
 */
import { FramePlayer } from '../../src/player';
import { BlobByteReader, indexMp4, type ByteReader } from '../../src/core/mp4';
import { containRect, decodeBarcode } from '../../src/testing/barcode';

export interface HarnessInfo {
  name: string;
  frameCount: number;
  width: number;
  height: number;
  /** Frames of sync samples (keyframes), ascending. */
  keyframes: number[];
  ptsUs: number[];
}

declare global {
  interface Window {
    __player: FramePlayer;
    __harness: HarnessInfo | null;
    /** Resolves when load() has finished (successfully or with the player in an error state). */
    __loaded: Promise<void>;
    __readBarcode: () => number | null;
    __readThumbnailBarcode: (frame: number) => number | null;
    __harnessError: string | null;
    /** Loads another fixture into the same player. */
    __loadFixture: (name: string) => Promise<void>;
    /** Fault injection for subsequent reads: 'none', 'throw' (read error) or 'garbage' (random bytes). */
    __setReadFault: (fault: ReadFault) => void;
  }
}

export type ReadFault = 'none' | 'throw' | 'garbage';

/** ByteReader wrapper whose reads can be made to fail or return garbage. */
class FaultyReader implements ByteReader {
  fault: ReadFault = 'none';
  constructor(private readonly inner: ByteReader) {}
  get size(): number {
    return this.inner.size;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (this.fault === 'throw') throw new Error('injected read failure');
    const bytes = await this.inner.read(offset, length);
    if (this.fault === 'garbage') {
      const junk = new Uint8Array(bytes.byteLength);
      for (let i = 0; i < junk.length; i++) junk[i] = (i * 151 + 7) & 0xff;
      return junk;
    }
    return bytes;
  }
}

const params = new URLSearchParams(location.search);
const rawName = params.get('v') ?? 'cfr25_bframes';
const fileName = rawName.endsWith('.mp4') ? rawName : `${rawName}.mp4`;
if (params.has('nowebcodecs')) Reflect.deleteProperty(window, 'VideoDecoder');
if (params.has('unsupported')) {
  VideoDecoder.isConfigSupported = async (config: VideoDecoderConfig) => ({ supported: false, config });
}

const canvas = document.getElementById('screen') as HTMLCanvasElement;
const statusEl = document.getElementById('status') as HTMLElement;
const player = new FramePlayer(canvas);
window.__player = player;
window.__harness = null;
window.__harnessError = null;

function readBarcodeFrom(source: CanvasImageSource & { width: number; height: number }): number | null {
  const info = window.__harness;
  if (!info) return null;
  const off = new OffscreenCanvas(source.width, source.height);
  const ctx = off.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0);
  const img = ctx.getImageData(0, 0, source.width, source.height);
  return decodeBarcode(img.data, img.width, containRect(img.width, img.height, info.width, info.height));
}

window.__readBarcode = () => readBarcodeFrom(canvas);
window.__readThumbnailBarcode = (frame: number) => {
  const bmp = player.peekThumbnail(frame);
  return bmp ? readBarcodeFrom(bmp) : null;
};

player.subscribe((s) => {
  statusEl.textContent = `${window.__harness?.name ?? fileName}  status=${s.status}  frame=${s.displayedFrame ?? '–'}  requested=${s.requestedFrame ?? '–'}  playing=${s.playing}  rate=${s.rate}${s.error ? `  error=${s.error.code}` : ''}`;
});

let reader: FaultyReader | null = null;

async function loadFixture(name: string): Promise<void> {
  const file = name.endsWith('.mp4') ? name : `${name}.mp4`;
  const res = await fetch(`/tests/fixtures/videos/${file}`);
  if (!res.ok) throw new Error(`fetch ${file}: HTTP ${res.status}`);
  const blob = await res.blob();
  const index = await indexMp4(new BlobByteReader(blob));
  const keyframes = Array.from(index.syncSamples, (s) => index.sampleToFrame[s]).filter((f) => f >= 0).sort((a, b) => a - b);
  window.__harness = {
    name: file,
    frameCount: index.frameCount,
    width: index.displayWidth,
    height: index.displayHeight,
    keyframes,
    ptsUs: Array.from(index.ptsUs),
  };
  reader = new FaultyReader(new BlobByteReader(blob));
  await player.load(index, reader);
}

window.__loadFixture = loadFixture;
window.__setReadFault = (fault) => {
  if (reader) reader.fault = fault;
};

// Other modules are edited while tests run; accepting dependency updates keeps the dev server from
// reloading this page mid-test (the running player keeps the code it was loaded with).
import.meta.hot?.accept(['../../src/player', '../../src/core/mp4', '../../src/testing/barcode'], () => {});

window.__loaded = loadFixture(fileName).catch((e: unknown) => {
  window.__harnessError = e instanceof Error ? e.message : String(e);
  statusEl.textContent = `harness error: ${window.__harnessError}`;
});
