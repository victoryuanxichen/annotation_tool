import type { ReactElement } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { LANGS, LANG_LABEL_KEY, formatDateTime, useT } from '../../i18n';
import { actions, useApp } from '../app';
import type { Lang, ThemePref } from '../app';
import { useResolvedTheme } from '../theme';
import { selectCurrentIndex } from '../hooks';
import { useMsg } from '../msg';
import { Button, IconButton, MenuButton, MiddleEllipsis, SegmentedControl, StatusDot, type MenuEntry } from '../kit';

function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}

function SaveState(): ReactElement {
  const t = useT();
  const tm = useMsg();
  const save = useApp((s) => s.save);
  let dot: ReactElement;
  switch (save.kind) {
    case 'idle':
      dot = <StatusDot tone="neutral" label={t('save.idle')} />;
      break;
    case 'saving':
      dot = <StatusDot tone="busy" label={t('save.saving')} />;
      break;
    case 'saved':
      dot = <StatusDot tone="ok" label={t('save.saved', { time: formatDateTime(save.at, 'time') })} />;
      break;
    case 'conflict':
      dot = <StatusDot tone="attention" tintLabel label={t('save.conflict')} />;
      break;
    case 'error':
      dot = (
        <StatusDot tone="danger" tintLabel label={t('save.failed')} title={t('save.failedDetail', { reason: tm(save.msg) })} />
      );
      break;
  }
  return (
    <span className="wb-state wb-state--save" data-testid="save-state">
      <span className="wb-state-label">{t('save.label')}</span>
      {dot}
      {save.kind === 'error' ? (
        <Button size="sm" variant="ghost" icon="refresh" onClick={() => actions.retrySave()}>
          {t('common.retry')}
        </Button>
      ) : null}
    </span>
  );
}

function ExportState(): ReactElement {
  const t = useT();
  const tm = useMsg();
  const status = useApp((s) => s.exportStatus);
  let dot: ReactElement;
  let target: string | null = null;
  switch (status.kind) {
    case 'none':
      dot = <StatusDot tone="neutral" label={t('exportState.none')} />;
      break;
    case 'dirty':
      dot = <StatusDot tone="attention" tintLabel label={t('exportState.dirty')} />;
      break;
    case 'exporting':
      dot = <StatusDot tone="busy" label={t('exportState.exporting')} />;
      break;
    case 'exported':
      dot = <StatusDot tone="ok" label={t('exportState.exported', { time: formatDateTime(status.at, 'time') })} />;
      target = status.targets.map(baseName).join(', ');
      break;
    case 'error':
      dot = <StatusDot tone="danger" tintLabel label={t('exportState.failed')} title={tm(status.msg)} />;
      break;
  }
  return (
    <span className="wb-state wb-state--export" data-testid="export-state">
      <span className="wb-state-label">{t('exportState.label')}</span>
      {dot}
      {target ? (
        <span className="wb-state-target">
          <span aria-hidden>→</span>
          <MiddleEllipsis
            text={target}
            title={status.kind === 'exported' ? status.targets.join('\n') : undefined}
            className="wb-state-target-name"
          />
        </span>
      ) : null}
    </span>
  );
}

/** Product mark · batch position · save state · export state · open menu · language · help. */
export function TopBar(): ReactElement {
  const t = useT();
  const lang = useApp((s) => s.settings.language);
  const themePref = useApp((s) => s.settings.theme);
  const resolvedTheme = useResolvedTheme();
  const { index, total, mode } = useApp(
    useShallow((s) => ({ index: selectCurrentIndex(s), total: s.batch.items.length, mode: s.batch.mode })),
  );

  const openItems: MenuEntry[] = [
    { id: 'file', label: t('topbar.openFile'), icon: 'file', onSelect: () => void actions.openFile() },
    { id: 'folder', label: t('topbar.openFolder'), icon: 'folder', onSelect: () => void actions.openFolder() },
    { id: 'sep', kind: 'separator' },
    {
      id: 'close',
      label: t('topbar.closeFolder'),
      icon: 'x',
      disabled: mode === 'none',
      onSelect: () => void actions.closeBatch(),
    },
  ];

  const themeItems: MenuEntry[] = (['dark', 'light', 'system'] as const).map((p: ThemePref) => ({
    id: `theme-${p}`,
    label: t(`theme.${p}`),
    icon: p === 'dark' ? 'moon' : p === 'light' ? 'sun' : 'monitor',
    checked: themePref === p,
    onSelect: () => actions.setTheme(p),
  }));

  return (
    <header className="wb-top">
      <div className="wb-mark">
        <span className="wb-mark-glyph" aria-hidden />
        {t('app.name')}
      </div>
      <span className="wb-sep" aria-hidden />
      {index >= 0 ? (
        <span
          className="wb-batchpos"
          aria-label={t('topbar.batchPositionLabel', { index: index + 1, total })}
          data-testid="batch-position"
        >
          <b>{index + 1}</b> / {total}
        </span>
      ) : (
        <span className="wb-batchpos wb-batchpos--none">{t('topbar.noBatch')}</span>
      )}
      <span className="wb-sep" aria-hidden />
      <SaveState />
      <ExportState />
      <div className="wb-top-end">
        <MenuButton items={openItems} label={t('topbar.openMenu')} icon="folder" placement="bottom-end" variant="ghost" size="sm">
          {t('topbar.openMenu')}
        </MenuButton>
        <SegmentedControl<Lang>
          aria-label={t('lang.label')}
          size="sm"
          value={lang}
          onChange={(l) => actions.setLanguage(l)}
          options={LANGS.map((l) => ({ value: l, label: l === 'en' ? 'EN' : '繁中', title: t(LANG_LABEL_KEY[l]) }))}
        />
        <MenuButton
          items={themeItems}
          label={t('theme.label')}
          icon={resolvedTheme === 'light' ? 'sun' : 'moon'}
          placement="bottom-end"
          variant="ghost"
          size="sm"
          className="wb-theme-btn"
        />
        <IconButton
          icon="help"
          label={t('topbar.help')}
          kbd="Shift+/"
          tooltipPlacement="bottom"
          onClick={() => actions.openDialog({ kind: 'help' })}
        />
      </div>
    </header>
  );
}
