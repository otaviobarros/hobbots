import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { type PromptRequest, RuntimeError, type RuntimeEvent, type ToolAccess } from "@hobbots/agents";
import { EMPTY_HOB_POLICY } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect, Exit, Layer, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAppServer } from "../src/codex/app-server.ts";
import { unexpectedSkillsMessage } from "../src/codex/skills.ts";
import { type CodexTurnConfig, runCodexTurn } from "../src/codex/turn.ts";
import { SKILL_MOUNTS, skillMountsHash } from "../src/skills.ts";
import { functionCall, type Move, runs, standIn, textOf } from "../src/testing/responses-stand-in.ts";
import {
  AGENTS_SKILL,
  ASKED_SKILL,
  type CleanRuntimeFixture,
  CONTRACT_ANSWER,
  CONTRACT_HUB_TOOL,
  CONTRACT_ROSTER,
  CONTRACT_SEARCH,
  cleanRuntimeFixture,
  contractPageText,
  FOREIGN_MARKERS,
  HOB_SESSION_MARKERS,
  HOB_SESSION_PROMPTS,
  LIBRARY_SKILL,
  ROSTER_INJECTION,
  SET_RULES,
  SET_SIBLING,
  SET_SKILL,
  searchAndReadContract,
  stepRecordingContract,
  TEAM_SET,
  WEB_FETCH_CONTRACT_TOOL,
} from "./clean-runtime.ts";
import { approvalsAnswering, approve } from "./codex-fixture.ts";

/**
 * The clean-runtime contract test on an installed Codex (ADR 029), with a stand-in model that records
 * what Codex offers it. Set HOBBOTS_CODEX to the `codex` binary to run it; it needs no account.
 */
const codex = process.env.HOBBOTS_CODEX;

/** Codex's system configuration folder on Linux and macOS, whose skills have scope `admin`. */
const SYSTEM_SKILLS = "/etc/codex/skills";
const ORG_SKILL = "hobbots-test-org-skill";

/** Writes an administrator's skill where the test may, as in CI's container; false where it may not. */
const writeOrgSkill = (): boolean => {
  const folder = join(SYSTEM_SKILLS, ORG_SKILL);
  try {
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "SKILL.md"),
      `---\nname: ${ORG_SKILL}\ndescription: Marker ${ORG_SKILL}-offered.\n---\n\nUse it.\n`,
    );
    return true;
  } catch {
    return false;
  }
};

