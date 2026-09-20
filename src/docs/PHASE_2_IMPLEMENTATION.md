# Phase 1 review and Phase 2 implementation

## Scope and assumptions

The existing stack is Tauri 2, Rust, React 19, strict TypeScript, Zustand, Zod,
Tailwind, and per-project SQLite. Reuse the media library, FFmpeg worker pipeline,
asset URLs, project lifecycle, existing timeline tables, and typed IPC boundary.

Phase 2 delivers one editable master timeline per project. Times are seconds,
quantized to the project frame rate. Edits preserve source media. Video and audio
tracks support manual editing; composition transforms and generated text remain
later phases. Same-track overlap is rejected so moving a clip never silently
overwrites another clip. Different tracks may overlap.

## Phase 1 review

- Project creation/reopening, metadata, thumbnails, filmstrips, bounded background
  proxy generation, and streamed waveform generation exist. Baseline: 196 Rust
  tests pass.
- Audio-only imports incorrectly displayed a message directing users to a
  waveform with no audio playback control. Image imports also used video preview.
- Import commands re-read the active project after asynchronous probing, allowing
  a project switch to redirect the import. Bind imports to their starting project.
- Media removal deletes derivatives before the database row. With timeline foreign
  keys, a rejected removal would destroy usable preview artifacts. Check timeline
  references first and remove the database row before cleaning derivatives.
- Source media remains externally referenced: moving only the project folder does
  not move originals. Missing-database recovery restores the project header only,
  not media or timeline edits. Full portability/recovery remains later work.

## Implementation order

1. Fix Phase 1 preview and project-isolation issues.
2. Add validated timeline contracts, frame-based editing operations and history.
3. Persist timelines transactionally in existing SQLite tables, with project-ID
   guards and source/reference validation.
4. Build timeline tracks, clip selection, drag/trim, snapping, precision editing,
   keyboard commands, source ranges, playback, and explicit save/reopen.
5. Verify editing invariants, history, persistence, invalid-input rejection, and UI
   flows; run frontend and native quality gates and build where permitted.

## Verification environment

PowerShell blocks `npm.ps1`; use `npm.cmd`. Node currently cannot resolve the
workspace parent inside the sandbox (`EPERM`). An escalation attempt was rejected
because the automatic approval service returned HTTP 403. Frontend checks remain
pending until an authorized execution environment is available.
