/** Draft persistence with optimistic revisions and cross-tab notifications (SPEC §5, §7.8). */
import type { PhaseDef, Segment } from '../core/types';
import { defaultDb, runTransaction, singleRequest, type DbProvider } from './db';
import { TAB_ID } from './tabId';

export { Autosaver } from './autosave';
export type { AutosaveStatus, AutosaverOptions, AttachTarget, DraftProducer } from './autosave';

export const PENDING_PREFIX = 'pending:';
export const CHANNEL_NAME = 'phase-annotator';

export interface ExportTarget {
  label: string;
  format: 'csv' | 'json';
}

export interface ExportedInfo {
  contentHash: string;
  at: number;
  targets: ExportTarget[];
}

export interface DraftRecord {
  /** sha256 hex, or 'pending:' + fingerprint until the full hash is known. */
  key: string;
  sha256: string | null;
  fingerprint: string;
  fileName: string;
  relPath: string | null;
  frameCount: number;
  durationUs: number;
  segments: Segment[];
  /** Snapshot of every phase referenced by segments. */
  phases: Record<string, PhaseDef>;
  /** Stable hash of (segments, phase names), for dirty tracking. */
  contentHash: string;
  /** +1 on every save; 0 means "never stored". */
  revision: number;
  savedAt: number;
  /** Tab id of the writer. */
  savedBy: string;
  exported: ExportedInfo | null;
}

export type SaveResult =
  | { ok: true; record: DraftRecord }
  /** `conflict` is the stored record, or null when it was deleted/re-keyed elsewhere. */
  | { ok: false; conflict: DraftRecord | null };

export type PromoteResult =
  | { kind: 'promoted'; record: DraftRecord }
  /** Both records are kept unchanged; the UI decides which one wins. */
  | { kind: 'collision'; collision: DraftRecord; pending: DraftRecord }
  | { kind: 'not_found' };

export interface DraftLookup {
  record: DraftRecord;
  match: 'sha256' | 'fingerprint';
}

export type DraftMessage =
  | { type: 'draft-saved'; key: string; revision: number; tabId: string }
  | { type: 'draft-promoted'; from: string; key: string; revision: number; tabId: string }
  | { type: 'draft-deleted'; key: string; tabId: string };

/** The subset of BroadcastChannel used here, so tests and old browsers can substitute it. */
export interface ChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  close(): void;
}

export interface DraftStoreOptions {
  db?: DbProvider;
  tabId?: string;
  now?: () => number;
  /** Returns null when cross-tab messaging is unavailable. */
  createChannel?: (name: string) => ChannelLike | null;
}

export function pendingKey(fingerprint: string): string {
  return PENDING_PREFIX + fingerprint;
}

export function isPendingKey(key: string): boolean {
  return key.startsWith(PENDING_PREFIX);
}

/** Key for a video: its sha256 when known, otherwise the pending fingerprint key. */
export function draftKeyFor(sha256: string | null, fingerprint: string): string {
  return sha256 ?? pendingKey(fingerprint);
}

export interface DraftInit {
  sha256: string | null;
  fingerprint: string;
  fileName: string;
  relPath: string | null;
  frameCount: number;
  durationUs: number;
}

/** A fresh, never-saved draft (revision 0) with no segments. */
export function newDraft(init: DraftInit): DraftRecord {
  return {
    ...init,
    key: draftKeyFor(init.sha256, init.fingerprint),
    segments: [],
    phases: {},
    contentHash: computeContentHash([], {}),
    revision: 0,
    savedAt: 0,
    savedBy: '',
    exported: null,
  };
}

/**
 * Stable 64-bit (hex) hash over exactly what an export contains: phase id, phase name and frame
 * boundaries. Segment ids and colours are deliberately excluded.
 */
