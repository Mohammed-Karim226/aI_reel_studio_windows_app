import { transcriptSchema, type Transcript } from "@/domain/captions";
import { z } from "zod";
import {
  transcriptionSetupSchema,
  transcriptionReadinessSchema,
  type TranscriptionSetup,
  type TranscriptionReadiness,
} from "@/domain/transcriptionSetup";
import { invokeCommand } from "./invoke";

export interface TranscribeMediaOptions {
  projectId: string;
  mediaId: string;
  sourceStart: number;
  sourceEnd: number;
  pythonPath: string;
  modelPath: string;
  language: "auto" | "en" | "ar";
}

export function transcribeMedia(options: TranscribeMediaOptions): Promise<Transcript> {
  return invokeCommand("transcribe_media", { ...options }, transcriptSchema);
}

export function openTranscriptionSetupFolder(): Promise<null> {
  return invokeCommand("open_transcription_setup_folder", {}, z.null());
}

export function getTranscriptionSetup(): Promise<TranscriptionSetup | null> {
  return invokeCommand("get_transcription_setup", {}, transcriptionSetupSchema.nullable());
}

export function saveTranscriptionSetup(setup: TranscriptionSetup): Promise<TranscriptionSetup> {
  return invokeCommand(
    "save_transcription_setup",
    { setup: transcriptionSetupSchema.parse(setup) },
    transcriptionSetupSchema,
  );
}

export function checkTranscriptionSetup(
  setup: TranscriptionSetup,
): Promise<TranscriptionReadiness> {
  return invokeCommand(
    "check_transcription_setup",
    { setup: transcriptionSetupSchema.parse(setup) },
    transcriptionReadinessSchema,
  );
}
