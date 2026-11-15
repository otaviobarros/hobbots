import {
  AgentNotFound,
  HobUnavailable,
  type InvalidHob,
  MessageNotQueued,
  ReplyNotResumable,
  type StartFreshRefused,
  ChannelArchived,
  type ChannelArchiveRefused,
  type ChannelKeyReused,
  type ChannelNotCamp,
  ChannelNotFound,
  TurnsAtLimit,
} from "@hobbots/api";
import {
  type Agent,
  type AgentId,
  type Brain,
  type ChapterId,
  type ChapterMove,
  type ChapterNotFound,
  type ChapterRefused,
  type Committed,
  DEFAULT_CHANNEL_TITLE,
  hobReads,
  hobStanding,
  type IllegalChapterTransition,
  isResumable,
  type MentionRefused,
  Message,
  MessageId,
  MessageTransitions,
  mainLine,
  openChannelTask,
  type PackReport,
  replyHobOf,
  type SkillMention,
  type SkillTrial,
  type StartedFresh,
  Channel,
  ChannelId,
  ChannelLifecycle,
  type ChannelMember,
  type ChannelRunStatus,
  type TurnRequest,
  type TurnRequestId,
  TurnRequests,
  takesNewWork,
  type UnreadChannels,
  waitedSteps,
} from "@hobbots/domain";
import { Context, DateTime, Deferred, Effect, Layer, Option, Ref, Semaphore } from "effect";
import { HobAdmission, withChannelLock } from "./admission.ts";
import { type CampRequest, type MoveRequest, makeCampCommands } from "./camp-commands.ts";
import { buildPack, type Pack } from "./context-pack.ts";
import { Continuations } from "./continuations.ts";
import { makeMentionNotes } from "./mention-notes.ts";
import { makePackPeople } from "./pack-people.ts";
import { EventPublisher } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";
import { makeRedactor, SecretRedaction } from "./secrets.ts";
import { mentionedSkill, namedSkills } from "./skill-turn.ts";
import { speakerIn } from "./speaker.ts";
import { uncertainCalls } from "./steps.ts";
import { TaskTurns } from "./task-turns.ts";
import { TaskRepository } from "./tasks.ts";
import { makeChannelCommands } from "./channel-commands.ts";
import { isBusy } from "./channel-run.ts";
import { brainFor, makeChannelRunner } from "./channel-runner.ts";
import { HobTools } from "./tools.ts";
import { makeTurnGrants } from "./turn-grants.ts";
import { makeTurnInputs } from "./turn-inputs.ts";
import { makePackSources, PackReports } from "./turn-pack.ts";
import { sessionActor } from "./users.ts";

/**
 * The skill a message asks for: the one you picked with `/`, or one its text names. A skill of a set
 * picked by its name alone is recorded with its set, when that names one.
 */
const pickedSkill = (
  content: string,
  askedSkill: SkillMention | null,
  named: Parameters<typeof mentionedSkill>[1],
): SkillMention | null =>
  askedSkill === null ? mentionedSkill(content, named) : (mentionedSkill(`/${askedSkill}`, named) ?? askedSkill);

/** How much of a cut-off reply the runtime is shown when asked to continue it. */
const CONTINUE_CONTEXT = 4_000;

/**
 * The prompt that resumes a reply that ended early, so the runtime picks up where it left off. Tool
 * calls the reply left uncertain are named, so none is run again before it is checked (EX-004).
 */
