import { open } from "@tauri-apps/plugin-dialog";
import { create } from "zustand";

import { errorMessage } from "@/domain/errors";
import type { DerivativeKind, MediaAsset } from "@/domain/media";
import {
  getMedia,
  importMedia,
  listMedia,
  regenerateDerivative,
  removeMedia,
} from "@/infrastructure/tauri/media";

const MEDIA_EXTENSIONS = [
  "mp4",
  "mov",
  "mkv",
  "webm",
  "avi",
  "m4v",
  "mts",
  "mp3",
  "wav",
  "m4a",
  "aac",
  "flac",
  "png",
  "jpg",
  "jpeg",
  "webp",
];

interface MediaState {
  assets: MediaAsset[];
  selectedId: string | null;
  loading: boolean;
  importing: boolean;
  error: string | null;
  /** Human-readable summary of files the last import could not accept (spec §29). */
  notice: string | null;
  load: () => Promise<void>;
  /** Re-reads one asset after its derivative jobs finished, without touching the rest. */
  refreshAsset: (mediaId: string) => Promise<void>;
  importFiles: () => Promise<void>;
  importPaths: (paths: string[]) => Promise<void>;
  select: (mediaId: string | null) => void;
  remove: (mediaId: string) => Promise<void>;
  regenerate: (mediaId: string, kind: DerivativeKind) => Promise<void>;
  clearMessages: () => void;
  reset: () => void;
}

export const useMediaStore = create<MediaState>((set, get) => ({
  assets: [],
  selectedId: null,
  loading: false,
  importing: false,
  error: null,
  notice: null,

  load: async () => {
    set({ loading: true });
    try {
      const assets = await listMedia();
      set((state) => ({
        assets,
        loading: false,
        selectedId:
          state.selectedId && assets.some((asset) => asset.id === state.selectedId)
            ? state.selectedId
            : (assets[0]?.id ?? null),
      }));
    } catch (error) {
      set({ error: errorMessage(error), loading: false });
    }
  },

  refreshAsset: async (mediaId) => {
    try {
      const asset = await getMedia(mediaId);
      set((state) => ({
        assets: state.assets.map((candidate) => (candidate.id === asset.id ? asset : candidate)),
      }));
    } catch {
      // The asset may have been removed while its job finished; the next full load reconciles.
    }
  },

  importFiles: async () => {
    const selection = await open({
      multiple: true,
      title: "Import media",
      filters: [{ name: "Media", extensions: MEDIA_EXTENSIONS }],
    });
    if (!selection) {
      return;
    }
    const paths = Array.isArray(selection) ? selection : [selection];
    await get().importPaths(paths);
  },

  importPaths: async (paths) => {
    if (paths.length === 0) {
      return;
    }
    set({ importing: true, error: null, notice: null });
    try {
      const outcome = await importMedia(paths);
      await get().load();

      set({
        importing: false,
        selectedId: get().selectedId ?? outcome.imported[0]?.id ?? null,
        notice:
          outcome.skipped.length === 0
            ? null
            : outcome.skipped
                .map((skipped) => `${fileName(skipped.path)}: ${skipped.reason}`)
                .join("\n"),
      });
    } catch (error) {
      set({ error: errorMessage(error), importing: false });
    }
  },

  select: (mediaId) => {
    set({ selectedId: mediaId });
  },

  remove: async (mediaId) => {
    try {
      await removeMedia(mediaId);
      await get().load();
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  regenerate: async (mediaId, kind) => {
    try {
      await regenerateDerivative(mediaId, kind);
      // The job event that follows will refresh the asset; this keeps the row honest meanwhile.
      await get().refreshAsset(mediaId);
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  clearMessages: () => {
    set({ error: null, notice: null });
  },

  reset: () => {
    set({ assets: [], selectedId: null, error: null, notice: null });
  },
}));

export function selectedAsset(state: MediaState): MediaAsset | null {
  return state.assets.find((asset) => asset.id === state.selectedId) ?? null;
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
