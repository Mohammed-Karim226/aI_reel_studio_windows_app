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
  const mode = useTimelineStore((state) => state.mode);
  const projectId = useTimelineStore((state) => state.projectId);
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar />

      <div className="flex min-h-0 flex-1">
        <aside className="w-60 shrink-0 border-r border-slate-800 bg-slate-900/30">
          <MediaPanel />
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
