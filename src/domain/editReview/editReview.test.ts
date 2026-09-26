import { describe, expect, it } from "vitest";
import { createEffect, evaluateEffects } from "@/domain/effects";
import { createHookLayer } from "@/domain/hook";
import { mediaAssetSchema } from "@/domain/media";
import { safeZones } from "@/domain/safeZones";
import { applyEdit } from "@/domain/timeline/edit";
import {
  createTimeline,
  createTrack,
  defaultTransform,
  deserializeTimeline,
  serializeTimeline,
  type Timeline,
  type TimelineClip,
} from "@/domain/timeline/model";
import { analyzeReel } from "./analyze";
import { suggestionEdit } from "./edits";
import { reviewSuggestionSchema, type ReviewSuggestion } from "./model";

const asset = mediaAssetSchema.parse({
  id: "media-1",
  originalPath: "C:\\media\\podcast.mp4",
  fileName: "podcast.mp4",
  kind: "video",
  container: "mp4",
  sizeBytes: 100,
  durationSec: 1000,
  hasVideo: true,
  hasAudio: true,
  video: null,
  audio: null,
  importedAt: "2026-09-26T00:00:00Z",
  derivatives: [],
});

function clip(id = "clip-1", start = 0, end = 20): TimelineClip {
  return {
    id,
    sourceMediaId: asset.id,
    label: "Podcast",
    sourceStart: 90,
    sourceEnd: 90 + end - start,
    timelineStart: start,
    timelineEnd: end,
    speed: 1,
    enabled: true,
    transform: { ...defaultTransform },
    effects: [],
  };
}

function reel(): Timeline {
  const timeline = createTimeline({ width: 1080, height: 1920, fps: 30 });
  timeline.duration = 20;
  timeline.tracks[0].clips = [clip()];
  return timeline;
}

function withCaptions(timeline = reel()): Timeline {
  timeline.captions.segments = [
    {
      id: "caption-1",
      start: 0,
      end: 5,
      words: [
        { text: "لماذا", start: 0, end: 1, emphasis: false },
        { text: "نتعلم", start: 1, end: 2, emphasis: false },
        { text: "كل", start: 2, end: 3, emphasis: false },
        { text: "يوم؟", start: 3, end: 5, emphasis: false },
      ],
    },
  ];
  return timeline;
}

function finding(timeline: Timeline, type: NonNullable<ReviewSuggestion["action"]>["type"]) {
  const result = analyzeReel(timeline, "tiktok").find((item) => item.action?.type === type);
  if (!result) throw new Error(`Missing ${type} test suggestion`);
  return result;
}

