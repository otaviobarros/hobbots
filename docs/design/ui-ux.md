# Design specification

Decided in [ADR 008](../decisions/008-design.md). This document records what the code must match. The [screen inventory](screens-and-flows.md) lists every screen and its states.

Hobbots is a modern AI chat app with a pixel-folklore character: small hobs that work at night in a lantern-lit workshop. Familiar interactions come first. The art, the hob animations and the names carry the personality; they never hide what a hob or an action actually does.

## Style tokens

| Token | Value | Use |
|---|---|---|
| Ground | `#141228` | App background, text on lantern and mint |
| Deep | `#0d0c1c` | Rail, title strip, inputs, scenes |
| Panel / Card | `#1b1835` / `#1f1c3e` | Side panels / cards |
| Hover | `#25224a` | Row and button hover |
| Line / Line 2 | `#2c2a5a` / `#3a3666` | Dividers, selected fill / selected thread, quiet borders |
| Control | `#7770c4` | Input and secondary-button borders (3:1+) |
| Text / Secondary / Label | `#ece8ff` / `#c9c3e8` / `#a9a2e0` | Reading text / supporting text / labels and timestamps |
| Moonlight | `#f3e9b5` | Selected item, hob names, focus ring |
| Lantern | `#f2a541` (hover `#ffb75c`, press edge `#9a5f16`, link hover `#ffc477`) | Primary action, links, "needs you" |
| Mint | `#7fd1b9` (deep `#3f8a75`) | Working, done, approve |
| Rose | `#ee9292` | Deny, stop, error |

Status tags: Working (mint on ground), Running (mint deep), Waiting and Needs you (lantern), Queued (line 2), Cancelled (line 2 with secondary text), Failed (rose). Workbench view labels: Live (mint), Screenshot (`#8fb4f0`, with age), History, Unavailable (with reason), Later. Provider tiles: Claude C `#e39a74`, ChatGPT G `#8fd3a8`, Gemini G `#8fb4f0`, Grok X `#c9c3e8`, Local L `#f3e9b5`, Other + `#b79be8`.

All text passes WCAG AA; the lowest pair is 5.6:1. Control borders are at least 3:1.

## Type

- **Atkinson Hyperlegible Next** for all reading text: chat, lists, buttons, fields. Body 15px.
- **Pixelify Sans** (ligatures off) only for headings, hob names and uppercase section labels, never below 14px.
- Fonts are bundled with the app; no network font loading.

## Shape and motion

- Pixel corners (a 4px clipped corner) on cards and buttons. Primary buttons have a 4px "press" edge and press down 2px.
- Focus is a 3px moonlight ring; inside clipped shapes it is drawn inset.
- Selection uses a fill (`#2c2a5a`), never a colored left edge. **No decorative left-edge accent borders** anywhere.
- Motion is stepped (pixel timing): hover a hob and it hops; working hobs bob; thinking shows blinking dots; streaming shows a moonlight caret; new messages slide in; approve throws sparkles, deny shakes, forget poofs, sleep shows Zs. **Every animation stops with Reduce motion.**
- Each hob is a 14×14 pixel avatar generated from a seed (hat, gear, face, ears, beard, outfit, skin) plus one of six colors (Violet, Moss, Amber, Rose, Sky, Ember). The seed and color are saved with the hob, so the same hob looks the same on every device. The 10×10 contact sprite is kept for the crest. The sprite sheet defines nine states: idle, working, thinking, waiting, needs you, asleep, celebrating, failed, sending.

## Layout

- **Title strip**, 30px, with the window controls.
- **Rail**, 76px: crest, Home, Hobs, Inbox (needs-you count), Usage, and Settings at the bottom. Icons are 12×12 pixel art; the active item is moonlight on line.
- **Hob panel**, 256px: search; "Hobs" label; each hob row (sprite, name, role · thread count) opens into its threads; "+ New thread"; a "Rooms: the great hall" card tagged Later; "+ Summon a hob"; key hints. Collapses.
- **Chat**: header with sprite, name, thread title, role, brain chip (provider · model · effort, and health), Edit hob and the right-panel toggle. My messages are right-aligned on a line-colored bubble (max 460px); a hob's messages show its 26px sprite and name in moonlight. A new thread shows "A fresh page" with idea chips. Composer: input on deep with a control border, Send in lantern, Stop in rose, hint line. Stop ends only the current reply; Cancel lives on the Quest.
- **Right panel**, 340px, tabs **Quest**, **Inbox**, **Workshop**. Quest: the task tree (who asked whom, owner, state, age, who is waited on); Pin keeps it visible in every thread. Inbox: this Quest's questions, approvals, problems and results with delivery state. Workshop: the live night scene with a link to the Workbench. Collapses.
- **Reconnecting banner**: lantern fill, "Reconnecting to Hobbots…"; messages wait to send.

## Components

The component sheet defines: buttons (primary, approve, secondary, deny, quiet, disabled, icon, chip), switch, segmented control, inputs, status tags, Workbench view labels, delivery steps (Sent, Delivered, Read, Answered), the approval card (Allow once, Always for this site, Deny, Details), Quest card, nested task rows, provider tiles, potions, hop / sparkles / poof, the streaming caret and the banner. Shared primitives live in `packages/ui` (shadcn/ui, restyled to these tokens).

## Behavior rules

- Durable server records drive every status; persuasive assistant text never does.
- Workbench labels are honest: Live, Screenshot (with age), History, Unavailable (and why). Computer control is shown as Later.
- Approvals show the exact action, target, who asked (for example You → Pip → Tinker), why now, risk and expiry. Lifetimes: once, this Quest, always for this site; high-risk actions offer once only and need a check box. Deny takes an optional reason. Expired requests cannot be approved late.
- Retire asks what happens to a hob's work (hand it off, let it finish, stop it now). Nothing is deleted; the hob moves to Settings › Archived hobs.
- Providers appear only when connected; keys typed by hand go to the OS keychain and never into chat.

## Implementation status

The validation slice ([ADR 009](../decisions/009-toolchain-and-validation-slice.md)) builds these screens in this style:

- **Home** is the landing page: the night scene with every hob and its live state, count chips, Needs you (empty until approvals exist), Happening now, Recent threads, a Claude potion under AI plans, and Quests in progress (empty).
- **Chat workspace:** title strip, rail (Home, Hobs, Inbox, Usage, Settings), hob panel with search over hobs and thread titles, "+ New thread" opening a fresh page with idea chips (the thread is saved on the first message), ⌥↑ / ⌥↓ to switch threads, chat with streaming, thinking, Stop, stopped and failed states, a reconnecting banner, and the right panel with Quest, Inbox and Workshop tabs. Quest and Inbox show empty states; the Workshop scene follows the hob's live state.
- **Inbox and Usage** are empty pages that explain what arrives with the MVP. **Settings** shows AI providers: Claude Code health, and the other providers tagged Later.
- Summon, Edit hob and Rooms are disabled or tagged Later. Hobs are seeded avatars stored with each hob (migration `0002_hob_look`).

## Design verification

Compare each built screen against its design. Check keyboard focus and screen-reader names, contrast, Reduce motion, collapsed panels, narrow windows and overflow. A screen-reader and keyboard pass in the real app is still open.
