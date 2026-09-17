import { z } from "zod";

/** Master composition format of a project. Defaults to the vertical Reel (spec §8). */
export const projectFormatSchema = z.object({
  width: z.number(),
  height: z.number(),
  fps: z.number(),
});

export type ProjectFormat = z.infer<typeof projectFormatSchema>;

/** A project as listed in the recent-projects registry. */
export const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastOpenedAt: z.string().nullable(),
});

export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const projectInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string(),
  createdAt: z.string(),
  format: projectFormatSchema,
  mediaCount: z.number(),
});

export type ProjectInfo = z.infer<typeof projectInfoSchema>;
