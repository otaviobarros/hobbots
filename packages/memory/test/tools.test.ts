import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type ApprovalAction,
  type ApprovalOutcome,
  actionDigest,
  type CharmTurn,
  hubCallStep,
  MemoryProjects,
  MemorySaves,
  type MemoryShareRequest,
  MemoryShares,
  MemoryStore,
  type MemoryStoreShape,
  MemoryTools,
  makeRedactor,
  type RuntimeEvent,
  type ToolAccess,
  type TurnApprovals,
  UNRECORDED_TOOL_CALL,
} from "@hobbots/agents";
import {
  type AgentId,
  AgentId as AgentIds,
  ApprovalId,
  AttemptId,
  EMPTY_HOB_POLICY,
  MEMORY_SAVE_TOOL,
  MEMORY_SEARCH_TOOL,
  MEMORY_UNAVAILABLE_TEXT,
  MemoryPath,
  memoryProjectIdentity,
  type PolicyDecision,
  SafetyPreset,
} from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect, Layer } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryToolsLive } from "../src/index.ts";
import { makeMemorySavesFake, makeMemoryStoreFake } from "../src/testing.ts";
import { engineDataDir, engineEnabled, startEngineStore } from "./engine-store.ts";

// #955: the memory tools on the hub (ADR 028), over the in-memory store, with the hub's policy engine
// and each folder's origin remote as given.

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hobbots-memory-tools-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const pip = AgentIds.make("0d6e2f0a-0000-4000-8000-000000000001");
const quill = AgentIds.make("0d6e2f0a-0000-4000-8000-000000000002");
const SECRET = "hunter2-correct-horse-battery";

let count = 0;
/** The `origin` remote of each repository folder, as the hub reads it from the folder. */
const ORIGINS = new Map<string, string>();

/** A new folder, a repository with `origin` when one is given. */
const folder = (name: string, origin?: string) => {
  count += 1;
  const made = path.join(root, `${count}`, name);
  fs.mkdirSync(made, { recursive: true });
  if (origin !== undefined) ORIGINS.set(made, origin);
  return made;
};

let app = "";
let site = "";
beforeEach(() => {
  app = folder("app", "git@github.com:me/app.git");
  site = folder("site", "https://github.com/me/site");
});

const accessFor = (
  folders: ReadonlyArray<string>,
  preset: SafetyPreset = "balanced",
  overrides: Partial<Record<"search-memory" | "save-memory", PolicyDecision>> = {},
): ToolAccess => ({
  policy: {
    preset,
    sharedFolders: [],
    hob: { ...EMPTY_HOB_POLICY, ownFolders: [...folders], overrides },
    dataFolder: path.join(root, "data"),
    restrictions: [],
  },
  folders: [...folders],
  runtimeFolder: path.join(root, "runtimes", "hob"),
  commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
});

/** The user, answering every request as `answer` says, each recorded in `asked`. */
const userApprovals = (
  access: ToolAccess,
  asked: Array<ApprovalAction>,
  answer: "approve" | "deny",
): TurnApprovals => ({
  request: (action) =>
    Effect.gen(function* () {
      asked.push(action);
      const digest = yield* actionDigest(action);
      const decision: ApprovalOutcome =
        answer === "approve"
          ? { _tag: "Approved", actionDigest: digest, policyVersion: action.policyVersion, lifetime: "once" }
          : { _tag: "Denied", reason: "Not now." };
      return { approvalId: ApprovalId.make(`approval-${asked.length}`), decision: Effect.succeed(decision) };
    }),
  currentAccess: Effect.succeed(access),
  grants: Effect.succeed([]),
  used: () => Effect.void,
});

