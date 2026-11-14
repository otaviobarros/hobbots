import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Actor,
  AgentId,
  ApprovalId,
  ApprovalRequest,
  Artifact,
  type AwayMessage,
  awayItems,
  ChapterId,
  catchUpOf,
  Decision,
  DecisionId,
  deciderOf,
  type ForYouThread,
  forYouOf,
  HubQuestion,
  HubQuestionId,
  MessageId,
  OWNER_ACTOR,
  Question,
  QuestionId,
  RegisteredArtifactId,
  Task,
  TaskId,
  ThreadId,
} from "../src/index.ts";

// Issue #1456 (ADR 039, Cards every thread shares › For you): one list per person, built from the
// records and that person's read marker, topped by the same away summary catch-up shows.

const BRUNA: Actor = { kind: "user", id: "bruna" };
const LEO: Actor = { kind: "user", id: "leo" };
const HOB: Actor = { kind: "hob", id: "aldric" };
const PEOPLE = [OWNER_ACTOR, BRUNA, LEO] as const;
const AUTHORS = [...PEOPLE, HOB] as const;

const CHAPTER = ChapterId.make("chapter-1");
const at = (revision: number) => new Date(Date.UTC(2026, 10, 14) + revision * 60_000).toISOString();

const message = (threadId: string, id: string, revision: number, fields: Partial<AwayMessage> = {}): AwayMessage => ({
  id: MessageId.make(`${threadId}-${id}`),
  role: "assistant",
  status: "complete",
  content: `Message ${id}`,
  quiet: false,
  revision,
  createdAt: at(revision),
  actor: HOB,
  mentions: [],
  ...fields,
});

const decision = (threadId: string, id: string, revision: number, actor: Actor, active: boolean) =>
  new Decision({
    id: DecisionId.make(`${threadId}-${id}`),
    threadId: ThreadId.make(threadId),
    chapterId: CHAPTER,
    sourceMessageId: null,
    text: `Decision ${id}`,
    actor,
    state: active ? "active" : "superseded",
    supersededBy: null,
    recordedAt: at(revision),
    supersededAt: active ? null : at(revision),
    revision,
  });

const artifact = (threadId: string, id: string, revision: number, actor: Actor, fields: Partial<Artifact> = {}) =>
  new Artifact({
    id: RegisteredArtifactId.make(`${threadId}-${id}`),
    threadId: ThreadId.make(threadId),
    chapterId: CHAPTER,
    kind: "doc",
    title: `${id}.md`,
    locator: `/work/${id}.md`,
    latestVersion: 1,
    origin: { kind: "message", id: `made-${id}` },
    actor,
    createdAt: at(revision),
    updatedAt: at(revision),
    revision,
    ...fields,
  });

const approval = (id: string, threadId: string, revision: number) =>
  new ApprovalRequest({
    id: ApprovalId.make(id),
    agentId: AgentId.make("aldric"),
    threadId: ThreadId.make(threadId),
    messageId: null,
    stepId: `tool-${id}`,
    tool: "Bash",
    operation: "delete-files",
    targets: ["scratch/notes.txt"],
    arguments: { command: "rm scratch/notes.txt" },
    label: "Running rm scratch/notes.txt",
    reason: "Deleting files asks first.",
    actionDigest: "d".repeat(64),
    policyVersion: "r1",
    state: "pending",
    denyReason: null,
    createdAt: at(revision),
    decidedAt: null,
  });

const task = (threadId: string | null) =>
  new Task({
    id: TaskId.make(`task-${threadId}`),
    ownerId: AgentId.make("aldric"),
    parentId: null,
    rootId: TaskId.make(`task-${threadId}`),
    threadId: threadId === null ? null : ThreadId.make(threadId),
    brief: "Build the landing page",
    state: "waiting",
    dependsOn: [],
    result: null,
    currentAttemptId: null,
    createdAt: at(1),
    updatedAt: at(1),
    revision: 1,
  });

const question = (id: string, threadId: string | null, revision: number) => ({
  question: new Question({
    id: QuestionId.make(id),
    taskId: task(threadId).id,
    askerId: AgentId.make("aldric"),
    recipientId: null,
    chain: [],
    text: "Which photo goes first?",
    state: "open",
    answer: null,
    answeredBy: null,
    createdAt: at(revision),
    answeredAt: null,
  }),
  task: task(threadId),
});

