# Phase Annotator

A local-first workbench for annotating **surgical phases** in H.264 MP4 video, frame-exactly.
An annotation assigns one phase to a continuous, half-open range of frames, `[start_frame, end_frame)`.
Everything stays on your machine: videos are read in place, and frame indexes, labels, drafts,
checkpoints and exports never leave the device. The UI is available in English and Traditional Chinese
(Taiwan).

- [Setup](#setup) · [Browser support](#browser-support) · [Using the workbench](#using-the-workbench)
- [Frame numbering](#frame-numbering) · [Export format](#export-format-v1) · [Recovering frames](#recovering-the-exact-frames-from-an-export)
- [Where data is stored](#where-data-is-stored) · [Verified limitations](#verified-limitations) · [Development and tests](#development-and-tests)

The test record (what was tested, how, and the results) is in [docs/TESTING.md](docs/TESTING.md).

## Setup

Requires Node.js 20 or newer (tested with Node 26) and a Chromium-based desktop browser.

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

Then open **http://127.0.0.1:4173**. `npm start` serves the production build from `dist/` with a
zero-dependency server bound to localhost (`PORT`/`HOST` environment variables override the defaults).

Once installed and built, no network is needed: fonts (IBM Plex Sans/Mono) and all code are bundled,
and the app makes no requests outside `127.0.0.1` (verified by an automated test, see TESTING.md).

For development, `npm run dev` starts Vite on http://127.0.0.1:5173.

## Browser support

| Browser | Status |
| --- | --- |
| **Chrome / Edge 120+ (desktop)** | Full support. Verified with Google Chrome 155 on macOS. |
| Other Chromium browsers (Brave, Arc, Opera) | Expected to work: same WebCodecs and File System Access APIs. Not tested. |
| Firefox, Safari | Not supported for annotation work. WebCodecs is present in recent versions, but there is no File System Access API: folders open read-only through a fallback picker, exports become downloads, and the app has not been tested there. |

The app needs WebCodecs (`VideoDecoder`) to show frames and refuses to load video without it. It uses the File
System Access API for folder access, sidecar discovery and writing exports beside the video. It needs a
secure context, which `localhost`/`127.0.0.1` provides.

## Using the workbench

```
┌ top bar: batch position · draft save state · export state · Open · EN/繁中 · help ───────────┐
│ ‹ Previous   relative/path/video.mp4 · status                  Next › │ Selected phase        │
│ ┌───────────────────────────────────────────────────────────────────┐ │ Recent (10 chips)     │
│ │                           video                                   │ │ More phases · Custom  │
│ └───────────────────────────────────────────────────────────────────┘ │ Marking: pending start│
│ ⏮ ◂ ▶ ▸ ⏭  rate  [frame] / N  timecode                         zoom   │ Start Q · Finish W    │
│ zoomable timeline: ruler (scrub, hover preview) + segment lane         │ Finish+next E · End R │
├──────────────────────────────────────┬───────────────────────────────────────────────────────┤
│ Segments | Checkpoints | Export       │ Videos: relative path · size · modified · status      │
└──────────────────────────────────────┴───────────────────────────────────────────────────────┘
```

1. **Open** → *Open folder* lists every `.mp4`/`.m4v` recursively, with relative paths and statuses:
   *Annotated*, *Draft* (local changes not exported), *Not annotated*, *Not verified* (an annotation file is
   present but not yet checked against the video hash), *Mismatch* (the annotation file belongs to another
   video). Sort by name, modified time or size. *Open file* opens a single MP4. You can also drag files or
   folders onto the window.
2. Pick a phase (click a chip or press `1`–`5`, `Shift+1`–`5`), press **Q** at the first frame of the
   phase, move to the first frame of the next phase and press **W** (finish) or **E** (finish and start the
   next segment at the same boundary). **R** marks through the end of the video, so the last frame is included.
3. Click a segment (table row or timeline) to seek to its start. In the table you can relabel segments, edit
   their boundaries, set a boundary to the current frame, and delete them. You can also drag a segment
   edge on the timeline; a boundary shared by two adjacent segments moves both.
4. **Next/Previous** (or a click in the video list) first exports the current annotations (default: CSV
   beside the video), then switches. If validation or writing fails, the current video and its draft stay
   open and a dialog explains how to recover: fix the issues, download instead, choose another folder, or
   switch without exporting (the draft stays in this browser).

### Keyboard (left hand; ignored while typing in a field)

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| Space | Play / pause | Q | Set start at the current frame |
| A / D | Previous / next frame | W | Finish segment at the current frame |
| Shift+A / Shift+D | Back / forward 10 frames | E | Finish and start the next segment here |
| Z / X | First / last frame | R | Mark through end of video |
| Shift+Z / Shift+X | Previous / next video | Esc | Cancel pending start / close dialog |
| 1–5, Shift+1–5 | Select recent phase 1–10 | ⌘/Ctrl+Z, ⌘/Ctrl+Shift+Z | Undo / redo |
| Shift+/ | Help | | |

### Phases and presets

Phases have a stable **ID** (for example `chole.preparation`) and a display **name**. Renaming a phase never
changes its ID. Phases are grouped into locally managed **presets** by procedure type; two editable synthetic
examples ship with the app ("Laparoscopic cholecystectomy (example)", "Cataract surgery (example)"). Custom
phases can be added at any time. Switching the active preset changes only which chips are offered; existing
annotations and their phase IDs are untouched. The ten most recently used phases are shown as chips (short
labels share a row); the rest are under **More phases**. Recent phases are remembered across videos until you
press **Clear recent**. Chip positions stay fixed while you work on a video, so number keys don't change
meaning under you.

### Frame confirmation

The frame counter only ever shows a frame that is actually on screen. The player decodes with WebCodecs and
tags every decoded picture with its frame number, so the frame drawn on the canvas is known exactly. During
rapid scrubbing the latest seek wins and intermediate targets are dropped. A pending target is shown faintly
as `→ 1234` next to the counter. A boundary is committed only after the frame the key was pressed on has been
displayed. If that cannot be confirmed (a newer seek replaced it, a decode error, or the video isn't ready),
the mark is refused with an explanation next to the marking buttons.

## Frame numbering

- Frames are numbered **0…N−1 in presentation order** of the original MP4: samples are sorted by
  composition time (decode-order ties keep decode order). The edit list is applied the way FFmpeg applies it:
  `presentation = CTS − media_time + empty_edit`, and samples outside the edit are not frames.
- Each frame's timestamp is `round_half_up(ticks × 10⁶ / timescale)` integer **microseconds**, computed with
  integers only. Boundaries are never derived from elapsed time × average frame rate. Constant, fractional
  (30000/1001) and variable frame rates, B-frame reordering and open-GOP streams are handled. All of them were
  checked frame by frame against ffprobe.
- `duration_us` is the presentation end of the last frame: its timestamp plus its sample duration. The
  end-of-video boundary is frame **N**, and its time is `duration_us`.
- Ranges are **half-open**. When phases meet at frame 250, the first segment is `[…, 250)` (its last frame is
  249) and the second starts at 250. A segment ending at `N` includes the last frame.

## Export format (v1)

One record per segment, ordered by `start_frame`. The default sidecar names are `<video stem>.phases.csv`
and `<video stem>.phases.json`. Format and destination are chosen in the Export tab: CSV (default), JSON or
both; beside the video (default), a chosen folder (mirrors relative sub-folders, so same-named videos don't
collide), or download.

Before any export the annotations are validated: **overlaps**, **out-of-range** boundaries, **empty**
segments, non-integer boundaries and **invalid phase references** block the export. **Gaps are allowed**:
frames not covered by a segment are unlabeled.

### CSV

UTF-8 **with BOM**, CRLF line endings, RFC 4180 quoting (fields containing `,` `"` CR or LF are quoted and
embedded quotes are doubled). The video columns repeat on each row, so files from many videos can be
concatenated.

```csv
format_version,video_sha256,frame_count,duration_us,phase_id,phase_name,start_frame,end_frame,start_us,end_us
1,12ee4770f39d2f4dc3c14f8b209602e8fc6026ada5fdfe3dd2a6043351c0bc8f,250,10000000,chole.preparation,Preparation,5,45,200000,1800000
1,12ee4770f39d2f4dc3c14f8b209602e8fc6026ada5fdfe3dd2a6043351c0bc8f,250,10000000,chole.calot-triangle-dissection,Calot triangle dissection,45,118,1800000,4720000
1,12ee4770f39d2f4dc3c14f8b209602e8fc6026ada5fdfe3dd2a6043351c0bc8f,250,10000000,chole.clipping-and-cutting,"Clipping, cutting",118,250,4720000,10000000
```

| Column | Meaning |
| --- | --- |
| `format_version` | `1` |
| `video_sha256` | Full SHA-256 of the source MP4 file (64 lowercase hex) |
| `frame_count` | N, number of presented frames |
| `duration_us` | Presentation end of the last frame (time of boundary N), integer µs |
| `phase_id` | Stable phase ID, `^[a-z0-9][a-z0-9._-]{0,63}$` |
| `phase_name` | Phase name at export time |
| `start_frame`, `end_frame` | Half-open frame range `[start, end)`, `0 ≤ start < end ≤ N` |
| `start_us`, `end_us` | Timestamps of frames `start_frame` and `end_frame` (`end_frame = N` → `duration_us`), integer µs |

**Formula protection.** A text cell (`phase_id`, `phase_name`) that begins with `=`, `+`, `-`, `@`, tab, CR,
LF or `'` is written with a leading `'`, so spreadsheet applications treat it as text. Readers strip exactly
one leading `'` from those two columns. The round trip is lossless.

**Empty annotation.** A video that was annotated and deliberately left with no segments exports exactly
one row: the four video columns are filled and the six segment columns are empty. A row with an empty
`start_frame` means "this video has no segments". On import it is recognized as *annotated, 0 segments*.
Videos you never touched are not exported at all.

### JSON

UTF-8 without BOM, one segment per line:

```json
{
  "format": "phase-annotations",
  "format_version": 1,
  "video": {"sha256": "12ee4770f39d2f4dc3c14f8b209602e8fc6026ada5fdfe3dd2a6043351c0bc8f", "frame_count": 250, "duration_us": 10000000, "file_name": "case_01.mp4"},
  "segments": [
    {"phase_id": "chole.preparation", "phase_name": "Preparation", "start_frame": 5, "end_frame": 45, "start_us": 200000, "end_us": 1800000},
    {"phase_id": "chole.calot-triangle-dissection", "phase_name": "Calot triangle dissection", "start_frame": 45, "end_frame": 118, "start_us": 1800000, "end_us": 4720000}
  ]
}
```

The empty annotation is `"segments": []`.

### Import and sidecar verification

When a video opens, `.csv`/`.json` files in the same folder whose name starts with the video stem followed by
`.`, `_`, `-` or a space (`case.csv`, `case.phases.json`, `case_annotations.csv`) are candidates. If two
videos' stems match, the longer stem owns the file. A candidate is loaded only if **all** of these match the
video: the full SHA-256, the frame count, the duration, and every segment boundary (integers in range,
non-overlapping, and `start_us`/`end_us` equal to the video's own frame timestamps). A file that fails is
marked *Mismatch* with the reasons, and is never loaded. If you have a local draft that differs from a
matching file, you choose between **Use file** (the draft is checkpointed first) and **Keep draft**. Manual
import (Export tab → *Import file…*) accepts either format and goes through the same verification.

When an export would overwrite an existing file, it does so only if that file belongs to the same video (same
SHA-256). If the file's annotations differ from both the draft and the last export, they are checkpointed
first. Files belonging to another video are never overwritten.

## Recovering the exact frames from an export

Frame `k` is the k-th frame the decoder outputs (presentation order, starting at 0). A segment covers frames
`start_frame … end_frame − 1`. Any of these recovers them:

**ffmpeg**, by index (`n` is the presentation-order frame number):

```bash
ffmpeg -i case_01.mp4 -vf "select='between(n,45,117)'" -fps_mode passthrough phase_%06d.png
```

**Python (PyAV)**, by index or by timestamp:

```python
import av, csv
rows = [r for r in csv.DictReader(open("case_01.phases.csv", encoding="utf-8-sig")) if r["start_frame"]]
with av.open("case_01.mp4") as c:
    s = c.streams.video[0]
    for k, frame in enumerate(c.decode(s)):            # presentation order
        pts_us = round(frame.pts * s.time_base * 1_000_000)
        for r in rows:
            if int(r["start_frame"]) <= k < int(r["end_frame"]):
                assert int(r["start_us"]) <= pts_us     # same frame by time
                ...                                     # frame k belongs to r["phase_id"]
```

**Independent check script** (only ffprobe/ffmpeg + Node). It verifies hash, frame count, duration and every
boundary time against ffprobe, and can extract the first and last frame of each segment:

```bash
node scripts/recover-frames.mjs case_01.mp4 case_01.phases.csv --extract boundary-frames/
```

## Where data is stored

| Data | Location |
| --- | --- |
| Videos | Read in place from the folder or file you open; never copied or uploaded. |
| Frame index | Built in memory (in a worker) each time a video is opened, from the MP4's `moov` box only. |
| Drafts | IndexedDB database `phase-annotator`, store `drafts`, in this browser profile, keyed by the video's **full SHA-256**. While the hash is still being computed (seconds for multi-GB files), edits are saved under a provisional key from a quick fingerprint (size + first/last MiB) and moved to the hash key once it is known. Saved after every change (300 ms debounce, 1 s max wait) and on tab hide/close. |
| Checkpoints | IndexedDB store `checkpoints`. Automatic checkpoints are created before restoring, before replacing a draft with an imported file, and before resolving a tab conflict. |
| Phase library, presets, recent phases, settings, language | IndexedDB store `kv`. |
| Folder permissions | IndexedDB store `handles` (to reconnect the last folder after a reload). |
| SHA-256 cache | IndexedDB store `hashCache` keyed by name + size + modification time + relative path. |
| Exports | Beside the video (default), in a folder you choose, or your downloads folder. |

The app asks the browser for persistent storage, so drafts aren't evicted under storage pressure. Clearing
site data for `127.0.0.1:4173` deletes drafts and checkpoints; exports are not affected. Data stored under
`localhost:5173` (dev server) and `127.0.0.1:4173` is separate, because each origin has its own storage.

**Recovery.** After a crash, reload or closed tab, open the same folder or file again and the draft is
restored. A renamed copy of the same video finds its draft by content hash. If two tabs edit the same video,
the second tab shows a "changed in another tab" banner instead of overwriting; *Load newer* and *Keep mine*
both checkpoint the version they replace. Leaving the page with unexported changes, including on the last
video of a batch, triggers the browser's native close warning.

## Verified limitations

- **H.264 in non-fragmented MP4 only.** Fragmented MP4 (`moof`), HEVC/AV1, and encrypted tracks are refused
  with a message. Edit lists with more than one non-empty entry are indexed in composition order with a
  warning, because frame numbers may then differ from players that apply the full edit list.
- **Video only.** Playback is silent; audio tracks are ignored.
- **Chromium only for real work** (see Browser support). Folder access must be granted by the user. After a
  reload, Chrome may ask again (*Reconnect* button).
- The built-in example preset and phase names are English in both UI languages. They are data that appears
  in exports, not UI text.
- The phase library is not merged live between two open tabs (drafts are protected; library edits made in
  two tabs at once take the last write).
- Names of automatic checkpoints stay in the language that was active when they were created.
- Scrub previews in the hover tooltip show the nearest preceding keyframe (labelled as such); the main video
  always shows the exact frame.
- Tested on macOS with Google Chrome 155 (headless for automated suites, plus a desktop walkthrough). Windows,
  Linux and touch input were not tested.
- Desktop layout: designed for 1280×760 and larger, usable down to about 1100 px wide. Narrower windows scroll.

## Development and tests

```bash
npm run gen:videos     # synthetic test videos → tests/fixtures/videos (needs ffmpeg/ffprobe with libx264)
npm run typecheck
npm test               # unit tests (vitest)
npm run test:e2e       # end-to-end tests in installed Google Chrome (Playwright, channel "chrome")
```

Every synthetic frame shows its frame number twice: as large digits for people, and as a 24-cell barcode
that tests read from the canvas. Only synthetic material is used anywhere in the project.

Source layout: `src/core` (MP4 index, annotation model, CSV/JSON formats), `src/player` (WebCodecs
frame-exact player), `src/storage` (IndexedDB, autosave, hashing worker), `src/fs` (File System Access),
`src/state` (application controller), `src/ui` (workbench), `src/i18n` (English, Traditional Chinese).
Design notes: [docs/SPEC.md](docs/SPEC.md).
