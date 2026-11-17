# Phase Annotator — implementation spec

This is the binding contract for every module. Product requirements live in
`docs/REQUIREMENTS.md` (verbatim copy of the brief). When this spec and the brief disagree,
the brief wins; flag the conflict in your report.

## 0. Stack and ground rules

- Vite 8 + React 19 + TypeScript 5.9 (strict). State: zustand 5. Hashing: `hash-wasm` (in a worker).
  Fonts: `@fontsource/ibm-plex-sans` (400/500/600) and `@fontsource/ibm-plex-mono` (400/500), bundled
  locally. **No network requests at runtime, no CDNs.** CJK falls back to system fonts:
  `"IBM Plex Sans", "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif`.
- Primary browser: Chromium (Chrome/Edge ≥ 120) — WebCodecs + File System Access API.
  Others degrade gracefully (see §7.6).
- `npm run dev` (Vite on 127.0.0.1:5173), `npm run build` (typecheck + build to `dist/`),
  `npm start` (`server/serve.mjs`: zero-dependency static server for `dist/` on 127.0.0.1:4173).
- Unit tests: vitest in `tests/unit/*.test.ts` (node env; use `fake-indexeddb/auto` where needed).
  E2E: Playwright in `tests/e2e/*.spec.ts`, **must use `channel: 'chrome'`** (installed Google Chrome;
  the bundled Chromium lacks H.264).
- Test videos: `npm run gen:videos` → `tests/fixtures/videos/*.mp4` + `manifest.json` (ffprobe ground
  truth: `frame_count`, `pts_us[]` in presentation order, `sha256`, `size`, `width`, `height`).
  Every frame shows its frame number as 7-segment digits and as a 24-cell barcode across the top 10% of
  the frame: cell0 white guard, cell1 black guard, cells 2..21 = 20-bit frame number MSB-first
  (white=1), cells 22..23 = frame mod 4. Use `src/testing/barcode.ts` (`decodeBarcode(imageData)`) to
  read it back from a canvas.
- Do not edit files owned by another module unless your task says so. If you need a change in a
  shared contract, make the smallest additive change and report it.
- Code style: small modules, explicit types, no `any` in public APIs, comments only where the reason
  is non-obvious.

## 1. Core: MP4 frame index (`src/core/mp4/`, DONE — do not change semantics)

`indexMp4(reader: ByteReader): Promise<FrameIndex>` — see `frameIndex.ts` for the numbering rule.
Key fields: `frameCount` (N), `ptsUs[f]` (integer µs), `durationUs` (time of boundary N),
`frameToSample`, `sampleToFrame`, `sampleOffsets/sampleSizes/sampleIsSync` (decode order),
`syncSamples`, `codec`, `description` (avcC), `nalLengthSize`, `warnings[]`.
Helpers: `boundaryUs(index, b)`, `frameAtUs(index, t)`, `decodeStartFor(index, f, isIdr?)`,
`isIdrAccessUnit(bytes, nalLengthSize)`. `BlobByteReader(file)` reads slices of a File.

Indexing runs in `src/workers/index.worker.ts` (posts `File` in, gets `FrameIndex` back with typed
arrays transferred). Client: `src/core/indexClient.ts` → `indexFile(file: File): Promise<FrameIndex>`.

## 2. Annotation model and formats (`src/core/annotations.ts`, `src/core/formats/*`)

```ts
type FrameBoundary = number;               // integer in [0, N]
interface Segment { id: string; phaseId: string; start: number; end: number } // half-open [start,end)
interface PhaseDef { id: string; name: string; color: string }   // color: '#rrggbb'
```

- Segments are kept sorted by `start`. A segment covers frames `start … end-1`. `end = N` includes the
  last frame. Adjacent segments share a boundary (`a.end === b.start`). Gaps are allowed.
- Phase IDs: `^[a-z0-9][a-z0-9._-]{0,63}$`. Derived from the name by slugging (ASCII); when the slug is
  empty (e.g. Chinese names) use `phase-` + 6 hex chars. IDs never change after creation; renaming a
  phase changes only `name`.
