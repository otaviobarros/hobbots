import { Option, Schema } from "effect";
import { type Actor, OWNER_ACTOR } from "./actor.ts";
import { HobColor } from "./look.ts";

/**
 * A person the hub serves (ADR 039, Users as actors). Every record a person writes names them as an
 * actor `{ kind: "user", id }`, and `id` is this record's. A hub has one person today, the owner,
 * whose id is `owner`; the accounts design adds people as rows, without changing what a stored actor
 * means. A user holds no credentials: devices prove who is asking (ADR 021).
 */
export const UserId = Schema.String.pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;

/** The owner of the hub: the person every `OWNER_ACTOR` names. */
export const OWNER_USER_ID = UserId.make(OWNER_ACTOR.id);

/**
 * Where a user stands. Only `active` today: removing a person and what happens to their records is
 * left to the accounts design, which adds its states, and the machine they need, when it lands.
 */
export const UserState = Schema.Literals(["active"]);
export type UserState = typeof UserState.Type;

export class User extends Schema.Class<User>("User")({
  id: UserId,
  /** How people and hobs see this person named. */
  name: Schema.String,
  /** One or two letters drawn in the person's badge. */
  initials: Schema.String,
  /** The badge's color, from the same palette as a hob's. */
  color: HobColor,
  state: UserState,
}) {}

/** The user a person actor names, or none for a hob or the hub. */
export const userIdOf = (actor: Actor): Option.Option<UserId> =>
  actor.kind === "user" ? Option.some(UserId.make(actor.id)) : Option.none();
