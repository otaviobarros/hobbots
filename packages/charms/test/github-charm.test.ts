import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NodeServices } from "@effect/platform-node";
import { CharmTools, makeRedactor, type ToolAccess } from "@hobbots/agents";
import { AgentId, EMPTY_HOB_POLICY, type GitHubRepository, type PolicyDecision } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GITHUB_UNASKABLE,
  GitHubApi,
  GitHubApiLive,
  GitHubCharmTools,
  GitHubCredential,
  GitHubError,
  GitRemotes,
} from "../src/index.ts";

let root = "";
let project = "";
let other = "";

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hobbots-charms-")));
  project = path.join(root, "project");
  other = path.join(root, "other");
  await fs.mkdir(project);
  await fs.mkdir(other);
});
afterAll(() => fs.rm(root, { recursive: true, force: true }));

const HOBBOTS: GitHubRepository = { owner: "otaviobarros", name: "hobbots" };

/** Records what the Charm asked GitHub, and answers as GitHub would. */
const fakeApi = (asked: Array<string>, failWith?: GitHubError) =>
  Layer.succeed(
    GitHubApi,
    GitHubApi.of({
      repository: (_agentId, repository) => {
        asked.push(`repository ${repository.owner}/${repository.name}`);
        return failWith
          ? Effect.fail(failWith)
          : Effect.succeed({
              fullName: "otaviobarros/hobbots",
              description: "Hobs that work beside you.",
              defaultBranch: "main",
              visibility: "public",
              url: "https://github.com/otaviobarros/hobbots",
              openIssuesAndPullRequests: 42,
            });
      },
      search: (_agentId, query, limit) => {
        asked.push(`search ${query} (${limit})`);
        return Effect.succeed({
          query,
          total: 37,
          items: [
            { number: 317, title: "Read GitHub", state: "open", author: "otaviobarros", updatedAt: "2026-11-01" },
          ],
        });
      },
      item: (_agentId, repository, number, comments) => {
        asked.push(`item ${repository.owner}/${repository.name}#${number} (${comments})`);
        return Effect.succeed({
          number,
          title: "Read GitHub",
          state: "open",
          author: "otaviobarros",
          updatedAt: "2026-11-01",
          pullRequest: false,
          url: `https://github.com/otaviobarros/hobbots/issues/${number}`,
          body: "The token is ghp_abcdefghijklmnopqrstuvwxyz0123456789 here.",
          labels: [],
          commentCount: 0,
          comments: [],
        });
      },
    }),
  );

const fakeRemotes = (repositories: Record<string, GitHubRepository>) =>
  Layer.succeed(GitRemotes, GitRemotes.of({ repositoryOf: (folder) => Effect.succeed(repositories[folder] ?? null) }));

const access = (folders: ReadonlyArray<string>, readGitHub?: PolicyDecision, githubCharm = true): ToolAccess => ({
  policy: {
    preset: "balanced",
    sharedFolders: [project],
    hob: {
      ...EMPTY_HOB_POLICY,
      overrides: readGitHub === undefined ? {} : { "read-github": readGitHub },
      ...(githubCharm ? {} : { githubCharm: false }),
    },
    dataFolder: path.join(root, "data"),
    restrictions: [],
  },
  folders,
  runtimeFolder: path.join(root, "runtimes", "hob"),
});

/** GitHub connected on the hub, or not; the Charm never reads the token itself. */
const fakeCredential = (connected: boolean) =>
  Layer.succeed(
    GitHubCredential,
    GitHubCredential.of({
      connected: Effect.succeed(connected),
      tokenFor: () => Effect.succeed(Redacted.make("token")),
      refused: () => Effect.succeed(Redacted.make("token")),
      revoked: () => Effect.void,
      reaches: (_agentId, repository) =>
        repository.owner === "otaviobarros"
          ? Effect.void
          : Effect.fail(new GitHubError({ reason: "not-found", message: "The Hobbots app is not installed there." })),
    }),
  );

