import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PromptRequest, type RuntimeEvent, type ToolAccess, UNRECORDED_TOOL_CALL } from "@hobbots/agents";
import { EMPTY_HOB_POLICY, type HobPolicy, type SafetyPreset, type SandboxState } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { toolTurn } from "../src/claude-code.ts";
import type { AppServerNotification } from "../src/codex/app-server.ts";
import { codexTurnEvents } from "../src/codex/events.ts";
import { type PolicyRequest, policyGate, STDIN_REFUSED, shellScript, UNKNOWN_PATCH } from "../src/codex/policy.ts";
import { CODEX_MODEL_HOSTS } from "../src/codex/turn.ts";
import type { CommitsAs } from "../src/git-config.ts";
import { approvalsAnswering as answering, approve } from "./codex-fixture.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-codex-policy-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const project = join(root, "project");
const outside = join(root, "outside");
for (const dir of [project, outside]) mkdirSync(dir);

const engine = Effect.runSync(Effect.service(PolicyEngine).pipe(Effect.provide(PolicyEngine.node)));

const THREAD = "thr-1";
const TURN = "turn-1";

const access = (preset: SafetyPreset = "balanced", hob: HobPolicy = EMPTY_HOB_POLICY): ToolAccess => ({
  policy: { preset, sharedFolders: [project], hob, dataFolder: join(root, "data"), restrictions: [] },
  folders: [project],
  runtimeFolder: join(root, "runtimes", "hob-1"),
});

const approvalsAnswering = (answer: Parameters<typeof answering>[0]) => answering(answer, access("careful"));

const command = (itemId: string, line: string, extra: Record<string, unknown> = {}): PolicyRequest =>
  ({
    method: "item/commandExecution/requestApproval",
    params: { threadId: THREAD, turnId: TURN, kind: "command", itemId, command: line, cwd: project, ...extra },
  }) as PolicyRequest;

const fileChange = (itemId: string): PolicyRequest => ({
  method: "item/fileChange/requestApproval",
  params: { threadId: THREAD, turnId: TURN, itemId },
});

const patchStarted = (itemId: string, changes: ReadonlyArray<Record<string, unknown>>) =>
  ({
    method: "item/started",
    params: { threadId: THREAD, turnId: TURN, item: { type: "fileChange", id: itemId, changes, status: "inProgress" } },
  }) as AppServerNotification;

/** Decides `asked` as a Codex turn's gate would, with what it reported and what Codex was answered. */
const decide = async (
  asked: PolicyRequest,
  options: {
    readonly preset?: SafetyPreset;
    readonly hob?: HobPolicy;
    readonly sandbox?: SandboxState;
    readonly request?: Partial<PromptRequest>;
    readonly before?: ReadonlyArray<AppServerNotification>;
  } = {},
) => {
  const tools = toolTurn(access(options.preset, options.hob), options.sandbox ?? "on", null, CODEX_MODEL_HOSTS);
  if (tools === null) throw new Error("expected a tool turn");
  const events: Array<RuntimeEvent> = [];
  const mapper = codexTurnEvents(THREAD);
  for (const note of options.before ?? []) for (const event of mapper.map(note).events) events.push(event);
  const request = {
    prompt: "",
    sessionId: null,
    instructions: "",
    instructionsChanged: false,
    model: null,
    effort: null,
    ...options.request,
  } satisfies PromptRequest;
  const gate = policyGate(engine, tools, request, true, "50 millis");
  const answer = await Effect.runPromise(gate(asked, { events: mapper, report: (event) => events.push(event) }));
  return { answer, events, mapper };
};

