import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import {
  type ApprovalAction,
  type ApprovalOutcome,
  actionDigest,
  type RuntimeEvent,
  type ToolAccess,
  type TurnApprovals,
} from "@hobbots/agents";
import { ApprovalId, EMPTY_HOB_POLICY, type HobPolicy } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { adoptSession, parseKeychainLogin, policyHooks, toolTurn } from "../src/claude-code.ts";
import { makeFakeRuntime } from "../src/fake.ts";
import { decideForLiveTurns, ProcessSandbox, sandboxEnv, sandboxFilesystem, sandboxGitConfig } from "../src/sandbox.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-hooks-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const project = join(root, "project");
const outside = join(root, "outside");
const data = join(root, "data");
const runtimes = join(root, "runtimes");
for (const dir of [project, outside, data, runtimes]) mkdirSync(dir);
writeFileSync(join(project, "a.ts"), "export {};\n");

const engine = Effect.runSync(
  Effect.gen(function* () {
    return yield* PolicyEngine;
  }).pipe(Effect.provide(PolicyEngine.node)),
);

const access = (hob: HobPolicy = EMPTY_HOB_POLICY): ToolAccess => ({
  policy: { preset: "balanced", sharedFolders: [project], hob, dataFolder: data, restrictions: [] },
  folders: [project],
  runtimeFolder: join(runtimes, "hob-1"),
});

