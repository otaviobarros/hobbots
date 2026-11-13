import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import {
  type CallSteering,
  Charms,
  type HubTools,
  makeRedactor,
  type PromptRequest,
  type ToolAccess,
} from "@hobbots/agents";
import { charmTakeoversFor, fakeCharm, memoryCharmCalls } from "@hobbots/agents/testing";
import {
  AgentId,
  type CommitsAs,
  EMPTY_HOB_POLICY,
  GITHUB_CHARM_NOTE,
  GITHUB_TOOLS,
  GITHUB_WRITE_TOOLS,
  settleCommitsAs,
} from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect, Layer, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { claudeTurnStart, policyHooks, toolTurn } from "../src/claude-code.ts";
import { codexTurnEvents } from "../src/codex/events.ts";
import { type PolicyRequest, policyGate } from "../src/codex/policy.ts";
import { CODEX_MODEL_HOSTS, type CodexTurnConfig, runCodexTurn } from "../src/codex/turn.ts";
import { scriptedToolEvents } from "../src/fake.ts";
import { commitIdentityNow, NO_GIT_IDENTITY_NOTE, SETS_COMMIT_IDENTITY_NOTE } from "../src/git-config.ts";
import type { ProcessSandboxShape } from "../src/sandbox.ts";
import { completed, fakeServer, THREAD, TURN } from "./codex-app-server.ts";

// Issue #741: who a turn's commits are made as is settled by the hub, and every runtime must apply
// it the same way. Each runtime Hobbots supports is listed in RUNTIMES and passes every case here:
// its commands commit as the settled identity or not at all, its hob is told so, a resumed session
// is told again, and a command that sets its own identity is refused naming it. A new runtime is
// added to RUNTIMES; it cannot be supported without passing these.

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-commit-contract-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const project = join(temp, "project");
const home = join(temp, "home");
for (const folder of [project, home]) mkdirSync(folder);
const engine = Effect.runSync(Effect.service(PolicyEngine).pipe(Effect.provide(PolicyEngine.node)));

const access = (commitsAs: CommitsAs): ToolAccess => ({
  policy: {
    preset: "balanced",
    sharedFolders: [project],
    hob: EMPTY_HOB_POLICY,
    dataFolder: join(temp, "data"),
    restrictions: [],
  },
  folders: [project],
  runtimeFolder: join(temp, "runtimes", "hob-1"),
  commitsAs,
});

const request = (commitsAs: CommitsAs, sessionId: string | null = null): PromptRequest => ({
  prompt: "Save the notes",
  sessionId,
  instructions: "Be brief.",
  instructionsChanged: false,
  model: null,
  effort: null,
  tools: access(commitsAs),
});

/** What a runtime's turn starts with: the environment its commands get, its instructions and its prompt. */
interface Started {
  readonly env: NodeJS.ProcessEnv;
  readonly instructions: string;
  readonly prompt: string;
}

interface Runtime {
  readonly name: string;
  /** Starts a turn, or null for a runtime that runs no command of its own. */
  readonly start: ((request: PromptRequest) => Promise<Started>) | null;
  /**
   * What the hob is told when the runtime refuses `command`, which sets its own commit identity or
   * makes a commit the turn's `steering` holds, or nothing when it does not refuse it.
   */
  readonly refusal: (
    tools: ToolAccess,
    command: string,
    steering?: CallSteering,
    hubTools?: HubTools,
  ) => Promise<string>;
}

const BASE_ENV = { PATH: process.env.PATH } satisfies NodeJS.ProcessEnv;

