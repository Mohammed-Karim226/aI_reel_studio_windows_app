import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
}));

import App from "./App";
import { useJobsStore } from "@/stores/jobsStore";
import { useMediaStore } from "@/stores/mediaStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

const ffmpegAvailable = {
  available: true,
  tools: {
    ffmpegPath: "C:\\ffmpeg\\bin\\ffmpeg.exe",
    ffprobePath: "C:\\ffmpeg\\bin\\ffprobe.exe",
    version: "7.1.1",
    source: "systemPath",
  },
  error: null,
};

const ffmpegMissing = {
  available: false,
  tools: null,
  error: "ffmpeg.exe and ffprobe.exe were not found. Searched: C:\\Windows",
};

const audioAsset = {
  id: "m1",
  originalPath: "D:\\media\\podcast.mp4",
  fileName: "podcast.mp4",
  kind: "video",
  container: "mov,mp4",
  sizeBytes: 4_294_967_296,
  durationSec: 3600,
  hasVideo: true,
  hasAudio: true,
  video: {
    codec: "h264",
    width: 3840,
    height: 2160,
    displayWidth: 3840,
    displayHeight: 2160,
    fps: 29.97,
    rotation: 0,
    pixFmt: "yuv420p",
    bitRate: 45_000_000,
  },
  audio: { codec: "aac", channels: 2, sampleRate: 48_000, bitRate: 192_000 },
  importedAt: "2026-01-01T00:00:00+00:00",
  derivatives: [],
};

function resetStores() {
  useWorkspaceStore.setState({
    status: "booting",
    appInfo: null,
    ffmpeg: null,
    recentProjects: [],
    project: null,
    busy: false,
    error: null,
  });
  useMediaStore.setState({
    assets: [],
    selectedId: null,
    loading: false,
    importing: false,
    error: null,
    notice: null,
  });
  useJobsStore.setState({ jobs: [], listening: true, error: null });
}

beforeEach(() => {
  invokeMock.mockReset();
  resetStores();
});

describe("App", () => {
  it("lands on the project picker and lists recent projects", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      switch (command) {
        case "get_app_info":
          return { name: "AI Reel Studio", version: "0.1.0", platform: "windows" };
        case "resolve_ffmpeg":
          return ffmpegAvailable;
        case "current_project":
          return null;
        case "list_recent_projects":
          return [
            {
              id: "p1",
              name: "Podcast Reels",
              rootPath: "D:\\projects\\podcast",
              createdAt: "2026-01-01T00:00:00+00:00",
              updatedAt: "2026-01-01T00:00:00+00:00",
              lastOpenedAt: null,
            },
          ];
        case "list_jobs":
          return [];
        case "default_projects_dir":
          return "C:\\Users\\test\\Documents\\AI Reel Studio";
        default:
          throw new Error(`unexpected command ${command}`);
      }
    });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "AI Reel Studio" })).toBeInTheDocument();
    expect(await screen.findByText("Podcast Reels")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create project" })).toBeInTheDocument();
    // The default location comes from the backend, not from a hardcoded UI string.
    expect(
      await screen.findByTitle("C:\\Users\\test\\Documents\\AI Reel Studio"),
    ).toBeInTheDocument();
  });

  it("explains how to install FFmpeg when none is found", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      switch (command) {
        case "get_app_info":
          return { name: "AI Reel Studio", version: "0.1.0", platform: "windows" };
        case "resolve_ffmpeg":
          return ffmpegMissing;
        case "current_project":
          return null;
        case "list_recent_projects":
          return [];
        case "list_jobs":
          return [];
        case "default_projects_dir":
          return "C:\\Users\\test\\Documents\\AI Reel Studio";
        default:
          throw new Error(`unexpected command ${command}`);
      }
    });

    render(<App />);

    expect(await screen.findByTestId("ffmpeg-setup")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Locate ffmpeg.exe" })).toBeInTheDocument();
  });

  it("opens the editor when an existing project is opened", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      switch (command) {
        case "get_app_info":
          return { name: "AI Reel Studio", version: "0.1.0", platform: "windows" };
        case "resolve_ffmpeg":
          return ffmpegAvailable;
        case "current_project":
          return null;
        case "list_recent_projects":
          return [
            {
              id: "p1",
              name: "Podcast Reels",
              rootPath: "D:\\projects\\podcast",
              createdAt: "2026-01-01T00:00:00+00:00",
              updatedAt: "2026-01-01T00:00:00+00:00",
              lastOpenedAt: null,
            },
          ];
        case "list_jobs":
          return [];
        case "default_projects_dir":
          return "C:\\Users\\test\\Documents\\AI Reel Studio";
        case "open_project":
          return {
            id: "p1",
            name: "Podcast Reels",
            rootPath: "D:\\projects\\podcast",
            createdAt: "2026-01-01T00:00:00+00:00",
            format: { width: 1080, height: 1920, fps: 30 },
            mediaCount: 1,
          };
        case "list_media":
          return [audioAsset];
        default:
          throw new Error(`unexpected command ${command}`);
      }
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Open" }));

    await waitFor(() => {
      expect(screen.getByText("Media (1)")).toBeInTheDocument();
    });
    expect(screen.getAllByText("podcast.mp4").length).toBeGreaterThan(0);
    expect(screen.getByText(/Timeline · Phase 2 — not implemented yet/)).toBeInTheDocument();
  });
});
