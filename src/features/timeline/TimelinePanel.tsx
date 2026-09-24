import { useTimelineStore, isTimelineDirty } from "@/stores/timelineStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { Button } from "@/shared/ui/Button";
import { TimelineClipView } from "./TimelineClipView";
import { useTimelineShortcuts } from "./useTimelineShortcuts";

export function TimelinePanel() {
  const state = useTimelineStore();
  const project = useWorkspaceStore((state) => state.project);
  useTimelineShortcuts();
  if (!state.timeline)
    return (
      <section className="border-t border-slate-800 p-3 text-xs">
        {state.loading ? "Loading timeline…" : (state.error ?? "No timeline loaded")}
        {!state.loading && project && (
          <Button size="sm" onClick={() => void state.load(project)}>
            Retry timeline
          </Button>
        )}
      </section>
    );
  const { timeline, zoom, selectedIds, playhead } = state;
  const width = Math.max(800, (timeline.duration + 10) * zoom);
  const interval = Math.max(1, Math.ceil(80 / zoom));
  const tickCount = Math.min(2000, Math.ceil(width / zoom / interval));
  return (
    <section
      aria-label="Timeline editor"
      className="flex h-[290px] min-h-[220px] shrink-0 flex-col border-t border-slate-700 bg-slate-950"
    >
      <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-800 px-3 py-2">
        <h2 className="mr-2 text-xs font-semibold">Timeline</h2>
        <Button size="sm" onClick={state.togglePlayback} disabled={!timeline.duration}>
          {state.playing ? "Pause" : "Play"}
        </Button>
        <span className="min-w-28 text-xs tabular-nums">
          {playhead.toFixed(2)} / {timeline.duration.toFixed(2)}s
        </span>
        <Button
          size="sm"
          disabled={!selectedIds.length}
          onClick={() => state.edit({ type: "split", ids: selectedIds, at: playhead })}
          title="S"
        >
          Split
        </Button>
        <Button
          size="sm"
          disabled={!selectedIds.length}
          onClick={() => state.edit({ type: "delete", ids: selectedIds })}
        >
          Delete
        </Button>
        <Button
          size="sm"
          disabled={!selectedIds.length}
          onClick={() => state.edit({ type: "delete", ids: selectedIds, ripple: true })}
        >
          Ripple delete
        </Button>
        <Button
          size="sm"
          disabled={!selectedIds.length}
          onClick={() => state.edit({ type: "duplicate", ids: selectedIds })}
        >
          Duplicate
        </Button>
        <Button size="sm" disabled={!state.past.length} onClick={state.undo} title="Ctrl+Z">
          Undo
        </Button>
        <Button size="sm" disabled={!state.future.length} onClick={state.redo} title="Ctrl+Shift+Z">
          Redo
        </Button>
        <Button
          size="sm"
          aria-pressed={state.snapping}
          onClick={() => useTimelineStore.setState({ snapping: !state.snapping })}
        >
          Snap {state.snapping ? "on" : "off"}
        </Button>
        <label className="flex items-center gap-1 text-xs">
          Zoom
          <input
            aria-label="Timeline zoom"
            type="range"
            min="2"
            max="150"
            value={zoom}
            onChange={(event) => useTimelineStore.setState({ zoom: Number(event.target.value) })}
            className="w-20"
          />
        </label>
        <Button size="sm" onClick={() => state.edit({ type: "addTrack", kind: "video" })}>
          + Video
        </Button>
        <Button size="sm" onClick={() => state.edit({ type: "addTrack", kind: "audio" })}>
          + Audio
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={state.saving || !isTimelineDirty(state)}
          onClick={() => void state.save()}
        >
          {state.saving ? "Saving…" : "Save timeline"}
        </Button>
        <span className="text-[11px] text-slate-400">
          {isTimelineDirty(state) ? "Unsaved changes" : "Saved"}
        </span>
      </div>
      {state.error && (
        <div
          role="alert"
          className="flex items-center justify-between px-3 py-1 text-xs text-rose-300"
        >
          {state.error}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => useTimelineStore.setState({ error: null })}
          >
            Dismiss
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <div style={{ width: width + 170 }} className="relative">
          <div className="flex h-7">
            <div className="sticky left-0 z-20 w-[170px] shrink-0 bg-slate-900 px-2 text-[11px] leading-7">
              Tracks · Ctrl+click to select
            </div>
            <div
              role="slider"
              aria-label="Timeline playhead"
              aria-valuemin={0}
              aria-valuemax={timeline.duration}
              aria-valuenow={playhead}
              tabIndex={0}
              className="relative flex-1 cursor-crosshair bg-slate-900"
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                state.seek(
                  (event.clientX - event.currentTarget.getBoundingClientRect().left) / zoom,
                );
              }}
              onPointerMove={(event) => {
                if (event.buttons === 1)
                  state.seek(
                    (event.clientX - event.currentTarget.getBoundingClientRect().left) / zoom,
                  );
              }}
            >
              {Array.from({ length: tickCount }, (_, index) => (
                <span
                  key={index}
                  className="absolute border-l border-slate-600 pl-1 text-[10px] text-slate-400"
                  style={{ left: index * interval * zoom }}
                >
                  {index * interval}s
                </span>
              ))}
            </div>
          </div>
          <div className="flex h-[48px] border-b border-slate-800" aria-label="Caption track">
            <div className="sticky left-0 z-20 flex w-[170px] shrink-0 items-center justify-between bg-slate-900 px-2 text-xs">
              <span>Captions ({timeline.captions.segments.length})</span>
              <button
                aria-label="Show captions"
                aria-pressed={timeline.captions.enabled}
                className={timeline.captions.enabled ? "text-teal-300" : "text-slate-500"}
                onClick={() =>
                  state.edit({
                    type: "captions",
                    captions: { ...timeline.captions, enabled: !timeline.captions.enabled },
                  })
                }
              >
                Show
              </button>
            </div>
            <div className="relative flex-1 overflow-hidden">
              {timeline.captions.segments.map((segment) => (
                <button
                  key={segment.id}
                  dir="auto"
                  title={`${segment.start.toFixed(2)}–${segment.end.toFixed(2)}s: ${segment.words.map((word) => word.text).join(" ")}`}
                  onClick={() => state.seek(segment.start)}
                  className={`absolute inset-y-2 overflow-hidden text-ellipsis whitespace-nowrap rounded border border-teal-600 px-1 text-xs text-teal-100 ${timeline.captions.enabled ? "bg-teal-900" : "bg-slate-800 opacity-50"}`}
                  style={{
                    left: segment.start * zoom,
                    width: Math.max(2, (segment.end - segment.start) * zoom),
                  }}
                >
                  {segment.words.map((word) => word.text).join(" ")}
                </button>
              ))}
            </div>
          </div>
          {timeline.tracks.map((track) => (
            <div
              key={track.id}
              data-track-id={track.id}
              className="flex h-[58px] border-b border-slate-800"
            >
              <div className="sticky left-0 z-20 flex w-[170px] shrink-0 flex-col justify-center gap-1 bg-slate-900 px-2">
                <div className="flex items-center gap-1">
                  <button
                    className="flex-1 truncate text-left text-xs"
                    onClick={() => useTimelineStore.setState({ selectedTrackId: track.id })}
                  >
                    {track.name}
                  </button>
                  <button
                    aria-label={`Remove ${track.name}`}
                    disabled={track.locked || !!track.clips.length}
                    className="text-xs disabled:opacity-20"
                    onClick={() => state.edit({ type: "removeTrack", trackId: track.id })}
                  >
                    ×
                  </button>
                </div>
                <div className="flex gap-2 text-[10px]">
                  {(["enabled", "muted", "solo", "locked"] as const).map((key) => (
                    <button
                      key={key}
                      aria-label={`${key} ${track.name}`}
                      aria-pressed={track[key]}
                      className={track[key] ? "text-indigo-300" : "text-slate-500"}
                      onClick={() =>
                        state.edit({
                          type: "track",
                          trackId: track.id,
                          patch: { [key]: !track[key] },
                        })
                      }
                    >
                      {key === "enabled"
                        ? "Show"
                        : key === "muted"
                          ? "Mute"
                          : key === "solo"
                            ? "Solo"
                            : "Lock"}
                    </button>
                  ))}
                </div>
              </div>
              <div
                className="relative flex-1"
                onPointerDown={(event) => {
                  state.seek(
                    (event.clientX - event.currentTarget.getBoundingClientRect().left) / zoom,
                  );
                  useTimelineStore.setState({ selectedIds: [], selectedTrackId: track.id });
                }}
              >
                {track.clips.map((clip) => (
                  <TimelineClipView key={clip.id} clip={clip} track={track} zoom={zoom} />
                ))}
              </div>
            </div>
          ))}
          <div
            className="pointer-events-none absolute inset-y-0 z-10 w-px bg-amber-300"
            style={{ left: 170 + playhead * zoom }}
          />
        </div>
      </div>
    </section>
  );
}