const continuePrompt = (reply: Message) => {
  const uncertain = uncertainCalls(reply.steps);
  return [
    "Your previous reply was cut off before it finished. It ends with this text:",
    "",
    reply.content.slice(-CONTINUE_CONTEXT),
    "",
    ...(uncertain === null ? [] : [uncertain, ""]),
    "Continue from exactly where it stops. Do not repeat what is already written.",
  ].join("\n");
};

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export class ChatService extends Context.Service<
  ChatService,
  {
    /**
     * Starts a new channel for the hob. With `skillTrial`, the channel tries that draft (ADR 029, Try in a
     * chat): every turn of it loads the draft and no other skill, under `title`.
     */
    readonly createChannel: (
      agentId: AgentId,
      options?: { readonly title?: string; readonly skillTrial?: SkillTrial },
    ) => Effect.Effect<Channel, AgentNotFound | HobUnavailable>;
    /** Starts a turn, or queues the message while the channel's reply runs (assistantMessage is then null). */
    readonly sendPrompt: (
      channelId: ChannelId,
      content: string,
      /** The skill you picked for the message with `/` (ADR 029, Explicit use), if any. */
      askedSkill?: SkillMention | null,
    ) => Effect.Effect<
      { userMessage: Message; assistantMessage: Message | null },
      ChannelNotFound | HobUnavailable | ChannelArchived | MentionRefused
    >;
    readonly removeQueued: (
      channelId: ChannelId,
      messageId: MessageId,
    ) => Effect.Effect<void, ChannelNotFound | MessageNotQueued>;
    /** Stops the channel's running reply, if any, and starts this queued message once the turn has ended. */
    readonly sendNow: (
      channelId: ChannelId,
      messageId: MessageId,
    ) => Effect.Effect<void, ChannelNotFound | MessageNotQueued>;
    /**
     * Asks the channel's current turn to stop and returns once the request is recorded: the reply shows
     * as stopping, then as stopped when the runtime confirms the turn ended. Asking again, or with no
     * turn in progress, changes nothing. Given a hob, stops the turn only while that hob speaks.
     */
    readonly stop: (channelId: ChannelId, speaker?: AgentId) => Effect.Effect<void, ChannelNotFound>;
    /**
     * Stop all (ADR 039, One hob speaks at a time): stops the turn speaking in the channel and drops
     * every request still owed there, each recording who stopped it. Work in the backpack is never
     * dropped.
     */
    readonly stopAll: (channelId: ChannelId) => Effect.Effect<void, ChannelNotFound>;
    /**
     * Let them go on (ADR 039, Hobs talking to hobs): the hobs the relay budget paused in the
     * channel go on, for the budget's turns again, the resumed turn first. A person's message there
     * drops what was paused instead. With nothing paused, it changes nothing.
     */
    readonly letHobsGoOn: (channelId: ChannelId) => Effect.Effect<void, ChannelNotFound>;
    /**
     * Stop waiting (#1056): once the hob has answered and its reply only waits on commands it started,
     * ends the reply now. The reply shows as stopping, then completes with its text, and each command
     * it waited on is stopped. With no reply waiting, it changes nothing.
     */
    readonly stopWaiting: (channelId: ChannelId) => Effect.Effect<void, ChannelNotFound>;
    /**
     * Continue: resumes a reply that was cut off or ended by the provider's limit, in place. Only the
     * channel's latest message can be continued, while its hob is active and no other turn runs.
     */
    readonly continueReply: (
      channelId: ChannelId,
      messageId: MessageId,
    ) => Effect.Effect<Message, ChannelNotFound | HobUnavailable | ReplyNotResumable | ChannelArchived | TurnsAtLimit>;
    /** Stops every turn the hob has in progress and waits until each has ended (stopped if the user had asked, otherwise interrupted). */
    readonly interruptAgent: (agentId: AgentId) => Effect.Effect<void>;
    /**
     * Stops, and waits for, every running turn of the hob (or of every hob) whose tools the current
     * policy narrows: a folder removed, the tools taken away, or an operation's answer narrowed
     * (PE-008). Call it once a change to the policy is saved.
     */
    readonly reviewAuthority: (agentId?: AgentId) => Effect.Effect<void>;
    /**
     * Switches the channel to its own brain, or back to the hob's with null (ADR 017), from its next
     * turn. A brain the same as the hob's follows the hob. Refused for a retired hob, a runtime the
     * hub cannot run, or a model or effort the runtime does not offer.
     */
    readonly setBrain: (
      channelId: ChannelId,
      brain: Brain | null,
    ) => Effect.Effect<Channel, ChannelNotFound | HobUnavailable | InvalidHob | ChannelArchived>;
    /**
     * Refuses a brain switch the channel cannot take now: its hob retired or the channel archived.
     * Reads without the hob's lock: call it while holding the lock (`HobService.updateThen`).
     */
    readonly checkBrainSwitch: (
      channelId: ChannelId,
    ) => Effect.Effect<void, ChannelNotFound | HobUnavailable | ChannelArchived>;
    /**
     * Clears the channel's own brain, so it follows its hob again. Takes no hob lock: call it while
     * holding the lock, after `checkBrainSwitch`.
     */
    readonly followHob: (channelId: ChannelId) => Effect.Effect<Channel, ChannelNotFound>;
    /**
     * Archives the channel, which then takes no new messages until it is restored. Refused while a
     * reply runs or waits in its queue, while an approval waits, or when its hob is retired.
     * Archiving an archived channel returns it unchanged.
     */
    readonly archive: (channelId: ChannelId) => Effect.Effect<Channel, ChannelNotFound | ChannelArchiveRefused>;
    /** Renames the channel. Refused while it is archived. */
    readonly rename: (channelId: ChannelId, title: string) => Effect.Effect<Channel, ChannelNotFound | ChannelArchived>;
    /** Pins the channel to the top of its hob's chats, or unpins it. Refused while it is archived. */
    readonly setPinned: (channelId: ChannelId, pinned: boolean) => Effect.Effect<Channel, ChannelNotFound | ChannelArchived>;
    /**
     * Makes a camp private, or public again (ADR 037): from then on, memory capture takes nothing it
     * writes while private, and what it captured before stays. Refused for a chat and while archived.
     */
    readonly setPrivate: (
      channelId: ChannelId,
      value: boolean,
    ) => Effect.Effect<Channel, ChannelNotFound | ChannelArchived | ChannelNotCamp>;
    /**
     * Records that the person asking read the channel through `messageId`, as they saw it at
     * `revision` (ADR 027), so its unread dot clears on every device of theirs: their member row,
     * with its marker moved (ADR 039). The marker only moves forward: a message they had read past,
     * or one from another channel, returns null. An archived channel takes it too.
     */
    readonly markRead: (
      channelId: ChannelId,
      messageId: MessageId,
      revision: number,
    ) => Effect.Effect<ChannelMember | null, ChannelNotFound>;
    /** The channels where a hob wrote since the person asking last read them (ADR 039). */
    readonly unreadChannels: Effect.Effect<UnreadChannels>;
    /** Restores an archived channel, unless its hob is retired. Restoring a live channel returns it unchanged. */
    readonly restore: (channelId: ChannelId) => Effect.Effect<Channel, ChannelNotFound | ChannelArchiveRefused>;
    /**
     * Makes a camp for the hob, with a title, a goal and whether it is private (ADR 037), and the other
     * hobs it is made with, which join as members (ADR 039); the hob leads its quests. Its key
     * becomes the camp's id: the same camp asked for again is returned unchanged, and a key that
     * names another channel is refused. Refused for a hob that takes no new work.
     */
    readonly makeCamp: (
      agentId: AgentId,
      request: CampRequest,
    ) => Effect.Effect<Channel, AgentNotFound | HobUnavailable | ChannelKeyReused>;
    /**
     * Starts the hob's chat fresh (ADR 037): the chat is superseded and a new one opens under `key`,
     * with what the old one still owed moved into it. Refused for a channel that is not its hob's open
     * chat, and for what stops an archive. The same request sent again returns what it did.
     */
    readonly startFresh: (
      channelId: ChannelId,
      key: ChannelId,
    ) => Effect.Effect<StartedFresh, ChannelNotFound | StartFreshRefused | ChannelKeyReused>;
    /**
     * Moves a chapter into a camp (ADR 037, #1385): an open camp of the hob's, or a new one made from
     * it under `key`, whose origin is the channel and chapter. Its messages, decisions, artifacts and
     * the quests started in it go along, and the channel keeps a stub. Refused while a reply runs or
     * an approval waits in either channel. The same move asked again returns what it did.
     */
    readonly moveChapter: (
      channelId: ChannelId,
      chapterId: ChapterId,
      request: MoveRequest,
    ) => Effect.Effect<
      ChapterMove,
      | ChannelNotFound
      | AgentNotFound
      | HobUnavailable
      | ChannelKeyReused
      | ChapterRefused
      | ChapterNotFound
      | IllegalChapterTransition
    >;
    /**
     * The context pack the channel's next new session would start from, and the report of the pack
     * its last such turn read, if the hub kept one (ADR 037, #1380). The dev-only endpoint shows both.
     */
    readonly contextPack: (
      channelId: ChannelId,
    ) => Effect.Effect<{ readonly next: Pack; readonly lastTurn: PackReport | null }, ChannelNotFound>;
    /** Starts the hob's queued messages and the work waiting in its backpack, in channels with no turn running, as when it wakes. */
    readonly drainAgent: (agentId: AgentId) => Effect.Effect<void>;
    /**
     * Starts what waits in the channel, if no turn runs there: your queued message first, with any
     * backpack work riding along, else a continuation for that work (ADR 019). Called when work
     * arrives for the channel's hob.
     */
    readonly wake: (channelId: ChannelId) => Effect.Effect<void>;
    /**
     * Wakes the channel even when you stopped its work there, as when you retry that work's blocker:
     * your choice starts it again without a message of yours.
     */
    readonly resume: (channelId: ChannelId) => Effect.Effect<void>;
    /**
     * Channels with a turn in progress in this process, until its runtime has exited. Each change is
     * announced as the transient `TurnStarted` or `TurnEnded`, published once it has happened.
     */
    readonly activeChannels: Effect.Effect<ReadonlyArray<ChannelId>>;
    /**
     * The hob of each turn in progress, by channel, from its `TurnStarted` until its `TurnEnded`: in a
     * camp, the hob speaking, which need not be the hob the camp belongs to (ADR 039).
     */
    readonly activeTurns: Effect.Effect<ReadonlyArray<{ readonly channelId: ChannelId; readonly agentId: AgentId }>>;
    /**
     * Every line whose run is not idle or has hobs waiting for its floor, as `ChannelRunChanged`
     * publishes it, and the revision of the last transition of any run: a line left out is idle with
     * nobody waiting as of that revision (ADR 037, ADR 039).
     */
    readonly channelRuns: Effect.Effect<{ readonly revision: number; readonly runs: ReadonlyArray<ChannelRunStatus> }>;
    /** The replies still streaming or stopping, with all the text held in memory so far. */
    readonly streamingReplies: Effect.Effect<ReadonlyArray<Message>>;
  }
