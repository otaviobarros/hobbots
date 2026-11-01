import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isAbsolute } from "node:path";
import { AgentId, EMPTY_HOB_POLICY, Grant, GrantId, ruleOperation } from "@hobbots/domain";
import { type PolicyContext, PolicyEngine, type PolicyRequest, type PolicyVerdict } from "@hobbots/permissions";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  commandRequests,
  narrowestVerdict,
  offeredTools,
  simpleCommands,
  toolLabel,
  toolRequests,
} from "../src/tool-calls.ts";

const context = (overrides: Partial<PolicyContext> = {}): PolicyContext => ({
  preset: "balanced",
  sharedFolders: ["/work"],
  hob: EMPTY_HOB_POLICY,
  dataFolder: "/data",
  sandbox: "on",
  modelHosts: [],
  restrictions: [],
  ...overrides,
});

describe("Claude Code tool calls as policy requests", () => {
  it("maps file tools to the paths they name, and searches to their folder", () => {
    expect(toolRequests("Read", { file_path: "a.ts" }, "/work")).toEqual([
      { _tag: "Files", operation: "read-files", paths: ["a.ts"], cwd: "/work" },
    ]);
    expect(toolRequests("Edit", { file_path: "/work/a.ts" }, "/work")).toEqual([
      { _tag: "Files", operation: "edit-files", paths: ["/work/a.ts"], cwd: "/work" },
    ]);
    expect(toolRequests("NotebookEdit", { notebook_path: "n.ipynb" }, "/work")?.[0]).toMatchObject({
      operation: "edit-files",
      paths: ["n.ipynb"],
    });
    expect(toolRequests("Grep", { pattern: "x" }, "/work")?.[0]).toMatchObject({ paths: ["/work"] });
    expect(toolRequests("Glob", { pattern: "*", path: "/elsewhere" }, "/work")?.[0]).toMatchObject({
      paths: ["/elsewhere"],
    });
  });

  it("gives a file tool without a path no target, so the engine refuses it", () => {
    expect(toolRequests("Write", {}, "/work")).toEqual([
      { _tag: "Files", operation: "edit-files", paths: [], cwd: "/work" },
    ]);
  });

  it("knows no other tool", () => {
    expect(toolRequests("WebFetch", { url: "https://example.com" }, "/work")).toBeNull();
    expect(toolRequests("mcp__x__y", {}, "/work")).toBeNull();
  });

  it("splits a command line into simple commands, honoring quotes", () => {
    expect(simpleCommands(`pnpm test && git commit -m "a; b" | cat`)).toEqual([
      ["pnpm", "test"],
      ["git", "commit", "-m", "a; b"],
      ["cat"],
    ]);
    expect(simpleCommands(String.raw`echo 'it''s' \; done`)).toEqual([["echo", "its", ";", "done"]]);
  });

  it("recognizes Git, pushes and deletes inside a command", () => {
    expect(commandRequests("pnpm test", "/work")).toEqual([
      { _tag: "Command", operation: "run-commands", cwd: "/work", words: ["pnpm", "test"] },
    ]);
    expect(commandRequests("git -C sub status", "/work")).toEqual([
      { _tag: "Command", operation: "local-git", cwd: "/work/sub", words: ["git", "-C", "sub", "status"] },
    ]);
    // A leading assignment cannot be granted; the next simple command still can.
    expect(commandRequests("FOO=1 rm -rf build && ls", "/work")).toEqual([
      { _tag: "Files", operation: "delete-files", paths: ["build"], cwd: "/work", exact: false },
      { _tag: "Command", operation: "run-commands", cwd: "/work", words: null },
      { _tag: "Command", operation: "run-commands", cwd: "/work", words: ["ls"] },
    ]);
    // A line the reader cannot read gives no words to any of its commands.
    expect(commandRequests("rm *.tmp; ls", "/work")).toEqual([
      { _tag: "Files", operation: "delete-files", paths: ["*.tmp"], cwd: "/work", exact: false },
      { _tag: "Command", operation: "run-commands", cwd: "/work", words: null },
    ]);
  });

  it("[#209] sees through assignments and wrappers in any order, by basename and with their options", () => {
    const decided = (command: string) =>
      commandRequests(command, "/work", "/home/me").map((r) => (r._tag === "Command" ? r.operation : r._tag));
    for (const command of [
      "FOO=1 git push origin main",
      "env FOO=1 git push origin main",
      "env -i git push origin main",
      "env -u HOME -- git push origin main",
      "/usr/bin/env git push origin main",
      "command -p git push origin main",
      "nice git push origin main",
      "nice -n 5 git push origin main",
      "timeout 30 git push origin main",
      "timeout -s KILL 30 git push origin main",
      "nohup nice -5 env A=1 time -p git push origin main",
      "env -S 'git push origin main'",
      "exec -a x git push origin main",
    ])
      expect(decided(command), command).toEqual(["Push"]);
    expect(commandRequests("timeout 30 git push origin main", "/work")[0]).toMatchObject({
      branch: "main",
      toDefaultBranch: true,
    });
    expect(decided("GIT_CONFIG_GLOBAL=/dev/null git -C /work log")).toEqual(["local-git"]);
    // A wrapper's line offers no rule (ADR 015).
    expect(commandRequests("env FOO=1 rm -rf src", "/work")).toEqual([
      { _tag: "Files", operation: "delete-files", paths: ["src"], cwd: "/work", exact: false },
      { _tag: "Command", operation: "run-commands", cwd: "/work", words: null },
    ]);
  });

  it("[#209] ignores redirections, so they are not read as a remote or a file", () => {
    expect(commandRequests("git push 2>&1 | tail -5", "/work")[0]).toMatchObject({ remote: "origin" });
    expect(commandRequests("rm -f a > /dev/null 2> err.log &> all.log", "/work")[0]).toMatchObject({ paths: ["a"] });
  });

  it("[#209] resolves later paths against the folder cd and pushd move to", () => {
    const deletes = (command: string) =>
      commandRequests(command, "/work", "/home/me").filter((r) => r._tag === "Files");
    expect(deletes("pwd; cd ~/project && touch x; rm -rf .git/zz-probe")).toEqual([
      { _tag: "Files", operation: "delete-files", paths: [".git/zz-probe"], cwd: "/home/me/project", exact: false },
    ]);
    expect(deletes("cd sub && cd ../other; rm x")[0]).toMatchObject({ cwd: "/work/other" });
    expect(deletes("pushd /tmp && rm x")[0]).toMatchObject({ cwd: "/tmp" });
    expect(deletes("cd && rm x")[0]).toMatchObject({ cwd: "/home/me" });
    expect(deletes("rm ~/x")[0]).toMatchObject({ paths: ["/home/me/x"] });
    // A quoted `~` is passed on as written, so the path stays relative to the folder.
    expect(deletes("rm '~/x'")[0]).toMatchObject({ paths: ["~/x"], cwd: "/work", exact: true });
    expect(deletes('rm "~"')[0]).toMatchObject({ paths: ["~"], exact: true });
    expect(commandRequests("git -C '~/x' status", "/work", "/home/me")[0]).toMatchObject({ cwd: "/work/~/x" });
    // A subshell, a pipeline and the background do not move the shell itself.
    expect(deletes("(cd sub && rm a); rm b").map((r) => r.cwd)).toEqual(["/work/sub", "/work"]);
    expect(deletes("cd sub | cat; rm b")[0]).toMatchObject({ cwd: "/work" });
    expect(deletes("cd sub & rm b")[0]).toMatchObject({ cwd: "/work" });
    expect(deletes("cd sub && echo ready & rm file")[0]).toMatchObject({ cwd: "/work" });
    expect(deletes("cd a || cd b & rm file")[0]).toMatchObject({ cwd: "/work" });
    expect(deletes("cd sub; make & rm file")[0]).toMatchObject({ cwd: "/work/sub" });
  });

  it("[#209] takes `..` off the spelling after cd, as the shell does, but not after git -C", () => {
    // With /work/link pointing at /work/real/deep, `cd link && cd ..` is back in /work.
    expect(commandRequests("cd link && cd .. && rm file", "/work").find((r) => r._tag === "Files")).toMatchObject({
      cwd: "/work",
    });
    expect(commandRequests("git -C link/.. status", "/work")[0]).toMatchObject({ cwd: "/work/link/.." });
    // `cd -P` follows links Hobbots does not read, so the folder after it is not worked out.
    const physical = commandRequests("cd -P link && rm file", "/work")[1];
    expect(physical?._tag === "Files" && isAbsolute(physical.cwd)).toBe(false);
  });

  it("[#209] does not guess the folder when a cd may have been skipped", () => {
    const cwdOf = (command: string) => {
      const remove = commandRequests(command, "/work").find((r) => r._tag === "Files");
      return remove?._tag === "Files" ? remove.cwd : undefined;
    };
    for (const command of ["false && cd sub; rm file", "true || cd sub; rm file", "cd a || cd b; rm file"])
      expect(isAbsolute(cwdOf(command) ?? "/"), command).toBe(false);
    expect(commandRequests("false && cd /tmp; git status", "/work").at(-1)).toMatchObject({ operation: "local-git" });
    expect(isAbsolute((commandRequests("false && cd /tmp; git status", "/work").at(-1) as { cwd: string }).cwd)).toBe(
      false,
    );
    // A command that runs only after the cd ran, or only when it failed, is in a known folder.
    expect(cwdOf("make && cd sub && rm file")).toBe("/work/sub");
    expect(cwdOf("cd sub || rm file")).toBe("/work");
    expect(cwdOf("(false && cd sub); rm file")).toBe("/work");
  });

  it("[#209] keeps quoted operators as arguments, dropping only real redirections", () => {
    expect(commandRequests("rm -f '>' .git/config safe", "/work")[0]).toMatchObject({
      paths: [">", ".git/config", "safe"],
    });
    expect(commandRequests(String.raw`rm \> a 2>/dev/null`, "/work")[0]).toMatchObject({ paths: [">", "a"] });
    expect(commandRequests("rm a > 'out file' b", "/work")[0]).toMatchObject({ paths: ["a", "b"] });
    // A quoted target does not make the operator before it an argument.
    expect(commandRequests(`git push 2>"log" origin main`, "/work")[0]).toMatchObject({
      remote: "origin",
      branch: "main",
      toDefaultBranch: true,
    });
    expect(commandRequests(`rm a >'out' 2>>"err" <in b`, "/work")[0]).toMatchObject({ paths: ["a", "b"] });
  });

  it("[#209] moves git -C, make -C and env -C only for their own command", () => {
    expect(commandRequests("git -C a -C b status; git status", "/work")).toEqual([
      { _tag: "Command", operation: "local-git", cwd: "/work/a/b", words: ["git", "-C", "a", "-C", "b", "status"] },
      { _tag: "Command", operation: "local-git", cwd: "/work", words: ["git", "status"] },
    ]);
    expect(commandRequests("make -C build test", "/work")).toEqual([
      { _tag: "Command", operation: "run-commands", cwd: "/work/build", words: ["make", "-C", "build", "test"] },
    ]);
    expect(commandRequests("make --directory=/elsewhere", "/work")[0]).toMatchObject({ cwd: "/elsewhere" });
    expect(commandRequests("env -C /elsewhere rm x", "/work")[0]).toMatchObject({ cwd: "/elsewhere" });
  });

  it("[#209] leaves a folder it cannot work out unresolved, never as an absolute path", () => {
    for (const command of [
      `cd "$DIR" && rm x`,
      "cd - && rm x",
      "cd sub || exit 1; rm x",
      "popd; rm x",
      "cd /work/* && rm x",
    ]) {
      const requests = commandRequests(command, "/work");
      const remove = requests.find((r) => r._tag === "Files");
      const run = requests.findLast((r) => r._tag === "Command");
      expect(remove, command).toMatchObject({ paths: ["x"] });
      expect(remove?._tag === "Files" && isAbsolute(remove.cwd), command).toBe(false);
      expect(run?._tag === "Command" && !isAbsolute(run.cwd), command).toBe(true);
    }
    // An absolute path does not depend on the folder.
    expect(commandRequests(`cd "$DIR" && rm /work/x`, "/work")[1]).toMatchObject({ paths: ["/work/x"] });
  });

  it("treats a push of an unknown branch, the default branch or with force as protected", () => {
    const push = (command: string) => commandRequests(command, "/work")[0];
    expect(push("git push origin feature")).toEqual({
      _tag: "Push",
      remote: "origin",
      branch: "feature",
      force: false,
      toDefaultBranch: false,
      cwd: "/work",
      exact: true,
    });
    expect(push("git push")).toMatchObject({ remote: "origin", toDefaultBranch: true });
    expect(push("git push origin HEAD:refs/heads/main")).toMatchObject({ branch: "main", toDefaultBranch: true });
    expect(push("git push --force-with-lease origin feature")).toMatchObject({ force: true });
    expect(push("git push origin +feature")).toMatchObject({ branch: "feature", force: true });
    expect(push("git push origin :feature")).toMatchObject({ branch: "feature", force: true });
  });

  it("decides every branch a push updates, and marks a push its words do not fully describe as inexact", () => {
    const pushes = (command: string) => commandRequests(command, "/work").filter((r) => r._tag === "Push");
    expect(pushes("git push origin feature main")).toEqual([
      {
        _tag: "Push",
        remote: "origin",
        branch: "feature",
        force: false,
        toDefaultBranch: false,
        cwd: "/work",
        exact: true,
      },
      {
        _tag: "Push",
        remote: "origin",
        branch: "main",
        force: false,
        toDefaultBranch: true,
        cwd: "/work",
        exact: true,
      },
    ]);
    expect(pushes("git push -u origin feature")).toMatchObject([{ branch: "feature", exact: true }]);
    for (const command of [
      "git push --force-with-lease origin feature",
      "git push -o ci.skip origin feature",
      "git -C ../sibling push origin feature",
      "git -c push.default=matching push origin feature",
      "cd sub && git push origin feature",
    ]) {
      expect({ command, exact: pushes(command).map((p) => p._tag === "Push" && p.exact) }).toEqual({
        command,
        exact: pushes(command).map(() => false),
      });
    }
    expect(pushes("git push --all origin")).toMatchObject([{ toDefaultBranch: true, exact: false }]);
    // Patterns, matching pushes and the current branch do not name the branches they update.
    for (const command of [
      "git push origin 'refs/heads/*:refs/heads/*'",
      "git push origin :",
      "git push origin +:",
      "git push origin HEAD",
      "git push origin @",
      "git push origin HEAD:HEAD",
    ]) {
      expect({ command, pushes: pushes(command) }).toMatchObject({
        command,
        pushes: [{ toDefaultBranch: true, exact: false }],
      });
    }
    expect(pushes("git push --tags origin feature")).toMatchObject([{ toDefaultBranch: true, exact: false }]);
  });

  it("names no exact paths or words in a line that changes folder", () => {
    expect(commandRequests("cd sub && rm build", "/work")).toEqual([
      { _tag: "Command", operation: "run-commands", cwd: "/work", words: null },
      { _tag: "Files", operation: "delete-files", paths: ["build"], cwd: "/work/sub", exact: false },
      { _tag: "Command", operation: "run-commands", cwd: "/work/sub", words: null },
    ]);
  });

  it("labels each step from the call's own arguments", () => {
    expect(toolLabel("Edit", { file_path: "/work/src/app.ts" })).toBe("Editing app.ts");
    expect(toolLabel("Bash", { command: "pnpm test\necho done" })).toBe("Running pnpm test");
    expect(toolLabel("Grep", { pattern: "TODO" })).toBe("Searching for TODO");
    expect(toolLabel("Mystery", {})).toBe("Using Mystery");
  });

  it("redacts secrets in a label before shortening it, so no part of one is left", () => {
    const token = `ghp_${"a".repeat(36)}`;
    // Cut at 100 characters, the label would end inside the marker, so it is cut before it.
    const command = `git remote set-url --push upstream-mirror-of-the-entire-project-here https://x:${token}@github.com/acme/app.git`;
    expect(toolLabel("Bash", { command })).toBe(
      "Running git remote set-url --push upstream-mirror-of-the-entire-project-here https://x:…",
    );
    // A marker holds spaces but reads as one word, so it stays whole.
    expect(toolLabel("Bash", { command: `GITHUB_TOKEN=${token} gh pr list` })).toBe(
      "Running GITHUB_TOKEN=[redacted: GitHub token] gh pr list",
    );
    const known = "a-known-hub-value-123456";
    const redact = (text: string) => text.replaceAll(known, "[redacted: HUB_TOKEN]");
    expect(toolLabel("Bash", { command: `printf %s ${known} | wc -c` }, redact)).toBe(
      "Running printf %s [redacted: HUB_TOKEN] | wc -c",
    );
    expect(toolLabel("Grep", { pattern: token })).toBe("Searching for [redacted: GitHub token]");
  });
});

