import { MemoryVersionAuthors } from "@hobbots/agents";
import { MemoryAuthor, MemoryVersion, memoryScopeKey } from "@hobbots/domain";
import { Array as Arr, DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

/** How many versions one statement reads, well inside both databases' limits on parameters. */
const BATCH = 500;

const AuthorJson = Schema.fromJsonString(MemoryAuthor);
const encodeAuthor = Schema.encodeSync(AuthorJson);
const decodeAuthor = Schema.decodeUnknownEffect(AuthorJson);

/** Who wrote each memory version the hub sent (migration 0094, #1317). */
export const MemoryVersionAuthorsLive = Layer.effect(
  MemoryVersionAuthors,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return MemoryVersionAuthors.of({
      // A version is written once, so a second record of it, as a retried write's, changes nothing.
      record: (scope, path, version, author) =>
        Effect.gen(function* () {
          const at = DateTime.formatIso(yield* DateTime.now);
          yield* sql`INSERT INTO memory_version_authors ${sql.insert({
            version,
            scope: memoryScopeKey(scope),
            path,
            author: encodeAuthor(author),
            recorded_at: at,
          })} ON CONFLICT (version) DO NOTHING`;
        }).pipe(Effect.orDie),
      of: (versions) =>
        Effect.forEach(
          Arr.chunksOf([...new Set(versions)], BATCH),
          (some) =>
            sql<{ version: string; author: string }>`SELECT version, author FROM memory_version_authors
            WHERE ${sql.in("version", some)}`,
        ).pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows.flat(), (row) =>
              Effect.map(decodeAuthor(row.author), (author) => [MemoryVersion.make(row.version), author] as const),
            ),
          ),
          Effect.map((found) => new Map(found)),
          Effect.orDie,
        ),
      forget: (scope, path) =>
        sql`DELETE FROM memory_version_authors WHERE scope = ${memoryScopeKey(scope)} AND path = ${path}`.pipe(
          Effect.asVoid,
          Effect.orDie,
        ),
    });
  }),
);
