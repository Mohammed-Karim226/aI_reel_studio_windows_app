import { z } from "zod";

/**
 * Errors that cross the IPC boundary.
 *
 * The Rust side serializes `AppError` as `{ kind, message, retryable }`; `kind` is a stable
 * machine code, so the UI branches on it instead of matching human-readable text. This schema is
 * the single frontend definition, shared by command failures and job failures.
 */

export const APP_ERROR_KINDS = [
  "database",
  "io",
  "serde",
  "ffmpeg_unavailable",
  "tool_failed",
  "transcription_unavailable",
  "transcription_failed",
  "media_file_not_found",
  "unsupported_media",
  "project_not_found",
  "media_asset_not_found",
  "no_project_open",
  "job_cancelled",
  "job_not_found",
  "invalid_input",
  "internal",
] as const;

export type AppErrorKind = (typeof APP_ERROR_KINDS)[number];

export const appErrorSchema = z.object({
  kind: z.enum(APP_ERROR_KINDS),
  message: z.string(),
  retryable: z.boolean(),
});

export type AppError = z.infer<typeof appErrorSchema>;

export function isAppError(value: unknown): value is AppError {
  return appErrorSchema.safeParse(value).success;
}

/** Normalizes anything thrown or rejected into a typed {@link AppError}. */
export function toAppError(value: unknown): AppError {
  const parsed = appErrorSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  if (value instanceof Error) {
    return { kind: "internal", message: value.message, retryable: false };
  }
  return { kind: "internal", message: String(value), retryable: false };
}

export function errorMessage(value: unknown): string {
  return toAppError(value).message;
}
