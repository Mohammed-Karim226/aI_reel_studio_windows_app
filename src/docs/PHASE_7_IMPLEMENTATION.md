# Phase 7 implementation

## Scope and assumptions

The repository already contains the Phase 6 effects stack. Phase 7 continues with an
end-to-end AI Cut workflow: local speech recognition, transcript-derived candidates,
transparent ranking, source preview, explicit selection, and undoable timeline creation.

Speech recognition reuses the existing native faster-whisper provider, setup checks,
bounded extraction, job progress, and cancellation. Analysis handles one source range
of at most one hour per request. A longer source can be analyzed in successive ranges.
Candidate ranking uses configurable local rules over real recognized words, pauses,
and punctuation. Scores are editing hints, not semantic judgments or predictions of
audience performance. English and Arabic cues are supported; users review every cut.

## Delivered

- Validated duration controls (up to five minutes per candidate), suggestion count
  (up to 50), and weights for opening, clarity, emotion-word, useful-content,
  sentence-boundary, and pacing signals. Defaults suggest 15–60 second clips.
- Arabic/English punctuation and cue handling, overlapping-word grouping, source-time
  mapping, and ranked nonoverlapping suggestions. Two-second pauses divide passages.
  Bounds come from recognized speech; silence is not added to satisfy clip lengths.
- An intentionally bounded search: at most 2,048 sampled start positions and three
  windows per position. Long transcripts can contain other suitable moments beyond
  those sampled. Explanations report observed cues and this sampling limitation.
- Native transcription jobs, readiness checks, error reporting, and cancellation
  through Jobs. No sample transcript or invented model output is used.
- A project-scoped review draft that survives source/timeline switching and ordinary
  edits. Project reloads, changed/removed sources, and late results cannot apply to
  another project. Derivative refreshes do not invalidate an unchanged source.
- Re-ranking without another speech request. Selections survive when the same ranges
  remain in the new results. Applying clears the draft to avoid accidental reapplication.
- Source preview with seek-to-start, bounded playback, replay, and exit controls.
- Atomic chronological append after the existing timeline, creating a compatible
  unlocked video track when needed. Reviewed ranges are rounded inward to whole frames.
  Undo/redo and save/reopen use the existing timeline infrastructure. Existing clips,
  hooks, captions, and effect stacks remain part of the same document.

## Workflow

1. Import a video with an audio track, then open **AI Cut** beside **Media**.
2. Select the source and analysis range; use successive ranges for videos over one hour.
3. Open **Speech setup** and use **Save and check setup** with the same local environment
   used for captions. Set minimum/maximum clip lengths and optional ranking preferences.
4. Choose **Find candidate clips**. Follow progress or cancel in **Jobs**.
5. Read suggestions and their **Why this clip?** explanations. **Preview suggestion**
   opens the range in the source monitor; **Play candidate** plays only that range.
6. Check the suggestions to keep and choose **Add selected**. Clips are appended in
   source order in one undoable action. Save the timeline normally.

## Verification

On September 25, 2026, all 18 frontend suites passed (164 tests), including analysis
bounds, Arabic cues, timing offsets, provider errors, project/source invalidation,
atomic append, undo/redo, save/reopen, review selection, and candidate playback.
A final candidate-playback improvement also passed all four source-monitor tests,
including a new check that stops between sparse media events and cleans up its frame
callback on unmount (165 unique frontend tests verified overall).
TypeScript and ESLint also passed. The tests ran inside the sandbox using an equivalent
native Vite configuration, a threads pool, Node's preserve-symlink options, and a wrapper
around Vitest's built-in jsdom environment. This avoids the sandbox's blocked parent-path
resolution; the normal npm entry points remain unchanged.

Repository-wide Prettier passes after normalizing tracked Windows line endings and
formatting two existing effects inspector files. Native formatting and Clippy with warnings denied
passed, and Rust passed 247 tests (one intentionally ignored subprocess fixture).
An existing effects test compile error was fixed while running these gates.

The full frontend test command's outside-sandbox retry was not executed because automatic
approval review failed with `content-blocked`. The sandbox-compatible run above subsequently
verified the suite without escalation. Real browser/GPU effects checks remain unverified
as described in the Phase 6 document.

## Persistence and limits

Accepted clips use the existing timeline format and SQLite persistence. Transcript
review drafts are held in memory for the current project. Saving a timeline preserves
accepted clips; closing the project discards unaccepted analysis. Captions and effects
can be added to accepted clips with the existing editor tools.

Speaker identification, visual/face analysis, model-based semantic ranking, and
automatic hook or caption generation are outside this slice.

Live speech recognition still requires an installed faster-whisper environment, a local
model, and FFmpeg. Automated workflow tests use provider fixtures and do not establish
transcription quality on real speech or rendering performance on the user's hardware.

The next planned phase is **Phase 8: AI Edit Assistant**.
