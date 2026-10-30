import * as path from "node:path";
import { type PolicyDecision, PolicyOperation, PRESET_DECISIONS, SafetyPreset } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { evaluate, type PolicyRequest, policyVersion, type ResolvedScope } from "../src/index.ts";
import { contextFor, decide, files, type Home, useHome } from "./fixture.ts";

const home: Home = useHome();

/** One request per operation, all inside the shared folder except the last. */
const requests = (h: Home): Record<PolicyOperation, PolicyRequest> => ({
  "read-files": files("read-files", h.project, "src/index.ts"),
  "edit-files": files("edit-files", h.project, "src/new-file.ts"),
  "delete-files": files("delete-files", h.project, "src/index.ts"),
  "run-commands": { _tag: "Command", operation: "run-commands", cwd: h.project },
  "local-git": { _tag: "Command", operation: "local-git", cwd: path.join(h.project, "src") },
  push: { _tag: "Push", remote: "origin", branch: "feature", force: false, toDefaultBranch: false },
  "use-web": { _tag: "Web", host: "registry.npmjs.org", addresses: [] },
  "outside-folders": files("read-files", h.project, "../secret.txt"),
});

/** ADR 014's preset table, written out again so the engine is checked against the decision, not itself. */
const ADR_014: Record<PolicyOperation, readonly [PolicyDecision, PolicyDecision, PolicyDecision]> = {
  "read-files": ["allow", "allow", "allow"],
  "edit-files": ["ask", "allow", "allow"],
  "delete-files": ["ask", "ask", "allow"],
  "run-commands": ["ask", "allow", "allow"],
  "local-git": ["ask", "allow", "allow"],
  push: ["ask", "ask", "allow"],
  "use-web": ["ask", "allow", "allow"],
  "outside-folders": ["deny", "deny", "deny"],
};

/** Ways a path can name something outside the hob's folders. */
const escapes = (h: Home): ReadonlyArray<readonly [string, PolicyRequest]> => [
  ["an absolute path", files("read-files", h.project, h.secret)],
  ["a `..` path", files("read-files", h.project, "src/../../secret.txt")],
  ["a `..` from a folder that does not exist", files("read-files", h.project, "nowhere/../../secret.txt")],
  ["a symlink to a file outside", files("read-files", h.project, "secret-link")],
  ["a path through a symlinked folder outside", files("read-files", h.project, "private-link/diary.txt")],
  [
    "a `..` after a symlink, which climbs from the link's target",
    files("read-files", h.project, "private-link/../secret.txt"),
  ],
  ["a dangling symlink whose target is outside", files("read-files", h.project, "dangling")],
  ["a relative path from a working folder outside", files("read-files", h.root, "secret.txt")],
  [
    "a working folder that leaves through a symlink and `..`",
    files("read-files", `${h.project}/private-link/..`, "secret.txt"),
  ],
  ["Hobbots' data folder inside a shared folder", files("read-files", h.project, ".hobbots-data/hobbots.db")],
  ["a symlink loop", files("read-files", h.project, "loop-a")],
];

