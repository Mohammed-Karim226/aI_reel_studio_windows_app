import { Pill } from "@/shared/ui/Pill";
import { useWorkspaceStore } from "@/stores/workspaceStore";

export function FfmpegStatusBadge() {
  const ffmpeg = useWorkspaceStore((state) => state.ffmpeg);

  if (!ffmpeg) {
    return <Pill tone="neutral">FFmpeg …</Pill>;
  }
  if (ffmpeg.available && ffmpeg.tools) {
    return <Pill tone="good">FFmpeg {ffmpeg.tools.version}</Pill>;
  }
  return <Pill tone="bad">FFmpeg missing</Pill>;
}
