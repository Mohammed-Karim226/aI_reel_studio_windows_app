import { derivativeOf, type DerivativeKind, type MediaAsset } from "@/domain/media";
import { assetUrl, derivativeAbsolutePath } from "@/infrastructure/tauri/fileUrl";
import { cn } from "@/shared/cn";
import { formatBytes, formatDuration } from "@/shared/format";
import { Pill } from "@/shared/ui/Pill";

const DERIVATIVE_ORDER: DerivativeKind[] = ["thumbnail", "filmstrip", "waveform", "proxy"];

const DOT_TONES: Record<string, string> = {
  ready: "bg-emerald-400",
  pending: "bg-slate-500",
  running: "bg-amber-400 animate-pulse",
  failed: "bg-rose-500",
};

interface MediaCardProps {
  asset: MediaAsset;
  projectRoot: string;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
}

export function MediaCard({ asset, projectRoot, selected, onSelect, onRemove }: MediaCardProps) {
  const thumbnail = derivativeOf(asset, "thumbnail");
  const thumbnailUrl =
    thumbnail?.status === "ready" && thumbnail.relativePath
      ? assetUrl(
          derivativeAbsolutePath(projectRoot, thumbnail.relativePath),
          // Cache-bust on the artifact itself, so unrelated job completions do not re-download
          // every thumbnail in the library.
          thumbnail.updatedAt,
        )
      : null;

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "group flex w-full items-start gap-3 rounded-md border p-2 text-left transition-colors",
          selected
            ? "border-indigo-500/70 bg-indigo-500/10"
            : "border-transparent hover:border-slate-700 hover:bg-slate-800/60",
        )}
      >
        <div className="flex h-[52px] w-[92px] shrink-0 items-center justify-center overflow-hidden rounded bg-slate-950">
          {thumbnailUrl ? (
            <img src={thumbnailUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="text-[10px] uppercase text-slate-600">
              {thumbnail?.status ?? "no art"}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-slate-100">{asset.fileName}</p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {formatDuration(asset.durationSec)} · {formatBytes(asset.sizeBytes)}
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            {DERIVATIVE_ORDER.map((kind) => {
              const derivative = derivativeOf(asset, kind);
              const status = derivative?.status ?? "pending";
              return (
                <span
                  key={kind}
                  title={`${kind}: ${derivative?.status ?? "not generated"}`}
                  className={cn("h-1.5 w-1.5 rounded-full", DOT_TONES[status] ?? "bg-slate-700")}
                />
              );
            })}
            <Pill tone="neutral" className="ml-1">
              {asset.kind}
            </Pill>
          </div>
        </div>
      </button>

      <div className="mt-1 flex justify-end">
        <button
          type="button"
          onClick={onRemove}
          className="rounded px-1.5 py-0.5 text-[10px] text-slate-500 opacity-0 transition-opacity hover:bg-slate-800 hover:text-rose-300 focus:opacity-100 group-hover:opacity-100"
        >
          Remove from project
        </button>
      </div>
    </li>
  );
}
