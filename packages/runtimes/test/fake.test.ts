import { notOfferedReason, RuntimeError, RuntimeLimitReached } from "@hobbots/agents";
import { CONTINUATION_HEADER } from "@hobbots/domain";
import { Effect, Exit, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  FAKE_DIRECTIVES,
  FAKE_FAIL_DIRECTIVE,
  FAKE_ONCE_DIRECTIVE,
  fakeCutOffError,
  fakeInstructionsPrompt,
  makeFakeRuntime,
} from "../src/fake.ts";

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

  it("writes nothing in a turn that only carries arrived work when told to stay quiet, and echoes it otherwise", async () => {
    const reply = async (quietContinuations: boolean, prompt: string) => {
      const events = Array.from(
        await makeFakeRuntime({ quietContinuations })
          .sendPrompt(request(prompt))
          .pipe(Stream.runCollect, Effect.runPromise),
      );
      const completed = events.find((e) => e._tag === "Completed");
      return {
        text: completed?._tag === "Completed" ? completed.text : null,
        deltas: events.filter((e) => e._tag === "TextDelta").length,
      };
    };
    const arrived = `${CONTINUATION_HEADER} Work arrived for you while you were not running:`;
    expect(await reply(true, arrived)).toEqual({ text: "", deltas: 0 });
    expect((await reply(false, arrived)).text).toBe(`Echo: ${arrived}`);
    // A turn you started with a message always gets its reply.
    expect((await reply(true, "Plan a Black Friday campaign")).text).toBe("Echo: Plan a Black Friday campaign");
  });

  it("cuts a reply off after its first words when the prompt asks for it", async () => {
    const exit = await makeFakeRuntime()
      .sendPrompt(request(`${FAKE_DIRECTIVES.cutOff} now`))
      .pipe(Stream.runCollect, Effect.runPromiseExit);
    expect(exit).toStrictEqual(Exit.fail(new RuntimeError({ message: fakeCutOffError })));
  });

  it("fails a reply when any line of the prompt asks for it, not only the first", async () => {
    const exit = await makeFakeRuntime()
      .sendPrompt(request(`Write the notes\n  ${FAKE_FAIL_DIRECTIVE}  \nmore`))
      .pipe(Stream.runCollect, Effect.runPromiseExit);
    expect(exit).toStrictEqual(Exit.fail(new RuntimeError({ message: fakeCutOffError })));
    const kept = await makeFakeRuntime()
      .sendPrompt(request(`Write the notes ${FAKE_FAIL_DIRECTIVE}`))
      .pipe(Stream.runCollect, Effect.runPromiseExit);
    expect(Exit.isSuccess(kept)).toBe(true);
  });

  it("runs a once line the first time it sees it, in any session, and drops it after", async () => {
    const fake = makeFakeRuntime();
    const reply = async (prompt: string) =>
      Array.from(await fake.sendPrompt(request(prompt)).pipe(Stream.runCollect, Effect.runPromise)).flatMap((e) =>
        e._tag === "Completed" ? [e.text] : [],
      );
    const prompt = `Tidy\n${FAKE_ONCE_DIRECTIVE} ${FAKE_FAIL_DIRECTIVE}`;
    const first = await fake.sendPrompt(request(prompt)).pipe(Stream.runCollect, Effect.runPromiseExit);
    expect(Exit.isFailure(first)).toBe(true);
    expect(await reply(prompt)).toHaveLength(1);
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
      tools: ["delegate_task", "hand_off"].map((name) => ({ name, description: name, inputSchema: {}, label: name })),
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

  // covers PE-001 (#1356)
  it("[TC-PE-1356-04] refuses a call to a hub tool the turn was not offered, as a runtime does, without the hub", async () => {
    const calls: Array<string> = [];
    const hubTools = {
      tools: [{ name: "read_tasks", description: "Read", inputSchema: {}, label: "Reading" }],
      call: (name: string) =>
        Effect.sync(() => {
          calls.push(name);
          return { text: "Read.", refused: false };
        }),
    };
    const events = await makeFakeRuntime()
      .sendPrompt({ ...request(`fake:hub github_comment {"body":"Hi"}\nfake:hub read_tasks {"key":"r"}`), hubTools })
      .pipe(Stream.runCollect, Effect.runPromise);
    expect(calls).toEqual(["read_tasks"]);
    expect(events.filter((event) => event._tag === "ToolDenied")).toEqual([
      expect.objectContaining({ id: "fake-hub-1", tool: "github_comment", notOffered: { runtimeTool: null } }),
    ]);
    const completed = events.find((event) => event._tag === "Completed");
    expect(completed?._tag === "Completed" ? completed.text : "").toContain(
      "github_comment: github_comment is not offered in this session, so it did not run.",
    );
  });
});

