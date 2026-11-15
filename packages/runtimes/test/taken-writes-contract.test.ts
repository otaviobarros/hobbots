import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import {
  type ApprovalOutcome,
  actionDigest,
  type CallSteering,
  type CallWrites,
  type PromptRequest,
  type ToolAccess,
  type TurnApprovals,
} from "@hobbots/agents";
import { ApprovalId, EMPTY_HOB_POLICY } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect, Layer, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { callWrites, decideCall } from "../src/approval.ts";
import { makeClaudeCode, policyHooks, toolTurn } from "../src/claude-code.ts";
import type { AppServerNotification } from "../src/codex/app-server.ts";
import { codexTurnEvents } from "../src/codex/events.ts";
import { type PolicyRequest, policyGate } from "../src/codex/policy.ts";
import { CODEX_MODEL_HOSTS, type CodexTurnConfig, runCodexTurn } from "../src/codex/turn.ts";
import { scriptedToolEvents } from "../src/fake.ts";
import { ProcessSandbox, type ProcessSandboxShape, type SandboxScope, sandboxFilesystem } from "../src/sandbox.ts";
import { completed, fakeServer } from "./codex-app-server.ts";

// Issue #1449: once you take over a Task, the hub refuses a hob's writes to the paths and branches
// it took over, whichever runtime makes them. Each runtime Hobbots supports is listed in RUNTIMES
// and passes every case here: a file tool's write, a command's redirection, a push of the branch
// and a commit while it is checked out are refused with the hub's reason, and a read or a write
// elsewhere runs. Once you give them back (#1538), the next call goes through. A write the hub cannot
// read from the call, such as one a test script makes, fails in the turn's sandbox (#1537). A new
// runtime is added to RUNTIMES; it cannot be supported without passing these.

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-taken-writes-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const project = join(temp, "project");
mkdirSync(join(project, "docs"), { recursive: true });
// A repository, as a hob's folder usually is: the sandbox closes its Git hooks and config.
execFileSync("git", ["init", "-q", project]);
mkdirSync(join(project, ".git", "hooks"), { recursive: true });
const engine = Effect.runSync(Effect.service(PolicyEngine).pipe(Effect.provide(PolicyEngine.node)));

const access: ToolAccess = {
  policy: {
    preset: "balanced",
    sharedFolders: [project],
    hob: EMPTY_HOB_POLICY,
    dataFolder: join(temp, "data"),
    restrictions: [],
  },
  folders: [project],
  runtimeFolder: join(temp, "runtimes", "hob-1"),
  commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
};

const request: PromptRequest = {
  prompt: "Write the plan",
  sessionId: null,
  instructions: "",
  instructionsChanged: false,
  model: null,
  effort: null,
  tools: access,
};

const TAKEN =
  "The user took over path docs in github.com/me/app from Task build, so Hobbots refuses your writes to it.";
const PLAN = join(project, "docs", "plan.md");

/** The hub's side, as the claims register answers it: `docs` and branch `feat/shop` are yours. */
const steering = (asked: Array<CallWrites>): CallSteering => ({
  takeovers: [],
  takenByYou: (writes) =>
    Effect.sync(() => {
      asked.push(writes);
      const yours =
        writes.paths.some((path) => path.startsWith(join(project, "docs"))) ||
        writes.pushes.some((push) => push.branch === "feat/shop") ||
        writes.commits.length > 0;
      return yours ? TAKEN : null;
    }),
});

/** What a script that writes files the call does not name did, in the turn's sandbox. */
interface HiddenRun {
  /** Which of the files it meant to write it wrote, by path inside the project. */
  readonly written: ReadonlyArray<string>;
  /** What it printed, as the hob reads it. */
  readonly output: string;
}

interface Runtime {
  readonly name: string;
  /** What the hob is told when the runtime refuses its file tool's write of `path`, or nothing. */
  readonly write: (path: string, steer: CallSteering) => Promise<string>;
  /** What the hob is told when the runtime refuses `command`, or nothing. */
  readonly run: (command: string, steer: CallSteering) => Promise<string>;
  /**
   * Runs `pnpm test` in a turn given `tools`, a script that writes each of `files` (paths inside the
   * project) without its command naming any, as the turn's sandbox lets it (#1537).
   */
  readonly hidden: (tools: ToolAccess, files: ReadonlyArray<string>) => Promise<HiddenRun>;
}

