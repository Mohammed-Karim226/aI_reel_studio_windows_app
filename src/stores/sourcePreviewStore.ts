import { create } from "zustand";
import { useMediaStore } from "./mediaStore";
import { useTimelineStore } from "./timelineStore";

export interface SourcePreviewRange {
  id: string;
  mediaId: string;
  start: number;
  end: number;
}

interface SourcePreviewState {
  range: SourcePreviewRange | null;
  preview: (mediaId: string, start: number, end: number) => void;
  clear: () => void;
}

export const useSourcePreviewStore = create<SourcePreviewState>((set) => ({
  range: null,
  preview: (mediaId, start, end) => {
    const asset = useMediaStore.getState().assets.find((item) => item.id === mediaId);
    if (
      !asset ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      end > asset.durationSec
    )
      return;
    useMediaStore.getState().select(mediaId);
    set({ range: { id: crypto.randomUUID(), mediaId, start, end } });
  },
  clear: () => set({ range: null }),
}));

const unsubscribeTimeline = useTimelineStore.subscribe((state, previous) => {
  if (state.projectId !== previous.projectId || (state.loading && !previous.loading))
    useSourcePreviewStore.getState().clear();
});
const unsubscribeMedia = useMediaStore.subscribe((state, previous) => {
  const range = useSourcePreviewStore.getState().range;
  const asset = state.assets.find((item) => item.id === range?.mediaId);
  const oldAsset = previous.assets.find((item) => item.id === range?.mediaId);
  if (
    range &&
    (state.selectedId !== range.mediaId ||
      !asset ||
      asset.durationSec < range.end ||
      asset.originalPath !== oldAsset?.originalPath ||
      asset.importedAt !== oldAsset?.importedAt)
  )
    useSourcePreviewStore.getState().clear();
});

if (import.meta.hot)
  import.meta.hot.dispose(() => {
    unsubscribeTimeline();
    unsubscribeMedia();
  });
