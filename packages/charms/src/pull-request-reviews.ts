import { Records } from "@hobbots/agents";
import { type AgentId, AgentId as AgentIds, type Artifact, pullRequestOf, repositorySlug } from "@hobbots/domain";
import { Duration, Effect, Layer, Ref, Schedule } from "effect";
import { GitHubCredential } from "./github-account.ts";
import { GitHubApi } from "./github-api.ts";

/**
 * The GitHub Charm's part in what is ready for review (#1422): a pull request a hob delivered waits
 * for your review until you review it, or until GitHub reports it merged or closed. Every few minutes
 * the hub asks GitHub how each waiting pull request stands, with the sign-in of the hob that made it,
 * and reviews it once it ended. Asking GitHub happens before the command, never inside it
 * (STD-ARCH-014); a pull request GitHub did not answer for is asked again next round.
 */

/** How often the hub asks GitHub about the pull requests waiting for review. */
export const PULL_REQUEST_CHECK_EVERY = Duration.minutes(5);

/**
 * The most pull requests one round asks about, so a round stays small. The next round goes on from
 * where it stopped, so every waiting pull request is asked about in turn.
 */
export const PULL_REQUEST_CHECKS_PER_ROUND = 50;

/** A pull request waiting for review, with the artifacts that name it and the hob whose sign-in reads it. */
interface Waiting {
  readonly key: string;
  readonly ref: NonNullable<ReturnType<typeof pullRequestOf>>;
  readonly artifacts: Array<Artifact>;
  agentId: AgentId | null;
}

/**
 * The waiting pull requests, each once however many chats or camps hold it, oldest first, with the
 * sign-in of the first hob that made it. One only you or the hub made has no hob to read it with, and
 * waits for you.
 */
const waitingByPullRequest = (artifacts: ReadonlyArray<Artifact>): ReadonlyArray<Waiting> => {
  const found: Array<Waiting> = [];
  for (const artifact of artifacts) {
    const ref = pullRequestOf(artifact.locator);
    if (ref === null) continue;
    const key = `${repositorySlug(ref.repository).toLowerCase()}#${ref.number}`;
    const hob = artifact.actor.kind === "hob" ? AgentIds.make(artifact.actor.id) : null;
    const same = found.find((each) => each.key === key);
    if (same === undefined) found.push({ key, ref, artifacts: [artifact], agentId: hob });
    else {
      same.artifacts.push(artifact);
      same.agentId ??= hob;
    }
  }
  return found.filter((each) => each.agentId !== null);
};

/** Whether GitHub reports the pull request merged or closed: nothing is left to review on it. */
const hasEnded = (state: string) => state === "merged" || state === "closed";

/**
 * One round: asks GitHub about up to `limit` pull requests waiting for review, from the `start`th
 * on, wrapping around, and reviews those that ended. Answers how many artifacts it reviewed and
 * where the next round starts. A pull request GitHub did not answer for stays waiting.
 */
export const checkPullRequests = (start = 0, limit = PULL_REQUEST_CHECKS_PER_ROUND) =>
  Effect.gen(function* () {
    const records = yield* Records;
    const api = yield* GitHubApi;
    const credential = yield* GitHubCredential;
    const all = waitingByPullRequest(yield* records.waitingPullRequests);
    const from = all.length === 0 ? 0 : start % all.length;
    const waiting = [...all.slice(from), ...all.slice(0, from)].slice(0, limit);
    let reviewed = 0;
    let ended = 0;
    for (const each of waiting) {
      const { repository, number } = each.ref;
      const agentId = each.agentId;
      if (agentId === null) continue;
      const item = yield* credential
        .onRepository(agentId, repository, api.item(agentId, repository, number, 0))
        .pipe(
          Effect.catch((error) =>
            Effect.as(Effect.logDebug(`Could not read pull request ${each.key}: ${error.message}`), null),
          ),
        );
      if (item === null || !item.pullRequest || !hasEnded(item.state)) continue;
      ended += 1;
      for (const artifact of each.artifacts) {
        if ((yield* records.pullRequestEnded(artifact.id)) !== null) reviewed += 1;
      }
    }
    // What ended is no longer waiting, so the next round starts past only what still waits.
    return { reviewed, next: from + waiting.length - ended };
  });

/** The rounds, every few minutes for as long as the hub runs; a failed round is logged and the next one runs. */
export const PullRequestReviews = Layer.effectDiscard(
  Effect.gen(function* () {
    const next = yield* Ref.make(0);
    const round = Ref.get(next).pipe(
      Effect.flatMap((start) => checkPullRequests(start)),
      Effect.flatMap((done) => Ref.set(next, done.next)),
      Effect.catchCause((cause) => Effect.logWarning("Could not check pull requests on GitHub", cause)),
    );
    yield* round.pipe(Effect.repeat(Schedule.spaced(PULL_REQUEST_CHECK_EVERY)), Effect.forkScoped);
  }),
);
