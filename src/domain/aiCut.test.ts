import { describe, expect, it } from "vitest";

import {
  aiCutOptionsSchema,
  analyzeTranscript,
  candidateClipSchema,
  DEFAULT_AI_CUT_OPTIONS,
  scoreKeys,
  type AiCutOptions,
  type CandidateClip,
  type ScoreKey,
} from "./aiCut";
import type { CaptionWord, Transcript } from "./captions";

function word(text: string, start: number, end: number): CaptionWord {
  return { text, start, end, emphasis: false };
}

function transcript(texts: string[], start = 0, step = 1, length = 0.8): Transcript {
  return {
    language: "en",
    words: texts.map((text, index) =>
      word(text, start + index * step, start + index * step + length),
    ),
  };
}

function options(overrides: Partial<AiCutOptions> = {}): AiCutOptions {
  return {
    ...DEFAULT_AI_CUT_OPTIONS,
    minDuration: 3,
    maxDuration: 8,
    weights: { ...DEFAULT_AI_CUT_OPTIONS.weights },
    ...overrides,
  };
}

function onlyWeight(key: ScoreKey): AiCutOptions["weights"] {
  return Object.fromEntries(
    scoreKeys.map((item) => [item, item === key ? 1 : 0]),
  ) as AiCutOptions["weights"];
}

function expectValidCandidates(candidates: CandidateClip[], settings: AiCutOptions): void {
  expect(candidates.length).toBeLessThanOrEqual(settings.maxCandidates);
  candidates.forEach((candidate, index) => {
    expect(candidateClipSchema.safeParse(candidate).success).toBe(true);
    expect(candidate.end - candidate.start).toBeGreaterThanOrEqual(settings.minDuration);
    expect(candidate.end - candidate.start).toBeLessThanOrEqual(settings.maxDuration);
    if (index) expect(candidate.score).toBeLessThanOrEqual(candidates[index - 1].score);
    for (const other of candidates.slice(index + 1)) {
      expect(candidate.start < other.end && other.start < candidate.end).toBe(false);
    }
  });
  expect(new Set(candidates.map((candidate) => candidate.id)).size).toBe(candidates.length);
}

describe("AI Cut options and candidates", () => {
  it("has useful, valid defaults and six editable scoring weights", () => {
    expect(aiCutOptionsSchema.parse(DEFAULT_AI_CUT_OPTIONS)).toEqual(DEFAULT_AI_CUT_OPTIONS);
    expect(DEFAULT_AI_CUT_OPTIONS.minDuration).toBe(15);
    expect(DEFAULT_AI_CUT_OPTIONS.maxDuration).toBe(60);
    expect(DEFAULT_AI_CUT_OPTIONS.maxCandidates).toBe(12);
    expect(scoreKeys).toEqual([
      "hook",
      "clarity",
      "emotion",
      "shareability",
      "completeness",
      "pacing",
    ]);
    expect(scoreKeys.every((key) => DEFAULT_AI_CUT_OPTIONS.weights[key] > 0)).toBe(true);
  });

  it.each([
    { minDuration: 0 },
    { maxDuration: Infinity },
    { minDuration: 10, maxDuration: 9 },
    { maxDuration: 301 },
    { maxCandidates: 0 },
    { maxCandidates: 51 },
    { maxCandidates: 1.5 },
    { weights: { ...DEFAULT_AI_CUT_OPTIONS.weights, hook: NaN } },
    { weights: { ...DEFAULT_AI_CUT_OPTIONS.weights, clarity: -1 } },
    { weights: { hook: 0, clarity: 0, emotion: 0, shareability: 0, completeness: 0, pacing: 0 } },
  ])("rejects invalid options: %j", (overrides) => {
    expect(aiCutOptionsSchema.safeParse(options(overrides)).success).toBe(false);
  });

  it("validates saved candidate ranges, scores and explanations", () => {
    const [candidate] = analyzeTranscript(
      transcript(["Why", "try", "these", "steps?"]),
      0,
      4,
      options(),
    );
    expect(candidateClipSchema.safeParse(candidate).success).toBe(true);
    expect(candidateClipSchema.safeParse({ ...candidate, end: candidate.start }).success).toBe(
      false,
    );
    expect(candidateClipSchema.safeParse({ ...candidate, score: 101 }).success).toBe(false);
    expect(
      candidateClipSchema.safeParse({ ...candidate, scores: { ...candidate.scores, hook: -1 } })
        .success,
    ).toBe(false);
    expect(candidateClipSchema.safeParse({ ...candidate, reasons: [] }).success).toBe(false);
  });
});

