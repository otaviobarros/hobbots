# Screens and flow inventory

Decided in [ADR 008](../decisions/008-design.md). Each row is one MVP screen. The [design specification](ui-ux.md) holds the style rules. Routes, exact copy and example numbers are illustrative; behavior and states are decided.

## MVP screens

| # | Screen | Contents | States and outcomes | Requirements |
|---|---|---|---|---|
| 1 | Welcome (first launch) | Animated night village; Get started; "I already use Hobbots"; supported providers named. | Intro plays once; idle loop continues quietly. Get started opens Onboarding; the other link opens Home. | OP-001 |
| 2 | Where Hobbots runs (first step of setup) | "Run Hobbots on this computer" or "Connect to Hobbots on another computer". Run here: optional "Use Hobbots from your other devices too?" with Tailscale status, the switch, the hub address and a QR code, Skip for now or Continue. Connect: type the address or pick a hub found on the tailnet, then wait with a matching code. | Run here continues to Onboarding; remote access can be turned on later in Settings › Devices; without Tailscale, install steps show. Connect ends on Home once the hub allows it, or shows the refused state. Hobs always work on the hub. | DP-001, DP-002, DP-004 |
| 3 | Onboarding (Elder Hob) | 1 Providers found on this computer (Claude Code, Codex, Gemini CLI, Ollama…) or a typed key; 2 first hob (role, chores in the user's words, name dice, seeded look with nearby looks, provider · model · effort); 3 safety preset (Careful, Balanced, Trusting), each card listing Read your folders, Create and edit files, Delete files, Run commands, Use the web, Push your work and Anything outside your folders with Allow, Ask or Never; picking Trusting also shows "Let new hobs run without the sandbox", off; 4 folders, shared by every hob; 5 summon. | At least one provider is needed to continue. Keys go to the OS keychain. Balanced is Trusted Workspace. The rows and wording come from ADR 014. | OP-001, AG-001, AG-005, PE-001 |
| 4 | New device approval (on the hub) | The device name, what it uses (Hobbots app or a browser), its Tailscale identity and the matching code, with Allow / Deny / Decide later. The new device shows "Waiting for approval on <hub name>" with the same code. | Asked once per new device, even on the same Tailscale account; also a system notification when the window is closed. Allow remembers it (revocable in Settings › Devices); Deny lets it ask again; Decide later leaves the request in Settings › Devices. | DP-004 |
| 5 | Home (landing page) | Animated scene of hobs and their state; Needs you; Quests in progress; a usage potion per provider. | Allow resolves a request in place. | UX-001, UX-004 |
| 5b | Home with many hobs | The scene shows at most six hobs (needs you first, then the busiest); everyone else waits in the hall, and the door shows how many. Below, every hob as a tile grouped by state, team or brain. | Count chips jump to a state; a filter finds a hob by name or role; each tile reads "Role · state" with the role sigil on the avatar; ⌘K jumps anywhere. Resting folds by default past 12 hobs. | UX-001, UX-004 |
| 6 | Chat, threads and Quest | Rail, hob panel (each hob with its role sigil and "Role · N threads"), chat with the role title beside the hob name (and the Unsandboxed tag when it applies), right panel with Quest / Inbox / Workshop tabs. | Streaming with tool steps; Stop ends only the reply; approval card inline; Quest task detail with Message, Retry, Reassign, Cancel task; Pin; Cancel Quest shows "Cancelling…" until every hob confirms. | CH-001–007, OR-001–007, UX-001, UX-006 |
| 7 | Workbench | Header with owner, who asked, brain, where it runs on the hub (in the sandbox, or Unsandboxed); Terminal, Changes, Files, Browser; task-scoped chat drawer with quick nudges. | Live, Screenshot (age), History, Unavailable (why); computer control is Later. Nothing goes live until approved. | UX-002 |
| 8 | Inbox and approvals | Needs you / All / History, grouped by Quest; approval detail. | Three lifetimes; high-risk is once-only with a check box; Deny with reason; expired requests cannot be approved late; "Always" rules removable from History. | IN-001–007, PE-003, PE-007 |
| 9 | Chat states | Reference set. | Streaming with steps; stopped by you; cancelled (finished parts kept); interrupted by the provider, with Continue; reconnecting; queued message with "Send now and interrupt"; brain unavailable with Fix it; provider limit reached; new hob with no threads. | CH-004–007, AG-005 |
| 10 | Summon a hob | Pick a role (the first eight, more roles by family, or your own title and sigil, with a link to suggest a missing role), which fills in the chores; seeded look with hat and tool with nearby looks and colors; name dice; thinks with (connected providers, model, effort); where it works (on the hub, in the sandbox by default); Asks first, read-only with a link to Settings; runs when asked. | Offers the same hob fields as onboarding's first hob. Keeps its draft until the hob exists. Opens the new hob's chat with a hello. Schedules are post-MVP. | AG-001, AG-004 |
| 11 | Hob profile and Retire | Header with the name, one state pill, and the role title with "Good at" from the chores; Pause / Wake, and Retire under More actions. Tabs Profile, Charms, Permissions. Charms lists the runtime's own tools with how each is enforced, then the hob's Charms with their answer, then what the runtime holds on this hub: each enforcement capability as Verified, Not verified or Unsupported, with its evidence. Where the sandbox cannot start or is not yet verified on this hub, commands, local Git and the web show Needs the sandbox in place of their answer, and Permissions says why beside the switch. Permissions holds its folders (shared and its own, with add and remove for its own), the "Run in the sandbox" switch and allow, ask, never per kind of action, with checked rules marked. An unsandboxed hob shows the Unsandboxed tag beside its state pill. Profile is one column: a role card whose Change role opens a sheet with every starter role, a search and a filter per family, or an own title and sigil; Tone, with one voice from three groups (Everyday, Expert, and Themed, marked "Changes wording only") and one length (Brief, Balanced, Detailed), each with a one-line description; full-width instructions in the user's own words (the hub tells the runtime the hob's name, role and tone before them on every turn); Brain (provider, model, effort); a footer line with where the hob works, when it was summoned and its version. One save bar at the bottom saves it all as one version. | Retire hands work off, lets it finish, or stops it; nothing is deleted; the hob goes to Archived hobs. | AG-002, AG-004, AG-006 |
| 12 | Usage | One potion per connected provider plan; breakdown by hob; 7 or 30 days. | Subscriptions drain and refill, API keys show spend, local models are unlimited. Data depends on what each provider reports. | OP-002 |
| 13 | Settings | General (Open Hobbots at login, with its macOS status; Keep running in the menu bar when the window closes); Providers with health and fixes, and each provider's enforcement on this hub; Devices (Tailscale status, remote access on or off, the hub address and QR code, optional HTTPS, port, approved devices with last activity and Revoke; on a connected desktop: the hub it uses and Disconnect); Backup & export; Diagnostics; Archived hobs; Permissions, Appearance (Reduce motion), Notifications, About. | Backups never contain keys. Deleting an archived hob asks first. Both General switches are on by default; Open at login shows when macOS needs approval in System Settings. | AG-005, DP-001–004, EX-005, OP-002, OP-003 |
| 14 | Menu-bar icon and closing the window (macOS) | A pixel-art template icon in the menu bar showing Starting, Running, Stopped or Error; menu with Open Hobbots, Pause remote access and Quit Hobbots. | The Dock icon shows only while a window is open. With Keep running off, closing the last window quits; if hobs are working, a dialog says their work will stop (Quit / Cancel). | EX-005, DP-001 |

