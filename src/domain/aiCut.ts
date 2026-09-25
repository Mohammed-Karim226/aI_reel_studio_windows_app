import { z } from "zod";

import { transcriptSchema, type Transcript } from "./captions";

export const scoreKeys = [
  "hook",
  "clarity",
  "emotion",
  "shareability",
  "completeness",
  "pacing",
] as const;
export type ScoreKey = (typeof scoreKeys)[number];

const weight = z.number().finite().min(0).max(100);
const weightsSchema = z.object({
  hook: weight,
  clarity: weight,
  emotion: weight,
  shareability: weight,
  completeness: weight,
  pacing: weight,
});

export const aiCutOptionsSchema = z
  .object({
    minDuration: z.number().finite().positive().max(300),
    maxDuration: z.number().finite().positive().max(300),
    maxCandidates: z.number().int().min(1).max(50),
    weights: weightsSchema,
  })
  .superRefine((options, ctx) => {
    if (options.maxDuration < options.minDuration) {
      ctx.addIssue({
        code: "custom",
        path: ["maxDuration"],
        message: "Maximum duration must be at least the minimum duration",
      });
    }
    if (!scoreKeys.some((key) => options.weights[key] > 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["weights"],
        message: "At least one score weight must be greater than zero",
      });
    }
  });

export type AiCutOptions = z.infer<typeof aiCutOptionsSchema>;

export const DEFAULT_AI_CUT_OPTIONS: AiCutOptions = {
  minDuration: 15,
  maxDuration: 60,
  maxCandidates: 12,
  weights: { hook: 2, clarity: 1.5, emotion: 1, shareability: 1, completeness: 2, pacing: 1.5 },
};

const score = z.number().finite().min(0).max(100);
export const candidateClipSchema = z
  .object({
    id: z.string().min(1).max(128),
    start: z.number().finite().nonnegative(),
    end: z.number().finite().nonnegative(),
    // The transcript schema permits 100,000 words of up to 512 characters each.
    text: z.string().trim().min(1).max(51_300_000),
    score,
    scores: z.object({
      hook: score,
      clarity: score,
      emotion: score,
      shareability: score,
      completeness: score,
      pacing: score,
    }),
    reasons: z.array(z.string().min(1).max(512)).min(1).max(12),
  })
  .superRefine((candidate, ctx) => {
    if (candidate.end <= candidate.start) {
      ctx.addIssue({ code: "custom", message: "Candidate end must be after its start" });
    }
  });

export type CandidateClip = z.infer<typeof candidateClipSchema>;

const MAX_STARTS = 2048;
const PAUSE_BOUNDARY = 0.65;
const HARD_GAP = 2;
// Compare media timestamps with sub-microsecond tolerance, without padding clips.
const TIME_EPSILON = 0.0000001;
const sentenceEnd = /[.!?\u061f\u061b\u06d4\u2026]["'\u201d\u2019\u00bb)\]]*$/u;
const questionWords = new Set([
  "what",
  "why",
  "how",
  "when",
  "where",
  "who",
  "which",
  "هل",
  "لماذا",
  "كيف",
  "متى",
  "اين",
  "ماذا",
  "ليه",
  "ازاي",
]);
const fillerWords = new Set(["um", "uh", "erm", "hmm", "اه", "امم", "يعني"]);
const emotionalWords = new Set([
  "love",
  "hate",
  "excited",
  "afraid",
  "happy",
  "sad",
  "fear",
  "hope",
  "angry",
  "shocking",
  "surprising",
  "amazing",
  "خوف",
  "سعادة",
  "حزين",
  "سعيد",
  "غاضب",
  "مذهل",
  "حب",
  "اكره",
  "احب",
  "صدمة",
]);
const practicalWords = new Set([
  "tip",
  "tips",
  "step",
  "steps",
  "learn",
  "guide",
  "example",
  "طريقة",
  "خطوة",
  "خطوات",
  "نصيحة",
  "نصائح",
  "تعلم",
  "مثال",
]);
const signalKeys = [
  "filler",
  "emotional",
  "practical",
  "question",
  "questionCue",
  "exclamation",
] as const;
type Signal = (typeof signalKeys)[number];
type Boundary = "transcript edge" | "sentence punctuation" | "pause" | "word boundary";

interface WordGroup {
  first: number;
  after: number;
  start: number;
  end: number;
  punctuated: boolean;
}

interface RankedWindow {
  first: number;
  last: number;
  start: number;
  end: number;
  score: number;
  scores: Record<ScoreKey, number>;
  reasons: string[];
}

function normalizeWord(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670\u0640]/gu, "")
    .replace(/[\u0622\u0623\u0625\u0671]/gu, "ا")
    .replace(/^[^\p{Letter}\p{Number}]+|[^\p{Letter}\p{Number}]+$/gu, "");
}

