import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type PolicyDecision, PolicyOperation, PRESET_DECISIONS, SafetyPreset } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { evaluate, type PolicyRequest, policyVersion, type ResolvedScope } from "../src/index.ts";
import {
  contextFor,
  decide,
  engineAhead,
  engineListingWith,
  engineWithLimit,
  files,
  type Home,
  lastingEngine,
  useHome,
} from "./fixture.ts";

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
  // 90 real path checks against the filesystem; on a busy two-core CI runner they take longer than the 5 s default.
  it("[TC-PE-002] refuses escapes through `..`, symlinks and the data folder under every preset", {
    timeout: 30_000,
  }, async () => {
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

  it("[#209] refuses a folder a command line moved to unknowably, and relative paths against it", async () => {
    const trusting = contextFor(home, "trusting");
    const command = await decide(trusting, { _tag: "Command", operation: "run-commands", cwd: 'cd "$DIR"' });
    expect(command).toMatchObject({ decision: "deny", reason: { code: "unresolvable-path" } });
    const relative = await decide(trusting, files("delete-files", 'cd "$DIR"', "src/index.ts"));
    expect(relative).toMatchObject({ decision: "deny", reason: { code: "unresolvable-path" } });
    // An absolute path does not depend on the folder, so it is decided as usual.
    const absolute = await decide(
      trusting,
      files("delete-files", 'cd "$DIR"', path.join(home.project, "src/index.ts")),
    );
    expect(absolute.decision).toBe("allow");
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
    expect((await decide(off, requests(home).push)).enforcement).toBe("checked");

    const on = contextFor(home, "trusting");
    expect((await decide(on, requests(home)["delete-files"])).enforcement).toBe("checked");
    expect((await decide(on, requests(home)["edit-files"])).enforcement).toBe("enforced");
  });

  it("marks Push checked where a command could push to a remote that needs no credentials", async () => {
    expect((await decide(contextFor(home, "careful"), requests(home).push)).enforcement).toBe("enforced");
    expect((await decide(contextFor(home, "balanced"), requests(home).push)).enforcement).toBe("checked");
    expect((await decide(contextFor(home, "trusting"), requests(home).push)).enforcement).toBe("checked");
    const noWeb = contextFor(home, "trusting", { restrictions: [{ "use-web": "ask" }] });
    expect((await decide(noWeb, requests(home).push)).enforcement).toBe("enforced");
    const noSandbox = contextFor(home, "trusting", { sandbox: "unavailable" });
    expect((await decide(noSandbox, requests(home).push)).enforcement).toBe("enforced");
  });

  // covers PE-002
  it("[TC-PE-004] keeps Git hooks and config read-only wherever the folder starts and wherever hooks link", async () => {
    const context = contextFor(home, "trusting", { sharedFolders: [home.repo, path.join(home.repo, ".git")] });
    const insideGit = contextFor(home, "balanced", {
      sharedFolders: [path.join(home.repo, ".git"), path.join(home.repo, "custom-hooks")],
    });
    for (const [ctx, cwd, target] of [
      [insideGit, path.join(home.repo, ".git"), "config"],
      [insideGit, path.join(home.repo, ".git"), "hooks/pre-commit"],
      [context, home.repo, ".git/hooks/pre-commit"],
      [context, home.repo, "custom-hooks/pre-commit"],
      [context, home.repo, "custom-hooks"],
    ] as const) {
      for (const operation of ["edit-files", "delete-files"] as const) {
        const verdict = await decide(ctx, files(operation, cwd, target));
        expect({ target, operation, decision: verdict.decision, code: verdict.reason.code }).toEqual({
          target,
          operation,
          decision: "deny",
          code: "protected-path",
        });
      }
    }
    expect((await decide(context, files("read-files", home.repo, "custom-hooks/pre-commit"))).decision).toBe("allow");
    expect((await decide(context, files("edit-files", home.repo, "docs/readme.md"))).decision).toBe("allow");
  });

  // covers PE-002
  it("[TC-PE-007] keeps Git hooks read-only when they link into another approved folder", async () => {
    const outer = path.join(home.root, "linked-repo");
    const nested = path.join(outer, "packages", "nested");
    const other = path.join(home.root, "other");
    await fs.mkdir(path.join(outer, ".git"), { recursive: true });
    await fs.mkdir(path.join(other, "hooks"), { recursive: true });
    await fs.mkdir(path.join(other, "nested-hooks"));
    await fs.mkdir(path.join(other, "docs"));
    await fs.writeFile(path.join(outer, ".git", "config"), "");
    await fs.symlink(path.join(other, "hooks"), path.join(outer, ".git", "hooks"));
    const engine = lastingEngine();
    try {
      const decideBoth = async (preset: SafetyPreset, cwd: string, target: string) => {
        const context = contextFor(home, preset, { sharedFolders: [outer, other] });
        return Promise.all(
          (["edit-files", "delete-files"] as const).map((operation) =>
            engine.decide(context, files(operation, cwd, target)).then((verdict) => ({
              preset,
              target,
              operation,
              decision: verdict.decision,
              code: verdict.reason.code,
            })),
          ),
        );
      };
      const denied = (preset: SafetyPreset, target: string) =>
        (["edit-files", "delete-files"] as const).map((operation) => ({
          preset,
          target,
          operation,
          decision: "deny",
          code: "protected-path",
        }));
      for (const preset of ["balanced", "trusting"] as const) {
        expect((await decideBoth(preset, other, "nested-hooks/pre-commit")).map((v) => v.decision)).not.toContain(
          "deny",
        );
        // A repository nested in another's working tree, created after the engine last looked.
        await fs.mkdir(path.join(nested, ".git"), { recursive: true });
        await fs.rm(path.join(nested, ".git", "hooks"), { force: true });
        await fs.symlink(path.join(other, "nested-hooks"), path.join(nested, ".git", "hooks"));
        for (const [cwd, target] of [
          [outer, ".git/hooks/pre-commit"],
          [other, "hooks/pre-commit"],
          [other, "hooks"],
          [other, "."],
          [nested, ".git/hooks/pre-commit"],
          [other, "nested-hooks/pre-commit"],
          [other, "nested-hooks"],
        ] as const) {
          expect(await decideBoth(preset, cwd, target)).toEqual(denied(preset, target));
        }
        const context = contextFor(home, preset, { sharedFolders: [outer, other] });
        expect((await engine.decide(context, files("edit-files", other, "docs/readme.md"))).decision).not.toBe("deny");
        expect((await engine.decide(context, files("read-files", other, "hooks/pre-commit"))).decision).toBe("allow");
        // Once the nested repository is gone its former hooks folder is ordinary again.
        await fs.rm(nested, { recursive: true });
        expect((await decideBoth(preset, other, "nested-hooks/pre-commit")).map((v) => v.decision)).not.toContain(
          "deny",
        );
      }
    } finally {
      await engine.dispose();
    }
  });

  // covers PE-002
  it("[TC-PE-010] notices a nested repository even when its folder's modification time is set back", async () => {
    const outer = path.join(home.root, "restored-repo");
    const nested = path.join(outer, "vendor", "lib");
    const other = path.join(home.root, "restored-other");
    await fs.mkdir(path.join(outer, ".git"), { recursive: true });
    await fs.mkdir(nested, { recursive: true });
    await fs.mkdir(path.join(other, "hooks"), { recursive: true });
    const old = new Date(Math.floor(Date.now() / 1000) * 1000 - 24 * 60 * 60 * 1000);
    await fs.utimes(nested, old, old);
    // The engine's clock runs an hour fast, so every listing counts as settled and only metadata tells.
    const engine = lastingEngine(engineAhead(60 * 60 * 1000));
    try {
      const context = contextFor(home, "trusting", { sharedFolders: [outer, other] });
      const edit = () => engine.decide(context, files("edit-files", other, "hooks/pre-commit"));
      expect((await edit()).decision).toBe("allow");
      await fs.mkdir(path.join(nested, ".git"));
      await fs.symlink(path.join(other, "hooks"), path.join(nested, ".git", "hooks"));
      await fs.utimes(nested, old, old);
      expect(Math.round((await fs.stat(nested)).mtimeMs)).toBe(old.getTime());
      expect(await edit()).toMatchObject({ decision: "deny", reason: { code: "protected-path" } });
    } finally {
      await engine.dispose();
    }
  });

  // covers PE-002
  it("[TC-PE-011] never answers from a repository index another decision is still refreshing", async () => {
    const outer = path.join(home.root, "racing-repo");
    const other = path.join(home.root, "racing-other");
    await fs.mkdir(path.join(outer, ".git"), { recursive: true });
    await fs.mkdir(path.join(other, "hooks"), { recursive: true });
    let hold: { readonly dir: string; readonly reached: () => void; readonly released: Promise<void> } | null = null;
    const engine = lastingEngine(
      engineListingWith(
        async (dir) => {
          if (hold !== null && dir === hold.dir) {
            hold.reached();
            await hold.released;
          }
        },
        60 * 60 * 1000,
      ),
    );
    try {
      const context = contextFor(home, "trusting", { sharedFolders: [outer, other] });
      const edit = () => engine.decide(context, files("edit-files", other, "hooks/pre-commit"));
      expect((await edit()).decision).toBe("allow");
      // A new subtree holding a repository whose hooks link into the other folder.
      const nested = path.join(outer, "new", "lib");
      await fs.mkdir(path.join(nested, ".git"), { recursive: true });
      await fs.symlink(path.join(other, "hooks"), path.join(nested, ".git", "hooks"));
      const canonicalNested = await fs.realpath(nested);
      let release = () => {};
      const reached = new Promise<void>((resolve) => {
        hold = {
          dir: canonicalNested,
          reached: resolve,
          released: new Promise<void>((done) => {
            release = done;
          }),
        };
      });
      // The first refresh has indexed `new` and is paused before listing `new/lib`. The clock runs an
      // hour fast, so the second cannot tell `new` was listed just now and re-list it.
      const first = edit();
      await reached;
      hold = null;
      const second = edit();
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      for (const verdict of await Promise.all([first, second])) {
        expect(verdict).toMatchObject({ decision: "deny", reason: { code: "protected-path" } });
      }
    } finally {
      await engine.dispose();
    }
  });

  // covers PE-002
  it("[TC-PE-008] keeps single-file changes open in folders too large to search, and asks instead of guessing", async () => {
    const big = path.join(home.root, "big");
    const bigRepo = path.join(home.root, "big-repo");
    await fs.mkdir(path.join(big, "docs"), { recursive: true });
    await fs.mkdir(path.join(bigRepo, ".git", "hooks"), { recursive: true });
    for (let i = 0; i < 10; i++) {
      await fs.writeFile(path.join(big, `file-${i}.txt`), "");
      await fs.writeFile(path.join(bigRepo, `file-${i}.txt`), "");
    }
    const limited = engineWithLimit(15);
    const context = (preset: SafetyPreset) => contextFor(home, preset, { sharedFolders: [big] });
    const small = contextFor(home, "trusting", { sharedFolders: [bigRepo, path.join(home.project, "src")] });
    expect((await decide(small, files("edit-files", bigRepo, "file-1.txt"), limited)).decision).toBe("allow");
    expect((await decide(small, files("edit-files", bigRepo, ".git/hooks/pre-commit"), limited)).reason.code).toBe(
      "protected-path",
    );
    for (let i = 10; i < 20; i++) await fs.writeFile(path.join(big, `file-${i}.txt`), "");
    // Past the limit a change asks rather than locking the folder; a folder too large to search is refused.
    for (const preset of ["balanced", "trusting"] as const) {
      expect(await decide(context(preset), files("edit-files", big, "file-1.txt"), limited)).toMatchObject({
        decision: "ask",
        reason: { code: "unsearched-folder" },
      });
      expect((await decide(context(preset), files("delete-files", big, "docs"), limited)).decision).toBe("ask");
      expect(await decide(context(preset), files("delete-files", big, "."), limited)).toMatchObject({
        decision: "deny",
        reason: { code: "protected-path" },
      });
    }
    expect((await decide(context("careful"), files("edit-files", big, "file-1.txt"), limited)).reason.code).toBe(
      "preset",
    );
    expect((await decide(context("trusting"), files("read-files", big, "file-1.txt"), limited)).decision).toBe("allow");
    expect((await decide(context("trusting"), files("edit-files", big, "file-1.txt"))).decision).toBe("allow");
  });

  // covers PE-002
  it("[TC-PE-009] keeps the files a hook links to read-only", async () => {
    const repo = path.join(home.root, "hooked-repo");
    await fs.mkdir(path.join(repo, ".git", "hooks"), { recursive: true });
    await fs.mkdir(path.join(repo, "scripts"));
    await fs.writeFile(path.join(repo, "scripts", "pre-push.sh"), "");
    await fs.writeFile(path.join(repo, "scripts", "build.sh"), "");
    await fs.symlink(path.join(repo, "scripts", "pre-push.sh"), path.join(repo, ".git", "hooks", "pre-push"));
    const context = contextFor(home, "trusting", { sharedFolders: [repo] });
    for (const operation of ["edit-files", "delete-files"] as const) {
      expect((await decide(context, files(operation, repo, "scripts/pre-push.sh"))).reason.code).toBe("protected-path");
      expect((await decide(context, files(operation, repo, "scripts"))).reason.code).toBe("protected-path");
    }
    expect((await decide(context, files("edit-files", repo, "scripts/build.sh"))).decision).toBe("allow");
  });

  // covers PE-002
  it("[TC-PE-005] refuses changing a folder that holds the data folder or a repository's hooks and config", async () => {
    const context = contextFor(home, "trusting", { sharedFolders: [home.project, home.repo] });
    for (const [cwd, target, code] of [
      [home.project, ".", "data-folder"],
      [home.project, ".git", "protected-path"],
      [home.repo, ".", "protected-path"],
      [home.repo, ".git", "protected-path"],
    ] as const) {
      for (const operation of ["edit-files", "delete-files"] as const) {
        const verdict = await decide(context, files(operation, cwd, target));
        expect({ cwd, target, operation, decision: verdict.decision, code: verdict.reason.code }).toEqual({
          cwd,
          target,
          operation,
          decision: "deny",
          code,
        });
      }
    }
    expect((await decide(context, files("delete-files", home.project, "src"))).decision).toBe("allow");
    expect((await decide(context, files("delete-files", home.repo, "docs"))).decision).toBe("allow");
    expect((await decide(context, files("read-files", home.project, "."))).decision).toBe("allow");
  });
});

describe("policy version", () => {
  it("changes with any policy input and not with key order", () => {
    const base = contextFor(home, "balanced");
    expect(policyVersion(base)).toMatch(/^r2-[0-9a-f]{16}$/);
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
