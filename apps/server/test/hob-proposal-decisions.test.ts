import { HobbotsRepository, type HobProposalApplier, HobProposalLog, HobProposals, pendingRow } from "@hobbots/agents";
import { DeviceRevoked, UserSession } from "@hobbots/api";
import { Agent, AgentId, type HobProposal, type HobProposalRow, WINDOW_DEVICE_ID } from "@hobbots/domain";
import { CharmCallsLive, HobbotsRepositoryLive, HobProposalLogLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { Effect, Exit, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

// A decision on a hob proposal (ADR 034) is saved only while your device is still approved, and a row
// is saved as applying before anything is made, so a hub that stopped in the middle of making it
// checks the hob before anything else decides it.

const BRAM = AgentId.make("0d6e2f0a-0000-4000-8000-0000000000b1");

/** What the fake applier was asked, and how it answers. */
const made: Array<string> = [];
let applying: "apply" | "die" = "apply";
let reconciled: string | null = null;

const applier: HobProposalApplier = {
  apply: (_proposal, row) =>
    applying === "die"
      ? Effect.die("the hub stopped")
      : Effect.sync(() => {
          made.push(row.id);
          return { _tag: "Applied", text: `Summoned ${row.label}` } as const;
        }),
  changedSince: () => Effect.succeed(false),
  alwaysAllow: () => Effect.succeed({ before: 1, after: 2 }),
  reconcile: () => Effect.succeed(reconciled),
};

let revoked = false;
const session = Layer.succeed(UserSession, {
  deviceId: WINDOW_DEVICE_ID,
  name: "This computer's Hobbots window",
  kind: "window",
  whileApproved: (write) =>
    revoked ? Effect.fail(new DeviceRevoked({ message: "This device was removed from this hub." })) : write,
});

const TestLayer = HobProposals.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(HobProposalLogLive, CharmCallsLive, HobbotsRepositoryLive)),
  Layer.provideMerge(TestDatabase),
);

const row = (id: string, label: string): HobProposalRow =>
  pendingRow({
    id,
    hobId: AgentId.make(crypto.randomUUID()),
    label,
    draft: { name: label },
    change: null,
    before: null,
    configVersion: null,
    status: null,
    runningReplies: null,
  });

/** A summon proposal by Bram of Ada and Cy, bound to the fake applier, with nothing waiting on it. */
const proposed = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  if (Option.isNone(yield* repo.findAgent(BRAM))) {
    yield* repo.insertAgent(
      new Agent({
        id: BRAM,
        name: "Bram",
        roleTitle: "Lead",
        runtime: "claude-code",
        model: null,
        effort: null,
        instructions: "",
        lookSeed: 1,
        lookColor: "violet",
        configVersion: 1,
        createdAt: "2026-11-01T00:00:00.000Z",
      }),
    );
  }
  const proposals = yield* HobProposals;
  yield* proposals.bindApplier(applier);
  const { proposal } = yield* proposals.propose({
    agentId: BRAM,
    kind: "summon",
    tool: "summoning_summon",
    call: { scope: "reply:m1", key: crypto.randomUUID() },
    threadId: null,
    messageId: null,
    taskId: null,
    stepId: null,
    rows: [row("1", "Ada"), row("2", "Cy")],
    asks: ["summoning.summon"],
    safety: null,
    highRisk: false,
  });
  return proposal;
});

const stored = (proposal: HobProposal) =>
  Effect.gen(function* () {
    const log = yield* HobProposalLog;
    return Option.getOrThrow(yield* log.get(proposal.id));
  });

const run = <A, E>(effect: Effect.Effect<A, E, HobProposals | HobProposalLog | HobbotsRepository | UserSession>) =>
  Effect.runPromise(Effect.provide(effect, Layer.merge(TestLayer, session)));

describe("deciding a hob proposal", () => {
  // covers PE-006, ADR 034 (only you decide), docs/architecture/permissions.md
  it("[TC-AG-409-08] a decision from a device revoked before it was saved is refused, and nothing is made", async () => {
    made.length = 0;
    applying = "apply";
    await run(
      Effect.gen(function* () {
        const proposal = yield* proposed;
        const proposals = yield* HobProposals;
        revoked = true;
        const allowed = yield* Effect.exit(proposals.allow(proposal.id, "1", {}));
        const all = yield* Effect.exit(proposals.allowAll(proposal.id, {}));
        const always = yield* Effect.exit(proposals.alwaysAllow(proposal.id, "summoning.summon"));
        const denied = yield* Effect.exit(proposals.denyAll(proposal.id));
        revoked = false;
        for (const exit of [allowed, all, always, denied]) {
          expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("DeviceRevoked");
        }
        expect(made).toEqual([]);
        const after = yield* stored(proposal);
        expect(after.rows.map((each) => each.state)).toEqual(["pending", "pending"]);
        expect(after.alwaysAllowed).toEqual([]);
      }),
    );
  });

  // covers STD-DATA-001, ADR 034 (Applying re-checks)
  it("[TC-AG-409-09] a row the hub stopped while making stays applying, and is settled from the hob before anything else decides it", async () => {
    made.length = 0;
    revoked = false;
    await run(
      Effect.gen(function* () {
        const proposals = yield* HobProposals;
        // The hub stops after it saved the row as applying, before it heard what was made.
        const first = yield* proposed;
        applying = "die";
        expect(Exit.isFailure(yield* Effect.exit(proposals.allow(first.id, "1", {})))).toBe(true);
        applying = "apply";
        expect((yield* stored(first)).rows[0]?.state).toBe("applying");
        // The hob shows it was made: Deny no longer says nothing was done, it reads as allowed.
        reconciled = "Summoned Ada";
        const deny = yield* Effect.exit(proposals.deny(first.id, "1"));
        expect(Exit.isFailure(deny) && JSON.stringify(deny.cause)).toContain("HobProposalDecided");
        expect((yield* stored(first)).rows[0]).toMatchObject({ state: "allowed", outcome: "Summoned Ada" });

        // The hob shows nothing of it: the row waits for you again, and Allow makes it once.
        const second = yield* proposed;
        applying = "die";
        yield* Effect.exit(proposals.allow(second.id, "1", {}));
        applying = "apply";
        reconciled = null;
        const view = yield* proposals.allow(second.id, "1", {});
        expect(view.proposal.rows[0]).toMatchObject({ state: "allowed", outcome: "Summoned Ada" });
        expect(made).toEqual(["1"]);
      }),
    );
  });
  // covers STD-DATA-001: a stuck row needs no decision to be settled
  it("[TC-AG-409-12] a row the hub stopped while making is settled by reading the card, as made or as waiting again", async () => {
    made.length = 0;
    revoked = false;
    await run(
      Effect.gen(function* () {
        const proposals = yield* HobProposals;
        const first = yield* proposed;
        applying = "die";
        yield* Effect.exit(proposals.allow(first.id, "1", {}));
        applying = "apply";
        reconciled = "Summoned Ada";
        expect((yield* proposals.get(first.id)).proposal.rows[0]).toMatchObject({ state: "allowed" });

        const second = yield* proposed;
        applying = "die";
        yield* Effect.exit(proposals.allow(second.id, "1", {}));
        applying = "apply";
        reconciled = null;
        const listed = (yield* proposals.list).find((each) => each.proposal.id === second.id);
        expect(listed?.proposal.rows[0]).toMatchObject({ state: "pending", edited: null, decidedAt: null });
      }),
    );
  });
});