describe("[#210] command step labels", () => {
  const label = (command: string) => toolLabel("Bash", { command });

  it("leaves out leading assignments and the folder a lone Git command names, which On shows", () => {
    expect(label("GIT_CONFIG_GLOBAL=/dev/null git -C /Users/me/Development/projects/hobbots log --oneline -30")).toBe(
      "Running git log --oneline -30",
    );
    expect(label("git --git-dir=/srv/app/.git --work-tree /srv/app -c core.pager=cat status")).toBe(
      "Running git -c core.pager=cat status",
    );
    // A line of nothing but assignments is shown as it is.
    expect(label("FOO=1")).toBe("Running FOO=1");
  });

  it("keeps assignments that run code, expand, or change which repository or program is used", () => {
    expect(label('X="$(rm -rf /tmp/x)" git status')).toBe('Running X="$(rm -rf /tmp/x)" git status');
    expect(label("X=`rm -rf ~` git status")).toBe("Running X=`rm -rf ~` git status");
    expect(label("GIT_DIR=/outside/.git git commit -m x")).toBe("Running GIT_DIR=/outside/.git git commit -m x");
    expect(label("PATH=/tmp/bin:$PATH make")).toBe("Running PATH=/tmp/bin:$PATH make");
    expect(label("LD_PRELOAD=/tmp/x.so ls")).toBe("Running LD_PRELOAD=/tmp/x.so ls");
    expect(label('GIT_SSH_COMMAND="ssh -i k" git fetch')).toBe('Running GIT_SSH_COMMAND="ssh -i k" git fetch');
    expect(label("NODE_OPTIONS=--require=x.js npm test")).toBe("Running NODE_OPTIONS=--require=x.js npm test");
    // A config file left out is plain; one put in its place may run code.
    expect(label("GIT_CONFIG_GLOBAL=~/evil git status")).toBe("Running GIT_CONFIG_GLOBAL=~/evil git status");
    expect(label("NO_COLOR=1 CI=true pnpm test")).toBe("Running pnpm test");
  });

  it("keeps the line's own spacing around separators", () => {
    expect(label("echo $(date)")).toBe("Running echo $(date)");
    expect(label("cat <(ls) | wc -l")).toBe("Running cat <(ls) | wc -l");
    expect(label("(cd x; ls)&&pwd")).toBe("Running (cd x; ls)&&pwd");
  });

  it("never mistakes the command's own text for a redaction marker", () => {
    expect(label("echo \uE0000\uE001 x")).toBe("Running echo 0 x");
  });

  it("keeps the folder options of a Git command that shares its line, since On names one folder", () => {
    expect(label("cd /srv && git -C app log")).toBe("Running cd /srv && git -C app log");
  });

  it("cuts long paths to their last two parts and keeps quotes, redirections and URLs", () => {
    expect(label("pnpm exec vitest run /Users/me/dev/hobbots/apps/web/src/x.test.ts 2>&1 | tail -5")).toBe(
      "Running pnpm exec vitest run …/src/x.test.ts 2>&1 | tail -5",
    );
    expect(label("cp --target-directory=/Users/me/dev/out a.txt")).toBe(
      "Running cp --target-directory=…/dev/out a.txt",
    );
    expect(label(`grep -n "two  spaces" '/Users/me/dev/hobbots/notes.md'`)).toBe(
      `Running grep -n "two  spaces" '…/hobbots/notes.md'`,
    );
    expect(label("curl https://github.com/acme/app/pulls/1")).toBe("Running curl https://github.com/acme/app/pulls/1");
    expect(label("ls /tmp/a/b")).toBe("Running ls /tmp/a/b");
  });

  it("labels from the first line that says something", () => {
    expect(label("\n\nls -la\npwd")).toBe("Running ls -la");
  });
});

