# Screens and flow inventory

Decided in [ADR 008](../decisions/008-design.md). Each row is one MVP screen. The [design specification](ui-ux.md) holds the style rules. Routes, exact copy and example numbers are illustrative; behavior and states are decided.

## MVP screens

| # | Screen | Contents | States and outcomes | Requirements |
|---|---|---|---|---|
| 1 | Welcome (first launch) | Animated night village; Get started; "I already use Hobbots"; supported providers named. | Intro plays once; idle loop continues quietly. Get started opens Onboarding; the other link opens Home. | OP-001 |
| 2 | Onboarding (5 steps, Elder Hob) | 1 Providers found on this Mac (Claude Code, Codex, Gemini CLI, Ollama…) or a typed key; 2 first hob (craft, name dice, seeded look, provider · model · effort); 3 safety preset (Careful, Balanced, Trusting); 4 folders; 5 summon. | At least one provider is needed to continue. Keys go to the OS keychain. Balanced is Trusted Workspace. | OP-001, AG-001, AG-005, PE-001 |
| 3 | Home (landing page) | Animated scene of hobs and their state; Needs you; Quests in progress; a usage potion per provider. | Allow resolves a request in place. With many hobs the scene shows at most six (needs you first, then the busiest); everyone else is in a grouped tile list with count chips, a filter and ⌘K. | UX-001, UX-004 |
| 4 | Chat, threads and Quest | Rail, hob panel, chat, right panel with Quest / Inbox / Workshop tabs. | Streaming with tool steps; Stop ends only the reply; approval card inline; Quest task detail with Message, Retry, Reassign, Cancel task; Pin; Cancel Quest shows "Cancelling…" until every hob confirms. | CH-001–007, OR-001–007, UX-001, UX-006 |
| 5 | Workbench | Header with owner, who asked, brain, where it runs; Terminal, Changes, Files, Browser; task-scoped chat drawer with quick nudges. | Live, Screenshot (age), History, Unavailable (why); computer control is Later. Nothing goes live until approved. | UX-002 |
| 6 | Inbox and approvals | Needs you / All / History, grouped by Quest; approval detail. | Three lifetimes; high-risk is once-only with a check box; Deny with reason; expired requests cannot be approved late; "Always" rules removable from History. | IN-001–007, PE-003, PE-007 |
| 7 | Chat states | Reference set. | Streaming with steps; stopped by you; cancelled (finished parts kept); interrupted by the provider, with Continue; reconnecting; queued message with "Send now and interrupt"; brain unavailable with Fix it; provider limit reached; new hob with no threads. | CH-004–007, AG-005 |
| 8 | Summon a hob | Describe chores or start from a kind; seeded look and colors; name dice; thinks with (connected providers, model, effort); where it works; Asks first; runs when asked. | Opens the new hob's chat with a hello. Schedules are post-MVP. | AG-001, AG-004 |
| 9 | Hob profile and Retire | Brain (provider, model, effort); Pause / Wake; tabs Instructions, Tools, Permissions (allow, ask, never per kind of action); Retire. | Retire hands work off, lets it finish, or stops it; nothing is deleted; the hob goes to Archived hobs. | AG-002, AG-004, AG-006 |
| 10 | Usage | One potion per connected provider plan; breakdown by hob; 7 or 30 days. | Subscriptions drain and refill, API keys show spend, local models are unlimited. Data depends on what each provider reports. | OP-002 |
| 11 | Settings | Providers with health and fixes; Devices & access (server, where hobs work, Tailscale / Wi-Fi / HTTPS, devices, pairing); Backup & export; Diagnostics; Archived hobs; Permissions, Appearance (Reduce motion), Notifications, About. | Backups never contain keys. Deleting an archived hob asks first. | AG-005, DP-001–004, OP-002, OP-003 |

## Post-MVP (kept from the full-app design)

- **Routines:** chores on a schedule; returns to the rail when shipped.
- **Memory:** what each hob remembers, readable and editable; "About you" is shared.
- **Rooms:** group chats with several hobs; shown in the MVP only as a Later card.

## Handoff sheets

- **Component sheet:** tokens, type, every control and state listed in the [design specification](ui-ux.md#components).
- **Hob sprite sheet:** the nine sprite states with timing, seeded looks, size rules and how states map to real task status.

## End-to-end interaction checks

1. First launch: Welcome → Onboarding with a connected provider → first hob → Home.
2. Open a hob from Home; chat opens on its last thread. Start a new thread from the fresh page.
3. Delegate parallel work; inspect the Quest tree and a task's Workbench without leaving the parent chat. Pin the Quest and switch threads.
4. Approve once, for this Quest and always for this site; deny with a reason; confirm an expired request cannot be approved late.
5. Stop a reply versus Cancel a Quest; show their different scopes and outcomes.
6. Disconnect and restart at a controlled point; the reconnecting banner shows, queued messages send, durable history and waits are intact.
7. Retire a busy hob with each work option; its history remains inspectable.
8. Turn on Reduce motion; every animation stops.

## Explicitly excluded

Company fleets, team spaces, employee RBAC, mandatory approval for every action, recurring schedules, long-term memory, marketplace publishing and native mobile apps stay outside the MVP.
