import { z } from "zod";

export const mediaKindSchema = z.enum(["video", "audio", "image"]);
export type MediaKind = z.infer<typeof mediaKindSchema>;

export const derivativeKindSchema = z.enum(["thumbnail", "filmstrip", "waveform", "proxy"]);
export type DerivativeKind = z.infer<typeof derivativeKindSchema>;

export const derivativeStatusSchema = z.enum(["pending", "running", "ready", "failed"]);
export type DerivativeStatus = z.infer<typeof derivativeStatusSchema>;

const videoStreamSchema = z.object({
  codec: z.string(),
  width: z.number(),
  height: z.number(),
  displayWidth: z.number(),
  displayHeight: z.number(),
  fps: z.number(),
  rotation: z.number(),
  pixFmt: z.string().nullable(),
  bitRate: z.number().nullable(),
});

export type VideoStreamInfo = z.infer<typeof videoStreamSchema>;

const audioStreamSchema = z.object({
  codec: z.string(),
  channels: z.number(),
  sampleRate: z.number(),
  bitRate: z.number().nullable(),
});

export type AudioStreamInfo = z.infer<typeof audioStreamSchema>;

export const mediaDerivativeSchema = z.object({
  id: z.string(),
  mediaAssetId: z.string(),
  kind: derivativeKindSchema,
  status: derivativeStatusSchema,
  relativePath: z.string().nullable(),
  params: z.unknown(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type MediaDerivative = z.infer<typeof mediaDerivativeSchema>;

export const mediaAssetSchema = z.object({
  id: z.string(),
  originalPath: z.string(),
  fileName: z.string(),
  kind: mediaKindSchema,
  container: z.string().nullable(),
  sizeBytes: z.number(),
  durationSec: z.number(),
  hasVideo: z.boolean(),
  hasAudio: z.boolean(),
  video: videoStreamSchema.nullable(),
  audio: audioStreamSchema.nullable(),
  importedAt: z.string(),
  derivatives: z.array(mediaDerivativeSchema),
});

export type MediaAsset = z.infer<typeof mediaAssetSchema>;

/** Whether a derivative applies to an asset, and why not when it does not. */
export const derivativePlanViewSchema = z.object({
  kind: derivativeKindSchema,
  applicable: z.boolean(),
  reason: z.string().nullable(),
  params: z.unknown(),
});

export type DerivativePlanView = z.infer<typeof derivativePlanViewSchema>;

export const waveformDataSchema = z.object({
  version: z.number(),
  sampleRate: z.number(),
  durationSec: z.number(),
  peaks: z.array(z.number()),
});

export type WaveformData = z.infer<typeof waveformDataSchema>;

const skippedImportSchema = z.object({
  path: z.string(),
  reason: z.string(),
});

export type SkippedImport = z.infer<typeof skippedImportSchema>;

export const importOutcomeSchema = z.object({
  imported: z.array(mediaAssetSchema),
  skipped: z.array(skippedImportSchema),
});

export type ImportOutcome = z.infer<typeof importOutcomeSchema>;

export function derivativeOf(asset: MediaAsset, kind: DerivativeKind): MediaDerivative | null {
  return asset.derivatives.find((derivative) => derivative.kind === kind) ?? null;
}

export function readyDerivative(asset: MediaAsset, kind: DerivativeKind): MediaDerivative | null {
  const derivative = derivativeOf(asset, kind);
  return derivative?.status === "ready" ? derivative : null;
}
