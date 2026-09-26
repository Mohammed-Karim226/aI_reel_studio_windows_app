import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewSuggestion } from "@/domain/editReview/model";
import type { MediaAsset } from "@/domain/media";
import { createTimeline, defaultTransform } from "@/domain/timeline/model";
import { useEditReviewStore } from "@/stores/editReviewStore";
import { useMediaStore } from "@/stores/mediaStore";
import { useTimelineStore } from "@/stores/timelineStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { EditReviewPanel } from "./EditReviewPanel";

const { analyzeMock } = vi.hoisted(() => ({ analyzeMock: vi.fn() }));
vi.mock("@/domain/editReview/analyze", () => ({ analyzeReel: analyzeMock }));

const format = { width: 1080, height: 1920, fps: 30 };
const asset: MediaAsset = {
  id: "video",
  originalPath: "C:\\media\\interview.mp4",
  fileName: "interview.mp4",
  kind: "video",
  container: "mp4",
  sizeBytes: 1000,
  durationSec: 20,
  hasVideo: true,
  hasAudio: true,
  video: null,
  audio: null,
  importedAt: "2026-09-26",
  derivatives: [],
};
const opening: ReviewSuggestion = {
  id: "opening",
  category: "hook",
  title: "Add an opening line",
  explanation: "No opening text is visible in the first two seconds.",
  start: 0,
  end: 2,
  action: { type: "openingHook", text: "" },
};
const manual: ReviewSuggestion = {
  id: "pacing",
  category: "pacing",
  title: "Review this long shot",
  explanation: "Play this section and trim any pauses that do not help the story.",
  start: 4,
  end: 10,
  action: null,
};

beforeEach(() => {
  useEditReviewStore.getState().reset();
  useTimelineStore.getState().reset();
  useWorkspaceStore.setState({
    status: "editor",
    busy: false,
    closing: false,
    project: {
      id: "project",
      name: "Interview",
      rootPath: "C:\\projects\\interview",
      createdAt: "2026-09-26",
      mediaCount: 1,
      format,
    },
  });
  const timeline = createTimeline(format);
  timeline.duration = 10;
  timeline.hook.enabled = false;
  timeline.hook.layers = [];
  timeline.tracks[0].clips = [
    {
      id: "clip",
      sourceMediaId: asset.id,
      label: asset.fileName,
      sourceStart: 0,
      sourceEnd: 10,
      timelineStart: 0,
      timelineEnd: 10,
      speed: 1,
      enabled: true,
      transform: { ...defaultTransform },
      effects: [],
    },
  ];
  useTimelineStore.setState({ timeline, projectId: "project", loading: false });
  useMediaStore.setState({ assets: [asset], loading: false });
  analyzeMock.mockReset().mockReturnValue([opening, manual]);
});

function review() {
  fireEvent.click(screen.getByRole("button", { name: "Review timeline" }));
}