describe("policy engine", () => {
  // covers PE-001, PE-002, AG-004
  it("[TC-PE-001] answers each operation as ADR 014's table does, for every preset", async () => {
    for (const [i, preset] of SafetyPreset.literals.entries()) {
      expect(PRESET_DECISIONS[preset]).toEqual(
        Object.fromEntries(PolicyOperation.literals.map((op) => [op, ADR_014[op][i]])),
      );
      for (const [operation, request] of Object.entries(requests(home))) {
        const verdict = await decide(contextFor(home, preset), request);
        expect({ preset, operation, decision: verdict.decision }).toEqual({
          preset,
          operation,
          decision: ADR_014[operation as PolicyOperation][i],
        });
        expect(verdict.operation).toBe(operation);
        expect(verdict.policyVersion).toBe(policyVersion(contextFor(home, preset)));
        expect(verdict.reason.message).not.toBe("");
      }
    }
  });

  // covers PE-002, AG-004
  it("[TC-PE-002] refuses escapes through `..`, symlinks and the data folder under every preset", async () => {
    for (const preset of SafetyPreset.literals) {
      for (const [how, request] of escapes(home)) {
        for (const operation of ["read-files", "edit-files", "delete-files"] as const) {
          const verdict = await decide(contextFor(home, preset), { ...request, operation } as PolicyRequest);
          expect({ preset, how, operation, decision: verdict.decision }).toEqual({
            preset,
            how,
            operation,
            decision: "deny",
          });
          expect(verdict.operation).toBe("outside-folders");
        }
      }
    }
  });

  // covers PE-002
  it("[TC-PE-003] never reads a file outside the hob's folders, whatever widening is attempted", async () => {
    const widening = { "outside-folders": "allow", "read-files": "allow" } as const;
    for (const preset of SafetyPreset.literals) {
      const context = contextFor(home, preset, {
        hob: { ownFolders: [], hiddenSharedFolders: [], overrides: widening },
        restrictions: [widening],
      });
      const verdict = await decide(context, files("read-files", home.project, home.secret));
      expect(verdict).toMatchObject({ decision: "deny", operation: "outside-folders" });
      expect(verdict.reason.code).toBe("outside-folders");
      expect(verdict.targets[0]?.endsWith(`${path.sep}secret.txt`)).toBe(true);
    }
  });

  it("names the canonical target and the reason", async () => {
    const verdict = await decide(contextFor(home, "balanced"), files("read-files", home.project, "secret-link"));
    expect(verdict.targets).toHaveLength(1);
    expect(verdict.targets[0]).not.toContain("secret-link");
    expect(verdict.reason.message).toContain("outside this hob's folders");
  });

  it("decides several paths by the narrowest of them", async () => {
    const verdict = await decide(
      contextFor(home, "trusting"),
      files("edit-files", home.project, "src/index.ts", "../secret.txt"),
    );
    expect(verdict.decision).toBe("deny");
    expect(verdict.targets).toHaveLength(2);
    const none = await decide(contextFor(home, "trusting"), files("read-files", home.project));
    expect(none).toMatchObject({ decision: "deny", reason: { code: "no-target" } });
  });

  it("lets overrides and restrictions only narrow, and says which one decided", async () => {
    const narrowed = await decide(
      contextFor(home, "trusting", {
        hob: { ownFolders: [], hiddenSharedFolders: [], overrides: { "edit-files": "ask" } },
      }),
      requests(home)["edit-files"],
    );
    expect(narrowed).toMatchObject({ decision: "ask", reason: { code: "override" } });

    const widened = await decide(
      contextFor(home, "careful", {
        hob: { ownFolders: [], hiddenSharedFolders: [], overrides: { "edit-files": "allow" } },
      }),
      requests(home)["edit-files"],
    );
    expect(widened).toMatchObject({ decision: "ask", reason: { code: "preset" } });

    const restricted = await decide(
      contextFor(home, "balanced", { restrictions: [{}, { "run-commands": "deny" }] }),
      requests(home)["run-commands"],
    );
    expect(restricted).toMatchObject({ decision: "deny", reason: { code: "restriction" } });
  });

  it("works in the hob's own folders and not in a shared folder it hides", async () => {
    const own = contextFor(home, "balanced", {
      hob: { ownFolders: [home.notes], hiddenSharedFolders: [], overrides: {} },
    });
    expect((await decide(own, files("edit-files", home.notes, "todo.md"))).decision).toBe("allow");
    expect((await decide(contextFor(home, "balanced"), files("edit-files", home.notes, "todo.md"))).decision).toBe(
      "deny",
    );

    const hidden = contextFor(home, "trusting", {
      hob: { ownFolders: [home.notes], hiddenSharedFolders: [`${home.project}/`], overrides: {} },
    });
    expect(await decide(hidden, files("read-files", home.project, "src/index.ts"))).toMatchObject({
      decision: "deny",
      reason: { code: "outside-folders" },
    });
    expect((await decide(hidden, { _tag: "Command", operation: "run-commands", cwd: home.project })).decision).toBe(
      "deny",
    );
  });

  it("keeps .git/hooks and .git/config read-only, while the rest of .git stays writable", async () => {
    const context = contextFor(home, "trusting");
    for (const target of [".git/hooks/pre-commit", ".git/config", "src/../.git/hooks", "vendor/lib/.git/config"]) {
      expect(await decide(context, files("edit-files", home.project, target))).toMatchObject({
        decision: "deny",
        reason: { code: "protected-path" },
      });
      expect((await decide(context, files("delete-files", home.project, target))).decision).toBe("deny");
    }
    expect((await decide(context, files("read-files", home.project, ".git/config"))).decision).toBe("allow");
    expect((await decide(context, files("edit-files", home.project, ".git/index"))).decision).toBe("allow");
  });

  it("always asks once only before a force push or a push to the default branch", async () => {
    for (const preset of SafetyPreset.literals) {
      for (const push of [
        { force: true, toDefaultBranch: false },
        { force: false, toDefaultBranch: true },
      ]) {
        const verdict = await decide(contextFor(home, preset), {
          _tag: "Push",
          remote: "origin",
          branch: "main",
          ...push,
        });
        expect(verdict).toMatchObject({ decision: "ask", onceOnly: true, reason: { code: "protected-push" } });
        expect(verdict.targets).toEqual(["origin main"]);
      }
    }
    const never = contextFor(home, "trusting", {
      hob: { ownFolders: [], hiddenSharedFolders: [], overrides: { push: "deny" } },
    });
    expect(
      await decide(never, { _tag: "Push", remote: "origin", branch: "main", force: true, toDefaultBranch: true }),
    ).toMatchObject({
      decision: "deny",
      onceOnly: false,
    });
  });

  it("decides each host, never reaching loopback, link-local or metadata addresses", async () => {
    const web = (host: string, addresses: ReadonlyArray<string> = []): PolicyRequest => ({
      _tag: "Web",
      host,
      addresses,
    });
    for (const preset of SafetyPreset.literals) {
      for (const host of [
        "localhost",
        "hub.localhost",
        "LOCALHOST.",
        "127.0.0.1:4100",
        "127.1",
        "2130706433",
        "0x7f000001",
        "0.0.0.0",
        "::1",
        "[::ffff:127.0.0.1]",
        "169.254.169.254",
        "fe80::1",
        "fd00:ec2::254",
        "metadata.google.internal",
        "100.100.100.200",
      ]) {
        expect(await decide(contextFor(home, preset), web(host))).toMatchObject({
          decision: "deny",
          reason: { code: "blocked-host" },
        });
      }
      // A public name that resolves to a blocked address, as in DNS rebinding.
      expect((await decide(contextFor(home, preset), web("rebind.example", ["127.0.0.1"]))).decision).toBe("deny");
      expect(await decide(contextFor(home, preset), web("API.Anthropic.com:443"))).toMatchObject({
        decision: "allow",
        reason: { code: "model-host" },
      });
    }
    expect(await decide(contextFor(home, "careful"), web("example.com"))).toMatchObject({
      decision: "ask",
      targets: ["example.com"],
    });
    expect((await decide(contextFor(home, "balanced"), web("example.com", ["93.184.215.14"]))).decision).toBe("allow");
    expect((await decide(contextFor(home, "balanced"), web("not a host"))).reason.code).toBe("invalid-host");
  });

  it("blocks commands and the web without the sandbox, and marks rules checked when it is off", async () => {
    const unavailable = contextFor(home, "trusting", { sandbox: "unavailable" });
    for (const op of ["run-commands", "local-git", "use-web"] as const) {
      expect(await decide(unavailable, requests(home)[op])).toMatchObject({
        decision: "deny",
        reason: { code: "needs-sandbox" },
      });
    }
    expect(await decide(unavailable, requests(home)["edit-files"])).toMatchObject({
      decision: "allow",
      enforcement: "enforced",
    });
    expect((await decide(unavailable, requests(home).push)).decision).toBe("allow");

    const off = contextFor(home, "trusting", { sandbox: "off" });
    expect(await decide(off, requests(home)["run-commands"])).toMatchObject({
      decision: "allow",
      enforcement: "checked",
    });
    expect(await decide(off, requests(home)["outside-folders"])).toMatchObject({
      decision: "deny",
      enforcement: "checked",
    });
    expect((await decide(off, requests(home).push)).enforcement).toBe("enforced");

    const on = contextFor(home, "trusting");
    expect((await decide(on, requests(home)["delete-files"])).enforcement).toBe("checked");
    expect((await decide(on, requests(home)["edit-files"])).enforcement).toBe("enforced");
  });
});

