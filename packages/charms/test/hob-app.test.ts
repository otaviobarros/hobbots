import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import {
  type ApprovalAction,
  type ApprovalOutcome,
  actionDigest,
  Charms,
  DeviceRepository,
  GrantService,
  HobbotsRepository,
  HobGitHubApps,
  hubCallStep,
  makeRedactor,
  RetiredHobGitHubApp,
  type RuntimeEvent,
  SecretRedaction,
  type ToolAccess,
  type TurnApprovals,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  ApprovalId,
  type CharmCall,
  Device,
  DeviceId,
  EMPTY_HOB_POLICY,
  type GitHubRepository,
  type HobGitHubApp,
  HobPolicy,
  hobAppBot,
  MessageId,
  type PolicyDecision,
  type SafetyPreset,
  ThreadId,
} from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GITHUB_CHARM } from "../src/github-operations.ts";
import {
  ACTION_PERMISSIONS,
  GitHubApi,
  GitHubApiLive,
  GitHubCharm,
  GitHubConnection,
  GitHubCredential,
  GitHubCredentialPerHob,
  GitPush,
  GitPushLive,
  GitRemotes,
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
import { charmToolsFor, directSandbox, memoryCharmCalls } from "./support.ts";

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
  // The user's account signs in with `user-token`, which the hob's app must never use.
  github = await startFakeGitHub({ folder: join(temp, "github"), login: "otaviobarros", tokens: ["user-token"] });
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
  /** Every change of GitHub identity that revoked a hob's GitHub grants, in order. */
  readonly revokedGitHub: Array<AgentId>;
  /** The Charm's call records, by hob and key. */
  readonly calls: Map<string, CharmCall>;
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
  revokedGitHub: [],
  calls: new Map(),
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

/** The hobs, of which only reading one is used here. */
const hobsOf = (w: World) =>
  Layer.succeed(HobbotsRepository, {
    findAgent: (id: AgentId) => Effect.succeed(Option.fromNullishOr(w.hobs.get(id))),
  } as unknown as HobbotsRepository["Service"]);

const layer = (w: World, keys: Layer.Layer<HobAppKeys> = HobAppKeysMemory) =>
  HobGitHubAppLive(github.hosts).pipe(
    Layer.provideMerge(keys),
    Layer.provide([
      FetchHttpClient.layer,
      Layer.succeed(SecretRedaction, w.redactor),
      hobsOf(w),
      Layer.succeed(DeviceRepository, {
        find: (id: DeviceId) => Effect.succeed(Option.fromNullishOr(w.devices.get(id))),
      } as unknown as DeviceRepository["Service"]),
      grantsOf(w),
      appsOf(w),
    ]),
  );

/** The hob's GitHub identity switches, each recorded with the grants it revoked. */
const grantsOf = (w: World) =>
  Layer.succeed(GrantService, {
    switchIdentity: <A, E, R>(_charm: unknown, id: AgentId, change: Effect.Effect<A, E, R>) =>
      Effect.sync(() => void w.revokedGitHub.push(id)).pipe(Effect.andThen(change)),
    identity: (_charm: unknown, id: AgentId) => Effect.sync(() => w.revokedGitHub.filter((each) => each === id).length),
    exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
  } as unknown as GrantService["Service"]);

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

  // covers ADR 022, #227
  it("[TC-GEN-084] names the repositories each installation reaches, with one metadata-only token an hour", async () => {
    const w = world();
    github.createRepository({ owner: "otaviobarros", name: "frodo-docs" });
    github.createRepository({ owner: "otaviobarros", name: "frodo-site" });
    const [docs, site] = ["otaviobarros/frodo-docs", "otaviobarros/frodo-site"];
    const outcome = await run(
      w,
      Effect.gen(function* () {
        const service = yield* HobGitHubAppService;
        const frodo = yield* throughGitHub(FRODO);
        const made = yield* service.complete(frodo.state, frodo.code);
        github.installApp(made.app.slug, "selected", [docs]);
        github.installApp(made.app.slug, "all");
        const first = yield* service.installations(FRODO);
        const again = yield* service.installations(FRODO);
        const minted = github.installationTokens.filter((token) => token.appId === made.app.appId);
        yield* service.disconnect(FRODO);
        return { first, again, minted };
      }),
    );
    const [selected, all] = outcome.first;
    expect(selected?.repositories).toEqual([docs]);
    expect(all?.repositories).toEqual(expect.arrayContaining([docs, site]));
    expect(outcome.again).toEqual(outcome.first);
    // One token for each installation, kept for the second read, reading names and nothing else.
    expect(outcome.minted).toHaveLength(2);
    for (const token of outcome.minted) expect(token.permissions).toEqual({ metadata: "read" });
  });

  // covers ADR 022, #227
  it("[TC-GEN-085] still removes every installation on disconnect when GitHub will not name their repositories", async () => {
    const w = world();
    const outcome = await run(
      w,
      Effect.gen(function* () {
        const service = yield* HobGitHubAppService;
        const frodo = yield* throughGitHub(FRODO);
        const made = yield* service.complete(frodo.state, frodo.code);
        github.installApp(made.app.slug, "selected");
        github.installApp(made.app.slug, "all");
        // Neither a token for the names nor the names themselves come back.
        github.answer = (request) =>
          (request.method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(request.path)) ||
          request.path === "/installation/repositories"
            ? { status: 500 }
            : undefined;
        const listing = yield* Effect.flip(service.installations(FRODO));
        const disconnected = yield* service.disconnect(FRODO);
        github.answer = null;
        return {
          listing,
          disconnected,
          left: github.apps.find((each) => each.slug === made.app.slug)?.installations.length,
          leftOver: w.leftOver.get(FRODO) ?? null,
        };
      }),
    );
    expect(outcome.listing.message).toContain("the names of the app's repositories");
    expect(outcome.disconnected.problem).toBeNull();
    expect(outcome.left).toBe(0);
    expect(outcome.leftOver).toBeNull();
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

  // covers #948
  it("[TC-OP-101] counts a key delete the keychain never answered as kept while the hob's app is recorded, until it is gone", async () => {
    const w = world();
    const stalled = { value: false };
    // The keychain tool times out, which the hub cannot tell from one that is not there.
    const keys = Layer.effect(
      HobAppKeys,
      Effect.map(HobAppKeys, (memory) =>
        HobAppKeys.of({
          ...memory,
          remove: (agentId) =>
            stalled.value
              ? Effect.fail(
                  new KeychainError({ reason: "unavailable", message: "The keychain did not answer in time." }),
                )
              : memory.remove(agentId),
        }),
      ),
    ).pipe(Layer.provide(HobAppKeysMemory));
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* HobGitHubAppService;
        const retired = yield* RetiredHobGitHubApp;
        const flow = yield* throughGitHub(FRODO);
        yield* service.complete(flow.state, flow.code);
        stalled.value = true;
        const first = yield* retired.erase(FRODO);
        // Asked again, the app is still recorded as left over, so the outcome is still unknown.
        const again = yield* retired.erase(FRODO);
        // Sam never had an app, so the hub stored no key of Sam's.
        const sam = yield* retired.erase(SAM);
        stalled.value = false;
        const answered = yield* retired.erase(FRODO);
        return { first, again, sam, answered, key: yield* (yield* HobAppKeys).read(FRODO) };
      }).pipe(Effect.provide(layer(w, keys))),
    );
    const unknown =
      "The hub could not tell whether the keychain deleted the app's key: The keychain did not answer in time.";
    expect(outcome.first).toBe(unknown);
    expect(outcome.again).toBe(unknown);
    expect(outcome.sam).toBeNull();
    expect(outcome.answered).toBeNull();
    expect(Option.isNone(outcome.key)).toBe(true);
  });

  // covers #948
  it("[TC-OP-106] keeps the hob's app as left over when a key write fails and the key may still be there", async () => {
    const w = world();
    const timedOut = new KeychainError({ reason: "unavailable", message: "The keychain did not answer in time." });
    const stalled = Layer.succeed(
      HobAppKeys,
      HobAppKeys.of({
        usable: Effect.succeed(true),
        read: () => Effect.succeed(Option.none()),
        write: () => Effect.fail(timedOut),
        remove: () => Effect.fail(timedOut),
      }),
    );
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const flow = yield* throughGitHub(FRODO);
        const failed = yield* Effect.flip((yield* HobGitHubAppService).complete(flow.state, flow.code));
        const status = yield* (yield* HobGitHubAppService).status(FRODO);
        const erased = yield* (yield* RetiredHobGitHubApp).erase(FRODO);
        return { failed, status, erased };
      }).pipe(Effect.provide(layer(w, stalled))),
    );
    expect(outcome.failed).toMatchObject({ reason: "failed" });
    expect(outcome.status).toMatchObject({ _tag: "LeftOver" });
    expect(outcome.erased).toBe(
      "The hub could not tell whether the keychain deleted the app's key: The keychain did not answer in time.",
    );
  });

  // covers ADR 022
  it("[TC-PE-257] counts a platform without a keychain Hobbots can use as having none", async () => {
    const windows = HobAppKeysLive("win32", {}, "0123456789abcdef").pipe(Layer.provide(NodeServices.layer));
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
        hobApp: () => Effect.succeed(null),
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
    Layer.provide([userAccount(calls), appsOf(w), grantsOf(w), hobsOf(w)]),
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
  it("[TC-GEN-155] marks the hob's app for reinstalling when it is uninstalled everywhere, and sends nothing more until then", async () => {
    const w = world();
    const calls: Array<string> = [];
    const repository = repositoryFor("pony-pen");
    const outcome = await runCharm(
      w,
      calls,
      Effect.gen(function* () {
        const app = yield* withApp(FRODO, ["otaviobarros/pony-pen"]);
        const credential = yield* GitHubCredential;
        const api = yield* GitHubApi;
        const service = yield* HobGitHubAppService;
        // The Charms tab showed it installed. Uninstalled before any call: GitHub finds no installation
        // for the repository, and lists none left anywhere.
        yield* service.installations(FRODO);
        github.uninstallApp(app.slug);
        const refused = yield* api.comment(FRODO, repository, 1, "Pip.");
        const status = yield* service.status(FRODO);
        const asked = github.requests.length;
        const second = yield* Effect.flip(credential.tokenFor(FRODO, { repository, action: "read" }));
        const sentAfter = github.requests.length - asked;
        // Reinstalled on GitHub, the Charms tab lists the installations again, which clears the mark.
        github.installApp(app.slug, "selected", ["otaviobarros/pony-pen"]);
        yield* service.installations(FRODO);
        const cleared = yield* service.status(FRODO);
        const token = yield* credential.tokenFor(FRODO, { repository, action: "read" });
        return { app, refused, status, second, sentAfter, cleared, token };
      }),
    );
    expect(outcome.refused).toMatchObject({ _tag: "NotSent" });
    expect(outcome.refused._tag === "NotSent" && outcome.refused.message).toContain(
      `${outcome.app.slug}[bot] is not installed on otaviobarros/pony-pen, nor anywhere else on GitHub`,
    );
    expect(outcome.status).toMatchObject({ _tag: "Connected", needsReconnect: { reason: "installation" } });
    expect(outcome.second.message).toContain(`${github.base}/apps/${outcome.app.slug}/installations/new`);
    expect(outcome.sentAfter).toBe(0);
    expect(outcome.cleared).toMatchObject({ _tag: "Connected", needsReconnect: null });
    expect(Redacted.value(outcome.token)).toMatch(/^ghs_/);
    expect(github.items("otaviobarros/pony-pen")[0]?.comments).toEqual([]);
    expect(calls).toEqual([]);
  });

  // covers ADR 022
  it("[TC-GEN-156] leaves the hob's app unmarked when one installation goes but another is left", async () => {
    const w = world();
    const calls: Array<string> = [];
    const loft = repositoryFor("pony-loft");
    const barn = repositoryFor("pony-barn");
    const outcome = await runCharm(
      w,
      calls,
      Effect.gen(function* () {
        const app = yield* withApp(FRODO, ["otaviobarros/pony-loft"]);
        github.installApp(app.slug, "selected", ["otaviobarros/pony-barn"]);
        const fake = github.apps.find((each) => each.slug === app.slug);
        if (fake === undefined) return yield* Effect.die("no app");
        const credential = yield* GitHubCredential;
        const api = yield* GitHubApi;
        // The hub knows the installation behind the loft, and has a token for it.
        yield* api.repository(FRODO, loft);
        const gone = fake.installations.findIndex((each) => each.repositories.includes("otaviobarros/pony-loft"));
        fake.installations.splice(gone, 1);
        github.expireInstallationTokens();
        const refused = yield* Effect.flip(api.repository(FRODO, loft));
        const status = yield* (yield* HobGitHubAppService).status(FRODO);
        const token = yield* credential.tokenFor(FRODO, { repository: barn, action: "read" });
        return { app, refused, status, token };
      }),
    );
    expect(outcome.refused.message).toContain(`${outcome.app.slug}[bot] is not installed on otaviobarros/pony-loft`);
    expect(outcome.refused.message).not.toContain("anywhere else");
    expect(outcome.status).toMatchObject({ _tag: "Connected", needsReconnect: null });
    expect(Redacted.value(outcome.token)).toMatch(/^ghs_/);
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
        const revokedOnConnect = [...w.revokedGitHub];
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
        return { revokedOnConnect, stopped, after, bot: yield* credential.hobApp(FRODO) };
      }),
    );
    // Grants approved under one GitHub identity never carry over to the other: both switches revoke them.
    expect(outcome.revokedOnConnect).toEqual([FRODO]);
    expect(w.revokedGitHub).toEqual([FRODO, FRODO]);
    expect(outcome.stopped.message).toContain("changed during this call");
    expect(Redacted.value(outcome.after)).toBe("user-token");
    expect(outcome.bot).toBeNull();
    expect(calls).toEqual(["tokenFor"]);
  });
  // covers ADR 022
  it("[TC-GEN-066] gives every call GitHub refused the same token at once one new token, minted once", async () => {
    const w = world();
    const repository = repositoryFor("pony-pen");
    const outcome = await runCharm(
      w,
      [],
      Effect.gen(function* () {
        yield* withApp(FRODO, ["otaviobarros/pony-pen"]);
        const credential = yield* GitHubCredential;
        const scope = { repository, action: "read" } as const;
        const stale = yield* credential.tokenFor(FRODO, scope);
        github.expireInstallationTokens();
        const fromToken = github.installationTokens.length;
        // Three calls holding the same token are refused at once; a fourth comes after the renewal.
        const renewed = yield* Effect.all(
          [credential.refused(FRODO, stale), credential.refused(FRODO, stale), credential.refused(FRODO, stale)],
          { concurrency: 3 },
        );
        const late = yield* credential.refused(FRODO, stale);
        return { stale, renewed, late, minted: tokensSince(fromToken).length };
      }),
    );
    const values = [...outcome.renewed, outcome.late].map(Redacted.value);
    expect(new Set(values).size).toBe(1);
    expect(values[0]).not.toBe(Redacted.value(outcome.stale));
    expect(outcome.minted).toBe(1);
  });
});

