import { describe, expect, it } from "vitest";

import { mediaAssetSchema } from "@/domain/media";
import { createEffect, evaluateEffects } from "@/domain/effects";
import { applyEdit } from "./edit";
import {
  createTimeline,
  createTrack,
  deserializeTimeline,
  serializeTimeline,
  type Timeline,
} from "./model";

const asset = mediaAssetSchema.parse({
  id: "media-1",
  originalPath: "C:\\media\\podcast.mp4",
  fileName: "podcast.mp4",
  kind: "video",
  container: "mp4",
  sizeBytes: 100,
  durationSec: 20,
  hasVideo: true,
  hasAudio: true,
  video: {
    codec: "h264",
    width: 1920,
    height: 1080,
    displayWidth: 1920,
    displayHeight: 1080,
    fps: 30,
    rotation: 0,
    pixFmt: "yuv420p",
    bitRate: null,
  },
  audio: { codec: "aac", channels: 2, sampleRate: 48000, bitRate: null },
  importedAt: "2026-01-01T00:00:00Z",
  derivatives: [],
});

function timelineWithClip(): Timeline {
  const timeline = createTimeline({ width: 1080, height: 1920, fps: 30 });
  timeline.tracks[0].clips.push({
    id: "clip-1",
    sourceMediaId: asset.id,
    label: asset.fileName,
    sourceStart: 0,
    sourceEnd: 5,
    timelineStart: 0,
    timelineEnd: 5,
    speed: 1,
    enabled: true,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    effects: [],
  });
  timeline.duration = 5;
  return timeline;
}

describe("timeline composition edits", () => {
  it("updates a clip transform without changing its timing", () => {
    const result = applyEdit(
      timelineWithClip(),
      {
        type: "transform",
        id: "clip-1",
        patch: { x: 12, y: -8, scale: 1.25, rotation: 4, opacity: 0.8 },
      },
      [asset],
    );
    const clip = result.tracks[0].clips[0];
    expect(clip.transform).toEqual({ x: 12, y: -8, scale: 1.25, rotation: 4, opacity: 0.8 });
    expect(clip.timelineStart).toBe(0);
    expect(clip.timelineEnd).toBe(5);
  });

  it("rejects invalid transform values", () => {
    expect(() =>
      applyEdit(timelineWithClip(), { type: "transform", id: "clip-1", patch: { opacity: 2 } }, [
        asset,
      ]),
    ).toThrow("opacity");
    expect(() =>
      applyEdit(timelineWithClip(), { type: "transform", id: "clip-1", patch: { scale: 0 } }, [
        asset,
      ]),
    ).toThrow("scale");
  });
});

