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

Lamplight is smooth: rounded corners, eased motion and Atkinson headings. Workshop is today's pixel look: cut corners, Pixelify headings and stepped motion. First run always uses Workshop Night.

## What is in themes.json

- **color**: 26 color tokens, each with a value for every theme and a line on where it is used.
- **shadow**: `shadow-menu` and `shadow-sheet` for every theme.
- **fixed**: values that stay the same in every theme. The switch knob is `#fdf9ef` when the switch is on.
- **skin**: the values each look sets once. Components read them and never use a corner, font or easing directly.
- **font**, **type**, **space**, **radius**, **size** and **duration**: the same in every theme.

## Rules

- Token names are the same in every theme. Only the values change.
- A component never checks which theme is on. It reads tokens and skin values.
- Every theme sets every color and shadow token. A missing value is a bug.
- `tile`, the square behind a hob portrait, stays dark in every theme so the pixel art reads the same.
- `lantern` marks what needs you and the one primary action in a view. Nothing else uses it.
- The type scale, spacing, sizes and layout never change with the theme.
- Fonts ship with the app. Each font stack starts with the family name its `@fontsource-variable` package registers, such as `Atkinson Hyperlegible Next Variable`. Literata is optional and not bundled yet. Add `@fontsource-variable/literata` before replies can use it.

## Contrast

Every theme meets these floors against `ground`:

| Pair | Floor | Lamplight Dusk | Lamplight Paper | Workshop Night | Workshop Daylight |
| --- | --- | --- | --- | --- | --- |
| `text` | 12:1 | 12.8 | 12.4 | 13.1 | 14.1 |
| `text-secondary` | 4.5:1 | 7.6 | 6.9 | 10.9 | 7.6 |
| `label` | 4.5:1 | 6.6 | 6.0 | 7.8 | 6.4 |
| `lantern`, `mint`, `rose` | 4.5:1 | 7.3 or more | 5.8 or more | 8.0 or more | 5.5 or more |
| `control` | 3:1 | 4.1 | 3.5 | 4.3 | 3.5 |
| `focus-ring` | 3:1 | 10.1 | 5.1 | 14.9 | 7.2 |

`on-lantern` on a `lantern` fill is 6.6:1 or more in every theme.

## In the code

`apps/web/src/styles.css` holds the themes. Its `@theme` block and `:root` rule carry Lamplight Dusk, the default when no theme is set, and a `:root[data-theme="…"]` rule per other theme overrides every color and shadow. Two more rules set the skin: Lamplight on `:root`, Workshop on `[data-theme^="workshop-"]`. A unit test checks the file against themes.json. The app opens in Workshop Night (`apps/web/index.html`) until the saved choice lands (#480).

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
