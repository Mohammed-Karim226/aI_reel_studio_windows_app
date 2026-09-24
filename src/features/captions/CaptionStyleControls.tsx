import { captionPresets, type CaptionStyle } from "@/domain/captions";

const inputClass = "mt-1 w-full min-w-0 rounded bg-slate-800 p-2 text-slate-200";

export function CaptionStyleControls({
  style,
  onChange,
}: {
  style: CaptionStyle;
  onChange: (style: CaptionStyle) => boolean;
}) {
  function numberField(
    label: string,
    key: "fontSize" | "outlineWidth" | "x" | "y" | "lineHeight" | "maxWidth",
    min: number,
    max: number,
    step = 1,
  ) {
    return (
      <label>
        {label}
        <input
          key={style[key]}
          aria-label={`Caption ${label.toLowerCase()}`}
          className={inputClass}
          type="number"
          min={min}
          max={max}
          step={step}
          defaultValue={style[key]}
          onBlur={(event) => {
            if (!onChange({ ...style, [key]: event.target.valueAsNumber }))
              event.target.value = String(style[key]);
          }}
        />
      </label>
    );
  }
  function textField(
    label: string,
    key: "fontFamily" | "color" | "highlightColor" | "outlineColor" | "background",
  ) {
    return (
      <label>
        {label}
        <input
          key={style[key]}
          aria-label={`Caption ${label.toLowerCase()}`}
          className={inputClass}
          maxLength={key === "fontFamily" ? 128 : 32}
          defaultValue={style[key]}
          onBlur={(event) => {
            if (!onChange({ ...style, [key]: event.target.value })) event.target.value = style[key];
          }}
        />
      </label>
    );
  }
  return (
    <div className="mt-3 space-y-3">
      <label className="block">
        Style
        <select
          aria-label="Caption style"
          className={inputClass}
          value={style.preset}
          onChange={(event) => {
            const preset = captionPresets.find((item) => item.id === event.target.value);
            if (preset) onChange({ ...preset.style });
          }}
        >
          {captionPresets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </select>
      </label>
      <details className="rounded border border-slate-800 p-2">
        <summary className="cursor-pointer font-medium text-slate-300">Customize style</summary>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {textField("Font", "fontFamily")}
          {numberField("Size", "fontSize", 10, 200)}
          <label>
            Weight
            <select
              aria-label="Caption weight"
              className={inputClass}
              value={style.fontWeight}
              onChange={(event) =>
                onChange({
                  ...style,
                  fontWeight: Number(event.target.value) as CaptionStyle["fontWeight"],
                })
              }
            >
              <option value={400}>Regular</option>
              <option value={700}>Bold</option>
              <option value={900}>Black</option>
            </select>
          </label>
          <label>
            Direction
            <select
              aria-label="Caption direction"
              className={inputClass}
              value={style.direction}
              onChange={(event) =>
                onChange({ ...style, direction: event.target.value as CaptionStyle["direction"] })
              }
            >
              <option value="auto">Auto</option>
              <option value="ltr">Left to right</option>
              <option value="rtl">Right to left</option>
            </select>
          </label>
          {textField("Color", "color")}
          {textField("Highlight color", "highlightColor")}
          {textField("Outline color", "outlineColor")}
          {numberField("Outline width", "outlineWidth", 0, 12, 0.5)}
          {textField("Background", "background")}
          {numberField("Line spacing", "lineHeight", 0.8, 2, 0.1)}
          {numberField("X position", "x", 0, 100)}
          {numberField("Y position", "y", 0, 100)}
          {numberField("Maximum width", "maxWidth", 10, 100)}
          <label className="flex items-center gap-2 self-end py-2">
            <input
              aria-label="Caption shadow"
              type="checkbox"
              checked={style.shadow}
              onChange={(event) => onChange({ ...style, shadow: event.target.checked })}
            />
            Shadow
          </label>
          <label>
            Animation
            <select
              aria-label="Caption animation"
              className={inputClass}
              value={style.animation}
              onChange={(event) =>
                onChange({ ...style, animation: event.target.value as CaptionStyle["animation"] })
              }
            >
              <option value="none">None</option>
              <option value="fade">Fade</option>
              <option value="pop">Pop</option>
            </select>
          </label>
          <label>
            Highlighting
            <select
              aria-label="Caption highlighting"
              className={inputClass}
              value={style.highlighting}
              onChange={(event) =>
                onChange({
                  ...style,
                  highlighting: event.target.value as CaptionStyle["highlighting"],
                })
              }
            >
              <option value="none">None</option>
              <option value="word">Current word</option>
              <option value="karaoke">Karaoke</option>
            </select>
          </label>
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          Use installed fonts. Tahoma supports Arabic; direction Auto follows the first letter.
          Colors accept hex, and background also accepts transparent.
        </p>
      </details>
    </div>
  );
}
