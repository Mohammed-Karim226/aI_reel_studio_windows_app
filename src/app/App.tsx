import { useEffect } from "react";

import { Alerts } from "@/features/editor/Alerts";
import { BootScreen } from "@/features/editor/BootScreen";
import { EditorShell } from "@/features/editor/EditorShell";
import { ProjectPicker } from "@/features/projects/ProjectPicker";
import { disposeJobsListener, useJobsStore } from "@/stores/jobsStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

export default function App() {
  const status = useWorkspaceStore((state) => state.status);
  const initialize = useWorkspaceStore((state) => state.initialize);

  useEffect(() => {
    void initialize();
    void useJobsStore.getState().initialize();
  }, [initialize]);

  useEffect(() => disposeJobsListener, []);

  return (
    <>
      {status === "booting" && <BootScreen />}
      {status === "picker" && <ProjectPicker />}
      {status === "editor" && <EditorShell />}
      <Alerts />
    </>
  );
}