/** A folder of the user's with `main`, `feat/x` and `feat/y`, and its repository on the fake GitHub with one issue. */
const projectFor = (name: string) => {
  const folder = join(temp, "projects", name);
  mkdirSync(folder, { recursive: true });
  const git = (...args: Array<string>) => execFileSync("git", args, { cwd: folder, stdio: "pipe" });
  git("init", "--quiet", "--initial-branch=main");
  writeFileSync(join(folder, "README.md"), "Ponies\n");
  git("add", "README.md");
  git("-c", "user.name=Otavio", "-c", "user.email=o@example.com", "commit", "--quiet", "--no-gpg-sign", "-m", "Start");
  git("branch", "feat/x");
  git("branch", "feat/y");
  github.createRepository({ owner: "otaviobarros", name, from: folder });
  github.addItem(`otaviobarros/${name}`, { title: "Pick a name for the pony" });
  const repository: GitHubRepository = { owner: "otaviobarros", name };
  return { folder, repository, slug: `otaviobarros/${name}` };
};

const accessIn = (
  folder: string,
  preset: SafetyPreset,
  overrides: Record<string, PolicyDecision> = {},
): ToolAccess => ({
  policy: {
    preset,
    sharedFolders: [folder],
    // Charm overrides go apart from the built-in ones, as a stored policy reads.
    hob: Schema.decodeUnknownSync(HobPolicy)({ ...EMPTY_HOB_POLICY, overrides }),
    dataFolder: join(temp, "data"),
    restrictions: [],
    // The hub declares the GitHub Charm's operations, as the server does (ADR 031).
    charmOperations: GITHUB_CHARM.operations,
  },
  folders: [folder],
  runtimeFolder: join(temp, "runtimes", "frodo"),
  commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
});

