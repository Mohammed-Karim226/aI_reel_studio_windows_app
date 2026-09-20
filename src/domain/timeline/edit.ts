import type { MediaAsset } from "@/domain/media";
import { createTrack, defaultTransform, timelineSchema, type Timeline, type TimelineClip, type Track, type TrackKind } from "./model";

export type Edit =
  | { type: "addTrack"; kind: TrackKind }
  | { type: "removeTrack"; trackId: string }
  | { type: "track"; trackId: string; patch: Partial<Pick<Track, "name" | "enabled" | "locked" | "muted" | "solo" | "volume">> }
  | { type: "add"; trackId: string; asset: MediaAsset; start: number; sourceStart: number; sourceEnd: number }
  | { type: "split"; ids: string[]; at: number }
  | { type: "trim"; id: string; edge: "start" | "end"; at: number }
  | { type: "move"; id: string; trackId: string; at: number }
  | { type: "delete"; ids: string[]; ripple?: boolean }
  | { type: "duplicate"; ids: string[] };

export const frameTime = (seconds: number, fps: number) => Math.max(0, Math.round(seconds * fps) / fps);
export const clipDuration = (clip: TimelineClip) => clip.timelineEnd - clip.timelineStart;

export function acceptsMedia(track: Track, asset: MediaAsset): boolean {
  return track.kind === "video" ? asset.hasVideo || asset.kind === "image"
    : (track.kind === "audio" || track.kind === "sfx") && asset.hasAudio;
}

function editable(track: Track) {
  if (track.locked) throw new Error(`Unlock ${track.name} before editing it`);
}

export function applyEdit(current: Timeline, edit: Edit, assets: MediaAsset[]): Timeline {
  const next = structuredClone(current);
  const trackById = (id: string) => {
    const track = next.tracks.find((item) => item.id === id);
    if (!track) throw new Error("Track not found");
    return track;
  };
  const locate = (id: string) => {
    for (const track of next.tracks) {
      const clip = track.clips.find((item) => item.id === id);
      if (clip) { editable(track); return { track, clip }; }
    }
    throw new Error("Clip not found");
  };
  const quantize = (value: number) => frameTime(value, next.fps);

  switch (edit.type) {
    case "addTrack":
      next.tracks.push(createTrack(edit.kind, `${edit.kind === "video" ? "Video" : "Audio"} ${next.tracks.filter((track) => track.kind === edit.kind).length + 1}`));
      break;
    case "removeTrack": {
      const track = trackById(edit.trackId);
      editable(track);
      if (track.clips.length) throw new Error("Delete the track's clips before removing it");
      next.tracks = next.tracks.filter((item) => item.id !== track.id);
      break;
    }
    case "track":
      Object.assign(trackById(edit.trackId), edit.patch);
      break;
    case "add": {
      const track = trackById(edit.trackId);
      editable(track);
      if (!acceptsMedia(track, edit.asset)) throw new Error("Choose a compatible video or audio track");
      const sourceStart = quantize(edit.sourceStart);
      const sourceEnd = quantize(edit.sourceEnd);
      const start = quantize(edit.start);
      track.clips.push({ id: crypto.randomUUID(), sourceMediaId: edit.asset.id, label: edit.asset.fileName,
        sourceStart, sourceEnd, timelineStart: start, timelineEnd: start + sourceEnd - sourceStart,
        speed: 1, enabled: true, transform: { ...defaultTransform } });
      break;
    }
    case "split":
      for (const id of edit.ids) {
        const { track, clip } = locate(id);
        const at = quantize(edit.at);
        if (at <= clip.timelineStart + 0.00001 || at >= clip.timelineEnd - 0.00001) continue;
        const sourceAt = clip.sourceStart + at - clip.timelineStart;
        track.clips.push({ ...structuredClone(clip), id: crypto.randomUUID(), sourceStart: sourceAt, timelineStart: at });
        clip.sourceEnd = sourceAt;
        clip.timelineEnd = at;
      }
      break;
    case "trim": {
      const { clip } = locate(edit.id);
      const at = quantize(edit.at);
      if (edit.edge === "start") {
        clip.sourceStart += at - clip.timelineStart;
        clip.timelineStart = at;
      } else {
        clip.sourceEnd += at - clip.timelineEnd;
        clip.timelineEnd = at;
      }
      break;
    }
    case "move": {
      const { track, clip } = locate(edit.id);
      const target = trackById(edit.trackId);
      editable(target);
      const duration = clipDuration(clip);
      clip.timelineStart = quantize(edit.at);
      clip.timelineEnd = clip.timelineStart + duration;
      track.clips = track.clips.filter((item) => item.id !== clip.id);
      target.clips.push(clip);
      break;
    }
    case "delete":
      for (const track of next.tracks) {
        const removed = track.clips.filter((clip) => edit.ids.includes(clip.id));
        if (!removed.length) continue;
        editable(track);
        track.clips = track.clips.filter((clip) => !edit.ids.includes(clip.id));
        if (edit.ripple) for (const clip of track.clips) {
          const shift = removed.filter((item) => item.timelineEnd <= clip.timelineStart + 0.00001).reduce((sum, item) => sum + clipDuration(item), 0);
          clip.timelineStart -= shift;
          clip.timelineEnd -= shift;
        }
      }
      break;
    case "duplicate":
      for (const id of edit.ids) {
        const { track, clip } = locate(id);
        const at = Math.max(0, ...track.clips.map((item) => item.timelineEnd));
        track.clips.push({ ...structuredClone(clip), id: crypto.randomUUID(), timelineStart: at, timelineEnd: at + clipDuration(clip) });
      }
      break;
  }

  for (const track of next.tracks) {
    track.clips.sort((a, b) => a.timelineStart - b.timelineStart);
    for (const clip of track.clips) {
      const asset = assets.find((item) => item.id === clip.sourceMediaId);
      if (!asset) throw new Error("A clip's source media is missing");
      if (!acceptsMedia(track, asset)) throw new Error("This media cannot be placed on that track");
      if (asset.kind !== "image" && clip.sourceEnd > asset.durationSec + 0.00001) throw new Error("Trim exceeds the source duration");
    }
  }
  next.duration = Math.max(0, ...next.tracks.flatMap((track) => track.clips.map((clip) => clip.timelineEnd)));
  const result = timelineSchema.safeParse(next);
  if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid edit");
  return result.data;
}

/** Snap either edge of a moving clip within a fixed screen distance. */
export function snapTime(at: number, duration: number, targets: number[], threshold: number): number {
  let best = at;
  let distance = threshold + Number.EPSILON;
  for (const target of targets) for (const edge of [0, duration]) {
    const candidate = target - edge;
    const delta = Math.abs(candidate - at);
    if (candidate >= 0 && delta < distance) { best = candidate; distance = delta; }
  }
  return Math.max(0, best);
}
