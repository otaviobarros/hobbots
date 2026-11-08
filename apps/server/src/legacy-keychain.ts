import { GitHubAccounts, HobbotsRepository, HobGitHubApps } from "@hobbots/agents";
import { HobAppKeys, Keychain, type KeychainError, LegacyKeychain } from "@hobbots/charms";
import { Effect, Option, Redacted } from "effect";

/** One keychain item to move: where the hub keeps it now, and where every hub kept it before. */
interface Move {
  readonly what: string;
  readonly legacy: {
    readonly read: Effect.Effect<Option.Option<Redacted.Redacted<string>>, KeychainError>;
    readonly remove: Effect.Effect<void, KeychainError>;
  };
  readonly own: {
    readonly read: Effect.Effect<Option.Option<Redacted.Redacted<string>>, KeychainError>;
    readonly write: (secret: Redacted.Redacted<string>) => Effect.Effect<void, KeychainError>;
  };
}

const same = (a: Redacted.Redacted<string>, b: Redacted.Redacted<string>) => Redacted.value(a) === Redacted.value(b);

/**
 * Moves one shared item into the hub's own, and deletes the shared one once the hub's own holds it.
 * When the hub already has its own item, the shared one may be another hub's, so it stays, unless
 * it holds the same secret: a move that stopped before its delete.
 */
const move = ({ what, legacy, own }: Move) =>
  Effect.gen(function* () {
    const shared = yield* legacy.read;
    if (Option.isNone(shared)) return;
    const mine = yield* own.read;
    if (Option.isSome(mine) && !same(mine.value, shared.value)) return;
    if (Option.isNone(mine)) yield* own.write(shared.value);
    yield* legacy.remove;
    yield* Effect.log(`Moved ${what} into this hub's own keychain item`);
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        `The hub could not move ${what} into its own keychain item, and tries again on its next start`,
        {
          message: error.message,
        },
      ),
    ),
  );

/**
 * Moves the sign-ins this hub kept in the keychain items every hub on the computer shared before
 * #1214 into its own items, once, so an upgrade keeps it signed in. Only what the hub's records say
 * it stored is moved: the GitHub App sign-in when it connected one, and the key of each hob with an
 * app. The first hub to start with such a record takes the shared item. A keychain that does not
 * answer leaves everything where it was, for the next start; the hub starts either way.
 */
export const claimLegacySignIns = Effect.gen(function* () {
  const legacy = yield* LegacyKeychain;
  const signIn = yield* Keychain;
  const keys = yield* HobAppKeys;
  const accounts = yield* GitHubAccounts;
  const apps = yield* HobGitHubApps;
  const hobs = yield* HobbotsRepository;
  if ((yield* accounts.get)?.source === "app") {
    yield* move({ what: "the GitHub sign-in", legacy: legacy.signIn, own: signIn });
  }
  for (const hob of yield* hobs.listAgentsWithStatus(["active", "paused", "retired"])) {
    const recorded = (yield* apps.get(hob.id)) !== null || (yield* apps.leftOver(hob.id)) !== null;
    if (!recorded) continue;
    yield* move({
      what: `${hob.name}'s GitHub app key`,
      legacy: { read: legacy.hobAppKeys.read(hob.id), remove: legacy.hobAppKeys.remove(hob.id) },
      own: { read: keys.read(hob.id), write: (pem) => keys.write(hob.id, pem) },
    });
  }
});
