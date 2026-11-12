import { CharmCall, type CharmDeclaration, isCharmCallSettled } from "@hobbots/domain";
import { Effect, Layer, Option, Schema } from "effect";
import type { AskableVerdict } from "./asking.ts";
import { CharmCalls } from "./charm-calls.ts";
import {
  type Charm,
  type CharmOffer,
  Charms,
  type CharmTurn,
  defineCharm,
  joinHubTools,
  takeoversOf,
} from "./charms.ts";
import { hubAction } from "./hub-actions.ts";

/** Test doubles for the agents package's ports, for this package's tests and its callers'. */

const idOf = (agentId: string, scope: string, key: string) => `${agentId} ${scope} ${key}`;

/** Charm call records in memory, with the rules of the SQL ones (migrations 0028 and 0045), by hob, scope and key. */
export const memoryCharmCalls = (rows: Map<string, CharmCall> = new Map()) => {
  /** `call`'s sending, by its attempt, in whatever scope it is now. */
  const sending = (call: CharmCall) =>
    [...rows.entries()].find(
      ([, row]) => row.agentId === call.agentId && row.key === call.key && row.attempt === call.attempt,
    );
  return Layer.succeed(
    CharmCalls,
    CharmCalls.of({
      begin: (call, also) =>
        Effect.sync(() => {
          const id = idOf(call.agentId, call.scope, call.key);
          const earlier = also === undefined ? undefined : rows.get(idOf(call.agentId, also, call.key));
          const stored = rows.get(id) ?? earlier;
          const replaces = stored?.state === "not-sent" && stored.input === call.input;
          if (stored !== undefined && !replaces) return { _tag: "Existing", call: stored } as const;
          const busy = [...rows.values()].find(
            (row) => row.tool === call.tool && row.site === call.site && !isCharmCallSettled(row.state),
          );
          if (busy !== undefined) return { _tag: "Blocked", call: busy } as const;
          if (replaces && stored.scope !== call.scope) rows.delete(idOf(call.agentId, stored.scope, call.key));
          rows.set(id, call);
          return { _tag: "Started" } as const;
        }),
      settle: (call, state, result, at) =>
        Effect.sync(() => {
          const [id, stored] = sending(call) ?? [];
          if (id === undefined || stored === undefined || isCharmCallSettled(stored.state)) return Option.none();
          const next = new CharmCall({ ...stored, state, result, updatedAt: at });
          rows.set(id, next);
          return Option.some(next);
        }),
      current: (call) => Effect.sync(() => Option.fromUndefinedOr(sending(call)?.[1])),
      find: (agentId, scopes, key) =>
        Effect.sync(() =>
          Option.fromUndefinedOr(
            scopes.map((scope) => rows.get(idOf(agentId, scope, key))).find((row) => row !== undefined),
          ),
        ),
      findByStep: (threadId, messageId, stepId) =>
        Effect.sync(() =>
          Option.fromUndefinedOr(
            [...rows.values()].find(
              (row) => row.threadId === threadId && row.messageId === messageId && row.stepId === stepId,
            ),
          ),
        ),
      listForThread: (threadId) => Effect.sync(() => [...rows.values()].filter((row) => row.threadId === threadId)),
      findSending: (scope, attempt) =>
        Effect.sync(() =>
          Option.fromUndefinedOr([...rows.values()].find((row) => row.scope === scope && row.attempt === attempt)),
        ),
      uncertainOnTasks: Effect.sync(() =>
        [...rows.values()].filter(
          (row) => row.state === "uncertain" && row.messageId === null && row.scope.startsWith("task:"),
        ),
      ),
      unsettled: Effect.sync(() => [...rows.values()].filter((row) => !isCharmCallSettled(row.state))),
    }),
  );
};

/**
 * The Charm tools a turn is offered, joined into one set as a runtime gets them beside the other hub
 * tools, or null when it is offered none.
 */
