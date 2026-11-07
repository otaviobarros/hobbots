import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeKind, TaskTree } from "@hobbots/domain";
import { afterEach, describe, expect, it } from "vitest";
import { hub, isLive, ownedBy, PIP, partyHub, send, treeWhen } from "./party-hub.ts";

// A Quest read done while the page its member delivered was gone: the member wrote it in its
// turn's own temporary folder ($TMPDIR), which the hub removes when the turn ends, and attached that
// path to complete_task, which took it. complete_task now completes a Task only with file artifacts
// that are regular files inside its folders, and tells the hob where to put them otherwise. The hub
// checks the call, so every runtime is held to it.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

/** Pip's Task once it ended and no turn runs on it. */
const ended = (tree: TaskTree) => {
  const pip = ownedBy(tree, PIP);
  return (
    pip !== undefined &&
    (pip.state === "completed" || pip.state === "blocked") &&
    !tree.attempts.some((each) => each.taskId === pip.id && isLive(each.state))
  );
};

/** Frodo hands Pip a Task whose brief plays `lines` in Pip's turn, and waits for it. */
const delegated = (lines: ReadonlyArray<string>) =>
  send([
    "Explain the Skills feature",
    hub("delegate_task", { key: "page", hob: "Pip", brief: ["Write the Skills explainer", ...lines].join("\n") }),
    hub("wait_for", { key: "wait", tasks: ["$page.task_id"] }),
  ]);

const file = (value: string) => ({ kind: "file", label: "skills-feature-explained.html", value });

const RUNTIMES: ReadonlyArray<RuntimeKind> = ["claude-code", "codex"];

describe.each(RUNTIMES)("a Task that returns a file, on %s", (runtime) => {
  // covers OR-004, EX-002
  it("[TC-OR-657] is refused while the file is outside its folders, and completes once the file is saved inside them", async () => {
    const party = partyHub({ members: runtime, files: true });
    dispose = party.dispose;
    const { run, answers, project, temp } = party;
    // The turn's own temporary folder, outside the hob's folders, as $TMPDIR is.
    const scratch = join(temp, "hb-turn");
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, "skills-feature-explained.html"), "<!doctype html>\n");
    writeFileSync(join(project, "skills-feature-explained.html"), "<!doctype html>\n");
    await run(
      delegated([
        hub("complete_task", {
          key: "in-temp",
          summary: "The page is in my temporary folder",
          artifacts: [file(join(scratch, "skills-feature-explained.html"))],
        }),
        hub("complete_task", {
          key: "in-folder",
          summary: "The page is saved",
          artifacts: [file(join(project, "skills-feature-explained.html"))],
        }),
      ]),
    );
    const done = await run(treeWhen(ended));
    const pip = ownedBy(done, PIP);
    expect(answers.get("in-temp")).toContain("Refused (artifact-unreachable)");
    expect(answers.get("in-temp")).toContain(`outside this Task's folders`);
    expect(answers.get("in-temp")).toContain(`Save each file inside one of your folders (${project})`);
    expect(pip?.state).toBe("completed");
    expect(pip?.result?.summary).toBe("The page is saved");
    // Only the file someone can open is on the Task.
    expect(done.artifacts.filter((each) => each.taskId === pip?.id).map((each) => each.value)).toEqual([
      join(project, "skills-feature-explained.html"),
    ]);
  }, 30_000);

  // covers OR-004, EX-002
  it("[TC-OR-658] is refused when the file it names inside its folders does not exist", async () => {
    const party = partyHub({ members: runtime, files: true });
    dispose = party.dispose;
    const { run, answers, project } = party;
    await run(
      delegated([
        hub("complete_task", {
          key: "missing",
          summary: "The page is saved",
          artifacts: [file(join(project, "never-written.html"))],
        }),
      ]),
    );
    const done = await run(treeWhen(ended));
    const pip = ownedBy(done, PIP);
    expect(answers.get("missing")).toContain("Refused (artifact-unreachable)");
    expect(answers.get("missing")).toContain(`is not a file at ${join(project, "never-written.html")}`);
    // Whatever the Task ended with, it never carries the file that is not there.
    expect(done.artifacts.filter((each) => each.taskId === pip?.id)).toEqual([]);
  }, 30_000);

  // covers OR-004
  it("[TC-OR-659] completes with links and text as before, which name no file", async () => {
    const party = partyHub({ members: runtime, files: true });
    dispose = party.dispose;
    const { run, answers } = party;
    await run(
      delegated([
        hub("complete_task", {
          key: "text",
          summary: "The explainer, as text",
          artifacts: [
            { kind: "text", label: "Explainer", value: "<!doctype html>" },
            { kind: "link", label: "ADR 029", value: "https://hobbots.ai/docs/skills" },
          ],
        }),
      ]),
    );
    const done = await run(treeWhen(ended));
    expect(answers.get("text")).toContain("is complete");
    expect(ownedBy(done, PIP)?.state).toBe("completed");
  }, 30_000);
});
