import {
  AttemptActivity,
  FileChange,
  FileChangeId,
  Quest,
  TaskFile,
  TaskFileId,
  TreeActivity,
  TreeAttempt,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { ALDRIC, attempt, CAMPAIGN, COPY, quest, tree } from "../../test/quests.ts";
import { questRoots, shownDir, shownPath } from "./shown-paths.ts";

const AT = "2026-11-01T10:00:00.000Z";
const done = attempt(COPY, "completed");

const change = (folder: string, path: string) =>
  new FileChange({
    id: FileChangeId.make(`f-${folder}-${path}`),
    attemptId: done.id,
    taskId: COPY,
    folder,
    path,
    kind: "added",
    movedFrom: null,
    before: null,
    after: { hash: "h", size: 1, kind: "text", contentId: null, notKept: null },
    sharedWith: [],
    settled: true,
    recordedAt: AT,
  });

const file = (folder: string, path: string) =>
  new TaskFile({
    id: TaskFileId.make(`t-${folder}-${path}`),
    folder,
    path,
    location: `${folder}/${path}`,
    label: null,
    origin: "added",
    preview: "text",
    size: 1,
    now: "same",
    hash: null,
    notServed: null,
  });

const read = (changes: ReadonlyArray<FileChange>, files: ReadonlyArray<TaskFile> = []) =>
  new TreeActivity({
    taskId: CAMPAIGN,
    attempts: [
      new TreeAttempt({
        ownerId: ALDRIC,
        files: [...files],
        activity: new AttemptActivity({
          attempt: done,
          commands: [],
          changes: [...changes],
          scans: [],
          artifacts: [],
          sharedWithHobs: [],
          detailsClearedAt: null,
        }),
      }),
    ],
  });

describe("the paths the Workbench shows", () => {
  it("reads a member's file in a subfolder from its lead's folder, as the lead's own change reads it (#643)", () => {
    const roots = questRoots(
      tree(),
      read([change("/work/shop", "test/docs/NOTES.md"), change("/work/shop/test", "docs/NOTES.md")]),
    );
    expect(roots).toEqual(["/work/shop"]);
    expect(shownPath(roots, "/work/shop", "test/docs/NOTES.md")).toEqual({
      root: "/work/shop",
      path: "test/docs/NOTES.md",
    });
    expect(shownPath(roots, "/work/shop/test", "docs/NOTES.md")).toEqual({
      root: "/work/shop",
      path: "test/docs/NOTES.md",
    });
  });

  it("counts the Quest's own folders and the files a Task touched, so a path reads the same whichever lane is lit", () => {
    const working = new Quest({ ...quest(), limits: { ...quest().limits, folders: ["/work/shop/"] } });
    const roots = questRoots(
      tree({ quests: [working] }),
      read([change("/work/shop/site", "index.html")], [file("/work/blog", "post.md")]),
    );
    expect(roots).toEqual(["/work/shop/", "/work/blog"]);
    expect(shownPath(roots, "/work/shop/site", "index.html").path).toBe("site/index.html");
  });

  it("names the folder a path is in when the list holds more than one root", () => {
    expect(shownDir({ root: "/work/shop", path: "test/docs/NOTES.md" }, false)).toBe("test/docs/");
    expect(shownDir({ root: "/work/shop", path: "NOTES.md" }, false)).toBe("");
    expect(shownDir({ root: "/work/shop", path: "src/app.ts" }, true)).toBe("shop/src/");
    expect(shownDir({ root: "/work/shop/", path: "app.ts" }, true)).toBe("shop/");
  });

  it("reads a folder no root holds from itself", () => {
    expect(shownPath([], "C:\\work\\shop", "app.ts")).toEqual({ root: "C:\\work\\shop", path: "app.ts" });
    expect(shownPath(["C:\\work"], "C:\\work\\shop", "app.ts")).toEqual({ root: "C:\\work", path: "shop/app.ts" });
  });
});
