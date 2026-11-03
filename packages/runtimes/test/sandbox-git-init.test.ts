import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { HubTools, RuntimeEvent, ToolAccess } from "@hobbots/agents";
import {
  EMPTY_HOB_POLICY,
  GIT_INIT_DESCRIPTION,
  GIT_INIT_LABEL,
  GIT_INIT_TOOL,
  leftoverGitNote,
  type SafetyPreset,
} from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { keptGitHint } from "../src/approval.ts";
import { policyHooks, toolTurn, turnInstructions } from "../src/claude-code.ts";
import { type PreparedSandbox, ProcessSandbox, TEMP_BASE } from "../src/sandbox.ts";
import { initsRepository } from "../src/tool-calls.ts";

// #578: a hob could not create a Git repository in its sandbox, and had no temporary folder it knew
// of. The hub now creates the repository (the `git_init` hub tool, in @hobbots/charms), a `git init`
// command points there, and each turn's commands are told about their own `TMPDIR` (ADR 014).

// The real OS sandbox runs on macOS, and on Linux with HOBBOTS_SANDBOX_TESTS=1 where bubblewrap,
// socat and sandbox-runtime's seccomp helper are installed (as in sandbox-hub.test.ts).
const sandboxed = process.platform === "darwin" || process.env.HOBBOTS_SANDBOX_TESTS === "1";
const linux = process.platform === "linux";

const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-git-init-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const data = join(root, "data");
const runtimes = join(root, "runtimes");
for (const dir of [data, runtimes]) mkdirSync(dir);
let projects = 0;
const newProject = () => {
  const project = join(root, `project-${++projects}`);
  mkdirSync(project);
  return project;
};

const engine = Effect.runSync(
  Effect.gen(function* () {
    return yield* PolicyEngine;
  }).pipe(Effect.provide(PolicyEngine.node)),
);

const access = (project: string, preset: SafetyPreset = "balanced"): ToolAccess => ({
  policy: { preset, sharedFolders: [project], hob: EMPTY_HOB_POLICY, dataFolder: data, restrictions: [] },
  folders: [project],
  runtimeFolder: join(runtimes, "hob-1"),
});

/** The hub tools of a turn that offers `git_init`, as the hub's local Git tools do. */
const withGitInit: HubTools = {
  tools: [{ name: GIT_INIT_TOOL, description: GIT_INIT_DESCRIPTION, inputSchema: {}, label: GIT_INIT_LABEL }],
  call: () => Effect.succeed({ text: "", refused: false }),
};

/** What the policy hook reports for one tool call in `project`. */
const hooked = async (project: string, tool: string, input: Record<string, unknown>, hubTools?: HubTools) => {
  const turn = toolTurn(access(project), "on", hubTools);
  if (turn === null) throw new Error("expected a tool turn");
  const events: Array<RuntimeEvent> = [];
  const { hooks } = policyHooks(engine, turn, (event) => events.push(event));
  const [pre] = hooks.PreToolUse?.[0]?.hooks ?? [];
  await pre?.(
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
  return events[0];
};

/** Git on the hub, outside any sandbox, as the `git_init` tool runs it. */
const hubGit = (...args: Array<string>) =>
  execFileSync("git", args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });

/** Runs a shell script in the turn's sandbox, in `cwd`, without blocking. */
const runIn = async (prepared: PreparedSandbox, cwd: string, script: string) => {
  const { command, args, env } = prepared.spawnArgs("/bin/sh", ["-c", script], {
    PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
  });
  return promisify(execFile)(command, [...args], { cwd, env, encoding: "utf8" }).then(
    ({ stdout, stderr }) => ({ ok: true, stdout, stderr }),
    (error: { stdout?: string; stderr?: string }) => ({
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    }),
  );
};

/** A turn's sandbox over `project`, for the length of `use`. */
const inTurn = <A>(project: string, use: (prepared: PreparedSandbox) => Promise<A>) =>
  Effect.gen(function* () {
    const sandbox = yield* ProcessSandbox;
    expect(sandbox.state, sandbox.evidence).toBe("on");
    return yield* Effect.acquireUseRelease(
      sandbox.prepare({
        folders: [project],
        folderAccess: { read: true, write: true },
        dataFolder: data,
        binary: "/bin/sh",
        runtimeFolder: join(runtimes, "hob-1"),
        allowedHosts: [],
      }),
      (prepared) => Effect.promise(() => use(prepared)),
      (prepared) => Effect.sync(prepared.release),
    );
  }).pipe(Effect.provide(ProcessSandbox.layer), Effect.scoped, Effect.runPromise);

