import { useWorkspaceStore } from "@/stores/workspaceStore";

/** Full-screen state shown while the app talks to the native backend for the first time. */
export function BootScreen() {
  const error = useWorkspaceStore((state) => state.error);

  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center gap-3 text-slate-400"
      data-testid="boot-screen"
    >
      <p className="text-sm">Starting AI Reel Studio…</p>
      {error && <p className="text-xs text-rose-300">{error}</p>}
    </div>
  );
}
