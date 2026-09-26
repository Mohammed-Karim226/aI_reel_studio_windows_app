# AI Reel Studio (Windows)

A native Windows 10/11 (x64) desktop application built with **Tauri 2**, **React**, **TypeScript**,
and **Rust**.

This repository is at **Phase 8: AI Edit Assistant** (see `src/docs/MASTER_BUILD_SPEC.md`). Phase 0
delivered the packaged desktop shell; Phase 1 added projects, media import, and background
derivative generation; Phase 2 added editable timeline tracks, clip operations, playback, and persistence;
Phase 3 added a 9:16 composition monitor, transform editing, and platform safe-zone overlays;
Phase 4 added persisted hook text layers, keyframe interpolation, and hook templates;
Phase 5 adds local transcription, editable word timing, Arabic/English captions, nine caption styles,
word highlighting, and animation. Phase 6 adds stacked visual effects and editable keyframes.
Phase 7 adds local transcript analysis, ranked candidate clips, source-range preview, and explicit
selection that appends clips in one undoable edit. Existing timeline edits are preserved.
Phase 8 adds local timeline review for hooks, pacing, captions, zooms, weak sections, and
platform safe zones, with temporary previews and individually undoable accepted changes.

See [caption setup](src/docs/PHASE_5_IMPLEMENTATION.md),
[effects](src/docs/PHASE_6_IMPLEMENTATION.md), and
[AI Cut workflow and limits](src/docs/PHASE_7_IMPLEMENTATION.md), and
[edit review workflow and limits](src/docs/PHASE_8_IMPLEMENTATION.md).

Caption generation and AI Cut require **Python with faster-whisper** and an existing local CTranslate2 Whisper
model. Caption editing and styling work without a model. Models and Python packages are not bundled
or downloaded automatically.

Open **AI Cut** beside **Media**, select a video with audio, check **Speech setup**, and choose
**Find candidate clips**. Analyze up to one hour per request. Ranking uses adjustable local rules
over the recognized transcript; review suggestions before adding them. It does not predict audience
performance. Use **Preview suggestion** and **Play candidate** to review a range, then select clips
and choose **Add selected**. Saving persists accepted clips; analysis drafts last for the current
project session.

Open **AI Review** beside **AI Cut** after creating a timeline, select a platform guide, and
choose **Review timeline**. Preview, apply, or ignore each suggestion. Enter opening hook text
when there are no opening captions to use as a draft. Findings that require manual editing
provide guidance and a range to preview. Accepted edits use the existing hook, caption, and
effect tools and can be undone normally. Review uses local metadata rules and requires no
speech model or API key; it does not inspect video frames or listen to audio.
The next planned phase is **Phase 9: Export Engine**.

In the desktop app, use **Captions → Generate from speech → First-time setup → Open setup folder**
for the included setup helper and instructions. **Save and check setup** verifies the interpreter,
model, language support, and FFmpeg before generation. Settings are saved in the native app database.

