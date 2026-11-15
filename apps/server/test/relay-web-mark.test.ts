import { HobbotsRepository, type PromptRequest, ThreadMemberRepository, WEB_MARK_NOTE } from "@hobbots/agents";
import { hobActor, OWNER_ACTOR, Thread } from "@hobbots/domain";
import { waitUntil } from "@hobbots/domain/testing";
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { FRODO, PIP, partyHub, send, threadId } from "./party-hub.ts";

// Issue #1463 (ADR 039, Hobs talking to hobs; ADR 036, The read-the-web mark): a hob whose session
// read the web writes what a page said into its reply, and a reply that mentions another hob wakes
// it with that reply as its prompt. So the turn it wakes starts marked, as the writer's session is,
// and its session keeps the mark for the turns after.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const of = (hobId: string) => (request: PromptRequest) => request.tools?.runtimeFolder.endsWith(`/${hobId}`) === true;

describe("a relay from a hob that read the web", () => {
  // covers ADR 039 (Hobs talking to hobs), ADR 036 (The read-the-web mark)
  it("[TC-CH-1463-09] wakes the hob it mentions marked as having read the web, and keeps the mark on its session", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run, requests, reactions } = party;
    await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        const thread = Option.getOrThrow(yield* repo.findThread(threadId));
        yield* repo.upsertThread(new Thread({ ...thread, kind: "camp" }));
        yield* ThreadMemberRepository.use((members) => members.add(threadId, hobActor(PIP), OWNER_ACTOR));
      }),
    );
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
});
