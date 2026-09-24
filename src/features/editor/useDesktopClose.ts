import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { errorMessage } from "@/domain/errors";
import { isActiveJob } from "@/domain/jobs";
import { cancelJob, listJobs } from "@/infrastructure/tauri/jobs";
import { useMediaStore } from "@/stores/mediaStore";
import { isTimelineDirty, useTimelineStore } from "@/stores/timelineStore";
import { useTranscriptionStore } from "@/stores/transcriptionStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

const STOP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 250;

function assertReadyToClose(): void {
  if (useTranscriptionStore.getState().checking) {
    throw new Error("Wait for the speech setup check to finish before closing the app.");
  }
  if (useMediaStore.getState().importing) {
    throw new Error("Wait for the media import to finish before closing the app.");
  }
  if (
    useTimelineStore.getState().loading ||
    useMediaStore.getState().loading ||
    useWorkspaceStore.getState().busy ||
    useWorkspaceStore.getState().status === "booting"
  ) {
    throw new Error("Wait for the project to finish loading before closing the app.");
  }
}

async function saveEdits(): Promise<void> {
  const state = useTimelineStore.getState();
  if ((state.saving || isTimelineDirty(state)) && !(await state.save())) {
    throw new Error(
      `The app stayed open because your edits could not be saved. ${useTimelineStore.getState().error ?? "Try saving again before closing."}`,
    );
  }
}

async function stopJobs(isDisposed: () => boolean): Promise<void> {
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  const timeoutError = () =>
    new Error("Background work is still stopping. Wait a moment, then close the app again.");
  // The deadline also bounds an IPC request that never responds.
  const withinDeadline = <T>(operation: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        void operation.catch(() => undefined);
        reject(timeoutError());
        return;
      }
      const timer = setTimeout(() => reject(timeoutError()), remaining);
      operation.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });

  const requested = new Set<string>();
  while (!isDisposed()) {
    const jobs = await withinDeadline(listJobs());
    if (isDisposed()) return;
    const active = jobs.filter(isActiveJob);
    if (active.length === 0) return;
    await withinDeadline(
      Promise.all(
        active
          .filter((job) => !requested.has(job.id))
          .map((job) => {
            requested.add(job.id);
            return cancelJob(job.id);
          }),
      ),
    );
    if (isDisposed()) return;
    await withinDeadline(new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS)));
  }
}

/** Save the desktop document and stop native workers before X or Alt+F4 destroys the window. */
export function useDesktopClose(): void {
  useEffect(() => {
    if (!isTauri()) return;
    const appWindow = getCurrentWindow();
    let disposed = false;
    let closing = false;
    let unlisten: UnlistenFn | undefined;

    void appWindow
      .onCloseRequested(async (event) => {
        event.preventDefault();
        if (disposed || closing || useWorkspaceStore.getState().closing) return;
        closing = true;
        useWorkspaceStore.setState({ closing: true, error: null });
        let destroyed = false;
        try {
          assertReadyToClose();
          useTimelineStore.setState({ playing: false });
          document
            .querySelectorAll<HTMLMediaElement>("video, audio")
            .forEach((media) => media.pause());
          await saveEdits();
          if (disposed) return;
          await stopJobs(() => disposed);
          if (disposed) return;
          assertReadyToClose();
          await saveEdits();
          if (disposed) return;
          assertReadyToClose();
          await appWindow.destroy();
          destroyed = true;
        } catch (error) {
          if (!disposed) useWorkspaceStore.setState({ error: errorMessage(error) });
        } finally {
          closing = false;
          if (!disposed && !destroyed) useWorkspaceStore.setState({ closing: false });
        }
      })
      .then((removeListener) => {
        if (disposed) removeListener();
        else unlisten = removeListener;
      })
      .catch((error: unknown) => {
        if (!disposed) {
          useWorkspaceStore.setState({
            error: `Could not prepare desktop closing. Save your edits before exiting. ${errorMessage(error)}`,
          });
        }
      });

    return () => {
      disposed = true;
      if (closing) useWorkspaceStore.setState({ closing: false });
      unlisten?.();
    };
  }, []);
}
