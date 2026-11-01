import { linkSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolLogs } from "@hobbots/agents";
import type { MessageId, ThreadId } from "@hobbots/domain";
import { Effect, Exit, Option } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { ToolLogsLive } from "../src/tool-logs.ts";

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-tool-logs-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const folder = join(temp, "tool-logs");
const key = { threadId: "t1" as ThreadId, messageId: "m1" as MessageId, stepId: "toolu_1" };

const run = <A, E>(effect: Effect.Effect<A, E, ToolLogs>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(ToolLogsLive(folder))));

describe("tool logs", () => {
  it("keeps a step's log and reads it back", async () => {
    expect(await run(ToolLogs.use((logs) => logs.write(key, "first\n")))).toEqual(Exit.void);
    expect(await run(ToolLogs.use((logs) => logs.write(key, "all\n")))).toEqual(Exit.void);
    expect(await run(ToolLogs.use((logs) => logs.read(key)))).toEqual(Exit.succeed(Option.some("all\n")));
  });

  it("[#153] never empties or reads a file a hard link at the log's name points to", async () => {
    const [name] = readdirSync(folder);
    const target = join(temp, "personal.txt");
    writeFileSync(target, "Not for hobs.\n");
    rmSync(join(folder, name as string));
    linkSync(target, join(folder, name as string));

    const written = await run(ToolLogs.use((logs) => logs.write(key, "overwrite\n")));
    expect(Exit.isFailure(written)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("Not for hobs.\n");
    expect(await run(ToolLogs.use((logs) => logs.read(key)))).toEqual(Exit.succeed(Option.none()));
  });
});
