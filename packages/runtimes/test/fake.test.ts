import { Effect, Exit, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { RuntimeError, RuntimeLimitReached } from "../src/adapter.ts";
import { FAKE_DIRECTIVES, fakeCutOffError, makeFakeRuntime } from "../src/fake.ts";

const request = (prompt: string) => ({ prompt, sessionId: null, instructions: "", model: null, effort: null });

describe("fake runtime", () => {
  it("starts a session, streams deltas and completes with the full text", async () => {
    const events = await makeFakeRuntime().sendPrompt(request("hi there")).pipe(Stream.runCollect, Effect.runPromise);
    const tags = Array.from(events, (e) => e._tag);
    expect(tags.slice(0, 3)).toEqual(["SessionStarted", "StepStarted", "StepEnded"]);
    expect(tags.at(-1)).toBe("Completed");
    const text = Array.from(events)
      .flatMap((e) => (e._tag === "TextDelta" ? [e.text] : []))
      .join("");
    expect(text).toBe("Echo: hi there");
  });

  it("cuts a reply off after its first words when the prompt asks for it", async () => {
    const exit = await makeFakeRuntime()
      .sendPrompt(request(`${FAKE_DIRECTIVES.cutOff} now`))
      .pipe(Stream.runCollect, Effect.runPromiseExit);
    expect(exit).toStrictEqual(Exit.fail(new RuntimeError({ message: fakeCutOffError })));
  });

  it("reaches the provider limit when the prompt asks for it", async () => {
    const error = await makeFakeRuntime()
      .sendPrompt(request(`${FAKE_DIRECTIVES.limit} now`))
      .pipe(Stream.runCollect, Effect.flip, Effect.runPromise);
    expect(error).toBeInstanceOf(RuntimeLimitReached);
    expect(error._tag === "RuntimeLimitReached" && error.resetsAt).toMatch(/^\d{4}-/);
  });

  it("refuses turns while it reports a brain that is not ready", async () => {
    const runtime = makeFakeRuntime({ availability: "signedOut" });
    expect((await Effect.runPromise(runtime.health)).availability).toBe("signedOut");
    const exit = await runtime.sendPrompt(request("hi")).pipe(Stream.runCollect, Effect.runPromiseExit);
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
