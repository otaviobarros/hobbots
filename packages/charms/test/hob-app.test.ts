import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import {
  DeviceRepository,
  HobbotsRepository,
  HobGitHubApps,
  makeRedactor,
  RetiredHobGitHubApp,
  SecretRedaction,
} from "@hobbots/agents";
import { Agent, AgentId, Device, DeviceId, type HobGitHubApp } from "@hobbots/domain";
import { Effect, Layer, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ACTION_PERMISSIONS,
  GitHubApi,
  GitHubApiLive,
  GitHubConnection,
  GitHubCredential,
  GitHubCredentialPerHob,
  HOB_APP_PERMISSIONS,
  HobAppKeys,
  HobAppKeysLive,
  HobAppKeysMemory,
  HobGitHubAppLive,
  HobGitHubAppService,
  hobAppName,
  KeychainError,
} from "../src/index.ts";
import { type FakeGitHub, startFakeGitHub } from "../src/testing.ts";

// A hob's own GitHub App (#223, ADR 022) against the fake GitHub of #325: the manifest, the state,
// the code exchange, the key in the keychain, the installations and removing it all again.
const temp = mkdtempSync(join(tmpdir(), "hobbots-hob-app-"));
const FRODO = AgentId.make("frodo");
const SAM = AgentId.make("sam");
const WINDOW = DeviceId.make("window");
const PHONE = DeviceId.make("phone");
const HUB = "http://127.0.0.1:4242";

let github: FakeGitHub;
beforeAll(async () => {
  github = await startFakeGitHub({ folder: join(temp, "github"), login: "otaviobarros" });
});
afterAll(async () => {
  await github.close();
  rmSync(temp, { recursive: true, force: true });
});
afterEach(() => {
  github.answer = null;
  github.installationTokenMs = 3_600_000;
});

const agent = (id: AgentId, name: string, status: "active" | "retired" = "active") =>
  new Agent({
    id,
    name,
    roleTitle: "Guide",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: "2026-11-02T00:00:00.000Z",
    status,
  });

const device = (id: DeviceId, revokedAt: string | null = null) =>
  new Device({
    id,
    name: id,
    kind: "window",
    platform: "macOS",
    tailscale: null,
    approvedAt: "2026-11-02T00:00:00.000Z",
    lastActiveAt: null,
    revokedAt,
  });

interface World {
  readonly hobs: Map<AgentId, Agent>;
  readonly devices: Map<DeviceId, Device>;
  readonly apps: Map<AgentId, HobGitHubApp>;
  /** What could not be removed from a hob's app, which is then left over. */
  readonly leftOver: Map<AgentId, string>;
  readonly redactor: ReturnType<typeof makeRedactor>;
}

const world = (): World => ({
  hobs: new Map([
    [FRODO, agent(FRODO, "Frodo")],
    [SAM, agent(SAM, "Sam")],
  ]),
  devices: new Map([
    [WINDOW, device(WINDOW)],
    [PHONE, device(PHONE)],
  ]),
  apps: new Map(),
  leftOver: new Map(),
  redactor: makeRedactor(),
});

/** The hobs' apps in memory, as the database keeps them. */
const appsOf = (w: World) =>
  Layer.succeed(
    HobGitHubApps,
    HobGitHubApps.of({
      get: (id) => Effect.sync(() => (w.leftOver.has(id) ? null : (w.apps.get(id) ?? null))),
      leftOver: (id) =>
        Effect.sync(() => {
          const app = w.apps.get(id);
          const problem = w.leftOver.get(id);
          return app === undefined || problem === undefined ? null : { app, problem };
        }),
      save: (id, app) =>
        Effect.sync(() => {
          w.apps.set(id, app);
          w.leftOver.delete(id);
        }),
      leave: (id, problem) => Effect.sync(() => void w.leftOver.set(id, problem)),
      remove: (id) =>
        Effect.sync(() => {
          w.apps.delete(id);
          w.leftOver.delete(id);
        }),
    }),
  );

const layer = (w: World, keys: Layer.Layer<HobAppKeys> = HobAppKeysMemory) =>
  HobGitHubAppLive(github.hosts).pipe(
    Layer.provideMerge(keys),
    Layer.provide([
      FetchHttpClient.layer,
      Layer.succeed(SecretRedaction, w.redactor),
      Layer.succeed(
        HobbotsRepository,
        // Only reading a hob is used here.
        {
          findAgent: (id: AgentId) => Effect.succeed(Option.fromNullishOr(w.hobs.get(id))),
        } as unknown as HobbotsRepository["Service"],
      ),
      Layer.succeed(DeviceRepository, {
        find: (id: DeviceId) => Effect.succeed(Option.fromNullishOr(w.devices.get(id))),
      } as unknown as DeviceRepository["Service"]),
      appsOf(w),
    ]),
  );

