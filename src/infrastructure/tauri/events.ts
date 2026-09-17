import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { jobSnapshotSchema, type JobSnapshot } from "@/domain/jobs";

/** Event name the Rust job registry emits on. */
export const JOB_EVENT = "job://update";

/**
 * Subscribes to live job updates. Malformed payloads are dropped rather than crashing the UI;
 * the periodic list refresh is the safety net.
 */
export function onJobUpdate(handler: (job: JobSnapshot) => void): Promise<UnlistenFn> {
  return listen<unknown>(JOB_EVENT, (event) => {
    const parsed = jobSnapshotSchema.safeParse(event.payload);
    if (parsed.success) {
      handler(parsed.data);
    }
  });
}
