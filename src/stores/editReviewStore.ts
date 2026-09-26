import { create } from "zustand";
import { errorMessage } from "@/domain/errors";
import { analyzeReel } from "@/domain/editReview/analyze";
import { suggestionEdit } from "@/domain/editReview/edits";
import { reviewSuggestionSchema, type ReviewSuggestion } from "@/domain/editReview/model";
import type { SafeZonePlatform } from "@/domain/safeZones";
import { applyEdit } from "@/domain/timeline/edit";
import { serializeTimeline, type Timeline } from "@/domain/timeline/model";
import { useMediaStore } from "./mediaStore";
import { useTimelineStore } from "./timelineStore";
import { useWorkspaceStore } from "./workspaceStore";

interface ReviewPreview {
  suggestionId: string;
  timeline: Timeline;
  start: number;
  end: number;
}

interface EditReviewState {
  platform: SafeZonePlatform;
  projectId: string | null;
  snapshot: string | null;
  sourceSnapshot: string | null;
  suggestions: ReviewSuggestion[];
  ignoredIds: string[];
  hasReview: boolean;
  stale: boolean;
  hookText: string;
  preview: ReviewPreview | null;
  error: string | null;
  notice: string | null;
  review: () => void;
  setPlatform: (platform: SafeZonePlatform) => void;
  setHookText: (text: string) => void;
  previewSuggestion: (id: string) => boolean;
  apply: (id: string) => boolean;
  ignore: (id: string) => void;
  clearPreview: () => void;
  reset: () => void;
}

const initial = {
  platform: "instagram" as SafeZonePlatform,
  projectId: null,
  snapshot: null,
  sourceSnapshot: null,
  suggestions: [],
  ignoredIds: [],
  hasReview: false,
  stale: false,
  hookText: "",
  preview: null,
  error: null,
  notice: null,
};