describe.runIf(codex !== undefined)("a clean Codex runtime (ADR 029)", () => {
  const model = standIn();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-clean-codex-")));
  let fixture: CleanRuntimeFixture;
  let config: CodexTurnConfig;
  let access: ToolAccess;
  let orgSkill = false;
  const savedHome = process.env.HOME;

  beforeAll(async () => {
    fixture = cleanRuntimeFixture(root);
    orgSkill = writeOrgSkill();
    // Codex finds `~/.agents/skills` through the home folder, as a hob's Codex does.
    process.env.HOME = fixture.home;
    await new Promise<void>((resolve) => model.server.listen(0, "127.0.0.1", resolve));
    const { port } = model.server.address() as AddressInfo;
    const { engine, spawner } = await Effect.runPromise(
      Effect.all({
        engine: Effect.service(PolicyEngine),
        spawner: Effect.service(ChildProcessSpawner.ChildProcessSpawner),
      }).pipe(Effect.provide(Layer.mergeAll(PolicyEngine.node, NodeServices.layer))),
    );
    config = {
      binary: Effect.succeed(codex ?? "codex"),
      start: (command, options) =>
        startAppServer(command, options).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      signIn: () => Effect.succeed(null),
      clientVersion: "0.0.0",
      workspaceDir: join(root, "workspace"),
      userHome: fixture.home,
      // Decided as if sandboxed, but Codex runs without the sandbox: this checks what it loads.
      policy: {
        engine,
        sandboxState: "on",
        sandbox: { state: "unavailable", evidence: "not started for this check", prepare: () => Effect.never },
      },
      extraArgs: [
        "-c",
        'model_provider="standin"',
        "-c",
        `model_providers.standin={ name = "standin", base_url = "http://127.0.0.1:${port}/v1", wire_api = "responses" }`,
        "-c",
        'model="gpt-5.5"',
      ],
    };
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
    process.env.HOME = savedHome;
    model.server.close();
    if (orgSkill) rmSync(join(SYSTEM_SKILLS, ORG_SKILL), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  /** One turn under `turnConfig`, with the stand-in model saying hello. */
  const turnWith = (turnConfig: CodexTurnConfig, overrides: Partial<PromptRequest>) => {
    model.moves.push({ say: "Hello." });
    return Effect.runPromise(
      Stream.runCollect(
        runCodexTurn(turnConfig, {
          prompt: "Say hello.",
          sessionId: null,
          instructions: "You are Pip.",
          instructionsChanged: false,
          model: null,
          effort: null,
          ...overrides,
        }),
      ).pipe(Effect.exit),
    );
  };

  const turn = async (overrides: Partial<PromptRequest>, moves: ReadonlyArray<Move> = [{ say: "Hello." }]) => {
    const { approvals } = approvalsAnswering(approve, access);
    const asked = model.requests.length;
    model.moves.push(...moves);
    const exit = await Effect.runPromise(
      Stream.runCollect(
        runCodexTurn(config, {
          prompt: "Say hello.",
          sessionId: null,
          instructions: "You are Pip.",
          instructionsChanged: false,
          model: null,
          effort: null,
          approvals,
          skills: fixture.mounts,
          ...overrides,
        }),
      ).pipe(Effect.exit),
    );
    return { exit, offered: JSON.stringify(model.requests.slice(asked)) };
  };

  const expectClean = (offered: string, events: ReadonlyArray<RuntimeEvent>) => {
    for (const marker of FOREIGN_MARKERS) expect(offered, marker).not.toContain(marker);
    // The mounted skills, the `~/.agents` one among them, reach the turn through Hobbots.
    expect(offered).toContain(`${LIBRARY_SKILL}-offered`);
    expect(offered).toContain(`${AGENTS_SKILL}-offered`);
    // A mounted set's skills, less the one the hob turned off (ADR 029, Skill sets).
    expect(offered).toContain(`${SET_SKILL}-offered`);
    expect(offered).toContain(`${SET_SIBLING}-offered`);
    // Only when asked: listed to no model.
    expect(offered).not.toContain(`${ASKED_SKILL}-offered`);
    // No bundled skill: Codex's own are off.
    expect(offered).not.toContain("skill-creator");
    for (const ran of fixture.ranMarkers) expect(existsSync(ran), ran).toBe(false);
    const started = events.find((event) => event._tag === "SessionStarted");
    if (orgSkill) {
      // An administrator's skill stays in force, as the organization's.
      expect(offered).toContain(`${ORG_SKILL}-offered`);
      expect(started).toMatchObject({ organizationSkills: [ORG_SKILL] });
    } else {
      expect(started).not.toHaveProperty("organizationSkills");
    }
  };

  // covers RT-001, ADR 029
  it("[TC-RT-510] a chat-only turn loads only the skills Hobbots mounted, from no home folder", {
    timeout: 60_000,
  }, async () => {
    const { exit, offered } = await turn({});
    expect(Exit.isSuccess(exit), String(exit)).toBe(true);
    expectClean(offered, Exit.isSuccess(exit) ? exit.value : []);
  });

  // covers RT-001, PE-001, ADR 029
  it("[TC-RT-511] a turn in a repository loads none of its skills, MCP servers or configuration", {
    timeout: 60_000,
  }, async () => {
    const { exit, offered } = await turn({ tools: access });
    expect(Exit.isSuccess(exit), String(exit)).toBe(true);
    expectClean(offered, Exit.isSuccess(exit) ? exit.value : []);
    // The turn's skill folder is gone once the turn ends.
    expect(readdirSync(join(access.runtimeFolder, "skill-mounts"))).toEqual([]);
  });

  // covers EX-004, ADR 031
  it("[TC-PE-472] records a hub tool call's step with the turn's recorder before the hub runs it", {
    timeout: 60_000,
  }, async () => {
    for (const records of [true, false]) {
      const contract = stepRecordingContract(records);
      const { exit } = await turn({ hubTools: contract.hubTools, recordToolStart: contract.recordToolStart }, [
        functionCall(CONTRACT_HUB_TOOL, {}, `call-${records}`),
        { say: "Done." },
      ]);
      expect(Exit.isSuccess(exit), String(exit)).toBe(true);
      expect(contract.order).toEqual([`recorded ${CONTRACT_HUB_TOOL} as call-${records}`, records ? "ran" : "not run"]);
    }
  });

  /** The names of the tools each model request of the turns since `asked` carried. */
  const toolNames = (asked: number) =>
    model.requests.slice(asked).map((request) => (request.tools ?? []).map((tool) => tool.name ?? tool.type));

  // covers PE-008, ADR 031 (#1347, #1245)
  it("[TC-PE-1347-04] a resumed session keeps the hub tools it started with, and a new one is offered the turn's", {
    timeout: 120_000,
  }, async () => {
    const { hubTools } = stepRecordingContract();
    const wider = { ...hubTools, tools: [...hubTools.tools, WEB_FETCH_CONTRACT_TOOL] };
    const asked = model.requests.length;
    const first = await turn({ hubTools });
    expect(Exit.isSuccess(first.exit), String(first.exit)).toBe(true);
    const events = Exit.isSuccess(first.exit) ? first.exit.value : [];
    const started = events.find((event) => event._tag === "SessionStarted");
    const sessionId = started?._tag === "SessionStarted" ? started.sessionId : null;
    expect(sessionId).not.toBeNull();
    const resumed = await turn({ hubTools: wider, sessionId });
    expect(Exit.isSuccess(resumed.exit), String(resumed.exit)).toBe(true);
    const fresh = await turn({ hubTools: wider });
    expect(Exit.isSuccess(fresh.exit), String(fresh.exit)).toBe(true);
    const [started1, resumed1, fresh1] = toolNames(asked).map((names) => [
      names.some((name) => name?.includes(CONTRACT_HUB_TOOL)),
      names.some((name) => name?.includes(WEB_FETCH_CONTRACT_TOOL.name)),
    ]);
    // Codex resumes a thread with the dynamic tools it started with: the change names it (#1347).
    expect([started1, resumed1, fresh1]).toEqual([
      [true, false],
      [true, false],
      [true, true],
    ]);
  });

  // covers PE-001, ADR 014 (#1356)
  it("[TC-PE-1356-02] a call to a tool the thread was not offered is reported as refused, new or resumed", {
    timeout: 120_000,
  }, async () => {
    const contract = stepRecordingContract();
    const first = await turn(
      { hubTools: contract.hubTools, recordToolStart: contract.recordToolStart, tools: access },
      [functionCall("github_comment", { body: "Looks good." }, "call-comment"), { say: "Done." }],
    );
    expect(Exit.isSuccess(first.exit), String(first.exit)).toBe(true);
    const events = Exit.isSuccess(first.exit) ? first.exit.value : [];
    const started = events.find((event) => event._tag === "SessionStarted");
    const sessionId = started?._tag === "SessionStarted" ? started.sessionId : null;
    expect(sessionId).not.toBeNull();
    // A resumed thread, whose App Server reports no raw items, is read the same way.
    const resumed = await turn(
      { hubTools: contract.hubTools, recordToolStart: contract.recordToolStart, tools: access, sessionId },
      [functionCall("github_review", { body: "Approve." }, "call-review"), { say: "Done." }],
    );
    expect(Exit.isSuccess(resumed.exit), String(resumed.exit)).toBe(true);
    const refused = [...events, ...(Exit.isSuccess(resumed.exit) ? resumed.exit.value : [])].filter(
      (event) => event._tag === "ToolDenied",
    );
    expect(refused).toEqual([
      expect.objectContaining({ id: "call-comment", tool: "github_comment", notOffered: { runtimeTool: null } }),
      expect.objectContaining({ id: "call-review", tool: "github_review", notOffered: { runtimeTool: null } }),
    ]);
    // Neither reached the hub or was recorded as started.
    expect(contract.order).toEqual([]);
  });

  // covers ADR 039 (The context pack with several hobs), RT-001
  it("[TC-RT-1464-02] two hobs' sessions in one workspace each resume their own history, never the other's", {
    timeout: 180_000,
  }, async () => {
    const started = async (prompt: string) => {
      const { exit } = await turn({ prompt });
      expect(Exit.isSuccess(exit), String(exit)).toBe(true);
      const events = Exit.isSuccess(exit) ? exit.value : [];
      const event = events.find((e) => e._tag === "SessionStarted");
      return event?._tag === "SessionStarted" ? event.sessionId : null;
    };
    const wren = await started(HOB_SESSION_PROMPTS.wren);
    const quill = await started(HOB_SESSION_PROMPTS.quill);
    expect(wren).not.toBeNull();
    expect(quill).not.toBeNull();
    expect(quill).not.toBe(wren);
    for (const [sessionId, own, other] of [
      [wren, HOB_SESSION_MARKERS.wren, HOB_SESSION_MARKERS.quill],
      [quill, HOB_SESSION_MARKERS.quill, HOB_SESSION_MARKERS.wren],
    ] as const) {
      const resumed = await turn({ prompt: "And now?", sessionId });
      expect(Exit.isSuccess(resumed.exit), String(resumed.exit)).toBe(true);
      expect(resumed.offered).toContain(own);
      expect(resumed.offered).not.toContain(other);
    }
  });

  // covers ADR 036 (On every runtime)
  it("[TC-PE-1267-17] records a web_fetch call's step before the hub reads the page", {
    timeout: 60_000,
  }, async () => {
    const tool = WEB_FETCH_CONTRACT_TOOL.name;
    for (const records of [true, false]) {
      const contract = stepRecordingContract(records, WEB_FETCH_CONTRACT_TOOL);
      const { exit } = await turn({ hubTools: contract.hubTools, recordToolStart: contract.recordToolStart }, [
        functionCall(tool, { url: "https://example.test/lamp" }, `web-${records}`),
        { say: "Done." },
      ]);
      expect(Exit.isSuccess(exit), String(exit)).toBe(true);
      expect(contract.order).toEqual([`recorded ${tool} as web-${records}`, records ? "ran" : "not run"]);
    }
  });

  // covers RT-001, ADR 029
  it("[TC-RT-526] a skill you picked loads as Codex's skill item, even Only when asked, and counts as used", {
    timeout: 60_000,
  }, async () => {
    const { exit, offered } = await turn({ prompt: "Release it.", askedSkill: ASKED_SKILL });
    expect(Exit.isSuccess(exit), String(exit)).toBe(true);
    expect(offered).toContain(`Use ${ASKED_SKILL}.`);
    const events = Exit.isSuccess(exit) ? exit.value : [];
    expect(events.filter((event) => event._tag === "SkillUsed")).toEqual([
      { _tag: "SkillUsed", source: "library", name: ASKED_SKILL, explicit: true },
    ]);
  });

  // covers RT-001, ADR 029
  it("[TC-RT-527] the model reading a mounted skill's SKILL.md counts as using it, and reading another file does not", {
    timeout: 60_000,
  }, async () => {
    const skills = join(access.runtimeFolder, SKILL_MOUNTS, skillMountsHash(fixture.mounts), "skills");
    const { exit } = await turn({ tools: access }, [
      runs("read-skill", `cat ${join(skills, LIBRARY_SKILL, "SKILL.md")}`),
      runs("read-other", `cat ${join(fixture.repo, ".agents", "skills", "repo-agents-skill", "SKILL.md")}`),
      { say: "Done." },
    ]);
    expect(Exit.isSuccess(exit), String(exit)).toBe(true);
    const events = Exit.isSuccess(exit) ? exit.value : [];
    expect(events.filter((event) => event._tag === "SkillUsed")).toEqual([
      { _tag: "SkillUsed", source: "library", name: LIBRARY_SKILL, explicit: false },
    ]);
  });

  /** Where a skill of the mounted set is in the turn's folder. */
  const setSkillFolder = (name: string) =>
    join(access.runtimeFolder, SKILL_MOUNTS, skillMountsHash(fixture.mounts), "sets", TEAM_SET, "skills", name);

  // covers RT-001, ADR 029
  it("[TC-RT-1143-04] a skill of a set you picked loads from its set's folder and follows its links", {
    timeout: 60_000,
  }, async () => {
    const base = setSkillFolder(SET_SKILL);
    const { exit, offered } = await turn(
      { prompt: "Plan it.", askedSkill: `${TEAM_SET}:${SET_SKILL}`, tools: access },
      [
        runs("read-rules", `cat '${join(base, "..", "..", "references", "rules.md")}'`),
        runs("read-sibling", `cat '${join(base, "..", SET_SIBLING, "SKILL.md")}'`),
        { say: "Done." },
      ],
    );
    expect(Exit.isSuccess(exit), String(exit)).toBe(true);
    expect(offered).toContain(`Use ${SET_SKILL}.`);
    expect(offered).toContain(join(base, "SKILL.md"));
    expect(offered).toContain(SET_RULES);
    expect(offered).toContain(`name: ${SET_SIBLING}`);
    const events = Exit.isSuccess(exit) ? exit.value : [];
    expect(events.filter((event) => event._tag === "SkillUsed")).toEqual([
      { _tag: "SkillUsed", source: "library", name: SET_SKILL, explicit: true, set: TEAM_SET },
      // Following the link to the other skill's SKILL.md reads that skill.
      { _tag: "SkillUsed", source: "library", name: SET_SIBLING, explicit: false, set: TEAM_SET },
    ]);
  });

  // covers RT-001, ADR 029
  it("[TC-RT-1143-05] reading a set's skill's SKILL.md counts as using it, with its set", {
    timeout: 60_000,
  }, async () => {
    const { exit } = await turn({ tools: access }, [
      runs("read-set-skill", `cat '${join(setSkillFolder(SET_SIBLING), "SKILL.md")}'`),
      { say: "Done." },
    ]);
    expect(Exit.isSuccess(exit), String(exit)).toBe(true);
    const events = Exit.isSuccess(exit) ? exit.value : [];
    expect(events.filter((event) => event._tag === "SkillUsed")).toEqual([
      { _tag: "SkillUsed", source: "library", name: SET_SIBLING, explicit: false, set: TEAM_SET },
    ]);
  });

  /** The web search tool each model request of the turns since `asked` carried, as Codex sent it. */
  const searchTools = (asked: number) =>
    model.requests
      .slice(asked)
      .map((request) =>
        (request.tools ?? []).filter((tool) => tool.type === "web_search" || tool.name === "web_search"),
      );

  // covers RT-001, PE-001, ADR 036
  it("[TC-RT-1266-09] a hob allowed to search is offered Codex's cached search only, on a new thread and a resumed one", {
    timeout: 120_000,
  }, async () => {
    const searching = { ...config, cachedSearch: Effect.succeed(true) };
    const asked = model.requests.length;
    const first = await turnWith(searching, { tools: access, webSearch: true });
    expect(Exit.isSuccess(first), String(first)).toBe(true);
    const started = (Exit.isSuccess(first) ? first.value : []).find((event) => event._tag === "SessionStarted");
    const sessionId = started?._tag === "SessionStarted" ? started.sessionId : null;
    expect(sessionId).not.toBeNull();
    const resumed = await turnWith(searching, { tools: access, webSearch: true, sessionId });
    expect(Exit.isSuccess(resumed), String(resumed)).toBe(true);
    const offered = searchTools(asked);
    expect(offered.length).toBe(2);
    // Cached search keeps to OpenAI's index: the model is never let fetch a page (ADR 036).
    for (const tools of offered) expect(tools).toEqual([expect.objectContaining({ external_web_access: false })]);
  });

  // covers RT-001, PE-001, ADR 036
  it("[TC-RT-1266-10] a hob set to Never, or a turn the hub did not let search, is offered no search", {
    timeout: 120_000,
  }, async () => {
    const searching = { ...config, cachedSearch: Effect.succeed(true) };
    const never = {
      ...access,
      policy: { ...access.policy, hob: { ...EMPTY_HOB_POLICY, overrides: { "search-web": "deny" } } },
    } as const;
    const asked = model.requests.length;
    for (const exit of [
      await turnWith(searching, { tools: never, webSearch: true }),
      await turnWith(searching, { tools: access }),
      // A Codex the contract test did not hold searches for no hob.
      await turnWith(config, { tools: access, webSearch: true }),
      // A chat-only turn, whatever the user's own setting says.
      await turnWith(searching, {}),
    ]) {
      expect(Exit.isSuccess(exit), String(exit)).toBe(true);
    }
    expect(searchTools(asked)).toEqual([[], [], [], []]);
  });

  // covers RT-001, ADR 036 (On every runtime)
  it("[TC-RT-1272-02] a hob searches with cached search, reads two pages from the results and answers with them as sources", {
    timeout: 120_000,
  }, async () => {
    const contract = searchAndReadContract();
    const [first, second] = CONTRACT_SEARCH.hits;
    const asked = model.requests.length;
    const searching = { ...config, cachedSearch: Effect.succeed(true) };
    const { approvals } = approvalsAnswering(approve, access);
    // A move an earlier turn left unused would answer this turn's first request instead.
    model.moves.length = 0;
    model.moves.push(
      {
        call: {
          type: "web_search_call",
          id: "ws-lamp-oil",
          status: "completed",
          action: {
            type: "search",
            query: CONTRACT_SEARCH.query,
            sources: CONTRACT_SEARCH.hits.map((hit) => ({ type: "url", ...hit })),
          },
        },
      },
      functionCall(WEB_FETCH_CONTRACT_TOOL.name, { url: first.url }, "read-first"),
      functionCall(WEB_FETCH_CONTRACT_TOOL.name, { url: second.url }, "read-second"),
      { say: CONTRACT_ANSWER },
    );
    const exit = await Effect.runPromise(
      Stream.runCollect(
        runCodexTurn(searching, {
          prompt: "How should lamp oil be kept?",
          sessionId: null,
          instructions: "You are Pip.",
          instructionsChanged: false,
          model: null,
          effort: null,
          approvals,
          tools: access,
          webSearch: true,
          hubTools: contract.hubTools,
          recordToolStart: contract.recordToolStart,
          recordSearch: contract.recordSearch,
          checkWebSearch: contract.checkWebSearch,
        }),
      ).pipe(Effect.exit),
    );
    expect(Exit.isSuccess(exit), String(exit)).toBe(true);
    const events = Exit.isSuccess(exit) ? exit.value : [];
    // Codex's hosted search cannot be refused inside a turn, so the hub's limits are never asked;
    // the search is recorded before the first page is read.
    expect(contract.order).toEqual([`searched ${CONTRACT_SEARCH.query}`, `read ${first.url}`, `read ${second.url}`]);
    // A stand-in model's search has no results: Codex gets them from OpenAI's search out of band, so
    // they are proven only with a real search (ADR 036, Validation).
    expect(contract.searched).toEqual([expect.objectContaining({ query: CONTRACT_SEARCH.query, results: null })]);
    // Every request of the turn holds Codex to cached search.
    const offered = searchTools(asked);
    expect(offered.length).toBe(4);
    for (const tools of offered) expect(tools).toEqual([expect.objectContaining({ external_web_access: false })]);
    // The model got both pages, and its answer names them as its sources.
    const last = textOf(model.requests.at(-1));
    for (const hit of CONTRACT_SEARCH.hits) expect(last).toContain(contractPageText(hit.url));
    const said = events.flatMap((event) => (event._tag === "TextDelta" ? [event.text] : [])).join("");
    expect(said).toContain(CONTRACT_ANSWER);
  });

  // covers RT-001, ADR 029
  it("[TC-RT-512] a turn without skills is offered none", { timeout: 60_000 }, async () => {
    const { exit, offered } = await turn({ skills: null });
    expect(Exit.isSuccess(exit), String(exit)).toBe(true);
    for (const marker of [...FOREIGN_MARKERS, `${LIBRARY_SKILL}-offered`, `${AGENTS_SKILL}-offered`]) {
      expect(offered, marker).not.toContain(marker);
    }
  });

  // covers RT-001, ADR 029
  it("[TC-RT-513] a turn does not start when Codex would load a skill Hobbots did not turn off", {
    timeout: 60_000,
  }, async () => {
    // A skill that appears after Hobbots looked, as one written while the turn starts would.
    const late = join(fixture.home, ".agents", "skills", "late-skill");
    const wrapper = join(root, "codex-late");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nmkdir -p '${late}'\nprintf -- '---\\nname: late-skill\\ndescription: Marker late-skill-offered.\\n---\\n' > '${late}/SKILL.md'\nexec '${codex}' "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    const asked = model.requests.length;
    const exit = await Effect.runPromise(
      Stream.runCollect(
        runCodexTurn(
          { ...config, binary: Effect.succeed(wrapper) },
          {
            prompt: "Say hello.",
            sessionId: null,
            instructions: "You are Pip.",
            instructionsChanged: false,
            model: null,
            effort: null,
            skills: fixture.mounts,
          },
        ),
      ).pipe(Effect.exit),
    );
    rmSync(late, { recursive: true, force: true });
    expect(exit).toEqual(
      Exit.fail(
        new RuntimeError({
          message: unexpectedSkillsMessage([
            { name: "late-skill", path: join(late, "SKILL.md"), scope: "user", enabled: true },
          ]),
        }),
      ),
    );
    // No thread opened and no model was asked.
    expect(model.requests.length).toBe(asked);
  });

  // covers ADR 032 (The roster, Every runtime)
  it("[TC-RT-1235-02] the roster of other hobs reaches the model with the turn's prompt, never in its instructions", {
    timeout: 60_000,
  }, async () => {
    const asked = model.requests.length;
    const { exit } = await turn({ briefing: CONTRACT_ROSTER, prompt: "Who can push to GitHub?" });
    expect(Exit.isSuccess(exit), String(exit)).toBe(true);
    const requests = model.requests.slice(asked);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.instructions ?? "").not.toContain(ROSTER_INJECTION);
      expect(JSON.stringify(request.input)).toContain(
        JSON.stringify(`${CONTRACT_ROSTER}\n\nWho can push to GitHub?`).slice(1, -1),
      );
    }
  });
});
