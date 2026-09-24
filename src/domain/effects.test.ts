import { describe, expect, it } from "vitest";
import {
  createEffect,
  EFFECT_DEFINITIONS,
  effectStackSchema,
  effectTypes,
  evaluateEffects,
  type ClipEffect,
} from "./effects";

describe("clip effect validation", () => {
  it("accepts defaults and parameter boundaries for every effect", () => {
    for (const type of effectTypes) {
      const effect = createEffect(type, 5, 2);
      expect(effectStackSchema.parse([effect])).toEqual([effect]);
      for (const parameter of EFFECT_DEFINITIONS[type].parameters) {
        for (const value of [parameter.min, parameter.max]) {
          effect.params[parameter.key] = value;
          expect(effectStackSchema.safeParse([effect]).success).toBe(true);
        }
        for (const value of [
          parameter.min - parameter.step,
          parameter.max + parameter.step,
          NaN,
          Infinity,
        ]) {
          effect.params[parameter.key] = value;
          expect(effectStackSchema.safeParse([effect]).success).toBe(false);
        }
        effect.params[parameter.key] = parameter.defaultValue;
      }
    }
  });

  it("requires exactly the parameters defined for the effect type", () => {
    const effect = createEffect("zoom");
    delete effect.params.centerX;
    expect(effectStackSchema.safeParse([effect]).success).toBe(false);
    effect.params.centerX = 50;
    effect.params.radius = 10;
    expect(effectStackSchema.safeParse([effect]).success).toBe(false);
    expect(effectStackSchema.safeParse([{ ...effect, type: "unknown" }]).success).toBe(false);
  });

  it("bounds the stack and effect IDs while allowing multiple instances of an effect", () => {
    const stack = Array.from({ length: 16 }, () => createEffect("blur"));
    expect(effectStackSchema.safeParse(stack).success).toBe(true);
    expect(effectStackSchema.safeParse([...stack, createEffect("blur")]).success).toBe(false);
    expect(effectStackSchema.safeParse([stack[0], stack[0]]).success).toBe(false);
    expect(effectStackSchema.safeParse([{ ...stack[0], id: "" }]).success).toBe(false);
    expect(effectStackSchema.safeParse([{ ...stack[0], id: "a".repeat(129) }]).success).toBe(false);
  });

  it("requires unique known animations and bounded, ordered source keyframes", () => {
    const effect = createEffect("punchZoom", 5, 2);
    const valid = structuredClone(effect.animations[0]);
    const reject = (animations: ClipEffect["animations"]) =>
      expect(effectStackSchema.safeParse([{ ...effect, animations }]).success).toBe(false);
    reject([valid, valid]);
    reject([{ ...valid, property: "radius" }]);
    reject([{ ...valid, keyframes: [] }]);
    reject([
      {
        ...valid,
        keyframes: Array.from({ length: 101 }, (_, time) => ({ time, value: 1, easing: "linear" })),
      },
    ]);
    reject([{ ...valid, keyframes: [{ time: 0, value: 5, easing: "linear" }] }]);
    reject([{ ...valid, keyframes: [{ time: -1, value: 1, easing: "linear" }] }]);
    reject([{ ...valid, keyframes: [{ time: Infinity, value: 1, easing: "linear" }] }]);
    reject([{ ...valid, keyframes: [{ time: 0, value: NaN, easing: "linear" }] }]);
    reject([{ ...valid, keyframes: [valid.keyframes[0], valid.keyframes[0]] }]);
    reject([{ ...valid, keyframes: [...valid.keyframes].reverse() }]);
    expect(
      effectStackSchema.safeParse([
        {
          ...effect,
          animations: [
            { property: "scale", keyframes: [{ time: 0, value: 1, easing: "unknown" }] },
          ],
        },
      ]).success,
    ).toBe(false);
  });
});

describe("source-time effect evaluation", () => {
  it.each([
    ["linear", 1.25],
    ["ease-in", 1.0625],
    ["ease-out", 1.4375],
    ["ease-in-out", 1.125],
  ] as const)("interpolates %s using the destination keyframe easing", (easing, expected) => {
    const effect = createEffect("zoom");
    effect.animations = [
      {
        property: "scale",
        keyframes: [
          { time: 5, value: 1, easing: "linear" },
          { time: 9, value: 2, easing },
        ],
      },
    ];
    expect(evaluateEffects([effect], 6)[0].params.scale).toBeCloseTo(expected);
    expect(evaluateEffects([effect], 0)[0].params.scale).toBe(1);
    expect(evaluateEffects([effect], 9)[0].params.scale).toBe(2);
    expect(evaluateEffects([effect], 20)[0].params.scale).toBe(2);
  });

  it("preserves stack order, skips disabled effects, and leaves saved parameters unchanged", () => {
    const punch = createEffect("punchZoom", 5);
    const disabled = { ...createEffect("color"), enabled: false };
    const vignette = createEffect("vignette");
    const stack = [punch, disabled, vignette];
    const before = structuredClone(stack);
    const evaluated = evaluateEffects(stack, 5.12);
    expect(evaluated.map((effect) => effect.id)).toEqual([punch.id, vignette.id]);
    expect(evaluated[0].params.scale).toBeCloseTo(1.2);
    evaluated[0].params.scale = 3;
    expect(stack).toEqual(before);
  });

  it("anchors Punch Zoom to source start and returns to neutral within 0.6 seconds", () => {
    const effect = createEffect("punchZoom", 7, 5);
    const frames = effect.animations[0].keyframes;
    expect(frames.map((frame) => frame.time)).toEqual([7, 7.12, 7.39, 7.6]);
    expect(evaluateEffects([effect], 7)[0].params.scale).toBe(1);
    expect(evaluateEffects([effect], 7.12)[0].params.scale).toBeCloseTo(1.2);
    expect(evaluateEffects([effect], 7.3)[0].params.scale).toBeCloseTo(1.2);
    expect(evaluateEffects([effect], 7.6)[0].params.scale).toBe(1);
  });

  it("keeps short-clip Punch Zoom curves ordered and inside the source range", () => {
    for (const sourceStart of [0, 5, 100000]) {
      for (const duration of [1 / 240, 1 / 30, 0.1, 1e-12, Number.MIN_VALUE]) {
        const effect = createEffect("punchZoom", sourceStart, duration);
        expect(effectStackSchema.safeParse([effect]).success).toBe(true);
        const frames = effect.animations[0].keyframes;
        expect(frames[0].time).toBe(sourceStart);
        expect(frames.at(-1)!.time).toBeLessThanOrEqual(sourceStart + duration);
      }
    }
    for (const [start, duration] of [
      [-1, 1],
      [0, 0],
      [0, Infinity],
      [NaN, 1],
    ])
      expect(() => createEffect("punchZoom", start, duration)).toThrow("finite");
  });
});
