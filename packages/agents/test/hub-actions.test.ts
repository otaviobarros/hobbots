import {
  AgentId,
  ApprovalId,
  type CharmDeclaration,
  EMPTY_HOB_POLICY,
  type PolicyDecision,
  type ReplyStep,
} from "@hobbots/domain";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  type ApprovalAction,
  type ApprovalOutcome,
  type AskableVerdict,
  actionDigest,
  type HubActionOwner,
  HubRefusal,
  type HubRequest,
  hubAction,
  hubCallStep,
  makeHubActions,
  makeRedactor,
  nextSteps,
  outsideDataLine,
  type RuntimeEvent,
  type ToolAccess,
  type TurnApprovals,
  UNASKABLE,
  UNRECORDED_TOOL_CALL,
} from "../src/index.ts";

// The hub action pipeline (ADR 031), driven through a fake Charm, Pip, whose read is planned by the
// action and decided, asked, recorded, sent and redacted by the pipeline alone.

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
  takesOver: ["push"],
};

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

const access = (pip = true): ToolAccess => ({
  policy: {
    preset: "balanced",
    sharedFolders: ["/work"],
    hob: { ...EMPTY_HOB_POLICY, ...(pip ? {} : { githubCharm: false }) },
    dataFolder: "/data",
    restrictions: [],
    charmOperations: PIP.operations,
  },
  folders: ["/work"],
  runtimeFolder: "/runtimes/hob",
  commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
});

const verdict = (decision: PolicyDecision, message = `The policy answers ${decision}.`): AskableVerdict => ({
  decision,
  operation: "pip.read",
  reason: { message },
  targets: ["top"],
  onceOnly: false,
  grantable: decision === "ask",
  rules: [],
  grantIds: [],
  policyVersion: "v1",
});

interface Scenario {
  /** What the policy answers, first and after an approval. */
  readonly decisions?: ReadonlyArray<PolicyDecision>;
  /** What the hob's access is when the call is made. */
  readonly now?: ToolAccess | null;
  /** The user takes the Charm away while they are asked. */
  readonly offWhileAsking?: boolean;
  /** The request the action plans. */
  readonly request?: HubRequest;
  readonly effect?: "read" | "write";
  readonly owner?: HubActionOwner;
  /** What sending does. */
  readonly send?: Effect.Effect<string, HubRefusal>;
  /** What recording the step answers; null for a call with no step. */
  readonly records?: Effect.Effect<boolean> | null;
  /** The user's answer when asked; null for a turn with nobody to ask. */
  readonly answer?: "approve" | "deny" | null;
}

/** Runs one call to `pip_read` and says what happened, in order. */
const callPip = (input: unknown, scenario: Scenario = {}) => {
  const happened: Array<string> = [];
  const asked: Array<ApprovalAction> = [];
  const events: Array<RuntimeEvent> = [];
  const decisions = [...(scenario.decisions ?? ["allow"])];
  let now = scenario.now === undefined ? access() : scenario.now;
  const contexts: Array<unknown> = [];
  const approvals: TurnApprovals | null =
    scenario.answer === null
      ? null
      : {
          request: (action) =>
            Effect.gen(function* () {
              asked.push(action);
              happened.push("asked");
              if (scenario.offWhileAsking) now = access(false);
              const decision: ApprovalOutcome =
                (scenario.answer ?? "approve") === "approve"
                  ? {
                      _tag: "Approved",
                      actionDigest: yield* actionDigest(action),
                      policyVersion: action.policyVersion,
                      lifetime: "once",
                    }
                  : { _tag: "Denied", reason: "Not now." };
              return { approvalId: ApprovalId.make(`approval-${asked.length}`), decision: Effect.succeed(decision) };
            }),
          currentAccess: Effect.succeed(access()),
          grants: Effect.succeed([]),
          used: () => Effect.void,
        };
  const tools = makeHubActions({
    owner: scenario.owner ?? {
      _tag: "Charm",
      declaration: PIP,
      name: "Pip",
      holds: (now) => now.policy.hob.githubCharm !== false,
    },
    actions: [
      hubAction({
        tool: { name: "pip_read", description: "Reads a shelf.", inputSchema: {}, label: "Reading Pip" },
        input: Schema.Struct({ shelf: Schema.String }),
        effect: scenario.effect ?? "read",
        otherwise: "Pip cannot be read",
        plan: (decoded, context) =>
          Effect.gen(function* () {
            happened.push(`planned ${decoded.shelf} for ${context.turn.agentId}`);
            contexts.push(context);
            if (decoded.shelf === "locked") return yield* new HubRefusal({ message: "That shelf is locked." });
            return {
              request: scenario.request ?? {
                _tag: "Charm",
                charm: "pip",
                operation: "pip.read",
                site: { shelf: decoded.shelf },
              },
              card: { arguments: { shelf: decoded.shelf }, summary: `Read the ${decoded.shelf} shelf` },
              send: Effect.suspend(() => {
                happened.push("sent");
                return scenario.send ?? Effect.succeed(`The ${decoded.shelf} shelf holds ${SECRET}.`);
              }),
            };
          }),
      }),
    ],
    decide: () => () =>
      Effect.sync(() => {
        happened.push("decided");
        return verdict(decisions.shift() ?? "deny");
      }),
  })({
    agentId: AgentId.make("hob"),
    threadId: null,
    messageId: null,
    scope: () => "",
    currentAccess: Effect.sync(() => now),
    redactor: makeRedactor(),
    approvals,
  });
  const records = scenario.records === undefined ? Effect.succeed(true) : scenario.records;
  const step =
    records === null
      ? undefined
      : hubCallStep(
          "toolu_1",
          (event) => events.push(event),
          (event) =>
            records.pipe(
              Effect.tap((ok) => Effect.sync(() => happened.push(`recorded ${event.tool} ${event.operation} ${ok}`))),
            ),
        );
  return Effect.runPromise(tools.call("pip_read", input, step)).then((answer) => ({
    answer,
    happened,
    asked,
    events,
    contexts,
    offered: tools.tools.map((tool) => tool.name),
  }));
};

