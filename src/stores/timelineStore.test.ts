import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCaptions, type CaptionTrack } from "@/domain/captions";
import { createEffect, evaluateEffects } from "@/domain/effects";
import type { MediaAsset } from "@/domain/media";
import { createTimeline, deserializeTimeline, serializeTimeline } from "@/domain/timeline/model";
import type { ProjectInfo } from "@/domain/projects";
import { useMediaStore } from "./mediaStore";

const { loadMock, saveMock } = vi.hoisted(() => ({ loadMock: vi.fn(), saveMock: vi.fn() }));
vi.mock("@/infrastructure/tauri/timeline", () => ({
  loadTimeline: loadMock,
  saveTimeline: saveMock,
}));

import { isTimelineDirty, useTimelineStore } from "./timelineStore";

const project: ProjectInfo = {
  id: "caption-project",
  name: "Caption test",
  rootPath: "C:\\projects\\captions",
  createdAt: "2026-09-23T00:00:00Z",
  format: { width: 1080, height: 1920, fps: 30 },
  mediaCount: 0,
};

function captions(): CaptionTrack {
  return {
    ...structuredClone(defaultCaptions),
    style: { ...defaultCaptions.style, direction: "rtl", highlighting: "word" },
    segments: [
      {
        id: "caption-1",
        start: 1,
        end: 2,
        words: [
          { text: "مرحبا", start: 1, end: 1.4, emphasis: false },
          { text: "Studio", start: 1.5, end: 2, emphasis: true },
        ],
      },
    ],
  };
}

beforeEach(() => {
  useTimelineStore.getState().reset();
  useMediaStore.setState({ assets: [] });
  loadMock.mockReset().mockResolvedValue(null);
  saveMock.mockReset().mockResolvedValue(undefined);
});

describe("clip effect history and native persistence", () => {
  const asset: MediaAsset = {
    id: "effect-media",
    originalPath: "C:\\media\\effect.mp4",
    fileName: "effect.mp4",
    kind: "video",
    container: "mp4",
    sizeBytes: 100,
    durationSec: 20,
    hasVideo: true,
    hasAudio: false,
    video: null,
    audio: null,
    importedAt: "2026-09-24T00:00:00Z",
    derivatives: [],
  };

  async function loadClip() {
    const timeline = createTimeline(project.format);
    timeline.tracks[0].clips = [
      {
        id: "effect-clip",
        sourceMediaId: asset.id,
        label: asset.fileName,
        sourceStart: 3,
        sourceEnd: 5,
        timelineStart: 0,
        timelineEnd: 2,
        speed: 1,
        enabled: true,
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        effects: [],
      },
    ];
    timeline.duration = 2;
    useMediaStore.setState({ assets: [asset] });
    loadMock.mockResolvedValue(timeline);
    await useTimelineStore.getState().load(project);
  }

  it("undoes, redoes, saves and reopens ordered effects and source keyframes", async () => {
    await loadClip();
    const effects = [createEffect("punchZoom", 3, 2), { ...createEffect("blur"), enabled: false }];
    const original = useTimelineStore.getState().timeline;
    useTimelineStore.getState().edit({ type: "effects", id: "effect-clip", effects });
    expect(isTimelineDirty(useTimelineStore.getState())).toBe(true);
    expect(useTimelineStore.getState().timeline?.tracks[0].clips[0].effects).toEqual(effects);

    useTimelineStore.getState().undo();
    expect(useTimelineStore.getState().timeline).toBe(original);
    expect(isTimelineDirty(useTimelineStore.getState())).toBe(false);
    useTimelineStore.getState().redo();
    expect(useTimelineStore.getState().timeline?.tracks[0].clips[0].effects).toEqual(effects);

    expect(await useTimelineStore.getState().save()).toBe(true);
    expect(isTimelineDirty(useTimelineStore.getState())).toBe(false);
    expect(saveMock).toHaveBeenCalledWith(project.id, useTimelineStore.getState().timeline);
    const persisted = serializeTimeline(saveMock.mock.calls[0][1]);
    useTimelineStore.getState().reset();
    loadMock.mockResolvedValue(deserializeTimeline(persisted));
    await useTimelineStore.getState().load(project);
    const reopened = useTimelineStore.getState().timeline!.tracks[0].clips[0];
    expect(reopened.effects).toEqual(effects);
    expect(evaluateEffects(reopened.effects, 3.2)[0].params.scale).toBeCloseTo(1.2);
    expect(isTimelineDirty(useTimelineStore.getState())).toBe(false);
  });

  it("leaves an existing edit and undo history intact when effect validation fails", async () => {
    await loadClip();
    useTimelineStore
      .getState()
      .edit({ type: "effects", id: "effect-clip", effects: [createEffect("zoom")] });
    const before = useTimelineStore.getState().timeline;
    const history = useTimelineStore.getState().past;
    const invalid = createEffect("zoom");
    invalid.animations = [
      { property: "scale", keyframes: [{ time: 3, value: 100, easing: "linear" }] },
    ];
    useTimelineStore.getState().edit({ type: "effects", id: "effect-clip", effects: [invalid] });
    expect(useTimelineStore.getState().timeline).toBe(before);
    expect(useTimelineStore.getState().past).toBe(history);
    expect(useTimelineStore.getState().error).toContain("Scale keyframes");
    useTimelineStore.getState().undo();
    expect(useTimelineStore.getState().timeline?.tracks[0].clips[0].effects).toEqual([]);
  });
});

describe("caption timeline history and persistence", () => {
  it("opens Phase 4 timelines with empty captions", () => {
    const { captions: _captions, ...legacy } = createTimeline(project.format);
    expect(deserializeTimeline(JSON.stringify(legacy)).captions).toEqual(defaultCaptions);
  });

  it("undoes, redoes, saves and reloads Arabic word timing and styles", async () => {
    await useTimelineStore.getState().load(project);
    useTimelineStore.getState().edit({ type: "captions", captions: captions() });
    expect(isTimelineDirty(useTimelineStore.getState())).toBe(true);
    expect(useTimelineStore.getState().timeline?.duration).toBe(0);

    useTimelineStore.getState().undo();
    expect(useTimelineStore.getState().timeline?.captions.segments).toHaveLength(0);
    expect(isTimelineDirty(useTimelineStore.getState())).toBe(false);
    useTimelineStore.getState().redo();
    expect(useTimelineStore.getState().timeline?.captions).toEqual(captions());

    expect(await useTimelineStore.getState().save()).toBe(true);
    expect(isTimelineDirty(useTimelineStore.getState())).toBe(false);
    expect(saveMock).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({ captions: captions() }),
    );
    const persisted = serializeTimeline(saveMock.mock.calls[0][1]);
    useTimelineStore.getState().reset();
    loadMock.mockResolvedValue(deserializeTimeline(persisted));
    await useTimelineStore.getState().load(project);
    expect(useTimelineStore.getState().timeline?.captions).toEqual(captions());
  });

  it("rejects invalid timing without changing the current edit or undo history", async () => {
    await useTimelineStore.getState().load(project);
    const invalid = captions();
    invalid.segments[0].words[1].end = 3;
    const before = useTimelineStore.getState().timeline;
    useTimelineStore.getState().edit({ type: "captions", captions: invalid });
    expect(useTimelineStore.getState().timeline).toBe(before);
    expect(useTimelineStore.getState().past).toHaveLength(0);
    expect(useTimelineStore.getState().error).toContain("inside the caption");
  });
});
