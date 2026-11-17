/**
 * Single bridge between the UI and the application controller (src/state). Every UI module
 * imports controller values and contract types from here, never from src/state directly.
 */
export { useApp, appStore, actions, getPlayer, usePlayerSnapshot, getFrameIndex, getThumbnail } from '../state';
export type * from '../state/contract';
