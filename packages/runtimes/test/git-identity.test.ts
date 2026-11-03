import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { namedRepositories, repositoriesOf, userGitIdentity, withUserIdentity } from "../src/git-config.ts";
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
  let root: string;
  let repo: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-identity-")));
    repo = join(root, "work");
    init(repo);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const NO_CONFIG = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd: string, ...args: ReadonlyArray<string>) =>
    execFileSync("git", args, { cwd, env: { ...NO_CONFIG, HOME: join(root, "no-home") } })
      .toString()
      .trim();
  const init = (folder: string) => {
    mkdirSync(folder, { recursive: true });
    git(folder, "init", "-q");
  };
  const ada = { name: "Ada Lovelace", email: "ada@example.com" };
  /** The environment a turn on `folders` commits with, as the launcher builds it. */
  const turn = (folders: ReadonlyArray<string>, identity = ada) =>
    withUserIdentity(UNSIGNED_GIT, identity, namedRepositories(repositoriesOf(folders), join(root, "no-home")));

  /** Commits as a hob's command would, unable to read any user config, and returns the author and committer or Git's error. */
  const commit = (env: NodeJS.ProcessEnv, at = repo) => {
    const base = {
      ...NO_CONFIG,
      HOME: join(root, "no-home"),
      GIT_AUTHOR_NAME: undefined,
      GIT_AUTHOR_EMAIL: undefined,
      GIT_COMMITTER_NAME: undefined,
      GIT_COMMITTER_EMAIL: undefined,
      EMAIL: undefined,
    };
    writeFileSync(join(at, "a.md"), `${Math.random()}\n`);
    try {
      execFileSync("git", ["add", "a.md"], { cwd: at, env: { ...base, ...env } });
      execFileSync("git", ["commit", "-q", "-m", "one"], { cwd: at, env: { ...base, ...env }, stdio: "pipe" });
      return execFileSync("git", ["log", "-1", "--format=%an <%ae>, %cn <%ce>"], { cwd: at, env: base })
        .toString()
        .trim();
    } catch (error) {
      return `failed: ${String((error as { stderr?: Buffer }).stderr ?? error)}`;
    }
  };

  // covers OR-004
  it("[TC-OR-286] commit under the user's configured name and email, unless the repository names its own", () => {
    expect(turn([repo]).GIT_AUTHOR_NAME).toBeUndefined();
    expect(commit(turn([repo]))).toBe("Ada Lovelace <ada@example.com>, Ada Lovelace <ada@example.com>");
    // The repository sets its own identity, and signs: the next turn leaves the identity to it, unsigned.
    git(repo, "config", "user.name", "Site Bot");
    git(repo, "config", "user.email", "site@example.com");
    git(repo, "config", "commit.gpgsign", "true");
    expect(namedRepositories(repositoriesOf([join(repo, "docs")]), join(root, "no-home"))).toHaveLength(1);
    expect(commit(turn([repo]))).toBe("Site Bot <site@example.com>, Site Bot <site@example.com>");
  });

  // covers OR-004
  it("[TC-OR-287] fail with no identity rather than one made up from the computer's name, keeping the other settings", () => {
    const env = withUserIdentity(gitConfigEnv([["commit.gpgsign", "false"]]), { name: "Ada Lovelace", email: null });
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_KEY_1: "user.useConfigOnly",
      GIT_CONFIG_VALUE_1: "true",
      GIT_CONFIG_KEY_2: "commit.gpgsign",
      GIT_CONFIG_VALUE_2: "false",
    });
    expect(commit(env)).toMatch(/^failed: .*no email was given and auto-detection is disabled/s);
  });

  // covers OR-004
  it("[TC-OR-292] a repository that sets only its email commits under that email and the user's name", () => {
    git(repo, "config", "user.email", "site@example.com");
    expect(commit(turn([repo]))).toBe("Ada Lovelace <site@example.com>, Ada Lovelace <site@example.com>");
    // One that sets only its name keeps it, with the user's email.
    git(repo, "config", "--unset", "user.email");
    git(repo, "config", "user.name", "Site Bot");
    expect(commit(turn([repo]))).toBe("Site Bot <ada@example.com>, Site Bot <ada@example.com>");
  });

  // covers OR-004
  it("[TC-OR-293] each repository of the turn's folders settles its own commits: nested, side by side and in a worktree", () => {
    // `work/site` names itself inside the approved `work`; `notes` beside it does not; `docs` does by email only.
    const site = join(repo, "site");
    init(site);
    git(site, "config", "user.name", "Site Bot");
    git(site, "config", "user.email", "site@example.com");
    const notes = join(root, "notes");
    init(notes);
    const docs = join(root, "docs");
    init(docs);
    git(docs, "config", "user.email", "docs@example.com");
    const env = turn([repo, notes, docs]);
    expect(commit(env)).toBe("Ada Lovelace <ada@example.com>, Ada Lovelace <ada@example.com>");
    expect(commit(env, site)).toBe("Site Bot <site@example.com>, Site Bot <site@example.com>");
    expect(commit(env, notes)).toBe("Ada Lovelace <ada@example.com>, Ada Lovelace <ada@example.com>");
    expect(commit(env, docs)).toBe("Ada Lovelace <docs@example.com>, Ada Lovelace <docs@example.com>");
    // A linked worktree of `site`, approved on its own, reads the shared config.
    const linked = join(root, "site-linked");
    git(site, "worktree", "add", "-q", "-b", "linked", linked);
    expect(commit(turn([linked]), linked)).toBe("Site Bot <site@example.com>, Site Bot <site@example.com>");
  });
});