- Operations (pure functions, return new arrays, never mutate):
  `addSegment(segs, seg, {replaceOverlaps})` → `{ok:true, segments, replaced: Segment[]}` or
  `{ok:false, reason:'empty'|'out_of_range'|'overlap', conflicts: Segment[]}`. With
  `replaceOverlaps`, overlapped parts of existing segments are trimmed/split away.
  `updateSegment(segs, id, patch, N, {linkAdjacent})` — with `linkAdjacent`, moving a boundary that is
  shared with an adjacent segment moves both. `deleteSegment`, `relabelSegment`.
- `validateForExport(segs, N, phaseExists)` → `ValidationIssue[]` with codes
  `overlap | out_of_range | empty | invalid_phase | not_integer`, each listing segment ids.

### 2.1 Export format v1 (`src/core/formats/export.ts`, `csv.ts`, `json.ts`, `import.ts`)

Video metadata: `sha256` (64 lowercase hex), `frame_count` (N), `duration_us` (= `boundaryUs(N)`).
Times: `start_us = boundaryUs(start)`, `end_us = boundaryUs(end)`.

**CSV** (default). UTF-8 with BOM, CRLF line endings, RFC 4180 quoting (quote fields containing
`,` `"` CR or LF; double embedded quotes). Header (exact order):
```
format_version,video_sha256,frame_count,duration_us,phase_id,phase_name,start_frame,end_frame,start_us,end_us
```
One row per segment, ordered by `start_frame`. Video columns repeat on every row so files can be
concatenated. **Empty annotation** (no segments): exactly one row with the four video columns filled
and the six segment columns empty. A reader treats a row with an empty `start_frame` as "no segments".
**Formula protection**: a text cell (`phase_id`, `phase_name`) that begins with `=`, `+`, `-`, `@`, TAB,
CR, LF, or `'` gets a leading `'`. Importers strip exactly one leading `'` from text cells. This is
lossless.

**JSON**: UTF-8 without BOM, one segment per line:
```json
{
  "format": "phase-annotations",
  "format_version": 1,
  "video": {"sha256": "…", "frame_count": 250, "duration_us": 10000000, "file_name": "case.mp4"},
  "segments": [
    {"phase_id": "prep", "phase_name": "Preparation", "start_frame": 0, "end_frame": 100, "start_us": 0, "end_us": 4000000}
  ]
}
```
Empty annotation: `"segments": []`.

Default sidecar file names: `<video stem>.phases.csv` / `<video stem>.phases.json`.

**Import** (`parseAnnotationFile(text, nameHint)`): auto-detect JSON vs CSV (strip BOM; `{` → JSON).
Returns `{ok:true, file: ParsedAnnotation}` or `{ok:false, errors: ImportError[]}`.
`verifyAgainstVideo(parsed, {sha256, frameCount, durationUs, boundaryUs})` checks, in order:
sha256 equal, frame_count equal, duration_us equal, and for each segment: integers,
`0 ≤ start < end ≤ N`, `start_us`/`end_us` equal `boundaryUs(start/end)`, no overlaps, consistent
phase names per id. Returns all problems (not just the first), each with a code and params for i18n.

## 3. Video player (`src/player/`)

`FramePlayer` renders frames to a `<canvas>` through WebCodecs `VideoDecoder`. It is the **only**
source of truth for "which frame is on screen".

