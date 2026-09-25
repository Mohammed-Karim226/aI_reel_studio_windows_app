import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaAsset } from "@/domain/media";
import { createTimeline } from "@/domain/timeline/model";
import { defaultTranscriptionSetup } from "@/domain/transcriptionSetup";
import { useAiCutStore } from "@/stores/aiCutStore";
import { useMediaStore } from "@/stores/mediaStore";
import { useSourcePreviewStore } from "@/stores/sourcePreviewStore";
import { useTimelineStore } from "@/stores/timelineStore";
import { useTranscriptionStore } from "@/stores/transcriptionStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { AiCutPanel } from "./AiCutPanel";

const { transcribeMock } = vi.hoisted(() => ({ transcribeMock: vi.fn() }));
vi.mock("@/infrastructure/tauri/captions", () => ({
  transcribeMedia: transcribeMock,
  getTranscriptionSetup: vi.fn(),
  saveTranscriptionSetup: vi.fn(),
  checkTranscriptionSetup: vi.fn(),
}));
vi.mock("@/features/captions/TranscriptionSetupPanel", () => ({
  TranscriptionSetupPanel: () => <p>Local speech setup controls</p>,
}));

const asset: MediaAsset = {
  id: "video",
  fileName: "interview.mp4",
  originalPath: "C:\\media\\interview.mp4",
  kind: "video",
  container: "mp4",
  sizeBytes: 1000,
  durationSec: 90,
  hasVideo: true,
  hasAudio: true,
  video: null,
  audio: null,
  importedAt: "2026-09-25",
  derivatives: [],
};

beforeEach(() => {
  useAiCutStore.getState().reset();
  useTimelineStore.getState().reset();
  useSourcePreviewStore.getState().clear();
  const format = { width: 1080, height: 1920, fps: 30 };
  useWorkspaceStore.setState({
    status: "editor",
    busy: false,
    closing: false,
    project: {
      id: "project",
      name: "Interview",
      rootPath: "C:\\projects\\interview",
      createdAt: "2026-09-25",
      mediaCount: 1,
      format,
    },
  });
  useTimelineStore.setState({
    projectId: "project",
    timeline: createTimeline(format),
    loading: false,
  });
  useMediaStore.setState({ assets: [asset], selectedId: asset.id, loading: false });
  useTranscriptionStore.setState({
    loaded: true,
    loading: false,
    checking: false,
    setup: { ...defaultTranscriptionSetup, modelPath: "C:\\models\\small" },
    readiness: {
      ready: true,
      pythonVersion: "3.13",
      providerVersion: "1.2",
      modelReady: true,
      ffmpegReady: true,
      multilingual: true,
      issues: [],
    },
  });
  const words = "Why learn this? Here are practical tips for better videos.".split(" ");
  transcribeMock.mockReset().mockResolvedValue({
    language: "en",
    words: Array.from({ length: 100 }, (_, index) => ({
      text: words[index % words.length],
      start: index * 0.5,
      end: index * 0.5 + 0.45,
      emphasis: false,
    })),
  });
});

describe("AI Cut panel", () => {
  it("requires speech readiness and a valid source range before requesting transcription", () => {
    useTranscriptionStore.setState({ readiness: null });
    render(<AiCutPanel />);
    expect(screen.getByRole("button", { name: "Find candidate clips" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Speech setup" }));
    expect(screen.getByText("Local speech setup controls")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Analyze to (s)"), { target: { value: "100" } });
    expect(screen.getByRole("alert")).toHaveTextContent("valid source range");
    expect(transcribeMock).not.toHaveBeenCalled();
  });

  it("reviews real candidates, previews source ranges, and only appends after selection", async () => {
    const before = useTimelineStore.getState().timeline;
    render(<AiCutPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Find candidate clips" }));
    const preview = await screen.findByRole("button", { name: "Preview suggestion 1" });
    expect(useTimelineStore.getState().timeline).toBe(before);
    expect(screen.getByRole("button", { name: "Add selected (0)" })).toBeDisabled();
    const candidate = useAiCutStore.getState().draft!.candidates[0];
    fireEvent.click(preview);
    expect(useSourcePreviewStore.getState().range).toMatchObject({
      mediaId: asset.id,
      start: candidate.start,
      end: candidate.end,
    });
    expect(useTimelineStore.getState().mode).toBe("source");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select suggestion 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Add selected (1)" }));
    expect(useTimelineStore.getState().timeline!.duration).toBeGreaterThan(0);
    expect(useTimelineStore.getState().past).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Added 1 clip");
    useTimelineStore.getState().undo();
    expect(useTimelineStore.getState().timeline).toBe(before);
  });

  it("re-ranks the existing transcript without another speech request", async () => {
    render(<AiCutPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Find candidate clips" }));
    await screen.findByRole("button", { name: "Preview suggestion 1" });
    fireEvent.change(screen.getByLabelText("Maximum clip (s)"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Re-rank transcript" }));
    expect(transcribeMock).toHaveBeenCalledTimes(1);
    expect(useAiCutStore.getState().draft!.options.maxDuration).toBe(20);
    expect(
      useAiCutStore.getState().draft!.candidates.every((item) => item.end - item.start <= 20),
    ).toBe(true);
  });

  it("shows provider failures and leaves timeline edits intact", async () => {
    const before = useTimelineStore.getState().timeline;
    transcribeMock.mockRejectedValue(new Error("The speech model is unavailable"));
    render(<AiCutPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Find candidate clips" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("speech model is unavailable"),
    );
    expect(useTimelineStore.getState().timeline).toBe(before);
    expect(screen.queryByRole("button", { name: "Add selected (0)" })).not.toBeInTheDocument();
  });
});