describe("[#210] the folder a Git command works in", () => {
  const folders = (command: string) =>
    commandRequests(command, "/work").map((r) => (r._tag === "Web" ? r.host : r.cwd));

  it("names the repository first, then the working tree --work-tree points at", () => {
    // Without --git-dir, Git finds the repository from the folder it runs in.
    expect(commandRequests("git --work-tree=/srv/app status", "/work")).toEqual([
      { _tag: "Command", operation: "local-git", cwd: "/work", words: ["git", "--work-tree=/srv/app", "status"] },
      { _tag: "Command", operation: "local-git", cwd: "/srv/app", words: ["git", "--work-tree=/srv/app", "status"] },
    ]);
    expect(folders("git --git-dir /srv/app/.git --work-tree=/srv/app log")).toEqual(["/srv/app", "/work"]);
    // A bare repository is its own folder.
    expect(folders("git --git-dir=/srv/app.git --work-tree=/srv/app log")).toEqual([
      "/srv/app.git",
      "/srv/app",
      "/work",
    ]);
    expect(commandRequests("git -C /srv --work-tree=app push origin feature", "/work")[0]).toMatchObject({
      _tag: "Push",
      cwd: "/srv",
    });
  });

  it("resolves --git-dir and --work-tree after every -C, as Git does", () => {
    expect(folders("git -C /outside --work-tree=/hob commit")).toEqual(["/outside", "/hob"]);
    expect(folders("git --work-tree=/hob -C /outside commit")).toEqual(["/outside", "/hob"]);
    expect(folders("git --work-tree=. -C /outside commit")).toEqual(["/outside", "/outside/."]);
    expect(folders("git --git-dir=.git --work-tree=. -C /outside commit")).toEqual(["/outside", "/outside/."]);
    // Git still writes some files where it runs, so that folder is decided as well.
    expect(folders("git -C /outside --git-dir=/hob/.git --work-tree=/hob archive -o out.tar HEAD")).toEqual([
      "/hob",
      "/outside",
    ]);
    expect(
      commandRequests("cd /outside && git --work-tree=/hob add f", "/work").map((r) =>
        r._tag === "Web" ? r.host : r.cwd,
      ),
    ).toEqual(["/work", "/outside", "/hob"]);
  });

  it("also names the folder Git runs in when a Git directory has no working tree", () => {
    // Git then works on the folder it runs in, so both are decided.
    expect(folders("git --git-dir=/srv/app/.git checkout .")).toEqual(["/srv/app", "/work"]);
    expect(folders("git --git-dir=/srv/app.git log")).toEqual(["/srv/app.git", "/work"]);
    // A folder Hobbots cannot work out stays closed.
    expect(isAbsolute(folders('git --git-dir="$DIR" log')[0] ?? "/")).toBe(false);
  });
});

