import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Redacted, type Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitPush, GitPushLive, type PushTarget, pushResult } from "../src/index.ts";
import { type FakeGitHubGit, startFakeGitHubGit } from "./fake-github-git.ts";
import { directSandbox } from "./support.ts";

const TOKEN = "ghu_faketoken0123456789abcdefghijklmnopqrstuv";
const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

let root = "";
let github: FakeGitHubGit;

const sh = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Hob",
      GIT_AUTHOR_EMAIL: "hob@example.com",
      GIT_COMMITTER_NAME: "Hob",
      GIT_COMMITTER_EMAIL: "hob@example.com",
    },
  }).trim();

/** A hob's folder: a repository on `main` with one commit, and `feat/x` one commit ahead. */
const makeFolder = async (name: string) => {
  const folder = path.join(root, name);
  await fs.mkdir(folder);
  sh(folder, "init", "--quiet", "--initial-branch=main");
  await fs.writeFile(path.join(folder, "a.txt"), "a\n");
  sh(folder, "add", "a.txt");
  sh(folder, "commit", "--quiet", "--no-gpg-sign", "-m", "First");
  sh(folder, "checkout", "--quiet", "-b", "feat/x");
  await fs.writeFile(path.join(folder, "b.txt"), "b\n");
  sh(folder, "add", "b.txt");
  sh(folder, "commit", "--quiet", "--no-gpg-sign", "-m", "Add b");
  return folder;
};