// The real OS sandbox runs on macOS, and on Linux with HOBBOTS_SANDBOX_TESTS=1 where bubblewrap,
// socat and sandbox-runtime's seccomp helper are installed (as in sandbox-hub.test.ts). Elsewhere a
// script's writes are read from the rules the turn's sandbox starts with.
const osSandbox = process.platform === "darwin" || process.env.HOBBOTS_SANDBOX_TESTS === "1";

/** A sandbox that records the scope each turn starts it with, and starts nothing. */
const recordingSandbox = (scopes: Array<Omit<SandboxScope, "tempFolder">>): ProcessSandboxShape => ({
  state: "on",
  evidence: "a stand-in sandbox",
  prepare: (scope) =>
    Effect.sync(() => {
      scopes.push(scope);
      return {
        spawnArgs: (command, args, env) => ({ command: "/sandbox", args: [command, ...args], env }),
        release: () => {},
      };
    }),
});

/**
 * What a script writing `files` does in a sandbox started with `scope`, the one a runtime started
 * its turn with: run in the real OS sandbox where it starts, else read from the sandbox's rules,
 * where a file under a path it closes to writes is not written.
 */
const scriptIn = async (scope: Omit<SandboxScope, "tempFolder">, files: ReadonlyArray<string>): Promise<HiddenRun> => {
  if (!osSandbox) {
    const closed = sandboxFilesystem({ ...scope, tempFolder: join(temp, "tmp") }).denyWrite.map((entry) =>
      typeof entry === "string" ? entry : entry.path,
    );
    const shut = (file: string) =>
      closed.some((path) => join(project, file) === path || join(project, file).startsWith(`${path}/`));
    return {
      written: files.filter((file) => !shut(file)),
      output: files
        .filter(shut)
        .map((file) => `${file}: Operation not permitted\n`)
        .join(""),
    };
  }
  for (const file of files) rmSync(join(project, file), { force: true });
  const script = files.map((file) => `printf hidden > '${file}'`).join("; ");
  const output = await Effect.gen(function* () {
    const sandbox = yield* ProcessSandbox;
    return yield* Effect.acquireUseRelease(
      sandbox.prepare(scope),
      (prepared) =>
        Effect.promise(() => {
          const spawn = prepared.spawnArgs("/bin/sh", ["-c", script], { PATH: "/usr/bin:/bin" });
          return promisify(execFile)(spawn.command, [...spawn.args], { cwd: project, env: spawn.env }).then(
            ({ stderr }) => stderr,
            (error: { stderr?: string }) => error.stderr ?? "",
          );
        }),
      (prepared) => Effect.sync(prepared.release),
    );
  }).pipe(Effect.provide(ProcessSandbox.layer), Effect.scoped, Effect.runPromise);
  return {
    written: files.filter(
      (file) => existsSync(join(project, file)) && readFileSync(join(project, file), "utf8") === "hidden",
    ),
    output,
  };
};

/** A stand-in runtime binary, in a folder of its own: the sandbox opens the binary's folder read-only. */
const stub = (name: string, script: string) => {
  const path = join(temp, "bin", name);
  mkdirSync(join(temp, "bin"), { recursive: true });
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
};

