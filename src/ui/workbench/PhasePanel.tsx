import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { useT } from '../../i18n';
import { actions, useApp } from '../app';
import type { PhaseDef } from '../../core/types';
import { releaseFocus, useReleaseAfterPointerPick } from '../hooks';
import { useMsg } from '../msg';
import { Button, Chip, IconButton, Popover, Select, TextInput } from '../kit';
import { MarkingBlock } from './MarkingBlock';
import { phaseGroups, presetLabel, slotLabel } from './phaseUtil';

function usePhaseLookup(): (id: string) => PhaseDef | undefined {
  const lib = useApp((s) => s.library.phases);
  const doc = useApp((s) => s.editor.doc.phases);
  return (id) => lib[id] ?? doc[id];
}

/** Compact one-line header: label, swatch and name (the ID is in the tooltip). */
function SelectedPhase(): ReactElement {
  const t = useT();
  const lookup = usePhaseLookup();
  const selectedId = useApp((s) => s.selectedPhaseId);
  const phase = selectedId ? lookup(selectedId) : undefined;
  return (
    <section className="wb-section wb-selbar" aria-label={t('phase.selected')}>
      <div className="wb-selected" data-testid="selected-phase" title={phase ? `${phase.name} · ${phase.id}` : undefined}>
        <span className="wb-selected-label">{t('phase.selected')}</span>
        <span
          className={phase ? 'wb-selected-swatch' : 'wb-selected-swatch wb-selected-swatch--none'}
          style={phase ? ({ '--sel': phase.color } as CSSProperties) : undefined}
          aria-hidden
        />
        <span className={phase ? 'wb-selected-name u-truncate' : 'wb-selected-name wb-selected-name--none u-truncate'}>
          {phase ? phase.name : t('phase.none')}
        </span>
      </div>
    </section>
  );
}

function CustomPhaseForm({ suggestedName, onDone }: { suggestedName: string; onDone: () => void }): ReactElement {
  const t = useT();
  const tm = useMsg();
  // Until the user edits the name, it follows the filter text that found no match.
  const [edited, setEdited] = useState<string | null>(null);
  const name = edited ?? suggestedName;
  const [id, setId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('phase.err.nameRequired'));
      return;
    }
    const result = actions.addCustomPhase(trimmed, id.trim() || undefined);
    if (!result.ok) {
      setError(tm(result.msg));
      return;
    }
    actions.selectPhase(result.id);
    onDone();
  };

  return (
    <form className="wb-custom-form" onSubmit={submit} noValidate>
      <h4>{t('phase.addCustomTitle')}</h4>
      <TextInput
        size="sm"
        label={t('phase.name')}
        value={name}
        onChange={(e) => {
          setEdited(e.target.value);
          setError(null);
        }}
        data-custom-name
      />
      <TextInput
        size="sm"
        mono
        label={t('phase.idOptional')}
        hint={t('phase.idHint')}
        value={id}
        spellCheck={false}
        autoCapitalize="off"
        onChange={(e) => {
          setId(e.target.value);
          setError(null);
        }}
      />
      <div className="wb-custom-foot">
        <p className="wb-form-error" role="alert">
          {error ?? ''}
        </p>
        <Button type="submit" size="sm" variant="primary" icon="plus">
          {t('common.add')}
        </Button>
      </div>
    </form>
  );
}

interface PhasePickerProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  /** Open with the custom phase form focused. */
  focusForm: boolean;
  onClose: () => void;
}

