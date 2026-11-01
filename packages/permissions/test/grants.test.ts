import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentId, Grant, GrantId, type GrantRule, ruleOperation } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { type PolicyContext, type PolicyRequest, readCommandLine } from "../src/index.ts";
import { contextFor, decide, files, type Home, useHome } from "./fixture.ts";

const home: Home = useHome();

const grantOf = (rule: GrantRule, fields: Partial<Grant> = {}) =>
  new Grant({
    id: GrantId.make(`grant-${JSON.stringify(rule).length}-${Math.random()}`),
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
    ...fields,
  });

const command = (line: string, cwd: string, operation: "run-commands" | "local-git" = "run-commands") => {
  const words = readCommandLine(line)?.[0] ?? null;
  return { _tag: "Command", operation, cwd, words } satisfies PolicyRequest;
};

/** Asks under `context`, then saves what Always would save and returns the context with those grants. */
const approveAlways = async (context: PolicyContext, request: PolicyRequest) => {
  const asked = await decide(context, request);
  expect(asked).toMatchObject({ decision: "ask", grantable: true });
  return { ...context, grants: [...(context.grants ?? []), ...asked.rules.map((rule) => grantOf(rule))] };
};

describe("the command reader", () => {
  it("reads literal words, with their quotes removed", () => {
    expect(readCommandLine("pnpm test")).toEqual([["pnpm", "test"]]);
    expect(readCommandLine("rm '*.tmp'")).toEqual([["rm", "*.tmp"]]);
    expect(readCommandLine(`git commit -m "fix: the thing"`)).toEqual([["git", "commit", "-m", "fix: the thing"]]);
    expect(readCommandLine("pnpm lint && pnpm test | tee out.txt")).toEqual([
      ["pnpm", "lint"],
      ["pnpm", "test"],
      ["tee", "out.txt"],
    ]);
  });

  it("reads nothing from a line with a word the shell would expand or redirect", () => {
    for (const line of [
      "rm *.tmp",
      'rm "$FILE"',
      "ls ~/Code",
      "echo $(whoami)",
      "echo `whoami`",
      "cat <(ls)",
      "pnpm test > out.txt",
      "cat <<EOF",
      "ls {a,b}",
      "ls a?",
      "ls [ab]",
      "sleep 5 &",
      'echo "unterminated',
      "echo a\\ b",
      'echo "$HOME"',
    ]) {
      expect({ line, read: readCommandLine(line) }).toEqual({ line, read: null });
    }
  });

  it("offers no rule for assignments, folder changes, shells and wrappers", () => {
    for (const line of ["FOO=1 pnpm test", "cd src", "pushd src", "eval ls", "sh -c ls", "bash -c ls", "xargs rm"]) {
      expect({ line, read: readCommandLine(line) }).toEqual({ line, read: [null] });
    }
    for (const line of ["env ls", "sudo ls", "exec ls", "watch ls", "/usr/bin/env ls", "=ls"]) {
      expect({ line, read: readCommandLine(line) }).toEqual({ line, read: [null] });
    }
    expect(readCommandLine("cd src && pnpm test")).toEqual([null, ["pnpm", "test"]]);
  });
});