describe("candidate clip append", () => {
  it("appends reviewed ranges in source order without changing existing content", () => {
    const original = timelineWithClip();
    original.hook.enabled = true;
    original.captions.enabled = false;
    const before = structuredClone(original);
    const result = applyEdit(
      original,
      {
        type: "appendCandidates",
        mediaId: asset.id,
        ranges: [
          { start: 12, end: 15, label: "Later thought" },
          { start: 6, end: 9, label: "Earlier thought" },
        ],
      },
      [asset],
    );
    expect(original).toEqual(before);
    expect(result.tracks[0].clips[0]).toEqual(before.tracks[0].clips[0]);
    expect(result.hook).toEqual(before.hook);
    expect(result.captions).toEqual(before.captions);
    expect(
      result.tracks[0].clips
        .slice(1)
        .map((clip) => [clip.label, clip.sourceStart, clip.timelineStart, clip.timelineEnd]),
    ).toEqual([
      ["Earlier thought", 6, 5, 8],
      ["Later thought", 12, 8, 11],
    ]);
    expect(result.duration).toBe(11);
  });

  it("creates an enabled video track when existing video tracks are locked or disabled", () => {
    const original = timelineWithClip();
    original.tracks[0].locked = true;
    const disabled = createTrack("video", "Hidden video");
    disabled.enabled = false;
    original.tracks.push(disabled);
    const result = applyEdit(
      original,
      {
        type: "appendCandidates",
        mediaId: asset.id,
        ranges: [{ start: 6, end: 9, label: "Candidate" }],
      },
      [asset],
    );
    expect(result.tracks.slice(0, 3)).toEqual(original.tracks);
    expect(result.tracks[3]).toMatchObject({ kind: "video", enabled: true, locked: false });
    expect(result.tracks[3].clips[0].timelineStart).toBe(5);
  });

  it("rounds inward at a fractional media end and appends after all tracks", () => {
    const original = timelineWithClip();
    original.tracks[1].clips = [
      { ...original.tracks[0].clips[0], id: "audio-clip", sourceEnd: 10.01, timelineEnd: 10.01 },
    ];
    original.duration = 10.01;
    const source = { ...asset, durationSec: 19.999 };
    const result = applyEdit(
      original,
      {
        type: "appendCandidates",
        mediaId: source.id,
        ranges: [{ start: 18.001, end: source.durationSec, label: "Final words" }],
      },
      [source],
    );
    const clip = result.tracks[0].clips[1];
    expect(clip.sourceStart).toBeGreaterThanOrEqual(18.001);
    expect(clip.sourceEnd).toBeLessThanOrEqual(source.durationSec);
    expect(clip.timelineStart).toBeGreaterThanOrEqual(10.01);
    expect(clip.sourceStart * 30).toBeCloseTo(Math.round(clip.sourceStart * 30));
    expect(clip.sourceEnd * 30).toBeCloseTo(Math.round(clip.sourceEnd * 30));
    expect(clip.timelineEnd - clip.timelineStart).toBeCloseTo(clip.sourceEnd - clip.sourceStart);
  });

  it.each([
    [{ start: -1, end: 5, label: "Negative" }],
    [{ start: 5, end: 21, label: "Beyond media" }],
    [{ start: 5, end: 5, label: "Empty" }],
    [{ start: NaN, end: 5, label: "Not finite" }],
    [{ start: 5.001, end: 5.01, label: "No complete frame" }],
    [{ start: 5, end: 6, label: "a".repeat(513) }],
  ])("rejects an invalid candidate atomically: %j", (range) => {
    const original = timelineWithClip();
    const before = structuredClone(original);
    expect(() =>
      applyEdit(
        original,
        {
          type: "appendCandidates",
          mediaId: asset.id,
          ranges: [{ start: 2, end: 3, label: "Valid" }, range],
        },
        [asset],
      ),
    ).toThrow();
    expect(original).toEqual(before);
  });

  it("rejects unavailable media, excessive batch size, and exhausted track capacity", () => {
    const original = timelineWithClip();
    const range = { start: 6, end: 9, label: "Candidate" };
    const edit = { type: "appendCandidates" as const, mediaId: asset.id, ranges: [range] };
    expect(() => applyEdit(original, edit, [])).toThrow("available video");
    expect(() => applyEdit(original, edit, [{ ...asset, hasAudio: false }])).toThrow("with audio");
    expect(() => applyEdit(original, { ...edit, ranges: [] }, [asset])).toThrow("1 and 50");
    expect(() =>
      applyEdit(original, { ...edit, ranges: Array.from({ length: 51 }, () => range) }, [asset]),
    ).toThrow("1 and 50");
    original.tracks[0].locked = true;
    while (original.tracks.length < 64) original.tracks.push(createTrack("audio", "Audio"));
    const before = structuredClone(original);
    expect(() => applyEdit(original, edit, [asset])).toThrow("unlocked video track");
    expect(original).toEqual(before);
  });
});

