import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settleCommitsAs } from "@hobbots/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NO_GIT_IDENTITY_NOTE, turnCommits, userGitIdentity, withUserIdentity } from "../src/git-config.ts";
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
    // The user's own config, which the sandbox opens for reading.
    mkdirSync(join(root, "home"));
    writeFileSync(join(root, "home", ".gitconfig"), '[user]\n  name = "Ada Lovelace"\n  email = ada@example.com\n');
    repo = join(root, "work");
    init(repo);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const SCRUBBED = {
    GIT_AUTHOR_NAME: undefined,
    GIT_AUTHOR_EMAIL: undefined,
    GIT_COMMITTER_NAME: undefined,
    GIT_COMMITTER_EMAIL: undefined,
    EMAIL: undefined,
    XDG_CONFIG_HOME: undefined,
    GIT_CONFIG_GLOBAL: undefined,
  };
  /** A hob's command: the user's config open for reading, or closed as when one of its files holds a secret. */
  const sandbox = (config: "open" | "closed") => ({
    ...SCRUBBED,
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: join(root, "home"),
    ...(config === "closed" ? { GIT_CONFIG_GLOBAL: "/dev/null" } : {}),
  });
  const git = (cwd: string, ...args: ReadonlyArray<string>) =>
    execFileSync("git", args, { cwd, env: { ...sandbox("closed"), HOME: join(root, "no-home") } })
      .toString()
      .trim();
  const init = (folder: string) => {
    mkdirSync(folder, { recursive: true });
    git(folder, "init", "-q");
  };
  const ada = { name: "Ada Lovelace", email: "ada@example.com" };
  /** The environment a turn's commands commit with, as the launcher builds it. */
  const turn = withUserIdentity(UNSIGNED_GIT, ada);

  /** Commits as a hob's command would, and returns the author and committer or Git's error. */
  const commit = (at: string, config: "open" | "closed" = "open", env: NodeJS.ProcessEnv = turn) => {
    writeFileSync(join(at, "a.md"), `${Math.random()}\n`);
    const run = { ...sandbox(config), ...env };
    try {
      execFileSync("git", ["add", "a.md"], { cwd: at, env: run });
      execFileSync("git", ["commit", "-q", "-m", "one"], { cwd: at, env: run, stdio: "pipe" });
      return git(at, "log", "-1", "--format=%an <%ae>, %cn <%ce>");
    } catch (error) {
      return `failed: ${String((error as { stderr?: Buffer }).stderr ?? error)}`;
    }
  };

  // covers OR-004
  it("[TC-OR-286] commit under the user's configured name and email, unless the repository names its own", () => {
    // The turn names no one: Git settles the name from config, so no repository's own is overridden.
    expect(turn.GIT_AUTHOR_NAME).toBeUndefined();
    expect(Object.entries(turn).filter(([, value]) => value === "user.name")).toEqual([]);
    expect(commit(repo)).toBe("Ada Lovelace <ada@example.com>, Ada Lovelace <ada@example.com>");
    // The repository sets its own identity, and signs: it keeps its identity, unsigned.
    git(repo, "config", "user.name", "Site Bot");
    git(repo, "config", "user.email", "site@example.com");
    git(repo, "config", "commit.gpgsign", "true");
    expect(commit(repo)).toBe("Site Bot <site@example.com>, Site Bot <site@example.com>");
    // With the user's config closed it keeps it too.
    expect(commit(repo, "closed")).toBe("Site Bot <site@example.com>, Site Bot <site@example.com>");
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
    git(repo, "config", "user.name", "Site Bot");
    expect(commit(repo, "closed", env)).toMatch(/^failed: .*no email was given and auto-detection is disabled/s);
  });

  // covers OR-004
  it("[TC-OR-292] a repository that sets only its email commits under that email and the user's name", () => {
    git(repo, "config", "user.email", "site@example.com");
    expect(commit(repo)).toBe("Ada Lovelace <site@example.com>, Ada Lovelace <site@example.com>");
    // One that sets only its name keeps it, with the user's email, whether or not the user's config is open.
    git(repo, "config", "--unset", "user.email");
    git(repo, "config", "user.name", "Site Bot");
    expect(commit(repo)).toBe("Site Bot <ada@example.com>, Site Bot <ada@example.com>");
    expect(commit(repo, "closed")).toBe("Site Bot <ada@example.com>, Site Bot <ada@example.com>");
  });

  // covers OR-004
  it("[TC-OR-293] each repository settles its own commits, however deep: nested, side by side and in a worktree", () => {
    // `work/a/b/c/d/e/site` names itself deep inside the approved `work`; `notes` beside it does not.
    const site = join(repo, "a", "b", "c", "d", "e", "site");
    init(site);
    git(site, "config", "user.name", "Site Bot");
    git(site, "config", "user.email", "site@example.com");
    const notes = join(root, "notes");
    init(notes);
    expect(commit(repo)).toBe("Ada Lovelace <ada@example.com>, Ada Lovelace <ada@example.com>");
    expect(commit(site)).toBe("Site Bot <site@example.com>, Site Bot <site@example.com>");
    expect(commit(site, "closed")).toBe("Site Bot <site@example.com>, Site Bot <site@example.com>");
    expect(commit(notes)).toBe("Ada Lovelace <ada@example.com>, Ada Lovelace <ada@example.com>");
    // A linked worktree of `site` reads the shared config.
    const linked = join(root, "site-linked");
    git(site, "worktree", "add", "-q", "-b", "linked", linked);
    expect(commit(linked)).toBe("Site Bot <site@example.com>, Site Bot <site@example.com>");
  });

  // covers OR-004
  it("[TC-OR-630] with no identity in the user's config, commit under the one they gave Hobbots, or not at all (#741)", () => {
    const empty = join(root, "empty-home");
    mkdirSync(empty);
    const given = { name: "otaviobarros", email: "35647586+otaviobarros@users.noreply.github.com" };
    // What the hub settles from the user's config under `home` and their answer, and the turn applies.
    const settled = (home: string, answer: typeof given | null, bot: typeof given | null = null) => {
      const commitsAs = settleCommitsAs(bot, userGitIdentity(home), answer);
      return { as: commitsAs, ...turnCommits({ commitsAs }) };
    };
    // Neither the user's config nor Hobbots has one: the hob is told not to commit and not to ask.
    const none = settled(empty, null);
    expect(none.as._tag).toBe("Missing");
    expect(none.note).toBe(NO_GIT_IDENTITY_NOTE);
    expect(none.note).toContain("Do not ask the user yourself");
    const noHome = { HOME: empty };
    expect(commit(repo, "open", { ...none.env(UNSIGNED_GIT), ...noHome })).toMatch(/^failed: .*no email was given/s);
    // The user gave Hobbots one: it is used, name and email, and the hob is told so.
    const asGiven = settled(empty, given);
    expect(asGiven.as).toMatchObject({ _tag: "UserGiven", identity: given });
    expect(asGiven.note).toContain(`made as ${given.name} <${given.email}>`);
    expect(commit(repo, "open", { ...asGiven.env(UNSIGNED_GIT), ...noHome })).toBe(
      `${given.name} <${given.email}>, ${given.name} <${given.email}>`,
    );
    // A config that sets only a name keeps it, with the given email.
    writeFileSync(join(empty, ".gitconfig"), '[user]\n  name = "Otavio Barros"\n');
    const named = settled(empty, given);
    expect(named.as).toMatchObject({ _tag: "UserGiven", identity: { name: "Otavio Barros", email: given.email } });
    expect(commit(repo, "open", { ...named.env(UNSIGNED_GIT), ...noHome })).toBe(
      `Otavio Barros <${given.email}>, Otavio Barros <${given.email}>`,
    );
    // The user's own config wins over the given one once it sets an email.
    const own = settled(join(root, "home"), given);
    expect(own.as._tag).toBe("UserConfig");
    expect(own.note).toBe("");
    expect(commit(repo, "open", own.env(UNSIGNED_GIT))).toBe(
      "Ada Lovelace <ada@example.com>, Ada Lovelace <ada@example.com>",
    );
    // A hob with its own app commits as its bot, whatever the user gave.
    const bot = { name: "frodo[bot]", email: "1+frodo[bot]@users.noreply.github.com" };
    expect(settled(empty, given, bot).as).toEqual({ _tag: "Bot", identity: bot });
  });
});
