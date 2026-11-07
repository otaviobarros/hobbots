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
  HobLifecycle,
  HobService,
  HobTools,
  HubQuestions,
  OWN_GIT_LABEL,
  PermissionSummary,
  UserGitIdentity,
} from "@hobbots/agents";
import { HubQuestionsRead } from "@hobbots/api";
import { Agent, AgentId, type GitHubUser, type GitIdentity, type HubQuestion, Thread, ThreadId } from "@hobbots/domain";
import {
  ApprovalRepositoryLive,
  BackpackLive,
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

const FakeGitHub = (signedIn: boolean) =>
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
});

const startHub = async (signedIn = true) => {
  const Tools = HobToolsLive.pipe(
    Layer.provideMerge(CommitIdentityQuestions.layer),
    Layer.provideMerge(HubQuestions.layer),
    Layer.provide(FakeGitHub(signedIn)),
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
  const request = async (method: "GET" | "POST", path: string, body?: unknown) => {
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
    access: () => runtime.runPromise(HobTools.use((tools) => tools.access(nettle, { chat: QUEST_CHAT }))),
    /** What the hob may do now, read when no turn starts, as when its authority is checked. */
    accessNow: () => runtime.runPromise(HobTools.use((tools) => tools.access(nettle))),
    open: async (): Promise<ReadonlyArray<HubQuestion>> => {
      const { status, body } = await request("GET", "/api/hub-questions");
      expect(status).toBe(200);
      return Schema.decodeUnknownSync(HubQuestionsRead)(body).questions;
    },
    answer: (question: HubQuestion, answer: string) =>
      request("POST", `/api/hub-questions/${question.id}/answer`, { answer, via: "inbox" }),
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

describe("who a hob on your account commits as when your Git config sets no one", () => {
  // covers OR-004, IN-004
  it("[TC-OR-632] the hub asks you once with your GitHub account recommended, and the hob's next turn commits as it", async () => {
    hub = await startHub();
    const current = hub;

    // Reading what the hob may do, with no turn starting, asks nothing.
    expect((await current.accessNow())?.commitsAs._tag).toBe("Missing");
    expect(await current.open()).toEqual([]);

    // The turn starts with no identity: the hob gets none, and the hub asks you, once, in the Quest's chat.
    const before = await current.access();
    expect(before?.commitsAs._tag).toBe("Missing");
    expect(commitAs(before)).toMatch(/^failed: .*no email was given/s);
    expect(turnCommits(before).note).toContain("Do not ask the user or another hob who to commit as");
    await current.access();
    const [question, ...others] = await current.open();
    expect(others).toEqual([]);
    expect(question).toMatchObject({
      subject: { kind: "commit-identity", key: "user", title: "Who hobs commit as" },
      chat: QUEST_CHAT,
      options: [
        {
          label: "My GitHub account, @otaviobarros",
          consequence: `Commits are made as otaviobarros <${NOREPLY}>, which GitHub links to your account.`,
        },
        { label: OWN_GIT_LABEL },
      ],
      recommended: 0,
    });
    expect(githubReads).toBe(1);

    // You pick your GitHub account in the Inbox; the hub keeps it.
    const answered = await current.answer(question as HubQuestion, "My GitHub account, @otaviobarros");
    expect(answered).toMatchObject({ status: 200, body: { picked: 0 } });
    await until(async () => (await current.access())?.commitsAs._tag === "UserGiven");

    // The hob's next turn commits under it, and asks nothing more.
    const after = await current.access();
    expect(after?.commitsAs).toMatchObject({ _tag: "UserGiven", identity: { name: "otaviobarros", email: NOREPLY } });
    expect(commitAs(after)).toBe(`otaviobarros <${NOREPLY}>|otaviobarros <${NOREPLY}>`);
    expect(turnCommits(after).note).toContain(`made as otaviobarros <${NOREPLY}>`);
    expect(await current.open()).toEqual([]);
  }, 30_000);

  // covers OR-004
  it("[TC-OR-633] takes a typed name and email, asks again when it finds none, and asks nothing when Git sets one", async () => {
    hub = await startHub(false);
    const current = hub;
    await current.access();
    // No GitHub account is connected: the question asks you to type one, with no choices.
    const [first] = await current.open();
    expect(first?.options).toEqual([]);
    expect(first?.text).toContain("Ada Lovelace <ada@example.com>");

    // Words with no name and email in them are asked about again, saying so.
    await current.answer(first as HubQuestion, "whatever you think");
    await until(async () => (await current.open()).some((question) => question.id !== first?.id));
    const [second] = await current.open();
    expect(second?.text).toContain(`couldn't find a name and email in "whatever you think"`);
    expect(second?.chat).toEqual(QUEST_CHAT);

    await current.answer(second as HubQuestion, "Otavio Barros <otavio@example.com>");
    await until(async () => (await current.access())?.commitsAs._tag === "UserGiven");
    expect(commitAs(await current.access())).toBe(
      "Otavio Barros <otavio@example.com>|Otavio Barros <otavio@example.com>",
    );
  }, 30_000);

  // covers OR-004
  it("[TC-OR-634] asks nothing while your Git config sets an identity, and leaves it to Git when you say you'll set it there", async () => {
    gitConfig = { name: "Ada Lovelace", email: "ada@example.com" };
    hub = await startHub();
    const current = hub;
    expect((await current.access())?.commitsAs._tag).toBe("UserConfig");
    expect(await current.open()).toEqual([]);
    expect(githubReads).toBe(0);

    // Without one, you say you'll set it in Git yourself: the hub keeps no identity of its own.
    gitConfig = { name: null, email: null };
    await current.access();
    const [question] = await current.open();
    await current.answer(question as HubQuestion, OWN_GIT_LABEL);
    await until(async () => (await current.open()).length === 0);
    gitConfig = { name: "Otavio Barros", email: "otavio@example.com" };
    expect((await current.access())?.commitsAs._tag).toBe("UserConfig");
    expect(await current.open()).toEqual([]);
  }, 30_000);

  // covers OR-004
  it("[TC-OR-635] two turns that start at once ask you once", async () => {
    hub = await startHub();
    const current = hub;
    // Both turns read GitHub at once, and GitHub answers only once both have passed the first check.
    let answerGitHub: () => void = () => {};
    githubAnswers = new Promise((resolve) => {
      answerGitHub = () => resolve();
    });
    const both = Promise.all([current.access(), current.access()]);
    await until(async () => githubReads === 2);
    answerGitHub();
    await both;
    const [question, ...others] = await current.open();
    expect(others).toEqual([]);

    await current.answer(question as HubQuestion, "Otavio Barros <otavio@example.com>");
    await until(async () => (await current.accessNow())?.commitsAs._tag === "UserGiven");
  }, 30_000);

  // covers OR-004
  it("[TC-OR-636] a turn still reading GitHub when another turn's question is answered asks nothing more", async () => {
    hub = await startHub();
    const current = hub;
    // The first turn finds nothing asked yet, and waits on GitHub.
    let answerGitHub: () => void = () => {};
    githubAnswers = new Promise((resolve) => {
      answerGitHub = () => resolve();
    });
    const slow = current.access();
    await until(async () => githubReads === 1);
    // Meanwhile another turn asks, GitHub answering it at once, and you answer.
    githubAnswers = Promise.resolve();
    await current.access();
    const [question] = await current.open();
    await current.answer(question as HubQuestion, "Otavio Barros <otavio@example.com>");
    await until(async () => (await current.accessNow())?.commitsAs._tag === "UserGiven");

    // GitHub answers the first turn now: it finds your answer and asks nothing.
    answerGitHub();
    await slow;
    expect(await current.open()).toEqual([]);
  }, 30_000);
});
