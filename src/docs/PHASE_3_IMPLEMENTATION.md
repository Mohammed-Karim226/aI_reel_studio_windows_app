# Phase 3 implementation

Phase 2 left the project with a persisted, editable master timeline. This phase continues with
the vertical composition slice from the master build specification:

- the timeline monitor is rendered in the project format (1080x1920 by default),
- each active video/image clip applies its non-destructive transform at preview time,
- transform edits are validated domain operations and participate in undo/redo and persistence,
- platform safe-zone overlays can be previewed without changing the master timeline.

The monitor still uses proxies when available. Rendering from original media, captions, hooks,
effects, and platform export presets remain subsequent vertical slices.

## Verification

- Rust formatting and all 200 native tests pass.
- `git diff --check` passes.
- Frontend checks are currently blocked in this environment because Node cannot resolve the
  workspace parent path (`EPERM`); run `npm.cmd run typecheck`, `npm.cmd test -- --run`, and
  `npm.cmd run lint` on a normal Windows checkout.
