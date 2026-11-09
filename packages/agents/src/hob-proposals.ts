import {
  type DeviceRevoked,
  HobProposalChangedSince,
  HobProposalDecided,
  type HobProposalError,
  HobProposalMissing,
  HobProposalNotAlwaysAllowable,
  HobProposalNotConfirmed,
  type HobProposalRefused,
  type HobProposalView,
  UserSession,
} from "@hobbots/api";
import {
  type AgentId,
  type ChangeCall,
  type CharmOperationId,
  type Committed,
  ConfigVersion,
  everyRowDecided,
  HobProposal,
  HobProposalId,
  type HobProposalKind,
  type HobProposalRow,
  hobProposalOutcomeText,
  INBOX_HISTORY,
  type MessageId,
  type SummoningDraft,
  type TaskId,
  type ThreadId,
} from "@hobbots/domain";
import { Context, DateTime, Deferred, Effect, Layer, Option, Semaphore } from "effect";
import { CharmCalls } from "./charm-calls.ts";
import { HobProposalLog } from "./hob-proposal-log.ts";
import { announcer, EventPublisher } from "./ports.ts";

/**
 * Hob proposals (ADR 034, Asking is a proposal): a Summoning Charm call that asks is recorded as a
 * proposal on the manager's call, which needs no user session and grants nothing. Only you decide
 * a row, edit it, press "Always allow" and apply it, through use cases that require a `UserSession`
 * (PE-006), so no hob, the manager included, can decide or apply its own proposal. The call waits
 * for the proposal to settle while its turn runs; once it stops waiting, the outcome goes to the
 * manager's backpack (ADR 019).
 */

/** How the hub makes one row you allowed, bound by the Summoning Charm, which knows the hob use cases. */
export interface HobProposalApplier {
  /**
   * Makes the row as you, on the manager's proposal, checked as the call was: `edited` is your
   * version of a summon row. Refused, nothing is made and the row still waits.
   */
  readonly apply: (
    proposal: HobProposal,
    row: HobProposalRow,
    edited: SummoningDraft | null,
  ) => Effect.Effect<{ readonly _tag: "Applied" | "Failed"; readonly text: string }, HobProposalRefused>;
  /** Whether the row's hob changed since the row was made, so it is never applied. */
  readonly changedSince: (row: HobProposalRow) => Effect.Effect<boolean>;
  /**
   * Sets `operation` to Allow on the manager's Summoning Charm, as a change made by you, and gives the
   * manager's configuration version before and after it.
   */
  readonly alwaysAllow: (
    proposal: HobProposal,
    operation: CharmOperationId,
  ) => Effect.Effect<{ readonly before: number; readonly after: number }, HobProposalRefused>;
  /**
   * For a row left `applying` when the hub stopped: what it made, read from the hob, or null when the
   * hob shows nothing of it, so the row waits for you again.
   */
  readonly reconcile: (proposal: HobProposal, row: HobProposalRow) => Effect.Effect<string | null>;
}

/** What a Summoning call's plan gives to record a proposal. */
export interface HobProposalInput {
  readonly agentId: AgentId;
  readonly kind: HobProposalKind;
  readonly tool: string;
  readonly call: ChangeCall;
  readonly threadId: ThreadId | null;
  readonly messageId: MessageId | null;
  readonly taskId: TaskId | null;
  readonly stepId: string | null;
  readonly rows: ReadonlyArray<HobProposalRow>;
  readonly asks: ReadonlyArray<CharmOperationId>;
  readonly safety: string | null;
  readonly highRisk: boolean;
}

/** A proposal's next state as written, and what waits for it to commit: its events and the call that waits. */
interface Stored {
  readonly saved: HobProposal;
  readonly entries: Committed<HobProposal>["entries"];
  readonly waiter: Deferred.Deferred<HobProposal> | undefined;
}

/** A row ready to record: pending, undecided, with nothing edited yet. */
export const pendingRow = (
  row: Omit<HobProposalRow, "state" | "outcome" | "decidedAt" | "edited">,
): HobProposalRow => ({ ...row, edited: null, state: "pending", outcome: null, decidedAt: null });

