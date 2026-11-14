import {
  announcer,
  CharmDeclarations,
  ChatService,
  EventPublisher,
  GrantService,
  sessionActor,
  setupLoss,
} from "@hobbots/agents";
import { HobbotsApi, SETTING_CHANGES_LIMIT, UndeclaredOperation } from "@hobbots/api";
import {
  declaredOperations,
  type InstallationSetup,
  SUMMONING_CHARM,
  type SummoningForEveryHob,
  summoningDefaultsFor,
} from "@hobbots/domain";
import { SetupRepository } from "@hobbots/persistence";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { checkFolder, checkNewFolder } from "./folders.ts";

/**
 * "Summoning for every hob" as a change sets it (ADR 034): turning it on, or turning "Can manage
 * itself" on, writes the Charm's defaults under the answers the change gives. An answer for an
 * operation the Summoning Charm does not declare is refused.
 */
const everyHobChange = (before: InstallationSetup, given: SummoningForEveryHob | null) =>
  Effect.gen(function* () {
    if (given === null) return null;
    const declared = new Set(SUMMONING_CHARM.operations.map((operation) => operation.id));
    const undeclared = Object.keys(given.overrides).filter((id) => !declared.has(id as never));
    if (undeclared.length > 0) {
      return yield* new UndeclaredOperation({
        operations: undeclared,
        message: `The Summoning Charm does not declare ${undeclared.join(", ")}`,
      });
    }
    const was = before.summoningForEveryHob;
    const defaults = summoningDefaultsFor({
      granting: was === null,
      selfTurnedOn: given.scope.self && !(was?.scope.self ?? false),
    });
    return { scope: given.scope, overrides: { ...(was?.overrides ?? {}), ...defaults, ...given.overrides } };
  });

export const SetupHandlers = HttpApiBuilder.group(HobbotsApi, "setup", (handlers) =>
  Effect.gen(function* () {
    const setup = yield* SetupRepository;
    const chat = yield* ChatService;
    const grants = yield* GrantService;
    const charmOperations = declaredOperations(yield* CharmDeclarations);
    const announce = announcer(yield* Effect.serviceOption(EventPublisher), "a setting change");
    return handlers.handleAll({
      get: () => setup.get,
      // One more than Settings shows tells whether older changes were left out.
      changes: () =>
        setup.changes(SETTING_CHANGES_LIMIT + 1).pipe(
          Effect.map((found) => ({
            changes: found.slice(0, SETTING_CHANGES_LIMIT),
            more: found.length > SETTING_CHANGES_LIMIT,
          })),
        ),
      // Folders are checked on the hub and stored resolved. A folder or provider added twice is
      // kept once, where it was first added. A newly added folder is also opened once, so macOS asks
      // about a protected one, such as Documents, now rather than in a hob's turn (#1225).
      update: ({ payload }) =>
        Effect.gen(function* () {
          const before = yield* setup.get;
          const approved = new Set(before.approvedFolders);
          const folders =
            payload.approvedFolders &&
            (yield* Effect.forEach(payload.approvedFolders, (folder) =>
              approved.has(folder) ? checkFolder(folder) : checkNewFolder(folder),
            ));
          const everyHob =
            payload.summoningForEveryHob === undefined
              ? undefined
              : yield* everyHobChange(before, payload.summoningForEveryHob);
          // Each authority setting the change moves is kept with the person who made it (#1357).
          const committed = yield* setup.update(
            {
              ...payload,
              ...(everyHob !== undefined && { summoningForEveryHob: everyHob }),
              ...(folders && { approvedFolders: [...new Set(folders)] }),
              ...(payload.connectedProviders && { connectedProviders: [...new Set(payload.connectedProviders)] }),
            },
            yield* sessionActor,
          );
          yield* announce(committed.entries);
          const updated = committed.value;
          // A narrower preset or a removed folder revokes the grants that relied on it (ADR 015), and
          // also reaches the turns already running (PE-008).
          yield* grants.revokeLost(null, setupLoss(before, updated, charmOperations));
          yield* chat.reviewAuthority();
          return updated;
        }),
    });
  }),
);
