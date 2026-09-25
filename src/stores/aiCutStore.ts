import { create } from "zustand";
import {
  aiCutOptionsSchema,
  analyzeTranscript,
  candidateClipSchema,
  type AiCutOptions,
  type CandidateClip,
} from "@/domain/aiCut";
import { transcriptSchema, type Transcript } from "@/domain/captions";
import { errorMessage } from "@/domain/errors";
import type { MediaAsset } from "@/domain/media";
import { transcribeMedia } from "@/infrastructure/tauri/captions";
import { useMediaStore } from "./mediaStore";
import { useTimelineStore } from "./timelineStore";
import { useTranscriptionStore } from "./transcriptionStore";
import { useWorkspaceStore } from "./workspaceStore";

export interface AiCutDraft {
  projectId: string;
  mediaId: string;
  sourceStart: number;
  sourceEnd: number;
  transcript: Transcript;
  candidates: CandidateClip[];
  options: AiCutOptions;
}

interface AiCutState {
  draft: AiCutDraft | null;
  selectedIds: string[];
  generating: boolean;
  error: string | null;
  notice: string | null;
  generate: (
    mediaId: string,
    sourceStart: number,
    sourceEnd: number,
    options: AiCutOptions,
  ) => Promise<void>;
  rerank: (options: AiCutOptions) => void;
  toggle: (id: string) => void;
  applySelected: () => boolean;
  reset: () => void;
}

interface SourceContext {
  projectId: string;
  projectRoot: string;
  mediaId: string;
  signature: string;
}

const initial = {
  draft: null,
  selectedIds: [],
  generating: false,
  error: null,
  notice: null,
};
let generation = 0;
let sourceContext: SourceContext | null = null;

// Proxy/thumbnail refreshes do not change the source whose speech was analyzed.
function sourceSignature(asset: MediaAsset): string {
  return JSON.stringify([
    asset.id,
    asset.originalPath,
    asset.sizeBytes,
    asset.durationSec,
    asset.kind,
    asset.hasVideo,
    asset.hasAudio,
    asset.importedAt,
  ]);
}

function availableProject(): string {
  const workspace = useWorkspaceStore.getState();
  const timeline = useTimelineStore.getState();
  if (workspace.closing || workspace.busy)
    throw new Error("Wait for the workspace to finish changing before using AI Cut.");
  if (
    workspace.status !== "editor" ||
    !workspace.project ||
    timeline.loading ||
    !timeline.timeline ||
    timeline.projectId !== workspace.project.id ||
    useMediaStore.getState().loading
  )
    throw new Error("Wait for the project and media to finish loading before using AI Cut.");
  return workspace.project.id;
}

function currentSource(context: SourceContext): boolean {
  const project = useWorkspaceStore.getState().project;
  const asset = useMediaStore.getState().assets.find((item) => item.id === context.mediaId);
  return (
    project?.id === context.projectId &&
    project.rootPath === context.projectRoot &&
    useTimelineStore.getState().projectId === context.projectId &&
    !!asset &&
    sourceSignature(asset) === context.signature
  );
}

function requireDraft(draft: AiCutDraft | null): AiCutDraft {
  const projectId = availableProject();
  if (
    !draft ||
    draft.projectId !== projectId ||
    !sourceContext ||
    sourceContext.mediaId !== draft.mediaId ||
    !currentSource(sourceContext)
  )
    throw new Error("Analyze the source again before adding candidate clips.");
  return draft;
}

function parseOptions(options: AiCutOptions): AiCutOptions {
  const result = aiCutOptionsSchema.safeParse(options);
  if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Check AI Cut settings.");
  return result.data;
}

