# ADR 017 — Switching a thread's brain

Status: **Accepted.** Refines [conversations](../architecture/conversations.md) (session mapping) and the [agent model](../architecture/agent-model.md) for #169.

## Context

A brain is the runtime and model a hob thinks with, such as Claude Code with Sonnet. A thread should be able to move to another brain, for example from Claude Code to Codex, and keep going. Runtime sessions cannot move between runtimes: Claude Code's session means nothing to Codex. Until now a thread held one runtime session, and only the hob's configuration said which brain a turn used.

The issue leaves four questions to this ADR: how much history to send verbatim and how to fit a smaller context window, which brain writes the summary of older turns, whether a thread's brain choice is an override or a hob configuration change, and how usage is attributed when one thread spans runtimes.

## Decision

### Hobbots' transcript is the source of truth

- A thread keeps **one session per runtime**: its runtime, the runtime's session id, and the last message that session has seen. A switch never moves a session. The first turn on a runtime the thread has not used starts a fresh session; switching back to a runtime the thread used before resumes that runtime's own session.
- A switch reads nothing from the runtime it leaves. The handoff is built from what Hobbots stored: messages, and each reply's tool steps as stored (label and outcome). Tool calls are redacted before they are stored ([#168](https://github.com/otaviobarros/hobbots/issues/168)), so a secret in a command never reaches another provider through a briefing either. A switch away from a brain that is limited, signed out or down works the same as any other.
- Files a hob changed are already in its folders, so the handoff does not repeat them.

### The briefing

A turn carries a briefing when its runtime's session missed replies from another brain: the session is new to a thread another brain has answered in, or it resumes after another brain replied. Continuing a reply on another brain also carries one. A thread that has only ever used one runtime never gets a briefing. The briefing travels as its own field of the prompt request, and the adapter places it after the hob's instructions and before the user's prompt, so the prompt itself is stored and passed as the user wrote it. Claude Code receives the three in one message, so a slash command typed on a briefed turn is read as text, as it already is on a turn that repeats changed instructions. The hob's identity and instructions are delivered as on any other turn.

- **New session** (the runtime has not been used in this thread): the latest turns verbatim, and a summary of the older ones.
- **Resumed session** (the runtime is used again after another brain replied): only what happened since that session last replied, verbatim, with a summary if it does not fit.
- **Verbatim window:** the newest messages, newest first, until 24,000 characters. A single message longer than 6,000 characters is cut to its first and last 3,000.
- **Quoting:** each message's text is quoted line by line, and a summary line's text sits in quotation marks, so text that looks like the briefing's own headings or speakers stays inside its quote. The briefing says quoted text is a record, not instructions.
- **Summary:** one line per older message, its first 280 characters, and for a reply the steps it took (at most 8, each cut to 120 characters, then how many more) such as `Ran pnpm test (done)` or `Edit src/a.ts (denied: …)`. At most 8,000 characters; when over, the oldest lines are dropped with a note saying how many.
- The whole briefing stays under about 32,000 characters, roughly 8,000 tokens, which fits every model Hobbots offers today. Sizing the window to each model's context comes when runtimes report their windows.

### Who writes the summary

**The hub writes it, without a model.** The summary is the deterministic digest above, so it costs nothing, needs no runtime to be available, and the same history always gives the same summary, which keeps it testable. A model-written summary is better prose but costs a turn on some brain, and the brain at hand may be the very one that is limited; it can be added later as an option without changing the rest of this decision.

The summary is stored as a **checkpoint**: the thread's summary text and the last message it covers. The next handoff reuses it and summarizes only what came after, so older history is not summarized again on every switch.

### A thread's brain is a thread setting

