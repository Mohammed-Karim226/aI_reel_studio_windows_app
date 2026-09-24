import { z } from "zod";

const time = z.number().finite().nonnegative();
const color = z
  .string()
  .regex(/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i, "Use a hex color such as #ffffff");
const epsilon = 0.00001;

export const captionWordSchema = z
  .object({
    text: z.string().trim().min(1).max(512),
    start: time,
    end: time,
    emphasis: z.boolean().default(false),
  })
  .superRefine((word, ctx) => {
    if (word.end <= word.start)
      ctx.addIssue({ code: "custom", message: "Word end must be after its start" });
  });

export const captionSegmentSchema = z
  .object({
    id: z.string().min(1).max(128),
    start: time,
    end: time,
    words: z.array(captionWordSchema).min(1).max(100),
  })
  .superRefine((segment, ctx) => {
    if (segment.end <= segment.start)
      ctx.addIssue({ code: "custom", message: "Caption end must be after its start" });
    segment.words.forEach((word, index) => {
      if (word.start < segment.start - epsilon || word.end > segment.end + epsilon) {
        ctx.addIssue({
          code: "custom",
          message: "Word timestamps must stay inside the caption",
          path: ["words", index],
        });
      }
      if (index > 0 && word.start < segment.words[index - 1].start) {
        ctx.addIssue({
          code: "custom",
          message: "Words must be ordered by start time",
          path: ["words", index],
        });
      }
    });
  });

export const captionStyleSchema = z.object({
  preset: z.enum([
    "classic",
    "bold",
    "karaoke",
    "highlight",
    "minimal",
    "podcast",
    "impact",
    "dynamic",
    "arabic",
  ]),
  fontFamily: z.string().trim().min(1).max(128),
  fontSize: z.number().finite().min(10).max(200),
  fontWeight: z.union([z.literal(400), z.literal(700), z.literal(900)]),
  color,
  highlightColor: color,
  outlineColor: color,
  outlineWidth: z.number().finite().min(0).max(12),
  shadow: z.boolean(),
  background: z.union([color, z.literal("transparent")]),
  x: z.number().finite().min(0).max(100),
  y: z.number().finite().min(0).max(100),
  lineHeight: z.number().finite().min(0.8).max(2),
  maxWidth: z.number().finite().min(10).max(100),
  direction: z.enum(["auto", "ltr", "rtl"]),
  animation: z.enum(["none", "fade", "pop"]),
  highlighting: z.enum(["none", "word", "karaoke"]),
});

export const captionTrackSchema = z
  .object({
    enabled: z.boolean(),
    style: captionStyleSchema,
    segments: z.array(captionSegmentSchema).max(10000),
  })
  .superRefine((captions, ctx) => {
    const ids = new Set<string>();
    captions.segments.forEach((segment, index) => {
      if (ids.has(segment.id))
        ctx.addIssue({
          code: "custom",
          message: "Caption IDs must be unique",
          path: ["segments", index],
        });
      ids.add(segment.id);
      if (index > 0 && segment.start < captions.segments[index - 1].end - epsilon) {
        ctx.addIssue({
          code: "custom",
          message: "Captions must be ordered without overlaps",
          path: ["segments", index],
        });
      }
    });
  });

export const transcriptSchema = z
  .object({
    language: z.string().min(1).max(64),
    words: z.array(captionWordSchema).max(100000),
  })
  .superRefine((transcript, ctx) => {
    if (
      transcript.words.some(
        (word, index) => index > 0 && word.start < transcript.words[index - 1].start,
      )
    ) {
      ctx.addIssue({ code: "custom", message: "Transcript words must be ordered by start time" });
    }
  });

export type CaptionWord = z.infer<typeof captionWordSchema>;
export type CaptionSegment = z.infer<typeof captionSegmentSchema>;
export type CaptionStyle = z.infer<typeof captionStyleSchema>;
export type CaptionTrack = z.infer<typeof captionTrackSchema>;
export type Transcript = z.infer<typeof transcriptSchema>;

export const defaultCaptions: CaptionTrack = {
  enabled: true,
  style: {
    preset: "classic",
    fontFamily: "Arial",
    fontSize: 64,
    fontWeight: 700,
    color: "#ffffff",
    highlightColor: "#fbbf24",
    outlineColor: "#000000",
    outlineWidth: 2,
    shadow: true,
    background: "transparent",
    x: 50,
    y: 78,
    lineHeight: 1.2,
    maxWidth: 86,
    direction: "auto",
    animation: "none",
    highlighting: "none",
  },
  segments: [],
};

export const captionPresets: { id: CaptionStyle["preset"]; name: string; style: CaptionStyle }[] = [
  { id: "classic", name: "Classic", style: { ...defaultCaptions.style } },
  {
    id: "bold",
    name: "Bold",
    style: {
      ...defaultCaptions.style,
      preset: "bold",
      fontSize: 78,
      fontWeight: 900,
      outlineWidth: 4,
    },
  },
  {
    id: "karaoke",
    name: "Karaoke",
    style: {
      ...defaultCaptions.style,
      preset: "karaoke",
      highlighting: "karaoke",
      highlightColor: "#4ade80",
    },
  },
  {
    id: "highlight",
    name: "Word Highlight",
    style: {
      ...defaultCaptions.style,
      preset: "highlight",
      highlighting: "word",
      highlightColor: "#facc15",
      animation: "pop",
    },
  },
  {
    id: "minimal",
    name: "Minimal",
    style: {
      ...defaultCaptions.style,
      preset: "minimal",
      fontSize: 46,
      fontWeight: 400,
      outlineWidth: 0,
      shadow: false,
      background: "#00000099",
    },
  },
  {
    id: "podcast",
    name: "Podcast",
    style: {
      ...defaultCaptions.style,
      preset: "podcast",
      fontFamily: "Georgia",
      fontSize: 60,
      background: "#0f172acc",
      outlineWidth: 0,
      animation: "fade",
    },
  },
  {
    id: "impact",
    name: "Impact",
    style: {
      ...defaultCaptions.style,
      preset: "impact",
      fontFamily: "Impact",
      fontSize: 88,
      fontWeight: 900,
      color: "#fbbf24",
      outlineWidth: 5,
      animation: "pop",
    },
  },
  {
    id: "dynamic",
    name: "Dynamic",
    style: {
      ...defaultCaptions.style,
      preset: "dynamic",
      fontSize: 74,
      fontWeight: 900,
      highlighting: "word",
      highlightColor: "#38bdf8",
      animation: "pop",
    },
  },
  {
    id: "arabic",
    name: "Arabic Viral",
    style: {
      ...defaultCaptions.style,
      preset: "arabic",
      fontFamily: "Tahoma, Arial",
      fontSize: 70,
      direction: "rtl",
      lineHeight: 1.5,
      highlighting: "word",
      animation: "fade",
    },
  },
];

