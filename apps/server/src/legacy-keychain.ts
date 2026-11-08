import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { GitHubAccounts, HobbotsRepository, HobGitHubApps } from "@hobbots/agents";
import { HobAppKeys, Keychain, type KeychainError, LegacyKeychain } from "@hobbots/charms";
import { Context, Effect, Layer, Option, Redacted, Schedule } from "effect";
import { processAlive } from "./hub-presence.ts";

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
 * it holds the same secret: a move that stopped before its delete. Answers what may still be in the
 * shared item because the keychain did not read, save or delete it, or null when nothing of it is.
 */
const move = ({ what, legacy, own }: Move) =>
  Effect.gen(function* () {
    const shared = yield* legacy.read;
    if (Option.isNone(shared)) return null;
    const mine = yield* own.read;
    if (Option.isSome(mine) && !same(mine.value, shared.value)) return null;
    if (Option.isNone(mine)) yield* own.write(shared.value);
    yield* legacy.remove;
    yield* Effect.log(`Moved ${what} into this hub's own keychain item`);
    return null;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(`${capitalize(what)} may still be in the keychain item every hub shared: ${error.message}`),
    ),
  );

const capitalize = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/**
 * The lock every hub of this user takes while it moves sign-ins out of the shared items: a folder
 * made with `mkdir`, which only one process can do at a time, beside the user's own temporary files.
 * Without it, two hubs starting together could both copy the same sign-in, and a refresh by one
 * would retire the other's token.
 */
export const legacyKeychainLock = () => join(tmpdir(), `hobbots-${userInfo().uid}-legacy-keychain.lock`);

const owner = (lock: string) => join(lock, "pid");

/** The process holding the lock, or null while the holder has not written it yet. */
const holder = (lock: string) => {
  try {
    return Number.parseInt(readFileSync(owner(lock), "utf8"), 10) || null;
  } catch {
    return null;
  }
};

/** Whether a lock was left by a hub that stopped while it held it: its process is gone, or it never wrote one. */
const abandoned = (lock: string) => {
  const pid = holder(lock);
  if (pid !== null) return !processAlive(pid);
  try {
    return Date.now() - statSync(lock).mtimeMs > 60_000;
  } catch {
    return false;
  }
};

/**
 * Takes the lock, waiting up to `wait` for another hub to let it go. An abandoned lock is taken
 * over. Fails when another hub still holds it.
 */
const take = (lock: string, wait: number) =>
  Effect.try({
    try: () => {
      try {
        mkdirSync(lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !abandoned(lock)) throw error;
        rmSync(lock, { recursive: true, force: true });
        mkdirSync(lock);
      }
      writeFileSync(owner(lock), `${process.pid}\n`, { mode: 0o600 });
    },
    catch: (error) => error as NodeJS.ErrnoException,
  }).pipe(
    Effect.retry({
      while: (error) => error.code === "EEXIST",
      schedule: Schedule.spaced("100 millis"),
      times: Math.ceil(wait / 100),
    }),
    Effect.mapError((error) =>
      error.code === "EEXIST"
        ? "Another hub on this computer is moving its sign-ins out of the keychain items every hub shared. Try again once it has started."
        : `The hub could not make ${lock}, so it did not move its sign-ins out of the keychain items every hub shared: ${error.message}`,
    ),
  );

const release = (lock: string) => Effect.sync(() => rmSync(lock, { recursive: true, force: true }));

/**
 * Moves the sign-ins this hub kept in the keychain items every hub on the computer shared before
 * #1214 into its own items, once, so an upgrade keeps it signed in. Only what the hub's records say
 * it stored is moved: the GitHub App sign-in when it connected one, and the key of each hob with an
 * app. One hub moves at a time, under `lock`, and reads the shared items only once it holds it, so
 * of two hubs with such a record, only the first takes the shared item.
 *
 * Answers what may still be in the shared items: an item the keychain did not read, save or delete,
 * or every item when another hub kept the lock. The hub starts either way and tries again on its
 * next start, but Start over and the reset command delete nothing while anything is answered, so
 * the records that say the hub stored those items stay (ADR 026).
 */
export const claimLegacySignIns = (lock: string, wait = 30_000) =>
  Effect.gen(function* () {
    const legacy = yield* LegacyKeychain;
    const signIn = yield* Keychain;
    const keys = yield* HobAppKeys;
    const accounts = yield* GitHubAccounts;
    const apps = yield* HobGitHubApps;
    const hobs = yield* HobbotsRepository;
    const moves: Array<Move> = [];
    if ((yield* accounts.get)?.source === "app") {
      moves.push({ what: "the GitHub sign-in", legacy: legacy.signIn, own: signIn });
    }
    for (const hob of yield* hobs.listAgentsWithStatus(["active", "paused", "retired"])) {
      const recorded = (yield* apps.get(hob.id)) !== null || (yield* apps.leftOver(hob.id)) !== null;
      if (!recorded) continue;
      moves.push({
        what: `${hob.name}'s GitHub app key`,
        legacy: { read: legacy.hobAppKeys.read(hob.id), remove: legacy.hobAppKeys.remove(hob.id) },
        own: { read: keys.read(hob.id), write: (pem) => keys.write(hob.id, pem) },
      });
    }
    if (moves.length === 0) return [];
    const kept = yield* Effect.acquireUseRelease(
      take(lock, wait),
      () => Effect.forEach(moves, move),
      () => release(lock),
    ).pipe(Effect.catch((reason) => Effect.succeed([reason])));
    const problems: Array<string> = [];
    for (const problem of kept) if (problem !== null) problems.push(problem);
    if (problems.length > 0) {
      yield* Effect.logWarning("The hub could not move every sign-in out of the shared keychain items", { problems });
    }
    return problems;
  });

/**
 * The move, with what it needs, for Start over (#948): it moves what is left before it erases the
 * hub's own items, and stops while anything may still be in the shared ones.
 */
export class LegacySignIns extends Context.Service<
  LegacySignIns,
  { readonly claim: Effect.Effect<ReadonlyArray<string>> }
>()("@hobbots/server/LegacySignIns") {
  static readonly layer = (lock: string) =>
    Layer.effect(
      LegacySignIns,
      Effect.gen(function* () {
        const context = yield* Effect.context<
          LegacyKeychain | Keychain | HobAppKeys | GitHubAccounts | HobGitHubApps | HobbotsRepository
        >();
        return LegacySignIns.of({ claim: claimLegacySignIns(lock).pipe(Effect.provide(context)) });
      }),
    );
}
