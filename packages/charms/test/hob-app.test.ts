import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  HOB_APP_PERMISSIONS,
  HobAppKeys,
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
  redactor: makeRedactor(),
});

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
      Layer.succeed(
        HobGitHubApps,
        HobGitHubApps.of({
          get: (id) => Effect.sync(() => w.apps.get(id) ?? null),
          save: (id, app) => Effect.sync(() => void w.apps.set(id, app)),
          remove: (id) => Effect.sync(() => void w.apps.delete(id)),
        }),
      ),
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
        return { listing, disconnected, key: yield* (yield* HobAppKeys).read(FRODO) };
      }),
    );
    expect(outcome.listing).toMatchObject({ reason: "signed-out" });
    expect(outcome.disconnected.problem).toContain("Delete the app on GitHub");
    expect(outcome.disconnected.deleteUrl).toContain("/advanced");
    expect(Option.isNone(outcome.key)).toBe(true);
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
