import { z } from "zod";
import { evaluateKeyframes, keyframeSchema } from "@/domain/hook";

export const effectTypes = [
  "zoom",
  "punchZoom",
  "blur",
  "color",
  "glow",
  "sharpen",
  "vignette",
] as const;
export type EffectType = (typeof effectTypes)[number];

export interface EffectParameterDefinition {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
}

const zoomParameters: EffectParameterDefinition[] = [
  { key: "scale", label: "Scale", min: 1, max: 4, step: 0.01, defaultValue: 1.15 },
  { key: "centerX", label: "Center X", min: 0, max: 100, step: 1, defaultValue: 50 },
  { key: "centerY", label: "Center Y", min: 0, max: 100, step: 1, defaultValue: 50 },
];

export const EFFECT_DEFINITIONS: Record<
  EffectType,
  { label: string; description: string; parameters: EffectParameterDefinition[] }
> = {
  zoom: {
    label: "Zoom",
    description: "Enlarge the picture around a chosen center.",
    parameters: zoomParameters,
  },
  punchZoom: {
    label: "Punch Zoom",
    description: "Quickly zoom in, hold, and return at the start of the clip.",
    parameters: zoomParameters.map((parameter) => ({
      ...parameter,
      defaultValue: parameter.key === "scale" ? 1 : parameter.defaultValue,
    })),
  },
  blur: {
    label: "Blur",
    description: "Soften detail across the picture.",
    parameters: [{ key: "radius", label: "Radius", min: 0, max: 40, step: 0.5, defaultValue: 6 }],
  },
  color: {
    label: "Color Correction",
    description: "Adjust brightness, contrast, saturation, and color balance.",
    parameters: [
      { key: "brightness", label: "Brightness", min: 0, max: 2, step: 0.01, defaultValue: 1 },
      { key: "contrast", label: "Contrast", min: 0, max: 2, step: 0.01, defaultValue: 1 },
      { key: "saturation", label: "Saturation", min: 0, max: 2, step: 0.01, defaultValue: 1 },
      { key: "temperature", label: "Temperature", min: -1, max: 1, step: 0.01, defaultValue: 0 },
      { key: "tint", label: "Tint", min: -1, max: 1, step: 0.01, defaultValue: 0 },
    ],
  },
  glow: {
    label: "Glow",
    description: "Blend a soft glow over the picture.",
    parameters: [
      { key: "radius", label: "Radius", min: 0, max: 40, step: 0.5, defaultValue: 12 },
      { key: "intensity", label: "Intensity", min: 0, max: 2, step: 0.01, defaultValue: 0.35 },
    ],
  },
  sharpen: {
    label: "Sharpen",
    description: "Increase definition around edges.",
    parameters: [{ key: "amount", label: "Amount", min: 0, max: 2, step: 0.01, defaultValue: 0.5 }],
  },
  vignette: {
    label: "Vignette",
    description: "Darken the edges to draw attention toward the center.",
    parameters: [
      { key: "amount", label: "Amount", min: 0, max: 1, step: 0.01, defaultValue: 0.4 },
      { key: "radius", label: "Radius", min: 0.1, max: 1, step: 0.01, defaultValue: 0.65 },
      { key: "softness", label: "Softness", min: 0.01, max: 1, step: 0.01, defaultValue: 0.5 },
    ],
  },
};

