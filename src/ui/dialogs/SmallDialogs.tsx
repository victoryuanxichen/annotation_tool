import { useRef, useState, type FormEvent, type ReactElement } from 'react';
import { useT } from '../../i18n';
import { actions } from '../app';
import { Button, Dialog, TextInput } from '../kit';

/** A matching sidecar differs from the draft: use the file (draft is checkpointed) or keep the draft. */
export function ImportChoiceDialog({
  sidecarName,
  fileSegmentCount,
  draftSegmentCount,
}: {
  sidecarName: string;
  fileSegmentCount: number;
  draftSegmentCount: number;
}): ReactElement {
  const t = useT();
  return (
    <Dialog
      open
      dismissible={false}
      onClose={() => void actions.resolveImportChoice('keep-draft')}
      title={t('conflict.title')}
      description={t('conflict.body', { file: sidecarName })}
      footerNote={t('conflict.note')}
      footer={
        <>
          <Button onClick={() => void actions.resolveImportChoice('keep-draft')}>{t('conflict.keepDraft')}</Button>
          <Button variant="primary" onClick={() => void actions.resolveImportChoice('use-file')}>
            {t('conflict.useFile')}
          </Button>
        </>
      }
      data-testid="import-choice-dialog"
    >
      <dl className="wb-compare">
        <dt>{t('ui.import.draft')}</dt>
        <dd>{t('segments.count', { count: draftSegmentCount })}</dd>
        <dt>{t('ui.import.file')}</dt>
        <dd>{t('segments.count', { count: fileSegmentCount })}</dd>
      </dl>
    </Dialog>
  );
}

/**
 * Closing the batch while videos have unexported changes. The controller opens this dialog from
 * actions.closeBatch(); calling closeBatch() again while it is open confirms ("Leave anyway").
 */
export function ConfirmCloseBatchDialog({ unexportedCount }: { unexportedCount: number }): ReactElement {
  const t = useT();
  return (
    <Dialog
      open
      onClose={() => actions.closeDialog()}
      tone="warning"
      title={t('leave.title')}
      description={t('leave.body', { count: unexportedCount })}
      footer={
        <>
          <Button onClick={() => actions.closeDialog()}>{t('leave.stay')}</Button>
          <Button
            onClick={() => {
              actions.closeDialog();
              void actions.exportNow();
            }}
          >
            {t('leave.exportFirst')}
          </Button>
          <Button variant="danger" onClick={() => void actions.closeBatch()}>
            {t('leave.confirm')}
          </Button>
        </>
      }
      data-testid="confirm-close-dialog"
    />
  );
}

/** Name prompt for a new checkpoint. */
export function CheckpointNameDialog({ defaultName }: { defaultName: string }): ReactElement {
  const t = useT();
  const [name, setName] = useState(defaultName);
  const inputRef = useRef<HTMLInputElement>(null);
  const submit = (e?: FormEvent): void => {
    e?.preventDefault();
    const finalName = name.trim() || defaultName;
    actions.closeDialog();
    void actions.createCheckpoint(finalName);
  };
  return (
    <Dialog
      open
      size="sm"
      onClose={() => actions.closeDialog()}
      title={t('checkpoints.create')}
      initialFocusRef={inputRef}
      footer={
        <>
          <Button onClick={() => actions.closeDialog()}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => submit()}>
            {t('checkpoints.create')}
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        <TextInput
          ref={inputRef}
          label={t('checkpoints.name')}
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
        />
      </form>
    </Dialog>
  );
}
