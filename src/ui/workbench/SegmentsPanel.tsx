import { useEffect, useMemo, useRef, type FocusEvent, type MouseEvent, type ReactElement } from 'react';
import { formatTimecode, useT } from '../../i18n';
import { actions, useApp } from '../app';
import type { IssueView } from '../app';
import type { Segment } from '../../core/types';
import { boundaryTime, formatDurationUs, releaseFocus, useFrameIndex, useReleaseAfterPointerPick } from '../hooks';
import { useMsg } from '../msg';
import { Icon } from '../icons';
import { EmptyState, IconButton, NumberInput, Select, parseIntInRange, type SelectGroup } from '../kit';
import { phaseGroups } from './phaseUtil';

interface BoundaryCellProps {
  seg: Segment;
  which: 'start' | 'end';
  max: number;
  label: string;
}

/** Inline boundary editor: commits on Enter or blur, Esc reverts. Shared boundaries move together. */
function BoundaryCell({ seg, which, max, label }: BoundaryCellProps): ReactElement {
  // Set when the blur that follows should not commit (Esc reverted, or Enter already committed).
  const skipBlur = useRef(false);
  const value = seg[which];
  const min = which === 'start' ? 0 : 1;
  const commit = (v: number): void => {
    if (v !== value) void actions.setSegmentBounds(seg.id, which === 'start' ? { start: v } : { end: v }, { linkAdjacent: true });
  };
  const onEnter = (v: number): void => {
    commit(v);
    skipBlur.current = true;
    releaseFocus();
  };
  const onBlur = (e: FocusEvent<HTMLInputElement>): void => {
    if (skipBlur.current) {
      skipBlur.current = false;
      return;
    }
    const parsed = parseIntInRange(e.currentTarget.value, min, max);
    if (parsed.ok) commit(parsed.value);
  };
  return (
    <div
      className="wb-bound"
      onKeyDownCapture={(e) => {
        if (e.key === 'Escape') skipBlur.current = true;
      }}
    >
      <NumberInput
        size="sm"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        onCommit={onEnter}
        onBlur={onBlur}
        errorDisplay="float"
      />
    </div>
  );
}

const ISSUE_ORDER: ReadonlyArray<IssueView['code']> = ['overlap', 'out_of_range', 'empty', 'invalid_phase', 'not_integer'];

