import { z } from "zod";

import {
  derivativeKindSchema,
  derivativePlanViewSchema,
  importOutcomeSchema,
  mediaAssetSchema,
  waveformDataSchema,
  type DerivativeKind,
  type DerivativePlanView,
  type ImportOutcome,
  type MediaAsset,
  type WaveformData,
} from "@/domain/media";
import { invokeCommand } from "./invoke";

export function importMedia(paths: string[]): Promise<ImportOutcome> {
  return invokeCommand("import_media", { paths }, importOutcomeSchema);
}

export function listMedia(): Promise<MediaAsset[]> {
  return invokeCommand("list_media", {}, z.array(mediaAssetSchema));
}

export function getMedia(mediaId: string): Promise<MediaAsset> {
  return invokeCommand("get_media", { mediaId }, mediaAssetSchema);
}

export function removeMedia(mediaId: string): Promise<null> {
  return invokeCommand("remove_media", { mediaId }, z.null());
}

export function planMediaDerivatives(mediaId: string): Promise<DerivativePlanView[]> {
  return invokeCommand("plan_media_derivatives", { mediaId }, z.array(derivativePlanViewSchema));
}

export function regenerateDerivative(mediaId: string, kind: DerivativeKind): Promise<string> {
  const parsedKind: DerivativeKind = derivativeKindSchema.parse(kind);
  return invokeCommand("regenerate_derivative", { mediaId, kind: parsedKind }, z.string());
}

export function readWaveform(mediaId: string): Promise<WaveformData> {
  return invokeCommand("read_waveform", { mediaId }, waveformDataSchema);
}
