import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { type HubTools, RepositorySandbox, type RuntimeEvent, type ToolAccess } from "@hobbots/agents";
import { EMPTY_HOB_POLICY, GIT_INIT_DESCRIPTION, GIT_INIT_LABEL, GIT_INIT_TOOL } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { policyHooks, toolTurn, turnInstructions } from "../src/claude-code.ts";
import { RepositorySandboxLive } from "../src/folder-sandbox.ts";
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

const access = (project: string): ToolAccess => ({
  policy: { preset: "balanced", sharedFolders: [project], hob: EMPTY_HOB_POLICY, dataFolder: data, restrictions: [] },
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
    "[TC-PE-320] a hob commits in a repository the hub creates in its empty folder, while the repository's hooks and config stay read-only",
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

/**
 * The hub's `git init` of `folder` in the sandbox it runs in, writable below `writable`, with `PATH`
 * first searching `bin`, where a test lays a `git` that acts as a hob's command racing the call.
 */
const sandboxedInit = (writable: string, folder: string, bin: string) =>
  Effect.gen(function* () {
    const repositories = yield* RepositorySandbox;
    const path = `${bin}:${process.env.PATH ?? ""}`;
    const saved = process.env.PATH;
    process.env.PATH = path;
    const program = yield* repositories
      .gitInit(writable, folder, null)
      .pipe(Effect.ensuring(Effect.sync(() => (process.env.PATH = saved))));
    return yield* Effect.promise(() =>
      promisify(execFile)("/bin/sh", ["-c", program.commandLine], {
        env: { PATH: path, ...program.env },
        encoding: "utf8",
      }).then(
        () => ({ ok: true, stderr: "" }),
        (error: { stderr?: string }) => ({ ok: false, stderr: error.stderr ?? "" }),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      RepositorySandboxLive({ dataFolder: data, stateFolder: join(root, "hub-git") }).pipe(
        Layer.provide(ProcessSandbox.layer),
      ),
    ),
    Effect.runPromise,
  );

// Outside the shared temporary folder, which a turn on Linux sees as its own empty one, so the
// sandboxed program finds the test's `git` and the folder a link leads to.
const away = realpathSync(mkdtempSync(join(import.meta.dirname, ".git-init-")));
afterAll(() => rmSync(away, { recursive: true, force: true }));

/** A `git` that runs `before` in the folder it is started in, then the real Git. */
const racingGit = (name: string, before: string) => {
  const bin = join(away, `bin-${name}`);
  mkdirSync(bin);
  const real = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${before}\nexec ${real} "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  return bin;
};

describe("the hub's git init, bound to the folder decided", () => {
  // covers PE-001, PE-005
  it.runIf(sandboxed)(
    "[TC-PE-329] creates the repository in a folder below the hub's own too, writes nothing outside the hob's folder through a link a command lays while the call runs, and refuses a folder that moved",
    async () => {
      const project = newProject();
      const outside = join(away, "outside");
      mkdirSync(outside);
      const plain = racingGit("plain", ":");

      // Without a race it creates the repository, with no hooks, in the folder and in a new one below.
      expect(await sandboxedInit(project, project, plain)).toMatchObject({ ok: true });
      expect(existsSync(join(project, ".git", "HEAD"))).toBe(true);
      expect(existsSync(join(project, ".git", "hooks"))).toBe(false);
      const nested = join(project, "tools", "cli");
      expect(await sandboxedInit(project, nested, plain)).toMatchObject({ ok: true });
      expect(hubGit("-C", nested, "rev-parse", "--show-toplevel").trim()).toBe(nested);

      // Below the hub's own working folder too, where sandbox-runtime keeps every .git/config read-only.
      const beneathHub = join(away, "beneath-hub");
      mkdirSync(beneathHub);
      expect(beneathHub.startsWith(`${realpathSync(process.cwd())}/`)).toBe(true);
      expect(await sandboxedInit(beneathHub, beneathHub, plain)).toMatchObject({ ok: true });
      expect(hubGit("-C", beneathHub, "rev-parse", "--show-toplevel").trim()).toBe(beneathHub);
      expect(hubGit("-C", beneathHub, "config", "--local", "core.bare").trim()).toBe("false");
      expect(readdirSync(beneathHub)).toEqual([".git"]);
      const below = join(beneathHub, "tools");
      expect(await sandboxedInit(beneathHub, below, plain)).toMatchObject({ ok: true });
      expect(hubGit("-C", below, "rev-parse", "--show-toplevel").trim()).toBe(below);

      // A .git link to outside, laid after every check and just before Git writes, leads nowhere.
      const other = newProject();
      const linked = racingGit("link", `ln -s ${outside} .git`);
      expect(await sandboxedInit(other, other, linked)).toMatchObject({ ok: false });
      expect(readdirSync(outside)).toEqual([]);
      const sub = join(other, "sub");
      rmSync(join(other, ".git"));
      expect(await sandboxedInit(other, sub, linked)).toMatchObject({ ok: false });
      expect(readdirSync(outside)).toEqual([]);

      // A link already there, or a folder swapped for a link to outside, is refused before Git runs.
      const swapped = join(project, "swapped");
      symlinkSync(outside, swapped);
      const moved = await sandboxedInit(project, swapped, plain);
      expect(moved).toMatchObject({ ok: false, stderr: expect.stringContaining("moved") });
      const third = newProject();
      symlinkSync(outside, join(third, ".git"));
      const existing = await sandboxedInit(third, third, plain);
      expect(existing).toMatchObject({ ok: false, stderr: expect.stringContaining("already has a .git") });
      expect(readdirSync(outside)).toEqual([]);
    },
    60_000,
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
