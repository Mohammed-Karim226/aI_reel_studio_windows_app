import { describe, expect, it } from "vitest";

import { formatBytes, formatDuration, formatPercent } from "./format";

describe("formatDuration", () => {
  it("formats minutes and seconds", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(3600)).toBe("1:00:00");
    expect(formatDuration(3725)).toBe("1:02:05");
  });

  it("does not produce negative or NaN output", () => {
    expect(formatDuration(-5)).toBe("0:00");
    expect(formatDuration(Number.NaN)).toBe("0:00");
  });
});

describe("formatBytes", () => {
  it("scales units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(4 * 1024 ** 3)).toBe("4.0 GB");
  });
});

describe("formatPercent", () => {
  it("clamps to the unit range", () => {
    expect(formatPercent(0.5)).toBe("50%");
    expect(formatPercent(-1)).toBe("0%");
    expect(formatPercent(3)).toBe("100%");
  });
});