/** What the user's browser does: posts the hub's form to GitHub, which redirects back with a code. */
const createOnGitHub = (action: string, manifest: string) =>
  Effect.promise(async () => {
    const response = await fetch(action, {
      method: "POST",
      body: new URLSearchParams({ manifest }),
      redirect: "manual",
    });
    const back = new URL(response.headers.get("location") ?? "");
    return { back, code: back.searchParams.get("code") ?? "", state: back.searchParams.get("state") ?? "" };
  });

/** Starts the flow for a hob and follows it to GitHub's redirect back to the hub. */
const throughGitHub = (agentId: AgentId, deviceId: DeviceId = WINDOW) =>
  Effect.gen(function* () {
    const service = yield* HobGitHubAppService;
    const started = yield* service.start(agentId, deviceId, HUB);
    const state = new URL(started.url).searchParams.get("state") ?? "";
    const form = yield* service.form(state);
    if (Option.isNone(form)) return yield* Effect.die("no form for a fresh state");
    const back = yield* createOnGitHub(form.value.action, form.value.manifest);
    return { started, form: form.value, back: back.back, code: back.code, state };
  });

const run = <A, E>(w: World, effect: Effect.Effect<A, E, HobGitHubAppService | HobAppKeys | RetiredHobGitHubApp>) =>
  Effect.runPromise(Effect.provide(effect, layer(w)));

