import { type AgentId, type GitHubActor, githubActorLogin } from "@hobbots/domain";
import { Effect, Option } from "effect";
import type { GitHubCredential } from "./github-account.ts";
import type { GitHubApi } from "./github-api.ts";
import type { GitHubError } from "./github-error.ts";

/**
 * Who acts on GitHub for the hob's next call (ADR 022), which its step and approval card name: the
 * hob's own app when it has one, the user's account otherwise, with its login when GitHub gives it.
 * Fails when the hob's credential changed since the call was checked, so a card never names one
 * identity while another acts.
 */
export const githubActor = (
  credential: GitHubCredential["Service"],
  api: GitHubApi["Service"],
  agentId: AgentId,
): Effect.Effect<GitHubActor, GitHubError> =>
  Effect.gen(function* () {
    const app = yield* credential.hobApp(agentId);
    if (app !== null) return app;
    const login = yield* api.viewer(agentId).pipe(Effect.option, Effect.map(Option.getOrNull));
    return { _tag: "You", login };
  });

/**
 * The account a recorded call acted as, for reading it back: from the actor its plan names, or the
 * bare login a call recorded before the hob could have its own app kept; null when the hub did not know.
 */
export const recordedLogin = (actingAs: GitHubActor | string | null | undefined): string | null =>
  actingAs === undefined || actingAs === null || typeof actingAs === "string"
    ? (actingAs ?? null)
    : githubActorLogin(actingAs);
