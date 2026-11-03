import { Delegation, TaskId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { ALDRIC, BUILD, blackFriday, CAMPAIGN, COPY, delegation, task, tree } from "../../test/quests.ts";
import { folderName, memberFolders } from "./member-folders.ts";
import { taskDetail } from "./work-model.ts";

// Issue #582: the Task drawer and the Workbench header show the folders a member works in.

const STEP = TaskId.make("copy-step");

/** Black Friday with Quill's copy kept to the shop's copy folder, and a step under it. */
const narrowed = () => {
  const read = blackFriday();
  const copy = delegation(read.tasks[1]?.ownerId ?? ALDRIC, COPY, "Draft the landing copy");
  return tree({
    ...read,
    tasks: [...read.tasks, task(STEP, { ownerId: copy.memberId, parentId: COPY, brief: "Write the headlines" })],
    delegations: [
      new Delegation({ ...copy, authority: { overrides: {}, folders: ["/Users/you/shop/copy"] } }),
      ...read.delegations.filter((each) => each.childTaskId !== COPY),
    ],
  });
};

const taskOf = (read: ReturnType<typeof narrowed>, id: TaskId) => {
  const found = read.tasks.find((each) => each.id === id);
  if (found === undefined) throw new Error(`missing Task ${id}`);
  return found;
};

describe("The folders a member works in", () => {
  it("are those its Delegation gives, and the nearest Delegation's for a step under it", () => {
    const read = narrowed();
    expect(memberFolders(read, taskOf(read, COPY))).toEqual(["/Users/you/shop/copy"]);
    expect(memberFolders(read, taskOf(read, STEP))).toEqual(["/Users/you/shop/copy"]);
    expect(taskDetail(read, taskOf(read, COPY)).folders).toEqual(["/Users/you/shop/copy"]);
  });

  it("are not shown for work no lead gave, or a Delegation that left its lead's folders as they were", () => {
    const read = narrowed();
    expect(memberFolders(read, taskOf(read, CAMPAIGN))).toBeNull();
    expect(memberFolders(read, taskOf(read, BUILD))).toBeNull();
  });

  it("show by their last name", () => {
    expect(folderName("/Users/you/shop/copy")).toBe("copy");
    expect(folderName("C:\\Users\\you\\shop\\")).toBe("shop");
    expect(folderName("/")).toBe("/");
  });
});
