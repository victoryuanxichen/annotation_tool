/** Named snapshots of a video's annotations (SPEC §5, §7.5). */
import type { PhaseDef, Segment } from '../core/types';
import { defaultDb, runTransaction, singleRequest, type DbProvider } from './db';
import { rekeyCheckpointsInTx } from './drafts';
import { newId } from './tabId';

export type CheckpointKind = 'manual' | 'auto-before-restore' | 'auto-before-import' | 'auto-before-conflict';

export interface CheckpointRecord {
  id: string;
  /** Draft key of the video (sha256 or pending key). */
  videoKey: string;
  name: string;
  createdAt: number;
  kind: CheckpointKind;
  segments: Segment[];
  phases: Record<string, PhaseDef>;
}

export type CheckpointInput = Omit<CheckpointRecord, 'id' | 'createdAt'>;

export interface CheckpointStoreOptions {
  db?: DbProvider;
  now?: () => number;
  newId?: () => string;
}

export class CheckpointStore {
  private readonly db: DbProvider;
  private readonly now: () => number;
  private readonly makeId: () => string;
  private lastCreatedAt = 0;

  constructor(options: CheckpointStoreOptions = {}) {
    this.db = options.db ?? defaultDb;
    this.now = options.now ?? Date.now;
    this.makeId = options.newId ?? newId;
  }

  async create(input: CheckpointInput): Promise<CheckpointRecord> {
    // Strictly increasing timestamps keep "newest first" well defined for back-to-back checkpoints.
    const createdAt = Math.max(this.now(), this.lastCreatedAt + 1);
    this.lastCreatedAt = createdAt;
    const record: CheckpointRecord = {
      id: this.makeId(),
      videoKey: input.videoKey,
      name: input.name,
      kind: input.kind,
      segments: input.segments,
      phases: input.phases,
      createdAt,
    };
    await singleRequest(this.db, 'checkpoints', 'readwrite', (s) => s.add(record));
    return record;
  }

  /** Checkpoints of one video, newest first. */
  async list(videoKey: string): Promise<CheckpointRecord[]> {
    const all = await singleRequest<CheckpointRecord[]>(this.db, 'checkpoints', 'readonly', (s) =>
      s.index('videoKey').getAll(videoKey),
    );
    return all.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }

  async get(id: string): Promise<CheckpointRecord | null> {
    const rec = await singleRequest<CheckpointRecord | undefined>(this.db, 'checkpoints', 'readonly', (s) => s.get(id));
    return rec ?? null;
  }

  async delete(id: string): Promise<void> {
    await singleRequest(this.db, 'checkpoints', 'readwrite', (s) => s.delete(id));
  }

  /** Moves every checkpoint of `oldVideoKey` to `newVideoKey`; returns how many moved. */
  rekey(oldVideoKey: string, newVideoKey: string): Promise<number> {
    if (oldVideoKey === newVideoKey) return Promise.resolve(0);
    return runTransaction(this.db, 'checkpoints', 'readwrite', (tx) => rekeyCheckpointsInTx(tx, oldVideoKey, newVideoKey));
  }
}
