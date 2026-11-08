import { createHash } from "node:crypto";
import type { AgentId } from "@hobbots/domain";
import { Context, Effect, Layer, Option, Redacted, Ref, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { runTool, type ToolRun, toolEnv } from "./run-tool.ts";

/**
 * The OS keychain on the hub, where the connected GitHub account's tokens live (ADR 020). The
 * secret is handed to the keychain tool on its standard input, never on a command line, where any
 * process on the hub could read it. Without a usable keychain the hub refuses to keep a secret
 * rather than write it to a file.
 */

/** Why the keychain could not keep or give back a secret. */
export class KeychainError extends Schema.TaggedError<KeychainError>()("KeychainError", {
  reason: Schema.Literals(["unavailable", "failed"]),
  message: Schema.String,
}) {}

/**
 * What a failed delete of a keychain item leaves to say, or null when nothing of it can be left
 * (#948). A refusal means the item is still there. A tool that could not run or answer in time says
 * nothing about the item, so the outcome is unknown, and counts as kept when the hub's records say
 * it stored the item (`recorded`). Without such a record, the hub never stored one it knows of.
 */
export const deleteOutcome = (error: KeychainError, recorded: boolean, what: string): string | null => {
  if (error.reason === "failed") return `The keychain did not delete ${what}: ${error.message}`;
  return recorded ? `The hub could not tell whether the keychain deleted ${what}: ${error.message}` : null;
};

export class Keychain extends Context.Service<
  Keychain,
  {
    /** The stored secret, or none when there is no item. */
    readonly read: Effect.Effect<Option.Option<Redacted.Redacted<string>>, KeychainError>;
    /** Stores the secret, replacing any item already there. */
    readonly write: (secret: Redacted.Redacted<string>) => Effect.Effect<void, KeychainError>;
    /** Deletes the item; nothing happens when there is none. */
    readonly remove: Effect.Effect<void, KeychainError>;
  }
>()("@hobbots/charms/Keychain") {}

/**
 * Which hub's items these are (#1214): every hub on one computer shares its keychain, so each one
 * keeps its items under its own name, made from its data folder. Start over on one hub, or Connect
 * on another, then leaves the other hubs' sign-ins alone. `dataDir` is the data folder's real path,
 * so two spellings of one folder name one hub. A restore into the same folder keeps the name, and
 * with it the sign-ins, as before.
 */
export const hubKeychainScope = (dataDir: string) =>
  createHash("sha256").update(dataDir, "utf8").digest("hex").slice(0, 16);

/** The service name of the hub's GitHub sign-in in the keychain: one item, for the account it connected. */
export const signInService = (scope: string) => `ai.hobbots.hub-${scope}.github`;
/** The keychain service of every hob's app key on the hub; the item's account is the hob's ID. */
export const hobAppService = (scope: string) => `ai.hobbots.hub-${scope}.github.hob-app`;

/**
 * The service names every hub on a computer shared before #1214. A hub moves what it finds there
 * into its own items once (`LegacyKeychain`), and never writes there again.
 */
export const LEGACY_SIGN_IN_SERVICE = "ai.hobbots.github";
export const LEGACY_HOB_APP_SERVICE = "ai.hobbots.github.hob-app";
const KEYCHAIN_ACCOUNT = "github.com";

// A stored secret holds only these characters (base64url), so it needs no quoting on `security`'s input line.
const SAFE_SECRET = /^[A-Za-z0-9_-]+$/;

/** Runs a keychain tool on the hub; one that cannot run means the hub has no keychain. */
const runner = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"], env: NodeJS.ProcessEnv) => {
  const run = runTool(spawner, toolEnv(env));
  return (command: string, args: ReadonlyArray<string>, input?: string): Effect.Effect<ToolRun, KeychainError> =>
    run(command, args, input === undefined ? {} : { input }).pipe(
      Effect.mapError(
        () =>
          new KeychainError({
            reason: "unavailable",
            message: `The hub could not run ${command}, so it has no keychain to keep secrets in.`,
          }),
      ),
    );
};
type Runner = ReturnType<typeof runner>;

/** One keychain item: where it is kept, and what it holds, in words for messages. */
interface Item {
  readonly service: string;
  readonly account: string;
  /** Such as "the GitHub sign-in". */
  readonly what: string;
  /** The label the Secret Service shows. */
  readonly label: string;
}

