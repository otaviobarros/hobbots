import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// What a reply's latest turn took and used, as its runtime reported it (#398), next to the runtime
// and model that turn ran on (migration 0020): milliseconds until the runtime sent its first model
// request, until the response stream opened and until the first complete message, then its input,
// output, cache-read and cache-write tokens. One column each, so usage can be summed by runtime and
// model. Any can be null: a runtime may not report it, and existing replies have none.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE messages ADD COLUMN time_to_request_ms INTEGER`;
  yield* sql`ALTER TABLE messages ADD COLUMN time_to_first_stream_ms INTEGER`;
  yield* sql`ALTER TABLE messages ADD COLUMN time_to_first_token_ms INTEGER`;
  yield* sql`ALTER TABLE messages ADD COLUMN input_tokens BIGINT`;
  yield* sql`ALTER TABLE messages ADD COLUMN output_tokens BIGINT`;
  yield* sql`ALTER TABLE messages ADD COLUMN cache_read_tokens BIGINT`;
  yield* sql`ALTER TABLE messages ADD COLUMN cache_write_tokens BIGINT`;
});