const claudeCode: Runtime = {
  name: "Claude Code",
  start: async (turn) => {
    const started = claudeTurnStart(turn, "on", true);
    return { env: started.commits.env(BASE_ENV), instructions: started.instructions, prompt: started.prompt };
  },
  refusal: async (tools, command, steering, hubTools) => {
    const turn = toolTurn(tools, "on", { steering: steering ?? null, hubTools: hubTools ?? null });
    if (turn === null) throw new Error("expected a tool turn");
    const { hooks } = policyHooks(engine, turn, () => undefined);
    const [pre] = hooks.PreToolUse?.[0]?.hooks ?? [];
    const output = await pre?.(
      {
        session_id: "s",
        transcript_path: "",
        cwd: project,
        tool_name: "Bash",
        tool_input: { command },
        tool_use_id: "t1",
        hook_event_name: "PreToolUse",
      } as HookInput,
      "t1",
      { signal: new AbortController().signal },
    );
    return (
      (output as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput
        ?.permissionDecisionReason ?? ""
    );
  },
};

// Codex runs in a stand-in sandbox that passes the environment through, as the real one does.
const codexSandbox: ProcessSandboxShape = {
  state: "on",
  evidence: "a stand-in sandbox",
  prepare: () =>
    Effect.succeed({
      spawnArgs: (command, args, env) => ({ command: "/sandbox", args: [command, ...args], env }),
      release: () => undefined,
    }),
};
const codexBinary = join(temp, "codex");
writeFileSync(codexBinary, "");

const codex: Runtime = {
  name: "Codex",
  start: async (turn) => {
    const server = fakeServer({ script: [completed("completed")] });
    const config: CodexTurnConfig = {
      binary: Effect.succeed(codexBinary),
      start: server.start,
      signIn: () => Effect.succeed(null),
      clientVersion: "0.0.0",
      workspaceDir: mkdtempSync(join(temp, "codex-")),
      policy: { engine, sandboxState: "on", sandbox: codexSandbox },
    };
    await Effect.runPromise(Stream.runDrain(runCodexTurn(config, turn)).pipe(Effect.exit));
    const begun = server.requests.find((each) => each.method === "thread/start");
    const text = server.requests.find((each) => each.method === "turn/start");
    const input = (text?.params as { input?: ReadonlyArray<{ text?: string }> } | undefined)?.input ?? [];
    return {
      env: server.commands.at(-1)?.env ?? {},
      instructions: (begun?.params as { developerInstructions?: string } | undefined)?.developerInstructions ?? "",
      prompt: input.map((part) => part.text ?? "").join("\n"),
    };
  },
  refusal: async (tools, command, steering, hubTools) => {
    const turn = toolTurn(tools, "on", { steering: steering ?? null, hubTools: hubTools ?? null }, CODEX_MODEL_HOSTS);
    if (turn === null) throw new Error("expected a tool turn");
    // What the hob reads is the note told to its turn: Codex's own answer to a declined call has no text (#1082).
    const told: Array<string> = [];
    const gate = policyGate(engine, turn, { ...request(tools.commitsAs), tools }, true, "50 millis");
    await Effect.runPromise(
      gate(
        {
          method: "item/commandExecution/requestApproval",
          params: { threadId: THREAD, turnId: TURN, kind: "command", itemId: "c1", command, cwd: project },
        } as PolicyRequest,
        {
          events: codexTurnEvents(THREAD),
          report: () => undefined,
          tell: (_turn, text) => Effect.sync(() => told.push(text)),
        },
      ),
    );
    return told.join("\n");
  },
};

// The fake runtime runs no command, so only its refusals are its own.
const fake: Runtime = {
  name: "the fake runtime",
  start: null,
  refusal: async (tools, command, steering, hubTools) => {
    const turn = {
      ...request(tools.commitsAs),
      tools,
      ...(steering === undefined ? {} : { steering }),
      ...(hubTools === undefined ? {} : { hubTools }),
      prompt: `fake:run ${JSON.stringify({ command, exitCode: 0 })}`,
    };
    const events = await Effect.runPromise(Stream.runCollect(scriptedToolEvents(turn, engine)));
    return [...events].flatMap((event) => (event._tag === "ToolDenied" ? [event.reason] : [])).join("\n");
  },
};

/** Every runtime Hobbots supports. */
const RUNTIMES: ReadonlyArray<Runtime> = [claudeCode, codex, fake];

/**
 * Commits as a command of the turn would, with its environment, in a repository that sets its own
 * `repoEmail` when given, and returns the author or Git's error.
 */
const commitWith = (env: NodeJS.ProcessEnv, repoEmail?: string) => {
  const repo = mkdtempSync(join(temp, "repo-"));
  const run = { ...env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig") };
  execFileSync("git", ["init", "-q"], { cwd: repo, env: run });
  if (repoEmail !== undefined) execFileSync("git", ["config", "user.email", repoEmail], { cwd: repo, env: run });
  try {
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "one"], { cwd: repo, env: run, stdio: "pipe" });
    return execFileSync("git", ["log", "-1", "--format=%an <%ae>"], { cwd: repo, env: run }).toString().trim();
  } catch (error) {
    return `failed: ${String((error as { stderr?: Buffer }).stderr ?? error)}`;
  }
};

