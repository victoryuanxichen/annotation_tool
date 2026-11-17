import { useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactElement } from 'react';
import { PHASE_PALETTE } from '../../core/phases';
import type { PhaseDef, Preset } from '../../core/types';
import { useT } from '../../i18n';
import { actions, useApp } from '../app';
import { useMsg } from '../msg';
import { Icon } from '../icons';
import { Button, Dialog, IconButton, Popover, Select, TextInput } from '../kit';
import { presetLabel } from '../workbench/phaseUtil';

/** Text field that commits on Enter or blur and reverts on Esc. Remount (key) to reset. */
function CommitInput({
  initial,
  label,
  onCommit,
  mono,
}: {
  initial: string;
  label: string;
  onCommit: (value: string) => void;
  mono?: boolean;
}): ReactElement {
  const [value, setValue] = useState(initial);
  const commit = (): void => {
    const v = value.trim();
    if (v && v !== initial) onCommit(v);
    else setValue(initial);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setValue(initial);
    }
  };
  return (
    <TextInput
      size="sm"
      mono={mono}
      aria-label={label}
      value={value}
      maxLength={120}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
    />
  );
}

function ColorButton({ phase }: { phase: PhaseDef }): ReactElement {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="wb-color-btn"
        style={{ '--chip-color': phase.color } as CSSProperties}
        aria-label={`${t('preset.recolor')}: ${phase.name}`}
        title={t('preset.recolor')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      />
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        placement="bottom-start"
        aria-label={t('phase.color')}
        className="wb-palette-pop"
      >
        <div className="wb-palette">
          {PHASE_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              className="wb-palette-swatch"
              style={{ background: c }}
              aria-label={c}
              aria-pressed={c.toLowerCase() === phase.color.toLowerCase()}
              onClick={() => {
                actions.recolorPhase(phase.id, c);
                setOpen(false);
                ref.current?.focus();
              }}
            >
              {c.toLowerCase() === phase.color.toLowerCase() ? <Icon name="check" size={12} /> : null}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

function PresetEditor({ preset, active }: { preset: Preset; active: boolean }): ReactElement {
  const t = useT();
  const tm = useMsg();
  const phases = useApp((s) => s.library.phases);
  const [addId, setAddId] = useState('');
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ids = preset.phaseIds;
  const label = presetLabel(preset, t);

  const setIds = (next: string[]): void => actions.setPresetPhases(preset.id, next);
  const move = (i: number, d: -1 | 1): void => {
    const next = [...ids];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setIds(next);
  };

  const available = Object.values(phases)
    .filter((p) => !ids.includes(p.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  const addNew = (e: FormEvent): void => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) {
      setError(t('phase.err.nameRequired'));
      return;
    }
    const result = actions.addCustomPhase(name);
    if (!result.ok) {
      setError(tm(result.msg));
      return;
    }
    setIds([...ids, result.id]);
    setNewName('');
    setError(null);
  };

  return (
    <div className="wb-preset-editor">
      <div className="wb-preset-editor-head">
        <CommitInput
          key={`${preset.id}|${label}`}
          initial={label}
          label={t('preset.rename')}
          onCommit={(v) => actions.renamePreset(preset.id, v)}
        />
        <Button
          size="sm"
          disabled={active}
          icon={active ? 'check' : undefined}
          onClick={() => actions.setActivePreset(preset.id)}
        >
          {active ? t('preset.active') : t('ui.presets.makeActive')}
        </Button>
        <IconButton icon="trash" size="sm" label={t('preset.delete')} onClick={() => setConfirmDelete(true)} />
      </div>
      {ids.length === 0 ? <p className="wb-hint">{t('preset.empty')}</p> : null}
      <ol className="wb-preset-phases">
        {ids.map((id, i) => {
          const phase = phases[id];
          if (!phase) return null;
          return (
            <li key={id} className="wb-preset-phase">
              <ColorButton phase={phase} />
              <CommitInput
                key={`${id}|${phase.name}`}
                initial={phase.name}
                label={t('preset.renamePhase')}
                onCommit={(v) => actions.renamePhase(id, v)}
              />
              <span className="wb-preset-phase-id u-truncate" title={`${t('phase.id')}: ${id}`}>
                {id}
              </span>
              <IconButton icon="chevron-up" size="sm" label={t('common.moveUp')} disabled={i === 0} onClick={() => move(i, -1)} />
              <IconButton
                icon="chevron-down"
                size="sm"
                label={t('common.moveDown')}
                disabled={i === ids.length - 1}
                onClick={() => move(i, 1)}
              />
              <IconButton
                icon="x"
                size="sm"
                label={t('preset.removePhase')}
                onClick={() => setIds(ids.filter((x) => x !== id))}
              />
            </li>
          );
        })}
      </ol>
      <div className="wb-preset-add">
        <Select<string>
          size="sm"
          aria-label={t('ui.presets.addExisting')}
          value={addId}
          onChange={setAddId}
          disabled={available.length === 0}
          options={[{ value: '', label: t('ui.presets.addExisting') }, ...available.map((p) => ({ value: p.id, label: p.name }))]}
        />
        <Button
          size="sm"
          icon="plus"
          disabled={!addId}
          onClick={() => {
            setIds([...ids, addId]);
            setAddId('');
          }}
        >
          {t('common.add')}
        </Button>
      </div>
      <form className="wb-preset-add" onSubmit={addNew} noValidate>
        <TextInput
          size="sm"
          aria-label={t('ui.presets.newPhase')}
          placeholder={t('ui.presets.newPhase')}
          value={newName}
          maxLength={120}
          error={error}
          onChange={(e) => {
            setNewName(e.target.value);
            setError(null);
          }}
        />
        <Button type="submit" size="sm" icon="plus">
          {t('preset.addPhase')}
        </Button>
      </form>
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        size="sm"
        tone="danger"
        title={t('preset.deleteTitle')}
        description={t('preset.deleteBody', { name: label })}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmDelete(false);
                actions.deletePreset(preset.id);
              }}
            >
              {t('common.delete')}
            </Button>
          </>
        }
      />
    </div>
  );
}

