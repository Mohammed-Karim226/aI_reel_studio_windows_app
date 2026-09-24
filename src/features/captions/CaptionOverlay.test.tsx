import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { defaultCaptions, type CaptionTrack } from "@/domain/captions";
import { CaptionOverlay } from "./CaptionOverlay";

const captions: CaptionTrack = {
  ...defaultCaptions,
  style: { ...defaultCaptions.style, direction: "rtl", highlighting: "word" },
  segments: [
    {
      id: "c1",
      start: 1,
      end: 2,
      words: [
        { text: "Version", start: 1, end: 1.4, emphasis: false },
        { text: "٢", start: 1.4, end: 1.6, emphasis: false },
        { text: "بالعربية؟", start: 1.6, end: 2, emphasis: false },
      ],
    },
  ],
};

describe("CaptionOverlay", () => {
  it("honors forced RTL while preserving the paragraph's natural mixed-script text runs", () => {
    const { rerender } = render(<CaptionOverlay captions={captions} time={1.5} width={1080} />);
    const paragraph = screen.getByLabelText("Caption overlay").firstElementChild;
    expect(paragraph).toHaveAttribute("dir", "rtl");
    expect(paragraph).toHaveStyle({ unicodeBidi: "isolate" });
    expect(screen.getByText("Version")).toHaveAttribute("data-highlighted", "false");
    expect(screen.getByText("٢")).toHaveAttribute("data-highlighted", "true");
    expect(screen.getByText("Version")).not.toHaveAttribute("dir");
    expect(screen.getByText("بالعربية؟")).not.toHaveAttribute("dir");
    expect(paragraph?.textContent).toBe("Version ٢ بالعربية؟");
    rerender(<CaptionOverlay captions={captions} time={2} width={1080} />);
    expect(screen.queryByLabelText("Caption overlay")).not.toBeInTheDocument();
  });

  it("derives animation from playhead scrubbing and lets short captions reach full opacity", () => {
    const short = {
      ...captions,
      style: { ...captions.style, animation: "fade" as const },
      segments: [
        {
          id: "short",
          start: 0,
          end: 0.1,
          words: [{ text: "Hi", start: 0, end: 0.1, emphasis: false }],
        },
      ],
    };
    const { rerender } = render(<CaptionOverlay captions={short} time={0.05} width={1080} />);
    expect(screen.getByLabelText("Caption overlay").firstElementChild).toHaveStyle({
      opacity: "1",
    });
    rerender(<CaptionOverlay captions={short} time={0} width={1080} />);
    expect(screen.getByLabelText("Caption overlay").firstElementChild).toHaveStyle({
      opacity: "0",
    });
  });
});
