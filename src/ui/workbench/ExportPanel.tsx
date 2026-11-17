import type { ReactElement } from 'react';
import { formatDateTime, useT } from '../../i18n';
import type { ExportFormatChoice } from '../../core/types';
import { actions, useApp } from '../app';
import type { ExportDestination, SidecarStatus } from '../app';
import { useMsg } from '../msg';
import { useUi } from '../uiStore';
import { Icon } from '../icons';
import { Button, MiddleEllipsis, SegmentedControl, StatusDot, type StatusTone } from '../kit';

const SIDECAR_TONE: Readonly<Record<SidecarStatus['state'], StatusTone>> = {
  checking: 'busy',
  match: 'ok',
  mismatch: 'danger',
  invalid: 'danger',
};

function ExportStatusLine(): ReactElement {
  const t = useT();
  const tm = useMsg();
  const status = useApp((s) => s.exportStatus);
  switch (status.kind) {
    case 'none':
      return <p className="wb-export-status">{t('export.never')}</p>;
    case 'dirty':
      return <p className="wb-export-status wb-export-status--attention">{t('exportState.dirty')}</p>;
    case 'exporting':
      return <p className="wb-export-status">{t('exportState.exporting')}</p>;
    case 'exported':
      return (
        <p className="wb-export-status wb-export-status--ok" title={status.targets.join('\n')}>
          {t('export.last', { time: formatDateTime(status.at, 'time'), target: status.targets.join(', ') })}
        </p>
      );
    case 'error':
      return (
        <p className="wb-export-status wb-export-status--danger" role="alert">
          {tm(status.msg)}
        </p>
      );
  }
}

function Validation(): ReactElement {
  const t = useT();
  const tm = useMsg();
  const issues = useApp((s) => s.editor.issues);
  const setTab = useUi((s) => s.setBottomTab);
  if (issues.length === 0) {
    return (
      <p className="wb-validation wb-validation--ok">
        <Icon name="check" size={14} />
        {t('export.validation.ok')}
      </p>
    );
  }
  return (
    <div className="wb-validation">
      <p className="wb-validation-head">
        <Icon name="alert" size={14} />
        {t('export.validation.issues', { count: issues.length })}
      </p>
      <ul className="wb-validation-list">
        {issues.map((issue, i) => (
          <li key={`${issue.code}-${i}`}>
            <span className="wb-validation-msg">{tm(issue.msg)}</span>
            {issue.segmentIds.length > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  actions.selectSegment(issue.segmentIds[0], { seek: true });
                  setTab('segments');
                }}
              >
                {t('segments.seek')}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Sidecars(): ReactElement {
  const t = useT();
  const tm = useMsg();
  const sidecars = useApp((s) => s.video.sidecars);
  const sourceFolder = useApp((s) => s.video.sourceFolder);
  if (sourceFolder === 'needs-access') {
    return (
      <div className="wb-note">
        <p>{t('folder.notice')}</p>
        <Button size="sm" icon="folder" onClick={() => void actions.requestSourceFolderAccess()}>
          {t('folder.allow')}
        </Button>
      </div>
    );
  }
  if (sidecars.length === 0) return <p className="wb-hint">{t('import.noneDetected')}</p>;
  return (
    <ul className="wb-sidecars" data-testid="sidecars">
      {sidecars.map((sc) => (
        <li key={sc.relPath} className="wb-sidecar">
          <div className="wb-sidecar-row">
            <MiddleEllipsis text={sc.name} title={sc.relPath} className="wb-sidecar-name" />
            <StatusDot size="sm" tone={SIDECAR_TONE[sc.state]} label={t(`import.state.${sc.state}`)} />
            <span className="wb-sidecar-count u-tnum">
              {sc.segmentCount === null ? '' : t('segments.count', { count: sc.segmentCount })}
            </span>
            <Button size="sm" disabled={sc.state !== 'match'} onClick={() => void actions.importSidecar(sc.relPath)}>
              {t('import.load')}
            </Button>
          </div>
          {sc.problems.length > 0 ? (
            <ul className="wb-sidecar-problems">
              {sc.problems.map((p, i) => (
                <li key={i}>{tm(p)}</li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Export settings and action, validation summary, manual import and detected sidecar files. */
export function ExportPanel(): ReactElement {
  const t = useT();
  const format = useApp((s) => s.settings.exportFormat);
  const dest = useApp((s) => s.settings.exportDestination);
  const exporting = useApp((s) => s.exportStatus.kind === 'exporting');
  const hasVideo = useApp((s) => s.video.itemId !== null || s.video.fileName !== null);
  const fsAccess = useApp((s) => s.capabilities.fileSystemAccess);
  const sourceFolder = useApp((s) => s.video.sourceFolder);
  const empty = useApp((s) => s.editor.doc.segments.length === 0 && s.editor.touched);

  return (
    <div className="wb-export">
      <section className="wb-export-col" aria-label={t('tabs.export')}>
        <div className="wb-form-row">
          <span className="wb-form-label">{t('export.format')}</span>
          <SegmentedControl<ExportFormatChoice>
            size="sm"
            aria-label={t('export.format')}
            value={format}
            onChange={(f) => actions.setExportFormat(f)}
            options={[
              { value: 'csv', label: t('export.format.csv') },
              { value: 'json', label: t('export.format.json') },
              { value: 'both', label: t('export.format.both') },
            ]}
          />
        </div>
        <div className="wb-form-row">
          <span className="wb-form-label">{t('export.destination')}</span>
          <SegmentedControl<ExportDestination['kind']>
            size="sm"
            aria-label={t('export.destination')}
            value={dest.kind}
            onChange={(k) => void actions.setExportDestination(k)}
            options={[
              {
                value: 'beside',
                label: t('ui.export.dest.beside'),
                title: t('export.dest.beside'),
                disabled: !fsAccess || sourceFolder === 'unsupported',
              },
              { value: 'folder', label: t('ui.export.dest.folder'), title: t('export.chooseFolder'), disabled: !fsAccess },
              { value: 'download', label: t('export.dest.download') },
            ]}
          />
        </div>
        <p className="wb-hint wb-dest-detail">
          {dest.kind === 'folder'
            ? t('ui.export.folderNamed', { name: dest.folderName })
            : !fsAccess
              ? t('notice.noFsAccess')
              : dest.kind === 'beside' && sourceFolder === 'needs-access'
                ? t('video.sourceFolder.needsAccess')
                : ' '}
        </p>
        <div className="wb-export-action">
          <Button
            variant="primary"
            icon="download"
            busy={exporting}
            disabled={!hasVideo}
            onClick={() => void actions.exportNow()}
          >
            {t('export.now')}
          </Button>
          <ExportStatusLine />
        </div>
        {empty ? <p className="wb-hint">{t('export.emptyNote')}</p> : null}
        <Validation />
      </section>
      <section className="wb-export-col" aria-label={t('ui.export.importHeading')}>
        <div className="wb-export-col-head">
          <h3>{t('import.detected')}</h3>
          <Button size="sm" icon="upload" disabled={!hasVideo} onClick={() => void actions.importFromFile()}>
            {t('import.file')}
          </Button>
        </div>
        <Sidecars />
      </section>
    </div>
  );
}