/** Segment table: relabel, edit boundaries, set to current frame, delete; click a row to seek. */
export function SegmentsPanel(): ReactElement {
  const t = useT();
  const tm = useMsg();
  const index = useFrameIndex();
  const segments = useApp((s) => s.editor.doc.segments);
  const docPhases = useApp((s) => s.editor.doc.phases);
  const lib = useApp((s) => s.library);
  const selectedId = useApp((s) => s.editor.selectedSegmentId);
  const issues = useApp((s) => s.editor.issues);
  const n = index?.frameCount ?? 0;
  const selectedRow = useRef<HTMLTableRowElement>(null);
  const relabelFocus = useReleaseAfterPointerPick();

  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const issuesBySegment = useMemo(() => {
    const map = new Map<string, IssueView[]>();
    for (const issue of issues) {
      for (const id of issue.segmentIds) map.set(id, [...(map.get(id) ?? []), issue]);
    }
    for (const list of map.values()) list.sort((a, b) => ISSUE_ORDER.indexOf(a.code) - ISSUE_ORDER.indexOf(b.code));
    return map;
  }, [issues]);

  const phaseOptions = useMemo<SelectGroup<string>[]>(() => {
    const groups: SelectGroup<string>[] = phaseGroups(lib, t).map((g) => ({
      label: g.label,
      options: g.phases.map((p) => ({ value: p.id, label: p.name })),
    }));
    // Phases referenced by segments but missing from the library stay selectable.
    const known = new Set(Object.keys(lib.phases));
    const orphans = [...new Set(segments.map((s) => s.phaseId))].filter((id) => !known.has(id));
    if (orphans.length > 0) {
      groups.push({
        label: t('preset.custom'),
        options: orphans.map((id) => ({ value: id, label: docPhases[id]?.name ?? t('phase.unknown', { id }) })),
      });
    }
    return groups;
  }, [lib, t, segments, docPhases]);

  if (segments.length === 0) {
    return <EmptyState align="start" message={t('segments.empty')} />;
  }

  const onRowClick = (e: MouseEvent<HTMLTableRowElement>, id: string): void => {
    if ((e.target as HTMLElement).closest('input, select, button')) return;
    actions.selectSegment(id, { seek: true });
  };

  return (
    <table className="wb-table wb-segments" data-testid="segments-table">
      <colgroup>
        <col style={{ width: 236 }} />
        <col style={{ width: 92 }} />
        <col style={{ width: 92 }} />
        <col style={{ width: 84 }} />
        <col style={{ width: 96 }} />
        <col />
        <col style={{ width: 96 }} />
      </colgroup>
      <thead>
        <tr>
          <th>{t('segments.col.phase')}</th>
          <th className="num">{t('segments.col.start')}</th>
          <th className="num" title={t('segments.endHint')}>
            {t('segments.col.end')}
          </th>
          <th className="num">{t('segments.col.last')}</th>
          <th className="num">{t('segments.col.duration')}</th>
          <th />
          <th className="num">{t('segments.col.actions')}</th>
        </tr>
      </thead>
      <tbody>
        {segments.map((s) => {
          const phase = lib.phases[s.phaseId] ?? docPhases[s.phaseId];
          const rowIssues = issuesBySegment.get(s.id) ?? [];
          const selected = s.id === selectedId;
          const duration = index ? boundaryTime(index, s.end) - boundaryTime(index, s.start) : null;
          return (
            <tr
              key={s.id}
              ref={selected ? selectedRow : undefined}
              className={[selected && 'is-selected', rowIssues.length > 0 && 'has-issue'].filter(Boolean).join(' ') || undefined}
              title={t('segments.seek')}
              onClick={(e) => onRowClick(e, s.id)}
            >
              <td>
                <Select<string>
                  size="sm"
                  swatch={phase?.color ?? '#6b737c'}
                  value={s.phaseId}
                  onPointerDown={relabelFocus.onPointerDown}
                  onKeyDown={relabelFocus.onKeyDown}
                  onChange={(id) => {
                    actions.relabelSegment(s.id, id);
                    relabelFocus.picked();
                  }}
                  groups={phaseOptions}
                  aria-label={t('segments.relabel')}
                />
              </td>
              <td className="num">
                <BoundaryCell seg={s} which="start" max={Math.max(0, n - 1)} label={t('segments.col.start')} />
              </td>
              <td className="num">
                <BoundaryCell seg={s} which="end" max={n} label={t('segments.col.end')} />
              </td>
              <td className="num muted">{s.end - 1}</td>
              <td className="num">{duration === null ? '—' : formatDurationUs(duration, formatTimecode)}</td>
              <td className="wb-issue-cell">
                {rowIssues.length > 0 ? (
                  <span className="wb-issue" title={rowIssues.map((i) => tm(i.msg)).join('\n')}>
                    <Icon name="alert" size={12} />
                    <span className="u-truncate">{t(`segments.issue.${rowIssues[0].code}`)}</span>
                  </span>
                ) : null}
              </td>
              <td>
                <div className="wb-actions">
                  <IconButton
                    size="sm"
                    icon="flag"
                    label={t('segments.setStart')}
                    onClick={() => void actions.setSegmentBoundaryToCurrent(s.id, 'start')}
                  />
                  <IconButton
                    size="sm"
                    icon="flag-end"
                    label={t('segments.setEnd')}
                    onClick={() => void actions.setSegmentBoundaryToCurrent(s.id, 'end')}
                  />
                  <IconButton size="sm" icon="trash" label={t('segments.delete')} onClick={() => actions.deleteSegment(s.id)} />
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
