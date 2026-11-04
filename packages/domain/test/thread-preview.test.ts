import { describe, expect, it } from "vitest";
import { messagePreview, PREVIEW_LENGTH, previewLine } from "../src/thread.ts";

describe("previewLine", () => {
  it("collapses a message into one line", () => {
    expect(previewLine("  Done.\n\nThe copy is in\tdocs/launch.md ")).toBe("Done. The copy is in docs/launch.md");
  });

  it("cuts a long message with an ellipsis", () => {
    const line = previewLine("word ".repeat(60));
    expect(line).toHaveLength(PREVIEW_LENGTH);
    expect(line?.endsWith("word…")).toBe(true);
  });

  it("has no line for a message with no text", () => expect(previewLine(" \n ")).toBeNull());
});

describe("messagePreview", () => {
  it("skips a queued message, which the transcript does not show yet", () => {
    expect(messagePreview({ content: "Next, the email", status: "queued" })).toBeNull();
    expect(messagePreview({ content: "Next, the email", status: "streaming" })).toBe("Next, the email");
  });
});
