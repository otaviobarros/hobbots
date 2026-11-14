# ADR 039 — Shared camps with hobs and people

Status: **Proposed.** Amends the threads of [ADR 037](037-chat-and-camps.md) (a thread has members, a chat is a direct message with one hob, a runtime session also belongs to one hob, and chapters run on their own without Split, Merge, the Focus chip or Start fresh), the quest view of [ADR 027](027-quest-room.md) (a quest is followed in its card's reply thread), the capture of [ADR 028](028-memory.md) (each hob captures only its own part of a shared thread), the user session of [ADR 021](021-devices-and-remote-access.md) (a device belongs to a user) and who decides an approval in [ADR 015](015-approval-lifetimes-and-grants.md). Builds on the Task tree of [ADR 018](018-tasks-and-quests.md), the backpack of [ADR 019](019-hob-backpack-and-continuations.md), the steer receipts of [ADR 027](027-quest-room.md), the hob directory of [ADR 032](032-hob-directory.md) and the claims register of ADR 037. Records the design for shared camps ([#1425](https://github.com/otaviobarros/hobbots/issues/1425)).

## Context

Hobbots chat should feel like the chat apps people already use, such as Slack or WhatsApp: direct messages, shared places, people and hobs talking in one place. Hobbots adds its own pieces on top: camps, chapters, records, quests and the camp sheet.

Today a conversation has one hob and one person:

- `Thread.agentId` names the one hob that answers. Every message wakes it.
- The person is implied. `OWNER_ACTOR` is the only user actor, devices act as that user, and the thread's read marker is "yours".
- A runtime session is keyed by thread, runtime and chapter. There is one hob, so there is one session per chapter.
- `ThreadRun` runs one turn at a time for that hob.
- Several hobs already work together, but only inside a Quest, under a lead, and party members never talk to each other. A planned `consult_hob` would have let one hob ask another a question out of sight.

Putting several hobs and several people in one conversation raises questions that one hob never did:

- Who answers a message, and who stays quiet?
- How do two hobs avoid answering at once and talking over each other?
- How do hobs avoid replying to each other without end?
- Which session, memory and context does each hob read?
- Whose approval is it, and whose plan pays for the turn?

ADR 037 put an explicit actor on every authored record and left shared camps for this decision. Nothing built since assumes one hob per conversation beyond `Thread.agentId`, the session key and `ThreadRun`.

## Decision

### Words

| UI word | What it is | Code |
| --- | --- | --- |
| Direct message | You and one hob. Today's chat, unchanged. Each hob has one. | `Thread` with `kind: chat` |
| Camp | A place for a goal or a team. One hob or several, you alone or with other people. A camp for ideas is a camp where nobody starts a quest. | `Thread` with `kind: camp` |
| Member | A person or a hob in a direct message or a camp. Not a party member of a Quest. | `ThreadMember` |
| Lead | The hob a thread was made with. It leads the thread's quests by default. There is no host setting: who answers comes from the members. | `Thread.agentId` |

People see two places, direct messages and camps, as in Slack's direct messages and channels. This ADR says **shared camp** for a camp with more than one hob or with another person. It is worked out from `ThreadMember`, it is not a kind, and the UI has no word for it: a shared camp is just a camp with more members.

The glossary gains these rows in the pull request that first builds each one.

### Members

- **`ThreadMember`** has `threadId`, `actor` (a user or a hob), `role` (`owner` or `member`), `state`, `joinedAt`, `addedBy` (an actor) and `readRevision`. It is unique on thread and actor.
- **`MemberMachine`** has the states `active`, `left` and `removed`. A hob or a person added by a member is active at once. An invited state comes with accounts.
- **The read marker moves to the member.** Today's per-thread marker becomes the owner's `readRevision`, so unread counts, the unread line and "While you were away" are per person.
- **`Thread.agentId` stays and means the default lead.** Every thread keeps the hob it was made with, so nothing that reads it today breaks. It leads the thread's quests unless someone asks another hob.
- **A direct message has exactly two members:** you and its hob. Adding anyone is refused. "Make a camp" starts a new camp with both of you, and the current chapter can move into it as ADR 037 moves a chapter.
- **A hob leaves every thread when it is retired**, and comes back when it returns.
- **Migration.** Every thread gets two members: the owner, with role `owner`, and its hob. The thread's read marker becomes the owner's `readRevision`. It runs in one pass, on SQLite and PostgreSQL.

### Who answers

`answerersFor(message, thread, members)` is a pure function, run in the transaction that stores the message. It returns the hobs that must answer, in order. The rules, in this order:

1. **A note to self wakes nobody**, as today. Neither does a hob's message that mentions no hob.
2. **An @mention wakes the mentioned hobs**, in the order they were mentioned. A mention of a hob that is not a member is refused before the message is stored, with "Rook isn't in this camp. Add Rook?"
3. **A reply to a hob's message counts as mentioning that hob.**
4. **With no mention, the members decide.** In a direct message, or a camp with one hob, that hob answers, as today. In a camp with several hobs nobody answers, and the composer says so before you send. There is no answer-rule setting.
5. **A running Quest keeps its rules.** A message in its thread reaches the lead, and an @mention reaches the member hob directly, as steering a running member does ([#1345](https://github.com/otaviobarros/hobbots/issues/1345)).

There is no mention that wakes every hob. A shared camp that wants every hob's view mentions the hobs it wants. This keeps the cost of one message predictable.

### One hob speaks at a time

- **A `TurnRequest` records each answer owed:** `threadId`, `rootMessageId` (its conversation), `hobId`, the message that caused it, `causedBy` (an actor), `cause` (`mention`, `reply`, `only-hob` or `relay`), `relayDepth`, and a state of `waiting`, `paused`, `speaking`, `answered`, `passed` or `dropped`, held by `TurnRequestMachine`. It is written with the message, in the same transaction. The `cause` is what the pack and the header say: "Leo mentioned you", "relayed by Quill".
- **A `TurnRequest` is a reply owed, not work.** It says that a hob owes a conversation an answer, as the session contract's reply obligations do. Work for a hob, such as a Task's result or a hand-off, still goes only in its backpack (ADR 019, STD-ARCH-017). Neither is a second queue of the other.
- **The floor belongs to one conversation.** A conversation is a thread's main line or one of its reply threads (see Reply threads). It runs one chat turn at a time, whichever hob it is for. Two conversations in the same camp run their turns at once. `ThreadRun` becomes one run per conversation and keeps its states from ADR 037, `held` and `wakePending` included.
- **The dispatcher stays the one delivery path, and it hands out the floor.** A backpack item already names the thread it returns to; it also names the conversation, which is the one the work was started from (the main line for work started before reply threads). When a conversation's floor is free, or `wakePending` says to look again, the dispatcher re-reads the records and picks the oldest of: a waiting `TurnRequest` there, and a hob's deliverable backpack work for there. The turn it starts is that hob's, and it carries everything that hob has waiting in that conversation: its other requests there, marked `answered` by that one turn, and its backpack items, as one continuation. Work that arrives while the floor is taken sets `wakePending`, as today, with no `TurnRequest`.
- **Restart.** Requests, backpack items and held marks are records, so the dispatcher rebuilds each conversation's waiting list from them in the same order. A turn that was speaking when the hub stopped is ended as today, and its request goes back to `waiting`.
- **A hob that waited reads what was said meanwhile.** Its pack carries the replies since the message that woke it. It may answer briefly, or `pass`: a hub tool on every runtime that ends the turn with no message and records "Pip passed: Quill covered it".
- **People never wait.** A person's message is stored and shown at once, whoever holds the floor. A message that mentions the hob speaking now joins that hob's next turn, as today. One that mentions another hob adds a request behind the others.
- **Stop stops the turn that is speaking, and what it set off.** Requests that turn caused, by mentioning another hob, are dropped with it, so stopping a hob also stops the hand-off it started. Requests a person caused stay waiting: Stop never cancels what someone else asked for. Backpack work the stopped turn carried is held, as today, until you write, resume it or its hob wakes. Stop all drops every waiting or paused request in the conversation. Each dropped request records who stopped it. Stop all and holds its backpack work. Work is never dropped by Stop: a result stays in the backpack until it is delivered.
- **Conversations stay independent.** A hob in three conversations, in one thread or several, can speak in each at once, with one session per conversation, as a hob already runs several Tasks at once.
- **Quests are not chat turns.** A quest's work runs in the quest's own sessions (ADR 018) and never holds a conversation's floor. A shared camp can run any number of quests at once, within the owner's plan, and people and hobs keep talking while they run. A hob that leads a quest can still answer a mention in the camp: that is a separate chat turn, and its pack says the quest is running.

### Hobs talking to hobs

- **A hob may @mention another member hob** in its reply. That adds a `TurnRequest` caused by a hob.
- **The relay budget.** A request caused by a person has `relayDepth` 0, and one caused by a hob's mention has its turn's depth plus one. A request deeper than `HOB_RELAY_BUDGET`, 3, is written `paused`: it is kept, wakes nobody, and the conversation shows "Hobs paused, waiting for a person" with "Let them go on". Let them go on turns the paused requests to `waiting` with depth 1, so the resumed turn counts as the first of 3 more. A person's message in the conversation drops the paused requests instead, because the person has taken over. The budget is a named constant with tests.
- **Work goes through the existing paths.** A mention in a shared camp is for talking in the open. A hob that needs another hob's work starts a quest. A hob that needs another hob's answer mentions it in a reply thread, in the open. No separate consult tool is needed.

### The context pack with several hobs

- **A runtime session belongs to one hob and one conversation.** `RuntimeSession` is keyed by thread, conversation (the reply thread's root message, or none for the main line), chapter, runtime and hob. In a shared thread each member hob has its own session, so each keeps its own runtime and model (ADR 017). A hob that answers in the main line and in a reply thread of the same chapter has two sessions, so the two turns can run at once and neither carries the other's history. Each session keeps its own `seenThrough` and memory-brief fingerprint.
- **Records are shared.** The brief, active decisions, the artifacts index, chapter lines and carried items are one set per thread, and every member hob reads the same set.
- **The transcript part names every speaker.** The live chapter's messages carry their author, such as "Marina (person)" or "Quill (hob)". A hob's own replies are its own turns. A resumed session adds only what was said since that hob last spoke.
- **Its share stays the live chapter's.** When "since you last spoke" is longer than the live chapter's share, the oldest lines become a count, and the hob reads them with `read_message`.
- **Each hob reads its own memory.** The memory brief is the hob's own scope and its projects, as in ADR 028. A hob never reads another member hob's memory, even in the same thread.
- **The pack says who is here and why this turn runs.** It lists the members once per session, as the roster of ADR 032 does, and gives the reason for the turn: "Leo mentioned you", or "You are the only hob here".

### Memory in a shared thread

- **Each hob captures its own part.** Capture writes a hob's own turns, and the messages its pack carried for them, into that hob's scope, tagged with the thread. Another hob's replies are never captured into its scope. They belong to their author's capture.
- **A person's message is captured only by the hobs that took a turn on it.**
- **Privacy is the thread's.** A private camp keeps every member hob's capture out, under the rule of ADR 037.
- **For accounts later.** A memory page keeps its thread tag. When another person asks a hob something, recall leaves out pages from threads that person is not a member of. The accounts decision settles this.

### Cards every thread shares

Each card is a message part built from records. It looks and works the same in a direct message and in a camp with one hob or many.

- **Approval, with Change it.** An approval offers Approve, Change it and Don't.
  - On a Charm action with typed fields, such as a send time or a list of recipients, Change it opens the fields. The hub checks the changed call against the action's own schema and approves that call. The hob gets its result and a note of what changed.
  - On any other approval, Change it sends your words to the hob as the reason and what to do instead. It is recorded as a steer (ADR 027).
  - **The decider is the person who asked for the work:** the quest's requester for work inside a quest, or else the person the turn's `TurnRequest` came from. A turn that no person caused, such as a backpack continuation of a hob's own work, goes to the owner. The thread's owner may decide too. Everyone else sees "Waiting on Marina", and the card says "You asked, so it's yours to decide" to the decider. The approval records who decided, as an actor.
  - **A grant covers only its own person's requests.** Grants are set by the owner and stay per hob. When another person asks, the hob's grants do not approve for them: the call asks that person.
- **Collision note.** A Heads-up from the claims register (ADR 037), shown in every thread involved. In a shared camp it names the people who asked, as well as the hobs: "Marina asked Quill to rewrite the hero while Leo asked Pip to change its photo." It says what the hub settled and what waits.
- **For you.** One list per person replaces the Needs-you tray, the Inbox, catch-up and the away summary as separate places. It holds your mentions, questions for you, approvals you decide and work waiting for your review. Its top is "While you were away", at your unread line, which lists, from records written since your `readRevision`, your mentions, the decisions made, the artifacts that changed and what needs you. It is a projection and needs no model. With a hub brain it is phrased by a projector, never in a request.
- **Status and cost.** The header says who is speaking and who waits. A reply's footer shows the hob and the turn's tokens. The members sheet shows each hob's turns and tokens today and how much of the plan is left, from the usage records. Runtimes run on the owner's sign-ins, so every member's message spends the owner's plan, and the sheet says whose plan it is.

### Asking for a delivery in a shared camp

Bruna asks in Shop team: "@Aldric we need a landing page for the market. Can it be live by Friday?"

- **The work stays where it was asked.** Aldric starts a quest in the camp, and the quest belongs to the camp's thread (ADR 037: a quest belongs to the thread that started it). No new camp is made for it. When the work keeps growing past the quest, the hub suggests "Give this its own camp", as it does for any long topic. Accepting moves the quest, its card and the card's reply thread into a new camp with the same members, as ADR 037 moves a chapter, and leaves a stub where it started.
- **The hob says what it read first.** Aldric's reply lists the records and memory its pack used, such as "Aldric's memory: the shop's look", "Shop camp: Landing page v3" and "Marina's message at 10:58". Each one opens. This comes from the `PackReport`, so it costs no model call.
- **One living card per quest.** The quest card is a message part that updates in place, never a new message per step. It shows the steps, who is on each, a live thumbnail of the main artifact, the time and tokens so far, and Stop. A strip under the header keeps the running quest in view after the card scrolls away.
- **The quest card has a reply thread, and that is where it is steered.** The hob-to-hob messages and step lines go in the card's reply thread, not in the camp. A reply there reaches the quest as a steer (#1345) without stopping it, and the hob answers in the thread. Its steps, tool calls and their output are in that thread too; there is no separate quest view.
- **The camp sees only what a person needs.** A hob's question for a person, one line for each new version ("Aldric updated Winter Market page v2 · map added, as Leo asked"), and Ready are also sent to the camp, marked as from the quest's thread. Everything else stays in the thread, which the card shows as "6 replies · last reply 11:18".
- **Many quests at once.** Each quest has its own card and reply thread. The quest strip under the header shows the running quest with its progress and what needs you, and opens its reply thread; All quests lists the others.
- **Questions go to the person who asked.** A question names the requester and offers quick answers. The card turns `lantern` while it waits, and the answer is recorded as a decision the quest reads.
- **Ready means ready for the requester.** The card turns into the review card: the page itself, then each thing the quest made, with its version and what changed. The requester decides, as with approvals. Going live is an approval of its own ("Put it live…"), because it reaches people outside the hub.
- **Anyone in the camp can ask for a change.** Leo's "can the page show a map?", in the quest's thread with a mention of Aldric, reaches the running quest, not a new one. The new version records that Leo asked. When two asks clash, the requester's wins, and the lead says so in the thread.
- **Stop on the card** is `stop_quest` ([#1346](https://github.com/otaviobarros/hobbots/issues/1346)), allowed to the requester and the owner.

### Reply threads

Any message can have a reply thread, as in Slack, so a side conversation doesn't fill the camp.

- **A reply thread is its root message's.** A message gains `rootMessageId`, which points at the message its thread hangs from. Replies are ordinary messages of the same thread, so find, chapters, records and capture keep working. The main line shows only messages with no root.
- **The root shows the thread in one line:** the faces of who replied, the count and the time of the last reply. It opens beside the camp, not over it.
- **Who answers is the same as in the camp.** In a reply thread a hob answers only when mentioned, or when the thread hangs from its own quest card. The thread is its own conversation for the floor, so a hob can answer there while another speaks in the main line.
- **Also send to the camp.** A reply can be sent to the main line too. It shows there with a link back to its thread. A hob's question for a person and a new version are always sent to both.
- **Per person.** Each member has a read marker per reply thread they took part in, and a reply in such a thread counts as unread for them. A mention of you anywhere counts as usual.
- **The pack.** A hob that answers in a reply thread reads its root and replies as the live part, plus the camp's records. It does not read the main line's recent messages unless the root points at them.

### Showing work: cards and the viewer

Artifacts already keep versions (#1434). This section decides how they look and read wherever they appear.

- **A card for each kind.** An artifact in chat shows what it is, not a file icon: a page shows its preview, a doc its opening lines, an image its picture (before and after when there is a v1), code its files with +/− counts and its checks, a table its first rows, a PDF its first page, screenshots as a strip. Each card has the version, who made it and one line on what changed.
- **One viewer for everything.** Opening any artifact opens the same viewer, over the thread:
  - **Preview** at desktop or phone size, with comment pins on the artifact itself.
  - **Point at something**: pick a part of a page or a span of a doc, and the ask carries it to the hob ("On: Save my spot button").
  - **Compare with an earlier version**: changes are numbered on the artifact, and a list says what each one is and who asked for it. Pages compare side by side, docs as a redline, images before and after.
  - **Changes**, for an artifact backed by code: a summary in words from the hob first, then the diff, unified or side by side, per file, with Viewed marks, comments on lines, the checks and where the branch lives.
  - **Versions**, each with its author, its time and the ask that caused it.
  - **An ask box** that goes to the hob that made it. The answer comes in the viewer, and the thread gets one line when the new version lands.
- **Who asked is part of every change.** A version records the actor whose message caused it. That is how Compare, the update line and the Artifacts tab can say "Leo asked".
- **The Artifacts tab.** The thread's sheet lists everything made or shared in it, grouped by the ask or quest it came from, with filters by kind. Files people add sit under "Shared in the camp".
- **What each person sees is the same.** Pins, comments and versions belong to the artifact, not to a person. Only read marks are per person.

### Users as actors

- **A `User` record** has `id`, `name`, `initials`, `color` and `state`. The migration makes the owner a user with id `owner`, so `OWNER_ACTOR` keeps its meaning.
- **A device belongs to a user.** `Device` gains `userId`, and `UserSession` names the user as well as the device. Today every device belongs to the owner.
- **What is per person:** read markers (`ThreadMember.readRevision`), For you items, which gain `for` (an actor), and mentions of you.
- **What stays the hob's:** a hob's tool policy applies whoever asks. Its grants cover only the owner's requests (see Cards every thread shares). A high-risk approval goes to the hob's owner, who is the hub's owner today.
- **What this does not decide.** Accounts, sign-in, invites, roles and remote access for another person need their own ADR. Until it lands, only the owner can be a person in a thread. This decision only makes sure that ADR adds rows, not meanings.

### The sidebar

- **Two sections:** Camps (every camp, shared or not; a shared camp shows a stack of its members) and Direct messages (your hobs).
- **Each row is a chat row:** its picture or a stack of members, its name, the last message with its author ("Marina: Thursday works"), the time, the unread count, and a mark when something needs you. A mention of you counts in `lantern`.
- **Camps come first, then direct messages.** Shared camps show above a hob's own camps, the rest wait behind Show more, and All your hobs closes the direct messages. A hob's page lists its direct message and the camps it is in. Above both sections sit Find or jump to, Home, For you (with the count of what needs you), Usage and Settings.
- Each member can mute a thread. A muted thread still counts mentions of you.

### Scope

- **A hob replies or runs a quest.** Work for one person is a quest with one member; Tasks are its parts. Hobs do not choose between a reply, a Task and a Quest ([#1157](https://github.com/otaviobarros/hobbots/issues/1157)).
- **The quest view is the card's reply thread.** It holds the steps, questions, versions and steering, and the viewer opens what the quest made. There is no quest tab in the camp sheet and no separate quest room. ADR 027's steer receipts and unread markers move into the thread.
- **Chapters run on their own.** The hub starts chapters for context and cost, and people see a quiet divider. Split, Merge, the Focus chip and Start fresh go. Work moves to a camp from a message or a reply thread.
- **Views in replies stay.** A hob can show a table, a chart or another view in a plain reply, without starting a quest ([#1110](https://github.com/otaviobarros/hobbots/issues/1110)).
- **Parked until a real case asks:** claims beyond code ([#1413](https://github.com/otaviobarros/hobbots/issues/1413)), a proactive hub ([#1407](https://github.com/otaviobarros/hobbots/issues/1407)), quick runs and steps on another model, and notes to self, which pins cover.

### Not chosen

- **Every hob answers every message.** It multiplies cost by the number of hobs and has them talk over each other.
- **An answer-rule or host setting.** Who answers follows from the members, so there is nothing to set or explain.
- **A model picks who answers.** It puts a model call in a command's request path, which ADR 037 forbids, and makes cost hard to predict. A projector may later suggest a hob to mention.
- **Hob turns in parallel in one thread.** Replies would interleave and contradict each other, and none would read the others.
- **One runtime session shared by every hob.** Hobs differ in runtime, model, instructions and memory.
- **A "group" as its own kind, table or word.** A shared camp is a thread with members, so it keeps chapters, records, quests, find and archive for free, and people learn one place instead of two.
- **A campfire kind.** Rounds, a facilitator and read-only tools added a word, a kind and a machine for little gain. A camp for ideas is a camp where nobody starts a quest, any hob can be asked to brainstorm, and an idea becomes a quest the usual way.

### Rollout

Slices in this order. Each leaves the app working and is proven end to end on Claude Code, Codex and the fake runtime.

1. **Members and users:** `User`, `Device.userId`, `UserSession` with a user, `ThreadMember` and its migration, read markers per member, the For you list and mentions per user, and a test seam that plays several people: a hidden developer setting that adds a named person and approves a device for them by hand, replaced by invites later. Nothing changes on screen for one person.
2. **Camps with several hobs:** add hobs to a camp, who answers, mentions in the composer, `TurnRequest` and the floor per conversation, `pass`, the relay budget, sessions and capture per hob, the pack with members and speakers, the members sheet and the sidebar's Camps and Direct messages. Still one person.
3. **Reply parts and the viewer:** reply parts and the view catalog ([#1110](https://github.com/otaviobarros/hobbots/issues/1110)), cards for each kind of artifact, stored artifact versions with who asked, the viewer with Preview, Versions, Compare and Changes, the Artifacts tab, views in plain replies, and MCP servers as Charms. Runs beside slice 2.
4. **Quests in conversations:** a quest started with its requester, the living quest card, reply threads with a floor each, steering from the card's thread, the quest strip, and questions, versions and Ready also sent to the main line.
5. **Shared cards:** the decider rule, Change it with typed fields, collision notes that name who asked, comment pins and Point at something and ask.
6. **People:** after the accounts ADR, other people join threads, with their own For you list and mentions.

## Rationale

- **Familiar first.** Direct messages, shared places and @mentions are what people already know. Hobbots' own pieces sit on top of them, not instead of them.
- **Nobody answers unless asked, in a shared camp.** People in a shared camp talk to each other most of the time. A hob that answered every message would cost a turn each time and crowd them out. A hob that is alone in a thread still answers, so one-hob places stay exactly as they are.
- **Rules before models.** Who answers, the floor and the relay budget are pure rules in the transaction. They are exact, free and work under No AI.
- **One speaker at a time.** A hob that waits reads what was said and can pass, so two hobs never say the same thing at once.
- **A shared camp is a thread.** Members are rows on a thread, so shared camps keep everything ADR 037 built, and a direct message stays exactly what it is today.
- **Each hob stays itself.** Its own session, memory and policy keep a shared thread from mixing up what each hob knows or may do.

## Consequences

- Only the hobs named, or the only hob in the thread, ever run, so the number of turns a message starts is known before it is sent. A turn's own cost depends on its pack, and the pack's budget is the same in a direct message and a shared camp.
- The migration adds a member row for every thread and a user row for the owner. It runs in one pass, on SQLite and PostgreSQL, with a test for each.
- `RuntimeSession` gains the hob and the conversation in its key. Existing sessions take their thread's hob and the main line. A reply thread starts its own session from the pack, which costs one fresh briefing per reply thread a hob answers in.
- `ThreadRun` becomes one run per conversation. The dispatcher picks the next turn from `TurnRequest` records and backpack items, and `wakePending` keeps its meaning. The model-based tests of ADR 037 extend to several hobs, several conversations and backpack work.
- Every memory and For you query that assumes one person gains an actor. Today that actor is always the owner.

## Amendment: the floor as built ([#1461](https://github.com/otaviobarros/hobbots/issues/1461))

Building `TurnRequest` and one floor per conversation settled what the decision left open.

- **The records replace `wakePending`.** A conversation's queue is its waiting `TurnRequest`s and its backpack items, so `ThreadRun` keeps no flag for work that arrived while the floor was taken. When a dispatch delivered nothing, the dispatcher reads the records again: work that needs the hob, or routine progress with a queued message to ride along, starts another dispatch; otherwise only a request can be waiting. A busy conversation that is woken does nothing, because its own end reads the records.
- **A turn answers the request it took.** Each person's queued message keeps its own turn, as before (CH-008), so a hob's other requests in the conversation wait their own turns instead of folding into one.
- **Restart answers a speaking request.** A turn that was speaking when the hub stopped ends as an interrupted reply, as before, and that reply answers its request, which Continue resumes. The request does not go back to `waiting`, so no second turn starts over an unfinished reply. Waiting requests start again in their order.
- **Stop all leaves what was said.** Stop all stops the speaking turn and drops every request still owed, each recording who stopped it. A queued message left with nothing owed leaves the queue as said, journaled `MessageDequeued` with reason `dropped`. Removing a queued message drops what was owed for it.
- **The run says who speaks.** `ThreadRunStatus` names its conversation (`rootMessageId`, null for the main line), the hob speaking and the hobs next in line. Every turn runs in a main line until reply threads come.
- **Requests are not journaled.** A `TurnRequest` is the hub's own queue, an exception to STD-ARCH-015. Its moves happen in the transactions that journal what clients do see: the message stored with its requests, the reply that takes the floor, and `MessageDequeued` when a drop leaves a queued message with nothing owed. Clients learn the floor from `ThreadRunChanged`, and the hub's status snapshot keeps a line whose hobs still wait for its floor. A journaled event per move can come when a client needs the history of the floor.
- **A member hob continues its own reply.** Continue resumes a reply with the hob that wrote it, so a mentioned hob's interrupted reply never goes on as the camp's own hob.
- **Paused and passed are declared, not reached.** The relay budget ([#1463](https://github.com/otaviobarros/hobbots/issues/1463)) writes `paused` requests and the `pass` tool ([#1462](https://github.com/otaviobarros/hobbots/issues/1462)) ends one `passed`.
- **Proven.** `[TC-DM-1461-03]` plays random sends, mentions, hob relays, starts, stops, Stop all and restarts across three hobs against a model of the floor; `[TC-PE-1461-03]` plays them on the records, on SQLite and PostgreSQL, with removals; `[TC-CH-1461-01]` to `[TC-CH-1461-03]` run the turns through the chat, a restart and Stop all included.

## Validation

The scenarios that would show this decision holds. None is proven yet. Each slice will file its proof issues from these ([#1425](https://github.com/otaviobarros/hobbots/issues/1425)).

- After the migration every thread has the owner and its hob as members, unread counts read the same as before, and adding a member to a direct message is refused. Not proven yet.
- In a camp with several hobs, a message with no mention starts no turn. A message that mentions Quill and Pip starts Quill's turn, then Pip's, never both at once, on Claude Code, Codex and the fake runtime. Not proven yet.
- Model-based tests of random sends, mentions, replies, backpack arrivals, stops and restarts across three hobs and two conversations agree with a model of the floor: one turn at a time per conversation, every request answered, passed or dropped exactly once, and every backpack item settled exactly once. Delivery stays at least once, as ADR 019 requires: an item a runtime took before a crash, but that was not yet settled, is delivered again, and its effects are idempotent, so it never writes a second reply or runs a second effect. Not proven yet.
- Two hobs that mention each other stop after `HOB_RELAY_BUDGET` turns, and the conversation shows that it waits for a person. Let them go on allows exactly 3 more hob turns, the resumed one included, and a person's message drops the paused request. Stop on a hob drops the requests its turn caused and keeps those a person caused. Not proven yet.
- The same hob mentioned in the main line and in a reply thread of the same chapter answers both at once, from two sessions, and neither turn's runtime input holds the other conversation's messages. Not proven yet.
- A Task result that reaches the backpack while another hob holds the floor starts its hob's continuation once the floor is free, with no `TurnRequest`, and survives a restart and a Stop. When that hob also owes a reply there, one turn carries both. Not proven yet.
- Each hob in a shared camp resumes its own session. Proven on the fake Claude Code and Codex runtimes, where two hobs in one thread each resume only their own session and a hob new to the live chapter starts one from the pack, by `[TC-CH-1464-01]`; on installed Claude Code and Codex with stand-in models, where two sessions in one workspace each resume only their own history, by `[TC-RT-1464-01]` and `[TC-RT-1464-02]`, and on the fake runtime by `[TC-RT-1464-03]`; and on SQLite and PostgreSQL, where migration 20261114005209_hob_sessions gives every stored and journaled session its thread's hob, by `[TC-DP-1464-01]` ([#1464](https://github.com/otaviobarros/hobbots/issues/1464), [evidence](../evidence/2026-11-14-hob-sessions.md)). Not run with a real model. Its pack names every speaker and carries only what was said since it last spoke, within the live chapter's share, and never another hob's memory brief. Not proven yet.
- Capture writes each hob's own turns to its own scope only, and nothing from a private camp. Not proven yet.
- Change it on a Charm action approves the changed call only when it passes the action's schema, and records who changed what. Only the requester or the owner can decide. Not proven yet.
- The For you list and its "While you were away" part list the same mentions, decisions and changed artifacts for the same records and read marker. Not proven yet.
- A quest started from a shared camp belongs to the camp's thread. Its card updates in place, its work and steers stay in the card's reply thread, and the camp gets only questions for a person, one line per new version and Ready. Not proven yet.
- Two quests in one camp run at once while people and hobs keep talking in the main line and in reply threads, and no chat turn waits on a quest. Not proven yet.
- A reply in a quest card's thread reaches the quest as a steer without stopping it. Not proven yet.
- A version made because of a message records that message's author, and Compare lists each change with who asked for it. Not proven yet.