describe("tools offered for a turn", () => {
  it("offers every mapped tool under Balanced with the sandbox on", () => {
    expect(offeredTools(context())).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "Bash",
    ]);
  });

  it("leaves out commands when the sandbox cannot start", () => {
    expect(offeredTools(context({ sandbox: "unavailable" }))).not.toContain("Bash");
  });

  it("leaves out a tool whose operations the hob's overrides deny", () => {
    const hob = {
      ...EMPTY_HOB_POLICY,
      overrides: { "edit-files": "deny", "run-commands": "deny", "local-git": "deny" },
    } as const;
    expect(offeredTools(context({ hob }))).toEqual(["Read", "Glob", "Grep"]);
  });

  it("keeps a tool a restriction only narrows to Ask, since each call is still decided", () => {
    expect(offeredTools(context({ restrictions: [{ "edit-files": "ask" }] }))).toContain("Edit");
  });

  it("[TC-PE-019] leaves out commands unless the hob may read and edit its folders without asking", () => {
    // covers PE-005
    // A command reads and writes files without a call per file, so it would get past the narrower answer.
    for (const restriction of [
      { "edit-files": "ask" },
      { "edit-files": "deny" },
      { "read-files": "ask" },
      { "read-files": "deny" },
    ] as const)
      expect(offeredTools(context({ restrictions: [restriction] }))).not.toContain("Bash");
  });
});

