import { waitToFind } from "@hobbots/domain/testing";
import { PolicyEngine } from "@hobbots/permissions";
import { folderAccessFor, READ_ONLY_SANDBOX_NOTE, readOnlyCommands, toolRequests, toolTurn } from "@hobbots/runtimes";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  hub,
  memberTask,
  PIP,
  promptsTo,
  ROOK,
  send,
  sharedDatabase,
  startHub,
  taskOf,
  treeWhen,
} from "./dependency-hub.ts";

// Issue #661: a lead gave its member Local Git and Run commands with Edit files Never, meaning "commit,
// but touch no file", and the member had no tool its brief needed. Since #1344 Edit files Never gives
// read-only commands: the member runs `git log` and tests but cannot write a file or commit. Edit files
// Ask still closes commands, since a command would write without asking, so the hub refuses that
// delegation and tells the lead what the member will have; a member given Local Git with its file
// tools commits.

const COMMIT = "git commit -m 'Add the app'";

describe("a delegation whose authority leaves the member no tool for its brief", () => {
  // covers OR-002, PE-005
  it("[TC-OR-430] is refused when it gives Local Git and Run commands but has Edit files ask, and no Task is made", async () => {
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
              "edit-files": "ask",
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
    expect(answer).toContain(
      "commands, Git's included, need read-files allow and edit-files allow, or edit-files deny for read-only commands",
    );
    expect(answer).toContain("Pip would have edit-files ask");
    expect(answer).toContain(
      "Give edit-files allow (or edit-files deny, for read-only commands), or give run-commands and local-git deny",
    );
    expect(answer).toContain("Pip will have: file reads, file edits, git_init; no commands.");
  }, 30_000);

  // covers OR-002, PE-005
  it("[TC-OR-1423] gives a member with Edit files Never read-only commands: it runs git log, and cannot write a file", async () => {
    const { run, answers, requests } = await startHub(await sharedDatabase());
    await run(
      send([
        "Review the app",
        hub("delegate_task", {
          key: "review",
          hob: "Rook",
          brief: "Review the last commit",
          authority: {
            decisions: { "edit-files": "deny", "delete-files": "deny", "local-git": "allow", "run-commands": "allow" },
          },
        }),
      ]),
    );
    const rook = taskOf(await run(treeWhen((each) => memberTask(each, ROOK) !== undefined)), ROOK);
    const answer = await run(waitToFind("the answer to the delegation", () => answers.get("review")));
    // Named as read-only, with neither a refusal nor a warning.
    expect(answer).toContain("Rook will have: file reads, read-only commands; no file edits, no git_init.");
    expect(answer).toContain("Rook's commands are read-only");
    expect(answer).not.toContain("could not use");
    expect(answer).not.toContain("though it has them");

    const request = await run(waitToFind("Rook's first prompt", () => promptsTo(requests, rook)[0]));
    const turn = toolTurn(request.tools, "on");
    if (turn === null) throw new Error("expected Rook's turn to have tools");
    expect(turn.tools).toContain("Bash");
    expect(turn.tools).not.toContain("Write");
    expect(turn.tools).not.toContain("Edit");
    // The sandbox closes its folders to every write, .git included, and its note says so.
    expect(folderAccessFor(turn.context)).toEqual({ read: true, write: false });
    expect(readOnlyCommands(turn.context)).toBe(true);
    expect(READ_ONLY_SANDBOX_NOTE).toContain("read-only");
    const cwd = turn.folders[0] as string;
    const decide = (tool: string, input: Record<string, unknown>) =>
      Effect.runPromise(
        Effect.flatMap(Effect.service(PolicyEngine), (engine) =>
          Effect.forEach(toolRequests(tool, input, cwd) ?? [], (each) => engine.decide(turn.context, each)),
        ).pipe(Effect.provide(PolicyEngine.node)),
      );
    const log = await decide("Bash", { command: "git log --oneline -5" });
    expect(log.map((each) => [each.operation, each.decision])).toEqual([["local-git", "allow"]]);
    const write = await decide("Write", { file_path: `${cwd}/notes.md`, content: "Reviewed" });
    expect(write.map((each) => [each.operation, each.decision])).toEqual([["edit-files", "deny"]]);
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
    const rook = taskOf(await run(treeWhen((each) => memberTask(each, ROOK) !== undefined)), ROOK);
    // The Task shows in the tree before the call that made it ends, so the answer is waited for.
    const answer = await run(waitToFind("the answer to the delegation", () => answers.get("commit")));
    expect(answer).toContain("Rook will have: file reads, file edits, commands, git_init.");

    const request = await run(waitToFind("Rook's first prompt", () => promptsTo(requests, rook)[0]));
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

  // covers OR-002, PE-005
  it("[TC-OR-433] tells the lead a member with no folder in common will have no tools, and its turn is chat-only", async () => {
    const { run, answers, requests } = await startHub(await sharedDatabase());
    await run(
      send([
        "Commit the app",
        hub("delegate_task", {
          key: "commit",
          hob: "Rook",
          brief: "Make the local commit",
          authority: { folders: [] },
        }),
      ]),
    );
    const rook = taskOf(await run(treeWhen((each) => memberTask(each, ROOK) !== undefined)), ROOK);
    const answer = await run(waitToFind("the answer to the delegation", () => answers.get("commit")));
    expect(answer).toContain(
      "Rook will have no tools: no folder is both yours and its own, so its turns are chat-only.",
    );
    expect(answer).not.toContain("will have: ");

    const request = await run(waitToFind("Rook's first prompt", () => promptsTo(requests, rook)[0]));
    expect(toolTurn(request.tools, "on")).toBeNull();
  }, 30_000);
});