const hubQuestion = (revision: number) =>
  new HubQuestion({
    id: HubQuestionId.make("hq-1"),
    key: "coding-setup",
    chat: null,
    ask: { kind: "coding-setup", hob: "Aldric" },
    options: [],
    recommended: null,
    state: "open",
    answer: null,
    picked: null,
    createdAt: at(revision),
    answeredAt: null,
    answeredByDeviceId: null,
    answeredVia: null,
    revision,
  });

const thread = (threadId: string, fields: Partial<ForYouThread> = {}): ForYouThread => ({
  threadId: ThreadId.make(threadId),
  marker: 10,
  messages: [],
  decisions: [],
  artifacts: [],
  quests: [],
  ...fields,
});

const empty = {
  hubOwner: OWNER_ACTOR,
  owners: new Map<ThreadId, Actor>(),
  approvals: [],
  questions: [],
  hubQuestions: [],
  reviews: [],
};

// Random records of one thread: messages by people and hobs that mention anyone, decisions and
// artifacts by anyone, read up to a random marker.
const actorArb = fc.constantFrom<Actor>(...AUTHORS);
const threadArb = (threadId: string): fc.Arbitrary<ForYouThread> =>
  fc
    .record({
      marker: fc.option(fc.integer({ min: 0, max: 40 }), { nil: null }),
      messages: fc.array(
        fc.record({
          revision: fc.integer({ min: 1, max: 40 }),
          role: fc.constantFrom("assistant", "user", "note"),
          quiet: fc.boolean(),
          actor: actorArb,
          mentions: fc.uniqueArray(actorArb, { selector: (actor) => `${actor.kind}:${actor.id}` }),
        }),
        { maxLength: 12 },
      ),
      decisions: fc.array(
        fc.record({ revision: fc.integer({ min: 1, max: 40 }), actor: actorArb, active: fc.boolean() }),
        {
          maxLength: 6,
        },
      ),
      artifacts: fc.array(fc.record({ revision: fc.integer({ min: 1, max: 40 }), actor: actorArb }), { maxLength: 6 }),
    })
    .map((drawn) =>
      thread(threadId, {
        marker: drawn.marker,
        messages: drawn.messages.map((each, index) => message(threadId, `m${index}`, each.revision, each)),
        decisions: drawn.decisions.map((each, index) =>
          decision(threadId, `d${index}`, each.revision, each.actor, each.active),
        ),
        artifacts: drawn.artifacts.map((each, index) => artifact(threadId, `a${index}`, each.revision, each.actor)),
      }),
    );