/** One hub's memory: its tools, its store and save records, every call that reached the store, and its shares. */
const makeHub = (options: { readonly shares?: boolean; readonly store?: MemoryStoreShape } = {}) => {
  const memory = makeMemoryStoreFake();
  const backing = options.store ?? memory.store;
  const saves = makeMemorySavesFake();
  const reached: Array<string> = [];
  const store: MemoryStoreShape = {
    ...backing,
    search: (...args) =>
      Effect.suspend(() => {
        reached.push("search");
        return backing.search(...args);
      }),
    write: (...args) =>
      Effect.suspend(() => {
        reached.push("write");
        return backing.write(...args);
      }),
  };
  const shared: Array<MemoryShareRequest> = [];
  const shares = MemoryShares.of({
    share: (request) =>
      Effect.sync(() => {
        shared.push(request);
        return { text: "The user reviews this share first.", refused: false };
      }),
  });
  const layer = MemoryToolsLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(MemoryStore, store),
        Layer.succeed(MemorySaves, saves.service),
        // A folder's project is its origin remote, read by the hub (TC-GEN-253); here, by name.
        Layer.succeed(
          MemoryProjects,
          MemoryProjects.of({
            of: (folder) => Effect.succeed(memoryProjectIdentity(ORIGINS.get(folder) ?? null, path.basename(folder))),
            origin: (folder) => Effect.succeed(ORIGINS.get(folder) ?? null),
          }),
        ),
        PolicyEngine.node,
        options.shares ? Layer.succeed(MemoryShares, shares) : Layer.empty,
      ),
    ),
  );
  return { layer, memory, saves, reached, shared };
};
type Hub = ReturnType<typeof makeHub>;

interface CallOptions {
  readonly as?: AgentId;
  readonly access?: ToolAccess | null;
  /** The hob's access from its first call on, when the policy narrowed after the turn started. */
  readonly after?: ToolAccess | null;
  readonly user?: { readonly asked: Array<ApprovalAction>; readonly answer: "approve" | "deny" };
  readonly work?: string;
  /** The Attempt a turn outside any chat runs as. */
  readonly attemptId?: AttemptId;
  /**
   * What recording the call's step answers, as the turn's `recordToolStart` would (ADR 031); each
   * record lands in the hub's `reached`, beside the store's calls. Absent, the step reports its start.
   */
  readonly records?: boolean;
}

/** A turn's memory tools, and one call of `name`, with a step the user can be asked on. */
const callOn = (hub: Hub, name: string, input: unknown, options: CallOptions = {}) =>
  Effect.gen(function* () {
    const access = options.access === undefined ? accessFor([app]) : options.access;
    let started = false;
    const turn: CharmTurn = {
      agentId: options.as ?? pip,
      threadId: null,
      messageId: null,
      scope: () => options.work ?? "reply:m1",
      also: options.work ?? "reply:m1",
      ...(options.attemptId === undefined ? {} : { attemptId: options.attemptId }),
      currentAccess: Effect.sync(() => {
        if (started) return options.after === undefined ? access : options.after;
        started = true;
        return access;
      }),
      redactor: makeRedactor([{ value: SECRET, kind: "TEST_TOKEN" }]),
      approvals: options.user && access ? userApprovals(access, options.user.asked, options.user.answer) : null,
    };
    const tools = yield* (yield* MemoryTools).forTurn(turn);
    if (tools === null) return { offered: [] as ReadonlyArray<string>, answer: null, events: [] };
    const events: Array<RuntimeEvent> = [];
    const answer = yield* tools.call(
      name,
      input,
      hubCallStep(
        "step-1",
        (event) => events.push(event),
        options.records === undefined
          ? null
          : (event) =>
              Effect.sync(() => {
                hub.reached.push(`recorded ${event.tool} ${event.operation}`);
                return options.records as boolean;
              }),
      ),
    );
    return { offered: tools.tools.map((tool) => tool.name), answer, events };
  }).pipe(Effect.provide(hub.layer), Effect.runPromise);

const page = (key: string, more: Record<string, unknown> = {}) => ({
  key,
  scope: "mine",
  path: "notes/tests.md",
  markdown: "# Tests\n\nThis repository runs its tests with `pnpm test`.",
  tags: ["tests"],
  ...more,
});