export function computeContentHash(segments: readonly Segment[], phases: Record<string, PhaseDef>): string {
  const rows = segments
    .map((s) => [s.start, s.end, s.phaseId, phases[s.phaseId]?.name ?? ''] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
  return fnv1a64(JSON.stringify(rows));
}

function fnv1a64(text: string): string {
  // Two independent 32-bit FNV-1a lanes (different offset bases) give 64 bits without BigInt.
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h1 >>> 13);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

function assertDraftKey(draft: DraftRecord): void {
  const valid = draft.sha256 !== null ? draft.key === draft.sha256 : draft.key === pendingKey(draft.fingerprint);
  if (!valid) throw new TypeError(`Draft key "${draft.key}" does not match its sha256/fingerprint`);
}

function defaultChannel(name: string): ChannelLike | null {
  return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(name);
}

function isDraftMessage(data: unknown): data is DraftMessage {
  if (typeof data !== 'object' || data === null) return false;
  const m = data as Record<string, unknown>;
  if (typeof m.tabId !== 'string' || typeof m.key !== 'string') return false;
  switch (m.type) {
    case 'draft-saved':
      return typeof m.revision === 'number';
    case 'draft-promoted':
      return typeof m.revision === 'number' && typeof m.from === 'string';
    case 'draft-deleted':
      return true;
    default:
      return false;
  }
}

export class DraftStore {
  readonly tabId: string;
  private readonly db: DbProvider;
  private readonly now: () => number;
  private readonly createChannel: (name: string) => ChannelLike | null;
  private channel: ChannelLike | null | undefined;

  constructor(options: DraftStoreOptions = {}) {
    this.db = options.db ?? defaultDb;
    this.tabId = options.tabId ?? TAB_ID;
    this.now = options.now ?? Date.now;
    this.createChannel = options.createChannel ?? defaultChannel;
  }

  async get(key: string): Promise<DraftRecord | null> {
    const rec = await singleRequest<DraftRecord | undefined>(this.db, 'drafts', 'readonly', (s) => s.get(key));
    return rec ?? null;
  }

  async list(): Promise<DraftRecord[]> {
    return singleRequest<DraftRecord[]>(this.db, 'drafts', 'readonly', (s) => s.getAll());
  }

  /**
   * Exact sha256 match wins. Otherwise the most recently saved draft with the same fingerprint whose
   * sha256 is unknown or equal (a fingerprint never overrides a different known sha256).
   */
  findForVideo(query: { sha256?: string | null; fingerprint: string }): Promise<DraftLookup | null> {
    const sha = query.sha256 ?? null;
    return runTransaction(this.db, 'drafts', 'readonly', (tx) => {
      const store = tx.objectStore('drafts');
      let bySha: DraftRecord | undefined;
      let byFp: DraftRecord[] = [];
      if (sha) {
        const r = store.get(sha);
        r.onsuccess = () => {
          bySha = r.result as DraftRecord | undefined;
        };
      }
      const f = store.index('fingerprint').getAll(query.fingerprint);
      f.onsuccess = () => {
        byFp = f.result as DraftRecord[];
      };
      return (): DraftLookup | null => {
        if (bySha) return { record: bySha, match: 'sha256' };
        const candidates = byFp
          .filter((d) => d.sha256 === null || d.sha256 === sha)
          .sort((a, b) => b.savedAt - a.savedAt);
        return candidates[0] ? { record: candidates[0], match: 'fingerprint' } : null;
      };
    });
  }

  /**
   * Writes `draft` with revision `baseRevision + 1` only if the stored revision still equals
   * `baseRevision` (a missing record counts as revision 0). The check and the write share one
   * readwrite transaction, so two tabs can never both succeed from the same base.
   */
  async save(draft: DraftRecord, baseRevision: number): Promise<SaveResult> {
    assertDraftKey(draft);
    const record: DraftRecord = { ...draft, revision: baseRevision + 1, savedAt: this.now(), savedBy: this.tabId };
    const result = await runTransaction(this.db, 'drafts', 'readwrite', (tx) => {
      const store = tx.objectStore('drafts');
      let outcome: SaveResult = { ok: false, conflict: null };
      const get = store.get(draft.key);
      get.onsuccess = () => {
        const stored = get.result as DraftRecord | undefined;
        if ((stored?.revision ?? 0) !== baseRevision) {
          outcome = { ok: false, conflict: stored ?? null };
          return;
        }
        store.put(record);
        outcome = { ok: true, record };
      };
      return () => outcome;
    });
    if (result.ok) this.broadcast({ type: 'draft-saved', key: record.key, revision: record.revision, tabId: this.tabId });
    return result;
  }

  /**
   * Atomically re-keys `pendingKey` to `sha256` (and moves its checkpoints). If a draft already
   * exists under `sha256`, nothing changes and both are reported for the UI to resolve.
   */
  async promotePending(pendingKeyValue: string, sha256: string): Promise<PromoteResult> {
    const result = await runTransaction(this.db, ['drafts', 'checkpoints'], 'readwrite', (tx) => {
      const drafts = tx.objectStore('drafts');
      let outcome: PromoteResult = { kind: 'not_found' };
      const getPending = drafts.get(pendingKeyValue);
      getPending.onsuccess = () => {
        const pending = getPending.result as DraftRecord | undefined;
        if (!pending) return;
        const getExisting = drafts.get(sha256);
        getExisting.onsuccess = () => {
          const existing = getExisting.result as DraftRecord | undefined;
          if (existing) {
            outcome = { kind: 'collision', collision: existing, pending };
            return;
          }
          const record: DraftRecord = {
            ...pending,
            key: sha256,
            sha256,
            revision: pending.revision + 1,
            savedAt: this.now(),
            savedBy: this.tabId,
          };
          drafts.put(record);
          drafts.delete(pendingKeyValue);
          rekeyCheckpointsInTx(tx, pendingKeyValue, sha256);
          outcome = { kind: 'promoted', record };
        };
      };
      return () => outcome;
    });
    if (result.kind === 'promoted') {
      this.broadcast({
        type: 'draft-promoted',
        from: pendingKeyValue,
        key: sha256,
        revision: result.record.revision,
        tabId: this.tabId,
      });
    }
    return result;
  }

  async delete(key: string): Promise<void> {
    await singleRequest(this.db, 'drafts', 'readwrite', (s) => s.delete(key));
    this.broadcast({ type: 'draft-deleted', key, tabId: this.tabId });
  }

  /** Listens to other tabs' draft messages (own messages are ignored). Returns an unsubscribe. */
  subscribe(callback: (message: DraftMessage) => void): () => void {
    const channel = this.getChannel();
    if (!channel) return () => undefined;
    const listener = (ev: MessageEvent): void => {
      if (isDraftMessage(ev.data) && ev.data.tabId !== this.tabId) callback(ev.data);
    };
    channel.addEventListener('message', listener);
    return () => channel.removeEventListener('message', listener);
  }

  close(): void {
    this.channel?.close();
    this.channel = null;
  }

  private getChannel(): ChannelLike | null {
    if (this.channel === undefined) {
      try {
        this.channel = this.createChannel(CHANNEL_NAME);
      } catch {
        this.channel = null;
      }
    }
    return this.channel;
  }

  private broadcast(message: DraftMessage): void {
    try {
      this.getChannel()?.postMessage(message);
    } catch {
      // Cross-tab notification is best effort; the revision check still prevents overwrites.
    }
  }
}

/** Shared by DraftStore.promotePending and CheckpointStore.rekey so both run inside a caller's tx. */
export function rekeyCheckpointsInTx(tx: IDBTransaction, oldVideoKey: string, newVideoKey: string): () => number {
  const store = tx.objectStore('checkpoints');
  let count = 0;
  const req = store.index('videoKey').getAll(oldVideoKey);
  req.onsuccess = () => {
    for (const cp of req.result as Array<{ videoKey: string }>) {
      store.put({ ...cp, videoKey: newVideoKey });
      count++;
    }
  };
  return () => count;
}
