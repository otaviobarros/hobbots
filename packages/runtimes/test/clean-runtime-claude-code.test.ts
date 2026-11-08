import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PromptRequest, RuntimeAdapterShape, ToolAccess } from "@hobbots/agents";
import { EMPTY_HOB_POLICY } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect, Exit, Layer, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeClaudeCode } from "../src/claude-code.ts";
import { pluginSkill } from "../src/claude-code-skills.ts";
import { ProcessSandbox } from "../src/sandbox.ts";
import { SKILL_MOUNTS, skillMountsHash } from "../src/skills.ts";
import { type MessagesMove, messagesStandIn } from "../src/testing/messages-stand-in.ts";
import {
  AGENTS_SKILL,
  ASKED_SKILL,
  type CleanRuntimeFixture,
  CONTRACT_HUB_TOOL,
  cleanRuntimeFixture,
  FOREIGN_MARKERS,
  FOREIGN_SKILLS,
  LIBRARY_SKILL,
  SET_RULES,
  SET_SIBLING,
  SET_SKILL,
  SET_SKIPPED,
  stepRecordingContract,
  TEAM_SET,
  WEB_FETCH_CONTRACT_TOOL,
} from "./clean-runtime.ts";

/**
 * The clean-runtime contract test on an installed Claude Code (ADR 029), with a stand-in for the
 * Messages API that records what Claude Code offers the model. Set HOBBOTS_CLAUDE_CODE to the
 * `claude` binary to run it; it needs no account.
 */
const claude = process.env.HOBBOTS_CLAUDE_CODE;

/** Marks the turn's own requests, apart from Claude Code's side questions. */
const INSTRUCTIONS = "You are Pip, a clean-runtime hob.";