```ts
interface PlayerSnapshot {
  status: 'empty' | 'loading' | 'ready' | 'error';
  displayedFrame: number | null;   // frame whose pixels are on the canvas (verified by decoder timestamp)
  requestedFrame: number | null;   // latest seek target (null when settled)
  playing: boolean;
  rate: number;                    // 0.25 … 4
  error: { code: string; message: string } | null;
}
class FramePlayer {
  constructor(canvas: HTMLCanvasElement);
  load(index: FrameIndex, reader: ByteReader): Promise<void>; // shows frame 0
  unload(): void;
  seek(frame: number): Promise<SeekOutcome>;  // latest seek wins; superseded seeks resolve {superseded:true}
  step(delta: number): Promise<SeekOutcome>;  // relative to requestedFrame ?? displayedFrame
  play(): void; pause(): void; setRate(r: number): void;
  settled(timeoutMs?: number): Promise<{ frame: number } | { error: string }>;
  subscribe(fn: (s: PlayerSnapshot) => void): () => void;
  getSnapshot(): PlayerSnapshot;
  peekThumbnail(frame: number): ImageBitmap | null; // nearest cached keyframe thumbnail for scrub preview
}
```
Rules:
- Chunk timestamps fed to the decoder are the **frame numbers** (`timestamp = sampleToFrame[s]`), so
  every output `VideoFrame.timestamp` *is* its frame number. Samples not presented (`-1`) are fed with
  a negative unique timestamp and their outputs are discarded.
- Seeking to frame f: decode from `decodeStartFor(index, f, isIdr)` (read the start sample and verify
  it is IDR with `isIdrAccessUnit`; cache results) in decode order. Outputs for frames presented before
  the run's start keyframe are discarded (possibly corrupt open-GOP leading pictures).
- Latest seek wins: if a new target arrives while decoding, keep going if the target lies in the
  current run ahead of what's decoded; otherwise `decoder.reset()` and start a new run. Never display a
  frame that is not the current target (except during playback).
- Decoded frames are converted to `ImageBitmap` (scaled to the canvas backing size, max 1920 px wide)
  and the `VideoFrame` is closed immediately. Keep an LRU cache of bitmaps around the target (memory
  budget ~350 MB, prefer frames ahead of the target 2:1) so stepping is instant. After a seek settles,
  prefetch forward and backward neighbours at low priority (cancel on any new request).
- `displayedFrame` changes **only** right after `drawImage` of that frame's bitmap. Subscribers are
  notified at most once per animation frame.
- Playback: decode ahead in decode order (backpressure: `decodeQueueSize` ≤ 8, ≤ 12 pending bitmaps),
  present frames when `performance.now()` reaches their pts / rate relative to the play start; drop
  late frames (never present out of order). Stop at the last frame. Video only, no audio.
- Errors (unsupported config via `VideoDecoder.isConfigSupported`, decode error, read error) set
  `status:'error'` with a code (`codec_unsupported | decode_failed | read_failed | webcodecs_missing`).
- Canvas: letterboxed to its CSS size × devicePixelRatio; redraws on resize (ResizeObserver).
- Keyframe thumbnails (for the scrub preview tooltip): after load, a background pass decodes up to 240
  evenly spaced IDR samples with a second decoder at ~160 px wide; must yield to foreground work
  (pause while seeking/playing).

## 4. Hashing and identity (`src/workers/hash.worker.ts`, `src/storage/hashing.ts`)

- `fingerprint(file)`: `fp1:<size>:<sha256(first 1 MiB ‖ last 1 MiB)>` (fast, used for instant draft
  lookup only).
- `sha256(file, {priority, onProgress, signal})`: full-file SHA-256 streamed in 8 MiB chunks inside a
  worker (hash-wasm). Queue with priorities: `foreground` (the open video) preempts `background`
  (batch verification). Results cached in IndexedDB `hashCache` keyed by
  `name|size|lastModified` (+ relative path when known).

## 5. Storage (`src/storage/`)

IndexedDB database `phase-annotator`, version 1. Stores:
- `drafts` keyPath `key`; indexes `fingerprint`, `sha256`.
- `checkpoints` keyPath `id`; index `videoKey`.
- `kv` keyPath `k` (settings, phase library, presets, recent labels, export prefs, layout).
- `handles` keyPath `id` (persisted `FileSystemDirectoryHandle`s for "reconnect folder").
- `hashCache` keyPath `k`.

