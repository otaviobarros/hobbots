import { describe, expect, it } from "vitest";
import { ghArguments } from "../src/tool-calls.ts";

// Issue #1349: no credential enters a hob's sandbox, so `gh` cannot sign in there. The hub refuses it
// before it runs, wherever the command line spells it, so it must find every `gh` the line runs.

const project = "/work/ledger";
const found = (command: string) => ghArguments("Bash", { command }, project, "/Users/frodo");

describe("the gh a command line runs (#1349)", () => {
  // covers PE-005, SEC-002
  it("[TC-RT-1349-01] finds gh behind wrappers and shell keywords, after other commands, inside eval, sh -c and command substitutions, and nothing for any other command", () => {
    expect(found("gh pr create --fill")).toEqual(["pr", "create", "--fill"]);
    expect(found("git add -A && gh pr comment 3 --body 'Looks good'")).toEqual([
      "pr",
      "comment",
      "3",
      "--body",
      "Looks good",
    ]);
    expect(found("GH_TOKEN=x gh issue list")).toEqual(["issue", "list"]);
    expect(found("env GH_PAGER=cat gh pr view 3")).toEqual(["pr", "view", "3"]);
    expect(found("env -S 'gh repo view'")).toEqual(["repo", "view"]);
    expect(found("/opt/homebrew/bin/gh api user")).toEqual(["api", "user"]);
    expect(found("sh -c 'cd /tmp && gh issue create -t x'")).toEqual(["issue", "create", "-t", "x"]);
    expect(found(`bash -lc "gh pr list"`)).toEqual(["pr", "list"]);
    expect(found("eval gh pr status")).toEqual(["pr", "status"]);
    expect(found("timeout 30 gh run list")).toEqual(["run", "list"]);
    expect(found("gh")).toEqual([]);
    // Behind shell keywords, and in a command substitution, quoted or not.
    expect(found("if gh pr view 1; then echo found; fi")).toEqual(["pr", "view", "1"]);
    expect(found("while ! gh pr checks 3; do sleep 5; done")).toEqual(["pr", "checks", "3"]);
    expect(found("for i in 1 2; do gh issue view $i; done")).toEqual(["issue", "view", "$i"]);
    expect(found("{ gh pr list; }")).toEqual(["pr", "list"]);
    expect(found('echo "$(gh pr view 1)"')).toEqual(["pr", "view", "1"]);
    expect(found("echo `gh pr list`")).toEqual(["pr", "list"]);
    expect(found('n=$(echo "$(gh issue list | wc -l)")')).toEqual(["issue", "list"]);
    expect(found("cat <(gh pr list)")).toEqual(["pr", "list"]);
    // An apostrophe inside double quotes opens no single quotes, so what follows still runs.
    expect(found(`echo "PR's $(gh pr view 1)"`)).toEqual(["pr", "view", "1"]);
    expect(found('echo "PR\'s `gh pr list`"')).toEqual(["pr", "list"]);
    expect(found(`echo "it's" '$(no)' "$(gh repo view)"`)).toEqual(["repo", "view"]);
    expect(found(`x=$(echo ")" && gh issue list)`)).toEqual(["issue", "list"]);
    for (const command of [
      "git push origin main",
      "echo gh pr create",
      "ghq list",
      "echo '$(gh pr view 1)'",
      `echo 'say "$(gh pr view 1)"'`,
      `echo "a" 'b $(gh pr list) c'`,
      "echo 'if gh pr view 1'",
      "if test -f gh; then echo gh; fi",
      "cat gh.md",
      "sh -c 'git status'",
    ]) {
      expect(found(command), command).toBeNull();
    }
    expect(ghArguments("Read", { file_path: `${project}/gh` }, project)).toBeNull();
  });
});
