import { captionTrackSchema } from "@/domain/captions";
import { createEffect, effectStackSchema } from "@/domain/effects";
import { createHookLayer, createPopAnimations, hookSchema } from "@/domain/hook";
import type { Edit } from "@/domain/timeline/edit";
import { timelineSchema, type Timeline } from "@/domain/timeline/model";
import { activeClips, sourceTime } from "@/domain/timeline/playback";
import { hookReviewTextSchema, reviewSuggestionSchema, type ReviewSuggestion } from "./model";

/** Convert a reviewed proposal to one normal, undoable editor command. */
export function suggestionEdit(
  timeline: Timeline,
  suggestion: ReviewSuggestion,
  hookText?: string,
): Edit | null {
  const current = timelineSchema.parse(timeline);
  const proposal = reviewSuggestionSchema.parse(suggestion);
  if (proposal.end > current.duration + 0.00001)
    throw new Error("The review range no longer fits the timeline. Run the review again.");
  const action = proposal.action;
  if (!action) return null;
  switch (action.type) {
    case "openingHook": {
      const text = hookReviewTextSchema.parse(hookText ?? action.text);
      if (!text) throw new Error("Write the opening hook before previewing or applying it.");
      if (current.hook.layers.length >= 32)
        throw new Error("Remove a hook layer before adding another one.");
      const duration = Math.min(2, current.duration);
      const layer = createHookLayer("main");
      layer.text = text;
      layer.end = duration;
      layer.animations = duration >= 0.3 ? createPopAnimations() : [];
      return {
        type: "setHook",
        hook: hookSchema.parse({
          ...current.hook,
          enabled: true,
          duration: Math.max(current.hook.duration, duration),
          layers: [...current.hook.layers, layer],
        }),
      };
    }
    case "captionStyle":
      if (!current.captions.enabled || !current.captions.segments.length)
        throw new Error("Enable or generate captions before changing their review style.");
      return {
        type: "captions",
        captions: captionTrackSchema.parse({
          ...current.captions,
          style: { ...current.captions.style, ...action.patch },
        }),
      };
    case "addZoom": {
      const track = current.tracks.find((item) =>
        item.clips.some((clip) => clip.id === action.clipId),
      );
      const clip = track?.clips.find((item) => item.id === action.clipId);
      if (!track || !clip || track.kind !== "video" || !track.enabled || !clip.enabled)
        throw new Error("The zoom's video clip is no longer available.");
      if (track.locked) throw new Error(`Unlock ${track.name} before applying this zoom.`);
      const end = action.at + action.duration;
      if (action.at < clip.timelineStart || end > clip.timelineEnd + 0.00001)
        throw new Error("The zoom must stay inside the selected clip.");
      const boundaries = [
        action.at,
        end,
        ...current.tracks.flatMap((item) =>
          item.clips.flatMap((entry) => [entry.timelineStart, entry.timelineEnd]),
        ),
      ]
        .filter((at) => at >= action.at && at <= end)
        .sort((a, b) => a - b);
      for (let index = 1; index < boundaries.length; index++) {
        if (boundaries[index] === boundaries[index - 1]) continue;
        const visible = activeClips(current, (boundaries[index - 1] + boundaries[index]) / 2).find(
          (item) => item.visible,
        )?.clip;
        if (visible?.id !== clip.id)
          throw new Error("Another video covers this zoom. Run the review again.");
      }
      if (clip.effects.length >= 16)
        throw new Error("Remove an effect before adding another one to this clip.");
      if (
        clip.effects.some((effect) => effect.enabled && ["zoom", "punchZoom"].includes(effect.type))
      )
        throw new Error("This clip already has a zoom. Adjust its existing effect instead.");
      const sourceStart = sourceTime(clip, action.at);
      const effect = createEffect("punchZoom", sourceStart, action.duration);
      // A restrained pulse spans the proposed interval and returns to the original framing.
      effect.animations[0].keyframes = [
        { time: sourceStart, value: 1, easing: "linear" },
        { time: sourceStart + action.duration * 0.25, value: 1.12, easing: "ease-out" },
        { time: sourceStart + action.duration * 0.7, value: 1.12, easing: "linear" },
        { time: sourceStart + action.duration, value: 1, easing: "ease-in-out" },
      ];
      return {
        type: "effects",
        id: clip.id,
        effects: effectStackSchema.parse([...clip.effects, effect]),
      };
    }
  }
}