export class HobProposals extends Context.Service<
  HobProposals,
  {
    /**
     * Records a proposal on the manager's call. `settled` waits for it to settle and gives it as it
     * settled; once the waiting call is interrupted, the outcome goes to the manager's backpack.
     */
    readonly propose: (
      input: HobProposalInput,
    ) => Effect.Effect<{ readonly proposal: HobProposal; readonly settled: Effect.Effect<HobProposal> }>;
    /** Binds how rows are made, where the Summoning Charm is built. */
    readonly bindApplier: (applier: HobProposalApplier) => Effect.Effect<void>;
    /** What waits for you, then the latest that settled, as their cards show them. */
    readonly list: Effect.Effect<ReadonlyArray<HobProposalView>>;
    readonly get: (id: string) => Effect.Effect<HobProposalView, HobProposalMissing>;
    readonly allow: (
      id: string,
      rowId: string,
      options: { readonly edited?: SummoningDraft | undefined; readonly confirmed?: boolean | undefined },
    ) => Effect.Effect<HobProposalView, HobProposalError | DeviceRevoked, UserSession>;
    readonly deny: (
      id: string,
      rowId: string,
    ) => Effect.Effect<HobProposalView, HobProposalError | DeviceRevoked, UserSession>;
    readonly allowAll: (
      id: string,
      options: { readonly confirmed?: boolean | undefined },
    ) => Effect.Effect<HobProposalView, HobProposalError | DeviceRevoked, UserSession>;
    readonly denyAll: (id: string) => Effect.Effect<HobProposalView, HobProposalError | DeviceRevoked, UserSession>;
    readonly alwaysAllow: (
      id: string,
      operation: CharmOperationId,
    ) => Effect.Effect<HobProposalView, HobProposalError | DeviceRevoked, UserSession>;
  }