/** The item the connected GitHub account's tokens live in, under `service`. */
const signInItem = (service: string): Item => ({
  service,
  account: KEYCHAIN_ACCOUNT,
  what: "the GitHub sign-in",
  label: "Hobbots GitHub",
});

const failed = (item: Item, verb: string, code: number) =>
  new KeychainError({ reason: "failed", message: `The keychain could not ${verb} ${item.what} (${code}).` });

const checkSafe = (item: Item, secret: Redacted.Redacted<string>) =>
  SAFE_SECRET.test(Redacted.value(secret))
    ? Effect.void
    : Effect.fail(
        new KeychainError({ reason: "failed", message: `${capitalize(item.what)} is not in a form Hobbots stores.` }),
      );

const capitalize = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** What one keychain item offers. */
type ItemAccess = Keychain["Service"];

/**
 * macOS Keychain through `security`. Writing goes through `security -i`, which reads the command
 * from its standard input, so the secret never shows in the process list. Exit code 44 means no item.
 */
const macOS = (run: Runner, item: Item): ItemAccess => {
  const read = run("security", ["find-generic-password", "-s", item.service, "-a", item.account, "-w"]).pipe(
    Effect.flatMap(({ out, code }) =>
      code === 0
        ? Effect.succeed(Option.some(Redacted.make(out.trim())))
        : code === 44
          ? Effect.succeed(Option.none())
          : Effect.fail(failed(item, "read", code)),
    ),
  );
  return {
    read,
    write: (secret) =>
      checkSafe(item, secret).pipe(
        Effect.andThen(
          run(
            "security",
            ["-i"],
            `add-generic-password -U -s ${item.service} -a ${item.account} -w ${Redacted.value(secret)}\n`,
          ),
        ),
        Effect.flatMap(({ code }) => (code === 0 ? Effect.void : Effect.fail(failed(item, "save", code)))),
        // `security -i` can exit 0 when the command it read failed, so the item is read back.
        Effect.andThen(read),
        Effect.flatMap((saved) =>
          Option.isSome(saved) && Redacted.value(saved.value) === Redacted.value(secret)
            ? Effect.void
            : Effect.fail(failed(item, "save", 0)),
        ),
      ),
    remove: run("security", ["delete-generic-password", "-s", item.service, "-a", item.account]).pipe(
      Effect.flatMap(({ code }) =>
        code === 0 || code === 44 ? Effect.void : Effect.fail(failed(item, "delete", code)),
      ),
    ),
  };
};

/**
 * The Secret Service on Linux through `secret-tool`, which reads the secret to store from its
 * standard input. A lookup with no item prints nothing and exits 1.
 */
const secretService = (run: Runner, item: Item): ItemAccess => {
  const attributes = ["service", item.service, "account", item.account];
  return {
    read: run("secret-tool", ["lookup", ...attributes]).pipe(
      Effect.flatMap(({ out, code }) =>
        code === 0 && out.trim() !== ""
          ? Effect.succeed(Option.some(Redacted.make(out.trim())))
          : code === 0 || code === 1
            ? Effect.succeed(Option.none())
            : Effect.fail(failed(item, "read", code)),
      ),
    ),
    write: (secret) =>
      checkSafe(item, secret).pipe(
        Effect.andThen(run("secret-tool", ["store", `--label=${item.label}`, ...attributes], Redacted.value(secret))),
        Effect.flatMap(({ code }) =>
          code === 0
            ? Effect.void
            : Effect.fail(
                new KeychainError({
                  reason: "unavailable",
                  message: `The Secret Service on this hub could not save ${item.what}. Is a keyring unlocked?`,
                }),
              ),
        ),
      ),
    remove: run("secret-tool", ["clear", ...attributes]).pipe(
      Effect.flatMap(({ code }) =>
        code === 0 || code === 1 ? Effect.void : Effect.fail(failed(item, "delete", code)),
      ),
    ),
  };
};

/** Whether the hub's platform has a keychain Hobbots can use: macOS Keychain, or the Secret Service on Linux. */
const hasKeychain = (platform: NodeJS.Platform) => platform === "darwin" || platform === "linux";