describe("timeline edit review analysis", () => {
  it("returns no invented findings for an empty edit and rejects unsupported inputs", () => {
    expect(analyzeReel(createTimeline({ width: 1080, height: 1920, fps: 30 }), "tiktok")).toEqual(
      [],
    );
    expect(() => analyzeReel({ ...reel(), duration: Infinity }, "tiktok")).toThrow();
    expect(() => analyzeReel(reel(), "unknown" as "tiktok")).toThrow(/supported/);
    expect(() => analyzeReel(reel(), "toString" as "tiktok")).toThrow(/supported/);
  });

  it("drafts hook text only from opening caption words, retaining Arabic", () => {
    expect(finding(reel(), "openingHook").action).toEqual({ type: "openingHook", text: "" });
    expect(finding(withCaptions(), "openingHook").action).toEqual({
      type: "openingHook",
      text: "لماذا نتعلم كل",
    });
    const timeline = withCaptions();
    timeline.captions.segments[0].words[0].text = "😀".repeat(200);
    const action = finding(timeline, "openingHook").action;
    expect(action?.type).toBe("openingHook");
    if (action?.type === "openingHook") {
      expect(action.text.length).toBeLessThanOrEqual(160);
      expect(new TextEncoder().encode(action.text).length).toBeLessThanOrEqual(500);
      expect(action.text.endsWith("\ud83d")).toBe(false);
    }
  });

  it("treats disabled existing hooks as manual work and recognizes an active opening layer", () => {
    const timeline = reel();
    const layer = createHookLayer();
    layer.text = "Existing headline";
    timeline.hook.layers = [layer];
    expect(analyzeReel(timeline, "tiktok").some((item) => item.category === "hook")).toBe(false);
    timeline.hook.enabled = false;
    expect(
      analyzeReel(timeline, "tiktok").find((item) => item.category === "hook")?.action,
    ).toBeNull();
  });

  it("counts hook opacity only inside the opening playback range", () => {
    const timeline = reel();
    const layer = createHookLayer();
    layer.end = 5;
    layer.transform.opacity = 1;
    layer.animations = [
      {
        property: "opacity",
        keyframes: [
          { time: 0, value: 0, easing: "linear" },
          { time: 3, value: 0, easing: "linear" },
          { time: 5, value: 1, easing: "linear" },
        ],
      },
    ];
    timeline.hook.duration = 5;
    timeline.hook.layers = [layer];
    expect(analyzeReel(timeline, "tiktok").some((item) => item.category === "hook")).toBe(true);
    layer.animations[0].keyframes[1].value = 1;
    expect(analyzeReel(timeline, "tiktok").some((item) => item.category === "hook")).toBe(false);
  });

  it("does not offer a font increase when the caption font is already at its limit", () => {
    const timeline = withCaptions();
    timeline.width = 8000;
    timeline.captions.style.fontSize = 200;
    expect(analyzeReel(timeline, "tiktok").some((item) => item.id === "caption-size")).toBe(false);
  });

  it("uses visible video ranges, not covered or disabled tracks, for pacing and zoom", () => {
    const timeline = reel();
    timeline.tracks[0].clips = [clip("top", 3, 6)];
    const underneath = createTrack("video", "Underneath");
    underneath.clips = [clip("underneath")];
    timeline.tracks.push(underneath);
    const zoom = finding(timeline, "addZoom");
    expect(zoom.action).toMatchObject({ clipId: "underneath", at: 9 });
    expect(analyzeReel(timeline, "tiktok").some((item) => item.id.startsWith("video-gap"))).toBe(
      false,
    );
    underneath.enabled = false;
    expect(
      analyzeReel(timeline, "tiktok")
        .filter((item) => item.id.startsWith("video-gap"))
        .map((item) => [item.start, item.end]),
    ).toEqual([
      [0, 3],
      [6, 20],
    ]);
  });

  it("keeps gap and pacing findings manual and does not claim source silence or static imagery", () => {
    const timeline = reel();
    timeline.tracks[0].clips[0] = clip("late", 2, 20);
    const suggestions = analyzeReel(timeline, "tiktok");
    expect(suggestions.find((item) => item.category === "weakSection")).toMatchObject({
      start: 0,
      end: 2,
      action: null,
    });
    expect(suggestions.find((item) => item.category === "pacing")?.action).toBeNull();
    expect(suggestions.map((item) => item.title).join(" ")).not.toMatch(
      /silent|static imagery|dead air/i,
    );
  });

  it("does not offer another zoom for locked, transparent, covered, or already zoomed clips", () => {
    for (const change of [
      (timeline: Timeline) => {
        timeline.tracks[0].locked = true;
      },
      (timeline: Timeline) => {
        timeline.tracks[0].clips[0].transform.opacity = 0;
      },
      (timeline: Timeline) => {
        timeline.tracks[0].clips[0].effects = [createEffect("zoom")];
      },
      (timeline: Timeline) => {
        timeline.tracks[0].clips[0].effects = Array.from({ length: 16 }, () =>
          createEffect("color"),
        );
      },
    ]) {
      const timeline = reel();
      change(timeline);
      expect(analyzeReel(timeline, "tiktok").some((item) => item.action?.type === "addZoom")).toBe(
        false,
      );
    }
  });

  it("fits a caption estimate inside each shared platform guide and preserves word timing", () => {
    for (const platform of Object.keys(safeZones) as Array<keyof typeof safeZones>) {
      const timeline = withCaptions();
      timeline.captions.style = { ...timeline.captions.style, x: 98, y: 99, maxWidth: 100 };
      const suggestion = analyzeReel(timeline, platform).find(
        (item) => item.category === "safeZone",
      );
      expect(suggestion?.action?.type).toBe("captionStyle");
      const edit = suggestionEdit(timeline, suggestion!);
      expect(edit?.type).toBe("captions");
      if (edit?.type === "captions") {
        const style = edit.captions.style;
        const zone = safeZones[platform];
        expect(style.x - style.maxWidth / 2).toBeGreaterThanOrEqual(zone.left);
        expect(style.x + style.maxWidth / 2).toBeLessThanOrEqual(100 - zone.right);
        expect(style.y).toBeLessThan(100 - zone.bottom);
        expect(style.y).toBeGreaterThan(zone.top);
        expect(edit.captions.segments).toEqual(timeline.captions.segments);
      }
    }
  });

  it("checks animated hook anchors at intermediate keyframes and preserves manual control", () => {
    const timeline = reel();
    const layer = createHookLayer();
    layer.animations = [
      {
        property: "x",
        keyframes: [
          { time: 0, value: 0, easing: "linear" },
          { time: 0.7, value: 49, easing: "linear" },
          { time: 1.5, value: 0, easing: "linear" },
        ],
      },
    ];
    timeline.hook.layers = [layer];
    const warning = analyzeReel(timeline, "tiktok").find((item) =>
      item.id.startsWith("hook-safe-zone"),
    );
    expect(warning).toMatchObject({ category: "safeZone", start: 0, end: 1.5, action: null });
  });

  it("bounds findings and produces unique, schema-valid identifiers", () => {
    const timeline = reel();
    timeline.tracks[0].clips = Array.from({ length: 70 }, (_, index) =>
      clip(`clip-${index}`, index * 20, (index + 1) * 20),
    );
    timeline.duration = 1400;
    const findings = analyzeReel(timeline, "tiktok");
    expect(findings).toHaveLength(50);
    expect(new Set(findings.map((item) => item.id)).size).toBe(50);
    findings.forEach((item) => expect(reviewSuggestionSchema.safeParse(item).success).toBe(true));
  });
});

