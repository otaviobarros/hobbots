import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  AgentId,
  type CharmOperation,
  type CharmOperationId,
  Grant,
  GrantId,
  GrantRule,
  HobPolicy,
  ruleOperation,
  StoredPolicyLayer,
  TaskId,
} from "@hobbots/domain";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { type PolicyContext, type PolicyRequest, readCommandLine } from "../src/index.ts";
import {
  comment,
  contextFor,
  decide,
  files,
  GITHUB_OPERATIONS,
  githubRead,
  type Home,
  pullRequest,
  useHome,
} from "./fixture.ts";

const home: Home = useHome();

const grantOf = (rule: GrantRule, fields: Partial<Grant> = {}) =>
  new Grant({
    id: GrantId.make(`grant-${JSON.stringify(rule).length}-${Math.random()}`),
    agentId: AgentId.make("scout"),
    operation: ruleOperation(rule),
    rule,
    lifetime: "always",
    taskId: null,
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
    for (const line of ["FOO=1 pnpm test", "=ls"]) {
      expect({ line, read: readCommandLine(line) }).toEqual({ line, read: [null] });
    }
    // A wrapper may run anything, anywhere: no command in its line is granted.
    for (const line of [
      "eval ls",
      "sh -c ls",
      "bash -c ls",
      "xargs rm",
      "env ls",
      "sudo ls",
      "exec ls",
      "watch ls",
      "/usr/bin/env ls",
      "ls && env -C sub rm build",
    ]) {
      expect({ line, read: readCommandLine(line) }).toEqual({ line, read: null });
    }
    expect(readCommandLine("git add . && pnpm run watch")).toEqual([
      ["git", "add", "."],
      ["pnpm", "run", "watch"],
    ]);
    expect(readCommandLine("FOO=1 ls && pnpm test")).toEqual([null, ["pnpm", "test"]]);
  });

  it("reads nothing from a line that changes folder, so no command in it is granted against the wrong one", () => {
    for (const line of [
      "cd src",
      "cd src && rm build",
      "pnpm build; pushd dist",
      "popd && ls",
      "/usr/bin/cd x; ls",
      "command cd sub && rm build",
      "builtin cd sub && rm build",
      "CDPATH=/tmp cd sub && rm build",
      "nice cd sub; rm build",
      "if true; then cd sub; fi; rm build",
      "true && { cd sub; }; rm build",
      "for d in sub; do cd sub; done; rm build",
      "while false; do :; done; rm build",
      "case x in x) ;; esac; rm build",
      "! cd sub; rm build",
      "trap 'cd sub' EXIT; rm build",
      "[[ -d sub ]] && rm build",
      "echo cd; rm build",
    ]) {
      expect({ line, read: readCommandLine(line) }).toEqual({ line, read: null });
    }
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
    // A saved rule holds the canonical path, which differs where the temp folder is a symlink.
    const src = await fs.realpath(path.join(home.project, "src"));
    expect(granted.grants[0]?.rule).toMatchObject({ _tag: "Folder", folder: src });
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
    // A push whose words do not say everything it does neither matches a grant nor offers one.
    expect(await decide(pushed, { ...push, exact: false })).toMatchObject({ decision: "ask", grantable: false });
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
      paths: [await fs.realpath(path.join(home.project, "src"))],
    });
    expect((await decide(deleting, remove)).decision).toBe("allow");
    expect((await decide(deleting, files("delete-files", home.project, "src/index.ts"))).decision).toBe("ask");
  });

  // covers ADR 036 (Addresses)
  it("[TC-PE-1267-18] asks before a page on a private address under every preset, and Always answers that host alone", async () => {
    const page = (host: string, addresses: ReadonlyArray<string>, found = true) =>
      ({ _tag: "Web", host, addresses, page: { url: `http://${host}/`, found } }) as const;
    for (const preset of ["careful", "balanced", "trusting"] as const) {
      const context = contextFor(home, preset);
      for (const [host, addresses] of [
        ["10.0.0.8", ["10.0.0.8"]],
        ["nas.home", ["192.168.1.20"]],
        ["printer.lan", ["172.16.4.4"]],
        ["box.ts.example", ["100.64.0.9"]],
        ["v6.home", ["[fd12:3456::1]"]],
      ] as const) {
        expect(await decide(context, page(host, addresses))).toMatchObject({
          decision: "ask",
          grantable: true,
          reason: { code: "private-address" },
          rules: [{ _tag: "Host", host }],
        });
      }
      // A page on a public address is the site rules' to decide, and loopback stays refused.
      expect((await decide(context, page("example.com", ["93.184.215.14"]))).reason.code).not.toBe("private-address");
      expect((await decide(context, page("loop.example", ["127.0.0.1"]))).decision).toBe("deny");
      const nas = await approveAlways(context, page("nas.home", ["192.168.1.20"]));
      expect((await decide(nas, page("nas.home", ["192.168.1.20"]))).decision).toBe("allow");
      expect((await decide(nas, page("printer.lan", ["172.16.4.4"]))).decision).toBe("ask");
    }
    // Never for Use the web stays Never, whatever the address.
    const balanced = contextFor(home, "balanced");
    const never = { ...balanced, hob: { ...balanced.hob, overrides: { "use-web": "deny" as const } } };
    expect((await decide(never, page("nas.home", ["192.168.1.20"]))).decision).toBe("deny");
  });

  // covers ADR 036 (Found URLs)
  it("[TC-PE-1267-19] asks once before a URL the hob wrote itself, under every preset and whatever was granted", async () => {
    const written = {
      _tag: "Web",
      host: "example.com",
      addresses: ["93.184.215.14"],
      page: { url: "https://example.com/?key=secret", found: false },
    } as const;
    for (const preset of ["careful", "balanced", "trusting"] as const) {
      const context = contextFor(home, preset);
      expect(await decide(context, written)).toMatchObject({
        decision: "ask",
        grantable: false,
        rules: [],
        reason: { code: "written-url" },
      });
      const granted = { ...context, grants: [grantOf({ _tag: "Host", host: "example.com" })] };
      expect((await decide(granted, written)).decision).toBe("ask");
      expect((await decide(granted, { ...written, page: { ...written.page, found: true } })).decision).toBe("allow");
    }
  });

  // covers ADR 036 (The read-the-web mark)
  it("[TC-PE-1268-01] asks, while the session has read the web, before each way data could leave, under every preset", async () => {
    const host = { _tag: "Web", host: "collector.example", addresses: [] } as const;
    const push = {
      _tag: "Push",
      remote: "origin",
      branch: "feature",
      force: false,
      toDefaultBranch: false,
      cwd: home.project,
    } as const;
    const write = { ...comment(home.project), sends: true } as const;
    const share = {
      _tag: "Memory",
      operation: "save-memory",
      scope: "the project github.com/acme/app",
      shared: true,
    } as const;
    for (const preset of ["careful", "balanced", "trusting"] as const) {
      const trusting = contextFor(home, preset);
      const marked = { ...trusting, readWeb: true };
      for (const request of [host, push, write, share] satisfies ReadonlyArray<PolicyRequest>) {
        const before = await decide(trusting, request);
        const after = await decide(marked, request);
        if (before.decision === "allow") {
          expect(after).toMatchObject({ decision: "ask", reason: { code: "read-the-web" } });
          expect(after.reason.message).toContain("read the web");
        } else expect(after.decision).toBe(before.decision);
        // The mark names the session, not the policy, so an approval binds to the same version.
        expect(after.policyVersion).toBe(before.policyVersion);
      }
      // A new host asks with Always for that host, and a saved Always for it still answers.
      expect(await decide(marked, host)).toMatchObject({
        grantable: true,
        rules: [{ _tag: "Host", host: "collector.example" }],
      });
      const hostGranted = { ...marked, grants: [grantOf({ _tag: "Host", host: "collector.example" })] };
      expect((await decide(hostGranted, host)).decision).toBe("allow");
      // A grant for a push or a Charm write says the place is fine, not what the hob sends there.
      const granted = {
        ...marked,
        grants: [
          grantOf({ _tag: "Push", cwd: home.project, remote: "origin", branch: "feature" }),
          grantOf({
            _tag: "CharmSite",
            charm: "github",
            operation: "github.comment",
            cwd: home.project,
            site: { repository: "otaviobarros/hobbots" },
          }),
        ],
      };
      expect(await decide(granted, push)).toMatchObject({
        decision: "ask",
        grantable: false,
        reason: { code: "read-the-web" },
      });
      expect(await decide(granted, write)).toMatchObject({
        decision: "ask",
        grantable: false,
        reason: { code: "read-the-web" },
      });
      // The model's own API stays open.
      expect((await decide(marked, { _tag: "Web", host: "api.anthropic.com", addresses: [] })).decision).toBe("allow");
    }
  });

  // covers ADR 036 (The read-the-web mark)
  it("[TC-PE-1268-02] leaves found pages, local work, own memory and Never as they were while the session has read the web", async () => {
    const balanced = contextFor(home, "balanced");
    const marked = { ...balanced, readWeb: true };
    const found = {
      _tag: "Web",
      host: "example.com",
      addresses: ["93.184.215.14"],
      page: { url: "https://example.com/a", found: true },
    } as const;
    const written = { ...found, page: { url: "https://example.com/?d=secret", found: false } } as const;
    for (const request of [
      found,
      files("read-files", home.project, "src/index.ts"),
      files("edit-files", home.project, "src/index.ts"),
      command("pnpm test", home.project),
      command("git commit -m wip", home.project, "local-git"),
      { _tag: "Memory", operation: "save-memory", scope: "your memory" },
      { _tag: "Memory", operation: "search-memory", scope: "your memory" },
      githubRead(home.project),
      // A Charm call the pipeline did not mark as a write is decided as it was.
      comment(home.project),
    ] satisfies ReadonlyArray<PolicyRequest>) {
      expect(await decide(marked, request)).toMatchObject({
        decision: (await decide(balanced, request)).decision,
        reason: { code: (await decide(balanced, request)).reason.code },
      });
    }
    expect((await decide(marked, written)).reason.code).toBe("written-url");
    // Never stays Never: the mark only adds asks.
    const never = {
      ...marked,
      hob: { ...marked.hob, overrides: { "use-web": "deny" as const, push: "deny" as const } },
    };
    expect((await decide(never, { _tag: "Web", host: "collector.example", addresses: [] })).decision).toBe("deny");
    expect(
      (await decide(never, { _tag: "Push", remote: "origin", branch: "feature", force: false, toDefaultBranch: false }))
        .decision,
    ).toBe("deny");
  });

  // covers PE-007
  it("leaves grants out of the policy version, and a This Task grant answers like any grant it is given", async () => {
    const careful = contextFor(home, "careful");
    const granted = await approveAlways(careful, command("pnpm test", home.project));
    expect((await decide(granted, command("pnpm test", home.project))).policyVersion).toBe(
      (await decide(careful, command("pnpm test", home.project))).policyVersion,
    );
    // Which grants apply to the Task a call is made in is the turn's to say; the engine matches the site.
    const task = {
      ...granted,
      grants: granted.grants.map((g) => new Grant({ ...g, lifetime: "task", taskId: TaskId.make("t1") })),
    };
    expect((await decide(task, command("pnpm test", home.project))).decision).toBe("allow");
    expect((await decide(task, command("pnpm test --watch", home.project))).decision).toBe("ask");
  });
});

