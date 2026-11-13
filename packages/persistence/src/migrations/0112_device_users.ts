import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A device belongs to a person (ADR 039, Users as actors; #1452): every request it sends is theirs.
// Until accounts exist every device is the owner's, so each existing device, the hub's window too,
// becomes the owner's here, and the hub gives each new one to the owner. PostgreSQL refuses a device
// without a user once the rows are filled; SQLite cannot change a column, so triggers refuse it there.
const message = "devices.user_id must name a user";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE devices ADD COLUMN user_id TEXT REFERENCES users(id)`;
  yield* sql`UPDATE devices SET user_id = 'owner'`;
  yield* sql.onDialectOrElse({
    pg: () => sql`ALTER TABLE devices ALTER COLUMN user_id SET NOT NULL`,
    orElse: () =>
      Effect.gen(function* () {
        const abort = `BEGIN SELECT RAISE(ABORT, '${message}'); END`;
        yield* sql.unsafe(`CREATE TRIGGER devices_user_required_insert BEFORE INSERT ON devices
          WHEN NEW.user_id IS NULL ${abort}`);
        yield* sql.unsafe(`CREATE TRIGGER devices_user_required_update BEFORE UPDATE OF user_id ON devices
          WHEN NEW.user_id IS NULL ${abort}`);
      }),
  });
});
