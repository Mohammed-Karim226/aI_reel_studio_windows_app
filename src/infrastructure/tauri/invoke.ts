import { invoke } from "@tauri-apps/api/core";
import type { z } from "zod";

import { toAppError } from "@/domain/errors";

/**
 * Single entry point for every IPC call: it validates the payload against a schema before the
 * rest of the app ever sees it, so a backend change cannot silently produce a malformed state.
 */
export async function invokeCommand<T>(
  command: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  try {
    const raw: unknown = await invoke(command, args);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return Promise.reject(
        toAppError({
          kind: "internal",
          message: `unexpected payload from ${command}: ${parsed.error.message}`,
          retryable: false,
        }),
      );
    }
    return parsed.data;
  } catch (error) {
    return Promise.reject(toAppError(error));
  }
}
