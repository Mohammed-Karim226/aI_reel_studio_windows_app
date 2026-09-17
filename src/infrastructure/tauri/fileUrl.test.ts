import { describe, expect, it } from "vitest";

import { joinPath } from "./fileUrl";

describe("joinPath", () => {
  it("joins with the root's separator", () => {
    expect(joinPath("D:\\projects\\reel", "proxies/m1.mp4")).toBe(
      "D:\\projects\\reel\\proxies\\m1.mp4",
    );
    expect(joinPath("/home/user/reel", "thumbnails/m1.jpg")).toBe(
      "/home/user/reel/thumbnails/m1.jpg",
    );
  });

  it("tolerates trailing and leading separators", () => {
    expect(joinPath("D:\\projects\\reel\\", "/proxies/m1.mp4")).toBe(
      "D:\\projects\\reel\\proxies\\m1.mp4",
    );
  });

  it("keeps nested relative directories intact", () => {
    expect(joinPath("D:\\p", "captions/m1.waveform.json")).toBe(
      "D:\\p\\captions\\m1.waveform.json",
    );
  });
});
