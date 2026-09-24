import { create } from "zustand";
import { errorMessage } from "@/domain/errors";
import {
  defaultTranscriptionSetup,
  transcriptionSetupSchema,
  type TranscriptionSetup,
  type TranscriptionReadiness,
} from "@/domain/transcriptionSetup";
import {
  getTranscriptionSetup,
  saveTranscriptionSetup,
  checkTranscriptionSetup,
} from "@/infrastructure/tauri/captions";

const legacyKey = "ai-reel-studio.transcription.v1";

function legacySetup(): TranscriptionSetup | null {
  try {
    const result = transcriptionSetupSchema.safeParse(
      JSON.parse(localStorage.getItem(legacyKey) ?? "null") as unknown,
    );
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

interface TranscriptionState {
  setup: TranscriptionSetup;
  loaded: boolean;
  loading: boolean;
  checking: boolean;
  readiness: TranscriptionReadiness | null;
  error: string | null;
  load: () => Promise<void>;
  update: (patch: Partial<TranscriptionSetup>) => void;
  saveAndCheck: () => Promise<boolean>;
}

/** Machine configuration lives in the native app database, independent of WebView origin. */
export const useTranscriptionStore = create<TranscriptionState>((set, get) => ({
  setup: { ...defaultTranscriptionSetup },
  loaded: false,
  loading: false,
  checking: false,
  readiness: null,
  error: null,
  load: async () => {
    if (get().loaded || get().loading) return;
    set({ loading: true, error: null });
    try {
      let setup = await getTranscriptionSetup();
      if (!setup) {
        const legacy = legacySetup();
        if (legacy) {
          setup = await saveTranscriptionSetup(legacy);
          try {
            localStorage.removeItem(legacyKey);
          } catch {
            /* Native copy was saved. */
          }
        }
      }
      set({ setup: setup ?? { ...defaultTranscriptionSetup }, loaded: true, loading: false });
    } catch (error) {
      // Retain editable defaults so a malformed saved value can be replaced explicitly.
      set({
        loaded: true,
        loading: false,
        error: `Could not load speech settings: ${errorMessage(error)}. Choose your setup and save again.`,
      });
    }
  },
  update: (patch) => {
    if (get().loading || get().checking) return;
    set((state) => ({ setup: { ...state.setup, ...patch }, readiness: null, error: null }));
  },
  saveAndCheck: async () => {
    if (get().loading || get().checking) return false;
    const parsed = transcriptionSetupSchema.safeParse(get().setup);
    if (!parsed.success) {
      set({ error: parsed.error.issues[0]?.message ?? "Check speech settings" });
      return false;
    }
    set({ checking: true, readiness: null, error: null });
    try {
      const setup = await saveTranscriptionSetup(parsed.data);
      set({ setup, loaded: true });
      const readiness = await checkTranscriptionSetup(setup);
      set({ readiness });
      return readiness.ready;
    } catch (error) {
      set({ error: errorMessage(error) });
      return false;
    } finally {
      set({ checking: false });
    }
  },
}));
