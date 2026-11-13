import { DeviceId, UserId } from "@hobbots/domain";
import { Schema } from "effect";

/**
 * One person the hub's test seam added beside the owner, with their device (ADR 039): who, which
 * device, and the token a browser keeps for it. The browser tests' build of the hub writes them to
 * `TEST_PEOPLE_FILE` in its data folder, and the browser tests read them back. No other build has it.
 */
export const TestPersonSeat = Schema.Struct({
  userId: UserId,
  name: Schema.String,
  deviceId: DeviceId,
  deviceName: Schema.String,
  token: Schema.String,
});
export type TestPersonSeat = typeof TestPersonSeat.Type;

/** What the seam writes: every person it added, in the order it added them. */
export const TestPersonSeats = Schema.fromJsonString(Schema.Array(TestPersonSeat));

/** The file in the hub's data folder that holds the seats, readable only by the user. */
export const TEST_PEOPLE_FILE = "test-people.json";
