import { describe, expect, it } from "vitest";
import {
  Artifact,
  CATCH_UP_MAX,
  type CatchUpInput,
  type CatchUpQuest,
  ChapterId,
  catchUpOf,
  Decision,
  DecisionId,
  hasNews,
  MessageId,
  OWNER_ACTOR,
  QuestId,
  RegisteredArtifactId,
  ThreadId,
} from "../src/index.ts";

const THREAD = ThreadId.make("thread-1");
const CHAPTER = ChapterId.make("chapter-1");
const HOB = { kind: "hob", id: "hob-1" } as const;
const at = (minute: number) => new Date(Date.UTC(2026, 10, 12) + minute * 60_000).toISOString();

type Row = CatchUpInput["messages"][number];
const message = (id: string, revision: number, fields: Partial<Row> = {}): Row => ({
  id: MessageId.make(id),
  role: "assistant",
  status: "complete",
  content: `Reply ${id}`,
  quiet: false,
  revision,
  createdAt: at(revision),
  actor: HOB,
  mentions: [],
  ...fields,
});

const decision = (id: string, revision: number, fields: Partial<Decision> = {}) =>
  new Decision({
    id: DecisionId.make(id),
    threadId: THREAD,
    chapterId: CHAPTER,
    sourceMessageId: MessageId.make(`from-${id}`),
    text: `Decision ${id}`,
    actor: HOB,
    state: "active",
    supersededBy: null,
    recordedAt: at(revision),
    supersededAt: null,
    revision,
    ...fields,
  });

const artifact = (id: string, revision: number, fields: Partial<Artifact> = {}) =>
  new Artifact({
    id: RegisteredArtifactId.make(id),
    threadId: THREAD,
    chapterId: CHAPTER,
    kind: "doc",
    title: `${id}.md`,
    locator: `/work/${id}.md`,
    latestVersion: 1,
    origin: { kind: "message", id: `made-${id}` },
    actor: HOB,
    createdAt: at(revision),
    updatedAt: at(revision),
    revision,
    ...fields,
  });

const quest = (id: string, revision: number, fields: Partial<CatchUpQuest["summary"]> = {}): CatchUpQuest => ({
  summary: { questId: QuestId.make(id), parentQuestId: null, state: "active", needsYou: 0, revision, ...fields },
  goal: `Goal ${id}`,
});

const input = (fields: Partial<CatchUpInput>): CatchUpInput => ({
  you: OWNER_ACTOR,
  marker: 10,
  messages: [],
  decisions: [],
  artifacts: [],
  quests: [],
  ...fields,
});

describe("catchUpOf", () => {
  it("counts the replies that landed since the marker and points at the first", () => {
    const caught = catchUpOf(
      input({
        messages: [
          message("read", 9),
          message("yours", 11, { role: "user", actor: OWNER_ACTOR }),
          message("first", 12),
          message("quiet", 13, { quiet: true }),
          message("running", 14, { status: "streaming" }),
          message("second", 15),
        ],
      }),
    );
    expect(caught).toMatchObject({ readUpTo: at(9), firstUnread: "first", replies: 2, items: [], more: 0 });
    expect(hasNews(caught)).toBe(true);
  });

  it("finds nothing new in a thread read past every record", () => {
    const caught = catchUpOf(
      input({
        marker: 50,
        messages: [message("a", 20)],
        decisions: [decision("d", 30)],
        artifacts: [artifact("f", 40)],
        quests: [quest("q", 45, { needsYou: 1 })],
      }),
    );
    expect(caught.items).toEqual([]);
    expect(hasNews(caught)).toBe(false);
  });

  it("lists what waits on you first, then every other change newest first", () => {
    const caught = catchUpOf(
      input({
        decisions: [decision("held", 11), decision("crossed", 14, { state: "superseded", supersededAt: at(14) })],
        artifacts: [artifact("brief", 13)],
        quests: [
          quest("asks", 12, { needsYou: 2 }),
          quest("done", 16, { state: "completed" }),
          quest("member", 17, { parentQuestId: QuestId.make("asks"), needsYou: 1 }),
          quest("quiet", 18),
        ],
      }),
    );
    expect(caught.items.map((item) => item._tag)).toEqual(["NeedsYou", "QuestEnded", "CrossedOut", "Made", "Decided"]);
    expect(caught.items[0]).toMatchObject({ goal: "Goal asks", count: 2, messageId: null });
    expect(caught.items[3]).toMatchObject({ messageId: "made-brief" });
    expect(caught.items[4]).toMatchObject({ messageId: "from-held" });
  });

  it("leaves out what you made yourself", () => {
    const caught = catchUpOf(
      input({
        decisions: [decision("mine", 11, { actor: OWNER_ACTOR })],
        artifacts: [artifact("upload", 12, { actor: OWNER_ACTOR })],
        messages: [
          message("note", 13, { role: "note", actor: OWNER_ACTOR, mentions: [OWNER_ACTOR] }),
          message("self", 14, { role: "user", actor: OWNER_ACTOR, mentions: [OWNER_ACTOR] }),
        ],
      }),
    );
    expect(caught).toMatchObject({ replies: 0, items: [] });
    expect(hasNews(caught)).toBe(false);
  });

  it("lists at most CATCH_UP_MAX changes and counts the rest", () => {
    const decisions = Array.from({ length: CATCH_UP_MAX + 3 }, (_, index) => decision(`d${index}`, 11 + index));
    const caught = catchUpOf(input({ decisions }));
    expect(caught.items).toHaveLength(CATCH_UP_MAX);
    expect(caught.more).toBe(3);
  });

  it("counts everything new in a thread you never read, with no time you left", () => {
    const caught = catchUpOf(input({ marker: null, messages: [message("a", 1)], decisions: [decision("d", 2)] }));
    expect(caught).toMatchObject({ readUpTo: null, firstUnread: "a", replies: 1 });
    expect(caught.items).toHaveLength(1);
  });
});
