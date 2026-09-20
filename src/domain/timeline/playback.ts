import type { Timeline, TimelineClip, Track } from "./model";

export function activeClips(timeline: Timeline, time: number): { track: Track; clip: TimelineClip; visible: boolean; audible: boolean }[] {
  const solo = timeline.tracks.some((track) => track.enabled && track.solo);
  const active = timeline.tracks.filter((track) => track.enabled).flatMap((track) =>
    track.clips.filter((clip) => clip.enabled && clip.timelineStart <= time && clip.timelineEnd > time)
      .map((clip) => ({ track, clip })));
  const topVideo = active.find((item) => item.track.kind === "video");
  return active.map((item) => ({ ...item, visible: item === topVideo,
    audible: !item.track.muted && (!solo || item.track.solo) }));
}

export function sourceTime(clip: TimelineClip, timelineTime: number): number {
  return Math.min(clip.sourceEnd, Math.max(clip.sourceStart, clip.sourceStart + timelineTime - clip.timelineStart));
}
