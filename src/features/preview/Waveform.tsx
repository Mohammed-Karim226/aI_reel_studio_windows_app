import { useEffect, useRef, useState } from "react";

import type { WaveformData } from "@/domain/media";
import { readWaveform } from "@/infrastructure/tauri/media";

interface WaveformProps {
  mediaId: string;
  /** The waveform artifact's own timestamp, so unrelated job completions do not re-read it. */
  cacheKey: string;
}

type Status = "loading" | "ready" | "pending";

/**
 * Draws the stored peak envelope. Generation is asynchronous, so a missing waveform is a normal
 * state, not an error: it simply says the audio has not been analyzed yet.
 */
export function Waveform({ mediaId, cacheKey }: WaveformProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [data, setData] = useState<WaveformData | null>(null);
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");

    readWaveform(mediaId)
      .then((waveform) => {
        if (!cancelled) {
          setData(waveform);
          setStatus("ready");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setData(null);
          setStatus("pending");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [mediaId, cacheKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !data) {
      return;
    }

    const draw = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) {
        return;
      }

      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const context = canvas.getContext("2d");
      if (!context) {
        return;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      const { peaks } = data;
      const middle = height / 2;
      context.fillStyle = "#818cf8";

      for (let x = 0; x < width; x += 1) {
        const from = Math.floor((x / width) * peaks.length);
        const to = Math.max(from + 1, Math.floor(((x + 1) / width) * peaks.length));
        let peak = 0;
        for (let index = from; index < to && index < peaks.length; index += 1) {
          peak = Math.max(peak, peaks[index]);
        }
        const amplitude = (peak / 255) * (middle - 1);
        context.fillRect(x, middle - amplitude, 1, Math.max(1, amplitude * 2));
      }
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(container);
    return () => observer.disconnect();
  }, [data]);

  return (
    <div
      ref={containerRef}
      className="h-20 w-full rounded-md border border-slate-800 bg-slate-950/60"
      data-testid="waveform"
    >
      {status === "ready" ? (
        <canvas ref={canvasRef} className="block h-full w-full" />
      ) : (
        <p className="flex h-full items-center justify-center text-[11px] text-slate-500">
          {status === "loading" ? "Loading waveform…" : "Waveform not generated yet"}
        </p>
      )}
    </div>
  );
}
