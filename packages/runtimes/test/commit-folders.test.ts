import { describe, expect, it } from "vitest";
import { commitFolders } from "../src/tool-calls.ts";

// Issue #742: Frodo, the lead, committed its member Nettle's work from its own session. The hub
// holds such a commit (TC-OR-742-02 for every runtime), so it must find every repository a command
// line commits in, wherever the line moves to first.

const project = "/work/ledger";
const other = "/work/notes";
const folders = (command: string) => commitFolders("Bash", { command }, project, "/Users/frodo");

describe("the repositories a command line commits in (#742)", () => {
  // covers PE-005, OR-004
  it("[TC-RT-742-01] finds each one after cd, git -C, wrappers that move it, eval and sh -c, and nothing for any other command", () => {
    expect(folders("git commit -m 'chore: pocket ledger v0.1'")).toEqual([project]);
    expect(folders("git add -A && git commit -am x")).toEqual([project]);
    expect(folders(`cd ${other} && git commit -m x`)).toEqual([other]);
    expect(folders(`git -C ${other} commit -m x`)).toEqual([other]);
    expect(folders("env GIT_PAGER=cat git commit -m x")).toEqual([project]);
    expect(folders(`sh -c 'cd ${other} && git commit -m x'`)).toEqual([other]);
    expect(folders("eval git commit -m x")).toEqual([project]);
    // A wrapper that moves the command it runs moves its commit, also into another shell.
    expect(folders(`env -C ${other} git commit -m x`)).toEqual([other]);
    expect(folders(`env --chdir=${other} git commit -m x`)).toEqual([other]);
    expect(folders(`env -C ${other} sh -c 'git commit -m x'`)).toEqual([other]);
    // A relative folder is kept as the line spells it; which repository it is in is the hub's to find.
    expect(folders("git -C ../ledger commit -m x")).toEqual(["/work/ledger/../ledger"]);
    expect(folders(`git commit -m one && cd ${other} && git commit -m two`)).toEqual([project, other]);
    for (const command of ["git status", "git log -1", "git add .", "git push origin main", "echo git commit"]) {
      expect(folders(command), command).toEqual([]);
    }
    expect(commitFolders("Read", { file_path: `${project}/a.ts` }, project)).toEqual([]);
  });
});