describe.runIf(claude !== undefined)("a clean Claude Code runtime (ADR 029)", () => {
  const model = messagesStandIn(INSTRUCTIONS);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-clean-claude-")));
  const savedEnv = { ...process.env };
  let fixture: CleanRuntimeFixture;
  let adapter: RuntimeAdapterShape;
  let access: ToolAccess;

  beforeAll(async () => {
    fixture = cleanRuntimeFixture(root);
    await new Promise<void>((resolve) => model.server.listen(0, "127.0.0.1", resolve));
    const { port } = model.server.address() as AddressInfo;
    // Claude Code reads the fake home and reaches only the stand-in; nothing of the machine's own
    // Claude Code setup passes through.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("CLAUDE") || key.startsWith("ANTHROPIC")) delete process.env[key];
    }
    process.env.HOME = fixture.home;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.ANTHROPIC_AUTH_TOKEN = "stand-in";
    adapter = await Effect.runPromise(
      makeClaudeCode({ workspaceDir: join(root, "workspace"), executable: claude }).pipe(
        Effect.provide(Layer.mergeAll(PolicyEngine.node, ProcessSandbox.unavailable("not needed for this check"))),
      ),
    );
    access = {
      policy: {
        preset: "balanced",
        sharedFolders: [fixture.repo],
        hob: EMPTY_HOB_POLICY,
        dataFolder: join(root, "data"),
        restrictions: [],
      },
      folders: [fixture.repo],
      runtimeFolder: join(root, "runtimes", "hob-1"),
      commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
    };
  });
  afterAll(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    model.server.close();
    rmSync(root, { recursive: true, force: true });
  });

  const turn = async (overrides: Partial<PromptRequest>, moves: ReadonlyArray<MessagesMove> = [{ say: "Hello." }]) => {
    const asked = model.requests.length;
    model.moves.push(...moves);
    const exit = await Effect.runPromise(
      Stream.runCollect(
        adapter.sendPrompt({
          prompt: "Say hello.",
          sessionId: null,
          instructions: INSTRUCTIONS,
          instructionsChanged: false,
          model: null,
          effort: null,
          skills: fixture.mounts,
          ephemeral: true,
          ...overrides,
        }),
      ).pipe(Effect.exit),
    );
    model.moves.length = 0;
    const requests = model.requests.slice(asked);
    return { exit, requests, offered: JSON.stringify(requests) };
  };

  const expectClean = (offered: string, tools: ReadonlyArray<string>) => {
    for (const marker of FOREIGN_MARKERS) expect(offered, marker).not.toContain(marker);
    for (const skill of FOREIGN_SKILLS) expect(offered, skill).not.toContain(skill);
    // The mounted skills, the `~/.agents` one among them, reach the turn through Hobbots.
    expect(offered).toContain(pluginSkill(LIBRARY_SKILL));
    expect(offered).toContain(`${AGENTS_SKILL}-offered`);
    // A mounted set's skills, by their set (ADR 029, Skill sets), less the one the hob turned off.
    expect(offered).toContain(`${TEAM_SET}:${SET_SKILL}`);
    expect(offered).toContain(`${TEAM_SET}:${SET_SIBLING}`);
    expect(offered).not.toContain(SET_SKIPPED);
    // Only when asked: listed to no model.
    expect(offered).not.toContain(`${ASKED_SKILL}-offered`);
    // No MCP server's tools, and the Skill tool for the mounted skills.
    expect(tools.filter((tool) => tool.startsWith("mcp__"))).toEqual([]);
    expect(tools).toContain("Skill");
    for (const ran of fixture.ranMarkers) expect(existsSync(ran), ran).toBe(false);
  };

  const toolsOf = (requests: ReturnType<typeof model.requests.slice>) =>
    [...new Set(requests.flatMap((request) => (request.tools ?? []).map((tool) => tool.name ?? "")))].sort();

  // covers RT-001, ADR 029
  it("[TC-RT-514] a chat-only turn loads only the skills Hobbots mounted, from no home folder", {
    timeout: 120_000,
  }, async () => {
    const { exit, requests, offered } = await turn({});
    expect(Exit.isSuccess(exit), String(exit)).toBe(true);
    expect(requests.length).toBeGreaterThan(0);
    expectClean(offered, toolsOf(requests));
    // No other tool: Claude Code adds a placeholder of its own beside a deferred-loading tool.
    // Read is there for the skills' own files alone (ADR 029, Skill sets).
    expect(toolsOf(requests).filter((tool) => tool !== "DeferredToolPlaceholder")).toEqual(["Read", "Skill"]);
  });

  // covers RT-001, PE-001, ADR 029
  it("[TC-RT-515] a turn in a repository loads none of its skills, MCP servers, hooks or settings", {
    timeout: 120_000,
  }, async () => {
    const { exit, requests, offered } = await turn({ tools: access });
    expect(Exit.isSuccess(exit), String(exit)).toBe(true);
    expectClean(offered, toolsOf(requests));
    // The turn's skill folder is gone once the turn ends.
    expect(readdirSync(join(access.runtimeFolder, "skill-mounts"))).toEqual([]);
  });

  // covers RT-001, ADR 029
  it("[TC-RT-516] the hob reads a mounted skill with the Skill tool, and no other", { timeout: 120_000 }, async () => {
    const { exit, requests } = await turn({}, [
      { tool: "Skill", input: { skill: pluginSkill(LIBRARY_SKILL) } },
      { tool: "Skill", input: { skill: "home-claude-skill" } },
      { say: "Done." },
    ]);
    expect(Exit.isSuccess(exit), String(exit)).toBe(true);
    const events = Exit.isSuccess(exit) ? exit.value : [];
    expect(events).toContainEqual(
      expect.objectContaining({ _tag: "StepStarted", label: "Reading the library-skill skill" }),
    );
    // The use line: the mounted skill was used, the refused one never (#1096).
    expect(events.filter((event) => event._tag === "SkillUsed")).toEqual([
      { _tag: "SkillUsed", source: "library", name: LIBRARY_SKILL, explicit: false },
    ]);
    // The mounted skill's instructions reached the model; the home folder's was refused.
    expect(JSON.stringify(requests[1])).toContain(`Use ${LIBRARY_SKILL}.`);
    expect(JSON.stringify(requests[2])).toMatch(/Unknown skill/);
  });

  // covers RT-001, ADR 029
  it("[TC-RT-517] an Only when asked skill still runs when the prompt names it", { timeout: 120_000 }, async () => {
    const { exit, offered } = await turn({ prompt: `/${pluginSkill(ASKED_SKILL)}` });
    expect(Exit.isSuccess(exit), String(exit)).toBe(true);
    expect(offered).toContain(`Use ${ASKED_SKILL}.`);
  });

  // covers RT-001, ADR 029
  it("[TC-RT-525] a skill you picked loads with the prompt, as Claude Code's own mention, and counts as used", {
    timeout: 120_000,
  }, async () => {
    const { exit, offered } = await turn({ prompt: "Release it.", askedSkill: ASKED_SKILL });
    expect(Exit.isSuccess(exit), String(exit)).toBe(true);
    expect(offered).toContain(`Use ${ASKED_SKILL}.`);
    const events = Exit.isSuccess(exit) ? exit.value : [];
    expect(events.filter((event) => event._tag === "SkillUsed")).toEqual([
      { _tag: "SkillUsed", source: "library", name: ASKED_SKILL, explicit: true },
    ]);
  });

  /** Where a skill of the mounted set is in a turn's folder under `base`. */
  const setSkillFolder = (base: string, name: string) =>
    join(base, SKILL_MOUNTS, skillMountsHash(fixture.mounts), "sets", TEAM_SET, "skills", name);

  // covers RT-001, ADR 029
  it("[TC-RT-1143-01] a skill of a set follows its links to the set's files, and a chat reads nothing else", {
    timeout: 120_000,
  }, async () => {
    const base = setSkillFolder(join(root, "workspace"), SET_SKILL);
    const { exit, requests } = await turn({}, [
      { tool: "Skill", input: { skill: `${TEAM_SET}:${SET_SKILL}` } },
      { tool: "Read", input: { file_path: join(base, "..", "..", "references", "rules.md") } },
      { tool: "Read", input: { file_path: join(base, "..", SET_SIBLING, "SKILL.md") } },
      { tool: "Read", input: { file_path: join(fixture.repo, ".claude", "skills", "repo-claude-skill", "SKILL.md") } },
      { say: "Done." },
    ]);
    expect(Exit.isSuccess(exit), String(exit)).toBe(true);
    expect(JSON.stringify(requests[1])).toContain(`Use ${SET_SKILL}.`);
    expect(JSON.stringify(requests[1])).toContain(base);
    expect(JSON.stringify(requests[2])).toContain(SET_RULES);
    expect(JSON.stringify(requests[3])).toContain(`name: ${SET_SIBLING}`);
    expect(JSON.stringify(requests[4])).toContain("reads only the files of its skills");
    expect(JSON.stringify(requests[4])).not.toContain("repo-claude-skill-offered");
    const events = Exit.isSuccess(exit) ? exit.value : [];
    expect(events.filter((event) => event._tag === "SkillUsed")).toEqual([
      { _tag: "SkillUsed", source: "library", name: SET_SKILL, explicit: false, set: TEAM_SET },
    ]);
  });

  // covers RT-001, PE-001, ADR 029
  it("[TC-RT-1143-02] with tools, a skill of a set reads the set's files under the policy's sandbox", {
    timeout: 120_000,
  }, async () => {
    const base = setSkillFolder(access.runtimeFolder, SET_SKILL);
    const { exit, requests } = await turn({ tools: access }, [
      { tool: "Read", input: { file_path: join(base, "..", "..", "references", "rules.md") } },
      { say: "Done." },
    ]);
    expect(Exit.isSuccess(exit), String(exit)).toBe(true);
    expect(JSON.stringify(requests[1])).toContain(SET_RULES);
  });

  // covers RT-001, ADR 029
  it("[TC-RT-1143-03] a skill of a set you picked loads by its set's name, and counts as used", {
    timeout: 120_000,
  }, async () => {
    const { exit, offered } = await turn({ prompt: "Plan it.", askedSkill: `${TEAM_SET}:${SET_SKILL}` });
    expect(Exit.isSuccess(exit), String(exit)).toBe(true);
    expect(offered).toContain(`Use ${SET_SKILL}.`);
    const events = Exit.isSuccess(exit) ? exit.value : [];
    expect(events.filter((event) => event._tag === "SkillUsed")).toEqual([
      { _tag: "SkillUsed", source: "library", name: SET_SKILL, explicit: true, set: TEAM_SET },
    ]);
  });

  // covers RT-001, PE-001, ADR 036
  it("[TC-RT-1266-11] a hob allowed to search is offered WebSearch, a hob set to Never is not, and none WebFetch", {
    timeout: 120_000,
  }, async () => {
    const never = {
      ...access,
      policy: { ...access.policy, hob: { ...EMPTY_HOB_POLICY, overrides: { "search-web": "deny" } } },
    } as const;
    const allowed = await turn({ tools: access, webSearch: true });
    expect(Exit.isSuccess(allowed.exit), String(allowed.exit)).toBe(true);
    expect(toolsOf(allowed.requests)).toContain("WebSearch");
    // The user's own settings allow WebSearch and WebFetch; no turn reads them.
    for (const { exit, requests } of [
      allowed,
      await turn({ tools: never, webSearch: true }),
      await turn({ tools: access }),
      await turn({ webSearch: true }),
    ]) {
      expect(Exit.isSuccess(exit), String(exit)).toBe(true);
      expect(toolsOf(requests)).not.toContain("WebFetch");
      if (requests !== allowed.requests) expect(toolsOf(requests)).not.toContain("WebSearch");
    }
  });

  // covers RT-001, ADR 029
  it("[TC-RT-518] a turn without skills is offered no skill and no Skill tool", { timeout: 120_000 }, async () => {
    const { exit, requests, offered } = await turn({ skills: null });
    expect(Exit.isSuccess(exit), String(exit)).toBe(true);
    for (const marker of [...FOREIGN_MARKERS, `${LIBRARY_SKILL}-offered`, `${AGENTS_SKILL}-offered`]) {
      expect(offered, marker).not.toContain(marker);
    }
    expect(toolsOf(requests)).toEqual([]);
  });

  // covers EX-004, ADR 031
  it("[TC-PE-471] records a hub tool call's step with the turn's recorder before the hub runs it", {
    timeout: 120_000,
  }, async () => {
    for (const records of [true, false]) {
      const contract = stepRecordingContract(records);
      const { exit } = await turn({ hubTools: contract.hubTools, recordToolStart: contract.recordToolStart }, [
        { tool: `mcp__hobbots__${CONTRACT_HUB_TOOL}`, input: {} },
        { say: "Done." },
      ]);
      expect(Exit.isSuccess(exit), String(exit)).toBe(true);
      expect(contract.order).toEqual([
        expect.stringMatching(new RegExp(`^recorded ${CONTRACT_HUB_TOOL} as `)),
        records ? "ran" : "not run",
      ]);
    }
  });

  // covers ADR 036 (On every runtime)
  it("[TC-PE-1267-16] records a web_fetch call's step before the hub reads the page", {
    timeout: 120_000,
  }, async () => {
    for (const records of [true, false]) {
      const contract = stepRecordingContract(records, WEB_FETCH_CONTRACT_TOOL);
      const { exit } = await turn({ hubTools: contract.hubTools, recordToolStart: contract.recordToolStart }, [
        { tool: `mcp__hobbots__${WEB_FETCH_CONTRACT_TOOL.name}`, input: { url: "https://example.test/lamp" } },
        { say: "Done." },
      ]);
      expect(Exit.isSuccess(exit), String(exit)).toBe(true);
      expect(contract.order).toEqual([
        expect.stringMatching(new RegExp(`^recorded ${WEB_FETCH_CONTRACT_TOOL.name} as `)),
        records ? "ran" : "not run",
      ]);
    }
  });
});
