import type { CaptionSegment, CaptionStyle } from "@/domain/captions";
import { evaluateHookLayer } from "@/domain/hook";
import { safeZones, type SafeZonePlatform } from "@/domain/safeZones";
import { timelineSchema, type Timeline, type TimelineClip } from "@/domain/timeline/model";
import { reviewSuggestionSchema, type ReviewSuggestion } from "./model";

interface VisibleSpan {
  start: number;
  end: number;
  clip: TimelineClip | null;
  locked: boolean;
}

/** Same first-enabled-video priority as timeline playback, including covered clip boundaries. */
function visibleSpans(timeline: Timeline): VisibleSpan[] {
  const events = timeline.tracks
    .flatMap((track, priority) =>
      track.enabled && track.kind === "video"
        ? track.clips
            .filter((clip) => clip.enabled)
            .flatMap((clip) => [
              { at: clip.timelineStart, priority, clip, start: true, locked: track.locked },
              { at: clip.timelineEnd, priority, clip, start: false, locked: track.locked },
            ])
        : [],
    )
    .sort((a, b) => a.at - b.at || Number(a.start) - Number(b.start));
  const active = new Map<number, { clip: TimelineClip; locked: boolean }>();
  const spans: VisibleSpan[] = [];
  let cursor = 0;
  const append = (end: number) => {
    if (end <= cursor) return;
    let top: { clip: TimelineClip; locked: boolean } | undefined;
    let priority = Infinity;
    for (const [index, entry] of active) {
      if (index < priority) {
        priority = index;
        top = entry;
      }
    }
    const clip = top?.clip ?? null;
    const previous = spans.at(-1);
    if (previous?.clip === clip && previous.end === cursor) previous.end = end;
    else spans.push({ start: cursor, end, clip, locked: top?.locked ?? false });
    cursor = end;
  };
  for (const event of events) {
    append(event.at);
    if (event.start) active.set(event.priority, { clip: event.clip, locked: event.locked });
    else active.delete(event.priority);
  }
  append(timeline.duration);
  return spans;
}

function excerpt(segments: CaptionSegment[], openingEnd: number): string {
  const text = segments
    .flatMap((segment) => segment.words)
    .filter((word) => word.start < openingEnd)
    .map((word) => word.text)
    .join(" ");
  let result = "";
  for (const character of text) {
    if (result.length + character.length > 160) break;
    const next = result + character;
    if (new TextEncoder().encode(next).length > 500) break;
    result = next;
  }
  return result.trim();
}

/** Conservative text estimate only; actual line wrapping depends on fonts and language. */
function captionHeight(
  segments: CaptionSegment[],
  style: CaptionStyle,
  width: number,
  height: number,
): number {
  const available = Math.max(1, (width * style.maxWidth) / 100 - style.fontSize * 0.5);
  const charactersPerLine = Math.max(1, Math.floor(available / (style.fontSize * 0.65)));
  let lines = 1;
  for (const segment of segments) {
    const text = segment.words.map((word) => word.text).join(" ");
    const count = text
      .split("\n")
      .reduce(
        (total, line) => total + Math.max(1, Math.ceil([...line].length / charactersPerLine)),
        0,
      );
    lines = Math.max(lines, count);
  }
  const padding = style.background === "transparent" ? 0 : style.fontSize * 0.3;
  return (
    ((lines * style.fontSize * style.lineHeight + padding + style.outlineWidth * 2) / height) * 100
  );
}

