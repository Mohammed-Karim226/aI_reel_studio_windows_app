import { retimeCaptionSegment, splitCaptionSegment, type CaptionSegment } from "@/domain/captions";
import { Button } from "@/shared/ui/Button";

const inputClass = "mt-1 w-full min-w-0 rounded bg-slate-800 p-1.5 text-slate-200";
const seconds = (value: number) => Number(value.toFixed(3));

export function CaptionSegmentEditor({
  segment,
  nextSegment,
  onReplace,
  onDelete,
  onMerge,
  onError,
}: {
  segment: CaptionSegment;
  nextSegment?: CaptionSegment;
  onReplace: (segments: CaptionSegment[]) => boolean;
  onDelete: () => void;
  onMerge: () => void;
  onError: (error: unknown) => void;
}) {
  function retime(key: "start" | "end", value: number): boolean {
    try {
      return onReplace([
        retimeCaptionSegment(
          segment,
          key === "start" ? value : segment.start,
          key === "end" ? value : segment.end,
        ),
      ]);
    } catch (error) {
      onError(error);
      return false;
    }
  }
  function replaceText(text: string): boolean {
    const words = text.trim().split(/\s+/u).filter(Boolean);
    if (!words.length) {
      onError(new Error("A caption needs at least one word."));
      return false;
    }
    if (words.join(" ") === segment.words.map((word) => word.text).join(" ")) return true;
    const duration = (segment.end - segment.start) / words.length;
    return onReplace([
      {
        ...segment,
        words: words.map((word, index) => ({
          text: word,
          start: segment.start + index * duration,
          end: segment.start + (index + 1) * duration,
          emphasis: false,
        })),
      },
    ]);
  }
  const text = segment.words.map((word) => word.text).join(" ");
  return (
    <div className="mt-3 rounded border border-indigo-500/40 bg-slate-900/60 p-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium text-slate-200">Edit caption</h3>
        <Button size="sm" variant="ghost" onClick={onDelete}>
          Delete caption
        </Button>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {(["start", "end"] as const).map((key) => (
          <label key={key}>
            {key === "start" ? "Start" : "End"} (s)
            <input
              key={segment[key]}
              aria-label={`Caption ${key} time`}
              className={inputClass}
              type="number"
              min={0}
              step={0.01}
              defaultValue={seconds(segment[key])}
              onBlur={(event) => {
                if (event.target.valueAsNumber === seconds(segment[key])) return;
                if (!retime(key, event.target.valueAsNumber))
                  event.target.value = String(seconds(segment[key]));
              }}
            />
          </label>
        ))}
      </div>
      <textarea
        key={text}
        aria-label="Caption text"
        dir="auto"
        className={`${inputClass} mt-2 min-h-16 resize-y`}
        defaultValue={text}
        onBlur={(event) => {
          if (!replaceText(event.target.value)) event.target.value = text;
        }}
      />
      <p className="mt-1 text-[11px] text-slate-500">
        Changing the full text distributes word times evenly. Edit individual words below to
        preserve their timing.
      </p>
      <div className="mt-3 space-y-2">
        {segment.words.map((word, index) => (
          <div key={index} className="rounded border border-slate-800 p-2">
            <div className="flex items-center gap-2">
              <input
                key={word.text}
                aria-label={`Word ${index + 1} text`}
                dir="auto"
                className="min-w-0 flex-1 rounded bg-slate-800 p-1.5"
                maxLength={512}
                defaultValue={word.text}
                onBlur={(event) => {
                  if (event.target.value.trim() === word.text) return;
                  if (
                    !onReplace([
                      {
                        ...segment,
                        words: segment.words.map((item, at) =>
                          at === index ? { ...item, text: event.target.value } : item,
                        ),
                      },
                    ])
                  )
                    event.target.value = word.text;
                }}
              />
              <label className="flex items-center gap-1 text-[11px]">
                <input
                  aria-label={`Emphasize word ${index + 1}`}
                  type="checkbox"
                  checked={word.emphasis}
                  onChange={(event) =>
                    onReplace([
                      {
                        ...segment,
                        words: segment.words.map((item, at) =>
                          at === index ? { ...item, emphasis: event.target.checked } : item,
                        ),
                      },
                    ])
                  }
                />
                Emphasis
              </label>
            </div>
            <div className="mt-1 grid grid-cols-2 gap-2">
              {(["start", "end"] as const).map((key) => (
                <label key={key} className="text-[11px]">
                  {key === "start" ? "Start" : "End"}
                  <input
                    key={word[key]}
                    aria-label={`Word ${index + 1} ${key}`}
                    className={inputClass}
                    type="number"
                    min={segment.start}
                    max={segment.end}
                    step={0.01}
                    defaultValue={seconds(word[key])}
                    onBlur={(event) => {
                      if (event.target.valueAsNumber === seconds(word[key])) return;
                      if (
                        !onReplace([
                          {
                            ...segment,
                            words: segment.words.map((item, at) =>
                              at === index ? { ...item, [key]: event.target.valueAsNumber } : item,
                            ),
                          },
                        ])
                      )
                        event.target.value = String(seconds(word[key]));
                    }}
                  />
                </label>
              ))}
            </div>
            {index > 0 && (
              <button
                type="button"
                className="mt-1 text-[11px] text-indigo-300 hover:underline"
                onClick={() => {
                  try {
                    onReplace(splitCaptionSegment(segment, index));
                  } catch (error) {
                    onError(error);
                  }
                }}
              >
                Split before word {index + 1}
              </button>
            )}
          </div>
        ))}
      </div>
      <Button
        className="mt-2"
        size="sm"
        disabled={!nextSegment || segment.words.length + nextSegment.words.length > 100}
        onClick={onMerge}
      >
        Merge with next caption
      </Button>
    </div>
  );
}