const charmLayer = (layers: {
  readonly remote?: GitHubRepository;
  readonly asked: Array<string>;
  readonly failWith?: GitHubError;
  readonly connected?: boolean;
}) =>
  GitHubCharmTools.pipe(
    Layer.provide(
      Layer.mergeAll(
        fakeApi(layers.asked, layers.failWith),
        fakeRemotes({ [project]: layers.remote ?? HOBBOTS, [other]: { owner: "someone", name: "secret" } }),
        PolicyEngine.node,
        fakeCredential(layers.connected ?? true),
      ),
    ),
  );

/** The tools a turn starts with when the hob's access is `atStart`, or null when it is offered none. */
const offered = (layers: { readonly asked: Array<string>; readonly connected?: boolean }, atStart: ToolAccess | null) =>
  Effect.gen(function* () {
    return yield* (yield* CharmTools).forTurn({
      agentId: AgentId.make("hob"),
      currentAccess: Effect.succeed(atStart),
      redactor: makeRedactor(),
    });
  }).pipe(Effect.provide(charmLayer(layers)), Effect.runPromise);

/** A call on a turn that started with the Charm, made with the hob's access as it is by then. */
const callWith = (
  layers: { readonly asked: Array<string>; readonly failWith?: GitHubError; readonly remote?: GitHubRepository },
  current: ToolAccess | null,
  name: string,
  input: unknown,
) =>
  Effect.gen(function* () {
    const charms = yield* CharmTools;
    let now: ToolAccess | null = access([project]);
    const tools = yield* charms.forTurn({
      agentId: AgentId.make("hob"),
      currentAccess: Effect.sync(() => now),
      redactor: makeRedactor(),
    });
    if (tools === null) throw new Error("The turn was offered no GitHub tools");
    now = current;
    return { names: tools.tools.map((tool) => tool.name), answer: yield* tools.call(name, input) };
  }).pipe(Effect.provide(charmLayer(layers)), Effect.runPromise);

