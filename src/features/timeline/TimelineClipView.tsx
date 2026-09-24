import { useRef, useState, type PointerEvent } from "react";
import type { TimelineClip, Track } from "@/domain/timeline/model";
import { clipDuration, frameTime, snapTime } from "@/domain/timeline/edit";
import { useTimelineStore } from "@/stores/timelineStore";
import { cn } from "@/shared/cn";

type Gesture = {
  pointerId: number;
  x: number;
  edge: "start" | "end" | "move";
  at: number;
  moved: boolean;
};

export function TimelineClipView({
  clip,
  track,
  zoom,
}: {
  clip: TimelineClip;
  track: Track;
  zoom: number;
}) {
  const selected = useTimelineStore((state) => state.selectedIds.includes(clip.id));
  const gesture = useRef<Gesture | null>(null);
  const [ghost, setGhost] = useState<{ start: number; end: number } | null>(null);
  const begin = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    useTimelineStore.getState().select(clip.id, track.id, event.ctrlKey || event.shiftKey);
    if (track.locked) return;
    const target = event.target as HTMLElement;
    const edge =
      target.dataset.edge === "start" ? "start" : target.dataset.edge === "end" ? "end" : "move";
    gesture.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      edge,
      at: edge === "end" ? clip.timelineEnd : clip.timelineStart,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const drag = gesture.current;
    const state = useTimelineStore.getState();
    if (!drag || !state.timeline) return;
    const delta = (event.clientX - drag.x) / zoom;
    drag.moved ||= Math.abs(event.clientX - drag.x) > 3;
    const targets = [
      0,
      state.playhead,
      ...state.timeline.tracks.flatMap((item) =>
        item.clips
          .filter((item) => item.id !== clip.id)
          .flatMap((item) => [item.timelineStart, item.timelineEnd]),
      ),
    ];
    const raw = (drag.edge === "end" ? clip.timelineEnd : clip.timelineStart) + delta;
    drag.at = frameTime(
      state.snapping
        ? snapTime(raw, drag.edge === "move" ? clipDuration(clip) : 0, targets, 8 / zoom)
        : raw,
      state.timeline.fps,
    );
    setGhost({
      start: drag.edge === "end" ? clip.timelineStart : drag.at,
      end:
        drag.edge === "start"
          ? clip.timelineEnd
          : drag.edge === "move"
            ? drag.at + clipDuration(clip)
            : drag.at,
    });
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const drag = gesture.current;
    gesture.current = null;
    setGhost(null);
    if (!drag?.moved) return;
    if (drag.edge === "move") {
      const destination =
        document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest<HTMLElement>("[data-track-id]")?.dataset.trackId ?? track.id;
      useTimelineStore
        .getState()
        .edit({ type: "move", id: clip.id, trackId: destination, at: drag.at });
    } else
      useTimelineStore.getState().edit({ type: "trim", id: clip.id, edge: drag.edge, at: drag.at });
  };
  const start = ghost?.start ?? clip.timelineStart;
  const end = ghost?.end ?? clip.timelineEnd;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Clip ${clip.label}`}
      aria-pressed={selected}
      onKeyDown={(event) => {
        if (event.key === "Enter")
          useTimelineStore.getState().select(clip.id, track.id, event.ctrlKey || event.shiftKey);
      }}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={() => {
        gesture.current = null;
        setGhost(null);
      }}
      className={cn(
        "absolute top-1 flex h-12 touch-none select-none items-center overflow-hidden rounded border text-xs",
        track.kind === "video"
          ? "bg-indigo-900 border-indigo-500"
          : "bg-emerald-950 border-emerald-600",
        selected && "ring-2 ring-amber-300",
        track.locked ? "cursor-not-allowed" : "cursor-grab",
      )}
      style={{ left: start * zoom, width: Math.max(3, (end - start) * zoom) }}
      title={`${clip.label} | ${clip.sourceStart.toFixed(3)}–${clip.sourceEnd.toFixed(3)}s`}
    >
      <span
        data-edge="start"
        className="absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize bg-white/15"
        title="Trim start"
      />
      <span className="truncate px-3">
        {clip.label}
        <small className="block opacity-70">{(end - start).toFixed(2)}s</small>
      </span>
      <span
        data-edge="end"
        className="absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize bg-white/15"
        title="Trim end"
      />
    </div>
  );
}
