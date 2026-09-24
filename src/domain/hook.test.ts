import { describe, expect, it } from "vitest";

import {
  createHookLayer,
  createPopAnimations,
  evaluateHookLayer,
  evaluateKeyframes,
  hookSchema,
  templateHook,
} from "./hook";

describe("hook animation", () => {
  it("interpolates keyframes with easing", () => {
    const keyframes = [
      { time: 0, value: 0, easing: "linear" as const },
      { time: 1, value: 100, easing: "ease-in" as const },
    ];
    expect(evaluateKeyframes(keyframes, -1, 50)).toBe(0);
    expect(evaluateKeyframes(keyframes, 0.5, 50)).toBe(25);
    expect(evaluateKeyframes(keyframes, 2, 50)).toBe(100);
  });

  it("creates an editable hook template with animated layers", () => {
    const hook = templateHook("bold-question");
    expect(hook.layers).toHaveLength(2);
    expect(hook.layers[0].animations[0]?.keyframes.length).toBeGreaterThan(1);
    expect(hookSchema.safeParse(hook).success).toBe(true);
  });

  it("starts a pop entrance when a delayed hook layer becomes visible", () => {
    const layer = createHookLayer("secondary");
    layer.start = 0.8;
    layer.animations = createPopAnimations(layer.start);
    expect(evaluateHookLayer(layer, layer.start).scale).toBe(0.85);
    expect(evaluateHookLayer(layer, layer.start + 0.15).scale).toBe(1.05);
    expect(evaluateHookLayer(layer, layer.start + 0.3).scale).toBe(1);
    expect(createPopAnimations()[0].keyframes[0].time).toBe(0);
  });
});
