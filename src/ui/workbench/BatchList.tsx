import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { formatBytes, formatDateTime, useT } from '../../i18n';
import { actions, useApp } from '../app';
import type { BatchItem, SortDir, SortKey } from '../app';
import { releaseFocus, selectCurrentIndex, useReleaseAfterPointerPick } from '../hooks';
import { useMsg } from '../msg';
import {
  BATCH_STATUS_TONE,
  Banner,
  Button,
  EmptyState,
  MiddleEllipsis,
  ProgressBar,
  SegmentedControl,
  Select,
  StatusDot,
} from '../kit';

const ROW_H = 32;
const OVERSCAN = 8;

function BatchNotices(): ReactElement | null {
  const t = useT();
  const access = useApp((s) => s.batch.access);
  const mode = useApp((s) => s.batch.mode);
  const rootName = useApp((s) => s.batch.rootName);
  const sourceFolder = useApp((s) => s.video.sourceFolder);
  if (access === 'needs-permission') {
    return (
      <Banner
        tone="warning"
        className="wb-pane-banner"
        actions={
          <Button size="sm" variant="primary" icon="link" onClick={() => void actions.reconnectFolder()}>
            {t('folder.reconnect')}
          </Button>
        }
      >
        {t('folder.reconnectNotice', { name: rootName ?? '' })}
      </Banner>
    );
  }
  if (mode === 'file' && sourceFolder === 'needs-access') {
    return (
      <Banner
        tone="info"
        className="wb-pane-banner"
        actions={
          <Button size="sm" icon="folder" onClick={() => void actions.requestSourceFolderAccess()}>
            {t('folder.allow')}
          </Button>
        }
      >
        {t('folder.notice')}
      </Banner>
    );
  }
  if (mode === 'folder' && access === 'read') {
    return (
      <Banner tone="info" className="wb-pane-banner">
        {t('folder.readOnly')}
      </Banner>
    );
  }
  if (mode !== 'none' && access === 'virtual') {
    return (
      <Banner tone="info" className="wb-pane-banner">
        {t('notice.noFsAccess')}
      </Banner>
    );
  }
  return null;
}

/** Compact scan / verification progress for the pane header (always the same slot). */
function Progress(): ReactElement {
  const t = useT();
  const scanning = useApp((s) => s.batch.scanning);
  const scanned = useApp((s) => s.batch.scannedCount);
  const verifying = useApp((s) => s.batch.verifying);
  let body: ReactElement | null = null;
  if (scanning) {
    const label = t('batch.scanning', { count: scanned });
    body = (
      <>
        <span className="wb-head-progress-label u-truncate" title={label}>
          {label}
        </span>
        <ProgressBar value={null} label={label} className="wb-head-progress-bar" />
      </>
    );
  } else if (verifying && verifying.total > 0 && verifying.done < verifying.total) {
    const label = t('batch.verifying', { done: verifying.done, total: verifying.total });
    // `current` (0…1 of the file being hashed) is optional in the state contract; when present the
    // bar moves within a file instead of only when a whole file finishes.
    const cur = 'current' in verifying && typeof verifying.current === 'number' ? Math.min(1, Math.max(0, verifying.current)) : 0;
    const frac = (verifying.done + cur) / verifying.total;
    body = (
      <>
        <span className="wb-head-progress-label u-truncate" title={label}>
          {label}
        </span>
        <ProgressBar value={frac} label={label} className="wb-head-progress-bar" />
      </>
    );
  }
  return (
    <div className="wb-head-progress" data-testid="batch-progress">
      {body}
    </div>
  );
}

function Row({
  item,
  index,
  current,
  active,
  onSelect,
}: {
  item: BatchItem;
  index: number;
  current: boolean;
  active: boolean;
  onSelect: () => void;
}): ReactElement {
  const t = useT();
  const tm = useMsg();
  const detail = item.statusDetail ? tm(item.statusDetail) : t(`batch.statusHelp.${item.status}`);
  return (
    <div
      id={`batch-row-${index}`}
      role="option"
      aria-selected={current}
      className={['wb-batch-row', current && 'is-current', active && 'is-active'].filter(Boolean).join(' ')}
      style={{ top: index * ROW_H }}
      onClick={onSelect}
      data-testid="batch-row"
    >
      <span className="wb-batch-path">
        <MiddleEllipsis text={item.relPath} />
      </span>
      <span className="wb-batch-num">{formatBytes(item.size)}</span>
      <span className="wb-batch-num">{formatDateTime(item.lastModified, 'shortDatetime')}</span>
      <span className="wb-batch-status">
        <StatusDot size="sm" tone={BATCH_STATUS_TONE[item.status]} label={t(`batch.status.${item.status}`)} title={detail} />
      </span>
    </div>
  );
}