>()("@hobbots/agents/ChatService") {
  static readonly layer = Layer.effect(
    ChatService,
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const bus = yield* EventPublisher;
      const admission = yield* HobAdmission;
      const hobTools = yield* HobTools;
      // Without the hub's redactor, secret shapes are still redacted.
      const redactor = Option.getOrElse(yield* Effect.serviceOption(SecretRedaction), () => makeRedactor());
      // Without Task work, turns offer no Task tools and hobs run no steps.
      const taskTurns = yield* Effect.serviceOption(TaskTurns);
      const taskRecords = yield* Effect.serviceOption(TaskRepository);
      const inputs = yield* makeTurnInputs(repo, hobTools, redactor);
      const { acceptedIn } = inputs;
      // Without a backpack, a channel starts only your queued messages.
      const continuations = yield* Effect.serviceOption(Continuations);
      // After a restore nothing that waited starts on its own until you resume work (ADR 026).
      const scope = yield* Effect.scope;
      const findChannel = (channelId: ChannelId) =>
        repo.findChannel(channelId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new ChannelNotFound({ channelId })),
              onSome: Effect.succeed,
            }),
          ),
        );

      // Only an active hob takes new work; a paused or retired hob's channels stay readable, and so do
      // those of a hob finishing its open Tasks before it retires.
      const requireActive = (agent: Agent) =>
        takesNewWork(agent)
          ? Effect.void
          : Effect.fail(new HobUnavailable({ agentId: agent.id, status: hobStanding(agent) }));

      // A hob that is awake: it may go on with work it already has, even while it finishes its open
      // Tasks before it retires (#408); `requireActive` also turns away new work.
      const requireAwake = (agent: Agent) =>
        agent.status === "active"
          ? Effect.void
          : Effect.fail(new HobUnavailable({ agentId: agent.id, status: hobStanding(agent) }));

      // A hob finishing its open Tasks before it retires takes messages only in a channel where one
      // of them is open, since they go on with it; anywhere else a message would be new work (#408).
      const requireOpenTaskWhileRetiring = (agent: Agent, channelId: ChannelId) =>
        Effect.gen(function* () {
          if (agent.retiring === null || agent.status === "retired") return;
          const trees = Option.isSome(taskRecords) ? yield* taskRecords.value.readChannelTrees(channelId) : [];
          if (openChannelTask(trees, agent.id) === undefined) {
            return yield* new HobUnavailable({ agentId: agent.id, status: "retiring" });
          }
        });

      // An archived channel is read-only until it is restored.
      const requireLive = (channel: Channel) =>
        channel.archivedAt === null
          ? Effect.void
          : Effect.fail(new ChannelArchived({ channelId: channel.id, archivedAt: channel.archivedAt }));

      // Writes journal their events in the same transaction (ADR 013); the bus announces them once
      // committed. Each returns what it stored, with its revision.
      const announce = <A>(committed: Committed<A>) => Effect.as(bus.publish(committed.entries), committed.value);
      const saveChannel = (channel: Channel) => repo.upsertChannel(channel).pipe(Effect.flatMap(announce));
      const saveMessage = (message: Message) => repo.upsertMessage(message).pipe(Effect.flatMap(announce));
      // Changes the channel as it is stored now, one change at a time, so a turn recording its session
      // and a brain switch never overwrite each other. `change` returns null to leave it as it is.
      const channelWrites = yield* Semaphore.make(1);
      const changeChannel = (channelId: ChannelId, change: (channel: Channel) => Channel | null) =>
        Semaphore.withPermit(
          channelWrites,
          Effect.gen(function* () {
            const stored = yield* repo.findChannel(channelId);
            if (Option.isNone(stored)) return stored;
            const next = change(stored.value);
            return Option.some(next === null ? stored.value : yield* saveChannel(next));
          }),
        );

      // A previous process may have died mid-turn; those turns cannot resume. A reply the user had
      // asked to stop is stopped; any other is interrupted. Its interrupted reply answers the request
      // it spoke for, which Continue resumes, so the floor does not start it again.
      for (const message of yield* repo.listUnfinishedMessages) {
        const next = MessageTransitions.interrupt(message);
        if (next instanceof Message) yield* saveMessage(next);
      }
      yield* announce(yield* repo.answerUnfinishedTurnRequests);

      // A queued message's start and removal write, then announce the change once it is committed (CH-008).
      const saveStarted = (message: Message, reply: Message, speaking: ReadonlyArray<TurnRequestId>) =>
        repo.startQueuedMessage(message, reply, speaking).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(null),
              onSome: (committed) => announce(committed).pipe(Effect.map((saved) => saved.reply)),
            }),
          ),
        );
      // A turn's reply, saved with the requests it answers taking the floor (ADR 039).
      const saveSpeaking = (reply: Message, speaking: ReadonlyArray<TurnRequestId>) =>
        repo
          .startReply(reply, speaking)
          .pipe(
            Effect.flatMap(
              Option.match({ onNone: () => Effect.succeed(null), onSome: (committed) => announce(committed) }),
            ),
          );
      const saveRemoved = (channelId: ChannelId, messageId: MessageId) =>
        repo.removeQueuedMessage(channelId, messageId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(false),
              onSome: (committed) => Effect.as(announce(committed), true),
            }),
          ),
        );

      // Reads the hob under its lock, so a pause or retirement cannot slip in before `body` ends.
      const withHob = <A, E, R>(agentId: AgentId, body: (agent: Agent) => Effect.Effect<A, E, R>) =>
        admission.withHob(
          agentId,
          Effect.gen(function* () {
            const agent = yield* repo.findAgent(agentId);
            if (Option.isNone(agent)) return yield* new AgentNotFound({ agentId });
            return yield* body(agent.value);
          }),
        );

      // Status is read under the hob's lock, so a pause or retirement cannot slip in before the channel is saved.
      const createChannel = Effect.fn("ChatService.createChannel")(function* (
        agentId: AgentId,
        options: { readonly title?: string; readonly skillTrial?: SkillTrial } = {},
      ) {
        return yield* withHob(agentId, (agent) =>
          Effect.gen(function* () {
            yield* requireActive(agent);
            const now = yield* nowIso;
            // The hob's first open channel is its chat (ADR 037); a skill trial is always a camp.
            const hasChat = (yield* repo.listChannels(agentId)).some(ChannelLifecycle.isOpenChat);
            const channel = new Channel({
              id: ChannelId.make(crypto.randomUUID()),
              agentId,
              title: options.title ?? DEFAULT_CHANNEL_TITLE,
              kind: hasChat || options.skillTrial !== undefined ? "camp" : "direct",
              skillTrial: options.skillTrial ?? null,
              createdAt: now,
              updatedAt: now,
            });
            return yield* saveChannel(channel);
          }),
        );
      });

      const grants = yield* makeTurnGrants(repo, hobTools);
      const mentions = yield* makeMentionNotes;
      const {
        runOf,
        step,
        transition,
        launch,
        slotFor,
        advance,
        sendsAtOnce,
        lineUp,
        drainChannels,
        endTurn,
        stopHob,
        holdDispatch,
        hobsOf,
        activeChannels,
        activeTurns,
        channelRuns,
        streamingReplies,
      } = yield* makeChannelRunner({
        redactor,
        grants,
        inputs,
        saveMessage,
        announce,
        changeChannel,
        saveStarted,
        saveSpeaking,
      });

      // Reads the channel and its hob again under the hob's lock, so neither changes before `body` ends.
      const withChannelHob = <A, E, R>(
        channelId: ChannelId,
        body: (channel: Channel, agent: Agent) => Effect.Effect<A, E, R>,
      ) =>
        Effect.gen(function* () {
          return yield* withChannelLock(
            admission,
            yield* findChannel(channelId),
            Effect.gen(function* () {
              const channel = yield* findChannel(channelId);
              // standards-allow STD-ARCH-021: the hob the channel belongs to, its default answerer
              const agent = yield* repo.findAgent(channel.agentId).pipe(Effect.map(Option.getOrThrow));
              return yield* body(channel, agent);
            }),
          );
        });

      // Drops what `pick` chooses among the line's requests still owed, as the person stopping.
      const dropOwed = (channelId: ChannelId, pick: (open: ReadonlyArray<TurnRequest>) => ReadonlyArray<TurnRequest>) =>
        Effect.gen(function* () {
          const dropping = pick(yield* repo.openTurnRequests(mainLine(channelId)));
          if (dropping.length === 0) return;
          const by = yield* sessionActor;
          yield* repo
            .dropTurnRequests(
              dropping.map((request) => request.id),
              by,
            )
            .pipe(Effect.flatMap(announce));
          yield* lineUp(channelId);
        });

      /** Your message as stored in the channel, `queued` while it waits for its turn. */
      const yourMessage = (
        channel: Channel,
        agent: Agent,
        content: string,
        askedSkill: SkillMention | null,
        queued: boolean,
      ) =>
        Effect.gen(function* () {
          const accepted = yield* acceptedIn(channel, agent);
          const named = namedSkills(accepted, channel.skillTrial);
          return new Message({
            id: MessageId.make(crypto.randomUUID()),
            channelId: channel.id,
            actor: yield* sessionActor,
            role: "user",
            content,
            status: queued ? "queued" : "complete",
            error: null,
            configVersion: null,
            skills: accepted,
            askedSkill: pickedSkill(content, askedSkill, named),
            createdAt: yield* nowIso,
          });
        });

      const sendPrompt = Effect.fn("ChatService.sendPrompt")(function* (
        channelId: ChannelId,
        content: string,
        askedSkill: SkillMention | null = null,
      ) {
        // The status check and the turn's registration happen under the hob's lock, so a turn is
        // either admitted before a retirement (which then sees and stops it) or refused after it.
        return yield* withChannelHob(channelId, (channel, agent) =>
          Effect.gen(function* () {
            // A retired hob takes nothing; a paused one keeps messages queued until it wakes.
            if (agent.status === "retired") yield* requireActive(agent);
            yield* requireOpenTaskWhileRetiring(agent, channelId);
            yield* requireLive(channel);
            // A message that @mentions a member of a quest here goes to that member, and the lead
            // reads it in the chat on its next turn without being woken for it (#1446).
            const mentioned = yield* mentions.targets(channelId, content);
            if (mentioned.length > 0) {
              const sent = yield* mentions.send(
                yield* yourMessage(channel, agent, content, askedSkill, false),
                mentioned,
              );
              // Another hob it mentions answers here, when the floor is its, and work you stopped
              // here may start again with that answer, as with any message you send.
              if (sent.requests.length > 0) {
                yield* step(channelId, { _tag: "Release" });
                yield* advance(channelId, null, sent.message.id);
                // Your message dropped what the relay budget paused there, so the line says so.
              } else yield* lineUp(channelId);
              return { userMessage: sent.message, assistantMessage: null };
            }
            // A message waits while its hob is paused, while a reply runs, behind any request ahead
            // of it, and while work of its hob goes first, so the channel's messages start in the
            // order they were sent (CH-008, ADR 039). It is stored and shown at once either way. One
            // that would start now waits, queued, while its turn has no slot (#1448).
            const by = yield* sessionActor;
            const atOnce = yield* sendsAtOnce(channelId, agent.id, by, yield* nowIso);
            const slot = atOnce ? yield* slotFor(channel, agent) : null;
            const free = slot?.release ?? Effect.void;
            const userMessage = yield* yourMessage(channel, agent, content, askedSkill, slot === null);
            // Who answers is decided in the transaction that stores the message (ADR 039, Who
            // answers), from the mentions the hub parses in its text: a mention of a hob that cannot
            // hear it refuses the message, and nothing is stored.
            // Each hob that owes it an answer gets a `TurnRequest`, written with it.
            const sent = yield* repo
              .sendMessage(userMessage, { mentions: [], repliesTo: null })
              .pipe(Effect.onError(() => free));
            const saved = yield* announce(sent).pipe(
              Effect.map((value) => value.message),
              Effect.onError(() => free),
            );
            if (sent.value.requests.length === 0) {
              yield* free;
              // Your message dropped what the relay budget paused there, so the line says so.
              yield* lineUp(channelId);
              return { userMessage: saved, assistantMessage: null };
            }
            // Work you stopped in this channel may start again once this message is answered.
            yield* step(channelId, { _tag: "Release" });
            // The floor goes on from here as from anywhere else: the first hob the message is owed
            // by takes it at once, in the slot taken for it when it is the channel's own hob.
            const begun = yield* advance(channelId, slot === null ? null : { hobId: agent.id, slot }, saved.id);
            return { userMessage: saved, assistantMessage: begun?.request.messageId === saved.id ? begun.saved : null };
          }),
        );
      });

      const removeQueued = Effect.fn("ChatService.removeQueued")(function* (channelId: ChannelId, messageId: MessageId) {
        yield* withChannelLock(
          admission,
          yield* findChannel(channelId),
          Effect.gen(function* () {
            if (!(yield* saveRemoved(channelId, messageId))) return yield* new MessageNotQueued({ messageId });
            yield* step(channelId, { _tag: "Unchoose", messageId });
            // An idle floor that waited on the removed message's hob goes to the next one waiting,
            // which may have a slot of its own (ADR 039).
            yield* advance(channelId);
          }),
        );
      });

      // The choice is held in memory: after a restart the queue simply keeps its order.
      const sendNow = Effect.fn("ChatService.sendNow")(function* (channelId: ChannelId, messageId: MessageId) {
        yield* withChannelLock(
          admission,
          yield* findChannel(channelId),
          Effect.gen(function* () {
            const messages = yield* repo.listMessages(channelId);
            if (!messages.some((m) => m.id === messageId && m.status === "queued")) {
              return yield* new MessageNotQueued({ messageId });
            }
            yield* step(channelId, { _tag: "Choose", messageId });
            // The chosen message starts in the drain once the stopped turn has ended.
            if (isBusy(yield* runOf(channelId))) yield* stop(channelId);
            else yield* advance(channelId);
          }),
        );
      });

      /** The reply of the turn running in the channel, if any; fails when there is no such channel. */
      const runningReply = (channelId: ChannelId) =>
        findChannel(channelId).pipe(
          Effect.andThen(runOf(channelId)),
          Effect.map((run) => run.reply),
        );

      const stop = Effect.fn("ChatService.stop")(function* (channelId: ChannelId, speaker?: AgentId) {
        yield* findChannel(channelId);
        const run = yield* runOf(channelId);
        const reply = run.reply;
        if (reply === null || (speaker !== undefined && run.speaking !== speaker)) return;
        // Only the first request moves the reply to stopping and interrupts the turn.
        const requested = yield* transition(
          reply,
          (m) => (m.status === "streaming" ? MessageTransitions.requestStop(m) : undefined),
          saveMessage,
        );
        // Work the turn carried waits for you instead of starting again on its own.
        // The hob held is the one this reply's run named, read before the stop: by now its turn may
        // have ended, or another started. A run with a reply always names its speaker.
        if (Option.isSome(requested) && reply.carries && run.speaking !== null) {
          yield* step(channelId, { _tag: "Hold", hobId: run.speaking });
        }
        if (Option.isNone(requested)) return;
        // The turn's request, and those its mentions caused, are dropped with it; a person's stay.
        // Only this reply's: a turn that started since keeps its own.
        yield* dropOwed(channelId, (open) =>
          TurnRequests.speaking(open)?.replyId === requested.value.id ? TurnRequests.stopping(open) : [],
        );
        // The turn records the confirmed outcome itself once the runtime has stopped.
        yield* Effect.forkIn(
          runOf(channelId).pipe(Effect.flatMap((run) => (run.reply === reply ? endTurn(channelId) : Effect.void))),
          scope,
        );
      });

      // Stop all (ADR 039): stops the turn that is speaking and drops every request still owed in
      // the line, each recording who stopped it. A queued message left with nothing owed stays said.
      // What is owed is dropped first, so the stopped turn's end finds nothing to start next. Both run
      // under the channel's lock, which every turn is admitted under, so a turn admitted meanwhile is
      // either running for the stop to reach, or never takes its dropped request. Work a dispatch is
      // putting through before its turn launched is held, so that turn never starts. A turn that
      // answers no request, as a carried backpack's, can complete between the drop and the stop, and
      // the relays its reply wrote then are dropped after the stop: once the stop is saved, it writes none.
      const stopAll = Effect.fn("ChatService.stopAll")(function* (channelId: ChannelId) {
        yield* withChannelLock(
          admission,
          yield* findChannel(channelId),
          Effect.gen(function* () {
            const reply = yield* runningReply(channelId);
            const running = reply === null ? null : (yield* Ref.get(reply.current)).id;
            yield* dropOwed(channelId, TurnRequests.stoppingAll);
            yield* stop(channelId);
            if (running !== null) {
              yield* dropOwed(channelId, (open) => open.filter((request) => request.messageId === running));
            }
            yield* holdDispatch(channelId);
          }),
        );
      });

      // Let them go on (ADR 039): the paused requests wait again, journaled as one reset of the relay
      // budget, and the floor moves on to the first of them, under the channel's lock as any start is.
      const letHobsGoOn = Effect.fn("ChatService.letHobsGoOn")(function* (channelId: ChannelId) {
        yield* withChannelLock(
          admission,
          yield* findChannel(channelId),
          Effect.gen(function* () {
            const woken = yield* repo
              .letHobsGoOn(mainLine(channelId), yield* sessionActor)
              .pipe(Effect.flatMap(announce));
            if (woken.length > 0) yield* advance(channelId);
          }),
        );
      });

      // Stop waiting (#1056): only a reply waiting on commands ends this way; it shows as stopping until
      // the runtime has ended, then completes in the turn itself.
      const stopWaiting = Effect.fn("ChatService.stopWaiting")(function* (channelId: ChannelId) {
        const reply = yield* runningReply(channelId);
        if (reply === null) return;
        const requested = yield* transition(
          reply,
          (m) =>
            m.status === "streaming" && waitedSteps(m.steps).length > 0 ? MessageTransitions.requestStop(m) : undefined,
          saveMessage,
        );
        if (Option.isSome(requested)) yield* Deferred.succeed(reply.endWait, undefined);
      });

      // The reply streams again with the configuration the hob has now, like any new turn.
      const continueReply = Effect.fn("ChatService.continueReply")(function* (
        channelId: ChannelId,
        messageId: MessageId,
      ) {
        return yield* withChannelHob(channelId, (channel, own) =>
          Effect.gen(function* () {
            // A note to self written since does not stand in the way: the hob never reads it.
            const transcript = (yield* repo.listMessages(channelId)).filter((m) => m.status !== "queued" && hobReads(m));
            const message = transcript.at(-1);
            // The hob that wrote the reply goes on with it, in a camp it joined too.
            const writer = message === undefined ? null : replyHobOf(message, channel);
            const author = writer !== null && writer !== own.id ? yield* repo.findAgent(writer) : Option.some(own);
            if (Option.isNone(author)) return yield* new ReplyNotResumable({ messageId });
            const agent = author.value;
            // Only a hob of the camp goes on: a reply moved here from another camp is not its to
            // continue unless it joined this one too (ADR 039).
            if (!(yield* hobsOf(channel)).includes(agent.id)) return yield* new ReplyNotResumable({ messageId });
            // Continuing a reply goes on with work the hob has; while it retires, only that of an open Task.
            yield* requireAwake(agent);
            yield* requireOpenTaskWhileRetiring(agent, channelId);
            yield* requireLive(channel);
            if (isBusy(yield* runOf(channelId)) || message?.id !== messageId || !isResumable(message.status)) {
              return yield* new ReplyNotResumable({ messageId });
            }
            const resumed = MessageTransitions.resume(message);
            if (!(resumed instanceof Message)) return yield* new ReplyNotResumable({ messageId });
            // Continue has no queue to wait in: with no free slot it is refused, and asked again later.
            const slot = yield* slotFor(channel, agent);
            if (slot === null) return yield* new TurnsAtLimit({ channelId });
            const config = yield* repo
              .findAgentConfig(agent.id, agent.configVersion)
              .pipe(Effect.map(Option.getOrThrow));
            // The reply is now the brain's that continues it.
            const brain = brainFor(channel, config);
            const saved = yield* saveMessage(
              new Message({ ...resumed, configVersion: config.version, runtime: brain.runtime, model: brain.model }),
            ).pipe(Effect.onError(() => slot.release));
            yield* launch(speakerIn(channel, agent), config, continuePrompt(message), saved, null, message, { slot });
            return saved;
          }),
        );
      });

      const interruptAgent = Effect.fn("ChatService.interruptAgent")(function* (agentId: AgentId) {
        yield* stopHob(agentId);
        if (Option.isSome(taskTurns)) yield* taskTurns.value.interruptAgent(agentId);
      });

      const reviewAuthority = Effect.fn("ChatService.reviewAuthority")(function* (agentId?: AgentId) {
        const narrowed = yield* grants.narrowed(agentId);
        // Outside the permit: a turn that is stopping may still be reading its grant.
        yield* Effect.forEach(narrowed, (channelId) => endTurn(channelId), { discard: true });
        if (Option.isSome(taskTurns)) yield* taskTurns.value.reviewAuthority(agentId);
      });

      const { checkBrainSwitch, followHob, setBrain, archive, restore, rename, setPinned, setPrivate, markRead } =
        yield* makeChannelCommands({
          findChannel,
          requireActive,
          requireLive,
          withChannelHob,
          changeChannel,
          announce,
          drainChannels,
        });
      const { makeCamp, startFresh, moveChapter } = yield* makeCampCommands({
        requireActive,
        withHob,
        withChannelHob,
        announce,
      });

      // The channels with requests or your queued messages or backpack work waiting: of one hob, or
      // of every hob. Requests are the floor's queue, rebuilt from the records at start (ADR 039).
      const channelsWaiting = (agentId?: AgentId) =>
        Effect.gen(function* () {
          const queued = [...(yield* repo.channelsWithQueuedMessages), ...(yield* repo.channelsWithWaitingRequests)];
          const work = Option.isSome(continuations) ? yield* continuations.value.waiting(agentId) : [];
          return [...new Set([...queued, ...work])];
        });

      const drainAgent = Effect.fn("ChatService.drainAgent")(function* (agentId: AgentId) {
        // A hob that wakes takes up its work in its channels.
        const channels = yield* channelsWaiting(agentId);
        const own = yield* Effect.filter(channels, (channelId) =>
          repo.findChannel(channelId).pipe(
            // standards-allow STD-ARCH-021: a hob that wakes takes up the channels it owns
            Effect.map((channel) => Option.isSome(channel) && channel.value.agentId === agentId),
          ),
        );
        // And the requests it owes in camps it joined, which wait for it there.
        const owed = yield* Effect.filter(channels, (channelId) =>
          repo
            .openTurnRequests(mainLine(channelId))
            .pipe(Effect.map((open) => TurnRequests.waiting(open).some((request) => request.hobId === agentId))),
        );
        // And the work its backpack holds for camps it joined, which it carries there.
        const work = Option.isSome(continuations) ? yield* continuations.value.waiting(agentId) : [];
        // It takes up the work you stopped of its own, and leaves another hob's held.
        const mine = [...new Set([...own, ...work])];
        yield* Effect.forEach(mine, (channelId) => step(channelId, { _tag: "Release", hobId: agentId }));
        yield* drainChannels([...new Set([...mine, ...owed])]);
        if (Option.isSome(taskTurns)) yield* taskTurns.value.drainAgent(agentId);
      });

      const wake = (channelId: ChannelId) => drainChannels([channelId]);
      const resume = (channelId: ChannelId) => step(channelId, { _tag: "Release" }).pipe(Effect.andThen(wake(channelId)));

      const packSources = yield* makePackSources;
      const packPeople = yield* makePackPeople;
      const packReports = yield* Effect.serviceOption(PackReports);
      const contextPack = (channelId: ChannelId) =>
        Effect.gen(function* () {
          const channel = yield* repo.findChannel(channelId);
          if (Option.isNone(channel)) return yield* new ChannelNotFound({ channelId });
          const transcript = (yield* repo.listMessages(channelId)).filter((m) => m.status !== "queued" && hobReads(m));
          const live = transcript.filter((m) => m.chapterId === channel.value.liveChapterId);
          // The pack shown is the one the hob the channel belongs to would start its next session from.
          // standards-allow STD-ARCH-021: the dev view shows the owner's pack, not a turn's
          const owner = channel.value.agentId;
          const people = yield* packPeople({ channel: channel.value, agent: { id: owner } });
          const sources = yield* packSources(channel.value, live, transcript, people, null);
          const agent = yield* repo.findAgent(owner);
          const memory = Option.isNone(agent)
            ? null
            : yield* inputs.memoryBriefFor(
                agent.value,
                yield* hobTools.access(agent.value, undefined, { taken: false }),
                undefined,
              );
          const lastTurn = Option.isNone(packReports) ? Option.none() : yield* packReports.value.last(channelId);
          return {
            next: buildPack({ ...sources, memoryBrief: memory?.text ?? null }),
            lastTurn: Option.getOrNull(lastTurn),
          };
        });

      // Messages queued and work left waiting before a restart start again, through the same path
      // as any other.
      yield* drainChannels(yield* channelsWaiting());

      return ChatService.of({
        createChannel,
        sendPrompt,
        removeQueued,
        sendNow,
        stop,
        stopAll,
        letHobsGoOn,
        stopWaiting,
        continueReply,
        interruptAgent,
        reviewAuthority,
        setBrain,
        checkBrainSwitch,
        followHob,
        archive,
        rename,
        setPinned,
        setPrivate,
        markRead,
        unreadChannels: repo.listUnreadChannels,
        restore,
        makeCamp,
        startFresh,
        moveChapter,
        contextPack,
        drainAgent,
        wake,
        resume,
        activeChannels,
        activeTurns,
        channelRuns,
        streamingReplies,
      });
    }),
  );
}
