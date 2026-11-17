import { useState, type FormEvent, type ReactElement } from 'react';
import { formatDateTime, useT, type MessageKey } from '../../i18n';
import { actions, useApp } from '../app';
import type { CheckpointSummary } from '../app';
import { Button, Dialog, EmptyState, IconButton, TextInput } from '../kit';

const KIND_KEY: Readonly<Record<CheckpointSummary['kind'], MessageKey>> = {
  manual: 'checkpoints.kind.manual',
  'auto-before-restore': 'checkpoints.kind.autoBeforeRestore',
  'auto-before-import': 'checkpoints.kind.autoBeforeImport',
  'auto-before-conflict': 'checkpoints.kind.autoBeforeConflict',
};

type Confirm = { kind: 'restore' | 'delete'; checkpoint: CheckpointSummary };

/** Named checkpoints for the open video: create, restore (current state saved first), delete. */
export function CheckpointsPanel(): ReactElement {
  const t = useT();
  const checkpoints = useApp((s) => s.checkpoints);
  const hasVideo = useApp((s) => s.video.itemId !== null || s.video.fileName !== null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const create = (e: FormEvent): void => {
    e.preventDefault();
    const finalName = name.trim() || t('checkpoints.defaultName', { time: formatDateTime(Date.now(), 'shortDatetime') });
    setBusy(true);
    void actions.createCheckpoint(finalName).finally(() => {
      setBusy(false);
      setName('');
    });
  };

  const run = (): void => {
    if (!confirm) return;
    const { kind, checkpoint } = confirm;
    setConfirm(null);
    void (kind === 'restore' ? actions.restoreCheckpoint(checkpoint.id) : actions.deleteCheckpoint(checkpoint.id));
  };

  const sorted = [...checkpoints].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="wb-checkpoints">
      <form className="wb-inline-form" onSubmit={create}>
        <TextInput
          size="sm"
          aria-label={t('checkpoints.name')}
          placeholder={t('checkpoints.name')}
          value={name}
          maxLength={120}
          disabled={!hasVideo}
          onChange={(e) => setName(e.target.value)}
          fieldClassName="wb-inline-form-field"
        />
        <Button type="submit" size="sm" icon="history" busy={busy} disabled={!hasVideo}>
          {t('checkpoints.create')}
        </Button>
      </form>
      {sorted.length === 0 ? (
        <EmptyState align="start" message={t('checkpoints.empty')} />
      ) : (
        <table className="wb-table" data-testid="checkpoints-table">
          <colgroup>
            <col />
            <col style={{ width: 132 }} />
            <col style={{ width: 132 }} />
            <col style={{ width: 84 }} />
            <col style={{ width: 128 }} />
          </colgroup>
          <thead>
            <tr>
              <th>{t('checkpoints.col.name')}</th>
              <th>{t('ui.checkpoints.col.kind')}</th>
              <th className="num">{t('checkpoints.col.time')}</th>
              <th className="num">{t('checkpoints.col.segments')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => (
              <tr key={c.id}>
                <td className="wb-cell-text" title={c.name}>
                  {c.name}
                </td>
                <td className="muted">{t(KIND_KEY[c.kind])}</td>
                <td className="num muted">{formatDateTime(c.createdAt, 'shortDatetime')}</td>
                <td className="num">{c.segmentCount}</td>
                <td>
                  <div className="wb-actions">
                    <Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: 'restore', checkpoint: c })}>
                      {t('checkpoints.restore')}
                    </Button>
                    <IconButton
                      size="sm"
                      icon="trash"
                      label={t('checkpoints.delete')}
                      onClick={() => setConfirm({ kind: 'delete', checkpoint: c })}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        size="sm"
        tone={confirm?.kind === 'delete' ? 'danger' : 'default'}
        title={confirm?.kind === 'delete' ? t('ui.checkpoints.deleteTitle') : t('checkpoints.restoreTitle')}
        description={
          confirm
            ? t(confirm.kind === 'delete' ? 'checkpoints.deleteBody' : 'checkpoints.restoreBody', {
                name: confirm.checkpoint.name,
              })
            : undefined
        }
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
            <Button variant={confirm?.kind === 'delete' ? 'danger' : 'primary'} onClick={run}>
              {confirm?.kind === 'delete' ? t('common.delete') : t('checkpoints.restore')}
            </Button>
          </>
        }
      />
    </div>
  );
}