/** The GitHub Charm's tools over the hob's app and GitHub's REST API, for hobs working in `folder`. */
const writesLayer = (w: World, calls: Array<string>, folder: string, repository: GitHubRepository) =>
  Charms.layer([GitHubCharm]).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          GitRemotes,
          GitRemotes.of({ repositoryOf: (f) => Effect.succeed(f === folder ? repository : null) }),
        ),
        PolicyEngine.node,
        memoryCharmCalls(w.calls),
        GitPushLive({ folder: join(temp, "charm", repository.name) }).pipe(
          Layer.provide(Layer.mergeAll(directSandbox, NodeServices.layer)),
        ),
      ),
    ),
    Layer.provideMerge(charmLayer(w, calls)),
  );

interface WriteTurn {
  readonly preset?: SafetyPreset;
  readonly overrides?: Record<string, PolicyDecision>;
  readonly answer?: "approve" | "deny";
  /** Runs while the card waits, before the user answers it. */
  readonly whileAsking?: Effect.Effect<void>;
}

/** One hob tool call in a turn of `agentId`'s, with the user answering its card as `turn` says; what was asked and reported. */
const callAs = (agentId: AgentId, w: World, folder: string, tool: string, input: object, turn: WriteTurn = {}) =>
  Effect.gen(function* () {
    const asked: Array<ApprovalAction> = [];
    const events: Array<RuntimeEvent> = [];
    const access = accessIn(folder, turn.preset ?? "balanced", turn.overrides);
    const tools = yield* charmToolsFor({
      agentId,
      threadId: ThreadId.make("t1"),
      messageId: MessageId.make("m1"),
      scope: () => "reply:m1",
      currentAccess: Effect.succeed(access),
      redactor: w.redactor,
      approvals: {
        request: (action) =>
          Effect.gen(function* () {
            asked.push(action);
            if (turn.whileAsking !== undefined) yield* turn.whileAsking;
            const digest = yield* actionDigest(action);
            return {
              approvalId: ApprovalId.make(`approval-${asked.length}`),
              decision: Effect.succeed(
                (turn.answer ?? "approve") === "approve"
                  ? ({
                      _tag: "Approved",
                      actionDigest: digest,
                      policyVersion: action.policyVersion,
                      lifetime: "once",
                    } as const)
                  : ({ _tag: "Denied", reason: "Not yet." } as const),
              ),
            };
          }),
        currentAccess: Effect.succeed(access),
        grants: Effect.succeed([]),
        used: () => Effect.void,
      },
    });
    if (tools === null) return yield* Effect.die("the turn was offered no GitHub tools");
    const answer = yield* tools.call(
      tool,
      input,
      hubCallStep(`step-${tool}`, (event) => events.push(event)),
    );
    const labels = events.flatMap((event) => ("label" in event ? [event.label] : []));
    return { answer, asked, labels, summary: asked.map((card) => String(card.arguments.summary)) };
  });

type WriteServices = Charms | CharmServices;