const NONE = { name: null, email: null };
const GIVEN = { name: "otaviobarros", email: "35647586+otaviobarros@users.noreply.github.com" };
const CASES: ReadonlyArray<{
  readonly why: string;
  readonly as: CommitsAs;
  /** The user's Git config under the turn's home. */
  readonly config: string;
  /** The email the repository's own config sets, if any. */
  readonly repoEmail?: string;
  readonly commits: RegExp | string;
}> = [
  {
    why: "no identity set yet: no commit, and the hob is told not to ask",
    as: settleCommitsAs(null, NONE, null),
    config: "",
    commits: /^failed: .*no email was given/s,
  },
  {
    why: "the identity the user gave Hobbots",
    as: settleCommitsAs(null, NONE, GIVEN),
    config: "",
    commits: `${GIVEN.name} <${GIVEN.email}>`,
  },
  {
    why: "the identity the user gave Hobbots, though their Git config takes an email from config only",
    as: settleCommitsAs(null, NONE, GIVEN),
    config: "[user]\n\tuseConfigOnly = true\n",
    commits: `${GIVEN.name} <${GIVEN.email}>`,
  },
  {
    why: "a repository's own email over the identity the user gave Hobbots",
    as: settleCommitsAs(null, NONE, GIVEN),
    config: "[user]\n\tuseConfigOnly = true\n",
    repoEmail: "site@example.com",
    commits: `${GIVEN.name} <site@example.com>`,
  },
  {
    why: "the user's own Git config",
    as: settleCommitsAs(null, { name: "Ada Lovelace", email: "ada@example.com" }, GIVEN),
    config: "[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n",
    commits: "Ada Lovelace <ada@example.com>",
  },
];

const BOT = { name: "frodo-hobbots[bot]", email: "90001000+frodo-hobbots[bot]@users.noreply.github.com" };
/** Every way a turn's commits can be made, by who the hub settles they are made as. */
const EVERY_IDENTITY: ReadonlyArray<{ readonly why: string; readonly as: CommitsAs }> = [
  { why: "no identity set yet", as: settleCommitsAs(null, NONE, null) },
  { why: "the identity the user gave Hobbots", as: settleCommitsAs(null, NONE, GIVEN) },
  {
    why: "the user's own Git config",
    as: settleCommitsAs(null, { name: "Ada Lovelace", email: "ada@example.com" }, null),
  },
  { why: "the hob's own bot", as: settleCommitsAs(BOT, NONE, GIVEN) },
];

