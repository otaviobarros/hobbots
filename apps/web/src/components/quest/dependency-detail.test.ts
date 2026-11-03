import { ArtifactId, ArtifactRef, AttemptId, HandOff, Task, type TaskId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { ADA, BUILD, CAMPAIGN, COPY, QUILL, task, tree } from "../../test/quests.ts";
import { rowStatus, taskDetail, waitsOnOf } from "./work-model.ts";

// Issues #564 and #567: a queued Task that comes after another waits on it, and once that one
// completes, the drawer's "Handed to it" shows what it returned, its result and its artifacts,
// beside anything its lead handed on.

const at = "2026-11-03T00:00:00.000Z";

const done = (id: TaskId, summary: string) =>
  new Task({
    ...task(id, { ownerId: QUILL, brief: "Draft the landing copy" }),
    state: "completed",
    result: { summary, attemptId: AttemptId.make(`a-${id}`) },
  });

const artifact = (id: string, taskId: TaskId, label: string) =>
  new ArtifactRef({
    id: ArtifactId.make(id),
    taskId,
    attemptId: AttemptId.make(`a-${taskId}`),
    kind: "text",
    label,
    value: `${label} text`,
    createdAt: at,
  });

describe("a dependent Task in the Quest views", () => {
  // covers UX-002, OR-003
  it("[TC-OR-213] reads Waiting while queued on an unfinished Task, and Running once that one completed", () => {
    const queued = task(BUILD, { ownerId: ADA, state: "queued", dependsOn: [COPY] });
    const running = tree({ tasks: [task(CAMPAIGN), task(COPY, { ownerId: QUILL }), queued] });
    expect(rowStatus(running, queued)).toBe("waiting");
    const after = tree({ tasks: [task(CAMPAIGN), done(COPY, "Playful copy"), queued] });
    expect(rowStatus(after, queued)).toBe("running");
  });

  // covers UX-002, OR-002
  it("[TC-OR-404] reads Blocked while a Task it comes after is blocked or failed, and still names its hob", () => {
    const queued = task(BUILD, { ownerId: ADA, state: "queued", dependsOn: [COPY] });
    for (const state of ["blocked", "failed"] as const) {
      const held = tree({ tasks: [task(CAMPAIGN), task(COPY, { ownerId: QUILL, state }), queued] });
      expect(rowStatus(held, queued)).toBe("blocked");
      expect(waitsOnOf(held, queued)).toEqual([QUILL]);
    }
  });

  // covers UX-002, OR-003
  it("[TC-OR-214] shows what the Tasks it comes after returned under Handed to it, beside what was handed to it", () => {
    const build = task(BUILD, { ownerId: ADA, state: "active", dependsOn: [COPY] });
    const read = tree({
      tasks: [task(CAMPAIGN), done(COPY, "Playful copy"), build],
      artifacts: [artifact("copy-text", COPY, "Landing copy"), artifact("brief", CAMPAIGN, "Brand brief")],
      handOffs: [new HandOff({ artifactId: ArtifactId.make("brief"), toTaskId: BUILD, createdAt: at })],
    });
    const detail = taskDetail(read, build);
    expect(detail.returned.map((each) => [each.id, each.result?.summary])).toEqual([[COPY, "Playful copy"]]);
    expect(detail.given.map((each) => each.label).sort()).toEqual(["Brand brief", "Landing copy"]);

    // Before it completes, nothing of it shows yet.
    const early = tree({ tasks: [task(CAMPAIGN), task(COPY, { ownerId: QUILL }), build] });
    expect(taskDetail(early, build).returned).toEqual([]);
    expect(taskDetail(early, build).given).toEqual([]);
  });
});

describe("a Task given another Task's artifact by hand-off", () => {
  // covers UX-002, OR-005
  it("[TC-OR-224] shows that Task's result once under Handed to it, with only the artifact handed on", () => {
    const build = task(BUILD, { ownerId: ADA, state: "active" });
    const read = tree({
      tasks: [task(CAMPAIGN), done(COPY, "Playful copy"), build],
      artifacts: [artifact("copy-text", COPY, "Landing copy"), artifact("copy-notes", COPY, "Copy notes")],
      handOffs: [
        new HandOff({ artifactId: ArtifactId.make("copy-text"), toTaskId: BUILD, createdAt: at }),
        new HandOff({ artifactId: ArtifactId.make("copy-text"), toTaskId: BUILD, createdAt: at }),
      ],
    });
    const detail = taskDetail(read, build);
    expect(detail.returned.map((each) => [each.id, each.result?.summary])).toEqual([[COPY, "Playful copy"]]);
    expect(detail.given.map((each) => each.label)).toEqual(["Landing copy"]);

    // Also a Task it comes after: listed once, with all of its artifacts.
    const both = new Task({ ...build, dependsOn: [COPY] });
    const again = tree({ ...read, tasks: [task(CAMPAIGN), done(COPY, "Playful copy"), both] });
    expect(taskDetail(again, both).returned.map((each) => each.id)).toEqual([COPY]);
    expect(
      taskDetail(again, both)
        .given.map((each) => each.label)
        .sort(),
    ).toEqual(["Copy notes", "Landing copy"]);
  });
});
