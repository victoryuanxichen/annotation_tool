/** Public types of the frame-accurate player (SPEC §3). */

export type PlayerStatus = 'empty' | 'loading' | 'ready' | 'error';

export type PlayerErrorCode = 'codec_unsupported' | 'decode_failed' | 'read_failed' | 'webcodecs_missing';

export interface PlayerError {
  code: PlayerErrorCode;
  message: string;
}

export interface PlayerSnapshot {
  status: PlayerStatus;
  /** Frame whose pixels are on the canvas (verified by decoder timestamp). */
  displayedFrame: number | null;
  /** Latest seek target; null when settled. */
  requestedFrame: number | null;
  playing: boolean;
  /** 0.25 … 4 */
  rate: number;
  error: PlayerError | null;
}

/** Why a seek could not complete: a player error code, or the player was not loaded. */
export type SeekFailure = PlayerErrorCode | 'not_ready' | 'unloaded';

export type SeekOutcome =
  | { ok: true; superseded: false; frame: number }
  | { ok: false; superseded: true }
  | { ok: false; superseded: false; error: SeekFailure };

/** `error` is a PlayerErrorCode, 'timeout', 'empty' or 'unloaded'. */
export type SettledResult = { frame: number } | { error: string };

/** Counters for diagnostics and tests. */
export interface PlayerStats {
  /** Decoder runs started (each one is a reset + configure at an IDR sample). */
  runs: number;
  /** Encoded samples fed to the foreground decoder. */
  samplesFed: number;
  /** Byte-range reads issued to the ByteReader (foreground + thumbnails). */
  reads: number;
  /** ImageBitmaps created for the frame cache. */
  bitmapsCreated: number;
  /** Frames dropped because they were late during playback. */
  framesDropped: number;
  /** Bitmaps currently cached, and their approximate size. */
  cachedFrames: number;
  cachedBytes: number;
  thumbnails: number;
}

export const MIN_RATE = 0.25;
export const MAX_RATE = 4;
