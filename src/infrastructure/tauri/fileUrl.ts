import { convertFileSrc } from "@tauri-apps/api/core";

/** Joins a project-root-relative path onto an absolute root using the root's separator. */
export function joinPath(root: string, relative: string): string {
  const separator = root.includes("\\") ? "\\" : "/";
  const trimmedRoot = root.replace(/[\\/]+$/, "");
  const child = relative.replace(/^[\\/]+/, "").replace(/[\\/]+/g, separator);
  return `${trimmedRoot}${separator}${child}`;
}

/**
 * Absolute path of a derivative inside a project.
 *
 * The database stores forward-slash paths so a project stays portable; Windows needs a real
 * separator before the file is handed to the asset protocol.
 */
export function derivativeAbsolutePath(projectRoot: string, relativePath: string): string {
  return joinPath(projectRoot, relativePath);
}

/**
 * URL the WebView can load through the Tauri asset protocol.
 *
 * `revision` appends a cache-busting query so a regenerated artifact replaces the old image
 * immediately; the asset handler reads only the path, so the query is ignored by the backend.
 * Pass the artifact's own timestamp, never a global counter, or every refresh re-downloads the
 * whole library.
 */
export function assetUrl(absolutePath: string, revision?: number | string): string {
  const url = convertFileSrc(absolutePath);
  return revision === undefined ? url : `${url}?rev=${encodeURIComponent(revision)}`;
}