export const useAiCutStore = create<AiCutState>((set, get) => ({
  ...initial,
  generate: async (mediaId, sourceStart, sourceEnd, options) => {
    if (get().generating) return;
    let request = generation;
    try {
      const projectId = availableProject();
      const media = useMediaStore.getState();
      const asset = media.assets.find((item) => item.id === mediaId);
      if (
        media.selectedId !== mediaId ||
        !asset ||
        asset.kind !== "video" ||
        !asset.hasVideo ||
        !asset.hasAudio ||
        !Number.isFinite(asset.durationSec) ||
        asset.durationSec <= 0
      )
        throw new Error("Select a video with audio to analyze.");
      if (
        !Number.isFinite(sourceStart) ||
        !Number.isFinite(sourceEnd) ||
        sourceStart < 0 ||
        sourceEnd <= sourceStart ||
        sourceEnd > asset.durationSec ||
        sourceEnd - sourceStart > 3600
      )
        throw new Error("Choose a source range inside the video, up to 60 minutes long.");
      const parsedOptions = parseOptions(options);
      if (sourceEnd - sourceStart + 0.0000001 < parsedOptions.minDuration)
        throw new Error("The source range is shorter than the minimum candidate duration.");
      const speech = useTranscriptionStore.getState();
      if (speech.loading || speech.checking || !speech.readiness?.ready)
        throw new Error("Save and check the speech setup before analyzing clips.");
      const context: SourceContext = {
        projectId,
        projectRoot: useWorkspaceStore.getState().project!.rootPath,
        mediaId,
        signature: sourceSignature(asset),
      };
      request = ++generation;
      sourceContext = context;
      set({ ...initial, generating: true });
      // Native transcription already publishes progress and cancellation through Jobs.
      const transcript = transcriptSchema.parse(
        await transcribeMedia({
          projectId,
          mediaId,
          sourceStart,
          sourceEnd,
          ...speech.setup,
        }),
      );
      if (request !== generation) return;
      availableProject();
      if (!currentSource(context)) throw new Error("The source changed. Analyze it again.");
      const candidates = analyzeTranscript(transcript, sourceStart, sourceEnd, parsedOptions);
      set({
        draft: {
          projectId,
          mediaId,
          sourceStart,
          sourceEnd,
          transcript,
          candidates,
          options: parsedOptions,
        },
        generating: false,
        notice: candidates.length
          ? null
          : "No suitable spoken clips were found. Try a wider range or shorter candidate duration.",
      });
    } catch (error) {
      if (request === generation) set({ generating: false, error: errorMessage(error) });
    }
  },
  rerank: (options) => {
    if (get().generating) return;
    try {
      const draft = requireDraft(get().draft);
      const parsed = parseOptions(options);
      const candidates = analyzeTranscript(
        draft.transcript,
        draft.sourceStart,
        draft.sourceEnd,
        parsed,
      );
      const ids = new Set(candidates.map((candidate) => candidate.id));
      set({
        draft: { ...draft, options: parsed, candidates },
        selectedIds: get().selectedIds.filter((id) => ids.has(id)),
        error: null,
        notice: candidates.length
          ? null
          : "No suitable spoken clips were found. Try a shorter candidate duration.",
      });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },
  toggle: (id) => {
    if (get().generating || !get().draft?.candidates.some((candidate) => candidate.id === id))
      return;
    set((state) => ({
      selectedIds: state.selectedIds.includes(id)
        ? state.selectedIds.filter((item) => item !== id)
        : [...state.selectedIds, id],
      error: null,
    }));
  },
  applySelected: () => {
    if (get().generating) return false;
    try {
      const draft = requireDraft(get().draft);
      const selectedIds = get().selectedIds;
      if (
        !selectedIds.length ||
        selectedIds.length > 50 ||
        new Set(selectedIds).size !== selectedIds.length
      )
        throw new Error("Select between 1 and 50 candidate clips to add.");
      if (
        new Set(draft.candidates.map((candidate) => candidate.id)).size !== draft.candidates.length
      )
        throw new Error("Candidate IDs changed. Analyze the source again.");
      const candidates = selectedIds.map((id) => {
        const selected = draft.candidates.find((item) => item.id === id);
        if (!selected)
          throw new Error("A selected candidate is no longer available. Analyze again.");
        const candidate = candidateClipSchema.parse(selected);
        const duration = candidate.end - candidate.start;
        if (
          candidate.start < draft.sourceStart ||
          candidate.end > draft.sourceEnd ||
          duration + 0.0000001 < draft.options.minDuration ||
          duration - 0.0000001 > draft.options.maxDuration
        )
          throw new Error(
            "Candidate ranges must match the analyzed source range and duration limits.",
          );
        return candidate;
      });
      candidates.sort((left, right) => left.start - right.start || left.end - right.end);
      const before = useTimelineStore.getState().timeline!;
      const oldIds = new Set(before.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
      useTimelineStore.getState().edit({
        type: "appendCandidates",
        mediaId: draft.mediaId,
        ranges: candidates.map((candidate) => ({
          start: candidate.start,
          end: candidate.end,
          label: candidate.text.slice(0, 120),
        })),
      });
      const after = useTimelineStore.getState();
      if (after.timeline === before)
        throw new Error(after.error ?? "The candidate clips could not be added.");
      const added = after.timeline!.tracks.flatMap((track) =>
        track.clips.filter((clip) => !oldIds.has(clip.id)).map((clip) => ({ track, clip })),
      );
      added.forEach(({ track, clip }, index) => after.select(clip.id, track.id, index > 0));
      after.seek(Math.min(...added.map(({ clip }) => clip.timelineStart)));
      sourceContext = null;
      set({
        ...initial,
        notice: `Added ${added.length} ${added.length === 1 ? "clip" : "clips"} to the timeline. Undo restores the previous timeline.`,
      });
      return true;
    } catch (error) {
      set({ error: errorMessage(error) });
      return false;
    }
  },
  reset: () => {
    generation++;
    sourceContext = null;
    set(initial);
  },
}));

// Drafts may survive editing/undo, but never a project load, reset, or source replacement.
const unsubscribeTimeline = useTimelineStore.subscribe((state, previous) => {
  if (
    state.projectId !== previous.projectId ||
    (state.loading && !previous.loading) ||
    (!state.timeline && !!previous.timeline)
  )
    useAiCutStore.getState().reset();
});
const unsubscribeMedia = useMediaStore.subscribe(() => {
  if (sourceContext && !currentSource(sourceContext)) useAiCutStore.getState().reset();
});
const unsubscribeWorkspace = useWorkspaceStore.subscribe((state, previous) => {
  if (
    state.project?.id !== previous.project?.id ||
    state.project?.rootPath !== previous.project?.rootPath ||
    (state.status !== "editor" && previous.status === "editor")
  ) {
    useAiCutStore.getState().reset();
  } else if ((state.closing || state.busy) && useAiCutStore.getState().generating) {
    useAiCutStore.getState().reset();
  }
});

if (import.meta.hot)
  import.meta.hot.dispose(() => {
    generation++;
    unsubscribeTimeline();
    unsubscribeMedia();
    unsubscribeWorkspace();
  });
