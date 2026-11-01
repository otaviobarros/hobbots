import { isAbsolute } from "node:path";
import { EMPTY_HOB_POLICY } from "@hobbots/domain";
import type { PolicyContext, PolicyVerdict } from "@hobbots/permissions";
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
      { _tag: "Command", operation: "run-commands", cwd: "/work" },
    ]);
    expect(commandRequests("git -C sub status", "/work")).toEqual([
      { _tag: "Command", operation: "local-git", cwd: "/work/sub" },
    ]);
    expect(commandRequests("FOO=1 rm -rf build && ls", "/work")).toEqual([
      { _tag: "Files", operation: "delete-files", paths: ["build"], cwd: "/work" },
      { _tag: "Command", operation: "run-commands", cwd: "/work" },
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
    expect(commandRequests("env FOO=1 rm -rf src", "/work")).toEqual([
      { _tag: "Files", operation: "delete-files", paths: ["src"], cwd: "/work" },
      { _tag: "Command", operation: "run-commands", cwd: "/work" },
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
      { _tag: "Files", operation: "delete-files", paths: [".git/zz-probe"], cwd: "/home/me/project" },
    ]);
    expect(deletes("cd sub && cd ../other; rm x")[0]).toMatchObject({ cwd: "/work/other" });
    expect(deletes("pushd /tmp && rm x")[0]).toMatchObject({ cwd: "/tmp" });
    expect(deletes("cd && rm x")[0]).toMatchObject({ cwd: "/home/me" });
    expect(deletes("rm ~/x")[0]).toMatchObject({ paths: ["/home/me/x"] });
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
      { _tag: "Command", operation: "local-git", cwd: "/work/a/b" },
      { _tag: "Command", operation: "local-git", cwd: "/work" },
    ]);
    expect(commandRequests("make -C build test", "/work")).toEqual([
      { _tag: "Command", operation: "run-commands", cwd: "/work/build" },
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
    });
    expect(push("git push")).toMatchObject({ remote: "origin", toDefaultBranch: true });
    expect(push("git push origin HEAD:refs/heads/main")).toMatchObject({ branch: "main", toDefaultBranch: true });
    expect(push("git push --force-with-lease origin feature")).toMatchObject({ force: true });
    expect(push("git push origin +feature")).toMatchObject({ branch: "feature", force: true });
  });

  it("labels each step from the call's own arguments", () => {
    expect(toolLabel("Edit", { file_path: "/work/src/app.ts" })).toBe("Editing app.ts");
    expect(toolLabel("Bash", { command: "pnpm test\necho done" })).toBe("Running pnpm test");
    expect(toolLabel("Grep", { pattern: "TODO" })).toBe("Searching for TODO");
    expect(toolLabel("Mystery", {})).toBe("Using Mystery");
  });

  it("redacts secrets in a label before shortening it, so no part of one is left", () => {
    const token = `ghp_${"a".repeat(36)}`;
    // Cut at 60 characters, the label would end with the token's first characters.
    const command = `git remote set-url origin https://x:${token}@github.com/acme/app.git`;
    expect(toolLabel("Bash", { command })).toBe("Running git remote set-url origin https://x:[redacted: GitHub token…");
    const known = "a-known-hub-value-123456";
    const redact = (text: string) => text.replaceAll(known, "[redacted: HUB_TOKEN]");
    expect(toolLabel("Bash", { command: `printf %s ${known} | wc -c` }, redact)).toBe(
      "Running printf %s [redacted: HUB_TOKEN] | wc -c",
    );
    expect(toolLabel("Grep", { pattern: token })).toBe("Searching for [redacted: GitHub token]");
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
