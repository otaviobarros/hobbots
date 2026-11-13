import { UserRepository } from "@hobbots/agents";
import { OWNER_USER_ID, User, UserId } from "@hobbots/domain";
import { Effect, Layer, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

// By id in byte order on both dialects, like `oldestFirst`.
const byId = (sql: SqlClient.SqlClient) =>
  sql.onDialectOrElse({ pg: () => sql.literal(`id COLLATE "C"`), orElse: () => sql.literal("id") });

/** The SQL store of users, for SQLite and PostgreSQL (migration 0111). */
export const UserRepositoryLive = Layer.effect(
  UserRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const find = SqlSchema.findOneOption({
      Request: UserId,
      Result: User,
      execute: (id) => sql`SELECT id, name, initials, color, state FROM users WHERE id = ${id}`,
    });
    const list = SqlSchema.findAll({
      Request: Schema.Void,
      Result: User,
      execute: () =>
        sql`SELECT id, name, initials, color, state FROM users
          ORDER BY CASE WHEN id = ${OWNER_USER_ID} THEN 0 ELSE 1 END, ${byId(sql)}`,
    });
    return UserRepository.of({
      find: (id) => find(id).pipe(Effect.orDie),
      list: list(undefined).pipe(Effect.orDie),
    });
  }),
);
