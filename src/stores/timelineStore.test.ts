import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCaptions, type CaptionTrack } from "@/domain/captions";
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
