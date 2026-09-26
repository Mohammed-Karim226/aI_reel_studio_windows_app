import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaAsset } from "@/domain/media";
import type { ProjectInfo } from "@/domain/projects";
import { applyEdit } from "@/domain/timeline/edit";
import { createTimeline, deserializeTimeline, serializeTimeline } from "@/domain/timeline/model";
import { useEditReviewStore } from "./editReviewStore";
import { useMediaStore } from "./mediaStore";
import { isTimelineDirty, useTimelineStore } from "./timelineStore";
import { useWorkspaceStore } from "./workspaceStore";

const { loadMock, saveMock } = vi.hoisted(() => ({ loadMock: vi.fn(), saveMock: vi.fn() }));
vi.mock("@/infrastructure/tauri/timeline", () => ({
  loadTimeline: loadMock,
  saveTimeline: saveMock,
}));

const asset: MediaAsset = {
  id: "source",
  originalPath: "C:\\media\\interview.mp4",
  fileName: "interview.mp4",
  kind: "video",
  container: "mp4",
  sizeBytes: 1000,
  durationSec: 60,
  hasVideo: true,
  hasAudio: true,
  video: null,
  audio: null,
  importedAt: "2026-09-26",
  derivatives: [],
};
const project: ProjectInfo = {
  id: "review-project",
  rootPath: "C:\\projects\\review",
  name: "Review",
  format: { width: 1080, height: 1920, fps: 30 },
  createdAt: "2026-09-26",
  mediaCount: 1,
};

beforeEach(() => {
  useEditReviewStore.getState().reset();
  useTimelineStore.getState().reset();
  useWorkspaceStore.setState({ status: "editor", project, closing: false, busy: false });
  useMediaStore.setState({ assets: [structuredClone(asset)], loading: false });
  const empty = createTimeline(project.format);
  const timeline = applyEdit(
    empty,
    { type: "add", trackId: empty.tracks[0].id, asset, start: 0, sourceStart: 10, sourceEnd: 30 },
    [asset],
  );
  useTimelineStore.setState({
    projectId: project.id,
    timeline,
    saved: serializeTimeline(timeline),
  });
  loadMock.mockReset();
  saveMock.mockReset().mockResolvedValue(undefined);
});

const review = () => useEditReviewStore.getState();
const editor = () => useTimelineStore.getState();
function zoomId() {
  review().review();
  return review().suggestions.find((suggestion) => suggestion.category === "zoom")!.id;
}

describe("review preview and accepted edits", () => {
  it("previews an actual effect without dirtying, changing history, or saving the proposal", async () => {
    const before = editor().timeline;
    const id = zoomId();
    expect(review().previewSuggestion(id)).toBe(true);
    expect(review().preview!.timeline.tracks[0].clips[0].effects).toHaveLength(1);
    expect(editor().timeline).toBe(before);
    expect(editor().past).toHaveLength(0);
    expect(isTimelineDirty(editor())).toBe(false);
    expect(await editor().save()).toBe(true);
    expect(saveMock).not.toHaveBeenCalled();
    review().clearPreview();
    expect(review().preview).toBeNull();
    expect(editor().timeline).toBe(before);
  });

  it("applies once, refreshes findings, and preserves the accepted change through undo, redo, save and load", async () => {
    const before = serializeTimeline(editor().timeline!);
    const id = zoomId();
    expect(review().apply(id)).toBe(true);
    const applied = serializeTimeline(editor().timeline!);
    expect(editor().past).toHaveLength(1);
    expect(review().stale).toBe(false);
    expect(review().suggestions.some((suggestion) => suggestion.id === id)).toBe(false);
    expect(review().apply(id)).toBe(false);
    expect(editor().past).toHaveLength(1);
    editor().undo();
    expect(serializeTimeline(editor().timeline!)).toBe(before);
    expect(review().stale).toBe(true);
    editor().redo();
    expect(serializeTimeline(editor().timeline!)).toBe(applied);
    expect(await editor().save()).toBe(true);
    expect(saveMock).toHaveBeenCalledWith(project.id, editor().timeline);
    loadMock.mockResolvedValue(deserializeTimeline(applied));
    await editor().load(project);
    expect(serializeTimeline(editor().timeline!)).toBe(applied);
    expect(review().hasReview).toBe(false);
  });

  it("requires actual hook text and edits the opening hook without fabricating caption words", () => {
    review().review();
    const id = review().suggestions.find(
      (suggestion) => suggestion.action?.type === "openingHook",
    )!.id;
    expect(review().hookText).toBe("");
    expect(review().apply(id)).toBe(false);
    expect(editor().past).toHaveLength(0);
    review().setHookText("ما الذي تغير؟");
    expect(review().previewSuggestion(id)).toBe(true);
    review().setHookText("لماذا تغير؟");
    expect(review().preview).toBeNull();
    expect(review().apply(id)).toBe(true);
    expect(editor().timeline!.hook.layers[0].text).toBe("لماذا تغير؟");
    expect(editor().timeline!.captions.segments).toHaveLength(0);
  });

  it("seeks manual findings without allowing them to be applied", () => {
    review().review();
    const finding = review().suggestions.find((suggestion) => suggestion.category === "pacing")!;
    expect(finding.action).toBeNull();
    expect(review().previewSuggestion(finding.id)).toBe(true);
    expect(review().preview!.timeline).toBe(editor().timeline);
    expect(review().apply(finding.id)).toBe(false);
    expect(editor().past).toHaveLength(0);
    review().ignore(finding.id);
    expect(review().preview).toBeNull();
    expect(review().previewSuggestion(finding.id)).toBe(false);
  });
});

