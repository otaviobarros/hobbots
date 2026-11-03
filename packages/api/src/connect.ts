/**
 * The connect protocol (ADR 025): a whole number that counts changes to what a connected desktop's
 * main process relies on: health, pairing, the device's own revoke, the event stream and the reads
 * behind notifications and the menu bar. It goes up only when one of those changes in a way an
 * older app cannot follow. The hub reports its own in the health answer.
 */
export const CONNECT_PROTOCOL = 1;

/** The connect protocols this app can use, oldest and newest. */
export const SUPPORTED_CONNECT = { min: 1, max: 1 } as const;

/**
 * Whether this app can connect to a hub that reports `connect`: `ok`, or which side must update.
 * A hub that reports none predates the protocol, so it counts as older.
 */
export const connectSupport = (
  connect: number | undefined,
  supported: { readonly min: number; readonly max: number } = SUPPORTED_CONNECT,
): "ok" | "hubOlder" | "appOlder" => {
  if (connect === undefined || connect < supported.min) return "hubOlder";
  return connect > supported.max ? "appOlder" : "ok";
};