describe("GitHub Charm", () => {
  it("[TC-PE-131] reads the repository of the hob's own folder, on the hub", async () => {
    const asked: Array<string> = [];
    const { names, answer } = await callWith({ asked }, access([project]), "github_search", { kind: "issue" });
    expect(names).toEqual(["github_repository", "github_search", "github_item"]);
    expect(answer.refused).toBe(false);
    expect(answer.text).toContain("37 matches for `repo:otaviobarros/hobbots is:issue is:open`.");
    expect(asked).toEqual(["search repo:otaviobarros/hobbots is:issue is:open (10)"]);

    const repo = await callWith({ asked }, access([project]), "github_repository", {});
    expect(repo.answer).toMatchObject({ refused: false });
    expect(repo.answer.text).toContain("otaviobarros/hobbots (public), default branch main");

    // What GitHub returns is redacted before the hob reads it.
    const item = await callWith({ asked }, access([project]), "github_item", { number: 317 });
    expect(item.answer.text).toContain("Issue #317 [open] Read GitHub");
    expect(item.answer.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("[TC-PE-132] never reads a repository outside the hob's folders, or under Ask or Never", async () => {
    const asked: Array<string> = [];
    // A folder the hob was not given, though the hub could read its repository.
    const outside = await callWith({ asked }, access([project]), "github_repository", { folder: other });
    expect(outside.answer).toEqual({
      refused: true,
      text: `${other} is not one of your folders. Your folders: ${project}.`,
    });
    // No folder of the hob's has a repository on GitHub.
    const none = await callWith({ asked }, access([path.join(root, "runtimes")]), "github_repository", {});
    expect(none.answer.refused).toBe(true);
    expect(none.answer.text).toContain("None of your folders");
    // Folders the engine refuses, such as one the policy no longer holds, are not read either.
    const notShared = await callWith({ asked }, access([other]), "github_repository", {});
    expect(notShared.answer).toMatchObject({ refused: true, text: `${other} is outside this hob's folders.` });
    const chatOnly = await callWith({ asked }, null, "github_repository", {});
    expect(chatOnly.answer.refused).toBe(true);

    const never = await callWith({ asked }, access([project], "deny"), "github_repository", {});
    expect(never.answer).toEqual({ refused: true, text: "This hob's own permissions never allows reading GitHub." });
    const ask = await callWith({ asked }, access([project], "ask"), "github_repository", {});
    expect(ask.answer).toEqual({
      refused: true,
      text: `This hob's own permissions asks before reading GitHub. ${GITHUB_UNASKABLE}`,
    });
    // Input that could widen the search is refused before anything is read.
    const injected = await callWith({ asked }, access([project]), "github_search", {
      kind: "issue",
      label: 'x" repo:someone/secret',
    });
    expect(injected.answer.refused).toBe(true);
    const merged = await callWith({ asked }, access([project]), "github_search", { kind: "issue", state: "merged" });
    expect(merged.answer.refused).toBe(true);
    const unknown = await callWith({ asked }, access([project]), "github_delete", {});
    expect(unknown.answer).toEqual({ refused: true, text: "Hobbots has no github_delete tool." });
    expect(asked).toEqual([]);
  });

  it("[TC-PE-140] offers its actions only to a hob with the Charm while GitHub is connected", async () => {
    const asked: Array<string> = [];
    const on = await offered({ asked }, access([project]));
    expect(on?.tools.map((tool) => tool.name)).toEqual(["github_repository", "github_search", "github_item"]);
    expect(await offered({ asked }, access([project], undefined, false))).toBeNull();
    expect(await offered({ asked, connected: false }, access([project]))).toBeNull();
    expect(await offered({ asked }, null)).toBeNull();
    // Taken away during the turn, the Charm refuses the next call.
    const off = await callWith({ asked }, access([project], undefined, false), "github_repository", {});
    expect(off.answer).toEqual({
      refused: true,
      text: "The GitHub Charm is off for you now, so GitHub cannot be read.",
    });
    expect(asked).toEqual([]);
  });

  it("[TC-GEN-034] asks the credential whether it reaches the repository before reading it", async () => {
    const asked: Array<string> = [];
    const elsewhere = await callWith(
      { asked, remote: { owner: "someone", name: "public" } },
      access([project]),
      "github_repository",
      {},
    );
    expect(elsewhere.answer).toEqual({ refused: true, text: "The Hobbots app is not installed there." });
    expect(asked).toEqual([]);
  });

  it("says why GitHub could not be read", async () => {
    const failWith = new GitHubError({ reason: "signed-out", message: "The hub is not signed in to GitHub." });
    const { answer } = await callWith({ asked: [], failWith }, access([project]), "github_repository", {});
    expect(answer).toEqual({ refused: true, text: "The hub is not signed in to GitHub." });
  });
});

describe("GitHub API", () => {
  const token = "gho_0123456789abcdefghijklmnopqrstuvwxyz";
  const respond = (
    status: number,
    body: unknown,
    seen: Array<{ url: string; auth: string | undefined }>,
    headers: Record<string, string> = {},
  ) =>
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request, url) => {
        seen.push({ url: url.toString(), auth: request.headers.authorization });
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status, headers })),
        );
      }),
    );
  const hob = AgentId.make("hob");
  const run = <A>(
    status: number,
    body: unknown,
    use: (api: GitHubApi["Service"]) => Effect.Effect<A, GitHubError>,
    headers: Record<string, string> = {},
  ) => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const credential: Array<string> = [];
    return Effect.gen(function* () {
      return yield* use(yield* GitHubApi);
    }).pipe(
      Effect.provide(
        GitHubApiLive.pipe(
          Layer.provide(respond(status, body, seen, headers)),
          Layer.provide(
            Layer.succeed(
              GitHubCredential,
              GitHubCredential.of({
                connected: Effect.succeed(true),
                tokenFor: (agentId) =>
                  Effect.sync(() => credential.push(`token for ${agentId}`)).pipe(Effect.as(Redacted.make(token))),
                refused: () =>
                  Effect.sync(() => credential.push("refused")).pipe(Effect.as(Redacted.make(`${token}2`))),
                revoked: () => Effect.sync(() => void credential.push("revoked")),
                reaches: () => Effect.void,
              }),
            ),
          ),
        ),
      ),
      Effect.result,
      Effect.runPromise,
      (result) => result.then((r) => ({ result: r, seen, credential })),
    );
  };

  it("signs in with the hob's credential and counts by GitHub's search", async () => {
    const { result, seen } = await run(
      200,
      {
        total_count: 2,
        items: [
          { number: 1, title: "A", state: "closed", user: null, updated_at: "t", pull_request: { merged_at: "m" } },
          { number: 2, title: "B", state: "open", user: { login: "o" }, updated_at: "t" },
        ],
      },
      (api) => api.search(hob, "repo:o/r is:pr", 0),
    );
    expect(result).toMatchObject({ _tag: "Success", success: { total: 2, items: [] } });
    expect(seen[0]?.auth).toBe(`Bearer ${token}`);
    expect(seen[0]?.url).toBe(
      "https://api.github.com/search/issues?q=repo%3Ao%2Fr+is%3Apr&sort=updated&order=desc&per_page=1",
    );
    const listed = await run(
      200,
      {
        total_count: 1,
        items: [
          { number: 1, title: "A", state: "closed", user: null, updated_at: "t", pull_request: { merged_at: "m" } },
        ],
      },
      (api) => api.search(hob, "q", 5),
    );
    expect(listed.result).toMatchObject({ success: { items: [{ number: 1, state: "merged", author: null }] } });
  });

  it("names each failure without the token", async () => {
    for (const [status, reason, headers] of [
      [401, "signed-out", {}],
      [404, "not-found", {}],
      // A 403 is a rate limit only when GitHub says so, as it does once the limit is used up.
      [403, "rate-limited", { "x-ratelimit-remaining": "0" }],
      [403, "rate-limited", { "retry-after": "60" }],
      [429, "rate-limited", {}],
      [403, "not-found", {}],
      [422, "not-found", {}],
      [500, "failed", {}],
    ] as const) {
      const { result } = await run(
        status,
        { message: "nope" },
        (api) => api.repository(hob, { owner: "o", name: "r" }),
        headers,
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: { reason } });
      expect(JSON.stringify(result)).not.toContain(token);
    }
    const { result } = await run(200, { unexpected: true }, (api) => api.repository(hob, { owner: "o", name: "r" }));
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "failed" } });
  });

  it("[TC-PE-141] tries a refused token once more after a refresh, then disconnects", async () => {
    const { result, seen, credential } = await run(401, { message: "Bad credentials" }, (api) =>
      api.repository(hob, { owner: "o", name: "r" }),
    );
    expect(credential).toEqual(["token for hob", "refused", "revoked"]);
    expect(seen.map((request) => request.auth)).toEqual([`Bearer ${token}`, `Bearer ${token}2`]);
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "signed-out" } });
    expect(JSON.stringify(result)).toContain("GitHub is disconnected");
  });
});