/** Deterministic review of actual timeline metadata; no speech, scene, or quality predictions. */
export function analyzeReel(timeline: Timeline, platform: SafeZonePlatform): ReviewSuggestion[] {
  const current = timelineSchema.parse(timeline);
  if (!Object.prototype.hasOwnProperty.call(safeZones, platform))
    throw new Error("Choose a supported safe-zone platform.");
  const zone = safeZones[platform];
  if (!current.duration) return [];
  const suggestions: ReviewSuggestion[] = [];
  const add = (suggestion: ReviewSuggestion) => {
    if (suggestions.length < 50) suggestions.push(reviewSuggestionSchema.parse(suggestion));
  };
  const openingEnd = Math.min(3, current.duration);
  const segments = current.captions.segments.filter((segment) => segment.start < current.duration);
  const captionRange = {
    start: segments[0]?.start ?? 0,
    end: Math.min(segments.at(-1)?.end ?? current.duration, current.duration),
  };
  const openingLayer =
    current.hook.enabled &&
    current.hook.layers.some((layer) => {
      const end = Math.min(layer.end, openingEnd);
      if (!layer.text.trim() || layer.start >= end) return false;
      const times = [
        layer.start,
        (layer.start + end) / 2,
        end,
        ...layer.animations.flatMap((animation) => animation.keyframes.map((frame) => frame.time)),
      ].filter((time) => time >= layer.start && time <= end);
      return times.some((time) => evaluateHookLayer(layer, time).opacity > 0);
    });
  if (!openingLayer) {
    const disabledExisting = !current.hook.enabled && current.hook.layers.length > 0;
    add({
      id: "opening-hook",
      category: "hook",
      title: disabledExisting ? "Existing hook is disabled" : "Add an opening hook",
      explanation: disabledExisting
        ? "The hook composition contains layers but is disabled. Review and enable it in the Hook Designer."
        : "No visible hook text is scheduled in the first three seconds. The draft uses only opening caption words; review or write the exact text. Applying adds a layer and preserves existing hook layers.",
      start: 0,
      end: openingEnd,
      action:
        disabledExisting || current.hook.layers.length >= 32
          ? null
          : { type: "openingHook", text: excerpt(segments, openingEnd) },
    });
  }

  if (!current.captions.enabled || !segments.length) {
    add({
      id: "missing-captions",
      category: "captions",
      title: current.captions.enabled ? "No captions on this timeline" : "Captions are disabled",
      explanation:
        "Use the caption tools to generate, review, or enable captions if this Reel contains speech. Timeline metadata does not establish whether speech is present.",
      start: 0,
      end: current.duration,
      action: null,
    });
  } else {
    const style = current.captions.style;
    const readableFontSize = Math.min(200, Math.max(10, Math.round(current.width * 0.045)));
    if (style.fontSize < current.width * 0.035 && readableFontSize > style.fontSize) {
      add({
        id: "caption-size",
        category: "captions",
        title: "Caption text may be small",
        explanation:
          "The caption font is smaller than 3.5% of the canvas width. Increase it for a phone preview, then check wrapping and safe zones.",
        ...captionRange,
        action: {
          type: "captionStyle",
          patch: { fontSize: readableFontSize },
        },
      });
    }
    const longCaption = segments.find(
      (segment) => segment.end - segment.start >= 4 && segment.words.length > 1,
    );
    if (longCaption && style.highlighting === "none") {
      add({
        id: "caption-emphasis",
        category: "captions",
        title: "A caption stays unchanged for four seconds",
        explanation:
          "Use word highlighting and a short entrance animation to mark the existing word times. This changes the caption track's style and keeps every word and timestamp.",
        start: longCaption.start,
        end: Math.min(longCaption.end, current.duration),
        action: { type: "captionStyle", patch: { highlighting: "word", animation: "pop" } },
      });
    }
    const dense = segments.find(
      (segment) =>
        segment.words.length > 8 ||
        segment.words.map((word) => word.text).join(" ").length / (segment.end - segment.start) >
          24,
    );
    if (dense) {
      add({
        id: "caption-density",
        category: "captions",
        title: "Review a dense caption",
        explanation:
          "This caption contains more than eight words or exceeds 24 characters per second. Split it at an existing word boundary in the caption tools; keep the recognized word times.",
        start: dense.start,
        end: Math.min(dense.end, current.duration),
        action: null,
      });
    }

    const estimatedHeight = captionHeight(segments, style, current.width, current.height);
    const unsafe =
      style.x - style.maxWidth / 2 < zone.left ||
      style.x + style.maxWidth / 2 > 100 - zone.right ||
      style.y - estimatedHeight / 2 < zone.top ||
      style.y + estimatedHeight / 2 > 100 - zone.bottom;
    if (unsafe) {
      const proposed = {
        ...style,
        maxWidth: Math.min(style.maxWidth, 100 - zone.left - zone.right - 4),
      };
      const usableHeight = 100 - zone.top - zone.bottom - 4;
      let height = captionHeight(segments, proposed, current.width, current.height);
      while (height > usableHeight && proposed.fontSize > 10) {
        proposed.fontSize = Math.max(10, Math.floor(proposed.fontSize * 0.9));
        height = captionHeight(segments, proposed, current.width, current.height);
      }
      const x = (zone.left + 100 - zone.right) / 2;
      const y = Math.min(
        100 - zone.bottom - 2 - height / 2,
        Math.max(zone.top + 2 + height / 2, style.y),
      );
      add({
        id: `caption-safe-zone:${platform}`,
        category: "safeZone",
        title: `Check captions against the ${zone.label} guide`,
        explanation:
          height <= usableHeight
            ? "The caption box or its estimated text height crosses this platform's guide. Adjust position, width, and font size to fit the estimate, then check actual wrapping in Preview. Font and language differences make this an estimate, not a visibility guarantee."
            : "The caption box or its estimated text height crosses this platform's guide and cannot fit within the available style limits. Split long captions manually, then check actual wrapping and placement in Preview.",
        ...captionRange,
        action:
          height <= usableHeight
            ? {
                type: "captionStyle",
                patch: { x, y, maxWidth: proposed.maxWidth, fontSize: proposed.fontSize },
              }
            : null,
      });
    }
  }

  if (current.hook.enabled) {
    for (const layer of current.hook.layers) {
      if (!layer.text.trim() || layer.start >= current.duration) continue;
      const end = Math.min(layer.end, current.duration);
      const times = [
        layer.start,
        end,
        ...layer.animations.flatMap((animation) => animation.keyframes.map((frame) => frame.time)),
      ].filter((time) => time >= layer.start && time <= end);
      const unsafe = times.some((time) => {
        const transform = evaluateHookLayer(layer, time);
        return (
          transform.opacity > 0 &&
          (50 + transform.x < zone.left ||
            50 + transform.x > 100 - zone.right ||
            50 + transform.y < zone.top ||
            50 + transform.y > 100 - zone.bottom)
        );
      });
      if (unsafe)
        add({
          id: `hook-safe-zone:${layer.id}:${platform}`,
          category: "safeZone",
          title: `Hook text anchor leaves the ${zone.label} guide`,
          explanation:
            "A visible hook anchor is outside the platform guide at a layer boundary or animation keyframe. Adjust its position and animation in the Hook Designer. This checks anchor positions; text extents and rotation still need a visual check.",
          start: layer.start,
          end,
          action: null,
        });
    }
  }

  const zoomed = new Set<string>();
  for (const span of visibleSpans(current)) {
    const duration = span.end - span.start;
    if (!span.clip) {
      if (duration >= 0.5)
        add({
          id: `video-gap:${span.start}`,
          category: "weakSection",
          title: "No enabled video clip in this range",
          explanation: `The video tracks have a ${duration.toFixed(1)} second gap. Hook or caption overlays may still be present. Review the range and move or trim clips manually if the gap is unintended.`,
          start: span.start,
          end: span.end,
          action: null,
        });
      continue;
    }
    const clip = span.clip;
    if (duration >= 12 || duration < 0.35)
      add({
        id: `pacing:${clip.id}:${span.start}`,
        category: "pacing",
        title:
          duration >= 12 ? "Long range without a timeline cut" : "Very short visible clip range",
        explanation:
          duration >= 12
            ? `The same video clip is on top for ${duration.toFixed(1)} seconds. Check the source motion and delivery before choosing a cut; footage content and speech were not analyzed.`
            : `This video clip is visible for ${duration.toFixed(2)} seconds. Preview the transition and adjust its timing if it feels abrupt.`,
        start: span.start,
        end: span.end,
        action: null,
      });
    if (clip.transform.opacity === 0 || clip.effects.filter((effect) => effect.enabled).length >= 5)
      add({
        id: `weak-clip:${clip.id}:${span.start}`,
        category: "weakSection",
        title:
          clip.transform.opacity === 0
            ? "Video clip opacity is zero"
            : "Review a large effect stack",
        explanation:
          clip.transform.opacity === 0
            ? "The top video clip is fully transparent. Check its opacity and the composition in the clip inspector."
            : "At least five effects are enabled on this clip. Preview their combined result and disable any unnecessary effects.",
        start: span.start,
        end: span.end,
        action: null,
      });
    const hasZoom = clip.effects.some(
      (effect) => effect.enabled && ["zoom", "punchZoom"].includes(effect.type),
    );
    if (
      duration >= 8 &&
      !span.locked &&
      clip.transform.opacity > 0 &&
      !hasZoom &&
      clip.effects.length < 16 &&
      !zoomed.has(clip.id)
    ) {
      zoomed.add(clip.id);
      const at = span.start + Math.min(3, duration / 3);
      const zoomDuration = Math.min(1.2, span.end - at);
      add({
        id: `zoom:${clip.id}:${span.start}`,
        category: "zoom",
        title: "Try a subtle zoom on this long clip",
        explanation:
          "This video clip stays on top for at least eight seconds with no enabled zoom effect. Preview a 12% zoom pulse, then check framing. This is a timeline-based option; camera motion, faces, and subject position were not analyzed.",
        start: at,
        end: at + zoomDuration,
        action: { type: "addZoom", clipId: clip.id, at, duration: zoomDuration },
      });
    }
  }
  return suggestions;
}
