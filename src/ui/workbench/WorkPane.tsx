import type { ReactElement } from 'react';
import { useT } from '../../i18n';
import { actions, useApp } from '../app';
import { useUi, type BottomTab } from '../uiStore';
import { IconButton, TabPanel, Tabs } from '../kit';
import { CheckpointsPanel } from './CheckpointsPanel';
import { ExportPanel } from './ExportPanel';
import { SegmentsPanel } from './SegmentsPanel';

const ID = 'bottom';

/** Bottom-left pane: Segments / Checkpoints / Export tabs with undo and redo. */
export function WorkPane(): ReactElement {
  const t = useT();
  const tab = useUi((s) => s.bottomTab);
  const setTab = useUi((s) => s.setBottomTab);
  const segmentCount = useApp((s) => s.editor.doc.segments.length);
  const issueCount = useApp((s) => s.editor.issues.length);
  const checkpointCount = useApp((s) => s.checkpoints.length);
  const canUndo = useApp((s) => s.editor.canUndo);
  const canRedo = useApp((s) => s.editor.canRedo);

  return (
    <section className="wb-pane" aria-label={t('tabs.segments')}>
      <Tabs<BottomTab>
        idBase={ID}
        aria-label={t('ui.bottom.tabs')}
        value={tab}
        onChange={setTab}
        items={[
          { id: 'segments', label: t('tabs.segments'), count: segmentCount },
          { id: 'checkpoints', label: t('tabs.checkpoints'), count: checkpointCount },
          { id: 'export', label: issueCount > 0 ? <span className="wb-tab-issue">{t('tabs.export')}</span> : t('tabs.export') },
        ]}
        trailing={
          <>
            <IconButton
              icon="undo"
              size="sm"
              label={t('mark.undo')}
              kbd="Mod+Z"
              disabled={!canUndo}
              onClick={() => actions.undo()}
            />
            <IconButton
              icon="redo"
              size="sm"
              label={t('mark.redo')}
              kbd="Mod+Shift+Z"
              disabled={!canRedo}
              onClick={() => actions.redo()}
            />
          </>
        }
      />
      <div className="wb-scroll">
        <TabPanel idBase={ID} id="segments" active={tab === 'segments'}>
          <SegmentsPanel />
        </TabPanel>
        <TabPanel idBase={ID} id="checkpoints" active={tab === 'checkpoints'}>
          <CheckpointsPanel />
        </TabPanel>
        <TabPanel idBase={ID} id="export" active={tab === 'export'}>
          <ExportPanel />
        </TabPanel>
      </div>
    </section>
  );
}