/** "More phases": filter, phases grouped by preset / Custom, and the add-custom-phase form. */
function PhasePicker({ open, anchorRef, focusForm, onClose }: PhasePickerProps): ReactElement {
  const t = useT();
  const lib = useApp((s) => s.library);
  const visible = useApp((s) => s.visibleRecent);
  const selectedId = useApp((s) => s.selectedPhaseId);
  const presetFocus = useReleaseAfterPointerPick();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = new Set(visible);
  const groups = phaseGroups(lib, t)
    .map((g) => ({
      ...g,
      // Without a filter, list only what is not already a recent chip; a filter searches everything.
      phases: g.phases.filter((p) => (q ? p.name.toLowerCase().includes(q) || p.id.includes(q) : !shown.has(p.id))),
    }))
    .filter((g) => g.phases.length > 0);

  const close = (): void => {
    setQuery('');
    onClose();
  };

  return (
    <Popover
      open={open}
      onClose={close}
      anchorRef={anchorRef}
      placement="bottom-start"
      width={300}
      maxHeight={520}
      aria-label={t('phase.more')}
      initialFocus="none"
      className="wb-picker"
    >
      <FocusOnMount selector={focusForm ? 'input[data-custom-name]' : 'input[data-filter]'}>
        <div className="wb-picker-head">
          <div className="wb-preset-row">
            <Select<string>
              size="sm"
              aria-label={t('preset.active')}
              title={t('preset.active')}
              value={lib.activePresetId ?? ''}
              onPointerDown={presetFocus.onPointerDown}
              onKeyDown={presetFocus.onKeyDown}
              onChange={(v) => {
                actions.setActivePreset(v || null);
                presetFocus.picked();
              }}
              options={[
                { value: '', label: t('ui.phase.presetNone') },
                ...lib.presets.map((p) => ({ value: p.id, label: presetLabel(p, t) })),
              ]}
            />
            <IconButton
              icon="edit"
              size="sm"
              label={t('phase.manage')}
              onClick={() => {
                close();
                actions.openDialog({ kind: 'presets' });
              }}
            />
          </div>
          <TextInput
            size="sm"
            icon="search"
            placeholder={t('phase.filter')}
            aria-label={t('phase.filter')}
            value={query}
            data-filter
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="wb-picker-groups">
          {groups.length === 0 && q ? <p className="wb-picker-empty">{t('phase.noMatch', { query: query.trim() })}</p> : null}
          {groups.map((g) => (
            <div key={g.id} className="wb-picker-group">
              <h4>{g.label}</h4>
              <div className="wb-chips">
                {g.phases.map((p) => (
                  <Chip
                    key={p.id}
                    color={p.color}
                    label={p.name}
                    title={`${p.name} · ${p.id}`}
                    selected={p.id === selectedId}
                    maxWidth="100%"
                    onClick={() => {
                      actions.selectPhase(p.id);
                      close();
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="wb-picker-custom">
          <CustomPhaseForm suggestedName={groups.length === 0 ? query.trim() : ''} onDone={close} />
        </div>
      </FocusOnMount>
    </Popover>
  );
}

/**
 * Focuses a field once the popover is placed (it stays hidden until positioned, and hidden
 * elements cannot take focus, so plain autoFocus would be lost).
 */
function FocusOnMount({ selector, children }: { selector: string; children: ReactNode }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => ref.current?.querySelector<HTMLInputElement>(selector)?.focus());
    return () => cancelAnimationFrame(id);
  }, [selector]);
  return <div ref={ref}>{children}</div>;
}

function RecentPhases(): ReactElement {
  const t = useT();
  const lookup = usePhaseLookup();
  const visible = useApp((s) => s.visibleRecent);
  const recentCount = useApp((s) => s.library.recent.length);
  const selectedId = useApp((s) => s.selectedPhaseId);
  const moreRef = useRef<HTMLButtonElement>(null);
  const customRef = useRef<HTMLButtonElement>(null);
  const [picker, setPicker] = useState<'more' | 'custom' | null>(null);
  const chips = visible.map((id, i) => ({ phase: lookup(id), slot: i + 1 })).filter((c) => c.phase !== undefined);

  return (
    <section className="wb-section wb-section--grow wb-recent" aria-label={t('phase.recent')}>
      <div className="wb-section-title">
        <span>{t('phase.recent')}</span>
        <Button size="sm" variant="ghost" disabled={recentCount === 0} onClick={() => actions.clearRecent()}>
          {t('phase.clearRecent')}
        </Button>
      </div>
      <div className="wb-recent-list">
        {chips.length > 0 ? (
          <div className="wb-chips wb-chips--recent" data-testid="recent-chips">
            {chips.map(({ phase, slot }) =>
              phase ? (
                <Chip
                  key={phase.id}
                  color={phase.color}
                  label={phase.name}
                  title={`${phase.name} · ${phase.id}`}
                  selected={phase.id === selectedId}
                  shortcut={slotLabel(slot)}
                  maxWidth="100%"
                  aria-keyshortcuts={slot <= 5 ? String(slot) : `Shift+${slot - 5}`}
                  onClick={(e) => {
                    actions.selectPhase(phase.id);
                    // A pointer pick hands the keyboard back to the shortcuts, so the chip does not
                    // keep a focus ring next to the selected one when 1–5 / D / Q follow.
                    if (e.detail > 0) releaseFocus();
                  }}
                />
              ) : null,
            )}
          </div>
        ) : (
          <p className="wb-hint">{t('phase.recentEmpty')}</p>
        )}
      </div>
      <div className="wb-recent-foot">
        <Button
          ref={moreRef}
          size="sm"
          variant="ghost"
          iconEnd="chevron-down"
          aria-expanded={picker === 'more'}
          aria-haspopup="dialog"
          onClick={() => setPicker((p) => (p === 'more' ? null : 'more'))}
        >
          {t('phase.more')}
        </Button>
        <Button
          ref={customRef}
          size="sm"
          variant="ghost"
          icon="plus"
          aria-expanded={picker === 'custom'}
          aria-haspopup="dialog"
          onClick={() => setPicker((p) => (p === 'custom' ? null : 'custom'))}
        >
          {t('phase.addCustom')}
        </Button>
      </div>
      <PhasePicker
        open={picker !== null}
        anchorRef={picker === 'custom' ? customRef : moreRef}
        focusForm={picker === 'custom'}
        onClose={() => setPicker(null)}
      />
    </section>
  );
}

/** Side panel: selected phase, recent chips, more phases (with the preset selector), and the pinned marking block. */
export function PhasePanel(): ReactElement {
  const t = useT();
  return (
    <aside className="wb-side" aria-label={t('phase.panel')}>
      <SelectedPhase />
      <RecentPhases />
      <MarkingBlock />
    </aside>
  );
}
