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
      { _tag: "Command", operation: "run-commands", cwd: "/work", words: ["pnpm", "test"] },
    ]);
    expect(commandRequests("git -C sub status", "/work")).toEqual([
      { _tag: "Command", operation: "local-git", cwd: "/work", words: ["git", "-C", "sub", "status"] },
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

  it("treats a push of an unknown branch, the default branch or with force as protected", () => {
    const push = (command: string) => commandRequests(command, "/work")[0];
    expect(push("git push origin feature")).toEqual({
      _tag: "Push",
      remote: "origin",
      branch: "feature",
      force: false,
      toDefaultBranch: false,
      cwd: "/work",
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
