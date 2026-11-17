/**
 * Global keyboard shortcuts (SPEC §7.9). One window listener; keys are matched by
 * `event.code` (physical key) so they work with any keyboard layout and while a CJK input
 * method is active outside text fields.
 */
import { actions, appStore, getFrameIndex, getPlayer } from './app';
import { isModalOpen } from './kit';

const TEXT_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

/** True when the key belongs to whatever the user is typing into (or a menu being navigated). */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (TEXT_TAGS.has(target.tagName) || target.isContentEditable) return true;
  return target.closest('[role="menu"]') !== null;
}

const DIGITS: Readonly<Record<string, number>> = { Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4, Digit5: 5 };

function lastFrame(): number | null {
  const index = getFrameIndex();
  return index && index.frameCount > 0 ? index.frameCount - 1 : null;
}

function togglePlay(): void {
  const player = getPlayer();
  if (!player) return;
  if (player.getSnapshot().playing) player.pause();
  else player.play();
}

/** Returns true when the event was handled. */
function handle(e: KeyboardEvent): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.altKey) {
    if (e.code === 'KeyZ') {
      if (e.shiftKey) actions.redo();
      else actions.undo();
      return true;
    }
    if (e.code === 'KeyY' && !e.shiftKey && !e.metaKey) {
      actions.redo();
      return true;
    }
    return false;
  }
  if (mod || e.altKey) return false;

  // Stepping repeats while the key is held (the player coalesces seeks); nothing else does.
  if (e.code === 'KeyA' || e.code === 'KeyD') {
    const delta = (e.code === 'KeyA' ? -1 : 1) * (e.shiftKey ? 10 : 1);
    void getPlayer()?.step(delta);
    return true;
  }
  if (e.code === 'Space') {
    if (!e.repeat) togglePlay();
    return true;
  }
  if (e.repeat) {
    return e.code in DIGITS || ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyZ', 'KeyX'].includes(e.code);
  }

  if (e.code in DIGITS) {
    actions.selectRecentSlot(DIGITS[e.code] + (e.shiftKey ? 5 : 0));
    return true;
  }
  if (e.shiftKey && (e.code === 'Slash' || e.key === '?')) {
    actions.openDialog({ kind: 'help' });
    return true;
  }
  if (e.shiftKey) {
    // Previous / next video (mnemonic with Z / X = first / last frame); goes through the export gate.
    if (e.code === 'KeyZ') {
      void actions.prevVideo();
      return true;
    }
    if (e.code === 'KeyX') {
      void actions.nextVideo();
      return true;
    }
    return false;
  }

  switch (e.code) {
    case 'KeyQ':
      void actions.markStart();
      return true;
    case 'KeyW':
      void actions.markFinish();
      return true;
    case 'KeyE':
      void actions.markFinishAndNext();
      return true;
    case 'KeyR':
      void actions.markThroughEnd();
      return true;
    case 'KeyZ':
      void getPlayer()?.seek(0);
      return true;
    case 'KeyX': {
      const last = lastFrame();
      if (last !== null) void getPlayer()?.seek(last);
      return true;
    }
    case 'Escape':
      if (appStore.getState().editor.pendingStart === null) return false;
      actions.cancelPendingStart();
      return true;
    default:
      return false;
  }
}

/** Installs the listener; returns the uninstall function. */
export function installShortcuts(): () => void {
  let swallowSpaceUp = false;

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.isComposing) return;
    if (isModalOpen() || isTypingTarget(e.target)) return;
    if (handle(e)) {
      // Also stops Space from scrolling or pressing a focused button.
      e.preventDefault();
      if (e.code === 'Space') swallowSpaceUp = true;
    }
  };

  // Buttons activate on Space keyup; swallow the keyup that belongs to a handled keydown.
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space' && swallowSpaceUp) {
      swallowSpaceUp = false;
      e.preventDefault();
    }
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp, true);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp, true);
  };
}
