# Product brief (verbatim)

Build a standalone, local-first surgical phase annotation tool from scratch. It should run as a polished desktop web app on localhost. Deliver working code, startup instructions, and a record of what you tested.

## 1. Scope

The first release supports H.264 video in MP4 files. An annotation assigns a surgical phase to a continuous range of frames, such as “Phase A” from frame 100 through frame 249. The tool should work offline once set up. Videos, frame indexes, labels, drafts, checkpoints, and exports stay on the device. Let users switch between English and Traditional Chinese.

## 2. Visual design and interaction quality

Design the workbench specifically for people who spend long sessions reviewing and annotating video. Give it a distinct, professional appearance through typography, spacing, alignment, and a restrained color palette. Avoid the generic AI-generated dashboard look, including decorative gradients, oversized cards, filler copy, and badges with no practical purpose. Use color where it helps distinguish phases, selection, save state, or errors.

Keep the video visually dominant and the controls predictable. Put frequently used actions within easy reach of the player, keep their positions stable as the workspace changes, and move instructions into a separate help dialog. Make the selected phase, current frame, pending start, and save or export state easy to spot at a glance. Use clear feedback when an action is unavailable or fails.

Make scrubbing, frame stepping, and consecutive annotations feel immediate. Keep indexing, hashing, and file writes off the main interaction path. During rapid scrubbing, the latest seek should win. Commit an annotation boundary only after confirming the corresponding frame is displayed. Keep users in context while they edit and minimize clicks and pointer travel when moving through a batch.

## 3. Annotation workbench

- Put the filename and Previous/Next buttons above the video. Place playback controls and a zoomable phase timeline beneath it. Below the timeline, put annotated segments, checkpoints, and export actions on the left and the batch file list on the right. Reserve the panel beside the player for phase selection and common marking actions.
- Support play and pause, one-frame steps in both directions, jumping to a frame number, scrubbing with a visible preview, and clicking a segment to seek to its start. Show the current frame, total frame count, and time.
- Let users mark a start, finish at the current boundary, or finish one segment and start the next at that same boundary. Users can relabel segments, edit their boundaries, and delete them. Include a “Mark through end of video” action so the last frame can be included.
- Keep shortcuts on the left side of the keyboard so the right hand can stay on the mouse. Use Space for play/pause, A/D for previous/next frame, Q to set the start, W to finish a segment, E to finish and start the next segment, R to mark through the end, and Z/X to jump to the first/last frame. Suppress these shortcuts while the user is typing in a field.
- Show phases as clickable, colored chips. Show the 10 most recent labels directly, let short labels share a row, and put the rest under “More phases.” Keep recent labels across videos until the user clears them. Support custom labels and locally managed phase presets grouped by procedure type. Changing presets preserves existing annotations and phase IDs.

## 4. Frame accuracy and training exports

- Number frames in the original MP4’s presentation order, starting at 0. Use media timestamps and verified frame presentation or decoding to identify the frame. Handle constant, fractional, and variable frame rates and encoded frame reordering. Do not calculate boundaries by multiplying elapsed time by the average frame rate. If the displayed frame cannot be confirmed, prevent marking and explain why.
- Use half-open ranges `[start_frame, end_frame)`. When two phases meet at frame 250, the first ends after frame 249 and the second begins at frame 250. For a video with N frames, the end-of-video boundary is N.
- Default to CSV, with JSON and both formats available as options. Export one record per segment with a stable phase ID, phase name, frame boundaries, and time boundaries in integer microseconds. Include the format version, full SHA-256 digest of the source video, frame count, and duration. Keep exports compact. CSV should use UTF-8 with BOM, handle quotes and line breaks, and protect text that spreadsheet applications might interpret as formulas.
- Before training export, validate overlaps, out-of-range boundaries, empty segments, and invalid phase references. Allow gaps and leave uncovered frames unlabeled. Document the format with CSV and JSON examples and show how to recover the exact boundary frames from the source video and its export.

## 5. Batch annotation and recovery

- Let users open an individual MP4 or recursively list supported videos in a selected folder. Show relative paths and annotation status, including annotated, unannotated, and not yet verified. Support sorting by name, modification time, and size. Users can switch videos from the list or with Previous/Next.
- Detect compatible CSV or JSON files beside the source video and support manual import of both formats. For an individually opened MP4, ask for access to its source folder if needed. Use filenames to find candidates and verify the full SHA-256 digest, frame count, duration, and segment boundaries before loading. Let users choose between importing the matching file and keeping their draft. Create a checkpoint before replacing it.
- Before switching videos, save and export the current annotations. Default to CSV in the source folder and allow users to change the destination and format. Keep the current video and draft open if validation or writing fails, and explain how to recover. If the browser cannot write to a selected folder, offer manual download. Define how an empty draft is exported and recognized.
- Autosave drafts in local browser storage and identify them by the full video hash so users can recover after a reload, a crash, or reopening a renamed file. Support named checkpoints and preserve the current state before restoring one. Show when work is being saved, when it has been saved or exported, and when an operation fails. Prevent a stale browser tab from silently overwriting newer edits.
- Warn before leaving the workbench with unexported changes, including on the last video in a batch. Use the browser’s native close warning where available. Rely on committed local drafts to recover from an unexpected exit.

## 6. Acceptance and delivery

Test with synthetic MP4s that show identifiable frame numbers, including constant and variable frame rates. Verify the first, middle, and last frames, rapid scrubbing, frame stepping, adjacent segments, and round-trip CSV and JSON import and export against the actual video frames. Test same-name file mismatches, sidecar discovery, batch switching, denied write permissions, crash recovery, checkpoint restoration, and the unexported-changes warning on the last video.

Walk through a multi-video annotation session in a real desktop browser using both mouse and keyboard. Check that controls stay in place, rapid seeking does not leave the frame counter out of sync with the image, and background work does not interrupt marking or playback. Verify that annotation and export work offline.

Deliver a README covering setup, browser support, where drafts are stored, the export schema, and verified limitations. Use only synthetic material for examples and tests.