function sourceSnapshot(timeline: Timeline): string {
  const ids = new Set(
    timeline.tracks.flatMap((track) => track.clips.map((clip) => clip.sourceMediaId)),
  );
  return JSON.stringify(
    useMediaStore
      .getState()
      .assets.filter((asset) => ids.has(asset.id))
      .map((asset) => ({
        id: asset.id,
        path: asset.originalPath,
        kind: asset.kind,
        duration: asset.durationSec,
        hasVideo: asset.hasVideo,
        hasAudio: asset.hasAudio,
        importedAt: asset.importedAt,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}

function currentTimeline() {
  const workspace = useWorkspaceStore.getState();
  const state = useTimelineStore.getState();
  if (
    workspace.status !== "editor" ||
    !workspace.project ||
    workspace.closing ||
    workspace.busy ||
    state.loading ||
    state.saving ||
    useMediaStore.getState().loading ||
    !state.timeline ||
    state.projectId !== workspace.project.id
  )
    throw new Error("Wait until the project is ready to review the timeline.");
  if (!state.timeline.duration) throw new Error("Add media to the timeline before reviewing it.");
  return { projectId: workspace.project.id, timeline: state.timeline };
}

function currentSuggestion(state: EditReviewState, id: string) {
  const current = currentTimeline();
  if (
    !state.hasReview ||
    state.stale ||
    state.projectId !== current.projectId ||
    state.sourceSnapshot !== sourceSnapshot(current.timeline) ||
    state.snapshot !== serializeTimeline(current.timeline)
  )
    throw new Error("The timeline changed. Review again before using a suggestion.");
  const candidate = state.suggestions.find((item) => item.id === id);
  if (!candidate || state.ignoredIds.includes(id))
    throw new Error("This suggestion is no longer available. Review again.");
  const suggestion = reviewSuggestionSchema.parse(candidate);
  if (suggestion.start < 0 || suggestion.end > current.timeline.duration)
    throw new Error("The suggestion is outside the current timeline. Review again.");
  return { ...current, suggestion };
}

export const useEditReviewStore = create<EditReviewState>((set, get) => ({
  ...initial,
  review: () => {
    try {
      const { projectId, timeline } = currentTimeline();
      const suggestions = analyzeReel(timeline, get().platform).map((suggestion) =>
        reviewSuggestionSchema.parse(suggestion),
      );
      const opening = suggestions.find((suggestion) => suggestion.action?.type === "openingHook");
      get().clearPreview();
      set({
        projectId,
        snapshot: serializeTimeline(timeline),
        sourceSnapshot: sourceSnapshot(timeline),
        suggestions,
        ignoredIds: [],
        hasReview: true,
        stale: false,
        hookText: opening?.action?.type === "openingHook" ? opening.action.text : "",
        error: null,
        notice: null,
      });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },
  setPlatform: (platform) => {
    if (platform === get().platform) return;
    get().clearPreview();
    set({ platform, stale: get().hasReview, error: null, notice: null });
  },
  setHookText: (hookText) => {
    get().clearPreview();
    set({ hookText, error: null });
  },
  previewSuggestion: (id) => {
    try {
      const { timeline, suggestion } = currentSuggestion(get(), id);
      const edit = suggestionEdit(timeline, suggestion, get().hookText);
      const previewTimeline = edit
        ? applyEdit(timeline, edit, useMediaStore.getState().assets)
        : timeline;
      useTimelineStore.setState({ playing: false, mode: "timeline", safeZone: get().platform });
      useTimelineStore.getState().seek(suggestion.start);
      set({
        preview: {
          suggestionId: id,
          timeline: previewTimeline,
          start: suggestion.start,
          end: suggestion.end,
        },
        error: null,
        notice: edit
          ? "Preview only. Choose Apply to keep this change."
          : "Review this section in the monitor, then edit it manually.",
      });
      return true;
    } catch (error) {
      set({ error: errorMessage(error) });
      return false;
    }
  },
  apply: (id) => {
    try {
      const { timeline, suggestion } = currentSuggestion(get(), id);
      const edit = suggestionEdit(timeline, suggestion, get().hookText);
      if (!edit)
        throw new Error("This finding needs a manual edit. Preview the section for context.");
      // Validate before committing, using the same reducer as all manual timeline edits.
      applyEdit(timeline, edit, useMediaStore.getState().assets);
      useTimelineStore.getState().edit(edit);
      const after = useTimelineStore.getState();
      if (after.timeline === timeline)
        throw new Error(after.error ?? "The suggestion did not change the timeline.");
      get().review();
      set({ notice: "Suggestion applied. Undo restores the previous edit. Review updated." });
      return true;
    } catch (error) {
      set({ error: errorMessage(error) });
      return false;
    }
  },
  ignore: (id) => {
    if (!get().suggestions.some((suggestion) => suggestion.id === id)) return;
    if (get().preview?.suggestionId === id) get().clearPreview();
    set((state) => ({ ignoredIds: [...new Set([...state.ignoredIds, id])], error: null }));
  },
  clearPreview: () => {
    if (get().preview) {
      set({ preview: null, notice: null });
      useTimelineStore.setState({ playing: false });
    }
  },
  reset: () => {
    get().clearPreview();
    set(initial);
  },
}));

const unsubscribeTimeline = useTimelineStore.subscribe((state, previous) => {
  if (
    state.projectId !== previous.projectId ||
    (state.loading && !previous.loading) ||
    (!state.timeline && previous.timeline)
  ) {
    useEditReviewStore.getState().reset();
  } else if (state.timeline !== previous.timeline && useEditReviewStore.getState().hasReview) {
    useEditReviewStore.getState().clearPreview();
    useEditReviewStore.setState({ stale: true, notice: null });
  } else if (state.mode !== previous.mode && state.mode === "source") {
    useEditReviewStore.getState().clearPreview();
  }
});

const unsubscribeWorkspace = useWorkspaceStore.subscribe((state, previous) => {
  if (
    state.project?.id !== previous.project?.id ||
    state.project?.rootPath !== previous.project?.rootPath ||
    (state.status !== "editor" && previous.status === "editor")
  ) {
    useEditReviewStore.getState().reset();
  } else if (state.closing || state.busy) {
    useEditReviewStore.getState().clearPreview();
  }
});

const unsubscribeMedia = useMediaStore.subscribe(() => {
  const review = useEditReviewStore.getState();
  const timeline = useTimelineStore.getState().timeline;
  if (review.hasReview && timeline && review.sourceSnapshot !== sourceSnapshot(timeline)) {
    review.clearPreview();
    useEditReviewStore.setState({ stale: true, notice: null });
  }
});

if (import.meta.hot)
  import.meta.hot.dispose(() => {
    unsubscribeTimeline();
    unsubscribeWorkspace();
    unsubscribeMedia();
  });
