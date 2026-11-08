import { HobbotsApi, SkillMissing, SkillSourceNotRead } from "@hobbots/api";
import type { SkillNotFound } from "@hobbots/domain";
import { SkillRepositories } from "@hobbots/skills";
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { importError } from "./skills.ts";

/**
 * A repository's own skills over HTTP (ADR 029, Scopes, #1098): `SkillRepositories` in
 * `@hobbots/skills` decides what is offered and what an import does. Every decision here is yours:
 * a device session makes it, and no hob reaches these routes.
 */

const missing = (error: SkillNotFound) => new SkillMissing({ id: error.id });

export const SkillRepositoriesHandlers = HttpApiBuilder.group(HobbotsApi, "skillRepositories", (handlers) =>
  Effect.gen(function* () {
    const found = yield* Effect.serviceOption(SkillRepositories);
    if (Option.isNone(found)) {
      const none = ({ payload }: { readonly payload: { readonly project: string } }) =>
        Effect.fail(new SkillMissing({ id: payload.project }));
      return handlers.handleAll({
        list: () => Effect.succeed({ repositories: [] }),
        scan: none,
        import: none,
        dismiss: none,
      });
    }
    const repositories = found.value;
    const view = Effect.map(repositories.list, (all) => ({ repositories: all }));
    return handlers.handleAll({
      list: () => view,
      scan: ({ payload }) =>
        repositories
          .scan(payload.project)
          .pipe(
            Effect.mapError((error) =>
              error._tag === "SkillNotFound" ? missing(error) : new SkillSourceNotRead({ message: error.message }),
            ),
          ),
      import: ({ payload }) => repositories.import(payload.project, payload.scanned).pipe(Effect.mapError(importError)),
      dismiss: ({ payload }) =>
        repositories.dismiss(payload.project).pipe(Effect.mapError(missing), Effect.andThen(view)),
    });
  }),
);
