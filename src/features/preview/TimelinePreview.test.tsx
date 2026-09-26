import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHookLayer } from "@/domain/hook";
import { createTimeline, serializeTimeline, type Timeline } from "@/domain/timeline/model";
import { useEditReviewStore } from "@/stores/editReviewStore";
import { useMediaStore } from "@/stores/mediaStore";
import { isTimelineDirty, useTimelineStore } from "@/stores/timelineStore";
import { TimelinePreview } from "./TimelinePreview";

function committedTimeline(): Timeline {
  const timeline = createTimeline({ width: 1080, height: 1920, fps: 30 });
  timeline.duration = 10;
  timeline.tracks[0].clips = [
    {
      id: "clip",
      sourceMediaId: "source",
      label: "Source clip",
      sourceStart: 0,
      sourceEnd: 10,
      timelineStart: 0,
      timelineEnd: 10,
      speed: 1,
      enabled: true,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      effects: [],
    },
  ];
  const layer = createHookLayer();
  layer.text = "Saved opening";
  timeline.hook.layers = [layer];
  return timeline;
}

function preview(timeline: Timeline, start = 0, end = 3) {
  const draft = structuredClone(timeline);
  const layer = createHookLayer();
  layer.text = "Proposed opening";
  draft.hook.layers.push(layer);
  useEditReviewStore.setState({
    preview: { suggestionId: "opening-hook", timeline: draft, start, end },
  });
}

function animationClock() {
  let now = 1000;
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const request = vi.fn((callback: FrameRequestCallback) => {
    const id = ++nextId;
    frames.set(id, callback);
    return id;
  });
  const cancel = vi.fn((id: number) => {
    frames.delete(id);
  });
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", request);
  vi.stubGlobal("cancelAnimationFrame", cancel);
  return {
    frames,
    request,
    cancel,
    advance: (milliseconds: number) => {
      now += milliseconds;
      const callbacks = [...frames.values()];
      frames.clear();
      act(() => callbacks.forEach((callback) => callback(now)));
    },
  };
}

beforeEach(() => {
  useEditReviewStore.getState().reset();
  useTimelineStore.getState().reset();
  useMediaStore.getState().reset();
  const timeline = committedTimeline();
  useTimelineStore.setState({
    timeline,
    saved: serializeTimeline(timeline),
    projectId: "project",
    mode: "timeline",
    playhead: 0.5,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("edit review timeline preview", () => {
  it("renders the temporary composition and exits without changing the saved edit or history", () => {
    const before = useTimelineStore.getState();
    preview(before.timeline!);
    render(<TimelinePreview />);

    expect(screen.getByText("Saved opening")).toBeInTheDocument();
    expect(screen.getByText("Proposed opening")).toBeInTheDocument();
    expect(screen.getByText("Review preview")).toBeInTheDocument();
    expect(useTimelineStore.getState().timeline).toBe(before.timeline);
    expect(isTimelineDirty(useTimelineStore.getState())).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Exit preview" }));

    expect(screen.queryByText("Proposed opening")).not.toBeInTheDocument();
    expect(screen.getByText("Saved opening")).toBeInTheDocument();
    expect(useEditReviewStore.getState().preview).toBeNull();
    expect(useTimelineStore.getState().timeline).toBe(before.timeline);
    expect(useTimelineStore.getState().saved).toBe(before.saved);
    expect(useTimelineStore.getState().past).toBe(before.past);
    expect(useTimelineStore.getState().future).toBe(before.future);
    expect(isTimelineDirty(useTimelineStore.getState())).toBe(false);
  });

  it("bounds playback, replays the review range, and releases the bound and pending frames on exit", () => {
    const clock = animationClock();
    preview(useTimelineStore.getState().timeline!, 3.25, 4.75);
    useTimelineStore.setState({ playhead: 8 });
    const { unmount } = render(<TimelinePreview />);

    act(() => useTimelineStore.getState().togglePlayback());
    expect(useTimelineStore.getState().playhead).toBe(3.25);
    clock.advance(500);
    expect(useTimelineStore.getState().playhead).toBe(3.75);
    clock.advance(1500);
    expect(useTimelineStore.getState().playhead).toBe(4.75);
    expect(useTimelineStore.getState().playing).toBe(false);
    expect(clock.frames.size).toBe(0);

    act(() => useTimelineStore.getState().togglePlayback());
    expect(useTimelineStore.getState().playhead).toBe(3.25);
    clock.advance(250);
    expect(useTimelineStore.getState().playhead).toBe(3.5);
    expect(clock.frames.size).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Exit preview" }));
    expect(useTimelineStore.getState().playing).toBe(false);
    expect(clock.frames.size).toBe(0);
    expect(clock.cancel).toHaveBeenCalled();

    act(() => {
      useTimelineStore.getState().seek(4.5);
      useTimelineStore.getState().togglePlayback();
    });
    clock.advance(1000);
    expect(useTimelineStore.getState().playhead).toBe(5.5);
    expect(useTimelineStore.getState().playing).toBe(true);
    expect(clock.frames.size).toBe(1);
    const pendingFrame = clock.request.mock.results.at(-1)!.value as number;
    unmount();
    expect(clock.cancel).toHaveBeenLastCalledWith(pendingFrame);
    expect(clock.frames.size).toBe(0);
  });
});