/** Create/rename/delete presets; add, remove, reorder, rename and recolour their phases. */
export function PresetsDialog({ onClose }: { onClose: () => void }): ReactElement {
  const t = useT();
  const presets = useApp((s) => s.library.presets);
  const activeId = useApp((s) => s.library.activePresetId);
  const [selectedId, setSelectedId] = useState<string | null>(activeId ?? presets[0]?.id ?? null);
  const selected = presets.find((p) => p.id === selectedId) ?? presets[0] ?? null;

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={t('preset.title')}
      footerNote={t('preset.switchNote')}
      footer={<Button onClick={onClose}>{t('common.done')}</Button>}
      className="wb-presets"
      data-testid="presets-dialog"
    >
      <div className="wb-presets-grid">
        <div className="wb-presets-list">
          <ul aria-label={t('ui.presets.list')}>
            {presets.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className={p.id === selected?.id ? 'wb-presets-item is-selected' : 'wb-presets-item'}
                  aria-pressed={p.id === selected?.id}
                  onClick={() => setSelectedId(p.id)}
                >
                  <span className="wb-presets-check">
                    {p.id === activeId ? <Icon name="check" size={14} title={t('preset.active')} /> : null}
                  </span>
                  <span className="u-truncate">{presetLabel(p, t)}</span>
                  <span className="wb-presets-count u-tnum">{p.phaseIds.length}</span>
                </button>
              </li>
            ))}
          </ul>
          <Button size="sm" variant="ghost" icon="plus" onClick={() => setSelectedId(actions.createPreset(t('preset.newName')))}>
            {t('preset.new')}
          </Button>
        </div>
        {selected ? (
          <PresetEditor key={selected.id} preset={selected} active={selected.id === activeId} />
        ) : (
          <p className="wb-hint">{t('preset.empty')}</p>
        )}
      </div>
    </Dialog>
  );
}