describe("the GitHub Charm's writes", () => {
  const repository = "otaviobarros/hobbots";

  // covers PE-001, PE-003, PE-007
  it("[TC-PE-200] asks before opening a pull request or commenting, and a rule names only the repository and base", async () => {
    const balanced = contextFor(home, "balanced");
    const project = await fs.realpath(home.project);
    expect(await decide(balanced, pullRequest(home.project))).toMatchObject({
      decision: "ask",
      operation: "github.open-pull-request",
      targets: ["github.com/otaviobarros/hobbots into main"],
      onceOnly: false,
      grantable: true,
      rules: [
        {
          _tag: "CharmSite",
          charm: "github",
          operation: "github.open-pull-request",
          cwd: project,
          site: { repository, base: "main" },
        },
      ],
    });
    expect(await decide(balanced, comment(home.project))).toMatchObject({
      decision: "ask",
      operation: "github.comment",
      targets: ["github.com/otaviobarros/hobbots #324"],
      grantable: true,
      rules: [{ _tag: "CharmSite", charm: "github", operation: "github.comment", cwd: project, site: { repository } }],
    });
    expect((await decide(contextFor(home, "trusting"), pullRequest(home.project))).decision).toBe("allow");
    expect((await decide(contextFor(home, "trusting"), comment(home.project))).decision).toBe("allow");

    // A pull request rule is for its base branch; a comment rule is for every item of the repository.
    const opened = await approveAlways(balanced, pullRequest(home.project));
    expect(await decide(opened, pullRequest(home.project))).toMatchObject({
      decision: "allow",
      reason: { code: "grant" },
    });
    expect((await decide(opened, pullRequest(home.project, "release"))).decision).toBe("ask");
    const commented = await approveAlways(balanced, comment(home.project));
    expect((await decide(commented, comment(home.project, 7))).decision).toBe("allow");
    expect((await decide(commented, pullRequest(home.project))).decision).toBe("ask");
  });

  // covers PE-001, PE-004
  it("[TC-PE-201] refuses a GitHub write from outside the hob's folders, and under Never, whatever was granted", async () => {
    for (const request of [pullRequest(home.root), comment("relative/folder")]) {
      expect(await decide(contextFor(home, "trusting"), request)).toMatchObject({
        decision: "deny",
        operation: "outside-folders",
      });
    }
    const granted = await approveAlways(contextFor(home, "balanced"), comment(home.project));
    for (const answer of ["ask", "deny"] as const) {
      const narrowed = {
        ...granted,
        hob: {
          ownFolders: [],
          hiddenSharedFolders: [],
          overrides: {},
          charms: { overrides: { "github.comment": answer } },
        },
      };
      // The hob's own Ask or Never is never answered by a rule saved under the preset's Ask.
      expect(await decide(narrowed, comment(home.project))).toMatchObject({ decision: answer, grantable: false });
    }
  });
});

