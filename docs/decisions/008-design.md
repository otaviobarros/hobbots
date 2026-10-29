# ADR 008 — Hobbots design

Status: **Accepted.**

## Decision

The [design specification](../design/ui-ux.md) records its style, layout and components, and the [screen inventory](../design/screens-and-flows.md) lists every screen. They are the visual and interaction reference for the MVP:

- **Home is the landing page.** It is an animated dashboard: what each hob is doing, what needs you, Quests in progress and usage. Chat stays one click away and opens on the last thread.
- **The chat workspace keeps its layout** (rail, hob and thread list, chat, right panel). The right panel has three tabs: **Quest**, **Inbox** and a live **Workshop** scene that links to the full Workbench.
- **Approvals offer three lifetimes:** just this once, for this Quest, or always for this site. High-risk actions only offer once and need a confirmation check box.
- **Onboarding safety presets are Careful, Balanced and Trusting.** Balanced is Trusted Workspace and remains the default ([ADR 003](003-autonomy.md)).
- **Many providers from day one:** Claude, ChatGPT, Gemini, Grok, local models and any OpenAI-compatible key, each shown only when actually connected and healthy.
- **Usage** shows one potion per connected provider plan.
- **Vocabulary:** agents are **hobs**; **Quest** stays; archiving a hob is **Retire**.
- **Making a hob** uses seeded pixel avatars, a name dice and an effort picker.
- **Rooms** (group chats) shows as a "Later" card. **Routines** and **Memory** move to post-MVP.
- **Visual identity:** a night palette (ground `#141228`, moonlight, lantern, mint, rose), Atkinson Hyperlegible Next for reading text and Pixelify Sans for headings, hob names and labels, pixel corners and stepped motion. No decorative left-edge accent borders.
- **The Hobbots mark is the chief of the hobs**, an elder hob in a gem crown with a lantern staff, built from the hob generator's parts. One drawing serves the rail and the app icon, and the icon fills its whole canvas so macOS masks it to its shape. On the rail the chief keeps still and its lantern carries status: it glows while a hob works and rises, blazes and pulses with a "!" when a request needs you.

## Rationale

An animated, character-led identity carries the Hobbots name, while the layout stays close to familiar AI chat apps.

The chief replaced the earlier crest at the user's direction (#41) so the app icon and the window show the same mark. A looping animation in the rail proved distracting in peripheral vision, so motion there is kept for status: the lantern reads as a quiet working light and a clear needs-you signal, in line with motion that shows what hobs are doing.

## Consequences

- The design proves no runtime capability. Every provider, Workbench view and approval control still needs a verified adapter or enforcement boundary before it is shown as working.
- Provider breadth conflicts with the existing-runtime approach of [ADR 002](002-existing-runtimes.md) for API-key-only providers. The [open questions](../product/open-questions.md) track how those run.

## Change control

A deliberate, user-directed design change updates the design specification and this ADR, or supersedes it with a new ADR.
