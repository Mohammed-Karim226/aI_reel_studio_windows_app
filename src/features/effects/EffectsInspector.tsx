import { useState } from "react";
import {
  createEffect,
  EFFECT_DEFINITIONS,
  effectTypes,
  evaluateEffects,
  type ClipEffect,
  type EffectParameterDefinition,
  type EffectType,
} from "@/domain/effects";
import type { TimelineClip } from "@/domain/timeline/model";
import { sourceTime } from "@/domain/timeline/playback";
import { Button } from "@/shared/ui/Button";
import { useTimelineStore } from "@/stores/timelineStore";

const inputClass = "mt-1 w-full min-w-0 rounded bg-slate-800 p-1.5 text-slate-200";
const easings = ["linear", "ease-in", "ease-out", "ease-in-out"] as const;
const sameTime = (a: number, b: number) => Math.abs(a - b) < 0.000001;

/** Read the current stack at commit time: a preceding field blur may already have edited it. */
function changeStack(clipId: string, change: (effects: ClipEffect[]) => ClipEffect[]): boolean {
  const state = useTimelineStore.getState();
  const clip = state.timeline?.tracks.flatMap((track) => track.clips).find((c) => c.id === clipId);
  if (!clip || state.selectedIds.length !== 1 || state.selectedIds[0] !== clipId) return false;
  state.edit({ type: "effects", id: clipId, effects: change(structuredClone(clip.effects)) });
  return useTimelineStore.getState().error === null;
}

function changeEffect(clipId: string, effectId: string, change: (effect: ClipEffect) => void) {
  return changeStack(clipId, (effects) => {
    const effect = effects.find((item) => item.id === effectId);
    if (effect) change(effect);
    return effects;
  });
}

function setKeyframe(effect: ClipEffect, property: string, time: number, value: number) {
  let animation = effect.animations.find((item) => item.property === property);
  if (!animation) {
    animation = { property, keyframes: [] };
    effect.animations.push(animation);
  }
  const existing = animation.keyframes.find((frame) => sameTime(frame.time, time));
  if (existing) existing.value = value;
  else animation.keyframes.push({ time, value, easing: "linear" });
  animation.keyframes.sort((a, b) => a.time - b.time);
}

