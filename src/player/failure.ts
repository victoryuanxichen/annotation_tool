import type { PlayerErrorCode } from './types';

/** Internal error carrying a player error code; surfaces as `status: 'error'`. */
export class PlayerFailure extends Error {
  constructor(
    readonly code: PlayerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PlayerFailure';
  }
}

export function toFailure(e: unknown, fallback: PlayerErrorCode): PlayerFailure {
  if (e instanceof PlayerFailure) return e;
  const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return new PlayerFailure(fallback, message);
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}