describe("Edit review panel", () => {
  it("guides an empty timeline before running a review", () => {
    useTimelineStore.setState({ timeline: createTimeline(format) });
    render(<EditReviewPanel />);
    expect(screen.getByRole("button", { name: "Review timeline" })).toBeDisabled();
    expect(screen.getByText("Add media to the timeline to review your edit.")).toBeVisible();
    expect(screen.getByText(/do not inspect video frames or listen to audio/)).toBeVisible();
    expect(analyzeMock).not.toHaveBeenCalled();
  });

  it("requires hook text, previews without editing, and commits one undoable change", () => {
    const before = useTimelineStore.getState().timeline;
    render(<EditReviewPanel />);
    review();
    const preview = screen.getByRole("button", { name: `Preview ${opening.title}` });
    const apply = screen.getByRole("button", { name: `Apply ${opening.title}` });
    expect(preview).toBeDisabled();
    expect(apply).toBeDisabled();
    expect(apply).toHaveAccessibleDescription(/Enter hook text/);
    fireEvent.change(screen.getByRole("textbox", { name: "Opening hook text" }), {
      target: { value: "Start with the useful detail" },
    });
    fireEvent.click(preview);
    expect(useTimelineStore.getState().timeline).toBe(before);
    expect(useTimelineStore.getState().past).toHaveLength(0);
    expect(useEditReviewStore.getState().preview?.timeline.hook.layers[0].text).toBe(
      "Start with the useful detail",
    );
    expect(preview).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByRole("textbox", { name: "Opening hook text" }), {
      target: { value: "ابدأ بالفكرة المهمة" },
    });
    expect(useEditReviewStore.getState().preview).toBeNull();
    fireEvent.click(preview);
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(useEditReviewStore.getState().preview).toBeNull();
    expect(useTimelineStore.getState().timeline).toBe(before);
    analyzeMock.mockReturnValue([manual]);
    fireEvent.click(apply);
    expect(useTimelineStore.getState().timeline?.hook.layers[0].text).toBe("ابدأ بالفكرة المهمة");
    expect(useTimelineStore.getState().past).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Suggestion applied");
    act(() => useTimelineStore.getState().undo());
    expect(useTimelineStore.getState().timeline).toBe(before);
    expect(screen.getByRole("button", { name: `Preview ${manual.title}` })).toBeDisabled();
  });

  it("previews manual guidance, explains the disabled Apply, and lets the user ignore it", () => {
    analyzeMock.mockReturnValue([manual]);
    const before = useTimelineStore.getState().timeline;
    render(<EditReviewPanel />);
    review();
    const card = screen.getByRole("article", { name: manual.title });
    const apply = within(card).getByRole("button", { name: `Apply ${manual.title}` });
    expect(apply).toBeDisabled();
    expect(apply).toHaveAccessibleDescription(/manual edit/);
    expect(within(card).getByText("0:04.0–0:10.0")).toBeVisible();
    fireEvent.click(within(card).getByRole("button", { name: `Preview ${manual.title}` }));
    expect(useTimelineStore.getState().playhead).toBe(4);
    expect(useTimelineStore.getState().timeline).toBe(before);
    expect(screen.getByText(manual.explanation)).toBeVisible();
    fireEvent.click(within(card).getByRole("button", { name: `Ignore ${manual.title}` }));
    expect(screen.queryByRole("article", { name: manual.title })).not.toBeInTheDocument();
    expect(useEditReviewStore.getState().preview).toBeNull();
    expect(screen.getByText(/All suggestions ignored/)).toBeVisible();
  });

  it("requires a fresh review when the platform changes", () => {
    render(<EditReviewPanel />);
    review();
    fireEvent.change(screen.getByRole("combobox", { name: "Platform safe zones" }), {
      target: { value: "tiktok" },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Review again to refresh suggestions");
    expect(screen.getByRole("button", { name: `Preview ${manual.title}` })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Opening hook text" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Review again" }));
    expect(analyzeMock).toHaveBeenLastCalledWith(useTimelineStore.getState().timeline, "tiktok");
    expect(screen.getByRole("button", { name: `Preview ${manual.title}` })).toBeEnabled();
  });

  it.each(["closing", "busy", "loading", "saving"] as const)(
    "disables review controls while the project is %s",
    (state) => {
      render(<EditReviewPanel />);
      review();
      act(() => {
        if (state === "closing" || state === "busy") useWorkspaceStore.setState({ [state]: true });
        else useTimelineStore.setState({ [state]: true });
      });
      for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
      expect(screen.getByRole("combobox", { name: "Platform safe zones" })).toBeDisabled();
      const hook = screen.queryByRole("textbox", { name: "Opening hook text" });
      if (hook) expect(hook).toBeDisabled();
    },
  );

  it("exposes review failures as an alert", () => {
    analyzeMock.mockImplementation(() => {
      throw new Error("The timeline could not be reviewed.");
    });
    render(<EditReviewPanel />);
    review();
    expect(screen.getByRole("alert")).toHaveTextContent("The timeline could not be reviewed.");
  });
});
