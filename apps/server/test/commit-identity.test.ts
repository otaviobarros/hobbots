import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import {
  ApprovalService,
  ChatService,
  CommitIdentityQuestions,
  ConnectedGitHubUser,
  GrantService,
  HobAdmission,
  HobbotsRepository,
  HobGitHubApps,
  HobLifecycle,
  HobService,
  HobTools,
  HubQuestions,
  PermissionSummary,
  UserGitIdentity,
} from "@hobbots/agents";
import { HubQuestionsRead } from "@hobbots/api";
import {
  Agent,
  AgentId,
  type GitHubUser,
  type GitIdentity,
  type HobGitHubApp,
  type HubQuestion,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  CodingSetupDismissalRepository,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  HubCommitIdentityRepository,
  HubQuestionRepositoryLive,
  SearchIndex,
  SetupRepository,
  TaskRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer, turnCommits } from "@hobbots/runtimes";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { HobToolsLive } from "../src/tools.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

// Issue #741: on a computer whose Git config sets no name and email, a hob on the user's account
// could not commit, could not set an identity, and kept asking the user who to commit as, though
// nothing could act on the answer. Now the hub asks the user itself, once, with their GitHub
// account recommended, keeps the answer, and the hob's next turn commits under it. The hub's own
// composition runs on SQLite or PostgreSQL (TestDatabase); the fake runtime runs no command, so the
// commit runs here with the environment the Claude Code adapter gives a turn's commands.

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-commit-identity-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const dataDir = join(temp, "hub", "data");
const project = join(temp, "tide-table");
const home = join(temp, "home");
for (const folder of [dataDir, project, home]) mkdirSync(folder, { recursive: true });

const NOW = "2026-11-06T02:00:00.000Z";
const nettle = new Agent({
  id: AgentId.make("nettle"),
  name: "Nettle",
  roleTitle: "Builder",
  runtime: "claude-code",
  model: null,
  effort: null,
  instructions: "",
  lookSeed: 1,
  lookColor: "moss",
  configVersion: 1,
  createdAt: NOW,
});
const fern = new Agent({ ...nettle, id: AgentId.make("fern"), name: "Fern", lookSeed: 2 });
/** The Quest's chat, where the work was asked for. */
const QUEST_CHAT = { agentId: nettle.id, threadId: ThreadId.make("tide-table") };
const ME: GitHubUser = { login: "otaviobarros", id: 35647586, name: null };
const NOREPLY = "35647586+otaviobarros@users.noreply.github.com";

/** The user's Git identity as the hub reads it now: none until a test sets one. */
let gitConfig: GitIdentity = { name: null, email: null };
/** How many times the hub read the user's GitHub account. */
let githubReads = 0;
/** What a read of the GitHub account waits on before it answers: nothing until a test holds it. */
let githubAnswers: Promise<void> = Promise.resolve();
/** Whether the hub's GitHub account is connected now. */
let signedIn = true;
/** Each hob's own GitHub app, once a test gives it one. */
const hobApps = new Map<string, HobGitHubApp>();
const NETTLE_APP: HobGitHubApp = {
  appId: 1,
  clientId: "Iv1.nettle",
  slug: "nettle-hobbots",
  owner: "otaviobarros",
  origin: "made",
  botUserId: 7,
  htmlUrl: "https://github.com/apps/nettle-hobbots",
  connectedAt: NOW,
};
const FakeHobApps = Layer.succeed(
  HobGitHubApps,
  HobGitHubApps.of({
    get: (agentId) => Effect.sync(() => hobApps.get(agentId) ?? null),
    leftOver: () => Effect.succeed(null),
    save: (agentId, app) => Effect.sync(() => void hobApps.set(agentId, app)),
    leave: () => Effect.void,
    holder: () => Effect.succeed(null),
    remove: (agentId) => Effect.sync(() => void hobApps.delete(agentId)),
  }),
);

const FakeGitHub = () =>
  Layer.succeed(
    ConnectedGitHubUser,
    ConnectedGitHubUser.of({
      get: () =>
        Effect.promise(async () => {
          githubReads++;
          await githubAnswers;
          return signedIn ? ME : null;
        }),
    }),
  );

