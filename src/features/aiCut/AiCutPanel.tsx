import { useState } from "react";
import {
  aiCutOptionsSchema,
  DEFAULT_AI_CUT_OPTIONS,
  scoreKeys,
  type AiCutOptions,
  type CandidateClip,
} from "@/domain/aiCut";
import { TranscriptionSetupPanel } from "@/features/captions/TranscriptionSetupPanel";
import { Button } from "@/shared/ui/Button";
import { formatDuration } from "@/shared/format";
import { useAiCutStore } from "@/stores/aiCutStore";
import { selectedAsset, useMediaStore } from "@/stores/mediaStore";
import { useSourcePreviewStore } from "@/stores/sourcePreviewStore";
import { useTimelineStore } from "@/stores/timelineStore";
import { useTranscriptionStore } from "@/stores/transcriptionStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

const inputClass = "mt-1 w-full min-w-0 rounded bg-slate-800 p-1.5 text-slate-200";
const scoreLabels = {
  hook: "Opening cues",
  clarity: "Clarity cues",
  emotion: "Emotion words",
  shareability: "Useful content cues",
  completeness: "Sentence boundaries",
  pacing: "Speech pacing",
};

export function AiCutPanel() {
  const asset = useMediaStore(selectedAsset);
  const assets = useMediaStore((state) => state.assets);
  const eligible = assets.filter((item) => item.kind === "video" && item.hasAudio && item.hasVideo);
  const state = useAiCutStore();
  const blocked = useWorkspaceStore((workspace) => workspace.closing || workspace.busy);
  const timelineLoading = useTimelineStore((timeline) => timeline.loading || !timeline.timeline);
  const ready = useTranscriptionStore(
    (speech) => speech.readiness?.ready === true && !speech.loading && !speech.checking,
  );
  const [options, setOptions] = useState<AiCutOptions>(() =>
    structuredClone(DEFAULT_AI_CUT_OPTIONS),
  );
  const [showSetup, setShowSetup] = useState(false);
  const [range, setRange] = useState<{ mediaId: string; start: number; end: number } | null>(null);
  const usable = asset && eligible.some((item) => item.id === asset.id) ? asset : null;
  const start = range?.mediaId === usable?.id ? (range?.start ?? 0) : 0;
  const end =
    range?.mediaId === usable?.id ? (range?.end ?? 0) : Math.min(usable?.durationSec ?? 0, 3600);
  const validOptions = aiCutOptionsSchema.safeParse(options).success;
  const validRange =
    !!usable &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    end > start &&
    end <= usable.durationSec &&
    end - start <= 3600;
  const busy = blocked || timelineLoading || state.generating;
  const draft = state.draft;
  const draftAsset = assets.find((item) => item.id === draft?.mediaId);

  return (
    <section className="space-y-3 p-3 text-xs" aria-label="AI Cut">
      <div>
        <h2 className="font-semibold text-slate-200">Find your next Reel</h2>
        <p className="mt-1 leading-5 text-slate-400">
          Transcribe a video, review suggested moments, then add your picks to the timeline.
        </p>
      </div>
      <label className="block text-slate-400">
        Video to analyze
        <select
          aria-label="AI Cut source"
          className={inputClass}
          value={usable?.id ?? ""}
          disabled={busy}
          onChange={(event) => useMediaStore.getState().select(event.target.value)}
        >
          <option value="" disabled>
            Choose a video with speech
          </option>
          {eligible.map((item) => (
            <option key={item.id} value={item.id}>
              {item.fileName}
            </option>
          ))}
        </select>
      </label>
      {!eligible.length && (
        <p className="text-slate-400">Import a video with an audio track in Media first.</p>
      )}
      <fieldset
        disabled={busy || !usable}
        className="grid min-w-0 grid-cols-2 gap-2 text-slate-400"
      >
        <NumberField
          label="Analyze from (s)"
          value={start}
          min={0}
          max={usable?.durationSec ?? 0}
          onChange={(value) => usable && setRange({ mediaId: usable.id, start: value, end })}
        />
        <NumberField
          label="Analyze to (s)"
          value={end}
          min={0}
          max={usable?.durationSec ?? 0}
          onChange={(value) => usable && setRange({ mediaId: usable.id, start, end: value })}
        />
      </fieldset>
      <p className="text-[11px] text-slate-500">
        Analyze up to one hour at a time. Times refer to the original video.
      </p>
      {usable && !validRange && (
        <p role="alert" className="text-amber-300">
          Choose a valid source range of one hour or less.
        </p>
      )}
      <fieldset disabled={busy} className="grid min-w-0 grid-cols-2 gap-2 text-slate-400">
        <NumberField
          label="Minimum clip (s)"
          value={options.minDuration}
          min={1}
          max={300}
          onChange={(value) => setOptions({ ...options, minDuration: value })}
        />
        <NumberField
          label="Maximum clip (s)"
          value={options.maxDuration}
          min={1}
          max={300}
          onChange={(value) => setOptions({ ...options, maxDuration: value })}
        />
      </fieldset>
      <details className="rounded border border-slate-800 p-2 text-slate-400">
        <summary className="cursor-pointer">Ranking preferences</summary>
        <p className="my-2 text-[11px]">
          Local rules use words, punctuation, and pauses. Scores are review hints, not predictions
          of reach or quality.
        </p>
        <fieldset disabled={busy} className="grid min-w-0 grid-cols-2 gap-2">
          <NumberField
            label="Suggestions"
            value={options.maxCandidates}
            min={1}
            max={50}
            onChange={(value) => setOptions({ ...options, maxCandidates: value })}
          />
          {scoreKeys.map((key) => (
            <NumberField
              key={key}
              label={`${scoreLabels[key]} weight`}
              value={options.weights[key]}
              min={0}
              max={100}
              step={0.5}
              onChange={(value) =>
                setOptions({ ...options, weights: { ...options.weights, [key]: value } })
              }
            />
          ))}
        </fieldset>
      </details>
      {!validOptions && (
        <p role="alert" className="text-amber-300">
          Check clip lengths, suggestion count, and weights. At least one weight must be positive.
        </p>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setShowSetup(!showSetup)}
        aria-expanded={showSetup}
      >
        {showSetup ? "Hide speech setup" : "Speech setup"}
      </Button>
      {showSetup && <TranscriptionSetupPanel />}
      {!ready && (
        <p className="text-[11px] text-amber-200">
          Open Speech setup and use Save and check setup before analyzing.
        </p>
      )}
      <Button
        variant="primary"
        className="w-full"
        disabled={busy || !ready || !validRange || !validOptions}
        onClick={() => usable && void state.generate(usable.id, start, end, options)}
      >
        {state.generating ? "Analyzing speech…" : "Find candidate clips"}
      </Button>
      {state.generating && (
        <p role="status" className="text-slate-400">
          Transcription is running. Follow progress or cancel in Jobs.
        </p>
      )}
      {state.error && (
        <p role="alert" className="text-rose-300">
          {state.error}
        </p>
      )}
      {state.notice && (
        <p role="status" className="text-emerald-200">
          {state.notice}
        </p>
      )}
      {draft && (
        <div className="space-y-3 border-t border-slate-800 pt-3">
          <div>
            <h3 className="font-medium text-slate-200">
              Review {draft.candidates.length} suggestions
            </h3>
            <p className="mt-1 break-words text-[11px] text-slate-400">
              {draftAsset?.fileName} · {formatDuration(draft.sourceStart)}–
              {formatDuration(draft.sourceEnd)} · {draft.transcript.language}
            </p>
          </div>
          <Button size="sm" disabled={busy || !validOptions} onClick={() => state.rerank(options)}>
            Re-rank transcript
          </Button>
          <p className="text-[11px] text-slate-500">
            Adjust preferences and re-rank without transcribing again. Matching selections stay
            checked.
          </p>
          {!draft.candidates.length && (
            <p className="text-slate-400">
              No speech passages fit these lengths. Try a shorter minimum or another source range.
            </p>
          )}
          {draft.candidates.map((candidate, index) => (
            <CandidateCard
              key={candidate.id}
              candidate={candidate}
              rank={index + 1}
              checked={state.selectedIds.includes(candidate.id)}
              disabled={busy}
              onToggle={() => state.toggle(candidate.id)}
              onPreview={() =>
                useSourcePreviewStore
                  .getState()
                  .preview(draft.mediaId, candidate.start, candidate.end)
              }
            />
          ))}
          {!!draft.candidates.length && (
            <div className="sticky bottom-0 space-y-2 border-t border-slate-700 bg-slate-900 py-3">
              <Button
                variant="primary"
                className="w-full"
                disabled={busy || !state.selectedIds.length}
                onClick={() => state.applySelected()}
              >
                Add selected ({state.selectedIds.length})
              </Button>
              <p className="text-[11px] text-slate-400">
                Adds clips in source order at the end of your timeline. Undo removes the whole
                addition.
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block min-w-0 text-[11px]">
      {label}
      <input
        type="number"
        className={inputClass}
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : ""}
        onChange={(event) => onChange(event.target.valueAsNumber)}
      />
    </label>
  );
}

function CandidateCard({
  candidate,
  rank,
  checked,
  disabled,
  onToggle,
  onPreview,
}: {
  candidate: CandidateClip;
  rank: number;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  onPreview: () => void;
}) {
  return (
    <article className="space-y-2 rounded border border-slate-700 bg-slate-800/30 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 font-medium text-slate-200">
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={onToggle}
            aria-label={`Select suggestion ${rank}`}
          />
          Suggestion {rank}
        </label>
        <span title="Weighted transcript score" className="text-indigo-300">
          {candidate.score.toFixed(0)}/100
        </span>
      </div>
      <p className="text-[11px] text-slate-400">
        {formatDuration(candidate.start)}–{formatDuration(candidate.end)} ·{" "}
        {(candidate.end - candidate.start).toFixed(1)}s
      </p>
      <p
        dir="auto"
        className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words leading-5 text-slate-200"
      >
        {candidate.text}
      </p>
      <Button size="sm" disabled={disabled} onClick={onPreview}>
        Preview suggestion {rank}
      </Button>
      <details className="text-[11px] text-slate-400">
        <summary className="cursor-pointer">Why this clip?</summary>
        <ul className="my-2 list-disc space-y-1 pl-4">
          {candidate.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
        <dl className="space-y-1">
          {scoreKeys.map((key) => (
            <div key={key} className="flex justify-between gap-2">
              <dt>{scoreLabels[key]}</dt>
              <dd>{candidate.scores[key].toFixed(0)}/100</dd>
            </div>
          ))}
        </dl>
      </details>
    </article>
  );
}
