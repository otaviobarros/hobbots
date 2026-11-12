import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  IllegalMemoryShareTransition,
  MemoryPath,
  MemoryProjectIdentity,
  MemoryShare,
  type MemoryShareEvent,
  MemoryShareMachine,
  type MemorySharePending,
  type MemoryShareState,
  MemoryShareStates,
  type MemoryShareThrough,
  MemoryVersion,
} from "../src/index.ts";
import { agreesWithModel } from "../testing/machine-model.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 12) + minute * 60_000).toISOString();

/** The `pending` each state may hold: only a share being written says what it writes. */
const PENDING: Readonly<Record<MemoryShareState, ReadonlyArray<MemorySharePending | null>>> = {
  waiting: [null],
  sending: ["share", "keep", "undo", "restored"],
  shared: [null],
  kept: [null],
  undone: [null],
};

const share = (state: MemoryShareState, pending: MemorySharePending | null, through: MemoryShareThrough) =>
  new MemoryShare({
    id: "share-1",
    agentId: AgentId.make("hob-1"),
    work: "task:task-1",
    key: "key",
    input: "input",
    path: MemoryPath.make("notes/launch.md"),
    markdown: "Launch on Tuesday.",
    tags: [],
    scope: { _tag: "Project", identity: MemoryProjectIdentity.make("github.com/me/app") },
    state,
    pending,
    through,
    edited: false,
    version: state === "waiting" ? null : MemoryVersion.make("v2"),
    previous: state === "waiting" ? null : MemoryVersion.make("v1"),
    replaced: state === "waiting" ? null : "Launch on Monday.",
    threadId: null,
    messageId: null,
    createdAt: at(0),
    updatedAt: at(0),
    decidedAt: state === "waiting" || state === "sending" ? null : at(1),
  });

/** What the model tracks of a share: every field a rule writes. */
interface ShareView {
  readonly state: MemoryShareState;
  readonly pending: MemorySharePending | null;
  readonly through: MemoryShareThrough;
  readonly markdown: string;
  readonly edited: boolean;
  readonly version: string | null;
  readonly previous: string | null;
  readonly replaced: string | null;
  readonly updatedAt: string;
  readonly decidedAt: string | null;
}

const view = (s: MemoryShare): ShareView => ({
  state: s.state,
  pending: s.pending,
  through: s.through,
  markdown: s.markdown,
  edited: s.edited,
  version: s.version,
  previous: s.previous,
  replaced: s.replaced,
  updatedAt: s.updatedAt,
  decidedAt: s.decidedAt,
});

const sending = (m: ShareView, pending: MemorySharePending, at: string): ShareView => ({
  ...m,
  state: "sending",
  pending,
  updatedAt: at,
});

const pick = <T, K extends keyof T>(value: T, keys: ReadonlyArray<K>) =>
  Object.fromEntries(keys.map((key) => [key, value[key]])) as Pick<T, K>;

/** The state each of your decisions starts from, and what it has the hub write. */
const DECIDES = { Keep: ["waiting", "keep"], Undo: ["shared", "undo"] } as const;

/** What each write that lands must have been writing, and the state it lands in. */
const LANDS = {
  Shared: ["share", "shared"],
  Kept: ["keep", "kept"],
  Undone: ["restored", "undone"],
} as const satisfies Record<string, readonly [MemorySharePending, MemoryShareState]>;

/** A conflict sends a share or keep back to you and an Undo back to shared; past its first step, nothing. */
const conflicted = (m: ShareView, writing: MemorySharePending | null, at: string): ShareView | "refused" => {
  if (writing === "undo") return { ...m, state: "shared", pending: null, updatedAt: at };
  if (writing !== "share" && writing !== "keep") return "refused";
  return {
    ...m,
    state: "waiting",
    pending: null,
    through: "review",
    version: null,
    previous: null,
    replaced: null,
    updatedAt: at,
  };
};

// ADR 028's Sharing, written apart from the machine so the two can disagree: you decide a share that
// waits, undo a shared one, and each write is recorded before it runs. What lands must be what was
// being written; a conflict sends a share or keep back to you, and an Undo back to shared, except past
// its first step, where only the hob's own copy is left to write.
const stepModel = (m: ShareView, e: MemoryShareEvent): ShareView | "refused" => {
  const writing = m.state === "sending" ? m.pending : null;
  const landed = (state: MemoryShareState): ShareView => ({
    ...m,
    state,
    pending: null,
    updatedAt: e.at,
    decidedAt: e.at,
  });
  switch (e._tag) {
    case "Share":
      return m.state === "waiting"
        ? { ...sending(m, "share", e.at), ...pick(e, ["markdown", "edited", "previous", "replaced"]) }
        : "refused";
    case "Keep":
    case "Undo": {
      const [from, pending] = DECIDES[e._tag];
      return m.state === from ? sending(m, pending, e.at) : "refused";
    }
    case "Restored":
      return writing === "undo" ? sending(m, "restored", e.at) : "refused";
    case "Shared":
    case "Kept":
    case "Undone": {
      const [needs, state] = LANDS[e._tag];
      if (writing !== needs) return "refused";
      return e._tag === "Shared" ? { ...landed(state), version: e.version } : landed(state);
    }
    case "Conflicted":
      return conflicted(m, writing, e.at);
  }
};