describe.each(RUNTIMES)("who $name commits as (#741)", (runtime) => {
  // covers OR-004
  it.skipIf(runtime.start === null).each(CASES)(
    "[TC-OR-638] commits as $why, and says so in new and resumed sessions",
    async (each) => {
      if (runtime.start === null) throw new Error("skipped");
      writeFileSync(join(home, ".gitconfig"), each.config);
      const fresh = await runtime.start(request(each.as));
      const commit = commitWith(fresh.env, each.repoEmail);
      if (typeof each.commits === "string") expect(commit).toBe(each.commits);
      else expect(commit).toMatch(each.commits);
      if (each.as._tag === "Missing") expect(fresh.instructions).toContain(NO_GIT_IDENTITY_NOTE);
      if (each.as._tag === "UserGiven") expect(fresh.instructions).toContain(commitIdentityNow(each.as));
      // A resumed session keeps its first instructions, so its prompt says who it commits as now.
      const resumed = await runtime.start(request(each.as, THREAD));
      expect(resumed.prompt).toContain(`<commit-identity>\n${commitIdentityNow(each.as)}\n</commit-identity>`);
    },
  );

  // covers OR-004 (#1213)
  it.skipIf(runtime.start === null).each(EVERY_IDENTITY)(
    "[TC-OR-1213-02] tells the hob up front that Hobbots sets who commits, for $why, in new and resumed sessions",
    async (each) => {
      if (runtime.start === null) throw new Error("skipped");
      const turn = (sessionId: string | null) => {
        const asked = request(each.as, sessionId);
        // The hub hands a hob with its own app its bot, which the runtime commits as (ADR 022).
        return each.as._tag === "Bot" && asked.tools
          ? { ...asked, tools: { ...asked.tools, commitAs: each.as.identity } }
          : asked;
      };
      const fresh = await runtime.start(turn(null));
      expect(fresh.instructions).toContain(SETS_COMMIT_IDENTITY_NOTE);
      const resumed = await runtime.start(turn(THREAD));
      expect(resumed.prompt).toContain(SETS_COMMIT_IDENTITY_NOTE);
    },
  );

  // covers OR-004
  it("[TC-OR-639] refuses a command that sets its own identity, naming who the hub says commits", async () => {
    const command = "git -c user.email=me@example.com commit -m x";
    expect(await runtime.refusal(access(settleCommitsAs(null, NONE, null)), command)).toContain("none is set yet");
    expect(await runtime.refusal(access(settleCommitsAs(null, NONE, GIVEN)), command)).toContain(
      `made as ${GIVEN.name} <${GIVEN.email}>, the identity the user gave Hobbots`,
    );
  });

  // covers OR-004, PE-005 (#742)
  it("[TC-OR-742-02] refuses a commit the hub holds, as a lead's of a member's open work, with whose work it is", async () => {
    const held = `${project} holds changes a member has not committed: LEDGER.md of Task build, which Nettle works on.`;
    const asked: Array<string> = [];
    const lead: CallSteering = {
      takeovers: [],
      holdsCommit: (cwd) =>
        Effect.sync(() => {
          asked.push(cwd);
          return cwd === project ? held : null;
        }),
    };
    const as = settleCommitsAs(null, { name: "Ada Lovelace", email: "ada@example.com" }, null);
    expect(
      await runtime.refusal(access(as), "git add -A && git commit -m 'chore: pocket ledger v0.1'", lead),
    ).toContain(held);
    expect(asked).toEqual([project]);
    // A command that commits nothing is never held, and the hub is not asked about it.
    expect(await runtime.refusal(access(as), "git status", lead)).not.toContain(held);
    expect(asked).toEqual([project]);
  });
});

/**
 * How the hub steers a `git push` for a hob that holds a fake Charm, Acme, which takes Push over from
 * `pushesFrom` (ADR 031): what the registry exposes, as the hub hands it to every runtime.
 */
const acmeSteering = (pushesFrom: ReadonlyArray<string>): Promise<CallSteering> => {
  const tools: ToolAccess = {
    ...access(settleCommitsAs(null, NONE, null)),
    policy: {
      ...access(settleCommitsAs(null, NONE, null)).policy,
      hob: { ...EMPTY_HOB_POLICY, charms: { granted: ["acme"] } },
    },
  };
  return charmTakeoversFor({
    agentId: AgentId.make("hob-1"),
    threadId: null,
    messageId: null,
    scope: () => "",
    currentAccess: Effect.succeed(tools),
    redactor: makeRedactor(),
    approvals: null,
  }).pipe(
    Effect.map((takeovers) => ({ takeovers })),
    Effect.provide(
      Charms.layer([fakeCharm({ id: "acme", name: "Acme", pushesFrom })]).pipe(Layer.provide(memoryCharmCalls())),
    ),
    Effect.runPromise,
  );
};

