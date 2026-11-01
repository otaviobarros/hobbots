# ADR 016 — Client stores for unsent messages

Status: **Accepted.** Records an exception to [STD-REACT-003](../standards/react.md#std-react-003-local-ui-state-stays-local), which keeps UI state local and asks for an ADR before a global client store.

## Decision

- **Two module stores hold what the user has written but the hub does not have yet.** The outbox (`apps/web/src/api/outbox.ts`) holds messages sent while the hub is out of reach. The draft store (`apps/web/src/api/drafts.ts`) holds the unsent text of each thread and fresh page. Both live in a module of the web client, outside React, and components read them through `useSyncExternalStore`.
- **Each is keyed by where the text belongs.** A key is a thread id, or `new-<hob id>` for a hob's fresh page before its thread exists. A store never holds state for a view, a selection or a filter: that stays in the component or the URL (STD-REACT-002, STD-REACT-003).
- **Ownership.** Only the chat view and the composer change these stores, through the functions each module exports. Server data never enters them (STD-REACT-001).
- **Lifetime of the outbox.** A message stays until the hub has taken it, the user takes it back to edit, or the page closes. A fresh page's messages move to the thread the first of them started.
- **Lifetime of a draft.** A draft lasts until it is sent or emptied. It is kept in memory and in local storage under `draft.<key>`. Typing is saved a moment later, a pending save is written when the page is hidden or closed, and an emptied draft leaves storage at once. A send that fails puts its text back into the draft of the place it was sent from. A fresh page's draft moves to the thread its first message started.
- **Any other global client store needs its own ADR.** Adding a store library (Zustand, Redux, Jotai or similar) also needs one.

## Rationale

The chat view is keyed by thread, so it remounts on every switch, and a reply can outlive the page that sent it. State that must survive both cannot belong to the component. A small store per concern, keyed by place, keeps each owner obvious. It also means that typing re-renders only the composer, not the transcript.

## Consequences

- Drafts of deleted threads stay in local storage until cleared. Two windows do not sync their drafts with each other.
- The stores are not part of the Query cache, so a resync never replaces unsent text.

## Validation

- A draft survives switching threads and a reload, and a sent draft does not come back: `[TC-CH-132]`, and the unit tests in `drafts.test.ts`.
- A refused send puts its text back in the composer: `[TC-CH-133]`.
- Messages sent while the hub is away wait and go out in order, also after a resync: `[TC-CH-094]`, `[TC-CH-102]`, `[TC-CH-107]`.
