import { describe, expect, it } from "vitest";
import {
  AgentId,
  type Artifact,
  ArtifactId,
  ArtifactRef,
  type ArtifactSighting,
  AttemptId,
  artifactSightings,
  ChapterId,
  FileChange,
  FileChangeId,
  fileArtifactKind,
  hobActor,
  linkArtifactKind,
  Message,
  MessageId,
  placedFromTask,
  RegisteredArtifactId,
  registeredArtifact,
  TaskId,
  ThreadId,
} from "../src/index.ts";

const at = "2026-11-12T00:00:00.000Z";
const TASK = TaskId.make("task-1");
const ATTEMPT = AttemptId.make("attempt-1");
const THREAD = ThreadId.make("thread-1");
const CHAPTER = ChapterId.make("chapter-1");
const HOB = AgentId.make("hob-1");

const ref = (kind: ArtifactRef["kind"], value: string, label = "Result") =>
  new ArtifactRef({
    id: ArtifactId.make(`ref-${kind}`),
    taskId: TASK,
    attemptId: ATTEMPT,
    kind,
    label,
    value,
    createdAt: at,
  });

const change = (path: string, fields: Partial<FileChange> = {}) =>
  new FileChange({
    id: FileChangeId.make(`change-${path}`),
    attemptId: ATTEMPT,
    taskId: TASK,
    folder: "/work/app/",
    path,
    kind: "edited",
    movedFrom: null,
    before: null,
    after: { hash: "h", size: 1, kind: "text", contentId: null, notKept: null },
    sharedWith: [],
    settled: true,
    recordedAt: at,
    ...fields,
  });

const reply = (fields: Partial<Message> = {}) =>
  new Message({
    id: MessageId.make("reply-1"),
    threadId: THREAD,
    chapterId: CHAPTER,
    actor: hobActor(HOB),
    role: "assistant",
    content: "Done.",
    status: "complete",
    error: null,
    configVersion: 1 as Message["configVersion"],
    createdAt: at,
    steps: [
      {
        id: "s1",
        kind: "tool",
        label: "Writing launch.md",
        state: "done",
        call: { tool: "Write", operation: "edit-files", targets: ["/work/app/launch.md"] },
      },
      {
        id: "s2",
        kind: "tool",
        label: "Writing draft.html",
        state: "failed",
        call: { tool: "Write", operation: "edit-files", targets: ["/work/app/draft.html"] },
      },
      {
        id: "s3",
        kind: "tool",
        label: "Reading notes.md",
        state: "done",
        call: { tool: "Read", operation: "read-files", targets: ["/work/app/notes.md"] },
      },
    ],
    ...fields,
  });

describe("artifact kinds", () => {
  it("tells code, docs, pages, images, emails and other files apart by name", () => {
    expect(fileArtifactKind("/a/src/main.ts")).toBe("code");
    expect(fileArtifactKind("/a/README.md")).toBe("doc");
    expect(fileArtifactKind("/a/site/index.html")).toBe("page");
    expect(fileArtifactKind("/a/logo.PNG")).toBe("image");
    expect(fileArtifactKind("/a/hello.eml")).toBe("email");
    expect(fileArtifactKind("/a/data.bin")).toBe("file");
    expect(fileArtifactKind("/a/Makefile")).toBe("file");
  });

  it("tells a pull request from any other link", () => {
    expect(linkArtifactKind("https://github.com/me/app/pull/12")).toBe("pr");
    expect(linkArtifactKind("https://github.com/me/app/pull/12/files")).toBe("pr");
    expect(linkArtifactKind("https://github.com/me/app/pulls")).toBe("page");
    expect(linkArtifactKind("https://example.com/pull/12")).toBe("page");
  });
});

