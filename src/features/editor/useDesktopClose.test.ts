import { act, renderHook } from "@testing-library/react";
import type * as TauriCore from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JobSnapshot } from "@/domain/jobs";
import { createTimeline, serializeTimeline } from "@/domain/timeline/model";
import { useMediaStore } from "@/stores/mediaStore";
import { isTimelineDirty, useTimelineStore } from "@/stores/timelineStore";
import { useTranscriptionStore } from "@/stores/transcriptionStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

const { nativeMock, listenMock, destroyMock, unlistenMock, listMock, cancelMock, saveMock } =
  vi.hoisted(() => ({
    nativeMock: vi.fn(),
    listenMock: vi.fn(),
    destroyMock: vi.fn(),
    unlistenMock: vi.fn(),
    listMock: vi.fn(),
    cancelMock: vi.fn(),
    saveMock: vi.fn(),
  }));

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof TauriCore>()),
  isTauri: nativeMock,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: listenMock, destroy: destroyMock }),
}));
vi.mock("@/infrastructure/tauri/jobs", () => ({ listJobs: listMock, cancelJob: cancelMock }));
vi.mock("@/infrastructure/tauri/timeline", () => ({
  saveTimeline: saveMock,
  loadTimeline: vi.fn(),
}));

import { useDesktopClose } from "./useDesktopClose";

type CloseHandler = (event: { preventDefault: () => void }) => Promise<void>;
let closeHandler: CloseHandler | undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function job(id: string, status: JobSnapshot["status"] = "running"): JobSnapshot {
  return {
    id,
    status,
    kind: "transcription",
    label: "Generate captions",
    progress: 0.1,
    message: null,
    error: null,
    mediaAssetId: "media-1",
    createdAt: "2026-09-23T12:00:00Z",
    updatedAt: "2026-09-23T12:00:00Z",
  };
}

