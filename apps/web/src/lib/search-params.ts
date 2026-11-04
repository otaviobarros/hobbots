import { Effect, Option, Schema } from "effect";

/**
 * A search param for a route's `validateSearch` (STD-REACT-002). A missing param stays missing, and
 * a value the schema refuses reads as `undefined`, so the page opens on its default and never on
 * an error screen. Links still type the param with the schema's own values.
 */
export const searchParam = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(
    Schema.UndefinedOr(schema).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(undefined)))),
  );

/** Text that holds more than spaces, such as a search query. */
export const SearchText = Schema.String.check(Schema.makeFilter((text) => text.trim() !== ""));