/** Claude Code's PreToolUse hook, as the SDK calls it, and the reason it gives for a refusal. */
const claudeHook = async (steer: CallSteering, tool: string, input: Record<string, unknown>) => {
  const turn = toolTurn(access, "on", { steering: steer, hubTools: null });
  if (turn === null) throw new Error("expected a tool turn");
  const [pre] = policyHooks(engine, turn, () => undefined).hooks.PreToolUse?.[0]?.hooks ?? [];
  const output = await pre?.(
    {
      session_id: "s",
      transcript_path: "",
      cwd: project,
      tool_name: tool,
      tool_input: input,
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
};

// A stand-in Claude Code that reports a current version; the turn stops once its sandbox is prepared.
const claudeBinary = stub("claude", '#!/bin/sh\necho "2.1.999 (Claude Code)"\n');

const claudeCode: Runtime = {
  name: "Claude Code",
  write: (path, steer) => claudeHook(steer, "Write", { file_path: path, content: "# Plan\n" }),
  run: (command, steer) => claudeHook(steer, "Bash", { command }),
  hidden: async (tools, files) => {
    const scopes: Array<Omit<SandboxScope, "tempFolder">> = [];
    const signIn = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    // A sign-in in the hub's environment keeps the turn from reading the user's own.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "claude-sign-in";
    try {
      const adapter = await Effect.runPromise(
        makeClaudeCode({ workspaceDir: join(temp, "claude-workspace"), executable: claudeBinary }).pipe(
          Effect.provide(
            Layer.mergeAll(
              PolicyEngine.node,
              Layer.succeed(ProcessSandbox, ProcessSandbox.of(recordingSandbox(scopes))),
            ),
          ),
        ),
      );
      // The stand-in cannot run a session: the turn fails once it starts, after its sandbox is prepared.
      await Effect.runPromise(Stream.runDrain(adapter.sendPrompt({ ...request, tools })).pipe(Effect.exit));
    } finally {
      if (signIn === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = signIn;
    }
    const scope = scopes[0];
    if (scope === undefined) throw new Error("expected Claude Code to start in the sandbox");
    return scriptIn(scope, files);
  },
};

/** What a Codex turn's gate tells the hob after deciding `asked`: Codex's own decline has no text (#1082). */
const codexTold = async (steer: CallSteering, asked: PolicyRequest, before: ReadonlyArray<AppServerNotification>) => {
  const turn = toolTurn(access, "on", { steering: steer, hubTools: null }, CODEX_MODEL_HOSTS);
  if (turn === null) throw new Error("expected a tool turn");
  const mapper = codexTurnEvents("thr-1");
  for (const note of before) mapper.map(note);
  const told: Array<string> = [];
  const gate = policyGate(engine, turn, request, true, "50 millis");
  await Effect.runPromise(
    gate(asked, {
      events: mapper,
      report: () => undefined,
      tell: (_turn, text) => Effect.sync(() => told.push(text)),
    }),
  );
  return told.join("\n");
};

const codexBinary = stub("codex", "#!/bin/sh\n");

const codex: Runtime = {
  name: "Codex",
  hidden: async (tools, files) => {
    const scopes: Array<Omit<SandboxScope, "tempFolder">> = [];
    const server = fakeServer({ script: [completed("completed")] });
    const config: CodexTurnConfig = {
      binary: Effect.succeed(codexBinary),
      start: server.start,
      signIn: () => Effect.succeed(null),
      clientVersion: "0.0.0",
      workspaceDir: mkdtempSync(join(temp, "codex-")),
      policy: { engine, sandboxState: "on", sandbox: recordingSandbox(scopes) },
    };
    await Effect.runPromise(Stream.runDrain(runCodexTurn(config, { ...request, tools })).pipe(Effect.exit));
    const scope = scopes[0];
    if (scope === undefined) throw new Error("expected Codex to start in the sandbox");
    return scriptIn(scope, files);
  },
  write: (path, steer) =>
    codexTold(
      steer,
      { method: "item/fileChange/requestApproval", params: { threadId: "thr-1", turnId: "turn-1", itemId: "f1" } },
      [
        {
          method: "item/started",
          params: {
            threadId: "thr-1",
            turnId: "turn-1",
            item: {
              type: "fileChange",
              id: "f1",
              changes: [{ path, kind: { type: "add" }, diff: "# Plan\n" }],
              status: "inProgress",
            },
          },
        } as AppServerNotification,
      ],
    ),
  run: (command, steer) =>
    codexTold(
      steer,
      {
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thr-1", turnId: "turn-1", kind: "command", itemId: "c1", command, cwd: project },
      } as PolicyRequest,
      [],
    ),
};

/** The reasons the fake runtime gives for the calls of `prompt` it refuses. */
const fakeRefusals = async (steer: CallSteering, prompt: string) => {
  const events = await Effect.runPromise(
    Stream.runCollect(scriptedToolEvents({ ...request, steering: steer, prompt }, engine)),
  );
  return [...events].flatMap((event) => (event._tag === "ToolDenied" ? [event.reason] : [])).join("\n");
};

const fake: Runtime = {
  name: "the fake runtime",
  write: (path, steer) => fakeRefusals(steer, `fake:write ${path} "# Plan"`),
  run: (command, steer) => fakeRefusals(steer, `fake:run ${JSON.stringify({ command, exitCode: 0 })}`),
  hidden: async (tools, files) => {
    for (const file of files) rmSync(join(project, file), { force: true });
    const writes = Object.fromEntries(files.map((file) => [file, "hidden"]));
    const events = await Effect.runPromise(
      Stream.runCollect(
        scriptedToolEvents(
          { ...request, tools, prompt: `fake:run ${JSON.stringify({ command: "pnpm test", writes })}` },
          engine,
        ),
      ),
    );
    return {
      written: files.filter(
        (file) => existsSync(join(project, file)) && readFileSync(join(project, file), "utf8") === "hidden",
      ),
      output: [...events].flatMap((event) => (event._tag === "ToolFinished" ? [event.output ?? ""] : [])).join(""),
    };
  },
};

const RUNTIMES: ReadonlyArray<Runtime> = [claudeCode, codex, fake];

describe.each(RUNTIMES)("writes to what you took over, on $name", (runtime) => {
  // Issue #1449
  it("refuses a file tool's write to a path you took over, and lets one elsewhere run (#1449)", async () => {
    const asked: Array<CallWrites> = [];
    expect(await runtime.write(PLAN, steering(asked))).toContain(TAKEN);
    expect(asked.at(-1)?.paths).toEqual([PLAN]);
    expect(await runtime.write(join(project, "notes.md"), steering(asked))).not.toContain(TAKEN);
  });

  it("refuses a command that writes there, pushes the branch or commits on it (#1449)", async () => {
    const asked: Array<CallWrites> = [];
    expect(await runtime.run(`echo plan > ${PLAN}`, steering(asked))).toContain(TAKEN);
    expect(asked.at(-1)?.paths).toEqual([PLAN]);
    expect(await runtime.run("git push origin feat/shop", steering(asked))).toContain(TAKEN);
    expect(asked.at(-1)?.pushes).toEqual([{ cwd: project, branch: "feat/shop" }]);
    expect(await runtime.run("git commit -m 'docs: plan'", steering(asked))).toContain(TAKEN);
    expect(asked.at(-1)?.commits).toEqual([project]);
    // A command that writes nothing is never refused, and the hub is not asked about it.
    const before = asked.length;
    expect(await runtime.run(`cat ${PLAN}`, steering(asked))).not.toContain(TAKEN);
    expect(asked).toHaveLength(before);
  });

  // Issue #1538
  it("lets a write through once you give back what it writes, asking the hub on every call (#1538)", async () => {
    const asked: Array<CallWrites> = [];
    let yours = true;
    const live: CallSteering = {
      takeovers: [],
      takenByYou: (writes) =>
        Effect.sync(() => {
          asked.push(writes);
          return yours ? TAKEN : null;
        }),
    };
    expect(await runtime.write(PLAN, live)).toContain(TAKEN);
    expect(await runtime.run(`echo plan > ${PLAN}`, live)).toContain(TAKEN);
    // You gave it back: the same session's next calls go through, with nothing kept from before.
    yours = false;
    const before = asked.length;
    expect(await runtime.write(PLAN, live)).not.toContain(TAKEN);
    expect(await runtime.run(`echo plan > ${PLAN}`, live)).not.toContain(TAKEN);
    expect(asked.length).toBe(before + 2);
  });
});

describe.each(RUNTIMES)("writes the hub cannot read from the call, on $name", (runtime) => {
  // Issue #1537
  it("fails a script's write to a path you took over in the turn's sandbox, and makes its others (#1537)", async () => {
    const files = ["docs/plan.md", "notes.md"];
    const taken = { ...access, taken: [join(project, "docs")] };
    const run = await runtime.hidden(taken, files);
    expect(run.written).toEqual(["notes.md"]);
    expect(run.output).toMatch(/docs\/plan\.md.*(Operation not permitted|Read-only file system)/);
    // Given back, the next turn's sandbox lets the same script write both.
    expect((await runtime.hidden(access, files)).written).toEqual(files);
  });
});

describe("a write the user approved", () => {
  // Issue #1449
  it("is refused if you took over what it writes while its card waited (#1449)", async () => {
    const careful = { ...access, policy: { ...access.policy, preset: "careful" as const } };
    const turn = toolTurn(careful, "on");
    if (turn === null) throw new Error("expected a tool turn");
    const approvals: TurnApprovals = {
      request: (action) =>
        Effect.succeed({
          approvalId: ApprovalId.make("approval-1"),
          decision: Effect.map(
            actionDigest(action),
            (digest): ApprovalOutcome => ({
              _tag: "Approved",
              actionDigest: digest,
              policyVersion: action.policyVersion,
              lifetime: "once",
            }),
          ),
        }),
      currentAccess: Effect.succeed(careful),
      grants: Effect.succeed([]),
      used: () => Effect.void,
    };
    const decide = (answers: Array<string | null>) =>
      Effect.runPromise(
        decideCall(
          engine,
          turn.context,
          approvals,
          { id: "t1", tool: "Write", input: { file_path: PLAN, content: "# Plan\n" }, cwd: project },
          () => undefined,
          { commitsAs: access.commitsAs, takenByYou: () => Effect.succeed(answers.shift() ?? null) },
        ),
      );
    // Nothing was yours when it asked, and nothing is when you approve: it runs.
    expect((await decide([null, null]))._tag).toBe("Run");
    // You took it over while it waited: your approval does not let it overwrite your file.
    expect(await decide([null, TAKEN])).toMatchObject({ _tag: "Refuse", reason: TAKEN });
  });
});

describe("what a call writes", () => {
  it("reads relative file paths against the call's folder, and a patch's every file", () => {
    expect(callWrites({ id: "1", tool: "Edit", input: { file_path: "docs/plan.md" }, cwd: project }).paths).toEqual([
      PLAN,
    ]);
    const patch = callWrites({
      id: "2",
      tool: "apply_patch",
      input: {
        changes: [
          { path: PLAN, kind: "update" },
          { path: join(project, "old.md"), kind: "delete" },
        ],
      },
      cwd: project,
    });
    expect(patch.paths).toEqual([PLAN, join(project, "old.md")]);
    // A `..` after a link is kept for the hub, which follows the link first, as the write lands.
    expect(
      callWrites({ id: "4", tool: "Write", input: { file_path: "link/../plan.md", content: "" }, cwd: project }).paths,
    ).toEqual([`${join(project, "link")}/../plan.md`]);
    expect(callWrites({ id: "3", tool: "Read", input: { file_path: PLAN }, cwd: project })).toEqual({
      paths: [],
      pushes: [],
      commits: [],
      trees: [],
    });
    // A relative write is joined to the folder it is written from, after any `cd`.
    const writes = (command: string) => callWrites({ id: "6", tool: "Bash", input: { command }, cwd: project }).paths;
    expect(writes("echo x > docs/plan.md")).toEqual([`${project}/docs/plan.md`]);
    expect(writes("cp a.md docs/plan.md")).toEqual([`${project}/a.md`, `${project}/docs/plan.md`]);
    expect(writes("cd docs && touch plan.md")).toEqual([`${project}/docs/plan.md`]);
    // A redirection opens its file in the shell's folder after a `cd`, and a bare one writes too.
    expect(writes("cd docs && printf changed > plan.md")).toEqual([`${project}/docs/plan.md`]);
    expect(writes("cd docs; >plan.md 2>&1")).toEqual([`${project}/docs/plan.md`]);
    // A redirection written against the word before it still writes its file.
    expect(writes("printf changed>docs/plan.md")).toEqual([`${project}/docs/plan.md`]);
    // A line run by `eval` or `sh -c` writes too.
    expect(writes("eval 'printf changed > docs/plan.md'")).toEqual([`${project}/docs/plan.md`]);
    expect(writes("cd docs && sh -c 'touch plan.md'")).toEqual([`${project}/docs/plan.md`]);
    expect(writes('echo "x">>docs/plan.md 2>&1')).toEqual([`${project}/docs/plan.md`]);
    // A Git command that rewrites the working tree is named by its folder, whichever files it reaches.
    const bash = (command: string) => callWrites({ id: "5", tool: "Bash", input: { command }, cwd: project }).trees;
    expect(bash("git reset --hard HEAD")).toEqual([project]);
    expect(bash("git -C web checkout -- .")).toEqual([join(project, "web")]);
    expect(bash("git clean -fd && git stash")).toEqual([project]);
    expect(bash("git checkout-index -f -a")).toEqual([project]);
    // An explicit work tree is reached too, and a branch move counts as a rewrite.
    expect(bash("git --work-tree=/other reset --hard")).toEqual(expect.arrayContaining(["/other", project]));
    expect(bash("git switch taken && git commit -am x")).toEqual([project]);
    expect(bash("git branch -f taken HEAD")).toEqual([project]);
    expect(bash("git branch -Df taken")).toEqual([project]);
    expect(bash("git branch --force taken HEAD")).toEqual([project]);
    expect(bash("git fetch --force origin HEAD:refs/heads/taken")).toEqual([project]);
    expect(bash("git -c remote.origin.fetch=+refs/heads/main:refs/heads/taken fetch origin")).toEqual([project]);
    expect(bash("git fetch --refmap=+refs/heads/source:refs/heads/taken origin source")).toEqual([project]);
    expect(bash("git fetch --refmap +refs/heads/source:refs/heads/taken origin")).toEqual([project]);
    // A subcommand not known to leave the working tree alone is read as one that may rewrite it.
    expect(bash("git frobnicate")).toEqual([project]);
    // Every reset may move the checked-out branch, `--soft` and the default mode included.
    expect(bash("git reset --soft HEAD~1")).toEqual([project]);
    expect(bash("git status; git stash list; git add . && git diff; git branch; git fetch origin")).toEqual([]);
  });
});