```ts
interface DraftRecord {
  key: string;              // sha256 hex, or 'pending:' + fingerprint until the hash is known
  sha256: string | null;
  fingerprint: string;
  fileName: string; relPath: string | null;
  frameCount: number; durationUs: number;
  segments: Segment[];
  phases: Record<string, PhaseDef>;   // snapshot of every phase referenced by segments
  contentHash: string;      // stable hash of (segments, phase names) — used for dirty tracking
  revision: number;         // +1 on every save
  savedAt: number; savedBy: string;   // tab id
  exported: { contentHash: string; at: number; targets: { label: string; format: 'csv'|'json' }[] } | null;
}
```
- `DraftStore.save(draft, baseRevision)`: one readwrite transaction; if the stored revision differs from
  `baseRevision` → `{ok:false, conflict: stored}` and nothing is written. Otherwise writes
  `revision = baseRevision + 1` and broadcasts `{type:'draft-saved', key, revision, tabId}` on
  `BroadcastChannel('phase-annotator')`.
- `promotePending(pendingKey, sha256)`: atomically re-keys a pending draft to its sha256 (if a sha256
  draft already exists, keep both and return `{collision: existing}` for the UI to resolve).
- `findForVideo({sha256?, fingerprint})`.
- Checkpoints: `{id, videoKey, name, createdAt, kind: 'manual'|'auto-before-restore'|'auto-before-import', segments, phases}`.
- Call `navigator.storage.persist()` once at startup (ignore failure).

## 6. File system (`src/fs/`)

- `pickVideoFile()`: `showOpenFilePicker` (mp4) → `{handle, file}`; fallback `<input type=file>`.
- `pickFolder()`: `showDirectoryPicker({mode:'readwrite', id:'videos'})`; fallback
  `<input webkitdirectory>` (read-only: exports go to downloads).
- `scanFolder(root, {signal, onProgress})` → `VideoEntry[]` recursively (skip hidden dirs and
  `node_modules`), `.mp4`/`.m4v` case-insensitive. `VideoEntry = {id (relPath), relPath, name, stem,
  dir: DirRef, fileHandle | file, size, lastModified, sidecars: SidecarRef[]}` where sidecars are
  `*.csv`/`*.json` in the same directory whose name starts with the video stem (`stem.csv`,
  `stem.json`, `stem.phases.csv`, `stem_*.json`, …).
- `writeTextFile(dir, name, text)` → `{ok:true}` or `{ok:false, reason:'permission_denied'|'not_found'|
  'no_space'|'unsupported'|'unknown', message}`; checks/requests `readwrite` permission (request only
  when called during a user gesture; otherwise report `permission_denied`). Write via
  `createWritable()` to a temp-safe path: write whole content then `close()`.
- `downloadText(name, text, mime)` — Blob + object URL + `<a download>`.
- `requestSourceFolder(fileHandle)`: `showDirectoryPicker({startIn: fileHandle, mode:'readwrite'})`
  then `dir.resolve(fileHandle)` to confirm the folder (or an ancestor) contains the video; returns the
  direct parent `DirRef` or a reason.

## 7. Application behaviour (`src/state/`, `src/ui/`)

### 7.1 Layout (desktop ≥ 1280×760; usable down to 1100 wide)
```
┌ top bar: product mark · batch position (3/12) · save state · export state · language · help ┐
├──────────────────────────────────────────────────────────┬───────────────────────────────┤
│ [◀ Prev]  relative/path/case_003.mp4  ·  status   [Next ▶] │ PHASE PANEL                   │
│ ┌──────────────────────────────────────────────────────┐ │  selected phase (big swatch)  │
│ │                 VIDEO CANVAS (dominant)              │ │  10 recent chips (wrap)       │
│ └──────────────────────────────────────────────────────┘ │  More phases ▾ · + Custom     │
│ ⏮ ◂ ▶ ▸ ⏭  rate  [frame 001234] / 9000   00:41.133      │  ─────────────                │
│ ┌ zoomable timeline: ruler/scrub lane + segment lane ──┐ │  Pending start: 1200 [×]      │
│ └──────────────────────────────────────────────────────┘ │  [Q Start] [W Finish]         │
│                                                          │  [E Finish+Next] [R → End]    │
├────────────────────────────────────┬─────────────────────┴───────────────────────────────┤
│ Segments | Checkpoints | Export     │ Batch: sort ▾  list of relative paths + status        │
└────────────────────────────────────┴─────────────────────────────────────────────────────┘
```
- Video column and the side panel have fixed widths/positions; the side panel is 300 px. The bottom
  region has a draggable divider (height persisted). Controls never shift: fixed-width counters with
  `font-variant-numeric: tabular-nums`, filenames truncate in the middle with full path in a tooltip,
  disabled controls stay in place (never hidden).