describe("Codex's tool calls under the hob's policy", () => {
  // covers EX-004, ADR 024
  it("[TC-RT-061] records an allowed command before it runs, then streams its output to the Workbench", async () => {
    const recorded: Array<RuntimeEvent> = [];
    const { answer, events, mapper } = await decide(command("c1", "/bin/bash -lc 'ls -la'"), {
      request: { recordToolStart: (event) => Effect.sync(() => recorded.push(event) > 0) },
    });
    expect(answer).toEqual({ decision: "accept" });
    // The record is the start: nothing is reported twice.
    expect(events).toEqual([]);
    expect(recorded).toEqual([
      {
        _tag: "ToolStarted",
        id: "c1",
        tool: "Bash",
        operation: "run-commands",
        targets: [project],
        label: "Running ls -la",
        command: { line: "ls -la", folder: project, sandboxed: true, liveOutput: true },
      },
    ]);
    // The call is followed from now on: its streamed output and its end reach the Workbench.
    expect(
      mapper.map({
        method: "item/commandExecution/outputDelta",
        params: { threadId: THREAD, turnId: TURN, itemId: "c1", delta: "total 0\n" },
      }).events,
    ).toEqual([{ _tag: "ToolOutput", id: "c1", text: "total 0\n" }]);
  });

  // covers EX-004
  it("[TC-RT-062] declines a call Hobbots could not record, with the reason", async () => {
    const { answer, events } = await decide(command("c1", "/bin/bash -lc 'ls'"), {
      request: { recordToolStart: () => Effect.succeed(false) },
    });
    expect(answer).toEqual({ decision: "decline" });
    expect(events).toEqual([expect.objectContaining({ _tag: "ToolDenied", id: "c1", reason: UNRECORDED_TOOL_CALL })]);
  });

  // covers PE-003, PE-008
  it("[TC-RT-063] holds a command the policy asks about until the user allows it, then runs it", async () => {
    const { asked, approvals } = approvalsAnswering(approve);
    const { answer, events } = await decide(command("c1", "/bin/bash -lc 'pnpm test'"), {
      preset: "careful",
      request: { approvals },
    });
    expect(answer).toEqual({ decision: "accept" });
    expect(asked).toEqual([
      expect.objectContaining({
        stepId: "c1",
        tool: "Bash",
        operation: "run-commands",
        arguments: { command: "pnpm test" },
      }),
    ]);
    expect(events.map((event) => event._tag)).toEqual(["ToolAwaitingApproval", "ToolStarted"]);
    expect(events[1]).toMatchObject({ id: "c1", label: "Running pnpm test" });

    // Denied, Codex hears it was declined; the step keeps the user's reason.
    const denied = approvalsAnswering(() => Effect.succeed({ _tag: "Denied", reason: "Not today" }));
    const refused = await decide(command("c2", "/bin/bash -lc 'pnpm test'"), {
      preset: "careful",
      request: { approvals: denied.approvals },
    });
    expect(refused.answer).toEqual({ decision: "decline" });
    expect(refused.events.at(-1)).toMatchObject({ _tag: "ToolDenied", decidedBy: "user" });
    expect(refused.events.at(-1)).toHaveProperty("reason", expect.stringContaining("Not today"));

    // With nobody to ask, Ask is refused.
    const alone = await decide(command("c3", "/bin/bash -lc 'pnpm test'"), { preset: "careful" });
    expect(alone.answer).toEqual({ decision: "decline" });
  });

  // covers PE-001, PE-005
  it("[TC-RT-064] declines what the policy never allows, and every command without the sandbox", async () => {
    const outsideFolder = await decide(command("c1", `/bin/bash -lc 'rm -rf ${outside}/x'`));
    expect(outsideFolder.answer).toEqual({ decision: "decline" });
    expect(outsideFolder.events).toEqual([
      expect.objectContaining({ _tag: "ToolDenied", operation: "outside-folders", decidedBy: "policy" }),
    ]);
    const unsandboxed = await decide(command("c2", "/bin/bash -lc 'ls'"), { sandbox: "unavailable" });
    expect(unsandboxed.answer).toEqual({ decision: "decline" });
    expect(unsandboxed.events).toEqual([expect.objectContaining({ _tag: "ToolDenied", operation: "run-commands" })]);
    // Typing into a running command is never let through.
    const stdin = await decide(command("c3", "/bin/bash -lc 'cat'", { kind: "writeStdin" }));
    expect(stdin.answer).toEqual({ decision: "decline" });
    expect(stdin.events).toEqual([expect.objectContaining({ _tag: "ToolDenied", reason: STDIN_REFUSED })]);
  });

  // covers OR-004
  it("[TC-RT-1020] refuses a command that sets its own commit identity, saying none is set yet when there is none (#741)", async () => {
    const offered = toolTurn(access(), "on", null, CODEX_MODEL_HOSTS);
    if (offered === null) throw new Error("expected a tool turn");
    const asked = command("c1", "/bin/bash -lc 'git -c user.email=me@example.com commit -m x'");
    const refusedWith = async (commitsAs: CommitsAs) => {
      const events: Array<RuntimeEvent> = [];
      const gate = policyGate(
        engine,
        { ...offered, commitsAs },
        { prompt: "", sessionId: null, instructions: "", instructionsChanged: false, model: null, effort: null },
        true,
        "50 millis",
      );
      const answer = await Effect.runPromise(
        gate(asked, { events: codexTurnEvents(THREAD), report: (event) => events.push(event) }),
      );
      expect(answer).toEqual({ decision: "decline" });
      return events.find((event) => event._tag === "ToolDenied")?.reason ?? "";
    };
    expect(await refusedWith({ _tag: "Missing" })).toContain("none is set yet");
    expect(await refusedWith({ _tag: "UserGiven", identity: { name: "Ada", email: "ada@example.com" } })).toContain(
      "made as Ada <ada@example.com>, the identity the user gave Hobbots",
    );
  });

  // covers PE-001, PE-003, ADR 024
  it("[TC-RT-065] decides a file change on every file it touches, and shows the user its diff", async () => {
    const inside = [{ path: join(project, "a.txt"), kind: { type: "add" }, diff: "hello\n" }];
    const allowed = await decide(fileChange("f1"), { before: [patchStarted("f1", inside)] });
    expect(allowed.answer).toEqual({ decision: "accept" });
    expect(allowed.events).toEqual([
      expect.objectContaining({
        _tag: "ToolStarted",
        tool: "apply_patch",
        operation: "edit-files",
        label: "Editing a.txt",
        targets: [join(project, "a.txt")],
      }),
    ]);

    // A move out of the folders is outside them, whatever the file it starts from.
    const moved = [
      { path: join(project, "a.txt"), kind: { type: "update", move_path: join(outside, "a.txt") }, diff: "" },
    ];
    const away = await decide(fileChange("f2"), { before: [patchStarted("f2", moved)] });
    expect(away.answer).toEqual({ decision: "decline" });
    expect(away.events).toEqual([expect.objectContaining({ _tag: "ToolDenied", operation: "outside-folders" })]);

    const { asked, approvals } = approvalsAnswering(approve);
    const careful = await decide(fileChange("f3"), {
      preset: "careful",
      request: { approvals },
      before: [patchStarted("f3", inside)],
    });
    expect(careful.answer).toEqual({ decision: "accept" });
    expect(asked[0]?.arguments).toEqual({ changes: [{ path: join(project, "a.txt"), kind: "add", diff: "hello\n" }] });

    // A change whose files Codex never named does not run.
    const unknown = await decide(fileChange("f4"));
    expect(unknown.answer).toEqual({ decision: "decline" });
    expect(unknown.events).toEqual([expect.objectContaining({ _tag: "ToolDenied", reason: UNKNOWN_PATCH })]);
  });

  // covers PE-001, PE-003, STD-SEC-002
  it("[TC-RT-070] decides a file change that deletes a file as a deletion, alone or with edits", async () => {
    const removed = { path: join(project, "old.txt"), kind: { type: "delete" }, diff: "" };
    const added = { path: join(project, "new.txt"), kind: { type: "add" }, diff: "hi\n" };

    // Balanced allows edits but asks before a deletion.
    for (const [id, changes] of [
      ["d1", [removed]],
      ["d2", [added, removed]],
    ] as const) {
      const { asked, approvals } = answering(approve, access());
      const result = await decide(fileChange(id), { request: { approvals }, before: [patchStarted(id, changes)] });
      expect(result.answer).toEqual({ decision: "accept" });
      expect(asked).toEqual([expect.objectContaining({ stepId: id, operation: "delete-files" })]);
      expect(result.events.map((event) => event._tag)).toEqual(["ToolAwaitingApproval", "ToolStarted"]);
      expect(result.events[1]).toMatchObject({ label: id === "d1" ? "Deleting old.txt" : "Editing 2 files" });
    }

    // With nobody to ask, the deletion does not run, nor the edits that come with it.
    const alone = await decide(fileChange("d3"), { before: [patchStarted("d3", [added, removed])] });
    expect(alone.answer).toEqual({ decision: "decline" });
    expect(alone.events).toEqual([expect.objectContaining({ _tag: "ToolDenied", operation: "delete-files" })]);

    // A hob that may never delete has a deleting patch refused, even with nobody to ask.
    const never = await decide(fileChange("d4"), {
      hob: { ...EMPTY_HOB_POLICY, overrides: { "delete-files": "deny" } },
      before: [patchStarted("d4", [added, removed])],
    });
    expect(never.answer).toEqual({ decision: "decline" });
    expect(never.events).toEqual([
      expect.objectContaining({ _tag: "ToolDenied", operation: "delete-files", decidedBy: "policy" }),
    ]);

    // An edit alone still runs without asking.
    const edit = await decide(fileChange("d5"), { before: [patchStarted("d5", [added])] });
    expect(edit.answer).toEqual({ decision: "accept" });
  });

  // covers ADR 024
  it("[TC-RT-066] decides the script inside Codex's shell wrapper, and any other line as it is", () => {
    expect(shellScript("/bin/bash -lc 'git status && ls'")).toBe("git status && ls");
    expect(shellScript(`/bin/zsh -c 'echo '"'"'hi'"'"''`)).toBe("echo 'hi'");
    expect(shellScript("/bin/bash -lc ls")).toBe("ls");
    expect(shellScript("/bin/bash -lc 'ls' ; rm -rf x")).toBe("/bin/bash -lc 'ls' ; rm -rf x");
    expect(shellScript("python3 -c 'print(1)'")).toBe("python3 -c 'print(1)'");
  });
});
