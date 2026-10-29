import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import { Layer, String as Str } from "effect";
import { migrations } from "./migrations/index.ts";

/**
 * SQLite client with migrations applied; snake_case columns map to camelCase fields.
 * Tests pass an earlier subset of `migrations` to check a migration against existing rows.
 */
export const SqliteLive = (filename: string, record = migrations) =>
  SqliteMigrator.layer({ loader: SqliteMigrator.fromRecord(record) }).pipe(
    Layer.provideMerge(
      SqliteClient.layer({
        filename,
        transformQueryNames: Str.camelToSnake,
        transformResultNames: Str.snakeToCamel,
      }),
    ),
  );
