import { UserSession } from "@hobbots/api";
import {
  AgentId,
  ApprovalId,
  type CharmCall,
  type CharmDeclaration,
  CharmWriteKey,
  EMPTY_HOB_POLICY,
  holdsCharm,
  MessageId,
  type PolicyDecision,
  type ReplyStep,
  ThreadId,
  toolInputJsonSchema,
  WINDOW_DEVICE_ID,
} from "@hobbots/domain";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  type ApprovalAction,
  type ApprovalOutcome,
  type AskableVerdict,
  actionDigest,
  CharmCallService,
  CharmCalls,
  type HubActionOwner,
  HubRefusal,
  type HubRequest,
  hubAction,
  hubCallStep,
  makeCharmCallRunner,
  makeHubActions,
  makeRedactor,
  nextSteps,
  offerHubActions,
  outsideDataLine,
  type ReadBack,
  type RuntimeEvent,
  readBacksOf,
  type ToolAccess,
  type TurnApprovals,
  UNASKABLE,
  UNRECORDED_TOOL_CALL,
  uncertainNote,
  type WriteOutcome,
} from "../src/index.ts";
import { memoryCharmCalls } from "../src/testing.ts";

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

const PIP_SHELVE = {
  id: "pip.shelve",
  words: "shelving with Pip",
  presets: { careful: "ask", balanced: "ask", trusting: "allow" },
  site: ["shelf"],
  onceOnly: false,
  actsAsIdentity: false,
} as const;

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