const commitReadme =
  "echo hello > README.md && git add README.md && git -c user.name=Nettle -c user.email=nettle@example.com commit --quiet --no-gpg-sign -m 'First'";

describe("a Git repository in the sandbox", () => {
  // covers PE-005
  it.runIf(sandboxed)(
    "[TC-PE-320] a hob commits in a repository the hub creates in its empty folder, while the repository's hooks and config stay read-only, and cannot reach where the hub makes it",
    async () => {
      const project = newProject();
      await inTurn(project, async (prepared) => {
        // git init in the sandbox cannot write the new repository's config, which is why the hub makes it.
        const refused = await runIn(prepared, project, "git init --quiet .");
        expect(refused.ok).toBe(false);
        expect(existsSync(join(project, ".git", "HEAD"))).toBe(false);
        // The hub creates it during the turn, as `git_init` does: no template, so no hooks.
        hubGit("init", "--quiet", "--template=", "--", project);
        const inTurn = await runIn(prepared, project, commitReadme);
        // On Linux the turn's mounts are fixed when it starts, so the repository appears from the next turn (ADR 014).
        expect(inTurn.ok, inTurn.stderr).toBe(!linux);
      });
      await inTurn(project, async (prepared) => {
        if (linux) {
          const committed = await runIn(prepared, project, commitReadme);
          expect(committed.ok, committed.stderr).toBe(true);
        }
        expect(hubGit("-C", project, "log", "-1", "--format=%s %an").trim()).toBe("First Nettle");
        // The repository's hooks and config stay read-only, as in any repository (ADR 014).
        const hook = await runIn(prepared, project, "mkdir -p .git/hooks && echo 'echo hi' > .git/hooks/pre-commit");
        expect(hook.ok).toBe(false);
        const config = await runIn(prepared, project, "git config core.hooksPath .husky");
        expect(config.ok).toBe(false);
        expect(existsSync(join(project, ".git", "hooks", "pre-commit"))).toBe(false);
        expect(readFileSync(join(project, ".git", "config"), "utf8")).not.toContain("hooksPath");
      });

      // A repository the hub creates in a folder below appears at once, on either system.
      const nested = join(project, "tools");
      await inTurn(project, async (prepared) => {
        hubGit("init", "--quiet", "--template=", "--", nested);
        const committed = await runIn(prepared, nested, commitReadme);
        expect(committed.ok, committed.stderr).toBe(true);
      });
      expect(hubGit("-C", nested, "log", "-1", "--format=%s").trim()).toBe("First");

      // git_init makes a repository in the hub's data folder before it copies it (apps/server), and a
      // turn's commands cannot write there, so none can lay a hook or config in it meanwhile.
      const staging = join(data, "charms", "local-git", "init-test");
      mkdirSync(staging, { recursive: true });
      await inTurn(project, async (prepared) => {
        const injected = await runIn(
          prepared,
          project,
          `mkdir -p ${staging}/.git/hooks && echo 'echo hi' > ${staging}/.git/hooks/pre-commit; echo x > ${staging}/config`,
        );
        // macOS refuses the writes; on Linux they land in the turn's own empty view of the folder.
        expect(injected.ok).toBe(linux);
      });
      expect(readdirSync(staging)).toEqual([]);
    },
    60_000,
  );

  // covers PE-005
  it.runIf(sandboxed)(
    "[TC-PE-321] a turn's commands write their own temporary folder, TMPDIR, and never the shared /tmp",
    async () => {
      const project = newProject();
      const name = `hobbots-578-${process.pid}-${Date.now()}`;
      await inTurn(project, async (prepared) => {
        const own = await runIn(
          prepared,
          project,
          'echo kept > "$TMPDIR/scratch" && cat "$TMPDIR/scratch" && echo "$TMPDIR"',
        );
        expect(own.ok, own.stderr).toBe(true);
        const [kept, folder] = own.stdout.trim().split("\n");
        expect(kept).toBe("kept");
        expect(folder).toMatch(/\/hb-[^/]+$/);
        await runIn(prepared, project, `echo leaked > /tmp/${name}`);
        // macOS refuses the write; on Linux it lands in the turn's own empty /tmp, which nothing else sees.
        expect(existsSync(join("/tmp", name))).toBe(false);
      });
    },
    30_000,
  );
});

