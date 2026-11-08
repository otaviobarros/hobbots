import { WebFoundUrls } from "@hobbots/agents";
import { Array as Arr, DateTime, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";

/** How many URLs one statement reads or adds, well inside both databases' limits on parameters. */
const BATCH = 500;

const batches = Arr.chunksOf(BATCH);

/** Each session's found URLs (migration 0083, ADR 036), by the work they belong to. */
export const WebFoundUrlsLive = Layer.effect(
  WebFoundUrls,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return WebFoundUrls.of({
      sources: (work, urls) =>
        Effect.forEach(
          batches([...new Set(urls)]),
          (some) =>
            sql<{ url: string; source: string }>`SELECT url, source FROM web_found_urls
            WHERE work = ${work} AND ${sql.in("url", some)}`,
        ).pipe(
          Effect.map((rows) => new Map(rows.flat().map((row) => [row.url, row.source] as const))),
          Effect.orDie,
        ),
      // A URL already found keeps where it was found first.
      add: (work, found) =>
        Effect.gen(function* () {
          const at = DateTime.formatIso(yield* DateTime.now);
          const first = new Map<string, (typeof found)[number]>();
          for (const one of found) if (!first.has(one.url)) first.set(one.url, one);
          const unique = [...first.values()];
          yield* Effect.forEach(
            batches(unique),
            (some) =>
              sql`INSERT INTO web_found_urls ${sql.insert(
                Arr.map(some, (one) => ({ work, url: one.url, source: one.source, found_at: at })),
              )} ON CONFLICT (work, url) DO NOTHING`,
            { discard: true },
          );
        }).pipe(Effect.orDie),
    });
  }),
);
