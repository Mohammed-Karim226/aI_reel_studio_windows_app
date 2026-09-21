import { z } from "zod";

const time = z.number().finite().nonnegative();
const easingSchema = z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]);
const transformSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  scale: z.number().positive(),
  rotation: z.number().finite(),
  opacity: z.number().min(0).max(1),
});

export const keyframeSchema = z.object({ time, value: z.number().finite(), easing: easingSchema });
export type Easing = z.infer<typeof easingSchema>;
export type Keyframe = z.infer<typeof keyframeSchema>;

const animationSchema = z.object({
  property: z.enum(["x", "y", "scale", "rotation", "opacity"]),
  keyframes: z.array(keyframeSchema).min(1).max(100),
});

export const hookLayerSchema = z.object({
  id: z.string().min(1).max(128),
  role: z.enum(["main", "secondary"]),
  text: z.string().max(500),
  start: time,
  end: time,
  style: z.object({
    fontSize: z.number().positive(),
    color: z.string().min(1).max(32),
    background: z.string().max(32),
    weight: z.enum(["regular", "bold", "black"]),
    align: z.enum(["left", "center", "right"]),
  }),
  transform: transformSchema,
  animations: z.array(animationSchema).max(10),
}).superRefine((layer, ctx) => {
  if (layer.end <= layer.start) ctx.addIssue({ code: "custom", message: "Hook layer must have a positive duration" });
  for (const animation of layer.animations) {
    if (animation.keyframes.some((frame, index) => index > 0 && frame.time < animation.keyframes[index - 1].time)) {
      ctx.addIssue({ code: "custom", message: "Hook keyframes must be ordered by time" });
    }
  }
});

export const hookSchema = z.object({
  enabled: z.boolean(),
  duration: time,
  background: z.string().min(1).max(32),
  layers: z.array(hookLayerSchema).max(32),
}).superRefine((hook, ctx) => {
  if (hook.layers.some((layer) => layer.end > hook.duration + 0.00001)) {
    ctx.addIssue({ code: "custom", message: "Hook layers cannot exceed the hook duration" });
  }
});

export type HookLayer = z.infer<typeof hookLayerSchema>;
export type HookComposition = z.infer<typeof hookSchema>;
export type HookProperty = keyof HookLayer["transform"];

export const defaultHook: HookComposition = {
  enabled: true,
  duration: 1.5,
  background: "#111827",
  layers: [],
};

export function createHookLayer(role: HookLayer["role"] = "main"): HookLayer {
  return {
    id: crypto.randomUUID(), role, text: role === "main" ? "Your hook text" : "Supporting line", start: 0, end: 1.5,
    style: { fontSize: role === "main" ? 82 : 34, color: role === "main" ? "#ffffff" : "#fbbf24", background: "transparent", weight: role === "main" ? "black" : "bold", align: "center" },
    transform: { x: 0, y: role === "main" ? 0 : 20, scale: 1, rotation: 0, opacity: 1 }, animations: [],
  };
}

export const popAnimations: HookLayer["animations"] = [{
  property: "scale",
  keyframes: [{ time: 0, value: 0.85, easing: "ease-out" }, { time: 0.15, value: 1.05, easing: "ease-out" }, { time: 0.3, value: 1, easing: "linear" }],
}];

export const hookTemplates = [
  { id: "bold-question", category: "Podcast", name: "Bold Question", main: "What nobody tells you", secondary: "The answer changes everything" },
  { id: "strong-claim", category: "Business", name: "Strong Claim", main: "This changes the game", secondary: "Here is why" },
  { id: "curiosity-gap", category: "Educational", name: "Curiosity Gap", main: "Wait until you see this", secondary: "The detail most people miss" },
] as const;

export function templateHook(templateId: string): HookComposition {
  const template = hookTemplates.find((item) => item.id === templateId) ?? hookTemplates[0];
  return hookSchema.parse({
    ...defaultHook,
    layers: [
      {
        id: crypto.randomUUID(), role: "main", text: template.main, start: 0, end: 1.5,
        style: { fontSize: 82, color: "#ffffff", background: "transparent", weight: "black", align: "center" },
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        animations: [{ property: "scale", keyframes: [{ time: 0, value: 0.85, easing: "ease-out" }, { time: 0.15, value: 1.05, easing: "ease-out" }, { time: 0.3, value: 1, easing: "linear" }] }],
      },
      {
        id: crypto.randomUUID(), role: "secondary", text: template.secondary, start: 0.2, end: 1.5,
        style: { fontSize: 34, color: "#fbbf24", background: "transparent", weight: "bold", align: "center" },
        transform: { x: 0, y: 20, scale: 1, rotation: 0, opacity: 1 },
        animations: [{ property: "opacity", keyframes: [{ time: 0.2, value: 0, easing: "linear" }, { time: 0.45, value: 1, easing: "ease-out" }] }],
      },
    ],
  });
}

function ease(progress: number, easing: Easing): number {
  switch (easing) {
    case "ease-in": return progress * progress;
    case "ease-out": return 1 - (1 - progress) * (1 - progress);
    case "ease-in-out": return progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    default: return progress;
  }
}

export function evaluateKeyframes(keyframes: Keyframe[], time: number, fallback: number): number {
  if (!keyframes.length) return fallback;
  const frames = [...keyframes].sort((a, b) => a.time - b.time);
  if (time <= frames[0].time) return frames[0].value;
  const last = frames[frames.length - 1];
  if (time >= last.time) return last.value;
  const nextIndex = frames.findIndex((frame) => frame.time >= time);
  const next = frames[nextIndex];
  const previous = frames[nextIndex - 1];
  const progress = (time - previous.time) / (next.time - previous.time);
  return previous.value + (next.value - previous.value) * ease(progress, next.easing);
}

export function evaluateHookLayer(layer: HookLayer, time: number): HookLayer["transform"] {
  const result = { ...layer.transform };
  for (const animation of layer.animations) result[animation.property] = evaluateKeyframes(animation.keyframes, time, result[animation.property]);
  return result;
}
