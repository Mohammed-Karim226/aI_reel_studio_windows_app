import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { errorMessage } from "@/domain/errors";
import { useTranscriptionStore } from "@/stores/transcriptionStore";
import { FfmpegSetupCard } from "@/features/system/FfmpegSetupCard";
import { Button } from "@/shared/ui/Button";
import { openTranscriptionSetupFolder } from "@/infrastructure/tauri/captions";

const inputClass =
  "mt-1 w-full min-w-0 rounded bg-slate-800 p-2 text-slate-200 disabled:opacity-50";

export function TranscriptionSetupPanel() {
  const state = useTranscriptionStore();
  const load = state.load;
  const [dialogError, setDialogError] = useState<string | null>(null);
  const busy = state.loading || state.checking;
  useEffect(() => {
    void load();
  }, [load]);

  async function browse(kind: "pythonPath" | "modelPath") {
    setDialogError(null);
    try {
      const chosen = await open(
        kind === "modelPath"
          ? { directory: true, multiple: false, title: "Choose local speech model folder" }
          : {
              multiple: false,
              title: "Choose Python executable",
              filters: [{ name: "Python executable", extensions: ["exe"] }],
            },
      );
      if (typeof chosen === "string") state.update({ [kind]: chosen });
    } catch (error) {
      setDialogError(errorMessage(error));
    }
  }

  return (
    <div className="mt-3 space-y-2" aria-label="Speech setup">
      <p className="text-[11px] text-slate-400">
        Speech recognition runs on this computer. Choose your local speech engine and model, then
        check they are ready.
      </p>
      <fieldset disabled={busy} className="min-w-0 space-y-2">
        <label className="block">
          Python executable
          <input
            aria-label="Transcription Python executable"
            className={inputClass}
            value={state.setup.pythonPath}
            onChange={(event) => state.update({ pythonPath: event.target.value })}
          />
        </label>
        <Button size="sm" onClick={() => void browse("pythonPath")}>
          Browse Python executable
        </Button>
        <label className="block">
          Local model folder
          <input
            aria-label="Transcription model folder"
            className={inputClass}
            value={state.setup.modelPath}
            onChange={(event) => state.update({ modelPath: event.target.value })}
            placeholder="Choose a multilingual model for Arabic"
          />
        </label>
        <Button size="sm" onClick={() => void browse("modelPath")}>
          Browse model folder
        </Button>
        <label className="block">
          Language
          <select
            aria-label="Transcription language"
            className={inputClass}
            value={state.setup.language}
            onChange={(event) =>
              state.update({ language: event.target.value as typeof state.setup.language })
            }
          >
            <option value="auto">Auto detect</option>
            <option value="en">English</option>
            <option value="ar">Arabic</option>
          </select>
        </label>
      </fieldset>
      <Button size="sm" disabled={busy} onClick={() => void state.saveAndCheck()}>
        {state.loading
          ? "Loading speech settings…"
          : state.checking
            ? "Checking speech setup…"
            : "Save and check setup"}
      </Button>
      {state.readiness && (
        <div
          role="status"
          className={`rounded p-2 text-[11px] ${state.readiness.ready ? "bg-emerald-950/60 text-emerald-200" : "bg-amber-950/50 text-amber-200"}`}
        >
          <p className="font-medium">
            {state.readiness.ready
              ? "Ready for local transcription"
              : "Speech setup needs attention"}
          </p>
          {state.readiness.ready && (
            <p className="mt-1">
              {state.readiness.multilingual ? "Multilingual model" : "English-only model"} · FFmpeg
              ready
            </p>
          )}
          {state.readiness.issues.length > 0 && (
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {state.readiness.issues.map((issue, index) => (
                <li key={index}>{issue}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {(state.error || dialogError) && (
        <p role="alert" className="text-[11px] text-rose-300">
          {dialogError ?? state.error}
        </p>
      )}
      {state.readiness && !state.readiness.ffmpegReady && <FfmpegSetupCard />}
      <details className="text-[11px] text-slate-500">
        <summary className="cursor-pointer text-slate-400">First-time setup</summary>
        <p className="mt-2">
          Use Python 3.9 or newer with faster-whisper installed in its environment. Choose a local
          CTranslate2 Whisper model containing model.bin, config.json, and tokenizer.json. Arabic
          requires a multilingual model.
        </p>
        <p className="mt-2">
          A setup helper and guide are included with the app. Run the helper to prepare a local
          speech engine and download a model, or use your existing offline installation. Checking
          setup does not install or download anything.
        </p>
        <Button
          className="mt-2"
          size="sm"
          onClick={() => {
            setDialogError(null);
            void openTranscriptionSetupFolder().catch((error: unknown) =>
              setDialogError(errorMessage(error)),
            );
          }}
        >
          Open setup folder
        </Button>
        {state.readiness?.pythonVersion && (
          <p className="mt-2">
            Python {state.readiness.pythonVersion} · faster-whisper{" "}
            {state.readiness.providerVersion ?? "unavailable"}
          </p>
        )}
      </details>
    </div>
  );
}
