import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ToolAccess } from "@hobbots/agents";
import { EMPTY_HOB_POLICY, hobAppCommitIdentity } from "@hobbots/domain";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toolTurn, turnSigningAgent } from "../src/claude-code.ts";
import { ProcessSandbox, withCommitIdentity } from "../src/sandbox.ts";

// A hob with its own GitHub App commits locally as its bot (ADR 022, #225).
const BOT = hobAppCommitIdentity({ slug: "frodo-hobbots", botUserId: 90001000 });
let root = "";

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-commit-identity-")));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The user's own Git setup: a global config naming them, and asking to sign every commit. */
const userSetup = () => {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, ".gitconfig"),
    "[user]\n\tname = Otavio\n\temail = otavio@example.com\n[author]\n\tname = Otavio\n[committer]\n\temail = otavio@example.com\n[commit]\n\tgpgsign = true\n",
  );
  return home;
};

/** A repository whose own config names someone else again. */
const repository = (name: string) => {
  const folder = join(root, name);
  mkdirSync(folder);
  execFileSync("git", ["init", "--quiet", folder]);
  execFileSync("git", ["-C", folder, "config", "user.name", "Repository"]);
  execFileSync("git", ["-C", folder, "config", "user.email", "repository@example.com"]);
  writeFileSync(join(folder, "a.txt"), "a\n");
  return folder;
};

/** The hub's own environment, where the identity variables name the user too. */
const hubEnv = (home: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: home,
  GIT_AUTHOR_NAME: "Otavio",
  GIT_AUTHOR_EMAIL: "otavio@example.com",
  GIT_COMMITTER_NAME: "Otavio",
  GIT_COMMITTER_EMAIL: "otavio@example.com",
  EMAIL: "otavio@example.com",
});

const commitIn = (folder: string, env: NodeJS.ProcessEnv, ...extra: Array<string>) => {
  execFileSync("git", ["-C", folder, "add", "a.txt"], { env });
  execFileSync("git", ["-C", folder, "commit", "--quiet", ...extra, "-m", "Add a"], { env });
  return execFileSync("git", ["-C", folder, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%G?"], {
    env,
    encoding: "utf8",
  }).trim();
};

const access = (folder: string, commitAs?: typeof BOT): ToolAccess => ({
  policy: {
    preset: "balanced",
    sharedFolders: [folder],
    hob: { ...EMPTY_HOB_POLICY, signCommits: true },
    dataFolder: join(root, "data"),
    restrictions: [],
  },
  folders: [folder],
  runtimeFolder: join(root, "runtimes", "frodo"),
  ...(commitAs ? { commitAs } : {}),
});

describe("a hob's commit identity", () => {
  // covers ADR 022
  it("[TC-CH-194] commits as the hob's bot over the user's and the repository's config and the hub's identity variables", () => {
    expect(BOT).toEqual({
      name: "frodo-hobbots[bot]",
      email: "90001000+frodo-hobbots[bot]@users.noreply.github.com",
    });
    // Without the bot's user ID, GitHub's older noreply address.
    expect(hobAppCommitIdentity({ slug: "sam-hobbots", botUserId: null }).email).toBe(
      "sam-hobbots[bot]@users.noreply.github.com",
    );
    const home = userSetup();
    const folder = repository("as-bot");
    const env = withCommitIdentity(hubEnv(home), BOT);
    for (const name of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) {
      expect(env).not.toHaveProperty(name);
    }
    // Author and committer are both the bot, and the user's config asking to sign is turned off.
    const bot = `${BOT.name} <${BOT.email}>`;
    expect(commitIn(folder, env)).toBe(`${bot}|${bot}|N`);
    // A hob may name another author in its own command; Push still recreates the commit as the bot.
    writeFileSync(join(folder, "a.txt"), "b\n");
    expect(commitIn(folder, env, "--author=Someone <someone@example.com>")).toBe(
      `Someone <someone@example.com>|${bot}|N`,
    );
  });

  // covers ADR 022
  it("[TC-CH-195] keeps the user's own identity for a hob on the user's account", () => {
    const home = userSetup();
    const folder = repository("as-you");
    const env = hubEnv(home);
    expect(withCommitIdentity(env, undefined)).toBe(env);
    expect(
      commitIn(folder, {
        ...env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "commit.gpgsign",
        GIT_CONFIG_VALUE_0: "false",
      }),
    ).toBe("Otavio <otavio@example.com>|Otavio <otavio@example.com>|N");
  });

  // covers ADR 022
  it("[TC-CH-196] never opens the user's signing agent to a hob with its own app, even with signing on", () => {
    const folder = repository("signing");
    const agent = () => "/Users/me/agent.sock";
    const asYou = toolTurn(access(folder), "on");
    const asBot = toolTurn(access(folder, BOT), "on");
    expect(asYou?.commitAs).toBeUndefined();
    expect(asBot?.commitAs).toEqual(BOT);
    expect(turnSigningAgent(asYou, agent)).toBe("/Users/me/agent.sock");
    expect(turnSigningAgent(asBot, agent)).toBeUndefined();
    // Without the sandbox no turn reaches the agent.
    expect(turnSigningAgent(null, agent)).toBeUndefined();
  });

  // covers ADR 022
  it.runIf(process.platform === "darwin")(
    "[TC-CH-197] commits as the bot inside the sandbox, whatever the user's config says",
    async () => {
      const folder = repository("sandboxed");
      await Effect.gen(function* () {
        const sandbox = yield* ProcessSandbox;
        const prepared = yield* Effect.acquireRelease(
          sandbox.prepare({
            folders: [folder],
            folderAccess: { read: true, write: true },
            dataFolder: join(root, "data"),
            binary: "/bin/sh",
            runtimeFolder: join(root, "runtimes", "frodo"),
            allowedHosts: [],
            commitAs: BOT,
          }),
          (ready) => Effect.sync(ready.release),
        );
        const { command, args, env } = prepared.spawnArgs(
          "/bin/sh",
          ["-c", "git add a.txt && git commit --quiet -m 'Add a' && git log -1 --format='%an <%ae>|%cn <%ce>'"],
          hubEnv(process.env.HOME ?? root),
        );
        const { stdout } = yield* Effect.promise(() =>
          promisify(execFile)(command, [...args], { cwd: folder, env, encoding: "utf8" }),
        );
        const bot = `${BOT.name} <${BOT.email}>`;
        expect(stdout.trim()).toBe(`${bot}|${bot}`);
      }).pipe(Effect.provide(ProcessSandbox.layer), Effect.scoped, Effect.runPromise);
    },
    30_000,
  );
});
