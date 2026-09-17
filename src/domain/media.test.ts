import { describe, expect, it } from "vitest";

import { derivativeOf, mediaAssetSchema, readyDerivative } from "./media";

const asset = {
  id: "m1",
  originalPath: "D:\\media\\podcast.mp4",
  fileName: "podcast.mp4",
  kind: "video",
  container: "mov,mp4",
  sizeBytes: 1000,
  durationSec: 60,
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
  audio: { codec: "aac", channels: 2, sampleRate: 48_000, bitRate: null },
  importedAt: "2026-01-01T00:00:00+00:00",
  derivatives: [
    {
      id: "d1",
      mediaAssetId: "m1",
      kind: "thumbnail",
      status: "ready",
      relativePath: "thumbnails/m1.jpg",
      params: { height: 180 },
      error: null,
      createdAt: "2026-01-01T00:00:00+00:00",
      updatedAt: "2026-01-01T00:00:00+00:00",
    },
    {
      id: "d2",
      mediaAssetId: "m1",
      kind: "proxy",
      status: "running",
      relativePath: null,
      params: { height: 720 },
      error: null,
      createdAt: "2026-01-01T00:00:00+00:00",
      updatedAt: "2026-01-01T00:00:00+00:00",
    },
  ],
};

describe("mediaAssetSchema", () => {
  it("accepts a payload produced by the backend", () => {
    const parsed = mediaAssetSchema.parse(asset);
    expect(parsed.fileName).toBe("podcast.mp4");
    expect(parsed.derivatives).toHaveLength(2);
  });

  it("rejects a payload with an unknown derivative kind", () => {
    const broken = {
      ...asset,
      derivatives: [{ ...asset.derivatives[0], kind: "hologram" }],
    };
    expect(mediaAssetSchema.safeParse(broken).success).toBe(false);
  });
});

describe("derivative helpers", () => {
  const parsed = mediaAssetSchema.parse(asset);

  it("finds a derivative by kind", () => {
    expect(derivativeOf(parsed, "thumbnail")?.id).toBe("d1");
    expect(derivativeOf(parsed, "waveform")).toBeNull();
  });

  it("only reports a derivative as usable when it is ready", () => {
    expect(readyDerivative(parsed, "thumbnail")?.id).toBe("d1");
    expect(readyDerivative(parsed, "proxy")).toBeNull();
  });
});
