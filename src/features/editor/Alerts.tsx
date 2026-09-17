import { Button } from "@/shared/ui/Button";
import { useMediaStore } from "@/stores/mediaStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

/** Non-blocking messages: import rejections and command errors (spec §29). */
export function Alerts() {
  const workspaceError = useWorkspaceStore((state) => state.error);
  const clearWorkspaceError = useWorkspaceStore((state) => state.clearError);
  const mediaError = useMediaStore((state) => state.error);
  const notice = useMediaStore((state) => state.notice);
  const clearMessages = useMediaStore((state) => state.clearMessages);

  if (!workspaceError && !mediaError && !notice) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(420px,80vw)] flex-col gap-2">
      {workspaceError && <Alert tone="bad" text={workspaceError} onDismiss={clearWorkspaceError} />}
      {mediaError && <Alert tone="bad" text={mediaError} onDismiss={clearMessages} />}
      {notice && <Alert tone="warn" text={notice} onDismiss={clearMessages} />}
    </div>
  );
}

interface AlertProps {
  tone: "bad" | "warn";
  text: string;
  onDismiss: () => void;
}

function Alert({ tone, text, onDismiss }: AlertProps) {
  const palette =
    tone === "bad"
      ? "border-rose-500/40 bg-rose-950/80 text-rose-100"
      : "border-amber-500/40 bg-amber-950/80 text-amber-100";

  return (
    <div
      className={`pointer-events-auto flex items-start gap-3 rounded-md border p-3 text-xs shadow-lg ${palette}`}
      role="alert"
    >
      <p className="flex-1 whitespace-pre-line leading-5">{text}</p>
      <Button size="sm" variant="ghost" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
