import { Schema } from "effect";
import { AgentStatus, ConfigVersion, RetireWork } from "./agent.ts";
import { ChangeCall } from "./change-actor.ts";
import { AgentId, MessageId, ThreadId } from "./ids.ts";
import { defineMachine } from "./machine.ts";
import { CharmOperationId } from "./policy.ts";
import { Revision } from "./revision.ts";
import { SummoningChange, SummoningDraft } from "./summoning.ts";
import { TaskId } from "./task.ts";

/**
 * A hob proposal (ADR 034, Asking is a proposal): a Summoning Charm call that asks becomes an Inbox
 * item that only you decide and apply. The hub records it on the manager's call, with one row per hob,
 * and what you allow is made by you on the manager's proposal. No hob decides or applies one, the
 * manager included.
 */

export const HobProposalId = Schema.String.pipe(Schema.brand("HobProposalId"));
export type HobProposalId = typeof HobProposalId.Type;

/** What a proposal does: summon new hobs, change hobs, or pause, wake or retire one. */
export const HobProposalKind = Schema.Literals(["summon", "change", "pause", "wake", "retire"]);
export type HobProposalKind = typeof HobProposalKind.Type;

/**
 * Where one row stands: `pending` until you decide it; `applying` once you allowed it, while the hub
 * makes it; `allowed` once what it proposes was made; `denied` when you said no; `failed` when you
 * allowed it and the hub could not make it, with why. `applying` is saved before the hub makes
 * anything, so a row the hub stopped in the middle of is checked against the hob before anything else
 * decides it.
 */
export const HobProposalRowState = Schema.Literals(["pending", "applying", "allowed", "denied", "failed"]);
export type HobProposalRowState = typeof HobProposalRowState.Type;

/**
 * One hob of a proposal. A summon row holds the draft of a new hob and the id the hub minted for it,
 * a change row the change and its target's fields before it, and a pause, wake or retire row its
 * target. `configVersion` and `status` are the target's when the row was made: a row whose target has
 * moved on since is never applied (changed since), and only Deny is left.
 */
export const HobProposalRow = Schema.Struct({
  id: Schema.String,
  hobId: AgentId,
  /** The hob's name as the row was made: the draft's, or the target's. */
  label: Schema.String,
  draft: Schema.NullOr(SummoningDraft),
  change: Schema.NullOr(SummoningChange),
  /** The target's value of each field the change gives, by the change's own field name. */
  before: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  configVersion: Schema.NullOr(ConfigVersion),
  status: Schema.NullOr(AgentStatus),
  /** For a retire row: what happens to the hob's running replies. */
  runningReplies: Schema.NullOr(RetireWork),
  /** Your version of a summon row, when you edited it before you allowed it. */
  edited: Schema.NullOr(SummoningDraft),
  state: HobProposalRowState,
  /** What the hub did or why it could not, as the manager is told. */
  outcome: Schema.NullOr(Schema.String),
  decidedAt: Schema.NullOr(Schema.String),
});
export type HobProposalRow = typeof HobProposalRow.Type;

/** `open` while a row waits for you; `settled` once every row is decided. */
export const HobProposalState = Schema.Literals(["open", "settled"]);
export type HobProposalState = typeof HobProposalState.Type;

