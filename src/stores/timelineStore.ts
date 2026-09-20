import { create } from "zustand";
import { errorMessage } from "@/domain/errors";
import type { ProjectInfo } from "@/domain/projects";
import { applyEdit, frameTime, type Edit } from "@/domain/timeline/edit";
import { createTimeline, serializeTimeline, type Timeline } from "@/domain/timeline/model";
import { loadTimeline, saveTimeline } from "@/infrastructure/tauri/timeline";
import { useMediaStore } from "./mediaStore";

interface TimelineState {
  projectId: string | null;
  timeline: Timeline | null;
  past: Timeline[];
  future: Timeline[];
  saved: string | null;
  selectedIds: string[];
  selectedTrackId: string | null;
  playhead: number;
  playing: boolean;
  mode: "source" | "timeline";
  zoom: number;
  snapping: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  load: (project: ProjectInfo) => Promise<void>;
  save: () => Promise<boolean>;
  edit: (edit: Edit) => void;
  undo: () => void;
  redo: () => void;
  select: (id: string, trackId: string, additive?: boolean) => void;
  seek: (seconds: number) => void;
  togglePlayback: () => void;
  reset: () => void;
}

const initial = {
  projectId: null, timeline: null, past: [], future: [], saved: null, selectedIds: [],
  selectedTrackId: null, playhead: 0, playing: false, mode: "source" as const,
  zoom: 30, snapping: true, loading: false, saving: false, error: null,
};
let pendingSave: Promise<boolean> | null = null;
let generation = 0;

export const useTimelineStore = create<TimelineState>((set, get) => ({
  ...initial,
  load: async (project) => {
    const request = ++generation;
    set({ ...initial, loading: true, projectId: project.id });
    try {
      const persisted = await loadTimeline(project.id);
      if (request !== generation) return;
      const timeline = persisted ?? createTimeline(project.format);
      set({ timeline, saved: serializeTimeline(timeline), loading: false,
        selectedTrackId: timeline.tracks[0]?.id ?? null, mode: persisted?.duration ? "timeline" : "source" });
    } catch (error) {
      if (request === generation) set({ loading: false, error: errorMessage(error) });
    }
  },
  save: () => {
    if (pendingSave) return pendingSave;
    const request = generation;
    pendingSave = (async () => {
      set({ saving: true, playing: false, error: null });
      try {
        // Edits made while IPC is in flight must also reach disk before a close can proceed.
        while (true) {
          const { timeline, projectId, saved } = get();
          if (!timeline || !projectId) return false;
          const snapshot = serializeTimeline(timeline);
          if (snapshot === saved) return true;
          await saveTimeline(projectId, timeline);
          if (request !== generation) return false;
          set({ saved: snapshot });
        }
      } catch (error) {
        if (request === generation) set({ error: errorMessage(error) });
        return false;
      } finally {
        if (request === generation) set({ saving: false });
      }
    })().finally(() => { pendingSave = null; });
    return pendingSave;
  },
  edit: (edit) => {
    const { timeline, past } = get();
    if (!timeline) return;
    try {
      const next = applyEdit(timeline, edit, useMediaStore.getState().assets);
      if (serializeTimeline(next) === serializeTimeline(timeline)) return;
      const ids = new Set(next.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
      set((state) => ({ timeline: next, past: [...past.slice(-99), timeline], future: [], error: null,
        selectedIds: state.selectedIds.filter((id) => ids.has(id)), playing: false, mode: "timeline",
        playhead: Math.min(state.playhead, next.duration),
        selectedTrackId: next.tracks.some((track) => track.id === state.selectedTrackId) ? state.selectedTrackId : (next.tracks[0]?.id ?? null) }));
    } catch (error) { set({ error: errorMessage(error), playing: false }); }
  },
  undo: () => {
    const { timeline, past, future } = get();
    const previous = past.at(-1);
    if (!timeline || !previous) return;
    set({ timeline: previous, past: past.slice(0, -1), future: [timeline, ...future], selectedIds: [], playing: false, error: null, playhead: Math.min(get().playhead, previous.duration) });
  },
  redo: () => {
    const { timeline, past, future } = get();
    if (!timeline || !future[0]) return;
    set({ timeline: future[0], past: [...past, timeline], future: future.slice(1), selectedIds: [], playing: false, error: null, playhead: Math.min(get().playhead, future[0].duration) });
  },
  select: (id, trackId, additive = false) => set((state) => ({
    selectedIds: additive ? state.selectedIds.includes(id) ? state.selectedIds.filter((item) => item !== id) : [...state.selectedIds, id] : [id],
    selectedTrackId: trackId, mode: "timeline",
  })),
  seek: (seconds) => set((state) => ({ playhead: frameTime(Math.min(Math.max(0, seconds), state.timeline?.duration ?? 0), state.timeline?.fps ?? 30), mode: "timeline" })),
  togglePlayback: () => set((state) => ({ playing: !!state.timeline?.duration && !state.playing,
    playhead: state.playhead >= (state.timeline?.duration ?? 0) ? 0 : state.playhead, mode: "timeline" })),
  reset: () => { generation++; set(initial); },
}));

export const isTimelineDirty = (state: Pick<TimelineState, "timeline" | "saved">) => !!state.timeline && serializeTimeline(state.timeline) !== state.saved;
