import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SearchText, searchParam } from "./search-params.ts";

const Search = Schema.Struct({
  show: searchParam(Schema.Literals(["all", "needs"])),
  days: searchParam(Schema.Literals([7, 30])),
  q: searchParam(SearchText),
});
const validate = (input: unknown) => {
  const result = Schema.toStandardSchemaV1(Search)["~standard"].validate(input);
  if (result instanceof Promise) throw new Error("validation is synchronous");
  return result;
};

describe("searchParam", () => {
  it("keeps valid params", () => {
    expect(validate({ show: "needs", days: 30, q: "launch" })).toEqual({
      value: { show: "needs", days: 30, q: "launch" },
    });
  });

  it("leaves missing params out", () => {
    expect(validate({})).toEqual({ value: {} });
  });

  it("reads an invalid param as undefined instead of failing", () => {
    const result = validate({ show: "everything", days: "thirty", q: "   " });
    expect(result.issues).toBeUndefined();
    expect(result).toEqual({ value: { show: undefined, days: undefined, q: undefined } });
  });
});