function requestClose(): Promise<void> {
  const preventDefault = vi.fn();
  const completion = closeHandler!({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  return completion;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  closeHandler = undefined;
  nativeMock.mockReturnValue(true);
  listenMock.mockImplementation(async (handler: CloseHandler) => {
    closeHandler = handler;
    return unlistenMock;
  });
  listMock.mockResolvedValue([]);
  cancelMock.mockResolvedValue(null);
  destroyMock.mockResolvedValue(undefined);
  saveMock.mockResolvedValue(undefined);
  useWorkspaceStore.setState({ status: "editor", busy: false, closing: false, error: null });
  useMediaStore.setState({ importing: false, loading: false });
  useTranscriptionStore.setState({ checking: false });
  useTimelineStore.getState().reset();
  const timeline = createTimeline({ width: 1080, height: 1920, fps: 30 });
  useTimelineStore.setState({
    timeline,
    projectId: "project-1",
    saved: serializeTimeline(timeline),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("desktop close safety", () => {
  it("does not install a native listener in the browser", () => {
    nativeMock.mockReturnValue(false);
    renderHook(useDesktopClose);
    expect(listenMock).not.toHaveBeenCalled();
  });

  it("pauses playback and waits for dirty captions to finish saving before destroying", async () => {
    const save = deferred<void>();
    saveMock.mockReturnValue(save.promise);
    useTimelineStore.setState({ saved: null, playing: true });
    renderHook(useDesktopClose);
    let completion!: Promise<void>;
    await act(async () => {
      completion = requestClose();
    });
    expect(useTimelineStore.getState().playing).toBe(false);
    expect(useWorkspaceStore.getState().closing).toBe(true);
    expect(saveMock).toHaveBeenCalledOnce();
    expect(listMock).not.toHaveBeenCalled();
    expect(destroyMock).not.toHaveBeenCalled();

    await act(async () => {
      save.resolve();
      await completion;
    });
    expect(isTimelineDirty(useTimelineStore.getState())).toBe(false);
    expect(destroyMock).toHaveBeenCalledOnce();
  });

  it("keeps the window and dirty edits when saving fails", async () => {
    saveMock.mockRejectedValue(new Error("Disk is full"));
    useTimelineStore.setState({ saved: null });
    renderHook(useDesktopClose);
    await act(requestClose);
    expect(destroyMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
    expect(isTimelineDirty(useTimelineStore.getState())).toBe(true);
    expect(useWorkspaceStore.getState().error).toContain("Disk is full");
    expect(useWorkspaceStore.getState().closing).toBe(false);
  });

  it("coalesces repeated close requests while a save is pending", async () => {
    const save = deferred<void>();
    saveMock.mockReturnValue(save.promise);
    useTimelineStore.setState({ saved: null });
    renderHook(useDesktopClose);
    let first!: Promise<void>;
    await act(async () => {
      first = requestClose();
      await requestClose();
      await requestClose();
    });
    expect(saveMock).toHaveBeenCalledOnce();
    expect(destroyMock).not.toHaveBeenCalled();
    await act(async () => {
      save.resolve();
      await first;
    });
    expect(destroyMock).toHaveBeenCalledOnce();
  });

  it("cancels active jobs, waits for completion, and saves edits made while stopping", async () => {
    listMock
      .mockResolvedValueOnce([job("running"), job("queued", "queued"), job("done", "completed")])
      .mockResolvedValueOnce([job("running", "cancelled"), job("queued", "cancelled")]);
    useTimelineStore.setState({ saved: null });
    renderHook(useDesktopClose);
    let completion!: Promise<void>;
    await act(async () => {
      completion = requestClose();
    });
    expect(cancelMock.mock.calls).toEqual([["running"], ["queued"]]);
    expect(saveMock).toHaveBeenCalledOnce();
    expect(destroyMock).not.toHaveBeenCalled();
    // Simulates another editor update while the native cancellation request is in flight.
    useTimelineStore.getState().edit({
      type: "captions",
      captions: { ...useTimelineStore.getState().timeline!.captions, enabled: false },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await completion;
    });
    expect(saveMock).toHaveBeenCalledTimes(2);
    expect(isTimelineDirty(useTimelineStore.getState())).toBe(false);
    expect(destroyMock).toHaveBeenCalledOnce();
  });

  it("stays open after five seconds if a worker does not stop and allows retry", async () => {
    listMock.mockResolvedValue([job("stuck")]);
    renderHook(useDesktopClose);
    let completion!: Promise<void>;
    await act(async () => {
      completion = requestClose();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await completion;
    });
    expect(cancelMock).toHaveBeenCalledOnce();
    expect(destroyMock).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().error).toContain("still stopping");
    listMock.mockResolvedValue([]);
    await act(requestClose);
    expect(destroyMock).toHaveBeenCalledOnce();
  });

  it("also bounds an unresponsive list-jobs request", async () => {
    const response = deferred<JobSnapshot[]>();
    listMock.mockReturnValue(response.promise);
    renderHook(useDesktopClose);
    let completion!: Promise<void>;
    await act(async () => {
      completion = requestClose();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await completion;
      response.resolve([]);
    });
    expect(destroyMock).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().error).toContain("still stopping");
  });

  it("stays open when cancelling a worker fails", async () => {
    listMock.mockResolvedValue([job("worker")]);
    cancelMock.mockRejectedValue(new Error("Could not cancel worker"));
    renderHook(useDesktopClose);
    await act(requestClose);
    expect(destroyMock).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().error).toContain("Could not cancel worker");
  });

  it.each(["importing", "loading", "checking"] as const)(
    "blocks closing while %s",
    async (operation) => {
      if (operation === "importing") useMediaStore.setState({ importing: true });
      else if (operation === "checking") useTranscriptionStore.setState({ checking: true });
      else useTimelineStore.setState({ loading: true });
      renderHook(useDesktopClose);
      await act(requestClose);
      expect(saveMock).not.toHaveBeenCalled();
      expect(listMock).not.toHaveBeenCalled();
      expect(destroyMock).not.toHaveBeenCalled();
      expect(useWorkspaceStore.getState().error).toContain("Wait for");
    },
  );

  it("removes a listener that finishes registering after unmount", async () => {
    const registration = deferred<() => void>();
    listenMock.mockReturnValue(registration.promise);
    const hook = renderHook(useDesktopClose);
    hook.unmount();
    await act(async () => {
      registration.resolve(unlistenMock);
    });
    expect(unlistenMock).toHaveBeenCalledOnce();
  });

  it("does not continue closing after unmount during a pending save", async () => {
    const save = deferred<void>();
    saveMock.mockReturnValue(save.promise);
    useTimelineStore.setState({ saved: null });
    const hook = renderHook(useDesktopClose);
    let completion!: Promise<void>;
    await act(async () => {
      completion = requestClose();
    });
    hook.unmount();
    await act(async () => {
      save.resolve();
      await completion;
    });
    expect(unlistenMock).toHaveBeenCalledOnce();
    expect(listMock).not.toHaveBeenCalled();
    expect(destroyMock).not.toHaveBeenCalled();
  });
});