type Hub = Awaited<ReturnType<typeof startHub>>;
let hub: Hub | undefined;
afterEach(async () => {
  await hub?.dispose();
  hub = undefined;
  gitConfig = { name: null, email: null };
  githubReads = 0;
  githubAnswers = Promise.resolve();
  signedIn = true;
  hobApps.clear();
});

const startHub = async (connected = true) => {
  signedIn = connected;
  const Tools = HobToolsLive.pipe(
    Layer.provideMerge(CommitIdentityQuestions.layer),
    Layer.provideMerge(HubQuestions.layer),
    Layer.provide(FakeGitHub()),
    Layer.provideMerge(FakeHobApps),
    Layer.provide(Layer.succeed(UserGitIdentity, UserGitIdentity.of({ read: Effect.sync(() => gitConfig) }))),
  );
  const App = HobLifecycle.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ChatService.layer.pipe(Layer.provide(HobTools.chatOnly)),
        ApprovalService.layer,
        GrantService.layer,
        HobService.layer,
        PermissionSummary.layer,
      ),
    ),
    Layer.provideMerge(Tools),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mergeAll(
          HobbotsRepositoryLive,
          ApprovalRepositoryLive,
          GrantRepositoryLive,
          TaskRepositoryLive,
          HubQuestionRepositoryLive,
          HubCommitIdentityRepository,
          CodingSetupDismissalRepository,
          EventJournal.layer,
          BackpackLive,
          SetupRepository.layer,
          SearchIndex.layer,
        ).pipe(Layer.provideMerge(TestDatabase)),
        EventBus.layer,
        HobAdmission.layer,
        NodeFolderChecks,
        FakeRuntimeLayer({ availability: "signedOut" }),
        Layer.succeed(Installation, { app: "hobbots", installationId: "commit-identity", version: "0.0.0", dataDir }),
      ),
    ),
  );
  const runtime = ManagedRuntime.make(App);
  const web = HttpRouter.toWebHandler(
    ApiRoutes.pipe(
      Layer.provide(TestDevices),
      Layer.provide(Layer.succeedContext(await runtime.context())),
      Layer.provide(NodeHttpServer.layerHttpServices),
    ),
    { disableLogger: true },
  );
  const request = async (method: "GET" | "POST" | "DELETE", path: string, body?: unknown) => {
    const response = await web.handler(
      new Request(`http://localhost:4390${path}`, {
        method,
        headers: { ...AS_WINDOW, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    return { status: response.status, body: (text === "" ? null : JSON.parse(text)) as unknown };
  };
  await runtime.runPromise(
    Effect.gen(function* () {
      yield* SetupRepository.use((setup) => setup.update({ approvedFolders: [project] }));
      const repo = yield* HobbotsRepository;
      yield* repo.insertAgent(nettle);
      yield* repo.insertAgent(fern);
      yield* repo.upsertThread(
        new Thread({
          id: QUEST_CHAT.threadId,
          agentId: nettle.id,
          title: "Tide table",
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
    }),
  );
  return {
    request,
    /** What the hob's turn in the Quest's chat is given to work with, as the hub works it out when it starts. */
    access: (hob: Agent = nettle) =>
      runtime.runPromise(HobTools.use((tools) => tools.access(hob, { chat: QUEST_CHAT }))),
    /** What the hob may do now, read when no turn starts, as when its authority is checked. */
    accessNow: () => runtime.runPromise(HobTools.use((tools) => tools.access(nettle))),
    open: async (): Promise<ReadonlyArray<HubQuestion>> => {
      const { status, body } = await request("GET", "/api/hub-questions");
      expect(status).toBe(200);
      return Schema.decodeUnknownSync(HubQuestionsRead)(body).questions;
    },
    answer: (question: HubQuestion, answer: string) =>
      request("POST", `/api/hub-questions/${question.id}/answer`, { answer, via: "inbox" }),
    pick: (question: HubQuestion, picked: string) =>
      request("POST", `/api/hub-questions/${question.id}/answer`, { picked, via: "inbox" }),
    /** The hob got its own GitHub app, as the hub's page for GitHub's redirect saves it and says so. */
    connectApp: (hob: Agent) =>
      runtime.runPromise(
        Effect.gen(function* () {
          hobApps.set(hob.id, NETTLE_APP);
          yield* CommitIdentityQuestions.use((setup) => setup.settled(hob.id));
        }),
      ),
    dispose: async () => {
      await web.dispose();
      await runtime.dispose();
    },
  };
};

/** Waits, up to ten seconds, for `check` to hold on the hub's state. */
const until = (check: () => Promise<boolean>) => expect.poll(check, { timeout: 10_000 }).toBe(true);

/** Commits in a fresh repository as the hob's command would, and returns the author and committer or Git's error. */
const commitAs = (access: Parameters<typeof turnCommits>[0]) => {
  const repo = mkdtempSync(join(temp, "repo-"));
  const env = {
    ...turnCommits(access).env({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1" }),
  };
  execFileSync("git", ["init", "-q"], { cwd: repo, env });
  writeFileSync(join(repo, "tide.md"), "High tide at 06:12\n");
  try {
    execFileSync("git", ["add", "tide.md"], { cwd: repo, env });
    execFileSync("git", ["commit", "-q", "-m", "docs: add the tide table"], { cwd: repo, env, stdio: "pipe" });
    return execFileSync("git", ["log", "-1", "--format=%an <%ae>|%cn <%ce>"], { cwd: repo, env }).toString().trim();
  } catch (error) {
    return `failed: ${String((error as { stderr?: Buffer }).stderr ?? error)}`;
  }
};

/** The coding setup cards open now. */
const cards = async (current: Hub) => (await current.open()).filter((question) => question.ask.kind === "coding-setup");
const keys = async (current: Hub) => (await cards(current)).map((question) => question.key);
const choices = async (current: Hub) => (await current.request("GET", "/api/charms/github/coding-setup")).body;

describe("who a hob on your account commits as when your Git config sets no one", () => {
  // covers OR-004, IN-004
  it("[TC-OR-1241-01] with your GitHub account connected, a hob commits as it and nothing is asked", async () => {
    hub = await startHub();
    const current = hub;

    // Reading what the hob may do, with no turn starting, asks nothing and reads no GitHub.
    expect((await current.accessNow())?.commitsAs._tag).toBe("Missing");
    expect(githubReads).toBe(0);

    // The first turn that may commit takes your account, keeps it, and commits as it.
    const first = await current.access();
    expect(first?.commitsAs).toMatchObject({ _tag: "UserGiven", identity: { name: "otaviobarros", email: NOREPLY } });
    expect(commitAs(first)).toBe(`otaviobarros <${NOREPLY}>|otaviobarros <${NOREPLY}>`);
    expect(turnCommits(first).note).toContain(`made as otaviobarros <${NOREPLY}>`);
    expect(await current.open()).toEqual([]);

    // It is kept: later turns read GitHub no more.
    await current.access(fern);
    expect(githubReads).toBe(1);
  }, 30_000);

  // covers OR-004, IN-004, UX-001
  it("[TC-OR-1241-02] without one, each hob gets one coding setup card with two choices and no typed answer", async () => {
    hub = await startHub(false);
    const current = hub;

    // The turn starts with no identity: the hob gets none, is told how to point you to GitHub, and the hub asks once.
    const before = await current.access();
    expect(before?.commitsAs._tag).toBe("Missing");
    expect(commitAs(before)).toMatch(/^failed: .*no email was given/s);
    expect(turnCommits(before).note).toContain("set up GitHub in its GitHub section");
    await current.access();
    const [card, ...others] = await cards(current);
    expect(others).toEqual([]);
    // It names the hob in data and its choices by key; the client words it (#1045).
    expect(card).toMatchObject({
      key: "nettle",
      ask: { kind: "coding-setup", hob: "Nettle" },
      chat: QUEST_CHAT,
      options: ["not-this-hob", "no-hob"],
      recommended: null,
    });
    // Anything typed is not a choice: it says not to ask for no hob, and the next turn asks again.
    expect((await current.answer(card as HubQuestion, "Otavio <otavio@example.com>")).status).toBe(200);
    await until(async () => (await cards(current)).length === 0);
    expect(await choices(current)).toEqual({ allHobs: false, hobs: [] });
    await current.access();
    expect(await keys(current)).toEqual(["nettle"]);

    // Another hob gets a card of its own.
    await current.access(fern);
    expect(await keys(current)).toEqual(["nettle", "fern"]);

    // Once your Git config sets an identity, no hob is asked again.
    gitConfig = { name: "Ada Lovelace", email: "ada@example.com" };
    expect((await current.access())?.commitsAs._tag).toBe("UserConfig");
  }, 30_000);

  // covers OR-004, IN-004
  it("[TC-OR-1241-03] not for this hob stops its card only, not for any hob stops every card, and Settings clears both", async () => {
    hub = await startHub(false);
    const current = hub;
    await current.access();
    await current.access(fern);
    const [nettleCard, fernCard] = await cards(current);

    // Not for Nettle: Nettle is never asked again, Fern's card stays.
    expect((await current.pick(nettleCard as HubQuestion, "not-this-hob")).status).toBe(200);
    await until(
      async () => JSON.stringify(await choices(current)) === JSON.stringify({ allHobs: false, hobs: ["nettle"] }),
    );
    await current.access();
    expect(await keys(current)).toEqual(["fern"]);

    // Don't ask for any hob: Fern's card leaves too, and no hob is asked.
    expect((await current.pick(fernCard as HubQuestion, "no-hob")).status).toBe(200);
    await until(async () => (await cards(current)).length === 0);
    await current.access(fern);
    await current.access();
    expect(await cards(current)).toEqual([]);
    expect(await choices(current)).toEqual({ allHobs: true, hobs: ["nettle"] });

    // Settings clears both: the next turn of each hob asks again.
    expect((await current.request("DELETE", "/api/charms/github/coding-setup")).body).toEqual({
      allHobs: false,
      hobs: [],
    });
    await current.access();
    await current.access(fern);
    expect(await keys(current)).toEqual(["nettle", "fern"]);
  }, 30_000);

  // covers OR-004
  it("[TC-OR-1241-04] two turns that start at once ask once, and a hob's own GitHub app withdraws its card", async () => {
    hub = await startHub(false);
    const current = hub;
    await Promise.all([current.access(), current.access()]);
    expect(await cards(current)).toHaveLength(1);

    // The hob commits as its own app now: its card is no longer needed.
    await current.connectApp(nettle);
    expect(await cards(current)).toEqual([]);
  }, 30_000);

  // covers OR-004
  it("[TC-OR-1241-07] a GitHub account connected after a card was raised is used by the very next turn", async () => {
    hub = await startHub(false);
    const current = hub;
    await current.access();
    expect(await keys(current)).toEqual(["nettle"]);

    // You connect the hub's GitHub account: the next turn commits as it at once, and the card leaves.
    signedIn = true;
    const next = await current.access();
    expect(next?.commitsAs).toMatchObject({ _tag: "UserGiven", identity: { name: "otaviobarros", email: NOREPLY } });
    expect(await cards(current)).toEqual([]);
  }, 30_000);

  // covers OR-004
  it("[TC-OR-1241-08] a turn still reading GitHub when the hob gets its own app raises no card", async () => {
    hub = await startHub(false);
    const current = hub;
    // The turn waits on GitHub, which finds no account.
    let answerGitHub: () => void = () => {};
    githubAnswers = new Promise((resolve) => {
      answerGitHub = () => resolve();
    });
    const slow = current.access();
    await until(async () => githubReads === 1);

    // Meanwhile the hob gets its own GitHub app.
    await current.connectApp(nettle);

    // GitHub answers the turn now: it finds the hob's app and raises no card.
    answerGitHub();
    await slow;
    expect(await cards(current)).toEqual([]);
  }, 30_000);
});