describe("policy version", () => {
  it("changes with any policy input and not with key order", () => {
    const base = contextFor(home, "balanced");
    expect(policyVersion(base)).toMatch(/^r1-[0-9a-f]{16}$/);
    expect(policyVersion({ ...base })).toBe(policyVersion(base));
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as unknown as typeof base;
    expect(policyVersion(reordered)).toBe(policyVersion(base));
    expect(policyVersion({ ...base, preset: "careful" })).not.toBe(policyVersion(base));
    expect(policyVersion({ ...base, hob: { ...base.hob, overrides: { push: "deny" } } })).not.toBe(policyVersion(base));
  });

  it("is pure: the same resolved inputs give the same verdict", () => {
    const scope: ResolvedScope = { folders: ["/work"], dataFolder: "/data" };
    const request = {
      _tag: "Files",
      operation: "edit-files",
      targets: [{ input: "a", canonical: { path: "/WORK/a", caseSensitive: false } }],
    } as const;
    const context = contextFor(home, "balanced");
    expect(evaluate(context, scope, request)).toEqual(evaluate(context, scope, request));
    expect(evaluate(context, scope, request).decision).toBe("allow");
    const sensitive = { ...request, targets: [{ input: "a", canonical: { path: "/WORK/a", caseSensitive: true } }] };
    expect(evaluate(context, scope, sensitive).decision).toBe("deny");
  });
});