/** Where an item lives on the hub's platform: macOS Keychain, the Secret Service on Linux, else nowhere. */
const platformItems =
  (platform: NodeJS.Platform, run: Runner) =>
  (item: Item): ItemAccess => {
    if (platform === "darwin") return macOS(run, item);
    if (platform === "linux") return secretService(run, item);
    return {
      read: Effect.succeed(Option.none()),
      write: () =>
        Effect.fail(
          new KeychainError({
            reason: "unavailable",
            message: `This hub has no keychain Hobbots can use, so it does not keep ${item.what}.`,
          }),
        ),
      remove: Effect.void,
    };
  };

/**
 * The hub's GitHub sign-in in the keychain of its platform: macOS Keychain, the Secret Service on
 * Linux, else none. `scope` is the hub's own, from `hubKeychainScope`.
 */
export const KeychainLive = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv, scope: string) =>
  Layer.effect(
    Keychain,
    Effect.gen(function* () {
      const run = runner(yield* ChildProcessSpawner.ChildProcessSpawner, env);
      return Keychain.of(platformItems(platform, run)(signInItem(signInService(scope))));
    }),
  );

/** One keychain item held in memory, checked as the real keychain checks what it stores. */
const memoryItem = (described: Item): Effect.Effect<ItemAccess> =>
  Effect.map(Ref.make(Option.none<Redacted.Redacted<string>>()), (item) => ({
    read: Ref.get(item),
    write: (secret) => checkSafe(described, secret).pipe(Effect.andThen(Ref.set(item, Option.some(secret)))),
    remove: Ref.set(item, Option.none()),
  }));

/**
 * A connected desktop's device token (ADR 025): one item, the token the hub it is connected to
 * gave it. Never written to a file; without a usable keychain, connecting stops.
 */
export class DeviceTokenKeychain extends Context.Service<DeviceTokenKeychain, Keychain["Service"]>()(
  "@hobbots/charms/DeviceTokenKeychain",
) {}

/** The item's service name in the keychain of a connected desktop. */
export const DEVICE_KEYCHAIN_SERVICE = "ai.hobbots.device";

const DEVICE_ITEM: Item = {
  service: DEVICE_KEYCHAIN_SERVICE,
  account: "hub",
  what: "this computer's device token",
  label: "Hobbots device",
};

/** The device token in the keychain of this computer's platform: macOS Keychain, the Secret Service on Linux. */
export const DeviceTokenKeychainLive = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv) =>
  Layer.effect(
    DeviceTokenKeychain,
    Effect.gen(function* () {
      const run = runner(yield* ChildProcessSpawner.ChildProcessSpawner, env);
      return DeviceTokenKeychain.of(platformItems(platform, run)(DEVICE_ITEM));
    }),
  );

/** The device token held in memory, for tests and an app started with `HOBBOTS_FAKE_KEYCHAIN=memory`. */
export const DeviceTokenKeychainMemory = Layer.effect(DeviceTokenKeychain, memoryItem(DEVICE_ITEM));

/**
 * A keychain held in memory for the hub's lifetime, for tests and for a hub started with
 * `HOBBOTS_FAKE_KEYCHAIN=memory` to try the flow without touching the real keychain.
 */
export const KeychainMemory = Layer.effect(Keychain, memoryItem(signInItem("memory")));

/**
 * Each hob's own GitHub App private key (ADR 022): one keychain item per hob, beside the connected
 * account's. The key is kept as base64url, so it goes to the keychain tool without quoting, and is
 * handed back as the PEM text GitHub gave.
 */
export class HobAppKeys extends Context.Service<
  HobAppKeys,
  {
    /** Whether the hub has a keychain to keep a key in. Reads no secret. */
    readonly usable: Effect.Effect<boolean>;
    readonly read: (agentId: AgentId) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, KeychainError>;
    /** Stores the hob's key, replacing any it had, and reads it back. */
    readonly write: (agentId: AgentId, pem: Redacted.Redacted<string>) => Effect.Effect<void, KeychainError>;
    /** Deletes the hob's key; nothing happens when there is none. */
    readonly remove: (agentId: AgentId) => Effect.Effect<void, KeychainError>;
  }
>()("@hobbots/charms/HobAppKeys") {}

const hobAppItem = (service: string, agentId: AgentId): Item => ({
  service,
  account: agentId,
  what: "the hob's GitHub app key",
  label: "Hobbots hob GitHub app",
});

// A hob ID goes on the keychain tool's command line and input line, so it must need no quoting.
const SAFE_ACCOUNT = /^[A-Za-z0-9_-]+$/;

const encodeKey = (pem: Redacted.Redacted<string>) =>
  Redacted.make(Buffer.from(Redacted.value(pem), "utf8").toString("base64url"));
