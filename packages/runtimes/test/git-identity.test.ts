import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { userGitIdentity, withUserIdentity } from "../src/git-config.ts";
import { gitConfigEnv, UNSIGNED_GIT } from "../src/sandbox.ts";

// Issue #586: a hob without its own app commits as the user, never as an identity Git makes up
// from the user's account and the computer's name.

const HOME = "/Users/ada";
const files = (map: Record<string, string>) => (path: string) => map[path] ?? null;

describe("The user's Git identity", () => {
  it("reads user.name and user.email from the user's config and the files it includes, the last winning", () => {
    const read = files({
      [`${HOME}/.gitconfig`]: [
        "[user]",
        '  name = "Ada Lovelace"',
        "  email = ada@old.example # replaced below",
        "[include]",
        "  path = ~/.gitconfig.local",
        '[includeIf "gitdir:~/work/"]',
        "  path = ~/.gitconfig.work",
        "[http]",
        "  extraHeader = Authorization: Bearer secret",
      ].join("\n"),
      [`${HOME}/.gitconfig.local`]: "[user]\n\temail = ada@example.com\n",
      [`${HOME}/.gitconfig.work`]: "[user]\n\temail = ada@work.example\n",
    });
    expect(userGitIdentity(HOME, {}, read)).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
  });

  it("finds none when no config sets one", () => {
    expect(userGitIdentity(HOME, {}, files({ [`${HOME}/.gitconfig`]: "[core]\n  editor = vim\n" }))).toEqual({
      name: null,
      email: null,
    });
  });
});

describe("Commits a hob makes without its own app", () => {
  let repo: string;
  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-identity-")));
    execFileSync("git", ["init", "-q"], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    writeFileSync(join(repo, "a.md"), "a\n");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  /** Commits as a hob's command would, unable to read any user config, and returns the author or Git's error. */
  const commit = (env: NodeJS.ProcessEnv) => {
    const base = {
      PATH: process.env.PATH,
      HOME: join(repo, "no-home"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: undefined,
    };
    try {
      execFileSync("git", ["add", "a.md"], { cwd: repo, env: { ...base, ...env } });
      execFileSync("git", ["commit", "-q", "-m", "one"], { cwd: repo, env: { ...base, ...env }, stdio: "pipe" });
      return execFileSync("git", ["log", "-1", "--format=%ae"], { cwd: repo, env: base }).toString().trim();
    } catch (error) {
      return `failed: ${String((error as { stderr?: Buffer }).stderr ?? error)}`;
    }
  };

  // covers OR-004
  it("[TC-OR-286] commit under the user's configured email, which a repository's own setting still overrides", () => {
    const env = withUserIdentity(UNSIGNED_GIT, { name: "Ada Lovelace", email: "ada@example.com" });
    expect(env.GIT_CONFIG_COUNT).toBe(UNSIGNED_GIT.GIT_CONFIG_COUNT);
    expect(commit(env)).toBe("ada@example.com");
    writeFileSync(join(repo, "a.md"), "a, again\n");
    execFileSync("git", ["config", "user.email", "site@example.com"], { cwd: repo });
    expect(commit(env)).toBe("site@example.com");
  });

  // covers OR-004
  it("[TC-OR-287] fail with no identity rather than one made up from the computer's name, keeping the other settings", () => {
    const env = withUserIdentity(gitConfigEnv([["commit.gpgsign", "false"]]), { name: "Ada Lovelace", email: null });
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "commit.gpgsign",
      GIT_CONFIG_KEY_1: "user.useConfigOnly",
      GIT_CONFIG_VALUE_1: "true",
    });
    expect(commit(env)).toMatch(/^failed: .*no email was given and auto-detection is disabled/s);
  });
});
