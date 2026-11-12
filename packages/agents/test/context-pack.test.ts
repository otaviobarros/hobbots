import {
  AgentId,
  CarriedOver,
  Chapter,
  ChapterId,
  type ChatWork,
  Message,
  MessageId,
  Question,
  QuestionId,
  Task,
  TaskId,
  ThreadId,
} from "@hobbots/domain";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildPack,
  CHARS_PER_TOKEN,
  cutMarker,
  PACK_BUDGET,
  type PackArtifact,
  type PackBudget,
  type PackDecision,
  type PackRecords,
  packChapters,
  plainChapterSummary,
} from "../src/context-pack.ts";

// The context pack (ADR 037, #1380): built from records within a budget, never over it, and never
// dropping an active decision or open work silently.

const THREAD = ThreadId.make("camp-1");
const WREN = AgentId.make("wren");
const at = (minute: number) => new Date(Date.UTC(2026, 10, 12) + minute * 60_000).toISOString();

const message = (n: number, role: "user" | "assistant", content: string, chapter = "live") =>
  new Message({
    id: MessageId.make(`m${n}`),
    threadId: THREAD,
    role,
    content,
    status: "complete",
    error: null,
    configVersion: role === "assistant" ? 1 : null,
    runtime: role === "assistant" ? "claude-code" : null,
    model: role === "assistant" ? "sonnet" : null,
    chapterId: ChapterId.make(chapter),
    createdAt: at(n),
  });

const task = (id: string, brief: string, fields: Partial<Task> = {}) =>
  new Task({
    id: TaskId.make(id),
    ownerId: WREN,
    parentId: null,
    rootId: TaskId.make(id),
    threadId: THREAD,
    brief,
    state: "active",
    dependsOn: [],
    result: null,
    currentAttemptId: null,
    createdAt: at(1),
    updatedAt: at(1),
    ...fields,
  });

const NO_WORK: ChatWork = { tasks: [], trees: [], questions: [], items: [] };

const decision = (n: number, text: string): PackDecision => ({ id: `d${n}`, text, recordedAt: at(n) });

const empty: PackRecords = {
  memoryBrief: null,
  campBrief: null,
  decisions: [],
  work: NO_WORK,
  carried: [],
  artifacts: [],
  chapters: [],
  live: [],
};

/** The pack's whole size in characters, the memory brief the turn sends beside it included. */
const sizeOf = (records: PackRecords, text: string | null) =>
  [records.memoryBrief, text].filter((part) => part !== null).join("\n\n").length;

const fixed = (): PackRecords => {
  const root = task("t1", "Plant the spring garden", { updatedAt: at(3) });
  const step = task("t2", "Buy tomato seedlings", {
    parentId: root.id,
    rootId: root.id,
    state: "completed",
    updatedAt: at(4),
  });
  const question = new Question({
    id: QuestionId.make("q1"),
    taskId: root.id,
    askerId: WREN,
    recipientId: null,
    chain: [],
    text: "Raised beds or pots?",
    state: "open",
    answer: null,
    answeredBy: null,
    createdAt: at(5),
    answeredAt: null,
  });
  return {
    memoryBrief: "## What you remember\n\nThe user gardens on a balcony.",
    campBrief: "Planning the balcony garden for spring.",
    decisions: [decision(2, "Grow tomatoes in pots.\nThey get the most sun there."), decision(1, "No pesticides.")],
    work: { tasks: [root], trees: [root, step], questions: [question], items: [] },
    carried: [
      new CarriedOver({
        fromThreadId: ThreadId.make("chat-0"),
        toThreadId: THREAD,
        ref: { _tag: "task", taskId: root.id },
        label: "Plant the spring garden",
        carriedAt: at(0),
      }),
    ],
    artifacts: [{ kind: "doc", title: "Planting plan", latestVersion: 2, updatedAt: at(6) }],
    chapters: [{ number: 1, title: "The cat", summary: "Named the cat Miso; she is three." }],
    live: [message(10, "user", "What should I plant first?"), message(11, "assistant", "Tomatoes, in pots.")],
  };
};

