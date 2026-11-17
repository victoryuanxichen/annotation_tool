/**
 * Application state entry point (contract: src/state/contract.ts). Creates the single controller
 * with the browser dependencies and exposes the zustand hook, the actions and the player helpers.
 */
import { useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import type { FrameIndex } from '../core/mp4/frameIndex';
import type { FramePlayer, PlayerSnapshot } from '../player';
import type { Actions, AppState } from './contract';
import { createController } from './controller';
import { createBrowserDeps } from './deps';
import { installTestHook } from './testHook';

export type * from './contract';
export { createController } from './controller';
export type { ControllerApi } from './controller';
export type { ControllerDeps, PlayerLike } from './deps';

const controller = createController(createBrowserDeps());

export const appStore: { getState(): AppState; subscribe(fn: (state: AppState, prev: AppState) => void): () => void } = controller.store;

/** zustand hook; use `useShallow` (zustand/react/shallow) for selectors returning new objects. */
export function useApp<T>(selector: (s: AppState) => T): T {
  return useStore(controller.store, selector);
}

export const actions: Actions = controller.actions;

export function getPlayer(): FramePlayer | null {
  return controller.getPlayer();
}

export function getFrameIndex(): FrameIndex | null {
  return controller.getFrameIndex();
}

export function getThumbnail(frame: number): { frame: number; bitmap: ImageBitmap } | null {
  return controller.getThumbnail(frame);
}

const EMPTY_SNAPSHOT: PlayerSnapshot = Object.freeze({
  status: 'empty',
  displayedFrame: null,
  requestedFrame: null,
  playing: false,
  rate: 1,
  error: null,
});

function subscribePlayer(onChange: () => void): () => void {
  let unsubPlayer: (() => void) | null = null;
  const bind = (): void => {
    unsubPlayer?.();
    unsubPlayer = controller.getPlayer()?.subscribe(onChange) ?? null;
  };
  bind();
  const unsubSwap = controller.onPlayerChange(() => {
    bind();
    onChange();
  });
  return () => {
    unsubSwap();
    unsubPlayer?.();
  };
}

function playerSnapshot(): PlayerSnapshot {
  return controller.getPlayer()?.getSnapshot() ?? EMPTY_SNAPSHOT;
}

/** Player state; FramePlayer notifies at most once per animation frame. */
export function usePlayerSnapshot(): PlayerSnapshot {
  return useSyncExternalStore(subscribePlayer, playerSnapshot, playerSnapshot);
}

installTestHook(controller);
