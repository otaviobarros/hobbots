import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Agent,
  type MemoryHit,
  type MemoryPage,
  type MemoryPageSummary,
  type MemoryPageVersion,
  type MemorySave,
  type MemoryShare,
  type Message,
  memoryScopeKey,
  type Thread,
} from "@hobbots/domain";
import { testEngine } from "@hobbots/memory/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HubProcess, killHubProcesses, startHubProcess } from "./hub-process.ts";

// #964: ADR 028's memory scenarios end to end, on the hub as `main.ts` composes it, in its own
// process, with the fake runtime making the hobs' scripted calls and the bundled ai-memory as the
// engine. Skipped without the engine, and failed for its absence in CI (HOBBOTS_MEMORY_CONTRACT=1).
vi.setConfig({ testTimeout: 180_000 });

let root = "";
let hub: HubProcess | undefined;

afterEach(async () => {
  await hub?.stop();
  // A hub that never answered, or that a timed-out test left running, is killed before its data goes.
  await killHubProcesses();
  hub = undefined;
  if (root !== "") rmSync(root, { recursive: true, force: true });
  root = "";
});

/** A data folder and a Git repository with a remote, as a hob's project. */
const prepare = () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-memory-hub-")));
  const project = join(root, "app");
  const dataDir = join(root, "data");
  for (const folder of [project, dataDir]) mkdirSync(folder, { recursive: true });
  execFileSync("git", ["init", "--quiet", project]);
  execFileSync("git", ["-C", project, "remote", "add", "origin", "git@github.com:me/app.git"]);
  return { project, dataDir };
};

/** The hub with memory on over the engine in `engineDir`, and no fake memory. */
const start = (dataDir: string, engineDir = testEngine.folder ?? "") =>
  startHubProcess(dataDir, {
    HOBBOTS_MEMORY: "on",
    HOBBOTS_MEMORY_ENGINE_DIR: engineDir,
    HOBBOTS_FAKE_MEMORY: undefined,
  });

