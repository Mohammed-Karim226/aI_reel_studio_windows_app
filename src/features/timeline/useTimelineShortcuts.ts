import { useEffect } from "react";
import { useTimelineStore } from "@/stores/timelineStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

export function useTimelineShortcuts() {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (useWorkspaceStore.getState().closing) return;
      if (
        event.target instanceof HTMLElement &&
        (event.target.closest("input, textarea, select, [contenteditable=true]") ||
          (event.target.closest("button, [role=button]") && event.code === "Space"))
      )
        return;
      const state = useTimelineStore.getState();
      const control = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (control && key === "s") {
        event.preventDefault();
        void state.save();
      } else if (control && key === "z") {
        event.preventDefault();
        if (event.shiftKey) state.redo();
        else state.undo();
      } else if (control && key === "y") {
        event.preventDefault();
        state.redo();
      } else if (control && key === "d") {
        event.preventDefault();
        state.edit({ type: "duplicate", ids: state.selectedIds });
      } else if (key === "delete" || key === "backspace") {
        event.preventDefault();
        state.edit({ type: "delete", ids: state.selectedIds, ripple: event.altKey });
      } else if (!control && key === "s") {
        event.preventDefault();
        state.edit({ type: "split", ids: state.selectedIds, at: state.playhead });
      } else if (event.code === "Space") {
        event.preventDefault();
        state.togglePlayback();
      } else if (key === "arrowleft" || key === "arrowright") {
        event.preventDefault();
        state.seek(state.playhead + (key === "arrowleft" ? -1 : 1) / (state.timeline?.fps ?? 30));
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);
}
