import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { EMPTY_HOB_POLICY, type HobPolicy } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import type { RuntimeEvent, ToolAccess } from "../src/adapter.ts";
import { parseKeychainLogin, policyHooks, toolTurn } from "../src/claude-code.ts";
import { makeFakeRuntime } from "../src/fake.ts";
import { decideForLiveTurns, ProcessSandbox, sandboxFilesystem } from "../src/sandbox.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-hooks-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const project = join(root, "project");
const outside = join(root, "outside");
const data = join(root, "data");
for (const dir of [project, outside, data]) mkdirSync(dir);
writeFileSync(join(project, "a.ts"), "export {};\n");

const engine = Effect.runSync(
  Effect.gen(function* () {
    return yield* PolicyEngine;
  }).pipe(Effect.provide(PolicyEngine.node)),
);

const access = (hob: HobPolicy = EMPTY_HOB_POLICY): ToolAccess => ({
  policy: { preset: "balanced", sharedFolders: [project], hob, dataFolder: data, restrictions: [] },
  folders: [project],
});

/** Runs one tool call through the hooks as Claude Code would, with what each hook reported. */
const call = async (tool: string, toolInput: Record<string, unknown>, outcome: "success" | "failure" = "success") => {
  const turn = toolTurn(access(), "on");
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
  it("[TC-PE-014] does not run a call that needs approval, since Hobbots cannot ask yet", async () => {
    const result = await call("Bash", { command: "pnpm test && git push origin main" });
    expect(result.decision).toBe("deny");
    expect(result.events[0]).toMatchObject({ _tag: "ToolDenied", operation: "push" });
    expect(result.events[0]?._tag === "ToolDenied" && result.events[0].reason).toContain("cannot ask you");
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

  it("makes no tool calls in a chat-only turn", async () => {
    expect(await turn(`fake:tool Edit ${join(project, "a.ts")}`, null)).toEqual([]);
  });
});

describe("the process sandbox", () => {
  it("closes the home folder except the hob's folders and Claude Code's own state", () => {
    const rules = sandboxFilesystem({
      folders: ["/Users/me/work"],
      dataFolder: "/Users/me/Library/Hobbots",
      binary: "/Users/me/.local/bin/claude",
      tempFolder: "/tmp/turn",
      allowedHosts: [],
      home: "/Users/me",
      path: "/usr/bin:/Users/me/.volta/bin:relative",
    });
    expect(rules.denyRead).toEqual(["/Users/me", "/Users/me/Library/Hobbots"]);
    expect(rules.allowRead).toEqual(
      expect.arrayContaining(["/Users/me/work", "/Users/me/.claude", "/Users/me/.local/bin", "/Users/me/.volta/bin"]),
    );
    expect(rules.allowWrite).toEqual(["/Users/me/work", "/Users/me/.claude", "/tmp/turn"]);
    expect(rules.denyWrite).toEqual(
      expect.arrayContaining([
        "/Users/me/Library/Hobbots",
        "/Users/me/.claude/settings.json",
        "/Users/me/.claude/hooks",
      ]),
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
          dataFolder: data,
          binary: "/bin/sh",
          allowedHosts: [],
        });
        try {
          const run = (script: string) => {
            const { command, args, env } = prepared.spawnArgs("/bin/sh", ["-c", script], { PATH: "/usr/bin:/bin" });
            return spawnSync(command, [...args], { cwd: project, env, encoding: "utf8" });
          };
          expect(run(`echo ok > ${join(project, "inside.txt")}`).status).toBe(0);
          const escaped = run(`echo no > ${join(outside, "escaped.txt")}`);
          expect(escaped.status).not.toBe(0);
          expect(escaped.stderr).toContain("Operation not permitted");
          expect(run(`echo no > ${join(data, "x")}`).status).not.toBe(0);
          // Git's hooks and config stay read-only, since the user's own Git would run them unsandboxed.
          mkdirSync(join(project, ".git", "hooks"), { recursive: true });
          writeFileSync(join(project, ".git", "config"), "[core]\n");
          expect(run(`echo no > ${join(project, ".git", "hooks", "pre-commit")}`).status).not.toBe(0);
          expect(run(`echo no >> ${join(project, ".git", "config")}`).status).not.toBe(0);
          expect(run(`echo ok > ${join(project, ".git", "HEAD")}`).status).toBe(0);
          // The keychain stays closed, so no command reaches the credentials Git or gh keep there.
          const helper = run("printf 'protocol=https\\nhost=github.com\\n\\n' | git credential-osxkeychain get");
          expect(helper.stdout).not.toContain("password=");
        } finally {
          prepared.release();
        }
      }).pipe(Effect.provide(ProcessSandbox.layer), Effect.scoped, Effect.runPromise);
    },
    30_000,
  );
});
