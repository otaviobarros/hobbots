import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import {
  FAKE_HUB_DIRECTIVE,
  fakeInstructionsPrompt,
  fakeRosterPrompt,
  fakeSkillsPrompt,
  makeFakeRuntime,
} from "../src/fake.ts";
import {
  AGENTS_SKILL,
  ASKED_SKILL,
  CONTRACT_HUB_TOOL,
  CONTRACT_PACK,
  CONTRACT_ROSTER,
  cleanRuntimeFixture,
  LIBRARY_SKILL,
  PACK_PROMPT,
  SET_SIBLING,
  SET_SKILL,
  stepRecordingContract,
  TEAM_SET,
  WEB_FETCH_CONTRACT_TOOL,
} from "./clean-runtime.ts";

// The clean-runtime contract test on the fake runtime (ADR 029): it loads exactly the skills the turn
// mounts, whatever the home folder and the repository hold. The real runtimes run the same fixture in
// clean-runtime-claude-code.test.ts and clean-runtime-codex.test.ts.

describe("a clean fake runtime (ADR 029)", () => {
  const root = mkdtempSync(join(tmpdir(), "hobbots-clean-fake-"));
  const fixture = cleanRuntimeFixture(root);
  const savedHome = process.env.HOME;
  process.env.HOME = fixture.home;
  afterAll(() => {
    process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });

  const skillsOf = (skills: typeof fixture.mounts | null) =>
    makeFakeRuntime()
      .sendPrompt({
        prompt: fakeSkillsPrompt,
        sessionId: null,
        instructions: "",
        instructionsChanged: false,
        model: null,
        effort: null,
        skills,
      })
      .pipe(Stream.runCollect, Effect.runPromise)
      .then((events) => Array.from(events).flatMap((event) => (event._tag === "Completed" ? [event.text] : [])));

  // covers RT-001, ADR 029
  it("[TC-RT-519] loads only the skills the turn mounts, Only when asked marked, and none without mounts", async () => {
    expect(await skillsOf(fixture.mounts)).toEqual([
      [
        LIBRARY_SKILL,
        `${ASKED_SKILL} (only when asked)`,
        AGENTS_SKILL,
        // A set's skills by their set, less the one the hob turned off (ADR 029, Skill sets).
        `${TEAM_SET}:${SET_SKILL}`,
        `${TEAM_SET}:${SET_SIBLING}`,
      ].join("\n"),
    ]);
    expect(await skillsOf(null)).toEqual(["No skills."]);
  });

  const hubCall = (records: boolean, tool = CONTRACT_HUB_TOOL) => {
    const contract =
      tool === CONTRACT_HUB_TOOL
        ? stepRecordingContract(records)
        : stepRecordingContract(records, WEB_FETCH_CONTRACT_TOOL);
    const input = tool === CONTRACT_HUB_TOOL ? "{}" : JSON.stringify({ url: "https://example.test/lamp" });
    return makeFakeRuntime()
      .sendPrompt({
        prompt: `${FAKE_HUB_DIRECTIVE} ${tool} ${input}`,
        sessionId: null,
        instructions: "",
        instructionsChanged: false,
        model: null,
        effort: null,
        hubTools: contract.hubTools,
        recordToolStart: contract.recordToolStart,
      })
      .pipe(Stream.runCollect, Effect.runPromise)
      .then(() => contract.order);
  };

  // covers EX-004, ADR 031
  it("[TC-PE-470] records a hub tool call's step with the turn's recorder before the hub runs it", async () => {
    expect(await hubCall(true)).toEqual([`recorded ${CONTRACT_HUB_TOOL} as fake-hub-1`, "ran"]);
    expect(await hubCall(false)).toEqual([`recorded ${CONTRACT_HUB_TOOL} as fake-hub-1`, "not run"]);
  });

  // covers ADR 036 (On every runtime)
  it("[TC-PE-1267-15] records a web_fetch call's step before the hub reads the page", async () => {
    const tool = WEB_FETCH_CONTRACT_TOOL.name;
    expect(await hubCall(true, tool)).toEqual([`recorded ${tool} as fake-hub-1`, "ran"]);
    expect(await hubCall(false, tool)).toEqual([`recorded ${tool} as fake-hub-1`, "not run"]);
  });

  // covers ADR 032 (The roster, Every runtime)
  it("[TC-RT-1235-03] the roster of other hobs reaches the turn as its briefing, apart from its instructions", async () => {
    const told = await makeFakeRuntime()
      .sendPrompt({
        prompt: fakeRosterPrompt,
        briefing: CONTRACT_ROSTER,
        sessionId: null,
        instructions: "",
        instructionsChanged: false,
        model: null,
        effort: null,
      })
      .pipe(Stream.runCollect, Effect.runPromise)
      .then((events) => Array.from(events).flatMap((event) => (event._tag === "Completed" ? [event.text] : [])));
    expect(told).toEqual([CONTRACT_ROSTER]);
  });

  // covers ADR 039 (The context pack with several hobs), RT-001
  it("[TC-RT-1465-03] the pack with several hobs reaches the turn as its briefing, ahead of the prompt", async () => {
    const told = await makeFakeRuntime()
      .sendPrompt({
        prompt: PACK_PROMPT,
        briefing: CONTRACT_PACK,
        sessionId: null,
        instructions: "",
        instructionsChanged: false,
        model: null,
        effort: null,
      })
      .pipe(Stream.runCollect, Effect.runPromise)
      .then((events) => Array.from(events).flatMap((event) => (event._tag === "Completed" ? [event.text] : [])));
    expect(told).toEqual([`Echo: ${CONTRACT_PACK}\n\n${PACK_PROMPT}`]);
  });

  // covers ADR 039 (The context pack with several hobs), RT-001
  it("[TC-RT-1464-03] two hobs' sessions each resume their own instructions, never the other's", async () => {
    const fake = makeFakeRuntime();
    const turn = (instructions: string, sessionId: string | null, prompt = "Say hello.") =>
      fake
        .sendPrompt({ prompt, sessionId, instructions, instructionsChanged: false, model: null, effort: null })
        .pipe(Stream.runCollect, Effect.runPromise)
        .then((events) => Array.from(events).find((event) => event._tag === "Completed"))
        .then((done) => (done?._tag === "Completed" ? done : null));
    const wren = await turn("You are Wren.", null);
    const quill = await turn("You are Quill.", null);
    expect(wren?.sessionId).not.toBe(quill?.sessionId);
    // A resumed session keeps the instructions it started with, so each answers as its own hob.
    const resumed = await Promise.all(
      [wren, quill].map((done) => turn("", done?.sessionId ?? null, fakeInstructionsPrompt)),
    );
    expect(resumed.map((done) => [done?.sessionId, done?.text])).toEqual([
      [wren?.sessionId, "You are Wren."],
      [quill?.sessionId, "You are Quill."],
    ]);
  });
});
