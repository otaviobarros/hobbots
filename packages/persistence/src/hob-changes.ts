import { HobChanges } from "@hobbots/agents";
import {
  AgentConfiguration,
  type AgentId,
  AgentStatus,
  ChangeActor,
  type HobChange,
  type HobChangeOrigin,
  MessageId,
  scopeWork,
  ThreadId,
  YOU,
} from "@hobbots/domain";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { agentRows } from "./repositories.ts";
import { settingChangesReaching } from "./setup.ts";

interface StatusRow {
  readonly agentId: string;
  readonly fromStatus: string;
  readonly status: string;
  readonly actor: string;
  readonly createdAt: string;
}

interface CallRow {
  readonly charm: string;
  readonly threadId: string | null;
  readonly messageId: string | null;
}

const decodeConfigs = Schema.decodeUnknownEffect(Schema.Array(AgentConfiguration));
const decodeActor = Schema.decodeUnknownEffect(Schema.fromJsonString(ChangeActor));
const decodeStatus = Schema.decodeUnknownEffect(AgentStatus);

// In the same instant a status change comes before a version, and a version before a setting change.
const SAME_INSTANT: Record<HobChange["_tag"], number> = { Status: 0, Version: 1, Setting: 2 };

/** Newest first; changes made in the same instant keep the order of `SAME_INSTANT`. */
const newestFirst = (a: HobChange, b: HobChange) =>
  b.at.localeCompare(a.at) || SAME_INSTANT[a._tag] - SAME_INSTANT[b._tag];

/**
 * The SQL change records: configuration versions with their actor (migrations 0007 and 0082) and
 * status changes (0085). The request behind a hob's change is read from its Charm call record
 * (0028) and its call's scope (0045): a call whose record is gone still names its Task or reply.
 */
export const HobChangesLive = Layer.effect(
  HobChanges,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const configs = (rows: ReadonlyArray<Readonly<Record<string, unknown>>>) =>
      decodeConfigs(agentRows(rows)).pipe(Effect.orDie);

    const threadOf = (messageId: string) =>
      sql<{ readonly threadId: string }>`SELECT thread_id FROM messages WHERE id = ${messageId}`.pipe(
        Effect.map((rows) => rows[0]?.threadId ?? null),
      );

    const originOf = (actor: ChangeActor) =>
      Effect.gen(function* () {
        if (actor._tag === "You") return null;
        const { scope, key } = actor.call;
        const work = scopeWork(scope);
        const [call] = yield* sql<CallRow>`SELECT charm, thread_id, message_id FROM charm_calls
          WHERE agent_id = ${actor.hobId} AND scope = ${scope} AND call_key = ${key}
          ORDER BY created_at DESC LIMIT 1`;
        const messageId = call?.messageId ?? work.messageId;
        const threadId = call?.threadId ?? (messageId === null ? null : yield* threadOf(messageId));
        return {
          charm: call?.charm ?? null,
          taskId: work.taskId,
          threadId: threadId === null ? null : ThreadId.make(threadId),
          messageId: messageId === null ? null : MessageId.make(messageId),
        } satisfies HobChangeOrigin;
      });

    // Each version with the one before it, read once per hob for the versions not already at hand.
    const versionChanges = (versions: ReadonlyArray<AgentConfiguration>) =>
      Effect.gen(function* () {
        const byKey = new Map(versions.map((config) => [`${config.agentId}/${config.version}`, config]));
        const wanted = new Map<string, Array<number>>();
        for (const config of versions) {
          if (config.version > 1 && !byKey.has(`${config.agentId}/${config.version - 1}`)) {
            wanted.set(config.agentId, [...(wanted.get(config.agentId) ?? []), config.version - 1]);
          }
        }
        for (const [agentId, numbers] of wanted) {
          const earlier = yield* sql`SELECT * FROM agent_config_versions
            WHERE agent_id = ${agentId} AND ${sql.in("version", numbers)}`.pipe(Effect.flatMap(configs));
          for (const config of earlier) byKey.set(`${config.agentId}/${config.version}`, config);
        }
        return yield* Effect.forEach(
          versions,
          (config): Effect.Effect<HobChange, unknown> =>
            originOf(config.actor).pipe(
              Effect.map((origin) => ({
                _tag: "Version",
                hobId: config.agentId,
                at: config.createdAt,
                actor: config.actor,
                origin,
                config,
                previous: byKey.get(`${config.agentId}/${config.version - 1}`) ?? null,
              })),
            ),
        );
      });

    const statusChanges = (rows: ReadonlyArray<StatusRow>) =>
      Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const actor = yield* decodeActor(row.actor);
          return {
            _tag: "Status",
            hobId: row.agentId as AgentId,
            at: row.createdAt,
            actor,
            origin: yield* originOf(actor),
            from: yield* decodeStatus(row.fromStatus),
            status: yield* decodeStatus(row.status),
          } satisfies HobChange;
        }),
      );

    const assemble = (versions: ReadonlyArray<AgentConfiguration>, statuses: ReadonlyArray<StatusRow>) =>
      Effect.all([versionChanges(versions), statusChanges(statuses)]).pipe(
        Effect.map(([a, b]) => [...a, ...b].sort(newestFirst)),
      );

    /**
     * The hub setting changes that reached the hob (#1357), as each recorded the hobs it reached
     * when it was made.
     */
    const settingChanges = (hobId: AgentId) =>
      Effect.map(settingChangesReaching(sql, hobId), (found) =>
        found.map(
          (setting): HobChange => ({ _tag: "Setting", hobId, at: setting.at, actor: YOU, origin: null, setting }),
        ),
      );

    return HobChanges.of({
      forHob: (hobId) =>
        Effect.gen(function* () {
          const versions = yield* sql`SELECT * FROM agent_config_versions WHERE agent_id = ${hobId}
            ORDER BY version DESC`.pipe(Effect.flatMap(configs));
          const statuses = yield* sql<StatusRow>`SELECT * FROM agent_status_changes WHERE agent_id = ${hobId}
            ORDER BY revision DESC`;
          const settings = yield* settingChanges(hobId);
          return [...(yield* assemble(versions, statuses)), ...settings].sort(newestFirst);
        }).pipe(Effect.orDie),
      latest: (limit) =>
        Effect.gen(function* () {
          const versions = yield* sql`SELECT * FROM agent_config_versions
            ORDER BY created_at DESC, version DESC LIMIT ${limit}`.pipe(Effect.flatMap(configs));
          const statuses = yield* sql<StatusRow>`SELECT * FROM agent_status_changes
            ORDER BY revision DESC LIMIT ${limit}`;
          return (yield* assemble(versions, statuses)).slice(0, limit);
        }).pipe(Effect.orDie),
    });
  }),
);