/** Batch file list: sortable, windowed for large folders; click (or Enter) switches video. */
export function BatchList(): ReactElement {
  const t = useT();
  const items = useApp((s) => s.batch.items);
  const mode = useApp((s) => s.batch.mode);
  const sort = useApp((s) => s.settings.sort);
  const currentIndex = useApp(selectCurrentIndex);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(320);
  const [active, setActive] = useState(-1);
  const sortFocus = useReleaseAfterPointerPick();

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [items.length > 0]);

  const reveal = (i: number): void => {
    const el = scrollRef.current;
    if (!el || i < 0) return;
    const top = i * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  };

  // Follow the open video (Prev/Next, sorting) and reset the keyboard cursor to it.
  useEffect(() => {
    setActive(currentIndex);
    reveal(currentIndex);
  }, [currentIndex, items]);

  const select = (i: number): void => {
    const item = items[i];
    if (item && i !== currentIndex) void actions.selectVideo(item.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (items.length === 0) return;
    let next = active;
    if (e.key === 'ArrowDown') next = Math.min(items.length - 1, active + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, active - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'Enter') {
      e.preventDefault();
      select(active);
      return;
    } else return;
    e.preventDefault();
    setActive(next);
    reveal(next);
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(items.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);

  return (
    <section className="wb-pane" aria-label={t('batch.title')}>
      <div className="wb-pane-head">
        <span className="wb-pane-title">{t('batch.title')}</span>
        <span className="wb-pane-count" aria-label={t('batch.count', { count: items.length })}>
          {items.length}
        </span>
        {/* Scan / background-verification progress lives in the header so rows never move. */}
        <Progress />
        <div className="wb-pane-tools">
          <Select<SortKey>
            size="sm"
            aria-label={t('batch.sort')}
            title={t('batch.sort')}
            value={sort.key}
            disabled={items.length === 0}
            onPointerDown={sortFocus.onPointerDown}
            onKeyDown={sortFocus.onKeyDown}
            onChange={(k) => {
              actions.setSort(k, sort.dir);
              sortFocus.picked();
            }}
            options={[
              { value: 'name', label: t('batch.sort.name') },
              { value: 'mtime', label: t('batch.sort.modified') },
              { value: 'size', label: t('batch.sort.size') },
            ]}
          />
          <SegmentedControl<SortDir>
            size="sm"
            aria-label={t('ui.batch.sortDir')}
            value={sort.dir}
            disabled={items.length === 0}
            onChange={(d) => actions.setSort(sort.key, d)}
            options={[
              { value: 'asc', icon: 'chevron-up', ariaLabel: t('batch.sort.asc') },
              { value: 'desc', icon: 'chevron-down', ariaLabel: t('batch.sort.desc') },
            ]}
          />
        </div>
      </div>
      <BatchNotices />
      {items.length === 0 ? (
        <EmptyState
          message={mode === 'none' ? t('batch.empty') : t('video.empty')}
          action={
            <div className="wb-empty-actions">
              <Button size="sm" icon="folder" onClick={() => void actions.openFolder()}>
                {t('topbar.openFolder')}
              </Button>
              <Button size="sm" icon="file" variant="ghost" onClick={() => void actions.openFile()}>
                {t('topbar.openFile')}
              </Button>
            </div>
          }
        />
      ) : (
        <>
          <div className="wb-batch-head" aria-hidden>
            <span>{t('batch.col.path')}</span>
            <span className="wb-batch-num">{t('batch.col.size')}</span>
            <span className="wb-batch-num">{t('batch.col.modified')}</span>
            <span>{t('batch.col.status')}</span>
          </div>
          <div
            ref={scrollRef}
            className="wb-scroll wb-batch-scroll"
            role="listbox"
            tabIndex={0}
            aria-label={t('batch.title')}
            aria-activedescendant={active >= 0 && active >= first && active < last ? `batch-row-${active}` : undefined}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            onKeyDown={onKeyDown}
          >
            <div className="wb-batch-body" style={{ height: items.length * ROW_H }}>
              {items.slice(first, last).map((item, k) => {
                const i = first + k;
                return (
                  <Row
                    key={item.id}
                    item={item}
                    index={i}
                    current={i === currentIndex}
                    active={i === active}
                    onSelect={() => {
                      setActive(i);
                      select(i);
                      // A pointer pick hands the keyboard back to the shortcuts (no focus ring on
                      // the list when D/A/Q follow); arrow-key navigation keeps focus.
                      releaseFocus();
                    }}
                  />
                );
              })}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
