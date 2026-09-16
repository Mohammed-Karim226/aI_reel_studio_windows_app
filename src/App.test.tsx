import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { fetchAppInfo } from "./lib/appInfo";

vi.mock("./lib/appInfo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/appInfo")>();
  return {
    ...actual,
    fetchAppInfo: vi.fn(),
  };
});

const mockedFetchAppInfo = vi.mocked(fetchAppInfo);

describe("App", () => {
  beforeEach(() => {
    mockedFetchAppInfo.mockReset();
  });

  it("shows foundation status when the backend responds", async () => {
    mockedFetchAppInfo.mockResolvedValue({
      name: "AI Reel Studio",
      version: "0.1.0",
      platform: "windows",
    });
    render(<App />);
    const status = await screen.findByTestId("foundation-status");
    expect(status).toHaveTextContent("Foundation verified");
    expect(status).toHaveTextContent("AI Reel Studio v0.1.0 (windows)");
  });

  it("shows an error when the backend is unavailable", async () => {
    mockedFetchAppInfo.mockRejectedValue(new Error("ipc failure"));
    render(<App />);
    expect(await screen.findByTestId("foundation-error")).toBeInTheDocument();
  });
});
