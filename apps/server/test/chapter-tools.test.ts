import {
  ChapterService,
  ChatService,
  HobbotsRepository,
  type PromptRequest,
  START_CHAPTER_OUTSIDE_CHAT,
  unknownMessageText,
} from "@hobbots/agents";
import {
  liveSession,
  MESSAGE_PART_CHARS,
  type Message,
  READ_MESSAGE_TOOL,
  type RuntimeKind,
  START_CHAPTER_TOOL,
} from "@hobbots/domain";
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FRODO, hub, messagesWhen, PIP, partyHub, send, threadId } from "./party-hub.ts";

// Issue #1381 (ADR 037): the hob ends a chapter itself with `start_chapter`, and reads back a message
// the context pack cut with `read_message`. Both are hub tools, so Claude Code and Codex serve them
// alike; the fake runtime plays each hob from `fake:hub` lines.

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const offered = (request: PromptRequest | undefined) => request?.hubTools?.tools.map((tool) => tool.name) ?? [];

/** A party hub with the Chapter tools, Frodo thinking with `lead`. */
const chapterHub = (lead: RuntimeKind = "claude-code") => {
  const party = partyHub({ chapters: true, lead });
  dispose = party.dispose;
  const { run } = party;
  /** Sends your message to Frodo and waits until his thread holds `count` messages, every reply ended. */
  const say = (lines: ReadonlyArray<string>, count: number) =>
    run(send(lines)).then(() => run(messagesWhen((all) => all.length >= count)));
  const chapters = () => run(ChapterService.use((service) => service.listChapters(threadId)));
  const thread = () =>
    run(HobbotsRepository.use((repo) => repo.findThread(threadId)).pipe(Effect.map(Option.getOrThrow)));
  return { ...party, say, chapters, thread };
};

describe("start_chapter", () => {
  // covers ADR 037 (Chapters), RT-001
  it.each<RuntimeKind>(["claude-code", "codex"])(
    "[TC-CH-1381-01] on %s, the hob starts a chapter and its next turn runs in a new session",
    async (runtime) => {
      const { say, chapters, thread, requests, answers } = chapterHub(runtime);
      await say(["My cat is called Miso."], 2);
      expect(offered(requests[0])).toEqual(expect.arrayContaining([START_CHAPTER_TOOL, READ_MESSAGE_TOOL]));
      const first = liveSession(await thread(), runtime, FRODO);
      expect(first?.sessionId).toMatch(/^fake-/);

      await say(["Let's talk about the garden.", hub("start_chapter", { key: "chapter", title: "The garden" })], 4);
      expect(answers.get("chapter")).toMatch(/^Started chapter 2, “The garden”\./);
      expect((await chapters()).map((c) => [c.number, c.title, c.state])).toEqual([
        [1, null, "resting"],
        [2, "The garden", "live"],
      ]);
      // The turn that started it ran in the first chapter's session, which no later turn resumes.
      expect(requests[1]?.sessionId).toBe(first?.sessionId);
      expect(liveSession(await thread(), runtime, FRODO)).toBeUndefined();

      const all = await say(["What should I plant?"], 6);
      const fresh = requests[2] as PromptRequest;
      expect(fresh.sessionId).toBeNull();
      expect(offered(fresh)).toEqual(expect.arrayContaining([START_CHAPTER_TOOL, READ_MESSAGE_TOOL]));
      expect((all.at(-1) as Message).chapterId).toBe((await thread()).liveChapterId);
      const second = liveSession(await thread(), runtime, FRODO);
      expect(second?.sessionId).not.toBe(first?.sessionId);
    },
  );

  // covers ADR 037 (Chapters, The context pack)
  it.each<RuntimeKind>(["claude-code", "codex"])(
    "[TC-CH-1381-08] on %s, the turn after the hob's start_chapter starts from the pack, never the old transcript",
    async (runtime) => {
      const { say, requests } = chapterHub(runtime);
      await say(["My cat is called Miso."], 2);
      await say(["Now the garden.", hub("start_chapter", { key: "chapter", title: "The garden" })], 4);
      await say(["What should I plant?"], 6);
      const fresh = requests[2] as PromptRequest;
      expect(fresh.sessionId).toBeNull();
      const told = fresh.briefing ?? "";
      // The pack's earlier chapters carry the first chapter as one line, never its messages.
      expect(told).toContain("## Earlier chapters");
      expect(told).toMatch(/- Chapter 1: .*My cat is called Miso\./);
      expect(told).not.toContain("> My cat is called Miso.");
    },
  );

  // covers ADR 037 (Chapters)
  it("[TC-CH-1381-02] a turn starts at most one chapter, and a retried call starts none", async () => {
    const { say, chapters, answers } = chapterHub();
    await say(
      [
        "New topic.",
        hub("start_chapter", { key: "once", title: "The garden" }),
        hub("start_chapter", { key: "again", title: "The orchard" }),
      ],
      2,
    );
    expect(answers.get("once")).toMatch(/^Started chapter 2, “The garden”/);
    expect(answers.get("again")).toMatch(/^This turn already started chapter 2, “The garden”/);
    expect((await chapters()).map((c) => c.title)).toEqual([null, "The garden"]);
  });

  // covers ADR 037 (Chapters)
  it("[TC-CH-1381-03] a call the chapter commands refuse is answered with the reason", async () => {
    const { say, answers } = chapterHub();
    await say([hub("start_chapter", { key: "blank", title: "   " }), hub("start_chapter", { key: "none" })], 2);
    expect(answers.get("blank")).toBe("Give the new chapter a title with some text.");
    expect(answers.get("none")).toBe("Give the new chapter's topic as `title`.");
  });

  // covers ADR 037 (Chapters, The context pack), ADR 018
  it("[TC-CH-1381-04] start_chapter in a Task step's session is refused with a reason the hob can read", async () => {
    const { run, chapters, answers } = chapterHub();
    await run(
      send([
        "Draft the notes",
        hub("plan_steps", {
          key: "plan",
          steps: [
            {
              brief: [
                "Draft the notes",
                hub("start_chapter", { key: "step-chapter", title: "Drafting" }),
                hub("complete_task", { delivered: true, key: "noted", summary: "Drafted" }),
              ].join("\n"),
            },
          ],
        }),
      ]),
    );
    await vi.waitFor(() => expect(answers.get("step-chapter")).toBeDefined(), { timeout: 10_000 });
    expect(answers.get("step-chapter")).toBe(START_CHAPTER_OUTSIDE_CHAT);
    expect(await chapters()).toHaveLength(1);
  });
});