describe("validated review edits", () => {
  it("rejects unknown commands, nested fields, invalid intervals, and mismatched action categories", () => {
    const suggestion = finding(reel(), "addZoom");
    for (const invalid of [
      { ...suggestion, command: "execute" },
      { ...suggestion, start: NaN },
      { ...suggestion, end: suggestion.start },
      { ...suggestion, category: "captions" },
      { ...suggestion, action: { ...suggestion.action, duration: Infinity } },
      { ...suggestion, action: { ...suggestion.action, sourcePath: "outside" } },
      { ...suggestion, action: { type: "run", code: "arbitrary" } },
      { ...suggestion, category: "captions", action: { type: "captionStyle", patch: {} } },
      {
        ...suggestion,
        category: "captions",
        action: { type: "captionStyle", patch: { color: "red" } },
      },
    ])
      expect(reviewSuggestionSchema.safeParse(invalid).success).toBe(false);
  });

  it("adds an authored hook without replacing existing layers and survives persistence", () => {
    const timeline = reel();
    const existing = createHookLayer("secondary");
    existing.start = 5;
    existing.end = 6;
    timeline.hook.layers = [existing];
    timeline.hook.duration = 6;
    const before = serializeTimeline(timeline);
    const suggestion = finding(timeline, "openingHook");
    expect(() => suggestionEdit(timeline, suggestion)).toThrow(/Write the opening hook/);
    const edit = suggestionEdit(timeline, suggestion, "Why does this happen?");
    expect(edit?.type).toBe("setHook");
    const after = applyEdit(timeline, edit!, [asset]);
    expect(after.hook.layers[0]).toEqual(existing);
    expect(after.hook.layers[1]).toMatchObject({ text: "Why does this happen?", start: 0, end: 2 });
    expect(after.hook.duration).toBe(6);
    expect(serializeTimeline(timeline)).toBe(before);
    expect(deserializeTimeline(serializeTimeline(after))).toEqual(after);
  });

  it("fits a new hook into very short reels and enforces native text limits", () => {
    const timeline = reel();
    timeline.tracks[0].clips[0] = clip("short", 0, 0.2);
    timeline.duration = 0.2;
    const suggestion = finding(timeline, "openingHook");
    const edit = suggestionEdit(timeline, suggestion, "A real title");
    if (edit?.type !== "setHook") throw new Error("Expected hook edit");
    expect(edit.hook.layers[0].end).toBe(0.2);
    expect(edit.hook.layers[0].animations).toEqual([]);
    expect(() => suggestionEdit(timeline, suggestion, "字".repeat(161))).toThrow();
  });

  it("adds source-timed zoom keyframes, preserves effects, and returns to original framing", () => {
    const timeline = reel();
    const color = createEffect("color");
    timeline.tracks[0].clips[0].effects = [color];
    const suggestion = finding(timeline, "addZoom");
    const edit = suggestionEdit(timeline, suggestion);
    if (edit?.type !== "effects") throw new Error("Expected effects edit");
    expect(edit.effects[0]).toEqual(color);
    const zoom = edit.effects[1];
    expect(zoom.animations[0].keyframes[0].time).toBe(93);
    expect(zoom.animations[0].keyframes.at(-1)?.time).toBeCloseTo(94.2);
    expect(evaluateEffects([zoom], 92)[0].params.scale).toBe(1);
    expect(evaluateEffects([zoom], 93.5)[0].params.scale).toBeCloseTo(1.12);
    expect(evaluateEffects([zoom], 95)[0].params.scale).toBe(1);
    const after = applyEdit(timeline, edit, [asset]);
    expect(deserializeTimeline(serializeTimeline(after))).toEqual(after);
    expect(() => suggestionEdit(after, suggestion)).toThrow(/already has a zoom/);
  });

  it("rejects zooms if a clip is locked or another clip covers any part of the proposed interval", () => {
    const timeline = reel();
    const suggestion = finding(timeline, "addZoom");
    timeline.tracks[0].locked = true;
    expect(() => suggestionEdit(timeline, suggestion)).toThrow(/Unlock/);
    timeline.tracks[0].locked = false;
    const overlay = createTrack("video", "Overlay");
    overlay.clips = [clip("cover", 3.2, 3.4)];
    timeline.tracks.unshift(overlay);
    expect(() => suggestionEdit(timeline, suggestion)).toThrow(/covers this zoom/);
  });

  it("changes caption style without changing text, timestamps, or unrelated composition", () => {
    const timeline = withCaptions();
    const suggestion = analyzeReel(timeline, "tiktok").find(
      (item) => item.id === "caption-emphasis",
    )!;
    const edit = suggestionEdit(timeline, suggestion);
    const after = applyEdit(timeline, edit!, [asset]);
    expect(after.captions.style).toMatchObject({ animation: "pop", highlighting: "word" });
    expect(after.captions.segments).toEqual(timeline.captions.segments);
    expect(after.tracks).toEqual(timeline.tracks);
    expect(after.hook).toEqual(timeline.hook);
    expect(timeline.captions.style.highlighting).toBe("none");
  });

  it("returns no edit for manual findings and rejects out-of-timeline proposals", () => {
    const timeline = reel();
    const manual = analyzeReel(timeline, "tiktok").find((item) => item.category === "pacing")!;
    expect(suggestionEdit(timeline, manual)).toBeNull();
    expect(() => suggestionEdit(timeline, { ...manual, end: timeline.duration + 1 })).toThrow(
      /no longer fits/,
    );
  });
});
