import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { fakeInstructionsPrompt, makeFakeRuntime } from "../src/fake.ts";

describe("fake runtime", () => {
  it("starts a session, streams deltas and completes with the full text", async () => {
    const events = await makeFakeRuntime()
      .sendPrompt({
        prompt: "hi there",
        sessionId: null,
        instructions: "",
        instructionsChanged: false,
        model: null,
        effort: null,
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

  it("keeps a resumed session's first instructions unless the turn carries changed ones", async () => {
    const fake = makeFakeRuntime();
    const ask = (sessionId: string | null, instructions: string, instructionsChanged = false) =>
      fake
        .sendPrompt({
          prompt: fakeInstructionsPrompt,
          sessionId,
          instructions,
          instructionsChanged,
          model: null,
          effort: null,
        })
        .pipe(Stream.runCollect, Effect.runPromise)
        .then(
          (events) => Array.from(events).flatMap((e) => (e._tag === "Completed" ? [[e.sessionId, e.text]] : []))[0],
        );
    const [session, first] = (await ask(null, "Be brief.")) ?? [];
    expect(first).toBe("Be brief.");
    expect(await ask(session ?? null, "Be thorough.")).toEqual([session, "Be brief."]);
    expect(await ask(session ?? null, "Be thorough.", true)).toEqual([session, "Be thorough."]);
    expect(await ask(session ?? null, "Be thorough.")).toEqual([session, "Be thorough."]);
  });
});