const runWrites = <A, E>(
  w: World,
  calls: Array<string>,
  project: { readonly folder: string; readonly repository: GitHubRepository },
  effect: Effect.Effect<A, E, WriteServices>,
) => Effect.runPromise(Effect.provide(effect, writesLayer(w, calls, project.folder, project.repository)));

describe("A hob's own GitHub App's pull requests and comments", () => {
  // covers ADR 022, PE-003, PE-007
  it("[TC-GEN-092] opens a draft pull request as the hob's bot, with a card and a step that name the bot", async () => {
    const w = world();
    const calls: Array<string> = [];
    const project = projectFor("pr-shed");
    const fromToken = github.installationTokens.length;
    const outcome = await runWrites(
      w,
      calls,
      project,
      Effect.gen(function* () {
        const app = yield* withApp(FRODO, [project.slug]);
        const opened = yield* callAs(FRODO, w, project.folder, "github_open_pull_request", {
          head: "feat/x",
          title: "Name the pony",
          body: "Picks Bill.",
          key: "pr-1",
        });
        return { app, ...opened };
      }),
    );
    const bot = `${outcome.app.slug}[bot]`;
    expect(outcome.answer).toMatchObject({
      refused: false,
      text: expect.stringContaining("Opened draft pull request #2"),
    });
    expect(outcome.asked).toHaveLength(1);
    expect(outcome.asked[0]).toMatchObject({ tool: "github_open_pull_request", operation: "github.open-pull-request" });
    expect(outcome.asked[0]?.arguments.actingAs).toEqual({ _tag: "HobApp", hob: "Frodo", bot });
    expect(outcome.summary[0]?.split("\n").at(-1)).toBe(`As Frodo's app, ${bot}.`);
    expect(outcome.labels).toContain(`Opening a pull request from feat/x as Frodo's app, ${bot}`);
    const pull = github.items(project.slug).find((item) => item.pullRequest !== null);
    expect(pull).toMatchObject({
      author: bot,
      title: "Name the pony",
      pullRequest: { head: "feat/x", base: "main", draft: true },
    });
    // Read and open each with a token for this repository and only that action's permissions.
    expect(tokensSince(fromToken).map((token) => [token.repositories, token.permissions])).toEqual([
      [[project.slug], ACTION_PERMISSIONS.read],
      [[project.slug], ACTION_PERMISSIONS["open-pull-request"]],
    ]);
    // The user's account was never asked for a token.
    expect(calls).toEqual([]);
    expect([...w.calls.values()].map((call) => call.state)).toEqual(["applied"]);
  });

  // covers ADR 022, PE-003, PE-007
  it("[TC-GEN-093] comments as the hob's bot, with the hidden marker, after a card that names the bot", async () => {
    const w = world();
    const calls: Array<string> = [];
    const project = projectFor("comment-shed");
    const outcome = await runWrites(
      w,
      calls,
      project,
      Effect.gen(function* () {
        const app = yield* withApp(FRODO, [project.slug]);
        const commented = yield* callAs(FRODO, w, project.folder, "github_comment", {
          number: 1,
          body: "Bill is a fine name.",
          key: "c-1",
        });
        return { app, ...commented };
      }),
    );
    const bot = `${outcome.app.slug}[bot]`;
    expect(outcome.answer).toMatchObject({ refused: false, text: expect.stringContaining("Commented on issue #1") });
    expect(outcome.summary[0]).toBe(
      `Comment on issue #1 in ${project.slug}: Pick a name for the pony\n\nBill is a fine name.\n\nAs Frodo's app, ${bot}.`,
    );
    expect(outcome.labels).toContain(`Commenting on #1 as Frodo's app, ${bot}`);
    const [comment] = github.items(project.slug)[0]?.comments ?? [];
    expect(comment?.author).toBe(bot);
    expect(comment?.body).toMatch(/^Bill is a fine name\.\n\n<!-- hobbots-call: [0-9a-f-]{36} -->$/);
    expect(github.installationTokens.at(-1)?.permissions).toEqual(ACTION_PERMISSIONS.comment);
    expect(calls).toEqual([]);
  });

  // covers ADR 022, PE-003, PE-005
  it("[TC-GEN-094] keeps the hob's policy: runs under Trusting without asking, sends nothing under Never or when denied", async () => {
    const w = world();
    const calls: Array<string> = [];
    const project = projectFor("policy-shed");
    const outcome = await runWrites(
      w,
      calls,
      project,
      Effect.gen(function* () {
        const app = yield* withApp(FRODO, [project.slug]);
        const never = yield* callAs(
          FRODO,
          w,
          project.folder,
          "github_comment",
          { number: 1, body: "Never.", key: "p-1" },
          { overrides: { "github.comment": "deny" } },
        );
        const denied = yield* callAs(
          FRODO,
          w,
          project.folder,
          "github_comment",
          { number: 1, body: "Denied.", key: "p-2" },
          { answer: "deny" },
        );
        const trusting = yield* callAs(
          FRODO,
          w,
          project.folder,
          "github_comment",
          { number: 1, body: "Trusted.", key: "p-3" },
          { preset: "trusting" },
        );
        return { app, never, denied, trusting };
      }),
    );
    const bot = `${outcome.app.slug}[bot]`;
    expect(outcome.never).toMatchObject({ answer: { refused: true }, asked: [] });
    expect(outcome.denied.answer.refused).toBe(true);
    expect(outcome.denied.asked).toHaveLength(1);
    expect(outcome.trusting).toMatchObject({ answer: { refused: false }, asked: [] });
    // Without a card, the step alone says who acts.
    expect(outcome.trusting.labels).toContain(`Commenting on #1 as Frodo's app, ${bot}`);
    expect(
      github.items(project.slug)[0]?.comments.map((comment) => [comment.author, comment.body.split("\n")[0]]),
    ).toEqual([[bot, "Trusted."]]);
    expect(calls).toEqual([]);
  });

  // covers ADR 022, PE-005
  it("[TC-GEN-095] does not send when the hob's app is disconnected while the card waits, and asks again as you", async () => {
    const w = world();
    const calls: Array<string> = [];
    const project = projectFor("switch-shed");
    const outcome = await runWrites(
      w,
      calls,
      project,
      Effect.gen(function* () {
        const app = yield* withApp(FRODO, [project.slug]);
        const service = yield* HobGitHubAppService;
        const switched = yield* callAs(
          FRODO,
          w,
          project.folder,
          "github_open_pull_request",
          { head: "feat/x", title: "Name the pony", key: "s-1" },
          { whileAsking: service.disconnect(FRODO).pipe(Effect.asVoid, Effect.orDie) },
        );
        const again = yield* callAs(
          FRODO,
          w,
          project.folder,
          "github_open_pull_request",
          { head: "feat/x", title: "Name the pony", key: "s-1" },
          { answer: "deny" },
        );
        return { app, switched, again };
      }),
    );
    expect(outcome.switched.summary[0]).toContain(`As Frodo's app, ${outcome.app.slug}[bot].`);
    expect(outcome.switched.answer).toMatchObject({
      refused: true,
      text: expect.stringContaining("changed during this call"),
    });
    expect(github.items(project.slug).filter((item) => item.pullRequest !== null)).toEqual([]);
    // Calling again asks again, now naming the user's account, which acts for the hob from then on.
    expect(outcome.again.asked).toHaveLength(1);
    expect(outcome.again.asked[0]?.arguments.actingAs).toMatchObject({ _tag: "You" });
    expect(outcome.again.summary[0]).toMatch(/\nAs you( \(@[^)]+\))?\.$/);
    expect(w.revokedGitHub).toEqual([FRODO, FRODO]);
  });

  // covers ADR 022, IN-003, EX-004
  it("[TC-GEN-096] reads a lost pull request back as the bot's, and never takes the user's own for it", async () => {
    const w = world();
    const calls: Array<string> = [];
    const project = projectFor("lost-shed");
    /**
     * GitHub gets the request but its answer never arrives. Meanwhile the user opens their own pull
     * request from that head, and, when `bot` is given, GitHub opened the hob's as that bot.
     */
    const loseAnswer = (head: string, bot?: string) => {
      github.answer = (request) => {
        if (request.method !== "POST" || !request.path.endsWith("/pulls")) return undefined;
        const pullRequest = { head, base: "main" };
        github.addItem(project.slug, { title: "Theirs", author: "otaviobarros", pullRequest });
        if (bot !== undefined) github.addItem(project.slug, { title: "Name the pony", author: bot, pullRequest });
        return "drop";
      };
    };
    const outcome = await runWrites(
      w,
      calls,
      project,
      Effect.gen(function* () {
        const app = yield* withApp(FRODO, [project.slug]);
        const open = (head: string, key: string) =>
          callAs(FRODO, w, project.folder, "github_open_pull_request", { head, title: "Name the pony", key });
        loseAnswer("feat/x");
        const lost = yield* open("feat/x", "l-1");
        loseAnswer("feat/y", hobAppBot(app));
        const found = yield* open("feat/y", "l-2");
        github.answer = null;
        return { app, lost, found };
      }),
    );
    // Only the user's pull request is there: it is not this call's, so the call stays uncertain.
    expect(outcome.lost.answer.refused).toBe(true);
    expect(w.calls.get(`${FRODO} reply:m1 l-1`)?.state).toBe("uncertain");
    // The bot's own is found and settles the call with its link.
    const ours = github.items(project.slug).find((item) => item.author === hobAppBot(outcome.app));
    expect(ours?.pullRequest?.head).toBe("feat/y");
    expect(outcome.found.answer).toMatchObject({
      refused: false,
      text: expect.stringContaining(`pull request #${ours?.number} from feat/y`),
    });
    expect(w.calls.get(`${FRODO} reply:m1 l-2`)?.state).toBe("applied");
    expect(calls).toEqual([]);
  });
});

