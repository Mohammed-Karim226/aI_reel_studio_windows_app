import { useRef, useState } from "react";
import type { MediaAsset } from "@/domain/media";
import { acceptsMedia } from "@/domain/timeline/edit";
import { Button } from "@/shared/ui/Button";
import { useTimelineStore } from "@/stores/timelineStore";

export function SourceMonitor({
  asset,
  src,
  poster,
}: {
  asset: MediaAsset;
  src: string;
  poster?: string;
}) {
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [time, setTime] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(
    asset.kind === "image" ? 5 : Math.floor(asset.durationSec * 30) / 30,
  );
  const [error, setError] = useState<string | null>(null);
  const timeline = useTimelineStore((state) => state.timeline);
  const selectedTrackId = useTimelineStore((state) => state.selectedTrackId);
  const tracks =
    timeline?.tracks.filter((track) => acceptsMedia(track, asset) && !track.locked) ?? [];
  const target = tracks.find((track) => track.id === selectedTrackId) ?? tracks[0];
  const events = {
    onTimeUpdate: () => setTime(media.current?.currentTime ?? 0),
    onError: () =>
      setError(
        "This source cannot be played. Check its location or generate a compatible proxy in the Inspector.",
      ),
  };
  const mark = (edge: "start" | "end") => {
    if (edge === "start") setStart(time);
    else setEnd(time);
  };
  return (
    <>
      {asset.kind === "image" ? (
        <img src={src} alt={asset.fileName} className="max-h-[35vh] w-full object-contain" />
      ) : asset.hasVideo ? (
        <video
          ref={media}
          src={src}
          poster={poster}
          controls
          {...events}
          className="max-h-[35vh] w-full rounded border border-slate-800 bg-black"
        />
      ) : (
        <audio ref={media} src={src} controls {...events} className="w-full" />
      )}
      {error && (
        <p role="alert" className="text-xs text-rose-300">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2 text-xs">
        <label>
          Source in (s)
          <input
            aria-label="Source in"
            type="number"
            min="0"
            step={1 / (timeline?.fps ?? 30)}
            value={start}
            onChange={(event) => setStart(Number(event.target.value))}
            className="ml-2 w-24 rounded bg-slate-800 p-1"
          />
        </label>
        <Button size="sm" onClick={() => mark("start")} disabled={asset.kind === "image"}>
          Mark in
        </Button>
        <label>
          Source out (s)
          <input
            aria-label="Source out"
            type="number"
            min="0"
            step={1 / (timeline?.fps ?? 30)}
            value={end}
            onChange={(event) => setEnd(Number(event.target.value))}
            className="ml-2 w-24 rounded bg-slate-800 p-1"
          />
        </label>
        <Button size="sm" onClick={() => mark("end")} disabled={asset.kind === "image"}>
          Mark out
        </Button>
        <select
          aria-label="Destination track"
          className="rounded bg-slate-800 p-1.5"
          value={target?.id ?? ""}
          onChange={(event) => useTimelineStore.setState({ selectedTrackId: event.target.value })}
        >
          {!tracks.length && <option value="">Add a compatible track</option>}
          {tracks.map((track) => (
            <option key={track.id} value={track.id}>
              {track.name}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="primary"
          disabled={!target || end <= start}
          onClick={() => {
            if (!target) return;
            useTimelineStore.getState().edit({
              type: "add",
              trackId: target.id,
              asset,
              sourceStart: start,
              sourceEnd: end,
              start: Math.max(0, ...target.clips.map((clip) => clip.timelineEnd)),
            });
          }}
        >
          Append to timeline
        </Button>
      </div>
    </>
  );
}
