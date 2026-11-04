# Themes

The redesign (#462) moves the app from one night palette to four themes. This page and [themes.json](themes.json) hold every value the themes need. Until Redesign 1 (#463) lands, the [design specification](ui-ux.md) still describes the app as it ships today.

## The four themes

A theme changes how things look. It never changes where things are, what they say or how big they are. The theme is set with `data-theme` on the root element.

| Theme | `data-theme` | Look | Mode |
| --- | --- | --- | --- |
| Lamplight Dusk (default) | `lamplight-dusk` | Lamplight | Dark |
| Lamplight Paper | `lamplight-paper` | Lamplight | Light |
| Workshop Night | `workshop-night` | Workshop | Dark |
| Workshop Daylight | `workshop-daylight` | Workshop | Light |

Lamplight is smooth: rounded corners, eased motion and Atkinson headings. Workshop is today's pixel look: cut corners, Pixelify headings and stepped motion. First run always uses Workshop Night. When first run finishes on a device with no saved theme, the device keeps Lamplight Dusk from its next start. A device with no saved theme that finished setup earlier stays on Workshop Night.

## What is in themes.json

- **color**: 26 color tokens, each with a value for every theme and a line on where it is used.
- **shadow**: `shadow-menu` and `shadow-sheet` for every theme.
- **fixed**: values that stay the same in every theme. The switch knob is `#fdf9ef` when the switch is on. The letter on an AI provider's tile is `provider-ink`, `#141228`, because the tiles keep their light colors in every theme. The two fixed shadows are here too (see Shadows and gradients).
- **skin**: every value each look sets once, with the same names `styles.css` uses: corners, the heading font and weight, label case and tracking, easing, edge, button weight, hop, the selected fill, which icon set shows, the cut, the focus values and the press values. Components read them and never use a corner, font or easing directly.
- **font**, **type**, **space**, **space-inset**, **radius**, **size** and **duration**: the same in every theme.
- **motion**, **gradient** and **shape**: rules that hold in every theme, described below.
- **contrast**: the floors every theme meets, as pairs of a text color and the color behind it.

## Rules

- Token names are the same in every theme. Only the values change.
- A component never checks which theme is on. It reads tokens and skin values.
- Every theme sets every color and shadow token. A missing value is a bug.
- `tile`, the square behind a hob portrait, stays dark in every theme so the pixel art reads the same.
- `lantern` marks what needs you and the one primary action in a view. Nothing else uses it.
- The type scale, spacing, sizes and layout never change with the theme.
- Fonts ship with the app. Each font stack starts with the family name its `@fontsource-variable` package registers, such as `Atkinson Hyperlegible Next Variable`. Literata is optional and not bundled yet. Add `@fontsource-variable/literata` before replies can use it.

## Contrast

Every theme meets these floors against `ground`. The pairs and floors live in `contrast` in themes.json, and `apps/web/type-and-contrast.test.ts` checks every pair in every theme. A new color that sets text adds its pair there.

The 12:1 floor for `text` is measured on `ground` only. Reading text means hob replies, which sit on `ground`. Text on a card or panel is UI text and needs 4.5:1.

| Pair | Floor | Lamplight Dusk | Lamplight Paper | Workshop Night | Workshop Daylight |
| --- | --- | --- | --- | --- | --- |
| `text` | 12:1 | 12.8 | 12.4 | 13.1 | 14.1 |
| `text-secondary` | 4.5:1 | 7.6 | 6.9 | 10.9 | 7.6 |
| `label` | 4.5:1 | 6.6 | 6.0 | 7.8 | 6.4 |
| `text-strong`, `link` | 4.5:1 | 15.0 | 15.3 | 15.3 | 15.6 |
| `moonlight` | 4.5:1 | 14.0 | 8.8 | 14.9 | 7.2 |
| `lantern`, `mint`, `rose` | 4.5:1 | 7.3 or more | 5.8 or more | 7.9 or more | 5.5 or more |
| `star` | 4.5:1 | 10.1 | 5.1 | 11.7 | 6.1 |
| `control` | 3:1 | 4.1 | 3.5 | 4.3 | 3.5 |
| `focus-ring` | 3:1 | 10.1 | 5.1 | 14.9 | 7.2 |

`on-lantern` on a `lantern` fill and `on-rose` on a `rose` fill are 6.2:1 or more in every theme. Status tags add their own pairs (`mint` on `line`, `text-secondary` on `line` and `line-2`, `text-strong` on `line-2`, `label` on `line`), each at 4.5:1.

## Type and spacing

The type scale, the spacing grid and every size are the same in all four themes. `apps/web/src/styles.css` sets each style of `type` as a Tailwind text size with its own line height: `text-display`, `text-heading`, `text-title`, `text-reading`, `text-body`, `text-ui`, `text-detail`, `text-meta` and `text-code`. The `label` style is the `lbl` utility, because `text-label` is the label color.

- `body` (15px/23px) is the UI text of fields, cards and buttons. `ui` (14px/20px) is for denser UI text beside it: rows, menus, search fields and tabs.
- No text goes below `meta`, 12px, anywhere. That includes key hints, tags and counts.
- Spacing uses Tailwind's 4px step, and every `space` value sits on it. Layout gaps and page padding use only these steps.
- Padding inside a control or a row may also use a 2px half step: 6, 10 or 14px (`space-inset`, Tailwind's `1.5`, `2.5` and `3.5`).
- No theme or look sets a size, a line height or a spacing value.

The same test checks all of this.

## Sizes

Every size in `size` is a `--spacing-*` token in `styles.css`, so Tailwind reads it in any width, height or size class: `max-w-bubble-max`, `h-title-strip`, `size-hob-tile`. A component never writes one of these values by hand, and a test checks that `@theme` and themes.json hold the same sizes.

| Size | Value | Used for |
| --- | --- | --- |
| `title-strip` | 30px | The title strip with the window controls |
| `sidebar` | 72px | The sidebar, collapsed |
| `sidebar-open` | 256px | The sidebar, expanded |
| `sheet` | 340px | The work sheet that opens over the chat |
| `workbench-chat` | 300px | The Task chat panel beside the Workbench's tabs |
| `chat-min` | 360px | The narrowest the chat gets |
| `measure` | 70ch | The longest line of reply prose, the tray and the composer |
| `bubble-max` | 460px | Your own message bubble and what waits beside it; the hob profile dialog |
| `work-max` | 604px | Task and question cards in the transcript |
| `column-max` | 560px | Dialogs, centered notices and empty states, the approval card |
| `form-max` | 760px | Long single-column content, such as a hob's charms and permissions |
| `home-max` | 880px | Home and Usage |
| `page-max` | 1080px | The Hobs page and a hob's page |
| `hob-tile` | 36px | A hob's portrait tile |
| `row-min` | 36px | The smallest sidebar row |
| `hit-min` | 28px | The smallest pointer target anywhere |

A width that two or more screens share gets a size here before it is used.

## Motion

Durations come from `duration`. `styles.css` sets each one in `@theme` as `--dur-press`, `--dur-fade`, `--dur-enter`, `--dur-sheet`, `--dur-shake`, `--dur-hop` and `--dur-loop-cap`, and a test checks them against themes.json. A transition reads them as `duration-(--dur-fade)`.

Nothing loops past `dur-loop-cap` (10s) or 3 cycles without new input, in any theme. A loop starts again only on a change, such as a new reply or a hob starting work. A state that just needs to show uses a still frame, so a working hob shows a still mint mark. Scenes settle to a still frame after 30 seconds without input. Every animation stops with Reduce motion (STD-UI-004).

## Shadows and gradients

`shadow-menu` and `shadow-sheet` change with the theme. Besides them, only these fixed shadows are allowed, each named once in `fixed`:

| Shadow | Value | Used for |
| --- | --- | --- |
| `shadow-segment` | `0 1px 2px rgb(0 0 0 / 0.18)` | The lift under the picked segment of a segmented control |
| `stand-shadow` | `rgb(0 0 0 / 0.28)` | The soft shadow under a standing hob |

A new fixed shadow is added to that list first.

Gradients in the hob's color are allowed on the hob hero, card doors and the pixel ground strip. Nothing else uses a gradient.

## Shape

Corners come from the skin's `corner-*` values. Filter chips are the one exception: they are pills (`radius-round`) in every theme, Workshop included. Bubble corners are fixed by design too.

The focus ring is 2px in every theme. Workshop's `--focus-outline` in `styles.css` is still 3px until #801 lands.

## In the code

`apps/web/src/styles.css` holds the themes. Its `@theme` block and `:root` rule carry Lamplight Dusk, the default when no theme is set, and a `:root[data-theme="…"]` rule per other theme overrides every color and shadow. Two more rules set the skin: Lamplight on `:root`, Workshop on `[data-theme^="workshop-"]`. A unit test checks the file against themes.json. The app opens in Workshop Night on first run: `apps/web/index.html` and `apps/web/local.html` set it. `apps/web/src/lib/theme.ts` then applies the theme saved on this device before the first render, and follows a theme picked in another window. Like Reduce motion, the theme belongs to the device it is picked on, not to the hub. A missing or unknown value means Workshop Night. Finishing setup saves Lamplight Dusk when nothing is saved yet (`firstRunFinished`), and the open window keeps Workshop Night until the next start.

Components read the skin through a few utilities, so none of them checks the theme:

| Utility | Reads | Used for |
| --- | --- | --- |
| `cut` | `--cut`, `--corner-card` | Cards, menus, dialogs and toasts |
| `cut-control` | `--cut`, `--corner-control`, the focus values | Buttons and rows you press |
| `rounded-control`, `rounded-tag`, `rounded-dot`, `rounded-tile`, `rounded-card` | `--corner-*` | Fields, tags, state marks, portrait tiles |
| `font-heading` | `--font-heading` | Headings and hob names. `font-pixel` stays for the wordmark and art marks |
| `lbl` | `--font-heading`, `--label-case`, `--label-track` | Section labels |
| `press` | `--press-*`, with `--press-color` set by the button | The primary and approve press |
| `animate-(--hop)` | `--hop` | A hob's hop. It is `none` in Lamplight |

Transitions, `animate-hb-in` and `animate-hb-pop` ease with `--ease-ui`. Scene and hob art always steps. In Workshop the cut clip hides an outside outline, so a focused control draws its ring inset, with a 2px ground gap.

Shadows are plain custom properties with their own `shadow-menu` and `shadow-sheet` utilities, so each theme can change their shape. shadcn's `dark:` variant follows the mode: every theme but Lamplight Paper and Workshop Daylight is dark.

Workshop Night keeps the palette the app had before the themes. These tokens were renamed or added:

| Before | In the themes |
| --- | --- |
| `--color-text` (`#ece8ff`) | `text-strong`, for headings, names and button labels. Every use of the old `text` moved to it, so Workshop Night looks as before |
| (none) | `text`, a softer color for reading text (`#dcd7f2` in Workshop Night) |
| `--color-secondary-text` | `text-secondary` |
| `--color-lantern-shadow` | `lantern-press` |
| (none) | `tile`, `on-lantern`, `on-rose`, `focus-ring`, `link` |
| `--color-ring` (moonlight) | `focus-ring`, which is moonlight in Workshop Night and differs in the other themes |
| `--shadow-drawer` | `shadow-sheet` |
| `--color-wood` | Kept as it is. It is scene art, not a theme token. |

The shadcn names in `styles.css`, such as `--color-primary` and `--color-border`, keep pointing at these tokens. That way the components in `packages/ui` follow the theme without changes.

Components never write a color. Scene art keeps the colors the design draws it with in every theme, so `styles.css` names them once beside `wood`: `scene-*` for the village, Home's sky, the words on it and its hall, and setup's ground, `desk` and `desk-edge` for the Workbench desk, and `provider-*` for the tile behind each AI provider's letter mark. Pixel art palettes live in `apps/web/src/art`. Home's sky stays a night sky in every theme: shadcn's `dark:` variant shows the stars and the moon in the dark themes, and the sun in the light ones. A test fails on a hex or `rgb()` color in `apps/web/src/components`.

The desktop window's background follows the theme too. The preload script reports `ground` each time `data-theme` changes, and the next window opens with the last one. Before any page reports, it uses Workshop Night's ground, since first run always uses Workshop Night.
