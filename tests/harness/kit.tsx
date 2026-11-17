/**
 * UI kit showcase: /tests/harness/kit.html
 * Query params (for deterministic screenshots): lang=en|zh-Hant, dialog=help|conflict|switch,
 * popover=more, toasts=1, gallery=1 (scroll to gallery).
 */
import { StrictMode, useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/styles';
import { PHASE_PALETTE } from '../../src/styles';
import {
  LANGS,
  LANG_LABEL_KEY,
  formatBytes,
  formatDateTime,
  formatTimecode,
  setLang,
  useLang,
  useT,
  isLang,
  type Lang,
  type Translate,
} from '../../src/i18n';
import { Icon, ICON_NAMES } from '../../src/ui/icons';
import {
  Banner,
  BATCH_STATUS_TONE,
  Button,
  Checkbox,
  Chip,
  Dialog,
  EmptyState,
  IconButton,
  Kbd,
  MenuButton,
  MiddleEllipsis,
  NumberInput,
  Popover,
  ProgressBar,
  SAVE_STATE_TONE,
  SegmentedControl,
  Select,
  Splitter,
  StatusDot,
  Swatch,
  TabPanel,
  Tabs,
  TextInput,
  ToastRegion,
  Tooltip,
  toast,
  type BatchStatus,
  type MenuEntry,
} from '../../src/ui/kit';

const params = new URLSearchParams(location.search);
const initialLang = params.get('lang');
setLang(isLang(initialLang) ? initialLang : 'en');

// ------------------------------------------------------------------ synthetic data
interface DemoPhase {
  id: string;
  name: string;
  color: string;
}

const PHASES: DemoPhase[] = [
  { id: 'preparation', name: 'Preparation', color: PHASE_PALETTE[0] },
  { id: 'trocar-placement', name: 'Trocar placement', color: PHASE_PALETTE[1] },
  { id: 'calot-dissection', name: 'Calot triangle dissection', color: PHASE_PALETTE[2] },
  { id: 'clipping-cutting', name: 'Clipping and cutting', color: PHASE_PALETTE[3] },
  { id: 'gb-dissection', name: 'Gallbladder dissection', color: PHASE_PALETTE[4] },
  { id: 'gb-packaging', name: 'Gallbladder packaging', color: PHASE_PALETTE[5] },
  { id: 'cleaning', name: 'Cleaning and coagulation', color: PHASE_PALETTE[6] },
  { id: 'gb-retraction', name: 'Gallbladder retraction', color: PHASE_PALETTE[7] },
  { id: 'phase-3fa1c2', name: '止血與沖洗', color: PHASE_PALETTE[8] },
  { id: 'idle', name: 'Idle', color: PHASE_PALETTE[11] },
];
const MORE_PHASES: DemoPhase[] = [
  { id: 'incision', name: 'Incision', color: PHASE_PALETTE[9] },
  { id: 'capsulorhexis', name: 'Capsulorhexis', color: PHASE_PALETTE[10] },
  { id: 'hydrodissection', name: 'Hydrodissection', color: PHASE_PALETTE[0] },
  { id: 'phaco', name: 'Phacoemulsification', color: PHASE_PALETTE[1] },
  { id: 'ia', name: 'Irrigation / aspiration', color: PHASE_PALETTE[6] },
];

const N = 9000;
const FPS = 25;
const CURRENT = 7480;
const PENDING = 7350;

interface DemoSegment {
  id: string;
  phase: DemoPhase;
  start: number;
  end: number;
  issue?: 'overlap';
}

const SEGMENTS: DemoSegment[] = [
  { id: 's1', phase: PHASES[0], start: 0, end: 1200 },
  { id: 's2', phase: PHASES[1], start: 1200, end: 2310 },
  { id: 's3', phase: PHASES[2], start: 2310, end: 4875 },
  { id: 's4', phase: PHASES[3], start: 4875, end: 5400 },
  { id: 's5', phase: PHASES[4], start: 5400, end: 7350 },
  { id: 's6', phase: PHASES[8], start: 7300, end: 7340, issue: 'overlap' },
];

interface DemoVideo {
  path: string;
  size: number;
  modified: number;
  status: BatchStatus;
}

const BASE_TIME = Date.UTC(2026, 9, 14, 6, 12, 0);
const VIDEOS: DemoVideo[] = [
  { path: 'site_a/2026-10/case_001_lap_chole.mp4', size: 1_482_331_904, modified: BASE_TIME, status: 'annotated' },
  { path: 'site_a/2026-10/case_002_lap_chole.mp4', size: 1_102_004_224, modified: BASE_TIME + 86e6, status: 'annotated' },
  { path: 'site_a/2026-10/case_003_lap_chole_extended_view.mp4', size: 2_310_998_016, modified: BASE_TIME + 172e6, status: 'draft' },
  { path: 'site_a/2026-10/case_004_lap_chole.mp4', size: 988_117_120, modified: BASE_TIME + 259e6, status: 'unverified' },
  { path: 'site_a/2026-11/case_005_lap_chole.mp4', size: 1_250_455_552, modified: BASE_TIME + 345e6, status: 'unannotated' },
  { path: 'site_b/cataract/eye_0012_right.mp4', size: 412_558_336, modified: BASE_TIME + 431e6, status: 'mismatch' },
  { path: 'site_b/cataract/eye_0013_left.mp4', size: 398_102_528, modified: BASE_TIME + 518e6, status: 'unannotated' },
  { path: 'site_b/cataract/eye_0014_left_reoperation.mp4', size: 455_000_064, modified: BASE_TIME + 604e6, status: 'error' },
  { path: 'site_b/cataract/eye_0015_right.mp4', size: 402_948_096, modified: BASE_TIME + 690e6, status: 'unannotated' },
];
const CURRENT_VIDEO = 2;

const usOf = (frame: number): number => Math.round((frame * 1e6) / FPS);
const pct = (frame: number): string => `${(frame / N) * 100}%`;

// ------------------------------------------------------------------ top bar
function TopBar({ t }: { t: Translate }): ReactElement {
  const lang = useLang();
  const openItems: MenuEntry[] = [
    { id: 'file', label: t('topbar.openFile'), icon: 'file', kbd: 'Mod+O', onSelect: () => toast.info(t('topbar.openFile')) },
    { id: 'folder', label: t('topbar.openFolder'), icon: 'folder', onSelect: () => toast.info(t('topbar.openFolder')) },
    { id: 'sep', kind: 'separator' },
    { id: 'close', label: t('topbar.closeFolder'), icon: 'x', danger: true, onSelect: () => toast.warning(t('leave.title')) },
  ];
  return (
    <header className="wb-top">
      <div className="wb-mark">
        <span className="wb-mark-glyph" aria-hidden />
        {t('app.name')}
      </div>
      <span className="wb-sep" />
      <span className="wb-batchpos" aria-label={t('topbar.batchPositionLabel', { index: 3, total: VIDEOS.length })}>
        <b>3</b> / {VIDEOS.length}
      </span>
      <span className="wb-sep" />
      <span className="wb-state">
        <span className="wb-state-label">{t('save.label')}</span>
        <StatusDot tone={SAVE_STATE_TONE.saved} label={t('save.saved', { time: formatDateTime(BASE_TIME + 3.6e6, 'time') })} />
      </span>
      <span className="wb-state">
        <span className="wb-state-label">{t('exportState.label')}</span>
        <StatusDot tone="attention" label={t('exportState.dirty')} tintLabel />
      </span>
      <div className="wb-top-end">
        <MenuButton items={openItems} label={t('topbar.openMenu')} icon="folder" placement="bottom-end" variant="ghost" size="sm">
          {t('topbar.openMenu')}
        </MenuButton>
        <SegmentedControl<Lang>
          aria-label={t('lang.label')}
          size="sm"
          value={lang}
          onChange={setLang}
          options={LANGS.map((l) => ({ value: l, label: l === 'en' ? 'EN' : '繁中', title: t(LANG_LABEL_KEY[l]) }))}
        />
        <IconButton icon="help" label={t('topbar.help')} kbd="Shift+/" tooltipPlacement="bottom" />
      </div>
    </header>
  );
}

// ------------------------------------------------------------------ video column
function FileBar({ t }: { t: Translate }): ReactElement {
  return (
    <div className="wb-filebar">
      <Button size="sm" icon="chevron-left" variant="ghost" kbd={undefined} aria-label={t('video.prevLabel')}>
        {t('video.prev')}
      </Button>
      <div className="wb-file">
        <MiddleEllipsis text={VIDEOS[CURRENT_VIDEO].path} />
        <StatusDot tone="busy" size="sm" label={t('video.status.hashing', { percent: 64 })} />
      </div>
      <Button size="sm" iconEnd="chevron-right" variant="ghost" aria-label={t('video.nextLabel')}>
        {t('video.next')}
      </Button>
    </div>
  );
}

function Transport({ t }: { t: Translate }): ReactElement {
  const [rate, setRate] = useState('1');
  const [frame, setFrame] = useState(CURRENT);
  const [playing, setPlaying] = useState(false);
  return (
    <div className="wb-transport">
      <IconButton icon="skip-start" label={t('player.first')} kbd="Z" />
      <IconButton icon="step-back" label={t('player.stepBack')} kbd="A" />
      <IconButton
        icon={playing ? 'pause' : 'play'}
        label={playing ? t('player.pause') : t('player.play')}
        kbd="Space"
        variant="default"
        onClick={() => setPlaying((p) => !p)}
      />
      <IconButton icon="step-forward" label={t('player.stepForward')} kbd="D" />
      <IconButton icon="skip-end" label={t('player.last')} kbd="X" />
      <Select
        size="sm"
        mono
        aria-label={t('player.rate')}
        value={rate}
        onChange={setRate}
        options={['0.25', '0.5', '1', '1.5', '2', '4'].map((r) => ({ value: r, label: t('player.rateValue', { rate: r }) }))}
      />
      <div className="wb-counter">
        <NumberInput
          aria-label={t('player.jumpTo')}
          value={frame}
          min={0}
          max={N - 1}
          invalidMessage={t('player.jumpInvalid', { max: N - 1 })}
          onCommit={setFrame}
          errorDisplay="float"
        />
        <span className="wb-total">/ {N}</span>
        <span className="wb-ghost" aria-live="polite">
          → 7481
        </span>
        <span className="wb-tc">{formatTimecode(usOf(frame))}</span>
      </div>
      <div className="wb-transport-end">
        <IconButton icon="zoom-out" label={t('timeline.zoomOut')} kbd="-" />
        <span className="wb-zoom">1×</span>
        <IconButton icon="zoom-in" label={t('timeline.zoomIn')} kbd="+" />
      </div>
    </div>
  );
}

function Timeline({ t }: { t: Translate }): ReactElement {
  const majors = Array.from({ length: 13 }, (_, i) => i * 750);
  const minors = Array.from({ length: 61 }, (_, i) => i * 150);
  return (
    <div className="wb-timeline" role="group" aria-label={t('timeline.label')}>
      <div className="wb-ruler">
        {minors.map((f) => (
          <span key={`m${f}`} className="wb-tick" style={{ left: pct(f) }} />
        ))}
        {majors.map((f) => (
          <span key={f}>
            <span className="wb-tick wb-tick--major" style={{ left: pct(f) }} />
            <span className="wb-tick-label" style={{ left: pct(f) }}>
              {formatTimecode(usOf(f)).slice(3, 8)}
            </span>
          </span>
        ))}
      </div>
      <div className="wb-lane">
        {SEGMENTS.filter((s) => !s.issue).map((s) => (
          <div
            key={s.id}
            className={s.id === 's3' ? 'wb-seg wb-seg--selected' : 'wb-seg'}
            style={{ left: pct(s.start), width: `calc(${pct(s.end - s.start)} - 1px)`, '--seg': s.phase.color } as CSSProperties}
            title={`${s.phase.name} [${s.start}, ${s.end})`}
          >
            <span>{s.phase.name}</span>
          </div>
        ))}
      </div>
      <div className="wb-pending" style={{ left: pct(PENDING), width: pct(CURRENT - PENDING) }} title={t('timeline.pendingStart', { frame: PENDING })} />
      <div className="wb-playhead" style={{ left: pct(CURRENT) }} />
      <div className="wb-overview">
        <i style={{ left: 0, width: '100%' }} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ phase panel
function MorePhases({ t }: { t: Translate }): ReactElement {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(params.get('popover') === 'more');
  const [query, setQuery] = useState('');
  const groups = [
    { label: t('preset.cholecystectomy'), phases: PHASES.slice(5) },
    { label: t('preset.cataract'), phases: MORE_PHASES },
  ];
  const q = query.trim().toLowerCase();
  return (
    <>
      <Button ref={anchorRef} size="sm" variant="ghost" iconEnd="chevron-down" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {t('phase.more')}
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} placement="bottom-start" aria-label={t('phase.more')} className="more-pop">
        <div className="more-pop-head">
          <TextInput size="sm" icon="search" placeholder={t('phase.filter')} aria-label={t('phase.filter')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {groups.map((g) => {
          const items = g.phases.filter((p) => p.name.toLowerCase().includes(q));
          if (items.length === 0) return null;
          return (
            <div key={g.label} className="more-pop-group">
              <h4>{g.label}</h4>
              <div className="wb-chips">
                {items.map((p) => (
                  <Chip key={p.id} color={p.color} label={p.name} onClick={() => setOpen(false)} />
                ))}
              </div>
            </div>
          );
        })}
      </Popover>
    </>
  );
}

function PhasePanel({ t }: { t: Translate }): ReactElement {
  const [selected, setSelected] = useState(PHASES[4].id);
  const sel = PHASES.find((p) => p.id === selected) ?? PHASES[0];
  return (
    <aside className="wb-side" aria-label={t('phase.panel')}>
      <section className="wb-section">
        <div className="wb-section-title">{t('phase.selected')}</div>
        <div className="wb-selected">
          <span className="wb-selected-swatch" style={{ '--sel': sel.color } as CSSProperties} />
          <div style={{ minWidth: 0 }}>
            <div className="wb-selected-name u-truncate">{sel.name}</div>
            <div className="wb-selected-id">{sel.id}</div>
          </div>
        </div>
      </section>
      <section className="wb-section wb-section--grow">
        <div className="wb-section-title">
          <span>{t('phase.recent')}</span>
          <Button size="sm" variant="ghost">
            {t('phase.clearRecent')}
          </Button>
        </div>
        <div className="wb-chips">
          {PHASES.map((p, i) => (
            <Chip
              key={p.id}
              color={p.color}
              label={p.name}
              selected={p.id === selected}
              shortcut={i < 5 ? String(i + 1) : `⇧${i - 4}`}
              onClick={() => setSelected(p.id)}
              maxWidth={268}
            />
          ))}
        </div>
        <div className="wb-chip-row">
          <MorePhases t={t} />
          <Button size="sm" variant="ghost" icon="plus">
            {t('phase.addCustom')}
          </Button>
        </div>
      </section>
      <section className="wb-section wb-section--pinned">
        <div className="wb-section-title">{t('mark.title')}</div>
        <div className="wb-pendingbox">
          <span className="wb-pendingbox-label">{t('mark.pendingStart')}</span>
          <span className="wb-pendingbox-value">{PENDING}</span>
          <IconButton icon="x" size="sm" label={t('mark.cancelPending')} kbd="Esc" />
        </div>
        <div className="wb-markgrid">
          <Button kbd="Q" title={t('mark.startLabel')}>
            {t('mark.start')}
          </Button>
          <Button kbd="W" variant="primary" title={t('mark.finishLabel')}>
            {t('mark.finish')}
          </Button>
          <Button kbd="E" title={t('mark.finishNextLabel')}>
            {t('mark.finishNext')}
          </Button>
          <Button kbd="R" title={t('mark.throughEndLabel')}>
            {t('mark.throughEnd')}
          </Button>
        </div>
        <div className="wb-feedback" role="status" aria-live="polite">
          <Icon name="warning" size={14} style={{ marginTop: 1 }} />
          <span>{t('mark.err.overlap', { count: 1 })}</span>
          <Button size="sm" variant="ghost">
            {t('mark.replaceOverlapped')}
          </Button>
        </div>
      </section>
    </aside>
  );
}

// ------------------------------------------------------------------ bottom panes
function SegmentsTable({ t }: { t: Translate }): ReactElement {
  const phaseOptions = [...PHASES, ...MORE_PHASES].map((p) => ({ value: p.id, label: p.name }));
  return (
    <table className="wb-table">
      <thead>
        <tr>
          <th style={{ width: 220 }}>{t('segments.col.phase')}</th>
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
        {SEGMENTS.map((s) => (
          <tr key={s.id} className={s.id === 's3' ? 'is-selected' : undefined}>
            <td>
              <Select size="sm" swatch={s.phase.color} value={s.phase.id} onChange={() => undefined} options={phaseOptions} aria-label={t('segments.relabel')} />
            </td>
            <td className="num">{s.start}</td>
            <td className="num">{s.end}</td>
            <td className="num muted">{s.end - 1}</td>
            <td className="num">{formatTimecode(usOf(s.end) - usOf(s.start)).slice(3)}</td>
            <td>
              {s.issue ? (
                <span className="wb-issue">
                  <Icon name="alert" size={12} />
                  {t('segments.issue.overlap')}
                </span>
              ) : null}
            </td>
            <td>
              <div className="wb-actions">
                <IconButton size="sm" icon="flag" label={t('segments.setStart')} />
                <IconButton size="sm" icon="flag-end" label={t('segments.setEnd')} />
                <IconButton size="sm" icon="trash" label={t('segments.delete')} />
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type BottomTab = 'segments' | 'checkpoints' | 'export';

function LeftPane({ t }: { t: Translate }): ReactElement {
  const [tab, setTab] = useState<BottomTab>('segments');
  const [format, setFormat] = useState<'csv' | 'json' | 'both'>('csv');
  return (
    <section className="wb-pane">
      <Tabs<BottomTab>
        idBase="bottom"
        aria-label={t('tabs.segments')}
        value={tab}
        onChange={setTab}
        items={[
          { id: 'segments', label: t('tabs.segments'), count: SEGMENTS.length },
          { id: 'checkpoints', label: t('tabs.checkpoints'), count: 2 },
          { id: 'export', label: t('tabs.export') },
        ]}
        trailing={
          <>
            <IconButton icon="undo" size="sm" label={t('mark.undo')} kbd="Mod+Z" />
            <IconButton icon="redo" size="sm" label={t('mark.redo')} kbd="Mod+Shift+Z" />
          </>
        }
      />
      <div className="wb-scroll">
        <TabPanel idBase="bottom" id="segments" active={tab === 'segments'}>
          <SegmentsTable t={t} />
        </TabPanel>
        <TabPanel idBase="bottom" id="checkpoints" active={tab === 'checkpoints'}>
          <EmptyState message={t('checkpoints.empty')} action={<Button size="sm" icon="history">{t('checkpoints.create')}</Button>} />
        </TabPanel>
        <TabPanel idBase="bottom" id="export" active={tab === 'export'}>
          <div style={{ padding: 16, display: 'grid', gap: 12, maxWidth: 520 }}>
            <SegmentedControl
              aria-label={t('export.format')}
              value={format}
              onChange={setFormat}
              options={[
                { value: 'csv', label: t('export.format.csv') },
                { value: 'json', label: t('export.format.json') },
                { value: 'both', label: t('export.format.both') },
              ]}
            />
            <Button variant="primary" icon="download">
              {t('export.now')}
            </Button>
          </div>
        </TabPanel>
      </div>
    </section>
  );
}

function BatchPane({ t }: { t: Translate }): ReactElement {
  const [sort, setSort] = useState('name');
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  return (
    <section className="wb-pane">
      <div className="wb-pane-head">
        <span className="wb-pane-title">{t('batch.title')}</span>
        <span className="wb-pane-count">{VIDEOS.length}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
          <Select
            size="sm"
            aria-label={t('batch.sort')}
            value={sort}
            onChange={setSort}
            options={[
              { value: 'name', label: t('batch.sort.name') },
              { value: 'mtime', label: t('batch.sort.modified') },
              { value: 'size', label: t('batch.sort.size') },
            ]}
          />
          <SegmentedControl
            size="sm"
            aria-label={t('batch.sort')}
            value={dir}
            onChange={setDir}
            options={[
              { value: 'asc', icon: 'chevron-up', ariaLabel: t('batch.sort.asc') },
              { value: 'desc', icon: 'chevron-down', ariaLabel: t('batch.sort.desc') },
            ]}
          />
        </div>
      </div>
      <div className="wb-progress">
        <div className="wb-progress-row">
          <span>{t('batch.verifying', { done: 2, total: 5 })}</span>
          <span>40%</span>
        </div>
        <ProgressBar value={0.4} label={t('batch.verifying', { done: 2, total: 5 })} />
      </div>
      <div className="wb-scroll">
        <table className="wb-table wb-batch">
          <thead>
            <tr>
              <th>{t('batch.col.path')}</th>
              <th className="num">{t('batch.col.size')}</th>
              <th className="num">{t('batch.col.modified')}</th>
              <th>{t('batch.col.status')}</th>
            </tr>
          </thead>
          <tbody>
            {VIDEOS.map((v, i) => (
              <tr key={v.path} className={i === CURRENT_VIDEO ? 'is-current' : undefined}>
                <td className="path">
                  <MiddleEllipsis text={v.path} />
                </td>
                <td className="num muted">{formatBytes(v.size)}</td>
                <td className="num muted">{formatDateTime(v.modified, 'shortDatetime')}</td>
                <td>
                  <StatusDot size="sm" tone={BATCH_STATUS_TONE[v.status]} label={t(`batch.status.${v.status}`)} title={t(`batch.statusHelp.${v.status}`)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ dialogs
function HelpDialog({ t, open, onClose }: { t: Translate; open: boolean; onClose: () => void }): ReactElement {
  const sections: { title: string; rows: [string, string][] }[] = [
    {
      title: t('help.section.playback'),
      rows: [
        ['Space', t('help.key.playPause')],
        ['A  D', t('help.key.step')],
        ['Shift+A  Shift+D', t('help.key.step10')],
        ['Z  X', t('help.key.firstLast')],
      ],
    },
    {
      title: t('help.section.marking'),
      rows: [
        ['Q', t('help.key.start')],
        ['W', t('help.key.finish')],
        ['E', t('help.key.finishNext')],
        ['R', t('help.key.throughEnd')],
      ],
    },
    {
      title: t('help.section.phases'),
      rows: [
        ['1–5', t('help.key.recent1to5')],
        ['Shift+1–5', t('help.key.recent6to10')],
      ],
    },
    {
      title: t('help.section.general'),
      rows: [
        ['Mod+Z', t('help.key.undo')],
        ['Mod+Shift+Z', t('help.key.redo')],
        ['Esc', t('help.key.escape')],
        ['Shift+/', t('help.key.help')],
      ],
    },
  ];
  return (
    <Dialog open={open} onClose={onClose} title={t('help.title')} size="lg" footerNote={t('help.typingNote')} footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      <div className="help-grid">
        {sections.map((s) => (
          <div key={s.title} className="help-section">
            <h3>{s.title}</h3>
            {s.rows.map(([keys, label]) => (
              <div key={label} className="help-row">
                <span>{label}</span>
                <span style={{ display: 'flex', gap: 6 }}>
                  {keys.split('  ').map((k) => (
                    <Kbd key={k} keys={k.replace('1–5', '1-5')} size="md" />
                  ))}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="help-about">
        <p>{t('help.about.halfOpen')}</p>
        <p>{t('help.about.confirm')}</p>
        <p>{t('help.about.storage')}</p>
      </div>
    </Dialog>
  );
}

function ConflictDialog({ t, open, onClose }: { t: Translate; open: boolean; onClose: () => void }): ReactElement {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={false}
      title={t('conflict.title')}
      description={t('conflict.body', { file: 'case_003_lap_chole.phases.csv' })}
      footerNote={t('conflict.note')}
      footer={
        <>
          <Button onClick={onClose}>{t('conflict.keepDraft')}</Button>
          <Button variant="primary" onClick={onClose}>
            {t('conflict.useFile')}
          </Button>
        </>
      }
      size="md"
    >
      <div style={{ display: 'grid', gap: 6, fontSize: 12, color: 'var(--c-text-muted)' }}>
        <span>{t('conflict.draftSummary', { count: 5, time: formatDateTime(BASE_TIME + 3.6e6) })}</span>
        <span>{t('conflict.fileSummary', { count: 6, time: formatDateTime(BASE_TIME) })}</span>
      </div>
    </Dialog>
  );
}

function SwitchFailedDialog({ t, open, onClose }: { t: Translate; open: boolean; onClose: () => void }): ReactElement {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      tone="warning"
      size="lg"
      title={t('switch.failedTitle')}
      description={t('switch.failedBody', { file: 'case_003_lap_chole_extended_view.mp4', reason: t('export.reason.permission_denied') })}
      footerNote={t('switch.draftKept')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('switch.withoutExport')}
          </Button>
          <Button onClick={onClose}>{t('switch.chooseFolder')}</Button>
          <Button variant="primary" icon="download" onClick={onClose}>
            {t('switch.download')}
          </Button>
        </>
      }
    />
  );
}

// ------------------------------------------------------------------ gallery
function Gallery({ t, onDialog }: { t: Translate; onDialog: (d: string) => void }): ReactElement {
  const [checked, setChecked] = useState(true);
  const [name, setName] = useState('');
  const [view, setView] = useState('timeline');
  return (
    <main className="gal" id="gallery">
      <section>
        <h2>Colour</h2>
        <p className="gal-sub">Graphite neutrals · cyan accent (focus, selection, playhead) · semantic state · 12 phase colours</p>
        <div className="gal-swatches">
          {PHASE_PALETTE.map((c) => (
            <div key={c} style={{ background: c }} title={c} />
          ))}
        </div>
        <div className="gal-row" style={{ marginTop: 16 }}>
          {(['ok', 'busy', 'attention', 'danger', 'neutral', 'accent'] as const).map((tone) => (
            <StatusDot key={tone} tone={tone} label={tone} />
          ))}
          <StatusDot tone="ok" tintLabel label={t('save.saved', { time: '14:02:11' })} />
          <StatusDot tone="busy" label={t('save.saving')} />
          <StatusDot tone="danger" tintLabel label={t('save.failed')} />
        </div>
      </section>

      <section className="gal-type">
        <h2>Type</h2>
        <p className="gal-sub">IBM Plex Sans 11 / 12 / 13 / 15 · IBM Plex Mono for frames and timecodes · CJK fallback</p>
        <p style={{ fontSize: 15, fontWeight: 600 }}>15 / 600 — {t('help.title')}</p>
        <p style={{ fontSize: 13 }}>13 / 400 — {t('help.about.halfOpen')}</p>
        <p style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>12 / 400 muted — {t('folder.notice')}</p>
        <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--c-text-muted)' }}>11 / 600 — {t('phase.recent')}</p>
        <p className="u-mono" style={{ fontSize: 14 }}>
          007480 / 9000 · {formatTimecode(299_200_000)} · {formatTimecode(3_723_456_789)}
        </p>
      </section>

      <section>
        <h2>Buttons</h2>
        <p className="gal-sub">primary · default · ghost · danger — sm / md — icon and key cap slots</p>
        <div className="gal-row">
          <Button variant="primary" icon="download" kbd="Mod+E">
            {t('export.now')}
          </Button>
          <Button icon="flag" kbd="Q">
            {t('mark.start')}
          </Button>
          <Button variant="ghost" icon="plus">
            {t('phase.addCustom')}
          </Button>
          <Button variant="danger" icon="trash">
            {t('common.delete')}
          </Button>
          <Button disabled icon="arrow-to-end" kbd="R">
            {t('mark.throughEnd')}
          </Button>
          <Button busy>{t('exportState.exporting')}</Button>
        </div>
        <div className="gal-row" style={{ marginTop: 12 }}>
          <Button size="sm" variant="primary">
            {t('common.apply')}
          </Button>
          <Button size="sm">{t('common.cancel')}</Button>
          <Button size="sm" variant="ghost" iconEnd="chevron-down">
            {t('phase.more')}
          </Button>
          <IconButton icon="play" label={t('player.play')} kbd="Space" variant="default" />
          <IconButton icon="history" label={t('checkpoints.create')} />
          <IconButton icon="lock" label="Pressed" pressed />
          <IconButton icon="trash" size="sm" label={t('segments.delete')} />
          <MenuButton
            label={t('kit.menu.more')}
            items={[
              { id: 'a', label: t('import.file'), icon: 'upload', onSelect: () => toast.info(t('import.file')) },
              { id: 'b', label: t('checkpoints.create'), icon: 'history', kbd: 'Mod+S', onSelect: () => undefined },
              { id: 'l', kind: 'label', label: t('batch.sort') },
              { id: 'n', label: t('batch.sort.name'), checked: true, onSelect: () => undefined },
              { id: 'm', label: t('batch.sort.modified'), checked: false, onSelect: () => undefined },
              { id: 's', kind: 'separator' },
              { id: 'd', label: t('segments.delete'), icon: 'trash', danger: true, onSelect: () => undefined },
              { id: 'x', label: t('common.rename'), icon: 'edit', disabled: true, onSelect: () => undefined },
            ]}
          />
          <Tooltip content={t('segments.endHint')}>
            <span tabIndex={0} className="u-muted" style={{ fontSize: 12, borderBottom: '1px dotted var(--c-text-faint)' }}>
              {t('segments.col.end')}
            </span>
          </Tooltip>
        </div>
      </section>

      <section>
        <h2>Icons</h2>
        <p className="gal-sub">16 px grid · 1.5 px stroke · currentColor</p>
        <div className="gal-grid">
          {ICON_NAMES.map((n) => (
            <div key={n} className="gal-icon">
              <Icon name={n} />
              <span>{n}</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>Forms</h2>
        <div className="gal-cols">
          <div className="gal-panel" style={{ display: 'grid', gap: 12 }}>
            <TextInput label={t('phase.name')} placeholder="Gallbladder retraction" value={name} onChange={(e) => setName(e.target.value)} />
            <TextInput label={t('phase.idOptional')} mono defaultValue="Bad ID!" error={t('phase.err.idInvalid')} />
            <TextInput label={t('checkpoints.name')} hint={t('phase.idHint')} defaultValue="Before relabel" />
          </div>
          <div className="gal-panel" style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
            <NumberInput aria-label={t('player.jumpTo')} label={t('player.jumpTo')} value={1234} min={0} max={8999} onCommit={() => undefined} />
            <Select
              aria-label={t('export.destination')}
              value="beside"
              onChange={() => undefined}
              options={[
                { value: 'beside', label: t('export.dest.beside') },
                { value: 'folder', label: t('export.dest.folder') },
                { value: 'download', label: t('export.dest.download') },
              ]}
            />
            <SegmentedControl
              aria-label="View"
              value={view}
              onChange={setView}
              fullWidth
              options={[
                { value: 'timeline', label: t('timeline.label') },
                { value: 'segments', label: t('tabs.segments') },
                { value: 'batch', label: t('batch.title') },
              ]}
            />
            <Checkbox checked={checked} onChange={setChecked} label={t('timeline.dragBoundary')} description={t('help.timeline.boundary')} />
          </div>
          <div className="gal-panel" style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
            <div className="wb-chips">
              {PHASES.slice(0, 6).map((p, i) => (
                <Chip key={p.id} color={p.color} label={p.name} selected={i === 2} shortcut={String(i + 1)} />
              ))}
              <Chip color={PHASE_PALETTE[9]} label="A very long custom phase name that will ellipsize" maxWidth={180} />
              <Chip color={PHASE_PALETTE[10]} label="Disabled" disabled />
            </div>
            <div className="gal-row">
              <Swatch color={PHASE_PALETTE[0]} size="sm" />
              <Swatch color={PHASE_PALETTE[1]} />
              <Swatch color={PHASE_PALETTE[2]} size="lg" />
              <span className="gal-mid">
                <MiddleEllipsis text="site_a/2026-10/really/deeply/nested/folder/structure/case_003_lap_chole.mp4" />
              </span>
            </div>
          </div>
        </div>
      </section>

      <section>
        <h2>Notices</h2>
        <div style={{ display: 'grid', gap: 8 }}>
          <Banner tone="warning" actions={<><Button size="sm">{t('stale.keepMine')}</Button><Button size="sm" variant="primary">{t('stale.loadNewer')}</Button></>}>
            {t('stale.banner')} <span className="u-muted">{t('stale.note')}</span>
          </Banner>
          <Banner tone="info" actions={<Button size="sm" icon="folder">{t('folder.allow')}</Button>} onDismiss={() => undefined}>
            {t('folder.notice')}
          </Banner>
          <Banner tone="danger">{t('notice.unsupportedBrowser')}</Banner>
          <Banner tone="success">{t('import.success', { file: 'case_001_lap_chole.phases.csv' })}</Banner>
          <div className="gal-row" style={{ marginTop: 8 }}>
            <Button size="sm" onClick={() => onDialog('help')}>help dialog</Button>
            <Button size="sm" onClick={() => onDialog('conflict')}>conflict dialog</Button>
            <Button size="sm" onClick={() => onDialog('switch')}>switch-failed dialog</Button>
            <Button size="sm" onClick={() => toast.success(t('export.success', { file: 'case_003.phases.csv' }))}>success toast</Button>
            <Button size="sm" onClick={() => toast.info(t('checkpoints.created', { name: 'Before relabel' }))}>info toast</Button>
            <Button size="sm" onClick={() => toast.warning(t('folder.readOnly'))}>warning toast</Button>
            <Button
              size="sm"
              onClick={() =>
                toast.error(t('export.failed', { reason: t('export.reason.permission_denied') }), {
                  detail: 'site_a/2026-10/case_003_lap_chole.phases.csv',
                  action: { label: t('switch.download'), onAction: () => undefined },
                })
              }
            >
              error toast
            </Button>
          </div>
          <div className="gal-panel" style={{ padding: 0, marginTop: 8 }}>
            <EmptyState message={t('segments.empty')} />
          </div>
          <div className="gal-panel" style={{ padding: 0 }}>
            <EmptyState message={t('batch.empty')} action={<Button size="sm" icon="folder">{t('topbar.openFolder')}</Button>} />
          </div>
        </div>
      </section>
    </main>
  );
}

// ------------------------------------------------------------------ root
function App(): ReactElement {
  const t = useT();
  const [dialog, setDialog] = useState<string | null>(params.get('dialog'));
  const [bottom, setBottom] = useState(() => Math.round(Math.min(280, Math.max(180, window.innerHeight * 0.28))));

  useEffect(() => {
    if (params.get('toasts') !== '1') return;
    toast.success(t('export.success', { file: 'case_002_lap_chole.phases.csv' }), { durationMs: null, id: 'demo-ok' });
    toast.error(t('export.failed', { reason: t('export.reason.permission_denied') }), {
      id: 'demo-err',
      detail: 'site_a/2026-10/case_003_lap_chole.phases.csv',
      action: { label: t('switch.download'), onAction: () => undefined },
    });
    // Run once on mount; toasts carry text in the initial language only.
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === '?' && !(e.target instanceof HTMLInputElement)) setDialog('help');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (params.get('gallery') === '1') document.getElementById('gallery')?.scrollIntoView();
  }, []);

  return (
    <>
      <div className="wb" style={{ '--bottom-h': `${bottom}px` } as CSSProperties}>
        <TopBar t={t} />
        <div className="wb-main">
          <div className="wb-video">
            <FileBar t={t} />
            <div className="wb-well">
              <div className="wb-canvas" role="img" aria-label={t('player.canvasLabel')}>
                <span>VIDEO CANVAS</span>
              </div>
            </div>
            <Transport t={t} />
            <Timeline t={t} />
          </div>
          <PhasePanel t={t} />
        </div>
        <Splitter aria-label={t('kit.splitter.label')} value={bottom} min={160} max={520} onChange={setBottom} />
        <div className="wb-bottom">
          <LeftPane t={t} />
          <BatchPane t={t} />
        </div>
      </div>
      <Gallery t={t} onDialog={setDialog} />
      <HelpDialog t={t} open={dialog === 'help'} onClose={() => setDialog(null)} />
      <ConflictDialog t={t} open={dialog === 'conflict'} onClose={() => setDialog(null)} />
      <SwitchFailedDialog t={t} open={dialog === 'switch'} onClose={() => setDialog(null)} />
      <ToastRegion />
    </>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
