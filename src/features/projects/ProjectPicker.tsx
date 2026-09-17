import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";

import { defaultProjectsDir } from "@/infrastructure/tauri/system";
import { Button } from "@/shared/ui/Button";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { FfmpegSetupCard } from "@/features/system/FfmpegSetupCard";
import { FfmpegStatusBadge } from "@/features/system/FfmpegStatusBadge";

export function ProjectPicker() {
  const appInfo = useWorkspaceStore((state) => state.appInfo);
  const recentProjects = useWorkspaceStore((state) => state.recentProjects);
  const busy = useWorkspaceStore((state) => state.busy);
  const createProject = useWorkspaceStore((state) => state.createProject);
  const openProject = useWorkspaceStore((state) => state.openProject);
  const forgetProject = useWorkspaceStore((state) => state.forgetProject);

  const [name, setName] = useState("");
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [defaultDir, setDefaultDir] = useState<string | null>(null);

  // The backend owns the default location (Documents, with an app-data fallback), so ask it
  // instead of hardcoding a path that may not match what creation actually uses.
  useEffect(() => {
    let cancelled = false;
    defaultProjectsDir()
      .then((dir) => {
        if (!cancelled) {
          setDefaultDir(dir);
        }
      })
      .catch(() => {
        // The label is cosmetic; creation still works with the backend default.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function chooseLocation() {
    const selection = await open({ directory: true, title: "Project location" });
    if (typeof selection === "string") {
      setParentDir(selection);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    const created = await createProject(trimmed, parentDir ?? undefined);
    if (created) {
      setName("");
    }
  }

  async function openExisting() {
    const selection = await open({ directory: true, title: "Open project folder" });
    if (typeof selection === "string") {
      await openProject(selection);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-8 py-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">AI Reel Studio</h1>
          <p className="text-xs text-slate-400">
            {appInfo ? `v${appInfo.version} · ${appInfo.platform}` : "starting…"}
          </p>
        </div>
        <FfmpegStatusBadge />
      </header>

      <FfmpegSetupCard />

      <section className="rounded-lg border border-slate-700 bg-slate-900/50 p-5">
        <h2 className="text-sm font-semibold text-slate-100">New project</h2>
        <form className="mt-3 flex flex-col gap-3" onSubmit={submit}>
          <div className="flex gap-3">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Project name"
              aria-label="Project name"
              className="h-9 flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-indigo-500"
            />
            <Button type="submit" variant="primary" disabled={busy || name.trim().length === 0}>
              {busy ? "Creating…" : "Create project"}
            </Button>
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span className="truncate" title={parentDir ?? defaultDir ?? undefined}>
              Location: {parentDir ?? defaultDir ?? "the Documents folder"}
            </span>
            <Button size="sm" variant="ghost" onClick={chooseLocation}>
              Change…
            </Button>
          </div>
        </form>
      </section>

      <section className="rounded-lg border border-slate-700 bg-slate-900/50 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-100">Recent projects</h2>
          <Button size="sm" variant="ghost" onClick={openExisting}>
            Open folder…
          </Button>
        </div>

        {recentProjects.length === 0 ? (
          <p className="mt-3 text-xs text-slate-500">
            No projects yet. Create one to import a long video and start a Reel.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-800">
            {recentProjects.map((project) => (
              <li key={project.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm text-slate-100">{project.name}</p>
                  <p className="truncate text-[11px] text-slate-500" title={project.rootPath}>
                    {project.rootPath}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void openProject(project.rootPath)}
                    disabled={busy}
                  >
                    Open
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void forgetProject(project.id)}
                    title="Remove from this list. Files are kept."
                  >
                    Forget
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
