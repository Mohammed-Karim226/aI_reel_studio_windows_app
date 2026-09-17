import { Button } from "@/shared/ui/Button";
import { useMediaStore } from "@/stores/mediaStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { MediaCard } from "./MediaCard";

export function MediaPanel() {
  const assets = useMediaStore((state) => state.assets);
  const selectedId = useMediaStore((state) => state.selectedId);
  const importing = useMediaStore((state) => state.importing);
  const loading = useMediaStore((state) => state.loading);
  const select = useMediaStore((state) => state.select);
  const remove = useMediaStore((state) => state.remove);
  const importFiles = useMediaStore((state) => state.importFiles);
  const projectRoot = useWorkspaceStore((state) => state.project?.rootPath ?? "");

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-slate-800 px-3 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Media {assets.length > 0 && `(${assets.length})`}
        </h2>
        <Button size="sm" variant="primary" onClick={() => void importFiles()} disabled={importing}>
          {importing ? "Importing…" : "Import"}
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading && assets.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-slate-500">Loading library…</p>
        ) : assets.length === 0 ? (
          <div className="px-2 py-8 text-center">
            <p className="text-xs text-slate-400">No media yet.</p>
            <p className="mt-1 text-[11px] leading-5 text-slate-500">
              Import a long video or podcast. Original files are never modified.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {assets.map((asset) => (
              <MediaCard
                key={asset.id}
                asset={asset}
                projectRoot={projectRoot}
                selected={asset.id === selectedId}
                onSelect={() => select(asset.id)}
                onRemove={() => {
                  if (
                    window.confirm(
                      `Remove "${asset.fileName}" from this project?\n\nThe original file is not deleted.`,
                    )
                  ) {
                    void remove(asset.id);
                  }
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
