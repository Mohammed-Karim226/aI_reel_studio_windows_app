import { describe, expect, it } from "vitest";

import { mediaAssetSchema } from "@/domain/media";
import { applyEdit } from "./edit";
import { createTimeline, type Timeline } from "./model";

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
  video: { codec: "h264", width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080, fps: 30, rotation: 0, pixFmt: "yuv420p", bitRate: null },
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
  });
  timeline.duration = 5;
  return timeline;
}

describe("timeline composition edits", () => {
  it("updates a clip transform without changing its timing", () => {
    const result = applyEdit(timelineWithClip(), { type: "transform", id: "clip-1", patch: { x: 12, y: -8, scale: 1.25, rotation: 4, opacity: 0.8 } }, [asset]);
    const clip = result.tracks[0].clips[0];
    expect(clip.transform).toEqual({ x: 12, y: -8, scale: 1.25, rotation: 4, opacity: 0.8 });
    expect(clip.timelineStart).toBe(0);
    expect(clip.timelineEnd).toBe(5);
  });

  it("rejects invalid transform values", () => {
    expect(() => applyEdit(timelineWithClip(), { type: "transform", id: "clip-1", patch: { opacity: 2 } }, [asset])).toThrow("opacity");
    expect(() => applyEdit(timelineWithClip(), { type: "transform", id: "clip-1", patch: { scale: 0 } }, [asset])).toThrow("scale");
  });
});
