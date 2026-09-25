import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AI_CUT_OPTIONS, type AiCutOptions } from "@/domain/aiCut";
import { defaultCaptions, type Transcript } from "@/domain/captions";
import type { MediaAsset } from "@/domain/media";
import type { ProjectInfo } from "@/domain/projects";
import { createTimeline, deserializeTimeline, serializeTimeline } from "@/domain/timeline/model";

const { transcribeMock, loadMock, saveMock } = vi.hoisted(() => ({
  transcribeMock: vi.fn(),
  loadMock: vi.fn(),
  saveMock: vi.fn(),
}));
vi.mock("@/infrastructure/tauri/captions", () => ({
  transcribeMedia: transcribeMock,
  getTranscriptionSetup: vi.fn(),
  saveTranscriptionSetup: vi.fn(),
  checkTranscriptionSetup: vi.fn(),
}));
vi.mock("@/infrastructure/tauri/timeline", () => ({
  loadTimeline: loadMock,
  saveTimeline: saveMock,
}));

import { useAiCutStore } from "./aiCutStore";
import { useMediaStore } from "./mediaStore";
import { useTimelineStore } from "./timelineStore";
import { useTranscriptionStore } from "./transcriptionStore";
import { useWorkspaceStore } from "./workspaceStore";

const project: ProjectInfo = {
  id: "cut-project",
  name: "AI Cut project",
  rootPath: "C:\\projects\\cut",
  createdAt: "2026-09-25T00:00:00Z",
  format: { width: 1080, height: 1920, fps: 30 },
  mediaCount: 1,
};
const asset: MediaAsset = {
  id: "cut-source",
  originalPath: "C:\\media\\speech.mp4",
  fileName: "speech.mp4",
  kind: "video",
  container: "mp4",
  sizeBytes: 100,
  durationSec: 200,
  hasVideo: true,
  hasAudio: true,
  video: null,
  audio: null,
  importedAt: "2026-09-25T00:00:00Z",
  derivatives: [],
};
const options: AiCutOptions = {
  ...DEFAULT_AI_CUT_OPTIONS,
  minDuration: 4,
  maxDuration: 12,
  maxCandidates: 6,
};
const speechSetup = {
  pythonPath: "C:\\speech\\python.exe",
  modelPath: "C:\\models\\small",
  language: "en" as const,
};
const transcript: Transcript = {
  language: "en",
  words: Array.from({ length: 12 }, (_, sentence) =>
    "Here is the secret to making your video much better.".split(" ").map((text, index) => ({
      text,
      start: 1 + sentence * 6 + index * 0.45,
      end: 1.4 + sentence * 6 + index * 0.45,
      emphasis: false,
    })),
  ).flat(),
};

