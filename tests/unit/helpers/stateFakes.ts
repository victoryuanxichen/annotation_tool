/**
 * Fakes for controller tests (node env): isolated fake-indexeddb databases, a scriptable player,
 * deterministic hashing (real SHA-256 of the bytes), a synthetic frame index and the in-memory
 * File System Access API from fakeFs.ts.
 */
import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import type { FrameIndex } from '../../../src/core/mp4/frameIndex';
import type { ByteReader } from '../../../src/core/mp4/byteReader';
import { buildExportRecords, serializeCsv, serializeJson } from '../../../src/core/formats/export';
import type { Segment } from '../../../src/core/types';
import type { PlayerSnapshot, SeekOutcome, SettledResult } from '../../../src/player/types';
import { createController, type ControllerApi } from '../../../src/state/controller';
import { browserFsDeps, type ControllerDeps, type PlayerLike, type WindowLike } from '../../../src/state/deps';
import { deleteDb, openDb, type DbProvider } from '../../../src/storage/db';
import { CheckpointStore } from '../../../src/storage/checkpoints';
import { DraftStore, type ChannelLike } from '../../../src/storage/drafts';
import { HandleStore } from '../../../src/storage/handles';
import { HashCache } from '../../../src/storage/hashCache';
import { KvStore } from '../../../src/storage/kv';
import type { AppState } from '../../../src/state/contract';

export const US_PER_FRAME = 40_000;

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function videoBytes(tag: string): Uint8Array {
  return new TextEncoder().encode(`synthetic-video:${tag}`);
}

export function boundaryUsOf(b: number): number {
  return b * US_PER_FRAME;
}

/** Export text for a fake video (frame count N, 40 ms per frame). */
export function sidecarText(
  content: Uint8Array,
  frameCount: number,
  segments: Omit<Segment, 'id'>[],
  names: Record<string, string>,
  format: 'csv' | 'json' = 'csv',
  shaOverride?: string,
): string {
  const doc = buildExportRecords(
    { sha256: shaOverride ?? sha256Hex(content), frameCount, durationUs: frameCount * US_PER_FRAME, fileName: 'video.mp4' },
    segments.map((s, i) => ({ ...s, id: `x${i}` })),
    (id) => names[id],
    boundaryUsOf,
  );
  return format === 'csv' ? serializeCsv(doc) : serializeJson(doc);
}

export function fakeIndex(frameCount: number): FrameIndex {
  const ptsUs = new Float64Array(frameCount);
  for (let f = 0; f < frameCount; f++) ptsUs[f] = f * US_PER_FRAME;
  return {
    codec: 'avc1.64001f',
    description: new Uint8Array(0),
    nalLengthSize: 4,
    codedWidth: 320,
    codedHeight: 240,
    displayWidth: 320,
    displayHeight: 240,
    timescale: 1_000_000,
    frameCount,
    durationUs: frameCount * US_PER_FRAME,
    ptsTicks: ptsUs,
    ptsUs,
    frameToSample: new Uint32Array(frameCount).map((_, i) => i),
    sampleToFrame: new Int32Array(frameCount).map((_, i) => i),
    sampleOffsets: new Float64Array(frameCount),
    sampleSizes: new Uint32Array(frameCount),
    sampleIsSync: new Uint8Array(frameCount),
    syncSamples: new Uint32Array([0]),
    averageFps: 25,
    variableFrameRate: false,
    reordered: false,
    warnings: [],
  };
}

/** Player whose displayed frame and settle behaviour are set by the test. */
export class FakePlayer implements PlayerLike {
  status: PlayerSnapshot['status'] = 'empty';
  displayed: number | null = null;
  playing = false;
  frameCount = 0;
  /** Next settled() result override: an error, or 'hang' (never settles → timeout). */
  settleMode: 'ok' | 'hang' | { error: string } = 'ok';
  settleCalls = 0;
  seeks: number[] = [];
  private listeners = new Set<(s: PlayerSnapshot) => void>();
  private gate: Promise<void> | null = null;
  private release: (() => void) | null = null;

  /** Makes settled() wait until `releaseSettle()` is called. */
  holdSettle(): void {
    this.gate = new Promise((r) => (this.release = r));
  }

  releaseSettle(): void {
    this.release?.();
    this.gate = null;
  }