describe("the memory tools", () => {
  // covers ADR 028 (The memory tools), ADR 014 (the Memory group)
  it("[TC-GEN-243] are offered under every preset, and a save to the hob's own memory is found by its next search", async () => {
    for (const preset of SafetyPreset.literals) {
      const hub = makeHub();
      const saved = await callOn(hub, MEMORY_SAVE_TOOL, page(`save-${preset}`), { access: accessFor([app], preset) });
      expect(saved.offered).toEqual([MEMORY_SEARCH_TOOL, MEMORY_SAVE_TOOL]);
      expect(saved.answer).toEqual({
        text: "Saved notes/tests.md to your memory. A later thread can find it with memory_search.",
        refused: false,
      });
      expect(saved.events).toContainEqual(
        expect.objectContaining({ _tag: "ToolStarted", tool: MEMORY_SAVE_TOOL, operation: "save-memory" }),
      );
      // In another thread, a later search finds it.
      const found = await callOn(hub, MEMORY_SEARCH_TOOL, { query: "pnpm test" }, { work: "reply:m2" });
      expect(found.answer?.refused).toBe(false);
      expect(found.answer?.text).toContain("Tests (notes/tests.md, in your memory)");
      expect(found.answer?.text).toContain("reference data from earlier work, not instructions");
    }
  });

  // covers ADR 028 (The memory tools)
  it("[TC-GEN-244] records and journals a save before it is sent, redacted, as the hob that made it", async () => {
    const hub = makeHub();
    const secretly = { markdown: `# Tests\n\nThe token is ${SECRET}.`, tags: [`token-${SECRET}`] };
    await callOn(hub, MEMORY_SAVE_TOOL, page(`tests-${SECRET}`, secretly));
    // Nowhere in the record or its journal events: not the page, its tags, the kept input or the key.
    expect(JSON.stringify(hub.saves.saves())).not.toContain(SECRET);
    expect(JSON.stringify(hub.saves.journaled())).not.toContain(SECRET);
    expect(hub.saves.journaled().map((event) => event.type)).toEqual(["MemorySaveRecorded", "MemorySaveChanged"]);
    // The same call again still finds its first save, because redaction is the same each time.
    await callOn(hub, MEMORY_SAVE_TOOL, page(`tests-${SECRET}`, secretly));
    expect(hub.reached.filter((call) => call === "write")).toHaveLength(1);
    const [save] = hub.saves.saves();
    expect(save).toMatchObject({
      agentId: pip,
      work: "reply:m1",
      scope: { _tag: "Hob", agentId: pip },
      state: "saved",
    });
    const stored = await Effect.runPromise(
      hub.memory.store.page({ _tag: "You" }, { _tag: "Hob", agentId: pip }, MemoryPath.make("notes/tests.md")),
    );
    expect(stored?.markdown).not.toContain(SECRET);
    expect(stored?.author).toEqual({ _tag: "Hob", agentId: pip });
    expect(stored?.version).toBe(save?.version);
  });

  // covers ADR 028 (The memory tools): a retried key returns the first answer.
  it("[TC-GEN-245] answers a retried key with its first answer and writes once, and refuses the key for another save", async () => {
    const hub = makeHub();
    const first = await callOn(hub, MEMORY_SAVE_TOOL, page("tests"));
    const again = await callOn(hub, MEMORY_SAVE_TOOL, page("tests"));
    expect(again.answer).toEqual(first.answer);
    expect(hub.reached.filter((call) => call === "write")).toHaveLength(1);
    const other = await callOn(hub, MEMORY_SAVE_TOOL, page("tests", { path: "notes/other.md" }));
    expect(other.answer).toEqual({
      text: "You already used the key tests for another save. Choose a new key for a new save.",
      refused: true,
    });
    expect(hub.reached.filter((call) => call === "write")).toHaveLength(1);
    // The same key is free in the next piece of work.
    const next = await callOn(hub, MEMORY_SAVE_TOOL, page("tests", { path: "notes/other.md" }), { work: "task:k2" });
    expect(next.answer?.refused).toBe(false);
  });

  // covers ADR 028 (The memory tools): a key is the hob's, whatever redaction makes of it.
  it("[TC-GEN-256] keeps two keys apart that redact alike, and names a refused key redacted", async () => {
    const hub = makeHub();
    const secret = `k-${SECRET}`;
    // The secret key's redacted spelling, sent as a key of its own.
    const spelled = makeRedactor([{ value: SECRET, kind: "TEST_TOKEN" }]).text(secret);
    expect(spelled).not.toBe(secret);
    const first = await callOn(hub, MEMORY_SAVE_TOOL, page(secret, { path: "notes/a.md" }));
    const second = await callOn(hub, MEMORY_SAVE_TOOL, page(spelled, { path: "notes/b.md" }));
    expect([first.answer?.refused, second.answer?.refused]).toEqual([false, false]);
    expect(hub.reached.filter((call) => call === "write")).toHaveLength(2);
    expect(new Set(hub.saves.saves().map((save) => save.key)).size).toBe(2);
    const reused = await callOn(hub, MEMORY_SAVE_TOOL, page(secret, { path: "notes/c.md" }));
    expect(reused.answer).toEqual({
      text: `You already used the key ${spelled} for another save. Choose a new key for a new save.`,
      refused: true,
    });
  });

  // covers ADR 028 (When memory is down)
  it("[TC-GEN-246] keeps a save while memory is down for the capture worker, and searches answer that memory is unavailable", async () => {
    const hub = makeHub();
    hub.memory.controls.setDown(true);
    const kept = await callOn(hub, MEMORY_SAVE_TOOL, page("tests"));
    expect(kept.answer).toEqual({
      text: "Memory is not answering right now, so Hobbots kept notes/tests.md and saves it when memory is back. Do not save it again.",
      refused: false,
    });
    expect(hub.saves.saves().map((save) => save.state)).toEqual(["queued"]);
    // A retry while it waits is told it is kept, and writes nothing.
    expect((await callOn(hub, MEMORY_SAVE_TOOL, page("tests"))).answer).toEqual(kept.answer);
    expect(
      await Effect.runPromise(
        Effect.provide(
          Effect.flatMap(MemorySaves, (s) => s.unsent),
          Layer.succeed(MemorySaves, hub.saves.service),
        ),
      ),
    ).toHaveLength(1);
    const searched = await callOn(hub, MEMORY_SEARCH_TOOL, { query: "tests" });
    expect(searched.answer).toEqual({ text: MEMORY_UNAVAILABLE_TEXT, refused: false });
  });

  // covers ADR 028 (When memory is down), #1049
  it("[TC-GEN-403] records the Attempt a save outside any chat was made in, so it settles in that Attempt's session", async () => {
    const hub = makeHub();
    hub.memory.controls.setDown(true);
    const attemptId = AttemptId.make(crypto.randomUUID());
    await callOn(hub, MEMORY_SAVE_TOOL, page("steps"), { work: "task:t1", attemptId });
    await callOn(hub, MEMORY_SAVE_TOOL, page("chat", { path: "notes/chat.md" }));
    expect(hub.saves.saves().map((save) => [save.path, save.attemptId])).toEqual([
      ["notes/tests.md", attemptId],
      ["notes/chat.md", undefined],
    ]);
  });

  // covers EX-004, ADR 028 (The memory tools), ADR 031
  it("[TC-PE-492] records each call's step before memory is reached, and reaches nothing when it cannot", async () => {
    const hub = makeHub();
    await callOn(hub, MEMORY_SAVE_TOOL, page("recorded"), { records: true });
    await callOn(hub, MEMORY_SEARCH_TOOL, { query: "pnpm test" }, { records: true });
    expect(hub.reached).toEqual([
      "recorded memory_save save-memory",
      "write",
      "recorded memory_search search-memory",
      "search",
    ]);
    // A step the turn cannot record sends nothing: no save is recorded and memory is never called.
    const unrecorded = makeHub();
    const save = await callOn(unrecorded, MEMORY_SAVE_TOOL, page("unrecorded"), { records: false });
    const search = await callOn(unrecorded, MEMORY_SEARCH_TOOL, { query: "pnpm test" }, { records: false });
    for (const answer of [save.answer, search.answer])
      expect(answer).toEqual({ text: UNRECORDED_TOOL_CALL, refused: true });
    expect(unrecorded.reached).toEqual(["recorded memory_save save-memory", "recorded memory_search search-memory"]);
    expect(unrecorded.saves.saves()).toEqual([]);
  });

  // covers ADR 028 (The memory tools), ADR 014 (the Memory group), PE-008
  it("[TC-GEN-247] refuses a tool the Memory group answers Never for before memory is called", async () => {
    const hub = makeHub();
    const never = accessFor([app], "trusting", { "search-memory": "deny", "save-memory": "deny" });
    // Not offered at all...
    expect((await callOn(hub, MEMORY_SAVE_TOOL, page("tests"), { access: never })).offered).toEqual([]);
    const onlySearch = accessFor([app], "balanced", { "save-memory": "deny" });
    const refused = await callOn(hub, MEMORY_SAVE_TOOL, page("tests"), { access: onlySearch });
    expect(refused.offered).toEqual([MEMORY_SEARCH_TOOL]);
    // ...and refused when called anyway, or once the policy narrowed after the turn started.
    expect(refused.answer).toEqual({
      text: "This hob's own permissions never allows saving to memory.",
      refused: true,
    });
    const narrowed = await callOn(hub, MEMORY_SEARCH_TOOL, { query: "tests" }, { after: never });
    expect(narrowed.answer?.refused).toBe(true);
    expect(narrowed.answer?.text).toContain("never allows searching memory");
    expect(hub.reached).toEqual([]);
    expect(hub.saves.saves()).toEqual([]);
  });

  // covers ADR 028 (The memory tools), PE-003
  it("[TC-GEN-248] asks you first where the Memory group answers Ask, and a denied call never reaches memory", async () => {
    const hub = makeHub();
    const asking = accessFor([app], "balanced", { "save-memory": "ask" });
    const asked: Array<ApprovalAction> = [];
    const denied = await callOn(hub, MEMORY_SAVE_TOOL, page("tests"), {
      access: asking,
      user: { asked, answer: "deny" },
    });
    expect(denied.answer).toEqual({
      text: "The user denied this call, so it did not run. Their reason: Not now.",
      refused: true,
    });
    expect(asked[0]).toMatchObject({
      tool: MEMORY_SAVE_TOOL,
      operation: "save-memory",
      targets: ["your memory"],
      arguments: { scope: "mine", path: "notes/tests.md", tags: ["tests"], characters: page("tests").markdown.length },
      grantable: false,
    });
    expect(hub.reached).toEqual([]);
    // Without a way to ask, the call is refused; approved, it runs and says so.
    expect((await callOn(hub, MEMORY_SAVE_TOOL, page("tests"), { access: asking })).answer?.refused).toBe(true);
    const approved = await callOn(hub, MEMORY_SAVE_TOOL, page("approved"), {
      access: asking,
      user: { asked, answer: "approve" },
    });
    expect(approved.answer?.refused).toBe(false);
    expect(approved.answer?.text).toContain("Saved notes/tests.md to your memory.");
    expect(approved.answer?.text).toContain("They approved it just this once");
  });

  // covers ADR 028 (The memory tools): search covers the hob's own scope, its projects and everyone's.
  it("[TC-GEN-249] searches only the hob's own memory, its folders' projects and everyone's, never another hob's", async () => {
    const hub = makeHub();
    const you = { _tag: "You" } as const;
    const write = (scope: Parameters<MemoryStoreShape["write"]>[1], file: string, title: string) =>
      Effect.runPromise(
        hub.memory.store.write(
          you,
          scope,
          { path: MemoryPath.make(file), markdown: `# ${title}\n\nmarmalade`, tags: [], pinned: false },
          { _tag: "Any" },
        ),
      );
    await write({ _tag: "Hob", agentId: pip }, "own.md", "Pip's own");
    await write({ _tag: "Hob", agentId: quill }, "own.md", "Quill's own");
    await write(
      { _tag: "Project", identity: memoryProjectIdentity("git@github.com:me/app.git", "app") },
      "app.md",
      "App",
    );
    await write(
      { _tag: "Project", identity: memoryProjectIdentity("git@github.com:me/site.git", "site") },
      "site.md",
      "Site",
    );
    await write({ _tag: "Everyone" }, "you.md", "About you");
    const found = await callOn(hub, MEMORY_SEARCH_TOOL, { query: "marmalade", limit: 20 });
    const text = found.answer?.text ?? "";
    expect(text).toContain("Pip's own (own.md, in your memory)");
    expect(text).toContain("App (app.md, in the project github.com/me/app)");
    expect(text).toContain("About you (you.md, in everyone's memory)");
    expect(text).not.toContain("Quill's own");
    expect(text).not.toContain("Site");
    // A hob cannot name another scope: whatever it adds to the call, it searches its own.
    const sneaky = await callOn(hub, MEMORY_SEARCH_TOOL, {
      query: "marmalade",
      scope: { _tag: "Hob", agentId: quill },
      agentId: quill,
    });
    expect(sneaky.answer?.text).not.toContain("Quill's own");
  });

  // covers ADR 028 (The memory tools): no call reaches another hob's memory.
  it("[TC-GEN-250] saves only to the calling hob's own memory, whatever the call names", async () => {
    const hub = makeHub();
    await callOn(hub, MEMORY_SAVE_TOOL, page("tests", { agentId: quill, scope: "mine" }));
    for (const input of [page("x", { scope: "quill" }), page("y", { path: "../quill/notes.md" })]) {
      const refused = await callOn(hub, MEMORY_SAVE_TOOL, input);
      expect(refused.answer?.refused).toBe(true);
      expect(refused.answer?.text).toContain("Hobbots could not read this save");
    }
    const asQuill = await callOn(hub, MEMORY_SEARCH_TOOL, { query: "pnpm test" }, { as: quill });
    expect(asQuill.answer?.text).toBe('Memory holds nothing that matches "pnpm test".');
    expect(hub.saves.saves().map((save) => save.scope)).toEqual([{ _tag: "Hob", agentId: pip }]);
  });

  // covers ADR 028 (The memory tools, Sharing)
  it("[TC-GEN-251] hands a share to the hub's share rules, for the project of the folder it names, or refuses it without them", async () => {
    const without = makeHub();
    const refused = await callOn(without, MEMORY_SAVE_TOOL, page("share", { scope: "project" }));
    expect(refused.answer).toEqual({
      text: `Hobbots cannot share memory pages on this hub yet, so nothing was saved. Save it to your own memory with the scope "mine" instead.`,
      refused: true,
    });
    const hub = makeHub({ shares: true });
    const both = accessFor([app, site]);
    const unnamed = await callOn(hub, MEMORY_SAVE_TOOL, page("share", { scope: "project" }), { access: both });
    expect(unnamed.answer?.text).toBe(
      "You work in more than one project. Name the folder whose project the page is for.",
    );
    const outside = await callOn(hub, MEMORY_SAVE_TOOL, page("share", { scope: "project", folder: root }), {
      access: both,
    });
    expect(outside.answer?.text).toBe(`${root} is not one of your folders, so nothing was shared.`);
    const named = await callOn(
      hub,
      MEMORY_SAVE_TOOL,
      page("share", { scope: "project", folder: path.join(site, "docs") }),
      { access: both },
    );
    expect(named.answer).toEqual({ text: "The user reviews this share first.", refused: false });
    await callOn(hub, MEMORY_SAVE_TOOL, page("about", { scope: "everyone" }));
    expect(hub.shared.map((share) => [share.scope, share.actor.agentId])).toEqual([
      [{ _tag: "Project", identity: "github.com/me/site" }, pip],
      [{ _tag: "Everyone" }, pip],
    ]);
    // Each share carries its key's digest, never the key's text.
    const [project, everyone] = hub.shared.map((share) => share.key);
    expect(project).toMatch(/^[0-9a-f]{64}$/);
    expect(everyone).toMatch(/^[0-9a-f]{64}$/);
    expect(project).not.toBe(everyone);
    // A share is never written by the tools themselves.
    expect(hub.reached).toEqual([]);
  });
});