describe("review lifecycle and validation", () => {
  it("invalidates suggestions and exits preview as soon as the timeline is edited", () => {
    const id = zoomId();
    review().previewSuggestion(id);
    editor().edit({
      type: "transform",
      id: editor().timeline!.tracks[0].clips[0].id,
      patch: { scale: 1.1 },
    });
    expect(review().preview).toBeNull();
    expect(review().stale).toBe(true);
    expect(review().apply(id)).toBe(false);
    expect(editor().past).toHaveLength(1);
  });

  it("clears project review state on project replacement, even with the same project id", () => {
    const id = zoomId();
    review().previewSuggestion(id);
    useWorkspaceStore.setState({ project: { ...project, rootPath: "C:\\projects\\other" } });
    expect(review().hasReview).toBe(false);
    expect(review().preview).toBeNull();
    expect(review().apply(id)).toBe(false);
  });

  it("keeps review on derivative refresh, but invalidates a replaced source", () => {
    const id = zoomId();
    review().previewSuggestion(id);
    useMediaStore.setState({
      assets: [
        {
          ...asset,
          derivatives: [
            {
              id: "proxy",
              mediaAssetId: asset.id,
              kind: "proxy",
              status: "ready",
              relativePath: "proxy.mp4",
              params: {},
              error: null,
              createdAt: "today",
              updatedAt: "today",
            },
          ],
        },
      ],
    });
    expect(review().stale).toBe(false);
    expect(review().preview).not.toBeNull();
    useMediaStore.setState({ assets: [{ ...asset, originalPath: "C:\\media\\replacement.mp4" }] });
    expect(review().stale).toBe(true);
    expect(review().preview).toBeNull();
    expect(review().apply(id)).toBe(false);
  });

  it("exits preview on source monitor switching and closing, and rejects changes while closing", () => {
    const id = zoomId();
    review().previewSuggestion(id);
    useTimelineStore.setState({ mode: "source" });
    expect(review().preview).toBeNull();
    review().previewSuggestion(id);
    useWorkspaceStore.setState({ closing: true });
    expect(review().preview).toBeNull();
    expect(review().apply(id)).toBe(false);
    expect(editor().past).toHaveLength(0);
  });

  it("invalidates review on platform changes and rejects unvalidated actions", () => {
    const id = zoomId();
    review().previewSuggestion(id);
    review().setPlatform("tiktok");
    expect(review().stale).toBe(true);
    expect(review().preview).toBeNull();
    expect(review().apply(id)).toBe(false);
    review().review();
    useEditReviewStore.setState({
      suggestions: review().suggestions.map((suggestion) =>
        suggestion.id === id ? { ...suggestion, end: Infinity } : suggestion,
      ),
    });
    expect(review().apply(id)).toBe(false);
    expect(editor().past).toHaveLength(0);
  });
});
