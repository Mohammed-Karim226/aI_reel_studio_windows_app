export type SafeZonePlatform = "instagram" | "tiktok" | "shorts" | "facebook";

/** Approximate platform UI guides, expressed as percentages of the canvas. */
export const safeZones: Record<
  SafeZonePlatform,
  { label: string; top: number; right: number; bottom: number; left: number }
> = {
  instagram: { label: "Instagram", top: 8, right: 7, bottom: 14, left: 7 },
  tiktok: { label: "TikTok", top: 8, right: 6, bottom: 18, left: 6 },
  shorts: { label: "YouTube Shorts", top: 7, right: 6, bottom: 12, left: 6 },
  facebook: { label: "Facebook", top: 8, right: 6, bottom: 15, left: 6 },
};
