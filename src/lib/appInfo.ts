import { invoke } from "@tauri-apps/api/core";

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
}

export function fetchAppInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("get_app_info");
}

export function formatAppInfo(info: AppInfo): string {
  return `${info.name} v${info.version} (${info.platform})`;
}