  async load(index: FrameIndex, _reader: ByteReader): Promise<void> {
    this.frameCount = index.frameCount;
    this.status = 'ready';
    this.displayed = 0;
  }
  unload(): void {
    this.status = 'empty';
    this.displayed = null;
  }
  dispose(): void {
    this.unload();
  }
  async seek(frame: number): Promise<SeekOutcome> {
    this.seeks.push(frame);
    if (this.status !== 'ready') return { ok: false, superseded: false, error: 'not_ready' };
    this.displayed = Math.max(0, Math.min(this.frameCount - 1, frame));
    return { ok: true, superseded: false, frame: this.displayed };
  }
  pause(): void {
    this.playing = false;
  }
  async settled(timeoutMs = 1500): Promise<SettledResult> {
    this.settleCalls++;
    if (this.gate) await this.gate;
    if (this.settleMode === 'hang') {
      await new Promise((r) => setTimeout(r, timeoutMs));
      return { error: 'timeout' };
    }
    if (typeof this.settleMode === 'object') return this.settleMode;
    if (this.status !== 'ready' || this.displayed === null) return { error: 'empty' };
    return { frame: this.displayed };
  }
  subscribe(fn: (s: PlayerSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  getSnapshot(): PlayerSnapshot {
    return { status: this.status, displayedFrame: this.displayed, requestedFrame: null, playing: this.playing, rate: 1, error: null };
  }
  peekThumbnail(): ImageBitmap | null {
    return null;
  }
}

/** In-process BroadcastChannel stand-in shared by several DraftStores ("tabs"). */
export class ChannelHub {
  private readonly members = new Set<FakeChannel>();
  create(): ChannelLike {
    const ch = new FakeChannel(this.members);
    this.members.add(ch);
    return ch;
  }
}

class FakeChannel implements ChannelLike {
  private readonly listeners = new Set<(ev: MessageEvent) => void>();
  constructor(private readonly members: Set<FakeChannel>) {}
  postMessage(message: unknown): void {
    for (const m of this.members) if (m !== this) for (const l of m.listeners) l({ data: message } as MessageEvent);
  }
  addEventListener(_type: 'message', l: (ev: MessageEvent) => void): void {
    this.listeners.add(l);
  }
  removeEventListener(_type: 'message', l: (ev: MessageEvent) => void): void {
    this.listeners.delete(l);
  }
  close(): void {
    this.members.delete(this);
  }
}

export interface Harness {
  api: ControllerApi<FakePlayer>;
  player: FakePlayer;
  deps: ControllerDeps<FakePlayer>;
  db: DbProvider;
  drafts: DraftStore;
  checkpoints: CheckpointStore;
  hub: ChannelHub;
  downloads: { name: string; text: string }[];
  frameCounts: Map<string, number>;
  state(): AppState;
  /** Waits for identity/sidecar work and autosave to finish. */
  idle(): Promise<void>;
  cleanup(): Promise<void>;
}

let dbSeq = 0;

export async function createHarness(overrides: Partial<ControllerDeps<FakePlayer>> = {}, options: { window?: WindowLike } = {}): Promise<Harness> {
  const dbName = `state-test-${++dbSeq}-${Math.random().toString(36).slice(2)}`;
  const db: DbProvider = () => openDb({ name: dbName });
  const hub = new ChannelHub();
  const drafts = new DraftStore({ db, tabId: 'tab-main', createChannel: () => hub.create() });
  const checkpoints = new CheckpointStore({ db });
  const player = new FakePlayer();
  const downloads: { name: string; text: string }[] = [];
  const frameCounts = new Map<string, number>();
  const deps: ControllerDeps<FakePlayer> = {
    drafts,
    checkpoints,
    kv: new KvStore({ db }),
    handles: new HandleStore({ db }),
    hashCache: new HashCache({ db }),
    hashing: {
      fingerprint: async (file) => `fp1:${file.size}:${sha256Hex(new Uint8Array(await file.arrayBuffer()))}`,
      sha256: async (file) => sha256Hex(new Uint8Array(await file.arrayBuffer())),
    },
    indexFile: async (file) => fakeIndex(frameCounts.get(file.name) ?? 250),
    createPlayer: () => player,
    createReader: () => ({ size: 0, read: async () => new Uint8Array(0) }),
    fs: {
      ...browserFsDeps,
      downloadText: (name, text) => {
        downloads.push({ name, text });
      },
      pickVideoFile: async () => null,
      pickFolder: async () => null,
      pickAnnotationFile: async () => null,
      pickExportFolder: async () => null,
    },
    env: {
      fileSystemAccess: () => true,
      webCodecs: () => true,
      requestPersistence: async () => true,
      detectLang: () => 'en',
      window: options.window ?? null,
    },
    autosave: { debounceMs: 5, maxWaitMs: 20 },
    settleTimeoutMs: 40,
    now: () => Date.now(),
    ...overrides,
  };
  const api = createController(deps);
  api.actions.attachCanvas({} as HTMLCanvasElement);
  await api.actions.init();
  return {
    api,
    player,
    deps,
    db,
    drafts,
    checkpoints,
    hub,
    downloads,
    frameCounts,
    state: () => api.store.getState(),
    idle: () => api.whenIdle(),
    cleanup: async () => {
      api.dispose();
      drafts.close();
      await deleteDb(dbName);
    },
  };
}