describe("clip effect edits", () => {
  function timelineWithEffect() {
    const timeline = timelineWithClip();
    const clip = timeline.tracks[0].clips[0];
    clip.sourceStart = 5;
    clip.sourceEnd = 10;
    return applyEdit(
      timeline,
      { type: "effects", id: clip.id, effects: [createEffect("punchZoom", 5, 5)] },
      [asset],
    );
  }

  it("loads old clips with an empty independent effect stack", () => {
    const original = timelineWithClip();
    const legacy = JSON.parse(JSON.stringify(original));
    delete legacy.tracks[0].clips[0].effects;
    const loaded = deserializeTimeline(JSON.stringify(legacy));
    expect(loaded.tracks[0].clips[0].effects).toEqual([]);
    expect(serializeTimeline(loaded)).toBe(serializeTimeline(original));
    const added = applyEdit(
      original,
      {
        type: "add",
        trackId: original.tracks[0].id,
        asset,
        start: 5,
        sourceStart: 0,
        sourceEnd: 2,
      },
      [asset],
    );
    expect(added.tracks[0].clips[1].effects).toEqual([]);
    expect(added.tracks[0].clips[1].effects).not.toBe(added.tracks[0].clips[0].effects);
  });

  it("adds, reorders, disables and removes effects without mutating the caller", () => {
    const original = timelineWithClip();
    const zoom = createEffect("zoom");
    const blur = createEffect("blur");
    const effects = [blur, { ...zoom, enabled: false }];
    const changed = applyEdit(original, { type: "effects", id: "clip-1", effects }, [asset]);
    expect(changed.tracks[0].clips[0].effects).toEqual(effects);
    effects[0].params.radius = 20;
    expect(changed.tracks[0].clips[0].effects[0].params.radius).toBe(6);
    expect(original.tracks[0].clips[0].effects).toEqual([]);
    const reordered = applyEdit(changed, { type: "effects", id: "clip-1", effects: [zoom, blur] }, [
      asset,
    ]);
    expect(reordered.tracks[0].clips[0].effects.map((effect) => effect.id)).toEqual([
      zoom.id,
      blur.id,
    ]);
    expect(
      applyEdit(reordered, { type: "effects", id: "clip-1", effects: [] }, [asset]).tracks[0]
        .clips[0].effects,
    ).toEqual([]);
  });

  it("respects locked tracks and rejects invalid parameters without changing the timeline", () => {
    const timeline = timelineWithClip();
    const invalid = createEffect("blur");
    invalid.params.radius = 41;
    expect(() =>
      applyEdit(timeline, { type: "effects", id: "clip-1", effects: [invalid] }, [asset]),
    ).toThrow("Radius");
    expect(timeline.tracks[0].clips[0].effects).toEqual([]);
    timeline.tracks[0].locked = true;
    expect(() =>
      applyEdit(timeline, { type: "effects", id: "clip-1", effects: [createEffect("blur")] }, [
        asset,
      ]),
    ).toThrow("Unlock");
  });

  it("allows effects only on video tracks and prevents moving them to audio", () => {
    const timeline = timelineWithEffect();
    const audioId = timeline.tracks[1].id;
    expect(() =>
      applyEdit(timeline, { type: "move", id: "clip-1", trackId: audioId, at: 0 }, [asset]),
    ).toThrow("effects");
    const empty = applyEdit(timeline, { type: "effects", id: "clip-1", effects: [] }, [asset]);
    const audio = applyEdit(empty, { type: "move", id: "clip-1", trackId: audioId, at: 0 }, [
      asset,
    ]);
    expect(() =>
      applyEdit(
        audio,
        { type: "effects", id: "clip-1", effects: [{ ...createEffect("blur"), enabled: false }] },
        [asset],
      ),
    ).toThrow("video");
    audio.tracks[1].clips[0].effects = [createEffect("blur")];
    expect(() => serializeTimeline(audio)).toThrow("video");
  });

  it("preserves the curve across a split without restarting the punch", () => {
    const original = timelineWithEffect();
    const split = applyEdit(original, { type: "split", ids: ["clip-1"], at: 0.3 }, [asset]);
    const [left, right] = split.tracks[0].clips;
    expect(left.sourceEnd).toBe(5.3);
    expect(right.sourceStart).toBe(5.3);
    expect(right.effects).toEqual(left.effects);
    expect(right.effects).not.toBe(left.effects);
    expect(evaluateEffects(left.effects, left.sourceEnd)).toEqual(
      evaluateEffects(right.effects, right.sourceStart),
    );
    expect(evaluateEffects(right.effects, right.sourceStart)[0].params.scale).toBeCloseTo(1.2);
    expect(evaluateEffects(right.effects, right.sourceStart + 0.3)[0].params.scale).toBe(1);
    expect(deserializeTimeline(serializeTimeline(split))).toEqual(split);
  });

  it("keeps source anchoring after trim, move and duplicate", () => {
    const original = timelineWithEffect();
    const originalEffects = original.tracks[0].clips[0].effects;
    const trimmed = applyEdit(original, { type: "trim", id: "clip-1", edge: "start", at: 0.2 }, [
      asset,
    ]);
    const moved = applyEdit(
      trimmed,
      { type: "move", id: "clip-1", trackId: trimmed.tracks[0].id, at: 2 },
      [asset],
    );
    const duplicated = applyEdit(moved, { type: "duplicate", ids: ["clip-1"] }, [asset]);
    const [first, copy] = duplicated.tracks[0].clips;
    expect(first.sourceStart).toBe(5.2);
    expect(first.timelineStart).toBe(2);
    expect(copy.sourceStart).toBe(first.sourceStart);
    expect(copy.effects).toEqual(originalEffects);
    expect(copy.effects[0]).not.toBe(first.effects[0]);
    expect(evaluateEffects(first.effects, first.sourceStart)[0].params.scale).toBeCloseTo(1.2);
    expect(evaluateEffects(copy.effects, copy.sourceStart)).toEqual(
      evaluateEffects(originalEffects, 5.2),
    );
  });
});
