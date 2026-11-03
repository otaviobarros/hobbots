import { PolicyEngine } from "@hobbots/permissions";
import { toolRequests, toolTurn } from "@hobbots/runtimes";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { hub, memberTask, PIP, ROOK, retry, send, sharedDatabase, startHub, treeWhen } from "./dependency-hub.ts";

// Issue #661: a lead gave its member Local Git and Run commands with Edit files Never, meaning "commit,
// but touch no file". Commands run only through Bash, which a hob has only when Read files and Edit
// files are both Allow, so the member had no tool its brief needed. The hub refuses that delegation
// and tells the lead what the member will have; a member given Local Git with its file tools commits.

const COMMIT = "git commit -m 'Add the app'";

describe("a delegation whose authority leaves the member no tool for its brief", () => {
  // covers OR-002, PE-005
  it("[TC-OR-430] is refused when it gives Local Git and Run commands but denies Edit files, and no Task is made", async () => {
    const { run, answers } = await startHub(await sharedDatabase());
    await run(
      send([
        "Commit the app",
        hub("delegate_task", {
          key: "commit",
          hob: "Pip",
          brief: "Make the local commit",
          authority: {
            decisions: {
              "edit-files": "deny",
              "delete-files": "deny",
              "local-git": "allow",
              "run-commands": "allow",
            },
          },
        }),
        hub("delegate_task", { key: "after", hob: "Rook", brief: "Write the notes" }),
      ]),
    );
    const tree = await run(treeWhen((each) => memberTask(each, ROOK) !== undefined));
    expect(memberTask(tree, PIP)).toBeUndefined();
    const answer = answers.get("commit");
    expect(answer).toContain("Pip could not use run-commands or local-git");
    expect(answer).toContain("commands, Git's included, need read-files and edit-files both allow");
    expect(answer).toContain("Pip would have edit-files deny");
    expect(answer).toContain("Give edit-files allow, or give run-commands and local-git deny");
    expect(answer).toContain("Pip will have: file reads; no file edits, no commands, no git_init.");
  }, 30_000);

  // covers OR-002, PE-005
  it("[TC-OR-431] tells the lead what a member given Local Git will have, and that member can commit", async () => {
    const { run, answers, requests } = await startHub(await sharedDatabase());
    await run(
      send([
        "Commit the app",
        hub("delegate_task", {
          key: "commit",
          hob: "Rook",
          brief: "Make the local commit",
          authority: { decisions: { "delete-files": "deny", "local-git": "allow", "run-commands": "deny" } },
        }),
      ]),
    );
    await run(treeWhen((each) => memberTask(each, ROOK) !== undefined));
    expect(answers.get("commit")).toContain("Rook will have: file reads, file edits, commands, git_init.");

    const request = await run(
      retry(
        Effect.suspend(() => {
          const found = requests.find((each) => each.prompt.includes("Make the local commit"));
          return found === undefined ? Effect.fail("not yet") : Effect.succeed(found);
        }),
      ),
    );
    const turn = toolTurn(request.tools, "on");
    expect(turn?.tools).toContain("Bash");
    const cwd = turn?.folders[0] as string;
    const verdicts = await Effect.runPromise(
      Effect.flatMap(Effect.service(PolicyEngine), (engine) =>
        Effect.forEach(toolRequests("Bash", { command: COMMIT }, cwd) ?? [], (each) =>
          engine.decide(turn?.context as never, each),
        ),
      ).pipe(Effect.provide(PolicyEngine.node)),
    );
    expect(verdicts.map((each) => [each.operation, each.decision])).toEqual([["local-git", "allow"]]);
  }, 30_000);
});
