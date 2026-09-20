import { useState } from "react";
import type { TimelineClip, Track } from "@/domain/timeline/model";
import { useTimelineStore } from "@/stores/timelineStore";
import { Button } from "@/shared/ui/Button";

export function ClipInspector() {
  const timeline = useTimelineStore((state) => state.timeline);
  const ids = useTimelineStore((state) => state.selectedIds);
  const selected = timeline?.tracks.flatMap((track) => track.clips).find((clip) => clip.id === ids[0]);
  if (!selected || !timeline) return <p className="p-3 text-xs text-slate-500">Select a timeline clip to edit its timing. Drag the clip to move it; drag its edges to trim.</p>;
  return <ClipFields key={`${selected.id}:${selected.timelineStart}:${selected.timelineEnd}`} clip={selected} tracks={timeline.tracks} />;
}

function ClipFields({ clip, tracks }: { clip: TimelineClip; tracks: Track[] }) {
  const [position, setPosition] = useState(clip.timelineStart);
  const [sourceIn, setSourceIn] = useState(clip.sourceStart);
  const [sourceOut, setSourceOut] = useState(clip.sourceEnd);
  const [trackId, setTrackId] = useState(tracks.find((track) => track.clips.some((item) => item.id === clip.id))?.id ?? "");
  const edit = useTimelineStore((state) => state.edit);
  return <section className="flex flex-col gap-3 p-3 text-xs">
    <h2 className="font-semibold text-slate-200">Clip timing</h2>
    <p className="break-all text-slate-400">{clip.label}</p>
    <label>Timeline start (seconds)<input aria-label="Clip timeline start" type="number" min="0" step="0.001" value={position} onChange={(event) => setPosition(Number(event.target.value))} className="mt-1 w-full rounded bg-slate-800 p-2" /></label>
    <select aria-label="Move clip to track" value={trackId} onChange={(event) => setTrackId(event.target.value)} className="rounded bg-slate-800 p-2">{tracks.map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}</select>
    <Button size="sm" onClick={() => edit({ type: "move", id: clip.id, trackId, at: position })}>Move clip</Button>
    <label>Source in (seconds)<input aria-label="Clip source in" type="number" min="0" step="0.001" value={sourceIn} onChange={(event) => setSourceIn(Number(event.target.value))} className="mt-1 w-full rounded bg-slate-800 p-2" /></label>
    <Button size="sm" onClick={() => edit({ type: "trim", id: clip.id, edge: "start", at: clip.timelineStart + sourceIn - clip.sourceStart })}>Trim start</Button>
    <label>Source out (seconds)<input aria-label="Clip source out" type="number" min="0" step="0.001" value={sourceOut} onChange={(event) => setSourceOut(Number(event.target.value))} className="mt-1 w-full rounded bg-slate-800 p-2" /></label>
    <Button size="sm" onClick={() => edit({ type: "trim", id: clip.id, edge: "end", at: clip.timelineEnd + sourceOut - clip.sourceEnd })}>Trim end</Button>
    <p className="text-slate-500">Timing is aligned to project frames. Ripple delete closes space on the selected clips’ tracks.</p>
  </section>;
}