>()("@hobbots/agents/HobProposals") {
  static readonly layer = Layer.effect(
    HobProposals,
    Effect.gen(function* () {
      const log = yield* HobProposalLog;
      const calls = yield* CharmCalls;
      const publish = announcer(yield* Effect.serviceOption(EventPublisher), "a hob proposal");
      const applier = yield* Deferred.make<HobProposalApplier>();
      // One decision at a time, so two decisions on one row never both make it.
      const lock = yield* Semaphore.make(1);
      /** The calls that wait for a proposal to settle, by proposal. */
      const waiters = new Map<string, Deferred.Deferred<HobProposal>>();

      const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

      /** Waits for `proposal` to settle; leaving the wait leaves its outcome to the backpack. */
      const waitFor = (proposal: HobProposal) =>
        Effect.gen(function* () {
          if (proposal.state === "settled") return Effect.succeed(proposal);
          const settled = waiters.get(proposal.id) ?? (yield* Deferred.make<HobProposal>());
          waiters.set(proposal.id, settled);
          return Deferred.await(settled).pipe(
            Effect.onInterrupt(() => Effect.sync(() => waiters.delete(proposal.id))),
            Effect.ensuring(Effect.sync(() => waiters.delete(proposal.id))),
          );
        });

      const viewOf = (proposal: HobProposal) =>
        Effect.gen(function* () {
          if (proposal.state === "settled") return { proposal, changedSince: [] } satisfies HobProposalView;
          const apply = yield* Deferred.await(applier);
          const changed = yield* Effect.filter(
            proposal.rows.filter((row) => row.state === "pending"),
            (row) => apply.changedSince(row),
          );
          return { proposal, changedSince: changed.map((row) => row.id) } satisfies HobProposalView;
        });

      const find = (id: string) =>
        Effect.flatMap(
          log.get(HobProposalId.make(id)),
          Option.match({
            onNone: () => Effect.fail(new HobProposalMissing({ proposalId: id })),
            onSome: Effect.succeed,
          }),
        );

      /** The rows with `id`'s replaced by `row`. */
      const withRow = (rows: ReadonlyArray<HobProposalRow>, row: HobProposalRow) =>
        rows.map((each) => (each.id === row.id ? row : each));

      /**
       * Settles the manager's keyed call when no call waits for the proposal any more (ADR 031): a
       * call the hub left uncertain, or one whose turn stopped, ends with the proposal's outcome.
       */
      const settleCall = (proposal: HobProposal) =>
        Effect.gen(function* () {
          const call = yield* calls.find(proposal.agentId, [proposal.call.scope], proposal.call.key);
          if (Option.isNone(call) || (call.value.state !== "sending" && call.value.state !== "uncertain")) return;
          const made = proposal.rows.some((row) => row.state === "allowed");
          yield* calls.settle(
            call.value,
            made ? "applied" : "refused",
            hobProposalOutcomeText(proposal),
            yield* nowIso,
          );
        });

      /**
       * Writes the proposal's next state; once every row is decided it settles, and a call no longer
       * waiting hears how. What is announced, and the call that waits, wait for the write to commit.
       */
      const store = (
        proposal: HobProposal,
        rows: ReadonlyArray<HobProposalRow>,
        alwaysAllowed = proposal.alwaysAllowed,
      ) =>
        Effect.gen(function* () {
          const at = yield* nowIso;
          const settles = everyRowDecided(rows);
          const next = new HobProposal({
            ...proposal,
            rows,
            alwaysAllowed,
            state: settles ? "settled" : "open",
            updatedAt: at,
            settledAt: settles ? at : null,
          });
          const waiter = settles ? waiters.get(proposal.id) : undefined;
          const moved = yield* log.move(next, { unwaited: settles && waiter === undefined });
          if (Option.isNone(moved)) {
            const now = yield* find(proposal.id);
            return yield* new HobProposalDecided({ proposalId: proposal.id, state: now.state });
          }
          const saved = moved.value.value;
          if (settles && waiter === undefined) yield* settleCall(saved);
          return { saved, entries: moved.value.entries, waiter } satisfies Stored;
        });

      /** Once a write committed: announces it, and wakes the call that waits for the proposal to settle. */
      const announce = (stored: Stored) =>
        Effect.gen(function* () {
          yield* publish(stored.entries);
          if (stored.waiter !== undefined) yield* Deferred.succeed(stored.waiter, stored.saved);
          return stored.saved;
        });

      /** Saves what the hub found or made, whoever's device asked. */
      const save = (proposal: HobProposal, rows: ReadonlyArray<HobProposalRow>) =>
        Effect.flatMap(store(proposal, rows), announce);

      /** Saves your decision, in one transaction that first checks your device is still approved (PE-006). */
      const saveDecision = (
        session: UserSession["Service"],
        proposal: HobProposal,
        rows: ReadonlyArray<HobProposalRow>,
      ) => Effect.flatMap(session.whileApproved(store(proposal, rows)), announce);

      /**
       * A row the hub stopped while making is checked against its hob before anything else decides
       * the proposal: allowed when the hob shows it was made, else waiting for you again.
       */
      const reconciled = (proposal: HobProposal) =>
        Effect.gen(function* () {
          const applying = proposal.rows.filter((row) => row.state === "applying");
          if (applying.length === 0) return proposal;
          const apply = yield* Deferred.await(applier);
          let rows = proposal.rows;
          for (const row of applying) {
            const made = yield* apply.reconcile(proposal, row);
            rows = withRow(
              rows,
              made === null
                ? { ...row, edited: null, state: "pending", outcome: null, decidedAt: null }
                : { ...row, state: "allowed", outcome: made },
            );
          }
          return yield* save(proposal, rows);
        });

      const open = (id: string) =>
        Effect.gen(function* () {
          const proposal = yield* Effect.flatMap(find(id), reconciled);
          if (proposal.state !== "open") {
            return yield* new HobProposalDecided({ proposalId: id, state: proposal.state });
          }
          return proposal;
        });

      const pendingRowOf = (proposal: HobProposal, rowId: string) => {
        const row = proposal.rows.find((each) => each.id === rowId);
        if (row === undefined) return Effect.fail(new HobProposalMissing({ proposalId: proposal.id, rowId }));
        if (row.state !== "pending") {
          return Effect.fail(
            new HobProposalDecided({ proposalId: proposal.id, state: proposal.state, rowId, rowState: row.state }),
          );
        }
        return Effect.succeed(row);
      };

      /**
       * Makes one row you allowed. The row is saved as applying before anything is made, under your
       * device's check, then as what came of it. A row the hub refuses waits for you again, or, under
       * Allow all, ends as failed with why, so the others still go ahead.
       */
      const allowRow = (
        session: UserSession["Service"],
        proposal: HobProposal,
        row: HobProposalRow,
        options: { readonly edited: SummoningDraft | null; readonly at: string; readonly refusedFails: boolean },
      ) =>
        Effect.gen(function* () {
          const apply = yield* Deferred.await(applier);
          if (yield* apply.changedSince(row)) {
            return yield* new HobProposalChangedSince({ proposalId: proposal.id, rowId: row.id });
          }
          const applying: HobProposalRow = { ...row, edited: options.edited, state: "applying", decidedAt: options.at };
          const marked = yield* saveDecision(session, proposal, withRow(proposal.rows, applying));
          const made = yield* apply
            .apply(marked, row, options.edited)
            .pipe(
              Effect.catchTag("HobProposalRefused", (refused) =>
                options.refusedFails
                  ? Effect.succeed({ _tag: "Failed", text: refused.message } as const)
                  : Effect.flatMap(save(marked, withRow(marked.rows, row)), () => Effect.fail(refused)),
              ),
            );
          const state = made._tag === "Applied" ? "allowed" : "failed";
          return yield* save(marked, withRow(marked.rows, { ...applying, state, outcome: made.text }));
        });

      const denied = (row: HobProposalRow, at: string): HobProposalRow => ({
        ...row,
        state: "denied",
        outcome: null,
        decidedAt: at,
      });

      const confirmedFor = (proposal: HobProposal, confirmed: boolean | undefined) =>
        proposal.highRisk && confirmed !== true
          ? Effect.fail(new HobProposalNotConfirmed({ proposalId: proposal.id }))
          : Effect.void;

      /**
       * A decision of yours: one at a time, so two decisions on one row never both make it, and whole
       * once started, so a request that goes away leaves no row half decided.
       */
      const decide = <E>(decision: (session: UserSession["Service"]) => Effect.Effect<HobProposal, E>) =>
        Effect.gen(function* () {
          const session = yield* UserSession;
          const saved = yield* Semaphore.withPermit(lock, Effect.uninterruptible(decision(session)));
          return yield* viewOf(saved);
        });

      return HobProposals.of({
        propose: (input) =>
          Effect.gen(function* () {
            const at = yield* nowIso;
            const committed = yield* log.insert(
              new HobProposal({
                ...input,
                id: HobProposalId.make(crypto.randomUUID()),
                rows: [...input.rows],
                asks: [...input.asks],
                alwaysAllowed: [],
                state: "open",
                createdAt: at,
                updatedAt: at,
                settledAt: null,
              }),
            );
            yield* publish(committed.entries);
            return { proposal: committed.value, settled: yield* waitFor(committed.value) };
          }),
        bindApplier: (bound) => Deferred.succeed(applier, bound).pipe(Effect.asVoid),
        list: Effect.flatMap(log.list(INBOX_HISTORY), (proposals) => Effect.forEach(proposals, viewOf)),
        get: (id) => Effect.flatMap(find(id), viewOf),
        allow: (id, rowId, options) =>
          decide((session) =>
            Effect.gen(function* () {
              const proposal = yield* open(id);
              const row = yield* pendingRowOf(proposal, rowId);
              yield* confirmedFor(proposal, options.confirmed);
              const edited = options.edited ?? null;
              if (edited !== null && proposal.kind !== "summon") {
                return yield* new HobProposalMissing({ proposalId: id, rowId });
              }
              return yield* allowRow(session, proposal, row, { edited, at: yield* nowIso, refusedFails: false });
            }),
          ),
        deny: (id, rowId) =>
          decide((session) =>
            Effect.gen(function* () {
              const proposal = yield* open(id);
              const row = yield* pendingRowOf(proposal, rowId);
              return yield* saveDecision(session, proposal, withRow(proposal.rows, denied(row, yield* nowIso)));
            }),
          ),
        allowAll: (id, options) =>
          decide((session) =>
            Effect.gen(function* () {
              let proposal = yield* open(id);
              yield* confirmedFor(proposal, options.confirmed);
              const at = yield* nowIso;
              const apply = yield* Deferred.await(applier);
              // A row whose hob changed since is never applied: Allow all leaves it for you to deny.
              for (const row of proposal.rows) {
                if (row.state !== "pending" || (yield* apply.changedSince(row))) continue;
                proposal = yield* allowRow(session, proposal, row, { edited: null, at, refusedFails: true });
              }
              return proposal;
            }),
          ),
        denyAll: (id) =>
          decide((session) =>
            Effect.gen(function* () {
              const proposal = yield* open(id);
              const at = yield* nowIso;
              return yield* saveDecision(
                session,
                proposal,
                proposal.rows.map((row) => (row.state === "pending" ? denied(row, at) : row)),
              );
            }),
          ),
        alwaysAllow: (id, operation) =>
          decide((session) =>
            Effect.gen(function* () {
              const proposal = yield* open(id);
              if (!proposal.asks.includes(operation) || proposal.alwaysAllowed.includes(operation)) {
                return yield* new HobProposalNotAlwaysAllowable({ proposalId: id, operation });
              }
              const apply = yield* Deferred.await(applier);
              // The policy change and the proposal that says so commit together, under your device's check.
              const stored = yield* session.whileApproved(
                Effect.gen(function* () {
                  const version = yield* apply.alwaysAllow(proposal, operation);
                  // A row on the manager itself made before this change is still yours to allow: the
                  // change it would otherwise read as "changed since" is this one.
                  const rows = proposal.rows.map(
                    (row): HobProposalRow =>
                      row.state === "pending" && row.hobId === proposal.agentId && row.configVersion === version.before
                        ? { ...row, configVersion: ConfigVersion.make(version.after) }
                        : row,
                  );
                  return yield* store(proposal, rows, [...proposal.alwaysAllowed, operation]);
                }),
              );
              return yield* announce(stored);
            }),
          ),
      });
    }),
  );
}
