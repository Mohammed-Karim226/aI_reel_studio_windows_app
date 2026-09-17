import { z } from "zod";

export const appInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  platform: z.string(),
});

export type AppInfo = z.infer<typeof appInfoSchema>;

export const toolSourceSchema = z.enum([
  "configured",
  "environment",
  "bundled",
  "systemPath",
  "wellKnown",
]);

export type ToolSource = z.infer<typeof toolSourceSchema>;

export const ffmpegToolsSchema = z.object({
  ffmpegPath: z.string(),
  ffprobePath: z.string(),
  version: z.string(),
  source: toolSourceSchema,
});

export type FfmpegTools = z.infer<typeof ffmpegToolsSchema>;

export const ffmpegStatusSchema = z.object({
  available: z.boolean(),
  tools: ffmpegToolsSchema.nullable(),
  error: z.string().nullable(),
});

export type FfmpegStatus = z.infer<typeof ffmpegStatusSchema>;