describe("A hob's own GitHub App", () => {
  // covers ADR 022
  it("[TC-GEN-051] is made from a manifest with the hob's name and the Charm's permissions, and keeps only its key", async () => {
    const w = world();
    const result = await run(
      w,
      Effect.gen(function* () {
        const service = yield* HobGitHubAppService;
        const before = yield* service.status(FRODO);
        const flow = yield* throughGitHub(FRODO);
        const made = yield* service.complete(flow.state, flow.code);
        const key = yield* (yield* HobAppKeys).read(FRODO);
        return { before, flow, made, key, after: yield* service.status(FRODO) };
      }),
    );
    expect(result.before).toEqual({ _tag: "None", cannotCreate: null });
    expect(result.flow.started.url).toMatch(
      /^http:\/\/127\.0\.0\.1:4242\/github\/hob-app\/new\?state=[A-Za-z0-9_-]{43}$/,
    );
    expect(result.flow.form.action).toBe(`${github.base}/settings/apps/new?state=${result.flow.state}`);
    expect(result.flow.back.origin + result.flow.back.pathname).toBe(`${HUB}/github/hob-app/callback`);
    const posted = github.apps[0];
    expect(posted?.manifest).toEqual({
      name: "frodo-hobbots",
      url: "https://hobbots.ai",
      description: expect.stringContaining("Frodo"),
      public: false,
      default_permissions: HOB_APP_PERMISSIONS,
      default_events: [],
      hook_attributes: { url: "https://hobbots.ai", active: false },
      redirect_url: `${HUB}/github/hob-app/callback`,
    });
    expect(result.made.app).toMatchObject({
      appId: posted?.id,
      clientId: posted?.clientId,
      slug: posted?.slug,
      owner: "otaviobarros",
      botUserId: posted?.botId,
      htmlUrl: "https://github.com/apps/frodo-hobbots",
    });
    expect(posted?.slug).toBe("frodo-hobbots");
    expect(result.made.installUrl).toBe(`${github.base}/apps/frodo-hobbots/installations/new`);
    expect(result.after).toMatchObject({ _tag: "Connected", bot: "frodo-hobbots[bot]" });
    // The key is in the keychain as GitHub gave it; nothing else of GitHub's secrets is kept.
    const pem = Option.map(result.key, Redacted.value);
    expect(Option.getOrNull(pem)).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);
    const kept = JSON.stringify([...w.apps.values()]);
    for (const secret of github.secrets()) expect(kept).not.toContain(secret);
    // The key is redacted by value from then on.
    expect(w.redactor.text(`key: ${Option.getOrThrow(pem)}`)).not.toContain("PRIVATE KEY-----\n");
  });

  // covers ADR 022
  it("[TC-PE-250] answers a state only once, for an hour, and only for the hob and device it was made for", async () => {
    const w = world();
    const outcome = await run(
      w,
      Effect.gen(function* () {
        const service = yield* HobGitHubAppService;
        const unknown = yield* Effect.flip(service.complete("not-a-state", "abc"));
        // Used once: the second redirect with the same state does nothing.
        const first = yield* throughGitHub(FRODO);
        yield* service.complete(first.state, first.code);
        const again = yield* Effect.flip(service.complete(first.state, first.code));
        const formAgain = yield* service.form(first.state);
        // A second start for a hob ends the first.
        const older = yield* throughGitHub(SAM);
        const newer = yield* service.start(SAM, WINDOW, HUB);
        const ended = yield* Effect.flip(service.complete(older.state, older.code));
        // Past the hour, the state is gone.
        yield* TestClock.adjust("61 minutes");
        const lapsed = yield* service.form(new URL(newer.url).searchParams.get("state") ?? "");
        return { unknown, again, formAgain, ended, lapsed };
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(outcome.unknown).toMatchObject({ reason: "unknown", deleteUrl: null });
    expect(outcome.again).toMatchObject({ reason: "unknown" });
    expect(Option.isNone(outcome.formAgain)).toBe(true);
    expect(outcome.ended).toMatchObject({ reason: "unknown" });
    expect(Option.isNone(outcome.lapsed)).toBe(true);
    expect(w.apps.has(SAM)).toBe(false);
  });

  // covers ADR 022
  it("[TC-PE-251] keeps no app for a removed device or a retired hob, and links to delete the one GitHub made", async () => {
    const w = world();
    const outcome = await run(
      w,
      Effect.gen(function* () {
        const service = yield* HobGitHubAppService;
        const fromPhone = yield* throughGitHub(FRODO, PHONE);
        w.devices.set(PHONE, device(PHONE, "2026-11-02T01:00:00.000Z"));
        const revoked = yield* Effect.flip(service.complete(fromPhone.state, fromPhone.code));
        const forSam = yield* throughGitHub(SAM);
        w.hobs.set(SAM, agent(SAM, "Sam", "retired"));
        const retired = yield* Effect.flip(service.complete(forSam.state, forSam.code));
        const startRetired = yield* Effect.flip(service.start(SAM, WINDOW, HUB));
        return { revoked, retired, startRetired, keys: yield* (yield* HobAppKeys).read(FRODO) };
      }),
    );
    expect(outcome.revoked).toMatchObject({
      reason: "failed",
      deleteUrl: expect.stringMatching(/\/settings\/apps\/frodo-hobbots-\d+\/advanced$/),
    });
    expect(outcome.retired).toMatchObject({ reason: "failed", deleteUrl: expect.stringContaining("sam-hobbots") });
    expect(outcome.startRetired).toMatchObject({ reason: "retired" });
    expect(Option.isNone(outcome.keys)).toBe(true);
    expect(w.apps.size).toBe(0);
  });

  // covers ADR 022
  it("[TC-PE-252] refuses to make an app without a keychain, and links to delete one whose key it could not keep", async () => {
    const w = world();
    const noKeychain = new KeychainError({ reason: "unavailable", message: "No keychain here." });
    const none = Layer.succeed(
      HobAppKeys,
      HobAppKeys.of({
        usable: Effect.succeed(false),
        read: () => Effect.fail(noKeychain),
        write: () => Effect.fail(noKeychain),
        remove: () => Effect.fail(noKeychain),
      }),
    );
    const refused = await Effect.runPromise(
      Effect.flip(Effect.flatMap(HobGitHubAppService, (service) => service.start(FRODO, WINDOW, HUB))).pipe(
        Effect.zip(Effect.flatMap(HobGitHubAppService, (service) => service.status(FRODO))),
        Effect.provide(layer(w, none)),
      ),
    );
    expect(refused[0]).toMatchObject({ reason: "no-keychain" });
    expect(refused[1]).toEqual({ _tag: "None", cannotCreate: "no-keychain" });

    // A keychain that is there but will not save: GitHub already made the app.
    const locked = Layer.succeed(
      HobAppKeys,
      HobAppKeys.of({
        usable: Effect.succeed(true),
        read: () => Effect.succeed(Option.none()),
        write: () => Effect.fail(new KeychainError({ reason: "failed", message: "The keychain is locked." })),
        remove: () => Effect.void,
      }),
    );
    const failed = await Effect.runPromise(
      Effect.gen(function* () {
        const flow = yield* throughGitHub(FRODO);
        return yield* Effect.flip((yield* HobGitHubAppService).complete(flow.state, flow.code));
      }).pipe(Effect.provide(layer(w, locked))),
    );
    expect(failed).toMatchObject({ reason: "failed", message: expect.stringContaining("The keychain is locked.") });
    expect(failed.deleteUrl).toMatch(/\/settings\/apps\/frodo-hobbots-?\w*\/advanced$/);
    expect(w.apps.size).toBe(0);
  });

  // covers ADR 022
  it("[TC-GEN-052] lists the app's installations, and disconnecting or retiring removes them, then the key", async () => {
    const w = world();
    const outcome = await run(
      w,
      Effect.gen(function* () {
        const service = yield* HobGitHubAppService;
        const keys = yield* HobAppKeys;
        const frodo = yield* throughGitHub(FRODO);
        const made = yield* service.complete(frodo.state, frodo.code);
        const none = yield* service.installations(FRODO);
        github.installApp(made.app.slug, "selected");
        github.installApp(made.app.slug, "all");
        const listed = yield* service.installations(FRODO);
        const disconnected = yield* service.disconnect(FRODO);
        const app = github.apps.find((each) => each.slug === made.app.slug);

        const sam = yield* throughGitHub(SAM);
        const samApp = yield* service.complete(sam.state, sam.code);
        github.installApp(samApp.app.slug);
        yield* (yield* RetiredHobGitHubApp).remove(SAM);
        const samLeft = github.apps.find((each) => each.slug === samApp.app.slug)?.installations.length;
        return {
          slug: made.app.slug,
          none,
          listed,
          disconnected,
          left: app?.installations.length,
          samLeft,
          frodoKey: yield* keys.read(FRODO),
          samKey: yield* keys.read(SAM),
          status: yield* service.status(FRODO),
        };
      }),
    );
    expect(outcome.none).toEqual([]);
    expect(outcome.listed).toEqual([
      expect.objectContaining({ account: "otaviobarros", repositorySelection: "selected", suspended: false }),
      expect.objectContaining({ account: "otaviobarros", repositorySelection: "all" }),
    ]);
    expect(outcome.disconnected).toEqual({
      deleteUrl: `${github.base}/settings/apps/${outcome.slug}/advanced`,
      problem: null,
    });
    expect(outcome.left).toBe(0);
    expect(outcome.samLeft).toBe(0);
    expect(Option.isNone(outcome.frodoKey)).toBe(true);
    expect(Option.isNone(outcome.samKey)).toBe(true);
    expect(outcome.status).toEqual({ _tag: "None", cannotCreate: null });
    // Every request the app made carried a JWT GitHub took; none carried the key.
    const appRequests = github.requests.filter((request) => request.path.startsWith("/app/"));
    expect(appRequests.length).toBeGreaterThan(0);
    for (const request of github.requests) expect(request.body).not.toContain("PRIVATE KEY");
  });

  // covers ADR 022
  it("[TC-PE-253] shows what it could not remove when GitHub refuses the key, and still deletes the key", async () => {
    const w = world();
    const outcome = await run(
      w,
      Effect.gen(function* () {
        const service = yield* HobGitHubAppService;
        const flow = yield* throughGitHub(FRODO);
        const made = yield* service.complete(flow.state, flow.code);
        const app = github.apps.find((each) => each.slug === made.app.slug);
        if (app !== undefined) app.keyLive = false;
        const listing = yield* Effect.flip(service.installations(FRODO));
        const disconnected = yield* service.disconnect(FRODO);
        const key = yield* (yield* HobAppKeys).read(FRODO);
        // The problem stays shown, and no new app is made over it, until the user dismisses it.
        const leftOver = yield* service.status(FRODO);
        const restart = yield* Effect.flip(service.start(FRODO, WINDOW, HUB));
        const dismissed = yield* service.disconnect(FRODO);
        const after = yield* service.status(FRODO);
        // A flow already on its way back from GitHub when an app is left over, as when it was started
        // while an earlier one was being completed: it does not replace the left-over app, and links
        // to delete the one GitHub just made.
        const second = yield* throughGitHub(FRODO);
        w.apps.set(FRODO, made.app);
        w.leftOver.set(FRODO, "1 of the app's installations could not be removed.");
        const late = yield* Effect.flip(service.complete(second.state, second.code));
        const stillLeft = yield* service.status(FRODO);
        return { listing, disconnected, key, late, stillLeft, leftOver, restart, dismissed, after };
      }),
    );
    expect(outcome.listing).toMatchObject({ reason: "signed-out" });
    expect(outcome.disconnected.problem).toContain("Delete the app on GitHub");
    expect(outcome.disconnected.deleteUrl).toContain("/advanced");
    expect(Option.isNone(outcome.key)).toBe(true);
    expect(outcome.leftOver).toEqual({
      _tag: "LeftOver",
      app: expect.objectContaining({ slug: expect.stringMatching(/^frodo-hobbots/) }),
      problem: outcome.disconnected.problem,
      deleteUrl: outcome.disconnected.deleteUrl,
    });
    expect(outcome.late).toMatchObject({ reason: "failed", message: expect.stringContaining("not fully removed") });
    expect(outcome.late.deleteUrl).toMatch(/\/settings\/apps\/frodo-hobbots-\w+\/advanced$/);
    expect(outcome.restart).toMatchObject({ reason: "left-over" });
    expect(outcome.stillLeft).toMatchObject({ _tag: "LeftOver", problem: expect.any(String) });
    expect(outcome.dismissed).toEqual({ deleteUrl: outcome.disconnected.deleteUrl, problem: null });
    expect(outcome.after).toEqual({ _tag: "None", cannotCreate: null });
  });

  // covers ADR 022
  it("[TC-PE-256] keeps what retiring a hob could not remove from its app, even when retired again, with where to delete it", async () => {
    const w = world();
    const outcome = await run(
      w,
      Effect.gen(function* () {
        const service = yield* HobGitHubAppService;
        const flow = yield* throughGitHub(SAM);
        const made = yield* service.complete(flow.state, flow.code);
        github.installApp(made.app.slug);
        // GitHub refuses to remove the installation.
        github.answer = (request) =>
          request.method === "DELETE" && request.path.startsWith("/app/installations/")
            ? { status: 500, body: {} }
            : undefined;
        yield* (yield* RetiredHobGitHubApp).remove(SAM);
        github.answer = null;
        // Retiring again, as a repeated request would, leaves it shown.
        yield* (yield* RetiredHobGitHubApp).remove(SAM);
        return {
          slug: made.app.slug,
          left: github.apps.find((each) => each.slug === made.app.slug)?.installations.length,
          key: yield* (yield* HobAppKeys).read(SAM),
          status: yield* service.status(SAM),
        };
      }),
    );
    expect(outcome.left).toBe(1);
    expect(Option.isNone(outcome.key)).toBe(true);
    expect(outcome.status).toEqual({
      _tag: "LeftOver",
      app: expect.objectContaining({ slug: outcome.slug }),
      problem: "1 of the app's installations could not be removed. Delete the app on GitHub to close them.",
      deleteUrl: `${github.base}/settings/apps/${outcome.slug}/advanced`,
    });
  });

  // covers ADR 022
  it("[TC-PE-257] counts a platform without a keychain Hobbots can use as having none", async () => {
    const windows = HobAppKeysLive("win32", {}).pipe(Layer.provide(NodeServices.layer));
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const usable = yield* (yield* HobAppKeys).usable;
        // The hub then refuses to start, before GitHub makes an app whose key it could not keep.
        const refused = yield* Effect.flip((yield* HobGitHubAppService).start(FRODO, WINDOW, HUB));
        return { usable, refused };
      }).pipe(Effect.provide(layer(world(), windows))),
    );
    expect(outcome.usable).toBe(false);
    const refused = outcome.refused;
    expect(refused).toMatchObject({ reason: "no-keychain" });
  });
});

