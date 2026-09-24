import { describe, expect, it } from "vitest";
import {
  activeCaption,
  captionDirection,
  captionPresets,
  captionTrackSchema,
  captionWordIsHighlighted,
  defaultCaptions,
  retimeCaptionSegment,
  segmentTranscript,
  splitCaptionSegment,
  type CaptionSegment,
  type CaptionWord,
} from "./captions";

const word = (text: string, start: number, end = start + 0.2): CaptionWord => ({
  text,
  start,
  end,
  emphasis: false,
});
const segment: CaptionSegment = {
  id: "c1",
  start: 1,
  end: 2,
  words: [word("Hello", 1, 1.3), word("world", 1.6, 2)],
};

describe("caption segmentation", () => {
  it("maps range-relative timestamps onto a trimmed clip, keeps pauses and clips out-of-range speech", () => {
    const result = segmentTranscript(
      {
        language: "en",
        words: [
          word("First.", 0.1, 0.4),
          word("Then", 0.5, 0.8),
          word("pause", 1.6, 1.9),
          word("finish", 2.1, 2.8),
          word("outside", 3, 3.3),
        ],
      },
      { timelineStart: 12, duration: 2.5 },
    );
    expect(result.map((item) => item.words.map((item) => item.text))).toEqual([
      ["First."],
      ["Then"],
      ["pause", "finish"],
    ]);
    expect(result.map(({ start, end }) => [start, end])).toEqual([
      [12.1, 12.4],
      [12.5, 12.8],
      [13.6, 14.5],
    ]);
    expect(captionTrackSchema.safeParse({ ...defaultCaptions, segments: result }).success).toBe(
      true,
    );
  });

  it("respects Arabic punctuation and reading limits without reversing words or numbers", () => {
    const result = segmentTranscript(
      {
        language: "ar",
        words: [word("لماذا؟", 0), word("الإصدار", 0.25), word("2.0", 0.5), word("ممتاز", 0.75)],
      },
      { timelineStart: 0, duration: 2, maxWords: 2 },
    );
    expect(result.map((item) => item.words.map((item) => item.text))).toEqual([
      ["لماذا؟"],
      ["الإصدار", "2.0"],
      ["ممتاز"],
    ]);
  });

  it("breaks by character and duration budgets while retaining each word's real timing", () => {
    const words = [word("one", 0), word("two", 0.3), word("three", 0.6), word("four", 0.9)];
    expect(
      segmentTranscript(
        { language: "en", words },
        { timelineStart: 0, duration: 2, maxCharacters: 7 },
      ).map((item) => item.words.length),
    ).toEqual([2, 1, 1]);
    expect(
      segmentTranscript(
        { language: "en", words },
        { timelineStart: 0, duration: 2, maxDuration: 0.6 },
      ).map((item) => item.words.length),
    ).toEqual([2, 2]);
  });

  it("keeps overlapping recognizer words together instead of producing overlapping captions", () => {
    const result = segmentTranscript(
      { language: "en", words: [word("Wait!", 0, 0.6), word("now", 0.4, 0.8), word("go", 1, 1.2)] },
      { timelineStart: 0, duration: 2, maxWords: 1 },
    );
    expect(result.map((item) => item.words.length)).toEqual([2, 1]);
    expect(captionTrackSchema.safeParse({ ...defaultCaptions, segments: result }).success).toBe(
      true,
    );
  });

  it("returns no captions for silence and rejects invalid or unsorted provider timing", () => {
    expect(
      segmentTranscript({ language: "en", words: [] }, { timelineStart: 0, duration: 1 }),
    ).toEqual([]);
    expect(() =>
      segmentTranscript(
        { language: "en", words: [word("second", 1), word("first", 0)] },
        { timelineStart: 0, duration: 2 },
      ),
    ).toThrow();
    expect(() =>
      segmentTranscript(
        { language: "en", words: [word("broken", 1, 1)] },
        { timelineStart: 0, duration: 2 },
      ),
    ).toThrow();
  });
});

