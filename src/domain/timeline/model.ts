import { z } from "zod";

export const trackKinds = ["video", "audio", "text", "captions", "graphics", "effects", "sfx"] as const;
const time = z.number().finite().nonnegative();
const id = z.string().min(1).max(128);

export const clipSchema = z.object({
  id,
  sourceMediaId: id,
  label: z.string().max(512),
  sourceStart: time,
  sourceEnd: time,
  timelineStart: time,
  timelineEnd: time,
  speed: z.literal(1),
  enabled: z.boolean(),
  transform: z.object({
    x: z.number().finite(), y: z.number().finite(), scale: z.number().positive(),
    rotation: z.number().finite(), opacity: z.number().min(0).max(1),
  }),
}).superRefine((clip, ctx) => {
  if (clip.sourceEnd <= clip.sourceStart || clip.timelineEnd <= clip.timelineStart ||
      Math.abs((clip.sourceEnd - clip.sourceStart) - (clip.timelineEnd - clip.timelineStart)) > 0.00001) {
    ctx.addIssue({ code: "custom", message: "Clip source and timeline durations must match and be positive" });
  }
});

export const trackSchema = z.object({
  id, kind: z.enum(trackKinds), name: z.string().min(1).max(128),
  enabled: z.boolean(), locked: z.boolean(), muted: z.boolean(), solo: z.boolean(),
  volume: z.number().min(0).max(1), clips: z.array(clipSchema).max(10000),
});

export const timelineSchema = z.object({
  version: z.literal(1), id, name: z.string().min(1).max(128),
  width: z.number().int().positive(), height: z.number().int().positive(),
  fps: z.number().positive().max(240), duration: time, tracks: z.array(trackSchema).max(64),
}).superRefine((timeline, ctx) => {
  const ids = new Set<string>();
  let duration = 0;
  for (const track of timeline.tracks) {
    if (ids.has(track.id)) ctx.addIssue({ code: "custom", message: "Duplicate track ID" });
    ids.add(track.id);
    let end = 0;
    for (const clip of [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart)) {
      if (ids.has(clip.id)) ctx.addIssue({ code: "custom", message: "Duplicate clip ID" });
      ids.add(clip.id);
      if (clip.timelineStart < end - 0.00001) ctx.addIssue({ code: "custom", message: "Clips on a track cannot overlap" });
      end = clip.timelineEnd;
      duration = Math.max(duration, end);
    }
  }
  if (Math.abs(duration - timeline.duration) > 0.00001) ctx.addIssue({ code: "custom", message: "Incorrect timeline duration" });
});

export type TimelineClip = z.infer<typeof clipSchema>;
export type Track = z.infer<typeof trackSchema>;
export type TrackKind = Track["kind"];
export type Timeline = z.infer<typeof timelineSchema>;
export const defaultTransform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };

export function createTrack(kind: TrackKind, name: string): Track {
  return { id: crypto.randomUUID(), kind, name, enabled: true, locked: false, muted: false, solo: false, volume: 1, clips: [] };
}

export function createTimeline(format: { width: number; height: number; fps: number }): Timeline {
  return { version: 1, id: "main", name: "Reel timeline", ...format, duration: 0,
    tracks: [createTrack("video", "Video 1"), createTrack("audio", "Audio 1")] };
}

export function serializeTimeline(timeline: Timeline): string {
  return JSON.stringify(timelineSchema.parse(timeline));
}

export function deserializeTimeline(json: string): Timeline {
  return timelineSchema.parse(JSON.parse(json) as unknown);
}
