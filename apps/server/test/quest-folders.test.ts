import type { AttemptId, TaskTree } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { endedActivity, hub, say, setUp, treeWhen } from "./workbench-hub.ts";

// Issue #670: a lead's own turns scanned every folder it has, the Hobbots source among them, though
// its Quest worked in one. Once its Quest says where the work is, its turns on it scan only there,
// on SQLite or PostgreSQL (TestDatabase).

const write = (path: string, text: string) => `fake:write ${path} ${JSON.stringify(text)}`;

/**
 * The folders each of the Task's Attempts scanned, start and end alike, oldest Attempt first. Each
 * Attempt's are sorted: scans started in the same millisecond are read back in either order.
 */
const scanned = async (run: ReturnType<typeof setUp>["run"], tree: TaskTree) => {
  const folders = [];
  for (const attempt of tree.attempts) {
    const activity = await run(endedActivity(attempt.id as AttemptId));
    folders.push([...new Set(activity.scans.map((scan) => scan.folder))].sort());
  }
  return folders;
};

describe("a lead's turns on its Quest", () => {
  // covers UX-002, ADR 018, ADR 023
  it("[TC-OR-480] scan only the folders start_quest names, from the turn that starts it on", async () => {
    const { run, folder, others } = setUp({ "README.md": "# Site\n" }, ["hobbots", "other"]);
    await run(
      say(
        [
          "Build the site",
          hub("start_quest", { key: "quest", goal: "Build the site", folders: [folder] }),
          write("index.html", "<h1>Site</h1>\n"),
        ].join("\n"),
      ),
    );
    const tree = await run(treeWhen((each) => each.attempts.length === 1));
    expect(tree.quests[0]?.limits.folders).toEqual([folder]);
    // The next turn on the Task knows its folders from the start.
    await run(say(["Add a page", write("about.html", "<h1>About</h1>\n")].join("\n")));
    const activity = await run(endedActivity(tree.attempts[0]?.id as AttemptId, 2));

    expect(await scanned(run, tree)).toEqual([[folder]]);
    expect(activity.scans.filter((scan) => scan.phase === "start")).toHaveLength(2);
    expect(activity.changes.map(({ path }) => path).sort()).toEqual(["about.html", "index.html"]);
    expect(others).toHaveLength(2);
  }, 30_000);

  // covers UX-002, ADR 018, ADR 023
  it("[TC-OR-481] scan the folders the goal names when start_quest names none, and all of them when nothing does", async () => {
    const named = setUp({}, ["hobbots"]);
    await named.run(
      say(["Build it", hub("start_quest", { key: "quest", goal: `Build the site in ${named.folder}` })].join("\n")),
    );
    const narrowed = await named.run(treeWhen((tree) => tree.attempts.length === 1));
    expect(await scanned(named.run, narrowed)).toEqual([[named.folder]]);

    const unnamed = setUp({}, ["hobbots"]);
    await unnamed.run(say(["Build it", hub("start_quest", { key: "quest", goal: "Build the site" })].join("\n")));
    const whole = await unnamed.run(treeWhen((tree) => tree.attempts.length === 1));
    expect(whole.quests[0]?.limits.folders).toBeUndefined();
    expect(await scanned(unnamed.run, whole)).toEqual([[unnamed.folder, ...unnamed.others].sort()]);
  }, 30_000);
});
