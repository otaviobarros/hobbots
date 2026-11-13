import { describe, expect, it } from "vitest";
import { ghArguments } from "../src/tool-calls.ts";

// Issue #1349: no credential enters a hob's sandbox, so `gh` cannot sign in there. The hub refuses it
// before it runs, wherever the command line spells it, so it must find every `gh` the line runs.

const project = "/work/ledger";
const found = (command: string) => ghArguments("Bash", { command }, project, "/Users/frodo");

describe("the gh a command line runs (#1349)", () => {
  // covers PE-005, SEC-002
  it("[TC-RT-1349-01] finds gh behind wrappers, after other commands, inside eval and sh -c, and nothing for any other command", () => {
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
    for (const command of [
      "git push origin main",
      "echo gh pr create",
      "ghq list",
      "cat gh.md",
      "sh -c 'git status'",
    ]) {
      expect(found(command), command).toBeNull();
    }
    expect(ghArguments("Read", { file_path: `${project}/gh` }, project)).toBeNull();
  });
});
