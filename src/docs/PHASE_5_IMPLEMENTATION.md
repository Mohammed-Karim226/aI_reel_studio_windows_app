# Phase 5 implementation

Captions are now persisted timeline data with word timestamps and a composition preview. They use
the same undo/redo and save/reopen flow as clips and hooks.

## Delivered

- A Rust `TranscriptionProvider` interface and real local faster-whisper implementation. The frontend
  passes a project/media ID and the selected clip's source range; Rust resolves the original source,
  extracts mono 16 kHz audio with FFmpeg, and runs the model on CPU with word timestamps.
- Background transcription jobs with progress, cancellation, timeout/output bounds, typed errors,
  a single active model with a cancellable queue, and cleanup of each request's temporary WAV.
  No speech, missing dependencies, and invalid model
  output are reported rather than replaced with sample captions.
- Word timestamps mapped from the extracted source range onto the clip's master timeline position.
  Segmentation respects reading limits, pauses, and Arabic/English punctuation. Overlapping
  recognizer words stay together so neighboring captions do not overlap.
- Generated captions are reviewed before applying. Apply replaces caption segments intersecting
  the selected clip's range and preserves segments wholly outside it. Results cannot overwrite a
  changed timeline or a different project.
- Manual captions; whole-caption and word text/timing edits; proportional retiming; split, merge,
  delete, and word emphasis. Editing whole-caption text evenly redistributes word timing; editing
  individual words preserves the other timestamps.
- Classic, Bold, Karaoke, Word Highlight, Minimal, Podcast, Impact, Dynamic, and Arabic Viral styles.
  Font, size, weight, colors, outline, shadow, background, position, line spacing, and width are
  customizable. Current-word/karaoke highlighting and Fade/Pop animation follow the playhead,
  including when scrubbing.
- Arabic shaping through the browser text engine, explicit/automatic paragraph direction, and
  natural mixed-script phrase/number ordering. The Arabic preset uses installed Tahoma/Arial fonts.
- A captions lane with timing blocks, seek controls, and visibility toggle. Preview sizing follows
  the design canvas; platform safe-zone guides remain visible above hooks and captions.
- Matching Zod/Rust validation and SQLite migration 3 (`captions_json`). Older timelines get empty
  captions. Captions are retained after media trims so they can be retimed or deleted, and do not
  extend the media timeline duration.
- Native application-wide speech settings with migration from the original WebView settings.
  **Save and check setup** verifies Python, faster-whisper/CTranslate2, the local model, Arabic
  compatibility, and FFmpeg. Model checks share the transcription slot and use a bounded hidden
  subprocess. Dependency/library logging cannot corrupt the JSON protocol.
- Native executable/folder pickers and a setup helper/guide included in the Windows installers.
  The helper uses an isolated environment and per-user storage when launched from an installed app.
- Source/timeline switching retains generated drafts. Windows close/Alt+F4 saves outstanding edits,
  pauses playback, cancels and waits for jobs, and keeps the window open if saving/stopping fails.
  A busy overlay prevents new edits during shutdown; active setup checks/imports also prevent close.

## Local transcription setup

From the desktop app, open **First-time setup → Open setup folder**. The folder contains instructions
and `setup-transcription.ps1`; opening it does not install or download anything. Running the helper
explicitly requires Python 3.10+ and internet access. It installs faster-whisper 1.2.1 and downloads
the multilingual small model. For a development checkout:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-transcription.ps1
```

The helper prints the exact executable and model paths. It uses `.venv-captions/` in a development
checkout and `%LOCALAPPDATA%\com.aireelstudio.app\speech-runtime` when packaged, avoiding writes to
Program Files. Use `-Model tiny` for a smaller multilingual model or `-SkipModelDownload` to prepare
only the environment. To inspect an existing installation without network or filesystem changes:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-transcription.ps1 -CheckOnly
```

