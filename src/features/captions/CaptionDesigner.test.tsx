import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTimeline, defaultTransform } from "@/domain/timeline/model";
import { defaultCaptions, type CaptionSegment, type Transcript } from "@/domain/captions";
import type { MediaAsset } from "@/domain/media";
import {
  defaultTranscriptionSetup,
  type TranscriptionReadiness,
  type TranscriptionSetup,
} from "@/domain/transcriptionSetup";
import { useMediaStore } from "@/stores/mediaStore";
import { useTimelineStore } from "@/stores/timelineStore";
import { useTranscriptionStore } from "@/stores/transcriptionStore";
import { CaptionDesigner } from "./CaptionDesigner";
import { CaptionSegmentEditor } from "./CaptionSegmentEditor";

const { transcribeMock, getSetupMock, saveSetupMock, checkSetupMock } = vi.hoisted(() => ({
  transcribeMock: vi.fn(),
  getSetupMock: vi.fn(),
  saveSetupMock: vi.fn(),
  checkSetupMock: vi.fn(),
}));
vi.mock("@/infrastructure/tauri/captions", () => ({
  transcribeMedia: transcribeMock,
  getTranscriptionSetup: getSetupMock,
  saveTranscriptionSetup: saveSetupMock,
  checkTranscriptionSetup: checkSetupMock,
  openTranscriptionSetupFolder: vi.fn(async () => null),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

const media: MediaAsset = {
  id: "m1",
  originalPath: "C:\\podcast.wav",
  fileName: "podcast.wav",
  kind: "audio",
  container: "wav",
  sizeBytes: 1000,
  durationSec: 30,
  hasVideo: false,
  hasAudio: true,
  video: null,
  audio: { codec: "pcm_s16le", channels: 1, sampleRate: 16000, bitRate: null },
  importedAt: "2026-01-01",
  derivatives: [],
};
const transcript: Transcript = {
  language: "ar",
  words: [
    { text: "مرحباً", start: 0.25, end: 0.8, emphasis: false },
    { text: "world!", start: 0.9, end: 1.3, emphasis: false },
  ],
};
const readySetup: TranscriptionReadiness = {
  ready: true,
  pythonVersion: "3.13.1",
  providerVersion: "1.2.1",
  modelReady: true,
  ffmpegReady: true,
  multilingual: true,
  issues: [],
};

beforeEach(() => {
  localStorage.clear();
  transcribeMock.mockReset();
  getSetupMock.mockReset().mockResolvedValue(null);
  saveSetupMock.mockReset().mockImplementation(async (setup: TranscriptionSetup) => setup);
  checkSetupMock.mockReset().mockResolvedValue(readySetup);
  useTranscriptionStore.setState({
    setup: { ...defaultTranscriptionSetup, modelPath: "C:\\models\\small" },
    loaded: true,
    loading: false,
    checking: false,
    readiness: readySetup,
    error: null,
  });
  useTimelineStore.getState().reset();
  const timeline = createTimeline({ width: 1080, height: 1920, fps: 30 });
  timeline.duration = 8;
  timeline.tracks[1].clips = [
    {
      id: "clip1",
      sourceMediaId: "m1",
      label: "podcast.wav",
      sourceStart: 10,
      sourceEnd: 13,
      timelineStart: 5,
      timelineEnd: 8,
      speed: 1,
      enabled: true,
      transform: { ...defaultTransform },
    },
  ];
  useTimelineStore.setState({
    projectId: "project1",
    timeline,
    selectedIds: ["clip1"],
    selectedTrackId: timeline.tracks[1].id,
    mode: "timeline",
  });
  useMediaStore.setState({ assets: [media] });
});

function requestCaptions() {
  fireEvent.click(screen.getByRole("button", { name: "Generate captions" }));
}

describe("CaptionDesigner generation", () => {
  it("saves settings natively and requires a setup check after reloading them", async () => {
    const { unmount } = render(<CaptionDesigner />);
    fireEvent.change(screen.getByRole("textbox", { name: "Transcription Python executable" }), {
      target: { value: "C:\\python\\python.exe" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Transcription model folder" }), {
      target: { value: "C:\\models\\small" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Transcription language" }), {
      target: { value: "ar" },
    });
    expect(screen.getByRole("button", { name: "Generate captions" })).toBeDisabled();
    const savedSetup: TranscriptionSetup = {
      pythonPath: "C:\\python\\python.exe",
      modelPath: "C:\\models\\small",
      language: "ar",
    };
    fireEvent.click(screen.getByRole("button", { name: "Save and check setup" }));
    await screen.findByText("Ready for local transcription");
    expect(saveSetupMock).toHaveBeenCalledWith(savedSetup);
    expect(checkSetupMock).toHaveBeenCalledWith(savedSetup);
    expect(screen.getByRole("button", { name: "Generate captions" })).toBeEnabled();
    unmount();
    // A fresh session loads the native database rather than relying on the WebView origin.
    useTranscriptionStore.setState({
      setup: { ...defaultTranscriptionSetup },
      loaded: false,
      readiness: null,
    });
    getSetupMock.mockResolvedValue(savedSetup);
    render(<CaptionDesigner />);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Transcription Python executable" })).toHaveValue(
        "C:\\python\\python.exe",
      ),
    );
    expect(screen.getByRole("textbox", { name: "Transcription model folder" })).toHaveValue(
      "C:\\models\\small",
    );
    expect(screen.getByRole("combobox", { name: "Transcription language" })).toHaveValue("ar");
    expect(getSetupMock).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Generate captions" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save and check setup" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Generate captions" })).toBeEnabled(),
    );
  });

  it("transcribes the selected source range, previews a draft, and applies with undo", async () => {
    transcribeMock.mockResolvedValue(transcript);
    render(<CaptionDesigner />);
    requestCaptions();
    await screen.findByRole("button", { name: "Apply generated captions" });
    expect(transcribeMock).toHaveBeenCalledWith({
      projectId: "project1",
      mediaId: "m1",
      sourceStart: 10,
      sourceEnd: 13,
      pythonPath: "python",
      modelPath: "C:\\models\\small",
      language: "auto",
    });
    expect(useTimelineStore.getState().timeline?.captions.segments).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Apply generated captions" }));
    const segments = useTimelineStore.getState().timeline!.captions.segments;
    expect(segments).toHaveLength(1);
    expect(segments[0].words.map(({ start, end }) => [start, end])).toEqual([
      [5.25, 5.8],
      [5.9, 6.3],
    ]);
    act(() => useTimelineStore.getState().undo());
    expect(useTimelineStore.getState().timeline?.captions.segments).toEqual([]);
  });

  it("rejects a delayed result when the timeline changes during recognition", async () => {
    let resolve!: (value: Transcript) => void;
    transcribeMock.mockImplementation(
      () =>
        new Promise<Transcript>((done) => {
          resolve = done;
        }),
    );
    render(<CaptionDesigner />);
    requestCaptions();
    act(() =>
      useTimelineStore
        .getState()
        .edit({ type: "captions", captions: { ...defaultCaptions, enabled: false } }),
    );
    await act(async () => resolve(transcript));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "timeline changed during transcription",
    );
    expect(
      screen.queryByRole("button", { name: "Apply generated captions" }),
    ).not.toBeInTheDocument();
    expect(useTimelineStore.getState().timeline?.captions.enabled).toBe(false);
  });

  it("rechecks the snapshot when applying a reviewed result", async () => {
    transcribeMock.mockResolvedValue(transcript);
    render(<CaptionDesigner />);
    requestCaptions();
    await screen.findByRole("button", { name: "Apply generated captions" });
    fireEvent.change(screen.getByRole("combobox", { name: "Caption style" }), {
      target: { value: "arabic" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply generated captions" }));
    expect(screen.getByRole("alert")).toHaveTextContent("timeline changed after transcription");
    expect(useTimelineStore.getState().timeline?.captions.segments).toEqual([]);
    expect(useTimelineStore.getState().timeline?.captions.style.preset).toBe("arabic");
  });

  it("discards an in-flight result after leaving its project", async () => {
    let resolve!: (value: Transcript) => void;
    transcribeMock.mockImplementation(
      () =>
        new Promise<Transcript>((done) => {
          resolve = done;
        }),
    );
    const { unmount } = render(<CaptionDesigner />);
    requestCaptions();
    unmount();
    useTimelineStore.setState({ projectId: "project2" });
    render(<CaptionDesigner />);
    await act(async () => resolve(transcript));
    expect(
      screen.queryByRole("button", { name: "Apply generated captions" }),
    ).not.toBeInTheDocument();
    expect(useTimelineStore.getState().timeline?.captions.segments).toEqual([]);
  });

  it("allows style edits to captions retained beyond a shortened media timeline", async () => {
    const timeline = useTimelineStore.getState().timeline!;
    const retained: CaptionSegment = {
      id: "retained",
      start: 9,
      end: 10,
      words: [{ text: "Later", start: 9, end: 10, emphasis: false }],
    };
    useTimelineStore.setState({
      timeline: { ...timeline, captions: { ...defaultCaptions, segments: [retained] } },
    });
    render(<CaptionDesigner />);
    fireEvent.change(screen.getByRole("combobox", { name: "Caption style" }), {
      target: { value: "bold" },
    });
    await waitFor(() =>
      expect(useTimelineStore.getState().timeline?.captions.style.preset).toBe("bold"),
    );
    expect(useTimelineStore.getState().timeline?.captions.segments).toEqual([retained]);
  });
});

describe("CaptionSegmentEditor", () => {
  it("preserves precise provider timestamps when a rounded field is merely focused and blurred", () => {
    const onReplace = vi.fn(() => true);
    const segment: CaptionSegment = {
      id: "precise",
      start: 1.1234567,
      end: 2.987654,
      words: [{ text: "precise", start: 1.1234567, end: 2.987654, emphasis: false }],
    };
    render(
      <CaptionSegmentEditor
        segment={segment}
        onReplace={onReplace}
        onDelete={vi.fn()}
        onMerge={vi.fn()}
        onError={vi.fn()}
      />,
    );
    for (const name of ["Caption start time", "Caption end time", "Word 1 start", "Word 1 end"]) {
      fireEvent.focus(screen.getByRole("spinbutton", { name }));
      fireEvent.blur(screen.getByRole("spinbutton", { name }));
    }
    expect(onReplace).not.toHaveBeenCalled();
  });
});
