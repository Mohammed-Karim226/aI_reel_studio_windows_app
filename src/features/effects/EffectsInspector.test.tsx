import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { createEffect, evaluateEffects } from "@/domain/effects";
import { mediaAssetSchema } from "@/domain/media";
import { applyEdit } from "@/domain/timeline/edit";
import { createTimeline } from "@/domain/timeline/model";
import { useMediaStore } from "@/stores/mediaStore";
import { useTimelineStore } from "@/stores/timelineStore";
import { EffectsInspector } from "./EffectsInspector";

const asset = mediaAssetSchema.parse({
  id: "video1", originalPath: "C:\\video.mp4", fileName: "video.mp4", kind: "video",
  container: "mp4", sizeBytes: 100, durationSec: 30, hasVideo: true, hasAudio: false,
  video: { codec: "h264", width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080,
    fps: 30, rotation: 0, pixFmt: "yuv420p", bitRate: null },
  audio: null, importedAt: "2026-09-24", derivatives: [],
});

beforeEach(() => {
  useTimelineStore.getState().reset();
  useMediaStore.setState({ assets: [asset] });
  const initial = createTimeline({ width: 1080, height: 1920, fps: 30 });
  const timeline = applyEdit(initial, {
    type: "add", trackId: initial.tracks[0].id, asset, start: 5, sourceStart: 10, sourceEnd: 15,
  }, [asset]);
  useTimelineStore.setState({ timeline, selectedIds: [timeline.tracks[0].clips[0].id],
    selectedTrackId: timeline.tracks[0].id, playhead: 5, mode: "timeline" });
});

const clip = () => useTimelineStore.getState().timeline!.tracks[0].clips[0];
const add = (type: string) => {
  fireEvent.change(screen.getByRole("combobox", { name: "Effect type" }), { target: { value: type } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
};
const blurValue = (label: string, value: string) => {
  const field = screen.getByRole("spinbutton", { name: label });
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
};

describe("Effects inspector", () => {
  it("adds, bypasses, reorders, and removes the selected clip's effects", () => {
    render(<EffectsInspector />);
    add("zoom");
    add("blur");
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable Zoom" }));
    expect(clip().effects[0].enabled).toBe(false);
    const blur = screen.getByLabelText("Blur effect 2");
    fireEvent.click(within(blur).getByRole("button", { name: "Move effect up" }));
    expect(clip().effects.map((effect) => effect.type)).toEqual(["blur", "zoom"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove Blur" }));
    expect(clip().effects.map((effect) => effect.type)).toEqual(["zoom"]);
  });

  it("edits values with undo and rejects invalid numeric drafts", () => {
    render(<EffectsInspector />);
    add("zoom");
    blurValue("Zoom scale", "2");
    expect(clip().effects[0].params.scale).toBe(2);
    blurValue("Zoom scale", "99");
    expect(clip().effects[0].params.scale).toBe(2);
    expect(screen.getByRole("spinbutton", { name: "Zoom scale" })).toHaveValue(2);
    act(() => {
      const id = clip().id;
      useTimelineStore.getState().undo();
      useTimelineStore.getState().select(id, useTimelineStore.getState().timeline!.tracks[0].id);
    });
    expect(screen.getByRole("spinbutton", { name: "Zoom scale" })).toHaveValue(1.15);
  });

  it("sets source-anchored keyframes at the playhead and freezes the current value on clear", () => {
    render(<EffectsInspector />);
    add("zoom");
    fireEvent.click(screen.getByRole("button", { name: "Add Zoom scale keyframe" }));
    act(() => useTimelineStore.getState().seek(6));
    blurValue("Zoom scale", "2");
    expect(clip().effects[0].animations[0].keyframes.map(({ time }) => time)).toEqual([10, 11]);
    act(() => useTimelineStore.getState().seek(5.5));
    expect(evaluateEffects(clip().effects, 10.5)[0].params.scale).toBeCloseTo(1.575);
    fireEvent.click(screen.getByRole("button", { name: "Clear Zoom scale animation" }));
    expect(clip().effects[0].animations).toEqual([]);
    expect(clip().effects[0].params.scale).toBeCloseTo(1.575);
  });

  it("preserves precise curves when a displayed field blurs without an edit", () => {
    const effect = createEffect("zoom");
    effect.animations = [{ property: "scale", keyframes: [
      { time: 10, value: 1, easing: "linear" },
      { time: 13, value: 2, easing: "linear" },
    ] }];
    useTimelineStore.getState().edit({ type: "effects", id: clip().id, effects: [effect] });
    useTimelineStore.getState().seek(6);
    render(<EffectsInspector />);
    const before = structuredClone(clip().effects);
    fireEvent.blur(screen.getByRole("spinbutton", { name: "Zoom scale" }));
    expect(clip().effects).toEqual(before);
  });

  it("keeps retained keyframes and rejects duplicate keyframe times", () => {
    render(<EffectsInspector />);
    add("punchZoom");
    const before = structuredClone(clip().effects);
    blurValue("Punch Zoom scale keyframe time 10.12", "0");
    expect(clip().effects).toEqual(before);
    expect(useTimelineStore.getState().error).toBeTruthy();
    act(() => useTimelineStore.getState().edit({ type: "trim", id: clip().id, edge: "start", at: 5.3 }));
    expect(screen.getAllByText(/outside trim/).length).toBeGreaterThan(0);
    expect(clip().effects).toEqual(before);
  });

  it("requires a single video clip and respects the track lock", () => {
    useTimelineStore.setState({ selectedIds: [] });
    render(<EffectsInspector />);
    expect(screen.getByText(/Select one video or image clip/)).toBeInTheDocument();
    act(() => {
      const timeline = structuredClone(useTimelineStore.getState().timeline!);
      timeline.tracks[0].locked = true;
      useTimelineStore.setState({ timeline, selectedIds: [clip().id] });
    });
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    expect(screen.getByText(/Unlock this track/)).toBeInTheDocument();
  });
});
