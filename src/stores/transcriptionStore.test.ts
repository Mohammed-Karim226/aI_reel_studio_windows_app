import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultTranscriptionSetup,
  type TranscriptionReadiness,
} from "@/domain/transcriptionSetup";

const { getMock, saveMock, checkMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  saveMock: vi.fn(),
  checkMock: vi.fn(),
}));
vi.mock("@/infrastructure/tauri/captions", () => ({
  getTranscriptionSetup: getMock,
  saveTranscriptionSetup: saveMock,
  checkTranscriptionSetup: checkMock,
}));
import { useTranscriptionStore } from "./transcriptionStore";

const setup = {
  pythonPath: "C:\\speech\\python.exe",
  modelPath: "C:\\models\\small",
  language: "ar" as const,
};
const ready: TranscriptionReadiness = {
  ready: true,
  pythonVersion: "3.13.1",
  providerVersion: "1.2.1",
  modelReady: true,
  ffmpegReady: true,
  multilingual: true,
  issues: [],
};
const legacyKey = "ai-reel-studio.transcription.v1";

beforeEach(() => {
  localStorage.clear();
  getMock.mockReset().mockResolvedValue(null);
  saveMock.mockReset().mockImplementation(async (value) => value);
  checkMock.mockReset().mockResolvedValue(ready);
  useTranscriptionStore.setState({
    setup: { ...defaultTranscriptionSetup },
    loaded: false,
    loading: false,
    checking: false,
    readiness: null,
    error: null,
  });
});

describe("native speech settings", () => {
  it("prefers the native app database over stale WebView configuration", async () => {
    localStorage.setItem(legacyKey, JSON.stringify({ ...setup, language: "en" }));
    getMock.mockResolvedValue(setup);
    await useTranscriptionStore.getState().load();
    expect(useTranscriptionStore.getState().setup).toEqual(setup);
    expect(saveMock).not.toHaveBeenCalled();
    expect(useTranscriptionStore.getState().readiness).toBeNull();
  });

  it("migrates old settings only after successfully saving a native copy", async () => {
    localStorage.setItem(legacyKey, JSON.stringify(setup));
    await useTranscriptionStore.getState().load();
    expect(saveMock).toHaveBeenCalledWith(setup);
    expect(useTranscriptionStore.getState().setup).toEqual(setup);
    expect(localStorage.getItem(legacyKey)).toBeNull();
    await useTranscriptionStore.getState().load();
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it("retains the legacy copy after migration failure and lets the user repair native settings", async () => {
    localStorage.setItem(legacyKey, JSON.stringify(setup));
    saveMock.mockRejectedValueOnce(new Error("Database is read-only"));
    await useTranscriptionStore.getState().load();
    expect(localStorage.getItem(legacyKey)).not.toBeNull();
    expect(useTranscriptionStore.getState().error).toContain("read-only");
    useTranscriptionStore.getState().update(setup);
    expect(await useTranscriptionStore.getState().saveAndCheck()).toBe(true);
    expect(useTranscriptionStore.getState().readiness).toEqual(ready);
  });

  it("prevents concurrent edits/checks while testing and invalidates readiness on a later change", async () => {
    let resolve!: (value: TranscriptionReadiness) => void;
    checkMock.mockImplementation(
      () =>
        new Promise<TranscriptionReadiness>((done) => {
          resolve = done;
        }),
    );
    useTranscriptionStore.getState().update(setup);
    const pending = useTranscriptionStore.getState().saveAndCheck();
    await vi.waitFor(() => expect(checkMock).toHaveBeenCalled());
    useTranscriptionStore.getState().update({ language: "en" });
    expect(useTranscriptionStore.getState().setup.language).toBe("ar");
    expect(await useTranscriptionStore.getState().saveAndCheck()).toBe(false);
    resolve(ready);
    expect(await pending).toBe(true);
    useTranscriptionStore.getState().update({ modelPath: "C:\\other" });
    expect(useTranscriptionStore.getState().readiness).toBeNull();
    expect(checkMock).toHaveBeenCalledTimes(1);
  });

  it("reports missing dependencies without permitting generation and never checks unsaved settings", async () => {
    useTranscriptionStore.getState().update(setup);
    saveMock.mockRejectedValueOnce(new Error("Settings could not be written"));
    expect(await useTranscriptionStore.getState().saveAndCheck()).toBe(false);
    expect(checkMock).not.toHaveBeenCalled();
    checkMock.mockResolvedValue({
      ...ready,
      ready: false,
      modelReady: false,
      issues: ["Choose a complete local model"],
    });
    expect(await useTranscriptionStore.getState().saveAndCheck()).toBe(false);
    expect(useTranscriptionStore.getState().readiness?.issues).toEqual([
      "Choose a complete local model",
    ]);
    expect(useTranscriptionStore.getState().checking).toBe(false);
  });
});
