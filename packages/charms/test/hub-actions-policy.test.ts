import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hubAction, hubCallStep, makeHubActions, makeRedactor, type ToolAccess } from "@hobbots/agents";
import { AgentId, type CharmDeclaration, EMPTY_HOB_POLICY } from "@hobbots/domain";
import { decideHubCall, PolicyEngine, type PolicyRequest } from "@hobbots/permissions";
import { Effect, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvingUser } from "./support.ts";

// A fake second Charm, Pip, on the hub action pipeline with the real policy engine (ADR 031): a read
// whose preset asks is decided, asked and then answered by the grant you saved for its site.

const PIP: CharmDeclaration = {
  id: "pip",
  operations: [
    {
      id: "pip.read",
      words: "reading Pip",
      presets: { careful: "ask", balanced: "ask", trusting: "allow" },
      site: ["shelf"],
      onceOnly: false,
      actsAsIdentity: false,
    },
  ],
  takesOver: [],
};

let root = "";
beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hobbots-pip-")));
});
afterAll(() => fs.rm(root, { recursive: true, force: true }));

const accessOf = (): ToolAccess => ({
  policy: {
    preset: "balanced",
    sharedFolders: [root],
    hob: EMPTY_HOB_POLICY,
    dataFolder: path.join(root, "data"),
    restrictions: [],
    charmOperations: PIP.operations,
  },
  folders: [root],
  runtimeFolder: path.join(root, "runtimes", "hob"),
  commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
});

describe("a fake Charm's read on the hub action pipeline", () => {
  // covers PE-003, PE-007, ADR 015, ADR 031
  it("[TC-PE-469] asks for a read whose preset asks, and the grant saved for its site answers later reads", async () => {
    const access = accessOf();
    const user = approvingUser(access, "always");
    const sent: Array<string> = [];
    const answers = await Effect.gen(function* () {
      const engine = yield* PolicyEngine;
      const tools = makeHubActions({
        owner: { _tag: "Charm", declaration: PIP, name: "Pip", holds: () => true },
        actions: [
          hubAction({
            tool: { name: "pip_read", description: "Reads a shelf.", inputSchema: {}, label: "Reading Pip" },
            input: Schema.Struct({ shelf: Schema.String }),
            effect: "read",
            otherwise: "Pip cannot be read",
            plan: ({ shelf }) =>
              Effect.succeed({
                request: {
                  _tag: "Charm",
                  charm: "pip",
                  operation: "pip.read",
                  site: { shelf },
                } satisfies PolicyRequest,
                card: { arguments: { shelf } },
                send: Effect.sync(() => {
                  sent.push(shelf);
                  return `The ${shelf} shelf is full.`;
                }),
              }),
          }),
        ],
        decide: (approvals, base, request: PolicyRequest) => decideHubCall(engine, approvals, base, request),
      })({
        agentId: AgentId.make("hob"),
        threadId: null,
        messageId: null,
        scope: () => "",
        currentAccess: Effect.succeed(access),
        redactor: makeRedactor(),
        approvals: user.approvals,
      });
      const read = (shelf: string, id: string) =>
        tools.call(
          "pip_read",
          { shelf },
          hubCallStep(id, () => {}),
        );
      return [yield* read("top", "toolu_1"), yield* read("top", "toolu_2"), yield* read("bottom", "toolu_3")];
    }).pipe(Effect.provide(PolicyEngine.node), Effect.runPromise);

    // The first read asks and offers the shelf's rule; Always saves it.
    expect(user.asked.map((action) => [action.stepId, action.grantable, action.rules])).toEqual([
      ["toolu_1", true, [{ _tag: "CharmSite", charm: "pip", operation: "pip.read", site: { shelf: "top" } }]],
      ["toolu_3", true, [{ _tag: "CharmSite", charm: "pip", operation: "pip.read", site: { shelf: "bottom" } }]],
    ]);
    // The second read of the same shelf runs on the saved grant; another shelf asks again.
    expect(answers.map((answer) => answer.refused)).toEqual([false, false, false]);
    expect(answers[0]?.text).toContain("They approved calls like it always");
    expect(answers[1]?.text).toContain("an approval the user saved earlier covers it");
    expect(sent).toEqual(["top", "top", "bottom"]);
  });
});
