import { type DevicePlace, DeviceRepository, DeviceService, EventPublisher, LOCAL } from "@hobbots/agents";
import { UserSession } from "@hobbots/api";
import { type EventEnvelope, type TailscaleIdentity, WINDOW_DEVICE_ID } from "@hobbots/domain";
import { DeviceRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { Effect, Exit, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { DeviceSecretsLive, knownWindowKey, PairingLimiterLive } from "../src/devices.ts";
import { TEST_WINDOW_KEY } from "./window-device.ts";

// Pairing as the hub decides it (ADR 021): Allow, Deny and Decide later, expiry, who may ask and the
// limits, over the real device store, with the test clock standing in for time.

const node = (nodeId: string, login = "you@example.com"): TailscaleIdentity => ({
  nodeId,
  nodeName: nodeId.toLowerCase(),
  owner: { _tag: "User", login },
});
const HUB = Option.some(node("nHUB"));
const tailnet = (peer: TailscaleIdentity): DevicePlace => ({ _tag: "Tailnet", peer });
const PHONE = tailnet(node("nPHONE"));
const LAPTOP = tailnet(node("nLAPTOP"));

const browser = { name: "Safari on iPhone", platform: "iOS", kind: "browser" } as const;

const published: Array<EventEnvelope> = [];
const Publisher = Layer.succeed(EventPublisher, {
  publish: (entries) => Effect.sync(() => published.push(...entries)),
  publishTransient: () => Effect.void,
});

const TestLayer = DeviceService.layer.pipe(
  Layer.provideMerge(knownWindowKey(TEST_WINDOW_KEY)),
  Layer.provideMerge(DeviceSecretsLive),
  Layer.provideMerge(PairingLimiterLive),
  Layer.provideMerge(DeviceRepositoryLive),
  Layer.provideMerge(TestDatabase),
  Layer.provideMerge(Publisher),
);

// The hub's window decides, as the user does from it.
const asWindow = Effect.gen(function* () {
  const repo = yield* DeviceRepository;
  return UserSession.of({
    deviceId: WINDOW_DEVICE_ID,
    name: "This computer's Hobbots window",
    kind: "window",
    whileApproved: repo.whileApproved(WINDOW_DEVICE_ID),
  });
});

const run = <A, E>(
  effect: Effect.Effect<A, E, DeviceService | DeviceRepository | UserSession | TestClock.TestClock>,
) => {
  published.length = 0;
  return effect.pipe(
    Effect.provideServiceEffect(UserSession, asWindow),
    Effect.provide(Layer.fresh(TestLayer)),
    Effect.provide(Layer.fresh(TestClock.layer())),
    Effect.runPromise,
  );
};

const ask = (place: DevicePlace, secret?: string) =>
  Effect.flatMap(DeviceService, (devices) =>
    devices.openPairing(browser, { place, hub: HUB, secret: Option.fromNullishOr(secret) }),
  );

const failureTag = (exit: Exit.Exit<unknown, { readonly _tag: string }>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit))?._tag : "Success";

describe("pairing a device", () => {
  // covers DP-004
  it("[TC-DP-091] a denied device sees it was not allowed, and its node can ask again only after a minute", async () => {
    const result = await run(
      Effect.gen(function* () {
        const devices = yield* DeviceService;
        const opened = yield* ask(PHONE);
        yield* devices.deny(opened.status.id);
        const status = yield* devices.pairingStatus(opened.secret, PHONE);
        const tooSoon = yield* Effect.exit(ask(PHONE));
        // Another node is not held back by the phone's Deny.
        const other = yield* Effect.exit(ask(LAPTOP));
        yield* TestClock.adjust("61 seconds");
        const later = yield* Effect.exit(ask(PHONE));
        return { status, tooSoon, other, later };
      }),
    );
    expect(result.status).toMatchObject({ state: "denied" });
    expect(Exit.isFailure(result.tooSoon) && Exit.findErrorOption(result.tooSoon)).toMatchObject(
      Option.some({ _tag: "PairingThrottled", retryAfterSeconds: 60 }),
    );
    expect(failureTag(result.other)).toBe("Success");
    expect(failureTag(result.later)).toBe("Success");
    expect(published.map((entry) => entry.type)).toEqual([
      "PairingRequested",
      "PairingChanged",
      "PairingRequested",
      "PairingRequested",
    ]);
  });

  // covers DP-004
  it("[TC-DP-092] an expired request cannot be allowed, and Decide later keeps one open for 24 hours from when it was opened", async () => {
    const result = await run(
      Effect.gen(function* () {
        const devices = yield* DeviceService;
        const expiring = yield* ask(PHONE);
        const deferred = yield* ask(LAPTOP);
        const later = yield* devices.later(deferred.status.id);
        yield* TestClock.adjust("11 minutes");
        const expiredStatus = yield* devices.pairingStatus(expiring.secret, PHONE);
        const lateAllow = yield* Effect.exit(devices.allow(expiring.status.id));
        const waiting = yield* devices.listOpenPairing(HUB);
        const deferredStatus = yield* devices.pairingStatus(deferred.secret, LAPTOP);
        const allowed = yield* devices.allow(deferred.status.id);
        return { later, expiredStatus, lateAllow, waiting, deferredStatus, allowed };
      }),
    );
    expect(Date.parse(result.later.expiresAt) - Date.parse(result.later.createdAt)).toBe(24 * 60 * 60 * 1000);
    expect(result.expiredStatus).toMatchObject({ state: "expired" });
    expect(Exit.isFailure(result.lateAllow) && Exit.findErrorOption(result.lateAllow)).toMatchObject(
      Option.some({ _tag: "PairingClosed", state: "expired" }),
    );
    expect(result.waiting.map((device) => device.request.name)).toEqual(["Safari on iPhone"]);
    expect(result.deferredStatus).toMatchObject({ state: "pending" });
    expect(result.allowed).toMatchObject({ state: "allowed" });
  });

  // covers DP-004
  it("[TC-DP-093] only the hub owner's own devices may ask, and a request from the hub itself says so", async () => {
    const result = await run(
      Effect.gen(function* () {
        const devices = yield* DeviceService;
        const tagged = yield* Effect.exit(
          ask(tailnet({ nodeId: "nSERVER", nodeName: "server", owner: { _tag: "Tagged", tags: ["tag:ci"] } })),
        );
        const teammate = yield* Effect.exit(ask(tailnet(node("nSAM", "sam@example.com"))));
        const unknownHub = yield* Effect.exit(
          devices.openPairing(browser, { place: PHONE, hub: Option.none(), secret: Option.none() }),
        );
        yield* ask(PHONE);
        yield* ask(LOCAL);
        yield* ask(tailnet(node("nHUB")));
        return { tagged, teammate, unknownHub, waiting: yield* devices.listOpenPairing(HUB) };
      }),
    );
    for (const refused of [result.tagged, result.teammate, result.unknownHub]) {
      expect(Exit.isFailure(refused) && Exit.findErrorOption(refused)).toMatchObject(
        Option.some({ _tag: "PairingRefused", reason: "notYours" }),
      );
    }
    // All three asked at the same moment, so their order is by ID.
    const fromWhere = result.waiting.map((device) => [device.request.tailscale?.nodeId ?? "local", device.fromHub]);
    expect(fromWhere.sort()).toEqual([
      ["local", true],
      ["nHUB", true],
      ["nPHONE", false],
    ]);
    // Nothing refused ever reached the journal, so no prompt showed for it.
    expect(published.map((entry) => entry.type)).toEqual(["PairingRequested", "PairingRequested", "PairingRequested"]);
  });

  // covers DP-004
  it("[TC-DP-094] holds each node to its pairing limits, and asking again with the same secret returns the same request", async () => {
    const result = await run(
      Effect.gen(function* () {
        const devices = yield* DeviceService;
        const first = yield* ask(PHONE);
        const again = yield* ask(PHONE, first.secret);
        yield* ask(PHONE);
        yield* ask(PHONE);
        // Three open requests per node, deferred ones included.
        const fourthOpen = yield* Effect.exit(ask(PHONE));
        for (const waiting of yield* devices.listOpenPairing(HUB)) yield* devices.allow(waiting.request.id);
        yield* ask(PHONE);
        yield* ask(PHONE);
        // Five new requests per node in ten minutes, however many were decided.
        const sixthNew = yield* Effect.exit(ask(PHONE));
        // One status check a second while a request waits.
        const waiting = yield* ask(LAPTOP);
        yield* devices.pairingStatus(waiting.secret, LAPTOP);
        const quickCheck = yield* Effect.exit(devices.pairingStatus(waiting.secret, LAPTOP));
        yield* TestClock.adjust("1 second");
        const nextCheck = yield* Effect.exit(devices.pairingStatus(waiting.secret, LAPTOP));
        // At most 60 requests a minute from one tailnet node without a device; local ones are never counted.
        const times = (count: number, place: DevicePlace) =>
          Effect.exit(Effect.forEach(Array.from({ length: count }), () => devices.throttleAnonymous(place)));
        const anonymous = yield* times(61, tailnet(node("nTV")));
        const local = yield* times(100, LOCAL);
        return { first, again, fourthOpen, sixthNew, quickCheck, nextCheck, anonymous, local };
      }),
    );
    expect(result.again.status.id).toBe(result.first.status.id);
    expect(result.again.secret).toBe(result.first.secret);
    expect(failureTag(result.fourthOpen)).toBe("PairingThrottled");
    expect(failureTag(result.sixthNew)).toBe("PairingThrottled");
    expect(failureTag(result.quickCheck)).toBe("PairingThrottled");
    expect(failureTag(result.nextCheck)).toBe("Success");
    expect(failureTag(result.anonymous)).toBe("PairingThrottled");
    expect(failureTag(result.local)).toBe("Success");
  });
  // covers DP-004
  it("[TC-DP-117] a secret that names no request waiting here, a claimed one included, counts against the node's limit like no secret at all", async () => {
    const result = await run(
      Effect.gen(function* () {
        const devices = yield* DeviceService;
        const opened = yield* ask(PHONE);
        const tv = tailnet(node("nTV"));
        // The TV's own request, allowed and claimed: its secret stopped working.
        const claimed = yield* ask(tv);
        yield* devices.allow(claimed.status.id);
        const token = (yield* devices.pairingStatus(claimed.secret, tv)).token;
        // Malformed, unknown, another node's and a claimed secret: 60 of them use up a minute's requests.
        const guesses = ["", "hbp_invalid", `${opened.secret}x`, opened.secret, claimed.secret];
        const tries = yield* Effect.forEach(Array.from({ length: 60 }), (_, index) =>
          Effect.exit(devices.pairingStatus(guesses[index % guesses.length] ?? "", tv)),
        );
        const overLimit = yield* Effect.exit(devices.pairingStatus("hbp_invalid", tv));
        // The phone's own secret is spared: it was never counted.
        const own = yield* Effect.exit(devices.pairingStatus(opened.secret, PHONE));
        return { token, tries, overLimit, own };
      }),
    );
    expect(result.token).toMatch(/^hbd_/);
    expect(new Set(result.tries.map(failureTag))).toEqual(new Set(["PairingNotFound"]));
    expect(failureTag(result.overLimit)).toBe("PairingThrottled");
    expect(failureTag(result.own)).toBe("Success");
  });

  // covers DP-004
  it("[TC-DP-118] devices asking at the same moment cannot pass a node's three open requests together", async () => {
    const result = await run(
      Effect.gen(function* () {
        const devices = yield* DeviceService;
        yield* ask(PHONE);
        yield* ask(PHONE);
        const together = yield* Effect.all(
          Array.from({ length: 4 }, () => Effect.exit(ask(PHONE))),
          { concurrency: "unbounded" },
        );
        return { together, open: yield* devices.listOpenPairing(HUB) };
      }),
    );
    expect(result.together.filter((exit) => Exit.isSuccess(exit))).toHaveLength(1);
    expect(result.open).toHaveLength(3);
  });
});
