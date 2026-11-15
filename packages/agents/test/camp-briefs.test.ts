import {
  AgentId,
  Artifact,
  type ArtifactOrigin,
  ChapterId,
  Decision,
  DecisionId,
  type EventEnvelope,
  OWNER_ACTOR,
  RegisteredArtifactId,
  Task,
  TaskId,
  Channel,
  ChannelId,
} from "@hobbots/domain";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BRIEF_INPUT_MAX, briefInput, briefTriggers, plainBrief } from "../src/camp-briefs.ts";
import { buildPack, CAMP_BRIEF_MAX } from "../src/context-pack.ts";

// Issue #1384 (ADR 037, Records): the brief projector's pure parts. Its plain brief, the rule under
// No AI, is written from the channel's decisions and artifacts and always fits its share of the pack;
// chapter ends and Quest steps are what ask for a new one.

const NOW = "2026-11-12T00:00:00.000Z";
const CHANNEL = ChannelId.make("camp-1");
const CHAPTER = ChapterId.make("chapter-1");
const WREN = AgentId.make("wren");

const camp = (goal: string | null = "Ship the launch emails") =>
  new Channel({ id: CHANNEL, ownerHobId: WREN, title: "Launch", kind: "camp", goal, createdAt: NOW, updatedAt: NOW });

const decision = (id: string, text: string, state: Decision["state"] = "active") =>
  new Decision({
    id: DecisionId.make(id),
    channelId: CHANNEL,
    chapterId: CHAPTER,
    sourceMessageId: null,
    text,
    actor: OWNER_ACTOR,
    state,
    supersededBy: null,
    recordedAt: NOW,
    supersededAt: state === "superseded" ? NOW : null,
  });

const origin: ArtifactOrigin = { kind: "message", id: "reply-1" };
const artifact = (id: string, title: string, latestVersion = 1) =>
  new Artifact({
    id: RegisteredArtifactId.make(id),
    channelId: CHANNEL,
    chapterId: CHAPTER,
    kind: "doc",
    title,
    locator: `/work/${title}`,
    latestVersion,
    origin,
    actor: { kind: "hob", id: WREN },
    createdAt: NOW,
    updatedAt: NOW,
  });

/** A journal entry as the projector reads it; only its payload matters here. */
const entry = (sequence: number, payload: unknown) => ({ sequence, payload }) as unknown as EventEnvelope;

describe("the plain brief", () => {
  it("says the goal, the decisions that hold and what was made, newest first, and nothing without records (#1384)", () => {
    const text = plainBrief(
      camp(),
      [decision("d2", "Emails go out on Wednesdays."), decision("d1", "Emails go out on Tuesdays.", "superseded")],
      [artifact("a1", "launch.md", 2)],
    );
    expect(text).toBe(
      [
        "Goal: Ship the launch emails",
        "Decided:\n- Emails go out on Wednesdays.",
        "Made:\n- launch.md (doc, version 2)",
      ].join("\n\n"),
    );
    // A goal alone is no brief: the camp's header already says it.
    expect(plainBrief(camp(), [decision("d1", "Old.", "superseded")], [])).toBeNull();
  });

  it("on random records, always fits its share of the pack, which then carries it whole (#1384)", () => {
    const words = fc.string({ minLength: 1, maxLength: 400 });
    fc.assert(
      fc.property(
        fc.option(words, { nil: null }),
        fc.array(words, { maxLength: 40 }),
        fc.array(words, { maxLength: 40 }),
        (goal, decided, made) => {
          const text = plainBrief(
            camp(goal),
            decided.map((t, i) => decision(`d${i}`, t)),
            made.map((t, i) => artifact(`a${i}`, t)),
          );
          if (decided.length === 0 && made.length === 0) {
            expect(text).toBeNull();
            return;
          }
          expect((text ?? "").length).toBeLessThanOrEqual(CAMP_BRIEF_MAX);
          const pack = buildPack({
            memoryBrief: null,
            members: null,
            quests: [],
            speaker: (m) => (m.role === "user" ? "Marina (person)" : "You"),
            campBrief: text,
            decisions: [],
            work: { tasks: [], trees: [], questions: [], items: [] },
            carried: [],
            artifacts: [],
            chapters: [],
            live: [],
          });
          expect(pack.report.parts.find((part) => part.part === "camp-brief")?.trimmed ?? null).toBeNull();
          expect(pack.text).toContain(text);
        },
      ),
    );
  });

  it("counts what does not fit instead of dropping it (#1384)", () => {
    const many = Array.from({ length: 60 }, (_, i) => decision(`d${i}`, `Decision number ${i} about the launch plan.`));
    const text = plainBrief(camp(null), many, [artifact("a1", "launch.md")]) ?? "";
    expect(text).toMatch(/- and \d+ more\n\nMade:\n- launch\.md/);
    expect(text.length).toBeLessThanOrEqual(CAMP_BRIEF_MAX);
  });
});

