import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CharmTurn,
  cardAnswers,
  DirectoryTools,
  HobDirectory,
  hobCard,
  makeRedactor,
  type ToolAccess,
} from "@hobbots/agents";
import { Agent, AgentId, EMPTY_HOB_POLICY, READ_HOB_TOOL, roleFields } from "@hobbots/domain";
import { type HubCallRuntime, hubCallRuntimes } from "@hobbots/runtimes/testing";
import { Effect, Exit, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DirectoryReadTools } from "../src/directory.ts";

// `read_hob` on each runtime that serves hub tools (ADR 032): the fake runtime, and an installed
// Claude Code and Codex where HOBBOTS_CLAUDE_CODE and HOBBOTS_CODEX name them, each with a stand-in
// model. Each call's step is recorded with the turn's recorder before the directory is read.

const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-directory-runtimes-")));
const folder = join(root, "app");
mkdirSync(folder, { recursive: true });

const access: ToolAccess = {
  policy: {
    preset: "balanced",
    sharedFolders: [],
    hob: { ...EMPTY_HOB_POLICY, ownFolders: [folder] },
    dataFolder: join(root, "data"),
    restrictions: [],
  },
  folders: [folder],
  runtimeFolder: join(root, "runtimes", "ada"),
  commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
};

const pip = hobCard(
  new Agent({
    id: AgentId.make("0d6e2f0a-0000-4000-8000-000000000002"),
    name: "Pip",
    ...roleFields("writer"),
    goodAt: "Launch emails.",
    runtime: "codex",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: "2026-11-08T00:00:00.000Z",
  }),
  ["GitHub"],
  cardAnswers("balanced", EMPTY_HOB_POLICY, []),
);

/** One hub's directory tools over a directory holding Pip, with every record and read in `order`. */
const directoryHub = () => {
  const order: Array<string> = [];
  const found = (hob: string) =>
    Effect.sync(() => {
      order.push(`read ${hob}`);
      return { cards: hob.trim().toLowerCase() === "pip" ? [pip] : [], shared: new Set<string>() };
    });
  const layer = DirectoryReadTools.pipe(
    Layer.provide(
      Layer.succeed(
        HobDirectory,
        HobDirectory.of({ listed: () => found("everyone"), find: (_reader, hob) => found(hob) }),
      ),
    ),
  );
  const turn: CharmTurn = {
    agentId: AgentId.make("0d6e2f0a-0000-4000-8000-000000000001"),
    threadId: null,
    messageId: null,
    scope: () => "reply:m1",
    also: "reply:m1",
    currentAccess: Effect.succeed(access),
    redactor: makeRedactor([]),
    approvals: null,
  };
  const tools = Effect.runPromise(DirectoryTools.use((service) => service.forTurn(turn)).pipe(Effect.provide(layer)));
  return { tools, order };
};

const expectedRuntimes = [
  "fake",
  ...(process.env.HOBBOTS_CLAUDE_CODE === undefined ? [] : ["claude-code"]),
  ...(process.env.HOBBOTS_CODEX === undefined ? [] : ["codex"]),
];

let runtimes: Awaited<ReturnType<typeof hubCallRuntimes>>;
beforeAll(async () => {
  runtimes = await hubCallRuntimes();
});
afterAll(() => {
  runtimes.close();
  rmSync(root, { recursive: true, force: true });
});

/** Runs a turn on `runtime` that reads Pip's card, with a recorder answering `records`. */
const readPip = async (runtime: HubCallRuntime, records: boolean) => {
  const hub = directoryHub();
  const hubTools = await hub.tools;
  if (hubTools === null) throw new Error("No directory tools");
  const { exit } = await runtime.turn({
    hubTools,
    recordToolStart: (event) =>
      Effect.sync(() => {
        hub.order.push(`recorded ${event.tool} ${event.operation}`);
        return records;
      }),
    calls: [{ tool: READ_HOB_TOOL, input: { hob: "Pip" } }],
  });
  expect(Exit.isSuccess(exit), String(exit)).toBe(true);
  return hub;
};

describe("read_hob on every runtime", () => {
  // covers EX-004, ADR 032 (read_hob, Every runtime)
  it("[TC-PE-1234-01] each runtime records a read_hob call's step before the directory is read, and reads nothing unrecorded", {
    timeout: 240_000,
  }, async () => {
    expect(runtimes.runtimes.map((runtime) => runtime.name)).toEqual(expectedRuntimes);
    for (const runtime of runtimes.runtimes) {
      const recorded = await readPip(runtime, true);
      expect(recorded.order, runtime.name).toEqual(["recorded read_hob read-hobs", "read Pip"]);
      const unrecorded = await readPip(runtime, false);
      expect(unrecorded.order, runtime.name).toEqual(["recorded read_hob read-hobs"]);
    }
  });
});
