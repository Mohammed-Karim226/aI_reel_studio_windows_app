import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { evaluateEffects, type ClipEffect } from "@/domain/effects";
import { EffectsRenderer, type PreviewMedia } from "./effectsRenderer";

interface EffectPreviewProps {
  mediaRef: RefObject<PreviewMedia | null>;
  sourceKey: string;
  effects: ClipEffect[];
  sourceSeconds: number;
  designWidth: number;
  style: CSSProperties;
  onReadyChange: (ready: boolean) => void;
}

/** The original media element remains the sole playback/audio source for the canvas. */
export function EffectPreview({
  mediaRef,
  sourceKey,
  effects,
  sourceSeconds,
  designWidth,
  style,
  onReadyChange,
}: EffectPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestDrawRef = useRef<(() => void) | null>(null);
  const latest = useRef({ effects, sourceSeconds, designWidth, onReadyChange });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    latest.current = { effects, sourceSeconds, designWidth, onReadyChange };
    requestDrawRef.current?.();
  }, [effects, sourceSeconds, designWidth, onReadyChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const media = mediaRef.current;
    if (!canvas || !media) return;
    const video = "videoWidth" in media ? media : null;
    let renderer: EffectsRenderer | null = null;
    let frame: number | null = null;
    let videoFrame: number | null = null;
    let disposed = false;
    let ready = false;

    const reportReady = (next: boolean) => {
      if (ready === next) return;
      ready = next;
      latest.current.onReadyChange(next);
    };
    const fail = (reason: unknown) => {
      renderer?.dispose();
      renderer = null;
      reportReady(false);
      setError(
        reason instanceof Error ? reason.message : "The graphics device could not render effects.",
      );
    };
    const draw = () => {
      frame = null;
      if (disposed || !renderer) return;
      try {
        const settings = latest.current;
        if (
          renderer.render(
            media,
            evaluateEffects(settings.effects, settings.sourceSeconds),
            settings.designWidth,
          )
        )
          reportReady(true);
      } catch (reason) {
        fail(reason);
      }
      // WebView2 normally exposes video-frame callbacks. Keep playback working on older
      // supported runtimes too, without polling when a clip is paused or effects failed.
      if (
        video &&
        !video.paused &&
        typeof video.requestVideoFrameCallback !== "function" &&
        renderer
      )
        requestDraw();
    };
    const requestDraw = () => {
      if (!disposed && renderer && frame === null) frame = requestAnimationFrame(draw);
    };
    const createRenderer = () => {
      try {
        renderer?.dispose();
        renderer = new EffectsRenderer(canvas);
        setError(null);
        requestDraw();
      } catch (reason) {
        fail(reason);
      }
    };
    const contextLost = (event: Event) => {
      event.preventDefault(); // Let WebView2 restore the context and recreate GPU resources.
      fail(new Error("The graphics context was lost. Effects resume when it is restored."));
    };
    const contextRestored = () => createRenderer();
    const mediaFailed = () => fail(new Error("The source could not be read for effects preview."));
    const watchVideoFrames = () => {
      if (!video || typeof video.requestVideoFrameCallback !== "function") return;
      videoFrame = video.requestVideoFrameCallback(() => {
        videoFrame = null;
        if (disposed) return;
        requestDraw();
        watchVideoFrames();
      });
    };

    requestDrawRef.current = requestDraw;
    canvas.addEventListener("webglcontextlost", contextLost);
    canvas.addEventListener("webglcontextrestored", contextRestored);
    // seeked/load are essential: a paused scrub often changes the timeline before the
    // decoder has made the new source frame available for texture upload.
    const redrawEvents = [
      "load",
      "loadeddata",
      "seeked",
      "canplay",
      "resize",
      "playing",
      "pause",
      "timeupdate",
    ];
    redrawEvents.forEach((name) => media.addEventListener(name, requestDraw));
    media.addEventListener("error", mediaFailed);
    const observer = new ResizeObserver(requestDraw);
    observer.observe(canvas);
    window.addEventListener("resize", requestDraw);
    createRenderer();
    watchVideoFrames();

    return () => {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      if (video && videoFrame !== null) video.cancelVideoFrameCallback(videoFrame);
      observer.disconnect();
      window.removeEventListener("resize", requestDraw);
      redrawEvents.forEach((name) => media.removeEventListener(name, requestDraw));
      media.removeEventListener("error", mediaFailed);
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("webglcontextrestored", contextRestored);
      renderer?.dispose();
      requestDrawRef.current = null;
      reportReady(false);
    };
  }, [mediaRef, sourceKey]);

  return (
    <>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full"
        style={{ ...style, visibility: error ? "hidden" : "visible" }}
      />
      {error && (
        <div
          role="status"
          title={error}
          className="pointer-events-none absolute inset-x-2 bottom-2 z-10 rounded bg-amber-950/95 px-2 py-1 text-center text-[11px] text-amber-100"
        >
          Effects preview unavailable. Original media is shown.
        </div>
      )}
    </>
  );
}
