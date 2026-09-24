import type { UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";

import { errorMessage } from "@/domain/errors";
import { isActiveJob, type JobSnapshot } from "@/domain/jobs";
import { onJobUpdate } from "@/infrastructure/tauri/events";
import { cancelJob, clearFinishedJobs, listJobs } from "@/infrastructure/tauri/jobs";
import { useMediaStore } from "./mediaStore";

interface JobsState {
  jobs: JobSnapshot[];
  listening: boolean;
  error: string | null;
  initialize: () => Promise<void>;
  cancel: (jobId: string) => Promise<void>;
  clearFinished: () => Promise<void>;
}

let unlisten: UnlistenFn | null = null;

export const useJobsStore = create<JobsState>((set, get) => ({
  jobs: [],
  listening: false,
  error: null,

  initialize: async () => {
    try {
      set({ jobs: await listJobs() });
    } catch (error) {
      set({ error: errorMessage(error) });
    }

    if (get().listening) {
      return;
    }
    set({ listening: true });

    unlisten = await onJobUpdate((job) => {
      set((state) => ({ jobs: upsert(state.jobs, job) }));

      // Derivative artifacts only exist once the job finishes; refresh just that asset so the
      // library shows the new thumbnail/proxy/waveform without reloading everything.
      if (!isActiveJob(job) && job.mediaAssetId && job.kind !== "transcription") {
        void useMediaStore.getState().refreshAsset(job.mediaAssetId);
      }
    });
  },

  cancel: async (jobId) => {
    try {
      await cancelJob(jobId);
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  clearFinished: async () => {
    try {
      await clearFinishedJobs();
      set({ jobs: await listJobs() });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },
}));

export function disposeJobsListener(): void {
  unlisten?.();
  unlisten = null;
  // Clearing the flag matters: `initialize` refuses to register a listener while it is set, so
  // leaving it behind would silently stop job updates after any dispose/initialize cycle.
  useJobsStore.setState({ listening: false });
}

function upsert(jobs: JobSnapshot[], job: JobSnapshot): JobSnapshot[] {
  const index = jobs.findIndex((candidate) => candidate.id === job.id);
  if (index === -1) {
    return [job, ...jobs];
  }
  const next = [...jobs];
  next[index] = job;
  return next;
}