const LABEL = outsideDataLine("Pip");

describe("the hub action pipeline (ADR 031)", () => {
  // covers PE-008, ADR 031
  it("[TC-PE-463] answers a bad input, a plan refusal, a turn without tools and a Charm taken away, sending nothing", async () => {
    const bad = await callPip({ shelf: 3 });
    expect(bad.answer.refused).toBe(true);
    expect(bad.answer.text).toContain("shelf");
    expect(bad.happened).toEqual([]);

    const locked = await callPip({ shelf: "locked" });
    expect(locked.answer).toEqual({ text: "That shelf is locked.", refused: true });
    expect(locked.happened).toEqual(["planned locked for hob"]);

    const noTools = await callPip({ shelf: "top" }, { now: null });
    expect(noTools.answer).toEqual({ text: "You have no tools this turn, so Pip cannot be read.", refused: true });
    const off = await callPip({ shelf: "top" }, { now: access(false) });
    expect(off.answer).toEqual({ text: "The Pip Charm is off for you now, so Pip cannot be read.", refused: true });
    expect([...noTools.happened, ...off.happened]).toEqual([]);

    const unknown = await callPip({ shelf: "top" }).then(() =>
      Effect.runPromise(
        makeHubActions({ owner: { _tag: "BuiltIn" }, actions: [], decide: () => () => Effect.die("never") })({
          agentId: AgentId.make("hob"),
          threadId: null,
          messageId: null,
          scope: () => "",
          currentAccess: Effect.succeed(access()),
          redactor: makeRedactor(),
          approvals: null,
        }).call("pip_delete", {}),
      ),
    );
    expect(unknown).toEqual({ text: "Hobbots has no pip_delete tool.", refused: true });
  });

  // covers PE-003, EX-004, ADR 031
  it("[TC-PE-464] records an allowed read's step before sending it, and labels and redacts what it returns", async () => {
    const { answer, happened, offered } = await callPip({ shelf: "top" });
    expect(offered).toEqual(["pip_read"]);
    expect(happened).toEqual(["planned top for hob", "decided", "recorded pip_read pip.read true", "sent"]);
    expect(answer.refused).toBe(false);
    expect(answer.text.startsWith(`${LABEL}\nThe top shelf holds `)).toBe(true);
    expect(answer.text).not.toContain(SECRET);

    const never = await callPip({ shelf: "top" }, { decisions: ["deny"] });
    expect(never.answer).toEqual({ text: "The policy answers deny.", refused: true });
    expect(never.happened).toEqual(["planned top for hob", "decided"]);
  });

  // covers PE-003, PE-008, ADR 015, ADR 031
  it("[TC-PE-465] asks on the call's step with the plan's card, and runs only what was approved", async () => {
    const approved = await callPip({ shelf: "top" }, { decisions: ["ask", "ask"] });
    expect(approved.asked).toEqual([
      expect.objectContaining({
        stepId: "toolu_1",
        tool: "pip_read",
        operation: "pip.read",
        arguments: { shelf: "top", summary: "Read the top shelf" },
        label: "Reading Pip",
      }),
    ]);
    expect(approved.happened).toEqual([
      "planned top for hob",
      "decided",
      "asked",
      "decided",
      "recorded pip_read pip.read true",
      "sent",
    ]);
    expect(approved.events.map((event) => event._tag)).toEqual(["ToolAwaitingApproval"]);
    expect(approved.answer.text).toContain("They approved it just this once, so a call like it asks again.");

    const denied = await callPip({ shelf: "top" }, { decisions: ["ask"], answer: "deny" });
    expect(denied.answer).toEqual({
      text: "The user denied this call, so it did not run. Their reason: Not now.",
      refused: true,
    });
    expect(denied.happened).not.toContain("sent");
    // The step the user was asked on ends denied, by them, with their reason, so the reply shows it.
    const toolEvents = denied.events.filter((event) => event._tag !== "ToolAwaitingApproval");
    expect(toolEvents).toEqual([
      {
        _tag: "ToolDenied",
        id: "toolu_1",
        tool: "pip_read",
        operation: "pip.read",
        targets: ["top"],
        label: "Reading Pip",
        reason: "The user denied this call, so it did not run. Their reason: Not now.",
        decidedBy: "user",
      },
    ]);
    const steps = [
      { _tag: "StepStarted", id: "toolu_1", kind: "tool", label: "Reading Pip" } as const,
      ...denied.events,
    ].reduce<ReadonlyArray<ReplyStep>>((current, event) => nextSteps(current, 0, event) ?? current, []);
    expect(steps).toMatchObject([
      { id: "toolu_1", state: "denied", decidedBy: "user", reason: expect.stringContaining("Not now.") },
    ]);

    const nobody = await callPip({ shelf: "top" }, { decisions: ["ask"], answer: null });
    expect(nobody.answer).toEqual({ text: `The policy answers ask. ${UNASKABLE}`, refused: true });
    // A call without a step has no card to show, so it cannot ask either.
    const noStep = await callPip({ shelf: "top" }, { decisions: ["ask"], records: null });
    expect(noStep.answer).toEqual({ text: `The policy answers ask. ${UNASKABLE}`, refused: true });
    expect([...nobody.happened, ...noStep.happened]).not.toContain("sent");
  });

  // covers EX-004, ADR 031
  it("[TC-PE-466] sends nothing for a call whose step is missing or cannot be recorded", async () => {
    for (const records of [null, Effect.succeed(false), Effect.die("the journal is gone")]) {
      const { answer, happened } = await callPip({ shelf: "top" }, { records });
      expect(answer).toEqual({ text: UNRECORDED_TOOL_CALL, refused: true });
      expect(happened).not.toContain("sent");
    }
  });

  // covers ADR 031
  it("[TC-PE-467] turns a defect into an answer naming the tool, and refuses a request its owner does not declare", async () => {
    const broken = await callPip({ shelf: "top" }, { send: Effect.die("GitHub fell over") });
    expect(broken.answer).toEqual({ text: "Hobbots could not finish pip_read this time. Try again.", refused: true });

    const failed = await callPip({ shelf: "top" }, { send: Effect.fail(new HubRefusal({ message: `No ${SECRET}.` })) });
    expect(failed.answer.refused).toBe(true);
    expect(failed.answer.text).not.toContain(SECRET);

    // A built-in request the Charm did not take over, and another Charm's request, are refused unsent.
    for (const request of [
      { _tag: "Command", operation: "run-commands" },
      { _tag: "Charm", charm: "github", operation: "github.read" },
    ]) {
      const refused = await callPip({ shelf: "top" }, { request });
      expect(refused.answer).toEqual({
        text: "Hobbots could not finish pip_read this time. Try again.",
        refused: true,
      });
      expect(refused.happened).toEqual(["planned top for hob"]);
    }
    // Push, which it takes over, is decided as Push.
    const push = await callPip({ shelf: "top" }, { request: { _tag: "Push" } });
    expect(push.answer.refused).toBe(false);

    // A built-in set plans built-in requests only, and its answers carry no outside-data line.
    const builtIn = await callPip({ shelf: "top" }, { owner: { _tag: "BuiltIn" }, request: { _tag: "Memory" } });
    expect(builtIn.answer.text.startsWith("The top shelf holds ")).toBe(true);
    const builtInCharm = await callPip({ shelf: "top" }, { owner: { _tag: "BuiltIn" } });
    expect(builtInCharm.happened).not.toContain("sent");

    // A Charm write waits for its keyed record (#618), so none runs through the pipeline yet.
    const write = await callPip({ shelf: "top" }, { effect: "write" });
    expect(write.answer.refused).toBe(true);
    expect(write.happened).toEqual(["planned top for hob"]);
  });

  // covers PE-008, ADR 031
  it("[TC-PE-474] stops a call whose Charm was taken away while you decided, and plans with the turn's ids alone", async () => {
    const off = await callPip({ shelf: "top" }, { decisions: ["ask", "ask"], offWhileAsking: true });
    expect(off.answer).toEqual({ text: "The Pip Charm is off for you now, so Pip cannot be read.", refused: true });
    expect(off.happened).toEqual(["planned top for hob", "decided", "asked", "decided"]);
    expect(off.events.at(-1)).toMatchObject({ _tag: "ToolDenied", decidedBy: "policy", id: "toolu_1" });

    // The plan context is built for the call: no approvals, grants, recorder or redactor ride along.
    const { contexts } = await callPip({ shelf: "top" });
    expect(contexts).toHaveLength(1);
    const [context] = contexts as Array<Record<string, Record<string, unknown>>>;
    expect(Object.keys(context ?? {}).sort()).toEqual(["access", "turn"]);
    expect(Object.keys(context?.turn ?? {}).sort()).toEqual(["agentId", "messageId", "scope", "threadId"]);
  });
});
