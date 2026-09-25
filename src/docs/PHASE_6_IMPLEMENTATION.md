# Phase 6 — Effects

Phase 6 adds non-destructive visual effects to video and image clips. The effect stack is part of
the timeline document, so ordinary undo, redo, save, and reopen preserve its order, parameters,
enabled states, and animation curves.

## Delivered scope

- Zoom and Punch Zoom, with scale and horizontal/vertical center controls.
- Blur, Glow, Sharpen, and Vignette.
- Color Correction, with brightness, contrast, saturation, temperature, and tint.
- An ordered stack of up to 16 effects per clip, including multiple instances of the same effect.
- Controls to add, remove, enable, disable, and move effects up or down the stack.
- Parameter keyframes with linear, ease-in, ease-out, and ease-in-out interpolation.
- Validation in both the TypeScript domain and Rust persistence layer.
- A database migration that gives existing clips an empty effect stack.

Each parameter can contain up to 100 keyframes. Animation times belong to the original source
media. Moving a clip does not shift its curve, while splitting, duplicating, or trimming retains
the curve and keyframes outside the current trim. Punch Zoom starts with a short scale animation
that zooms in, holds, and returns to neutral within the first 0.6 source seconds of the clip.

## Workflow

1. Select one video or image clip on an unlocked video track.
2. In **Effects**, choose a type and select **Add**.
3. Adjust its parameters. Effects run from the top of the stack to the bottom; use **Up** and
   **Down** to change that order, or disable an effect to compare the result.
4. Seek inside the selected clip and select **Keyframe at playhead** for a parameter. Seek to
   another time and change the parameter to add or update a point on that curve.
5. Expand the parameter's keyframes to edit their clip-relative times, values, and arrival easing.
   **Clear animation** retains the currently evaluated value as a constant parameter.
6. Play or scrub the timeline to review the result, then save the project.

Locked tracks and non-visual clips cannot receive visual effects. Invalid parameter values or
duplicate keyframe times are rejected without changing the previous edit.

## Preview and persistence

The preview uses WebGL2 passes in the saved stack order. Zoom consumes the preceding effect's
image; blur and glow use separable passes; color correction, sharpening, and vignette each use
their own pass. Premultiplied alpha preserves transparent media edges. Preview and source texture
allocations are bounded independently of display DPI and original media resolution.

The original media element remains responsible for video playback and audio. Rendering responds
to decoded video frames, paused seeks, source loading, and canvas resizing. If WebGL2 or the
graphics context is unavailable, the preview displays the original media with an effects status
message. Context restoration recreates the rendering resources.

Effects are stored as JSON on each timeline clip. Rust validates the entire document before
transactional writes and validates stored effects when loading. A failed save rolls back the
other edits in the transaction. Older projects migrate without replacing their clips, media,
captions, or hook composition.

## Validation and limits

Existing automated tests cover effect contracts and bounds, stack ordering and bypass,
interpolation, source-time retention through edits, inspector controls, undo/redo, persistence,
migration, and rejected or failed writes. A separate browser pixel smoke script is available at
`.runtime-check/effects-pixels.mjs`; it exercises the actual renderer with synthetic images.

On September 25, 2026, Rust formatting and Clippy with warnings denied passed. The Rust suite
passed 247 tests with one intentionally ignored subprocess fixture. This includes the effect
validation and database migration/persistence tests. A compile error in an existing effect test
was corrected by cloning its animation fixture instead of requiring a `Copy` implementation.

The browser pixel smoke could not complete in this session: the sandboxed graphics subprocess
failed, and an in-process GPU retry timed out. Automatic approval review failed with
`content-blocked` before the outside-sandbox retry could execute; this was a review service
failure, not an unsafe-action determination. These attempts do not verify the rendered pixels.
Frontend checks and installer results should be recorded with the current build's validation.

Effects currently render in the timeline preview. Export rendering is planned for Phase 9.
Motion blur, noise, speed changes, additional effects, and effect export presets remain outside
this phase. Browser smoke checks do not establish hardware GPU performance or decoding behavior
for every source codec. No automated component test currently verifies the complete effect
preview lifecycle with real video playback and graphics-context recovery.

The next planned phase is **Phase 7: AI Cut**: transcript-based candidate clips, scoring, user
selection, and explicit creation of an edit without automatically replacing an existing timeline.
