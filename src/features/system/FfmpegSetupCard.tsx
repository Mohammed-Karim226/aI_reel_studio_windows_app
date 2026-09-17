import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";

import { errorMessage } from "@/domain/errors";
import { configureFfmpeg } from "@/infrastructure/tauri/system";
import { Button } from "@/shared/ui/Button";
import { useWorkspaceStore } from "@/stores/workspaceStore";

/**
 * Shown when no usable FFmpeg was found. The app deliberately keeps working without it — the
 * library, project management and metadata stay available — so this is a setup card, not a
 * fatal error screen (spec §29, §42).
 */
export function FfmpegSetupCard() {
  const ffmpeg = useWorkspaceStore((state) => state.ffmpeg);
  const refreshFfmpeg = useWorkspaceStore((state) => state.refreshFfmpeg);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (ffmpeg?.available) {
    return null;
  }

  async function locate() {
    const selection = await open({
      multiple: false,
      title: "Select ffmpeg.exe",
      filters: [{ name: "FFmpeg", extensions: ["exe"] }],
    });
    if (!selection || Array.isArray(selection)) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const status = await configureFfmpeg(selection);
      if (!status.available) {
        setError(status.error ?? "That binary could not be used.");
      }
      await refreshFfmpeg();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4"
      data-testid="ffmpeg-setup"
    >
      <h2 className="text-sm font-semibold text-amber-200">FFmpeg is required</h2>
      <p className="mt-1 text-xs leading-5 text-amber-200/80">
        FFmpeg powers export, proxies, thumbnails and waveforms. It is not bundled with the app in
        v1. Install it with{" "}
        <code className="rounded bg-slate-900/60 px-1 py-0.5">winget install Gyan.FFmpeg</code> or
        point the app at an existing{" "}
        <code className="rounded bg-slate-900/60 px-1 py-0.5">ffmpeg.exe</code>.
      </p>
      {ffmpeg?.error && <p className="mt-2 text-[11px] text-amber-200/60">{ffmpeg.error}</p>}
      {error && <p className="mt-2 text-[11px] text-rose-300">{error}</p>}
      <Button className="mt-3" size="sm" onClick={locate} disabled={busy}>
        {busy ? "Checking…" : "Locate ffmpeg.exe"}
      </Button>
    </div>
  );
}
