import { UserSession } from "@hobbots/api";
import { type Actor, OWNER_ACTOR, type User, type UserId, userIdOf } from "@hobbots/domain";
import { Context, Effect, Option } from "effect";

/** The people the hub serves (ADR 039, Users as actors). The owner, `owner`, is always one of them. */
export class UserRepository extends Context.Service<
  UserRepository,
  {
    readonly find: (id: UserId) => Effect.Effect<Option.Option<User>>;
    /** Every user, the owner first and then by id. */
    readonly list: Effect.Effect<ReadonlyArray<User>>;
  }
>()("@hobbots/agents/UserRepository") {}

/** The user a record's actor names, such as the owner; none for a hob, the hub or an unknown id. */
export const userOfActor = (actor: Actor): Effect.Effect<Option.Option<User>, never, UserRepository> =>
  Option.match(userIdOf(actor), {
    onNone: () => Effect.succeedNone,
    onSome: (id) =>
      Effect.gen(function* () {
        const users = yield* UserRepository;
        return yield* users.find(id);
      }),
  });

/**
 * Who a person's message is from (ADR 039, Users as actors): the actor of the request's user session.
 * Only the hub's own code sends one without a session, and that one is the owner's. This is the
 * session default, the one place outside the domain and the migrations that names the owner as an
 * actor (STD-SEC-006).
 */
export const sessionActor: Effect.Effect<Actor> = Effect.map(
  Effect.serviceOption(UserSession),
  Option.match({ onNone: () => OWNER_ACTOR, onSome: (session) => session.actor }),
);

/**
 * The hub's owner (ADR 039, the decider): who decides what no person caused, such as a hob's own
 * backpack work, and answers the hub's own questions.
 */
export const hubOwner: Actor = OWNER_ACTOR;
