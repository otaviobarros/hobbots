import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Devices and pairing requests (ADR 021, DP-004). Every client of the hub is an approved device:
// its name, kind and platform, the Tailscale node it was approved on (none for a local request),
// when it was approved, last used and revoked. The hub keeps only the SHA-256 hash of a device's
// token and of a pairing secret, never the secret itself. The hub's window has a row without a
// token hash: its key lives in memory and in a file only the user can read, and changes on every
// start. A Tailscale owner is JSON text: a user's login, or a tagged node's tags.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      platform TEXT NOT NULL,
      tailscale_node_id TEXT,
      tailscale_node_name TEXT,
      tailscale_owner TEXT,
      token_hash TEXT UNIQUE,
      approved_at TEXT NOT NULL,
      last_active_at TEXT,
      revoked_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE pairing_requests (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      secret_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      platform TEXT NOT NULL,
      tailscale_node_id TEXT,
      tailscale_node_name TEXT,
      tailscale_owner TEXT,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decided_at TEXT,
      device_id TEXT REFERENCES devices(id)
    )
  `;
  yield* sql`CREATE INDEX pairing_requests_state ON pairing_requests (state, expires_at)`;
});
