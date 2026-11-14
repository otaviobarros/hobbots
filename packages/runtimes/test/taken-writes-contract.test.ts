import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { Effect, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { callWrites, decideCall } from "../src/approval.ts";
import { policyHooks, toolTurn } from "../src/claude-code.ts";
import type { AppServerNotification } from "../src/codex/app-server.ts";
import { codexTurnEvents } from "../src/codex/events.ts";
import { type PolicyRequest, policyGate } from "../src/codex/policy.ts";
import { CODEX_MODEL_HOSTS } from "../src/codex/turn.ts";
import { scriptedToolEvents } from "../src/fake.ts";

// Issue #1449: once you take over a Task, the hub refuses a hob's writes to the paths and branches
// it took over, whichever runtime makes them. Each runtime Hobbots supports is listed in RUNTIMES
// and passes every case here: a file tool's write, a command's redirection, a push of the branch
// and a commit while it is checked out are refused with the hub's reason, and a read or a write
// elsewhere runs. A new runtime is added to RUNTIMES; it cannot be supported without passing these.

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-taken-writes-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const project = join(temp, "project");
mkdirSync(join(project, "docs"), { recursive: true });
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

interface Runtime {
  readonly name: string;
  /** What the hob is told when the runtime refuses its file tool's write of `path`, or nothing. */
  readonly write: (path: string, steer: CallSteering) => Promise<string>;
  /** What the hob is told when the runtime refuses `command`, or nothing. */
  readonly run: (command: string, steer: CallSteering) => Promise<string>;
}

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

const claudeCode: Runtime = {
  name: "Claude Code",
  write: (path, steer) => claudeHook(steer, "Write", { file_path: path, content: "# Plan\n" }),
  run: (command, steer) => claudeHook(steer, "Bash", { command }),
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

const codex: Runtime = {
  name: "Codex",
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
};

const RUNTIMES: ReadonlyArray<Runtime> = [claudeCode, codex, fake];

describe.each(RUNTIMES)("writes to what you took over, on $name", (runtime) => {
  // covers OR-006, #1449
  it("[TC-OR-1449-01] refuses a file tool's write to a path you took over, and lets one elsewhere run", async () => {
    const asked: Array<CallWrites> = [];
    expect(await runtime.write(PLAN, steering(asked))).toContain(TAKEN);
    expect(asked.at(-1)?.paths).toEqual([PLAN]);
    expect(await runtime.write(join(project, "notes.md"), steering(asked))).not.toContain(TAKEN);
  });

  it("[TC-OR-1449-02] refuses a command that writes there, pushes the branch or commits on it", async () => {
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
});

describe("a write the user approved", () => {
  // covers OR-006, PE-008, #1449
  it("[TC-OR-1449-07] is refused if you took over what it writes while its card waited", async () => {
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
    // A subcommand not known to leave the working tree alone is read as one that may rewrite it.
    expect(bash("git frobnicate")).toEqual([project]);
    expect(bash("git reset HEAD~1; git status; git stash list; git add . && git diff; git branch")).toEqual([]);
  });
});
