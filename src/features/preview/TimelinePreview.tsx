import { useCallback, useEffect, useRef, useState } from "react";
import { readyDerivative, type MediaAsset } from "@/domain/media";
import { evaluateHookLayer, type HookComposition } from "@/domain/hook";
import { CaptionOverlay } from "@/features/captions/CaptionOverlay";
import { EffectPreview } from "@/features/effects/EffectPreview";
import type { TimelineClip } from "@/domain/timeline/model";
import { activeClips, sourceTime } from "@/domain/timeline/playback";
import { assetUrl, derivativeAbsolutePath } from "@/infrastructure/tauri/fileUrl";
import { useMediaStore } from "@/stores/mediaStore";
import { useTimelineStore } from "@/stores/timelineStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useEditReviewStore } from "@/stores/editReviewStore";
import { safeZones, type SafeZonePlatform } from "@/domain/safeZones";
import { Button } from "@/shared/ui/Button";

export function TimelinePreview() {
  const committedTimeline = useTimelineStore((state) => state.timeline);
  const reviewPreview = useEditReviewStore((state) => state.preview);
  const timeline = reviewPreview?.timeline ?? committedTimeline;
  const time = useTimelineStore((state) => state.playhead);
  const playing = useTimelineStore((state) => state.playing);
  const assets = useMediaStore((state) => state.assets);
  const safeZone = useTimelineStore((state) => state.safeZone);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    if (reviewPreview) {
      const playhead = useTimelineStore.getState().playhead;
      if (playhead < reviewPreview.start || playhead >= reviewPreview.end)
        useTimelineStore.setState({ playhead: reviewPreview.start });
    }
    const tick = (now: number) => {
      const state = useTimelineStore.getState();
      if (!state.playing) return;
      const preview = useEditReviewStore.getState().preview;
      const duration = preview?.end ?? state.timeline?.duration ?? 0;
      const next = Math.min(
        duration,
        Math.max(preview?.start ?? 0, state.playhead) + (now - last) / 1000,
      );
      last = now;
      useTimelineStore.setState({ playhead: next, playing: next < duration });
      if (next < duration) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, reviewPreview]);
  const active = timeline ? activeClips(timeline, time) : [];
  return (
    <div className="flex h-full flex-col gap-2 p-3">
      {reviewPreview && (
        <div
          role="status"
          className="flex items-center justify-between gap-2 rounded bg-amber-950/40 px-2 py-1 text-xs text-amber-200"
        >
          <span>Review preview</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => useEditReviewStore.getState().clearPreview()}
          >
            Exit preview
          </Button>
        </div>
      )}
      <div className="flex items-center justify-between text-[11px] text-slate-500">
        <span>Vertical composition</span>
        <label className="flex items-center gap-1.5">
          <span>Safe zone</span>
          <select
            aria-label="Safe zone"
            value={safeZone}
            onChange={(event) =>
              useTimelineStore.setState({ safeZone: event.target.value as typeof safeZone })
            }
            className="rounded bg-slate-800 px-1.5 py-1 text-slate-300"
          >
            <option value="none">Off</option>
            <option value="instagram">Instagram</option>
            <option value="tiktok">TikTok</option>
            <option value="shorts">YouTube Shorts</option>
            <option value="facebook">Facebook</option>
          </select>
        </label>
      </div>
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded bg-slate-900"
        aria-label="Timeline monitor"
      >
        <div
          className="relative h-full max-w-full overflow-hidden bg-black"
          style={{
            aspectRatio: `${timeline?.width ?? 1080} / ${timeline?.height ?? 1920}`,
            containerType: "inline-size",
          }}
        >
          {!active.some((item) => item.visible) && (
            <span className="absolute inset-0 flex items-center justify-center text-center text-xs text-slate-500">
              {timeline?.duration
                ? "No video at playhead"
                : "Append a source range to begin your Reel"}
            </span>
          )}
          {active.map(({ clip, track, visible, audible }) => {
            const asset = assets.find((item) => item.id === clip.sourceMediaId);
            return asset ? (
              <TimelineMedia
                key={clip.id}
                asset={asset}
                clip={clip}
                time={time}
                playing={playing}
                visible={visible}
                volume={audible ? track.volume : 0}
                designWidth={timeline?.width ?? 1080}
              />
            ) : null;
          })}
          {timeline && <HookOverlay hook={timeline.hook} time={time} width={timeline.width} />}
          {timeline && (
            <CaptionOverlay captions={timeline.captions} time={time} width={timeline.width} />
          )}
          {safeZone !== "none" && <SafeZoneOverlay kind={safeZone} />}
        </div>
      </div>
      <p className="text-[11px] text-slate-500">
        Preview uses available proxies and the master timeline. Final exports render from original
        media.
      </p>
    </div>
  );
}

