import type { ReactElement } from 'react';
import { useT } from '../../i18n';
import { actions, useApp } from '../app';
import type { SwitchFailure } from '../app';
import { useMsg } from '../msg';
import { useUi } from '../uiStore';
import { Button, Dialog } from '../kit';

/** Export-before-switch failed: explain why and offer the recovery paths (SPEC §7.7). */
export function SwitchFailedDialog({ failure }: { failure: SwitchFailure }): ReactElement {
  const t = useT();
  const tm = useMsg();
  const fileName = useApp((s) => s.video.fileName ?? s.video.relPath ?? '');
  const setTab = useUi((s) => s.setBottomTab);
  const resolve = (choice: Parameters<typeof actions.resolveSwitchFailure>[0]): void => {
    void actions.resolveSwitchFailure(choice);
  };

  const reason =
    failure.reason === 'validation'
      ? t('export.reason.validation')
      : failure.reason === 'write'
        ? tm(failure.msg)
        : t('switch.hashPending');

  let footer: ReactElement;
  if (failure.reason === 'validation') {
    footer = (
      <>
        <Button variant="ghost" onClick={() => resolve('switch-without-export')}>
          {t('switch.withoutExport')}
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            const first = failure.issues[0]?.segmentIds[0];
            resolve('stay');
            setTab('segments');
            if (first) actions.selectSegment(first, { seek: true });
          }}
        >
          {t('switch.fixIssues')}
        </Button>
      </>
    );
  } else if (failure.reason === 'write') {
    footer = (
      <>
        <Button variant="ghost" onClick={() => resolve('switch-without-export')}>
          {t('switch.withoutExport')}
        </Button>
        <Button onClick={() => resolve('stay')}>{t('switch.stay')}</Button>
        <Button onClick={() => resolve('choose-folder')}>{t('switch.chooseFolder')}</Button>
        <Button variant="primary" icon="download" onClick={() => resolve('download-and-switch')}>
          {t('switch.download')}
        </Button>
      </>
    );
  } else {
    footer = (
      <>
        <Button variant="ghost" onClick={() => resolve('switch-without-export')}>
          {t('switch.withoutExport')}
        </Button>
        <Button variant="primary" onClick={() => resolve('stay')}>
          {t('switch.stay')}
        </Button>
      </>
    );
  }

  return (
    <Dialog
      open
      onClose={() => resolve('stay')}
      tone="warning"
      size="lg"
      title={t('switch.failedTitle')}
      description={t('switch.failedBody', { file: fileName, reason })}
      footerNote={t('switch.draftKept')}
      footer={footer}
      data-testid="switch-failed-dialog"
    >
      {failure.reason === 'validation' && failure.issues.length > 0 ? (
        <ul className="wb-dialog-list">
          {failure.issues.map((issue, i) => (
            <li key={`${issue.code}-${i}`}>{tm(issue.msg)}</li>
          ))}
        </ul>
      ) : null}
    </Dialog>
  );
}
