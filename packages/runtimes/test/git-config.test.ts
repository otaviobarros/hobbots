import { describe, expect, it } from "vitest";
import { gitConfigAccess, includedFiles, secretIn } from "../src/git-config.ts";

const home = "/Users/me";
const files =
  (contents: Record<string, string>) =>
  (path: string): string | null =>
    contents[path] ?? null;
const same = (path: string) => path;

describe("the user's Git config in the sandbox", () => {
  it("finds no secret in an ordinary config", () => {
    expect(
      secretIn(
        [
          "[user]",
          "\tsigningkey = ~/.ssh/id_ed25519.pub",
          "[core]",
          "\teditor = vim",
          "[alias]",
          "\tst = status",
          "[credential]",
          "\thelper = osxkeychain",
          "# token = ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  it("finds tokens, passwords and authorization headers", () => {
    expect(secretIn('[http]\n\textraHeader = "Authorization: Bearer abc"')).not.toBeNull();
    expect(secretIn('[url "https://me:s3cret@github.com/"]\n\tinsteadOf = https://github.com/')).not.toBeNull();
    expect(secretIn("[github]\n\ttoken = abc")).not.toBeNull();
    expect(secretIn("[alias]\n\tx = !echo ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).not.toBeNull();
  });

  it("tells a URL with a password from one with a user name only", () => {
    expect(secretIn('[url "ssh://git@github.com/"]\n\tinsteadOf = https://github.com/')).toBeNull();
  });

  it("scans long hostile lines in linear time", () => {
    const started = performance.now();
    for (const line of ["a".repeat(50_000), " #".repeat(50_000), `path=${" ".repeat(50_000)}`, ":/".repeat(50_000)]) {
      secretIn(line);
      includedFiles(`[include]\n${line}`, "/Users/me/.gitconfig", home);
    }
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("lists the files a config includes, under any condition", () => {
    const text = [
      "[include]",
      "\tpath = ~/.gitconfig.local",
      '[includeIf "gitdir:~/work/"]',
      '\tpath = "work/config"',
      "\tpath = ~/.gitconfig.extra # kept here",
      "[user]",
      "\tpath = not-an-include",
    ].join("\n");
    expect(includedFiles(text, "/Users/me/.gitconfig", home)).toEqual([
      "/Users/me/.gitconfig.local",
      "/Users/me/work/config",
      "/Users/me/.gitconfig.extra",
    ]);
  });

  it("opens the config files that exist, with their includes and real locations", () => {
    const access = gitConfigAccess(
      home,
      {},
      files({
        "/Users/me/.gitconfig": "[include]\n\tpath = ~/dotfiles/identity\n[include]\n\tpath = ~/.gitconfig",
        "/Users/me/dotfiles/identity": "[user]\n\tname = Ada",
      }),
      (path) => (path === "/Users/me/.gitconfig" ? "/Users/me/dotfiles/gitconfig" : path),
    );
    expect(access).toEqual({
      _tag: "Open",
      files: ["/Users/me/.gitconfig", "/Users/me/dotfiles/gitconfig", "/Users/me/dotfiles/identity"],
    });
    expect(gitConfigAccess(home, { XDG_CONFIG_HOME: "/x" }, files({ "/x/git/config": "[core]" }), same)).toEqual({
      _tag: "Open",
      files: ["/x/git/config"],
    });
  });

  it("keeps every file closed when one of them holds a secret", () => {
    const access = gitConfigAccess(
      home,
      {},
      files({
        "/Users/me/.gitconfig": "[include]\n\tpath = ~/.gitconfig.local",
        "/Users/me/.gitconfig.local": "[github]\n\ttoken = abc",
      }),
      same,
    );
    expect(access).toMatchObject({ _tag: "Closed", file: "/Users/me/.gitconfig.local" });
  });
});