describe("a Charm request", () => {
  /** A second Charm, as an MCP server might declare one: a read with no site, and a once-only send. */
  const MAIL: ReadonlyArray<CharmOperation> = [
    {
      id: "mail.search",
      words: "searching mail",
      presets: { careful: "ask", balanced: "allow", trusting: "allow" },
      site: [],
      onceOnly: false,
      actsAsIdentity: false,
    },
    {
      id: "mail.send",
      words: "sending mail",
      presets: { careful: "ask", balanced: "ask", trusting: "allow" },
      site: ["to"],
      onceOnly: true,
      actsAsIdentity: true,
    },
    {
      id: "mail.label",
      words: "labelling mail",
      presets: { careful: "ask", balanced: "ask", trusting: "allow" },
      site: ["label"],
      onceOnly: false,
      actsAsIdentity: false,
    },
  ];
  const withMail = (preset: "careful" | "balanced" | "trusting", extra: Partial<PolicyContext> = {}) =>
    contextFor(home, preset, { charmOperations: [...GITHUB_OPERATIONS, ...MAIL], ...extra });
  const mail = (operation: CharmOperationId, site: Record<string, string> = {}, folder?: string): PolicyRequest => ({
    _tag: "Charm",
    charm: "mail",
    operation,
    site,
    ...(folder === undefined ? {} : { folder }),
  });

  // covers PE-001, PE-002
  it("[TC-PE-456] is decided on the answers its Charm declares, and refused when no Charm declares it", async () => {
    expect(await decide(withMail("careful"), mail("mail.search"))).toMatchObject({
      decision: "ask",
      operation: "mail.search",
      reason: { code: "preset", message: "The safety preset asks before searching mail." },
      enforcement: "enforced",
      targets: [],
    });
    expect((await decide(withMail("balanced"), mail("mail.search"))).decision).toBe("allow");
    expect((await decide(withMail("trusting"), mail("mail.label", { label: "done" }))).decision).toBe("allow");
    // Without its declaration, or claimed by another Charm, the operation stays closed.
    expect(await decide(contextFor(home, "trusting"), mail("mail.search"))).toMatchObject({
      decision: "deny",
      reason: { code: "undeclared-operation" },
    });
    expect(
      await decide(withMail("trusting"), { _tag: "Charm", charm: "github", operation: "mail.search", site: {} }),
    ).toMatchObject({ decision: "deny", reason: { code: "undeclared-operation" } });
  });

  // covers PE-004
  it("[TC-PE-457] is narrowed by the hob's override and by a restriction, and neither is answered by a grant", async () => {
    const overridden = withMail("trusting", {
      hob: { ownFolders: [], hiddenSharedFolders: [], overrides: {}, charms: { overrides: { "mail.label": "deny" } } },
    });
    expect(await decide(overridden, mail("mail.label", { label: "done" }))).toMatchObject({
      decision: "deny",
      reason: { code: "override" },
    });
    const restricted = withMail("trusting", { restrictions: [{ "mail.label": "ask" }] });
    expect(await decide(restricted, mail("mail.label", { label: "done" }))).toMatchObject({
      decision: "ask",
      reason: { code: "restriction" },
      grantable: false,
    });
    const granted = await approveAlways(withMail("balanced"), mail("mail.label", { label: "done" }));
    const both = { ...granted, restrictions: [{ "mail.label": "ask" as const }] };
    expect(await decide(both, mail("mail.label", { label: "done" }))).toMatchObject({
      decision: "ask",
      grantable: false,
    });
  });

  // covers PE-007
  it("[TC-PE-458] is answered by a CharmSite grant only when every declared site field and the folder match", async () => {
    const balanced = withMail("balanced");
    const asked = await decide(balanced, mail("mail.label", { label: "done", subject: "ignored" }));
    // The rule names only the declared site fields, never free text such as a subject.
    expect(asked).toMatchObject({
      decision: "ask",
      grantable: true,
      rules: [{ _tag: "CharmSite", charm: "mail", operation: "mail.label", site: { label: "done" } }],
    });
    expect(asked.rules[0]).not.toHaveProperty("cwd");
    const granted = await approveAlways(balanced, mail("mail.label", { label: "done" }));
    expect(await decide(granted, mail("mail.label", { label: "done", subject: "other" }))).toMatchObject({
      decision: "allow",
      reason: { code: "grant" },
    });
    expect((await decide(granted, mail("mail.label", { label: "later" }))).decision).toBe("ask");
    // A grant from a folder answers only calls from that folder.
    const fromFolder = await approveAlways(balanced, mail("mail.label", { label: "done" }, home.project));
    expect((await decide(fromFolder, mail("mail.label", { label: "done" }, home.project))).decision).toBe("allow");
    expect((await decide(fromFolder, mail("mail.label", { label: "done" }))).decision).toBe("ask");
    const both = { ...fromFolder, hob: { ...fromFolder.hob, ownFolders: [home.notes] } };
    expect((await decide(both, mail("mail.label", { label: "done" }, home.notes))).decision).toBe("ask");
    // A call missing a declared site field, or for an operation that declares none, is approved once only.
    expect(await decide(balanced, mail("mail.label"))).toMatchObject({ decision: "ask", grantable: false });
    expect(await decide(withMail("careful"), mail("mail.search"))).toMatchObject({
      decision: "ask",
      grantable: false,
      rules: [],
    });
  });

  // covers PE-007
  it("[TC-PE-459] asks before a once-only operation, once only, even where its preset allows it, and Never still wins", async () => {
    // Trusting allows sending mail, but a once-only operation is high risk and always waits for you (ADR 015).
    const asked = await decide(withMail("trusting"), mail("mail.send", { to: "ada@example.com" }));
    expect(asked).toMatchObject({
      decision: "ask",
      onceOnly: true,
      grantable: false,
      rules: [],
      reason: { code: "once-only-operation", message: "Sending mail always waits for you, once only." },
    });
    expect(await decide(withMail("balanced"), mail("mail.send", { to: "ada@example.com" }))).toMatchObject({
      decision: "ask",
      onceOnly: true,
      grantable: false,
    });
    const refused = withMail("trusting", {
      hob: { ownFolders: [], hiddenSharedFolders: [], overrides: {}, charms: { overrides: { "mail.send": "deny" } } },
    });
    expect(await decide(refused, mail("mail.send", { to: "ada@example.com" }))).toMatchObject({
      decision: "deny",
      reason: { code: "override" },
    });
    expect(
      await decide(withMail("trusting", { restrictions: [{ "mail.send": "deny" }] }), mail("mail.send", { to: "x" })),
    ).toMatchObject({ decision: "deny", reason: { code: "restriction" } });
    const saved = {
      ...withMail("trusting"),
      grants: [grantOf({ _tag: "CharmSite", charm: "mail", operation: "mail.send", site: { to: "ada@example.com" } })],
    };
    expect(await decide(saved, mail("mail.send", { to: "ada@example.com" }))).toMatchObject({
      decision: "ask",
      onceOnly: true,
    });
  });

  // covers PE-001
  it("[TC-PE-460] refuses a call found from a folder outside the hob's folders", async () => {
    for (const folder of [home.root, path.join(home.project, "private-link"), "relative/folder"]) {
      expect(await decide(withMail("trusting"), mail("mail.search", {}, folder))).toMatchObject({
        decision: "deny",
        operation: "outside-folders",
      });
    }
  });
});