describe("buildPack", () => {
  // covers ADR 037 (The context pack), STD-ARCH-018
  it("[TC-CH-1380-01] is the same for the same records, part by part", () => {
    const pack = buildPack(fixed());
    expect(buildPack(fixed())).toEqual(pack);
    expect(pack.text).toMatchSnapshot();
    expect(pack.report).toMatchSnapshot();
    // The memory brief goes beside the pack, and counts against its budget.
    expect(pack.text).not.toContain("What you remember");
    expect(pack.report.parts.find((part) => part.part === "memory-brief")?.tokens).toBeGreaterThan(0);
    expect(pack.report.tokens).toBeLessThanOrEqual(PACK_BUDGET.total);
    // The open Task carries its last step, and the question waiting on it.
    expect(pack.text).toContain(
      "- Open Task: Plant the spring garden (Task t1, active); last step: Buy tomato seedlings (completed)",
    );
    expect(pack.text).toContain("- A question waiting for an answer: Raised beds or pots? (question q1)");
  });

  // covers ADR 037 (The context pack)
  it("[TC-CH-1380-02] says nothing when there is nothing to say", () => {
    const pack = buildPack(empty);
    expect(pack.text).toBeNull();
    expect(pack.report).toEqual({
      budget: PACK_BUDGET.total,
      tokens: 0,
      parts: Object.entries(PACK_BUDGET.shares).map(([part, share]) => ({ part, share, tokens: 0, trimmed: null })),
    });
  });

  // covers ADR 037 (The context pack), STD-ARCH-018
  it("[TC-CH-1380-03] stays within its budget when the briefs and decisions alone would not, listing every decision", () => {
    const decisions = (count: number) =>
      Array.from({ length: count }, (_, n) => decision(count - n, `Decision ${count - n}: ${"why ".repeat(110)}`));
    const over = (count: number): PackRecords => ({
      ...empty,
      memoryBrief: "m".repeat(20_000),
      campBrief: "b".repeat(20_000),
      decisions: decisions(count),
    });
    const accounted = (records: PackRecords) => {
      const pack = buildPack(records);
      expect(sizeOf(records, pack.text)).toBeLessThanOrEqual(PACK_BUDGET.total * CHARS_PER_TOKEN);
      expect(pack.report.parts.find((part) => part.part === "camp-brief")?.trimmed?.cutCharacters).toBeGreaterThan(0);
      const trimmed = pack.report.parts.find((part) => part.part === "decisions")?.trimmed;
      const { full = 0, titlesOnly = 0, leftOut = 0 } = trimmed ?? {};
      expect(full + titlesOnly + leftOut).toBe(records.decisions.length);
      expect(pack.text).toContain(`(decision d${records.decisions.length}`);
      return { text: pack.text ?? "", full, titlesOnly, leftOut };
    };

    // The newest in full, and every older one by title.
    const some = accounted(over(30));
    expect(some.full).toBeGreaterThan(0);
    expect(some.titlesOnly).toBeGreaterThan(0);
    expect(some.leftOut).toBe(0);
    expect(some.text).toContain("(decision d1, title only)");
    // Past what the titles fit, the newest titles, then a count of the rest.
    const many = accounted(over(60));
    expect(many).toMatchObject({ full: 0, titlesOnly: expect.any(Number) });
    expect(many.leftOut).toBeGreaterThan(0);
    expect(many.text).toContain(`(${many.leftOut} older active decisions are not listed here.)`);
  });

  // covers ADR 037 (The context pack)
  it("[TC-CH-1380-04] trims resting chapters first, then the oldest artifacts, then the live chapter's oldest turns", () => {
    const budget: PackBudget = {
      total: 1_500,
      shares: {
        "memory-brief": 100,
        "camp-brief": 100,
        decisions: 100,
        "open-work": 100,
        carried: 100,
        artifacts: 200,
        chapters: 200,
        "live-chapter": 600,
      },
    };
    const chapters = Array.from({ length: 40 }, (_, n) => ({ number: n + 1, title: null, summary: "x".repeat(80) }));
    const artifacts: Array<PackArtifact> = Array.from({ length: 40 }, (_, n) => ({
      kind: "doc",
      title: `Draft ${40 - n}`,
      latestVersion: 1,
      updatedAt: at(40 - n),
    }));
    const live = Array.from({ length: 30 }, (_, n) =>
      message(n, n % 2 === 0 ? "user" : "assistant", `turn ${n} ${"t".repeat(300)}`),
    );
    const trimmed = (records: PackRecords) =>
      Object.fromEntries(
        buildPack(records, budget).report.parts.map((part) => [part.part, part.trimmed?.leftOut ?? 0]),
      );

    // With little live chapter, chapters and artifacts take the room it leaves.
    const quiet = trimmed({
      ...empty,
      chapters: chapters.slice(0, 10),
      artifacts: artifacts.slice(0, 10),
      live: live.slice(-1),
    });
    expect(quiet).toMatchObject({ chapters: 0, artifacts: 0, "live-chapter": 0 });
    // Over budget, resting chapters go first, and the newest ones stay.
    const full = buildPack({ ...empty, chapters, artifacts, live }, budget);
    const parts = Object.fromEntries(full.report.parts.map((part) => [part.part, part]));
    expect(parts.chapters?.trimmed?.leftOut).toBeGreaterThan(0);
    expect(full.text).toContain("- Chapter 40: ");
    expect(full.text).not.toContain("- Chapter 1: ");
    expect(full.text).toContain("earlier chapters left out.)");
    // Then the oldest artifacts, the newest kept.
    expect(full.text).toContain("Draft 40");
    expect(full.text).toMatch(/\(\d+ older artifacts left out\.\)/);
    // Then the live chapter's oldest turns; its last turn stays whole.
    expect(full.text).toContain(`turn 29 ${"t".repeat(300)}`);
    expect(full.text).toMatch(/\(\d+ earlier messages of this chapter left out\.\)/);
    expect(full.report.tokens).toBeLessThanOrEqual(budget.total);
  });

  // covers ADR 037 (The context pack)
  it("[TC-CH-1380-05] cuts a last turn larger than the whole budget to its start and end, naming it for read_message", () => {
    const huge = `START ${"a".repeat(30_000)}${"z".repeat(30_000)} END`;
    const records: PackRecords = {
      ...empty,
      live: [message(1, "user", "Here is the log:"), message(2, "assistant", huge)],
    };
    const pack = buildPack(records);
    expect(pack.report.tokens).toBeLessThanOrEqual(PACK_BUDGET.total);
    expect(pack.text).toContain("> START a");
    expect(pack.text).toContain("z END");
    expect(pack.text).toMatch(/\[… [\d,]+ characters left out\. Read the rest with read_message, message_id m2\.\]/);
    const live = pack.report.parts.find((part) => part.part === "live-chapter");
    expect(live?.trimmed).toMatchObject({ leftOut: 1 });
    expect(live?.trimmed?.cutCharacters).toBeGreaterThan(10_000);
    expect(cutMarker(12_345, "m9")).toBe(
      "[… 12,345 characters left out. Read the rest with read_message, message_id m9.]",
    );
  });

  // covers ADR 037 (The context pack), STD-ARCH-018
  it("[TC-CH-1380-06] never goes over its budget, and accounts for every decision and open item, on random records", () => {
    const text = (max: number) => fc.string({ maxLength: max });
    const records = fc.record({
      memoryBrief: fc.option(text(8_000), { nil: null }),
      campBrief: fc.option(text(6_000), { nil: null }),
      decisions: fc.array(text(500), { maxLength: 80 }),
      tasks: fc.array(text(300), { maxLength: 40 }),
      artifacts: fc.array(text(200), { maxLength: 60 }),
      chapters: fc.array(text(280), { maxLength: 60 }),
      live: fc.array(text(20_000), { maxLength: 30 }),
    });
    fc.assert(
      fc.property(records, (r) => {
        const tasks = r.tasks.map((brief, n) => task(`t${n}`, brief || "work"));
        const input: PackRecords = {
          ...empty,
          memoryBrief: r.memoryBrief,
          campBrief: r.campBrief,
          decisions: r.decisions.map((t, n) => decision(n, t || "d")),
          work: { ...NO_WORK, tasks, trees: tasks },
          artifacts: r.artifacts.map((title, n) => ({ kind: "file", title, latestVersion: 1, updatedAt: at(n) })),
          chapters: r.chapters.map((summary, n) => ({ number: n + 1, title: null, summary })),
          live: r.live.map((content, n) => message(n, n % 2 === 0 ? "user" : "assistant", content)),
        };
        const pack = buildPack(input);
        expect(sizeOf(input, pack.text)).toBeLessThanOrEqual(PACK_BUDGET.total * CHARS_PER_TOKEN);
        expect(pack.report.tokens).toBeLessThanOrEqual(PACK_BUDGET.total);
        const part = (name: string) => pack.report.parts.find((p) => p.part === name);
        const decisions = part("decisions")?.trimmed;
        if (decisions != null) {
          expect(decisions.full + decisions.titlesOnly + decisions.leftOut).toBe(input.decisions.length);
        }
        const work = part("open-work")?.trimmed;
        if (work != null) expect(work.full + work.leftOut).toBe(tasks.length);
      }),
      { numRuns: 60 },
    );
  });
});

