import { useEffect, useState, type CSSProperties, type DragEvent, type ReactElement } from 'react';
import { setLang, useT } from '../../i18n';
import { actions, useApp } from '../app';
import { DialogHost } from '../dialogs/DialogHost';
import { installShortcuts } from '../shortcuts';
import { useUi } from '../uiStore';
import { isModalOpen, Splitter } from '../kit';
import { BatchList } from './BatchList';
import { PhasePanel } from './PhasePanel';
import { PlayerStage } from './PlayerStage';
import { Timeline } from './timeline/Timeline';
import { Toasts } from './Toasts';
import { TopBar } from './TopBar';
import { TransportBar } from './TransportBar';
import { VideoHeader } from './VideoHeader';
import { WorkPane } from './WorkPane';
import './workbench.css';

const BOTTOM_MIN = 140;
/**
 * Side-panel height that shows all ten recent chips (one per row in the worst case) between the
 * compact selected-phase bar and the pinned marking block (budget in workbench.css). The video
 * column needs less than this, so it also bounds the video area.
 */
const SIDE_MIN = 566;
/** Top bar (40) + splitter hairline (1) + SIDE_MIN: the bottom panel never grows into it. */
const TOP_RESERVED = 40 + 1 + SIDE_MIN;

function useWindowHeight(): number {
  const [h, setH] = useState(() => window.innerHeight);
  useEffect(() => {
    const on = (): void => setH(window.innerHeight);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return h;
}

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes('Files');
}

/** SPEC §7.1 grid: top bar; video column + phase panel; splitter; work pane + batch list. */
export function AppShell(): ReactElement {
  const t = useT();
  const stored = useApp((s) => s.settings.bottomPanelHeight);
  const lang = useApp((s) => s.settings.language);
  const setDragOver = useUi((s) => s.setDragOver);
  const winH = useWindowHeight();
  const [live, setLive] = useState<number | null>(null);
  const max = Math.max(BOTTOM_MIN, winH - TOP_RESERVED);
  const height = Math.min(max, Math.max(BOTTOM_MIN, live ?? stored));

  useEffect(() => setLang(lang), [lang]);
  // The live drag height yields once the persisted value catches up.
  useEffect(() => setLive(null), [stored]);
  useEffect(() => installShortcuts(), []);

  // The native close warning (beforeunload) is installed by the controller.

  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (!hasFiles(e) || isModalOpen()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>): void => {
    // Only when the pointer leaves the window, not when it moves between children.
    if (e.relatedTarget === null || !e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    setDragOver(false);
    if (!hasFiles(e) || isModalOpen()) return;
    e.preventDefault();
    // DataTransfer is only readable synchronously inside the drop event.
    void actions.openDropped(e.dataTransfer);
  };

  return (
    <div
      className="wb"
      style={{ '--bottom-h': `${height}px` } as CSSProperties}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <TopBar />
      <main className="wb-main">
        <div className="wb-video">
          <VideoHeader />
          <PlayerStage />
          <TransportBar />
          <Timeline />
        </div>
        <PhasePanel />
      </main>
      <Splitter
        aria-label={t('kit.splitter.label')}
        aria-controls="wb-bottom"
        value={height}
        min={BOTTOM_MIN}
        max={max}
        onChange={setLive}
        onCommit={(v) => actions.setBottomPanelHeight(v)}
      />
      <div className="wb-bottom" id="wb-bottom">
        <WorkPane />
        <BatchList />
      </div>
      <DialogHost />
      <Toasts />
    </div>
  );
}