/** The user's account behind `GitHubCredential`, which a hob with its own app must never use. */
const userAccount = (calls: Array<string>) =>
  Layer.mergeAll(
    Layer.succeed(
      GitHubCredential,
      GitHubCredential.of({
        connected: Effect.succeed(true),
        bot: () => Effect.succeed(null),
        tokenFor: () => Effect.sync(() => void calls.push("tokenFor")).pipe(Effect.as(Redacted.make("user-token"))),
        refused: () => Effect.sync(() => void calls.push("refused")).pipe(Effect.as(Redacted.make("user-token"))),
        revoked: () => Effect.sync(() => void calls.push("revoked")),
        reaches: () => Effect.sync(() => void calls.push("reaches")),
        onRepository: (_agentId, _repository, use) =>
          Effect.andThen(
            Effect.sync(() => calls.push("onRepository")),
            use,
          ),
      }),
    ),
    Layer.succeed(GitHubConnection, {} as GitHubConnection["Service"]),
  );

/** The hob's app behind `GitHubCredential`, with GitHub's REST API over it, as the Charm sees them. */
const charmLayer = (w: World, calls: Array<string>) =>
  GitHubApiLive(github.hosts.api).pipe(
    Layer.provideMerge(GitHubCredentialPerHob),
    Layer.provide([userAccount(calls), appsOf(w)]),
    Layer.provideMerge(layer(w)),
    Layer.provide(FetchHttpClient.layer),
  );

