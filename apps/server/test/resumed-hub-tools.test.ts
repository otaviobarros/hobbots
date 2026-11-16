import { HobbotsRepository, type PromptRequest } from "@hobbots/agents";
import {
  EMPTY_HOB_POLICY,
  type HobPolicy,
  liveSession,
  PASS_TOOL,
  READ_HOB_TOOL,
  type RuntimeKind,
} from "@hobbots/domain";
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { channelId, FRODO, messagesWhen, partyHub, send } from "./party-hub.ts";

// Issue #1245 (ADR 024): Codex keeps the hub tools a thread started with, since `thread/resume`
// takes none. A hob that gains a hub tool after its thread started, here `read_hob` once its Read
// other hobs answer turns from Never to Allow (ADR 032), is offered it on its next turn: the hub
// starts a new thread from the context pack in place of one that lacks a tool the turn offers.
// Claude Code is offered each turn's tools, so its session is resumed as before. The fake runtime
// plays each, and fake Codex keeps its thread's first tools as Codex does.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const offered = (request: PromptRequest | undefined) => request?.hubTools?.tools.map((tool) => tool.name) ?? [];

/** Frodo's own answers: Read other hobs is Never until `allow` turns it Allow. */
const readHobAnswer = () => {
  let answer: "deny" | "allow" = "deny";
  const hob = (): HobPolicy => ({ ...EMPTY_HOB_POLICY, overrides: { "read-hobs": answer } });
  return {
    hob,
    allow: () => {
      answer = "allow";
    },
  };
};

/** A hub where Frodo thinks with `runtime`, sees the other hobs, and answers Read other hobs as `hob` says. */
const hubOn = (runtime: RuntimeKind, hob: () => HobPolicy) => {
  const party = partyHub({ lead: runtime, directory: true, hob });
  dispose = party.dispose;
  return party;
};

/** Sends `text` in Frodo's channel and waits until `replies` replies have ended. */
const turn = (run: ReturnType<typeof partyHub>["run"], text: string, replies: number) =>
  Effect.gen(function* () {
    yield* send([text]);
    yield* messagesWhen(
      (messages) => messages.filter((m) => m.role === "assistant" && m.status === "complete").length >= replies,
    );
  }).pipe(run);

const frodoSession = (run: ReturnType<typeof partyHub>["run"], runtime: RuntimeKind) =>
  run(
    HobbotsRepository.use((repo) => repo.findChannel(channelId)).pipe(
      Effect.map((found) => liveSession(Option.getOrThrow(found), runtime, FRODO)),
    ),
  );

describe("hub tools a resumed session gains", () => {
  // covers ADR 024 (A thread keeps the tools it started with), ADR 032 (read_hob), RT-001
  it("on codex, a thread started without read_hob is not resumed once its answer turns Allow, and the new one is (#1245)", async () => {
    const answers = readHobAnswer();
    const { run, requests } = hubOn("codex", answers.hob);
    await turn(run, "My cat is called Miso.", 1);
    const first = await frodoSession(run, "codex");
    answers.allow();
    await turn(run, "Who else is on the hub?", 2);
    const second = await frodoSession(run, "codex");
    await turn(run, "And what is my cat called?", 3);
    const third = await frodoSession(run, "codex");

    expect(offered(requests[0])).not.toContain(READ_HOB_TOOL);
    expect(first?.hubTools).toContain(PASS_TOOL);
    expect(first?.hubTools).not.toContain(READ_HOB_TOOL);
    // The thread lacks read_hob, which the turn now offers: a new thread starts, holding it.
    expect(requests[1]?.sessionId).toBeNull();
    expect(offered(requests[1])).toContain(READ_HOB_TOOL);
    expect(second?.sessionId).not.toBe(first?.sessionId);
    expect(second?.hubTools).toContain(READ_HOB_TOOL);
    // It started from the context pack, so it is told what the conversation said before it.
    expect(requests[1]?.briefing ?? "").toContain("My cat is called Miso.");
    // The new thread holds every tool the next turn offers, so that turn resumes it.
    expect(requests[2]?.sessionId).toBe(second?.sessionId);
    expect(third?.sessionId).toBe(second?.sessionId);
  }, 30_000);

  // covers ADR 024 (A thread keeps the tools it started with), RT-001
  it("on codex, a thread that holds every tool the turn offers is resumed (#1245)", async () => {
    const { run, requests } = hubOn("codex", () => EMPTY_HOB_POLICY);
    await turn(run, "My cat is called Miso.", 1);
    const first = await frodoSession(run, "codex");
    await turn(run, "What is my cat called?", 2);

    expect(offered(requests[0])).toContain(READ_HOB_TOOL);
    expect(requests[1]?.sessionId).toBe(first?.sessionId);
    expect(offered(requests[1])).toEqual(offered(requests[0]));
  }, 30_000);

  // covers ADR 024 (A thread keeps the tools it started with), RT-001
  it("on claude-code, a session is resumed and offered read_hob once its answer turns Allow (#1245)", async () => {
    const answers = readHobAnswer();
    const { run, requests } = hubOn("claude-code", answers.hob);
    await turn(run, "My cat is called Miso.", 1);
    const first = await frodoSession(run, "claude-code");
    answers.allow();
    await turn(run, "Who else is on the hub?", 2);

    expect(offered(requests[0])).not.toContain(READ_HOB_TOOL);
    expect(requests[1]?.sessionId).toBe(first?.sessionId);
    expect(offered(requests[1])).toContain(READ_HOB_TOOL);
    // Claude Code is offered each turn's tools, so nothing is recorded of what its session holds.
    expect(first?.hubTools).toBeUndefined();
  }, 30_000);
});
