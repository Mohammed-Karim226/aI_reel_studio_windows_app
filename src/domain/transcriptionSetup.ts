import { z } from "zod";

const path = z
  .string()
  .refine(
    (value) => new TextEncoder().encode(value).length <= 4096,
    "Paths must be at most 4096 bytes",
  )
  .refine(
    (value) =>
      Array.from(value).every((character) => {
        const code = character.codePointAt(0)!;
        return code >= 32 && (code < 127 || code > 159);
      }),
    "Paths cannot contain control characters",
  )
  .transform((value) => value.trim());

export const transcriptionSetupSchema = z.object({
  pythonPath: path.transform((value) => value || "python"),
  modelPath: path,
  language: z.enum(["auto", "en", "ar"]),
});

export const transcriptionReadinessSchema = z.object({
  ready: z.boolean(),
  pythonVersion: z.string().nullable(),
  providerVersion: z.string().nullable(),
  modelReady: z.boolean(),
  ffmpegReady: z.boolean(),
  multilingual: z.boolean().nullable(),
  issues: z.array(z.string()),
});

export type TranscriptionSetup = z.infer<typeof transcriptionSetupSchema>;
export type TranscriptionReadiness = z.infer<typeof transcriptionReadinessSchema>;
export const defaultTranscriptionSetup: TranscriptionSetup = {
  pythonPath: "python",
  modelPath: "",
  language: "auto",
};
