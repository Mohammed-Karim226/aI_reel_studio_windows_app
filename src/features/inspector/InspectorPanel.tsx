import { useEffect, useState } from "react";

import { derivativeOf, type DerivativeKind, type DerivativePlanView } from "@/domain/media";
import { planMediaDerivatives } from "@/infrastructure/tauri/media";
import { formatBytes, formatDuration } from "@/shared/format";
import { Button } from "@/shared/ui/Button";
import { Pill } from "@/shared/ui/Pill";
import { useMediaStore, selectedAsset } from "@/stores/mediaStore";

const KIND_LABELS: Record<DerivativeKind, string> = {
  thumbnail: "Thumbnail",
  filmstrip: "Filmstrip",
  waveform: "Waveform",
  proxy: "Proxy",
};

export function InspectorPanel() {
  const asset = useMediaStore(selectedAsset);
  const regenerate = useMediaStore((state) => state.regenerate);
  const [plans, setPlans] = useState<DerivativePlanView[]>([]);

  useEffect(() => {
    if (!asset) {
      setPlans([]);
      return;
    }
    let cancelled = false;
    planMediaDerivatives(asset.id)
      .then((result) => {
        if (!cancelled) {
          setPlans(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPlans([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [asset]);

  if (!asset) {
    return (
      <section className="flex h-full items-center justify-center p-6">
        <p className="text-center text-xs text-slate-500">
          Select a clip to inspect its metadata and generated artifacts.
        </p>
      </section>
    );
  }

  const video = asset.video;
  const audio = asset.audio;

  return (
    <section className="flex h-full min-h-0 flex-col overflow-y-auto">
      <header className="border-b border-slate-800 px-3 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Inspector</h2>
      </header>

      <div className="border-b border-slate-800 p-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Source</h3>
        <dl className="mt-2 flex flex-col gap-1.5 text-[11px]">
          <Row label="File" value={asset.fileName} />
          <Row label="Type" value={`${asset.kind} · ${asset.container ?? "unknown"}`} />
          <Row label="Duration" value={formatDuration(asset.durationSec)} />
          <Row label="Size" value={formatBytes(asset.sizeBytes)} />
          {video && (
            <Row
              label="Video"
              value={`${video.codec} · ${video.displayWidth}×${video.displayHeight} · ${video.fps.toFixed(2)} fps${
                video.rotation !== 0 ? ` · ${video.rotation}°` : ""
              }`}
            />
          )}
          {audio && (
            <Row
              label="Audio"
              value={`${audio.codec} · ${audio.channels} ch · ${audio.sampleRate} Hz`}
            />
          )}
          <Row label="Path" value={asset.originalPath} wrap />
        </dl>
      </div>

      <div className="p-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Generated artifacts
        </h3>
        <ul className="mt-2 flex flex-col gap-2">
          {plans.length === 0 && (
            <li className="text-[11px] text-slate-500">No derivative plan available.</li>
          )}
          {plans.map((plan) => {
            const derivative = derivativeOf(asset, plan.kind);
            const running = derivative?.status === "pending" || derivative?.status === "running";

            return (
              <li
                key={plan.kind}
                className="rounded-md border border-slate-800 bg-slate-900/40 p-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-slate-200">
                    {KIND_LABELS[plan.kind]}
                  </span>
                  <StatusPill status={derivative?.status ?? null} applicable={plan.applicable} />
                </div>

                <p className="mt-1 text-[11px] text-slate-500">
                  {plan.applicable
                    ? (summarizeParams(plan.kind, plan.params) ?? "Ready to generate")
                    : (plan.reason ?? "Not applicable to this asset")}
                </p>

                {derivative?.error && (
                  <p className="mt-1 text-[11px] text-rose-300">{derivative.error}</p>
                )}

                <div className="mt-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!plan.applicable || running}
                    onClick={() => void regenerate(asset.id, plan.kind)}
                  >
                    {derivative?.status === "ready" ? "Regenerate" : "Generate"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function Row({ label, value, wrap = false }: { label: string; value: string; wrap?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-slate-500">{label}</dt>
      <dd
        className={`min-w-0 flex-1 text-slate-300 ${wrap ? "break-all" : "truncate"}`}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function StatusPill({ status, applicable }: { status: string | null; applicable: boolean }) {
  if (!applicable) {
    return <Pill tone="neutral">not applicable</Pill>;
  }
  switch (status) {
    case "ready":
      return <Pill tone="good">ready</Pill>;
    case "running":
      return <Pill tone="info">running</Pill>;
    case "pending":
      return <Pill tone="warn">queued</Pill>;
    case "failed":
      return <Pill tone="bad">failed</Pill>;
    default:
      return <Pill tone="neutral">not generated</Pill>;
  }
}

function summarizeParams(kind: DerivativeKind, params: unknown): string | null {
  if (typeof params !== "object" || params === null) {
    return null;
  }
  const record = params as Record<string, unknown>;

  switch (kind) {
    case "thumbnail":
      return typeof record.height === "number" ? `${record.height}p poster` : null;
    case "filmstrip":
      return typeof record.frames === "number" ? `${record.frames} frames` : null;
    case "waveform":
      return typeof record.buckets === "number" ? `${record.buckets} peaks` : null;
    case "proxy": {
      const parts: string[] = [];
      if (typeof record.height === "number") {
        parts.push(`${record.height}p`);
      }
      if (typeof record.crf === "number") {
        parts.push(`CRF ${record.crf}`);
      }
      if (typeof record.reason === "string") {
        parts.push(record.reason);
      }
      return parts.length > 0 ? parts.join(" · ") : null;
    }
  }
}