For a development checkout, prepare the speech environment explicitly with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-transcription.ps1
```

The helper requires Python 3.10+, installs into an isolated environment, and downloads a multilingual
model. Use `-Model tiny` for a smaller model or `-CheckOnly` to inspect an existing setup offline.
In an installed app, it uses your local application data directory so no administrator access is needed.

## Prerequisites

| Requirement                             | Notes                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Windows 10/11 x64                       | Build and target platform                                                                       |
| Node.js >= 22                           | Includes npm (npm >= 11 recommended)                                                            |
| Rust (stable, `x86_64-pc-windows-msvc`) | Install via [rustup](https://rustup.rs)                                                         |
| Visual Studio 2022 Build Tools          | "Desktop development with C++" workload (MSVC v143 + Windows SDK)                               |
| WebView2 Runtime                        | Preinstalled on Windows 11; Evergreen on updated Windows 10                                     |
| **FFmpeg + ffprobe**                    | Required for import. `winget install Gyan.FFmpeg`, or point the app at an existing `ffmpeg.exe` |

FFmpeg is deliberately **not bundled** in v1. Discovery order is: user-configured path,
`FFMPEG_PATH`, next to the executable, `PATH`, then well-known install directories
(`winget`, Chocolatey, Scoop).

## Setup

```powershell
npm install
```

## Commands

### Frontend and packaging

| Command                | Description                                                               |
| ---------------------- | ------------------------------------------------------------------------- |
| `npm run dev`          | Start the Vite dev server (frontend only, port 1420)                      |
| `npm run tauri dev`    | Run the native desktop app in dev mode with hot reload                    |
| `npm run tauri build`  | Type-check, bundle, compile Rust (release), produce NSIS + MSI installers |
| `npm run test`         | Run frontend unit tests (Vitest)                                          |
| `npm run test:watch`   | Run tests in watch mode                                                   |
| `npm run typecheck`    | TypeScript check, no emit                                                 |
| `npm run lint`         | ESLint                                                                    |
| `npm run format`       | Prettier write                                                            |
| `npm run format:check` | Prettier check                                                            |
| `npm run icon`         | Regenerate `assets/app-icon.png` and the full Tauri icon set              |

### Rust (run inside `src-tauri/`)

| Command                       | Description                  |
| ----------------------------- | ---------------------------- |
| `cargo fmt --check`           | Verify formatting            |
| `cargo clippy -- -D warnings` | Lint with warnings as errors |
| `cargo test`                  | Run Rust unit tests          |

## Project structure

```
├─ index.html                     Vite entry point
├─ src/                           React + TypeScript frontend
│  ├─ app/                        Root component and routing between picker/editor
│  ├─ domain/                     Zod schemas + types mirroring the Rust contracts
│  ├─ features/                   projects, media, preview, inspector, jobs, system
│  ├─ infrastructure/tauri/       Typed IPC wrappers (invoke + validation), asset URLs, events
│  ├─ shared/                     UI primitives and formatting helpers
│  └─ stores/                     Zustand stores (workspace, media, jobs)
├─ src-tauri/                     Rust native application
│  ├─ src/commands/               IPC surface (system, projects, media, jobs)
│  ├─ src/db/                     SQLite: app registry, per-project database, migrations
│  ├─ src/media/                  FFmpeg discovery, probe, proxy, thumbnail, waveform, runner
│  ├─ src/jobs/                   Background job registry + derivative pipeline
│  ├─ src/project.rs              On-disk project layout (spec §25)
│  ├─ src/state.rs                Shared application state
│  ├─ src/logging.rs              Categorized file logs + in-memory ring
│  └─ src/error.rs                Typed error envelope crossing IPC
└─ scripts/                       Node tooling scripts
```

## Architecture notes

- The web view is a thin UI layer; every privileged operation lives on the Rust side behind a
  typed `invoke` command. Frontend payloads are validated with Zod before use.
- A project is a portable directory (spec §25): `project.json` manifest, `project.db`, and one
  subdirectory per artifact class. The project list lives in an app-level database under
  `%APPDATA%\com.aireelstudio.app\`.
- Original media is never modified or copied; derivatives are written inside the project directory
  and source files are streamed to the preview through the Tauri asset protocol.
- All long-running work runs on worker threads and reports through the job registry, which streams
  progress to the UI on `job://update`. Derivative runs are queued behind a small concurrency cap
  so a multi-file import cannot start dozens of ffmpeg processes, and each artifact is rendered to
  a staging file before it replaces the previous one. Failed jobs carry a typed, retryable error
  envelope shared with failed commands.
- A project missing its database is rebuilt from `project.json`, so a half-copied folder stays
  openable.
- Content Security Policy is set in `src-tauri/tauri.conf.json`; relaxations must be justified
  per feature. The readable scope of the asset protocol is extended at runtime only for the open
  project directory and the sources it references.
- The desktop close handler saves outstanding edits and cancels/waits for background jobs before
  destroying the window. Failed saves or jobs that cannot stop leave the editor open with an error.
- Installers are produced to `src-tauri/target/release/bundle/` (`nsis/` and `msi/`).

## Quality gates

- Frontend: `typecheck`, `lint`, `format:check`, `test`.
- Rust: `fmt --check`, `clippy -- -D warnings`, `test`.
- Packaging: `npm run tauri build` produces NSIS + MSI installers; the packaged executable is
  smoke-tested by launching it.

Code signing and CI are planned for a later phase.
