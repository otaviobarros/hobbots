import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitHubAccounts, HobbotsRepository, HobGitHubApps } from "@hobbots/agents";
import { HobAppKeys, Keychain, KeychainError, LegacyKeychain } from "@hobbots/charms";
import { Context, Effect, Layer, Option, Redacted, Schedule, Schema } from "effect";
import { lockToken, releaseLock, tryTakeLock } from "./keychain-lock.ts";

/** One keychain item to move: where the hub keeps it now, and where every hub kept it before. */
interface Move {
  /** Its name in the list of moves under way. */
  readonly key: string;
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
 * The item is listed in `moves` before the hub's own copy is written and leaves the list once the
 * shared one is gone. When the hub already has its own item, the shared one may be another hub's,
 * so it stays, unless the list names it or it holds the same secret: a move that stopped before its
 * delete, even if the hub refreshed its copy since. Answers what may still be in the shared item
 * because the keychain did not read, save or delete it, or null when nothing of it is.
 */
const move = (dataDir: string, moves: Set<string>, { key, what, legacy, own }: Move) =>
  Effect.gen(function* () {
    const listed = moves.has(key);
    const shared = yield* legacy.read;
    if (Option.isSome(shared)) {
      const mine = yield* own.read;
      if (Option.isSome(mine) && !listed && !same(mine.value, shared.value)) return null;
      if (Option.isNone(mine)) {
        moves.add(key);
        yield* writeMoves(dataDir, moves);
        yield* own.write(shared.value);
      }
      yield* legacy.remove;
      yield* Effect.log(`Moved ${what} into this hub's own keychain item`);
    }
    if (moves.delete(key)) yield* writeMoves(dataDir, moves);
    return null;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(`${capitalize(what)} may still be in the keychain item every hub shared: ${error.message}`),
    ),
  );

const capitalize = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/**
 * Takes the lock as `token`, waiting up to `wait` for another hub to let it go (`keychain-lock.ts`).
 * Fails when another hub still holds it.
 */
const take = (lock: string, token: string, wait: number) =>
  Effect.try({
    try: () => {
      if (!tryTakeLock(lock, token)) throw new Held();
    },
    catch: (error) => error,
  }).pipe(
    Effect.retry({
      while: (error) => error instanceof Held,
      schedule: Schedule.spaced("100 millis"),
      times: Math.ceil(wait / 100),
    }),
    Effect.mapError((error) =>
      error instanceof Held
        ? "Another hub on this computer is moving its sign-ins out of the keychain items every hub shared. Try again once it has started."
        : `The hub could not take ${lock}, so it did not move its sign-ins out of the keychain items every hub shared: ${String(error)}`,
    ),
  );

class Held {}

/**
 * The file in the data folder that lists the shared items this hub moved and has not yet deleted
 * (#1214). An item is listed before the hub writes its own copy, and only leaves the list once the
 * shared one is gone, so the hub still knows the shared item is its own after it refreshed its copy.
 * Start over and the reset command delete nothing while the list names an item still there.
 */
const legacyMovesFile = (dataDir: string) => join(dataDir, "legacy-keychain.json");

const decodeMoves = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));

/** The items listed, or null when the file cannot be read. */
const readMoves = (dataDir: string): Set<string> | null => {
  let text: string;
  try {
    text = readFileSync(legacyMovesFile(dataDir), "utf8");
  } catch (error) {
    return code(error) === "ENOENT" ? new Set() : null;
  }
  return Option.match(decodeMoves(text), { onNone: () => null, onSome: (items) => new Set(items) });
};

const code = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** Written beside the file and renamed over it, so a reader never sees half a list. */
const writeMoves = (dataDir: string, items: ReadonlySet<string>) =>
  Effect.try({
    try: () => {
      const file = legacyMovesFile(dataDir);
      if (items.size === 0) return rmSync(file, { force: true });
      writeFileSync(`${file}.tmp`, `${JSON.stringify([...items].sort())}\n`, { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    },
    catch: (error) => new KeychainError({ reason: "failed", message: `${legacyMovesFile(dataDir)}: ${String(error)}` }),
  });

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
export const claimLegacySignIns = (dataDir: string, lock: string, wait = 30_000) =>
  Effect.gen(function* () {
    const legacy = yield* LegacyKeychain;
    const signIn = yield* Keychain;
    const keys = yield* HobAppKeys;
    const accounts = yield* GitHubAccounts;
    const apps = yield* HobGitHubApps;
    const hobs = yield* HobbotsRepository;
    const moves: Array<Move> = [];
    if ((yield* accounts.get)?.source === "app") {
      moves.push({ key: "sign-in", what: "the GitHub sign-in", legacy: legacy.signIn, own: signIn });
    }
    for (const hob of yield* hobs.listAgentsWithStatus(["active", "paused", "retired"])) {
      const recorded = (yield* apps.get(hob.id)) !== null || (yield* apps.leftOver(hob.id)) !== null;
      if (!recorded) continue;
      moves.push({
        key: `hob-app:${hob.id}`,
        what: `${hob.name}'s GitHub app key`,
        legacy: { read: legacy.hobAppKeys.read(hob.id), remove: legacy.hobAppKeys.remove(hob.id) },
        own: { read: keys.read(hob.id), write: (pem) => keys.write(hob.id, pem) },
      });
    }
    if (moves.length === 0) return [];
    const token = lockToken();
    const kept = yield* Effect.acquireUseRelease(
      take(lock, token, wait),
      () =>
        Effect.gen(function* () {
          // Read under the lock: the list is this data folder's, and one hub runs on it at a time.
          const listed = readMoves(dataDir);
          if (listed === null) {
            return [
              `${legacyMovesFile(dataDir)} cannot be read, so the hub cannot tell which shared keychain items it moved.`,
            ];
          }
          return yield* Effect.forEach(moves, (item) => move(dataDir, listed, item));
        }),
      () => Effect.sync(() => releaseLock(lock, token)),
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
  static readonly layer = (dataDir: string, lock: string) =>
    Layer.effect(
      LegacySignIns,
      Effect.gen(function* () {
        const context = yield* Effect.context<
          LegacyKeychain | Keychain | HobAppKeys | GitHubAccounts | HobGitHubApps | HobbotsRepository
        >();
        return LegacySignIns.of({ claim: claimLegacySignIns(dataDir, lock).pipe(Effect.provide(context)) });
      }),
    );
}
