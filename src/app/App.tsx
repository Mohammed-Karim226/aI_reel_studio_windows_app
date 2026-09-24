import { useEffect } from "react";

import { Alerts } from "@/features/editor/Alerts";
import { BootScreen } from "@/features/editor/BootScreen";
import { EditorShell } from "@/features/editor/EditorShell";
import { useDesktopClose } from "@/features/editor/useDesktopClose";
import { ProjectPicker } from "@/features/projects/ProjectPicker";
import { disposeJobsListener, useJobsStore } from "@/stores/jobsStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

export default function App() {
  useDesktopClose();
  const status = useWorkspaceStore((state) => state.status);
  const closing = useWorkspaceStore((state) => state.closing);
  const initialize = useWorkspaceStore((state) => state.initialize);

  useEffect(() => {
    void initialize();
    void useJobsStore.getState().initialize();
  }, [initialize]);

  useEffect(() => disposeJobsListener, []);

  return (
    <>
      <div inert={closing}>
        {status === "booting" && <BootScreen />}
        {status === "picker" && <ProjectPicker />}
        {status === "editor" && <EditorShell />}
        <Alerts />
      </div>
      {closing && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/85 text-sm text-slate-100"
          role="status"
        >
          Saving project and stopping background work…
        </div>
      )}
    </>
  );
}