export const charmToolsFor = (turn: CharmTurn, offer?: CharmOffer) =>
  Charms.use((charms) => charms.forTurn(turn, offer)).pipe(Effect.map(joinHubTools));

/** The built-in requests the Charms a turn is offered take over, as the runtimes steer them (ADR 031). */
export const charmTakeoversFor = (turn: CharmTurn, offer?: CharmOffer) =>
  Charms.use((charms) => charms.forTurn(turn, offer)).pipe(Effect.map(takeoversOf));

// A fake Charm (ADR 031), for tests that register Charms other than GitHub.

const allowed = (operation: `${string}.${string}`): AskableVerdict => ({
  decision: "allow",
  operation,
  reason: { message: "The policy allows it." },
  targets: [],
  onceOnly: false,
  grantable: false,
  rules: [],
  grantIds: [],
  policyVersion: "v1",
});

/**
 * The declaration of a fake Charm called `id`: a read and a write, allowed under every preset, and
 * Push when it `takesOverPush`.
 */
export const fakeCharmDeclaration = (id: string, takesOverPush = false): CharmDeclaration => ({
  id,
  operations: ["read", "write"].map((operation) => ({
    id: `${id}.${operation}` as const,
    words: `${operation} with ${id}`,
    presets: { careful: "allow", balanced: "allow", trusting: "allow" },
    site: [],
    onceOnly: false,
    actsAsIdentity: false,
  })),
  takesOver: takesOverPush ? ["push"] : [],
});

const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object" }, label: name });

export interface FakeCharm {
  readonly id: string;
  readonly name: string;
  /** Its tools' names, `<id>_read` and `<id>_write` unless given. */
  readonly read?: string;
  readonly write?: string;
  readonly connected?: boolean;
  /** The folders a `git push` is made with its write from instead, folders inside them included. */
  readonly pushesFrom?: ReadonlyArray<string>;
}

/** A Charm whose read answers its name, and whose write ends uncertain and is found applied when read back. */
export const fakeCharm = (charm: FakeCharm): Effect.Effect<Charm> => {
  const prefix = charm.id.replaceAll("-", "_");
  const read = charm.read ?? `${prefix}_read`;
  const write = charm.write ?? `${prefix}_write`;
  const request = (operation: string) => ({
    _tag: "Charm",
    charm: charm.id,
    operation: `${charm.id}.${operation}`,
    site: {},
  });
  const { pushesFrom } = charm;
  return Effect.succeed(
    defineCharm({
      declaration: fakeCharmDeclaration(charm.id, pushesFrom !== undefined),
      name: charm.name,
      actions: [
        hubAction({
          tool: tool(read),
          input: Schema.Struct({}),
          effect: "read",
          otherwise: `${charm.name} cannot be read`,
          plan: () => Effect.succeed({ request: request("read"), card: { arguments: {} }, send: Effect.succeed(read) }),
        }),
        hubAction({
          tool: tool(write),
          input: Schema.Struct({}),
          effect: "write",
          otherwise: `nothing was written to ${charm.name}`,
          readBack: () => Effect.succeed(true),
          plan: () =>
            Effect.succeed({
              request: request("write"),
              card: { arguments: {} },
              write: {
                site: charm.id,
                recorded: {},
                appliedText: `${charm.name} shows it took effect.`,
                send: Effect.succeed({ _tag: "Uncertain", text: "No answer." } as const),
              },
            }),
        }),
      ],
      decide: (_approvals, _base, planned) => () => Effect.succeed(allowed(planned.operation as `${string}.${string}`)),
      connected: () => Effect.succeed(charm.connected ?? true),
      ...(pushesFrom === undefined
        ? {}
        : {
            takeovers: [
              {
                operation: "push",
                tool: write,
                appliesIn: (_turn, cwd) =>
                  Effect.succeed(pushesFrom.some((folder) => cwd === folder || cwd.startsWith(`${folder}/`))),
              },
            ],
          }),
    }),
  );
};
