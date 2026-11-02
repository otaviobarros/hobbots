import { RuntimeError, RuntimeLimitReached } from "@hobbots/agents";
import { Effect, Exit, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { FAKE_DIRECTIVES, fakeCutOffError, fakeInstructionsPrompt, makeFakeRuntime } from "../src/fake.ts";

const request = (prompt: string) => ({
  prompt,
  sessionId: null,
  instructions: "",
  instructionsChanged: false,
  model: null,
  effort: null,
});

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

describe("fake runtime's scripted hub calls", () => {
  it("lets a later call, in any session, refer to what an earlier call gave back by its key", async () => {
    const calls: Array<{ readonly name: string; readonly input: unknown }> = [];
    const hubTools = {
      tools: [],
      call: (name: string, input: unknown) =>
        Effect.sync(() => {
          calls.push({ name, input });
          return {
            text: `Done.\n${JSON.stringify({ task_id: `t${calls.length}`, artifacts: ["a1"] })}`,
            refused: false,
          };
        }),
    };
    const fake = makeFakeRuntime();
    const first = [
      `fake:hub delegate_task {"key":"copy","hob":"Quill"}`,
      `fake:hub delegate_task {"key":"build","depends_on":["$copy.task_id"]}`,
    ].join("\n");
    await fake.sendPrompt({ ...request(first), hubTools }).pipe(Stream.runDrain, Effect.runPromise);
    // Another session refers to both, and to a reference that names nothing, which stays as written.
    const second = `fake:hub hand_off {"key":"hand","artifact_id":"$copy.artifacts.0","to_task_id":"$build.task_id","x":"$none.id"}`;
    await fake.sendPrompt({ ...request(second), hubTools }).pipe(Stream.runDrain, Effect.runPromise);
    expect(calls.map((call) => call.input)).toEqual([
      { key: "copy", hob: "Quill" },
      { key: "build", depends_on: ["t1"] },
      { key: "hand", artifact_id: "a1", to_task_id: "t2", x: "$none.id" },
    ]);
  });
});