/** Git in a hob's folder, committing as `name` unless the test says otherwise. */
const gitIn = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: temp,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Otavio",
      GIT_AUTHOR_EMAIL: "otavio@example.com",
      GIT_COMMITTER_NAME: "Otavio",
      GIT_COMMITTER_EMAIL: "otavio@example.com",
    },
  }).trim();

/** A hob's folder cloned from a repository of the user's on the fake GitHub, on a new branch `feat/x`. */
const pushSetUp = (name: string) => {
  const seed = join(temp, `${name}-seed`);
  mkdirSync(seed);
  gitIn(seed, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(seed, "a.txt"), "a\n");
  gitIn(seed, "add", "a.txt");
  gitIn(seed, "commit", "--quiet", "--no-gpg-sign", "-m", "First");
  github.createRepository({ owner: "otaviobarros", name, from: seed });
  const folder = join(temp, name);
  // Cloned from the fake's own folder: Git over HTTP would wait on the server this process runs.
  gitIn(temp, "clone", "--quiet", join(temp, "github", "otaviobarros", `${name}.git`), folder);
  gitIn(folder, "checkout", "--quiet", "-b", "feat/x");
  return { folder, repository: { owner: "otaviobarros", name }, slug: `otaviobarros/${name}` };
};

/** One more commit in the hob's folder, which writes `files` and removes `removed`. */
const commitIn = (
  folder: string,
  message: string,
  files: Readonly<Record<string, string>>,
  options: { readonly removed?: ReadonlyArray<string>; readonly author?: string } = {},
) => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, file)), { recursive: true });
    writeFileSync(join(folder, file), text);
    gitIn(folder, "add", file);
  }
  for (const file of options.removed ?? []) gitIn(folder, "rm", "--quiet", file);
  const author = options.author === undefined ? [] : [`--author=${options.author}`];
  gitIn(folder, "commit", "--quiet", "--no-gpg-sign", ...author, "-m", message);
  return gitIn(folder, "rev-parse", "HEAD");
};

/** The GitHub Charm as a hob with its own app sees it, pushing from the hub's staging repository. */
const pushLayer = (
  w: World,
  calls: Array<string>,
  folder: string,
  repository: GitHubRepository,
  wrap: (git: GitPush["Service"]) => GitPush["Service"] = (git) => git,
) =>
  Charms.layer([GitHubCharm]).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          GitRemotes,
          GitRemotes.of({ repositoryOf: (f) => Effect.succeed(f === folder ? repository : null) }),
        ),
        PolicyEngine.node,
        memoryCharmCalls(),
        Layer.effect(GitPush, Effect.map(GitPush, wrap)).pipe(
          Layer.provide(
            GitPushLive({ folder: join(temp, "data", "charms", "github"), httpsBase: github.base }).pipe(
              Layer.provide(Layer.mergeAll(directSandbox, NodeServices.layer)),
            ),
          ),
        ),
      ),
    ),
    Layer.provideMerge(charmLayer(w, calls)),
  );

/** The user approves every card, once, and each card is kept. */
const approveAll = (access: ToolAccess, asked: Array<ApprovalAction>, whileAsking = () => {}): TurnApprovals => ({
  request: (action) =>
    Effect.gen(function* () {
      asked.push(action);
      whileAsking();
      const digest = yield* actionDigest(action);
      const decision: ApprovalOutcome = {
        _tag: "Approved",
        actionDigest: digest,
        policyVersion: action.policyVersion,
        lifetime: "once",
      };
      return { approvalId: ApprovalId.make(`approval-${asked.length}`), decision: Effect.succeed(decision) };
    }),
  currentAccess: Effect.succeed(access),
  grants: Effect.succeed([]),
  used: () => Effect.void,
});