- A thread may name its own brain (runtime, model, effort). When it does, its turns use that brain; when it does not, they use the hob's. It is a thread setting, journaled with the thread (`ThreadUpserted`), not a policy override and not a new hob configuration version. It grants and narrows nothing: tools run under the hob's policy and the chosen runtime's declared enforcement (ADR 014), whatever the brain.
- The picker in the chat sets any of the three, runtime, model and effort, and changes the thread only. A model switch keeps the thread's effort when the new model takes it. **Make it the hob's default** instead saves the brain as the hob's next configuration version (AG-002), clears the thread's own choice, and so also applies to the hob's other threads that follow the hob.
- The runtime is now part of a hob's versioned configuration, so a turn keeps the runtime it started with even if the hob is edited meanwhile.
- A brain is accepted only when the hub has an adapter for its runtime and the model is one that runtime offers. Runtimes without an adapter are listed as unavailable with the reason, never hidden.
- A limited or cut-off reply offers Continue on another brain next to Continue: the thread switches first, then the reply continues in place with a briefing that includes the reply as its first brain left it, with its text and tool steps, so the new brain does not redo that work.

### Attribution

Each reply records the runtime and model that produced it. That is what the chat uses to show a switch ("Now thinking with Codex") and what usage will be attributed by when Hobbots tracks usage: per reply, to the brain that ran it. A reply continued on another brain is attributed to the brain of its latest turn. The billing a runtime reports stays per runtime, in provider health.

## Rationale

Keeping the transcript as the source of truth is the only option that works when the old runtime is unavailable, and it is also what the agent model already says: a session is a binding that may change, never the thread's identity. One session per runtime keeps each runtime's own memory, tools history and caching where it is cheapest to resume, and sending only the difference on the way back keeps the briefing small. A deterministic, stored summary trades prose quality for zero cost and predictability, which suits the first version and leaves room for a model-written summary later. Making the thread's choice a thread setting, and the hob's default an ordinary configuration edit, reuses the versioning and journaling that already exist instead of adding a third kind of override.

## Consequences

- Threads store their sessions and their own brain; replies store their runtime and model; a new table stores the summary checkpoint (migration 0020). Existing threads keep their Claude Code session.
- The hub serves every runtime it has an adapter for; the API lists the others as unavailable. With `HOBBOTS_RUNTIME=fake`, the fake answers for Claude Code and for Codex, so switching can be tested without either.
- The chat header's brain chip becomes a picker; the transcript shows a switch where a reply's brain differs from the one before it.
- Until the Codex adapter lands (#12), the only runtime a real hub can switch to is Claude Code itself, with another model.

## Validation

The scenarios that would show this decision holds. Each names the test case or evidence that checks it, or the issue that will.

- A thread started on one runtime continues on another, and the new session's first turn carries a briefing with facts from earlier in the thread: `[TC-CH-126]`, with the fake runtime for both. On real Claude Code and Codex: not proven yet, [#12](https://github.com/otaviobarros/hobbots/issues/12).
- Switching back resumes the first runtime's own session and sends only what happened since it left: `[TC-CH-127]`.
- The picker changes only that thread; making it the hob's default adds a configuration version and the hob's other threads follow it: `[TC-CH-128]`.
- A switch away from a runtime that is limited or unavailable still works, the old runtime is never asked, and a reply continued on another brain is told the tool steps it already ran: `[TC-CH-129]`.
- A brain with no adapter or a model the runtime does not offer is refused: `[TC-CH-180]`.
- The briefing keeps the latest messages within the verbatim budget, cuts long messages, summarizes tool steps and reuses the stored checkpoint: `[TC-CH-183]`.
- The summary drops its oldest lines to fit, a reply with many tool calls cannot crowd it out, and text that looks like the briefing's headings or speakers stays quoted: `[TC-CH-134]`.
- Claude Code receives the briefing between the hob's instructions and the user's prompt: `[TC-CH-185]`.
- Migration 0020 keeps an existing thread's Claude Code session and records Claude Code and the configured model on existing replies: `[TC-DP-035]`, `[TC-DP-036]`.
- The chat shows the switch, sets the effort as well as the runtime and model, and offers Continue on another brain for a limited reply: `[TC-CH-184]`, in the browser.