const decodeKey = (stored: Redacted.Redacted<string>) =>
  Redacted.make(Buffer.from(Redacted.value(stored), "base64url").toString("utf8"));

/**
 * The hobs' app keys under `service`. `supported`: false on a platform with no keychain Hobbots can
 * use, where nothing can be kept.
 */
const hobAppKeys = (items: (item: Item) => ItemAccess, supported: boolean, service: string) => {
  const itemFor = (agentId: AgentId): Effect.Effect<ItemAccess, KeychainError> =>
    SAFE_ACCOUNT.test(agentId)
      ? Effect.succeed(items(hobAppItem(service, agentId)))
      : Effect.fail(
          new KeychainError({ reason: "failed", message: "The hob's ID is not one Hobbots keeps a key for." }),
        );
  return HobAppKeys.of({
    // A read the keychain cannot run means there is none; a locked one still counts as usable.
    usable: supported
      ? items(hobAppItem(service, "probe" as AgentId)).read.pipe(
          Effect.as(true),
          Effect.catch((error) => Effect.succeed(error.reason !== "unavailable")),
        )
      : Effect.succeed(false),
    read: (agentId) =>
      itemFor(agentId).pipe(
        Effect.flatMap((item) => item.read),
        Effect.map(Option.map(decodeKey)),
      ),
    write: (agentId, pem) => itemFor(agentId).pipe(Effect.flatMap((item) => item.write(encodeKey(pem)))),
    remove: (agentId) => itemFor(agentId).pipe(Effect.flatMap((item) => item.remove)),
  });
};

/** The hobs' app keys in the keychain of the hub's platform, under the hub's own `scope`. */
export const HobAppKeysLive = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv, scope: string) =>
  Layer.effect(
    HobAppKeys,
    Effect.gen(function* () {
      return hobAppKeys(
        platformItems(platform, runner(yield* ChildProcessSpawner.ChildProcessSpawner, env)),
        hasKeychain(platform),
        hobAppService(scope),
      );
    }),
  );

/** Hobs' app keys held in a map, as the real keychain checks what it stores. */
const memoryHobAppKeys = (kept: Map<string, Redacted.Redacted<string>>, service: string) =>
  hobAppKeys(
    (item) => ({
      read: Effect.sync(() => Option.fromNullishOr(kept.get(item.account))),
      write: (secret) =>
        checkSafe(item, secret).pipe(Effect.andThen(Effect.sync(() => void kept.set(item.account, secret)))),
      remove: Effect.sync(() => void kept.delete(item.account)),
    }),
    true,
    service,
  );

/** The hobs' app keys held in memory, for tests and a hub started with `HOBBOTS_FAKE_GITHUB=on`. */
export const HobAppKeysMemory = Layer.sync(HobAppKeys, () => memoryHobAppKeys(new Map(), "memory"));

/**
 * The items every hub on a computer shared before #1214: the GitHub sign-in and each hob's app key
 * under one service name each. A hub only reads them to move what is its own into its items, and
 * deletes each one it moved (`claimLegacySignIns` in the server).
 */
export class LegacyKeychain extends Context.Service<
  LegacyKeychain,
  { readonly signIn: Keychain["Service"]; readonly hobAppKeys: HobAppKeys["Service"] }
>()("@hobbots/charms/LegacyKeychain") {}

/** The shared items in the keychain of the hub's platform. */
export const LegacyKeychainLive = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv) =>
  Layer.effect(
    LegacyKeychain,
    Effect.gen(function* () {
      const items = platformItems(platform, runner(yield* ChildProcessSpawner.ChildProcessSpawner, env));
      return LegacyKeychain.of({
        signIn: items(signInItem(LEGACY_SIGN_IN_SERVICE)),
        hobAppKeys: hobAppKeys(items, hasKeychain(platform), LEGACY_HOB_APP_SERVICE),
      });
    }),
  );

/** The shared items held in memory, empty at first: for tests and a hub with a fake keychain. */
export const LegacyKeychainMemory = Layer.effect(
  LegacyKeychain,
  Effect.map(memoryItem(signInItem(LEGACY_SIGN_IN_SERVICE)), (signIn) =>
    LegacyKeychain.of({ signIn, hobAppKeys: memoryHobAppKeys(new Map(), LEGACY_HOB_APP_SERVICE) }),
  ),
);
