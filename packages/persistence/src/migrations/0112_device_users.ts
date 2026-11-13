import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A device belongs to a person (ADR 039, Users as actors; #1452): every request it sends is theirs.
// Until accounts exist every device is the owner's, so each existing device, the hub's window too,
// becomes the owner's here, and the hub gives each new one to the owner. PostgreSQL refuses a device
// without a user once the rows are filled; SQLite cannot change a column, so triggers refuse it there.
// A journaled `DeviceRevoked` (version 2) carries its device's user too, so each retained entry gets
// the owner and decodes after the upgrade (ADR 013).
const message = "devices.user_id must name a user";
const PAGE = 500;
const REVOKED_VERSION = 2;

type Stored = Record<string, unknown>;

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

  let sequence = 0;
  for (;;) {
    const events = yield* sql<{ sequence: unknown; payload: string }>`SELECT sequence, payload FROM event_journal
      WHERE type = 'DeviceRevoked' AND schema_version < ${REVOKED_VERSION} AND sequence > ${sequence}
      ORDER BY sequence LIMIT ${PAGE}`;
    for (const event of events) {
      const payload = JSON.parse(event.payload) as Stored;
      const changed = { ...payload, device: { ...(payload.device as Stored), userId: "owner" } };
      yield* sql`UPDATE event_journal SET payload = ${JSON.stringify(changed)}, schema_version = ${REVOKED_VERSION}
        WHERE sequence = ${event.sequence}`;
    }
    if (events.length < PAGE) break;
    sequence = Number(events[events.length - 1]?.sequence);
  }
});