function HookOverlay({
  hook,
  time,
  width,
}: {
  hook: HookComposition;
  time: number;
  width: number;
}) {
  if (!hook.enabled || !hook.layers.length || time >= hook.duration) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-20"
      style={{ background: hook.background }}
      aria-label="Hook composition"
    >
      {hook.layers
        .filter((layer) => layer.start <= time && layer.end > time)
        .map((layer) => {
          const transform = evaluateHookLayer(layer, time);
          const weight =
            layer.style.weight === "black" ? 900 : layer.style.weight === "bold" ? 700 : 400;
          return (
            <div
              key={layer.id}
              dir="auto"
              className="absolute max-w-[90%] whitespace-pre-wrap px-3"
              style={{
                left: `${50 + transform.x}%`,
                top: `${50 + transform.y}%`,
                color: layer.style.color,
                background: layer.style.background,
                fontSize: `${(layer.style.fontSize / width) * 100}cqw`,
                fontWeight: weight,
                textAlign: layer.style.align,
                opacity: transform.opacity,
                transform: `translate(-50%, -50%) scale(${transform.scale}) rotate(${transform.rotation}deg)`,
              }}
            >
              {layer.text}
            </div>
          );
        })}
    </div>
  );
}

function TimelineMedia({
  asset,
  clip,
  time,
  playing,
  visible,
  volume,
  designWidth,
}: {
  asset: MediaAsset;
  clip: TimelineClip;
  time: number;
  playing: boolean;
  visible: boolean;
  volume: number;
  designWidth: number;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [effectsSource, setEffectsSource] = useState<string | null>(null);
  const root = useWorkspaceStore((state) => state.project?.rootPath ?? "");
  const proxy = readyDerivative(asset, "proxy");
  const path = proxy?.relativePath
    ? derivativeAbsolutePath(root, proxy.relativePath)
    : asset.originalPath;
  const src = assetUrl(path, proxy?.updatedAt ?? asset.importedAt);
  const effectsEnabled =
    visible && asset.kind !== "audio" && clip.effects.some((effect) => effect.enabled);
  const effectsReady = effectsEnabled && effectsSource === src;
  const onEffectsReady = useCallback(
    (ready: boolean) => setEffectsSource(ready ? src : null),
    [src],
  );
  const desired = sourceTime(clip, time);
  const desiredRef = useRef(desired);
  useEffect(() => {
    desiredRef.current = desired;
  }, [desired]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.volume = volume;
    if (element.readyState > 0 && Math.abs(element.currentTime - desired) > (playing ? 0.2 : 0.001))
      element.currentTime = desired;
    if (playing && element.paused)
      void element.play().catch(() => {
        useTimelineStore.setState({
          playing: false,
          error: "Playback could not start. Check the source or generate a proxy.",
        });
      });
    if (!playing && !element.paused) element.pause();
  }, [desired, playing, volume, src]);
  const style = {
    transform: `translate(${clip.transform.x}%, ${clip.transform.y}%) scale(${clip.transform.scale}) rotate(${clip.transform.rotation}deg)`,
    opacity: clip.transform.opacity,
  };
  const effectPreview = effectsEnabled ? (
    <EffectPreview
      mediaRef={asset.kind === "image" ? imageRef : ref}
      sourceKey={src}
      effects={clip.effects}
      sourceSeconds={desired}
      designWidth={designWidth}
      style={style}
      onReadyChange={onEffectsReady}
    />
  ) : null;
  if (asset.kind === "image")
    return visible ? (
      <>
        <img
          ref={imageRef}
          crossOrigin="anonymous"
          src={src}
          alt={clip.label}
          style={{ ...style, visibility: effectsReady ? "hidden" : undefined }}
          className="absolute h-full w-full object-contain"
        />
        {effectPreview}
      </>
    ) : null;
  return (
    <>
      <video
        ref={ref}
        crossOrigin="anonymous"
        src={src}
        style={{ ...style, visibility: effectsReady ? "hidden" : undefined }}
        className={visible ? "absolute h-full w-full object-contain" : "hidden"}
        playsInline
        preload="auto"
        onLoadedMetadata={() => {
          if (ref.current) ref.current.currentTime = desiredRef.current;
        }}
        onError={() =>
          useTimelineStore.setState({
            playing: false,
            error: `Cannot preview ${asset.fileName}. Check the source or regenerate its proxy.`,
          })
        }
      />
      {effectPreview}
    </>
  );
}

function SafeZoneOverlay({ kind }: { kind: SafeZonePlatform }) {
  const { label, top, right, bottom, left } = safeZones[kind];
  const inset = `${top}% ${right}% ${bottom}% ${left}%`;
  return (
    <div
      className="pointer-events-none absolute z-40 border border-dashed border-amber-300/70"
      style={{ inset }}
      aria-label={`${label} safe zone`}
    >
      <span className="absolute right-1 top-1 rounded bg-black/60 px-1 py-0.5 text-[9px] text-amber-200">
        {label} safe zone
      </span>
    </div>
  );
}
