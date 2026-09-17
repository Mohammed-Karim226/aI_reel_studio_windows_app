import { JobsPanel } from "@/features/jobs/JobsPanel";
import { InspectorPanel } from "@/features/inspector/InspectorPanel";
import { MediaPanel } from "@/features/media/MediaPanel";
import { PreviewPanel } from "@/features/preview/PreviewPanel";
import { TopBar } from "./TopBar";

/**
 * Editor layout from spec §27: media on the left, canvas in the middle, inspector on the right,
 * jobs pinned to the bottom. Phase 2 adds the timeline track area.
 */
export function EditorShell() {
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar />

      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 border-r border-slate-800 bg-slate-900/30">
          <MediaPanel />
        </aside>
        <main className="min-w-0 flex-1">
          <PreviewPanel />
        </main>
        <aside className="w-80 shrink-0 border-l border-slate-800 bg-slate-900/30">
          <InspectorPanel />
        </aside>
      </div>

      <div className="shrink-0 border-t border-slate-800 bg-slate-950/60 px-3 py-1.5">
        <p className="text-[11px] text-slate-500">
          Timeline · Phase 2 — not implemented yet. This build covers projects, import and
          derivative generation.
        </p>
      </div>

      <JobsPanel />
    </div>
  );
}
