# Phase 4 implementation

The Hook Designer is now a persisted mini-composition on the master timeline:

- hook layers persist text, timing, style, and transform values; the current inspector exposes
  text, start/end, and X/Y offsets,
- hook layers support numeric keyframe data with linear/eased interpolation and a Pop preset,
- built-in templates create actual editable layer/keyframe data,
- the hook renders over the 9:16 preview during its time range,
- hook changes use the same timeline history and save/reopen flow as clip edits,
- existing project databases migrate with a validated `hook_json` column.

Review before Phase 5 corrected stale inspector values after undo/template changes and offset Pop
keyframes to the layer's start time. Preview text now scales to the composition monitor, offsets
refer to the canvas, and safe-zone guides stay above overlays.

This slice deliberately keeps the template library small. The full Phase 4 specification still
includes shapes, a keyframe editor, complete style/transform controls, and layer deletion. Hook-only
compositions also require media clips to supply playback duration. Those items remain follow-up work;
Phase 5 adds the caption engine and transcription.
