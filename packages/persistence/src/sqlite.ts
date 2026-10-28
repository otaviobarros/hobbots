import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import { Layer, String as Str } from "effect";
import { migrations } from "./migrations/index.ts";

/** SQLite client with migrations applied; snake_case columns map to camelCase fields. */
export const SqliteLive = (filename: string) =>
  SqliteMigrator.layer({ loader: SqliteMigrator.fromRecord(migrations) }).pipe(
    Layer.provideMerge(
      SqliteClient.layer({
        filename,
        transformQueryNames: Str.camelToSnake,
        transformResultNames: Str.snakeToCamel,
      }),
    ),
  );