export function EffectsInspector() {
  const timeline = useTimelineStore((state) => state.timeline);
  const selectedIds = useTimelineStore((state) => state.selectedIds);
  const [type, setType] = useState<EffectType>("zoom");
  const track = timeline?.tracks.find((item) =>
    item.clips.some((clip) => clip.id === selectedIds[0]),
  );
  const clip = track?.clips.find((item) => item.id === selectedIds[0]);
  return (
    <section aria-label="Clip effects" className="border-t border-slate-800 p-3 text-xs">
      <h2 className="font-semibold text-slate-200">Effects</h2>
      {!clip || selectedIds.length !== 1 || track?.kind !== "video" ? (
        <p className="mt-2 text-slate-500">Select one video or image clip to edit its effects.</p>
      ) : (
        <>
          <p className="mt-1 break-words text-slate-400">{clip.label}</p>
          {track.locked && (
            <p className="mt-2 text-amber-300">Unlock this track to edit effects.</p>
          )}
          <fieldset disabled={track.locked} className="mt-3 min-w-0 space-y-3">
            <div className="flex items-end gap-2">
              <label className="min-w-0 flex-1">
                Add effect
                <select
                  aria-label="Effect type"
                  className={inputClass}
                  value={type}
                  onChange={(event) => setType(event.target.value as EffectType)}
                >
                  {effectTypes.map((kind) => (
                    <option key={kind} value={kind}>
                      {EFFECT_DEFINITIONS[kind].label}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                size="sm"
                disabled={clip.effects.length >= 16}
                onClick={() =>
                  changeStack(clip.id, (effects) => [
                    ...effects,
                    createEffect(type, clip.sourceStart, clip.sourceEnd - clip.sourceStart),
                  ])
                }
              >
                Add
              </Button>
            </div>
            {clip.effects.length === 0 ? (
              <p className="text-slate-500">No effects on this clip yet.</p>
            ) : (
              <p className="text-[11px] text-slate-500">
                Applied from top to bottom. Up to 16 effects per clip.
              </p>
            )}
            {clip.effects.map((effect, index) => (
              <EffectCard
                key={`${clip.id}:${effect.id}`}
                clip={clip}
                effect={effect}
                index={index}
                count={clip.effects.length}
                fps={timeline?.fps ?? 30}
              />
            ))}
          </fieldset>
        </>
      )}
    </section>
  );
}

function EffectCard({
  clip,
  effect,
  index,
  count,
  fps,
}: {
  clip: TimelineClip;
  effect: ClipEffect;
  index: number;
  count: number;
  fps: number;
}) {
  const definition = EFFECT_DEFINITIONS[effect.type];
  function move(offset: number) {
    changeStack(clip.id, (effects) => {
      const from = effects.findIndex((item) => item.id === effect.id);
      const to = from + offset;
      if (from >= 0 && to >= 0 && to < effects.length)
        [effects[from], effects[to]] = [effects[to], effects[from]];
      return effects;
    });
  }
  return (
    <details
      open
      aria-label={`${definition.label} effect ${index + 1}`}
      className="rounded border border-slate-700 p-2"
    >
      <summary className="cursor-pointer font-medium text-slate-200">
        {index + 1}. {definition.label}
        {!effect.enabled && " (off)"}
      </summary>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <label className="mr-auto flex items-center gap-1 text-slate-400">
          <input
            type="checkbox"
            checked={effect.enabled}
            aria-label={`Enable ${definition.label}`}
            onChange={(event) =>
              changeEffect(clip.id, effect.id, (item) => {
                item.enabled = event.target.checked;
              })
            }
          />
          Enabled
        </label>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Move effect up"
          disabled={index === 0}
          onClick={() => move(-1)}
        >
          Up
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Move effect down"
          disabled={index === count - 1}
          onClick={() => move(1)}
        >
          Down
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Remove ${definition.label}`}
          onClick={() =>
            changeStack(clip.id, (effects) => effects.filter((item) => item.id !== effect.id))
          }
        >
          Remove
        </Button>
      </div>
      <p className="mt-2 text-[11px] text-slate-500">{definition.description}</p>
      <div className="mt-3 space-y-3">
        {definition.parameters.map((parameter) => (
          <ParameterEditor
            key={parameter.key}
            clip={clip}
            effect={effect}
            parameter={parameter}
            fps={fps}
          />
        ))}
      </div>
    </details>
  );
}

function ParameterEditor({
  clip,
  effect,
  parameter,
  fps,
}: {
  clip: TimelineClip;
  effect: ClipEffect;
  parameter: EffectParameterDefinition;
  fps: number;
}) {
  const playhead = useTimelineStore((state) => state.playhead);
  const animation = effect.animations.find((item) => item.property === parameter.key);
  const inClip = playhead >= clip.timelineStart && playhead < clip.timelineEnd;
  const time = sourceTime(clip, playhead);
  // Disabled effects keep their editable animated values while being bypassed in the monitor.
  const evaluated = evaluateEffects([{ ...effect, enabled: true }], time)[0];
  const value = evaluated.params[parameter.key];
  const atKeyframe = animation?.keyframes.some((frame) => sameTime(frame.time, time));
  const label = `${EFFECT_DEFINITIONS[effect.type].label} ${parameter.label.toLowerCase()}`;
  const duration = clip.timelineEnd - clip.timelineStart;
  return (
    <div>
      <NumberField
        label={parameter.label}
        ariaLabel={label}
        value={value}
        min={parameter.min}
        max={parameter.max}
        step={parameter.step}
        disabled={!!animation && !inClip}
        onCommit={(next) =>
          changeEffect(clip.id, effect.id, (item) => {
            if (item.animations.some((entry) => entry.property === parameter.key))
              setKeyframe(item, parameter.key, time, next);
            else item.params[parameter.key] = next;
          })
        }
      />
      <div className="mt-1 flex flex-wrap gap-1">
        <Button
          size="sm"
          variant="ghost"
          aria-label={`${atKeyframe ? "Update" : "Add"} ${label} keyframe`}
          disabled={!inClip || (!atKeyframe && (animation?.keyframes.length ?? 0) >= 100)}
          onClick={() =>
            changeEffect(clip.id, effect.id, (item) =>
              setKeyframe(item, parameter.key, time, value),
            )
          }
        >
          {atKeyframe ? "Update keyframe" : "Keyframe at playhead"}
        </Button>
        {animation && (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Clear ${label} animation`}
            onClick={() =>
              changeEffect(clip.id, effect.id, (item) => {
                item.params[parameter.key] = value;
                item.animations = item.animations.filter(
                  (entry) => entry.property !== parameter.key,
                );
              })
            }
          >
            Clear animation
          </Button>
        )}
      </div>
      {!inClip && (
        <p className="text-[10px] text-slate-500">Seek inside this clip to set a keyframe.</p>
      )}
      {animation && (
        <details className="mt-1 border-l border-slate-700 pl-2">
          <summary className="cursor-pointer text-[11px] text-indigo-300">
            {parameter.label} keyframes ({animation.keyframes.length})
          </summary>
          <p className="mt-2 text-[10px] text-slate-500">
            Times are seconds into this clip. Keyframes follow the footage through moves, splits,
            and trims; points outside the trim are retained. Easing controls arrival at each point.
          </p>
          {animation.keyframes.map((frame) => {
            const local = frame.time - clip.sourceStart;
            const retained = local < -0.000001 || local > duration + 0.000001;
            const changeFrame = (patch: Partial<typeof frame>) =>
              changeEffect(clip.id, effect.id, (item) => {
                const current = item.animations.find((entry) => entry.property === parameter.key);
                const point = current?.keyframes.find((entry) => entry.time === frame.time);
                if (point) Object.assign(point, patch);
                current?.keyframes.sort((a, b) => a.time - b.time);
              });
            return (
              <div key={frame.time} className="mt-2 space-y-1 rounded bg-slate-950/40 p-2">
                {retained ? (
                  <p className="text-[11px] text-slate-400">
                    {local.toFixed(3)}s · {frame.value.toFixed(3)} · outside trim
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <NumberField
                      label="Time (s)"
                      ariaLabel={`${label} keyframe time ${frame.time}`}
                      value={Math.max(0, local)}
                      min={0}
                      max={duration}
                      step={1 / fps}
                      onCommit={(next) =>
                        changeFrame({ time: clip.sourceStart + Math.round(next * fps) / fps })
                      }
                    />
                    <NumberField
                      label="Value"
                      ariaLabel={`${label} keyframe value ${frame.time}`}
                      value={frame.value}
                      min={parameter.min}
                      max={parameter.max}
                      step={parameter.step}
                      onCommit={(next) => changeFrame({ value: next })}
                    />
                  </div>
                )}
                <select
                  aria-label={`${label} keyframe easing ${frame.time}`}
                  className={inputClass}
                  value={frame.easing}
                  onChange={(event) =>
                    changeFrame({ easing: event.target.value as typeof frame.easing })
                  }
                >
                  {easings.map((easing) => (
                    <option key={easing} value={easing}>
                      {easing}
                    </option>
                  ))}
                </select>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={retained}
                    aria-label={`Seek to ${label} keyframe ${frame.time}`}
                    onClick={() =>
                      useTimelineStore
                        .getState()
                        .seek(clip.timelineStart + Math.min(local, Math.max(0, duration - 1 / fps)))
                    }
                  >
                    Seek
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Delete ${label} keyframe ${frame.time}`}
                    onClick={() =>
                      changeEffect(clip.id, effect.id, (item) => {
                        const current = item.animations.find(
                          (entry) => entry.property === parameter.key,
                        );
                        if (!current) return;
                        current.keyframes = current.keyframes.filter(
                          (entry) => entry.time !== frame.time,
                        );
                        if (!current.keyframes.length) {
                          item.params[parameter.key] = value;
                          item.animations = item.animations.filter((entry) => entry !== current);
                        }
                      })
                    }
                  >
                    Delete
                  </Button>
                </div>
              </div>
            );
          })}
        </details>
      )}
    </div>
  );
}

function NumberField({
  label,
  ariaLabel,
  value,
  min,
  max,
  step,
  disabled,
  onCommit,
}: {
  label: string;
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onCommit: (value: number) => boolean;
}) {
  return (
    <label className="block text-[11px] text-slate-400">
      {label}
      <input
        key={value}
        aria-label={ariaLabel}
        type="number"
        className={inputClass}
        defaultValue={Number(value.toFixed(6))}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onFocus={() => useTimelineStore.setState({ playing: false })}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        onBlur={(event) => {
          const next = event.target.valueAsNumber;
          if (!Number.isFinite(next) || next < min || next > max) {
            event.target.value = String(Number(value.toFixed(6)));
            useTimelineStore.setState({ error: `${label} must be between ${min} and ${max}.` });
          } else if (next !== Number(value.toFixed(6)) && !onCommit(next))
            event.target.value = String(Number(value.toFixed(6)));
        }}
      />
    </label>
  );
}