describe("GitHub answers saved before the Charm operations", () => {
  // covers PE-007, DP-003
  it("[TC-PE-462] answer the same calls whether read in their old form or as 0071 rewrites them", async () => {
    const repository = "otaviobarros/hobbots";
    // The stored forms before and after 0071, as [TC-DP-285] writes and checks them.
    const stored = {
      before: {
        hob: { ownFolders: [], hiddenSharedFolders: [], overrides: { push: "ask", "read-github": "deny" } },
        rule: { _tag: "GitHubComment", cwd: home.project, repository },
        delegation: { "open-pull-request": "deny", "edit-files": "ask" },
      },
      after: {
        hob: { ownFolders: [], hiddenSharedFolders: [], overrides: { push: "ask", "github.read": "deny" } },
        rule: {
          _tag: "CharmSite",
          charm: "github",
          operation: "github.comment",
          cwd: home.project,
          site: { repository },
        },
        delegation: { "github.open-pull-request": "deny", "edit-files": "ask" },
      },
    };
    const contextOf = (form: (typeof stored)["before" | "after"]) =>
      contextFor(home, "balanced", {
        hob: Schema.decodeUnknownSync(HobPolicy)(form.hob),
        grants: [grantOf(Schema.decodeUnknownSync(GrantRule)(form.rule))],
        restrictions: [Schema.decodeUnknownSync(StoredPolicyLayer)(form.delegation)],
      });
    const calls = [githubRead(home.project), comment(home.project), pullRequest(home.project)];
    const answers = async (context: PolicyContext) =>
      Promise.all(
        calls.map(async (call) => {
          const { decision, operation, reason } = await decide(context, call);
          return { decision, operation, code: reason.code };
        }),
      );
    const before = await answers(contextOf(stored.before));
    expect(before).toEqual([
      { decision: "deny", operation: "github.read", code: "override" },
      { decision: "allow", operation: "github.comment", code: "grant" },
      { decision: "deny", operation: "github.open-pull-request", code: "restriction" },
    ]);
    expect(await answers(contextOf(stored.after))).toEqual(before);
  });
});