describe("forYouOf", () => {
  // covers ADR 039 (Cards every thread shares › For you; Validation)
  it("[TC-DM-1456-01] lists the same mentions, decisions and changed artifacts as catch-up, for the same records and read marker", () => {
    fc.assert(
      fc.property(fc.constantFrom<Actor>(...PEOPLE), fc.tuple(threadArb("camp"), threadArb("chat")), (you, threads) => {
        const forYou = forYouOf({ you, threads, ...empty });
        expect(forYou.for).toEqual(you);
        for (const each of threads) {
          // Its part of While you were away is exactly the catch-up of that thread.
          const caught = catchUpOf({ ...each, you });
          const away = forYou.away.find((part) => part.threadId === each.threadId);
          expect(away?.items ?? []).toEqual(caught.items);
          expect(away?.more ?? 0).toBe(caught.more);
          // And the list's mentions are every mention of you the away summary has, uncapped.
          const mentioned = awayItems({ ...each, you }).flatMap((item) =>
            item._tag === "Mentioned" ? [item.messageId] : [],
          );
          const listed = forYou.items.flatMap((item) =>
            item._tag === "Mention" && item.threadId === each.threadId ? [item.messageId] : [],
          );
          expect([...listed].sort()).toEqual([...mentioned].sort());
        }
        // Nothing in your list is for anyone else, and nothing in it is yours to have written.
        for (const item of forYou.items) expect(item.for).toEqual(you);
        for (const part of forYou.away)
          for (const item of part.items) {
            if (item._tag === "Decided" || item._tag === "CrossedOut") expect(item.decision.actor).not.toEqual(you);
            if (item._tag === "Made") expect(item.artifact.actor).not.toEqual(you);
            if (item._tag === "Mentioned") expect(item.author).not.toEqual(you);
          }
      }),
    );
  });

  // covers ADR 039 (Users as actors: mentions of you are per person)
  it("[TC-DM-1456-02] gives Bruna and Leo their own mentions in a camp they share", () => {
    const camp = thread("camp", {
      marker: 0,
      messages: [
        message("camp", "to-bruna", 11, {
          actor: LEO,
          role: "user",
          content: "@Bruna can you check the map?",
          mentions: [BRUNA],
        }),
        message("camp", "to-leo", 12, { content: "@Leo the photos are in", mentions: [LEO] }),
        message("camp", "to-both", 13, { actor: OWNER_ACTOR, role: "user", mentions: [BRUNA, LEO] }),
      ],
      decisions: [decision("camp", "price", 14, BRUNA, true)],
    });
    const listFor = (you: Actor) => forYouOf({ you, threads: [camp], ...empty });
    const mentionsOf = (you: Actor) =>
      listFor(you).items.flatMap((item) => (item._tag === "Mention" ? [item.messageId] : []));
    expect(mentionsOf(BRUNA)).toEqual(["camp-to-bruna", "camp-to-both"]);
    expect(mentionsOf(LEO)).toEqual(["camp-to-leo", "camp-to-both"]);
    expect(listFor(BRUNA).items[0]).toMatchObject({
      for: BRUNA,
      author: LEO,
      excerpt: "@Bruna can you check the map?",
    });
    // Bruna's own decision is news to Leo, not to her.
    const decided = (you: Actor) =>
      listFor(you).away.flatMap((part) => part.items.filter((item) => item._tag === "Decided"));
    expect(decided(BRUNA)).toEqual([]);
    expect(decided(LEO)).toHaveLength(1);
  });

  // covers ADR 039 (Cards every thread shares › Approval: the decider)
  it("[TC-DM-1456-03] gives approvals, questions and reviews to the thread's owner, else the hub's owner, oldest first", () => {
    const input = {
      hubOwner: OWNER_ACTOR,
      threads: [],
      owners: new Map<ThreadId, Actor>([[ThreadId.make("brunas-camp"), BRUNA]]),
      approvals: [approval("brunas", "brunas-camp", 3), approval("owners", "owners-chat", 2)],
      questions: [question("q-brunas", "brunas-camp", 4), question("q-loose", null, 1)],
      hubQuestions: [hubQuestion(5)],
      reviews: [
        artifact("brunas-camp", "page", 6, HOB),
        artifact("brunas-camp", "reviewed", 7, HOB, { review: "reviewed" }),
      ],
    };
    const kinds = (you: Actor) =>
      forYouOf({ you, ...input }).items.map((item) => [item._tag, item.for.id, item.at] as const);
    expect(kinds(BRUNA)).toEqual([
      ["Approval", "bruna", at(3)],
      ["Question", "bruna", at(4)],
      ["Review", "bruna", at(6)],
    ]);
    expect(kinds(OWNER_ACTOR)).toEqual([
      ["Question", "owner", at(1)],
      ["Approval", "owner", at(2)],
      ["HubQuestion", "owner", at(5)],
    ]);
    expect(kinds(LEO)).toEqual([]);
  });

  it("[TC-DM-1456-04] names the requester as decider before the owner, and the hub's owner when there is neither", () => {
    const hubOwner = OWNER_ACTOR;
    expect(deciderOf({ requester: LEO, owner: BRUNA, hubOwner })).toEqual(LEO);
    expect(deciderOf({ requester: null, owner: BRUNA, hubOwner })).toEqual(BRUNA);
    expect(deciderOf({ requester: null, owner: null, hubOwner })).toEqual(OWNER_ACTOR);
  });

  it("[TC-DM-1456-05] lists in While you were away only threads with news, the latest change first", () => {
    const forYou = forYouOf({
      you: OWNER_ACTOR,
      threads: [
        thread("quiet", { decisions: [decision("quiet", "old", 5, HOB, true)] }),
        thread("earlier", { decisions: [decision("earlier", "d", 12, HOB, true)] }),
        thread("later", { artifacts: [artifact("later", "a", 15, HOB)] }),
      ],
      ...empty,
    });
    expect(forYou.away.map((part) => part.threadId)).toEqual(["later", "earlier"]);
    expect(forYou.away[0]).toMatchObject({ readRevision: 10, more: 0 });
  });
});
