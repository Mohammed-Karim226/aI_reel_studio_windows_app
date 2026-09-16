import { describe, expect, it } from "vitest";
import { formatAppInfo } from "./appInfo";

describe("formatAppInfo", () => {
  it("formats app name, version and platform", () => {
    expect(formatAppInfo({ name: "AI Reel Studio", version: "0.1.0", platform: "windows" })).toBe(
      "AI Reel Studio v0.1.0 (windows)",
    );
  });
});
