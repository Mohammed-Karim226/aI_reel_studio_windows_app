# Phase 8 implementation

## Scope and assumptions

Phase 7 is complete. This phase adds an AI Edit Review beside Media and AI Cut,
using local rules over the actual timeline, hook, captions, and effect metadata.
It requires no additional model, download, or API key. Findings describe measurable
editing conditions, not judgments of speech meaning, video motion, or audience response.

Suggestions cover opening hooks, pacing, captions, zooms, weak sections, and platform
safe zones. Editable suggestions use strict schemas and the existing timeline reducer.
Timing gaps and other findings that require editorial judgment provide manual guidance.
An opening hook uses existing opening caption text as a draft when available; otherwise
the user supplies the text. No transcript or claimed source facts are invented.

## Delivered

- Shared platform safe-zone geometry and strictly validated analysis/edit contracts.
- Up to 50 findings per review, respecting enabled tracks, clip visibility, locked
  tracks, existing zooms, and source-time effect keyframes.
- A project-scoped review session with ignore, preview, and one-step undoable
  application through the existing timeline store. Applying refreshes the review.
- Temporary composition preview with bounded playback and replay. Exit preview returns
  to the committed edit; saving while previewing saves only the committed document.
- Stale-result protection after timeline edits, undo/redo, platform changes, or source
  replacement. Derivative refreshes preserve the review. Project changes and reloads
  discard the session; project closing exits preview and blocks application.
- Editable opening hook text, including Arabic, with existing layers preserved;
  caption readability, emphasis, and approximate safe-zone fixes; subtle zoom pulses.

## Workflow

1. Create a timeline, then open **AI Review** beside **Media** and **AI Cut**.
2. Choose a platform and select **Review timeline**.
3. Read each finding and its explanation. For an opening hook, review the caption-derived
   draft or enter the exact text to add.
4. Choose **Preview** and play the indicated range in the monitor. Editable suggestions
   appear temporarily in the composition; manual findings show the existing edit.
5. Choose **Apply** to keep an editable suggestion in one undoable action, or **Ignore**.
   Manual findings have a disabled Apply control and explain where to make the edit.
6. Use **Review again** after manual changes. Save normally to keep accepted edits.

## Persistence

Accepted edits are ordinary hooks, caption styles, and clip effects in the existing
timeline format. Saving and reopening preserve them through the current native storage.
Review findings and ignored suggestions remain in memory for the current project.

## Verification

On September 26, 2026, the full frontend run passed 22 suites and 201 tests. Two
additional analysis regressions were then added and the complete 18-test review-domain
suite passed, for 203 unique frontend tests verified. Coverage includes strict schemas,
visibility and source timing, Arabic hook text, safe-zone estimates, preview isolation,
bounded playback and replay, stale results, source/project replacement, closing guards,
undo/redo, and accepted-edit persistence.

TypeScript, ESLint, repository-wide Prettier, and the production frontend build passed.
Rust formatting, Clippy with warnings denied, and 247 tests passed; one subprocess
fixture remains intentionally ignored. The frontend tools ran inside the managed
Windows sandbox with Node's preserve-symlink options and the existing native Vite
validation configuration. Standard npm entry points remain unchanged.

The production bundle reports its existing dependency annotation warnings and a main
JavaScript chunk above Vite's 500 kB warning threshold. No performance claim is made.

The Windows installer build was attempted after producing the frontend bundle. Rust's
release compiler stopped with `IO failure on output stream: no space on device`; about
29 MB remained on the drive. The workspace's generated `src-tauri/target/debug/incremental`
cache measured 1,379,379,875 bytes. Cleanup was not executed because automatic approval
review failed with `content-blocked`. A new Phase 8 executable/installer has not been
produced; older files under `target/release` are not verification of this phase.

A separate fixture using the real review panel, composition monitor, and stores bundled
successfully for a browser visual check. Edge headless timed out without producing DOM
or a screenshot in this sandbox. Visual desktop/GPU behavior remains unverified beyond
the automated component and playback tests.

## Limits

The analysis does not inspect video frames, detect speakers, measure audio silence or
loudness, or generate semantic hook copy. A long uncut clip can contain motion within
its source; an uncovered caption interval does not establish silence. Safe-zone checks
are estimates based on text layout metadata and the editor's platform guides, not
platform guarantees or measurements of rendered font glyphs.

The next planned phase is **Phase 9: Export Engine**.
