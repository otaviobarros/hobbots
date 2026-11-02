import { describe, expect, it } from "vitest";
import { type FileCandidate, SERVED_FILE_BYTES, TaskFileId, taskFile } from "../src/index.ts";

const candidate = (size: number): FileCandidate => ({
  id: TaskFileId.make("c-export.bin"),
  folder: "/work",
  path: "export.bin",
  label: null,
  origin: "added",
  left: { hash: "left", size },
});

describe("how a Task's file is now", () => {
  const big = SERVED_FILE_BYTES + 1;

  // A file too large to hash is never taken as the same as what the Task left.
  it("[#388] says a file too large to read was not checked when its size is what the Task left", () => {
    expect(taskFile(candidate(big), { size: big, hash: null }).now).toBe("unchecked");
  });

  it("[#388] says a file too large to read changed when its size did", () => {
    expect(taskFile(candidate(big), { size: big + 1, hash: null }).now).toBe("changed");
  });

  it("[#388] compares a file it could read by its hash", () => {
    expect(taskFile(candidate(6), { size: 6, hash: "left" }).now).toBe("same");
    expect(taskFile(candidate(6), { size: 6, hash: "other" }).now).toBe("changed");
    expect(taskFile(candidate(6), null).now).toBe("gone");
  });
});
