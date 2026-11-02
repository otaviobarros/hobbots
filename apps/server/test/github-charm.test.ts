import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatService, HobAdmission, HobbotsRepository, HobTools } from "@hobbots/agents";
import {
  GitHubAccountLive,
  GitHubApi,
  GitHubCharmTools,
  GitHubConnection,
  GitHubSignInFake,
  GitRemotes,
  KeychainMemory,
  LocalGitHubSignInsNone,
} from "@hobbots/charms";
import { Agent, AgentId, EMPTY_HOB_POLICY, isInProgress } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { GitHubAccountRepository, HobbotsRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Layer, Schedule } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";

const HOB_ID = AgentId.make("aldric");
const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-github-charm-")));
const folder = join(root, "project");
mkdirSync(folder);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const summonHob = Effect.flatMap(HobbotsRepository, (repo) =>
  repo.insertAgent(
    new Agent({
      id: HOB_ID,
      name: "Aldric",
      roleTitle: "Guide",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "You are Aldric.",
      lookSeed: 4821,
      lookColor: "violet",
      configVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  ),
);

/** GitHub as the Charm reads it: one repository, whose details are always the same. */
const FakeGitHub = Layer.succeed(
  GitHubApi,
  GitHubApi.of({
    repository: () =>
      Effect.succeed({
        fullName: "octohob/workshop",
        description: null,
        defaultBranch: "main",
        visibility: "private",
        url: "https://github.com/octohob/workshop",
        openIssuesAndPullRequests: 3,
      }),
    search: (_agentId, query) => Effect.succeed({ query, total: 0, items: [] }),
    item: () => Effect.die("not read in these tests"),
  }),
);

describe("The GitHub Charm on a hub", () => {
  // covers PE-002, PE-008
  it("[TC-PE-144] is offered to a hob with the Charm once GitHub is connected, and from the next turn after it disconnects", async () => {
    // The hob's own switch, as saved right now.
    let githubCharm = true;
    const tools = Layer.succeed(
      HobTools,
      HobTools.of({
        access: () =>
          Effect.sync(() => ({
            policy: {
              preset: "balanced" as const,
              sharedFolders: [folder],
              hob: { ...EMPTY_HOB_POLICY, ...(githubCharm ? {} : { githubCharm: false }) },
              dataFolder: join(root, "data"),
              restrictions: [],
            },
            folders: [folder],
            runtimeFolder: join(root, "runtimes", HOB_ID),
          })),
      }),
    );
    const Account = GitHubAccountLive({ clientId: "Iv23liHobbots", slug: "hobbots", environmentToken: null }).pipe(
      Layer.provide(Layer.mergeAll(KeychainMemory, GitHubSignInFake, LocalGitHubSignInsNone, GitHubAccountRepository)),
    );
    const Charms = GitHubCharmTools.pipe(
      Layer.provide(
        Layer.mergeAll(
          FakeGitHub,
          Layer.succeed(
            GitRemotes,
            GitRemotes.of({ repositoryOf: () => Effect.succeed({ owner: "octohob", name: "workshop" }) }),
          ),
          PolicyEngine.node,
        ),
      ),
      Layer.provideMerge(Account),
    );
    const layer = ChatService.layer.pipe(
      Layer.provide(tools),
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.effectDiscard(summonHob),
          EventBus.layer,
          HobAdmission.layer,
          FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node)),
          Charms,
        ),
      ),
      Layer.provideMerge(HobbotsRepositoryLive.pipe(Layer.provideMerge(TestDatabase))),
    );

    const replies = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const repo = yield* HobbotsRepository;
      const connection = yield* GitHubConnection;
      const thread = yield* chat.createThread(HOB_ID);
      /** One turn that tries the Charm, and what the hob read. */
      const turn = Effect.gen(function* () {
        yield* chat.sendPrompt(thread.id, "Which repository is this?\nfake:hub github_repository {}");
        const reply = yield* repo.listMessages(thread.id).pipe(
          Effect.flatMap((messages) => {
            const last = messages.at(-1);
            return last?.role === "assistant" && !isInProgress(last.status)
              ? Effect.succeed(last)
              : Effect.fail("busy");
          }),
          Effect.retry(Schedule.spaced("5 millis")),
        );
        return reply.content.includes("octohob/workshop (private), default branch main") ? "read" : "not offered";
      });
      const before = yield* turn;
      yield* connection.connect;
      // The stand-in grants the code at its second poll, a second apart.
      yield* connection.state.pipe(
        Effect.flatMap((state) => (state._tag === "Connected" ? Effect.void : Effect.fail("waiting"))),
        Effect.retry(Schedule.spaced("50 millis")),
      );
      const connected = yield* turn;
      githubCharm = false;
      const switchedOff = yield* turn;
      githubCharm = true;
      const switchedOn = yield* turn;
      yield* connection.disconnect;
      const disconnected = yield* turn;
      return { before, connected, switchedOff, switchedOn, disconnected };
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

    expect(replies).toEqual({
      before: "not offered",
      connected: "read",
      switchedOff: "not offered",
      switchedOn: "read",
      disconnected: "not offered",
    });
  }, 20_000);
});