/** Runs one tool call through the hooks as Claude Code would, with what each hook reported. */
const call = async (
  tool: string,
  toolInput: Record<string, unknown>,
  outcome: "success" | "failure" = "success",
  sandbox: "on" | "unavailable" = "on",
) => {
  const turn = toolTurn(access(), sandbox);
  if (turn === null) throw new Error("expected a tool turn");
  const events: Array<RuntimeEvent> = [];
  const { hooks } = policyHooks(engine, turn, (event) => events.push(event));
  const signal = new AbortController().signal;
  const base = {
    session_id: "s",
    transcript_path: "",
    cwd: project,
    tool_name: tool,
    tool_input: toolInput,
    tool_use_id: "t1",
  };
  const [pre] = hooks.PreToolUse?.[0]?.hooks ?? [];
  const output = await pre?.({ ...base, hook_event_name: "PreToolUse" } as HookInput, "t1", { signal });
  const decision = (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
    ?.permissionDecision;
  if (decision === "allow") {
    const after = outcome === "success" ? hooks.PostToolUse : hooks.PostToolUseFailure;
    await after?.[0]?.hooks[0]?.(
      {
        ...base,
        hook_event_name: outcome === "success" ? "PostToolUse" : "PostToolUseFailure",
        tool_response: "",
        error: "x",
      } as HookInput,
      "t1",
      { signal },
    );
  }
  return { decision, events };
};

describe("Claude Code tool calls under the policy hook", () => {
  // covers PE-001, PE-002
  it("[TC-PE-012] lets a hob under Balanced edit and run tests in its folder without asking", async () => {
    const edit = await call("Edit", { file_path: join(project, "a.ts") });
    expect(edit.decision).toBe("allow");
    expect(edit.events).toEqual([
      {
        _tag: "ToolStarted",
        id: "t1",
        tool: "Edit",
        operation: "edit-files",
        targets: [join(project, "a.ts")],
        label: "Editing a.ts",
      },
      { _tag: "ToolFinished", id: "t1", failed: false },
    ]);
    const tests = await call("Bash", { command: "pnpm test" }, "failure");
    expect(tests.decision).toBe("allow");
    expect(tests.events.at(-1)).toEqual({ _tag: "ToolFinished", id: "t1", failed: true });
  });

  // covers PE-002
  it("[TC-PE-013] refuses a call outside the hob's folders or in Hobbots' data, whatever the prompt says", async () => {
    for (const [tool, input] of [
      ["Write", { file_path: join(outside, "x.txt") }],
      ["Read", { file_path: "../outside/x.txt" }],
      ["Edit", { file_path: join(data, "hobbots.sqlite") }],
    ] as const) {
      const result = await call(tool, input);
      expect(result.decision).toBe("deny");
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({ _tag: "ToolDenied", tool, decidedBy: "policy" });
    }
  });

  // covers PE-003
  it("[TC-PE-014] does not run a call that needs approval on a turn that cannot ask", async () => {
    const result = await call("Bash", { command: "pnpm test && git push origin main" });
    expect(result.decision).toBe("deny");
    expect(result.events[0]).toMatchObject({ _tag: "ToolDenied", operation: "push" });
    expect(result.events[0]?._tag === "ToolDenied" && result.events[0].reason).toContain("cannot ask you");
  });

  /** Approvals that answer every request with `answer`, recording what was asked. */
  const approvalsAnswering = (
    answer: (action: ApprovalAction) => Effect.Effect<ApprovalOutcome>,
    current: ToolAccess | null = access(),
  ) => {
    const asked: Array<ApprovalAction> = [];
    const approvals: TurnApprovals = {
      request: (action) =>
        Effect.sync(() => {
          asked.push(action);
          return { approvalId: ApprovalId.make(`approval-${asked.length}`), decision: answer(action) };
        }),
      currentAccess: Effect.succeed(current),
    };
    return { asked, approvals };
  };
  const approve = (action: ApprovalAction) =>
    Effect.map(
      actionDigest(action),
      (digest): ApprovalOutcome => ({
        _tag: "Approved",
        actionDigest: digest,
        policyVersion: action.policyVersion,
      }),
    );

  /** A push through the hook, then the permission callback, as Claude Code makes them. */
  const askedCall = async (approvals: TurnApprovals) => {
    const turn = toolTurn(access(), "on");
    if (turn === null) throw new Error("expected a tool turn");
    const events: Array<RuntimeEvent> = [];
    const { hooks, canUseTool } = policyHooks(engine, turn, (event) => events.push(event), approvals);
    const signal = new AbortController().signal;
    const input = { command: "git push origin main" };
    const [pre] = hooks.PreToolUse?.[0]?.hooks ?? [];
    const output = await pre?.(
      {
        session_id: "s",
        transcript_path: "",
        cwd: project,
        tool_name: "Bash",
        tool_input: input,
        tool_use_id: "t1",
        hook_event_name: "PreToolUse",
      } as HookInput,
      "t1",
      { signal },
    );
    const hook = (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
      ?.permissionDecision;
    const result = await canUseTool("Bash", input, { signal, toolUseID: "t1" } as Parameters<typeof canUseTool>[2]);
    return { hook, result, events };
  };

  // covers PE-003
  it("[TC-PE-067] asks the user about a call that needs approval and runs it only once approved", async () => {
    const { asked, approvals } = approvalsAnswering(approve);
    const { hook, result, events } = await askedCall(approvals);
    expect(hook).toBe("ask");
    expect(result).toMatchObject({ behavior: "allow" });
    expect(asked).toEqual([
      expect.objectContaining({
        stepId: "t1",
        tool: "Bash",
        operation: "push",
        arguments: { command: "git push origin main" },
      }),
    ]);
    expect(events.map((event) => event._tag)).toEqual(["ToolAwaitingApproval", "ToolStarted"]);
    expect(events[0]).toMatchObject({ id: "t1", approvalId: "approval-1", operation: "push" });
  });

  // covers PE-003
  it("[TC-PE-068] gives the hob the user's reason when they deny the call", async () => {
    const { approvals } = approvalsAnswering(() => Effect.succeed({ _tag: "Denied", reason: "Not today" }));
    const { result, events } = await askedCall(approvals);
    expect(result).toMatchObject({ behavior: "deny", message: expect.stringContaining("Not today") });
    expect(events.map((event) => event._tag)).toEqual(["ToolAwaitingApproval", "ToolDenied"]);
    expect(events[1]).toMatchObject({ decidedBy: "user" });
  });

  // covers PE-008
  it("[TC-PE-069] decides an approved call again under the policy as it is now", async () => {
    // Pushing became Never while the user decided.
    const narrower = approvalsAnswering(approve, access({ ...EMPTY_HOB_POLICY, overrides: { push: "deny" } }));
    const refused = await askedCall(narrower.approvals);
    expect(refused.result).toMatchObject({ behavior: "deny" });
    expect(refused.events.at(-1)).toMatchObject({ _tag: "ToolDenied", operation: "push" });
    // An approval for another action does not apply: the call asks again.
    let round = 0;
    const changed = approvalsAnswering((action) =>
      ++round === 1
        ? Effect.succeed({ _tag: "Approved", actionDigest: "other", policyVersion: action.policyVersion })
        : approve(action),
    );
    const again = await askedCall(changed.approvals);
    expect(changed.asked).toHaveLength(2);
    expect(again.result).toMatchObject({ behavior: "allow" });
  });

  // covers PE-003, PE-008
  it("[TC-PE-071] asks about the call in the folder the hook saw, and refuses one whose arguments changed", async () => {
    const turn = toolTurn(access(), "on");
    if (turn === null) throw new Error("expected a tool turn");
    const { asked, approvals } = approvalsAnswering(approve);
    const events: Array<RuntimeEvent> = [];
    const { hooks, canUseTool } = policyHooks(engine, turn, (event) => events.push(event), approvals);
    const signal = new AbortController().signal;
    const [pre] = hooks.PreToolUse?.[0]?.hooks ?? [];
    const sub = join(project, "sub");
    mkdirSync(sub, { recursive: true });
    const hook = (id: string, command: string) =>
      pre?.(
        {
          session_id: "s",
          transcript_path: "",
          cwd: sub,
          tool_name: "Bash",
          tool_input: { command },
          tool_use_id: id,
          hook_event_name: "PreToolUse",
        } as HookInput,
        id,
        { signal },
      );
    const options = (id: string) => ({ signal, toolUseID: id }) as Parameters<typeof canUseTool>[2];
    await hook("t1", "rm -rf build");
    expect(await canUseTool("Bash", { command: "rm -rf build" }, options("t1"))).toMatchObject({ behavior: "allow" });
    expect(asked[0]?.targets).toEqual([join(sub, "build")]);
    await hook("t2", "rm -rf build");
    expect(await canUseTool("Bash", { command: "rm -rf /" }, options("t2"))).toMatchObject({ behavior: "deny" });
    expect(asked).toHaveLength(1);
  });

  // covers PE-005
  it("[TC-PE-040] blocks shell commands where the sandbox cannot start, and says why", async () => {
    // Bash is not offered at all, while file tools still work through the hook.
    const turn = toolTurn(access(), "unavailable");
    expect(turn?.tools).not.toContain("Bash");
    expect(turn?.tools).toContain("Edit");
    // A command that reached the hook anyway is refused with the reason, never run unsandboxed.
    for (const command of ["pnpm test", "git status", "git push origin feature"]) {
      const result = await call("Bash", { command }, "success", "unavailable");
      expect(result.decision).toBe("deny");
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({ _tag: "ToolDenied", decidedBy: "policy" });
      expect(result.events[0]?._tag === "ToolDenied" && result.events[0].reason).toContain("sandbox cannot start");
    }
    expect((await call("Edit", { file_path: join(project, "a.ts") }, "success", "unavailable")).decision).toBe("allow");
  });

  it("refuses a tool Hobbots does not know", async () => {
    const result = await call("WebFetch", { url: "https://example.com" });
    expect(result.decision).toBe("deny");
    expect(result.events[0]).toMatchObject({ _tag: "ToolDenied", reason: expect.stringContaining("WebFetch") });
  });

  it("decides again in the permission callback", async () => {
    const turn = toolTurn(access(), "on");
    if (turn === null) throw new Error("expected a tool turn");
    const { canUseTool } = policyHooks(engine, turn, () => {});
    const signal = new AbortController().signal;
    const options = { signal, toolUseID: "t1" } as Parameters<typeof canUseTool>[2];
    expect(await canUseTool("Edit", { file_path: join(project, "a.ts") }, options)).toMatchObject({
      behavior: "allow",
    });
    expect(await canUseTool("Edit", { file_path: join(outside, "a.ts") }, options)).toMatchObject({ behavior: "deny" });
  });

  it("reads only the short-lived access token from Claude Code's keychain login", () => {
    const secret = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: 5 } });
    expect(parseKeychainLogin(secret)).toEqual({ token: "a", expiresAt: 5 });
    expect(parseKeychainLogin("not json")).toBeNull();
    expect(parseKeychainLogin("{}")).toBeNull();
  });

  it("keeps a turn chat-only without folders that exist", () => {
    expect(toolTurn(null, "on")).toBeNull();
    expect(toolTurn({ ...access(), folders: [join(root, "missing")] }, "on")).toBeNull();
  });

  it("keeps a turn chat-only when the hob may not read its folders", () => {
    // covers PE-005
    // Claude Code cannot start in a folder it cannot read, and no tool works without reading it.
    expect(toolTurn(access({ ...EMPTY_HOB_POLICY, overrides: { "read-files": "deny" } }), "on")).toBeNull();
  });
});

