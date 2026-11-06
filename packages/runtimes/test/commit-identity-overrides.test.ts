import { describe, expect, it } from "vitest";
import { steerCommitIdentity } from "../src/approval.ts";
import { overridesCommitIdentity } from "../src/tool-calls.ts";

// #700: a hob without an app of its own committed as another hob's bot with `git -c user.name=…`.
// The hub sets every hob's commit identity, so a command that sets its own is refused.

const cwd = "/work/shire";
const home = "/Users/frodo";
const overrides = (command: string) => overridesCommitIdentity("Bash", { command }, cwd, home);
const BOT = "frodo-hobbots[bot]";
const BOT_EMAIL = `351716127+${BOT}@users.noreply.github.com`;

describe("commit identity overrides", () => {
  it("detects every way a command line sets the author or committer", () => {
    for (const command of [
      `git -c user.name=${BOT} -c user.email=${BOT_EMAIL} commit -m "chore: pocket ledger v0.1"`,
      `git -c user.email=${BOT_EMAIL} commit -m x`,
      `git -cuser.name=${BOT} commit -m x`,
      "git -c User.Name=Frodo commit -m x",
      "git -c author.name=Frodo commit -m x",
      "git -c committer.email=frodo@example.com commit -m x",
      "git -c include.path=/work/shire/identity commit -m x",
      "git -c includeIf.onbranch:main.path=/work/shire/identity commit -m x",
      "git --config-env=user.name=NAME commit -m x",
      "git --config-env user.email=MAIL commit -m x",
      "git -C sub -c user.name=Frodo commit -m x",
      `git commit --author="${BOT} <${BOT_EMAIL}>" -m x`,
      `git commit -m x --author "${BOT} <${BOT_EMAIL}>"`,
      "git commit --auth=Frodo -m x",
      "git commit --au Frodo -m x",
      `GIT_AUTHOR_NAME=${BOT} git commit -m x`,
      "GIT_AUTHOR_EMAIL=frodo@example.com git commit -m x",
      "GIT_COMMITTER_NAME=Frodo GIT_COMMITTER_EMAIL=frodo@example.com git commit -m x",
      "EMAIL=frodo@example.com git commit -m x",
      "env GIT_AUTHOR_NAME=Frodo git commit -m x",
      "env -i GIT_AUTHOR_NAME=Frodo git commit -m x",
      "nice env GIT_COMMITTER_NAME=Frodo git commit -m x",
      "env -S 'GIT_AUTHOR_NAME=Frodo git commit -m x'",
      "export GIT_AUTHOR_NAME=Frodo && git commit -m x",
      "export GIT_AUTHOR_NAME+=Frodo; git commit -m x",
      "declare -x GIT_COMMITTER_EMAIL=frodo@example.com; git commit -m x",
      "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=Frodo git commit -m x",
      "GIT_CONFIG_PARAMETERS=\"'user.name'='Frodo'\" git commit -m x",
      "GIT_CONFIG_GLOBAL=/work/shire/identity git commit -m x",
      "GIT_CONFIG=/work/shire/identity git commit -m x",
      "git add . && git -c user.name=Frodo commit -m x",
      "GIT_AUTHOR_NAME=Frodo npm run release",
      // The variables the hub sets a bot's identity with, and dropping them.
      `GIT_CONFIG_VALUE_0=${BOT} git commit -m x`,
      "GIT_CONFIG_COUNT=0 git commit -m x",
      "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=color.ui GIT_CONFIG_VALUE_0=false git log",
      "unset GIT_CONFIG_COUNT; git commit -m x",
      "env -i PATH=/usr/bin git commit -m x",
      "env -u GIT_CONFIG_COUNT git commit -m x",
      "env --unset=EMAIL git commit -m x",
      "env -C . -i git commit -m x",
      "env -C sub -u GIT_CONFIG_COUNT git commit -m x",
      "env -S '-i git commit -m x'",
      // Writing the identity to a config, or taking another commit's author.
      `git config user.name ${BOT} && git commit -m x`,
      "git config --global user.email frodo@example.com",
      "git config set user.name Frodo",
      "git commit -C abc123 --allow-empty",
      "git commit --reuse-message=abc123",
      "git commit -c abc123",
      "git commit -aC abc123",
      // A value that only looks like an option is never read as one.
      "git commit --author='Frodo <frodo@example.com>' -m '--reset-author'",
      "git commit -m --reset-author --author=Frodo",
      // Another shell's command line, `eval`, and a key only the shell settles.
      'bash -c "git -c user.name=Frodo commit -m x"',
      "sh -ec 'GIT_AUTHOR_NAME=Frodo git commit -m x'",
      "eval GIT_AUTHOR_NAME=Frodo git commit -m x",
      'git -c "$KEY=Frodo" commit -m x',
    ]) {
      expect(overrides(command), command).toBe(true);
    }
  });

  it("lets an ordinary commit and other Git commands through", () => {
    for (const command of [
      "git commit -m 'chore: pocket ledger v0.1'",
      "git add . && git commit -am 'Fix the ledger'",
      "git commit --amend --no-edit",
      "git commit --all -m x",
      "git commit -m x -- --author",
      "git -c color.ui=false commit -m x",
      "git -c core.editor=true commit",
      "GIT_CONFIG_GLOBAL=/dev/null git status",
      "git config --get user.email",
      "git commit -C abc123 --reset-author",
      "git commit -m '--author=Frodo'",
      "git commit -am --author=Frodo",
      "git commit --message --reuse-message=abc",
      "git commit -F msg.txt -- --author",
      "env -C sub git commit -m x",
      "bash -c 'git commit -m x'",
      "unset NODE_OPTIONS; npm test",
      "git log --author=Frodo",
      "git shortlog --author Frodo",
      "git config user.name",
      "echo GIT_AUTHOR_NAME=Frodo",
      'git commit -m "Document --author and GIT_AUTHOR_NAME"',
      "export NODE_ENV=test && npm test",
    ]) {
      expect(overrides(command), command).toBe(false);
    }
    // Only a command line is read.
    expect(overridesCommitIdentity("Write", { file_path: "x", content: "git -c user.name=Frodo" }, cwd, home)).toBe(
      false,
    );
  });

  it("names the identity the hub sets in the refusal: the hob's bot, the user's, the one they gave, or none yet", () => {
    const bot = steerCommitIdentity({ _tag: "Bot", identity: { name: BOT, email: BOT_EMAIL } });
    const config = steerCommitIdentity({ _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } });
    const given = steerCommitIdentity({
      _tag: "UserGiven",
      config: { name: null, email: null },
      identity: { name: "Ada", email: "ada@example.com" },
    });
    const missing = steerCommitIdentity({ _tag: "Missing", config: { name: null, email: null } });
    expect(bot).toContain(`made as ${BOT} <${BOT_EMAIL}>`);
    expect(config).toContain("made as the user, with the identity their Git config sets");
    expect(given).toContain("made as Ada <ada@example.com>, the identity the user gave Hobbots");
    for (const reason of [bot, config, given]) expect(reason).toContain("never as another hob");
    // #741: with no identity at all it never claims the user's config sets one, and never sends the hob to ask.
    expect(missing).not.toContain("their Git config sets,");
    expect(missing).toContain("none is set yet");
    expect(missing).toContain("Do not ask them yourself");
  });
});
