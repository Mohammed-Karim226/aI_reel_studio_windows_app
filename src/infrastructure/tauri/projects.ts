import { z } from "zod";

import {
  projectInfoSchema,
  projectSummarySchema,
  type ProjectInfo,
  type ProjectSummary,
} from "@/domain/projects";
import { invokeCommand } from "./invoke";

export function listRecentProjects(limit = 20): Promise<ProjectSummary[]> {
  return invokeCommand("list_recent_projects", { limit }, z.array(projectSummarySchema));
}

export function createProject(name: string, parentDir?: string): Promise<ProjectInfo> {
  return invokeCommand("create_project", { name, parentDir: parentDir ?? null }, projectInfoSchema);
}

export function openProject(rootPath: string): Promise<ProjectInfo> {
  return invokeCommand("open_project", { rootPath }, projectInfoSchema);
}

export function closeProject(): Promise<null> {
  return invokeCommand("close_project", {}, z.null());
}

export function currentProject(): Promise<ProjectInfo | null> {
  return invokeCommand("current_project", {}, projectInfoSchema.nullable());
}

export function forgetProject(projectId: string): Promise<null> {
  return invokeCommand("forget_project", { projectId }, z.null());
}