type CharmServices = GitHubApi | GitHubCredential | HobGitHubAppService | HobAppKeys | RetiredHobGitHubApp;

const runCharm = <A, E>(w: World, calls: Array<string>, effect: Effect.Effect<A, E, CharmServices>) =>
  Effect.runPromise(Effect.provide(effect, charmLayer(w, calls)));

/** A repository of the user's for one test, with one issue. */
const repositoryFor = (name: string) => {
  github.createRepository({ owner: "otaviobarros", name });
  github.addItem(`otaviobarros/${name}`, { title: "Pick a name for the pony" });
  return { owner: "otaviobarros", name };
};

/** Gives the hob its own app, installed on `repositories`. */
const withApp = (agentId: AgentId, repositories: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const flow = yield* throughGitHub(agentId);
    const made = yield* (yield* HobGitHubAppService).complete(flow.state, flow.code);
    if (repositories.length > 0) github.installApp(made.app.slug, "selected", repositories);
    return made.app;
  });

/** The claims of the JWTs the app signed in with, from what reached GitHub since `from`. */
const jwtsSince = (from: number) =>
  github.requests.slice(from).flatMap((request) => {
    const parts = (request.authorization ?? "").replace(/^Bearer /, "").split(".");
    if (parts.length !== 3) return [];
    return [JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as { iat: number; exp: number }];
  });