describe("artifactSightings", () => {
  it("reads a completed Task's results: a file by its path, a link by its URL, a text by its id", () => {
    const sightings = artifactSightings([
      {
        _tag: "TaskCompleted",
        task: undefined as never,
        artifacts: [
          ref("file", "/work/app/launch.md/", "Launch plan"),
          ref("link", "https://github.com/me/app/pull/7"),
          ref("text", "Three headlines", " "),
        ],
      },
    ]);
    expect(sightings.map((s) => [s.locator, s.kind, s.label, s.origin.kind, s.from._tag])).toEqual([
      ["/work/app/launch.md", "doc", "Launch plan", "task-artifact", "Task"],
      ["https://github.com/me/app/pull/7", "pr", "Result", "task-artifact", "Task"],
      ["text:ref-text", "doc", null, "task-artifact", "Task"],
    ]);
  });

  it("reads an Attempt's settled changes that left a file, and nothing it deleted or has not settled", () => {
    const sightings = artifactSightings([
      {
        _tag: "FileChangesRecorded",
        attemptId: ATTEMPT,
        taskId: TASK,
        folder: "/work/app/",
        changes: [
          change("src/main.ts"),
          change("old.md", { kind: "deleted", after: null }),
          change("wip.md", { settled: false }),
          change("logo.png", { kind: "added" }),
        ],
        removed: [],
      },
    ]);
    expect(sightings.map((s) => [s.locator, s.kind, s.fallbackTitle, s.origin])).toEqual([
      ["/work/app/src/main.ts", "code", "main.ts", { kind: "attempt", id: ATTEMPT }],
      ["/work/app/logo.png", "image", "logo.png", { kind: "attempt", id: ATTEMPT }],
    ]);
  });

  it("reads the files a finished reply's steps wrote, once each, and nothing from a reply still being written", () => {
    const done = artifactSightings([{ _tag: "MessageUpserted", message: reply() }]);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      locator: "/work/app/launch.md",
      origin: { kind: "message", id: "reply-1" },
      from: { _tag: "Message", threadId: THREAD, chapterId: CHAPTER, actor: hobActor(HOB) },
    });
    expect(artifactSightings([{ _tag: "MessageUpserted", message: reply({ status: "streaming" }) }])).toEqual([]);
    expect(
      artifactSightings([{ _tag: "MessageUpserted", message: reply({ role: "user", actor: null, steps: [] }) }]),
    ).toEqual([]);
  });
});

describe("registeredArtifact", () => {
  const sighting = (origin: ArtifactSighting["origin"], label: string | null = null): ArtifactSighting => ({
    locator: "/work/app/launch.md",
    kind: "doc",
    label,
    fallbackTitle: "launch.md",
    origin,
    from: { _tag: "Task", taskId: TASK },
  });
  const placed = (s: ArtifactSighting) => placedFromTask(s, { threadId: THREAD, chapterId: CHAPTER, ownerId: HOB });
  const id = RegisteredArtifactId.make("artifact-1");

  it("starts an artifact at version 1, named by its record or its file", () => {
    const made = registeredArtifact({
      existing: null,
      placed: placed(sighting({ kind: "attempt", id: "a1" })),
      seen: false,
      id,
      at,
    });
    expect(made).toMatchObject({ latestVersion: 1, title: "launch.md", actor: hobActor(HOB), threadId: THREAD });
  });

  it("moves to the next version for a new record, keeping its name unless the record gives one", () => {
    const first = registeredArtifact({
      existing: null,
      placed: placed(sighting({ kind: "task-artifact", id: "r1" }, "Launch plan")),
      seen: false,
      id,
      at,
    }) as Artifact;
    const second = registeredArtifact({
      existing: first,
      placed: placed(sighting({ kind: "attempt", id: "a2" })),
      seen: false,
      id: RegisteredArtifactId.make("ignored"),
      at: "2026-11-12T01:00:00.000Z",
    });
    expect(second).toMatchObject({
      id,
      latestVersion: 2,
      title: "Launch plan",
      origin: { kind: "attempt", id: "a2" },
      createdAt: at,
      updatedAt: "2026-11-12T01:00:00.000Z",
    });
  });

  it("changes nothing for a record that saw it before", () => {
    const first = registeredArtifact({
      existing: null,
      placed: placed(sighting({ kind: "attempt", id: "a1" })),
      seen: false,
      id,
      at,
    }) as Artifact;
    expect(
      registeredArtifact({
        existing: first,
        placed: placed(sighting({ kind: "attempt", id: "a1" })),
        seen: true,
        id,
        at,
      }),
    ).toBeNull();
  });
});
