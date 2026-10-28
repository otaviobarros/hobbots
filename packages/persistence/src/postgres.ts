import { NodeServices } from "@effect/platform-node";
import { PgClient, PgMigrator } from "@effect/sql-pg";
import { Layer, Redacted, String as Str } from "effect";
import { migrations } from "./migrations/index.ts";

/**
 * PostgreSQL client with migrations applied; snake_case columns map to camelCase fields.
 * Runs the same migrations and repositories as `SqliteLive` (ADR 011).
 */
export const PgLive = (url: string) => makePgLive({ url: Redacted.make(url) });

/** Builds `PgLive` from a full client config, for callers such as tests that set session defaults. */
export const makePgLive = (config: PgClient.PgPoolConfig) =>
  PgMigrator.layer({ loader: PgMigrator.fromRecord(migrations) }).pipe(
    Layer.provideMerge(
      PgClient.layer({
        ...config,
        transformQueryNames: Str.camelToSnake,
        transformResultNames: Str.snakeToCamel,
      }),
    ),
    // PgMigrator needs process and file services only to dump a schema, which this layer never does.
    Layer.provide(NodeServices.layer),
  );
