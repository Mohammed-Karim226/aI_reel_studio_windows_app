import { useEffect, useRef } from "react";
import { readyDerivative, type MediaAsset } from "@/domain/media";
import type { TimelineClip } from "@/domain/timeline/model";
import { activeClips, sourceTime } from "@/domain/timeline/playback";
import { assetUrl, derivativeAbsolutePath } from "@/infrastructure/tauri/fileUrl";
import { useMediaStore } from "@/stores/mediaStore";
import { useTimelineStore } from "@/stores/timelineStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

export function TimelinePreview() {
  const timeline = useTimelineStore((state) => state.timeline);
  const time = useTimelineStore((state) => state.playhead);
  const playing = useTimelineStore((state) => state.playing);
  const assets = useMediaStore((state) => state.assets);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const state = useTimelineStore.getState();
      const duration = state.timeline?.duration ?? 0;
      const next = Math.min(duration, state.playhead + (now - last) / 1000);
      last = now;
      useTimelineStore.setState({ playhead: next, playing: next < duration });
      if (next < duration) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  const active = timeline ? activeClips(timeline, time) : [];
  return <div className="flex h-full flex-col gap-2 p-3">
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded bg-black" aria-label="Timeline monitor">
      {!active.some((item) => item.visible) && <span className="text-xs text-slate-500">{timeline?.duration ? "No video at playhead" : "Append a source range to begin your Reel"}</span>}
      {active.map(({ clip, track, visible, audible }) => {
        const asset = assets.find((item) => item.id === clip.sourceMediaId);
        return asset ? <TimelineMedia key={clip.id} asset={asset} clip={clip} time={time} playing={playing} visible={visible} volume={audible ? track.volume : 0} /> : null;
      })}
    </div>
    <p className="text-[11px] text-slate-500">Preview uses available proxies. First video track is on top; enabled audio tracks are mixed.</p>
  </div>;
}

function TimelineMedia({ asset, clip, time, playing, visible, volume }: {
  asset: MediaAsset; clip: TimelineClip; time: number; playing: boolean; visible: boolean; volume: number;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const root = useWorkspaceStore((state) => state.project?.rootPath ?? "");
  const proxy = readyDerivative(asset, "proxy");
  const path = proxy?.relativePath ? derivativeAbsolutePath(root, proxy.relativePath) : asset.originalPath;
  const src = assetUrl(path, proxy?.updatedAt ?? asset.importedAt);
  const desired = sourceTime(clip, time);
  const desiredRef = useRef(desired);
  const playingRef = useRef(playing);
  useEffect(() => { desiredRef.current = desired; playingRef.current = playing; }, [desired, playing]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.volume = volume;
    if (element.readyState > 0 && Math.abs(element.currentTime - desired) > (playing ? 0.2 : 0.001)) element.currentTime = desired;
    if (playing && element.paused) void element.play().catch(() => {
      useTimelineStore.setState({ playing: false, error: "Playback could not start. Check the source or generate a proxy." });
    });
    if (!playing && !element.paused) element.pause();
  }, [desired, playing, volume, src]);
  if (asset.kind === "image") return visible ? <img src={src} alt={clip.label} className="absolute h-full w-full object-contain" /> : null;
  return <video ref={ref} src={src} className={visible ? "absolute h-full w-full object-contain" : "hidden"} playsInline preload="auto"
    onLoadedMetadata={() => { if (ref.current) ref.current.currentTime = desiredRef.current; }}
    onError={() => useTimelineStore.setState({ playing: false, error: `Cannot preview ${asset.fileName}. Check the source or regenerate its proxy.` })} />;
}
