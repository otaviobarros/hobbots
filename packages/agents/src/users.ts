import { type Actor, type User, type UserId, userIdOf } from "@hobbots/domain";
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

/** The user a record's actor names, such as `OWNER_ACTOR`'s owner; none for a hob, the hub or an unknown id. */
export const userOfActor = (actor: Actor): Effect.Effect<Option.Option<User>, never, UserRepository> =>
  Option.match(userIdOf(actor), {
    onNone: () => Effect.succeedNone,
    onSome: (id) =>
      Effect.gen(function* () {
        const users = yield* UserRepository;
        return yield* users.find(id);
      }),
  });
