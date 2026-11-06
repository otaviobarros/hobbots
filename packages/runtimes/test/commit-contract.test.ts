import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { PromptRequest, RuntimeEvent, ToolAccess } from "@hobbots/agents";
import { type CommitsAs, EMPTY_HOB_POLICY, settleCommitsAs } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { claudeTurnStart, policyHooks, toolTurn } from "../src/claude-code.ts";
import { codexTurnEvents } from "../src/codex/events.ts";
import { type PolicyRequest, policyGate } from "../src/codex/policy.ts";
import { CODEX_MODEL_HOSTS, type CodexTurnConfig, runCodexTurn } from "../src/codex/turn.ts";
import { scriptedToolEvents } from "../src/fake.ts";
import { commitIdentityNow, NO_GIT_IDENTITY_NOTE } from "../src/git-config.ts";
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
  /** Why the runtime refuses `command`, which sets its own commit identity. */
  readonly refusal: (tools: ToolAccess, command: string) => Promise<string>;
}

const BASE_ENV = { PATH: process.env.PATH } satisfies NodeJS.ProcessEnv;

const claudeCode: Runtime = {
  name: "Claude Code",
  start: async (turn) => {
    const started = claudeTurnStart(turn, "on", true);
    return { env: started.commits.env(BASE_ENV), instructions: started.instructions, prompt: started.prompt };
  },
  refusal: async (tools, command) => {
    const turn = toolTurn(tools, "on");
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
  refusal: async (tools, command) => {
    const turn = toolTurn(tools, "on", null, CODEX_MODEL_HOSTS);
    if (turn === null) throw new Error("expected a tool turn");
    const events: Array<RuntimeEvent> = [];
    const gate = policyGate(engine, turn, { ...request(tools.commitsAs), tools }, true, "50 millis");
    await Effect.runPromise(
      gate(
        {
          method: "item/commandExecution/requestApproval",
          params: { threadId: THREAD, turnId: TURN, kind: "command", itemId: "c1", command, cwd: project },
        } as PolicyRequest,
        { events: codexTurnEvents(THREAD), report: (event) => events.push(event) },
      ),
    );
    return events.flatMap((event) => (event._tag === "ToolDenied" ? [event.reason] : [])).join("\n");
  },
};

// The fake runtime runs no command, so only its refusals are its own.
const fake: Runtime = {
  name: "the fake runtime",
  start: null,
  refusal: async (tools, command) => {
    const turn = { ...request(tools.commitsAs), tools, prompt: `fake:run ${JSON.stringify({ command, exitCode: 0 })}` };
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

  // covers OR-004
  it("[TC-OR-639] refuses a command that sets its own identity, naming who the hub says commits", async () => {
    const command = "git -c user.email=me@example.com commit -m x";
    expect(await runtime.refusal(access(settleCommitsAs(null, NONE, null)), command)).toContain("none is set yet");
    expect(await runtime.refusal(access(settleCommitsAs(null, NONE, GIVEN)), command)).toContain(
      `made as ${GIVEN.name} <${GIVEN.email}>, the identity the user gave Hobbots`,
    );
  });
});