export interface SegmentationOptions {
  /** Absolute start of the selected clip on the master timeline. */
  timelineStart: number;
  /** Duration of the selected source range; provider words are relative to this range. */
  duration: number;
  maxWords?: number;
  maxCharacters?: number;
  maxDuration?: number;
  silenceGap?: number;
}

/** Preserve recognizer word timestamps while grouping at punctuation, pauses, and reading limits. */
export function segmentTranscript(
  transcript: Transcript,
  options: SegmentationOptions,
): CaptionSegment[] {
  const input = transcriptSchema.parse(transcript);
  const parsed = z
    .object({
      timelineStart: time,
      duration: z.number().finite().positive(),
      maxWords: z.number().int().min(1).max(100).default(6),
      maxCharacters: z.number().int().min(1).max(51200).default(42),
      maxDuration: z.number().finite().positive().default(3),
      silenceGap: z.number().finite().nonnegative().default(0.65),
    })
    .parse(options);
  const words = input.words.flatMap((word) => {
    const start = Math.min(parsed.duration, word.start);
    const end = Math.min(parsed.duration, word.end);
    return end > start
      ? [{ ...word, start: start + parsed.timelineStart, end: end + parsed.timelineStart }]
      : [];
  });
  const segments: CaptionSegment[] = [];
  let group: CaptionWord[] = [];
  const flush = () => {
    if (!group.length) return;
    segments.push({
      id: crypto.randomUUID(),
      start: group[0].start,
      end: Math.max(...group.map((word) => word.end)),
      words: group,
    });
    group = [];
  };
  for (const word of words) {
    const previous = group.at(-1);
    const groupEnd = group.length ? Math.max(...group.map((item) => item.end)) : 0;
    const boundary =
      previous &&
      (group.length >= parsed.maxWords ||
        group.map((item) => item.text).join(" ").length + word.text.length + 1 >
          parsed.maxCharacters ||
        word.end - group[0].start > parsed.maxDuration ||
        word.start - previous.end >= parsed.silenceGap ||
        /[.!?؟؛…]["'”’»)]*$/u.test(previous.text));
    // Overlapping provider words stay in the same segment so segment ranges never overlap.
    if (boundary && word.start >= groupEnd) flush();
    if (group.length === 100)
      throw new Error(
        "Too many overlapping words in one caption. Correct the transcript timestamps.",
      );
    group.push(word);
  }
  flush();
  return captionTrackSchema.parse({ ...defaultCaptions, segments }).segments;
}

export function activeCaption(captions: CaptionTrack, time: number): CaptionSegment | null {
  if (!captions.enabled) return null;
  return captions.segments.find((segment) => segment.start <= time && time < segment.end) ?? null;
}

/** First strong letter sets the paragraph direction; digits and punctuation do not. */
export function captionDirection(
  text: string,
  direction: CaptionStyle["direction"],
): "ltr" | "rtl" {
  if (direction !== "auto") return direction;
  for (const character of text) {
    if (!/\p{Letter}/u.test(character)) continue;
    return /[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(character) ? "rtl" : "ltr";
  }
  return "ltr";
}

export function captionWordIsHighlighted(
  word: CaptionWord,
  time: number,
  mode: CaptionStyle["highlighting"],
): boolean {
  return (
    word.emphasis ||
    (mode === "word"
      ? word.start <= time && time < word.end
      : mode === "karaoke" && word.start <= time)
  );
}

export function retimeCaptionSegment(
  segment: CaptionSegment,
  start: number,
  end: number,
): CaptionSegment {
  const scale = (end - start) / (segment.end - segment.start);
  return captionSegmentSchema.parse({
    ...segment,
    start,
    end,
    words: segment.words.map((word) => ({
      ...word,
      start: start + (word.start - segment.start) * scale,
      end: start + (word.end - segment.start) * scale,
    })),
  });
}

/** Split before a word, retaining every timestamp. A gap stays a gap between the captions. */
export function splitCaptionSegment(segment: CaptionSegment, wordIndex: number): CaptionSegment[] {
  if (!Number.isInteger(wordIndex) || wordIndex <= 0 || wordIndex >= segment.words.length)
    throw new Error("Choose a word after the first word to split the caption.");
  const first = segment.words.slice(0, wordIndex);
  const second = segment.words.slice(wordIndex);
  const firstEnd = Math.max(...first.map((word) => word.end));
  if (firstEnd > second[0].start)
    throw new Error("Adjust overlapping word times before splitting here.");
  return [
    { ...segment, end: firstEnd, words: first },
    { id: crypto.randomUUID(), start: second[0].start, end: segment.end, words: second },
  ];
}
