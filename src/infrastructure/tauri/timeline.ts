import { z } from "zod";
import { timelineSchema, type Timeline } from "@/domain/timeline/model";
import { invokeCommand } from "./invoke";

export const loadTimeline = (projectId: string) =>
  invokeCommand("load_timeline", { projectId }, timelineSchema.nullable());
export const saveTimeline = (projectId: string, timeline: Timeline) =>
  invokeCommand("save_timeline", { projectId, timeline: timelineSchema.parse(timeline) }, z.null());