## Post-MVP (kept from the full-app design)

- **Mobile app:** a client of the hub on the same API, approved like any device.
- **More connection routes:** relay, local network with HTTPS, public HTTPS and a server install.

- **Routines:** chores on a schedule; returns to the rail when shipped.
- **Memory:** what each hob remembers, readable and editable; "About you" is shared.
- **Rooms:** group chats with several hobs; shown in the MVP only as a Later card.

## Handoff sheets

- **Component sheet:** tokens, type, every control and state listed in the [design specification](ui-ux.md#components).
- **Hob sprite sheet:** the nine sprite states with timing, seeded looks, size rules and how states map to real task status.

## End-to-end interaction checks

1. First launch: Welcome → Where Hobbots runs (run here) → Onboarding with a connected provider → first hob → Home.
2. Open a hob from Home; chat opens on its last thread. Start a new thread from the fresh page.
3. Delegate parallel work; inspect the Quest tree and a task's Workbench without leaving the parent chat. Pin the Quest and switch threads.
4. Approve once, for this Quest and always for this site; deny with a reason; confirm an expired request cannot be approved late.
5. Stop a reply versus Cancel a Quest; show their different scopes and outcomes.
6. Disconnect and restart at a controlled point; the reconnecting banner shows, queued messages send, durable history and waits are intact.
7. Retire a busy hob with each work option; its history remains inspectable.
8. Turn on Reduce motion; every animation stops.
9. Turn on remote access, open the hub address in a tailnet browser, Allow it on the hub, then Revoke it; the browser is refused at once.
10. Close the hub window during a Quest; the work continues and a connected device follows it live.

## Explicitly excluded

Company fleets, team spaces, employee RBAC, mandatory approval for every action, recurring schedules, long-term memory, marketplace publishing and native mobile apps stay outside the MVP. Hobs never act on the files or apps of a connected device.
