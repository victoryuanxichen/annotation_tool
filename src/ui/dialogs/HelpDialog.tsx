import type { ReactElement } from 'react';
import { useT, type MessageKey } from '../../i18n';
import { Button, Dialog, Kbd } from '../kit';

interface Row {
  keys: string[];
  label: MessageKey;
}

const SECTIONS: ReadonlyArray<{ title: MessageKey; rows: Row[] }> = [
  {
    title: 'help.section.playback',
    rows: [
      { keys: ['Space'], label: 'help.key.playPause' },
      { keys: ['A', 'D'], label: 'help.key.step' },
      { keys: ['Shift+A', 'Shift+D'], label: 'help.key.step10' },
      { keys: ['Z', 'X'], label: 'help.key.firstLast' },
    ],
  },
  {
    title: 'help.section.marking',
    rows: [
      { keys: ['Q'], label: 'help.key.start' },
      { keys: ['W'], label: 'help.key.finish' },
      { keys: ['E'], label: 'help.key.finishNext' },
      { keys: ['R'], label: 'help.key.throughEnd' },
    ],
  },
  {
    title: 'help.section.phases',
    rows: [
      { keys: ['1–5'], label: 'help.key.recent1to5' },
      { keys: ['Shift+1–5'], label: 'help.key.recent6to10' },
    ],
  },
  {
    title: 'help.section.editing',
    rows: [
      { keys: ['Mod+Z'], label: 'help.key.undo' },
      { keys: ['Mod+Shift+Z'], label: 'help.key.redo' },
      { keys: ['Esc'], label: 'help.key.escape' },
      { keys: ['Shift+/'], label: 'help.key.help' },
    ],
  },
];

const TIMELINE: ReadonlyArray<MessageKey> = [
  'help.timeline.scrub',
  'help.timeline.zoom',
  'help.timeline.pan',
  'help.timeline.boundary',
];

const ABOUT: ReadonlyArray<MessageKey> = [
  'help.about.halfOpen',
  'ui.help.boundary',
  'help.about.confirm',
  'help.about.switch',
  'help.about.storage',
];

const EXPORT: ReadonlyArray<MessageKey> = ['ui.help.exportFormats', 'ui.help.exportColumns', 'ui.help.exportEmpty'];

const ENVIRONMENT: ReadonlyArray<MessageKey> = ['ui.help.browser', 'ui.help.offline'];

/** All shortcuts and the rules behind marking, exports and storage. Never shown on the main screen. */
export function HelpDialog({ onClose }: { onClose: () => void }): ReactElement {
  const t = useT();
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('help.title')}
      size="lg"
      footerNote={t('help.typingNote')}
      footer={<Button onClick={onClose}>{t('common.close')}</Button>}
      className="wb-help"
      data-testid="help-dialog"
    >
      <div className="help-grid">
        {SECTIONS.map((s) => (
          <div key={s.title} className="help-section">
            <h3>{t(s.title)}</h3>
            {s.rows.map((r) => (
              <div key={r.label} className="help-row">
                <span>{t(r.label)}</span>
                <span className="help-keys">
                  {r.keys.map((k) => (
                    <Kbd key={k} keys={k} size="md" />
                  ))}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="help-about">
        <h3>{t('help.section.timeline')}</h3>
        <ul>
          {TIMELINE.map((k) => (
            <li key={k}>{t(k)}</li>
          ))}
        </ul>
        <h3>{t('help.section.about')}</h3>
        <ul>
          {ABOUT.map((k) => (
            <li key={k}>{t(k)}</li>
          ))}
        </ul>
        <h3>{t('ui.help.section.export')}</h3>
        <ul>
          {EXPORT.map((k) => (
            <li key={k}>{t(k)}</li>
          ))}
        </ul>
        <h3>{t('ui.help.section.environment')}</h3>
        <ul>
          {ENVIRONMENT.map((k) => (
            <li key={k}>{t(k)}</li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