const pushAccess = (folder: string): ToolAccess => ({
  policy: {
    preset: "balanced",
    sharedFolders: [folder],
    hob: EMPTY_HOB_POLICY,
    dataFolder: join(temp, "data"),
    restrictions: [],
    // The hub declares the GitHub Charm's operations, as the server does (ADR 031).
    charmOperations: GITHUB_CHARM.operations,
  },
  folders: [folder],
  runtimeFolder: join(temp, "runtimes", "frodo"),
  commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
});

/** Frodo calls Push once, with the user approving the card. */
const pushAs = (
  folder: string,
  asked: Array<ApprovalAction>,
  input: Record<string, unknown>,
  whileAsking?: () => void,
) =>
  Effect.gen(function* () {
    const access = pushAccess(folder);
    const tools = yield* charmToolsFor({
      agentId: FRODO,
      threadId: ThreadId.make("t1"),
      messageId: MessageId.make("m1"),
      scope: () => "reply:m1",
      currentAccess: Effect.succeed(access),
      redactor: makeRedactor(),
      approvals: approveAll(access, asked, whileAsking),
    });
    if (tools === null) return yield* Effect.die("The turn was offered no GitHub tools");
    return yield* tools.call(
      "github_push",
      input,
      hubCallStep(`toolu_${asked.length + 1}`, () => {}),
    );
  });

/** The commits the fake made through its Git database API since `from`. */
const madeSince = (from: number) => github.madeCommits.slice(from);

/** What reached GitHub's Git database API since `from`, as `METHOD kind`. */
const gitDatabaseSince = (from: number) =>
  github.requests
    .slice(from)
    .filter((request) => request.path.includes("/git/") && request.method === "POST")
    .map((request) => `POST ${request.path.split("/git/")[1]}`);

const runPush = <A, E>(
  w: World,
  calls: Array<string>,
  folder: string,
  repository: GitHubRepository,
  effect: Effect.Effect<A, E, CharmServices | Charms>,
  wrap?: (git: GitPush["Service"]) => GitPush["Service"],
) => Effect.runPromise(Effect.provide(effect, pushLayer(w, calls, folder, repository, wrap)));

/** The permissions of the installation token each Git push to GitHub since `from` signed in with. */
const pushTokensSince = (from: number) =>
  github.requests
    .slice(from)
    .filter((request) => request.method === "POST" && request.path.endsWith("/git-receive-pack"))
    .map((request) => {
      const password = Buffer.from((request.authorization ?? "").split(" ")[1] ?? "", "base64")
        .toString("utf8")
        .split(":")
        .slice(1)
        .join(":");
      return github.installationTokens.find((token) => token.token === password)?.permissions;
    });

/** The hub's staging repository for a hob's folder, and the refs of its map for `slug` (ADR 022). */
const stagingFor = (folder: string, slug: string) => {
  const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 24);
  return {
    staging: join(temp, "data", "charms", "github", "staging", `${hash(folder)}.git`),
    github: `refs/hobbots/github/${hash(slug)}`,
    sent: `refs/hobbots/sent/${hash(slug)}`,
  };
};

// Each case makes an app, with its RSA key, and runs Git and the hub's staging repository for real.
const PUSH_TIMEOUT = 30_000;

