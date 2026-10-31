import { HobInputErrors, InvalidHob } from "@hobbots/api";
import { Effect, SchemaIssue } from "effect";
import { HttpApiMiddleware } from "effect/http-api";

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

/** The first failing field of a create or edit request, as `InvalidHob`. */
export const HobInputErrorsLayer = HttpApiMiddleware.layerSchemaErrorTransform(HobInputErrors, (error) => {
  const [first] = formatIssue(error.cause.issue).issues;
  const field = first?.path?.[0];
  return Effect.fail(
    new InvalidHob({
      field: typeof field === "string" ? field : null,
      message: first?.message ?? error.cause.message,
    }),
  );
});
