import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { makeFakeRuntime } from "../src/fake.ts";

describe("fake runtime", () => {
  it("starts a session, streams deltas and completes with the full text", async () => {
    const events = await makeFakeRuntime()
      .sendPrompt({
        prompt: "hi there",
        sessionId: null,
        instructions: "",
        model: null,
      })
      .pipe(Stream.runCollect, Effect.runPromise);
    const tags = Array.from(events, (e) => e._tag);
    expect(tags[0]).toBe("SessionStarted");
    expect(tags.at(-1)).toBe("Completed");
    const text = Array.from(events)
      .flatMap((e) => (e._tag === "TextDelta" ? [e.text] : []))
      .join("");
    expect(text).toBe("Echo: hi there");
  });
});