export class HobProposal extends Schema.Class<HobProposal>("HobProposal")({
  id: HobProposalId,
  /** The manager: the hob whose call made the proposal. */
  agentId: AgentId,
  kind: HobProposalKind,
  /** The Summoning tool the manager called. */
  tool: Schema.String,
  /** The call behind it: the work its key belongs to and the key, as a change it applies records (ADR 031). */
  call: ChangeCall,
  threadId: Schema.NullOr(ThreadId),
  messageId: Schema.NullOr(MessageId),
  /** The Task the manager's turn worked on, or null outside one. */
  taskId: Schema.NullOr(TaskId),
  /** The call's reply step, which shows the same card in the chat. */
  stepId: Schema.NullOr(Schema.String),
  rows: Schema.Array(HobProposalRow),
  /**
   * The operations that asked and that "Always allow" may set to Allow on the manager's Summoning
   * Charm. Empty for a safety Ask or a high-risk operation, which it never covers.
   */
  asks: Schema.Array(CharmOperationId),
  /** Why every field asks whatever its answer, for a target wider than the manager; null otherwise. */
  safety: Schema.NullOr(Schema.String),
  /** Retire is high risk: allowing it needs the confirmation check box (ADR 015). */
  highRisk: Schema.Boolean,
  /** The operations you set to Allow from this proposal with "Always allow". */
  alwaysAllowed: Schema.Array(CharmOperationId),
  state: HobProposalState,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  settledAt: Schema.NullOr(Schema.String),
  /** The journal sequence of its last change, which a change must name to land. */
  revision: Revision,
}) {}

/**
 * What can happen to a row. `Allow` and `Deny` are your decisions on a row that waits; `Allow` is
 * saved as applying before the hub makes anything. `Made` and `Failed` are what came of it. `Reopen`
 * sends a row the hub could not make back to you: one the hub refused, or one a stopped hub left
 * applying that its hob shows was never made.
 */
export type HobProposalRowEvent =
  | { readonly _tag: "Allow"; readonly edited: SummoningDraft | null; readonly at: string }
  | { readonly _tag: "Deny"; readonly at: string }
  | { readonly _tag: "Made"; readonly outcome: string }
  | { readonly _tag: "Failed"; readonly outcome: string }
  | { readonly _tag: "Reopen" };

/** A change to a row its state does not allow. */
export class IllegalHobProposalRowTransition extends Schema.TaggedError<IllegalHobProposalRowTransition>()(
  "IllegalHobProposalRowTransition",
  { rowId: Schema.String, from: HobProposalRowState, to: HobProposalRowState },
) {}

/** One row's lifecycle (ADR 034), declared once. A decided row stays decided. */
export const HobProposalRowMachine = defineMachine<
  HobProposalRowState,
  HobProposalRowEvent,
  HobProposalRow,
  IllegalHobProposalRowTransition
>({
  name: "HobProposalRow",
  states: {
    pending: "It waits for you to allow or deny it",
    applying: "You allowed it and the hub is making it; a stopped hub checks it against the hob first",
    allowed: "What it proposes was made",
    denied: "You said no, so nothing was done",
    failed: "You allowed it and the hub could not make it, with why",
  },
  field: "state",
  events: {
    Allow: {
      from: ["pending"],
      to: "applying",
      apply: (row, e) => ({ ...row, state: "applying", edited: e.edited, decidedAt: e.at }),
    },
    Deny: {
      from: ["pending"],
      to: "denied",
      apply: (row, e) => ({ ...row, state: "denied", outcome: null, decidedAt: e.at }),
    },
    Made: { from: ["applying"], to: "allowed", apply: (row, e) => ({ ...row, state: "allowed", outcome: e.outcome }) },
    Failed: { from: ["applying"], to: "failed", apply: (row, e) => ({ ...row, state: "failed", outcome: e.outcome }) },
    Reopen: {
      from: ["applying"],
      to: "pending",
      apply: (row) => ({ ...row, state: "pending", edited: null, outcome: null, decidedAt: null }),
    },
  },
  illegal: (row, _, to) => new IllegalHobProposalRowTransition({ rowId: row.id, from: row.state, to }),
});

/** `HobProposalRowMachine` with the questions code outside this module asks of a row's state. */
export const HobProposalRows = {
  ...HobProposalRowMachine,
  /** Whether a row waits for you. */
  isPending: (row: Pick<HobProposalRow, "state">): boolean => row.state === "pending",
  /** Whether a row was allowed and the hub is making it, or a stopped hub left it so. */
  isApplying: (row: Pick<HobProposalRow, "state">): boolean => row.state === "applying",
  /** Whether what a row proposes was made. */
  isMade: (row: Pick<HobProposalRow, "state">): boolean => row.state === "allowed",
  /** Whether a row is decided: allowed, denied or failed. */
  isDecided: (row: Pick<HobProposalRow, "state">): boolean => row.state !== "pending" && row.state !== "applying",
};

