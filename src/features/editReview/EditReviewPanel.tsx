import { useId } from "react";
import { hookReviewTextSchema, type ReviewSuggestion } from "@/domain/editReview/model";
import { safeZones, type SafeZonePlatform } from "@/domain/safeZones";
import { formatDuration } from "@/shared/format";
import { Button } from "@/shared/ui/Button";
import { useEditReviewStore } from "@/stores/editReviewStore";
import { useTimelineStore } from "@/stores/timelineStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

const categoryLabels: Record<ReviewSuggestion["category"], string> = {
  hook: "Opening hook",
  pacing: "Pacing",
  captions: "Captions",
  zoom: "Zoom",
  weakSection: "Section to review",
  safeZone: "Safe zones",
};

export function EditReviewPanel() {
  const state = useEditReviewStore();
  const timeline = useTimelineStore((editor) => editor.timeline);
  const timelineBusy = useTimelineStore((editor) => editor.loading || editor.saving);
  const workspaceBusy = useWorkspaceStore(
    (workspace) => workspace.closing || workspace.busy || workspace.status !== "editor",
  );
  const blocked = workspaceBusy || timelineBusy || !timeline;
  const hasClips = !!timeline?.tracks.some((track) => track.clips.length);
  const suggestions = state.suggestions.filter((item) => !state.ignoredIds.includes(item.id));
  const previewed = suggestions.find((item) => item.id === state.preview?.suggestionId);

  return (
    <section className="space-y-3 p-3 text-xs" aria-label="Edit review">
      <div>
        <h2 className="font-semibold text-slate-200">Review your edit</h2>
        <p className="mt-1 leading-5 text-slate-400">
          Local checks use clip timing, caption words, effects, and layout settings. They do not
          inspect video frames or listen to audio.
        </p>
      </div>
      <label className="block text-slate-400">
        Platform safe zones
        <select
          className="mt-1 w-full min-w-0 rounded bg-slate-800 p-1.5 text-slate-200"
          value={state.platform}
          disabled={blocked}
          onChange={(event) => state.setPlatform(event.target.value as SafeZonePlatform)}
        >
          {Object.entries(safeZones).map(([platform, zone]) => (
            <option key={platform} value={platform}>
              {zone.label}
            </option>
          ))}
        </select>
      </label>
      <p className="text-[11px] leading-4 text-slate-500">
        Platform guides are approximate. Check text placement in the final upload.
      </p>
      <Button
        variant="primary"
        className="w-full"
        disabled={blocked || !hasClips}
        onClick={() => state.review()}
      >
        {state.hasReview ? "Review again" : "Review timeline"}
      </Button>
      {!hasClips && !timelineBusy && (
        <p className="text-slate-400">Add media to the timeline to review your edit.</p>
      )}
      {state.stale && (
        <p role="status" className="rounded border border-amber-800/60 p-2 text-amber-200">
          Your edit or review settings changed. Review again to refresh suggestions.
        </p>
      )}
      {state.error && (
        <p role="alert" className="break-words text-rose-300">
          {state.error}
        </p>
      )}
      {state.notice && (
        <p role="status" className="text-emerald-200">
          {state.notice}
        </p>
      )}
      {previewed && (
        <div className="space-y-2 rounded border border-indigo-700 bg-indigo-950/40 p-2.5">
          <p className="font-medium text-indigo-200">Previewing: {previewed.title}</p>
          <p className="leading-4 text-slate-400">
            {previewed.action
              ? "Apply changes the timeline. Undo restores the previous edit."
              : "Play this range in the monitor and use the guidance below to edit it manually."}
          </p>
          <Button size="sm" disabled={blocked} onClick={() => state.clearPreview()}>
            Close preview
          </Button>
        </div>
      )}
      {state.hasReview && (
        <div className="space-y-3 border-t border-slate-800 pt-3">
          <p className="font-medium text-slate-200">
            {suggestions.length} {suggestions.length === 1 ? "suggestion" : "suggestions"}
          </p>
          {!suggestions.length && (
            <p className="leading-5 text-slate-400">
              {state.suggestions.length
                ? "All suggestions ignored. Review again to start a new review."
                : "No suggestions from these checks. Play through your edit before exporting."}
            </p>
          )}
          {suggestions.map((suggestion) => (
            <SuggestionCard
              key={suggestion.id}
              suggestion={suggestion}
              blocked={blocked}
              stale={state.stale}
              hookText={state.hookText}
              active={state.preview?.suggestionId === suggestion.id}
              onHookTextChange={state.setHookText}
              onPreview={() => state.previewSuggestion(suggestion.id)}
              onApply={() => state.apply(suggestion.id)}
              onIgnore={() => state.ignore(suggestion.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SuggestionCard({
  suggestion,
  blocked,
  stale,
  hookText,
  active,
  onHookTextChange,
  onPreview,
  onApply,
  onIgnore,
}: {
  suggestion: ReviewSuggestion;
  blocked: boolean;
  stale: boolean;
  hookText: string;
  active: boolean;
  onHookTextChange: (text: string) => void;
  onPreview: () => void;
  onApply: () => void;
  onIgnore: () => void;
}) {
  const id = useId();
  const openingHook = suggestion.action?.type === "openingHook";
  const validHook =
    !openingHook || (!!hookText.trim() && hookReviewTextSchema.safeParse(hookText).success);
  const actionReason = !suggestion.action
    ? "This needs a manual edit. Preview the range, then use the timeline or inspector."
    : !validHook
      ? "Enter hook text of up to 160 characters to preview or apply."
      : null;

  return (
    <article
      aria-labelledby={`${id}-title`}
      className={`space-y-2 rounded border p-2.5 ${active ? "border-indigo-500 bg-indigo-950/30" : "border-slate-700 bg-slate-800/30"}`}
    >
      <p className="text-[10px] uppercase tracking-wide text-indigo-300">
        {categoryLabels[suggestion.category]}
      </p>
      <h3 id={`${id}-title`} className="font-medium leading-5 text-slate-200">
        {suggestion.title}
      </h3>
      <p className="text-[11px] tabular-nums text-slate-400">
        {reviewTime(suggestion.start)}–{reviewTime(suggestion.end)}
      </p>
      <p className="break-words leading-5 text-slate-400">{suggestion.explanation}</p>
      {openingHook && (
        <label className="block text-slate-400">
          Opening hook text
          <textarea
            dir="auto"
            rows={3}
            maxLength={160}
            value={hookText}
            disabled={blocked || stale}
            onChange={(event) => onHookTextChange(event.target.value)}
            className="mt-1 w-full resize-y rounded bg-slate-800 p-2 text-slate-200"
          />
        </label>
      )}
      {actionReason && (
        <p id={`${id}-reason`} className="text-[11px] leading-4 text-slate-400">
          {actionReason}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          aria-label={`Preview ${suggestion.title}`}
          aria-pressed={active}
          aria-describedby={!validHook ? `${id}-reason` : undefined}
          disabled={blocked || stale || !validHook}
          onClick={onPreview}
        >
          Preview
        </Button>
        <Button
          size="sm"
          variant="primary"
          aria-label={`Apply ${suggestion.title}`}
          aria-describedby={actionReason ? `${id}-reason` : undefined}
          disabled={blocked || stale || !suggestion.action || !validHook}
          onClick={onApply}
        >
          Apply
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Ignore ${suggestion.title}`}
          disabled={blocked}
          onClick={onIgnore}
        >
          Ignore
        </Button>
      </div>
    </article>
  );
}

function reviewTime(seconds: number) {
  const tenths = Math.round(seconds * 10);
  return `${formatDuration(tenths / 10)}.${tenths % 10}`;
}
