# ADR 039 — Group chats with hobs and people

Status: **Proposed.** Amends the threads of [ADR 037](037-chat-and-camps.md) (a thread has members, a chat is a direct message with one hob, a runtime session also belongs to one hob, and a camp can be a campfire), the capture of [ADR 028](028-memory.md) (each hob captures only its own part of a shared thread), the user session of [ADR 021](021-devices-and-remote-access.md) (a device belongs to a user) and who decides an approval in [ADR 015](015-approval-lifetimes-and-grants.md). Builds on the Task tree of [ADR 018](018-tasks-and-quests.md), the backpack of [ADR 019](019-hob-backpack-and-continuations.md), the steer receipts of [ADR 027](027-quest-room.md), the hob directory of [ADR 032](032-hob-directory.md) and the claims register of ADR 037. Records the design for shared camps and campfires ([#1425](https://github.com/otaviobarros/hobbots/issues/1425)).

## Context

Hobbots chat should feel like the chat apps people already use, such as Slack or WhatsApp: direct messages, groups, people and hobs talking in one place. Hobbots adds its own pieces on top: camps, chapters, records, quests and the camp sheet.

Today a conversation has one hob and one person:

- `Thread.agentId` names the one hob that answers. Every message wakes it.
- The person is implied. `OWNER_ACTOR` is the only user actor, devices act as that user, and the thread's read marker is "yours".
- A runtime session is keyed by thread, runtime and chapter. There is one hob, so there is one session per chapter.
- `ThreadRun` runs one turn at a time for that hob.
- Several hobs already work together, but only inside a Quest, under a lead, and party members never talk to each other. `consult_hob` ([#1293](https://github.com/otaviobarros/hobbots/issues/1293)) lets one hob ask another a question, out of sight.

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
| Camp | A place with a goal. One hob or several, you alone or with other people. | `Thread` with `kind: camp` |
| Group | A camp or campfire with more than one hob, or with another person. It is a view over the members, not a kind. | Derived from `ThreadMember` |
| Campfire | A camp where hobs and people talk ideas through in rounds. Nothing gets built there. It ends in a decision or a quest. | `Thread` with `kind: campfire` |
| Member | A person or a hob in a chat, camp or campfire. Not a party member of a Quest. | `ThreadMember` |
| Host | The hob a thread was made with. It answers when nobody is mentioned, if the members chose that, and leads the thread's quests by default. | `Thread.agentId` |

The glossary gains these rows in the pull request that first builds each one.

### Members

- **`ThreadMember`** has `threadId`, `actor` (a user or a hob), `role` (`owner` or `member`), `state`, `joinedAt`, `addedBy` (an actor) and `readRevision`. It is unique on thread and actor.
- **`MemberMachine`** has the states `active`, `left` and `removed`. A hob or a person added by a member is active at once. An invited state comes with accounts.
- **The read marker moves to the member.** Today's per-thread marker becomes the owner's `readRevision`, so unread counts, the unread line and the away summary are per person.
- **`Thread.agentId` stays and means the host.** Every thread keeps one host hob, the hob it was made with, so nothing that reads it today breaks. A thread names the host in the UI only when it has more than one hob.
- **A direct message has exactly two members:** you and its hob. Adding anyone is refused. "Make a group" starts a new camp with both of you, and the current chapter can move into it as ADR 037 moves a chapter.
- **A hob leaves every thread when it is retired**, and comes back when it returns.
- **Migration.** Every thread gets two members: the owner, with role `owner`, and its hob. The thread's read marker becomes the owner's `readRevision`. It runs in one pass, on SQLite and PostgreSQL.

### Who answers

`answerersFor(message, thread, members)` is a pure function, run in the transaction that stores the message. It returns the hobs that must answer, in order. The rules, in this order:

1. **A note to self wakes nobody**, as today. Neither does a hob's message that mentions no hob.
2. **An @mention wakes the mentioned hobs**, in the order they were mentioned. A mention of a hob that is not a member is refused before the message is stored, with "Rook isn't in this group. Add Rook?"
3. **A reply to a hob's message counts as mentioning that hob.**
4. **With no mention, the thread's answer rule decides.** `host`: the host answers. `mentions`: nobody answers, and the composer says so before you send. A direct message and a camp with one hob use `host`, so they behave as today. A group starts with `mentions`. Any member can change it in the members sheet.
5. **A running Quest keeps its rules.** A message in its thread reaches the lead, and an @mention reaches the member hob directly, as steering a running member does ([#1345](https://github.com/otaviobarros/hobbots/issues/1345)).

There is no mention that wakes every hob. A group that wants every hob's view asks the host, which can consult the others. This keeps the cost of one message predictable.

### One hob speaks at a time

- **A `TurnRequest` records each answer owed:** `threadId`, `hobId`, the message that caused it, the actor who caused it, and a state of `waiting`, `speaking`, `answered`, `passed` or `dropped`, held by `TurnRequestMachine`. It is written with the message, in the same transaction.
- **`ThreadRun` gives the floor to the oldest waiting request.** A thread runs one turn at a time, whichever hob it is for. The run keeps its states from ADR 037. Its `wakePending` flag becomes the queue of waiting requests, rebuilt at start from the records.
- **A hob that waited reads what was said meanwhile.** Its pack carries the replies since the message that woke it. It may answer briefly, or `pass`: a hub tool on every runtime that ends the turn with no message and records "Pip passed: Quill covered it".
- **People never wait.** A person's message is stored and shown at once, whoever holds the floor. A message that mentions the hob speaking now joins that hob's next turn, as today. One that mentions another hob adds a request behind the others.
- **Stop stops the turn that is speaking.** The waiting requests stay. Stop all drops them, and each one is marked `dropped` with who stopped it.
- **Threads stay independent.** A hob in three threads can speak in each, with one session per thread, as a hob already runs several Tasks at once.

### Hobs talking to hobs

- **A hob may @mention another member hob** in its reply. That adds a `TurnRequest` caused by a hob.
- **The relay budget.** After a person's message, hobs may wake each other for at most `HOB_RELAY_BUDGET` turns, 3, before a person speaks again. Past it, the hub drops the request and the thread shows "Hobs paused, waiting for a person" with "Let them go on", which resets the budget once. The budget is a named constant with tests.
- **Work goes through the existing paths.** A mention in a group is for talking in the open. A hob that needs another hob's work starts a Task or a Quest. A hob that needs another hob's answer out of sight uses `consult_hob`.

### The context pack with several hobs

- **A runtime session also belongs to one hob.** `RuntimeSession` is keyed by thread, chapter, runtime and hob. In a shared thread each member hob has its own session, so each keeps its own runtime and model (ADR 017).
- **Records are shared.** The brief, active decisions, the artifacts index, chapter lines and carried items are one set per thread, and every member hob reads the same set.
- **The transcript part names every speaker.** The live chapter's messages carry their author, such as "Marina (person)" or "Quill (hob)". A hob's own replies are its own turns. A resumed session adds only what was said since that hob last spoke.
- **Its share stays the live chapter's.** When "since you last spoke" is longer than the live chapter's share, the oldest lines become a count, and the hob reads them with `read_message`.
- **Each hob reads its own memory.** The memory brief is the hob's own scope and its projects, as in ADR 028. A hob never reads another member hob's memory, even in the same thread.
- **The pack says who is here and why this turn runs.** It lists the members and the answer rule once per session, as the roster of ADR 032 does, and gives the reason for the turn: "Leo mentioned you", or "You are the host and nobody was mentioned".

### Memory in a shared thread

- **Each hob captures its own part.** Capture writes a hob's own turns, and the messages its pack carried for them, into that hob's scope, tagged with the thread. Another hob's replies are never captured into its scope. They belong to their author's capture.
- **A person's message is captured only by the hobs that took a turn on it.**
- **Privacy is the thread's.** A private camp or campfire keeps every member hob's capture out, under the rule of ADR 037.
- **For accounts later.** A memory page keeps its thread tag. When another person asks a hob something, recall leaves out pages from threads that person is not a member of. The accounts decision settles this.

### Cards every thread shares

Each card is a message part built from records. It looks and works the same in a direct message, a camp, a group and a campfire.

- **Approval, with Change it.** An approval offers Approve, Change it and Don't.
  - On a Charm action with typed fields, such as a send time or a list of recipients, Change it opens the fields. The hub checks the changed call against the action's own schema and approves that call. The hob gets its result and a note of what changed.
  - On any other approval, Change it sends your words to the hob as the reason and what to do instead. It is recorded as a steer (ADR 027).
  - **The decider is the person who asked for the work:** the requester on the Task, or the author of the message that started the turn. The thread's owner may decide too. Everyone else sees "Waiting on Marina". The approval records who decided, as an actor.
- **Collision note.** A Heads-up from the claims register (ADR 037), shown in every thread involved. In a group it names the people who asked, as well as the hobs: "Marina asked Quill to rewrite the hero while Leo asked Pip to change its photo." It says what the hub settled and what waits.
- **Away summary.** "While you were away" sits at your unread line. It lists, from records written since your `readRevision`, your mentions, the decisions made, the artifacts that changed and what needs you. It is a projection and needs no model. With a hub brain it is phrased by a projector, never in a request.
- **Status and cost.** The header says who is speaking and who waits. A reply's footer shows the hob and the turn's tokens. The members sheet shows each hob's turns and tokens today and how much of the plan is left, from the usage records. Runtimes run on the owner's sign-ins, so every member's message spends the owner's plan, and the sheet says whose plan it is.

### Campfires

- **A campfire is a kind.** It has a question instead of a goal and a facilitator, which is its host.
- **Rounds.** The facilitator opens a round. Each member hob speaks once, in an order the facilitator picks, through `TurnRequest`. People add ideas and vote at any time. `CampfireRound` is a machine with the states `open`, `closed` and `ended`.
- **Nothing gets built.** In a campfire the tool policy allows only reading and searching. A hob that tries to write is refused with "This is a campfire. Turn the idea into a quest to build it."
- **It ends with a choice.** "Turn the top idea into a quest" starts a quest in a camp the person picks, with the ideas and votes as its brief, and records the choice as a decision. "End without a choice" keeps the campfire read-only and searchable.

### Users as actors

- **A `User` record** has `id`, `name`, `initials`, `color` and `state`. The migration makes the owner a user with id `owner`, so `OWNER_ACTOR` keeps its meaning.
- **A device belongs to a user.** `Device` gains `userId`, and `UserSession` names the user as well as the device. Today every device belongs to the owner.
- **What is per person:** read markers (`ThreadMember.readRevision`), the Needs-you tray and Inbox items, which gain `for` (an actor), and mentions of you.
- **What stays the hob's:** a hob's tool policy and grants apply whoever asks. A high-risk approval goes to the hob's owner, who is the hub's owner today.
- **What this does not decide.** Accounts, sign-in, invites, roles and remote access for another person need their own ADR. Until it lands, only the owner can be a person in a thread. This decision only makes sure that ADR adds rows, not meanings.

### The sidebar

- **Three sections, worked out from members:** Groups (threads with another person or more than one hob), Camps (your camps with one hob) and Direct messages (your hobs).
- **Each row is a chat row:** its picture or a stack of members, its name, the last message with its author ("Marina: Thursday works"), the time, the unread count, and a mark when something needs you. A mention of you counts in `lantern`.
- **The open direct message lists its hob's camps beneath it**, as the rail of ADR 037 does, so a hob's camps stay one click away.
- Each member can mute a thread. A muted thread still counts mentions of you.

### Not chosen

- **Every hob answers every message.** It multiplies cost by the number of hobs and has them talk over each other.
- **A model picks who answers.** It puts a model call in a command's request path, which ADR 037 forbids, and makes cost hard to predict. A projector may later suggest a hob to mention.
- **Hob turns in parallel in one thread.** Replies would interleave and contradict each other, and none would read the others.
- **One runtime session shared by every hob.** Hobs differ in runtime, model, instructions and memory.
- **A separate `Group` table.** A group is a thread with members, so it keeps chapters, records, quests, find and archive for free.

### Rollout

Five slices, in order. Each leaves the app working.

1. **Members and users as actors:** `User`, `ThreadMember`, the migration, read markers per member and `Device.userId`. No change in what you see.
2. **Groups with hobs:** add hobs to a camp, mentions, the answer rule, `TurnRequest`, the floor, the relay budget, sessions per hob, the pack's speakers, the members sheet and the sidebar sections. Still one person.
3. **Shared cards:** Change it, collision notes that name who asked, the away summary per member, and status and cost.
4. **Campfires:** the kind, rounds, the facilitator, read-only tools and turning an idea into a quest.
5. **People:** after the accounts ADR, other people join threads, with their own tray, Inbox and mentions.

## Rationale

- **Familiar first.** Direct messages, groups and @mentions are what people already know. Hobbots' own pieces sit on top of them, not instead of them.
- **Nobody answers unless asked, in a group.** People in a group talk to each other most of the time. A hob that answered every message would cost a turn each time and crowd them out. The host rule keeps one-hob places exactly as they are.
- **Rules before models.** Who answers, the floor and the relay budget are pure rules in the transaction. They are exact, free and work under No AI.
- **One speaker at a time.** A hob that waits reads what was said and can pass, so two hobs never say the same thing at once.
- **A group is a thread.** Members are rows on a thread, so groups keep everything ADR 037 built, and a direct message stays exactly what it is today.
- **Each hob stays itself.** Its own session, memory and policy keep a shared thread from mixing up what each hob knows or may do.

## Consequences

- A turn in a group costs no more than a turn in a direct message. Only the hobs named, or the host, ever run.
- The migration adds a member row for every thread and a user row for the owner. It runs in one pass, on SQLite and PostgreSQL, with a test for each.
- `RuntimeSession` gains the hob in its key. Existing sessions take their thread's hob.
- `ThreadRun`'s `wakePending` flag becomes a queue of `TurnRequest` records. The model-based tests of ADR 037 extend to several hobs.
- Every memory, Inbox and tray query that assumes one person gains an actor. Today that actor is always the owner.

## Validation

The scenarios that would show this decision holds. None is proven yet. Each slice will file its proof issues from these ([#1425](https://github.com/otaviobarros/hobbots/issues/1425)).

- After the migration every thread has the owner and its hob as members, unread counts read the same as before, and adding a member to a direct message is refused. Not proven yet.
- In a group whose answer rule is `mentions`, a message with no mention starts no turn. A message that mentions Quill and Pip starts Quill's turn, then Pip's, never both at once, on Claude Code, Codex and the fake runtime. Not proven yet.
- Model-based tests of random sends, mentions, replies, stops and restarts across three hobs agree with a model of the floor: one turn at a time, every request answered, passed or dropped exactly once. Not proven yet.
- Two hobs that mention each other stop after `HOB_RELAY_BUDGET` turns, and the thread shows that it waits for a person. Not proven yet.
- Each hob in a group resumes its own session. Its pack names every speaker and carries only what was said since it last spoke, within the live chapter's share, and never another hob's memory brief. Not proven yet.
- Capture writes each hob's own turns to its own scope only, and nothing from a private group. Not proven yet.
- Change it on a Charm action approves the changed call only when it passes the action's schema, and records who changed what. Only the requester or the owner can decide. Not proven yet.
- The away summary lists the same mentions, decisions and changed artifacts for the same records and read marker. Not proven yet.
- A campfire refuses every tool that writes, and turning its top idea into a quest records the choice as a decision. Not proven yet.
