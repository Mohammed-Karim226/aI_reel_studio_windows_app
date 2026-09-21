# Phase 4 implementation

The Hook Designer is now a persisted mini-composition on the master timeline:

- hook layers have editable text, timing, style, and transform values,
- hook layers support numeric keyframes with linear/eased interpolation,
- built-in templates create actual editable layer/keyframe data,
- the hook renders over the 9:16 preview during its time range,
- hook changes use the same timeline history and save/reopen flow as clip edits,
- existing project databases migrate with a validated `hook_json` column.

This slice deliberately keeps the template library small. Captions, transcription, richer motion
presets, and effects remain the next phases.
