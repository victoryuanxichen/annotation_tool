import type { ReactElement } from 'react';
import { actions, useApp } from '../app';
import { HelpDialog } from './HelpDialog';
import { PresetsDialog } from './PresetsDialog';
import { CheckpointNameDialog, ConfirmCloseBatchDialog, ImportChoiceDialog } from './SmallDialogs';
import { SwitchFailedDialog } from './SwitchFailedDialog';

/** Renders the controller's current dialog (state.dialog). */
export function DialogHost(): ReactElement | null {
  const dialog = useApp((s) => s.dialog);
  if (!dialog) return null;
  const close = (): void => actions.closeDialog();
  switch (dialog.kind) {
    case 'help':
      return <HelpDialog onClose={close} />;
    case 'presets':
      return <PresetsDialog onClose={close} />;
    case 'switch-failed':
      return <SwitchFailedDialog failure={dialog.failure} />;
    case 'import-choice':
      return (
        <ImportChoiceDialog
          sidecarName={dialog.sidecarName}
          fileSegmentCount={dialog.fileSegmentCount}
          draftSegmentCount={dialog.draftSegmentCount}
        />
      );
    case 'confirm-close-batch':
      return <ConfirmCloseBatchDialog unexportedCount={dialog.unexportedCount} />;
    case 'checkpoint-name':
      return <CheckpointNameDialog defaultName={dialog.defaultName} />;
  }
}
