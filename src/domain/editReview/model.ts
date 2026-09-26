import { z } from "zod";

const time = z.number().finite().nonnegative();

export const hookReviewTextSchema = z
  .string()
  .trim()
  .max(160, "Keep the opening hook within 160 characters.")
  .refine((text) => new TextEncoder().encode(text).length <= 500, {
    message: "The opening hook exceeds the project's text size limit.",
  });

const captionPatchSchema = z
  .strictObject({
    fontSize: z.number().finite().min(10).max(200).optional(),
    animation: z.enum(["none", "fade", "pop"]).optional(),
    highlighting: z.enum(["none", "word", "karaoke"]).optional(),
    x: z.number().finite().min(0).max(100).optional(),
    y: z.number().finite().min(0).max(100).optional(),
    maxWidth: z.number().finite().min(10).max(100).optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "A caption recommendation must change a style setting.",
  });

export const reviewActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("openingHook"), text: hookReviewTextSchema }),
  z.strictObject({ type: z.literal("captionStyle"), patch: captionPatchSchema }),
  z.strictObject({
    type: z.literal("addZoom"),
    clipId: z.string().min(1).max(128),
    at: time,
    duration: z.number().finite().min(0.2).max(3),
  }),
]);

/** Review plans contain only supported edit data; arbitrary commands are rejected. */
export const reviewSuggestionSchema = z
  .strictObject({
    id: z.string().min(1).max(256),
    category: z.enum(["hook", "pacing", "captions", "zoom", "weakSection", "safeZone"]),
    title: z.string().trim().min(1).max(200),
    explanation: z.string().trim().min(1).max(2000),
    start: time,
    end: time,
    action: reviewActionSchema.nullable(),
  })
  .superRefine((suggestion, context) => {
    if (suggestion.end <= suggestion.start)
      context.addIssue({ code: "custom", message: "Review ranges must have positive duration." });
    const action = suggestion.action;
    if (!action) return;
    const matches =
      (action.type === "openingHook" && suggestion.category === "hook") ||
      (action.type === "captionStyle" &&
        (suggestion.category === "captions" || suggestion.category === "safeZone")) ||
      (action.type === "addZoom" && suggestion.category === "zoom");
    if (!matches)
      context.addIssue({
        code: "custom",
        message: "The action does not match the review category.",
      });
    if (
      action.type === "addZoom" &&
      (action.at < suggestion.start || action.at + action.duration > suggestion.end + 0.00001)
    )
      context.addIssue({ code: "custom", message: "The zoom must stay inside its review range." });
  });

export type ReviewSuggestion = z.infer<typeof reviewSuggestionSchema>;
export type ReviewAction = z.infer<typeof reviewActionSchema>;