describe("chapter summaries in the pack", () => {
  const chapter = (id: string, number: number, state: Chapter["state"], summary: string | null) =>
    new Chapter({
      id: ChapterId.make(id),
      threadId: THREAD,
      number,
      title: number === 2 ? "The garden" : null,
      summary,
      state,
      startedAt: at(number),
      endedAt: state === "live" ? null : at(number + 1),
      movedTo: state === "moved" ? ThreadId.make("camp-2") : null,
    });

  // covers ADR 037 (The context pack), #1380
  it("[TC-CH-1380-07] lists each resting chapter with its summary, or the plain one until the projector writes it", () => {
    const messages = [
      message(1, "user", "My cat is called   Miso.", "c1"),
      message(2, "assistant", "Hello Miso!", "c1"),
      message(3, "user", "What should I plant?", "c2"),
      message(4, "user", "Moved away", "c3"),
      message(5, "user", "And now?", "c4"),
    ];
    const listed = packChapters(
      [
        chapter("c1", 1, "resting", null),
        chapter("c2", 2, "resting", "Picked tomatoes for the balcony."),
        chapter("c3", 3, "moved", null),
        chapter("c4", 4, "live", null),
      ],
      messages,
    );
    expect(listed).toEqual([
      { number: 1, title: null, summary: "2 messages, starting with “My cat is called Miso.”" },
      { number: 2, title: "The garden", summary: "Picked tomatoes for the balcony." },
    ]);
    expect(plainChapterSummary([message(9, "assistant", "Only me")])).toBe("1 message");
  });
});
