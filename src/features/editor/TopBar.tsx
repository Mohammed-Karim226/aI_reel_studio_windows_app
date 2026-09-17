import { Button } from "@/shared/ui/Button";
import { Pill } from "@/shared/ui/Pill";
import { FfmpegStatusBadge } from "@/features/system/FfmpegStatusBadge";
import { useWorkspaceStore } from "@/stores/workspaceStore";

export function TopBar() {
  const project = useWorkspaceStore((state) => state.project);
  const closeProject = useWorkspaceStore((state) => state.closeProject);

  if (!project) {
    return null;
  }

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-slate-800 bg-slate-900/70 px-4">
      <div className="flex min-w-0 items-center gap-3">
        <span className="text-sm font-semibold text-slate-100">{project.name}</span>
        <Pill tone="info">
          {project.format.width}×{project.format.height} · {project.format.fps} fps
        </Pill>
        <span
          className="hidden truncate text-[11px] text-slate-500 lg:inline"
          title={project.rootPath}
        >
          {project.rootPath}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <FfmpegStatusBadge />
        <Button size="sm" variant="ghost" onClick={() => void closeProject()}>
          Close project
        </Button>
      </div>
    </header>
  );
}