- Visual language: dark graphite neutrals (not pure black), one accent for focus/selection/playhead,
  phase colours from a 12-colour categorical palette tuned for dark backgrounds, semantic colours only for
  save state (saved/saving/unsaved/error). 4 px spacing grid, 6 px radii max, 1 px hairlines, no
  gradients, no drop-shadow cards, no decorative badges or filler copy. IBM Plex Sans 13 px UI,
  IBM Plex Mono for frame numbers/timecodes.
- Instructions live in a Help dialog (`?` button / `Shift+/`), not on the main screen.

### 7.2 Player & navigation
Play/pause, ±1 frame, ±10 frames (Shift+A/D), first/last, jump-to-frame input (Enter commits; invalid
input shows an inline error), rate selector (0.25–4). Display: frame `f` / `N`, timecode of `ptsUs[f]`
as `HH:MM:SS.mmm`. While a seek is pending, show the target faintly next to the verified counter.
Timeline: zoom with Ctrl/⌘+wheel or +/− buttons (min one frame ≈ 12 px, max whole video); pan with
wheel / Shift+wheel / overview drag; click/drag in the ruler lane scrubs (latest seek wins) with a hover
tooltip showing frame, time and the keyframe thumbnail; segment lane shows coloured segments, pending
start marker, playhead; clicking a segment selects it and seeks to its start; dragging a segment edge
moves the boundary (shared boundaries move both sides), committed only after the frame at the new
boundary is displayed.