describe("Git remotes", () => {
  const repositoryOf = (folder: string) =>
    Effect.gen(function* () {
      return yield* (yield* GitRemotes).repositoryOf(folder);
    }).pipe(Effect.provide(GitRemotes.layer.pipe(Layer.provide(NodeServices.layer))), Effect.runPromise);
  const git = (cwd: string, ...args: Array<string>) => execFileSync("git", args, { cwd, stdio: "ignore" });

  it("[TC-PE-133] finds the repository from the folder's own origin remote, and nothing else", async () => {
    const repo = path.join(root, "repo");
    await fs.mkdir(repo);
    expect(await repositoryOf(repo)).toBeNull();
    git(repo, "init", "-q");
    expect(await repositoryOf(repo)).toBeNull();
    git(repo, "remote", "add", "origin", "git@github.com:otaviobarros/hobbots.git");
    expect(await repositoryOf(repo)).toEqual(HOBBOTS);
    // A subfolder of a repository is not its top.
    await fs.mkdir(path.join(repo, "sub"));
    expect(await repositoryOf(path.join(repo, "sub"))).toBeNull();
    // A `.git` file pointing at another repository's folder is not followed.
    const linked = path.join(root, "linked");
    await fs.mkdir(linked);
    await fs.writeFile(path.join(linked, ".git"), `gitdir: ${path.join(repo, ".git")}\n`);
    expect(await repositoryOf(linked)).toBeNull();
    // Another host names no repository.
    git(repo, "remote", "set-url", "origin", "https://gitlab.com/otaviobarros/hobbots.git");
    expect(await repositoryOf(repo)).toBeNull();
  });
});