const access = (pip = true): ToolAccess => ({
  policy: {
    preset: "balanced",
    sharedFolders: ["/work"],
    hob: { ...EMPTY_HOB_POLICY, charms: { granted: pip ? ["pip"] : [] } },
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
  /** Whether the call's step keeps the answer as its output. */
  readonly keepsAnswer?: boolean;
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
      holds: (now) => holdsCharm(now.policy.hob, "pip"),
    },
    actions: [
      hubAction({
        tool: { name: "pip_read", description: "Reads a shelf.", inputSchema: {}, label: "Reading Pip" },
        input: Schema.Struct({ shelf: Schema.String }),
        effect: scenario.effect ?? "read",
        otherwise: "Pip cannot be read",
        ...(scenario.keepsAnswer === undefined ? {} : { keepsAnswer: scenario.keepsAnswer }),
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

    // A Charm write runs only as its keyed record (#618): a Charm that gives no runner is refused as
    // soon as its tools are made, before any call.
    expect(() => callPip({ shelf: "top" }, { effect: "write" })).toThrow("gave no runner");
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
    expect(Object.keys(context ?? {}).sort()).toEqual(["access", "stepId", "turn"]);
    expect(context?.stepId).toBe("toolu_1");
    expect(Object.keys(context?.turn ?? {}).sort()).toEqual(["agentId", "messageId", "scope", "threadId"]);
  });

  // covers ADR 036 (Amendment: the screens), #1271
  it("[TC-PE-1271-05] ends the step of an action that keeps its answer with the redacted answer, whichever runtime called it, and a refusal with nothing", async () => {
    const kept = await callPip({ shelf: "top" }, { keepsAnswer: true });
    expect(kept.answer.refused).toBe(false);
    const finished = kept.events.filter((event) => event._tag === "ToolFinished");
    expect(finished).toEqual([{ _tag: "ToolFinished", id: "toolu_1", failed: false, output: kept.answer.text }]);
    expect(JSON.stringify(finished)).not.toContain(SECRET);
    // The runtime's own end comes after the hub's (Claude Code's PostToolUse, Codex's item completed)
    // and finds the step ended, so the step keeps the answer.
    const started = {
      _tag: "ToolStarted",
      id: "toolu_1",
      tool: "web_fetch",
      operation: "use-web",
      targets: [],
      label: "Reading a page",
    } as const;
    const output = {
      head: kept.answer.text,
      tail: "",
      omittedBytes: 0,
      totalBytes: kept.answer.text.length,
      logged: false,
    };
    const ended = nextSteps(nextSteps([], 0, started) ?? [], 0, finished[0] as RuntimeEvent, undefined, output) ?? [];
    expect(nextSteps(ended, 0, { _tag: "StepEnded", id: "toolu_1" })).toBeNull();
    expect(nextSteps(ended, 0, { _tag: "ToolFinished", id: "toolu_1", failed: false })).toBeNull();
    expect(ended[0]).toMatchObject({ state: "done", output });

    const refused = await callPip({ shelf: "locked" }, { keepsAnswer: true });
    expect(refused.events.filter((event) => event._tag === "ToolFinished")).toEqual([]);
    const plain = await callPip({ shelf: "top" });
    expect(plain.events.filter((event) => event._tag === "ToolFinished")).toEqual([]);
  });
});

interface WriteScenario {
  /** How each send ends, in order; the call is applied when none is left. */
  readonly outcomes?: Array<WriteOutcome>;
  /** What reading Pip back finds; no read-back when absent. */
  readonly readBack?: () => boolean;
  /** What recording the step answers. */
  readonly records?: boolean;
}

const SHELVE_INPUT = Schema.Struct({ shelf: Schema.String, note: Schema.optionalKey(Schema.String) });

/**
 * A hub with Pip's write, `pip_shelve`, whose call records live in `rows`; each call says what
 * happened, in order, and what the plan was given.
 */
const pipWrites = (scenario: WriteScenario = {}, rows = new Map<string, CharmCall>()) => {
  const happened: Array<string> = [];
  const planned: Array<{ readonly input: unknown; readonly redacted: unknown }> = [];
  const decided: Array<unknown> = [];
  const outcomes = [...(scenario.outcomes ?? [])];
  const readBack: ReadBack | undefined =
    scenario.readBack === undefined
      ? undefined
      : () =>
          Effect.sync(() => {
            happened.push("read back");
            return scenario.readBack?.() ?? false;
          });
  const action = hubAction({
    tool: { name: "pip_shelve", description: "Shelves a book.", inputSchema: {}, label: "Shelving with Pip" },
    input: SHELVE_INPUT,
    effect: "write",
    otherwise: "nothing can be shelved",
    ...(readBack === undefined ? {} : { readBack }),
    plan: (input, context) =>
      Effect.sync(() => {
        planned.push({ input, redacted: context.redacted });
        happened.push(`planned ${input.shelf}`);
        return {
          request: { _tag: "Charm", charm: "pip", operation: "pip.shelve", site: { shelf: input.shelf } },
          card: { arguments: { ...input }, label: `Shelving on ${input.shelf}` },
          write: {
            site: `pip ${input.shelf}`,
            recorded: { shelf: input.shelf },
            appliedText: `Shelved on ${input.shelf}.`,
            send: Effect.sync(() => {
              happened.push("sent");
              return outcomes.shift() ?? ({ _tag: "Applied", text: `Shelved on ${input.shelf} at once.` } as const);
            }),
          },
        };
      }),
  });
  // Recording a call's key is seen in `happened`, so it can be told apart from recording its step.
  const calls = Layer.effect(
    CharmCalls,
    Effect.gen(function* () {
      const inner = yield* CharmCalls;
      return CharmCalls.of({
        ...inner,
        begin: (call, also) =>
          Effect.sync(() => happened.push(`began ${call.key}`)).pipe(Effect.andThen(inner.begin(call, also))),
      });
    }),
  ).pipe(Layer.provide(memoryCharmCalls(rows)));
  const declared = { ...PIP, operations: [...PIP.operations, PIP_SHELVE] };
  const call = (input: unknown, answer: "approve" | "deny" = "approve") =>
    Effect.gen(function* () {
      const runner = yield* makeCharmCallRunner(readBacksOf([action]));
      const asked: Array<ApprovalAction> = [];
      const events: Array<RuntimeEvent> = [];
      const tools = makeHubActions({
        owner: { _tag: "Charm", declaration: declared, name: "Pip", holds: () => true },
        actions: [action],
        decide: (_approvals, _base, request) => () =>
          Effect.sync(() => {
            decided.push(request);
            return { ...verdict("ask"), operation: "pip.shelve" };
          }),
        calls: runner,
      })({
        agentId: AgentId.make("hob"),
        threadId: ThreadId.make("t1"),
        messageId: MessageId.make("m1"),
        scope: () => "reply:m1",
        currentAccess: Effect.succeed(access()),
        redactor: makeRedactor(),
        approvals: {
          request: (asking) =>
            Effect.gen(function* () {
              asked.push(asking);
              happened.push("asked");
              const decision: ApprovalOutcome =
                answer === "approve"
                  ? {
                      _tag: "Approved",
                      actionDigest: yield* actionDigest(asking),
                      policyVersion: asking.policyVersion,
                      lifetime: "once",
                    }
                  : { _tag: "Denied", reason: "Not now." };
              return { approvalId: ApprovalId.make(`approval-${asked.length}`), decision: Effect.succeed(decision) };
            }),
          currentAccess: Effect.succeed(access()),
          grants: Effect.succeed([]),
          used: () => Effect.void,
        },
      });
      const step = hubCallStep(
        "toolu_1",
        (event) => events.push(event),
        (event) =>
          Effect.sync(() => {
            happened.push(`recorded ${event.tool} ${event.label}`);
            return scenario.records ?? true;
          }),
      );
      const result = yield* tools.call("pip_shelve", input, step);
      return { answer: result, asked, events, offered: tools.tools };
    }).pipe(Effect.scoped, Effect.provide(calls), Effect.runPromise);
  return { call, happened, planned, decided, rows, calls };
};

const states = (rows: Map<string, CharmCall>) => [...rows.values()].map((row) => [row.key, row.state, row.result]);

describe("Charm writes in the hub action pipeline (ADR 031)", () => {
  // covers IN-003, ADR 020, ADR 031
  it("[TC-PE-481] adds a required key to a Charm write's input, and refuses a call without one", async () => {
    const hub = pipWrites();
    const missing = await hub.call({ shelf: "top" });
    expect(missing.answer.refused).toBe(true);
    expect(missing.answer.text).toContain("key");
    const [tool] = missing.offered;
    expect(tool?.inputSchema).toEqual(
      toolInputJsonSchema(Schema.Struct({ ...SHELVE_INPUT.fields, key: CharmWriteKey })),
    );
    expect(tool?.inputSchema).toMatchObject({ required: expect.arrayContaining(["shelf", "key"]) });
    expect(hub.happened).toEqual([]);

    // The plan never sees the key: it is the record's, not the call's.
    const keyed = await hub.call({ shelf: "top", key: "s-1" });
    expect(keyed.answer).toMatchObject({ refused: false, text: expect.stringContaining("Shelved on top at once.") });
    expect(hub.planned.map((each) => each.input)).toEqual([{ shelf: "top" }]);
    // A write's answer is the hub's own words, so it carries no outside-data line.
    expect(keyed.answer.text).not.toContain(outsideDataLine("Pip"));
    expect(keyed.asked).toEqual([expect.objectContaining({ tool: "pip_shelve", label: "Shelving on top" })]);
  });

  // covers ADR 036 (The read-the-web mark)
  it("[TC-PE-1268-07] decides every Charm write as one that sends, whatever its Charm planned", async () => {
    const hub = pipWrites();
    await hub.call({ shelf: "top", key: "s-1" });
    // Decided as it asks, then again once approved, each time as one that sends.
    expect(hub.decided.length).toBeGreaterThan(0);
    for (const request of hub.decided) {
      expect(request).toMatchObject({ _tag: "Charm", operation: "pip.shelve", sends: true });
    }
  });

  // covers IN-003, EX-003, ADR 020
  it("[TC-PE-482] sends a key used twice once, answering the second call as the first ended, without asking again", async () => {
    const hub = pipWrites();
    const first = await hub.call({ shelf: "top", key: "s-1" });
    const second = await hub.call({ shelf: "top", key: "s-1" });
    expect(first.answer.refused).toBe(false);
    expect(second.answer).toEqual({
      text: "You made this call before, so it was not sent again. Its result then: Shelved on top at once.",
      refused: false,
    });
    expect(second.asked).toEqual([]);
    expect(hub.happened.filter((each) => each === "sent")).toHaveLength(1);
    const other = await hub.call({ shelf: "low", key: "s-1" });
    expect(other.answer.text).toContain("You already used the key s-1 for another call.");
    expect(hub.happened.filter((each) => each === "sent")).toHaveLength(1);
  });

  // covers EX-003, EX-004, ADR 020
  it("[TC-PE-483] reads an uncertain write back and answers it as applied when the change is there", async () => {
    const hub = pipWrites({ outcomes: [{ _tag: "Uncertain", text: "Pip did not answer." }], readBack: () => true });
    const { answer, events } = await hub.call({ shelf: "top", key: "s-1" });
    expect(answer).toMatchObject({
      refused: false,
      text: expect.stringMatching(/^Shelved on top\. Hobbots showed the user/),
    });
    expect(hub.happened.slice(-2)).toEqual(["sent", "read back"]);
    expect(states(hub.rows)).toEqual([["s-1", "applied", "Shelved on top."]]);
    // The step was recorded as started, and ends applied: it never shows as uncertain.
    expect(events.map((event) => event._tag)).toEqual(["ToolAwaitingApproval"]);
  });

  // covers EX-003, PE-006, ADR 020, ADR 031
  it("[TC-PE-484] keeps an uncertain write without a read-back waiting until the user settles it from its step", async () => {
    const rows = new Map<string, CharmCall>();
    const hub = pipWrites({ outcomes: [{ _tag: "Uncertain", text: "Pip did not answer." }] }, rows);
    const { answer, events } = await hub.call({ shelf: "top", key: "s-1" });
    expect(answer).toEqual({ text: `Pip did not answer. ${uncertainNote("Pip", false)}`, refused: true });
    expect(events.at(-1)).toEqual({ _tag: "ToolUncertain", id: "toolu_1", reason: "Pip did not answer." });
    expect(states(rows)).toEqual([["s-1", "uncertain", "Pip did not answer."]]);
    // Calling again names the Charm and does not send it again.
    const again = await hub.call({ shelf: "top", key: "s-1" });
    expect(again.answer.text).toBe(`Pip did not answer. ${uncertainNote("Pip", false)}`);
    expect(hub.happened.filter((each) => each === "sent")).toHaveLength(1);

    // Only the user settles it, in the Charm's words.
    const user = Layer.succeed(UserSession, {
      deviceId: WINDOW_DEVICE_ID,
      name: "This computer's Hobbots window",
      kind: "window",
      whileApproved: (write) => write,
    });
    const settled = await Effect.gen(function* () {
      const service = yield* CharmCallService;
      return yield* service.settle(ThreadId.make("t1"), MessageId.make("m1"), "toolu_1", "not-sent");
    }).pipe(
      Effect.provide(Layer.mergeAll(CharmCallService.layer.pipe(Layer.provide(memoryCharmCalls(rows))), user)),
      Effect.runPromise,
    );
    expect(settled).toMatchObject({
      state: "not-sent",
      result: "The user looked on Pip and settled this call as not sent, so it may be made again.",
    });
    // Settled as not sent, the same key may be made again, and is decided again.
    const retried = await hub.call({ shelf: "top", key: "s-1" });
    expect(retried.answer.refused).toBe(false);
    expect(retried.asked).toHaveLength(1);
  });

  // covers PE-003, ADR 031
  it("[TC-PE-485] plans and stores a Charm write's input redacted, and says which fields were", async () => {
    const hub = pipWrites();
    const { answer, asked } = await hub.call({ shelf: "top", note: `Use ${SECRET}`, key: "s-1" });
    expect(answer.refused).toBe(false);
    expect(hub.planned).toEqual([
      { input: { shelf: "top", note: expect.not.stringContaining(SECRET) }, redacted: ["note"] },
    ]);
    expect(JSON.stringify(asked)).not.toContain(SECRET);
    const [row] = [...hub.rows.values()];
    expect(row?.input).not.toContain(SECRET);
    expect(row).toMatchObject({ charm: "Pip", tool: "pip_shelve", site: "pip top", appliedText: "Shelved on top." });
    expect(JSON.parse(row?.plan ?? "{}")).toEqual({ shelf: "top" });
  });

  // covers EX-004, ADR 031
  it("[TC-PE-486] records the call's step before its never-twice record, and records neither when the step cannot be", async () => {
    const hub = pipWrites();
    await hub.call({ shelf: "top", key: "s-1" });
    expect(hub.happened).toEqual(["planned top", "asked", "recorded pip_shelve Shelving on top", "began s-1", "sent"]);

    const unrecorded = pipWrites({ records: false });
    const { answer } = await unrecorded.call({ shelf: "top", key: "s-1" });
    expect(answer).toEqual({ text: UNRECORDED_TOOL_CALL, refused: true });
    expect(unrecorded.happened).toEqual(["planned top", "asked", "recorded pip_shelve Shelving on top"]);
    expect(unrecorded.rows.size).toBe(0);
  });
});

// A built-in set, Notes, on the pipeline as the Memory and Skill tools are (#1135): offered by its
// operations' answers, answering a call that changes nothing without deciding it, and keeping its own answers.

interface NotesScenario {
  /** The hob's own answers for the set's operations. */
  readonly overrides?: Readonly<Record<string, PolicyDecision>>;
  /** What the policy answers each call. */
  readonly decision?: PolicyDecision;
}

const notesTurn = (now: ToolAccess | null, approvals: TurnApprovals | null) => ({
  agentId: AgentId.make("hob"),
  threadId: null,
  messageId: null,
  scope: () => "",
  currentAccess: Effect.succeed(now),
  redactor: makeRedactor(),
  approvals,
});

const approvingOnce: TurnApprovals = {
  request: (action) =>
    Effect.gen(function* () {
      const digest = yield* actionDigest(action);
      return {
        approvalId: ApprovalId.make("approval-1"),
        decision: Effect.succeed<ApprovalOutcome>({
          _tag: "Approved",
          actionDigest: digest,
          policyVersion: action.policyVersion,
          lifetime: "once",
        }),
      };
    }),
  currentAccess: Effect.succeed(access()),
  grants: Effect.succeed([]),
  used: () => Effect.void,
};

/** Offers the Notes set to a turn under `scenario`, and says what each call did. */
const offerNotes = (scenario: NotesScenario = {}, now: ToolAccess | null = access()) => {
  const happened: Array<string> = [];
  const shelf = Schema.Struct({ shelf: Schema.String });
  const tools = offerHubActions({
    owner: { _tag: "BuiltIn" },
    actions: [
      hubAction({
        tool: { name: "notes_search", description: "Searches notes.", inputSchema: {}, label: "Searching notes" },
        input: shelf,
        effect: "read",
        operation: "search-memory",
        otherwise: "notes are closed",
        unreadable: () => "Name the shelf to search as `shelf`.",
        plan: (input) =>
          Effect.succeed({
            request: { _tag: "Memory", operation: "search-memory" },
            card: { arguments: { ...input } },
            send: Effect.sync(() => {
              happened.push("searched");
              return `Nothing on the ${input.shelf} shelf.`;
            }),
          }),
      }),
      hubAction({
        tool: { name: "notes_save", description: "Saves a note.", inputSchema: {}, label: "Saving a note" },
        input: shelf,
        effect: "write",
        operation: "save-memory",
        otherwise: "notes are closed",
        plan: (input) =>
          input.shelf === "kept"
            ? Effect.succeed({ _tag: "NoCall", text: "That note is already kept, so nothing changed." } as const)
            : Effect.succeed({
                request: { _tag: "Memory", operation: "save-memory" },
                card: { arguments: { ...input } },
                send: Effect.sync(() => {
                  happened.push("saved");
                  return { text: "You already used this key for another note.", refused: true };
                }),
              }),
      }),
    ],
    decide: (_approvals, _base, request) => () =>
      Effect.sync(() => {
        happened.push(`decided ${request.operation}`);
        return { ...verdict(scenario.decision ?? "allow"), operation: request.operation ?? "search-memory" };
      }),
  });
  const withOverrides =
    now === null
      ? null
      : { ...now, policy: { ...now.policy, hob: { ...now.policy.hob, overrides: scenario.overrides ?? {} } } };
  const call = (name: string, input: unknown) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const offered = yield* tools(notesTurn(withOverrides, approvingOnce));
        if (offered === null) return { offered: null, answer: null };
        const step = hubCallStep(
          "toolu_1",
          () => {},
          (event) =>
            Effect.sync(() => {
              happened.push(`recorded ${event.tool}`);
              return true;
            }),
        );
        return { offered: offered.tools.map((tool) => tool.name), answer: yield* offered.call(name, input, step) };
      }),
    );
  return { call, happened };
};

