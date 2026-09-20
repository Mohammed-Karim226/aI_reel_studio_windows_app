import { derivativeOf, readyDerivative } from "@/domain/media";
import { assetUrl, derivativeAbsolutePath } from "@/infrastructure/tauri/fileUrl";
import { Pill } from "@/shared/ui/Pill";
import { useMediaStore, selectedAsset } from "@/stores/mediaStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { Filmstrip } from "./Filmstrip";
import { Waveform } from "./Waveform";
import { SourceMonitor } from "./SourceMonitor";
import { TimelinePreview } from "./TimelinePreview";
import { useTimelineStore } from "@/stores/timelineStore";
import { Button } from "@/shared/ui/Button";

export function PreviewPanel() {
  const mode = useTimelineStore((state) => state.mode);
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex gap-2 border-b border-slate-800 p-2">
      <Button size="sm" variant={mode === "source" ? "primary" : "ghost"} onClick={() => useTimelineStore.setState({ mode: "source", playing: false })}>Source</Button>
      <Button size="sm" variant={mode === "timeline" ? "primary" : "ghost"} onClick={() => useTimelineStore.setState({ mode: "timeline" })}>Timeline preview</Button>
    </div>
    <div className="min-h-0 flex-1">{mode === "timeline" ? <TimelinePreview /> : <SourcePreview />}</div>
  </div>;
}

function SourcePreview() {
  const asset = useMediaStore(selectedAsset);
  const totalAssets = useMediaStore((state) => state.assets.length);
  const importFiles = useMediaStore((state) => state.importFiles);
  const projectRoot = useWorkspaceStore((state) => state.project?.rootPath ?? "");

  if (!asset) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-slate-300">
          {totalAssets === 0 ? "Import a long video to get started" : "Select a clip to preview"}
        </p>
        <p className="max-w-sm text-xs leading-5 text-slate-500">
          {totalAssets === 0
            ? "The original file stays untouched. The app builds a proxy, thumbnail, filmstrip and waveform for smooth editing."
            : "Preview uses the proxy when one is ready, and the original file otherwise."}
        </p>
        {totalAssets === 0 && (
          <button
            type="button"
            className="rounded-md bg-indigo-500 px-3.5 py-2 text-xs font-medium text-white hover:bg-indigo-400"
            onClick={() => void importFiles()}
          >
            Import media
          </button>
        )}
      </div>
    );
  }

  const proxy = readyDerivative(asset, "proxy");
  const poster = readyDerivative(asset, "thumbnail");
  const waveform = derivativeOf(asset, "waveform");

  const sourcePath = proxy?.relativePath
    ? derivativeAbsolutePath(projectRoot, proxy.relativePath)
    : asset.originalPath;
  // Keying on the source keeps playback alive while unrelated jobs finish; the derivative's own
  // timestamp busts the cache only when the proxy is actually regenerated.
  const sourceTag = proxy?.updatedAt ?? asset.importedAt;
  const previewKey = `${asset.id}:${sourcePath}:${sourceTag}`;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="truncate text-sm font-medium text-slate-200">{asset.fileName}</h2>
        <Pill tone={proxy ? "good" : "neutral"}>
          {proxy ? "Preview: proxy" : "Preview: original"}
        </Pill>
      </div>

      <SourceMonitor
          asset={asset}
          key={previewKey}
          src={assetUrl(sourcePath, sourceTag)}
          poster={
            poster?.relativePath
              ? assetUrl(derivativeAbsolutePath(projectRoot, poster.relativePath), poster.updatedAt)
              : undefined
          }
        />

      <div className="grid grid-cols-1 gap-3">
        {asset.hasAudio && <Waveform mediaId={asset.id} cacheKey={waveform?.updatedAt ?? "not-generated"} />}
        <Filmstrip asset={asset} projectRoot={projectRoot} />
      </div>
    </div>
  );
}
