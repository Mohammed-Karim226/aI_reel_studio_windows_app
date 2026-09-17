import { z } from "zod";

import { jobSnapshotSchema, type JobSnapshot } from "@/domain/jobs";
import { invokeCommand } from "./invoke";

export function listJobs(): Promise<JobSnapshot[]> {
  return invokeCommand("list_jobs", {}, z.array(jobSnapshotSchema));
}

export function cancelJob(jobId: string): Promise<null> {
  return invokeCommand("cancel_job", { jobId }, z.null());
}

export function clearFinishedJobs(): Promise<number> {
  return invokeCommand("clear_finished_jobs", {}, z.number());
}
