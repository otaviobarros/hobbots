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
import {
  AGENTS_SKILL,
  ASKED_SKILL,
  type CleanRuntimeFixture,
  CONTRACT_HUB_TOOL,
  cleanRuntimeFixture,
  FOREIGN_MARKERS,
  LIBRARY_SKILL,
  stepRecordingContract,
} from "./clean-runtime.ts";
import { approvalsAnswering, approve } from "./codex-fixture.ts";
import { functionCall, type Move, runs, standIn } from "./responses-stand-in.ts";

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
});
