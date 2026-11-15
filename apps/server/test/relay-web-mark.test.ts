import {
  ChapterService,
  ChatService,
  HobbotsRepository,
  type PromptRequest,
  ThreadMemberRepository,
  WEB_MARK_NOTE,
} from "@hobbots/agents";
import { ChapterId, hobActor, OWNER_ACTOR, Thread } from "@hobbots/domain";
import { waitUntil } from "@hobbots/domain/testing";
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { FRODO, messagesWhen, PIP, partyHub, send, threadId } from "./party-hub.ts";

// Issue #1463 (ADR 039, Hobs talking to hobs; ADR 036, The read-the-web mark): a hob whose session
// read the web writes what a page said into its reply, and a reply that mentions another hob wakes
// it with that reply as its prompt. So the turn it wakes starts marked, as the writer's session is,
// and its session keeps the mark for the turns after. The reply keeps the mark too, so any turn whose
// context holds it starts marked: the reply it answers in any chapter, or the live chapter it hears.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const of = (hobId: string) => (request: PromptRequest) => request.tools?.runtimeFolder.endsWith(`/${hobId}`) === true;

/** Frodo's thread made a camp Pip is a member of. */
const camp = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  const thread = Option.getOrThrow(yield* repo.findThread(threadId));
  yield* repo.upsertThread(new Thread({ ...thread, kind: "camp" }));
  yield* ThreadMemberRepository.use((members) => members.add(threadId, hobActor(PIP), OWNER_ACTOR));
});

/** The camp once every reply has ended and no hob owes one, but those the relay budget paused. */
const quiet = waitUntil(
  HobbotsRepository.use((repo) =>
    Effect.all([repo.listMessages(threadId), repo.openTurnRequests({ threadId, rootMessageId: null })]),
  ),
  ([all, owed]) =>
    owed.every((request) => request.state === "paused") &&
    all.every((m) => m.status !== "streaming" && m.status !== "stopping"),
  { what: "a quiet camp" },
);

/** Frodo's turns so far, once there are `count`. */
const frodosTurns = (requests: ReadonlyArray<PromptRequest>, count: number) =>
  waitUntil(
    Effect.sync(() => requests.filter(of(FRODO))),
    (all) => all.length >= count,
    { what: `Frodo's turn ${count}` },
  );

describe("a relay from a hob that read the web", () => {
  // covers ADR 039 (Hobs talking to hobs), ADR 036 (The read-the-web mark)
  it("[TC-CH-1463-09] wakes the hob it mentions marked as having read the web, and keeps the mark on its session", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run, requests, reactions } = party;
    await run(camp);
    // Pip searches, then hands over to Frodo, the camp's hob, in its reply.
    reactions.push({ on: "lamp oil", lines: ["@Frodo, over to you"] });
    await run(send(["@Pip what does lamp oil cost?", "fake:search lamp oil"]));
    const relayed = await run(
      waitUntil(
        Effect.sync(() => requests.find(of(FRODO))),
        (request): request is PromptRequest => request !== undefined,
        { what: "Frodo's relayed turn" },
      ),
    );
    const sessions = await run(
      waitUntil(
        HobbotsRepository.use((repo) =>
          Effect.map(repo.findThread(threadId), (thread) => Option.getOrThrow(thread).sessions),
        ),
        (all) => all.some((session) => session.agentId === FRODO),
        { what: "Frodo's session" },
      ),
    );

    const pips = requests.filter(of(PIP));
    // Pip's own turn read nothing before it, so it starts unmarked; Frodo's starts marked.
    expect(pips[0]?.briefing ?? "").not.toContain(WEB_MARK_NOTE);
    expect(relayed.briefing ?? "").toContain(WEB_MARK_NOTE);
    expect(sessions.find((session) => session.agentId === FRODO)?.readWeb).toMatchObject({
      source: 'the web search "lamp oil"',
    });
  }, 30_000);

  // covers ADR 039 (Hobs talking to hobs), ADR 036 (The read-the-web mark)
  it("[TC-CH-1463-10] marks a turn whose live chapter holds a marked hob reply, and a relay that goes on in a new chapter", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run, requests } = party;
    await run(camp);
    // Pip searches and answers you; its reply quotes you, mentioning only itself, so it wakes nobody.
    await run(send(["@Pip what does lamp oil cost?", "fake:search lamp oil"]));
    const answered = await run(
      messagesWhen((all) => all.some((m) => m.role === "assistant" && m.actor?.id === PIP && m.status === "complete")),
    );
    expect(answered.find((m) => m.actor?.id === PIP)?.readWeb).toMatchObject({ source: 'the web search "lamp oil"' });
    // You ask Frodo next: his turn hears Pip's reply in the live chapter, so it starts marked.
    await run(send(["@Frodo and what do you think?"]));
    const [heard] = await run(frodosTurns(requests, 1));
    expect(heard?.briefing ?? "").toContain(WEB_MARK_NOTE);
    // The fake echoes the chapter, which @mentions Pip, so the hobs relay until the budget pauses
    // the next one, Pip's to Frodo.
    await run(quiet);
    const asked = requests.filter(of(FRODO)).length;
    // A new chapter starts a new session, which holds no mark and hears no marked reply. The relay
    // that goes on there still starts marked: the reply it answers carries the mark of Pip's session.
    await run(
      ChapterService.use((chapters) =>
        chapters.startChapter(threadId, { id: ChapterId.make("chapter-2"), title: "Supper" }),
      ),
    );
    await run(ChatService.use((chat) => chat.letHobsGoOn(threadId)));
    const later = await run(frodosTurns(requests, asked + 1));
    expect(later[asked]?.briefing ?? "").toContain(WEB_MARK_NOTE);
    const sessions = await run(
      waitUntil(
        HobbotsRepository.use((repo) =>
          Effect.map(repo.findThread(threadId), (thread) => Option.getOrThrow(thread).sessions),
        ),
        (all) => all.some((session) => session.agentId === FRODO && session.chapterId === "chapter-2"),
        { what: "Frodo's session in the new chapter" },
      ),
    );
    expect(
      sessions.find((session) => session.agentId === FRODO && session.chapterId === "chapter-2")?.readWeb,
    ).toMatchObject({ source: 'the web search "lamp oil"' });
  }, 30_000);
});
