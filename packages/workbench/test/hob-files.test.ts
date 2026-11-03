import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVED_FILE_BYTES } from "@hobbots/domain";
import { Effect, Option } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { makeHobFiles } from "../src/hob-files.ts";

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-hob-files-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

describe("the hob's files, as the Files tab looks at them", () => {
  // The Files tab remembers what it hashed, and hashes a file again whenever it may have changed.
  it("[#388] looks again at a file rewritten under the same size, and remembers one left alone", async () => {
    const files = makeHobFiles();
    const look = () => Effect.runPromise(files.look(temp, "notes.txt")).then(Option.getOrNull);
    writeFileSync(join(temp, "notes.txt"), "first\n");
    expect(await look()).toEqual({ size: 6, hash: sha256("first\n") });
    expect(await look()).toEqual({ size: 6, hash: sha256("first\n") });
    writeFileSync(join(temp, "notes.txt"), "again\n");
    expect(await look()).toEqual({ size: 6, hash: sha256("again\n") });
    rmSync(join(temp, "notes.txt"));
    expect(await look()).toBeNull();
  });

  // A file the hub would never serve is measured, not read through: a multi-GB export costs one stat.
  it("[#388] measures a file larger than the hub serves without hashing it", async () => {
    writeFileSync(join(temp, "export.bin"), "");
    truncateSync(join(temp, "export.bin"), SERVED_FILE_BYTES + 1);
    const found = await Effect.runPromise(makeHobFiles().look(temp, "export.bin")).then(Option.getOrNull);
    expect(found).toEqual({ size: SERVED_FILE_BYTES + 1, hash: null });
  });
});
