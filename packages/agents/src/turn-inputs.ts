// What a chat turn starts with, besides its prompt: the hob's skills, its memory brief, the roster of
// other hobs, and what its session missed (#1397). ChatService builds these for each turn.

import {
  type Agent,
  type AgentConfiguration,
  type AgentId,
  liveSession,
  Message,
  type RuntimeKind,
  type RuntimeSession,
  skillTitle,
  systemInstructions,
  type Thread,
} from "@hobbots/domain";
import { Effect, Option } from "effect";
import { buildBriefing } from "./briefing.ts";
import { sinceYouSpoke } from "./context-pack.ts";
import { turnRoster } from "./hob-directory.ts";
import { MemoryProjects, MemoryStore } from "./memory.ts";
import { type TurnMemoryBrief, turnMemoryBrief } from "./memory-brief.ts";
import { isOwnReply, type PackPeople, reasonLine, type TurnReason } from "./pack-people.ts";
import type { HobbotsRepository } from "./repository.ts";
import type { RuntimeAdapterShape, ToolAccess } from "./runtime.ts";
import type { Redactor } from "./secrets.ts";
import { skillMounter } from "./skill-turn.ts";
import type { HobTools } from "./tools.ts";

/**
 * The messages a runtime's session missed (ADR 017): everything after the last one it saw, and that
 * one too when another brain continued it since. Without a record of what it saw, everything after
 * its own latest reply.
 */
const missedBy = (
  thread: Thread,
  runtime: RuntimeKind,
  agentId: AgentId,
  seenThrough: string | null,
  before: ReadonlyArray<Message>,
) => {
  const seen = before.findIndex((m) => m.id === seenThrough);
  if (seen !== -1) return before.slice(before[seen]?.runtime === runtime ? seen + 1 : seen);
  const own = before.findLastIndex((m) => isOwnReply(m, thread, agentId) && m.runtime === runtime);
  return before.slice(own + 1);
};

/**
 * Whether a session missed what others said, not only what its own hob said on another brain: a
 * reply by another hob, or a person's messages no hob has answered since (ADR 039).
 */
const missedOthers = (thread: Thread, agentId: AgentId, missed: ReadonlyArray<Message>) =>
  missed.some((m) => m.role === "assistant" && !isOwnReply(m, thread, agentId)) ||
  (missed.some((m) => m.role === "user") && !missed.some((m) => m.role === "assistant"));

/** Whether a reply is `agentId`'s own; one from before replies named their author is the thread's hob's. */
const isHobsOwn = (message: Message, agentId: AgentId): boolean =>
  message.actor === null || (message.actor.kind === "hob" && message.actor.id === agentId);

/** Why a trial chat's turn did not start, and how to try the draft again (ADR 029, Try in a chat). */
export const draftGoneText = (name: string) =>
  `The draft of ${skillTitle(name)} this chat tries is no longer on this hub, as after a restore, so nothing ran here. Try in a chat again from where you wrote it.`;

/** The reply with the skills its turn recorded, or nothing to change when it recorded none. */
export const withSkills = (recorded: Message["skills"]) => (message: Message) =>
  recorded === null ? undefined : new Message({ ...message, skills: recorded });

