import { create } from "zustand";

import { errorMessage } from "@/domain/errors";
import type { ProjectInfo, ProjectSummary } from "@/domain/projects";
import type { AppInfo, FfmpegStatus } from "@/domain/system";
import {
  closeProject as closeProjectCommand,
  createProject as createProjectCommand,
  currentProject,
  forgetProject as forgetProjectCommand,
  listRecentProjects,
  openProject as openProjectCommand,
} from "@/infrastructure/tauri/projects";
import { getAppInfo, resolveFfmpeg } from "@/infrastructure/tauri/system";
import { useMediaStore } from "./mediaStore";
import { useTimelineStore, isTimelineDirty } from "./timelineStore";

type WorkspaceStatus = "booting" | "picker" | "editor";

interface WorkspaceState {
  status: WorkspaceStatus;
  appInfo: AppInfo | null;
  ffmpeg: FfmpegStatus | null;
  recentProjects: ProjectSummary[];
  project: ProjectInfo | null;
  busy: boolean;
  closing: boolean;
  error: string | null;
  initialize: () => Promise<void>;
  refreshFfmpeg: (refresh?: boolean) => Promise<void>;
  loadRecentProjects: () => Promise<void>;
  createProject: (name: string, parentDir?: string) => Promise<boolean>;
  openProject: (rootPath: string) => Promise<boolean>;
  closeProject: () => Promise<void>;
  forgetProject: (projectId: string) => Promise<void>;
  clearError: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  status: "booting",
  appInfo: null,
  ffmpeg: null,
  recentProjects: [],
  project: null,
  busy: false,
  closing: false,
  error: null,

  initialize: async () => {
    try {
      const [appInfo, ffmpeg, project] = await Promise.all([
        getAppInfo(),
        resolveFfmpeg(),
        currentProject(),
      ]);

      if (project) {
        set({ appInfo, ffmpeg, project, status: "editor" });
        await useMediaStore.getState().load();
        await useTimelineStore.getState().load(project);
        return;
      }

      set({ appInfo, ffmpeg, status: "picker" });
      await get().loadRecentProjects();
    } catch (error) {
      set({ error: errorMessage(error), status: "picker" });
    }
  },

  refreshFfmpeg: async (refresh = false) => {
    try {
      set({ ffmpeg: await resolveFfmpeg(refresh) });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  loadRecentProjects: async () => {
    try {
      set({ recentProjects: await listRecentProjects() });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  createProject: async (name, parentDir) => {
    set({ busy: true, error: null });
    try {
      const project = await createProjectCommand(name, parentDir);
      set({ project, status: "editor", busy: false });
      await useMediaStore.getState().load();
      await useTimelineStore.getState().load(project);
      return true;
    } catch (error) {
      set({ error: errorMessage(error), busy: false });
      return false;
    }
  },

  openProject: async (rootPath) => {
    set({ busy: true, error: null });
    try {
      const project = await openProjectCommand(rootPath);
      set({ project, status: "editor", busy: false });
      await useMediaStore.getState().load();
      await useTimelineStore.getState().load(project);
      return true;
    } catch (error) {
      set({ error: errorMessage(error), busy: false });
      return false;
    }
  },

  closeProject: async () => {
    if (useMediaStore.getState().importing) {
      set({ error: "Wait for the media import to finish before closing the project." });
      return;
    }
    if (isTimelineDirty(useTimelineStore.getState()) && !(await useTimelineStore.getState().save()))
      return;
    try {
      await closeProjectCommand();
    } catch (error) {
      set({ error: errorMessage(error) });
      return;
    }
    useMediaStore.getState().reset();
    useTimelineStore.getState().reset();
    set({ project: null, status: "picker" });
    await get().loadRecentProjects();
  },

  forgetProject: async (projectId) => {
    try {
      await forgetProjectCommand(projectId);
      await get().loadRecentProjects();
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  clearError: () => {
    set({ error: null });
  },
}));
