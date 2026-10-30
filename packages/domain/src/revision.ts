import { Effect, Schema } from "effect";

/**
 * The journal sequence of the change that last wrote an entity, so a client can tell which of two
 * versions is newer (ADR 013). The repository sets it on every write; 0 until the entity is saved,
 * and for rows saved before the journal existed.
 */
export const Revision = Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(0)));