/**
 * What can happen to a proposal: its rows or the operations you set to Allow from it change. It
 * settles once every row is decided.
 */
export type HobProposalEvent = {
  readonly _tag: "Update";
  readonly rows: ReadonlyArray<HobProposalRow>;
  readonly alwaysAllowed: ReadonlyArray<CharmOperationId>;
  readonly at: string;
};

/** A change to a proposal its state does not allow. */
export class IllegalHobProposalTransition extends Schema.TaggedError<IllegalHobProposalTransition>()(
  "IllegalHobProposalTransition",
  { proposalId: HobProposalId, from: HobProposalState, to: HobProposalState },
) {}

/** A proposal's lifecycle (ADR 034), declared once: open until every row is decided, then settled for good. */
export const HobProposalMachine = defineMachine<
  HobProposalState,
  HobProposalEvent,
  HobProposal,
  IllegalHobProposalTransition
>({
  name: "HobProposal",
  states: {
    open: "A row waits for you, or the hub is making one you allowed",
    settled: "Every row is decided, and the manager was told how",
  },
  field: "state",
  events: {
    Update: [
      {
        from: ["open"],
        to: "settled",
        guard: (_, e) => e.rows.every(HobProposalRows.isDecided),
        apply: (proposal, e) =>
          new HobProposal({
            ...proposal,
            rows: [...e.rows],
            alwaysAllowed: [...e.alwaysAllowed],
            state: "settled",
            updatedAt: e.at,
            settledAt: e.at,
          }),
      },
      {
        from: ["open"],
        to: "open",
        apply: (proposal, e) =>
          new HobProposal({ ...proposal, rows: [...e.rows], alwaysAllowed: [...e.alwaysAllowed], updatedAt: e.at }),
      },
    ],
  },
  illegal: (proposal, _, to) => new IllegalHobProposalTransition({ proposalId: proposal.id, from: proposal.state, to }),
});

/** Whether a proposal still waits for you. */
export const hobProposalOpen = (proposal: Pick<HobProposal, "state">): boolean => proposal.state === "open";

/** `HobProposalMachine` with the questions code outside this module asks of a proposal's state. */
export const HobProposalStates = {
  ...HobProposalMachine,
  /** Whether a proposal still waits for you. */
  isOpen: hobProposalOpen,
  /** Whether a proposal made anything: a row of it was allowed and made. */
  madeAny: (proposal: Pick<HobProposal, "rows">): boolean => proposal.rows.some(HobProposalRows.isMade),
};

/**
 * What the manager is told once a proposal settles: row by row, what was created, changed or denied.
 * It is the call's answer when the call still waits, and its backpack item otherwise (ADR 019).
 */
export const hobProposalOutcomeText = (proposal: Pick<HobProposal, "rows" | "alwaysAllowed">): string => {
  const lines = proposal.rows.map((row) => {
    switch (row.state) {
      case "applying":
        return `- ${row.label}: the user allowed it, and Hobbots is making it.`;
      case "allowed":
        return `- ${row.label}: the user allowed it. ${row.outcome ?? ""}`.trimEnd();
      case "denied":
        return `- ${row.label}: the user denied it, so nothing was done.`;
      case "failed":
        return `- ${row.label}: the user allowed it, but it could not be done. ${row.outcome ?? ""}`.trimEnd();
      default:
        return `- ${row.label}: the user has not decided it yet.`;
    }
  });
  const always =
    proposal.alwaysAllowed.length === 0
      ? []
      : [`The user set ${proposal.alwaysAllowed.join(", ")} to Allow for you, so calls like it no longer ask.`];
  return ["Hobbots showed the user your proposal as a card, and they decided it row by row:", ...lines, ...always].join(
    "\n",
  );
};
