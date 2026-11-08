import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { FAKE_HUB_DIRECTIVE, fakeSkillsPrompt, makeFakeRuntime } from "../src/fake.ts";
import {
  AGENTS_SKILL,
  ASKED_SKILL,
  CONTRACT_HUB_TOOL,
  cleanRuntimeFixture,
  LIBRARY_SKILL,
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
});