describe("a built-in set on the hub action pipeline (#1135)", () => {
  // covers PE-008, ADR 014, ADR 031
  it("[TC-PE-490] offers only the tools whose operation the hob's policy does not answer Never for", async () => {
    const all = await offerNotes().call("notes_search", { shelf: "top" });
    expect(all.offered).toEqual(["notes_search", "notes_save"]);

    const noSaves = offerNotes({ overrides: { "save-memory": "deny" } });
    const narrowed = await noSaves.call("notes_save", { shelf: "top" });
    expect(narrowed.offered).toEqual(["notes_search"]);
    // A call to the tool that was not offered still reaches the pipeline, which decides it.
    expect(noSaves.happened).toEqual(["decided save-memory", "recorded notes_save", "saved"]);

    const none = await offerNotes({ overrides: { "search-memory": "deny", "save-memory": "deny" } }).call(
      "notes_search",
      { shelf: "top" },
    );
    expect(none).toEqual({ offered: null, answer: null });
    expect(await offerNotes({}, null).call("notes_search", { shelf: "top" })).toEqual({ offered: null, answer: null });
  });

  // covers EX-004, ADR 031
  it("[TC-PE-491] answers a call that changes nothing unrecorded, and keeps a set's own words and answers", async () => {
    const kept = offerNotes();
    expect((await kept.call("notes_save", { shelf: "kept" })).answer).toEqual({
      text: "That note is already kept, so nothing changed.",
      refused: false,
    });
    expect(kept.happened).toEqual([]);

    const unread = offerNotes();
    expect((await unread.call("notes_search", { shelf: 3 })).answer).toEqual({
      text: "Name the shelf to search as `shelf`.",
      refused: true,
    });
    expect(unread.happened).toEqual([]);

    // A refused answer of the set's own, after an approval, says it was refused and how it was approved.
    const asked = offerNotes({ decision: "ask" });
    const answer = (await asked.call("notes_save", { shelf: "top" })).answer;
    expect(answer?.refused).toBe(true);
    expect(answer?.text).toBe(
      "You already used this key for another note. Hobbots showed the user an approval request for this call before it ran. They approved it just this once, so a call like it asks again.",
    );
    // Decided, asked, decided again on the approval, then recorded before it is sent.
    expect(asked.happened).toEqual(["decided save-memory", "decided save-memory", "recorded notes_save", "saved"]);
  });
});