describe("Push as a hob's own GitHub App", () => {
  // covers ADR 022
  it(
    "[TC-GEN-087] makes the hob's commits on GitHub as its bot, verified, then moves the branch with Git",
    async () => {
      const w = world();
      const calls: Array<string> = [];
      const { folder, repository, slug } = pushSetUp("pony-push");
      // Files, an executable, a symbolic link and a removal, and a commit made under another name.
      const first = commitIn(folder, "Add the stable\n\nWith a door.", { "stable/door.txt": "door\n" });
      writeFileSync(join(folder, "run.sh"), "#!/bin/sh\n");
      chmodSync(join(folder, "run.sh"), 0o755);
      symlinkSync("stable/door.txt", join(folder, "door"));
      gitIn(folder, "add", "run.sh", "door");
      const second = commitIn(
        folder,
        "Add a way in",
        {},
        { removed: ["a.txt"], author: "Someone <someone@example.com>" },
      );
      const fromMade = github.madeCommits.length;
      const fromToken = github.installationTokens.length;
      const asked: Array<ApprovalAction> = [];
      const outcome = await runPush(
        w,
        calls,
        folder,
        repository,
        Effect.gen(function* () {
          const app = yield* withApp(FRODO, [slug]);
          const answer = yield* pushAs(folder, asked, { branch: "feat/x", key: "push-1" });
          return { app, answer };
        }),
      );
      const bot = `${outcome.app.slug}[bot]`;
      const made = madeSince(fromMade);
      expect(outcome.answer.refused).toBe(false);
      // Two new commits on GitHub, both written and signed as the bot, never as the user or the hob's author.
      expect(made).toHaveLength(2);
      for (const commit of made) {
        expect(commit).toMatchObject({ madeBy: bot, verified: true, author: { name: bot }, committer: { name: bot } });
      }
      // The branch is at GitHub's last commit, with the hob's files, modes, link and messages exactly.
      const head = github.headOf(slug, "feat/x");
      expect(head).toBe(made[1]?.sha);
      const remote = join(temp, "github", "otaviobarros", "pony-push.git");
      expect(gitIn(remote, "rev-parse", "feat/x^{tree}")).toBe(gitIn(folder, "rev-parse", `${second}^{tree}`));
      expect(gitIn(remote, "rev-parse", "feat/x~1^{tree}")).toBe(gitIn(folder, "rev-parse", `${first}^{tree}`));
      expect(gitIn(remote, "log", "--format=%B", "-1", "feat/x~1")).toBe("Add the stable\n\nWith a door.");
      expect(gitIn(remote, "rev-parse", "feat/x~2")).toBe(gitIn(folder, "rev-parse", "main"));
      // The card said who acts and that GitHub makes the commits again; the answer gives both IDs.
      expect(asked[0]?.arguments.summary).toContain("GitHub creates these commits again, signed as the bot");
      expect(asked[0]?.arguments.summary).toContain(`As Frodo's app, ${bot}.`);
      expect(outcome.answer.text).toContain(`${second.slice(0, 12)} is ${made[1]?.sha.slice(0, 12)} on GitHub`);
      expect(outcome.answer.text).toContain(`${first.slice(0, 12)} is ${made[0]?.sha.slice(0, 12)} on GitHub`);
      // One token for the push, with Contents write only; the user's account was never asked.
      expect(github.installationTokens.slice(fromToken).map((token) => token.permissions)).toContainEqual(
        ACTION_PERMISSIONS.push,
      );
      expect(github.installationTokens.slice(fromToken).map((token) => token.permissions)).not.toContainEqual(
        ACTION_PERMISSIONS["push-workflows"],
      );
      expect(calls).toEqual([]);
    },
    PUSH_TIMEOUT,
  );

  // covers ADR 022
  it(
    "[TC-GEN-088] sends only newer commits on the next push, and counts only those on its card",
    async () => {
      const w = world();
      const { folder, repository, slug } = pushSetUp("pony-again");
      commitIn(folder, "Add hay", { "hay.txt": "hay\n" });
      const asked: Array<ApprovalAction> = [];
      const fromMade = github.madeCommits.length;
      const outcome = await runPush(
        w,
        [],
        folder,
        repository,
        Effect.gen(function* () {
          yield* withApp(FRODO, [slug]);
          const first = yield* pushAs(folder, asked, { branch: "feat/x", key: "push-1" });
          const unchanged = yield* pushAs(folder, asked, { branch: "feat/x", key: "push-2" });
          commitIn(folder, "Add oats", { "oats.txt": "oats\n" });
          const second = yield* pushAs(folder, asked, { branch: "feat/x", key: "push-3" });
          return { first, unchanged, second };
        }),
      );
      expect(outcome.first.refused).toBe(false);
      // Nothing new: the branch is already at GitHub's commit for the hob's, so nothing is asked or sent.
      expect(outcome.unchanged.text).toContain("nothing to push");
      expect(outcome.second.refused).toBe(false);
      const made = madeSince(fromMade);
      expect(made).toHaveLength(2);
      expect(asked.map((card) => card.arguments.commits)).toEqual([1, 1]);
      expect(asked[1]?.arguments.subjects).toEqual(["Add oats"]);
      // GitHub's second commit builds on its first, which the branch already had: a plain push.
      expect(github.headOf(slug, "feat/x")).toBe(made[1]?.sha);
      const remote = join(temp, "github", "otaviobarros", "pony-again.git");
      expect(gitIn(remote, "rev-parse", "feat/x~1")).toBe(made[0]?.sha);
    },
    PUSH_TIMEOUT,
  );

  // covers ADR 022
  it(
    "[TC-GEN-089] refuses a branch that moved on GitHub, and a force push keeps its lease",
    async () => {
      const w = world();
      const { folder, repository, slug } = pushSetUp("pony-moved");
      commitIn(folder, "Add a saddle", { "saddle.txt": "saddle\n" });
      const remote = join(temp, "github", "otaviobarros", "pony-moved.git");
      // Someone else's commit on the branch, which the hob does not have.
      const elsewhere = join(temp, "pony-moved-elsewhere");
      gitIn(temp, "clone", "--quiet", remote, elsewhere);
      const theirs = commitIn(elsewhere, "Theirs", { "theirs.txt": "theirs\n" });
      gitIn(elsewhere, "push", "--quiet", remote, `${theirs}:refs/heads/feat/x`);
      const asked: Array<ApprovalAction> = [];
      const leased: Array<ApprovalAction> = [];
      const outcome = await runPush(
        w,
        [],
        folder,
        repository,
        Effect.gen(function* () {
          yield* withApp(FRODO, [slug]);
          const plain = yield* pushAs(folder, asked, { branch: "feat/x", key: "push-1" });
          const forced = yield* pushAs(folder, asked, { branch: "feat/x", force: true, key: "push-2" });
          const forcedHead = github.headOf(slug, "feat/x");
          // A force push whose branch moves again while its card waits is refused by its lease.
          commitIn(folder, "Add a bridle", { "bridle.txt": "bridle\n" });
          const moved = commitIn(elsewhere, "Theirs again", { "again.txt": "again\n" });
          const lease = yield* pushAs(folder, leased, { branch: "feat/x", force: true, key: "push-3" }, () =>
            gitIn(elsewhere, "push", "--quiet", "--force", remote, `${moved}:refs/heads/feat/x`),
          );
          return { plain, forced, forcedHead, lease, moved };
        }),
      );
      // The plain push is refused as not a fast-forward and moves nothing.
      expect(outcome.plain).toMatchObject({ refused: true, text: expect.stringContaining("refused the push") });
      // The force push replaced exactly the commit read when deciding, and is the bot's.
      expect(outcome.forced.refused).toBe(false);
      expect(github.madeCommits.find((commit) => commit.sha === outcome.forcedHead)).toMatchObject({ verified: true });
      expect(asked[1]?.arguments).toMatchObject({ force: true, replaces: theirs });
      expect(outcome.lease).toMatchObject({ refused: true, text: expect.stringContaining("refused the push") });
      expect(github.headOf(slug, "feat/x")).toBe(outcome.moved);
    },
    PUSH_TIMEOUT,
  );

  // covers ADR 022
  it(
    "[TC-GEN-090] changes no branch when GitHub fails before the branch moves, and moves it once when called again",
    async () => {
      const w = world();
      const { folder, repository, slug } = pushSetUp("pony-retry");
      commitIn(folder, "Add a bucket", { "bucket.txt": "bucket\n" });
      commitIn(folder, "Fill the bucket", { "bucket.txt": "water\n" });
      const asked: Array<ApprovalAction> = [];
      const outcome = await runPush(
        w,
        [],
        folder,
        repository,
        Effect.gen(function* () {
          yield* withApp(FRODO, [slug]);
          // Too few requests left this hour: refused before anything is sent.
          github.rateRemaining = 3;
          const fromLimited = github.requests.length;
          const limited = yield* pushAs(folder, asked, { branch: "feat/x", key: "push-1" });
          const sentWhileLimited = gitDatabaseSince(fromLimited);
          github.rateRemaining = 5000;
          // GitHub fails the second commit: the first was made, but no branch moves.
          let commits = 0;
          github.answer = (request) =>
            request.method === "POST" && request.path.endsWith("/git/commits") && ++commits === 2
              ? { status: 502, body: { message: "Server Error" } }
              : undefined;
          const failed = yield* pushAs(folder, asked, { branch: "feat/x", key: "push-2" });
          const headAfterFailure = github.headOf(slug, "feat/x");
          github.answer = null;
          const fromAgain = github.madeCommits.length;
          const again = yield* pushAs(folder, asked, { branch: "feat/x", key: "push-3" });
          return { limited, sentWhileLimited, failed, headAfterFailure, again, madeAgain: madeSince(fromAgain) };
        }),
      );
      expect(outcome.limited).toMatchObject({ refused: true, text: expect.stringContaining("Try again after") });
      expect(outcome.sentWhileLimited).toEqual([]);
      expect(outcome.failed).toMatchObject({
        refused: true,
        text: expect.stringContaining("No branch was changed, but what the hub already made on GitHub may stay there"),
      });
      expect(outcome.headAfterFailure).toBeNull();
      // Called again, the hub makes both commits anew and moves the branch once, to the last of them.
      expect(outcome.again.refused).toBe(false);
      expect(outcome.madeAgain).toHaveLength(2);
      expect(github.headOf(slug, "feat/x")).toBe(outcome.madeAgain[1]?.sha);
    },
    PUSH_TIMEOUT,
  );

  // covers ADR 022
  it(
    "[TC-GEN-091] asks for Workflows only when a commit changes one, and reads a lost answer back by GitHub's ID",
    async () => {
      const w = world();
      const { folder, repository, slug } = pushSetUp("pony-workflow");
      commitIn(folder, "Add a check", { ".github/workflows/check.yml": "on: push\n" });
      const fromToken = github.installationTokens.length;
      const asked: Array<ApprovalAction> = [];
      const outcome = await runPush(
        w,
        [],
        folder,
        repository,
        Effect.gen(function* () {
          const app = yield* withApp(FRODO, [slug]);
          // The push reaches GitHub, but its answer is lost.
          github.drop = { after: github.requests.length, when: "after" };
          const fromMade = github.madeCommits.length;
          const lost = yield* pushAs(folder, asked, { branch: "feat/x", key: "push-1" });
          github.drop = null;
          const made = madeSince(fromMade).filter((commit) => commit.madeBy === `${app.slug}[bot]`).length;
          // Calling again with the same key gives the same answer instead of pushing twice.
          const again = yield* pushAs(folder, asked, { branch: "feat/x", key: "push-1" });
          return { lost, made, again };
        }),
      );
      expect(github.installationTokens.slice(fromToken).map((token) => token.permissions)).toContainEqual(
        ACTION_PERMISSIONS["push-workflows"],
      );
      const head = github.headOf(slug, "feat/x");
      expect(github.madeCommits.find((commit) => commit.sha === head)).toMatchObject({ verified: true });
      // The lost answer was read back: the branch is at GitHub's commit for the hob's, not at the hob's own.
      expect(outcome.made).toBe(1);
      expect(outcome.lost).toMatchObject({ refused: false, text: expect.stringContaining("Pushed") });
      expect(outcome.lost.text).toContain(`is ${head?.slice(0, 12)} on GitHub`);
      expect(outcome.again).toMatchObject({ refused: false, text: expect.stringContaining("not sent again") });
    },
    PUSH_TIMEOUT,
  );
});

