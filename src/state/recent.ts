/**
 * Stable recent-phase chips (contract `AppState.visibleRecent`): computed from library.recent when
 * a video opens; afterwards a phase that is not shown replaces the least recently used visible chip
 * in place, so the other chips never move while the user works.
 */
export const MAX_VISIBLE_RECENT = 10;

/**
 * `fill` (the active preset's phases) tops up the chips while fewer than 10 phases were used, so a
 * first session still has clickable chips and working 1–5 keys. Fill chips count as least recent.
 */
export function initialVisibleRecent(recent: readonly string[], phaseExists: (id: string) => boolean, fill: readonly string[] = []): string[] {
  const out = recent.filter(phaseExists).slice(0, MAX_VISIBLE_RECENT);
  for (const id of fill) {
    if (out.length >= MAX_VISIBLE_RECENT) break;
    if (phaseExists(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Ensures `phaseId` is visible. `recent` is the library's most-recent-first list *before* this use;
 * visible chips missing from it count as least recent (the last such chip is replaced first).
 */
export function showInVisibleRecent(visible: readonly string[], phaseId: string, recent: readonly string[]): string[] {
  if (visible.includes(phaseId)) return visible as string[];
  if (visible.length < MAX_VISIBLE_RECENT) return [...visible, phaseId];
  let victim = 0;
  let victimRank = -1;
  visible.forEach((id, slot) => {
    const r = recent.indexOf(id);
    const rank = r < 0 ? Number.MAX_SAFE_INTEGER : r;
    if (rank >= victimRank) {
      victim = slot;
      victimRank = rank;
    }
  });
  const next = [...visible];
  next[victim] = phaseId;
  return next;
}
