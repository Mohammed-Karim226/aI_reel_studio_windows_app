import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  captionTrackSchema,
  segmentTranscript,
  type CaptionSegment,
  type CaptionTrack,
} from "@/domain/captions";
import { errorMessage } from "@/domain/errors";
import { serializeTimeline } from "@/domain/timeline/model";
import { transcribeMedia } from "@/infrastructure/tauri/captions";
import { useMediaStore } from "@/stores/mediaStore";
import { useTimelineStore } from "@/stores/timelineStore";
import { useTranscriptionStore } from "@/stores/transcriptionStore";
import { Button } from "@/shared/ui/Button";
import { CaptionSegmentEditor } from "./CaptionSegmentEditor";
import { CaptionStyleControls } from "./CaptionStyleControls";
import { TranscriptionSetupPanel } from "./TranscriptionSetupPanel";

interface GeneratedDraft {
  projectId: string;
  snapshot: string;
  label: string;
  start: number;
  end: number;
  language: string;
  segments: CaptionSegment[];
}

const inputClass = "mt-1 w-full min-w-0 rounded bg-slate-800 p-2 text-slate-200";
const seconds = (value: number) => `${value.toFixed(2)}s`;
export function CaptionDesigner() {
  const projectId = useTimelineStore((state) => state.projectId);
  const timeline = useTimelineStore((state) => state.timeline);
  const selectedIds = useTimelineStore((state) => state.selectedIds);
  const playhead = useTimelineStore((state) => state.playhead);
  const edit = useTimelineStore((state) => state.edit);
  const assets = useMediaStore((state) => state.assets);
  const { pythonPath, modelPath, language } = useTranscriptionStore((state) => state.setup);
  const speechReady = useTranscriptionStore(
    (state) => state.readiness?.ready === true && !state.checking && !state.loading,
  );
  const [maxWords, setMaxWords] = useState(6);
  const [maxDuration, setMaxDuration] = useState(3);
  const [generating, setGenerating] = useState(false);
  const [draft, setDraft] = useState<GeneratedDraft | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
    },
    [projectId],
  );
  if (!timeline || !projectId) return null;
  const captions = timeline.captions;
  const clip =
    selectedIds.length === 1
      ? timeline.tracks.flatMap((track) => track.clips).find((item) => item.id === selectedIds[0])
      : undefined;
  const asset = clip ? assets.find((item) => item.id === clip.sourceMediaId) : undefined;
  const selectedSegment =
    captions.segments.find((segment) => segment.id === selectedSegmentId) ??
    captions.segments.find((segment) => segment.start <= playhead && playhead < segment.end);
  const selectedIndex = selectedSegment ? captions.segments.indexOf(selectedSegment) : -1;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(captions.segments.length / 25) - 1));
  const showError = (error: unknown) =>
    setMessage(
      error instanceof z.ZodError
        ? (error.issues[0]?.message ?? "Check caption settings.")
        : errorMessage(error),
    );

  function applyCaptions(next: CaptionTrack): boolean {
    try {
      const validated = captionTrackSchema.parse(next);
      edit({ type: "captions", captions: validated });
      const error = useTimelineStore.getState().error;
      if (error) {
        setMessage(error);
        return false;
      }
      setMessage(null);
      return true;
    } catch (error) {
      showError(error);
      return false;
    }
  }

  async function generate() {
    if (!clip || !asset?.hasAudio || !projectId || !timeline || !speechReady) return;
    const token = ++request.current;
    const captured = {
      projectId,
      snapshot: serializeTimeline(timeline),
      label: clip.label,
      start: clip.timelineStart,
      end: clip.timelineEnd,
    };
    setGenerating(true);
    setDraft(null);
    setMessage(null);
    try {
      const transcript = await transcribeMedia({
        projectId,
        mediaId: clip.sourceMediaId,
        sourceStart: clip.sourceStart,
        sourceEnd: clip.sourceEnd,
        pythonPath: pythonPath.trim(),
        modelPath: modelPath.trim(),
        language,
      });
      if (token !== request.current) return;
      const current = useTimelineStore.getState();
      if (
        current.projectId !== projectId ||
        !current.timeline ||
        serializeTimeline(current.timeline) !== captured.snapshot
      )
        throw new Error(
          "The timeline changed during transcription. Generate again for the current edit.",
        );
      const segments = segmentTranscript(transcript, {
        timelineStart: clip.timelineStart,
        duration: clip.sourceEnd - clip.sourceStart,
        maxWords,
        maxDuration,
      });
      if (!segments.length) {
        setMessage("No speech was detected in the selected clip.");
        return;
      }
      setDraft({ ...captured, language: transcript.language, segments });
    } catch (error) {
      if (token === request.current) showError(error);
    } finally {
      if (token === request.current) setGenerating(false);
    }
  }

  function applyDraft() {
    if (!draft) return;
    const current = useTimelineStore.getState();
    if (
      current.projectId !== draft.projectId ||
      !current.timeline ||
      serializeTimeline(current.timeline) !== draft.snapshot
    ) {
      setMessage(
        "The timeline changed after transcription. Generate again before applying captions.",
      );
      return;
    }
    const outside = current.timeline.captions.segments.filter(
      (segment) => segment.end <= draft.start || segment.start >= draft.end,
    );
    if (
      applyCaptions({
        ...current.timeline.captions,
        enabled: true,
        segments: [...outside, ...draft.segments].sort((a, b) => a.start - b.start),
      })
    ) {
      setSelectedSegmentId(draft.segments[0].id);
      useTimelineStore.getState().seek(draft.segments[0].start);
      setDraft(null);
    }
  }

  function addCaption() {
    const next = captions.segments.find((segment) => segment.start > playhead);
    if (captions.segments.some((segment) => segment.start <= playhead && playhead < segment.end)) {
      setMessage("Move the playhead to a gap before adding a caption.");
      return;
    }
    const end = Math.min(playhead + 2, next?.start ?? timeline!.duration, timeline!.duration);
    if (end <= playhead) {
      setMessage("Move the playhead before the end of the timeline.");
      return;
    }
    const segment: CaptionSegment = {
      id: crypto.randomUUID(),
      start: playhead,
      end,
      words: [{ text: "Caption", start: playhead, end, emphasis: false }],
    };
    if (
      applyCaptions({
        ...captions,
        segments: [...captions.segments, segment].sort((a, b) => a.start - b.start),
      })
    )
      setSelectedSegmentId(segment.id);
  }

  return (
    <section className="border-t border-slate-800 p-3 text-xs text-slate-400">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold text-slate-200">Captions</h2>
        <label className="flex items-center gap-1 text-[11px]">
          <input
            aria-label="Enable captions"
            type="checkbox"
            checked={captions.enabled}
            onChange={(event) => applyCaptions({ ...captions, enabled: event.target.checked })}
          />
          Enabled
        </label>
      </div>
      <details
        className="mt-3 rounded border border-slate-800 p-2"
        open={!captions.segments.length}
      >
        <summary className="cursor-pointer font-medium text-slate-300">
          Generate from speech
        </summary>
        <p className="mt-2 text-[11px]">
          {clip && asset?.hasAudio
            ? `${clip.label} · ${seconds(clip.sourceStart)}–${seconds(clip.sourceEnd)}`
            : "Select one timeline clip containing audio."}
        </p>
        <TranscriptionSetupPanel />
        <p className="mt-2 text-[11px] text-slate-500">
          {speechReady
            ? "Progress and cancellation appear in Jobs."
            : "Save and check speech setup before generating captions."}
        </p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label>
            Words per caption
            <input
              aria-label="Words per caption"
              className={inputClass}
              type="number"
              min={1}
              max={100}
              value={maxWords}
              onChange={(event) => setMaxWords(Number(event.target.value))}
            />
          </label>
          <label>
            Max duration (s)
            <input
              aria-label="Maximum caption duration"
              className={inputClass}
              type="number"
              min={0.1}
              max={30}
              step={0.1}
              value={maxDuration}
              onChange={(event) => setMaxDuration(Number(event.target.value))}
            />
          </label>
        </div>
        <Button
          className="mt-3 w-full"
          size="sm"
          variant="primary"
          disabled={
            generating ||
            !speechReady ||
            !asset?.hasAudio ||
            !clip ||
            !modelPath.trim() ||
            !pythonPath.trim() ||
            !Number.isInteger(maxWords) ||
            maxWords < 1 ||
            maxWords > 100 ||
            !Number.isFinite(maxDuration) ||
            maxDuration <= 0 ||
            maxDuration > 30
          }
          onClick={() => void generate()}
        >
          {generating ? "Transcribing…" : "Generate captions"}
        </Button>
        {draft && (
          <div className="mt-3 rounded border border-emerald-700/60 p-2">
            <p className="text-emerald-200">
              {draft.segments.length} captions · {draft.language}
            </p>
            <p className="mt-1 text-[11px]">
              Apply replaces captions intersecting {seconds(draft.start)}–{seconds(draft.end)} for{" "}
              {draft.label}.
            </p>
            <ol
              aria-label="Generated caption preview"
              className="mt-2 max-h-52 space-y-2 overflow-y-auto text-slate-200"
            >
              {draft.segments.map((segment) => (
                <li key={segment.id} className="rounded bg-slate-950/50 p-2">
                  <span className="block text-[10px] tabular-nums text-slate-500">
                    {seconds(segment.start)}–{seconds(segment.end)}
                  </span>
                  <span dir="auto" className="block">
                    {segment.words.map((word) => word.text).join(" ")}
                  </span>
                </li>
              ))}
            </ol>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="primary" onClick={applyDraft}>
                Apply generated captions
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                Discard
              </Button>
            </div>
          </div>
        )}
      </details>
      {message && (
        <p role="alert" className="mt-2 rounded bg-amber-950/50 p-2 text-[11px] text-amber-200">
          {message}
        </p>
      )}
      <CaptionStyleControls
        style={captions.style}
        onChange={(style) => applyCaptions({ ...captions, style })}
      />
      <div className="mt-3 flex items-center justify-between">
        <span>{captions.segments.length} captions</span>
        <Button size="sm" disabled={!timeline.duration} onClick={addCaption}>
          Add at playhead
        </Button>
      </div>
      <div className="mt-2 max-h-44 space-y-1 overflow-y-auto" aria-label="Caption segments">
        {captions.segments.slice(currentPage * 25, currentPage * 25 + 25).map((segment) => (
          <button
            key={segment.id}
            type="button"
            aria-pressed={selectedSegment?.id === segment.id}
            className={`block w-full rounded p-2 text-start ${selectedSegment?.id === segment.id ? "bg-indigo-900/60 text-slate-100" : "bg-slate-900 text-slate-400 hover:bg-slate-800"}`}
            onClick={() => {
              setSelectedSegmentId(segment.id);
              useTimelineStore.getState().seek(segment.start);
            }}
          >
            <span className="block text-[10px] tabular-nums">
              {seconds(segment.start)}–{seconds(segment.end)}
            </span>
            <span dir="auto" className="block truncate">
              {segment.words.map((word) => word.text).join(" ")}
            </span>
          </button>
        ))}
      </div>
      {captions.segments.length > 25 && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <Button size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
            Previous captions
          </Button>
          <span>
            {currentPage + 1}/{Math.ceil(captions.segments.length / 25)}
          </span>
          <Button
            size="sm"
            disabled={(currentPage + 1) * 25 >= captions.segments.length}
            onClick={() => setPage(currentPage + 1)}
          >
            Next captions
          </Button>
        </div>
      )}
      {selectedSegment && (
        <CaptionSegmentEditor
          key={selectedSegment.id}
          segment={selectedSegment}
          nextSegment={captions.segments[selectedIndex + 1]}
          onError={showError}
          onReplace={(replacements) =>
            applyCaptions({
              ...captions,
              segments: captions.segments.flatMap((segment) =>
                segment.id === selectedSegment.id ? replacements : [segment],
              ),
            })
          }
          onDelete={() => {
            if (
              applyCaptions({
                ...captions,
                segments: captions.segments.filter((segment) => segment.id !== selectedSegment.id),
              })
            )
              setSelectedSegmentId(null);
          }}
          onMerge={() => {
            const next = captions.segments[selectedIndex + 1];
            if (!next) return;
            applyCaptions({
              ...captions,
              segments: captions.segments.flatMap((segment) =>
                segment.id === selectedSegment.id
                  ? [
                      {
                        ...selectedSegment,
                        end: next.end,
                        words: [...selectedSegment.words, ...next.words],
                      },
                    ]
                  : segment.id === next.id
                    ? []
                    : [segment],
              ),
            });
          }}
        />
      )}
    </section>
  );
}