describe("pointing a hob to what works in its sandbox", () => {
  // covers PE-005
  it("[TC-PE-322] refuses a git init command and points it to git_init when the turn offers it, wherever the line runs it", async () => {
    const project = newProject();
    for (const command of [
      "git init",
      "git init --initial-branch=main .",
      "mkdir app && cd app && git init",
      `git -C ${project} init`,
      "env GIT_TRACE=1 git init",
      "git status; git init sub",
    ]) {
      const event = await hooked(project, "Bash", { command }, withGitInit);
      expect(event, command).toMatchObject({ _tag: "ToolDenied", reason: expect.stringContaining("git_init tool") });
    }
    // Other Git commands are decided as Local Git, as before.
    for (const command of ["git status", "git commit -m init", "git log --grep=init", "echo git init"]) {
      expect(initsRepository("Bash", { command }, project), command).toBe(false);
      expect(await hooked(project, "Bash", { command }, withGitInit), command).toMatchObject({ _tag: "ToolStarted" });
    }
    // A turn without the tool decides git init as Local Git, as before.
    expect(toolTurn(access(project), "on")?.initTool).toBeUndefined();
    expect(toolTurn(access(project), "on", withGitInit)?.initTool).toBe(GIT_INIT_TOOL);
    expect(await hooked(project, "Bash", { command: "git init" })).toMatchObject({
      _tag: "ToolStarted",
      operation: "local-git",
    });
  });

  // covers PE-005
  it("[TC-PE-323] a refused write to a shared temporary folder names TMPDIR, and the sandbox note names it and git_init", async () => {
    const project = newProject();
    // A command that writes there is refused before it runs, and so is a file tool's write.
    for (const command of [
      "echo x > /tmp/scratch.txt",
      "npm test 2>&1 | tee /tmp/test.log",
      "cp a.txt /var/tmp/a.txt",
      "mkdir -p /private/tmp/work",
    ]) {
      expect(await hooked(project, "Bash", { command }), command).toMatchObject({
        _tag: "ToolDenied",
        reason: expect.stringMatching(/shared temporary folder.*"\$TMPDIR\/name"/),
      });
    }
    expect(await hooked(project, "Write", { file_path: "/tmp/notes.md", content: "x" })).toMatchObject({
      _tag: "ToolDenied",
      reason: expect.stringMatching(/outside this hob's folders\..*\$TMPDIR/),
    });
    // A read there, or a write elsewhere outside the folders, says nothing of TMPDIR.
    const read = await hooked(project, "Read", { file_path: "/tmp/notes.md" });
    expect(read).toMatchObject({ _tag: "ToolDenied" });
    expect((read as { reason: string }).reason).not.toContain("TMPDIR");
    const elsewhere = await hooked(project, "Write", { file_path: join(data, "x"), content: "x" });
    expect((elsewhere as { reason: string }).reason).not.toContain("TMPDIR");
    // Writing "$TMPDIR/name" from a command is not refused by the policy, nor is the turn's own
    // folder by its full path: the sandbox opens it to the turn alone.
    for (const command of [
      'echo x > "$TMPDIR/scratch.txt"',
      `echo x > ${join(TEMP_BASE, "hb-AbC123", "scratch.txt")}`,
      "cat /tmp/notes.md > notes.md",
    ]) {
      expect(await hooked(project, "Bash", { command }), command).toMatchObject({ _tag: "ToolStarted" });
    }

    const note = turnInstructions("Be brief.", true);
    expect(note).toContain("git_init tool instead of git init");
    expect(note).toContain("$TMPDIR");
    expect(turnInstructions("Be brief.", false)).toBe("Be brief.");
  });
});

// #663: deleting a repository from the sandbox leaves its config and hooks, which no hob may remove,
// and git_init then replaces what is left (in @hobbots/charms, TC-PE-440).
describe("a repository a hob deletes", () => {
  // covers PE-005
  it.runIf(sandboxed)(
    "[TC-PE-443] an approved delete of a repository leaves only its config and hooks, whose files stay read-only, and its output names git_init",
    async () => {
      const project = newProject();
      hubGit("init", "--quiet", "--", project);
      hubGit("-C", project, "config", "user.name", "Frodo");
      await inTurn(project, async (prepared) => {
        const committed = await runIn(prepared, project, commitReadme);
        expect(committed.ok, committed.stderr).toBe(true);
      });
      const hook = join(project, ".git", "hooks", "pre-commit");
      writeFileSync(hook, "echo earlier\n");
      await inTurn(project, async (prepared) => {
        // A hook that exists stays read-only, as before.
        const edited = await runIn(prepared, project, "echo 'echo hob' >> .git/hooks/pre-commit");
        expect(edited.ok).toBe(false);
        expect(readFileSync(hook, "utf8")).toBe("echo earlier\n");
        // The delete, as approved, removes everything but the repository's config and hooks.
        const deleted = await runIn(prepared, project, "rm -rf ./* ./.[!.]*");
        expect(deleted.ok).toBe(false);
        expect(keptGitHint("Bash", `${deleted.stdout}${deleted.stderr}`, GIT_INIT_TOOL)).toBe(
          leftoverGitNote(GIT_INIT_TOOL),
        );
      });
      expect(readdirSync(project)).toEqual([".git"]);
      expect(readdirSync(join(project, ".git")).sort()).toEqual(["config", "hooks"]);
      expect(readFileSync(hook, "utf8")).toBe("echo earlier\n");
    },
    60_000,
  );

  // covers PE-005
  it("[TC-PE-444] a delete refused for a repository's config or hooks, and one the sandbox kept them from, both point to git_init", async () => {
    const project = newProject();
    hubGit("init", "--quiet", "--", project);
    // The policy refuses a delete it can read that holds the config or hooks, and says what to do.
    expect(await hooked(project, "Bash", { command: `rm -rf ${project}` }, withGitInit)).toMatchObject({
      _tag: "ToolDenied",
      reason: expect.stringContaining(leftoverGitNote(GIT_INIT_TOOL)),
    });
    // Without git_init on the turn, the refusal says only why.
    const plain = await hooked(project, "Bash", { command: `rm -rf ${project}` });
    expect((plain as { reason: string }).reason).not.toContain(GIT_INIT_TOOL);

    // A delete that ran and met the sandbox gets the note with its result, on macOS's words or Linux's.
    const turn = toolTurn(access(project, "trusting"), "on", withGitInit);
    if (turn === null) throw new Error("expected a tool turn");
    const { hooks } = policyHooks(engine, turn, () => {});
    const signal = new AbortController().signal;
    const ended = async (id: string, error: string) => {
      const base = { session_id: "s", transcript_path: "", cwd: project, tool_use_id: id, tool_name: "Bash" };
      const tool_input = { command: "rm -rf ./* ./.[!.]*" };
      await hooks.PreToolUse?.[0]?.hooks[0]?.({ ...base, hook_event_name: "PreToolUse", tool_input } as HookInput, id, {
        signal,
      });
      const failed = { ...base, hook_event_name: "PostToolUseFailure", tool_input, error, is_interrupt: false };
      return hooks.PostToolUseFailure?.[0]?.hooks[0]?.(failed as unknown as HookInput, id, { signal });
    };
    const note = {
      hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: leftoverGitNote(GIT_INIT_TOOL) },
    };
    expect(await ended("t2", `Exit code 1\nrm: ${project}/.git/config: Operation not permitted`)).toEqual(note);
    expect(
      await ended("t3", `Exit code 1\nrm: cannot remove '${project}/.git/hooks/pre-commit': Read-only file system`),
    ).toEqual(note);
    expect(await ended("t4", "Exit code 1\nrm: cannot remove 'notes.txt': Permission denied")).toEqual({});
    // Git's warning that it could not write the config, as after deleting a branch, is not a delete.
    expect(
      await ended("t5", "Exit code 0\nwarning: could not write config file .git/config: Operation not permitted"),
    ).toEqual({});
    expect(keptGitHint("Bash", `rm: ${project}/.git/config: Operation not permitted`, undefined)).toBeUndefined();
    // Output a command crafts is read in linear time (STD-SEC-005): a long line of candidate paths with
    // no refusal answers at once.
    const started = performance.now();
    expect(keptGitHint("Bash", `rm: ${".git/config ".repeat(500_000)}`, GIT_INIT_TOOL)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(500);
  });
});