describe("read_message", () => {
  // covers ADR 037 (The context pack), ADR 036 (paging)
  it("[TC-CH-1381-05] pages a long message of the hob's own thread, redacted", async () => {
    const { say, answers } = chapterHub();
    const long = `The plan starts here, with ${SECRET}.\n${"line of the plan\n".repeat(2_000)}The plan ends here.`;
    const [prompt] = await say([long], 2);
    const id = (prompt as Message).id;
    await say(
      [
        hub("read_message", { key: "one", message_id: id }),
        hub("read_message", { key: "two", message_id: id, part: 2 }),
        hub("read_message", { key: "three", message_id: id, part: 3 }),
      ],
      4,
    );
    const one = answers.get("one") ?? "";
    expect(one).toContain(`Message ${id}, written by the user`);
    expect(one).toContain(`Part 1 of 2. Read the next with ${READ_MESSAGE_TOOL}, the same message_id and part 2.`);
    expect(one).toContain("The plan starts here");
    expect(one).not.toContain(SECRET);
    const two = answers.get("two") ?? "";
    expect(two).toContain("Part 2 of 2, the last.");
    expect(two).toContain("The plan ends here.");
    expect(answers.get("three")).toBe(`Message ${id} has 2 parts, so there is no part 3.`);
  });

  // covers ADR 037 (The context pack), STD-SEC
  it("[TC-CH-1381-07] a secret across a part boundary is redacted whole, in neither part", async () => {
    const { say, answers } = chapterHub();
    // No line break, so the parts are cut at exactly MESSAGE_PART_CHARS, through the secret.
    const long = `${"a".repeat(MESSAGE_PART_CHARS - 11)} ${SECRET} ${"b".repeat(1_000)}`;
    const [prompt] = await say([long], 2);
    const id = (prompt as Message).id;
    await say(
      [
        hub("read_message", { key: "one", message_id: id }),
        hub("read_message", { key: "two", message_id: id, part: 2 }),
      ],
      4,
    );
    const both = `${answers.get("one") ?? ""}\n${answers.get("two") ?? ""}`;
    expect(both).toContain("Part 1 of 2.");
    expect(both).not.toContain(SECRET.slice(0, 10));
    expect(both).not.toContain(SECRET.slice(10));
  });

  // covers ADR 037 (The context pack), PE-001
  it("[TC-CH-1381-06] never reads a message of another hob's thread", async () => {
    const { run, say, answers } = chapterHub();
    const pips = await run(ChatService.use((chat) => chat.createThread(PIP)));
    await run(ChatService.use((chat) => chat.sendPrompt(pips.id, "Pip's own plan")));
    const [theirs] = await run(HobbotsRepository.use((repo) => repo.listMessages(pips.id)));
    const id = (theirs as Message).id;
    expect((theirs as Message).content).toBe("Pip's own plan");

    await say(
      [
        hub("read_message", { key: "theirs", message_id: id }),
        hub("read_message", { key: "unknown", message_id: "no-such-message" }),
      ],
      2,
    );
    // Another hob's message reads as one that does not exist.
    expect(answers.get("theirs")).toBe(unknownMessageText(id));
    expect(answers.get("theirs")).not.toContain("Pip's own plan");
    expect(answers.get("unknown")).toBe(unknownMessageText("no-such-message"));
  });
});