describe("standing grants", () => {
  // covers PE-007, PE-008
  it("[TC-PE-088] answers the preset's Ask for exactly the granted command, folder and hob", async () => {
    const careful = contextFor(home, "careful");
    const granted = await approveAlways(careful, command("pnpm test", home.project));
    const rule = granted.grants[0]?.rule;
    expect(rule).toMatchObject({ _tag: "Command", words: ["pnpm", "test"] });

    const again = await decide(granted, command("pnpm test", home.project));
    expect(again).toMatchObject({ decision: "allow", reason: { code: "grant" } });
    expect(again.grantIds).toEqual([granted.grants[0]?.id]);
    // Another command, the same command with more words, or in another folder, still asks.
    for (const other of [
      command("pnpm test --watch", home.project),
      command("pnpm install", home.project),
      command("pnpm test", path.join(home.project, "src")),
      command("pnpm test", home.notes),
      command("pnpm test", home.project, "local-git"),
    ]) {
      expect((await decide({ ...granted, hob: { ...granted.hob, ownFolders: [home.notes] } }, other)).decision).toBe(
        "ask",
      );
    }
    // Another hob's context carries only its own grants, so the same command asks for it.
    expect((await decide(careful, command("pnpm test", home.project))).decision).toBe("ask");
    // A revoked or expired grant is left out of the live grants, so the next call asks again.
    expect((await decide({ ...granted, grants: [] }, command("pnpm test", home.project))).decision).toBe("ask");
  });

  // covers PE-007
  it("[TC-PE-089] keeps a quoted glob literal, and never grants or matches an unquoted one", async () => {
    const careful = contextFor(home, "careful");
    const literal = await approveAlways(careful, command("rm '*.tmp'", home.project));
    expect(literal.grants[0]?.rule).toMatchObject({ words: ["rm", "*.tmp"] });
    const glob = await decide(literal, command("rm *.tmp", home.project));
    expect(glob).toMatchObject({ decision: "ask", grantable: false, rules: [] });
    expect(await decide(careful, { _tag: "Command", operation: "run-commands", cwd: home.project })).toMatchObject({
      decision: "ask",
      grantable: false,
    });
  });

  // covers PE-007, AG-004
  it("[TC-PE-090] never answers Deny, Never, a narrower Ask, a high-risk push or a safety Ask", async () => {
    const careful = contextFor(home, "careful");
    const edit = files("edit-files", home.project, "src/index.ts");
    const granted = await approveAlways(careful, edit);
    expect(granted.grants[0]?.rule).toMatchObject({ _tag: "Folder", folder: path.join(home.project, "src") });
    expect((await decide(granted, edit)).decision).toBe("allow");
    // A file beside it is covered; one in a subfolder is not.
    await fs.mkdir(path.join(home.project, "src", "deep"), { recursive: true });
    expect((await decide(granted, files("edit-files", home.project, "src/other.ts"))).decision).toBe("allow");
    expect((await decide(granted, files("edit-files", home.project, "src/deep/x.ts"))).decision).toBe("ask");

    // The hob's override or a restriction asking, or answering Never, wins over the grant.
    const override = { ...granted, hob: { ...granted.hob, overrides: { "edit-files": "ask" as const } } };
    expect(await decide(override, edit)).toMatchObject({ decision: "ask", grantable: false });
    const restricted = { ...granted, restrictions: [{ "edit-files": "deny" as const }] };
    expect((await decide(restricted, edit)).decision).toBe("deny");

    // Changing a Git config is refused, whatever grants exist, while reading it follows the policy.
    const config = files("edit-files", home.project, ".git/config");
    const everything = {
      ...granted,
      grants: [
        grantOf({ _tag: "Folder", operation: "edit-files", folder: path.join(home.project, ".git") }),
        grantOf({ _tag: "Paths", operation: "edit-files", paths: [path.join(home.project, ".git", "config")] }),
      ],
    };
    expect(await decide(everything, config)).toMatchObject({ decision: "deny", reason: { code: "protected-path" } });
    expect((await decide(everything, files("read-files", home.project, ".git/config"))).decision).toBe("allow");

    // Outside the hob's folders is Deny, and no rule reaches it.
    const outside = {
      ...granted,
      grants: [grantOf({ _tag: "Paths", operation: "edit-files", paths: [home.secret] })],
    };
    expect((await decide(outside, files("edit-files", home.project, home.secret))).decision).toBe("deny");

    // A push to the default branch asks once only, under Trusting too, and offers no rule.
    for (const preset of ["careful", "trusting"] as const) {
      const push = { _tag: "Push", remote: "origin", branch: "main", force: false, toDefaultBranch: true } as const;
      const withGrant = {
        ...contextFor(home, preset),
        grants: [grantOf({ _tag: "Push", cwd: home.project, remote: "origin", branch: "main" })],
      };
      expect(await decide(withGrant, { ...push, cwd: home.project })).toMatchObject({
        decision: "ask",
        onceOnly: true,
        grantable: false,
      });
    }
  });

  // covers PE-007
  it("[TC-PE-091] grants a feature-branch push from its folder, a host exactly, and a delete by its path", async () => {
    const careful = contextFor(home, "careful");
    const push = {
      _tag: "Push",
      remote: "origin",
      branch: "feature",
      force: false,
      toDefaultBranch: false,
      cwd: home.project,
    } as const;
    const pushed = await approveAlways(careful, push);
    expect((await decide(pushed, push)).decision).toBe("allow");
    expect((await decide(pushed, { ...push, branch: "other" })).decision).toBe("ask");
    const { cwd: _cwd, ...unplaced } = push;
    expect(await decide(careful, unplaced)).toMatchObject({ decision: "ask", grantable: false });

    const web = { _tag: "Web", host: "Registry.npmjs.org.", addresses: [] } as const;
    const hosted = await approveAlways(careful, web);
    expect(hosted.grants[0]?.rule).toEqual({ _tag: "Host", host: "registry.npmjs.org" });
    expect((await decide(hosted, { ...web, host: "registry.npmjs.org" })).decision).toBe("allow");
    expect((await decide(hosted, { ...web, host: "evil.registry.npmjs.org" })).decision).toBe("ask");

    const remove = files("delete-files", home.project, "src");
    const deleting = await approveAlways(careful, remove);
    // Deleting a folder saves a rule for that folder only, never for the folder above it.
    expect(deleting.grants[0]?.rule).toEqual({
      _tag: "Paths",
      operation: "delete-files",
      paths: [path.join(home.project, "src")],
    });
    expect((await decide(deleting, remove)).decision).toBe("allow");
    expect((await decide(deleting, files("delete-files", home.project, "src/index.ts"))).decision).toBe("ask");
  });

  // covers PE-007
  it("leaves grants out of the policy version, and applies a Quest grant only to its Quest", async () => {
    const careful = contextFor(home, "careful");
    const granted = await approveAlways(careful, command("pnpm test", home.project));
    expect((await decide(granted, command("pnpm test", home.project))).policyVersion).toBe(
      (await decide(careful, command("pnpm test", home.project))).policyVersion,
    );
    const quest = {
      ...granted,
      grants: granted.grants.map((g) => new Grant({ ...g, lifetime: "quest", questId: "q1" })),
    };
    expect((await decide(quest, command("pnpm test", home.project))).decision).toBe("ask");
    expect((await decide({ ...quest, questId: "q1" }, command("pnpm test", home.project))).decision).toBe("allow");
  });
});
