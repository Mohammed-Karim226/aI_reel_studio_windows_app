import { z } from "zod";

import { toAppError } from "@/domain/errors";
import {
  appInfoSchema,
  ffmpegStatusSchema,
  type AppInfo,
  type FfmpegStatus,
} from "@/domain/system";
import { invokeCommand } from "./invoke";

export function getAppInfo(): Promise<AppInfo> {
  return invokeCommand("get_app_info", {}, appInfoSchema);
}

/**
 * Reports the FFmpeg installation, degrading to "unavailable" instead of rejecting: the app stays
 * usable without FFmpeg, so a discovery failure is a state, not an error (spec §42).
 */
export async function resolveFfmpeg(refresh = false): Promise<FfmpegStatus> {
  try {
    return await invokeCommand("resolve_ffmpeg", { refresh }, ffmpegStatusSchema);
  } catch (error) {
    return { available: false, tools: null, error: toAppError(error).message };
  }
}

export function configureFfmpeg(ffmpegPath: string, ffprobePath?: string): Promise<FfmpegStatus> {
  return invokeCommand(
    "configure_ffmpeg",
    { ffmpegPath, ffprobePath: ffprobePath ?? null },
    ffmpegStatusSchema,
  );
}

export function defaultProjectsDir(): Promise<string> {
  return invokeCommand("default_projects_dir", {}, z.string());
}
