import { Agent, AgentId } from "@hobbots/domain";
import { HobbotsRepository } from "@hobbots/persistence";
import { DateTime, Effect, Option } from "effect";

export const ALDRIC_ID = AgentId.make("aldric");

const ALDRIC_INSTRUCTIONS = `You are Aldric, a friendly, capable generalist and the first bot in Hobbots.
You are running inside the first validation build of Hobbots. You have no tools in this build,
so answer from your own knowledge and say so plainly when a task would need files, a terminal or the web.`;

/** Creates the first agent on an empty installation. */
export const seedAgents = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  if (Option.isSome(yield* repo.findAgent(ALDRIC_ID))) return;
  yield* repo.insertAgent(
    new Agent({
      id: ALDRIC_ID,
      name: "Aldric",
      role: "Guide",
      runtime: "claude-code",
      model: null,
      instructions: ALDRIC_INSTRUCTIONS,
      lookSeed: 4821,
      lookColor: "violet",
      createdAt: DateTime.formatIso(yield* DateTime.now),
    }),
  );
});