/** A repository on the fake GitHub, which takes pushes. */
const makeRemote = async (slug: string) => {
  const remote = path.join(root, "github", `${slug}.git`);
  await fs.mkdir(path.dirname(remote), { recursive: true });
  sh(root, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  sh(remote, "config", "http.receivepack", "true");
  return remote;
};

const layer = () =>
  GitPushLive({ folder: path.join(root, "data", "charms", "github"), httpsBase: github.base }).pipe(
    Layer.provide(Layer.mergeAll(directSandbox, NodeServices.layer)),
  );

const run = <A, E>(effect: Effect.Effect<A, E, GitPush | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(layer()), Effect.runPromise);

const target = (commit: string, overrides: Partial<PushTarget> = {}): PushTarget => ({
  repository: { owner: "octo", name: "app" },
  commit,
  remoteBranch: "feat/x",
  force: false,
  replaces: null,
  ...overrides,
});

const https = { _tag: "Https", token: Redacted.make(TOKEN) } as const;

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hobbots-push-")));
  github = await startFakeGitHubGit(path.join(root, "github"), TOKEN);
});
afterAll(async () => {
  await github.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("pushing from the hub's staging repository", () => {
  // covers PE-005, PE-008
  it("[TC-PE-150] pushes the commit fixed when deciding, even after the hob commits again", async () => {
    const folder = await makeFolder("fixed");
    const remote = await makeRemote("octo/app");
    const expected = sh(folder, "rev-parse", "feat/x");
    const result = await run(
      Effect.gen(function* () {
        const git = yield* GitPush;
        const staged = yield* git.stage([folder], folder, "feat/x");
        // The hob commits again after the decision: that commit is not pushed.
        yield* Effect.promise(() => fs.writeFile(path.join(folder, "c.txt"), "c\n"));
        sh(folder, "add", "c.txt");
        sh(folder, "commit", "--quiet", "--no-gpg-sign", "-m", "Later");
        const summary = yield* git.commits(staged, [null]);
        return { staged, summary, pushed: yield* git.push(staged, target(staged.commit), https) };
      }),
    );
    expect(result.staged.commit).toBe(expected);
    expect(result.summary).toEqual({ count: 2, subjects: ["Add b", "First"] });
    expect(result.pushed).toEqual({ _tag: "Pushed", created: true, forced: false });
    expect(sh(remote, "rev-parse", "refs/heads/feat/x")).toBe(expected);
    // The token reached GitHub as Git's credential, through the hub's helper.
    expect(github.authorizations).toContain(`Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`);
  });

  // covers PE-005, PE-006
  it("[TC-PE-151] runs no hook or configured program from a hostile repository, and sends the token nowhere else", async () => {
    const folder = await makeFolder("hostile");
    const remote = await makeRemote("octo/hostile");
    // A replace ref would make Git read another commit for the branch's.
    const real = sh(folder, "rev-parse", "feat/x");
    const decoy = sh(folder, "commit-tree", "-m", "Decoy", `${real}^{tree}`);
    sh(folder, "replace", real, decoy);
    const marker = (name: string) => path.join(root, `ran-${name}`);
    const touch = (name: string) => `touch ${quote(marker(name))}`;
    const evilHooks = path.join(root, "evil-hooks");
    await fs.mkdir(evilHooks, { recursive: true });
    for (const hook of ["pre-push", "post-update", "reference-transaction", "pre-receive", "update", "post-checkout"]) {
      for (const dir of [path.join(folder, ".git", "hooks"), evilHooks]) {
        await fs.writeFile(path.join(dir, hook), `#!/bin/sh\n${touch(`hook-${hook}`)}\n`, { mode: 0o755 });
      }
    }
    const included = path.join(root, "evil.gitconfig");
    await fs.writeFile(included, `[core]\n\tfsmonitor = ${touch("included")}\n`);
    const settings: Array<[string, string]> = [
      ["core.hooksPath", evilHooks],
      ["core.fsmonitor", touch("fsmonitor")],
      ["core.sshCommand", touch("ssh-command")],
      [`url.http://127.0.0.1:9/.insteadOf`, github.base],
      ["include.path", included],
      ["uploadpack.packObjectsHook", `${touch("pack-objects-hook")}; exec`],
      ["core.alternateRefsCommand", touch("alternate-refs")],
      ["credential.helper", `!${touch("credential-helper")}; echo password=stolen`],
      ["http.proxy", "http://127.0.0.1:9"],
      ["remote.origin.url", "http://127.0.0.1:9/evil.git"],
      ["remote.origin.pushurl", "http://127.0.0.1:9/evil.git"],
    ];
    for (const [key, value] of settings) sh(folder, "config", key, value);
    const pushed = await run(
      Effect.gen(function* () {
        const git = yield* GitPush;
        const staged = yield* git.stage([folder], folder, "feat/x");
        return yield* git.push(
          staged,
          target(staged.commit, { repository: { owner: "octo", name: "hostile" } }),
          https,
        );
      }),
    );
    expect(pushed._tag).toBe("Pushed");
    expect(sh(remote, "rev-parse", "refs/heads/feat/x")).toBe(real);
    const ran = (await fs.readdir(root)).filter((name) => name.startsWith("ran-"));
    expect(ran).toEqual([]);
  });

  // covers PE-005
  it("[TC-PE-152] refuses a repository whose files point at another one", async () => {
    const cases: Array<[string, (gitDir: string) => Promise<void>]> = [
      ["commondir", (gitDir) => fs.writeFile(path.join(gitDir, "commondir"), "../../other/.git\n")],
      ["alternates", (gitDir) => fs.writeFile(path.join(gitDir, "objects", "info", "alternates"), "/elsewhere\n")],
      [
        "grafts",
        async (gitDir) => {
          await fs.mkdir(path.join(gitDir, "info"), { recursive: true });
          await fs.writeFile(path.join(gitDir, "info", "grafts"), "\n");
        },
      ],
      ["shallow", (gitDir) => fs.writeFile(path.join(gitDir, "shallow"), "\n")],
    ];
    const refused: Array<string> = [];
    for (const [name, lay] of cases) {
      const folder = await makeFolder(`layout-${name}`);
      await lay(path.join(folder, ".git"));
      const result = await run(
        Effect.gen(function* () {
          const git = yield* GitPush;
          return yield* git.stage([folder], folder, "feat/x");
        }).pipe(Effect.flip),
      );
      refused.push(result.message);
    }
    expect(refused).toEqual([
      expect.stringContaining("points its repository at another one"),
      expect.stringContaining("borrows objects from another repository"),
      expect.stringContaining("rewrites its history with grafts"),
      expect.stringContaining("is a shallow clone"),
    ]);
  });

  // covers PE-003, EX-004
  it("[TC-PE-153] never forces without force, leases a force push, and tells a refused sign-in apart", async () => {
    const folder = await makeFolder("moved");
    const remote = await makeRemote("octo/moved");
    const first = sh(folder, "rev-parse", "feat/x");
    const results = await run(
      Effect.gen(function* () {
        const git = yield* GitPush;
        const repository = { owner: "octo", name: "moved" };
        const staged = yield* git.stage([folder], folder, "feat/x");
        const created = yield* git.push(staged, target(staged.commit, { repository }), https);
        // The hob rewrites its branch: a push without force is refused, a force push replaces only the commit read.
        sh(folder, "commit", "--quiet", "--no-gpg-sign", "--amend", "-m", "Add b again");
        const rewritten = yield* git.stage([folder], folder, "feat/x");
        const plain = yield* git.push(rewritten, target(rewritten.commit, { repository }), https);
        const stale = yield* git.push(
          rewritten,
          target(rewritten.commit, { repository, force: true, replaces: "0".repeat(40) }),
          https,
        );
        const forced = yield* git.push(
          rewritten,
          target(rewritten.commit, { repository, force: true, replaces: first }),
          https,
        );
        const signedOut = yield* git.push(rewritten, target(rewritten.commit, { repository }), {
          _tag: "Https",
          token: Redacted.make("ghu_wrong"),
        });
        return { created, plain, stale, forced, signedOut, rewritten };
      }),
    );
    expect(results.created._tag).toBe("Pushed");
    expect(results.plain).toMatchObject({ _tag: "Rejected", message: expect.stringContaining("moved") });
    expect(results.stale._tag).toBe("Rejected");
    expect(results.forced).toEqual({ _tag: "Pushed", created: false, forced: true });
    expect(results.signedOut).toEqual({ _tag: "SignedOut" });
    expect(sh(remote, "rev-parse", "refs/heads/feat/x")).toBe(results.rewritten.commit);
  });

  // covers EX-003, EX-004
  it("[TC-PE-154] reads an unclear end as uncertain, and only an unreachable GitHub as not sent", () => {
    const ref = "refs/heads/feat/x";
    expect(pushResult(128, "", "fatal: unable to access: Could not resolve host: github.com", ref)._tag).toBe(
      "NotSent",
    );
    expect(pushResult(128, "", "error: RPC failed; HTTP 502 curl 22", ref)._tag).toBe("Uncertain");
    expect(pushResult(128, "", "fatal: the remote end hung up unexpectedly", ref)._tag).toBe("Uncertain");
    expect(
      pushResult(1, `To x\n!\tabc:${ref}\t[remote rejected] (protected branch hook declined)\nDone\n`, "", ref),
    ).toMatchObject({ _tag: "Rejected", message: expect.stringContaining("protected branch") });
    expect(pushResult(0, `To x\n*\tabc:${ref}\t[new branch]\nDone\n`, "", ref)).toEqual({
      _tag: "Pushed",
      created: true,
      forced: false,
    });
  });
});
