import { useState } from "react";
import { AiCutPanel } from "@/features/aiCut/AiCutPanel";
import { EditReviewPanel } from "@/features/editReview/EditReviewPanel";
import { Button } from "@/shared/ui/Button";
import { JobsPanel } from "@/features/jobs/JobsPanel";
import { InspectorPanel } from "@/features/inspector/InspectorPanel";
import { MediaPanel } from "@/features/media/MediaPanel";
import { PreviewPanel } from "@/features/preview/PreviewPanel";
import { TopBar } from "./TopBar";
import { TimelinePanel } from "@/features/timeline/TimelinePanel";
import { ClipInspector } from "@/features/timeline/ClipInspector";
import { HookDesigner } from "@/features/hooks/HookDesigner";
import { CaptionDesigner } from "@/features/captions/CaptionDesigner";
import { EffectsInspector } from "@/features/effects/EffectsInspector";
import { useTimelineStore } from "@/stores/timelineStore";

/**
 * Editor layout from spec §27: media on the left, canvas in the middle, inspector on the right,
 * jobs pinned to the bottom. The timeline and vertical composition monitor share one master edit.
 */
export function EditorShell() {
  const [libraryTab, setLibraryTab] = useState<"media" | "aiCut" | "review">("media");
  const mode = useTimelineStore((state) => state.mode);
  const projectId = useTimelineStore((state) => state.projectId);
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar />

      <div className="flex min-h-0 flex-1">
        <aside
          className={`${libraryTab === "media" ? "w-60" : "w-80"} flex shrink-0 flex-col border-r border-slate-800 bg-slate-900/30`}
        >
          <div className="flex gap-2 border-b border-slate-800 p-2" aria-label="Library tools">
            <Button
              size="sm"
              variant={libraryTab === "media" ? "primary" : "ghost"}
              onClick={() => setLibraryTab("media")}
            >
              Media
            </Button>
            <Button
              size="sm"
              variant={libraryTab === "aiCut" ? "primary" : "ghost"}
              onClick={() => setLibraryTab("aiCut")}
            >
              AI Cut
            </Button>
            <Button
              size="sm"
              variant={libraryTab === "review" ? "primary" : "ghost"}
              onClick={() => setLibraryTab("review")}
            >
              AI Review
            </Button>
          </div>
          <div hidden={libraryTab !== "media"} className="min-h-0 flex-1">
            <MediaPanel />
          </div>
          <div hidden={libraryTab !== "aiCut"} className="min-h-0 flex-1 overflow-y-auto">
            <AiCutPanel key={projectId} />
          </div>
          <div hidden={libraryTab !== "review"} className="min-h-0 flex-1 overflow-y-auto">
            <EditReviewPanel key={projectId} />
          </div>
        </aside>
        <main className="min-w-0 flex-1">
          <PreviewPanel />
        </main>
        <aside className="w-64 shrink-0 overflow-y-auto border-l border-slate-800 bg-slate-900/30">
          <div hidden={mode !== "timeline"}>
            <ClipInspector />
            <EffectsInspector key={`effects:${projectId}`} />
            <CaptionDesigner key={projectId} />
            <HookDesigner />
          </div>
          {mode !== "timeline" && <InspectorPanel />}
        </aside>
      </div>

      <TimelinePanel />

      <JobsPanel />
    </div>
  );
}