const times = fc.integer({ min: 0, max: 10_000 }).map(at);
const versions = fc.constantFrom("v1", "v2", "v3").map((v) => MemoryVersion.make(v));
const events: fc.Arbitrary<MemoryShareEvent> = fc.oneof(
  fc.record({
    _tag: fc.constant("Share" as const),
    markdown: fc.constantFrom("Launch on Tuesday.", "Launch on Wednesday."),
    edited: fc.boolean(),
    previous: fc.option(versions, { nil: null }),
    replaced: fc.option(fc.constantFrom("Launch on Monday.", "Launch soon."), { nil: null }),
    at: times,
  }),
  fc.record({ _tag: fc.constant("Keep" as const), at: times }),
  fc.record({ _tag: fc.constant("Undo" as const), at: times }),
  fc.record({ _tag: fc.constant("Restored" as const), at: times }),
  fc.record({ _tag: fc.constant("Shared" as const), version: versions, at: times }),
  fc.record({ _tag: fc.constant("Kept" as const), at: times }),
  fc.record({ _tag: fc.constant("Undone" as const), at: times }),
  fc.record({ _tag: fc.constant("Conflicted" as const), at: times }),
);
const records = fc
  .constantFrom(...(Object.keys(PENDING) as ReadonlyArray<MemoryShareState>))
  .chain((state) =>
    fc
      .tuple(fc.constantFrom(...PENDING[state]), fc.constantFrom<MemoryShareThrough>("review", "preset"))
      .map(([pending, through]) => share(state, pending, through)),
  );

describe("MemoryShareMachine", () => {
  it("agrees with a model of decisions, writes, undo and conflicts over random runs of events", () => {
    agreesWithModel({
      machine: MemoryShareMachine,
      records,
      events,
      model: { init: view, step: stepModel, view },
      isError: (result): result is IllegalMemoryShareTransition => result instanceof IllegalMemoryShareTransition,
    });
  });

  it("keeps `pending` set while a share is sending, and only then, over random runs of events", () => {
    fc.assert(
      fc.property(records, fc.array(events, { maxLength: 40 }), (start, run) => {
        let current = start;
        for (const event of run) {
          const next = MemoryShareMachine.transition(current, event);
          if (next instanceof IllegalMemoryShareTransition) continue;
          current = next;
          expect(current.pending !== null).toBe(MemoryShareStates.isSending(current));
        }
      }),
    );
  });

  it("exports one row per rule", () => {
    expect(MemoryShareMachine.table.map((row) => [row.event, row.from, row.to, row.guarded])).toEqual([
      ["Share", ["waiting"], "sending", false],
      ["Keep", ["waiting"], "sending", false],
      ["Undo", ["shared"], "sending", false],
      ["Restored", ["sending"], "sending", true],
      ["Shared", ["sending"], "shared", true],
      ["Kept", ["sending"], "kept", true],
      ["Undone", ["sending"], "undone", true],
      ["Conflicted", ["sending"], "shared", true],
      ["Conflicted", ["sending"], "waiting", true],
    ]);
  });

  it("never sends an Undo past its first step back, and names what it was writing when it refuses", () => {
    const restored = share("sending", "restored", "review");
    const refused = MemoryShareStates.transition(restored, { _tag: "Conflicted", at: at(2) });
    expect(refused).toBeInstanceOf(IllegalMemoryShareTransition);
    expect(refused).toMatchObject({ from: "sending", pending: "restored" });
    // A share that landed as kept is not taken back as an Undo would be.
    const kept = share("kept", null, "review");
    expect(MemoryShareStates.can(kept, { _tag: "Undo", at: at(2) })).toBe(false);
  });

  it("answers the hob by where its share stands", () => {
    expect(MemoryShareStates.answerText(share("sending", "share", "preset"))).toMatch(/not answering right now/);
    expect(MemoryShareStates.answerText(share("sending", "share", "review"))).toMatch(/waits for their review/);
    expect(MemoryShareStates.answerText(share("undone", null, "review"))).toMatch(/took back sharing/);
  });
});