describe("scripted tool calls in the fake runtime", () => {
  const turn = (prompt: string, tools: ToolAccess | null) =>
    makeFakeRuntime({ engine })
      .sendPrompt({
        prompt,
        sessionId: null,
        instructions: "",
        instructionsChanged: false,
        model: null,
        effort: null,
        tools,
      })
      .pipe(Stream.runCollect, Effect.runPromise)
      .then((events) => Array.from(events).filter((e) => e._tag.startsWith("Tool")));

  // covers PE-002
  it("[TC-PE-015] reports allowed calls as started and finished and refused ones as denied", async () => {
    const events = await turn(
      `fake:tool Edit ${join(project, "a.ts")}\nfake:tool Write ${join(outside, "b.txt")}`,
      access(),
    );
    expect(events.map((e) => e._tag)).toEqual(["ToolStarted", "ToolFinished", "ToolDenied"]);
    expect(events[2]).toMatchObject({ operation: "outside-folders", label: "Writing b.txt" });
  });

  it("refuses a tool Hobbots does not know, as the hook does", async () => {
    const events = await turn("fake:tool WebFetch https://example.com", access());
    expect(events).toEqual([expect.objectContaining({ _tag: "ToolDenied", tool: "WebFetch", decidedBy: "policy" })]);
  });

  it("makes no tool calls in a chat-only turn", async () => {
    expect(await turn(`fake:tool Edit ${join(project, "a.ts")}`, null)).toEqual([]);
  });
});