describe("Push as a hob's own GitHub App, when a step after GitHub made the commits fails", () => {
  // covers ADR 022
  it(
    "[TC-GEN-097] keeps Workflows when the branch did not move after GitHub made a commit that changes one",
    async () => {
      const w = world();
      const { folder, repository, slug } = pushSetUp("pony-workflow-retry");
      commitIn(folder, "Add a lint check", { ".github/workflows/lint.yml": "on: push\n" });
      const asked: Array<ApprovalAction> = [];
      const fromRequest = github.requests.length;
      const fromMade = github.madeCommits.length;
      let pushes = 0;
      const outcome = await runPush(
        w,
        [],
        folder,
        repository,
        Effect.gen(function* () {
          const app = yield* withApp(FRODO, [slug]);
          const answer = yield* pushAs(folder, asked, { branch: "feat/x", key: "push-1" });
          return { app, answer };
        }),
        // The commit map is saved, then Git cannot reach GitHub once: the branch has not moved.
        (git) => ({
          ...git,
          push: (staged, target, transport) =>
            ++pushes === 1
              ? Effect.succeed({ _tag: "NotSent", message: "The hub could not reach GitHub, so nothing was sent." })
              : git.push(staged, target, transport),
        }),
      );
      expect(outcome.answer.refused).toBe(false);
      expect(pushes).toBe(2);
      // GitHub made the commit once; the retry found it in the map and asked for Workflows again.
      const made = madeSince(fromMade).filter((commit) => commit.madeBy === `${outcome.app.slug}[bot]`);
      expect(made).toHaveLength(1);
      expect(github.headOf(slug, "feat/x")).toBe(made[0]?.sha);
      expect(pushTokensSince(fromRequest)).toEqual([ACTION_PERMISSIONS["push-workflows"]]);
    },
    PUSH_TIMEOUT,
  );

  // covers ADR 022
  it(
    "[TC-GEN-098] moves no branch when the hub cannot save which commits GitHub made, and pushes once it can",
    async () => {
      const w = world();
      const { folder, repository, slug } = pushSetUp("pony-map");
      const local = commitIn(folder, "Add a blanket", { "blanket.txt": "blanket\n" });
      const map = stagingFor(folder, slug);
      // A lock left on the map's ref, as a crashed Git would leave it: the hub cannot write the map.
      gitIn(temp, "init", "--bare", "--quiet", map.staging);
      const lock = join(map.staging, `${map.github}/${local}.lock`);
      mkdirSync(dirname(lock), { recursive: true });
      writeFileSync(lock, "");
      const asked: Array<ApprovalAction> = [];
      const outcome = await runPush(
        w,
        [],
        folder,
        repository,
        Effect.gen(function* () {
          yield* withApp(FRODO, [slug]);
          const failed = yield* pushAs(folder, asked, { branch: "feat/x", key: "push-1" });
          const headAfterFailure = github.headOf(slug, "feat/x");
          const refsAfterFailure = gitIn(map.staging, "for-each-ref", "--format=%(refname)", "refs/hobbots/");
          rmSync(lock);
          const again = yield* pushAs(folder, asked, { branch: "feat/x", key: "push-2" });
          return { failed, headAfterFailure, refsAfterFailure, again };
        }),
      );
      expect(outcome.failed).toMatchObject({
        refused: true,
        text: expect.stringContaining("could not save which commits GitHub made, so no branch was moved"),
      });
      expect(outcome.headAfterFailure).toBeNull();
      // Saving the map is one transaction: neither half of it was written.
      expect(outcome.refsAfterFailure).toBe("");
      expect(outcome.again.refused).toBe(false);
      const head = github.headOf(slug, "feat/x");
      expect(gitIn(map.staging, "rev-parse", `${map.github}/${local}`)).toBe(head);
      expect(gitIn(map.staging, "rev-parse", `${map.sent}/${local}`)).toBe(local);
    },
    PUSH_TIMEOUT,
  );
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