describe.each(RUNTIMES)("how $name steers a git push a Charm takes over (ADR 031)", (runtime) => {
  // covers PE-005, ADR 031
  it("[TC-PE-513] points a git push to the tool a fake Charm declares, only where its declaration applies", async () => {
    const tools = access(settleCommitsAs(null, NONE, null));
    const command = "pnpm test && git push origin feature";
    expect(await runtime.refusal(tools, command, await acmeSteering([project]))).toContain(
      "Push with the acme_write tool instead of git push: Hobbots pushes your branch to Acme for you, as the user and under your policy.",
    );
    // Where the declaration does not apply, or without the Charm, the push is decided as a push.
    for (const steering of [await acmeSteering([join(temp, "elsewhere")]), undefined]) {
      const refused = await runtime.refusal(tools, command, steering);
      expect(refused).not.toContain("instead of git push");
      expect(refused).toContain("push");
    }
  });
});

/** Hub tools that offer `names` and answer nothing, as a turn's GitHub Charm tools are offered. */
const offering = (names: ReadonlyArray<string>): HubTools => ({
  tools: names.map((name) => ({ name, description: name, inputSchema: { type: "object" }, label: name })),
  call: () => Effect.succeed({ text: "", refused: false }),
});

const GITHUB_CHARM = offering([...GITHUB_TOOLS, ...GITHUB_WRITE_TOOLS].map((tool) => tool.name));

describe.each(RUNTIMES)("how $name steers gh to the GitHub Charm (#1349)", (runtime) => {
  // covers PE-005, SEC-002, ADR 020
  it("[TC-PE-1349-01] refuses gh before it runs, naming the Charm tool for what it tried, also inside env and sh -c", async () => {
    const tools = access(settleCommitsAs(null, NONE, null));
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["gh pr create --fill", "Use the github_open_pull_request tool instead of gh pr create"],
      ["env GH_PAGER=cat gh pr comment 1 --body hi", "Use the github_comment tool instead of gh pr comment"],
      ["sh -c 'gh issue view 1'", "Use the github_item tool instead of gh issue view"],
      ["pnpm test && gh pr list", "Use the github_search tool instead of gh pr list"],
      ["gh issue create -t Parser", "GitHub issues are not available to hobs yet."],
    ];
    for (const [command, pointer] of cases) {
      expect(await runtime.refusal(tools, command, undefined, GITHUB_CHARM), command).toContain(pointer);
    }
    // Without the Charm, gh is refused all the same, and the hob is told to ask the user.
    expect(await runtime.refusal(tools, "gh pr create --fill")).toContain(
      "GitHub goes through the GitHub Charm, whose tools you are not offered now.",
    );
    // A command that runs no gh is decided as before.
    expect(await runtime.refusal(tools, "echo gh pr create", undefined, GITHUB_CHARM)).not.toContain(
      "gh cannot sign in",
    );
  });

  it.skipIf(runtime.start === null)(
    "[TC-PE-1349-02] tells a hob holding the GitHub Charm that GitHub goes through it, and a resumed session again",
    async () => {
      const as = settleCommitsAs(null, NONE, null);
      const start = runtime.start as NonNullable<Runtime["start"]>;
      expect((await start({ ...request(as), hubTools: GITHUB_CHARM })).instructions).toContain(GITHUB_CHARM_NOTE);
      expect((await start({ ...request(as, "session-1"), hubTools: GITHUB_CHARM })).prompt).toContain(
        GITHUB_CHARM_NOTE,
      );
      expect((await start(request(as))).instructions).not.toContain(GITHUB_CHARM_NOTE);
    },
  );
});