/** First index whose value is at least target; all searched arrays are increasing. */
function lowerBound(values: ArrayLike<number>, target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function sampleEvenly(indices: number[], limit: number): number[] {
  if (indices.length <= limit) return indices;
  return Array.from(
    { length: limit },
    (_, index) => indices[Math.floor((index * (indices.length - 1)) / (limit - 1))],
  );
}

function boundedScore(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}

/**
 * Transparent local ranking, not an LLM or a prediction of meaning/virality.
 *
 * Validate every word, then group overlapping words so no cut bisects speech.
 * Prefix counts and binary searches score at most 3 windows at each of 2,048
 * starts, evenly sampling both natural boundaries and all word groups. A gap of
 * two seconds separates runs; clip ranges always use actual speech endpoints.
 * Work is O(words + bounded windows * log(words)), plus bounded sorting/selection.
 * Text is joined only for the selected, nonoverlapping results, not every window.
 */
export function analyzeTranscript(
  transcript: Transcript,
  sourceStart: number,
  sourceEnd: number,
  options: AiCutOptions,
): CandidateClip[] {
  const input = transcriptSchema.parse(transcript);
  const settings = aiCutOptionsSchema.parse(options);
  const range = z
    .object({
      start: z.number().finite().nonnegative(),
      end: z.number().finite().nonnegative(),
    })
    .refine((value) => value.end > value.start, "Source end must be after its start")
    .parse({ start: sourceStart, end: sourceEnd });
  const duration = range.end - range.start;
  const words = input.words;
  if (words.some((word) => word.end > duration + TIME_EPSILON)) {
    throw new Error("Transcript word timestamps must stay inside the extracted source range.");
  }
  if (!words.length || duration + TIME_EPSILON < settings.minDuration) return [];

  const prefix = Object.fromEntries(
    signalKeys.map((key) => [key, new Uint32Array(words.length + 1)]),
  ) as Record<Signal, Uint32Array>;
  const groups: WordGroup[] = [];
  words.forEach((word, index) => {
    const normalized = normalizeWord(word.text);
    const signals: Record<Signal, boolean> = {
      filler: fillerWords.has(normalized),
      emotional: emotionalWords.has(normalized),
      practical: practicalWords.has(normalized),
      question: /[?\u061f]/u.test(word.text),
      questionCue: questionWords.has(normalized),
      exclamation: /!/u.test(word.text),
    };
    for (const key of signalKeys)
      prefix[key][index + 1] = prefix[key][index] + Number(signals[key]);
    const previous = groups.at(-1);
    if (previous && word.start < previous.end) {
      previous.after = index + 1;
      previous.end = Math.max(previous.end, word.end);
      previous.punctuated = sentenceEnd.test(word.text);
    } else {
      groups.push({
        first: index,
        after: index + 1,
        start: word.start,
        end: word.end,
        punctuated: sentenceEnd.test(word.text),
      });
    }
  });

  const startBoundary = (index: number): Boundary => {
    if (!index) return "transcript edge";
    if (groups[index - 1].punctuated) return "sentence punctuation";
    if (groups[index].start - groups[index - 1].end >= PAUSE_BOUNDARY) return "pause";
    return "word boundary";
  };
  const endBoundary = (index: number): Boundary => {
    if (groups[index].punctuated) return "sentence punctuation";
    if (index === groups.length - 1) return "transcript edge";
    if (groups[index + 1].start - groups[index].end >= PAUSE_BOUNDARY) return "pause";
    return "word boundary";
  };
  const ends = groups.map((group) => group.end);
  const naturalStarts: number[] = [];
  const naturalEnds: number[] = [];
  const spoken = new Float64Array(groups.length + 1);
  const runEnds = new Uint32Array(groups.length);
  let runEnd = groups.length - 1;
  for (let index = groups.length - 1; index >= 0; index--) {
    if (index < groups.length - 1 && groups[index + 1].start - groups[index].end >= HARD_GAP) {
      runEnd = index;
    }
    runEnds[index] = runEnd;
  }
  groups.forEach((group, index) => {
    if (startBoundary(index) !== "word boundary") naturalStarts.push(index);
    if (endBoundary(index) !== "word boundary") naturalEnds.push(index);
    spoken[index + 1] = spoken[index] + group.end - group.start;
  });
  const allStarts = groups.map((_, index) => index);
  const starts =
    groups.length <= MAX_STARTS
      ? allStarts
      : [
          ...new Set([
            ...sampleEvenly(naturalStarts, MAX_STARTS / 2),
            ...sampleEvenly(allStarts, MAX_STARTS / 2),
          ]),
        ].sort((left, right) => left - right);
  const windows: RankedWindow[] = [];
  const weightTotal = scoreKeys.reduce((total, key) => total + settings.weights[key], 0);
  const boundaryPoints = (boundary: Boundary) =>
    boundary === "word boundary" ? 5 : boundary === "transcript edge" ? 30 : 50;

  for (const first of starts) {
    const firstGroup = groups[first];
    const minimum = Math.max(
      first,
      lowerBound(ends, firstGroup.start + settings.minDuration - TIME_EPSILON),
    );
    const latestEnd = firstGroup.start + settings.maxDuration + TIME_EPSILON;
    let maximum = lowerBound(ends, latestEnd);
    if (maximum === groups.length || ends[maximum] > latestEnd) {
      maximum--;
    }
    maximum = Math.min(maximum, runEnds[first]);
    if (minimum > maximum) continue;

    const naturalMinimum = lowerBound(naturalEnds, minimum);
    const naturalMaximum = lowerBound(naturalEnds, maximum + 1) - 1;
    const selectedEnds = new Set<number>();
    for (const target of [
      settings.minDuration,
      (settings.minDuration + settings.maxDuration) / 2,
      settings.maxDuration,
    ]) {
      const near = Math.max(
        minimum,
        Math.min(maximum, lowerBound(ends, firstGroup.start + target)),
      );
      if (naturalMinimum <= naturalMaximum) {
        const next = Math.max(
          naturalMinimum,
          Math.min(naturalMaximum, lowerBound(naturalEnds, near)),
        );
        const before = Math.max(naturalMinimum, next - 1);
        const distance = (position: number) =>
          Math.abs(ends[naturalEnds[position]] - firstGroup.start - target);
        selectedEnds.add(naturalEnds[distance(before) <= distance(next) ? before : next]);
      } else selectedEnds.add(near);
    }

    for (const last of selectedEnds) {
      const lastGroup = groups[last];
      const clipDuration = lastGroup.end - firstGroup.start;
      const start = range.start + firstGroup.start;
      const end = Math.min(range.end, range.start + lastGroup.end);
      if (
        clipDuration + TIME_EPSILON < settings.minDuration ||
        clipDuration - TIME_EPSILON > settings.maxDuration ||
        end <= start ||
        end - start + TIME_EPSILON < settings.minDuration ||
        end - start - TIME_EPSILON > settings.maxDuration
      )
        continue;
      const count = lastGroup.after - firstGroup.first;
      const openingAfter = Math.min(lastGroup.after, firstGroup.first + 8);
      const signalCount = (key: Signal, after = lastGroup.after) =>
        prefix[key][after] - prefix[key][firstGroup.first];
      const openingQuestions = signalCount("question", openingAfter);
      const openingCues = signalCount("questionCue", openingAfter);
      const openingExclamations = signalCount("exclamation", openingAfter);
      const fillers = signalCount("filler");
      const emotions = signalCount("emotional");
      const practical = signalCount("practical");
      const questions = signalCount("question");
      const exclamations = signalCount("exclamation");
      const wordsPerMinute = (count / clipDuration) * 60;
      const coverage = Math.min(1, (spoken[last + 1] - spoken[first]) / clipDuration);
      const beginning = startBoundary(first);
      const ending = endBoundary(last);
      const scores: Record<ScoreKey, number> = {
        hook: boundedScore(openingQuestions * 24 + openingCues * 18 + openingExclamations * 10),
        clarity: boundedScore(
          100 - (fillers / count) * 240 - Math.max(0, wordsPerMinute - 210) * 0.25,
        ),
        emotion: boundedScore(((emotions * 2 + exclamations) / Math.max(5, count)) * 200),
        shareability: boundedScore(((practical * 3 + questions) / Math.max(8, count)) * 100),
        completeness: boundaryPoints(beginning) + boundaryPoints(ending),
        pacing: boundedScore(100 - Math.abs(wordsPerMinute - 150) * 0.45 - (1 - coverage) * 50),
      };
      const reasons = [
        `Hook proxy: ${openingCues} question cues, ${openingQuestions} question-marked words and ${openingExclamations} exclamation-marked words in the first ${openingAfter - firstGroup.first} words.`,
        `Clarity proxy: ${fillers} filler-marked words out of ${count}; wording is not checked for meaning.`,
        `Emotion proxy: ${emotions} words from a small English/Arabic cue list and ${exclamations} exclamation-marked words; tone is not inferred.`,
        `Shareability proxy: ${practical} practical cue words and ${questions} question-marked words; audience response is not predicted.`,
        `Boundary proxy: starts at ${beginning}; ends at ${ending}. Transcript edges may omit surrounding context.`,
        `Timing proxy: ${Math.round(wordsPerMinute)} timed words/minute and ${Math.round(coverage * 100)}% speech coverage.`,
        "Local rule scores are review aids. Accuracy, context and emotional meaning require human review.",
      ];
      if (groups.length > MAX_STARTS) {
        reasons.push(
          `Search sampled ${starts.length} starts across this transcript; some possible windows were not scored.`,
        );
      }
      windows.push({
        first,
        last,
        start,
        end,
        scores,
        reasons,
        score: boundedScore(
          scoreKeys.reduce((total, key) => total + scores[key] * settings.weights[key], 0) /
            weightTotal,
        ),
      });
    }
  }

  windows.sort(
    (left, right) =>
      right.score - left.score ||
      right.scores.completeness - left.scores.completeness ||
      left.start - right.start ||
      left.end - right.end,
  );
  const selected: RankedWindow[] = [];
  for (const window of windows) {
    if (selected.some((item) => window.start < item.end && item.start < window.end)) continue;
    selected.push(window);
    if (selected.length === settings.maxCandidates) break;
  }
  return selected.map((window) => {
    const first = groups[window.first].first;
    const after = groups[window.last].after;
    return candidateClipSchema.parse({
      id: `ai-cut-${window.start}-${window.end}-${first}-${after}`,
      start: window.start,
      end: window.end,
      text: words
        .slice(first, after)
        .map((word) => word.text)
        .join(" "),
      score: window.score,
      scores: window.scores,
      reasons: window.reasons,
    });
  });
}