const effectSchema = z
  .object({
    id: z.string().min(1).max(128),
    type: z.enum(effectTypes),
    enabled: z.boolean(),
    params: z.record(z.string(), z.number().finite()),
    animations: z.array(
      z.object({
        property: z.string(),
        keyframes: z.array(keyframeSchema).min(1).max(100),
      }),
    ),
  })
  .superRefine((effect, ctx) => {
    const parameters = EFFECT_DEFINITIONS[effect.type].parameters;
    if (
      Object.keys(effect.params).length !== parameters.length ||
      parameters.some(
        (parameter) => !Object.prototype.hasOwnProperty.call(effect.params, parameter.key),
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Effect parameters must contain exactly the known keys",
      });
    }
    for (const parameter of parameters) {
      const value = effect.params[parameter.key];
      if (value < parameter.min || value > parameter.max) {
        ctx.addIssue({
          code: "custom",
          message: `${parameter.label} must be between ${parameter.min} and ${parameter.max}`,
          path: ["params", parameter.key],
        });
      }
    }
    if (effect.animations.length > parameters.length) {
      ctx.addIssue({ code: "custom", message: "An effect can animate each parameter only once" });
    }
    const properties = new Set<string>();
    for (const [index, animation] of effect.animations.entries()) {
      const parameter = parameters.find((item) => item.key === animation.property);
      if (!parameter || properties.has(animation.property)) {
        ctx.addIssue({
          code: "custom",
          message: "Effect animations must have unique known parameter names",
          path: ["animations", index, "property"],
        });
      }
      properties.add(animation.property);
      for (const [frameIndex, frame] of animation.keyframes.entries()) {
        if (parameter && (frame.value < parameter.min || frame.value > parameter.max)) {
          ctx.addIssue({
            code: "custom",
            message: `${parameter.label} keyframes must be between ${parameter.min} and ${parameter.max}`,
            path: ["animations", index, "keyframes", frameIndex, "value"],
          });
        }
        if (frameIndex > 0 && frame.time <= animation.keyframes[frameIndex - 1].time) {
          ctx.addIssue({
            code: "custom",
            message: "Effect keyframes must have strictly increasing source times",
            path: ["animations", index, "keyframes", frameIndex, "time"],
          });
        }
      }
    }
  });

export type ClipEffect = z.infer<typeof effectSchema>;

export const effectStackSchema = z
  .array(effectSchema)
  .max(16)
  .superRefine((effects, ctx) => {
    if (new Set(effects.map((effect) => effect.id)).size !== effects.length) {
      ctx.addIssue({ code: "custom", message: "Duplicate effect ID in a clip" });
    }
  });

/** Animation times belong to the source media, so clip edits do not restart a curve. */
export function createEffect(type: EffectType, sourceStart = 0, duration = 1): ClipEffect {
  if (
    !Number.isFinite(sourceStart) ||
    sourceStart < 0 ||
    !Number.isFinite(duration) ||
    duration <= 0
  )
    throw new Error("An effect needs a finite source start and a positive duration");
  const effect: ClipEffect = {
    id: crypto.randomUUID(),
    type,
    enabled: true,
    params: Object.fromEntries(
      EFFECT_DEFINITIONS[type].parameters.map((parameter) => [
        parameter.key,
        parameter.defaultValue,
      ]),
    ),
    animations: [],
  };
  if (type === "punchZoom") {
    const span = Math.min(duration, 0.6);
    const keyframes: ClipEffect["animations"][number]["keyframes"] = [];
    for (const [fraction, value, easing] of [
      [0, 1, "linear"],
      [0.2, 1.2, "ease-out"],
      [0.65, 1.2, "linear"],
      [1, 1, "ease-in-out"],
    ] as const) {
      const time = sourceStart + fraction * span;
      // Extremely small ranges can collapse to the same floating-point time.
      if (!keyframes.length || time > keyframes[keyframes.length - 1].time)
        keyframes.push({ time, value, easing });
    }
    effect.animations = [{ property: "scale", keyframes }];
  }
  return effect;
}

export interface EvaluatedEffect {
  id: string;
  type: EffectType;
  params: Record<string, number>;
}

export function evaluateEffects(effects: ClipEffect[], sourceSeconds: number): EvaluatedEffect[] {
  return effects
    .filter((effect) => effect.enabled)
    .map((effect) => {
      const params = { ...effect.params };
      for (const animation of effect.animations)
        params[animation.property] = evaluateKeyframes(
          animation.keyframes,
          sourceSeconds,
          params[animation.property],
        );
      return { id: effect.id, type: effect.type, params };
    });
}
