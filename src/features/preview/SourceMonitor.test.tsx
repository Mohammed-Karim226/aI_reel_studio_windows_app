import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaAsset } from "@/domain/media";
import { useTimelineStore } from "@/stores/timelineStore";
import { useSourcePreviewStore } from "@/stores/sourcePreviewStore";
import { SourceMonitor } from "./SourceMonitor";

const asset: MediaAsset = {
  id: "source",
  originalPath: "C:\\source.mp4",
  fileName: "source.mp4",
  kind: "video",
  container: "mp4",
  sizeBytes: 100,
  durationSec: 60,
  hasVideo: true,
  hasAudio: true,
  video: null,
  audio: null,
  importedAt: "2026-09-25",
  derivatives: [],
};
const previewRange = { id: "preview", mediaId: asset.id, start: 10.25, end: 15.75 };
const pause = vi.fn();
const play = vi.fn(async () => {});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  useTimelineStore.getState().reset();
  pause.mockClear();
  play.mockClear();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play);
});

describe("candidate source preview", () => {
  it("checks the end between media timeupdate events and cleans up pending frames", () => {
    let onFrame: FrameRequestCallback = () => {};
    const request = vi.fn((callback: FrameRequestCallback) => {
      onFrame = callback;
      return 42;
    });
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", request);
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const { container, unmount } = render(
      <SourceMonitor asset={asset} src="source.mp4" previewRange={previewRange} />,
    );
    const video = container.querySelector("video")!;
    video.currentTime = 15.7;
    fireEvent.play(video);
    expect(request).toHaveBeenCalledOnce();
    video.currentTime = 15.77;
    act(() => onFrame(0));
    expect(pause).toHaveBeenCalledOnce();
    expect(video.currentTime).toBe(previewRange.end);
    fireEvent.play(video);
    unmount();
    expect(cancel).toHaveBeenCalledWith(42);
  });
  it("seeks to the reviewed start, stops at its end, and replays from its start", () => {
    const { container } = render(
      <SourceMonitor asset={asset} src="source.mp4" previewRange={previewRange} />,
    );
    const video = container.querySelector("video")!;
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(10.25);
    expect(screen.getByRole("spinbutton", { name: "Source in" })).toHaveValue(10.25);
    expect(screen.getByRole("spinbutton", { name: "Source out" })).toHaveValue(15.75);
    video.currentTime = 16;
    fireEvent.timeUpdate(video);
    expect(pause).toHaveBeenCalled();
    expect(video.currentTime).toBe(15.75);
    fireEvent.click(screen.getByRole("button", { name: "Play candidate" }));
    expect(video.currentTime).toBe(10.25);
    expect(play).toHaveBeenCalledOnce();
  });

  it("keeps seeking inside the candidate and lets the user exit preview", () => {
    useSourcePreviewStore.setState({ range: previewRange });
    const { container } = render(
      <SourceMonitor asset={asset} src="source.mp4" previewRange={previewRange} />,
    );
    const video = container.querySelector("video")!;
    video.currentTime = 2;
    fireEvent.seeking(video);
    expect(video.currentTime).toBe(10.25);
    fireEvent.click(screen.getByRole("button", { name: "Exit candidate preview" }));
    expect(useSourcePreviewStore.getState().range).toBeNull();
  });

  it("preserves unrestricted playback for the normal source monitor", () => {
    const { container } = render(<SourceMonitor asset={asset} src="source.mp4" />);
    const video = container.querySelector("video")!;
    video.currentTime = 40;
    fireEvent.timeUpdate(video);
    expect(video.currentTime).toBe(40);
    expect(pause).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Play candidate" })).not.toBeInTheDocument();
  });
});