describe("combining verdicts", () => {
  const verdict = (decision: PolicyVerdict["decision"], operation: PolicyVerdict["operation"]): PolicyVerdict => ({
    decision,
    operation,
    reason: { code: "preset", message: "" },
    targets: [],
    enforcement: "enforced",
    onceOnly: false,
    grantable: false,
    rules: [],
    grantIds: [],
    policyVersion: "v",
  });

  it("takes the narrowest, keeping the first on a tie", () => {
    expect(narrowestVerdict([verdict("allow", "run-commands"), verdict("ask", "delete-files")])?.operation).toBe(
      "delete-files",
    );
    expect(narrowestVerdict([verdict("allow", "run-commands"), verdict("allow", "local-git")])?.operation).toBe(
      "run-commands",
    );
    expect(narrowestVerdict([])).toBeUndefined();
  });
});

describe("grants from command lines", () => {
  const decide = (context: PolicyContext, request: PolicyRequest) =>
    Effect.gen(function* () {
      const engine = yield* PolicyEngine;
      return yield* engine.decide(context, request);
    }).pipe(Effect.provide(PolicyEngine.node), Effect.runPromise);

  // covers PE-007
  it("[TC-PE-099] saves a quoted ~ path as written, so its grant never answers the home folder's path", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hobbots-tilde-")));
    const home = path.join(root, "home");
    const work = path.join(root, "work");
    await fs.mkdir(path.join(work, "~", "artifact"), { recursive: true });
    await fs.mkdir(path.join(home, "artifact"), { recursive: true });
    const careful = context({ preset: "careful", sharedFolders: [root] });
    const [quoted] = commandRequests("rm -r '~/artifact'", work, home);
    if (quoted === undefined) throw new Error("no delete request");
    const asked = await decide(careful, quoted);
    expect(asked).toMatchObject({ decision: "ask", grantable: true });
    // The shell deletes `work/~/artifact`, and that is the path the rule names.
    expect(asked.rules).toEqual([
      { _tag: "Paths", operation: "delete-files", paths: [path.join(work, "~", "artifact")] },
    ]);
    const grants = asked.rules.map(
      (rule, i) =>
        new Grant({
          id: GrantId.make(`grant-${i}`),
          agentId: AgentId.make("scout"),
          operation: ruleOperation(rule),
          rule,
          lifetime: "always",
          questId: null,
          approvalId: null,
          grantedBy: "user",
          createdAt: "2026-11-01T00:00:00.000Z",
          expiresAt: null,
          lastUsedAt: null,
          revokedAt: null,
          revokedBy: null,
          revokeReason: null,
        }),
    );
    const granted = { ...careful, grants };
    expect((await decide(granted, quoted)).decision).toBe("allow");
    const [homePath] = commandRequests(`rm -r ${path.join(home, "artifact")}`, work, home);
    if (homePath === undefined) throw new Error("no delete request");
    expect((await decide(granted, homePath)).decision).toBe("ask");
    await fs.rm(root, { recursive: true, force: true });
  });
});