beforeEach(() => {
  useAiCutStore.getState().reset();
  useTimelineStore.getState().reset();
  useWorkspaceStore.setState({
    status: "editor",
    project,
    busy: false,
    closing: false,
    error: null,
  });
  useMediaStore.setState({
    assets: [structuredClone(asset)],
    selectedId: asset.id,
    loading: false,
  });
  useTimelineStore.setState({ projectId: project.id, timeline: createTimeline(project.format) });
  useTranscriptionStore.setState({
    setup: speechSetup,
    loading: false,
    checking: false,
    loaded: true,
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
  transcribeMock.mockReset().mockResolvedValue(structuredClone(transcript));
  loadMock.mockReset().mockResolvedValue(null);
  saveMock.mockReset().mockResolvedValue(undefined);
});

const generate = () => useAiCutStore.getState().generate(asset.id, 20, 120, options);

describe("AI Cut transcription and review", () => {
  it("analyzes the actual selected source range without editing the timeline", async () => {
    const before = useTimelineStore.getState().timeline;
    await generate();
    expect(transcribeMock).toHaveBeenCalledWith({
      projectId: project.id,
      mediaId: asset.id,
      sourceStart: 20,
      sourceEnd: 120,
      ...speechSetup,
    });
    const state = useAiCutStore.getState();
    expect(state.error).toBeNull();
    expect(state.generating).toBe(false);
    expect(state.draft?.transcript).toEqual(transcript);
    expect(state.draft!.candidates.length).toBeGreaterThan(1);
    expect(
      state.draft!.candidates.every((candidate) => candidate.start >= 20 && candidate.end <= 120),
    ).toBe(true);
    expect(state.selectedIds).toEqual([]);
    expect(useTimelineStore.getState().timeline).toBe(before);
    expect(useTimelineStore.getState().past).toHaveLength(0);
  });

  it("reranks retained speech locally and keeps selections that remain available", async () => {
    await generate();
    const candidate = useAiCutStore.getState().draft!.candidates[0];
    useAiCutStore.getState().toggle(candidate.id);
    useAiCutStore.getState().toggle("not-a-candidate");
    useAiCutStore.getState().rerank(options);
    expect(useAiCutStore.getState().selectedIds).toEqual([candidate.id]);
    useAiCutStore.getState().rerank({ ...options, weights: { ...options.weights, pacing: 100 } });
    expect(useAiCutStore.getState().draft?.options.weights.pacing).toBe(100);
    expect(transcribeMock).toHaveBeenCalledTimes(1);
    const before = useAiCutStore.getState().draft;
    useAiCutStore.getState().rerank({ ...options, minDuration: 99, maxDuration: 5 });
    expect(useAiCutStore.getState().draft).toBe(before);
    expect(useAiCutStore.getState().error).toBeTruthy();
  });

  it("preserves review while selecting other media or refreshing derivative metadata", async () => {
    await generate();
    const before = useAiCutStore.getState().draft;
    useMediaStore.getState().select(null);
    useMediaStore.setState({ assets: [{ ...asset, fileName: "renamed.mp4", derivatives: [] }] });
    expect(useAiCutStore.getState().draft).toBe(before);
    useAiCutStore.getState().toggle(before!.candidates[0].id);
    expect(useAiCutStore.getState().applySelected()).toBe(true);
  });

  it("reports empty speech and native cancellation without inventing clips", async () => {
    transcribeMock.mockResolvedValueOnce({ language: "en", words: [] });
    await generate();
    expect(useAiCutStore.getState().draft?.candidates).toEqual([]);
    expect(useAiCutStore.getState().notice).toContain("No suitable");
    transcribeMock.mockRejectedValueOnce(new Error("Transcription cancelled"));
    await generate();
    expect(useAiCutStore.getState().error).toContain("cancelled");
    expect(useAiCutStore.getState().generating).toBe(false);
    expect(useAiCutStore.getState().draft).toBeNull();
    expect(useTimelineStore.getState().past).toHaveLength(0);
  });

  it("requires a checked speech setup and a selected video with audio", async () => {
    useTranscriptionStore.setState({ readiness: null });
    await generate();
    expect(useAiCutStore.getState().error).toContain("speech setup");
    useMediaStore.setState({ assets: [{ ...asset, hasAudio: false }] });
    await generate();
    expect(useAiCutStore.getState().error).toContain("video with audio");
    expect(transcribeMock).not.toHaveBeenCalled();
  });

  it.each([
    [NaN, 120],
    [-1, 120],
    [20, 20],
    [20, 201],
    [20, Infinity],
  ])("rejects the invalid source range %s..%s before IPC", async (start, end) => {
    await useAiCutStore.getState().generate(asset.id, start, end, options);
    expect(useAiCutStore.getState().error).toContain("source range");
    expect(transcribeMock).not.toHaveBeenCalled();
  });

  it("limits each transcription to 60 minutes", async () => {
    useMediaStore.setState({ assets: [{ ...asset, durationSec: 5000 }] });
    await useAiCutStore.getState().generate(asset.id, 0, 3601, options);
    expect(useAiCutStore.getState().error).toContain("60 minutes");
    expect(transcribeMock).not.toHaveBeenCalled();
  });
});

describe("AI Cut stale result guards", () => {
  it.each(["reset", "reload", "remove", "replace", "project", "busy", "closing"])(
    "discards pending transcription after %s",
    async (change) => {
      let resolve!: (value: Transcript) => void;
      transcribeMock.mockImplementation(
        () =>
          new Promise<Transcript>((done) => {
            resolve = done;
          }),
      );
      const pending = generate();
      expect(useAiCutStore.getState().generating).toBe(true);
      await generate();
      expect(transcribeMock).toHaveBeenCalledTimes(1);
      if (change === "reset") useTimelineStore.getState().reset();
      if (change === "reload") await useTimelineStore.getState().load(project);
      if (change === "remove") useMediaStore.setState({ assets: [] });
      if (change === "replace")
        useMediaStore.setState({ assets: [{ ...asset, originalPath: "C:\\replacement.mp4" }] });
      if (change === "project")
        useWorkspaceStore.setState({ project: { ...project, id: "other" } });
      if (change === "busy") useWorkspaceStore.setState({ busy: true });
      if (change === "closing") useWorkspaceStore.setState({ closing: true });
      resolve(transcript);
      await pending;
      expect(useAiCutStore.getState().draft).toBeNull();
      expect(useAiCutStore.getState().generating).toBe(false);
      expect(useTimelineStore.getState().past).toHaveLength(0);
    },
  );

  it("does not let an older request overwrite a newer analysis", async () => {
    let resolve!: (value: Transcript) => void;
    transcribeMock.mockImplementationOnce(
      () =>
        new Promise<Transcript>((done) => {
          resolve = done;
        }),
    );
    const pending = generate();
    useAiCutStore.getState().reset();
    await generate();
    const newer = useAiCutStore.getState().draft;
    resolve({ language: "ar", words: [] });
    await pending;
    expect(useAiCutStore.getState().draft).toBe(newer);
  });
});

describe("AI Cut atomic timeline application", () => {
  it("appends chronologically to the current timeline in one undo step and saves the result", async () => {
    await generate();
    const candidates = useAiCutStore
      .getState()
      .draft!.candidates.slice(0, 2)
      .sort((left, right) => left.start - right.start);
    // Ordinary edits made after analysis must survive the eventual append.
    const timeline = useTimelineStore.getState().timeline!;
    useTimelineStore.getState().edit({
      type: "add",
      trackId: timeline.tracks[0].id,
      asset,
      start: 0,
      sourceStart: 0,
      sourceEnd: 5,
    });
    useTimelineStore.getState().edit({ type: "hook", patch: { enabled: true, duration: 2 } });
    useTimelineStore
      .getState()
      .edit({ type: "captions", captions: { ...defaultCaptions, enabled: false } });
    const before = useTimelineStore.getState().timeline!;
    const historyLength = useTimelineStore.getState().past.length;
    [...candidates].reverse().forEach((candidate) => useAiCutStore.getState().toggle(candidate.id));
    expect(useAiCutStore.getState().applySelected()).toBe(true);
    const state = useTimelineStore.getState();
    const after = state.timeline!;
    const clips = after.tracks[0].clips;
    expect(state.past).toHaveLength(historyLength + 1);
    expect(clips[0]).toEqual(before.tracks[0].clips[0]);
    expect(after.hook).toEqual(before.hook);
    expect(after.captions).toEqual(before.captions);
    expect(clips.slice(1).map((clip) => clip.label)).toEqual(
      candidates.map((candidate) => candidate.text.slice(0, 120)),
    );
    expect(clips[1].timelineStart).toBe(5);
    expect(clips[2].timelineStart).toBe(clips[1].timelineEnd);
    expect(state.selectedIds).toEqual(clips.slice(1).map((clip) => clip.id));
    expect(state.playhead).toBe(5);
    expect(state.mode).toBe("timeline");
    expect(useAiCutStore.getState().draft).toBeNull();
    expect(useAiCutStore.getState().applySelected()).toBe(false);
    expect(useTimelineStore.getState().timeline).toBe(after);
    useTimelineStore.getState().undo();
    expect(useTimelineStore.getState().timeline).toBe(before);
    useTimelineStore.getState().redo();
    expect(useTimelineStore.getState().timeline).toBe(after);
    expect(await useTimelineStore.getState().save()).toBe(true);
    loadMock.mockResolvedValueOnce(
      deserializeTimeline(serializeTimeline(saveMock.mock.calls[0][1])),
    );
    await useTimelineStore.getState().load(project);
    expect(useTimelineStore.getState().timeline).toEqual(after);
  });

  it.each(["closing", "busy", "loading", "selection", "range", "duration"])(
    "leaves the timeline and history intact when application is invalid: %s",
    async (invalid) => {
      await generate();
      const draft = useAiCutStore.getState().draft!;
      useAiCutStore.getState().toggle(draft.candidates[0].id);
      if (invalid === "closing") useWorkspaceStore.setState({ closing: true });
      if (invalid === "busy") useWorkspaceStore.setState({ busy: true });
      if (invalid === "loading") useTimelineStore.setState({ loading: true });
      if (invalid === "selection") useAiCutStore.setState({ selectedIds: ["unknown-id"] });
      if (invalid === "range")
        useAiCutStore.setState({
          draft: { ...draft, candidates: [{ ...draft.candidates[0], start: 0 }] },
        });
      if (invalid === "duration")
        useAiCutStore.setState({
          draft: {
            ...draft,
            candidates: [{ ...draft.candidates[0], end: draft.candidates[0].start + 0.1 }],
          },
        });
      const before = useTimelineStore.getState().timeline;
      const history = useTimelineStore.getState().past;
      expect(useAiCutStore.getState().applySelected()).toBe(false);
      expect(useTimelineStore.getState().timeline).toBe(before);
      expect(useTimelineStore.getState().past).toBe(history);
      expect(useAiCutStore.getState().error).toBeTruthy();
    },
  );
});
