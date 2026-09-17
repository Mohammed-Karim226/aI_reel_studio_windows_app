import { z } from "zod";

import { appErrorSchema, type AppError } from "./errors";

export const jobKindSchema = z.enum(["thumbnail", "filmstrip", "waveform", "proxy"]);

export type JobKind = z.infer<typeof jobKindSchema>;

export const jobStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "skipped",
  "failed",
  "cancelled",
]);

export type JobStatus = z.infer<typeof jobStatusSchema>;

/** Failed jobs carry the same envelope as failed commands. */
export type JobError = AppError;

/** One row in the jobs panel, streamed live over `job://update`. */
export const jobSnapshotSchema = z.object({
  id: z.string(),
  kind: jobKindSchema,
  status: jobStatusSchema,
  label: z.string(),
  progress: z.number().nullable(),
  message: z.string().nullable(),
  error: appErrorSchema.nullable(),
  mediaAssetId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type JobSnapshot = z.infer<typeof jobSnapshotSchema>;

export function isActiveJob(job: JobSnapshot): boolean {
  return job.status === "queued" || job.status === "running";
}