An existing Python 3.9+ environment and model can also be selected directly. Choose the interpreter
in **Python executable** and the model in **Local model folder**. The folder must include `model.bin`,
`config.json`, and `tokenizer.json`. The application runs Python in isolated mode, so a `--user`
package installation is insufficient; use a virtual environment or environment-wide installation.
The provider uses offline/local-files-only mode and does not download anything during generation.
FFmpeg must also be configured as described in the README.
The selected Python/model paths and language are remembered in the native app database on this device.
After changing any of them, use **Save and check setup** again; generation is enabled only after a
successful check. Arabic rejects English-only models. An Auto check using an English-only model is
reported as English-only so the user can choose a multilingual model if needed.

## Workflow

1. Import a video or audio file, append the desired source range, and select one timeline clip
   containing speech.
2. Open **Timeline preview → Captions → Generate from speech**. Configure the local provider and
   choose Auto, English, or Arabic, run **Save and check setup**, then set caption density.
3. Choose **Generate captions**. Follow progress or cancel in **Jobs**.
4. Review the generated text, then choose **Apply generated captions**. If the timeline changed
   during recognition or review, generate again for the current edit.
5. Choose a style, customize it, and edit the segments/words. Play or scrub to review timing and
   highlighting. Save the timeline; reopening restores the caption document.

Manual editing is available through **Add at playhead** without Python or a model.

## Validation and current limits

Rust tests cover persistence round trips, migration from Phase 4, rejection/rollback of invalid
captions, provider parsing, source-range arguments, offline configuration, cancellation, timeout,
and output bounds. Frontend tests cover segmentation, Arabic direction, highlight/animation
boundaries, generation/apply guards, undo/save/reload, and preserving precise word times on blur.

TypeScript checking, ESLint, Prettier, and the production frontend build passed in this workspace.
All 234 Rust tests passed (one additional subprocess fixture is intentionally ignored during normal
collection); Clippy and Rust formatting passed. A direct caption-domain smoke check also passed all
nine presets, RTL checks, and 500 generated timing/segmentation cases. Eight Python subprocess
protocol tests passed, including offline behavior, noisy native stdout, missing/broken dependencies,
and Arabic model compatibility. Direct mocked smoke checks also exercised native settings migration,
readiness invalidation, failed-save recovery, and seven desktop-close scenarios (including delayed
save, duplicate close, cancellation, and a five-second timeout).

The complete Vitest suite still cannot start because its resolver and workers canonicalize a parent
directory denied by the Windows sandbox. The authorized escalation retry failed because the automatic
approval review service returned HTTP 403. These are infrastructure blockers; the full frontend tests
remain unexecuted. An isolated Python environment was created, but installing faster-whisper failed
with restricted-network WinError 10013. No model was downloaded, and live speech recognition remains
unverified. FFmpeg/ffprobe are also absent from the checked local locations.

A temporary equivalent native Vite config was used to build inside the sandbox. The Tauri installer
build reused the verified frontend bundle while skipping its normal npm pre-build hook for the same
reason; the checked-in build commands remain unchanged. The installer build failed with OS error 112
(not enough disk space). Further builds are paused for approved compiler-cache cleanup. Existing
installers are older artifacts and do not verify the current changes; a new installer remains unverified.
The approved cleanup command was also blocked before execution by an automatic approval review
HTTP 403 failure. All eight targeted cache directories remain (6,836,923,690 bytes, about 6.4 GiB);
no cache space was reclaimed, and the existing installer hashes are unchanged.

Generation currently covers one selected source range at a time (up to one hour). Provider quality
and speed depend on the chosen multilingual model and hardware. Caption motion/styling currently
renders in the preview; burned-in export is part of Phase 9. GPU/provider selection, batch
transcription, and importing/exporting subtitle files remain outside this phase.

Phase 6 effects are now implemented; see [Phase 6](PHASE_6_IMPLEMENTATION.md).
Development has continued through [Phase 7: AI Cut](PHASE_7_IMPLEMENTATION.md).
