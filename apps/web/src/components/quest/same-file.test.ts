import { Checkpoint, CheckpointId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { ADA, BUILD, blackFriday, CAMPAIGN, COPY, checkpoint, QUILL, tree } from "../../test/quests.ts";
import { roomRows } from "./control-room.ts";
import { taskDetail } from "./work-model.ts";

// Issue #570: a finding the hub records when two Tasks change the same file sits on the Task that
// changed it last and names the other, and both Tasks show it.

const sameFile = new Checkpoint({
  id: CheckpointId.make("overlap"),
  taskId: BUILD,
  attemptId: null,
  source: "automatic",
  kind: "finding",
  milestoneId: null,
  summary: "Ada changed web/badge.png in /shop, which Quill's Task copy also changed and is still working on.",
  aboutTaskId: COPY,
  createdAt: "2026-11-01T10:00:09.000Z",
  revision: 9,
});

/** The Black Friday Quest with these checkpoints. */
const withCheckpoints = (...checkpoints: ReadonlyArray<Checkpoint>) => tree({ ...blackFriday(), checkpoints });

describe("A hub finding on two Tasks changing the same file", () => {
  it("tags both members' rows in the Quest tab with the other hob, and no one else's", () => {
    const rows = roomRows(withCheckpoints(sameFile));
    const byTask = new Map(rows.map((row) => [row.task.id, row.sameFileAs]));
    expect(byTask.get(BUILD)).toEqual([QUILL]);
    expect(byTask.get(COPY)).toEqual([ADA]);
    expect(byTask.get(CAMPAIGN)).toEqual([]);
  });

  it("shows in both Tasks' drawers, while the other automatic checkpoints still only repeat the state", () => {
    const read = withCheckpoints(checkpoint(COPY, "started", "Started", 4), sameFile);
    const copy = read.tasks.find((each) => each.id === COPY);
    const build = read.tasks.find((each) => each.id === BUILD);
    if (copy === undefined || build === undefined) throw new Error("missing Task");
    expect(taskDetail(read, copy).checkpoints.map((each) => each.kind)).toEqual(["started", "finding"]);
    expect(taskDetail(read, build).checkpoints.map((each) => each.id)).toEqual(["overlap"]);
  });
});