/** A request to the hub's API as its window, answered as it came. */
const call = (method: string, path: string, body?: unknown) => {
  if (hub === undefined) throw new Error("No hub");
  return fetch(`${hub.url}/api${path}`, {
    method,
    headers: { "content-type": "application/json", ...hub.asWindow() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
};

/** A request to the hub's API as its window, which must succeed; answers its JSON. */
const api = async <A>(method: string, path: string, body?: unknown): Promise<A> => {
  const response = await call(method, path, body);
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return (text === "" ? undefined : JSON.parse(text)) as A;
};

/** Reads until `read` answers something, for up to `seconds`. */
const eventually = async <A>(what: string, read: () => Promise<A | undefined>, seconds = 60): Promise<A> => {
  const deadline = Date.now() + seconds * 1000;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`Waited ${seconds}s for ${what}${last === undefined ? "" : `: ${String(last)}`}`);
};

const messages = (thread: Thread) => api<ReadonlyArray<Message>>("GET", `/threads/${thread.id}/messages`);

/** Sends `lines` as one message and waits until its reply has ended. */
const exchange = async (thread: Thread, ...lines: Array<string>) => {
  const before = (await messages(thread)).length;
  await api("POST", `/threads/${thread.id}/messages`, { content: lines.join("\n") });
  return eventually("the reply", async () => {
    const all = await messages(thread);
    const last = all.at(-1);
    return all.length >= before + 2 && last?.role === "assistant" && last.status === "complete" ? last : undefined;
  });
};

interface EngineHealth {
  readonly state: "starting" | "running" | "restarting" | "off";
  readonly restarts: number;
}

/** The memory engine as Settings › Diagnostics shows it. */
const engineHealth = async () => (await api<{ readonly memory: EngineHealth | null }>("GET", "/diagnostics")).memory;

/** Waits until Diagnostics shows the engine running. */
const engineRunning = () =>
  eventually("the memory engine to run", async () => {
    const health = await engineHealth();
    return health?.state === "running" ? health : undefined;
  });

const hubCall = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

/** Finishes setup under `preset` with `folders` approved. */
const setUp = (folders: ReadonlyArray<string>, preset: "balanced" | "trusting" = "balanced") =>
  api("PATCH", "/setup", {
    completed: true,
    connectedProviders: ["claude-code"],
    safetyPreset: preset,
    approvedFolders: folders,
  });

/** A hob that works in every approved folder, as setup shares them with every hob. */
const summon = (name: string, lookSeed: number) =>
  api<Agent>("POST", "/agents", {
    name,
    role: null,
    roleTitle: "Engineer",
    sigil: "assistant",
    hat: null,
    tool: null,
    lookSeed,
    lookColor: "moss",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });

const newThread = (hob: Agent) => api<Thread>("POST", `/agents/${hob.id}/threads`);

const ownScope = (hob: Agent) => memoryScopeKey({ _tag: "Hob", agentId: hob.id });

type PageRead = { readonly page: MemoryPage; readonly history: ReadonlyArray<MemoryPageVersion> };

/** A page as the Memory page reads it, or undefined while memory does not have it. */
const readPage = (scope: string, path: string) =>
  api<PageRead>("GET", `/memory/page?${new URLSearchParams({ scope, path })}`).catch(() => undefined);

const pagesOf = (scope: string) =>
  api<ReadonlyArray<MemoryPageSummary>>("GET", `/memory/pages?${new URLSearchParams({ scope })}`);

/** A copy of the bundled engine, for a test that takes it away and brings it back. */
const engineCopy = () => {
  const folder = join(root, "engine");
  cpSync(testEngine.folder ?? "", folder, { recursive: true });
  return folder;
};

/** The process ids of the engine running from `folder`. */
const enginePids = (folder: string) =>
  execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(join(folder, "ai-memory")))
    .map((line) => Number(line.trim().split(/\s+/)[0]));

const LESSON = {
  key: "tests",
  scope: "mine",
  path: "notes/tests.md",
  markdown: "# Tests\n\nThis repository runs its tests with `pnpm test:unit`, never `pnpm test`.",
};

describe.runIf(testEngine.enabled)("memory end to end on the hub and the bundled ai-memory", () => {
  // covers CH-001, CH-002, ADR 028 (The memory tools, The memory brief)
  it("[TC-CH-289] a lesson a hob learns in one thread is in its next thread's brief and search, and never another hob's", async () => {
    const { project, dataDir } = prepare();
    hub = await start(dataDir);
    await engineRunning();
    await setUp([project]);
    const pip = await summon("Pip", 9641);
    const quill = await summon("Quill", 9642);

    const first = await newThread(pip);
    const saved = await exchange(first, "Remember how the tests run", hubCall("memory_save", LESSON));
    expect(saved.content).toContain("memory_save: Saved notes/tests.md to your memory.");

    // The next thread's first turn is briefed from what Pip learned: the fake echoes its briefing.
    const next = await newThread(pip);
    const briefed = await exchange(next, "Run the tests.", hubCall("memory_search", { query: "pnpm" }));
    expect(briefed.content).toContain("## From your memory");
    expect(briefed.content).toContain("never `pnpm test`");
    expect(briefed.content).toContain("Tests (notes/tests.md, in your memory)");

    // Quill works in the same project and learned nothing: no brief from Pip's memory, no hit.
    const theirs = await newThread(quill);
    const unbriefed = await exchange(theirs, "Run the tests.", hubCall("memory_search", { query: "pnpm" }));
    expect(unbriefed.content).not.toContain("never `pnpm test`");
    expect(unbriefed.content).toContain('memory_search: Memory holds nothing that matches "pnpm".');
  });

  // covers ADR 028 (The memory tools, Writes), #961
  it("[TC-GEN-389] a chat lists its own saves, Undo puts back what a save replaced or removes the page it made, and the hob's page counts what it reads", async () => {
    const { project, dataDir } = prepare();
    hub = await start(dataDir);
    await engineRunning();
    await setUp([project]);
    const pip = await summon("Pip", 9647);
    const scope = ownScope(pip);
    const LAUNCH = "decisions/launch.md";
    const save = (key: string, path: string, markdown: string) =>
      hubCall("memory_save", { key, scope: "mine", path, markdown });
    const undo = (saveId: string) => call("POST", `/memory-saves/${saveId}/undo`);

    const thread = await newThread(pip);
    await exchange(thread, "When is the launch?", save("monday", LAUNCH, "# Launch\n\nMonday."));
    await exchange(thread, "It moved.", save("tuesday", LAUNCH, "# Launch\n\nTuesday at 9 AM."));
    await exchange(await newThread(pip), "Elsewhere", save("other", "notes/other.md", "# Other\n\nElsewhere."));

    // The chat lists only its own two saves, each under the reply that made it.
    const replies = (await messages(thread)).filter((message) => message.role === "assistant");
    const saves = await api<ReadonlyArray<MemorySave>>("GET", `/threads/${thread.id}/memory-saves`);
    expect(saves.map((each) => [each.messageId, each.path, each.state])).toEqual(
      replies.map((reply) => [reply.id, LAUNCH, "saved"]),
    );

    // Undo of Tuesday's save puts Monday back, as a version by you, once.
    const tuesday = saves[1]?.id ?? "";
    const undone = await undo(tuesday);
    expect(undone.status, await undone.clone().text()).toBe(200);
    const back = await readPage(scope, LAUNCH);
    expect(back?.page.markdown).toBe("# Launch\n\nMonday.");
    expect(back?.page.author).toEqual({ _tag: "You" });
    expect(await (await undo(tuesday)).json()).toMatchObject({ _tag: "MemorySaveNotUndoable", reason: "undone" });

    // A save you changed the page after is never undone over your change.
    await exchange(thread, "Moved again.", save("thursday", LAUNCH, "# Launch\n\nThursday."));
    const thursday = (await api<ReadonlyArray<MemorySave>>("GET", `/threads/${thread.id}/memory-saves`)).at(-1);
    const theirs = await readPage(scope, LAUNCH);
    await api("POST", "/memory/page", {
      scope,
      path: LAUNCH,
      markdown: "# Launch\n\nFriday, says you.",
      tags: [],
      pinned: false,
      forgetOn: null,
      expected: theirs?.page.version,
    });
    expect(await (await undo(thursday?.id ?? "")).json()).toMatchObject({
      _tag: "MemorySaveNotUndoable",
      reason: "newer",
    });
    expect((await readPage(scope, LAUNCH))?.page.markdown).toBe("# Launch\n\nFriday, says you.");

    // Undo of a save that made a page removes it.
    const others = await api<ReadonlyArray<MemorySave>>(
      "GET",
      `/threads/${(await api<ReadonlyArray<Thread>>("GET", `/agents/${pip.id}/threads`)).find((each) => each.id !== thread.id)?.id}/memory-saves`,
    );
    expect((await undo(others[0]?.id ?? "")).status).toBe(200);
    expect(await readPage(scope, "notes/other.md")).toBeUndefined();

    // The hob's page counts what it reads: its own memory, About you and its project.
    const reads = await api<{ scopes: ReadonlyArray<{ scope: { _tag: string }; pages: number }> }>(
      "GET",
      `/agents/${pip.id}/memory`,
    );
    expect(reads.scopes.map((each) => [each.scope._tag, each.pages])).toEqual([
      ["Hob", 1],
      ["Everyone", 0],
      ["Project", 0],
    ]);
  });

  // covers ADR 028 (Sharing), IN-001
  it("[TC-GEN-387] a page a hob shares reaches another hob only once you share it from the Inbox", async () => {
    const { project, dataDir } = prepare();
    hub = await start(dataDir);
    await engineRunning();
    await setUp([project]);
    const pip = await summon("Pip", 9643);
    const quill = await summon("Quill", 9644);

    const deploy = {
      key: "deploy",
      scope: "project",
      path: "howtos/deploy.md",
      markdown: "# Deploy\n\nRun `pnpm release:canary` before every deploy.",
    };
    const asked = await exchange(await newThread(pip), "Teach the others to deploy", hubCall("memory_save", deploy));
    expect(asked.content).not.toContain("memory_save: Saved");

    // The Inbox lists it waiting for you, and nothing reached the project: Quill finds nothing.
    const waiting = await eventually("the share in the Inbox", async () =>
      (await api<{ shares: ReadonlyArray<MemoryShare> }>("GET", "/memory/shares")).shares.find(
        (share) => share.state === "waiting",
      ),
    );
    const before = await exchange(
      await newThread(quill),
      "How do we deploy?",
      hubCall("memory_search", { query: "canary" }),
    );
    expect(before.content).not.toContain("release:canary` before every deploy");
    expect(before.content).toContain('memory_search: Memory holds nothing that matches "canary".');

    // Share it, as the Inbox's Share it does: the page is in the project, written as Pip.
    await api("POST", `/memory/shares/${waiting.id}/share`, {});
    const shared = await eventually("the shared page", async () => {
      const hits = await api<ReadonlyArray<MemoryHit>>("GET", `/memory/search?${new URLSearchParams({ q: "canary" })}`);
      return hits.find((hit) => hit.scope._tag === "Project" && hit.path === deploy.path);
    });
    const page = await readPage(memoryScopeKey(shared.scope), deploy.path);
    expect(page?.page.author).toMatchObject({ _tag: "Hob", agentId: pip.id });

    // Quill's next thread is briefed from it and finds it.
    const after = await exchange(
      await newThread(quill),
      "How do we deploy?",
      hubCall("memory_search", { query: "canary" }),
    );
    expect(after.content).toMatch(/### Project [^\n]+\n\n#### Deploy/);
    expect(after.content).toContain("Deploy (howtos/deploy.md, in the project");
  });

  // covers ADR 028 (When memory is down, Capture and summaries)
  it("[TC-GEN-388] stopping ai-memory mid-chat loses nothing: the hob keeps working, and every capture and save arrives once it is back", async () => {
    const { project, dataDir } = prepare();
    const engine = engineCopy();
    hub = await start(dataDir, engine);
    await engineRunning();
    await setUp([project]);
    const pip = await summon("Pip", 9645);
    const thread = await newThread(pip);
    await exchange(thread, "Before the outage we spoke of apricots.");

    // Mid-reply, ai-memory stops, and its binary is gone, so it stays stopped until the hub starts again.
    const long = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");
    await api("POST", `/threads/${thread.id}/messages`, { content: `While memory stops, blueberries. ${long}` });
    await eventually("the reply to stream", async () =>
      (await messages(thread)).at(-1)?.status === "streaming" ? true : undefined,
    );
    renameSync(join(engine, "ai-memory"), join(engine, "ai-memory.away"));
    const pids = enginePids(engine);
    expect(pids).toHaveLength(1);
    for (const pid of pids) process.kill(pid, "SIGKILL");
    await eventually("memory to be off", async () => ((await engineHealth())?.state === "off" ? true : undefined));

    // The hob keeps working: the reply ends, a save is kept, and a new thread is told memory is down.
    const streamed = await eventually("the reply to end", async () => {
      const last = (await messages(thread)).at(-1);
      return last?.role === "assistant" && last.status === "complete" ? last : undefined;
    });
    expect(streamed.content).toContain("blueberries");
    const kept = await exchange(
      thread,
      "During the outage, cherries.",
      hubCall("memory_save", { key: "fruit", scope: "mine", path: "notes/fruit.md", markdown: "# Fruit\n\nCherries." }),
    );
    expect(kept.content).toContain("Hobbots kept notes/fruit.md and saves it when memory is back.");
    const told = await exchange(await newThread(pip), "Anything to recall?");
    expect(told.content).toContain("Memory is unavailable right now, so nothing from it is included.");

    // The hub starts again with the engine back: the kept save arrives, and so does all of the chat.
    await hub.stop();
    renameSync(join(engine, "ai-memory.away"), join(engine, "ai-memory"));
    hub = await start(dataDir, engine);
    await engineRunning();
    const fruit = await eventually("the kept save", () => readPage(ownScope(pip), "notes/fruit.md"));
    expect(fruit.page.markdown).toContain("Cherries.");
    expect(fruit.history).toHaveLength(1);
    // Archiving the thread ends its session, and memory writes one page of it from every turn.
    await api("POST", `/threads/${thread.id}/archive`);
    const session = await eventually("the thread's session page", async () => {
      const page = (await pagesOf(ownScope(pip))).find((each) => each.path.startsWith("sessions/"));
      return page === undefined ? undefined : readPage(ownScope(pip), page.path);
    });
    for (const word of ["apricots", "blueberries", "cherries"]) expect(session?.page.markdown).toContain(word);
    expect((await pagesOf(ownScope(pip))).filter((each) => each.path.startsWith("sessions/"))).toHaveLength(1);
  });

  // covers ADR 028 (Backups), OP-003, OP-004
  it("[TC-OP-107] an export holds memory, and a restored backup keeps it: the page, its history and the next thread's brief, with new keys", async () => {
    const { project, dataDir } = prepare();
    const backups = join(root, "backups");
    mkdirSync(backups);
    hub = await start(dataDir);
    await engineRunning();
    await setUp([project]);
    const pip = await summon("Pip", 9646);
    await exchange(await newThread(pip), "Remember how the tests run", hubCall("memory_save", LESSON));
    // Your edit, a second version by you.
    const saved = await eventually("the lesson", () => readPage(ownScope(pip), LESSON.path));
    const edited = `${LESSON.markdown}\n\nRun them twice on CI.`;
    await api("POST", "/memory/page", {
      scope: ownScope(pip),
      path: LESSON.path,
      markdown: edited,
      tags: [],
      pinned: false,
      forgetOn: null,
      expected: saved.page.version,
    });

    // An export holds the page as you left it.
    const exported = await api<{ folder: string }>("POST", "/exports", {
      scope: { _tag: "Everything" },
      destination: backups,
    });
    expect(readFileSync(join(exported.folder, "memory", "hobs", "Pip", LESSON.path), "utf8")).toBe(edited);
    expect(JSON.parse(readFileSync(join(exported.folder, "export.json"), "utf8")).memory.state).toBe("included");

    await api("POST", "/backup", { destination: backups });
    const done = await eventually("the backup", async () => {
      const { state } = await api<{ state: { _tag: string; path?: string } }>("GET", "/backup");
      if (state._tag === "Failed") throw new Error(JSON.stringify(state));
      return state._tag === "Done" ? (state.path as string) : undefined;
    });
    // After the backup the page is deleted: the restore brings it back.
    const current = await readPage(ownScope(pip), LESSON.path);
    await api("POST", "/memory/page/delete", {
      scope: ownScope(pip),
      path: LESSON.path,
      version: current?.page.version,
    });
    expect(await readPage(ownScope(pip), LESSON.path)).toBeUndefined();
    const keys = readFileSync(join(dataDir, "memory-keys"), "utf8");

    // The hub stops, restores and starts again in the same process, on the same port.
    await api("POST", "/restore", { path: done });
    await eventually("the restored hub", async () =>
      (await api<{ latest: unknown }>("GET", "/restore")).latest === null ? undefined : true,
    );
    await api("POST", "/restore/resume");
    await engineRunning();
    expect(readFileSync(join(dataDir, "memory-keys"), "utf8")).not.toBe(keys);
    const restored = await eventually("the restored page", () => readPage(ownScope(pip), LESSON.path));
    expect(restored.page.markdown).toBe(edited);
    expect(restored.history).toHaveLength(2);
    const briefed = await exchange(await newThread(pip), "Run the tests.");
    expect(briefed.content).toContain("Run them twice on CI.");
  });
});