export const makeTurnInputs = (repo: HobbotsRepository["Service"], hobTools: HobTools["Service"], redactor: Redactor) =>
  Effect.gen(function* () {
    // Without memory, turns are told nothing from it (ADR 028).
    const memoryStore = yield* Effect.serviceOption(MemoryStore);
    // Without project identities, each folder is the project of its name.
    const memoryProjects = yield* Effect.serviceOption(MemoryProjects);
    // What the turn's session is told from the hob's memory: sent when the session is new or last
    // received a different brief (ADR 028).
    const memoryBriefFor = (agent: Agent, tools: ToolAccess | null, session: RuntimeSession | undefined) =>
      Option.isNone(memoryStore)
        ? Effect.succeed<TurnMemoryBrief | null>(null)
        : turnMemoryBrief(memoryStore.value, memoryProjects, agent.id, tools?.folders ?? [], session?.memoryBrief);
    // The other hobs on the hub (ADR 032), sent when the session is new or last received a different roster.
    const rosterFor = (
      agent: Agent,
      tools: ToolAccess | null,
      session: RuntimeSession | undefined,
      adapter: RuntimeAdapterShape,
    ) =>
      turnRoster({
        agentId: agent.id,
        access: tools,
        redactor,
        received: session?.roster,
        resumed: session !== undefined,
        keepsTools: adapter.resumeKeepsHubTools === true,
      });
    // Without a skills library, turns have no skills (ADR 029).
    const skillMounts = yield* skillMounter;
    // The skills recorded with a message of yours when it was accepted (ADR 029), so a queued message
    // keeps them through a rollout. Read with the folders the hob works in now.
    const acceptedSkills = (agent: Agent) =>
      skillMounts.enabled
        ? Effect.flatMap(hobTools.access(agent), (access) =>
            skillMounts.resolve({ agentId: agent.id, policy: agent.policy, folders: access?.folders ?? [] }),
          )
        : Effect.succeed(null);
    // A chat that tries a draft records no library skill with a message, and `/` names the draft
    // (ADR 029, Try in a chat).
    const acceptedIn = (thread: Thread, agent: Agent) =>
      thread.skillTrial === null ? acceptedSkills(agent) : Effect.succeed<Message["skills"]>([]);
    // A turn's skills: those its message was accepted with, or, for a continuation or a message
    // from before, the hob's as the turn starts. The reply records them, and the runtime gets their mounts.
    // A chat that tries a draft loads the draft alone, and records no library skill (ADR 029, Try in a chat).
    const skillsFor = (
      agent: Agent,
      config: AgentConfiguration,
      tools: ToolAccess | null,
      thread: Thread,
      yours?: Message,
    ) =>
      Effect.gen(function* () {
        const trial = thread.skillTrial;
        if (trial !== null) return { recorded: [], mounts: yield* skillMounts.draft(trial), trial };
        const recorded =
          yours?.skills ??
          (yield* skillMounts.resolve({ agentId: agent.id, policy: config.policy, folders: tools?.folders ?? [] }));
        return { recorded, mounts: yield* skillMounts.mounts(recorded), trial };
      });
    // Claude Code keeps a resumed session's first instructions, so a turn whose session may follow
    // others carries them. Which a session follows is not stored: a stopped or failed turn may or may
    // not have delivered its own, and threads from before #164 never received theirs. So a thread
    // whose replies all ran on the current instructions needs nothing, and any other carries them.
    // Only the hob's own replies count, since only they ran in its session (ADR 039).
    const instructionsChanged = (thread: Thread, runtime: RuntimeKind, agent: Agent, instructions: string) =>
      Effect.gen(function* () {
        if (liveSession(thread, runtime, agent.id) === undefined) return false;
        const versions = new Set(
          (yield* repo.listMessages(thread.id)).flatMap((m) =>
            m.role === "assistant" && m.configVersion !== null && isHobsOwn(m, agent.id) ? [m.configVersion] : [],
          ),
        );
        for (const version of versions) {
          const config = yield* repo.findAgentConfig(agent.id, version);
          if (Option.isNone(config) || systemInstructions(config.value.name, config.value) !== instructions)
            return true;
        }
        return false;
      });

    // What a resumed session missed, told ahead of the prompt (ADR 017), built from the stored
    // transcript without asking the brain the thread left. `before` is the live chapter's transcript
    // before the turn's own prompt and reply. `switched` when the reply itself moves from another
    // brain, as on Continue. A new session starts from the context pack instead (ADR 037), so this
    // is null for one. When others spoke since the hob last did, it hears what they said, each
    // under its author's name, within the live chapter's share, and why it answers now when another
    // actor asked it (ADR 039, The context pack with several hobs). Otherwise it hears what its own
    // hob wrote on other brains.
    const brief = (
      thread: Thread,
      runtime: RuntimeKind,
      agentId: AgentId,
      before: ReadonlyArray<Message>,
      switched: boolean,
      people: PackPeople,
      reason: TurnReason | null,
    ) =>
      Effect.sync(() => {
        const session = liveSession(thread, runtime, agentId);
        if (session === undefined) return null;
        const missed = missedBy(thread, runtime, agentId, session.seenThrough, before);
        // The only hob in a thread knows why it answers from its pack: a reason says something only
        // when another actor asked it.
        const why =
          reason === null || reason.cause === "only-hob"
            ? null
            : `Why you are answering now: ${reasonLine(reason, people.nameOf)}`;
        if (missedOthers(thread, agentId, missed)) {
          return [why, sinceYouSpoke(missed, people.speaker)].filter((part) => part !== null).join("\n\n") || null;
        }
        // Only a switch needs one: a session is told what other brains wrote that it did not see.
        const others = missed.some((m) => m.role === "assistant" && m.runtime !== null && m.runtime !== runtime);
        const switchedText =
          switched || others
            ? (buildBriefing({ kind: "resumed", messages: missed, checkpoint: null })?.text ?? null)
            : null;
        return [why, switchedText].filter((part) => part !== null).join("\n\n") || null;
      });

    return { memoryBriefFor, rosterFor, acceptedIn, skillsFor, instructionsChanged, brief } as const;
  });