describe("fake runtime's hub tools on a resumed session", () => {
  // Codex keeps the hub tools a thread started with (ADR 024): fake Codex does too, so a test of a
  // resumed lead sees what Codex would (#1543). Fake Claude Code is offered each turn's tools.
  const offering = (names: ReadonlyArray<string>, calls: Array<string>) => ({
    tools: names.map((name) => ({ name, description: name, label: name, inputSchema: {} })),
    call: (name: string) =>
      Effect.sync(() => {
        calls.push(name);
        return { text: `${name} ran.`, refused: false };
      }),
  });
  const turn = async (
    fake: ReturnType<typeof makeFakeRuntime>,
    sessionId: string | null,
    names: ReadonlyArray<string>,
    calls: Array<string>,
  ) => {
    const events = await fake
      .sendPrompt({
        ...request(`fake:hub check_criterion {"key":"accept"}`),
        sessionId,
        hubTools: offering(names, calls),
      })
      .pipe(Stream.runCollect, Effect.runPromise);
    const started = events.find((event) => event._tag === "SessionStarted");
    const completed = events.find((event) => event._tag === "Completed");
    return { started, text: completed?._tag === "Completed" ? completed.text : "" };
  };

  it("[TC-RT-1543-01] fake Codex holds the hub tools its session started with, and refuses a newer one", async () => {
    const fake = makeFakeRuntime({ runtime: "codex" });
    expect(fake.resumeKeepsHubTools).toBe(true);
    const calls: Array<string> = [];
    const first = await turn(fake, null, ["start_quest"], calls);
    // A new session says which hub tools it holds, so the hub can record them.
    expect(first.started).toMatchObject({ _tag: "SessionStarted", hubTools: ["start_quest"] });
    const sessionId = first.started?._tag === "SessionStarted" ? first.started.sessionId : null;
    const resumed = await turn(fake, sessionId, ["start_quest", "check_criterion"], calls);
    expect(resumed.started).not.toHaveProperty("hubTools");
    // A call to a tool it does not hold is refused as not offered, before the hub, as Codex refuses it (#1356).
    expect(resumed.text).toContain(`check_criterion: ${notOfferedReason("check_criterion")}`);
    expect(calls).toEqual([]);
    // A new session holds what its turn offers.
    const fresh = await turn(fake, null, ["start_quest", "check_criterion"], calls);
    expect(fresh.text).toContain("check_criterion: check_criterion ran.");
    expect(calls).toEqual(["check_criterion"]);
  });

  it("[TC-RT-1543-02] fake Claude Code is offered each turn's hub tools, resumed or not", async () => {
    const fake = makeFakeRuntime();
    expect(fake.resumeKeepsHubTools).toBeUndefined();
    const calls: Array<string> = [];
    const first = await turn(fake, null, ["start_quest"], calls);
    expect(first.started).not.toHaveProperty("hubTools");
    const sessionId = first.started?._tag === "SessionStarted" ? first.started.sessionId : null;
    // A call to a tool the turn does not list is refused as not offered, before the hub, as Claude Code refuses it (#1356).
    expect(first.text).toContain(`check_criterion: ${notOfferedReason("check_criterion")}`);
    expect(calls).toEqual([]);
    const resumed = await turn(fake, sessionId, ["start_quest", "check_criterion"], calls);
    expect(resumed.text).toContain("check_criterion: check_criterion ran.");
    expect(calls).toEqual(["check_criterion"]);
  });
});