describe("what asks for a brief", () => {
  it("a chapter end, a split or merge, and a Quest's steps; nothing else (#1384)", () => {
    const task = new Task({
      id: TaskId.make("t1"),
      ownerId: WREN,
      parentId: null,
      rootId: TaskId.make("t1"),
      channelId: CHANNEL,
      brief: "Write the emails",
      state: "completed",
      dependsOn: [],
      result: null,
      currentAttemptId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const other = ChannelId.make("chat-1");
    const failedIn = ChannelId.make("camp-2");
    const cancelledIn = ChannelId.make("camp-3");
    const triggers = briefTriggers([
      entry(1, { _tag: "TaskCompleted", task, artifacts: [] }),
      entry(2, {
        _tag: "CheckpointRecorded",
        checkpoint: { taskId: TaskId.make("t9"), kind: "milestone" },
        milestone: { id: "m1" },
      }),
      // A milestone not reached, a summary and a message ask for none.
      entry(3, {
        _tag: "CheckpointRecorded",
        checkpoint: { taskId: TaskId.make("t8"), kind: "progress" },
        milestone: null,
      }),
      entry(4, { _tag: "ChapterSummarized", channelId: other, chapter: {} }),
      entry(5, { _tag: "MessageUpserted", message: { channelId: other } }),
      entry(6, { _tag: "ChapterStarted", channelId: other, chapter: {}, ended: null }),
      // A step or member's Task with no Quest of its own that failed or was cancelled asks for one;
      // one that only started asks for none.
      entry(7, { _tag: "TaskStateChanged", task: { state: "failed", channelId: failedIn }, attempt: null, quest: null }),
      entry(8, {
        _tag: "TaskStateChanged",
        task: { state: "cancelled", channelId: cancelledIn },
        attempt: null,
        quest: null,
      }),
      entry(9, { _tag: "TaskStateChanged", task: { state: "running", channelId: other }, attempt: null, quest: null }),
    ]);
    expect([...triggers.channels]).toEqual([CHANNEL, failedIn, cancelledIn]);
    expect([...triggers.tasks]).toEqual(["t9"]);
  });
});

describe("what the brain reads", () => {
  it("the channel's name, goal and records, never more than its limit (#1384)", () => {
    const input = briefInput({
      channel: camp(),
      decisions: [decision("d1", "Emails go out on Wednesdays.")],
      artifacts: [artifact("a1", "launch.md")],
      chapters: [{ number: 1, title: "Dates", summary: "Settled the send day." }],
      openTasks: [{ brief: "Write the emails", state: "running" }],
      recent: [],
    });
    expect(input).toContain("Camp: Launch");
    expect(input).toContain("Goal: Ship the launch emails");
    expect(input).toContain("- Emails go out on Wednesdays.");
    expect(input).toContain("- Chapter 1 (Dates): Settled the send day.");
    expect(input).toContain("- Write the emails (running)");
    const long = briefInput({
      channel: camp(),
      decisions: Array.from({ length: 200 }, (_, i) => decision(`d${i}`, "x".repeat(300))),
      artifacts: [],
      chapters: [],
      openTasks: [],
      recent: [],
    });
    expect(long.length).toBeLessThanOrEqual(BRIEF_INPUT_MAX);
  });
});
