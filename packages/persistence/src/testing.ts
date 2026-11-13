import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { PgClient } from "@effect/sql-pg";
import type { User } from "@hobbots/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { migrations } from "./migrations/index.ts";
import { makePgLive } from "./postgres.ts";
import { SqliteLive } from "./sqlite.ts";

/**
 * Test-only database with migrations applied, chosen by `HOBBOTS_TEST_DB`:
 * - `sqlite` (default): a fresh in-memory SQLite database.
 * - `postgres`: a fresh database on the PostgreSQL server at `HOBBOTS_TEST_DATABASE_URL`, copied
 *   from a template database the first test migrates, and dropped again when the layer is
 *   released. With only some migrations, a fresh schema in that database instead.
 *
 * Every build of the layer is isolated, so test runs never see each other's rows.
 */
export const TestDatabase = Layer.unwrap(Effect.sync(() => testDatabase(migrations)));

/** `TestDatabase` with only the given migrations applied, to check a later one against existing rows. */
export const TestDatabaseAt = (record: typeof migrations) => Layer.unwrap(Effect.sync(() => testDatabase(record)));

/**
 * Adds a person to the hub for tests that play several people (ADR 039): the hub itself has no way
 * to add one until accounts exist. A user already there is left as it is.
 */
export const addTestUser = (user: User) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO users (id, name, initials, color, state)
      VALUES (${user.id}, ${user.name}, ${user.initials}, ${user.color}, ${user.state})
      ON CONFLICT (id) DO NOTHING`;
  }).pipe(Effect.orDie);

const testDatabase = (record: typeof migrations) => {
  const db = process.env.HOBBOTS_TEST_DB || "sqlite";
  if (db === "sqlite") return SqliteLive(":memory:", record);
  if (db === "postgres") {
    const url = process.env.HOBBOTS_TEST_DATABASE_URL;
    if (!url) throw new Error("HOBBOTS_TEST_DB=postgres needs HOBBOTS_TEST_DATABASE_URL");
    return record === migrations ? PgCopyLive(url) : PgSchemaLive(Redacted.make(url), record);
  }
  throw new Error(`Unknown HOBBOTS_TEST_DB "${db}"; use "sqlite" or "postgres"`);
};

const PgSchemaLive = (url: Redacted.Redacted, record: typeof migrations) => {
  const schema = `hobbots_test_${randomUUID().replaceAll("-", "")}`;
  // Creates the schema before the client connects and drops it after the client closes.
  const Schema = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.acquireRelease(sql`CREATE SCHEMA ${sql(schema)}`, () =>
        sql`DROP SCHEMA ${sql(schema)} CASCADE`.pipe(Effect.ignore),
      );
    }),
  ).pipe(Layer.provide(PgClient.layer({ url, maxConnections: 1 })));
  return makePgLive({ url, startupParameters: { search_path: schema } }, record).pipe(Layer.provide(Schema));
};

/** The URL of database `name` on the server at `url`. */
const databaseUrl = (url: string, name: string) => {
  const at = new URL(url);
  at.pathname = `/${name}`;
  return Redacted.make(at.toString());
};

/**
 * The template's name follows the migrations' source, so a changed or added migration gets a
 * template of its own instead of copies of one that lacks it.
 */
const templateName = () => {
  const folder = new URL("migrations/", import.meta.url);
  const hash = createHash("sha256");
  for (const file of readdirSync(folder).sort()) hash.update(file).update(readFileSync(new URL(file, folder)));
  return `hobbots_template_${hash.digest("hex").slice(0, 16)}`;
};

/**
 * Makes the template database once per server: the test workers race for an advisory lock, and
 * the first migrates it under a temporary name, so a run that stops halfway leaves no template
 * that looks finished.
 */
const ensureTemplate = (url: string, template: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.acquireRelease(sql`SELECT pg_advisory_lock(hashtext(${template}))`, () =>
      sql`SELECT pg_advisory_unlock(hashtext(${template}))`.pipe(Effect.ignore),
    );
    const found = yield* sql`SELECT 1 FROM pg_database WHERE datname = ${template}`;
    if (found.length > 0) return;
    const building = `${template}_building`;
    yield* sql`DROP DATABASE IF EXISTS ${sql(building)} WITH (FORCE)`;
    yield* sql`CREATE DATABASE ${sql(building)}`;
    yield* Layer.build(makePgLive({ url: databaseUrl(url, building) })).pipe(Effect.scoped);
    yield* sql`ALTER DATABASE ${sql(building)} RENAME TO ${sql(template)}`;
  }).pipe(Effect.scoped);

// The template is checked once per test worker; each test then only copies it.
const templates = new Map<string, Promise<void>>();

/**
 * A fresh database copied from the migrated template. Copying a database is several times faster
 * than migrating a fresh schema, which each test's hub would otherwise do (#1066).
 */
const PgCopyLive = (url: string) => {
  const template = templateName();
  const name = `hobbots_test_${randomUUID().replaceAll("-", "")}`;
  const Database = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      let ready = templates.get(template);
      if (ready === undefined) {
        ready = Effect.runPromise(
          ensureTemplate(url, template).pipe(
            Effect.provide(PgClient.layer({ url: Redacted.make(url), maxConnections: 1 })),
          ),
        );
        templates.set(template, ready);
      }
      yield* Effect.promise(() => ready);
      yield* Effect.acquireRelease(sql`CREATE DATABASE ${sql(name)} TEMPLATE ${sql(template)} STRATEGY FILE_COPY`, () =>
        sql`DROP DATABASE IF EXISTS ${sql(name)} WITH (FORCE)`.pipe(Effect.ignore),
      );
    }),
  ).pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url), maxConnections: 1 })));
  return makePgLive({ url: databaseUrl(url, name) }).pipe(Layer.provide(Database));
};
