import {
  activeCaption,
  captionDirection,
  captionWordIsHighlighted,
  type CaptionTrack,
} from "@/domain/captions";

/** Parent is the design canvas and establishes container-type: inline-size. */
export function CaptionOverlay({
  captions,
  time,
  width,
}: {
  captions: CaptionTrack;
  time: number;
  width: number;
}) {
  const segment = activeCaption(captions, time);
  if (!segment) return null;
  const style = captions.style;
  const text = segment.words.map((word) => word.text).join(" ");
  const duration = segment.end - segment.start;
  const progress = Math.min(1, Math.max(0, (time - segment.start) / Math.min(0.18, duration / 3)));
  const exitProgress = Math.min(
    1,
    Math.max(0, (segment.end - time) / Math.min(0.12, duration / 3)),
  );
  const scale = style.animation === "pop" ? 0.86 + 0.14 * (1 - (1 - progress) ** 3) : 1;
  const unit = 100 / Math.max(1, width);
  return (
    <div
      aria-label="Caption overlay"
      className="pointer-events-none absolute inset-0 z-30 overflow-hidden"
    >
      <div
        dir={captionDirection(text, style.direction)}
        className="absolute text-center"
        style={{
          left: `${style.x}%`,
          top: `${style.y}%`,
          width: `${style.maxWidth}%`,
          transform: `translate(-50%, -50%) scale(${scale})`,
          opacity: style.animation === "fade" ? Math.min(progress, exitProgress) : 1,
          fontFamily: style.fontFamily,
          fontSize: `${style.fontSize * unit}cqw`,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
          color: style.color,
          background: style.background,
          WebkitTextStroke: `${style.outlineWidth * unit}cqw ${style.outlineColor}`,
          paintOrder: "stroke fill",
          textShadow: style.shadow ? `0 ${2 * unit}cqw ${5 * unit}cqw #000000cc` : "none",
          borderRadius: "0.15em",
          padding: style.background !== "transparent" ? "0.15em 0.25em" : 0,
          overflowWrap: "anywhere",
          whiteSpace: "pre-wrap",
          unicodeBidi: "isolate",
        }}
      >
        {segment.words.map((word, index) => (
          <span key={index}>
            {index > 0 ? " " : null}
            <span
              data-highlighted={captionWordIsHighlighted(word, time, style.highlighting)}
              style={{
                color: captionWordIsHighlighted(word, time, style.highlighting)
                  ? style.highlightColor
                  : style.color,
                fontWeight: word.emphasis ? 900 : style.fontWeight,
              }}
            >
              {word.text}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