describe("sessions across configuration folders", () => {
  it("copies a session into the folder a turn resumes it from, when that folder's copy is older", async () => {
    const user = join(root, "user-claude");
    const hob = join(runtimes, "hob-adopt");
    mkdirSync(join(user, "projects", "-work", "s1"), { recursive: true });
    writeFileSync(join(user, "projects", "-work", "s1.jsonl"), "first\n");
    writeFileSync(join(user, "projects", "-work", "s1", "agent.jsonl"), "sub\n");
    await adoptSession(hob, [user], "s1");
    expect(readFileSync(join(hob, "projects", "-work", "s1.jsonl"), "utf8")).toBe("first\n");
    // Only the transcript moves; a session's subagent runs stay where they were written.
    expect(existsSync(join(hob, "projects", "-work", "s1"))).toBe(false);
    // The hob's own copy moves on from here, so a later turn leaves it alone.
    writeFileSync(join(hob, "projects", "-work", "s1.jsonl"), "first\nsecond\n");
    await adoptSession(hob, [user], "s1");
    expect(readFileSync(join(hob, "projects", "-work", "s1.jsonl"), "utf8")).toBe("first\nsecond\n");
    await adoptSession(hob, [user], "missing");
    expect(existsSync(join(hob, "projects", "-work", "missing.jsonl"))).toBe(false);
  });

  it("keeps a thread's whole history when its turns move between folders", async () => {
    const user = join(root, "user-claude-2");
    const hob = join(runtimes, "hob-move");
    const transcript = (folder: string, project: string) => join(folder, "projects", project, "s2.jsonl");
    mkdirSync(join(user, "projects", "-work"), { recursive: true });
    mkdirSync(join(hob, "projects", "-other"), { recursive: true });
    // The hob holds a stale copy from an earlier turn; a chat-only turn wrote on in the user's folder.
    writeFileSync(transcript(hob, "-other"), "one\n");
    utimesSync(transcript(hob, "-other"), new Date(1_000), new Date(1_000));
    writeFileSync(transcript(user, "-work"), "one\ntwo\n");
    await adoptSession(hob, [user], "s2");
    expect(readFileSync(transcript(hob, "-work"), "utf8")).toBe("one\ntwo\n");
    expect(existsSync(transcript(hob, "-other"))).toBe(false);
    // And back: the hob's turn wrote on, so a later chat-only turn takes its copy.
    writeFileSync(transcript(hob, "-work"), "one\ntwo\nthree\n");
    utimesSync(transcript(user, "-work"), new Date(2_000), new Date(2_000));
    await adoptSession(user, [hob], "s2");
    expect(readFileSync(transcript(user, "-work"), "utf8")).toBe("one\ntwo\nthree\n");
  });

  it("never copies a link a hob's command left in its folder", async () => {
    const user = join(root, "user-claude-3");
    const hob = join(runtimes, "hob-link");
    const target = join(outside, "user-file.json");
    writeFileSync(target, "{}\n");
    mkdirSync(join(hob, "projects", "-work", "s3"), { recursive: true });
    symlinkSync(target, join(hob, "projects", "-work", "s3.jsonl"));
    await adoptSession(user, [hob], "s3");
    expect(existsSync(join(user, "projects", "-work", "s3.jsonl"))).toBe(false);
    rmSync(join(hob, "projects", "-work", "s3.jsonl"));
    writeFileSync(join(hob, "projects", "-work", "s3.jsonl"), "one\n");
    symlinkSync(target, join(hob, "projects", "-work", "s3", "agent.jsonl"));
    await adoptSession(user, [hob], "s3");
    expect(readFileSync(join(user, "projects", "-work", "s3.jsonl"), "utf8")).toBe("one\n");
    expect(existsSync(join(user, "projects", "-work", "s3", "agent.jsonl"))).toBe(false);
  });

  it("[TC-PE-023] writes nowhere outside while a command swaps the hob's folders for links", async () => {
    // covers PE-005
    // A command of another thread of the same hob keeps swapping its project folder for a link outside.
    const user = join(root, "user-claude-6");
    const hob = join(runtimes, "hob-swapping");
    const elsewhere = join(outside, "swapped");
    mkdirSync(join(user, "projects", "-work"), { recursive: true });
    mkdirSync(join(hob, "projects"), { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(user, "projects", "-work", "s6.jsonl"), "mine\n");
    const work = join(hob, "projects", "-work");
    // Swaps the project folder for a link outside and back, as fast as it can.
    const swapper = spawn(
      process.execPath,
      [
        "-e",
        `const fs = require("node:fs");
        const [work, elsewhere] = process.argv.slice(1);
        for (;;) {
          try { fs.renameSync(work, work + ".aside"); } catch {}
          try { fs.symlinkSync(elsewhere, work); fs.unlinkSync(work); } catch {}
          try { fs.renameSync(work + ".aside", work); } catch {}
        }`,
        "--",
        work,
        elsewhere,
      ],
      { stdio: "ignore" },
    );
    try {
      // Each round starts a copy process; 200 rounds catch a copy that follows a swapped link.
      for (let round = 0; round < Number(process.env.SWAP_ROUNDS ?? 200); round++) {
        utimesSync(join(user, "projects", "-work", "s6.jsonl"), new Date(), new Date(Date.now() + round * 1_000));
        await adoptSession(hob, [user], "s6");
      }
    } finally {
      const exited = new Promise((resolve) => swapper.once("exit", resolve));
      swapper.kill();
      await exited;
    }
    expect(readdirSync(elsewhere)).toEqual([]);
  }, 60_000);

  it("[TC-PE-018] never follows a linked folder on the way to a session", async () => {
    // covers PE-005
    const elsewhere = join(outside, "elsewhere");
    mkdirSync(join(elsewhere, "-work"), { recursive: true });
    writeFileSync(join(elsewhere, "-work", "s4.jsonl"), "outside\n");
    // A hob's project folder that points outside is not a copy to take.
    const hob = join(runtimes, "hob-linked-source");
    mkdirSync(join(hob, "projects"), { recursive: true });
    symlinkSync(join(elsewhere, "-work"), join(hob, "projects", "-work"));
    const user = join(root, "user-claude-4");
    await adoptSession(user, [hob], "s4");
    expect(existsSync(join(user, "projects", "-work", "s4.jsonl"))).toBe(false);
    // Nor a place to write: the copy is refused when the target's folder, or its projects, is a link.
    const writer = join(root, "user-claude-5");
    mkdirSync(join(writer, "projects", "-work"), { recursive: true });
    writeFileSync(join(writer, "projects", "-work", "s5.jsonl"), "mine\n");
    for (const linked of ["-work", "projects"]) {
      const target = join(runtimes, `hob-linked-${linked}`);
      mkdirSync(join(target, "projects"), { recursive: true });
      if (linked === "projects") {
        rmSync(join(target, "projects"), { recursive: true });
        symlinkSync(elsewhere, join(target, "projects"));
      } else symlinkSync(join(elsewhere, "-work"), join(target, "projects", "-work"));
      await adoptSession(target, [writer], "s5");
      expect(existsSync(join(elsewhere, "-work", "s5.jsonl"))).toBe(false);
    }
    // A link where the transcript goes is replaced, not written through.
    const replaced = join(runtimes, "hob-linked-file");
    mkdirSync(join(replaced, "projects", "-work"), { recursive: true });
    symlinkSync(join(elsewhere, "-work", "s5.jsonl"), join(replaced, "projects", "-work", "s5.jsonl"));
    await adoptSession(replaced, [writer], "s5");
    expect(readFileSync(join(replaced, "projects", "-work", "s5.jsonl"), "utf8")).toBe("mine\n");
    expect(lstatSync(join(replaced, "projects", "-work", "s5.jsonl")).isFile()).toBe(true);
    expect(existsSync(join(elsewhere, "-work", "s5.jsonl"))).toBe(false);
  });
});

describe("the process sandbox", () => {
  it("closes the home folder, the user's Claude Code state and other hobs' except the hob's own", () => {
    const rules = sandboxFilesystem({
      folders: ["/Volumes/Work/app"],
      folderAccess: { read: true, write: true },
      dataFolder: "/Users/me/Library/Hobbots",
      binary: "/Users/me/.local/bin/claude",
      runtimeFolder: "/Users/me/Library/Hobbots-runtimes/hob-1",
      tempFolder: "/private/var/folders/xy/T/turn",
      allowedHosts: [],
      home: "/Users/me",
      path: "/usr/bin:/Users/me/.volta/bin:relative",
    });
    expect(rules.denyRead).toEqual(
      expect.arrayContaining([
        "/Users/me",
        "/Volumes",
        "/tmp",
        "/private/var/folders",
        "/Users/me/Library/Hobbots",
        "/Users/me/Library/Hobbots-runtimes",
      ]),
    );
    expect(rules.allowRead).toEqual(
      expect.arrayContaining([
        "/Volumes/Work/app",
        "/Users/me/Library/Hobbots-runtimes/hob-1",
        "/private/var/folders/xy/T/turn",
        "/Users/me/.local/bin",
        "/Users/me/.volta/bin",
      ]),
    );
    expect(rules.allowRead).not.toContain("/Users/me/.claude");
    // Closed explicitly too, for a folder that holds the home folder.
    expect(rules.denyWrite).toEqual(expect.arrayContaining(["/Users/me/.claude.json"]));
    expect(rules.allowWrite).toEqual([
      "/Volumes/Work/app",
      "/Users/me/Library/Hobbots-runtimes/hob-1",
      "/private/var/folders/xy/T/turn",
    ]);
    expect(rules.denyWrite).toEqual(expect.arrayContaining(["/Users/me/Library/Hobbots"]));
  });

  it("closes the folders to processes where the policy denies reading or editing them", () => {
    const rules = (folderAccess: { read: boolean; write: boolean }) =>
      sandboxFilesystem({
        folders: ["/Volumes/Work/app"],
        folderAccess,
        dataFolder: "/Users/me/Library/Hobbots",
        binary: "/usr/bin/claude",
        runtimeFolder: "/Users/me/Library/Hobbots-runtimes/hob-1",
        tempFolder: "/private/var/folders/xy/T/turn",
        allowedHosts: [],
        home: "/Users/me",
        path: "/usr/bin",
      });
    expect(rules({ read: true, write: false }).allowWrite).not.toContain("/Volumes/Work/app");
    expect(rules({ read: true, write: false }).allowRead).toContain("/Volumes/Work/app");
    expect(rules({ read: false, write: false }).allowRead).not.toContain("/Volumes/Work/app");
  });

  it("lets only the variables a runtime needs into the sandbox", () => {
    expect(
      sandboxEnv({
        PATH: "/usr/bin",
        HOME: "/Users/me",
        LC_ALL: "C",
        CLAUDE_CODE_OAUTH_TOKEN: "t",
        GH_TOKEN: "secret",
        AWS_SECRET_ACCESS_KEY: "secret",
        SSH_AUTH_SOCK: "/tmp/agent",
        ANTHROPIC_API_KEY: "secret",
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "secret",
        CLAUDE_CODE_MEMORY_API_TOKEN: "secret",
      }),
    ).toEqual({ PATH: "/usr/bin", HOME: "/Users/me", LC_ALL: "C", CLAUDE_CODE_OAUTH_TOKEN: "t" });
  });

  it("gives Git only the user's identity, quoted, in place of their own config", () => {
    expect(sandboxGitConfig({})).toBe("");
    expect(sandboxGitConfig({ name: "Ada Lovelace", email: "ada@example.com" })).toBe(
      '[user]\n\tname = "Ada Lovelace"\n\temail = "ada@example.com"\n',
    );
    // A value cannot end its quotes or start another setting.
    expect(sandboxGitConfig({ name: 'Ada "x"\\\n[core]\nhooksPath = /tmp' })).toBe(
      '[user]\n\tname = "Ada \\"x\\"\\\\[core]hooksPath = /tmp"\n',
    );
  });

  it("reaches a host only when every live turn may reach it", async () => {
    const open = async () => true as const;
    const closed = async (host: string) => `${host} is closed.`;
    expect(await decideForLiveTurns([open, open], "registry.npmjs.org")).toBe(true);
    expect(await decideForLiveTurns([open, closed], "registry.npmjs.org")).toEqual({
      allow: false,
      reason: "registry.npmjs.org is closed.",
    });
    expect(await decideForLiveTurns([], "example.com")).toMatchObject({ allow: false });
  });

  // covers PE-005
  it.runIf(process.platform === "darwin")(
    "[TC-PE-016] lets a command write in the hob's folder and fails one that writes outside it or to Git's hooks",
    async () => {
      await Effect.gen(function* () {
        const sandbox = yield* ProcessSandbox;
        expect(sandbox.state).toBe("on");
        const prepared = yield* sandbox.prepare({
          folders: [project],
          folderAccess: { read: true, write: true },
          dataFolder: data,
          binary: "/bin/sh",
          runtimeFolder: join(runtimes, "hob-1"),
          allowedHosts: [],
        });
        try {
          const run = (script: string) => {
            const { command, args, env } = prepared.spawnArgs("/bin/sh", ["-c", script], {
              PATH: "/usr/bin:/bin",
              GH_TOKEN: "not-for-commands",
            });
            return spawnSync(command, [...args], { cwd: project, env, encoding: "utf8" });
          };
          expect(run(`echo ok > ${join(project, "inside.txt")}`).status).toBe(0);
          const escaped = run(`echo no > ${join(outside, "escaped.txt")}`);
          expect(escaped.status).not.toBe(0);
          expect(escaped.stderr).toContain("Operation not permitted");
          expect(run(`echo no > ${join(data, "x")}`).status).not.toBe(0);
          // Reads outside the folders fail too, outside the home folder included, as do other hobs' state.
          writeFileSync(join(outside, "secret.txt"), "secret\n");
          mkdirSync(join(runtimes, "hob-2"), { recursive: true });
          writeFileSync(join(runtimes, "hob-2", "session.jsonl"), "{}\n");
          expect(run(`cat ${join(outside, "secret.txt")}`).status).not.toBe(0);
          expect(run(`cat ${join(runtimes, "hob-2", "session.jsonl")}`).status).not.toBe(0);
          expect(run(`echo ok > ${join(runtimes, "hob-1", "state.json")}`).status).toBe(0);
          // The user's own Claude Code state stays closed: its memory and settings load outside any policy.
          expect(run(`ls ${join(homedir(), ".claude")}`).status).not.toBe(0);
          // Git's hooks and config stay read-only, since the user's own Git would run them unsandboxed.
          mkdirSync(join(project, ".git", "hooks"), { recursive: true });
          writeFileSync(join(project, ".git", "config"), "[core]\n");
          expect(run(`echo no > ${join(project, ".git", "hooks", "pre-commit")}`).status).not.toBe(0);
          expect(run(`echo no >> ${join(project, ".git", "config")}`).status).not.toBe(0);
          expect(run(`echo ok > ${join(project, ".git", "HEAD")}`).status).toBe(0);
          // So do a submodule's.
          mkdirSync(join(project, ".git", "modules", "lib", "hooks"), { recursive: true });
          expect(run(`echo no > ${join(project, ".git", "modules", "lib", "config")}`).status).not.toBe(0);
          expect(run(`echo no > ${join(project, ".git", "modules", "lib", "hooks", "post-checkout")}`).status).not.toBe(
            0,
          );
          expect(run(`echo ok > ${join(project, ".git", "modules", "lib", "HEAD")}`).status).toBe(0);
          // The keychain stays closed, so no command reaches the credentials Git or gh keep there.
          const helper = run("printf 'protocol=https\\nhost=github.com\\n\\n' | git credential-osxkeychain get");
          expect(helper.stdout).not.toContain("password=");
          // Credentials in the hub's environment stay out, and the runtime keeps state in its own folder.
          expect(run('echo "[$GH_TOKEN]"').stdout.trim()).toBe("[]");
          expect(run('echo "$CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"').stdout.trim()).toBe("1");
          expect(run('echo "$CLAUDE_CONFIG_DIR"').stdout.trim()).toBe(join(runtimes, "hob-1"));
          // Git runs although the user's own config is closed: on macOS it stops when it cannot read it.
          const gitProject = join(project, "repo");
          spawnSync("git", ["init", "-q", gitProject]);
          const status = run(`git -C ${gitProject} status --short`);
          expect(status.stderr).not.toContain("unable to access");
          expect(status.status).toBe(0);
        } finally {
          prepared.release();
        }
      }).pipe(Effect.provide(ProcessSandbox.layer), Effect.scoped, Effect.runPromise);
    },
    30_000,
  );

  // covers PE-005
  it.runIf(process.platform === "darwin")(
    "[TC-PE-020] fails a command that writes or reads a folder the policy closes to it",
    async () => {
      await Effect.gen(function* () {
        const sandbox = yield* ProcessSandbox;
        const run = (folderAccess: { read: boolean; write: boolean }, script: string) =>
          Effect.acquireUseRelease(
            sandbox.prepare({
              folders: [project],
              folderAccess,
              dataFolder: data,
              binary: "/bin/sh",
              runtimeFolder: join(runtimes, "hob-1"),
              allowedHosts: [],
            }),
            (prepared) =>
              Effect.sync(() => {
                const { command, args, env } = prepared.spawnArgs("/bin/sh", ["-c", script], { PATH: "/usr/bin:/bin" });
                return spawnSync(command, [...args], { cwd: runtimes, env, encoding: "utf8" });
              }),
            (prepared) => Effect.sync(prepared.release),
          );
        writeFileSync(join(project, "kept.txt"), "kept\n");
        // Editing denied: a command cannot change a file, while reading it still works.
        expect(
          (yield* run({ read: true, write: false }, `printf changed > ${join(project, "kept.txt")}`)).status,
        ).not.toBe(0);
        expect(readFileSync(join(project, "kept.txt"), "utf8")).toBe("kept\n");
        expect((yield* run({ read: true, write: false }, `cat ${join(project, "kept.txt")}`)).stdout).toBe("kept\n");
        // Reading denied too: a command cannot read it either.
        const read = yield* run({ read: false, write: false }, `cat ${join(project, "kept.txt")}`);
        expect(read.status).not.toBe(0);
        expect(read.stdout).not.toContain("kept");
      }).pipe(Effect.provide(ProcessSandbox.layer), Effect.scoped, Effect.runPromise);
    },
    30_000,
  );
});
