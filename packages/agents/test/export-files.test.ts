import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { exportedContents, overLimits } from "../src/export-files.ts";
import { makeRedactor } from "../src/secrets.ts";

// Eight characters, the shortest value the redactor knows, and its marker is 20.
const SHORT = "s3cr3t-x";
const MARKER = "[redacted: GH_TOKEN]";
const redactor = makeRedactor([{ value: SHORT, kind: "GH_TOKEN" }]);
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("an export's copied files", () => {
  // covers OP-003
  it("[TC-OP-047] apply the size limits to what is written, after redaction has made it longer", () => {
    const text = `${SHORT}\n`.repeat(4);
    const redacted = `${MARKER}\n`.repeat(4);
    const limits = { file: redacted.length, total: 1000 };
    // The file itself is well within the limit: only its redacted copy reaches it, and fits exactly.
    expect(Option.isNone(overLimits(text.length, 0, limits))).toBe(true);
    const fits = exportedContents(redactor, encode(text), 0, limits);
    expect(fits._tag === "Copy" && decode(fits.bytes)).toBe(redacted);
    // One byte less and the redacted copy is too large, though the file is not.
    expect(exportedContents(redactor, encode(text), 0, { ...limits, file: redacted.length - 1 })).toEqual({
      _tag: "Skip",
      why: "too-large",
    });
    // The export's total counts the redacted copy too.
    expect(exportedContents(redactor, encode(text), 1000 - redacted.length, limits)._tag).toBe("Copy");
    expect(exportedContents(redactor, encode(text), 1001 - redacted.length, limits)).toEqual({
      _tag: "Skip",
      why: "export-full",
    });
    // A binary file is copied as it is when it holds no secret, and not at all when it does.
    const binary = Uint8Array.from([0, 0xff, 1, 2]);
    expect(exportedContents(redactor, binary, 0, limits)).toEqual({ _tag: "Copy", bytes: binary });
    expect(exportedContents(redactor, Uint8Array.from([0, 0xff, ...encode(SHORT)]), 0, limits)).toEqual({
      _tag: "Skip",
      why: "holds-secret",
    });
  });
});