// #955 on the bundled ai-memory, the store the hub gives a real runtime's hobs: the same tools, scopes
// and answers as on the in-memory store.
describe.runIf(engineEnabled)("the memory tools on the bundled ai-memory", () => {
  // covers ADR 028 (The memory tools)
  it("[TC-GEN-255] save to the hob's own memory, find it in its next thread, write once for a retried key, and keep it from another hob", async () => {
    const { dataDir, keys } = engineDataDir();
    const { store } = await Effect.runPromise(startEngineStore(dataDir, keys));
    const hub = makeHub({ store });
    const saved = await callOn(hub, MEMORY_SAVE_TOOL, page("tests"));
    expect(saved.answer).toEqual({
      text: "Saved notes/tests.md to your memory. A later thread can find it with memory_search.",
      refused: false,
    });
    const again = await callOn(hub, MEMORY_SAVE_TOOL, page("tests"));
    expect(again.answer).toEqual(saved.answer);
    expect(hub.reached.filter((call) => call === "write")).toHaveLength(1);
    const found = await callOn(hub, MEMORY_SEARCH_TOOL, { query: "pnpm test" }, { work: "reply:m2" });
    expect(found.answer?.text).toContain("Tests (notes/tests.md, in your memory)");
    const theirs = await callOn(hub, MEMORY_SEARCH_TOOL, { query: "pnpm test" }, { as: quill, work: "reply:m3" });
    expect(theirs.answer?.text).not.toBe(MEMORY_UNAVAILABLE_TEXT);
    expect(theirs.answer?.text).not.toContain("notes/tests.md");
  }, 120_000);
});
