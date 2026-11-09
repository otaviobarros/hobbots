import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Each session's found URLs (ADR 036): the URLs `web_fetch` reads under the site rules alone, kept by
// the work they belong to (`thread:<id>` or `task:<id>`), with where each was found first.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE web_found_urls (
      work TEXT NOT NULL,
      url TEXT NOT NULL,
      source TEXT NOT NULL,
      found_at TEXT NOT NULL,
      PRIMARY KEY (work, url)
    )
  `;
});