describe("local transcript candidate analysis", () => {
  it("returns no candidates for empty or short speech without padding silence", () => {
    expect(analyzeTranscript(transcript([]), 100, 200, options())).toEqual([]);
    expect(analyzeTranscript(transcript(["Brief", "sentence."]), 0, 100, options())).toEqual([]);
  });

  it.each([
    [-1, 5],
    [0, 0],
    [5, 4],
    [NaN, 5],
    [0, Infinity],
  ])("validates the extraction range even with empty speech (%s, %s)", (start, end) => {
    expect(() => analyzeTranscript(transcript([]), start, end, options())).toThrow();
  });

  it("returns absolute media timestamps and retains exact speech endpoints and text", () => {
    const input = transcript(["Why", "does", "this", "work?"], 2);
    const settings = options({ minDuration: 3, maxDuration: 4 });
    const candidates = analyzeTranscript(input, 120, 140, settings);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ start: 122, end: 125.8, text: "Why does this work?" });
    expectValidCandidates(candidates, settings);
  });

  it("rejects out-of-range words instead of silently clipping them", () => {
    const input = transcript(["A", "few", "valid", "words."]);
    input.words.push(word("outside", 10, 11));
    expect(() => analyzeTranscript(input, 100, 110, options())).toThrow(
      /inside the extracted source range/,
    );
  });

  it("retains exact duration clips when extraction offsets introduce floating-point rounding", () => {
    const input = transcript(
      Array.from({ length: 15 }, () => "word"),
      0,
      1,
      1,
    );
    const [candidate] = analyzeTranscript(
      input,
      123.45,
      138.45,
      options({ minDuration: 15, maxDuration: 15 }),
    );
    expect(candidate).toMatchObject({ start: 123.45, end: 138.45 });
    expect(candidate.end - candidate.start).toBeCloseTo(15, 10);
  });

  it.each([
    [word("second", 2, 3), word("first", 1, 2)],
    [word("negative", -1, 2)],
    [word("reversed", 2, 1)],
    [word("zero", 1, 1)],
    [word("infinite", 1, Infinity)],
    [word("   ", 1, 2)],
  ])("rejects malformed transcript words: %j", (...words) => {
    expect(() => analyzeTranscript({ language: "en", words }, 0, 10, options())).toThrow();
  });

  it("does not join separate short fragments across long silent gaps", () => {
    const input: Transcript = {
      language: "en",
      words: [word("First.", 0, 1), word("Second.", 10, 11), word("Third.", 20, 21)],
    };
    expect(analyzeTranscript(input, 0, 30, options({ minDuration: 3, maxDuration: 30 }))).toEqual(
      [],
    );
  });

  it("keeps clips on either side of a long pause separate", () => {
    const input: Transcript = {
      language: "en",
      words: [
        ...transcript(["One", "useful", "complete", "sentence."]).words,
        ...transcript(["Another", "clear", "complete", "sentence."], 10).words,
      ],
    };
    const settings = options({ minDuration: 3, maxDuration: 20 });
    const candidates = analyzeTranscript(input, 0, 20, settings);
    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.end <= 3.8 || candidate.start >= 10)).toBe(
      true,
    );
    expectValidCandidates(candidates, settings);
  });

  it("recognizes Arabic question punctuation and sentence boundaries", () => {
    const input = transcript(["لماذا", "نحتاج", "هذه", "الخطوة؟", "لأن", "هذه", "طريقة", "جديدة."]);
    input.language = "ar";
    const settings = options({ minDuration: 3, maxDuration: 4 });
    const candidates = analyzeTranscript(input, 0, 8, settings);
    expect(candidates).toHaveLength(2);
    const question = candidates.find((candidate) => candidate.start === 0)!;
    expect(question.text).toBe("لماذا نحتاج هذه الخطوة؟");
    expect(question.scores.hook).toBe(42);
    expect(question.reasons.some((reason) => reason.includes("ends at sentence punctuation"))).toBe(
      true,
    );
    expect(candidates.find((candidate) => candidate.start === 4)?.scores.completeness).toBe(100);
    expectValidCandidates(candidates, settings);
  });

  it("normalizes Arabic diacritics when counting explicit cue words", () => {
    const input = transcript(["كَيْفَ", "أَتَعَلَّمُ", "هَذِهِ", "الخُطْوَة؟"]);
    const [candidate] = analyzeTranscript(input, 0, 4, options());
    expect(candidate.scores.hook).toBe(42);
    expect(candidate.reasons[0]).toContain("1 question cues");
  });

  it("uses ordinary pauses as reviewable boundaries", () => {
    const input: Transcript = {
      language: "en",
      words: [
        word("one", 0, 1),
        word("two", 1, 2.5),
        word("three", 3.5, 4.5),
        word("four", 4.5, 6),
      ],
    };
    const candidates = analyzeTranscript(
      input,
      0,
      6,
      options({ minDuration: 2.5, maxDuration: 3 }),
    );
    expect(candidates).toHaveLength(2);
    expect(
      candidates.some((candidate) =>
        candidate.reasons.some((reason) => reason.includes("ends at pause")),
      ),
    ).toBe(true);
    expect(
      candidates.some((candidate) =>
        candidate.reasons.some((reason) => reason.includes("starts at pause")),
      ),
    ).toBe(true);
  });

  it("preserves overlapping word groups and never cuts inside them", () => {
    const input: Transcript = {
      language: "en",
      words: [
        word("long", 0, 1.8),
        word("overlap", 0.5, 1),
        word("then", 1.8, 3),
        word("finish.", 3, 4),
      ],
    };
    const [candidate] = analyzeTranscript(input, 0, 4, options({ minDuration: 4, maxDuration: 4 }));
    expect(candidate).toMatchObject({ start: 0, end: 4, text: "long overlap then finish." });
    expect(candidate.reasons.some((reason) => reason.includes("100% speech coverage"))).toBe(true);
    expect(analyzeTranscript(input, 0, 4, options({ minDuration: 0.8, maxDuration: 1 }))).toEqual([
      expect.objectContaining({ start: 3, end: 4, text: "finish." }),
    ]);
  });

  it("returns duration-bounded, nonoverlapping ranked clips from unpunctuated speech", () => {
    const input = transcript(
      Array.from({ length: 120 }, (_, index) => `word${index}`),
      0,
      0.5,
      0.5,
    );
    const settings = options({ minDuration: 5, maxDuration: 10, maxCandidates: 4 });
    const candidates = analyzeTranscript(input, 25, 85, settings);
    expect(candidates).toHaveLength(4);
    expectValidCandidates(candidates, settings);
    expect(candidates.every((candidate) => candidate.start >= 25 && candidate.end <= 85)).toBe(
      true,
    );
  });

  it("uses adjustable weights to rank observed signals without changing their scores", () => {
    const input: Transcript = {
      language: "en",
      words: [
        ...transcript(
          ["Why?", "How?", "What?", "Does", "this", "make", "a", "useful", "clear", "question?"],
          0,
          0.5,
          0.5,
        ).words,
        ...transcript(
          [
            "Love",
            "happy",
            "excited",
            "amazing!",
            "Hope",
            "love",
            "happy",
            "excited",
            "amazing!",
            "Hope.",
          ],
          20,
          0.5,
          0.5,
        ).words,
      ],
    };
    const base = { minDuration: 5, maxDuration: 5, maxCandidates: 2 };
    const hook = analyzeTranscript(input, 0, 30, options({ ...base, weights: onlyWeight("hook") }));
    const emotion = analyzeTranscript(
      input,
      0,
      30,
      options({ ...base, weights: onlyWeight("emotion") }),
    );
    expect(hook).toHaveLength(2);
    expect(emotion).toHaveLength(2);
    expect(hook[0].start).toBe(0);
    expect(emotion[0].start).toBe(20);
    expect(hook[0].score).toBe(hook[0].scores.hook);
    expect(emotion[0].score).toBe(emotion[0].scores.emotion);
    expect(hook[0].id).toBe(emotion[1].id);
    expect(hook[0].scores).toEqual(emotion[1].scores);
  });

  it("is deterministic, does not mutate input, and states the local rules' limits", () => {
    const input = transcript([
      "Why",
      "try",
      "these",
      "steps?",
      "They",
      "provide",
      "an",
      "example.",
    ]);
    const settings = options();
    const original = structuredClone({ input, settings });
    const first = analyzeTranscript(input, 0, 8, settings);
    expect(analyzeTranscript(input, 0, 8, settings)).toEqual(first);
    expect({ input, settings }).toEqual(original);
    expect(first[0].reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("audience response is not predicted"),
        expect.stringContaining("tone is not inferred"),
        expect.stringContaining("require human review"),
      ]),
    );
  });

  it("bounds candidate search across 100,000 words and validates even the final word", () => {
    const input = transcript(
      Array.from({ length: 100_000 }, (_, index) => (index % 20 === 19 ? "word." : "word")),
      0,
      0.5,
      0.5,
    );
    const settings = options({ minDuration: 10, maxDuration: 30, maxCandidates: 12 });
    const candidates = analyzeTranscript(input, 0, 50_000, settings);
    expect(candidates).toHaveLength(12);
    expect(
      candidates.every((candidate) =>
        candidate.reasons.some((reason) => reason.includes("Search sampled")),
      ),
    ).toBe(true);
    expectValidCandidates(candidates, settings);
    input.words[input.words.length - 1].end = 50_001;
    expect(() => analyzeTranscript(input, 0, 50_000, settings)).toThrow(
      /inside the extracted source range/,
    );
  });
});