### 7.3 Marking
State: `selectedPhaseId`, `pendingStart: number | null`.
- **Q** set start at the displayed frame (replaces an existing pending start).
- **W** finish: segment `[pendingStart, displayedFrame)`, clears pending start.
- **E** finish and start next: same, then `pendingStart = displayedFrame`.
- **R** mark through end: segment `[pendingStart, N)` (requires pending start); clears pending start.
- Before committing any boundary: `await player.settled(1500)`; use the settled `displayedFrame`.
  If it cannot be confirmed (error/timeout/decoder failure) refuse and explain ("Frame not confirmed:
  …"). During playback the displayed frame is used directly.
- Unavailable actions show a short inline message near the marking buttons (and an `aria-live` region):
  no phase selected, no pending start, end ≤ start, overlap with "Replace overlapped" action, frame not
  confirmed, video not ready.
- Undo/redo (⌘/Ctrl+Z, ⌘/Ctrl+Shift+Z) covers segment and pending-start changes.

### 7.4 Phases
- Library of phases + presets grouped by procedure type (two built-in synthetic examples, fully
  editable: "Laparoscopic cholecystectomy (example)" and "Cataract surgery (example)") + "Custom".
- Chips: 10 most recently used phases shown directly (flex-wrap so short labels share a row), the rest
  under "More phases" (popover with filter input, grouped by procedure). Keys 1–5 select chips 1–5,
  Shift+1–5 chips 6–10. Recent list persists across videos until "Clear recent".
- Add custom phase (name, optional id, colour auto-assigned); manage presets dialog (create/rename/
  delete preset, add/remove/reorder phases, rename phase, recolour). Switching the active preset never
  changes existing segments or phase IDs.

### 7.5 Segments, checkpoints, export (bottom-left tabs)
- Segments table: colour, phase (select to relabel), start, end (exclusive, shown as "end − 1" last
  frame too), duration, actions (set start/end to current frame, delete). Clicking a row seeks to its
  start. Validation issues shown inline per row.
- Checkpoints: create named, list (name, time, segment count), restore (auto-checkpoint current state
  first), delete.
- Export: format (CSV default / JSON / Both), destination (beside source video — default / chosen
  folder / download), "Export now", last export info, validation summary. Import: "Import file…"
  (manual, CSV or JSON) and detected sidecars.

### 7.6 Batch & files
- Open file (single MP4) or open folder (recursive). Drag & drop files/folders onto the window.
- Batch list: relative path (middle-truncated), size, modified time, status ∈ `annotated` (verified
  sidecar or exported draft), `draft` (local unexported changes), `unannotated`, `unverified` (sidecar
  present but not yet hash-verified), `mismatch` (sidecar for another video). Sort by name / modified /
  size, asc/desc. Click to switch. Prev/Next follow the sorted order.
- Background verification hashes videos that have sidecars, one at a time, at background priority.
- Single-file open: if no folder access, show a notice offering "Allow folder access" to look for
  sidecars and to save exports beside the video (uses `requestSourceFolder`).
- Without File System Access API: open via inputs; exports download; sidecars discovered from the
  selected folder listing.

### 7.7 Video lifecycle
On open: index (worker) → player.load → fingerprint → look up draft by fingerprint (provisional) →
full hash (foreground) → promote pending key / verify → sidecar discovery & verification →
- no draft & matching sidecar: import automatically (toast "Loaded annotations from …").
- draft with segments differs from matching sidecar: dialog "Use file" / "Keep draft" (checkpoint the
  draft before replacing).
- sidecar that fails verification: status `mismatch`, explain which check failed; never load it.
Before switching video (Prev/Next/list click/open other): if dirty (contentHash ≠ exported.contentHash
and the draft was edited) → validate → export to destination → on success switch; on failure stay,
keep everything open, show a dialog with the reason and recovery options (fix issues / download
instead / choose another folder / switch without exporting — draft stays saved in this browser).
Untouched videos are not exported. A deliberately emptied draft (had segments, now none) exports the
empty-annotation form.

### 7.8 Autosave, conflicts, leaving
- Autosave on every change: debounce 300 ms, max wait 1 s, flush on `visibilitychange:hidden` and
  `pagehide`. Top bar shows `Saving…` / `Saved hh:mm:ss` / `Save failed — retry`.
- Stale tab: on broadcast or save conflict for the open video, show a banner: "This video was changed in
  another tab" with "Load newer version" (current state is checkpointed first) and "Keep mine"
  (checkpoints the newer stored version, then overwrites). No silent overwrite.
- `beforeunload`: when any opened video in this session has unexported changes (including the last
  video in the batch) call `preventDefault()` and set `returnValue`. In-app "Close folder"/"Open other"
  shows an equivalent confirm dialog.

### 7.9 Shortcuts (left hand; ignored while focus is in input/select/textarea/contenteditable)
Space play/pause · A/D ∓1 frame · Shift+A/D ∓10 · Q start · W finish · E finish+next · R through end ·
Z/X first/last frame · 1–5 / Shift+1–5 select recent phase · ⌘/Ctrl+Z undo · ⌘/Ctrl+Shift+Z redo ·
Esc cancel pending start / close dialog · Shift+/ help.

### 7.10 i18n
`src/i18n/{en.ts, zhHant.ts, index.ts}`. `en` defines keys; `zhHant` is typed
`Record<keyof typeof en, string>` (Traditional Chinese, Taiwan usage: 影格, 標註, 階段, 匯出, 匯入,
檢查點, 草稿, 資料夾). `t(key, params)` with `{name}` interpolation; `useT()` hook re-renders on change.
Language persisted in `kv`. Numbers/dates formatted with `Intl` for the active locale.
