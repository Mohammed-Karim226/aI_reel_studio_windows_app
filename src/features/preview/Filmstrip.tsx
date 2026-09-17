import { readyDerivative, type MediaAsset } from "@/domain/media";
import { assetUrl, derivativeAbsolutePath } from "@/infrastructure/tauri/fileUrl";

interface FilmstripProps {
  asset: MediaAsset;
  projectRoot: string;
}

/** Sampled frames of the source, used as a visual index until the Phase 2 timeline exists. */
export function Filmstrip({ asset, projectRoot }: FilmstripProps) {
  const filmstrip = readyDerivative(asset, "filmstrip");

  if (!filmstrip?.relativePath) {
    return (
      <div className="flex h-16 w-full items-center justify-center rounded-md border border-slate-800 bg-slate-950/60">
        <span className="text-[11px] text-slate-500">Filmstrip not generated yet</span>
      </div>
    );
  }

  return (
    <img
      src={assetUrl(
        derivativeAbsolutePath(projectRoot, filmstrip.relativePath),
        filmstrip.updatedAt,
      )}
      alt={`Sampled frames of ${asset.fileName}`}
      className="h-16 w-full rounded-md border border-slate-800 object-cover"
    />
  );
}