describe("caption document and editing", () => {
  it("validates all nine presets, supplies emphasis, and rejects unsafe or incompatible styles", () => {
    expect(captionPresets).toHaveLength(9);
    for (const preset of captionPresets)
      expect(
        captionTrackSchema.safeParse({ ...defaultCaptions, style: preset.style }).success,
      ).toBe(true);
    const parsed = captionTrackSchema.parse({
      ...defaultCaptions,
      segments: [{ ...segment, words: [{ text: "  Hello  ", start: 1, end: 2 }] }],
    });
    expect(parsed.segments[0].words[0]).toEqual({
      text: "Hello",
      start: 1,
      end: 2,
      emphasis: false,
    });
    for (const style of [
      { fontSize: 0 },
      { color: "red" },
      { background: "url(file.png)" },
      { fontWeight: 600 },
    ]) {
      expect(
        captionTrackSchema.safeParse({
          ...defaultCaptions,
          style: { ...defaultCaptions.style, ...style },
        }).success,
      ).toBe(false);
    }
  });

  it("rejects duplicate IDs, segment overlap, out-of-bounds words and reversed word order", () => {
    expect(
      captionTrackSchema.safeParse({
        ...defaultCaptions,
        segments: [segment, { ...segment, start: 3, end: 4, words: [word("duplicate", 3)] }],
      }).success,
    ).toBe(false);
    expect(
      captionTrackSchema.safeParse({
        ...defaultCaptions,
        segments: [segment, { ...segment, id: "c2" }],
      }).success,
    ).toBe(false);
    expect(
      captionTrackSchema.safeParse({
        ...defaultCaptions,
        segments: [{ ...segment, words: [word("outside", 0)] }],
      }).success,
    ).toBe(false);
    expect(
      captionTrackSchema.safeParse({
        ...defaultCaptions,
        segments: [{ ...segment, words: [...segment.words].reverse() }],
      }).success,
    ).toBe(false);
  });

  it("retimes proportionally and splits without moving words or filling a silence gap", () => {
    expect(retimeCaptionSegment(segment, 10, 12).words).toEqual([
      word("Hello", 10, 10.6),
      word("world", 11.2, 12),
    ]);
    const split = splitCaptionSegment(segment, 1);
    expect(split.map(({ start, end }) => [start, end])).toEqual([
      [1, 1.3],
      [1.6, 2],
    ]);
    expect(split.flatMap((item) => item.words)).toEqual(segment.words);
    expect(() => splitCaptionSegment(segment, 0)).toThrow();
    expect(() => retimeCaptionSegment(segment, 2, 1)).toThrow();
  });
});

describe("caption playback and direction", () => {
  it("uses half-open segment and highlight ranges, retaining emphasis through pauses", () => {
    const captions = { ...defaultCaptions, segments: [segment] };
    expect(activeCaption(captions, 1)).toBe(segment);
    expect(activeCaption(captions, 2)).toBeNull();
    expect(activeCaption({ ...captions, enabled: false }, 1)).toBeNull();
    expect(captionWordIsHighlighted(segment.words[0], 1, "word")).toBe(true);
    expect(captionWordIsHighlighted(segment.words[0], 1.3, "word")).toBe(false);
    expect(captionWordIsHighlighted(segment.words[0], 1.8, "karaoke")).toBe(true);
    expect(captionWordIsHighlighted({ ...segment.words[1], emphasis: true }, 1.4, "none")).toBe(
      true,
    );
  });

  it("finds first strong letters around numbers and honors explicit direction", () => {
    expect(captionDirection("2026 — مرحباً OpenAI!", "auto")).toBe("rtl");
    expect(captionDirection("2026 — OpenAI مرحباً!", "auto")).toBe("ltr");
    expect(captionDirection("Version 2 مرحباً", "rtl")).toBe("rtl");
    expect(captionDirection("العربية 2026", "ltr")).toBe("ltr");
    expect(captionDirection("123 !", "auto")).toBe("ltr");
  });
});