const tokensSince = (from: number) => github.installationTokens.slice(from);

describe("A hob's own GitHub App's tokens", () => {
  // covers ADR 022
  it("[TC-GEN-059] acts as the hob's bot with a token for one repository and the action's permissions, never as you", async () => {
    const w = world();
    const calls: Array<string> = [];
    const repository = repositoryFor("pony-shed");
    repositoryFor("other-shed");
    const fromRequest = github.requests.length;
    const fromToken = github.installationTokens.length;
    const outcome = await runCharm(
      w,
      calls,
      Effect.gen(function* () {
        const app = yield* withApp(FRODO, ["otaviobarros/pony-shed", "otaviobarros/other-shed"]);
        const api = yield* GitHubApi;
        const credential = yield* GitHubCredential;
        const read = yield* credential.onRepository(FRODO, repository, api.repository(FRODO, repository));
        const comment = yield* credential.onRepository(FRODO, repository, api.comment(FRODO, repository, 1, "Pip."));
        const viewer = yield* api.viewer(FRODO);
        // The user's account still serves a hob without its own app.
        yield* credential.tokenFor(SAM, { repository, action: "read" });
        return { app, read, comment, viewer, connected: yield* credential.connected };
      }),
    );
    expect(outcome.read.fullName).toBe("otaviobarros/pony-shed");
    const bot = `${outcome.app.slug}[bot]`;
    expect(outcome.comment).toMatchObject({ _tag: "Done", value: { author: bot } });
    expect(outcome.viewer).toBe(bot);
    expect(github.items("otaviobarros/pony-shed")[0]?.comments[0]?.author).toBe(bot);
    // One token per action, each for the one repository and only the permissions that action needs.
    expect(tokensSince(fromToken).map((token) => [token.repositories, token.permissions])).toEqual([
      [["otaviobarros/pony-shed"], ACTION_PERMISSIONS.read],
      [["otaviobarros/pony-shed"], ACTION_PERMISSIONS.comment],
    ]);
    expect(ACTION_PERMISSIONS.comment).toEqual({ metadata: "read", issues: "write", pull_requests: "write" });
    // Every JWT lasted at most ten minutes, issued a minute back against clock drift.
    const jwts = jwtsSince(fromRequest);
    expect(jwts.length).toBeGreaterThan(0);
    for (const jwt of jwts) expect(jwt.exp - jwt.iat).toBeLessThanOrEqual(600);
    // Only Sam, who has no app, used the user's account.
    expect(calls).toEqual(["tokenFor"]);
    // Every token and JWT is redacted by value from then on.
    for (const token of tokensSince(fromToken)) expect(w.redactor.text(token.token)).not.toContain(token.token);
  });

  // covers ADR 022
  it("[TC-GEN-060] keeps a token until five minutes before it expires, then mints a new one, and mints one for two calls at once", async () => {
    const w = world();
    const repository = repositoryFor("pony-mill");
    const fromToken = github.installationTokens.length;
    const outcome = await runCharm(
      w,
      [],
      Effect.gen(function* () {
        yield* withApp(FRODO, ["otaviobarros/pony-mill"]);
        const credential = yield* GitHubCredential;
        const scope = { repository, action: "read" } as const;
        const [first, second] = yield* Effect.all(
          [credential.tokenFor(FRODO, scope), credential.tokenFor(FRODO, scope)],
          { concurrency: 2 },
        );
        const again = yield* credential.tokenFor(FRODO, scope);
        const minted = tokensSince(fromToken).length;
        // A token GitHub gives with five minutes and a moment left is replaced on its next use.
        github.installationTokenMs = 5 * 60_000 + 1_500;
        yield* credential.tokenFor(FRODO, { repository, action: "comment" });
        const short = yield* credential.tokenFor(FRODO, { repository, action: "comment" });
        yield* Effect.sleep("1600 millis");
        const replaced = yield* credential.tokenFor(FRODO, { repository, action: "comment" });
        return { first, second, again, minted, short, replaced };
      }),
    );
    expect(Redacted.value(outcome.first)).toBe(Redacted.value(outcome.second));
    expect(Redacted.value(outcome.again)).toBe(Redacted.value(outcome.first));
    expect(outcome.minted).toBe(1);
    expect(Redacted.value(outcome.replaced)).not.toBe(Redacted.value(outcome.short));
    expect(tokensSince(fromToken)).toHaveLength(4 - 1);
  });

  // covers ADR 022
  it("[TC-GEN-061] refuses a repository the hob's app is not installed on, with where to install it, and never asks for a token", async () => {
    const w = world();
    const calls: Array<string> = [];
    const repository = repositoryFor("pony-barn");
    const fromToken = github.installationTokens.length;
    const outcome = await runCharm(
      w,
      calls,
      Effect.gen(function* () {
        const app = yield* withApp(FRODO, []);
        const credential = yield* GitHubCredential;
        const api = yield* GitHubApi;
        const refused = yield* Effect.flip(
          credential.onRepository(FRODO, repository, api.comment(FRODO, repository, 1, "Pip.")),
        );
        return { app, refused, status: yield* (yield* HobGitHubAppService).status(FRODO) };
      }),
    );
    expect(outcome.refused).toMatchObject({ reason: "not-found" });
    expect(outcome.refused.message).toContain(`${outcome.app.slug}[bot] is not installed on otaviobarros/pony-barn`);
    expect(outcome.refused.message).toContain(`${github.base}/apps/${outcome.app.slug}/installations/new`);
    expect(tokensSince(fromToken)).toEqual([]);
    expect(github.items("otaviobarros/pony-barn")[0]?.comments).toEqual([]);
    // Not installed on one repository is no reconnect, and never a reason to act as you.
    expect(outcome.status).toMatchObject({ _tag: "Connected", needsReconnect: null });
    expect(calls).toEqual([]);
  });

  // covers ADR 022
  it("[TC-GEN-062] marks the hob's app as needing a new one when GitHub refuses its key, and sends nothing more until then", async () => {
    const w = world();
    const calls: Array<string> = [];
    const repository = repositoryFor("pony-forge");
    const outcome = await runCharm(
      w,
      calls,
      Effect.gen(function* () {
        const app = yield* withApp(FRODO, ["otaviobarros/pony-forge"]);
        const fake = github.apps.find((each) => each.slug === app.slug);
        if (fake === undefined) return yield* Effect.die("no app");
        fake.keyLive = false;
        const credential = yield* GitHubCredential;
        const api = yield* GitHubApi;
        const first = yield* api.comment(FRODO, repository, 1, "Pip.");
        const status = yield* (yield* HobGitHubAppService).status(FRODO);
        const asked = github.requests.length;
        const second = yield* Effect.flip(credential.tokenFor(FRODO, { repository, action: "read" }));
        const sentAfter = github.requests.length - asked;
        // The key works again, as after a clock problem: listing the installations clears the mark.
        fake.keyLive = true;
        yield* (yield* HobGitHubAppService).installations(FRODO);
        const cleared = yield* (yield* HobGitHubAppService).status(FRODO);
        const token = yield* credential.tokenFor(FRODO, { repository, action: "read" });
        return { app, first, status, second, sentAfter, cleared, token };
      }),
    );
    expect(outcome.first).toMatchObject({ _tag: "NotSent" });
    expect(outcome.first._tag === "NotSent" && outcome.first.message).toContain(
      `GitHub refused ${outcome.app.slug}[bot]'s key`,
    );
    expect(outcome.status).toMatchObject({ _tag: "Connected", needsReconnect: { reason: "key" } });
    expect(outcome.second.message).toContain("Give the hob a new app");
    expect(outcome.sentAfter).toBe(0);
    expect(outcome.cleared).toMatchObject({ _tag: "Connected", needsReconnect: null });
    expect(Redacted.value(outcome.token)).toMatch(/^ghs_/);
    expect(github.items("otaviobarros/pony-forge")[0]?.comments).toEqual([]);
    expect(calls).toEqual([]);
  });

  // covers ADR 022
  it("[TC-GEN-063] mints once more when GitHub refuses a token, and marks the app for reinstalling when it refuses again", async () => {
    const w = world();
    const calls: Array<string> = [];
    const repository = repositoryFor("pony-yard");
    const fromToken = github.installationTokens.length;
    const outcome = await runCharm(
      w,
      calls,
      Effect.gen(function* () {
        const app = yield* withApp(FRODO, ["otaviobarros/pony-yard"]);
        const api = yield* GitHubApi;
        const service = yield* HobGitHubAppService;
        // An expired token is refused once, and the call goes through with a new one.
        yield* api.repository(FRODO, repository);
        github.expireInstallationTokens();
        const renewed = yield* api.repository(FRODO, repository);
        const minted = tokensSince(fromToken).length;
        // GitHub refuses every token of the app's: the call is not sent, and the app needs reinstalling.
        github.answer = (request) =>
          request.authorization?.startsWith("Bearer ghs_")
            ? { status: 401, body: { message: "Bad credentials" } }
            : undefined;
        const refused = yield* api.comment(FRODO, repository, 1, "Pip.");
        const status = yield* service.status(FRODO);
        github.answer = null;
        // Reinstalled on GitHub, the Charms tab lists the installations again, which clears the mark.
        github.installApp(app.slug, "selected", ["otaviobarros/pony-yard"]);
        yield* service.installations(FRODO);
        return { renewed, minted, refused, status, cleared: yield* service.status(FRODO) };
      }),
    );
    expect(outcome.renewed.fullName).toBe("otaviobarros/pony-yard");
    expect(outcome.minted).toBe(2);
    expect(outcome.refused).toMatchObject({ _tag: "NotSent" });
    expect(outcome.refused._tag === "NotSent" && outcome.refused.message).toContain("Install it again at");
    expect(outcome.status).toMatchObject({ _tag: "Connected", needsReconnect: { reason: "installation" } });
    expect(outcome.cleared).toMatchObject({ _tag: "Connected", needsReconnect: null });
    expect(github.items("otaviobarros/pony-yard")[0]?.comments).toEqual([]);
    expect(calls).toEqual([]);
  });

  // covers ADR 022
  it("[TC-GEN-064] stops a call checked under the hob's app once the app is disconnected, and the hob acts as you after", async () => {
    const w = world();
    const calls: Array<string> = [];
    const repository = repositoryFor("pony-gate");
    const outcome = await runCharm(
      w,
      calls,
      Effect.gen(function* () {
        yield* withApp(FRODO, ["otaviobarros/pony-gate"]);
        const credential = yield* GitHubCredential;
        const stopped = yield* Effect.flip(
          credential.onRepository(
            FRODO,
            repository,
            Effect.gen(function* () {
              yield* (yield* HobGitHubAppService).disconnect(FRODO);
              return yield* credential.tokenFor(FRODO, { repository, action: "comment" });
            }),
          ),
        );
        const after = yield* credential.tokenFor(FRODO, { repository, action: "comment" });
        return { stopped, after, bot: yield* credential.bot(FRODO) };
      }),
    );
    expect(outcome.stopped.message).toContain("changed during this call");
    expect(Redacted.value(outcome.after)).toBe("user-token");
    expect(outcome.bot).toBeNull();
    expect(calls).toEqual(["tokenFor"]);
  });
});

describe("hobAppName", () => {
  it("names the app after the hob in GitHub's characters, within 34", () => {
    expect(hobAppName("Frodo")).toBe("frodo-hobbots");
    expect(hobAppName("Éowyn of Rohan!")).toBe("eowyn-of-rohan-hobbots");
    expect(hobAppName("A very long hob name that goes on and on")).toBe("a-very-long-hob-name-that-hobbots");
    expect(hobAppName("A very long hob name that goes on and on").length).toBeLessThanOrEqual(34);
    expect(hobAppName("🙂")).toBe("hob-hobbots");
  });
});
